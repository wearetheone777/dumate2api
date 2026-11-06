// test/unit/trae-billing-usage.test.js - TRAE 额度包口径 / 逐轮账单 / turn id
//
// 四件事锁死（P0-7 / P0-8 / 2026-11-06 Remote 逐轮计费收官）：
//   1. 额度包要剔除促销/隐藏/已失效三类，不限量（credits_limit=-1）不能当成 0
//   2. 逐轮账单 get_session_usage 的三种响应形状都能解析
//   3. turn id 从事件里按「最后一个非空」取
//   4. session_usage 补充行在 computeCosts 里精确覆盖差值、不混进 rows、
//      并发标注只豁免精确行自己
const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parsePacks } = require('../../src/traework/checkin');
const billing = require('../../src/traework/billing');
const chat = require('../../src/traework/chat');
const credits = require('../../src/traework/credits');

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

// ---- session_usage 补充行的合并语义（2026-11-06）----
// computeCosts 读 dataDir()（每次调用时读 DUMATE_ADMIN_DATA），
// 临时目录写 JSONL 即可离线构造，不需要打桩上游。
function withTempLedger(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-credits-'));
  const prev = process.env.DUMATE_ADMIN_DATA;
  process.env.DUMATE_ADMIN_DATA = tmp;
  try {
    return fn(tmp);
  } finally {
    if (prev === undefined) delete process.env.DUMATE_ADMIN_DATA;
    else process.env.DUMATE_ADMIN_DATA = prev;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }
  }
}

function writeLedger(tmp, rows) {
  fs.writeFileSync(
    path.join(tmp, credits.FILE),
    rows.map((r) => `${JSON.stringify(r)}\n`).join(''),
    'utf8',
  );
}

const cursor = (ts, reqId, consumed, ms = 500) => ({ ts, req_id: reqId, account_id: 1, consumed, ms });

test('computeCosts：session_usage 精确覆盖差值，补充行不混进 rows', () => {
  withTempLedger((tmp) => {
    writeLedger(tmp, [
      cursor(1000, 'r1', 10.0),
      cursor(2000, 'r2', 10.5),   // 差值 0.5，将被精确值 0.42 覆盖
      cursor(3000, 'r3', 11.2),   // 差值 0.7，无精确值维持不变
      { type: 'session_usage', ts: 2100, req_id: 'r2', account_id: 1, turn_id: 't2', credits: 0.42 },
    ]);
    const { rows, delta, exactIds } = credits.computeCosts();
    assert.strictEqual(rows.length, 3, '补充行不进 rows（否则逐笔明细出幽灵行、请求计数重复）');
    assert.strictEqual(delta.r2, 0.42, '精确账单覆盖差值');
    assert.strictEqual(delta.r3, 0.7, '无精确值的行维持差值口径');
    assert.ok(exactIds.has('r2'), '精确行进 exactIds');
    assert.ok(!exactIds.has('r3'));
  });
});

test('computeCosts：并发标注只豁免精确行自己，对端保留', () => {
  withTempLedger((tmp) => {
    // r_a（开始 3000）与 r_b（开始 4000）区间相交 → 两者都进 inexact；
    // r_b 有精确账单后只豁免 r_b——r_a 的差值仍可能含 r_b 的消耗
    writeLedger(tmp, [
      cursor(1000, 'r0', 10.0),
      { ...cursor(5000, 'r_a', 10.3), ms: 2000 },
      { ...cursor(6000, 'r_b', 10.9), ms: 2000 },
      { type: 'session_usage', ts: 6100, req_id: 'r_b', account_id: 1, turn_id: 'tb', credits: 0.55 },
    ]);
    const { delta, inexact, exactIds } = credits.computeCosts();
    assert.strictEqual(delta.r_b, 0.55, '并发行的精确覆盖照常生效');
    assert.ok(exactIds.has('r_b'));
    assert.ok(!inexact.has('r_b'), '精确行不受并发干扰，豁免标注');
    assert.ok(inexact.has('r_a'), '对端的差值仍可能含本请求消耗，标注保留');
  });
});

test('computeCosts：credits=null 的补充行忽略（没查到 ≠ 没花钱）', () => {
  withTempLedger((tmp) => {
    writeLedger(tmp, [
      cursor(1000, 'r1', 10.0),
      cursor(2000, 'r2', 10.5),
      { type: 'session_usage', ts: 2100, req_id: 'r2', account_id: 1, turn_id: 't2', credits: null },
    ]);
    const { rows, delta, exactIds } = credits.computeCosts();
    assert.strictEqual(delta.r2, 0.5, 'null 精确值不覆盖差值');
    assert.strictEqual(exactIds.size, 0);
    assert.strictEqual(rows.length, 2);
  });
});

test('attachCosts：精确行标 session_usage，差值行标 consumed_delta', () => {
  withTempLedger((tmp) => {
    writeLedger(tmp, [
      cursor(1000, 'r1', 10.0),
      cursor(2000, 'r2', 10.5),
      { type: 'session_usage', ts: 2100, req_id: 'r2', account_id: 1, turn_id: 't2', credits: 0.42 },
    ]);
    const page = [
      { channel: 'traework', req_id: 'r2' },
      { channel: 'traework', req_id: 'missing' },
    ];
    const out = credits.attachCosts(page);
    assert.strictEqual(out[0].tw_cost, 0.42);
    assert.strictEqual(out[0].tw_exact, true);
    assert.strictEqual(out[0].tw_source, 'session_usage');
    assert.strictEqual(out[1].tw_source, undefined, '无归因记录的行不带口径标记');
  });
});

// ---- 账单缓存计数抽取（2026-11-06，真机形状）----

test('parseBillCache：顶层 extra_info（真机形状）', () => {
  const r = credits.parseBillCache({
    data: {
      user_usage_group_by_session: {
        amount_float: 0.19, credits_float: 0.19, session_id: '6aecf96d',
        extra_info: { cache_read_token: 25344, cache_write_token: 0, input_token: 25442, output_token: 63 },
        usage_group_details: [{ amount_float: 0.19, extra_info: { cache_read_token: 25344, cache_write_token: 0, input_token: 25442, output_token: 63 } }],
      },
    },
  });
  assert.deepStrictEqual(r, { cacheRead: 25344, cacheWrite: 0, inputTokens: 25442, outputTokens: 63 });
});

test('parseBillCache：顶层缺失时取 details[0]；键名是单数 output_token', () => {
  const r = credits.parseBillCache({
    data: {
      user_usage_group_by_session: {
        usage_group_details: [{ extra_info: { cache_read_token: 5, cache_write_token: 6, input_token: 7, output_token: 8 } }],
      },
    },
  });
  assert.deepStrictEqual(r, { cacheRead: 5, cacheWrite: 6, inputTokens: 7, outputTokens: 8 });
});

test('parseBillCache：全零骨架（免费/未结算）返回 null——0 与「真没缓存」不可区分时不补', () => {
  assert.strictEqual(credits.parseBillCache({
    data: {
      user_usage_group_by_session: {
        amount_float: 0, credits_float: 0, extra_info: { cache_read_token: 0, cache_write_token: 0, input_token: 0, output_token: 0 },
        usage_group_details: [],
      },
    },
  }), null);
  assert.strictEqual(credits.parseBillCache({ data: {} }), null);
  assert.strictEqual(credits.parseBillCache(null), null);
});
