// test/keepalive.test.js - 保活与余额联动调度（施工包 B）离线单测
//
// 覆盖：调度触发、解冻闭环、错峰间隔、并发上限、ctx 可取消、pool 接口假设层。
// 零依赖（node:test），不打真实上游：adapter 与 pool 全部注入假件，
// 数据目录在 require 模块前重定向到临时目录（admin/store 加载时读该变量）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须先重定向数据目录再 require 模块
const { tmpDir } = require('./helpers/tmpdir');
const TMP = tmpDir('dumate-keepalive-test');
process.env.DUMATE_ADMIN_DATA = TMP;

const keepalive = require('../src/keepalive');
const { computeNextRunAt, normalizePool, sleepCtx, armAt } = keepalive.internals;

test.afterEach(() => {
  keepalive.stop();          // 清掉任何遗留定时器与进行中的一轮
  keepalive.setAdapters(null);
  keepalive.setPool(undefined);
});

async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

// 造一个假 web adapter：uid 与 A 包 web-pool 同键位（裸 String(id)）
function fakeAdapter({ accounts: list, refresh, balance, checkin } = {}) {
  return {
    channel: 'web',
    list: () => list || [],
    uid: (a) => String(a.id),
    name: (a) => `acct${a.id}`,
    refresh: refresh || (async () => ({ ok: true })),
    balance: balance || (async () => ({ ok: true, remain: 1 })),
    ...(checkin ? { checkin } : {}),
  };
}

test('computeNextRunAt：未到点排今天，过了排明天，抖动只后延不提前', () => {
  const now = new Date('2026-10-25T10:00:00').getTime();
  const cfg = { hour: 22, minute: 30, jitter_minutes: 30 };
  const expect = new Date('2026-10-25T22:30:00').getTime();
  // rng()=0 → 无抖动，正好落在时点上
  assert.strictEqual(computeNextRunAt(now, cfg, () => 0), expect);
  // rng()=0.5 → 后延一半抖动窗口（15 分钟），绝不提前
  assert.strictEqual(computeNextRunAt(now, cfg, () => 0.5), expect + 15 * 60 * 1000);
  assert.strictEqual(computeNextRunAt(now, cfg, () => 0.999), expect + 29 * 60 * 1000 + 58200);
  // 时点已过 → 顺延到明天同一时点（+抖动）
  const later = new Date('2026-10-25T23:00:00').getTime();
  assert.strictEqual(computeNextRunAt(later, cfg, () => 0), expect + 24 * 60 * 60 * 1000);
  // 抖动为 0 → 精确时点
  assert.strictEqual(computeNextRunAt(now, { hour: 3, minute: 7, jitter_minutes: 0 }, () => 0.5),
    new Date('2026-10-26T03:07:00').getTime());
});

test('解冻闭环（假设形态 revive 兜底）：冷却账号余额回正 → revive；余额 0 / 不在冷却 / 查不到的不动', async () => {
  const now = Date.now();
  const revived = [];
  const healthy = [];
  const pool = {
    entries() {
      return [
        { uid: '1', cooldown: { kind: 'soft', until: now + 60000 } },
        { uid: '2', cooldown: { kind: 'soft', until: now + 60000 } },
        { uid: '3', cooldown: null },
        { uid: '4', cooldown: { kind: 'soft', until: now + 60000 } },
        { uid: '9', cooldown: { kind: 'soft', until: now + 60000 } },  // 池里有但 adapter 没有
      ];
    },
    revive(uid, reason) { revived.push({ uid, reason }); },
    noteHealthy(uid) { healthy.push(uid); },
  };
  const adapters = [fakeAdapter({
    accounts: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    refresh: async (a) => a.id === 4
      ? { ok: false, error: '换票失败', expire_at: now + 3600 * 1000 }   // 续不上且快过期 → 预警
      : { ok: true, expire_at: now + 2 * 3600 * 1000 },                  // 续上了 → 不预警
    balance: async (a) => [
      { ok: true, remain: 5 },        // web:1 冷却 + 余额>0 → 解冻
      { ok: true, remain: 0 },        // web:2 冷却但余额 0 → 不动
      { ok: true, remain: 3 },        // web:3 不在冷却 → 不动
      { ok: false, error: 'x' },      // web:4 冷却但余额查不到 → 不动（不猜）
    ][a.id - 1],
  })];

  const r = await keepalive.runOnce('test', { adapters, pool, per_account_delay_ms: 0, checkin: false });

  assert.deepStrictEqual(revived.map((x) => x.uid), ['1']);
  assert.ok(/余额 5/.test(revived[0].reason), `reason: ${revived[0].reason}`);
  assert.strictEqual(r.unfrozen_count, 1);
  assert.strictEqual(r.pool_mode, 'pool');
  // 刷新成功的记健康（4 号刷新失败不记）
  assert.deepStrictEqual(healthy.sort(), ['1', '2', '3']);
  // 过期预警只给「没续上且落在窗口内」的号
  const warns = r.results.filter((x) => x.expire_warn);
  assert.deepStrictEqual(warns.map((x) => x.uid), ['4']);
  assert.ok(Math.abs(warns[0].expire_warn.left_hours - 1) < 0.1);
});

