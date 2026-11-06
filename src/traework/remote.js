// src/traework/remote.js - TRAE Remote 链路（2026-11-01，P2-16 最小传输层）
//
// 协议全部取自 Trae2api-cn 的 web remote 客户端（trae_remote_client.py）：
//
//   POST {base}/chat_sessions                             建会话 → {chat_session_id, message_id}
//   GET  {base}/chat_sessions/{id}/events?reply_to_message_id=<mid>   SSE 事件流
//   POST {base}/chat_sessions/{id}/stop                    中断
//
// 与 utils_chat（chat.js）的关键差异：
//   · 事件流是**标准 SSE**（event:/data: 行、[DONE] 哨兵），不是 utils_chat 的
//     自定义事件块——但结束同样靠哨兵，不能只看连接关闭（代理可能吞掉末尾空行）；
//   · 鉴权仍是 Cloud-IDE-JWT，但要带 web 客户端身份头（X-Trae-Client-Type 等）；
//   · 会话按 (账号, 模型) 稳定派生 session id（common_params.solo_chat_mode 决定档）；
//   · 历史以**扁平文本**进 query（[System]/[Assistant]/[Client Tool Result] 前缀），
//     不是 utils_chat 的 messages 数组。
//
// 本文件先做**最小可用**：code 模式 + auto 策略 + 文本历史（无工具调用矩阵、
// 无思考档位透传、无 max 档）——先真机跑通一条对话，再按实测证据扩。
// 国际版 remote 基址未实测（hub 只证实 raw 链路），如实拒绝不预编。
const https = require('https');
const crypto = require('crypto');
const c = require('./constants');
const { StringDecoder } = require('string_decoder');

const CONNECT_TIMEOUT_MS = Number(process.env.DUMATE_TRAEWORK_REMOTE_CONNECT_MS || 15000);
const FIRST_EVENT_MS = Number(process.env.DUMATE_TRAEWORK_REMOTE_FIRST_EVENT_MS || 120000);

/** remote 基址。intl 未实测——拒绝而不是猜 */
function remoteBaseOf(region) {
  const r = String(region || 'cn').toLowerCase();
  if (r === 'intl' || r === 'global') return null;
  return c.REMOTE_BASE_CN;
}

/**
 * 扁平化历史为 remote 端点的 query JSON 字符串（Trae2api-cn flatten_query 同款）。
 * 角色前缀是协议的一部分，不是装饰：remote 端按前缀分辨发言人。
 * 图像块降级为占位文本（remote 的渲染器媒体块形状未实测，不预编）。
 *
 * 长会话保护（2026-11-05，P2-13 补，Trae2api-cn 的 build_remote_query 裁剪层
 * 同策略）：超 maxChars 时**头部连续 [System] 块保护**（外部工具契约是安全
 * 边界，不能随旧历史一起丢）+ 会话部分取尾部 suffix + 中间插
 * `[Prompt truncated: N chars omitted]` 标记；保护块自己超限时只返回保护块。
 * 默认 480000 对齐 Trae2api-cn 的 TRAE_REMOTE_QUERY_MAX_CHARS 缺省。
 * 消息级配对挑选（防孤儿 tool result）不做——我们的前缀自解释
 * （[Client Tool Result: …] 不依赖 assistant 帧存在），差异如实注释。
 */
const QUERY_MAX_CHARS_DEFAULT = (() => {
  const n = parseInt(process.env.DUMATE_TRAEWORK_REMOTE_QUERY_MAX_CHARS || '480000', 10);
  return Number.isFinite(n) && n > 0 ? n : 480000;
})();

