// test/unit/qwen-cooldown.test.js - 千问「无可用账号」归因四态（2026-11-27 融合 P0-2）
//
// 锁 src/qwenwork/cooldown.js 的 attributeNoAccount：把 channelPool.availability()
// 的逐账号原因压成四态文案 + 冷却概况。四态的处置完全不同，不能压成一句
// 「没有可用账号」——软冷却要 429（客户端自动退避），硬冷却/停用要 503 等人处理。
const { test } = require('node:test');
const assert = require('assert');

const { attributeNoAccount } = require('../../src/qwenwork/cooldown');

// 构造 availability() 的返回体（形状与 channel-pool.availability 一致）
function av(details, { softOnly = false, nextInMs = 0 } = {}) {
  return { usable: false, nextInMs, softOnly, busy: false, details, details_truncated: false };
}
const d = (id, reason) => ({ id, name: `账号${id}`, reason });

test('账号不存在：归因为「尚未添加」，回 503', () => {
  const err = attributeNoAccount(av([]), 0);
  assert.ok(err.message.includes('尚未添加'), `文案: ${err.message}`);
  assert.strictEqual(err.statusCode, 503);
  assert.strictEqual(err.noAccount, true);
});

test('全停用/暂停：归因为停用，回 503（不是 429）', () => {
  const err = attributeNoAccount(av([d(1, 'disabled'), d(2, 'paused')]), 2);
  assert.ok(err.message.includes('停用或暂停'), `文案: ${err.message}`);
  assert.strictEqual(err.statusCode, 503);
});

test('额度用尽（硬冷却）：归因为额度用尽，回 503', () => {
  const err = attributeNoAccount(av([d(1, 'cooling:hard')], { nextInMs: 3600000 }), 1);
  assert.ok(err.message.includes('额度用尽'), `文案: ${err.message}`);
  assert.strictEqual(err.statusCode, 503);
  // 硬冷却也带恢复时间（额度重置时刻）
  assert.strictEqual(err.retryAfterMs, 3600000);
});

test('全在冷却（软/模型级）：归因为冷却，回 429 让客户端退避', () => {
  const err = attributeNoAccount(
    av([d(1, 'cooling:soft'), d(2, 'model_cooling:pro')], { softOnly: true, nextInMs: 60000 }),
    2,
  );
  assert.ok(err.message.includes('冷却'), `文案: ${err.message}`);
  assert.strictEqual(err.statusCode, 429);
  assert.strictEqual(err.retryAfterMs, 60000);
  assert.deepStrictEqual(err.cooldown, { coolingCount: 2, nextInMs: 60000 });
});

test('在途满/最小间隔：归因为并发闸门，回 503', () => {
  const err = attributeNoAccount(av([d(1, 'inflight'), d(2, 'interval')]), 2);
  assert.ok(err.message.includes('在途满或处于最小请求间隔'), `文案: ${err.message}`);
  assert.strictEqual(err.statusCode, 503);
});

test('余额低于保留下限：归因为保底，回 503', () => {
  const err = attributeNoAccount(av([d(1, 'floor_blocked')]), 1);
  assert.ok(err.message.includes('保留下限'), `文案: ${err.message}`);
  assert.strictEqual(err.statusCode, 503);
});

test('混合原因：硬冷却优先于软冷却（额度用尽是更严重的态）', () => {
  // 一个硬冷却 + 一个软冷却：报额度用尽（硬），不报「全在冷却」
  const err = attributeNoAccount(av([d(1, 'cooling:hard'), d(2, 'cooling:soft')]), 2);
  assert.ok(err.message.includes('额度用尽'), `文案: ${err.message}`);
});

test('无恢复时间时不设 retryAfterMs / cooldown', () => {
  const err = attributeNoAccount(av([d(1, 'disabled')], { nextInMs: 0 }), 1);
  assert.strictEqual(err.retryAfterMs, undefined);
  assert.strictEqual(err.cooldown, undefined);
});

test('noAccountDetails 带逐账号原因，供客户端排查', () => {
  const details = [d(1, 'cooling:soft'), d(2, 'model_cooling:pro')];
  const err = attributeNoAccount(av(details, { softOnly: true, nextInMs: 30000 }), 2);
  assert.ok(Array.isArray(err.noAccountDetails));
  assert.strictEqual(err.noAccountDetails.length, 2);
  assert.strictEqual(err.noAccountDetails[1].reason, 'model_cooling:pro');
});

test('details 缺失时不报错（容错）', () => {
  const err = attributeNoAccount({ usable: false, nextInMs: 0, softOnly: false }, 1);
  assert.strictEqual(err.statusCode, 503);
  assert.ok(err.message.includes('没有可用账号'));
});
