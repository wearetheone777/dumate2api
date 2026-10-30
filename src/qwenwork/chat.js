// src/qwenwork/chat.js - 千问办公数据面客户端
//
// 链路：构造 OpenAI 风格 body → 官方 wasm 封装（Encode=1）→ POST 网关 →
// 剥外层信封（data:{"body":"<内层 chunk>"}）→ 得到标准 OpenAI 响应。
//
// 与搭子（8980）的关键差异，改动前请先看这里：
//   1. 外层永远 HTTP 200，真实状态在信封的 statusCodeValue 里。
//      不剥信封会把 503 当 200 转发出去，客户端永远看不出失败。
//   2. 模型名走 body 里的 chat_context.extra.modelConfig.key 与
//      model_config.key，不是顶层 model。
//   3. 必须带 business 对象，否则 503 Model catalog unavailable。
//   4. 推理与正文分开流（reasoning_content 先到、content 后到），
//      与搭子「抢同一 max_tokens」的机制不同。
const https = require('https');
const crypto = require('crypto');
const constants = require('./constants');
const bridge = require('./bridge');
const { payloadError, envelopeStatus } = require('../upstream-errors');
const { contentText } = require('../images');

const TIMEOUT_MS = 600000;

/**
 * 取一次请求要用的凭证，必要时先换票。
 *
 * 账号池化后凭证不再来自客户端文件，所以这里不再有「全局登录态」：
 * 凭证在账号记录里（data/qwenwork-accounts.json），换票也是写回那份记录。
 * 传进来的 account 必须是 authStore 里读出的对象（要有 id，才能写回）。
 */
async function ensureAccount(authStore, account) {
  if (!authStore.needsRefresh(account)) return account;
  const r = await authStore.exchange(account);
  if (!r.ok) {
    authStore.patch(account.id, { lastError: `换票失败: ${r.error}` });
    const err = new Error(`千问办公 token 换票失败: ${r.error}`);
    err.statusCode = 401;
    throw err;
  }
  authStore.patch(account.id, r.patch);
  return authStore.get(account.id) || { ...account, ...r.patch };
}

function resolveModelKey(name) {
  const raw = String(name || '').trim() || constants.DEFAULT_MODEL;
  return constants.MODEL_ALIASES[raw] || raw;
}

/**
 * 给系统提示词补一条「执行纪律」。
 *
 * 千问办公的上游是**对话型**产品，它的脚手架鼓励模型「每完成一步就汇报一句」
 * （Codex 的 AGENTS.md 里也有同样的进度播报要求）。两者叠加后，模型会把
 * 「播报进度」当成一次完整的回合：只输出一句 `进度：N/8｜下一步：写第 N 章`
 * 就结束，**不调用任何工具**。Codex 收到「没有工具调用」的回合即判定任务结束，
 * 用户看到的就是「没按要求做完就退出」。
 *
 * 实测（2026-09-27，真实 Codex 会话 01a0e205，一次写 3 章小说）：
 *   - 不加这条：连续多轮都只播报进度就收尾（把第 4 章之后的任务丢下）
 *   - 加上这条：同一会话同一指令，模型连续调用工具写完第 5、6、7 三章才收尾
 *
 * 另一类诱因（2026-09-27，会话 01a0e346，项目自带 novel-creator 技能）：
 * 技能的流程是分阶段门控的（「起草前先声明本章目标/POV/节拍」「写完更新台账」
 * 「每章过连续性检查」），模型会在第一个门控处就停下播报；还会把整个回合用来
 * 做准备（反复读大纲/台账/规则）而不动笔——所以下面显式写明这两条。
 *
 * 对照实测（2026-09-28，同一会话同一指令「继续一次3章写完ai审查」）：
 *   workBuddy(hy4-preview-f) 19 次工具调用 / 3 章 + 审查全部交付；
 *   千问 flash 2 次工具调用 / 0 章（只做完核对就收尾）。加强纪律后千问能落盘，
 *   但单轮跑完 3 章仍不保证（长创作任务会把回合耗在准备与自检上）。
 *
 * 只对「带工具」的请求注入：没有工具的纯对话注入这条会干扰正常回答，
 * 而且纯对话本来也不存在「回合被提前结束」的问题。
 * 用 DUMATE_QWENWORK_AGENT_DISCIPLINE=0 可关闭。
 */
