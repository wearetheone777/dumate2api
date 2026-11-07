// src/web-gateway.js - 网页凭证模型网关（独立进程）
//
// 与 src/server.js 的区别：
//   9080/9082  本地后端链路：依赖 dumate-main-server.exe，同一时刻只有一份登录态
//   9084       网页凭证链路：直连云端网关，多账号轮换，不依赖桌面客户端
//
// 对外协议与 9080 保持一致（OpenAI / Anthropic / Google / Responses），
// 客户端换 base_url 即可切换，不用改配置格式。
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const pool = require('./web-pool');
const accounts = require('./accounts');
const keysvc = require('./keys');
const reqlog = require('./reqlog');
const pointsCursor = require('./points-cursor');
const modelmap = require('./modelmap');
const { anthropicToOpenAI, openAIToAnthropic, mapFinishReason } = require('./anthropic');
const { resolveMaxTokens } = require('./budget');

const PORT = parseInt(process.env.DUMATE_WEB_GATEWAY_PORT || '9084', 10);
const HOST = process.env.DUMATE_WEB_GATEWAY_HOST || '127.0.0.1';
// 与 9080 同款开关（P0-1）：DUMATE_REQUIRE_KEY=1 或设置 DUMATE2API_KEY 即启用
const ENV_API_KEY = String(process.env.DUMATE2API_KEY || '').trim();
const REQUIRE_KEY = process.env.DUMATE_REQUIRE_KEY === '1' || !!ENV_API_KEY;
const cors = require('./cors');

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...(res._cors || {}),
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// 请求体上限（审计 P1-1a，与 server.js 同口径）：9084 同样是匿名可达的一侧，
// 不设限等于让一次 POST 把内存吃满。DUMATE_MAX_BODY_MB 可调。
const MAX_BODY_BYTES = Math.max(1, parseInt(process.env.DUMATE_MAX_BODY_MB || '32', 10)) * 1024 * 1024;

function readBody(req) {
  if (req._bodyTooLarge) return Promise.resolve(null);
  if (typeof req._rawBody === 'string') return Promise.resolve(req._rawBody);
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req._bodyTooLarge = true;
        chunks.length = 0;
        // 继续把剩余数据读干净，连接才能正常收尾；handler 统一回 413
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(req._bodyTooLarge ? null : Buffer.concat(chunks).toString('utf8')));
  });
}

function sendBodyTooLarge(res) {
  return sendJSON(res, 413, { error: { message: 'Request body too large', type: 'invalid_request_error' } });
}

function logRequest(req, res, startedAt, info, status, usage, extra) {
  if (res._logged) return;
  res._logged = true;
  const u = usage || { input: 0, output: 0, total: 0 };
  const ts = Date.now();
  reqlog.record({
    ts,
    ms: Date.now() - startedAt,
    path: req._logPath || '',
    model: info.model || '',
    stream: !!info.stream,
    messages: info.messages || 0,
    status: status || 0,
    input_tokens: u.input || 0,
    output_tokens: u.output || 0,
    total_tokens: u.total || 0,
    ip: reqlog.clientIP(req),
    key_id: (req._apiKey && req._apiKey.id) || 0,
    key: (req._apiKey && req._apiKey.name) || '',
    // 区分链路来源：同一个日志文件里要能分辨是本地后端还是网页凭证跑的
    upstream: 'web',
    // 通道：网页凭证走的仍是**搭子**这条上游通道（模型名与计费都是搭子的），
    // 只是凭证来源不同（网页 cookie vs 桌面 auth.json）。所以这里标 dumate，
    // 而不是另立一条通道——另立会把搭子的用量在界面上劈成两半。
    // 与 upstream 字段配合看：channel=dumate + upstream=web = 网页凭证链路
    channel: req._channel || 'dumate',
    account: (extra && extra.account) || '',
    ...(extra || {}),
  });

  // 余额游标：记在响应之后，差值即这条请求的实际扣费（见 points-cursor.js）
  if (status && status < 500 && extra && extra.account) {
    pointsCursor.capture(ts, extra.account);
  }
}

