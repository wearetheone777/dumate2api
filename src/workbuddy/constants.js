// src/workbuddy/constants.js - WorkBuddy 数据面常量
//
// WorkBuddy 是腾讯 Copilot 系的 AI 编程助手（国内 WorkBuddy / 国际 WorkBuddy AI），
// 与 CodeBuddy 同源。协议要点（参照 qoder-trae-workbuddy-switch 的
// modules/upstream.rs + region.rs + account.rs + checkin.rs 逐条移植）：
//   - chat：标准 OpenAI 形状（/v2/chat/completions），强制 stream:true
//   - 双区域端点、模型目录路径、UA 形态都不同（见 REGION_SPECS）
//   - 签到仅国内版有（国际版明确不支持）
//   - 额度在 billing 域的 get-user-resource（套餐包列表）
//
// 区域术语：通道内部用 'cn' / 'global'（与 qoder 同构）；keys.js 的 'intl'
// 在 index.js 的选号层映射成 'global'。
const CHANNEL_ID = 'workbuddy';
const DISPLAY_NAME = 'WorkBuddy';

// CLI 形态 UA（刷新 / CN 目录请求用，上游按它识别客户端来源）
const CLIENT_UA = (process.env.DUMATE_WORKBUDDY_CLI_UA || 'CLI/2.63.2 CodeBuddy/2.63.2').trim();

// 国际版 chat 前置的最小 system 提示词：上游网关要求首条必须是 system，
// 只为满足前置条件，不引导模型（参照 upstream.rs INTERNATIONAL_SYSTEM_PROMPT）
const INTERNATIONAL_SYSTEM_PROMPT = 'You are a helpful assistant.';

// ---- 区域描述符（对照 region.rs 的 RegionSpec，一区一整行，不要再 if 散落）----
const REGION_SPECS = {
  cn: {
    id: 'cn',
    label: '国内版',
    // chat 上游基址
    chatBase: 'https://copilot.tencent.com',
    // billing / 签到 / 额度基址（与 chat 不同域，混用会 404）
    billingBase: 'https://www.codebuddy.cn',
    // 模型目录：CN 走 CLI 同款路径
    modelsPath: '/console/enterprises/personal/models',
    // 目录 UA 形态：CN 是 CLI 形态（CLIENT_UA）
    catalogUa: 'cli',
    fallbackAppVersion: '5.5.6',
  },
  global: {
    id: 'global',
    label: '国际版',
    chatBase: 'https://www.workbuddy.ai',
    billingBase: 'https://www.workbuddy.ai',
    // 国际版模型目录是 App 形态的 /v3/config（可能返回裸文档，无 {code,data} 包装）
    modelsPath: '/v3/config',
    catalogUa: 'app',
    fallbackAppVersion: '5.5.2',
  },
};

function specOf(region) {
  return REGION_SPECS[region === 'global' ? 'global' : 'cn'] || REGION_SPECS.cn;
}

/** 归一化区域：'global' 才是国际（'intl' 由选号层先映射），其余一律国内 */
function normalizeRegion(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return s === 'global' || s === 'intl' ? 'global' : 'cn';
}

/** 官方客户端认证文件的候选路径（账号导入用；登录流程后置）。
 *  文件结构：{ auth: {accessToken, refreshToken, expiresAt, domain}, account: {uid, nickname} } */
function authFileCandidates(region) {
  const name = region === 'global' ? 'workbuddy-desktop-ai.info' : 'workbuddy-desktop.info';
  const appdata = process.env.APPDATA || '';
  const local = process.env.LOCALAPPDATA || '';
  const home = process.env.USERPROFILE || '';
  const out = [];
  // 实测本机位置：CodeBuddyExtension 的公共 auth 目录
  if (local) out.push(`${local}\\CodeBuddyExtension\\Data\\Public\\auth\\${name}`);
  if (home) out.push(`${home}\\${name}`);
  if (appdata) out.push(`${appdata}\\@genie\\workbuddy-desktop\\${name}`);
  return out;
}

