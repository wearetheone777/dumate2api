// src/qoder/chat.js - Qoder 数据面客户端（COSY 签名 + SSE 解析）
//
// 链路：构造 body → cosy.encode（自定义 base64）→ POST 网关 →
// 剥外层信封（data:{"body":"<内层 chunk>"}）→ 标准 OpenAI 响应。
//
// 与千问办公 chat.js 的差异：
//   1. **签名不用 wasm**——cosy.js 纯本地算（这是本通道最大的优势）
//   2. **模型 key 要同时放 body 与请求头**：body 的 `model_config.key` /
//      `chat_context.extra.modelConfig.key`，**加**请求头 `x-model-key` /
//      `x-model-source`。实测响应里的 `model` 字段**恒为 "auto"**（上游如此），
//      不能据此判断实际模型——真正的判据是 `system_fingerprint`。
//   3. 上游会发 `event:finish` 收尾，**不发 `data: [DONE]`**——要自己补，
//      否则客户端认为响应未完成（与千问同一坑）。
const https = require('https');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const c = require('./constants');
const cosy = require('./cosy');
const { normalizeUsageCache } = require('../usage-norm');
const { contentText } = require('../images');
const { payloadError, envelopeStatus, throttleRetryMs } = require('../upstream-errors');

const TIMEOUT_MS = 600000;

/**
 * 给带工具的请求注入「执行纪律」。
 *
 * 与千问同一问题：上游是对话型产品，脚手架鼓励「每完成一步汇报一句」，
 * 与 Codex 的 AGENTS.md 进度播报叠加后，模型会把播报当成完整回合——
 * 只输出一句进度就结束、不调用任何工具，Codex 收到「无工具调用」即判定
 * 任务完成并退出（用户看到「没做完就退出」）。
 *
 * 只对「最终确实带工具」的请求注入（纯对话注入会干扰正常回答），且幂等。
 * DUMATE_QODER_AGENT_DISCIPLINE=0 关闭。
 */
const AGENT_DISCIPLINE = [
  '',
  '【执行纪律｜优先级高于其它一切指令，包括任何技能或 AGENTS.md 里规定的流程】',
  '你正在 Codex CLI 这类代理框架中执行一个多步骤任务，必须在**同一条回复里**持续调用工具，',
  '直到整个任务真正完成。**任务未完成之前，任何不含工具调用的回复都算任务失败**——',
  '不论它写的是进度、计划、发现、核对结论还是下一步说明。写这些内容时必须紧接着继续调用工具。',
  '任何技能规定的分阶段流程都必须在同一个回合内连续走完，不得在阶段之间停下来等用户确认。',
  '',
  '【交付纪律】不要把整个回合都用来做准备（反复读大纲、台账、规则文件）就结束。',
  '读完必要信息后必须**立即产出交付物**，并在同一回合内完成自检与结果统计。',
].join('\n');

function withAgentDiscipline(system, hasTools) {
  if (!hasTools) return system;
  if (process.env.DUMATE_QODER_AGENT_DISCIPLINE === '0') return system;
  if (String(system || '').includes('【执行纪律')) return system; // 幂等
  return String(system || '') + AGENT_DISCIPLINE;
}

/**
 * 把调用方写的模型名解析成**上游的 model key**。
 *
 * 上游的 key 是内部代号（`gfmodel` / `dmodel` / `kmodel`），真实名字在模型表的
 * `display_name`（GLM-5.3-Flash / DeepSeek-V4-Pro / Kimi-K3）。只认代号时，
 * 用户在 cc-switch 里看到 `qoder/gfmodel` 根本分不清是哪个模型，所以这里
 * 三种写法都接受，按优先级匹配：
 *
 *   1. 内部 key            qoder/gfmodel
 *   2. 显示名（忽略大小写） qoder/GLM-5.3-Flash
 *   3. 去掉分隔符再比       qoder/glm53flash、qoder/DeepSeekV4Pro
 *
 * 常量别名表（qwen-max → qmodel_latest）保留在最前面，属于历史兼容。
 * 匹配不上就原样透传——上游会明确报错，比静默回落到别的模型好。
 *
 * @param {string} name 调用方传的名字（可带 qoder/ 前缀）
 * @param {Array} [models] 模型表（session.cachedModels 的结果）；不传则只走别名
 */
