// test/unit/qoder-model-catalog.test.js - P0-2 模型目录治理
//
// 锁住五条纪律（方案原话，逐条对应一个用例组）：
//   1. **不删条目**：第三方清单不是本项目真机证据，只标 retiredCandidate
//   2. **倍率只读上游**：快照里不写任何第三方数值，兜底行的 rate 恒 null
//   3. 四级降级：upstream → disk-cache → client-cache → snapshot，
//      每一级都带 catalogSource，**不静默回落**
//   4. 运行时别名：上游 display_name 注册后能解析，歧义不猜
//   5. `enable=false` 的模型管理端列出、/v1/models 不列
//
// 运行：node --test test/unit/qoder-model-catalog.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-qoder-catalog');
process.env.DUMATE_ADMIN_DATA = TMP;

const catalog = require('../../src/qoder/catalog');
const constants = require('../../src/qoder/constants');
const chat = require('../../src/qoder/chat');
const session = require('../../src/qoder/session');
const auth = require('../../src/qoder/auth');

function clearDisk() {
  try { fs.unlinkSync(catalog.diskCachePath()); } catch (e) { /* 不存在 */ }
}

test.beforeEach(() => {
  clearDisk();
  catalog._resetForTest();
  chat._resetAliasesForTest();
});

// ---------- 纪律 1：不删条目，只标候选 ----------

test('快照：候选下线条目仍在表里，带原因', () => {
  const rows = catalog.loadSnapshot();
  assert.ok(rows.length > 0, '快照非空');
  const retired = rows.filter((r) => r.retiredCandidate);
  assert.ok(retired.length > 0, '至少一条候选（第三方清单声称下线）');
  for (const r of retired) {
    assert.ok(r.reason && r.reason.length > 0, `${r.key} 必须给原因`);
  }
  // 关键纪律：候选**不出现在** fallbackKeys({includeRetired:false})，
  // 但仍在 fallbackKeys() 全量里——删条目会让「上游其实还能用」永远找不回来
  const all = catalog.fallbackKeys();
  const live = catalog.fallbackKeys({ includeRetired: false });
  for (const r of retired) {
    assert.ok(all.includes(r.key), `${r.key} 不该被删`);
    assert.ok(!live.includes(r.key), `${r.key} 不该默认列出`);
  }
});

test('快照：只记 key 与状态，不写第三方倍率/显示名', () => {
  const raw = JSON.parse(fs.readFileSync(catalog.SNAPSHOT_FILE, 'utf8'));
  for (const m of raw.models) {
    assert.ok(typeof m.key === 'string' && m.key, 'key 必填');
    assert.strictEqual(m.rate, undefined, `${m.key} 不该带第三方倍率`);
    assert.strictEqual(m.price_factor, undefined, `${m.key} 不该带 price_factor`);
    assert.strictEqual(m.display_name, undefined, `${m.key} 不该带第三方显示名`);
  }
});

test('constant 派生：FALLBACK_MODELS 与快照一一对应，CHEAP_MODELS 剔除候选', () => {
  assert.deepEqual(constants.FALLBACK_MODELS, catalog.fallbackKeys());
  assert.ok(constants.DEFAULT_MODEL === 'auto');
  for (const k of constants.CHEAP_MODELS) {
    assert.strictEqual(catalog.statusOf(k).retiredCandidate, false, `${k} 是候选不该进推荐`);
  }
});

test('真机复核（2026-11-28）：三个下线条目已确证，候选标记不得回退', () => {
  // 真机依据：cn 两账号 + global 两账号共四个账号的模型表，**都不含**这三个 key。
  // 把它们改回 retiredCandidate:false 会让 /v1/models 与便宜档推荐重新列出
  // 根本调不通的模型——症状是客户端选中后稳定失败，而且原因（404/信封错误）
  // 离「这个模型不存在」很远，非常难查。
  for (const k of ['qmodel', 'q37fmodel', 'gm51model']) {
    const st = catalog.statusOf(k);
    assert.ok(st.retiredCandidate, `${k} 已真机确证下线，必须保持候选标记`);
    assert.ok(st.reason.includes('真机'), `${k} 的原因必须写明真机依据`);
  }
});

