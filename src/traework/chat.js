// src/traework/chat.js - 对话（llm_utils_chat）与 SSE 解析
//
// 与 OpenAI 的差异（参考 traework2api 的 PrepareBody，逐条对齐）：
//   1. content 必须是**数组** [{type:'text',text:...}]，字符串上游不认
//   2. 必须带 function:"solo_work_lite"，否则上游拒
//   3. model 同时写进 config_name 与 model 两个字段
//   4. stream 强制 true（上游只走 SSE，非流式由我们聚合）
//   5. tools[].function.parameters 上游是 **string 类型**（OpenAI 标准是 object），
//      要把对象序列化成 JSON 字符串
//   6. tool_choice 上游只认字符串（"auto"/"required"/函数名），对象要归一化
//   7. assistant 回传的 tool_calls 要改成 function_call 形状
const https = require('https');
const c = require('./constants');
const { soloHeaders } = require('./headers');

/**
 * 执行纪律——与 src/qwenwork/chat.js 同一份文本、同一个判定口径
 * （只注入「最终确实带工具」的请求；幂等；`DUMATE_TRAEWORK_AGENT_DISCIPLINE=0` 关闭）。
 * TRAE 同样实测踩过「播报即收尾」：模型输出一条进度汇报（不含工具调用）就
 * 结束回合，Codex 判定任务完成退出（2026-10-03，139-141 续写在 15% 处收工）。
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
  if (process.env.DUMATE_TRAEWORK_AGENT_DISCIPLINE === '0') return system;
  if (String(system || '').includes('【执行纪律')) return system; // 幂等：重试/多次构造不重复注入
  return String(system || '') + AGENT_DISCIPLINE;
}

/** 把 OpenAI 请求体改写成 SOLO 的形状。meta（可选）会被填入过滤后的工具数量 */
function buildBody(payload, model, meta) {
  const obj = JSON.parse(JSON.stringify(payload || {}));
  obj.stream = true;
  obj.function = c.FUNCTION;

  const modelName = String(model || obj.model || c.DEFAULT_MODEL).trim() || c.DEFAULT_MODEL;
  obj.model = modelName;
  obj.config_name = modelName;

  // messages：content 字符串 → 数组；assistant 的 tool_calls → function_call
  if (Array.isArray(obj.messages)) {
    for (const m of obj.messages) {
      if (!m || typeof m !== 'object') continue;
      // 图像只属于 user 消息（OpenAI/Anthropic 规范如此）。历史里的
      // assistant/tool 图像 part 剥掉——上游对非 user 图像的行为未知，
      // 不给它赌的机会。user 的 image_url part 原样透传（实测上游接受，
      // 2026-10-30 真机：纯红色 PNG → 模型答「红色」）
      if (m.role !== 'user' && Array.isArray(m.content)) {
        const kept = m.content.filter((p) => !(p && typeof p === 'object'
          && (p.type === 'image_url' || p.type === 'input_image')));
        if (kept.length !== m.content.length) m.content = kept;
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        const kept = [];
        for (const tc of m.tool_calls) {
          if (!tc || typeof tc !== 'object') continue;
          if (tc.function && !tc.function_call) {
            tc.function_call = tc.function;
            delete tc.function;
          }
          const name = tc.function_call && tc.function_call.name;
          // 上游要求 FunctionCall.Name 必填，无 name 的整条剔除
          if (!name || !String(name).trim()) continue;
          kept.push(tc);
        }
        if (kept.length) m.tool_calls = kept; else delete m.tool_calls;
      }
      if (m.content == null) continue;
      if (typeof m.content === 'string') {
        m.content = [{ type: 'text', text: m.content }];
      }
      // 已是数组则透传
    }
  }

  // tools：parameters 对象 → JSON 字符串；非 function 形状剔除
  if (Array.isArray(obj.tools)) {
    const out = [];
    for (const t of obj.tools) {
      if (!t || typeof t !== 'object') continue;
      if (t.type !== 'function' || !t.function || !t.function.name) continue;
      const fn = { ...t.function };
      if (fn.parameters && typeof fn.parameters === 'object') {
        fn.parameters = JSON.stringify(fn.parameters);
      }
      out.push({ type: 'function', function: fn });
    }
    if (out.length) obj.tools = out; else delete obj.tools;
  }

  // tool_choice：上游只认字符串
  const tc = obj.tool_choice;
  if (tc != null) {
    if (typeof tc === 'string') {
      if (tc.toLowerCase() === 'none') { delete obj.tool_choice; delete obj.tools; }
      // auto / required 原样保留
    } else if (typeof tc === 'object') {
      const typ = String(tc.type || '').toLowerCase();
      if (typ === 'none') { delete obj.tool_choice; delete obj.tools; }
      else if (typ === 'auto' || typ === 'required') obj.tool_choice = typ;
      else if (typ === 'function') {
        const n = (tc.function && tc.function.name) || tc.name || '';
        obj.tool_choice = String(n).trim() || 'auto';
      } else delete obj.tool_choice;
    } else delete obj.tool_choice;
  }

  // 补执行纪律。判定口径与千问一致：按「过滤后是否真的还有工具」决定，
  // 纯对话请求注入反而干扰正常回答。system 权威来源在 messages 里
  // （与千问同因：上游/客户端都按 messages 走），所以直接改写首条 system。
  if (Array.isArray(obj.tools) && obj.tools.length && Array.isArray(obj.messages)) {
    let sys = obj.messages.find((m) => m && m.role === 'system');
    const asBlocks = (content) => {
      if (Array.isArray(content)) return content;
      return [{ type: 'text', text: content == null ? '' : String(content) }];
    };
    if (!sys) {
      sys = { role: 'system', content: [] };
      obj.messages.unshift(sys);
    }
    sys.content = asBlocks(sys.content);
    const cur = sys.content.map((p) => (p && p.text) || '').join('\n');
    const injected = withAgentDiscipline(cur, true);
    if (injected !== cur) sys.content = [{ type: 'text', text: injected }];
  }

  if (meta) meta.toolCount = Array.isArray(obj.tools) ? obj.tools.length : 0;

  return JSON.stringify(obj);
}

