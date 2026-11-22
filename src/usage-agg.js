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
// 2026-11-16（调研 P2-13）补两组**口径上本来就该有、但一直缺**的指标：
//   - TTFB（`first_token_ms`）：以前只有 /overview 现扫 jsonl 算今日均值，
//     明细一滚就没了；现在按桶累加（样本数/和/min/max/>3s 计数/8 段直方图），
//     直方图让 p50/p90 也能跨轮转保留。**分母只数「报了 TTFB 的请求」**——
//     老日志没这个字段时当 0 算会把均值拉低，那是最典型的假数字。
//   - 缓存写入（`cache_creation_input_tokens`）：命中率的分母必须把它剔掉。
//     定义：命中率 = 读命中 /（读命中 + 纯新输入），其中「纯新 = 非缓存输入 −
//     写入」。写入的 token 没被读过一次，算进分母等于把「预热轮」当成「没命中」，
//     每加一段前缀就凭空掉几个百分点。分母为 0 时命中率是 **null 而不是 0**
//     （没样本 ≠ 全miss），与仓库「null ≠ 0」同一条纪律。
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

/**
 * TTFB 直方图的分段上界（毫秒）。**8 段是有意压小的**：分桶账本要 JSON 落盘，
 * 每桶存 8 个整数已经够拿 p50/p90，再细分只会让 5 万个桶的文件变大而不增加决策价值。
 * 最后一段没有上界（> 30s）。
 */
const TTFB_EDGES = [250, 500, 1000, 2000, 5000, 10000, 30000];

/** 一次 TTFB 落在第几段（0..TTFB_EDGES.length） */
function histBucketOf(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return -1;
  for (let i = 0; i < TTFB_EDGES.length; i++) {
    if (v < TTFB_EDGES[i]) return i;
  }
  return TTFB_EDGES.length;
}

/**
 * 从直方图取分位数。返回 `{ms, lo, hi}`：
 *   ms = 命中段的上界（**近似值**，UI 显示成「≈」）
 *   lo/hi = 该段的真实区间，最后一段 hi 为 null（表示「以上」）
 * 找不到样本返回 null——**不是 0**。
 */
function percentileOf(hist, p) {
  const list = Array.isArray(hist) ? hist : [];
  const total = list.reduce((a, b) => a + (Number(b) || 0), 0);
  if (!total) return null;
  const want = Math.min(1, Math.max(0, Number(p) || 0)) * total;
  let seen = 0;
  for (let i = 0; i < list.length; i++) {
    seen += Number(list[i]) || 0;
    if (seen >= want) {
      const lo = i === 0 ? 0 : TTFB_EDGES[i - 1];
      const hi = i < TTFB_EDGES.length ? TTFB_EDGES[i] : null;
      return { ms: hi == null ? lo : hi, lo, hi };
    }
  }
  const lo = TTFB_EDGES[TTFB_EDGES.length - 1];
  return { ms: lo, lo, hi: null };
}

/**
 * 命中率（0~1）与它的分子分母。**分母 = 读命中 + 纯新输入**，把缓存写入剔掉。
 * 分母 0 → `null`（没样本），不是 0（全 miss）。
 */
