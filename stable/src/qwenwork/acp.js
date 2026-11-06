// src/qwenwork/acp.js - 千问办公 ACP 会话通道（qwen-acp/ 前缀，2026-11-04）
//
// 与 chat 桥（./index.js）的关系：**不是同一类东西**。chat 桥是对话型
// agent_chat_generation HTTP 链路；ACP 是 agent 型会话协议（REST 建会话 +
// WebSocket 带信封 JSON-RPC），上游自己带沙箱与脚手架。所以做成独立
// provider（qianfan-raw 同款接入：upstream-router 给 target.provider），
// 不塞进现有 chat 桥。
//
// 协议证据（全部实测自 tang-bugu/dsh-connect-qwenwork 的 README，2026-10-22
// 真机跑通、10-29 补 32KB 上限；本项目未独立复测，联调时按日志修正）：
//
//   REST POST /api/chat-sessions   Authorization: Bearer → 201 {id}
//   WS   wss://qwenwork.cn/api/chat-ws  Authorization: Bearer → 101
//     → {"type":"control","payload":{"method":"ping"}}                → pong
//     → control join      {params:{sessionId}}                        ← join_ack{accepted:true}
//     → control new_prompt{id, params:{sessionId, prompt:[{type:"text",text}]}}
//                                                                   ← result{promptId,turnId}
//                                                                   ← new_prompt_ack{accepted:true}
//     ← data 帧 session_status: idle   **上一轮遗留，必须忽略**
//     ← data 帧 session_status: running                     本轮真的开始
//     ← data 帧 session/update: agent_thought_chunk / agent_message_chunk
//     ← data 帧 session_status: idle                        本轮结束
//
//   · 裸 JSON-RPC 被拒 `{"code":-32700,"message":"unknown envelope type"}`——
//     必须包 `{"type":"control"|"data","payload":{…}}` 信封。
//   · 结束判据：**见过 running 或正文增量之后的 idle**。开始前的遗留 idle
//     单看「有没有 idle」会把回复截断成空。
//   · 单条消息 ≤ 32768 字节（未压缩字节），超限 1009 断开，压缩救不了——
//     发送前必须裁剪（promptOf）。
//   · 模型档位由账号/套餐决定，new_prompt 不接受逐轮指定——`qwen-acp/` 下的
//     模型名只是调用方标签，不影响上游。
//   · 每条请求开新会话：复用会把客户端已组装的上下文在上游 agent 会话里
//     重跑一遍（重复计费），代价是上游留下短会话。
//
// 帧的具体 JSON 路径 README 没给全（只给了事件名与语义），解析用**标记搜索**
// 的宽松归一（normalizeFrame）：在帧里找事件名字段，再在邻位取内容——真机
// 联调时按 DEBUG 日志（DUMATE_QWENWORK_ACP_DEBUG=1 打印未知帧）收紧。
'use strict';
const https = require('https');
const { WsClient } = require('./wsclient');
const c = require('./constants');
const channelPool = require('../channel-pool');

const CHANNEL = 'qwenwork';
const REQ_ID_PREFIX = 'qacp';
const TURN_TIMEOUT_MS = () => {
  const n = parseInt(process.env.DUMATE_QWENWORK_ACP_TIMEOUT_MS || '600000', 10);
  return Number.isFinite(n) && n > 0 ? n : 600000;
};

// ---- 纯函数：messages → 单条 prompt 文本（带 32KB 裁剪）----

function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (p && typeof p === 'object') {
        if (p.type === 'text') return String(p.text || '');
        if (p.type === 'image_url') return '[image omitted]';
        if (p.type === 'input_image') return '[image omitted]';
        return `[${String(p.type || 'part')} omitted]`;
      }
      return String(p);
    }).join('');
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    return JSON.stringify(content);
  }
  return String(content);
}

function serializeMessage(m) {
  const role = m && m.role ? String(m.role) : 'user';
  if (role === 'tool') {
    return `[tool result] ${contentText(m.content)}`;
  }
  if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
    const calls = m.tool_calls.map((t) => `[calls ${t.function && t.function.name}] ${(t.function && t.function.arguments) || ''}`).join('\n');
    const text = contentText(m.content);
    return `[assistant] ${text}${text ? '\n' : ''}${calls}`.trimEnd();
  }
  const tag = role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user';
  return `[${tag}] ${contentText(m.content)}`;
}