// 云端返回的 usage 字段名与 OpenAI 一致
function pickUsage(u) {
  if (!u || typeof u !== 'object') return { input: 0, output: 0, total: 0 };
  const input = Number(u.prompt_tokens || 0) || 0;
  const output = Number(u.completion_tokens || 0) || 0;
  return { input, output, total: Number(u.total_tokens || 0) || (input + output) };
}

// ==================== OpenAI 兼容 ====================

async function handleOpenAIModels(req, res) {
  const cfg = modelmap.load();
  const created = Math.floor(Date.now() / 1000);
  // 9084 只打云端网关，模型列表用**云端名空间**（cloud_upstream，2026-11-06
  // 实测：本地名 glm-5 / model-artifact-validate 在云端一律 404，列出来只会
  // 让客户端选中一个必失败的模型）。owned_by 同口径。
  const upstream = new Set(cfg.cloud_upstream);
  sendJSON(res, 200, {
    object: 'list',
    data: cfg.cloud_upstream.map((id) => ({
      id,
      object: 'model',
      created,
      owned_by: upstream.has(id) ? 'dumate-web' : 'dumate-web-proxy',
    })),
  });
}

async function handleOpenAIChat(req, res) {
  const startedAt = Date.now();
  const bodyStr = await readBody(req);
  if (bodyStr == null) return sendBodyTooLarge(res);
  let reqBody;
  try {
    reqBody = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
  }

  const info = reqlog.describeRequest(reqBody);
  req._logPath = '/v1/chat/completions';

  // 云端名空间归一（toCloudModel，2026-11-06）：云端只认 cloud_upstream 六个
  // 路由名——glm-5 等本地名在这里会 404，必须先归一。
  reqBody.model = modelmap.toCloudModel(reqBody.model);
  reqBody.max_tokens = resolveMaxTokens(reqBody.max_tokens);

  const r = await pool.callWithFailover('/chat/completions', 'POST', reqBody, {
    timeout: reqBody.stream ? 600000 : 300000,
  });

  if (!r.ok) {
    logRequest(req, res, startedAt, info, r.status, null, { error: r.error });
    return sendJSON(res, r.status, {
      error: {
        message: r.error,
        type: 'api_error',
        details: r.errors || undefined,
      },
    });
  }

  if (reqBody.stream) {
    // 云端返回的是 SSE 文本；这里重新解析再转发，以便统计 usage。
    // 直接透传流会更省事，但那样就拿不到 token 数，而这个网关的价值之一
    // 就是按账号统计用量。
    return streamOpenAI(r, req, res, startedAt, info);
  }

  logRequest(req, res, startedAt, info, 200, pickUsage(r.json && r.json.usage), { account: accounts.displayName(r.account) });
  return sendJSON(res, 200, r.json);
}

// 把云端的非流式响应改写成 SSE（客户端要 stream 但上游按非流式回了）
function streamOpenAI(r, req, res, startedAt, info) {
  const j = r.json || {};
  const choice = (j.choices || [])[0] || {};
  const msg = choice.message || {};

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...(res._cors || {}),
  });

  const id = j.id || ('chatcmpl_' + crypto.randomUUID());
  const created = j.created || Math.floor(Date.now() / 1000);
  const base = { id, object: 'chat.completion.chunk', created, model: j.model || '' };

  const write = (delta, finish = null) => {
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  };

  write({ role: 'assistant' });
  if (msg.reasoning_content) write({ reasoning_content: msg.reasoning_content });
  if (msg.content) write({ content: msg.content });
  write({}, choice.finish_reason || 'stop');
  if (j.usage) {
    res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: j.usage })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
  logRequest(req, res, startedAt, info, 200, pickUsage(j.usage), { account: accounts.displayName(r.account) });
}

// ==================== Anthropic 兼容 ====================

