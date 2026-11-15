// test/model-info.test.js - model-info.js 行为测试（三通道模型表）
//
// modelmap 在 require 时固化 DUMATE_ADMIN_DATA，本文件把数据目录指到
// 一次性夹具目录再加载。**不碰 traeworkRows（会真机拉模型表）**；
// qoder/qwenwork 的行全部用 setQoderModels / setQwenKeys 快照注入，
// 保证离线且不出网。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeTmpData } = require('./helpers/tmpdata');

const tmp = makeTmpData('modelinfo');
fs.writeFileSync(tmp.file('model-map.json'), JSON.stringify({
  aliases: { 'alias-a': 'model-text', 'glm-5': 'glm-5' },
  upstream_models: ['model-text', 'model-artifact-validate', 'glm-5'],
  exposed: ['alias-a', 'glm-5', 'unknown-alias'],
  fallback: 'model-text',
}));

process.env.DUMATE_ADMIN_DATA = tmp.dir;
const modelinfo = require('../src/model-info');

test('dumateRows：别名落点语义——别名→目标、native→自身、未知名→fallback', () => {
  // 关掉清单追加行，只测 exposed 的映射语义（清单行为在 rowsFor 那条用例里）
  process.env.DUMATE_EXPOSE_CATALOG = '0';
  try {
    const rows = modelinfo.dumateRows();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    for (const r of rows) {
      assert.equal(r.channel, 'dumate');
      assert.equal(r.rate, null, '搭子无倍率概念');
      assert.ok(r.maxTokens > 0, r.id + ' 输出上限应是实测正数');
    }
    // 别名行：native=false，target 指向映射目标，note 讲清楚转发去哪
    assert.equal(byId['alias-a'].native, false);
    assert.equal(byId['alias-a'].target, 'model-text');
    assert.match(byId['alias-a'].note, /model-text/);
    // 上游原生行
    assert.equal(byId['glm-5'].native, true);
    assert.equal(byId['glm-5'].target, 'glm-5');
    assert.equal(byId['glm-5'].note, modelinfo.DUMATE_NOTE);
    // 未登记别名也未登记 upstream → 走 fallback（不是映射到自身）。
    // 它与 alias-a 落到同一个后端（model-text），2026-11-15 起同后端合并成
    // 一行：主行保留 alias-a，unknown-alias 进 alsoKnownAs（信息不丢）。
    assert.ok(byId['alias-a'].alsoKnownAs.includes('unknown-alias'));
    assert.equal(byId['unknown-alias'], undefined, '同后端不重复占行');
    assert.equal(rows.length, 2, 'alias-a/unknown-alias 合并 + glm-5');
  } finally {
    delete process.env.DUMATE_EXPOSE_CATALOG;
  }
});

test('dumateRows：上下文来自实测表（不冒充上游给值）', () => {
  process.env.DUMATE_EXPOSE_CATALOG = '0';
  try {
    const rows = modelinfo.dumateRows();
    const r = rows.find((x) => x.id === 'alias-a');   // → model-text
    const real = modelinfo.DUMATE_REAL['model-text'];
    assert.equal(r.contextWindow, real.context);
    assert.equal(r.contextWindowMin, null, '没有「区间」概念就不再给下界字段填数');
    assert.equal(r.contextSource, 'measured');
    assert.equal(r.maxTokens, real.maxTokens);
  } finally {
    delete process.env.DUMATE_EXPOSE_CATALOG;
  }
});

test('qoderRows：归一化快照形状（session.fetchModels）映射', async () => {
  modelinfo.setQoderModels([
    {
      key: 'gfmodel', name: 'GLM Flash', rate: 0.1, rateOriginal: 1,
      contextWindow: 180000, maxInputTokens: 1000000,
      contextTiers: [180000, 1000000], reasoning: false, multimodal: true, isFree: false,
    },
  ]);
  const rows = await modelinfo.qoderRows();
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.id, 'gfmodel');
  assert.equal(r.prefixed, 'qoder/GLM Flash', '调用前缀用真实模型名，不是内部代号');
  assert.equal(r.rate, 0.1);
  assert.equal(r.rateSource, 'upstream');
  assert.equal(r.rateOriginal, 1);
  assert.equal(r.contextWindow, 1000000, '上下文按最大档（ctxMax 优先于 ctx）');
  assert.match(r.contextNote, /1M/, '多档位时说明网关按最大档下发');
  assert.equal(r.capability, 'chat_model');
  assert.equal(r.multimodal, true);
  assert.match(r.note, /低倍率/);
});

