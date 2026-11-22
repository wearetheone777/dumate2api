// test/unit/keys-account-allowlist.test.js - API Key 账号白名单（P1-4）
//
// 出处：docs/WORKBUDDY-FUSION.md P1-4（hub 多 Key「账号白名单：可精确限定该
// Key 仅允许调度的账号范围」）。原有 model_allowlist / channel / region / CIDR
// 都只能限定到「通道」，限定不到「某几个账号」。
//
// 三个设计决定（都在注释里，这里锁行为）：
//   1. **空数组 = 不限**（与 model_allowlist 同口径）：清空名单不该变成
//      「一把都调不了」
//   2. 两种写法都认：裸 id `1`（单通道语境）与 `通道:id`（跨通道）
//   3. 判定在**选号处**而不是鉴权处——鉴权时刻还不知道会选中哪个账号
//
// 运行：node --test test/unit/keys-account-allowlist.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-keys-acct');
process.env.DUMATE_ADMIN_DATA = TMP;

const keysvc = require('../../src/keys');

function reset() {
  try { fs.unlinkSync(keysvc.filePath()); } catch (e) { /* 没有更正常 */ }
}

test('normalizeAccountList：字符串化 + 去空 + 去重（顺序保留）', () => {
  assert.deepStrictEqual(keysvc.normalizeAccountList(['1', ' 2 ', 2, '', null, '1']), ['1', '2']);
  assert.deepStrictEqual(keysvc.normalizeAccountList(['workbuddy:3', 'workbuddy:3']), ['workbuddy:3']);
  assert.deepStrictEqual(keysvc.normalizeAccountList(null), []);
  assert.deepStrictEqual(keysvc.normalizeAccountList('1,2'), [], '非数组一律空（不猜）');
});

test('accountAllowed：空名单全放行（不限）', () => {
  assert.strictEqual(keysvc.accountAllowed({}, 'workbuddy', 1), true);
  assert.strictEqual(keysvc.accountAllowed({ account_allowlist: [] }, 'workbuddy', 1), true);
  assert.strictEqual(keysvc.accountAllowed(null, 'workbuddy', 1), true);
});

test('accountAllowed：裸 id 与 通道:id 两种写法都认', () => {
  const k1 = { account_allowlist: ['1', '2'] };
  assert.strictEqual(keysvc.accountAllowed(k1, 'workbuddy', 1), true);
  assert.strictEqual(keysvc.accountAllowed(k1, 'workbuddy', 3), false);
  assert.strictEqual(keysvc.accountAllowed(k1, 'workbuddy', '2'), true, '数字/字符串等价');

  const k2 = { account_allowlist: ['workbuddy:4'] };
  assert.strictEqual(keysvc.accountAllowed(k2, 'workbuddy', 4), true);
  assert.strictEqual(keysvc.accountAllowed(k2, 'traework', 4), false, '通道前缀要匹配');
  assert.strictEqual(keysvc.accountAllowed(k2, 'workbuddy', 5), false);
});

test('accountAllowed：缺 id 时不放行（fail-closed）', () => {
  const k = { account_allowlist: ['1'] };
  assert.strictEqual(keysvc.accountAllowed(k, 'workbuddy', null), false);
  assert.strictEqual(keysvc.accountAllowed(k, 'workbuddy', ''), false);
});

test('create / update：字段落盘并被 list 读回；未设置时是空数组', () => {
  reset();
  const { key } = keysvc.create({ name: 'acct-key', account_allowlist: ['1', 'workbuddy:2', '1'] });
  assert.deepStrictEqual(key.account_allowlist, ['1', 'workbuddy:2']);
  const row = keysvc.list().find((k) => k.id === key.id);
  assert.deepStrictEqual(row.account_allowlist, ['1', 'workbuddy:2']);

  keysvc.update(key.id, { account_allowlist: [] });
  assert.deepStrictEqual(keysvc.list().find((k) => k.id === key.id).account_allowlist, [], '清空 = 不限');

  const plain = keysvc.create({ name: 'no-acct' });
  assert.deepStrictEqual(plain.key.account_allowlist, [], '未设置时是空数组（不是 undefined）');
  reset();
});

test('旧 key（无该字段）行为不变：accountAllowed 回退为不限', () => {
  reset();
  // 直接写一个老形状的 key（没有 account_allowlist 字段）
  keysvc.save({
    keys: [{
      id: 1, name: 'legacy', prefix: 'dmk_x', hash: keysvc.hash('dmk_legacy'),
      plain: 'dmk_legacy', created_at: Date.now(), enabled: true,
      ip_allowlist: [], model_allowlist: [], channel: '', region: '',
    }],
  });
  const k = keysvc.resolve('dmk_legacy');
  assert.ok(k);
  assert.strictEqual(keysvc.accountAllowed(k, 'workbuddy', 99), true, '老 key 不该被白名单误伤');
  reset();
});
