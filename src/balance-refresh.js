// src/balance-refresh.js - 低频余额刷新 + 冷却自动解冻（2026-11-07 融合项 P1-5）
//
// 思路来自 workbuddy2api 面板的 schedule.balance_refresh_minutes（默认 5 分钟）：
// 「两次签到时点之间 credits 保持新鲜，余额恢复的冷却账号也会自动解冻」。
//
// 本仓库的缺口：FEFO 快照（data/expiring-snapshot.json）只在管理端三处页面
// 打开时才更新——**管理端不开，快照的 at 就停在上次打开页面的时刻**，网关
// 选号超 TTL（默认 6h）后静默退回普通轮询（expiring.js 的陈旧语义，可用性
// 不受影响但临期优先失效）；冷却账号的解冻只在每日 keepalive（22:30）跑。
// 本模块补的正是这个：低频、轻量（纯读接口）、串行限速。
//
// 默认关闭——沿用 keepalive「新排程不悄悄自启」的纪律：管理端 / 环境变量
// 显式打开。与每日 keepalive 的分工：那边做全量闭环（保活刷新+签到+余额+
// 解冻），这边只做「余额 + FEFO 快照 + 解冻」三件轻量活。
//
// 配置：data/balance-refresh.json（管理端可改）
//   { enabled: bool, minutes: 1-1440 }
// 环境变量：
//   DUMATE_BALANCE_REFRESH_MINUTES  默认间隔（无保存配置时生效），0 = 关
//   DUMATE_BALANCE_REFRESH=1        无保存配置时强制启用（部署即用，不进界面）
const accounts = require('./accounts');
const web = require('./dumate-web');
const expiringSnap = require('./expiring');
const balanceHist = require('./balance-hist');
const { readJSON, writeJSON } = require('./admin/store');
const keepalive = require('./keepalive');

const CONFIG_FILE = 'balance-refresh.json';
const DEFAULT_MINUTES = Math.max(0, parseInt(process.env.DUMATE_BALANCE_REFRESH_MINUTES || '10', 10) || 0);
// 串行间隔（读接口轻，比 keepalive 的 2s 短；仍不同一瞬间打满全部账号）
const PER_ACCOUNT_DELAY_MS = Math.max(0, parseInt(process.env.DUMATE_BALANCE_REFRESH_DELAY_MS || '800', 10) || 0);
// 启动后首轮的延迟：避开进程启动高峰（模型表预热等），也给上游一个安静窗口
const FIRST_RUN_DELAY_MS = 15000;

function loadConfig() {
  const saved = readJSON(CONFIG_FILE, null);
  if (saved && typeof saved === 'object') {
    return {
      enabled: !!saved.enabled,
      minutes: Number.isInteger(saved.minutes) && saved.minutes >= 0 && saved.minutes <= 1440
        ? saved.minutes : DEFAULT_MINUTES,
      saved: true,
    };
  }
  // 无保存配置：环境变量说了算（部署即用路径），一旦管理端保存过就以保存为准
  return { enabled: process.env.DUMATE_BALANCE_REFRESH === '1' && DEFAULT_MINUTES > 0, minutes: DEFAULT_MINUTES, saved: false };
}

function saveConfig() {
  writeJSON(CONFIG_FILE, {
    enabled: state.enabled,
    minutes: state.minutes,
    updated_at: Date.now(),
  });
}

const state = {
  ...loadConfig(),
  last_run_at: null,
  last_result: null,
  running: false,
};

let timer = null;
let firstTimer = null;

function sleep(ms) {
  return ms > 0 ? new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }) : Promise.resolve();
}

function schedule() {
  if (timer) { clearInterval(timer); timer = null; }
  if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
  if (!state.enabled || !(state.minutes > 0)) return;
  const every = state.minutes * 60000;
  // 首轮延后：进程刚起时 upstream 模型表预热、池恢复等一堆活，别抢同一窗口
  firstTimer = setTimeout(() => { runOnce('scheduled').catch(() => { /* 首轮失败等下一轮 */ }); }, FIRST_RUN_DELAY_MS);
  if (firstTimer.unref) firstTimer.unref();
  timer = setInterval(() => { runOnce('scheduled').catch(() => { /* 单轮失败不终止排程 */ }); }, every);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
}

/**
 * 逐账号收余额（串行限速）。io 注入供测试：list / quota / delay。
 * FEFO 口径与 admin/routes/accounts.js 的 /credits 一致：只算**剩余 >0**
 * 的额度包，取最早到期时刻；查不到的账号由调用方走 keepIds 保留旧条目。
 */
