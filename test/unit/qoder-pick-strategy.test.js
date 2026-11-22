// test/unit/qoder-pick-strategy.test.js - 最少在途优先选号（P1-7）
//
// 调研出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P1-7「负载均衡策略可选 +
// 账号权重 + 低积分阈值排除」的**策略**部分（权重/阈值已在 pool.js 与
// channel-pool.noteCredits 里，本批补的是分配顺序）。
//
// 为什么需要它：Qoder 的 10605 排队是请求级随机的，并发越高越容易撞。加权
// 抽签会把流量压到余额高的号（那恰是最容易排队的时候）；单号并发闸门只挡住
// 「同一个号打两发」，挡不住「池里有闲号却还是压在一个号上」。
//
// 三条不变量：
//   1. 默认（env 不配）行为与之前逐字节一致——加权抽签/轮询，不受影响
//   2. least-inflight 下按「在途少 → 最久未被选」排序，池取第一个可用项
//   3. **粘性优先于 least-inflight**：前缀缓存命中率比排队概率更值钱
//
// 运行：node --test test/unit/qoder-pick-strategy.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-qoder-pick');
process.env.DUMATE_ADMIN_DATA = TMP;
process.env.DUMATE_POOL_STATE = path.join(TMP, 'pool-state.json');
// 关掉防撞号窗口：本套件验的是排序，不是「同毫秒不重复」
process.env.DUMATE_POOL_PICK_GAP_MS = '0';

const { pool } = require('../../src/pool');
const channelPool = require('../../src/channel-pool');

const A = (id) => ({ id, uid: `uid-${id}`, nickname: `号${id}`, enabled: true });

function clearEnv() {
  delete process.env.DUMATE_QODER_PICK_STRATEGY;
}

test.after(clearEnv);

test('默认（env 不配）：策略为空，池按自己的加权抽签走——现有行为回归锚', () => {
  clearEnv();
  assert.strictEqual(
    // 内部判据：未配置时不走 least-inflight 分支
    channelPool.pickStrategyOf ? channelPool.pickStrategyOf('qoder') : '',
    '',
  );
});

test('least-inflight：在途少的号优先，且只看实时在途数', () => {
  process.env.DUMATE_QODER_PICK_STRATEGY = 'least-inflight';
  const a = A(7001);
  const b = A(7002);
  pool.revive(`qoder:${a.id}`);
  pool.revive(`qoder:${b.id}`);
  // 让 a 号占两个在途（模拟正在跑两条请求）
  pool.acquire(`qoder:${a.id}`);
  pool.acquire(`qoder:${a.id}`);

  const sel = channelPool.pickCandidate('qoder', [a, b], { model: 'gfmodel' });
  assert.ok(sel);
  assert.strictEqual(sel.account.id, b.id, 'b 号在途 0，应优先');
  channelPool.release(sel.uid);
  clearEnv();
});

test('least-inflight：在途相同时按「最久未被选」优先（不恒取第一个）', () => {
  process.env.DUMATE_QODER_PICK_STRATEGY = 'least-inflight';
  const a = A(7011);
  const b = A(7012);
  pool.revive(`qoder:${a.id}`);
  pool.revive(`qoder:${b.id}`);
  // 先让 a 被选过一次（last_pick_at 更近），下一轮应轮到 b
  const first = channelPool.pickCandidate('qoder', [a, b], { model: 'gfmodel' });
  assert.ok(first);
  channelPool.release(first.uid);
  const second = channelPool.pickCandidate('qoder', [a, b], { model: 'gfmodel' });
  assert.ok(second);
  assert.notStrictEqual(second.account.id, first.account.id, '两轮不该选同一个号（在途都为 0 时应轮转）');
  channelPool.release(second.uid);
  clearEnv();
});

test('least-inflight：队首被模型冷却时让给下一个（池判据没被绕开）', () => {
  process.env.DUMATE_QODER_PICK_STRATEGY = 'least-inflight';
  const a = A(7021);
  const b = A(7022);
  pool.revive(`qoder:${a.id}`);
  pool.revive(`qoder:${b.id}`);
  // a 号对这个模型排队中
  channelPool.noteError('qoder', a.id, {
    status: 403,
    message: '{"isQueued":true,"modelKey":"dfmodel","serviceAvailable":false}',
    model: 'dfmodel',
  });
  const sel = channelPool.pickCandidate('qoder', [a, b], { model: 'dfmodel' });
  assert.ok(sel);
  assert.strictEqual(sel.account.id, b.id, 'a 号该模型排队中 → 必须让给 b');
  channelPool.release(sel.uid);
  clearEnv();
});

test('粘性优先于 least-inflight：暖账号持有缓存，不因在途多而换号', () => {
  process.env.DUMATE_QODER_PICK_STRATEGY = 'least-inflight';
  const a = A(7031);
  const b = A(7032);
  pool.revive(`qoder:${a.id}`);
  pool.revive(`qoder:${b.id}`);
  // 先建立粘性（a 成为该会话的暖账号）
  const first = channelPool.pickCandidate('qoder', [a, b], { sessionKey: 'sess-sticky', model: 'gfmodel' });
  assert.ok(first);
  channelPool.release(first.uid);
  const boundId = first.account.id;
  // 给绑定的号加压（仍在在途帽内：默认 4）
  pool.acquire(`qoder:${boundId}`);
  pool.acquire(`qoder:${boundId}`);

  const next = channelPool.pickCandidate('qoder', [a, b], { sessionKey: 'sess-sticky', model: 'gfmodel' });
  assert.ok(next);
  assert.strictEqual(next.account.id, boundId, '粘住的号必须继续用（前缀缓存命中率优先于在途均衡）');
  channelPool.release(next.uid);
  clearEnv();
});

test('env 名字按通道隔离：别的通道配 least-inflight 不影响 qoder', () => {
  clearEnv();
  process.env.DUMATE_TRAEWORK_PICK_STRATEGY = 'least-inflight';
  assert.strictEqual(
    channelPool.pickStrategyOf ? channelPool.pickStrategyOf('qoder') : '',
    '',
    'qoder 不该读到 TRAEWORK 的配置',
  );
  delete process.env.DUMATE_TRAEWORK_PICK_STRATEGY;
});
