// test/unit/ccswitch-tiers.test.js - cc-switch / agent-setup 的档位选取
//
// 2026-11-15：模型信息表把「同后端」的多个名字合并成一行（主行 + alsoKnownAs）。
// 用户显式指定被并掉的名字时（实例 deepseek-v41-flash 并进 model-text），
// pickTiers 必须还能解析到主行——否则 apply 会写出空模型名（review #6）。
const { test } = require('node:test');
const assert = require('node:assert');
const cc = require('../../src/admin/routes/ccswitch');

test('pickTiers：显式选择命中 alsoKnownAs（同后端合并后的别名）', () => {
  const main = { id: 'model-text', prefixed: 'model-text', alsoKnownAs: ['deepseek-v41-flash'] };
  const other = { id: 'glm-5', prefixed: 'glm-5' };
  const tiers = cc.pickTiers([main, other], ['deepseek-v41-flash']);
  assert.equal(tiers.length, 1);
  assert.equal(tiers[0], main, '别名解析到主行');
  assert.equal(cc.derive(tiers).context_window, null, '主行没有窗口字段时不编数字');
});

test('pickTiers：主行 id 与 prefixed 仍优先于别名', () => {
  const main = { id: 'model-text', prefixed: 'model-text', alsoKnownAs: ['glm-5'] };
  const real = { id: 'glm-5', prefixed: 'glm-5' };
  assert.equal(cc.pickTiers([main, real], ['glm-5'])[0], real, '真实存在的 id 不被别名抢走');
});
