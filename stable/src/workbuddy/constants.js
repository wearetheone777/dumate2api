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
 * 额度用满（6004）** → 429 → 404 → 5xx → 其余 client。
 * @returns {'hard_credit'|'session_dead'|'restricted'|'model_cap'|'soft_rate'|'not_found'|'server'|'client'}
 */
function classifyStatus(status, body) {
  if (status === 402) return 'hard_credit';
  const lower = String(body || '').toLowerCase();
  for (const m of HARD_CREDIT_MARKERS) {
    if (lower.includes(m.toLowerCase()) || String(body || '').includes(m)) return 'hard_credit';
  }
  for (const m of SESSION_DEAD_MARKERS) {
    if (String(body || '').includes(m)) return 'session_dead';
  }
  // 裸 401 也是凭证判死（上游拒绝这份 accessToken）——原来落到 'client'，
  // send 层无法区分「刷新能救」与「协议错」，401 刷新重试就没有入口
  if (status === 401) return 'session_dead';
  if (RESTRICTED_CODE_RE.test(String(body || ''))) return 'restricted';
  for (const m of RESTRICTED_TEXT_MARKERS) {
    if (lower.includes(m.toLowerCase()) || String(body || '').includes(m)) return 'restricted';
  }
  // 6004 必须在 429 之前判：它是模型级额度事实，处置与账号级 soft_rate 完全不同
  if (MODEL_CAP_CODE_RE.test(String(body || ''))) return 'model_cap';
  for (const m of MODEL_CAP_TEXT_MARKERS) {
    if (lower.includes(m.toLowerCase())) return 'model_cap';
  }
  if (status === 429) return 'soft_rate';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'client';
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
  HARD_CREDIT_MARKERS, SESSION_DEAD_MARKERS, RESTRICTED_CODE_RE, RESTRICTED_TEXT_MARKERS,
  MODEL_CAP_CODE_RE, MODEL_CAP_TEXT_MARKERS, WWW_AUTH_INVALID_TOKEN_RE, PARAM_ERROR_TEXT_RE,
  parseRateLimitReset, classifyStatus,
};
