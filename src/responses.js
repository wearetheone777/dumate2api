// dumate2api - OpenAI Responses API (/v1/responses) -> Chat Completions 适配层
//
// Codex CLI 0.155+ 只认 `wire_api = "responses"`（`chat` 已被移除），
// 所以代理必须自己提供 /v1/responses，把它翻译成上游唯一的
// /chat/completions 调用。
//
// 覆盖范围：
//   - 请求：instructions / input(字符串或 item 数组) / tools(function|local_shell)
//           / tool_choice / max_output_tokens / temperature / top_p / stream
//   - 响应：非流式 responses 对象，流式则翻译成 Responses 的语义事件序列
//     (response.created / output_item.added / output_text.delta /
//      function_call_arguments.delta / response.completed ...)
//
// 明确不支持的字段（静默忽略并记一条日志）：
//   - previous_response_id / store（上游无状态，靠 Codex 自己回传完整 input）
//   - reasoning 配置、include、text.format(json_schema) 等
//
// 注意：本模块**不做**模型映射与预算兜底——两者都要按通道决定，
// 由 server.js 在 router.resolve 之后处理（见 responsesToOpenAI 的注释）。

const { markFirstToken } = require('./reqlog');

// ---------- 请求侧 ----------

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => {
      if (typeof p === 'string') return p;
      if (!p || typeof p !== 'object') return '';
      if (typeof p.text === 'string') return p.text;
      // input_text / output_text / 其它带 text 字段的块
      if (p.type === 'input_image' || p.type === 'image_url') {
        return '[Image content - not supported by DuMate backend]';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

// Responses 的 function 工具 -> Chat Completions 的 function 工具
function convertTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'function') {
      const fn = t.function || t; // 两种形状都接受
      if (!fn.name) continue;
      out.push({
        type: 'function',
        function: {
          name: fn.name,
          description: fn.description || '',
          parameters: fn.parameters || { type: 'object', properties: {} },
        },
      });
    } else if (t.type === 'local_shell') {
      // Codex 的本地 shell 工具在上游没有对应实现，跳过（由 Codex 侧 fallback 处理）
      continue;
    }
  }
  return out.length ? out : null;
}

