// src/traework/solo.js - TRAE SOLO/IDE raw 链路（2026-11-06，#12）
//
// TraeCode 的 llm_raw_chat 端点（Trae2api-cn 的 raw_client.py TraeCode 契约 +
// 本项目真机实测打通，探测记录见 test/ 历史与 CLAUDE.md 备注）：
//
//   POST {base}/api/ide/v2/llm_raw_chat   （失败回退 v1 → api5-normal v2）
//
// 与 utils_chat（llm_utils_chat）的关键差异：
//   · body 九字段：config_name（族名）+ model_name（**model_detail_list 的
//     __dev 全名**）+ encrypted_model_params（上游下发的现成加密信封，**字符串
//     原样透传**——解析成对象会被 400 拒，真机实测）+ conversation_id/session_id
//     （ObjectId 账单键，与 utils_chat 同机制）+ stream + raw_chat_function
//     （solo_agent）+ config_source + messages；
//   · **版本身份必须与 JWT 一致**：X-Ide-Version 用我们自己的 0.1.43 + 动态
//     版本码——Trae2api-cn 的 3.4.4 常量是它的凭证身份（3.4.x 桌面端），套到
//     我们的 TraeWork 0.1.45 JWT 上被上游判 4001/400（实测对照）；
//   · 帧形状与 utils_chat **完全同族**（metadata/timing_cost/output/token_usage/
//     done/error，output 带 tool_calls/multimodal_contents）——chat.js 的
//     readStream/aggregate/toOpenAIChunk/事件门全部直接复用；
//   · **原生 tools 槽**（TraeWork legacy raw 才要 parameters 转字符串；raw v2
//     保持对象）+ assistant 历史用 `function_call` 包装（不是 OpenAI 的
//     function 嵌套）+ tool 消息保留 tool_call_id/name（Trae2api-cn 测试锁定）。
const crypto = require('crypto');
const https = require('https');
const c = require('./constants');
const { soloHeaders } = require('./headers');

/** 端点候选链（Trae2api-cn resolve_traecode_base_urls + v2→v1 同顺序）：
 *  连接级失败才换下一家；拿到 HTTP 响应（含 4xx/5xx）交上层按状态码处置 */
const RAW_ENDPOINTS = [
  { host: c.AGENT_HOST, path: '/api/ide/v2/llm_raw_chat' },
  { host: c.AGENT_HOST, path: '/api/ide/v1/llm_raw_chat' },
  { host: 'https://api5-normal.mchost.guru', path: '/api/ide/v2/llm_raw_chat' },
];

/** TraeCode 差量头（soloHeaders 打底——身份/设备/版本组两族重叠） */
function soloRawHeaders(auth, rawChatFunction, stream = true) {
  return {
    ...soloHeaders(auth, stream),
    'X-Plugin-Channel': 'desktop',
    'X-App-Function': rawChatFunction,
    'X-Ide-Function': rawChatFunction,
    'X-Request-Id': crypto.randomUUID(),
  };
}

/** content 归一为 raw 的原生数组形状（[{type:'text',text}]）。
 *  图像块降级为占位文本（渲染层媒体块形状未实测，不预编——remote.js 同口径） */
function textBlocksOf(content) {
  if (content == null || content === '') return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const p of content) {
    if (typeof p === 'string') { parts.push(p); continue; }
    if (p && typeof p === 'object') {
      if (p.type === 'text' && p.text) parts.push(String(p.text));
      else if (p.type === 'image_url') parts.push('[图片：本链路暂不支持，请以文字描述]');
    }
  }
  return parts.length ? [{ type: 'text', text: parts.join('\n') }] : [];
}

/** assistant 的 tool_calls → raw 的原生形状（function_call 包装，非 OpenAI 嵌套） */
function nativeToolCalls(toolCalls) {
  const out = [];
  for (const t of Array.isArray(toolCalls) ? toolCalls : []) {
    const fn = (t && t.function) || t || {};
    const name = String(fn.name || t.name || '');
    if (!name) continue;
    let args = fn.arguments != null ? fn.arguments : fn.input;
    if (typeof args !== 'string') {
      try { args = JSON.stringify(args == null ? {} : args); } catch (e) { args = '{}'; }
    }
    out.push({
      id: String(t.id || t.tool_call_id || ''),
      type: String(t.type || 'function'),
      function_call: { name, arguments: args },
    });
  }
  return out;
}

/**
 * OpenAI messages → raw 原生形状。文本内容全部进 content 数组；工具历史走
 * **原生协议**（function_call 包装 + tool 消息回灌）——Trae2api-cn 的
 * test_solo_body_preserves_native_tools_and_tool_history 锁定的形状。
 */
function buildMessages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    let role = m.role || 'user';
    if (role === 'developer') role = 'system';
    const blocks = textBlocksOf(m.content);
    if (role === 'assistant') {
      const calls = nativeToolCalls(m.tool_calls || (m.function_call ? [m.function_call] : []));
      const msg = { role: 'assistant' };
      if (blocks.length) msg.content = blocks;
      if (calls.length) msg.tool_calls = calls;
      if (!blocks.length && !calls.length) continue;
      out.push(msg);
      continue;
    }
    if (role === 'tool') {
      const text = blocks.length ? blocks[0].text : '';
      out.push({
        role: 'tool',
        tool_call_id: String(m.tool_call_id || m.toolCallId || ''),
        name: String(m.name || 'tool'),
        content: [{ type: 'text', text }],
      });
      continue;
    }
    if (role !== 'system' && role !== 'user') role = 'user';
    if (!blocks.length) continue;
    out.push({ role, content: blocks });
  }
  return out;
}

