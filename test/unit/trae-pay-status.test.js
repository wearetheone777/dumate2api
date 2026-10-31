// test/unit/trae-pay-status.test.js - TRAE 付费状态解析 + 请求体韧性（2026-10-31）
//
// pay_status 的字段取自真机实测响应（v2 端点，见 constants.EP_PAY_STATUS 注释）。
// buildBody 的韧性三类取自会导致上游整轮 4001 的形状。
const { test } = require('node:test');
const assert = require('node:assert');
const checkin = require('../../src/traework/checkin');
const chat = require('../../src/traework/chat');

test('parsePayStatus 搬套餐档位与能力位', () => {
  const r = checkin.parsePayStatus({
    user_pay_identity_str: 'Free',
    user_pay_identity: 0,
    is_pay_freshman: true,
    is_credits_billing: true,
    is_support_commercialization: false,
    enable_solo_lite: true,
    enable_solo_web: true,
    enable_solo_coder: true,
    enable_solo_builder: true,
    enable_fission: false,
    server_time_ms: 1793451889615,
  });
  assert.equal(r.payIdentity, 'Free');
  assert.equal(r.isFreshman, true);
  assert.equal(r.capabilities.soloLite, true);
  assert.equal(r.capabilities.fission, false);
  assert.equal(r.serverTimeMs, 1793451889615);
});

test('能力位缺失给 null 而不是 false', () => {
  const r = checkin.parsePayStatus({});
  assert.equal(r.capabilities.soloLite, null);
  assert.equal(r.isFreshman, null);
  assert.equal(r.payIdentity, null);
  // 空体不编造活动
  assert.deepEqual(r.activities, []);
});

test('parsePayStatus 解析活动资格与可领积分', () => {
  const r = checkin.parsePayStatus({
    commercial_activities: [
      { Enabled: true, activity_id: 'send_message_reward', activity_type: 105,
        start_time_ms: 1785859200000, end_time_ms: 4954406399000,
        work_extra: { eligible: true, general_credits: 500 } },
      { Enabled: false, activity_id: 'work_lite_202606', activity_type: 101,
        work_extra: { eligible: false, grantable: false, granted: false } },
    ],
  });
  const reward = r.activities.find((x) => x.activityId === 'send_message_reward');
  assert.equal(reward.kind, 'send_message_reward');
  assert.equal(reward.eligible, true);
  assert.equal(reward.generalCredits, 500);
  const lite = r.activities.find((x) => x.activityId === 'work_lite_202606');
  assert.equal(lite.enabled, false);
  assert.equal(lite.eligible, false);
});

test('未知 activity_type 的 kind 为 null，但原值保留', () => {
  const r = checkin.parsePayStatus({ commercial_activities: [{ activity_type: 999, activity_id: 'x' }] });
  assert.equal(r.activities[0].activityType, 999);
  assert.equal(r.activities[0].kind, null);
});

// ---- buildBody 请求体韧性 ----

test('buildBody 把 role=developer 归一成 system', () => {
  const body = JSON.parse(chat.buildBody({
    messages: [
      { role: 'developer', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
  }, 'glm-5.2', {}));
  assert.equal(body.messages[0].role, 'system');
});

test('buildBody 剔除找不到声明 id 的孤儿 tool 消息', () => {
  const meta = {};
  const body = JSON.parse(chat.buildBody({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '答', tool_calls: [{ id: 'call_a', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_a', content: '结果' },
      { role: 'tool', tool_call_id: 'call_missing', content: '孤儿' },
    ],
  }, 'glm-5.2', meta));
  const tools = body.messages.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].tool_call_id, 'call_a');
  assert.equal(meta.dropped.orphanTool, 1);
});

test('buildBody 剔除空 assistant（无正文无工具）', () => {
  const meta = {};
  const body = JSON.parse(chat.buildBody({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: [], tool_calls: [] },
    ],
  }, 'glm-5.2', meta));
  assert.equal(body.messages.filter((m) => m.role === 'assistant').length, 0);
  assert.equal(meta.dropped.emptyAssistant, 2);
});

test('buildBody 把 system 移到最前（不是复制）', () => {
  const body = JSON.parse(chat.buildBody({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'sys' },
    ],
  }, 'glm-5.2', {}));
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages.length, 2);
});

test('buildBody 保留合法 tool 调用链（不误删）', () => {
  const meta = {};
  const body = JSON.parse(chat.buildBody({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '答', tool_calls: [{ id: 'call_x', function: { name: 'run', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_x', content: 'ok' },
    ],
  }, 'glm-5.2', meta));
  assert.equal(body.messages.length, 3);
  assert.equal(meta.dropped.orphanTool, 0);
  assert.equal(meta.dropped.emptyAssistant, 0);
});
