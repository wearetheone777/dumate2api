// test/unit/workbuddy-convfields.test.js - 会话轮级字段（批次十，misakano conv_fields.go 移植）
//
// 出处：conv_fields.go / 两版真机抓包同构——官方把「这一轮属于哪个 request-id」
// 同时写在**头**（X-Conversation-Request-ID）和**体**（最后一条 user 的
// conversationRequestId）里。网关原来只写头，头体不一致本身就是可判别指纹。
//
// 锁的行为：
//   1. 带 opts.convReqId 时，最后一条 user 补 conversationRequestId /
//      startsNewUserRequest:true / agent:'cli' 三件套
//   2. 客户端已带的值原值优先（显式值是意图）；startsNewUserRequest 只补
//      undefined（显式 false 不覆盖）
//   3. 只写「当前轮」最后一条 user——历史 user 的轮级 ID 无从得知，不编造
//   4. 无 opts.convReqId（独立调用方没走 postStream）→ 整个跳过，不写空值
//   5. 头体同源：chatHeaders 用同一个 opts.convReqId，头与体同值
//   6. X-Agent-Type 可覆写（窗口探针 auxiliary），默认 main
//   7. 注入不回写调用方的 payload 对象（buildChatBody 深拷贝语义不被破坏）
//
// 运行：node --test test/unit/workbuddy-convfields.test.js
// 注意：buildChatBody 读运行期配置（runtime.js），测试必须钉住 DUMATE_ADMIN_DATA
// 到临时目录，否则本机面板配置会让断言机器相关。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DUMATE_ADMIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-convfields-'));

const chat = require('../../src/workbuddy/chat');

const acct = { id: 1, uid: 'u12345678', accessToken: 't' };
const REQ = '0190aabbccdd7abc89ef0123456789ab'; // uuidv7hex 形状（32 位小写十六进制）

const build = (payload, opts) => JSON.parse(chat.buildChatBody(payload, 'cn', acct, opts).body);

test('带 convReqId：最后一条 user 补齐三件套', () => {
  const b = build({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }, { convReqId: REQ });
  const u = b.messages.find((m) => m.role === 'user');
  assert.equal(u.conversationRequestId, REQ);
  assert.equal(u.startsNewUserRequest, true);
  assert.equal(u.agent, 'cli');
});

test('客户端自带 conversationRequestId 原值优先；显式 startsNewUserRequest:false 不覆盖', () => {
  const b = build({
    model: 'glm-5.3',
    messages: [{ role: 'user', content: 'hi', conversationRequestId: 'client-own-id', startsNewUserRequest: false }],
  }, { convReqId: REQ });
  const u = b.messages.find((m) => m.role === 'user');
  assert.equal(u.conversationRequestId, 'client-own-id', '显式值是意图');
  assert.equal(u.startsNewUserRequest, false, '只补 undefined');
  assert.equal(u.agent, 'cli', 'agent 未带仍补');
});

test('客户端自带非空 agent 原值优先；空串被补值', () => {
  const b1 = build({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi', agent: 'sdk' }] }, { convReqId: REQ });
  assert.equal(b1.messages.find((m) => m.role === 'user').agent, 'sdk');
  const b2 = build({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi', agent: '', conversationRequestId: '  ' }] }, { convReqId: REQ });
  const u2 = b2.messages.find((m) => m.role === 'user');
  assert.equal(u2.agent, 'cli');
  assert.equal(u2.conversationRequestId, REQ, '空白串视为未带');
});

test('只写最后一条 user，历史 user 不编造', () => {
  const b = build({
    model: 'glm-5.3',
    messages: [
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: '第一轮回答' },
      { role: 'user', content: '第二轮' },
    ],
  }, { convReqId: REQ });
  const users = b.messages.filter((m) => m.role === 'user');
  assert.equal(users.length, 2);
  assert.equal(users[0].conversationRequestId, undefined, '历史轮级 ID 无从得知，不编造');
  assert.equal(users[0].startsNewUserRequest, undefined);
  assert.equal(users[0].agent, undefined);
  assert.equal(users[1].conversationRequestId, REQ);
  assert.equal(users[1].startsNewUserRequest, true);
});

test('无 opts.convReqId → 整个跳过，不写任何轮级字段', () => {
  const b = build({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] });
  const u = b.messages.find((m) => m.role === 'user');
  assert.equal(u.conversationRequestId, undefined);
  assert.equal(u.startsNewUserRequest, undefined);
  assert.equal(u.agent, undefined);
});

test('消息里没有 user（纯 system/assistant）→ 不炸不注入', () => {
  const b = build({
    model: 'glm-5.3',
    messages: [{ role: 'system', content: 's' }, { role: 'assistant', content: 'a' }],
  }, { convReqId: REQ });
  assert.equal(b.messages[1].conversationRequestId, undefined);
});

test('头体同源：chatHeaders 用同一个 opts.convReqId', () => {
  const { body, convId, traceId } = chat.buildChatBody(
    { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }, 'cn', acct, { convReqId: REQ });
  const h = chat.chatHeaders('cn', acct, body.length, convId, traceId, { convReqId: REQ });
  assert.equal(h['X-Conversation-Request-ID'], REQ);
  const parsed = JSON.parse(body);
  assert.equal(parsed.messages.find((m) => m.role === 'user').conversationRequestId, REQ, '头与体同值——同源是本批的全部意义');
  // 不传时本级生成（不空），且 X-Request-ID（cn 区）与它同值
  const h2 = chat.chatHeaders('cn', acct, 10, convId, traceId);
  assert.ok(/^[0-9a-f]{32}$/.test(h2['X-Conversation-Request-ID']));
  assert.equal(h2['X-Request-ID'], h2['X-Conversation-Request-ID']);
});

test('X-Agent-Type：默认 main，可覆写 auxiliary（窗口探针）', () => {
  const h1 = chat.chatHeaders('cn', acct, 10, 'c'.repeat(32), 't'.repeat(32));
  assert.equal(h1['X-Agent-Type'], 'main');
  const h2 = chat.chatHeaders('cn', acct, 10, 'c'.repeat(32), 't'.repeat(32), { agentType: 'auxiliary' });
  assert.equal(h2['X-Agent-Type'], 'auxiliary');
});

test('注入不回写调用方 payload（深拷贝语义不被破坏）', () => {
  const payload = { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] };
  build(payload, { convReqId: REQ });
  assert.equal(payload.messages[0].conversationRequestId, undefined);
  assert.equal(payload.messages[0].startsNewUserRequest, undefined);
  assert.equal(payload.messages[0].agent, undefined);
});
