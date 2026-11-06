// test/unit/channel-gate.test.js - 通道级节奏闸门（在途帽覆盖 + 最小请求间隔）
//
// DEV-CHECKLIST #15 / qoder2api-hub 风控文档融合（2026-11-04）：两层闸门
// 都默认关——env 不配时行为与之前逐字节一致（默认行为回归锚）。判据：
//   - 最小间隔看「上次 pick 时刻」（约束发射节奏，不是请求时长）；
//   - 间隔内的跳过与 busy 同语义（不惩罚账号）。
// 运行：node --test test/unit/channel-gate.test.js
const assert = require('assert');
const { test } = require('node:test');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-gate-'));
process.env.DUMATE_ADMIN_DATA = TMP;
process.env.DUMATE_POOL_STATE = path.join(TMP, 'pool-state.json');

const { pool } = require('../../src/pool');
const channelPool = require('../../src/channel-pool');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function account(id) {
  return { id, uid: `uid-gate-${id}`, nickname: `闸门${id}`, region: 'cn', enabled: true };
}

test('默认（env 不配）：单账号连续两次 pick 都成功——现有行为回归锚', () => {
  const a = account(9801);
  pool.revive(`qoder:${a.id}`);
  const s1 = channelPool.pickCandidate('qoder', [a], { model: 'gfmodel' });
  assert.ok(s1, '第一次应选中');
  const s2 = channelPool.pickCandidate('qoder', [a], { model: 'gfmodel', exclude: [] });
  assert.ok(s2, '默认在途帽 4，第二次也应选中');
  channelPool.release(s1.uid);
  channelPool.release(s2.uid);
  pool.revive(`qoder:${a.id}`);
});

test('MIN_INTERVAL_MS：间隔内跳过（busy 语义，不惩罚），过间隔恢复', async () => {
  process.env.DUMATE_QODER_MIN_INTERVAL_MS = '250';
  const a = account(9802);
  pool.revive(`qoder:${a.id}`);
  try {
    const s1 = channelPool.pickCandidate('qoder', [a], { model: 'gfmodel' });
    assert.ok(s1, '第一次应选中');
    channelPool.release(s1.uid);
    // 间隔内：跳过该账号（busy 不是账号的错）
    const s2 = channelPool.pickCandidate('qoder', [a], { model: 'gfmodel' });
    assert.strictEqual(s2, null, '最小间隔内应跳过');
    const av = channelPool.availability('qoder', [a], { model: 'gfmodel' });
    assert.strictEqual(av.usable, false);
    assert.strictEqual(av.busy, true, '间隔内应报 busy（不惩罚）');
    // 过间隔后恢复
    await sleep(300);
    const s3 = channelPool.pickCandidate('qoder', [a], { model: 'gfmodel' });
    assert.ok(s3, '过间隔后应恢复可选');
    channelPool.release(s3.uid);
    // 释放后**立刻**再查仍应 busy——判据是「上次 pick 时刻」，刚发完一个
    // 当然还在间隔内；这是闸门语义（约束发射节奏），不是实现缺陷
    const avBusy = channelPool.availability('qoder', [a], { model: 'gfmodel' });
    assert.strictEqual(avBusy.usable, false, '间隔内 availability 不报可用');
    await sleep(300);
    const av2 = channelPool.availability('qoder', [a], { model: 'gfmodel' });
    assert.strictEqual(av2.usable, true, '过间隔后 availability 应报可用');
  } finally {
    // 断言失败也要清 env——它是进程级的，残留会串扰后续用例
    delete process.env.DUMATE_QODER_MIN_INTERVAL_MS;
    pool.revive(`qoder:${a.id}`);
  }
});

test('INFLIGHT_MAX：通道级在途帽覆盖池默认', () => {
  process.env.DUMATE_QODER_INFLIGHT_MAX = '1';
  const a = account(9803);
  pool.revive(`qoder:${a.id}`);
  try {
    const s1 = channelPool.pickCandidate('qoder', [a], { model: 'gfmodel' });
    assert.ok(s1, '第一个名额应选中');
    const s2 = channelPool.pickCandidate('qoder', [a], { model: 'gfmodel' });
    assert.strictEqual(s2, null, '在途帽=1 时第二个名额应拿不到');
    const av = channelPool.availability('qoder', [a], { model: 'gfmodel' });
    assert.strictEqual(av.busy, true, '在途满应报 busy');
    channelPool.release(s1.uid);
    const s3 = channelPool.pickCandidate('qoder', [a], { model: 'gfmodel' });
    assert.ok(s3, '释放后应恢复可选');
    channelPool.release(s3.uid);
  } finally {
    delete process.env.DUMATE_QODER_INFLIGHT_MAX;
    pool.revive(`qoder:${a.id}`);
  }
});

test('双闸门并存：另一通道不受影响（env 按通道隔离）', () => {
  process.env.DUMATE_QODER_MIN_INTERVAL_MS = '60000';
  const a = account(9804);
  pool.revive(`qwenwork:${a.id}`);
  const s1 = channelPool.pickCandidate('qwenwork', [a], { model: 'pro' });
  assert.ok(s1, 'qoder 的间隔闸门不应影响 qwenwork');
  const s2 = channelPool.pickCandidate('qwenwork', [a], { model: 'pro' });
  assert.ok(s2, 'qwenwork 无间隔配置，连发可选');
  channelPool.release(s1.uid);
  channelPool.release(s2.uid);
  delete process.env.DUMATE_QODER_MIN_INTERVAL_MS;
  pool.revive(`qwenwork:${a.id}`);
});
