// test/unit/qwen-model-capabilities.test.js - 千问模型能力位解析（2026-11-27 融合 G3）
//
// 锁 src/qwenwork/index.js 的 normalizeModelRow 能力位字段 + resolveProtocol。
// 能力位是管理端能力覆盖层（A1）与 MaaS 链路协议路由（G1）的地基：
// provider/protocol 决定协议端点，modalities/reasoning/tool_call 给覆盖层作默认值。
const { test } = require('node:test');
const assert = require('assert');

const { normalizeModelRow, parseModelsResponse, resolveProtocol } = require('../../src/qwenwork/index');

test('normalizeModelRow：基础字段（key/name/rate/contextWindow）保持兼容', () => {
  const row = normalizeModelRow({
    key: 'pro',
    display_name: '高级',
    price_factor: 1.5,
    context_config: { a: { token_count: 262144 }, b: { tokens: 131072 } },
    is_vl: false,
    enable: true,
  });
  assert.strictEqual(row.key, 'pro');
  assert.strictEqual(row.name, '高级');
  assert.strictEqual(row.rate, 1.5);
  assert.strictEqual(row.contextWindow, 262144);
  assert.strictEqual(row.multimodal, false);
  assert.strictEqual(row.enabled, true);
  assert.strictEqual(row.free, false);
});

test('normalizeModelRow：能力位 provider/protocol/maxOutputTokens', () => {
  const row = normalizeModelRow({
    key: 'minimax-m3.1-flash',
    provider: 'anthropic',
    protocol: 'messages',
    max_output_tokens: 8192,
    is_vl: true,
  });
  assert.strictEqual(row.provider, 'anthropic');
  assert.strictEqual(row.protocol, 'messages');
  assert.strictEqual(row.maxOutputTokens, 8192);
});

test('normalizeModelRow：modalities 从 is_vl 推导', () => {
  const vl = normalizeModelRow({ key: 'x', is_vl: true });
  assert.deepStrictEqual(vl.modalities, ['text', 'image']);
  const txt = normalizeModelRow({ key: 'y', is_vl: false });
  assert.deepStrictEqual(txt.modalities, ['text']);
});

test('normalizeModelRow：reasoning/tool_call 识别', () => {
  assert.strictEqual(normalizeModelRow({ key: 'a', is_reasoning: true }).reasoning, true);
  assert.strictEqual(normalizeModelRow({ key: 'b', reasoning: true }).reasoning, true);
  assert.strictEqual(normalizeModelRow({ key: 'c' }).reasoning, false);
  assert.strictEqual(normalizeModelRow({ key: 'd', tool_call: true }).toolCall, true);
  assert.strictEqual(normalizeModelRow({ key: 'e', support_tool: true }).toolCall, true);
  // 上游无 tool_call 字段：null（未知），不是 false——四个协议入口都支持工具调用
  assert.strictEqual(normalizeModelRow({ key: 'f' }).toolCall, null);
});

test('resolveProtocol：显式 protocol 优先', () => {
  assert.strictEqual(resolveProtocol('anthropic', 'custom'), 'custom');
});

test('resolveProtocol：按 provider 查映射表', () => {
  assert.strictEqual(resolveProtocol('anthropic'), 'messages');
  assert.strictEqual(resolveProtocol('openai'), 'responses');
});

test('resolveProtocol：未知 provider 兜底 chat', () => {
  assert.strictEqual(resolveProtocol('', undefined), 'chat');
  assert.strictEqual(resolveProtocol('unknown', undefined), 'chat');
  assert.strictEqual(resolveProtocol(undefined, undefined), 'chat');
});

test('normalizeModelRow：minimax3.1flash 标为免费档（测试纪律）', () => {
  const row = normalizeModelRow({ key: 'minimax-m3.1-flash', display_name: 'MiniMax-M3.1-flash' });
  assert.strictEqual(row.free, true);
});

test('normalizeModelRow：上游不返能力位时给中性默认，不抛', () => {
  const row = normalizeModelRow({ key: 'pro' });
  assert.strictEqual(row.provider, '');
  assert.strictEqual(row.protocol, 'chat');
  assert.strictEqual(row.maxOutputTokens, null);
  assert.deepStrictEqual(row.modalities, ['text']);
  assert.strictEqual(row.reasoning, false);
  assert.strictEqual(row.toolCall, null);
});

test('normalizeModelRow：非法输入返回 null', () => {
  assert.strictEqual(normalizeModelRow(null), null);
  assert.strictEqual(normalizeModelRow(undefined), null);
  assert.strictEqual(normalizeModelRow('not-object'), null);
  assert.strictEqual(normalizeModelRow({}), null); // 没有 key
});

test('parseModelsResponse：过滤 enable=false，能力位透传', () => {
  const rows = parseModelsResponse({
    qwork: [
      { key: 'a', provider: 'openai', is_vl: true },
      { key: 'b', enable: false },
    ],
  });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].key, 'a');
  assert.strictEqual(rows[0].protocol, 'responses');
});
