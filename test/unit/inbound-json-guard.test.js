// test/unit/inbound-json-guard.test.js - 入站 JSON 统一解析（P1-2，misakano #295）
//
// 三层覆盖：
//   1. 模块级：parseJsonBody / invalidJsonMessage 的纯函数行为（BOM、截断、
//      空 body、allowEmpty 语义、48 字符回显、换行压缩）。
//   2. HTTP 级：子进程起临时 9080 网关，四个协议入口 + count_tokens 各喂一份
//      截断 JSON——400 形状各按协议，message 带原文回显；BOM 包裹的合法 body
//      **不再**被 400 拒（改前必然 'Invalid JSON body'）。
//   3. 接线锁定（从源码抠，防漂移）：9080 与 9084 的入口都不再裸
//      `JSON.parse(bodyStr)`，且 require 了共享实现。
//
// 运行：node --test test/unit/inbound-json-guard.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { tmpDir } = require('../helpers/tmpdir');
const { parseJsonBody, invalidJsonMessage } = require('../../src/inbound-json');

// ---------- 1. 模块级 ----------

test('parseJsonBody：BOM 剥离后正常解析', () => {
  const r = parseJsonBody('﻿{"a":1}');
  assert.deepEqual(r, { value: { a: 1 } });
});

test('parseJsonBody：BOM + 前后空白 + 多行照常解析', () => {
  const r = parseJsonBody('﻿ \n {"a":\n1}\n ');
  assert.deepEqual(r, { value: { a: 1 } });
});

test('parseJsonBody：截断 JSON → err + 前 48 字符 sample', () => {
  const body = '{"model":"glm-5","messages":[{"role":"user","content":"' + 'x'.repeat(100);
  const r = parseJsonBody(body);
  assert.ok(r.err && !r.value);
  assert.equal(r.sample.length, 48);
  assert.ok(r.sample.startsWith('{"model":"glm-5"'));
});

test('parseJsonBody：空 body —— 协议入口拒绝、工具端点（allowEmpty）给 {}', () => {
  const strict = parseJsonBody('');
  assert.equal(strict.err, 'empty body');
  const strictNull = parseJsonBody(null);
  assert.equal(strictNull.err, 'empty body');
  const empty = parseJsonBody('', { allowEmpty: true });
  assert.deepEqual(empty, { value: {} });
  const ws = parseJsonBody('  \n\t ', { allowEmpty: true });
  assert.deepEqual(ws, { value: {} });
  // 严格模式下纯空白也是 empty
  assert.equal(parseJsonBody('   ').err, 'empty body');
});

test('parseJsonBody：二进制垃圾不抛异常，走 err 路径', () => {
  const r = parseJsonBody('\x00\x01\x02{bad');
  assert.ok(r.err);
  assert.ok(r.value === undefined);
});

test('invalidJsonMessage：回显压缩空白、带解析原因、空 body 标 (empty)', () => {
  assert.equal(
    invalidJsonMessage({ err: 'Unexpected token } in JSON at position 5', sample: '{"a": }\n"b":1' }),
    'Invalid JSON body: "{"a": } "b":1" (Unexpected token } in JSON at position 5)'
  );
  assert.equal(invalidJsonMessage({ err: 'empty body', sample: '' }), 'Invalid JSON body: "(empty)"');
});

// ---------- 2. HTTP 级（临时 9080 网关） ----------

const KEY = '{{SECRET_r1n2bd3j}}';
const TMP = tmpDir('dumate-inbound-json');
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });
process.env.DUMATE_ADMIN_DATA = DATA;

function startServer(port) {
  return require('child_process').spawn(process.execPath, [path.resolve(__dirname, '../../src/server.js')], {
    env: { ...process.env, DUMATE2API_PORT: String(port), DUMATE2API_KEY: KEY, DUMATE_ADMIN_DATA: DATA, DUMATE_AUTOSTART: 'off' },
    stdio: 'ignore',
  });
}

function post(port, reqPath, body, extraHeaders = {}) {
  return new Promise((resolve) => {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, method: 'POST',
        headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json', 'Content-Length': data.length, ...extraHeaders } },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.end(data);
  });
}

