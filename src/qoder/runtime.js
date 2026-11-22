// src/qoder/runtime.js - Qoder 稳定性参数的运行期配置（热生效，跨进程按 mtime 重读）
//
// 出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P0-3「运行时配置面板化（热生效）」。
//
// **要修的真问题**：`qoder/chat.js` 的三个计时器（首字节 / 无内容 / 读空闲）与
// 请求体上限都是**模块加载时**读一次 `process.env` 就定死——调阈值必须重启 9082。
// 这类「定时器写死」已经造成过一次事故（6s 无内容阈值误杀大上下文 prefill，
// 见 CLAUDE.md 与 chat.js 的 90s 修正注释）。
//
// 纪律与 workbuddy/runtime.js、trae-runtime.js、livecfg.js 完全同构，四条缺一条
// 就会出静默故障：
//   1. 原子写（tmp + renameAtomic）+ 跨进程 filelock
//   2. mtime 失效重读——管理端 PUT 后，网关**下一次判定**就看到新值，不重启
//   3. 白名单清洗：磁盘宽容（未知键丢弃）/ 接口提交严格（未知键 400）
//   4. **环境变量仍是默认值来源**——只设 env 不碰面板的部署行为逐字节不变
//
// **额外一条本文件专属**：文件不存在（mtime 0）时**不缓存**默认值。
// 其余 runtime 模块都会缓存首份快照，但这里的默认值来自 env，而
// `test/verify-qoder-read-idle.js` 的手法正是「改 env → 删 require.cache → 重
// require」；若默认快照被缓存，第二次 Load 会拿到上一次的 env 值，该脚本
// 的四条不变量会当场失真。文件存在时仍按 mtime 缓存（热生效路径）。
//
// 字段分组与 env 的对应关系：
//   timeouts.firstByteMs   DUMATE_QODER_FIRST_BYTE_MS      首字节超时（0 = 关）
//   timeouts.contentMs     DUMATE_QODER_CONTENT_MS         「无内容」超时（排队 ack 兜底）
//   timeouts.readIdleMs    DUMATE_QODER_READ_IDLE_MS       读空闲超时（每块数据重置）
//   timeouts.maxBodyMb     DUMATE_QODER_MAX_BODY_MB        请求体上限（对齐 SLB 30MB）
//   queue.pollEnabled      DUMATE_QODER_QUEUE_POLL         官方排队轮询协议（'0' 关）
//   queue.pollBudgetMs     DUMATE_QODER_QUEUE_POLL_BUDGET_MS
//   queue.patienceMs       DUMATE_QODER_QUEUE_PATIENCE_MS  快速轮询总预算
//   queue.stepMs           DUMATE_QODER_QUEUE_STEP_MS      快速轮询间隔
//   queue.pollIntervalMs   DUMATE_QODER_QUEUE_POLL_INTERVAL_MS（0 = 按上游 retryAfter）
//   queue.cooldownMs       DUMATE_QODER_QUEUE_COOLDOWN_MS  排队类限流的短冷却
//   limits.throttleMaxMs   DUMATE_THROTTLE_MAX_MS          冷却上限（千问与 Qoder 共用）
//   limits.fefoDays        DUMATE_QODER_FEFO_DAYS          FEFO 临期窗口（0 = 关）
//   repair.retry           DUMATE_QODER_REPAIR_RETRY       「播报即收尾」重试上限（0 = 关）
//   repair.holdCap         DUMATE_QODER_HOLD_CAP           正文缓冲门阈值（字符）
//   concurrency.inflightMax DUMATE_QODER_INFLIGHT_MAX      单号并发闸门（0 = 用池默认 4）
//   concurrency.minIntervalMs DUMATE_QODER_MIN_INTERVAL_MS 单号最小请求间隔（0 = 关）
//   concurrency.pickStrategy DUMATE_QODER_PICK_STRATEGY    选号策略（'' = 池默认）
const fs = require('fs');
const path = require('path');
const filelock = require('../filelock');