test('解冻闭环（A 包真名 reenableIfCredits）：只解硬冷却，软冷却/健康号不动', async () => {
  const now = Date.now();
  const calls = [];
  const healthy = [];
  const pool = {
    snapshot() {
      // A 包 status 行形态：id 为 String，cooling/cooldown_until 现算
      return [
        { id: '1', state: 'cooling', cooling: true, cooldown_kind: 'hard', cooldown_until: now + 60000, until: now + 60000 },
        { id: '2', state: 'cooling', cooling: true, cooldown_kind: 'soft', cooldown_until: now + 60000, until: now + 60000 },
        { id: '3', state: 'healthy', cooling: false, cooldown_until: 0, until: 0 },
      ];
    },
    noteSuccess(id) { healthy.push(id); },
    reenableIfCredits(id, credits) {
      calls.push([id, credits]);
      return { unfrozen: id === '1' };   // 软冷却/健康号 unfrozen=false 是 A 的语义
    },
  };
  const r = await keepalive.runOnce('test', {
    adapters: [fakeAdapter({
      accounts: [{ id: 1 }, { id: 2 }, { id: 3 }],
      balance: async () => ({ ok: true, remain: 7 }),
    })],
    pool, per_account_delay_ms: 0, checkin: false,
  });
  assert.deepStrictEqual(healthy.sort(), ['1', '2', '3']);
  // 只有 cooling 行进解冻循环；软冷却行调了 reenableIfCredits 但 unfrozen=false（A 的语义）
  assert.deepStrictEqual(calls, [['1', 7], ['2', 7]]);
  assert.deepStrictEqual(r.unfrozen.map((x) => x.uid), ['1']);
  assert.strictEqual(r.pool_mode, 'pool');
});

test('解冻阈值可配置：balance_threshold 调高后余额不达标不解冻', async () => {
  const now = Date.now();
  const revived = [];
  keepalive.configure({ balance_threshold: 10 });
  try {
    const r = await keepalive.runOnce('test', {
      adapters: [fakeAdapter({ accounts: [{ id: 1 }], balance: async () => ({ ok: true, remain: 5 }) })],
      pool: { entries: () => [{ uid: '1', cooldown: { until: now + 60000 } }], revive: (uid) => revived.push(uid) },
      per_account_delay_ms: 0, checkin: false,
    });
    assert.deepStrictEqual(revived, []);
    assert.strictEqual(r.unfrozen_count, 0);
  } finally {
    keepalive.configure({ balance_threshold: 0 });
  }
});

test('余额阶段并发不超过 sem_cap 且确有并行', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const N = 7;
  const adapters = [fakeAdapter({
    accounts: Array.from({ length: N }, (_, i) => ({ id: i + 1 })),
    balance: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      inFlight--;
      return { ok: true, remain: 1 };
    },
  })];
  const r = await keepalive.runOnce('test', {
    adapters, pool: { entries: () => [] }, per_account_delay_ms: 5, sem_cap: 3, checkin: false,
  });
  assert.strictEqual(r.balance_results.length, N);
  assert.ok(maxInFlight <= 3, `并发峰值 ${maxInFlight} 超过上限 3`);
  assert.ok(maxInFlight >= 2, `并发峰值 ${maxInFlight}，没有形成并行`);
});

test('错峰：刷新阶段账号之间保持配置的串行间隔', async () => {
  const stamps = [];
  const adapters = [fakeAdapter({
    accounts: [{ id: 1 }, { id: 2 }, { id: 3 }],
    refresh: async () => { stamps.push(Date.now()); return { ok: true }; },
  })];
  await keepalive.runOnce('test', { adapters, pool: { entries: () => [] }, per_account_delay_ms: 60, checkin: false });
  assert.strictEqual(stamps.length, 3);
  for (let i = 1; i < stamps.length; i++) {
    assert.ok(stamps[i] - stamps[i - 1] >= 50, `第 ${i} 个间隔只有 ${stamps[i] - stamps[i - 1]}ms`);
  }
});

