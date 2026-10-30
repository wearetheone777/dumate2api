// test/unit/qwen-billing.test.js - 千问计费自检的纯函数（node:test）
//
// 探针（admin/routes/qwenwork.js 的 /billing-check）读三池余额前后差值。
// 这里的函数负责「差值口径（与 credits.capture 逐字一致）/ 每千 token 成本 /
// 消耗归属」。千问没有标称倍率，口径是纯测量（见 src/qwenwork/billing.js）。
const { test } = require('node:test');
const assert = require('assert');
const billing = require('../../src/qwenwork/billing');

test('walletDelta: 只扣 daily 时 free 计入、paid 为 0', () => {
  const r = billing.walletDelta(
    { daily: 100, monthly: 0, longterm: 0 },
    { daily: 99.998, monthly: 0, longterm: 0 },
  );
  assert.strictEqual(r.daily, 0.002);
  assert.strictEqual(r.free, 0.002);
  assert.strictEqual(r.paid, 0);
  assert.strictEqual(r.total, 0.002);
});

test('walletDelta: 扣付费池时 paid 计入（monthly + longterm 合计）', () => {
  const r = billing.walletDelta(
    { daily: 0, monthly: 10, longterm: 5 },
    { daily: 0, monthly: 9.5, longterm: 5 },
  );
  assert.strictEqual(r.free, 0);
  assert.strictEqual(r.paid, 0.5);
  assert.strictEqual(r.total, 0.5);
});

test('walletDelta: 余额回升（充值/重置）不形成负消耗', () => {
  const r = billing.walletDelta(
    { daily: 1, monthly: 0, longterm: 0 },
    { daily: 100, monthly: 0, longterm: 0 },
  );
  assert.strictEqual(r.daily, -99);
  assert.strictEqual(r.free, 0);
  assert.strictEqual(r.total, 0);
});

test('walletDelta: 与 credits.capture 同口径处理 longterm 负值（坏读补偿）', () => {
  // 账号 2 的已知坏读形态：daily 为正、longterm 等量负值，三池合计为 0
  const r = billing.walletDelta(
    { daily: 0, monthly: 0, longterm: -4.3 },
    { daily: 0, monthly: 0.5, longterm: -4.8 },
  );
  assert.strictEqual(r.monthly, -0.5);
  assert.strictEqual(r.longterm, 0.5);
  assert.strictEqual(r.paid, 0);
});

test('walletDelta: 任一侧缺字段时相应项如实 null，不补 0', () => {
  const r = billing.walletDelta({ daily: 100, monthly: null, longterm: 0 }, { daily: 99, monthly: 0, longterm: 0 });
  assert.strictEqual(r.free, 1);
  assert.strictEqual(r.paid, null);
  assert.strictEqual(r.total, null);
  assert.strictEqual(billing.walletDelta(null, { daily: 1 }), null);
});

test('perKTokens: 成本 ÷ (tokens/1000)，四位小数；0 是合法测量', () => {
  assert.strictEqual(billing.perKTokens(0.002, 1000), 0.002);
  assert.strictEqual(billing.perKTokens(0.005, 2222), 0.0023);
  assert.strictEqual(billing.perKTokens(0, 900), 0);
  assert.strictEqual(billing.perKTokens(0.5, 0), null);
  assert.strictEqual(billing.perKTokens(null, 900), null);
  assert.strictEqual(billing.perKTokens(-0.1, 900), null);
});

test('attributeWalletDelta: 恰好一个账号有消耗时直接采用', () => {
  const before = new Map([
    ['2', { daily: 4.3, monthly: 0, longterm: -4.3 }],
    ['3', { daily: 4.8, monthly: 0, longterm: 0 }],
  ]);
  const after = new Map([
    ['2', { daily: 4.3, monthly: 0, longterm: -4.3 }],
    ['3', { daily: 4.797, monthly: 0, longterm: 0 }],
  ]);
  const r = billing.attributeWalletDelta(before, after, null);
  assert.strictEqual(r.charged.length, 1);
  assert.strictEqual(r.delta.total, 0.003);
  assert.strictEqual(r.singleAccount, true);
});

test('attributeWalletDelta: 给了服务账号 id 就取它的（多账号同时变动不合并）', () => {
  const before = new Map([
    ['2', { daily: 4, monthly: 0, longterm: 0 }],
    ['3', { daily: 4, monthly: 0, longterm: 0 }],
  ]);
  const after = new Map([
    ['2', { daily: 3.9, monthly: 0, longterm: 0 }],
    ['3', { daily: 3.5, monthly: 0, longterm: 0 }],
  ]);
  const r = billing.attributeWalletDelta(before, after, '3');
  assert.strictEqual(r.delta.total, 0.5);
  assert.strictEqual(r.singleAccount, false);
  assert.strictEqual(r.charged.length, 2);
});

test('attributeWalletDelta: 没给服务账号且多个变动 → delta null', () => {
  const before = new Map([
    ['2', { daily: 4, monthly: 0, longterm: 0 }],
    ['3', { daily: 4, monthly: 0, longterm: 0 }],
  ]);
  const after = new Map([
    ['2', { daily: 3.9, monthly: 0, longterm: 0 }],
    ['3', { daily: 3.5, monthly: 0, longterm: 0 }],
  ]);
  const r = billing.attributeWalletDelta(before, after, null);
  assert.strictEqual(r.delta, null);
  assert.strictEqual(r.singleAccount, false);
});

test('attributeWalletDelta: 无消耗（含余额不足导致的 0 扣费）→ 未归属', () => {
  const before = new Map([['2', { daily: 4, monthly: 0, longterm: 0 }]]);
  const after = new Map([['2', { daily: 4, monthly: 0, longterm: 0 }]]);
  const r = billing.attributeWalletDelta(before, after, '2');
  assert.deepStrictEqual(r.charged, []);
  assert.strictEqual(r.delta, null);
});
