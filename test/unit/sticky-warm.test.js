// test/unit/sticky-warm.test.js - 会话暖账号列表（hub #718 的 SessionAffinity）
//
// 锁三件事：
//   1. sticky 的新语义：bind = promote 到 front，原 front 降为 fallback；
//      recent() 给 front 优先的暖列表；单值 lookup 兼容旧调用方。
//   2. channel-pool.pickCandidate 的暖列表优先：front 不可用（冷却）时先试
//      会话的其他暖账号，而不是直接池轮询随机换号丢前缀缓存。
//   3. 池轮询换号后 promote 重排，暖副本保留；绑定账号被显式排除才全清。
const { test } = require('node:test');
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DUMATE_ADMIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-sticky-'));
// 池状态写临时文件（不污染真实 data/pool-state.json）
process.env.DUMATE_POOL_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-sticky-state-')) + '/pool-state.json';

const { createSticky } = require('../../src/sticky');
const channelPool = require('../../src/channel-pool');
const { pool } = require('../../src/pool');

test('sticky：bind 是 promote，recent 给 front 优先暖列表，lookup 兼容单值', () => {
  const s = createSticky();
  s.bind('k1', 'a');
  assert.deepEqual(s.recent('k1'), ['a']);
  assert.equal(s.lookup('k1'), 'a');
  // 换账号 = promote：新 front + 原 front 降为 fallback
  s.bind('k1', 'b');
  assert.deepEqual(s.recent('k1'), ['b', 'a']);
  // 回到 a：b 落 fallback
  s.bind('k1', 'a');
  assert.deepEqual(s.recent('k1'), ['a', 'b']);
  // 重复 bind 不产生重复项
  s.bind('k1', 'a');
  assert.deepEqual(s.recent('k1'), ['a', 'b']);
  // 暖列表上限：默认 3
  s.bind('k1', 'c');
  s.bind('k1', 'd');
  assert.deepEqual(s.recent('k1'), ['d', 'c', 'a'], 'b 被挤出（最旧 fallback）');
  // 空键 / 空 uid
  assert.equal(s.bind('', 'x'), false);
  assert.equal(s.bind('k2', ''), false);
  assert.deepEqual(s.recent('missing'), []);
});

test('sticky：TTL 过期后 recent 清空、lookup 返回 null', () => {
  let t = 1000000;
  const s = createSticky({ ttlMs: 1000, now: () => t });
  s.bind('k', 'a');
  t += 2000;
  assert.deepEqual(s.recent('k'), []);
  assert.equal(s.lookup('k'), null);
});

test('channel-pool：front 不可用时先试暖 fallback（不丢前缀缓存），并 promote 重排', async () => {
  pool.revive();
  channelPool._stickyClear();
  // 两个健康账号 a=1, b=2（workbuddy 通道）
  for (const id of [1, 2]) {
    pool.noteSuccess(`workbuddy:${id}`);
  }
  const accounts = [{ id: 1 }, { id: 2 }];
  const sessionKey = 'sk-warm-1';
  // 第一轮：粘住 1（sticky 空表走池轮询，选中即 bind front）
  const sel1 = channelPool.pickCandidate('workbuddy', accounts, { sessionKey });
  assert.ok(sel1, '第一轮应选中一个账号');
  const first = sel1.uid;
  const second = first === 'workbuddy:1' ? 'workbuddy:2' : 'workbuddy:1';
  channelPool.release(sel1.uid);
  // 第二轮：池轮询粘回同一账号（单值语义回归）
  const sel2 = channelPool.pickCandidate('workbuddy', accounts, { sessionKey });
  assert.equal(sel2.uid, first, '健康时会话粘住同一账号');
  channelPool.release(sel2.uid);
  // front 被硬冷却 → 暖列表里只剩另一个账号，应直接选中它（而不是返回 null 或全清重排）
  pool.noteError(first, { kind: 'hard', message: 'quota exhausted' });
  const sel3 = channelPool.pickCandidate('workbuddy', accounts, { sessionKey });
  assert.ok(sel3, 'front 冷却后仍有暖 fallback 可用');
  assert.equal(sel3.uid, second, '应落到会话的暖 fallback（另一个账号）');
  channelPool.release(sel3.uid);
  // promote 重排：新 front 是 second，first 降为 fallback——恢复后暖副本仍在
  // （sticky 内部状态不可直接窥视，行为断言见下：冷却未恢复时继续粘 fallback）
  const sel4 = channelPool.pickCandidate('workbuddy', accounts, { sessionKey });
  assert.equal(sel4.uid, second, '冷却未恢复时继续粘 fallback');
  channelPool.release(sel4.uid);
  channelPool._stickyClear();
});