async function handleAnthropicMessages(req, res) {
  const startedAt = Date.now();
  const bodyStr = await readBody(req);
  if (bodyStr == null) return sendBodyTooLarge(res);
  let anthropicReq;
  try {
    anthropicReq = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } });
  }

  const info = reqlog.describeRequest(anthropicReq);
  req._logPath = '/v1/messages';

  const openaiReq = anthropicToOpenAI(anthropicReq);
  // 9084 只有搭子一条通道，没有前缀分流，所以映射在这里补——翻译层已经
  // 不再自己 mapModel（那会让 `traework/xxx` 这类带前缀的名字在 9080/9082
  // 上被提前兜底、前缀丢失）。同文件 OpenAI 路径的映射同一口径。
  // 2026-11-06 改 toCloudModel：9084 打的是云端网关，本地名 glm-5 会 404。
  openaiReq.model = modelmap.toCloudModel(openaiReq.model);
  if (anthropicReq.stream) openaiReq.stream_options = { include_usage: true };

  const r = await pool.callWithFailover('/chat/completions', 'POST', openaiReq, {
    timeout: anthropicReq.stream ? 600000 : 300000,
  });

  if (!r.ok) {
    logRequest(req, res, startedAt, info, r.status, null, { error: r.error });
    return sendJSON(res, r.status, {
      type: 'error',
      error: { type: 'api_error', message: r.error },
    });
  }

  if (anthropicReq.stream) {
    return translateStreamToAnthropic(r, req, res, startedAt, info, anthropicReq.model);
  }

  const anthropicResp = openAIToAnthropic(r.json || {}, anthropicReq.model);
  logRequest(req, res, startedAt, info, 200, pickUsage(r.json && r.json.usage), { account: accounts.displayName(r.account) });
  return sendJSON(res, 200, anthropicResp);
}

// 把云端的非流式结果翻译成 Anthropic 的 SSE 事件序列
function translateStreamToAnthropic(r, req, res, startedAt, info, originalModel) {
  const j = r.json || {};
  const choice = (j.choices || [])[0] || {};
  const msg = choice.message || {};
  const msgId = 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const usage = pickUsage(j.usage);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...(res._cors || {}),
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send('message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant',
      model: originalModel || 'claude-3-5-sonnet-20241022',
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: usage.input, output_tokens: 0 },
    },
  });

  let index = 0;
  // 思维链按 Anthropic 的 thinking 块输出，保持与本地链路一致
  if (msg.reasoning_content) {
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
    send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: msg.reasoning_content } });
    send('content_block_stop', { type: 'content_block_stop', index });
    index++;
  }

  const text = msg.content || '';
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  // 空正文 + 有工具调用时不发空 text 块（与主网关 translateStreamToAnthropic
  // 同口径：空 text 块会让部分客户端判定「模型只说了句空话」）
  if (text || !toolCalls.length) {
    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    if (text) {
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
    }
    send('content_block_stop', { type: 'content_block_stop', index });
    index++;
  }

  // 工具块：按顺序依次发 start + 完整 input_json_delta + stop。
  // 用 input_json_delta 而不是在 start 里塞 input——前者是各家客户端都吃的
  // 标准形状（与主网关 server.js 的 toolBuf 收尾同一口径）。
  // 9084 的云端调用恒为非流式（callWithFailover 返回完整 JSON），所以这里
  // 拿到的 tool_calls 是完整的，不需要跨帧累积。
  let sentToolUse = false;
  for (const tc of toolCalls) {
    const fn = tc.function || tc;
    if (!fn.name) {
      // 没名字的工具发给客户端只会报 unknown tool，不发——但必须留痕
      console.warn('[web-gateway] 丢弃一个没有名字的工具调用（上游未给 name）');
      continue;
    }
    const args = typeof fn.arguments === 'string' ? fn.arguments : (fn.arguments ? JSON.stringify(fn.arguments) : '{}');
    send('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool_use',
        id: tc.id || ('toolu_' + Math.random().toString(36).slice(2, 10)),
        name: fn.name,
        input: {},
      },
    });
    send('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: args || '{}' },
    });
    send('content_block_stop', { type: 'content_block_stop', index });
    index++;
    sentToolUse = true;
  }

  // stop_reason：有工具调用**必须**是 tool_use，不能照搬上游 finish_reason
  // （上游给 tool_calls 时也可能报 stop，翻译成 end_turn 会让 Claude Code
  // 认为回合正常结束、不去执行工具——主网关 2026-10-03 踩过的同一个坑）
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: sentToolUse ? 'tool_use' : mapFinishReason(choice.finish_reason), stop_sequence: null },
    usage: { input_tokens: usage.input, output_tokens: usage.output },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();

  logRequest(req, res, startedAt, info, 200, usage, { account: accounts.displayName(r.account) });
}

// ==================== Google 兼容 ====================

