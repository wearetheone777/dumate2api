// src/qwenwork/credits.js - 千问办公积分：余额读取 + 按请求归因
//
// 积分不在凭证里，要问站点：GET https://qwenwork.cn/user/wallets
// （同一个 Bearer token 可用）。上游返回三个池子的余额：
//
//   daily_credits     每日免费额度（**2026-11-01 起上游已不再发放**，实测恒 0）
//   monthly_credits   月度额度 → 付费，月初刷新（active_wallet 的 valid_to）
//   longterm_credits  充值/赠送 → 付费，按有效期
//
// **积分体系已随上游政策改过一次，不要再按「每日 100 免费额度」写代码**：
// 实测（2026-11-01 / 11-02，两个账号）daily_credits.total_balance 恒为 0，
// 而 monthly_credits 从 11-01 起从 0 变成 100 左右、active_wallets 只剩一条
// 且 valid_to = 12-01（月初）。归因账本也一致：11-01 起每条请求 free=0、
// paid>0，10-31 之前则大量 free>0。
//
// 因此下面这套「观测峰值推断每日上限 + 今日消耗 = 上限 − 余额」的机制
// **已整体删除**：
//   · 上限不再存在（没有每日发放，配置里的 100 是过期政策），
//     `DUMATE_QWENWORK_DAILY_CREDITS` 一并停用；
//   · 峰值法的前提是「每天重置到上限、之后只减不增」，daily 恒 0 时它只会
//     产出 limit=配置兜底 / peak=0 / calibrated=false 这种全无信息量的组合，
//     界面上表现为「每日额度 0 / 100 · 今日已用 —（未观测到满额）」——
//     用户看到的就是一堆读不懂的数。
//   · 「今日全部消耗」（含客户端内对话）本来就依赖「上限 − 余额」，
//     没有上限就推不出来。**宁可不出这个数，也不编一个**（项目一贯口径）。
//     真实的消耗数字改用归因账本（经本网关的请求逐条实测），并在界面上
//     明确标注口径。
//
// 仍然保留的两件事：
//   1. **余额读失败的重试 + 权威口径交叉验证**（见 fetchWallets）。上游
//      `/user/wallets` 偶发返回「三池全 0」的坏读，这时 account-context 的
//      `quota.remaining` 是权威值（按定义等于各池之和）。原来的交叉验证只
//      纠正 daily，现在 generalized 成纠正 total——daily 不再是重点，
//      「余额是不是真的没了」才是。
//   2. **按请求归因**（前后两次余额差值），口径不变；free/paid 两栏保留，
//      因为历史账本里它们是真数据，只是现在 free 恒 0。
//
// **三处状态都按账号隔离**（账号池化之后）：余额缓存、归因基准、串行队列。
// 混在一起会算出「A 请求扣了 B 账号的钱」——多账号下这是最要紧的一条。
const https = require('https');
const path = require('path');
const constants = require('./constants');

const SITE_ORIGIN = 'https://qwenwork.cn';
const WALLETS_PATH = '/user/wallets';
// 权威余额在 gateway 的 account-context 上。它的 quota.remaining **等于三池之和**，
// 所以当 wallets 谎报全 0 时，remaining 能证明「其实是读失败」。
// 注意它在 gateway 域名，不在 qwenwork.cn——两者不可互换。
const ACCOUNT_CONTEXT_HOST = 'gateway.qwenwork.cn';

// 余额缓存按账号分开：A 的余额不能回答「B 还剩多少」
const CACHE_MS = parseInt(process.env.DUMATE_QWENWORK_CREDIT_CACHE_MS || '30000', 10);
const caches = new Map();

/** 取 token。兼容 account 对象与裸 token 串 */
function tokenOf(account) {
  if (!account) return '';
  if (typeof account === 'string') return account;
  return account.accessToken || account.token || '';
}

function httpGet(path, token, timeout = 15000, hostname = 'qwenwork.cn', opts = {}) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname,
      path,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': constants.USER_AGENT,
      },
      timeout,
      // 出站代理（E 包收口补点）：余额查询与对话同出口，null = 直连
      ...(opts.agent ? { agent: opts.agent } : {}),
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(b) }); }
        catch (e) { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.end();
  });
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 读 gateway 的 account-context，取 `quota.remaining`。
 *
 * 这是余额的**权威口径**：按定义等于各池之和（历史实测 100 + (−4.8222) = 95.1778）。
 * **只在 wallets 看起来全 0 时才调用**——正常路径不该为一次查询多打一个上游。
 * 取不到（网络错 / 结构变了）返回 null，调用方据此回落，不编数字。
 */