const TRUNC = '{"model":"glm-5","messages":[{"role":"user"'; // 截断体
const BOM_OK = Buffer.from('﻿' + JSON.stringify({ model: 'glm-5', messages: [{ role: 'user', content: 'hi' }] }), 'utf8');

test('HTTP 级：五个入口的畸形 JSON 各按协议形状 400 并带原文回显', async () => {
  const port = 19621 + (process.pid % 300);
  const child = startServer(port);
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const probe = await post(port, '/v1/models', '', {});
      if (probe.status !== 0) up = true;
    }
    assert.ok(up, '临时网关应在 10s 内就绪');

    // OpenAI chat：error.type=invalid_request_error + 回显
    const chat = await post(port, '/v1/chat/completions', TRUNC);
    assert.equal(chat.status, 400);
    const chatBody = JSON.parse(chat.body);
    assert.equal(chatBody.error.type, 'invalid_request_error');
    assert.ok(chatBody.error.message.includes('Invalid JSON body: "{'), chatBody.error.message);
    assert.ok(chatBody.error.message.length > 'Invalid JSON body: "'.length + 10);

    // Responses：同 OpenAI 形状
    const resp = await post(port, '/v1/responses', TRUNC);
    assert.equal(resp.status, 400);
    assert.equal(JSON.parse(resp.body).error.type, 'invalid_request_error');
    assert.ok(JSON.parse(resp.body).error.message.includes('"{'), JSON.parse(resp.body).error.message);

    // Anthropic messages：type=error + error.type=invalid_request_error
    const anth = await post(port, '/v1/messages', TRUNC);
    assert.equal(anth.status, 400);
    const anthBody = JSON.parse(anth.body);
    assert.equal(anthBody.type, 'error');
    assert.equal(anthBody.error.type, 'invalid_request_error');
    assert.ok(anthBody.error.message.includes('"{'), anthBody.error.message);

    // count_tokens：Anthropic 形状
    const ct = await post(port, '/v1/messages/count_tokens', TRUNC);
    assert.equal(ct.status, 400);
    assert.equal(JSON.parse(ct.body).type, 'error');

    // Google：INVALID_ARGUMENT 形状
    const goog = await post(port, '/v1beta/models/gemini-x:generateContent', TRUNC);
    assert.equal(goog.status, 400);
    const googBody = JSON.parse(goog.body);
    assert.equal(googBody.error.status, 'INVALID_ARGUMENT');
    assert.ok(googBody.error.message.includes('"{'), googBody.error.message);

    // 空 body：协议入口 400 且标 (empty)
    const emptyChat = await post(port, '/v1/chat/completions', '');
    assert.equal(emptyChat.status, 400);
    assert.ok(JSON.parse(emptyChat.body).error.message.includes('(empty)'));
  } finally {
    child.kill();
  }
});

test('HTTP 级：BOM 包裹的合法 body 不再被 400 Invalid JSON 拒（改前必拒）', async () => {
  const port = 19931 + (process.pid % 300);
  const child = startServer(port);
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const probe = await post(port, '/v1/models', '', {});
      if (probe.status !== 0) up = true;
    }
    assert.ok(up, '临时网关应在 10s 内就绪');

    const res = await post(port, '/v1/chat/completions', BOM_OK);
    // 没有可用上游/账号（临时 data 目录），但绝不能是 'Invalid JSON body'——
    // BOM 剥离成功，请求已进入路由与选号层。
    assert.notEqual(res.status, 400, `BOM body 不应 400：${res.status} ${res.body.slice(0, 200)}`);
    assert.ok(!res.body.includes('Invalid JSON body'), res.body.slice(0, 300));
  } finally {
    child.kill();
  }
});

// ---------- 3. 接线锁定（从源码抠，防漂移） ----------

test('接线：9080 与 9084 入口都不再裸 JSON.parse(bodyStr)，共享实现已 require', () => {
  for (const f of ['src/server.js', 'src/web-gateway.js']) {
    const s = fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf8');
    assert.ok(!/JSON\.parse\(bodyStr/.test(s), `${f} 仍有裸 JSON.parse(bodyStr)`);
    assert.ok(/require\('\.\/inbound-json'\)/.test(s), `${f} 未 require inbound-json`);
    assert.ok(/parseJsonBody\(bodyStr/.test(s), `${f} 未接线 parseJsonBody`);
  }
});
