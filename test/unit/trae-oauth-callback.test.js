// test/unit/trae-oauth-callback.test.js - 登录回环回调（node:test，真实 HTTP 到 127.0.0.1）
//
// 2026-11-16 调研 P0-2a。锁住的是**安全边界**，不是「能不能跳回来」：
//   · 只绑 127.0.0.1 + 校验 Host（防 DNS rebinding）
//   · state 单次消费、错的不许过、10 分钟到期、可取消
//   · 回调 query 不进日志（这里用「handler 之外没有任何地方拿到 url」间接验证）
//   · 换票失败如实报 failed，不重试
//   · 没带 state 的回调**放行但标记**（上游是否回显没有证据，不能一刀切）
//
// 不碰真实账号：handler 是假的，返回 {ok:true, account:{id:1}}。
const { test } = require('node:test');
const assert = require('assert');
const http = require('http');
const { createBroker, traceOf } = require('../../src/traework/oauth-callback');

/** 极简 GET（不走全局 fetch：要能伪造 Host 头） */
function get(url, hostHeader) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
      // agent:false = 每次一条新连接。Node 19+ 的默认 agent 会 keep-alive，
      // 复用的 socket 会让「监听已关」这条断言测不到点子上。
      agent: false,
      headers: hostHeader ? { Host: hostHeader } : {},
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    req.end();
  });
}

function okHandler(calls) {
  return async (url, session) => {
    calls.push({ url, sid: session.sid });
    return { ok: true, account: { id: 1, nickname: '假号' } };
  };
}

test('正常回调：接住 → handler 跑一次 → success，且监听已关', async () => {
  const b = createBroker();
  const calls = [];
  const s = await b.start({ port: 0, onCallback: okHandler(calls) });
  assert.match(s.redirect, /^http:\/\/127\.0\.0\.1:\d+\/authorize$/);
  assert.strictEqual(s.state.length, 64, 'state 32 字节 hex');

  const r = await get(`${s.redirect}?refreshToken=tok&userInfo=%7B%7D`);
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /登录成功/);
  assert.deepStrictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url.includes('refreshToken=tok'), true);

  const st = b.status(s.sessionId);
  assert.strictEqual(st.status, 'success');
  assert.deepStrictEqual(st.account, { id: 1, nickname: '假号' });
  // 监听已关：句柄置空 + 稍等一拍后应连不上（close() 不是同步生效的）
  assert.strictEqual(b.sessions.get(s.sessionId).server, null, '会话结束后必须置空监听句柄');
  await new Promise((r) => setTimeout(r, 60));
  const again = await get(`${s.redirect}?refreshToken=tok`);
  assert.strictEqual(again.status, 0, `会话结束后监听必须关掉（实际 ${again.status}）`);
  b.shutdown();
});

test('state 不匹配 → 403，且**不消费**（随后正确回调仍能成功）', async () => {
  const b = createBroker();
  const calls = [];
  const s = await b.start({ port: 0, onCallback: okHandler(calls) });

  const bad = await get(`${s.redirect}?refreshToken=x&login_trace_id=deadbeef`);
  assert.strictEqual(bad.status, 403);
  assert.strictEqual(calls.length, 0, '错的 state 不许触发换票');
  assert.strictEqual(b.status(s.sessionId).status, 'pending', '错回调不消费会话');

  const good = await get(`${s.redirect}?refreshToken=x&login_trace_id=${s.state}`);
  assert.strictEqual(good.status, 200);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(b.status(s.sessionId).trace_verified, true);
  b.shutdown();
});

test('没带 state 的回调：放行但标记 trace_verified=false（不猜上游行为）', async () => {
  const b = createBroker();
  const calls = [];
  const s = await b.start({ port: 0, onCallback: okHandler(calls) });
  const r = await get(`${s.redirect}?refreshToken=y`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(b.status(s.sessionId).trace_verified, false);
  b.shutdown();
});

test('单次消费：第二次回调 409，不再换票', async () => {
  const b = createBroker();
  const calls = [];
  const s = await b.start({ port: 0, onCallback: okHandler(calls) });
  await get(`${s.redirect}?refreshToken=a&login_trace_id=${s.state}`);
  const second = await b.complete(s.sessionId, `${s.redirect}?refreshToken=b&login_trace_id=${s.state}`,
    okHandler(calls));
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.status, 409);
  assert.strictEqual(calls.length, 1);
  b.shutdown();
});

test('Host 校验：伪造 Host → 403（DNS rebinding 防线）', async () => {
  const b = createBroker();
  const calls = [];
  const s = await b.start({ port: 0, onCallback: okHandler(calls) });
  const r = await get(`${s.redirect}?refreshToken=x`, 'evil.example.com');
  assert.strictEqual(r.status, 403);
  assert.strictEqual(calls.length, 0);
  b.shutdown();
});

