// src/traework/credits.js - TRAE Work 逐请求积分归因（按账号的消耗游标）
//
// 为什么不能直接用上游账单归因：ide_user_ent_usage 只给**累计值**
// （usage_summary.consumed_amount），没有逐笔流水，拿不到「这一条请求花了多少」。
//
// 做法与 points-cursor.js 同构：每条请求结束后记一次该账号的累计已消耗，
// 同一账号相邻两次的差值 = 后一条请求的成本。三个理由缺一不可：
//   1. **必须用 consumed 而不是 remain**：remain 会因签到 / 充值回升，
//      差值会算出负数；consumed 单调不减，只会被消耗推高。
//   2. **每账号一条串行队列**：丢一条游标会让下一条的差值跨过两条请求，
//      静默算错——宁可排队也不缺档。
//   3. **采集在响应发出之后**：请求本身要几秒，提前读会读到还没结算的状态。
//
// TRAE 与千问的关键差别：**它是多账号**（凭证自持），所以游标必须按账号分开，
// 且归因记录要带上账号——「哪个账号花了多少」正是这个通道最要紧的信息。
const fs = require('fs');
const path = require('path');
const checkin = require('./checkin');
const jsonl = require('../jsonl');

const FILE = 'traework-credits.jsonl';

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
}

function filePath() {
  return path.join(dataDir(), FILE);
}

function append(entry) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    // 大小轮转（jsonl.js）：逐请求归因文件不设限会无限增长
    jsonl.append(filePath(), `${JSON.stringify(entry)}\n`);
  } catch (e) { /* 埋点失败绝不影响正在转发的响应 */ }
}

// 每账号一条串行队列，key 是账号 id
const queues = new Map();

// 归因节流（审计 P1-4）：每条请求一次上游 usage 查询，匿名刷网关等于把
// 上游额度查询接口打满。TTL 内同一账号只实测一次，窗口内的请求不落归因
// 记录，窗口两端的 consumed 差值涵盖期间消耗总量。DUMATE_TRAEWORK_CREDIT_TTL_MS 可调。
const CAPTURE_TTL_MS = Math.max(0, parseInt(process.env.DUMATE_TRAEWORK_CREDIT_TTL_MS || '60000', 10));
const lastCaptureAt = new Map();

/**
 * 采集一次请求后的账号消耗游标。**必须在请求完成之后调用**。
 *
 * @param {object} account 本次实际使用的账号（多账号下必须记下来源）
 * @param {object} [opts]
 * @param {string} [opts.reqId] 请求埋点的 req_id。两边靠它精确配对——
 *   归因要等额度接口返回，ts 必然晚于埋点，靠时间猜会串账。
 * @param {string} [opts.model] 模型名
 * @param {number} [opts.startedAt] 请求开始时刻
 * @returns {Promise<object|null>}
 */
function capture(account, opts = {}) {
  if (!account || account.id == null) return Promise.resolve(null);
  const key = String(account.id);
  // 节流窗口内不打上游、不落归因
  const last = lastCaptureAt.get(key) || 0;
  if (CAPTURE_TTL_MS && Date.now() - last < CAPTURE_TTL_MS) return Promise.resolve(null);
  lastCaptureAt.set(key, Date.now());
  const run = async () => {
    const u = await checkin.usage(account);
    // 国际版订阅制（2026-11-03）：没有 usage_summary、consumed 恒 null——
    // 差值口径不适用，但**请求本身要落账**（逐笔明细的区域区分靠它），
    // 标 intl 让前端显示「订阅制不计积分」而不是「无参照点」。
    // 国内存量行为 consumed null 的话 computeCosts 会断链处理，不会编差值
    const isIntl = require('./constants').regionOf(account) === 'intl';
    // 取不到就不落记录。**不补 0**——0 会被读成「这次没花钱」，
    // 而真相是没测到；下一条请求的差值会跨过这一条，界面靠并发/缺档标注体现
    if (!u.ok || (u.consumed == null && !isIntl)) return null;
    const entry = {
      ts: Date.now(),
      req_id: opts.reqId || '',
      account_id: account.id,
      account: account.nickname || account.uid || `账号 ${account.id}`,
      model: opts.model || '',
      ms: opts.startedAt ? Date.now() - opts.startedAt : null,
      // 累计已消耗：差值算成本靠它（单调不减）。国际订阅制恒 null
      consumed: u.consumed,
      remain: u.remain,
      limit: u.limit,
      ...(isIntl ? { intl: true } : {}),
    };
    append(entry);
    return entry;
  };
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(run, run);
  queues.set(key, next.catch(() => {}));
  return next;
}

