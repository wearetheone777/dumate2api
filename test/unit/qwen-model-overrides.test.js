// test/unit/qwen-model-overrides.test.js - 千问逐模型开关与能力覆盖层（2026-11-27 融合 A1）
//
// 锁 src/qwenwork/model-overrides.js：覆盖层读写、合并视图、prune 清理、原子写。
// 覆盖层是本机偏好：刷新目录不重置，目录删模型清开关（与社区实现一致）。
const { test, beforeEach } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ov = require('../../src/qwenwork/model-overrides');

let tmpFile;
beforeEach(() => {
  // 每用例一个临时文件，避免污染真实 data/ 与互相串扰
  tmpFile = path.join(os.tmpdir(), `qw-overrides-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  process.env.DUMATE_QWENWORK_OVERRIDES_FILE = tmpFile;
});

test('初始状态：空覆盖，无禁用', () => {
  const st = ov.load();
  assert.deepStrictEqual(st.disabled, []);
  assert.deepStrictEqual(st.overrides, {});
  assert.strictEqual(ov.isDisabled('pro'), false);
});

test('setDisabled：开/关切换，持久化', () => {
  ov.setDisabled('pro', true);
  assert.strictEqual(ov.isDisabled('pro'), true);
  ov.setDisabled('pro', false);
  assert.strictEqual(ov.isDisabled('pro'), false);
});

test('setOverride：写单项能力覆盖', () => {
  ov.setOverride('pro', 'context', 500000);
  const o = ov.overrideOf('pro');
  assert.strictEqual(o.context, 500000);
});

test('setOverride：非法字段抛错', () => {
  assert.throws(() => ov.setOverride('pro', 'bad', 1), /非法覆盖字段/);
});

test('clearOverride：跟随目录，清覆盖', () => {
  ov.setOverride('pro', 'context', 500000);
  ov.setOverride('pro', 'vision', true);
  ov.clearOverride('pro');
  assert.strictEqual(ov.overrideOf('pro'), null);
});

test('mergedView：无覆盖时跟随目录默认', () => {
  const entries = [{ key: 'pro', contextWindow: 262144, multimodal: false, reasoning: true }];
  const view = ov.mergedView(entries);
  assert.strictEqual(view[0].disabled, false);
  assert.strictEqual(view[0].dirty, false);
  assert.strictEqual(view[0].contextOverride, null);
  assert.strictEqual(view[0].effectiveContext, 262144);
  assert.strictEqual(view[0].effectiveVision, false);
  assert.strictEqual(view[0].effectiveReasoning, true);
});

test('mergedView：有覆盖时用覆盖值，标 dirty', () => {
  ov.setOverride('pro', 'context', 500000);
  ov.setOverride('pro', 'vision', true);
  const entries = [{ key: 'pro', contextWindow: 262144, multimodal: false, reasoning: true }];
  const view = ov.mergedView(entries);
  assert.strictEqual(view[0].dirty, true);
  assert.strictEqual(view[0].contextOverride, 500000);
  assert.strictEqual(view[0].effectiveContext, 500000);
  assert.strictEqual(view[0].visionOverride, true);
  assert.strictEqual(view[0].effectiveVision, true);
});

test('prune：目录删模型，禁用与覆盖都清掉', () => {
  ov.setDisabled('gone', true);
  ov.setOverride('gone', 'context', 100);
  ov.setDisabled('keep', true);
  ov.setOverride('keep', 'context', 200);
  const r = ov.prune(['keep']);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(ov.isDisabled('gone'), false);
  assert.strictEqual(ov.overrideOf('gone'), null);
  assert.strictEqual(ov.isDisabled('keep'), true);
  assert.strictEqual(ov.overrideOf('keep').context, 200);
});

test('prune：无变化不写盘（changed=false）', () => {
  ov.setDisabled('keep', true);
  const r = ov.prune(['keep']);
  assert.strictEqual(r.changed, false);
});

test('原子写：落盘是合法 JSON（无半写）', () => {
  ov.setDisabled('pro', true);
  const raw = fs.readFileSync(tmpFile, 'utf8');
  const j = JSON.parse(raw); // 不抛即合法
  assert.ok(Array.isArray(j.disabled));
});