// ---- 端点路径 ----
const EP_CHAT = '/v2/chat/completions';
const EP_REFRESH = '/v2/plugin/auth/token/refresh';
// 签到族挂在 billing 域的 /v2/billing/meter 下（CHECKIN_API_PREFIX）
const CHECKIN_API_PREFIX = '/v2/billing/meter';
const EP_CHECKIN_STATUS = '/checkin-activity-status';     // 新接口
const EP_CHECKIN_STATUS_FALLBACK = '/checkin-status';     // 旧接口（新接口失败时回退）
const EP_CHECKIN_CLAIM = '/daily-checkin';
const EP_CREDITS = '/get-user-resource';                  // 额度包（POST）
/**
 * 模型实时繁忙度探针（2026-11-08 融合批，GitHub 生态调研）。
 *
 * **为什么值钱**：这是唯一「免费、不扣额度、不动账号状态」的上游接口——
 * 一次批量问 ≤50 个模型的繁忙度（idle/normal/busy/congested/unavailable），
 * 用它可以在**选号前**就知道该模型排队严重，而不是撞满 429 再退避。
 *
 * **国际版 404**（实测）：只有国内有这个端点。调用方必须容忍 404 → 当成
 * 「没有繁忙度信息」而不是「通道坏了」。
 */
const EP_CHAT_BUSY = '/v2/chat/busy';

// ---- 失败分类标记（对照 upstream.rs classify_upstream_error）----
// 硬性积分不足（402 或响应体含这些标记都按额度问题处理）
const HARD_CREDIT_MARKERS = [
  'insufficient credit', 'no credit', 'credit exhausted', 'credits exhausted',
  'out of credit', 'quota exceeded', 'quota exhaust', 'payment required',
  'credit not enough', 'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
];
// 会话被上游作废的标记（出现在响应体里；裸 401 与它的处置不同）
const SESSION_DEAD_MARKERS = ['Offline user session not found', '12153'];
// **账号级风控**（11140，TraeWorkAssistant issue #136 实测）：账号被上游限制
// 使用——与设备指纹无关、**换号有意义**（受限由上游按账号判定）。处置是
// SwitchKey 换号接替 + 403 明确报错，不是熔断。
// 码值匹配带**负向数字断言**（111400 会包含 11140 子串，裸 includes 必误吃）
const RESTRICTED_CODE_RE = /"code"\s*:\s*11140(?!\d)|\bcode 11140(?!\d)/i;
const RESTRICTED_TEXT_MARKERS = ['账号存在异常行为', 'unusual activity', '已被限制使用'];

// **模型窗口额度用满**（6004，hub v1.9.0 #668/#672）：上游 429 + body 带
// code 6004——唯一带重置墙钟的额度判定，且粒度是 (账号, 模型)：该模型撞线
// 同账号其他模型照常可用。处置是**模型级冷却**（scope:model 喂池）+ 换号
// 打同模型，绝不能按账号级 429 把整个账号封掉。码值同样带负向数字断言。
const MODEL_CAP_CODE_RE = /"code"\s*:\s*"?6004"?(?!\d)/;
const MODEL_CAP_TEXT_MARKERS = [
  'usage exceeds frequency limit',          // intl 实测文案
  '使用量已超出频率限制',                     // cn 实测文案
];
// 认网关的 WWW-Authenticate 判死 401（hub v1.9.0 #686）：国内版上游是 APISIX，
// 凭证被拒时回的是 <html>401 Authorization Required</html>，死因只在响应头
// `Bearer realm="copilot", error="invalid_token"` 里。RFC 6750 的 invalid_token
// 是真失效的证据，挑战头优先于一切 body 判据。
const WWW_AUTH_INVALID_TOKEN_RE = /invalid[-_]token/i;
// 请求参数错误（hub v1.10.11 #794）：`The request param is invalid` 等——请求
// 本身的问题，换号/冷却整个账号池都无意义，下游如实 400。
const PARAM_ERROR_TEXT_RE = /request param is invalid|invalid request param|params? (is|are) invalid/i;

// ---------------------------------------------------------------------------
// 2026-11-08 融合批：把「被误当成账号故障」的四类请求级错误单独认出来
//
// 出处：GitHub 生态调研（xu20060420fan-cell/workbuddy2api-trae-qoder-minimax-panel
// 的 `internal/upstream/client.go` 14 个 ErrKind，与 linguo2625469/workbuddy2api-panel
// 母版交叉实证）。
//
// **为什么要拆**：这四类码都是 HTTP 400/429，原来一律落到 `client` 或
// `soft_rate`。而 `client` 在 send 层的处置是「如实报 400」——看起来无害，
// 但 `soft_rate` 会被喂池冷却**整个账号**，代价是「换模型就能过」的请求把
// 一个健康账号踢下线。真实事故形态：一个不支持 reasoning 的模型被请求
// 带了 effort 参数 → 11150 → 按 429 冷却 → 该账号 10 分钟内所有模型都不可用。
//
// 四类的处置各不相同，所以必须是四个 kind，不能合并：
//   model_unavailable  11102/11103/11158  (账号,模型) 负缓存，换模型能过
//   queue              6020/6021/6022     排队事实，报位次不罚号、不重试
//   reasoning_unsupported 11150           补默认档重发一次即成功
//   tool_pair_mismatch 11148             修历史配对能过（与 repair 门同源）
// ---------------------------------------------------------------------------

