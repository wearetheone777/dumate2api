// test/unit/key-usage-endpoint.test.js - GET /v1/usage 下游自查端点（M3）
//
// 子进程起临时网关（随机端口 + 临时 data 目录），真实 HTTP 打端点：
//   - env key 鉴权：200 + 窗口聚合形状 + quota=null + 无 key 本体泄漏
//   - 无 key：401
//   - 错 key：401
// 聚合正确性用「注入已知行」验证：预先往临时 data/requests.jsonl 写
// 可控行，断言聚合数字与注入一致。
// 运行：node --test test/unit/key-usage-endpoint.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-keyusage-'));
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });
// 探针路径不落进被测账本
process.env.DUMATE_ADMIN_DATA = DATA;

const KEY = 'ku-selftest-key-0001';
const DAY = 86400000;

/** 造请求行：key_id=7（登记 key），时间/状态/数值可控 */
function row(over = {}) {
  return JSON.stringify({
    ts: Date.now(), req_id: 'r' + Math.random().toString(36).slice(2),
    path: '/v1/chat/completions', channel: 'workbuddy', model: 'workbuddy/glm-5.3',
    status: 200, input_tokens: 10, output_tokens: 20, total_tokens: 30,
    key_id: 7, key: 'selftest', ...over,
  });
}

// 注入：env key（id=0）今天 2 行（1 行 500 失败）、昨天 1 行、40 天前 1 行
//（不该进 30d 窗口）；以及 key 8 的 2 行（别人的账，不得混入）
const NOW = Date.now();
const lines = [
  row({ ts: NOW - 1000, key_id: 0 }),
  row({ ts: NOW - 2000, key_id: 0, status: 500 }),
  row({ ts: NOW - DAY, key_id: 0, input_tokens: 100, output_tokens: 200, total_tokens: 300 }),
  row({ ts: NOW - 40 * DAY, key_id: 0 }), // 30 天窗口外
  row({ ts: NOW - 1000, key_id: 8, key: 'other' }), // 别人的账
  row({ ts: NOW - 2 * DAY, key_id: 8, key: 'other' }),
];
fs.writeFileSync(path.join(DATA, 'requests.jsonl'), lines.join('\n') + '\n');

const { execFile } = require('child_process');
function startServer(port) {
  const child = require('child_process').spawn(process.execPath, [path.resolve(__dirname, '../../src/server.js')], {
    env: { ...process.env, DUMATE2API_PORT: String(port), DUMATE2API_KEY: KEY, DUMATE_ADMIN_DATA: DATA },
    stdio: 'ignore',
  });
  return child;
}
function get(port, headers) {
  return new Promise((resolve) => {
    require('http').get({ host: '127.0.0.1', port, path: '/v1/usage', headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', (e) => resolve({ status: 0, body: e.message }));
  });
}

test('GET /v1/usage：聚合只算本 key 的行、窗口边界正确、不泄漏 key 本体', async () => {
  const port = 19091 + (process.pid % 500);
  const child = startServer(port);
  try {
    // 等监听
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const probe = await get(port, { Authorization: `Bearer ${KEY}` });
      if (probe.status === 200) up = true;
    }
    assert.ok(up, '临时网关应在 10s 内就绪');

    const res = await get(port, { Authorization: `Bearer ${KEY}` });
    assert.strictEqual(res.status, 200);
    const doc = JSON.parse(res.body);

    // key 元信息（env key）：id=0、名字、无 plain 无 hash
    assert.strictEqual(doc.key.id, 0);
    assert.strictEqual(doc.key.name, 'env:DUMATE2API_KEY');
    const blob = res.body;
    assert.ok(!blob.includes(KEY), '响应不得包含 key 本体');
    assert.ok(!blob.includes('"plain"') && !blob.includes('"hash"'), '响应不得含 plain/hash 字段');

    // 聚合正向验证：env key（id=0）的 3 行在 30d 窗口内（40 天前那行不进）、
    // 别人的账（key_id=8）不混入。tokens 三行合计：10+10+100 / 20+20+200 / 30+30+300
    assert.strictEqual(doc.usage['30d'].requests, 3);
    assert.strictEqual(doc.usage['30d'].failed, 1, '500 那行计入 failed');
    assert.strictEqual(doc.usage['30d'].input_tokens, 120);
    assert.strictEqual(doc.usage['30d'].output_tokens, 240);
    assert.strictEqual(doc.usage['30d'].total_tokens, 360);
    assert.strictEqual(doc.usage.today.requests, 2);
    assert.strictEqual(doc.usage['7d'].requests, 3);
    assert.ok(doc.usage['30d'].last_request_at > 0, 'last_request_at 应有值');
    assert.strictEqual(doc.quota, null);
    assert.ok(doc.quota_note, 'quota=null 必须带口径说明');
  } finally {
    child.kill();
  }
});

test('GET /v1/usage：无 key 401、错 key 401', async () => {
  const port = 19091 + (process.pid % 500) + 1;
  const child = startServer(port);
  try {
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const probe = await get(port, { Authorization: `Bearer ${KEY}` });
      if (probe.status === 200) ready = true;
    }
    const noKey = await get(port, {});
    assert.strictEqual(noKey.status, 401);
    const badKey = await get(port, { Authorization: 'Bearer totally-wrong' });
    assert.strictEqual(badKey.status, 401);
  } finally {
    child.kill();
  }
});
