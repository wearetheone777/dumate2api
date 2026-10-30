// src/channel-pool.js - 直连通道（qwenwork / traework / qoder）选号与账号池的接缝
//
// 施工包 A 建了池状态机（src/pool.js）并接好了 web 通道（web-pool.js），
// B 的 keepalive adapter 也定义了各通道账号在池里的 uid 键位；本模块把
// 三条直连通道的选号路径接到同一台状态机上——集成阶段唯一的新接缝。
//
// **uid 键位统一（B 包接口假设的集成校准，全库唯一裁决点）**：
//   web       = 裸 String(id)（A 包 web-pool 既有口径，管理端 /pool 端点同）
//   其余通道  = `${channel}:${id}`（B 包 keepalive adapter 同口径）
// 三条直连通道的 id 是各自文件里的自增数字，裸用会在共享 pool-state.json
// 里撞号；加通道前缀后与 web 裸数字天然不冲突。改键位只改本文件。
//
// 会话粘性（sticky）：同一会话尽量落到同一账号（TRAE 上下文恢复成本高）。
// 会话键取「首条 user 消息的指纹」——会话逐轮追加消息，首条不变，跨轮稳定；
// 调用方也可经 opts.sessionKey 显式指定。绑定只在内存（sticky.js 自己管），
// 命中时校验池健康态/模型负缓存/保底，不健康即解绑换号。
//
// 在途帽：命中即 pool.acquire，调用方请求结束后必须 release——防单账号
// 被打爆触发风控，与 web-pool 的 callModel 同一纪律。
const crypto = require('crypto');
const { pool, DEFAULTS } = require('./pool');
const { createSticky } = require('./sticky');
const { classify } = require('./upstream-errors');

const sticky = createSticky();

function uidOf(channel, id) {
  return `${channel}:${id}`;
}

/**
 * 会话键。优先 opts.sessionKey；否则用首条 user 消息文本的短指纹。
 * 取不到（空消息/非标准形状）返回空串 = 本请求不粘，走普通轮询。
 */
function sessionKeyOf(payload, opts) {
  if (opts && opts.sessionKey != null && String(opts.sessionKey).trim()) {
    return `k:${String(opts.sessionKey).trim()}`;
  }
  try {
    const msgs = payload && Array.isArray(payload.messages) ? payload.messages : [];
    const first = msgs.find((m) => m && m.role === 'user');
    let text = '';
    if (first) {
      if (typeof first.content === 'string') text = first.content;
      else if (Array.isArray(first.content)) {
        const part = first.content.find((p) => p && typeof p === 'object' && typeof p.text === 'string');
        text = part ? part.text : '';
      }
    }
    if (!text.trim()) return '';
    return `m:${crypto.createHash('sha1').update(text.slice(0, 2048)).digest('hex').slice(0, 20)}`;
  } catch (e) {
    return '';
  }
}

// 粘性命中也要过与 pool.pick 同一套判据：模型负缓存与保底不在
// isHealthy 里（那是账号级判定），这里按 status() 的现算字段补查。
function stickyUsable(uid, model) {
  if (!pool.isHealthy(uid)) return false;
  let st = null;
  try { st = pool.status(uid); } catch (e) { return false; }
  if (st.floor_blocked) return false;
  if (model && (st.model_cooldowns || []).some((m) => m.model === model)) return false;
  return true;
}

/**
 * 选一个候选账号：粘性命中优先，否则池轮询（冷却/熔断/禁用/暂停/在途满/
 * 模型负缓存/保底拦截全部跳过）。命中即占用一个在途名额。
 *
 * 在途满的候选不惩罚（busy 不是账号的错），换下一个继续找；全部 busy
 * 也返回 null（调用方按「没有可用账号」处理，与 web-pool 的 busy 语义一致）。
 *
 * @param {string} channel 通道名（qwenwork / traework / qoder）
 * @param {Array<{id:number|string}>} candidates 调用方给的可选账号（原始记录）
 * @param {{exclude?:Set|Array, sessionKey?:string, model?:string, paid?:boolean}} [opts]
 * @returns {{account:object, uid:string, sessionKey:string}|null} null = 没有可用账号
 */
function pickCandidate(channel, candidates, opts = {}) {
  const list = (candidates || []).filter((a) => a && a.id !== undefined);
  if (!list.length) return null;
  const byUid = new Map(list.map((a) => [uidOf(channel, a.id), a]));
  const uids = [...byUid.keys()];
  const exclude = opts.exclude ? new Set([...opts.exclude].map((id) => uidOf(channel, id))) : new Set();
  const sessionKey = opts.sessionKey || '';
  const busy = new Set();

  for (;;) {
    let uid = null;
    if (sessionKey) {
      const bound = sticky.lookup(sessionKey);
      if (bound && byUid.has(bound) && !exclude.has(bound) && !busy.has(bound)
        && stickyUsable(bound, opts.model)) {
        uid = bound;
      } else {
        sticky.unbind(sessionKey);
      }
    }
    if (!uid) {
      uid = pool.pick(uids, {
        exclude: [...exclude, ...busy],
        model: opts.model,
        paid: opts.paid,
        // FEFO（最早到期优先）：调用方算好的「有临期积分批次」uid 集合，
        // 非空时池把候选限制在集合内（pool.pick 的 expiring 语义），把临期
        // 额度先烧掉。集合为空/null 时无感。
        expiring: opts.expiring,
      });
      if (uid == null) return null;
    }
    if (pool.acquire(uid)) {
      if (sessionKey) sticky.bind(sessionKey, uid);
      return { account: byUid.get(uid), uid, sessionKey };
    }
    busy.add(uid);
    if (sessionKey) sticky.unbind(sessionKey);
    if (busy.size >= uids.length) return null;
  }
}

