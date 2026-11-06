// src/workbuddy/chat.js - 对话（/v2/chat/completions）与请求体规范化
//
// 上游是**标准 OpenAI 形状 + SSE**，但有多条硬校验（两个参照实现交叉实证）：
//   1. 强制 stream:true（非流式 11101，上游不接受非流式）
//   2. role:'developer' → 'system'（上游拒 developer，400/11128）
//   3. tool_choice 对象形态扁平化为字符串；none 时连 tools/functions 一起删
//   4. **首条消息必须 system**（上游 Go struct 硬校验 400；国际版同样）——
//      首条非 system 时前置最小 system 消息（不合并、不改序）
//   5. **conversation_id 必须注入请求体 + X-Conversation 三头必须带**
//      （dsh-xdpool#58 实证：国际版网关缺任一头即 400 11128 "request illegal"；
//      值不校验只查存在）。X-Conversation-ID 与 body 的 conversation_id 同源、
//      同会话稳定——上游前缀缓存不被打散
//   6. prompt_cache_key：按账号硬隔离的前缀缓存键（防对话内容跨账号泄露）
//
// **红线：chat 请求绝不携带 refresh token**（X-Refresh-Token 仅出现在刷新端点）。
const https = require('https');
const crypto = require('crypto');
const c = require('./constants');
const sanitize = require('./sanitize');

/** 24-hex 稳定会话 id：从首条 user 内容指纹派生（同会话跨轮稳定，无锚回落随机） */
function stableConversationId(messages) {
  const first = Array.isArray(messages)
    ? messages.find((m) => m && m.role === 'user') : null;
  const text = first ? JSON.stringify(first.content ?? first) : '';
  if (!text) {
    return crypto.randomBytes(12).toString('hex');
  }
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 24);
}

/** 上游前缀缓存键：wb-<uid 前 8 位>-<sha256(uid|conv)[0..16]>（TraeWorkAssistant 同式） */
function promptCacheKey(uid, convId) {
  const u = String(uid || '');
  const h = crypto.createHash('sha256');
  h.update(u);
  h.update('|');
  h.update(String(convId || ''));
  const hex = h.digest('hex');
  return `wb-${u.slice(0, 8)}-${hex.slice(0, 16)}`;
}

/**
 * 带 function 形状工具的个数。「播报即收尾」修复只对**带工具的请求**启用，
 * 判定口径与 qwenwork/chat.js 的同名函数一致（改过滤规则时两边不要漂移）。
 */
function hasFunctionTools(payload) {
  const t = Array.isArray(payload && payload.tools) ? payload.tools : [];
  return t.filter((x) => x && x.type === 'function' && x.function && x.function.name).length;
}

/**
 * 请求体规范化 + 会话注入。
 * @param {object} payload OpenAI 请求体
 * @param {string} region 'cn' | 'global'
 * @param {object} account 账号（uid 用于缓存键）
 * @returns {{ body: string, convId: string }} 出站 JSON 串与会话 id（三头与 body 同源）
 */
function buildChatBody(payload, region, account) {
  let obj = payload;
  if (typeof payload === 'string') {
    try { obj = JSON.parse(payload); } catch (e) { obj = { messages: [] }; }
  }
  const body = JSON.parse(JSON.stringify(obj || {}));
  body.stream = true;

  // developer → system
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (m && typeof m === 'object' && m.role === 'developer') m.role = 'system';
    }
  }
  // tool_choice 归一
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    if (typeof tc === 'string') {
      if (tc.trim().toLowerCase() === 'none') {
        delete body.tool_choice; delete body.tools; delete body.functions;
      }
    } else if (tc && typeof tc === 'object') {
      const kind = String(tc.type || '').trim().toLowerCase();
      if (kind === 'none') {
        delete body.tool_choice; delete body.tools; delete body.functions;
      } else if (kind === 'auto' || kind === 'required') {
        body.tool_choice = kind;
      } else if (kind === 'function') {
        const n = (tc.function && tc.function.name) || tc.name || '';
        body.tool_choice = String(n).trim() || 'auto';
      } else delete body.tool_choice;
    } else delete body.tool_choice;
  }

  // 首条必须 system（上游 Go struct 硬校验）：非 system 时前置最小 system。
  // 幂等：已 system 不动，重试/多次构造不重复注入
  if (!Array.isArray(body.messages)) body.messages = [];
  const first = body.messages[0];
  if (!first || first.role !== 'system') {
    body.messages.unshift({ role: 'system', content: c.INTERNATIONAL_SYSTEM_PROMPT });
  }

  // 11-128 指纹清洗（hub v1.7.25/26 + v1.9.0）：DSH 生态的 system/assistant
  // 必带身份句与提示词指纹，出站前中性化。放在会话 id 派生之前——清洗不改写
  // user 内容，convId（取首条 user）不受影响，前缀缓存键稳定
  body.messages = sanitize.sanitizeMessages(body.messages);

  // 会话 id：跨轮稳定（前缀缓存不被打散），三头与 body 同源
  const convId = stableConversationId(body.messages);
  body.conversation_id = convId;
  if (account && account.uid) {
    body.prompt_cache_key = promptCacheKey(account.uid, convId);
  }

  return { body: JSON.stringify(body), convId };
}

