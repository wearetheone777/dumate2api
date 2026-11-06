// 验证：直连通道「上游报错」时，客户端必须收到终结事件，
// 而不是一个没有终结事件的裸关闭；网关进程也不能因此崩溃。
//
// 复现的真实故障（2026-10-02 实测，**跨通道**，非 Qoder 特有）：
//   千问额度耗尽时上游报 402。此时网关已经吐过帧（翻译器一进入就
//   writeHead(200) 并写 response.created，所以 res.headersSent 恒为 true），
//   catch 分支只能裸 res.end()。两处后果：
//     1. 翻译器想补发的终结事件（response.completed / message_stop）因 res
//        已结束被丢弃 → Codex 报
//        `stream disconnected before completion: stream closed before response.completed`
//        （用户看到「思考很久然后失败」，且那一轮记成 0 token）
//     2. **更严重**：翻译器的 'end' 处理器是异步触发的，在 catch 同步
//        res.end() 之后才跑，于是 sendEvent 调 res.write() 抛
//        ERR_STREAM_WRITE_AFTER_END。流式 res 的 'error' 事件没有监听者
//        → 未捕获异常 → **网关进程直接退出**（9082 整个挂掉）。
//        实测证据：9082 于 23:51 退出、00:03 才重启，期间 cc-switch 连报
//        8 次「502 上游连接失败」。
//
// 本测试用 require.cache 注入假 provider，跑**真实的 server.js**，断言
// SSE 流里有对应的失败终结事件。
//
// 两种错误模式（FAKE_QODER_MODE）：
//   post（默认）—— 先吐一帧正常数据再报错（`err.sent = true`，与
//                  qwenwork/traework 的 `if (e.sent) throw e` 同形）
//   pre        —— 一帧都不吐就报错（模拟额度耗尽：上游首帧前就报 402）
//
// 对未修复的 HEAD 版本跑本测试会**进程崩溃**（ERR_STREAM_WRITE_AFTER_END）
// 或断言失败——这就是它作为回归测试的价值。
//
// 不依赖任何运行中的服务，也不打真实上游。
const path = require('path');
const http = require('http');
const Module = require('module');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PORT = 19077;

// ---- 1. 注入假 provider：替换 src/qoder ----
const qoderPath = require.resolve(path.join(ROOT, 'src/qoder'));
const fakeQoder = {
  status: () => ({ ready: true, needsClient: false, accounts: 1, error: '' }),
  warmup: () => ({ ready: true }),
  // server.js 的启动块调的是 warmupModels（warmup 已删）。桩缺了它时
  // 启动块会走 catch 被吞掉，测试仍报全绿——新代码路径完全没被覆盖。
  warmupModels: async () => ({ ok: true, models: [] }),
  listModels: async () => ['qfmodel'],
  listModelEntries: async () => [{ id: 'qoder/qfmodel', name: 'Q', contextWindow: 180000 }],
  pickAccount: () => ({ id: 1 }),
  checkin: async () => ({}),
  quota: async () => ({}),
  /**
   * 关键：先吐一帧正常数据，再抛「已吐帧」的错误——
   * 与 qwenwork/traework 的 `if (e.sent) throw e` 完全同形。
   *
   * `mode=pre` 时**一帧都不吐**就抛错（模拟额度耗尽：上游在首帧前就报 402）。
   * 这个分支同样会走到「头已发」的 catch —— 因为翻译器一进入就 writeHead(200)
   * 并写出 response.created，所以 res.headersSent 恒为 true。
   */
  send: async (payload, onChunk) => {
    const mode = process.env.FAKE_QODER_MODE || 'post';
    if (onChunk && mode !== 'pre') {
      onChunk(JSON.stringify({
        id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'auto',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      }));
      onChunk(JSON.stringify({
        id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'auto',
        choices: [{ index: 0, delta: { reasoning_content: 'thinking' }, finish_reason: null }],
      }));
      const err = new Error('qoder 402: quota exhausted');
      err.statusCode = 402;
      err.sent = true; // 已吐帧 → 上层不能再换号，直接抛
      throw err;
    }
    if (onChunk && mode === 'pre') {
      const err = new Error('qwenwork 402: quota exhausted');
      err.statusCode = 402;
      err.sent = false; // 一帧都没吐
      throw err;
    }
    throw new Error('non-stream not used in this test');
  },
};
fakeQoder.chatCompletion = (p, o) => fakeQoder.send(p, undefined, o);
fakeQoder.chatCompletionStream = (p, cb, o) => fakeQoder.send(p, cb, o);

