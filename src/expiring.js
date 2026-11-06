// src/expiring.js - 临期积分快照（搭子 / TRAE / 千问三家通道的 FEFO 选号数据源）
//
// **为什么需要落盘快照而不是网关现查上游**：Qoder 有一份本地账本
// （data/qoder-grants.jsonl）能直接推出临期账号；另外三家要打上游才能拿到
// 「哪个账号、哪天到期」，而网关选号在请求热路径上——为挑一个账号去多打
// 一次上游，慢且平白暴露给风控。管理端的 /credits 本就在拉这些数据
// （仪表盘每进一次都会拉），所以写方挂管理端、读方挂网关，进程间靠
// data/ 目录文件通信（CLAUDE.md 约定），不搞 IPC。
//
// **陈旧的正确姿势不是报错而是退回普通轮询**：快照是选号的*加分项*，
// 没有它，三家网关的行为退回到加这个功能之前的样子——可用、只是不优先
// 消耗临期积分。所以快照缺失 / 超 TTL / 窗口外，accountIds 一律返回空集合，
// 上层把 null 传给池，行数不会比旧代码多。
//
// **写盘节奏**：at 是快照的「心跳」（管理端每次刷新推进一次），所以 update
// 每次都写——TTL 的语义就是「管理端最近一次刷新时刻」，去重判 at 恒不等、
// 是死代码（与«上游探测缓存»当年同款教训：加上了从不生效）。读写都走
// tmp+rename 原子替换（与 store.js 同纪律），中途被杀也不会留下半个 JSON。
const fs = require('fs');
const path = require('path');

// 各通道的临期窗口（天）。来源不同、口径不同，别互相套：
//  - dumate：签到积分包天然落在 25~30 天区间，窗口必须 ≥30 天才不会恒空
//    （points-agg 的 expiring 聚合也是 30 天）
//  - traework：额度包到期即消失，上游包 7 天内陆续到期；管理端 /credits
//    也按 7 天（SOON_MS）过滤，两边同窗
//  - qwenwork：上游 expiring_soon 本身就是信号（管理端照单全收），窗口只
//    是兜底，给 30 天与另外两家对齐
//  - workbuddy：到期来自套餐 CycleEndTime（北京时间字符串，2026-11-04 真机
//    实证）；裂变包以月周期为主但也有短包，窗口给 7 天与 traework 同口径
const DEFAULT_WINDOW_DAYS = { dumate: 30, traework: 7, qwenwork: 30, workbuddy: 7 };

