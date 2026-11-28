// src/workbuddy/runtime.js - WorkBuddy 运行期配置（热生效，跨进程按 mtime 重读）
//
// 出处：docs/WORKBUDDY-FUSION.md P2-11（hub Unreleased「连坐暂停卡片：自定义
// 时长、保存更短时长即时截断倒计时」）。此前四个连坐参数只是 `index.js`
// **模块加载时**读一次的环境变量——改一次要重启网关，面板上做不了「立刻按
// 新阈值生效」。
//
// 纪律与 trae-runtime.js / livecfg.js 完全同构（三条，缺一条就会出静默故障）：
//   1. 原子写（tmp + renameAtomic）+ 跨进程 filelock
//   2. mtime 失效重读——管理端 PUT 后，网关下一次判定就看到新值，不重启
//   3. 白名单清洗：磁盘宽容（未知键丢弃）/ 接口提交严格（未知键 400）
//
// **环境变量仍是默认值来源**：文件不存在或字段缺失时按 env 兜底，这样既有的
// 部署方式（只设 env 不碰面板）行为逐字节不变，也让测试能通过 env 钉参数。
//
// 字段（restriction）：
//   waveMin            窗口内几个**不同账号**被限制就整区域暂停（1~50，默认 2）
//   waveWindowSec      连坐判定窗口秒（0~86400，默认 900）
//   holdSeconds        整区域暂停秒（0~86400，**0 = 彻底关闭连坐暂停**，默认 1800）
//   restrictedRotateMax 一次请求最多再换几个号（0~20，默认 0 = 11140 不换号）
// 字段（restriction）：见下；字段（guard）：额度护栏（P1-6）
//   guard.enabled     是否按「套餐剩余低于阈值」把账号从候选里剔除（默认关）
//   guard.threshold   阈值（积分，默认 1；< 阈值即跳过该账号）
//   guard.creditFloor pool 层保留积分下限（0 = 关闭）
// 字段（thinking）：DeepSeek 思考注入开关（2026-11-28 P0-4，thinking.js）
//   thinking.enabled       默认开（对齐官方客户端：deepseek 系必带 thinking+effort）
//   thinking.defaultEffort 默认档覆盖（'' = 用模型目录 reasoning.defaultEffort，
//                          目录也没有时 thinking.js 兜底 'high'）
// 字段（systemTail）：system 后置救前缀缓存（2026-11-28 P1-1，默认关）
//   systemTail.enabled  开头连续 system 块挪到消息末尾、头部放恒定短桩——
//                       前缀缓存键变小且跨会话稳定（仅 cn 区域生效，chat.js）
const fs = require('fs');
const path = require('path');
const filelock = require('../filelock');

const FILE = 'workbuddy-runtime.json';
const FIELDS = ['restriction', 'guard', 'thinking', 'systemTail'];

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

/** env 读布尔：缺失/非法回默认；'0'/'false'/'off' 为假，其余非空串为真 */
function envBool(name, dflt) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return dflt;
  const s = String(raw).trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(s)) return false;
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  return dflt;
}

/** env 读档位词（白名单外一律回默认——档位词表是 thinking.js 的 EFFORT_RANK） */
function envEffort(name, dflt) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(raw)) return raw;
  return dflt;
}

function defaults() {
  return {
    restriction: {
      waveMin: envInt('DUMATE_WORKBUDDY_RESTRICTION_WAVE_MIN', 2, 1, 50),
      waveWindowSec: envInt('DUMATE_WORKBUDDY_RESTRICTION_WAVE_WINDOW', 900, 0, 86400),
      holdSeconds: envInt('DUMATE_WORKBUDDY_RESTRICTION_HOLD_SECONDS', 1800, 0, 86400),
      restrictedRotateMax: envInt('DUMATE_WORKBUDDY_RESTRICTED_ROTATE_MAX', 0, 0, 20),
    },
    // 额度护栏（P1-6）：**默认关**。打开后选号时跳过「剩余低于阈值」的账号，
    // 免得多打一次注定 402 的上游请求。数据源是 credits-snapshot（管理端
    // /credits 写的落盘快照），陈旧时自动退回普通选号——不拿旧余额拦请求。
    guard: {
      enabled: false,
      threshold: 1,
      // 保留积分下限（2026-11-08 融合批）：与上面的 threshold **不是一回事**。
      //   threshold  是「低于它就不选这个号」的选号过滤（软，快照陈旧即失效）
      //   creditFloor 是 pool 层的**保底线**：写进池的余额低于它时
      //                `floorBlockedFor()` 直接把这个号从候选里去掉，
      //                语义是「别把最后一笔额度用光，留给手动操作/应急」。
      // 两者叠加生效（都要低于各自阈值才拦）。0 = 关闭（pool 的默认）。
      // **为什么默认 0**：保底线是运维策略，不是通用最优——有人希望榨干、
      // 有人希望留余量。默认拦会让「明明还有额度却不用」变成难解释的行为。
      creditFloor: 0,
    },
    // DeepSeek 思考注入（P0-4）：**默认开**——官方客户端对 deepseek 系必带
    // thinking:{type:"enabled"} + effort，裸请求上游按不思考应答（misakano
    // issue #43 实测）。客户端显式 off/none/disabled 永远赢过这个开关；
    // 运维想全关就在这里（或 env DUMATE_WORKBUDDY_THINKING=0）。
    thinking: {
      enabled: envBool('DUMATE_WORKBUDDY_THINKING', true),
      defaultEffort: envEffort('DUMATE_WORKBUDDY_THINKING_EFFORT', ''),
    },
    // system 后置（P1-1）：**默认关**——它改变出站消息顺序，是激进优化；
    // 开关 + 真机缓存对照（A/B）确认有收益后才在面板打开
    systemTail: {
      enabled: envBool('DUMATE_WORKBUDDY_SYSTEM_TAIL', false),
    },
  };
}

