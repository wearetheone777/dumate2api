// src/usage-norm.js - 上游 usage 的缓存命中字段归一 + 协议出口取值
//
// 上游按模型族把缓存命中放不同字段（qoder2api-hub #112）：
//   DeepSeek 系 → prompt_cache_hit_tokens
//   Qwen 系     → completion_tokens_details.cached_tokens
//   Anthropic 位 → cache_read_input_tokens
//   标准 OpenAI → prompt_tokens_details.cached_tokens（搭子直给这个）
// 按标准协议解析的客户端只认最后一种，读其他形状恒为 0。
//
// 两个用途，别混：
//   1. normalizeUsageCache —— **请求处理中途**就地改写上游 usage（千问/Qoder
//      的流式帧转发前），返回是否改过，调用方据此决定要不要重新序列化。
//   2. cachedTokensOf —— **协议出口**取值。OpenAI 的 prompt_tokens 含缓存，
//      Anthropic 的 input_tokens 不含（缓存单列 cache_read_input_tokens），
//      Gemini 另有 cachedContentTokenCount 子集。三条出口都必须过这里，
//      否则缓存命中在翻译层丢掉（2026-10-31 修：Anthropic/Google 两条曾漏）。
//
// 四条通道共用一份，防止修一处漏一处（upstream-errors.js 的同一收敛理由）。

/**
 * 就地归一化 usage 的缓存字段。返回是否发生过改写（调用方据此决定
 * 要不要重新序列化帧）。
 *
 * 两条不变量：上游没给缓存时**不凭空造**字段（造 0 会被读成「缓存没命中」）；
 * 已有标准位时**不覆盖**（已适配上游形态的客户端不受影响）。
 */
function normalizeUsageCache(usage) {
  if (!usage || typeof usage !== 'object') return false;
  const hit = typeof usage.prompt_cache_hit_tokens === 'number'
    ? usage.prompt_cache_hit_tokens
    : (usage.completion_tokens_details && typeof usage.completion_tokens_details === 'object'
      && typeof usage.completion_tokens_details.cached_tokens === 'number'
      ? usage.completion_tokens_details.cached_tokens
      : null);
  if (hit == null) return false;
  if (usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
    && typeof usage.prompt_tokens_details.cached_tokens === 'number') return false; // 已有标准位
  usage.prompt_tokens_details = { ...(usage.prompt_tokens_details || {}), cached_tokens: hit };
  return true;
}

/**
 * 从任意上游形状里取「缓存命中 token 数」，没有则 0。
 *
 * 翻译层用：OpenAI 的 `prompt_tokens` 是**含缓存**的总量，而 Anthropic 的
 * `input_tokens` 与 Google 的计数口径都要求把缓存单独列出来，所以协议出口
 * 必须把这个数字取出来，不能只看标准位（搭子直给标准位、DeepSeek 给
 * `prompt_cache_hit_tokens`、Qwen 给 `completion_tokens_details.cached_tokens`）。
 */
function cachedTokensOf(usage) {
  const u = usage || {};
  const details = (u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object')
    ? u.prompt_tokens_details : {};
  const completionDetails = (u.completion_tokens_details && typeof u.completion_tokens_details === 'object')
    ? u.completion_tokens_details : {};
  const cands = [
    details.cached_tokens,
    completionDetails.cached_tokens,
    u.prompt_cache_hit_tokens,
    u.cache_read_input_tokens,
    u.cached_tokens,
  ];
  for (const v of cands) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

module.exports = { normalizeUsageCache, cachedTokensOf };
