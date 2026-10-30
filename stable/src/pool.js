// src/pool.js - 账号池惩罚-恢复状态机（GAP F1,施工包 A;对齐 codebuddyManager
// workbuddy2api/internal/pool 的体系,按 dumate 的单进程 + JSON 落盘形态重写）
//
// ============================================================
// 为什么需要它
//
// web-pool.js 旧运行态只有一层固定时长内存冷却（连续 3 败 → 冷却 5 分钟,
// 重启清零）:429 与 5xx 同一处理、没有熔断退避、没有按余额拦路由、没有
// 运维复活入口。参照实现的 pool 包是完整的惩罚-恢复状态机,本模块把其中
// 与 dumate 形态匹配的部分移植过来（零依赖,只用 node: 标准库）:
//
//   - 多类冷却域: soft（429 限流,有界指数退避,冷却中不叠加）/ hard
//     （余额耗尽,冷却到下一次签到窗口）/ 模型级负缓存（403 模型不可用,
//     切模型即可用）。错误类别来自 upstream-errors.classify（Q3 映射表）。
//   - 熔断器: 5xx/网络类反复失败计数,达阈值指数退避封禁,与冷却域正交
//     （冷却管「被限流/没钱」,熔断管「服务坏了」）。
//   - session_dead 防误杀: 401 类连续计数达阈值才禁用,成功/复活清计数
//     （对齐 codebuddy 的 12153 sessionDeadThreshold 缓冲模式——一次 401
//     可能只是上游闪断,直接杀号曾误杀 13 个健康账号）。
//   - 积分保底: 余额快照低于阈值时对收费模型拦路由（纯函数判据在本模块）。
//   - 复活/解冻 API + 在途并发帽。
//   - 落盘持久化: data/pool-state.json,重启恢复;恢复时清理过期态
//     （GAP N8:「置位忘清理」的坑只在持久化后出现,必须在恢复路径处理）。
//
// 迁移矩阵（事件 → 动作 → 字段,对齐 transition.go 的正交性设计）:
//
//   cooldown{kind,until,reason} ← noteError(soft/hard) / freeze / 冷却自然到期
//   soft_streak                 ← noteError(soft) 有界退避;noteSuccess/revive 清
//   model_cooldowns             ← noteError(model);账号级冷却清它;noteSuccess 不清
//                                 （每模型独立计时,其他模型的成功不得抹掉）
//   breaker{fails,retry,until}  ← noteError(breaker);noteSuccess 清;disable 保留
//                                 （熔断是 5xx 观测,与授权/会话无关）
//   session_dead_fails          ← noteError(session_dead);noteSuccess/revive 清
//   disabled(+reason)           ← session_dead 达阈 / disable();清冷却域、保留熔断
//   paused                      ← pause();不动任何惩罚域（临时让位,随时 resume）
//
// ============================================================
// 接口契约（供 B 包保活调度 / 集成接线调用）
//
// 默认单例 `pool`（web-pool.js 与管理端共用,落盘 data/pool-state.json）,
// 测试用 `createPool(opts)` 建独立实例（可注入 now 时钟与文件路径）。
//
//   —— B 包闭环（签到 → 查余额 → 解冻）——
//   setCredits(id, credits, total)          余额快照写入（保活/签到/手动刷新后）
//   reenableIfCredits(id, credits, total)   余额>0 自动解冻**硬冷却**（不动软冷却/
//                                           模型级/熔断——余额恢复只证明 billing
//                                           通道健康,不证明限流已解除）
//   —— 运维动作（管理端端点在 admin/routes/accounts.js）——
//   freeze(id, ms, reason)   冻结（hard 冷却,余额恢复可解冻）
//   revive(id)               一键复活:清禁用+暂停+全部冷却+熔断+计数
//   disable / pause / resume / clearSessionDead
//   —— 状态机喂入（热路径,web-pool 每请求调用）——
//   noteSuccess(id)          成功即最强恢复证据（清熔断/软退避/防误杀计数）
//   noteError(id, cls)       cls 为 upstream-errors.classify 的输出,按 kind 分发
//   noteSessionDead(id)      401 类防误杀计数的独立入口（= noteError session_dead）
//   blockModel / clearModelBlock / acquire / release
//   —— 查询 ——
//   pick(candidates, {exclude, model, paid})   轮询选一个健康账号 id（跨进程无状态,
//                                              候选由调用方给,池只管惩罚态判定）
//   status(id) / snapshot() / counts() / isHealthy(id)
//
// 持久化与多进程:
//   落盘文件是跨进程共享的（web-gateway 9084 与管理端是两个进程）。热路径
//   （noteSuccess/noteError/acquire）只写内存 + 置脏,由 5s 防抖 flusher 落盘;
//   冷路径运维操作（freeze/revive/reenableIfCredits...）走「锁内读盘→改单条→
//   写盘」,立即对其他进程可见。热进程落盘前按记录级 rev 吸纳其他进程
//   的更新（per-record LWW,rev 是锁内单调递增的版本号,同毫秒写入也能分先后）,
//   防止防抖窗口内的全量写把管理端刚做的冻结盖回去。
//   代价（有意接受）:运维写盘与热进程下一次落盘之间,热进程 ≤5s 内未落盘的
//   该账号热变化会被磁盘记录覆盖——运维操作低频,丢一次冷却计数的代价远小于
//   引入跨进程合并日志的复杂度。
// ============================================================
const fs = require('fs');
const path = require('path');
const filelock = require('./filelock');
const fileperm = require('./fileperm');

