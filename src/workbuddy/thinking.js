// src/workbuddy/thinking.js - DeepSeek 思维链注入与 reasoning_content 回填（P0-4）
//
// 移植自 misakano7545/workbuddy2api-panel 的 internal/upstream/thinking.go
// （根因 issue #43，Hermes 逆向官方客户端 codebuddy.js 已确认）。
//
// 根因链：官方客户端对 deepseek 系模型标记 thinkingFormat:"deepseek" +
// requiresReasoningContentOnAssistantMessages，发请求时「开思考」必须显式带
// thinking:{type:"enabled"}，且真实上游对「不带 reasoning_effort」的裸请求
// 仍按不思考应答（reasoning_content 长度 0）——两字段缺一不可：
//   thinking.type=enabled + 某档 effort
// 官方默认档来自模型目录 reasoning.defaultEffort，无来源时兜底 "high"。
//
// 本项目此前只会剥（11150 降级），从不注入——workbuddy 的 deepseek 系模型
// 在网关里从不思考。现在注入默认开（对齐官方客户端形态），三路出口可关：
//   1. 客户端显式：reasoning_effort = off/none/disabled → thinking.type=disabled
//   2. 客户端显式：thinking.type = disabled → 照抄官方 disabled 分支
//   3. 运行期配置：data/workbuddy-runtime.json 的 thinking.enabled=false
//      （env DUMATE_WORKBUDDY_THINKING=0 兜底；面板 > env > 默认）
//   另有单请求逃生口：payload 顶层 wb_no_thinking:true（11150 降级路径自动带，
//   不会被外发——buildChatBody 消费后删除）。
'use strict';

