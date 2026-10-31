// test/unit/trae-remote.test.js - TRAE Remote 链路纯函数（2026-11-01，P2-16）
//
// 事件形状与快照语义全部来自真机实测（见 remote.js 顶部注释）；网络层不
// 做离线断言（真机已在落地时跑通：createSession → plan_item/token_usage/done
// → get_session_usage 返回真实 amount_float）。
const { test } = require('node:test');
const assert = require('node:assert');
const remote = require('../../src/traework/remote');

test('flattenQuery：角色前缀与工具历史的 query 形状', () => {
  const q = JSON.parse(remote.flattenQuery([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' },
    { role: 'assistant', content: 'A', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'f', content: 'R' },
  ]));
  assert.ok(q[0].type === 'text' && typeof q[0].data.content === 'string');
  assert.ok(q[0].data.content.startsWith('[System]\nS'));
  assert.ok(q[0].data.content.includes('[Assistant]\nA'));
  assert.ok(q[0].data.content.includes('[called tools: f({})]'));
  assert.ok(q[0].data.content.includes('[Client Tool Result: c1 f status=succeeded]\nR'));
});

test('flattenQuery：图像块降级为占位文本（不预编渲染器媒体块）', () => {
  const q = JSON.parse(remote.flattenQuery([
    { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] },
  ]));
  assert.ok(q[0].data.content.includes('看图'));
  assert.ok(q[0].data.content.includes('本链路暂不支持'));
});

test('remoteSessionId：同账号同模型稳定、跨账号互异、UUID 形状', () => {
  const a = remote.remoteSessionId('u1', 'm');
  assert.equal(a, remote.remoteSessionId('u1', 'm'));
  assert.notEqual(a, remote.remoteSessionId('u2', 'm'));
  assert.notEqual(a, remote.remoteSessionId('u1', 'm2'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('commonParams：**返回 JSON 字符串**且会话键在 biz_session_id（Trae2api-cn 断言同款）', () => {
  const s = remote.commonParams({ uid: 'u1' }, 'code', 'sess-1');
  assert.equal(typeof s, 'string', '请求体里 common_params 是序列化后的串，不是对象');
  const o = JSON.parse(s);
  assert.equal(o.biz_session_id, 'sess-1');
  assert.equal(o.solo_chat_mode, 'code');
  assert.equal(o.tenant, 'marscode');
});

test('remoteBaseOf：cn 给基址，intl 如实拒绝（未实测不预编）', () => {
  assert.equal(remote.remoteBaseOf('cn'), require('../../src/traework/constants').REMOTE_BASE_CN);
  assert.equal(remote.remoteBaseOf('intl'), null);
  assert.equal(remote.remoteBaseOf(undefined), remote.remoteBaseOf('cn'));
});

test('textAccumulator：快照取新增量、增量追加、旧快照忽略', () => {
  const t = remote.textAccumulator();
  assert.equal(t.push('收到'), '收到');
  // 累积快照：新帧是全文 → 只发新增量
  assert.equal(t.push('收到了'), '了');
  assert.equal(t.push('收到了吗'), '吗');
  // 旧快照迟到（乱序）：不发
  assert.equal(t.push('收到了'), '');
  // 真增量（不是前缀扩展）：追加
  assert.equal(t.push('！'), '！');
  assert.equal(t.value(), '收到了吗！');
});

test('aggregateEvents：plan_item 聚合、usage/model_config/done 归位', () => {
  const agg = remote.aggregateEvents([
    { event: 'plan_item', data: { thought: '你' } },
    { event: 'plan_item', data: { thought: '你好', reasoning_content: 'th' } },
    { event: 'model_config', data: { config_name: 'Doubao-Seed-2.1-Turbo' } },
    { event: 'token_usage', data: { prompt_tokens: 10, completion_tokens: 2, reasoning_tokens: 1, total_tokens: 12 } },
    { event: 'done', data: { status: 'completed' } },
  ], 'auto');
  assert.equal(agg.choices[0].message.content, '你好');
  assert.equal(agg.choices[0].message.reasoning_content, 'th');
  assert.equal(agg.model, 'Doubao-Seed-2.1-Turbo', '实际模型回填（上游恒 auto 时唯一真相）');
  assert.equal(agg.choices[0].finish_reason, 'stop');
  assert.equal(agg.usage.total_tokens, 12);
  assert.equal(agg.usage.completion_tokens_details.reasoning_tokens, 1);
});
