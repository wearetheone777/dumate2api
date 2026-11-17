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
const throttle = require('./throttle');

const sticky = createSticky();

function uidOf(channel, id) {
  return `${channel}:${id}`;
}

/**
 * 取「文本」：字符串直接用，parts 数组**按原顺序直接拼接**所有 text 片段。
 *
 * 拼接用空串而不是换行：`[{text:'同一段'},{text:'话'}]` 与 `'同一段话'` 是同一段
 * 话的两种编码，键必须一致——否则同一段 system 经不同协议/不同客户端进来会
 * 分裂成两个粘性键，粘性等于没做。指纹只用于本地选号，不需要保留换行语义。
 */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : ''))
      .join('');
  }
  return '';
}

/**
 * 会话的 system 文本（**跨协议同一口径**）：Anthropic 入口在顶层 `system`，
 * OpenAI 入口在 `messages` 里 role=system 的第一条。两处都认，才能保证
 * 「同一段话经不同协议进来」拿到同一个指纹。
 */
function systemTextOf(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const top = textOf(payload.system);
  if (top.trim()) return top;
  const msgs = Array.isArray(payload.messages) ? payload.messages : [];
  const sys = msgs.find((m) => m && m.role === 'system');
  return sys ? textOf(sys.content) : '';
}

/**
 * 会话键。优先 opts.sessionKey；否则用**首条 user 文本 + system**的短指纹。
 * 取不到首条 user（空消息/非标准形状）返回空串 = 本请求不粘，走普通轮询。
 *
 * **为什么必须含 system（2026-11-16，调研 P2-11）**：只看首条 user 时，「继续」
 * 这种一句话开场的会话在**不同 system** 下会撞同一个键——两个项目共用一段
 * 「继续」就共用一个粘性账号，前一秒还在 A 项目上下文里，后一秒被塞进 B 项目
 * 的前缀缓存，命中率与上下文恢复成本双双恶化。
 *
 * 三个已确认的前提（不成立时这条改动就该回退）：
 *   1. 两个协议都把 system **每轮重发**（Claude Code 顶层 `system`；Codex/OpenAI
 *      在 messages 里）——所以同一会话的 system 在轮次之间是稳定的，键也稳定；
 *   2. 绑定表**只在内存**（`sticky.js`），升级即随进程重启清空，没有迁移问题；
 *   3. 键只在本地用（选号 + 粘性表），不进上游、不进日志原文。
 *
 * system 用**全文**哈希而不截断：system 的差异常在尾部（追加的项目约定），
 * 截断会把「改过的 system」认成同一个；user 侧仍截 2048（那是既有的稳定锚点）。
 */