const DEFAULT_DEEPSEEK_EFFORT = 'high';
// 目录 efforts 的实测值域（cn 目录全表：low/medium/high/xhigh/max，见
// probe-workbuddy-ab 的 fetchModels 输出）。xhigh 排在 high 与 max 之间。
const EFFORT_RANK = { minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

/** deepseek 系模型（前缀匹配，不区分大小写；对齐官方 thinkingFormat 判定口径） */
function isDeepSeekModel(model) {
  return /^deepseek/i.test(String(model || '').trim());
}

/** 客户端是否用档位字段表达「关闭思考」。off/none 都不在 EFFORT_RANK 里，
 * 不截住就会被当未知值透传或被钳成最弱正档——「关思考」反而变成「思考开着但最弱」。 */
function effortValueOff(obj) {
  for (const k of ['reasoning_effort', 'reasoningEffort']) {
    const v = obj ? obj[k] : null;
    if (typeof v !== 'string') continue;
    if (['off', 'none', 'disabled'].includes(v.trim().toLowerCase())) return true;
  }
  return false;
}

function deleteEffortFields(obj) {
  delete obj.reasoning_effort;
  delete obj.reasoningEffort;
}

/** 缺 effort 档位时补默认档（snake 优先，camel 兜底）；已有任一 effort 不覆盖 */
function ensureDeepSeekEffort(obj, defaultEffort) {
  if (obj.reasoning_effort !== undefined) return;
  if (obj.reasoningEffort !== undefined) return;
  obj.reasoning_effort = defaultEffort || DEFAULT_DEEPSEEK_EFFORT;
}

/**
 * 档位钳制（misakano payload.go normalizeReasoningEffort 语义）：目录声明了
 * 支持档（efforts 非空）且请求档不在其中时，落到 ≤目标档的最高支持档
 * （「只向下钳」）；全高于目标档时落最低支持档（模型只声明了 stronger 档，
 * 那是它的下限，选最接近的）。目录没声明 efforts → 原样返回（交给 11150 降级）。
 */
function clampEffort(requested, efforts) {
  const raw = String(requested == null ? '' : requested).trim().toLowerCase();
  if (!raw) return requested;
  if (!Array.isArray(efforts) || !efforts.length) return requested;
  const list = efforts.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  if (list.includes(raw)) return raw;
  const reqRank = EFFORT_RANK[raw];
  if (!reqRank) return requested; // 未知档位词不猜（'auto' 等），交上游/降级路径
  let best = null;
  for (const e of list) {
    const r = EFFORT_RANK[e];
    if (r && r <= reqRank && (best === null || r > EFFORT_RANK[best])) best = e;
  }
  if (best) return best;
  // 没有任何 ≤目标的支持档：落目录声明的最低档（最接近「调不动更低」的语义）
  let lowest = null;
  for (const e of list) {
    const r = EFFORT_RANK[e];
    if (r && (lowest === null || r < EFFORT_RANK[lowest])) lowest = e;
  }
  return lowest || requested;
}

/**
 * 按 DeepSeek 思维链开关规则改写请求体。非 deepseek 模型零改动。
 * catalog = { efforts:[], defaultEffort } 来自模型目录（reasoningOf），可为空对象。
 * 返回 true = 该请求是 deepseek 且本轮做了注入判定。
 */
function injectThinking(obj, catalog = {}) {
  if (!obj || typeof obj !== 'object' || !isDeepSeekModel(obj.model)) return false;
  const efforts = Array.isArray(catalog.efforts) ? catalog.efforts : [];
  // 客户端用档位字段表达关闭：转 thinking.type=disabled。必须在注入之前——
  // 否则会被补 enabled + 默认档，「关思考」变成「思考开着但最弱」
  if (effortValueOff(obj)) {
    deleteEffortFields(obj);
    if (obj.thinking && typeof obj.thinking === 'object') obj.thinking.type = 'disabled';
    else obj.thinking = { type: 'disabled' };
    return true;
  }
  const th = obj.thinking && typeof obj.thinking === 'object' ? obj.thinking : null;
  const typ = th ? String(th.type || '').trim().toLowerCase() : '';
  if (typ === 'disabled') {
    // 显式关闭：照抄官方 disabled 分支——关思考且不带任何 effort
    deleteEffortFields(obj);
    return true;
  }
  if (typ) {
    // 显式 enabled（或其他非空值 = 客户端显式控制）：不改 type，缺 effort 补默认档
    ensureDeepSeekEffort(obj, catalog.defaultEffort);
  } else {
    // 无 thinking 或 type 为空：注入 enabled（官方 case "deepseek" 行为）。
    // 已有 reasoning_effort 也走此分支（effort 保留，开关照开）
    if (th) th.type = 'enabled';
    else obj.thinking = { type: 'enabled' };
    ensureDeepSeekEffort(obj, catalog.defaultEffort);
  }
  // 档位钳制：显式 effort 不覆盖值，但按目录收敛（只向下）
  const key = obj.reasoning_effort !== undefined ? 'reasoning_effort' : 'reasoningEffort';
  if (obj[key] !== undefined) {
    const clamped = clampEffort(obj[key], efforts);
    if (clamped && clamped !== String(obj[key]).toLowerCase()) obj[key] = clamped;
  }
  return true;
}

/**
 * DeepSeek 多轮一致性：保证每条 assistant 消息带 string 型 reasoning_content
 * （官方 requiresReasoningContentOnAssistantMessages，#165 对齐 apply 门控）。
 *
 * 门控（官方 ReasoningContentBackfillRule）：thinkingEnabled（注入后
 * thinking.type === 'enabled'）|| hasTrace（任一消息带非空 reasoning 或已有
 * reasoning_content 字段）。非 deepseek 模型零改动。
 *
 * 值语义：rc 已有 string 原样保留；reasoning 是非空 string → 复制；
 * 两者皆无 → 补**单个空格 " "**（部分账号/租户校验 len>0 且不 trim：
 * 空串 400、空白串 200，misakano 实测）；并镜像保证 reasoning 字段存在且非空。
 */
function backfillReasoningContent(obj) {
  if (!obj || typeof obj !== 'object' || !isDeepSeekModel(obj.model)) return false;
  const msgs = Array.isArray(obj.messages) ? obj.messages : null;
  if (!msgs || !msgs.length) return false;
  let thinkingEnabled = false;
  if (obj.thinking && typeof obj.thinking === 'object') {
    const typ = String(obj.thinking.type || '').trim().toLowerCase();
    if (typ === 'enabled') thinkingEnabled = true;
  }
  let hasTrace = false;
  for (const mm of msgs) {
    if (!mm || typeof mm !== 'object') continue;
    if (typeof mm.reasoning === 'string' && mm.reasoning) { hasTrace = true; break; }
    if (mm.reasoning_content !== undefined) { hasTrace = true; break; }
  }
  if (!thinkingEnabled && !hasTrace) return false;
  for (const mm of msgs) {
    if (!mm || typeof mm !== 'object' || mm.role !== 'assistant') continue;
    let rc;
    if (typeof mm.reasoning_content === 'string') {
      rc = mm.reasoning_content; // 已有 string → 不覆盖
    } else if (typeof mm.reasoning === 'string') {
      rc = mm.reasoning;
      mm.reasoning_content = rc;
    } else {
      rc = '';
      mm.reasoning_content = rc;
    }
    // 镜像：reasoning 缺失/空 → 归一化（非空 rc 优先，皆无补 " "）
    if (typeof mm.reasoning === 'string' && mm.reasoning) continue;
    if (rc) mm.reasoning = rc;
    else mm.reasoning = ' ';
  }
  return true;
}

module.exports = {
  DEFAULT_DEEPSEEK_EFFORT, EFFORT_RANK,
  isDeepSeekModel, effortValueOff, clampEffort, injectThinking, backfillReasoningContent,
};
