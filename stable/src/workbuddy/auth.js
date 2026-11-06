// src/workbuddy/auth.js - WorkBuddy 账号池存储与 token 续期
//
// 与 src/traework/auth.js / src/qoder/auth.js 同构（自持凭证、多账号、按
// mtime 失效重读、原子写 + 文件锁），差异在**字段与来源**：
//   - 凭证字段是 accessToken / refreshToken（驼峰，与官方客户端一致）
//   - 账号必须带 region（cn / global）与 domain——两区端点不同，
//     且上游按 domain 头识别归属（X-Domain）
//   - **登录流程后置**（用户要求）：账号来源是「从官方客户端认证文件导入」
//     （workbuddy-desktop[-ai].info，四段 JSON）或手动粘贴 token
const fs = require('fs');
const path = require('path');
const c = require('./constants');
const { explainError } = require('../errtext');
const filelock = require('../filelock');
const fileperm = require('../fileperm');

const FILE = 'workbuddy-accounts.json';

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
}

function filePath() {
  return path.join(dataDir(), FILE);
}

/** 读全部账号。按 mtime 失效重读（与 traework/auth.js 同一策略） */
let cache = { mtime: -1, data: null };
function load() {
  let mtime = 0;
  try { mtime = fs.statSync(filePath()).mtimeMs; } catch (e) { /* 文件不存在 */ }
  if (cache.data && cache.mtime === mtime) return cache.data;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(filePath(), 'utf8')); } catch (e) { /* 坏文件当空 */ }
  const data = { accounts: Array.isArray(raw && raw.accounts) ? raw.accounts : [] };
  cache = { mtime, data };
  return data;
}

/** 原子写：先 .tmp 再 rename */
function save(data) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const target = filePath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fileperm.harden(tmp);
  filelock.renameAtomic(tmp, target);
  cache = { mtime: fs.statSync(target).mtimeMs, data };
  return data;
}

/** 列表（脱敏：token 全量不外传，只给尾部 6 位供人工核对） */
function list() {
  // 代理脱敏（proxy-agent 的 describeProxy）：原始 URL 含 user:pass，**任何
  // 对外形状都必须过 redact**——list() 是管理端 API 的出口，这里漏了原始
  // URL 就等于把代理凭证发给浏览器。
  const proxyAgent = require('../proxy-agent');
  return load().accounts.map((a) => ({
    id: a.id,
    uid: a.uid || '',
    region: c.normalizeRegion(a.region),
    nickname: a.nickname || '',
    email: a.email || '',
    enterpriseName: a.enterpriseName || '',
    domain: a.domain || '',
    enabled: a.enabled !== false,
    preferred: !!a.preferred,
    createdAt: a.createdAt || null,
    expiresAt: a.expiresAt || null,
    refreshExpiresAt: a.refreshExpiresAt || null,
    source: a.source || '',
    lastError: explainError(a.lastError),
    lastErrorAt: a.lastErrorAt || null,
    hasRefresh: !!a.refreshToken,
    hasAccess: !!a.accessToken,
    refreshTail: a.refreshToken ? String(a.refreshToken).slice(-6) : '',
    // 档位（hub #505，计费摘要的权威口径）：paid/package + 读取时刻；
    // 没有结论（从未刷到 / 上游失败）如实 null，不猜
    tier: a.tier && Number(a.tier.at) > 0
      ? { paid: !!a.tier.paid, package: String(a.tier.package || ''), at: Number(a.tier.at) }
      : null,
    // 出站代理（M2.1）：只给脱敏形态与有无标记。null = 直连（未配代理）
    proxy: proxyAgent.describeProxy(a),
    // 分组（M2.4）：自由命名标签，批量操作（签到/启停/刷新）按组圈定范围。
    // 不做枚举——组名是用户自己的心智模型，后台只存字符串
    group: a.group || '',
  }));
}

function get(id) {
  return load().accounts.find((a) => a.id === Number(id) || a.id === id) || null;
}

/** 可用账号：启用的、凭证完整的 */
function findUsable() {
  return load().accounts.filter((a) => a.enabled !== false && a.accessToken && a.refreshToken);
}