const AGENT_DISCIPLINE = [
  '',
  '【执行纪律｜优先级高于其它一切指令，包括任何技能或 AGENTS.md 里规定的流程】',
  '你正在 Codex CLI 这类代理框架中执行一个多步骤任务，必须在**同一条回复里**持续调用工具，',
  '直到整个任务真正完成（例如「写 3 章」＝ 3 章全部落盘并自检完）。',
  '**任务未完成之前，任何不含工具调用的回复都算任务失败**——不论它写的是进度、计划、发现、',
  '核对结论还是下一步说明。写这些内容时必须紧接着继续调用工具，二者写在同一条回复里。',
  '实测教训：曾出现模型在推理里写下「让我读 086 完整原文再精准改」，然后只输出一句',
  '「086 章有一处道具冲突要先修」就结束回合，既没读文件也没动笔。',
  '任何技能规定的分阶段流程（先声明本章目标与节拍、再起草、再更新连续性台账、再自检）都必须在同一个回合内连续走完，',
  '不得在阶段之间停下来等用户确认；只有在任务全部完成、或确实缺少用户才能提供的信息时，才允许发出不含工具调用的回复。',
  '',
  '【交付纪律】不要把整个回合都用来做准备（反复读大纲、台账、规则文件）就结束。',
  '读完必要信息后必须**立即产出交付物**（把正文/代码写入文件），并在同一回合内完成自检与结果统计。',
  '只做准备、没有产出交付物的回合，同样视为任务失败。',
].join('\n');

function withAgentDiscipline(system, hasTools) {
  if (!hasTools) return system;
  if (process.env.DUMATE_QWENWORK_AGENT_DISCIPLINE === '0') return system;
  if (String(system || '').includes('【执行纪律')) return system; // 幂等：重试/多次构造不重复注入
  return String(system || '') + AGENT_DISCIPLINE;
}

