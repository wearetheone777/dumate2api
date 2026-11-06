// 验证：搭子通道走**网页回落**时，OpenAI 路径的流式请求不能打挂网关。
//
// 复现的真实故障（2026-10-14 实测，**卸载客户端后必现**）：
//   桌面链路不可用时回落成为唯一链路，此时 `/v1/chat/completions` + stream 抛
//     TypeError: upstreamRes.pipe is not a function
//   未捕获异常 → **整个网关进程退出**（9082 端口直接消失，不是单个请求失败）。
//
//   根因：回落返回的是**伪上游响应**（EventEmitter + statusCode/headers，
//   见 fallback-web.js），它没有 pipe 方法，而该分支原先无条件 `pipe(res)`。
//   翻译器路径（Responses/Anthropic/Google）读的是 `data` 事件，所以不受影响——
//   这就是为什么只有 OpenAI 路径崩。
//
//   桌面凭证可用时走的是真响应（IncomingMessage，有 pipe），所以这个洞
//   平时测不到；一旦客户端被卸载/凭证失效，回落成为唯一链路就必现。
//
// 对未修复的版本跑本测试会**进程崩溃**（TypeError，端口消失）——这就是它
// 作为回归测试的价值。
//
// 不依赖任何运行中的服务，也不打真实上游（打桩 fallback-web）。
const path = require('path');
const http = require('http');
const Module = require('module');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..');
const PORT = 19078;

// ---- 1. 注入假 fallback-web：把伪上游响应按生产语义造出来 ----
//
// 关键点全部照抄 fallback-web.js 的契约，否则测不出真问题：
//   · 伪响应是 EventEmitter，**没有 pipe**（这正是崩溃的触发条件）
//   · statusCode 在 ready resolve 之前就定下来（调用方拿到就 writeHead）
//   · chunk 是 **string**（web-pool 走 setEncoding('utf8') 后透传）
//   · 缓冲 → 等 ready → flush 的时序
const fallbackPath = require.resolve(path.join(ROOT, 'src/fallback-web.js'));

