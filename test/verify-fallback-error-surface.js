// test/verify-fallback-error-surface.js - 网页回落错误面保真的离线验证（不需要起服务）
//
// 背景（2026-10-30 实测，5MB 超长 Prompt 走网页回落）：
//   云端网关对请求级错误回 HTTP 400/200 + body 内错误体（{"error":{...}}）。
//   callModelStream 只按 HTTP 状态码定 ok、body 无条件经 onChunk 推出，于是：
//   1. 错误体先经 onChunk（settle(200) 抢先定格状态码），之后 !r.ok 分支的
//      settle(400) 被守卫挡掉 —— 客户端拿到 HTTP 200 包着错误；
//   2. !r.ok 分支再补一段 {"error":"web fallback failed"}，与已在缓冲里的
//      上游错误体直接拼接 —— 两段 JSON 连成非法 JSON，客户端解析必炸；
//   3. 非流式的上游错误体（r.json 里的「Prompt 超长」）被包成
//      'web fallback failed'，真实原因被抹掉。
//
// 修复（fallback-web.js）：流式首块嗅探（裸 JSON 错误体 → 攒到可解析即按
// error.type 定真实状态码）、!r.ok / catch 分支已推过字节不再补错误体、
// 非流式优先透传上游原始错误体。
//
// 打桩方式：替换 web-pool 模块对象上的 callStreamWithFailover / callWithFailover。

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const pool = require(path.join(ROOT, 'src/web-pool.js'));
const { callWebPool } = require(path.join(ROOT, 'src/fallback-web.js'));

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ok  ' + name); } else { fail += 1; console.log('  FAIL ' + name); }
}
function section(t) { console.log('\n' + t); }

const realStream = pool.callStreamWithFailover;
const realCall = pool.callWithFailover;

const PROMPT_LONG = JSON.stringify({
  error: { code: 'invalid_request', type: 'invalid_request_error', message: 'Backend response status code[400]: bad request. {"error":{"code":"1261","message":"Prompt 超长"}}' },
  gd_id: 'gd-test0001',
});
const PROMPT_LONG_FULL = JSON.stringify({
  error: { code: 'invalid_request', type: 'invalid_request_error', message: 'Prompt 超长' },
  gd_id: 'gd-test0002',
});

// 驱动器：收 data/end，等 ready 后放行（模拟调用方 callback+flush 时序）
function collect(emitter) {
  const chunks = [];
  emitter.on('data', (c) => chunks.push(String(c)));
  const ended = new Promise((r) => emitter.once('end', r));
  return { chunks, ended };
}

async function runStream(script) {
  pool.callStreamWithFailover = async (p, m, body, onChunk, opts) => script(onChunk, opts);
  const { emitter, done, ready, flush } = callWebPool({ stream: true, model: 'glm-5' }, {});
  const c = collect(emitter);
  await ready;
  flush();
  const fin = await done;
  await c.ended;
  return { statusCode: emitter.statusCode, chunks: c.chunks, fin };
}

async function runCall(script) {
  pool.callWithFailover = async () => script();
  const { emitter, done, ready, flush } = callWebPool({ stream: false, model: 'glm-5' }, {});
  const c = collect(emitter);
  await ready;
  flush();
  const fin = await done;
  await c.ended;
  return { statusCode: emitter.statusCode, chunks: c.chunks, fin };
}

function joined(chunks) { return chunks.join(''); }
function isSingleValidJSON(chunks) {
  const s = joined(chunks);
  try { JSON.parse(s); return true; } catch (e) { return false; }
}

