// test/unit/qoder-hungerg.test.js - 活动模型补充：HungerG（issue #9）
//
// 锁住四条纪律：
//   1. **key 是 `hmodel`**：官方 0.5.21 应用内置文案表 modelPresentations.models.hmodel
//      （同表 lmodel=QoDuck 与 hub 真机验证的 API key 一致——presentation 键就是
//      API key）。显示名/别名都收敛到 hmodel，出站统一由上游裁决。
//   2. **过期即隐藏**：免费窗口（2026-11-23 24:00 ~ 11-30 24:00 UTC+8）过后补充
//      条目不再自动列出；显式调用的 meta 仍可得（透传上游裁决，与 retiredCandidate
//      同一纪律：不删条目，只是不自动列）。
//   3. **动态表优先**：上游哪天把 HungerG 放进动态清单，补充条目不覆盖、不重复。
//   4. **区域提示**：HungerG 是国际版个人账号活动模型——key 未绑区域时按国际区
//      选号；key 显式绑定的区域优先于提示。
//
// 运行：node --test test/unit/qoder-hungerg.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-qoder-hungerg');
process.env.DUMATE_ADMIN_DATA = TMP;

const catalog = require('../../src/qoder/catalog');
const constants = require('../../src/qoder/constants');
const chat = require('../../src/qoder/chat');

test.beforeEach(() => {
  chat._resetAliasesForTest();
});

// 时间敏感断言统一注入「窗口内」的时刻——默认 now 的断言在窗口结束
// （2026-11-30 24:00 UTC+8）后会误报，时间由测试说了算
const IN_WINDOW = () => catalog.HUNGERG_FREE_UNTIL_MS - 60000;

// ---------- 纪律 1：key 收敛到 hmodel ----------

test('静态别名：显示名与常见写法都解析成 hmodel（目录缺席也一样）', () => {
  for (const name of ['HungerG', 'hungerg', 'hungerg-free', 'hungerg_free', 'qoder/HungerG', 'qoder/hmodel']) {
    assert.equal(chat.resolveModelKey(name, []), 'hmodel', name);
  }
});

test('补充行形状：0 倍率 / 1M 最大档 / 四档思考 / 多模态，字段与 fetchModels 归一化行同形', () => {
  const rows = catalog.supplementRows({ now: IN_WINDOW() });
  assert.equal(rows.length, 1, '当前只有一个补充条目');
  const row = rows[0];
  assert.equal(row.key, 'hmodel');
  assert.equal(row.name, 'HungerG');
  assert.equal(row.rate, 0, '活动期 0 倍率（官方活动页）');
  assert.equal(row.rateOriginal, null, '活动结束后的倍率官方未公布——不编');
  assert.equal(row.maxInputTokens, 1000000);
  assert.deepEqual(row.contextTiers, [200000, 400000, 1000000]);
  assert.deepEqual(row.reasoningEfforts, ['low', 'medium', 'high', 'max']);
  assert.equal(row.multimodal, true);
  assert.equal(row.isReasoning, true);
  assert.equal(row.enabled, true);
  assert.equal(row.status, 'active');
  assert.equal(row.freeUntil, catalog.HUNGERG_FREE_UNTIL_MS);
});

test('思考档位归一化吃补充 meta：max 直认，minimal 收敛到 low', () => {
  const meta = catalog.supplementMetaOf('hmodel');
  assert.ok(meta, 'meta 可得');
  assert.equal(chat.resolveReasoningEffort({ reasoning_effort: 'max' }, meta), 'max');
  assert.equal(chat.resolveReasoningEffort({ reasoning_effort: 'minimal' }, meta), 'low');
  // 不带 meta（表缺席）也不拦路：原样透传，上游裁决
  assert.equal(chat.resolveReasoningEffort({ reasoning_effort: 'max' }, null), 'max');
});

// ---------- 纪律 2：过期即隐藏 ----------

test('过期后：补充行与列表条目都不再自动给出，meta 仍可得', () => {
  const at = catalog.HUNGERG_FREE_UNTIL_MS + 1;
  assert.deepEqual(catalog.supplementRows({ now: at }), [], '行列表隐藏');
  const merged = catalog.mergeSupplementEntries([], { now: at });
  assert.equal(merged.length, 0, '条目合并不追加');
  assert.ok(catalog.supplementMetaOf('hmodel'), '显式调用的 meta 仍可得（透传上游裁决）');
});

test('窗口内：列表条目自动追加，带 catalogSource=supplement 与 freeUntil', () => {
  const merged = catalog.mergeSupplementEntries([], { now: IN_WINDOW() });
  assert.equal(merged.length, 1);
  const e = merged[0];
  assert.equal(e.id, 'qoder/HungerG');
  assert.equal(e.key, 'hmodel');
  assert.equal(e.name, 'HungerG');
  assert.equal(e.catalogSource, 'supplement');
  assert.equal(e.freeUntil, catalog.HUNGERG_FREE_UNTIL_MS);
  assert.equal(e.maxContextWindow, 1000000);
});

// ---------- 纪律 3：动态表优先 ----------

test('上游已列出（按 key 或按显示名）时不重复追加；传入数组不被改动', () => {
  const now = { now: IN_WINDOW() };
  const upstream = [{ id: 'qoder/HungerG', name: 'HungerG', status: 'active', catalogSource: 'upstream' }];
  const snapshot = upstream.slice();
  const merged = catalog.mergeSupplementEntries(upstream, now);
  assert.equal(merged.length, 1, '按显示名去重');
  assert.deepEqual(upstream, snapshot, '不改传入');

  const upstreamByKey = [{ id: 'qoder/hmodel', name: 'hmodel', status: 'active', catalogSource: 'upstream' }];
  assert.equal(catalog.mergeSupplementEntries(upstreamByKey, now).length, 1, '按 key 去重');

  const other = [{ id: 'qoder/gfmodel', name: 'GLM-5.3-Flash', status: 'active', catalogSource: 'upstream' }];
  assert.equal(catalog.mergeSupplementEntries(other, now).length, 2, '无关条目照常追加');
});

// ---------- 纪律 4：区域提示 ----------

test('区域提示：HungerG 各写法 → intl；普通模型与空值 → 无提示', () => {
  for (const name of ['HungerG', 'hungerg', 'hungerg-free', 'hmodel']) {
    assert.equal(catalog.supplementRegionOf(name), 'intl', name);
  }
  assert.equal(catalog.supplementRegionOf('gfmodel'), '');
  assert.equal(catalog.supplementRegionOf(''), '');
  assert.equal(catalog.supplementRegionOf('qoder/HungerG'), '', 'send() 传前已剥前缀——本函数只认裸名');
});

// ---------- 接线自证（防「模块写好、无调用方」） ----------

test('index.js 三个接线点真的在调用补充模块', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'qoder', 'index.js'), 'utf8');
  assert.ok(src.includes('mergeSupplementEntries('), 'listModelEntries 合并补充条目');
  assert.ok(src.includes('supplementMetaOf('), 'runOnce 的 modelMeta 兜底');
  assert.ok(src.includes('supplementRegionOf('), 'send() 的区域提示');
  // 常量别名表真的登记了 HungerG 系列
  assert.equal(constants.MODEL_ALIASES.HungerG, 'hmodel');
  assert.equal(constants.MODEL_ALIASES.hungerg, 'hmodel');
  assert.equal(constants.MODEL_ALIASES['hungerg-free'], 'hmodel');
});
