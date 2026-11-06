// src/workbuddy/login.js - WorkBuddy OAuth 设备授权登录（浏览器登录，天然多账号）
//
// 协议来源（两个独立开源实现交叉验证 + 本机实测）：
//   linguo2625469/workbuddy2api-panel  cmd/login/main.go   （Go）
//   ardeyouxipianyi/workbuddy2api-hub  wb_accounts.py      （Python）
//
// 流程（浏览器只是**授权面**，token 由上游签发给 platform=CLI）：
//   1. POST {chatBase}/v2/plugin/auth/state?platform=CLI
//      → { code:0, data:{ state, authUrl } }        authUrl = 官方登录页
//   2. 用户在浏览器打开 authUrl 完成登录（手机号/微信/OneID 均可）
//   3. GET  {chatBase}/v2/plugin/auth/token?state=<state>
//      → 未完成：业务 code 11217（LOGIN_PENDING）；完成：code 0 +
//        data:{ accessToken, refreshToken, expiresAt|expiresIn, domain }
//   4. GET  {chatBase}/v2/plugin/login/account?state=<state>（Bearer accessToken）
//      → data:{ uid, nickname, enterpriseId }（best-effort，失败时从 JWT sub 取 uid）
//
// 这与「浏览器 cookie」是两回事：网页登录态是 cookie（凭据面），而模型接口
// 要的是 Bearer accessToken/refreshToken（客户端面）。官方设备授权流程正好
// 把「浏览器登录」桥接成后者——**多账号就是每个账号各走一遍**（换账号后
// 重新生成 state；浏览器已登录别的账号时可用无痕窗口）。
//
// 落盘走 authStore.upsert（uid+region 幂等），source 标 'oauth'。
const https = require('https');
const c = require('./constants');
const authStore = require('./auth');

/** 设备授权等待中的业务码（上游在浏览器未完成登录时返回） */
const LOGIN_PENDING = 11217;

/** 登录窗口 TTL（毫秒）：超过后 state 基本作废，前端应重新发起 */
const LOGIN_TTL_MS = 10 * 60 * 1000;

/** 区域识别：token/域名字符串里出现这些字样分别归国内/国际（参照 hub 的 REALM_MARKERS） */
const CN_MARKERS = ['copilot.tencent.com', 'codebuddy.cn', 'workbuddy.cn'];
const INTL_MARKERS = ['workbuddy.ai', 'codebuddy.ai'];

/** 解析 JWT payload（accessToken 是 JWT，uid=sub、exp=过期秒） */
function jwtClaims(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return {};
    const pad = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(pad + '='.repeat((4 - (pad.length % 4)) % 4), 'base64').toString('utf8');
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) { return {}; }
}

/**
 * 凭据域与目标区域是否一致（区域红线，与 importFromClient 同口径但更宽容）：
 * 域名缺省时信任请求的区域（端点是按区域分开的，登录就发生在该区）；
 * 命中对方标记集合则拒绝。返回 { ok, error? }。
 */
function checkRegion(region, domain) {
  const d = String(domain || '').toLowerCase();
  if (!d) return { ok: true };
  const hitCN = CN_MARKERS.some((m) => d.includes(m));
  const hitIntl = INTL_MARKERS.some((m) => d.includes(m));
  if (region === 'global' && hitCN) {
    return { ok: false, error: `凭据域（${domain}）是国内账号，不能导入国际区域` };
  }
  if (region !== 'global' && hitIntl) {
    return { ok: false, error: `凭据域（${domain}）是国际版账号，不能导入国内区域` };
  }
  return { ok: true };
}

/** 归一化到期时刻：绝对值（秒或毫秒）→ 毫秒；其次相对 expiresIn（秒）；再次 JWT exp */
function expiryOf(data, token) {
  const abs = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n > 1e11 ? n : n * 1000;
    // 合理区间：2024 年之后、10 年之内——脏值不采信
    return ms > 1700000000000 && ms < Date.now() + 10 * 365 * 86400000 ? ms : null;
  };
  const fromData = abs(data && (data.expiresAt ?? data.expires_at));
  if (fromData) return fromData;
  const rel = Number(data && (data.expiresIn ?? data.expires_in));
  if (Number.isFinite(rel) && rel > 0) return Date.now() + rel * 1000;
  const exp = Number(jwtClaims(token).exp);
  if (Number.isFinite(exp) && exp > 0) return exp * 1000;
  return null;
}

/** 纯函数：解析 auth/state 响应信封 */
function parseAuthState(doc) {
  if (!doc || Number(doc.code) !== 0) {
    return { ok: false, error: `auth/state 失败：code=${doc && doc.code} ${(doc && (doc.msg || doc.message)) || ''}`.trim() };
  }
  const d = doc.data || {};
  if (!d.state || !d.authUrl) return { ok: false, error: 'auth/state 响应里缺 state/authUrl' };
  return { ok: true, state: String(d.state), authUrl: String(d.authUrl) };
}

/**
 * 纯函数：解析 auth/token 响应信封。
 * @returns {{status:'pending'|'ok'|'error', error?, token?:object}}
 */
function parseTokenDoc(doc) {
  const code = doc ? Number(doc.code) : NaN;
  if (code === LOGIN_PENDING) return { status: 'pending' };
  if (code !== 0) {
    return { status: 'error', error: `auth/token code=${code} ${(doc && (doc.msg || doc.message)) || ''}`.trim() };
  }
  const d = (doc && doc.data) || {};
  const accessToken = d.accessToken || d.access_token || '';
  if (!accessToken) return { status: 'pending' };
  return {
    status: 'ok',
    token: {
      accessToken,
      refreshToken: d.refreshToken || d.refresh_token || '',
      domain: d.domain || '',
      expiresAt: expiryOf(d, accessToken),
    },
  };
}

