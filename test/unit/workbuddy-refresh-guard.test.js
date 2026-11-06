// test/unit/workbuddy-refresh-guard.test.js - Token 刷新互斥守卫（M2.3）
//
// refreshToken 是轮换制（一次性）：官方客户端、网关 9082、管理端 9083 三方
// 都可能刷新同一账号。guard 两步用「重读 + 判别」消除竞态，不引入锁原语：
//   1. 打上游前重读：存储已有更新的有效 token → 采纳，不打上游
//   2. 打上游失败后重读：存储 token 与本次所用不同且有效 → 败者恢复
//
// 测试用可替换的 exchangeOnce 接缝（假实现，不打真上游）。
// 运行：node --test test/unit/workbuddy-refresh-guard.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-wb-guard-'));
process.env.DUMATE_ADMIN_DATA = TMP;

const auth = require('../../src/workbuddy/auth');

const T = (offsetMs) => Date.now() + offsetMs;

/** 建一个账号：传入的 refreshToken 与存储的不同（模拟「手里的副本过期了」） */
function setup({ storedToken, storedAccess, storedExp, storedRefreshExp }) {
  auth.upsert({
    uid: 'guard-1', region: 'cn',
    accessToken: storedAccess || 'stored-access',
    refreshToken: storedToken || 'stored-rt',
    expiresAt: storedExp ?? T(3600 * 1000),
    refreshExpiresAt: storedRefreshExp ?? T(30 * 86400 * 1000),
  });
  return auth.get(auth.list().find((r) => r.uid === 'guard-1').id);
}

test.afterEach(() => {
  // 恢复真实现 + 清数据（test runner 的 afterEach；node:test 顶层可用）
  auth.exchangeOnce = realExchangeOnce;
  const data = auth.load();
  data.accounts = [];
  auth.save(data);
});

let realExchangeOnce = null;
test.beforeEach(() => { realExchangeOnce = auth.exchangeOnce; });

test('guard 1：存储 token 比传入的新且有效 → 采纳，不打上游', async () => {
  setup({ storedToken: 'stored-rt-new', storedAccess: 'stored-access-new', storedExp: T(3600 * 1000) });
  let upstreamCalls = 0;
  auth.exchangeOnce = async () => { upstreamCalls++; return { ok: false, error: 'should not be called' }; };

  // 调用方手里的是旧副本（官方客户端刚轮换过，存储已被客户端更新）
  const r = await auth.exchange({ id: 1, refreshToken: 'stale-passed-rt' });

  assert.strictEqual(upstreamCalls, 0, '存储已有新值时不应打上游');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.adopted, true, '应标记为采纳路径');
  assert.strictEqual(r.patch.refreshToken, 'stored-rt-new');
  assert.strictEqual(r.patch.accessToken, 'stored-access-new');
  // 调用方按约定 patch 回去（幂等写回相同值）
  auth.patch(1, r.patch);
  const after = auth.get(1);
  assert.strictEqual(after.refreshToken, 'stored-rt-new');
});

test('guard 1 不触发：存储 token 与传入相同 → 正常走上游（成功路径）', async () => {
  setup({ storedToken: 'same-rt' });
  let called = 0;
  auth.exchangeOnce = async (a) => {
    called++;
    assert.strictEqual(a.refreshToken, 'same-rt', '应使用重读后的（最新）token');
    return { ok: true, patch: { accessToken: 'fresh-access', refreshToken: 'rotated-rt', expiresAt: T(3600 * 1000), lastError: '' } };
  };

  const r = await auth.exchange({ id: 1, refreshToken: 'same-rt' });
  assert.strictEqual(called, 1, '应恰好打一次上游');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.adopted, undefined, '正常路径不应带 adopted 标记');
  assert.strictEqual(r.patch.refreshToken, 'rotated-rt');
});

