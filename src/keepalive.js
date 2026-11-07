// src/keepalive.js - 凭证保活与余额联动调度（施工包 B / GAP F2）
//
// 为什么要有这个模块：凭证刷新目前全是被动的——登录、管理端换票、401 才刷。
// 长期不活跃的账号 token 过期了没人知道，等真要用时才发现；签到跑完也不看
// 余额，冷却账号余额回正后永远不会被解冻；余额快照无人定期采集，F1 的
// 保底判据（余额低于阈值拦收费模型）没有数据源。
//
// 本模块每日低峰跑一轮闭环（对齐 workbuddy2api internal/scheduler 的
// RunCheckinNow 语义「签到成功 → 重新查余额 → 余额>0 的冷却账号自动解冻」）：
//
//   1. 保活刷新（刷新前探）：余量低于 warn_hours 窗口的 token 主动续期，
//      续不上的进「过期预警」（结果行 expire_warn），不惩罚账号——
//      惩罚（熔断/冷却）是 pool 与错误路径的事，保活只观测和报告。
//   2. 签到（仅 web 通道，幂等）：解冻闭环的「签到」环节，冷却账号也参与
//      ——签到就是为了解冻它们。TRAE 签到由任务轮询（task-scheduler）自带，
//      qoder 签到带领取副作用，保持手动，不在这里自动跑。
//   3. 查余额：并发上限 sem_cap（默认 3，对齐 codebuddy 的 sem cap=3），
//      worker 起跑错开，不做同一瞬间的并发请求。
//   4. 解冻闭环：余额 > balance_threshold（默认 0，即 GAP 的「余额>0」）
//      且在冷却中的账号调 pool.revive。余额查不到（null）的不动——
//      不猜 0 也不猜有，宁可漏解冻不可误解冻。
//
// 风控纪律沿 task-scheduler：每日时点 + 0..jitter_minutes 随机抖动（只后延
// 不提前，留在低峰窗口内）、账号间串行间隔、余额阶段 worker 错峰起跑。
// ctx 可取消对齐参照实现的 sleepCtx：stop() 立即唤醒所有等待中的 sleep，
// 本轮尽快收尾，不等限速睡满。
//
// 【A 包接口对接（已在工作区对 src/pool.js 校准；合入后以此为准）】
// pool 模块导出 { createPool, pool, ... }，B 用默认单例 pool。用到的冷路径 API
// （pool.js 内注释即「运维 / B 包调度」组）：
//   pool.snapshot() → [{ id, state, cooling, cooldown_kind, cooldown_until, ... }]
//                                     惩罚态行（id 为 String；cooling/cooldown_until
//                                     由 pool 现算）。旧的 entries()/list() 形态仍兼容探测。
//   pool.noteSuccess(id)             成功喂入（= GAP F2 的「pool 记健康」）。
//   pool.reenableIfCredits(id, credits) → { unfrozen }
//                                     余额恢复解冻（B 包签到闭环入口，A 专为 B 预留）：
//                                     余额>0 且未禁用时只解**硬冷却**——软冷却/模型级
//                                     台账/熔断是限流与通道健康的保护，余额恢复证明
//                                     不了它们已解除，故保留（A 注释明示）。
//   pool.revive(id)                  一键复活（无 reason 参）。仅作 reenableIfCredits
//                                     缺失时的兜底，正常闭环不走它。
//   pool.freeze(id, ms, reason)      冻结。B 不调用（保活非破坏性，只观测解冻）。
// uid 键位（与 pool 的喂入方对账）：
//   web 通道 = 裸 String(a.id)——A 的 web-pool 已用裸 id 喂 pool（noteSuccess(a.id) 等）；
//   qwenwork/traework/qoder = `${channel}:${id}`——三通道 id 是各自文件里的自增数字，
//   裸用会在同一份 pool-state.json 里撞号；若后续集成统一键位，改各 adapter 的 uid。
// A 未合入或接口不可探测时降级 no-op stub（mode:'stub'，见 snapshot().pool_mode）。
//
// 环境变量：
//   DUMATE_KEEPALIVE_HOUR / DUMATE_KEEPALIVE_MINUTE  每日低峰时点，默认 22:30
//   DUMATE_ADMIN_DATA                                数据目录（store 读取）
const { readJSON, writeJSON } = require('./admin/store');
const accounts = require('./accounts');
// 余额变动流水（施工包 C）：保活查到的每个余额都过一遍 observe——
// 变动留痕、首见建基线，面板余额时间线/曲线的数据源就在这里。
const balanceHist = require('./balance-hist');

