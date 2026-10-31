// src/traework/remote.js - TRAE Remote 链路（2026-11-01，P2-16 最小传输层）
//
// 协议全部取自 Trae2api-cn 的 web remote 客户端（trae_remote_client.py）：
//
//   POST {base}/chat_sessions                             建会话 → {chat_session_id, message_id}
//   GET  {base}/chat_sessions/{id}/events?reply_to_message_id=<mid>   SSE 事件流
//   POST {base}/chat_sessions/{id}/stop                    中断
//
// 与 utils_chat（chat.js）的关键差异：
//   · 事件流是**标准 SSE**（event:/data: 行、[DONE] 哨兵），不是 utils_chat 的
//     自定义事件块——但结束同样靠哨兵，不能只看连接关闭（代理可能吞掉末尾空行）；
//   · 鉴权仍是 Cloud-IDE-JWT，但要带 web 客户端身份头（X-Trae-Client-Type 等）；
//   · 会话按 (账号, 模型) 稳定派生 session id（common_params.solo_chat_mode 决定档）；
//   · 历史以**扁平文本**进 query（[System]/[Assistant]/[Client Tool Result] 前缀），
//     不是 utils_chat 的 messages 数组。
//
// 本文件先做**最小可用**：code 模式 + auto 策略 + 文本历史（无工具调用矩阵、
// 无思考档位透传、无 max 档）——先真机跑通一条对话，再按实测证据扩。
// 国际版 remote 基址未实测（hub 只证实 raw 链路），如实拒绝不预编。
const https = require('https');
const crypto = require('crypto');
const c = require('./constants');
const { StringDecoder } = require('string_decoder');

const CONNECT_TIMEOUT_MS = Number(process.env.DUMATE_TRAEWORK_REMOTE_CONNECT_MS || 15000);
const FIRST_EVENT_MS = Number(process.env.DUMATE_TRAEWORK_REMOTE_FIRST_EVENT_MS || 120000);

/** remote 基址。intl 未实测——拒绝而不是猜 */
function remoteBaseOf(region) {
  const r = String(region || 'cn').toLowerCase();
  if (r === 'intl' || r === 'global') return null;
  return c.REMOTE_BASE_CN;
}

/**
 * 扁平化历史为 remote 端点的 query JSON 字符串（Trae2api-cn flatten_query 同款）。
 * 角色前缀是协议的一部分，不是装饰：remote 端按前缀分辨发言人。
 * 图像块降级为占位文本（remote 的渲染器媒体块形状未实测，不预编）。
 */
function flattenQuery(messages) {
  const parts = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          if (p.type === 'text') return String(p.text || '');
          if (p.type === 'image_url') return '[图片：本链路暂不支持，请以文字描述]';
        }
        return '';
      }).join('');
    }
    content = String(content == null ? '' : content);
    const role = m.role || 'user';
    if (role === 'system') parts.push(`[System]\n${content}`);
    else if (role === 'assistant') {
      const segs = content ? [content] : [];
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const calls = m.tool_calls.map((t) => {
          const fn = (t && t.function) || t || {};
          return `${fn.name || 'tool'}(${fn.arguments || '{}'})`;
        }).join('; ');
        segs.push(`[called tools: ${calls}]`);
      }
      if (segs.length) parts.push('[Assistant]\n' + segs.join('\n\n'));
    } else if (role === 'tool') {
      const id = m.tool_call_id || 'unknown';
      const name = m.name || 'tool';
      parts.push(`[Client Tool Result: ${id} ${name} status=succeeded]\n${content}`);
    } else if (content) {
      parts.push(content);
    }
  }
  return JSON.stringify([{ type: 'text', data: { content: parts.join('\n\n') } }]);
}

/**
 * 会话 id：同账号同模型稳定（hub 口径——它是 remote 侧的会话键，随机化等于
 * 每轮新会话）。与 channel-pool.sessionKeyOf 同思路：账号 + 模型派生 UUID。
 */
