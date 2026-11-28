// src/workbuddy/autocheckin.js - WorkBuddy 国内版自动签到调度（P0-1）
//
// 出处：docs/WORKBUDDY-FUSION.md P0-1（hawklithm「每日签到」+ hub「自动化福利与
// 签到」）。此前本项目只有手动 `/checkin`——忘了签就白掉一天积分，而签到是
// 国内版积分的主要补给之一。
//
// 口径照抄 hawklithm 的设计（它把这套跑在生产上），四条都不许放宽：
//   1. **开关默认关**，落盘持久化；打开时立即检查全部账号（用户点了开关就想
//      看到结果，等到次日 00:00 才动会被当成没生效）。
//   2. **每日 00:00（本地）触发 + 随机后延 0~jitter 分钟**。签到窗口是自然日，
//      整点齐发是明显的机器特征；随机后延只往后不加，留在低峰内。
//   3. **签到前先查状态**：已签 → 跳过（幂等，不白打上游）；**状态未知 → 不签**
//      （查不到就当没有答案，绝不用一次盲签去赌——盲签失败会污染账号的错误
//      记录，也会在风控画像上多一笔无意义请求）。
//   4. **关掉开关就取消等待中的计划**，并中断进行中的一轮（账号间 sleep 立刻
//      返回），不留后台尾巴。
//
// 进程归属：**管理端进程**（9083），与 autotask / task-scheduler / keepalive /
// balance-refresh / alerts 同一处。调研建议放网关进程，理由是「网关持有账号
// 刷新权」——但本项目账号存储是文件 + 文件锁的跨进程共享（auth.exchange 自带
// refreshGuard），管理端同样能刷新；而两个进程各排一份会把上游请求翻倍，
// 这正是 boot.js 头注释里「保活不许两个进程各排一份」的同一条纪律。
//
// 签到结果同时写进统一签到账本（`src/checkin-ledger.js`，channel='workbuddy'），
// 这样「签到详情」页将来加 workbuddy 分支就有历史可看——账本只记「签成了」，
// 失败如实进 last_result，不伪造。
const authStore = require('./auth');
const billing = require('./billing');
const c = require('./constants');
const ledger = require('../checkin-ledger');
const { readJSON, writeJSON } = require('../admin/store');

const CONFIG_FILE = 'workbuddy-autocheckin.json';
const DEFAULT_HOUR = parseInt(process.env.DUMATE_WORKBUDDY_CHECKIN_HOUR || '0', 10);
const DEFAULT_MINUTE = parseInt(process.env.DUMATE_WORKBUDDY_CHECKIN_MINUTE || '0', 10);
const DEFAULT_JITTER_MINUTES = 10;      // 0~10 分钟随机后延（错峰防风控）
const PER_ACCOUNT_DELAY_MS = 2000;      // 账号间串行间隔（同 task-scheduler 口径）

const DEFAULTS = {
  enabled: false,
  hour: Number.isInteger(DEFAULT_HOUR) && DEFAULT_HOUR >= 0 && DEFAULT_HOUR <= 23 ? DEFAULT_HOUR : 0,
  minute: Number.isInteger(DEFAULT_MINUTE) && DEFAULT_MINUTE >= 0 && DEFAULT_MINUTE <= 59 ? DEFAULT_MINUTE : 0,
  jitter_minutes: DEFAULT_JITTER_MINUTES,
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
  return cfg;
}

function saveConfig() {
  writeJSON(CONFIG_FILE, {
    enabled: state.enabled,
    hour: state.hour,
    minute: state.minute,
    jitter_minutes: state.jitter_minutes,
    updated_at: Date.now(),
  });
}

const state = {
  ...loadConfig(),
  last_run_at: null,
  last_result: null,
  next_run_at: null,
  running: false,
};

let timer = null;
// 取消令牌：stop()/关闭开关时让进行中的一轮在下一个账号边界收尾（同 keepalive
// 的 sleepCtx 语义）。简化成「只置标志 + 可中断 sleep」——这里没有长等待，
// 一轮最多几个账号 × 2 秒。
let abortFlag = false;

const sleep = (ms) => new Promise((r) => {
  const t = setTimeout(r, Math.max(0, ms));
  if (t.unref) t.unref();
});

