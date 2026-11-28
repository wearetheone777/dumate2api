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
//   7. 出站头/正文对齐官方客户端（2026-11-28 融合批 P0-1/P0-2，A/B 实测 200）：
//      头集见 chatHeaders；body 补 cache_retention / extra_vars / reasoning_summary
//      （test/probe-workbuddy-ab.js 变体 C 实证全部被上游接受）
//   8. 出站前工具配对修复 + DeepSeek 思考注入（toolpairing.js / thinking.js）
//
// **红线：chat 请求绝不携带 refresh token**（X-Refresh-Token 仅出现在刷新端点）。
const https = require('https');
const crypto = require('crypto');
const c = require('./constants');
const sanitize = require('./sanitize');
const toolpairing = require('./toolpairing');
const thinking = require('./thinking');
const failover = require('./failover');

// 出站注入点（测试打桩用）：默认真实 https.request（growth/tasks 同款）
let requestImpl = https.request;
/** @private 测试专用 */
function _setRequestImpl(f) { requestImpl = f || https.request; }

// P1-1 system 后置用的头部短桩：**永不变化**是它的全部价值——前缀缓存第一段
// 每个会话都一样，命中缓存的是桩之后真实消息的公共前缀。改文案 = 全量缓存失效。
const SYSTEM_TAIL_STUB = '你是助手。';

/** uuidv7 形状的 32-hex（时间有序前缀）：官方每请求 id（request/message/trace）
 * 都是 uuidv7 去连字符形态（Zhengyuuuui 抓包口径）。 */
function uuidv7hex(now = Date.now()) {
  const buf = crypto.randomBytes(16);
  const t = Math.floor(now);
  buf[0] = Math.floor(t / 2 ** 40) & 0xff;
  buf[1] = Math.floor(t / 2 ** 32) & 0xff;
  buf[2] = Math.floor(t / 2 ** 24) & 0xff;
  buf[3] = Math.floor(t / 2 ** 16) & 0xff;
  buf[4] = Math.floor(t / 2 ** 8) & 0xff;
  buf[5] = t & 0xff;
  buf[6] = 0x70 | (buf[6] & 0x0f); // version 7
  buf[8] = 0x80 | (buf[8] & 0x3f); // variant 10xx
  return buf.toString('hex');
}

/** 32-hex 种子 → uuidv7 形状（8-4-4-4-12 带连字符，钉 version 7 与 variant 位）。
 * 种子派生保证「形状像 uuidv7、值跨轮稳定」——上游不校验值的时序性
 * （dsh-xdpool#58：只查存在），稳定性交给种子而不是真实时钟。 */
