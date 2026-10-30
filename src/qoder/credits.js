// src/qoder/credits.js - Qoder 逐请求积分归因（上游直给 credits）
//
// 与千问 / TRAE 的关键差别：**Qoder 的 usage 直接返回本条请求的 credits**
// （`倍率 × tokens/1000`），是三条直连通道里唯一能精确归因单条请求的。
// 千问要读余额差、TRAE 要读 consumed 游标，都只能算「与上一条的差值」，
// 第一条没有参照点、并发时还会串账——Qoder 没有这些问题。
//
// 所以这里**不做游标差值**，只做「按 req_id 落一条」。落盘失败绝不影响响应。
const fs = require('fs');
const path = require('path');
const jsonl = require('../jsonl');

const FILE = 'qoder-credits.jsonl';

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
  } catch (e) { /* 埋点失败绝不影响已发出的响应 */ }
}

/**
 * 记一条请求的消耗。
 *
 * @param {object} account 本次实际使用的账号（多账号下必须记下来源）
 * @param {number|null} credits 上游 usage.credits。**null 就如实留空不落 0**
 *   ——0 会被读成「这次没花钱」，而真相是没测到。
 * @param {object} [opts] { reqId, model, ms, tokens }
 */
/**
 * 实测倍率：credits ÷ (tokens/1000)。
 *
 * 上游静默改路由的可见性（融合自 qoder2api-hub #113 的 billed_model 思路，
 * 保守版）：Qoder 响应的 model 恒为 "auto"，请求的模型可能被服务端换掉。
 * 直接比对「实测倍率 vs 模型表 price_factor」**不做自动判定**——错峰优惠
 * （discountFactor）会合法改变倍率而我们不确定乘性方向（CLAUDE.md 明确
 * 不解读），自动判会误报；把实测值记进账本，比对交给管理端人工探针。
 *
 * @param {number} credits 上游 usage 直给的消耗
 * @param {object|null} usage 同帧的 usage（total_tokens 或 prompt+completion）
 * @param {number|null} expectedRate 模型表的 price_factor
 * @returns {number|null} 无 credits / 无 tokens / 无期望倍率时如实 null
 */
function computeBilledRate(credits, usage, expectedRate) {
  if (typeof credits !== 'number' || !Number.isFinite(credits)) return null;
  const u = usage && typeof usage === 'object' ? usage : {};
  const tokens = Number(u.total_tokens)
    || (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0);
  if (!(tokens > 0)) return null;
  const rate = Number(expectedRate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.round((credits / (tokens / 1000)) * 10000) / 10000;
}

function capture(account, credits, opts = {}) {
  // 只认真正的数值：字符串 "abc" 会被 Number() 转成 NaN 从而挡掉，
  // 但 "0.5" 会强转成功——调用方传错类型时宁可不记，也不要记一笔可疑的数
  if (typeof credits !== 'number' || !Number.isFinite(credits)) return null;
  const entry = {
    ts: Date.now(),
    req_id: opts.reqId || '',
    account_id: account && account.id != null ? account.id : null,
    account: (account && (account.nickname || account.uid)) || '',
    model: opts.model || '',
    ms: opts.ms ?? null,
    // 上游直给的单条消耗，不需要与相邻记录做差
    credits: Math.round(Number(credits) * 10000) / 10000,
    exact: true,
  };
  // 实测倍率（computeBilledRate 的说明——上游改路由的可见性数据源）
  if (opts.billedRate != null) entry.billed_rate = opts.billedRate;
  append(entry);
  return entry;
}

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
 * 给请求日志里 channel=qoder 的行附上「真实消耗 + 是哪个账号」。
 *
 * 与 TRAE 的 attachCosts 同定位，但**不标并发**——Qoder 的 credits 是上游
 * 按本条请求算的，不受相邻请求影响，没有「差值可能含别人消耗」这回事。
 */
function attachCosts(pageRows) {
  const rows = readHistory();
  if (!rows.length) return pageRows;
  const idx = indexByReqId();
  return pageRows.map((r) => {
    if (r.channel !== 'qoder') return r;
    const c = idx.get(r.req_id);
    if (!c) return r;
    return {
      ...r,
      qoder_cost: c.credits,
      qoder_account: c.account || '',
    };
  });
}

/** 本地日期键 YYYY-MM-DD。按本地时区切天，与界面显示的日期一致 */
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 今日消耗（按本地日期），供仪表盘指标卡 */
function todayUsage() {
  const today = dayKey(Date.now());
  let cost = 0; let n = 0;
  for (const r of readHistory()) {
    if (!r || dayKey(r.ts) !== today) continue;
    cost += Number(r.credits || 0);
    n += 1;
  }
  return { cost: Number(cost.toFixed(4)), requests: n, concurrent: 0 };
}

/**
 * 账本最早一条的时刻。
 *
 * **为什么必须给**：本功能上线前经网关的请求没有逐笔记录，无法追溯（上游
 * 没有按请求的历史账单接口）。不给这个起点的话，「合计 0.0259」会被读成
 * 「总共只消耗了这么点」，而真相是绝大多数消耗发生在起点之前。
 * 账本为空时返回 null，界面无法显示。
 */
function since() {
  let min = null;
  for (const r of readHistory()) {
    if (r && typeof r.ts === 'number' && (min == null || r.ts < min)) min = r.ts;
  }
  return min;
}

/** 逐笔明细（按时间倒序），供仪表盘表格 */
function creditRecords(limit) {
  return readHistory()
    .slice()
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit)
    .map((r) => ({
      ts: r.ts,
      req_id: r.req_id || '',
      account: r.account || '',
      account_id: r.account_id,
      model: r.model || '',
      ms: r.ms ?? null,
      cost: r.credits ?? null,
      // 上游直给，恒为精确值（与 TRAE 的游标差不同源）
      exact: true,
    }));
}

module.exports = {
  capture, readHistory, indexByReqId, attachCosts, todayUsage, creditRecords, since, dayKey,
  computeBilledRate,
  FILE, filePath,
};
