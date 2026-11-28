// test/unit/workbuddy-body-fields.test.js - 官方 body 字段补齐（P0-2）+ 会话 id 形状
//
// 出处：misakano conv_fields.go / 抓包对照（2026-11-28 融合批）。官方对话 body
// 带四个本项目此前缺的字段：cache_retention（前缀缓存保留档）、
// extra_vars.harnessMetadata（代理器元数据，JSON **字符串**形态）、
// extra_vars.initiator（发起方）、reasoning_summary（思考摘要请求，也是上游
// isThinkingEnabled 的信号之一）。probe-workbuddy-ab.js 变体 C 实测上游 200。
//
// 锁的行为：
//   1. 只补缺省——客户端显式给过的值一律不覆盖（显式值是意图）
//   2. harnessMetadata 是 JSON 字符串，内层 schemaVersion/harnessVersion/stepIndex/agent
//   3. initiator 只在末条消息是 user 时补
//   4. conversation_id 是 uuidv7 形状、同会话跨轮稳定；prompt_cache_key 跟着变但派生口径不变
//   5. wb_no_thinking 私有逃生口被消费且不外发
//
// 运行：node --test test/unit/workbuddy-body-fields.test.js
// 注意：buildChatBody 读运行期配置（runtime.js），测试必须钉住 DUMATE_ADMIN_DATA
// 到临时目录，否则本机面板配置会让断言机器相关。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DUMATE_ADMIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-body-'));

const chat = require('../../src/workbuddy/chat');
const c = require('../../src/workbuddy/constants');

const acct = { id: 1, uid: 'u12345678', accessToken: 't' };
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const build = (payload) => JSON.parse(chat.buildChatBody(payload, 'cn', acct).body);

