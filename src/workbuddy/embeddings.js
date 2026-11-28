// src/workbuddy/embeddings.js - WorkBuddy 嵌入（批次八，hub + misakano 双源证据 + 真机探针定案）
//
// POST {chatBase}/v2/embeddings {"model","input"} —— 2026-11-28 真机实测：
//   信封是 OpenAI embeddings 形状 {data:[{embedding:[×1024], object}],
//   model, object:'list', usage:{prompt_tokens, total_tokens}}；bge-m3
//   唯一实测可用（嵌入与对话是两套注册表，/v3/config 查不到）。
//
// 错误口径（计划原文 + 探针）：
//   11351 model not found → 400（客户端选错模型，上游报 HTTP 500 也要收成 400）
//   11353 input 过长      → 400 input_too_large（不换号——换号改变不了输入长度）
//   8MiB                  → 413 payload_too_large（客户端预检，不发才知道更浪费）
//   条数不符              → 502 宁可不返回（嵌入按位置配对，缺一条就是静默错位）
const c = require('./constants');

const MAX_BODY_BYTES = 8 * 1024 * 1024;   // 上游 8MiB 上限（hub 口径）
const DEFAULT_MODEL = 'bge-m3';

/** 输入归一化：string → [string]；数组必须全是字符串（token 数组不接，上游吃文本） */
function normalizeInput(input) {
  if (typeof input === 'string') return input.trim() ? [input] : null;
  if (Array.isArray(input) && input.length) {
    const list = input.map((x) => (typeof x === 'string' ? x : null));
    if (list.every((x) => x != null)) return list;
  }
  return null;
}

/**
 * 生成嵌入。opts.account 显式指定账号（探针/管理端用）。
 * @param {{input:string|string[], model?:string}} p
 * @returns {Promise<{object:'list', data:Array, model:string, usage:object}>}
 */
async function sendEmbeddings(p, opts = {}) {
  const input = normalizeInput(p && p.input);
  if (!input) {
    const err = new Error('input 必须是非空字符串或非空字符串数组');
    err.statusCode = 400;
    throw err;
  }
  const model = String((p && p.model) || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  // 客户端预检 8MiB（上游限制；本地拦避免白打一次 413 才知道）
  const bodyBytes = Buffer.byteLength(JSON.stringify({ model, input }), 'utf8');
  if (bodyBytes > MAX_BODY_BYTES) {
    const err = new Error(`embeddings 请求体 ${(bodyBytes / 1048576).toFixed(1)}MiB 超过上游 8MiB 上限`);
    err.statusCode = 413;
    err.code = 'payload_too_large';
    throw err;
  }
  const search = require('./search');
  let r;
  try {
    r = await search.postTool(opts.region || 'cn', '/v2/embeddings', { model, input }, opts);
  } catch (e) {
    // 上游错误码分诊：11351/11353 是请求本身的问题，换号、冷却都无意义，
    // 一律收成 400（上游对 11351 报 HTTP 500，按状态码透传会让客户端当
    // 上游抖动重试——错误码在 body 里，得拆开看）
    const codeMatch = /(\d{5})\s*[:：]/.exec(String(e.message || ''));
    const code = e.upstreamCode || (codeMatch ? Number(codeMatch[1]) : 0);
    if (code === 11351) {
      const ne = new Error(`嵌入模型 ${model} 不存在（嵌入与对话是两套注册表，实测可用：bge-m3）`);
      ne.statusCode = 400;
      throw ne;
    }
    if (code === 11353) {
      const ne = new Error('嵌入输入过长：单条 8192 token 上限（input_too_large）');
      ne.statusCode = 400;
      ne.code = 'input_too_large';
      throw ne;
    }
    throw e;
  }
  const j = r.json;
  if (!j || !Array.isArray(j.data)) {
    const err = new Error('嵌入响应缺少 data 数组');
    err.statusCode = 502;
    throw err;
  }
  // 条数不符 → 502 宁可不返回：嵌入按请求位置配对，缺一条/多条都是静默错位
  if (j.data.length !== input.length) {
    const err = new Error(`嵌入条数不符：请求 ${input.length} 条，上游返回 ${j.data.length} 条（宁可不返回，不静默错位）`);
    err.statusCode = 502;
    throw err;
  }
  return {
    object: 'list',
    data: j.data,
    model: String(j.model || model),
    usage: j.usage && typeof j.usage === 'object' ? j.usage : null,
  };
}

module.exports = { sendEmbeddings, normalizeInput, MAX_BODY_BYTES, DEFAULT_MODEL };
