// src/workbuddy/billing.js - 签到与额度（billing 域，仅国内版有签到）
//
// 端点（对照 checkin.rs / upstream.rs fetch_credits）：
//   签到状态：POST {billing}/v2/billing/meter/checkin-activity-status（新，
//             失败回退 /checkin-status），body {}，只读
//   执行签到：POST {billing}/v2/billing/meter/daily-checkin；「已签到」按成功
//   额度包：  POST {billing}/v2/billing/meter/get-user-resource
// **国际版签到明确不支持**（「该版本暂不支持自动签到」）——如实报错，不白打。
// 认证头走 build_auth_headers（Bearer + X-User-Id + X-Enterprise/Tenant-Id + X-Domain）。
const c = require('./constants');

/** billing 域认证头（对照 account.rs build_auth_headers；非 chat 路径） */
function authHeaders(region, account) {
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${(account && account.accessToken) || ''}`,
  };
  if (account && account.uid) h['X-User-Id'] = account.uid;
  if (account && account.enterpriseId) {
    h['X-Enterprise-Id'] = account.enterpriseId;
    h['X-Tenant-Id'] = account.enterpriseId;
  }
  if (account && account.domain) h['X-Domain'] = account.domain;
  return h;
}

/** billing 域 POST 的小包装（body 恒为 {}） */
function post(region, account, path) {
  return new Promise((resolve) => {
    const spec = c.specOf(region);
    const u = new URL(spec.billingBase + c.CHECKIN_API_PREFIX + path);
    const body = JSON.stringify({});
    let agent = null;
    try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
      return resolve({ status: 0, body: e.message });
    }
    const headers = {
      ...authHeaders(region, account),
      'Content-Length': String(Buffer.byteLength(body)),
      'User-Agent': c.CLIENT_UA,
      Origin: spec.billingBase,
      Referer: `${spec.billingBase}/`,
    };
    const req = require('https').request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers,
      ...(agent ? { agent } : {}), timeout: 30000,
    }, (res) => {
      let buf = '';
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      res.on('data', (x) => { buf += dec.write(x); });
      res.on('end', () => { buf += dec.end(); resolve({ status: res.statusCode, body: buf }); });
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.write(body);
    req.end();
  }).then((r) => {
    let doc = null;
    try { doc = JSON.parse(r.body); } catch (e) { /* 非 JSON */ }
    return { status: r.status, doc };
  });
}

/**
 * 查签到状态。新接口失败回退旧接口（checkin.rs 同款）。
 * 返回 { ok, todayCheckedIn?, dailyCredit?, todayCredit?, totalCredits?,
 *        streakDays?, streakBonusCredit?, checkinDates?, error? }
 */
async function checkinStatus(region, account) {
  if (c.normalizeRegion(region) === 'global') {
    return { ok: false, unsupported: true, error: '该版本暂不支持自动签到' };
  }
  for (const ep of [c.EP_CHECKIN_STATUS, c.EP_CHECKIN_STATUS_FALLBACK]) {
    const r = await post(region, account, ep);
    const doc = r.doc;
    const code = doc ? Number(doc.code) : -1;
    if (r.status >= 200 && r.status < 300 && (code === 0 || code === 200)) {
      const d = (doc && doc.data) || {};
      return {
        ok: true,
        todayCheckedIn: d.today_checked_in ?? d.todayCheckedIn ?? false,
        dailyCredit: d.daily_credit != null ? Number(d.daily_credit) : null,
        todayCredit: d.today_credit != null ? Number(d.today_credit) : null,
        totalCredits: d.total_credits != null ? Number(d.total_credits) : null,
        streakDays: d.streak_days != null ? Number(d.streak_days) : null,
        streakBonusCredit: d.streak_bonus_credit != null ? Number(d.streak_bonus_credit) : null,
        checkinDates: d.checkin_dates ?? null,
      };
    }
  }
  return { ok: false, error: '签到状态查询失败（两个端点都未成功）' };
}

/**
 * 执行签到。已签（服务端提示）按成功处理（幂等）。
 * 返回 { ok, already?, message?, error? }
 */
async function checkinClaim(region, account) {
  if (c.normalizeRegion(region) === 'global') {
    return { ok: false, unsupported: true, error: '该版本暂不支持自动签到' };
  }
  const r = await post(region, account, c.EP_CHECKIN_CLAIM);
  const doc = r.doc;
  const code = doc ? Number(doc.code) : -1;
  if (r.status >= 200 && r.status < 300 && (code === 0 || code === 200)) {
    return { ok: true };
  }
  const msg = (doc && (doc.message || doc.msg)) || `code=${code}`;
  if (msg.includes('已签到') || msg.toLowerCase().includes('repeat')) {
    return { ok: true, already: true, message: msg };
  }
  return { ok: false, error: msg };
}

/**
 * 额度包列表（get-user-resource）。
 * 返回 { ok, total, packages:[{name, remain, size}], error? }
 *
 * 解析口径（对照 upstream.rs fetch_credits）：优先 CycleCapacity 三件套的
 * CycleCapacityRemain；没有周期字段时退 CapacityRemain。负数归 0。
 */
async function fetchCredits(region, account) {
  if (c.normalizeRegion(region) === 'global') {
    return { ok: false, unsupported: true, error: '国际版没有此额度接口（套餐口径不同）' };
  }
  const spec = c.specOf(region);
  const u = new URL(spec.billingBase + c.CHECKIN_API_PREFIX + c.EP_CREDITS);
  const now = new Date();
  const fmt = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const end = new Date(now.getTime() + 365 * 101 * 86400000);
  const body = JSON.stringify({
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: fmt(end),
  });
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
    return { ok: false, error: e.message };
  }
  const headers = {
    ...authHeaders(region, account),
    'Content-Length': String(Buffer.byteLength(body)),
    'User-Agent': c.CLIENT_UA,
    Origin: spec.billingBase,
    Referer: `${spec.billingBase}/`,
  };
  const r = await new Promise((resolve) => {
    const req = require('https').request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers,
      ...(agent ? { agent } : {}), timeout: 30000,
    }, (res) => {
      let buf = '';
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      res.on('data', (x) => { buf += dec.write(x); });
      res.on('end', () => { buf += dec.end(); resolve({ status: res.statusCode, body: buf }); });
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.write(body);
    req.end();
  });
  let doc = null;
  try { doc = JSON.parse(r.body); } catch (e) { /* 非 JSON */ }
  const code = doc ? Number(doc.code) : -1;
  if (r.status < 200 || r.status >= 300 || (Number.isFinite(code) && code !== 0) || !doc) {
    return { ok: false, error: (doc && (doc.msg || doc.message)) || `HTTP ${r.status}` };
  }
  const wrapper = (doc.data && typeof doc.data === 'object') ? doc.data : {};
  const data = (wrapper.Response && typeof wrapper.Response === 'object') ? wrapper.Response : {};
  const inner = (data.Data && typeof data.Data === 'object') ? data.Data : {};
  const rawAccounts = Array.isArray(inner.Accounts) ? inner.Accounts : [];
  const packages = [];
  let total = 0;
  for (const a of rawAccounts) {
    if (!a || typeof a !== 'object') continue;
    const num = (k) => (Number(a[k]) || 0);
    const size = num('CycleCapacitySize');
    const cycleRemain = num('CycleCapacityRemain');
    const cycleUsed = num('CycleCapacityUsed');
    let remain = (size > 0 || cycleRemain > 0 || cycleUsed > 0) ? cycleRemain : num('CapacityRemain');
    if (remain < 0) remain = 0;
    total += remain;
    packages.push({
      name: String(a.PackageName || '(unnamed)'),
      remain,
      size: size > 0 ? size : num('CapacitySize'),
    });
  }
  return { ok: true, total, packages };
}

module.exports = { checkinStatus, checkinClaim, fetchCredits, authHeaders };