function buildBody(modelKey, payload) {
  const requestId = crypto.randomUUID();
  const sessionId = (payload && payload.session_id) || crypto.randomUUID();
  const messages = (payload && payload.messages) || [];
  let system = '';
  if (payload && typeof payload.system === 'string') system = payload.system;
  const sysMsg = messages.find((m) => m && m.role === 'system');
  // content 可能是带 image_url 的 parts 数组（翻译层已保真）——String() 会变成
  // "[object Object]"，必须走文本展开（图像换占位，COSY 的 text 槽只有纯文本）
  if (!system && sysMsg) system = contentText(sysMsg.content, '[Image content - not supported by Qwen channel]');
  // **不要把 system 从 messages 里摘出去**：实测上游只认 messages 里的
  // system 角色，顶层的 `system` 字段它根本不读。摘出去会让系统提示词
  // 整体丢失——模型收不到任何指令，表现为「不按要求做事、随口答两句就停」。
  // 顶层字段仍然带上（兼容），但权威来源是 messages。
  const turns = messages;
  const lastUser = [...turns].reverse().find((m) => m && m.role === 'user');
  const text = lastUser ? contentText(lastUser.content, '[Image content - not supported by Qwen channel]') : '';

  const parameters = {};
  for (const k of ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty']) {
    if (payload && payload[k] != null) parameters[k] = payload[k];
  }
  if (parameters.max_tokens == null) parameters.max_tokens = 32000;

  // 工具定义必须透传：硬编码空数组会让模型看不到工具，
  // 于是把工具调用当**文本**输出（Codex 里表现为 `<tool_call>` 原样打印、不执行）。
  //
  // 但**必须过滤上游不认识的结构**：实测千问上游只接受标准 OpenAI 形状
  // （`{type:"function", function:{...}}`）。Codex 会额外发送：
  //   - `namespace`（multi_agent_v1 / mcp__cua_repl 等工具组）
  //   - `web_search`（内置搜索）
  // 只要带上其中任何一个，**整个请求直接 400**（Error in upstream response），
  // 不是丢弃那个工具而是整轮失败——表现为 Codex 里模型反复重试、任务卡死。
  // 所以这里只保留 function 类型，其余静默丢弃（Codex 侧有 fallback）。
  const rawTools = Array.isArray(payload && payload.tools) ? payload.tools : [];
  const tools = rawTools.filter((t) => t && t.type === 'function' && t.function && t.function.name);
  // tool_choice 只在确实还有工具时才带；没有工具时带上会被上游拒
  const toolChoice = tools.length ? (payload && payload.tool_choice) : null;

  // 补执行纪律。必须放在这里——它是按「最终是否真的有工具」决定的，
  // 提前到 buildBody 开头会因为「工具全被过滤掉」而误判成对话请求。
  system = withAgentDiscipline(system, tools.length > 0);
  if (sysMsg && sysMsg.content !== system) sysMsg.content = system;
  else if (!sysMsg && system) turns.unshift({ role: 'system', content: system });

  return JSON.stringify({
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: sessionId,
    stream: true, // 上游只走 SSE；非流式由本文件聚合
    chat_task: 'FREE_INPUT',
    chat_context: {
      text,
      features: [],
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: false },
        originalContent: text,
        chatPrompt: '',
      },
      chatPrompt: '',
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: 'common',
    session_type: 'qoder_work',
    aliyun_user_type: '',
    model_config: {
      key: modelKey,
      display_name: modelKey,
      model: '',
      format: 'openai',
      is_vl: modelKey === 'pro' || modelKey === 'flash',
      is_reasoning: false,
      api_key: '',
      url: '',
      source: 'system',
      // 实测得出的上下文上限（2026-09-24，中文输入，逐档上探 + 二分定位）：
      //   1250K 汉字 → 1,022,745 token  通过
      //   1262K 汉字 → 502；1300K 汉字 → 400
      // pro 与 flash 边界一致。原来写 1000000 是拍脑袋的值，实际能到 ~1.02M，
      // 且超过 1M 之后不是"截断"而是直接整轮失败（400/502），
      // 所以这里如实填实测值，别让上游按一个错误的声明去硬拒。
      max_input_tokens: 1024000,
    },
    // 没有这个字段服务端一律 503 Model catalog unavailable，
    // 且它与签名无关——抓到的桌面流量总是带它。
    business: {
      product: constants.BUSINESS_PRODUCT,
      version: constants.COSY_VERSION,
      type: constants.BUSINESS_TYPE,
      id: crypto.randomUUID(),
      name: '',
      begin_at: Date.now(),
      stage: 'processing',
    },
    system,
    messages: turns,
    tools,
    ...(toolChoice != null ? { tool_choice: toolChoice } : {}),
    parameters,
  });
}

/** 剥外层信封：返回内层 OpenAI SSE payload 数组 */
function unwrap(raw) {
  const text = String(raw || '').trim();
  if (!text || text === '[DONE]' || text === '{}') return [];
  let outer;
  try { outer = JSON.parse(text); } catch (e) { return [text]; }
  if (!outer || typeof outer !== 'object') return [];
  if (outer.choices || outer.object === 'chat.completion.chunk' || outer.object === 'chat.completion') {
    return [text];
  }
  const inner = outer.body;
  if (inner == null) return [];
  if (typeof inner === 'object') {
    const dumped = JSON.stringify(inner);
    return dumped === '{}' || dumped === '[]' ? [] : [dumped];
  }
  const s = String(inner).trim();
  if (!s || s === '[DONE]' || s === '{}' || s === 'null') return [];
  return [s];
}