function uuidFromSeed(seedHex) {
  const s = String(seedHex || '').replace(/[^0-9a-f]/gi, '').toLowerCase()
    .padEnd(32, '0').slice(0, 32);
  const variant = (0x8 | (parseInt(s[16], 16) & 0x3)).toString(16);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-7${s.slice(13, 16)}-${variant}${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

function uuidv7Uuid(now = Date.now()) {
  return uuidFromSeed(uuidv7hex(now));
}

/**
 * 稳定会话 id：从首条 user 内容指纹派生（同会话跨轮稳定，无锚回落真实 uuidv7）。
 * 官方 X-Conversation-ID 是标准 uuid 含连字符——从 24-hex 裸 hex 升级为 uuidv7
 * 形状（P0-1，probe-workbuddy-ab 变体 C 实测 200）。值变化只让前缀缓存键
 * 错位一次，之后照旧稳定。
 */
function stableConversationId(messages) {
  const first = Array.isArray(messages)
    ? messages.find((m) => m && m.role === 'user') : null;
  const text = first ? JSON.stringify(first.content ?? first) : '';
  if (!text) {
    return uuidv7Uuid();
  }
  const seed = crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
  return uuidFromSeed(seed);
}

/** 32-hex 种子 → uuidv7 **形状**的 32-hex（去连字符，钉 version/variant 位）。
 * 头部族（X-Trace-ID / traceparent / b3）用的就是 32-hex 裸形态。 */
function seedTraceHex(seedHex) {
  const s = String(seedHex || '').replace(/[^0-9a-f]/gi, '').toLowerCase()
    .padEnd(32, '0').slice(0, 32);
  return s.slice(0, 12) + '7' + s.slice(13, 16) + '8' + s.slice(17, 32);
}

/**
 * 会话级 TraceId（P2「b3 链路随会话延续」）：同一会话的多轮请求共用一个
 * TraceId、每请求换 SpanId——上游链路视图里一个会话是一条 trace，轮次是它的
 * span。锚与 stableConversationId 同源（首条 user 指纹派生）——种子派生天然
 * 「同会话稳定、跨会话不同」，无 LRU、无状态、无淘汰失忆。
 */
function sessionTraceId(messages) {
  const first = Array.isArray(messages)
    ? messages.find((m) => m && m.role === 'user') : null;
  const text = first ? JSON.stringify(first.content ?? first) : '';
  if (!text) {
    return uuidv7hex(); // 无锚回落真实 uuidv7（与 stableConversationId 同口径）
  }
  return seedTraceHex(crypto.createHash('sha256').update(`${text}|trace`).digest('hex'));
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

// —— 11151 空 text 段补位（P2，misakano empty_text_part.go 口径，2026-11-28）——
//
// 上游对每个 text 段做**零长度**校验：text 为空串 / null / 缺失 → 整条消息
// 400 / 11151「a message has empty content」。这条**不可自愈**：重试重放同一段
// 历史，换号换模型之外没有出路，多号池只会把同一个坏请求在上游撞满一轮。
//
// 实测形状（kimi-k3.1-pro + cn 号池逐形态对照）：
//   [{"type":"text","text":""}]      → 400/11151
//   [{"type":"text","text":null}]    → 400/11151
//   [{"type":"text"}]                → 400/11151
//   [{"type":"text","text":"   "}]   → 200（只判零长度，不 trim）
//   [{"type":"textarea","text":""}]  → 200（未知 type 被忽略）
//   {"type":"text","text":""}（对象）→ 200（不嗅探对象形态）
//
// 字符串 content 只要跳过空白后以 `[` 开头，上游就当 parts 数组解析——工具结果
// 里的表单/按钮抓取恰好是这个形状，一段「数据」会被嗅探成空文本段。修法
// **只补值不删段**（删段会改段落数量与下标，补一个空格对模型无语义影响）；
// 字符串形态必须在**字节层面**补：整体 JSON 往返会丢大整数精度、改转义、重排
// 键序，工具输出就不再是客户端发来的那份。不能用「加前缀空格」规避嗅探——
// 上游会先跳过空白再解析。

const EMPTY_TEXT_FILL = ' ';
const EMPTY_TEXT_FILL_JSON = JSON.stringify(EMPTY_TEXT_FILL); // '" "'
// 字节级扫描器共用 jsonscan.js（sanitize.js 的工具参数清洗也用它）
const { scanJsonValue: _scanJson, rawSpans: _rawSpans } = require('./jsonscan');

/** 单个段对象原文是否为「上游会判空的 text 段」，是则给出补位编辑（区间相对
 * objRaw）。重复键按最后一次出现（与解析成 map 的口径一致）；type 非精确
 * 'text' 不补（textarea 等未知 type 上游不校验，归一反而会拉进校验面）；
 * text 值只认原文 null 与 ""（转义形态宁可不补）。缺失时紧跟 `{` 插入。 */
function emptyTextSpanOf(objRaw) {
  const f = _rawSpans(objRaw, '{');
  if (!f) return null;
  let typ = null; let txt = null;
  for (const sp of f.spans) {
    if (sp.key === 'type') typ = sp;
    else if (sp.key === 'text') txt = sp;
  }
  if (!typ) return null;
  let t;
  try { t = JSON.parse(objRaw.slice(typ.start, typ.end)); } catch (e) { return null; }
  if (t !== 'text') return null;
  if (!txt) {
    // 对象至少有 type 键，后面补逗号合法
    return { start: 1, end: 1, repl: `"text":${EMPTY_TEXT_FILL_JSON},` };
  }
  const v = objRaw.slice(txt.start, txt.end);
  if (v !== 'null' && v !== '""') return null;
  return { start: txt.start, end: txt.end, repl: EMPTY_TEXT_FILL_JSON };
}

/** 对「会被上游当 parts 嗅探」的字符串补位；返回新串或 null（不动）。
 * 只在字节层面改空段的 text 值，其余字节一律不动。每段切片先用
 * 「再解析并与整体解析出的元素 stringify 相等」自证——宁可不补，也不写坏
 * 客户端的工具输出。 */
function fillSniffedEmptyText(content) {
  const lead = (/^[ \t\r\n]*/.exec(content) || [''])[0].length;
  const stripped = content.slice(lead);
  if (!stripped.startsWith('[')) return null;
  let parsed;
  try { parsed = JSON.parse(stripped); } catch (e) { return null; }
  // 空数组或含非对象元素：上游不把它当 parts
  if (!Array.isArray(parsed) || parsed.length === 0
    || !parsed.every((e) => e && typeof e === 'object' && !Array.isArray(e))) return null;
  const arr = _rawSpans(stripped, '[');
  if (!arr || arr.spans.length !== parsed.length) return null;
  const spans = [];
  for (let i = 0; i < arr.spans.length; i++) {
    const raw = stripped.slice(arr.spans[i].start, arr.spans[i].end);
    if (raw[0] !== '{') return null;
    let again;
    try { again = JSON.stringify(JSON.parse(raw)) === JSON.stringify(parsed[i]); } catch (e) { return null; }
    if (!again) return null;
    const sp = emptyTextSpanOf(raw);
    if (sp) {
      spans.push({
        start: sp.start + arr.spans[i].start,
        end: sp.end + arr.spans[i].start,
        repl: sp.repl,
      });
    }
  }
  if (!spans.length) return null;
  let b = content.slice(0, lead);
  let prev = 0;
  for (const sp of spans) {
    b += stripped.slice(prev, sp.start) + sp.repl;
    prev = sp.end;
  }
  b += stripped.slice(prev);
  return b;
}

/**
 * 把 messages 里所有空 text 段就地补位（11151 前置防线）。普通请求零改动：
 * 无空段时既不换数组也不换字符串，出站字节与原来一字不差。
 */
function guardEmptyTextParts(messages) {
  if (!Array.isArray(messages)) return;
  for (const m of messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
    if (!('content' in m)) continue;
    const content = m.content;
    if (Array.isArray(content)) {
      let copied = false;
      const parts = content.map((p) => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
        if (p.type !== 'text') return p;
        // 零长度判定：缺失/null/'' 都算；'   ' 实测放行，动了反而改报文
        const v = p.text;
        if (v !== undefined && v !== null && v !== '') return p;
        copied = true;
        return { ...p, text: EMPTY_TEXT_FILL };
      });
      if (copied) m.content = parts;
    } else if (typeof content === 'string') {
      const filled = fillSniffedEmptyText(content);
      if (filled != null) m.content = filled;
    }
  }
}

/**
 * 请求体规范化 + 会话注入。
 * @param {object} payload OpenAI 请求体
 * @param {string} region 'cn' | 'global'
 * @param {object} account 账号（uid 用于缓存键）
 * @returns {{ body: string, convId: string, traceId: string }} 出站 JSON 串、会话 id（三头与 body 同源）与会话级 TraceId（32-hex）
 */
function buildChatBody(payload, region, account, opts = {}) {
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
  // 顶层 tools[] 也要清（2026-11-08）：原来只清 messages，工具定义里的品牌指纹
  // 与提示词痕迹一样会被渠道校验看到。**只清 description，不动 name/schema 结构**
  // （改名会让 tool_call 回传对不上，改 schema 会让参数生成失效）。
  if (Array.isArray(body.tools)) body.tools = sanitize.sanitizeTools(body.tools);

  // 批次五：CN Kimi 不接受 parameters 里的 $ref/#/$defs（实测 400 11129）——
  // 出站前内联展开（sanitize.kimiInlineTools）。按 model 前缀门控：非 kimi
  // 零解析零改动；global 不启用（参考 realm 门控同口径）。'cn:' 前缀剥掉再判
  if (Array.isArray(body.tools) && region === 'cn'
    && /^kimi/i.test(String(body.model || '').replace(/^cn:/, ''))) {
    body.tools = sanitize.kimiInlineTools(body.tools);
  }

  // P1-1：system 后置救前缀缓存（默认关，runtime.systemTail.enabled，仅 cn）。
  // 长系统提示词占住前缀缓存的头部，每个新会话都要整段重算；把**开头连续**的
  // system 块挪到消息末尾、头部放恒定短桩后，缓存前缀变成一行固定文本，
  // 跨会话稳定（桩永不变化，真正的系统提示词随消息体走）。只动**开头连续**的
  // system 块：中段/尾部的 system 不碰（语义与工具配对不受影响）；
  // 首条必须是 system 的上游硬校验由短桩满足。global 区域不启用（激进优化
  // 不外溢到没有同款前缀缓存压力的端点）。
  if (Array.isArray(body.messages) && region === 'cn') {
    const tailCfg = require('./runtime').Load().systemTail;
    if (tailCfg && tailCfg.enabled) {
      let headRun = 0;
      while (headRun < body.messages.length && body.messages[headRun] && body.messages[headRun].role === 'system') headRun++;
      // headRun === messages.length（整条都是 system）不动：没有可救的前缀，
      // 乱挪只会改变没有缓存的请求
      if (headRun > 0 && body.messages.length > headRun) {
        const moved = body.messages.slice(0, headRun);
        body.messages = [{ role: 'system', content: SYSTEM_TAIL_STUB }, ...body.messages.slice(headRun), ...moved];
      }
    }
  }

  // P0-3：出站前工具配对修复（toolpairing.js 四步管线）。修复不改 user 内容，
  // convId（取首条 user）不受影响，前缀缓存键稳定
  if (Array.isArray(body.messages)) {
    body.messages = toolpairing.repairToolPairing(body.messages).messages;
  }

  // P2：11151 空 text 段补位（misakano empty_text_part.go 形状表）。必须在
  // convId/traceId 派生**之前**——锚取首条 user 的出站内容，补位幂等，第二轮
  // 起稳定；放在派生之后的话「带空段的会话」第一轮与后续轮的锚不一致
  if (Array.isArray(body.messages)) guardEmptyTextParts(body.messages);

  // 会话 id：跨轮稳定（前缀缓存不被打散），三头与 body 同源
  const convId = stableConversationId(body.messages);
  // TraceId：随会话延续（b3 链路视图里一个会话一条 trace），span 每请求新值
  const traceId = sessionTraceId(body.messages);
  body.conversation_id = convId;
  if (account && account.uid) {
    body.prompt_cache_key = promptCacheKey(account.uid, convId);
  }

  // P0-2：官方 body 字段（probe-workbuddy-ab 变体 C 实测 200）。只补缺省，
  // 客户端显式给过的值一律不覆盖
  if (body.cache_retention === undefined) body.cache_retention = 'long';
  if (body.reasoning_summary === undefined) body.reasoning_summary = 'auto';
  const ev = (body.extra_vars && typeof body.extra_vars === 'object' && !Array.isArray(body.extra_vars))
    ? body.extra_vars
    : (body.extra_vars = {});
  if (ev.harnessMetadata === undefined) {
    // 官方是 JSON **字符串**形态（misakano conv_fields.go / 抓包一致）
    ev.harnessMetadata = JSON.stringify({
      schemaVersion: 1,
      harnessVersion: c.CHAT_CLI_VERSION,
      stepIndex: 0,
      agent: { depth: 0 },
    });
  }
  const lastMsg = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : null;
  if (ev.initiator === undefined && lastMsg && lastMsg.role === 'user') ev.initiator = 'user';

  // P0-4：DeepSeek 思考注入 + reasoning_content 回填（thinking.js，misakano
  // 语义）。wb_no_thinking 是**私有逃生口标记**（11150 降级路径自动带；客户端
  // 也可显式传 true 关掉本轮注入），消费后删除、绝不外发
  const skipThinking = body.wb_no_thinking === true;
  delete body.wb_no_thinking;
  if (!skipThinking) {
    let cat = null;
    try { cat = require('./models').reasoningOf(region, body.model); } catch (e) { cat = null; }
    let cfg = null;
    try { cfg = require('./runtime').Load().thinking; } catch (e) { cfg = null; }
    if (!cfg || cfg.enabled !== false) {
      thinking.injectThinking(body, {
        efforts: cat && Array.isArray(cat.efforts) ? cat.efforts : [],
        // 档位来源优先级：面板配置 > 目录声明 > thinking.js 硬兜底 high
        defaultEffort: (cfg && cfg.defaultEffort) || (cat && cat.defaultEffort) || '',
      });
    }
  }
  thinking.backfillReasoningContent(body);

  // 批次十：会话轮级字段（misakano conv_fields.go，两版真机抓包同构）。官方把
  // 「这一轮属于哪个 request-id」同时写在**头**（X-Conversation-Request-ID）和
  // **体**（最后一条 user 的 conversationRequestId）里——网关之前只写头，
  // 头体不一致本身就是可判别指纹。注入点必须在 thinking 之后（字段不该被
  // 后续处理触碰）。
  //
  // 边界（不伪造，conv_fields.go 原文口径）：
  //   - 只给「当前轮」的最后一条 user 消息写；历史消息的轮级 ID OpenAI 协议
  //     无此字段，无从得知，**不编造**（对不上的 ID 比缺失更容易被抓）；
  //   - assistant 的 messageId/usage/model 由真实调用产出，历史部分同样不补；
  //   - 客户端已自带 conversationRequestId → 原值优先不覆盖；
  //   - opts.convReqId 为空（独立调用方没走 postStream）→ 整个跳过，不写空值。
  if (opts.convReqId && Array.isArray(body.messages) && body.messages.length) {
    let idx = -1;
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i];
      if (m && typeof m === 'object' && String(m.role || '').toLowerCase() === 'user') { idx = i; break; }
    }
    if (idx >= 0) {
      const cur = body.messages[idx];
      if (!String(cur.conversationRequestId || '').trim()) cur.conversationRequestId = opts.convReqId;
      if (cur.startsNewUserRequest === undefined) cur.startsNewUserRequest = true;
      if (!String(cur.agent || '').trim()) cur.agent = 'cli';
    }
  }

  return { body: JSON.stringify(body), convId, traceId };
}

