// test/unit/workbuddy-growth-scan.test.js - 任务中心三桶扫描 + 执行队列骨架（P1-7）
//
// 锁四件事（计划原文）：
//   1. 三桶分类 + 不变量 IncompleteTotal == 三桶之和（不漏项）
//   2. scan_state 五态——**401/空 body 绝不能渲染成「没有待办」**（error≠empty）
//   3. skipped_enterprise / skipped_disabled 不打上游（企业号成长体系全拒）
//   4. 执行队列：账号内串行（重复点击 TryLock 拒）、账号间并发、异常也放锁
//
// 运行：node --test test/unit/workbuddy-growth-scan.test.js
const assert = require('assert');
const { test } = require('node:test');

const growth = require('../../src/workbuddy/growth');
const tasks = require('../../src/workbuddy/tasks');

const acc = { id: 5, uid: 'uid-scan', region: 'cn', accessToken: 'tok' };

function stubGrowth(docFn, calls) {
  growth._setRequestImpl((opts, cb) => {
    calls.push({ method: opts.method, path: opts.path });
    const { status, doc } = docFn();
    const body = Buffer.from(JSON.stringify(doc));
    setImmediate(() => cb({
      statusCode: status,
      on(ev, fn) {
        if (ev === 'data') setImmediate(() => fn(body));
        if (ev === 'end') setImmediate(() => fn());
      },
    }));
    return { on() {}, write() {}, end() {}, destroy() {} };
  });
}

test('三桶分类 + 不变量：claimed/过期/无奖励不进桶，locked/mp/普通各归其位', async () => {
  const calls = [];
  stubGrowth(() => ({ status: 200, doc: { code: 0, data: { tasks: [
    { task_code: 'daily_login', task_type: 'single', accept_status: 'unknown', has_reward: true, progress: { current: 0, target: 1 } },   // auto
    { task_code: 'next_tier_task', task_type: 'single', locked: true, accept_status: 'unknown', has_reward: true, progress: { current: 0, target: 1 } }, // locked_auto
    { task_code: 'Sequential_Tasks_1', task_type: 'mp', accept_status: 'unknown', has_reward: true, progress: { current: 0, target: 1 } },  // manual
    { task_code: 'done_one', task_type: 'single', accept_status: 'claimed', has_reward: true, progress: { current: 1, target: 1 } },        // 已领不进桶
    { task_code: 'expired_one', task_type: 'single', accept_status: 'accepted', has_reward: true, valid_end: '2026-01-01 00:00:00', progress: { current: 1, target: 1 } }, // 过期不进桶
    { task_code: 'no_reward', task_type: 'single', accept_status: 'accepted', progress: { current: 0, target: 1 } },                        // 无奖励位不进桶
  ] } } }), calls);
  const r = await growth.scanGrowthTasks('cn', acc, { execution_enabled: false });
  assert.strictEqual(r.scan_state, 'ok');
  assert.deepStrictEqual(r.buckets.auto.map((t) => t.code), ['daily_login']);
  assert.deepStrictEqual(r.buckets.locked_auto.map((t) => t.code), ['next_tier_task']);
  assert.deepStrictEqual(r.buckets.manual.map((t) => t.code), ['Sequential_Tasks_1']);
  assert.strictEqual(r.invariant_ok, true);
  assert.strictEqual(r.incomplete_total, r.buckets.auto.length + r.buckets.locked_auto.length + r.buckets.manual.length,
    '不变量：三桶之和 == incomplete_total（不漏项）');
  assert.strictEqual(r.execution_enabled, false, '执行开关是调用方传的，扫描不读 env');
});

test('全部已领 → empty（真没有待办，与 error 是两回事）', async () => {
  const calls = [];
  stubGrowth(() => ({ status: 200, doc: { code: 0, data: { tasks: [
    { task_code: 'x', task_type: 'single', accept_status: 'claimed', has_reward: true, progress: { current: 1, target: 1 } },
  ] } } }), calls);
  const r = await growth.scanGrowthTasks('cn', acc);
  assert.strictEqual(r.scan_state, 'empty');
  assert.strictEqual(r.incomplete_total, 0);
});