/** 读归因历史 */
function readHistory() {
  try {
    return fs.readFileSync(filePath(), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

/** 按 req_id 建索引，供请求日志按条附上消耗。同 id 取最后一条 */
function indexByReqId() {
  const map = new Map();
  for (const r of readHistory()) {
    if (r && r.req_id) map.set(r.req_id, r);
  }
  return map;
}

/**
 * 算出每条请求的成本：同一账号相邻两条 consumed 的差值。
 *
 * 抽成共用函数是因为要服务的入口不止一个（请求日志附成本、按天聚合、
 * 逐笔明细），三处各写一遍必然漂移——某处改了负值处理而另一处没改，
 * 同一份数据在界面上会出现两个数。
 *
 * @returns {{rows: object[], delta: object, inexact: Set<string>}}
 *   rows 是全量归因记录；delta 按 req_id 给出成本；inexact 是与相邻
 *   请求并发、差值可能含对方消耗的那批 req_id。
 */
function computeCosts() {
  const rows = readHistory();
  const byAcc = {};
  for (const r of rows) {
    const k = String(r.account_id);
    (byAcc[k] = byAcc[k] || []).push(r);
  }

  const delta = {};
  const inexact = new Set();
  for (const k of Object.keys(byAcc)) {
    const list = byAcc[k].sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < list.length; i++) {
      // 国际订阅行（或任何 consumed 缺失的行）没有游标——差值链在它处断开，
      // 不把 null 当 0 算（JS 里 null 参与减法会静默变 0，下游账号的成本
      // 会被编成全额累计值）。断链只少算不编造，符合「宁可缺档」口径
      if (list[i].consumed == null || list[i - 1].consumed == null) continue;
      const d = list[i].consumed - list[i - 1].consumed;
      // 负数说明账号换过 / 上游重置过累计值，这种情况不硬算
      if (Number.isFinite(d) && d >= 0) {
        delta[list[i].req_id] = Math.round(d * 10000) / 10000;
      }
    }
    // 区间相交 = 并发，差值可能含对方的消耗
    for (let i = 0; i < list.length; i++) {
      const aStart = list[i].ts - (list[i].ms || 0);
      for (let j = i + 1; j < list.length; j++) {
        if (list[j].ts - (list[j].ms || 0) < list[i].ts) {
          inexact.add(list[i].req_id);
          inexact.add(list[j].req_id);
        } else break;
      }
    }
  }
  return { rows, delta, inexact };
}

/** 本地日期键 YYYY-MM-DD。按本地时区切天，与界面显示的日期一致 */
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 按天聚合消耗（供仪表盘趋势图）。
 *
 * **成本取差值而不是 consumed**：consumed 是累计值，直接按天求和等于把
 * 历史总量重复计入每一天。差值才是「这一天花了多少」。
 * 每个账号的首条没有参照点，不计入任何一天——宁可少算也不编。
 */
function dailyUsage(days) {
  const { rows, delta, inexact } = computeCosts();
  const since = Date.now() - days * 86400000;
  const byDay = new Map();
  for (const r of rows) {
    if (!r || r.ts < since) continue;
    const key = dayKey(r.ts);
    const cur = byDay.get(key) || { day: key, cost: 0, requests: 0, concurrent: 0 };
    if (r.req_id in delta) cur.cost += delta[r.req_id];
    cur.requests += 1;
    if (inexact.has(r.req_id)) cur.concurrent += 1;
    byDay.set(key, cur);
  }
  // 补齐没有请求的日期，否则折线图会把间隔压掉
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(Date.now() - i * 86400000);
    const cur = byDay.get(key) || { day: key, cost: 0, requests: 0, concurrent: 0 };
    out.push({
      day: key,
      cost: Number(cur.cost.toFixed(4)),
      requests: cur.requests,
      concurrent: cur.concurrent,
    });
  }
  return out;
}

/** 今日消耗（按本地日期），供仪表盘指标卡 */
function todayUsage() {
  const { rows, delta, inexact } = computeCosts();
  const today = dayKey(Date.now());
  let cost = 0; let n = 0; let concurrent = 0;
  for (const r of rows) {
    if (!r || dayKey(r.ts) !== today) continue;
    if (r.req_id in delta) cost += delta[r.req_id];
    n += 1;
    if (inexact.has(r.req_id)) concurrent += 1;
  }
  return {
    cost: Number(cost.toFixed(4)),
    requests: n,
    concurrent,
  };
}

/** 逐笔明细（按时间倒序），供仪表盘表格 */
function creditRecords(limit) {
  const { rows, delta, inexact } = computeCosts();
  // 区域随行给（2026-11-03 国际版）：积分明细/用量按国内/国际区分的数据源。
  // 按账号 id 回查；账号已删除的旧行如实空串，不猜。
  let regions = null;
  try {
    const authStore = require('./auth');
    regions = new Map(authStore.list().map((a) => [a.id, a.region || 'cn']));
  } catch (e) { regions = null; }
  return rows
    .slice()
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit)
    .map((r) => ({
      ts: r.ts,
      req_id: r.req_id || '',
      account: r.account || '',
      account_id: r.account_id,
      region: regions && r.account_id != null ? (regions.get(r.account_id) || '') : '',
      model: r.model || '',
      ms: r.ms ?? null,
      // 成本可能为 null（首条无参照点），如实留空而不是补 0
      cost: r.req_id in delta ? delta[r.req_id] : null,
      exact: !inexact.has(r.req_id),
      consumed: r.consumed ?? null,
      remain: r.remain ?? null,
      limit: r.limit ?? null,
    }));
}

