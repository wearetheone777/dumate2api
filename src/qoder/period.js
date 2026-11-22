// src/qoder/period.js - 订阅周期感知的统计口径（P1-10）
//
// 出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P1-10「订阅周期感知的统计口径
// （本地累计不被周期切换污染）」（EchoPing07 的规则密度最高的一节）。
//
// **要修的真问题**：本地账本（`credits.js`）是**无界累计**——`since()` 给的是
// 账本最早时刻，`todayUsage` 只按自然日。于是「本周期扣了多少」这个问题
// 没有答案：跨过重置点后总量继续累加，用户看到的是一个越来越大的数字，
// 而套餐额度其实已经刷新了。
//
// **四条边界治理规则**（照抄 EchoPing07，每条都有具体故障对应）：
//   1. **重置时刻以 `/user/status` 的 `nextResetAt` 为权威**，`expiresAt` 只兜底；
//      且**必须 < 2100-01-01 才采纳**——无期限套餐填 `9999-12-31` 哨兵值，
//      直接采纳会让「本周期」永远不到期。
//   2. **首次拿到边界保留已累计值**——刚启用周期统计时不应该把之前花的钱
//      算成「本周期 0」。
//   3. **边界未推进直接忽略**（上游接口有缓存，可能报旧值）；**前进 < 7 天
//      视为同一周期**（不清零）；**≥ 7 天才判定真实续期并清零**。
//      阈值取 7 天：月付周期一次前进约 30 天，日付/周付不会出现「前进 3 天」
//      这种形态——真出现说明是同一周期的抖动。
//   4. **均值分母是 `billed_requests`**（仅 `billable=true` 的 usage 帧），
//      不是请求总数——总数含失败/免费帧/断流无 usage 帧，会低估均价。
//
// 状态落 `data/qoder-period.json`（原子写 + filelock），键是**账号 id**：
// 每个账号的订阅周期各自独立（多账号下不能共用一个边界）。
'use strict';

const fs = require('fs');
const path = require('path');
const filelock = require('../filelock');

const FILE = 'qoder-period.json';
/** 哨兵值上限：>= 此值的时间戳视为「无期限」，不采纳 */
const SENTINEL_MS = Date.UTC(2100, 0, 1);
/** 边界前进多少才判定为「真实续期」（小于此值视为同周期抖动） */
const RENEW_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
}

function filePath() {
  if (process.env.DUMATE_QODER_PERIOD_FILE) return process.env.DUMATE_QODER_PERIOD_FILE;
  return path.join(dataDir(), FILE);
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (e) { return {}; }
}

function save(data) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const target = filePath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    filelock.renameAtomic(tmp, target);
    return true;
  } catch (e) { return false; }
}

/**
 * 解析上游给的周期边界（纯函数）。
 *
 * **优先级**：`nextResetAt`（权威）→ `expiresAt`（兜底）。两者都可能缺。
 * **哨兵过滤**：≥ 2100-01-01 一律当「无期限」，返回 null 而不是一个假边界。
 *
 * @param {object} src `/user/status` 或 `/api/v2/user/plan` 的响应
 * @returns {{at:number|null, source:'nextResetAt'|'expiresAt'|'', raw:any}}
 */
function parseBoundary(src, now = Date.now()) {
  const out = { at: null, source: '', raw: null };
  if (!src || typeof src !== 'object') return out;
  // 上游两种写法都见过：秒 / 毫秒 / ISO 字符串
  const toMs = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || v <= 0) return null;
      // < 1e12 按秒解释（2026 年的秒级时间戳约 1.7e9）
      return v < 1e12 ? v * 1000 : v;
    }
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? t : null;
  };
  for (const key of ['nextResetAt', 'next_reset_at', 'resetAt', 'periodEnd']) {
    const ms = toMs(src[key]);
    if (ms != null) {
      if (ms >= SENTINEL_MS) return { at: null, source: '', raw: src[key] };
      return { at: ms, source: 'nextResetAt', raw: src[key] };
    }
  }
  for (const key of ['expiresAt', 'expires_at', 'expireTime']) {
    const ms = toMs(src[key]);
    if (ms != null) {
      if (ms >= SENTINEL_MS) return { at: null, source: '', raw: src[key] };
      // expiresAt 兜底：**已过期的也采纳**（它是「本周期什么时候结束」的
      // 最后已知值，丢掉会让统计退回无界累计）
      return { at: ms, source: 'expiresAt', raw: src[key] };
    }
  }
  return out;
}

/**
 * 边界变更的**接受规则**（纯函数，本模块的核心）。
 *
 * @param {object} prev 上次落盘的状态 `{ boundary, periodStart, observedAt }`
 * @param {number|null} next 本次读到的边界（parseBoundary 的结果）
 * @param {number} now
 * @returns {{action:'init'|'ignore'|'same'|'renew', boundary:number|null, periodStart:number|null, reason:string}}
 *   init    首次拿到边界 → **保留已累计值**（periodStart 用边界回推一个月，
 *           但不能早于边界减 31 天——宁可少算也不要把历史全算进来）
 *   ignore  边界未推进（上游缓存报旧值）→ 不动
 *   same    前进 < 7 天 → 同一周期，只更新边界
 *   renew   前进 ≥ 7 天 → 真实续期，**periodStart 改为新边界回推**
 */
