// test/unit/port-probe.test.js - 启动前端口占用检查（P2-10）
//
// 出处：docs/WORKBUDDY-FUSION.md P2-10（hub `--probe-only`）。Windows 的
// SO_REUSEADDR 允许重复监听，旧实例卡死仍绑着端口时新连接会被分给它，于是
// 「新进程在跑、界面永远是空的」，日志还干干净净——这条检查就是为那一刻。
//
// 四条口径：
//   1. 能连上就算占用（哪怕 /health 不回话）——卡死的旧实例正是最该拦的
//   2. 空闲（拒绝连接）→ occupied=false，允许继续启动
//   3. /health 是本服务的 → 带回 service/role 供人判断是哪个进程
//   4. 探测失败（权限等）不拦启动：探测是辅助，不能比服务本身更脆
//
// 用真 kernel socket（127.0.0.1 + port 0 让 OS 分配），不 mock http——
// 这条判据的价值全在「真实的连接语义」上。
//
// 运行：node --test test/unit/port-probe.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const portProbe = require('../../src/port-probe');

function listenOn(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler || ((req, res) => { res.writeHead(200); res.end('{}'); }));
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function freePort() {
  // 申请后立即释放：拿一个确定没人在听的端口
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

test('空闲端口：occupied=false', async () => {
  const port = await freePort();
  const r = await portProbe.probe('127.0.0.1', port, { timeoutMs: 800 });
  assert.strictEqual(r.occupied, false);
  assert.strictEqual(r.note, '');
});

test('本服务实例在监听：occupied=true + service/role 读出来', async () => {
  const { srv, port } = await listenOn((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ service: 'dumate2api', role: 'gateway' }));
    }
    res.writeHead(404); res.end();
  });
  try {
    const r = await portProbe.probe('127.0.0.1', port, { timeoutMs: 1500 });
    assert.strictEqual(r.occupied, true);
    assert.deepStrictEqual(r.health, { service: 'dumate2api', role: 'gateway' });
    assert.match(r.note, /dumate2api/);
    assert.match(r.note, /gateway/);
  } finally { srv.close(); }
});

test('别的程序占着端口：occupied=true 且如实说「不是本服务」', async () => {
  const { srv, port } = await listenOn((req, res) => { res.writeHead(404); res.end('nope'); });
  try {
    const r = await portProbe.probe('127.0.0.1', port, { timeoutMs: 1500 });
    assert.strictEqual(r.occupied, true);
    assert.strictEqual(r.health, null);
    assert.match(r.note, /不是本服务/);
  } finally { srv.close(); }
});

test('连上但不回话（卡死的旧实例）：仍算占用，不误判为空闲', async () => {
  // 只接受连接、永不回响应
  const srv = http.createServer(() => { /* 故意不响应 */ });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const r = await portProbe.probe('127.0.0.1', port, { timeoutMs: 300 });
    assert.strictEqual(r.occupied, true, '卡死实例必须被拦下——这正是 SO_REUSEADDR 陷阱');
    assert.strictEqual(r.health, null);
    assert.match(r.note, /无响应|卡死/);
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

test('parseHealth：非 JSON / 缺字段 / 空体都返回 null（不编身份）', () => {
  assert.strictEqual(portProbe.parseHealth('not json'), null);
  assert.strictEqual(portProbe.parseHealth(''), null);
  assert.strictEqual(portProbe.parseHealth('<html>401</html>'), null);
  assert.strictEqual(portProbe.parseHealth('{"hello":1}'), null);
  assert.deepStrictEqual(portProbe.parseHealth('{"service":"dumate2api"}'), { service: 'dumate2api', role: '' });
  assert.deepStrictEqual(portProbe.parseHealth('{"role":"admin"}'), { service: '', role: 'admin' });
});

test('enabled：DUMATE_PORT_PROBE=0/off 可关闭（默认开）', () => {
  const old = process.env.DUMATE_PORT_PROBE;
  try {
    delete process.env.DUMATE_PORT_PROBE;
    assert.strictEqual(portProbe.enabled(), true);
    for (const v of ['0', 'off', 'FALSE', 'no']) {
      process.env.DUMATE_PORT_PROBE = v;
      assert.strictEqual(portProbe.enabled(), false, `env=${v}`);
    }
    process.env.DUMATE_PORT_PROBE = '1';
    assert.strictEqual(portProbe.enabled(), true);
  } finally {
    if (old === undefined) delete process.env.DUMATE_PORT_PROBE;
    else process.env.DUMATE_PORT_PROBE = old;
  }
});