const RANGES = {
  waveMin: [1, 50, 'waveMin 需为 1-50 的整数'],
  waveWindowSec: [0, 86400, 'waveWindowSec 需为 0-86400 的整数（秒）'],
  holdSeconds: [0, 86400, 'holdSeconds 需为 0-86400 的整数（秒，0 = 关闭）'],
  restrictedRotateMax: [0, 20, 'restrictedRotateMax 需为 0-20 的整数'],
};

/**
 * 白名单清洗。
 * strict=true（接口提交）：类型/范围不对直接抛错——不能把「以为设了阈值」
 * 悄悄吞成默认值。strict=false（磁盘读）：逐项回默认，坏文件不该挡住启动。
 */
const SUBFIELDS = {
  restriction: Object.keys(RANGES),
  guard: ['enabled', 'threshold', 'creditFloor'],
  thinking: ['enabled', 'defaultEffort'],
  systemTail: ['enabled'],
};

/** 子键白名单：提交未知子键要 400（否则「填错了」会静默无效） */
function assertSubKeys(key, v, strict) {
  if (!strict) return;
  const allowed = SUBFIELDS[key] || [];
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) {
      throw new Error(`未知配置键: ${key}.${k}（白名单: ${allowed.join(', ')}）`);
    }
  }
}

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
    if (key === 'restriction') {
      out.restriction = {};
      for (const [k, [min, max, msg]] of Object.entries(RANGES)) {
        if (v[k] === undefined) continue;
        const n = Number(v[k]);
        if (!Number.isInteger(n) || n < min || n > max) {
          if (strict) throw new Error(msg);
          continue;
        }
        out.restriction[k] = n;
      }
    }
    if (key === 'guard') {
      out.guard = {};
      if (v.enabled !== undefined) out.guard.enabled = v.enabled === true;
      if (v.threshold !== undefined) {
        const n = Number(v.threshold);
        // 阈值必须 > 0：0 的语义是「没有账号该被拦」，那等于关掉护栏——
        // 要关就明确设 enabled=false，不能让「填 0」静默变成关闭
        if (!Number.isFinite(n) || n <= 0) {
          if (strict) throw new Error('threshold 需为大于 0 的积分值');
          continue;
        }
        out.guard.threshold = n;
      }
      if (v.creditFloor !== undefined) {
        const n = Number(v.creditFloor);
        // creditFloor **允许 0**（= 关闭保底线），与 threshold 的「必须 > 0」不同：
        // 保底线本来就是一个可选策略，关掉它是最常见的取值。
        // 但负数无意义（负数意味着永远不拦，等价于关闭却让人以为开着）。
        if (!Number.isFinite(n) || n < 0) {
          if (strict) throw new Error('creditFloor 需为不小于 0 的积分值（0 = 关闭）');
          continue;
        }
        out.guard.creditFloor = n;
      }
    }
    if (key === 'thinking') {
      out.thinking = {};
      if (v.enabled !== undefined) out.thinking.enabled = v.enabled === true;
      if (v.defaultEffort !== undefined) {
        const s = String(v.defaultEffort).trim().toLowerCase();
        if (!['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(s)) {
          if (strict) throw new Error('defaultEffort 需为 minimal/low/medium/high/xhigh/max 之一或空串');
          continue;
        }
        out.thinking.defaultEffort = s;
      }
    }
    if (key === 'systemTail') {
      out.systemTail = {};
      if (v.enabled !== undefined) out.systemTail.enabled = v.enabled === true;
    }
  }
  return out;
}

function merge(base, patch) {
  const out = { ...base };
  for (const key of FIELDS) {
    const p = patch[key];
    if (p === undefined) continue;
    out[key] = { ...(base[key] || {}), ...p };
  }
  return out;
}

function mtimeOf() {
  try { return fs.statSync(filePath()).mtimeMs; } catch (e) { return 0; }
}

let cache = { mtime: -1, snap: defaults() };

/** 读当前配置（私有拷贝：调用方改了也不污染下一个读者） */
function Load() {
  const m = mtimeOf();
  if (m !== cache.mtime) {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(filePath(), 'utf8')); }
    catch (e) { raw = null; }
    cache = { mtime: m, snap: merge(defaults(), sanitize(raw)) };
  }
  return {
    restriction: { ...cache.snap.restriction },
    guard: { ...cache.snap.guard },
    thinking: { ...cache.snap.thinking },
    systemTail: { ...cache.snap.systemTail },
  };
}

/**
 * 提交一次变更（patch 语义）。
 * @returns {{config:object, changed:object}} changed = 本次真正改动的字段
 *   （管理端据此决定要不要发「截断倒计时」信号）
 */
function Store(patch) {
  return filelock.withLock(filePath(), () => {
    cache = { mtime: -1, snap: defaults() };
    const base = Load();
    const clean = sanitize(patch, { strict: true });
    const snap = merge(base, clean);
    const changed = {};
    for (const k of FIELDS) {
      if (clean[k] !== undefined) changed[k] = { ...clean[k] };
    }
    fs.mkdirSync(dataDir(), { recursive: true });
    const target = filePath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8');
    filelock.renameAtomic(tmp, target);
    cache = { mtime: mtimeOf(), snap };
    return { config: Load(), changed };
  });
}

function _resetForTest() { cache = { mtime: -1, snap: defaults() }; }

module.exports = {
  FILE, FIELDS, dataDir, filePath, defaults, sanitize, merge, Load, Store, _resetForTest,
};
