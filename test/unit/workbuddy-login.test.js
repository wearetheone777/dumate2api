// test/unit/workbuddy-login.test.js - WorkBuddy OAuth 设备授权登录的离线验证
//
// 协议来源（交叉验证）：linguo2625469/workbuddy2api-panel cmd/login/main.go +
// ardeyouxipianyi/workbuddy2api-hub wb_accounts.py start_login/poll_login。
// 本文件锁：state/token 信封解析、pending=11217、到期时刻归一化、区域红线、
// JWT uid 回落，以及「登录成功 → 账号入池（source=oauth）」的完整编排。
const { test } = require('node:test');
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// 账号池写临时目录（auth store 落盘）
process.env.DUMATE_ADMIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-wb-login-'));

const login = require('../../src/workbuddy/login');
const authStore = require('../../src/workbuddy/auth');

/** 造一个 JWT（payload 用 base64url，不校验签名） */
function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`;
}

test('parseAuthState：成功 / 业务错误 / 缺字段', () => {
  assert.deepEqual(
    login.parseAuthState({ code: 0, data: { state: 's1', authUrl: 'https://copilot.tencent.com/login?platform=CLI&state=s1' } }),
    { ok: true, state: 's1', authUrl: 'https://copilot.tencent.com/login?platform=CLI&state=s1' },
  );
  const bad = login.parseAuthState({ code: 1, msg: 'boom' });
  assert.equal(bad.ok, false);
  assert.ok(/boom/.test(bad.error));
  assert.equal(login.parseAuthState({ code: 0, data: { state: 's1' } }).ok, false);
});

test('parseTokenDoc：pending=11217 / 业务错误 / 缺 accessToken 仍算 pending', () => {
  assert.equal(login.parseTokenDoc({ code: 11217, msg: 'login ing' }).status, 'pending');
  const err = login.parseTokenDoc({ code: 40001, msg: 'bad state' });
  assert.equal(err.status, 'error');
  assert.ok(/40001/.test(err.error));
  assert.equal(login.parseTokenDoc({ code: 0, data: {} }).status, 'pending');
  const ok = login.parseTokenDoc({
    code: 0,
    data: { accessToken: 'at', refreshToken: 'rt', domain: 'copilot.tencent.com', expiresIn: 3600 },
  });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.token.refreshToken, 'rt');
  assert.ok(ok.token.expiresAt > Date.now() + 3000 * 1000);
});

test('expiryOf：毫秒/秒/expiresIn/JWT exp 四种口径', () => {
  const now = Date.now();
  const ms = now + 86400000;
  assert.equal(login.expiryOf({ expiresAt: ms }, ''), ms);
  assert.equal(login.expiryOf({ expiresAt: Math.floor(ms / 1000) }, ''), Math.floor(ms / 1000) * 1000);
  assert.ok(login.expiryOf({ expiresIn: 60 }, '') >= now + 59000);
  const exp = Math.floor(ms / 1000);
  assert.equal(login.expiryOf({}, fakeJwt({ sub: 'u', exp })), exp * 1000);
  assert.equal(login.expiryOf(null, ''), null);
});

test('checkRegion：区域红线（域名字样按 hub 的三组标记）', () => {
  assert.equal(login.checkRegion('cn', '').ok, true, '域名缺省信任请求区域');
  assert.equal(login.checkRegion('cn', 'copilot.tencent.com').ok, true);
  assert.equal(login.checkRegion('cn', 'www.workbuddy.cn').ok, true);
  assert.equal(login.checkRegion('cn', 'www.workbuddy.ai').ok, false);
  assert.equal(login.checkRegion('global', 'www.workbuddy.ai').ok, true);
  assert.equal(login.checkRegion('global', 'codebuddy.ai').ok, true);
  assert.equal(login.checkRegion('global', 'copilot.tencent.com').ok, false);
});

test('jwtClaims：sub/exp 解析；坏 token 给空对象', () => {
  const t = fakeJwt({ sub: 'uid-1', exp: 1900000000 });
  assert.equal(login.jwtClaims(t).sub, 'uid-1');
  assert.equal(login.jwtClaims('not-a-jwt').sub, undefined);
  assert.deepEqual(login.jwtClaims(''), {});
});

test('端到端（打桩请求层）：startLogin → pending → ok 入池 source=oauth', async () => {
  const calls = [];
  const token = fakeJwt({ sub: 'uid-oauth-1', exp: Math.floor(Date.now() / 1000) + 7200 });
  const script = [
    // state
    { status: 200, doc: { code: 0, data: { state: 'st-1', authUrl: 'https://copilot.tencent.com/login?platform=CLI&state=st-1' } } },
    // 第一次 poll：未登录
    { status: 200, doc: { code: 11217, msg: 'login ing' } },
    // 第二次 poll：登录完成
    { status: 200, doc: { code: 0, data: { accessToken: token, refreshToken: 'rt-1', domain: 'copilot.tencent.com', expiresIn: 7200 } } },
    // login/account
    { status: 200, doc: { code: 0, data: { uid: 'uid-oauth-1', nickname: '测试号', enterpriseId: 'ent-1' } } },
  ];
  login._setRequest(async (region, method, p) => {
    calls.push({ region, method, p });
    return script.shift() || { status: 500, doc: null };
  });
  try {
    const started = await login.startLogin('cn');
    assert.equal(started.ok, true);
    assert.equal(started.state, 'st-1');
    assert.ok(/platform=CLI/.test(started.authUrl));

    const p1 = await login.pollLogin('cn', 'st-1');
    assert.equal(p1.status, 'pending');

    const p2 = await login.pollLogin('cn', 'st-1');
    assert.equal(p2.status, 'ok');
    assert.equal(p2.account.uid, 'uid-oauth-1');
    assert.equal(p2.account.nickname, '测试号');
    assert.equal(p2.account.source, 'oauth');
    assert.equal(p2.account.enterpriseName, '');
    // 入池后可用（access+refresh 齐全）
    assert.ok(authStore.findUsable().some((a) => a.uid === 'uid-oauth-1' && a.region === 'cn'));
    // 请求顺序与路径
    assert.equal(calls[0].p, '/v2/plugin/auth/state?platform=CLI');
    assert.ok(calls[1].p.startsWith('/v2/plugin/auth/token?state=st-1'));
    assert.ok(calls[3].p.startsWith('/v2/plugin/login/account?state=st-1'));
  } finally {
    login._setRequest(null);
  }
});

test('端到端：区域不符拒绝入池；refreshToken 缺失拒绝；login/account 失败回落 JWT sub', async () => {
  const token = fakeJwt({ sub: 'uid-fallback', exp: Math.floor(Date.now() / 1000) + 7200 });
  // 1) 国际 token 打到国内区域
  login._setRequest(async () => ({
    status: 200,
    doc: { code: 0, data: { accessToken: token, refreshToken: 'rt', domain: 'www.workbuddy.ai' } },
  }));
  const r1 = await login.pollLogin('cn', 'st-x');
  assert.equal(r1.status, 'error');
  assert.ok(/国际版/.test(r1.error));

  // 2) 没有 refreshToken
  login._setRequest(async () => ({
    status: 200,
    doc: { code: 0, data: { accessToken: token, domain: 'copilot.tencent.com' } },
  }));
  const r2 = await login.pollLogin('cn', 'st-x');
  assert.equal(r2.status, 'error');
  assert.ok(/refreshToken/.test(r2.error));

  // 3) account 端点失败 → uid 从 JWT sub 取
  let n = 0;
  login._setRequest(async () => {
    n++;
    if (n === 1) {
      return { status: 200, doc: { code: 0, data: { accessToken: token, refreshToken: 'rt-2', domain: 'copilot.tencent.com' } } };
    }
    return { status: 500, doc: null };
  });
  const r3 = await login.pollLogin('cn', 'st-y');
  assert.equal(r3.status, 'ok');
  assert.equal(r3.account.uid, 'uid-fallback');
  login._setRequest(null);
});

test('端到端：网络错误按 pending 返回（不误报失败）', async () => {
  login._setRequest(async () => ({ status: 0, doc: null, raw: 'ECONNRESET' }));
  const r = await login.pollLogin('cn', 'st-z');
  assert.equal(r.status, 'pending');
  assert.ok(/网络错误/.test(r.error));
  login._setRequest(null);
});
