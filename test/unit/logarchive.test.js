// 每日 JSONL 归档 + 零依赖 ZIP（批次十八）。
// 需要 DUMATE_ADMIN_DATA 钉到临时目录（logarchive 经 store 读 DATA_DIR）；
// store 在 require 时定死路径，freshModule 必须连 store 一起清缓存。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'd2a-logarchive-'));
}
function freshModule() {
  for (const m of ['../../src/admin/logarchive', '../../src/admin/store', '../../src/admin/routes/logs', '../../src/admin/routes/storage']) {
    try { delete require.cache[require.resolve(m)]; } catch (e) { /* 尚未加载 */ }
  }
  return require('../../src/admin/logarchive');
}

test('append 落 data/logs/run-YYYY-MM-DD.jsonl，一行一个 JSON，ch 原样保留', () => {
  const dir = tmpDir();
  process.env.DUMATE_ADMIN_DATA = dir;
  const la = freshModule();
  la.append({ ts: Date.now(), level: 'log', ch: 'task', text: '[task] 签到完成 account=1' });
  la.append({ ts: Date.now(), level: 'warn', ch: 'sys', text: 'warn 行' });
  const file = la.fileFor(la.dateStrOf(Date.now()));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  const row = JSON.parse(lines[0]);
  assert.strictEqual(row.ch, 'task');
  assert.strictEqual(row.text, '[task] 签到完成 account=1');
  assert.strictEqual(JSON.parse(lines[1]).level, 'warn');
});

test('prune 清超期归档；30 天内的保留', () => {
  const dir = tmpDir();
  process.env.DUMATE_ADMIN_DATA = dir;
  const la = freshModule();
  fs.mkdirSync(la.dirOf(), { recursive: true });
  fs.writeFileSync(path.join(la.dirOf(), 'run-2026-01-01.jsonl'), 'x\n');   // ~331 天前
  fs.writeFileSync(path.join(la.dirOf(), 'run-2026-11-01.jsonl'), 'y\n');   // 27 天前
  fs.writeFileSync(path.join(la.dirOf(), 'other.jsonl'), 'z\n');            // 非 run- 命名，不动
  const removed = la.prune(new Date('2026-11-28T00:00:00').getTime());
  assert.strictEqual(removed, 1);
  assert.strictEqual(fs.existsSync(path.join(la.dirOf(), 'run-2026-01-01.jsonl')), false);
  assert.strictEqual(fs.existsSync(path.join(la.dirOf(), 'run-2026-11-01.jsonl')), true);
  assert.strictEqual(fs.existsSync(path.join(la.dirOf(), 'other.jsonl')), true);
});

