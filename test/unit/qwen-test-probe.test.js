// test/unit/qwen-test-probe.test.js - 千问测试探针分档判定（2026-11-27 融合 A2）
//
// 锁 src/qwenwork/test-probe.js 的 classifyTestResult：状态码 + 是否有内容 → 判定档。
// 社区七档 + 本项目两档细分（server / forbidden）。
const { test } = require('node:test');
const assert = require('assert');

const { classifyTestResult, TIERS } = require('../../src/qwenwork/test-probe');

test('200 + 有内容 → 可用', () => {
  assert.deepStrictEqual(classifyTestResult(200, '', true), { tier: 'available', label: '可用' });
});

test('200 + 无内容 → 无输出', () => {
  assert.deepStrictEqual(classifyTestResult(200, '', false), { tier: 'no_output', label: '无输出' });
});

test('401 → 登录失效', () => {
  assert.strictEqual(classifyTestResult(401, 'unauthorized', false).tier, 'auth_failed');
});

test('402 → 积分不足', () => {
  assert.strictEqual(classifyTestResult(402, 'quota exhausted', false).tier, 'quota');
});

test('429 → 被限流', () => {
  assert.strictEqual(classifyTestResult(429, 'rate limited', false).tier, 'rate_limited');
});

test('403 + 模型不可用文案 → 不支持', () => {
  assert.strictEqual(classifyTestResult(403, 'Model is not available for this user', false).tier, 'unsupported');
  assert.strictEqual(classifyTestResult(403, '该模型不存在', false).tier, 'unsupported');
});

test('403 + 签名/权限类 → 无权限/签名', () => {
  assert.strictEqual(classifyTestResult(403, 'Signature invalid', false).tier, 'forbidden');
  assert.strictEqual(classifyTestResult(403, 'Forbidden', false).tier, 'forbidden');
});

test('0 / 网络错误文案 → 超时网络失败', () => {
  assert.strictEqual(classifyTestResult(0, 'connect ECONNREFUSED', false).tier, 'network');
  assert.strictEqual(classifyTestResult(500, 'ETIMEDOUT', false).tier, 'network');
});

test('5xx → 上游错误', () => {
  assert.strictEqual(classifyTestResult(500, 'internal error', false).tier, 'server');
  assert.strictEqual(classifyTestResult(502, 'bad gateway', false).tier, 'server');
});

test('未知状态 → 未知', () => {
  assert.strictEqual(classifyTestResult(418, 'teapot', false).tier, 'unknown');
});

test('TIERS 表涵盖所有档位', () => {
  for (const t of ['available', 'no_output', 'unsupported', 'auth_failed', 'quota', 'rate_limited', 'network', 'server', 'forbidden', 'unknown']) {
    assert.ok(TIERS[t], `TIERS.${t} 应有中文标签`);
  }
});
