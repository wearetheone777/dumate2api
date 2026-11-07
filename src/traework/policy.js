// src/traework/policy.js - 选号策略与凭证护栏（调研 P2-13 / P2-16）
//
// 两件事都只在**选号前**过滤候选，不动池状态、不打上游：
//   strategy  round-robin（默认）由 channel-pool 的池轮询负责；
//             credits-desc 用账号里**已落盘**的 credits 快照降序重排；
//             余额未知（null）排在已知值之后，绝不读成 0。
//   guard     默认关闭。开启后按「保留积分」跳过低于阈值的账号；
//             余额未知不跳过（查不到 ≠ 用完了，跳掉会让整池静默不可用）。
//
// 与 FEFO / 会话亲和的关系：本策略只决定「候选顺序」，不覆盖粘性——
// 会话已绑定的账号由 channel-pool 优先命中，顺序策略是兜底轮询那一层。
const { pool } = require('../pool');
const channelPool = require('../channel-pool');

function scoreOf(a, creditsOf) {
  const fromAccount = a && a.credits;
  const fromPool = creditsOf ? creditsOf(a) : null;
  // 池里的 credits 是最近一次余额读数的权威落盘值，优先于账号快照
  for (const v of [fromPool, fromAccount]) {
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return { known: true, value: n };
  }
  return { known: false, value: null };
}

function creditsOf(a) {
  try {
    const st = pool.status(channelPool.uidOf('traework', a.id));
    return st && st.credits != null ? st.credits : null;
  } catch (e) { return null; }
}

/** 保留积分护栏：返回被拦下的账号明细（用于「没有可用账号」的错误说明） */
function guardCandidates(list, cfg, io = {}) {
  if (!cfg || cfg.enabled !== true) return { rows: list, blocked: [] };
  const threshold = Number(cfg.reserveCredits);
  const below = Number(cfg.reserveBelow);
  const limit = Number.isFinite(threshold) && threshold > 0 ? threshold
    : (Number.isFinite(below) && below > 0 ? below : null);
  if (limit == null) return { rows: list, blocked: [] };
  const rows = [];
  const blocked = [];
  for (const a of list || []) {
    const s = scoreOf(a, io.creditsOf || creditsOf);
    if (s.known && s.value <= limit) {
      blocked.push({ id: a.id, name: a.nickname || a.uid || '', remain: s.value, limit });
    } else rows.push(a);
  }
  return { rows, blocked };
}

/** 按余额降序重排（未知值沉底但保留，不丢候选）；默认策略原样返回 */
function orderCandidates(list, strategy, io = {}) {
  if (strategy !== 'credits-desc' || !Array.isArray(list)) return list || [];
  return list.map((a, i) => ({ a, i, s: scoreOf(a, io.creditsOf || creditsOf) }))
    .sort((x, y) => {
      if (x.s.known !== y.s.known) return x.s.known ? -1 : 1;
      if (x.s.known && x.s.value !== y.s.value) return y.s.value - x.s.value;
      return x.i - y.i;                 // 稳定排序，避免同余额反复换号
    })
    .map((x) => x.a);
}

/** 没有可用账号时的原因：区分「全被模型开关关掉」与「池冷却/护栏」 */
function unavailableReason({ total, modelUsable, blocked }) {
  if (total > 0 && modelUsable === 0) {
    return 'TRAE 所有账号都关闭了「接模型请求」（签到与额度查询照常；到账号管理打开模型开关）';
  }
  if (blocked && blocked.length) {
    return `TRAE 没有可用账号：${blocked.length} 个账号低于保留积分线，其余处于冷却/禁用/在途满`;
  }
  return 'traework 没有可用账号（全部处于冷却/禁用/在途满，可到管理端账号池复活）';
}

module.exports = { scoreOf, creditsOf, guardCandidates, orderCandidates, unavailableReason };
