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
  // Qoder 轮转探活游标（P1-8）。进程内即弃：重启后从 0 号开始重扫一遍，
  // 一轮之后自然恢复覆盖（N 个账号 N 轮全覆盖，不依赖持久化）
  qoderCursor: 0,
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
 * 直连通道的余额扫描（2026-11-08 补）：
 * WorkBuddy 的 FEFO 快照（`expiring.js`）与额度护栏快照
 * （`workbuddy/credits-snapshot.js`）都只有 **6 小时 TTL**，而写方原来只有
 * 管理端 `/credits`。运维不点开页面时快照一过 TTL 就静默失效——真机上
 * 实测 workbuddy 段的 `at` 已经停了 100+ 小时，护栏快照文件压根没被创建过。
 *
 * 接进本模块而不是再起一个定时器：这里本来就是「低频、轻量、串行限速」
 * 的余额巡检；多一个 10 分钟级的定时器只会让上游看到更密的节奏。
 *
 * 口径全部复用 `keepalive` 的 workbuddy adapter（`balance` 取数 +
 * `persistSnapshots` 落盘），**不在这里重写**——两处各写一份必然漂移
 * （本仓库已经因为这类复制吃过「文档说做了、代码里没有」的亏）。
 *
 * @returns {object|null} null = 通道未启用 / 无可用账号
 */
async function collectWorkbuddy(opts = {}) {
  let ad;
  try {
    ad = opts.adapter || keepalive.internals
      .builtinAdapters().find((a) => a.channel === 'workbuddy');
  } catch (e) { ad = null; }
  if (!ad || typeof ad.persistSnapshots !== 'function') return null;

  let list;
  try { list = ad.list() || []; } catch (e) { return null; }
  if (!list.length) return null;

  const delay = opts.delay !== undefined ? opts.delay : PER_ACCOUNT_DELAY_MS;
  const rows = [];
  for (const a of list) {
    if (rows.length) await sleep(delay);
    let b;
    try {
      b = opts.balanceOf ? await opts.balanceOf(a) : await ad.balance(a);
    } catch (e) { b = { ok: false, error: e.message }; }
    rows.push({
      channel: 'workbuddy',
      accountId: a.id != null ? a.id : null,
      uid: ad.uid(a),
      name: ad.name(a),
      ok: !!(b && b.ok),
      remain: b && Number.isFinite(b.remain) ? b.remain : null,
      precise: b && Number.isFinite(b.precise) ? b.precise : null,
      expireNearest: b && Number.isFinite(b.expireNearest) ? b.expireNearest : null,
      error: (b && b.error) || '',
    });
  }
  const okCount = rows.filter((r) => r.ok).length;
  // 全失败的轮次照样调 persistSnapshots：它内部会把失败账号走 keepIds，
  // **at 不推进** —— 这是「部分数据是旧的，不能让快照看起来新鲜」的语义，
  // 在这里跳过调用反而是另一种错（旧条目该保留的还是要保留）。
  const out = ad.persistSnapshots(rows);
  return {
    accounts: rows.length,
    ok_count: okCount,
    fail_count: rows.length - okCount,
    ...out,
    rows,
  };
}

/**
 * Qoder 的余额轮转探活（P1-8，docs/QODER-GATEWAY-FEATURE-MERGE.md）。
 *
 * 出处：EchoPing07「轮转探活」——后台每轮探测**一个**账号的额度，N 个账号
 * 最多 N 轮全部刷新，上游调用恒约 1 次/轮；workbuddy panel 的
 * 「冷却账号余额恢复自动解冻」同一思路。
 *
 * **要补的真缺口**：`channelPool.noteCredits` 早就存在（`pool.creditFloor`
 * 的接线点），但 Qoder 从来没往里写——于是 `DUMATE_POOL_CREDIT_FLOOR`
 * 保底护栏对 Qoder **完全无效**（`floor_blocked` 恒 false），账号明明耗到
 * 只剩个位数积分却仍在接流量，每次请求都是注定 402/挂起的浪费。
 *
 * **为什么是轮转而不是全量**：Qoder 的额度接口是 `/api/v2/quota/usage`，
 * 每号一次上游往返；账号多了全量扫会形成明显的机器节奏（hub 风控文档里
 * 「轮转探活」正是为这个）。所以每轮只探一个，按 id 升序循环。
 *
 * **回归口径**：`credits == null` 一律不写（查不到 ≠ 0，写 0 会让保底线
 * 永久拦住该账号）。这条纪律在 noteCredits 里也有，这里是第二道。
 *
 * @param {object} opts 测试注入：list / quota / delay / cursor
 * @returns {object|null} null = 通道未启用或无可用账号
 */
