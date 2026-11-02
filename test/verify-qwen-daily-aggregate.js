// test/verify-qwen-daily-aggregate.js - 千问「多账号余额合计」的离线验证
//
// 不依赖网关/上游：把 qwenwork 管理路由挂上假的上游返回，验证**合计口径**。
//
// 背景（2026-09-30）：用户报「千问仪表盘每日额度显示不对，两个账号应该是
// 200 才对，今天都还没用」。根因是 `/api/admin/qwenwork/credits` 只读
// **主账号**，而同页顶部「积分余额」读的是 `/accounts` 的 summary.pointsTotal
// （本来就是全账号合计）——两个数字对不上，被读成「少算了一个账号」。
//
// **2026-11-02 口径变更**：上游已停止发放每日免费额度（daily 池实测恒 0），
// 「每日上限 / 观测峰值 / 今日已用」那一整套推断随之删除。本脚本改为钉住
// 剩下这些仍然成立的不变量：
//
//   1. /credits 的池子余额 = 各账号之和（不是主账号那一个）
//   2. /credits.total === /accounts.summary.pointsTotal（同页两处必须相等）
//   3. 有账号查询失败时，failedAccounts 如实报出、合计只含成功的账号
//   4. **余额未知（null）不参与求和，也不被当成 0**——合计只含已知的账号，
//      并标 partial + totalKnown，让「部分和」这件事看得见
//   5. 上游坏读校正过的账号（misread）计入 misreadAccounts，池子余额是 null
//      但 total 可信（来自 account-context 的权威值）
const path = require('path');

// 拦截 credits 模块的 fetchWallets：按账号返回预设余额，不打网络。
// 必须在上层 require 之前装好——路由是模块加载时 require 一次。
const creditsPath = require.resolve('../src/qwenwork/credits');
const realCredits = require(creditsPath);

// 假余额形状：daily 恒 0（上游现状），monthly 是唯一有余额的池
const FAKE = {
  1: { daily: 0, monthly: 100, longterm: 0, total: 100, refreshAt: '2026-12-01T00:00:00+08:00' },
  2: { daily: 0, monthly: 100, longterm: 0, total: 100, refreshAt: '2026-12-01T00:00:00+08:00' },
};
let failIds = new Set(); // 这些账号返回查询失败
let misreadIds = new Set(); // 这些账号返回坏读校正态（池子 null、total 权威）
let unknownIds = new Set(); // 这些账号 ok 但 total 未知（null）

const origFetch = realCredits.fetchWallets;
realCredits.fetchWallets = async (opts = {}) => {
  const id = opts.account && opts.account.id;
  if (failIds.has(id)) {
    return { ok: false, error: `模拟失败: 账号 ${id}`, daily: null, monthly: null, longterm: null };
  }
  const f = FAKE[id];
  if (!f) return { ok: false, error: `未知账号 ${id}`, daily: null, monthly: null, longterm: null };
  if (misreadIds.has(id)) {
    return {
      ok: true, error: '',
      daily: null, monthly: null, longterm: null,
      total: 42.5, misread: true, poolsUnknown: true, authoritativeTotal: 42.5,
      refreshAt: f.refreshAt,
      activeWallets: [], expiringSoon: { count: 0, total: 0, wallets: [] },
      fetchedAt: Date.now(),
    };
  }
  if (unknownIds.has(id)) {
    return {
      ok: true, error: '',
      daily: null, monthly: null, longterm: null, total: null,
      refreshAt: f.refreshAt,
      activeWallets: [], expiringSoon: { count: 0, total: 0, wallets: [] },
      fetchedAt: Date.now(),
    };
  }
  return {
    ok: true, error: '',
    daily: f.daily, monthly: f.monthly, longterm: f.longterm,
    total: f.total,
    refreshAt: f.refreshAt,
    activeWallets: [], expiringSoon: { count: 0, total: 0, wallets: [] },
    fetchedAt: Date.now(),
  };
};

// 同样拦掉 auth 模块：给两个账号（不走真实 data/ 文件）
const authPath = require.resolve('../src/qwenwork/auth');
const realAuth = require(authPath);
const ACCOUNTS = [
  { id: 1, uid: 'u1', nickname: '账号甲', enabled: true, preferred: true, accessToken: 't1', refreshToken: 'r1' },
  { id: 2, uid: 'u2', nickname: '账号乙', enabled: true, preferred: false, accessToken: 't2', refreshToken: 'r2' },
];
realAuth.list = () => ACCOUNTS.map((a) => ({ ...a }));
realAuth.get = (id) => ACCOUNTS.find((a) => String(a.id) === String(id)) || null;
// needsRefresh 恒 false：别让路由去换票（那是真网络）
realAuth.needsRefresh = () => false;

const { routes, resetCache } = require('../src/admin/routes/qwenwork');

function fakeRes() {
  const o = { code: 0, body: null };
  o.writeHead = (c) => { o.code = c; };
  o.end = (b) => { o.body = b; };
  o.setHeader = () => {};
  return o;
}

async function call(p) {
  // 路由层有 15s 余额缓存，场景之间必须清掉，否则第二个场景读到第一个的结果
  resetCache();
  const r = routes.find((x) => x.path === p);
  const res = fakeRes();
  await r.handler({ req: { url: p }, res, body: null, params: [] });
  return JSON.parse(res.body);
}

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

function reset() { failIds = new Set(); misreadIds = new Set(); unknownIds = new Set(); }