/** 发流式请求。返回 { stream, status, raw }。auth 兼作账号记录：出站代理
 *  （E 包接线）按它的 proxy 字段 > 全局 DUMATE_PROXY 解析，null 直连。 */
function postStream(body, auth) {
  return new Promise((resolve) => {
    let agent = null;
    try { agent = require('../proxy-agent').getAgentFor(auth); } catch (e) {
      return resolve({ stream: null, status: 0, error: `出站代理配置错误: ${e.message}` });
    }
    const u = new URL(c.AGENT_HOST + c.EP_CHAT);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: { ...soloHeaders(auth, true), 'Content-Length': Buffer.byteLength(body) },
      // 长流不能设总超时，否则 SSE 会被掐断
      timeout: c.STREAM_TIMEOUT_MS,
      ...(agent ? { agent } : {}),
    }, (res) => resolve({ stream: res, status: res.statusCode }));
    req.on('error', (e) => resolve({ stream: null, status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ stream: null, status: 0, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

/**
 * 从事件里取上游报错。**TRAE 的错误是流里的一个事件，不是 HTTP 状态码**：
 * 模型名不认识时返回 `event:error` + `{"code":4001,"message":"...param is invalid"}`，
 * 而 HTTP 仍是 200。
 *
 * 不判这个会把失败当成「成功的空回答」——客户端拿到 200 + 空正文，
 * 无从察觉；这正是最难排查的那类静默失败。
 *
 * @returns {{code:number, message:string}|null}
 */
function eventError(evt) {
  if (!evt || evt.event !== 'error') return null;
  const d = evt.data || {};
  return {
    code: Number(d.code) || 0,
    message: String(d.message || d.error || '上游返回错误'),
  };
}

/**
 * 解析 TRAE 的 SSE 流。
 *
 * **它不是 OpenAI 格式**，是 `event:xxx\ndata:{...}` 的自定义事件流：
 *   metadata     会话信息（忽略）
 *   timing_cost  性能数据（忽略）
 *   output       正文流 —— {response, reasoning_content, tool_calls, phase}
 *   extra_info   汇总帧（含完整 reasoning，忽略：正文已逐块收到）
 *   token_usage  用量 —— {prompt_tokens, completion_tokens, reasoning_tokens}
 *   done         结束 —— {finish_reason}
 *   error        上游报错 —— {code, message}（HTTP 仍是 200，必须自己判）
 *
 * 注意结束标记是 `event:done`，**不是** `data: [DONE]`。
 * 所以这里不按 OpenAI 的 `data:` 单行协议解析，而是按「事件块」切分。
 *
 * onEvent 回调收到 { event, data }（data 已 JSON 解析）。
 */
async function readStream(stream, onEvent) {
  const { StringDecoder } = require('string_decoder');
  const dec = new StringDecoder('utf8');
  let buf = '';
  return new Promise((resolve, reject) => {
    const flushBlock = (block) => {
      const lines = block.split('\n');
      let event = '';
      const dataLines = [];
      for (const l of lines) {
        if (l.startsWith('event:')) event = l.slice(6).trim();
        else if (l.startsWith('data:')) dataLines.push(l.slice(5).trim());
      }
      if (!event && !dataLines.length) return;
      const raw = dataLines.join('\n');
      let data = null;
      if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { _raw: raw }; } }
      onEvent({ event, data });
    };

    stream.on('data', (chunk) => {
      buf += dec.write(chunk);
      // 事件之间以空行分隔
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (block.trim()) flushBlock(block);
      }
    });
    stream.on('end', () => {
      buf += dec.end();
      if (buf.trim()) flushBlock(buf);
      resolve();
    });
    stream.on('error', reject);
  });
}

/**
 * 归一化一条工具调用增量为 OpenAI 标准形状。
 *
 * **上游的形状不是 OpenAI 的**（实测 2026-10-03）：
 *   首片  {"index":0,"id":"call_xxx","type":"function",
 *          "function_call":{"name":"read_file","arguments":""}}
 *   后续  {"index":0,"id":"","type":"",
 *          "function_call":{"name":"","arguments":"{\"path\":...}"}}
 * 字段叫 **function_call**（OpenAI 是 function），且后续片的名字是空串。
 * 三种形状都兼容（function_call / function / 平铺在 tc 顶层），
 * 空字段省略——消费端（responses/anthropic 翻译器）按「有才覆盖」处理。
 *
 * 流式（toOpenAIChunk）与非流式（aggregate）**必须走同一个归一化**：
 * 只改流式的话，非流式照旧拿到空名字的工具调用（chatlab 试调台全瞎）。
 */
function normalizeToolCall(tc) {
  if (!tc || typeof tc !== 'object') return null;
  const raw = (tc.function_call && typeof tc.function_call === 'object') ? tc.function_call
    : (tc.function && typeof tc.function === 'object') ? tc.function
      : tc;
  const out = { index: tc.index != null ? tc.index : 0, type: 'function', function: {} };
  if (tc.id) out.id = tc.id;
  if (raw && typeof raw === 'object') {
    if (raw.name) out.function.name = String(raw.name);
    if (raw.arguments != null) {
      out.function.arguments = typeof raw.arguments === 'string' ? raw.arguments : JSON.stringify(raw.arguments);
    }
  }
  return out;
}

/** TRAE 的 output 事件 → OpenAI delta 形状（content / reasoning_content / tool_calls） */
function deltaOf(evt) {
  const d = (evt && evt.data) || {};
  const delta = {};
  if (d.response) delta.content = d.response;
  if (d.reasoning_content) delta.reasoning_content = d.reasoning_content;
  if (Array.isArray(d.tool_calls) && d.tool_calls.length) {
    delta.tool_calls = d.tool_calls.map(normalizeToolCall).filter(Boolean);
  }
  return delta;
}

/** 把 TRAE 的 output 事件转成 OpenAI chunk 形状（便于上层统一处理） */
function toOpenAIChunk(evt, model) {
  return {
    id: 'traework',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: deltaOf(evt), finish_reason: null }],
  };
}