// 可注入的请求层（单测替换；生产用默认实现）
let requestImpl = defaultRequest;

/** 默认请求实现：{code,msg,data} 信封。返回 { status, doc, raw } */
function defaultRequest(region, method, pathWithQuery, opts = {}) {
  const spec = c.specOf(region);
  const u = new URL(spec.chatBase + pathWithQuery);
  const body = opts.body != null ? JSON.stringify(opts.body) : '';
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': c.CLIENT_UA,
    Origin: spec.billingBase,
    Referer: spec.billingBase + '/',
  };
  if (body) headers['Content-Length'] = String(Buffer.byteLength(body));
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(opts.account || {}); } catch (e) { /* 无代理直连 */ }
  return new Promise((resolve) => {
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method, headers,
      ...(agent ? { agent } : {}), timeout: opts.timeout || 20000,
    }, (res) => {
      let buf = '';
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      res.on('data', (x) => { buf += dec.write(x); });
      res.on('end', () => {
        buf += dec.end();
        let doc = null;
        try { doc = JSON.parse(buf); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, doc, raw: buf });
      });
    });
    req.on('error', (e) => resolve({ status: 0, doc: null, raw: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, doc: null, raw: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

/** 单测注入点（传 null 恢复默认） */
function _setRequest(fn) { requestImpl = typeof fn === 'function' ? fn : defaultRequest; }

/**
 * 第一步：生成授权链接。
 * @param {'cn'|'global'} region
 * @returns {Promise<{ok:boolean, state?:string, authUrl?:string, region:string, error?:string}>}
 */
async function startLogin(region) {
  const reg = c.normalizeRegion(region);
  const r = await requestImpl(reg, 'POST', '/v2/plugin/auth/state?platform=CLI', { body: {} });
  if (r.status === 0) return { ok: false, region: reg, error: `网络错误：${r.raw}` };
  if (r.status < 200 || r.status >= 300) return { ok: false, region: reg, error: `HTTP ${r.status}: ${String(r.raw || '').slice(0, 120)}` };
  const parsed = parseAuthState(r.doc);
  if (!parsed.ok) return { ok: false, region: reg, error: parsed.error };
  return { ok: true, region: reg, state: parsed.state, authUrl: parsed.authUrl };
}

/**
 * 第二步：轮询一次。pending / ok / error / expired 四态。
 * ok 时已写入账号池（upsert，source='oauth'），返回账号的脱敏行。
 */
async function pollLogin(region, state) {
  const reg = c.normalizeRegion(region);
  const st = String(state || '').trim();
  if (!st) return { status: 'error', error: '缺 state（先调 login/url）' };
  const r = await requestImpl(reg, 'GET', `/v2/plugin/auth/token?state=${encodeURIComponent(st)}`);
  if (r.status === 0) return { status: 'pending', error: `网络错误：${r.raw}` };
  if (r.status >= 500) return { status: 'pending', error: `上游 HTTP ${r.status}` };
  if (r.status >= 400) return { status: 'error', error: `HTTP ${r.status}: ${String(r.raw || '').slice(0, 120)}` };
  const parsed = parseTokenDoc(r.doc);
  if (parsed.status !== 'ok') return parsed;

  const t = parsed.token;
  const regionCheck = checkRegion(reg, t.domain);
  if (!regionCheck.ok) return { status: 'error', error: regionCheck.error };

  // 账号信息：优先 login/account；失败回落 JWT sub（uid 的权威来源之一）
  let profile = {};
  try {
    const a = await requestImpl(reg, 'GET', `/v2/plugin/login/account?state=${encodeURIComponent(st)}`, { bearer: t.accessToken });
    if (a.status >= 200 && a.status < 300 && a.doc && Number(a.doc.code) === 0) {
      profile = a.doc.data || {};
    }
  } catch (e) { /* best-effort */ }
  const uid = String(profile.uid || jwtClaims(t.accessToken).sub || '');
  if (!uid) return { status: 'error', error: '登录成功但取不到 uid（login/account 与 JWT 都没有）' };
  if (!t.refreshToken) return { status: 'error', error: '登录响应里没有 refreshToken（无法续期，拒绝导入）' };

  const rec = {
    uid,
    region: reg,
    nickname: String(profile.nickname || ''),
    email: String(profile.email || ''),
    enterpriseId: String(profile.enterpriseId || profile.enterprise_id || ''),
    enterpriseName: String(profile.enterpriseName || ''),
    domain: t.domain || (reg === 'global' ? 'www.workbuddy.ai' : 'copilot.tencent.com'),
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    expiresAt: t.expiresAt || null,
    source: 'oauth',
    lastError: '',
  };
  const saved = authStore.upsert(rec);
  const account = authStore.list().find((a) => a.id === saved.id) || null;
  return { status: 'ok', account };
}

module.exports = {
  LOGIN_PENDING, LOGIN_TTL_MS, CN_MARKERS, INTL_MARKERS,
  startLogin, pollLogin,
  // 纯函数导出：单测用（内部推导不导出＝没测到）
  jwtClaims, checkRegion, expiryOf, parseAuthState, parseTokenDoc,
  _setRequest,
};
