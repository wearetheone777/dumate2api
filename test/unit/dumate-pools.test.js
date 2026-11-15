// test/unit/dumate-pools.test.js - 积分钱包分池的纯函数验证（node:test）
//
// 2026-11-15 融合 P0-3（数据面）。锁三件事：
//   ① 三桶互不合并（dumate / unspecified / others）——把 unspecified 当 dumate
//      正是社区那次「余额虚报」的成因，反过来把 comate 算进搭子也是；
//   ② 只有 active（或上游没给 status）的包算可花费，inactive 的未来期不进；
//   ③ 空输入 / 畸形输入不抛，全零而不是 NaN。
const { test } = require('node:test');
const assert = require('assert');
const { splitPools } = require('../../src/dumate-web');

const pack = (o) => Object.assign({ total: 0, used: 0, status: '', product: '' }, o);

test('三桶分开：dumate / unspecified / others 不合并', () => {
  const p = splitPools([
    pack({ total: 100, used: 10, product: 'dumate', status: 'active' }),
    pack({ total: 50, used: 5 }),                                  // 上游没给 product
    pack({ total: 5000, used: 0, product: 'comate', status: 'active' }),
  ]);
  assert.strictEqual(p.dumate.total, 100);
  assert.strictEqual(p.unspecified.total, 50);
  assert.strictEqual(p.others.length, 1);
  assert.strictEqual(p.others[0].product, 'comate');
  assert.strictEqual(p.others[0].total, 5000);
  // 三桶合计 = 5150，但没有任何一桶是 5150
  assert.strictEqual(p.dumate.total + p.unspecified.total + p.others[0].total, 5150);
});

test('同一产品的多个包合并成一行', () => {
  const p = splitPools([
    pack({ total: 10, used: 1, product: 'comate', status: 'active' }),
    pack({ total: 20, used: 2, product: 'comate', status: 'active' }),
  ]);
  assert.strictEqual(p.others.length, 1);
  assert.strictEqual(p.others[0].total, 30);
  assert.strictEqual(p.others[0].used, 3);
  assert.strictEqual(p.others[0].packs, 2);
});

test('只有 active（或无 status）的包算可花费，inactive 不进 active 桶', () => {
  const p = splitPools([
    pack({ total: 100, used: 0, product: 'dumate', status: 'active' }),
    pack({ total: 900, used: 0, product: 'dumate', status: 'inactive' }), // 排队的未来期
    pack({ total: 50, used: 0 }),                                        // 没 status → 算可花费
  ]);
  assert.strictEqual(p.active.total, 150, 'inactive 的 900 不能进可花费');
  // 但分桶汇总仍如实包含（这是「账上有多少」，不是「现在能花多少」）
  assert.strictEqual(p.dumate.total, 1000);
  assert.strictEqual(p.unspecified.total, 50);
});

test('空输入 / 非数组：不抛，桶为空（0 是真实值）', () => {
  for (const input of [[], null, undefined, 'x']) {
    const p = splitPools(input);
    assert.strictEqual(p.dumate.total, 0);
    assert.strictEqual(p.unspecified.total, 0);
    assert.strictEqual(p.others.length, 0);
    assert.strictEqual(p.dumate.partial, false);
    assert.ok(Number.isFinite(p.active.total));
  }
});

test('余额缺失/非数值 → null + partial，不改写成 0（余额 null ≠ 0）', () => {
  const p = splitPools([{}, { total: NaN }]);   // 没给 product → unspecified 桶
  assert.strictEqual(p.unspecified.total, null, '全未知时不能报 0');
  assert.strictEqual(p.unspecified.used, null);
  assert.strictEqual(p.unspecified.left, null);
  assert.strictEqual(p.unspecified.packs, 2);
  assert.strictEqual(p.unspecified.packsUnknown, 2);
  assert.strictEqual(p.unspecified.partial, true);
  assert.strictEqual(p.active.partial, true);
  assert.strictEqual(p.active.total, null);
});

test('部分包缺数字：合计是已知部分和，left 如实 null', () => {
  const p = splitPools([
    pack({ total: 100, used: 10, product: 'dumate' }),
    { product: 'dumate' },                       // 缺 total/used
    pack({ total: 50, used: null, product: 'dumate' }),
  ]);
  assert.strictEqual(p.dumate.total, 100, '只累已知值');
  assert.strictEqual(p.dumate.used, 10);
  assert.strictEqual(p.dumate.left, null, '有一个未知就不给「精确余额」');
  assert.strictEqual(p.dumate.partial, true);
  assert.strictEqual(p.dumate.packs, 3);
  assert.strictEqual(p.dumate.packsUnknown, 2);
});

test('note 如实说明口径（有 others 时点明不可用于搭子；只有 unspecified 时点明不是专属额度）', () => {
  assert.match(splitPools([pack({ total: 1, product: 'comate' })]).note, /其他产品/);
  assert.match(splitPools([pack({ total: 1 })]).note, /unspecified/);
  assert.strictEqual(splitPools([pack({ total: 1, product: 'dumate' })]).note, '');
});

test('left 不为负（used 超过 total 的坏读）', () => {
  const p = splitPools([pack({ total: 10, used: 99, product: 'dumate' })]);
  assert.strictEqual(p.dumate.left, 0);
  assert.strictEqual(p.active.left, 0);
});
