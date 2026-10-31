// test/unit/trae-billing-usage.test.js - TRAE 额度包口径 / 逐轮账单 / turn id
//
// 三件事锁死（P0-7 / P0-8）：
//   1. 额度包要剔除促销/隐藏/已失效三类，不限量（credits_limit=-1）不能当成 0
//   2. 逐轮账单 get_session_usage 的三种响应形状都能解析
//   3. turn id 从事件里按「最后一个非空」取
const { test } = require('node:test');
const assert = require('assert');
const { parsePacks } = require('../../src/traework/checkin');
const billing = require('../../src/traework/billing');
const chat = require('../../src/traework/chat');

const pack = (over = {}) => ({
  display_desc: over.name || '额度包',
  entitlement_base_info: { quota: { credits_limit: over.limit != null ? over.limit : 100 } },
  usage: { credits_amount: over.used != null ? over.used : 20 },
  expire_time: over.exp,
  status: over.status,
  product_type: over.productType,
  is_hide: over.hide,
});

test('parsePacks：正常包按 limit−used 算剩余', () => {
  const out = parsePacks({ user_entitlement_pack_list: [pack({ limit: 100, used: 20 })] });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].limit, 100);
  assert.strictEqual(out[0].remain, 80);
});

test('parsePacks：促销包（product_type=3）剔除', () => {
  const out = parsePacks({ user_entitlement_pack_list: [pack({ productType: 3 })] });
  assert.strictEqual(out.length, 0);
});

test('parsePacks：隐藏包剔除', () => {
  const out = parsePacks({ user_entitlement_pack_list: [pack({ hide: true })] });
  assert.strictEqual(out.length, 0);
});

test('parsePacks：已失效包（status=3）剔除', () => {
  const out = parsePacks({ user_entitlement_pack_list: [pack({ status: 3 })] });
  assert.strictEqual(out.length, 0);
});

test('parsePacks：credits_limit=-1 是不限量，不能算成剩余 0', () => {
  const out = parsePacks({ user_entitlement_pack_list: [pack({ limit: -1, used: 5 })] });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].unlimited, true);
  assert.strictEqual(out[0].limit, null);
  assert.strictEqual(out[0].remain, null);
});

test('parsePacks：按到期时间升序', () => {
  const out = parsePacks({
    user_entitlement_pack_list: [
      pack({ name: 'late', exp: 2000 }),
      pack({ name: 'early', exp: 1000 }),
    ],
  });
  assert.deepStrictEqual(out.map((p) => p.name), ['early', 'late']);
});

test('parseSessionUsage：对象形状取 credits_float', () => {
  const r = billing.parseSessionUsage({ data: { user_usage_group_by_session: { credits_float: 1.23 } } });
  assert.strictEqual(r.credits, 1.23);
});

test('parseSessionUsage：真实字段名 amount_float 也认', () => {
  const r = billing.parseSessionUsage({
    data: { user_usage_group_by_session: { amount_float: 0.42, usage_group_details: [{ x: 1 }] } },
  });
  assert.strictEqual(r.credits, 0.42);
});

test('parseSessionUsage：全零骨架（amount_float=0 且无明细）如实 null', () => {
  const r = billing.parseSessionUsage({
    data: { user_usage_group_by_session: { amount_float: 0, usage_group_details: [] } },
  });
  assert.strictEqual(r.credits, null);
});

test('parseSessionUsage：数组形状求和', () => {
  const r = billing.parseSessionUsage({
    data: { user_usage_group_by_session: [{ credits_float: 1.1 }, { credits_float: 0.2 }] },
  });
  assert.strictEqual(r.credits, 1.3);
});

test('parseSessionUsage：取不到时如实 null', () => {
  assert.strictEqual(billing.parseSessionUsage({ data: {} }).credits, null);
  assert.strictEqual(billing.parseSessionUsage(null).credits, null);
});

test('turnIdOf：取最后一个非空 id', () => {
  const events = [
    { event: 'output', data: { reply_to_message_id: 'turn-1' } },
    { event: 'output', data: { user_message_id: 'turn-2' } },
    { event: 'done', data: { finish_reason: 'stop' } },
  ];
  assert.strictEqual(chat.turnIdOf(events), 'turn-2');
});

test('turnIdOf：没有任何 id 时返回 null', () => {
  assert.strictEqual(chat.turnIdOf([{ event: 'output', data: { response: 'hi' } }]), null);
  assert.strictEqual(chat.turnIdOf(null), null);
});