// 通道的临期窗口（天）。env 每次读——Qoder read-idle 当年在模块加载时读死
// env 值的教训（改配置必须重启才生效），这里不重犯。
// 返回 0 表示该通道关闭 FEFO。
function windowDays(channel) {
  const env = process.env[`DUMATE_${String(channel).toUpperCase()}_FEFO_DAYS`];
  if (env != null) {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_WINDOW_DAYS[channel] != null ? DEFAULT_WINDOW_DAYS[channel] : 0;
}

// 快照新鲜度 TTL：写入超过这么久，accountIds 返回空（过期数据比没有数据
// 更害人——它会驱动流量打向早已扣完临期积分的账号，还自以为在省积分）。
// 写方是管理端 /credits，用户每天看仪表盘就会刷新；默认 6 小时覆盖
// 「早上看过、晚上还在跑」的常规节奏。
function maxAgeMs() {
  const env = Number(process.env.DUMATE_EXPIRING_SNAPSHOT_TTL_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return 6 * 3600 * 1000;
}

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
}

function filePath() {
  return process.env.DUMATE_EXPIRING_SNAPSHOT_FILE
    || path.join(dataDir(), 'expiring-snapshot.json');
}

// 形态：{ channels: { [channel]: { at, accounts: { [accountId(字符串)]: nearestMs } } } }
// accountId 一律字符串（JSON 对象键只能是字符串）；nearest 是该账号最早
// 到期时刻（毫秒）。只记「窗口内会被秒」的账号——没临期的根本不进门。
let cache = { mtimeMs: -1, size: -1, data: null };

function loadSnap() {
  let st;
  try { st = fs.statSync(filePath()); } catch (e) { return null; }
  if (cache.data && st.mtimeMs === cache.mtimeMs && st.size === cache.size) return cache.data;
  let data;
  try { data = JSON.parse(fs.readFileSync(filePath(), 'utf8')); } catch (e) { return null; }
  if (!data || typeof data !== 'object') return null;
  if (!data.channels || typeof data.channels !== 'object') return null;
  cache = { mtimeMs: st.mtimeMs, size: st.size, data };
  return data;
}

/**
 * 全量重写一条通道的临期条目（管理端写方）。
 * @param {string} channel 通道 id（dumate / traework / qwenwork）
 * @param {Array<{accountId: number|string, nearest: number}>} entries
 *   nearest = 该账号最早到期时刻（ms）。只喂临期账号；调用方已经算好
 *   「有临期」，这里不再按窗口过滤（两边口径独立，读方还要卡一次）。
 * @param {object} opts
 *   - now {number} 可注入时刻（测试用）
 *   - keepIds {Iterable<number|string>} 本次**查询失败**的账号：保留它们的
 *     旧条目。没列进 entries 也没列进 keepIds 的账号视为「已确认无临期」，
 *     条目被清除。有 keepIds 时 at 不推进——「部分数据是旧的」不能让快照
 *     看起来同样新鲜（宁可让读方按 TTL 保守退回普通轮询）。
 * @returns {boolean} 是否写盘
 */
function update(channel, entries, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (!channel || !Array.isArray(entries)) return false;
  try {
    const snap = loadSnap() || { channels: {} };
    if (!snap.channels[channel] || typeof snap.channels[channel] !== 'object') {
      snap.channels[channel] = { at: 0, accounts: {} };
    }
    const ch = snap.channels[channel];
    const keep = [...(opts.keepIds || [])].map(String); // Set / 数组都可
    const acc = {};
    // 旧条目里被 keep 的账号原样保留（查询失败不是「没有临期」的证据）
    if (keep.length) {
      for (const [id, n] of Object.entries(ch.accounts || {})) {
        if (keep.includes(id)) acc[id] = n;
      }
    }
    for (const e of entries) {
      if (!e || e.accountId == null) continue;
      const n = Number(e.nearest);
      if (!Number.isFinite(n) || !(n > 0)) continue; // 无到期时刻的不进门，不编 0
      acc[String(e.accountId)] = n;
    }
    if (!keep.length || !ch.at) ch.at = now;
    ch.accounts = acc;
    const json = JSON.stringify(snap, null, 2);
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = filePath() + '.tmp';
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, filePath());
    // 写方进程自己也更新缓存（statSync 再核对一次太贵，直接按 known-good 记账）
    cache = { mtimeMs: Date.now(), size: Buffer.byteLength(json), data: snap };
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 网关读方：某通道当前应优先消耗的账号集合（FEFO）。
 * @returns {Set<string>|null} 字符串账号 id 集合；FEFO 关闭 / 无快照 /
 *   快照陈旧 / 窗口内无临期账号 → null（上层不传 expiring，走普通轮询）
 */
function accountIds(channel, now = Date.now()) {
  const days = windowDays(channel);
  if (!days) return null;
  const snap = loadSnap();
  if (!snap) return null;
  const ch = snap.channels && snap.channels[channel];
  if (!ch) return null;
  if (typeof ch.at !== 'number' || now - ch.at > maxAgeMs()) return null;
  const acc = ch.accounts;
  if (!acc || typeof acc !== 'object') return null;
  const horizon = now + days * 86400000;
  const out = new Set();
  for (const [id, nearest] of Object.entries(acc)) {
    // 只有"还没到期、且在窗口内"的才算临期——已过期的批次上游已废止，
    // 优先消耗它没有意义（额度包按剩余量扣，不是空壳）
    if (nearest > now && nearest <= horizon) out.add(id);
  }
  return out.size ? out : null;
}

/**
 * 快照新鲜度（管理端 /credits 透出用）：让「FEFO 没生效」可以被排障发现，
 * 而不是静默退回普通轮询。
 */
function info(channel, now = Date.now()) {
  const snap = loadSnap();
  const ch = snap && snap.channels && snap.channels[channel];
  if (!ch) return { at: null, fresh: false, accounts: 0, windowDays: windowDays(channel) };
  const accounts = ch.accounts ? Object.keys(ch.accounts).length : 0;
  return {
    at: ch.at || null,
    fresh: typeof ch.at === 'number' && now - ch.at <= maxAgeMs(),
    accounts,
    windowDays: windowDays(channel),
  };
}

module.exports = { update, accountIds, info, filePath, windowDays, maxAgeMs };