function makeFakeResponse(body) {
  const emitter = new EventEmitter();
  const wantFail = JSON.stringify(body || {}).includes('FORCE_FALLBACK_FAIL');
  emitter.statusCode = wantFail ? 502 : 200;
  emitter.headers = { 'content-type': body && body.stream ? 'text/event-stream' : 'application/json' };

  let flushing = false;
  let ended = false;
  const buffered = [];
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  const push = (c) => { if (flushing) emitter.emit('data', c); else buffered.push(c); };
  const end = () => { ended = true; if (flushing) emitter.emit('end'); };
  const flush = () => {
    if (flushing) return;
    flushing = true;
    for (const c of buffered) emitter.emit('data', c);
    buffered.length = 0;
    if (ended) emitter.emit('end');
  };

  const done = new Promise((resolve) => {
    // 用 setImmediate 模拟「云端响应头几百毫秒后才到」，确保缓冲路径被走到
    setImmediate(() => {
      resolveReady();
      if (wantFail) {
        emitter.headers = { 'content-type': 'application/json' };
        push(JSON.stringify({ error: { message: 'web fallback failed', type: 'api_error' } }));
        end();
        return resolve({ ok: false, status: 502, error: 'web fallback failed' });
      }
      if (body && body.stream) {
        const frame = (delta, finish) => `data: ${JSON.stringify({
          id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model: 'glm-5',
          choices: [{ index: 0, delta, finish_reason: finish || null }],
        })}\n\n`;
        push(frame({ role: 'assistant', content: '' }));
        push(frame({ content: '回落' }));
        push(frame({ content: '可用' }));
        push(frame({}, 'stop'));
        push('data: [DONE]\n\n');
        end();
        return resolve({ ok: true, status: 200, streamed: true });
      }
      push(JSON.stringify({
        id: 'chatcmpl-fake', object: 'chat.completion', created: 1, model: 'glm-5',
        choices: [{ index: 0, message: { role: 'assistant', content: '回落可用' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }));
      end();
      resolve({ ok: true, status: 200 });
    });
  });

  return { emitter, done, ready, flush };
}

const fakeFallback = {
  enabled: () => true,
  available: () => true,
  callWebPool: (body) => makeFakeResponse(body),
};

require.cache[fallbackPath] = new Module(fallbackPath, null);
require.cache[fallbackPath].filename = fallbackPath;
require.cache[fallbackPath].loaded = true;
require.cache[fallbackPath].exports = fakeFallback;

// ---- 2. 起真实 server.js（无上游 → 桌面链路必然失败 → 走回落）----
process.env.DUMATE2API_PORT = String(PORT);
process.env.DUMATE2API_HOST = '127.0.0.1';
process.env.DUMATE_AUTOSTART = 'off';
process.env.DUMATE_ADMIN_DATA = path.join(ROOT, 'data');
// 2026-11-01 起模型端点强制鉴权——测试用 env 密钥，post() 里带上
process.env.DUMATE2API_KEY = 'test-key-fallback';
require(path.join(ROOT, 'src/server.js'));

// ---- 3. 断言 ----
function post(pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': 'Bearer test-key-fallback',
      }, headers || {}),
    }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET' },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
}

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${cond ? '' : '  ← ' + (detail || '')}`);
}

(async () => {
  let up = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { await get('/ping'); up = true; break; } catch (e) { /* 还没起来 */ }
  }
  if (!up) { console.error('server 未能在 15s 内起监听'); process.exit(1); }

  // --- 核心：OpenAI 路径流式 + 伪响应（未修复时这里会打挂进程）---
  let r1;
  try {
    r1 = await post('/v1/chat/completions', {
      model: 'glm-5', stream: true, messages: [{ role: 'user', content: 'hi' }],
    });
  } catch (e) {
    assert('openai 流式 + 回落：请求本身不能失败（未修复时会 ECONNRESET）',
      false, e.message);
    console.log('\n进程已崩，后续断言无法进行');
    process.exit(1);
  }
  assert('openai 流式 + 回落：HTTP 200', r1.status === 200, `实际 ${r1.status}`);
  assert('openai 流式 + 回落：正文完整转发（回落可用）',
    r1.text.includes('回落') && r1.text.includes('可用'), '内容缺失');
  assert('openai 流式 + 回落：以 [DONE] 收尾', r1.text.includes('[DONE]'), '缺 [DONE]');
  assert('openai 流式 + 回落：流正常结束（不是半开）',
    /finish_reason":"stop/.test(r1.text), '没有 stop 帧');
  assert('openai 流式 + 回落：SSE 帧数 ≥ 5（4 数据帧 + [DONE]）',
    (r1.text.match(/^data: /gm) || []).length >= 5,
    `实际 ${(r1.text.match(/^data: /gm) || []).length} 帧`);

  // --- 回落失败（502）时也不能崩 ---
  let r2;
  try {
    r2 = await post('/v1/chat/completions', {
      model: 'glm-5', stream: true, messages: [{ role: 'user', content: 'FORCE_FALLBACK_FAIL' }],
    });
  } catch (e) {
    assert('openai 流式 + 回落失败：不能崩', false, e.message);
    process.exit(1);
  }
  assert('openai 流式 + 回落失败：状态码透传 502', r2.status === 502, `实际 ${r2.status}`);
  assert('openai 流式 + 回落失败：错误体转发给客户端',
    /"error"/.test(r2.text), '没有 error 字段');

  // --- 回归：翻译器路径（Codex / Claude Code 用的就是它们）---
  const r3 = await post('/v1/responses', {
    model: 'glm-5', stream: true, input: 'hi',
  });
  assert('responses 流式 + 回落：HTTP 200', r3.status === 200, `实际 ${r3.status}`);
  assert('responses 流式 + 回落：有 response.completed 收尾',
    r3.text.includes('response.completed'), '翻译器路径被改坏了');
  assert('responses 流式 + 回落：正文到了客户端',
    r3.text.includes('回落'), '正文缺失');

  const r4 = await post('/v1/messages', {
    model: 'glm-5', stream: true, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
  }, { 'anthropic-version': '2023-06-01' });
  assert('anthropic 流式 + 回落：HTTP 200', r4.status === 200, `实际 ${r4.status}`);
  assert('anthropic 流式 + 回落：有 message_stop 收尾',
    r4.text.includes('message_stop'), '缺 message_stop');

  // --- 回归：非流式（走的是另一分支，本来就没 pipe）---
  const r5 = await post('/v1/chat/completions', {
    model: 'glm-5', stream: false, messages: [{ role: 'user', content: 'hi' }],
  });
  assert('openai 非流式 + 回落：HTTP 200', r5.status === 200, `实际 ${r5.status}`);
  assert('openai 非流式 + 回落：正文完整',
    r5.text.includes('回落可用'), '正文缺失');

  // --- 进程必须还活着 ---
  let alive = false;
  try { alive = (await get('/health')) === 200; } catch (e) { /* 已崩 */ }
  assert('全部请求后网关进程仍存活', alive, '进程已退出');

  // --- 静态防回归：不允许再出现无条件的 upstreamRes.pipe(res) ---
  const src = require('fs').readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  assert('静态检查：server.js 里没有无条件的 upstreamRes.pipe(res)',
    !/^\s*upstreamRes\.pipe\(res\);\s*$/m.test(src),
    '无条件 pipe 回来了——伪响应会再次打挂进程');

  const pass = results.filter((x) => x.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