test('cache_retention / reasoning_summary：缺省补齐，显式值不覆盖', () => {
  const b = build({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(b.cache_retention, 'long');
  assert.equal(b.reasoning_summary, 'auto');
  const b2 = build({
    model: 'glm-5.3',
    messages: [{ role: 'user', content: 'hi' }],
    cache_retention: 'short',
    reasoning_summary: 'off',
  });
  assert.equal(b2.cache_retention, 'short', '显式值是意图，不覆盖');
  assert.equal(b2.reasoning_summary, 'off');
});

test('extra_vars.harnessMetadata：JSON 字符串形态 + 内层字段', () => {
  const b = build({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(typeof b.extra_vars.harnessMetadata, 'string', '官方是 JSON 字符串形态');
  const hm = JSON.parse(b.extra_vars.harnessMetadata);
  assert.equal(hm.schemaVersion, 1);
  assert.equal(hm.harnessVersion, c.CHAT_CLI_VERSION);
  assert.equal(hm.stepIndex, 0);
  assert.deepEqual(hm.agent, { depth: 0 });
  // 显式值不覆盖
  const b2 = build({
    model: 'glm-5.3',
    messages: [{ role: 'user', content: 'hi' }],
    extra_vars: { harnessMetadata: '{"custom":true}' },
  });
  assert.equal(b2.extra_vars.harnessMetadata, '{"custom":true}');
});

test('extra_vars.initiator：末条消息是 user 才补', () => {
  const u = build({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(u.extra_vars.initiator, 'user');
  const a = build({
    model: 'glm-5.3',
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }],
  });
  assert.equal(a.extra_vars.initiator, undefined, '末条是 assistant 不补');
  const e = build({
    model: 'glm-5.3',
    messages: [{ role: 'user', content: 'hi' }],
    extra_vars: { initiator: 'agent' },
  });
  assert.equal(e.extra_vars.initiator, 'agent', '显式值不覆盖');
});

test('conversation_id：uuidv7 形状、同会话稳定、prompt_cache_key 派生口径不变', () => {
  const payload = { model: 'glm-5.3', messages: [{ role: 'user', content: 'A' }] };
  const r1 = chat.buildChatBody(payload, 'cn', acct);
  const r2 = chat.buildChatBody({ ...payload }, 'cn', acct);
  assert.match(r1.convId, UUID_V7);
  assert.equal(r1.convId, r2.convId, '同会话跨轮稳定（前缀缓存不被打散）');
  const b = JSON.parse(r1.body);
  assert.equal(b.conversation_id, r1.convId, 'body 与头同源');
  assert.ok(b.prompt_cache_key.startsWith('wb-u1234567-'));
  assert.notEqual(
    JSON.parse(chat.buildChatBody({ model: 'glm-5.3', messages: [{ role: 'user', content: 'B' }] }, 'cn', acct).body).prompt_cache_key,
    b.prompt_cache_key,
    '不同会话不同缓存键',
  );
  const noUid = JSON.parse(chat.buildChatBody({ model: 'glm-5.3', messages: [{ role: 'user', content: 'A' }] }, 'cn', {}).body);
  assert.ok(!('prompt_cache_key' in noUid), 'uid 缺失不注入（宁缺勿造）');
});

test('wb_no_thinking：私有逃生口被消费、不外发', () => {
  const b = build({
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'hi' }],
    wb_no_thinking: true,
  });
  assert.ok(!('wb_no_thinking' in b), '私有标记绝不外发');
  assert.equal(b.thinking, undefined, '逃生口生效：本轮不注入思考');
  // 普通请求不受影响（对比组）
  const b2 = build({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(b2.thinking, { type: 'enabled' });
});

test('既有规范化不被新字段挤掉：developer→system / tool_choice none / 首条 system', () => {
  const b = build({
    model: 'glm-5.3',
    messages: [{ role: 'developer', content: 'dev' }, { role: 'user', content: 'hi' }],
    tool_choice: { type: 'none' },
    tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
  });
  assert.equal(b.messages[0].role, 'system');
  assert.equal(b.tool_choice, undefined);
  assert.equal(b.tools, undefined);
  assert.equal(b.stream, true);
});

// —— P2「11151 空 text 段补位」批（2026-11-28，misakano empty_text_part.go）——

test('11151 补位：parts 数组零长度段填空格，其余段与放行形状一字不动', () => {
  const b = build({
    model: 'glm-5.3',
    messages: [{ role: 'user', content: [
      { type: 'text', text: '' },
      { type: 'image_url', image_url: { url: 'u' } },
      { type: 'text', text: '   ' }, // 只判零长度：三个空格上游实测放行，不动
      { type: 'text' },              // 缺失也判空
      { type: 'textarea', text: '' }, // 未知 type 上游不校验，动了反而扩大校验面
    ] }],
  });
  const parts = b.messages[b.messages.length - 1].content;
  assert.equal(parts[0].text, ' ');
  assert.deepEqual(parts[1], { type: 'image_url', image_url: { url: 'u' } });
  assert.equal(parts[2].text, '   ');
  assert.equal(parts[3].text, ' ');
  assert.equal(parts[4].text, '');
});

test('11151 补位：字符串嗅探只在字节层面补，工具输出原样保留', () => {
  const raw = '  [ {"type":"text","text":"","seq":12345678901234567890,"html":"<b>&</b>"},{"type":"text","text":"ok"} ]  ';
  const b = build({ model: 'glm-5.3', messages: [{ role: 'user', content: raw }] });
  const out = b.messages[b.messages.length - 1].content;
  assert.equal(typeof out, 'string');
  // 只补空段；大整数精度、HTML 实体、前后空白、未空段全部一字不动
  // （整体 JSON 往返会丢大整数精度、改转义、重排键序——所以必须字节级）
  assert.equal(
    out,
    '  [ {"type":"text","text":" ","seq":12345678901234567890,"html":"<b>&</b>"},{"type":"text","text":"ok"} ]  ',
  );
});

test('11151 补位：缺失/null text 键补位；不被嗅探的形状不动（普通请求零影响）', () => {
  // 缺失 → 紧跟 { 插入；null → 原位替换
  const b1 = build({ model: 'glm-5.3', messages: [{ role: 'user', content: '[{"type":"text"}]' }] });
  assert.equal(b1.messages[b1.messages.length - 1].content, '[{"text":" ","type":"text"}]');
  const b2 = build({ model: 'glm-5.3', messages: [{ role: 'user', content: '[{"type":"text","text":null}]' }] });
  assert.equal(b2.messages[b2.messages.length - 1].content, '[{"type":"text","text":" "}]');
  // 上游不嗅探 / 不判空的形状：一字不动
  const noTouch = [
    '[{"type":"textarea","text":""}]', // 无 text 段
    '[]', // 空数组
    '[1,2]', // 非对象元素
    '{"type":"text","text":""}', // 对象形态不嗅探
    'plain [not json', // 以 [ 开头但不是 JSON
    '[{"type":"text","text":"\\u0022"}]', // 转义形态宁可不补（只认原文 null/""）
    'ok', // 普通文本
  ];
  for (const s of noTouch) {
    const b = build({ model: 'glm-5.3', messages: [{ role: 'user', content: s }] });
    assert.equal(b.messages[b.messages.length - 1].content, s, `不应改动: ${s}`);
  }
});
