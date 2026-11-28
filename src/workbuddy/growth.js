// src/workbuddy/growth.js - 成长中心只读聚合（2026-11-08 融合批）
//
// 出处：GitHub 生态调研（88lin/workbuddy-auto-signin 的成长中心模块、
// linguo2625469/workbuddy2api-panel 的「成长任务一键完成」）。调研把它列为
// 本项目最大的缺失项——我们此前只有签到与活跃上报，连登档位/任务/热力图/
// 能量/盲盒/猫猫旅行全无。
//
// **本模块只读，一个写接口都不调。** 这不是保守，是有依据的：
//   1. 调研实证「伪造 /v2/report 事件（成长任务/夜猫子）会被上游识别为异常，
//      2026-10-15 起国际版收紧」——写操作的收益（积分）与风险（封号）不对称；
//   2. 领奖/接取任务的 body 形状在调研里被标为「未在 unlocked 态验证」，
//      借用前必须真机验一遍，现在没有证据；
//   3. 只读部分已经能回答运维真正关心的问题：「这个号还活着吗、连登几天、
//      还有多少任务没领」。
//
// 后续要加写操作时，必须按项目纪律：独立开关、默认关、幂等、结果如实报。
//
// 端点（全部真机验证 2026-11-08，国内账号，均 HTTP 200 + code 0）：
//   GET /activity/growth/streak          连登天数 + 档位兑换状态（**无 /v2 前缀**）
//   GET /activity/growth/heatmap         热力墙（每日 score）
//   GET /v2/activity/growth/tasks        成长任务列表（**有 /v2 前缀**）
//   GET /v2/activity/growth/energy       成长能量余额
//   GET /v2/activity/growth/buddy/quota  盲盒可开次数
//
// **前缀不对称是有意的还是上游的历史遗留**：实测如此，别「顺手统一」——
// 加了 /v2 的 streak 会 404，去掉 /v2 的 tasks 也会 404。
const c = require('./constants');

// 测试注入点（与 activity.js 同款模式）
let requestImpl = require('https').request;
function _setRequestImpl(f) { requestImpl = f || require('https').request; }