/**
 * 给请求日志里 channel=traework 的行附上「真实消耗 + 是哪个账号」。
 *
 * 差值是「同一账号上一条请求的累计已消耗」到「这一条」的增量，所以每个
 * 账号的第一条没有值（没有参照点），如实留空而不是补 0。
 *
 * 并发判定与 points-cursor 同理：两条请求的执行区间有交集时，增量会把
 * 对方的消耗算进来，总和正确、单项不准，标记出来而不是假装精确。
 */
function attachCosts(pageRows) {
  const { rows, delta, inexact } = computeCosts();
  if (!rows.length) return pageRows;

  const idx = indexByReqId();
  return pageRows.map((r) => {
    if (r.channel !== 'traework') return r;
    const c = idx.get(r.req_id);
    const out = {
      ...r,
      // 消耗与账号都从归因记录取：账号是**实际使用**的那个，
      // 而不是「当前池里的第一个」——多账号下两者不是一回事
      tw_account: c ? c.account : '',
      tw_consumed: c ? c.consumed : null,
      tw_remain: c ? c.remain : null,
      tw_limit: c ? c.limit : null,
    };
    if (r.req_id in delta) {
      out.tw_cost = delta[r.req_id];
      out.tw_exact = !inexact.has(r.req_id);
    }
    return out;
  });
}

module.exports = {
  capture, readHistory, indexByReqId, attachCosts,
  computeCosts, dailyUsage, todayUsage, creditRecords, dayKey,
  FILE, filePath,
};