function flattenQuery(messages, maxChars) {
  const cap = Number(maxChars) > 0 ? Number(maxChars) : QUERY_MAX_CHARS_DEFAULT;
  const parts = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          if (p.type === 'text') return String(p.text || '');
          if (p.type === 'image_url') return '[图片：本链路暂不支持，请以文字描述]';
        }
        return '';
      }).join('');
    }
    content = String(content == null ? '' : content);
    const role = m.role || 'user';
    if (role === 'system') parts.push(`[System]\n${content}`);
    else if (role === 'assistant') {
      const segs = content ? [content] : [];
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const calls = m.tool_calls.map((t) => {
          const fn = (t && t.function) || t || {};
          return `${fn.name || 'tool'}(${fn.arguments || '{}'})`;
        }).join('; ');
        segs.push(`[called tools: ${calls}]`);
      }
      if (segs.length) parts.push('[Assistant]\n' + segs.join('\n\n'));
    } else if (role === 'tool') {
      const id = m.tool_call_id || 'unknown';
      const name = m.name || 'tool';
      parts.push(`[Client Tool Result: ${id} ${name} status=succeeded]\n${content}`);
    } else if (content) {
      parts.push(content);
    }
  }
  const prompt = parts.join('\n\n');
  if (prompt.length <= cap) return JSON.stringify([{ type: 'text', data: { content: prompt } }]);

  // 头部连续 [System] 块保护（连续才算——中途出现的 System 是会话的一部分）
  let protectedCount = 0;
  while (protectedCount < parts.length && parts[protectedCount].startsWith('[System]')) protectedCount++;
  const TRUNC = (omitted) => `[Prompt truncated: ${omitted} chars omitted]`;
  let bounded;
  if (protectedCount > 0) {
    const head = parts.slice(0, protectedCount).join('\n\n');
    const remaining = cap - head.length - TRUNC(0).length - 2;
    if (remaining > 256) {
      const conversation = parts.slice(protectedCount).join('\n\n');
      const suffix = conversation.slice(-remaining);
      const omitted = Math.max(0, conversation.length - suffix.length);
      bounded = omitted > 0
        ? `${head}\n\n${TRUNC(omitted)}\n${suffix}`
        : `${head}\n\n${conversation}`;
    } else {
      bounded = head; // 保护块自己占满预算：只留 System（外部工具契约不丢）
    }
  } else {
    const suffix = prompt.slice(-cap);
    const omitted = prompt.length - suffix.length;
    bounded = omitted > 0 ? `${TRUNC(omitted)}\n${suffix}` : prompt;
  }
  return JSON.stringify([{ type: 'text', data: { content: bounded } }]);
}

/**
 * 会话 id：同账号同模型稳定（hub 口径——它是 remote 侧的会话键，随机化等于
 * 每轮新会话）。与 channel-pool.sessionKeyOf 同思路：账号 + 模型派生 UUID。
 * variant（2026-11-06）：max 档与普通档是不同的上游配置——同一模型两档共用
 * 会话键会让上游缓存/会话状态互相污染（Trae2api-cn 的 _session_variant 同款）。
 */
function remoteSessionId(uid, model, variant) {
  const material = [String(uid || 'default'), String(model || 'auto'), String(variant || '')].join('\x1f');
  const digest = crypto.createHash('sha256').update(material).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

/**
 * code 模式的 common_params（Trae2api-cn 同款最小集；work 档的字段不预编）。
 * **返回值是 JSON 字符串不是对象**——请求体里 initial_message.common_params
 * 是序列化后的串（Trae2api-cn 的测试断言 json.loads(...) 可证）。会话键进
 * `biz_session_id`。user_identity 取账号的付费身份（Free 档实测就是 "Free"）。
 */
function commonParams(auth, mode, sessionId) {
  const uid = String(auth.uid || '');
  const params = {
    language: 'zh-cn',
    app_language: 'zh-CN',
    quality: 'stable',
    app_version: '1.0.0.1229',
    web_id: '',
    user_identity: String(auth.payIdentity || 'Free'),
    is_freshman: '0',
    biz_user_id: uid,
    user_unique_id: uid,
    scope: 'marscode-cn',
    tenant: 'marscode',
    region: 'cn',
    aiRegion: 'cn',
    is_privacy_mode: 0,
    privacy_mode: 'off',
    solo_chat_mode: mode,
    biz_session_id: sessionId,
  };
  return JSON.stringify(params);
}

/** remote 请求头（build_headers 同款；web 客户端身份是这族端点的门槛） */
function remoteHeaders(auth, opts = {}) {
  return {
    Authorization: `Cloud-IDE-JWT ${auth.accessToken}`,
    'Content-Type': 'application/json',
    Accept: opts.stream ? 'text/event-stream' : 'application/json',
    'X-Trae-Client-Type': 'web',
    'X-Preferenced-Language': 'zh-CN',
    'x-user-region': 'CN',
    Origin: c.REMOTE_ORIGIN,
    Referer: c.REMOTE_ORIGIN + '/',
    'User-Agent': c.REMOTE_UA,
  };
}

// ---------------------------------------------------------------------------
// manual 策略（2026-11-05，P2-13.1，协议取自 Trae2api-cn 的
// trae_remote_client.py：manual 请求省略完整模型对象时上游**静默落默认档**，
// 所以必须带完整 custom_model；tools 在 remote 无槽——参照实现明文
// "tools remain owned by the API caller"，带工具的请求仍走 utils_chat 不预编）
// ---------------------------------------------------------------------------

/**
 * 模型名归族（_model_family 逐字对照）：剥 trae/ 前缀、__ 运行档后缀、
 * 第一个 _ 换 -、小写；ali- 前缀与 deepseek-v4-(pro|flash) 族归并。
 */
function modelFamilyOf(name) {
  let text = String(name || '').trim().toLowerCase();
  if (!text) return '';
  if (text.startsWith('trae/')) text = text.slice(5);
  text = text.split('__', 1)[0].replace('_', '-');
  if (text.startsWith('ali-deepseek-v4-')) text = text.slice(4);
  const deepseek = /^(deepseek-v4-(?:pro|flash))(?:-(?:official|\d{4,8}))*/.exec(text);
  if (deepseek) return deepseek[1];
  if (text.endsWith('-official')) text = text.slice(0, -'-official'.length);
  return text;
}

// ---------------------------------------------------------------------------
// 思考档位（2026-11-06，协议逐字对照 Trae2api-cn 的 reasoning_effort.py /
// model_limits.py——Remote 端点实测生效，推翻「TRAE 档位字段被忽略」的旧结论：
// 那是在 utils_chat 链路上实测的，remote 的 custom_model.reasoning_effort 是
// 另一条通路）。
//
// 三条硬规则：
//   · 档位集合只有 Trae 原生三档 light / high / extra_high；
//   · 钳制是**向下**的（不高于请求档的最高支持档），descriptor 必须显式
//     support_thinking===true 且给出 options——模型名不是能力证据；
//   · 写入字段按模型对象已有键二选一（reasoning_effort_level 优先，两键
//     永不同时存在）；descriptor 不支持时删残留字段，防上游按残留值降档。
// ---------------------------------------------------------------------------

const EFFORT_LEVELS = ['light', 'high', 'extra_high'];
// none→light 是 Trae2api-cn 的口径（「不下发」在 Trae 侧没有协议槽，
// 显式关闭=压到最低档）；与 Qoder 的 none=省略参数不同，别混。
const EFFORT_ALIASES = {
  none: 'light', minimal: 'light', min: 'light', low: 'light', light: 'light',
  medium: 'high', mid: 'high', normal: 'high', default: 'high', high: 'high',
  xhigh: 'extra_high', 'x-high': 'extra_high', extra_high: 'extra_high',
  'extra-high': 'extra_high', very_high: 'extra_high', max: 'extra_high',
  maximum: 'extra_high', ultra: 'extra_high',
};

function normalizeLevel(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase().replace(/ /g, '_');
  return EFFORT_ALIASES[t] || '';
}

/** budget_tokens 区间（Trae2api-cn 同款：<4096 light / <16384 high / 更大 extra_high） */
function budgetLevel(budget) {
  const n = Number(budget);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 4096) return 'light';
  if (n < 16384) return 'high';
  return 'extra_high';
}

