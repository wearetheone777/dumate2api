// src/qoder/auth.js - Qoder 账号池存储与 token 续期
//
// 与 src/qwenwork/auth.js 同构（同样自持凭证、多账号、按 mtime 失效重读、
// 原子写），差异在**字段**：Qoder 的凭证是 device_token(dt-xxx) + refresh_token(drt-xxx)，
// 且有区域（cn / global）——两区账号不通用，各存各的。
//
// 为什么凭证要自己存而不是读客户端：与千问同理——客户端同一时刻只有一份
// 登录态，两个账号无法并存；而且 Qoder 的 device flow 可以完全脱离客户端跑
// （见 login.js），所以直接自持更干净。**这条通道不需要装 Qoder 客户端。**
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const c = require('./constants');
const { explainError } = require('../errtext');
const filelock = require('../filelock');
const fileperm = require('../fileperm');

const FILE = 'qoder-accounts.json';

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
  // 权限收紧（fileperm.js）：token 只留在当前用户可读的文件里
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fileperm.harden(tmp);
  filelock.renameAtomic(tmp, target);
  cache = { mtime: fs.statSync(target).mtimeMs, data };
  return data;
}

/**
 * 手机号脱敏：157****1251。
 *
 * 与千问/TRAE **同一份实现**（口径必须一致：三条通道的账号卡会并排看，
 * 「861****」和「157****」混着出现会让人以为是两个不同的号）。
 *
 * 号码是 PII，列表接口一律只给脱敏形式——认号用「前缀 + 后 4 位」足够了。
 * Qoder 更进一步：**连账号文件里也只存脱敏值**（见 login.js 的 finish），
 * 因为没有任何场景需要完整号码，存明文等于白担一份泄露风险。
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

/** 列表（脱敏：device/refresh token 全量不外传，只给尾 6 位供人工核对） */
function list() {
  return load().accounts.map((a) => ({
    id: a.id,
    uid: a.uid || '',
    nickname: a.nickname || '',
    username: a.username || '',
    email: a.email || '',
    // phone 落盘时就已是脱敏值（login.js 的 finish 存的），**不再脱敏一次**——
    // 对已脱敏的串再切一刀目前碰巧结果相同，但那只是巧合，脱敏规则一改
    // 就会切出「150********」这种废品。
    phoneMasked: a.phone || '',
    hasPhone: !!a.phone,
    region: c.normalizeRegion(a.region),
    userType: a.userType || '',
    planName: a.planName || '',
    enabled: a.enabled !== false,
    preferred: !!a.preferred,
    expiresAt: a.expiresAt || null,
    refreshExpiresAt: a.refreshExpiresAt || null,
    // P1-1：后台提前续期的状态（由 balance-refresh 探针写；失败不写 lastError）
    tokenRefresh: a.tokenRefresh || null,
    machineId: a.machineId || '',
    // 读取时翻译：`aborted` 这类原生错误名对「账号怎么了」没有信息量。
    // 存量记录（本功能上线前写的）靠这一层也能看懂——lastError 只在成功时
    // 才清，一个不再使用的账号会永久留着旧串。
    lastError: explainError(a.lastError),
    lastErrorAt: a.lastErrorAt || null,
    createdAt: a.createdAt || null,
    daysAlive: a.createdAt ? Math.floor((Date.now() - a.createdAt) / 86400000) : null,
    // P2-1：凭证族（device/job/pat）供凭证健康卡只读展示，不带 token
    tokenFamily: (() => { try { return require('./session').tokenFamilyOf(a); } catch (e) { return 'unknown'; } })(),
    // 「凭证是否完整」以布尔形式带出——token 本身不外传，调用方需要知道有没有
    hasRefresh: !!a.refreshToken,
    hasAccess: !!a.accessToken,
    refreshTail: a.refreshToken ? String(a.refreshToken).slice(-6) : '',
  }));
}

function get(id) {
  return load().accounts.find((a) => a.id === Number(id) || a.id === id) || null;
}

/** 可用账号：启用的、凭证完整的 */
function findUsable() {
  return load().accounts.filter((a) => a.enabled !== false && a.accessToken && a.refreshToken);
}

/**
 * 主账号：preferred 优先 → 环境变量指定 → 第一个可用。
 * 与千问同一顺序（preferred 稳定、环境变量是临时覆盖、第一个只作兜底）。
 */
function preferred() {
  const usable = findUsable();
  if (!usable.length) return null;
  const envId = String(process.env.DUMATE_QODER_ACCOUNT || '').trim();
  if (envId) {
    const byEnv = usable.find((a) => String(a.id) === envId);
    if (byEnv) return byEnv;
  }
  const marked = usable.find((a) => a.preferred);
  if (marked) return marked;
  return usable[0];
}

