// dumate2api - 输出预算策略（单一来源）
//
// 上游 GLM 的思维链 (reasoning_content) 与正文 (content) 共用同一个
// max_tokens 预算。reasoning 长度不可控（实测同一提示词 57 - 8492 tokens
// 都有出现），因此客户端给的预算越小，正文越容易被吃光：
//
//   实测（model-text，同一提示词）
//   ------------------------------------------------------------------
//   max_tokens | reasoning | content | finish_reason
//   ------------------------------------------------------------------
//        150  | 150       | 0       | length        <- 完全空回答
//       1024  | 1024      | 0       | length        <- 完全空回答
//       2048  | ~1.5K     | 有      | stop
//       4096  | 57-4074   | 有      | stop
//       8192+ | 任意      | 有      | stop
//
// 客户端自带的 max_tokens 只作参考，代理统一抬到 FLOOR 之上，保证
// reasoning 无论怎么展开都还剩得下正文空间。
//
// 环境变量：
//   DUMATE_MIN_MAX_TOKENS  预算下限，默认 65536（0 = 关闭抬升/压制，只对非法入参兜底）
//   DUMATE_MAX_MAX_TOKENS  预算上限，默认 131072（0 表示不设上限）
//   DUMATE_QWENWORK_MIN_MAX_TOKENS  千问办公专用下限，默认 4096

// 下限取 65536 而非 32768：32768 会在「一次写多章 + 完整项目上下文」下被
// 思维链吃光。实测（Codex 真实会话，写 3 章小说）：
//   预算 32768 → reasoning 32768 / 正文 0，耗时 7.5 分钟，整轮空转
//   预算 65536 → 同任务 reasoning 峰值实测约 22000（88% → 34%），留出余量
// 上游硬上限是 131072（传 200000 会被拒：`max_tokens参数非法：限制数值范围[1,131072]`），
// 所以 65536 只用掉一半空间，仍有向上调整余地。
const FLOOR = parseInt(process.env.DUMATE_MIN_MAX_TOKENS || '65536', 10);
const CEIL = parseInt(process.env.DUMATE_MAX_MAX_TOKENS || '131072', 10);

// 千问办公的下限**远低于**搭子，这是实测得出的，不是为了省：
//   千问的 reasoning 与正文分开流，但**它同样吃 max_tokens**，
//   而且峰值远超早期估计。实测同一「继续写 3 章小说」任务：
//     max_tokens=4096  → reasoning 约 46000 字符，工具参数只剩 216 字符（写不出内容）
//     max_tokens=32000 → reasoning 收敛到 3700 字符，工具参数 8681 字符（正常写作）
//   reasoning 被预算卡住时，模型会陷入反复推演（纠结章节对应哪一天之类），
//   最后只吐一句话就结束——表现为「几秒就停、不按要求做」。
//   所以下限不能太小：4096 对写作类任务远远不够，取 16384 留足思考空间，
//   同时仍明显低于搭子的 32768（避免小请求被撑得过大）。
const QW_FLOOR = (() => {
  const n = parseInt(process.env.DUMATE_QWENWORK_MIN_MAX_TOKENS || '16384', 10);
  return Number.isFinite(n) && n >= 0 ? n : 16384;
})();

// 千问的**默认**预算（客户端没给 max_tokens 时用），与搭子的 DEFAULT_BUDGET 分开。
//
// 取 131072 的实测依据（2026-09-27）：
//   - 上游接受的 max_tokens 范围是 **[1, 131072]**：131072 通过，131073 起一律
//     400（`pro` / `flash` 边界一致，实测）。
//   - **省略 max_tokens 不报错**，且实测一次输出到 **66807 token 才自然收尾**
//     （finish=stop），说明上游自己的默认远大于 66807——原来网关发 32768，
//     是**我们自己**把上限压低了。
//   - 压低的实际代价：Codex 不发 max_output_tokens，网关按默认值下发，实测
//     「一次写 3 章」单轮输出正好撞满 32768 → 上游报 `length`，断在工具参数
//     中间那一章就丢了（实测断在 `@('第三章　第七户','',`）。
// 所以默认值直接取上游上限：网关不再成为那个约束，行为与官方客户端一致
// （客户端自己也不带这个字段）。代价是失控的 reasoning 循环最多烧掉 131072
// token，但那种情形会被 `reasoning_budget_exhausted` 明确报错，不会静默失败。
const QW_DEFAULT = (() => {
  const n = parseInt(process.env.DUMATE_QWENWORK_DEFAULT_MAX_TOKENS || '131072', 10);
  return Number.isFinite(n) && n > 0 ? n : 131072;
})();

