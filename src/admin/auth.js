// src/admin/auth.js - 管理员口令、签名会话、登录锁定（对应参考 server/security.py）
const crypto = require('crypto');
const path = require('path');
const { readJSON, writeJSON, appendJSONL } = require('./store');
const offthread = require('../offthread');
// scrypt 的 worker 侧实现（审计 P1-5a）：登录是 public 路由，同步 scrypt
// 每次失败尝试都在事件循环上跑一次 256MB 内存分配 + 秒级 CPU，
// 换用户名可以稀释锁定键（ip|username）反复触发。搬到 worker 后
// 事件循环不被占用，串行 worker 还天然限流。
const SCRYPT_TASK = require.resolve('../scrypt-task');

const USERS_FILE = 'admin-users.json';
const SECRET_FILE = 'admin.secret';

// N 必须是 2 的幂（Node 的 scrypt 校验参数时会直接抛 RangeError），
// 262144 = 2^18 是常用的强度档，等价于参考实现那个量级的迭代成本。
const N_COST = 262144;
const R_BLOCK = 8;
const P_PARALLEL = 1;
const KEYLEN = 32;
const MAX_FAILS = 5;
const LOCK_SECONDS = 600;
const MAX_TRACKED = 5000;
const SESSION_DAYS = 1;
const SESSION_IDLE_HOURS = 12;
const COOKIE_NAME = 'dumate_admin';

const secretPath = () => path.join(require('./store').DATA_DIR, SECRET_FILE);

// 128 * N * r = 256MB，Node 默认 maxmem 只有 32MB，不显式抬高就会抛
// "memory limit exceeded"。校验侧同样要带，否则读别人的 hash 时又撞上。
const MAXMEM = 512 * 1024 * 1024;

function _scrypt(pwd, salt, n) {
  return crypto.scryptSync(pwd, salt, KEYLEN, { N: n, r: R_BLOCK, p: P_PARALLEL, maxmem: MAXMEM });
}

function makeHash(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = _scrypt(pwd, salt, N_COST).toString('hex');
  return `scrypt$${N_COST}$${salt}$${dk}`;
}

/**
 * 口令校验（**异步**，审计 P1-5a）。scrypt 在常驻 worker 里算，事件循环
 * 不被秒级阻塞；worker 起不来时回退同步版——退化成旧行为，登录仍可用。
 * makeHash 保持同步：只在 bootstrap / 管理员重置密码时调用，不是匿名热路径。
 */