/** 新增或按 uid+region 覆盖（两区的 uid 空间独立，匹配键必须带上区域） */
function upsert(acc) {
  return filelock.withLock(filePath(), () => {
    cache = { mtime: -1, data: null };
    const data = load();
    const wantRegion = c.normalizeRegion(acc.region);
    const i = data.accounts.findIndex((a) => a.region === wantRegion && acc.uid && a.uid === acc.uid);
    if (i >= 0) {
      data.accounts[i] = { ...data.accounts[i], ...acc, region: wantRegion };
      save(data);
      return data.accounts[i];
    }
    const id = data.accounts.reduce((m, a) => Math.max(m, Number(a.id) || 0), 0) + 1;
    const rec = { id, enabled: true, createdAt: Date.now(), region: wantRegion, ...acc };
    data.accounts.push(rec);
    save(data);
    return rec;
  });
}

/** 局部更新。lastError 与 lastErrorAt 同步移动（与千问同一约定） */
function patch(id, fields) {
  return filelock.withLock(filePath(), () => {
    cache = { mtime: -1, data: null };
    const data = load();
    const a = data.accounts.find((x) => x.id === Number(id));
    if (!a) return null;
    if (fields && fields.lastError !== undefined) {
      fields.lastErrorAt = fields.lastError ? Date.now() : null;
    }
    Object.assign(a, fields);
    save(data);
    return a;
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

/** token 是否在 skewMs 内过期。无 expiresAt 视为需要刷新 */
function needsRefresh(a, skewMs = 3600000) {
  if (!a || !a.expiresAt) return true;
  return Date.now() + skewMs >= a.expiresAt;
}

// 刷新单飞表：同一账号并发的 ExchangeToken 只打一次上游（TRAE 同款——
// refreshToken 轮换，并发写会互相覆盖导致账号报废）
const refreshFlights = new Map();

/**
 * 用 refreshToken 换新 token（POST /v2/plugin/auth/token/refresh）。
 * 头：X-Refresh-Token（仅此端点出现）+ X-Auth-Refresh-Source: workbuddy +
 * X-Enterprise-Id（账号有就带）。响应信封 {code:0, data:{accessToken, ...}}。
 */
async function exchangeOnce(a) {
  if (!a || !a.refreshToken) return { ok: false, error: '缺少 refreshToken' };
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(a); } catch (e) {
    return { ok: false, error: `出站代理配置错误: ${e.message}` };
  }
  const reg = c.normalizeRegion(a.region);
  const spec = c.specOf(reg);
  const u = new URL(spec.chatBase + c.EP_REFRESH);
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: spec.billingBase,
    Referer: `${spec.billingBase}/`,
    'User-Agent': c.CLIENT_UA,
    'Content-Type': 'application/json',
    'X-Refresh-Token': String(a.refreshToken),
    // 刷新渠道标识按区域不同（参照 workbuddy2api-hub 实测）：国内 'workbuddy'，
    // 国际 'plugin'。此前两区都用 'workbuddy'——国内实测正常，国际未单独验证。
    'X-Auth-Refresh-Source': reg === 'cn' ? 'workbuddy' : 'plugin',
    'X-CodeBuddy-Request': '1',
    'Accept-Language': reg === 'global' ? 'en-US' : 'zh-CN',
  };
  if (a.enterpriseId) headers['X-Enterprise-Id'] = a.enterpriseId;
  if (a.uid) headers['X-User-Id'] = String(a.uid);
  // X-Domain 兜底与参照实现一致：账号自己的 domain 优先，缺省按区域给
  const domain = a.domain || (reg === 'global' ? 'www.workbuddy.ai' : 'copilot.tencent.com');
  if (domain) headers['X-Domain'] = domain;
  const r = await new Promise((resolve) => {
    const req = require('https').request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers,
      ...(agent ? { agent } : {}), timeout: 30000,
    }, (res) => {
      let buf = '';
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      res.on('data', (x) => { buf += dec.write(x); });
      res.on('end', () => { buf += dec.end(); resolve({ status: res.statusCode, body: buf }); });
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.write(JSON.stringify({}));
    req.end();
  });
  let doc = null;
  try { doc = JSON.parse(r.body); } catch (e) { /* 非 JSON */ }
  const code = doc && Number(doc.code);
  if (r.status < 200 || r.status >= 300 || (Number.isFinite(code) && code !== 0) || !doc) {
    const msg = (doc && (doc.msg || doc.message)) || String(r.body).slice(0, 120);
    return { ok: false, error: `刷新失败 HTTP ${r.status}: ${msg}` };
  }
  const data = (doc && doc.data) || {};
  const accessToken = data.accessToken || data.access_token || '';
  if (!accessToken) return { ok: false, error: '刷新响应里没有 accessToken（需重新登录客户端）' };
  const out = { accessToken, lastError: '' };
  if (data.refreshToken) out.refreshToken = data.refreshToken;
  // 到期时间：优先绝对值 expiresAt（毫秒），其次相对 expiresIn（秒）。
  // 缺字段或越界不动旧值——一个脏值会把 expiresAt 写成过去或几百年后
  const saneSec = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= 10 * 365 * 86400 ? n : null;
  };
  const absMs = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > Date.now() - 86400000 && n < Date.now() + 10 * 365 * 86400000 ? n : null;
  };
  const exp = absMs(data.expiresAt ?? data.expires_at) ?? (() => {
    const s = saneSec(data.expiresIn);
    return s ? Date.now() + s * 1000 : null;
  })();
  if (exp) out.expiresAt = exp;
  const rExp = absMs(data.refreshExpiresAt ?? data.refresh_expires_at) ?? (() => {
    const s = saneSec(data.refreshExpiresIn);
    return s ? Date.now() + s * 1000 : null;
  })();
  if (rExp) out.refreshExpiresAt = rExp;
  if (data.domain) out.domain = data.domain;
  return { ok: true, patch: out };
}

