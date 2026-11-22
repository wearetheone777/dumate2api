// test/unit/qoder-expiry-distribution.test.js - 积分到期分布（P2-18）
//
// 调研出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P2-18「积分构成 / 到期分布页」。
//
// 为什么要聚合而不只列明细：30 天有效期 + 每天领 100 的话，每天都有一笔在到期，
// 明细里是一堆相同的行；聚合后才看得出「明天一口气作废 300」这种真风险。
//
// 五条口径：
//   1. 按**自然日**聚合（同日多账号多批次合成一行）
//   2. `remaining` 用**推算剩余**（先领先扣），不是领取额——后者会高估
//   3. `dailyNeed` = 推算剩余 ÷ 剩余天数（今天到期按 1 天算，避免除零）
//   4. 已过期批次不进分布（已作废，不持有余额）
//   5. `estimatedRemaining == null` 不参与合计（推不出来 ≠ 0）
//
// 运行：node --test test/unit/qoder-expiry-distribution.test.js
const test = require('node:test');
const assert = require('node:assert');

const grants = require('../../src/qoder/grants');

const NOW = new Date(2026, 10, 8, 15, 0, 0, 0).getTime(); // 2026-11-08 15:00 本地
const DAY = 86400000;
const at = (daysFromNow) => NOW + daysFromNow * DAY;

test('按自然日聚合：同日多账号多批次合成一行，账号去重', () => {
  const dist = grants.expiryDistribution([
    { grantId: 'a', accountId: 1, amount: 100, expiresAt: at(2), estimatedRemaining: 100 },
    { grantId: 'b', accountId: 2, amount: 100, expiresAt: at(2), estimatedRemaining: 50 },
    { grantId: 'c', accountId: 1, amount: 100, expiresAt: at(2), estimatedRemaining: 0 },
  ], NOW);
  assert.strictEqual(dist.length, 1);
  const row = dist[0];
  assert.strictEqual(row.grantCount, 3);
  assert.strictEqual(row.amounts, 300, '领取额合计（对照口径）');
  assert.strictEqual(row.remaining, 150, '**推算剩余**合计，不是领取额');
  assert.deepStrictEqual(row.accounts.sort(), [1, 2]);
  assert.strictEqual(row.accountCount, 2);
});

test('dailyNeed = 推算剩余 ÷ 剩余天数（今天到期按 1 天，不除零）', () => {
  const dist = grants.expiryDistribution([
    { grantId: 'a', accountId: 1, amount: 100, expiresAt: at(2), estimatedRemaining: 100 },
  ], NOW);
  assert.strictEqual(dist[0].daysLeft, 2);
  assert.strictEqual(dist[0].dailyNeed, 50, '100 ÷ 2 天');

  // 今天到期（同日不同时刻）：daysLeft 是自然日差 0，dailyNeed 用 1 天兜底
  const today = grants.expiryDistribution([
    { grantId: 'b', accountId: 1, amount: 100, expiresAt: at(0) + 3 * 3600000, estimatedRemaining: 100 },
  ], NOW);
  assert.strictEqual(today[0].daysLeft, 0, '自然日差为 0');
  assert.strictEqual(today[0].dailyNeed, 100, '按 1 天算，不除零');
  assert.strictEqual(today[0].warn, 'critical');
});

test('已过期批次不进分布（已作废，不持有余额）', () => {
  const dist = grants.expiryDistribution([
    { grantId: 'gone', accountId: 1, amount: 100, expiresAt: at(-1), estimatedRemaining: 100 },
    { grantId: 'live', accountId: 1, amount: 100, expiresAt: at(5), estimatedRemaining: 80 },
  ], NOW);
  assert.strictEqual(dist.length, 1);
  assert.strictEqual(dist[0].remaining, 80, '过期的那批不该被算进来');
});

test('estimatedRemaining=null 不参与合计（推不出来 ≠ 0）', () => {
  const dist = grants.expiryDistribution([
    { grantId: 'a', accountId: 1, amount: 100, expiresAt: at(3), estimatedRemaining: 60 },
    { grantId: 'b', accountId: 2, amount: 100, expiresAt: at(3), estimatedRemaining: null },
  ], NOW);
  assert.strictEqual(dist[0].remaining, 60, '只有能推出来的那批参与');
  assert.strictEqual(dist[0].amounts, 200, '领取额仍如实合计');
});

test('危险度分级：≤1 天 critical / ≤3 天 high / ≤7 天 watch / 其余无标记', () => {
  // d=0 用「今天稍晚」而不是 NOW 本身——expiresAt === now 属于已过期边界，
  // 会被分布过滤掉（那条边界另有专门断言）
  const mk = (d) => grants.expiryDistribution([
    { grantId: `g${d}`, accountId: 1, amount: 10, expiresAt: d === 0 ? at(0) + 3600000 : at(d), estimatedRemaining: 10 },
  ], NOW)[0].warn;
  assert.strictEqual(mk(0), 'critical');
  assert.strictEqual(mk(1), 'critical');
  assert.strictEqual(mk(2), 'high');
  assert.strictEqual(mk(3), 'high');
  assert.strictEqual(mk(5), 'watch');
  assert.strictEqual(mk(7), 'watch');
  assert.strictEqual(mk(10), '');
});

test('余额为 0 的批次不报警（已用完的批次不用提醒）', () => {
  const dist = grants.expiryDistribution([
    { grantId: 'a', accountId: 1, amount: 100, expiresAt: at(1), estimatedRemaining: 0 },
  ], NOW);
  assert.strictEqual(dist[0].warn, '', '余额 0 已经没什么可作废了');
});

test('结果按日期升序（最早的排前面）', () => {
  const dist = grants.expiryDistribution([
    { grantId: 'c', accountId: 1, amount: 1, expiresAt: at(20), estimatedRemaining: 1 },
    { grantId: 'a', accountId: 1, amount: 1, expiresAt: at(2), estimatedRemaining: 1 },
    { grantId: 'b', accountId: 1, amount: 1, expiresAt: at(9), estimatedRemaining: 1 },
  ], NOW);
  assert.deepStrictEqual(dist.map((x) => x.daysLeft), [2, 9, 20]);
});

test('空入参与脏入参不抛', () => {
  assert.deepStrictEqual(grants.expiryDistribution([], NOW), []);
  assert.deepStrictEqual(grants.expiryDistribution(null, NOW), []);
  const dist = grants.expiryDistribution([null, { grantId: 'x' }, { expiresAt: at(3) }], NOW);
  assert.strictEqual(dist.length, 1, '缺 grantId 但带 expiresAt 的仍可聚合（按日期分组）');
});
