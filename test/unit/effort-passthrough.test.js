// test/unit/effort-passthrough.test.js - 思考强度经翻译层的透传（node:test）
//
// Claude Code（Anthropic 入口）与 Codex（Responses 入口）的思考强度此前在
// 翻译层被丢弃——用户调 model_reasoning_effort 完全无效且无感。2026-10-30
// 起透传为 reasoning_effort，直连通道（Qoder）按模型合法档归一化后下发。
// 映射口径对齐 qoder2api-hub：budget_tokens 区间、output_config.effort 优先。
const { test } = require('node:test');
const assert = require('assert');
const anthropic = require('../../src/anthropic');
const responses = require('../../src/responses');

test('anthropic: output_config.effort（Claude Code adaptive 形态）透传', () => {
  const out = anthropic.anthropicToOpenAI({
    model: 'qoder/dfmodel', max_tokens: 1024,
    thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.strictEqual(out.reasoning_effort, 'high');
});

test('anthropic: thinking.effort 透传', () => {
  const out = anthropic.anthropicToOpenAI({
    model: 'qoder/dfmodel', max_tokens: 1024,
    thinking: { type: 'enabled', effort: 'low' },
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.strictEqual(out.reasoning_effort, 'low');
});

test('anthropic: budget_tokens 区间映射（对齐 hub：≤1024 minimal / ≤4096 low / ≤16384 medium / ≤32768 high / 更大 max）', () => {
  const mk = (n) => anthropic.anthropicToOpenAI({
    model: 'qoder/dfmodel', max_tokens: 1024,
    thinking: { type: 'enabled', budget_tokens: n },
    messages: [{ role: 'user', content: 'hi' }],
  }).reasoning_effort;
  assert.strictEqual(mk(512), 'minimal');
  assert.strictEqual(mk(1024), 'minimal');
  assert.strictEqual(mk(4096), 'low');
  assert.strictEqual(mk(16384), 'medium');
  assert.strictEqual(mk(32768), 'high');
  assert.strictEqual(mk(65536), 'max');
});

test('anthropic: thinking.type=disabled 不下发（上游按模型默认处理）', () => {
  const out = anthropic.anthropicToOpenAI({
    model: 'qoder/dfmodel', max_tokens: 1024,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.strictEqual(out.reasoning_effort, undefined);
});

test('anthropic: 没有任何思考配置时不编字段', () => {
  const out = anthropic.anthropicToOpenAI({
    model: 'qoder/dfmodel', max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.strictEqual(out.reasoning_effort, undefined);
});

test('responses: Codex 顶层 reasoning.effort 透传', () => {
  const out = responses.responsesToOpenAI({
    model: 'qoder/dfmodel',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    reasoning: { effort: 'high', summary: 'auto' },
  }, false);
  assert.strictEqual(out.reasoning_effort, 'high');
});

test('responses: 没带 reasoning 时不编字段', () => {
  const out = responses.responsesToOpenAI({
    model: 'qoder/dfmodel',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  }, false);
  assert.strictEqual(out.reasoning_effort, undefined);
});
