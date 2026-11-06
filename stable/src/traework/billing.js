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
 * 解析逐轮账单响应（`get_session_usage`）。
 *
 * 实测形状（Trae2api-cn）：`data.user_usage_group_by_session.credits_float`。
 * 字段位置可能因上游版本变化，所以同时认 credits_float / creditsFloat / credits；
 * 数组形状按求和（一轮里可能有多个会话记录）。取不到如实 null，不补 0。
 */
function parseSessionUsage(data) {
  if (!data || typeof data !== 'object') return { credits: null };
  const d = data.data && typeof data.data === 'object' ? data.data : data;
  // 真实响应用的是 amount_float（2026-10-31 实测），hub 的文档写 credits_float
  // ——两个都认，再加 credits/amount 兜底。
  const pick = (o) => {
    if (!o || typeof o !== 'object') return null;
    return num(o.credits_float ?? o.creditsFloat ?? o.credits ?? o.amount_float ?? o.amountFloat ?? o.amount);
  };
  let g = d.user_usage_group_by_session
    || (d.usage && d.usage.user_usage_group_by_session)
    || null;
  if (Array.isArray(g)) {
    let sum = 0;
    let any = false;
    for (const x of g) {
      const v = pick(x);
      if (v != null) { sum += v; any = true; }
    }
    return { credits: any ? Number(sum.toFixed(4)) : null };
  }
  if (g && typeof g === 'object') {
    const v = pick(g);
    // amount_float=0 且没有明细 = 这一轮还没结算/不是该 id 的记录。返回 0 会
    // 被读成「本次免费」，所以只有明细非空时才把 0 当成合法值。
    const hasDetails = Array.isArray(g.usage_group_details) && g.usage_group_details.length > 0;
    if (v === 0 && !hasDetails) return { credits: null };
    return { credits: v };
  }
  // 个别版本可能把数字直接放在 data 上
  return { credits: pick(d) };
}

/**
 * 取某一轮的精确扣费。**这是 TRAE 唯一的单请求账单口径**——`consumed` 前后
 * 差值只是推断（并发会串账、结算有延迟）。
 *
 * 失败时如实返回 `{ ok:false, error }`，调用方退回过 consumed 差值口径，
 * 不把「没测到」当成 0。
 */
async function fetchSessionUsage(auth, turnId, opts = {}) {
  const c = require('./constants');
  const { soloHeaders } = require('./headers');
  const tnc = require('./tnc');
  if (!turnId) return { ok: false, error: '缺少 turn id' };
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(auth); } catch (e) {
    return { ok: false, error: `出站代理配置错误: ${e.message}` };
  }
  const hosts = await tnc.agentHosts(auth).catch(() => [c.AGENT_HOST]);
  let last = null;
  for (const host of hosts) {
    const r = await c.request(host, c.EP_SESSION_USAGE, {
      method: 'POST', body: { session_id: String(turnId) },
      headers: soloHeaders(auth, false), timeout: 15000, agent,
    });
    if (r.status === 200 && r.data) {
      const parsed = parseSessionUsage(r.data);
      return { ok: true, credits: parsed.credits, raw: r.data };
    }
    last = r;
    // 拿到响应（含 4xx/5xx）就不再换主机——换主机只救「连不上」
    if (r.status !== 0) break;
  }
  return { ok: false, error: last ? `HTTP ${last.status} ${String(last.raw || '').slice(0, 120)}` : '无可用主机' };
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

module.exports = { expectedRate, billedRate, ratioOf, attributeDelta, parseSessionUsage, fetchSessionUsage };
