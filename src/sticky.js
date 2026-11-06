// src/sticky.js - 会话粘性绑定表（GAP F1 子项,独立可选;零依赖）
//
// 会话哈希 → 账号的绑定表:同一会话的请求尽量落到同一账号,多账号长会话
// （TRAE 上下文恢复成本高）不必每次换号重放上下文。
//
// 2026-11-06 起从单值绑定升级为**暖账号列表**（hub #718 的 SessionAffinity
// 语义）：每个会话记 front（最近使用的账号）+ 若干 fallback——front 不可用
// （冷却/在途满/禁用）时,调用方按 recent() 的顺序先试会话的其他暖账号,
// 它们可能还持有上游前缀缓存;直接跳回池轮询会让长会话每轮丢缓存重算
// prefill,Token 消耗翻倍。bind() 语义 = promote:选中的账号插到 front,
// 被替换的原 front 自动落在第二位当 fallback。
//
// 与 codebuddyManager internal/session 的差异:dumate 四通道均为无状态转发,
// 没有会话→账号的强绑定语义,粘性只是「尽量」——所以不需要上游会话校验,
// 只要一张内存表就够。绑定只在内存:重启丢失即重新分配,无恢复价值。
//
// 淘汰双策略:TTL 过期（会话本身有生命周期）+ LRU 容量上限（防长尾 key 把
// 表撑爆）。两者都只在 lookup/bind 时惰性执行,无后台定时器。
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 会话静默 30 分钟视为结束
const DEFAULT_MAX = 512;               // 绑定数上限,淘汰最久未用的
const DEFAULT_WARM = 3;                // 每会话暖账号数上限（front + 2 个 fallback）

/**
 * @param {{ttlMs?:number, max?:number, warm?:number, now?:()=>number}} [opts]
 */
function createSticky(opts = {}) {
  const ttlMs = opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
  const max = opts.max > 0 ? opts.max : DEFAULT_MAX;
  const warmMax = opts.warm > 0 ? opts.warm : DEFAULT_WARM;
  const now = () => (typeof opts.now === 'function' ? opts.now() : Date.now());
  // Map 保持插入序:头部最旧、尾部最新,天然当 LRU 链用
  const map = new Map(); // key → { uids: [front, ...fallback], at }

  function evictExpired(t) {
    // 全表扫描（≤ max 条）:lookup 命中会刷新 at,插入序不再保证 at 序,
    // 不能按序提前 break
    for (const [k, v] of map) {
      if (t - v.at > ttlMs) map.delete(k);
    }
  }

  /** 选中账号插到 front（去重;原 front 落到第二位当 fallback） */
  function bind(key, uid) {
    const k = String(key || '');
    const u = String(uid || '');
    if (!k || !u) return false;
    const t = now();
    evictExpired(t);
    let v = map.get(k);
    if (v) {
      map.delete(k); // 移到尾部（刷新 LRU）
    } else {
      v = { uids: [], at: t };
    }
    v.at = t;
    v.uids = [u, ...v.uids.filter((x) => x !== u)].slice(0, warmMax);
    map.set(k, v);
    while (map.size > max) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
    return true;
  }

  /** front 账号（兼容旧单值语义）。命中刷新 TTL + LRU */
  function lookup(key) {
    const k = String(key || '');
    const v = map.get(k);
    if (!v) return null;
    const t = now();
    if (t - v.at > ttlMs) {
      map.delete(k);
      return null;
    }
    map.delete(k);
    v.at = t;
    map.set(k, v);
    return v.uids[0] || null;
  }

  /**
   * 会话的暖账号列表（front 优先,副本不过 LRU/TTL 刷新——只读探测,
   * 真正使用由调用方 bind/promote 刷新）。过期返回 []。
   */
  function recent(key) {
    const k = String(key || '');
    const v = map.get(k);
    if (!v) return [];
    if (now() - v.at > ttlMs) return [];
    return [...v.uids];
  }

  function unbind(key) {
    return map.delete(String(key || ''));
  }

  function size() {
    evictExpired(now());
    return map.size;
  }

  function clear() {
    map.clear();
  }

  return { bind, lookup, recent, unbind, size, clear };
}

module.exports = { createSticky, DEFAULT_TTL_MS, DEFAULT_MAX, DEFAULT_WARM };
