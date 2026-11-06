// test/verify-web-pool-token.js - web-pool token 生命周期离线验证（不需要起服务）
//
// 背景（2026-11-06，融合自社区项目 magpie-dumate 的 token 生命周期经验）：
//   1. token/get 回 401（cookie 失效）时旧票必死——不清缓存的话，后续每个请求
//      都要「僵尸票打网关吃 401 → 强刷回 token/get 再失败」两连败；
//   2. callModelStream 原来没有 401 强刷重试（callModel 有），而且 401 错误体
//      经 onChunk 进入调用方嗅探层后 committed 被置位，连故障转移都会被短路。
//      修法：首次尝试的 401 错误体在 streamOnce 内吞掉，包装层强刷 token 重试。
//
// 打桩方式：劫持 https.request（web-pool 顶层 require 的共享模块对象），
// 按剧本逐个出队响应——全离线，不触真实上游，不依赖账号数据。
const fs = require('fs');
const os = require('os');
const path = require('path');

// env 必须先于任何 src 模块加载（pool 落盘目录在 require 时固化）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-token-'));
process.env.DUMATE_ADMIN_DATA = TMP;
process.env.DUMATE_POOL_STATE = path.join(TMP, 'pool-state.json');
delete process.env.DUMATE_PROXY;

const https = require('https');
const EventEmitter = require('events');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ok  ' + name); } else { fail += 1; console.log('  FAIL ' + name); }
}
function section(t) { console.log('\n' + t); }

const TOKEN_PATH = '/api/dumate/app/token/get';
const GATEWAY_HOST = 'dumate-svc.baidu.com';
const FUTURE = (ms) => new Date(Date.now() + (ms || 3600e3)).toISOString();

// ---- https.request 劫持：剧本队列 + 请求日志 ----
const script = [];   // 每项是 () => ({ status, headers, body })
const reqlog = [];   // { hostname, path, auth }
const realRequest = https.request;
https.request = function hijack(opts, cb) {
  const entry = script.shift();
  reqlog.push({
    hostname: opts.hostname,
    path: opts.path,
    auth: (opts.headers && opts.headers.Authorization) || '',
  });
  const req = new EventEmitter();
  req.write = () => {};
  req.destroy = () => {};
  req.end = () => {
    const spec = entry ? entry() : { status: 599, headers: {}, body: '{"error":"script exhausted"}' };
    const res = new EventEmitter();
    res.statusCode = spec.status;
    res.headers = spec.headers || {};
    res.setEncoding = () => {};
    res.resume = () => {};
    process.nextTick(() => {
      cb(res);
      // data/end 照发：401 吞体分支没挂监听器，emit 无监听器无害
      res.emit('data', spec.body == null ? '{}' : spec.body);
      res.emit('end');
    });
  };
  return req;
};

const pool = require('../src/web-pool');
const acc = (id) => ({ id, cookie: 'BDUSS=stub-' + id });
// 剧本工厂（push 的是函数本身，不出队不执行）
const TOKEN_OK = (t) => () => ({
  status: 200, headers: {}, body: JSON.stringify({ result: { token: t, expired_at: FUTURE() } }),
});
const TOKEN_401 = () => ({ status: 401, headers: {}, body: JSON.stringify({ message: 'login required' }) });
const GW_401 = () => ({ status: 401, headers: {}, body: JSON.stringify({ error: { message: 'token invalid' } }) });
const GW_SSE = () => ({
  status: 200,
  headers: { 'x-dumate-gw-realmodel': 'glm-53' },
  body: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
});
// 每节从零开始：清剧本残留 + 清请求日志（计数断言因此都是绝对值）
function reset() {
  script.length = 0;
  reqlog.length = 0;
}
const tokenGets = () => reqlog.filter((r) => r.path === TOKEN_PATH).length;
const gatewayCalls = () => reqlog.filter((r) => r.hostname === GATEWAY_HOST).length;
const gwAuths = () => reqlog.filter((r) => r.hostname === GATEWAY_HOST).map((r) => r.auth);

