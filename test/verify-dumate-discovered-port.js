// 回归：issue #8 —— 桌面链路的 dumate-main-server.exe 用随机端口时，
// 启动时 discoverPort() 发现的端口必须真正用于转发，而不是只写进 /health。
//
// 根因：router 的 dumate.defaultPort=8980 恒有值，forwardWithFallback 里
// `!t.port` 的发现分支永远走不到；真实端口只存在 server.js 的 upstreamPort
// 模块变量里。结果是连 127.0.0.1:8980 → ECONNREFUSED → 502
// "DuMate upstream unavailable"。
//
// 本测试用两个真实 HTTP 服务器：
//   假 DuMate 后端（随机端口）→ 回一个 OpenAI chat.completion；
//   假网关（独立子进程，加载真 server.js）→ 转发请求到 router target。
// discoverPort 在假网关进程里被打桩，返回假后端端口；断言客户端拿到的是
// 假后端答案而不是 502，且假后端确实收到请求（证明端口被用上）。
//
// 同时验证：
//   · 显式 DUMATE_UPSTREAM_PORT：优先级高于发现端口（用户钉死端口）。
// 全部离线：不碰真实 DuMate / 真实凭证，也不需要任何运行中的服务。
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
function freePort() {
  const srv = http.createServer();
  return listen(srv).then((port) => close(srv).then(() => port));
}

// 用子进程跑真 server.js，注入受控的 discoverPort 结果。
// extra 在 require('src/server.js') 之前执行。
function spawnGateway({ port, discovered, extra = '' }) {
  const src = `
    process.env.DUMATE2API_PORT = ${JSON.stringify(String(port))};
    process.env.DUMATE2API_HOST = '127.0.0.1';
    process.env.DUMATE_AUTOSTART = 'off';
    process.env.DUMATE_ADMIN_DATA = ${JSON.stringify(path.join(ROOT, 'data'))};
    process.env.DUMATE2API_KEY = '{{SECRET_gateway_key}}';
    process.env.DUMATE_DUMATE_SOURCE = 'auto';
    ${extra}
    const path = require('path');
    const ROOT = ${JSON.stringify(ROOT)};
    const Module = require('module');
    const dp = require.resolve(path.join(ROOT, 'src/discovery.js'));
    const real = require(dp);
    require.cache[dp] = new Module(dp, null);
    require.cache[dp].filename = dp;
    require.cache[dp].loaded = true;
    require.cache[dp].exports = Object.assign({}, real, {
      discoverPort: async () => { console.log('__DISCOVERED__'); return ${JSON.stringify(discovered)}; },
      verifyPort: async () => true,
    });
    require(path.join(ROOT, 'src/server.js'));
  `;
  const child = spawn(process.execPath, ['-e', src]);
  let stdout = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stdout += c; });
  const closed = new Promise((resolve) => child.once('close', resolve));
  return { child, closed, stdout: () => stdout };
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {
      model: 'glm-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16,
    });
    const rq = http.request({
      host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': 'Bearer {{SECRET_gateway_key}}',
      },
    }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
      res.on('error', reject);
    });
    rq.on('error', reject);
    rq.setTimeout(5000, () => rq.destroy(new Error('request timeout')));
    rq.write(data);
    rq.end();
  });
}
function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    rq.on('error', reject);
    rq.end();
  });
}

async function waitUp(port, handle) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (handle.stdout().includes('Fatal:')) throw new Error('gateway fatal: ' + handle.stdout().slice(-500));
    try { await get(port, '/ping'); return true; } catch (e) { /* 还没起来 */ }
  }
  return false;
}

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${cond ? '' : '  ← ' + (detail || '')}`);
}

(async () => {
  // 假 DuMate 后端：只在 /api/qianfanproxy/v1/chat/completions 回一个确定性答案
  let hits = 0;
  function makeBackend(label) {
    return http.createServer((req, res) => {
      hits++;
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'real-backend', object: 'chat.completion', created: 1, model: 'glm-5',
          choices: [{ index: 0, message: { role: 'assistant', content: label }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }));
      });
    });
  }
  const backend = makeBackend('FOUND_PORT');
  const backendPort = await listen(backend);
  const gwPort1 = await freePort();

  const g1 = spawnGateway({ port: gwPort1, discovered: backendPort });
  try {
    assert('测试网关启动成功', await waitUp(gwPort1, g1));
    assert('auto 模式启动时会做初始发现', g1.stdout().includes('__DISCOVERED__'));
    const h = JSON.parse((await get(gwPort1, '/health')).text);
    assert('health 报告同一个发现端口', h.upstream_port === backendPort,
      `upstream_port ${h.upstream_port} vs ${backendPort}`);

    const hitsBefore = hits;
    const r = await post(gwPort1);
    assert('发现端口用于转发：拿到假后端答案（不是 502）',
      r.status === 200 && r.text.includes('FOUND_PORT'), `status ${r.status} body ${r.text.slice(0, 200)}`);
    assert('假后端确实收到了请求（端口不是 8980）', hits === hitsBefore + 1, `hits ${hitsBefore} → ${hits}`);
  } finally {
    g1.child.kill();
    await g1.closed;
  }

  // 显式 DUMATE_UPSTREAM_PORT 优先于发现端口
  const backend2 = makeBackend('EXPLICIT_PORT');
  const explicitPort = await listen(backend2);
  const gwPort2 = await freePort();
  const g2 = spawnGateway({
    port: gwPort2, discovered: backendPort,
    extra: `process.env.DUMATE_UPSTREAM_PORT = '${explicitPort}';`,
  });
  try {
    assert('显式端口场景网关启动成功', await waitUp(gwPort2, g2));
    const hitsBefore = hits;
    const r = await post(gwPort2);
    assert('显式端口优先：请求使用显式端口而不是发现端口',
      r.status === 200 && r.text.includes('EXPLICIT_PORT') && hits === hitsBefore + 1,
      `hits ${hitsBefore} → ${hits}, status ${r.status}, body ${r.text.slice(0, 120)}`);
  } finally {
    g2.child.kill();
    await g2.closed;
  }
  await close(backend2);
  await close(backend);

  const pass = results.filter((x) => x.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
