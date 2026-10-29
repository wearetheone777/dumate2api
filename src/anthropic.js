// dumate2api - Anthropic Messages API -> OpenAI Chat Completions translation layer
//
// ============================================================================
// 两种工具模式，按通道选（2026-10-04 修）
//
//   text（默认，搭子用）：上游不支持 function calling，工具调用降级为纯文本
//     （`[Tool Use: 名字]` / `[Tool Result]`）。这是能力边界，不是缺陷。
//
//   native（三条直连通道用）：把 Anthropic 的 tools / tool_use / tool_result
//     真正转成 OpenAI 形状发上去。**必须开**，依据是实测对照：
//
//       同一模型（TRAE Doubao-Seed-Evolving）、同一 prompt、同一套 tools：
//         直连上游（只过 buildBody）→ 结构化 tool_calls
//             `{"name":"Glob","arguments":"{\"pattern\": \"**/*.md\"}"}`
//         经本文件的文本降级路径 → 模型收不到工具定义，正文里吐文本式
//             `<seed:tool_call><function name="Glob">…`（逐字分片到达）
//     客户端（Claude Code）收到的是普通文本、没有 tool_use 块，于是判定回合
//     正常结束——表现为「很快就输出、任务没做」。**不是上游不支持，是这里丢了 tools。**
//
//   Codex 走 /v1/responses，那条路径的 responses.js 一直有 convertTools，
//   所以「Codex 用 TRAE 能用工具」掩盖了本文件的问题：两条路径不是同一套代码。
// ============================================================================
const { resolveMaxTokens } = require('./budget');
const modelmap = require('./modelmap');

// 模型映射已抽到 modelmap.js（可经管理端编辑，落 data/model-map.json）。
// 这里保留 MODEL_MAP 导出以兼容既有引用，值是默认表。
const MODEL_MAP = modelmap.DEFAULT_ALIASES;

function mapModel(name) {
  return modelmap.mapModel(name);
}

/** Anthropic 工具定义 → OpenAI tools。形状不对的整条丢弃（不是整轮失败） */
function convertTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    // 两种形状都接受：Anthropic 原生（name/input_schema）与已被转过的 OpenAI 形状
    const name = t.name || (t.function && t.function.name) || '';
    if (!String(name).trim()) continue;
    out.push({
      type: 'function',
      function: {
        name: String(name),
        description: t.description || (t.function && t.function.description) || '',
        parameters: t.input_schema || t.parameters || { type: 'object', properties: {} },
      },
    });
  }
  return out.length ? out : null;
}

/**
 * Anthropic tool_choice → OpenAI tool_choice。
 * 对应关系：auto→auto、any→required、tool→指定函数、none→none。
 * 认不出来就不传（宁可让上游按默认走，也不传一个它不认的值）。
 */
function convertToolChoice(tc) {
  if (tc == null) return null;
  if (typeof tc === 'string') {
    const s = tc.toLowerCase();
    if (s === 'auto' || s === 'none') return s;
    if (s === 'any') return 'required';
    return null;
  }
  if (typeof tc === 'object') {
    const t = String(tc.type || '').toLowerCase();
    if (t === 'auto' || t === 'none') return t;
    if (t === 'any') return 'required';
    if (t === 'tool') {
      const n = tc.name || (tc.function && tc.function.name) || '';
      if (String(n).trim()) return { type: 'function', function: { name: String(n) } };
    }
  }
  return null;
}

/**
 * tool_use 的 input：Anthropic 要求是对象。
 * 解析失败（上游把参数截断在半句 JSON）时**不编一个空对象**——空对象会让客户端
 * 执行一个参数缺失的工具调用，失败原因看起来像模型的错。把原始串如实带出去，
 * 排查时能直接看到它断在哪里（与 responses.js 的 truncatedArguments 同口径）。
 */
function parseToolInput(args) {
  const s = String(args == null ? '' : args).trim();
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : { value: v };
  } catch (e) {
    return { _raw_arguments: s };
  }
}

function blockText(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  if (typeof block.text === 'string') return block.text;
  return '';
}

