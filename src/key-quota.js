// src/key-quota.js - 单 Key 每日配额（2026-11-07 清单项 9）
//
// 需求：keys.json 里每把 key 可配 daily_limit（每日请求数 / token 数），
// 超限后该 key 的请求一律 429，本地零点重置。
//
// 三个设计决策：
//   1. **独立内存计数器**，不查 requests.jsonl——那是 11MB+ 的账本，每次
//      请求读一遍不可接受。内存 Map 是权威，5 秒防抖落盘 data/key-quota.json；
//      重启丢当日末尾几秒的计数，对软限制可接受（账本仍在，可对账）。
//   2. **按本地日期分桶**：{"2026-11-07": {keyId: {requests, tokens}}}。
//      启动只恢复今天桶，昨日桶自动作废（跨零点同理）——与项目「冷却到
//      本地 0 点」口径一致。
//   3. **请求数在请求前计数，token 在响应后累加**（reqlog.record 挂钩）。
//      token 超限的判定落在「下一请求的检查」上——本请求不会中途被掐
//      （掐半截响应比超一点额度更伤客户端）。
//
// 关停：DUMATE_KEY_QUOTA=0 整体关闭（validate 恒通过，计数器不累加）。
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'key-quota.json');
const FLUSH_MS = 5000;

function enabled() {
  return process.env.DUMATE_KEY_QUOTA !== '0';
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地零点（重置时刻，429 响应里给客户端算退避用） */
function nextMidnight() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

// ── 内存态 ──
const state = { day: today(), buckets: {} }; // buckets[keyId] = { requests, tokens }
let dirty = false;
let flushTimer = null;

// 启动恢复：只认今天桶（读到旧日期的整份丢弃——跨天语义就是清零）
try {
  const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (j && j.day === state.day && j.buckets && typeof j.buckets === 'object') {
    state.buckets = j.buckets;
  }
} catch (e) { /* 首日无文件 */ }

function bucketOf(keyId) {
  if (state.day !== today()) {
    state.day = today();
    state.buckets = {};
    dirty = true;
  }
  const k = String(keyId);
  if (!state.buckets[k]) {
    state.buckets[k] = { requests: 0, tokens: 0 };
    dirty = true;
  }
  return state.buckets[k];
}

function scheduleFlush() {
  if (flushTimer || !dirty) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!dirty) return;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      fs.renameSync(tmp, FILE);
      dirty = false;
    } catch (e) { /* 落盘失败下轮再试，内存仍权威 */ }
  }, FLUSH_MS);
  if (flushTimer.unref) flushTimer.unref();
}

/**
 * 请求前调用：+1 请求数并判额。
 *
 * 家庭桶（2026-11-08 子 Key）：opts.familyId / opts.familyLimits 存在时，
 * 同一个请求也计入父 Key 的桶并判父的限制——子 Key 的消耗占用父 Key 的
 * 配额（「父这一份额度，无论被多少子 Key 瓜分」）。父子各自的上限都要满足。
 *
 * @param {number} keyId 请求所用 key 的 id
 * @param {{requests?:number,tokens?:number}} limits 自身限制（可为 {}）
 * @param {{familyId?:number,familyLimits?:{requests?:number,tokens?:number}}} [opts]
 * @returns {{ok:boolean, detail?:string, reset_at?:number}}
 */
function check(keyId, limits, opts = {}) {
  if (!enabled()) return { ok: true };
  const limit = limits || {};
  const famId = opts.familyId != null && String(opts.familyId) !== String(keyId)
    ? opts.familyId
    : null;
  const b = bucketOf(keyId);
  b.requests += 1;
  let fam = null;
  if (famId != null) {
    fam = bucketOf(famId);
    fam.requests += 1;
  }
  dirty = true;
  scheduleFlush();
  const reset_at = nextMidnight();
  if (limit.requests > 0 && b.requests > limit.requests) {
    return { ok: false, detail: `今日请求数 ${b.requests - 1}/${limit.requests} 已达上限`, reset_at };
  }
  if (limit.tokens > 0 && b.tokens >= limit.tokens) {
    return { ok: false, detail: `今日 token ${b.tokens}/${limit.tokens} 已达上限`, reset_at };
  }
  const flim = opts.familyLimits || {};
  if (fam && flim.requests > 0 && fam.requests > flim.requests) {
    return { ok: false, detail: `所属主 Key 今日请求数 ${fam.requests - 1}/${flim.requests} 已达上限`, reset_at };
  }
  if (fam && flim.tokens > 0 && fam.tokens >= flim.tokens) {
    return { ok: false, detail: `所属主 Key 今日 token ${fam.tokens}/${flim.tokens} 已达上限`, reset_at };
  }
  return { ok: true };
}

/**
 * 响应后调用：累加 token 计量（reqlog.record 挂钩喂入）。只计不判。
 * 子 Key 的 token 同时计入父 Key 的桶（与 check 的家庭桶同一口径）。
 */
function addTokens(keyId, tokens, opts = {}) {
  if (!enabled()) return;
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return;
  const v = Math.round(n);
  const b = bucketOf(keyId);
  b.tokens += v;
  const famId = opts.familyId != null && String(opts.familyId) !== String(keyId)
    ? opts.familyId
    : null;
  if (famId != null) bucketOf(famId).tokens += v;
  dirty = true;
  scheduleFlush();
}

/** 管理端展示：某 key 的当日用量（无记录 = 0/0） */
function todayOf(keyId) {
  if (state.day !== today()) return { requests: 0, tokens: 0 };
  const b = state.buckets[String(keyId)];
  return b ? { requests: b.requests, tokens: b.tokens } : { requests: 0, tokens: 0 };
}

/**
 * 管理端进程专用：从**落盘文件**读当日用量。计数器的内存权威在网关进程
 * （reqlog.record 挂钩发生在那边），管理端进程的内存 Map 永远是空的——
 * 两个进程共用 data/key-quota.json（网关 5 秒防抖落盘）才是跨进程正确读法。
 */
function readTodayFromDisk(keyId) {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!j || j.day !== today()) return { requests: 0, tokens: 0 };
    const b = j.buckets && j.buckets[String(keyId)];
    return b ? { requests: b.requests, tokens: b.tokens } : { requests: 0, tokens: 0 };
  } catch (e) {
    return { requests: 0, tokens: 0 };
  }
}

module.exports = { check, addTokens, todayOf, readTodayFromDisk, enabled, nextMidnight, FILE };
