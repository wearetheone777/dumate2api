// src/qwenwork/cooldown.js - 千问「无可用账号」归因与冷却概况（2026-11-27 融合 P0-2）
//
// **模型级冷却的记账与选号过滤不在此处**——它们早已在 `src/pool.js`
// （`model_cooldowns`、`applyModelSoftCooldown` / `applyModelBlock`）与
// `src/channel-pool.js`（`pickCandidate` 的 `opts.model` 过滤、`availability`
// 的逐账号归因）里实现，且调优比社区仓库的 60s 默认更精细（5min 基数、
// 指数退避、2h 封顶；模型负缓存 6h 起、命中翻倍、24h 封顶）。**不在这里
// 再写一份冷却表**——同一事实写两份，迟早不一致。
//
// 本模块只做**归因文案**：把 `availability()` 的逐账号原因压成四态，并带
// 冷却概况。纯函数、无副作用，可单测。
//
// 为什么不能压成一句「没有可用账号」：不可用的成因决定客户端该做什么——
//   - 软冷却（限流/模型级）→ 429，客户端自动退避重试；
//   - 硬冷却（额度用尽）→ 等额度重置（千问 00:00），报 503 等人处理；
//   - 全停用/暂停 → 要去管理端启用；
//   - 在途满/最小间隔 → 并发闸门，稍后重试。
const REASON_COOLING = /^cooling:/;
const REASON_MODEL_COOLING = /^model_cooling:/;
const REASON_HARD = /^cooling:hard/;

/**
 * 把 availability() 的结果归因为「无可用账号」错误。
 *
 * @param {object} av channelPool.availability() 的返回体
 *   （usable / nextInMs / softOnly / busy / details[]）
 * @param {number} accountCount 候选账号总数（0 = 没添加任何账号）
 * @returns {Error} 带 statusCode / noAccount / retryAfterMs / cooldown /
 *   noAccountDetails 的错误，文案按四态分开报
 */
function attributeNoAccount(av, accountCount) {
  const details = (av && Array.isArray(av.details)) ? av.details : [];
  const reasons = details.map((d) => d.reason);
  const cooling = reasons.filter((r) => REASON_COOLING.test(r) || REASON_MODEL_COOLING.test(r));
  const hard = reasons.filter((r) => REASON_HARD.test(r));
  const disabled = reasons.filter((r) => r === 'disabled' || r === 'paused');
  const busy = reasons.filter((r) => r === 'interval' || r === 'inflight');
  const floor = reasons.filter((r) => r === 'floor_blocked');

  let cause;
  if (!accountCount) {
    cause = '尚未添加千问账号';
  } else if (disabled.length === reasons.length && reasons.length) {
    cause = '账号全部停用或暂停';
  } else if (hard.length) {
    // 硬冷却 = 额度耗尽（402）。千问额度 00:00 重置，nextInMs 会指到那个点。
    cause = '额度用尽（硬冷却）';
  } else if (cooling.length) {
    cause = '全部账号在冷却（限流或模型级冷却）';
  } else if (busy.length === reasons.length && reasons.length) {
    cause = '全部账号在途满或处于最小请求间隔';
  } else if (floor.length === reasons.length && reasons.length) {
    cause = '账号余额低于保留下限';
  } else {
    cause = '没有可用账号';
  }

  const nextInMs = av && av.nextInMs ? av.nextInMs : 0;
  const err = new Error(`千问办公${cause}，可到管理端账号池查看或复活`);
  // 软冷却（限流）→ 429，客户端自动退避重试；其余 → 503 等人处理或等重置。
  err.statusCode = (av && av.softOnly) ? 429 : 503;
  err.noAccount = true;
  if (nextInMs > 0) {
    err.retryAfterMs = nextInMs;
    // 冷却概况：几个号在冷却、最早多久恢复，客户端能看到恢复时间
    err.cooldown = { coolingCount: cooling.length, nextInMs };
  }
  if (details.length) err.noAccountDetails = details;
  return err;
}

module.exports = { attributeNoAccount };