/**
 * OpenAI messages → 一条 ACP prompt 文本。
 *
 * 裁剪（dsh-connect 同策略）：超预算时保住系统提示与最新的消息，从最老的
 * 一侧整条丢弃，在正文里留省略标记；最新那条自己就超限的，保头尾各一段
 * （结论常在尾部）。
 *
 * 上限按**未压缩 UTF-8 字节数**算（上游 1009 是字节级限制），默认给 32000
 * 留 768 字节信封余量。
 */
function promptOf(messages, maxBytes) {
  const cap = Number(maxBytes) > 0 ? Number(maxBytes) : c.ACP_MAX_PROMPT_BYTES - 768;
  const lines = (Array.isArray(messages) ? messages : []).map(serializeMessage);
  const byteLen = (s) => Buffer.byteLength(s, 'utf8');
  const systemIdx = lines.findIndex((l) => l.startsWith('[system]'));
  const system = systemIdx >= 0 ? lines[systemIdx] : '';
  const body = lines.filter((l, i) => i !== systemIdx);
  const OMISSION = (n) => `[上游单条消息上限 32KB：已省略较早的 ${n} 条消息…]`;

  if (byteLen([...(system ? [system] : []), ...body].join('\n')) <= cap) {
    return [...(system ? [system] : []), ...body].join('\n').trim();
  }

  // 从最老的一侧丢，直到装下（至少保留最后一条）
  const kept = body.slice();
  let dropped = 0;
  while (kept.length > 1) {
    kept.shift();
    dropped++;
    const probe = [...(system ? [system] : []), ...(dropped ? [OMISSION(dropped)] : []), ...kept].join('\n');
    if (byteLen(probe) <= cap) break;
  }
  let parts = [...(system ? [system] : []), ...(dropped ? [OMISSION(dropped)] : []), ...kept];
  // 最新一条自己超限：保头尾（结论常在尾部）
  if (byteLen(parts.join('\n')) > cap) {
    const last = parts[parts.length - 1];
    const budget = cap - byteLen(parts.slice(0, -1).join('\n')) - 64;
    if (budget > 0) {
      const head = last.slice(0, Math.max(0, Math.floor(budget * 0.6)));
      const tail = last.slice(Math.max(0, last.length - Math.floor(budget * 0.4)));
      parts = [...parts.slice(0, -1), `${head}\n[…已截断…]\n${tail}`];
    } else {
      parts = [last.slice(0, Math.max(0, cap - 64))];
    }
  }
  return parts.join('\n').trim();
}

// ---- 纯函数：WS 帧 → 归一化事件 ----

