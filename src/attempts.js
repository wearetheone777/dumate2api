// src/attempts.js - 单次请求的「尝试链」（2026-11-16 调研 P1-5）
//
// ## 为什么需要
//
// 请求日志原来只有一行结论（状态码 / 账号 / 耗时），于是「为什么这个号被跳过」
// 「这次为什么换号」「为什么最后是 503」只能靠人肉翻代码 + 猜。P0-3 那批判据
// （认证拒绝不重放、冷却隔离、跨区容灾、降级）都需要一个**可读的时间轴**来验证
// 它们在真实流量里到底有没有按预期起作用。
//
// ## 只有判据，没有报文
//
// 刻意**不记录请求体/响应体**：体积与隐私都不是这里该付的代价，而排障真正需要
// 的是「谁、什么时候、因为什么、结果如何」。字段固定五项：
//   accountId  账号 id（能回查账号，显示名会改会重名）
//   account    当时的显示名（给人看的）
//   outcome    picked | ok | error | skip | failover
//   reason     判据/分类（如 session_dead / cooling / 无可用账号的原因）
//   at / ms    相对请求开始的毫秒数（绝对时间戳与日志行重复，不存）
//
// ## 上限与截断
//
// 最多记 `limit` 条（默认 8）：正常请求 2~3 条，跨区+降级最多 5~6 条，
// 再多说明有循环——截断而不是无限长，并置 `truncated` 让读的人知道
// 「后面还有，别以为就这些」。
const DEFAULT_LIMIT = 8;

/**
 * @param {{limit?:number, now?:()=>number, t0?:number}} [opts]
 *   t0 请求起点（默认构造时刻），`at`/`ms` 都相对它
 */
function create(opts = {}) {
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : DEFAULT_LIMIT;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const t0 = Number.isFinite(opts.t0) ? opts.t0 : now();
  const list = [];
  let truncated = false;

  function add(entry = {}) {
    const at = now() - t0;
    if (list.length >= limit) { truncated = true; return null; }
    const item = {
      accountId: entry.accountId == null ? null : Number(entry.accountId),
      account: String(entry.account || '').slice(0, 60),
      outcome: String(entry.outcome || 'note').slice(0, 16),
      reason: String(entry.reason || '').slice(0, 120),
      at,
    };
    if (entry.ms != null && Number.isFinite(Number(entry.ms))) item.ms = Math.max(0, Number(entry.ms));
    // P1-3：上游诊断码/请求 ID（只记标识，不记报文正文与凭证）
    if (entry.upstreamCode != null && String(entry.upstreamCode).trim()) {
      item.upstreamCode = String(entry.upstreamCode).slice(0, 40);
    }
    if (entry.upstreamRequestId != null && String(entry.upstreamRequestId).trim()) {
      item.upstreamRequestId = String(entry.upstreamRequestId).slice(0, 120);
    }
    // P1-3：失败阶段（auth / upstream / http / throttle / network）。
    // 与 upstreamCode 是两回事：码是上游给的，阶段是**我们**判定的
    // 「这一步错在哪」——排障先看阶段，再看码。
    if (entry.stage != null && String(entry.stage).trim()) {
      item.stage = String(entry.stage).slice(0, 20);
    }
    list.push(item);
    return item;
  }

  /** 概率型汇总：给日志行一个「几次尝试」的读数（详情仍看 attempts 数组） */
  function summary() {
    const counts = {};
    for (const x of list) counts[x.outcome] = (counts[x.outcome] || 0) + 1;
    return { n: list.length, truncated, counts };
  }

  return {
    add,
    list: () => list.slice(),
    json: () => ({ attempts: list.slice(), attempts_truncated: truncated }),
    summary,
    get length() { return list.length; },
    get truncated() { return truncated; },
    limit,
  };
}

module.exports = { create, DEFAULT_LIMIT };