// ---------------------------------------------------------------------------
// 「播报即收尾」修复（2026-10-05）
//
// 现象：TRAE 的 Doubao 系模型在**带工具的**请求上有约 20~25% 的概率只输出一条
// 进度播报（「当前进度：8%｜已完成：…｜下一步：读取…」）而不调用任何工具就结束
// 回合。Codex 把「无工具调用的回合」判定成任务完成并退出，用户看到的就是
// 「没按要求做完就退出」。
//
// 实测（同一份真实请求，各跑 5 次，判据＝该轮有没有发出工具调用）：
//   现状                        1/5
//   tool_choice=required        1/4（上游并不真的强制）
//   纪律移到消息末尾            3/4
//   重试时追加「只输出工具调用」 5/5
//   → 提示词层面的加固都不稳定，唯一可靠的是**重试**。
//
// 所以这里做「检测 + 重试」：正文先缓冲住（正文总在工具调用之前、只有几十字，
// 缓冲几乎不增加首字延迟；reasoning 照常直发，用户仍能看到模型在动），等整轮
// 结束再判定。判据是**模型自己说还有下一步**——它既然声明了下一步，回合就不该
// 在这里结束。长正文（>600 字）按真回答处理，不重试。
// ---------------------------------------------------------------------------

/** 重试时追加的修复指令（实测 5/5 触发工具调用） */
const REPAIR_NUDGE = [
  '你上一条回复只输出了一条进度汇报，没有调用任何工具就结束了回合，这是不允许的。',
  '必须立即调用工具继续执行任务：不要输出任何文字，只输出工具调用。',
].join('\n');

