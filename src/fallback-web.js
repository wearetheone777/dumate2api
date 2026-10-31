// src/fallback-web.js - 搭子通道的网页凭证回落
//
// 背景：搭子有两套凭证来源，只差在凭证本身，协议能力不分家：
//   桌面凭证（auth.json → dumate-main-server.exe 8980）
//     优点：链路短、长期登录态
//     硬伤：**同一时刻只有一份登录态，且过期后必须打开客户端重登一次**
//   网页凭证（data/web-accounts.json → 直连 dumate-svc.baidu.com）
//     优点：可多账号、token 自动续（约 1 小时一换）
//     硬伤：上游是云网关，少两处默认行为——usage 帧要显式请求
//           （stream_options.include_usage，已在 server.js 注入），
//           且不支持图片/工具调用的桌面扩展字段
//
// 注意主语：网页凭证**不**缺协议能力。它被包装成伪上游响应后交给
// server.js 的四个协议处理器原样复用，所以 responses / count_tokens /
// 三通道前缀分流在网页凭证下全部照常可用。真正没有 responses 的是
// **9084 那条独立链路**（web-gateway.js），与这里的回落无关——
// 别把两件事读混。
//
// 默认来源现在是 `web`（router.dumateSource()），桌面链路只在
// DUMATE_DUMATE_SOURCE=auto 时参与，作为回落的**备用**而非主路。
//
// 实现方式：把网页池包装成一个**伪上游响应**（EventEmitter + statusCode +
// headers），交给现有四个协议处理器原样复用。不重写翻译层——那三套 SSE
// 状态机（Anthropic 的 block 顺序、Responses 的 item 顺序、Google 的分片）
// 是踩了十几个坑才稳定的，重写一遍等于把那些坑再踩一次。
//
// 上游协议一致是这里成立的前提：网页池打的是同一个
// `dumate-svc.baidu.com/gateway/apis/v1/chat/completions`，返回 OpenAI SSE，
// 与 8980 后端吐的东西同构。
//
// ---------------------------------------------------------------------------
// 状态码时序（这是本模块最容易写错的地方）
//
// 四个处理器拿到「上游响应」后会**立刻** `res.writeHead(upstreamRes.statusCode)`。
// 也就是说 statusCode 必须在把 emitter 交出去之前就定下来。而网页池的状态码
// 要等云端响应头到达才知道——两者之间有几百毫秒。
//
// 所以用「缓冲 → 等状态 → 释放」：
//   1. 调用方 await ready（状态码定下来，成功 200 或失败 4xx/5xx）
//   2. 调用方把 emitter 交给处理器（此时 writeHead 拿到的是正确状态码）
//   3. 调用方 flush()，把缓冲的 chunk 放出去，之后转为直接 emit
//
// 不这样做的话，失败时头已经按 200 发出去了，客户端会收到一个空的 200——
// 本项目在别处踩过同样的坑（见 server.js 里 writeSSEHead 的注释）。
const { EventEmitter } = require('events');
const pool = require('./web-pool');
const accounts = require('./accounts');

// 回落开关。默认开启——它存在的理由（桌面凭证过期）是常态而非例外。
// 设 0 可关掉，便于排查「是不是回落导致的怪现象」。
function enabled() {
  return process.env.DUMATE_WEB_FALLBACK !== '0';
}

/** 网页池里有没有可用账号。没有就谈不上回落 */
function available() {
  if (!enabled()) return false;
  try {
    return pool.snapshot().some((a) => a.enabled && !a.cooling);
  } catch (e) {
    return false;
  }
}

/**
 * 把一次网页池调用包装成伪上游响应。
 *
 * @param {object} body 已构造好的 OpenAI 请求体
 * @param {object} opts { onAccount } 供埋点回填「实际用了哪个账号」
 * @returns {{emitter, done, ready, flush}}
 *   emitter 伪上游响应；done 最终结果；ready 等状态码；flush 释放缓冲。
 */