// TRAE Work 的下限：与千问同理（reasoning 与正文抢预算），
// 但它实测 reasoning 峰值更高（单次 138~195 token 级别，长任务可到千级），
// 取 16384 与千问一致——低于这个值长任务会被 reasoning 吃光正文。
const TW_FLOOR = (() => {
  const n = parseInt(process.env.DUMATE_TRAEWORK_MIN_MAX_TOKENS || '16384', 10);
  return Number.isFinite(n) && n >= 0 ? n : 16384;
})();

const DEFAULT_BUDGET = 32768;

// Qoder 的输出预算下限。与千问/TRAE 同理：reasoning 与正文共用 max_tokens，
// 小值会被 reasoning 吃光、正文为空。默认 16384（与 TRAE 一致，实测够用）。
const QD_FLOOR = (() => {
  const n = parseInt(process.env.DUMATE_QODER_MIN_MAX_TOKENS || '16384', 10);
  return Number.isFinite(n) && n >= 0 ? n : 16384;
})();

/**
 * 搭子的预算钳制。cap 是**按模型**的输出上限（src/dumate-caps.js：实测表 +
 * 上游错误自学习）——旧的单一 CEIL 来自 GLM 一家的范围，对 deepseek 低延迟
 * （384K）与 kimi-k3（≥200 万）是白压低。cap 缺失时行为与旧版完全一致；
 * cap 比 FLOOR 小时以 cap 为准（上游范围优先于本地下限，宁可发小也别 400）。
 */
function resolveMaxTokens(requested, cap) {
  const n = Number(requested);
  let out = Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET;
  // FLOOR=0 表示关闭预算策略：只对缺失/非法入参兜底到默认值，
  // 客户端明确给出的值原样透传，不再抬升也不再压制。
  if (FLOOR > 0) out = Math.max(out, FLOOR);
  const ceil = Number.isFinite(cap) && cap > 0 ? cap : CEIL;
  if (ceil > 0) out = Math.min(out, ceil);
  return out;
}

/**
 * 千问办公的预算。与搭子分开的原因见 QW_FLOOR 的注释：
 * 千问也要兜底（否则小预算直接截断正文），但下限低得多。
 * 传 0 表示完全不干预（保留逃生口）。
 */
function resolveQwenMaxTokens(requested) {
  const n = Number(requested);
  let out = Number.isFinite(n) && n > 0 ? n : QW_DEFAULT;
  if (QW_FLOOR > 0) out = Math.max(out, QW_FLOOR);
  if (CEIL > 0) out = Math.min(out, CEIL);
  return out;
}

/** TRAE Work 的预算。与千问同一套逻辑，下限独立可配 */
function resolveTraeworkMaxTokens(requested) {
  const n = Number(requested);
  let out = Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET;
  if (TW_FLOOR > 0) out = Math.max(out, TW_FLOOR);
  if (CEIL > 0) out = Math.min(out, CEIL);
  return out;
}

/**
 * Qoder 的预算。与千问/TRAE 同一套逻辑（reasoning 与正文抢预算），
 * 下限独立可配——**三通道各一套，不要互相套用**。
 */
function resolveQoderMaxTokens(requested) {
  const n = Number(requested);
  let out = Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET;
  if (QD_FLOOR > 0) out = Math.max(out, QD_FLOOR);
  if (CEIL > 0) out = Math.min(out, CEIL);
  return out;
}

module.exports = {
  resolveMaxTokens,
  resolveQwenMaxTokens,
  resolveTraeworkMaxTokens,
  resolveQoderMaxTokens,
  FLOOR,
  QW_FLOOR,
  QW_DEFAULT,
  TW_FLOOR,
  QD_FLOOR,
  CEIL,
  DEFAULT_BUDGET,
};
