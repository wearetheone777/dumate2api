// test/reqlog-hook.test.js - 请求日志挂钩与归档查询单测（施工包 C）
//
// 覆盖：reqlog.record 自动挂上计量聚合、DUMATE_USAGE_AGG=0 关停、
// readArchive 倒序/跨代/from 早停/offset 分页/hasMore/limit 钳制/坏行容忍。
// DUMATE_ADMIN_DATA 在 require 之前指到 tmp 目录，不碰真实 data/。
const os = require('os');
const path = require('path');
const { tmpDir } = require('./helpers/tmpdir');
process.env.DUMATE_ADMIN_DATA = tmpDir('dumate-reqhook');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const reqlog = require('../src/reqlog');
const hook = require('../src/reqlog-hook');
const usageAgg = require('../src/usage-agg');

const DATA = process.env.DUMATE_ADMIN_DATA;
const T = new Date(2026, 9, 25, 14, 0).getTime();

function row(over) {
  return {
    ts: T,
    channel: 'dumate',
    account: 'a1',
    model: 'm1',
    status: 200,
    input_tokens: 7,
    output_tokens: 3,
    total_tokens: 10,
    ms: 50,
    ...over,
  };
}

function writeArchive(name, rows) {
  // 字符串元素原样直写（坏行/空行用），对象才做序列化
  fs.writeFileSync(
    path.join(DATA, name),
    rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n',
    'utf8',
  );
}

test('reqlog.record 自动挂上计量聚合，且埋点照常落盘', () => {
  reqlog.record(row({ model: 'hooked' }));
  const s = usageAgg.snapshot({});
  assert.equal(s.totals.requests, 1);
  assert.equal(s.totals.total_tokens, 10);
  assert.equal(s.by_model[0].key, 'hooked');
  // 埋点主流程不受影响：requests.jsonl 照常追加
  const log = fs.readFileSync(path.join(DATA, 'requests.jsonl'), 'utf8');
  assert.ok(log.includes('"model":"hooked"'));
});

test('DUMATE_USAGE_AGG=0 时挂钩不聚合（埋点照常）', () => {
  const before = usageAgg.snapshot({}).totals.requests;
  process.env.DUMATE_USAGE_AGG = '0';
  try {
    reqlog.record(row({ model: 'switched-off' }));
    assert.equal(usageAgg.snapshot({}).totals.requests, before);
    const log = fs.readFileSync(path.join(DATA, 'requests.jsonl'), 'utf8');
    assert.ok(log.includes('"model":"switched-off"'), '埋点不受关停影响');
  } finally {
    delete process.env.DUMATE_USAGE_AGG;
  }
});

test('feed 直接喂聚合（含坏输入自吞）', () => {
  assert.equal(hook.feed(null), false);
  assert.equal(hook.feed(row({ model: 'fed', account: 'a2', ts: T + 1 })), true);
  const s = usageAgg.snapshot({});
  assert.equal(s.totals.requests, 2);
  assert.equal(s.by_account.map((r) => r.key).sort().join(','), 'a1,a2');
});

test('readArchive：倒序、limit、offset 分页、hasMore', () => {
  writeArchive('requests.jsonl', [
    row({ ts: T, model: 'e1' }),
    row({ ts: T + 1000, model: 'e2' }),
    row({ ts: T + 2000, model: 'e3' }),
    row({ ts: T + 3000, model: 'e4' }),
    row({ ts: T + 4000, model: 'e5' }),
  ]);
  const r1 = hook.readArchive({ limit: 3 });
  assert.deepEqual(r1.rows.map((e) => e.model), ['e5', 'e4', 'e3']);
  assert.equal(r1.hasMore, true);

  const r2 = hook.readArchive({ limit: 5 });
  assert.equal(r2.rows.length, 5);
  assert.equal(r2.hasMore, false);

  const r3 = hook.readArchive({ limit: 2, offset: 3 });
  assert.deepEqual(r3.rows.map((e) => e.model), ['e2', 'e1']);
  assert.equal(r3.hasMore, false);
});

test('readArchive：跨代（.1）读取且新代在前', () => {
  writeArchive('requests.jsonl.1', [
    row({ ts: T - 3000, model: 'old1' }),
    row({ ts: T - 2000, model: 'old2' }),
    row({ ts: T - 1000, model: 'old3' }),
  ]);
  writeArchive('requests.jsonl', [
    row({ ts: T + 5000, model: 'new1' }),
    row({ ts: T + 6000, model: 'new2' }),
  ]);
  const r = hook.readArchive({ limit: 10 });
  assert.deepEqual(r.rows.map((e) => e.model), ['new2', 'new1', 'old3', 'old2', 'old1']);
  assert.equal(r.hasMore, false);
});

test('readArchive：from 时间界整段早停，不扫更旧的一代', () => {
  // 当前代最早条目 ts=T+5000；from=T+5000 时上一代（更旧）不应被扫
  const r = hook.readArchive({ limit: 10, from: T + 5000 });
  assert.deepEqual(r.rows.map((e) => e.model), ['new2', 'new1']);
  // from 落在上一代中间：只取界内条目
  const r2 = hook.readArchive({ limit: 10, from: T - 2500 });
  assert.deepEqual(r2.rows.map((e) => e.model), ['new2', 'new1', 'old3', 'old2']);
  const r3 = hook.readArchive({ limit: 10, to: T + 5500 });
  assert.deepEqual(r3.rows.map((e) => e.model), ['new1', 'old3', 'old2', 'old1']);
});

test('readArchive：filter 回调（对齐 reqlog.read 习惯）', () => {
  const r = hook.readArchive({ limit: 10, filter: (e) => e.model === 'new1' || e.model === 'old1' });
  assert.deepEqual(r.rows.map((e) => e.model), ['new1', 'old1']);
});

test('readArchive：limit 钳制与坏行容忍', () => {
  // good1 放文件尾（ts 最新、落盘也最新），倒序扫描第一条就该是它
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(row({ ts: T + 8000 - i * 10, model: `g${i}` }));
  lines.push('{broken json', '');
  lines.push(row({ ts: T + 9000, model: 'good1' }));
  writeArchive('requests.jsonl', lines);
  // 隔离：上一代 .1（跨代测试写的）删掉，只验当前代
  try { fs.unlinkSync(path.join(DATA, 'requests.jsonl.1')); } catch (e) { /* 没有 .1 */ }
  const r = hook.readArchive({ limit: 99999 }); // 钳到 2000，坏行跳过
  assert.equal(r.rows[0].model, 'good1');
  assert.equal(r.rows.length, 31);
  assert.equal(r.rows[30].model, 'g0', '最旧的一条也在');
  assert.ok(r.rows.every((e) => e && e.model), '全部是可解析条目');
});

test('空归档：目录还没有日志也不报错', () => {
const { tmpDir } = require('./helpers/tmpdir');
  const empty = tmpDir('dumate-reqhook-empty');
  const r = hook.readArchive({ dir: empty, limit: 5 });
  assert.deepEqual(r.rows, []);
  assert.equal(r.hasMore, false);
});
