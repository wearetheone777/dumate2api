// test/verify-web-pool-token-host.js - token 签发域容灾的离线验证（不需要起服务）
//
// 2026-11-15 真机实测（账号 1 / 我谁敌）：`www.dumate.cn` 与 `console.bce.baidu.com`
// 两个域签出的 token **完全相同**（长度 36、同一个 expired_at），且 console 域签的
// token 打模型 200。所以本仓把签 token 改成「按候选域依次尝试」，纯容灾。
//
// 本脚本锁九条边界：
//   ① 第一域 200 → 只用一域（不多打第二域）
//   ② 第一域网络错误 / 5xx / 非 JSON → 切第二域并成功
//   ③ 第一域 401 → **不切**（cookie 失效换域无意义，多打一次只是拉长失败路径）
//   ④ 两域都失败 → 错误信息里如实列出尝试过的域
//   ⑤ 成功后 token 进缓存，第二次调用不再发 token 请求
//   ⑥ 候选域去重且第一域来自 DUMATE_WEB_BASE
//   ⑦ 400 / 404 / 429 / 3xx 一律**不切**：这些不是「域挂了」，换域只会把
//      同一份 Cookie 多报给一个域（自建 base 场景下还可能是跨环境重放）
//   ⑧ 非生产 base（DUMATE_WEB_BASE 指向自建环境）**不追加** console 生产域
//   ⑨ base 的端口与路径前缀原样带进 token 请求
//
// 打桩：劫持 https.request（web-pool 顶层 require 的共享对象），按剧本出队。全离线。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-tokenhost-'));
process.env.DUMATE_ADMIN_DATA = TMP;
process.env.DUMATE_POOL_STATE = path.join(TMP, 'pool-state.json');
delete process.env.DUMATE_WEB_BASE;   // 用默认的第一域 www.dumate.cn
delete process.env.DUMATE_PROXY;

const https = require('https');
const EventEmitter = require('events');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ok  ' + name); } else { fail += 1; console.log('  FAIL ' + name); }
}

const TOKEN_PATH = '/api/dumate/app/token/get';
const FUTURE = () => new Date(Date.now() + 3600e3).toISOString();

// ---- https.request 劫持 ----
const script = [];
const reqlog = [];
https.request = function hijack(opts, cb) {
  const entry = script.shift();
  reqlog.push({ hostname: opts.hostname, path: opts.path });
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
      res.emit('data', spec.body == null ? '{}' : spec.body);
      res.emit('end');
    });
  };
  return req;
};

const pool = require('../src/web-pool');

const TOKEN_OK = (t) => () => ({ status: 200, headers: {}, body: JSON.stringify({ result: { token: t, expired_at: FUTURE() } }) });
const TOKEN_500 = () => ({ status: 500, headers: {}, body: '{"message":"upstream boom"}' });
const TOKEN_NETERR = () => ({ status: 0, headers: {}, body: null });   // httpsJSON 在 error 时 status 0
const TOKEN_HTML = () => ({ status: 200, headers: {}, body: '<html>login page</html>' });
const TOKEN_401 = () => ({ status: 401, headers: {}, body: '{"message":"login required"}' });

const H1 = 'www.dumate.cn';
const H2 = 'console.bce.baidu.com';
const tokenReqs = () => reqlog.filter((r) => r.path === TOKEN_PATH);
const reset = () => { script.length = 0; reqlog.length = 0; };