// Responses input -> Chat Completions messages
function inputToMessages(body) {
  const messages = [];

  const instructions = body.instructions;
  if (typeof instructions === 'string' && instructions.trim()) {
    messages.push({ role: 'system', content: instructions });
  }

  const input = body.input;
  if (typeof input === 'string') {
    if (input.trim()) messages.push({ role: 'user', content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  // function_call 的 arguments 是分片到达的，按 call_id 聚合后再落到 tool_calls
  const pendingCalls = new Map();

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;

    switch (item.type) {
      case 'message':
      case undefined: {
        const role = item.role === 'assistant' ? 'assistant'
          : (item.role === 'system' || item.role === 'developer') ? 'system' : 'user';
        const text = textFromContent(item.content);
        if (!text) break;
        if (role === 'system') messages.push({ role: 'system', content: text });
        else messages.push({ role, content: text });
        break;
      }
      case 'function_call': {
        const id = item.call_id || item.id || ('call_' + Math.random().toString(36).slice(2, 10));
        pendingCalls.set(id, {
          id,
          type: 'function',
          function: { name: item.name || '', arguments: item.arguments || '{}' },
        });
        break;
      }
      case 'function_call_output': {
        const id = item.call_id || item.id || '';
        // 先把已聚合的 tool_calls 落到一条 assistant 消息里
        if (pendingCalls.size) {
          messages.push({ role: 'assistant', content: null, tool_calls: [...pendingCalls.values()] });
          pendingCalls.clear();
        }
        const out = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
        messages.push({ role: 'tool', tool_call_id: id, content: out });
        break;
      }
      // reasoning / local_shell_call 等：上游不认，直接丢弃
      default:
        break;
    }
  }

  if (pendingCalls.size) {
    messages.push({ role: 'assistant', content: null, tool_calls: [...pendingCalls.values()] });
  }

  return messages;
}

function responsesToOpenAI(body, stream) {
  const messages = inputToMessages(body);
  const tools = convertTools(body.tools);

  const req = {
    // **不要在这里 mapModel**：模型名要先经 upstream-router 按前缀分流，
    // 分流之后再按通道决定是否映射。曾经在这里先映射，`qwen/flash` 被
    // 兜底成 `model-text`，前缀被抹掉，路由只能落到搭子——
    // 表现为「cc-switch 切到千问，实际跑的是搭子模型」。
    // 与 chat/completions 路径保持同一顺序：先 resolve，后 map。
    model: body.model || 'model-text',
    messages,
    // 预算同理：不在这里兜底，交给 server.js 按通道决定下限
    // （千问 4096 / 搭子 32768）。这里先应用会按搭子的下限抬高，
    // 之后千问再走自己的下限就失效了。
    max_tokens: body.max_output_tokens,
    stream: !!stream,
  };
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  // Codex 的思考强度（Responses 请求顶层 reasoning.effort）。此前整体丢弃——
  // 用户在 Codex 里调 model_reasoning_effort 完全无效且无感。直连通道（Qoder）
  // 会按模型合法档归一化后下发；其他通道不认识这个键，自然忽略。
  if (body.reasoning && body.reasoning.effort != null) {
    req.reasoning_effort = String(body.reasoning.effort);
  }
  if (tools) req.tools = tools;

  const choice = body.tool_choice;
  if (choice === 'auto' || choice === 'none' || choice === 'required') {
    req.tool_choice = choice;
  } else if (choice && typeof choice === 'object' && choice.name) {
    req.tool_choice = { type: 'function', function: { name: choice.name } };
  }

  return req;
}

// ---------- 响应侧 ----------

function newResponseId() {
  return 'resp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/**
 * 工具调用的参数是不是**被截断的半截 JSON**？
 *
 * 千问上游在「一次写多章」这类长任务里，实测会出现 `finish_reason=length`
 * 时 arguments 停在半句（例：`{"cmd": "... @('第三章　第七户','',`，字符串都没闭合）。
 * 网关若把它当正常工具调用交给 Codex，Codex 会**执行一条语法残缺的命令**——
 * 命令必然失败，模型看到失败后往往直接收尾「下一步：写入第 3 章」就结束回合，
 * 用户看到的就是「没做完就退出」。所以这种参数必须判成不完整。
 *
 * 判据：JSON 解析失败，或解析出来不是对象/数组。
 * 注意 arguments 为空串是**合法**的（无参工具，OpenAI 规范允许），不能判成截断。
 */
function truncatedArguments(args) {
  const s = String(args == null ? '' : args).trim();
  if (!s) return false;
  try {
    const v = JSON.parse(s);
    return !v || typeof v !== 'object';
  } catch (e) {
    return true;
  }
}

function usageFrom(openaiUsage) {
  const u = openaiUsage || {};
  return {
    input_tokens: u.prompt_tokens || 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: u.completion_tokens || 0,
    output_tokens_details: { reasoning_tokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0 },
    total_tokens: u.total_tokens || 0,
  };
}

// 非流式：OpenAI 响应 -> Responses 对象
function openAIToResponse(openaiResp, model) {
  const choice = (openaiResp.choices && openaiResp.choices[0]) || {};
  const msg = choice.message || {};
  const output = [];

  // reasoning -> reasoning item（Codex 会把它当思考过程展示）
  if (msg.reasoning_content) {
    output.push({
      type: 'reasoning',
      id: 'rs_' + Math.random().toString(36).slice(2, 10),
      summary: [{ type: 'summary_text', text: msg.reasoning_content }],
    });
  }

  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: 'function_call',
        id: 'fc_' + Math.random().toString(36).slice(2, 10),
        call_id: tc.id || '',
        name: (tc.function && tc.function.name) || '',
        arguments: (tc.function && tc.function.arguments) || '{}',
        status: 'completed',
      });
    }
  }

  if (msg.content) {
    output.push({
      type: 'message',
      id: 'msg_' + Math.random().toString(36).slice(2, 10),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: msg.content, annotations: [], logprobs: [] }],
    });
  }

  return {
    id: openaiResp.id || newResponseId(),
    object: 'response',
    created_at: openaiResp.created || Math.floor(Date.now() / 1000),
    status: 'completed',
    model: model || openaiResp.model || 'model-text',
    output,
    output_text: msg.content || '',
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: usageFrom(openaiResp.usage),
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    temperature: null,
    top_p: null,
  };
}

