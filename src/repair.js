// src/repair.js - 「播报即收尾」共享修复模块（千问 / Qoder / TRAE 三通道共用）
//
// 现象：上游是对话型产品（千问办公 / Qoder / TRAE 脚手架都鼓励「每完成一步
// 汇报一句」），与 Codex 的 AGENTS.md 进度播报叠加后，模型会把播报当成一次
// 完整回合：只输出 `进度：N/8｜下一步：写第 N 章` 就结束、不调用任何工具。
// 客户端收到「无工具调用」的回合即判定任务完成退出——用户看到「没做完就退出」。
//
// 提示词修不动：TRAE 2026-10-05 的对照实测（同一份真实 Codex 请求各跑 4~5 次，
// 判据＝该轮有没有发出工具调用）里，只有「检测 + 一次性重试」打到 5/5：
//
//   | 手段                              | 成功率 |
//   |-----------------------------------|--------|
//   | 现状（执行纪律已在 system）        | 1/5    |
//   | 去掉纪律（对照）                    | 1/4    |
//   | 纪律移到消息末尾                    | 3/4    |
//   | tool_choice:"required"             | 1/4    |
//   | 重试时追加「只输出工具调用」        | **5/5** |
//
// 所以三通道共用的是这条链路：
//   1. looksUnfinished —— 判据是「模型自己说还有下一步」，不是「没有工具调用」；
//   2. 追加 REPAIR_NUDGE 重试一次（上限 REPAIR_MAX）；
//   3. 流式路径用缓冲门：正文先扣住，工具调用一到先冲刷并直发，
//      超过 HOLD_CAP 转直发，usage / finish_reason / [DONE] 暂扣到轮末补发。
//      重试轮触发时，上一轮的缓冲整轮丢弃（下游只收到重试轮的输出）。
//
// 判据不要放宽成「只要没有工具调用就重试」——那样真·收尾也会被逼着再调一次
// 工具，变成永不结束。长正文（> HOLD_CAP）按真回答处理，不重试。
'use strict';

/** 修复指令原文（TRAE 实测 5/5 的文本，三通道共用） */
const REPAIR_NUDGE = [
  '你上一条回复只输出了一条进度汇报，没有调用任何工具就结束了回合，这是不允许的。',
  '必须立即调用工具继续执行任务：不要输出任何文字，只输出工具调用。',
].join('\n');

/** 正文缓冲上限默认值（真·长回答不该被扣住等判定） */
const DEFAULT_HOLD_CAP = 600;

/** 各通道的重试次数默认值（0 = 关闭整个修复） */
const DEFAULT_REPAIR_MAX = 1;

/**
 * 读某通道的修复配置。prefix 是环境变量段名：
 *   TRAEWORK  → DUMATE_TRAEWORK_HOLD_CAP / DUMATE_TRAEWORK_REPAIR_RETRY
 *   QWENWORK  → DUMATE_QWENWORK_HOLD_CAP / DUMATE_QWENWORK_REPAIR_RETRY
 *   QODER     → DUMATE_QODER_HOLD_CAP / DUMATE_QODER_REPAIR_RETRY
 *
 * 空串的重试值按 0 处理（Number('')===0，与 TRAE 旧口径一致）。
 */
function envCaps(prefix) {
  const cap = process.env[`DUMATE_${prefix}_HOLD_CAP`];
  const retry = process.env[`DUMATE_${prefix}_REPAIR_RETRY`];
  const h = Number(cap == null || cap === '' ? DEFAULT_HOLD_CAP : cap);
  return {
    HOLD_CAP: h > 0 ? h : DEFAULT_HOLD_CAP,
    REPAIR_MAX: retry == null ? DEFAULT_REPAIR_MAX : Math.max(0, Math.floor(Number(retry) || 0)),
  };
}

/**
 * 一轮「无工具调用」的回复，是不是「没干活就收工」。
 *
 * @param {string} text 本轮正文（聚合值）
 * @param {number} [cap] 正文缓冲上限，超过按真回答处理
 */
function looksUnfinished(text, cap) {
  const t = String(text || '').trim();
  if (!t) return true;                          // 一个字都没吐，等价于没干活
  if (t.length > (cap || DEFAULT_HOLD_CAP)) return false;
  return /下一步|next\s+step/i.test(t);         // 模型自己声明还有下一步
}

