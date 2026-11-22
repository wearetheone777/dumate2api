// test/usage-agg.test.js - usage-agg 分桶聚合单测（施工包 C）
//
// 覆盖：聚合正确性、\x00 桶键防碰撞、滚动窗口、小时桶折叠幂等、
// 内存上限淘汰、落盘恢复、多进程合并、本地时区桶键、关停开关。
// 全部走 tmp 目录与注入时钟，不碰真实 data/。
const { tmpDir } = require('./helpers/tmpdir');
process.env.DUMATE_ADMIN_DATA = tmpDir('dumate-usageagg-shared');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const usageAgg = require('../src/usage-agg');

function tmpdir() {
  return tmpDir('dumate-usageagg');
}

// 本地 2026-10-25 14:05（固定时刻，避免测试跨小时抖动）
const T = new Date(2026, 9, 25, 14, 5).getTime();

function row(over) {
  return {
    ts: T,
    channel: 'dumate',
    account: 'a1',
    model: 'm1',
    status: 200,
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    ms: 100,
    ...over,
  };
}

test('聚合正确性：请求数/失败数/token 按模型与账号分桶', () => {
  const inst = usageAgg.create({ dir: tmpdir(), persist: false });
  inst.addEntry(row({ model: 'glm', input_tokens: 100, output_tokens: 50, total_tokens: 150, ms: 200 }));
  inst.addEntry(row({ model: 'glm', input_tokens: 10, output_tokens: 5, total_tokens: 15, ms: 100 }));
  inst.addEntry(row({ model: 'sonnet', account: 'a2', status: 500, ms: 300 }));
  inst.addEntry(row({ model: 'x', status: 0, ms: 40 }));

  const s = inst.snapshot({});
  assert.equal(s.totals.requests, 4);
  assert.equal(s.totals.errors, 2); // 500 与 0 都算失败，与面板口径一致
  assert.equal(s.totals.input_tokens, 130); // 100 + 10 + 默认行×2
  assert.equal(s.totals.output_tokens, 65);
  assert.equal(s.totals.total_tokens, 195);
  assert.equal(s.totals.ms_samples, 4);
  assert.equal(s.totals.avg_ms, Math.round((200 + 100 + 300 + 40) / 4));

  const glm = s.by_model.find((r) => r.key === 'glm');
  assert.equal(glm.requests, 2);
  assert.equal(glm.total_tokens, 165);
  const a1 = s.by_account.find((r) => r.key === 'a1');
  assert.equal(a1.requests, 3);
  const a2 = s.by_account.find((r) => r.key === 'a2');
  assert.equal(a2.errors, 1);
  // 同一时序点聚合
  assert.equal(s.series.length, 1);
  assert.equal(s.series[0].scope, 'hour');
  assert.equal(s.series[0].requests, 4);
});

test('total_tokens 缺省时用 input+output 兜底', () => {
  const inst = usageAgg.create({ dir: tmpdir(), persist: false });
  inst.addEntry(row({ input_tokens: 7, output_tokens: 3, total_tokens: undefined }));
  const s = inst.snapshot({});
  assert.equal(s.totals.total_tokens, 10);
});

test('桶键 \\x00 分隔防碰撞（审计修复点 1）', () => {
  const inst = usageAgg.create({ dir: tmpdir(), persist: false });
  // '|' 分隔符下这两条会折进同一桶：'a|b' + 'c' === 'a' + 'b|c'
  inst.addEntry(row({ channel: 'a|b', account: 'c', status: 200 }));
  inst.addEntry(row({ channel: 'a', account: 'b|c', status: 200 }));
  const s = inst.snapshot({});
  assert.equal(s.buckets, 2);
  assert.deepEqual(s.by_channel.map((r) => r.key).sort(), ['a', 'a|b']);
  // 维度值里出现 \x00 本身也会被清洗，不会绕过分隔符
  const inst2 = usageAgg.create({ dir: tmpdir(), persist: false });
  inst2.addEntry(row({ channel: 'a\x00b', account: 'c' }));
  inst2.addEntry(row({ channel: 'a', account: 'b\x00c' }));
  assert.equal(inst2.snapshot({}).buckets, 2);
});

test('滚动窗口：hours 只统计窗口内的小时桶', () => {
  const inst = usageAgg.create({ dir: tmpdir(), persist: false, now: () => T });
  inst.addEntry(row({ ts: T })); // 本地 14 点桶
  inst.addEntry(row({ ts: T - 3 * 3600000, model: 'm0' })); // 11 点桶

  assert.equal(inst.snapshot({ hours: 2 }).totals.requests, 1); // from=13:00
  assert.equal(inst.snapshot({ hours: 4 }).totals.requests, 2); // 整点回溯到 11:00
  assert.equal(inst.snapshot({}).totals.requests, 2);
  // 显式区间按「桶起点入窗」判定：11 点桶起点 11:00 早于 11:05(T-3h)，出局；
  // from 取到 11:00 整（含）即入窗
  assert.equal(inst.snapshot({ from: T - 3 * 3600000, to: T }).totals.requests, 1);
  assert.equal(inst.snapshot({ from: T - 3 * 3600000 - 5 * 60000, to: T }).totals.requests, 2);
  assert.equal(inst.snapshot({ from: T - 2 * 3600000 }).totals.requests, 1);
  // 通道过滤
  assert.equal(inst.snapshot({ channel: 'qwenwork' }).totals.requests, 0);
  assert.equal(inst.snapshot({ channel: 'dumate' }).totals.requests, 2);
});

