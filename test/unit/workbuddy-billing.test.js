// test/unit/workbuddy-billing.test.js - WorkBuddy 计费自检的纯函数
//
// 口径与 traework/billing.js 同一定位：实测倍率 = 套餐剩余额差值 ÷ (tokens/1000)。
// 这里锁边界：负差值（结算回滚）、单账号归属、并发多账号串账、免费档不做除法。
const { test } = require('node:test');
const assert = require('assert');
const billing = require('../../src/workbuddy/billing');

test('billedRate：正常换算与四位小数', () => {
  assert.equal(billing.billedRate(0.34, 1000), 0.34);
  assert.equal(billing.billedRate(0.05, 200), 0.25);
  assert.equal(billing.billedRate(0.123456, 1000), 0.1235); // 四舍五入到 4 位
});

test('billedRate：0 是合法测量（没扣费），负值/零 token/缺失如实 null', () => {
  assert.equal(billing.billedRate(0, 1000), 0);
  assert.equal(billing.billedRate(-0.1, 1000), null);   // 结算回滚，不编
  assert.equal(billing.billedRate(0.1, 0), null);
  assert.equal(billing.billedRate(null, 1000), null);
  assert.equal(billing.billedRate(0.1, null), null);
});

test('ratioOf：正常比值；expected 为 0（免费档）或缺失时 null', () => {
  assert.equal(billing.ratioOf(0.34, 0.34), 1);
  assert.equal(billing.ratioOf(0.3, 0.2), 1.5);
  assert.equal(billing.ratioOf(0.1, 0), null);
  assert.equal(billing.ratioOf(null, 0.2), null);
  assert.equal(billing.ratioOf(0.1, null), null);
});

test('attributeDelta：服务账号的增量优先', () => {
  const before = new Map([['1', 100], ['2', 50]]);
  const after = new Map([['1', 100], ['2', 49.5]]);
  const r = billing.attributeDelta(before, after, 2);
  assert.equal(r.delta, 0.5);
  assert.deepEqual(r.charged, [{ id: '2', delta: 0.5 }]);
  assert.equal(r.singleAccount, true);
});

test('attributeDelta：服务账号没扣费时不借用别人账号的增量', () => {
  const before = new Map([['1', 100], ['2', 50]]);
  const after = new Map([['1', 99.5], ['2', 50]]);
  const r = billing.attributeDelta(before, after, 2);
  assert.equal(r.delta, null);   // 别把账号 1 的并发消耗算到这次探针头上
  assert.deepEqual(r.charged, [{ id: '1', delta: 0.5 }]);
});

test('attributeDelta：无 servedId 时仅「恰好一个账号被扣费」才采信', () => {
  const before = new Map([['1', 100], ['2', 50]]);
  const one = billing.attributeDelta(before, new Map([['1', 99], ['2', 50]]), null);
  assert.equal(one.delta, 1);
  assert.equal(one.singleAccount, true);
  const two = billing.attributeDelta(before, new Map([['1', 99], ['2', 49]]), null);
  assert.equal(two.delta, null); // 两个账号同时涨 = 有并发流量，合并会失真
  assert.equal(two.singleAccount, false);
  assert.equal(two.charged.length, 2);
});

test('attributeDelta：余额不变/缺失的账号不进 charged', () => {
  const before = new Map([['1', 100], ['2', 50]]);
  const after = new Map([['1', 100], ['2', 50]]);
  const r = billing.attributeDelta(before, after, 1);
  assert.equal(r.delta, null);
  assert.deepEqual(r.charged, []);
  // after 缺失某账号（快照失败）：跳过，不补 0
  const partial = billing.attributeDelta(before, new Map([['1', 99]]), 1);
  assert.equal(partial.delta, 1);
  assert.deepEqual(partial.charged, [{ id: '1', delta: 1 }]);
});

// ---------------------------------------------------------------------------
// 套餐解析（2026-11-04 真机夹具：get-user-resource 的 Accounts[0] 原样字段）
// ---------------------------------------------------------------------------

