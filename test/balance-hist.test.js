// test/balance-hist.test.js - 余额流水账本单测（施工包 C）
//
// 覆盖：首见建基线不误报、带符号 Delta 留痕、无变动不落盘、脏数据护栏、
// 时间线倒序/过滤/早停、jsonl 轮转跨代查询、重启基线恢复、曲线降采样、
// 消耗速率、多进程追加。
// 全部走 tmp 目录与注入时钟，不碰真实 data/。
const { tmpDir } = require('./helpers/tmpdir');
process.env.DUMATE_ADMIN_DATA = tmpDir('dumate-balancehist-shared');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const balanceHist = require('../src/balance-hist');

function tmpdir() {
  return tmpDir('dumate-balancehist');
}

const T = new Date(2026, 9, 25, 14, 0).getTime();

function inst(opts = {}) {
  return balanceHist.create({ dir: tmpdir(), now: () => T, ...opts });
}

test('首见建基线（delta=null 行），变动留痕带符号', () => {
  const h = inst();
  const base = h.observe({ account: 'a', balance: 100, source: 'manual' });
  assert.equal(base.delta, null);
  assert.equal(base.before, null);
  assert.equal(base.after, 100);

  const up = h.observe({ account: 'a', balance: 120, source: 'checkin', ts: T + 1000 });
  assert.equal(up.delta, 20);
  assert.equal(up.before, 100);
  assert.equal(up.after, 120);

  assert.equal(h.observe({ account: 'a', balance: 120, ts: T + 2000 }), null, '无变动不落盘');

  const down = h.observe({ account: 'a', balance: 90, source: 'chat', ts: T + 3000 });
  assert.equal(down.delta, -30);

  const { rows } = h.timeline({ account: 'a' });
  assert.deepEqual(rows.map((r) => r.balance), [90, 120, 100]); // 最新在前
  assert.deepEqual(rows.map((r) => r.delta), [-30, 20, null]);
});

test('脏数据护栏：|Delta| 超限只挪基线不留痕', () => {
  const h = inst();
  h.observe({ account: 'a', balance: 100 });
  const dirty = h.observe({ account: 'a', balance: 100 + 2000000, ts: T + 1 });
  assert.equal(dirty, null, '超限变动不留痕');
  const { rows } = h.timeline({ account: 'a' });
  assert.equal(rows.length, 1, '只有首条基线行');
  assert.equal(h.baselinesView().get('a'), 100 + 2000000, '基线已挪到新值');
  // 恢复正常量级后继续留痕
  const ok = h.observe({ account: 'a', balance: 100 + 2000000 + 10, ts: T + 2 });
  assert.equal(ok.delta, 10);
});

test('无效输入拒绝：非有限余额 / 空对象', () => {
  const h = inst();
  assert.equal(h.observe(null), null);
  assert.equal(h.observe({ account: 'a', balance: 'NaN' }), null);
  assert.equal(h.observe({ account: 'a', balance: Number.POSITIVE_INFINITY }), null);
});

test('时间线：limit、from 早停、source 过滤', () => {
  const h = inst();
  h.observe({ account: 'a', balance: 100, source: 'checkin', ts: T });
  h.observe({ account: 'a', balance: 110, source: 'keepalive', ts: T + 1000 });
  h.observe({ account: 'a', balance: 105, source: 'chat', ts: T + 2000 });
  h.observe({ account: 'b', balance: 500, source: 'manual', ts: T + 3000 });

  assert.equal(h.timeline({ account: 'a', limit: 2 }).rows.length, 2);
  assert.deepEqual(
    h.timeline({ account: 'a', limit: 1 }).rows.map((r) => r.balance),
    [105],
  );
  // from 界：只要有一条比 from 早，更旧的整段不再扫
  const r = h.timeline({ account: 'a', from: T + 1500 });
  assert.deepEqual(r.rows.map((x) => x.balance), [105]);
  assert.equal(r.hasMore, false);
  // source 精确过滤
  assert.deepEqual(
    h.timeline({ account: 'a', source: 'keepalive' }).rows.map((x) => x.balance),
    [110],
  );
  // 未知账号为空
  assert.deepEqual(h.timeline({ account: 'zz' }).rows, []);
});

test('jsonl 轮转后时间线仍跨代可查', () => {
  // 轮转只保留一代（.old 覆盖写），6 条正好分两代：更早的随上一代被覆盖，
  // 断言只锁「两代内的都能查到、顺序正确」。
  const h = inst({ maxBytes: 300 }); // 每行约 103 字节，写满 3 条就轮转
  for (let i = 0; i < 6; i++) {
    h.observe({ account: 'a', balance: i, ts: T + i * 1000 });
  }
  const all = h.timeline({ limit: 0 });
  assert.equal(all.rows.length, 6);
  assert.equal(all.rows[0].balance, 5, '最新在前');
  assert.equal(all.rows[5].balance, 0, '最旧的也能查到（来自 .old 代）');
  assert.equal(all.hasMore, false);

  assert.equal(h.timeline({ limit: 3 }).rows.length, 3);
  assert.equal(h.timeline({ limit: 3 }).hasMore, true);
});

