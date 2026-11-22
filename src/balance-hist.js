// src/balance-hist.js - 余额变动流水账本（施工包 C / GAP F4）
//
// 为什么需要：签到 / 保活 / 手动刷新都会查到余额，但「某账号余额什么时候从
// 多少变成多少」此前没有任何留痕——变动数据散失，画不出余额曲线、算不出
// 消耗速率。把余额当观测量逐次比对，变动即留痕（Delta 带符号双向），覆盖
// 全部获取渠道；展示层用正负号区分获取与消耗。
//
// 记账规则（对齐 credithist 参照 + 首见建基线不误报）：
//   - 首次见到某账号：写一条 delta=null 的基线行（不误报成「刚获得」，
//     同时让重启后能从文件恢复基线）；
//   - 余额与基线相同：不落盘；
//   - |Delta| <= maxDelta：留痕一条带符号流水；
//   - |Delta| > maxDelta：上游脏数据 / 口径切换（如「不限量」哨兵值），
//     只挪基线不留痕，避免一条假流水污染整段历史。
//
// 落盘：data/balance-hist.jsonl 追加式（复用 jsonl.js 的 16MB 轮转）。追加
// 天然多进程安全（网关 / 管理端可各自观察）；每个进程维护自己的基线缓存，
// 并发观察同一账号时可能多记一条同值行，无害。
//
// 查询从文件尾反向分块扫：最新优先、命中即停、from 时间界一到整段停，
// 不做整文件加载——对齐请求归档查询的早停模式。
const fs = require('fs');
const path = require('path');
const jsonl = require('./jsonl');

const FILE_NAME = 'balance-hist.jsonl';
const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
const DEFAULT_MAX_DELTA = Math.max(
  1,
  Number(process.env.DUMATE_BALANCE_HIST_MAX_DELTA) || 1000000,
);
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;
const TAIL_BYTES = 64 * 1024;
const CHUNK_BYTES = 256 * 1024;

