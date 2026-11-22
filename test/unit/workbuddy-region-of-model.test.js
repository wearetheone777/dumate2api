// test/unit/workbuddy-region-of-model.test.js - 按模型名推断区域（2026-11-08 融合批）
//
// **出处：真机事故**。补身份头之后真机连续撞 11140，做严格 A/B 对照后发现与头
// 无关，真实成因是：`accountsForRegion()` 只在调用方显式传 region 时才收窄，
// 不传时两区账号混在一起，于是「国内模型名」被发给国际账号。上游对这种情况回的是
// **11140（风控码）而不是 11102（模型不存在）** —— 一次正常请求看起来像「账号被
// 限制」，进而触发连坐暂停，把整条通道弄停。
//
// 判据的三条纪律（每条都有断言）：
//   1. **只用缓存目录**，绝不在选号热路径打上游（`_setCatalog` 注入，不碰网络）
//   2. 判不出来（两边都有 / 两边都没有）**返回 null 不拦** —— 宁可让上游报 11102，
//      也不要凭猜测拒掉一个可能合法的模型名（自定义别名、上游新上线的模型）
//   3. 只在一侧有时才判得出（这是收窄能生效的唯一前提）
//
// 运行：node --test test/unit/workbuddy-region-of-model.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { tmpDir } = require('../helpers/tmpdir');
process.env.DUMATE_ADMIN_DATA = tmpDir('wb-region-of-model');
process.env.DUMATE_POOL_STATE = path.join(process.env.DUMATE_ADMIN_DATA, 'pool-state.json');

const models = require('../../src/workbuddy/models');

/** 每例重置两侧目录（互不污染） */
function seed(cnIds, intlIds) {
  models._setCatalog('cn', cnIds);
  models._setCatalog('global', intlIds);
}

test('只在国内目录里 → 判 cn（收窄到国内账号）', () => {
  seed(['deepseek-v4.1-flash', 'glm-5.3'], ['default-model', 'max-model']);
  assert.equal(models.regionOfModel('deepseek-v4.1-flash'), 'cn');
  assert.equal(models.regionOfModel('glm-5.3'), 'cn');
});

test('只在国际目录里 → 判 global（收窄到国际账号）', () => {
  seed(['deepseek-v4.1-flash', 'glm-5.3'], ['default-model', 'max-model']);
  assert.equal(models.regionOfModel('default-model'), 'global');
  assert.equal(models.regionOfModel('max-model'), 'global');
});

test('两侧都有同名模型 → 判不出，返回 null（不拦）', () => {
  // 实测 hy4std / hy4free / hy3 在两区目录里都有（同名不同价）：
  // 这种情况**不能**猜区域，猜错就是把请求发到会回 11140 的那一侧
  seed(['hy4std', 'hy4free', 'hy3'], ['hy4std', 'hy4free', 'hy3', 'default-model']);
  assert.equal(models.regionOfModel('hy4std'), null);
  assert.equal(models.regionOfModel('hy4free'), null);
});

test('两侧都没有 → 返回 null（交给上游报 11102，本地不拦）', () => {
  seed(['glm-5.3'], ['default-model']);
  assert.equal(models.regionOfModel('my-custom-alias'), null,
    '自定义别名/新上线模型都在这一档，本地拦掉会让本来能用的名字变不可用');
});

test('空/异常输入返回 null（不编区域）', () => {
  seed(['glm-5.3'], ['default-model']);
  for (const v of ['', '  ', null, undefined, 0]) {
    assert.equal(models.regionOfModel(v), null, `输入 ${JSON.stringify(v)} 应判不出`);
  }
});

test('清空缓存后回到「判不出」（注入的清理路径可用）', () => {
  seed(['only-cn-model'], []);
  assert.equal(models.regionOfModel('only-cn-model'), 'cn');
  models._setCatalog('cn', null);
  models._setCatalog('global', null);
  // 国内无缓存时 cachedModelIds 有历史兜底 ['glm-5.3']，所以这个断言只锁
  // 「不再是确定性的 cn-only 判据」，不锁具体值
  const r = models.regionOfModel('only-cn-model');
  assert.equal(r, null, '缓存清空后不该还判成 cn');
});

test('regionOfModel 导出且是函数（选号路径 require 它）', () => {
  assert.equal(typeof models.regionOfModel, 'function');
});

test('cachedModelIds：国际版无缓存时为空（不给国际编国内模型名）', () => {
  models._setCatalog('global', null);
  const intl = models.cachedModelIds('global');
  assert.deepEqual(intl, [], '国际版没有兜底模型名——编一个正好是本次事故的形态');
});
