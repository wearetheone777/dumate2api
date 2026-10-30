// src/traework/auth.js - 凭证存储与 token 刷新
//
// 与千问的关键差异：**不需要读客户端文件**。
// TRAE Work 的凭证由我们自己在登录流程里换取（见 login.js），
// 存到 data/traework-accounts.json —— 多账号就是多条记录。
//
// 这与搭子的 web-accounts.json 同构（都是我们自己持有凭证），
// 而不是千问那种「只读客户端 auth-v2.dat」。
//
// refreshToken 是**轮换**的：每次 ExchangeToken 都会返回新的，
// 必须原子落盘，否则旧 token 失效后账号就废了。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const c = require('./constants');
const { oauthHeaders } = require('./headers');
const { explainError } = require('../errtext');
const filelock = require('../filelock');
const fileperm = require('../fileperm');
const jitter = require('../jitter');

const FILE = 'traework-accounts.json';

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
}

function filePath() {
  return path.join(dataDir(), FILE);
}

/** 读全部账号。按 mtime 失效重读（与 keys.js / modelmap.js 同一策略） */
let cache = { mtime: -1, data: null };
function load() {
  let mtime = 0;
  try { mtime = fs.statSync(filePath()).mtimeMs; } catch (e) { /* 不存在 */ }
  if (cache.data && cache.mtime === mtime) return cache.data;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(filePath(), 'utf8')); } catch (e) { /* 坏文件当空 */ }
  const data = { accounts: Array.isArray(raw && raw.accounts) ? raw.accounts : [] };
  cache = { mtime, data };
  return data;
}

/** 原子写：先 .tmp 再 rename。中途被 kill 不会留下半个 JSON */
function save(data) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const target = filePath();
  const tmp = `${target}.tmp`;
  // 权限收紧（fileperm.js）：token 只留在当前用户可读的文件里
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fileperm.harden(tmp);
  filelock.renameAtomic(tmp, target);
  cache = { mtime: fs.statSync(target).mtimeMs, data };
  return data;
}

/** 生成 32 位十六进制设备标识（与开源实现的 openssl rand -hex 16 一致） */
function genId() {
  return crypto.randomBytes(16).toString('hex');
}

/** 列表（脱敏：不外传 refreshToken 全量） */
function list() {
  return load().accounts.map((a) => ({
    id: a.id,
    uid: a.uid || '',
    nickname: a.nickname || '',
    email: a.email || '',
    // 手机号：只给脱敏形式。完整值只留在账号文件里（PII）
    phone: maskPhone(a.phone),
    // 来源必须一起给——TRAE 这个号是从昵称推断的，不是接口下发的真手机号。
    // 界面要据此标注，否则用户会以为和千问一样是官方数据。
    phoneSource: a.phone ? (a.phoneSource || 'inferred-nickname') : '',
    enabled: a.enabled !== false,
    // createdAt 供仪表盘的「账号存活天数」用（见 admin/routes/traework.js
    // 的 /dashboard）。不外传这个字段的话那边只能恒给 null。
    createdAt: a.createdAt || null,
    expiresAt: a.expiresAt || null,
    refreshExpiresAt: a.refreshExpiresAt || null,
    credits: a.credits == null ? null : a.credits,
    lastCheckin: a.lastCheckin || null,
    // 读取时翻译：存量记录里的 `aborted` 之类也要看得懂（详见 errtext.js）
    lastError: explainError(a.lastError),
    // lastError 的写入时刻（与 qwenwork/auth.js 同构）。界面据此显示「N 分钟前」，
    // 没有它一条早已自愈的瞬时错误会被读成「当前故障」。无 lastError 时为 null。
    lastErrorAt: a.lastErrorAt || null,
    deviceId: a.deviceId || '',
    // 只给尾部，便于人工核对是哪个账号
    refreshTail: a.refreshToken ? String(a.refreshToken).slice(-6) : '',
  }));
}

function get(id) {
  return load().accounts.find((a) => a.id === Number(id) || a.id === id) || null;
}

function findUsable() {
  return load().accounts.filter((a) => a.enabled !== false && a.accessToken && a.refreshToken);
}