async function fetchQuotaRemaining(token, opts = {}) {
  const r = await httpGet(constants.ACCOUNT_CONTEXT_PATH, token, 15000, ACCOUNT_CONTEXT_HOST, opts);
  if (r.status !== 200 || !r.data) return null;
  const q = (r.data.data || {}).quota;
  if (!q || typeof q.remaining !== 'number' || !Number.isFinite(q.remaining)) return null;
  return q.remaining;
}

/**
 * 读三池余额。默认走 30s 缓存——仪表盘刷新不该每次都打上游。
 *
 * @param {object} [opts]
 * @param {object|string} [opts.account] 账号对象或裸 token。**必填**：余额是
 *   账号级的，没有账号就不知道该查谁。
 * @param {boolean} [opts.force] 跳过缓存
 *
 * 返回形状（`daily/monthly/longterm` 在**坏读校正**后可能是 null——见下）：
 *   { ok, daily, monthly, longterm, total, paid,
 *     refreshAt, activeWallets, expiringSoon, fetchedAt,
 *     retried?, misread?, poolsUnknown? }
 */
async function fetchWallets(opts = {}) {
  const token = tokenOf(opts.account);
  if (!token) {
    return { ok: false, error: '缺少账号 token，无法查询余额', daily: null, monthly: null, longterm: null };
  }
  // 出站代理（E 包收口补点）：余额查询与对话同出口。配置非法按查询失败
  // 返回（保活/面板把该账号当「查不到余额」），绝不回退直连。
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(opts.account); } catch (e) {
    return { ok: false, error: e.message, daily: null, monthly: null, longterm: null };
  }
  const agentOpts = { agent };
  // 无账号对象（裸 token）时按 token 尾段分桶，保证缓存仍然按身份隔离
  const key = String((opts.account && opts.account.id) || token.slice(-8));
  if (!opts.force) {
    const hit = caches.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  }

  let r = await httpGet(WALLETS_PATH, token, 15000, 'qwenwork.cn', agentOpts);
  if (r.status !== 200 || !r.data) {
    return { ok: false, error: r.error || `HTTP ${r.status}`, daily: null, monthly: null, longterm: null };
  }

  // 「三池全 0 + active_wallets 空」要**重试一次**再下结论。
  //
  // 为什么不能直接当成「用完了」：实测（2026-09-30）同一时刻打两个接口，
  // `/user/wallets` 报全 0 而 `account-context` 的 quota.remaining 报 100——
  // 两者矛盾，说明那次是**读失败**（上游/边缘节点的一次瞬时状态）。
  //
  // 为什么也不能一律当成读失败：真·额度耗尽时三池确实都是 0，那种情况
  // 显示 0 是**正确的**。
  const walletBalances = (x) => {
    const dd = x && x.data && x.data.data;
    if (!dd) return null;
    const w = (dd.active_wallets && Array.isArray(dd.active_wallets.wallets)) ? dd.active_wallets.wallets : [];
    return {
      daily: num((dd.daily_credits || {}).total_balance),
      monthly: num((dd.monthly_credits || {}).total_balance),
      longterm: num((dd.longterm_credits || {}).total_balance),
      walletCount: w.length,
    };
  };
  const allZero = (x) => {
    const b = walletBalances(x);
    return !!b && b.daily === 0 && b.monthly === 0 && b.longterm === 0 && b.walletCount === 0;
  };
  let retried = false;     // 是否发生了重试
  let retryRecovered = false; // 重试后拿到了非 0（即第一次是抖动）
  if (allZero(r)) {
    retried = true;
    await new Promise((s) => setTimeout(s, 400));
    const r2 = await httpGet(WALLETS_PATH, token, 15000, 'qwenwork.cn', agentOpts);
    if (r2.status === 200 && r2.data && !allZero(r2)) {
      // 重试拿到了非 0 —— 第一次确实是抖动，用第二次的结果
      r = r2;
      retryRecovered = true;
    }
  }

  const d = r.data.data || {};
  const activeWallets = (d.active_wallets && Array.isArray(d.active_wallets.wallets))
    ? d.active_wallets.wallets : [];
  const monthlyVal = num((d.monthly_credits || {}).total_balance);
  const longtermVal = num((d.longterm_credits || {}).total_balance);
  const dailyVal = num((d.daily_credits || {}).total_balance);

  // 交叉验证（2026-10-02 加 daily 版，2026-11-02 改成 total 版）：
  // wallets 报「三池全 0」且重试也没恢复时，拿 account-context 的
  // `quota.remaining` 核对——它是权威口径。
  //
  // **为什么触发条件从「daily 读数为 0」改成「三池全 0」**：2026-11-01 起上游
  // 不再发放每日免费额度，daily 常态就是 0。按旧条件，**每一次余额查询都会
  // 多打一次 account-context**（把每条请求的归因从 2 次上游调用放大成 3 次），
  // 而它想救的那个「daily 被谎报成 0」已经不存在了。现在只在真的可疑
  // （全 0）时才验证。
  //
  // 判据：remaining > 0.005 才认定是坏读。真耗尽时 remaining 也≈0，不校正，
  // 如实报 0 + retried。取不到 remaining 时也不校正，回落成「如实报 0 + retried」。
  //
  // **校正时不编造池分配**：remaining 只给总数，分不出是哪个池。所以
  // `daily/monthly/longterm` 一律 null（未知），`total` 用权威值，标 misread。
  // 编一个「daily = remaining − paid」正是旧实现做的事——现在 daily 不再是
  // 重点，把总数硬拆进池子只会又造一个假数字。
  let authoritativeTotal = null;
  let misread = false;
  if (dailyVal === 0 && monthlyVal === 0 && longtermVal === 0) {
    const remaining = await fetchQuotaRemaining(token, agentOpts);
    if (remaining != null && Number.isFinite(remaining) && remaining > 0.005) {
      authoritativeTotal = remaining;
      misread = true;
      // 已校正 ⇒ 这次的 0 已解释清楚，不是「无法判定的异常」，不标 retried
      retried = false;
    }
  }

  // 月度额度的刷新时刻：取 active_wallet 里最早的那个 valid_to。
  // 这是**上游唯一给出的「额度什么时候变」的时间点**（实测 2026-12-01T00:00+08:00，
  // 两个账号一致）——Free 号的月度额度月初刷新，界面上要让用户看得到，
  // 否则「还剩 74.45」会被读成「永久可用」。
  const refreshAt = activeWallets
    .map((w) => String(w.valid_to || ''))
    .filter((s) => s && Number.isFinite(Date.parse(s)))
    .sort()[0] || null;

  const out = {
    ok: true,
    // 坏读校正后池子余额未知（null），不是 0——0 会被读成「用完了」
    daily: misread ? null : dailyVal,
    monthly: misread ? null : monthlyVal,
    longterm: misread ? null : longtermVal,
    // 只有「重试过且仍是全 0」才标出来——那才是值得排查的状态
    // （可能真耗尽，也可能上游持续异常）。抖动后恢复的不算异常，不标。
    ...(retried && !retryRecovered ? { retried: true } : {}),
    // wallets 报全 0 而 account-context 给出正数：这是坏读，已用权威总数校正
    ...(misread ? { misread: true, poolsUnknown: true, authoritativeTotal } : {}),
    // 上游 active_wallets 原样透出（balance + valid_to），排障与界面都要用
    activeWallets: activeWallets.map((w) => ({
      balance: num(w.balance),
      valid_to: String(w.valid_to || ''),
    })),
    refreshAt,
    // 上游自己给的「即将过期」列表——**这才是会作废的那部分**（付费积分
    // 按有效期，过期即消失）。count/total_balance 为 0 时是空数组。
    expiringSoon: (() => {
      const es = d.expiring_soon || {};
      const ws = Array.isArray(es.wallets) ? es.wallets : [];
      return {
        count: num(es.count),
        total: num(es.total_balance),
        wallets: ws.map((w) => ({
          balance: num(w.balance),
          valid_to: String(w.valid_to || ''),
        })),
      };
    })(),
    fetchedAt: Date.now(),
  };
  // 合计：坏读时用权威总数，否则是三池之和。未知就如实 null，不补 0。
  out.total = misread ? authoritativeTotal : (out.daily + out.monthly + out.longterm);
  out.paid = misread ? null : (out.monthly + out.longterm);
  caches.set(key, { at: Date.now(), data: out });
  return out;
}

