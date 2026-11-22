// src/reasoning-apply.js - 「客户端没给档位时套默认档」的纯函数（2026-11-16 调研 P0-4）
//
// ## 为什么要单独一层
//
// 客户端（Codex / Claude Code / 散装脚本）经常**不带** `reasoning_effort`。
// 不带时上游按它自己的默认走，用户无法表达「这个模型我就要 high」。但**不能**
// 因此就把网关的默认值塞进请求：档位是**模型能力**，不是全局设定。
//
// 三条纪律（每一条都对着一次踩过的坑）：
//   1. **客户端优先**。客户端明确传了任何形态的档位（`reasoning_effort` /
//      `reasoning.effort` / `thinking.effort` / `budget_tokens`）就一律不动它——
//      网关永远不该覆盖调用方的显式意图。
//   2. **没有 descriptor 就不套**。档位集合只认上游 `reasoning_effort_config`
//      的 `support_thinking` + `options`（`remote.supportedLevels`）。模型名不是
//      能力证据；表没就绪时「不知道支持什么」，此时套默认等于拿用户的钱赌。
//   3. **向下钳，不向上**。默认档超出该模型支持范围时按 `remote.clampLevel`
//      取不高于它的最高支持档，并在结果里说明被钳过——不静默改写。
//
// 档位词表**复用 `remote.js` 的单一来源**（`EFFORT_LEVELS` / `normalizeLevel` /
// `clampLevel`），不在这里再写一份：两套词表迟早不一致，而档位静默丢失正是
// Qoder 那轮踩过的坑。
const remote = require('./traework/remote');

/** 默认档表里，模式串的最大长度（防一条畸形配置把匹配拖慢） */
const PATTERN_MAX = 120;

/**
 * 从配置表里挑出该模型的默认档。
 *
 * 匹配优先级：**精确模型名** > `前缀*`（最长前缀优先）> `*`。
 * 配置形如 `{ "glm-5.2": "high", "gemini*": "light", "*": "high" }`。
 *
 * @param {object} table {pattern: tier}
 * @param {string} model 模型名（已剥前缀）
 * @returns {{pattern:string, tier:string}|null}
 */
function pickDefault(table, model) {
  if (!table || typeof table !== 'object') return null;
  const want = String(model || '').trim().toLowerCase();
  if (!want) return null;
  const entries = Object.entries(table)
    .filter(([k, v]) => k && v != null && String(v).trim())
    .map(([k, v]) => [String(k).slice(0, PATTERN_MAX), String(v).trim()]);

  // 1) 精确（大小写不敏感）
  const exact = entries.find(([k]) => !k.includes('*') && k.toLowerCase() === want);
  if (exact) return { pattern: exact[0], tier: exact[1] };

  // 2) 前缀通配：长前缀优先（更具体的规则赢）
  const prefixes = entries
    .filter(([k]) => k.endsWith('*') && k !== '*')
    .map(([k, v]) => [k.slice(0, -1), v])
    .filter(([p]) => p && want.startsWith(p.toLowerCase()))
    .sort((a, b) => b[0].length - a[0].length);
  if (prefixes.length) return { pattern: `${prefixes[0][0]}*`, tier: prefixes[0][1] };

  // 3) 兜底
  const star = entries.find(([k]) => k === '*');
  return star ? { pattern: '*', tier: star[1] } : null;
}

/**
 * 套默认档。
 *
 * @param {object} payload 请求体（不会被就地改动）
 * @param {object} opts
 * @param {object} [opts.table]     运行态配置的默认档表
 * @param {string} [opts.model]     模型名（已剥前缀）
 * @param {string[]|null} [opts.supported] 该模型 descriptor 声明的档位（remote.supportedLevels 的输出）
 * @returns {{payload:object, source:'client'|'default'|'none', requested:string,
 *            effective:string, applied:boolean, note:string}}
 *   source: client=客户端自己给的（未改）、default=套了默认、none=没套（附原因）
 */
function applyDefault(payload, opts = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const supported = Array.isArray(opts.supported) ? opts.supported.filter(Boolean) : [];

  // 纪律 1：客户端显式给了档位就不动（含 budget_tokens 换算出来的档）
  const requested = remote.requestedEffort(p);
  if (requested) {
    return { payload: p, source: 'client', requested, effective: requested, applied: false, note: '' };
  }

  const hit = pickDefault(opts.table, opts.model);
  if (!hit) {
    return { payload: p, source: 'none', requested: '', effective: '', applied: false, note: '未配置该模型的默认档' };
  }
  const want = remote.normalizeLevel(hit.tier);
  if (!want) {
    return {
      payload: p, source: 'none', requested: hit.tier, effective: '', applied: false,
      note: `默认档「${hit.tier}」不是合法档位（模式 ${hit.pattern}），未套用`,
    };
  }
  // 纪律 2：descriptor 没声明支持什么 → 不套（拿用户的钱赌能力，不做）
  if (!supported.length) {
    return {
      payload: p, source: 'none', requested: want, effective: '', applied: false,
      note: `模型 ${opts.model || ''} 的 descriptor 未声明思考档位，默认档未套用`,
    };
  }
  // 纪律 3：只向下钳
  const eff = remote.clampLevel(want, supported);
  if (!eff) {
    return {
      payload: p, source: 'none', requested: want, effective: '', applied: false,
      note: `默认档 ${want} 无法映射到该模型支持的档位（${supported.join('/')}）`,
    };
  }
  const out = { ...p, reasoning_effort: eff };
  return {
    payload: out,
    source: 'default',
    requested: want,
    effective: eff,
    applied: true,
    note: eff === want ? '' : `默认档 ${want} 超出支持范围，已钳到 ${eff}（支持：${supported.join('/')}）`,
  };
}

/** 给人看的一行摘要（日志/响应头共用同一个口径） */
function summary(res) {
  if (!res) return '';
  if (res.source === 'client') return `client:${res.effective}`;
  if (res.source === 'default') return `default:${res.effective}`;
  return '';
}

module.exports = { applyDefault, pickDefault, summary, PATTERN_MAX };