test('超龄小时桶折叠为日桶且幂等', () => {
  const inst = usageAgg.create({
    dir: tmpdir(),
    persist: false,
    now: () => T,
    hourlyKeepMs: 7 * 86400000,
  });
  inst.addEntry(row({ ts: T - 8 * 86400000, input_tokens: 1, output_tokens: 1, total_tokens: 2 }));
  inst.addEntry(row({ ts: T - 8 * 86400000 - 3600000, input_tokens: 2, output_tokens: 2, total_tokens: 4 }));
  inst.addEntry(row({ ts: T, model: 'fresh' }));

  assert.equal(inst.rollup(T), 2); // 两个超龄小时桶
  const s = inst.snapshot({});
  assert.equal(s.buckets, 2); // 1 日桶 + 1 小时桶
  assert.equal(s.totals.requests, 3);
  assert.equal(s.totals.total_tokens, 6 + 15);
  const day = s.series.find((p) => p.scope === 'day');
  assert.ok(day, '存在日桶时序点');
  assert.equal(day.requests, 2);
  // 幂等：再折叠一遍不多不少
  assert.equal(inst.rollup(T), 0);
  const s2 = inst.snapshot({});
  assert.equal(s2.buckets, 2);
  assert.equal(s2.totals.requests, 3);
});

test('内存有界：超上限先折叠、仍超则淘汰', () => {
  const inst = usageAgg.create({ dir: tmpdir(), persist: false, now: () => T, maxBuckets: 5 });
  for (let i = 0; i < 20; i++) {
    inst.addEntry(row({ model: `m${i}` })); // 同一小时 20 个模型桶
  }
  // 淘汰到 90%（5 * 0.9 = 4），总量有界；同时间片内各桶 scope 相同，
  // 按键序淘汰（确定即可），断言只锁「有界」与「计数一致」。
  assert.equal(inst.describe().buckets, 4);
  const s = inst.snapshot({});
  assert.equal(s.buckets, 4);
  assert.equal(s.totals.requests, 4);
  assert.equal(s.by_model.length, 4);
});

test('落盘与恢复：重启不丢桶', () => {
  const dir = tmpdir();
  const inst = usageAgg.create({ dir, flushMs: 0, now: () => T });
  inst.addEntry(row({ input_tokens: 11, output_tokens: 2, total_tokens: 13 }));
  inst.addEntry(row({ account: 'a2', status: 404 }));
  assert.equal(inst.flushNow(), true);

  const file = path.join(dir, usageAgg.FILE_NAME);
  assert.ok(fs.existsSync(file));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.buckets.length, 2);

  const inst2 = usageAgg.create({ dir, now: () => T });
  const s = inst2.snapshot({});
  assert.equal(s.totals.requests, 2);
  assert.equal(s.totals.input_tokens, 21); // 11 + 默认行的 10
  assert.equal(s.totals.total_tokens, 28); // 13 + 15
  assert.equal(s.totals.errors, 1);
});

test('损坏的落盘文件从容起步', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, usageAgg.FILE_NAME), '{oops not json', 'utf8');
  const inst = usageAgg.create({ dir, now: () => T });
  assert.equal(inst.snapshot({}).totals.requests, 0);
  inst.addEntry(row());
  assert.equal(inst.flushNow(), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, usageAgg.FILE_NAME), 'utf8')).buckets.length, 1);
});

test('多进程合并落盘：flush 采纳他进程的桶', () => {
  const dir = tmpdir();
  const a = usageAgg.create({ dir, now: () => T });
  const b = usageAgg.create({ dir, now: () => T }); // b 启动时磁盘还没有 a 的数据
  a.addEntry(row({ model: 'from-a' }));
  assert.equal(a.flushNow(), true);
  b.addEntry(row({ model: 'from-b' }));
  assert.equal(b.flushNow(), true); // b 合并了磁盘上 a 的桶

  const c = usageAgg.create({ dir, now: () => T });
  const s = c.snapshot({});
  assert.equal(s.totals.requests, 2);
  assert.deepEqual(s.by_model.map((r) => r.key).sort(), ['from-a', 'from-b']);
});

test('桶键用本地时区而非 UTC（审计修复点 3）', () => {
  const inst = usageAgg.create({ dir: tmpdir(), persist: false });
  // 本地 2026-09-01 00:30：UTC 桶键会落到 08-31 或 08-31T16
  inst.addEntry(row({ ts: new Date(2026, 8, 1, 0, 30).getTime() }));
  const s = inst.snapshot({});
  assert.equal(s.series[0].t, '2026-09-01T00');
  assert.equal(s.since, '2026-09-01T00');
});

test('防抖落盘：dirty 才写、间隔可调', () => {
  const dir = tmpdir();
  const inst = usageAgg.create({ dir, flushMs: 20, now: () => T });
  const file = path.join(dir, usageAgg.FILE_NAME);
  inst.addEntry(row());
  assert.ok(!fs.existsSync(file), '防抖窗口内未落盘');
  inst.dispose();
});

test('共享实例走 DUMATE_ADMIN_DATA 目录', () => {
  usageAgg.addEntry(row({ model: 'shared-probe' }));
  const d = usageAgg.describe();
  assert.ok(d.buckets >= 1);
  assert.equal(path.dirname(d.file), process.env.DUMATE_ADMIN_DATA);
  assert.equal(usageAgg.flushNow(), true);
  assert.ok(fs.existsSync(path.join(process.env.DUMATE_ADMIN_DATA, usageAgg.FILE_NAME)));
});