/** 解析请求里的档位（全入口写法：入口翻译层已统一成 reasoning_effort，
 *  但模块直调/散装客户端可能带原始形态，全收不亏）。返回 Trae 原生档或 '' */
function requestedEffort(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  for (const k of ['reasoning_effort', 'reasoningEffort', 'thinking_effort', 'reasoning_effort_level', 'reasoningEffortLevel']) {
    const lv = normalizeLevel(p[k]);
    if (lv) return lv;
  }
  if (p.reasoning && typeof p.reasoning === 'object') {
    const lv = normalizeLevel(p.reasoning.effort);
    if (lv) return lv;
  }
  for (const k of ['output_config', 'outputConfig']) {
    if (p[k] && typeof p[k] === 'object') {
      const lv = normalizeLevel(p[k].effort);
      if (lv) return lv;
    }
  }
  if (p.thinking && typeof p.thinking === 'object') {
    const lv = normalizeLevel(p.thinking.effort || p.thinking.level);
    if (lv) return lv;
    const b = budgetLevel(p.thinking.budget_tokens != null ? p.thinking.budget_tokens : p.thinking.budgetTokens);
    if (b) return b;
  }
  return '';
}

/** descriptor 字段可能是对象也可能是字符串化 JSON（model_limits._mapping 同款） */
function mappingOf(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' && !Array.isArray(p) ? p : null;
    } catch (e) { return null; }
  }
  return null;
}

function explicitBool(v) {
  if (v == null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const t = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(t)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(t)) return false;
  return null;
}

/** 取 descriptor 的 reasoning 配置（字段名/JSON 串/别名键全兼容，归一化输出） */
function reasoningConfigOf(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return null;
  const raw = mappingOf(descriptor.reasoning_effort_config != null ? descriptor.reasoning_effort_config : descriptor.reasoningEffortConfig);
  if (!raw) return null;
  const out = { ...raw };
  const support = explicitBool('support_thinking' in out ? out.support_thinking : out.supportThinking);
  if (support != null) out.support_thinking = support;
  if (!('options' in out)) {
    const opts = out.reasoning_effort_options != null ? out.reasoning_effort_options : out.reasoningEffortOptions;
    if (opts != null) out.options = opts;
  }
  if (typeof out.options === 'string' && out.options.trim().startsWith('[')) {
    try {
      const p = JSON.parse(out.options);
      if (Array.isArray(p)) out.options = p;
    } catch (e) { /* 解析不了保原样，supportedLevels 自然返回空 */ }
  }
  return out;
}