test('buildZip 结构合法：EOCD / 本地头逐字段 / inflateRaw 回读 / CRC 一致', () => {
  const la = freshModule();
  const a = Buffer.from('hello archive\n', 'utf8');
  const b = Buffer.from('中文内容行\n'.repeat(100), 'utf8'); // 高度可压缩 → 走 deflate
  const zip = la.buildZip([
    { name: 'run-2026-11-27.jsonl', data: a, mtimeMs: new Date('2026-11-27T10:00:00').getTime() },
    { name: 'run-2026-11-28.jsonl', data: b, mtimeMs: new Date('2026-11-28T10:00:00').getTime() },
  ]);
  const eocdOff = zip.length - 22;
  assert.strictEqual(zip.readUInt32LE(eocdOff), 0x06054b50, 'EOCD 签名');
  assert.strictEqual(zip.readUInt16LE(eocdOff + 10), 2, '条目总数');
  let off = 0;
  const names = [];
  const contents = [];
  for (let i = 0; i < 2; i++) {
    assert.strictEqual(zip.readUInt32LE(off), 0x04034b50, `本地头签名 #${i}`);
    const method = zip.readUInt16LE(off + 8);
    const crc = zip.readUInt32LE(off + 14);
    const csize = zip.readUInt32LE(off + 18);
    const usize = zip.readUInt32LE(off + 22);
    const nlen = zip.readUInt16LE(off + 26);
    const elen = zip.readUInt16LE(off + 28);
    names.push(zip.slice(off + 30, off + 30 + nlen).toString('utf8'));
    const start = off + 30 + nlen + elen;
    const payload = zip.slice(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(payload) : payload;
    contents.push(data);
    assert.strictEqual(data.length, usize, `解压长度 #${i}`);
    assert.strictEqual(la.crc32(data), crc, `CRC #${i}`);
    off = start + csize;
  }
  assert.deepStrictEqual(names, ['run-2026-11-27.jsonl', 'run-2026-11-28.jsonl']);
  assert.strictEqual(contents[0].toString(), 'hello archive\n');
  assert.ok(contents[1].equals(b), '第二份内容逐字节一致');
});

test('exportZip：days 过滤只取近 N 天；空集产出合法空 ZIP', () => {
  const dir = tmpDir();
  process.env.DUMATE_ADMIN_DATA = dir;
  const la = freshModule();
  fs.mkdirSync(la.dirOf(), { recursive: true });
  const now = new Date('2026-11-28T12:00:00').getTime();
  fs.writeFileSync(path.join(la.dirOf(), 'run-2026-11-28.jsonl'), 'today\n');
  fs.writeFileSync(path.join(la.dirOf(), 'run-2026-11-21.jsonl'), 'week-ago\n');
  const one = la.exportZip(1, now);
  assert.strictEqual(one.count, 1);
  assert.strictEqual(one.name, 'dumate-logs-2026-11-28.zip');
  // 单条目：从本地头读载荷回原文（小文件可能 stored 或 deflate，按 method 分流）
  function readFirstEntry(buf, nameLen) {
    const method = buf.readUInt16LE(8);
    const csize = buf.readUInt32LE(18);
    const payload = buf.slice(30 + nameLen, 30 + nameLen + csize);
    return method === 8 ? zlib.inflateRawSync(payload).toString() : payload.toString();
  }
  assert.strictEqual(readFirstEntry(one.body, 'run-2026-11-28.jsonl'.length), 'today\n');
  const week = la.exportZip(30, now);
  assert.strictEqual(week.count, 2);
  // 空目录：合法空 ZIP
  process.env.DUMATE_ADMIN_DATA = tmpDir();
  const la2 = freshModule();
  const none = la2.exportZip(7, now);
  assert.strictEqual(none.count, 0);
  assert.ok(none.body.length >= 22);
  assert.strictEqual(none.body.readUInt32LE(none.body.length - 22), 0x06054b50);
  assert.strictEqual(none.body.readUInt16LE(none.body.length - 22 + 10), 0);
});

test('GET /export 路由：days 越界 400；合法天数回 ZIP 响应头 + 二进制体', () => {
  const dir = tmpDir();
  process.env.DUMATE_ADMIN_DATA = dir;
  const la = freshModule(); // 先建模块（store 归位），路由的 require 才拿到同一 store
  fs.mkdirSync(la.dirOf(), { recursive: true });
  delete require.cache[require.resolve('../../src/admin/routes/logs')];
  const { routes } = require('../../src/admin/routes/logs');
  const exp = routes.find((r) => r.path === '/export');
  assert.ok(exp, '/export 路由已注册');

  function fakeRes() {
    return {
      status: 0,
      headers: null,
      body: null,
      _cors: {},
      writeHead(code, headers) { this.status = code; this.headers = headers; },
      end(body) { this.body = body; },
    };
  }
  const bad = fakeRes();
  exp.handler({ req: { url: '/export?days=999' }, res: bad });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(JSON.parse(bad.body.toString()).error, 'days_out_of_range');

  const good = fakeRes();
  exp.handler({ req: { url: '/export?days=3' }, res: good });
  assert.strictEqual(good.status, 200);
  assert.match(good.headers['Content-Type'], /zip/);
  assert.match(good.headers['Content-Disposition'], /attachment/);
  assert.ok(Buffer.isBuffer(good.body));
  assert.ok(good.body.length >= 22);
});

test('接线与分类：server.js 挂 sink；storage 登记 logs 目录；/export 在路由表', () => {
  const dir = tmpDir();
  process.env.DUMATE_ADMIN_DATA = dir;
  freshModule();
  const serverSrc = fs.readFileSync(path.join(__dirname, '../../src/admin/server.js'), 'utf8');
  assert.match(serverSrc, /logarchive'\)\.attach\(logbuffer\.shared\)/, '管理端进程挂归档 sink');
  const { classify } = require('../../src/admin/routes/storage');
  const dirCls = classify('logs', true);
  assert.strictEqual(dirCls.category, 'logs');
  assert.notStrictEqual(dirCls.deletable, true, '目录本身不可删');
  // 存储页只列 data/ 顶层条目：run-*.jsonl 只会出现在 logs/ 目录行内部（聚合），
  // 不会作为独立文件行出现——它的生命周期由 30 天滚动清理与 ZIP 导出覆盖
  assert.match(dirCls.note, /30 天/, '目录注释如实说明清理方式');
  const { routes } = require('../../src/admin/routes/logs');
  assert.ok(routes.some((r) => r.path === '/export'), '/export 路由已注册');
});