function dim(v) {
  return String(v == null ? '' : v).replace(/\x00/g, '');
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

// 解析一行流水；余额必须是有限数，坏行丢弃。
function parseLine(line) {
  let r;
  try { r = JSON.parse(line); } catch (e) { return null; }
  if (!r || typeof r !== 'object') return null;
  const balance = Number(r.balance);
  if (!Number.isFinite(balance)) return null;
  return r;
}

/**
 * 创建账本实例。生产用模块级共享实例，测试用工厂注入独立目录 / 时钟。
 *
 * @param {object} [opts]
 * @param {string} [opts.dir]      数据目录
 * @param {string} [opts.file]     落盘文件绝对路径
 * @param {boolean} [opts.persist] false = 纯内存（测试用）
 * @param {number} [opts.maxBytes] jsonl 轮转阈值
 * @param {number} [opts.maxDelta] 单次变动留痕上限
 * @param {() => number} [opts.now] 时钟注入
 */
function create(opts = {}) {
  const dir = opts.dir || DATA_DIR;
  const persist = opts.persist !== false;
  const file = opts.persist === false ? '' : (opts.file || path.join(dir, FILE_NAME));
  const maxBytes = opts.maxBytes || jsonl.DEFAULT_MAX_BYTES;
  const maxDelta = opts.maxDelta || DEFAULT_MAX_DELTA;
  const now = opts.now || Date.now;

  const baselines = new Map();   // account → 最近一次余额
  const baselineTs = new Map();  // account → 该基线的观测时刻（refreshTail 判行新旧用）
  let loaded = false;

  function gens() {
    return persist ? [file, `${file}.old`] : [];
  }

  // 进程内基线冷启动：整读当前代文件一次（≤16MB，每进程一次），同账号
  // 后写的行覆盖先写的——文件追加序即时间序，最后一行就是最新基线。
  // .old 里的基线不读：轮转后的老基线丢了顶多让下次观察重记一条基线行，
  // 不会误报 Delta。
  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    if (!persist) return;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
    for (const line of text.split('\n')) {
      const r = parseLine(line.trim());
      if (r && r.account != null) {
        const key = String(r.account);
        baselines.set(key, Number(r.balance));
        baselineTs.set(key, Number(r.ts) || 0);
      }
    }
  }

  // 每次观察前从文件尾刷新基线：他进程可能刚写过同账号，不刷新的话本进程
  // 会拿旧基线算错 Delta。只读末尾 64KB；首段是否半行按窗口前置字节判定
  // （见实现内注释），完整行照常采纳；采纳按 ts 判新旧——文件里本进程自己
  // 的旧行（脏数据护栏静默挪基线后尤甚）不得把内存基线拉回过去。
  function refreshTail() {
    if (!persist) return;
    let size = 0;
    let fd = null;
    try {
      size = fs.statSync(file).size;
      if (!size) return;
      fd = fs.openSync(file, 'r');
    } catch (e) { return; }
    try {
      const len = Math.min(TAIL_BYTES, size);
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, size - len + got);
        if (n <= 0) break;
        got += n;
      }
      if (got <= 0) return;
      // 首段是否半行,看窗口起点前一个字节是不是 \n:是 → 首行完整,照常处理;
      // 不是（或窗口已顶到文件头）→ 首段是被截断的半行,跳过。无条件跳过会漏掉
      // 他进程刚写的基线——轮转后该账号若只有这一条更新,本进程就会拿旧基线
      // 算出错误 Delta。
      let first = 1;
      if (size === len) {
        first = 0;
      } else {
        try {
          const prev = Buffer.alloc(1);
          const n = fs.readSync(fd, prev, 0, 1, size - len - 1);
          if (n === 1 && prev[0] === 0x0A) first = 0;
        } catch (e) { /* 读不到前置字节按半行处理 */ }
      }
      const lines = buf.toString('utf8', 0, got).split('\n');
      for (let i = first; i < lines.length; i++) {
        const r = parseLine(lines[i].trim());
        if (!r || r.account == null) continue;
        // 只采纳比已知基线**更新**的行（按 ts）：文件里该账号自己的旧行
        // （或本进程刚写过但 ts 相同的行）不得把内存基线拉回去——脏数据护栏
        // 静默挪基线后、落盘失败留在内存的基线,都靠这条不被文件回退。
        const key = String(r.account);
        const ts = Number(r.ts) || 0;
        if (!(ts > (baselineTs.get(key) || 0))) continue;
        baselines.set(key, Number(r.balance));
        baselineTs.set(key, ts);
      }
    } finally {
      try { fs.closeSync(fd); } catch (e) { /* 已关 */ }
    }
  }

  /**
   * 记录一次真实查到的余额。
   * @returns {object|null} 本次写下的流水行；无变动 / 无效输入返回 null。
   */
  function observe(o) {
    if (!o || typeof o !== 'object') return null;
    // 显式挡 null：Number(null) === 0 会把「余额未知」记成一次跌破到 0 的
    // 观测（曲线上凭空出现一次清零又恢复）。只认真正的数值输入。
    if (o.balance === null || o.balance === undefined || o.balance === '') return null;
    const balance = Number(o.balance);
    if (!Number.isFinite(balance)) return null;
    const account = dim(o.account).slice(0, 200);
    const channel = dim(o.channel).slice(0, 40);
    const source = dim(o.source).slice(0, 40);
    ensureLoaded();
    refreshTail();
    const prev = baselines.get(account);
    if (prev !== undefined && prev === balance) return null;
    const ts = Number(o.ts) || now();
    let entry = null;
    if (prev === undefined) {
      entry = { ts, account, channel, balance, delta: null, before: null, after: balance, source };
    } else {
      const delta = round2(balance - prev);
      // 超限视为脏数据：只挪基线不留痕
      if (Math.abs(delta) <= maxDelta) {
        entry = { ts, account, channel, balance, delta, before: prev, after: balance, source };
      }
    }
    baselines.set(account, balance);
    baselineTs.set(account, ts);
    if (entry && persist) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        jsonl.append(file, `${JSON.stringify(entry)}\n`, maxBytes);
      } catch (e) { /* 落盘失败不影响观察方主流程，基线仍在内存 */ }
    }
    return entry;
  }

  /**
   * 流水时间线：最新在前。
   * limit <= 0 表示不限（配合 from 时间界仍然早停有界）；from/to 毫秒闭区间；
   * account / source 精确匹配。返回 { rows, hasMore }。
   */
  function timeline(opts2 = {}) {
    let limit = Number(opts2.limit);
    if (!Number.isFinite(limit) || limit <= 0) limit = 0;
    else limit = Math.min(limit, MAX_LIMIT);
    const account = opts2.account != null ? dim(opts2.account) : null;
    const source = opts2.source != null ? dim(opts2.source) : null;
    const from = Number(opts2.from) || 0;
    const to = Number(opts2.to) || 0;
    const rows = [];
    let stopped = false;
    for (const f of gens()) {
      if (stopped) break;
      stopped = scanFileReverse(f, (line) => {
        const r = parseLine(line);
        if (!r) return true;
        // 追加序即时间序：碰到比 from 更早的行，更旧的整段出局
        if (from && Number(r.ts) && Number(r.ts) < from) return false;
        if (to && Number(r.ts) && Number(r.ts) > to) return true;
        if (account != null && String(r.account) !== account) return true;
        if (source != null && String(r.source) !== source) return true;
        if (limit > 0 && rows.length >= limit) return false;
        rows.push(r);
        return true;
      });
    }
    return { rows, hasMore: stopped && limit > 0 };
  }

  /**
   * 余额曲线：升序采样点，超过 maxPoints 时等步长降采样（末点必留）。
   * 基线行（delta=null）也是曲线点，天然参与。
   */
  function curve(opts2 = {}) {
    const maxPoints = Math.max(2, Number(opts2.maxPoints) || 400);
    const { rows } = timeline({ account: opts2.account, from: opts2.from, to: opts2.to, limit: 0 });
    const asc = rows.slice().reverse();
    const n = asc.length;
    let picked = asc;
    if (n > maxPoints) {
      const step = Math.ceil(n / maxPoints);
      picked = [];
      for (let i = 0; i < n; i += step) picked.push(asc[i]);
      if (picked[picked.length - 1] !== asc[n - 1]) picked.push(asc[n - 1]);
    }
    return {
      points: picked.map((r) => ({ ts: Number(r.ts) || 0, balance: Number(r.balance) })),
      total: n,
    };
  }

  /**
   * 消耗速率：窗口内带符号 Delta 汇总。consumed = 负向 Delta 绝对值之和，
   * gained = 正向之和，consumed_per_hour 折算到每小时。
   */
  function rate(opts2 = {}) {
    const nowMs = now();
    const windowMs = Math.max(60000, Number(opts2.windowMs) || 86400000);
    const from = Number(opts2.from) || (nowMs - windowMs);
    const { rows } = timeline({ account: opts2.account, from, limit: 0 });
    let consumed = 0;
    let gained = 0;
    let samples = 0;
    for (const r of rows) {
      // 基线行 delta=null；Number(null) 是 0 不是 NaN，必须先判类型
      if (typeof r.delta !== 'number' || !Number.isFinite(r.delta)) continue;
      samples++;
      if (r.delta < 0) consumed += -r.delta;
      else gained += r.delta;
    }
    return {
      account: opts2.account == null ? '' : dim(opts2.account),
      window_ms: windowMs,
      from,
      consumed: round2(consumed),
      gained: round2(gained),
      net: round2(gained - consumed),
      consumed_per_hour: round2(consumed / (windowMs / 3600000)),
      samples,
    };
  }

  function baselinesView() {
    return new Map(baselines);
  }

  // 从文件尾反向逐行产出（最新在前）。按字节 \n 切分——UTF-8 多字节字符
  // 不含 0x0A，跨块边界切行不会切坏中文账号名。visit 返回 false 表示停止。
  // 返回 true 表示因 visit 叫停（命中上限 / from 早停），false 表示扫完文件。
  function scanFileReverse(f, visit) {
    let fd;
    try { fd = fs.openSync(f, 'r'); } catch (e) { return false; }
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK_BYTES, size)));
      let pos = size;
      let rem = null; // 更新一侧切出的行尾段（行首在更旧的未读字节里）
      while (pos > 0) {
        const len = Math.min(buf.length, pos);
        pos -= len;
        let got = 0;
        while (got < len) {
          const n = fs.readSync(fd, buf, got, len - got, pos + got);
          if (n <= 0) break;
          got += n;
        }
        if (got <= 0) break;
        const head = buf.subarray(0, got);
        const combined = rem && rem.length ? Buffer.concat([head, rem]) : Buffer.from(head);
        const nl = combined.indexOf(10);
        if (nl === -1) {
          // 整块无换行：都是某条超长行的一部分，继续向旧块拼接
          rem = combined;
          continue;
        }
        rem = Buffer.from(combined.subarray(0, nl));
        // 第一个 \n 之后的分段都完整；最后一段与本块行尾融合，同样完整
        const segs = [];
        let start = nl + 1;
        for (let i = combined.indexOf(10, start); i !== -1; i = combined.indexOf(10, start)) {
          segs.push(combined.subarray(start, i));
          start = i + 1;
        }
        segs.push(combined.subarray(start));
        for (let i = segs.length - 1; i >= 0; i--) {
          const s = segs[i].toString('utf8').trim();
          if (s && visit(s) === false) return true;
        }
      }
      if (rem && rem.length) {
        const s = rem.toString('utf8').trim();
        if (s && visit(s) === false) return true;
      }
      return false;
    } finally {
      try { fs.closeSync(fd); } catch (e) { /* 已关 */ }
    }
  }

  // 基线在创建时整读一次当前代文件（懒加载会让 baselinesView 在首次观察前
  // 恒为空，面板「当前余额」会拿到假空表）。之后靠 refreshTail 跟进增量。
  ensureLoaded();

  return { observe, timeline, curve, rate, baselinesView };
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
  observe: (o) => shared().observe(o),
  timeline: (opts) => shared().timeline(opts),
  curve: (opts) => shared().curve(opts),
  rate: (opts) => shared().rate(opts),
  baselines: () => shared().baselinesView(),
};