/** 该模型 descriptor 显式支持的档位（按 LEVEL_ORDER 排序）。不支持 → [] */
function supportedLevels(customModel) {
  if (!customModel || typeof customModel !== 'object') return [];
  const cfg = reasoningConfigOf(customModel);
  if (!cfg || cfg.support_thinking !== true) return [];
  const opts = Array.isArray(cfg.options) ? cfg.options : [];
  const levels = opts.map(normalizeLevel).filter(Boolean);
  return EFFORT_LEVELS.filter((l) => levels.includes(l));
}

/** 向下钳：不高于请求档的最高支持档；没有更低就最低档（Trae2api-cn clamp 同款） */
function clampLevel(level, supported) {
  if (!level || !supported.length) return '';
  const rank = EFFORT_LEVELS.indexOf(level);
  const eligible = supported.filter((s) => EFFORT_LEVELS.indexOf(s) <= rank);
  return eligible.length ? eligible[eligible.length - 1] : supported[0];
}

/**
 * 按请求档位改写 custom_model（**浅拷贝**，不改模型表缓存原对象）。
 * 返回 { row, requested, level }：level 空串 = 不写档位（未请求，或
 * descriptor 不支持——后者删残留字段，requested 仍如实返回供观测）。
 */
function applyReasoningEffort(customModel, payload) {
  if (!customModel || typeof customModel !== 'object') return { row: customModel, requested: '', level: '' };
  const requested = requestedEffort(payload);
  if (!requested) return { row: { ...customModel }, requested: '', level: '' };
  const level = clampLevel(requested, supportedLevels(customModel));
  const updated = { ...customModel };
  if (!level) {
    // 调用方要了档位但 descriptor 不支持：上游会静默落默认档——删掉模型对象
    // 里可能残留的档位字段，防止上游按残留值降档（Trae2api-cn 同款防御）
    delete updated.reasoning_effort;
    delete updated.reasoning_effort_level;
    return { row: updated, requested, level: '' };
  }
  if ('reasoning_effort_level' in updated) {
    updated.reasoning_effort_level = level;
    delete updated.reasoning_effort;
  } else {
    updated.reasoning_effort = level;
    delete updated.reasoning_effort_level;
  }
  return { row: updated, requested, level };
}

/**
 * manual 策略的 initial_message 追加字段（Trae2api-cn 同款五件）。
 * @param {string} requestedModel 调用方请求的模型名
 * @param {object} row models.normalize 的归一化行（须带 customModel 原始对象）
 * @param {object} [effortPayload] 原始请求体——给了就解析思考档位并写入
 *   custom_model（钳制在 applyReasoningEffort 内做；auto 策略没有 custom_model
 *   槽，档位无处安放，不预编）
 * @returns {{error:string}|{fields:object, boundModel:string, effort:{requested:string, level:string}}}
 *   bound 校验失败返回 error——manual 省略完整对象会被上游静默落默认档，
 *   校验不过就明确失败，不静默回落 auto（Trae2api-cn 的 RuntimeError 同语义）。
 */
function manualFieldsOf(requestedModel, row, effortPayload) {
  const raw = row && row.customModel;
  if (!raw || typeof raw !== 'object') {
    return { error: `remote manual：模型 ${requestedModel} 没有上游原始配置对象（模型表未带）` };
  }
  const family = modelFamilyOf(requestedModel);
  const candidates = [raw.config_name, raw.model_name, raw.name]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  const hit = candidates.find((cand) => modelFamilyOf(cand) === family);
  if (!hit) {
    return { error: `remote manual：请求模型 ${requestedModel} 与账号模型表的 ${candidates.join('/') || '(空)'} 不匹配（拒绝静默落默认档）` };
  }
  const source = Number(raw.config_source);
  const applied = effortPayload ? applyReasoningEffort(raw, effortPayload) : { row: raw, requested: '', level: '' };
  return {
    boundModel: hit,
    effort: { requested: applied.requested || '', level: applied.level || '' },
    fields: {
      model_name: hit,
      model_config_source: Number.isFinite(source) && source !== 0 ? source : 1,
      model_is_preset: raw.is_preset !== undefined ? !!raw.is_preset : true,
      model_provider: String(raw.provider || ''),
      custom_model: applied.row,
    },
  };
}

function agentOf(auth) {
  try { return require('../proxy-agent').getAgentFor(auth); } catch (e) { throw new Error(`出站代理配置错误: ${e.message}`); }
}

/**
 * 建会话。mode 'code'（对话）| 'work'（执行档，字段未实测不预编）。
 * 返回 { ok, sessionId, messageId, error, status }。
 */