function openAIToGoogle(openaiResp, model) {
  const choice = (openaiResp.choices || [])[0] || {};
  const msg = choice.message || {};
  const parts = [];
  if (msg.content) parts.push({ text: msg.content });
  const u = openaiResp.usage || {};
  return {
    candidates: [{
      content: { role: 'model', parts: parts.length ? parts : [{ text: '' }] },
      finishReason: choice.finish_reason === 'length' ? 'MAX_TOKENS' : 'STOP',
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: u.prompt_tokens || 0,
      candidatesTokenCount: u.completion_tokens || 0,
      totalTokenCount: u.total_tokens || 0,
    },
    modelVersion: model || openaiResp.model || '',
  };
}

function googleToOpenAI(googleReq) {
  const messages = [];
  for (const c of googleReq.contents || []) {
    const role = c.role === 'model' ? 'assistant' : 'user';
    const text = (c.parts || []).map((p) => (typeof p === 'string' ? p : p.text || '')).join('\n');
    if (text) messages.push({ role, content: text });
  }
  const sys = googleReq.systemInstruction && googleReq.systemInstruction.parts
    ? googleReq.systemInstruction.parts.map((p) => p.text || '').join('\n') : '';
  if (sys) messages.unshift({ role: 'system', content: sys });

  return {
    model: modelmap.toCloudModel(googleReq.model),
    messages,
    max_tokens: resolveMaxTokens(
      googleReq.generationConfig && googleReq.generationConfig.maxOutputTokens,
    ),
    temperature: googleReq.generationConfig && googleReq.generationConfig.temperature,
  };
}

async function handleGoogleGenerate(req, res, pathModel, isStream) {
  const startedAt = Date.now();
  const bodyStr = await readBody(req);
  if (bodyStr == null) return sendBodyTooLarge(res);
  let googleReq;
  try {
    googleReq = JSON.parse(bodyStr);
  } catch (e) {
    return sendJSON(res, 400, { error: { code: 400, message: 'Invalid JSON body', status: 'INVALID_ARGUMENT' } });
  }
  googleReq.model = pathModel;

  const info = reqlog.describeRequest(googleReq, pathModel);
  req._logPath = '/v1beta:generateContent';

  const r = await pool.callWithFailover('/chat/completions', 'POST', googleToOpenAI(googleReq), {
    timeout: 300000,
  });

  if (!r.ok) {
    logRequest(req, res, startedAt, info, r.status, null, { error: r.error });
    return sendJSON(res, r.status, {
      error: { code: r.status, message: r.error, status: 'UNAVAILABLE' },
    });
  }

  const j = r.json || {};
  const out = openAIToGoogle(j, pathModel);

  if (isStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...(res._cors || {}),
    });
    res.write(`data: ${JSON.stringify(out)}\n\n`);
    res.end();
  } else {
    sendJSON(res, 200, out);
  }
  logRequest(req, res, startedAt, info, 200, pickUsage(j.usage), { account: accounts.displayName(r.account) });
}

// ==================== 服务 ====================

