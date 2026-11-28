// test/unit/qoder-model-metadata.test.js - P0-3 `/v1/models` 能力元数据出口
//
// 锁住三条口径：
//   1. 字段来自 session.fetchModels 已归一化的能力字段，不是第三方静态清单
//   2. 跨账号合并「一致才返回」：任一账号缺失/声明不同，整项省略（不填 false/null）
//   3. 旧客户端只读 id/name/contextWindow，新增字段不得改变这些旧字段
//
// 运行：node --test test/unit/qoder-model-metadata.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-qoder-model-meta');
process.env.DUMATE_ADMIN_DATA = TMP;
process.env.DUMATE_QODER_MAX_OUTPUT_FILE = path.join(TMP, 'max-output.json');

const qoder = require('../../src/qoder/index');
const auth = require('../../src/qoder/auth');
const session = require('../../src/qoder/session');
const maxOutput = require('../../src/qoder/max-output');

const { buildModelCapability } = qoder.internals;

const A = (id) => ({ id, uid: `uid-${id}`, region: 'cn', enabled: true });
const MODELS = [{
  key: 'gmodel', name: 'G-Model', maxInputTokens: 1000000,
  isReasoning: true, reasoningEfforts: ['low', 'high'], reasoningDefault: 'high',
  multimodal: true,
}];

function setAccounts(list) {
  auth.findUsable = () => list;
  auth.preferred = () => list[0];
}

test('单账号：能力字段全部来自模型表', () => {
  const out = buildModelCapability([MODELS], { region: 'cn', key: 'gmodel', accountCount: 1 });
  assert.deepEqual(out, {
    supports_reasoning: true,
    reasoning_effort_options: ['low', 'high'],
    default_reasoning_effort: 'high',
    multimodal: true,
  });
});

test('多账号一致：保留字段', () => {
  const out = buildModelCapability([MODELS, MODELS], { region: 'cn', key: 'gmodel', accountCount: 2 });
  assert.equal(out.supports_reasoning, true);
  assert.deepEqual(out.reasoning_effort_options, ['low', 'high']);
});

test('某账号没有该模型：不参与判定，已有声明保留', () => {
  const out = buildModelCapability([MODELS, [{ key: 'other', name: 'Other' }]], {
    region: 'cn', key: 'gmodel', accountCount: 1,
  });
  assert.equal(out.supports_reasoning, true);
  assert.equal(out.multimodal, true);
});

test('声明不一致：只省略冲突字段，其余保留', () => {
  const other = [{ ...MODELS[0], multimodal: false, isReasoning: false }];
  const out = buildModelCapability([MODELS, other], { region: 'cn', key: 'gmodel', accountCount: 2 });
  assert.equal(out.multimodal, undefined);
  assert.equal(out.supports_reasoning, undefined);
  assert.deepEqual(out.reasoning_effort_options, ['low', 'high']);
  assert.equal(out.default_reasoning_effort, 'high');
});

test('未知能力（字段缺失）不输出 false', () => {
  const unknown = [{ key: 'gmodel', name: 'G-Model' }];
  const out = buildModelCapability([unknown], { region: 'cn', key: 'gmodel', accountCount: 1 });
  assert.deepEqual(out, {});
});

test('maxOutputTokens 取上游声称值或自学习值，冲突即省略', () => {
  const claimed = [{ ...MODELS[0], max_tokens: 131072 }];
  const out = buildModelCapability([claimed], { region: 'cn', key: 'gmodel', accountCount: 1 });
  assert.equal(out.maxOutputTokens, 131072);
  // 两条声称不一致：省略
  assert.equal(buildModelCapability([claimed, [{ ...claimed[0], max_tokens: 32768 }]], {
    region: 'cn', key: 'gmodel', accountCount: 2,
  }).maxOutputTokens, undefined);
  // 自学习值（无声称值）
  maxOutput.learn('cn', 'gfmodel', 65536);
  assert.equal(buildModelCapability([[MODELS[0]]], { region: 'cn', key: 'gfmodel', accountCount: 1 }).maxOutputTokens, 65536);
});

test('listModelEntries：旧字段不变，新字段追加', async () => {
  setAccounts([A(1)]);
  session.fetchModels = async () => ({ ok: true, models: MODELS });
  session.cachedModels = () => null;
  const entries = await qoder.listModelEntries();
  // 活动模型补充（issue #9）会追加官方限时活动条目（catalogSource=supplement），
  // 动态表条目按来源过滤后再锁字段——窗口结束后过滤结果不变，断言不会过期
  const dyn = entries.filter((e) => e.catalogSource !== 'supplement');
  assert.equal(dyn.length, 1);
  assert.equal(dyn[0].id, 'qoder/G-Model');
  assert.equal(dyn[0].name, 'G-Model');
  assert.equal(dyn[0].contextWindow, 1000000);
  assert.equal(dyn[0].maxContextWindow, 1000000);
  assert.equal(dyn[0].supports_reasoning, true);
  assert.deepEqual(dyn[0].reasoning_effort_options, ['low', 'high']);
  for (const e of entries) {
    if (e.catalogSource === 'supplement') {
      assert.equal(e.status, 'active', '补充条目必是 active');
      assert.ok(e.key && e.id === `qoder/${e.name}`, '补充条目带 key 与显示名 id');
    }
  }
});

test('listModelEntries：无账号时兜底表不带能力字段', async () => {
  setAccounts([]);
  const entries = await qoder.listModelEntries();
  assert.ok(entries.length > 0);
  assert.equal(entries[0].supports_reasoning, undefined);
  assert.equal(entries[0].multimodal, undefined);
});
