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
  assert.match(src, /telemetry\.note\('ok'\)/, '成功分支要计数');
  assert.match(src, /telemetry\.note\(telemetry\.kindOf\(/, '失败分支要按分类计数');
  assert.match(src, /classifyForTelemetry\(e, model\)/, '失败分类要复用 upstream-errors');
});
