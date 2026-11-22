// src/traework/models-cache.js - 模型表缓存的「作用域 + 单飞」纯逻辑（2026-11-16）
//
// 为什么单独成文件：`models.js` 负责 HTTP、归一化与对外口径，缓存策略要能
// 离线单测（不碰网络、不碰账号）。这里的每个函数都是纯的或只动自己的 Map。
//
// ## 背景：为什么不能再「按区域一份缓存」
//
// 旧实现 `caches: Map<region, {at,data}>`，而取数的是 `accountForRegion()`
// ——**该区第一个可用账号**。上游模型表里有一半字段是**账号相关**的：
//   · `consumption_rate` / `discount`（倍率与会员折扣，按会员等级不同）
//   · `reasoning_effort_config`（thinking 档位）
//   · `max_mode`（1M 上下文档）
//   · `multimodal`（是否支持图像）
// 于是同区第二个账号看到的是第一个账号的能力表：`/v1/models` 与管理端
// 「模型信息」全部 200，但能力判断可能错——正是本项目最怕的静默故障形态。
//
// 口径参考 Trae2api-cn v1.0.11（2026-11-05）：
// 「模型目录缓存按账号、Agent/Work 档位、原生 raw_chat_function、网关与
//   客户端身份参数隔离；同一范围的并发冷读取共享一次上游请求。」
//
// 我们只落**真正会变**的维度：region（网关）、accountId（账号）、
// fn（raw_chat_function）、version（客户端身份，进请求头影响能力下发）。
// 不发明别的维度——多一维只多一份缓存与一次上游请求，必须有正据。

const crypto = require('crypto');

/** 作用域键里的分隔符；脏字符替换掉，避免两个账号拼出同一个键 */
const SEP = '|';

function clean(v) {
  return String(v == null ? '' : v).replace(/[|\r\n]/g, '_').trim();
}

/**
 * 拼作用域键。四维都缺省也要得到稳定键（region 必有）。
 * @param {{region?:string, accountId?:string, fn?:string, version?:string}} scope
 * @returns {string} 形如 `cn|acc123|solo_work_lite|0.1.43`
 */
function scopeKey(scope) {
  const s = scope || {};
  return [clean(s.region) || 'cn', clean(s.accountId) || '-', clean(s.fn) || '-', clean(s.version) || '-'].join(SEP);
}

/** 键 → 结构体（展示用；解析不出来时字段为空串，不抛） */
function parseScope(key) {
  const parts = String(key || '').split(SEP);
  return {
    region: parts[0] || '',
    accountId: parts[1] || '',
    fn: parts[2] || '',
    version: parts[3] || '',
  };
}

/** 短指纹（管理端显示用；同一键稳定，但不可逆） */
function scopeId(key) {
  return crypto.createHash('sha1').update(String(key || '')).digest('hex').slice(0, 8);
}

/**
 * 建一个带 TTL + LRU 上限 + 单飞的缓存。
 *
 * @param {{ttlMs?:number, cap?:number, now?:function():number}} [opts]
 *   ttlMs 过期时长；cap 作用域条数上限（淘汰最久未用的）；
 *   now 注入时钟（单测用，避免 sleep）
 */
