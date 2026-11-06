// src/usage-agg.js - 长期用量分桶聚合（施工包 C / GAP F3）
//
// 为什么需要：请求明细在 data/requests.jsonl（32MB 轮转，历史一代即弃），
// 面板用量页每次全量现扫——轮转一滚，按月/年趋势就没了，且 jsonl 越大现算
// 越慢。这里在请求埋点处挂一层内存分桶（挂接点 reqlog-hook.feed，reqlog.js
// 懒加载调用，不经 server.js），按 (时间片, 通道, 账号, 模型, 费率) 累加，
// 防抖落盘 data/usage-agg.json。明细滚走了，趋势还在。
//
// 保留策略：近 7 天小时桶（看尖峰），更早折叠为日桶永久保留（看趋势）。
// 桶数有硬上限：超限先折叠，仍超则按时间片从最旧开始淘汰，内存因此有界。
//
// 对齐 codebuddyManager workbuddy2api/internal/usage 的能力，并避开其审计
// 修过的三类问题：
//   1. 桶键分隔符不用 '|'——维度值里出现 '|' 会把 (a|b, c) 与 (a, b|c) 折进
//      同一桶。这里用 '\x00'，且入桶前把维度值里的 '\x00' 清掉（键内组件
//      因此不可能含分隔符，结构上防碰撞）。
//   2. 持锁不做重活——flush 在文件锁内只做「合并磁盘 + 临时文件 + rename」，
//      序列化等都在锁外完成（Node 同步代码本身串行，锁只为跨进程互斥）。
//   3. 时间片桶键用本地时区（与管理端其它账本一致、与用户直觉一致），不是
//      UTC；窗口计算的「整点」也按本地时区取。
//
// 多进程：网关 / web 网关 / chatlab 三个进程都会走 reqlog.record。本文件是
// 读改写型 JSON（不是追加式），flush 时在 filelock 内先采纳磁盘上本进程没有
// 的桶（键并集、同键以本进程累计为准）再整体替换——并发下最多低估、不会
// 重复计数。重启最多丢最后一个防抖窗口（默认 30s）的增量，对趋势计量可接受。
const fs = require('fs');
const path = require('path');
const filelock = require('./filelock');

