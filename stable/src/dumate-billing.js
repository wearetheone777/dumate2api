// src/dumate-billing.js - 搭子计费自检的纯函数（2026-11-01）
//
// 搭子**没有标称倍率**——上游不吐 price_factor（TRAE/千问/Qoder 的模型表都带，
// 搭子连模型列表接口都没有），计费只体现在上游账单与余额游标。所以这里的
// 探针只能给「实测每千 token 积分成本」，与标称值的 ratio 比较无从做起，
// expected 恒 null（不编）。
//
// 口径与 Qoder 的 billed_rate 一致：cost ÷ (tokens/1000)。但**单位不同**：
// Qoder 的 credits 是上游直给的单请求扣费；搭子的 cost 是余额快照差
// （上游积分），两者数字不可互比。

/**
 * 实测每千 token 积分成本。tokens<=0 或 cost 为 null/负 → null（不编；
 * 负数是上游结算异常，如实交调用方标注，不在这里粉饰）。
 */
function billedRate(cost, totalTokens) {
  const n = Number(totalTokens);
  if (cost == null || !Number.isFinite(n) || n <= 0) return null;
  return Math.round((cost / (n / 1000)) * 10000) / 10000;
}

/**
 * 探针结论归一（纯函数，便于离线验证）。
 * cost === null  → { state: 'unmeasured' }（没测到：并发流量混入 / 结算延迟）
 * cost === 0     → { state: 'zero' }（真 0：小请求可能低于余额精度）
 * cost > 0       → { state: 'ok' }
 * cost < 0       → { state: 'negative' }（结算异常，如实标注）
 */
function verdictOf(cost) {
  if (cost == null) return { state: 'unmeasured' };
  if (cost < 0) return { state: 'negative' };
  if (cost === 0) return { state: 'zero' };
  return { state: 'ok' };
}

// ---------------------------------------------------------------------------
// 实测倍率缓存（2026-11-01，模型页「消耗倍率」列的数据源）
//
// 「—」的正解不是编一个标称值，而是**逐模型实测**：探针请求的余额差 ÷ tokens
// 落盘缓存（7 天 TTL，与 dumate-caps 同款原子写），模型信息表按 target 读。
// 别名行显示 **target** 的实测倍率——claude-* 实际按 model-text 计费，
// 显示 target 的数字才是真实语义。
//
// 单位是「积分/千token」（综合输入+输出的实测口径），与 TRAE/Qoder 的
// price_factor 不是同一单位，不可跨通道比大小。精度受余额两位小数限制：
// 请求越小相对误差越大，note 里如实标注。
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const RATE_TTL_MS = 7 * 24 * 3600 * 1000;

function rateCachePath() {
  if (process.env.DUMATE_DUMATE_RATE_FILE) return process.env.DUMATE_DUMATE_RATE_FILE;
  const dir = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
  return path.join(dir, 'dumate-rate-cache.json');
}

function readRateCache() {
  try {
    const j = JSON.parse(fs.readFileSync(rateCachePath(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (e) { return {}; }
}

/** 写入一条实测记录（原子写，与 dumate-caps 同款）。失败只影响下次展示 */
function saveRateEntry(model, entry) {
  try {
    const data = readRateCache();
    data[model] = { ...entry, measuredAt: Date.now() };
    const tmp = rateCachePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, rateCachePath());
    return true;
  } catch (e) { return false; }
}

/**
 * 从缓存取某模型的实测倍率。过期（TTL）如实返回 null——过期的数字比
 * 「—」更害人（上游改价后旧倍率看着仍然权威）。
 */
function rateForTarget(model, now) {
  const e = readRateCache()[String(model || '')];
  if (!e || !Number.isFinite(e.billed) || e.billed <= 0) return null;
  const at = Number(e.measuredAt) || 0;
  if (!at || (now || Date.now()) - at > RATE_TTL_MS) return null;
  return e;
}

module.exports = { billedRate, verdictOf, rateCachePath, readRateCache, saveRateEntry, rateForTarget, RATE_TTL_MS };
