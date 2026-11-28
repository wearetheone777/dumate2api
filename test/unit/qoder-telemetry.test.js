// test/unit/qoder-telemetry.test.js - 风控信号遥测（P1-11）
//
// 调研出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P1-11「`/health` 风控信号遥测」。
//
// 要回答的问题：「Qoder 现在是被限流、在排队，还是账号坏了？」三个状态在
// 客户端看起来完全一样（都要等），处置却完全不同（等 vs 换号/重登）。
//
// 五条口径：
//   1. 三类信号分开计数：queued（信封型排队）/ throttled（调用配额）/ rejected
//   2. 判据**复用 upstream-errors**，不另写一套正则（两套必然漂移）
//   3. 环形桶：高并发下内存不随流量线性增长；过期桶被清理
//   4. `waitOnly` 保守：有 1 条成功就不降级，样本不足也不降级
//   5. 计数只用于观测，绝不参与选号（埋点是单向的）
//
// 运行：node --test test/unit/qoder-telemetry.test.js
const test = require('node:test');
const assert = require('node:assert');

const telemetry = require('../../src/qoder/telemetry');

// 真实信封原文（实测自 2026-10-23~27）
const QUEUE_ENVELOPE = '{"code":"10605","message":"{\\"isQueued\\":true,\\"modelKey\\":\\"dfmodel\\",'
  + '\\"queueCount\\":0,\\"retryAfterSeconds\\":30,\\"serviceAvailable\\":false,\\"subCode\\":\\"RESOURCE_LIMIT\\"}"}';
const CALLCOUNT_ENVELOPE = '{"code":"10605","message":"{\\"isQueued\\":true,\\"modelKey\\":\\"dfmodel\\",'
  + '\\"queueCount\\":2410,\\"waitTime\\":66,\\"serviceAvailable\\":true,\\"subCode\\":\\"CALL_COUNT_LIMIT\\"}"}';
const POLICY_TEXT = 'DataInspectionFailed: 内容审核未通过';

test.afterEach(() => telemetry._resetForTest());

test('kindOf：信封型排队 → queued，调用配额限流 → throttled', () => {
  const ue = require('../../src/upstream-errors');
  const a = ue.classify({ status: 403, message: QUEUE_ENVELOPE, model: 'dfmodel' });
  assert.strictEqual(telemetry.kindOf({ ...a, throttled: true }), 'queued');
  const b = ue.classify({ status: 403, message: CALLCOUNT_ENVELOPE, model: 'dfmodel' });
  assert.strictEqual(telemetry.kindOf({ ...b, throttled: true }), 'throttled');
});

test('kindOf：审核拒绝 → rejected（换号无用，不是「等」）', () => {
  const ue = require('../../src/upstream-errors');
  const c = ue.classify({ status: 500, message: POLICY_TEXT });
  assert.strictEqual(telemetry.kindOf({ ...c, policy: true }), 'rejected');
});

test('kindOf：模型不可用 → rejected；空输入不抛', () => {
  const ue = require('../../src/upstream-errors');
  const c = ue.classify({ status: 403, message: 'model not available', model: 'x' });
  assert.strictEqual(telemetry.kindOf({ ...c, throttled: false }), 'rejected');
  assert.strictEqual(telemetry.kindOf(null), 'rejected');
});

test('note + snapshot：三类分开计数，waitRatio 只算「等」类', () => {
  telemetry.note('ok');
  telemetry.note('queued', { queueType: 'p3' });
  telemetry.note('throttled');
  telemetry.note('rejected');
  const s = telemetry.snapshot();
  assert.strictEqual(s.total, 4);
  assert.strictEqual(s.ok, 1);
  assert.strictEqual(s.queued, 1);
  assert.strictEqual(s.throttled, 1);
  assert.strictEqual(s.rejected, 1);
  assert.strictEqual(s.waitRatio, 0.5, '(1+1)/4');
  assert.strictEqual(s.lastQueueType, 'p3');
});