test('重启后基线从文件恢复，不误报 Delta', () => {
  const dir = tmpdir();
  const a = balanceHist.create({ dir, now: () => T });
  a.observe({ account: 'acc', balance: 100, source: 'manual' });
  a.observe({ account: 'acc', balance: 130, source: 'checkin', ts: T + 1000 });

  const b = balanceHist.create({ dir, now: () => T + 5000 });
  assert.equal(b.baselinesView().get('acc'), 130, '基线=文件里该账号最后一行');
  assert.equal(b.observe({ account: 'acc', balance: 130, ts: T + 6000 }), null, '同值不落盘');
  const e = b.observe({ account: 'acc', balance: 160, ts: T + 7000 });
  assert.equal(e.delta, 30);
  assert.equal(e.before, 130);
});

test('refreshTail：跨进程基线增量——完整首行采纳（轮转后单行更新不误报 Delta）', () => {
  const dir = tmpdir();
  const file = path.join(dir, balanceHist.FILE_NAME);
  const a = balanceHist.create({ dir, now: () => T });
  a.observe({ account: 'r1', balance: 100 });
  // 模拟轮转后另一进程写入的唯一一行更新：新文件的首行就是完整行
  fs.writeFileSync(
    file,
    `${JSON.stringify({ ts: T + 5000, account: 'r1', balance: 200, delta: 100, before: 100, after: 200, source: 'other', channel: '' })}\n`,
    'utf8',
  );
  const e = a.observe({ account: 'r1', balance: 210, ts: T + 6000 });
  assert.equal(e.delta, 10, '基线已被他进程的 200 刷新，不得拿旧基线 100 算出 +110');
  assert.equal(e.before, 200);
});

test('refreshTail：窗口内首段为半行时跳过，其后完整行照常采纳', () => {
  const dir = tmpdir();
  const file = path.join(dir, balanceHist.FILE_NAME);
  const a = balanceHist.create({ dir, now: () => T }); // 文件还不存在，基线空
  // 首行超长（>64KB 窗口）：窗口起点必切在其内部，首段是半行
  fs.writeFileSync(
    file,
    `${'X'.repeat(70000)}\n${JSON.stringify({ ts: T, account: 'r2', balance: 55, source: 'other' })}\n`,
    'utf8',
  );
  const e = a.observe({ account: 'r2', balance: 60, ts: T + 1 });
  assert.equal(e.delta, 5, '半行跳过、其后完整行成为基线');
  assert.equal(e.before, 55);
});

test('curve：升序曲线、基线行入图、超点数降采样', () => {
  const h = inst();
  const balances = [100, 80, 90, 60, 70];
  balances.forEach((balance, i) => {
    h.observe({ account: 'a', balance, ts: T + i * 1000 });
  });
  const full = h.curve({ account: 'a' });
  assert.equal(full.total, 5);
  assert.deepEqual(full.points.map((p) => p.balance), balances); // 升序含基线行

  const small = h.curve({ account: 'a', maxPoints: 3 });
  assert.deepEqual(small.points.map((p) => p.balance), [100, 90, 70]); // step=2 + 末点
  assert.equal(small.total, 5);
});

test('rate：消耗速率按窗口汇总带符号 Delta', () => {
  const h = inst({ now: () => T + 3600000 });
  const seq = [
    [T, 100, 'manual'],          // 基线
    [T + 1000, 80, 'chat'],      // -20
    [T + 2000, 90, 'checkin'],   // +10
    [T + 3000, 60, 'chat'],      // -30
    [T + 3600000, 70, 'checkin'],// +10（窗口边缘）
  ];
  for (const [ts, balance, source] of seq) {
    h.observe({ account: 'a', balance, source, ts });
  }
  const r = h.rate({ account: 'a', windowMs: 3600000, from: T });
  assert.equal(r.consumed, 50);
  assert.equal(r.gained, 20);
  assert.equal(r.net, -30);
  assert.equal(r.samples, 4); // 基线行不计入
  assert.equal(r.consumed_per_hour, 50); // 窗口恰好 1 小时
});

test('多进程追加：两个实例写同一目录互不干扰', () => {
  const dir = tmpdir();
  const a = balanceHist.create({ dir, now: () => T });
  const b = balanceHist.create({ dir, now: () => T });
  a.observe({ account: 'x', balance: 10, ts: T });
  b.observe({ account: 'x', balance: 20, ts: T + 1000 });
  a.observe({ account: 'x', balance: 30, ts: T + 2000 });
  b.observe({ account: 'y', balance: 5, ts: T + 3000 });

  const reader = balanceHist.create({ dir, now: () => T + 4000 });
  const { rows } = reader.timeline({ limit: 0 });
  assert.deepEqual(rows.map((r) => `${r.account}:${r.balance}`), [
    'y:5', 'x:30', 'x:20', 'x:10',
  ]);
});

test('共享实例走 DUMATE_ADMIN_DATA 目录', () => {
  const e = balanceHist.observe({ account: 'shared-probe', balance: 42, source: 'test' });
  assert.ok(e, '共享实例写出流水');
  const { rows } = balanceHist.timeline({ account: 'shared-probe' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].balance, 42);
  assert.ok(fs.existsSync(path.join(process.env.DUMATE_ADMIN_DATA, balanceHist.FILE_NAME)));
});
