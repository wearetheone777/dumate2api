// test/unit/qwen-quota-429.test.js - 千问额度/模型错误转 429（2026-11-27 融合 P2-2）
//
// 锁 src/qwenwork/index.js 的 isQuotaOrModel：认 402（积分耗尽）与
// 403+模型不可用文案。这两类错误在「一个内容块都没发出」时，send() 会
// 回 429（可重试语义）而不是 402/403（客户端按硬失败处理、不退避）。
const { test } = require('node:test');
const assert = require('assert');

const { isQuotaOrModel } = require('../../src/qwenwork/index');

test('402（积分耗尽）→ 是额度类', () => {
  assert.strictEqual(isQuotaOrModel(402, 'Error in upstream response'), true);
  assert.strictEqual(isQuotaOrModel(402, '余额不足'), true);
});

test('403 + 模型不可用文案 → 是模型类', () => {
  assert.strictEqual(isQuotaOrModel(403, 'Model is not available for this user'), true);
  assert.strictEqual(isQuotaOrModel(403, 'model not available'), true);
  assert.strictEqual(isQuotaOrModel(403, '无权限访问'), true);
  assert.strictEqual(isQuotaOrModel(403, '该模型不存在'), true);
});

test('403 + 其它文案（签名/权限类）→ 不是模型类', () => {
  assert.strictEqual(isQuotaOrModel(403, 'Signature invalid'), false);
  assert.strictEqual(isQuotaOrModel(403, 'Forbidden'), false);
});

test('401 / 429 / 5xx / 网络 → 不是额度/模型类（各有自己的处置）', () => {
  assert.strictEqual(isQuotaOrModel(401, 'unauthorized'), false);
  assert.strictEqual(isQuotaOrModel(429, 'rate limited'), false);
  assert.strictEqual(isQuotaOrModel(500, 'internal error'), false);
  assert.strictEqual(isQuotaOrModel(502, 'bad gateway'), false);
  assert.strictEqual(isQuotaOrModel(0, 'connection refused'), false);
});

test('非数字 code → 不是额度/模型类', () => {
  assert.strictEqual(isQuotaOrModel('-', 'some error'), false);
  assert.strictEqual(isQuotaOrModel(undefined, 'some error'), false);
});

test('message 为空时不误判 403', () => {
  assert.strictEqual(isQuotaOrModel(403, ''), false);
  assert.strictEqual(isQuotaOrModel(403, null), false);
});
