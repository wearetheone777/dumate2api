// test/unit/reasoning-default.test.js - 「默认思考档」的纯函数（node:test）
//
// 2026-11-16 调研 P0-4。锁三条纪律（每条都对应一次踩过的坑）：
//   ① 客户端给了档位就一律不动（网关不覆盖调用方意图）；
//   ② descriptor 没声明支持档位 → 不套（档位是能力，模型名不是证据）；
//   ③ 只向下钳，并如实说明被钳过（不静默改写）。
const { test } = require('node:test');
const assert = require('assert');
const { applyDefault, pickDefault, summary } = require('../../src/reasoning-apply');

const SUPPORTED = ['light', 'high', 'extra_high'];

test('客户端显式给了档位 → 一律不动（各种写法都算）', () => {
  for (const payload of [
    { reasoning_effort: 'high' },
    { reasoningEffort: 'low' },
    { thinking_effort: 'medium' },
    { reasoning: { effort: 'high' } },
    { thinking: { effort: 'extra_high' } },
    { thinking: { budget_tokens: 20000 } }, // 按 budget 换算成档位也算客户端意图
  ]) {
    const r = applyDefault(payload, { table: { '*': 'light' }, model: 'glm-5.2', supported: SUPPORTED });
    assert.strictEqual(r.source, 'client', JSON.stringify(payload));
    assert.strictEqual(r.applied, false);
    assert.strictEqual(r.payload, payload, '原对象不该被替换');
  }
});

test('客户端没给 + 精确匹配 + 支持该档 → 套用默认档，且不改动入参', () => {
  const payload = { model: 'glm-5.2', messages: [] };
  const r = applyDefault(payload, { table: { 'glm-5.2': 'high' }, model: 'glm-5.2', supported: SUPPORTED });
  assert.strictEqual(r.source, 'default');
  assert.strictEqual(r.effective, 'high');
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.payload.reasoning_effort, 'high');
  assert.strictEqual(payload.reasoning_effort, undefined, '入参必须保持原样');
});

test('匹配优先级：精确 > 最长前缀 > *', () => {
  const table = { '*': 'light', 'gem*': 'high', 'gemini-3*': 'extra_high', 'gemini-3-flash': 'light' };
  assert.deepStrictEqual(pickDefault(table, 'gemini-3-flash'), { pattern: 'gemini-3-flash', tier: 'light' });
  assert.deepStrictEqual(pickDefault(table, 'gemini-3-pro'), { pattern: 'gemini-3*', tier: 'extra_high' });
  assert.deepStrictEqual(pickDefault(table, 'gemini-x'), { pattern: 'gem*', tier: 'high' });
  assert.deepStrictEqual(pickDefault(table, 'glm-5.2'), { pattern: '*', tier: 'light' });
  assert.strictEqual(pickDefault({}, 'glm-5.2'), null);
  // 大小写不敏感
  assert.deepStrictEqual(pickDefault({ 'GLM-5.2': 'high' }, 'glm-5.2'), { pattern: 'GLM-5.2', tier: 'high' });
});

test('descriptor 没声明支持档位 → 不套（不拿用户的钱赌能力）', () => {
  const r = applyDefault({}, { table: { '*': 'high' }, model: 'glm-5.2', supported: null });
  assert.strictEqual(r.source, 'none');
  assert.strictEqual(r.applied, false);
  assert.strictEqual(r.payload.reasoning_effort, undefined);
  assert.match(r.note, /未声明/);
});

test('默认档超出支持范围 → 向下钳，并说明被钳过', () => {
  const r = applyDefault({}, { table: { '*': 'extra_high' }, model: 'glm-5.2', supported: ['light'] });
  assert.strictEqual(r.source, 'default');
  assert.strictEqual(r.effective, 'light');
  assert.match(r.note, /钳到 light/);
});

test('非法档位字符串 → 不套，且给出可读原因（配置写错不该静默生效）', () => {
  const r = applyDefault({}, { table: { '*': 'ultra-max-9000' }, model: 'glm-5.2', supported: SUPPORTED });
  assert.strictEqual(r.source, 'none');
  assert.strictEqual(r.applied, false);
  assert.match(r.note, /不是合法档位/);
});

test('没配默认档 → none，且不视为错误', () => {
  const r = applyDefault({}, { table: {}, model: 'glm-5.2', supported: SUPPORTED });
  assert.strictEqual(r.source, 'none');
  assert.strictEqual(r.note, '未配置该模型的默认档');
});

test('summary：只给「谁给的档位 + 生效档」，空来源返回空串', () => {
  assert.strictEqual(summary({ source: 'client', effective: 'high' }), 'client:high');
  assert.strictEqual(summary({ source: 'default', effective: 'light' }), 'default:light');
  assert.strictEqual(summary({ source: 'none' }), '');
  assert.strictEqual(summary(null), '');
});

test('运行态配置：defaultReasoning 的非法档位在写入口就被拒', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-rt-'));
  const prev = process.env.DUMATE_ADMIN_DATA;
  process.env.DUMATE_ADMIN_DATA = dir;
  const rtPath = require.resolve('../../src/trae-runtime');
  delete require.cache[rtPath];
  const rt = require('../../src/trae-runtime');
  try {
    assert.throws(() => rt.Store({ defaultReasoning: { 'glm-5.2': 'bogus' } }), /不合法/);
    // 别名落库前归一化：low → light（原生三档只有 light/high/extra_high）
    const ok = rt.Store({ defaultReasoning: { 'glm-5.2': 'high', 'gemini*': 'low' } });
    assert.deepStrictEqual(ok.defaultReasoning, { 'glm-5.2': 'high', 'gemini*': 'light' });
    // 第二份白名单：Load() 必须把它读回来
    assert.deepStrictEqual(rt.Load().defaultReasoning, { 'glm-5.2': 'high', 'gemini*': 'light' });
  } finally {
    if (prev === undefined) delete process.env.DUMATE_ADMIN_DATA; else process.env.DUMATE_ADMIN_DATA = prev;
    delete require.cache[rtPath];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('运行态配置：别名落库前归一化、空表能真清空（深合并会让你删不掉）', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-rt2-'));
  const prev = process.env.DUMATE_ADMIN_DATA;
  process.env.DUMATE_ADMIN_DATA = dir;
  const rtPath = require.resolve('../../src/trae-runtime');
  delete require.cache[rtPath];
  const rt = require('../../src/trae-runtime');
  try {
    // ultra 是 extra_high 的别名：落库应存原生档，否则界面下拉选不中它
    assert.deepStrictEqual(rt.Store({ defaultReasoning: { 'glm-5.2': 'ultra' } }).defaultReasoning,
      { 'glm-5.2': 'extra_high' });
    // 删掉一行必须真的删掉（merge 对这张表是整体替换，不是深合并）
    assert.deepStrictEqual(rt.Store({ defaultReasoning: { 'gemini*': 'light' } }).defaultReasoning,
      { 'gemini*': 'light' });
    assert.deepStrictEqual(rt.Store({ defaultReasoning: {} }).defaultReasoning, {});
  } finally {
    if (prev === undefined) delete process.env.DUMATE_ADMIN_DATA; else process.env.DUMATE_ADMIN_DATA = prev;
    delete require.cache[rtPath];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