const REAL_PACKAGE = {
  AccountId: 1013812937713868400,
  CycleStartTime: '2026-10-04 09:00:12',
  CycleEndTime: '2026-11-04 09:00:11',
  DeductionEndTime: 1793754011000,
  PackageName: 'CodeBuddy个人版国内运营裂变包',
  CapacityRemain: 8,
  CapacityUsed: 1,
  CapacitySize: 9,
  CycleCapacityRemain: 8,
  CycleCapacitySize: 9,
  CycleCapacityUsed: 1,
  CycleCapacityRemainPrecise: '8.8',
  CycleCapacitySizePrecise: '9',
  ExpiredTime: '',
  Status: 0,
};

test('parseBeijingTime：北京时间字符串 → 毫秒（与 DeductionEndTime 逐位一致）', () => {
  assert.equal(billing.parseBeijingTime('2026-11-04 09:00:11'), 1793754011000);
  assert.equal(billing.parseBeijingTime(''), null);
  assert.equal(billing.parseBeijingTime('2026-11-04'), null);
  assert.equal(billing.parseBeijingTime('not a time'), null);
  assert.equal(billing.parseBeijingTime(null), null);
});

test('decimalsOf：小数位数（量化分辨率推算用）', () => {
  assert.equal(billing.decimalsOf('8.8'), 1);
  assert.equal(billing.decimalsOf('0.25'), 2);
  assert.equal(billing.decimalsOf('8'), null);     // 整数串无小数位
  assert.equal(billing.decimalsOf(''), null);
  assert.equal(billing.decimalsOf(null), null);
});

test('parsePackages：真机夹具——整数 floor + 精确余额 + 到期时间', () => {
  const r = billing.parsePackages([REAL_PACKAGE]);
  assert.equal(r.total, 8);                          // 整数 remain（floor）
  assert.equal(r.totalPrecise, 8.8);                 // 精确合计
  assert.equal(r.preciseDecimals, 1);                // 上游 1 位小数
  assert.equal(r.packages[0].remain, 8);
  assert.equal(r.packages[0].remainPrecise, 8.8);
  assert.equal(r.packages[0].expireAt, 1793754011000, 'CycleEndTime 按北京时间解析');
  assert.equal(r.packages[0].size, 9);
});

test('parsePackages：旧形状（无 Cycle/Precise 字段）如实降级，不编数', () => {
  const r = billing.parsePackages([{ PackageName: '旧包', CapacityRemain: 12, CapacitySize: 20 }]);
  assert.equal(r.total, 12);
  assert.equal(r.totalPrecise, null);
  assert.equal(r.preciseDecimals, null);
  assert.equal(r.packages[0].remain, 12);
  assert.equal(r.packages[0].remainPrecise, null);
  assert.equal(r.packages[0].expireAt, null);
});

test('parsePackages：负余额归 0；非对象行跳过', () => {
  const r = billing.parsePackages([
    { PackageName: '负数包', CapacityRemain: -5, CapacitySize: 10 },
    null,
    { PackageName: '正常包', CycleCapacityRemain: 3, CycleCapacitySize: 5, CycleCapacityRemainPrecise: '3.05' },
  ]);
  assert.equal(r.total, 3);
  assert.equal(r.packages[0].remain, 0);
  assert.equal(r.totalPrecise, 3.05);
  assert.equal(r.preciseDecimals, 2);
  assert.equal(r.packages.length, 2);
});

test('fetchCredits：成功响应带 ok:true（/credits、探针、keepalive 都按它判定）', async () => {
  // 2026-11-04 回归：重构时丢过 ok:true，下游 q.ok 全部失效、FEFO 快照写空
  const https = require('https');
  const realRequest = https.request;
  const RESP = JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [REAL_PACKAGE] } } } });
  https.request = (opts, cb) => {
    const { EventEmitter } = require('events');
    const fakeRes = new EventEmitter();
    fakeRes.statusCode = 200;
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.write = () => {};
    req.end = () => {
      setImmediate(() => {
        cb(fakeRes);
        setImmediate(() => {
          fakeRes.emit('data', Buffer.from(RESP));
          fakeRes.emit('end');
        });
      });
    };
    req.destroy = () => {};
    return req;
  };
  try {
    const r = await billing.fetchCredits('cn', { accessToken: 't', uid: 'u', domain: 'copilot.tencent.com', region: 'cn' });
    assert.equal(r.ok, true);
    assert.equal(r.total, 8);
    assert.equal(r.totalPrecise, 8.8);
    assert.equal(r.preciseDecimals, 1);
    assert.equal(r.packages[0].expireAt, 1793754011000);
  } finally {
    https.request = realRequest;
  }
});