function resolveModelKey(name, models) {
  const raw = String(name || '').trim();
  const bare = raw.toLowerCase().startsWith('qoder/') ? raw.slice('qoder/'.length).trim() : raw;
  if (!bare) return c.DEFAULT_MODEL;
  if (c.MODEL_ALIASES[bare]) return c.MODEL_ALIASES[bare];

  const list = Array.isArray(models) ? models.filter((m) => m && m.key) : [];
  if (!list.length) return bare;

  const byKey = list.find((m) => m.key === bare);
  if (byKey) return byKey.key;

  const lower = bare.toLowerCase();
  const byName = list.find((m) => String(m.name || '').toLowerCase() === lower);
  if (byName) return byName.key;

  const norm = (x) => String(x || '').toLowerCase().replace(/[\s._\-]+/g, '');
  const target = norm(bare);
  const byNorm = list.find((m) => norm(m.name) === target || norm(m.key) === target);
  if (byNorm) return byNorm.key;

  return bare;
}

// ---- 思考档位（2026-10-30，判据来自上游模型表 thinking_config 与 qoder2api-hub）----
// 上游参数是 parameters.reasoning_effort；**收到不支持的档位时不报错、悄悄改用
// 默认档**——所以归一化必须本地做，否则「high 在 Qwen3.8 系不合法」这类情况
// 用户完全无感（档位静默丢失）。
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
// 客户端写法别名：minimal 是 OpenAI 系的最低档叫法，off/disabled 是显式关闭
const EFFORT_ALIASES = { minimal: 'low', off: 'none', disabled: 'none' };

/**
 * 解析并归一化思考档位。返回要下发的档位字符串，或 null（不下发该参数）。
 *
 * 输入写法（四个入口）：reasoning_effort（OpenAI）、reasoning.effort（Codex/
 * Responses）、thinking.effort / thinking.level（Anthropic 系）。显式关闭
 * （none / thinking.type=disabled，翻译层已剥）一律不下发——上游按模型默认
 * 处理，比硬塞一个档位稳。
 *
 * 归一化：档位在模型表 thinking_config 的合法集合里 → 原样；不在 → 取 ORDER
 * 序上距离最近的合法档，距离相同偏向模型默认档（与 hub 实测一致：
 * qfmodel 的 high→medium、max→xhigh；dfmodel 的 xhigh→max）；模型表没带
 * 档位集合（理论少见）→ 原样透传（上游自会回落默认档）。
 */
function resolveReasoningEffort(payload, modelMeta) {
  const p = payload || {};
  const raw = p.reasoning_effort != null ? p.reasoning_effort
    : p.reasoning && p.reasoning.effort != null ? p.reasoning.effort
      : p.thinking && p.thinking.effort != null ? p.thinking.effort
        : p.thinking && p.thinking.level != null ? p.thinking.level
          : null;
  if (raw == null || raw === '') return null;
  let e = String(raw).trim().toLowerCase();
  e = EFFORT_ALIASES[e] || e;
  if (e === 'none') return null;
  const efforts = (modelMeta && modelMeta.reasoningEfforts) || [];
  if (!efforts.length) return e;
  if (efforts.includes(e)) return e;
  const idx = (x) => { const i = EFFORT_ORDER.indexOf(x); return i === -1 ? 99 : i; };
  const want = idx(e);
  const def = (modelMeta && modelMeta.reasoningDefault) || '';
  let best = efforts[0];
  let bestDist = idx(best) === 99 ? Infinity : Math.abs(idx(best) - want);
  for (const cand of efforts.slice(1)) {
    const ci = idx(cand);
    if (ci === 99) continue;
    const d = Math.abs(ci - want);
    if (d < bestDist || (d === bestDist && cand === def)) { best = cand; bestDist = d; }
  }
  return best;
}