// 流式：OpenAI SSE -> Responses SSE
function translateStreamToResponses(upstreamRes, res, model, onDone) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    ...(res._cors || {}),
  });

  // 收尾时把最终 usage 交回调用方做埋点；两条收尾路径都要走一次
  let finished = false;
  const finish = (status, extra) => {
    if (finished) return;
    finished = true;
    if (onDone) {
      const u = usage ? usageFrom(usage) : { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
      onDone(
        { input: u.input_tokens || 0, output: u.output_tokens || 0, total: u.total_tokens || 0 },
        status,
        extra,
      );
    }
  };

  const responseId = newResponseId();
  const createdAt = Math.floor(Date.now() / 1000);
  // 流一旦结束就不能再写：实测响应发完 response.completed 并 res.end() 后，
  // 收尾逻辑仍尝试补发 reasoning 的 done，触发 ERR_STREAM_WRITE_AFTER_END
  // ——这是**未捕获的 error 事件，会直接把网关进程打挂**（9082 整个退出）。
  // 所以 send 必须自带守卫，写不动就静默跳过。
  let ended = false;
  const send = (type, payload) => {
    if (ended || res.writableEnded || res.destroyed) return;
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch (e) { /* 写失败不打断收尾 */ }
  };
  const baseResponse = (status, output) => ({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    model: model || 'model-text',
    output: output || [],
    output_text: '',
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: null,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    temperature: null,
    top_p: null,
  });

  let buffer = '';
  // StringDecoder：跨 chunk 的多字节汉字不能逐块解码，否则出现 U+FFFD
  const { StringDecoder } = require('string_decoder');
  const decoder = new StringDecoder('utf8');
  let seq = 0;
  let textItemId = null;
  let textOutputIndex = -1;
  let fullText = '';
  let reasoningItemId = null;
  let reasoningOutputIndex = -1;
  let fullReasoning = '';
  const callItems = new Map(); // tool_call index -> { id, itemId, name, args, outputIndex }
  let usage = null;
  let finishReason = null;
  let nextOutputIndex = 0;

  send('response.created', { type: 'response.created', sequence_number: seq++, response: baseResponse('in_progress') });
  send('response.in_progress', { type: 'response.in_progress', sequence_number: seq++, response: baseResponse('in_progress') });

  const closeTextItem = () => {
    if (textItemId) {
      send('response.output_text.done', {
        type: 'response.output_text.done', sequence_number: seq++, item_id: textItemId,
        output_index: textOutputIndex, content_index: 0, text: fullText,
      });
      send('response.output_item.done', {
        type: 'response.output_item.done', sequence_number: seq++, output_index: textOutputIndex,
        item: { type: 'message', id: textItemId, status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: fullText, annotations: [], logprobs: [] }] },
      });
      textItemId = null;
    }
  };

  upstreamRes.on('data', (chunk) => {
    // 首个上游字节到达即记首字。必须在这里而不是 send() 里：response.created
    // 是本函数**自己**造的事件，紧接着就发出去了，拿它算首字等于只量了
    // 上游的排队时间以外的部分。要的是「上游开始回话」这一刻。
    markFirstToken(res);
    buffer += decoder.write(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.substring(6).trim();
      if (dataStr === '[DONE]') continue;

      let cj;
      try { cj = JSON.parse(dataStr); } catch { continue; }

      if (cj.usage) usage = cj.usage;
      const choice = cj.choices && cj.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;

      // reasoning 增量
      if (delta.reasoning_content) {
        if (!reasoningItemId) {
          reasoningItemId = 'rs_' + Math.random().toString(36).slice(2, 10);
          reasoningOutputIndex = nextOutputIndex++;
          send('response.output_item.added', {
            type: 'response.output_item.added', sequence_number: seq++, output_index: reasoningOutputIndex,
            item: { type: 'reasoning', id: reasoningItemId, summary: [] },
          });
        }
        fullReasoning += delta.reasoning_content;
        send('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta', sequence_number: seq++,
          item_id: reasoningItemId, output_index: reasoningOutputIndex, summary_index: 0,
          delta: delta.reasoning_content,
        });
      }

      // 工具调用增量
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index != null ? tc.index : 0;
          let entry = callItems.get(idx);
          if (!entry) {
            // **先关掉 reasoning item 再开 function_call**。两者是并列的
            // output item，reasoning 的 done 若拖到流末尾才发，Codex 会看到
            // 「function_call 的 arguments.done 之前先来了一个 output_item.done」，
            // 于是报 `failed to parse function arguments: trailing characters`
            // ——工具调用直接失败，表现为模型反复重试、任务卡死。
            closeReasoningLater();
            entry = { id: tc.id || ('call_' + Math.random().toString(36).slice(2, 10)),
              itemId: 'fc_' + Math.random().toString(36).slice(2, 10),
              name: (tc.function && tc.function.name) || '', args: '', outputIndex: nextOutputIndex++ };
            callItems.set(idx, entry);
            send('response.output_item.added', {
              type: 'response.output_item.added', sequence_number: seq++, output_index: entry.outputIndex,
              item: { type: 'function_call', id: entry.itemId, call_id: entry.id,
                name: entry.name, arguments: '', status: 'in_progress' },
            });
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function && tc.function.name) entry.name = tc.function.name;
          const argDelta = (tc.function && tc.function.arguments) || '';
          if (argDelta) {
            entry.args += argDelta;
            send('response.function_call_arguments.delta', {
              type: 'response.function_call_arguments.delta', sequence_number: seq++,
              item_id: entry.itemId, output_index: entry.outputIndex, delta: argDelta,
            });
          }
        }
      }

      // 正文增量
      if (delta.content) {
        if (!textItemId) {
          closeReasoningLater();
          textItemId = 'msg_' + Math.random().toString(36).slice(2, 10);
          textOutputIndex = nextOutputIndex++;
          send('response.output_item.added', {
            type: 'response.output_item.added', sequence_number: seq++, output_index: textOutputIndex,
            item: { type: 'message', id: textItemId, status: 'in_progress', role: 'assistant', content: [] },
          });
          send('response.content_part.added', {
            type: 'response.content_part.added', sequence_number: seq++, item_id: textItemId,
            output_index: textOutputIndex, content_index: 0,
            part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
          });
        }
        fullText += delta.content;
        send('response.output_text.delta', {
          type: 'response.output_text.delta', sequence_number: seq++, item_id: textItemId,
          output_index: textOutputIndex, content_index: 0, delta: delta.content, logprobs: [],
        });
      }
    }
  });

  let reasoningClosed = false;
  function closeReasoningLater() {
    if (reasoningItemId && !reasoningClosed) {
      reasoningClosed = true;
      send('response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done', sequence_number: seq++, item_id: reasoningItemId,
        output_index: reasoningOutputIndex, summary_index: 0, text: fullReasoning,
      });
      send('response.output_item.done', {
        type: 'response.output_item.done', sequence_number: seq++, output_index: reasoningOutputIndex,
        item: { type: 'reasoning', id: reasoningItemId, summary: [{ type: 'summary_text', text: fullReasoning }] },
      });
    }
  }

  upstreamRes.on('end', () => {
    closeReasoningLater();
    closeTextItem();

    for (const entry of callItems.values()) {
      send('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done', sequence_number: seq++, item_id: entry.itemId,
        output_index: entry.outputIndex, arguments: entry.args,
      });
      send('response.output_item.done', {
        type: 'response.output_item.done', sequence_number: seq++, output_index: entry.outputIndex,
        item: { type: 'function_call', id: entry.itemId, call_id: entry.id, name: entry.name,
          arguments: entry.args, status: 'completed' },
      });
    }

    // 截断判定：`length` 是上游说「预算用完了」。但实测还见过另一种——
    // 正文为空、reasoning 吃光预算，此时若仍报 completed，Codex 会认为
    // 任务成功结束并停止等待，用户看到的是「完成了但没内容」，
    // 比明说 incomplete 更难排查。所以两种都标 incomplete。
    const hitLength = finishReason === 'length';
    // 「空正文但被截断」原本只排除 `stop`，于是把 `tool_calls` 也算了进来——
    // 而纯工具调用轮次**本来就没有正文**（模型直接调工具），实测 Codex 里
    // 大量轮次都是 finish_reason=tool_calls + 正文 0，那些轮次会被整轮标成
    // incomplete。上游不发 usage 帧时（末帧才带 usage，部分路径拿不到）
    // reasoning 判据也失效，就会真的误报。这里把正常的工具调用收尾排除。
    const emptyButTruncated = !fullText && !!finishReason
      && finishReason !== 'stop' && finishReason !== 'tool_calls';
    // 工具参数被截断：上游在 length 收尾（或中途断流）时把 arguments 停在半句。
    // 实测（Codex「一次写 3 章」）：最后一轮参数停在 `@('第三章　第七户','',`，
    // 网关当正常工具调用发给 Codex，Codex 执行半截命令失败，模型随即放弃任务、
    // 只留一句「下一步：写入第 3 章」——用户看到的就是「没做完就退出」。
    // 标成 incomplete 后客户端至少知道这一轮不可信，不会把它当成任务正常结束。
    const truncatedCall = [...callItems.values()].find((e) => truncatedArguments(e.args));
    const incomplete = hitLength || emptyButTruncated || !!truncatedCall;

    // 思维链失控：整轮预算全部烧在 reasoning 上、正文一个字都没产出。
    // 实测（Codex 写小说，一次 3 章 + 完整项目上下文）：
    //   output=32768 / reasoning=32768 / 正文 0，耗时 7.5 分钟
    // 根因是模型在 reasoning 里做「全景回顾」（逐条罗列全部素材）时停不下来。
    //
    // 这种情形**必须报错而不是 incomplete**：Codex 收到 status=incomplete 会
    // 当成正常收尾（日志里 `model_needs_follow_up=false`），前端什么都不提示，
    // 用户只看到界面卡回「Ask Codex to do anything」——静默失败，最难排查。
    // 发 response.failed 后客户端会明确报错，用户知道要重发，而不是干等。
    const reasoningTokens = (usage && usage.completion_tokens_details
      && usage.completion_tokens_details.reasoning_tokens) || 0;
    const outputTokens = (usage && usage.completion_tokens) || 0;
    const reasoningBurnedAll = !fullText
      && reasoningTokens > 0
      && (hitLength || reasoningTokens >= outputTokens);
    if (reasoningBurnedAll) {
      send('response.failed', {
        type: 'response.failed',
        sequence_number: seq++,
        response: {
          ...baseResponse('failed'),
          output_text: '',
          usage: usageFrom(usage),
          error: {
            code: 'reasoning_budget_exhausted',
            message: '模型把整轮输出预算全部用在思考上，未产出正文。'
              + '请缩小单次任务范围（例如「一次只写一章」）后重试。',
          },
        },
      });
      ended = true;
      res.end();
      finish(502, { error: 'reasoning_budget_exhausted' });
      return;
    }

    send('response.completed', {
      type: 'response.completed',
      sequence_number: seq++,
      response: {
        ...baseResponse(incomplete ? 'incomplete' : 'completed'),
        output_text: fullText,
        usage: usageFrom(usage),
        incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
      },
    });
    ended = true;
    res.end();
    finish(200, truncatedCall ? { error: 'tool_arguments_truncated' } : undefined);
  });

  // 上游在第一帧之前就失败（限流/额度/网关错）。**必须把真实原因写进
  // response.failed.error.message**：硬编码成 `upstream stream error` 时，
  // Codex 只报一句「上游流错误」，用户看不出是排队限流还是凭证失效，
  // 也没法判断该等 30 秒还是该去管理端换账号。
  // 状态码同样不能写死 502：埋点里全部直连通道的失败都变成 502 就归因不了。
  upstreamRes.on('error', (e) => {
    const msg = String((e && e.message) || 'upstream stream error').slice(0, 500);
    const status = Number(e && e.statusCode) || 502;
    send('response.failed', {
      type: 'response.failed', sequence_number: seq++,
      response: {
        ...baseResponse('failed'),
        error: { code: status === 429 ? 'rate_limit_exceeded' : 'server_error', message: msg },
      },
    });
    ended = true;
    res.end();
    finish(status);
  });
}

module.exports = { responsesToOpenAI, openAIToResponse, translateStreamToResponses, truncatedArguments };