const CONFIG_FILE = 'keepalive.json';
const DEFAULT_HOUR = parseInt(process.env.DUMATE_KEEPALIVE_HOUR || '22', 10);
const DEFAULT_MINUTE = parseInt(process.env.DUMATE_KEEPALIVE_MINUTE || '30', 10);
const DEFAULT_JITTER_MINUTES = 30;      // 每日在 [时点, 时点+jitter] 内随机取触发时刻
const DEFAULT_WARN_HOURS = 24;          // token 余量低于此窗口 → 本轮续期；续不上 → 预警
const DEFAULT_SEM_CAP = 3;              // 余额阶段并发上限（对齐 codebuddy sem cap=3）
const DEFAULT_PER_ACCOUNT_DELAY_MS = 2000;   // 同 task-scheduler：账号间不同一瞬间打上游
const DEFAULT_BALANCE_THRESHOLD = 0;    // 余额 > 阈值才解冻（GAP：余额>0）

const DEFAULTS = {
  enabled: false,   // 新排程不悄悄自启，管理端显式打开（同 autotask 的纪律）
  hour: DEFAULT_HOUR,
  minute: DEFAULT_MINUTE,
  jitter_minutes: DEFAULT_JITTER_MINUTES,
  warn_hours: DEFAULT_WARN_HOURS,
  sem_cap: DEFAULT_SEM_CAP,
  per_account_delay_ms: DEFAULT_PER_ACCOUNT_DELAY_MS,
  balance_threshold: DEFAULT_BALANCE_THRESHOLD,
  checkin: true,
};

function loadConfig() {
  const saved = readJSON(CONFIG_FILE, null) || {};
  const cfg = { ...DEFAULTS };
  if (Number.isInteger(saved.hour)) cfg.hour = saved.hour;
  if (Number.isInteger(saved.minute)) cfg.minute = saved.minute;
  if (Number.isInteger(saved.jitter_minutes)) cfg.jitter_minutes = saved.jitter_minutes;
  if (Number.isFinite(saved.warn_hours) && saved.warn_hours >= 0) cfg.warn_hours = saved.warn_hours;
  if (Number.isInteger(saved.sem_cap) && saved.sem_cap >= 1) cfg.sem_cap = saved.sem_cap;
  if (Number.isInteger(saved.per_account_delay_ms) && saved.per_account_delay_ms >= 0) {
    cfg.per_account_delay_ms = saved.per_account_delay_ms;
  }
  if (Number.isFinite(saved.balance_threshold) && saved.balance_threshold >= 0) {
    cfg.balance_threshold = saved.balance_threshold;
  }
  if (typeof saved.checkin === 'boolean') cfg.checkin = saved.checkin;
  cfg.enabled = !!saved.enabled;
  return cfg;
}

