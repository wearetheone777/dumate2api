// src/traework/makeup.js - 「今天还没签的账号」判定（纯函数，2026-11-16 调研 P1-8）
//
// ## 为什么需要它
//
// 后台排程有两种「整天不签」的失败形态，都不是靠重试能救的，因为**根本没人跑**：
//   1. 进程在 09:17 之后才启动（`admin/routes/autotask.js` 的 `nextRunAt()`
//      会把已过的时刻顺延到明天）；
//   2. 机器在 09:17 时睡眠/关机，定时器没触发，醒来后同样顺延。
// TRAE 侧的 `task-scheduler` 是「从现在起每 30 分钟」，重启后会自然补上，
// 但它**默认关闭**，关着的时候同样一整天没人签。
//
// 于是需要一个不依赖排程的、用户可见的答案：「今天哪些账号还没签到」。
// 这个文件只做**判定**（纯函数），跑签到留在调用方（路由 / 调度器），
// 这样判定可以离线单测，而「跑」沿用既有的 `checkinAndSave`（幂等）。
//
// ## 「今天签过了」的两条证据，缺一不可
//
//   a. 本地签到账本（`checkin-ledger.jsonl`）今天有该账号的行 —— 主口径。
//      注意**两种行都算签过**：`source:'claim'`（我们领的）与 `source:'already'`
//      （上游说已签，比如用户在 TRAE 客户端里签过）。
//   b. 账号上的 `lastCheckin` 落在今天 —— 补口径。账本只从功能上线那天开始有，
//      更早签到成功的账号在账本里可能一条都没有；只有 (a) 会把它们判成「没签」，
//      于是每次补签都要多打一次上游（虽然幂等，但没必要）。
//
// 两条都不成立才进 due。**不确定就当作已签**这条不采用——那会让真没签的号
// 永远不补，而这里是「多问一次上游」的产品，代价不对称。
const ledger = require('../checkin-ledger');

