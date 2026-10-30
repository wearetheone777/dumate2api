// dumate2api - Google Generative Language (v1beta) <-> OpenAI Chat translation
//
// Gemini CLI talks the native Google protocol through GoogleGenAI when
// GOOGLE_GEMINI_BASE_URL is set. DuMate upstream only speaks OpenAI chat
// completions, so this module converts between the two:
//   - generateContent / streamGenerateContent request  -> OpenAI chat request
//   - OpenAI chat response / SSE stream                -> Google response
//
// 模型名走 modelmap.js 这唯一的映射来源，与管理端「模型管理」页共享配置。
// 本模块原先自带第三份映射表：既不知道管理端的改动（改了别名对 /v1beta
// 不生效），未知名字还直接透传——上游只认 model-text / model-artifact-validate
// / glm-5，透传一个 gemini-1.5-pro 只会拿到 404。现在未知名字一律走
// modelmap 的 fallback，与管理端表现一致。

const { resolveMaxTokens } = require('./budget');
const modelmap = require('./modelmap');
const { markFirstToken } = require('./reqlog');
const images = require('./images');

// 回落名由 modelmap 决定，不再在本模块另立一个常量——两处常量必然漂移
const DEFAULT_MODEL = modelmap.DEFAULTS.fallback;

// Gemini CLI 可能配置了通用名，这些名字上游不认，映射到本地可用模型
const GEMINI_TO_DUMATE = {
  'gemini-2.5-pro': 'model-text',
  'gemini-2.5-flash': 'model-text',
  'gemini-3-pro': 'model-text',
  'gemini-3-flash': 'model-text',
  'gemini-3-pro-preview': 'model-text',
  'gemini-pro': 'model-text',
  'gemini-flash': 'model-text',
};

function mapModel(name) {
  if (!name) return modelmap.load().fallback;
  if (GEMINI_TO_DUMATE[name]) return GEMINI_TO_DUMATE[name];
  // 上游原生 ID 原样透传，其余交给统一映射（查不到则回落 fallback）
  return modelmap.mapModel(name);
}

function partsToText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p.text === 'string') return p.text;
      // inlineData 由 partsToImageParts 提取成 image_url part，这里跳过
      if (p && (p.inlineData || p.inline_data)) return '';
      return '';
    })
    .join('\n');
}

// Google inlineData part → OpenAI image_url part（data URI）
function partsToImageParts(parts) {
  const out = [];
  if (!Array.isArray(parts)) return out;
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    const d = p.inlineData || p.inline_data;
    if (d && d.data) {
      const mime = d.mimeType || d.mime_type || 'image/png';
      const part = images.toImageUrlPart(`data:${mime};base64,${d.data}`);
      if (part) out.push(part);
    }
  }
  return out;
}

// Google request -> OpenAI chat request
function googleToOpenAI(googleReq) {
  const messages = [];

  const sys = googleReq.systemInstruction;
  if (sys) {
    const sysText = Array.isArray(sys) ? partsToText(sys) : partsToText(sys.parts);
    if (sysText) messages.push({ role: 'system', content: sysText });
  }

  for (const content of (googleReq.contents || [])) {
    const role = content.role === 'model' ? 'assistant' : 'user';
    const parts = content.parts || [];

    const toolCalls = [];
    const toolResults = [];
    const texts = [];

    for (const p of parts) {
      if (typeof p === 'string') {
        texts.push(p);
      } else if (p && typeof p.text === 'string') {
        texts.push(p.text);
      } else if (p && p.functionCall) {
        toolCalls.push({
          id: p.functionCall.id || ('call_' + Math.random().toString(36).slice(2, 10)),
          type: 'function',
          function: {
            name: p.functionCall.name || '',
            arguments: JSON.stringify(p.functionCall.args || {}),
          },
        });
      } else if (p && p.functionResponse) {
        toolResults.push({
          tool_call_id: p.functionResponse.id || '',
          role: 'tool',
          content: typeof p.functionResponse.response === 'string'
            ? p.functionResponse.response
            : JSON.stringify(p.functionResponse.response || {}),
        });
      }
    }

    if (toolCalls.length) {
      messages.push({ role: 'assistant', content: texts.join('\n') || null, tool_calls: toolCalls });
    } else if (toolResults.length) {
      messages.push(...toolResults);
    } else {
      const text = texts.join('\n');
      // 图像保真（Gemini inlineData → OpenAI image_url）：直连通道认该形状，
      // 压成字符串会把图像丢掉
      const imgs = role === 'user' ? partsToImageParts(parts) : [];
      if (imgs.length) {
        const msgParts = [];
        if (text) msgParts.push({ type: 'text', text });
        msgParts.push(...imgs);
        messages.push({ role, content: msgParts });
      } else if (text) {
        messages.push({ role, content: text });
      }
    }
  }

  const cfg = googleReq.generationConfig || {};
  // 预算统一由 budget.js 判定：reasoning 与正文共用 max_tokens，客户端小值
  // 会让正文被 reasoning 吃光。
  const openaiReq = {
    // **不要在这里 mapModel**：同 anthropic.js——带前缀的模型名（`qwen/` /
    // `traework/`）提前过搭子别名表会被兜底成 `model-text`，前缀丢失后
    // upstream-router 判成搭子通道，静默打到错的模型上。
    // 映射统一在 server.js 的 needsModelMap 分支里做。
    model: googleReq.model || 'model-text',
    messages,
    max_tokens: resolveMaxTokens(cfg.maxOutputTokens || cfg.max_tokens),
    temperature: cfg.temperature,
    top_p: cfg.topP,
    stream: googleReq.stream || false,
  };
  if (Array.isArray(cfg.stopSequences) && cfg.stopSequences.length) {
    openaiReq.stop = cfg.stopSequences;
  }

  // functionDeclarations -> OpenAI tools
  const fns = (googleReq.tools || [])
    .flatMap((t) => (t.functionDeclarations || []))
    .filter((f) => f && f.name);
  if (fns.length) {
    openaiReq.tools = [{
      type: 'function',
      function: {
        name: '_tools',
        description: 'Available tool calls',
        parameters: {
          type: 'object',
          properties: Object.fromEntries(fns.map((f) => [f.name, {
            type: 'object',
            description: f.description || '',
            properties: (f.parameters && f.parameters.properties) || {},
          }])),
        },
      },
    }];
  }

  return openaiReq;
}

