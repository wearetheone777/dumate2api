// src/workbuddy/credits-snapshot.js - 各账号套餐剩余额的落盘快照（护栏数据源）
//
// 为什么需要它：`/credits` 已经在拉每个账号的套餐剩余（`get-user-resource`），
// 但那份数据只在管理端的响应里活一瞬间。额度护栏（P1-6）要在**网关选号**时
// 知道「这个号还剩多少」，而网关不能为了挑一个账号去打上游（慢、且平白暴露
// 给风控）——所以管理端把结果落一份快照，网关读文件。
//
// 与 `expiring.js` 的分工：那个只记「窗口内会到期的账号」（FEFO 用），
// 这个记**全部账号的剩余额**（护栏用）。两者数据同源（`/credits`）、
// 写法同构（原子写 + mtime 失效重读 + TTL 判定），但**消费语义不同**，
// 混在一份快照里会让「删掉护栏」和「删掉 FEFO」互相牵连。
//
// 三条口径（都是反复用血换来的）：
//   1. **查不到 ≠ 0**：查询失败的账号不进快照（`keepIds` 保留旧条目更不能写 0）；
//   2. **陈旧退回普通行为**：快照超 TTL 时 `lowAccounts()` 返回 null，护栏
//      自动失效——绝不拿 6 小时前的余额把请求全拦死；
//   3. 写盘原子（tmp + rename），中途被杀不会留半个 JSON。
const fs = require('fs');
const path = require('path');

const FILE = 'workbuddy-credits-snapshot.json';

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
}

function filePath() {
  return process.env.DUMATE_WORKBUDDY_CREDITS_SNAPSHOT_FILE
    || path.join(dataDir(), FILE);
}

/** 快照 TTL：默认 6 小时（与 expiring 同窗口）。0 = 永不过期（测试用） */
function maxAgeMs() {
  const raw = process.env.DUMATE_WORKBUDDY_CREDITS_TTL_MS;
  if (raw == null || String(raw).trim() === '') return 6 * 3600 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 6 * 3600 * 1000;
}

let cache = { mtimeMs: -1, size: -1, data: null };

function loadSnap() {
  let st;
  try { st = fs.statSync(filePath()); } catch (e) { return null; }
  if (cache.data && st.mtimeMs === cache.mtimeMs && st.size === cache.size) return cache.data;
  let data;
  try { data = JSON.parse(fs.readFileSync(filePath(), 'utf8')); } catch (e) { return null; }
  if (!data || typeof data !== 'object' || !data.accounts || typeof data.accounts !== 'object') return null;
  cache = { mtimeMs: st.mtimeMs, size: st.size, data };
  return data;
}

/**
 * 全量或部分写入。
 * @param {Array<{id:number|string, remain:number|null, precise?:number|null}>} rows
 *   remain 为 null（查询失败）的账号**不写入**，并自动进 keepIds
 * @param {object} [opts] { now, keepIds, scope:'all'|'partial' }
 * @returns {boolean} 是否写盘
 */
function update(rows, opts = {}) {
  try {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const snap = loadSnap() || { at: 0, accounts: {} };
    const keep = new Set([...(opts.keepIds || [])].map(String));
    const accounts = {};
    if (opts.scope === 'partial') {
      // 部分刷新：未点名的账号原样保留（它们没被查，不是「剩余 0」）
      for (const [id, v] of Object.entries(snap.accounts || {})) accounts[id] = v;
    }
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || r.id == null) continue;
      const id = String(r.id);
      const remain = r.precise != null ? Number(r.precise) : (r.remain != null ? Number(r.remain) : null);
      if (remain == null || !Number.isFinite(remain) || remain < 0) {
        // 查不到 → 不写；旧条目该保留就保留（不是 0）
        if (snap.accounts && snap.accounts[id]) accounts[id] = snap.accounts[id];
        continue;
      }
      accounts[id] = { remain, at: now };
    }
    for (const id of keep) {
      if (!accounts[id] && snap.accounts && snap.accounts[id]) accounts[id] = snap.accounts[id];
    }
    const json = JSON.stringify({ at: opts.scope === 'partial' ? (snap.at || now) : now, accounts }, null, 2);
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = `${filePath()}.tmp`;
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, filePath());
    cache = { mtimeMs: Date.now(), size: Buffer.byteLength(json), data: JSON.parse(json) };
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 剩余额低于阈值的账号 id 集合（护栏用）。
 * @param {number} threshold 低于它就算「该歇了」
 * @param {number} [now]
 * @returns {Set<string>|null} null = 无快照 / 陈旧 / 没有账号低于阈值
 *   **null 的语义是「护栏不生效」**，调用方直接退回普通选号
 */
function lowAccounts(threshold, now = Date.now()) {
  const th = Number(threshold);
  if (!Number.isFinite(th)) return null;
  const snap = loadSnap();
  if (!snap) return null;
  const ttl = maxAgeMs();
  if (ttl > 0 && (!(snap.at > 0) || now - snap.at > ttl)) return null;
  const out = new Set();
  for (const [id, v] of Object.entries(snap.accounts || {})) {
    const remain = Number(v && v.remain);
    if (!Number.isFinite(remain)) continue;
    // 快照本身的原子条目过期也丢弃（逐条 at 用于「只有个别账号很久没刷」的场景）
    if (ttl > 0 && v && Number(v.at) > 0 && now - Number(v.at) > ttl) continue;
    if (remain < th) out.add(id);
  }
  return out.size ? out : null;
}

/** 快照新鲜度（管理端展示用） */
function info(now = Date.now()) {
  const snap = loadSnap();
  const ttl = maxAgeMs();
  if (!snap) return { at: null, fresh: false, accounts: 0, ttlMs: ttl };
  return {
    at: snap.at || null,
    fresh: !(ttl > 0) || (snap.at > 0 && now - snap.at <= ttl),
    accounts: Object.keys(snap.accounts || {}).length,
    ttlMs: ttl,
  };
}

module.exports = { FILE, filePath, maxAgeMs, update, lowAccounts, info, loadSnap };