/** 默认窗口：签到时刻（09:17）之后、当天结束前。超过就不再补（避免零点前后跨日混乱） */
const DEFAULT_WINDOW = { startHour: 9, startMinute: 17, endHour: 23, endMinute: 30 };

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 该时刻在当天的分钟数 */
function minuteOfDay(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 补签窗口状态。
 * @param {{now?:number, window?:object}} [opts]
 * @returns {{open:boolean, reason:string, startMin:number, endMin:number}}
 */
function windowState(opts = {}) {
  const w = { ...DEFAULT_WINDOW, ...(opts.window || {}) };
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const startMin = w.startHour * 60 + w.startMinute;
  const endMin = w.endHour * 60 + w.endMinute;
  const cur = minuteOfDay(now);
  const label = `${pad(w.startHour)}:${pad(w.startMinute)}–${pad(w.endHour)}:${pad(w.endMinute)}`;
  if (cur < startMin) return { open: false, reason: `未到补签窗口（${label}）`, startMin, endMin };
  if (cur > endMin) return { open: false, reason: `补签窗口已过（${label}）`, startMin, endMin };
  return { open: true, reason: '', startMin, endMin };
}

/** 该账号今天是否已签（见头注释的两条证据） */
function signedToday(account, day, rowsByAccount) {
  const id = Number(account && account.id);
  const rows = rowsByAccount.get(id);
  if (rows && rows.length) return { signed: true, why: 'ledger' };
  const lc = Number(account && account.lastCheckin);
  if (Number.isFinite(lc) && lc > 0 && ledger.dayOf(lc) === day) return { signed: true, why: 'lastCheckin' };
  return { signed: false, why: '' };
}

/**
 * 算出今天该补签谁。
 *
 * @param {object} p
 * @param {Array}  p.accounts  账号列表（authStore 的记录；`enabled` 为 false 的会被跳过）
 * @param {Array}  [p.rows]    今日的账本行（`ledger.rowsInRange({channel:'traework'})` 的产物）
 * @param {number} [p.now]     注入时钟
 * @param {object} [p.window]  覆盖窗口
 * @param {Array<number>} [p.ids] 只处理这些账号（手动补签指定账号时用）
 * @returns {{day:string, window:{open:boolean,reason:string}, due:Array, skipped:Array,
 *            counts:{total:number,due:number,signed:number,disabled:number,outside:number}}}
 */
function plan(p = {}) {
  const now = typeof p.now === 'number' ? p.now : Date.now();
  const day = ledger.dayOf(now);
  const win = windowState({ now, window: p.window });
  const accounts = Array.isArray(p.accounts) ? p.accounts : [];
  const wanted = Array.isArray(p.ids) && p.ids.length
    ? new Set(p.ids.map((x) => Number(x)).filter((n) => Number.isFinite(n)))
    : null;

  const rowsByAccount = new Map();
  for (const r of (Array.isArray(p.rows) ? p.rows : [])) {
    if (!r || r.channel !== 'traework') continue;
    if (ledger.dayOf(r.at || 0) !== day) continue;
    const id = Number(r.account_id);
    if (!Number.isFinite(id)) continue;
    if (!rowsByAccount.has(id)) rowsByAccount.set(id, []);
    rowsByAccount.get(id).push(r);
  }

  const due = [];
  const skipped = [];
  const counts = { total: accounts.length, due: 0, signed: 0, disabled: 0, outside: 0 };

  for (const a of accounts) {
    const id = Number(a && a.id);
    const name = (a && (a.nickname || a.uid)) || `账号 ${id}`;
    if (wanted && !wanted.has(id)) continue;
    if (a && a.enabled === false) {
      counts.disabled += 1;
      skipped.push({ id, name, reason: 'disabled', detail: '账号已停用（停用不参与签到）' });
      continue;
    }
    const st = signedToday(a, day, rowsByAccount);
    if (st.signed) {
      counts.signed += 1;
      skipped.push({
        id, name, reason: 'already',
        detail: st.why === 'ledger' ? '今天已有签到记录' : '账号 lastCheckin 是今天',
      });
      continue;
    }
    if (!win.open) {
      counts.outside += 1;
      skipped.push({ id, name, reason: 'outside_window', detail: win.reason });
      continue;
    }
    counts.due += 1;
    due.push({ id, name });
  }

  return { day, window: { open: win.open, reason: win.reason }, due, skipped, counts };
}

/**
 * 每日定时任务的**补跑判定**（`admin/routes/autotask.js` 用；纯函数便于单测）。
 *
 * 原实现 `nextRunAt()` 把「今天已过的时刻」顺延到明天，于是进程 9:17 之后启动、
 * 或机器那时在睡眠，当天就整天空转。这里补的是「今天该跑但没跑过」这一种，
 * 判据只有两条：**今天的时间点已过** + **今天还没跑过**（`lastRunDay` 落盘）。
 *
 * @param {{enabled?:boolean, hour?:number, minute?:number, now?:number, lastRunDay?:string}} p
 * @returns {{run:boolean, reason:string, day:string, dueAt:number}}
 */
function shouldCatchUp(p = {}) {
  const now = typeof p.now === 'number' ? p.now : Date.now();
  const day = ledger.dayOf(now);
  const hour = Number.isInteger(p.hour) ? p.hour : 9;
  const minute = Number.isInteger(p.minute) ? p.minute : 17;
  const dueAt = new Date(now);
  dueAt.setHours(hour, minute, 0, 0);
  const out = { run: false, reason: '', day, dueAt: dueAt.getTime() };
  if (!p.enabled) { out.reason = '自动签到未开启'; return out; }
  if (now < dueAt.getTime()) { out.reason = '今天的时间点还没到（等定时器）'; return out; }
  if (p.lastRunDay === day) { out.reason = '今天已经跑过'; return out; }
  out.run = true;
  out.reason = '今天的时间点已过但还没跑过（进程晚启动或机器睡眠）→ 立即补跑';
  return out;
}

module.exports = { plan, windowState, signedToday, shouldCatchUp, DEFAULT_WINDOW, minuteOfDay };
