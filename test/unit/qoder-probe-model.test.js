// test/unit/qoder-probe-model.test.js - billing-check 默认模型挑选（hub v1.7.20 #134）
//
// 真 0 价（price_factor==0）优先；is_free 只表示「含免费权益」不作首选；
// 没有 0 价挑最小正倍率；空表/无 rate 如实 null（调用方要求显式传 model）。
// 运行：node --test test/unit/qoder-probe-model.test.js
const assert = require('assert');
const { test } = require('node:test');
const { pickProbeModel } = require('../../src/qoder/probe-model');

test('真 0 价优先（price_factor==0），不管它在表里的位置', () => {
  const rows = [
    { key: 'kmodel_latest', rate: 1.4 },
    { key: 'qfmodel', rate: 0 },
    { key: 'pro', rate: 1 },
  ];
  assert.deepStrictEqual(pickProbeModel(rows), { key: 'qfmodel', rate: 0, reason: 'price_factor==0（真 0 价）' });
});

test('没有 0 价时挑最小正倍率', () => {
  const rows = [
    { key: 'kmodel_latest', rate: 1.4 },
    { key: 'pro', rate: 1 },
    { key: 'dfmodel', rate: 0.1 },
  ];
  const r = pickProbeModel(rows);
  assert.strictEqual(r.key, 'dfmodel');
  assert.strictEqual(r.rate, 0.1);
  assert.strictEqual(r.reason, '标称倍率最低');
});

test('rate 缺失/null 的行不参与；错峰负值不入选', () => {
  const rows = [
    { key: 'a' },                      // 无 rate
    { key: 'b', rate: null },
    { key: 'c', rate: -1 },            // 负倍率不是合法候选
    { key: 'd', rate: 0.2 },
  ];
  const r = pickProbeModel(rows);
  assert.strictEqual(r.key, 'd');
});

test('空表 / 全部无效 → null（调用方要求显式传 model，不猜）', () => {
  assert.strictEqual(pickProbeModel([]), null);
  assert.strictEqual(pickProbeModel(null), null);
  assert.strictEqual(pickProbeModel(undefined), null);
  assert.strictEqual(pickProbeModel([{ key: 'a' }, { key: 'b', rate: null }]), null);
  assert.strictEqual(pickProbeModel('bad'), null);
});
