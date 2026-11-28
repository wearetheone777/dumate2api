// test/unit/workbuddy-agenttool.test.js - 批次八：agenttool 搜索/抓取 + embeddings
//
// 真机探针定案（2026-11-28，账号#1 cn，轻量头集全 200）：
//   search    → {query, type:'text2text', provider:'1', results:[{title,url,
//               snippet,site,favicon}]×5, total_results, response_time_ms}
//   webfetch  → {url, title, content(markdown)}；http scheme 也可
//   embeddings→ OpenAI 形状 {data:[{embedding:[×1024]}], model, object:'list',
//               usage}；坏模型 → HTTP 500 {code:11351,...}（要收成 400）
//
// 打桩：postTool 走 module.exports（search.js 内部经模块对象调用，补丁生效）；
// postTool 自身的 3xx/非 JSON 行为用 https.request 打桩锁。
//
// 运行：node --test test/unit/workbuddy-agenttool.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

// 隔离数据目录（auth store / 出站代理配置解析都会读）
process.env.DUMATE_ADMIN_DATA = path.join(os.tmpdir(), `dumate-wb-agenttool-${process.pid}`);

const search = require('../../src/workbuddy/search');
// 原始实现必须在任何打桩之前捕获——后面的 webSearch/webFetch 用例会换桩
const realPostTool = search.postTool;
const emb = require('../../src/workbuddy/embeddings');
const https = require('https');

test('buildQuery：黑名单拼 -site:，幂等不重复，空 query 不拼', () => {
  assert.strictEqual(search.buildQuery('腾讯云', ['cloud.tencent.com', 'qq.com']), '腾讯云 -site:cloud.tencent.com -site:qq.com');
  assert.strictEqual(search.buildQuery('a -site:x.com', ['x.com']), 'a -site:x.com', '已拼过的不重复');
  assert.strictEqual(search.buildQuery('abc', []), 'abc');
  assert.strictEqual(search.buildQuery('abc', ['  ', null]), 'abc', '空白域名跳过');
  assert.strictEqual(search.buildQuery('', ['x.com']), '');
});

test('webSearch：信封 → items 归一化 + 元数据透传', async () => {
  search.postTool = async () => ({
    status: 200,
    json: {
      query: '腾讯云 -site:a.com', type: 'text2text', provider: '1',
      results: [{ title: 't', url: 'https://x', snippet: 's', site: 'x.com', favicon: 'f.ico' }],
      total_results: 5, response_time_ms: 1353, wechat_source_access: 'true',
    },
    raw: '{}',
  });
  const r = await search.webSearch({ query: '腾讯云', blockedDomains: ['a.com'] }, { region: 'cn' });
  assert.deepStrictEqual(r.items, [{ title: 't', url: 'https://x', snippet: 's', site: 'x.com', favicon: 'f.ico' }]);
  assert.strictEqual(r.totalResults, 5);
  assert.strictEqual(r.responseTimeMs, 1353);
  assert.strictEqual(r.query, '腾讯云 -site:a.com', '上游回显拼好的 query');
});

test('webSearch：results 缺失 → 空数组不炸；total_results 缺 → 用 items.length', async () => {
  search.postTool = async () => ({ status: 200, json: { query: 'q' }, raw: '{}' });
  const r = await search.webSearch({ query: 'q' });
  assert.deepStrictEqual(r.items, []);
  assert.strictEqual(r.totalResults, 0);
});

test('webSearch：空 query → 400 不打上游', async () => {
  search.postTool = async () => { throw new Error('不该被调用'); };
  await assert.rejects(() => search.webSearch({ query: '  ' }), (e) => e.statusCode === 400);
});

test('webFetch：url 校验 + format 缺省 markdown + 信封透传', async () => {
  let captured = null;
  search.postTool = async (region, p, bodyObj) => { captured = { region, p, bodyObj }; return { status: 200, json: { url: 'https://example.com', title: 'Example', content: '# hi' }, raw: '{}' }; };
  const r = await search.webFetch({ url: 'https://example.com' }, { region: 'cn' });
  assert.deepStrictEqual(r, { url: 'https://example.com', title: 'Example', content: '# hi' });
  assert.strictEqual(captured.bodyObj.format, 'markdown', 'format 缺省补 markdown');
  assert.strictEqual(captured.p, '/agenttool/v1/webfetch');
  await assert.rejects(() => search.webFetch({ url: 'ftp://x' }), (e) => e.statusCode === 400);
  await assert.rejects(() => search.webFetch({ url: '' }), (e) => e.statusCode === 400);
});

