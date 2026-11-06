// src/qwenwork/auth.js - 千问办公凭证存储与 token 刷新
//
// 与 src/traework/auth.js 同构：凭证由我们自己持有，存到 data/ 下，
// 多账号就是多条记录。
//
// 这条通道以前只读官方客户端的 auth-v2.dat（Electron safeStorage 加密），
// 那份文件同一时刻只有一份登录态，所以两个账号无法并存、必须开客户端换。
// 逆向出客户端自己的登录方式后（见 login.js：OAuth device flow + PKCE），
// 我们也能自己拿凭证——于是「只认账号池」，不再碰客户端那个文件。
//
// 好处不只是能多账号：凭证在自己的文件里，刷新与落盘都在我们手上，
// 不存在「客户端和我们各写一次互相刷掉」的问题。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const c = require('./constants');
const { explainError } = require('../errtext');
const filelock = require('../filelock');
const fileperm = require('../fileperm');

const FILE = 'qwenwork-accounts.json';

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

/** 原子写：先 .tmp 再 rename。中途被 kill 不会留下半个 JSON */
function save(data) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const target = filePath();
  const tmp = `${target}.tmp`;
  // 权限收紧（fileperm.js）：token 与明文手机号只留在当前用户可读的文件里
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fileperm.harden(tmp);
  filelock.renameAtomic(tmp, target);
  cache = { mtime: fs.statSync(target).mtimeMs, data };
  return data;
}

