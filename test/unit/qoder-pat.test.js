// test/unit/qoder-pat.test.js - PAT 导入与凭证族路由（2026-11-01，hub 口径）
//
// 端点与请求形状取自 qoder2api-hub（import_pat / refresh 的凭证族路由）。
// 网络层不做离线断言（真机已在落地时探测：假 pt- 命中端点回业务错误）。
const { test } = require('node:test');
const assert = require('node:assert');
const session = require('../../src/qoder/session');

test('tokenFamilyOf：drt-/jrt-/PAT/空 四族', () => {
  assert.equal(session.tokenFamilyOf({ refreshToken: 'drt-abc' }), 'device');
  assert.equal(session.tokenFamilyOf({ refreshToken: 'jrt-abc' }), 'job');
  assert.equal(session.tokenFamilyOf({ refreshToken: '', personalToken: 'pt-x' }), 'pat');
  assert.equal(session.tokenFamilyOf({ refreshToken: '' }), 'device');
  // 无 rt 但带 drt 前缀判断不受 personalToken 干扰
  assert.equal(session.tokenFamilyOf({ refreshToken: 'drt-x', personalToken: 'pt-x' }), 'device');
});

test('importPat：非 pt- 前缀直接拒（不打上游）', async () => {
  const r = await session.importPat('jt-not-a-pat', 'cn');
  assert.equal(r.ok, false);
  assert.ok(/pt-/.test(r.error), r.error);
  const r2 = await session.importPat('', 'cn');
  assert.equal(r2.ok, false);
});
