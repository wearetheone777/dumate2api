// test/unit/trae-error-codes.test.js - TRAE 业务码分类（2026-10-31）
//
// 只有 4001 与 HTTP 401 是本项目实测过的；其余码值的语义取自社区参照
// （Trae2api-cn / traework2api-panel / bluechonk）。判据只做保守分类。
const { test } = require('node:test');
const assert = require('node:assert');
const ue = require('../../src/upstream-errors');

test('traeCodeOf 只在 TRAE 语境里认码（不误吃别的通道）', () => {
  assert.equal(ue.traeCodeOf('traework 4001: param is invalid'), 4001);
  assert.equal(ue.traeCodeOf('qwenwork 402: quota'), null);
  assert.equal(ue.traeCodeOf('Qoder 所有账号均失败：x(403)'), null);
});

test('1005 订阅专享 → model（换模型即可用，不罚账号）', () => {
  const c = ue.classify({ status: 403, message: 'traework 1005: subscription only' });
  assert.equal(c.kind, 'model');
});

test('额度类 3003/3004/4008 → soft（换号有用，不进熔断）', () => {
  for (const code of [3003, 3004, 4008]) {
    const c = ue.classify({ status: 403, message: `traework ${code}: quota` });
    assert.equal(c.kind, 'soft', `${code} 应为 soft`);
  }
});

test('风控类 4015/4019 → soft（不进熔断）', () => {
  for (const code of [4015, 4019]) {
    const c = ue.classify({ status: 403, message: `traework ${code}: risk` });
    assert.equal(c.kind, 'soft', `${code} 应为 soft`);
  }
});

test('确定性错误（4001/4026 等）不惩罚账号', () => {
  for (const code of [1001, 4001, 4011, 4023, 4026, 10101, 20405]) {
    const c = ue.classify({ status: 400, message: `traework ${code}: bad request` });
    assert.equal(c.kind, null, `${code} 不应进池惩罚`);
  }
});

test('4026 上下文超限同时被判为确定性错误（不重发同一份字节）', () => {
  const c = ue.classify({ status: 400, message: 'traework 4026: context too long' });
  assert.equal(c.deterministic, true);
});

test('HTTP 401 仍走 session_dead（防误杀计数）', () => {
  const c = ue.classify({ status: 401, message: 'traework 401: unauthorized' });
  assert.equal(c.kind, 'session_dead');
});

test('未在表里的码交回通用判据（5xx 仍熔断）', () => {
  const c = ue.classify({ status: 503, message: 'traework 9999: whatever' });
  assert.equal(c.kind, 'breaker');
});

test('traeCodeKind 对非法输入返回 null', () => {
  for (const bad of [null, undefined, 0, -1, 'abc']) {
    assert.equal(ue.traeCodeKind(bad), null);
  }
});