function createSession(auth, opts = {}) {
  const base = remoteBaseOf(auth.region);
  if (!base) return Promise.resolve({ ok: false, error: 'remote 链路国际版基址未实测，暂不支持国际账号' });
  const mode = opts.mode === 'work' ? 'work' : 'code';
  const agentType = opts.agentType || (mode === 'work' ? 'solo_work_remote' : 'solo_agent_remote');
  const model = String(opts.model || '');
  // manual 策略：先解析追加字段——解析失败**在发请求前**拒绝（不静默回落）。
  // effortPayload（原始请求体）给了就解析思考档位写入 custom_model
  let manual = null;
  if (opts.strategy === 'manual') {
    manual = manualFieldsOf(model, opts.customModelRow, opts.effortPayload);
    if (manual.error) return Promise.resolve({ ok: false, error: manual.error });
  }
  // 1M Max（#15，2026-11-06）：请求显式要（opts.maxMode）且 manual 且 descriptor
  // 显式支持——strategy 升 "max" + 显式上限字段，会话键加 max 变体（与普通档
  // 的上游会话/缓存状态隔离）。auto 策略没有 custom_model 槽，无从判定能力，
  // 不启用（与 Trae2api-cn 一致：max 判定只在 manual 分支内做）。
  const maxDescriptor = (opts.customModelRow && opts.customModelRow.customModel) || null;
  const maxMode = { requested: opts.maxMode === true, applied: false };
  let sessionId = opts.sessionId || remoteSessionId(auth.uid, model);
  if (maxMode.requested && manual && mode === 'code' && supportsMaxMode(maxDescriptor)) {
    maxMode.applied = true;
    sessionId = remoteSessionId(auth.uid, model, 'max');
  }
  const body = {
    mode,
    environment_id: 'default',
    env: 'remote',
    auto_create_project: false,
    origin: 'web',
    initial_message: {
      chat_session_id: '',
      content: [],
      query: flattenQuery(opts.messages || []),
      model_name: model,
      agent_type: agentType,
      // agent_id 不带会被 remote 静默落到默认档（Trae2api-cn 注释明示）
      agent_id: agentType,
      model_selection_strategy: opts.strategy || 'auto',
      common_params: commonParams(auth, mode, sessionId),
      ...(manual ? manual.fields : {}),
      ...(maxMode.applied ? maxModeFields(maxDescriptor, opts.maxModeType) : {}),
    },
  };
  return new Promise((resolve) => {
    let agent;
    try { agent = agentOf(auth); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const u = new URL(base + '/chat_sessions');
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { ...remoteHeaders(auth, { stream: false }), 'Content-Length': Buffer.byteLength(payload) },
      timeout: CONNECT_TIMEOUT_MS,
      ...(agent ? { agent } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          return resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode} ${raw.slice(0, 300)}` });
        }
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
        const d = (data && (data.data || data.Result || data)) || {};
        const sid = String(d.chat_session_id || '');
        const mid = String(d.message_id || '');
        if (!sid || !mid) return resolve({ ok: false, status: res.statusCode, error: `create_session 缺 id: ${raw.slice(0, 200)}` });
        resolve({ ok: true, sessionId: sid, messageId: mid, effort: manual ? manual.effort : null, maxMode, raw: d });
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* 已结束 */ } resolve({ ok: false, error: 'connect timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 1M Max 模式（2026-11-06，协议逐字对照 Trae2api-cn 的 _max_mode_fields /
// model_limits.descriptor_supports_max_mode）。只在 remote manual（Agent 档）
// 生效：model_selection_strategy 升为 "max" + model_auto_selection + 从
// descriptor 显式声明的字段取上下文/输出上限——**不合成 1M/936K/64K 参数**，
// descriptor 没标 max_mode 就是不支持（模型名不是能力证据）。
// ---------------------------------------------------------------------------

/** 从 descriptor 取显式存在的上下文/输出限制（model_limits.context_limits 同形） */
function contextLimitsOf(descriptor) {
  const out = {};
  if (!descriptor || typeof descriptor !== 'object') return out;
  const keys = ['max_mode', 'context_window_size', 'context_window_sizes', 'context_window_tokens', 'prompt_max_tokens', 'max_tokens', 'max_turn', 'max_turns'];
  for (const k of keys) {
    if (descriptor[k] != null) out[k] = descriptor[k];
  }
  const features = mappingOf(descriptor.features);
  if (features) {
    const windows = mappingOf(features.context_windows);
    if (windows) out.context_windows = windows;
  }
  return out;
}

/** descriptor 显式声明的最大上下文；没有就 null（绝不合成） */
function maxContextOf(descriptor) {
  const limits = contextLimitsOf(descriptor);
  const candidates = [];
  const pushNum = (v) => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) candidates.push(n);
  };
  for (const key of ['context_window_size', 'context_window_sizes']) {
    if (limits[key] == null) continue;
    const m = mappingOf(limits[key]);
    if (m) {
      pushNum(m.max);
      pushNum(m.max_context);
    } else if (typeof limits[key] !== 'object') {
      pushNum(limits[key]); // 直接数字形态
    }
  }
  if (limits.context_window_tokens != null) {
    const m = mappingOf(limits.context_window_tokens);
    if (m) pushNum(m.max);
  }
  if (limits.context_windows && typeof limits.context_windows === 'object') {
    const data = mappingOf(limits.context_windows.data);
    if (data) {
      pushNum(data.max_context);
      pushNum(data.max_context_list);
    }
  }
  return candidates.length ? Math.max(...candidates) : null;
}

/** max 档的硬门：descriptor 显式标 max_mode 且上下文/输出上限三项齐备
 *  （Trae2api-cn descriptor_supports_max_mode 同形——缺一即不支持） */
function supportsMaxMode(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return false;
  if (descriptor.max_mode !== true) return false;
  const limits = contextLimitsOf(descriptor);
  const maxContext = maxContextOf(descriptor);
  if (maxContext == null || maxContext < 1000000) return false;
  const promptMax = Number(limits.prompt_max_tokens);
  const maxOut = Number(limits.max_tokens);
  return Number.isFinite(promptMax) && promptMax > 0 && Number.isFinite(maxOut) && maxOut > 0;
}

/** max 档的 wire 字段（model_auto_selection + 显式上限，从 descriptor 取） */
function maxModeFields(descriptor, modeType) {
  const limits = contextLimitsOf(descriptor);
  const fields = {
    model_auto_selection: { strategy: 'max', fallback_to_advance_model: null, entitlement_id: null },
    model_selection_strategy: 'max',
  };
  const maxContext = maxContextOf(descriptor);
  if (maxContext != null) fields.context_window_size = maxContext;
  for (const key of ['prompt_max_tokens', 'max_tokens']) {
    const v = Number(limits[key]);
    if (Number.isFinite(v) && v > 0) fields[key] = v;
  }
  const mt = Number(modeType != null ? modeType : process.env.DUMATE_TRAEWORK_REMOTE_MAX_MODE_TYPE || 1);
  if (Number.isFinite(mt) && mt > 0) fields.mode_type = mt;
  return fields;
}

/**
 * 订阅事件流（GET /chat_sessions/{id}/events?reply_to_message_id=<mid>）。
 * onEvent({ event, data })；[DONE] 哨兵后 resolve('done')。
 * 解析按标准 SSE 事件块（与 chat.js 的自定义块不同：哨兵是 data: [DONE]）。
 */
/**
 * 事件名归一（Trae2api-cn 的 event_name 同款）：上游事件名有蛇形与驼峰两种
 * 形态（tokenUsage / responseDone / streamDone…），只做小写会把驼峰帧漏进
 * 'message' 默认分支——model_config 丢失、done 判不出来。归一 + 已知别名表。
 */
const EVENT_ALIASES = {
  modelconfig: 'model_config',
  planitem: 'plan_item',
  responsedone: 'done',
  response_done: 'done',
  streamdone: 'done',
  stream_done: 'done',
  tokenusage: 'token_usage',
};

function normEventName(name) {
  let t = String(name || '').trim();
  if (!t) return ''; // 空入空出：调用方用 || 链回退到 data.event / 'message'
  t = t.replace(/([a-z0-9])([A-Z])/g, '$1_$2');          // 驼峰 → 蛇形
  t = t.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return EVENT_ALIASES[t] || t;
}

function streamEvents(auth, sessionId, messageId, onEvent, opts = {}) {
  const base = remoteBaseOf(auth.region);
  if (!base) return Promise.resolve({ ok: false, error: 'remote 链路国际版未支持' });
  return new Promise((resolve) => {
    let agent;
    try { agent = agentOf(auth); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const u = new URL(`${base}/chat_sessions/${encodeURIComponent(sessionId)}/events`);
    u.searchParams.set('reply_to_message_id', messageId);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: remoteHeaders(auth, { stream: true }),
      timeout: 0, // 长流不设总超时；首事件超时自己管
      ...(agent ? { agent } : {}),
    }, (res) => {
      if (res.statusCode >= 400) {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode} ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}` }));
        res.resume();
        return;
      }
      const dec = new StringDecoder('utf8');
      let buf = '';
      let firstEventSeen = false;
      let settleGuard = false;
      const settle = (v) => { if (settleGuard) return; settleGuard = true; clearTimeout(firstTimer); try { res.destroy(); } catch (e) { /* 已结束 */ } resolve(v); };
      // 首事件超时：排队/心跳帧不算模型活动——remote 会先吐 queue/heartbeat
      const firstTimer = setTimeout(() => {
        settle({ ok: false, error: `首事件超时（${FIRST_EVENT_MS}ms 内无任何模型事件）` });
      }, FIRST_EVENT_MS);
      if (firstTimer.unref) firstTimer.unref();
      const MODEL_EVENTS = new Set(['model_config', 'plan_item', 'message', 'assistant_message', 'response', 'text', 'output', 'token_usage', 'done']);
      const norm = normEventName;
      const flushBlock = (block) => {
        const lines = block.split('\n');
        let event = '';
        const dataLines = [];
        for (const l of lines) {
          const t = l.replace(/\r$/, '');
          if (t.startsWith(':')) continue; // SSE 注释（心跳注释帧）
          if (t.startsWith('event:')) event = t.slice(6).trim();
          else if (t.startsWith('data:')) dataLines.push(t.slice(5).trim());
        }
        const raw = dataLines.join('\n');
        if (raw === '[DONE]') { settle({ ok: true, done: true }); return; }
        let data = null;
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { _raw: raw }; } }
        const n = norm(event) || norm(data && (data.event || data.event_type)) || 'message';
        if (!firstEventSeen && MODEL_EVENTS.has(n)) {
          firstEventSeen = true;
          clearTimeout(firstTimer);
        }
        // **终结判据是 event:done**（2026-11-01 真机实测定案）：上游发完 done
        // 帧后直接关流，没有 data:[DONE] 哨兵——只认 [DONE] 会把完整回答
        // 误判成「流被掐断」（Trae2api-cn 的 saw_terminal 判的也是 done 事件）。
        if (n === 'done') {
          try { onEvent({ event: n, data }); } catch (e) { /* 消费方异常不掐流 */ }
          settle({ ok: true, done: true });
          return;
        }
        try { onEvent({ event: n, data }); } catch (e) { /* 消费方异常不掐流 */ }
      };
      res.on('data', (chunk) => {
        buf += dec.write(chunk);
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (block.trim()) flushBlock(block);
          if (settleGuard) return;
        }
      });
      res.on('end', () => {
        buf += dec.end();
        if (buf.trim()) flushBlock(buf);
        // 连接关闭但没见到 [DONE]：remote 可能静默断流（Trae2api-cn
        // RemoteStreamIncomplete 同款判据——不能让半截答案装成正常收尾）
        settle({ ok: false, error: '事件流在 [DONE] 前被关闭', incomplete: !firstEventSeen });
      });
      res.on('error', (e) => settle({ ok: false, error: e.message }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* 已结束 */ } });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

