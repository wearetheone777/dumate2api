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
const modelmap = require('./modelmap');
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

/**
 * 按名字找缓存条目。**键的规范形式是 `modelmap.backendOf(名字)`**（真实
 * 后端）：同一后端的 model-text / deepseek-v41-flash / text.L0 只存一份价，
 * 不会出现「同一后端四个数字」。
 *
 * 老缓存里有按 target 或请求名写的条目（2026-11-01 的计费自检直接存
 * `mapped`）。读取时按 backend 归一后再扫一遍——不认老键会让已经测过的
 * 倍率凭空消失（review #9）。
 */
function findRateEntry(cache, model) {
  const key = String(model || '');
  if (!key) return null;
  if (cache[key]) return { key, entry: cache[key] };
  const backend = modelmap.backendOf(key);
  if (backend !== key && cache[backend]) return { key: backend, entry: cache[backend] };
  // 老缓存可能给同一个后端留下了多个键（model-text / dm-auto-model/text.L0 …）。
  // 取**最新**的那条，避免旧条目随对象键序遮蔽新测量。
  const atOf = (e) => Math.max(
    Number(e && e.pointsPerKOutAt) || 0,
    Number(e && e.billedAt) || 0,
    Number(e && e.measuredAt) || 0,
  );
  let hit = null;
  for (const [k, e] of Object.entries(cache)) {
    if (modelmap.backendOf(k) !== backend) continue;
    if (!hit || atOf(e) > atOf(hit.entry)) hit = { key: k, entry: e };
  }
  return hit;
}

/**
 * 写入一条实测记录（原子写，与 dumate-caps 同款）。失败只影响下次展示。
 *
 * 两点与老实现不同（review #9 / #11）：
 *   1. **键归一到真实后端**，写入口径统一（探针脚本、计费自检、合并脚本）。
 *   2. **按口径分别记时间戳**：pointsPerKOut（积分/千out）与 billed（积分/千tok）
 *      单位不同，后来者不能覆盖前者的时间——否则要么把旧价格盖成新鲜，
 *      要么把新测量的另一种口径冲掉。`entry.measuredAt` 可显式传入（合并
 *      历史报告时用它写**真实测量时刻**，不是合并时刻）。
 */
function saveRateEntry(model, entry) {
  try {
    const data = readRateCache();
    const key = modelmap.backendOf(model) || String(model || '');
    if (!key) return false;
    const prev = data[key] && typeof data[key] === 'object' ? data[key] : {};
    const next = { ...prev };
    // 老条目只有一个 measuredAt：按字段迁移成各自的时刻，迁移时不改原值
    const legacyAt = Number(prev.measuredAt) || 0;
    if (next.billed != null && next.billedAt == null) next.billedAt = legacyAt;
    if (next.pointsPerKOut != null && next.pointsPerKOutAt == null) next.pointsPerKOutAt = legacyAt;

    const at = Number(entry && entry.measuredAt) || Date.now();
    const { measuredAt, ...rest } = entry || {};
    Object.assign(next, rest);
    if (Number.isFinite(rest.pointsPerKOut) && rest.pointsPerKOut > 0) {
      next.pointsPerKOutAt = at;
      next.pointsPerKOutTokens = rest.tokens || '';
    }
    if (Number.isFinite(rest.billed) && rest.billed > 0) {
      next.billedAt = at;
      next.billedTokens = rest.tokens || '';
    }
    // measuredAt 只作向后兼容的“最新一次测量”摘要，不再作为单一 TTL 依据
    next.measuredAt = Math.max(
      Number(next.pointsPerKOutAt) || 0,
      Number(next.billedAt) || 0,
      Number(next.measuredAt) || 0,
    ) || at;
    data[key] = next;

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
  const hit = findRateEntry(readRateCache(), model);
  if (!hit) return null;
  const e = hit.entry;
  if (!e || !Number.isFinite(e.billed) || e.billed <= 0) return null;
  const at = Number(e.billedAt || e.measuredAt) || 0;
  if (!at || (now || Date.now()) - at > RATE_TTL_MS) return null;
  return e;
}

/**
 * 取某模型的**展示用**倍率，两种口径分先后：
 *
 *   ① `pointsPerKOut`（双点解斜率，积分/千 **output** token）——2026-11-15 起
 *       `test/probe-dumate-rates.js` 写的就是这个。它把「每次调用的固定开销」
 *      抵消掉了，比 ② 准得多（真机复现：model-text 2.0179 vs 社区 2.014）。
 *   ② `billed`（单次小请求 + 余额前后差，积分/千 **token** 综合）——2026-11-01
 *      的老口径，模型页「计费自检」按钮写的。没有 ① 时用它兜底。
 *
 * 两个口径**单位不同、不可混比**，所以返回里必须带 `unit`，界面按它写单位，
 * 不许把两种数字并到一列去比大小（本项目反复踩过的坑）。
 */
function rateValueForTarget(model, now) {
  const hit = findRateEntry(readRateCache(), model);
  if (!hit) return null;
  const e = hit.entry || {};
  const t = now || Date.now();
  const fresh = (at) => {
    const n = Number(at) || 0;
    return n > 0 && t - n <= RATE_TTL_MS;
  };
  // 两种口径各有自己的测量时刻：双点解刚测过、单点已过期时，应回落到
  // 单点的 null 而不是把过期数字当新鲜（反之亦然）。
  if (Number.isFinite(e.pointsPerKOut) && e.pointsPerKOut > 0 && fresh(e.pointsPerKOutAt || e.measuredAt)) {
    return {
      value: e.pointsPerKOut,
      unit: 'pts/1k_out',
      unitText: '积分/千out',
      source: 'two-point',
      measuredAt: Number(e.pointsPerKOutAt || e.measuredAt),
      tokens: e.pointsPerKOutTokens || e.tokens || '',
      note: `双点解斜率实测（${e.pointsPerKOutTokens || e.tokens || '—'}），纯 output token 口径`,
    };
  }
  if (Number.isFinite(e.billed) && e.billed > 0 && fresh(e.billedAt || e.measuredAt)) {
    return {
      value: e.billed,
      unit: 'pts/1k_tok',
      unitText: '积分/千tok',
      source: 'single',
      measuredAt: Number(e.billedAt || e.measuredAt),
      tokens: e.billedTokens || e.tokens || '',
      note: e.note || '单次小请求 + 余额前后差（综合输入+输出）',
    };
  }
  return null;
}

module.exports = {
  billedRate, verdictOf, rateCachePath, readRateCache, saveRateEntry, rateForTarget,
  rateValueForTarget, RATE_TTL_MS,
};