/** 释放一次请求占用的在途名额（调用方 finally 里调；uid 无效时静默） */
function release(uid) {
  try { pool.release(uid); } catch (e) { /* 释放失败不影响请求结果 */ }
}

/**
 * `pickCandidate` 返回 null 时，给调用方一个**准确的原因**。
 *
 * 为什么不复用一句「没有可用账号」：不可用的成因决定客户端该做什么——
 *  - 软冷却（限流）→ 应该回 429，客户端会自动退避重试；
 *     报成 503 会被当成「通道挂了」，用户看到的就是「Qoder 用不了」，
 *     而真实条件是上游让我们等 30 秒。
 *  - 硬冷却/熔断/禁用/暂停/在途满 → 503，这些要人去管理端处理或等更久。
 *
 * @returns {{usable:boolean, nextInMs:number, softOnly:boolean, busy:boolean}}
 *   nextInMs 最早恢复的冷却剩余毫秒（没有可恢复的冷却时为 0）
 */
function availability(channel, candidates, opts = {}) {
  const list = (candidates || []).filter((a) => a && a.id !== undefined);
  const maxInFlight = Number(opts.inFlightMax) > 0 ? Number(opts.inFlightMax) : DEFAULTS.inFlightMax;
  let nextInMs = 0;
  let softOnly = true;
  let busy = false;
  let seen = 0;
  for (const a of list) {
    const uid = uidOf(channel, a.id);
    let st = null;
    try { st = pool.status(uid); } catch (e) { continue; }
    if (!st) continue;
    seen++;
    const mc = opts.model ? (st.model_cooldowns || []).find((m) => m.model === opts.model) : null;
    const modelCooled = !!mc;
    if (st.state === 'healthy' && !st.floor_blocked && !modelCooled) {
      if ((st.in_flight || 0) >= maxInFlight) { busy = true; softOnly = false; continue; }
      return { usable: true, nextInMs: 0, softOnly: false, busy };
    }
    // 账号健康、只是**这个模型**在排队：属于「稍后再来」（429 + 可重试），
    // 不是通道故障（503）。少了这条分支，模型级冷却会掉进下面的
    // `!st.cooling` → softOnly=false，客户端拿到 503 直接放弃重试。
    if (modelCooled && st.state === 'healthy' && !st.floor_blocked) {
      const ms = Math.max(0, (mc.until || 0) - Date.now());
      if (ms > 0 && (!nextInMs || ms < nextInMs)) nextInMs = ms;
      continue;
    }
    if (!st.cooling) { softOnly = false; continue; }          // disabled / paused / 保底拦截
    if (st.cool_kind !== 'soft') softOnly = false;            // breaker / hard
    const ms = Math.max(0, (st.cool_remaining_s || 0) * 1000);
    if (ms > 0 && (!nextInMs || ms < nextInMs)) nextInMs = ms;
  }
  return { usable: false, nextInMs, softOnly: seen > 0 && list.length > 0 && softOnly, busy };
}

/** 成功喂池（清熔断/软退避/防误杀计数） */
function noteSuccess(channel, id) {
  try { pool.noteSuccess(uidOf(channel, id)); } catch (e) { /* 喂池失败不影响请求 */ }
}

/**
 * 各通道「免费额度重置」的本地时刻（小时）。402（额度耗尽）的**硬冷却必须
 * 结束在这个点**，不能用池的默认值。
 *
 * 池的默认是次日 **04:00**（`pool.msUntilNext4AM`），那是给**搭子**的——
 * 它的签到窗口在凌晨 4 点。而**千问的每日免费额度是 00:00 自动重置**
 * （实测：`wallet.valid_to` 是 `T00:00:00+08:00`，且当天零请求的账号次日也
 * 恢复满额）。照 04:00 冷却会让千问账号在 00:00~04:00 这 4 小时里明明有满额
 * 可用，却被本地直接跳过——实测 2026-10-29：账号 2 的 402 把冷却设到次日
 * 04:00，而它 00:00 就会回满 100 积分。
 *
 * 不在表里的通道（搭子/dumate、TRAE、Qoder）沿用池的默认。
 */
const QUOTA_RESET_HOUR = { qwenwork: 0 };

/** 下一个「整点 hour」距现在多少毫秒（今天是 hour 点且已过，就顺延到明天） */
function msUntilHour(hour, now = Date.now()) {
  const d = new Date(now);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0);
  if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  return Math.max(1000, target.getTime() - now);
}

/**
 * 失败喂池。info 与 web-pool.markFailure 同形：字符串/Error 按网络类，
 * 或 { status, code, message, model } 交给 classify 定类别。
 * 池动作（软冷却/硬冷却/模型负缓存/防误杀/熔断）由类别决定，这里不判。
 */
function noteError(channel, id, info) {
  try {
    const cls = (typeof info === 'string' || info instanceof Error)
      ? classify({ status: 0, message: info instanceof Error ? info.message : info })
      : classify(info);
    // 额度耗尽（hard）的冷却时长按**该通道的额度重置时刻**给，见 QUOTA_RESET_HOUR
    const resetHour = QUOTA_RESET_HOUR[channel];
    if (cls && cls.kind === 'hard' && cls.durationMs == null && resetHour != null) {
      cls.durationMs = msUntilHour(resetHour);
    }
    pool.noteError(uidOf(channel, id), cls);
  } catch (e) { /* 喂池失败不影响请求 */ }
}

// 测试与运维观测入口（不改变运行行为）
function _stickySize() { return sticky.size(); }
function _stickyClear() { sticky.clear(); }

module.exports = {
  uidOf, sessionKeyOf, pickCandidate, availability, release, noteSuccess, noteError,
  _stickySize, _stickyClear,
};