function toolResultText(block) {
  const c = block && block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => blockText(x)).filter(Boolean).join('\n');
  return '';
}

// Convert Anthropic Messages request to OpenAI Chat Completions request
//
// opts.nativeTools=true 时才转发结构化工具（直连通道）；默认 false = 旧的文本降级。
function anthropicToOpenAI(anthropicReq, opts = {}) {
  const native = opts.nativeTools === true;
  const messages = [];

  // System prompt
  if (anthropicReq.system) {
    const sysContent = typeof anthropicReq.system === 'string'
      ? anthropicReq.system
      : anthropicReq.system.map(b => (typeof b === 'string' ? b : b.text || '')).join('\n');
    if (sysContent) messages.push({ role: 'system', content: sysContent });
  }

  // Messages
  for (const msg of (anthropicReq.messages || [])) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;

    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    if (!native) {
      // ---- 文本降级（搭子）----
      const parts = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          parts.push({ type: 'text', text: `[Tool Use: ${block.name}]\n${JSON.stringify(block.input)}` });
        } else if (block.type === 'tool_result') {
          parts.push({ type: 'text', text: `[Tool Result]\n${toolResultText(block)}` });
        } else if (block.type === 'image') {
          parts.push({ type: 'text', text: '[Image content - not supported by DuMate backend]' });
        }
      }
      messages.push({ role: msg.role, content: parts.map(p => p.text).join('\n') });
      continue;
    }

    // ---- 结构化（直连通道）----
    const texts = [];
    const toolUses = [];
    const toolResults = [];
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') texts.push(block.text || '');
      else if (block.type === 'tool_use') toolUses.push(block);
      else if (block.type === 'tool_result') toolResults.push(block);
      else if (block.type === 'image') texts.push('[Image content - not supported by DuMate backend]');
      // thinking 块不回传：那是模型自己的思考，上游不需要，回传反而干扰
    }

    if (msg.role === 'assistant') {
      const out = { role: 'assistant', content: texts.filter(Boolean).join('\n') || null };
      if (toolUses.length) {
        out.tool_calls = toolUses.map((b, i) => ({
          id: b.id || `call_${Date.now().toString(36)}${i}`,
          type: 'function',
          function: {
            name: b.name || '',
            arguments: JSON.stringify(b.input == null ? {} : b.input),
          },
        }));
      }
      // 既无正文又无工具调用（例如只有 thinking 块）就整条跳过
      if (out.content == null && !out.tool_calls) continue;
      messages.push(out);
      continue;
    }

    // user：tool_result 必须各自独立成 role:'tool' 消息，且**紧跟在带 tool_calls
    // 的 assistant 消息之后**——中间夹一条 user 文本会让上游报「工具结果没有
    // 对应的调用」。所以先落 tool 消息，再落文本。
    for (const b of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: b.tool_use_id || b.id || '',
        content: toolResultText(b),
      });
    }
    const text = texts.filter(Boolean).join('\n');
    if (text) messages.push({ role: 'user', content: text });
  }

  // 预算统一由 budget.js 判定：客户端值只作参考，reasoning 与正文共用预算，
  // 客户端给的小值会让 reasoning 吃光正文导致空回答 / 半句截断。
  const maxTokens = resolveMaxTokens(anthropicReq.max_tokens);

  const openaiReq = {
    // **不要在这里 mapModel**：模型名必须先经 upstream-router 按前缀分流
    // （`qwen/` / `traework/` / `qoder/`）。提前过搭子的别名表会把带前缀的名字
    // 兜底成 `model-text`，斜杠随之消失，下游 resolve() 就只能判成搭子通道——
    // 请求返回 200，但回答来自完全不同的模型，客户端无从察觉。
    // 映射统一在 server.js 的 needsModelMap 分支里做，与 responses.js 同口径。
    model: anthropicReq.model || 'model-text',
    messages: messages,
    max_tokens: maxTokens,
    temperature: anthropicReq.temperature,
    top_p: anthropicReq.top_p,
    stream: anthropicReq.stream || false,
  };

  if (anthropicReq.stop_sequences) {
    openaiReq.stop = anthropicReq.stop_sequences;
  }

  // 工具只在 native 模式转发。tools 为空时连 tool_choice 一起不带——
  // 有些上游见到 tool_choice 但没有 tools 会直接 400。
  if (native) {
    const tools = convertTools(anthropicReq.tools);
    if (tools) {
      openaiReq.tools = tools;
      const choice = convertToolChoice(anthropicReq.tool_choice);
      if (choice) openaiReq.tool_choice = choice;
    }
  }

  // 思考强度透传（2026-10-30，口径对齐 qoder2api-hub 的归一化表）。
  // Claude Code 实测发 thinking={"type":"adaptive"} + output_config.effort；
  // 也有显式 thinking.budget_tokens 的客户端，按区间映射（≤1024 minimal /
  // ≤4096 low / ≤16384 medium / ≤32768 high / 更大 max）。disabled → 不下发，
  // 直连通道按各自模型默认处理。其他通道（搭子/千问/TRAE）构造 parameters
  // 时只挑认识的键，这个字段自然被忽略，无副作用。
  const effort = anthropicEffort(anthropicReq);
  if (effort) openaiReq.reasoning_effort = effort;

  return openaiReq;
}