/**
 * chat 请求头。缺失的身份字段用官方 CLI 的 X-No-* 约定表达；
 * X-Conversation 三头是**国际版硬校验**（缺任一 11128），国内版同样带——
 * 官方客户端每个 chat 请求都带，两版一致才像客户端。
 */
function chatHeaders(region, account, bodyLen, convId) {
  const spec = c.specOf(region);
  const acceptLanguage = region === 'global' ? 'en-US' : 'zh-CN';
  const clientVersion = (process.env.DUMATE_WORKBUDDY_APP_VERSION || '').trim()
    || spec.fallbackAppVersion;
  const h = {
    Accept: 'application/json, text/event-stream',
    'Accept-Language': acceptLanguage,
    'X-CodeBuddy-Request': '1',
    'X-Agent-Purpose': 'conversation',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: spec.billingBase,
    // Referer 带 chat 路径（TraeWorkAssistant 三铁律 1）
    Referer: `${spec.billingBase}${c.EP_CHAT}`,
    'Content-Type': 'application/json',
    'Content-Length': String(bodyLen),
    Authorization: `Bearer ${(account && account.accessToken) || ''}`,
    'X-Product': 'SaaS',
    // 客户端指纹（个人中心「请求明细」按这些头识别客户端）
    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'CLI',
    'X-IDE-Version': clientVersion,
    'X-Request-ID': crypto.randomBytes(16).toString('hex'),
    // 会话三件套（dsh-xdpool#58：缺任一 400 11128）
    'X-Conversation-ID': convId,
    'X-Conversation-Request-ID': crypto.randomBytes(16).toString('hex'),
    'X-Conversation-Message-ID': crypto.randomBytes(16).toString('hex'),
  };
  if (account && account.uid) h['X-User-Id'] = account.uid;
  else h['X-No-User-Id'] = '1';
  if (account && account.enterpriseId) h['X-Enterprise-Id'] = account.enterpriseId;
  else h['X-No-Enterprise-Id'] = '1';
  if (account && account.domain) h['X-Domain'] = account.domain;
  else h['X-No-Department-Info'] = '1';
  return h;
}

// chat 形态 UA：WorkBuddy/<v> + 产品 token（Global「WorkBuddy AI」/ CN「WorkBuddy」）
function chatUserAgent(region) {
  const clientVersion = (process.env.DUMATE_WORKBUDDY_APP_VERSION || '').trim()
    || c.specOf(region).fallbackAppVersion;
  const product = region === 'global' ? 'WorkBuddy AI' : 'WorkBuddy';
  return `WorkBuddy/${clientVersion} ${product}/${clientVersion}`;
}

/**
 * 发流式请求。返回 { stream, status, raw, convId }。
 * 走账号的出站代理（proxy-agent），与其它直连通道同规则。
 */
function postStream(region, account, payload) {
  return new Promise((resolve) => {
    let agent = null;
    try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
      return resolve({ stream: null, status: 0, error: `出站代理配置错误: ${e.message}`, fatal: true });
    }
    const spec = c.specOf(region);
    const u = new URL(spec.chatBase + c.EP_CHAT);
    const { body, convId } = buildChatBody(payload, region, account);
    const headers = {
      ...chatHeaders(region, account, Buffer.byteLength(body), convId),
      'User-Agent': chatUserAgent(region),
    };
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers,
      // 长流不能设总超时，否则 SSE 会被掐断（与其它直连通道同口径）
      timeout: 600000,
      ...(agent ? { agent } : {}),
    }, (res) => resolve({ stream: res, status: res.statusCode, headers: res.headers, convId }));
    req.on('error', (e) => resolve({ stream: null, status: 0, error: e.message, convId }));
    req.on('timeout', () => { req.destroy(); resolve({ stream: null, status: 0, error: 'timeout', convId }); });
    req.write(body);
    req.end();
  });
}