/** 模型对**该账号**不可用（目录里有、路由没配 / 档位不够）。负缓存粒度是 (账号,模型) */
const MODEL_UNAVAILABLE_CODE_RE = /"code"\s*:\s*"?1110[23]"?(?!\d)|"code"\s*:\s*"?11158"?(?!\d)/;
const MODEL_UNAVAILABLE_TEXT_MARKERS = [
  'service info not found',            // 11102 实测文案
  'is not allowed for user type',      // 11158 实测文案（个人免费档请求付费模型）
  'not support this call',             // 11103
];

/** 排队（6020 等待 / 6021 队列满 / 6022 达上限）。**不是故障**，报位次给人看 */
const QUEUE_CODE_RE = /"code"\s*:\s*"?602[012]"?(?!\d)/;

/** reasoning effort 不被该模型支持（11150）。补默认档重发一次即可，不罚号 */
const REASONING_CODE_RE = /"code"\s*:\s*"?11150"?(?!\d)/;
const REASONING_TEXT_MARKERS = ['reasoning effort is not supported', 'reasoning_effort'];

/** tool_calls 与 tool 结果不配对（11148）。修历史即能过，与「播报即收尾」修复同源 */
const TOOL_PAIR_CODE_RE = /"code"\s*:\s*"?11148"?(?!\d)/;
const TOOL_PAIR_TEXT_MARKERS = [
  'tool calls and tool results do not match',
  'tool_calls and tool results',
];

/**
 * **积分耗尽（14018）**（2026-11-08 融合批）。
 *
 * 出处：GitHub 生态调研（buddy-proxy）。这个码有两个坑，都要在判据里处理：
 *   1. **它可能藏在 `error.data.code` 嵌套层**，不是顶层 `code`——
 *      只匹配 `"code":14018` 会漏掉嵌套形态；
 *   2. 文案有**单复数**（`credit exhausted` / `credits exhausted`）。
 *
 * **漏判的代价**（调研原话）：会退化成每 2 分钟重试一次。因为 14018 通常带
 * HTTP 4xx/429，落到 `soft_rate` 只会软冷却几分钟，然后无限重试——
 * 而积分耗尽应当**硬冷却到次日签到恢复**（WorkBuddy 的额度按天重置）。
 */
const CREDIT_EXHAUSTED_CODE_RE = /"code"\s*:\s*"?14018"?(?!\d)/;
const CREDIT_EXHAUSTED_TEXT_MARKERS = [
  'credit exhausted', 'credits exhausted',
  'credit(s) exhausted', 'no credit left',
  '积分已耗尽', '积分耗尽', '额度已耗尽',
];

/**
 * 从上游 429 正文里解析重置墙钟（hub parse_rate_limit_reset 移植）。
 * 上游只在 6004 里写，两种实测形状：
 *   intl: "... your usage will reset at 2026-09-19 18:29:03 UTC+8 ..."
 *   cn:   "您的使用量已超出频率限制，将在 2026-10-02 16:00:34 UTC+8 重置 ..."
 * 墙钟是正文自己 UTC 偏移下的时刻：按 UTC 解析再减偏移（等价 hub 的
 * timegm——不能用 Date.parse 裸解析，会被宿主机时区带偏几个小时）。
 * 措辞不认识时兜底认「YYYY-MM-DD HH:MM:SS UTC±N」搭配。返回 epoch 秒或 null。
 */
