// test/unit/qwen-models-meta.test.js - 千问模型表的元数据解析与展示
//
// 背景（2026-10-31）：上游 /api/v2/model/list 的条目带 price_factor /
// context_config / is_vl，旧实现只取 key 全丢了，界面只能显示「无倍率」。
const { test } = require('node:test');
const assert = require('assert');
const qw = require('../../src/qwenwork');
const modelinfo = require('../../src/model-info');

test('normalizeModelRow：倍率、上下文档位、多模态、显示名', () => {
  const e = qw.normalizeModelRow({
    key: 'pro', display_name: '高级', price_factor: 1.0, original_price_factor: 1.2,
    is_vl: true, enable: true,
    context_config: { small: { token_count: 200000 }, large: { token_count: 1000000 }, mid: { token_count: 400000 } },
  });
  assert.strictEqual(e.key, 'pro');
  assert.strictEqual(e.name, '高级');
  assert.strictEqual(e.rate, 1.0);
  assert.strictEqual(e.rateOriginal, 1.2);
  assert.deepStrictEqual(e.contextTiers, [200000, 400000, 1000000]);
  assert.strictEqual(e.contextWindow, 1000000);
  assert.strictEqual(e.multimodal, true);
});

test('normalizeModelRow：缺字段时如实 null，不编 0', () => {
  const e = qw.normalizeModelRow({ key: 'flash' });
  assert.strictEqual(e.rate, null);
  assert.strictEqual(e.contextWindow, null);
  assert.strictEqual(e.multimodal, false);
});

test('parseModelsResponse：认 qwork 外壳并过滤 enable=false', () => {
  const list = qw.parseModelsResponse({
    qwork: [
      { key: 'pro', price_factor: 1 },
      { key: 'off', enable: false },
      { key: 'flash', price_factor: 0.1, context_config: { a: { token_count: 1024000 } } },
    ],
  });
  assert.deepStrictEqual(list.map((x) => x.key), ['pro', 'flash']);
  assert.strictEqual(list[1].contextWindow, 1024000);
});

test('qwenworkRows(entries)：带上游倍率与多模态，上下文标注来源', () => {
  const rows = modelinfo.qwenworkRows([
    { key: 'flash', name: '标准', rate: 0.1, rateOriginal: 0.1, contextWindow: 1024000, contextTiers: [1024000], multimodal: false },
  ]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].rate, 0.1);
  assert.strictEqual(rows[0].rateSource, 'upstream');
  assert.strictEqual(rows[0].contextWindow, 1024000);
  assert.strictEqual(rows[0].contextSource, 'upstream');
  assert.strictEqual(rows[0].note, '');
});

test('qwenworkRows(entries)：上游没给上下文时回落实测值', () => {
  const rows = modelinfo.qwenworkRows([
    { key: 'pro', name: '高级', rate: null, contextWindow: null, contextTiers: [], multimodal: true },
  ]);
  assert.strictEqual(rows[0].contextWindow, modelinfo.QW_CONTEXT.max);
  assert.strictEqual(rows[0].contextSource, 'measured');
  assert.strictEqual(rows[0].multimodal, true);
});

test('setQwenModels：缓存快照驱动 qwenworkRows()', () => {
  modelinfo.setQwenModels([
    { key: 'x', name: 'X', rate: 2, rateOriginal: 2, contextWindow: 200000, contextTiers: [200000], multimodal: false },
  ]);
  const rows = modelinfo.qwenworkRows();
  assert.deepStrictEqual(rows.map((r) => r.id), ['x']);
  assert.strictEqual(rows[0].rate, 2);
  modelinfo.setQwenModels(null);
});