function remoteSessionId(uid, model) {
  const material = [String(uid || 'default'), String(model || 'auto')].join('\x1f');
  const digest = crypto.createHash('sha256').update(material).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

/**
 * code 模式的 common_params（Trae2api-cn 同款最小集；work 档的字段不预编）。
 * **返回值是 JSON 字符串不是对象**——请求体里 initial_message.common_params
 * 是序列化后的串（Trae2api-cn 的测试断言 json.loads(...) 可证）。会话键进
 * `biz_session_id`。user_identity 取账号的付费身份（Free 档实测就是 "Free"）。
 */
function commonParams(auth, mode, sessionId) {
  const uid = String(auth.uid || '');
  const params = {
    language: 'zh-cn',
    app_language: 'zh-CN',
    quality: 'stable',
    app_version: '1.0.0.1229',
    web_id: '',
    user_identity: String(auth.payIdentity || 'Free'),
    is_freshman: '0',
    biz_user_id: uid,
    user_unique_id: uid,
    scope: 'marscode-cn',
    tenant: 'marscode',
    region: 'cn',
    aiRegion: 'cn',
    is_privacy_mode: 0,
    privacy_mode: 'off',
    solo_chat_mode: mode,
    biz_session_id: sessionId,
  };
  return JSON.stringify(params);
}

/** remote 请求头（build_headers 同款；web 客户端身份是这族端点的门槛） */
function remoteHeaders(auth, opts = {}) {
  return {
    Authorization: `Cloud-IDE-JWT ${auth.accessToken}`,
    'Content-Type': 'application/json',
    Accept: opts.stream ? 'text/event-stream' : 'application/json',
    'X-Trae-Client-Type': 'web',
    'X-Preferenced-Language': 'zh-CN',
    'x-user-region': 'CN',
    Origin: c.REMOTE_ORIGIN,
    Referer: c.REMOTE_ORIGIN + '/',
    'User-Agent': c.REMOTE_UA,
  };
}

function agentOf(auth) {
  try { return require('../proxy-agent').getAgentFor(auth); } catch (e) { throw new Error(`出站代理配置错误: ${e.message}`); }
}

/**
 * 建会话。mode 'code'（对话）| 'work'（执行档，字段未实测不预编）。
 * 返回 { ok, sessionId, messageId, error, status }。
 */
function createSession(auth, opts = {}) {
  const base = remoteBaseOf(auth.region);
  if (!base) return Promise.resolve({ ok: false, error: 'remote 链路国际版基址未实测，暂不支持国际账号' });
  const mode = opts.mode === 'work' ? 'work' : 'code';
  const agentType = opts.agentType || (mode === 'work' ? 'solo_work_remote' : 'solo_agent_remote');
  const model = String(opts.model || '');
  const sessionId = opts.sessionId || remoteSessionId(auth.uid, model);
  const body = {
    mode,
    environment_id: 'default',
    env: 'remote',
    auto_create_project: false,
    origin: 'web',
    initial_message: {
      chat_session_id: '',
      content: [],
      query: flattenQuery(opts.messages || []),
      model_name: model,
      agent_type: agentType,
      // agent_id 不带会被 remote 静默落到默认档（Trae2api-cn 注释明示）
      agent_id: agentType,
      model_selection_strategy: opts.strategy || 'auto',
      common_params: commonParams(auth, mode, sessionId),
    },
  };
  return new Promise((resolve) => {
    let agent;
    try { agent = agentOf(auth); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const u = new URL(base + '/chat_sessions');
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { ...remoteHeaders(auth, { stream: false }), 'Content-Length': Buffer.byteLength(payload) },
      timeout: CONNECT_TIMEOUT_MS,
      ...(agent ? { agent } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          return resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode} ${raw.slice(0, 300)}` });
        }
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
        const d = (data && (data.data || data.Result || data)) || {};
        const sid = String(d.chat_session_id || '');
        const mid = String(d.message_id || '');
        if (!sid || !mid) return resolve({ ok: false, status: res.statusCode, error: `create_session 缺 id: ${raw.slice(0, 200)}` });
        resolve({ ok: true, sessionId: sid, messageId: mid, raw: d });
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* 已结束 */ } resolve({ ok: false, error: 'connect timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

/**
 * 订阅事件流（GET /chat_sessions/{id}/events?reply_to_message_id=<mid>）。
 * onEvent({ event, data })；[DONE] 哨兵后 resolve('done')。
 * 解析按标准 SSE 事件块（与 chat.js 的自定义块不同：哨兵是 data: [DONE]）。
 */
function streamEvents(auth, sessionId, messageId, onEvent, opts = {}) {
  const base = remoteBaseOf(auth.region);
  if (!base) return Promise.resolve({ ok: false, error: 'remote 链路国际版未支持' });
  return new Promise((resolve) => {
    let agent;
    try { agent = agentOf(auth); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const u = new URL(`${base}/chat_sessions/${encodeURIComponent(sessionId)}/events`);
    u.searchParams.set('reply_to_message_id', messageId);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: remoteHeaders(auth, { stream: true }),
      timeout: 0, // 长流不设总超时；首事件超时自己管
      ...(agent ? { agent } : {}),
    }, (res) => {
      if (res.statusCode >= 400) {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode} ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}` }));
        res.resume();
        return;
      }
      const dec = new StringDecoder('utf8');
      let buf = '';
      let firstEventSeen = false;
      let settleGuard = false;
      const settle = (v) => { if (settleGuard) return; settleGuard = true; clearTimeout(firstTimer); try { res.destroy(); } catch (e) { /* 已结束 */ } resolve(v); };
      // 首事件超时：排队/心跳帧不算模型活动——remote 会先吐 queue/heartbeat
      const firstTimer = setTimeout(() => {
        settle({ ok: false, error: `首事件超时（${FIRST_EVENT_MS}ms 内无任何模型事件）` });
      }, FIRST_EVENT_MS);
      if (firstTimer.unref) firstTimer.unref();
      const MODEL_EVENTS = new Set(['model_config', 'plan_item', 'message', 'assistant_message', 'response', 'text', 'output', 'token_usage', 'done']);
      const norm = (name) => String(name || '').trim().toLowerCase();
      const flushBlock = (block) => {
        const lines = block.split('\n');
        let event = '';
        const dataLines = [];
        for (const l of lines) {
          const t = l.replace(/\r$/, '');
          if (t.startsWith(':')) continue; // SSE 注释（心跳注释帧）
          if (t.startsWith('event:')) event = t.slice(6).trim();
          else if (t.startsWith('data:')) dataLines.push(t.slice(5).trim());
        }
        const raw = dataLines.join('\n');
        if (raw === '[DONE]') { settle({ ok: true, done: true }); return; }
        let data = null;
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { _raw: raw }; } }
        const n = norm(event) || norm(data && (data.event || data.event_type)) || 'message';
        if (!firstEventSeen && MODEL_EVENTS.has(n)) {
          firstEventSeen = true;
          clearTimeout(firstTimer);
        }
        // **终结判据是 event:done**（2026-11-01 真机实测定案）：上游发完 done
        // 帧后直接关流，没有 data:[DONE] 哨兵——只认 [DONE] 会把完整回答
        // 误判成「流被掐断」（Trae2api-cn 的 saw_terminal 判的也是 done 事件）。
        if (n === 'done') {
          try { onEvent({ event: n, data }); } catch (e) { /* 消费方异常不掐流 */ }
          settle({ ok: true, done: true });
          return;
        }
        try { onEvent({ event: n, data }); } catch (e) { /* 消费方异常不掐流 */ }
      };
      res.on('data', (chunk) => {
        buf += dec.write(chunk);
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (block.trim()) flushBlock(block);
          if (settleGuard) return;
        }
      });
      res.on('end', () => {
        buf += dec.end();
        if (buf.trim()) flushBlock(buf);
        // 连接关闭但没见到 [DONE]：remote 可能静默断流（Trae2api-cn
        // RemoteStreamIncomplete 同款判据——不能让半截答案装成正常收尾）
        settle({ ok: false, error: '事件流在 [DONE] 前被关闭', incomplete: !firstEventSeen });
      });
      res.on('error', (e) => settle({ ok: false, error: e.message }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* 已结束 */ } });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