test('ctx 可取消：stop() 立即中断进行中的一轮', async () => {
  let processed = 0;
  const adapters = [fakeAdapter({
    accounts: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
    refresh: async () => { processed++; return { ok: true }; },
  })];
  const p = keepalive.runOnce('test', { adapters, pool: { entries: () => [] }, per_account_delay_ms: 200, checkin: false });
  await new Promise((r) => setTimeout(r, 60));   // 第一个账号跑完，正睡在账号间隔里
  keepalive.stop();
  const r = await p;
  assert.strictEqual(r.aborted, true);
  assert.ok(processed < 5, `中断前已处理 ${processed} 个`);
  // 中断后不再进入余额阶段
  assert.strictEqual(r.balance_results.length, 0);
  assert.strictEqual(keepalive.state.running, false);
});

test('幂等：进行中的一轮期间重复触发不双跑（already_running）', async () => {
  let refreshCount = 0;
  const adapters = [fakeAdapter({
    accounts: [{ id: 1 }],
    refresh: async () => {
      refreshCount++;
      await new Promise((r) => setTimeout(r, 150));
      return { ok: true };
    },
  })];
  const p1 = keepalive.runOnce('test', { adapters, pool: { entries: () => [] }, per_account_delay_ms: 0, checkin: false });
  // 第一轮仍在跑（refresh 还没返回）时再触发:必须整轮跳过,不得驱动第二轮
  const second = await keepalive.runOnce('test', { adapters, pool: { entries: () => [] }, per_account_delay_ms: 0, checkin: false });
  assert.deepStrictEqual(second, { skipped: 'already_running' });
  await p1;
  assert.strictEqual(refreshCount, 1, '重复触发不得驱动第二轮');
  assert.strictEqual(keepalive.state.running, false);
});

test('sleepCtx：等满返回 true，取消立即返回 false', async () => {
  const token = keepalive.internals.makeToken();
  const t0 = Date.now();
  const full = await sleepCtx(30, token);
  assert.strictEqual(full, true);
  assert.ok(Date.now() - t0 >= 25);
  const token2 = keepalive.internals.makeToken();
  setTimeout(() => token2.abort(), 10);
  const t1 = Date.now();
  const cut = await sleepCtx(10 * 60 * 1000, token2);
  assert.strictEqual(cut, false);
  assert.ok(Date.now() - t1 < 5000, '取消应立即唤醒，不等睡满');
});

test('调度触发：到点自动跑一轮（scheduled）并落结果', async () => {
  const fired = [];
  keepalive.setAdapters([fakeAdapter({
    accounts: [{ id: 9 }],
    refresh: async () => { fired.push(Date.now()); return { ok: true }; },
  })]);
  keepalive.setPool(null);   // scheduled 路径不走真 pool 单例（测试隔离）
  const before = keepalive.state.last_run_at;
  armAt(Date.now() + 400);   // 排程原语：400ms 后触发
  assert.ok(await waitFor(() => keepalive.state.last_run_at !== before), '定时触发未发生');
  assert.strictEqual(keepalive.state.last_result.trigger, 'scheduled');
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(keepalive.state.running, false);
});

test('pool 接口假设层：缺接口降级 stub，有接口正确包装', () => {
  const stub = normalizePool(null);
  assert.strictEqual(stub.mode, 'stub');
  assert.deepStrictEqual(stub.entries(), []);
  stub.revive('x');          // no-op，不抛
  stub.noteHealthy('x');

  const calls = [];
  const wrapped = normalizePool({
    revive(uid, reason) { calls.push([uid, reason]); },
    list() { return [{ uid: 'u1', cooldown: { until: 1 } }]; },
  });
  assert.strictEqual(wrapped.mode, 'pool');
  assert.deepStrictEqual(wrapped.entries(), [{ uid: 'u1', cooldown: { until: 1 } }]);
  wrapped.revive('u1', 'r');
  assert.deepStrictEqual(calls, [['u1', 'r']]);
  wrapped.noteHealthy('u1');   // 未声明 noteHealthy → 静默跳过
});

test('snapshot：pool_mode 反映 A 包对接状态（A 未落=stub，已落=pool）', () => {
  const s = keepalive.snapshot();
  // src/pool.js 已在工作区出现（A 包并行开发）→ 应探到真单例；若 A 移除则回落 stub
  assert.ok(s.pool_mode === 'stub' || s.pool_mode === 'pool', `pool_mode=${s.pool_mode}`);
  assert.ok(Array.isArray(s.rationale) && s.rationale.length >= 3);
});