function decideBoundary(prev, next, now = Date.now()) {
  const oldAt = prev && Number.isFinite(Number(prev.boundary)) ? Number(prev.boundary) : null;
  // 没读到边界：不动（不能因为一次读不到就把累计清零）
  if (!Number.isFinite(Number(next)) || Number(next) <= 0) {
    if (oldAt) {
      return { action: 'ignore', boundary: oldAt, periodStart: prev.periodStart || null, reason: '本次没读到边界，保留旧值' };
    }
    return { action: 'init', boundary: null, periodStart: null, reason: '从未读到边界' };
  }
  const at = Number(next);
  if (!oldAt) {
    // **首次拿到边界：保留已累计值**。periodStart 用「边界 − 31 天」回推。
    // 只在回推值落到**未来**时夹到 now——那是「边界就在眼前」的形态，
    // 回推出的起点不可能成立；正常情况（边界在几周后）不夹，否则会把
    // 本周期头几天的消耗算丢。
    const guess = at - 31 * 86400000;
    return {
      action: 'init',
      boundary: at,
      periodStart: guess > now ? now : guess,
      reason: '首次拿到边界：保留已累计值，周期起点按 31 天回推',
    };
  }
  if (at === oldAt) {
    return { action: 'ignore', boundary: oldAt, periodStart: prev.periodStart || null, reason: '边界未变' };
  }
  if (at < oldAt) {
    // 后退：上游缓存报旧值（或换了套餐）。**不动**——按旧边界继续统计，
    // 直到它真的推进到 newer 值。
    return { action: 'ignore', boundary: oldAt, periodStart: prev.periodStart || null, reason: `边界后退（${oldAt} → ${at}），按缓存旧值处理` };
  }
  const delta = at - oldAt;
  if (delta < RENEW_THRESHOLD_MS) {
    // 前进不足 7 天：同一周期内的抖动（上游可能按小时滚动 nextResetAt）
    return { action: 'same', boundary: at, periodStart: prev.periodStart || oldAt, reason: `边界前进 ${Math.round(delta / 3600000)}h，不足 7 天，视为同周期` };
  }
  // 真实续期：新周期从「新边界 − 一个周期长度」开始。周期长度按旧边界回推的
  // 实际跨度估（月付约 30 天），没有旧 periodStart 时退回 31 天。
  const span = (prev.periodStart && oldAt > prev.periodStart) ? (oldAt - prev.periodStart) : 31 * 86400000;
  return {
    action: 'renew',
    boundary: at,
    periodStart: at - span,
    reason: `边界前进 ${Math.round(delta / 86400000)} 天 → 判定真实续期，周期清零`,
  };
}

/**
 * 读一次上游边界并更新状态。**失败不改状态**（宁可这次不更新，
 * 也不要因为一次网络抖动把周期清零）。
 *
 * @param {number|string} accountId
 * @param {object} src 上游响应（`/user/status` 或 plan）
 * @param {number} [now]
 */
function observe(accountId, src, now = Date.now()) {
  const key = String(accountId);
  const parsed = parseBoundary(src, now);
  return filelock.withLock(filePath(), () => {
    const data = load();
    const prev = data[key] || null;
    const d = decideBoundary(prev, parsed.at, now);
    data[key] = {
      boundary: d.boundary,
      periodStart: d.periodStart,
      observedAt: now,
      source: parsed.source || (prev && prev.source) || '',
      lastAction: d.action,
      lastReason: d.reason,
    };
    save(data);
    return { ...d, source: data[key].source, observedAt: now };
  });
}

/** 读某账号的周期状态（不触发网络）。没有记录返回 null */
function stateOf(accountId) {
  const hit = load()[String(accountId)];
  return hit || null;
}

/**
 * 把账本行按周期切分（纯函数）。
 *
 * 口径：`periodStart <= ts` 的算本周期。**periodStart 为 null 时全算**
 * （没有周期信息时不该假装有，如实按全量给并标 `bounded:false`）。
 *
 * @param {Array} rows `credits.readHistory()` 的行（带 ts / credits / billable）
 * @param {{periodStart?:number|null, accountId?:number|null}} opts
 */
function summarize(rows, opts = {}) {
  // **null 必须与 0 区分**：`Number(null) === 0`，直接 Number 会把「没有周期
  // 信息」变成「本周期从 1970 年开始」（全量都算进来还标 bounded=true）。
  // 这正是本项目反复强调的「null ≠ 0」，在切分入口最容易犯。
  const rawStart = opts.periodStart;
  const start = (rawStart != null && Number.isFinite(Number(rawStart))) ? Number(rawStart) : null;
  const wantAcc = opts.accountId != null ? Number(opts.accountId) : null;
  let cost = 0;
  let requests = 0;
  // **均值分母只数 billable**：总数含失败/免费帧/断流无 usage 帧，会低估均价
  let billed = 0;
  let billedCost = 0;
  for (const r of (rows || [])) {
    if (!r || typeof r.ts !== 'number') continue;
    if (wantAcc != null && Number(r.account_id) !== wantAcc) continue;
    if (start != null && r.ts < start) continue;
    const c = Number(r.credits);
    requests++;
    if (Number.isFinite(c)) {
      cost += c;
      // billable 字段缺失时按「有 credits 就算计费」处理（老账本没有这个字段）
      if (r.billable !== false) { billed++; billedCost += c; }
    }
  }
  return {
    // bounded=false 表示「没有周期信息，这是全量累计」——界面必须标出来，
    // 否则会被读成「本周期只花了这么多」
    bounded: start != null,
    periodStart: start,
    cost: Math.round(cost * 10000) / 10000,
    requests,
    billedRequests: billed,
    billedCost: Math.round(billedCost * 10000) / 10000,
    // 每千 token 成本这类「均价」用 billed 口径（见文件头第 4 条）
    avgPerBilledRequest: billed > 0 ? Math.round((billedCost / billed) * 10000) / 10000 : null,
  };
}

module.exports = {
  FILE, SENTINEL_MS, RENEW_THRESHOLD_MS,
  filePath, load, save, parseBoundary, decideBoundary, observe, stateOf, summarize,
};