/** tools 过滤成 function 形状（千问 chat.js 同口径：namespace/web_search 等整轮 400）。
 *  **parameters 保持对象**——raw v2 与 TraeWork legacy 不同，不转字符串。 */
function nativeToolsOf(tools) {
  const out = [];
  for (const t of Array.isArray(tools) ? tools : []) {
    const fn = t && (t.function || t);
    if (!fn || !fn.name) continue;
    if (t.type && t.type !== 'function') continue;
    const f = {
      name: String(fn.name),
      ...(fn.description != null ? { description: String(fn.description) } : {}),
      ...(fn.parameters != null ? { parameters: fn.parameters } : {}),
    };
    out.push({ type: 'function', function: f });
  }
  return out;
}

/**
 * 构造 raw v2 请求体。row 是 models.normalize 的归一化行（须带 customModel）。
 * 缺 model_detail_list（没有加密信封）时明确报错——没有信封 raw 必 4001，
 * 静默发等于制造一次上游失败。
 *
 * @returns {{error:string}|{body:object, providerId:string}}
 */
function buildBody(payload, row, meta, opts = {}) {
  const raw = row && row.customModel;
  if (!raw || typeof raw !== 'object') {
    return { error: `solo raw：模型 ${opts.model || ''} 没有上游原始配置对象（模型表未带）` };
  }
  const detail = (Array.isArray(raw.model_detail_list) ? raw.model_detail_list : [])[0] || null;
  const enc = detail && detail.encrypted_model_params;
  if (!detail || !enc) {
    return { error: `solo raw：模型 ${row.id} 的模型表条目缺 model_detail_list/encrypted_model_params（raw 端点必 4001），回落 utils_chat` };
  }
  const messages = buildMessages(payload && payload.messages);
  if (!messages.length) return { error: 'solo raw：messages 为空' };
  if (!meta.sessionId) meta.sessionId = require('./chat').oidSessionId();
  const source = Number(raw.config_source);
  const body = {
    config_name: String(raw.config_name || row.id),
    model_name: String(detail.model_name || row.id),
    conversation_id: meta.sessionId,
    session_id: meta.sessionId,
    stream: true,
    raw_chat_function: opts.rawChatFunction || 'solo_agent',
    config_source: Number.isFinite(source) && source !== 0 ? source : 1,
    // 加密信封**字符串原样**（上游下发的现成信封；解析成对象被 400 拒——真机实测）
    encrypted_model_params: enc,
    messages,
  };
  const tools = nativeToolsOf(payload && payload.tools);
  if (tools.length) {
    body.tools = tools;
    if (payload.tool_choice != null) body.tool_choice = payload.tool_choice;
    if (payload.parallel_tool_calls != null) body.parallel_tool_calls = !!payload.parallel_tool_calls;
  }
  // 与 chat.buildBody 同语义：返回 JSON 字符串（postStream 直接 byteLength + write）
  return { body: JSON.stringify(body), providerId: body.model_name };
}

/**
 * 发流式请求（端点候选链）。rawChatFunction 是 body 里的 raw_chat_function——
 * X-App-Function/X-Ide-Function 头必须与它一致。返回 { stream, status, error,
 * fatal }——与 chat.postStream 的形状对齐，消费方（index.runAttempt）无感切换。
 */
function postSoloStream(bodyJson, auth, rawChatFunction = 'solo_agent') {
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(auth); } catch (e) {
    return Promise.resolve({ stream: null, status: 0, error: `出站代理配置错误: ${e.message}`, fatal: true });
  }
  const candidates = RAW_ENDPOINTS.map((e) => ({ ...e, headers: soloRawHeaders(auth, rawChatFunction, true) }));
  let i = 0;
  const attempt = () => {
    if (i >= candidates.length) {
      return Promise.resolve({ stream: null, status: 0, error: 'solo raw 全部候选端点不可达' });
    }
    const cur = candidates[i++];
    return new Promise((resolve) => {
      let settled = false;
      const settle = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
      const u = new URL(cur.host + cur.path);
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname,
        method: 'POST',
        headers: { ...cur.headers, 'Content-Length': Buffer.byteLength(bodyJson) },
        // 长流不设总超时（socket 空闲 600s 兜底），连接超时独立管
        timeout: c.STREAM_TIMEOUT_MS,
        ...(agent ? { agent } : {}),
      }, (res) => settle({ stream: res, status: res.statusCode }));
      const timer = setTimeout(() => {
        try { req.destroy(new Error(`connect timeout (${cur.host}${cur.path})`)); } catch (e) { /* 已结束 */ }
        settle({ stream: null, status: 0, error: `connect timeout (${cur.host}${cur.path})` });
      }, c.CONNECT_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      req.on('error', (e) => settle({ stream: null, status: 0, error: e.message }));
      req.on('timeout', () => { try { req.destroy(); } catch (e) { /* 已结束 */ } settle({ stream: null, status: 0, error: 'timeout' }); });
      req.write(bodyJson);
      req.end();
    }).then((r) => {
      if (r.stream || r.fatal) return r;
      // 连接层失败（DNS/拒绝/超时）换下一家候选；拿到 HTTP 响应就交上层
      if (r.status !== 0) return r;
      return attempt();
    });
  };
  return attempt();
}

module.exports = { RAW_ENDPOINTS, soloRawHeaders, textBlocksOf, nativeToolCalls, buildMessages, nativeToolsOf, buildBody, postSoloStream };
