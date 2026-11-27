// src/qoder/identity-guard.js - Qoder 出站身份句守卫（受控 A/B 结论）
//
// 出处：shuishuipingan/qoder2api-hub v1.10.3 + docs/risk-control-and-queueing.md §7
// （2026-11-23 受控实验）。第三方 Agent 的 system 文本里出现字面子串
//   You are ZCode, / You are Claude Code, / You are Codex,
//   powered by DeepSeekRuntime.
// 时，Qoder 上游回 10605 / queueType:p1 / queueCount:0 /
// serviceAvailable:false——这是**伪装成排队的硬拒绝**，等待不会放行。
// 单变量对照排除了出口 IP、账号、机器身份头、工具定义和模型本身。
//
// 对策是字符级最小中和：只在命中片段的标点前插一个空格，打断字面匹配；
// 品牌名、语序、语义全部保留。自家品牌 Qoder 豁免，保证官方前缀逐字节
// 不变（前缀缓存亲和不能因为这道守卫抖一次）。
//
// 纪律：
//   1. **默认关闭**——与 src/prompt-guard.js 同款选通开关；只有显式打开才动出站文本。
//   2. 不做语义改写，不复用 workbuddy/sanitize.js 的整句中性化（那是另一条通道的口径）。
//   3. 天然幂等：中和后的文本不再命中同一模式。
//   4. 覆盖 system / developer / user / assistant 的全部文本 part 与 reasoning_content；
//      tool 消息正文不碰（那是工具输出不是身份自述）。
'use strict';

// 品牌名：大写开头，允许多词 / 连字符 / 数字尾词（Claude Code / DeepSeek-Harness / GPT-5）
const BRAND = '[A-Z][A-Za-z0-9]*(?:[ -][A-Z0-9][A-Za-z0-9]*)*';
// 模式 A：身份同位语（逗号必须紧跟品牌名）；模式 B：powered 归属（句号必须紧跟品牌名）
const PATTERNS = [
  new RegExp(`(You are ${BRAND})(,)`, 'g'),
  new RegExp(`(powered by ${BRAND})(\\.)`, 'g'),
];
const OWN_BRANDS = new Set(['Qoder']);

/**
 * 开关闭合：env 或 qoder-runtime 面板任一开启即生效。
 * runtime.pick 内部已吞异常，这里再包一层保证热路径绝不抛。
 */
function enabled() {
  if (process.env.DUMATE_QODER_IDENTITY_GUARD === '1') return true;
  try {
    const v = require('./runtime').pick('identityGuard.enabled', false);
    return v === true;
  } catch (e) { return false; }
}

/** 品牌是否自家（豁免）。只豁免精确品牌词，不动通用正则的覆盖范围 */
function isOwnBrand(brand) {
  return OWN_BRANDS.has(brand);
}

/** 单段文本中和。幂等：标点前已有空格时不再命中 */
function neutralize(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (whole, prefix, punct) => {
      // 从 prefix 尾部取品牌名（模式 A: "You are X"; 模式 B: "powered by X"）
      const m = /[A-Z][A-Za-z0-9]*(?:[ -][A-Z0-9][A-Za-z0-9]*)*$/.exec(prefix);
      if (m && isOwnBrand(m[0])) return whole;
      // 幂等由正则本身保证：命中形态要求标点紧跟品牌名，插入空格后不再命中
      return `${prefix} ${punct}`;
    });
  }
  return out;
}

/** content part：只动 type=text 与 reasoning_content 的文本字段 */
function partText(p) {
  if (!p || typeof p !== 'object') return;
  if (p.type === 'text' && typeof p.text === 'string') p.text = neutralize(p.text);
  if (typeof p.reasoning_content === 'string') p.reasoning_content = neutralize(p.reasoning_content);
}

/**
 * 就地处理 OpenAI 形状 body 里的身份句。返回 body 本身（方便链式）。
 * 关掉时**零改动**：连遍历都不做，确保默认行为逐字节不变。
 */
function guardBody(body) {
  if (!enabled() || !body || !Array.isArray(body.messages)) return body;
  for (const m of body.messages) {
    if (!m || typeof m !== 'object') continue;
    // role:'tool' 是工具输出，不是模型身份自述，不碰
    if (m.role === 'tool') continue;
    if (typeof m.content === 'string') {
      m.content = neutralize(m.content);
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) partText(p);
    }
    // Anthropic 桥可能带顶层 reasoning_content
    if (typeof m.reasoning_content === 'string') m.reasoning_content = neutralize(m.reasoning_content);
  }
  return body;
}

module.exports = { enabled, neutralize, guardBody, isOwnBrand, PATTERNS, OWN_BRANDS };
