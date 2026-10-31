// src/keys.js - API Key 存储与校验（网关与管理端共用）
//
// 两个进程都要用它：网关在每个请求上校验，管理端增删查改。所以它和
// modelmap.js 一样按 mtime 失效重读，改完 key 不需要重启网关。
//
// 只存 token 的 sha256，不存明文——data/ 目录一旦被复制走，明文 key 等于
// 直接可用，而哈希只能被验证、不能被还原。明文仅在创建那一次返回给用户。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const filelock = require('./filelock');
const fileperm = require('./fileperm');

const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
const FILE = 'keys.json';
const PREFIX = 'dmk_';

let cache = { mtime: -1, data: null };

function filePath() {
  return path.join(DATA_DIR, FILE);
}

function mtimeOf() {
  try { return fs.statSync(filePath()).mtimeMs; } catch (e) { return 0; }
}

function load() {
  const mtime = mtimeOf();
  if (cache.data && cache.mtime === mtime) return cache.data;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filePath(), 'utf8')); }
  catch (e) { raw = null; }
  const data = { keys: Array.isArray(raw && raw.keys) ? raw.keys : [] };
  cache = { mtime, data };
  return data;
}

function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const target = filePath();
  const tmp = `${target}.tmp`;
  // 权限收紧（fileperm.js）：key 哈希与名单不属于公开数据，POSIX 创建即
  // 0600，Windows 收紧目录 ACL（每进程一次）
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fileperm.harden(tmp);
  filelock.renameAtomic(tmp, target);
  cache = { mtime: mtimeOf(), data };
  return data;
}

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function generateToken() {
  // 32 字节随机，base64url 后约 43 字符。熵足够，且不含需要转义的字符
  return PREFIX + crypto.randomBytes(32).toString('base64url');
}

// ---- CIDR 匹配 ----
// 只实现 IPv4；IPv6 字面量按整串精确比对。返回 false 表示不匹配，
// 非法条目同样返回 false —— 这是 fail-closed：写错一个 CIDR 会让这把 key
// 对**所有**来源都拒绝，而不是意外放行所有人。
function ipToInt(ip) {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = parseInt(p, 10);
    if (v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0;
}

function ipMatches(ip, entry) {
  const e = String(entry || '').trim();
  if (!e) return false;
  if (e === '*') return true;

  if (e.includes('/')) {
    const [net, bitsRaw] = e.split('/');
    const bits = parseInt(bitsRaw, 10);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const a = ipToInt(ip);
    const b = ipToInt(net);
    if (a === null || b === null) return false;
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (a & mask) === (b & mask);
  }

  return String(ip).trim() === e;
}

function validateCIDR(entry) {
  const e = String(entry || '').trim();
  if (!e || e === '*') return { ok: true };
  if (e.includes('/')) {
    const [net, bitsRaw] = e.split('/');
    const bits = parseInt(bitsRaw, 10);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
      return { ok: false, reason: `${e}：掩码必须是 0-32 的整数` };
    }
    if (ipToInt(net) === null) {
      return { ok: false, reason: `${e}：网络地址不是合法的 IPv4` };
    }
    return { ok: true };
  }
  if (e.includes(':')) return { ok: true };   // IPv6 字面量，整串比对
  if (ipToInt(e) === null) {
    return { ok: false, reason: `${e}：请写成单个 IP（1.2.3.4）或 CIDR（10.0.0.0/8）` };
  }
  return { ok: true };
}

function normalizeList(items) {
  if (!Array.isArray(items)) return [];
  return items.map((s) => String(s).trim()).filter(Boolean);
}

// 通道绑定。'' / null = 不限通道（兼容已有 key：网关按模型名前缀分流，
// 不按 key 分流）。设成具体通道后，这把 key 只能调该通道的模型。
// 四条通道：dumate（本地转发）、qwenwork（直连）、traework（直连，凭证自持）、
// qoder（直连，纯本地签名）
const { CHANNELS, normalize } = require('./channels');
function normalizeChannel(v) {
  return normalize(v);
}