/** 新增或按 uid 覆盖 */
function upsert(acc) {
  // 跨进程互斥（filelock.js）：refreshToken 是轮换的，管理端换票写新值、
  // 网关请求失败 patch(lastError)，两进程无锁 RMW 时后写者会盖掉新 token。
  // 锁内先失效缓存再重读。
  return filelock.withLock(filePath(), () => {
    cache = { mtime: -1, data: null };
    const data = load();
    const i = data.accounts.findIndex((a) => (acc.uid && a.uid === acc.uid) || (acc.id && a.id === acc.id));
    if (i >= 0) {
      data.accounts[i] = { ...data.accounts[i], ...acc };
      save(data);
      return data.accounts[i];
    }
    const id = data.accounts.reduce((m, a) => Math.max(m, Number(a.id) || 0), 0) + 1;
    const rec = { id, enabled: true, createdAt: Date.now(), ...acc };
    data.accounts.push(rec);
    save(data);
    return rec;
  });
}

function remove(id) {
  return filelock.withLock(filePath(), () => {
    cache = { mtime: -1, data: null };
    const data = load();
    const before = data.accounts.length;
    data.accounts = data.accounts.filter((a) => a.id !== Number(id));
    if (data.accounts.length === before) return false;
    save(data);
    return true;
  });
}

function patch(id, fields) {
  return filelock.withLock(filePath(), () => {
    cache = { mtime: -1, data: null };
    const data = load();
    const a = data.accounts.find((x) => x.id === Number(id));
    if (!a) return null;
    // lastError 与 lastErrorAt 必须同步移动（与 qwenwork/auth.js 同构）：所有写
    // lastError 的调用方都走这里，集中打时间戳比在每个调用点各写一次可靠——
    // 漏一处就会出现「有时间戳的错误」和「没时间戳的错误」两种形状，界面无法统一判断新鲜度。
    if (fields && fields.lastError !== undefined) {
      fields.lastErrorAt = fields.lastError ? Date.now() : null;
    }
    Object.assign(a, fields);
    save(data);
    return a;
  });
}

/**
 * 刷新错峰窗口：把「提前量」按账号稳定地摊开（默认 30 分钟），避免一批
 * 同时到期的账号在同一秒集体打 token 端点。
 *
 * 为什么必须是**确定性**偏移而不是随机：随机偏移每次启动都变，等于每次
 * 重启都换一批刷新时刻，上游看到的是「这个号的刷新时刻一直在跳」；确定性
 * 偏移跨重启不变，上游看到的是「这个号一直是这个点刷」——后者才像人。
 * 依据与实现见 src/jitter.js 的 staggerMs。
 *
 * 设 0 关闭（行为回退到"统一提前量"）。
 */
const REFRESH_STAGGER_MS = Number(process.env.DUMATE_TRAEWORK_REFRESH_STAGGER_MS ?? 30 * 60 * 1000);

/**
 * token 是否在 skewMs（含本账号的确定性错峰偏移）内过期。
 *
 * 错峰加在**提前量**上而不是"延迟刷新"：让不同账号在不同时刻进入刷新窗口，
 * 而不是让它们一起到点、再排队错开——后者在窗口内仍是同一秒的请求尖峰。
 */
function needsRefresh(a, skewMs = 24 * 3600 * 1000) {
  if (!a || !a.expiresAt) return true;
  const margin = skewMs + jitter.staggerMs(`traework:${a.id}`, REFRESH_STAGGER_MS);
  return Date.now() + margin >= a.expiresAt;
}

// 刷新单飞表：同一账号并发的 ExchangeToken 只打一次上游。
//
// 为什么必须有：TRAE 的 refreshToken 是**轮换**的（文件头已写明）。两个并发
// 请求各拿各的新串，后落盘的覆盖先落盘的，被覆盖的那一串从此失效——账号直接
// 报废，且界面上看不出原因（只会表现为"偶尔 401"）。单飞让并发调用共享同
// 一个结果与同一份落盘，轮换链才不会断。
const refreshFlights = new Map();

/**
 * 用 refreshToken 换新 token（refreshToken 会轮换）。
 * 成功后**由调用方**落盘（保持「读-改-写」在一次调用里，避免并发覆盖）。
 */