// ---------------------------------------------------------------------------
// 按请求归因
//
// 三个必须串行的理由，缺一个都会算错：
//   1. 并发请求下「前后差值」会互相穿插——A 的 after 可能已包含 B 的扣费
//   2. 「请求前余额」也必须在队列内读。若在队列外读，B 可能拿到 A 扣费前的
//      旧值，于是 B 的差值把 A 的消耗也算进去，重复计一次
//   3. 结算有延迟（实测 < 1s），after 要等一拍再读
//
// 所以这里维护一个「上一次结算后的余额」作为基准，每次采集完更新它。
// 与 points-cursor.js 同一思路（那里也是宁可排队也不缺档）。
//
// **基准与队列都按账号分开**（src/traework/credits.js 的 queues 同款）：
// 共用一个基准会把 A 的余额当成 B 的起点，于是第一条跨账号的差值
// 等于两个账号余额之差——一个完全编出来的数。
// ---------------------------------------------------------------------------
const queues = new Map();   // 账号 id → Promise（串行队列）
const baselines = new Map(); // 账号 id → 上一次结算后的余额

// 归因节流（审计 P1-4）：每次归因要「前后两次」打上游余额接口（force 读，
// 不走 30s 缓存），匿名刷网关等于把每条请求放大成两次上游调用。TTL 内同一
// 账号只做一次实测归因，窗口内的请求不落归因记录（与首个请求无基准时的
// 行为一致），窗口两端的差值涵盖期间消耗总量。DUMATE_QWENWORK_CREDIT_TTL_MS 可调。
const CAPTURE_TTL_MS = Math.max(0, parseInt(process.env.DUMATE_QWENWORK_CREDIT_TTL_MS || '60000', 10));
const lastCaptureAt = new Map();

