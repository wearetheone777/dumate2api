// src/qwenwork/billing.js - 千问计费自检的纯函数
//
// 与 TRAE 的 billing.js 定位相同（探针端点在 admin/routes/qwenwork.js），
// 但判定方式不同：**千问上游不提供标称倍率/单价**（模型表没有 price_factor），
// 所以没有「标称 vs 实测」的比值——探针只能回答「这一次请求实际扣了多少、
// 折算到每千 token 是多少」。判读靠历史量级（实测 flash 约 0.002~0.01
// credits / 千 token）。

function num(v) {
  return v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
}

function r6(v) {
  return v == null ? null : Number(v.toFixed(6));
}

/**
 * 三池余额差值。与 credits.capture 的归因口径**逐字一致**：
 *   free = max(0, Δdaily)，paid = max(0, Δmonthly + Δlongterm)，total = free + paid。
 * 逐池也给出原始 delta（可能为负——上游结算回滚或坏读；此时不硬算成正消耗）。
 *
 * @param {object|null} before {daily, monthly, longterm}
 * @param {object|null} after  同形状
 * @returns {{daily:number|null, monthly:number|null, longterm:number|null,
 *            free:number|null, paid:number|null, total:number|null}|null}
 */
function walletDelta(before, after) {
  if (!before || !after) return null;
  const bd = num(before.daily); const ad = num(after.daily);
  const bm = num(before.monthly); const am = num(after.monthly);
  const bl = num(before.longterm); const al = num(after.longterm);
  const dd = bd != null && ad != null ? r6(bd - ad) : null;
  const dm = bm != null && am != null ? r6(bm - am) : null;
  const dl = bl != null && al != null ? r6(bl - al) : null;
  const free = dd != null ? r6(Math.max(0, dd)) : null;
  const paid = dm != null && dl != null ? r6(Math.max(0, dm + dl)) : null;
  const total = free != null && paid != null ? r6(free + paid) : null;
  return { daily: dd, monthly: dm, longterm: dl, free, paid, total };
}

/**
 * 每千 token 成本（与 TRAE/Qoder 的 billed_rate 同一归一化）。
 * token 为 0 或成本缺失时如实 null；成本 0 是合法测量（本次没扣费）。
 */
function perKTokens(cost, tokens) {
  const c = num(cost);
  const t = num(tokens);
  if (c == null || c < 0 || t == null || t <= 0) return null;
  return Math.round((c / (t / 1000)) * 10000) / 10000;
}

/**
 * 从「请求前 / 后的三池快照」推导本次消耗归属。
 *
 * @param {Map<string, object>} before 账号 id → {daily,monthly,longterm}
 * @param {Map<string, object>} after  同形状
 * @param {string|number|null} [servedId] 本次实际服务的账号 id（send 的 onAccount 上报）。
 *   给了就取该账号；没给时仅在「恰好一个账号有消耗」时采用。
 * @returns {{charged: Array<{id:string, delta:object}>, delta: object|null, singleAccount: boolean}}
 */
function attributeWalletDelta(before, after, servedId) {
  const charged = [];
  for (const [id, afterW] of after) {
    const d = walletDelta(before.get(id), afterW);
    if (d && d.total != null && d.total > 0) charged.push({ id: String(id), delta: d });
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

module.exports = { walletDelta, perKTokens, attributeWalletDelta };