function saveConfig() {
  writeJSON(CONFIG_FILE, {
    enabled: state.enabled,
    hour: state.hour,
    minute: state.minute,
    jitter_minutes: state.jitter_minutes,
    warn_hours: state.warn_hours,
    sem_cap: state.sem_cap,
    per_account_delay_ms: state.per_account_delay_ms,
    balance_threshold: state.balance_threshold,
    checkin: state.checkin,
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

// ── 可取消等待（对齐参照实现 sleepCtx：取消立即返回 false，等满返回 true）──

function makeToken() {
  const listeners = [];
  return {
    aborted: false,
    on(fn) { listeners.push(fn); },
    off(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    abort() {
      if (this.aborted) return;
      this.aborted = true;
      const all = listeners.splice(0, listeners.length);
      for (const fn of all) { try { fn(); } catch (e) { /* 唤醒失败不影响其余 */ } }
    },
  };
}

const activeRuns = new Set();

function sleepCtx(ms, token) {
  if (token.aborted) return Promise.resolve(false);
  if (!(ms > 0)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => done(true), ms);
    if (t.unref) t.unref();
    const onAbort = () => done(false);
    token.on(onAbort);
    function finished() { token.off(onAbort); clearTimeout(t); }
    function done(v) { if (!finished.done) { finished.done = true; finished(); resolve(v); } }
  });
}

// 下一次触发时刻 = 每日时点 + [0, jitter] 随机后延。
// 抖动只往后加不往前减：低峰窗口是从时点开始的一段，提前会爬回高峰。
// rng 注入是为了测试可复现。
function computeNextRunAt(now, cfg, rng = Math.random) {
  const base = new Date(now);
  base.setHours(cfg.hour, cfg.minute, 0, 0);
  let at = base.getTime();
  if (at <= now) at += 24 * 60 * 60 * 1000;
  const jitterMs = Math.max(0, cfg.jitter_minutes || 0) * 60 * 1000;
  if (jitterMs > 0) at += Math.floor(rng() * jitterMs);
  return at;
}

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
  // 重启补跑（2026-11-06）：进程没在跑时今天的时点照样会过去——重启后若
  // 今天时点已过且 last_run_at 不是今天，立即后台补一轮。幂等由签到接口
  // already / grants 去重 / running 互斥三层兜底，跑过了就是空转一轮。
  if (shouldCatchup(Date.now(), state, state.last_run_at)) {
    runOnce('catchup').catch(() => { /* 补跑失败明天照常 */ });
  }
}

// 补跑判据（纯函数，schedule() 接线、测试直测）：今天时点已过 && 今天没跑过。
// 「恰好等于时点」要补——computeNextRunAt 的 at <= now 分支会把排程翻到明天。
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

// 取消排程 + 立即中断进行中的一轮（sleepCtx 全部提前返回，阶段边界快速收尾）
function stop() {
  if (timer) { clearTimeout(timer); timer = null; }
  state.next_run_at = null;
  for (const t of activeRuns) { try { t.abort(); } catch (e) { /* 忽略 */ } }
}

// ── pool 接口对接层（真名/假设名双探测，见文件头【A 包接口对接】）──

function normalizePool(p) {
  const api = p && typeof p === 'object' ? p : null;
  const has = (f) => !!api && typeof api[f] === 'function';
  // 惩罚态列表：A 真名 snapshot()（status 行）；假设形态 entries()/list() 兼容
  const entriesLike = has('snapshot') ? () => api.snapshot()
    : has('entries') ? () => api.entries()
      : has('list') ? () => api.list() : null;
  // 记健康：A 真名 noteSuccess(id)；假设名 noteHealthy 兼容
  const noteHealthyLike = has('noteSuccess') ? (id) => api.noteSuccess(id)
    : has('noteHealthy') ? (id) => api.noteHealthy(id) : null;
  // 余额恢复解冻：A 真名 reenableIfCredits(id, credits) → { unfrozen }
  const reenable = has('reenableIfCredits') ? (id, credits) => api.reenableIfCredits(id, credits) : null;
  const reviveLike = has('revive') ? (id, reason) => api.revive(id, reason) : null;
  // 三个关键口一个都没有 → 接口不可探测，按 stub 降级
  if (!api || (!entriesLike && !reviveLike && !reenable)) {
    return {
      mode: 'stub',
      revive() {}, freeze() {}, noteHealthy() {}, reenableIfCredits: null,
      entries() { return []; },
    };
  }
  return {
    mode: 'pool',
    entries: entriesLike || (() => []),
    noteHealthy: noteHealthyLike || (() => {}),
    reenableIfCredits: reenable,
    revive: reviveLike || (() => {}),
    freeze: has('freeze') ? (id, ms, reason) => api.freeze(id, ms, reason) : () => {},
  };
}

let poolResolution = null;
function resolvePool() {
  if (poolResolution) return poolResolution;
  let api = null;
  try {
    const m = require('./pool');   // A 包文件存在才加载；并行开发期通常不存在
    // 工厂型模块（{ createPool, pool }）用默认单例；裸对象模块直接用
    const cand = m && typeof m === 'object' ? (m.pool || (typeof m.createPool === 'function' ? null : m)) : null;
    if (cand && typeof cand === 'object'
      && (typeof cand.revive === 'function' || typeof cand.snapshot === 'function' || typeof cand.reenableIfCredits === 'function')) {
      api = cand;
    }
  } catch (e) { /* A 包未合入 */ }
  poolResolution = api ? { mode: 'pool', api } : { mode: 'stub', api: null };
  return poolResolution;
}

// ── 通道 adapter：把四类账号存取收敛成统一的最小接口 ──
// 全部走惰性 require：管理端/网关哪个进程引用本模块都不会在加载期拖起
// 不需要的通道包；单通道故障也不影响其余通道的保活。

function builtinAdapters() {
  return [
    {
      // web（百度搭子网页凭证）：token 约 1 小时有效期、按 cookie 随取随换，
      // 保活价值在「每天真打一次 token 接口验证 cookie 还活着」+ 余额快照。
      channel: 'web',
      list() { return accounts.load().accounts.filter((a) => a.enabled); },
      // 裸 String(id)：对齐 A 包 web-pool 喂入 pool 的键位（noteSuccess(a.id) 等）
      uid(a) { return String(a.id); },
      name(a) { return accounts.displayName(a); },
      async refresh(a) {
        const webPool = require('./web-pool');
        const t = await webPool.getToken(a, true);   // 主动预热，不等到转发时才刷
        const st = webPool.stateOf(a.id);
        return { ok: !!t.ok, error: t.error || '', expired: !!t.expired, expire_at: t.ok ? (st.token_expire_at || null) : null };
      },
      async balance(a) {
        const web = require('./dumate-web');
        // 出站代理（E 包收口补点）：余额查询与对话同出口，配置非法按查询失败处理
        let agent = null;
        try { agent = web.agentFor(a); } catch (e) {
          return { ok: false, error: e.message, remain: null };
        }
        const r = await web.api.quotaOverview(a.cookie, { agent });
        return { ok: !!r.ok, remain: r.ok && Number.isFinite(r.left) ? r.left : null, error: r.error || '' };
      },
      async checkin(a) {
        let doCheckin;
        try { ({ doCheckin } = require('./admin/routes/accounts')); } catch (e) {
          return { ok: false, error: `签到模块不可用: ${e.message}` };
        }
        const r = await doCheckin(a);
        return { ok: !!r.ok, already: !!(r && (r.already || r.result === 'already')), error: (r && r.error) || '' };
      },
    },
    {
      // qwenwork：refreshToken 轮换制，exchange 成功后由调用方落盘（patch）。
      channel: 'qwenwork',
      list() { return require('./qwenwork/auth').findUsable(); },
      uid(a) { return `qwenwork:${a.id}`; },
      name(a) { return a.nickname || a.uid || `账号 ${a.id}`; },
      async refresh(a) {
        const authStore = require('./qwenwork/auth');
        const cur = authStore.get(a.id) || a;
        if (!authStore.needsRefresh(cur, state.warn_hours * 3600 * 1000)) {
          return { ok: true, skipped: true, expire_at: cur.expiresAt || null };
        }
        const r = await authStore.exchange(cur);
        if (r.ok && r.patch) { try { authStore.patch(a.id, r.patch); } catch (e) { /* 落盘失败下轮重试 */ } }
        const merged = { ...cur, ...(r.patch || {}) };
        return { ok: !!r.ok, error: r.error || '', expired: !!r.expired, expire_at: merged.expiresAt || null };
      },
      async balance(a) {
        const { fetchWallets } = require('./qwenwork/credits');
        const r = await fetchWallets({ account: a, force: true });
        // 合计以 total 为准：它是三池之和（上游坏读时已用 account-context 的
        // 权威值校正过）。**不要自己把三池加起来**——坏读时池子是 null，
        // 当成 0 相加会得出「余额 0」，保活会把它当「额度耗尽」报出去。
        const t = r.ok && typeof r.total === 'number' && Number.isFinite(r.total) ? r.total : null;
        return { ok: !!r.ok && t != null, remain: t, error: r.error || '' };
      },
    },
    {
      // traework：同为 refreshToken 轮换制。
      channel: 'traework',
      list() { return require('./traework/auth').findUsable(); },
      uid(a) { return `traework:${a.id}`; },
      name(a) { return a.nickname || a.uid || `账号 ${a.id}`; },
      async refresh(a) {
        const authStore = require('./traework/auth');
        const cur = authStore.get(a.id) || a;
        if (!authStore.needsRefresh(cur, state.warn_hours * 3600 * 1000)) {
          return { ok: true, skipped: true, expire_at: cur.expiresAt || null };
        }
        const r = await authStore.exchange(cur);
        if (r.ok && r.patch) { try { authStore.patch(a.id, r.patch); } catch (e) { /* 同上 */ } }
        const merged = { ...cur, ...(r.patch || {}) };
        return { ok: !!r.ok, error: r.error || '', expired: !!r.expired, expire_at: merged.expiresAt || null };
      },
      async balance(a) {
        const { usage } = require('./traework/checkin');
        const r = await usage(a);
        return { ok: !!r.ok, remain: r.ok && typeof r.remain === 'number' ? r.remain : null, error: r.error || '' };
      },
    },
    {
      // qoder：ensureAccount 内部完成 needsRefresh → exchange → patch 落盘，
      // 换票失败抛 401（凭证失效该重登，不是网络问题）。
      channel: 'qoder',
      list() { return require('./qoder/auth').findUsable(); },
      uid(a) { return `qoder:${a.id}`; },
      name(a) { return a.nickname || a.uid || `账号 ${a.id}`; },
      async refresh(a) {
        const authStore = require('./qoder/auth');
        const session = require('./qoder/session');
        try {
          const cur = authStore.get(a.id) || a;
          if (!authStore.needsRefresh(cur, state.warn_hours * 3600 * 1000)) {
            return { ok: true, skipped: true, expire_at: cur.expiresAt || null };
          }
          const updated = await session.ensureAccount(authStore, cur);
          return { ok: true, expire_at: (updated && updated.expiresAt) || null };
        } catch (e) {
          return { ok: false, error: e.message, expired: e.statusCode === 401 };
        }
      },
      async balance(a) {
        const authStore = require('./qoder/auth');
        const session = require('./qoder/session');
        const cur = authStore.get(a.id) || a;
        // 出站代理（E 包收口补点）：余额查询与对话同出口，配置非法按查询失败处理
        let agent = null;
        try { agent = require('./proxy-agent').getAgentFor(cur); } catch (e) {
          return { ok: false, error: e.message, remain: null };
        }
        const r = await session.fetchQuota(cur.accessToken, cur.region, { agent });
        if (!r.ok) return { ok: false, error: r.error || '', remain: null };
        // 管理端口径：userQuota 与 addOnQuota 分开报不相加。解冻判据看主套餐，
        // 主套餐取不到再看加量包；都取不到就是 null（不猜 0）。
        const remain = r.userQuota && Number.isFinite(r.userQuota.remaining) ? r.userQuota.remaining
          : (r.addOnQuota && Number.isFinite(r.addOnQuota.remaining) ? r.addOnQuota.remaining : null);
        return { ok: true, remain, error: '' };
      },
    },
  ];
}

// 测试/集成注入：设置后 scheduled 触发也走这套 adapter / pool（runOnce 手动
// 调用仍可用 opts.adapters / opts.pool 临时覆盖）。setAdapters(null) / setPool(undefined)
// 还原自动探测。
let injectedAdapters = null;
function setAdapters(list) { injectedAdapters = list; }
let injectedPool;   // undefined = 自动探测；null = 强制 stub
function setPool(p) { injectedPool = p; }

// 过期预警：续期没成功（失败或被跳过）且到期时刻已知、余量落在预警窗口内。
// 续期成功的不预警——能续上就说明活着，预警只留给「要过期又续不上」的号。
function expireWarn(r, warnHours) {
  const at = r && Number(r.expire_at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const leftMs = at - Date.now();
  if (leftMs > warnHours * 3600 * 1000) return null;
  return { expire_at: at, left_hours: Math.max(0, Math.round((leftMs / 3600000) * 10) / 10) };
}

// ── 健康预警判据（2026-11-06 清单项「登录态健康预警 UI」的数据面）──
//
// 纯函数，输入两个**内存快照**（管理端 /keepalive/health 端点喂入）：
//   ka          keepalive.snapshot() 的裁剪版（enabled / last_result.results）
//   webAccounts web-pool.snapshot() 的账号行（搭子网页凭证）
// 分级：crit（红）= 登录态已死或账号不可用；warn（黄）= 要留意；绿 = alerts 为空。
// 判读纪律：字段查不到就跳过该条，不编成因（与 grants 推算同一口径）。
// 注意 results 行的 expire_warn 只覆盖「到期时刻已知」的号——cookie 死
// （401）的行 expire_at 未知、expire_warn 恒 null，crit 从 error 串判。
function healthAlerts({ ka, webAccounts } = {}) {
  const alerts = [];
  const errKind = (s) => (/401|expired|login|cookie/i.test(String(s || '')) ? 'auth' : 'network');

  // ── 搭子网页账号（web-pool 状态机视图）──
  for (const a of Array.isArray(webAccounts) ? webAccounts : []) {
    if (!a || !a.enabled) continue;                 // 未启用的账号不进健康面
    if (a.disabled) {
      alerts.push({
        level: 'crit', channel: 'dumate', account: a.name, reason: 'disabled',
        message: a.disabled_reason || '账号已被禁用（连续 401 达阈）',
      });
      continue;
    }
    const err = String(a.last_error || '');
    if (errKind(err) === 'auth') {
      alerts.push({
        level: 'crit', channel: 'dumate', account: a.name, reason: 'cookie_dead',
        message: `登录态失效（${err.slice(0, 80)}）——需重新登录`,
      });
      continue;                                     // 登录态都死了，冷却没有意义
    }
    // token 票（约 1h 有效）余量 < 10 分钟：下次请求会自动续期，纯提示
    if (Number.isFinite(a.token_expires_in_s) && a.token_expires_in_s > 0 && a.token_expires_in_s < 600) {
      alerts.push({
        level: 'warn', channel: 'dumate', account: a.name, reason: 'token_low',
        message: `token 余量仅 ${Math.max(1, Math.round(a.token_expires_in_s / 60))} 分钟（下次请求自动续期）`,
      });
    }
    if (a.cooling) {
      alerts.push({
        level: 'warn', channel: 'dumate', account: a.name, reason: 'cooling',
        message: `冷却中${Number.isFinite(a.cool_remaining_s) && a.cool_remaining_s > 0
          ? `（${Math.round(a.cool_remaining_s / 60)} 分钟后可重试）` : ''}` +
          (a.cooldown_reason ? `：${a.cooldown_reason}` : ''),
      });
    }
  }

  // ── 保活轮结果（含直连通道账号——它们的健康信息只在这里有）──
  const last = ka && ka.last_result;
  if (last && Array.isArray(last.results)) {
    for (const r of last.results) {
      if (!r || r.ok || r.skipped) continue;
      const kind = errKind(r.error);
      alerts.push({
        level: kind === 'auth' ? 'crit' : 'warn',
        channel: r.channel || '', account: r.name || r.uid || '',
        reason: kind === 'auth' ? 'refresh_auth_fail' : 'refresh_fail',
        message: (kind === 'auth' ? '保活续期失败（登录态疑失效）：' : '保活续期失败：') +
          String(r.error || '未知原因').slice(0, 80),
      });
    }
    if (last.aborted) {
      alerts.push({
        level: 'warn', channel: 'keepalive', account: '', reason: 'keepalive_aborted',
        message: '最近一轮保活被中断（结果不完整）',
      });
    }
  }

  // ── 排程面（提示性）──
  if (ka && !ka.enabled) {
    alerts.push({
      level: 'warn', channel: 'keepalive', account: '', reason: 'keepalive_off',
      message: '每日保活排程未启用——过期只在请求时被动发现',
    });
  }

  // 红的排前面：界面横幅只看计数，明细列表红在上更符合阅读顺序
  return alerts.sort((x, y) => (x.level === 'crit' ? 0 : 1) - (y.level === 'crit' ? 0 : 1));
}

// 解冻闭环（纯函数）：冷却中的账号 ∩ 余额查到的账号 ∩ 余额 > 阈值 → 解冻。
// 优先走 A 包真名 reenableIfCredits（只解硬冷却，软冷却/熔断由它的语义保留）；
// 该接口缺失的假设形态走 revive 全清兜底。余额查不到的账号不动：
// 解冻的依据是观测到的余额，不是「应该有余额」。
function reconcile(poolApi, balanceRows, cfg, now = Date.now()) {
  const okByUid = new Map();
  for (const b of balanceRows) {
    if (b && b.ok && typeof b.remain === 'number' && Number.isFinite(b.remain)) okByUid.set(b.uid, b.remain);
  }
  let cooling;
  try {
    cooling = (poolApi.entries() || []).filter((e) => {
      if (!e) return false;
      // A 包 status 行：cooling 布尔 + cooldown_until/until 现算字段；
      // 假设接口行：cooldown:{ until }
      if (typeof e.cooling === 'boolean') {
        return e.cooling && Number(e.cooldown_until || e.until || 0) > now;
      }
      return !!(e.cooldown && Number(e.cooldown.until) > now);
    });
  } catch (e) { cooling = []; }
  const unfrozen = [];
  const failed = [];
  const skipped = [];
  for (const e of cooling) {
    const uid = e.id !== undefined ? String(e.id) : e.uid;
    const remain = okByUid.get(uid);
    if (remain === undefined) continue;            // 查不到余额的不动——不猜
    if (!(remain > cfg.balance_threshold)) { skipped.push({ uid, remain }); continue; }
    try {
      if (poolApi.reenableIfCredits) {
        const r = poolApi.reenableIfCredits(uid, remain);
        if (r && r.unfrozen) unfrozen.push({ uid, remain });
        else skipped.push({ uid, remain });        // 无硬冷却可解（软冷却/熔断保留是 A 的语义）
      } else {
        poolApi.revive(uid, `keepalive: 余额 ${remain} > ${cfg.balance_threshold}，自动解冻`);
        unfrozen.push({ uid, remain });
      }
    } catch (err) { failed.push({ uid, error: err.message }); }
  }
  return { cooling_count: cooling.length, with_balance: okByUid.size, unfrozen, revive_failed: failed, below_threshold: skipped };
}

// 余额阶段：worker 池（并发上限 cap）。不用「每账号一个 Promise」的写法——
// 那样账号一多同一瞬间就是几十个请求，正是要避免的机器特征。
// worker 起跑按 per_account_delay_ms 的一半错开：cap 个并发不等于同一瞬间
// cap 个请求；worker 内部每处理完一个账号也隔一个账号间隔。
async function balancePhase(units, cfg, token) {
  const rows = new Array(units.length).fill(null);
  if (!units.length) return [];
  const cap = Math.max(1, Math.min(cfg.sem_cap || 1, units.length));
  const staggerBase = Math.max(1, Math.floor(cfg.per_account_delay_ms / 2));
  let idx = 0;
  const worker = async (w) => {
    if (w > 0) await sleepCtx(w * staggerBase + Math.floor(Math.random() * staggerBase), token);
    while (!token.aborted) {
      const i = idx++;
      if (i >= units.length) return;
      const u = units[i];
      let b;
      try { b = await u.ad.balance(u.a); } catch (e) { b = { ok: false, error: e.message }; }
      const remain = b && typeof b.remain === 'number' && Number.isFinite(b.remain) ? b.remain : null;
      // 余额流水观测（C 包挂钩）：查到了就记，变动与否由 balance-hist 的
      // 基线比对决定；uid 已是统一键位（web 裸 id，其余 channel:id）
      if (b && b.ok && remain != null) {
        try { balanceHist.observe({ account: u.uid, channel: u.ad.channel, balance: remain, source: 'keepalive' }); } catch (e) { /* 记账失败不影响保活 */ }
      }
      rows[i] = {
        channel: u.ad.channel, uid: u.uid, name: u.name,
        ok: !!(b && b.ok),
        remain,
        error: (b && b.error) || '',
      };
      if (!(await sleepCtx(cfg.per_account_delay_ms, token))) return;
    }
  };
  await Promise.all(Array.from({ length: cap }, (_, w) => worker(w).catch(() => {})));
  return rows.filter(Boolean);
}

// 跑一轮完整闭环：保活刷新 → 签到（可选）→ 查余额 → 解冻。
// opts（全部可选，测试/手动用）：adapters、pool、per_account_delay_ms、
// sem_cap、checkin。scheduled 触发不带 opts，走注入或内置 adapter。
async function runOnce(trigger = 'manual', opts = {}) {
  if (state.running) return { skipped: 'already_running' };
  const token = makeToken();
  activeRuns.add(token);
  state.running = true;
  const startedAt = Date.now();
  try {
    const cfg = {
      warn_hours: state.warn_hours,
      per_account_delay_ms: opts.per_account_delay_ms !== undefined ? opts.per_account_delay_ms : state.per_account_delay_ms,
      sem_cap: opts.sem_cap !== undefined ? opts.sem_cap : state.sem_cap,
      balance_threshold: state.balance_threshold,
      checkin: opts.checkin !== undefined ? opts.checkin : state.checkin,
    };
    const poolApi = normalizePool(opts.pool !== undefined
      ? opts.pool
      : (injectedPool !== undefined ? injectedPool : resolvePool().api));
    const adapters = opts.adapters || injectedAdapters || builtinAdapters();

    const units = [];
    for (const ad of adapters) {
      let list;
      try { list = ad.list() || []; } catch (e) { continue; }   // 单通道读失败不影响其余
      for (const a of list) units.push({ ad, a, uid: ad.uid(a), name: ad.name(a) });
    }

    // 阶段 1：保活刷新。串行 + 账号间隔——刷新请求对上游是低频敏感动作，
    // 与余额查询不同，没必要也没有理由并发。
    const results = [];
    for (let i = 0; i < units.length; i++) {
      if (token.aborted) break;
      if (i > 0) { if (!(await sleepCtx(cfg.per_account_delay_ms, token))) break; }
      const u = units[i];
      let r;
      try { r = await u.ad.refresh(u.a); } catch (e) { r = { ok: false, error: e.message }; }
      const ok = !!(r && r.ok);
      if (ok) { try { poolApi.noteHealthy(u.uid); } catch (e) { /* 假设接口缺失时静默 */ } }
      results.push({
        channel: u.ad.channel, uid: u.uid, name: u.name,
        ok, skipped: !!(r && r.skipped), error: (r && r.error) || '',
        expire_at: (r && r.expire_at) || null,
        // 预警只留给「没续上」的号（见 expireWarn 注释）
        expire_warn: ok ? null : expireWarn(r, cfg.warn_hours),
      });
    }

    // 阶段 2：签到（幂等，仅声明了 checkin 的通道；冷却账号也参与——签到就是为了解冻它们）
    let checkinResults = null;
    if (cfg.checkin && !token.aborted) {
      checkinResults = [];
      const targets = units.filter((u) => typeof u.ad.checkin === 'function');
      for (let i = 0; i < targets.length; i++) {
        if (token.aborted) break;
        if (i > 0) { if (!(await sleepCtx(cfg.per_account_delay_ms, token))) break; }
        const u = targets[i];
        let r;
        try { r = await u.ad.checkin(u.a); } catch (e) { r = { ok: false, error: e.message }; }
        checkinResults.push({ channel: u.ad.channel, uid: u.uid, name: u.name, ok: !!(r && r.ok), already: !!(r && r.already), error: (r && r.error) || '' });
      }
    }

    // 阶段 3：查余额（并发上限）；阶段 4：解冻闭环
    const balanceRows = token.aborted ? [] : await balancePhase(units, cfg, token);
    const rec = token.aborted
      ? { cooling_count: 0, with_balance: 0, unfrozen: [], revive_failed: [] }
      : reconcile(poolApi, balanceRows, cfg);

    state.last_run_at = Date.now();
    state.last_result = {
      trigger,
      started_at: startedAt,
      duration_ms: state.last_run_at - startedAt,
      aborted: token.aborted,
      accounts: units.length,
      checkin_ran: !!checkinResults,
      balance_ok: balanceRows.filter((b) => b.ok).length,
      unfrozen_count: rec.unfrozen.length,
      results,
      checkin_results: checkinResults,
      balance_results: balanceRows,
      unfrozen: rec.unfrozen,
      revive_failed: rec.revive_failed,
      pool_mode: poolApi.mode,
    };
    try {
      require('./admin/auth').audit('system', 'keepalive', '',
        `${trigger}: ${units.length} 号，解冻 ${rec.unfrozen.length}${token.aborted ? '（中断）' : ''}`);
    } catch (e) { /* 审计不可用不阻塞结果 */ }
    // crit 告警推送（2026-11-06 清单项 4）：轮次结束时判一次健康面，crit>0
    // 才推——warn 是「要留意」，推消息会养成狼来了。fire-and-forget：推送
    // 挂了不阻塞本轮返回（notify.sendNotify 内部已兜错，这里再兜一层）。
    // web 账号行惰性 require web-pool（同进程标准快照；无循环依赖——
    // web-pool 不依赖 keepalive）。
    setImmediate(() => {
      try {
        const notify = require('./notify');
        if (!notify.loadConfig().enabled) return;
        const webPool = require('./web-pool');
        const crits = healthAlerts({ ka: { enabled: state.enabled, last_result: state.last_result }, webAccounts: webPool.snapshot() })
          .filter((a) => a.level === 'crit');
        if (!crits.length) return;
        const lines = crits.map((a) => `[${a.channel}] ${a.account || '—'}: ${a.message}`);
        notify.sendNotify(`【dumate2api 健康告警】${crits.length} 个危险项\n${lines.join('\n')}`)
          .then((r) => { if (!r.ok) console.warn('[keepalive] 告警推送失败:', r.error); })
          .catch(() => { /* 通知挂了不拖挂保活 */ });
      } catch (e) { /* 通知面任何异常都不影响保活轮 */ }
    });
    return state.last_result;
  } finally {
    activeRuns.delete(token);
    state.running = false;
  }
}

function snapshot() {
  return {
    enabled: state.enabled,
    hour: state.hour,
    minute: state.minute,
    jitter_minutes: state.jitter_minutes,
    warn_hours: state.warn_hours,
    sem_cap: state.sem_cap,
    per_account_delay_ms: state.per_account_delay_ms,
    balance_threshold: state.balance_threshold,
    checkin: state.checkin,
    last_run_at: state.last_run_at,
    last_result: state.last_result,
    next_run_at: state.next_run_at,
    running: state.running,
    // A 包 pool 接入状态：stub = 接口假设尚未校准（见文件头），pool = 已切真
    pool_mode: resolvePool().mode,
    rationale: [
      'token 只被动刷新的问题：长期不活跃账号过期才发现——本轮把余量低于 warn_hours 的都主动续期',
      '解冻闭环对齐 workbuddy2api：签到 → 重新查余额 → 余额>0 且在冷却 → pool.revive',
      `余额阶段并发上限 ${state.sem_cap}、worker 起跑错开；刷新阶段串行、账号间 ${state.per_account_delay_ms}ms`,
      `每日 ${state.hour}:${String(state.minute).padStart(2, '0')} + 0~${state.jitter_minutes} 分钟随机后延（只后延不提前，留在低峰窗口）`,
    ],
  };
}

function intIn(patch, key, min, max) {
  const v = parseInt(patch[key], 10);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${key} 需为 ${min}-${max} 的整数`);
  return v;
}

function configure(patch = {}) {
  if (patch.enabled !== undefined) state.enabled = !!patch.enabled;
  if (patch.checkin !== undefined) state.checkin = !!patch.checkin;
  if (patch.hour !== undefined) state.hour = intIn(patch, 'hour', 0, 23);
  if (patch.minute !== undefined) state.minute = intIn(patch, 'minute', 0, 59);
  if (patch.jitter_minutes !== undefined) state.jitter_minutes = intIn(patch, 'jitter_minutes', 0, 120);
  if (patch.sem_cap !== undefined) state.sem_cap = intIn(patch, 'sem_cap', 1, 8);
  if (patch.per_account_delay_ms !== undefined) {
    const v = parseInt(patch.per_account_delay_ms, 10);
    if (!Number.isInteger(v) || v < 0) throw new Error('per_account_delay_ms 需为不小于 0 的整数');
    state.per_account_delay_ms = v;
  }
  if (patch.warn_hours !== undefined) {
    const v = Number(patch.warn_hours);
    if (!Number.isFinite(v) || v < 0) throw new Error('warn_hours 需为不小于 0 的数字');
    state.warn_hours = v;
  }
  if (patch.balance_threshold !== undefined) {
    const v = Number(patch.balance_threshold);
    if (!Number.isFinite(v) || v < 0) throw new Error('balance_threshold 需为不小于 0 的数字');
    state.balance_threshold = v;
  }
  schedule();
  saveConfig();
  return snapshot();
}

module.exports = {
  schedule, stop, runOnce, snapshot, configure, state, setAdapters, setPool,
  // 测试/集成专用：排程纯函数、pool 对接层、可取消原语
  internals: { computeNextRunAt, normalizePool, makeToken, sleepCtx, expireWarn, reconcile, balancePhase, armAt, shouldCatchup, healthAlerts },
};
