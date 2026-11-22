// src/qoder/autocheckin.js - Qoder 自动签到排程（P0-1）
//
// 出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P0-1「签到自动排程（三态结果 +
// 抖动防惊群 + 失败退避）」。
//
// **为什么这个比 WorkBuddy 的更急**：Qoder 的额度为 0 时**聊天会挂起而不是报错**
// （见 session.fetchQuota 注释）。忘了签到 = 通道直接不可用，用户看到的是
// 「点了半天没反应」。而签到是每天 100 积分、必须当天领——漏一天就少一天，
// 且 grants 账本「从功能启用时开始记」，漏签会让过期提醒随之失真。
//
// 时点取 **10:15**，不是 00:00：上游活动是 `Daily reset: 10:00 (UTC+8)`
// （session.checkinStatus 实测推导，与本项目记载一致），00:00 去签会撞上
// 「昨天的活动已领、今天的还没开始」这一格，三态里全是 already/skipped。
// 15 分钟余量给上游刷新留窗口（EchoPing07 同取 10:15）。
//
// 五条口径（放宽任何一条都会变成「白打上游」或「白掉一天积分」）：
//   1. **开关默认关**，落盘持久化；打开时立即检查全部账号（点了就想看结果）。
//   2. 时点 + **只后延**的随机抖动（0~jitter 分钟，整池齐发是机器特征）。
//   3. 签到前**先查状态**（/campaigns 是只读 GET）：已签跳过、**状态未知不签**
//      （不拿盲签去赌——盲签失败会污染 lastError，也在风控画像上白记一笔）。
//   4. 失败**当日退避 30 分钟**再试一次，跨日重置；`skipped`（当天没有可领活动）
//      **有意不重试**——那不是失败。
//   5. 签成写统一签到账本（channel='qoder'），失败如实进 last_result 不伪造。
//
// 进程归属：**管理端进程**（9083），与 workbuddy/autocheckin、autotask、
// balance-refresh、keepalive 同一处。理由与 WorkBuddy 那条完全一样：
// 账号存储是文件 + 文件锁的跨进程共享（auth.exchange 自带 refreshGuard），
// 管理端同样能换票；两个进程各排一份会把上游请求翻倍。
const authStore = require('./auth');
const session = require('./session');
const c = require('./constants');
const ledger = require('../checkin-ledger');
const { readJSON, writeJSON } = require('../admin/store');

const CONFIG_FILE = 'qoder-autocheckin.json';
// 10:15 上游刷新（10:00 UTC+8）后 15 分钟；两个 env 都要设才生效（与
// DUMATE_AUTO_CHECKIN_HOUR/_MINUTE 同一约定，避免「只设 HOUR 静默不生效」）
const DEFAULT_HOUR = parseInt(process.env.DUMATE_QODER_CHECKIN_HOUR || '10', 10);
const DEFAULT_MINUTE = parseInt(process.env.DUMATE_QODER_CHECKIN_MINUTE || '15', 10);
const DEFAULT_JITTER_MINUTES = 10;   // 0~10 分钟随机后延
const PER_ACCOUNT_DELAY_MS = 2500;   // 账号间串行间隔（签到链路每次 2~3 次上游往返）
const RETRY_BACKOFF_MS = 30 * 60 * 1000; // 失败当日退避 30 分钟再试

const DEFAULTS = {
  enabled: false,
  hour: Number.isInteger(DEFAULT_HOUR) && DEFAULT_HOUR >= 0 && DEFAULT_HOUR <= 23 ? DEFAULT_HOUR : 10,
  minute: Number.isInteger(DEFAULT_MINUTE) && DEFAULT_MINUTE >= 0 && DEFAULT_MINUTE <= 59 ? DEFAULT_MINUTE : 15,
  jitter_minutes: DEFAULT_JITTER_MINUTES,
  // 国际版没有签到活动（campaigns 只在 cn 有），但**不默认跳过**：如实去查一次，
  // 查空按 skipped 记（不重试）。真没活动时一轮只有 1 次 GET/号，成本极低。
  include_intl: false,
};

