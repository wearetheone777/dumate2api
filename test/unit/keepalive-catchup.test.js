// test/unit/keepalive-catchup.test.js - 重启补跑判据（shouldCatchup）离线测试
//
// 背景（2026-11-06，清单项「签到补签兜底」，借鉴 AIAutomator 的睡眠唤醒补签）：
// keepalive 的 timer 在睡眠唤醒后会自动到期补跑（Node 定时器语义），
// 真正的漏跑场景是**进程没在跑**（关机/重启）——重启后 schedule() 若只排
// 下一个时点，今天就漏了。shouldCatchup 判定「今天时点已过 && 今天没跑过」；
// 补跑的幂等由三层既有机制兜底（签到接口 already / grants 去重 / running 互斥）。
const test = require('node:test');
const assert = require('node:assert');

const { internals } = require('../../src/keepalive');
const { shouldCatchup } = internals;

// 2026-11-06 是周五；22:30 = 时点（keepalive 默认）
const DAY = new Date('2026-11-06T00:00:00').getDate();
const at = (h, m) => new Date(2026, 10, DAY, h, m, 0).getTime();

test('时点已过 + 今天没跑过 → 补跑', () => {
  assert.strictEqual(shouldCatchup(at(23, 0), { enabled: true, hour: 22, minute: 30 }, null), true);
  assert.strictEqual(shouldCatchup(at(22, 31), { enabled: true, hour: 22, minute: 30 }, 0), true);
});

test('时点未到不补；恰好等于时点要补（排程已翻到明天）', () => {
  assert.strictEqual(shouldCatchup(at(10, 0), { enabled: true, hour: 22, minute: 30 }, null), false,
    '时点未到，正常排程覆盖');
  // computeNextRunAt 的 `at <= now` 分支会把「恰好在时点上」的排程翻到明天——
  // 不补的话今天真漏，所以此刻必须补
  assert.strictEqual(shouldCatchup(at(22, 30), { enabled: true, hour: 22, minute: 30 }, null), true,
    '等于时点：排程翻明天，今天靠补跑');
  assert.strictEqual(shouldCatchup(at(22, 31), { enabled: true, hour: 22, minute: 30 }, 0), true);
});

test('今天已经跑过 → 不补（上次运行是今天任意时刻）', () => {
  // lastRunAt 在时点之后（正常轮跑完）
  assert.strictEqual(
    shouldCatchup(at(23, 0), { enabled: true, hour: 22, minute: 30 }, at(22, 40)), false,
    '正常轮已跑');
  // lastRunAt 在时点之前但同一天（catchup 跑过 / 手动触发过）
  assert.strictEqual(
    shouldCatchup(at(23, 0), { enabled: true, hour: 22, minute: 30 }, at(9, 0)), false,
    '当天早些时候跑过也不补');
});

test('昨天跑过、今天没跑 → 补', () => {
  const last = new Date(2026, 10, DAY - 1, 22, 40).getTime();
  assert.strictEqual(shouldCatchup(at(23, 0), { enabled: true, hour: 22, minute: 30 }, last), true);
});

test('排程未启用 → 永不补（新排程不悄悄自启的纪律）', () => {
  assert.strictEqual(shouldCatchup(at(23, 0), { enabled: false, hour: 22, minute: 30 }, null), false);
  assert.strictEqual(shouldCatchup(at(23, 0), null, null), false);
});
