// src/points-usage-cache.js - 搭子积分账单的预热缓存（批次二十「统计预热」）
//
// /overview 的「积分消耗」必须逐网页账号问上游（usageRecords page=1 limit=1，
// 缺参数上游报参数错误），账号一多页面加载就是一串上游往返。这里把这笔开销
// 挪出请求路径：
//   1. keepalive runOnce 的空闲收尾预热（每日一轮，fire-and-forget）；
//   2. /overview 命中新鲜缓存直接回，陈旧则现算并**后台预热**（先回账再暖，
//      下一次刷新就是热的）。
// 落盘 data/points-usage-cache.json（store.writeJSON 原子写）：管理端重启不用
// 重新冷启动，keepalive 与 /overview 两个调用方共享同一份。
//
// 新鲜度按两部分独立判定（查询窗口不同，不能共用一个时间戳）：
//   - 窗口账单（days 天合计 + 各账号明细）：window.at 距今 ≤ TTL
//   - 今日实付：today.at 距今 ≤ TTL
// TTL 默认 30 分钟（DUMATE_POINTS_USAGE_CACHE_TTL_MS 覆盖）。缓存数字**必须
// 带时间出仓**（/overview 响应的 points_cache.cached_at，前端标注「缓存于
// HH:mm」）——账单缓存与实时混着看却不标时间，读的人无从判断数字新旧。
//
// 与 routes/usage.js 的分工：计算逻辑**只有一份**（本文件的 computeWindow /
// computeToday，与原 pointsUsage/pointsTodayUsage 逐行同义）；usage.js 的同名
// 导出改为委托到这里——第二份实现必然漂移（与「凭证退场口径只有一处」同一纪律）。
const accounts = require('./accounts');
const web = require('./dumate-web');
const store = require('./admin/store');

const FILE_NAME = 'points-usage-cache.json';
const DEFAULT_TTL_MS = Math.max(
  60000,
  parseInt(process.env.DUMATE_POINTS_USAGE_CACHE_TTL_MS || '', 10) || 30 * 60000,
);

function create(opts = {}) {
  const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS;
  const now = opts.now || Date.now;
  // 上游查询可注入（测试打桩）；生产走 web.api.usageRecords，代理按账号配置
  const fetchRecords = opts.fetchRecords || ((a, q) => web.api.usageRecords(a.cookie, { ...q, agent: web.agentFor(a) }));
  // 出站代理解析也可注入（账号配置非法时的错误行形状要与原实现一致）
  const agentFor = opts.agentFor || ((a) => web.agentFor(a));

  let mem = null; // { windows: { [days]: {at, total_consumed, total_records, accounts} }, today: {at, consumed, records} }

  function load() {
    if (mem) return mem;
    mem = { windows: {}, today: null };
    const disk = store.readJSON(FILE_NAME);
    if (disk && typeof disk === 'object') {
      if (disk.windows && typeof disk.windows === 'object') mem.windows = disk.windows;
      if (disk.today && typeof disk.today === 'object') mem.today = disk.today;
    }
    return mem;
  }

  function save() {
    try { store.writeJSON(FILE_NAME, { version: 1, ...mem }); } catch (e) { /* 落盘失败下次再试，内存里仍在 */ }
  }

  function fresh(at) {
    return Number.isFinite(at) && now() - at <= ttlMs;
  }

  /** days 天窗口账单：合计 + 各账号明细（含失败账号的错误行，不补 0）。 */
  async function computeWindow(days) {
    const nowSec = Math.floor(now() / 1000);
    const start = nowSec - days * 86400;
    const list = accounts.load().accounts.filter((a) => a.enabled);
    const perAccount = [];
    let total = 0;
    let count = 0;
    for (const a of list) {
      let agent;
      try { agent = agentFor(a); } catch (e) {
        perAccount.push({ id: a.id, name: accounts.displayName(a), ok: false, error: e.message });
        continue;
      }
      // limit=1 就够：只要 totalCount 与 consumedPoints 两个汇总字段
      const r = await fetchRecords(a, { startAt: start, endAt: nowSec, page: 1, limit: 1, agent });
      if (!r.ok) {
        perAccount.push({ id: a.id, name: accounts.displayName(a), ok: false, error: r.error });
        continue;
      }
      const consumed = Number(r.consumed_points || 0);
      const cnt = Number(r.total_count || 0);
      total += consumed;
      count += cnt;
      perAccount.push({ id: a.id, name: accounts.displayName(a), ok: true, consumed_points: consumed, count: cnt });
    }
    return {
      at: now(),
      total_consumed: Math.round(total * 100) / 100,
      total_records: count,
      accounts: perAccount,
    };
  }

  /** 今日实付（窗口不同，单独取）。 */
  async function computeToday() {
    const nowSec = Math.floor(now() / 1000);
    const start = Math.floor(new Date(now()).setHours(0, 0, 0, 0) / 1000);
    const list = accounts.load().accounts.filter((a) => a.enabled);
    let total = 0;
    let count = 0;
    for (const a of list) {
      let agent = null;
      try { agent = agentFor(a); } catch (e) { continue; }
      const r = await fetchRecords(a, { startAt: start, endAt: nowSec, page: 1, limit: 1, agent });
      if (r.ok) {
        total += Number(r.consumed_points || 0);
        count += Number(r.total_count || 0);
      }
    }
    return { at: now(), consumed: Math.round(total * 100) / 100, records: count };
  }

  /** 预热：窗口账单 + 今日实付都算一遍并落盘。失败上抛（调用方决定要不要吞）。 */
  async function refresh(days = 30) {
    const d = Math.max(1, Math.min(90, parseInt(days, 10) || 30));
    const m = load();
    // 串行而不是并行：上游对同一账号的查询没有并发必要，两段都是逐账号串行
    m.windows[d] = await computeWindow(d);
    m.today = await computeToday();
    save();
    return m;
  }

  /** 出仓视图：window/today 各带 at 与 fresh。没有的窗口如实 null（不拿别的窗口顶）。 */
  function view(days = 30) {
    const m = load();
    const d = Math.max(1, Math.min(90, parseInt(days, 10) || 30));
    const w = m.windows[d] || null;
    return {
      window: w ? { ...w, fresh: fresh(w.at) } : null,
      today: m.today ? { ...m.today, fresh: fresh(m.today.at) } : null,
      ttl_ms: ttlMs,
    };
  }

  /** 后台预热（fire-and-forget，错误吞掉只留 stderr）。 */
  function warm(days = 30) {
    refresh(days).catch((e) => {
      try { process.stderr.write(`[points-usage-cache] 预热失败: ${e.message}\n`); } catch (_) { /* stderr 也没了 */ }
    });
  }

  /** 测试用：清内存态（下次 view 从盘上重读）。 */
  function dispose() { mem = null; }

  return { refresh, view, warm, dispose, computeWindow, computeToday, ttlMs };
}

// ---- 模块级共享实例（生产路径） ----
let sharedInst = null;
function shared() {
  if (!sharedInst) sharedInst = create();
  return sharedInst;
}

module.exports = {
  create,
  FILE_NAME,
  DEFAULT_TTL_MS,
  view: (days) => shared().view(days),
  refresh: (days) => shared().refresh(days),
  warm: (days) => shared().warm(days),
  computeWindow: (days) => shared().computeWindow(days),
  computeToday: () => shared().computeToday(),
};