/**
 * 换票（带单飞 + refreshGuard，2026-11-06 M2.3）。
 *
 * 单飞只解决**进程内**并发；真正的杀手是**跨进程轮换竞态**——9083（keepalive
 * 排程）与 9082（请求热路径）是两个进程，官方桌面客户端是第三个写者，三方
 * 都可能对同一账号发起刷新。refreshToken 是**一次性轮换**的：两方拿同一个
 * 旧值打上游，后到者 invalid_grant，而且旧值已被作废——账号就此报废。
 *
 * guard 两步（CreditDaddy 的 refreshGuard 语义，不加锁原语）：
 *   1. 打上游**前**重读存储：存储里已有「与传入不同的 refreshToken 且仍有效」
 *      → 别人已经换好了，直接采纳，不再打上游（多打一次 = 多一次作废风险）。
 *   2. 打上游**失败后**重读：存储的 refreshToken 与本次所用不同且有效
 *      → 竞态败者恢复：别人用同一个旧值抢先成功，采纳对方的新值，
 *      而不是把 invalid_grant 记成 session_dead 判死账号。
 *
 * 同步文件锁罩不住这条路径（withLock 是同步的，网络调用 30s 会被 STALE_MS
 * 抢锁），所以靠「重读 + 判别」而不是互斥。
 */
async function exchange(a) {
  const id = a && a.id != null ? String(a.id) : '';
  // 无 id（导入/登录期的裸对象）同样走接缝：exchangeOnce 会真打上游，
  // 测试必须能替换它——两条路径的调用口径必须一致
  if (!id) return module.exports.exchangeOnce(a);
  const inflight = refreshFlights.get(id);
  if (inflight) return inflight;
  const p = (async () => {
    // --- guard 1：刷新前重读对齐 ---
    const fresh = get(a.id) || a;
    const stored = fresh && fresh.refreshToken ? String(fresh.refreshToken) : '';
    const passed = a && a.refreshToken ? String(a.refreshToken) : '';
    if (stored && passed && stored !== passed
        && fresh.expiresAt && Date.now() + 60000 < fresh.expiresAt) {
      return {
        ok: true,
        adopted: true,
        patch: {
          accessToken: fresh.accessToken,
          refreshToken: stored,
          expiresAt: fresh.expiresAt,
          refreshExpiresAt: fresh.refreshExpiresAt || null,
          lastError: '',
        },
      };
    }
    const used = stored || passed;
    // 经 module.exports（而非局部 exports）调用：文件尾部 module.exports = {...}
    // 重指向后，局部 exports 还是旧对象——测试接缝（假 exchangeOnce）会失效。
    const r = await module.exports.exchangeOnce(fresh);
    if (!r.ok) {
      // --- guard 2：败者恢复 ---
      const now = get(a.id);
      const nowToken = now && now.refreshToken ? String(now.refreshToken) : '';
      if (nowToken && used && nowToken !== used
          && now.accessToken && now.expiresAt && Date.now() + 60000 < now.expiresAt) {
        return {
          ok: true,
          adopted: true,
          patch: {
            accessToken: now.accessToken,
            refreshToken: nowToken,
            expiresAt: now.expiresAt,
            refreshExpiresAt: now.refreshExpiresAt || null,
            lastError: '',
          },
        };
      }
      return r;
    }
    return r;
  })();
  refreshFlights.set(id, p);
  return p.finally(() => { refreshFlights.delete(id); });
}

