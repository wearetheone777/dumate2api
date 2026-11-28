// src/workbuddy/usage.js - 官方逐请求用量账本（P1-6，2026-11-28 融合批）
//
// 端点（xu20060420 usage_official.go 取证 + 2026-11-28 本批克隆核对）：
//   POST {chatBase}/billing/meter/get-user-request-usage
//     body {"startTime":"RFC3339(+08:00)","endTime":"RFC3339","pageNum":1,"pageSize":100}
//     resp {"code":0,"data":{"total":N,"data":[{requestId,credit,model,client,
//           requestTime:"YYYY-MM-DD HH:mm:ss",agentPurpose?}]}}
//   CN/global 同路径、无 /v2 前缀（/v2/billing/... 实测 404）；分页字段是
//   pageNum/pageSize（page/page_size 不认）；startTime/endTime 必须是 RFC3339
//   带时区字符串（传数字/纯日期报 invalid params）。
//
// 分页终止判据：「本页条数 < pageSize」为主——上游部分域 Total 恒 0，只看 Total
// 会首页就断（统计了前 100 条还没有任何提示）。第 2 页起失败记 error + truncated
// ——「统计了前半段」必须可见，绝不能静默少算（计费视图最忌）。
//
// **只读不写**。R2 两本账：本模块是官方账本（含客户端直连的消耗）；reqlog 是
// 网关侧账本（只覆盖经本网关的请求）。两本账不是「一个总量的两部分」，
// 覆盖范围不同，聚合时 credit 缺失的行不补 0。
'use strict';

// 单账号单次最多翻页数（pageSize=100 → 上限 1000 条/账号），防超长窗口打爆上游
const MAX_PAGES = 10;
const PAGE_SIZE = 100;
const DEFAULT_HOURS = 72;
const MAX_HOURS = 720;
const USAGE_PATH = '/billing/meter/get-user-request-usage';

/** 北京时区 (+08:00) 的 RFC3339。技巧：时间戳加 8h 后取 ISO 形状、把
 *  「.毫秒Z」整体换成 +08:00——得到的字符串就是「北京墙钟 + 正确时区」，
 *  与参考实现实测口径一致（毫秒非零时也不能漏换，否则混出 Z 形状） */
function rfc3339Cn(d) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '+08:00');
}

/** 单条记录的宽松解析（credit 缺失不补 0——聚合时如实少算并让 partial 可见） */
function parseUsageRow(it) {
  if (!it || typeof it !== 'object') return null;
  // 显式 null 与缺失同等对待：Number(null)===0 会把「不知道」洗成「免费」
  const creditNum = it.credit == null ? NaN : Number(it.credit);
  return {
    requestId: String(it.requestId || ''),
    credit: Number.isFinite(creditNum) ? creditNum : null,
    model: String(it.model || ''),
    client: String(it.client || ''),
    requestTime: String(it.requestTime || ''),
    agentPurpose: String(it.agentPurpose || ''),
  };
}

/**
 * 拉一个账号窗口内的全部用量页。
 * @returns {Promise<{ok:boolean, rows:Array, truncated:boolean, errors:string[], error:string}>}
 */
async function fetchAccountUsage(region, account, { startIso, endIso, maxPages = MAX_PAGES } = {}) {
  const growth = require('./growth');
  const out = { ok: false, rows: [], truncated: false, errors: [], error: '' };
  for (let page = 1; page <= maxPages; page++) {
    const r = await growth.postJson(region, account, USAGE_PATH, {
      startTime: startIso, endTime: endIso, pageNum: page, pageSize: PAGE_SIZE,
    });
    if (!r.ok) {
      const msg = `第 ${page} 页拉取失败: ${r.error || `HTTP ${r.status}`}`;
      if (page === 1) {
        out.error = msg; // 第一页失败 = 该账号整体失败，不产半截数据
        return out;
      }
      // 第 2 页起失败：留半截但必须可见
      out.errors.push(msg);
      out.truncated = true;
      break;
    }
    const d = (r.doc && r.doc.data) || {};
    const list = Array.isArray(d.data) ? d.data : [];
    for (const it of list) {
      const row = parseUsageRow(it);
      if (row) out.rows.push(row);
    }
    // 终止判据（双保险）：本页不满 → 到头；Total 有效且已覆盖 → 到头
    if (list.length < PAGE_SIZE) break;
    const total = Number(d.total);
    if (Number.isFinite(total) && total > 0 && page * PAGE_SIZE >= total) break;
    if (page === maxPages) {
      out.truncated = true;
      out.errors.push(`达到单账号最大页数 ${maxPages}（>${maxPages * PAGE_SIZE} 条），其余截断`);
    }
  }
  out.ok = true;
  return out;
}

