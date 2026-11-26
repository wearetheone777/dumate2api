// test/unit/langfuse-export.test.js - A7 Langfuse 可选导出（2026-11-27）
//
// 锁三件事：默认关/配置缺失零开销；只导出白名单字段；失败吞掉不影响埋点。
const { test } = require('node:test');
const assert = require('assert');

const lf = require('../../src/langfuse-export');

const ENTRY = {
  ts: Date.parse('2026-11-27T00:00:00Z'), req_id: 'abc-1', ms: 1234, first_token_ms: 50,
  path: '/v1/chat/completions', channel: 'qwenwork', model: 'qwen/pro',
  mapped_model: 'minimax-m3.1-flash', real_model: 'minimax-m3.1-flash',
  stream: true, messages: 2, status: 200, input_tokens: 10, output_tokens: 20,
  total_tokens: 30, account: 'tester', key: 'k1', error: '',
  // 敏感字段：不能进 Langfuse
  ip: '1.2.3.4', ua: 'UA', accessToken: 'secret', keys: ['secret'],
};

test('默认关：configured() 为 false，exportEntry 是 no-op', () => {
  assert.strictEqual(lf.configured(), false);
  lf.exportEntry(ENTRY);
  assert.strictEqual(lf.meta().queued, 0);
});

test('buildEvent：只导出白名单字段，不含 token/ip/ua', () => {
  const evt = lf.buildEvent(ENTRY);
  assert.ok(evt);
  assert.ok(evt.body.includes('trace-abc-1'));
  assert.ok(evt.body.includes('minimax-m3.1-flash'));
  assert.ok(evt.body.includes('minimax-m3.1-flash'));
  for (const secret of ['1.2.3.4', 'UA', 'accessToken', 'secret']) {
    assert.ok(!evt.body.includes(secret), `导出体含敏感字段 ${secret}`);
  }
});

test('buildEvent：非千问通道默认不导出', () => {
  assert.strictEqual(lf.buildEvent({ ...ENTRY, channel: 'dumate' }), null);
});

test('buildEvent：4xx 状态写入 span level=ERROR 与 statusMessage', () => {
  const evt = lf.buildEvent({ ...ENTRY, status: 429, error: 'rate limited' });
  assert.ok(evt.body.includes('ERROR'));
  assert.ok(evt.body.includes('rate limited'));
});

test('buildEvent：4xx/未知状态都标 ERROR', () => {
  for (const status of [0, 401, 500]) {
    const evt = lf.buildEvent({ ...ENTRY, status });
    assert.ok(evt.body.includes('ERROR'), `status=${status} 未标 ERROR`);
  }
});

test('meta：暴露开关与队列长度，不暴露 URL/KEY', () => {
  const m = lf.meta();
  assert.strictEqual(typeof m.enabled, 'boolean');
  assert.strictEqual(typeof m.configured, 'boolean');
  assert.strictEqual(typeof m.queued, 'number');
  assert.ok(!JSON.stringify(m).includes('DUMATE_LANGFUSE'));
  assert.ok(typeof m.localLog === 'string');
});
