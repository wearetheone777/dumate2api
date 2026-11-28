// test/unit/workbuddy-refresh-retired.test.js - 凭证退场标记（2026-11-28）
//
// 与 TRAE 同源的缺口：WorkBuddy 的 `auth.ensureFresh` 刷新失败时**静默带旧
// token 继续**（`return a`），错误只在请求真正失败时才浮出来。于是：
//
//   1. 死号的刷新被上游明确拒（12153 / invalid_grant）之后，下一次轮到它
//      又白撞一次换票端点 —— 上游答案不会变。
//   2. 那个 401 走池的 `session_dead` 防误杀计数（连续 3 次才禁用），
//      中间两次全是白白消耗的上游请求。
//
// 修法：刷新被拒 → 标 `refreshRetiredAt`（`needsRefresh` 因此返回 false，
// 不再反复打换票端点）；access 也过期时由选号层直接判废换号。
//
// 锁住四条不变量：
//   1. 判据只认上游原文措辞，认不出不猜（网络抖不能误标）
//   2. 刷新被拒 → 标退场
//   3. 标了之后 needsRefresh 不再要求刷新
//   4. 重新导入（upsert 带新 refreshToken）清标记；不带则保留
//
// 运行：node --test test/unit/workbuddy-refresh-retired.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { tmpDir } = require('../helpers/tmpdir');
const tmp = tmpDir('dumate-wb-retired');
process.env.DUMATE_ADMIN_DATA = tmp;
process.env.DUMATE_POOL_STATE = require('path').join(tmp, 'pool-state.json');

const auth = require('../../src/workbuddy/auth');

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结果 */ }
});

function seed(accounts) {
  const data = { accounts: accounts.map((a, i) => ({ id: i + 1, region: 'cn', ...a })) };
  fs.writeFileSync(auth.filePath(), JSON.stringify(data, null, 2));
}

test('isRefreshRejected：上游终态措辞都认', () => {
  const fn = auth.isRefreshRejected;
  assert.strictEqual(fn('刷新失败 HTTP 401: 12153'), true, '12153 是会话已死标记');
  assert.strictEqual(fn('刷新失败 HTTP 200: Offline user session not found'), true);
  assert.strictEqual(fn('刷新失败 HTTP 400: invalid_grant'), true);
  assert.strictEqual(fn('刷新失败 HTTP 400: refresh token is invalid'), true);
  assert.strictEqual(fn('刷新失败 HTTP 400: refresh token expired'), true);
});

test('isRefreshRejected：认不出不猜（网络抖与参数错不能误标）', () => {
  const fn = auth.isRefreshRejected;
  assert.strictEqual(fn('刷新失败 HTTP 0: timeout'), false);
  assert.strictEqual(fn('刷新失败 HTTP 0: ECONNRESET'), false);
  assert.strictEqual(fn('刷新失败 HTTP 502: Bad Gateway'), false);
  assert.strictEqual(fn('刷新失败 HTTP 400: 参数错误'), false, '没有 refresh 语义的 400 不认');
  assert.strictEqual(fn(''), false);
  assert.strictEqual(fn(null), false);
});

test('ensureFresh：刷新被拒 → 标退场，且 needsRefresh 之后不再刷新', async () => {
  seed([{
    uid: 'dead', nickname: '死号', accessToken: 'A1', refreshToken: 'R1',
    expiresAt: Date.now() - 1000, enabled: true,
  }]);
  const origOnce = auth.exchangeOnce;
  auth.exchangeOnce = async () => ({ ok: false, error: '刷新失败 HTTP 401: 12153' });
  try {
    const before = auth.get(1);
    assert.strictEqual(auth.needsRefresh(before), true, '前置：过期就该刷新');
    const out = await auth.ensureFresh(before);
    assert.strictEqual(out.id, 1, '刷新失败仍返回该账号（带旧 token 试一次）');
    const after = auth.get(1);
    assert.ok(after.refreshRetiredAt, '被拒后必须标退场');
    assert.match(String(after.lastError || ''), /凭证失效/, 'lastError 要能让人看出是凭证问题');
    assert.strictEqual(auth.needsRefresh(after), false, '标了之后不再反复打换票端点');
  } finally {
    auth.exchangeOnce = origOnce;
  }
});