test('snapshot：窗口内 0 条时 waitRatio 是 null，不是 0', () => {
  const s = telemetry.snapshot();
  assert.strictEqual(s.total, 0);
  assert.strictEqual(s.waitRatio, null, '没有样本 ≠ 等待比例 0');
  assert.ok(s.since > 0, 'since 要给出（进程启动时刻）');
});

test('环形桶：过期桶被清理，内存不随历史流量增长', () => {
  const now = Date.now();
  // 造 100 个「不同桶」的历史记录（每桶间隔 1 分钟，远超 12 桶窗口）
  for (let i = 0; i < 100; i++) {
    telemetry.note('ok', { now: now - (100 - i) * 60 * 1000 });
  }
  const s = telemetry.snapshot(now);
  // 只应保留最近 10 分钟内的桶
  assert.ok(s.total <= telemetry.BUCKETS * 1, `窗口内不该有 ${s.total} 条（桶数上限 ${telemetry.BUCKETS}）`);
  // 桶数据结构本身也被裁剪
  const fresh = telemetry.snapshot(now);
  assert.ok(fresh.total <= 12);
});

test('waitOnly：全「等」类且无成功 → true；出现 1 条成功 → false', () => {
  for (let i = 0; i < 6; i++) telemetry.note(i % 2 ? 'queued' : 'throttled');
  assert.strictEqual(telemetry.waitOnly(), true, '6 条全是等类 → 通道没坏，是上游让等');

  telemetry.note('ok');
  assert.strictEqual(telemetry.waitOnly(), false, '有 1 条成功就说明通道是通的，不降级');
});

test('waitOnly：样本不足不降级（宁可探活报红一次，也不藏真故障）', () => {
  telemetry.note('queued');
  telemetry.note('queued');
  assert.strictEqual(telemetry.waitOnly(), false, '2 条不足以判断');
  assert.strictEqual(telemetry.waitOnly({ minSamples: 2 }), true, '显式放宽阈值后成立');
});

test('waitOnly：有 rejected 时不判「只是在等」', () => {
  for (let i = 0; i < 6; i++) telemetry.note('queued');
  telemetry.note('rejected');
  assert.strictEqual(telemetry.waitOnly(), false, '审核拒绝/模型不可用不是「等一等就好」');
});

test('note 永不抛：脏入参也不影响调用方', () => {
  assert.doesNotThrow(() => telemetry.note('ok', null));
  assert.doesNotThrow(() => telemetry.note(undefined));
  assert.doesNotThrow(() => telemetry.note('queued', { queueType: 12345 }));
});

