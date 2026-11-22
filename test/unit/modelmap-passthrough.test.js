// test/unit/modelmap-passthrough.test.js - mapModel 上游真名透传（2026-11-01）
//
// 此前别名表是唯一允许名单：上游真名不在表里就静默落 fallback，逼着配置
// 躺一堆 glm-5 -> glm-5 的自映射。透传后别名表只承担真正的改名映射。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 自带 model-map 夹具（理由同 claude-route.test.js）：`data/` 被 gitignore，
// 不能假设机器上已有 auto-l* / glm-5.2 这些别名。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'modelmap-passthrough-'));
fs.writeFileSync(path.join(TMP, 'model-map.json'), JSON.stringify({
  aliases: {
    'auto-l0': 'dm-auto-model/text.L0',
    'auto-l1': 'dm-auto-model/text.L1',
    'auto-l2': 'dm-auto-model/text.L2',
    'glm-5.2': 'glm-5',
  },
  upstream_models: ['model-text', 'model-artifact-validate', 'glm-5'],
  exposed: ['model-text', 'model-artifact-validate', 'glm-5'],
  fallback: 'model-text',
}));
process.env.DUMATE_ADMIN_DATA = TMP;

const mm = require('../../src/modelmap');

test('mapModel：upstream_models 里的真名直接透传（无需别名条目）', () => {
  const cfg = mm.load();
  for (const name of cfg.upstream_models) {
    assert.equal(mm.mapModel(name), name, name + ' 应透传');
  }
});

test('mapModel：别名表仍生效（auto-l* 简写），未知名仍兜底 fallback', () => {
  assert.equal(mm.mapModel('auto-l1'), 'dm-auto-model/text.L1');
  // glm-5.2 已注册为别名（→ glm-5）；真正未知的名字仍兜底（防上游 404）
  assert.equal(mm.mapModel('glm-5.2'), 'glm-5');
  assert.equal(mm.mapModel('no-such-model-xyz'), mm.load().fallback);
  assert.equal(mm.mapModel(''), mm.load().fallback);
  assert.equal(mm.mapModel(undefined), mm.load().fallback);
});
