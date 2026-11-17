// test/unit/checkin-makeup.test.js - 今日补签的判定（node:test，纯函数）
//
// 2026-11-16 调研 P1-8。锁两件事：
//   ① `plan()`：**谁今天还没签**（账本 / lastCheckin 两条证据、窗口、ids 过滤、停用）
//   ② `shouldCatchUp()`：每日定时任务该不该补跑（进程晚启动 / 机器睡眠的场景）
//
// 全部用本地时间构造函数造时间戳——`ledger.dayOf` 按本机时区取日期，
// 用 UTC 字符串会整体错一天（账本那边已经踩过）。
const { test } = require('node:test');
const assert = require('assert');
const makeup = require('../../src/traework/makeup');
const ledger = require('../../src/checkin-ledger');

/** 本地时间戳 */
function at(y, m, d, hh, mm) {
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}
const DAY = at(2026, 11, 16, 0, 0);
const dayStr = ledger.dayOf(DAY);

const acc = (o) => Object.assign({ id: 1, nickname: '号A', enabled: true }, o);

test('windowState：09:17 之前不开、窗口内开、23:30 之后关', () => {
  assert.strictEqual(makeup.windowState({ now: at(2026, 11, 16, 9, 16) }).open, false);
  assert.match(makeup.windowState({ now: at(2026, 11, 16, 9, 16) }).reason, /未到补签窗口/);
  assert.strictEqual(makeup.windowState({ now: at(2026, 11, 16, 9, 17) }).open, true);
  assert.strictEqual(makeup.windowState({ now: at(2026, 11, 16, 23, 30) }).open, true);
  const over = makeup.windowState({ now: at(2026, 11, 16, 23, 31) });
  assert.strictEqual(over.open, false);
  assert.match(over.reason, /已过/);
});

test('plan：账本今天有行 → 已签（两条证据的第一条）', () => {
  const p = makeup.plan({
    accounts: [acc({ id: 1 })],
    rows: [{ channel: 'traework', account_id: 1, at: at(2026, 11, 16, 9, 20), source: 'claim' }],
    now: at(2026, 11, 16, 12, 0),
  });
  assert.strictEqual(p.due.length, 0);
  assert.strictEqual(p.skipped[0].reason, 'already');
  assert.match(p.skipped[0].detail, /签到记录/);
  assert.strictEqual(p.day, dayStr);
});

test('plan：source=already 的行也算签过（用户在 TRAE 客户端签的）', () => {
  const p = makeup.plan({
    accounts: [acc({ id: 1 })],
    rows: [{ channel: 'traework', account_id: 1, at: at(2026, 11, 16, 8, 0), source: 'already' }],
    now: at(2026, 11, 16, 12, 0),
  });
  assert.strictEqual(p.due.length, 0);
});

test('plan：账本没行但 lastCheckin 是今天 → 已签（第二条证据）', () => {
  const p = makeup.plan({
    accounts: [acc({ id: 1, lastCheckin: at(2026, 11, 16, 7, 30) })],
    rows: [],
    now: at(2026, 11, 16, 12, 0),
  });
  assert.strictEqual(p.due.length, 0);
  assert.match(p.skipped[0].detail, /lastCheckin/);
});

test('plan：昨天的账本行/昨天 lastCheckin 都不算今天签过', () => {
  const p = makeup.plan({
    accounts: [acc({ id: 1, lastCheckin: at(2026, 11, 15, 9, 30) })],
    rows: [{ channel: 'traework', account_id: 1, at: at(2026, 11, 15, 9, 20) }],
    now: at(2026, 11, 16, 12, 0),
  });
  assert.strictEqual(p.due.length, 1, '今天还没签，应进 due');
  assert.deepStrictEqual(p.due[0].id, 1);
});

test('plan：窗口未开/已过 → 不产生 due，原因写明（不静默为空）', () => {
  const before = makeup.plan({ accounts: [acc({ id: 1 })], rows: [], now: at(2026, 11, 16, 8, 0) });
  assert.strictEqual(before.due.length, 0);
  assert.strictEqual(before.skipped[0].reason, 'outside_window');
  assert.match(before.skipped[0].detail, /未到补签窗口/);
  assert.strictEqual(before.counts.outside, 1);

  const after = makeup.plan({ accounts: [acc({ id: 1 })], rows: [], now: at(2026, 11, 16, 23, 59) });
  assert.strictEqual(after.due.length, 0);
  assert.match(after.skipped[0].detail, /已过/);
});

test('plan：ids 过滤只算指定账号（其余不出现）', () => {
  const p = makeup.plan({
    accounts: [acc({ id: 1 }), acc({ id: 2, nickname: '号B' })],
    rows: [], ids: [2], now: at(2026, 11, 16, 12, 0),
  });
  assert.deepStrictEqual(p.due.map((d) => d.id), [2]);
  assert.strictEqual(p.skipped.length, 0);
});

test('plan：停用账号跳过并写明原因（不参与签到，但也不冒充"已签"）', () => {
  const p = makeup.plan({
    accounts: [acc({ id: 1, enabled: false })], rows: [], now: at(2026, 11, 16, 12, 0),
  });
  assert.strictEqual(p.due.length, 0);
  assert.strictEqual(p.skipped[0].reason, 'disabled');
  assert.strictEqual(p.counts.disabled, 1);
});

test('plan：别的通道的账本行不算（账本是共用文件）', () => {
  const p = makeup.plan({
    accounts: [acc({ id: 1 })],
    rows: [{ channel: 'qoder', account_id: 1, at: at(2026, 11, 16, 9, 20) }],
    now: at(2026, 11, 16, 12, 0),
  });
  assert.strictEqual(p.due.length, 1, 'Qoder 签过不等于 TRAE 签过');
});

test('shouldCatchUp：未开启 / 时间没到 / 今天已跑 → 不补', () => {
  const now = at(2026, 11, 16, 12, 0);
  assert.strictEqual(makeup.shouldCatchUp({ enabled: false, now, lastRunDay: '' }).run, false);
  assert.match(makeup.shouldCatchUp({ enabled: false, now }).reason, /未开启/);

  const early = makeup.shouldCatchUp({ enabled: true, hour: 9, minute: 17, now: at(2026, 11, 16, 9, 10), lastRunDay: '' });
  assert.strictEqual(early.run, false);
  assert.match(early.reason, /还没到/);

  const ran = makeup.shouldCatchUp({ enabled: true, hour: 9, minute: 17, now, lastRunDay: dayStr });
  assert.strictEqual(ran.run, false);
  assert.match(ran.reason, /已经跑过/);
});

test('shouldCatchUp：时间点已过且今天没跑过 → 补跑（进程晚启动/睡眠的核心场景）', () => {
  const cu = makeup.shouldCatchUp({
    enabled: true, hour: 9, minute: 17, now: at(2026, 11, 16, 12, 0), lastRunDay: '2026-11-15',
  });
  assert.strictEqual(cu.run, true);
  assert.match(cu.reason, /补跑/);
  assert.strictEqual(cu.day, dayStr);
  // 边界：正好到点也算（>= 触发）
  assert.strictEqual(makeup.shouldCatchUp({
    enabled: true, hour: 9, minute: 17, now: at(2026, 11, 16, 9, 17), lastRunDay: '',
  }).run, true);
});
