// src/traework/billing.js - TRAE 计费自检的纯函数
//
// 探针端点（admin/routes/traework.js 的 /billing-check）负责打上游；
// 判定逻辑抽出来单独可测——与 Qoder 的 credits.computeBilledRate 同一定位。
//
// 口径（2026-10-30 由本地账本反推）：实测倍率 = consumed 增量 ÷ (tokens/1000)。
// 依据：glm-5.2（模型表标称 0.78）多笔请求的 Δconsumed ÷ (tokens/1000) 落在
// 0.69~0.75，与标称值同量级。**这是推断口径而不是上游文档**——探针把原始
// 数字（delta / tokens）一并返回，判定留给看结果的人。

function num(v) {
  return v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
}

/**
 * 期望倍率：命中会员折扣取折后价，否则取标称价；都没有如实 null。
 * 与 Qoder 的「rate>0 否则 rateOriginal」同一保守思路：不编数字。
 */
function expectedRate(meta) {
  if (!meta) return null;
  const rate = num(meta.rate);
  const discounted = num(meta.rateDiscounted);
  const original = num(meta.rateOriginal);
  if (meta.discountMatched && discounted != null && discounted > 0) return discounted;
  if (rate != null && rate > 0) return rate;
  if (original != null && original > 0) return original;
  return null;
}

/**
 * 实测倍率 = 消耗增量 ÷ (tokens/1000)。
 * 差值为负（上游结算回滚）或 token 为 0 时返回 null——如实留空，不编。
 * 差值为 0 是合法测量（本次没扣费），保留 0。
 */
function billedRate(delta, tokens) {
  const d = num(delta);
  const t = num(tokens);
  if (d == null || d < 0 || t == null || t <= 0) return null;
  return Math.round((d / (t / 1000)) * 10000) / 10000;
}

/** 比值 = billed / expected。任一侧缺失或 expected <= 0 时如实 null */
function ratioOf(billed, expected) {
  const b = num(billed);
  const e = num(expected);
  if (b == null || e == null || e <= 0) return null;
  return Math.round((b / e) * 1000) / 1000;
}

/**
 * 从「请求前 / 请求后的 consumed 快照」推导本次消耗。
 *
 * @param {Map<string, number>} before 账号 id → consumed
 * @param {Map<string, number>} after  账号 id → consumed
 * @param {string|number|null} [servedId] 本次实际服务的账号 id（由 send 的
 *   onAccount 上报）。给了就取该账号的增量；没给时仅在「恰好一个账号被扣费」
 *   时采用其增量——多个账号同时涨说明有并发流量，合并数字会失真。
 * @returns {{charged: Array<{id: string, delta: number}>, delta: number|null, singleAccount: boolean}}
 */
function attributeDelta(before, after, servedId) {
  const charged = [];
  for (const [id, afterVal] of after) {
    const b = before.get(id);
    if (b == null || afterVal == null) continue;
    const d = Math.round((afterVal - b) * 10000) / 10000;
    if (d > 0) charged.push({ id: String(id), delta: d });
  }
  let delta = null;
  if (servedId != null) {
    const hit = charged.find((c) => c.id === String(servedId));
    delta = hit ? hit.delta : null;
  } else if (charged.length === 1) {
    delta = charged[0].delta;
  }
  return { charged, delta, singleAccount: charged.length === 1 };
}

module.exports = { expectedRate, billedRate, ratioOf, attributeDelta };