/** 中断会话（best-effort，失败静默——中断的目的是停止上游烧钱） */
function stopSession(auth, sessionId, messageId) {
  const base = remoteBaseOf(auth.region);
  if (!base || !sessionId || !messageId) return Promise.resolve(false);
  return new Promise((resolve) => {
    let agent;
    try { agent = agentOf(auth); } catch (e) { return resolve(false); }
    const u = new URL(`${base}/chat_sessions/${encodeURIComponent(sessionId)}/stop`);
    const payload = JSON.stringify({ chat_session_id: sessionId, user_message_id: messageId });
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { ...remoteHeaders(auth, { stream: false }), 'Content-Length': Buffer.byteLength(payload) },
      timeout: 10000,
      ...(agent ? { agent } : {}),
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode < 400)); });
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* 已结束 */ } resolve(false); });
    req.on('error', () => resolve(false));
    req.write(payload);
    req.end();
  });
}


// ---------------------------------------------------------------------------
// 事件 → OpenAI chunk 翻译（2026-11-01 真机实测定案的形状）
//
// plan_item 是**累积快照**不是增量：同一 id 的每帧 thought/reasoning_content
// 都是「到目前为止的全文」（实测同一轮连收 4 帧「明白」→「明白明白」→…→全量）。
// 翻译层用快照/增量双判：新串以前串开头 = 快照（取新增量）；否则按增量追加。
// 判错的后果是把全文重复发 4 遍，客户端看到复读。
// ---------------------------------------------------------------------------

