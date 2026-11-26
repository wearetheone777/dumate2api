// test/unit/qwen-import-fingerprint.test.js - 千问导入登录态与单号换指纹（2026-11-27 融合 A4/A5）
//
// 锁 src/qwenwork/auth.js 的 upsert / patch / genMachineId 语义：
//   - 导入：按 uid 去重，覆盖 token，不重复建号
//   - 换指纹：只改 machineId + 清 lastError，不动 token/uid
const { test, beforeEach } = require('node:test');
const assert = require('assert');
const os = require('os');
const path = require('path');

const fs = require('fs');
let auth;
beforeEach(() => {
  // 每个用例一个全新数据目录：auth.js 按 mtime 缓存、filelock 按路径缓存，
  // 只有换目录才能彻底隔离（删文件后 mtime 回 -1 不会让旧缓存失效）。
  process.env.DUMATE_ADMIN_DATA = path.join(os.tmpdir(), `qw-import-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(process.env.DUMATE_ADMIN_DATA, { recursive: true });
  Object.keys(require.cache).filter((k) => k.includes('/src/qwenwork/auth.js')).forEach((k) => delete require.cache[k]);
  auth = require('../../src/qwenwork/auth');
});

test('A4：导入新账号（access + uid）', () => {
  const rec = auth.upsert({
    accessToken: 'at-import', refreshToken: 'rt-import',
    uid: 'uid-import', nickname: '导入号', machineId: 'mid-import',
  });
  assert.strictEqual(rec.id, 1);
  // list() 返回公开脱敏视图（不含 token），完整凭证要用 get()
  assert.strictEqual(auth.list().length, 1);
  const full = auth.get(rec.id);
  assert.strictEqual(full.accessToken, 'at-import');
  assert.strictEqual(full.nickname, '导入号');
});

test('A4：同 uid 重复导入 → 覆盖而非建新号', () => {
  auth.upsert({ accessToken: 'old', uid: 'same-uid', machineId: 'm1' });
  auth.upsert({ accessToken: 'new', uid: 'same-uid', machineId: 'm2' });
  assert.strictEqual(auth.list().length, 1, '不该建两个账号');
  assert.strictEqual(auth.get(1).accessToken, 'new');
});

test('A4：无 uid 的导入不按 token 去重（允许不同 access）', () => {
  auth.upsert({ accessToken: 'a1', machineId: 'm1' });
  auth.upsert({ accessToken: 'a2', machineId: 'm2' });
  assert.strictEqual(auth.list().length, 2);
});

test('A5：换指纹只改 machineId，不动 token/uid', () => {
  auth.upsert({
    accessToken: 'at', refreshToken: 'rt', uid: 'u1',
    machineId: 'old-mid', nickname: '测试号', lastError: '旧错误',
  });
  const a = auth.list()[0];
  const newMid = auth.genMachineId();
  auth.patch(a.id, { machineId: newMid, lastError: '', lastErrorAt: null });
  const after = auth.get(a.id);
  assert.strictEqual(after.machineId, newMid);
  assert.strictEqual(after.accessToken, 'at');
  assert.strictEqual(after.refreshToken, 'rt');
  assert.strictEqual(after.uid, 'u1');
  assert.strictEqual(after.lastError, '');
  assert.strictEqual(after.lastErrorAt, null);
});

test('A5：genMachineId 每次返回不同值', () => {
  const a = auth.genMachineId();
  const b = auth.genMachineId();
  assert.ok(a && b);
  assert.notStrictEqual(a, b);
});

test('导入的账号默认 enabled=true 且第一个账号自动 preferred', () => {
  const rec = auth.upsert({ accessToken: 'at', uid: 'u1', machineId: 'm' });
  assert.strictEqual(rec.enabled, true);
  assert.strictEqual(auth.get(rec.id).preferred, true);
});