function finishReasonMap(reason) {
  switch (reason) {
    case 'length': return 'MAX_TOKENS';
    case 'content_filter': return 'SAFETY';
    default: return 'STOP';
  }
}

// OpenAI response -> Google generateContent response
function openAIToGoogle(openaiResp, originalModel) {
  const choice = openaiResp.choices && openaiResp.choices[0];
  const message = choice ? choice.message : {};
  const parts = [];

  if (message.reasoning_content) {
    parts.push({ text: message.reasoning_content, thought: true });
  }

  if (message.tool_calls && message.tool_calls.length) {
    for (const tc of message.tool_calls) {
      parts.push({
        functionCall: {
          id: tc.id,
          name: tc.function && tc.function.name,
          args: (() => {
            try { return JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch { return {}; }
          })(),
        },
      });
    }
  }

  if (message.content) {
    parts.push({ text: message.content });
  }
  if (!parts.length) parts.push({ text: '' });

  const usage = openaiResp.usage || {};
  return {
    candidates: [{
      content: { role: 'model', parts },
      finishReason: finishReasonMap(choice ? choice.finish_reason : null),
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: usage.prompt_tokens || 0,
      candidatesTokenCount: usage.completion_tokens || 0,
      totalTokenCount: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
    modelVersion: originalModel || openaiResp.model || DEFAULT_MODEL,
  };
}

// Translate OpenAI SSE stream into Google streamGenerateContent SSE events.
function translateStreamToGoogle(upstreamRes, res, originalModel, onDone) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    ...(res._cors || {}),
  });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  let buffer = '';
  // StringDecoder：TCP chunk 不按字符边界切，直接 toString('utf8') 会让
  // 跨 chunk 的汉字变成 U+FFFD（流式输出里随机出现「�」）
  const { StringDecoder } = require('string_decoder');
  const decoder = new StringDecoder('utf8');
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = null;

  // 收尾时回报 usage 供埋点；end/error 两条路径只会生效一次
  let finished = false;
  const finish = (status) => {
    if (finished) return;
    finished = true;
    if (onDone) {
      onDone({ input: inputTokens, output: outputTokens, total: inputTokens + outputTokens }, status);
    }
  };

  upstreamRes.on('data', (chunk) => {
    // 首个上游字节到达即记首字（口径同 Responses / Anthropic 两个翻译器）。
    markFirstToken(res);
    buffer += decoder.write(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.substring(6).trim();
      if (dataStr === '[DONE]') continue;
      let chunkJson;
      try { chunkJson = JSON.parse(dataStr); } catch { continue; }

      if (chunkJson.usage) {
        if (chunkJson.usage.prompt_tokens != null) inputTokens = chunkJson.usage.prompt_tokens;
        if (chunkJson.usage.completion_tokens != null) outputTokens = chunkJson.usage.completion_tokens;
      }
      const delta = chunkJson.choices && chunkJson.choices[0] && chunkJson.choices[0].delta;
      if (!delta) continue;
      if (chunkJson.choices && chunkJson.choices[0].finish_reason) {
        finishReason = chunkJson.choices[0].finish_reason;
      }

      const parts = [];
      if (delta.reasoning_content) parts.push({ text: delta.reasoning_content, thought: true });
      if (delta.tool_calls && delta.tool_calls.length) {
        for (const tc of delta.tool_calls) {
          parts.push({
            functionCall: {
              id: tc.id,
              name: tc.function && tc.function.name,
              args: (() => {
                try { return JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch { return {}; }
              })(),
            },
          });
        }
      }
      if (delta.content) parts.push({ text: delta.content });

      if (parts.length) {
        send({
          candidates: [{
            content: { role: 'model', parts },
            finishReason: null,
            index: 0,
          }],
        });
      }
    }
  });

  upstreamRes.on('end', () => {
    send({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: finishReasonMap(finishReason), index: 0 }] });
    if (inputTokens || outputTokens) {
      send({
        usageMetadata: {
          promptTokenCount: inputTokens,
          candidatesTokenCount: outputTokens,
          totalTokenCount: inputTokens + outputTokens,
        },
      });
    }
    // Google's streaming protocol ends by closing the connection; no [DONE]
    // sentinel (that is an OpenAI SSE convention and breaks GoogleGenAI).
    res.end();
    finish(200);
  });

  upstreamRes.on('error', () => {
    res.end();
    finish(502);
  });
}

module.exports = { DEFAULT_MODEL, mapModel, googleToOpenAI, openAIToGoogle, translateStreamToGoogle };