test('真机复核（2026-11-28）：上游实际存在的 key 不得被误标候选', () => {
  // 真机模型表（cn 14 条 / global 17 条）里实际出现过的 key。少录任何一条
  // 都会让「兜底时列出的模型比上游少」，且没有任何报错。
  for (const k of ['auto', 'fast', 'qmodel_latest', 'qmodel_38max', 'qfmodel',
    'dmodel', 'dfmodel', 'gmodel_latest', 'gmodel', 'gfmodel',
    'kmodel_latest', 'kmodel', 'mmodel', 'jmodel']) {
    assert.ok(constants.FALLBACK_MODELS.includes(k), `${k} 是真机存在的模型，必须在兜底表`);
    assert.strictEqual(catalog.statusOf(k).retiredCandidate, false, `${k} 不该被标候选`);
  }
});

test('真机复核（2026-11-28）：qwen-plus 别名不指向已下线 key', () => {
  // qmodel 已真机确证下线；别名指向它会让 `qwen-plus` 稳定失败。
  for (const [alias, target] of Object.entries(constants.MODEL_ALIASES)) {
    assert.notStrictEqual(target, 'qmodel', `${alias} 不该指向已下线的 qmodel`);
    assert.strictEqual(catalog.statusOf(target).retiredCandidate, false,
      `${alias} → ${target} 目标不能是候选下线条目`);
  }
});

// ---------- 纪律 2：倍率不编 ----------

test('兜底行 rate 恒 null（不拿第三方数值冒充上游倍率）', async () => {
  const r = await catalog.resolveCatalog({});
  assert.strictEqual(r.catalogSource, 'snapshot');
  for (const m of r.models) {
    assert.strictEqual(m.rate, null, `${m.key} 的 rate 应为 null`);
    assert.strictEqual(m.rateOriginal, null);
  }
});

// ---------- 纪律 3：四级降级 ----------

test('降级 L1：upstream 成功即用，并写磁盘缓存', async () => {
  const fetched = [{ key: 'upmodel', name: 'Up Model', rate: 0.5 }];
  const r = await catalog.resolveCatalog({
    fetchUpstream: async () => ({ ok: true, models: fetched }),
  });
  assert.strictEqual(r.catalogSource, 'upstream');
  assert.deepEqual(r.models.map((m) => m.key), ['upmodel']);
  const disk = catalog.readDiskCache();
  assert.ok(disk && disk.models.length === 1, '成功后必须落盘缓存');
});

test('降级 L2：upstream 失败走磁盘缓存（带 stale 标记，不静默）', async () => {
  catalog.writeDiskCache([{ key: 'cached', name: 'Cached' }], 'upstream');
  const r = await catalog.resolveCatalog({
    fetchUpstream: async () => ({ ok: false, error: '401 token expired' }),
  });
  assert.strictEqual(r.catalogSource, 'disk-cache');
  assert.equal(r.stale, false, '7 天内不算陈旧');
  assert.ok(r.error.includes('401'), '上游失败原因必须带出来，不能静默');
});

test('降级 L2：过期缓存仍可用但标 stale:true', async () => {
  catalog.writeDiskCache([{ key: 'old', name: 'Old' }], 'upstream');
  const future = Date.now() + catalog.DISK_CACHE_TTL_MS + 86400000;
  const r = await catalog.resolveCatalog({ now: future });
  assert.strictEqual(r.catalogSource, 'disk-cache');
  assert.strictEqual(r.stale, true, '超过 7 天必须标陈旧');
});

