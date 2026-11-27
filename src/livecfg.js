// src/livecfg.js - 运行期可变配置（热生效快照）
//
// 参照 codebuddyManager workbuddy2api/internal/livecfg（快照 + 原子指针），
// 按 Node 单进程形态落地：模块单例持一个快照对象，Store **整体替换**新对象，
// Load 返回**私有拷贝**。跨进程（网关 / 管理端共用 data/）靠
// mtime 失效重读同步——与 keys.js / modelmap.js 同一套纪律，任一进程 PUT
// 后其余进程下一次 Load 即可见，不用重启。
//
// **审计教训（必须保持的纪律）**：集合类字段（hiddenModels）绝不能把内部
// 数组原样交出去——调用方对返回值的一次 push/splice 会泄漏给所有后续读者。
// Go 侧靠值拷贝天然隔离，JS 必须在 Load 里显式复制。Store 同理：
// 永远构造新快照，不原地改旧快照，读到半新半旧视图的调用方才会不存在。
//
// 只承载**读路径深、热改需求强**的少数字段，白名单式（不开放任意键）：
//   - recordClientInfo 请求日志是否记录调用来源（ip / ua）。消费者：
//     src/reqlog.js 的 record（本包接线，F6e）。默认 true——保持既有日志
//     形状，关掉是显式动作。
//   - hiddenModels     要隐藏的模型名（精确匹配、大小写敏感、裸名）。
//     消费接线点：/v1/models 与 /v1beta/models 的输出侧（server.js 调
//     applyHiddenModels）。dumate 无 cn/global 双域，裸名即全量 id，不做
//     codebuddy 的前缀归一化（N10 不应对齐）。
//   - softCooldownMs   429 软冷却基数（<=0 或缺省 = 用调用方内置默认）。
//     消费者：池状态机生产单例（pool.js 的 hotSoftCooldown 门控热读，
//     测试池不读——保持单测对机器真实配置不敏感）。
//   - throttle         通道风控旋钮（P1-9）：`{通道: {inflightMax, minIntervalMs,
//     retryMax}}`。**解析优先级与语义只在 src/throttle.js 里实现一份**，本文件
//     只负责把这几个数存住。null 值 = 该旋钮回落到 env/默认；提交 `{通道:null}`
//     = 整条通道重置。消费方：channel-pool（并发/间隔）、repair（短故障重试）。
//   - throttleMaxMs   排队限流冷却上限（全局单值，ms）。0 = 回落 env/默认。
//   - imageBudget     内联图片上限与压缩（P1-6）：`{maxBytes, maxTotalBytes, maxEdge}`。
//     maxBytes/maxTotalBytes 单位字节，0 = 不限；maxEdge 是**长边像素**，0 = 不缩。
//     解析在 src/image-budget.js；这里只存。
//
// 落盘 data/livecfg.json（tmp+rename 原子写 + filelock 跨进程互斥，与
// qoder/auth.js 同一套写纪律）。文件里只会有白名单键——磁盘上多出的键
// 容忍并丢弃（向前兼容），接口提交多出的键直接 400（防手滑写错键名
// 静默无效）。
const fs = require('fs');
const path = require('path');
const filelock = require('./filelock');

const FILE = 'livecfg.json';

const FIELDS = ['recordClientInfo', 'hiddenModels', 'softCooldownMs', 'throttle', 'throttleMaxMs', 'imageBudget', 'reqlogRetention'];

/**
 * 通道风控旋钮的**存储形状**（只存，不解释语义——解释在 src/throttle.js）。
 * 与 `src/throttle.js` 的 CHANNELS/KNOBS 必须一致：两处不一致会让「界面能填、
 * 后端读不到」。单测 test/unit/throttle-config.test.js 锁这条。
 */
const THROTTLE_CHANNELS = ['qwenwork', 'traework', 'qoder', 'workbuddy'];
const THROTTLE_KNOBS = ['inflightMax', 'minIntervalMs', 'retryMax'];

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
}

function filePath() {
  return path.join(dataDir(), FILE);
}