test('只认 GET /authorize：别的路径 404', async () => {
  const b = createBroker();
  const s = await b.start({ port: 0, onCallback: okHandler([]) });
  const base = s.redirect.replace('/authorize', '');
  assert.strictEqual((await get(`${base}/other`)).status, 404);
  assert.strictEqual((await get(`${base}/`)).status, 404);
  b.shutdown();
});

test('取消：status=cancelled，回调 410，监听已关', async () => {
  const b = createBroker();
  const calls = [];
  const s = await b.start({ port: 0, onCallback: okHandler(calls) });
  assert.strictEqual(b.cancel(s.sessionId).ok, true);
  assert.strictEqual(b.status(s.sessionId).status, 'cancelled');
  const r = await b.complete(s.sessionId, `${s.redirect}?refreshToken=x`, okHandler(calls));
  assert.strictEqual(r.status, 410);
  assert.strictEqual(calls.length, 0);
  b.shutdown();
});

test('到期：超过 ttl 后回调 410，status=expired（注入时钟，不 sleep）', async () => {
  let t = 1000;
  const b = createBroker({ ttlMs: 5000, now: () => t });
  const calls = [];
  const s = await b.start({ port: 0, onCallback: okHandler(calls) });
  t += 6000;
  assert.strictEqual(b.status(s.sessionId).status, 'expired');
  const r = await b.complete(s.sessionId, `${s.redirect}?refreshToken=x`, okHandler(calls));
  assert.strictEqual(r.status, 410);
  assert.strictEqual(calls.length, 0);
  b.shutdown();
});

test('换票失败：status=failed + 原因如实，且不重试（只调一次 handler）', async () => {
  const b = createBroker();
  const calls = [];
  const s = await b.start({
    port: 0,
    onCallback: async (url) => { calls.push(url); return { ok: false, error: '换票失败 HTTP 500' }; },
  });
  const r = await get(`${s.redirect}?refreshToken=x&login_trace_id=${s.state}`);
  assert.strictEqual(r.status, 200, 'HTTP 200 但页面显示失败（回调已送达，业务失败）');
  assert.match(r.body, /换票失败 HTTP 500/);
  assert.strictEqual(calls.length, 1);
  const st = b.status(s.sessionId);
  assert.strictEqual(st.status, 'failed');
  assert.match(st.error, /HTTP 500/);
  b.shutdown();
});

test('未知 sessionId：status=not_found，complete 404（不泄露别的会话）', async () => {
  const b = createBroker();
  assert.strictEqual(b.status('nope').status, 'not_found');
  const r = await b.complete('nope', 'http://127.0.0.1/authorize?x=1', okHandler([]));
  assert.strictEqual(r.status, 404);
  assert.strictEqual(b.cancel('nope').ok, false);
  b.shutdown();
});

test('端口占用：start 如实拒绝并给出可执行建议（不静默换端口）', async () => {
  const b1 = createBroker();
  const s = await b1.start({ port: 0, onCallback: okHandler([]) });
  const taken = new URL(s.redirect).port;
  const b2 = createBroker();
  await assert.rejects(
    () => b2.start({ port: Number(taken), onCallback: okHandler([]) }),
    /已被占用|DUMATE_TRAEWORK_LOGIN_PORT/,
  );
  b1.shutdown();
  b2.shutdown();
});

test('traceOf：认几种字段名，取不到返回空串', () => {
  assert.strictEqual(traceOf('http://x/authorize?login_trace_id=abc'), 'abc');
  assert.strictEqual(traceOf('http://x/authorize?loginTraceID=def'), 'def');
  assert.strictEqual(traceOf('http://x/authorize?state=ghi'), 'ghi');
  assert.strictEqual(traceOf('http://x/authorize?refreshToken=t'), '');
  assert.strictEqual(traceOf(''), '');
});

// ---------------------------------------------------------------------------
// parseCallback：真机回调的两种形态（2026-11-17 小米平板实测）
// ---------------------------------------------------------------------------
const login = require('../../src/traework/login');

test('parseCallback：userInfo 原样带花括号（未百分号编码）也要解析出 uid/昵称', () => {
  const u = 'http://127.0.0.1:18080/authorize?refreshToken=TOKEN1&host=https://api.trae.com.cn'
    + '&userInfo={"ScreenName":"\u6d4b\u98de\u7684\u4f01\u9e45","UserID":"3675042082466132","TenantID":"t1"}';
  const p = login.parseCallback(u);
  assert.strictEqual(p.refreshToken, 'TOKEN1');
  assert.strictEqual(p.uid, '3675042082466132', '原样 JSON 必须能解析（先 decode 会抛错并被吞掉）');
  assert.strictEqual(p.nickname, '测飞的企鹅');
  assert.strictEqual(p.host, 'https://api.trae.com.cn');
});