/**
 * 给请求 payload 追加一条修复指令 user 消息（OpenAI messages 形状）。
 *
 * 千问 / Qoder 共用：两家的 buildBody 都从 payload.messages 取完整对话
 * （system 留在 messages 里是上游的硬约束），追加一条 user 消息就是最小干预。
 * 浅拷贝 payload，**不改调用方的对象**——原 payload 还要给失败换号 / 埋点用。
 *
 * 注意：追加的这条会变成两通道的 chat_context.text（「当前用户输入」）——
 * 上游对它的权重最高，模型首先要响应的就是它。这不是缺陷：修复指令本来
 * 就该是模型正在响应的那句话。
 *
 * @param {object} payload OpenAI 格式请求体
 * @returns {object} 带 nudge 的新 payload（messages 数组替换，旧消息对象共享）
 */
function appendRepairNudge(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const msgs = Array.isArray(payload.messages) ? payload.messages : [];
  return { ...payload, messages: [...msgs, { role: 'user', content: REPAIR_NUDGE }] };
}

/**
 * 修复触发时留一行日志（通道名拼前缀）。
 *
 * 这是「模型行为」而不是「网关行为」，不记下来就无从归因。带上被丢弃的正文
 * 片段，用来区分「真·播报即收尾」与「判据误伤」（两者处置完全不同）。
 */
function logRepair(channel, reqId, attempt, text) {
  try {
    const snip = String(text || '').replace(/\s+/g, ' ').slice(0, 120);
    console.log(`[${channel}] 播报即收尾：第 ${attempt} 次重试（req_id=${reqId || '-'}）丢弃正文=「${snip}」`);
  } catch (e) { /* 日志失败不影响请求 */ }
}

// ---------------------------------------------------------------------------
// DeepSeek DSML 工具调用回退解析 + fail-closed 分类（2026-10-31 收敛到共享层）
//
// 现象（TRAE 2026-10-30 实测、hub#120 生产日志同款）：DeepSeek 系模型偶尔把
// 工具调用以**文本标记**写进正文而不走原生 tool_calls 增量——`<dsml:calls>` 包
// `<dsml:invoke name="…">` 包 `<dsml:parameter name="…">`（标签名里 DSML 的位置
// 与分隔符不固定）。客户端拿到 XML 文本，本轮工具调用不执行。
//
// 三通道共用一个分类器（fail-closed 语义，对齐 hub#120）：
//   none      正文没有（代码围栏外的）DSML 标记——原样交付（围栏内是模型在讨论格式）
//   recovered 完整 calls 块且解析出 invoke——还原成结构化工具调用 + 干净正文
//   empty     只有空壳/残片（标签闭合但没有 invoke）——剥离标记 + WARN
//             （不剥离会被「播报即收尾」的判据反复捞出来，形成无限重试）
//   leak      协议结构未闭合（calls/invoke/parameter 开了没收）——**报错**，
//             把半截协议喂给客户端比明确失败更糟
//
// TRAE（event:output 门）与千问/Qoder（标准 OpenAI chunk 门）的 finish 阶段
// 都接这个分类器；解析函数从 traework/chat.js 收敛到这里，只留 re-export。
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

/** 代码围栏剥离：围栏内的 DSML 是模型在讨论格式，不是协议。定长空串占位保偏移 */
function stripFences(s) {
  return String(s || '').replace(/```[\s\S]*?(?:```|$)/g, (m) => ' '.repeat(m.length));
}

/**
 * DSML 残片分类（见本节头注释）。text 传**缓冲中的整轮正文**。
 */
function classifyDsml(text) {
  const s = String(text || '');
  if (!/dsml/i.test(stripFences(s))) return { kind: 'none' };
  const parsed = parseDsmlToolCalls(s);
  if (parsed) return { kind: 'recovered', calls: parsed.calls, clean: parsed.clean };
  // 无完整块：区分「空壳」（标签都闭合，只是没有 invoke）与「未闭合结构」。
  // 自闭合标签（<dsml:parameter …/>）不算开。
  const outside = stripFences(s);
  const count = (re) => (outside.match(re) || []).length;
  const opens = count(/<(?!\/)[^>]*dsml[^>]*(?:calls|invoke|parameter)[^>]*>/gi)
    - count(/<(?!\/)[^>]*dsml[^>]*(?:calls|invoke|parameter)[^>]*\/>/gi);
  const closes = count(/<\/[^>]*dsml[^>]*(?:calls|invoke|parameter)\s*>/gi);
  return { kind: opens > closes ? 'leak' : 'empty' };
}