const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
const STATE_FILE = process.env.DUMATE_POOL_STATE || path.join(DATA_DIR, 'pool-state.json');

// 默认参数（对齐 codebuddyManager pool 包的默认值,可被 createPool 覆盖）
const DEFAULTS = {
  flushMs: 5000,              // 防抖落盘周期;0 = 不启动 flusher（测试用 flush()）
  breakerThreshold: 3,        // 连续失败多少次触发熔断
  breakerCooldownMs: 30 * 60 * 1000,       // 首次熔断时长
  breakerCooldownMaxMs: 6 * 60 * 60 * 1000, // 熔断指数退避封顶
  softBaseMs: 5 * 60 * 1000,  // 软冷却基数（沿用旧 COOLDOWN_MS,行为不回退）;生产单例被 livecfg.softCooldownMs 热覆盖（>0 时）
  softMaxMs: 2 * 60 * 60 * 1000,           // 软冷却退避封顶（defaultSoftRateMax）
  modelBlockBaseMs: 6 * 60 * 60 * 1000,    // 模型级负缓存首 TTL（11102 语义）
  modelBlockMaxMs: 24 * 60 * 60 * 1000,    // 模型级负缓存封顶
  sessionDeadThreshold: 3,    // 401 类连续计数达阈才禁用（防误杀）
  inFlightMax: 4,             // 每账号在途并发帽（防单账号被打爆触发风控）
  creditFloor: 0,             // 积分保底线;0 = 关闭（余额数据源由 B 包接入）
  // ── 选号（加权抽签，替代纯轮询）───────────────────────────────────────
  // 'weighted' = 按额度/闲置加权随机抽签；'rr' = 回到轮询。
  // 为什么不再取「额度最高的那个」：那是确定性的，最高分号会吃掉全部流量，
  // 而乘性权重会让 credits=0 的号永久饿死（参考实现 pool.go:drawLocked 的
  // 注释就是这两条）。所以额度只做**加性**加成，基线 1.0 保证每个候选都有机会。
  pickMode: process.env.DUMATE_POOL_PICK_MODE === 'rr' ? 'rr' : 'weighted',
  pickGapMs: Number(process.env.DUMATE_POOL_PICK_GAP_MS ?? 100), // 防撞号窗口;0 = 关闭
  creditWeight: Number(process.env.DUMATE_POOL_CREDIT_WEIGHT ?? 10), // 额度加成上限倍数
  idleBonusPerHour: Number(process.env.DUMATE_POOL_IDLE_BONUS_PER_HOUR ?? 1), // 每闲置 1 小时加多少权重
  idleBonusMax: Number(process.env.DUMATE_POOL_IDLE_BONUS_MAX ?? 5), // 闲置加成封顶
};

function newEntry(id) {
  return {
    id: String(id),
    // 身份域（终态）
    disabled: false,
    disabled_reason: '',
    paused: false,
    // 冷却域
    cooldown: { kind: '', until: 0, reason: '' },
    soft_streak: 0,
    model_cooldowns: {}, // model → { until, reason, hits }
    // 熔断域（与冷却域正交）
    breaker: { fails: 0, retry_count: 0, until: 0 },
    // 防误杀计数
    session_dead_fails: 0,
    // 余额快照（floor 判据的数据源,由 setCredits/reenableIfCredits 写入）
    credits: null,
    credits_total: null,
    // 观测计数
    ok_count: 0,
    err_total: 0,
    last_used_at: 0,
    last_success_at: 0,
    last_error: '',
    // 运行态,不落盘:synced_at = 本进程最后一次采纳/写盘该记录的时刻;
    // rev = 该记录最后采纳的落盘版本号（写侧每次 +1,是跨进程 LWW 的裁决序）
    in_flight: 0,
    synced_at: 0,
    rev: 0,
    // 运行态,不落盘:选号用。**pick_seq 必须是单调序号而不是墙钟**——
    // 同毫秒内 last_pick_at 会相等,按它比较会退化成「恒取第一个」,
    // 防撞号窗口的兜底就失效了（参考实现 pool.go:drawLocked 的 usedSeq）。
    pick_seq: 0,
    last_pick_at: 0,
  };
}

/** 冷却到下一个 04:00（本地时区）的毫秒数——余额耗尽等签到恢复的窗口。
 *  凌晨 00:00~04:00 之间命中时等**当天** 04:00（签到尚未执行,等次日会白冷一天）。 */
function msUntilNext4AM(now) {
  const d = new Date(now);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0, 0);
  if (d.getHours() >= 4) target.setDate(target.getDate() + 1);
  return Math.max(1000, target.getTime() - now);
}

function clampMsg(s) {
  return String(s || '').slice(0, 200);
}

/**
 * 创建池实例。
 * @param {object} [opts] DEFAULTS 的键均可覆盖;file 为持久化路径（null = 纯内存）,
 *   now 为时钟注入（测试用）。
 */
