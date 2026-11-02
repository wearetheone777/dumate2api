// test/verify-workbuddy.js - WorkBuddy 通道协议离线验证
//
// 覆盖：请求体规范化（stream/developer/tool_choice/首条 system）、会话注入
// （conversation_id 稳定性 + prompt_cache_key 账号隔离）、X-Conversation 三头、
// 失败分类（402/12153/11140/429）、区域归一化。全部离线，不打上游。
const { test } = require('node:test');
const assert = require('assert');
const chat = require('../src/workbuddy/chat');
const c = require('../src/workbuddy/constants');

test('buildChatBody：强制 stream + developer→system + tool_choice 扁平化', () => {
  const { body } = chat.buildChatBody({
    stream: false,
    messages: [
      { role: 'developer', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
    tool_choice: { type: 'function', function: { name: 'do_it' } },
  }, 'cn', { uid: 'u1' });
  const p = JSON.parse(body);
  assert.equal(p.stream, true);
  assert.equal(p.messages[0].role, 'system');
  assert.equal(p.messages[1].role, 'user');
  assert.equal(p.tool_choice, 'do_it');
});

test('buildChatBody：tool_choice none 连 tools/functions 一起删', () => {
  const { body } = chat.buildChatBody({
    tool_choice: 'none',
    tools: [{ x: 1 }],
    functions: [{ y: 2 }],
    messages: [{ role: 'user', content: 'a' }],
  }, 'cn', {});
  const p = JSON.parse(body);
  assert.ok(!('tool_choice' in p));
  assert.ok(!('tools' in p));
  assert.ok(!('functions' in p));
});

test('buildChatBody：首条非 system 前置最小 system（幂等，不改序）', () => {
  const src = { messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'second' }] };
  const one = chat.buildChatBody(src, 'global', {});
  const p1 = JSON.parse(one.body);
  assert.equal(p1.messages.length, 3);
  assert.equal(p1.messages[0].role, 'system');
  assert.equal(p1.messages[0].content, c.INTERNATIONAL_SYSTEM_PROMPT);
  assert.equal(p1.messages[1].content, 'first');
  // 幂等：已 system 不再注入
  const twice = chat.buildChatBody(JSON.parse(one.body), 'global', {});
  assert.equal(JSON.parse(twice.body).messages.length, 3);
});

test('buildChatBody：conversation_id 同会话稳定（前缀缓存不被打散）', () => {
  const msgs = { messages: [{ role: 'user', content: '第一章写什么' }] };
  const a = chat.buildChatBody(msgs, 'cn', { uid: 'u1' });
  const b = chat.buildChatBody(msgs, 'cn', { uid: 'u1' });
  assert.equal(a.convId, b.convId);
  assert.equal(JSON.parse(a.body).conversation_id, a.convId);
  // 追加轮次（同首条 user）不变
  const more = { messages: [...msgs.messages, { role: 'assistant', content: 'x' }, { role: 'user', content: '继续' }] };
  const c2 = chat.buildChatBody(more, 'cn', { uid: 'u1' });
  assert.equal(c2.convId, a.convId);
  // 不同会话互异
  const d = chat.buildChatBody({ messages: [{ role: 'user', content: '别的会话' }] }, 'cn', { uid: 'u1' });
  assert.notEqual(d.convId, a.convId);
});

test('buildChatBody：prompt_cache_key 按账号硬隔离', () => {
  const msgs = { messages: [{ role: 'user', content: 'hello' }] };
  const a = chat.buildChatBody(msgs, 'cn', { uid: 'user-a' });
  const b = chat.buildChatBody(msgs, 'cn', { uid: 'user-b' });
  const ka = JSON.parse(a.body).prompt_cache_key;
  const kb = JSON.parse(b.body).prompt_cache_key;
  assert.ok(ka.startsWith('wb-user-a-'), ka);
  assert.ok(kb.startsWith('wb-user-b-'), kb);
  assert.notEqual(ka, kb);
  // uid 缺失不注入（宁缺勿造）
  const n = chat.buildChatBody(msgs, 'cn', {});
  assert.ok(!('prompt_cache_key' in JSON.parse(n.body)));
});

