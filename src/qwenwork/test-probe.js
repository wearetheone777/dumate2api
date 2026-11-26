// src/qwenwork/test-probe.js - 千问模型测试探针的分档判定（2026-11-27 融合 A2）
//
// 纯函数：把「上游状态码 + 是否有内容」归到一个判定档。路由层
// （admin/routes/qwenwork.js 的 /models/test）用它给每个模型的测试结果分类。
// 见 docs/PLAN-QWENWORK-GITHUB-MERGE-ROUND2.md §A2。
//
// 社区实现（ponm3ay/dsh-connect-qwenwork 的 DETAIL.md）的七档：
// 可用 / 无输出 / 不支持 / 登录失效 / 积分不足 / 被限流 / 超时网络失败。
// 这里补 server（5xx）与 forbidden（403 非模型类，签名/权限）两档，更细。
const { isQuotaOrModel } = require('./index');

const TIERS = {
  available: '可用',
  no_output: '无输出',
  unsupported: '不支持',
  auth_failed: '登录失效',
  quota: '积分不足',
  rate_limited: '被限流',
  network: '超时网络失败',
  server: '上游错误',
  forbidden: '无权限/签名',
  unknown: '未知',
};

/**
 * 分档判定（纯函数，便于离线验证）。
 * @param {number} status HTTP 状态码（0 = 网络层失败）
 * @param {string} message 上游错误文案
 * @param {boolean} hasContent 是否收到正文内容
 * @returns {{tier: string, label: string}}
 */
function classifyTestResult(status, message, hasContent) {
  const msg = String(message || '');
  if (status === 200) {
    return hasContent
      ? { tier: 'available', label: TIERS.available }
      : { tier: 'no_output', label: TIERS.no_output };
  }
  if (status === 401) return { tier: 'auth_failed', label: TIERS.auth_failed };
  if (status === 402) return { tier: 'quota', label: TIERS.quota };
  if (status === 429) return { tier: 'rate_limited', label: TIERS.rate_limited };
  if (status === 403) {
    // 模型不可用（套餐挡）→ 不支持；签名/权限类 → 无权限/签名
    return isQuotaOrModel(403, msg)
      ? { tier: 'unsupported', label: TIERS.unsupported }
      : { tier: 'forbidden', label: TIERS.forbidden };
  }
  if (status === 0 || /timeout|ETIMEDOUT|ECONN|ENOTFOUND|socket|aborted/i.test(msg)) {
    return { tier: 'network', label: TIERS.network };
  }
  if (status >= 500) return { tier: 'server', label: TIERS.server };
  return { tier: 'unknown', label: TIERS.unknown };
}

module.exports = { classifyTestResult, TIERS };
