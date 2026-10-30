// test/unit/responses-usage.test.js - Responses 出口的 usage 归一（node:test）
//
// 背景（2026-10-30 融自 qoder-trae-workbuddy-switch 的 build_responses_usage）：
// usageFrom 曾把 input_tokens_details.cached_tokens 硬编码为 0——Qoder 通道的
// normalizeUsageCache 归一好的缓存命中在 Responses 出口又丢了，Codex 的
// /status 永远显示缓存 0。现在多形状回退取值。
const { test } = require('node:test');
const assert = require('assert');
const responses = require('../../src/responses');

// usageFrom 不在导出列表里，走 openAIToResponse 的输出验证
function usageOf(openaiResp) {
  const resp = responses.openAIToResponse(openaiResp, 'glm-5');
  return resp.usage;
}

test('标准形状：prompt_tokens_details.cached_tokens 透传', () => {
  const u = usageOf({
    id: 'chatcmpl-x', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 64 }, completion_tokens_details: { reasoning_tokens: 8 } },
  });
  assert.strictEqual(u.input_tokens, 100);
  assert.strictEqual(u.input_tokens_details.cached_tokens, 64);
  assert.strictEqual(u.output_tokens_details.reasoning_tokens, 8);
  assert.strictEqual(u.total_tokens, 120);
});

test('DeepSeek 形状：prompt_cache_hit_tokens 回退取到', () => {
  const u = usageOf({
    id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 77 },
  });
  assert.strictEqual(u.input_tokens_details.cached_tokens, 77);
});

test('缺失/为 0 时如实给 0，不编', () => {
  const u = usageOf({
    id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });
  assert.strictEqual(u.input_tokens_details.cached_tokens, 0);
  assert.strictEqual(u.output_tokens_details.reasoning_tokens, 0);
});

test('上游没给 usage 时给 0 值结构（不炸）', () => {
  const u = usageOf({
    id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  });
  assert.strictEqual(u.input_tokens, 0);
  assert.strictEqual(u.input_tokens_details.cached_tokens, 0);
});
