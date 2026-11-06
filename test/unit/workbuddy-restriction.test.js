// test/unit/workbuddy-restriction.test.js - 风控连坐状态与跨进程解除信号
//
// 背景（2026-11-06，M2.2）：连坐判定的权威是两个内存 Map（网关进程内），
// 而管理端 9083 是**另一个进程**——它 require 同一个模块会拿到自己的空 Map。
// 所以新增了「落盘观测快照 + 反向解除信号文件」这对跨进程通道。
//
// 本套件锁四件事：
//   1. 连坐触发条件（窗口内不同账号数达阈值才暂停）
//   2. 快照的形状与「过期即不算暂停」
//   3. 解除信号被网关消费后内存与快照都清
//   4. 落盘失败不影响判定（观测不该拖垮热路径）
//
// 运行：node --test test/unit/workbuddy-restriction.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-wb-restriction-'));
process.env.DUMATE_ADMIN_DATA = TMP;
// 显式钉住连坐参数，别让本机环境变量影响断言
process.env.DUMATE_WORKBUDDY_RESTRICTION_WAVE_MIN = '2';
process.env.DUMATE_WORKBUDDY_RESTRICTION_WAVE_WINDOW = '900';
process.env.DUMATE_WORKBUDDY_RESTRICTION_HOLD_SECONDS = '1800';

const wb = require('../../src/workbuddy');

const SNAP = path.join(TMP, 'workbuddy-restriction.json');
const CLEAR = path.join(TMP, 'workbuddy-restriction-clear.json');

function cleanup() {
  wb._restrictionReset();
  for (const f of [SNAP, CLEAR]) { try { fs.unlinkSync(f); } catch (e) { /* 没有更正常 */ } }
}

test('单账号被限制不足以连坐（直到第二个不同账号）', () => {
  cleanup();
  const t1 = wb.noteAccountRestriction('cn', 'uid-a');
  assert.strictEqual(t1, 0, '一个账号不该触发整区域暂停');
  assert.strictEqual(wb.restrictionHoldRemaining('cn'), 0);

  const t2 = wb.noteAccountRestriction('cn', 'uid-b');
  assert.ok(t2 > 0, '第二个不同账号应触发暂停');
  assert.ok(wb.restrictionHoldRemaining('cn') > 0);
  cleanup();
});

test('同一账号重复被限制不累计（按不同 uid 计数）', () => {
  cleanup();
  wb.noteAccountRestriction('cn', 'uid-a');
  wb.noteAccountRestriction('cn', 'uid-a');
  wb.noteAccountRestriction('cn', 'uid-a');
  assert.strictEqual(wb.restrictionHoldRemaining('cn'), 0, '同一 uid 三次仍只是 1 个账号');
  cleanup();
});

test('区域隔离：cn 暂停不影响 global', () => {
  cleanup();
  wb.noteAccountRestriction('cn', 'a');
  wb.noteAccountRestriction('cn', 'b');
  assert.ok(wb.restrictionHoldRemaining('cn') > 0);
  assert.strictEqual(wb.restrictionHoldRemaining('global'), 0);
  cleanup();
});

test('快照形状：config / regions（含 remainingMs）/ events（含 agoMs）', () => {
  cleanup();
  wb.noteAccountRestriction('cn', 'a', Date.now() - 1000);
  wb.noteAccountRestriction('cn', 'b', Date.now() - 500);

  const snap = wb.restrictionSnapshot();
  assert.ok(snap, '触发后应落下快照');
  assert.strictEqual(snap.config.waveMin, 2);
  assert.strictEqual(snap.config.holdMs, 1800 * 1000);
  assert.strictEqual(snap.config.waveWindowMs, 900 * 1000);

  const cn = snap.regions.cn;
  assert.ok(cn, '快照应含 cn 区域');
  assert.ok(cn.until > Date.now(), 'until 应在未来');
  assert.ok(cn.remainingMs > 0);

  const evs = snap.events.cn;
  assert.strictEqual(evs.length, 2, '事件应记两个不同 uid');
  assert.deepStrictEqual(evs.map((e) => e.uid).sort(), ['a', 'b']);
  assert.ok(evs.every((e) => typeof e.agoMs === 'number' && e.agoMs >= 0));
  cleanup();
});

test('windowDays 外的旧事件被剔除（窗口 900s）', () => {
  cleanup();
  const now = Date.now();
  // 第一个事件放到窗口外（901 秒前），再补两个窗口内的 → 应触发暂停
  wb.noteAccountRestriction('cn', 'stale', now - 901 * 1000);
  wb.noteAccountRestriction('cn', 'a', now - 1000);
  const snap1 = wb.restrictionSnapshot();
  assert.strictEqual(snap1.events.cn.length, 2, '写入时旧事件仍会先记录（清理在下次写入时做）');

  const t = wb.noteAccountRestriction('cn', 'b', now);
  assert.ok(t > 0, '窗口内两个不同账号应触发');
  const snap2 = wb.restrictionSnapshot();
  const uids = snap2.events.cn.map((e) => e.uid).sort();
  assert.deepStrictEqual(uids, ['a', 'b'], 'stale 应已被窗口清理掉');
  cleanup();
});