// ── 纯函数（离线可测）────────────────────────────────────────────────────

/**
 * 下一次触发时刻 = 今天（或明天）的 hour:minute + [0, jitter) 随机后延。
 * 后延只往后加：提前会爬出低峰窗口，也可能落进「昨天」。
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
 * 「恰好等于时点」要补——computeNextRunAt 的 at <= now 分支会把排程翻到明天。
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
 * 单个账号的签到决定（纯函数）——**只查状态，不做动作**，动作由 runOnce 执行。
 *   unsupported 国际版没有签到接口，跳过（不白打）
 *   already     今日已签，跳过
 *   claim       可以签
 *   unknown     状态查询失败/字段缺失：**不签**（未知状态不自动签）
 */
function decideCheckin(status) {
  if (!status) return 'unknown';
  if (status.unsupported) return 'unsupported';
  if (!status.ok) return 'unknown';
  if (typeof status.todayCheckedIn !== 'boolean') return 'unknown';
  return status.todayCheckedIn ? 'already' : 'claim';
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
  // 启动/重排时补跑：进程没在跑时今天的时点照样会过去，重启后不补就白掉一天。
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
 * @param {string} trigger 'scheduled' | 'catchup' | 'manual' | 'enable'
 * @param {object} [opts] 测试注入
 *   accounts     账号数组（默认 authStore.findUsable()）
 *   statusOf     (account) => Promise<status>
 *   claimOf      (account) => Promise<{ok, already?, error?}>
 *   region       只处理该区域（默认只处理 cn——国际版没有签到接口）
 *   webAgent     (account) => Promise<{ok,skipped,msg,error}>；国际版网页打卡。
 *                undefined = 用 webagent.dailyActivity；null = 跳过国际版
 *   activityReporter (account) => Promise<{ok,skipped,streakDays,msg,error}>；
 *                国内版对话活跃上报（growth 连登）。undefined = 用
 *                activity.reportActivity；null = 跳过
 *
 * **国内版还有第三条腿：对话活跃上报**（`activity.reportActivity` → `POST
 * /v2/report` 一条 `chat_request_send` 事件点亮 growth 连登）。CLAUDE.md 写着
 * 「keepalive 签到后顺带」，但 keepalive 没有 workbuddy 签到（见上一批定案），
 * `reportActivity` 实际只在 webagent 的**证书降级分支**里被调用——正常路径下
 * 国内账号的连登从来不会点亮。所以接在这里，与签到**并列**而不是互斥：
 *  - 签到 = 领当天积分（上游 daily-checkin）
 *  - 活跃 = 点亮连登（上游 /v2/report），两者是不同体系，一个失败不该拖另一个
 *  - 各自幂等：签到靠「先查状态」，活跃靠账号档案 `lastActivityReport`
 *  - 计数分开：`claimed` / `activity` / `webDaily`
 *
 * **国际版走另一条路**：上游没有签到接口（`checkinStatus` 直接
 * `unsupported`），但**有网页打卡**——`webagent.dailyActivity`（ACP 建会话 +
 * 跑一轮，点亮网页端连登）。这条路径此前代码齐全却**全库无调用方**
 * （CLAUDE.md 写着「keepalive 的 global 分支改为网页打卡」，实际没接），
 * 2026-11-08 接到这里：签到排程本来就该覆盖「两条腿」，而网页打卡比签到重
 * 得多（十几秒/号、有活跃会话上限），所以**只在 cn 跑完之后顺序执行**，
 * 不复用签到那套「查状态」判据（它的幂等由账号档案 lastWebActivity 负责）。
 */
async function runOnce(trigger = 'manual', opts = {}) {
  if (state.running) return { skipped: 'already_running' };
  state.running = true;
  abortFlag = false;
  const startedAt = Date.now();
  const statusOf = opts.statusOf || ((a) => billing.checkinStatus(c.normalizeRegion(a.region), a));
  const claimOf = opts.claimOf || ((a) => billing.checkinClaim(c.normalizeRegion(a.region), a));
  const delayMs = opts.perAccountDelayMs !== undefined ? opts.perAccountDelayMs : PER_ACCOUNT_DELAY_MS;
  const wantRegion = opts.region ? c.normalizeRegion(opts.region) : 'cn';
  const authStoreRef = opts.authStore || authStore;
  const allAccounts = Array.isArray(opts.accounts) ? opts.accounts : authStore.findUsable();
  try {
    // 国际版网页打卡（`opts.webAgent === null` 关闭；默认开）
    const webAgent = opts.webAgent === undefined
      ? require('./webagent').dailyActivity
      : opts.webAgent;
    const intlResults = [];
    if (webAgent && !opts.region) {
      for (const raw of allAccounts) {
        if (abortFlag) break;
        if (c.normalizeRegion(raw.region) !== 'global') continue;
        if (intlResults.length > 0) await sleep(delayMs);
        const name = raw.nickname || raw.uid || `账号 ${raw.id}`;
        let r;
        try { r = await webAgent(raw, { authStore: authStoreRef }); } catch (e) { r = { ok: false, error: e.message }; }
        intlResults.push({
          id: raw.id, name, region: 'global',
          ok: !!(r && r.ok),
          // action 用 'web-daily' 明确这是网页打卡而不是签到（两者上游含义不同）
          action: 'web-daily',
          already: !!(r && r.skipped),
          streakDays: null,
          error: (r && r.error) || '',
          msg: (r && r.msg) || '',
        });
      }
    }

    let list;
    if (Array.isArray(opts.accounts)) list = opts.accounts;
    else list = authStore.findUsable();
    // 国际版没有签到接口：直接不进队列（不至于每轮都白打两次上游）
    list = list.filter((a) => c.normalizeRegion(a.region) === wantRegion);

    const results = [];
    for (let i = 0; i < list.length; i++) {
      if (abortFlag) break;
      if (i > 0) await sleep(delayMs);
      if (abortFlag) break;
      const raw = list[i];
      const name = raw.nickname || raw.uid || `账号 ${raw.id}`;
      let a = raw;
      try { a = await authStoreRef.ensureFresh(raw); } catch (e) { a = raw; }
      let st;
      try { st = await statusOf(a); } catch (e) { st = { ok: false, error: e.message }; }
      const decision = decideCheckin(st);
      if (decision !== 'claim') {
        results.push({
          id: raw.id, name, region: c.normalizeRegion(raw.region),
          ok: decision !== 'unknown',        // 未知状态不算失败（没做事），但要能看见
          action: decision,
          already: decision === 'already',
          streakDays: st && st.ok ? (st.streakDays != null ? st.streakDays : null) : null,
          error: decision === 'unknown' ? String((st && st.error) || '签到状态查询失败（未知状态不自动签）') : '',
        });
        continue;
      }
      let r;
      try { r = await claimOf(a); } catch (e) { r = { ok: false, error: e.message }; }
      if (r && r.ok) {
        try { authStoreRef.patch(raw.id, { lastCheckin: Date.now(), lastError: '' }); } catch (e) { /* 记不下不影响结论 */ }
        // 统一签到账本：只记「签成了」。已签跳过的不记（那天本来就签过）
        try {
          ledger.append({
            channel: 'workbuddy', account_id: raw.id, account: name,
            day: ledger.dayOf(Date.now()), at: Date.now(),
            credits: r && r.already ? null : (st && st.dailyCredit != null ? st.dailyCredit : null),
            source: trigger,
          });
        } catch (e) { /* 记账失败不影响签到 */ }
      } else {
        try { authStoreRef.patch(raw.id, { lastError: (r && r.error) || '签到失败' }); } catch (e) { /* 同上 */ }
      }
      results.push({
        id: raw.id, name, region: c.normalizeRegion(raw.region),
        ok: !!(r && r.ok), action: 'claim',
        already: !!(r && r.already),
        streakDays: st && st.ok ? (st.streakDays != null ? st.streakDays : null) : null,
        error: (r && r.error) || '',
      });
    }

    // ---- 国内版对话活跃上报（第三腿，与签到并列而非互斥）----
    //
    // 签到领当天积分，活跃点亮连登——两个上游体系，各自幂等（活跃靠账号档案
    // lastActivityReport），任一失败不该拖另一个。放在签到循环**之后**顺序跑：
    // `/v2/report` 是轻量 POST，但仍不该与签到并发打同一账号。
    // `opts.activityReporter === null` 可关（测试用）。
    // 条件是 `wantRegion === 'cn'` 而不是 `!opts.region`：活跃上报本来就是
    // 国内版专属（list 已按 wantRegion 过滤），cn 单区域轮也该点亮连登。
    const activityReporter = opts.activityReporter === undefined
      ? (() => { try { return require('./activity').reportActivity; } catch (e) { return null; } })()
      : opts.activityReporter;
    const activityResults = [];
    if (activityReporter && wantRegion === 'cn') {
      for (const raw of list) {
        if (abortFlag) break;
        if (activityResults.length > 0) await sleep(delayMs);
        const name = raw.nickname || raw.uid || `账号 ${raw.id}`;
        let r;
        try { r = await activityReporter(raw, { authStore: authStoreRef }); } catch (e) { r = { ok: false, error: e.message }; }
        activityResults.push({
          id: raw.id, name, region: c.normalizeRegion(raw.region),
          ok: !!(r && r.ok),
          // 'activity' 明确是连登活跃上报，不是签到也不是网页打卡
          action: 'activity',
          already: !!(r && r.skipped),
          // 连登天数只有这条路径拿得到（/activity/growth/streak 回读）
          streakDays: r && r.streakDays != null ? r.streakDays : null,
          // **未验证 ≠ 成功**：`/v2/report` 用假 token 也回 code=0（真机实测），
          // 只有回读到天数才算真的计入了连登。这里如实把 verified 透出，
          // 让界面能区分「已送达」与「已计入」。
          verified: !!(r && r.verified),
          error: (r && r.error) || '',
          msg: (r && r.msg) || '',
        });
      }
    }

    // ---- 成长任务补领清扫（第四腿，P0-6；独立开关 DUMATE_WORKBUDDY_TASKS_SWEEP 默认关）----
    //
    // 与签到并列的第四条腿：accept（幂等报名）+ claim（完成未领）+ 连登兑换，
    // 全部真实动作流的低风险层。企业号（enterpriseId 非空）跳过——组织账号的
    // 行为自动化不碰。`opts.taskSweeper === null` 可关（测试用），注入函数接管时
    // 开关不参与判定（测试不想陪 env 玩）。
    const taskSweeper = opts.taskSweeper === undefined
      ? (() => { try { const t = require('./tasks'); return t.sweepEnabled() ? t.sweepDaily : null; } catch (e) { return null; } })()
      : opts.taskSweeper;
    const taskResults = [];
    if (taskSweeper) {
      const { enterpriseBlocked } = require('./tasks');
      for (const raw of list) {
        if (abortFlag) break;
        if (taskResults.length > 0) await sleep(delayMs);
        const name = raw.nickname || raw.uid || `账号 ${raw.id}`;
        const region = c.normalizeRegion(raw.region);
        if (enterpriseBlocked(raw)) {
          taskResults.push({ id: raw.id, name, region, ok: true, action: 'tasks', skipped: true, error: '', msg: '企业号跳过成长写腿' });
          continue;
        }
        // 与签到腿同款：先 ensureFresh 再打上游（清扫是 2~5 次写，AT 必须新鲜）
        let a = raw;
        try { a = await authStoreRef.ensureFresh(raw); } catch (e) { a = raw; }
        let r;
        try { r = await taskSweeper(a); } catch (e) { r = null; }
        const sweep = (r && r.sweep) || { ok: false, error: (r && r.error) || '清扫无结果' };
        const redeem = (r && r.redeem) || { ok: false, redeemed: [], skipped: [] };
        taskResults.push({
          id: raw.id, name, region,
          ok: !!(r && r.sweep && r.sweep.ok),
          action: 'tasks',
          // 明细按腿语义摊平：accepted/claimed/unverified 是清扫三态，redeemed 是兑换
          accepted: (sweep.accepted || []).length,
          claimed: (sweep.claimed || []).length,
          unverified: (sweep.unverified || []).length,
          redeemed: (redeem.redeemed || []).length,
          skipped: !!(sweep.ok && !(sweep.accepted || []).length && !(sweep.claimed || []).length
            && !(sweep.unverified || []).length && !(redeem.redeemed || []).length),
          error: sweep.error || '',
          msg: `${(sweep.claimed || []).length} 领 / ${(redeem.redeemed || []).length} 兑`,
        });
      }
    }

    const allResults = results.concat(activityResults, intlResults, taskResults);
    const claimed = results.filter((r) => r.ok && r.action === 'claim' && !r.already).length;
    const webDaily = intlResults.filter((r) => r.ok && !r.already).length;
    // 活跃**只把「回读到连登天数」算进 activity**：送达但未验证的数量单列。
    // 理由（真机实测）：`/v2/report` 用假 accessToken 也回 `{"code":0,"OK"}`，
    // 而同一假 token 打 `/activity/growth/streak` 是 401——code=0 只证明请求被接，
    // 不证明事件被计入。把未验证算进 activity 就是界面报喜不报忧。
    const activityUnverified = activityResults.filter((r) => r.ok && !r.already && !r.verified).length;
    const activity = activityResults.filter((r) => r.ok && !r.already && r.verified).length;
    state.last_run_at = Date.now();
    state.last_result = {
      trigger,
      started_at: startedAt,
      duration_ms: state.last_run_at - startedAt,
      aborted: abortFlag,
      region: wantRegion,
      accounts: allResults.length,
      claimed,
      already: allResults.filter((r) => r.already).length,
      unknown: results.filter((r) => r.action === 'unknown').length,
      failed: allResults.filter((r) => !r.ok).length,
      // 三条腿分开计数（上游含义各不相同，合并会误导）
      activity,
      activityUnverified,
      activityFailed: activityResults.filter((r) => !r.ok).length,
      webDaily,
      webDailyFailed: intlResults.filter((r) => !r.ok).length,
      // 第四腿（成长任务）：领/兑分开计，未验证单列——没回读证据不算到手
      tasksAccepted: taskResults.reduce((s, r) => s + (r.accepted || 0), 0),
      tasksClaimed: taskResults.reduce((s, r) => s + (r.claimed || 0), 0),
      tasksUnverified: taskResults.reduce((s, r) => s + (r.unverified || 0), 0),
      tasksRedeemed: taskResults.reduce((s, r) => s + (r.redeemed || 0), 0),
      tasksFailed: taskResults.filter((r) => !r.ok).length,
      results: allResults,
    };
    try {
      require('../admin/auth').audit('system', 'workbuddy_autocheckin', '',
        `${trigger}: 国内签成 ${claimed} / 活跃 ${activity}${activityUnverified ? `（未验证 ${activityUnverified}）` : ''} / 网页打卡 ${webDaily}`
        + (taskSweeper ? ` / 任务领 ${taskResults.reduce((s, r) => s + (r.claimed || 0), 0)} 兑 ${taskResults.reduce((s, r) => s + (r.redeemed || 0), 0)}` : ''));
    } catch (e) { /* 审计不可用不阻塞结果 */ }
    return state.last_result;
  } finally {
    state.running = false;
    abortFlag = false;
  }
}

// ── 配置 ────────────────────────────────────────────────────────────────

function snapshot() {
  return {
    enabled: state.enabled,
    hour: state.hour,
    minute: state.minute,
    jitter_minutes: state.jitter_minutes,
    per_account_delay_ms: PER_ACCOUNT_DELAY_MS,
    last_run_at: state.last_run_at,
    last_result: state.last_result,
    next_run_at: state.next_run_at,
    running: state.running,
    rationale: [
      '签到是国内版积分的主要补给：忘了签 = 白掉一天，所以有排程',
      `每日 ${state.hour}:${String(state.minute).padStart(2, '0')} + 0~${state.jitter_minutes} 分钟随机后延（只后延不提前）`,
      '签到前先查状态：已签跳过、未知状态不签（不拿盲签去赌）',
      '国际版没有签到接口，不自动跑；排程在管理端进程，避免网关与管理端各排一份',
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
  computeNextRunAt, shouldCatchup, decideCheckin,
  schedule, stop, runOnce, snapshot, configure, state,
};