(async () => {
  // ---------------- 1. 缓存与单飞 ----------------
  section('1. token 缓存与并发单飞');
  reset();
  script.push(TOKEN_OK('T1'));
  const a1 = acc(8101);
  const first = await pool.getToken(a1);
  ok(first.ok && first.token === 'T1', '首次取票成功（T1）');
  const [c1, c2, c3] = await Promise.all([
    pool.getToken(a1), pool.getToken(a1), pool.getToken(a1),
  ]);
  ok(c1.token === 'T1' && c2.token === 'T1' && c3.token === 'T1', '并发读全命中缓存');
  ok(tokenGets() === 1, `并发只打一次 token/get（实际 ${tokenGets()}）`);
  ok(pool.stateOf(a1.id).refreshing === null, '单飞槽位用后即清');

  // ---------------- 2. callModel 401 强刷重试（既有行为回归） ----------------
  section('2. callModel 401 → 强刷重试（既有行为回归）');
  reset();
  const a2 = acc(8102);
  script.push(TOKEN_OK('T2a'), GW_401, TOKEN_OK('T2b'), GW_SSE);
  const r2 = await pool.callModel(a2, '/chat/completions', 'POST',
    { model: 'model-text', messages: [], max_tokens: 1 });
  ok(r2.ok === true, '强刷后重试成功');
  ok(tokenGets() === 2 && gatewayCalls() === 2, `请求序列 = 2 次取票 + 2 次网关（${tokenGets()}/${gatewayCalls()}）`);
  const auths2 = gwAuths();
  ok(auths2[0] === 'Bearer T2a' && auths2[1] === 'Bearer T2b', '重试请求带新票（T2b）');

  // ---------------- 3. callModelStream 401 吞体强刷重试 ----------------
  section('3. callModelStream 401 → 错误体不上 onChunk，强刷重试');
  reset();
  const a3 = acc(8103);
  script.push(TOKEN_OK('T3a'), GW_401, TOKEN_OK('T3b'), GW_SSE);
  const chunks3 = [];
  const r3 = await pool.callModelStream(a3, '/chat/completions', 'POST',
    { model: 'model-text', messages: [], stream: true }, (c) => chunks3.push(String(c)));
  ok(r3.ok === true, '流式强刷后重试成功');
  ok(!chunks3.some((c) => c.includes('token invalid')), '首次 401 错误体未泄漏给调用方');
  ok(chunks3.some((c) => c.startsWith('data:')), '重试的 SSE 帧正常透传');
  ok(tokenGets() === 2 && gatewayCalls() === 2, `序列 = 2 次取票 + 2 次网关（${tokenGets()}/${gatewayCalls()}）`);
  const auths3 = gwAuths();
  ok(auths3[0] === 'Bearer T3a' && auths3[1] === 'Bearer T3b', '重试流式请求带新票（T3b）');

  // ---------------- 4. 重试仍 401 → 错误体按原样交出 ----------------
  section('4. 重试仍 401 → 错误体照喂 onChunk（不无限重试）');
  reset();
  const a4 = acc(8104);
  script.push(TOKEN_OK('T4a'), GW_401, TOKEN_OK('T4b'), GW_401);
  const chunks4 = [];
  const r4 = await pool.callModelStream(a4, '/chat/completions', 'POST',
    { model: 'model-text', messages: [], stream: true }, (c) => chunks4.push(String(c)));
  ok(r4.ok === false && r4.status === 401, '最终失败如实上报 401');
  ok(chunks4.some((c) => c.includes('token invalid')), '第二次错误体经 onChunk 交出（与旧行为一致）');
  ok(tokenGets() === 2 && gatewayCalls() === 2, `只重试一次（${tokenGets()}/${gatewayCalls()}）`);

  // ---------------- 5. token/get 401 → 清缓存 ----------------
  section('5. token/get 401（cookie 失效）→ 缓存当场作废');
  reset();
  const a5 = acc(8105);
  script.push(TOKEN_OK('T5a'), TOKEN_401);
  ok((await pool.getToken(a5)).ok, '先建立缓存（T5a）');
  const r5 = await pool.getToken(a5, true);
  ok(r5.ok === false && r5.expired === true, 'token/get 401 如实上报 expired');
  const st5 = pool.stateOf(a5.id);
  ok(st5.token === null && st5.token_expire_at === 0, '僵尸票已被清掉');

  // ---------------- 6. cookie 死后的最短失败路径 ----------------
  section('6. cookie 死后 callModel 走最短失败路径');
  reset();
  script.push(TOKEN_401);
  const r6 = await pool.callModel(a5, '/chat/completions', 'POST',
    { model: 'model-text', messages: [], max_tokens: 1 });
  ok(r6.ok === false && r6.status === 401 && r6.expired === true, '请求失败且标 expired');
  ok(tokenGets() === 1 && gatewayCalls() === 0,
    `只打了一次 token/get，没拿旧票去撞网关（${tokenGets()}/${gatewayCalls()}）`);

  console.log(`\n${pass} passed, ${fail} failed`);
  https.request = realRequest;
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('driver error:', e);
  https.request = realRequest;
  process.exit(1);
});