async function exchangeOnce(a) {
  if (!a || !a.refreshToken) return { ok: false, error: '缺少 refreshToken' };
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(a); } catch (e) {
    return { ok: false, error: `出站代理配置错误: ${e.message}` };
  }
  const host = a.apiHost || c.OAUTH_HOST;
  const body = {
    ClientID: c.CLIENT_ID,
    RefreshToken: a.refreshToken,
    ClientSecret: '-',
    UserID: '',
  };
  const r = await c.request(host, c.EP_EXCHANGE, {
    method: 'POST', body, headers: oauthHeaders(), agent,
  });
  if (r.status !== 200 || !r.data) {
    return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}` };
  }
  const res = (r.data && r.data.Result) || r.data || {};
  const token = res.Token || res.token;
  if (!token) return { ok: false, error: '响应里没有 Token' };
  const out = { accessToken: token };
  if (res.RefreshToken) out.refreshToken = res.RefreshToken;
  // 到期时间：优先用 JWT 的 exp，其次用接口给的毫秒时间戳
  const exp = jwtExp(token);
  if (exp) out.expiresAt = exp;
  else if (res.ExpiresAt) out.expiresAt = Number(res.ExpiresAt);
  if (res.RefreshExpireAt) out.refreshExpiresAt = Number(res.RefreshExpireAt);
  return { ok: true, patch: out };
}

/**
 * 换票（带**单飞**）。同账号并发调用只打一次上游，共享同一个结果。
 *
 * 无 id 的临时记录（登录流程里还没落盘的）不走单飞——它没有稳定主键，
 * 且只会出现一次。
 */
async function exchange(a) {
  const id = a && a.id != null ? String(a.id) : '';
  if (!id) return exchangeOnce(a);
  const inflight = refreshFlights.get(id);
  if (inflight) return inflight;
  // finally 里清理：失败也要清，否则这个 id 的后续刷新会被永久卡在旧 Promise 上
  const p = exchangeOnce(a).finally(() => { refreshFlights.delete(id); });
  refreshFlights.set(id, p);
  return p;
}

/**
 * 手机号脱敏：157****1251。
 *
 * 号码是 PII，列表接口一律只给脱敏形式——认号用「前缀 + 后 4 位」足够了，
 * 没必要把完整号码裸在页面上（管理端页面可能被投屏/截图）。
 * 完整值只留在 data/ 的账号文件里，与 token 同级对待。
 */
function maskPhone(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  const plus = s.startsWith('+') ? '+' : '';
  const digits = s.replace(/^\+/, '');
  // 先剥国家码再脱敏。国内号是 86 + 11 位，不剥的话切出来会是「861****」
  // 而不是「157****」——认号时要的是本机号的前 3 位。
  let body = digits;
  let cc = '';
  if (digits.length === 13 && digits.startsWith('86')) {
    cc = '86';
    body = digits.slice(2);
  }
  if (body.length >= 7) {
    return `${plus}${cc}${body.slice(0, 3)}****${body.slice(-4)}`;
  }
  return `${plus}${cc}${body.slice(0, 1)}****`;
}

/**
 * 尝试从昵称里抽手机号。
 *
 * TRAE 的 GetUserInfo 已 401（拿不到官方身份字段），昵称是唯一的身份线索。
 * 曾以为上游默认昵称形如「用户<手机号>」——**实测是错的**：本机这个号是
 * 「用户23062830688」，11 位但以 2 开头，不是手机号格式，也与 uid 无关。
 *
 * 所以这里只在昵称**严格**匹配「用户 + 标准手机号」时才认，其他一律不给。
 * 严格一点是为了不把不是手机号的数字显示成手机号——那比不显示更糟。
 * 实测本机 TRAE 账号就抽不到，界面显示「手机号未知」，这是正确的结果。
 */
function phoneFromNickname(nickname) {
  const m = String(nickname || '').match(/^用户(1[3-9]\d{9})$/);
  return m ? m[1] : '';
}

/** 从 JWT 里取 exp（秒 → 毫秒） */
function jwtExp(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const j = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return j && j.exp ? j.exp * 1000 : null;
  } catch (e) { return null; }
}

/** 从 JWT 里取 user id（sub / data.id 都认） */
function jwtUid(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return '';
    const j = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return String((j && j.data && j.data.id) || (j && j.sub) || '');
  } catch (e) { return ''; }
}

/**
 * 补齐账号的设备标识。
 *
 * **签到能不能成功取决于这个**：新的 TRAE JWT 会校验设备指纹，随机编一个
 * 会被恒定拒（表现为 9074）。所以三个值都从 uid 确定性派生——同一账号
 * 每次算出来一样，且与参考实现（TraeWorkAssistant）完全一致。
 *
 * 旧账号（deviceId 是 32 位随机 hex 的）会被就地纠正：那种格式服务端不认。
 * 判定标准是「15 位纯数字」，不合规就重派生。
 */
function ensureDevice(a) {
  if (!a) return null;
  const uid = a.uid || jwtUid(a.accessToken) || '';
  if (!uid) return a;
  const ok = a.deviceId && /^\d{15}$/.test(a.deviceId) && a.sessionId && a.marketUserId;
  if (ok) return a;
  const d = require('./device').deriveDevice(uid, a.deviceGeneration);
  return patch(a.id, {
    deviceId: d.deviceId,
    sessionId: d.sessionId,
    marketUserId: d.marketUserId,
    deviceDerivedFrom: uid,
  }) || { ...a, ...d };
}

/**
 * 9074 自愈：换到下一代的派生设备（gen+1 重派生三件套并落盘）。
 *
 * 9074「当前参与用户太多」实测是**设备级**校验：同一 token 换一个新派生的
 * id 就能签到成功（Trae2api-cn 的 rotate_checkin_device_id 同结论，它的
 * device_generation 字段同方案）。只对「确实是派生出来的」设备轮换——
 * deviceDerivedFrom 缺失说明 id 是手工填的，轮换它不是我们的决定。
 * 返回 null 表示不可轮换（调用方按「没轮换过」继续走退避）。
 */
function rotateDevice(a) {
  if (!a) return null;
  const uid = a.deviceDerivedFrom || a.uid || jwtUid(a.accessToken) || '';
  if (!uid || !a.deviceDerivedFrom) return null;
  const g = (Number(a.deviceGeneration) || 0) + 1;
  const d = require('./device').deriveDevice(uid, g);
  return patch(a.id, {
    deviceGeneration: g,
    deviceId: d.deviceId,
    sessionId: d.sessionId,
    marketUserId: d.marketUserId,
  }) || { ...a, ...d, deviceGeneration: g };
}

/** 取用户信息（登录后用一次，补 uid / 昵称）。
 *  出站代理（E 包收口补点）：与对话同出口。配置非法返回 null（调用方按
 *  「读不到」处理），不回退直连。 */
async function fetchUserInfo(a) {
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(a); } catch (e) { return null; }
  const r = await c.request(a.apiHost || c.OAUTH_HOST, c.EP_USER_INFO, {
    method: 'POST', body: {}, headers: { ...oauthHeaders(), Authorization: `Cloud-IDE-JWT ${a.accessToken}` }, agent,
  });
  if (r.status !== 200 || !r.data) return null;
  const res = (r.data && r.data.Result) || r.data || {};
  return {
    uid: String(res.UserID || res.userId || res.UID || ''),
    nickname: res.Nickname || res.nickname || res.UserName || '',
    email: res.Email || res.email || '',
  };
}

/**
 * 把**上游当前的昵称**同步回本地账号记录。
 *
 * 为什么需要单独一个方法：昵称只在登录回调那一瞬间抓一次，之后再不更新
 * （`upsert` 只在重登时写）。所以用户在 TRAE 平台改名后，本地永远是旧名，
 * 页面、埋点、积分流水全都跟着显示旧名——2026-10-29 用户报的正是这个。
 *
 * 前置条件：`GetUserInfo` 要求**有效登录态**，access token 过期时返回
 * `20310 The user is not logged in`（实测），所以这里先续期再查——
 * 与 `checkin.withFreshToken` 同一处理。
 *
 * @returns {{ok:boolean, nickname:string, changed:boolean, error:string}}
 *   取不到就如实报 ok:false，**不返回空串覆盖已有昵称**。
 */
async function syncNickname(a) {
  let cur = a;
  try {
    if (needsRefresh(cur)) {
      const r = await exchange(cur);
      if (r.ok && r.patch) cur = patch(cur.id, { ...r.patch, lastError: '' }) || { ...cur, ...r.patch };
    }
  } catch (e) { /* 续期失败就用现有 token 试，失败会体现在下面的结果里 */ }

  let info = null;
  try { info = await fetchUserInfo(cur); } catch (e) { /* 下面统一处理 */ }
  if (!info || !info.nickname) {
    return { ok: false, nickname: cur.nickname || '', changed: false, error: '上游未返回昵称（登录态可能已失效）' };
  }
  const before = cur.nickname || '';
  if (info.nickname === before) {
    return { ok: true, nickname: before, changed: false, error: '' };
  }
  patch(cur.id, { nickname: info.nickname });
  return { ok: true, nickname: info.nickname, changed: true, error: '' };
}

module.exports = {
  FILE, filePath, dataDir, load, save, list, get, findUsable, upsert, remove, patch,
  needsRefresh, exchange, jwtExp, jwtUid, fetchUserInfo, ensureDevice, rotateDevice,
  maskPhone, phoneFromNickname, genId, syncNickname,
};
