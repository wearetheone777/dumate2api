// test/unit/cloud-model-map.test.js - 云端模型名空间归一（toCloudModel）离线测试
//
// 背景（2026-11-06 真机实测定案，test/probe-dumate-cloud-models.js）：
// 云端网关只认 6 个路由名（model-text / kimi-k31 / glm-53 / glm-53-flash /
// deepseek-v4-pro / deepseek-v41-flash / qwen38-flash），社区对外别名与本地
// 后端真名一律 404。toCloudModel 负责把任意入站名归一成云端可用的名字，
// 9084 与 fallback-web 回落共用。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// env 先于模块加载：modelmap 的 DATA_DIR 在 require 时固化
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-cloudmap-'));
process.env.DUMATE_ADMIN_DATA = TMP;

const modelmap = require('../../src/modelmap');

test('云端真名原样透传（含 [1M] 剥壳）', () => {
  for (const m of modelmap.DEFAULT_CLOUD_UPSTREAM) {
    assert.strictEqual(modelmap.toCloudModel(m), m, m);
    assert.strictEqual(modelmap.toCloudModel(m + '[1M]'), m, m + '[1M]');
  }
});

test('本地名经 cloud_aliases 映射：glm-5 → glm-53', () => {
  assert.strictEqual(modelmap.toCloudModel('glm-5'), 'glm-53');
  assert.strictEqual(modelmap.toCloudModel('glm-5[1M]'), 'glm-53');
});

test('普通别名表落到云端名：gpt-4o → model-text', () => {
  assert.strictEqual(modelmap.toCloudModel('gpt-4o'), 'model-text');
  assert.strictEqual(modelmap.toCloudModel('claude-3-5-sonnet-20241022'), 'model-text');
});

test('云端不认识的名字兜底 fallback（model-text 两边同后端，安全）', () => {
  // 社区对外别名（个人版实测 404）→ 兜底而非 404
  assert.strictEqual(modelmap.toCloudModel('deepseek-v4.1'), 'model-text');
  assert.strictEqual(modelmap.toCloudModel('kimi-k3.1-pro'), 'model-text');
  // 本地后端真名在云端同样 404 → 兜底
  assert.strictEqual(modelmap.toCloudModel('deepseek-v4.1-flash-low-latency'), 'model-text');
  assert.strictEqual(modelmap.toCloudModel('glm-5.2'), 'model-text');
});

test('空值回落 fallback；model-artifact-validate 不映射（云端无对应物）', () => {
  assert.strictEqual(modelmap.toCloudModel(''), 'model-text');
  assert.strictEqual(modelmap.toCloudModel(null), 'model-text');
  // 制品校验不是聊天模型，悄悄变成普通聊天等于编造——fallback 是它的归宿
  assert.strictEqual(modelmap.toCloudModel('model-artifact-validate'), 'model-text');
});

test('cloud 字段持久化咬合：save 其他字段不丢 cloud_upstream/cloud_aliases', () => {
  const before = modelmap.load();
  modelmap.save({ exposed: ['model-text', 'glm-5'] });
  const after = modelmap.load();
  assert.deepStrictEqual(after.cloud_upstream, before.cloud_upstream, 'cloud_upstream 保留');
  assert.deepStrictEqual(after.cloud_aliases, before.cloud_aliases, 'cloud_aliases 保留');
  assert.deepStrictEqual(after.exposed, ['model-text', 'glm-5'], 'exposed 更新生效');
});

test('旧配置文件（无 cloud 字段）读出默认值', () => {
  // 模拟存量 model-map.json：只有旧字段
  fs.writeFileSync(path.join(TMP, 'model-map.json'), JSON.stringify({
    aliases: { 'gpt-4o': 'model-text' },
    upstream_models: ['model-text', 'glm-5'],
    exposed: ['model-text', 'glm-5'],
    fallback: 'model-text',
  }), 'utf8');
  const cfg = modelmap.load();
  assert.ok(cfg.cloud_upstream.includes('kimi-k31'), 'cloud_upstream 走默认值');
  assert.strictEqual(cfg.cloud_aliases['glm-5'], 'glm-53', 'cloud_aliases 走默认值');
  // 清理，避免影响同进程后续用例的缓存
  fs.unlinkSync(path.join(TMP, 'model-map.json'));
  modelmap.load();
});

test('mapModel 行为不变（本地链路不受云端名空间影响）', () => {
  // 回归守卫：cloud 名**没有**混进本地 upstream_models——本地链路传 kimi-k31
  // 依旧落 fallback（8980 不认识它），而不是透传后 404
  assert.strictEqual(modelmap.mapModel('glm-5'), 'glm-5');
  assert.strictEqual(modelmap.mapModel('model-text'), 'model-text');
  assert.strictEqual(modelmap.mapModel('kimi-k31'), 'model-text', '云端名不进本地表');
});
