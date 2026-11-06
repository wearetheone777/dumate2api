// src/credit-split.js - 积分三段拆分（hub v1.7.22 融合，2026-11-04）
//
// 按 token 把一条请求的积分成本折算成「非缓存输入 / 缓存输入 / 输出」三段，
// 一眼看出成本落在哪段——缓存为 0 的超长 prompt 是最容易被忽略的成本项。
//
// 系数来自 qoder2api-hub #129 的实测拟合（1.069 / 0.086 / 4.277，每千
// token 的 credits）。**只适用 Qoder 通道**——它是几条直连通道里唯一由
// 上游直给单请求 credits 的；TRAE/千问/WorkBuddy 的成本口径是套餐余额
// 差值，token 三段折算不出 credits，不做拆分。
//
// 缓存段与 hub 的 `?` 同口径：**上游没回报缓存字段（cached_reported=false）
// 时缓存段给 null**，不编 0——「没回报」与「真零命中」是两回事。
//
// DUMATE_QODER_CREDIT_COEF 可覆盖系数（逗号分隔三个数，顺序同上）。
'use strict';

const DEFAULT_COEFS = [1.069, 0.086, 4.277];

/** 读系数。非法值回落默认（部分非法也整体回落——半套系数更危险） */
function coefsOf() {
  const raw = String(process.env.DUMATE_QODER_CREDIT_COEF || '').trim();
  if (!raw) return DEFAULT_COEFS.slice();
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    return DEFAULT_COEFS.slice();
  }
  return parts;
}

/**
 * 三段拆分。
 * @param {object} row 请求日志行（reqlog.record 的 entry 形状）
 * @returns {object|null} null = 不适用（非 Qoder / 无 token 数据）；
 *   applicable 行带 {input, cached, output, sum}（credits），缓存未回报时
 *   cached 与 sum 为 null——sum 少一段不能假装完整。
 */
function splitOf(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.channel !== 'qoder') return null;
  const input = Math.max(0, Number(row.input_tokens) || 0);
  const output = Math.max(0, Number(row.output_tokens) || 0);
  if (!input && !output) return null;
  const cached = Math.max(0, Number(row.cached_tokens) || 0);
  const reported = !!row.cached_reported;
  const [cIn, cCached, cOut] = coefsOf();
  const noncached = Math.max(0, input - cached);
  const r4 = (v) => Math.round(v * 10000) / 10000;
  const segIn = r4((noncached / 1000) * cIn);
  const segCached = reported ? r4((cached / 1000) * cCached) : null;
  const segOut = r4((output / 1000) * cOut);
  const sum = segCached == null ? null : r4(segIn + segCached + segOut);
  return {
    input: segIn,
    cached: segCached,
    output: segOut,
    sum,
    tokens: { noncached_input: noncached, cached, output },
    coef: [cIn, cCached, cOut],
  };
}

module.exports = { splitOf, coefsOf, DEFAULT_COEFS };