(async () => {
  // ---------------------------------------------------------------------------
  section('1. 流式：HTTP 400 + body 错误体（实测场景）');
  {
    const r = await runStream(async (onChunk) => {
      onChunk(PROMPT_LONG);            // 上游 4xx 的 body 照样流经 onChunk
      return { ok: false, status: 400, account: { id: 1 } };
    });
    ok(r.statusCode === 400, `状态码 400（实测此前是 200）→ ${r.statusCode}`);
    ok(r.chunks.length === 1, `只输出一段（实测此前两段拼接）→ ${r.chunks.length} 段`);
    ok(isSingleValidJSON(r.chunks), '响应体是合法 JSON');
    ok(joined(r.chunks).includes('Prompt 超长'), '上游真实错误原文保留');
  }

  // ---------------------------------------------------------------------------
  section('2. 流式：HTTP 200 + body 错误体（云端网关另一形态）');
  {
    const r = await runStream(async (onChunk) => {
      onChunk(PROMPT_LONG_FULL);
      return { ok: true, status: 200, account: { id: 1 } };
    });
    ok(r.statusCode === 400, `HTTP 200 包错误也能按 error.type 翻成 400 → ${r.statusCode}`);
    ok(r.chunks.length === 1 && isSingleValidJSON(r.chunks), '单段合法 JSON');
  }

  // ---------------------------------------------------------------------------
  section('3. 流式：错误体跨多个 chunk');
  {
    const parts = [PROMPT_LONG_FULL.slice(0, 20), PROMPT_LONG_FULL.slice(20, 55), PROMPT_LONG_FULL.slice(55)];
    const r = await runStream(async (onChunk) => {
      for (const p of parts) onChunk(p);
      return { ok: false, status: 400, account: { id: 1 } };
    });
    ok(r.statusCode === 400, '跨块攒齐后才定状态码');
    ok(joined(r.chunks) === PROMPT_LONG_FULL, '内容无丢失无重复');
    ok(r.chunks.length === 1, '攒齐后一次性放行（不是逐块乱序）');
  }

  // ---------------------------------------------------------------------------
  section('4. 流式回归：正常 SSE 不受嗅探影响');
  {
    const frames = ['data: {"choices":[{"delta":{"content":"你"}}]}\n\n', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'];
    const r = await runStream(async (onChunk) => {
      for (const f of frames) onChunk(f);
      return { ok: true, status: 200, account: { id: 1 } };
    });
    ok(r.statusCode === 200, '正常流状态码 200');
    ok(joined(r.chunks) === frames.join(''), '帧内容与顺序逐字节一致');
  }

  // ---------------------------------------------------------------------------
  section('5. 流式：残缺错误体（JSON 永远不完整）兜底放行');
  {
    const r = await runStream(async (onChunk) => {
      onChunk('{"error":{"code":12');   // 截断
      return { ok: false, status: 400, account: { id: 1 } };
    });
    ok(r.chunks.length === 1, '残缺体兜底放行，不与 fallback 错误体拼接');
    ok(isSingleValidJSON(r.chunks) === false && joined(r.chunks).includes('"error"'), '放行的是残缺原文（不编造）');
    ok(r.statusCode === 502, `残缺体按 502 → ${r.statusCode}`);
  }

  // ---------------------------------------------------------------------------
  section('6. 非流式：上游错误体原样透传（原因不被抹掉）');
  {
    const r = await runCall(() => ({ ok: false, status: 400, json: JSON.parse(PROMPT_LONG_FULL), raw: PROMPT_LONG_FULL }));
    ok(r.statusCode === 400, '状态码 400');
    ok(joined(r.chunks) === PROMPT_LONG_FULL, '透传上游原文（不包 web fallback failed 层）');
  }
  section('7. 非流式：网络错误（无上游体）保留包装层');
  {
    const r = await runCall(() => ({ ok: false, status: 0, error: 'socket hang up' }));
    ok(r.statusCode === 502, '网络错误 502');
    ok(joined(r.chunks).includes('socket hang up'), '错误信息保留');
    ok(isSingleValidJSON(r.chunks), '仍是合法 JSON');
  }
  section('8. 非流式回归：成功响应原样');
  {
    const okBody = JSON.stringify({ id: 'x', choices: [{ message: { content: '好的' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    const r = await runCall(() => ({ ok: true, status: 200, json: JSON.parse(okBody), raw: okBody }));
    ok(r.statusCode === 200 && joined(r.chunks) === okBody, '成功路径逐字节一致');
  }

  pool.callStreamWithFailover = realStream;
  pool.callWithFailover = realCall;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('RUNNER ERROR', e);
  process.exit(1);
});