/** 剥掉正文里全部 DSML 标签（empty 处置用），多余空白收敛 */
function stripDsmlTags(text) {
  return String(text || '').replace(/<[^>]*dsml[^>]*>/gi, '').trim();
}

/** empty/leak 处置的统一日志（channel 拼前缀，hub#120 的 WARN 语义） */
function logDsml(channel, kind, text) {
  try {
    const snip = String(text || '').replace(/\s+/g, ' ').slice(0, 120);
    console.warn(`[${channel}] DSML ${kind}：${kind === 'leak' ? '未闭合协议结构，本轮按 fail-closed 丢弃' : '空壳残片已剥离'}｜正文片段=「${snip}」`);
  } catch (e) { /* 日志失败不影响请求 */ }
}

// ---------------------------------------------------------------------------
// OpenAI chunk 缓冲门（千问 / Qoder 流式路径共用）。
//
// 两条 COSY 通道解信封后得到的就是标准 OpenAI chunk（delta.content /
// reasoning_content / tool_calls / finish_reason / usage），与 TRAE 的
// event:output 上游格式不同，所以 TRAE 用它自己的 createTextGate，这里给
// 标准形状的那条门，语义与 TRAE 版完全对齐：
//
//   - reasoning_content → 直发（缓冲思考过程对判定没有帮助）
//   - tool_calls        → 先冲刷已缓冲的正文再直发；一出现就说明这轮真在干活
//   - content           → 先缓冲；超过 cap 转直发
//   - usage / finish_reason / [DONE] → 暂扣，等轮末 finish() 统一补发
//
// 转发的是**上游帧原串**（不重新序列化）：除了 usage 归一化这种在门之前
// 已经发生的改写，门不做任何内容编辑。
//
// 重试轮触发时调用方**不调 finish()**（上一轮的缓冲整轮丢弃，与 TRAE 同
// 语义：下游只收到重试轮的输出）；判定为正常收尾时才 finish() 补发。
// ---------------------------------------------------------------------------

/**
 * 给一帧解出的 OpenAI chunk 分类。
 * @returns {'tools'|'content'|'reasoning'|'hold'|'pass'}
 */
function chunkKind(o) {
  const ch = (o.choices || [])[0];
  const d = ch ? (ch.delta || ch.message || {}) : {};
  const hasToolCalls = Array.isArray(d.tool_calls) && d.tool_calls.length > 0;
  if (hasToolCalls) return 'tools';
  if (d.content) return 'content';
  if (d.reasoning_content) return 'reasoning';
  // 没有有效载荷的帧：usage 统计帧 / finish_reason 帧——暂扣到轮末，让收尾
  // 顺序可控（正文 → usage → finish_reason → [DONE]），重试时才能整轮丢弃。
  if ((ch && ch.finish_reason) || o.usage) return 'hold';
  return 'pass';   // role 帧 / 空 delta：直接放行（下游翻译层要它们保持顺序）
}

/**
 * @param {function} emit 下游回调（收 OpenAI chunk 的 JSON 串）
 * @param {boolean} hold 是否缓冲（只在「带工具的请求」上启用）
 * @param {number} [cap] content 缓冲上限
 * @param {object} [opts] { model, channel } —— model 用于 finish 阶段合成
 *   DSML 还原帧；channel 用于日志前缀。两者都给才启用 DSML fail-closed。
 */