/** 列表（脱敏：token 全量不外传，只给 refresh 尾 6 位供人工核对） */
function list() {
  return load().accounts.map((a) => ({
    id: a.id,
    uid: a.uid || '',
    nickname: a.nickname || '',
    username: a.username || '',
    email: a.email || '',
    // 手机号只给脱敏形式：认号够用，又不把完整号码裸在页面上。
    // 完整值只留在账号文件里，与 token 同级对待
    phoneMasked: maskPhone(a.phone),
    hasPhone: !!a.phone,
    tier: a.tier || '',
    planId: a.planId || '',
    planName: a.planName || '',
    enabled: a.enabled !== false,
    preferred: !!a.preferred,
    expiresAt: a.expiresAt || null,
    refreshExpiresAt: a.refreshExpiresAt || null,
    machineId: a.machineId || '',
    // 读取时翻译：存量记录里的 `aborted` 之类也要看得懂（详见 errtext.js）
    lastError: explainError(a.lastError),
    // lastError 的写入时刻。界面据此显示「N 分钟前」——没有它，一条几小时前
    // 的瞬时错误会被读成「当前故障」（2026-10-02 实测踩到：账号页显示的
    // 403/402 其实早已自愈）。无 lastError 时为 null。
    lastErrorAt: a.lastErrorAt || null,
    createdAt: a.createdAt || null,
    // 「账号存活天数」供仪表盘展示——接口里没这字段，由 createdAt 算。
    // 没有 createdAt（旧数据兼容）就 null，界面显示「—」，不编天数
    daysAlive: a.createdAt ? Math.floor((Date.now() - a.createdAt) / 86400000) : null,
    // 「凭证是否完整」要以布尔形式带出来：refreshToken 本身不外传，
    // 但调用方（管理端的 usable 判定）需要知道有没有。
    // 不这么做的话 usable 只能拿被脱敏掉的字段判，结果恒为 false。
    hasRefresh: !!a.refreshToken,
    hasAccess: !!a.accessToken,
    refreshTail: a.refreshToken ? String(a.refreshToken).slice(-6) : '',
    // 凭证来源标记：refresh 被拒时从官方客户端 auth-v2.dat 收编救活的账号带
    // 'official-desktop'（exchange 的兜底写入）。排障时能看出「这个号是靠
    // 客户端登录态救活的」，正常 device flow 的账号没有这个字段
    adoptedFrom: a.adoptedFrom || null,
    // refresh token 临期预警（<24h）：过期即必须重新 device flow，
    // 提前一天亮牌比过期后账号变不可用再排查强（与 admin /accounts 同口径）
    refreshExpiringSoon: !!(a.refreshExpiresAt && a.refreshExpiresAt > Date.now()
      && a.refreshExpiresAt - Date.now() < 24 * 3600 * 1000),
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
 * 主账号：preferred 优先，其次环境变量指定的 id，最后取第一个可用。
 *
 * 顺序为什么是这样：preferred 是用户在账号文件里定的（稳定），环境变量是
 * 临时覆盖（改启动参数不改文件）。两者都没配就取第一个——「第一个」在
 * 删号后会变，所以只作兜底，不该成为长期依赖。
 */
function preferred() {
  const usable = findUsable();
  if (!usable.length) return null;
  const envId = String(process.env.DUMATE_QWENWORK_ACCOUNT || '').trim();
  if (envId) {
    const byEnv = usable.find((a) => String(a.id) === envId);
    if (byEnv) return byEnv;
  }
  const marked = usable.find((a) => a.preferred);
  if (marked) return marked;
  return usable[0];
}

/** 新增或按 uid / id 覆盖。uid 相同视为同一个账号（重新登录同一个号） */
function upsert(acc) {
  // 跨进程互斥（filelock.js）：**高危点**——网关在请求失败时 patch(lastError)、
  // 管理端在换票后写新的 accessToken/refreshToken，两个进程同时 RMW 时后写者
  // 会用旧快照盖掉先写者刚换到的 refresh token，账号直接报废。锁内先失效
  // 缓存再重读，保证改的是磁盘上的最新值。
  return filelock.withLock(filePath(), () => {
    cache = { mtime: -1, data: null };
    const data = load();
    const i = data.accounts.findIndex((a) => (acc.uid && a.uid === acc.uid) || (acc.id && a.id === acc.id));
    // 主账号是排他的：任何写路径带 preferred:true 都要先清掉别人的。
    // 只在新账号时设 preferred 是不够的——绕过 upsert 直接传 preferred 的
    // 调用方（如探针、导入）会留下两个 true，选号就变成「看谁排在前面」。
    if (acc && acc.preferred === true) {
      for (const x of data.accounts) x.preferred = false;
    }
    if (i >= 0) {
      data.accounts[i] = { ...data.accounts[i], ...acc };
      save(data);
      return data.accounts[i];
    }
    const id = data.accounts.reduce((m, a) => Math.max(m, Number(a.id) || 0), 0) + 1;
    // 池里第一个账号自动成为主账号，否则一个账号时也要额外配一次
    const rec = { id, enabled: true, createdAt: Date.now(), ...acc };
    if (rec.preferred === undefined) rec.preferred = data.accounts.length === 0;
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
    // 删掉的是主账号时，把主账号顺延给剩下的第一个——否则池里没有 preferred，
    // 选号会静默退化成「取第一个」，用户以为是随机换的
    if (!data.accounts.some((a) => a.preferred) && data.accounts.length) {
      data.accounts[0].preferred = true;
    }
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
    // 设为主账号是排他的：置 true 时清掉其他账号的同标记
    if (fields && fields.preferred === true) {
      for (const x of data.accounts) if (x.id !== a.id) x.preferred = false;
    }
    // lastError 与 lastErrorAt 必须同步移动：所有写 lastError 的调用方
    // （index.js 的 markFailure、chat.js 的换票失败）都走这里，集中打时间戳
    // 比在每个调用点各写一次可靠——漏一处就会出现「有时间戳的错误」和
    // 「没时间戳的错误」两种形状，界面无法统一判断新鲜度。
    //
    // 为什么要时间戳：lastError **只在换票成功时才清空**，所以它经常停在
    // 很久以前的失败上。用户看到「Model is not available」会以为当前坏了，
    // 其实可能是几小时前那次瞬时抖动的残留。带上时刻才能显示「N 分钟前」。
    if (fields && fields.lastError !== undefined) {
      fields.lastErrorAt = fields.lastError ? Date.now() : null;
    }
    Object.assign(a, fields);
    save(data);
    return a;
  });
}

/**
 * token 是否该续期了（在 skewMs 内过期就续）。
 *
 * **提前量必须按小时算，不能按分钟**（2026-10-29 修，账号报废级）。
 *
 * 原值是 5 分钟。它的隐含假设是「反正每个请求都会走到这里，快到期时顺手续上」——
 * 但那只在**有请求**的时候成立。实测后果：
 *
 *   · 账号 1 的 access token `iat 10-21 14:07 / exp 10-28 14:07`（7 天有效）
 *   · 它最后一次成功请求是 10-28 08:20，之后 6 小时没有流量
 *   · 于是 5 分钟窗口里一个请求都没有 → 没人触发续期
 *   · 下次有人来（10-29 13:10，已过期 **23 小时**）才第一次换票
 *   · 上游回 `401 INVALID_REFRESH_TOKEN` / `invalid_grant:令牌未激活或缺少用户ID`
 *
 * 也就是说：**refresh token 只在 access token 还有效时可用**，过期太久 grant
 * 直接被作废，7 天的额度全废，只能重新登录。同一天同在跑的另一账号（10-28
 * 16:36 到期）因为当时有请求，在到期这一刻续上了，一直健康——差别只在
 * 「到期时有没有流量」，这就是 5 分钟窗口的随机性风险。
 *
 * 改成 24 小时：任何一次请求都会提前一天续上，不再依赖「到期那一刻恰好有请求」。
 * 与 `traework/auth.js` 的口径一致（那边一直是 24 小时，所以 TRAE 从没出过这种事）。
 * 代价是每天多一次换票请求——可忽略，而账号报废要人工重登。
 *
 * 注意上游**允许**同一 RT 重复使用（实测并发 3 次全部 200，且各自轮换出新 RT），
 * 所以提前续期不会消耗掉别的进程手里的 RT。
 */
function needsRefresh(a, skewMs = 24 * 3600 * 1000) {
  if (!a || !a.expiresAt) return true;
  return Date.now() + skewMs >= a.expiresAt;
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

/** 发一个 JSON 请求。统一用 StringDecoder——跨 chunk 的汉字逐块解码会变 U+FFFD。
 *  opts.agent 出站代理（E 包接线）：凭证请求与对话同出口，换 IP 出口不一致
 *  本身就是风控信号。null = 直连。 */
function requestJson(pathname, method, body, headers, timeout = 20000, opts = {}) {
  return new Promise((resolve) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = require('https').request({
      hostname: new URL(c.GATEWAY).hostname,
      path: pathname,
      method,
      headers: {
        ...headers,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout,
      ...(opts.agent ? { agent: opts.agent } : {}),
    }, (res) => {
      let buf = '';
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      res.on('data', (x) => { buf += dec.write(x); });
      res.on('end', () => {
        buf += dec.end();
        let data = null;
        try { data = JSON.parse(buf); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, data, raw: buf });
      });
    });
    req.on('error', (e) => resolve({ status: 0, data: null, raw: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: null, raw: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 用 refreshToken 换 device_token（单次，不含兜底）。
 *
 * **不落盘**：返回 patch 字段由调用方写回，保持「读-改-写」在一次调用里，
 * 避免并发刷新时后写的覆盖掉先写的（traework/auth.js 同一约定）。
 *
 * refresh token 是轮换的：每次返回新的，必须存下来。实测旧 token 不会被
 * 立即作废（同一 RT 连用多次都成功），但那不能当成设计保证——新的一定存。
 */
async function exchangeOnce(a) {
  if (!a || !a.refreshToken) return { ok: false, error: '缺少 refreshToken', status: 0, errorCode: '' };
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(a); } catch (e) {
    return { ok: false, error: `出站代理配置错误: ${e.message}`, status: 0, errorCode: '' };
  }
  const r = await requestJson(c.REFRESH_PATH, 'POST', { refresh_token: a.refreshToken, target: 'c' }, {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': c.USER_AGENT,
    'X-Request-Id': crypto.randomUUID(),
    'Login-Version': c.LOGIN_VERSION,
  }, 30000, { agent });

  const token = (r.data && (r.data.device_token || r.data.token)) || '';
  if (!token) {
    // refresh 失败通常是凭证本身失效（refresh token 过期/被吊销）。
    // 报「未返回 device_token」会让人去查网络，其实该做的是重新登录一次。
    const code = (r.data && (r.data.errorCode || r.data.error)) || `HTTP ${r.status}`;
    const detail = (r.data && (r.data.errorMessage || r.data.message)) || String(r.raw || '').slice(0, 120);
    return {
      ok: false,
      error: `换票失败（${code}${detail ? ': ' + detail : ''}）`,
      expired: true,
      // 供 exchange 的兜底判定：401/403 是「refresh 被明确拒绝」，收编才有意义
      status: r.status,
      errorCode: String((r.data && r.data.errorCode) || ''),
    };
  }

  const out = { accessToken: token };
  if (r.data.refresh_token) out.refreshToken = r.data.refresh_token;
  // 到期时间：优先 JWT 的 exp（服务端给的 expires_at 也可能有，两者一致时用 JWT）
  const exp = jwtExp(token) || (r.data.expires_at ? Date.parse(r.data.expires_at) : null);
  if (exp) out.expiresAt = exp;
  if (r.data.refresh_token_expires_at) {
    const t = Date.parse(r.data.refresh_token_expires_at);
    if (Number.isFinite(t)) out.refreshExpiresAt = t;
  }
  out.lastError = '';
  return { ok: true, patch: out };
}

/**
 * 官方登录态收编（融合自 Buddy2api v2.2.17 token.py 的 _official_replacement /
 * _adopt_official，2026-11-06）：refresh 被上游明确拒绝时，本机官方客户端若
 * **重新登录过**，它的 auth-v2.dat 里就有一份我们没有的新 refresh token——
 * 收编过来再刷一次，账号就不需要人工重新走 device flow。
 *
 * 收编成功后**必须把轮换出的新 token 写回官方文件**：refresh token 是轮换的，
 * 我们刷一次，官方客户端手里那份旧的就作废了——不写回去等于把用户从官方
 * 客户端里登出（反向事故）。写回失败只丢日志语义，不影响本次返回。
 *
 * 三道防线：
 *   - 官方文件读不到 / 解不开 → 不收编（本机没装客户端是常态）；
 *   - refreshToken 与存档相同 → 收编无意义（官方也没重新登录）；
 *   - uid 双侧都有且不一致 → 官方登录的是**另一个账号**，收编会张冠李戴。
 */
function adoptOfficialAndRefresh(a, deps = {}) {
  const cred = deps.credentials || require('./credentials');
  const refreshOnce = deps.exchangeOnce || exchangeOnce;
  let doc;
  try { doc = cred.decryptAuth(); } catch (e) { return null; }
  const officialRt = String(doc.refreshToken || doc.refresh_token || '');
  const officialTok = String(doc.token || '');
  if (!officialRt || officialRt === String((a && a.refreshToken) || '')) return null;
  const officialUid = String(doc.uid || (doc.user && (doc.user.id || doc.user.uid)) || '');
  if (officialUid && a && a.uid && officialUid !== String(a.uid)) return null;
  return (async () => {
    // 带上官方 access token 一起试：它可能仍然有效，能省一次「刷新再失败」
    const retry = await refreshOnce({ ...a, refreshToken: officialRt, accessToken: officialTok });
    if (!retry.ok) return null;
    try {
      cred.encryptAuth({
        ...doc,
        token: retry.patch.accessToken,
        refreshToken: retry.patch.refreshToken || officialRt,
        expiresAt: retry.patch.expiresAt
          ? new Date(retry.patch.expiresAt).toISOString()
          : doc.expiresAt,
      });
    } catch (e) { /* 写回失败不影响收编结果（下次刷新会再对齐） */ }
    return { ok: true, patch: { ...retry.patch, adoptedFrom: 'official-desktop' } };
  })();
}

/**
 * 换票（带兜底）。所有调用方入口。
 *
 * 失败时做两件事：
 *   1. **文案分层**：access 仍在有效期时，错误里带「仍可用到 HH:MM」——
 *      refresh 失效与通道整体不可用是两种故障，混成一句会让人把还能用的账号
 *      也去重新登录（Buddy2api token.py 的 _invalid_refresh_message 同款口径）。
 *   2. **官方登录态收编**：refresh 被明确拒绝（401/403 或 INVALID_REFRESH_TOKEN /
 *      invalid_grant）时尝试 adoptOfficialAndRefresh——网络抖动 / 5xx 不触发，
 *      那种失败换 token 也没用。
 */
async function exchange(a, opts = {}) {
  // deps 注入仅供测试（exchangeOnce / credentials），生产路径零感知
  const deps = opts.deps || {};
  const once = deps.exchangeOnce || exchangeOnce;
  const r = await once(a);
  if (r.ok || opts.noAdopt) return r;

  const exp = Number(a && a.expiresAt);
  if (Number.isFinite(exp) && exp > Date.now()) {
    r.error += `；访问令牌仍可用到 ${new Date(exp).toLocaleTimeString('zh-CN', { hour12: false })}，网关请求暂不受影响`;
  }

  const rejected = r.status === 401 || r.status === 403
    || /INVALID_REFRESH_TOKEN|invalid_grant/i.test(r.error || '');
  if (rejected) {
    try {
      const adopted = await adoptOfficialAndRefresh(a, { ...deps, exchangeOnce: once });
      if (adopted) return adopted;
    } catch (e) { /* 收编异常不吞原错误 */ }
  }
  return r;
}

/**
 * 取用户信息（登录后用一次，补 uid / 昵称 / 套餐）。
 * uid 是 wasm 签名的必需输入（prepareInfer 的 uid 参数），没有它发不出请求。
 */
async function fetchUserInfo(a) {
  const token = (a && (a.accessToken || a.access)) || '';
  if (!token) return null;
  // 出站代理（E 包收口补点）：用户信息查询与对话同出口。配置非法返回 null
  //（调用方按「读不到」处理），不回退直连。
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(a); } catch (e) { return null; }
  const r = await requestJson(c.ACCOUNT_CONTEXT_PATH, 'GET', null, {
    Accept: 'application/json',
    'User-Agent': c.USER_AGENT,
    Authorization: `Bearer ${token}`,
  }, 20000, { agent });
  if (r.status !== 200 || !r.data) return null;
  const d = (r.data && r.data.data) || r.data;
  const u = d.user || d;
  const plan = d.plan || {};
  return {
    uid: String(u.id || u.user_id || u.uid || ''),
    nickname: String(u.name || u.username || ''),
    username: String(u.username || u.user_name || ''),
    email: String(u.email || ''),
    tier: String(u.tier || plan.name || ''),
    planId: String(plan.pid || ''),
    planName: String(plan.name || ''),
  };
}

/**
 * 机器标识。
 *
 * 优先用客户端那份（~/.qoderworkcn/.auth/machine_id）——它是**已被证明能
 * 用于 wasm 签名**的值。随机生成一个也能登录，但服务端是否校验「签名用的
 * machine_id 必须等于登录时上报的那个」还没实测过（探针只验证到
 * account-context 与 wallets，没打过真实推理）。所以安全做法是沿用已验证的。
 *
 * 每个账号存一份自己的，之后不再改——改了等于换设备。
 */
function genMachineId() {
  try {
    const v = require('./credentials').machineId();
    if (v) return v;
  } catch (e) { /* 没装客户端就退回随机值 */ }
  return crypto.randomUUID();
}

/**
 * 取真实手机号。
 *
 * 不在 account-context 里（那里只有 phone_<uid>@phone.local 这种占位邮箱），
 * 要问 /api/v1/adapter/auth/identities 的 c_site_user。
 *
 * 拿不返回 null 而不是空串——「没拿到」和「这个号没绑手机」是两回事，
 * 界面上都要显示 —，但排查时得能区分。
 */
async function fetchPhone(a) {
  const token = (a && (a.accessToken || a.token)) || '';
  if (!token) return null;
  const r = await requestJson(c.IDENTITIES_PATH, 'GET', null, {
    Accept: 'application/json',
    'User-Agent': c.USER_AGENT,
    Authorization: `Bearer ${token}`,
  });
  if (r.status !== 200 || !r.data) return null;
  const u = (r.data && r.data.c_site_user) || {};
  const num = String(u.phone_number || '').trim();
  if (!num) return null;
  const cc = String(u.phone_country_code || '').trim();
  return { phone: cc ? `${cc}${num}` : num, countryCode: cc || '', verified: !!u.verified };
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

module.exports = {
  FILE, filePath, dataDir, load, save, list, get, findUsable, preferred,
  upsert, remove, patch, needsRefresh, exchange, exchangeOnce,
  adoptOfficialAndRefresh, jwtExp, fetchUserInfo,
  fetchPhone, maskPhone, genMachineId,
};