test('restrictionState：内存优先，内存空则回落快照；过期 until 不算暂停', () => {
  cleanup();
  wb.noteAccountRestriction('cn', 'a');
  wb.noteAccountRestriction('cn', 'b');
  const s1 = wb.restrictionState();
  assert.strictEqual(s1.source, 'memory');
  assert.ok(s1.regions.cn);

  // 模拟「管理端进程」：清内存但保留快照文件 → 应回落读文件
  wb._restrictionReset();
  wb.noteAccountRestriction('cn', 'a'); // 只 1 个，不足以连坐，但会写快照
  const snapFile = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  snapFile.regions = { cn: { until: Date.now() + 60000, remainingMs: 60000 } };
  fs.writeFileSync(SNAP, JSON.stringify(snapFile));
  // 直接读文件那层（内存里没有 hold）
  const s2 = wb.restrictionState();
  assert.strictEqual(s2.source, 'snapshot', '内存无 hold 时应回落快照');
  assert.ok(s2.regions.cn.remainingMs > 0);

  // 把 until 改成过去 → 不应再报暂停
  snapFile.regions = { cn: { until: Date.now() - 1000, remainingMs: -1000 } };
  fs.writeFileSync(SNAP, JSON.stringify(snapFile));
  const s3 = wb.restrictionState();
  assert.deepStrictEqual(s3.regions, {}, '过期的 until 不应算作暂停');
  cleanup();
});

test('解除：requestClearRestriction 写信号 + 乐观清快照 + 清本进程内存', () => {
  cleanup();
  wb.noteAccountRestriction('cn', 'a');
  wb.noteAccountRestriction('cn', 'b');
  assert.ok(wb.restrictionHoldRemaining('cn') > 0);

  const r = wb.requestClearRestriction('cn');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.region, 'cn');
  assert.ok(fs.existsSync(CLEAR), '应写下解除信号文件给网关');

  // 乐观更新：快照里立即没有 cn 了
  const snap = wb.restrictionSnapshot();
  assert.ok(!snap.regions.cn, '快照应已乐观清除');
  // 本进程内存也清了
  assert.strictEqual(wb.restrictionHoldRemaining('cn'), 0);
  cleanup();
});

test('解除信号被网关消费：事件与 hold 一起清，信号文件删除', () => {
  cleanup();
  wb.noteAccountRestriction('cn', 'a');
  wb.noteAccountRestriction('cn', 'b');
  // 直接写信号（模拟管理端），不清本进程内存——模拟「网关侧收到别人的请求」。
  // **注意**：不能用 restrictionHoldRemaining 断言「消费前仍在暂停」——它本身
  // 就是消费点（暂停期间调用会顺带 readFile + unlink）。用 restrictionState()，
  // 那条路径只读不消费。
  fs.writeFileSync(CLEAR, JSON.stringify({ region: 'cn', at: Date.now() }));
  const before = wb.restrictionState();
  assert.ok(before.regions.cn, '消费前仍在暂停');

  const consumed = wb.consumeClearSignal();
  assert.strictEqual(consumed, true);
  assert.strictEqual(wb.restrictionHoldRemaining('cn'), 0, '消费后应解除');
  assert.ok(!fs.existsSync(CLEAR), '信号文件应被删除');

  const snap = wb.restrictionSnapshot();
  assert.deepStrictEqual(snap.regions, {}, '快照不应再有暂停区域');
  assert.deepStrictEqual(snap.events, {}, '事件也应清（否则会立刻重新触发连坐）');
  cleanup();
});

test('region 归一：intl 与 global 落到同一区域', () => {
  cleanup();
  const r = wb.requestClearRestriction('intl');
  assert.strictEqual(r.region, 'global', 'intl 应归一成 global');
  const sig = JSON.parse(fs.readFileSync(CLEAR, 'utf8'));
  assert.strictEqual(sig.region, 'global');
  cleanup();
});

test('缺 region 时拒绝而不是静默成功', () => {
  cleanup();
  const r = wb.requestClearRestriction('');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /region/);
  cleanup();
});

test('落盘不可写不影响判定（观测失败不拖垮热路径）', () => {
  cleanup();
  // 把 data 目录指向一个非法路径：快照写不进去
  const good = process.env.DUMATE_ADMIN_DATA;
  process.env.DUMATE_ADMIN_DATA = path.join(TMP, 'no-such-dir', 'deeper');
  try {
    // 不 mkdir 的话 persistRestriction 内部会 mkdir（它能建成），
    // 所以这里改用「把 dataDir 指到一个已存在的文件路径」制造失败
    const blocker = path.join(TMP, 'blocker-file');
    fs.writeFileSync(blocker, 'x');
    process.env.DUMATE_ADMIN_DATA = blocker;

    const t1 = wb.noteAccountRestriction('cn', 'a');
    const t2 = wb.noteAccountRestriction('cn', 'b');
    assert.strictEqual(t1, 0);
    assert.ok(t2 > 0, '落盘失败时连坐判定仍必须生效');
    assert.ok(wb.restrictionHoldRemaining('cn') > 0);
    assert.strictEqual(wb.restrictionSnapshot(), null, '快照读不到时如实返回 null');
  } finally {
    process.env.DUMATE_ADMIN_DATA = good;
    cleanup();
  }
});
