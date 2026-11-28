// src/continue.js - 长度截断无缝续写（批次二十三，对齐 misakano continue.go 的能力）
//
// 问题：deepseek-v4.1-flash 系上游对**单次响应**有输出硬上限（实测约 32k
// token），请求体里的 max_tokens 给得再大也只影响这一段。撞上限时上游回
// finish_reason=length，客户端拿到的是半截回答——对 Codex 写长文件的场景
// 尤其难受（写一半就断，还要手动「继续」）。
//
// 做法：上游流式响应**纯文本收尾且 finish_reason=length** 时，同账号自动补发
// 续写请求（原消息 + 已生成文本作为 assistant 预填 + 一条继续指令），把续写
// 段的 delta 帧接进**同一条 SSE**——对协议翻译层与客户端都表现为一次连续的
// 回答。usage 跨段合并（prompt 取末段——续写请求的 prompt 天然包含前文，
// 按段相加会把输入翻倍；completion 按段相加）。
//
// 三条硬边界：
//   1. **工具参数截断（半截 JSON）不续**——段内出现过任何 delta.tool_calls
//      就只透传收尾帧。工具调用被截断补发续写只会生成重复/损坏的参数。
//   2. 透传保真：第一段的所有帧原样透传（只扣住收尾三件套——finish 帧 /
//      usage 帧 / [DONE]），不重新序列化，首字延迟不受影响。扣住是为了让
//      翻译层看到「一条没结束的流」，否则它会在第一段的 finish 上收口。
//   3. 续写段只透传 delta.content——段 2 的 reasoning_content 在协议上没有
//      位置可放（翻译层已把第一段的思考块收口），丢弃并在注释里说明。
//      continuation 请求失败时降级：把扣住的收尾帧原样放出，客户端拿到
//      与旧行为完全相同的「截断但完整收口」的回答。
//
// 触发条件（全部满足才续）：finish_reason === 'length' + 段内无 tool_calls +
// 段内有正文 + 续写预算未用完 + 开关未关（DUMATE_CONTINUE_RETRY=0 关）。
// 段数上限 DUMATE_CONTINUE_MAX（默认 3 段续写，0 = 关）。
const CONTINUE_INSTRUCTION =
  'Continue from exactly where the output above was cut off. '
  + 'Do not repeat any previous content, do not add any preamble or explanation. '
  + 'Just continue seamlessly.';

function maxSegments() {
  const n = Number(process.env.DUMATE_CONTINUE_MAX);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}

function enabled() {
  return process.env.DUMATE_CONTINUE_RETRY !== '0';
}

/** 续写请求体：原消息 + assistant 预填已生成文本 + 一条继续指令 */
function continuationBody(origBody, fullText) {
  return {
    ...origBody,
    messages: [
      ...(Array.isArray(origBody && origBody.messages) ? origBody.messages : []),
      { role: 'assistant', content: fullText },
      { role: 'user', content: CONTINUE_INSTRUCTION },
    ],
  };
}

/** usage 跨段合并：prompt 取末段（含前文），completion 按段相加，
 *  total 按合并口径重算（末段 prompt + 各段 completion 和）——上游逐段的
 *  total 是「各自 prompt + 各自 completion」，直接相加会双计输入。 */
function mergeUsage(acc, seg) {
  if (!seg || typeof seg !== 'object') return acc || null;
  const out = { ...(acc || {}) };
  for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    const v = Number(seg[k]);
    if (!Number.isFinite(v)) continue;
    if (k === 'prompt_tokens') out[k] = v; // 末段覆盖：续写 prompt 含前文
    else out[k] = (Number(out[k]) || 0) + v;
  }
  if (Number.isFinite(out.prompt_tokens) && Number.isFinite(out.completion_tokens)) {
    out.total_tokens = out.prompt_tokens + out.completion_tokens;
  }
  return out;
}