// ---- postTool 自身行为（https 打桩）----

// 前面的 webSearch/webFetch 测试给 module.exports.postTool 换过桩——桩只会
// resolve，行为测试必须先换回真实现，否则「Missing expected rejection」。
// 注意必须在**测试内**恢复：顶层代码在文件加载时执行，随后 webSearch 用例
// 又会把桩换回去。
function realPostToolBack() { search.postTool = realPostTool; }

function fakeHttps(status, body, headers = {}) {
  const orig = https.request;
  https.request = (opts, cb) => {
    const req = new (require('events').EventEmitter)();
    req.write = () => {};
    req.end = () => {
      process.nextTick(() => {
        const res = new (require('events').EventEmitter)();
        res.statusCode = status;
        res.headers = headers;
        cb(res);
        process.nextTick(() => { res.emit('data', Buffer.from(body)); res.emit('end'); });
      });
    };
    return req;
  };
  return () => { https.request = orig; };
}

test('postTool：无可用账号 → 503（隔离数据目录里没有账号）', async () => {
  realPostToolBack();
  await assert.rejects(() => search.postTool('cn', '/agenttool/v1/search', {}),
    (e) => e.statusCode === 503 && /没有可用的国内账号/.test(e.message));
});

test('postTool：3xx 拒绝跟随（Authorization 不外泄）', async () => {
  const restore = fakeHttps(302, '', { location: 'https://evil.example/catch' });
  try {
    // 无账号先拦，给它一个假账号：直接 stub auth 模块
    const authStore = require('../../src/workbuddy/auth');
    authStore.findUsable = () => [{ id: 1, accessToken: 'at', region: 'cn' }];
    authStore.ensureFresh = async (a) => a;
    await assert.rejects(() => search.postTool('cn', '/agenttool/v1/search', {}),
      (e) => e.statusCode === 502 && /禁跟随/.test(e.message) && /evil\.example/.test(e.message));
  } finally { restore(); }
});

test('postTool：信封错误带 code/msg；4xx 状态码透传、5xx 收 502', async () => {
  const restore = fakeHttps(400, JSON.stringify({ code: 11502, msg: 'bad request', requestId: 'r1' }));
  try {
    await assert.rejects(() => search.postTool('cn', '/x', {}),
      (e) => e.statusCode === 400 && e.upstreamCode === 11502 && /11502: bad request/.test(e.message));
  } finally { restore(); }
  const restore2 = fakeHttps(500, JSON.stringify({ code: 11351, msg: 'model not found' }));
  try {
    await assert.rejects(() => search.postTool('cn', '/x', {}),
      (e) => e.statusCode === 502 && e.upstreamCode === 11351);
  } finally { restore2(); }
});

test('postTool：2xx 非 JSON → 502（搜索端点信封恒为 JSON，裸文本是上游异常）', async () => {
  const restore = fakeHttps(200, '<html>oops</html>');
  try {
    await assert.rejects(() => search.postTool('cn', '/x', {}),
      (e) => e.statusCode === 502 && /非 JSON/.test(e.message));
  } finally { restore(); }
});

// ---- embeddings ----

test('normalizeInput：string / 字符串数组 / 其余形状全拒', () => {
  assert.deepStrictEqual(emb.normalizeInput('hello'), ['hello']);
  assert.deepStrictEqual(emb.normalizeInput(['a', 'b']), ['a', 'b']);
  assert.strictEqual(emb.normalizeInput('  '), null);
  assert.strictEqual(emb.normalizeInput([]), null);
  assert.strictEqual(emb.normalizeInput(['a', 1]), null, '混入非字符串全拒（token 数组不接）');
  assert.strictEqual(emb.normalizeInput(123), null);
  assert.strictEqual(emb.normalizeInput(null), null);
});

test('sendEmbeddings：透传 OpenAI 形状信封（1024 维与 usage 原样）', async () => {
  const vec = new Array(1024).fill(0.1);
  search.postTool = async (region, p, bodyObj) => {
    assert.strictEqual(p, '/v2/embeddings');
    assert.deepStrictEqual(bodyObj, { model: 'bge-m3', input: ['hello world'] });
    return { status: 200, json: { data: [{ embedding: vec, object: 'embedding' }], model: 'bge-m3', object: 'list', usage: { prompt_tokens: 5, total_tokens: 5 } }, raw: '{}' };
  };
  const r = await emb.sendEmbeddings({ input: 'hello world' });
  assert.strictEqual(r.object, 'list');
  assert.strictEqual(r.data.length, 1);
  assert.strictEqual(r.data[0].embedding.length, 1024);
  assert.strictEqual(r.model, 'bge-m3');
  assert.deepStrictEqual(r.usage, { prompt_tokens: 5, total_tokens: 5 });
});