/** 正文缓冲上限：超过就转直发（真·长回答不该被扣住等判定） */
const HOLD_CAP = Number(process.env.DUMATE_TRAEWORK_HOLD_CAP || 600);

/** 重试次数上限（0 关闭整个修复） */
const REPAIR_MAX = Number(process.env.DUMATE_TRAEWORK_REPAIR_RETRY == null
  ? 1 : process.env.DUMATE_TRAEWORK_REPAIR_RETRY);

/**
 * 一轮「无工具调用」的回复，是不是「没干活就收工」。
 * @returns {boolean}
 */
function looksUnfinished(text) {
  const t = String(text || '').trim();
  if (!t) return true;                    // 一个字都没吐，等价于没干活
  if (t.length > HOLD_CAP) return false;  // 长文本按真回答处理
  return /下一步|next\s+step/i.test(t);   // 模型自己声明还有下一步
}

/** 在请求体末尾追加修复指令（幂等：已经加过就不再加） */
function withRepairNudge(bodyJson) {
  try {
    const obj = JSON.parse(bodyJson);
    if (!Array.isArray(obj.messages)) return null;
    const last = obj.messages[obj.messages.length - 1];
    const lastText = last && (Array.isArray(last.content)
      ? last.content.map((p) => (p && p.text) || '').join('')
      : String(last.content || ''));
    if (String(lastText).includes(REPAIR_NUDGE)) return bodyJson;
    obj.messages.push({ role: 'user', content: [{ type: 'text', text: REPAIR_NUDGE }] });
    return JSON.stringify(obj);
  } catch (e) { return null; }
}

/**
 * 正文缓冲门。
 *
 * 把一轮上游流「按需缓冲」后转发给下游：
 *   - reasoning_content → 直发（思考过程，缓冲它对判定没有帮助）
 *   - tool_calls        → 先冲刷已缓冲的正文再直发；一出现就说明这轮真在干活
 *   - content           → 先缓冲；超过 HOLD_CAP 或已转直发后直发
 *   - token_usage / done → 暂扣，等整轮结束由 finish() 统一补发
 *
 * @param {function} emit 下游回调（收 OpenAI chunk 的 JSON 字符串）
 * @param {string} model
 * @param {boolean} hold 是否启用缓冲（只有「带工具的请求」才需要）
 */