function defaults() {
  return {
    recordClientInfo: true,
    hiddenModels: [],
    softCooldownMs: 0,
    // 空表 = 全部旋钮跟随 env/默认。只在面板真的设了某项时才写盘，
    // 读取侧（throttle.Load 的 materialize）补全成完整形状。
    throttle: {},
    throttleMaxMs: 0,
    imageBudget: { maxBytes: 0, maxTotalBytes: 0, maxEdge: 0 },
    // P2-3：请求日志保留策略。0 = 不按天清理（env DUMATE_REQLOG_RETENTION_DAYS 仍生效）；
    // maxLines 只裁剪归档 `.1`，在写主文件绝不碰。
    reqlogRetention: {
      days: parseInt(process.env.DUMATE_REQLOG_RETENTION_DAYS || '0', 10) || 0,
      maxLines: parseInt(process.env.DUMATE_REQLOG_MAX_LINES || '0', 10) || 0,
    },
  };
}

/** 把存储里的稀疏 throttle 补成全通道全旋钮形状（null = 未设） */
function materializeThrottle(table) {
  const src = (table && typeof table === 'object' && !Array.isArray(table)) ? table : {};
  const out = {};
  for (const ch of THROTTLE_CHANNELS) {
    const row = (src[ch] && typeof src[ch] === 'object' && !Array.isArray(src[ch])) ? src[ch] : {};
    const cell = {};
    for (const k of THROTTLE_KNOBS) {
      const v = row[k];
      cell[k] = (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : null;
    }
    out[ch] = cell;
  }
  return out;
}

/**
 * 白名单清洗。把任意输入收敛成合法快照片段：
 *   - 只认 FIELDS 里的键（strict=true 时多出的键抛错，false 时丢弃）
 *   - recordClientInfo：undefined/null → 缺省（不写）；其余按布尔
 *   - hiddenModels：字符串数组 → 逐项去空白 → 滤空 → 去重；非法输入 → []
 *   - softCooldownMs：非负有限数 → 取整；其余 → 0（=回退内置默认）
 * 返回的键集只含**输入里出现过的**白名单键（配合 Store 做 patch 合并）。
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
    if (key === 'recordClientInfo') {
      if (v == null) continue; // 未提供 = 不改这一项
      out.recordClientInfo = v === true;
    } else if (key === 'hiddenModels') {
      if (v == null) continue;
      if (!Array.isArray(v)) {
        if (strict) throw new Error('hiddenModels 必须是字符串数组');
        continue;
      }
      const seen = new Set();
      for (const item of v) {
        const s = String(item == null ? '' : item).trim();
        if (s) seen.add(s);
      }
      out.hiddenModels = [...seen];
    } else if (key === 'softCooldownMs') {
      if (v == null) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        if (strict) throw new Error('softCooldownMs 必须是非负数字（毫秒）');
        continue;
      }
      out.softCooldownMs = Math.round(n);
    } else if (key === 'throttleMaxMs') {
      if (v == null) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        if (strict) throw new Error('throttleMaxMs 必须是非负数字（毫秒，0 = 跟随环境变量/默认）');
        continue;
      }
      out.throttleMaxMs = Math.round(n);
    } else if (key === 'throttle') {
      if (v == null) continue;
      if (typeof v !== 'object' || Array.isArray(v)) {
        if (strict) throw new Error('throttle 必须是 `{通道: {旋钮: 数值}}` 对象');
        continue;
      }
      const table = {};
      for (const [rawCh, rawRow] of Object.entries(v)) {
        const ch = String(rawCh || '').trim().toLowerCase();
        if (!THROTTLE_CHANNELS.includes(ch)) {
          if (strict) throw new Error(`未知通道: ${rawCh}（可用: ${THROTTLE_CHANNELS.join(', ')}）`);
          continue;
        }
        // null = 整条通道重置（回到 env/默认）。**必须能表达**，否则面板一旦
        // 覆盖过就再也回不去（0 是「显式关断」，不是「未设」）。
        if (rawRow === null) { table[ch] = null; continue; }
        if (typeof rawRow !== 'object' || Array.isArray(rawRow)) {
          if (strict) throw new Error(`throttle.${ch} 必须是对象或 null`);
          continue;
        }
        const cell = {};
        for (const [rawK, rawV] of Object.entries(rawRow)) {
          const k = String(rawK || '').trim();
          if (!THROTTLE_KNOBS.includes(k)) {
            if (strict) throw new Error(`未知旋钮: ${rawK}（可用: ${THROTTLE_KNOBS.join(', ')}）`);
            continue;
          }
          if (rawV === null) { cell[k] = null; continue; }
          const n = Number(rawV);
          if (!Number.isFinite(n) || n < 0) {
            if (strict) throw new Error(`throttle.${ch}.${k} 必须是非负数字或 null`);
            continue;
          }
          cell[k] = Math.round(n);
        }
        table[ch] = cell;
      }
      out.throttle = table;
    } else if (key === 'reqlogRetention') {
      if (v == null) continue;
      if (typeof v !== 'object' || Array.isArray(v)) {
        if (strict) throw new Error('reqlogRetention 必须是 `{days, maxLines}` 对象');
        continue;
      }
      const cell = {};
      for (const k of ['days', 'maxLines']) {
        if (v[k] === undefined || v[k] === null) continue;
        const n = Number(v[k]);
        if (!Number.isFinite(n) || n < 0) {
          if (strict) throw new Error(`reqlogRetention.${k} 必须是非负数字（0 = 不限）`);
          continue;
        }
        cell[k] = Math.round(n);
      }
      out.reqlogRetention = cell;
    } else if (key === 'imageBudget') {
      if (v == null) continue;
      if (typeof v !== 'object' || Array.isArray(v)) {
        if (strict) throw new Error('imageBudget 必须是 `{maxBytes, maxTotalBytes}` 对象');
        continue;
      }
      const cell = {};
      for (const k of ['maxBytes', 'maxTotalBytes', 'maxEdge']) {
        if (v[k] === undefined || v[k] === null) continue;
        const n = Number(v[k]);
        if (!Number.isFinite(n) || n < 0) {
          const unit = k === 'maxEdge' ? '长边像素，0 = 不缩' : '字节，0 = 不限';
          if (strict) throw new Error(`imageBudget.${k} 必须是非负数字（${unit}）`);
          continue;
        }
        cell[k] = Math.round(n);
      }
      out.imageBudget = cell;
    }
  }
  return out;
}

function mtimeOf() {
  try { return fs.statSync(filePath()).mtimeMs; } catch (e) { return 0; }
}

function readDisk() {
  try { return JSON.parse(fs.readFileSync(filePath(), 'utf8')); }
  catch (e) { return null; } // 不存在 / 坏文件都按默认，下次 Store 会整体重写
}

// 进程内缓存：{ mtime, snap }。mtime 对不上就重读——这就是跨进程热生效。
let cache = { mtime: -1, snap: defaults() };

function current() {
  const m = mtimeOf();
  if (m !== cache.mtime) {
    const patch = sanitize(readDisk()); // 磁盘宽容：未知键丢弃
    cache = { mtime: m, snap: { ...defaults(), ...patch } };
  }
  return cache.snap;
}

/**
 * 读当前配置。**返回私有拷贝**：顶层浅拷 + hiddenModels 数组复制 +
 * throttle 逐通道复制，调用方随意改动都不影响下一个读者（审计教训，见文件头）。
 *
 * `throttle` 在这里**补成全通道全旋钮形状**（未设 = null）：磁盘上只该有
 * 真被设过的项，而界面与 /system/throttle 需要一个稳定的表结构——让每个
 * 读者自己补齐等于把同一段补全逻辑写四份。
 */
function Load() {
  const snap = current();
  return {
    ...snap,
    hiddenModels: [...snap.hiddenModels],
    throttle: materializeThrottle(snap.throttle),
    imageBudget: { ...(snap.imageBudget || {}) },
    reqlogRetention: { ...(snap.reqlogRetention || {}) },
  };
}

/**
 * 把 patch 合进基线快照。**只有 throttle 需要逐层合并**：
 * 普通字段是整体替换（patch 语义），而 throttle 是两级表（通道 → 旋钮）——
 * 整体替换会让「只改 qoder 的间隔」把 traework 的配置整条抹掉，或让「清掉
 * 一项重试次数」连带清掉同一通道的并发帽。所以：
 *
 *   {通道: null}            → 整条通道重置（回到 env/默认）
 *   {通道: {旋钮: 数值}}    → 只改这几项，兄弟项保留
 *   {通道: {旋钮: null}}    → 只清这一项
 *   {通道: {}}              → 无变化（不是重置；重置要显式 null）
 */
function mergeInto(base, patch) {
  const out = { ...base, ...patch };
  if (patch.imageBudget) {
    // 两个键是同一件事的两面，逐键合并才符合 patch 语义
    out.imageBudget = { ...(base.imageBudget || {}), ...patch.imageBudget };
  }
  if (patch.reqlogRetention) out.reqlogRetention = { ...(base.reqlogRetention || {}), ...patch.reqlogRetention };
  if (patch.throttle) {
    const table = { ...(base.throttle || {}) };
    for (const [ch, row] of Object.entries(patch.throttle)) {
      if (row === null) { delete table[ch]; continue; }
      const cell = { ...(table[ch] || {}) };
      for (const [k, v] of Object.entries(row)) {
        if (v === null || v === undefined) delete cell[k];
        else cell[k] = v;
      }
      if (Object.keys(cell).length) table[ch] = cell;
      else delete table[ch];
    }
    out.throttle = table;
  }
  return out;
}

/**
 * 提交一次变更（patch 语义：只传要改的键）。
 * 锁内 读当前 → 合并 → 白名单校验（strict，未知键抛错）→ 原子落盘 →
 * 换入新快照。**整体替换**，不原地改旧快照。
 * @returns {object} 提交后的完整配置（Load 形状，私有拷贝）
 */
function Store(patch) {
  return filelock.withLock(filePath(), () => {
    // 锁内先失效缓存再读：其他进程可能刚写过同一个文件
    cache = { mtime: -1, snap: defaults() };
    const base = current();
    const clean = sanitize(patch, { strict: true });
    const snap = mergeInto(base, clean);
    fs.mkdirSync(dataDir(), { recursive: true });
    const target = filePath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8');
    filelock.renameAtomic(tmp, target);
    cache = { mtime: mtimeOf(), snap };
    return Load();
  });
}

/**
 * 模型列表输出侧的隐藏过滤（hiddenModels 的消费接线点：/v1/models 与
 * /v1beta/models）。rows 是 {id}（OpenAI 形态）/ {name:'models/<id>'}（Google
 * 形态）/ 裸字符串，统一剥前缀取裸名后与 hiddenModels 精确比对（大小写敏感）。
 * 返回新数组不改入参；配置读不到时原样返回——隐藏是可选能力，故障不放大。
 */
function applyHiddenModels(rows) {
  let hidden;
  try { hidden = Load().hiddenModels; } catch (e) { return rows; }
  if (!Array.isArray(rows) || !hidden.length) return rows;
  const bare = (id) => (id.startsWith('models/') ? id.slice('models/'.length) : id);
  return rows.filter((r) => {
    const id = typeof r === 'string' ? r : String((r && (r.id != null ? r.id : r.name)) || '');
    return !hidden.includes(bare(id));
  });
}

/** 仅供测试：把进程内缓存打回「未读过」状态 */
function _resetForTest() {
  cache = { mtime: -1, snap: defaults() };
}

module.exports = {
  FILE, FIELDS, THROTTLE_CHANNELS, THROTTLE_KNOBS,
  filePath, defaults, sanitize, mergeInto, materializeThrottle, Load, Store,
  applyHiddenModels, _resetForTest,
};