function loadConfig() {
  const saved = readJSON(CONFIG_FILE, null) || {};
  const cfg = { ...DEFAULTS };
  if (Number.isInteger(saved.hour) && saved.hour >= 0 && saved.hour <= 23) cfg.hour = saved.hour;
  if (Number.isInteger(saved.minute) && saved.minute >= 0 && saved.minute <= 59) cfg.minute = saved.minute;
  if (Number.isInteger(saved.jitter_minutes) && saved.jitter_minutes >= 0 && saved.jitter_minutes <= 120) {
    cfg.jitter_minutes = saved.jitter_minutes;
  }
  cfg.enabled = !!saved.enabled;
  cfg.include_intl = !!saved.include_intl;
  return cfg;
}

function saveConfig() {
  writeJSON(CONFIG_FILE, {
    enabled: state.enabled,
    hour: state.hour,
    minute: state.minute,
    jitter_minutes: state.jitter_minutes,
    include_intl: state.include_intl,
    updated_at: Date.now(),
  });
}

const state = {
  ...loadConfig(),
  last_run_at: null,
  last_result: null,
  next_run_at: null,
  running: false,
  // 当日失败时刻（accountId → ts）。**进程内即弃**：退避窗口只有 30 分钟，
  // 重启后重试一次是无害的（签到本身幂等，已签会被状态查询挡住）
  failures: {},
};

let timer = null;
let abortFlag = false;

const sleep = (ms) => new Promise((r) => {
  const t = setTimeout(r, Math.max(0, ms));
  if (t.unref) t.unref();
});

// ── 纯函数（离线可测）────────────────────────────────────────────────────

/**
 * 下一次触发时刻 = 今天（或明天）的 hour:minute + [0, jitter) 随机后延。
 * 后延**只往后加**：提前会爬出「刷新后」窗口，可能落进昨天那一格。
 */
function computeNextRunAt(now, cfg, rng = Math.random) {
  const base = new Date(now);
  base.setHours(cfg.hour, cfg.minute, 0, 0);
  let at = base.getTime();
  if (at <= now) at += 24 * 60 * 60 * 1000;
  const jitterMs = Math.max(0, cfg.jitter_minutes || 0) * 60 * 1000;
  if (jitterMs > 0) at += Math.floor(rng() * jitterMs);
  return at;
}

/**
 * 补跑判据：今天时点已过 && 今天没跑过。
 * 「恰好等于时点」要补——computeNextRunAt 的 `at <= now` 分支会把排程翻到明天，
 * 两者只允许一处承接这一格。
 */
function shouldCatchup(now, cfg, lastRunAt) {
  if (!cfg || !cfg.enabled) return false;
  const point = new Date(now);
  point.setHours(cfg.hour, cfg.minute, 0, 0);
  if (point.getTime() > now) return false;
  if (lastRunAt) {
    const last = new Date(lastRunAt);
    if (last.getFullYear() === point.getFullYear()
      && last.getMonth() === point.getMonth()
      && last.getDate() === point.getDate()) return false;
  }
  return true;
}

/**
 * 单账号的签到决定（纯函数，**只判不动作**）：
 *   already   今日已签（claimable=0 且已有 CLAIMED 活动）
 *   claim     有可领活动
 *   skipped   一个活动都没有（当天无可领，**有意不重试**）
 *   unknown   状态查询失败 —— **不签**（未知状态不自动签）
 *
 * 判据来源是 `session.checkinStatus` 的返回（只读 /campaigns）：
 *   checkedIn === true  → already
 *   checkedIn === false → claim（pending 有值）
 *   checkedIn === null  → campaigns === 0 ? skipped : unknown
 */
function decideCheckin(status) {
  if (!status || !status.ok) return 'unknown';
  if (status.checkedIn === true) return 'already';
  if (status.checkedIn === false) return 'claim';
  // checkedIn=null：上游没给任何活动（campaigns=0）才是 skipped，
  // 有活动却判不出状态属于 unknown——不猜
  if (status.campaigns === 0) return 'skipped';
  return 'unknown';
}