// 区域维度（2026-11-01）：'' = 不限 / 'cn' = 仅国内账号 / 'intl' = 仅国际账号。
// 只对有国际版的通道有意义——qoder（global 端点已接）、traework（国际链路
// 未接入，intl key 会拿到明确的「未接入」报错）；dumate 与 qwenwork 是纯国内
// 产品（上游连国际端点都没有），intl key 打它们在 validate 就拒，不进运行时。
const KEY_REGIONS = ['', 'cn', 'intl'];
function normalizeRegionKey(v) {
  const s = String(v || '').trim().toLowerCase();
  return KEY_REGIONS.includes(s) ? s : '';
}
/** 没有国际版的通道（区域恒为国内） */
const CN_ONLY_CHANNELS = new Set(['dumate', 'qwenwork']);

// ---- 校验 ----
// 返回 { ok } 或 { ok:false, reason }。reason 直接面向使用者，
// 所以要说清是哪一条规则挡住的，而不是笼统的「无效」。
function validate(key, ip, model, channel) {
  if (!key) return { ok: false, reason: 'unknown_key' };
  if (key.enabled === false) return { ok: false, reason: 'disabled' };

  if (key.expires_at && Date.now() > key.expires_at) {
    return { ok: false, reason: 'expired' };
  }

  const allow = normalizeList(key.ip_allowlist);
  if (allow.length && !allow.some((e) => ipMatches(ip, e))) {
    return { ok: false, reason: 'ip_not_allowed' };
  }

  const models = normalizeList(key.model_allowlist);
  if (models.length && model && !models.includes(model)) {
    return { ok: false, reason: 'model_not_allowed' };
  }

  // 通道绑定：设了就只允许走这条通道。不传 channel 时跳过（调用方没做
  // 通道判定的老路径不该因此被拒）。
  if (key.channel && channel && key.channel !== channel) {
    return { ok: false, reason: 'channel_not_allowed' };
  }

  // 区域绑定：intl key 打纯国内通道直接拒（上游连国际端点都不存在，
  // 放进运行时只会变成「没有可用账号」这种无信息量报错）。cn key 打
  // 国内通道天然通过；qoder/traework 的账号级过滤在 send 里做——
  // 请求的模型名不编码区域（qoder/xxx 两个区的账号都能接），区域约束
  // 只能落在账号池选择上。channel 未知时跳过（与通道绑定同一口径）。
  if (key.region && channel) {
    if (key.region === 'intl' && CN_ONLY_CHANNELS.has(channel)) {
      return { ok: false, reason: 'region_not_available' };
    }
  }

  return { ok: true };
}

// 从请求头里取 token。兼容三种客户端习惯：
// Authorization: Bearer xxx / x-api-key: xxx / api-key: xxx
function tokenFromHeaders(headers) {
  const h = headers || {};
  const auth = h.authorization || h.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(auth).trim());
  if (m) return m[1].trim();
  const x = h['x-api-key'] || h['api-key'] || h['apikey'];
  if (x) return String(x).trim();
  return '';
}