/** 中断会话（best-effort，失败静默——中断的目的是停止上游烧钱） */
function stopSession(auth, sessionId, messageId) {
  const base = remoteBaseOf(auth.region);
  if (!base || !sessionId || !messageId) return Promise.resolve(false);
  return new Promise((resolve) => {
    let agent;
    try { agent = agentOf(auth); } catch (e) { return resolve(false); }
    const u = new URL(`${base}/chat_sessions/${encodeURIComponent(sessionId)}/stop`);
    const payload = JSON.stringify({ chat_session_id: sessionId, user_message_id: messageId });
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { ...remoteHeaders(auth, { stream: false }), 'Content-Length': Buffer.byteLength(payload) },
      timeout: 10000,
      ...(agent ? { agent } : {}),
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode < 400)); });
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* 已结束 */ } resolve(false); });
    req.on('error', () => resolve(false));
    req.write(payload);
    req.end();
  });
}


// ---------------------------------------------------------------------------
// 事件 → OpenAI chunk 翻译（2026-11-01 真机实测定案的形状）
//
// plan_item 是**累积快照**不是增量：同一 id 的每帧 thought/reasoning_content
// 都是「到目前为止的全文」（实测同一轮连收 4 帧「明白」→「明白明白」→…→全量）。
// 翻译层用快照/增量双判：新串以前串开头 = 快照（取新增量）；否则按增量追加。
// 判错的后果是把全文重复发 4 遍，客户端看到复读。
// ---------------------------------------------------------------------------