function sessionKeyOf(payload, opts) {
  if (opts && opts.sessionKey != null && String(opts.sessionKey).trim()) {
    return `k:${String(opts.sessionKey).trim()}`;
  }
  try {
    const msgs = payload && Array.isArray(payload.messages) ? payload.messages : [];
    const first = msgs.find((m) => m && m.role === 'user');
    const text = first ? textOf(first.content) : '';
    if (!text.trim()) return '';
    const sys = systemTextOf(payload);
    const digest = crypto.createHash('sha1')
      .update(sys)
      .update('\u0000')                       // 分隔符：防「system 尾部 + user 头部」拼出同一串
      .update(text.slice(0, 2048))
      .digest('hex')
      .slice(0, 20);
    return `m:${digest}`;
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

// ---------------------------------------------------------------------------
// 节奏闸门（2026-11-04，DEV-CHECKLIST #15 / 融合 qoder2api-hub 风控文档）
//
// 两层，都**默认关**（不配 env / 面板不填时行为与之前逐字节一致）：
//   1. 通道级在途帽 DUMATE_{CHANNEL}_INFLIGHT_MAX —— 覆盖池默认的
//      inFlightMax（4）。Qoder 的 10605 排队是 (账号, 模型) 粒度的请求级
//      随机，但单账号并发过高会推高风控画像；hub 的处置等级里「单号并发
//      闸门」是防 10605 的第一道。
//   2. 账号最小请求间隔 DUMATE_{CHANNEL}_MIN_INTERVAL_MS —— 上次选号后
//      不足间隔的账号本轮跳过（busy，不惩罚）。判据是「上次 pick 时刻」
//      而不是「上次 release」：间隔约束的是发射节奏，不是请求时长。
// 两个值都只在 pickCandidate / availability 里消费；先埋点观察 10605 率
// 再定阈值，所以默认全关。
//
// 2026-11-16（调研 P1-9）：两个旋钮从「只认环境变量」升级为**面板可热改**。
// 取值一律经 `src/throttle.js`（优先级 面板 > env > 内置默认），本文件不再
// 直接读 process.env —— 两套读法会让界面显示与实际生效静默不一致。
// ---------------------------------------------------------------------------

/** 通道级在途帽（0 = 用池默认）。面板 > env > 0。 */
function inflightMaxOf(channel) {
  const v = throttle.knob(channel, 'inflightMax');
  return v == null ? 0 : v;
}

/** 账号最小请求间隔毫秒（0 = 关）。面板 > env > 0；面板填 0 是**显式关断**。 */
function minIntervalMsOf(channel) {
  const v = throttle.knob(channel, 'minIntervalMs');
  return v == null ? 0 : v;
}

// 上次选号时刻（uid → ts）。进程内即弃——节奏闸门是运行态观测，不落盘。
const lastPickAt = new Map();

/** 该账号是否还在最小间隔内（true = 本轮跳过） */
function withinInterval(uid, minMs, now) {
  if (!minMs) return false;
  const last = lastPickAt.get(uid) || 0;
  return now - last < minMs;
}

/**
 * 算会话键，并**顺手通知调用方**（`opts.onSessionKey`）。
 *
 * 为什么要有这个包装而不是各处直接调 `sessionKeyOf`：请求日志要能按会话分组看
 * 「这条会话为什么换号」，而键是在 provider 里算的、日志是在 server.js 里写的。
 * 让 5 个调用点各自记得回调，迟早漏一个（漏了的表现是「某些通道的会话键恒空」，
 * 且不报错）。所以键的产生与上报绑在同一个函数里。
 *
 * 回调失败一律吞掉：埋点绝不能影响选号。
 */
function sessionKeyFor(payload, opts) {
  const key = sessionKeyOf(payload, opts);
  if (key && opts && typeof opts.onSessionKey === 'function') {
    try { opts.onSessionKey(key); } catch (e) { /* 埋点失败不影响请求 */ }
  }
  return key;
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
  const minMs = minIntervalMsOf(channel);
  const inFlightMax = inflightMaxOf(channel);
  const now = Date.now();

  for (;;) {
    let uid = null;
    if (sessionKey) {
      // 会话暖账号列表优先（front → fallback，hub #718 的 SessionAffinity）：
      // 绑定账号不可用时先试会话的其他暖账号——它们可能还持有上游前缀缓存；
      // 直接跳回池轮询会让长会话每轮换号丢缓存重算 prefill，Token 消耗翻倍。
      for (const warm of sticky.recent(sessionKey)) {
        if (exclude.has(warm) || busy.has(warm)) continue;
        if (!byUid.has(warm)) continue;          // 不在候选内（区域/FEFO/调用方过滤）
        if (withinInterval(warm, minMs, now)) continue;
        if (!stickyUsable(warm, opts.model)) continue;
        if (pool.acquire(warm, inFlightMax ? { inFlightMax } : undefined)) {
          lastPickAt.set(warm, now);
          sticky.bind(sessionKey, warm);         // promote 到 front，原 front 降为 fallback
          return { account: byUid.get(warm), uid: warm, sessionKey };
        }
        busy.add(warm);                          // 在途满：本轮跳过，不惩罚
      }
      // 暖列表全不可用 → 池轮询重选。暖列表不整体清空：池选中的账号会
      // promote 到 front，原 front 自动降为 fallback（真实换号也保留暖副本）。
      // 只有绑定账号被区域/调用方显式排除时才全清重开。
      const bound = sticky.lookup(sessionKey);
      if (bound && (!byUid.has(bound) || exclude.has(bound))) {
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
        // 通道级在途帽（env 配了才生效；0 = 池默认）
        ...(inFlightMax ? { inFlightMax } : {}),
      });
      if (uid == null) return null;
      // 闸门放在池选择之后（池还不知道间隔这回事）：选中的账号若在最小
      // 间隔内，本轮跳过它继续找——不是账号的错，与 busy 同语义
      if (withinInterval(uid, minMs, now)) {
        busy.add(uid);
        // 不 unbind：暖列表保留（下一轮 promote 时自动重排），全清会丢暖副本
        if (busy.size >= uids.length) return null;
        continue;
      }
    }
    if (pool.acquire(uid, inFlightMax ? { inFlightMax } : undefined)) {
      lastPickAt.set(uid, now);
      if (sessionKey) sticky.bind(sessionKey, uid);
      return { account: byUid.get(uid), uid, sessionKey };
    }
    busy.add(uid);
    // 不 unbind：同上，promote 到 front 的账号下一轮被 busy 挡住，暖副本保留
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
  const maxInFlight = Number(opts.inFlightMax) > 0 ? Number(opts.inFlightMax)
    : (inflightMaxOf(channel) || DEFAULTS.inFlightMax);
  const minMs = minIntervalMsOf(channel);
  const now = Date.now();
  let nextInMs = 0;
  let softOnly = true;
  let busy = false;
  let seen = 0;
  // 逐账号判据（P1-5 尝试链的数据源）：只给「为什么没选它」，最多 20 条。
  // 不记录凭证、不记录模型内容——理由都是本地状态词，可以直接进请求日志。
  const details = [];
  const DETAIL_MAX = 20;
  const why = (a, reason) => {
    if (details.length >= DETAIL_MAX) return;
    details.push({ id: Number(a.id), name: String(a.nickname || a.uid || '').slice(0, 40), reason });
  };
  for (const a of list) {
    const uid = uidOf(channel, a.id);
    let st = null;
    try { st = pool.status(uid); } catch (e) { continue; }
    if (!st) continue;
    seen++;
    const mc = opts.model ? (st.model_cooldowns || []).find((m) => m.model === opts.model) : null;
    const modelCooled = !!mc;
    if (st.state === 'healthy' && !st.floor_blocked && !modelCooled) {
      if (withinInterval(uid, minMs, now)) { why(a, 'interval'); busy = true; softOnly = false; continue; }
      if ((st.in_flight || 0) >= maxInFlight) { why(a, 'inflight'); busy = true; softOnly = false; continue; }
      return { usable: true, nextInMs: 0, softOnly: false, busy, details };
    }
    // 账号健康、只是**这个模型**在排队：属于「稍后再来」（429 + 可重试），
    // 不是通道故障（503）。少了这条分支，模型级冷却会掉进下面的
    // `!st.cooling` → softOnly=false，客户端拿到 503 直接放弃重试。
    if (modelCooled && st.state === 'healthy' && !st.floor_blocked) {
      const ms = Math.max(0, (mc.until || 0) - Date.now());
      if (ms > 0 && (!nextInMs || ms < nextInMs)) nextInMs = ms;
      why(a, `model_cooling:${mc.model || ''}`);
      continue;
    }
    if (!st.cooling) { softOnly = false; why(a, st.disabled ? 'disabled' : (st.paused ? 'paused' : 'floor_blocked')); continue; }
    if (st.cool_kind !== 'soft') softOnly = false;            // breaker / hard
    const ms = Math.max(0, (st.cool_remaining_s || 0) * 1000);
    if (ms > 0 && (!nextInMs || ms < nextInMs)) nextInMs = ms;
    why(a, `cooling:${st.cool_kind || ''}`);
  }
  return {
    usable: false, nextInMs, softOnly: seen > 0 && list.length > 0 && softOnly, busy,
    details, details_truncated: details.length >= DETAIL_MAX,
  };
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
  uidOf, sessionKeyOf, sessionKeyFor, systemTextOf, pickCandidate, availability, release, noteSuccess, noteError,
  _stickySize, _stickyClear,
};
