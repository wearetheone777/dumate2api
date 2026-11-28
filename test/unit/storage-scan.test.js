// test/unit/storage-scan.test.js - 存储管理（批次十七，参考 workbuddy-shift storage/）
//
// 语义定案：
// - 白名单根只有 DUMATE_ADMIN_DATA，且只收**裸文件名**（路径分隔符/.. 在参数形状上
//   就被拒）——路径穿越不成立；
// - 分类表只登记认识的文件；未识别一律 other/protected（宁可少删，绝不猜）；
// - 可删除的只有 logs（流水与日志）与 cache（可再生缓存）两类，其余全部 protected；
// - 60s 快照：切页不重扫，refresh 强制作废，清理后作废；
// - 预览与执行读同一份校验（collect 语义同源），预览零写盘。
//
// 运行：node --test test/unit/storage-scan.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 每个用例独立临时目录 + 重置模块缓存（store.DATA_DIR 在 require 时读 env——
// 只删 storage 的缓存不清 store，第二个用例起就会串到第一个用例的目录；
// router 顶层 require auth，auth 解构的 appendJSONL 绑定在它加载时的 store
// 实例上——不清 auth/router，审计会写进第一个用例的目录）
function freshModule() {
  for (const p of [
    '../../src/admin/routes/storage',
    '../../src/admin/store',
    '../../src/admin/router',
    '../../src/admin/auth',
  ]) {
    delete require.cache[require.resolve(p)];
  }
  return require('../../src/admin/routes/storage');
}

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-storage-'));
  return dir;
}

function seed(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content || 'x'.repeat(100));
  }
}