/** 账号在队列里的 key。没有 id 就退回 token 尾段，保证同一身份同一条队列 */
function queueKeyOf(account) {
  return String((account && account.id) || tokenOf(account).slice(-8) || 'unknown');
}

/** 余额快照只留三个数字；坏读（null）时整份给 null——不能与 0 混为一谈 */
function snapOf(w) {
  if (!w || !w.ok) return null;
  if (w.daily == null || w.monthly == null || w.longterm == null) return null;
  return { daily: w.daily, monthly: w.monthly, longterm: w.longterm };
}

/**
 * 采集一次请求的积分消耗。**必须在请求完成之后调用**——请求本身要几秒
 * （实测 4s），若在发出前调用，等待 1.2s 就读余额会读到请求还没结算的状态。
 *
 * @param {object} opts
 * @param {object} opts.account  本次实际使用的账号（**必填**：余额与基准都是账号级的）
 * @param {string} opts.model   模型名，写进归因记录
 * @param {number} opts.startedAt 请求开始时刻
 * @param {string} [opts.reqId] 请求埋点的 req_id。**两边靠它对齐**——
 *   归因要等 1.5s 结算，时间戳对不上；不带这个键就只能靠时间猜，
 *   同一秒内两条请求会互相串账。
 * @returns {Promise<{free:number, paid:number, pool:string}|null>}
 */