/**
 * 剥掉 reasoning 相关字段（降级一次用）。
 *
 * 出处（2026-11-08 融合批，GitHub 生态调研）：上游 11150
 * `reasoning effort is not supported` —— 模型存在、账号健康，只是**这个模型
 * 不吃 effort 参数**。原实现把这个 body 原样透传，撞上 11150 后被判成请求级
 * 失败，用户拿到 400；而**把字段剥掉重发一次就能过**。
 *
 * 四种写法都要剥（不同客户端/翻译层给的不同）：
 *   reasoning_effort（OpenAI 风格顶层）
 *   reasoning: { effort } （嵌套形态）
 *   thinking / enable_thinking （部分 SDK）
 *   reasoning_summary（P0-2 起注入的官方字段，同样是上游的思考信号）
 *
 * 重发时会带 wb_no_thinking:true 私有标记——否则 buildChatBody 的思考注入
 * （P0-4）会把剥掉的字段原样补回来，降级重发等于没降。该标记在下一轮
 * buildChatBody 被消费并删除，不会外发。
 *
 * @returns {{body:string, removed:string[]}|null} null = 本来就没有，无需降级
 */
function withoutReasoningFields(payload) {
  let obj = payload;
  if (typeof payload === 'string') {
    try { obj = JSON.parse(payload); } catch (e) { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const body = JSON.parse(JSON.stringify(obj));
  const removed = [];
  for (const k of ['reasoning_effort', 'reasoning', 'thinking', 'enable_thinking', 'reasoning_summary']) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      delete body[k];
      removed.push(k);
    }
  }
  if (!removed.length) return null;
  body.wb_no_thinking = true;
  return { body: JSON.stringify(body), removed };
}

