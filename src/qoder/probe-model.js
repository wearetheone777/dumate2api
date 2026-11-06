// src/qoder/probe-model.js - billing-check 探针的默认模型挑选（纯函数）
//
// hub v1.7.20 #134 的另一半（2026-11-05 融合）：对零额度国际号跑探针时，
// 默认测试模型必须是**真 0 价**的（price_factor == 0 优先）；is_free 只表示
// 「含免费权益」不是 0 价，不作首选。表里没有 0 价模型时挑最小的正倍率
// （观测口径——探针是人工触发的消耗动作，默认就该打最便宜的档）。
// 表不可用/空表时返回 null，调用方要求显式传 model——**不猜**。
'use strict';

/**
 * @param {Array<{key:string, rate?:number|null, name?:string}>} rows model-info.qoderRows 的归一化行
 * @returns {{key:string, rate:number|null, reason:string}|null}
 */
function pickProbeModel(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && r.key) : [];
  if (!list.length) return null;
  // 真 0 价：rate === 0（price_factor 标 0）。错峰窗口内 0 档按 original 计费
  // 是另一回事（CLAUDE.md 明确不解读），探针的挑选只看标称 0。
  const zero = list.find((r) => r.rate === 0);
  if (zero) return { key: zero.key, rate: 0, reason: 'price_factor==0（真 0 价）' };
  // 没有标称 0：挑最小的正倍率
  const cheapest = list
    .filter((r) => Number.isFinite(r.rate) && r.rate > 0)
    .sort((a, b) => a.rate - b.rate)[0];
  if (cheapest) return { key: cheapest.key, rate: cheapest.rate, reason: '标称倍率最低' };
  return null;
}

module.exports = { pickProbeModel };