/**
 * 创建续写闸门。一个请求一个实例（有段间状态）。
 *
 * 返回：
 *   onChunk(chunk)     —— 交给 callModelStream 的透传钩子（替代裸 onChunk）
 *   segmentDone()      —— 每段流结束后调；返回 { continue: bool, body? }
 *   finalize()         —— 不再续写时调：把扣住的收尾帧按原顺序放出，
 *                         返回 { usage }（跨段合并后；无 usage 为 null）
 *   segText()          —— 当前已累积正文（跨段累计）
 *   segments           —— 已完成的段数（含第一段）
 */
function createGate(onChunk, opts = {}) {
  const maxSeg = opts.maxSegments != null ? opts.maxSegments : maxSegments();
  const origBody = opts.body || {};
  const out = onChunk;

  let lineBuf = '';
  let segments = 0;
  let fullText = '';        // 跨段累计正文（续写请求的 assistant 预填）
  let usageAcc = null;      // 跨段 usage 累计
  let sawToolCall = false;  // 当前段是否出现过工具调用
  let segHasContent = false;
  let segUsage = null;      // 当前段 usage
  let held = [];            // 当前段扣住的收尾帧（finish/usage/[DONE]，原顺序）
  let lastHeld = [];        // 上一段扣住的收尾帧（续写失败时恢复放出——降级路径）
  let heldReason = null;    // 当前段 finish_reason
  let tailHold = false;     // 扣住第一帧后，其后的所有行（含空行）都尾随扣住——
                            // 否则空行会先于扣住帧透传出去，打乱流的字节顺序
  let swallowing = false;   // 续写失败后的吞字节模式：失败段的错误体不进流
  let continuation = false; // 当前段是否续写段（≥2）

  function emit(s) {
    if (s) { try { out(s); } catch (e) { /* 下游写失败不影响解析 */ } }
  }

  /** 收尾帧扣住形态：raw 原始行；parsed 是可重写的帧对象（usage 合并后重建） */
  function hold(line, parsed) {
    held.push({ raw: line + '\n', parsed: parsed || null });
    tailHold = true;
  }

  /** 处理一个完整的 data 行（已含 'data: ' 前缀或为裸行） */
  function onLine(line) {
    if (tailHold) {
      // 扣住后仍要**解析**独立的 usage 帧（跨段合并的数据源），其余原样尾随
      const t = line.replace(/\r$/, '');
      if (t.startsWith('data:') && t.slice(5).trim() !== '[DONE]') {
        let f = null;
        try { f = JSON.parse(t.slice(5).trim()); } catch (e) { /* 非帧原样扣 */ }
        if (f && typeof f === 'object' && f.usage && (!Array.isArray(f.choices) || f.choices.length === 0)) {
          segUsage = mergeUsage(segUsage, f.usage);
          hold(line, f);
          return;
        }
      }
      held.push({ raw: line + '\n', parsed: null });
      return;
    }
    const trimmed = line.replace(/\r$/, '');
    if (trimmed === '' || trimmed.startsWith(':')) { emit(line + '\n'); return; }
    if (!trimmed.startsWith('data:')) { emit(line + '\n'); return; }
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') {
      hold(line); // 收尾三件套之一：扣住，由 finalize/续写决策处置
      return;
    }
    let frame = null;
    try { frame = JSON.parse(payload); } catch (e) { emit(line + '\n'); return; }
    if (!frame || typeof frame !== 'object') { emit(line + '\n'); return; }

    const choice = Array.isArray(frame.choices) && frame.choices[0];
    const delta = choice && choice.delta;
    if (frame.usage && (!Array.isArray(frame.choices) || frame.choices.length === 0)) {
      // 独立 usage 帧（stream_options.include_usage 的尾部帧）
      segUsage = mergeUsage(segUsage, frame.usage);
      hold(line, frame);
      return;
    }
    if (delta && Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
      sawToolCall = true; // 本段出现过工具调用 → 收尾后绝不续写
    }
    if (delta && typeof delta.content === 'string' && delta.content) {
      fullText += delta.content;
      segHasContent = true;
    }
    if (choice && choice.finish_reason) {
      heldReason = choice.finish_reason;
      if (frame.usage) segUsage = mergeUsage(null, frame.usage);
      hold(line, frame); // finish 帧扣住（可能与 usage 合并在同一帧）
      return;
    }
    if (continuation && delta && delta.reasoning_content && !delta.content) {
      // 续写段的纯思考帧：协议上没有位置（第一段的思考块已收口），丢弃。
      return;
    }
    if (continuation && delta && delta.reasoning_content && delta.content) {
      // 思考与正文混在一帧：重建一帧只留正文（续写段是我们自己发起的，
      // 重建不影响上游保真承诺）
      const rebuilt = { ...frame, choices: [{ ...choice, delta: { ...delta, reasoning_content: undefined } }] };
      emit(`data: ${JSON.stringify(rebuilt)}\n\n`);
      return;
    }
    emit(line + '\n');
  }

  return {
    onChunk(chunk) {
      if (swallowing) return; // 续写失败段的残余字节：整段吞掉，不进流
      if (!enabled() || maxSeg === 0) { emit(chunk); return; } // 开关关闭：逐字节透传
      lineBuf += chunk;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        onLine(line);
      }
      // 行尾无换行的残余留在线缓冲里，等下一个 chunk
    },

    /** 续写失败降级：恢复上一段的收尾帧（finalize 时放出），并进入吞字节
     *  模式——失败段已经流出的残余（错误体等）不得进流。 */
    restoreFallback() {
      held = lastHeld;
      tailHold = true;
      swallowing = true;
    },

    /** 段结束。返回 { continue, body? }——body 是下一续写段请求体 */
    segmentDone() {
      // 上游最后一块可能不带换行——残余行先按一行处理再判定，
      // 否则扣住的收尾帧会留在缓冲里被丢弃
      if (lineBuf) {
        const line = lineBuf;
        lineBuf = '';
        onLine(line);
      }
      segments++;
      usageAcc = mergeUsage(usageAcc, segUsage);
      const shouldContinue =
        enabled() && maxSeg > 0
        && segments <= maxSeg
        && heldReason === 'length'
        && !sawToolCall
        && segHasContent;
      if (shouldContinue) {
        const body = continuationBody(origBody, fullText);
        // 暂存本段收尾帧：续写失败时的降级放出口（restoreFallback）
        lastHeld = held;
        // 重置段内状态（跨段的 fullText/usageAcc 保留）
        lineBuf = '';
        sawToolCall = false;
        segHasContent = false;
        segUsage = null;
        held = [];
        heldReason = null;
        tailHold = false;
        continuation = true;
        return { continue: true, body };
      }
      return { continue: false };
    },

    /** 终局：放出扣住的收尾帧，返回合并 usage（写入响应元数据的原料）。
     *  usage 帧在放出前按跨段合并值**重写**——客户端与翻译层读的是流里的
     *  usage，不重写就只看到末段的 completion（少加前面几段）。单段
     *  （segments<=1）不重写：没有合并语义，保持逐字节保真。 */
    finalize() {
      if (lineBuf && !swallowing) {
        const line = lineBuf;
        lineBuf = '';
        onLine(line);
      }
      const wasHeld = held.length > 0;
      const rewrite = segments > 1;
      for (const h of held) {
        if (rewrite && h.parsed && h.parsed.usage && usageAcc && typeof usageAcc === 'object') {
          const rebuilt = { ...h.parsed, usage: { ...usageAcc } };
          emit(`data: ${JSON.stringify(rebuilt)}\n\n`);
        } else {
          emit(h.raw);
        }
      }
      held = [];
      swallowing = false;
      return { usage: usageAcc, heldFinale: wasHeld, segments };
    },

    segText() { return fullText; },
    get segments() { return segments; },
  };
}

module.exports = { createGate, continuationBody, mergeUsage, CONTINUE_INSTRUCTION, maxSegments, enabled };
