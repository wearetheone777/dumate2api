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

// ---- 活动模型补充（issue #9；hub v1.10.1 同款设计）----
//
// 官方限时活动模型**不在动态模型清单里**（只进官方应用/IDE 的选择器），但上游
// 可直接按 key 调用——hub 对 QoDuck（`lmodel`，仅 `app` 数组）验证过同款链路
// （hub v1.9.2「discover QoDuck app-only model」）。
//
// HungerG 的 key 依据（2026-11-29 自有证据，比 hub 静态表的 "HungerG" 更硬）：
// 官方 0.5.21 应用（2026-11-27 构建）内置文案表
// `out/qoder-text/global-prod/bundle.json` 的
// `modelPresentations.models.hmodel.label = "HungerG"`；同表 `lmodel = QoDuck`
// 与 hub 真机验证过的 API key 一致——presentation 键就是 API key。
// hub 把显示名 "HungerG" 当 key（它自己的活动日志只见过 10605 排队，无成功
// 调用记录）。两个拼写都注册成别名，出站统一用 `hmodel`，上游裁决。
//
// 免费窗口：2026-11-23 24:00 ~ 11-30 24:00（UTC+8，官方活动页
// docs.qoder.com/zh/events/hungerg-free）。窗口内不消耗 Credits（Max 思考档也按
// 0.0× 计费）；截止后按届时公示倍率收费——条目到点自动从列表隐藏，显式调用仍
// 透传给上游裁决（与 retiredCandidate 同一纪律：不删条目，只是不自动列出）。

const HUNGERG_FREE_UNTIL_MS = 1796054400000; // 2026-11-30 24:00 (UTC+8)；hub v1.10.1 同值

const SUPPLEMENTS = [
  {
    key: 'hmodel',
    name: 'HungerG',
    aliases: ['HungerG', 'hungerg', 'hungerg-free', 'hungerg_free'],
    region: 'intl', // 国际版个人账号活动模型（Team/Enterprise 不显示）
    row: {
      key: 'hmodel',
      name: 'HungerG',
      prefixed: 'qoder/hmodel',
      status: 'active',
      disabledReason: '',
      enabled: true,
      aliasOf: 'HungerG',
      // 活动期 0 倍率（官方活动页）；结束后倍率未公布——null 不编
      rate: 0,
      rateOriginal: null,
      // hub 真机观测静态表：max_input_tokens 180000（默认档 200K 扣 20K 预留），
      // context_config 三档 200K/400K/1M；上下文 1M 与官方活动页一致
      contextWindow: 180000,
      contextTiers: [200000, 400000, 1000000],
      maxInputTokens: 1000000,
      isDefault: false,
      isFree: true,
      isNew: true,
      isReasoning: true,
      multimodal: true,
      // hub 真机观测：thinking enabled efforts low/medium/high/max，
      // is_default 挂在 enabled 层（无 per-effort 默认档）——不猜默认档
      reasoningEfforts: ['low', 'medium', 'high', 'max'],
      reasoningDefault: '',
      reasoningCanDisable: true,
      promotion: null,
      cheap: true,
      supplement: true,
      freeUntil: HUNGERG_FREE_UNTIL_MS,
    },
  },
];

/** 补充条目的归一化行（默认不含已过期的）；形状与 session.fetchModels 一致 */
function supplementRows({ includeExpired = false, now = Date.now() } = {}) {
  return SUPPLEMENTS
    .filter((s) => includeExpired || now < HUNGERG_FREE_UNTIL_MS)
    .map((s) => ({ ...s.row }));
}

/** key 或别名 → 补充行（过期也返回——显式调用透传给上游裁决） */
function supplementMetaOf(keyOrAlias) {
  const bare = String(keyOrAlias || '').trim();
  if (!bare) return null;
  const hit = SUPPLEMENTS.find((s) => s.key === bare || s.aliases.includes(bare));
  return hit ? { ...hit.row } : null;
}

/** 调用方的裸模型名 → 补充条目的区域提示（'' = 无提示，按普通选号走） */
function supplementRegionOf(bareName) {
  const bare = String(bareName || '').trim();
  if (!bare) return '';
  const hit = SUPPLEMENTS.find((s) => s.key === bare || s.aliases.includes(bare));
  return hit ? hit.region : '';
}

/**
 * 把补充条目并进 /v1/models 条目列表。上游动态表已列出的 key 不覆盖（动态表
 * 优先——官方哪天把它放进清单，价格与元数据以官方为准）；已过期不追加。
 * 返回新数组，不改传入。
 */
function mergeSupplementEntries(entries, { now = Date.now() } = {}) {
  const out = Array.isArray(entries) ? entries.slice() : [];
  if (now >= HUNGERG_FREE_UNTIL_MS) return out;
  const present = new Set(out.map((e) => String((e && (e.key || e.id)) || '')));
  for (const s of SUPPLEMENTS) {
    if (present.has(s.key) || present.has(`qoder/${s.key}`) || present.has(`qoder/${s.name}`)) continue;
    out.push({
      id: `qoder/${s.name}`,
      key: s.key,
      name: s.name,
      contextWindow: s.row.maxInputTokens || null,
      maxContextWindow: s.row.maxInputTokens || null,
      status: 'active',
      catalogSource: 'supplement',
      supplement: true,
      freeUntil: HUNGERG_FREE_UNTIL_MS,
    });
  }
  return out;
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
  HUNGERG_FREE_UNTIL_MS, supplementRows, supplementMetaOf, supplementRegionOf, mergeSupplementEntries,
  clientCacheCandidates, readClientCache,
  diskCachePath, readDiskCache, writeDiskCache,
  resolveCatalog, _resetForTest,
};