test('guard 1 不触发：存储的 token 相同但已过期 → 照常刷新', async () => {
  setup({ storedToken: 'expired-rt', storedExp: Date.now() - 5000 });
  let called = 0;
  auth.exchangeOnce = async (a) => {
    called++;
    return { ok: true, patch: { accessToken: 'a2', refreshToken: 'r2', expiresAt: T(3600 * 1000) } };
  };
  const r = await auth.exchange({ id: 1, refreshToken: 'expired-rt' });
  assert.strictEqual(called, 1);
  assert.strictEqual(r.ok, true);
});

test('guard 2：上游失败但存储已被别人轮换 → 败者恢复，不判死账号', async () => {
  setup({ storedToken: 'race-rt' });
  auth.exchangeOnce = async (a) => {
    // 模拟竞态：上游调用期间，另一个进程用同一个 race-rt 成功轮换并落盘
    auth.patch(1, { accessToken: 'winner-access', refreshToken: 'winner-rt', expiresAt: T(3600 * 1000), lastError: '' });
    return { ok: false, error: '刷新失败 HTTP 401: invalid_grant' };
  };

  const r = await auth.exchange({ id: 1, refreshToken: 'race-rt' });
  assert.strictEqual(r.ok, true, '败者应恢复成功而不是报 invalid_grant');
  assert.strictEqual(r.adopted, true);
  assert.strictEqual(r.patch.refreshToken, 'winner-rt');
  assert.strictEqual(r.patch.accessToken, 'winner-access');
  // 调用方 patch 回去后，账号仍是健康状态
  auth.patch(1, r.patch);
  const after = auth.get(1);
  assert.strictEqual(after.refreshToken, 'winner-rt');
  assert.strictEqual(after.lastError, '');
});

test('guard 2 不触发：失败且存储 token 未变 → 如实返回错误', async () => {
  setup({ storedToken: 'real-dead-rt' });
  auth.exchangeOnce = async () => ({ ok: false, error: '刷新失败 HTTP 400: bad request' });
  const r = await auth.exchange({ id: 1, refreshToken: 'real-dead-rt' });
  assert.strictEqual(r.ok, false, '真失败必须如实报错');
  assert.match(r.error, /400/);
});

test('guard 2 不触发：存储换了 token 但它已过期（无效）→ 如实报错', async () => {
  setup({ storedToken: 'race-rt' });
  auth.exchangeOnce = async () => {
    auth.patch(1, { accessToken: 'expired-winner', refreshToken: 'expired-winner-rt', expiresAt: Date.now() - 1000 });
    return { ok: false, error: '刷新失败 HTTP 401: invalid_grant' };
  };
  const r = await auth.exchange({ id: 1, refreshToken: 'race-rt' });
  assert.strictEqual(r.ok, false, '存储里的新 token 无效时不能采纳');
});

test('单飞：同账号并发 exchange 只打一次上游', async () => {
  setup({ storedToken: 'sf-rt' });
  let called = 0;
  let release;
  const gate = new Promise((res) => { release = res; });
  auth.exchangeOnce = async () => {
    called++;
    await gate;
    return { ok: true, patch: { accessToken: 'sf-access', refreshToken: 'sf-rt2', expiresAt: T(3600 * 1000) } };
  };
  const p1 = auth.exchange({ id: 1, refreshToken: 'sf-rt' });
  const p2 = auth.exchange({ id: 1, refreshToken: 'sf-rt' });
  // 先放行再等结果——release 放在 await 之后会自锁（假实现永远等不到放行）
  setTimeout(release, 20);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(called, 1, '并发应合并成一次上游调用');
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.ok, true);
});

test('无 id 的裸对象仍走 exchangeOnce（导入/登录期的一次性刷新）', async () => {
  let called = 0;
  auth.exchangeOnce = async (a) => {
    called++;
    assert.strictEqual(a.refreshToken, 'raw-rt');
    return { ok: true, patch: { accessToken: 'x', refreshToken: 'y', expiresAt: T(1000) } };
  };
  const r = await auth.exchange({ refreshToken: 'raw-rt' });
  assert.strictEqual(called, 1);
  assert.strictEqual(r.ok, true);
});