async function collectQoder(opts = {}) {
  let authStore;
  let session;
  try {
    authStore = require('./qoder/auth');
    session = require('./qoder/session');
  } catch (e) { return null; }
  let list;
  try { list = opts.list ? opts.list() : authStore.findUsable(); } catch (e) { return null; }
  list = (list || []).filter((a) => a && a.enabled !== false);
  if (!list.length) return null;

  // 轮转游标（进程内）：按 id 排序后取下一个，保证「N 个账号 N 轮全覆盖」
  const sorted = [...list].sort((a, b) => Number(a.id) - Number(b.id));
  const idx = Number.isInteger(opts.cursor) ? (opts.cursor % sorted.length + sorted.length) % sorted.length
    : (state.qoderCursor % sorted.length);
  const a = sorted[idx];
  state.qoderCursor = (idx + 1) % sorted.length;

  let agent = null;
  try { agent = require('./proxy-agent').getAgentFor(a); } catch (e) {
    return { probed: 0, cursor: state.qoderCursor, account: null, error: `出站代理配置错误: ${e.message}` };
  }
  let q;
  try {
    q = opts.quota
      ? await opts.quota(a)
      : await session.fetchQuota(a.accessToken, a.region, { agent });
  } catch (e) { q = { ok: false, error: e.message }; }

  const name = a.nickname || a.uid || `账号 ${a.id}`;
  // 有效余额 = 签到积分 + 套餐内（团队号的共享池单列，**不与前面相加**——
  // 口径见 session.fetchQuota：orgResourcePackage 是「团队池」，个人号没有）
  const addOn = q && q.ok && q.addOnQuota ? Number(q.addOnQuota.remaining) : null;
  const user = q && q.ok && q.userQuota ? Number(q.userQuota.remaining) : null;
  const total = (addOn != null && user != null) ? addOn + user
    : (addOn != null ? addOn : user);
  let wrote = false;
  if (q && q.ok && total != null && Number.isFinite(total)) {
    // 写进池：这是 `DUMATE_POOL_CREDIT_FLOOR` 对 Qoder 生效的唯一途径
    try { wrote = require('./channel-pool').noteCredits('qoder', a.id, total); } catch (e) { wrote = false; }
  }
  return {
    probed: q && q.ok ? 1 : 0,
    cursor: state.qoderCursor,
    accounts: sorted.length,
    account: {
      id: a.id,
      name,
      region: a.region,
      ok: !!(q && q.ok),
      addOn,
      user,
      total: Number.isFinite(total) ? total : null,
      wrote,
      error: q && q.ok ? '' : String((q && q.error) || '额度查询失败'),
    },
  };
}

/**
 * 跑一轮：收余额 → FEFO 快照 → 冷却解冻；再顺带扫一遍直连通道（WorkBuddy + Qoder）。
 * 解冻复用 keepalive 的 reconcile + pool 对接层（同一套「只解硬冷却、
 * 余额查不到不动」的语义，两处各写一份必然漂移）。
 * opts：{ list, quota, pool, delay, trigger, workbuddy }（前四个测试注入；
 * workbuddy 是直连通道段的注入点，null = 跳过，便于老用例逐字节不变）
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

    // 直连通道（WorkBuddy）：失败不拖累主通道结果，单独一段回执
    let wb = null;
    if (opts.workbuddy !== null) {
      try { wb = await collectWorkbuddy({ ...opts.workbuddy, delay: opts.delay }); } catch (e) {
        wb = { error: e.message };
      }
    }

    // 直连通道（Qoder）轮转探活（P1-8）：每轮只探一个账号，写池余额让
    // `DUMATE_POOL_CREDIT_FLOOR` 保底护栏真正生效。失败不拖累主通道结果。
    let qd = null;
    if (opts.qoder !== null) {
      try { qd = await collectQoder({ ...opts.qoder, delay: opts.delay }); } catch (e) {
        qd = { error: e.message };
      }
    }

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
      workbuddy: wb,
      qoder: qd,
      rows,
    };
    const wbNote = wb
      ? `；WorkBuddy ${wb.ok_count ?? '?'}/${wb.accounts ?? '?'}，FEFO${wb.fefoWrote ? '已更新' : '未写'}`
      : '';
    // Qoder 只探一个号，回执写成「探了谁、余额多少、有没有写进池」
    const qdNote = qd && qd.account
      ? `；Qoder 探 ${qd.account.name}（${qd.account.ok ? `余额 ${qd.account.total ?? '—'}${qd.account.wrote ? ' 已写池' : ''}` : qd.account.error}）`
      : '';
    try {
      require('./admin/auth').audit('system', 'balance_refresh', '',
        `${trigger}: ${okRows.length}/${rows.length}，FEFO${wrote ? '已更新' : '未写'}，解冻 ${rec.unfrozen.length}${wbNote}${qdNote}`);
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
      ? `每 ${state.minutes} 分钟轻量刷新余额（纯读接口）：搭子网页池 + WorkBuddy + Qoder（轮转，每轮一个号）。`
        + 'FEFO 快照与额度护栏快照随行更新（两者 TTL 都是 6 小时，不刷新就会静默失效），'
        + '余额恢复的硬冷却账号自动解冻'
      : '低频余额刷新未启用——FEFO 与护栏快照只在管理端打开相关页面时更新'
        + '（TTL 6 小时，超时后 FEFO 退回普通轮询、护栏自动失效），解冻等每日 keepalive。'
        + 'WorkBuddy 每日 keepalive 会顺手写一次，但仍只覆盖 6 小时；'
        + 'Qoder 的余额快照此时只有管理端点「额度」页会写（保底护栏对 Qoder 期间不生效）',
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
  // collectWorkbuddy / collectQoder 一并导出：直连通道段的行为（串行、一次落盘、
  // 轮转游标、失败计数）必须有单测能直接打，否则只能靠「跑一天看看快照新不新」验证
  internals: { collect, collectWorkbuddy, collectQoder, loadConfig, PER_ACCOUNT_DELAY_MS, FIRST_RUN_DELAY_MS },
};