/**
 * 按账号**稳定派生**的设备/会话标识（2026-11-08 融合批）。
 *
 * 出处：GitHub 生态调研（ardeyoxipianyi/workbuddy2api-hub 的
 * `X-Machine-ID` / `X-Session-ID` 派生；多份实现交叉实证）。
 *
 * **为什么必须按账号派生，不能用进程级常量**：
 * 这两个头是上游的设备关联键。若整个网关共用一个值，**整个账号池会被上游
 * 关联成同一台设备**——一个账号触发 11140，其余账号跟着连坐。这与「出口 IP
 * 连坐」是同一个机制，而它比 IP 更难换（IP 有代理槽，设备指纹没有）。
 *
 * 派生口径（与参照实现一致）：
 *   md5("<salt>:<uid>") 取前 32 hex，再改造成 UUIDv4 形状（第 13 位 4、
 *   第 17 位 8/9/a/b）。为什么改形状而不直接用 md5：上游按 UUID 校验格式，
 *   32 位裸 hex 会被当成非法值；用 md5 而非 randomUUID 是为了**跨重启稳定**
 *   （同一账号每天都是同一台设备，这才像真人）。
 *
 * @param {'machine'|'session'} salt
 * @param {string|number} uid 账号 uid（缺失时退回账号 id，仍保证跨账号不同）
 * @returns {string} UUIDv4 形状的稳定标识；uid 为空时返回空串（不编）
 */