// 常时比较任意明文 token（DUMATE2API_KEY 环境变量兜底鉴权用）。
// 与 resolve 同款套路：先哈希再 timingSafeEqual，避免用响应耗时逐字节猜密钥。
function tokenMatches(token, plain) {
  if (!token || !plain) return false;
  const a = Buffer.from(hash(String(token).trim()), 'hex');
  const b = Buffer.from(hash(String(plain).trim()), 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function resolve(token) {
  if (!token) return null;
  const h = hash(String(token).trim());
  const { keys } = load();
  // 逐条 timingSafeEqual 而不是用 map 查找：哈希比对走常数时间，
  // 避免通过响应耗时逐字节猜 token
  for (const k of keys) {
    const a = Buffer.from(k.hash || '', 'hex');
    const b = Buffer.from(h, 'hex');
    if (a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b)) return k;
  }
  return null;
}

function list() {
  const { keys } = load();
  return keys.map((k) => ({
    ...k,
    // hash 不出接口（校验用），plain 出接口（管理端查看/复制完整 key；
    // 旧 key 没有这个字段，前端按「明文未存」显示）
    hash: undefined,
  }));
}

function create(opts = {}) {
  // 跨进程互斥（filelock.js）：网关/管理端两个进程都会写 keys.json，
  // 无锁 RMW 时后写者会用旧快照覆盖先写者的 key。锁内先失效缓存再重读。
  return filelock.withLock(filePath(), () => {
    cache = { mtime: -1, data: null };
    const { keys } = load();
    const token = generateToken();
    const now = Date.now();
    // 默认名不能按 keys.length 生成：删掉一个再建，长度回到原值就会与现存
    // key 重名，而用量是按名字聚合的，两个 key 的统计会串在一起。
    // 取「当前最大编号 +1」，与现存名字保证不撞。
    let autoName = '';
    if (!String(opts.name || '').trim()) {
      const used = new Set(keys.map((k) => k.name));
      let n = keys.length + 1;
      while (used.has(`key-${n}`)) n++;
      autoName = `key-${n}`;
    }
    const key = {
      id: (keys.reduce((m, k) => Math.max(m, k.id || 0), 0) + 1),
      name: String(opts.name || '').trim() || autoName,
      prefix: token.slice(0, 12),
      hash: hash(token),
      // 明文随 key 一起落盘（2026-11-01 用户要求）：管理端要支持随时查看与
      // 复制完整 key——「明文仅创建时返回一次」的旧策略废除了。明文本就
      // 属于签发方（网关/管理端）自持的凭证，data/ 目录已 gitignore，与
      // web-accounts.json 明文存 cookie 是同一种信任边界。
      // 旧 key 没有 plain 字段：明文在旧策略下从未落盘，无法回填，界面对
      // 这些 key 如实显示「明文未存」。
      plain: token,
      created_at: now,
      expires_at: opts.expires_at || null,
      enabled: opts.enabled !== false,
      ip_allowlist: normalizeList(opts.ip_allowlist),
      model_allowlist: normalizeList(opts.model_allowlist),
      // 通道绑定：留空 = 不限（网关按模型名前缀分流）
      channel: normalizeChannel(opts.channel),
      // 区域绑定：留空 = 不限；'cn'/'intl' 只对 qoder/traework 有区分度
      region: normalizeRegionKey(opts.region),
      note: String(opts.note || ''),
    };
    keys.push(key);
    save({ keys });
    return { key: { ...key, hash: undefined }, token };
  });
}

function update(id, patch = {}) {
  return filelock.withLock(filePath(), () => {
    cache = { mtime: -1, data: null };
    const data = load();
    const k = data.keys.find((x) => x.id === Number(id));
    if (!k) return null;
    if (patch.name !== undefined) k.name = String(patch.name).trim() || k.name;
    if (patch.enabled !== undefined) k.enabled = !!patch.enabled;
    if (patch.expires_at !== undefined) k.expires_at = patch.expires_at || null;
    if (patch.ip_allowlist !== undefined) k.ip_allowlist = normalizeList(patch.ip_allowlist);
    if (patch.model_allowlist !== undefined) k.model_allowlist = normalizeList(patch.model_allowlist);
    if (patch.channel !== undefined) k.channel = normalizeChannel(patch.channel);
    if (patch.region !== undefined) k.region = normalizeRegionKey(patch.region);
    if (patch.note !== undefined) k.note = String(patch.note);
    save(data);
    return { ...k, hash: undefined };
  });
}

function remove(id) {
  return filelock.withLock(filePath(), () => {
    cache = { mtime: -1, data: null };
    const data = load();
    const before = data.keys.length;
    data.keys = data.keys.filter((x) => x.id !== Number(id));
    if (data.keys.length === before) return false;
    save(data);
    return true;
  });
}

module.exports = {
  PREFIX,
  CHANNELS,
  KEY_REGIONS,
  normalizeRegionKey,
  CN_ONLY_CHANNELS,
  filePath,
  load,
  save,
  list,
  create,
  update,
  remove,
  resolve,
  validate,
  validateCIDR,
  ipMatches,
  tokenFromHeaders,
  tokenMatches,
  hash,
};
