// test/proxy-agent.test.js - 施工包 E：出站代理隧道与工厂（node:test，全离线）
//
// 起本地假 CONNECT 代理 + 明文回显目标验证隧道建立与凭证头；TLS 端到端
// 用 openssl 运行时生成自签证书（机器无 openssl 则跳过该组，其余照跑）。
// 所有服务绑 127.0.0.1 临时端口，测试互不依赖、无外部网络。
//
// 注意：进入 CONNECT 隧道态的 socket 会脱离 http.Server 的连接跟踪
// （closeAllConnections 不覆盖，server.close 永远等不到排空），所以假代理
// 自己记录洞内 socket，close 时手动断——这是本文件所有 fixture 自带
// close() 的原因。
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('./helpers/tmpdir');

const {
  HttpConnectAgent,
  connectViaProxy,
  normalizeProxyUrl,
  redactProxyUrl,
  resolveProxyUrl,
  describeProxy,
  getAgentFor,
  setGlobalProxy,
  getGlobalProxy,
  clearAgentCache,
} = require('../src/proxy-agent');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** 假 CONNECT 代理：按 opts 决定要凭证 / 拒绝 / 停摆；成功时向目标转发并双向 pipe */
function startFakeProxy(opts = {}) {
  const state = { connects: [], authSeen: [] };
  const tunnels = new Set();
  const server = http.createServer((req, res) => { res.writeHead(500); res.end('not a connect'); });
  server.on('connect', (req, socket, head) => {
    tunnels.add(socket);
    socket.on('close', () => tunnels.delete(socket));
    state.connects.push(String(req.url));
    state.authSeen.push(req.headers['proxy-authorization'] || null);
    const fail = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`); socket.destroy(); };
    if (opts.requiredAuth) {
      const expect = `Basic ${Buffer.from(opts.requiredAuth).toString('base64')}`;
      if (req.headers['proxy-authorization'] !== expect) return fail(407, 'Proxy Authentication Required');
    }
    if (opts.rejectWith) return fail(opts.rejectWith.code, opts.rejectWith.msg);
    if (opts.stall) return; // 收到 CONNECT 但永不响应：测 CONNECT 超时
    const i = req.url.lastIndexOf(':');
    const target = net.connect(Number(req.url.slice(i + 1)), req.url.slice(0, i), () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) target.write(head);
      socket.pipe(target);
      target.pipe(socket);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
  });
  const close = () => new Promise((resolve) => {
    server.close(() => resolve());
    for (const s of tunnels) s.destroy();
    server.closeAllConnections();
  });
  return { state, port: listen(server), server, close };
}

/** 隧道对端的明文目标：收到 PING 回 PONG。net.Server 没有 closeAllConnections，socket 自记自断 */
function startEchoTarget() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => { if (chunk.toString().includes('PING')) socket.write('PONG\n'); });
  });
  const close = () => new Promise((resolve) => {
    server.close(() => resolve());
    for (const s of sockets) s.destroy();
  });
  return { port: listen(server), server, close };
}

/** TLS 目标：/ 回 JSON，统计连接数（验证 keepAlive 复用隧道）。连接是普通 https 请求，可被 closeAllConnections 覆盖 */
function startTlsTarget(cert) {
  let conns = 0;
  const server = https.createServer(cert, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  server.on('connection', () => { conns += 1; });
  const close = () => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  return { port: listen(server), server, close, conns: () => conns };
}

function makeSelfSignedCert(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  const r = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '2',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-keyout', key, '-out', cert,
  ], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(cert)) return null;
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function httpsGet(port, agent) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port, path: '/via-proxy', method: 'GET',
      agent, rejectUnauthorized: false, timeout: 8000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

test('normalizeProxyUrl 校验与归一化', () => {
  assert.strictEqual(normalizeProxyUrl('http://h:8080'), 'http://h:8080');
  assert.strictEqual(normalizeProxyUrl('http://h:8080/'), 'http://h:8080'); // 路径丢弃
  assert.strictEqual(normalizeProxyUrl('http://h'), 'http://h'); // 缺省端口 80
  assert.strictEqual(normalizeProxyUrl('http://user:p%40ss@h:1'), 'http://user:p%40ss@h:1'); // 凭证保留
  assert.throws(() => normalizeProxyUrl('socks5://h:1'), /仅支持 http/);
  assert.throws(() => normalizeProxyUrl('https://h:1'), /仅支持 http/);
  assert.throws(() => normalizeProxyUrl('http:///'), /合法 URL|主机名/); // 特殊 scheme 空主机在 URL 解析层就抛
  assert.throws(() => normalizeProxyUrl('not a url'), /合法 URL/);
  assert.throws(() => normalizeProxyUrl(''), /不能为空/);
  assert.throws(() => normalizeProxyUrl('http://h:99999'), /合法 URL|端口/); // WHATWG 解析层直接拒 >65535
});

test('redactProxyUrl 打码凭证，无凭证原样返回', () => {
  assert.strictEqual(redactProxyUrl('http://user:secret@h:8080'), 'http://user:***@h:8080');
  assert.strictEqual(redactProxyUrl('http://:secret@h:8080'), 'http://:***@h:8080');
  assert.strictEqual(redactProxyUrl('http://h:8080'), 'http://h:8080');
  // 解析失败也要打码，不回显原文
  const masked = redactProxyUrl('http://user:secret@not a url');
  assert.ok(!masked.includes('secret'), `凭证泄漏到错误消息：${masked}`);
});

test('resolveProxyUrl：账号 > 全局默认；describeProxy 全程脱敏', () => {
  const saved = getGlobalProxy();
  try {
    setGlobalProxy('http://gh:3128');
    assert.strictEqual(resolveProxyUrl({ proxy: 'http://ah:8080' }), 'http://ah:8080');
    assert.strictEqual(resolveProxyUrl({ proxy: '' }), 'http://gh:3128');
    assert.strictEqual(resolveProxyUrl({}), 'http://gh:3128');
    assert.strictEqual(resolveProxyUrl(undefined), 'http://gh:3128');
    setGlobalProxy('');
    assert.strictEqual(resolveProxyUrl({ proxy: '' }), null);
    assert.strictEqual(resolveProxyUrl({}), null);
    // 账号凭证不出现在脱敏描述里
    assert.strictEqual(
      describeProxy({ proxy: 'http://user:secret@ah:8080' }),
      'http://user:***@ah:8080',
    );
  } finally {
    setGlobalProxy(saved);
  }
});

test('getAgentFor：无代理返回 null，非法代理抛错不回退直连，同址共享缓存', () => {
  clearAgentCache();
  const saved = getGlobalProxy();
  try {
    assert.strictEqual(getAgentFor({}), null);
    assert.strictEqual(getAgentFor({ proxy: '' }), null);
    assert.throws(() => getAgentFor({ proxy: 'socks5://h:1' }), /仅支持 http/);
    const a1 = getAgentFor({ proxy: 'http://h:8080' });
    const a2 = getAgentFor({ proxy: 'http://h:8080' });
    assert.ok(a1 instanceof HttpConnectAgent);
    assert.strictEqual(a1, a2); // 同一代理 URL 复用同一 agent（连接池共享）
    assert.strictEqual(a1.proxy.host, 'h');
    assert.strictEqual(a1.proxy.port, 8080);
  } finally {
    setGlobalProxy(saved);
    clearAgentCache();
  }
});

test('connectViaProxy：CONNECT 隧道建立并双向通数据', async () => {
  const proxy = startFakeProxy();
  const target = startEchoTarget();
  try {
    const [proxyPort, targetPort] = await Promise.all([proxy.port, target.port]);
    const socket = await connectViaProxy(`http://u:p@127.0.0.1:${proxyPort}`, '127.0.0.1', targetPort);
    const pong = await new Promise((resolve, reject) => {
      socket.setEncoding('utf8');
      const timer = setTimeout(() => reject(new Error('隧道内无响应')), 3000);
      socket.once('data', (d) => { clearTimeout(timer); resolve(d); });
      socket.write('PING\n');
    });
    assert.ok(pong.includes('PONG'));
    assert.strictEqual(proxy.state.connects[0], `127.0.0.1:${targetPort}`);
    assert.match(proxy.state.authSeen[0], /^Basic /); // 凭证进了 Authorization 头
    socket.destroy();
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('connectViaProxy：代理要求凭证，缺失/错误得 407，正确得通行', async () => {
  const proxy = startFakeProxy({ requiredAuth: 'user:right' });
  const target = startEchoTarget();
  try {
    const [proxyPort, targetPort] = await Promise.all([proxy.port, target.port]);
    await assert.rejects(
      () => connectViaProxy(`http://user:wrong@127.0.0.1:${proxyPort}`, '127.0.0.1', targetPort),
      /407/,
    );
    const socket = await connectViaProxy(`http://user:right@127.0.0.1:${proxyPort}`, '127.0.0.1', targetPort);
    socket.destroy();
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('connectViaProxy：代理拒绝 CONNECT（403）原样上抛', async () => {
  const proxy = startFakeProxy({ rejectWith: { code: 403, msg: 'Forbidden' } });
  const target = startEchoTarget();
  try {
    const [proxyPort, targetPort] = await Promise.all([proxy.port, target.port]);
    await assert.rejects(
      () => connectViaProxy(`http://127.0.0.1:${proxyPort}`, '127.0.0.1', targetPort),
      /403/,
    );
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('connectViaProxy：代理不可达直接失败（不静默直连）', async () => {
  const holder = net.createServer();
  const deadPort = await listen(holder); // 占一个端口再释放，保证它一定没人听
  await new Promise((r) => holder.close(() => r()));
  await assert.rejects(
    () => connectViaProxy(`http://127.0.0.1:${deadPort}`, '127.0.0.1', 9),
    (err) => err.message.length > 0,
  );
});

test('connectViaProxy：CONNECT 停摆按 connectTimeout 超时', async () => {
  const proxy = startFakeProxy({ stall: true });
  try {
    const proxyPort = await proxy.port;
    const t0 = Date.now();
    await assert.rejects(
      () => connectViaProxy(`http://127.0.0.1:${proxyPort}`, '127.0.0.1', 9, { connectTimeout: 300 }),
      /超时/,
    );
    assert.ok(Date.now() - t0 < 5000, '超时没有按时触发');
  } finally {
    await proxy.close();
  }
});

test('HttpConnectAgent + https 端到端：请求经隧道到达 TLS 目标', async (t) => {
  const dir = tmpDir('dumate-proxy-test');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cert = makeSelfSignedCert(dir);
  if (!cert) return t.skip('openssl 不可用，跳过 TLS 端到端');
  const proxy = startFakeProxy();
  const target = startTlsTarget(cert);
  const agent = new HttpConnectAgent(`http://user:s3cret@127.0.0.1:${await proxy.port}`, { keepAlive: true });
  t.after(() => agent.destroy());
  try {
    const tlsPort = await target.port;
    const res = await httpsGet(tlsPort, agent);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ok: true, path: '/via-proxy' });
    assert.strictEqual(proxy.state.connects[0], `127.0.0.1:${tlsPort}`);
    assert.ok(proxy.state.authSeen[0].startsWith('Basic '));
  } finally {
    await proxy.close();
    await target.close();
  }
});

test('HttpConnectAgent：keepAlive 复用同一条隧道（代理只见到一次 CONNECT）', async (t) => {
  const dir = tmpDir('dumate-proxy-test');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cert = makeSelfSignedCert(dir);
  if (!cert) return t.skip('openssl 不可用，跳过 TLS 端到端');
  const proxy = startFakeProxy();
  const target = startTlsTarget(cert);
  const agent = getAgentFor({ proxy: `http://127.0.0.1:${await proxy.port}` }, { keepAlive: true });
  t.after(() => { agent.destroy(); clearAgentCache(); });
  try {
    const tlsPort = await target.port;
    const r1 = await httpsGet(tlsPort, agent);
    const r2 = await httpsGet(tlsPort, agent);
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(target.conns(), 1, '两条请求应复用同一条 TLS 连接');
    assert.strictEqual(proxy.state.connects.length, 1, 'CONNECT 只应发生一次');
  } finally {
    await proxy.close();
    await target.close();
  }
});
