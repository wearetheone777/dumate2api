// test/unit/trae-billing.test.js - TRAE 计费自检的纯函数（node:test）
//
// 探针（admin/routes/traework.js 的 /billing-check）打上游拿 consumed 前后
// 差值；这里的函数负责「期望倍率选择 / 实测倍率换算 / 消耗增量归属」。
// 口径依据见 src/traework/billing.js 顶部注释（历史账本反推，非上游文档）。
const { test } = require('node:test');
const assert = require('assert');
const billing = require('../../src/traework/billing');

test('expectedRate: 命中会员折扣取折后价', () => {
  assert.strictEqual(billing.expectedRate({
    rate: 0.78, rateOriginal: 0.78, rateDiscounted: 0.39, discountMatched: true,
  }), 0.39);
});

test('expectedRate: 未命中折扣取标称价（不拿折后价冒充分子）', () => {
  assert.strictEqual(billing.expectedRate({
    rate: 0.78, rateOriginal: 0.78, rateDiscounted: 0.39, discountMatched: false,
  }), 0.78);
});

test('expectedRate: 标称缺失回退原价；都缺失如实 null，不编 0', () => {
  assert.strictEqual(billing.expectedRate({ rate: null, rateOriginal: 0.5, rateDiscounted: null }), 0.5);
  assert.strictEqual(billing.expectedRate({ rate: null, rateOriginal: null, rateDiscounted: null }), null);
  assert.strictEqual(billing.expectedRate(null), null);
});

test('expectedRate: rate 为 0 时不算有效标称（0 = 免费档，不是计费倍率）', () => {
  assert.strictEqual(billing.expectedRate({ rate: 0, rateOriginal: 0.3, discountMatched: false }), 0.3);
});

test('billedRate: consumed 增量 ÷ (tokens/1000)，四位小数', () => {
  // 实测样本：glm-5.2 一次 0.83 credits / 1111 tokens
  assert.strictEqual(billing.billedRate(0.83, 1111), 0.7471);
  // 0 是合法测量（本次没扣费），保留 0 而不是 null
  assert.strictEqual(billing.billedRate(0, 500), 0);
});

test('billedRate: 负增量与零 token 如实 null（结算回滚/未计量）', () => {
  assert.strictEqual(billing.billedRate(-0.01, 500), null);
  assert.strictEqual(billing.billedRate(0.5, 0), null);
  assert.strictEqual(billing.billedRate(null, 500), null);
  assert.strictEqual(billing.billedRate(0.5, null), null);
});

test('ratioOf: 比值三位小数；任一侧缺失或分母非正时 null', () => {
  assert.strictEqual(billing.ratioOf(0.78, 0.78), 1);
  assert.strictEqual(billing.ratioOf(0.7471, 0.78), 0.958);
  assert.strictEqual(billing.ratioOf(null, 0.78), null);
  assert.strictEqual(billing.ratioOf(0.5, null), null);
  assert.strictEqual(billing.ratioOf(0.5, 0), null);
});

test('attributeDelta: 恰好一个账号被扣费时直接采用', () => {
  const before = new Map([['1', 100], ['2', 200]]);
  const after = new Map([['1', 100.83], ['2', 200]]);
  const r = billing.attributeDelta(before, after, null);
  assert.deepStrictEqual(r.charged, [{ id: '1', delta: 0.83 }]);
  assert.strictEqual(r.delta, 0.83);
  assert.strictEqual(r.singleAccount, true);
});

test('attributeDelta: 给了服务账号 id 就取它的增量（多账号并发时不被合并数字带偏）', () => {
  const before = new Map([['1', 100], ['2', 200]]);
  const after = new Map([['1', 100.83], ['2', 200.5]]);
  const r = billing.attributeDelta(before, after, 2);
  assert.strictEqual(r.delta, 0.5);
  assert.strictEqual(r.singleAccount, false);
  assert.strictEqual(r.charged.length, 2);
});

test('attributeDelta: 没给服务账号且多个账号涨 → delta null（合并会失真）', () => {
  const before = new Map([['1', 100], ['2', 200]]);
  const after = new Map([['1', 100.83], ['2', 200.5]]);
  const r = billing.attributeDelta(before, after, null);
  assert.strictEqual(r.delta, null);
  assert.strictEqual(r.singleAccount, false);
});

test('attributeDelta: 无增量 / 负增量（上游重置）/ 缺参照点都不算扣费', () => {
  const before = new Map([['1', 100], ['2', 200]]);
  const after = new Map([['1', 100], ['2', 199.5], ['3', 50]]);
  const r = billing.attributeDelta(before, after, null);
  assert.deepStrictEqual(r.charged, []);
  assert.strictEqual(r.delta, null);
  assert.strictEqual(r.singleAccount, false);
});