/**
 * 失败退避判据（纯函数）：同一账号同一自然日内，距上次失败不足 backoffMs
 * 就跳过。跨日重置——昨天的失败不该挡住今天的重试。
 */
function withinBackoff(failedAt, now, backoffMs = RETRY_BACKOFF_MS) {
  if (!failedAt) return false;
  const a = new Date(failedAt);
  const b = new Date(now);
  if (a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate()) return false;
  return now - failedAt < backoffMs;
}

// ── 排程 ────────────────────────────────────────────────────────────────

function armAt(atMs) {
  state.next_run_at = atMs;
  timer = setTimeout(async () => {
    try { await runOnce('scheduled'); } catch (e) { /* 一轮失败不终止排程 */ }
    schedule();
  }, Math.max(250, atMs - Date.now()));
  if (timer.unref) timer.unref();
}

function schedule() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!state.enabled) { state.next_run_at = null; return; }
  armAt(computeNextRunAt(Date.now(), state));
  // 补跑：进程没在跑时今天的时点照样会过去，重启后不补就白掉一天。
  // 幂等由「先查状态、已签跳过」兜底，跑过了就是空转一轮。
  if (shouldCatchup(Date.now(), state, state.last_run_at)) {
    runOnce('catchup').catch(() => { /* 补跑失败明天照常 */ });
  }
}

/** 停排程 + 让进行中的一轮在下一个账号边界收尾 */
function stop() {
  if (timer) { clearTimeout(timer); timer = null; }
  state.next_run_at = null;
  abortFlag = true;
}

// ── 一轮 ────────────────────────────────────────────────────────────────

/**
 * 跑一轮签到。
 *
 * @param {string} trigger 'scheduled' | 'catchup' | 'manual' | 'enable'
 * @param {object} [opts] 测试/管理端注入
 *   accounts      账号数组（默认 authStore.findUsable()）
 *   statusOf      (account) => Promise<checkinStatus 形状>
 *   claimOf       (account) => Promise<session.checkin 形状>
 *   authStore     账号存储（默认 ./auth）
 *   perAccountDelayMs 账号间间隔（测试传 0）
 *   region        只处理该区域（'' = 不限，按 include_intl 决定是否含国际）
 *   failedAtOf    (accountId) => 上次失败时刻（默认读 state.failures）
 *   now           注入当前时刻（退避判据可测）
 */
