// src/channel-balance.js - 跨通道额度总览（2026-11-08，docs/DUMATE-GATEWAY-MERGE-FEATURES.md P2-10）
//
// 一张卡回答「五条通道各还剩多少、几个账号能用、哪些快过期」。融合自
// CreditDaddy 的多平台额度总览思路：各通道的额度此前散落在各自的积分页与
// 账号页，必须逐个切通道才能看，缺一个横向视野。
//
// 四条纪律（都来自本项目的既有教训）：
//   1. **不跨通道相加**——单位不同：搭子/千问是积分，TRAE/Qoder 是 credits，
//      WorkBuddy 国际版按请求数计。CLAUDE.md 定案「三套账不能相加」，所以
//      只并排列出，不给「总计」。
//   2. **失败如实标注**——remaining=null + error，绝不填 0：0 会被读成
//      「额度用完了」，那是把「查不到」写成「没有」。
//   3. **只读不喂池**——余额查询失败与账号健康无关，不惩罚账号。
//   4. **进程内 TTL 缓存**（DUMATE_CHANNEL_BALANCE_TTL_MS，默认 60s，
//      0 = 每次现查）——聚合要打所有账号的上游读接口，仪表盘每次进来都
//      全查一遍既慢又平白暴露。
//
// 单通道适配器独立 try/catch + 15s 超时：一个通道上游挂了不能拖垮整张卡
// （该行标查询超时，其余照常显示）。
const expiring = require('./expiring');

const LABELS = {
  dumate: '百度搭子',
  qwenwork: '千问办公',
  traework: 'TRAE Work',
  qoder: 'Qoder',
  workbuddy: 'WorkBuddy',
};

const TTL_DEFAULT_MS = 60000;
const ROW_TIMEOUT_MS = 15000;
/** Qoder 的临期窗口与它的 FEFO 同源（grants 账本，没有快照） */
const QODER_FEFO_DEFAULT_DAYS = 3;

function ttlMs() {
  const n = parseInt(process.env.DUMATE_CHANNEL_BALANCE_TTL_MS || String(TTL_DEFAULT_MS), 10);
  return Number.isFinite(n) && n >= 0 ? n : TTL_DEFAULT_MS;
}

let cache = null;

const round2 = (v) => Math.round(v * 100) / 100;

/** 一行额度（所有字段都显式初始化——前端按字段渲染，缺字段会被读成 undefined!=0） */
function rowOf(id, unit, note) {
  return {
    id,
    label: LABELS[id],
    ok: false,
    remaining: null,
    unit,
    unlimited: false,
    accounts: { total: 0, ok: 0, fail: 0 },
    failed: [],
    note,
    error: null,
    expiring: null,
  };
}

/**
 * 通用填充：把逐账号结果收成一行。
 * okRows 是「查询成功」的账号；known 只是其中「有可加数值」的那些——
 * TRAE 国际账号（订阅制）与 WorkBuddy 国际账号（按请求数计）查询成功但
 * 没有积分口径，不能参与合计，也不能被当成失败。
 */
function fillFromResults(row, results) {
  const okRows = results.filter((r) => r.ok);
  const known = okRows.filter((r) => typeof r.remain === 'number' && Number.isFinite(r.remain));
  row.accounts = { total: results.length, ok: okRows.length, fail: results.length - okRows.length };
  row.failed = results.filter((r) => !r.ok).map((r) => ({ name: r.name, error: r.error || '查询失败' }));
  row.remaining = known.length ? round2(known.reduce((s, r) => s + r.remain, 0)) : null;
  row.ok = okRows.length > 0;
  if (!results.length) row.error = '通道没有账号';
  else if (!okRows.length) row.error = '全部账号查询失败';
  return row;
}

// ==================== 通道适配器 ====================

/** 搭子：复用 dumate-points 的网页池聚合（自带 15s TTL） */
async function dumateRow() {
  const dp = require('./dumate-points');
  const s = await dp.summaryCached();
  const row = rowOf('dumate', '积分', '网页凭证池读数；桌面链路（8980）余额不在此列');
  row.accounts = { total: s.rows.length, ok: s.okCount, fail: s.failCount };
  row.failed = s.rows.filter((r) => !r.ok).map((r) => ({ name: r.name, error: r.error || '查询失败' }));
  row.remaining = s.totalLeft;
  row.ok = s.okCount > 0;
  if (!s.rows.length) row.error = '网页池没有启用账号';
  else if (!s.okCount) row.error = '全部账号查询失败';
  return row;
}