function deriveDeviceId(salt, uid) {
  const key = String(uid == null ? '' : uid).trim();
  if (!key) return '';
  const s = crypto.createHash('md5').update(`${salt}:${key}`, 'utf8').digest('hex');
  // 8-4-4-4-12，钉版本位（4）与变体位（8|9|a|b）
  const variant = (0x8 | (parseInt(s[16], 16) & 0x3)).toString(16);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${variant}${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

/** chat 形态 UA：三段 `WorkBuddy/<v> WorkBuddy/<v> CLI/<cli>`（官方 5.11.x 实包
 * 形态，yreidev official-client.md 核对）。intl 版产品 token 是 workbuddy-ai（无空格，
 * Zhengyuuuui 抓包口径），不再是旧的「WorkBuddy AI」带空格形态。 */
function chatUserAgent(region) {
  const clientVersion = (process.env.DUMATE_WORKBUDDY_APP_VERSION || '').trim()
    || c.specOf(region).fallbackAppVersion;
  const product = region === 'global' ? 'workbuddy-ai' : 'WorkBuddy';
  return `${product}/${clientVersion} ${product}/${clientVersion} CLI/${c.CHAT_CLI_VERSION}`;
}

/**
 * chat 请求头（2026-11-28 融合批 P0-1，对齐官方 5.11.x 实包）。
 *
 * **负向清单**（官方对话**不发**，yreidev 实包核对 + probe-workbuddy-ab.js 变体 B
 * 实测减头后 200）：Accept-Language / Origin / Referer / X-Requested-With /
 * X-Machine-ID / X-Session-ID / chat 上的 X-No-*（那是登录前 auth/state 的约定）。
 * X-Machine-ID/X-Session-ID 是我们 11.4 批加的「按账号派生设备指纹」——官方不发，
 * 且本轮 A/B 证明减掉无碍。DUMATE_WORKBUDDY_LEGACY_DEVICE_HEADERS=1 可临时带回。
 *
 * **新增**（官方必发，此前全缺）：8 个 X-Stainless-*（openai-js SDK 指纹）、
 * X-Agent-Intent/Type/Runtime（CLI 2.165.0 起必有）、X-Private-Data、
 * X-Client-Version/Platform/Product（5.11.x 起统一注入）、traceparent + 单行 b3
 * （W3C 族，与 X-B3-* 家族同发）。
 *
 * **分歧带（保持现状，注释存证）**：X-CodeBuddy-Request 与主对话的
 * X-Root-Request-ID——Zhengyuuuui 的 intl 抓包里有、yreidev 的实包核对说主对话
 * 不带（只有子代理带）。按「带上无害（A/B 已证）」保留，出现风控时先减这两个。
 *
 * id 形态全部升级 uuidv7 去连字符（官方口径）；cn 的 X-Request-ID 镜像
 * X-Conversation-Request-ID（Zhengyuuuui 抓包），intl 镜像 X-Conversation-Message-ID。
 *
 * @param {string} [traceIdHex] 会话级 TraceId（32-hex，可选）。传入时 trace 双族
 *   （X-B3-TraceId / traceparent / b3）随会话延续（P2「b3 链路随会话延续」）；
 *   不传或形状不对则每请求生成新 uuidv7（activity.js 等调用方不受影响）。
 */
function chatHeaders(region, account, bodyLen, convId, traceIdHex, opts = {}) {
  const spec = c.specOf(region);
  const clientVersion = (process.env.DUMATE_WORKBUDDY_APP_VERSION || '').trim()
    || spec.fallbackAppVersion;
  const product = region === 'global' ? 'workbuddy-ai' : 'WorkBuddy';
  const msgId = uuidv7hex();
  // convReqId 可由调用方传入（postStream：头体必须同源——body 里最后一条 user
  // 的 conversationRequestId 写的就是同一个值，批次十）；不传则本级生成。
  const convReqId = String(opts.convReqId || '') || uuidv7hex();
  const traceId = /^[0-9a-f]{32}$/.test(String(traceIdHex || ''))
    ? String(traceIdHex).toLowerCase()
    : uuidv7hex();
  const spanId = crypto.randomBytes(8).toString('hex');
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Content-Length': String(bodyLen),
    Authorization: `Bearer ${(account && account.accessToken) || ''}`,
    'X-Product': 'SaaS',
    'X-Agent-Purpose': 'conversation',
    'X-Agent-Intent': 'craft',
    // agentType 可覆写（批次十窗口探针用 auxiliary——panel 口径：内部维护请求
    // 不是用户主对话，上游看到的仍是一个正常 chat 请求）
    'X-Agent-Type': String(opts.agentType || '') || 'main',
    'X-Agent-Runtime': 'local-agent',
    'X-Private-Data': 'true',
    'X-Client-Version': clientVersion,
    'X-Client-Platform': 'macos',
    'X-Client-Product': product,
    // 客户端指纹（个人中心「请求明细」按这些头识别客户端；官方抓包 x-ide-* 值
    // 是 WorkBuddy 而不是 CLI——CLI 只出现在 UA 第三段）
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': clientVersion,
    // openai-js SDK 指纹（官方对话必带；版本对齐官方锁定的 6.25.0/v22.21.1）
    'X-Stainless-Retry-Count': '0',
    'X-Stainless-Timeout': '1200',
    'X-Stainless-Lang': 'js',
    'X-Stainless-Package-Version': '6.25.0',
    'X-Stainless-OS': 'MacOS',
    'X-Stainless-Arch': 'arm64',
    'X-Stainless-Runtime': 'node',
    'X-Stainless-Runtime-Version': 'v22.21.1',
    // 会话三件套（dsh-xdpool#58：缺任一 400 11128）。
    // X-Conversation-Request-ID 是上游「一次用户发送」的聚合主键，每请求新值；
    // X-Conversation-Message-ID 是被回答的那条消息。
    'X-Conversation-ID': convId,
    'X-Conversation-Request-ID': convReqId,
    'X-Conversation-Message-ID': msgId,
    'X-Request-ID': region === 'global' ? msgId : convReqId,
    // 链路追踪族：X-B3-* 家族 + W3C traceparent/单行 b3（官方两族同发）。
    // 桌面端无父 span，Root-Request-ID 与本请求同级（分歧带，见上）
    'X-Root-Request-ID': msgId,
    'X-CodeBuddy-Request': '1',
    'X-Trace-ID': traceId,
    traceparent: `00-${traceId}-${spanId}-01`,
    b3: `${traceId}-${spanId}-1`,
    'X-B3-TraceId': traceId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',
  };
  if (account && account.uid) h['X-User-Id'] = String(account.uid);
  if (account && account.enterpriseId) h['X-Enterprise-Id'] = String(account.enterpriseId);
  if (account && account.domain) h['X-Domain'] = String(account.domain);
  // 设备/会话标识：官方对话不发（11.4 批加的，A/B 证明减掉无碍）→ 默认不带；
  // 兜底开关带回时仍按账号派生（绝不共用进程级常量，见 deriveDeviceId 注释）
  if (String(process.env.DUMATE_WORKBUDDY_LEGACY_DEVICE_HEADERS || '').trim() === '1') {
    const uidKey = account && (account.uid || account.id);
    const machineId = deriveDeviceId('machine', uidKey);
    const sessionId = deriveDeviceId('session', uidKey);
    if (machineId) h['X-Machine-ID'] = machineId;
    if (sessionId) h['X-Session-ID'] = sessionId;
  }
  return h;
}

/**
 * 发流式请求。返回 { stream, status, headers, convId, reqHeaders }。
 * 走账号的出站代理（proxy-agent），与其它直连通道同规则。
 *
 * `reqHeaders` 是**我们实际发出去**的请求头（不是上游回的）：11-128 取证
 * （dump.js）要对照出站身份头，重建一份会有偏差（X-Request-ID 之类每次随机），
 * 所以在这里原样回传。
 *
 * P1-4 failover 一期（仅国内版多入口链）：主入口基础设施类失败（408/502/503/
 * 传输错误/超时；**504 不算**）→ 换备用入口重发一次（同一份 body 与 convId），
 * 每请求最多一次。响应体带 `retry_policy.retry === false` 时上游明说别重试——
 * 不 failover 也不记熔断。详见 failover.js。
 */
function postStream(region, account, payload, opts = {}) {
  return new Promise((resolve) => {
    let agent = null;
    try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
      return resolve({ stream: null, status: 0, error: `出站代理配置错误: ${e.message}`, fatal: true });
    }
    const spec = c.specOf(region);
    // 本轮聚合主键先于 body 构造生成：buildChatBody 把它写进最后一条 user 的
    // conversationRequestId，chatHeaders 把同一个值写进 X-Conversation-Request-ID
    // （批次十头体同源；failover 重发同一份 body，主键不换）
    const convReqId = uuidv7hex();
    const { body, convId, traceId } = buildChatBody(payload, region, account, {
      convReqId,
    });
    const chain = failover.chainFor(region, spec.chatBase);
    const maxIdx = Math.min(1, chain.length - 1); // 每请求最多一次 failover
    const attempt = (idx) => {
      const cand = chain[idx];
      const u = new URL(cand.base + c.EP_CHAT);
      const headers = {
        ...chatHeaders(region, account, Buffer.byteLength(body), convId, traceId, {
          convReqId,
          agentType: opts.agentType,
        }),
        'User-Agent': chatUserAgent(region),
      };
      const reqOpts = {
        hostname: u.hostname,
        path: u.pathname,
        method: 'POST',
        headers,
        // 长流不能设总超时，否则 SSE 会被掐断（与其它直连通道同口径）
        timeout: 600000,
        ...(agent ? { agent } : {}),
      };
      // 静态 IP 兜底候选：TCP 打 IP，Host 与 TLS SNI 仍用原域名（HTTPDNS 语义）
      if (cand.shadowHost) {
        headers.Host = cand.shadowHost;
        reqOpts.servername = cand.shadowHost;
      }
      const req = requestImpl(reqOpts, (res) => {
        const status = res.statusCode;
        if (!failover.isInfraStatus(status)) {
          failover.noteSuccess(cand.hostKey);
          return resolve({ stream: res, status, headers: res.headers, convId, reqHeaders: headers, bodyText: body });
        }
        // 基础设施失败：有界读完错误体，看上游有没有明说「别重试」
        readCapped(res, 1024 * 1024, (errText) => {
          if (/retry_policy[\s\S]{0,64}?"retry"\s*:\s*false/.test(errText)) {
            failover.noteSuccess(cand.hostKey);
            return resolve({ stream: bufferStream(errText, res.headers, status), status, headers: res.headers, convId, reqHeaders: headers, bodyText: body });
          }
          failover.noteFailure(cand.hostKey);
          if (idx + 1 <= maxIdx) return attempt(idx + 1);
          resolve({ stream: bufferStream(errText, res.headers, status), status, headers: res.headers, convId, reqHeaders: headers, bodyText: body });
        });
      });
      req.on('error', (e) => {
        failover.noteFailure(cand.hostKey);
        if (idx + 1 <= maxIdx) return attempt(idx + 1);
        resolve({ stream: null, status: 0, error: e.message, convId });
      });
      req.on('timeout', () => {
        req.destroy();
        failover.noteFailure(cand.hostKey);
        if (idx + 1 <= maxIdx) return attempt(idx + 1);
        resolve({ stream: null, status: 0, error: 'timeout', convId });
      });
      req.write(body);
      req.end();
    };
    attempt(0);
  });
}