/** GET 一个成长端点，返回 { ok, status, doc, error }。永不抛 */
/** POST 版 getJson（同头族同传输，P1-6 官方用量账本用）。bodyObj 序列化成 JSON。 */
function postJson(region, account, path, bodyObj) {
  return new Promise((resolve) => {
    const spec = c.specOf(region);
    let agent = null;
    try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
      return resolve({ ok: false, status: 0, doc: null, error: `出站代理配置错误: ${e.message}` });
    }
    const payload = Buffer.from(JSON.stringify(bodyObj || {}), 'utf8');
    const u = new URL(spec.chatBase + path);
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': region === 'global' ? 'en-US' : 'zh-CN',
      'X-CodeBuddy-Request': '1',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Product': 'SaaS',
      Origin: spec.billingBase,
      Referer: `${spec.billingBase}/`,
      'User-Agent': c.CLIENT_UA,
      Authorization: `Bearer ${(account && account.accessToken) || ''}`,
      'Content-Type': 'application/json',
      'Content-Length': String(payload.length),
    };
    if (account && account.uid) headers['X-User-Id'] = account.uid;
    if (account && account.domain) headers['X-Domain'] = account.domain;
    if (account && account.enterpriseId) headers['X-Enterprise-Id'] = account.enterpriseId;

    let req;
    try {
      req = requestImpl({
        hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers,
        ...(agent ? { agent } : {}), timeout: 15000,
      }, (res) => {
        let b = '';
        const { StringDecoder } = require('string_decoder');
        const dec = new StringDecoder('utf8');
        res.on('data', (x) => { b += dec.write(x); });
        res.on('end', () => {
          b += dec.end();
          let doc = null;
          try { doc = JSON.parse(b); } catch (e) { /* 非 JSON */ }
          const code = doc ? Number(doc.code) : NaN;
          const ok = res.statusCode >= 200 && res.statusCode < 300
            && Number.isFinite(code) && code === 0;
          resolve({
            ok, status: res.statusCode, doc,
            error: ok ? '' : `HTTP ${res.statusCode}${doc && doc.msg ? `: ${doc.msg}` : ''}`,
          });
        });
      });
    } catch (e) {
      return resolve({ ok: false, status: 0, doc: null, error: e.message });
    }
    req.on('error', (e) => resolve({ ok: false, status: 0, doc: null, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, doc: null, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

function getJson(region, account, path) {
  return new Promise((resolve) => {
    const spec = c.specOf(region);
    let agent = null;
    try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
      return resolve({ ok: false, status: 0, doc: null, error: `出站代理配置错误: ${e.message}` });
    }
    const u = new URL(spec.chatBase + path);
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': region === 'global' ? 'en-US' : 'zh-CN',
      'X-CodeBuddy-Request': '1',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Product': 'SaaS',
      Origin: spec.billingBase,
      Referer: `${spec.billingBase}/`,
      'User-Agent': c.CLIENT_UA,
      Authorization: `Bearer ${(account && account.accessToken) || ''}`,
    };
    if (account && account.uid) headers['X-User-Id'] = account.uid;
    if (account && account.domain) headers['X-Domain'] = account.domain;
    if (account && account.enterpriseId) headers['X-Enterprise-Id'] = account.enterpriseId;

    let req;
    try {
      req = requestImpl({
        hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers,
        ...(agent ? { agent } : {}), timeout: 15000,
      }, (res) => {
        let b = '';
        const { StringDecoder } = require('string_decoder');
        const dec = new StringDecoder('utf8');
        res.on('data', (x) => { b += dec.write(x); });
        res.on('end', () => {
          b += dec.end();
          let doc = null;
          try { doc = JSON.parse(b); } catch (e) { /* 非 JSON */ }
          const code = doc ? Number(doc.code) : NaN;
          const ok = res.statusCode >= 200 && res.statusCode < 300
            && Number.isFinite(code) && code === 0;
          resolve({
            ok, status: res.statusCode, doc,
            error: ok ? '' : `HTTP ${res.statusCode}${doc && doc.msg ? `: ${doc.msg}` : ''}`,
          });
        });
      });
    } catch (e) {
      return resolve({ ok: false, status: 0, doc: null, error: e.message });
    }
    req.on('error', (e) => resolve({ ok: false, status: 0, doc: null, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, doc: null, error: 'timeout' }); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 纯解析函数（可离线测；每个都容忍字段缺失，不编造）
// ---------------------------------------------------------------------------

/**
 * 连登状态。字段来自真机（2026-11-08）：
 *   streak.days / month_total_days / next_tier / next_tier_remaining / makeup_dates
 *   makeup_cards.balance / max
 *   redemption_status.tier_{7,14,28}d_{count,status}
 * @returns {{days:number|null, monthTotal:number|null, nextTier:string|null,
 *   nextTierRemaining:number|null, makeupCards:{balance:number|null,max:number|null},
 *   tiers:Array<{tier:number,count:number|null,status:string}>}|null}
 */
function parseStreak(doc) {
  const d = doc && doc.data;
  if (!d || typeof d !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const st = (d.streak && typeof d.streak === 'object') ? d.streak : {};
  const cards = (d.makeup_cards && typeof d.makeup_cards === 'object') ? d.makeup_cards : {};
  const red = (d.redemption_status && typeof d.redemption_status === 'object') ? d.redemption_status : {};
  const tiers = [7, 14, 28].map((tier) => ({
    tier,
    count: n(red[`tier_${tier}d_count`]),
    status: typeof red[`tier_${tier}d_status`] === 'string' ? red[`tier_${tier}d_status`] : 'unknown',
  }));
  return {
    days: n(st.days),
    monthTotal: n(st.month_total_days),
    nextTier: typeof st.next_tier === 'string' ? st.next_tier : null,
    nextTierRemaining: n(st.next_tier_remaining),
    makeupCards: { balance: n(cards.balance), max: n(cards.max) },
    // 「可领取但还没领」是运维真正该看的：调研说「必须手动领，不领会过期」
    redeemable: tiers.filter((t) => t.status === 'unlocked').map((t) => t.tier),
    tiers,
  };
}

/**
 * 核心盘/热力墙。`cells[].score > 0` 即当天点亮。
 * @returns {{lit:number, total:number, today:string|null, todayScore:number|null,
 *   recent:Array<{date:string,score:number}>}}
 */
function parseHeatmap(doc, now = Date.now()) {
  const cells = doc && doc.data && Array.isArray(doc.data.cells) ? doc.data.cells : null;
  if (!cells) return { lit: 0, total: 0, today: null, todayScore: null, recent: [] };
  const rows = cells
    .filter((x) => x && typeof x.date === 'string')
    .map((x) => ({ date: x.date, score: typeof x.score === 'number' ? x.score : 0 }));
  const d = new Date(now);
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const t = rows.find((x) => x.date === today) || null;
  return {
    lit: rows.filter((x) => x.score > 0).length,
    total: rows.length,
    today,
    todayScore: t ? t.score : null,
    recent: rows.slice(-14),
  };
}

/**
 * 成长任务列表。真机 19 项，字段含 task_code/task_type/reward_credit/
 * accept_status/progress{current,target}/has_reward。
 *
 * **只统计，不接取**：`accept_status` 的原值如实透出（single/auto/claimed/
 * unlocked/...），界面自己决定怎么显示。按 `claimed` 过滤出「还能做的」。
 */
function parseTasks(doc, now = Date.now()) {
  const list = doc && doc.data && Array.isArray(doc.data.tasks) ? doc.data.tasks : null;
  if (!list) return { total: 0, claimed: 0, claimable: 0, pending: [], creditTotal: 0, creditClaimed: 0 };
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const rows = list.map((t) => {
    const prog = (t && t.progress && typeof t.progress === 'object') ? t.progress : {};
    const end = t && t.valid_end ? Date.parse(String(t.valid_end).replace(' ', 'T') + '+08:00') : NaN;
    return {
      code: String((t && t.task_code) || ''),
      title: String((t && t.title) || ''),
      desc: String((t && (t.task_desc || t.description)) || ''),
      type: String((t && t.task_type) || ''),
      // auto 类不接受接取（调研：first_buddy 是 auto，其奖励是 Buddy 实例，
      // 是所有 single 任务与猫猫旅行的前置）
      auto: String((t && t.task_type) || '') === 'auto',
      acceptStatus: String((t && (t.accept_status || t.acceptStatus)) || 'unknown'),
      credit: n(t && t.reward_credit),
      energy: n(t && t.reward_energy),
      progress: {
        current: n(prog.current),
        target: n(prog.target),
      },
      locked: !!(t && t.locked),
      hasReward: !!(t && t.has_reward),
      expired: Number.isFinite(end) ? end < now : false,
    };
  });
  const claimable = rows.filter((r) => !r.locked && !r.expired && r.acceptStatus !== 'claimed');
  return {
    total: rows.length,
    claimed: rows.filter((r) => r.acceptStatus === 'claimed').length,
    claimable: claimable.length,
    creditTotal: rows.reduce((s, r) => s + r.credit, 0),
    creditClaimed: rows.filter((r) => r.acceptStatus === 'claimed').reduce((s, r) => s + r.credit, 0),
    // 未领的按奖励从大到小排：先看值钱的
    pending: claimable.sort((a, b) => b.credit - a.credit),
    rows,
  };
}

/** 能量余额：{balance, total_earned, total_consumed} */
function parseEnergy(doc) {
  const d = doc && doc.data;
  if (!d || typeof d !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    balance: n(d.balance),
    earned: n(d.total_earned),
    consumed: n(d.total_consumed),
  };
}

/**
 * 盲盒额度：{affordable, balance, cost_per_open, max_open_count}
 * `affordable` 是**当前能量够开几次**，不是剩余次数配额。
 */
function parseBuddyQuota(doc) {
  const d = doc && doc.data;
  if (!d || typeof d !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    affordable: n(d.affordable),
    balance: n(d.balance),
    costPerOpen: n(d.cost_per_open),
    maxOpenCount: n(d.max_open_count),
  };
}

/**
 * 拉一个账号的成长状态（5 个只读端点并发）。
 *
 * **串行 vs 并发**：这里用并发，但只有 5 个只读请求、且是「用户点开页面」
 * 触发的低频操作。自动排程里**不要**调它（那会变成每天 5×N 次上游请求）。
 *
 * @param {'cn'|'global'} region
 * @param {object} account
 * @returns {Promise<object>} 每个字段独立成功/失败，失败为 null + 在 errors 里说明
 */
async function fetchGrowth(region, account, now = Date.now()) {
  const [streakR, heatR, tasksR, energyR, quotaR] = await Promise.all([
    getJson(region, account, '/activity/growth/streak'),
    getJson(region, account, '/activity/growth/heatmap'),
    getJson(region, account, '/v2/activity/growth/tasks'),
    getJson(region, account, '/v2/activity/growth/energy'),
    getJson(region, account, '/v2/activity/growth/buddy/quota'),
  ]);
  const errors = {};
  const note = (k, r) => { if (!r.ok) errors[k] = r.error || 'unknown'; };
  note('streak', streakR); note('heatmap', heatR); note('tasks', tasksR);
  note('energy', energyR); note('buddyQuota', quotaR);

  const anyOk = streakR.ok || heatR.ok || tasksR.ok || energyR.ok || quotaR.ok;
  return {
    ok: anyOk,
    region,
    streak: streakR.ok ? parseStreak(streakR.doc) : null,
    heatmap: heatR.ok ? parseHeatmap(heatR.doc, now) : null,
    tasks: tasksR.ok ? parseTasks(tasksR.doc, now) : null,
    energy: energyR.ok ? parseEnergy(energyR.doc) : null,
    buddyQuota: quotaR.ok ? parseBuddyQuota(quotaR.doc) : null,
    errors,
    note: '只读：本模块不接取任务、不领奖、不开盲盒。调研实证伪造成长事件会被上游识别为异常。',
    at: now,
  };
}

/**
 * 任务中心三桶扫描（P1-7，2026-11-28 融合批；只读，不碰写路径）。
 *
 * 每账号未完成任务分三桶，不变量 `incomplete_total == 三桶之和` 保证不漏项：
 *   auto        可自动化——补领清扫（tasks.sweepTasks）能接的行（accept+claim）
 *   locked_auto 上游锁定（locked:true，等前置/等档位）——看得见动不了
 *   manual      需手动——mp/客户端口径任务（Sequential_Tasks_* 等，须 X-Client-Platform:
 *               miniprogram 头族），本批只显示指引不执行；国际版 manual 桶同理只指引
 * 已领（accept_status==='claimed'）/已过期/无奖励位的不进桶。
 *
 * scan_state 五态——**401/空 body/非 JSON 一律 error，绝不渲染成「没有待办」**：
 *   ok / empty / error / skipped_enterprise / skipped_disabled
 *
 * @param {{disabled?:boolean, execution_enabled?:boolean}} opts
 *   disabled=true 直接报 skipped_disabled（自动化腿在开关关闭时用）；
 *   execution_enabled 由调用方传（tasks.sweepEnabled()），这里不读 env——扫描是
 *   只读的，执行开关是执行路径的事，两件事不能搅在一起。
 */
async function scanGrowthTasks(region, account, opts = {}) {
  const region2 = c.normalizeRegion(region);
  const out = {
    scan_state: 'error', buckets: null, incomplete_total: null,
    claimable_total: 0, execution_enabled: opts.execution_enabled === true,
    invariant_ok: null, error: '',
  };
  const tasksMod = require('./tasks'); // 纯解析与企业号判据单一出处（无循环依赖）
  if (tasksMod.enterpriseBlocked(account)) {
    out.scan_state = 'skipped_enterprise';
    return out;
  }
  if (opts.disabled) {
    out.scan_state = 'skipped_disabled';
    return out;
  }
  const r = await getJson(region2, account, '/v2/activity/growth/tasks');
  if (!r.ok) {
    // 401 / 空 body / 非业务信封 → error。把「读不到」渲染成「没有待办」会让
    // 运维以为任务都领完了——这比漏领更难发现。
    out.error = r.error || `HTTP ${r.status}`;
    return out;
  }
  const rows = tasksMod.parseTasksList(r.doc);
  const buckets = { auto: [], locked_auto: [], manual: [] };
  for (const t of rows) {
    if (t.acceptStatus === 'claimed' || t.expired || !t.hasReward) continue;
    if (t.locked) buckets.locked_auto.push(t);
    else if (t.type === 'mp' || /^Sequential_Tasks_/.test(t.code)) buckets.manual.push(t);
    else buckets.auto.push(t);
  }
  const incomplete = buckets.auto.length + buckets.locked_auto.length + buckets.manual.length;
  out.scan_state = incomplete === 0 ? 'empty' : 'ok';
  out.buckets = buckets;
  out.incomplete_total = incomplete;
  out.invariant_ok = incomplete === buckets.auto.length + buckets.locked_auto.length + buckets.manual.length;
  out.claimable_total = rows.filter((t) => t.claimable).length;
  if (region2 === 'global' && buckets.manual.length) {
    out.manualNote = '国际版手动桶只显示指引（客户端/小程序口径），本网关不代执行';
  }
  return out;
}

module.exports = {
  parseStreak, parseHeatmap, parseTasks, parseEnergy, parseBuddyQuota,
  fetchGrowth, getJson, postJson, _setRequestImpl, scanGrowthTasks,
};