/** 千问：月度 + 长期（daily 池上游已停发，不再显示） */
async function qwenworkRow() {
  const authStore = require('./qwenwork/auth');
  const credits = require('./qwenwork/credits');
  const row = rowOf('qwenwork', '积分', '月度 + 长期积分；余额未知的账号不进合计');
  const list = authStore.list();
  const results = await Promise.all(list.map(async (a) => {
    const name = a.nickname || a.uid || `账号 ${a.id}`;
    try {
      const w = await credits.fetchWallets({ account: authStore.get(a.id) });
      if (!w || !w.ok) return { ok: false, name, error: (w && w.error) || '查询失败' };
      // 优先上游权威总数（全 0 坏读时由 account-context 校正过），
      // 否则月度 + 长期——与 admin/routes/qwenwork.js 的 aggregateWallets 同口径
      const total = typeof w.total === 'number' ? w.total : null;
      const m = typeof w.monthly === 'number' ? w.monthly : null;
      const l = typeof w.longterm === 'number' ? w.longterm : null;
      const remain = total != null ? total : (m != null || l != null ? (m || 0) + (l || 0) : null);
      return { ok: true, name, remain };
    } catch (e) {
      return { ok: false, name, error: e.message };
    }
  }));
  return fillFromResults(row, results);
}

/** TRAE：usage_summary 的总额 − 已消耗；国际账号订阅制（remain 恒 null） */
async function traeworkRow() {
  const authStore = require('./traework/auth');
  const checkin = require('./traework/checkin');
  const row = rowOf('traework', 'credits', '国内积分；国际账号订阅制（按请求数计）不进合计');
  const list = authStore.findUsable();
  const results = await Promise.all(list.map(async (raw) => {
    const name = raw.nickname || raw.uid || `账号 ${raw.id}`;
    try {
      // 先用 accessToken 续期一次——管理端读接口拿的是落盘 token，过期不刷
      // 整行会恒报 "not able to authenticate"（与 /credits 同根因）
      const a = await checkin.withFreshToken(raw);
      const u = await checkin.usage(a);
      if (!u || !u.ok) return { ok: false, name, error: (u && u.error) || '查询失败' };
      return { ok: true, name, remain: typeof u.remain === 'number' ? u.remain : null };
    } catch (e) {
      return { ok: false, name, error: e.message };
    }
  }));
  return fillFromResults(row, results);
}

/** Qoder：套餐（userQuota）+ 签到赠送（addOnQuota）+ 可用的团队共享池 */
async function qoderRow() {
  const authStore = require('./qoder/auth');
  const session = require('./qoder/session');
  const row = rowOf('qoder', 'credits', '套餐 + 签到赠送；团队共享池按可用计');
  const list = authStore.list();
  const results = await Promise.all(list.map(async (a) => {
    const name = a.nickname || a.uid || `账号 ${a.id}`;
    try {
      // list() 是**脱敏视图**（不含 accessToken / refreshToken），换票必须
      // 用 get(id) 拿完整记录——否则 ensureAccount 拿不到 refreshToken，
      // 直接拿空 token 打上游就是 401（真机踩过：/qoder/credits 正常而这里
      // 两个账号全 401，差别就在这一行）
      const raw = authStore.get(a.id);
      if (!raw) return { ok: false, name, error: '账号已不存在' };
      const acc = await session.ensureAccount(authStore, raw);
      // region 用 list 的规范化值（get 返回的是落盘原值）
      const q = await session.fetchQuota(acc.accessToken, a.region);
      if (!q || !q.ok) return { ok: false, name, error: (q && q.error) || '查询失败' };
      const org = q.orgResourcePackage;
      // 团队共享池不限量（cap=-1）：可用的「剩余」不是一个有限数字，
      // 标 unlimited 让界面显示「不限量」而不是拿 0 去加
      if (org && org.available && org.unlimited) {
        return { ok: true, name, remain: null, unlimited: true };
      }
      const u = q.userQuota && Number.isFinite(q.userQuota.remaining) ? q.userQuota.remaining : 0;
      const add = q.addOnQuota && Number.isFinite(q.addOnQuota.remaining) ? q.addOnQuota.remaining : 0;
      const orgRemain = org && org.available && Number.isFinite(org.remaining) ? org.remaining : 0;
      return { ok: true, name, remain: u + add + orgRemain };
    } catch (e) {
      return { ok: false, name, error: e.message };
    }
  }));
  const out = fillFromResults(row, results);
  const unlimitedCount = results.filter((r) => r.ok && r.unlimited).length;
  if (unlimitedCount) {
    out.unlimited = true;
    out.note += `；${unlimitedCount} 个账号额度不限量`;
  }
  return out;
}