/** token 余量不足就先换票（签到/额度等辅助路径用；对话走 index.ensureFresh） */
async function ensureFresh(a) {
  if (!needsRefresh(a)) return a;
  const r = await exchange(a);
  if (!r.ok) return a;   // 刷新失败带旧 token 试一次，错误如实上报
  return patch(a.id, r.patch) || { ...a, ...r.patch };
}

/**
 * 从官方客户端认证文件导入账号（登录流程后置期的账号来源）。
 * 文件是四段 JSON：{ account:{uid,nickname}, auth:{accessToken, refreshToken,
 * expiresAt, domain} }。region 校验：auth.domain 必须与目标区域一致
 * （workbuddy.ai → global；其余 → cn）——凭据与区域不符直接拒绝，
 * 不发起任何上游请求。
 */
async function importFromClient(region) {
  const reg = c.normalizeRegion(region);
  const expectedDomain = reg === 'global' ? 'workbuddy.ai' : null;
  const candidates = c.authFileCandidates(reg);
  let raw = null;
  let usedPath = '';
  for (const p of candidates) {
    try {
      const text = fs.readFileSync(p, 'utf8');
      const doc = JSON.parse(text);
      if (doc && (doc.auth || doc.account)) { raw = doc; usedPath = p; break; }
    } catch (e) { /* 下一个候选 */ }
  }
  if (!raw) {
    return { ok: false, error: `没有找到官方客户端认证文件（${c.specOf(reg).label}）。装过 WorkBuddy 客户端并登录后重试，或改用手动粘贴 token` };
  }
  const auth = raw.auth || {};
  const account = raw.account || {};
  const accessToken = auth.accessToken || '';
  const refreshToken = auth.refreshToken || '';
  if (!accessToken || !refreshToken) {
    return { ok: false, error: '认证文件里没有完整的 accessToken/refreshToken（客户端可能未登录）' };
  }
  const domain = auth.domain || raw.domain || '';
  // 区域红线：domain 必须与目标区域一致（workbuddy.ai → global）
  if (expectedDomain && !String(domain).toLowerCase().endsWith(expectedDomain)) {
    return { ok: false, error: `凭据域（${domain || '空'}）与目标区域不符，拒绝导入` };
  }
  if (!expectedDomain && String(domain).toLowerCase().includes('workbuddy.ai')) {
    return { ok: false, error: `凭据域（${domain}）是国际版账号，不能导入国内区域` };
  }
  const rec = {
    uid: String(account.uid || ''),
    region: reg,
    nickname: String(account.nickname || ''),
    accessToken,
    refreshToken,
    expiresAt: Number(auth.expiresAt) || null,
    refreshExpiresAt: Number(auth.refreshExpiresAt) || null,
    domain,
    enterpriseId: account.enterpriseId || auth.enterpriseId || '',
    enterpriseName: account.enterpriseName || '',
    source: 'client-import',
    lastError: '',
  };
  const saved = upsert(rec);
  return { ok: true, account: list().find((a) => a.id === saved.id), path: usedPath };
}

/**
 * 手动粘贴 token 导入（登录流程后置期的另一个账号来源）。
 * 必填 accessToken + refreshToken；uid 缺失时用 token 尾部做稳定占位——
 * uid 是 upsert 的匹配键，没有它每次导入都会新建重复账号。
 */
function importManual(opts) {
  const accessToken = String((opts && opts.accessToken) || '').trim();
  const refreshToken = String((opts && opts.refreshToken) || '').trim();
  if (!accessToken || !refreshToken) return { ok: false, error: '缺少 accessToken / refreshToken' };
  const uid = String((opts && opts.uid) || '').trim() || `manual-${refreshToken.slice(-8)}`;
  const rec = {
    uid,
    region: c.normalizeRegion(opts && opts.region),
    nickname: String((opts && opts.nickname) || ''),
    email: String((opts && opts.email) || ''),
    accessToken,
    refreshToken,
    expiresAt: Number(opts && opts.expiresAt) || null,
    domain: String((opts && opts.domain) || ''),
    enterpriseId: String((opts && opts.enterpriseId) || ''),
    source: 'manual',
    lastError: '',
  };
  const saved = upsert(rec);
  return { ok: true, account: list().find((a) => a.id === saved.id) };
}

module.exports = {
  FILE, dataDir, filePath, load, save, list, get, findUsable, upsert, patch, remove,
  needsRefresh, exchange, ensureFresh, importFromClient, importManual,
  // 测试接缝：exchange() 经 exports.exchangeOnce 调上游，测试可替换成假实现
  // （真实现直接打 refresh 端点，离线测不了）。生产代码路径不受影响。
  exchangeOnce,
};
