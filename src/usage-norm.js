// src/usage-norm.js - 上游 usage 的缓存命中字段归一（千问 / Qoder 共享）
//
// 上游按模型族把缓存命中放不同字段（qoder2api-hub #112）：
//   DeepSeek 系 → prompt_cache_hit_tokens
//   Qwen 系     → completion_tokens_details.cached_tokens
// 按标准协议解析的客户端读 prompt_tokens_details.cached_tokens 恒为 0。
// 这里把数字搬进标准位、原字段保留（已适配上游形态的客户端不受影响）；
// 上游没给缓存时不凭空造字段，已有标准位时不覆盖。
// 两个 COSY 通道（千问办公 / Qoder）共用一份，防止修一处漏一处
// （upstream-errors.js 的同一收敛理由）。

/**
 * 就地归一化 usage 的缓存字段。返回是否发生过改写（调用方据此决定
 * 要不要重新序列化帧）。
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

module.exports = { normalizeUsageCache };
