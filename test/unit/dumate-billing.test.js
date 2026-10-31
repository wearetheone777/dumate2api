// test/unit/dumate-billing.test.js - 搭子计费自检纯函数（2026-11-01）
//
// 搭子没有标称倍率（上游不吐 price_factor），探针只给实测「每千 token 积分
// 成本」。四态判定与 billedRate 边界在这里钉死。
const { test } = require('node:test');
const assert = require('node:assert');
const billing = require('../../src/dumate-billing');

test('billedRate：cost ÷ (tokens/1000)，四位小数', () => {
  assert.equal(billing.billedRate(0.5, 1000), 0.5);
  assert.equal(billing.billedRate(0.05, 500), 0.1);
  assert.equal(billing.billedRate(1, 3), 333.3333, '短请求噪声大——四位小数保留可判读的精度');
  assert.equal(billing.billedRate(0.136, 91), 1.4945);
});

test('billedRate：测不到的边界如实 null（不编 0）', () => {
  assert.equal(billing.billedRate(null, 1000), null);
  assert.equal(billing.billedRate(0.5, 0), null);
  assert.equal(billing.billedRate(0.5, undefined), null);
});

test('verdictOf：四态判定（unmeasured/zero/negative/ok），负值不粉饰', () => {
  assert.deepEqual(billing.verdictOf(null), { state: 'unmeasured' });
  assert.deepEqual(billing.verdictOf(0), { state: 'zero' });
  assert.deepEqual(billing.verdictOf(-0.3), { state: 'negative' });
  assert.deepEqual(billing.verdictOf(0.37), { state: 'ok' });
});