function callWebPool(body, opts = {}) {
  const emitter = new EventEmitter();
  emitter.statusCode = 200;
  emitter.headers = { 'content-type': body.stream ? 'text/event-stream' : 'application/json' };

  let settled = false;
  let flushing = false;
  let ended = false;
  const buffered = [];
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });

  const settle = (code) => {
    if (settled) return;
    settled = true;
    emitter.statusCode = code;
    resolveReady();
  };
  const push = (chunk) => {
    if (flushing) emitter.emit('data', chunk);
    else buffered.push(chunk);
  };
  const end = () => {
    ended = true;
    if (flushing) emitter.emit('end');
  };
  const flush = () => {
    if (flushing) return;
    flushing = true;
    for (const c of buffered) emitter.emit('data', c);
    buffered.length = 0;
    if (ended) emitter.emit('end');
  };

  const onChunk = (chunk) => { settle(200); push(chunk); };

  // 从云端网关的错误体（{"error":{...}} 形状）推状态码。它对部分请求级错误
  // 回 HTTP 200（Prompt 超长实测就是），错误藏在 body 里——不在首个 chunk
  // 到达时把状态码定下来，处理器会 writeHead(200)，客户端把错误当成功静默
  // 收下（2026-10-30 实测 5MB 请求即触发）。
  function statusFromBodyError(s) {
    try {
      const j = JSON.parse(s);
      const type = j && j.error && j.error.type;
      if (type === 'invalid_request_error') return 400;
      if (type === 'authentication_error') return 401;
      if (type === 'permission_error') return 403;
      if (type === 'rate_limit_error') return 429;
    } catch (e) { /* 形状不认识，按网关错处理 */ }
    return 502;
  }

  // 首块嗅探：正常流式（SSE）首帧必以 data:/event: 开头；裸 `{` 开头的是
  // 云端网关的错误体（HTTP 200 或 4xx 的 body 都会走到这里——callModelStream
  // 只按 HTTP 状态码定 ok，body 无条件经 onChunk 推出）。错误体可能跨多个
  // chunk，所以要攒到 JSON 能解析（或超限）再定状态码并放行。
  // sniffing 标志跨 chunk 保持——后续块不再做形状判定，直接进缓冲。
  let pushedAny = false;
  let sniffing = false;
  let sniff = '';
  const SNIFF_CAP = 64 * 1024;
  const releaseSniff = (code) => {
    settle(code);
    pushedAny = true;
    sniffing = false;
    push(sniff);
    sniff = '';
  };
  const tryReleaseSniff = () => {
    if (sniff.length > SNIFF_CAP) return releaseSniff(502);
    try {
      JSON.parse(sniff);
      releaseSniff(statusFromBodyError(sniff));
    } catch (e) { /* JSON 未完，继续攒 */ }
  };
  const onChunkSniff = (chunk) => {
    if (sniffing) {
      sniff += chunk;
      return tryReleaseSniff();
    }
    if (pushedAny) {
      settle(200);
      push(chunk);
      return;
    }
    const head = String(chunk).trimStart();
    if (head.startsWith('data:') || head.startsWith('event:') || head.startsWith(':') || !head.startsWith('{')) {
      settle(200);
      pushedAny = true;
      push(chunk);
      return;
    }
    sniffing = true;
    sniff = chunk;
    tryReleaseSniff();
  };

  const done = new Promise((resolve) => {
    const finish = (r) => resolve(r);

    const run = body.stream
      ? pool.callStreamWithFailover('/chat/completions', 'POST', body, onChunkSniff, {
        timeout: 600000,
        // 真实模型回调（X-Dumate-Gw-Realmodel）：池子在响应头到达时上报
        ...(opts.onRealModel ? { onRealModel: opts.onRealModel } : {}),
        // **不在 onStatus 里 settle(200)**：云端网关对部分错误回 HTTP 200 +
        // body 内错误体，响应头先于 body 到达——在这里 settle 会把状态码
        // 定格成 200，等首块嗅探发现错误体时已经改不了（处理器早已
        // writeHead）。状态码统一由首块嗅探定：正常 SSE 首帧毫秒级到达，
        // 代价只是 ready 晚解析一个首块的时间。
      })
      : pool.callWithFailover('/chat/completions', 'POST', body, {
        timeout: 600000,
        ...(opts.onRealModel ? { onRealModel: opts.onRealModel } : {}),
      });

    Promise.resolve(run).then((r) => {
      if (r && r.account) {
        // 挂到 emitter 上：调用方在回调里读它写埋点。
        // 多账号轮询下「实际用了哪个」只有池子知道，在埋点处猜必然是错的。
        emitter._account = accounts.displayName(r.account);
        if (typeof opts.onAccount === 'function') {
          try { opts.onAccount(accounts.displayName(r.account)); } catch (e) { /* 归因失败不影响转发 */ }
        }
      }
      // 真实后端模型（X-Dumate-Gw-Realmodel）。池子在响应头到达时已经通过
      // onRealModel 上报过；这里再挂一份到 emitter 上，供不走回调的调用方读取
      const realModel = (r && (r.realModel || (r.headers && r.headers['x-dumate-gw-realmodel']))) || '';
      if (realModel) {
        emitter._realModel = realModel;
        if (typeof opts.onRealModel === 'function') {
          try { opts.onRealModel(realModel); } catch (e) { /* 归因失败不影响转发 */ }
        }
      }
      if (!r) {
        settle(502);
        push(JSON.stringify({ error: { message: '网页池无响应', type: 'api_error' } }));
        return end(), finish({ ok: false, status: 502, error: '网页池无响应' });
      }

      if (!r.ok) {
        // 失败：给出明确状态码，别让下游以为成功。
        // 流已断而错误体 JSON 未完（残缺 body）时先兜底放行，别让它卡在
        // 嗅探缓冲里丢失。
        if (sniff) releaseSniff(502);
        // **流式已推出过字节时不补错误体**：错误体多半已经过 onChunkSniff
        // 推出（HTTP 4xx 的 body 也会流经 onChunk），再 push 就是两段 JSON
        // 直接拼接——非法 JSON，客户端解析必炸（2026-10-30 实测 5MB 超长
        // Prompt 请求返回 `{"error":...}{"error":...}` 即此因）。
        settle(r.status || 502);
        emitter.headers = { 'content-type': 'application/json' };
        if (!body.stream || !pushedAny) {
          // 非流式（或还没推过任何字节）：有上游错误体就**原样透传**——
          // 里面的 message（如「Prompt 超长」）才是真实原因；包一层
          // 'web fallback failed' 会把原因抹掉。
          const upstreamErr = r.raw && r.json && r.json.error;
          push(upstreamErr
            ? r.raw
            : JSON.stringify({ error: { message: r.error || 'web fallback failed', type: 'api_error' } }));
        }
        end();
        return finish({ ok: false, status: emitter.statusCode, error: r.error, json: r.json });
      }

      if (!body.stream) {
        // 非流式：一次性把完整 JSON 交给下游（它的分支就是累加后解析）
        settle(200);
        push(r.raw || JSON.stringify(r.json || {}));
        end();
        return finish({ ok: true, status: 200, json: r.json, account: r.account });
      }

      // 流式：chunk 已在 onChunk 里推过，这里只收尾
      settle(200);
      end();
      return finish({ ok: true, status: 200, account: r.account });
    }).catch((e) => {
      if (sniff) releaseSniff(502);
      settle(502);
      emitter.headers = { 'content-type': 'application/json' };
      // 已推过字节（半截流）再补错误体就是非法拼接，同 !r.ok 分支
      if (!pushedAny) {
        push(JSON.stringify({ error: { message: e.message, type: 'api_error' } }));
      }
      end();
      finish({ ok: false, status: 502, error: e.message });
    });
  });

  return { emitter, done, ready, flush };
}

module.exports = { enabled, available, callWebPool };