test('qoder/index 真的会喂遥测（接线回归：不能只写模块不接线）', () => {
  // 只读源码判据：send() 的成功/失败分支都必须调 telemetry.note。
  // 这条用例防的是「模块写好了、全库无调用方」——本仓库已经吃过这个亏
  // （WorkBuddy 的 webagent.dailyActivity 代码齐全却从没被调用）。
  const src = require('fs').readFileSync(
    require('path').resolve(__dirname, '../../src/qoder/index.js'), 'utf8');
  assert.match(src, /telemetry\.note\('ok', scopeOf\(account, model\)\)/, '成功分支要带作用域计数');
  assert.match(src, /telemetry\.note\(telemetry\.kindOf\(/, '失败分支要按分类计数');
  assert.match(src, /classifyForTelemetry\(e, model\)/, '失败分类要复用 upstream-errors');
});


// ---- P1-5 排队观察 ----

test('observationSnapshot：按 (area, account, model) 隔离，reason 恒 unknown', () => {
  const now = Date.now();
  telemetry.note('queued', { area: 'cn', accountId: 1, model: 'dfmodel', queueType: 'p7', now });
  telemetry.note('queued', { area: 'cn', accountId: 2, model: 'dfmodel', queueType: 'p1', now });
  telemetry.note('queued', { area: 'global', accountId: 1, model: 'dfmodel', queueType: 'p9', now });
  telemetry.note('queued', { area: 'cn', accountId: 1, model: 'gfmodel', queueType: 'p0', now });
  const s = telemetry.observationSnapshot(now);
  assert.strictEqual(s.total, 4);
  assert.strictEqual(s.windowMs, telemetry.OBSERVE_TTL_MS);
  const row = s.rows.find((r) => r.account === 1 && r.model === 'dfmodel' && r.area === 'cn');
  assert.strictEqual(row.queueType, 'p7');
  assert.strictEqual(row.queued, 1);
  for (const r of s.rows) assert.strictEqual(r.reason, 'unknown');
});

test('observationSnapshot：并发记账按作用域累加，queueType 非法归 unknown', () => {
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    telemetry.note('queued', { area: 'cn', accountId: 3, model: 'gfmodel', queueType: 'p2', now });
  }
  for (let i = 0; i < 3; i++) {
    telemetry.note('throttled', { area: 'cn', accountId: 3, model: 'gfmodel', now });
  }
  for (let i = 0; i < 2; i++) {
    telemetry.note('rejected', { area: 'cn', accountId: 3, model: 'gfmodel', queueType: 'q9', now });
  }
  const s = telemetry.observationSnapshot(now);
  const row = s.rows.find((r) => r.account === 3 && r.model === 'gfmodel');
  assert.strictEqual(row.queued, 5);
  assert.strictEqual(row.throttled, 3);
  assert.strictEqual(row.rejected, 2);
  assert.strictEqual(row.queueType, 'p2', '最后一个合法排队类型');
  // 只有非法 queueType 时记 unknown
  telemetry.note('queued', { area: 'cn', accountId: 9, model: 'x', queueType: 'p10', now });
  const bad = telemetry.observationSnapshot(now).rows.find((r) => r.account === 9);
  assert.strictEqual(bad.queueType, 'unknown');
});

test('observationSnapshot：成功只清匹配作用域，别的账号/模型不受影响', () => {
  const now = Date.now();
  telemetry.note('queued', { area: 'cn', accountId: 1, model: 'dfmodel', queueType: 'p3', now });
  telemetry.note('queued', { area: 'cn', accountId: 2, model: 'dfmodel', queueType: 'p5', now });
  telemetry.note('ok', { area: 'cn', accountId: 1, model: 'dfmodel', now });
  const s = telemetry.observationSnapshot(now);
  const hit = s.rows.find((r) => r.account === 1);
  const other = s.rows.find((r) => r.account === 2);
  assert.strictEqual(hit.queued, 0);
  assert.strictEqual(hit.throttled, 0);
  assert.strictEqual(hit.queueType, 'unknown');
  assert.strictEqual(hit.ok, 1);
  assert.ok(hit.clearedAt > 0);
  assert.strictEqual(other.queued, 1, '别的账号不受影响');
  assert.strictEqual(other.queueType, 'p5');
});

test('observationSnapshot：TTL 过期行不出现在快照里', () => {
  const now = Date.now();
  telemetry.note('queued', { area: 'cn', accountId: 1, model: 'dfmodel', queueType: 'p3', now: now - telemetry.OBSERVE_TTL_MS - 1000 });
  telemetry.note('queued', { area: 'cn', accountId: 2, model: 'dfmodel', queueType: 'p4', now });
  const s = telemetry.observationSnapshot(now);
  assert.strictEqual(s.total, 1);
  assert.strictEqual(s.rows[0].account, 2);
});

test('observationSnapshot：有界 200 条，超过丢最老', () => {
  const now = Date.now();
  for (let i = 0; i < telemetry.OBSERVE_MAX + 25; i++) {
    telemetry.note('queued', { area: 'cn', accountId: i, model: 'm', queueType: 'p1', now: now + i });
  }
  const s = telemetry.observationSnapshot(now + telemetry.OBSERVE_MAX + 25);
  assert.strictEqual(s.total, telemetry.OBSERVE_MAX);
  assert.ok(s.rows.every((r) => r.account >= 25));
});

test('observationSnapshot：note 缺字段不造观察行；ok 没有旧观察也不造行', () => {
  const now = Date.now();
  telemetry.note('ok', { now });
  telemetry.note('queued', { now });
  assert.strictEqual(telemetry.observationSnapshot(now).total, 0);
});
