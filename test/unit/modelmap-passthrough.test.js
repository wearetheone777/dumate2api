// test/unit/modelmap-passthrough.test.js - mapModel 上游真名透传（2026-11-01）
//
// 此前别名表是唯一允许名单：上游真名不在表里就静默落 fallback，逼着配置
// 躺一堆 glm-5 -> glm-5 的自映射。透传后别名表只承担真正的改名映射。
const { test } = require('node:test');
const assert = require('node:assert');
const mm = require('../../src/modelmap');

test('mapModel：upstream_models 里的真名直接透传（无需别名条目）', () => {
  const cfg = mm.load();
  for (const name of cfg.upstream_models) {
    assert.equal(mm.mapModel(name), name, name + ' 应透传');
  }
});

test('mapModel：别名表仍生效（auto-l* 简写），未知名仍兜底 fallback', () => {
  assert.equal(mm.mapModel('auto-l1'), 'dm-auto-model/text.L1');
  assert.equal(mm.mapModel('glm-5.2'), mm.load().fallback, '不在表内的近名仍兜底（防上游 404）');
  assert.equal(mm.mapModel(''), mm.load().fallback);
  assert.equal(mm.mapModel(undefined), mm.load().fallback);
});