/** 新增或按 uid / id 覆盖 */
function upsert(acc) {
  // 跨进程互斥（filelock.js）：refresh token 是轮换的，管理端登录/换票写新值、
  // 网关请求失败 patch(lastError)，两进程无锁 RMW 时后写者会盖掉新 token。
  // 锁内先失效缓存再重读。
  return filelock.withLock(filePath(), () => {
    cache = { mtime: -1, data: null };
    const data = load();
    const i = data.accounts.findIndex((a) => (acc.uid && a.uid === acc.uid) || (acc.id && a.id === acc.id));
    if (acc && acc.preferred === true) {
      for (const x of data.accounts) x.preferred = false;
    }
    // 重新登录（带新 refreshToken）必须清掉「凭证已退场」标记，否则
    // needsRefresh 一直返回 false，新凭证被判成不用刷新——表现为
    // 「重新登录了还是用不了」，且没有任何报错（TRAE/WorkBuddy 同款坑）。
    const fresh = acc.refreshToken ? { ...acc, refreshRetiredAt: null } : acc;
    if (i >= 0) {
      data.accounts[i] = { ...data.accounts[i], ...fresh };
      save(data);
      return data.accounts[i];
    }
    const id = data.accounts.reduce((m, a) => Math.max(m, Number(a.id) || 0), 0) + 1;
    const rec = { id, enabled: true, createdAt: Date.now(), ...fresh };
    if (rec.preferred === undefined) rec.preferred = data.accounts.length === 0;
    data.accounts.push(rec);
    save(data);
    return rec;
  });
}

/**
 * 给缺手机号的存量账号补一次脱敏号码。
 *
 * 为什么需要：手机号字段是本功能上线后才存的，**改动前登录的账号没有这一项**，
 * 不补的话它们的 phoneMasked 永远是空——而这正是现在库里仅有的两个账号。
 *
 * 三层保护，与搭子网页账号的 backfillNickname 同一套：
 *   - 幂等：已经有 phone 的直接跳过（不打上游）
 *   - 只补一次：失败的账号本次不再重试（进程内标记），避免每次进页面都白等
 *   - 失败静默：读路径不该因为取不到手机号而报错，账号其余信息照常显示
 *
 * @returns {Promise<number>} 本次补到的账号数
 */
const phoneTried = new Set();
async function backfillPhone(session) {
  if (!session || !session.fetchUserInfo) return 0;
  let n = 0;
  for (const a of load().accounts) {
    if (a.phone || phoneTried.has(a.id)) continue;
    if (!a.accessToken) continue;
    phoneTried.add(a.id);
    try {
      const info = await session.fetchUserInfo(a.accessToken, a.region, {
        // 出站代理（E 包收口补点）：与对话同出口；配置非法走下面的 catch 跳过
        agent: require('../proxy-agent').getAgentFor(a),
      });
      const masked = maskPhone(info && info.security_mobile);
      if (masked) { patch(a.id, { phone: masked }); n++; }
    } catch (e) { /* 读路径失败不影响账号展示 */ }
  }
  return n;
}

/** 局部更新。lastError 与 lastErrorAt 同步移动（与千问同一约定） */
function patch(id, fields) {
  return filelock.withLock(filePath(), () => {
    cache = { mtime: -1, data: null };
    const data = load();
    const a = data.accounts.find((x) => x.id === Number(id));
    if (!a) return null;
    if (fields && fields.preferred === true) {
      for (const x of data.accounts) if (x.id !== a.id) x.preferred = false;
    }
    // lastError 打时间戳：界面据此显示「N 分钟前」，避免把几小时前的瞬时
    // 错误读成「当前故障」。所有写 lastError 的调用方都走这里，集中一处。
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
    // 删掉的是主账号时顺延给剩下的第一个，否则选号会静默退化成「取第一个」
    if (!data.accounts.some((a) => a.preferred) && data.accounts.length) {
      data.accounts[0].preferred = true;
    }
    save(data);
    return true;
  });
}

/** token 是否在 skewMs 内过期。无 expiresAt 视为需要刷新 */
function needsRefresh(a, skewMs = 300000) {
  if (!a || !a.expiresAt) return true;
  // 凭证退场标记（2026-11-28，与 TRAE/WorkBuddy 同源）：换票被上游
  // 明确判死过（`exchange` 返回 `expired: true`），再问也是同一个答案。
  // 返回 false 表示「不刷新」，账号仍可能因 access 未过期而可用。
  if (a.refreshRetiredAt) return false;
  return Date.now() + skewMs >= a.expiresAt;
}

module.exports = {
  FILE, dataDir, filePath, load, save, list, get, findUsable, preferred,
  upsert, patch, remove, needsRefresh, maskPhone, backfillPhone,
};