test('401 → error 绝不渲染成「没有待办」（本项的核心）', async () => {
  const calls = [];
  stubGrowth(() => ({ status: 401, doc: { code: 401, msg: 'unauthorized' } }), calls);
  const r = await growth.scanGrowthTasks('cn', acc);
  assert.strictEqual(r.scan_state, 'error');
  assert.strictEqual(r.buckets, null, '读不到就给不出桶，不给空桶冒充');
  assert.strictEqual(r.incomplete_total, null);
  assert.match(r.error, /401/);
});

test('空 body / 非 JSON → error（getJson 解析失败的形状）', async () => {
  // 空 body：statusCode 200 但 body 不是 JSON
  growth._setRequestImpl((opts, cb) => {
    const body = Buffer.from('<html>gateway</html>');
    setImmediate(() => cb({ statusCode: 200, on(ev, fn) { if (ev === 'data') setImmediate(() => fn(body)); if (ev === 'end') setImmediate(() => fn()); } }));
    return { on() {}, write() {}, end() {}, destroy() {} };
  });
  const r = await growth.scanGrowthTasks('cn', acc);
  assert.strictEqual(r.scan_state, 'error', 'HTML 网关页不是任务列表，不能当「没有待办」');
});

test('skipped_enterprise / skipped_disabled：不打上游（calls 计数 0）', async () => {
  const calls = [];
  stubGrowth(() => ({ status: 200, doc: { code: 0, data: { tasks: [] } } }), calls);
  const ent = await growth.scanGrowthTasks('cn', { ...acc, enterpriseId: 'corp-1' });
  assert.strictEqual(ent.scan_state, 'skipped_enterprise');
  const dis = await growth.scanGrowthTasks('cn', acc, { disabled: true });
  assert.strictEqual(dis.scan_state, 'skipped_disabled');
  assert.strictEqual(calls.length, 0, '两种 skip 都不该打上游');
});

test('国际版 manual 桶只给指引（不执行）', async () => {
  const calls = [];
  stubGrowth(() => ({ status: 200, doc: { code: 0, data: { tasks: [
    { task_code: 'Sequential_Tasks_2', task_type: 'mp', accept_status: 'unknown', has_reward: true, progress: { current: 0, target: 1 } },
  ] } } }), calls);
  const r = await growth.scanGrowthTasks('global', { ...acc, region: 'global' });
  assert.strictEqual(r.scan_state, 'ok');
  assert.strictEqual(r.buckets.manual.length, 1);
  assert.match(r.manualNote, /指引/);
});

test('runExclusive：重复点击 TryLock 拒（busy），完成后放锁，异常也放锁', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const p1 = tasks.runExclusive({ id: 42 }, async () => { await gate; return { ok: true, v: 1 }; });
  // 第一次还在跑：同账号再进 → busy
  const p2 = await tasks.runExclusive({ id: 42 }, async () => ({ ok: true, v: 2 }));
  assert.strictEqual(p2.busy, true, '同账号并发 = TryLock 拒');
  assert.strictEqual(p2.ok, false);
  // 不同账号不受影响
  const p3 = await tasks.runExclusive({ id: 43 }, async () => ({ ok: true, v: 3 }));
  assert.strictEqual(p3.ok, true);
  release();
  const r1 = await p1;
  assert.strictEqual(r1.ok, true);
  // 放锁后同账号可再进
  const p4 = await tasks.runExclusive({ id: 42 }, async () => ({ ok: true, v: 4 }));
  assert.strictEqual(p4.ok, true);
  // 异常也放锁
  await tasks.runExclusive({ id: 44 }, async () => { throw new Error('boom'); }).catch(() => {});
  const p5 = await tasks.runExclusive({ id: 44 }, async () => ({ ok: true }));
  assert.strictEqual(p5.ok, true, 'finally 放锁：异常不卡死账号');
});

test('账号间并发（并发峰值 2）、账号内串行语义由锁保证', async () => {
  let active = 0; let peak = 0;
  const fn = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 15));
    active--;
    return { ok: true };
  };
  await Promise.all([
    tasks.runExclusive({ id: 101 }, fn),
    tasks.runExclusive({ id: 102 }, fn),
  ]);
  assert.strictEqual(peak, 2, '两个账号同时执行（账号间并发）');
  assert.deepStrictEqual(tasks.execBusyIds().filter((x) => x === '101' || x === '102'), [], '跑完锁全放');
});