test('qoderRows：原始上游形状（price_factor / context_config）同样能映射', async () => {
  modelinfo.setQoderModels([
    {
      key: 'qfmodel', display_name: 'Qwen Free',
      price_factor: 0.1, original_price_factor: 1,
      max_input_tokens: 180000,
      context_config: { t200: { token_count: 180000 }, t1m: { token_count: 1000000 } },
      is_reasoning: true, is_vl: false, is_free: true,
    },
  ]);
  const rows = await modelinfo.qoderRows();
  const r = rows[0];
  assert.equal(r.name, 'Qwen Free', 'display_name 也被认');
  assert.equal(r.rate, 0.1);
  assert.equal(r.rateOriginal, 1);
  assert.equal(r.contextWindow, 1000000, 'context_config 里取最大 token_count');
  assert.equal(r.contextSource, 'upstream');
  assert.equal(r.capability, 'reasoning_model');
  assert.equal(r.isFree, true);
  assert.match(r.contextNote, /180K \/ 1M/, '档位升序展示');
});

test('qoderRows：无快照回落静态表（如实 null，不估算）', async () => {
  modelinfo.setQoderModels(null);
  const rows = await modelinfo.qoderRows();
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.equal(r.rate, null);
    assert.equal(r.rateSource, null);
    assert.equal(r.contextWindow, null);
    assert.equal(r.isFree, false);
  }
});

test('setQoderModels：非数组/null 重置缓存', async () => {
  modelinfo.setQoderModels([{ key: 'x', rate: 2, contextWindow: 8 }]);
  modelinfo.setQoderModels('garbage');
  const rows = await modelinfo.qoderRows();
  assert.equal(rows[0].rate, null, '非法快照被丢弃，回落静态表');
});

test('qwenworkRows：默认静态表 + 注入快照后切换', () => {
  const staticRows = modelinfo.qwenworkRows();
  assert.ok(staticRows.length >= 1);
  for (const r of staticRows) {
    assert.equal(r.channel, 'qwenwork');
    assert.equal(r.rate, null);
    assert.match(r.note, /403/, '静态表标注接口不可用的背景');
  }
  modelinfo.setQwenKeys(['pro', 'flash']);
  const cached = modelinfo.qwenworkRows();
  assert.deepEqual(cached.map((r) => r.id), ['pro', 'flash']);
  assert.equal(cached[0].note, '', '上游快照来源无需标注');
  assert.equal(cached[0].contextWindow, modelinfo.QW_CONTEXT.max, 'pro/flash 在 QW_META 里，上下文用实测值');
  modelinfo.setQwenKeys(null); // 还原
});

test('rowsFor：四通道分发 + 未知通道报错', async () => {
  // 2026-11-15：搭子行数不再等于 exposed 的 3 条——dumateRows 会追加桌面端
  // 模型清单里未覆盖的条目（P0-1）。所以断言改成「≥ exposed 数量，且多出来的
  // 那部分来源标 desktop」，而不是钉死一个数字（清单条数会随客户端版本变）。
  const dmRows = (await modelinfo.rowsFor('dumate')).rows;
  const exposedCount = require('../src/modelmap').load().exposed.length;
  assert.ok(dmRows.length >= exposedCount, `搭子行数 ${dmRows.length} 应 ≥ exposed ${exposedCount}`);
  const desktopRows = dmRows.filter((r) => r.contextSource === 'desktop');
  assert.ok(desktopRows.length > 0, '应包含桌面清单条目（默认环境用包内 22 条清单）');
  assert.ok(desktopRows.every((r) => r.multimodalSource === 'desktop'), '清单行的来源标记应一致');
  assert.equal((await modelinfo.rowsFor('qwenwork')).rows.length >= 1, true);
  const unknown = await modelinfo.rowsFor('nope');
  assert.deepEqual(unknown.rows, []);
  assert.match(unknown.error, /nope/);
});

test('rowsFor visibleOnly：未实测的清单候选不进自动选档', async () => {
  // cc-switch / agent-setup 用 visibleOnly 自动挑档位：清单里只有客户端声明、
  // 本仓没实测过的名字（verified:false）不能写进客户端默认配置——可能是 404
  // 的名字（review #5）。管理端表格（不带 visibleOnly）仍能看到它们。
  const all = (await modelinfo.rowsFor('dumate')).rows;
  const visible = (await modelinfo.rowsFor('dumate', { visibleOnly: true })).rows;
  assert.ok(all.some((r) => r.verified === false), '默认清单里应有未实测条目（否则本用例失去意义）');
  assert.ok(visible.length > 0);
  assert.ok(visible.every((r) => r.verified !== false), '可见行不得含未实测候选');
  assert.ok(visible.length < all.length, '必须真的过滤掉了一些');
});

test('SRC 标记集完整', () => {
  assert.deepEqual(Object.keys(modelinfo.SRC).sort(), ['config', 'desktop', 'measured', 'upstream']);
});
