// src/workbuddy/tasks.js - 成长任务写路径（P0-6，2026-11-28 融合批）
//
// 三个动作（全部真实动作流的低风险层；行为链不在本模块——计数型任务上游校验
// 真实会话 messageId，伪造不计数还增暴露面）：
//   1. 补领清扫 sweep：只 accept（报名幂等）+ claim（只对完成且未领的行），
//      claim 后回读确认，未确认进 unverified 本轮不再重复空 claim；
//   2. 连登兑换 redeemUnlocked：tier 权威取 streak 的 redemption_status.tiers[]，
//      只兑 status==='unlocked' 的档；403 天数不足 / 409 本月已兑是业务态；
//   3. 断登补签 makeupBrokenDay：手动触发，每轮 ≤1 张；候选 = 当月、今天前、
//      score==0、不在 makeup_dates；400 date is not broken 是正常竞争不报错。
//
// 端点全部 2026-11-28 真机探针确认（test/probe-workbuddy-tasks.js，账号 1）：
//   GET  {chatBase}/v2/activity/growth/tasks                 任务列表（11-08 已验证）
//   POST {chatBase}/v2/activity/growth/tasks/accept          {"task_codes":[...]}（双前缀都通，取 /v2）
//   POST {webBase}/activity/growth/tasks/<code>/claim        **任务码在路径、无 body、web 头族**
//        ——CLI 域的 /v2/.../reward/claim 路径不存在（探针 400 task not completed，
//        misakano 同结论），claim 必须走 www.workbuddy.cn；已领码回 200 code=0 幂等
//   POST {chatBase}/activity/growth/redeem                   {"tier","client_token":"u-<uuid4>"}
//   POST {chatBase}/activity/growth/makeup-cards/use         {"target_date":...}（date 字段名实测被拒）
//
// 项目纪律（growth.js 头注释的承诺）：独立开关（DUMATE_WORKBUDDY_TASKS_SWEEP，
// 默认关）、幂等、结果如实报。小程序口径任务（Sequential_Tasks_* 等）不在本批
// ——accept/claim 要求 X-Client-Platform: miniprogram 头族，另行评估。
'use strict';
const crypto = require('crypto');
const c = require('./constants');

// 出站注入点（测试打桩用）：默认真实 https.request（activity.js 同款）
let requestImpl = (opts, cb) => require('https').request(opts, cb);
/** @private 测试专用 */
function _setRequestImpl(f) { requestImpl = f; }

// growth 域任务路径（探针定案）
const TASKS_LIST_PATH = '/v2/activity/growth/tasks';
const TASKS_ACCEPT_PATH = '/v2/activity/growth/tasks/accept';
const TASK_REDEEM_PATH = '/activity/growth/redeem';
const TASK_MAKEUP_PATH = '/activity/growth/makeup-cards/use';
// growth 体系的日期下界（2026-06-17 前账号没有成长数据，score==0 无意义）
const GROWTH_FLOOR_DATE = '2026-06-17';
// 前置任务的约定码（auto 类，Buddy 实例奖励；single 任务的前置）
const PREREQ_TASK = 'first_buddy';

// ---- 头族（探针验证的两种形状）----

function growthHeaders(region, account, bodyLen) {
  const spec = c.specOf(region);
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
  if (bodyLen) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(bodyLen);
  }
  return headers;
}

function webClaimHeaders(region, account, bodyLen) {
  const headers = {
    Authorization: `Bearer ${(account && account.accessToken) || ''}`,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: 'https://www.workbuddy.cn',
    Referer: 'https://www.workbuddy.cn/profile/growth-center',
    'x-client-platform': 'web',
    'User-Agent': c.CLIENT_UA,
  };
  if (account && account.uid) headers['X-User-Id'] = account.uid;
  if (account && account.enterpriseId) {
    headers['X-Enterprise-Id'] = account.enterpriseId;
    headers['X-Tenant-Id'] = account.enterpriseId;
  }
  if (account && account.domain) headers['X-Domain'] = account.domain;
  if (bodyLen) headers['Content-Length'] = String(bodyLen);
  return headers;
}

// ---- 出站（永不抛；错误进结果）----