const FILE = 'qoder-runtime.json';
const FIELDS = ['timeouts', 'queue', 'limits', 'repair', 'concurrency'];

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
}

function filePath() {
  return path.join(dataDir(), FILE);
}

/** env 读整数并夹区间：非法/缺失一律回默认（配置面不能把热路径弄崩） */
function envInt(name, dflt, min, max) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return dflt;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return dflt;
  return n;
}

/** env 读布尔：只有明确的 '0' 算 false（与 chat.js 既有口径一致） */
function envOn(name, dflt) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return dflt;
  return String(raw).trim() !== '0';
}

function defaults() {
  return {
    timeouts: {
      // 90s 的依据写在 chat.js 的 CONTENT_MS 注释里（成功请求首字实测 max 63.9s，
      // hub 记载上游可达 40~71s）。**别按「看起来太大」改小**——6s 那次就是这么错的。
      firstByteMs: envInt('DUMATE_QODER_FIRST_BYTE_MS', 60000, 0, 1800000),
      contentMs: envInt('DUMATE_QODER_CONTENT_MS', 90000, 0, 1800000),
      readIdleMs: envInt('DUMATE_QODER_READ_IDLE_MS', 120000, 0, 1800000),
      maxBodyMb: envInt('DUMATE_QODER_MAX_BODY_MB', 29, 1, 100),
    },
    queue: {
      pollEnabled: envOn('DUMATE_QODER_QUEUE_POLL', true),
      pollBudgetMs: envInt('DUMATE_QODER_QUEUE_POLL_BUDGET_MS', 60000, 0, 3600000),
      patienceMs: envInt('DUMATE_QODER_QUEUE_PATIENCE_MS', 6000, 0, 300000),
      stepMs: envInt('DUMATE_QODER_QUEUE_STEP_MS', 1500, 200, 60000),
      pollIntervalMs: envInt('DUMATE_QODER_QUEUE_POLL_INTERVAL_MS', 0, 0, 600000),
      cooldownMs: envInt('DUMATE_QODER_QUEUE_COOLDOWN_MS', 5000, 0, 600000),
    },
    limits: {
      // 上游按队列长度给 waitTime（实测 7015 秒），照单全收＝封号两小时
      throttleMaxMs: envInt('DUMATE_THROTTLE_MAX_MS', 600000, 1000, 86400000),
      // 0 = 关闭 FEFO（退回普通轮询）
      fefoDays: envInt('DUMATE_QODER_FEFO_DAYS', 3, 0, 365),
    },
    repair: {
      retry: envInt('DUMATE_QODER_REPAIR_RETRY', 1, 0, 5),
      holdCap: envInt('DUMATE_QODER_HOLD_CAP', 600, 0, 100000),
    },
    // 单号并发闸门与节奏（P1-6）。**默认 0 = 不改变现有行为**——
    // 调研建议 Qoder 默认 1，但那是「先埋点观察 10605 率再定阈值」的结论
    // （channel-pool 的注释就写着这句）。默认拦住会把吞吐砍四分之三，
    // 属于需要数据支撑的决定，不是升级时该静默改掉的行为。
    // 想直接启用：面板设 1（或设 DUMATE_QODER_INFLIGHT_MAX=1）。
    concurrency: {
      inflightMax: envInt('DUMATE_QODER_INFLIGHT_MAX', 0, 0, 64),
      minIntervalMs: envInt('DUMATE_QODER_MIN_INTERVAL_MS', 0, 0, 600000),
      // 'least-inflight' | ''（= 池默认加权抽签/轮询）
      pickStrategy: (() => {
        const raw = String(process.env.DUMATE_QODER_PICK_STRATEGY || '').trim().toLowerCase();
        return raw === 'least-inflight' || raw === 'least_inflight' ? 'least-inflight' : '';
      })(),
    },
  };
}

/**
 * 各族字段的范围表：[min, max, 错误文案]。数字字段一律整数；
 * 只有 queue.pollEnabled 是布尔，单独处理。
 */