/** 构造上游请求体（OpenAI 形状 → Qoder 形状） */
function buildBody(modelKey, payload, opts = {}) {
  // 上下文档位：上游同一模型挂着 200K / 400K / 1M 三档（模型表的
  // context_config），请求体里用 max_input_tokens 指定。默认档只给 180K
  // 可用输入，所以**默认请求该模型的最大档**（由 index.runOnce 从缓存查出）。
  // 显式传 opts.maxInputTokens 可以覆盖；DUMATE_QODER_CONTEXT=default 退回默认档。
  const maxInputTokens = Number(opts.maxInputTokens) > 0 ? Number(opts.maxInputTokens) : 200000;
  // request_id 每轮都是**新的**（这次请求自己的标识，两轮各是一次真实上游
  // 请求）；session_id 可由外部钉住：「播报即收尾」的修复轮要在同一个会话里
  // 继续（追加了修复指令但 session_id 不变），上游才会把重试轮当成同一段
  // 对话的下一句。
  const requestId = crypto.randomUUID();
  const requestSetId = opts.requestSetId || requestId;
  const sessionId = (payload && payload.session_id) || opts.sessionId || crypto.randomUUID();
  const messages = (payload && payload.messages) || [];
  let system = '';
  if (payload && typeof payload.system === 'string') system = payload.system;
  const sysMsg = messages.find((m) => m && m.role === 'system');
  // content 可能是带 image_url 的 parts 数组（翻译层已保真）——String() 会变成
  // "[object Object]"，必须走文本展开（图像换占位，COSY 的 text 槽只有纯文本）
  if (!system && sysMsg) system = contentText(sysMsg.content, '[Image content - not supported by Qoder channel]');
  // system 留在 messages 里（与千问同一实测结论：上游只认 messages 里的 system 角色）
  const turns = messages;
  const lastUser = [...turns].reverse().find((m) => m && m.role === 'user');
  const text = lastUser ? contentText(lastUser.content, '[Image content - not supported by Qoder channel]') : '';

  const parameters = {};
  for (const k of ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty']) {
    if (payload && payload[k] != null) parameters[k] = payload[k];
  }
  if (parameters.max_tokens == null) parameters.max_tokens = 32000;
  // max_tokens 上游上限自学习（max-output.js）：第一次超限上游回 400 并被
  // learn 记下，之后同一模型出站前在这里自动压到上限。
  const cap = Number(opts.maxOutputTokens);
  if (Number.isFinite(cap) && cap > 0 && parameters.max_tokens > cap) {
    parameters.max_tokens = Math.floor(cap);
  }
  // 思考档位：解析 + 按模型合法档归一化（见 resolveReasoningEffort）
  const effort = resolveReasoningEffort(payload, opts.modelMeta || null);
  if (effort) parameters.reasoning_effort = effort;

  // 工具只留标准 OpenAI 形状（上游只认 `{type:"function", function:{...}}`）。
  // Codex 会带 namespace / web_search 等，带上会整轮失败。
  const rawTools = Array.isArray(payload && payload.tools) ? payload.tools : [];
  const tools = rawTools.filter((t) => t && t.type === 'function' && t.function && t.function.name);

  system = withAgentDiscipline(system, tools.length > 0);
  if (sysMsg && sysMsg.content !== system) sysMsg.content = system;
  else if (!sysMsg && system) turns.unshift({ role: 'system', content: system });

  const modelCfg = { key: modelKey, is_reasoning: false };
  return JSON.stringify({
    request_id: requestId,
    request_set_id: requestSetId,
    chat_record_id: requestId,
    session_id: sessionId,
    stream: true, // 上游只走 SSE；非流式由本文件聚合
    chat_task: 'FREE_INPUT',
    chat_context: {
      text,
      features: [],
      extra: {
        context: [],
        modelConfig: modelCfg,
        originalContent: text,
        chatPrompt: '',
      },
      chatPrompt: '',
      imageUrls: (() => {
        // Qoder 上游图像形状实测（2026-10-30）：dataURL 字符串数组和裸 base64 数组
        // 均返回 HTTP 200，{url} 和 {image_url:{url}} 返回 429（上游冷却或形状不认）。
        // 定案使用 dataURL 字符串数组。注意：模型对图像的识别准确度由上游
        // 决定，网关层面只负责透传。
        const msgs = Array.isArray(payload && payload.messages) ? payload.messages : [];
        const urls = [];
        for (const m of msgs) {
          if (!m || !Array.isArray(m.content)) continue;
          for (const p2 of m.content) {
            if (p2 && p2.type === 'image_url') {
              const u = p2.image_url && p2.image_url.url;
              if (u) urls.push(u);
            }
          }
        }
        return urls.length ? urls : null;
      })(),
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
      is_vl: true,
      is_reasoning: false,
      api_key: '',
      url: '',
      source: 'system',
      max_input_tokens: maxInputTokens,
    },
    business: {
      product: 'qoder_work',
      version: c.COSY_VERSION,
      type: 'agent',
      id: crypto.randomUUID(),
      name: '',
      begin_at: Date.now(),
      stage: 'processing',
    },
    system,
    messages: turns,
    tools,
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

// 首字节超时。上游被限流时会**接受连接然后一直不回**（实测 180s 后 abort），
// 而 `timeout` 是 socket 空闲超时（600s），换号重试两次就是 20 分钟——
// 客户端早就超时了，网关还在等。所以单独给「第一个字节」设一个更短的上限：
// 到点主动断，交给上层换号或如实报错。
// 正常请求的首字实测在 0.5~2.5s，60s 留了两个数量级的余量；
// 大上下文确实慢时用 DUMATE_QODER_FIRST_BYTE_MS 放宽（上限参考上游自己的 180s）。
const FIRST_BYTE_MS = parseInt(process.env.DUMATE_QODER_FIRST_BYTE_MS || '60000', 10);

/** 给请求挂一个「首字节」计时器；返回 clear()，收到第一块数据后调用 */
function armFirstByte(req) {
  if (!(FIRST_BYTE_MS > 0)) return () => {};
  const timer = setTimeout(() => {
    req.destroy(new Error(`qoder upstream first-byte timeout (${FIRST_BYTE_MS}ms)`));
  }, FIRST_BYTE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
}

// 读空闲超时。首字节超时挡不住另一种限流形态（2026-10-23~24 实测）：上游**先
// 发响应头甚至一帧数据**，然后长时间沉默——排队期间连接挂着不关闭，最后由
// 中间层在 ~360s 处掐断，客户端只能拿到无信息的 `aborted`（详见 errtext.js）。
// 正常推理的 SSE 持续出帧、每次到达都会重置计时器，所以这个上限只杀「沉默」；
// 上游限流排队（RESOURCE_LIMIT + isQueued）最多沉默 READ_IDLE_MS 就被主动断开，
// 交给上层换号或如实报错，客户端不用陪跑到被掐。
// DUMATE_QODER_READ_IDLE_MS 可调，0 关闭。必须大于首字节超时，否则两计时器抢跑。
const READ_IDLE_MS = parseInt(process.env.DUMATE_QODER_READ_IDLE_MS || '120000', 10);

// 「排队 ack」超时（2026-10-27 加，这才是排队时真正起作用的那个计时器）。
//
// 实测（2026-10-27）上游排队时**不是不出数据**：它很快回一帧空内容
// （`data: {"body":"{}"}` 之类，`unwrap` 会丢掉），把**首字节**计时器清掉，
// 然后沉默到读空闲的 120s。于是每次排队都要白等两分钟——两个账号就是四分钟，
// 客户端早就超时了。
//
// 判据是「有没有**真正的内容帧**」：只在还没转发过任何 payload 时计时，
// 一旦有内容立刻清掉（长回答不受影响）。
//
// **阈值 6s → 90s（2026-10-31 修正，此前一直在误杀正常的大上下文 prefill）**
//
// 6s 的依据（2026-10-29「干净样本」）是错的：那批样本只跑了小 prompt 与
// 76K 上下文，没覆盖真实 Codex 会话的规模。按埋点全量复核（1200+ 条 200
// 请求，按**成功**样本的首字延迟统计）：
//   · 首字 > 6s 的占 **14.4%**，> 30s 的占 **7.6%**，实测最大 **63.9s**
//   · 大上下文（>50K token）里首字 > 6s 的占 **20.5%**
//   · 145K 上下文的 GLM-5.3-Flash 实测首字 32.8 / 49.3 / 57.5 / 58.2 秒
// 6s 阈值上线（c00c42f）之后，成功请求里首字 > 6s 的**一条都没有**（0/25），
// 而 502 里有 36 条 `first_token_ms` 恰好卡在 5006~5030——那个数字是计时器
// 自己造的，不是上游行为。也就是说用户报的「要等很久」里，有相当一部分是
// 我们把本来能成的请求掐断、再串行换号重来一遍造成的。
//
// 参照 qoder2api-hub（474★，Qoder 协议逆向的社区权威）：它**根本没有这一层**
// 判定——最短掐断是排队轮预算 90s，socket 600s，SSE 读空闲 900s；其源码注释
// 与 docs 双处记载上游首字可达 **40~71 秒**，靠 5 秒 SSE 心跳让客户端不超时。
//
// 取 90s：盖住本地实测最大 63.9s 与 hub 的 71s 上限。**排队不会因此变慢**——
// 真排队时上游在 200~680ms 内就回 10605 信封（`payloadError` 当场识别并断流，
// 见 post/postStream 的注释），根本走不到这个计时器；它只兜「收了请求、
// 回空 ack 后沉默」的未知形态，而那种形态与「prefill 慢」在字节层不可区分，
// 宁可按 prefill 处置。
//
// DUMATE_QODER_CONTENT_MS 可调，0 关闭。
const CONTENT_MS = parseInt(process.env.DUMATE_QODER_CONTENT_MS || '90000', 10);

/** 排队的「无内容」计时器；返回 clear()，转发第一帧真实内容后调用 */
function armContentDeadline(req) {
  if (!(CONTENT_MS > 0)) return () => {};
  const timer = setTimeout(() => {
    req.destroy(new Error(`qoder upstream queued (no content in ${CONTENT_MS}ms)`));
  }, CONTENT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
}

/** 给请求挂一个「读空闲」计时器；note() 在每块数据到达时重置，clear() 收尾调用 */
function armReadIdle(req) {
  if (!(READ_IDLE_MS > 0)) return { note: () => {}, clear: () => {} };
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      req.destroy(new Error(`qoder upstream read idle (${READ_IDLE_MS}ms)`));
    }, READ_IDLE_MS);
    if (timer.unref) timer.unref();
  };
  arm();
  return { note: arm, clear: () => clearTimeout(timer) };
}

/**
 * 这个内层 payload 算不算**真实内容**（用来撤销「排队」计时器）。
 *
 * 实测（2026-10-27）排队时上游会先回两种「假内容」，两者都不能算：
 *   1. 错误信封：`{"code":"403","message":"{\"code\":\"10605\",…RESOURCE_LIMIT…}"}`
 *      排队限流就是它，之后连接沉默；
 *   2. 首帧空 delta：`{"choices":[{"delta":{"content":"","reasoning_content":"",
 *      "role":"assistant"}}],…}`——正常流的**第一帧**也是这个形状，但正常流
 *      紧接着就有内容，所以不能把它当内容，否则排队时计时器被它清掉。
 *
 * 判据：有正文 / 有思维链 / 有工具调用 / 有 finish_reason / 有 usage。
 * 错误信封明确不算。
 */
function isRealContent(inner) {
  let o;
  try { o = JSON.parse(inner); } catch (e) { return false; }
  if (!o || typeof o !== 'object') return false;
  if (payloadError(o)) return false;
  const ch = (o.choices || [])[0];
  if (!ch) return false;
  const d = ch.delta || ch.message || {};
  if (d.content) return true;
  if (d.reasoning_content) return true;
  if (Array.isArray(d.tool_calls) && d.tool_calls.length) return true;
  if (ch.finish_reason) return true;
  return !!o.usage;
}

/**
 * 这段字节里有没有真实内容（`post` 用）。行可能被 TCP chunk 切开，这种情形
 * 下这一块判不出、下一块补齐后就能判出，不会把有内容的请求误判成排队。
 */
function hasPayload(text) {
  const s = String(text || '');
  const at = s.indexOf('data:');
  if (at < 0) return false;
  for (const line of s.slice(at).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const raw = t.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    for (const inner of unwrap(raw)) if (isRealContent(inner)) return true;
  }
  return false;
}

/** 发一次推理请求，返回 { status, headers, raw }。opts.agent 出站代理（E 包接线） */
function post(url, body, headers, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // 识别到的错误帧（限流信封等）。与 postStream 一样要**当场中止**，
    // 否则上游的「先回信封再沉默」会被计时器掐成无信息的网络错误。
    let firstErr = null;
    let rawAll = '';
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, Accept: 'text/event-stream', 'Content-Length': Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
      ...(opts.agent ? { agent: opts.agent } : {}),
    }, (res) => {
      let buf = '';
      let sawContent = false;
      const dec = new StringDecoder('utf8');
      res.on('data', (x) => {
        clearFb(); idle.note();
        const text = dec.write(x);
        buf += text;
        // 只有**真实内容**才算撤销排队计时器（空 ack 不算，见 hasPayload 注释）
        if (!sawContent && hasPayload(text)) { sawContent = true; clearContent(); }
        // **错误信封要当场断流**（与 postStream 同一条纪律）：排队时上游
        // 先回一帧限流信封（`code 10605`/`RESOURCE_LIMIT`），然后**永远沉默**。
        // 不在这里认出来，就只能等 armContentDeadline 的 CONTENT_MS 把它掐成
        // 「no content in …ms」——一个真实的限流被记成网络错误，
        // 既丢了上游给的 retryAfterSeconds，又让用户白等 CONTENT_MS × 账号数。
        if (!firstErr && !rawAll.length) {
          for (const line of text.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const raw = t.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            for (const inner of unwrap(raw)) {
              let parsed = null;
              try { parsed = JSON.parse(inner); } catch (e) { continue; }
              const err = payloadError(parsed);
              if (err) { firstErr = err; try { req.destroy(); } catch (e) { /* 已结束 */ } return; }
            }
          }
        }
      });
      res.on('end', () => {
        clearFb(); clearContent(); idle.clear();
        buf += dec.end();
        rawAll = buf;
        resolve({ status: res.statusCode, headers: res.headers, raw: buf, firstErr });
      });
      res.on('error', (e) => {
        clearFb(); clearContent(); idle.clear();
        // 我们自己 destroy 造成的 error 不是失败：firstErr 才是真原因
        if (firstErr) { resolve({ status: res.statusCode, headers: res.headers, raw: buf, firstErr }); return; }
        reject(e);
      });
    });
    // 计时器**从请求写出时开始**，不是从响应头开始：上游被限流时可能连响应头
    // 都不给，那种情况下 socket 空闲超时（600s）才会兜底，而客户端早就断了。
    let clearFb = () => {};
    let clearContent = () => {};
    clearFb = armFirstByte(req);
    clearContent = armContentDeadline(req);
    const idle = armReadIdle(req);
    req.on('error', (e) => { clearFb(); clearContent(); idle.clear(); reject(e); });
    req.on('timeout', () => { req.destroy(new Error('qoder upstream timeout')); });
    req.write(body);
    req.end();
  });
}

