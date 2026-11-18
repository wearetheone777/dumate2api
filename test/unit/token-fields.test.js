// test/unit/token-fields.test.js - 客户端 token 字段归一（max_completion_tokens → max_tokens）
//
// 背景（2026-11-13 真机实测，个人版网页凭证通道）：
//   上游 dumate-svc /gateway/apis/v1 只认 max_tokens。
//   - 两个都发：HTTP 400
//     `setting 'max_tokens' and 'max_completion_tokens' at the same time is not supported`
//     客户端侧表现为整轮失败（ZCode：provider_code=invalid_request, retryable=false）
//   - 只发 max_completion_tokens：不报错，但预算字段被丢弃，退回 DEFAULT_BUDGET
//   normalizeTokenFields 把两条都收敛成「只有一个 max_tokens」。
const { test } = require('node:test');
const assert = require('assert');

const budget = require('../../src/budget');
const { normalizeTokenFields, resolveMaxTokens, FLOOR } = budget;

test('只发 max_tokens：原样保留，不改写', () => {
  const body = { model: 'model-text', max_tokens: 8192 };
  assert.strictEqual(normalizeTokenFields(body), false, '无 max_completion_tokens 时不该改写');
  assert.strictEqual(body.max_tokens, 8192);
  assert.strictEqual(body.max_completion_tokens, undefined);
});

test('只发 max_completion_tokens：映射成 max_tokens 并删除原字段', () => {
  const body = { model: 'model-text', max_completion_tokens: 8192 };
  assert.strictEqual(normalizeTokenFields(body), true);
  assert.strictEqual(body.max_tokens, 8192, '预算字段不能再被丢弃');
  assert.strictEqual('max_completion_tokens' in body, false, '上游看不得这个键');
});

test('两个都发且相等：只留 max_tokens（复现 400 的那条）', () => {
  const body = { model: 'deepseek-v41-flash', max_tokens: 1000, max_completion_tokens: 1000 };
  assert.strictEqual(normalizeTokenFields(body), true);
  assert.strictEqual(body.max_tokens, 1000);
  assert.strictEqual('max_completion_tokens' in body, false);
});

test('两个都发且值不同：取较大者，不把用户要的长度砍短', () => {
  const a = { max_tokens: 1000, max_completion_tokens: 4096 };
  normalizeTokenFields(a);
  assert.strictEqual(a.max_tokens, 4096);

  const b = { max_tokens: 4096, max_completion_tokens: 1000 };
  normalizeTokenFields(b);
  assert.strictEqual(b.max_tokens, 4096);
});

test('max_completion_tokens 非法值：删掉键，不动已有的 max_tokens', () => {
  const body = { max_tokens: 2048, max_completion_tokens: 'abc' };
  assert.strictEqual(normalizeTokenFields(body), true);
  assert.strictEqual(body.max_tokens, 2048);
  assert.strictEqual('max_completion_tokens' in body, false);

  const only = { max_completion_tokens: 'abc' };
  normalizeTokenFields(only);
  assert.strictEqual('max_tokens' in only, false, '非法值不得凭空写出 max_tokens');
});

test('其它字段一律不动（tools / stream / temperature）', () => {
  const body = {
    model: 'model-text',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'f' } }],
    tool_choice: 'auto',
    stream: true,
    temperature: 0.6,
    max_completion_tokens: 512,
  };
  normalizeTokenFields(body);
  assert.strictEqual(body.tools.length, 1);
  assert.strictEqual(body.tool_choice, 'auto');
  assert.strictEqual(body.stream, true);
  assert.strictEqual(body.temperature, 0.6);
  assert.strictEqual(body.max_tokens, 512);
});

test('空入参 / 非对象：不抛，返回 false', () => {
  assert.strictEqual(normalizeTokenFields(null), false);
  assert.strictEqual(normalizeTokenFields(undefined), false);
  assert.strictEqual(normalizeTokenFields('{}'), false);
  assert.strictEqual(normalizeTokenFields({}), false);
});

test('归一后仍走 FLOOR 钳制：小值不会被当默认值吞掉', () => {
  const body = { max_completion_tokens: 1000 };
  normalizeTokenFields(body);
  // FLOOR>0 时 1000 会被抬到 FLOOR（reasoning 与正文共用预算，小值正文会被吃光）
  assert.strictEqual(resolveMaxTokens(body.max_tokens, null), FLOOR > 0 ? FLOOR : 1000);
});