test('parseCallback：值尾多一个逗号（真机粘贴里出现过）也能解析', () => {
  const u = 'http://127.0.0.1:18080/authorize?refreshToken=T'
    + '&userJwt={"RefreshToken":"JWT1"},&userInfo={"UserID":"42"},';
  const p = login.parseCallback(u);
  assert.strictEqual(p.jwtRefreshToken, 'JWT1', '尾逗号不该让整个值变空');
  assert.strictEqual(p.uid, '42');
});

test('parseCallback：两个候选 refresh token 都要交出来（顶层 vs JWT 内）', () => {
  const u = 'http://127.0.0.1:18080/authorize?refreshToken=TOP&userJwt={"RefreshToken":"INNER"}';
  const p = login.parseCallback(u);
  assert.strictEqual(p.refreshToken, 'TOP');
  assert.strictEqual(p.jwtRefreshToken, 'INNER');
  assert.notStrictEqual(p.refreshToken, p.jwtRefreshToken);
});

// ---------------------------------------------------------------------------
// P0-2b：授权码 + PKCE（纯计算部分；换票端点未在产品路径里猜）
// ---------------------------------------------------------------------------
test('newPkce：verifier 43 字符、challenge = base64url(sha256(verifier))（RFC 7636 附录 B 向量）', () => {
  const crypto = require('node:crypto');
  // RFC 7636 附录 B 的标准向量：给定 verifier，challenge 必须逐字节一致
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.strictEqual(
    crypto.createHash('sha256').update(verifier).digest('base64url'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
  const pk = login.newPkce();
  assert.strictEqual(pk.verifier.length, 43, '32 字节 base64url = 43 字符');
  assert.strictEqual(pk.challenge.length, 43);
  assert.strictEqual(
    crypto.createHash('sha256').update(pk.verifier).digest('base64url'),
    pk.challenge,
    'challenge 必须由 verifier 算出来（不是另取随机）',
  );
  assert.notStrictEqual(login.newPkce().verifier, pk.verifier, '每次都要新 verifier');
});

test('buildAuthCodeUrl：只在既有 URL 上追加 PKCE 两参，其余参数一个不动', () => {
  const ids = { deviceId: 'd'.repeat(32), machineId: 'm'.repeat(32) };
  // trace 每次随机，两处必须传同一个才可比（否则「没加参数」的断言会假失败）
  const plain = login.buildAuthUrl(ids, 'cn', { trace: 'T1' });
  const withPkce = login.buildAuthCodeUrl(ids, 'cn', { challenge: 'CH', trace: 'T1' });
  assert.ok(withPkce.includes('code_challenge=CH'));
  assert.ok(withPkce.includes('code_challenge_method=S256'));
  // 既有逆向参数必须还在（少一个就会被判非法客户端）
  for (const k of ['login_channel=native_ide', 'auth_callback_url=', 'login_trace_id=T1', 'client_id=']) {
    assert.ok(withPkce.includes(k), `缺少既有参数 ${k}`);
  }
  // 没有 challenge 时原样返回（不半吊子加一个空参数）
  assert.strictEqual(login.buildAuthCodeUrl(ids, 'cn', { trace: 'T1' }), plain);
});

test('parseAuthCodeCallback：authCodeInfo 两种编码 + 尾逗号；没有授权码时返回空串', () => {
  assert.strictEqual(
    login.parseAuthCodeCallback('http://127.0.0.1:18080/authorize?authCodeInfo={"AuthCode":"AC-1"}'),
    'AC-1',
  );
  assert.strictEqual(
    login.parseAuthCodeCallback('http://127.0.0.1:18080/authorize?authCodeInfo=%7B%22AuthCode%22%3A%22AC-2%22%7D'),
    'AC-2',
  );
  assert.strictEqual(
    login.parseAuthCodeCallback('http://127.0.0.1:18080/authorize?authCodeInfo={"AuthCode":"AC-3"},&x=1'),
    'AC-3',
    '尾逗号形态（真机粘贴出现过）也要能解',
  );
  assert.strictEqual(login.parseAuthCodeCallback('http://127.0.0.1:18080/authorize?refreshToken=R'), '',
    '这条登录不是授权码流程 → 空串，调用方据此判断');
  assert.strictEqual(login.parseAuthCodeCallback(''), '');
});
