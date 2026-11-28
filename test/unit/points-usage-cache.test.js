// points-usage-cache（批次二十「统计预热」）——新鲜度判定 / 落盘往返 / 计算与
// 出仓形状 / 接线自证。上游查询全部注入打桩，不碰网络；accounts.js 钉在临时
// 数据目录上读种子 web-accounts.json。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULES = ['../../src/points-usage-cache', '../../src/admin/store', '../../src/accounts', '../../src/admin/routes/storage'];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'd2a-points-cache-'));
}

// store/accounts 的 DATA_DIR 在 require 时定死、accounts 还有 mtime 缓存——
// 换目录必须连模块缓存一起清，否则后续测试读到第一个测试的目录
function useDataDir(dir) {
  process.env.DUMATE_ADMIN_DATA = dir;
  for (const m of MODULES) {
    try { delete require.cache[require.resolve(m)]; } catch (e) { /* 尚未加载 */ }
  }
}

function seedAccounts(dir, list) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'web-accounts.json'), JSON.stringify({ accounts: list }));
}

const ACCT_A = { id: 11, name: '测试甲', nickname: '甲号', cookie: 'CK_A', enabled: true };
const ACCT_B = { id: 22, name: '测试乙', nickname: '乙号', cookie: 'CK_B', enabled: true };
const ACCT_OFF = { id: 33, name: '停用号', cookie: 'CK_C', enabled: false };

function makeInst(dir, opts = {}) {
  let t = opts.t0 || 1700000000000;
  const calls = [];
  const replies = opts.replies || {};
  const fetchRecords = async (a, q) => {
    calls.push({ id: a.id, q });
    const r = replies[a.id];
    if (r === 'fail') return { ok: false, error: '上游拒绝' };
    return { ok: true, consumed_points: r.consumed, total_count: r.count };
  };
  const inst = require('../../src/points-usage-cache').create({
    dir,
    ttlMs: opts.ttlMs || 30 * 60000,
    now: () => t,
    fetchRecords,
    agentFor: opts.agentFor || (() => null),
  });
  return { inst, calls, advance: (ms) => { t += ms; } };
}

test('refresh 计算窗口合计 + 各账号明细 + 今日实付，停用号不参与', async () => {
  const dir = tmpDir();
  useDataDir(dir);
  seedAccounts(dir, [ACCT_A, ACCT_B, ACCT_OFF]);
  const { inst, calls } = makeInst(dir, {
    replies: { 11: { consumed: 12.5, count: 3 }, 22: { consumed: 7.5, count: 2 } },
  });
  await inst.refresh(7);
  const v = inst.view(7);
  assert.strictEqual(v.window.total_consumed, 20);
  assert.strictEqual(v.window.total_records, 5);
  assert.strictEqual(v.window.accounts.length, 2, '只有启用账号');
  assert.ok(v.window.fresh, '刚算完应在新鲜期内');
  assert.ok(v.today.fresh, '今日也应新鲜');
  // 每个启用账号各查了两次（窗口 + 今日），startAt/endAt 形状对
  assert.strictEqual(calls.length, 4);
  for (const c of calls) {
    assert.ok(Number.isFinite(c.q.startAt) && Number.isFinite(c.q.endAt), 'startAt/endAt 必须显式给（缺了上游报参数错误）');
    assert.strictEqual(c.q.limit, 1);
  }
});

test('上游拒绝出错误行不补 0；agentFor 抛错同样出错误行', async () => {
  const dir = tmpDir();
  useDataDir(dir);
  seedAccounts(dir, [ACCT_A, ACCT_B]);
  const { inst } = makeInst(dir, {
    replies: { 11: 'fail', 22: { consumed: 4, count: 1 } },
    agentFor: (a) => { if (a.id === 22) throw new Error('代理配置非法'); return null; },
  });
  await inst.refresh(30);
  const rows = inst.view(30).window.accounts;
  const a = rows.find((r) => r.id === 11);
  const b = rows.find((r) => r.id === 22);
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.error, '上游拒绝');
  assert.strictEqual(b.ok, false);
  assert.match(b.error, /代理配置非法/);
});

test('view 未有窗口如实 null；超 TTL 如实判陈旧', async () => {
  const dir = tmpDir();
  useDataDir(dir);
  seedAccounts(dir, [ACCT_A]);
  const { inst, advance } = makeInst(dir, { replies: { 11: { consumed: 1, count: 1 } } });
  let v = inst.view(7);
  assert.strictEqual(v.window, null, '没预热过就是 null，不编 0');
  assert.strictEqual(v.today, null);
  await inst.refresh(7);
  advance(30 * 60000 + 1); // 刚好超过 TTL
  v = inst.view(7);
  assert.strictEqual(v.window.fresh, false, '超 TTL 如实判陈旧');
  assert.strictEqual(v.today.fresh, false);
});

test('落盘往返：dispose 后从文件读回，窗口与今日都在且仍新鲜', async () => {
  const dir = tmpDir();
  useDataDir(dir);
  seedAccounts(dir, [ACCT_A, ACCT_B]);
  const { inst } = makeInst(dir, { replies: { 11: { consumed: 3, count: 1 }, 22: { consumed: 4, count: 2 } } });
  await inst.refresh(30);
  assert.ok(fs.existsSync(path.join(dir, 'points-usage-cache.json')), '缓存文件已落盘');
  inst.dispose();
  const v = inst.view(30);
  assert.strictEqual(v.window.total_consumed, 7);
  assert.ok(v.window.fresh && v.today.fresh);
});

test('warm 吞错不炸进程（fetchRecords 抛异常也只留 stderr）', async () => {
  const dir = tmpDir();
  useDataDir(dir);
  seedAccounts(dir, [ACCT_A]);
  const inst = require('../../src/points-usage-cache').create({
    dir,
    now: () => 1700000000000,
    fetchRecords: async () => { throw new Error('网络炸了'); },
    agentFor: () => null,
  });
  inst.warm(7); // 不 await——内部吞错，不应有未捕获异常
  await new Promise((r) => setTimeout(r, 20));
  const v = inst.view(7);
  assert.strictEqual(v.window, null, '预热失败不留半份缓存');
});

test('接线：keepalive 空闲预热、/overview 接缓存、storage 登记缓存文件', () => {
  const dir = tmpDir();
  useDataDir(dir);
  const ka = fs.readFileSync(path.join(__dirname, '../../src/keepalive.js'), 'utf8');
  assert.match(ka, /points-usage-cache'\)\.warm\(30\)/, 'keepalive 空闲收尾预热 30 天窗口');
  const usage = fs.readFileSync(path.join(__dirname, '../../src/admin/routes/usage.js'), 'utf8');
  assert.match(usage, /pointsCache\.view\(days\)/, '/overview 先查缓存');
  assert.match(usage, /pointsCache\.warm\(days\)/, '陈旧时后台预热');
  assert.match(usage, /points_cache: showPoints \? pointsCacheMeta : null/, '缓存元数据出仓');
  const storage = require('../../src/admin/routes/storage');
  assert.strictEqual(storage.KNOWN['points-usage-cache.json'].deletable, true, '缓存可再生，按 cache 类可清');
});