const server = http.createServer(async (req, res) => {
  // CORS 白名单判定（fail-closed，见 cors.js）：与 9080 同款
  res._cors = cors.headersFor(req);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...res._cors,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta',
    });
    return res.end();
  }

  const url = req.url.split('?')[0];

  const fail = (err) => {
    log('Error:', err.message);
    if (!res.headersSent) sendJSON(res, 500, { error: { message: err.message, type: 'api_error' } });
    else res.end();
  };

  try {
    if (url === '/health' || url === '/ping') {
      // 进程身份（2026-11-07 融合项 P1-6）：service 统一成 'dumate2api'——
      // 之前是 'dumate-web-gateway'，四个进程各叫各的，探活判据就没法统一；
      // 入口区分交给 role 字段。全仓没有消费旧值的代码（grep 过），改判据安全。
      const identity = require('./service-identity').identity('web-gateway');
      const poolState = pool.snapshot();
      return sendJSON(res, 200, {
        status: 'ok',
        service: identity.service,
        role: identity.role,
        upstream: 'web-credential',
        accounts_total: poolState.length,
        accounts_enabled: poolState.filter((a) => a.enabled).length,
        accounts_ready: poolState.filter((a) => a.enabled && !a.cooling).length,
        accounts: poolState.map((a) => ({
          name: a.name, enabled: a.enabled, cooling: a.cooling,
          token_expires_in_s: a.token_expires_in_s,
        })),
      }, { 'X-Service': identity.service });
    }

    if (REQUIRE_KEY) {
      const token = keysvc.tokenFromHeaders(req.headers);
      let key = keysvc.resolve(token);
      // env 密钥兜底（P0-1）：与登记 key 并联，常时比较
      if (!key && ENV_API_KEY && keysvc.tokenMatches(token, ENV_API_KEY)) {
        key = { id: 0, name: 'env:DUMATE2API_KEY', enabled: true };
      }
      const verdict = keysvc.validate(key, reqlog.clientIP(req), null);
      if (!verdict.ok) {
        // 配额超限 429 化（与 9080 同口径）：客户端对 429 自动退避重试
        if (verdict.reason === 'quota_exceeded') {
          return sendJSON(res, 429, {
            error: {
              message: `Daily quota exceeded: ${verdict.detail}`,
              type: 'rate_limit_error',
              code: 'quota_exceeded',
              reset_at: verdict.reset_at,
            },
          });
        }
        return sendJSON(res, key ? 403 : 401, {
          error: {
            message: verdict.reason === 'unknown_key' ? 'Invalid or missing API key' : `API key rejected: ${verdict.reason}`,
            type: 'authentication_error',
            code: verdict.reason,
          },
        });
      }
      req._apiKey = key;
    }

    if (url === '/v1/models' && req.method === 'GET') return await handleOpenAIModels(req, res);
    if (url === '/v1/chat/completions' && req.method === 'POST') return await handleOpenAIChat(req, res);

    const gm = url.match(/^\/v1beta\/models\/([^:/?]+):(generateContent|streamGenerateContent)$/);
    if (gm && req.method === 'POST') {
      return await handleGoogleGenerate(req, res, decodeURIComponent(gm[1]), gm[2] === 'streamGenerateContent');
    }

    if ((url === '/v1/messages' || url === '/messages' || url === '/api/v1/messages') && req.method === 'POST') {
      return await handleAnthropicMessages(req, res);
    }

    sendJSON(res, 404, { error: { message: `Not found: ${url}`, type: 'invalid_request_error' } });
  } catch (err) {
    fail(err);
  }
});

function start() {
  const poolState = pool.snapshot();
  log('dumate2api web gateway starting...');
  log(`  可用账号: ${poolState.filter((a) => a.enabled).length} / ${poolState.length}`);
  if (!poolState.length) {
    log('  ⚠ 没有账号。请先在管理系统「账号管理」里添加。');
  }
  server.listen(PORT, HOST, () => {
    log(`✓ web gateway listening on http://${HOST}:${PORT}`);
    // 鉴权态势（P0-1）：与 9080 同款告警——未开鉴权且监听非回环时显式提示
    if (!REQUIRE_KEY) {
      const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
      if (!LOOPBACK.has(String(HOST).toLowerCase())) {
        log(`  ⚠ 安全警告：未启用任何 API key 鉴权（未设 DUMATE2API_KEY / DUMATE_REQUIRE_KEY=1），且监听 ${HOST} 非回环地址——局域网内任何设备都能直接消耗上游账号与积分。`);
      }
    } else {
      log(`  ✓ 已启用鉴权：模型端点要求 ${ENV_API_KEY ? 'DUMATE2API_KEY 或登记 key' : '管理端登记的 API key'}`);
    }
    if (!cors.allowlistSize()) {
      log('  · CORS 默认关闭；如需放行请设 DUMATE_CORS_ORIGINS=http://localhost:xxxx（逗号分隔）');
    }
    log(`  上游: https://${pool.GATEWAY_HOST}${pool.GATEWAY_PREFIX}`);
    log(`  OpenAI:    http://127.0.0.1:${PORT}/v1/chat/completions`);
    log(`  Anthropic: http://127.0.0.1:${PORT}/v1/messages`);
    log(`  Google:    http://127.0.0.1:${PORT}/v1beta/models/{model}:generateContent`);
  });
}

if (require.main === module) start();

module.exports = { server, start, translateStreamToAnthropic };
