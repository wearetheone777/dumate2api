// test/unit/admin-users.test.js - 管理端多账户（2026-11-01）
//
// admin-users.json 本来就是多账户结构，本次补齐管理接口与角色强制。
// auth.js 的 DATA_DIR 在模块加载时定死，所以本文件先设 DUMATE_ADMIN_DATA
// 再 require（node --test 每个测试文件独立子进程，互不污染真实 data/）。
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-admin-users-'));
process.env.DUMATE_ADMIN_DATA = TMP;

const auth = require('../../src/admin/auth');
const { userFieldsProblem } = require('../../src/admin/routes/auth');

test('userFieldsProblem：用户名/密码/角色的字段校验', () => {
  assert.equal(userFieldsProblem('ops-01', 'password123', 'viewer'), null);
  assert.equal(userFieldsProblem('ab', 'password123', 'admin'), null);
  assert.ok(userFieldsProblem('a', 'password123', 'viewer'), '用户名太短应拒');
  assert.ok(userFieldsProblem('x'.repeat(33), 'password123', 'viewer'), '用户名太长应拒');
  assert.ok(userFieldsProblem('中文名', 'password123', 'viewer'), '非 ASCII 用户名应拒');
  assert.ok(userFieldsProblem('ops-01', 'short', 'viewer'), '密码太短应拒');
  assert.ok(userFieldsProblem('ops-01', '', 'viewer'), '空密码应拒');
  assert.ok(userFieldsProblem('ops-01', 'password123', 'root'), '非法 role 应拒');
});

test('bootstrap：首次启动生成唯一 admin', () => {
  const { created } = auth.bootstrapUsers();
  assert.ok(created, '首次启动应产出初始密码');
  const data = auth.users();
  assert.equal(Object.keys(data).length, 1);
  assert.equal(data.admin.role, 'admin');
});

beforeEach(() => { /* 每个用例共享同一个临时库即可，用例自己创建所需用户 */ });

test('创建 viewer 后可以登录并拿到角色', async () => {
  const data = auth.users();
  data['ops-01'] = {
    username: 'ops-01', role: 'viewer',
    hash: auth.makeHash('password123'), created_at: Date.now(), session_version: 0,
  };
  auth.saveUsers(data);

  const stored = auth.users()['ops-01'];
  assert.ok(await auth.verifyPwd('password123', stored.hash), '口令应可校验');
  assert.ok(!(await auth.verifyPwd('wrong-password', stored.hash)), '错误口令应拒绝');

  const token = auth.issueToken('ops-01', 'viewer');
  const req = { headers: { cookie: `${auth.COOKIE_NAME}=${encodeURIComponent(token)}` } };
  const user = auth.currentUser(req);
  assert.deepEqual(user, { username: 'ops-01', role: 'viewer' });
});

test('revokeSessions 后旧 token 立即失效（改密踢会话的底层）', () => {
  const token = auth.issueToken('ops-01', 'viewer');
  const req = { headers: { cookie: `${auth.COOKIE_NAME}=${encodeURIComponent(token)}` } };
  assert.ok(auth.currentUser(req), '会话应有效');
  auth.revokeSessions('ops-01');
  assert.equal(auth.currentUser(req), null, '版本号递增后旧 token 应失效');
});

test('viewer 的 token 带 role=viewer（router 层据此拒写）', () => {
  const token = auth.issueToken('ops-01', 'viewer');
  const req = { headers: { cookie: `${auth.COOKIE_NAME}=${encodeURIComponent(token)}` } };
  assert.equal(auth.currentUser(req).role, 'viewer');
});

test('删除用户的字典操作与最后 admin 保护口径一致（路由层判例的依据）', () => {
  // 路由层的「最后一个 admin」保护用 Object.values().filter(role==='admin') 计数——
  // 这里锁住该口径：只有一个 admin 时删除它应被判定拒绝。
  const data = auth.users();
  const admins = Object.values(data).filter((u) => u.role === 'admin');
  assert.equal(admins.length, 1, '当前只有 bootstrap 的 admin');
  // 模拟路由层的判定逻辑
  const canDelete = (username) => {
    const u = data[username];
    if (!u || u.role !== 'admin') return true;
    return Object.values(data).filter((x) => x.role === 'admin').length > 1;
  };
  assert.equal(canDelete('admin'), false, '最后一个 admin 不可删');
  assert.equal(canDelete('ops-01'), true, 'viewer 可删');
});

test('parseToken 对篡改的签名返回 null', () => {
  const token = auth.issueToken('ops-01', 'viewer');
  const [payload] = token.split('.');
  const forged = `${payload}.${'0'.repeat(64)}`;
  assert.equal(auth.parseToken(forged), null);
});
