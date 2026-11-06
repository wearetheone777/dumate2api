// test/unit/workbuddy-output-probe.test.js - 模型输出上限探针（M2.5）的纯函数与落盘
//
// 探针的真实请求路径不在线上测（烧积分且慢）；这里锁三件可离线验证的事：
//   1. judgeStep 三态判定的边界（at_least / clamped / below / inconclusive）
//   2. stepsFor 按模型表上限裁剪阶梯
//   3. 落盘形状与 isStale 30 天口径
// 运行：node --test test/unit/workbuddy-output-probe.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-wb-probe-'));
process.env.DUMATE_ADMIN_DATA = TMP;

const probe = require('../../src/workbuddy/output-probe');

test('judgeStep：finish=length 且追平 → at_least', () => {
  assert.strictEqual(probe.judgeStep(4096, 4000, 'length'), 'at_least');
  assert.strictEqual(probe.judgeStep(4096, 4096, 'length'), 'at_least');
});

test('judgeStep：finish=length 但明显不足 → clamped（上游静默钳制）', () => {
  assert.strictEqual(probe.judgeStep(4096, 1600, 'length'), 'clamped');
  // 89% 边界：低于 90% 算 clamped
  assert.strictEqual(probe.judgeStep(4096, 3600, 'length'), 'clamped');
  assert.strictEqual(probe.judgeStep(4096, 3700, 'length'), 'at_least');
});

test('judgeStep：自然收尾（stop）→ below，不冒充上限', () => {
  assert.strictEqual(probe.judgeStep(65536, 800, 'stop'), 'below');
});

test('judgeStep：无输出 / 非 length 非 stop → inconclusive', () => {
  assert.strictEqual(probe.judgeStep(4096, 0, 'length'), 'inconclusive');
  assert.strictEqual(probe.judgeStep(4096, null, 'length'), 'inconclusive');
  assert.strictEqual(probe.judgeStep(4096, 1000, undefined), 'inconclusive');
});

test('stepsFor：按模型表上限裁剪阶梯', () => {
  assert.deepStrictEqual(probe.stepsFor(200000), [4096, 16384, 32768, 65536]);
  assert.deepStrictEqual(probe.stepsFor(65536), [4096, 16384, 32768, 65536]);
  assert.deepStrictEqual(probe.stepsFor(16384), [4096, 16384]);
  assert.deepStrictEqual(probe.stepsFor(2048), [4096], '上限低于最小档时保底一档');
  assert.deepStrictEqual(probe.stepsFor(null), [4096, 16384, 32768, 65536], '表取不到按 65536');
});

test('saveProbe / loadProbes：原子落盘与覆盖', () => {
  const row1 = { model: 'm1', region: 'cn', verdict: 'at_least', atLeast: 16384, ts: Date.now() };
  assert.strictEqual(probe.saveProbe(row1), true);
  const row2 = { model: 'm1', region: 'global', verdict: 'clamped', clamped: 4096, ts: Date.now() };
  probe.saveProbe(row2);
  const doc = probe.loadProbes();
  assert.strictEqual(doc['m1|cn'].verdict, 'at_least');
  assert.strictEqual(doc['m1|global'].verdict, 'clamped');
  // 同键覆盖
  probe.saveProbe({ ...row1, verdict: 'clamped', clamped: 8192 });
  assert.strictEqual(probe.loadProbes()['m1|cn'].clamped, 8192);
});

test('isStale：30 天口径', () => {
  assert.strictEqual(probe.isStale({ ts: Date.now() }), false);
  assert.strictEqual(probe.isStale({ ts: Date.now() - 29 * 86400 * 1000 }), false);
  assert.strictEqual(probe.isStale({ ts: Date.now() - 31 * 86400 * 1000 }), true);
  assert.strictEqual(probe.isStale({}), true, '无 ts 视为过期');
  assert.strictEqual(probe.isStale(null), true);
});