async function runOnce(trigger = 'manual', opts = {}) {
  if (state.running) return { skipped: 'already_running' };
  state.running = true;
  abortFlag = false;
  const startedAt = Date.now();
  const now = Number(opts.now) || startedAt;
  const store = opts.authStore || authStore;
  const delayMs = opts.perAccountDelayMs !== undefined ? opts.perAccountDelayMs : PER_ACCOUNT_DELAY_MS;
  const statusOf = opts.statusOf || (async (a) => session.checkinStatus(a.accessToken, a.region, { agent: agentOfSafe(a) }));
  // 默认走 index 的 checkinAndSave：它会换票、写 grants 账本与签到账本
  // （管理端点同一条路，见 admin/routes/qoder.js 的 /checkin）
  const claimOf = opts.claimOf || ((a) => require('./index').checkin(a));
  try {
    let list = Array.isArray(opts.accounts) ? opts.accounts : store.findUsable();
    if (opts.region) {
      const want = c.normalizeRegion(opts.region);
      list = list.filter((a) => c.normalizeRegion(a.region) === want);
    } else if (!state.include_intl) {
      // 国际版默认不进队列：campaigns 端点只在 cn 有活动
      list = list.filter((a) => c.normalizeRegion(a.region) === 'cn');
    }
    const results = [];
    for (let i = 0; i < list.length; i++) {
      if (abortFlag) break;
      if (i > 0) await sleep(delayMs);
      if (abortFlag) break;
      const raw = list[i];
      const name = raw.nickname || raw.uid || `账号 ${raw.id}`;
      const region = c.normalizeRegion(raw.region);
      // 当日失败退避：同一自然日内失败过一次，等满 30 分钟再试
      const failedAt = opts.failedAtOf
        ? opts.failedAtOf(raw.id)
        : (state.failures[raw.id] || 0);
      if (withinBackoff(failedAt, now)) {
        results.push({
          id: raw.id, name, region, ok: true, action: 'backoff', already: false,
          error: '', note: '今日已失败过，30 分钟退避中',
        });
        continue;
      }
      let a = raw;
      // **先换票再查状态**：管理端与排程拿的都是落盘对象，device_token 过期后
      // /campaigns 必然 401，界面/日志表现为「状态查询失败」而账号其实完全正常。
      // 换票失败如实落到该账号那一行（不静默当成「未知状态」）。
      const refreshOf = opts.refreshOf || ((acc) => session.ensureAccount(store, acc));
      let refreshError = '';
      try { a = (await refreshOf(raw)) || raw; } catch (e) { a = raw; refreshError = e.message; }
      if (refreshError) {
        state.failures[raw.id] = now;
        results.push({
          id: raw.id, name, region, ok: false, action: 'refresh', already: false,
          error: `换票失败: ${refreshError}`,
        });
        continue;
      }
      let st;
      try { st = await statusOf(a); } catch (e) { st = { ok: false, error: e.message }; }
      const decision = decideCheckin(st);
      if (decision !== 'claim') {
        // unknown 不算「失败」但必须能看见（它是「没做事」而不是「做成了」）
        results.push({
          id: raw.id, name, region,
          ok: decision !== 'unknown',
          action: decision,
          already: decision === 'already',
          pending: st && st.pending != null ? st.pending : null,
          error: decision === 'unknown' ? String((st && st.error) || '签到状态查询失败（未知状态不自动签）') : '',
        });
        if (decision === 'unknown') state.failures[raw.id] = now;
        continue;
      }
      let r;
      try { r = await claimOf(a); } catch (e) { r = { ok: false, error: e.message, claimed: [] }; }
      const got = !!(r && r.ok && ((r.claimed || []).some((x) => x.ok) || r.gained > 0));
      if (got) {
        delete state.failures[raw.id];
        // 统一签到账本：index.checkinAndSave 已写（channel='qoder'）。
        // 这里只在**注入的 claimOf**（测试或自定义实现）时补写，避免双写——
        // 账本按 channel+账号+日期幂等，双写零伤害，但没必要。
        if (opts.claimOf) {
          try {
            ledger.append({
              channel: 'qoder', account_id: raw.id, account: name,
              at: Date.now(), credits: r && r.gained != null ? r.gained : null, source: trigger,
            });
          } catch (e) { /* 记账失败不影响签到 */ }
        }
      } else if (r && r.ok && r.alreadyChecked) {
        // 状态说可领、领取时又变成已签（并发/上游即时回填）：不是失败
        results.push({
          id: raw.id, name, region, ok: true, action: 'already', already: true,
          error: '', note: '领取时已无可领活动（视为今日已签）',
        });
        continue;
      } else {
        state.failures[raw.id] = now;
      }
      results.push({
        id: raw.id, name, region,
        ok: got,
        action: 'claim',
        already: false,
        gained: r && r.gained != null ? r.gained : null,
        claimed: (r && r.claimed ? r.claimed.filter((x) => x.ok).length : 0),
        error: got ? '' : String((r && r.error) || '签到失败'),
      });
    }
    state.last_run_at = Date.now();
    const claimed = results.filter((r) => r.ok && r.action === 'claim').length;
    state.last_result = {
      trigger,
      started_at: startedAt,
      duration_ms: state.last_run_at - startedAt,
      aborted: abortFlag,
      region: opts.region ? c.normalizeRegion(opts.region) : 'cn',
      accounts: results.length,
      claimed,
      already: results.filter((r) => r.action === 'already').length,
      skipped: results.filter((r) => r.action === 'skipped').length,
      unknown: results.filter((r) => r.action === 'unknown').length,
      backoff: results.filter((r) => r.action === 'backoff').length,
      // failed 只数**真失败**（领取失败 / 换票失败）。unknown 是「没做事」，
      // 单列在 unknown 里——把它算进 failed 会让「上游查不到状态」看起来像
      // 「签到被打挂了」，而两者该做的事完全不同。
      failed: results.filter((r) => !r.ok && r.action !== 'unknown').length,
      gained: Number(results.reduce((s, r) => s + (Number(r.gained) || 0), 0).toFixed(4)),
      results,
    };
    try {
      require('../admin/auth').audit('system', 'qoder_autocheckin', '',
        `${trigger}: 签成 ${claimed} / 已签 ${state.last_result.already} / 失败 ${state.last_result.failed}`
        + (state.last_result.backoff ? ` / 退避 ${state.last_result.backoff}` : ''));
    } catch (e) { /* 审计不可用不阻塞结果 */ }
    return state.last_result;
  } finally {
    state.running = false;
    abortFlag = false;
  }
}

