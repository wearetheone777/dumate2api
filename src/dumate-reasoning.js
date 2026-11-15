// src/dumate-reasoning.js - 搭子路径的思考档位归一化（2026-11-15 融合 P0-2）
//
// 背景：本仓的翻译层（anthropic.js / responses.js）会把客户端的思考强度统一
// 翻成 OpenAI 的 `reasoning_effort`（见 test/unit/effort-passthrough.test.js 的
// 既有约定）。但搭子路径在 2026-10-30 把它**主动剥掉**了，理由如实记录当时是
// 「多余字段原样进云端，行为未知」。后果是客户端传 none / max 全都无效：
//   传 max → 上游按默认档跑，思考预算拉不满；
//   传 none → 上游照样思考，budget.js 的 65536 下限照样被 reasoning 吃掉。
//
// 新证据（2026-11-13，社区 rance 0.3.1 对真实网关实测）：
//   `deepseek-v41-flash` 认 `none / low / high / max` 四档；
//   `none` 必须**显式**下发 thinking:{type:'disabled'} + enable_thinking:false
//   才真的不思考（只删 reasoning_effort 不够）；
//   `low` 与 `high` 在百度渠道实际同强度（所以 low 归一成 high，语义一致）；
//   `high` / `max` 保留对应强度并显式开启。
//
// 三个边界，改之前先读：
//
// 1. **只对同后端的模型生效**。白名单五个在 modelmap 的 MODEL_NAMES 里都标注为
//    实跑 `deepseek-v4.1-flash-low-latency`——档位语义是按后端说的，不同后端
//    的合法集合不同（Qoder 是 minimal/…/max 五档，千问另有 thinking_config）。
//    名单外的模型一律不注入，保持各自现状（chat 路径透传、翻译路径剥掉）。
//
// 2. **词表与翻译层不一致，是刻意的**。翻译层产 `minimal / low / medium /
//    high / max` 五档（对齐 qoder2api-hub），搭子只认四档。`minimal` / `medium`
//    落在白名单档位之外 → 交给调用方的 stripUnsupported 决定（翻译路径剥掉，
//    与改造前一致）。**不要顺手把它们映射成 none/high**——那是「让稍微想想
//    变成完全不想」，且 medium 的上游行为没有实测证据。
//
// 3. **不碰 messages / tools / 其他字段**。归一化只增删 reasoning_effort /
//    thinking / enable_thinking 三个键，其余原样（客户端可能在同一 body 里
//    带工具定义，任何深拷贝或重排都可能改变签名）。
//
// 离线验证：node --test test/unit/dumate-reasoning.test.js

/** 搭子认的思考档位（2026-11-13 真机实测，仅对白名单模型） */
const ALLOWED = new Set(['none', 'low', 'high', 'max']);

/**
 * 档位语义挂在**后端**上，不是挂在产品别名上。这五个 id 在 MODEL_NAMES 里
 * 都是 `deepseek-v4.1-flash-low-latency`。新增条目时先确认真实后端一致。
 * 注意：集合里的键一律**小写**（normModel 会小写入参），档位编码 `L0/L2`
 * 在归一化后变成 `l0/l2`——别按显示名的大小写写这里。
 */
const SAME_BACKEND = new Set([
  'deepseek-v41-flash',
  'model-text',
  'dm-auto-model/text.l0',
  'dm-auto-model/mm.l0',
  'dm-auto-model/mm.l2',
]);

/** 入站写法归一：剥 [1M] 标记、去空白、小写 */
function normModel(name) {
  return String(name || '')
    .replace(/\[1M\]$/i, '')
    .trim()
    .toLowerCase();
}

/** 该模型是否走 deepseek-v4.1-flash 后端（档位语义已知的那一族） */
function supportsEffort(model) {
  return SAME_BACKEND.has(normModel(model));
}

/** 取 body 里的档位原始值（只认 OpenAI 的 reasoning_effort，其他形态由翻译层负责） */
function rawEffort(body) {
  const v = body && body.reasoning_effort;
  return typeof v === 'string' ? v.trim().toLowerCase() : null;
}

/**
 * 归一化一个**已映射**的搭子请求体。原地修改并返回是否命中。
 *
 * @param {object} body  已 mapModel 的 OpenAI 请求体
 * @param {object} opts
 * @param {string} opts.mappedModel  映射后的模型名（req._mappedModel）
 * @param {boolean} [opts.stripUnsupported=true]
 *        未命中时是否剥掉 reasoning_effort：
 *        - 翻译器路径（Responses / Anthropic）传 true（或省略）——
 *          与 2026-10-30 起的既有行为一致：翻译层加的字段不进云端；
 *        - 纯 OpenAI 透传路径传 false——「最小干预透传」语义不变。
 * @returns {boolean} true = 按搭子档位归一化过；false = 未命中（按 stripUnsupported 处理）
 */
function apply(body, opts) {
  const o = opts || {};
  if (!body || typeof body !== 'object') return false;
  const effort = rawEffort(body);
  const hit = effort !== null && ALLOWED.has(effort) && supportsEffort(o.mappedModel);

  if (!hit) {
    // 未命中：白名单外模型、或白名单内但档位是 minimal/medium、或没有档位。
    if (o.stripUnsupported !== false) delete body.reasoning_effort;
    return false;
  }

  const enabled = effort !== 'none';
  if (!enabled) {
    // none：只删 reasoning_effort 不够，必须显式关开关（实测依据见文件头）
    delete body.reasoning_effort;
  } else if (effort === 'low') {
    // 百度渠道 low 与 high 同强度；归一成 high 让跨渠道语义一致
    body.reasoning_effort = 'high';
  } else {
    body.reasoning_effort = effort;
  }
  // 显式档位优先于 SDK / 变体留下的冲突开关（rance 原实现的注释语义）
  body.thinking = Object.assign({}, body.thinking, { type: enabled ? 'enabled' : 'disabled' });
  body.enable_thinking = enabled;
  return true;
}

module.exports = { apply, supportsEffort, ALLOWED, SAME_BACKEND };