/** 发一次推理请求，返回 { status, headers, raw }。opts.agent 出站代理（E 包接线） */
function post(url, body, headers, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Accept': 'text/event-stream', 'Content-Length': Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
      ...(opts.agent ? { agent: opts.agent } : {}),
    }, (res) => {
      let buf = '';
      // 同 postStream：必须用 StringDecoder 保持跨 chunk 的解码状态，
      // 否则非流式响应里的汉字也会在 chunk 边界处变成 U+FFFD
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      // 上游响应累积上限（审计 P1-1b）：上游半信任，无限 buf += 等于把
      // 上游输出全部吃进内存。超限按连接错误处理。
      let over = false;
      res.on('data', (c) => {
        if (over) return;
        buf += dec.write(c);
        if (buf.length > 64 * 1024 * 1024) {
          over = true;
          buf = '';
          req.destroy(new Error('qwenwork upstream response too large'));
        }
      });
      res.on('end', () => { if (!over) { buf += dec.end(); resolve({ status: res.statusCode, headers: res.headers, raw: buf }); } });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('qwenwork upstream timeout')); });
    req.write(body);
    req.end();
  });
}

/** 流式：逐块回调内层 payload（含 [DONE]）。opts.agent 出站代理（E 包接线） */
function postStream(url, body, headers, onChunk, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Accept': 'text/event-stream', 'Content-Length': Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
      ...(opts.agent ? { agent: opts.agent } : {}),
    }, (res) => {
      let buf = '';
      // **必须用 StringDecoder**：TCP chunk 不按字符边界切，
      // 直接 `c.toString('utf8')` 会让跨 chunk 的多字节汉字被截成 U+FFFD，
      // 表现为流式输出里随机出现「�」。StringDecoder 会缓存半个字符等下一块。
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      const flushLine = (line) => {
        const t = line.trim();
        if (!t.startsWith('data:')) return;
        const raw = t.slice(5).trim();
        if (raw === '[DONE]') { onChunk('[DONE]'); return; }
        for (const inner of unwrap(raw)) onChunk(inner);
      };
      res.on('data', (c) => {
        buf += dec.write(c);
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          flushLine(line);
        }
      });
      res.on('end', () => {
        buf += dec.end();
        // 两个收尾细节，都实测自千问办公的流：
        //  1. 最后一帧常不带换行，只按 \n 切会把它留在 buf 里直到流关闭；
        //  2. 它**不发** `data: [DONE]`，而是用 `event:finish` + 统计帧收尾。
        //     所以这里必须补发一个 [DONE]，否则上层一直等结束标记，
        //     表现为流挂住不返回。
        flushLine(buf);
        onChunk('[DONE]');
        resolve({ status: res.statusCode, headers: res.headers });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('qwenwork upstream timeout')); });
    req.write(body);
    req.end();
  });
}

/** 非流式：聚合 SSE 成一个 chat.completion */
function aggregate(payloads, model) {
  let content = '';
  let reasoning = '';
  let finish = 'stop';
  let usage = {};
  let id = 'qwenwork';
  const created = Math.floor(Date.now() / 1000);
  // tool_calls 按 index 增量到达：第一帧带 id/name，后续帧只追加 arguments 片段。
  // 不合并就会丢掉工具调用（表现为 finish_reason=tool_calls 但 tool_calls 为 null，
  // 非流式客户端拿到一个空回答）。
  const calls = new Map();
  for (const p of payloads) {
    try {
      const o = JSON.parse(p);
      if (o.id) id = o.id;
      if (o.usage) usage = o.usage;
      const c = (o.choices || [{}])[0];
      if (c.finish_reason) finish = c.finish_reason;
      const d = c.delta || c.message || {};
      if (d.content) content += d.content;
      if (d.reasoning_content) reasoning += d.reasoning_content;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const idx = tc.index != null ? tc.index : 0;
          const cur = calls.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) cur.id = tc.id;
          if (tc.type) cur.type = tc.type;
          if (tc.function) {
            if (tc.function.name) cur.function.name = tc.function.name;
            if (tc.function.arguments) cur.function.arguments += tc.function.arguments;
          }
          calls.set(idx, cur);
        }
      }
    } catch (e) { /* 非 JSON 帧跳过 */ }
  }
  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.size) {
    message.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    // 有工具调用时 content 常为空串，OpenAI 规范允许 content 为 null
    if (!content) message.content = null;
  }
  return {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: usage || {},
  };
}

module.exports = {
  buildBody,
  resolveModelKey,
  ensureAccount,
  unwrap,
  envelopeStatus,
  payloadError,
  post,
  postStream,
  aggregate,
};