function send(region, account, host, path, method, bodyObj, headerFamily) {
  return new Promise((resolve) => {
    let agent = null;
    try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
      return resolve({ status: 0, doc: null, error: `出站代理配置错误: ${e.message}` });
    }
    const payload = bodyObj === undefined || bodyObj === null
      ? null : Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const u = new URL(host + path);
    const headers = headerFamily === 'web'
      ? webClaimHeaders(region, account, payload ? payload.length : 0)
      : growthHeaders(region, account, payload ? payload.length : 0);
    let req;
    try {
      req = requestImpl({
        hostname: u.hostname, path: u.pathname + u.search, method, timeout: 15000, headers,
        ...(agent ? { agent } : {}),
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
          resolve({
            status: res.statusCode, doc, code: Number.isFinite(code) ? code : null,
            msg: doc && (doc.msg || doc.message) ? String(doc.msg || doc.message) : '',
            data: doc ? doc.data : null,
            error: '',
          });
        });
      });
    } catch (e) {
      return resolve({ status: 0, doc: null, error: e.message });
    }
    req.on('error', (e) => resolve({ status: 0, doc: null, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, doc: null, error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

function webBaseOf(region) {
  // 领奖的 web 域（misakano ClaimReward：global 与 chat 域同主机，cn 独立主机）
  return c.normalizeRegion(region) === 'global' ? c.specOf('global').chatBase : 'https://www.workbuddy.cn';
}

// ---- 纯解析（可离线测）----

/**
 * 任务行的宽松解析（progress 可能是 {current,target} 对象或平铺字段，
 * misakano parseGrowthTasks 双形状口径；global 列表用 code 字段无 task_code）。
 * @returns {{code:string,title:string,type:string,auto:boolean,acceptStatus:string,
 *   locked:boolean,expired:boolean,hasReward:boolean,credit:number,energy:number,
 *   status:string,current:number,target:number,claimable:boolean}|null}
 */
function parseTaskRow(t, now = Date.now()) {
  if (!t || typeof t !== 'object') return null;
  const code = String(t.task_code || t.code || '');
  if (!code) return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const prog = (t.progress && typeof t.progress === 'object') ? t.progress : {};
  const current = n(prog.current !== undefined ? prog.current : t.current);
  const target = n(prog.target !== undefined ? prog.target : t.target);
  const end = t.valid_end ? Date.parse(String(t.valid_end).replace(' ', 'T') + '+08:00') : NaN;
  const acceptStatus = String(t.accept_status || 'unknown');
  const status = String(t.status || '');
  const type = String(t.task_type || '');
  const auto = type === 'auto';
  const locked = !!t.locked;
  const expired = Number.isFinite(end) ? end < now : false;
  // claimable：完成且未领。完成 = 进度达标（target>0 且 current≥target）或上游
  // status 标 complete；未领 = accept_status !== 'claimed'。
  const done = (target > 0 && current >= target) || status === 'complete';
  return {
    code, title: String(t.title || ''), type, auto,
    acceptStatus, locked, expired,
    hasReward: !!t.has_reward,
    credit: n(t.reward_credit), energy: n(t.reward_energy),
    status, current, target,
    claimable: done && acceptStatus !== 'claimed' && !locked && !expired && !!t.has_reward,
  };
}

function parseTasksList(doc, now = Date.now()) {
  const list = doc && doc.data && Array.isArray(doc.data.tasks) ? doc.data.tasks : [];
  return list.map((t) => parseTaskRow(t, now)).filter(Boolean);
}

/** streak 的可兑档位（status==='unlocked'）。tier 权威取 tiers[].tier，不认第三方清单。
 *  实测形状（2026-11-28 探针）：tiers[] 是描述数组，status 在平铺键 tier_{tier}_status；
 *  11-08 的 growth.js 只见过平铺键——两层都认，缺数组时回退已知档位名。 */
function parseRedeemableTiers(doc) {
  const d = doc && doc.data;
  const red = d && d.redemption_status && typeof d.redemption_status === 'object' ? d.redemption_status : {};
  const tiers = Array.isArray(red.tiers) ? red.tiers : [];
  const names = tiers.map((t) => (t && typeof t.tier !== 'undefined' ? String(t.tier) : '')).filter(Boolean);
  if (!names.length) names.push('7d', '14d', '28d'); // 平铺键形状的兜底
  const out = [];
  for (const tier of names) {
    const status = typeof red[`tier_${tier}_status`] === 'string' ? red[`tier_${tier}_status`] : 'unknown';
    if (status === 'unlocked') out.push({ tier, status });
  }
  return out;
}

/**
 * 补签候选（纯函数）：当月、今天前、≥ growth 下界、score==0、不在 makeup_dates，
 * 最近断点优先。today 用**响应的 today.date**（宿主机若为 UTC，本地 08:00 前会算错天）。
 * @returns {string[]} 候选日期（YYYY-MM-DD，最近在前）；today 缺失返回 []（结构未知不猜窗口）
 */
function makeupCandidates(heatmapDoc, makeupDates, now = Date.now()) {
  const d = heatmapDoc && heatmapDoc.data;
  const todayRaw = d && d.today && typeof d.today.date === 'string' ? d.today.date : '';
  if (todayRaw.length < 10) return [];
  const today = todayRaw.slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const used = new Set((Array.isArray(makeupDates) ? makeupDates : []).map((x) => String(x).slice(0, 10)));
  const cells = Array.isArray(d.cells) ? d.cells : [];
  const out = [];
  for (const cell of cells) {
    const day = String((cell && cell.date) || '').slice(0, 10);
    if (day.length !== 10) continue;
    if (day >= today || day < monthStart || day < GROWTH_FLOOR_DATE) continue;
    if (!Number.isFinite(Number(cell.score)) || Number(cell.score) !== 0) continue;
    if (used.has(day)) continue;
    out.push(day);
  }
  return [...new Set(out)].sort().reverse(); // 最近断点优先
}

// ---- 三个动作 ----

/**
 * 补领清扫：accept 未接的 single 任务 + claim 完成未领的任务。
 * claim 后**回读任务列表确认**（claimed 或响应 already_claimed 才算 verified）。
 * `prerequisite` 报错先补跑前置（first_buddy 报名）再重试一次。
 *
 * @param {'cn'|'global'} region
 * @param {object} account
 * @param {object} [opts] { now } 测试注入
 * @returns {Promise<{ok:boolean, accepted:string[], claimed:Array<{code,credit,energy,verified}>,
 *   unverified:string[], skipped:Array<{code,reason}>, error:string}>}
 */
async function sweepTasks(region, account, opts = {}) {
  const now = opts.now || Date.now();
  const out = { ok: false, accepted: [], claimed: [], unverified: [], skipped: [], error: '' };
  const listR = await send(region, account, c.specOf(region).chatBase, TASKS_LIST_PATH, 'GET', undefined);
  if (listR.error || listR.code !== 0) {
    out.error = `任务列表读取失败: ${listR.error || listR.msg || `HTTP ${listR.status}`}`;
    return out;
  }
  const tasks = parseTasksList(listR.doc, now);
  const byCode = new Map(tasks.map((t) => [t.code, t]));

  // 1) accept（报名幂等，复数数组形状；auto 类不接受接取——上游按行为事件点亮）
  const toAccept = tasks.filter((t) => !t.auto && !t.locked && !t.expired
    && t.acceptStatus !== 'claimed' && t.acceptStatus !== 'accepted').map((t) => t.code);
  if (toAccept.length) {
    const accR = await send(region, account, c.specOf(region).chatBase, TASKS_ACCEPT_PATH, 'POST', { task_codes: toAccept });
    if (accR.error || accR.code !== 0) {
      out.skipped.push({ code: toAccept.join(','), reason: `accept 失败: ${accR.error || accR.msg || `HTTP ${accR.status}`}` });
    } else {
      out.accepted.push(...toAccept);
    }
  }

  // 2) claim（只对完成且未领的行发；逐个打 web 域路径）
  const claimable = tasks.filter((t) => t.claimable);
  const prereqTried = new Set();
  for (const t of claimable) {
    const host = webBaseOf(region);
    const path = `/activity/growth/tasks/${encodeURIComponent(t.code)}/claim`;
    let r = await send(region, account, host, path, 'POST', undefined, 'web');
    // prerequisite not met：补跑前置（first_buddy 报名）再重试一次
    if ((r.error || (r.code !== null && r.code !== 0)) && /prerequisite/i.test(r.msg || '')) {
      if (!prereqTried.has(t.code)) {
        prereqTried.add(t.code);
        await send(region, account, c.specOf(region).chatBase, TASKS_ACCEPT_PATH, 'POST', { task_codes: [PREREQ_TASK] });
        r = await send(region, account, host, path, 'POST', undefined, 'web');
      }
    }
    if (r.error) {
      out.skipped.push({ code: t.code, reason: `claim 传输失败: ${r.error}` });
      continue;
    }
    if (r.code === null) {
      out.skipped.push({ code: t.code, reason: `claim 响应不是业务信封（HTTP ${r.status}）` });
      continue;
    }
    if (r.code !== 0) {
      out.skipped.push({ code: t.code, reason: `claim 业务拒绝: ${r.msg || `code=${r.code}`}` });
      continue;
    }
    const data = r.data && typeof r.data === 'object' ? r.data : {};
    const already = data.already_claimed === true;
    // 实发在 credit/energy（claim 响应无 _granted 后缀——redeem 才有）；已领过 = 0 增量
    out.claimed.push({ code: t.code, credit: Number(data.credit) || 0, energy: Number(data.energy) || 0, verified: already });
  }

  // 3) 回读确认：本轮 claim 过的任务在列表里翻成 claimed 才算 verified
  if (out.claimed.length) {
    const re = await send(region, account, c.specOf(region).chatBase, TASKS_LIST_PATH, 'GET', undefined);
    if (re.error || re.code !== 0) {
      // 回读失败：全部按 unverified 处理（响应已说 code=0，但没证据就是没证据）
      for (const row of out.claimed) if (!row.verified) out.unverified.push(row.code);
      out.claimed = out.claimed.filter((row) => row.verified);
      out.unverified = [...new Set(out.unverified)];
    } else {
      const after = new Map(parseTasksList(re.doc, now).map((t) => [t.code, t]));
      for (const row of out.claimed) {
        const t = after.get(row.code);
        if (t && t.acceptStatus === 'claimed') row.verified = true;
      }
      out.unverified = [...new Set(out.claimed.filter((row) => !row.verified).map((row) => row.code))];
      out.claimed = out.claimed.filter((row) => row.verified);
    }
  }

  out.ok = true;
  return out;
}

/**
 * 连登兑换：只兑 status==='unlocked' 的档（403 天数不足/409 本月已兑是业务态，
 * 不报错）。实发字段带 `_granted` 后缀（credit 恒空，读它必漏计）。
 * @returns {Promise<{ok:boolean, redeemed:Array<{tier,granted:{credit,energy,cards,chances}}>,
 *   skipped:Array<{tier,reason}>, error:string}>}
 */
async function redeemUnlocked(region, account) {
  const out = { ok: false, redeemed: [], skipped: [], error: '' };
  const spec = c.specOf(region);
  const streakR = await send(region, account, spec.chatBase, '/activity/growth/streak', 'GET', undefined);
  if (streakR.error || streakR.code !== 0) {
    out.error = `streak 读取失败: ${streakR.error || streakR.msg || `HTTP ${streakR.status}`}`;
    return out;
  }
  const tiers = parseRedeemableTiers(streakR.doc);
  for (const { tier } of tiers) {
    const r = await send(region, account, spec.chatBase, TASK_REDEEM_PATH, 'POST',
      { tier, client_token: `u-${crypto.randomUUID()}` });
    if (r.error) {
      out.skipped.push({ tier, reason: `兑换传输失败: ${r.error}` });
      continue;
    }
    if (r.code === 403) { out.skipped.push({ tier, reason: '连续登录天数不足（业务态）' }); continue; }
    if (r.code === 409) { out.skipped.push({ tier, reason: '该档位本月已兑换' }); continue; }
    if (r.code !== 0) { out.skipped.push({ tier, reason: `兑换拒绝: ${r.msg || `code=${r.code}`}` }); continue; }
    const d = r.data && typeof r.data === 'object' ? r.data : {};
    out.redeemed.push({
      tier,
      granted: {
        credit: Number(d.credit_granted) || 0,
        energy: Number(d.energy_granted) || 0,
        cards: Number(d.cards_granted) || 0,
        chances: Number(d.chances_granted) || 0,
      },
    });
  }
  out.ok = true;
  return out;
}

/**
 * 断登补签（手动触发，每轮 ≤1 张）：候选最近断点优先，用一张补签卡。
 * 400 `date is not broken` 是正常竞争（别的端先补了）不报错；无卡如实跳过。
 * @returns {Promise<{ok:boolean, used:string|null, granted:number|null, error:string}>}
 */
async function makeupBrokenDay(region, account) {
  const out = { ok: false, used: null, granted: null, error: '' };
  const spec = c.specOf(region);
  const streakR = await send(region, account, spec.chatBase, '/activity/growth/streak', 'GET', undefined);
  const cards = streakR.doc && streakR.doc.data && streakR.doc.data.makeup_cards;
  const balance = cards && Number.isFinite(Number(cards.balance)) ? Number(cards.balance) : null;
  const makeupDates = streakR.doc && streakR.doc.data && streakR.doc.data.streak
    ? streakR.doc.data.streak.makeup_dates : [];
  if (balance !== null && balance < 1) {
    out.error = '没有可用补签卡（balance=0），跳过';
    out.ok = true;
    return out;
  }
  const heatR = await send(region, account, spec.chatBase, '/activity/growth/heatmap', 'GET', undefined);
  if (heatR.error || heatR.code !== 0) {
    out.error = `heatmap 读取失败: ${heatR.error || heatR.msg || `HTTP ${heatR.status}`}`;
    return out;
  }
  const candidates = makeupCandidates(heatR.doc, makeupDates);
  if (!candidates.length) {
    out.ok = true;
    out.error = '本月没有可补的断点（或 today 结构缺失不敢猜窗口）';
    return out;
  }
  const date = candidates[0]; // 每轮 ≤1 张，最近断点优先
  const r = await send(region, account, spec.chatBase, TASK_MAKEUP_PATH, 'POST', { target_date: date });
  if (r.error) { out.error = `补签传输失败: ${r.error}`; return out; }
  if (r.code === 400 && /date is not broken/i.test(r.msg || '')) {
    out.ok = true;
    out.error = `${date} 已不是断点（正常竞争，不耗卡）`;
    return out;
  }
  if (r.code !== 0) { out.error = `补签拒绝: ${r.msg || `code=${r.code}`}`; return out; }
  out.ok = true;
  out.used = date;
  const d = r.data && typeof r.data === 'object' ? r.data : {};
  out.granted = Number.isFinite(Number(d.cards_granted)) ? Number(d.cards_granted) : null;
  return out;
}

// ---- 执行队列骨架（P1-7）：账号内串行 / 账号间并发 / 重复点击 TryLock 拒 ----
//
// 行为链（聊天任务/专家/模板/旅行/盲盒）将来挂进这套骨架：每个动作进队列前
// 先 TryLock（同账号在跑就拒，对应 HTTP 409 语义），动作完成后**强制回读**
// 判定——本批只有 sweep 有回读（claim 后重拉任务列表），后续动作必须照做，
// 未达标不写 done。锁是进程内的（单实例部署），不落盘。

const execLocks = new Set();

/** 账号内互斥执行：已在跑返回 busy:true（不排队不等待——重复点击就该被拒） */
async function runExclusive(account, fn) {
  const key = String(account && account.id);
  if (execLocks.has(key)) {
    return { ok: false, busy: true, error: `账号 ${key} 已有任务在执行（重复点击被拒）` };
  }
  execLocks.add(key);
  try {
    return await fn();
  } finally {
    execLocks.delete(key);
  }
}

function execBusyIds() { return [...execLocks]; }

/** 清扫开关现读（默认关——写操作按项目纪律独立开关） */
function sweepEnabled() {
  const raw = String(process.env.DUMATE_WORKBUDDY_TASKS_SWEEP || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** 企业号闸：enterpriseId 非空的账号跳过全部成长写腿（组织账号的行为由组织管，
 *  自动化写操作撞上企业风控是连坐级风险）。判据单一出处，autocheckin 与管理端共用。 */
function enterpriseBlocked(account) {
  return !!(account && account.enterpriseId);
}

module.exports = {
  parseTaskRow, parseTasksList, parseRedeemableTiers, makeupCandidates,
  sweepTasks, redeemUnlocked, makeupBrokenDay, sweepEnabled, enterpriseBlocked,
  runExclusive, execBusyIds,
  sweepDaily: async (account, opts = {}) => {
    // autocheckin 尾步的统一入口：清扫 + 连登兑换串行（兑换依赖清扫补的活跃？不——
    // 两者独立，但都打 streak/tasks 域，串行避免同一账号并发打成长域）
    const sweep = await sweepTasks(c.normalizeRegion(account.region), account, opts);
    const redeem = sweep.ok ? await redeemUnlocked(c.normalizeRegion(account.region), account) : { ok: false, error: sweep.error, redeemed: [], skipped: [] };
    return { sweep, redeem };
  },
  _setRequestImpl,
};