function unescapeBody(detail) {
  const s = String(detail || '');
  if (!s.includes('\\u')) return s;
  // 只还原 \uXXXX（中间层把 UTF-8 中文转成 JSON 转义形态）；\n \t 等其余
  // 序列不动——整串 unicode_escape 会把正常文本解成乱码
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function parseRateLimitReset(detail) {
  const text = unescapeBody(detail);
  if (!text) return null;
  const m = /(?:reset at|将在)\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/i.exec(text)
    || /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})\s*UTC[+-]\d{1,2}/.exec(text);
  if (!m) return null;
  const stamp = m[1].replace('T', ' ');
  const tz = /UTC([+-]\d{1,2})(?::?(\d{2}))?/.exec(text);
  let offset = 0;
  if (tz) {
    const h = parseInt(tz[1], 10);
    const mins = parseInt(tz[2] || '0', 10) || 0;
    offset = h * 3600 + (h >= 0 ? mins * 60 : -mins * 60);
  }
  const t = Date.parse(`${stamp.split(' ')[0]}T${stamp.split(' ')[1]}Z`);
  if (!Number.isFinite(t)) return null;
  return Math.floor(t / 1000) - offset;
}

/**
 * 上游失败分类（严格按参照实现的判定顺序）：402 优先于 body 标记 →
 * 硬额度标记 → 会话作废标记 → **裸 401 判死** → **账号风控** → **模型窗口
 * 额度用满（6004）** → **请求级四类（2026-11-08 加）** → 429 → 404 → 5xx → 其余 client。
 *
 * 请求级四类插在 429 之前、6004 之后：
 *   - 它们都不是账号故障，落到 soft_rate 会被喂池冷却整个账号；
 *   - 但 6004 带重置墙钟、优先级更高，不能被它们抢走（同一 body 两个码时按 6004）。
 * @returns {'hard_credit'|'session_dead'|'restricted'|'model_cap'
 *   |'model_unavailable'|'queue'|'reasoning_unsupported'|'tool_pair_mismatch'
 *   |'soft_rate'|'not_found'|'server'|'client'}
 */
function classifyStatus(status, body) {
  if (status === 402) return 'hard_credit';
  const lower = String(body || '').toLowerCase();
  const raw = String(body || '');
  // **账号风控必须最先判**（2026-11-08 修正顺序）：
  //   11140 的处置是「不换号 + 连坐计数 + 区域暂停」，与额度类 hard_credit
  //   （喂池硬冷却到次日）完全不同。而 HARD_CREDIT_MARKERS 里含
  //   'credits exhausted' 这类文案——若先判额度，一个「账号被限制」的响应
  //   只要文案里带一句 quota 相关词就会被误判成积分耗尽，账号进 12 小时硬冷却，
  //   而真正该做的是停止整个区域的换号。
  if (RESTRICTED_CODE_RE.test(raw)) return 'restricted';
  for (const m of RESTRICTED_TEXT_MARKERS) {
    if (lower.includes(m.toLowerCase()) || raw.includes(m)) return 'restricted';
  }
  for (const m of HARD_CREDIT_MARKERS) {
    if (lower.includes(m.toLowerCase()) || raw.includes(m)) return 'hard_credit';
  }
  for (const m of SESSION_DEAD_MARKERS) {
    if (raw.includes(m)) return 'session_dead';
  }
  // 裸 401 也是凭证判死（上游拒绝这份 accessToken）——原来落到 'client'，
  // send 层无法区分「刷新能救」与「协议错」，401 刷新重试就没有入口
  if (status === 401) return 'session_dead';
  // 14018 积分耗尽：排在 6004 与 429 之前。
  // 它常常带 429，落到 soft_rate 会软冷却几分钟然后无限重试；
  // 积分耗尽要硬冷却到次日重置。判据同时覆盖顶层 code 与 `error.data.code`
  // 嵌套形态（负向断言保证不会误吃 140180）。
  // **比 6004 更优先**：积分彻底耗尽是账号级事实，此时"某个模型的窗口额度"
  // 已经没有意义（整个号都调不动）。若判成 model_cap，池只冷却那一个模型，
  // 其余模型继续撞同一个耗尽态，于是每 2 分钟重试一次（调研点名的代价）。
  if (CREDIT_EXHAUSTED_CODE_RE.test(raw)) return 'hard_credit';
  for (const m of CREDIT_EXHAUSTED_TEXT_MARKERS) {
    if (lower.includes(m.toLowerCase()) || raw.includes(m)) return 'hard_credit';
  }
  // 6004 必须在 429 之前判：它是模型级额度事实，处置与账号级 soft_rate 完全不同
  if (MODEL_CAP_CODE_RE.test(raw)) return 'model_cap';
  for (const m of MODEL_CAP_TEXT_MARKERS) {
    if (lower.includes(m.toLowerCase())) return 'model_cap';
  }
  // ---- 请求级四类（都不许喂池冷却整个账号）----
  if (QUEUE_CODE_RE.test(raw)) return 'queue';
  if (MODEL_UNAVAILABLE_CODE_RE.test(raw)) return 'model_unavailable';
  for (const m of MODEL_UNAVAILABLE_TEXT_MARKERS) {
    if (lower.includes(m.toLowerCase())) return 'model_unavailable';
  }
  if (REASONING_CODE_RE.test(raw)) return 'reasoning_unsupported';
  for (const m of REASONING_TEXT_MARKERS) {
    if (lower.includes(m.toLowerCase())) return 'reasoning_unsupported';
  }
  if (TOOL_PAIR_CODE_RE.test(raw)) return 'tool_pair_mismatch';
  for (const m of TOOL_PAIR_TEXT_MARKERS) {
    if (lower.includes(m.toLowerCase())) return 'tool_pair_mismatch';
  }
  if (status === 429) return 'soft_rate';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'client';
}