/** WorkBuddy：国内套餐剩余（精确值优先）；国际版没有积分接口 */
async function workbuddyRow() {
  const authStore = require('./workbuddy/auth');
  const billing = require('./workbuddy/billing');
  const row = rowOf('workbuddy', '积分', '国内套餐剩余；国际版按请求数计');
  const list = authStore.findUsable();
  const results = await Promise.all(list.map(async (raw) => {
    const name = raw.nickname || raw.uid || `账号 ${raw.id}`;
    try {
      const a = await authStore.ensureFresh(raw);
      const q = await billing.fetchCredits(a.region, a);
      if (!q || !q.ok) {
        // 国际版没有额度接口是「该版本不支持」，不是账号故障
        if (q && q.unsupported) return { ok: true, name, remain: null, unsupported: true };
        return { ok: false, name, error: (q && q.error) || '查询失败' };
      }
      const remain = q.totalPrecise != null ? q.totalPrecise : q.total;
      return { ok: true, name, remain: typeof remain === 'number' ? remain : null };
    } catch (e) {
      return { ok: false, name, error: e.message };
    }
  }));
  const out = fillFromResults(row, results);
  const unsupported = results.filter((r) => r.unsupported).length;
  if (unsupported) out.note += `；${unsupported} 个国际账号无积分口径`;
  return out;
}

// ==================== 临期 ====================

function qoderFefoDays() {
  const n = Number(process.env.DUMATE_QODER_FEFO_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : QODER_FEFO_DEFAULT_DAYS;
}

/**
 * 临期账号数 + 最早到期时刻。
 * 四家通道读落盘快照（窗口由 expiring.windowDays 决定，快照只记窗口内的
 * 账号）；Qoder 直接读 grants 账本（它没有快照）。
 */
function expiringOf(id) {
  try {
    if (id === 'qoder') {
      const days = qoderFefoDays();
      if (!days) return null; // FEFO 关闭 = 没有临期概念
      const grants = require('./qoder/grants');
      const soon = grants.expiring({ withinMs: days * 86400000 });
      if (!soon.length) return null;
      const ids = new Set(soon.map((g) => g.accountId));
      return { accounts: ids.size, nearest: soon[0].expiresAt || null };
    }
    const info = expiring.info(id);
    if (!info.accounts) return null;
    return { accounts: info.accounts, nearest: info.nearest || null };
  } catch (e) {
    return null;
  }
}

// ==================== 编排 ====================

/** 超时包装：race 的定时器必须清掉，否则进程里攒一堆待触发的 timer */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function safeRow(id, fn, unit, timeoutMs = ROW_TIMEOUT_MS) {
  try {
    const r = await withTimeout(fn(), timeoutMs);
    if (r === null) {
      const row = rowOf(id, unit, '');
      row.error = `查询超时（${Math.round(timeoutMs / 1000)}s）`;
      return row;
    }
    return r;
  } catch (e) {
    const row = rowOf(id, unit, '');
    row.error = e.message || '查询失败';
    return row;
  }
}

/** 通道顺序固定（卡片按这个顺序渲染；适配器可被 opts.adapters 覆盖） */
const ADAPTERS = {
  dumate: dumateRow,
  qwenwork: qwenworkRow,
  traework: traeworkRow,
  qoder: qoderRow,
  workbuddy: workbuddyRow,
};
const UNITS = { dumate: '积分', qwenwork: '积分', traework: 'credits', qoder: 'credits', workbuddy: '积分' };

/**
 * 五通道额度快照。opts.force 绕过 TTL（管理端「刷新」按钮与测试用）；
 * opts.adapters / opts.rowTimeoutMs 是测试接缝（生产路径不传）。
 * @returns {{at:number, cached:boolean, channels:object[], ttlMs:number}}
 */
async function snapshot(opts = {}) {
  const ttl = ttlMs();
  if (!opts.force && cache && ttl > 0 && Date.now() - cache.at < ttl) {
    return { ...cache.data, cached: true };
  }
  const adapters = { ...ADAPTERS, ...(opts.adapters || {}) };
  const timeoutMs = Number.isFinite(opts.rowTimeoutMs) && opts.rowTimeoutMs > 0
    ? opts.rowTimeoutMs
    : ROW_TIMEOUT_MS;
  const channels = await Promise.all(
    Object.keys(ADAPTERS).map((id) => safeRow(id, adapters[id], UNITS[id], timeoutMs)),
  );
  for (const r of channels) r.expiring = expiringOf(r.id);
  const out = { at: Date.now(), channels, ttlMs: ttl };
  cache = { at: out.at, data: out };
  return { ...out, cached: false };
}

function resetCacheForTest() { cache = null; }

module.exports = {
  snapshot, resetCacheForTest, ttlMs, fillFromResults, rowOf,
  LABELS, TTL_DEFAULT_MS, ROW_TIMEOUT_MS,
};