(async () => {
  console.log('① 第一域 200 → 只用一域');
  reset();
  script.push(TOKEN_OK('tok-ok'));
  let r = await pool.getToken({ id: 901, cookie: 'BDUSS=x' }, true);
  ok(r.ok && r.token === 'tok-ok', '拿到 token');
  ok(tokenReqs().length === 1, '只发了一次 token 请求');
  ok(tokenReqs()[0].hostname === H1, `第一域是 ${H1}`);

  console.log('\n② 第一域 500 → 切第二域');
  reset();
  script.push(TOKEN_500, TOKEN_OK('tok-second'));
  r = await pool.getToken({ id: 902, cookie: 'BDUSS=y' }, true);
  ok(r.ok && r.token === 'tok-second', '第二域救回');
  ok(tokenReqs().length === 2, '发了两次');
  ok(tokenReqs()[1].hostname === H2, `第二域是 ${H2}`);

  console.log('\n③ 第一域网络错误 → 切第二域');
  reset();
  script.push(TOKEN_NETERR, TOKEN_OK('tok-net'));
  r = await pool.getToken({ id: 903, cookie: 'BDUSS=z' }, true);
  ok(r.ok && r.token === 'tok-net', '网络错误后切域成功');

  console.log('\n④ 第一域回 HTML（被墙/跳登录页）→ 切第二域');
  reset();
  script.push(TOKEN_HTML, TOKEN_OK('tok-html'));
  r = await pool.getToken({ id: 904, cookie: 'BDUSS=w' }, true);
  ok(r.ok && r.token === 'tok-html', '非 JSON 也切域');

  console.log('\n⑤ 第一域 401 → 不切（cookie 失效，换域无意义）');
  reset();
  script.push(TOKEN_401, TOKEN_OK('tok-should-not-be-used'));
  r = await pool.getToken({ id: 905, cookie: 'BDUSS=bad' }, true);
  ok(!r.ok && r.expired === true, '如实报凭证失效');
  ok(tokenReqs().length === 1, '只发了一次（没有多打第二域）');

  console.log('\n⑥ 两域都失败 → 错误里列出尝试过的域');
  reset();
  script.push(TOKEN_500, TOKEN_500);
  r = await pool.getToken({ id: 906, cookie: 'BDUSS=none' }, true);
  ok(!r.ok, '失败');
  ok(/www\.dumate\.cn/.test(r.error) && /console\.bce\.baidu\.com/.test(r.error), '错误文本含两个域');
  ok(tokenReqs().length === 2, '两个域都试过');

  console.log('\n⑦ 成功后进缓存：第二次调用不再发 token 请求');
  reset();
  script.push(TOKEN_OK('tok-cache'));
  const a = await pool.getToken({ id: 907, cookie: 'BDUSS=c' }, true);
  reset();
  const b = await pool.getToken({ id: 907, cookie: 'BDUSS=c' }, false);
  ok(a.ok && b.ok && b.cached === true, '第二次命中缓存');
  ok(tokenReqs().length === 0, '缓存命中时零 token 请求');

  console.log('\n⑧ 400 / 404 / 429 / 3xx 一律不切域（不是「域挂了」）');
  const nonDown = [
    ['400', () => ({ status: 400, headers: {}, body: '{"message":"bad request"}' })],
    ['404', () => ({ status: 404, headers: {}, body: '{"message":"not found"}' })],
    ['429', () => ({ status: 429, headers: {}, body: '{"message":"slow down"}' })],
    ['302', () => ({ status: 302, headers: {}, body: '{"redirect":true}' })],
  ];
  for (let i = 0; i < nonDown.length; i++) {
    const [label, mk] = nonDown[i];
    reset();
    script.push(mk, TOKEN_OK('tok-should-not-be-used'));
    r = await pool.getToken({ id: 910 + i, cookie: 'BDUSS=q' }, true);
    ok(!r.ok && tokenReqs().length === 1, `${label} 只打第一域，不把 Cookie 报给第二域`);
  }

  console.log('\n⑨ 非生产 base：不追加 console 生产域（凭证不跨环境重放）');
  const childCmd = `
    const path = require('path');
    const EventEmitter = require('events');
    const https = require('https');
    https.request = function (opts, cb) {
      process.stdout.write(JSON.stringify({ host: opts.hostname, port: opts.port || '', path: opts.path }) + '\\n');
      const req = new EventEmitter();
      req.write = () => {}; req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200; res.setEncoding = () => {};
        process.nextTick(() => {
          cb(res);
          res.emit('data', JSON.stringify({ result: { token: 't', expired_at: new Date(Date.now() + 3600e3).toISOString() } }));
          res.emit('end');
        });
      };
      return req;
    };
    require(${JSON.stringify(path.resolve(__dirname, '../src/web-pool'))})
      .getToken({ id: 1, cookie: 'BDUSS=x' }, true)
      .then((r) => process.stdout.write(JSON.stringify({ ok: r.ok, hosts: require(${JSON.stringify(path.resolve(__dirname, '../src/web-pool'))}).TOKEN_HOSTS.length }) + '\\n'));
  `;
  const out = execFileSync(process.execPath, ['-e', childCmd], {
    env: { ...process.env, DUMATE_WEB_BASE: 'https://staging.internal:8443/console', DUMATE_ADMIN_DATA: TMP },
    encoding: 'utf8',
  }).trim().split('\n');
  const reqLine = JSON.parse(out[0]);
  const tail = JSON.parse(out[out.length - 1]);
  ok(tail.hosts === 1, '自建 base 时只有一个候选域（console 不追加）');
  ok(reqLine.host === 'staging.internal' && String(reqLine.port) === '8443', `端口原样带上（${reqLine.host}:${reqLine.port}）`);
  ok(reqLine.path === '/console/api/dumate/app/token/get', `路径前缀原样保留（${reqLine.path}）`);

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}（pass ${pass} / fail ${fail}）`);
  process.exit(fail === 0 ? 0 : 1);
})();
