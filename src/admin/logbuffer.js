// src/admin/logbuffer.js - 管理端进程运行日志环形缓冲（只读、强制脱敏）
//
// 调研 P1-9。管理端与网关是两个进程，这里只收**本进程** console 输出；
// 网关侧日志由网关进程自己持有（同款模块），不在本模块跨进程转发——
// 跨进程搬运 stdout 要么改启动器，要么引入 IPC，两者都比「看对应进程」
// 多一个故障点。
//
// 三条硬纪律：
//   1. 脱敏在**入缓冲之前**：原始串绝不进环形数组，防后来的读取路径漏过。
//      命中敏感键/形状整行丢弃（不回显打码后的值——打码长度与字符集本身
//      也是信息）；Bearer / sk- / cookie / authorization 都算。
//   2. 环形上限固定（每频道默认 500 行）；不落盘（归档落盘是 logarchive
//      的职责，同样只收脱敏后的行），重启即空（运行日志不是审计账本）。
//   3. 订阅者上限 4，SSE 先回放再推新；订阅者断开由路由层清理，不泄漏。
//      sink 不占订阅者名额——那是进程内单向喂给归档的管道，不是 SSE 客户端。
//
// 三频道（批次十八）：内存环按行首特征分 chat/task/sys——任务结果单独一环，
// 不被将来可能出现的对话流量冲掉。判据只有行首特征，不做全文猜测：
//   - 显式标签 `[chat]` / `[task]` / `[sys]` 直接命中（剥掉 server.js log()
//     的 ISO 时间戳前缀后匹配），将来按请求的对话日志用这个入口选频道；
//   - 已有的任务/巡检类前缀（[keepalive] 等）归 task；
//   - 其余一律 sys（启动横幅、系统告警——本仓库今天 console 的绝对主体）。
const MAX_LINES = 500;
const MAX_SUBSCRIBERS = 4;
const CHANNELS = ['chat', 'task', 'sys'];

// 输出重定向只在 install() 里替换 console.log/warn/error 的**一次**；
// original 继续写真实 stdout（启动器靠文件重定向收日志），不丢既有行为。

const CHANNEL_TAG = /^\[(chat|task|sys)\]/;
const TASK_PREFIX = /^\[(?:keepalive|workbuddy-window|workbuddy-web|autotask|tasks)\]/;
const TS_PREFIX = /^\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s*/; // server.js log() 的时间戳前缀

/** 行首特征 → 频道。导出供离线测试锁语义。 */
function channelOf(text) {
  const bare = String(text == null ? '' : text).replace(TS_PREFIX, '');
  const m = CHANNEL_TAG.exec(bare);
  if (m) return m[1];
  if (TASK_PREFIX.test(bare)) return 'task';
  return 'sys';
}

const SENSITIVE_KEY = /(?:^|[^a-z])(token|secret|authorization|cookie|password|passwd|api[_-]?key|refresh[_-]?token|access[_-]?token|private[_-]?key|set-cookie)(?:[^a-z]|$)/i;
const SECRET_SHAPE = /Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
// 形如 `key=value` 且键名敏感：即使整行没有明文标记也要丢。
// 中文标签同样要认——--reset-admin 的横幅打的是「密码:  <值>」（2026-11-28
// 实测漏过 ASCII 版判据，整行落进了归档）；带显式分隔符才命中，
// 「凭据不可用」这类正文词不误伤。
const SECRET_PAIR = /(?:token|secret|password|passwd|api[_-]?key|cookie)\s*[=:]\s*\S+|(?:密码|口令|密钥|秘钥|令牌|凭据)\s*[:：=]\s*\S+/i;

/** 敏感行判定（导出供离线测试与网关复用） */
function isSensitive(text) {
  const s = String(text == null ? '' : text);
  return SENSITIVE_KEY.test(s) || SECRET_SHAPE.test(s) || SECRET_PAIR.test(s);
}

/** 单条日志形状。level 只取 log/warn/error，其余归 log */
function entry(level, args, now = Date.now()) {
  const raw = (args || []).map((x) => {
    if (typeof x === 'string') return x;
    if (x instanceof Error) return x.stack || x.message;
    try { return JSON.stringify(x); } catch (e) { return String(x); }
  }).join(' ');
  if (isSensitive(raw)) return null;
  return { ts: now, level: ['warn', 'error'].includes(level) ? level : 'log', text: raw.slice(0, 4000), ch: channelOf(raw) };
}

function create(opts = {}) {
  const cap = Number(opts.capacity) > 0 ? Math.floor(Number(opts.capacity)) : MAX_LINES;
  const maxSubs = Number(opts.maxSubscribers) > 0 ? Math.floor(Number(opts.maxSubscribers)) : MAX_SUBSCRIBERS;
  const rings = { chat: [], task: [], sys: [] };
  const subs = new Set();
  const sinks = new Set(); // 进程内单向管道（归档），不占订阅者上限
  let seq = 0;

  function push(level, args) {
    const e = entry(level, args);
    if (!e) return;                   // 敏感整行丢弃，绝不进缓冲
    e.seq = ++seq;
    const ring = rings[e.ch] || rings.sys;
    ring.push(e);
    if (ring.length > cap) ring.splice(0, ring.length - cap);
    for (const fn of sinks) {
      try { fn(e); } catch (err) { /* 归档失败不拖垮转发 */ }
    }
    for (const fn of subs) {
      try { fn(e); } catch (err) { /* 单个订阅者写入失败不影响其它订阅者 */ }
    }
  }

  function read(filter = {}) {
    const level = String(filter.level || '').trim().toLowerCase();
    const keyword = String(filter.keyword || '').trim().toLowerCase();
    const channel = String(filter.channel || '').trim().toLowerCase();
    // 未知频道名返回空——不猜、不静默回落到全部
    const pool = !channel ? CHANNELS.flatMap((c) => rings[c]) : (rings[channel] || []);
    return pool.filter((x) => (!level || x.level === level) && (!keyword || x.text.toLowerCase().includes(keyword)))
      .sort((a, b) => a.seq - b.seq)
      .map((x) => ({ ...x }));
  }

  function subscribe(fn, filter = {}) {
    if (subs.size >= maxSubs) return null;
    subs.add(fn);
    return () => subs.delete(fn);
  }

  function install() {
    for (const level of ['log', 'warn', 'error']) {
      const orig = console[level].bind(console);
      console[level] = (...args) => { push(level, args); orig(...args); };
    }
  }

  function addSink(fn) {
    sinks.add(fn);
    return () => sinks.delete(fn);
  }

  return {
    push, read, subscribe, install, addSink, isSensitive,
    size: () => CHANNELS.reduce((n, c) => n + rings[c].length, 0),
    sizeByChannel: () => Object.fromEntries(CHANNELS.map((c) => [c, rings[c].length])),
    subscriberCount: () => subs.size,
    sinkCount: () => sinks.size,
    channels: CHANNELS,
  };
}

const shared = create();

module.exports = { create, shared, isSensitive, entry, channelOf, MAX_LINES, MAX_SUBSCRIBERS, CHANNELS };