const RANGES = {
  timeouts: {
    firstByteMs: [0, 1800000, 'timeouts.firstByteMs 需为 0-1800000 的整数（ms，0 = 关闭）'],
    contentMs: [0, 1800000, 'timeouts.contentMs 需为 0-1800000 的整数（ms，0 = 关闭）'],
    readIdleMs: [0, 1800000, 'timeouts.readIdleMs 需为 0-1800000 的整数（ms，0 = 关闭）'],
    maxBodyMb: [1, 100, 'timeouts.maxBodyMb 需为 1-100 的整数（MB）'],
  },
  queue: {
    pollBudgetMs: [0, 3600000, 'queue.pollBudgetMs 需为 0-3600000 的整数（ms）'],
    patienceMs: [0, 300000, 'queue.patienceMs 需为 0-300000 的整数（ms）'],
    stepMs: [200, 60000, 'queue.stepMs 需为 200-60000 的整数（ms）'],
    pollIntervalMs: [0, 600000, 'queue.pollIntervalMs 需为 0-600000 的整数（ms，0 = 按上游 retryAfter）'],
    cooldownMs: [0, 600000, 'queue.cooldownMs 需为 0-600000 的整数（ms）'],
  },
  limits: {
    throttleMaxMs: [1000, 86400000, 'limits.throttleMaxMs 需为 1000-86400000 的整数（ms）'],
    fefoDays: [0, 365, 'limits.fefoDays 需为 0-365 的整数（天，0 = 关闭）'],
  },
  repair: {
    retry: [0, 5, 'repair.retry 需为 0-5 的整数（0 = 关闭修复）'],
    holdCap: [0, 100000, 'repair.holdCap 需为 0-100000 的整数（字符）'],
  },
  concurrency: {
    inflightMax: [0, 64, 'concurrency.inflightMax 需为 0-64 的整数（0 = 用池默认 4）'],
    minIntervalMs: [0, 600000, 'concurrency.minIntervalMs 需为 0-600000 的整数（ms，0 = 关）'],
  },
};

const SUBFIELDS = {
  timeouts: [...Object.keys(RANGES.timeouts)],
  queue: ['pollEnabled', ...Object.keys(RANGES.queue)],
  limits: Object.keys(RANGES.limits),
  repair: Object.keys(RANGES.repair),
  concurrency: ['pickStrategy', ...Object.keys(RANGES.concurrency)],
};

const PICK_STRATEGIES = ['', 'least-inflight'];

function assertSubKeys(key, v, strict) {
  if (!strict) return;
  const allowed = SUBFIELDS[key] || [];
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) {
      throw new Error(`未知配置键: ${key}.${k}（白名单: ${allowed.join(', ')}）`);
    }
  }
}

/**
 * 白名单清洗。
 * strict=true（接口提交）：类型/范围不对直接抛错——不能把「以为设了阈值」
 * 悄悄吞成默认值。strict=false（磁盘读）：逐项回默认，坏文件不该挡住启动。
 */
function sanitize(patch, { strict = false } = {}) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const key of Object.keys(patch)) {
    if (!FIELDS.includes(key)) {
      if (strict) throw new Error(`未知配置键: ${key}（白名单: ${FIELDS.join(', ')}）`);
      continue;
    }
    const v = patch[key];
    if (v == null) continue;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      if (strict) throw new Error(`${key} 必须是对象`);
      continue;
    }
    assertSubKeys(key, v, strict);
    const cell = {};
    for (const [k, [min, max, msg]] of Object.entries(RANGES[key])) {
      if (v[k] === undefined) continue;
      const n = Number(v[k]);
      if (!Number.isInteger(n) || n < min || n > max) {
        // 0 的语义各不相同（0 = 关闭 / 0 = 按上游 retryAfter / 0 = 关闭 FEFO），
        // 范围表已经把它们包进去了，这里只拒绝越界与小数
        if (strict) throw new Error(msg);
        continue;
      }
      cell[k] = n;
    }
    if (key === 'queue' && v.pollEnabled !== undefined) {
      cell.pollEnabled = v.pollEnabled === true;
    }
    if (key === 'concurrency' && v.pickStrategy !== undefined) {
      const s = String(v.pickStrategy == null ? '' : v.pickStrategy).trim().toLowerCase();
      if (PICK_STRATEGIES.includes(s)) cell.pickStrategy = s;
      else if (strict) throw new Error(`concurrency.pickStrategy 只接受 ${PICK_STRATEGIES.filter(Boolean).map((x) => `'${x}'`).join(' / ')} 或空串`);
    }
    if (Object.keys(cell).length) out[key] = cell;
  }
  return out;
}

