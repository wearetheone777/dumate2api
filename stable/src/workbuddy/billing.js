// src/workbuddy/billing.js - 签到与额度（billing 域，仅国内版有签到）
//
// 端点（对照 checkin.rs / upstream.rs fetch_credits）：
//   签到状态：POST {billing}/v2/billing/meter/checkin-activity-status（新，
//             失败回退 /checkin-status），body {}，只读
//   执行签到：POST {billing}/v2/billing/meter/daily-checkin；「已签到」按成功
//   额度包：  POST {billing}/v2/billing/meter/get-user-resource
// **国际版签到明确不支持**（「该版本暂不支持自动签到」）——如实报错，不白打。
// 认证头走 build_auth_headers（Bearer + X-User-Id + X-Enterprise/Tenant-Id + X-Domain）。
const c = require('./constants');

/** billing 域认证头（对照 account.rs build_auth_headers；非 chat 路径） */
function authHeaders(region, account) {
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${(account && account.accessToken) || ''}`,
  };
  if (account && account.uid) h['X-User-Id'] = account.uid;
  if (account && account.enterpriseId) {
    h['X-Enterprise-Id'] = account.enterpriseId;
    h['X-Tenant-Id'] = account.enterpriseId;
  }
  if (account && account.domain) h['X-Domain'] = account.domain;
  return h;
}

/** billing 域 POST 的小包装（body 恒为 {}） */
function post(region, account, path) {
  return new Promise((resolve) => {
    const spec = c.specOf(region);
    const u = new URL(spec.billingBase + c.CHECKIN_API_PREFIX + path);
    const body = JSON.stringify({});
    let agent = null;
    try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
      return resolve({ status: 0, body: e.message });
    }
    const headers = {
      ...authHeaders(region, account),
      'Content-Length': String(Buffer.byteLength(body)),
      'User-Agent': c.CLIENT_UA,
      Origin: spec.billingBase,
      Referer: `${spec.billingBase}/`,
    };
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
    req.write(body);
    req.end();
  }).then((r) => {
    let doc = null;
    try { doc = JSON.parse(r.body); } catch (e) { /* 非 JSON */ }
    return { status: r.status, doc };
  });
}

/**
 * 查签到状态。新接口失败回退旧接口（checkin.rs 同款）。
 * 返回 { ok, todayCheckedIn?, dailyCredit?, todayCredit?, totalCredits?,
 *        streakDays?, streakBonusCredit?, checkinDates?, error? }
 */
async function checkinStatus(region, account) {
  if (c.normalizeRegion(region) === 'global') {
    return { ok: false, unsupported: true, error: '该版本暂不支持自动签到' };
  }
  for (const ep of [c.EP_CHECKIN_STATUS, c.EP_CHECKIN_STATUS_FALLBACK]) {
    const r = await post(region, account, ep);
    const doc = r.doc;
    const code = doc ? Number(doc.code) : -1;
    if (r.status >= 200 && r.status < 300 && (code === 0 || code === 200)) {
      const d = (doc && doc.data) || {};
      return {
        ok: true,
        todayCheckedIn: d.today_checked_in ?? d.todayCheckedIn ?? false,
        dailyCredit: d.daily_credit != null ? Number(d.daily_credit) : null,
        todayCredit: d.today_credit != null ? Number(d.today_credit) : null,
        totalCredits: d.total_credits != null ? Number(d.total_credits) : null,
        streakDays: d.streak_days != null ? Number(d.streak_days) : null,
        streakBonusCredit: d.streak_bonus_credit != null ? Number(d.streak_bonus_credit) : null,
        checkinDates: d.checkin_dates ?? null,
      };
    }
  }
  return { ok: false, error: '签到状态查询失败（两个端点都未成功）' };
}

/**
 * 执行签到。已签（服务端提示）按成功处理（幂等）。
 * 返回 { ok, already?, message?, error? }
 */
async function checkinClaim(region, account) {
  if (c.normalizeRegion(region) === 'global') {
    return { ok: false, unsupported: true, error: '该版本暂不支持自动签到' };
  }
  const r = await post(region, account, c.EP_CHECKIN_CLAIM);
  const doc = r.doc;
  const code = doc ? Number(doc.code) : -1;
  if (r.status >= 200 && r.status < 300 && (code === 0 || code === 200)) {
    return { ok: true };
  }
  const msg = (doc && (doc.message || doc.msg)) || `code=${code}`;
  if (msg.includes('已签到') || msg.toLowerCase().includes('repeat')) {
    return { ok: true, already: true, message: msg };
  }
  return { ok: false, error: msg };
}

/**
 * 额度包列表（get-user-resource）。
 * 返回 { ok, total, packages:[{name, remain, size}], error? }
 *
 * 解析口径（对照 upstream.rs fetch_credits）：优先 CycleCapacity 三件套的
 * CycleCapacityRemain；没有周期字段时退 CapacityRemain。负数归 0。
 */
/**
 * 套餐列表解析（纯函数，单测用真机夹具）。
 * @returns {{total:number, totalPrecise:number|null, preciseDecimals:number|null, packages:Array}}
 */
function parsePackages(rawAccounts) {
  const packages = [];
  let total = 0;
  let totalPrecise = 0;
  let anyPrecise = false;
  let preciseDecimals = 0;
  for (const a of Array.isArray(rawAccounts) ? rawAccounts : []) {
    if (!a || typeof a !== 'object') continue;
    const num = (k) => (Number(a[k]) || 0);
    const size = num('CycleCapacitySize');
    const cycleRemain = num('CycleCapacityRemain');
    const cycleUsed = num('CycleCapacityUsed');
    let remain = (size > 0 || cycleRemain > 0 || cycleUsed > 0) ? cycleRemain : num('CapacityRemain');
    if (remain < 0) remain = 0;
    total += remain;
    // 精确余额：整数 remain 是 floor（真机 "8.8" vs 8）——计费自检用它能
    // 摆脱整数量化。字符串小数原样取；**字段缺失不是 0**（num(undefined)=0
    // 会把 totalPrecise 污染成 0，2026-11-04 单测当场抓到），缺失记 null。
    const preciseRaw = a.CycleCapacityRemainPrecise ?? a.CapacityRemainPrecise;
    const hasPrecise = preciseRaw != null && String(preciseRaw).trim() !== '';
    // 注意：本函数内的局部 num() 是「按键取值」，这里要的是**按值**转换
    const n = hasPrecise ? Number(preciseRaw) : NaN;
    const remainPrecise = Number.isFinite(n) ? n : null;
    if (remainPrecise != null && remainPrecise >= 0) {
      totalPrecise += remainPrecise;
      anyPrecise = true;
      const d = decimalsOf(preciseRaw);
      if (d != null && d > preciseDecimals) preciseDecimals = d;
    }
    packages.push({
      name: String(a.PackageName || '(unnamed)'),
      remain,
      size: size > 0 ? size : num('CapacitySize'),
      // 到期：CycleEndTime（北京时间字符串）。FEFO 的数据源；没有如实 null
      expireAt: parseBeijingTime(a.CycleEndTime) || parseBeijingTime(a.ExpiredTime) || null,
      remainPrecise: remainPrecise >= 0 ? remainPrecise : null,
    });
  }
  return {
    total,
    // 精确合计：任一包有 precise 才给（部分缺失时它是**下界**，不能冒充全量）
    totalPrecise: anyPrecise ? Math.round(totalPrecise * 10000) / 10000 : null,
    // 上游小数位数（推测量化分辨率用）；没有任何 precise 时 null
    preciseDecimals: anyPrecise ? preciseDecimals : null,
    packages,
  };
}

async function fetchCredits(region, account) {
  if (c.normalizeRegion(region) === 'global') {
    return { ok: false, unsupported: true, error: '国际版没有此额度接口（套餐口径不同）' };
  }
  const spec = c.specOf(region);
  const u = new URL(spec.billingBase + c.CHECKIN_API_PREFIX + c.EP_CREDITS);
  const now = new Date();
  const fmt = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const end = new Date(now.getTime() + 365 * 101 * 86400000);
  const body = JSON.stringify({
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: fmt(end),
  });
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
    return { ok: false, error: e.message };
  }
  const headers = {
    ...authHeaders(region, account),
    'Content-Length': String(Buffer.byteLength(body)),
    'User-Agent': c.CLIENT_UA,
    Origin: spec.billingBase,
    Referer: `${spec.billingBase}/`,
  };
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
    req.write(body);
    req.end();
  });
  let doc = null;
  try { doc = JSON.parse(r.body); } catch (e) { /* 非 JSON */ }
  const code = doc ? Number(doc.code) : -1;
  if (r.status < 200 || r.status >= 300 || (Number.isFinite(code) && code !== 0) || !doc) {
    return { ok: false, error: (doc && (doc.msg || doc.message)) || `HTTP ${r.status}` };
  }
  const wrapper = (doc.data && typeof doc.data === 'object') ? doc.data : {};
  const data = (wrapper.Response && typeof wrapper.Response === 'object') ? wrapper.Response : {};
  const inner = (data.Data && typeof data.Data === 'object') ? data.Data : {};
  // 调用方（/credits、探针、keepalive）都按 q.ok 判定——成功必须带 ok:true
  return { ok: true, ...parsePackages(inner.Accounts) };
}

// ---------------------------------------------------------------------------
// 计费自检的纯函数（admin/routes/workbuddy.js 的 /billing-check 用）
//
// 口径与 traework/billing.js 同一定位、同一算法（各通道独立实现，TRAE 的
// 注释解释了为什么用「前后快照差值」而不是上游账单：WorkBuddy 也没有逐笔
// 消费接口，get-user-resource 只给套餐剩余）。**推断口径**——量化、结算
// 延迟、并发都会影响读数，探针把原始数字一并返回，判定留给看结果的人。
// ---------------------------------------------------------------------------

function num(v) {
  return v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
}

/**
 * 解析上游的本地时间字符串（"2026-11-04 09:00:11"）。实测是**北京时间**
 * （CycleStartTime 字符串与 CreateTime 毫秒值逐字对照过），机器时区无关地
 * 按 +08:00 解析；解析不出如实 null，不拿当前时间凑。
 */
function parseBeijingTime(s) {
  const str = String(s || '').trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) return null;
  const ms = Date.parse(str.replace(' ', 'T') + '+08:00');
  return Number.isFinite(ms) ? ms : null;
}

/** 小数位数（"8.8"→1；用于推测量化分辨率）。非数字/整数给 0，缺失给 null */
function decimalsOf(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^-?\d+\.\d+$/.test(s)) return null;
  return s.split('.')[1].length;
}

/**
 * 实测倍率 = 消耗增量 ÷ (tokens/1000)。
 * 差值为负（结算回滚）或 token 为 0 时返回 null——如实留空，不编。
 * 差值为 0 是合法测量（本例没扣费），保留 0。
 */
function billedRate(delta, tokens) {
  const d = num(delta);
  const t = num(tokens);
  if (d == null || d < 0 || t == null || t <= 0) return null;
  return Math.round((d / (t / 1000)) * 10000) / 10000;
}

/** 比值 = billed / expected。任一侧缺失或 expected <= 0 时如实 null（0 = 免费档，不做除法） */
function ratioOf(billed, expected) {
  const b = num(billed);
  const e = num(expected);
  if (b == null || e == null || e <= 0) return null;
  return Math.round((b / e) * 1000) / 1000;
}

/**
 * 从「请求前 / 请求后的套餐**剩余**快照」推导本次消耗。
 *
 * **符号方向与 TRAE 相反**：TRAE 的 consumed 是累计消耗（越用越大），
 * WorkBuddy 的 get-user-resource 给的是套餐**剩余**（越用越小）——
 * 消耗 = 请求前 − 请求后。照抄 TRAE 的 (after − before) 会把所有真实
 * 消耗都算成负数、探测永远测不到（2026-11-04 单测当场抓到）。
 *
 * @param {Map<string, number>} before 账号 id → 剩余合计
 * @param {Map<string, number>} after  账号 id → 剩余合计
 * @param {string|number|null} [servedId] 本次实际服务的账号 id（send 的
 *   onAccount 上报）。给了就取该账号的增量；没给时仅在「恰好一个账号被
 *   扣费」时采用其增量——多个账号同时降说明有并发流量，合并数字会失真。
 * @returns {{charged: Array<{id: string, delta: number}>, delta: number|null, singleAccount: boolean}}
 */
function attributeDelta(before, after, servedId) {
  const charged = [];
  for (const [id, afterVal] of after) {
    const b = before.get(id);
    if (b == null || afterVal == null) continue;
    const d = Math.round((b - afterVal) * 10000) / 10000;
    if (d > 0) charged.push({ id: String(id), delta: d });
  }
  let delta = null;
  if (servedId != null) {
    const hit = charged.find((c) => c.id === String(servedId));
    delta = hit ? hit.delta : null;
  } else if (charged.length === 1) {
    delta = charged[0].delta;
  }
  return { charged, delta, singleAccount: charged.length === 1 };
}

// ---------------------------------------------------------------------------
// 账号档位（hub v1.7.27 #505：计费摘要是唯一可信的档位来源）
//
// POST {billing}/v2/billing/meter/get-user-resource-summary（body {}，
// X-Client-Platform: web）的 IsPaidUser / SubscriptionPackageName /
// IsProtectedPriceUser / ProTrialStatus 解析成账号档案的 tier 记录。
// 三条硬口径（hub 实测注释照抄）：
//   · 响应里没有 IsPaidUser 字段 → 返回 null——「没有答案」绝不能写成「免费」；
//   · 401 / 非 0 code / 网络错误 → null，旧值与时间戳原样保留；
//   · 企业账号（enterpriseId）跳过——上游对它们的 IsPaidUser 语义未验证。
// TTL 24h：cn 的详细积分路径没打这个端点（我们与 hub 不同，fetchCredits 走
// get-user-resource），所以两区都是每账号每天最多一次摘要请求。
// ---------------------------------------------------------------------------
const EP_TIER_SUMMARY = '/get-user-resource-summary';
const TIER_TTL_MS = 24 * 3600 * 1000;

/** 计费摘要 → tier 纯函数。没有 IsPaidUser 字段 = 没有答案，返回 null */
function parseTierSummary(data) {
  if (!data || typeof data !== 'object' || !('IsPaidUser' in data)) return null;
  return {
    paid: !!data.IsPaidUser,
    package: String(data.SubscriptionPackageName || ''),
    protectedPrice: !!data.IsProtectedPriceUser,
    trial: String(data.ProTrialStatus || ''),
  };
}

function tierIsFresh(account, ttlMs = TIER_TTL_MS) {
  const at = Number(account && account.tier && account.tier.at) || 0;
  return at > 0 && Date.now() - at < ttlMs;
}

/** 拉一次计费摘要。任何失败返回 null（绝不把失败写成「免费」） */
async function fetchTier(region, account) {
  return fetchTierImpl(region, account);
}

async function fetchTierImpl(region, account) {
  if (!account || account.enterpriseId) return null;
  const spec = c.specOf(c.normalizeRegion(region));
  const u = new URL(spec.billingBase + c.CHECKIN_API_PREFIX + EP_TIER_SUMMARY);
  const body = JSON.stringify({});
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
    return null;
  }
  const headers = {
    ...authHeaders(region, account),
    'X-Client-Platform': 'web',
    'Content-Length': String(Buffer.byteLength(body)),
    'User-Agent': c.CLIENT_UA,
    Origin: spec.billingBase,
    Referer: `${spec.billingBase}/`,
  };
  const r = await new Promise((resolve) => {
    const req = require('https').request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers,
      ...(agent ? { agent } : {}), timeout: 15000,
    }, (res) => {
      let buf = '';
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      res.on('data', (x) => { buf += dec.write(x); });
      res.on('end', () => { buf += dec.end(); resolve({ status: res.statusCode, body: buf }); });
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.write(body);
    req.end();
  });
  let doc = null;
  try { doc = JSON.parse(r.body); } catch (e) { /* 非 JSON */ }
  const code = doc ? Number(doc.code) : -1;
  if (r.status < 200 || r.status >= 300 || (Number.isFinite(code) && code !== 0) || !doc) return null;
  return parseTierSummary(doc.data);
}

/**
 * 档位到期才刷新（TTL 内直接用账号档案现值）。失败保留旧值。
 * @returns {Promise<{paid:boolean, package:string, at:number}|null>}
 */
async function maybeRefreshTier(account, opts = {}) {
  if (!account || account.enterpriseId) return null;   // 企业账号语义未验证，跳过
  if (!opts.force && tierIsFresh(account)) {
    return account.tier || null;
  }
  // fetchTier 内部已全捕获；这里再兜一层——任何异常都不得把「刷新失败」
  // 变成「写空结论」或冒泡打断调用方（/credits 的主流程）
  let info = null;
  try { info = await fetchTierImpl(account.region, account); } catch (e) { info = null; }
  if (!info) return account.tier || null;   // 失败：旧值原样保留
  const tier = { ...info, at: Date.now() };
  try { require('./auth').patch(account.id, { tier }); } catch (e) { /* 记不下不影响返回 */ }
  return tier;
}

/** 测试注入点（替换 fetchTier 的出站实现） */
function _setFetchTier(f) { fetchTierImpl = f; }

module.exports = {
  checkinStatus, checkinClaim, fetchCredits, authHeaders,
  billedRate, ratioOf, attributeDelta,
  parseBeijingTime, decimalsOf, parsePackages,
  parseTierSummary, tierIsFresh, fetchTier, maybeRefreshTier, _setFetchTier, TIER_TTL_MS,
};