function createPool(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const file = o.file || null;
  const nowMs = () => (typeof o.now === 'function' ? o.now() : Date.now());

  const states = new Map(); // id → entry
  let cursor = 0;           // 轮询游标（进程内单调,重启归零无所谓）
  let pickSeqCounter = 0;   // 选号单调序号（防撞号窗口的 LRU 判据,见 markPick）
  let dirty = false;
  let timer = null;
  let lastMtime = 0;

  function ensure(id) {
    const key = String(id);
    let e = states.get(key);
    if (!e) {
      e = newEntry(key);
      states.set(key, e);
    }
    return e;
  }

  function markDirty() {
    if (file) dirty = true;
  }

  // ---------------------------------------------------------------------------
  // 迁移原语（对齐 transition.go:状态字段只经这些原语改动）
  // ---------------------------------------------------------------------------

  /** 清冷却域（until/kind/reason/softStreak/modelCooldowns）;熔断域不动 */
  function clearCooling(e) {
    e.cooldown = { kind: '', until: 0, reason: '' };
    e.soft_streak = 0;
    e.model_cooldowns = {};
  }

  /** 禁用:清冷却域（禁用是更强终态,冷却随之作废）;保留熔断观测 */
  function disableEntry(e, reason) {
    clearCooling(e);
    e.disabled = true;
    e.paused = false; // 禁用与暂停不叠加:禁用须 revive 才能复用
    e.disabled_reason = clampMsg(reason);
  }

  function isHealthy(e, now) {
    if (e.disabled || e.paused) return false;
    if (e.cooldown.until > now) return false;
    if (e.breaker.until > now) return false;
    return true;
  }

  function modelCooled(e, now, model) {
    if (!model) return false;
    const mc = e.model_cooldowns[model];
    return !!(mc && mc.until > now);
  }

  /** 积分保底判据（纯函数）:余额有快照、低于保底线时拦收费模型。
   *  credits 为 null（从未查过余额）不拦——没有数据源不做猜测性拦截。 */
  function floorBlockedFor(e) {
    return o.creditFloor > 0 && Number.isFinite(e.credits) && e.credits < o.creditFloor;
  }

  // ---------------------------------------------------------------------------
  // 热路径:状态机喂入
  // ---------------------------------------------------------------------------

  /**
   * 软冷却。
   *
   * 默认按「基数 × 2^streak」有界退避（429 挡的是「你打太快了」，指数增长
   * 让持续超速的账号越退越久）。但上游主动给了重试时刻时**按它来**：
   * COSY 通道（千问 / Qoder）的排队限流每次都带 `retryAfterSeconds`
   * （实测 30 / 66 秒），套 5 分钟基数会把一个 30 秒的条件放大到 5 分钟
   * 以上，两次请求就能把整个池打进长时间不可用（用户侧就是「通道用不了」）。
   *
   * 已在有效软冷却中仍然不推进/不延长——重试与并发兜底探测不得把冷却
   * 越堆越厚（对齐 CooldownSoftRate：这是「全池被推到封顶」教训的直接防回归）。
   */
  function applySoftCooldown(e, now, reason, retryAfterMs) {
    if (e.cooldown.kind === 'soft' && e.cooldown.until > now) return;
    let d;
    const explicit = Number(retryAfterMs);
    if (Number.isFinite(explicit) && explicit > 0) {
      // 上游明说了多久：夹在 [1s, 软冷却封顶] 之间。不递增 soft_streak——
      // 时长是上游定的，不是「我们又超速了一次」的累计证据。
      d = Math.min(Math.max(explicit, 1000), o.softMaxMs);
      e.cooldown = { kind: 'soft', until: now + d, reason };
      e.model_cooldowns = {};
      return;
    }
    // 热配置软冷却基数（D 包 livecfg ↔ 本模块对接）:>0 生效,<=0/读不到 =
    // 内置默认。仅生产单例开启（hotSoftCooldown）,测试池不读机器真实配置;
    // 错误路径调用频率低,每次现读 mtime 换取管理端 PUT 后下一个 429 即新口径。
    let base = o.softBaseMs;
    if (o.hotSoftCooldown) {
      try {
        const hot = require('./livecfg').Load().softCooldownMs;
        if (Number.isFinite(hot) && hot > 0) base = hot;
      } catch (err) { /* livecfg 不可用按内置默认 */ }
    }
    const shift = Math.min(e.soft_streak, 16); // 防大 streak 溢出
    d = Math.min(base * Math.pow(2, shift), o.softMaxMs);
    e.soft_streak++;
    e.cooldown = { kind: 'soft', until: now + d, reason };
    e.model_cooldowns = {}; // 账号级冷却清模型级豁免,防上一次豁免泄漏
  }

  /**
   * 模型级软冷却：上游的排队是 **(账号, 模型)** 粒度（信封带 modelKey），
   * 一个模型排长队不该把整个账号封掉。
   *
   * 实测代价（2026-10-27）：dfmodel 排 4697 位（waitTime 7015 秒）→ 账号级
   * 软冷却 7015 秒 → 同一账号的 qfmodel（上游直接 200）也全部被本地拒掉，
   * 用户看到的就是「Qoder 整条通道用不了」，而账号本身完全健康。
   *
   * 时长同样夹在 [1s, 软冷却封顶]：上游的 waitTime 是它自己队列的估算，
   * 队列随时在变，照单全收会把一个模型锁死两小时。
   */
  function applyModelSoftCooldown(e, now, model, reason, retryAfterMs) {
    if (!model) return applySoftCooldown(e, now, reason, retryAfterMs);
    const explicit = Number(retryAfterMs);
    const d = Number.isFinite(explicit) && explicit > 0
      ? Math.min(Math.max(explicit, 1000), o.softMaxMs)
      : Math.min(o.softBaseMs, o.softMaxMs);
    const prev = e.model_cooldowns[model];
    e.model_cooldowns[model] = {
      // 已在冷却中不缩短（并发兜底探测不得把冷却削薄）
      until: Math.max(now + d, (prev && prev.until) || 0),
      reason: clampMsg(reason),
      hits: ((prev && prev.hits) || 0) + 1,
    };
  }

  function applyHardCooldown(e, now, reason, durationMs) {
    const d = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : msUntilNext4AM(now);
    e.cooldown = { kind: 'hard', until: now + d, reason };
    e.model_cooldowns = {};
  }

  function applyModelBlock(e, now, model, reason) {
    // 缺模型名时退化为熔断计数:模型级负缓存必须带 (账号,模型) 二元组
    if (!model) return applyBreakerFailure(e, now);
    const prev = e.model_cooldowns[model];
    const hits = ((prev && prev.hits) || 0) + 1;
    const ttl = Math.min(o.modelBlockBaseMs * Math.pow(2, Math.min(hits - 1, 4)), o.modelBlockMaxMs);
    e.model_cooldowns[model] = { until: now + ttl, reason: clampMsg(reason), hits };
  }

  function applyBreakerFailure(e, now) {
    const b = e.breaker;
    b.fails++;
    if (b.fails < o.breakerThreshold) return;
    let d = o.breakerCooldownMs;
    for (let i = 0; i < b.retry_count && d < o.breakerCooldownMaxMs; i++) d *= 2;
    d = Math.min(d, o.breakerCooldownMaxMs);
    // 触发熔断:失败计数清零供下一轮重新累计;retryCount 递增放大退避指数
    b.fails = 0;
    b.retry_count++;
    b.until = now + d;
  }

  /** 401 类防误杀:连续计数达阈才禁用。返回是否本次触发了禁用。 */
  function applySessionDead(e, now) {
    e.session_dead_fails++;
    if (e.session_dead_fails < o.sessionDeadThreshold) return false;
    e.session_dead_fails = 0;
    disableEntry(e, `登录态连续失效（401 类,连续 ${o.sessionDeadThreshold} 次）`);
    return true;
  }

  /**
   * 记一次错误,按 classify 的 kind 分发到对应惩罚域。
   * kind 为 null（其余 4xx,请求自身问题）只累计观测,不惩罚账号。
   * @returns {boolean} 本次是否导致禁用（session_dead 达阈）
   */
  function noteError(id, info) {
    const e = ensure(id);
    const now = nowMs();
    e.err_total++;
    e.last_used_at = now;
    e.last_error = clampMsg(info && info.message);
    const kind = info && info.kind;
    const reason = clampMsg(info && info.message);
    let disabledNow = false;
    if (kind === 'soft') {
      // scope==='model'：上游只排这个模型的队，别把账号整体封掉
      if (info && info.scope === 'model') applyModelSoftCooldown(e, now, info.model, reason, info.retryAfterMs);
      else applySoftCooldown(e, now, reason, info && info.retryAfterMs);
    }
    else if (kind === 'hard') applyHardCooldown(e, now, reason, info.durationMs);
    else if (kind === 'model') applyModelBlock(e, now, info.model, reason);
    else if (kind === 'session_dead') disabledNow = applySessionDead(e, now);
    else if (kind === 'breaker') applyBreakerFailure(e, now);
    markDirty();
    return disabledNow;
  }

  function noteSuccess(id) {
    const e = ensure(id);
    const now = nowMs();
    e.ok_count++;
    e.last_success_at = now;
    e.last_error = '';
    // 成功是最强恢复证据:清熔断运行态、软退避计数、防误杀计数。
    // 不碰 cooldown.until（即时冷却各自到期）与 model_cooldowns
    // （每模型独立计时,其他模型的成功不得抹掉本模型的冷却）。
    e.breaker.fails = 0;
    e.breaker.retry_count = 0;
    e.breaker.until = 0;
    e.soft_streak = 0;
    e.session_dead_fails = 0;
    markDirty();
  }

  function noteSessionDead(id) {
    return noteError(id, { kind: 'session_dead', message: '401 session dead' });
  }

  function clearSessionDead(id) {
    const e = ensure(id);
    if (e.session_dead_fails) {
      e.session_dead_fails = 0;
      markDirty();
    }
  }

  function blockModel(id, model, reason) {
    if (!model) return;
    const e = ensure(id);
    applyModelBlock(e, nowMs(), model, reason);
    markDirty();
  }

  function clearModelBlock(id, model) {
    const e = ensure(id);
    if (model && e.model_cooldowns[model]) {
      delete e.model_cooldowns[model];
      markDirty();
    }
  }

  // ---------------------------------------------------------------------------
  // 在途并发帽（运行态,不落盘）
  // ---------------------------------------------------------------------------

  function acquire(id) {
    const e = ensure(id);
    if (e.in_flight >= o.inFlightMax) return false;
    e.in_flight++;
    return true;
  }

  function release(id) {
    const e = states.get(String(id));
    if (e && e.in_flight > 0) e.in_flight--;
  }

  // ---------------------------------------------------------------------------
  // 选号
  // ---------------------------------------------------------------------------

  /**
   * 从候选 id 里轮询选一个健康账号（排除惩罚态/在途满/模型冷却/保底拦截）。
   * 候选由调用方给（池不感知账号 enabled 与存在性——无记录 = 无惩罚 = 健康）。
   * @returns {string|null}
   */
  function pick(candidates, optsPick = {}) {
    const now = nowMs();
    const exclude = optsPick.exclude
      ? new Set([...optsPick.exclude].map(String))
      : null;
    const seen = new Set();
    let ok = [];
    for (const raw of candidates || []) {
      const id = String(raw);
      if (seen.has(id) || (exclude && exclude.has(id))) continue;
      seen.add(id);
      const e = states.get(id);
      if (!e) { ok.push(id); continue; } // 无惩罚记录 = 健康
      if (!isHealthy(e, now)) continue;
      if (e.in_flight >= (Number(optsPick.inFlightMax) > 0 ? optsPick.inFlightMax : o.inFlightMax)) continue;
      if (optsPick.model && modelCooled(e, now, optsPick.model)) continue;
      if (optsPick.paid && floorBlockedFor(e)) continue;
      ok.push(id);
    }
    if (!ok.length) return null;

    // 快过期优先：调用方标出的「这份额度快作废了」的账号，窗口内只在它们之间抽。
    // 为什么在选号层做：积分过期是真金白银的损失，而纯轮询/纯加权都会让某个号
    // 的快过期额度一直不被用、最后作废。credits=0 的号不算候选（没额度可过期）。
    const expiring = optsPick.expiring;
    if (expiring && expiring.size) {
      const soon = ok.filter((id) => expiring.has(id));
      if (soon.length) ok = soon;
    }

    // 防撞号窗口：minPickGap 内已被选过的号本轮不再进抽签。
    // 兜底必须比**单调序号**而不是墙钟——同毫秒内 last_pick_at 相等，
    // 按它比较会退化成「恒取第一个」。
    const gapRaw = Number(optsPick.pickGapMs) > 0 ? optsPick.pickGapMs : o.pickGapMs;
    const gap = Number.isFinite(gapRaw) ? gapRaw : 0;
    if (gap > 0) {
      const fresh = ok.filter((id) => {
        const e = states.get(id);
        return !e || now - (e.last_pick_at || 0) >= gap;
      });
      if (fresh.length) ok = fresh;
      else return markPick(oldestBySeq(ok), now);
    }

    if (o.pickMode === 'rr') {
      const id = ok[cursor % ok.length];
      cursor = (cursor + 1) % 1e9;
      return markPick(id, now);
    }
    return markPick(weightedDraw(ok, now), now);
  }

  /** 记录本次选号（防撞号窗口与 LRU 兜底的数据源） */
  function markPick(id, now) {
    const e = ensure(id);
    e.last_pick_at = now;
    e.pick_seq = ++pickSeqCounter;
    return id;
  }

  function oldestBySeq(ids) {
    let best = ids[0];
    let bs = Infinity;
    for (const id of ids) {
      const e = states.get(id);
      const s = (e && e.pick_seq) || 0;
      if (s < bs) { bs = s; best = id; }
    }
    return best;
  }

  /** 候选里的最大余额，用作额度加成的分母（同一批候选内归一化） */
  function maxCreditsOf(ids) {
    let m = 0;
    for (const id of ids) {
      const e = states.get(id);
      if (e && Number.isFinite(e.credits) && e.credits > m) m = e.credits;
    }
    return m;
  }

  /**
   * 单个候选的权重。
   * 基线 1.0 —— 这是关键：额度只做**加性**加成，不能做乘性。乘性权重下
   * credits=0 的号权重恒为 0，永久饿死；加性下它至少有基线，仍会被选中。
   */
  function weightOf(e, now, maxCredits) {
    const CW = Number.isFinite(o.creditWeight) ? o.creditWeight : 10;
    const PER = Number.isFinite(o.idleBonusPerHour) ? o.idleBonusPerHour : 1;
    const CAP = Number.isFinite(o.idleBonusMax) ? o.idleBonusMax : 5;
    let w = 1.0;
    if (!e) return w + CAP; // 无记录 = 全新账号，给满闲置加成优先启用
    if (maxCredits > 0 && Number.isFinite(e.credits) && e.credits > 0) {
      w += (e.credits / maxCredits) * CW;
    }
    if (e.last_used_at) {
      const hours = Math.max(0, (now - e.last_used_at) / 3600000);
      w += Math.min(hours * PER, CAP);
    } else {
      w += CAP; // 从没用过
    }
    return w;
  }

  function weightedDraw(ids, now) {
    const mc = maxCreditsOf(ids);
    const w = ids.map((id) => weightOf(states.get(id), now, mc));
    let total = 0;
    for (const x of w) total += x;
    if (!(total > 0)) return ids[0]; // 理论上不可达（基线 1.0），防 NaN 兜底
    let r = Math.random() * total;
    for (let i = 0; i < ids.length; i++) {
      r -= w[i];
      if (r <= 0) return ids[i];
    }
    return ids[ids.length - 1];
  }

  // ---------------------------------------------------------------------------
  // 冷路径运维操作:锁内读盘 → 改单条 → 写盘（跨进程立即可见）
  // ---------------------------------------------------------------------------

  function readDoc() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  }

  function mtimeOf() {
    try { return fs.statSync(file).mtimeMs; } catch (e) { return 0; }
  }

  function writeDoc(doc) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    fileperm.harden(tmp);
    filelock.renameAtomic(tmp, file);
    lastMtime = mtimeOf();
  }

  /** 磁盘记录 → entry。恢复时惰性清理过期态（GAP N8:过期惩罚不跨重启复活）。 */
  function entryFromRecord(id, rec, now) {
    const e = newEntry(id);
    if (!rec || typeof rec !== 'object') return e;
    e.rev = Math.max(0, rec.rev | 0);
    e.disabled = !!rec.disabled;
    e.disabled_reason = clampMsg(rec.disabled_reason);
    e.paused = !!rec.paused;
    e.soft_streak = Math.max(0, rec.soft_streak | 0);
    e.session_dead_fails = Math.max(0, rec.session_dead_fails | 0);
    e.credits = Number.isFinite(rec.credits) ? rec.credits : null;
    e.credits_total = Number.isFinite(rec.credits_total) ? rec.credits_total : null;
    e.ok_count = Math.max(0, rec.ok_count | 0);
    e.err_total = Math.max(0, rec.err_total | 0);
    e.last_used_at = rec.last_used_at || 0;
    e.last_success_at = rec.last_success_at || 0;
    e.last_error = clampMsg(rec.last_error);
    if (rec.cooldown && (rec.cooldown.kind === 'soft' || rec.cooldown.kind === 'hard')
      && rec.cooldown.until > now) {
      e.cooldown = {
        kind: rec.cooldown.kind,
        until: rec.cooldown.until,
        reason: clampMsg(rec.cooldown.reason),
      };
    }
    for (const [m, mc] of Object.entries(rec.model_cooldowns || {})) {
      if (mc && mc.until > now) {
        e.model_cooldowns[m] = { until: mc.until, reason: clampMsg(mc.reason), hits: Math.max(0, mc.hits | 0) };
      }
    }
    // 熔断恢复:未过期才恢复;fails 归零（部分观测不跨进程保留）,retryCount 仅在
    // 熔断仍有效时保留（否则退避指数归零,不背无用包袱）
    if (rec.breaker && rec.breaker.until > now) {
      e.breaker = { fails: 0, retry_count: Math.max(0, rec.breaker.retry_count | 0), until: rec.breaker.until };
    }
    e.synced_at = rec.updated_at || 0;
    return e;
  }

  /** entry → 磁盘记录。瞬态字段只落未过期的（写侧与读侧双重惰性过滤）。
   *  rev 由调用方传入:锁内读到的磁盘版本号 +1,保证跨进程严格单调。 */
  function serializeEntry(e, now, rev) {
    const rec = {
      updated_at: now,
      rev: Math.max(0, rev | 0),
      disabled: e.disabled,
      disabled_reason: e.disabled_reason || '',
      paused: e.paused,
      soft_streak: e.soft_streak,
      session_dead_fails: e.session_dead_fails,
      credits: e.credits,
      credits_total: e.credits_total,
      ok_count: e.ok_count,
      err_total: e.err_total,
      last_used_at: e.last_used_at || 0,
      last_success_at: e.last_success_at || 0,
      last_error: e.last_error || '',
    };
    if (e.cooldown.until > now) rec.cooldown = { ...e.cooldown };
    const mcKeys = Object.keys(e.model_cooldowns).filter((m) => e.model_cooldowns[m].until > now);
    if (mcKeys.length) {
      rec.model_cooldowns = {};
      for (const m of mcKeys) rec.model_cooldowns[m] = { ...e.model_cooldowns[m] };
    }
    if (e.breaker.until > now) {
      rec.breaker = { retry_count: e.breaker.retry_count, until: e.breaker.until };
    }
    return rec;
  }

  /** 在锁内对单个账号做「读盘→改→写盘」。磁盘记录是该账号最近一次落盘的权威态
   *  （热进程 5s 防抖内的最新变化可能尚未落盘——运维操作低频,以磁盘为基线再
   *  叠加本操作,避免覆盖其他进程刚写的惩罚态）。只回写目标账号的记录,本进程
   *  可能持有的其他账号陈旧内存态不参与写盘。 */
  function mutatePersisted(id, fn) {
    const key = String(id);
    if (!file) {
      return fn(ensure(key), nowMs());
    }
    let result;
    filelock.withLock(file, () => {
      const now = nowMs();
      let doc = readDoc();
      const rec = doc && doc.accounts ? doc.accounts[key] : null;
      const cur = states.get(key);
      const base = rec ? entryFromRecord(key, rec, now) : (cur || ensure(key));
      if (cur) base.in_flight = cur.in_flight; // 在途是本进程运行态,保留
      states.set(key, base);
      result = fn(base, now);
      if (!doc || typeof doc !== 'object' || typeof doc.accounts !== 'object') doc = { accounts: {} };
      const wnow = nowMs();
      const rec2 = serializeEntry(base, wnow, (base.rev || 0) + 1);
      doc.accounts[key] = rec2;
      doc.saved_at = wnow;
      writeDoc(doc);
      base.synced_at = wnow; // 同 save():自己写的记录不回吸
      base.rev = rec2.rev;
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // 冷路径 API（运维 / B 包调度）
  // ---------------------------------------------------------------------------

  /** 冻结（hard 冷却,kind=hard 使余额恢复路径也能解冻它） */
  function freeze(id, ms, reason) {
    const d = Number(ms);
    if (!Number.isFinite(d) || d <= 0) return false;
    return mutatePersisted(id, (e, now) => {
      e.cooldown = { kind: 'hard', until: now + d, reason: clampMsg(reason || '人工冻结') };
      e.model_cooldowns = {};
      markDirty();
      return true;
    });
  }

  /** 运维口径的「无条件恢复」:清禁用 + 暂停 + 全部冷却域 + 熔断 + 防误杀计数 */
  function revive(id) {
    return mutatePersisted(id, (e) => {
      e.disabled = false;
      e.paused = false;
      e.disabled_reason = '';
      clearCooling(e);
      e.breaker = { fails: 0, retry_count: 0, until: 0 };
      e.session_dead_fails = 0;
      markDirty();
      return true;
    });
  }

  function disable(id, reason) {
    return mutatePersisted(id, (e) => {
      disableEntry(e, reason);
      markDirty();
      return true;
    });
  }

  /** 暂停选号（临时让位）:不动任何惩罚域,保活/签到照常,随时 resume */
  function pause(id) {
    return mutatePersisted(id, (e) => {
      e.paused = true;
      markDirty();
      return true;
    });
  }

  function resume(id) {
    return mutatePersisted(id, (e) => {
      e.paused = false;
      markDirty();
      return true;
    });
  }

  function setCredits(id, credits, total) {
    return mutatePersisted(id, (e) => {
      e.credits = Number.isFinite(credits) ? credits : null;
      if (total !== undefined) e.credits_total = Number.isFinite(total) ? total : null;
      markDirty();
      return true;
    });
  }

  /**
   * 余额恢复解冻（B 包签到闭环入口）:余额 > 0 且未禁用时解冻**硬冷却**。
   * 不动软冷却/模型级台账/熔断——余额恢复只证明 billing 通道健康,不证明
   * 限流已解除或 chat 通道健康（若全清,任何限流冷却的实际寿命都会被压到
   * 一个刷新周期内,冷却保护形同虚设,对齐 reviveCoolingLocked 的教训）。
   * @returns {{unfrozen:boolean}}
   */
  function reenableIfCredits(id, credits, total) {
    return mutatePersisted(id, (e) => {
      e.credits = Number.isFinite(credits) ? credits : e.credits;
      if (total !== undefined) e.credits_total = Number.isFinite(total) ? total : e.credits_total;
      let unfrozen = false;
      if (e.credits > 0 && !e.disabled && e.cooldown.kind === 'hard') {
        e.cooldown = { kind: '', until: 0, reason: '' };
        unfrozen = true;
      }
      markDirty();
      return { unfrozen };
    });
  }

  // ---------------------------------------------------------------------------
  // 持久化:启动恢复 / 防抖落盘 / 跨进程吸纳
  // ---------------------------------------------------------------------------

  function load() {
    if (!file) return;
    const doc = readDoc();
    if (!doc || typeof doc !== 'object' || !doc.accounts) return;
    const now = nowMs();
    for (const [id, rec] of Object.entries(doc.accounts)) {
      const key = String(id);
      const cur = states.get(key);
      const e = entryFromRecord(id, rec, now);
      // 重读不清在途帽:reloadIfChanged 落在管理端视图路径,chatlab 等本进程
      // 在途请求还占着名额,清零会让并发帽失守（release 有下溢保护,帽没有）
      if (cur) e.in_flight = cur.in_flight;
      states.set(key, e);
    }
    lastMtime = mtimeOf();
  }

  /** 热路径落盘（flusher/flush 调用）。锁内「读盘吸纳 → 全量写」:
   *  写前按记录级 rev 吸纳其他进程的更新（per-record LWW）,否则防抖
   *  窗口内的全量写会把管理端刚做的冻结/复活盖回去。rev 是锁内维护的
   *  单调版本号（每次写 = 磁盘当前版本 + 1）, updated_at 同毫秒时仍能
   *  分清谁新谁旧——只比 updated_at 在同毫秒并发写时会丢掉对方的更新。
   *  与 mutatePersisted 各自拿锁、互不嵌套。 */
  function save() {
    if (!file) return false;
    filelock.withLock(file, () => {
      const now = nowMs();
      const doc = readDoc();
      if (doc && typeof doc === 'object' && doc.accounts) {
        for (const [id, rec] of Object.entries(doc.accounts)) {
          const cur = states.get(id);
          if (!cur) {
            // 另一进程新写、本进程内存里没有的账号（如对从未走过流量的账号冻结）
            states.set(id, entryFromRecord(id, rec, now));
            continue;
          }
          const recRev = (rec && rec.rev) | 0;
          const absorbed = recRev > (cur.rev || 0)
            || (!recRev && (rec.updated_at || 0) > (cur.synced_at || 0)); // 旧版文件无 rev,退回 updated_at
          if (absorbed) {
            const fresh = entryFromRecord(id, rec, now);
            fresh.in_flight = cur.in_flight;
            states.set(id, fresh);
          }
        }
      }
      const out = { saved_at: now, accounts: {} };
      for (const [id, e] of states) {
        const rec2 = serializeEntry(e, now, (e.rev || 0) + 1);
        out.accounts[id] = rec2;
        // 记下本进程写盘时刻与版本号:下次 save 时磁盘上 rev == e.rev 的记录
        // 是自己写的,不再吸纳;只有别人的更新（rev 更大）才覆盖内存。
        // 漏了这步,每次 save 都会把自己的旧记录当外部更新吸回来,
        // 防抖窗口内的内存变化全部被回滚。
        e.synced_at = now;
        e.rev = rec2.rev;
      }
      writeDoc(out);
    });
    return true;
  }

  /** 其他进程写过盘（mtime 变化）时重新加载。供非权威读进程（管理端视图）调用。 */
  function reloadIfChanged() {
    if (!file) return false;
    const m = mtimeOf();
    if (!m || m === lastMtime) return false;
    load();
    return true;
  }

  function startFlusher() {
    if (!file || !o.flushMs || timer) return;
    timer = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      try { save(); } catch (e) { dirty = true; /* 写失败回置脏标记,下个周期重试——吞掉就等于丢了防抖窗口 */ }
    }, o.flushMs);
    if (timer.unref) timer.unref();
  }

  /** 同步落盘（幂等:无变更不写）。供进程退出前与测试调用。
   *  写失败时脏标记回置（P1-2 教训:先清后写,失败即静默丢状态）,异常向上抛。 */
  function flush() {
    if (!dirty || !file) { dirty = false; return false; }
    dirty = false;
    try { save(); } catch (e) { dirty = true; throw e; }
    return true;
  }

  function close() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    flush();
  }

  // ---------------------------------------------------------------------------
  // 查询
  // ---------------------------------------------------------------------------

  function status(id) {
    const e = ensure(id);
    const now = nowMs();
    const cooling = e.cooldown.until > now || e.breaker.until > now;
    let state = 'healthy';
    if (e.disabled) state = 'disabled';
    else if (e.paused) state = 'paused';
    else if (cooling) state = 'cooling';
    // 仍在生效且更晚截止的那个（冷却与熔断可能只有其一生效）
    const until = Math.max(e.cooldown.until > now ? e.cooldown.until : 0, e.breaker.until > now ? e.breaker.until : 0);
    const breakerActive = e.breaker.until > now && e.breaker.until >= e.cooldown.until;
    return {
      id: e.id,
      state,
      cooling,
      disabled: e.disabled,
      disabled_reason: e.disabled_reason,
      paused: e.paused,
      cool_kind: cooling ? (breakerActive ? 'breaker' : (e.cooldown.kind || 'breaker')) : '',
      cool_remaining_s: until ? Math.ceil((until - now) / 1000) : 0,
      until,
      cooldown_kind: e.cooldown.kind,
      cooldown_until: e.cooldown.until,
      cooldown_reason: e.cooldown.reason,
      soft_streak: e.soft_streak,
      model_cooldowns: Object.entries(e.model_cooldowns)
        .filter(([, mc]) => mc.until > now)
        .map(([model, mc]) => ({ model, until: mc.until, reason: mc.reason, hits: mc.hits })),
      breaker_fails: e.breaker.fails,
      breaker_retry_count: e.breaker.retry_count,
      breaker_until: e.breaker.until,
      session_dead_fails: e.session_dead_fails,
      credits: e.credits,
      credits_total: e.credits_total,
      floor_blocked: floorBlockedFor(e),
      in_flight: e.in_flight,
      ok_count: e.ok_count,
      err_total: e.err_total,
      last_used_at: e.last_used_at || null,
      last_success_at: e.last_success_at || null,
      last_error: e.last_error || '',
    };
  }

  function snapshot() {
    return [...states.keys()].map((id) => status(id));
  }

  function counts() {
    const now = nowMs();
    const c = { total: 0, healthy: 0, cooling: 0, disabled: 0, paused: 0, in_flight_full: 0 };
    for (const e of states.values()) {
      c.total++;
      if (e.disabled) c.disabled++;
      else if (e.paused) c.paused++;
      else if (!isHealthy(e, now)) c.cooling++;
      else {
        c.healthy++;
        if (e.in_flight >= o.inFlightMax) c.in_flight_full++;
      }
    }
    return c;
  }

  function isHealthyId(id) {
    return isHealthy(ensure(id), nowMs());
  }

  // 启动:读旧状态 → 起 flusher
  load();
  startFlusher();

  return {
    // 喂入
    noteSuccess, noteError, noteSessionDead, clearSessionDead, blockModel, clearModelBlock,
    // 运维 / B 包
    freeze, revive, disable, pause, resume, setCredits, reenableIfCredits,
    // 在途
    acquire, release,
    // 选号与查询
    pick, status, snapshot, counts, isHealthy: isHealthyId,
    // 持久化
    flush, close, reloadIfChanged,
    msUntilNext4AM,
  };
}

// 默认单例:web-pool（网关进程）与管理端共用同一份 pool-state.json。
// flusher 周期 5s,进程退出由调用方调 close()（unref 过,不阻塞退出）。
// hotSoftCooldown:软冷却基数热读 livecfg（仅生产单例,测试池保持对机器配置不敏感）。
const pool = createPool({ file: STATE_FILE, hotSoftCooldown: true });

module.exports = { createPool, pool, DEFAULTS, STATE_FILE, msUntilNext4AM };
