// test/unit/workbuddy-rate-ledger.test.js - 实测单价台账（M2.6）的 EMA 语义
//
// 运行：node --test test/unit/workbuddy-rate-ledger.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-wb-ledger-'));
process.env.DUMATE_ADMIN_DATA = TMP;

const ledger = require('../../src/workbuddy/rate-ledger');

test('首样本直接落为 EMA', () => {
  const row = ledger.recordRate('m1', 'cn', 0.34, { nominal: 0.34 });
  assert.strictEqual(row.ema, 0.34);
  assert.strictEqual(row.samples, 1);
  assert.strictEqual(row.min, 0.34);
  assert.strictEqual(row.max, 0.34);
  assert.strictEqual(row.nominal, 0.34);
});

test('EMA 更新：alpha=0.3，新样本主导但保留记忆', () => {
  ledger.recordRate('m2', 'cn', 0.5);
  const row = ledger.recordRate('m2', 'cn', 1.0);
  // ema = 0.3*1.0 + 0.7*0.5 = 0.65
  assert.strictEqual(row.ema, 0.65);
  assert.strictEqual(row.samples, 2);
  assert.strictEqual(row.min, 0.5);
  assert.strictEqual(row.max, 1.0);
});

test('无效样本拒绝：负数 / NaN / 缺模型名不落账', () => {
  assert.strictEqual(ledger.recordRate('', 'cn', 0.5), null);
  assert.strictEqual(ledger.recordRate('m3', 'cn', NaN), null);
  assert.strictEqual(ledger.recordRate('m3', 'cn', -1), null);
  assert.strictEqual(ledger.getRate('m3', 'cn'), null);
});

test('区域隔离：cn 与 global 是两行', () => {
  ledger.recordRate('m4', 'cn', 0.1);
  ledger.recordRate('m4', 'global', 0.9);
  assert.strictEqual(ledger.getRate('m4', 'cn').ema, 0.1);
  assert.strictEqual(ledger.getRate('m4', 'global').ema, 0.9);
});

test('workbuddy/ 前缀剥掉（调用方可能带前缀）', () => {
  const row = ledger.recordRate('workbuddy/m5', 'cn', 0.2);
  assert.strictEqual(row.model, 'm5');
  assert.ok(ledger.getRate('m5', 'cn'));
});

test('intl 别名归一成 global', () => {
  ledger.recordRate('m6', 'intl', 0.3);
  assert.strictEqual(ledger.getRate('m6', 'global').ema, 0.3);
});

test('并发写不丢行（filelock 串行化）', async () => {
  await Promise.all([
    ledger.recordRate('c1', 'cn', 0.1),
    ledger.recordRate('c2', 'cn', 0.2),
    ledger.recordRate('c3', 'cn', 0.3),
  ]);
  assert.ok(ledger.getRate('c1', 'cn'));
  assert.ok(ledger.getRate('c2', 'cn'));
  assert.ok(ledger.getRate('c3', 'cn'));
});