function createTextGate(emit, model, hold) {
  let pending = '';          // 已收到但还没下发的正文
  let text = '';             // 本轮收到的全部正文（不论有没有下发）
  let live = !hold;          // 是否已转为直发
  let toolCalls = 0;
  const held = [];           // 暂扣的 usage / finish_reason 帧

  const mkChunk = (delta) => JSON.stringify({
    id: 'traework',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
  });
  const flush = () => { if (pending) { emit(mkChunk({ content: pending })); pending = ''; } };

  return {
    onEvent(evt) {
      if (evt.event === 'output') {
        const d = evt.data || {};
        if (d.reasoning_content) emit(mkChunk({ reasoning_content: d.reasoning_content }));
        if (Array.isArray(d.tool_calls) && d.tool_calls.length) {
          const tcs = d.tool_calls.map(normalizeToolCall).filter(Boolean);
          toolCalls += tcs.filter((t) => t.function && t.function.name).length;
          flush();
          live = true;
          emit(mkChunk({ tool_calls: tcs }));
        }
        if (d.response) {
          text += d.response;
          if (live) emit(mkChunk({ content: d.response }));
          else {
            pending += d.response;
            if (pending.length > HOLD_CAP) { live = true; flush(); }
          }
        }
        return;
      }
      if (evt.event === 'token_usage') {
        const d = evt.data || {};
        held.push(JSON.stringify({
          id: 'traework', object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000), model,
          choices: [],
          usage: {
            prompt_tokens: d.prompt_tokens || 0,
            completion_tokens: d.completion_tokens || 0,
            total_tokens: d.total_tokens || 0,
            completion_tokens_details: { reasoning_tokens: d.reasoning_tokens || 0 },
          },
        }));
        return;
      }
      if (evt.event === 'done' && evt.data && evt.data.finish_reason) {
        // 与 aggregate 同一纠正：流里出过工具调用时上游仍报 stop，照搬会把
        // 「执行工具」的信号吞掉（判据见 aggregate 内注释）。
        let fr = evt.data.finish_reason;
        if (fr === 'stop' && toolCalls) fr = 'tool_calls';
        held.push(JSON.stringify({
          id: 'traework', object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, delta: {}, finish_reason: fr }],
        }));
      }
    },
    /** 判定所需的中间状态 */
    result() { return { toolCalls, text, live, pending }; },
    /** 收尾：把还没下发的正文与暂扣的帧补发出去 */
    finish() {
      // DSML 流式兜底（2026-10-30）：整轮零工具调用、正文还没 flush（pending
      // 仍在缓冲里）、且正文带 DSML 块——解析还原成 tool_calls 补发，正文发
      // 剥离后的干净版（pending 置空阻止 flush 发原文）。已 flush（live）的
      // 场景正文出去了收不回，维持现状（不劣化）；reasoning 早已直发不受影响。
      if (!live && toolCalls === 0 && pending && /dsml/i.test(pending)) {
        const parsed = parseDsmlToolCalls(pending);
        if (parsed) {
          pending = '';
          emit(mkChunk({ content: parsed.clean }));
          emit(mkChunk({
            tool_calls: parsed.calls.map((cc, i) => ({
              index: i,
              id: `call_dsml_${Date.now().toString(36)}${i}`,
              type: 'function',
              function: { name: cc.name, arguments: cc.arguments },
            })),
          }));
          held.push(JSON.stringify({
            id: 'traework', object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          }));
        }
      }
      flush(); for (const f of held) emit(f);
    },
  };
}

// ---------------------------------------------------------------------------
// DeepSeek DSML 工具调用回退解析（2026-10-30，融合自 trae2api-hub trae_proxy.py）
//
// 现象：DeepSeek 系模型偶尔把工具调用以**文本标记**写进正文而不是走原生
// tool_calls 增量——形状是 `<dsml:calls>` 包 `<dsml:invoke name="…">` 包
// `<dsml:parameter name="…">`（标签名里 DSML 的位置与分隔符不固定，前缀
// 任意）。客户端拿到的是一段 XML 文本，本轮工具调用不执行。
//
// 处置是**纯兜底**：只在「正文含 DSML 标记且本轮没有任何原生 tool_calls」
// 时才解析——原生工具调用永远优先（真实调用带调用 id 与上游语义，文本
// 解析只是尽力还原），有原生调用时正文里的 DSML 文本原样保留（那可能是
// 模型在讨论格式而不是在调用）。流式路径不解析：正文可能已直发，收不回；
// 非流式（aggregate，含 chatlab 试调台）在聚合出口做，正文全量在手。
// ---------------------------------------------------------------------------

/** `<…DSML…calls>…</…DSML…calls>` 块（DOTALL：块可跨行） */
const DSML_CALLS_RE = /<[^>]*dsml[^>]*calls>([\s\S]*?)<\/[^>]*dsml[^>]*calls>/i;
/** `<…DSML…invoke name="…">…</…DSML…invoke>`（g 必须：exec 循环推进靠它） */
const DSML_INVOKE_RE = /<[^>]*dsml[^>]*invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/[^>]*invoke>/gi;
/** `<…DSML…parameter name="…">…</…DSML…parameter>`（g 同上） */
const DSML_PARAM_RE = /<[^>]*dsml[^>]*parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/[^>]*parameter>/gi;

/**
 * 从正文解析 DSML 工具调用块。
 * @returns {{calls:Array<{name:string,arguments:string}>, clean:string}|null}
 *          null = 没有 DSML 块或块里没有 invoke（正文原样保留）
 */