// 有界读整个响应体（基础设施错误体都是网关小页；1MB 封顶防异常大包）
function readCapped(stream, cap, cb) {
  const { StringDecoder } = require('string_decoder');
  const dec = new StringDecoder('utf8');
  let out = '';
  let done = false;
  const finish = () => { if (!done) { done = true; cb(out); } };
  stream.on('data', (x) => {
    out += dec.write(x);
    if (Buffer.byteLength(out) > cap) { stream.destroy(); finish(); }
  });
  stream.on('end', () => { out += dec.end(); finish(); });
  stream.on('error', () => finish());
}

// 把缓冲的错误体包成可读流——调用方（index.js 的 readAll/readStream）拿到的
// 形状与真 res 一致（statusCode/headers 挂在流对象上）
function bufferStream(text, headers, status) {
  const { PassThrough } = require('stream');
  const pt = new PassThrough();
  pt.statusCode = status;
  pt.headers = headers || {};
  pt.end(Buffer.from(text, 'utf8'));
  return pt;
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
  uuidv7hex, uuidFromSeed, uuidv7Uuid,
  stableConversationId, promptCacheKey, hasFunctionTools, buildChatBody, chatHeaders, chatUserAgent,
  sessionTraceId, seedTraceHex,
  guardEmptyTextParts, fillSniffedEmptyText,
  SYSTEM_TAIL_STUB,
  withoutReasoningFields, deriveDeviceId,
  postStream, readStream, aggregate, _setRequestImpl,
};
