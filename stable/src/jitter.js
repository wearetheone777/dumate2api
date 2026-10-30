// src/jitter.js - 请求节奏抖动与确定性错峰（风控：打散「多账号同步」特征）
//
// 为什么需要这个模块：本项目此前**请求路径上没有任何 jitter**（只在定时
// 任务侧有 keepalive.computeNextRunAt 与 task-scheduler 的 ±20%）。于是
// 一批同一时刻到期的账号会在同一秒集体打 token 端点 / 同一秒集体重试，
// 在 auth 侧形成「单 IP 批量刷新」与「同步重试」两个最典型的机器人特征。
//
// 三条纪律，改动时别破坏：
//
// 1. **错峰偏移必须是确定性的**（从账号 id 稳定哈希派生），不能用随机。
//    随机偏移每次启动都变，等于每次重启都换一批刷新时刻，反而更像异常；
//    确定性偏移跨重启不变，上游看到的仍是「这个号一直是这个点刷」。
//    依据：codex-proxy-rs 的 refresh_stagger / stable_factor（FNV-1a 派生
//    0.8~1.2 倍率），注释原话是「固定周期扫描会让到期时刻相同的账号在
//    同一轮齐刷，在 auth 侧形成单 IP 批量刷新特征」。
//
// 2. **重试抖动必须是随机的**（每次失败独立采样）。错峰解决的是「多个账号
//    互相错开」，抖动解决的是「同一批并发请求不要同步重试」。两者目标不同，
//    不要互相替代——把抖动做成确定性会让并发请求一起退避、一起重发。
//    量级取 50~250ms（codex-proxy-rs 的 server_error_retry_jitter），
//    这个量级对用户体验无感，但足以打散同批重试。
//
// 3. **只追加，不缩短**（catalogJitterMs 那条）。周期刷新任务加抖动只能把
//    时刻往后推，不能提前——提前会让「刚启动就全量刷新」，且可能与上一轮
//    的错峰冲突。
//
// 全部是纯函数、零 IO、零第三方依赖，方便离线验证：
// node test/verify-jitter.js

const crypto = require('crypto');

/** [0,1) 区间的确定性单位值。同一 key 恒返回同一个数，跨进程/跨重启一致。 */
function hashUnit(key) {
  const h = crypto.createHash('sha256').update(String(key), 'utf8').digest();
  // 取前 4 字节当 uint32，除以 2^32 → [0,1)。
  // 用 4 字节而不是 1 字节：1 字节只有 256 个取值，账号一多就会撞成同一偏移。
  return h.readUInt32BE(0) / 4294967296;
}

/**
 * 确定性错峰偏移：把 `spanMs` 按 key 稳定地摊开，返回 [0, spanMs) 的毫秒。
 *
 * 用法（token 刷新）：把「提前量」加长这个偏移，即
 *   needsRefresh = remaining <= margin + staggerMs(accountId, margin)
 * 于是 margin 相同的 N 个账号会各自在不同时刻进入刷新窗口，而不是一起。
 *
 * spanMs <= 0 时返回 0（调用方关掉错峰的行为不回退）。
 */
function staggerMs(key, spanMs) {
  const span = Number(spanMs);
  if (!Number.isFinite(span) || span <= 0) return 0;
  return Math.floor(hashUnit(`${key}\0stagger`) * span);
}

/**
 * 重试抖动：随机 [minMs, maxMs)，每次调用独立采样。
 * 默认 50~250ms（对下游无感、足以打散同批重试）。
 */
function retryJitterMs(opts = {}) {
  const min = Number.isFinite(opts.min) ? opts.min : 50;
  const max = Number.isFinite(opts.max) ? opts.max : 250;
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min));
}

/**
 * 周期性任务的单侧抖动：返回 [0, spanMs * ratio) 的**确定性**偏移，
 * 只用于把计划时刻往后推（纪律 3）。默认 ratio 0.2（0~20%）。
 */
function catalogJitterMs(key, spanMs, ratio = 0.2) {
  const span = Number(spanMs);
  if (!Number.isFinite(span) || span <= 0) return 0;
  const r = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0.2;
  return Math.floor(hashUnit(`${key}\0catalog`) * span * r);
}

/** 便捷：等 ms 毫秒（抖动后 sleep 用）。不传或 <=0 立即 resolve。 */
function sleep(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}

/**
 * 指数退避 + 抖动：第 attempt 次（从 1 开始）的等待 = base * 2^(attempt-1)，
 * 夹在 [0, capMs]，再叠一次随机抖动。
 * 用于「同一账号原地重试」——注意这只适用于**瞬时**错误；确定性错误
 * （413 / 模型不在套餐）重发同一份字节必然得到同一个失败，应当换号而不是重试。
 */
function backoffMs(attempt, opts = {}) {
  const base = Number.isFinite(opts.base) ? opts.base : 5000;
  const cap = Number.isFinite(opts.cap) ? opts.cap : 300000;
  const n = Math.max(1, Number(attempt) || 1);
  const raw = Math.min(base * Math.pow(2, n - 1), cap);
  return Math.min(raw + retryJitterMs(opts), cap);
}

module.exports = {
  hashUnit,
  staggerMs,
  retryJitterMs,
  catalogJitterMs,
  backoffMs,
  sleep,
};
