// test/unit/workbuddy-group.test.js - 账号分组（M2.4）的存储语义
//
// 分组是自由标签：auth 存储只管「写进去、读出来、按组圈定」。route 层的
// 批量签到 filter 是一行 (a.group||'')===group，真正的语义边界在存储层——
// 这里锁定 upsert/patch/list/findUsable 四个口的 group 行为。
// 运行：node --test test/unit/workbuddy-group.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-wb-group-'));
process.env.DUMATE_ADMIN_DATA = TMP;

const auth = require('../../src/workbuddy/auth');

function reset() {
  const data = auth.load();
  data.accounts = [];
  auth.save(data);
}

test('upsert 直接带 group 字段入库', () => {
  reset();
  auth.upsert({ uid: 'g1', region: 'cn', accessToken: 'a', refreshToken: 'r', group: '生产组' });
  const rows = auth.list();
  assert.strictEqual(rows[0].group, '生产组');
});

test('patch 可以改组 / 空串移出分组', () => {
  reset();
  auth.upsert({ uid: 'g2', region: 'cn', accessToken: 'a', refreshToken: 'r', group: 'A' });
  const id = auth.list()[0].id;
  auth.patch(id, { group: 'B' });
  assert.strictEqual(auth.list()[0].group, 'B');
  auth.patch(id, { group: '' });
  assert.strictEqual(auth.list()[0].group, '', '空串 = 移出分组');
});

test('按组圈定可用账号（route 批量签到的同款口径）', () => {
  reset();
  auth.upsert({ uid: 'p1', region: 'cn', accessToken: 'a', refreshToken: 'r', group: '生产组' });
  auth.upsert({ uid: 'p2', region: 'cn', accessToken: 'a', refreshToken: 'r', group: '生产组' });
  auth.upsert({ uid: 'p3', region: 'cn', accessToken: 'a', refreshToken: 'r', group: '测试组' });
  auth.upsert({ uid: 'p4', region: 'cn', accessToken: 'a', refreshToken: 'r' }); // 未分组
  const byGroup = (g) => auth.findUsable().filter((a) => (a.group || '') === g);
  assert.strictEqual(byGroup('生产组').length, 2);
  assert.strictEqual(byGroup('测试组').length, 1);
  assert.strictEqual(byGroup('不存在的组').length, 0);
  // 未分组账号不会被任何组签到误伤
  const groups = ['生产组', '测试组'];
  const covered = groups.flatMap(byGroup).map((a) => a.uid);
  assert.ok(!covered.includes('p4'), '未分组账号不进任何组的批量范围');
});

test('禁用的账号不进组签到范围（findUsable 既有口径不被 group 破坏）', () => {
  reset();
  auth.upsert({ uid: 'p5', region: 'cn', accessToken: 'a', refreshToken: 'r', group: '生产组' });
  const id = auth.list()[0].id;
  auth.patch(id, { enabled: false });
  const byGroup = auth.findUsable().filter((a) => (a.group || '') === '生产组');
  assert.strictEqual(byGroup.length, 0, '停用账号不参与组签到');
});

test('同 uid 换组再 upsert：覆盖写入保留新组（upsert 的 merge 语义）', () => {
  reset();
  auth.upsert({ uid: 'g3', region: 'cn', accessToken: 'a', refreshToken: 'r', group: 'A' });
  auth.upsert({ uid: 'g3', region: 'cn', accessToken: 'a2', refreshToken: 'r2', group: 'C' });
  const rows = auth.list().filter((r) => r.uid === 'g3');
  assert.strictEqual(rows.length, 1, '同 uid+region 覆盖而不是新增');
  assert.strictEqual(rows[0].group, 'C');
});
