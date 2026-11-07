// 验证：搭子的凭证来源（默认网页池）与真实失败路径。
//
// **默认值是 `web`**（2026-10-22 起）。依据是实测：客户端卸载后桌面链路必然
// 失败（`auth.json` 不存在），`auto` 只是让它先花约 3 秒探测、再在每个请求上
// 撞一次 ECONNREFUSED 才回落；而网页链路首字 p50 826ms，比桌面链路的 1570ms
// 快近一倍，四条协议在网页链路上全部可用。桌面链路保留为
// `DUMATE_DUMATE_SOURCE=auto`（别名 `desktop`）的显式退路。
//
// **另一个容易误判的点**（2026-10-14 实测）：客户端没装时，auto 模式的回落
// 路径上**每个请求并不会跑探测链**。upstream-router 给 dumate 的 defaultPort 是
// 8980 且 portOf() 保证返回有效数字，所以 target.port 恒有值，
// forwardWithFallback 里 `!t.port` 那条分支（会调 ensureUpstream → discoverPort）
// 走不到。真实路径是 startForward → 连一次本地 8980 →
// ECONNREFUSED（回环，毫秒级）→ 回调里 tryWebFallback()。
// 所以「给探测失败加静默窗口」是多余的——本测试在锁死这一点。
//
// 全部离线：打桩 discovery（计数）与 fallback-web（伪响应），不碰网络。
const path = require('path');
const http = require('http');
const Module = require('module');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 19079;

// ---- 1. 打桩 discovery：计数 discoverPort 调用 ----
const counters = { discoverPort: 0 };
const discoveryPath = require.resolve(path.join(ROOT, 'src/discovery.js'));
const realDiscovery = require(discoveryPath);
require.cache[discoveryPath] = new Module(discoveryPath, null);
require.cache[discoveryPath].filename = discoveryPath;
require.cache[discoveryPath].loaded = true;
require.cache[discoveryPath].exports = Object.assign({}, realDiscovery, {
  // 永远返回 null —— 模拟「客户端已卸载」这个目标场景
  discoverPort: async () => { counters.discoverPort++; return null; },
  verifyPort: async () => false,
});

// ---- 2. 打桩 fallback-web：伪上游响应（形状照抄生产语义）----
const fallbackPath = require.resolve(path.join(ROOT, 'src/fallback-web.js'));
let poolAvailable = true; // 中途可切换，用来验 availability 的分支
function makeFakeResponse() {
  const emitter = new EventEmitter();
  emitter.statusCode = 200;
  emitter.headers = { 'content-type': 'text/event-stream' };
  let flushing = false;
  let ended = false;
  const buffered = [];
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  const push = (c) => { if (flushing) emitter.emit('data', c); else buffered.push(c); };
  const flush = () => {
    if (flushing) return;
    flushing = true;
    for (const c of buffered) emitter.emit('data', c);
    buffered.length = 0;
    if (ended) emitter.emit('end');
  };
  const done = new Promise((resolve) => {
    setImmediate(() => {
      resolveReady();
      const frame = (delta, finish) => `data: ${JSON.stringify({
        id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model: 'glm-5',
        choices: [{ index: 0, delta, finish_reason: finish || null }],
      })}\n\n`;
      push(frame({ role: 'assistant', content: 'web' }));
      push(frame({}, 'stop'));
      push('data: [DONE]\n\n');
      ended = true;
      if (flushing) emitter.emit('end');
      resolve({ ok: true, status: 200, streamed: true });
    });
  });
  return { emitter, done, ready, flush };
}
require.cache[fallbackPath] = new Module(fallbackPath, null);
require.cache[fallbackPath].filename = fallbackPath;
require.cache[fallbackPath].loaded = true;
require.cache[fallbackPath].exports = {
  enabled: () => true,
  available: () => poolAvailable,
  callWebPool: () => makeFakeResponse(),
};

// ---- 3. 起真实 server.js（**不设** DUMATE_DUMATE_SOURCE，测默认值）----
process.env.DUMATE2API_PORT = String(PORT);
process.env.DUMATE2API_HOST = '127.0.0.1';
process.env.DUMATE_AUTOSTART = 'off';
process.env.DUMATE_ADMIN_DATA = path.join(ROOT, 'data');
// 2026-11-01 起模型端点强制鉴权——测试用 env 密钥，post() 里带上
//（/ping、/health 豁免，get() 不需要；子进程只看启动日志，也不需要）
process.env.DUMATE2API_KEY = 'test-key-source';
delete process.env.DUMATE_DUMATE_SOURCE;
require(path.join(ROOT, 'src/server.js'));

