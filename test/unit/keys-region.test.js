// test/unit/keys-region.test.js - API Key 区域绑定（2026-11-01）
//
// 区域维度：'' 不限 / 'cn' 国内 / 'intl' 国际。intl key 打纯国内通道
// （dumate/qwenwork）在 validate 就拒——上游连国际端点都不存在，放进
// 运行时只会变成「没有可用账号」这种无信息量报错。qoder/traework 的
// 账号级过滤在 send 里做（模型名不编码区域，约束只能落在账号池）。
const { test } = require('node:test');
const assert = require('node:assert');
const keys = require('../../src/keys');

const K = (region, channel) => ({ enabled: true, region, channel });

test('validate：intl key 打纯国内通道 → region_not_available', () => {
  assert.equal(keys.validate(K('intl', 'dumate'), '1.2.3.4', 'glm-5', 'dumate').reason, 'region_not_available');
  assert.equal(keys.validate(K('intl', 'qwenwork'), '1.2.3.4', 'qwen/pro', 'qwenwork').reason, 'region_not_available');
  // 通道未知时跳过（与通道绑定同一口径——不该因无法判定而拒掉）
  assert.equal(keys.validate(K('intl', ''), '1.2.3.4', null, '').ok, true);
});

test('validate：cn key 打国内通道通过；intl key 打 qoder/traework 不在 validate 拒（运行时过滤）', () => {
  assert.equal(keys.validate(K('cn', 'dumate'), '1.2.3.4', 'glm-5', 'dumate').ok, true);
  assert.equal(keys.validate(K('intl', 'qoder'), '1.2.3.4', 'qoder/gfmodel', 'qoder').ok, true, 'qoder 有国际账号，运行时按区域选号');
  assert.equal(keys.validate(K('intl', 'traework'), '1.2.3.4', 'traework/glm-5.2', 'traework').ok, true, 'traework intl 在 send 时报「未接入」');
  assert.equal(keys.validate(K('cn', 'qoder'), '1.2.3.4', 'qoder/gfmodel', 'qoder').ok, true);
});

test('validate：区域与通道绑定的组合判定（intl key 绑定 qoder 通道、调 qwen 模型）', () => {
  // 通道先拒——两条规则都命中时报通道（先到先判）
  const v = keys.validate(K('intl', 'qoder'), '1.2.3.4', 'qwen/pro', 'qwenwork');
  assert.equal(v.reason, 'channel_not_allowed');
});

test('normalizeRegionKey：非法值归空（不限），大小写归一', () => {
  assert.equal(keys.normalizeRegionKey('CN'), 'cn');
  assert.equal(keys.normalizeRegionKey('INTL'), 'intl');
  assert.equal(keys.normalizeRegionKey('global'), '');
  assert.equal(keys.normalizeRegionKey(undefined), '');
});

test('accountsForRegion：qoder 区域过滤（cn/global 账号术语映射）', () => {
  const { accountsForRegion } = require('../../src/qoder');
  const usable = [
    { id: 1, region: 'cn' },
    { id: 2, region: 'global' },
    { id: 3, region: undefined }, // 缺省按 normalizeRegion → global？不——qoder normalizeRegion 只认 'cn'，其余归 global
  ];
  assert.deepEqual(accountsForRegion(usable, '').map((a) => a.id), [1, 2, 3]);
  assert.deepEqual(accountsForRegion(usable, 'cn').map((a) => a.id), [1]);
  // qoder 的 normalizeRegion：非 'cn' 一律归 global（含缺省）——intl key 会用到 global 池
  assert.deepEqual(accountsForRegion(usable, 'intl').map((a) => a.id), [2, 3]);
});