/** 在对象里找「值等于标记」的字段所在节点（深度优先，限深防循环） */
function findMarked(obj, marks, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  // sessionUpdate 是真机采样确认的 ACP update 事件名键（2026-11-05）
  for (const k of ['type', 'method', 'name', 'event', 'kind', 'sessionUpdate']) {
    if (typeof obj[k] === 'string' && marks.includes(obj[k])) return obj;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const hit = findMarked(v, marks, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function textOf(node) {
  if (!node) return '';
  for (const k of ['text', 'delta', 'content', 'chunk']) {
    const v = node[k];
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const inner = textOf(v);
      if (inner) return inner;
    }
  }
  return '';
}

/** 忽略类帧（真机采样：沙箱生命周期与队列通知，无消费价值） */
const IGNORE_METHODS = new Set(['sandbox_status', 'replay_start', 'replay_end', 'refresh_prompt_queue']);

/**
 * 归一化一帧 WS 消息。返回 {kind, ...}：
 *   pong / join_ack{accepted} / prompt_result / prompt_ack
 *   status{state}（starting|idle|running|…）
 *   thought{text} / message{text}
 *   ignore（沙箱生命周期等，不进 DEBUG）/ unknown（DEBUG 时打印）
 *
 * 真机采样形状（2026-11-05，与 dsh-connect README 语义一致、路径更精确）：
 *   control 帧承载方法与响应：{jsonrpc, method, params}——join_ack 的 accepted
 *   在 params 里；session_status 的档位在 params.sessionStatus；
 *   {id, result:{promptId, turnId}} 是 new_prompt 的响应。
 *   data 帧承载通知：{seq, payload:{method:'session/update',
 *   params:{update:{sessionUpdate:'agent_message_chunk', content:{text}, …}}}}。
 */
function normalizeFrame(msg) {
  let f = null;
  try { f = JSON.parse(msg.data); } catch (e) { return { kind: 'unknown', raw: String(msg.data || '').slice(0, 200) }; }
  const p = (f && typeof f === 'object' && f.payload && typeof f.payload === 'object') ? f.payload : (f || {});
  if (p.method === 'ping') return { kind: 'ping' };
  if (p.method === 'pong') return { kind: 'pong' };
  if (IGNORE_METHODS.has(p.method)) return { kind: 'ignore' };

  const joinAck = findMarked(p, ['join_ack', 'joined']);
  if (joinAck) {
    const acc = joinAck.params ? joinAck.params.accepted : joinAck.accepted;
    return { kind: 'join_ack', accepted: acc !== false };
  }

  const promptAck = findMarked(p, ['new_prompt_ack']);
  if (promptAck) {
    const acc = promptAck.params ? promptAck.params.accepted : promptAck.accepted;
    return { kind: 'prompt_ack', accepted: acc !== false };
  }

  // new_prompt 的响应：JSON-RPC 风格 result（真机形状 {id:1, result:{promptId, turnId}}）
  if (p.result && typeof p.result === 'object' && (p.result.promptId || p.result.turnId)) {
    return { kind: 'prompt_result', promptId: p.result.promptId, turnId: p.result.turnId };
  }
  if (p.id != null && p.result != null && !Array.isArray(p.result)) {
    return { kind: 'prompt_result', promptId: p.result.promptId, turnId: p.result.turnId };
  }

  const status = findMarked(p, ['session_status']);
  if (status) {
    const src = status.params || status;
    const st = src.sessionStatus || src.status || src.state || src.value;
    return { kind: 'status', state: String(st || '').toLowerCase() };
  }

  const thought = findMarked(p, ['agent_thought_chunk']);
  if (thought) return { kind: 'thought', text: textOf(thought) };
  const message = findMarked(p, ['agent_message_chunk', 'agent_message']);
  if (message) return { kind: 'message', text: textOf(message) };

  return { kind: 'unknown', raw: String(msg.data || '').slice(0, 200) };
}

// ---- REST：建会话 ----

/**
 * 建会话响应里的上游实定档位（extra_data.mode）。tang-bugu README 实测它回
 * "flash"——new_prompt 不接受逐轮指定模型，这个字段是「上游到底给了哪个档」
 * 的唯一观测口。取不到返回空串，不编默认值。
 */
function sessionModeOf(j) {
  if (!j || typeof j !== 'object') return '';
  const src = (j.data && typeof j.data === 'object') ? j.data : j;
  return String((src.extra_data && src.extra_data.mode) || '');
}

function createSession(token) {
  return new Promise((resolve, reject) => {
    const u = new URL(c.ACP_ORIGIN + c.ACP_SESSIONS_PATH);
    const body = '{}';
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (x) => { b += x; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const e = new Error(`qwen-acp ${res.statusCode}: ${b.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
          e.statusCode = res.statusCode;
          return reject(e);
        }
        try {
          const j = JSON.parse(b);
          const id = j.id || (j.data && j.data.id) || j.sessionId || (j.data && j.data.sessionId);
          if (!id) return reject(new Error('qwen-acp: 会话响应缺 id'));
          resolve({ id, raw: j, ...(sessionModeOf(j) ? { mode: sessionModeOf(j) } : {}) });
        } catch (e) {
          reject(new Error('qwen-acp: 会话响应不是 JSON'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('qwen-acp: 建会话超时')); });
    req.write(body);
    req.end();
  });
}

// ---- 一个完整回合 ----

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 跑一轮 ACP 对话。onChunk 收 OpenAI chunk JSON 串（正文/思维链增量）。
 * 返回 { text, reasoning }。结束判据：见过 running 或增量之后的 idle。
 */
async function runTurn({ token, sessionId, prompt, onChunk, debug, wsUrl }) {
  const ws = new WsClient(
    // wsUrl 供测试注入本地回环；生产按常量拼（2026-11-04 真实上游探测：
    // wss 握手回 401 JWT verification fails——端点存在、鉴权确为 Bearer JWT，
    // 与 README 结论一致）
    wsUrl || `${c.ACP_ORIGIN.replace(/^http/, 'ws')}${c.ACP_WS_PATH}`,
    { Authorization: `Bearer ${token}` },
    { idleMs: TURN_TIMEOUT_MS() },
  );
  const state = {
    sawRunning: false,
    sawContent: false,
    idleAfterStart: false,
    text: '',
    reasoning: '',
    joinOk: false,
    promptAccepted: false,
    closed: false,
    error: null,
  };
  let finishResolve = null;
  const finished = new Promise((r) => { finishResolve = r; });
  let reqIdSeq = 1;

  const emit = (delta, field) => {
    if (!delta) return;
    state.sawContent = true;
    if (onChunk) {
      onChunk(JSON.stringify({
        id: `${REQ_ID_PREFIX}-${Date.now().toString(36)}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: '',
        choices: [{ index: 0, delta: { [field]: delta } }],
      }));
    }
  };

  const send = (obj) => ws.send(JSON.stringify({ type: 'control', payload: obj }));

  ws.opts.onMessage = (m) => {
    const ev = normalizeFrame(m);
    if (debug && ev.kind === 'unknown') console.log(`[qwen-acp] 未知帧: ${ev.raw}`);
    switch (ev.kind) {
      case 'ping': send({ method: 'pong' }); break;
      case 'join_ack':
        state.joinOk = ev.accepted !== false;
        if (!state.joinOk) {
          state.error = new Error('qwen-acp: join 被拒（会话不可用）');
          finishResolve();
        }
        break;
      case 'prompt_result':
      case 'prompt_ack':
        state.promptAccepted = true;
        break;
      case 'status':
        if (ev.state === 'running') state.sawRunning = true;
        if (ev.state === 'idle' && (state.sawRunning || state.sawContent)) {
          state.idleAfterStart = true;
          finishResolve();
        }
        // 开始前的遗留 idle：忽略（README 的第一坑）
        break;
      case 'thought':
        if (ev.text) { state.reasoning += ev.text; emit(ev.text, 'reasoning_content'); }
        break;
      case 'message':
        if (ev.text) { state.text += ev.text; emit(ev.text, 'content'); }
        break;
      default:
        break;
    }
  };
  ws.opts.onClose = (code) => {
    state.closed = true;
    if (!state.error && !state.idleAfterStart) {
      state.error = new Error(`qwen-acp: 连接在上游收尾前断开（code=${code}）`);
      // 1009 = 上游 32KB 上限（发送侧漏裁剪时的最后防线）
      if (code === 1009) state.error.message += '：消息超过 32KB 上限';
    }
    finishResolve();
  };
  ws.opts.onError = (e) => { if (!state.error) state.error = e; };

  try {
    await ws.connect();
    send({ method: 'ping' });
    send({ method: 'join', params: { sessionId } });
    const id = reqIdSeq++;
    send({
      method: 'new_prompt',
      id,
      params: { sessionId, prompt: [{ type: 'text', text: prompt }] },
    });
    // 整轮超时：agent 会话有沙箱启动开销（实测 15~17s），长任务更久——
    // 看门狗由 wsclient 的读空闲兜底，这里是整体硬顶
    const timer = setTimeout(() => {
      if (!state.error) {
        state.error = new Error(`qwen-acp: 回合超时（${TURN_TIMEOUT_MS()}ms，sawRunning=${state.sawRunning}）`);
      }
      finishResolve();
    }, TURN_TIMEOUT_MS());
    if (typeof timer.unref === 'function') timer.unref();
    await finished;
    clearTimeout(timer);
  } finally {
    ws.close(1000, 'done');
  }

  if (state.error) throw state.error;
  if (!state.promptAccepted) throw new Error('qwen-acp: 上游未确认 new_prompt（无 result/ack）');
  if (!state.sawRunning && !state.sawContent) {
    throw new Error('qwen-acp: 会话没有进入 running 也没有任何增量（可能被上游拒绝）');
  }
  return { text: state.text, reasoning: state.reasoning };
}

// ---- provider 接口 ----

function status() {
  try {
    const authStore = require('./auth');
    const usable = authStore.findUsable();
    return { ready: usable.length > 0, accounts: usable.length, error: usable.length ? '' : '千问办公没有可用账号' };
  } catch (e) {
    return { ready: false, accounts: 0, error: e.message };
  }
}

// 上游实定档位（最近一次建会话的 extra_data.mode）。模块级记忆——管理端
// /qwenwork/status 经 lastMode() 读它，模型页显示「ACP 实际档位」。
// new_prompt 不接受逐轮指定，这个字段是上游按账号/套餐定档的唯一观测口。
let lastSeenMode = null;

/** 模型档位由账号/套餐决定（new_prompt 不接受逐轮指定），只列一个标签 */
function listModels() { return ['auto']; }

/** 最近一次 ACP 会话的上游实定档位（无会话时 null，不编默认值） */
function lastMode() { return lastSeenMode; }

/**
 * provider 入口（qianfan-raw 同形）。
 * onChunk 存在 = 流式；不存在 = 非流式聚合。
 * opts.probe：探针模式——失败不喂池。
 */
async function send(payload, onChunk, opts = {}) {
  const authStore = require('./auth');
  const chat = require('./chat');
  const model = String((payload && payload.model) || 'auto').replace(/^qwen-acp\//, '');
  const prompt = promptOf(payload && payload.messages);
  if (!prompt) {
    const e = new Error('qwen-acp: 空 prompt（messages 缺失或全空）');
    e.statusCode = 400;
    throw e;
  }
  const debug = process.env.DUMATE_QWENWORK_ACP_DEBUG === '1';
  const region = opts.region === 'intl' ? 'intl' : '';
  if (region === 'intl') {
    // 协议证据只有 CN 域（qwenwork.cn），国际账号不路由——如实拒绝不猜
    const e = new Error('qwen-acp: ACP 链路暂只有国内证据，国际账号未接入');
    e.statusCode = 503;
    throw e;
  }

  const usable = authStore.findUsable();
  if (!usable.length) throw Object.assign(new Error('qwen-acp: 没有可用账号'), { statusCode: 503 });

  const tried = new Set();
  let lastErr = null;
  for (let i = 0; i < Math.min(3, usable.length); i++) {
    const sel = channelPool.pickCandidate(CHANNEL, usable.filter((a) => !tried.has(a.id)), {
      sessionKey: channelPool.sessionKeyOf(payload, opts),
      model: `qwen-acp/${model}`,
    });
    if (!sel) break;
    tried.add(sel.account.id);
    const { uid } = sel;
    try {
      const account = await chat.ensureAccount(authStore, sel.account);
      if (opts.onAccount) {
        const name = account.nickname || account.uid || `账号 ${account.id}`;
        try { opts.onAccount(name, account.id); } catch (e) { /* 上报失败不影响请求 */ }
      }
      if (opts.onModel) {
        try { opts.onModel(`qwen-acp/${model}`); } catch (e) { /* 同上 */ }
      }
      const sess = await createSession(account.accessToken);
      if (sess.mode) lastSeenMode = sess.mode;
      if (debug && sess.mode) console.log(`[qwen-acp] 上游会话档位: ${sess.mode}`);
      const out = await runTurn({
        token: account.accessToken,
        sessionId: sess.id,
        prompt,
        onChunk,
        debug,
      });
      channelPool.noteSuccess(CHANNEL, sel.account.id);
      if (sel.account.lastError) {
        try { authStore.patch(sel.account.id, { lastError: '' }); } catch (e) { /* 忽略 */ }
      }
      if (onChunk) {
        onChunk(JSON.stringify({
          id: `${REQ_ID_PREFIX}-fin-${Date.now().toString(36)}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: `qwen-acp/${model}`,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }));
        onChunk('[DONE]');
        return { streamed: true };
      }
      // 非流式聚合（usage 无数据源：ACP 帧不带 token 计量，不编数）
      return {
        id: `${REQ_ID_PREFIX}-${Date.now().toString(36)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: `qwen-acp/${model}`,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: out.text,
            ...(out.reasoning ? { reasoning_content: out.reasoning } : {}),
          },
          finish_reason: 'stop',
        }],
        usage: {},
      };
    } catch (e) {
      lastErr = e;
      // 探针模式（opts.probe）不喂池——观测动作不把健康账号打成冷却
      if (!opts.probe) {
        channelPool.noteError(CHANNEL, sel.account.id, {
          status: Number(e.statusCode) || 0, message: e.message, model: `qwen-acp/${model}`,
        });
      }
      // 4xx 是请求本身的问题，换号无用
      const st = Number(e.statusCode) || 0;
      if (st >= 400 && st < 500 && st !== 401 && st !== 402 && st !== 429) throw e;
      await sleep(300);
    } finally {
      channelPool.release(uid);
    }
  }
  throw lastErr || Object.assign(new Error('qwen-acp: 没有可用账号'), { statusCode: 503 });
}

module.exports = {
  status, listModels, send,
  promptOf, normalizeFrame, createSession, runTurn, sessionModeOf, lastMode,
  contentText, serializeMessage,
};