(async () => {
  console.log('== 两账号各 100 月度额度：合计应为 200 ==');
  reset();
  const c = await call('/credits');
  const a = await call('/accounts');

  const monthly = c.wallets.find((w) => w.id === 'monthly').balance;
  const sumMonthly = c.accounts.reduce((s, x) => s + (x.monthly || 0), 0);

  check('月度池是各账号之和', monthly === sumMonthly && monthly === 200,
    `monthly=${monthly}, 各账号之和=${sumMonthly}`);
  check('月度不是单个账号的值', monthly !== 100, `monthly=${monthly}`);
  check('accountCount 报出 2', c.accountCount === 2, String(c.accountCount));
  check('partial=false（两个账号余额都已知）', c.partial === false, String(c.partial));
  check('totalKnown=2', c.totalKnown === 2, String(c.totalKnown));

  // 同页两处口径必须相等——这正是用户看到的「对不上」
  check('/credits.total === /accounts.summary.pointsTotal',
    c.total === a.summary.pointsTotal,
    `${c.total} vs ${a.summary.pointsTotal}`);
  check('summary.pointsTotal 也是 200', a.summary.pointsTotal === 200, String(a.summary.pointsTotal));

  console.log('');
  console.log('== 每日额度池已彻底移除（上游停发，恒 0）==');
  // 2026-11-02：用户明确要求「每日额度没有了可以删除，不要再显示」。
  // 所以 daily 不再出现在 wallets 里——留一张永远显示 0 的卡会被读成
  // 「今天用光了」。
  check('wallets 里没有 daily', !c.wallets.some((w) => w.id === 'daily'),
    JSON.stringify(c.wallets.map((w) => w.id)));
  check('只剩两个付费池（monthly + longterm）', c.wallets.length === 2, String(c.wallets.length));
  check('没有 free 汇总字段', c.free === undefined, String(c.free));
  check('没有 dailyCap 字段（该口径已删除）', c.dailyCap === undefined, String(c.dailyCap));
  check('没有 freeUsed 字段（推不出，不编）', c.freeUsed === undefined, String(c.freeUsed));
  check('没有 limit/calibrated 字段（上限概念已删除）',
    c.limit === undefined && c.calibrated === undefined,
    `limit=${c.limit}, calibrated=${c.calibrated}`);
  check('today 只有 total/requests（不再拆 free/paid）',
    c.today.free === undefined && c.today.paid === undefined
      && typeof c.today.total === 'number',
    JSON.stringify(c.today));

  console.log('');
  console.log('== 有一个账号查不到时：合计只含成功的，并如实报失败数 ==');
  failIds = new Set([2]);
  const c2 = await call('/credits');
  check('failedAccounts 报出 1', c2.failedAccounts === 1, String(c2.failedAccounts));
  check('accountCount 降为 1', c2.accountCount === 1, String(c2.accountCount));
  check('月度只含成功账号（100，不是 200）',
    c2.wallets.find((w) => w.id === 'monthly').balance === 100,
    String(c2.wallets.find((w) => w.id === 'monthly').balance));
  check('仍 ok=true（部分成功不算整体失败）', c2.ok === true, String(c2.ok));
  check('retriedAccounts 默认 0（假上游没标 retried）', c2.retriedAccounts === 0, String(c2.retriedAccounts));

  console.log('');
  console.log('== 余额未知（null）不参与求和，也不被当成 0 ==');
  // 这是最容易写错的一条：`(a.total || 0)` 或 `n(null)=0` 会把「不知道」
  // 写成「没有」，合计凭空少掉一个账号的额度，用户读成「积分掉了」。
  reset();
  unknownIds = new Set([2]);
  const c3 = await call('/credits');
  check('totalKnown 报出 1（不是 2）', c3.totalKnown === 1, String(c3.totalKnown));
  check('partial=true', c3.partial === true, String(c3.partial));
  check('合计只含已知的 1 个账号（100，不是 200）', c3.total === 100, String(c3.total));
  check('未知账号的 total 是 null（不是 0）',
    c3.accounts.find((x) => x.id === '2').total === null,
    String(c3.accounts.find((x) => x.id === '2').total));
  check('每账号明细不带 daily 字段', c3.accounts.every((x) => x.daily === undefined),
    JSON.stringify(c3.accounts.map((x) => Object.keys(x))));

  console.log('');
  console.log('== 上游坏读校正过的账号：池子 null、total 可信，计入 misreadAccounts ==');
  reset();
  misreadIds = new Set([2]);
  const c4 = await call('/credits');
  check('misreadAccounts 报出 1', c4.misreadAccounts === 1, String(c4.misreadAccounts));
  check('该账号 total 用权威值 42.5',
    c4.accounts.find((x) => x.id === '2').total === 42.5,
    String(c4.accounts.find((x) => x.id === '2').total));
  check('该账号 monthly 是 null（池子分配未知，不编）',
    c4.accounts.find((x) => x.id === '2').monthly === null,
    String(c4.accounts.find((x) => x.id === '2').monthly));
  check('合计 total = 100 + 42.5', c4.total === 142.5, String(c4.total));

  console.log('');
  console.log('== 全部账号都查不到时：ok=false 并给出错误 ==');
  reset();
  failIds = new Set([1, 2]);
  const c5 = await call('/credits');
  check('ok=false', c5.ok === false, String(c5.ok));
  check('有 error 文案', typeof c5.error === 'string' && c5.error.length > 0, c5.error);

  console.log('');
  console.log('== 额度刷新时刻透出（不是「每日重置」）==');
  reset();
  const c6 = await call('/credits');
  check('resetAt 来自 active_wallet 的 valid_to',
    c6.resetAt === '2026-12-01T00:00:00+08:00', String(c6.resetAt));

  // 还原，避免影响同进程后续（脚本结束即退出，这里只为干净）
  reset();
  realCredits.fetchWallets = origFetch;

  console.log('');
  if (failures) {
    console.log(`${failures} 项失败`);
    process.exit(1);
  }
  console.log('全部通过');
  process.exit(0);
})();
