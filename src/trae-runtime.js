// src/trae-runtime.js - TRAE 通道运行期配置（热生效，跨进程按 mtime 重读）
//
// 调研 P0-3 / P0-5 / P2-13 / P2-16 / P2-20 共用一份配置：
//   degrade     额度耗尽 / 模型需升级时切备用模型或备用区域（默认关）
//   maxMode     remote 1M Max 的全局开关 + 模型白名单（默认关）
//   pickStrategy 选号策略（round-robin / credits-desc，默认轮转）
//   accountGuard 保留积分护栏（默认关；余额未知不猜 0）
//   gatewayPaused 全站 /v1 模型面暂停（默认关；管理台照常）
//
// 为什么单独一份文件而不塞进 livecfg：livecfg 是**全通道通用**的白名单
// 快照片段（hiddenModels / softCooldownMs），把 TRAE 专用策略混进去会让
// 「改 TRAE 开关」写进所有网关进程共享的通用配置，字段语义漂移。
//
// 与 keys.js / modelmap.js / livecfg.js 同一套纪律：原子写、mtime 失效重读、
// 白名单清洗（磁盘宽容 / 接口提交严格）、Load 返回私有拷贝。
const fs = require('fs');
const path = require('path');
const filelock = require('./filelock');

const FILE = 'traework-runtime.json';
const FIELDS = ['degrade', 'maxMode', 'pickStrategy', 'accountGuard', 'gatewayPaused'];

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
}

function filePath() {
  return path.join(dataDir(), FILE);
}

function defaults() {
  return {
    degrade: { enabled: false, fallbackModel: '', fallbackRegion: '', warnBelow: null, onQuota: true, onUpgrade: true },
    maxMode: { enabled: false, models: [] },
    pickStrategy: 'round-robin',
    accountGuard: { enabled: false, reserveCredits: null, reserveBelow: null, dailyTokens: null, dailyCredits: null, modelTokens: null },
    gatewayPaused: false,
  };
}

function list(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  for (const x of v) {
    const s = String(x == null ? '' : x).trim();
    if (s) seen.add(s);
  }
  return [...seen];
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function strictNumber(v, field) {
  // 非法数值直接拒绝：静默清成 null 会让「以为设了护栏」变成裸奔
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${field} 必须是非负数字`);
  return n;
}

function sanitizeObject(v, field) {
  if (v == null) return {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`${field} 必须是对象`);
  }
  return v;
}

/** 白名单清洗：strict=true 时非法输入抛错（接口提交），false 时逐项回默认（磁盘读） */
function sanitize(patch, { strict = false } = {}) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  const fail = (msg) => { if (strict) throw new Error(msg); };
  for (const key of Object.keys(patch)) {
    if (!FIELDS.includes(key)) {
      if (strict) throw new Error(`未知配置键: ${key}（白名单: ${FIELDS.join(', ')}）`);
      continue;
    }
    const v = patch[key];
    if (key === 'gatewayPaused') {
      out.gatewayPaused = v === true;
      continue;
    }
    if (key === 'pickStrategy') {
      const s = String(v || '').trim().toLowerCase();
      if (s !== 'round-robin' && s !== 'credits-desc') {
        fail('pickStrategy 只能是 round-robin / credits-desc');
        continue;
      }
      out.pickStrategy = s;
      continue;
    }
    let obj;
    try { obj = sanitizeObject(v, key); }
    catch (e) { if (strict) throw e; continue; }
    if (key === 'degrade') {
      out.degrade = {};
      if (obj.enabled !== undefined) out.degrade.enabled = obj.enabled === true;
      if (obj.fallbackModel !== undefined) out.degrade.fallbackModel = String(obj.fallbackModel || '').trim();
      if (obj.fallbackRegion !== undefined) {
        const r = String(obj.fallbackRegion || '').trim().toLowerCase();
        if (r && r !== 'cn' && r !== 'intl') {
          fail('fallbackRegion 只能是 cn / intl 或留空');
          continue;
        }
        out.degrade.fallbackRegion = r;
      }
      for (const [k, target] of [['warnBelow', 'warnBelow'], ['onQuota', 'onQuota'], ['onUpgrade', 'onUpgrade']]) {
        if (obj[k] === undefined) continue;
        if (k === 'warnBelow') {
          try { out.degrade.warnBelow = strictNumber(obj[k], 'warnBelow'); }
          catch (e) { if (strict) throw e; }
        } else out.degrade[target] = obj[k] === true;
      }
      continue;
    }
    if (key === 'maxMode') {
      out.maxMode = {};
      if (obj.enabled !== undefined) out.maxMode.enabled = obj.enabled === true;
      if (obj.models !== undefined) out.maxMode.models = list(obj.models);
      continue;
    }
    if (key === 'accountGuard') {
      out.accountGuard = {};
      if (obj.enabled !== undefined) out.accountGuard.enabled = obj.enabled === true;
      if (obj.reserveCredits !== undefined) {
        try { out.accountGuard.reserveCredits = strictNumber(obj.reserveCredits, 'reserveCredits'); }
        catch (e) { if (strict) throw e; }
      }
      if (obj.reserveBelow !== undefined) {
        try { out.accountGuard.reserveBelow = strictNumber(obj.reserveBelow, 'reserveBelow'); }
        catch (e) { if (strict) throw e; }
      }
      // 三项每日用量护栏（调研 P2-16）：余额快照管「有没有钱」，
      // 这三项管「今天是不是用过头了」。0/null 都是「不限」。
      for (const k of ['dailyTokens', 'dailyCredits', 'modelTokens']) {
        if (obj[k] === undefined) continue;
        try { out.accountGuard[k] = strictNumber(obj[k], k); }
        catch (e) { if (strict) throw e; }
      }
    }
  }
  return out;
}

/** 把 patch 合进完整快照（嵌套对象是深合并，不是整个覆盖） */
function merge(base, patch) {
  const out = { ...base };
  for (const key of FIELDS) {
    const p = patch[key];
    if (p === undefined) continue;
    if (p && typeof p === 'object' && !Array.isArray(p)) out[key] = { ...(base[key] || {}), ...p };
    else out[key] = p;
  }
  return out;
}

function mtimeOf() {
  try { return fs.statSync(filePath()).mtimeMs; } catch (e) { return 0; }
}

let cache = { mtime: -1, snap: defaults() };

function Load() {
  const m = mtimeOf();
  if (m !== cache.mtime) {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(filePath(), 'utf8')); }
    catch (e) { raw = null; }
    cache = { mtime: m, snap: merge(defaults(), sanitize(raw)) };
  }
  const s = cache.snap;
  // 返回私有拷贝：调用方对数组/对象的改动不污染下一个读者
  return {
    degrade: { ...s.degrade },
    maxMode: { ...s.maxMode, models: [...s.maxMode.models] },
    pickStrategy: s.pickStrategy,
    accountGuard: { ...s.accountGuard },
    gatewayPaused: s.gatewayPaused,
  };
}

function Store(patch) {
  return filelock.withLock(filePath(), () => {
    cache = { mtime: -1, snap: defaults() };
    const base = Load();
    const clean = sanitize(patch, { strict: true });
    const snap = merge(base, clean);
    fs.mkdirSync(dataDir(), { recursive: true });
    const target = filePath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8');
    filelock.renameAtomic(tmp, target);
    cache = { mtime: mtimeOf(), snap };
    return Load();
  });
}

function _resetForTest() { cache = { mtime: -1, snap: defaults() }; }

module.exports = { FILE, FIELDS, filePath, defaults, sanitize, merge, Load, Store, _resetForTest };