/**
 * 解析标准 OpenAI SSE（data: 行 + [DONE] 哨兵）。onChunk 收每条 data 的
 * JSON 对象（[DONE] 以 null 传入）。跨 chunk 汉字用 StringDecoder。
 *
 * [DONE] 即终态（hub v1.9.1 WB_STOP_AT_SSE_DONE 的默认开版本）：上游在
 * [DONE] 后会保持连接不关，聚合路径 readStream 不 resolve 就一直白等。
 * 见哨兵即销毁连接并 resolve——usage/finish 帧按协议都在 [DONE] 之前，
 * 之后不存在还值得等的数据。DUMATE_WORKBUDDY_STOP_AT_DONE=0 可关（兜底）。
 */
async function readStream(stream, onData) {
  const { StringDecoder } = require('string_decoder');
  const dec = new StringDecoder('utf8');
  let buf = '';
  let settled = false;
  const stopAtDone = process.env.DUMATE_WORKBUDDY_STOP_AT_DONE !== '0';
  return new Promise((resolve, reject) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const flushLine = (line) => {
      const s = line.trim();
      if (!s.startsWith('data:')) return;
      const payload = s.slice(5).trim();
      if (!payload) return;
      if (payload === '[DONE]') {
        onData(null);
        if (stopAtDone) {
          try { stream.destroy(); } catch (e) { /* 已结束 */ }
          finish();
        }
        return;
      }
      try { onData(JSON.parse(payload)); } catch (e) { /* 非 JSON 行跳过 */ }
    };
    stream.on('data', (chunk) => {
      if (settled) return;
      buf += dec.write(chunk);
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        flushLine(line);
        if (settled) return;
      }
    });
    stream.on('end', () => {
      buf += dec.end();
      if (buf.trim()) flushLine(buf);
      finish();
    });
    stream.on('error', (e) => { if (!settled) reject(e); });
  });
}

/** 聚合整轮结果（非流式路径）：标准 OpenAI chunk 流 → 一个 chat.completion */
function aggregate(chunks, model, opts = {}) {
  let content = '';
  let reasoning = '';
  let finish = 'stop';
  let usage = null;
  let err = null;
  const calls = new Map();
  for (const ch of chunks) {
    if (!ch || typeof ch !== 'object') continue;
    if (ch.error) { err = ch.error; continue; }
    const choice = (ch.choices || [])[0] || {};
    const d = choice.delta || {};
    if (d.content) content += d.content;
    if (d.reasoning_content) reasoning += d.reasoning_content;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const i = tc.index != null ? tc.index : calls.size;
        const cur = calls.get(i) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) cur.id = tc.id;
        if (tc.function && tc.function.name) cur.function.name = tc.function.name;
        if (tc.function && tc.function.arguments) cur.function.arguments += tc.function.arguments;
        calls.set(i, cur);
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
    if (ch.usage) usage = ch.usage;
  }
  // DSML fail-closed 兜底（共享实现 repair.aggregateDsmlFallback；WorkBuddy 的
  // 国际目录同样跑 DeepSeek 系，一样可能把工具调用写进正文）。
  // recovered 时把 stop 纠正成 tool_calls（模型没走原生调用，上游必然报 stop）。
  // 其后是 tool echo 兜底（hub#135）：纯 JSON 载荷形状，与 DSML 互补。
  const repair = require('../repair');
  const dsml = repair.aggregateDsmlFallback('workbuddy', content, calls);
  content = dsml.content;
  if (dsml.recovered && finish === 'stop') finish = 'tool_calls';
  const echo = repair.aggregateToolEchoFallback('workbuddy', content, calls, opts.toolNames, opts.echoMode);
  content = echo.content;
  if (echo.recovered && finish === 'stop') finish = 'tool_calls';
  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.size) {
    message.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    if (!content) message.content = null;
  }
  const out = {
    id: `workbuddy-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: usage || {},
  };
  if (err) {
    const e = new Error(`workbuddy: ${err.message || JSON.stringify(err)}`);
    e.statusCode = Number(err.code) || 502;
    throw e;
  }
  return out;
}

module.exports = {
  stableConversationId, promptCacheKey, hasFunctionTools, buildChatBody, chatHeaders, chatUserAgent,
  postStream, readStream, aggregate,
};