/** 快照/增量双判累积器。push 返回**新增量**（发 delta 用），value 取全文 */
function textAccumulator() {
  let acc = '';
  return {
    push(chunk) {
      const t = String(chunk || '');
      if (!t) return '';
      let delta;
      if (!acc) { acc = t; delta = t; }
      else if (t.startsWith(acc)) { delta = t.slice(acc.length); acc = t; }
      else if (acc.startsWith(t)) { delta = ''; } // 旧快照迟到，忽略
      else { acc += t; delta = t; }
      return delta;
    },
    value() { return acc; },
  };
}

/** remote 事件流的聚合结果形状（与 chat.aggregate 对齐的 OpenAI 形状） */
function aggregateEvents(events, model) {
  const text = textAccumulator();
  const reasoning = textAccumulator();
  let usage = null;
  let modelName = model;
  let finish = null;
  let errEvent = null;
  for (const ev of events) {
    const d = (ev && ev.data) || {};
    if (ev.event === 'plan_item') {
      text.push(d.thought);
      reasoning.push(d.reasoning_content);
    } else if (ev.event === 'token_usage') {
      usage = d;
    } else if (ev.event === 'model_config' && (d.config_name || d.model_name)) {
      modelName = d.config_name || d.model_name;
    } else if (ev.event === 'done') {
      finish = d;
    } else if (ev.event === 'error') {
      errEvent = d;
    }
  }
  const message = { role: 'assistant', content: text.value() };
  const r = reasoning.value();
  if (r) message.reasoning_content = r;
  const out = {
    id: 'traework-remote',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [{
      index: 0,
      message,
      finish_reason: finish && finish.status === 'completed' ? 'stop' : (finish ? 'stop' : null),
    }],
    usage: usage ? remoteUsageOf(usage) : null,
  };
  if (errEvent) out.error = errEvent;
  return out;
}

