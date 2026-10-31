// test/unit/qianfan-raw.test.js - 千帆原生透传前缀与请求体
//
// 这个命名空间存在的唯一理由是 response_format（应用链路回 400）。
// 锁两件事：路由把它归到搭子（同一份凭证/额度）但走 provider；请求体去前缀、
// 按流式开关补 stream_options。
const { test } = require('node:test');
const assert = require('assert');
const router = require('../../src/upstream-router');
const qianfan = require('../../src/qianfan-raw');

test('qianfan/ 前缀：归属搭子，但走 provider（direct）', () => {
  const r = router.resolve('qianfan/qwen3.5-35b-a3b');
  assert.strictEqual(r.channel, 'dumate');
  assert.strictEqual(r.model, 'qwen3.5-35b-a3b');
  assert.strictEqual(r.rawQianfan, true);
  assert.strictEqual(r.target.direct, true);
  assert.strictEqual(r.target.provider, './qianfan-raw');
  assert.strictEqual(r.target.needsModelMap, false);
  // 不做预算钳制：透传语义就是「调用方给什么发什么」
  assert.strictEqual(r.target.needsBudget, false);
});

test('未知前缀仍然报错（不静默回落）', () => {
  const r = router.resolve('nope/whatever');
  assert.ok(r.error && r.error.startsWith('unknown_channel'));
});

test('无前缀仍归搭子（既有客户端零改动）', () => {
  const r = router.resolve('glm-5');
  assert.strictEqual(r.channel, 'dumate');
  assert.strictEqual(r.target.direct, false);
});

test('buildRequest：去 qianfan/ 前缀', () => {
  const b = qianfan.buildRequest({ model: 'qianfan/qwen3.5-35b-a3b', messages: [] }, false);
  assert.strictEqual(b.model, 'qwen3.5-35b-a3b');
  assert.strictEqual(b.stream, false);
  assert.strictEqual(b.stream_options, undefined);
});

test('buildRequest：流式补 include_usage', () => {
  const b = qianfan.buildRequest({ model: 'x', messages: [], stream: false }, true);
  assert.strictEqual(b.stream, true);
  assert.deepStrictEqual(b.stream_options, { include_usage: true });
});

test('buildRequest：非流式保留 response_format', () => {
  const b = qianfan.buildRequest({
    model: 'x', messages: [], response_format: { type: 'json_object' }, stream: true,
  }, false);
  assert.deepStrictEqual(b.response_format, { type: 'json_object' });
  assert.strictEqual(b.stream_options, undefined);
});

test('listModels 非空且带已知模型', () => {
  assert.ok(qianfan.listModels().includes('qwen3.5-35b-a3b'));
});
