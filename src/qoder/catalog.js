// src/qoder/catalog.js - 模型目录来源与兜底状态（P0-2）
//
// 回答两个问题：
//   1. 这次模型表是**从哪来的**（upstream / disk-cache / client-cache / snapshot）
//   2. 兜底清单里哪些是**疑似下线**的条目（retiredCandidate）
//
// 纪律（方案 P0-2 原话，逐条遵守）：
//   - **不删条目**：第三方清单不是本项目的真机证据。标 `retiredCandidate`
//     只是「默认不列出 + 灰显提示」，显式调用仍然透传给上游自己判。
//   - **倍率只读上游 `price_factor`**，快照里不写任何第三方数值/显示名。
//   - 四级降级：动态接口 → 7 天磁盘缓存 → 本机客户端目录缓存 → 仓库快照。
//     任一级成功就带 `catalogSource`，**不静默回落**——界面要能看出现在是
//     第几级，否则「模型少了」会被当成网关故障排查。
//
// 本机客户端目录缓存：Qoder 客户端在 `%APPDATA%/Qoder`（Windows）/
// `~/.config/Qoder`（Linux）下会落 model list。**没有真机证据前不硬编路径**，
// 只按已知候选探测；探不到就跳过，不报错。
const fs = require('fs');
const os = require('os');
const path = require('path');

const SNAPSHOT_FILE = path.join(__dirname, 'qoder-catalog.snapshot.json');
const DISK_CACHE_TTL_MS = 7 * 86400000;

let snapshot = null;

function loadSnapshot() {
  if (snapshot) return snapshot;
  try {
    const j = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    const rows = Array.isArray(j.models) ? j.models : [];
    snapshot = rows
      .filter((m) => m && typeof m.key === 'string' && m.key.trim())
      .map((m) => ({
        key: m.key.trim(),
        retiredCandidate: m.retiredCandidate === true,
        reason: m.reason || '',
      }));
  } catch (e) {
    // 快照坏了不能让模型功能整体不可用：退回「全部非候选」的最小表
    snapshot = [];
  }
  return snapshot;
}

/** 兜底清单（key 数组，保持原顺序；retiredCandidate 也包含——调用方可自行过滤） */
function fallbackKeys({ includeRetired = true } = {}) {
  const rows = loadSnapshot();
  if (!rows.length) return [];
  return rows.filter((r) => includeRetired || !r.retiredCandidate).map((r) => r.key);
}

/** 兜底行的状态：active / retired_candidate */
function statusOf(key) {
  const row = loadSnapshot().find((r) => r.key === key);
  if (!row) return { status: 'unknown', retiredCandidate: false, reason: '' };
  return {
    status: row.retiredCandidate ? 'retired_candidate' : 'active',
    retiredCandidate: row.retiredCandidate,
    reason: row.reason,
  };
}

/** 便宜档：从兜底表里挑「非候选」的常用 0.1 档，候选不再自动推荐 */
function cheapKeys() {
  const rows = loadSnapshot();
  // mmodel（MiniMax-M3.1-Flash，0.1）是 2026-11-28 真机发现的新 0.1 档，补进候选。
  // qmodel / q37fmodel 保留在列表里但已被快照标候选，会自动被下面过滤掉。
  const CHEAP = ['qfmodel', 'qmodel', 'q37fmodel', 'dfmodel', 'gfmodel', 'mmodel'];
  return CHEAP.filter((k) => rows.some((r) => r.key === k && !r.retiredCandidate));
}

/**
 * 本机客户端模型目录缓存探测。**只在存在明确文件时读**；读不到返回 null。
 * 路径按 Qoder 客户端常见布局探测，找不到就是没装/没登录，不报错。
 */
function clientCacheCandidates() {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const out = [];
  for (const base of [path.join(appdata, 'Qoder'), path.join(home, '.config', 'Qoder'), path.join(home, '.qoder')]) {
    out.push(path.join(base, 'models.json'));
    out.push(path.join(base, 'cache', 'models.json'));
  }
  return out;
}

/**
 * 读本机客户端目录缓存。返回 `[{key, name, rate, contextWindow, ...}]` 或 null。
 * **不猜文件格式**：只接受 `{chat:[...]}` 或 `[...]` 两种，且每项必须有 key。
 */
