// test/unit/usage-protocol-mapping.test.js - usage 缓存字段的协议出口映射
//
// 背景（2026-10-31，P0-2）：
//   OpenAI 的 prompt_tokens **含**缓存命中；Anthropic 的 input_tokens **不含**
//   （缓存单独报 cache_read_input_tokens），Gemini 的 promptTokenCount 含、
//   另有 cachedContentTokenCount 子集。之前三个出口只搬 input/output，
//   缓存命中在 Anthropic 与 Google 两条路上直接丢了。
//
// 这里锁三件事：
//   1. cachedTokensOf 认所有上游形状（标准位 / DeepSeek / Qwen / Anthropic 位）
//   2. Anthropic 出口要**减**去缓存，并补 cache_read_input_tokens
//   3. Google 出口只补 cachedContentTokenCount，不动 promptTokenCount
const { test } = require('node:test');
const assert = require('assert');
const { cachedTokensOf } = require('../../src/usage-norm');
const anthropic = require('../../src/anthropic');
const google = require('../../src/google');

test('cachedTokensOf：标准位', () => {
  assert.strictEqual(cachedTokensOf({ prompt_tokens_details: { cached_tokens: 256 } }), 256);
});

test('cachedTokensOf：DeepSeek 的 prompt_cache_hit_tokens', () => {
  assert.strictEqual(cachedTokensOf({ prompt_cache_hit_tokens: 128 }), 128);
});

test('cachedTokensOf：Qwen 的 completion_tokens_details.cached_tokens', () => {
  assert.strictEqual(cachedTokensOf({ completion_tokens_details: { cached_tokens: 64 } }), 64);
});

test('cachedTokensOf：Anthropic 自己的 cache_read_input_tokens', () => {
  assert.strictEqual(cachedTokensOf({ cache_read_input_tokens: 32 }), 32);
});

test('cachedTokensOf：没有缓存字段返回 0（不凭空造）', () => {
  assert.strictEqual(cachedTokensOf({ prompt_tokens: 10 }), 0);
  assert.strictEqual(cachedTokensOf(null), 0);
  assert.strictEqual(cachedTokensOf({ prompt_tokens_details: { cached_tokens: 0 } }), 0);
});

test('Anthropic 出口：input_tokens 减去缓存，缓存单独报', () => {
  const resp = anthropic.openAIToAnthropic({
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020,
      prompt_tokens_details: { cached_tokens: 400 } },
  }, 'glm-5');
  assert.strictEqual(resp.usage.input_tokens, 600);
  assert.strictEqual(resp.usage.cache_read_input_tokens, 400);
  assert.strictEqual(resp.usage.cache_creation_input_tokens, 0);
  assert.strictEqual(resp.usage.output_tokens, 20);
});

test('Anthropic 出口：上游没报缓存时等于原值', () => {
  const resp = anthropic.openAIToAnthropic({
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 5 },
  }, 'm');
  assert.strictEqual(resp.usage.input_tokens, 100);
  assert.strictEqual(resp.usage.cache_read_input_tokens, 0);
});

test('Anthropic 出口：缓存数大于 prompt 时钳到 0，不出现负数', () => {
  const resp = anthropic.openAIToAnthropic({
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 99 },
  }, 'm');
  assert.strictEqual(resp.usage.input_tokens, 0);
  assert.strictEqual(resp.usage.cache_read_input_tokens, 10);
});

test('Google 出口：补 cachedContentTokenCount，promptTokenCount 不变', () => {
  const resp = google.openAIToGoogle({
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1000, completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 400 } },
  }, 'glm-5');
  assert.strictEqual(resp.usageMetadata.promptTokenCount, 1000);
  assert.strictEqual(resp.usageMetadata.cachedContentTokenCount, 400);
});

test('Google 出口：没有缓存时不造字段', () => {
  const resp = google.openAIToGoogle({
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 5 },
  }, 'm');
  assert.ok(!('cachedContentTokenCount' in resp.usageMetadata));
});