function createModelsCache(opts = {}) {
  const ttlMs = opts.ttlMs > 0 ? opts.ttlMs : 300000;
  const cap = opts.cap > 0 ? opts.cap : 8;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  /** key -> { at, usedAt, data, scope } */
  const entries = new Map();
  /** region -> { key, at } 最近一次成功的那个作用域（旧读法的兼容视图） */
  const regionView = new Map();
  /** key -> Promise（冷读单飞） */
  const inflight = new Map();
  const stats = { get: 0, hit: 0, miss: 0, set: 0, evict: 0, join: 0, fetch: 0 };

  function fresh(e) {
    return !!e && !!e.data && now() - e.at < ttlMs;
  }

  /** 读（过期返回 null，但条目保留——拉失败时旧数据还能被 regionView 兜底） */
  function get(key) {
    stats.get += 1;
    const e = entries.get(key);
    if (!fresh(e)) { stats.miss += 1; return null; }
    e.usedAt = now();
    stats.hit += 1;
    return e.data;
  }

  /** 直接读条目（含 at / scope；未过期才给，命中即续期）。无 data 包装，给聚合读法用 */
  function entry(key) {
    const e = entries.get(key);
    if (!fresh(e)) return null;
    e.usedAt = now();
    return e;
  }

  /** 条目存在但已过期（调用方据此决定「是否要重试」而非「是否可用」） */
  function stale(key) {
    const e = entries.get(key);
    return !!e && !fresh(e);
  }

  /** 淘汰：最久未使用的先走；正在单飞的键不淘汰（否则两个读者会打两次上游） */
  function evictIfNeeded() {
    if (entries.size <= cap) return;
    const victims = [...entries.entries()]
      .filter(([k]) => !inflight.has(k))
      .sort((a, b) => (a[1].usedAt || 0) - (b[1].usedAt || 0));
    while (entries.size > cap && victims.length) {
      const [k] = victims.shift();
      entries.delete(k);
      stats.evict += 1;
    }
  }

  /** 写。region 必填；scope 原样留下（管理端展示 / 聚合用） */
  function set(key, data, scope) {
    const t = now();
    const s = scope || parseScope(key);
    entries.set(key, { at: t, usedAt: t, data, scope: s });
    stats.set += 1;
    if (s.region) regionView.set(s.region, { key, at: t });
    evictIfNeeded();
    return data;
  }

  /** 最近一次成功的作用域数据（旧读法：`cacheOf(region)` 的语义） */
  function latest(region) {
    const ptr = regionView.get(region);
    if (!ptr) return null;
    return entries.get(ptr.key) || null;
  }

  /** 该区所有**未过期**条目，按 at 新→旧 */
  function keysOf(region) {
    return [...entries.entries()]
      .filter(([, e]) => e.scope && e.scope.region === region && fresh(e))
      .sort((a, b) => b[1].at - a[1].at)
      .map(([k]) => k);
  }

  /** 该区所有未过期数据（聚合读法的原料） */
  function datasOf(region) {
    return keysOf(region).map((k) => entries.get(k));
  }

  /** 管理端展示：作用域清单（含模型条数、取数时刻） */
  function scopes(region) {
    return [...entries.entries()]
      .filter(([, e]) => !region || (e.scope && e.scope.region === region))
      .sort((a, b) => b[1].at - a[1].at)
      .map(([k, e]) => ({
        key: k,
        id: scopeId(k),
        region: e.scope ? e.scope.region : '',
        accountId: e.scope ? e.scope.accountId : '',
        fn: e.scope ? e.scope.fn : '',
        version: e.scope ? e.scope.version : '',
        at: e.at,
        ageMs: Math.max(0, now() - e.at),
        stale: !fresh(e),
        models: e.data && Array.isArray(e.data.models) ? e.data.models.length : 0,
      }));
  }

  /**
   * 冷读单飞：同键并发只跑一次 producer，其余调用方拿同一个 Promise。
   * 失败原样抛给**每个**调用方（不吞、不缓存错误）。
   */
  function single(key, producer) {
    const cur = inflight.get(key);
    if (cur) { stats.join += 1; return cur; }
    stats.fetch += 1;
    const p = Promise.resolve().then(producer);
    inflight.set(key, p);
    // 单独一条链清理 inflight，避免影响调用方看到的 rejection
    p.catch(() => {}).then(() => { inflight.delete(key); });
    return p;
  }

  function hasInflight(key) {
    return inflight.has(key);
  }

  /** 清空（测试与「清缓存重取」用）：无参清全部，给 region 只清该区 */
  function clear(region) {
    if (!region) { entries.clear(); regionView.clear(); return; }
    for (const [k, e] of [...entries.entries()]) {
      if (e.scope && e.scope.region === region) entries.delete(k);
    }
    regionView.delete(region);
  }

  return {
    scopeKey, parseScope, scopeId,
    get, entry, stale, set, latest, keysOf, datasOf, scopes, single, hasInflight, clear,
    stats: () => ({ ...stats, size: entries.size, cap, ttlMs, inflight: inflight.size }),
    DEFAULT_CAP: cap,
  };
}

module.exports = { createModelsCache, scopeKey, parseScope, scopeId, SEP };