function createChunkGate(emit, hold, cap, opts = {}) {
  cap = cap || DEFAULT_HOLD_CAP;
  let pendingFrames = [];      // 已收到但还没下发的正文帧（原串）
  let pendingLen = 0;          // 待下发正文的字符数（flush 时清零）
  let pendingText = '';        // 待下发正文的纯文本（DSML 分类用）
  let text = '';               // 本轮收到的全部正文（包括已直发的，供判定）
  let live = !hold;            // 是否已转为直发
  let toolCalls = 0;           // 带名字的工具调用个数
  let emitted = 0;             // 实际转发给下游的帧数（错误时判「客户端是否已收到输出」）
  let doneSeen = false;        // [DONE] 哨兵

  const held = [];             // 暂扣的 usage / finish_reason 帧（原串）
  const fwd = (s) => { emitted++; emit(s); };
  const flush = () => {
    while (pendingFrames.length) fwd(pendingFrames.shift());
    pendingLen = 0;
    pendingText = '';
  };
  const mkChunk = (delta, finish) => JSON.stringify({
    id: 'dsml', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
    model: opts.model || '',
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
  });

  /**
   * finish 阶段的 DSML 兜底（2026-10-31，hub#120）：整轮零原生调用、正文还在
   * 缓冲（没转直发）时才有救——已直发的收不回。三分判据见 classifyDsml 注释。
   * 返回 true = 本轮已被 DSML 处置接管（finish 的剩余流程照走）。
   */
  const dsmlFixup = () => {
    if (!opts.model) return false;
    if (live || toolCalls > 0 || !pendingFrames.length || !pendingText) return false;
    if (!/dsml/i.test(stripFences(pendingText))) return false;
    const cls = classifyDsml(pendingText);
    if (cls.kind === 'recovered') {
      // 丢弃缓冲原文帧，改发干净正文 + 还原的 tool_calls；上游 finish 帧
      // 若报 stop 会被一并纠正（与 TRAE aggregate 的同一口径）。
      pendingFrames = [];
      pendingText = '';
      if (cls.clean) fwd(mkChunk({ content: cls.clean }));
      cls.calls.forEach((cc, i) => {
        fwd(mkChunk({ tool_calls: [{ index: i, id: `call_dsml_${Date.now().toString(36)}${i}`, type: 'function', function: { name: cc.name, arguments: cc.arguments } }] }));
      });
      toolCalls = cls.calls.length;
      for (let i = 0; i < held.length; i++) {
        try {
          const h = JSON.parse(held[i]);
          const fr = h.choices && h.choices[0] && h.choices[0].finish_reason;
          if (fr === 'stop') {
            h.choices[0].finish_reason = 'tool_calls';
            held[i] = JSON.stringify(h);
          }
        } catch (e) { /* 非原串帧跳过 */ }
      }
      return true;
    }
    if (cls.kind === 'empty') {
      const cleaned = stripDsmlTags(pendingText);
      logDsml(opts.channel || 'gate', 'empty', pendingText);
      pendingFrames = [];
      pendingText = '';
      if (cleaned) pendingFrames.push(mkChunk({ content: cleaned }));
      return true;
    }
    // leak：fail-closed。reasoning 已直发（emitted 计数如实），调用方的
    // catch 会把错误交给翻译器收尾（error 终结事件），客户端看到明确失败
    // 而不是半截协议。
    logDsml(opts.channel || 'gate', 'leak', pendingText);
    const err = new Error('DSML 协议残片无法还原：正文带未闭合的 tool 调用结构（fail-closed，本轮丢弃）');
    err.statusCode = 502;
    throw err;
  };

  return {
    /** 收一帧解出的内层 payload（原串或 '[DONE]' 哨兵） */
    onInner(inner) {
      if (inner === '[DONE]') { doneSeen = true; return; }
      if (live) { fwd(inner); return; }
      let o = null;
      try { o = JSON.parse(inner); } catch (e) { /* 非 JSON 帧照原样转发 */ }
      if (!o || typeof o !== 'object' || Array.isArray(o)) { fwd(inner); return; }
      const kind = chunkKind(o);
      if (kind === 'tools') {
        const ch = (o.choices || [])[0];
        const d = ch ? (ch.delta || ch.message || {}) : {};
        for (const tc of d.tool_calls) {
          if (tc && tc.function && tc.function.name) toolCalls++;
        }
        flush();
        live = true;
        fwd(inner);
        return;
      }
      if (kind === 'content') {
        const ch = (o.choices || [])[0];
        const d = ch ? (ch.delta || ch.message || {}) : {};
        const seg = String(d.content || '');
        text += seg;
        pendingText += seg;
        pendingFrames.push(inner);
        pendingLen += seg.length;
        if (pendingLen > cap) { live = true; flush(); }
        return;
      }
      if (kind === 'hold') { held.push(inner); return; }
      fwd(inner);   // reasoning / pass
    },
    /** 判定所需的中间状态（与 TRAE gate.result() 同形，多一个 emitted） */
    result() { return { toolCalls, text, live, emitted, pending: pendingFrames.length, held: held.length }; },
    /** 收尾：把还没下发的正文与暂扣的帧补发出去 */
    finish() {
      dsmlFixup();
      flush();
      for (const f of held) fwd(f);
      if (doneSeen) fwd('[DONE]');
    },
  };
}

module.exports = {
  REPAIR_NUDGE, DEFAULT_HOLD_CAP, DEFAULT_REPAIR_MAX,
  envCaps, looksUnfinished, appendRepairNudge, logRepair,
  chunkKind, createChunkGate,
  parseDsmlToolCalls, classifyDsml, stripFences, stripDsmlTags, logDsml,
};