test('chatHeaders：X-Conversation 三头必带且与 body 同源；身份缺省 X-No-* 占位', () => {
  const h = chat.chatHeaders('global', { accessToken: 't' }, 10, 'conv-1');
  assert.equal(h['X-Conversation-ID'], 'conv-1');
  assert.ok(h['X-Conversation-Request-ID']);
  assert.ok(h['X-Conversation-Message-ID']);
  assert.equal(h['X-No-User-Id'], '1');
  assert.equal(h['X-No-Enterprise-Id'], '1');
  assert.equal(h['X-No-Department-Info'], '1');
  assert.equal(h['X-Product'], 'SaaS');
  assert.equal(h['X-IDE-Type'], 'CLI');
  assert.equal(h.Origin, 'https://www.workbuddy.ai');
  // 红线：chat 请求绝不携带 X-Refresh-Token
  assert.ok(!Object.keys(h).some((k) => k.toLowerCase() === 'x-refresh-token'));
  // 完整账号走实名头
  const h2 = chat.chatHeaders('cn', { accessToken: 't', uid: 'u', enterpriseId: 'e', domain: 'd' }, 10, 'c');
  assert.equal(h2['X-User-Id'], 'u');
  assert.equal(h2['X-Enterprise-Id'], 'e');
  assert.equal(h2['X-Domain'], 'd');
});

test('classifyStatus：402 优先于 body 标记；12153 会话作废；11140 账号风控', () => {
  assert.equal(c.classifyStatus(402, ''), 'hard_credit');
  assert.equal(c.classifyStatus(200, '积分不足，请充值'), 'hard_credit');
  assert.equal(c.classifyStatus(200, 'error code 12153'), 'session_dead');
  assert.equal(c.classifyStatus(403, '{"code":11140,"msg":"账号存在异常行为"}'), 'restricted');
  assert.equal(c.classifyStatus(403, '{"code":111400}'), 'client');   // 111400 不是 11140
  assert.equal(c.classifyStatus(429, ''), 'soft_rate');
  assert.equal(c.classifyStatus(404, 'model not found'), 'not_found');
  assert.equal(c.classifyStatus(503, 'upstream boom'), 'server');
  assert.equal(c.classifyStatus(400, 'bad request'), 'client');
});

test('区域：normalizeRegion + specOf 两区端点', () => {
  assert.equal(c.normalizeRegion('intl'), 'global');
  assert.equal(c.normalizeRegion('cn'), 'cn');
  assert.equal(c.normalizeRegion(undefined), 'cn');
  assert.equal(c.specOf('cn').chatBase, 'https://copilot.tencent.com');
  assert.equal(c.specOf('cn').billingBase, 'https://www.codebuddy.cn');
  assert.equal(c.specOf('global').chatBase, 'https://www.workbuddy.ai');
  assert.equal(c.specOf('global').modelsPath, '/v3/config');
});

test('parseCreditsRate：x0.00 credits 判免费（后缀不影响取数）', () => {
  const { parseCatalog, parseCreditsRate } = require('../src/workbuddy/models');
  assert.equal(parseCreditsRate('x0.00 credits'), 0);
  assert.equal(parseCreditsRate('0.34'), 0.34);
  assert.equal(parseCreditsRate('x1.50 credits'), 1.5);
  const r = parseCatalog({
    agents: [{ name: 'cli', models: ['free-a', 'paid'] }],
    models: [
      { id: 'free-a', name: 'Free', maxInputTokens: 10, maxOutputTokens: 10, credits: 'x0.00 credits' },
      { id: 'paid', name: 'Paid', maxInputTokens: 10, maxOutputTokens: 10, credits: 'x1.5 credits' },
    ],
  });
  assert.ok(r.ok);
  assert.ok(r.models[0].free);
  assert.equal(r.models[1].rate, 1.5);
  // 白名单：不在 cli 清单里的不列；disabled / 0 窗口跳过
  const r2 = parseCatalog({
    agents: [{ name: 'cli', models: ['a', 'disabled', 'zero'] }],
    models: [
      { id: 'a', maxInputTokens: 1, maxOutputTokens: 1 },
      { id: 'disabled', maxInputTokens: 1, maxOutputTokens: 1, disabled: true },
      { id: 'zero', maxInputTokens: 0, maxOutputTokens: 0 },
      { id: 'extra', maxInputTokens: 5, maxOutputTokens: 5 },
    ],
  });
  assert.deepEqual(r2.models.map((m) => m.id), ['a']);
});