const FILE_NAME = 'usage-agg.json';
const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
const DEFAULT_MAX_BUCKETS = Math.max(
  1000,
  parseInt(process.env.DUMATE_USAGE_AGG_MAX_BUCKETS || '50000', 10) || 50000,
);
// 小时桶保留时长；GAP F3 定为 7 天，超出折叠为日桶。
const DEFAULT_HOURLY_KEEP_MS = 7 * 86400000;
const DEFAULT_FLUSH_MS = Math.max(
  0,
  parseInt(process.env.DUMATE_USAGE_AGG_FLUSH_MS || '30000', 10) || 0,
);
const HOUR_MS = 3600000;
const FILE_VERSION = 1;
// 桶键分隔符。'\x00' 不会出现在正常的通道/账号/模型名里，且入桶前已从维度
// 值中清除——键的切分因此无歧义。
const SEP = '\x00';
const SCOPE_RE = /^([hd]):(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?$/;

// 维度值清洗：去掉桶键分隔符，防注入式碰撞。空值归空串（入键后仍唯一）。
function dim(v) {
  return String(v == null ? '' : v).replace(/\x00/g, '');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 本地时区时间片：h:YYYY-MM-DDTHH / d:YYYY-MM-DD。不用 toISOString——
// 那是 UTC，东八区凌晨会被算成前一天，与管理端其它账本同坑。
function hourScope(ts) {
  const d = new Date(ts);
  return `h:${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}`;
}

function dayScope(ts) {
  const d = new Date(ts);
  return `d:${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 本地整点起点（窗口计算用）。Math.floor(ms/3600e3) 对齐的是 UTC 整点，
// 东八区会错位 8 小时。
function localHourFloor(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
}

// scope 字符串 → 桶起点本地时间戳；脏 scope 返回 null（不进任何窗口口径）。
function scopeTime(s) {
  const m = SCOPE_RE.exec(String(s || ''));
  if (!m) return null;
  const t = m[1] === 'h'
    ? new Date(+m[2], +m[3] - 1, +m[4], +m[5] || 0).getTime()
    : new Date(+m[2], +m[3] - 1, +m[4]).getTime();
  return Number.isFinite(t) ? t : null;
}

function bucketKey(b) {
  return `${b.s}${SEP}${b.r}${SEP}${b.u}${SEP}${b.m}${SEP}${b.x}`;
}

// 从磁盘 JSON 恢复一个桶（数值全部钳到非负，防脏数据毒化累计）。
function normalizeBucket(raw) {
  const num = (v) => Math.max(0, Number(v) || 0);
  return {
    s: String(raw.s || ''),
    r: dim(raw.r),
    u: dim(raw.u),
    m: dim(raw.m) || '(unknown)',
    x: dim(raw.x),
    q: num(raw.q),
    e: num(raw.e),
    p: num(raw.p),
    c: num(raw.c),
    t: num(raw.t),
    l: num(raw.l),
    ln: num(raw.ln),
    // 缓存三段（2026-11-04，hub v1.7.22 融合）：ci=非缓存输入、cc=缓存命中；
    // c0/c0p=「确认零缓存」的请求数与 prompt 合计（全价请求，行级判定后入桶）
    ci: num(raw.ci),
    cc: num(raw.cc),
    c0: num(raw.c0),
    c0p: num(raw.c0p),
  };
}

/**
 * 创建一个聚合器实例。生产用模块级共享实例（落 DATA_DIR），测试用工厂注入
 * 独立目录 / 时钟 / 上限。
 *
 * @param {object} [opts]
 * @param {string} [opts.dir]        数据目录（默认 DUMATE_ADMIN_DATA 或 data/）
 * @param {string} [opts.file]       落盘文件绝对路径（默认 dir/usage-agg.json）
 * @param {boolean} [opts.persist]   false = 纯内存不落盘（测试用）
 * @param {number} [opts.maxBuckets] 桶数硬上限
 * @param {number} [opts.hourlyKeepMs] 小时桶保留时长
 * @param {number} [opts.flushMs]    防抖落盘间隔（0 = 不自动落盘）
 * @param {() => number} [opts.now]  时钟注入（折叠/窗口/默认 ts）
 */
function create(opts = {}) {
  const dir = opts.dir || DATA_DIR;
  const persist = opts.persist !== false;
  const file = opts.persist === false ? '' : (opts.file || path.join(dir, FILE_NAME));
  const maxBuckets = Math.max(2, Number(opts.maxBuckets) || DEFAULT_MAX_BUCKETS);
  const hourlyKeepMs = opts.hourlyKeepMs != null ? opts.hourlyKeepMs : DEFAULT_HOURLY_KEEP_MS;
  const flushMs = opts.flushMs != null ? opts.flushMs : DEFAULT_FLUSH_MS;
  const now = opts.now || Date.now;
  // 全价请求阈值（hub v1.7.21）：单请求 prompt ≥ 阈值且**确认零缓存**。
  // create 可注入（测试），生产读 env；行级判定发生在 addEntry，聚合桶里
  // 只留计数——桶是聚合的，snapshot 时无法回放行级条件。
  const fullPriceMin = Math.max(1, Number(opts.fullPriceMin)
    || parseInt(process.env.DUMATE_FULL_PRICE_PROMPT_MIN || '100000', 10) || 100000);

  const buckets = new Map(); // key → bucket
  let dirty = false;
  let timer = null;

  function scheduleFlush() {
    if (!persist || timer || flushMs <= 0 || !dirty) return;
    timer = setTimeout(() => {
      timer = null;
      if (dirty) flushNow();
    }, flushMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  // 把超出保留期的小时桶折叠为日桶。幂等：先累加再删源桶，反复折叠不重复计数。
  function rollup(nowMs) {
    const cutoff = (Number(nowMs) || now()) - hourlyKeepMs;
    const moves = [];
    for (const [key, b] of buckets) {
      if (b.s[0] !== 'h') continue;
      const ts = scopeTime(b.s);
      if (ts == null || ts >= cutoff) continue;
      moves.push([key, b, dayScope(ts)]);
    }
    for (const [key, b, day] of moves) {
      buckets.delete(key);
      const dst = buckets.get(bucketKey({ ...b, s: day }));
      if (!dst) buckets.set(bucketKey({ ...b, s: day }), { ...b, s: day });
      else {
        dst.q += b.q; dst.e += b.e; dst.p += b.p; dst.c += b.c;
        dst.t += b.t; dst.l += b.l; dst.ln += b.ln;
        dst.ci += b.ci; dst.cc += b.cc; dst.c0 += b.c0; dst.c0p += b.c0p;
      }
    }
    if (moves.length) {
      dirty = true;
      scheduleFlush();
    }
    return moves.length;
  }

  // 淘汰到 keepTo 个桶为止。键按字典序排：scope 是键首段且 'd:' < 'h:'、
  // 同前缀内 ISO 串即时间序，所以「字典序最小 = 时间片最旧」，从队首删
  // 正好淘汰最旧的桶。
  function evict(keepTo) {
    if (buckets.size <= keepTo) return 0;
    const keys = [...buckets.keys()].sort();
    let n = 0;
    for (let i = 0; i < keys.length - keepTo; i++) {
      buckets.delete(keys[i]);
      n++;
    }
    if (n) dirty = true;
    return n;
  }

  /**
   * 记入一条请求（reqlog.record 的 entry 原样传入）。
   * status 2xx/3xx 算成功，其余（含 0 = 无响应）算失败——与面板口径一致。
   * total_tokens 缺省时用 input+output 兜底，保证总量口径连续。
   */
  function addEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    const ts = Number(entry.ts) || now();
    const input = Math.max(0, Number(entry.input_tokens) || 0);
    const output = Math.max(0, Number(entry.output_tokens) || 0);
    const total = entry.total_tokens != null
      ? Math.max(0, Number(entry.total_tokens) || 0)
      : input + output;
    const status = Number(entry.status) || 0;
    const ms = Number.isFinite(entry.ms) && entry.ms >= 0 ? Number(entry.ms) : null;
    // 缓存三段：非缓存输入 = input − cached（钳零）；「确认零缓存」只在
    // 上游**回报了**缓存字段且值为 0 且请求成功时成立（hub v1.7.21 全价请求
    // 口径——失败请求没有消耗，不计入全价）。cached_reported=false 是
    // 「上游没回报」，既不算命中也不算确认零缓存。
    const cached = Math.max(0, Number(entry.cached_tokens) || 0);
    const noncached = Math.max(0, input - cached);
    const confirmedZero = !!entry.cached_reported && cached === 0 && status >= 200 && status < 400;
    const fullPrice = confirmedZero && input >= fullPriceMin;
    const b = {
      s: hourScope(ts),
      r: dim(entry.channel) || 'untagged',
      u: dim(entry.account),
      m: dim(entry.model) || '(unknown)',
      // 费率维度：当前埋点通常不带，预留给接入积分倍率观测的通道。
      x: dim(entry.rate),
      q: 1,
      e: status >= 200 && status < 400 ? 0 : 1,
      p: input,
      c: output,
      t: total,
      l: ms == null ? 0 : ms,
      ln: ms == null ? 0 : 1,
      ci: noncached,
      cc: cached,
      c0: fullPrice ? 1 : 0,
      c0p: fullPrice ? input : 0,
    };
    const key = bucketKey(b);
    const cur = buckets.get(key);
    if (cur) {
      cur.q++; cur.e += b.e; cur.p += b.p; cur.c += b.c;
      cur.t += b.t; cur.l += b.l; cur.ln += b.ln;
      cur.ci += b.ci; cur.cc += b.cc; cur.c0 += b.c0; cur.c0p += b.c0p;
    } else {
      buckets.set(key, b);
    }
    dirty = true;
    if (buckets.size > maxBuckets) {
      rollup(now());
      // 折叠救不回来（短时间异常多维度组合）才淘汰，且一次淘汰到 90%，
      // 避免每个新桶都触发一轮全量排序。
      if (buckets.size > maxBuckets) evict(Math.floor(maxBuckets * 0.9));
    }
    scheduleFlush();
    return true;
  }

  // 采纳磁盘上本进程没有的桶（键并集，同键以本进程累计为准——并发下最多
  // 低估、不会重复计数）。
  function mergeFromDisk() {
    if (!persist) return;
    let f;
    try { f = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return; }
    if (!f || !Array.isArray(f.buckets)) return;
    for (const raw of f.buckets) {
      if (!raw || typeof raw.s !== 'string' || !SCOPE_RE.test(raw.s)) continue;
      const b = normalizeBucket(raw);
      const key = bucketKey(b);
      if (!buckets.has(key)) buckets.set(key, b);
    }
  }

  // 立即落盘：锁内「合并磁盘 → 临时文件 → rename 原子替换」。失败不抛，
  // 留 dirty 等下个防抖窗口重试。
  function flushNow() {
    if (!persist) {
      dirty = false;
      return true;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      filelock.withLock(file, () => {
        mergeFromDisk();
        const payload = JSON.stringify({
          version: FILE_VERSION,
          saved: new Date().toISOString(),
          buckets: [...buckets.values()],
        });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, payload, 'utf8');
        filelock.renameAtomic(tmp, file);
      });
      dirty = false;
      return true;
    } catch (e) {
      dirty = true;
      scheduleFlush();
      return false;
    }
  }

  // 把一组桶累加成一行统计。均值必须带样本数加权，不能对每桶均值再平均。
  function finish(a) {
    return {
      requests: a.q,
      errors: a.e,
      input_tokens: a.p,
      output_tokens: a.c,
      total_tokens: a.t,
      // 缓存三段（非缓存输入 / 缓存命中）：老数据桶没有这两个字段时是 0，
      // 与「上游没给缓存」的真实 0 无法区分——字段语义见 addEntry 注释。
      input_noncached_tokens: a.ci,
      cached_tokens: a.cc,
      avg_ms: a.ln ? Math.round(a.l / a.ln) : 0,
      ms_samples: a.ln,
    };
  }

  function keyed(m) {
    return [...m.entries()]
      .map(([key, a]) => ({ key, ...finish(a) }))
      .sort((x, y) => (y.total_tokens - x.total_tokens)
        || (y.requests - x.requests)
        || (x.key < y.key ? -1 : 1));
  }

  /**
   * 窗口聚合查询。
   *   - hours > 0：滚动窗口，从本地当前整点往回 hours-1 小时（含当前小时桶）；
   *   - from/to（毫秒）：显式区间，桶起点落在 [from, to] 内的入窗；
   *   - 都不传：全部历史（含已折叠日桶）。
   * channel：按通道精确过滤（含 'untagged'）。
   */
  function snapshot(opts2 = {}) {
    const nowMs = now();
    let from = Number(opts2.from) || 0;
    let to = Number(opts2.to) || 0;
    const hours = Math.min(Math.max(Number(opts2.hours) || 0, 0), 24 * 60);
    if (!from && !to && hours > 0) from = localHourFloor(nowMs) - (hours - 1) * HOUR_MS;
    const channel = dim(opts2.channel);
    const windowed = !!(from || to);

    const acc = () => ({ q: 0, e: 0, p: 0, c: 0, t: 0, l: 0, ln: 0, ci: 0, cc: 0, c0: 0, c0p: 0 });
    const add = (a, b) => {
      a.q += b.q; a.e += b.e; a.p += b.p; a.c += b.c; a.t += b.t; a.l += b.l; a.ln += b.ln;
      a.ci += b.ci || 0; a.cc += b.cc || 0; a.c0 += b.c0 || 0; a.c0p += b.c0p || 0;
    };
    const total = acc();
    const byChannel = new Map();
    const byAccount = new Map();
    const byModel = new Map();
    const series = new Map();
    let matched = 0;
    let since = '';
    for (const b of buckets.values()) {
      if (!since || b.s < since) since = b.s;
      if (windowed) {
        const ts = scopeTime(b.s);
        if (ts == null) continue;
        if (from && ts < from) continue;
        if (to && ts > to) continue;
      }
      if (channel && b.r !== channel) continue;
      matched++;
      add(total, b);
      const push = (m, k) => {
        let a = m.get(k);
        if (!a) { a = acc(); m.set(k, a); }
        add(a, b);
      };
      push(byChannel, b.r);
      push(byAccount, b.u);
      push(byModel, b.m);
      push(series, b.s);
    }

    // 时序升序：'d:' < 'h:' 且同前缀内 ISO 串即时间序，字典序即时间序
    // （日桶只来自超龄小时折叠，恒早于活着的小时桶）。
    const seriesRows = [...series.entries()]
      .sort((x, y) => (x[0] < y[0] ? -1 : 1))
      .map(([s, a]) => ({
        t: s.slice(2),
        scope: s[0] === 'h' ? 'hour' : 'day',
        ...finish(a),
      }));

    return {
      totals: finish(total),
      // 全价请求洞察（hub v1.7.21）：prompt ≥ 阈值且确认零缓存的请求——
      // 换前缀/新开会话/压缩后首轮的高成本形态，单行日志看不出来。
      // credit_share 本项目不做：各通道积分口径不同且埋点无统一 credits
      // 字段，tokens 占比是能如实给出的部分（不编数）。
      full_price: {
        threshold: fullPriceMin,
        requests: total.c0,
        prompt_tokens: total.c0p,
        prompt_share: total.p > 0 ? Number((total.c0p / total.p).toFixed(4)) : 0,
      },
      by_channel: keyed(byChannel),
      by_account: keyed(byAccount),
      by_model: keyed(byModel),
      series: seriesRows,
      buckets: matched,
      since: since ? since.slice(2) : '',
      window: {
        hours: hours || undefined,
        from: from || undefined,
        to: to || undefined,
      },
      generated: new Date(nowMs).toISOString(),
    };
  }

  function describe() {
    let bytes = 0;
    if (persist) {
      try { bytes = fs.statSync(file).size; } catch (e) { /* 还没落过盘 */ }
    }
    return { buckets: buckets.size, file: file || '', file_bytes: bytes };
  }

  function dispose() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  if (persist) mergeFromDisk(); // 启动恢复；损坏文件由 mergeFromDisk 吞掉、从空起步

  return { addEntry, snapshot, rollup, flushNow, describe, dispose };
}

// ---- 模块级共享实例（生产路径）：首次用到时按 DATA_DIR 懒加载 ----
let sharedInst = null;
function shared() {
  if (!sharedInst) sharedInst = create({ dir: DATA_DIR });
  return sharedInst;
}

module.exports = {
  create,
  FILE_NAME,
  addEntry: (entry) => shared().addEntry(entry),
  snapshot: (opts) => shared().snapshot(opts),
  rollup: () => shared().rollup(Date.now()),
  flushNow: () => shared().flushNow(),
  describe: () => shared().describe(),
};