// 注册进 require.cache，让 server.js 的 require('./qoder') 拿到假的
require.cache[qoderPath] = new Module(qoderPath, null);
require.cache[qoderPath].filename = qoderPath;
require.cache[qoderPath].loaded = true;
require.cache[qoderPath].exports = fakeQoder;

// ---- 2. 起真实 server.js ----
process.env.DUMATE2API_PORT = String(PORT);
process.env.DUMATE2API_HOST = '127.0.0.1';
process.env.DUMATE_AUTOSTART = 'off';
// 埋点写到临时目录：既隔离真实请求日志（开发实例可能同时在写），
// 也让下面的断言能只看本次运行的几行。
process.env.DUMATE_ADMIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-reqlog-'));
// 2026-11-01 起模型端点强制鉴权——测试用 env 密钥，post() 里带上
process.env.DUMATE2API_KEY = 'test-key-errterm';
require(path.join(ROOT, 'src/server.js'));

// ---- 3. 断言 ----
function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': 'Bearer test-key-errterm',
      },
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

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${cond ? '' : '  ← ' + (detail || '')}`);
}

(async () => {
  // 等 server 真正起监听（start() 里要先 ensureUpstream，是异步的）
  let up = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      await new Promise((resolve, reject) => {
        const rq = http.request({ host: '127.0.0.1', port: PORT, path: '/ping', method: 'GET' },
          (rs) => { rs.resume(); resolve(); });
        rq.on('error', reject);
        rq.end();
      });
      up = true; break;
    } catch (e) { /* 还没起来 */ }
  }
  if (!up) { console.error('server 未能在 15s 内起监听'); process.exit(1); }

  // --- Responses 路径（Codex 用的就是它）---
  const r1 = await post('/v1/responses', {
    model: 'qoder/qfmodel', input: 'hi', stream: true,
  });
  assert('responses: HTTP 200（头已发，不能改状态码）', r1.status === 200, `实际 ${r1.status}`);
  assert('responses: 流里有终结事件 response.failed',
    r1.text.includes('response.failed'), '没有 response.failed —— 就是本次要修的 bug');
  assert('responses: 终结事件的 status 是 failed',
    /"status":"failed"/.test(r1.text), '未标 failed');
  // 错误码从上游真实状态码推导（2026-10-27）：429 → rate_limit_exceeded，
  // 其余 → server_error。此前的硬编码 upstream_error 不是 OpenAI/Responses 的
  // 标准取值，且会把「排队限流」和「上游挂了」混成同一个码。
  assert('responses: 带标准错误码（server_error / rate_limit_exceeded）',
    /"error":\{"code":"(server_error|rate_limit_exceeded)"/.test(r1.text),
    '错误码缺失或不是标准取值');
  assert('responses: error.message 带上游真实原因',
    /"error":\{"code":"[^"]+","message":"[^"]{8,}"/.test(r1.text),
    '错误原因是空或用通用文案');
  assert('responses: 首帧确实发出去了（response.created）',
    r1.text.includes('response.created'), '首帧丢失');

  const preMode = (process.env.FAKE_QODER_MODE || 'post') === 'pre';

  // --- Anthropic 路径 ---
  const r2 = await post('/v1/messages', {
    model: 'qoder/qfmodel', max_tokens: 1024, stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert('anthropic: HTTP 200', r2.status === 200, `实际 ${r2.status}`);
  // 两种模式期望不同（2026-10-27 起）：
  //   post：已经吐过内容 → 协议上收不回去，按 message_delta + message_stop 正常收尾
  //   pre ：一个内容块都没发出去 → 发 Anthropic 的 `event: error`，
  //         否则 Claude Code 会把它当成一次「合法的空回合」而不重试
  if (preMode) {
    assert('anthropic: 首帧前失败 → 发 event: error（不是伪装成空回答）',
      r2.text.includes('event: error'), '缺少 error 事件 —— 客户端会把空回答当成功');
    assert('anthropic: error 事件带真实原因',
      /"type":"error"[\s\S]{0,200}"message":"[^"]{8,}"/.test(r2.text), 'error 事件没有 message');
    assert('anthropic: 不应再发 message_stop（那等于告诉客户端「回合正常结束」）',
      !r2.text.includes('message_stop'), '仍然发了一个正常的空回合收尾');
  } else {
    assert('anthropic: 流里有 message_stop 终结事件',
      r2.text.includes('message_stop'), '没有 message_stop —— 裸关闭');
    assert('anthropic: 流里有 message_delta（收尾 usage）',
      r2.text.includes('message_delta'), '缺 message_delta');
  }

  // --- OpenAI 路径（无翻译器）---
  // 两种模式期望不同，这**正是**设计意图：
  //   post：已吐帧 → 头已发，只能把错误帧 + [DONE] 写进流再关
  //   pre ：没吐帧 → 头未发，回正经的 402 JSON（比写进流更规范）
  const r3 = await post('/v1/chat/completions', {
    model: 'qoder/qfmodel', stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  });
  if (preMode) {
    assert('openai: 首帧前失败 → 回 402 JSON（头未发，不该硬造 200）',
      r3.status === 402, `实际 ${r3.status}`);
    assert('openai: 402 响应体带 error.message',
      /"error"/.test(r3.text), '没有 error 字段');
  } else {
    assert('openai: HTTP 200（头已发，不能改状态码）', r3.status === 200, `实际 ${r3.status}`);
    assert('openai: 流里有 error 帧（不是裸关闭）',
      /"error"/.test(r3.text), '没有 error 帧 —— 客户端会报响应未完成');
    assert('openai: 流以 [DONE] 收尾',
      r3.text.includes('[DONE]'), '缺 [DONE]');
  }

  // --- 埋点：错误必须落盘，且状态码是上游真实值 ---
  // 翻译器会在 emit('error') 里**同步** finish(502)，旧实现让外层再传的
  // extra 变成 no-op —— 所有直连通道的失败都记成 502 且 err 为空。
  const logFile = path.join(process.env.DUMATE_ADMIN_DATA, 'requests.jsonl');
  const rows = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean)
    : [];
  const lastOf = (p) => rows.filter((x) => x.path === p).pop();
  const rp = lastOf('/v1/responses');
  const am = lastOf('/v1/messages');
  const oc = lastOf('/v1/chat/completions');
  assert('埋点 responses: 状态码还原成上游真实值 402', rp && rp.status === 402, rp ? 'status=' + rp.status : '没有埋点行');
  assert('埋点 responses: 带 error 文本', rp && /quota exhausted/.test(String(rp.error || '')), rp ? JSON.stringify(rp.error) : '');
  assert('埋点 messages: 状态码还原成上游真实值 402', am && am.status === 402, am ? 'status=' + am.status : '没有埋点行');
  assert('埋点 messages: 带 error 文本', am && /quota exhausted/.test(String(am.error || '')), am ? JSON.stringify(am.error) : '');
  assert('埋点 openai: 带 error 文本', oc && /quota exhausted/.test(String(oc.error || '')), oc ? JSON.stringify(oc.error) : '');

  const pass = results.filter((x) => x.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