const router = require(path.join(ROOT, 'src/upstream-router'));

function post() {
  return new Promise((resolve, reject) => {
    const d = JSON.stringify({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: true });
    const rq = http.request({
      host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(d),
        'Authorization': 'Bearer test-key-source',
      },
    }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
      res.on('error', reject);
    });
    rq.on('error', reject);
    rq.write(d);
    rq.end();
  });
}
function get(pathname) {
  return new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET' }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    rq.on('error', reject);
    rq.end();
  });
}

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${cond ? '' : '  ← ' + (detail || '')}`);
}

/**
 * 向 OS 要一个当前空闲的端口，拿到就立刻关掉。
 * 用于把「上游不可达」变成确定前提：开发机上若真跑着 DuMate 后端（8980），
 * 回落用例会连上真后端而不回落，测试随环境漂移。
 */
function deadPort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

(async () => {
  let up = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { await get('/ping'); up = true; break; } catch (e) { /* 还没起来 */ }
  }
  if (!up) { console.error('server 未能在 15s 内起监听'); process.exit(1); }

  // ---- 默认值：web ----
  assert('dumateSource(): 未设环境变量 → web', router.dumateSource() === 'web', router.dumateSource());
  assert('启动阶段**零探测**（默认不走桌面链路）', counters.discoverPort === 0, `实际 ${counters.discoverPort}`);

  let allOk = true;
  for (let i = 0; i < 5; i++) {
    const r = await post();
    if (!(r.status === 200 && r.text.includes('web'))) allOk = false;
  }
  assert('默认配置下 5 个请求全部成功（走网页凭证）', allOk);
  assert('这 5 个请求一次探测都没跑', counters.discoverPort === 0, `多探了 ${counters.discoverPort} 次`);

  const h = JSON.parse((await get('/health')).text);
  assert('health: 默认 source=web', h.channels.dumate.source === 'web', JSON.stringify(h.channels.dumate));
  assert('health: 默认 ready 看网页池（可用 → true）', h.channels.dumate.ready === true, JSON.stringify(h.channels.dumate));

  // ---- availability ----
  assert('availability: 默认 + 池可用 → ok', router.availability('dumate').ok === true);

  poolAvailable = false;
  const notOk = router.availability('dumate');
  assert('availability: 默认 + 池不可用 → 拒绝', notOk.ok === false, JSON.stringify(notOk));
  assert('availability: 拒绝原因点明是网页凭证来源',
    /网页凭证/.test(notOk.reason || '') && /DUMATE_DUMATE_SOURCE=auto/.test(notOk.reason || ''),
    `实际: ${notOk.reason}`);

  const h2 = JSON.parse((await get('/health')).text);
  assert('health: 池不可用时 ready=false', h2.channels.dumate.ready === false, JSON.stringify(h2.channels.dumate));

  poolAvailable = true;

  // ---- 值解析：auto / desktop / 未知值 ----
  process.env.DUMATE_DUMATE_SOURCE = 'auto';
  assert('dumateSource(): auto → auto', router.dumateSource() === 'auto', router.dumateSource());
  process.env.DUMATE_DUMATE_SOURCE = 'desktop';
  assert('dumateSource(): desktop 是 auto 的别名', router.dumateSource() === 'auto', router.dumateSource());
  process.env.DUMATE_DUMATE_SOURCE = 'AUTO';
  assert('dumateSource(): 大小写不敏感', router.dumateSource() === 'auto', router.dumateSource());
  process.env.DUMATE_DUMATE_SOURCE = 'garbage';
  assert('dumateSource(): 未知值按默认（web）处理，不静默当 auto',
    router.dumateSource() === 'web', router.dumateSource());
  process.env.DUMATE_DUMATE_SOURCE = '  web  ';
  assert('dumateSource(): 容忍首尾空白', router.dumateSource() === 'web', router.dumateSource());

  // ---- 切到 auto 仍能工作（回落路径没被改坏）----
  // **把上游端口指向一个确定不可达的端口**，别依赖「本机 8980 恰好没在跑」。
  // 这条用例验的是「桌面链路连不上 → 回落网页池」，如果开发机上真跑着 DuMate
  // 后端（8980 LISTENING），请求会直连成功、不回落，用例就假失败——2026-11-08
  // 实测踩到：同一份代码，8980 未跑时 26/26 通过，8980 在跑时 24/26。
  // router 的 targetOf() 每次请求现读 DUMATE_UPSTREAM_PORT，所以这里改环境
  // 变量即可生效，不需要重启 server.js。端口由 OS 分配后立即释放，保证无人监听
  // （比硬编码 1 更稳：1 在某些 Windows 配置上是特权端口，行为不确定）。
  process.env.DUMATE_DUMATE_SOURCE = 'auto';
  process.env.DUMATE_UPSTREAM_PORT = String(await deadPort());
  const beforeAuto = counters.discoverPort;
  const r3 = await post();
  assert('auto 模式请求仍成功（连上游失败 → 回落网页池）',
    r3.status === 200 && r3.text.includes('web'), `status ${r3.status}`);
  assert('auto 模式下请求期间同样零探测', counters.discoverPort === beforeAuto,
    `多探了 ${counters.discoverPort - beforeAuto} 次`);
  const h3 = JSON.parse((await get('/health')).text);
  assert('health: auto 模式 source=auto', h3.channels.dumate.source === 'auto', JSON.stringify(h3.channels.dumate));

  delete process.env.DUMATE_DUMATE_SOURCE;
  delete process.env.DUMATE_UPSTREAM_PORT;

  // ---- 启动阶段：默认跳过那次约 3 秒的初始探测；auto 模式才跑 ----
  // 用子进程跑，因为「是否跳过初始发现」只在启动时决定一次。
  const childSrc = (envLine, port) => `
    ${envLine}
    process.env.DUMATE_AUTOSTART = 'off';
    const path = require('path');
    const ROOT = ${JSON.stringify(ROOT)};
    const Module = require('module');
    const dp = require.resolve(path.join(ROOT, 'src/discovery.js'));
    const real = require(dp);
    require.cache[dp] = new Module(dp, null);
    require.cache[dp].filename = dp;
    require.cache[dp].loaded = true;
    require.cache[dp].exports = Object.assign({}, real, {
      discoverPort: async () => { console.log('__PROBED__'); return null; },
    });
    process.env.DUMATE2API_PORT = '${port}';
    process.env.DUMATE_ADMIN_DATA = path.join(ROOT, 'data');
    require(path.join(ROOT, 'src/server.js'));
    setTimeout(() => process.exit(0), 4000);
  `;
  const runChild = (envLine, port) => {
    const child = spawnSync(process.execPath, ['-e', childSrc(envLine, port)],
      { encoding: 'utf8', timeout: 20000 });
    return (child.stdout || '') + (child.stderr || '');
  };

  const outDefault = runChild('', '19081');
  assert('默认启动时不跑初始探测（省掉那约 3 秒）',
    !outDefault.includes('__PROBED__'), '启动阶段仍然调用了 discoverPort');
  assert('默认启动日志说明凭证来源',
    /不探测桌面链路/.test(outDefault), '启动日志里没有说明');
  assert('默认启动日志不再报「main-server not detected」',
    !/main-server not detected/.test(outDefault), '仍在报桌面链路缺失');

  const outAuto = runChild("process.env.DUMATE_DUMATE_SOURCE = 'auto';", '19082');
  assert('auto 模式启动时**会**做初始探测（桌面链路参与）',
    outAuto.includes('__PROBED__'), 'auto 模式没有探测桌面链路');

  const outBad = runChild("process.env.DUMATE_DUMATE_SOURCE = 'desktp';", '19083');
  assert('无法识别的取值会告警，而不是静默按 auto 跑',
    /无法识别/.test(outBad), '没有告警');

  // ---- 静态防回归 ----
  const fs = require('fs');
  const src = require('fs').readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  assert('静态检查：forwardWithFallback 用 router.dumateSource() 判来源',
    /router\.dumateSource\(\) === 'web'/.test(src), '来源判定被改回硬读环境变量');
  assert('静态检查：没有残留的探测静默窗口（实测证明不需要）',
    !/desktopUnavailableUntil/.test(src), '静默窗口又回来了——那条分支默认走不到');

  const cursorSrc = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  assert('静态检查：余额游标认 req._upstreamAccount（否则网页行永远没有 points_delta）',
    /const cursorAccount = req\._upstreamAccount \|\|/.test(cursorSrc),
    '游标账号来源退回只认 extra.account');

  const pass = results.filter((x) => x.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