// ---------------------------------------------------------------------------
// 账号档位（hub v1.7.27 #505）
// ---------------------------------------------------------------------------

test('parseTierSummary：IsPaidUser 是唯一可信来源，缺字段 = 没有答案（null）', () => {
  assert.deepEqual(
    billing.parseTierSummary({ IsPaidUser: true, SubscriptionPackageName: 'Pro', IsProtectedPriceUser: false, ProTrialStatus: '' }),
    { paid: true, package: 'Pro', protectedPrice: false, trial: '' },
  );
  assert.deepEqual(
    billing.parseTierSummary({ IsPaidUser: false, SubscriptionPackageName: 'Free' }),
    { paid: false, package: 'Free', protectedPrice: false, trial: '' },
  );
  // 没有 IsPaidUser：绝不写成「免费」
  assert.equal(billing.parseTierSummary({ SubscriptionPackageName: 'Free' }), null);
  // IsPaidUser 在场即下结论——false 是「确认免费」，与「没有答案」是两回事
  assert.deepEqual(
    billing.parseTierSummary({ IsPaidUser: false, ProTrialStatus: 'x' }),
    { paid: false, package: '', protectedPrice: false, trial: 'x' },
  );
  assert.equal(billing.parseTierSummary(null), null);
  assert.equal(billing.parseTierSummary('x'), null);
});

test('tierIsFresh：24h 内新鲜，过期/无结论为 false', () => {
  const now = Date.now();
  assert.equal(billing.tierIsFresh({ tier: { at: now - 1000 } }), true);
  assert.equal(billing.tierIsFresh({ tier: { at: now - 25 * 3600 * 1000 } }), false);
  assert.equal(billing.tierIsFresh({ tier: null }), false);
  assert.equal(billing.tierIsFresh({}), false);
});

test('maybeRefreshTier：刷新落档案；失败保留旧值；TTL 内读缓存；企业账号跳过', async () => {
  const { test: _t } = require('node:test');
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  process.env.DUMATE_ADMIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-wb-tier-'));
  const billingFresh = (() => { delete require.cache[require.resolve('../../src/workbuddy/billing')]; return require('../../src/workbuddy/billing'); })();
  const patched = [];
  billingFresh._setFetchTier(async (region, acc) => {
    if (acc.fail) return null;
    return { paid: true, package: 'Pro', protectedPrice: false, trial: '' };
  });
  const authStore = require('../../src/workbuddy/auth');
  const realPatch = authStore.patch;
  authStore.patch = (id, p) => { patched.push({ id, p }); return { id, ...p }; };
  try {
    // 成功刷新 → 落档案带 at
    const a1 = { id: 1, region: 'cn', accessToken: 't' };
    const t1 = await billingFresh.maybeRefreshTier(a1);
    assert.equal(t1.paid, true);
    assert.ok(t1.at > 0);
    assert.equal(patched.length, 1);
    // TTL 内读缓存：不再打上游（impl 改成抛错也不影响）
    billingFresh._setFetchTier(async () => { throw new Error('should not call'); });
    const t2 = await billingFresh.maybeRefreshTier({ ...a1, tier: t1 });
    assert.equal(t2, t1);
    // 强制刷新 + 失败（impl 抛异常或返回 null 都算失败）：旧值原样保留
    const a2 = { id: 2, region: 'cn', accessToken: 't', tier: { paid: true, package: 'Old', at: 1 }, fail: true };
    billingFresh._setFetchTier(async () => null);
    const t3 = await billingFresh.maybeRefreshTier(a2, { force: true });
    assert.deepEqual(t3, { paid: true, package: 'Old', at: 1 });
    billingFresh._setFetchTier(async () => { throw new Error('network'); });
    const t4 = await billingFresh.maybeRefreshTier({ ...a2, tier: { paid: true, package: 'Old2', at: 2 } }, { force: true });
    assert.deepEqual(t4, { paid: true, package: 'Old2', at: 2 }, 'impl 抛异常同样保留旧值');
    // 企业账号：上游语义未验证，直接跳过（null）
    billingFresh._setFetchTier(async () => { throw new Error('should not call'); });
    assert.equal(await billingFresh.maybeRefreshTier({ id: 3, region: 'cn', accessToken: 't', enterpriseId: 'e1', force: true }), null);
  } finally {
    authStore.patch = realPatch;
  }
});