function parseDsmlToolCalls(text) {
  const s = String(text || '');
  if (!/dsml/i.test(s)) return null;
  const m = DSML_CALLS_RE.exec(s);
  if (!m) return null;
  const calls = [];
  let inv;
  while ((inv = DSML_INVOKE_RE.exec(m[1])) !== null) {
    const params = {};
    let p;
    while ((p = DSML_PARAM_RE.exec(inv[2])) !== null) {
      params[p[1]] = p[2].trim();
    }
    calls.push({ name: inv[1], arguments: JSON.stringify(params) });
  }
  if (!calls.length) return null;
  const clean = (s.slice(0, m.index).trim() + ' ' + s.slice(m.index + m[0].length).trim()).trim();
  return { calls, clean };
}

/**
 * 聚合整轮结果（非流式路径）。
 * 输入是 readStream 收集到的 [{event, data}]。
 */
function aggregate(events, model) {
  let content = '';
  let reasoning = '';
  let finish = 'stop';
  let usage = null;
  let sessionId = '';
  let err = null;
  const calls = new Map();

  for (const e of events) {
    const d = e.data || {};
    if (e.event === 'metadata' && d.session_id) sessionId = d.session_id;
    if (e.event === 'error') err = eventError(e);
    if (e.event === 'output') {
      if (d.response) content += d.response;
      if (d.reasoning_content) reasoning += d.reasoning_content;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const nc = normalizeToolCall(tc);
          if (!nc) continue;
          const i = nc.index != null ? nc.index : calls.size;
          const cur = calls.get(i) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (nc.id) cur.id = nc.id;
          if (nc.function.name) cur.function.name = nc.function.name;
          if (nc.function.arguments) cur.function.arguments += nc.function.arguments;
          calls.set(i, cur);
        }
      }
    }
    if (e.event === 'token_usage') {
      usage = {
        prompt_tokens: d.prompt_tokens || 0,
        completion_tokens: d.completion_tokens || 0,
        total_tokens: d.total_tokens || 0,
        completion_tokens_details: { reasoning_tokens: d.reasoning_tokens || 0 },
      };
    }
    if (e.event === 'done' && d.finish_reason) finish = d.finish_reason;
  }

  // DSML 回退（见 parseDsmlToolCalls 注释）：零原生调用且正文带 DSML 块时
  // 还原成结构化工具调用并从正文剥离；原生调用优先，不碰正文。
  if (!calls.size && content) {
    const parsed = parseDsmlToolCalls(content);
    if (parsed) {
      content = parsed.clean;
      parsed.calls.forEach((c, i) => {
        calls.set(i, {
          id: `call_dsml_${Date.now().toString(36)}${i}`,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        });
      });
    }
  }

  // 上游在给出工具调用的同时 done 帧仍报 `stop`（2026-10-29 实测抓包：
  // tool_calls 增量正常到达，done 是 {"finish_reason":"stop"}）。OpenAI 生态
  // 里 `finish_reason === 'tool_calls'` 是常见的执行判据，照搬会让工具被
  // 当成正常收尾忽略——表现为「模型说要调工具，但什么都没发生」。Anthropic
  // 翻译器两处（流式 sentToolUse / 非流式 openAIToAnthropic）已各自纠正过，
  // 这里在源头归一，OpenAI 直通与非流式聚合一并受益。
  if (calls.size && finish === 'stop') finish = 'tool_calls';

  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.size) {
    message.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    if (!content) message.content = null;
  }
  const out = {
    id: sessionId || 'traework',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: usage || {},
  };
  // 上游报错时抛出去，而不是返回一个空的 200。上层（server.js）会据此回
  // 正经的 4xx，客户端才知道这次没跑成。
  if (err) {
    const e = new Error(`traework ${err.code}: ${err.message}`);
    e.statusCode = err.code >= 400 && err.code < 600 ? err.code : 400;
    e.upstreamCode = err.code;
    throw e;
  }
  return out;
}

module.exports = {
  buildBody, postStream, readStream, toOpenAIChunk, deltaOf, aggregate, eventError, normalizeToolCall,
  createTextGate, looksUnfinished, withRepairNudge, REPAIR_NUDGE, REPAIR_MAX, HOLD_CAP,
  parseDsmlToolCalls,
};