function readClientCache() {
  for (const f of clientCacheCandidates()) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const list = Array.isArray(j) ? j : (Array.isArray(j.chat) ? j.chat : null);
      if (!list || !list.length) continue;
      const rows = list.filter((m) => m && typeof m.key === 'string' && m.key.trim())
        .map((m) => ({
          key: m.key.trim(),
          name: m.display_name || m.name || m.key,
          rate: typeof m.price_factor === 'number' ? m.price_factor : null,
          contextWindow: m.max_input_tokens || null,
        }));
      if (rows.length) return rows;
    } catch (e) { /* 文件不存在/格式不对，继续下一个候选 */ }
  }
  return null;
}

function diskCachePath() {
  const dir = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
  return path.join(dir, 'qoder-model-catalog.json');
}

/** 写盘（原子）；失败吞掉——缓存写不进去不影响本次返回 */
function writeDiskCache(models, source = 'upstream') {
  if (!Array.isArray(models) || !models.length) return;
  try {
    const filelock = require('../filelock');
    const p = diskCachePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      at: Date.now(), source, models,
    }), 'utf8');
    filelock.renameAtomic(tmp, p);
  } catch (e) { /* 忽略 */ }
}

/** 读盘；超过 7 天视为过期（过期仍返回，但标 stale，由调用方决定用不用） */
function readDiskCache(now = Date.now()) {
  try {
    const j = JSON.parse(fs.readFileSync(diskCachePath(), 'utf8'));
    if (!j || !Array.isArray(j.models) || !j.models.length) return null;
    return {
      at: Number(j.at) || 0,
      source: j.source || 'disk-cache',
      models: j.models,
      stale: !(now - (Number(j.at) || 0) <= DISK_CACHE_TTL_MS),
    };
  } catch (e) { return null; }
}

/**
 * 四级降级的统一入口。`fetchUpstream` 是**注入**的上游拉取函数
 * （返回 `{ok, models}` 或抛错），便于离线测试与「管理端 / 网关」不同进程复用。
 *
 * 返回 `{ok, models, catalogSource, error, stale}`：
 *   catalogSource ∈ upstream / disk-cache / client-cache / snapshot
 *   error 只在**四级都失败**时非空（snapshot 永远可用，除非快照文件坏了）。
 */
async function resolveCatalog({ fetchUpstream = null, now = Date.now(), allowSnapshot = true } = {}) {
  let upstreamError = '';
  if (typeof fetchUpstream === 'function') {
    try {
      const r = await fetchUpstream();
      if (r && r.ok && Array.isArray(r.models) && r.models.length) {
        writeDiskCache(r.models, 'upstream');
        return { ok: true, models: r.models, catalogSource: 'upstream', error: '', stale: false };
      }
      upstreamError = (r && r.error) || 'upstream 返回空模型表';
    } catch (e) { upstreamError = e.message; }
  }
  const disk = readDiskCache(now);
  if (disk) {
    return { ok: true, models: disk.models, catalogSource: 'disk-cache', error: upstreamError, stale: disk.stale };
  }
  const client = readClientCache();
  if (client) {
    return { ok: true, models: client, catalogSource: 'client-cache', error: upstreamError, stale: false };
  }
  if (!allowSnapshot) {
    return { ok: false, models: [], catalogSource: 'none', error: upstreamError || '没有可用模型表', stale: false };
  }
  const keys = fallbackKeys();
  return {
    ok: keys.length > 0,
    models: keys.map((k) => {
      const st = statusOf(k);
      return {
        key: k, name: k, rate: null, rateOriginal: null,
        contextWindow: null, status: st.status, retiredCandidate: st.retiredCandidate, reason: st.reason,
      };
    }),
    catalogSource: 'snapshot',
    error: upstreamError || '上游模型表不可用，使用仓库快照（可能含已下线条目）',
    stale: true,
  };
}

/** 仅供测试：清空快照缓存 */
function _resetForTest() {
  snapshot = null;
}

module.exports = {
  SNAPSHOT_FILE, DISK_CACHE_TTL_MS,
  loadSnapshot, fallbackKeys, statusOf, cheapKeys,
  clientCacheCandidates, readClientCache,
  diskCachePath, readDiskCache, writeDiskCache,
  resolveCatalog, _resetForTest,
};