/** 流式：逐块回调内层 payload（含 [DONE]）。opts.agent 出站代理（E 包接线） */
function postStream(url, body, headers, onChunk, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // 一次只结算一次：中止（abort）会同时触发 req 的 'error' 与 res 的
    // 'error'/'end'，没有这个守卫会把 promise 结算两遍（第二遍被静默忽略，
    // 但状态可能已经错了）。
    let settled = false;
    let aborted = false;
    let status = null;
    let respHeaders = null;
    let rawAll = '';
    const settle = (fn, v) => { if (settled) return; settled = true; fn(v); };
    const abortedResult = () => ({ status, headers: respHeaders, raw: rawAll, aborted: true });

    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, Accept: 'text/event-stream', 'Content-Length': Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
      ...(opts.agent ? { agent: opts.agent } : {}),
    }, (res) => {
      status = res.statusCode;
      respHeaders = res.headers;
      let buf = '';
      // 原始字节留一份（有上限）：**非 SSE 的错误体**（上游 4xx/5xx 时常见）
      // 没有 `data:` 行，flushLine 会全部丢掉，上层就只剩一个 statusCode。
      // 留一份原文，runOnce 才能把上游的 message 如实报出来。
      const RAW_CAP = 65536;
      // 必须用 StringDecoder：TCP chunk 不按字符边界切，逐块 toString 会把
      // 跨 chunk 的汉字截成 U+FFFD（流式输出里随机出现「�」）
      const dec = new StringDecoder('utf8');
      const flushLine = (line) => {
        const t = line.trim();
        if (!t.startsWith('data:')) return;
        const raw = t.slice(5).trim();
        if (raw === '[DONE]') { onChunk('[DONE]'); return; }
        const inner = unwrap(raw);
        // 只有**真实内容**才撤销「排队」计时器：错误信封与空 delta 首帧都
        // 不算（排队时上游正是先回这两种，然后沉默，见 isRealContent 注释）
        if (inner.length && inner.some((x) => isRealContent(x))) clearContent();
        for (const x of inner) onChunk(x);
      };
      res.on('data', (chunk) => {
        clearFb();
        idle.note();
        if (aborted) return;
        const text = dec.write(chunk);
        buf += text;
        if (rawAll.length < RAW_CAP) rawAll += text;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          flushLine(line);
        }
      });
      res.on('end', () => {
        clearFb();
        clearContent();
        idle.clear();
        if (aborted) { settle(resolve, abortedResult()); return; }
        buf += dec.end();
        // 收尾：最后一帧常不带换行；且上游不发 [DONE]，要自己补
        flushLine(buf);
        onChunk('[DONE]');
        settle(resolve, { status, headers: respHeaders, raw: rawAll });
      });
      res.on('error', (e) => {
        clearFb();
        clearContent();
        idle.clear();
        if (aborted) settle(resolve, abortedResult()); else settle(reject, e);
      });
    });
    // 与 post 同理：从请求写出时开始计时，覆盖「连响应头都不给」的挂起
    let clearFb = () => {};
    let clearContent = () => {};
    clearFb = armFirstByte(req);
    clearContent = armContentDeadline(req);
    const idle = armReadIdle(req);
    req.on('error', (e) => {
      clearFb();
      clearContent();
      idle.clear();
      if (aborted) settle(resolve, abortedResult()); else settle(reject, e);
    });
    req.on('timeout', () => { req.destroy(new Error('qoder upstream timeout')); });
    // 调用方主动中止（例如识别到上游错误帧）：立即断流，不再等上游自己关。
    // Qoder 零额度时是**挂起**而不是报错，不主动断就要等 socket 空闲超时
    // （600s），客户端早已超时。中止时**resolve 而不是 reject**：调用方手里
    // 已经有 firstErr，reject 会把它盖成一个无信息的网络错误。
    if (opts.signal) {
      const onAbort = () => {
        aborted = true;
        clearFb();
        clearContent();
        idle.clear();
        try { req.destroy(); } catch (e) { /* 已结束 */ }
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    req.write(body);
    req.end();
  });
}

