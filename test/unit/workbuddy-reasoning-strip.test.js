// test/unit/workbuddy-reasoning-strip.test.js - 11150 自动降级（2026-11-08 融合批）
//
// 出处：GitHub 生态调研。上游 11150 `reasoning effort is not supported` 的含义是
// 「模型存在、账号健康，只是这个模型不吃 effort 参数」——**把字段剥掉重发一次就过**。
//
// 原实现把 body 原样透传（buildChatBody 是整包深拷贝），撞上 11150 后按请求级
// 失败抛出，用户拿到 400；而这次失败本来是可以救回来的。
//
// 锁的行为：
//   1. 四种字段名都要剥（不同客户端/翻译层给的不同）
//   2. **幂等**：剥完再剥返回 null（防无限降级）
//   3. 没这些字段时返回 null（不是空改动）
//   4. 不碰 messages / tools 等其它字段（只删该删的）
//   5. 非法 JSON 不抛（返回 null，交给上层走正常错误路径）
//
// 运行：node --test test/unit/workbuddy-reasoning-strip.test.js
const test = require('node:test');
const assert = require('node:assert');

const chat = require('../../src/workbuddy/chat');

const parse = (s) => JSON.parse(s);

test('剥 reasoning_effort（OpenAI 风格顶层）', () => {
  const r = chat.withoutReasoningFields(JSON.stringify({
    messages: [{ role: 'system', content: 'x' }],
    reasoning_effort: 'high',
  }));
  assert.ok(r);
  assert.deepEqual(r.removed, ['reasoning_effort']);
  assert.equal(parse(r.body).reasoning_effort, undefined);
  assert.equal(parse(r.body).messages.length, 1, 'messages 必须原样保留');
});

test('剥 reasoning（嵌套形态）与 thinking / enable_thinking', () => {
  for (const key of ['reasoning', 'thinking', 'enable_thinking']) {
    const r = chat.withoutReasoningFields(JSON.stringify({ messages: [], [key]: { effort: 'low' } }));
    assert.ok(r, `${key} 应被识别`);
    assert.deepEqual(r.removed, [key]);
    assert.equal(parse(r.body)[key], undefined);
  }
});

test('同时存在多个字段：一并剥掉，且全部列出', () => {
  const r = chat.withoutReasoningFields(JSON.stringify({
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'high',
    reasoning: { effort: 'high' },
    enable_thinking: true,
  }));
  assert.ok(r);
  assert.deepEqual(r.removed.sort(), ['enable_thinking', 'reasoning', 'reasoning_effort']);
  const b = parse(r.body);
  for (const k of r.removed) assert.equal(b[k], undefined);
});

test('幂等：剥完再剥返回 null（这是「只降级一次」的判据）', () => {
  const once = chat.withoutReasoningFields(JSON.stringify({ messages: [], reasoning_effort: 'high' }));
  assert.ok(once);
  const twice = chat.withoutReasoningFields(once.body);
  assert.equal(twice, null, '没有可剥的字段时必须返回 null，否则会无限降级');
});

test('没有这些字段时返回 null（不做空改动）', () => {
  assert.equal(chat.withoutReasoningFields(JSON.stringify({ messages: [{ role: 'user', content: 'x' }] })), null);
  assert.equal(chat.withoutReasoningFields(JSON.stringify({})), null);
});

test('不碰其它字段：tools / temperature / model 全部原样', () => {
  const src = {
    model: 'glm-5',
    temperature: 0.7,
    tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'high',
  };
  const r = chat.withoutReasoningFields(JSON.stringify(src));
  const b = parse(r.body);
  assert.equal(b.model, 'glm-5');
  assert.equal(b.temperature, 0.7);
  assert.deepEqual(b.tools, src.tools);
  assert.deepEqual(b.messages, src.messages);
});

test('非法 JSON 返回 null 而不是抛（交给上层正常错误路径）', () => {
  assert.doesNotThrow(() => chat.withoutReasoningFields('{not json'));
  assert.equal(chat.withoutReasoningFields('{not json'), null);
  assert.equal(chat.withoutReasoningFields(null), null);
  assert.equal(chat.withoutReasoningFields(undefined), null);
  assert.equal(chat.withoutReasoningFields(123), null);
});

test('不修改入参（调用方可能还要用原 payload 做别的）', () => {
  const original = { messages: [], reasoning_effort: 'high' };
  const snapshot = JSON.stringify(original);
  chat.withoutReasoningFields(JSON.stringify(original));
  assert.equal(JSON.stringify(original), snapshot, '入参对象不能被就地改动');
});

test('接受对象输入（不只是字符串）', () => {
  const r = chat.withoutReasoningFields({ messages: [], reasoning_effort: 'low' });
  assert.ok(r);
  assert.deepEqual(r.removed, ['reasoning_effort']);
});