function agentOfSafe(a) {
  try { return require('../proxy-agent').getAgentFor(a); } catch (e) { return null; }
}

// ── 配置 ────────────────────────────────────────────────────────────────

function snapshot() {
  return {
    enabled: state.enabled,
    hour: state.hour,
    minute: state.minute,
    jitter_minutes: state.jitter_minutes,
    include_intl: state.include_intl,
    per_account_delay_ms: PER_ACCOUNT_DELAY_MS,
    retry_backoff_ms: RETRY_BACKOFF_MS,
    last_run_at: state.last_run_at,
    last_result: state.last_result,
    next_run_at: state.next_run_at,
    running: state.running,
    rationale: [
      'Qoder 零额度时聊天会挂起而不是报错——漏签 = 通道不可用，所以有排程',
      `每日 ${state.hour}:${String(state.minute).padStart(2, '0')} + 0~${state.jitter_minutes} 分钟随机后延（只后延不提前）`,
      '时点选 10:15 是因为上游活动 10:00（UTC+8）刷新，00:00 去签会撞在昨天的格子里',
      '签到前先查状态（只读 /campaigns）：已签跳过、未知状态不签（不拿盲签去赌）',
      `失败当日退避 ${Math.round(RETRY_BACKOFF_MS / 60000)} 分钟再试一次；跨日重置`,
      '排程在管理端进程，避免网关与管理端各排一份把上游请求翻倍',
    ],
  };
}

function intIn(patch, key, min, max) {
  const v = parseInt(patch[key], 10);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${key} 需为 ${min}-${max} 的整数`);
  return v;
}

/**
 * 改配置。**打开开关时立即跑一轮**（用户点了就想看到结果）；关闭时取消排程
 * 并中断进行中的一轮。
 */
function configure(patch = {}) {
  const wasEnabled = state.enabled;
  if (patch.enabled !== undefined) state.enabled = !!patch.enabled;
  if (patch.hour !== undefined) state.hour = intIn(patch, 'hour', 0, 23);
  if (patch.minute !== undefined) state.minute = intIn(patch, 'minute', 0, 59);
  if (patch.jitter_minutes !== undefined) {
    state.jitter_minutes = intIn(patch, 'jitter_minutes', 0, 120);
  }
  if (patch.include_intl !== undefined) state.include_intl = !!patch.include_intl;
  if (!state.enabled) stop();
  schedule();
  saveConfig();
  if (!wasEnabled && state.enabled) {
    runOnce('enable').catch(() => { /* 结果靠 snapshot 轮询 */ });
  }
  return snapshot();
}

module.exports = {
  CONFIG_FILE, DEFAULTS,
  computeNextRunAt, shouldCatchup, decideCheckin, withinBackoff,
  schedule, stop, runOnce, snapshot, configure, state,
};
