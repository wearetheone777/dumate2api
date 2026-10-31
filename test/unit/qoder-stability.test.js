// test/unit/qoder-stability.test.js - Qoder 通道的三条稳定性补丁（P0-4/5/6）
//
//   1. 请求体超上限本地拒绝（413），不换号、不打上游
//   2. DeepSeek 族的 reasoning_content 回填（只补匹配得上的那条 assistant）
//   3. tool_call.id 缺失补全（流式按 index 稳定、聚合出口也补）
const { test } = require('node:test');
const assert = require('assert');

// 必须在 require 之前设定：MAX_BODY_MB 在模块加载时读一次
process.env.DUMATE_QODER_MAX_BODY_MB = '1';

const chat = require('../../src/qoder/chat');

// ---- 1. 请求体体积 ----
test('请求体未超限时放行并返回字节数', () => {
  const bytes = chat.assertBodySize('a'.repeat(1024));
  assert.strictEqual(bytes, 1024);
});

test('请求体超限抛 413，且标记 tooLarge（上层不换号）', () => {
  const big = 'a'.repeat(1024 * 1024 + 1);
  assert.throws(() => chat.assertBodySize(big), (e) => {
    assert.strictEqual(e.statusCode, 413);
    assert.strictEqual(e.tooLarge, true);
    assert.ok(/超过上游单请求上限/.test(e.message));
    return true;
  });
});

// ---- 2. reasoning 回填 ----
test('DeepSeek 族：匹配到同一条 assistant 时补 reasoning_content', () => {
  chat.rememberReasoning('sess-a', '北京的天气是晴。', '先查天气，再回答。', 'dfmodel');
  const body = JSON.parse(chat.buildBody('dfmodel', {
    messages: [
      { role: 'user', content: '北京天气？' },
      { role: 'assistant', content: '北京的天气是晴。' },
      { role: 'user', content: '那上海呢？' },
    ],
  }, { sessionId: 'sess-a' }));
  const a = body.messages.find((m) => m.role === 'assistant');
  assert.strictEqual(a.reasoning_content, '先查天气，再回答。');
});

test('非 DeepSeek 族不补（不塞未知字段）', () => {
  chat.rememberReasoning('sess-b', '你好。', '思考中', 'gfmodel');
  const body = JSON.parse(chat.buildBody('gfmodel', {
    messages: [
      { role: 'assistant', content: '你好。' },
      { role: 'user', content: '继续' },
    ],
  }, { sessionId: 'sess-b' }));
  const a = body.messages.find((m) => m.role === 'assistant');
  assert.strictEqual(a.reasoning_content, undefined);
});

test('客户端自己带了 reasoning_content 时不覆盖', () => {
  chat.rememberReasoning('sess-c', '答案', '网关的思考', 'dmodel');
  const body = JSON.parse(chat.buildBody('dmodel', {
    messages: [
      { role: 'assistant', content: '答案', reasoning_content: '客户端自带的' },
      { role: 'user', content: '继续' },
    ],
  }, { sessionId: 'sess-c' }));
  const a = body.messages.find((m) => m.role === 'assistant');
  assert.strictEqual(a.reasoning_content, '客户端自带的');
});

test('正文对不上就不补（宁可不补也不编）', () => {
  chat.rememberReasoning('sess-d', '完全不同的回答', '思考', 'dfmodel');
  const body = JSON.parse(chat.buildBody('dfmodel', {
    messages: [
      { role: 'assistant', content: '另一个回答' },
      { role: 'user', content: '继续' },
    ],
  }, { sessionId: 'sess-d' }));
  const a = body.messages.find((m) => m.role === 'assistant');
  assert.strictEqual(a.reasoning_content, undefined);
});

// ---- 3. tool_call.id ----
test('流式：缺 id 时补一个，同一 index 后续帧复用同一个', () => {
  const ids = new Map();
  const f1 = { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Glob' } }] } }] };
  assert.strictEqual(chat.backfillToolCallIds(f1, ids), true);
  const id = f1.choices[0].delta.tool_calls[0].id;
  assert.ok(id && id.startsWith('call_qd_'), `实际 id=${id}`);

  const f2 = { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] };
  assert.strictEqual(chat.backfillToolCallIds(f2, ids), true);
  assert.strictEqual(f2.choices[0].delta.tool_calls[0].id, id);
});

test('流式：上游已给 id 时不改写', () => {
  const ids = new Map();
  const f = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_real', function: { name: 'X' } }] } }] };
  assert.strictEqual(chat.backfillToolCallIds(f, ids), false);
  assert.strictEqual(f.choices[0].delta.tool_calls[0].id, 'call_real');
});

test('聚合出口：缺 id 的 tool_calls 补上', () => {
  const frame = JSON.stringify({
    id: 'x', choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Glob', arguments: '{"p":"**"}' } }] }, finish_reason: 'tool_calls' }],
  });
  const out = chat.aggregate([frame], 'm');
  const tc = out.choices[0].message.tool_calls[0];
  assert.ok(tc.id && tc.id.startsWith('call_qd_'));
  assert.strictEqual(tc.function.name, 'Glob');
});