test('分类：认识/通配/未识别三类落位正确', () => {
  const dir = makeDir();
  process.env.DUMATE_ADMIN_DATA = dir;
  const mod = freshModule();
  seed(dir, {
    'keys.json': '{}',
    'web-accounts.json': '{}',
    'model-map.json': '{}',
    'pool-state.json': '{}',
    'requests.jsonl': 'x',
    'requests.jsonl.1': 'x',
    'gateway-9080.log': 'x',
    'qoder-accounts-trash.json': 'x',
    'expiring-snapshot.json': '{}',
    'qwenwork-daypeak.json': '{}',
    'something-unknown.bin': 'x',
    'activity.jsonl.2': 'x',
  });
  fs.mkdirSync(path.join(dir, 'browser-profile'));
  fs.mkdirSync(path.join(dir, 'mystery-dir'));
  const rows = mod.scanDir(dir);
  const by = new Map(rows.map((r) => [r.name, r]));
  assert.strictEqual(by.get('keys.json').category, 'credentials');
  assert.strictEqual(by.get('web-accounts.json').deletable, false, '凭证永不删');
  assert.strictEqual(by.get('pool-state.json').category, 'config', '运行态归配置（保护）');
  assert.strictEqual(by.get('requests.jsonl').deletable, true, '埋点可清理');
  assert.strictEqual(by.get('requests.jsonl.1').deletable, true, '轮转产物可清理');
  assert.strictEqual(by.get('activity.jsonl.2').deletable, true, '任意序号轮转产物可清理');
  assert.strictEqual(by.get('gateway-9080.log').deletable, true, '运行日志可清理');
  assert.strictEqual(by.get('qoder-accounts-trash.json').category, 'credentials', '回收站文件归凭证（去账号页管理）');
  assert.strictEqual(by.get('expiring-snapshot.json').category, 'cache', '临期快照是可再生缓存');
  assert.strictEqual(by.get('qwenwork-daypeak.json').deletable, true, '停用的遗留文件可删');
  assert.strictEqual(by.get('something-unknown.bin').category, 'other', '未识别 → other');
  assert.strictEqual(by.get('something-unknown.bin').deletable, false, '未识别一律保护');
  assert.strictEqual(by.get('browser-profile').category, 'credentials', '浏览器 profile 含登录态');
  assert.strictEqual(by.get('browser-profile').deletable, false, '目录永不在此删除');
  assert.strictEqual(by.get('mystery-dir').deletable, false, '未识别目录保护');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('快照：60s 内切页不重扫，refresh 与清理都作废', () => {
  const dir = makeDir();
  process.env.DUMATE_ADMIN_DATA = dir;
  const mod = freshModule();
  seed(dir, { 'requests.jsonl': 'xxxx' });
  const s1 = mod.scan();
  assert.strictEqual(s1.cached, false, '首次实扫');
  assert.strictEqual(s1.dataDir, dir, '快照键 = 数据目录');
  const s2 = mod.scan();
  assert.strictEqual(s2.cached, true, '60s 内复用快照');
  assert.strictEqual(s2.files.length, s1.files.length, '数字一致');
  const s3 = mod.scan({ refresh: true });
  assert.strictEqual(s3.cached, false, 'refresh 强制重扫');
  // 清理后作废（invalidateSnapshot 直接驱动，unlink 路径在 HTTP 层验证）
  mod.invalidateSnapshot();
  const s4 = mod.scan();
  assert.strictEqual(s4.cached, false, 'invalidate 后重扫');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('四类合计与可删字节：分类汇总自洽', () => {
  const dir = makeDir();
  process.env.DUMATE_ADMIN_DATA = dir;
  const mod = freshModule();
  seed(dir, {
    'keys.json': 'x'.repeat(10),
    'requests.jsonl': 'x'.repeat(200),
    'points-cursor.jsonl': 'x'.repeat(50),
    'expiring-snapshot.json': 'x'.repeat(30),
    'unknown.dat': 'x'.repeat(1000),
  });
  const snap = mod.scan({ refresh: true });
  const sumCategories = snap.categories.reduce((s, c) => s + c.bytes, 0);
  assert.strictEqual(sumCategories, snap.totals.bytes, '分类合计 = 总量');
  const logs = snap.categories.find((c) => c.id === 'logs');
  assert.strictEqual(logs.bytes, 250, 'logs = requests + points-cursor');
  assert.strictEqual(logs.deletable, true);
  assert.strictEqual(snap.deletableBytes, 280, '可删字节只含 logs/cache（requests 200 + points-cursor 50 + expiring-snapshot 30）');
  const other = snap.categories.find((c) => c.id === 'other');
  assert.strictEqual(other.count, 1, 'unknown.dat 进 other');
  assert.strictEqual(other.deletable, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('白名单：只收裸文件名——路径分隔符 / .. / 目录 / 受保护类别全拒', () => {
  const dir = makeDir();
  process.env.DUMATE_ADMIN_DATA = dir;
  const mod = freshModule();
  seed(dir, { 'requests.jsonl': 'x', 'keys.json': '{}' });
  fs.mkdirSync(path.join(dir, 'sub'));
  // 直接驱动 routes 层校验语义（preview 端点）
  const routes = mod.routes;
  const find = (m, p) => routes.find((r) => r.method === m && r.path === p);
  function call(m, p, body) {
    const r = find(m, p);
    assert.ok(r, `${m} ${p} 已注册`);
    const out = { status: 0, body: null };
    const fake = {
      setHeader() {}, writeHead(c) { out.status = c; return this; }, write() { return true; },
      end(ch) { out.body = JSON.parse(String(ch)); return this; },
      get headersSent() { return out.status !== 0; }, writableEnded: false, destroyed: false,
    };
    r.handler({ req: { url: p, method: m, headers: {}, on() { return this; }, resume() {}, destroy() {} }, res: fake, body: body || null, params: [], user: { username: 't', role: 'admin' } });
    return out;
  }
  const pv = call('POST', '/cleanup/preview', { names: [
    'requests.jsonl',            // 合法
    'keys.json',                 // 受保护
    'sub',                       // 目录
    '../keys.json',              // 穿越
    'sub/secret',                // 子路径
    'nope.json',                 // 不存在
    '',                          // 空名
    'requests.jsonl',            // 重复 → 合并
  ] });
  assert.strictEqual(pv.status, 200);
  assert.deepStrictEqual(pv.body.items.map((i) => i.name), ['requests.jsonl'], '只有合法项进入清单');
  assert.strictEqual(pv.body.write, false, '预览零写盘');
  const refusedNames = pv.body.refused.map((r) => r.name);
  assert.ok(refusedNames.includes('keys.json'), '受保护被拒');
  assert.ok(refusedNames.includes('../keys.json'), '穿越被拒');
  assert.ok(refusedNames.includes('sub'), '目录被拒');
  assert.ok(refusedNames.includes('nope.json'), '不存在被拒');
  assert.ok(pv.body.refused.every((r) => r.reason), '拒绝项带原因');
  // 目录没被动过（预览零写盘）
  assert.ok(fs.existsSync(path.join(dir, 'requests.jsonl')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('清理执行：confirm 门 + 只删验证过的文件 + 快照作废 + 审计', () => {
  const dir = makeDir();
  process.env.DUMATE_ADMIN_DATA = dir;
  const mod = freshModule();
  seed(dir, {
    'requests.jsonl': 'x'.repeat(500),
    'dumate-caps.json': 'x'.repeat(50),
    'keys.json': '{"secret":true}',
  });
  const routes = mod.routes;
  const find = (m, p) => routes.find((r) => r.method === m && r.path === p);
  function call(m, p, body) {
    const r = find(m, p);
    const out = { status: 0, body: null };
    const fake = {
      setHeader() {}, writeHead(c) { out.status = c; return this; }, write() { return true; },
      end(ch) { out.body = JSON.parse(String(ch)); return this; },
      get headersSent() { return out.status !== 0; }, writableEnded: false, destroyed: false,
    };
    r.handler({ req: { url: p, method: m, headers: {}, on() { return this; }, resume() {}, destroy() {} }, res: fake, body: body || null, params: [], user: { username: 't', role: 'admin' } });
    return out;
  }
  // 无 confirm 拒绝
  const no = call('POST', '/cleanup', { names: ['requests.jsonl'] });
  assert.strictEqual(no.status, 400, '无 confirm 拒绝');
  assert.ok(fs.existsSync(path.join(dir, 'requests.jsonl')), '拒绝后文件还在');
  // 带 confirm 执行
  const ex = call('POST', '/cleanup', { confirm: true, names: ['requests.jsonl', 'dumate-caps.json'] });
  assert.strictEqual(ex.status, 200);
  assert.strictEqual(ex.body.removed.length, 2, '两个文件被删');
  assert.strictEqual(ex.body.freedBytes, 550, '释放字节数 = 实际大小和');
  assert.ok(!fs.existsSync(path.join(dir, 'requests.jsonl')));
  assert.ok(!fs.existsSync(path.join(dir, 'dumate-caps.json')));
  assert.ok(fs.existsSync(path.join(dir, 'keys.json')), '凭证不受影响');
  // 快照已作废：下一次 scan 是实扫
  const s = mod.scan();
  assert.strictEqual(s.cached, false, '清理后快照作废');
  // 审计落了
  const audit = fs.readFileSync(path.join(dir, 'admin-audit.jsonl'), 'utf8').trim();
  assert.ok(audit.includes('storage_cleanup'), `审计含 storage_cleanup：${audit.slice(0, 120)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GET /scan 的 ?refresh=1 经真实 URL 解析生效', () => {
  const dir = makeDir();
  process.env.DUMATE_ADMIN_DATA = dir;
  const mod = freshModule();
  seed(dir, { 'requests.jsonl': 'x' });
  const routes = mod.routes;
  const r = routes.find((x) => x.method === 'GET' && x.path === '/scan');
  assert.ok(r, 'GET /scan 已注册');
  function call(url) {
    const out = { status: 0, body: null };
    r.handler({ req: { url, method: 'GET', headers: {}, on() { return this; }, resume() {}, destroy() {} }, res: { setHeader() {}, writeHead(c) { out.status = c; return this; }, write() { return true; }, end(ch) { out.body = JSON.parse(String(ch)); return this; }, get headersSent() { return out.status !== 0; }, writableEnded: false, destroyed: false }, body: null, params: [], user: { username: 't', role: 'admin' } });
    return out;
  }
  assert.strictEqual(call('/scan').body.cached, false, '首次实扫');
  assert.strictEqual(call('/scan').body.cached, true, 'TTL 内复用');
  assert.strictEqual(call('/scan?refresh=1').body.cached, false, 'refresh=1 强制重扫');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('接线自证：server.js 挂载 /storage 且三个路由齐备', () => {
  const src = fs.readFileSync('src/admin/server.js', 'utf8');
  assert.ok(src.includes("require('./routes/storage')"), 'server.js 挂载 storage 路由');
  const mod = freshModule();
  const paths = mod.routes.map((r) => `${r.method} ${r.path}`);
  assert.ok(paths.includes('GET /scan'), 'GET /scan');
  assert.ok(paths.includes('POST /cleanup/preview'), 'POST /cleanup/preview');
  assert.ok(paths.includes('POST /cleanup'), 'POST /cleanup');
});