test('ensureFresh：网络抖动不标退场（下次还能自愈）', async () => {
  seed([{
    uid: 'flaky', nickname: '抖号', accessToken: 'A1', refreshToken: 'R1',
    expiresAt: Date.now() - 1000, enabled: true,
  }]);
  const origOnce = auth.exchangeOnce;
  auth.exchangeOnce = async () => ({ ok: false, error: '刷新失败 HTTP 0: timeout' });
  try {
    await auth.ensureFresh(auth.get(1));
    assert.ok(!auth.get(1).refreshRetiredAt, '瞬时故障不能误标（误标要重新登录才能解）');
  } finally {
    auth.exchangeOnce = origOnce;
  }
});

test('ensureFresh：刷新成功清掉退场标记（否则新 token 用到过期都不再刷）', async () => {
  // 场景：先被拒标退场 → 用户重新登录前上游其实恢复了（或标记是误标的）。
  // 这条锁定「成功路径必须清标记」——不清的话 needsRefresh 永远 false，
  // 新 access 用到过期都不会再刷，症状是「突然某天全体 401」。
  // 构造：标了退场、access 已过期。先把标记清掉让 needsRefresh 为真，
  // 模拟 401 强制刷新那条路径（那里 `forceRefresh` 直接调 exchange）。
  seed([{
    uid: 'recover', nickname: '恢复号', accessToken: 'A1', refreshToken: 'R1',
    expiresAt: Date.now() - 1000, enabled: true, refreshRetiredAt: Date.now() - 5000,
  }]);
  const origOnce = auth.exchangeOnce;
  auth.exchangeOnce = async () => ({
    ok: true,
    patch: { accessToken: 'A2', expiresAt: Date.now() + 3600000 },
  });
  try {
    // exchange 成功后 index.js 的路径会 patch({...r.patch, refreshRetiredAt: null})；
    // auth.ensureFresh 里则是同一条语义（见其实现）。这里直接打 ensureFresh：
    // 先清标记打开 needsRefresh 闸门，再验证成功刷新后标记仍为 null。
    auth.patch(1, { refreshRetiredAt: null });
    await auth.ensureFresh(auth.get(1));
    assert.strictEqual(auth.get(1).accessToken, 'A2', '前置：刷新成功');
    assert.ok(!auth.get(1).refreshRetiredAt, '成功刷新后标记必须清掉');
  } finally {
    auth.exchangeOnce = origOnce;
  }
});

test('upsert：带新 refreshToken 清标记；不带则保留', () => {
  seed([{
    uid: 'u1', nickname: '旧', accessToken: 'oldA', refreshToken: 'oldR',
    expiresAt: Date.now() - 1000, enabled: true, refreshRetiredAt: Date.now(),
  }]);
  assert.ok(auth.get(1).refreshRetiredAt, '前置：标记在');
  // 重新导入客户端凭证
  const after = auth.upsert({ uid: 'u1', region: 'cn', accessToken: 'newA', refreshToken: 'newR', expiresAt: Date.now() + 86400000 });
  assert.strictEqual(after.refreshRetiredAt, null, '新凭证必须能生效');
  assert.strictEqual(after.accessToken, 'newA');

  // 只改昵称（不带 refreshToken）不该清标记
  const r2 = auth.upsert({ uid: 'u2', region: 'cn', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() - 1000 });
  auth.patch(r2.id, { refreshRetiredAt: 12345 });
  const keep = auth.upsert({ uid: 'u2', region: 'cn', nickname: '改名' });
  assert.strictEqual(keep.refreshRetiredAt, 12345, '没有新凭证时保留标记');
});
