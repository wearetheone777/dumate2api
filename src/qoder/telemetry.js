// src/qoder/telemetry.js - Qoder 风控信号遥测（P1-11）
//
// 出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P1-11「`/health` 风控信号遥测 +
// 健康端点身份标识」。
//
// **要回答的问题**：「Qoder 现在到底是被限流、在排队，还是账号坏了？」
// 这三个状态在客户端看起来**完全一样**（都要等），但处置完全不同：
//   排队/限流 → 等，别动账号
//   账号坏了 → 换号 / 重新登录
// 而排障时只能翻 JSONL 埋点。这里把三类信号做成滚动窗口计数，`/health`
// 直接读——探活脚本与运维一眼就能分辨。
//
// 三类信号（判据全部复用既有实现，不另写一套）：
//   queued    信封型排队（10605 / isQueued / serviceAvailable:false）
//   throttled CALL_COUNT_LIMIT 一类的调用配额限流（等久了会恢复）
//   rejected  内容审核拒绝 / 模型不可用（换号无用，请求本身的问题）
//
// **窗口是环形桶**（默认 10 分钟、12 个桶），不是滑动数组：高并发下每请求
// 都往数组里 push 会让内存随流量线性增长，而这里只需要「最近 N 分钟多少条」。
//
// 计数**只用于观测**，绝不参与任何判定——把遥测接进选号会让一次采样抖动
// 直接变成路由决策（本项目在「探针不喂池」上已经踩过一次）。
const BUCKETS = 12;
const WINDOW_MS = 10 * 60 * 1000;

/** 每桶 { at, queued, throttled, rejected, ok, total, lastQueueType } */
let ring = [];
let startedAt = Date.now();

function bucketAt(now) {
  const size = Math.floor(WINDOW_MS / BUCKETS);
  const idx = Math.floor(now / size);
  // 清理过期桶：保留最近 BUCKETS 个不同 idx
  ring = ring.filter((b) => idx - b.idx < BUCKETS);
  let b = ring.find((x) => x.idx === idx);
  if (!b) {
    b = { idx, queued: 0, throttled: 0, rejected: 0, ok: 0, total: 0, lastQueueType: '', lastAt: 0 };
    ring.push(b);
  }
  return b;
}

/**
 * 记一条上游结果。**永不抛**（埋点绝不能影响正在转发的响应）。
 *
 * @param {'ok'|'queued'|'throttled'|'rejected'} kind
 * @param {{queueType?:string, now?:number}} [info]
 */
function note(kind, info = {}) {
  try {
    const now = Number(info.now) || Date.now();
    const b = bucketAt(now);
    b.total++;
    b.lastAt = now;
    if (kind === 'ok') b.ok++;
    else if (kind === 'queued') {
      b.queued++;
      if (info.queueType) b.lastQueueType = String(info.queueType);
    } else if (kind === 'throttled') b.throttled++;
    else if (kind === 'rejected') b.rejected++;
  } catch (e) { /* 埋点失败绝不影响请求 */ }
}

/**
 * 把分类结果映射成遥测种类（纯函数，离线可测）。
 *
 * 判据复用 upstream-errors 的既有常量，**不新写一套正则**——两套判据必然漂移，
 * 而「遥测说在排队、实际进了 breaker」这种自相矛盾比没有遥测更糟。
 *
 * @param {{throttled?:boolean, policy?:boolean, kind?:string, message?:string, status?:number}} cls
 * @returns {'ok'|'queued'|'throttled'|'rejected'}
 */
function kindOf(cls) {
  if (!cls) return 'rejected';
  if (cls.policy === true) return 'rejected';
  if (cls.throttled === true || cls.kind === 'soft') {
    // 信封型排队（serviceAvailable:false）与调用配额限流分开计数：
    // 前者等多久都不保证放行，后者等久了确实会恢复
    return queuedByEnvelope(cls.message) ? 'queued' : 'throttled';
  }
  if (cls.kind === 'model') return 'rejected';
  return 'rejected';
}

function queuedByEnvelope(message) {
  try {
    const ue = require('../upstream-errors');
    return ue.QUEUE_TEXT.test(ue.unescapeDeep(String(message || '')));
  } catch (e) { return false; }
}

/** 滚动窗口汇总（给 /health） */
function snapshot(now = Date.now()) {
  try {
    bucketAt(now); // 触发一次清理
    const size = Math.floor(WINDOW_MS / BUCKETS);
    const curIdx = Math.floor(now / size);
    const live = ring.filter((b) => curIdx - b.idx < BUCKETS);
    const sum = (k) => live.reduce((s, b) => s + (b[k] || 0), 0);
    const total = sum('total');
    const queued = sum('queued');
    const throttled = sum('throttled');
    const rejected = sum('rejected');
    const lastQueue = live.filter((b) => b.lastQueueType).sort((a, b) => b.lastAt - a.lastAt)[0];
    return {
      windowMs: WINDOW_MS,
      // since 是**进程启动**时刻，不是「有数据的最早时刻」：窗口内 0 条时
      // 前者能说清「刚起来还没流量」，后者会被读成「一直没有流量」
      since: startedAt,
      total,
      ok: sum('ok'),
      queued,
      throttled,
      rejected,
      // 排队/限流占比：>0 说明「通道没问题，是上游让我们等」——这是
      // 「Qoder 用不了、网页版正常」那类投诉的第一判据
      waitRatio: total > 0 ? Number(((queued + throttled) / total).toFixed(3)) : null,
      lastQueueType: lastQueue ? lastQueue.lastQueueType : '',
      lastAt: live.reduce((m, b) => Math.max(m, b.lastAt || 0), 0) || null,
      note: '只统计本进程内的上游结果（滚动 10 分钟，12 个环形桶）。'
        + 'queued = 信封型排队（等多久都不保证放行）；throttled = 调用配额限流（等久了会恢复）；'
        + 'rejected = 审核拒绝/模型不可用（换号无用）。计数只用于观测，不参与选号。',
    };
  } catch (e) {
    return null;
  }
}

/**
 * 软隔离判据：窗口内全是「等」类失败、且没有任何成功——「通道没坏，是上游
 * 让我们等」。用于把 `/health` 的 overall 从 503 降级成 200 + wait。
 *
 * **故意保守**：只要有 1 条成功就返回 false（说明通道是通的，不需要降级），
 * 样本不足（<minSamples）也返回 false（少量请求不足以判断）。宁可让探活报红
 * 一次，也不要因为两条限流就把「真的坏了」藏起来。
 */
function waitOnly({ minSamples = 5 } = {}) {
  const s = snapshot();
  if (!s || s.total < minSamples) return false;
  return s.ok === 0 && s.rejected === 0 && (s.queued + s.throttled) > 0;
}

/** 仅供测试：清空环形桶 */
function _resetForTest() {
  ring = [];
  startedAt = Date.now();
}

module.exports = { WINDOW_MS, BUCKETS, note, kindOf, snapshot, waitOnly, _resetForTest };