async function collect(opts = {}) {
  const all = opts.list ? opts.list() : accounts.load().accounts;
  const list = (all || []).filter((a) => a.enabled);
  const rows = [];
  for (const a of list) {
    if (rows.length) await sleep(opts.delay !== undefined ? opts.delay : PER_ACCOUNT_DELAY_MS);
    let r;
    try {
      r = opts.quota
        ? await opts.quota(a)
        : await web.api.quotaOverview(a.cookie, { agent: web.agentFor(a) });
    } catch (e) { r = { ok: false, error: e.message }; }

    let expireNearest = null;
    if (r.ok) {
      for (const p of (r.packages || [])) {
        if ((p.left || 0) > 0 && Number.isFinite(p.expire_at) && p.expire_at > 0) {
          if (expireNearest == null || p.expire_at < expireNearest) expireNearest = p.expire_at;
        }
      }
      // 只更新三个数字，保留 points 里的派生视图（expire_at/subscribed/
      // expiring 是 /credits 按包聚合的——整个覆盖等于把界面临期明细清空）
      try {
        const cur = accounts.getRaw ? accounts.getRaw(a.id) : null;
        const prev = cur && cur.points && typeof cur.points === 'object' ? cur.points : {};
        accounts.patchInternal(a.id, {
          points: { ...prev, left: r.left, total: r.total, used: r.used },
          points_at: Date.now(),
          last_error: '',
        });
      } catch (e) { /* 落盘失败不影响本轮 */ }
      try {
        balanceHist.observe({ account: String(a.id), channel: 'web', balance: r.left, source: 'balance-refresh' });
      } catch (e) { /* 流水失败不影响本轮 */ }
    } else {
      try { accounts.patchInternal(a.id, { last_error: String(r.error || '').slice(0, 200) }); } catch (e) { /* 同上 */ }
    }
    rows.push({
      id: a.id,
      name: accounts.displayName ? accounts.displayName(a) : (a.nickname || a.name || `账号 ${a.id}`),
      ok: !!r.ok,
      left: r.ok ? r.left : null,
      total: r.ok ? r.total : null,
      used: r.ok ? r.used : null,
      expireNearest,
      error: r.ok ? '' : String(r.error || ''),
    });
  }
  return rows;
}

/**
 * 跑一轮：收余额 → FEFO 快照 → 冷却解冻。
 * 解冻复用 keepalive 的 reconcile + pool 对接层（同一套「只解硬冷却、
 * 余额查不到不动」的语义，两处各写一份必然漂移）。
 * opts：{ list, quota, pool, delay, trigger }（前四个测试注入）。
 */
async function runOnce(trigger = 'manual', opts = {}) {
  if (state.running) return { skipped: 'already_running' };
  state.running = true;
  try {
    const rows = await collect(opts);
    const okRows = rows.filter((r) => r.ok);
    const failRows = rows.filter((r) => !r.ok);

    // FEFO 快照：成功的给 entries，失败的 keepIds 保留旧条目（「查不到」
    // 不等于「无临期」——写空会在一次网络抖动后把临期账号忘干净）
    const wrote = expiringSnap.update('dumate',
      okRows.filter((r) => r.expireNearest).map((r) => ({ accountId: r.id, nearest: r.expireNearest })),
      { keepIds: failRows.map((r) => r.id) });

    // 冷却解冻（keepalive.internals.reconcile：余额 > 阈值 ∩ 冷却中 → 只解硬冷却）
    let rec = { cooling_count: 0, unfrozen: [], below_threshold: [], revive_failed: [] };
    try {
      const poolMod = require('./pool');
      const poolApi = keepalive.internals.normalizePool(opts.pool !== undefined ? opts.pool : poolMod.pool);
      if (poolApi.mode === 'pool') {
        rec = keepalive.internals.reconcile(
          poolApi,
          rows.map((r) => ({ uid: String(r.id), ok: r.ok, remain: r.left })),
          { balance_threshold: 0 },
        );
      }
    } catch (e) { rec.revive_failed = [{ error: e.message }]; }

    state.last_run_at = Date.now();
    state.last_result = {
      trigger,
      accounts: rows.length,
      ok_count: okRows.length,
      fail_count: failRows.length,
      fefo_wrote: wrote,
      unfrozen_count: rec.unfrozen.length,
      unfrozen: rec.unfrozen,
      cooling_count: rec.cooling_count,
      revive_failed: rec.revive_failed,
      rows,
    };
    try {
      require('./admin/auth').audit('system', 'balance_refresh', '',
        `${trigger}: ${okRows.length}/${rows.length}，FEFO${wrote ? '已更新' : '未写'}，解冻 ${rec.unfrozen.length}`);
    } catch (e) { /* 审计不可用不阻塞 */ }
    return state.last_result;
  } finally {
    state.running = false;
  }
}

function snapshot() {
  return {
    enabled: state.enabled,
    minutes: state.minutes,
    last_run_at: state.last_run_at,
    last_result: state.last_result,
    running: state.running,
    interval_active: !!timer,
    note: state.enabled
      ? `每 ${state.minutes} 分钟轻量刷新网页池余额（纯读接口），FEFO 快照随行更新，余额恢复的硬冷却账号自动解冻`
      : '低频余额刷新未启用——FEFO 快照只在管理端打开相关页面时更新，解冻等每日 keepalive',
  };
}

function intIn(patch, key, min, max) {
  const v = parseInt(patch[key], 10);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${key} 需为 ${min}-${max} 的整数`);
  return v;
}

function configure(patch = {}) {
  if (patch.enabled !== undefined) state.enabled = !!patch.enabled;
  if (patch.minutes !== undefined) state.minutes = intIn(patch, 'minutes', 0, 1440);
  schedule();
  saveConfig();
  return snapshot();
}

module.exports = {
  schedule, stop, runOnce, snapshot, configure, state,
  internals: { collect, loadConfig, PER_ACCOUNT_DELAY_MS, FIRST_RUN_DELAY_MS },
};