/** 该 kind 是否**属于账号故障**（只有它才该被喂池冷却/换号） */
function isAccountFault(kind) {
  return kind === 'hard_credit' || kind === 'session_dead'
    || kind === 'restricted' || kind === 'server' || kind === 'soft_rate';
}

/** 该 kind 是否**属于请求级**（换号/冷却无意义，重发同样的请求也一样错） */
function isRequestFault(kind) {
  return kind === 'model_unavailable' || kind === 'queue'
    || kind === 'reasoning_unsupported' || kind === 'tool_pair_mismatch'
    || kind === 'client' || kind === 'not_found';
}

/**
 * 排队位次的人话（6020/6021/6022）。调研里 dsh-connect-workbuddy 的做法：
 * 把上游的排队事实翻成一句用户能懂的话，而不是报「429 限流」。
 * @returns {{position:number|null, size:number|null, retryAfter:number|null, text:string}|null}
 */
function parseQueueInfo(detail) {
  const text = unescapeBody(detail);
  if (!text) return null;
  // 键名变体实测见过三种写法：snake_case / camelCase / 带横线。
  // 统一按「键名里允许 - 或 _ 或驼峰」匹配，别只认一种。
  const grab = (keys) => {
    for (const k of keys) {
      const re = new RegExp(`${k}["'\\s:=]+(\\d+)`, 'i');
      const m = re.exec(text);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  };
  const position = grab(['queue[_\\-]?position', 'queuePosition']);
  const size = grab(['queue[_\\-]?size', 'queueSize']);
  const retryAfter = grab(['retry[_\\-]?after', 'retryAfter']);
  if (position == null && size == null && retryAfter == null) return null;
  let t = '上游排队中';
  if (position != null && size != null) t = `上游排队中（第 ${position} 位，队列 ${size}）`;
  else if (position != null) t = `上游排队中（第 ${position} 位）`;
  if (retryAfter != null) t += `，建议 ${retryAfter} 秒后重试`;
  return { position, size, retryAfter, text: t };
}

module.exports = {
  CHANNEL_ID,
  DISPLAY_NAME,
  CLIENT_UA,
  INTERNATIONAL_SYSTEM_PROMPT,
  REGION_SPECS,
  specOf,
  normalizeRegion,
  authFileCandidates,
  EP_CHAT, EP_REFRESH, CHECKIN_API_PREFIX,
  EP_CHECKIN_STATUS, EP_CHECKIN_STATUS_FALLBACK, EP_CHECKIN_CLAIM, EP_CREDITS,
  EP_CHAT_BUSY,
  HARD_CREDIT_MARKERS, SESSION_DEAD_MARKERS, RESTRICTED_CODE_RE, RESTRICTED_TEXT_MARKERS,
  MODEL_CAP_CODE_RE, MODEL_CAP_TEXT_MARKERS, WWW_AUTH_INVALID_TOKEN_RE, PARAM_ERROR_TEXT_RE,
  MODEL_UNAVAILABLE_CODE_RE, MODEL_UNAVAILABLE_TEXT_MARKERS,
  QUEUE_CODE_RE, REASONING_CODE_RE, REASONING_TEXT_MARKERS,
  TOOL_PAIR_CODE_RE, TOOL_PAIR_TEXT_MARKERS,
  CREDIT_EXHAUSTED_CODE_RE, CREDIT_EXHAUSTED_TEXT_MARKERS,
  parseRateLimitReset, parseQueueInfo, classifyStatus, isAccountFault, isRequestFault,
};