function hitRateOf(cached, noncached, creation, reported) {
  const cc = Math.max(0, Number(cached) || 0);
  const ci = Math.max(0, Number(noncached) || 0);
  const cw = Math.max(0, Number(creation) || 0);
  // `reported` = 这一行里**有多少条请求的上游真的报了缓存字段**。
  // 一条都没报时命中率是 null：「这个通道不上报缓存」与「全 miss」是两件事，
  // 把前者显示成 0% 会让人去查一个根本不存在的问题（同 null ≠ 0）。
  const rep = reported == null ? 1 : Math.max(0, Number(reported) || 0);
  const fresh = Math.max(0, ci - cw);
  const denom = cc + fresh;
  return {
    numerator: cc,
    denominator: denom,
    fresh_tokens: fresh,
    cache_write_tokens: cw,
    reported: rep,
    rate: (rep > 0 && denom > 0) ? Math.round((cc / denom) * 10000) / 10000 : null,
  };
}

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
    // P2-13 新增：缓存写入与 TTFB（含 8 段直方图）。**这里是第三份字段清单**
    // （addEntry 造桶、mergeInto 合并、本函数从磁盘读回），三处必须同进同退——
    // 2026-11-16 实测漏过：种子数据写盘成功，管理端读回来 ttfb_samples 恒 0。
    // 回归守卫在 test/unit/usage-ttfb-hitrate.test.js 的「重启后字段不丢」。
    cw: num(raw.cw),
    cwn: num(raw.cwn),
    cr: num(raw.cr),
    fn: num(raw.fn),
    fl: num(raw.fl),
    fmin: raw.fmin == null ? null : Number(raw.fmin),
    fmax: raw.fmax == null ? null : Number(raw.fmax),
    fslow: num(raw.fslow),
    fh: Array.isArray(raw.fh)
      ? Array.from({ length: TTFB_EDGES.length + 1 }, (_, i) => num(raw.fh[i]))
      : null,
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

  /**
   * 同键桶的唯一合并实现。**只此一处**：TTFB 直方图与缓存写入这些新字段
   * 加进来时，只要有两份合并代码就必然有一份会漏（漏了的表现是「小时桶有、
   * 折叠成日桶后没了」，且不报错）。`dst` 是被改的那一份。
   */
  function mergeInto(dst, src) {
    dst.q += src.q; dst.e += src.e; dst.p += src.p; dst.c += src.c;
    dst.t += src.t; dst.l += src.l; dst.ln += src.ln;
    dst.ci += src.ci || 0; dst.cc += src.cc || 0;
    dst.c0 += src.c0 || 0; dst.c0p += src.c0p || 0;
    dst.cw = (dst.cw || 0) + (src.cw || 0);
    dst.cwn = (dst.cwn || 0) + (src.cwn || 0);
    dst.cr = (dst.cr || 0) + (src.cr || 0);
    if (src.fn) {
      dst.fn = (dst.fn || 0) + src.fn;
      dst.fl = (dst.fl || 0) + src.fl;
      dst.fmin = Math.min(dst.fmin == null ? Infinity : dst.fmin, src.fmin);
      dst.fmax = Math.max(dst.fmax == null ? 0 : dst.fmax, src.fmax);
      dst.fslow = (dst.fslow || 0) + (src.fslow || 0);
      if (!Array.isArray(dst.fh)) dst.fh = new Array(TTFB_EDGES.length + 1).fill(0);
      for (let i = 0; i < src.fh.length; i++) dst.fh[i] += src.fh[i];
    }
    return dst;
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
      else mergeInto(dst, b);
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
      // 缓存写入（P2-13）：命中率的分母要剔掉它。`cwn` 数「有多少条真的报了
      // 写入字段」——只有 Anthropic 系通道会报，没报的通道不能当「写入 0」算。
      cw: Math.max(0, Number(entry.cache_creation_tokens) || 0),
      cwn: entry.cache_creation_reported ? 1 : 0,
      // 上报过缓存字段的请求数：命中率的分母之外还要这个，否则
      // 「通道不上报缓存」会被显示成「命中率 0%」
      cr: entry.cached_reported ? 1 : 0,
    };
    // TTFB（P2-13）：**只数有值的请求**。老日志没这个字段就不进样本，
    // 不会被当成 0ms 把均值拉低（这是最典型的假数字）。
    if (Number.isFinite(entry.first_token_ms) && entry.first_token_ms >= 0) {
      const ft = Number(entry.first_token_ms);
      b.fn = 1;
      b.fl = ft;
      b.fmin = ft;
      b.fmax = ft;
      b.fslow = ft > 3000 ? 1 : 0;
      b.fh = new Array(TTFB_EDGES.length + 1).fill(0);
      b.fh[histBucketOf(ft)] += 1;
    }
    const key = bucketKey(b);
    const cur = buckets.get(key);
    if (cur) mergeInto(cur, b);
    else buckets.set(key, b);
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

  function histogramP50(h) { return percentileOf(h, 0.5); }
  function histogramP90(h) { return percentileOf(h, 0.9); }

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
      // 缓存写入（P2-13）：写入 token 与「报了这个字段的请求数」。
      cache_creation_tokens: a.cw || 0,
      cache_creation_reported: a.cwn || 0,
      /** 上游报了缓存字段的请求数：0 表示这一行的命中率不可知（不是 0%） */
      cache_reported: a.cr || 0,
      // TTFB（P2-13）：avg 的分母是 fn（报了 TTFB 的请求数），不是 q。
      // 无样本时 avg/p50/p90 都是 **null**（不是 0）——没有样本 ≠ 首字 0ms。
      ttfb_avg_ms: a.fn ? Math.round(a.fl / a.fn) : null,
      ttfb_samples: a.fn || 0,
      ttfb_min_ms: a.fn ? a.fmin : null,
      ttfb_max_ms: a.fn ? a.fmax : null,
      ttfb_slow: a.fslow || 0,
      ttfb_p50: histogramP50(a.fh),
      ttfb_p90: histogramP90(a.fh),
    };
  }

  /** 给一行统计补命中率（`hitRateOf` 是唯一实现） */
  function withHitRate(row) {
    return {
      ...row,
      cache_hit: hitRateOf(row.cached_tokens, row.input_noncached_tokens, row.cache_creation_tokens, row.cache_reported),
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

    // 累加器与 mergeInto 是同一套字段。**这里也要跟着加**：快照是另一条
    // 汇总路径（桶 → 分组行），漏一个字段的表现是「桶里有、页面上没有」。
    const acc = () => ({
      q: 0, e: 0, p: 0, c: 0, t: 0, l: 0, ln: 0, ci: 0, cc: 0, c0: 0, c0p: 0,
      cw: 0, cwn: 0, cr: 0, fn: 0, fl: 0, fmin: null, fmax: null, fslow: 0, fh: null,
    });
    const add = (a, b) => mergeInto(a, b);
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
      totals: withHitRate(finish(total)),
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
      // 命中率（P2-13）：分子分母都摊在行上，页面与调用方都能自己复核。
      // 口径只有一处实现（hitRateOf）——分母剔掉缓存写入，空分母是 null。
      by_channel: keyed(byChannel).map(withHitRate),
      by_account: keyed(byAccount).map(withHitRate),
      by_model: keyed(byModel).map(withHitRate),
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
  TTFB_EDGES, histBucketOf, percentileOf, hitRateOf,
};
