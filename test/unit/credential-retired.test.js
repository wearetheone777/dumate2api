// test/unit/credential-retired.test.js - 四条通道共用的「凭证退场」口径
//
// 2026-11-28 从 TRAE 一处真机事故长出来的通用机制，随后扩到 WorkBuddy /
// Qoder / 千问。核心是两件事，分开锁：
//
//   A. **判据**（每通道一份，形状不同但纪律相同）
//      · TRAE / WorkBuddy：只认上游原文措辞，网络抖不能误标
//      · Qoder：认 exchange 的 `expired: true`（比字符串可靠）
//      · 千问：401/403 或 INVALID_REFRESH_TOKEN / invalid_grant
//
//   B. **判废位置**（`channel-pool` 的 credentialDead，四条通道共用一次）
//      · 有退场标记 **且** access 已过期 → 不进候选
//      · 只有标记、access 未过期 → 仍可选中（实测这种号还能跑）
//      · 没有 expiresAt → 不敢判死（无法证明 access 失效）
//
// 运行：node --test test/unit/credential-retired.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const tmp = tmpDir('dumate-cred-retired');
process.env.DUMATE_ADMIN_DATA = tmp;
process.env.DUMATE_POOL_STATE = path.join(tmp, 'pool-state.json');

const channelPool = require('../../src/channel-pool');

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结果 */ }
});

// ---- B. 池层判废（与通道无关的那一道闸） ----

test('credentialDead：标记 + access 已过期 → 不进候选', () => {
  const dead = {
    id: 1, uid: 'u1', refreshRetiredAt: Date.now(), expiresAt: Date.now() - 1000,
  };
  const live = {
    id: 2, uid: 'u2', refreshRetiredAt: Date.now(), expiresAt: Date.now() + 86400000,
  };
  const sel = channelPool.pickCandidate('traework', [dead, live], {});
  assert.ok(sel, '至少还有一个可用账号');
  assert.strictEqual(sel.account.id, 2, '过期+退场的号必须被过滤，选到的是 access 仍有效的');
});

test('credentialDead：只有退场标记、access 未过期 → 仍可选中（实测这种号还能跑）', () => {
  const onlyRetired = {
    id: 1, uid: 'u1', refreshRetiredAt: Date.now(), expiresAt: Date.now() + 86400000,
  };
  const sel = channelPool.pickCandidate('traework', [onlyRetired], {});
  assert.ok(sel, '只标退场不该把号排除出候选');
  assert.strictEqual(sel.account.id, 1);
});

test('credentialDead：没有 expiresAt → 不敢判死（无法证明 access 失效）', () => {
  const unknown = { id: 1, uid: 'u1', refreshRetiredAt: Date.now() };
  const sel = channelPool.pickCandidate('traework', [unknown], {});
  assert.ok(sel, '缺少到期时间时宁可放它试一次，错误如实上报');
});

test('credentialDead：全部不可用时返回 null（调用方报「没有可用账号」）', () => {
  const dead = { id: 1, uid: 'u1', refreshRetiredAt: Date.now(), expiresAt: Date.now() - 1000 };
  assert.strictEqual(channelPool.pickCandidate('traework', [dead], {}), null);
});

// ---- A. 各通道判据 ----

test('TRAE isRefreshRejected：认上游措辞，不认网络抖动', () => {
  const trae = require('../../src/traework');
  const fn = trae.internals.isRefreshRejected;
  assert.strictEqual(fn('HTTP 400 {"Error":{"Code":"10101","Data":{"__Message.error":"refresh token is not matched"}}}'), true);
  assert.strictEqual(fn('HTTP 401 {"Error":{"Code":"20101","Data":{"__Message.error":"refresh token is invalid"}}}'), true);
  assert.strictEqual(fn('HTTP 0 ECONNRESET'), false);
  assert.strictEqual(fn('HTTP 502 Bad Gateway'), false);
});

test('WorkBuddy isRefreshRejected：12153 / invalid_grant 认，5xx 不认', () => {
  const wbAuth = require('../../src/workbuddy/auth');
  const fn = wbAuth.isRefreshRejected;
  assert.strictEqual(fn('刷新失败 HTTP 401: 12153'), true);
  assert.strictEqual(fn('刷新失败 HTTP 400: invalid_grant'), true);
  assert.strictEqual(fn('刷新失败 HTTP 0: timeout'), false);
  assert.strictEqual(fn('刷新失败 HTTP 502: Bad Gateway'), false);
});

test('千问 isRefreshRejected：401/403 与两种原文认，网络类不认', () => {
  const qwAuth = require('../../src/qwenwork/auth');
  const fn = qwAuth.isRefreshRejected;
  assert.strictEqual(fn({ ok: false, status: 401, error: 'HTTP 401' }), true);
  assert.strictEqual(fn({ ok: false, status: 403, error: 'HTTP 403' }), true, '403 在上游是凭证语义');
  assert.strictEqual(fn({ ok: false, status: 200, error: 'INVALID_REFRESH_TOKEN' }), true);
  assert.strictEqual(fn({ ok: false, status: 200, error: 'invalid_grant:令牌未激活' }), true);
  assert.strictEqual(fn({ ok: false, status: 0, error: 'timeout' }), false);
  assert.strictEqual(fn({ ok: true }), false, '成功不是拒绝');
});

test('Qoder：exchange 的 expired 标志是判死依据（比字符串可靠）', () => {
  // 不直接 require session（它有网络依赖），只验语义契约：
  // exchange 的失败分两类，expired=true 才是终态。
  const src = fs.readFileSync(path.join(__dirname, '../../src/qoder/session.js'), 'utf8');
  assert.match(src, /if \(r\.expired\)/, 'ensureAccount 必须按 expired 标志打退场标记');
  assert.match(src, /refreshRetiredAt: Date\.now\(\)/, '标记写在 refreshRetiredAt');
  assert.match(src, /refreshRetiredAt: null/, '刷新成功路径必须清标记');
});