/**
 * 并发拉全部账号并聚合（totals / by_account / by_model / 按日 series / errors）。
 * @param {Array<{account, region, name, id}>} targets
 * @param {{hours?:number}} opts
 */
async function fetchOfficialUsage(targets, opts = {}) {
  let hours = Number(opts.hours) || DEFAULT_HOURS;
  if (hours > MAX_HOURS) hours = MAX_HOURS;
  if (hours < 1) hours = 1;
  const now = new Date();
  const startIso = rfc3339Cn(new Date(now.getTime() - hours * 3600 * 1000));
  const endIso = rfc3339Cn(now);

  const per = await Promise.all(targets.map(async (t) => {
    const r = await fetchAccountUsage(t.region, t.account, { startIso, endIso });
    return { target: t, ...r };
  }));

  const byAccount = [];
  const byModel = new Map();
  const byDay = new Map();
  const errors = [];
  for (const p of per) {
    const row = {
      id: p.target.id, name: p.target.name, region: p.target.region,
      requests: p.rows.length,
      // credit 缺失的行不补 0：分母只累加有值的行，partial 让「部分和」可见
      creditsKnown: p.rows.filter((x) => x.credit != null).reduce((s, x) => s + x.credit, 0),
      creditsUnknown: p.rows.filter((x) => x.credit == null).length,
      truncated: p.truncated,
    };
    if (!p.ok) { row.error = p.error; row.requests = 0; errors.push({ id: p.target.id, name: p.target.name, error: p.error }); }
    byAccount.push(row);
    if (p.errors.length) errors.push({ id: p.target.id, name: p.target.name, error: p.errors.join('; ') });
    for (const x of p.rows) {
      const m = x.model || '未知';
      const mm = byModel.get(m) || { model: m, requests: 0, credits: 0, creditsUnknown: 0 };
      mm.requests++;
      if (x.credit != null) mm.credits += x.credit; else mm.creditsUnknown++;
      byModel.set(m, mm);
      const day = x.requestTime.slice(0, 10);
      const dd = byDay.get(day) || { day, requests: 0, credits: 0 };
      if (day) {
        dd.requests++;
        if (x.credit != null) dd.credits += x.credit;
        byDay.set(day, dd);
      }
    }
  }
  byAccount.sort((a, b) => b.creditsKnown - a.creditsKnown);
  const models = [...byModel.values()].sort((a, b) => b.credits - a.credits);
  const series = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  const totals = {
    requests: byAccount.reduce((s, r) => s + r.requests, 0),
    credits: byAccount.reduce((s, r) => s + r.creditsKnown, 0),
    creditsUnknown: byAccount.reduce((s, r) => s + r.creditsUnknown, 0),
    accounts: byAccount.length,
    active: byAccount.filter((r) => r.requests > 0).length,
    truncated: per.some((p) => p.truncated),
  };
  return {
    ok: true,
    window_hours: hours,
    start: startIso, end: endIso,
    totals, by_account: byAccount, by_model: models, series, errors,
    note: '官方账本（含客户端直连的消耗）。credit 缺失/0 的行如实计 creditsUnknown，不补 0、不冒充免费。',
  };
}

module.exports = { fetchAccountUsage, fetchOfficialUsage, parseUsageRow, rfc3339Cn, USAGE_PATH, MAX_PAGES, PAGE_SIZE, DEFAULT_HOURS, MAX_HOURS };