/** 快照/增量双判累积器。push 返回**新增量**（发 delta 用），value 取全文 */
function textAccumulator() {
  let acc = '';
  return {
    push(chunk) {
      const t = String(chunk || '');
      if (!t) return '';
      let delta;
      if (!acc) { acc = t; delta = t; }
      else if (t.startsWith(acc)) { delta = t.slice(acc.length); acc = t; }
      else if (acc.startsWith(t)) { delta = ''; } // 旧快照迟到，忽略
      else { acc += t; delta = t; }
      return delta;
    },
    value() { return acc; },
  };
}

/** remote 事件流的聚合结果形状（与 chat.aggregate 对齐的 OpenAI 形状） */
function aggregateEvents(events, model) {
  const text = textAccumulator();
  const reasoning = textAccumulator();
  let usage = null;
  let modelName = model;
  let finish = null;
  let errEvent = null;
  for (const ev of events) {
    const d = (ev && ev.data) || {};
    if (ev.event === 'plan_item') {
      text.push(d.thought);
      reasoning.push(d.reasoning_content);
    } else if (ev.event === 'token_usage') {
      usage = d;
    } else if (ev.event === 'model_config' && (d.config_name || d.model_name)) {
      modelName = d.config_name || d.model_name;
    } else if (ev.event === 'done') {
      finish = d;
    } else if (ev.event === 'error') {
      errEvent = d;
    }
  }
  const message = { role: 'assistant', content: text.value() };
  const r = reasoning.value();
  if (r) message.reasoning_content = r;
  const out = {
    id: 'traework-remote',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [{
      index: 0,
      message,
      finish_reason: finish && finish.status === 'completed' ? 'stop' : (finish ? 'stop' : null),
    }],
    usage: usage ? {
      prompt_tokens: Number(usage.prompt_tokens) || 0,
      completion_tokens: Number(usage.completion_tokens) || 0,
      total_tokens: Number(usage.total_tokens) || 0,
      completion_tokens_details: { reasoning_tokens: Number(usage.reasoning_tokens) || 0 },
    } : null,
  };
  if (errEvent) out.error = errEvent;
  return out;
}

/**
 * 一次完整 remote 回合：建会话 → 订事件 → 聚合。
 * onEvent 可选（流式路径逐事件回调，收 {event, data}）。
 * 返回 { ok, aggregate, messageId, sessionId, error, status }。
 */
async function runTurn(auth, opts = {}) {
  const cs = await createSession(auth, opts);
  if (!cs.ok) return { ok: false, error: cs.error, status: cs.status };
  const events = [];
  const sr = await streamEvents(auth, cs.sessionId, cs.messageId, (ev) => {
    events.push(ev);
    if (opts.onEvent) { try { opts.onEvent(ev); } catch (e) { /* 上报失败不影响流 */ } }
  }, opts);
  if (!sr.ok) {
    // 上游事件里的 error 已在 events 里（error 事件优先于传输层错误）
    const errEv = events.find((e) => e.event === 'error');
    if (errEv) {
      const d = errEv.data || {};
      return { ok: false, error: `traework remote ${d.code || ''}: ${d.message || '上游错误'}`, events, sessionId: cs.sessionId, messageId: cs.messageId };
    }
    return { ok: false, error: sr.error, events, sessionId: cs.sessionId, messageId: cs.messageId };
  }
  const doneEv = events.find((e) => e.event === 'done');
  const status = doneEv && doneEv.data && String(doneEv.data.status || '');
  if (status && status !== 'completed') {
    return { ok: false, error: `traework remote 回合未完成（status=${status}）`, events, sessionId: cs.sessionId, messageId: cs.messageId };
  }
  return { ok: true, aggregate: aggregateEvents(events, opts.model || ''), messageId: cs.messageId, sessionId: cs.sessionId, events };
}

module.exports = {
  remoteBaseOf, flattenQuery, remoteSessionId, commonParams, remoteHeaders,
  createSession, streamEvents, stopSession, textAccumulator, aggregateEvents, runTurn,
};