function merge(base, patch) {
  const out = {};
  for (const key of FIELDS) {
    out[key] = { ...(base[key] || {}), ...((patch && patch[key]) || {}) };
  }
  return out;
}

function mtimeOf() {
  try { return fs.statSync(filePath()).mtimeMs; } catch (e) { return 0; }
}

let cache = { mtime: -1, snap: null };

/**
 * 读当前配置（**私有拷贝**：调用方改了也不污染下一个读者）。
 *
 * mtime === 0（文件不存在）时**不缓存**：默认值来自 env，而测试与运维都可能
 * 在进程内改 env 后重读（见文件头第四条纪律）。
 */
function Load() {
  const m = mtimeOf();
  if (m === 0) {
    const snap = merge(defaults(), {});
    cache = { mtime: 0, snap };
    return merge(snap, {});
  }
  if (m !== cache.mtime || !cache.snap) {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(filePath(), 'utf8')); }
    catch (e) { raw = null; }
    cache = { mtime: m, snap: merge(defaults(), sanitize(raw)) };
  }
  return merge(cache.snap, {});
}

/**
 * 提交一次变更（patch 语义：只传要改的字段/子字段）。
 * @returns {{config:object, changed:object}} changed = 本次真正改动的字段
 */
function Store(patch) {
  // **先建目录再取锁**：filelock 的锁文件就落在同目录下，目录不存在时
  // openSync 直接 ENOENT 而不是 EEXIST——异常会穿出到调用方（面板保存 500）。
  // 数据目录在正常部署里总是存在的，但「首次保存到全新 DUMATE_ADMIN_DATA」
  // 与测试都是从零开始，这里不建就必然踩一次。
  fs.mkdirSync(dataDir(), { recursive: true });
  return filelock.withLock(filePath(), () => {
    cache = { mtime: -1, snap: null };
    const base = Load();
    const clean = sanitize(patch, { strict: true });
    const snap = merge(base, clean);
    fs.mkdirSync(dataDir(), { recursive: true });
    const target = filePath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8');
    filelock.renameAtomic(tmp, target);
    cache = { mtime: mtimeOf(), snap };
    return { config: Load(), changed: clean };
  });
}

/**
 * 热路径便捷取值器：任何一项读失败都回落到「该函数的默认值」。
 *
 * **为什么不直接 Load()**：`chat.js` 的三个计时器在每次请求里各调一次，任何
 * 一次异常抛出都会让本该发出的请求变成 500。配置读不到不该是这个后果——
 * 它是可选能力，故障必须不放大。
 */
function pick(pathStr, dflt) {
  try {
    const cfg = Load();
    let cur = cfg;
    for (const seg of String(pathStr).split('.')) {
      if (!cur || typeof cur !== 'object') return dflt;
      cur = cur[seg];
    }
    return cur === undefined || cur === null ? dflt : cur;
  } catch (e) {
    return dflt;
  }
}

function _resetForTest() { cache = { mtime: -1, snap: null }; }

module.exports = {
  FILE, FIELDS, SUBFIELDS, RANGES, dataDir, filePath, defaults, sanitize, merge,
  Load, Store, pick, _resetForTest,
};
