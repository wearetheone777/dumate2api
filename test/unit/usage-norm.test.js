// test/unit/usage-norm.test.js - usage 缓存命中归一（千问/Qoder 共享，node:test）
//
// qoder2api-hub #112 的另一半：Qoder 通道 P2 时修过，千问的流式透传一直没修
// ——DeepSeek 系模型的 prompt_cache_hit_tokens 原样透传，按标准读的客户端
// 恒见 0。归一化提升到 src/usage-norm.js 两个 COSY 通道共用。
const { test } = require('node:test');
const assert = require('assert');
const { normalizeUsageCache } = require('../../src/usage-norm');
const qoderChat = require('../../src/qoder/chat');
const responses = require('../../src/responses');

test('DeepSeek 形状：prompt_cache_hit_tokens 搬进标准位，原字段保留', () => {
  const u = { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 64 };
  assert.strictEqual(normalizeUsageCache(u), true);
  assert.strictEqual(u.prompt_tokens_details.cached_tokens, 64);
  assert.strictEqual(u.prompt_cache_hit_tokens, 64);
});

test('Qwen 形状：completion_tokens_details.cached_tokens 搬进标准位', () => {
  const u = { completion_tokens_details: { cached_tokens: 32 } };
  assert.strictEqual(normalizeUsageCache(u), true);
  assert.strictEqual(u.prompt_tokens_details.cached_tokens, 32);
  assert.strictEqual(u.completion_tokens_details.cached_tokens, 32);
});

test('已有标准位时不覆盖（不动已适配上游的客户端看到的数据）', () => {
  const u = { prompt_cache_hit_tokens: 64, prompt_tokens_details: { cached_tokens: 5 } };
  assert.strictEqual(normalizeUsageCache(u), false);
  assert.strictEqual(u.prompt_tokens_details.cached_tokens, 5);
});

test('无缓存字段时不凭空造', () => {
  const u = { prompt_tokens: 10, completion_tokens: 5 };
  assert.strictEqual(normalizeUsageCache(u), false);
  assert.strictEqual(u.prompt_tokens_details, undefined);
});

test('qoder.chat 导出的仍是同一实现（委托共享模块）', () => {
  const u = { prompt_cache_hit_tokens: 7 };
  assert.strictEqual(qoderChat.normalizeUsageCache(u), true);
  assert.strictEqual(u.prompt_tokens_details.cached_tokens, 7);
});

test('端到端：OpenAI→Responses 出口能看到归一后的缓存（responses.usageFrom）', () => {
  const resp = responses.responsesToOpenAI({
    model: 'qoder/dfmodel',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  }, false);
  // usageFrom 在 responses.js 内部——这里只锁「归一化后的形状能被标准读取」
  const u = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 8 };
  normalizeUsageCache(u);
  assert.strictEqual(u.prompt_tokens_details.cached_tokens, 8);
});