async function verifyPwd(pwd, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const n = parseInt(parts[1], 10);
  if (!Number.isInteger(n) || n <= 0) return false;
  const expectedHex = await offthread.run(
    SCRYPT_TASK,
    'scrypt',
    [{ pwd, salt: parts[2], n }],
    (p) => _scrypt(p.pwd, p.salt, p.n).toString('hex'),
  );
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(parts[3], 'hex');
  // 长度不等时 timingSafeEqual 会抛异常，先挡掉
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

// session 签名密钥与用户表分开存：密钥泄露不该连带把口令库也交出去
//
// 进程内缓存一份：密钥生成后不再变化，原实现每次 parseToken 都同步读盘，
// 每个管理端请求多一次文件 IO。跨进程首次生成走文件锁（filelock.js）——
// 两个进程同时首启都走 readJSON→writeJSON 时，后写者会把先写者的密钥
// 覆盖掉，另一边签发的会话全部失效。
let _secretCache = null;
function secret() {
  if (_secretCache) return _secretCache;
  let s = readJSON(SECRET_FILE, null);
  if (!s || typeof s !== 'string') {
    const filelock = require('../filelock');
    filelock.withLock(secretPath(), () => {
      s = readJSON(SECRET_FILE, null); // 锁内重读：另一进程可能刚生成过
      if (!s || typeof s !== 'string') {
        s = crypto.randomBytes(32).toString('hex');
        writeJSON(SECRET_FILE, s);
      }
    });
  }
  _secretCache = s;
  return s;
}

function _sign(payload, key) {
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

function issueToken(username, role) {
  // 必须带上用户当前的 session_version：重设密码/踢会话会把它加一，
  // 写死 0 的话新签发的 token 立刻就被自己的校验判为过期，
  // 表现为「登录接口返回成功，但下一个请求就 401」。
  const data = users() || {};
  const u = data[username];
  const obj = {
    u: username,
    r: role,
    iat: Date.now(),
    orig: Date.now(),
    ver: u ? (u.session_version || 0) : 0,
  };
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${payload}.${_sign(payload, secret())}`;
}

function parseToken(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expect = _sign(payload, secret());
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expect, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function idleExpired(obj) {
  if (!SESSION_IDLE_HOURS) return false;
  return Date.now() - obj.iat > SESSION_IDLE_HOURS * 3600 * 1000;
}

function absoluteExpired(obj) {
  return Date.now() - obj.orig > SESSION_DAYS * 24 * 3600 * 1000;
}

const users = () => readJSON(USERS_FILE, null);

// 首次启动没有用户时生成管理员。初始密码只在 stdout 出现一次——
// 写进文件等于在磁盘上留一份明文口令。
function bootstrapUsers() {
  const existing = users();
  if (existing && Object.keys(existing).length) return { users: existing, created: null };

  const pwd = crypto.randomBytes(9).toString('base64url');
  const data = {
    admin: {
      username: 'admin',
      role: 'admin',
      hash: makeHash(pwd),
      created_at: Date.now(),
      session_version: 0,
    },
  };
  writeJSON(USERS_FILE, data);
  return { users: data, created: pwd };
}

function saveUsers(data) {
  return writeJSON(USERS_FILE, data);
}

// 初始密码只在首次启动打印一次，日志被清掉或 data/ 被搬走后就再也拿不回来，
// 而 bootstrap 看到已有用户不会再生成——管理员会被永久锁在自己门外。
// 这个开关是唯一的本地补救路径，只在显式传入时执行。
// 允许指定密码：随机串要靠手抄，11 位里错一个字符就白跑一轮。
function resetAdminPassword(plain) {
  const pwd = plain || crypto.randomBytes(9).toString('base64url');
  const data = users() || {};
  data.admin = {
    username: 'admin',
    role: 'admin',
    hash: makeHash(pwd),
    created_at: (data.admin && data.admin.created_at) || Date.now(),
    session_version: (data.admin && data.admin.session_version || 0) + 1,
  };
  saveUsers(data);
  return pwd;
}

function revokeSessions(username) {
  const data = users() || {};
  const u = data[username];
  if (!u) return 0;
  u.session_version = (u.session_version || 0) + 1;
  saveUsers(data);
  return u.session_version;
}

// ---- 登录失败锁定 ----
// 存内存而不是磁盘：进程重启后计数器归零是可接受的（攻击者拿不到更多尝试机会），
// 而落盘会在断电后留下陈旧锁定把管理员自己锁在外面。
const fails = {};

// ---- 登录前置限流（按 IP 滑动窗口，审计 P1-5）----
// scrypt 搬进 worker 后事件循环不再被卡，但每次校验仍要吃 256MB 内存；
// 且失败锁定键是 ip|username——换用户名即可稀释（MAX_TRACKED=5000 个键）。
// 所以在进入锁定计数**之前**按 IP 卡一道：RATE_WINDOW_MS 内超过 RATE_MAX 次
// 登录尝试直接 429，不给 scrypt 跑的机会。DUMATE_ADMIN_LOGIN_RATE 可调。
const RATE_WINDOW_MS = 60000;
const RATE_MAX = Math.max(1, parseInt(process.env.DUMATE_ADMIN_LOGIN_RATE || '20', 10));
const ipHits = new Map();

function _pruneHits(now) {
  for (const [ip, arr] of ipHits) {
    const keep = arr.filter((t) => now - t < RATE_WINDOW_MS);
    if (keep.length) ipHits.set(ip, keep);
    else ipHits.delete(ip);
  }
}

function loginThrottled(ip) {
  const key = String(ip || '');
  const now = Date.now();
  // 只清自己的窗口：攻击者每 IP 至多压 RATE_MAX 条记录，Map 增长可控；
  // 超过阈值时整体清一次过期项兜底
  if (ipHits.size > 5000) {
    _pruneHits(now);
    if (ipHits.size > 10000) ipHits.clear(); // 真洪峰：宁可限流失效也不无限吃内存
  }
  const arr = (ipHits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length) ipHits.set(key, arr);
  else ipHits.delete(key);
  return arr.length >= RATE_MAX;
}

function recordLoginAttempt(ip) {
  const key = String(ip || '');
  const arr = ipHits.get(key) || [];
  arr.push(Date.now());
  ipHits.set(key, arr);
}

function _prune() {
  const keys = Object.keys(fails);
  if (keys.length <= MAX_TRACKED) return;
  keys.sort((a, b) => fails[a].at - fails[b].at);
  for (const k of keys.slice(0, keys.length - MAX_TRACKED)) delete fails[k];
}

function loginBlocked(ip, username) {
  const rec = fails[`${ip}|${username || ''}`];
  if (!rec || rec.n < MAX_FAILS) return false;
  if (Date.now() - rec.at > LOCK_SECONDS * 1000) {
    delete fails[`${ip}|${username || ''}`];
    return false;
  }
  return true;
}

function lockRemaining(ip, username) {
  const rec = fails[`${ip}|${username || ''}`];
  if (!rec || rec.n < MAX_FAILS) return 0;
  return Math.max(0, Math.ceil((LOCK_SECONDS * 1000 - (Date.now() - rec.at)) / 1000));
}

function recordFail(ip, username) {
  const key = `${ip}|${username || ''}`;
  const rec = fails[key];
  if (rec && Date.now() - rec.at > LOCK_SECONDS * 1000) {
    fails[key] = { n: 1, at: Date.now() };
  } else {
    fails[key] = { n: (rec ? rec.n : 0) + 1, at: rec && rec.n >= MAX_FAILS ? rec.at : Date.now() };
  }
  _prune();
}

function clearFail(ip, username) {
  delete fails[`${ip}|${username || ''}`];
}

function audit(actor, action, target = '', detail = '') {
  appendJSONL('admin-audit.jsonl', {
    ts: Date.now(),
    actor: actor || 'anonymous',
    action,
    target,
    detail,
  });
}

// 审计读取（GET /auth/audit 用）：倒序返回，坏行静默跳过（appendJSONL 的
// 轮转/截断可能产生半行，一条坏行不该让整份审计打不开）。
function readAudit() {
  const { readJSONL } = require('./store');
  return readJSONL('admin-audit.jsonl').reverse().filter((r) => r && r.ts);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// 返回当前登录用户；未登录返回 null。session_version 用于「改密码后踢掉旧会话」。
function currentUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  const obj = parseToken(token);
  if (!obj) return null;
  if (idleExpired(obj) || absoluteExpired(obj)) return null;
  const data = users() || {};
  const u = data[obj.u];
  if (!u) return null;
  if ((u.session_version || 0) !== (obj.ver || 0)) return null;
  return { username: u.username, role: u.role };
}

module.exports = {
  COOKIE_NAME,
  MAX_FAILS,
  LOCK_SECONDS,
  N_COST,
  RATE_WINDOW_MS,
  secretPath,
  makeHash,
  verifyPwd,
  issueToken,
  parseToken,
  bootstrapUsers,
  resetAdminPassword,
  users,
  saveUsers,
  revokeSessions,
  loginThrottled,
  recordLoginAttempt,
  loginBlocked,
  lockRemaining,
  recordFail,
  clearFail,
  audit,
  readAudit,
  parseCookies,
  currentUser,
};
