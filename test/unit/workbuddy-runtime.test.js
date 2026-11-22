// test/unit/workbuddy-runtime.test.js - 连坐参数运行期配置（P2-11）
//
// 出处：docs/WORKBUDDY-FUSION.md P2-11（hub Unreleased「连坐暂停卡片：自定义
// 时长、保存更短时长即时截断倒计时」）。此前四个参数是 index.js 模块加载时
// 读一次的 env——改一次要重启网关。
//
// 本套件锁四件事：
//   1. 白名单清洗：磁盘宽容（未知键丢弃）/ 接口提交严格（抛错），越界不静默吞
//   2. env 仍是默认值来源（只设 env 的部署行为不变）
//   3. 热生效：Store 之后下一次 Load 立刻是新值（mtime 失效重读）
//   4. **改短 hold 立即截断现有倒计时**（不需要等下一次触发、不需要信号文件）
//
// 运行：node --test test/unit/workbuddy-runtime.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-wb-runtime');
process.env.DUMATE_ADMIN_DATA = TMP;
// env 默认值钉死，别让本机环境变量影响断言
process.env.DUMATE_WORKBUDDY_RESTRICTION_WAVE_MIN = '2';
process.env.DUMATE_WORKBUDDY_RESTRICTION_WAVE_WINDOW = '900';
process.env.DUMATE_WORKBUDDY_RESTRICTION_HOLD_SECONDS = '1800';
process.env.DUMATE_WORKBUDDY_RESTRICTED_ROTATE_MAX = '0';

const runtime = require('../../src/workbuddy/runtime');
const wb = require('../../src/workbuddy');

function resetAll() {
  for (const f of [runtime.filePath(), `${runtime.filePath()}.tmp`]) {
    try { fs.unlinkSync(f); } catch (e) { /* 没有更正常 */ }
  }
  try { fs.unlinkSync(path.join(TMP, 'workbuddy-restriction.json')); } catch (e) { /* 同上 */ }
  try { fs.unlinkSync(path.join(TMP, 'workbuddy-restriction-clear.json')); } catch (e) { /* 同上 */ }
  runtime._resetForTest();
  wb._restrictionReset();
}

test('无配置文件时回落到 env 默认值（只设 env 的部署行为不变）', () => {
  resetAll();
  const c = runtime.Load();
  assert.deepStrictEqual(c.restriction, {
    waveMin: 2, waveWindowSec: 900, holdSeconds: 1800, restrictedRotateMax: 0,
  });
});

test('sanitize：磁盘宽容（未知键丢弃、越界回默认）', () => {
  const disk = runtime.sanitize({ restriction: { waveMin: 3, nope: 1 }, unknown: true });
  assert.deepStrictEqual(disk, { restriction: { waveMin: 3 } });
  // 越界值在宽容模式下被丢弃（不是写成 0 或 1）
  assert.deepStrictEqual(runtime.sanitize({ restriction: { waveMin: 999 } }), { restriction: {} });
  assert.deepStrictEqual(runtime.sanitize({ restriction: { holdSeconds: -1 } }), { restriction: {} });
  assert.deepStrictEqual(runtime.sanitize(null), {});
});

test('sanitize strict：未知键与非整数一律抛错（不静默吞）', () => {
  assert.throws(() => runtime.sanitize({ bogus: 1 }, { strict: true }), /未知配置键/);
  assert.throws(() => runtime.sanitize({ restriction: { waveMin: 0 } }, { strict: true }), /waveMin/);
  assert.throws(() => runtime.sanitize({ restriction: { holdSeconds: 100000 } }, { strict: true }), /holdSeconds/);
  assert.throws(() => runtime.sanitize({ restriction: { waveWindowSec: 1.5 } }, { strict: true }), /waveWindowSec/);
});

test('Store 落盘 + 热生效：下一次 Load 立刻是新值（不用重启）', () => {
  resetAll();
  const out = runtime.Store({ restriction: { holdSeconds: 60, waveMin: 3 } });
  assert.strictEqual(out.config.restriction.holdSeconds, 60);
  assert.deepStrictEqual(out.changed, { restriction: { holdSeconds: 60, waveMin: 3 } });
  // 落盘内容正确
  const disk = JSON.parse(fs.readFileSync(runtime.filePath(), 'utf8'));
  assert.strictEqual(disk.restriction.holdSeconds, 60);
  // 未提交的字段保持 env 默认
  assert.strictEqual(disk.restriction.waveWindowSec, 900);
  // 模拟「另一个进程」：清缓存后重读
  runtime._resetForTest();
  assert.strictEqual(runtime.Load().restriction.holdSeconds, 60);
});