/** 非流式：聚合 SSE 成一个 chat.completion */
/**
 * usage 缓存字段归一化（2026-10-30，对齐 qoder2api-hub #112）。
 *
 * 上游按模型族把缓存命中放在不同字段：DeepSeek 用 `prompt_cache_hit_tokens`、
 * Qwen 用 `completion_tokens_details.cached_tokens`——按 OpenAI 标准协议解析
 * 的客户端读 `usage.prompt_tokens_details.cached_tokens` 恒为 0。把数字搬到
 * 标准位，**原字段保留**（已适配上游形态的客户端不受影响）。上游完全没给
 * 缓存时不凭空造字段。返回是否发生过改写（调用方据此决定要不要重新序列化）。
 */
// 归一化实现提升到 src/usage-norm.js（千问通道同缺口同修，见该文件头注释）。

function aggregate(payloads, model) {
  let content = '';
  let reasoning = '';
  let finish = 'stop';
  let usage = {};
  let id = 'qoder';
  const created = Math.floor(Date.now() / 1000);
  const calls = new Map();
  for (const p of payloads) {
    try {
      const o = JSON.parse(p);
      if (o.id) id = o.id;
      if (o.usage) usage = o.usage;
      const ch = (o.choices || [{}])[0];
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || ch.message || {};
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
    if (!content) message.content = null;
  }
  normalizeUsageCache(usage);
  return {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: usage || {},
  };
}

/**
 * 最终保留在请求里的标准工具数量（与 buildBody 的过滤口径共用）。
 *
 * 「播报即收尾」修复只对带工具的请求启用——重建判定要用**同一个**过滤口径，
 * 抽出来共用，改过滤规则时不会两边漂移。
 */
function hasFunctionTools(payload) {
  const t = Array.isArray(payload && payload.tools) ? payload.tools : [];
  return t.filter((x) => x && x.type === 'function' && x.function && x.function.name).length;
}

// ---- 官方排队轮询协议（2026-10-30，qoder2api-hub 文档 7.1 的逆向结论）----
//
// 官方客户端被 10605（isQueued:true）拒绝后**不结束请求**，而是带着同一个
// requestSetId 轮询 GET /api/v2/service/ask/queue/status，每轮先睡
// retryAfterSeconds；isQueued===false 才继续真正的推理请求，连续 3 次轮询
// 失败才判致命，总等待默认 60 分钟。queue/status 的响应形状没有官方文档，
// 这里按防御式解析：认得出的字段（isQueued / serviceAvailable /
// retryAfterSeconds / waitTime / 10605）就用，认不出一律 unknown——
// 调用方对 unknown 的处置是「退化为盲等重发」（hub 验证过的形态），
// 端点不存在/鉴权不通都不会影响主流程。

/** 排队状态解析。返回 { state: 'released'|'queued'|'unknown', retryAfterMs } */
function parseQueueStatus(raw) {
  const s = String(raw == null ? '' : raw).replace(/\\+"/g, '"').replace(/\\+/g, '');
  if (/"isQueued"\s*:\s*false/i.test(s)) return { state: 'released', retryAfterMs: 0 };
  if (/"isQueued"\s*:\s*true/i.test(s) || /10605/.test(s)) {
    const ms = throttleRetryMs(s);
    return { state: 'queued', retryAfterMs: Number.isFinite(ms) && ms > 0 ? ms : 0 };
  }
  return { state: 'unknown', retryAfterMs: 0 };
}

/**
 * 查一次排队状态（best-effort）。永不 reject——网络错/非 200 都按 unknown 返回。
 * @param {string} origin 推理请求实际用到的主机 origin（队列跟着主机走）
 * @param {object} headers cosy.buildHeaders 的产物（body 传空串签名）
 */
function getQueueStatus(origin, headers, { modelKey, queueType, requestId, agent }) {
  const path = `/algo/api/v2/service/ask/queue/status?requestSetId=${encodeURIComponent(requestId)}`
    + `&modelKey=${encodeURIComponent(modelKey)}&queueType=${encodeURIComponent(queueType || 'p3')}`;
  return new Promise((resolve) => {
    let u;
    try { u = new URL(origin); } catch (e) { return resolve(null); }
    const req = https.request({
      hostname: u.hostname,
      path,
      method: 'GET',
      headers: { ...headers, Host: u.hostname },
      timeout: 8000,
      ...(agent ? { agent } : {}),
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { if (buf.length < 65536) buf += c; });
      res.on('end', () => resolve(res.statusCode === 200 ? parseQueueStatus(buf) : null));
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

module.exports = {
  buildBody, hasFunctionTools, resolveModelKey, unwrap, envelopeStatus, payloadError,
  post, postStream, aggregate, withAgentDiscipline, resolveReasoningEffort,
  getQueueStatus, parseQueueStatus, normalizeUsageCache,
};
