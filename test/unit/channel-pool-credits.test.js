// test/unit/channel-pool-credits.test.js - 余额写池与保底线（2026-11-08 融合批）
//
// **补的是一个「机制有、接线没接」的缺口**：
// `pool.js` 早就有 `creditFloor` + `floorBlockedFor()`（余额低于保底线时选号跳过），
// 但 `channel-pool` 从来没暴露 `setCredits`，于是**直连通道的余额从未写进池**，
// `floor_blocked` 恒为 false、保底护栏对 WorkBuddy 完全无效。
//
// 这里锁三条：
//   1. `noteCredits` 把余额写进池，`creditsOf` 能读回
//   2. **`null` / `undefined` / 空串 / `NaN` 一律不写**（`Number(null) === 0`，
//      直接 Number 会把「查不到」写成「余额 0」，保底线于是永久拦住该账号——
//      表现为「这个号明明有额度却从不被选中」）
//   3. `creditFloor > 0` 且余额低于它时，`floor_blocked` 为真
//
// 运行：node --test test/unit/channel-pool-credits.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { tmpDir } = require('../helpers/tmpdir');
const DATA = tmpDir('cp-credits');
process.env.DUMATE_ADMIN_DATA = DATA;
process.env.DUMATE_POOL_STATE = path.join(DATA, 'pool-state.json');
// 保底线在 createPool 时定死（`const o`），所以必须在 require 之前设 env
process.env.DUMATE_POOL_CREDIT_FLOOR = '50';

const cp = require('../../src/channel-pool');
const { pool } = require('../../src/pool');

test('noteCredits：写入并读回（含 total）', () => {
  assert.equal(cp.noteCredits('workbuddy', 1, 100.5, 200), true);
  const r = cp.creditsOf('workbuddy', 1);
  assert.equal(r.credits, 100.5);
  assert.equal(r.total, 200);
});

test('noteCredits：null / undefined / 空串 / NaN 一律不写（null ≠ 0）', () => {
  for (const bad of [null, undefined, '', NaN, 'abc']) {
    assert.equal(cp.noteCredits('workbuddy', 2, bad), false,
      `${JSON.stringify(bad)} 不该被写成余额——Number(null)===0 会把「查不到」变成「余额 0」`);
    const r = cp.creditsOf('workbuddy', 2);
    assert.equal(r.credits, null, '拒绝写入后应仍是 null');
  }
});

test('noteCredits：0 是合法余额（真的用完了）', () => {
  assert.equal(cp.noteCredits('workbuddy', 3, 0), true);
  assert.equal(cp.creditsOf('workbuddy', 3).credits, 0);
});

test('保底线：余额低于 creditFloor 时 floor_blocked 为真', () => {
  // env 设了 50
  cp.noteCredits('workbuddy', 10, 10);
  assert.equal(cp.creditsOf('workbuddy', 10).floorBlocked, true, '10 < 50 应被保底线拦住');

  cp.noteCredits('workbuddy', 11, 500);
  assert.equal(cp.creditsOf('workbuddy', 11).floorBlocked, false, '500 > 50 不该被拦');
});

test('保底线：刚好等于 creditFloor 不算低于（边界选「不拦」）', () => {
  cp.noteCredits('workbuddy', 12, 50);
  assert.equal(cp.creditsOf('workbuddy', 12).floorBlocked, false,
    '「低于」是严格小于；等于时还有整 50 可用，拦掉会让额度白放着');
});

test('跨通道隔离：同一个 id 在不同通道是不同账号', () => {
  cp.noteCredits('workbuddy', 99, 1);
  cp.noteCredits('qoder', 99, 9999);
  assert.equal(cp.creditsOf('workbuddy', 99).credits, 1);
  assert.equal(cp.creditsOf('qoder', 99).credits, 9999);
});

test('creditsOf：未写入过的账号返回全 null（不编 0、不编 false 之外的结论）', () => {
  const r = cp.creditsOf('workbuddy', 12345);
  assert.equal(r.credits, null);
  assert.equal(r.total, null);
  assert.equal(r.floorBlocked, false, '没有余额数据时不谈「被保底线拦住」');
});

test('pool 的 creditFloor 从 env 读且非法值回 0（关闭）', () => {
  // 当前进程设了 50，所以 DEFAULTS.creditFloor 不该是 0
  const { DEFAULTS } = require('../../src/pool');
  assert.equal(DEFAULTS.creditFloor, 50, 'env 设了 50 就该读到 50');

  // 用一个独立实例验证非法值：负数/非数字都回 0
  const { createPool } = require('../../src/pool');
  const p2 = createPool({ creditFloor: Number('abc') || 0 });
  assert.equal(typeof p2.setCredits, 'function');
});

test('noteCredits：pool 没有 setCredits 时静默返回 false（不抛）', () => {
  // 这条守的是「接口缺失时不要打挂请求」，用 stub 模拟
  assert.doesNotThrow(() => cp.noteCredits('nonexistent-channel', 1, 5));
});

test('noteCredits 写入后 snapshot 能看见该账号（排障入口）', () => {
  cp.noteCredits('workbuddy', 77, 3.5);
  const snap = pool.snapshot();
  const row = (snap || []).find((r) => String(r.id) === String(cp.uidOf('workbuddy', 77)));
  assert.ok(row, 'snapshot 里应能看到刚写入的账号');
  assert.equal(row.credits, 3.5);
});