test('sendEmbeddings：条数不符 → 502 宁可不返回', async () => {
  search.postTool = async () => ({ status: 200, json: { data: [{ embedding: [] }] }, raw: '{}' });
  await assert.rejects(() => emb.sendEmbeddings({ input: ['a', 'b'] }),
    (e) => e.statusCode === 502 && /条数不符/.test(e.message) && /静默错位/.test(e.message));
});

test('sendEmbeddings：11351 → 400（上游 500 也要收成 400，客户端错模型不重试）', async () => {
  // 路径 A：postTool 抛出带 upstreamCode 的错
  search.postTool = async () => {
    const e = new Error('workbuddy 11351: embedding model [x] not found');
    e.upstreamCode = 11351; e.statusCode = 502;
    throw e;
  };
  await assert.rejects(() => emb.sendEmbeddings({ input: 'a', model: 'text-embedding-ada-02' }),
    (e) => e.statusCode === 400 && /两套注册表/.test(e.message));
  // 路径 B：错误只在 message 文本里（探针实测：HTTP 500 + body 11351）
  search.postTool = async () => {
    const e = new Error('workbuddy HTTP 500: {"code":11351,"msg":"Generate embedding failed with error: 11351:embedding model [ada] not found"}');
    e.statusCode = 502;
    throw e;
  };
  await assert.rejects(() => emb.sendEmbeddings({ input: 'a', model: 'ada' }),
    (e) => e.statusCode === 400 && /bge-m3/.test(e.message));
});

test('sendEmbeddings：11353 → 400 input_too_large', async () => {
  search.postTool = async () => {
    const e = new Error('workbuddy 11353: input too large');
    e.upstreamCode = 11353; e.statusCode = 502;
    throw e;
  };
  await assert.rejects(() => emb.sendEmbeddings({ input: 'a'.repeat(100000) }),
    (e) => e.statusCode === 400 && e.code === 'input_too_large');
});

test('sendEmbeddings：8MiB 预检 413（不发上游）；坏 input → 400', async () => {
  search.postTool = async () => { throw new Error('不该打上游'); };
  await assert.rejects(() => emb.sendEmbeddings({ input: 'x'.repeat(9 * 1024 * 1024) }),
    (e) => e.statusCode === 413 && e.code === 'payload_too_large');
  await assert.rejects(() => emb.sendEmbeddings({ input: 42 }), (e) => e.statusCode === 400);
});

test('sendEmbeddings：其它上游错误原样透传（不吞不猜）', async () => {
  search.postTool = async () => {
    const e = new Error('workbuddy 11599: something else');
    e.upstreamCode = 11599; e.statusCode = 502;
    throw e;
  };
  await assert.rejects(() => emb.sendEmbeddings({ input: 'a' }),
    (e) => e.statusCode === 502 && /11599/.test(e.message));
});

// ---- 接线自证 ----

test('接线自证：server.js 路由与鉴权通道归属（防路径吞并）', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../../src/server.js'), 'utf8');
  for (const p of ['/v1/search/agenttool', '/v1/webfetch', '/v1/embeddings']) {
    assert.ok(src.includes(`'${p}'`), `路由 ${p} 在位`);
  }
  // workbuddy 分支必须**先于** body.model 的 resolve（embeddings 的 model
  // 是嵌入注册表名字，按它 resolve 会落 dumate 兜底 → 通道绑定 key 被 403）
  const wbIdx = src.indexOf('/^\\/(v1\\/)?(search\\/agenttool|webfetch|embeddings)/');
  const modelIdx = src.indexOf('} else if (model) {');
  assert.ok(wbIdx >= 0, 'workbuddy 工具端点分支在位');
  assert.ok(modelIdx > wbIdx, '路径归通道先于 body.model resolve');
  // qwenwork 的 search 匹配必须写全 web|images（宽匹配会吞 search/agenttool）。
  // 源码里是正则字面量，斜杠以 \/ 形式出现在文本中——按转义后的文本比对。
  assert.ok(src.includes('search\\/(web|images)'), 'qwenwork search 匹配已收窄');
});