/** 从 Anthropic 请求取思考强度：output_config.effort → thinking.effort → budget_tokens 区间 */
function anthropicEffort(req) {
  const t = req.thinking;
  if (t && t.type === 'disabled') return '';
  const direct = (req.output_config && req.output_config.effort) || (t && t.effort) || '';
  if (direct) return String(direct).trim().toLowerCase();
  const budget = t ? Number(t.budget_tokens) : NaN;
  if (Number.isFinite(budget) && budget > 0) {
    if (budget <= 1024) return 'minimal';
    if (budget <= 4096) return 'low';
    if (budget <= 16384) return 'medium';
    if (budget <= 32768) return 'high';
    return 'max';
  }
  return '';
}

// Convert OpenAI Chat Completions response to Anthropic Messages response
function openAIToAnthropic(openaiResp, originalModel) {
  const choice = openaiResp.choices && openaiResp.choices[0];
  const message = choice ? choice.message : {};
  const content = [];

  // Reasoning content -> thinking block
  if (message.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content });
  }

  // Main content
  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }

  // 工具调用 -> tool_use 块。**顺序在正文之后**：模型先说话再调工具是常态，
  // 反过来把 tool_use 放前面会让客户端以为模型什么都没说。
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const tc of toolCalls) {
    const fn = tc.function || tc;
    content.push({
      type: 'tool_use',
      id: tc.id || ('toolu_' + Math.random().toString(36).slice(2, 10)),
      name: fn.name || '',
      input: parseToolInput(fn.arguments),
    });
  }

  // 有工具调用时 stop_reason 必须是 tool_use（Anthropic 规范）。
  // **不能只看上游的 finish_reason**：实测 TRAE 在给了 tool_calls 的同时
  // 报的是 `stop`，照搬会翻成 `end_turn`——Claude Code 看到 end_turn 会认为
  // 回合结束、**不去执行工具**，于是「模型说要调工具但什么都没发生」。
  const stopReason = toolCalls.length ? 'tool_use' : mapFinishReason(choice ? choice.finish_reason : null);

  const anthropicResp = {
    id: openaiResp.id || ('msg_' + Date.now()),
    type: 'message',
    role: 'assistant',
    model: originalModel || 'claude-3-5-sonnet-20241022',
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage ? openaiResp.usage.prompt_tokens : 0,
      output_tokens: openaiResp.usage ? openaiResp.usage.completion_tokens : 0,
    },
  };

  return anthropicResp;
}

function mapFinishReason(reason) {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

module.exports = {
  MODEL_MAP,
  mapModel,
  anthropicToOpenAI,
  openAIToAnthropic,
  mapFinishReason,
  convertTools,
  convertToolChoice,
  parseToolInput,
};