/**
 * remote token_usage → OpenAI usage 形状（2026-11-06 缓存透传）。
 * 上游原生带 cache_read_input_tokens / cache_creation_input_tokens——读命中
 * 镜像进 OpenAI 标准位 prompt_tokens_details.cached_tokens（与 utils_chat
 * 的 chat.js 567 同口径），写缓存无标准位、平铺保留。**SSE 的 0 不能证明
 * 未命中**（真机实测：SSE 两轮全 0，账单 cache_read_token=25344）——
 * 账本层的账单补查才是权威口径（credits.enrichSessionUsage）。
 */
function remoteUsageOf(u) {
  const usage = {
    prompt_tokens: Number(u.prompt_tokens) || 0,
    completion_tokens: Number(u.completion_tokens) || 0,
    total_tokens: Number(u.total_tokens) || 0,
    completion_tokens_details: { reasoning_tokens: Number(u.reasoning_tokens) || 0 },
  };
  const read = Number(u.cache_read_input_tokens);
  if (Number.isFinite(read)) {
    usage.prompt_tokens_details = { ...(usage.prompt_tokens_details || {}), cached_tokens: read };
  }
  const write = Number(u.cache_creation_input_tokens);
  if (Number.isFinite(write)) usage.cache_creation_input_tokens = write;
  return usage;
}

/**
 * 一次完整 remote 回合：建会话 → 订事件 → 聚合。
 * onEvent 可选（流式路径逐事件回调，收 {event, data}）。
 * 返回 { ok, aggregate, messageId, sessionId, error, status }。
 */
async function runTurn(auth, opts = {}) {
  const cs = await createSession(auth, opts);
  if (!cs.ok) return { ok: false, error: cs.error, status: cs.status };
  const events = [];
  const sr = await streamEvents(auth, cs.sessionId, cs.messageId, (ev) => {
    events.push(ev);
    if (opts.onEvent) { try { opts.onEvent(ev); } catch (e) { /* 上报失败不影响流 */ } }
  }, opts);
  if (!sr.ok) {
    // 上游事件里的 error 已在 events 里（error 事件优先于传输层错误）
    const errEv = events.find((e) => e.event === 'error');
    if (errEv) {
      const d = errEv.data || {};
      return { ok: false, error: `traework remote ${d.code || ''}: ${d.message || '上游错误'}`, events, sessionId: cs.sessionId, messageId: cs.messageId };
    }
    return { ok: false, error: sr.error, events, sessionId: cs.sessionId, messageId: cs.messageId };
  }
  const doneEv = events.find((e) => e.event === 'done');
  const status = doneEv && doneEv.data && String(doneEv.data.status || '');
  if (status && status !== 'completed') {
    return { ok: false, error: `traework remote 回合未完成（status=${status}）`, events, sessionId: cs.sessionId, messageId: cs.messageId, effort: cs.effort, maxMode: cs.maxMode };
  }
  return { ok: true, aggregate: aggregateEvents(events, opts.model || ''), messageId: cs.messageId, sessionId: cs.sessionId, effort: cs.effort, maxMode: cs.maxMode, events };
}

/** 请求是否要 max 档：单次 `trae_max_mode` 开关或 env 全局开关（白名单放行）。
 *  descriptor 硬门（supportsMaxMode）在 createSession 里做——这里只判意图。 */
function maxModeRequested(model, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  let wanted = p.trae_max_mode === true || p.traeMaxMode === true;
  if (!wanted) {
    const env = String(process.env.DUMATE_TRAEWORK_REMOTE_MAX_MODE || '').trim().toLowerCase();
    wanted = env === '1' || env === 'true' || env === 'yes' || env === 'on';
  }
  if (!wanted) return false;
  const configured = String(process.env.DUMATE_TRAEWORK_REMOTE_MAX_MODELS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (configured.length && !configured.includes('*')) {
    return configured.includes(String(model || '').trim().toLowerCase());
  }
  return true;
}

module.exports = {
  remoteBaseOf, flattenQuery, remoteSessionId, commonParams, remoteHeaders,
  modelFamilyOf, manualFieldsOf,
  normalizeLevel, budgetLevel, requestedEffort, reasoningConfigOf, supportedLevels, clampLevel, applyReasoningEffort,
  contextLimitsOf, maxContextOf, supportsMaxMode, maxModeFields, normEventName, maxModeRequested,
  remoteUsageOf,
  createSession, streamEvents, stopSession, textAccumulator, aggregateEvents, runTurn,
};
