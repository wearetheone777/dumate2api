// test/unit/attempts.test.js - 尝试链的记录与可用性判据（node:test）
//
// 2026-11-16 调研 P1-5。锁三件事：
//   ① attempts：上限截断、只记判据（无报文）、时间相对请求起点、ms 非数值不落；
//   ② channel-pool.availability 的 details：逐账号「为什么没选它」；
//   ③ details 与 details_truncated 的形状（管理端直接渲染它）。
process.env.DUMATE_POOL_STATE = require('path').join(
  require('os').tmpdir(), `attempts-pool-${process.pid}.json`,
);
const { test } = require('node:test');
const assert = require('assert');
const attempts = require('../../src/attempts');
const channelPool = require('../../src/channel-pool');
const { pool } = require('../../src/pool');

test('attempts：上限 8 条，超了置 truncated（不静默丢）', () => {
  let t = 1000;
  const a = attempts.create({ t0: 1000, now: () => t, limit: 8 });
  for (let i = 0; i < 10; i += 1) { t += 5; a.add({ account: `号${i}`, outcome: 'skip', reason: 'r' }); }
  assert.strictEqual(a.length, 8);
  assert.strictEqual(a.truncated, true);
  const j = a.json();
  assert.strictEqual(j.attempts.length, 8);
  assert.strictEqual(j.attempts_truncated, true);
  assert.strictEqual(j.attempts[0].at, 5, 'at 相对 t0');
});

test('attempts：字段只留判据（账号/结果/原因/时间），不存报文', () => {
  const a = attempts.create({ t0: 0, now: () => 0 });
  const item = a.add({
    accountId: 7, account: '号A', outcome: 'picked', reason: 'link=utils_chat',
    // 这俩来自调用方手滑——不该被带进日志
    body: '{"messages":[...]}', response: '...',
  });
  assert.deepStrictEqual(Object.keys(item).sort(), ['account', 'accountId', 'at', 'outcome', 'reason']);
  assert.strictEqual(item.accountId, 7);
});

test('attempts：ms 只在有限数值时落（NaN 不写，避免界面显示 NaN）', () => {
  const a = attempts.create({ t0: 0, now: () => 0 });
  assert.strictEqual(a.add({ outcome: 'ok', ms: NaN }).ms, undefined);
  assert.strictEqual(a.add({ outcome: 'ok', ms: 123 }).ms, 123);
});

test('attempts：超长原因/账号名被截断（日志行不能被一条脏数据撑爆）', () => {
  const a = attempts.create();
  const item = a.add({ account: 'x'.repeat(200), outcome: 'error', reason: 'y'.repeat(400) });
  assert.strictEqual(item.account.length, 60);
  assert.strictEqual(item.reason.length, 120);
});

test('attempts：summary 给出次数读数（详情仍看数组）', () => {
  const a = attempts.create();
  a.add({ outcome: 'picked' });
  a.add({ outcome: 'error' });
  a.add({ outcome: 'error' });
  assert.deepStrictEqual(a.summary(), { n: 3, truncated: false, counts: { picked: 1, error: 2 } });
});

// --- availability 的逐账号判据 -------------------------------------------

test('availability.details：健康账号 → usable，且不带"为什么没选它"', () => {
  const uid = channelPool.uidOf('traework', 4101);
  pool.revive(uid);
  const r = channelPool.availability('traework', [{ id: 4101, nickname: '健康号' }], {});
  assert.strictEqual(r.usable, true);
  assert.ok(Array.isArray(r.details));
  assert.strictEqual(r.details.length, 0);
});

test('availability.details：禁用 → reason=disabled；软冷却 → cooling:soft', () => {
  const id = 4102;
  const uid = channelPool.uidOf('traework', id);
  pool.revive(uid);
  pool.disable(uid, 'manual');
  let r = channelPool.availability('traework', [{ id, nickname: '停用号' }], {});
  assert.strictEqual(r.usable, false);
  assert.deepStrictEqual(r.details.map((d) => [d.id, d.reason]), [[id, 'disabled']]);

  pool.revive(uid);
  channelPool.noteError('traework', id, { status: 429, message: 'too many requests' });
  r = channelPool.availability('traework', [{ id, nickname: '限流号' }], {});
  assert.strictEqual(r.usable, false);
  assert.strictEqual(r.details[0].reason, 'cooling:soft');
  pool.revive(uid);
});

test('availability.details：模型级冷却单独成词（model_cooling:模型名）', () => {
  const id = 4103;
  const uid = channelPool.uidOf('traework', id);
  pool.revive(uid);
  // 排队型限流带 modelKey → classify 标 scope=model → 只冷却该模型
  channelPool.noteError('traework', id, {
    status: 429,
    message: '{"message":"Resource limit reached","modelKey":"dfmodel","isQueued":true,"serviceAvailable":false}',
    model: 'dfmodel',
  });
  const r = channelPool.availability('traework', [{ id, nickname: '排队号' }], { model: 'dfmodel' });
  assert.strictEqual(r.usable, false);
  assert.match(r.details[0].reason, /model_cooling:dfmodel|cooling:soft/);
  pool.revive(uid);
});