test('Store 的 patch 语义：只改传入的字段，其余保留', () => {
  resetAll();
  runtime.Store({ restriction: { holdSeconds: 100 } });
  runtime.Store({ restriction: { waveMin: 5 } });
  const c = runtime.Load().restriction;
  assert.strictEqual(c.holdSeconds, 100, '上一次的改动不能被覆盖回默认');
  assert.strictEqual(c.waveMin, 5);
});

test('Load 返回私有拷贝（调用方改了不污染下一个读者）', () => {
  resetAll();
  const a = runtime.Load();
  a.restriction.holdSeconds = 1;
  assert.strictEqual(runtime.Load().restriction.holdSeconds, 1800);
});

test('连坐判定用运行期配置：waveMin 提高后不再触发暂停', () => {
  resetAll();
  assert.strictEqual(wb.noteAccountRestriction('cn', 'a'), 0);
  assert.ok(wb.noteAccountRestriction('cn', 'b') > 0, '默认 waveMin=2 应触发');

  wb._restrictionReset();
  runtime.Store({ restriction: { waveMin: 3 } });
  wb._restrictionReset();
  wb.noteAccountRestriction('cn', 'a');
  assert.strictEqual(wb.noteAccountRestriction('cn', 'b'), 0, '阈值提到 3 后两个号不足以连坐');
  assert.ok(wb.noteAccountRestriction('cn', 'c') > 0, '第三个号才触发');
});

test('**改短 hold 立即截断现有倒计时**（hub P2-11 的核心行为）', () => {
  resetAll();
  runtime.Store({ restriction: { holdSeconds: 1800 } });
  wb.noteAccountRestriction('cn', 'a');
  wb.noteAccountRestriction('cn', 'b');
  const before = wb.restrictionHoldRemaining('cn');
  assert.ok(before > 1700 * 1000, `初始应在 1800s 量级，实际 ${before}`);

  // 面板把 30 分钟改成 2 分钟
  runtime.Store({ restriction: { holdSeconds: 120 } });
  const after = wb.restrictionHoldRemaining('cn');
  assert.ok(after <= 120 * 1000 + 50, `改短后倒计时应立即收到 120s 内，实际 ${after}`);
  assert.ok(after > 0, '仍是暂停态（只是变短）');
  assert.ok(after < before, '必须比改之前短');
});

test('holdSeconds=0 彻底关闭连坐暂停（仍记事件供观测）', () => {
  resetAll();
  runtime.Store({ restriction: { holdSeconds: 0 } });
  wb._restrictionReset();
  wb.noteAccountRestriction('cn', 'a');
  const t = wb.noteAccountRestriction('cn', 'b');
  assert.strictEqual(t, 0, '关掉后不再触发整区域暂停');
  assert.strictEqual(wb.restrictionHoldRemaining('cn'), 0);
  // 事件仍在快照里——关掉护栏不等于蒙眼
  const snap = wb.restrictionSnapshot();
  assert.strictEqual(snap.events.cn.length, 2, '「哪些号被限制」仍要可观测');
});

test('restrictionState 的 config 反映运行期值（界面读的是实况）', () => {
  resetAll();
  runtime.Store({ restriction: { waveMin: 4, holdSeconds: 45, waveWindowSec: 60, restrictedRotateMax: 2 } });
  const st = wb.restrictionState();
  assert.strictEqual(st.config.waveMin, 4);
  assert.strictEqual(st.config.holdMs, 45000);
  assert.strictEqual(st.config.waveWindowMs, 60000);
  assert.strictEqual(st.config.restrictedRotateMax, 2);
});

test('快照里的旧倒计时回读时按当前配置再夹一次（管理端不显示过期数字）', () => {
  resetAll();
  runtime.Store({ restriction: { holdSeconds: 1800 } });
  wb.noteAccountRestriction('cn', 'a');
  wb.noteAccountRestriction('cn', 'b');
  const snapPath = path.join(TMP, 'workbuddy-restriction.json');
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  assert.ok(snap.regions.cn && snap.regions.cn.until > Date.now());

  // 模拟「网关还没重写快照，但配置已改短」：清内存（管理端进程视角）+ 改配置
  wb._restrictionReset();
  fs.writeFileSync(snapPath, JSON.stringify(snap));
  runtime.Store({ restriction: { holdSeconds: 90 } });

  const st = wb.restrictionState();
  assert.strictEqual(st.source, 'snapshot');
  assert.ok(st.regions.cn, '仍在暂停');
  assert.ok(st.regions.cn.remainingMs <= 90 * 1000 + 50,
    `应按当前 holdSeconds 夹到 90s 内，实际 ${st.regions.cn.remainingMs}`);
});