function capture(opts = {}) {
  const account = opts.account;
  if (!account) return Promise.resolve(null);
  const key = queueKeyOf(account);
  // 节流窗口内不打上游、不落归因
  const last = lastCaptureAt.get(key) || 0;
  if (CAPTURE_TTL_MS && Date.now() - last < CAPTURE_TTL_MS) return Promise.resolve(null);
  lastCaptureAt.set(key, Date.now());
  const run = async () => {
    // 首次没有基准，只建立它，不产出归因（否则会把历史消耗算到这次请求上）
    if (!baselines.has(key)) {
      const w = await fetchWallets({ account, force: true });
      const s = snapOf(w);
      if (!s) return null;
      baselines.set(key, s);
      return null;
    }
    const before = baselines.get(key);
    // 等结算。实测延迟 < 1s，留 1.5s 余量
    await new Promise((s) => setTimeout(s, 1500));
    const after = await fetchWallets({ account, force: true });
    const s = snapOf(after);
    // 坏读（余额未知）时**不更新基准也不落记录**：把 null 当 0 写进基准，
    // 下一条请求的差值会把整份额度算成一次消耗。
    if (!s) return null;
    baselines.set(key, s);

    const free = Math.max(0, num(before.daily) - num(s.daily));
    const paid = Math.max(0, (num(before.monthly) + num(before.longterm))
      - (num(s.monthly) + num(s.longterm)));
    // 哪个池减少就是消耗的哪种。**2026-11-01 起 free 恒 0**（上游不再发放
    // 每日免费额度），实测消耗全部落 paid；这个判据保留是因为历史数据里
    // free 是真值，且额度政策随时可能回来。
    const pool = free > 0 ? 'daily' : (paid > 0 ? 'paid' : 'none');
    const entry = {
      ts: Date.now(),
      // req_id：与请求埋点（requests.jsonl）的同一字段对齐。
      // 归因要等 1.5s 结算，ts 必然晚于埋点；只有这个键能精确配对。
      req_id: opts.reqId || '',
      model: opts.model || '',
      ms: opts.startedAt ? Date.now() - opts.startedAt : null,
      free: Number(free.toFixed(6)),
      paid: Number(paid.toFixed(6)),
      total: Number((free + paid).toFixed(6)),
      pool,
      balance: s,
      // 扣的是哪个千问账号。多账号下「哪个账号花了多少」正是这条通道最要紧的
      // 信息。
      //
      // **account 保持对象形状**：前端（web/src/api/reqlogs.ts 的 qw_account
      // 与 ReqLogsView 的 .name / .tier）按 {id,name,tier,planId} 渲染，改成
      // 字符串会让那些格子直接空白。所以只**新增** account_id，不换形状。
      account_id: account.id != null ? account.id : null,
      account: {
        id: String(account.id != null ? account.id : ''),
        name: account.nickname || account.username || '',
        tier: account.tier || '',
        planId: account.planId || '',
      },
    };
    // 并发时「前后差值」分不清是谁消耗的——总和正确、单项归属不准。
    // 如实标记而不是假装精确，聚合时可按需排除。
    if (opts.concurrent) entry.concurrent = true;
    record(entry);
    return entry;
  };
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(run, run);
  queues.set(key, next.catch(() => {}));
  return next;
}

/**
 * 主动建立基准（管理端刷新时用，避免第一次请求归因不出结果）。
 * 按账号逐个建——池里有几个账号就要几个基准。
 */
async function primeBaseline(accounts) {
  const list = Array.isArray(accounts) ? accounts : (accounts ? [accounts] : []);
  const out = [];
  for (const a of list) {
    if (!a) continue;
    const w = await fetchWallets({ account: a, force: true });
    const s = snapOf(w);
    if (s) {
      baselines.set(queueKeyOf(a), s);
      out.push({ id: a.id, ok: true });
    } else {
      out.push({ id: a.id, ok: false, error: w.error || '余额未知（上游坏读）' });
    }
  }
  return out;
}

/** 丢掉某账号的基准与队列（删除账号时调用，避免 Map 泄漏） */
function forget(account) {
  if (!account) return;
  const key = queueKeyOf(account);
  baselines.delete(key);
  queues.delete(key);
  lastCaptureAt.delete(key);
  caches.delete(String(account.id || ''));
}

/** 读归因历史（供管理端按天聚合）。rows 已带 req_id，可按请求精确关联 */
function readHistory(limit = 0) {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(
    process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data'),
    'qwenwork-credits.jsonl'
  );
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const rows = [];
    for (const l of lines) {
      try { rows.push(JSON.parse(l)); } catch (e) { /* 跳过坏行 */ }
    }
    return limit > 0 ? rows.slice(-limit) : rows;
  } catch (e) {
    return [];
  }
}

/**
 * 按 req_id 建索引，供请求日志按条附上积分消耗。
 * 用「最后一条同 id 的记录」——重试或重复采集时以最新为准。
 */
function indexByReqId() {
  const map = new Map();
  for (const r of readHistory()) {
    if (r && r.req_id) map.set(r.req_id, r);
  }
  return map;
}

function record(entry) {
  const fs = require('fs');
  const path = require('path');
  const jsonl = require('../jsonl');
  const dir = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 大小轮转（jsonl.js）：逐请求归因文件不设限会无限增长
    jsonl.append(path.join(dir, 'qwenwork-credits.jsonl'), `${JSON.stringify(entry)}\n`);
  } catch (e) { /* 埋点失败绝不影响正在转发的响应 */ }
}

module.exports = {
  fetchWallets, capture, primeBaseline, forget, readHistory, indexByReqId, record,
  SITE_ORIGIN, WALLETS_PATH,
};
