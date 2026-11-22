// test/unit/qoder-balance-probe.test.js - Qoder 余额轮转探活（P1-8）
//
// 调研出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P1-8「轮转探活 / 余额后台刷新 +
// 冷却自动解冻」。要补的真缺口：`channelPool.noteCredits` 早就存在
// （`pool.creditFloor` 的接线点），但 Qoder 从来没往里写——于是
// `DUMATE_POOL_CREDIT_FLOOR` 保底护栏对 Qoder 完全无效。
//
// 锁住的口径：
//   1. **轮转**：每轮只探一个账号，N 个账号 N 轮全覆盖（不形成机器节奏）
//   2. 有效余额 = addOnQuota.remaining + userQuota.remaining（团队共享池不相加）
//   3. `credits == null` 一律不写池（查不到 ≠ 0，写 0 会让保底护栏永久拦住该号）
//   4. 探活失败不抛、不写池，如实回执
//
// 运行：node --test test/unit/qoder-balance-probe.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-qoder-balance');
process.env.DUMATE_ADMIN_DATA = TMP;
process.env.DUMATE_POOL_STATE = path.join(TMP, 'pool-state.json');

const balanceRefresh = require('../../src/balance-refresh');
const channelPool = require('../../src/channel-pool');
const { pool } = require('../../src/pool');

const { collectQoder } = balanceRefresh.internals;

const A = (id) => ({
  id, uid: `uid-${id}`, nickname: `号${id}`, region: 'cn', enabled: true,
  accessToken: `dt-${id}`, refreshToken: `drt-${id}`,
});

function resetCursor() { balanceRefresh.state.qoderCursor = 0; }

test('轮转：每轮只探一个账号，N 轮覆盖全部，且顺序按 id', async () => {
  resetCursor();
  const accounts = [A(3), A(1), A(2)];   // 故意乱序：应按 id 升序轮转
  const probed = [];
  for (let i = 0; i < 3; i++) {
    const r = await collectQoder({
      list: () => accounts,
      quota: async (a) => { probed.push(a.id); return { ok: true, addOnQuota: { remaining: 10 }, userQuota: { remaining: 0 } }; },
    });
    assert.strictEqual(r.probed, 1, '每轮只探一个号');
  }
  assert.deepStrictEqual(probed, [1, 2, 3], '按 id 升序轮转');
  // 第 4 轮回到 1 号
  const r4 = await collectQoder({
    list: () => accounts,
    quota: async (a) => ({ ok: true, addOnQuota: { remaining: 10 }, userQuota: { remaining: 0 } }),
  });
  assert.strictEqual(r4.account.id, 1, '游标回绕');
});

test('有效余额 = addOnQuota + userQuota，并写进池（保底护栏的接线点）', async () => {
  resetCursor();
  const acc = A(41);
  pool.revive(`qoder:${acc.id}`);
  const r = await collectQoder({
    list: () => [acc],
    quota: async () => ({ ok: true, addOnQuota: { remaining: 120 }, userQuota: { remaining: 30 } }),
  });
  assert.strictEqual(r.account.total, 150);
  assert.strictEqual(r.account.addOn, 120);
  assert.strictEqual(r.account.user, 30);
  assert.strictEqual(r.account.wrote, true, '必须写进池，否则 creditFloor 对 Qoder 无效');
  const snap = channelPool.creditsOf('qoder', acc.id);
  assert.strictEqual(snap.credits, 150, '池里能读回');
});

test('只有 userQuota 时也写（免费号 addOn 为 0 的边界）', async () => {
  resetCursor();
  const acc = A(42);
  pool.revive(`qoder:${acc.id}`);
  const r = await collectQoder({
    list: () => [acc],
    quota: async () => ({ ok: true, addOnQuota: { remaining: 0 }, userQuota: { remaining: 200 } }),
  });
  assert.strictEqual(r.account.total, 200);
  assert.strictEqual(channelPool.creditsOf('qoder', acc.id).credits, 200);
});

test('额度查不到（ok=false）→ 不写池、如实回执', async () => {
  resetCursor();
  const acc = A(43);
  pool.revive(`qoder:${acc.id}`);
  // 先写一个已知值，用来证明失败轮次**不会**把它改成 0
  channelPool.noteCredits('qoder', acc.id, 88);
  const r = await collectQoder({
    list: () => [acc],
    quota: async () => ({ ok: false, error: 'HTTP 503' }),
  });
  assert.strictEqual(r.account.ok, false);
  assert.strictEqual(r.account.total, null);
  assert.strictEqual(r.account.wrote, false);
  assert.match(r.account.error, /503/);
  assert.strictEqual(channelPool.creditsOf('qoder', acc.id).credits, 88, '失败不该把余额洗成 0');
});

test('remaining 缺失（null）→ 不写池（null ≠ 0 的第二道闸）', async () => {
  resetCursor();
  const acc = A(44);
  pool.revive(`qoder:${acc.id}`);
  channelPool.noteCredits('qoder', acc.id, 55);
  const r = await collectQoder({
    list: () => [acc],
    // 上游回了 200 但两个池都没有 remaining 字段（形状漂移）
    quota: async () => ({ ok: true, addOnQuota: null, userQuota: null }),
  });
  assert.strictEqual(r.account.total, null);
  assert.strictEqual(r.account.wrote, false);
  assert.strictEqual(channelPool.creditsOf('qoder', acc.id).credits, 55, '不能把「查不到」写成 0');
});

test('无可用账号 → 返回 null（排程段跳过，不报错）', async () => {
  resetCursor();
  const r = await collectQoder({ list: () => [] });
  assert.strictEqual(r, null);
});

test('quota 抛异常 → 包成失败回执，不向上抛', async () => {
  resetCursor();
  const acc = A(45);
  const r = await collectQoder({
    list: () => [acc],
    quota: async () => { throw new Error('socket hang up'); },
  });
  assert.strictEqual(r.account.ok, false);
  assert.match(r.account.error, /socket hang up/);
  assert.strictEqual(r.account.wrote, false);
});

test('runOnce 把 Qoder 段接进回执（默认 null 跳过，不影响既有通道）', async () => {
  resetCursor();
  const out = await balanceRefresh.runOnce('manual', {
    list: () => [],
    quota: async () => ({ ok: false, error: 'none' }),
    workbuddy: null,
    qoder: {
      list: () => [A(46)],
      quota: async () => ({ ok: true, addOnQuota: { remaining: 42 }, userQuota: { remaining: 0 } }),
    },
  });
  assert.ok(out.qoder, '回执要带 qoder 段');
  assert.strictEqual(out.qoder.account.id, 46);
  assert.strictEqual(out.qoder.account.total, 42);

  // 老调用方（不传 qoder）仍然照跑，qoder 段为 null
  const out2 = await balanceRefresh.runOnce('manual', {
    list: () => [], quota: async () => ({ ok: false, error: 'none' }), workbuddy: null, qoder: null,
  });
  assert.strictEqual(out2.qoder, null);
});