test('降级 L4：前三级都不可用时回落快照，且 error 说明原因', async () => {
  const r = await catalog.resolveCatalog({
    fetchUpstream: async () => { throw new Error('network down'); },
  });
  assert.strictEqual(r.catalogSource, 'snapshot');
  assert.ok(r.error.includes('network down'), '上游错误原样带出');
  assert.ok(r.models.length > 0, '快照永远可用');
  assert.ok(r.models.some((m) => m.retiredCandidate), '快照里候选也在（调用方自行过滤）');
});

test('clientCacheCandidates：路径只探测，不硬编单一系统', () => {
  const paths = catalog.clientCacheCandidates();
  assert.ok(paths.length >= 4);
  for (const p of paths) assert.ok(p.endsWith('models.json'));
});

// ---------- 纪律 4：运行时别名 ----------

test('别名：上游 display_name 注册后精确名与归一化名都能解析', () => {
  chat.registerAliases([{ key: 'gfmodel', name: 'GLM-5.3-Flash' }]);
  assert.strictEqual(chat.resolveModelKey('GLM-5.3-Flash'), 'gfmodel');
  assert.strictEqual(chat.resolveModelKey('glm-5.3-flash'), 'gfmodel');
  assert.strictEqual(chat.resolveModelKey('glm53flash'), 'gfmodel');
  assert.strictEqual(chat.resolveModelKey('qoder/GLM-5.3-Flash'), 'gfmodel');
});

test('别名：歧义（两个 key 共用显示名）不猜，原样透传', () => {
  chat.registerAliases([
    { key: 'keyA', name: 'Shared Name' },
    { key: 'keyB', name: 'Shared Name' },
  ]);
  assert.strictEqual(chat.resolveModelKey('Shared Name'), 'Shared Name',
    '歧义时不猜——让上游裁决，猜错会静默跑另一个模型');
});

test('别名：静态表优先于运行时（上游改显示名不影响老别名）', () => {
  // 静态别名表是手写的用户约定（qwen-flash → qfmodel）。上游若把同一个名字
  // 注册成另一个 key，老调用不能被静默改掉指向。
  assert.strictEqual(chat.resolveModelKey('qwen-flash'), 'qfmodel');
  chat.registerAliases([{ key: 'other', name: 'qwen-flash' }]);
  assert.strictEqual(chat.resolveModelKey('qwen-flash'), 'qfmodel', '静态别名不能被运行时覆盖');
});

test('别名：未注册的名字原样返回（不吞模型名）', () => {
  assert.strictEqual(chat.resolveModelKey('totally-unknown'), 'totally-unknown');
});

// ---------- 纪律 5：enable=false 的出口口径 ----------

function setAccounts(list) {
  auth.findUsable = () => list;
  auth.preferred = () => list[0];
}

test('fetchModels：enable=false 保留并带 disabled 状态与原因', async () => {
  const orig = session.fetchModels;
  // 打桩上游：一启用一禁用
  session.fetchModels = async () => ({
    ok: true,
    models: [
      { key: 'live', name: 'Live', status: 'active', enabled: true, disabledReason: '' },
      { key: 'dead', name: 'Dead', status: 'disabled', enabled: false, disabledReason: '下架' },
    ],
  });
  try {
    const qoder = require('../../src/qoder/index');
    setAccounts([{ id: 1, region: 'cn', enabled: true }]);
    const entries = await qoder.listModelEntries();
    const names = entries.map((e) => e.name);
    // 活动模型补充（issue #9）：官方限时活动条目会被追加（catalogSource=supplement），
    // 名单断言因此只锁「启用者必须在、禁用者不得在」，并顺带核补充条目的状态
    assert.ok(names.includes('Live'), '启用的模型要列出');
    assert.ok(!names.includes('Dead'), '/v1/models 不列 disabled');
    for (const e of entries) {
      if (e.catalogSource === 'supplement') assert.equal(e.status, 'active', '补充条目必是 active');
    }
  } finally {
    session.fetchModels = orig;
  }
});
