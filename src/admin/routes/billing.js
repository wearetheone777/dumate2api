// src/admin/routes/billing.js - 计费对账总览（2026-11-07 清单项 5）
//
// 跨通道聚合「每模型实扣」——目的是把**倍率漂移**（上游改路由/倍率元数据
// 过期，TRAE 实测发生过 DeepSeek 标称 0.2 实测 1.35x 那种）从「要跑探针
// 才知道」变成「打开页面就看见分布」。
//
// 口径纪律（读账本，零上游调用，与健康端点同纪律）：
//   qoder     逐笔**精确**（usage.credits 上游直给），行自带 billed_rate
//             （computeBilledRate = credits ÷ (tokens/1000)）——按模型聚合
//             倍率分布（min/median/max），错峰优惠（discount 字段）单列计数，
//             不做 ratio 自动判定（CLAUDE.md 明确不解读乘性方向）。
//   traework  computeCosts 的差值链 + session_usage 精确覆盖：每 req_id 的
//             cost 已合并精确值，按模型聚合总实扣 + 精确/推断占比。tokens
//             不在账本行里，倍率不硬算——标称对比走 TRAE 的计费自检探针。
//   qwenwork / dumate  **不进表**：两家的账本都是余额快照（无逐请求归因），
//             硬聚只会编数字。它们的单次成本核对走各自的 billing-check 探针。
//
// 时间窗 ?days=7（默认），0 = 全量。
const { sendJSON } = require('../router');

function median(nums) {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10000) / 10000;
}

function sinceOf(days) {
  return days > 0 ? Date.now() - days * 86400000 : 0;
}

/** qoder：按模型聚合实扣 + 倍率分布（行自带 billed_rate） */
function qoderReconcile(since) {
  const qoderCredits = require('../../qoder/credits');
  const hist = qoderCredits.readHistory().filter((r) => (r.ts || 0) >= since);
  const byModel = new Map();
  for (const r of hist) {
    const model = r.model || '(unknown)';
    let g = byModel.get(model);
    if (!g) {
      g = { model, requests: 0, credits_total: 0, rates: [], discounted: 0 };
      byModel.set(model, g);
    }
    g.requests += 1;
    g.credits_total = Math.round((g.credits_total + (Number(r.credits) || 0)) * 10000) / 10000;
    if (Number.isFinite(Number(r.billed_rate)) && Number(r.billed_rate) > 0) g.rates.push(Number(r.billed_rate));
    if (r.discount != null) g.discounted += 1;
  }
  const rows = [...byModel.values()].map((g) => ({
    model: g.model,
    requests: g.requests,
    credits_total: g.credits_total,
    rate_min: g.rates.length ? Math.min(...g.rates) : null,
    rate_median: median(g.rates),
    rate_max: g.rates.length ? Math.max(...g.rates) : null,
    rate_samples: g.rates.length,
    discounted: g.discounted,
  }));
  return {
    channel: 'qoder',
    kind: 'exact',
    note: 'usage.credits 为上游直给的精确单请求扣费；billed_rate = credits ÷ (tokens/1000)。'
      + '错峰窗口内的折扣行（discounted）倍率天然偏低，属合法偏差——ratio 判读走模型页「计费自检」探针。',
    rows: rows.sort((a, b) => b.credits_total - a.credits_total),
  };
}

/** traework：computeCosts（差值链 + 精确覆盖）按模型聚合实扣 */
function traeworkReconcile(since) {
  const credits = require('../../traework/credits');
  const { rows, delta, inexact, exactIds } = credits.computeCosts();
  const byModel = new Map();
  for (const r of rows) {
    if ((r.ts || 0) < since) continue;
    const cost = delta[String(r.req_id)];
    if (cost == null) continue;                       // 无游标参照（首条/断链）——宁可缺档不编
    const model = r.model || '(unknown)';
    let g = byModel.get(model);
    if (!g) {
      g = { model, requests: 0, cost_total: 0, exact: 0, inexact: 0 };
      byModel.set(model, g);
    }
    g.requests += 1;
    g.cost_total = Math.round((g.cost_total + cost) * 10000) / 10000;
    if (exactIds.has(String(r.req_id))) g.exact += 1;
    if (inexact.has(String(r.req_id))) g.inexact += 1;
  }
  return {
    channel: 'traework',
    kind: 'mixed',
    note: 'cost 默认为 consumed 差值（推断口径，并发请求会互相污染标 inexact）；'
      + 'session_usage 单请求账单（exact）已覆盖差值。倍率对比走模型页「计费自检」探针（按账号 consumed 前后差，与这里同源）。',
    rows: [...byModel.values()].sort((a, b) => b.cost_total - a.cost_total),
  };
}

const routes = [
  {
    method: 'GET',
    path: '/reconcile',
    handler: async ({ res, req }) => {
      const url = new URL(req.url, 'http://localhost');
      const days = Math.max(0, Math.min(365, parseInt(url.searchParams.get('days') || '7', 10) || 7));
      const since = sinceOf(days);
      const channels = [];
      const errs = {};
      for (const [name, fn] of [['qoder', qoderReconcile], ['traework', traeworkReconcile]]) {
        try { channels.push(fn(since)); } catch (e) { errs[name] = e.message; }
      }
      return sendJSON(res, 200, {
        ok: true,
        days,
        channels,
        excluded: [
          { channel: 'qwenwork', reason: '账本是余额快照，无逐请求归因——单次成本核对走千问的 billing-check 探针' },
          { channel: 'dumate', reason: '同上（points-cursor 只有余额快照）；积分曲线见积分页' },
        ],
        errors: errs,
      });
    },
  },
];

module.exports = { routes };
