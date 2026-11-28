// src/admin/routes/storage.js - 存储管理（批次十七，参考 workbuddy-shift storage/）
//
// 职责：data/ 目录的体量四类视图 + 可清理项的「先预览再确认」删除 + 60s 快照
// （切页签不重扫）。三条纪律照搬参考实现，一条是本仓库的收窄：
//
// 1. **白名单根只有 DUMATE_ADMIN_DATA**：请求里只收**裸文件名**（禁止任何路径分隔符
//    与 `..`），且必须命中本次扫描目录的产物——路径穿越在参数形状上就不成立。
// 2. **先预览再确认**：清理是两步（/cleanup/preview 零写盘 → /cleanup 需 confirm），
//    预览与执行读同一份分类目录，绝不出现「预览说 3 个、实际删了 5 个」。
// 3. **60 秒快照**：扫描是全目录 stat，切页签不该重扫；清理后强制作废，页面紧接的
//    「重新扫描」必须拿到新数字。
// 4. **未识别文件一律保护**（本仓库收窄）：分类表只登记认识的文件名；data/ 里出现
//    不认识的文件（第三方插件、手工放的备份）→ other 类、protected——
//    存储管理页宁可少删，绝不能猜。凭证/配置/运行态/审计同样全部 protected：
//    这里是「回收空间」的入口，不是「删配置」的入口。
//
// 可删除的只有两类：**流水与日志**（JSONL 埋点与 *.log，删后从下一行重新累积；
// 其中积分归因/余额曲线删除后历史不可恢复——预览里如实标注）与**缓存**
// （可再生：expiring-snapshot 由 /credits 刷新重建、caps/rate-cache 由上游报错与
// 探针重建、daypeak 已停用可删）。

const fs = require('fs');
const path = require('path');
const { sendJSON } = require('../router');
const store = require('../store');

const SNAPSHOT_TTL_MS = Number(process.env.DUMATE_STORAGE_SNAPSHOT_TTL_MS) || 60000;

// 分类表（单一来源）：name → { category, deletable, note? }。
// 通配项用前缀/后缀规则（*.log / *-trash.json / requests.jsonl.1 这类轮转产物）。
// 刻意不写「默认 deletable」——没登记到的一律走 other/protected。
const KNOWN = {
  // 凭证（protected）
  'admin-users.json': { category: 'credentials', note: '管理账户表（口令哈希）' },
  'admin.secret': { category: 'credentials', note: '会话签名密钥' },
  'keys.json': { category: 'credentials', note: 'API Key（明文）' },
  'web-accounts.json': { category: 'credentials', note: '搭子网页账号（cookie 明文）' },
  'qwenwork-accounts.json': { category: 'credentials', note: '千问账号（含 refresh token）' },
  'qoder-accounts.json': { category: 'credentials', note: 'Qoder 账号（含 refresh token）' },
  'traework-accounts.json': { category: 'credentials', note: 'TRAE 账号（含 refresh token）' },
  'workbuddy-accounts.json': { category: 'credentials', note: 'WorkBuddy 账号（含 refresh token）' },
  // 配置与运行态（protected）
  'model-map.json': { category: 'config', note: '模型映射/别名' },
  'livecfg.json': { category: 'config', note: '面板热配置' },
  'key-quota.json': { category: 'config', note: '子 Key 配额桶' },
  'route-groups.json': { category: 'config', note: '自定义路由组' },
  'auto-checkin.json': { category: 'config', note: '自动签到配置' },
  'task-scheduler.json': { category: 'config', note: '任务轮询配置' },
  'notify.json': { category: 'config', note: '告警 webhook 配置' },
  'alerts-state.json': { category: 'config', note: '运维告警状态' },
  'desensitize-words.txt': { category: 'config', note: '脱敏词表' },
  'qoder-runtime.json': { category: 'config', note: 'Qoder 运行期配置' },
  'traework-runtime.json': { category: 'config', note: 'TRAE 运行期配置' },
  'workbuddy-runtime.json': { category: 'config', note: 'WorkBuddy 运行期配置' },
  'workbuddy-model-rules.json': { category: 'config', note: 'WorkBuddy 模型规则' },
  'workbuddy-model-windows.json': { category: 'config', note: '6004 额度窗口表' },
  'workbuddy-credits-snapshot.json': { category: 'config', note: 'WorkBuddy 护栏快照' },
  'qoder-period.json': { category: 'config', note: '订阅周期观察数据（重新观察成本高）' },
  'pool-state.json': { category: 'config', note: '账号池运行态（冷却/熔断/限流）' },
  'usage-agg.json': { category: 'config', note: '用量聚合桶（删除丢历史小时桶）' },
  'qoder-grants.jsonl': { category: 'config', note: 'Qoder 积分批次台账（上游无逐批余额接口，不可再生）' },
  'checkin-ledger.jsonl': { category: 'config', note: '签到幂等账本（删了会重复签到）' },
  'admin-audit.jsonl': { category: 'config', note: '管理操作审计（保留问责链）' },
  // 流水与日志（deletable）
  'requests.jsonl': { category: 'logs', deletable: true, note: '网关埋点（32MB 自动轮转；删除后统计从零累积）' },
  'activity.jsonl': { category: 'logs', deletable: true, note: '签到/任务/抽奖操作记录' },
  'task-runs.jsonl': { category: 'logs', deletable: true, note: '任务执行历史' },
  'qwenwork-credits.jsonl': { category: 'logs', deletable: true, note: '千问积分归因（删除后归因历史清零）' },
  'qoder-credits.jsonl': { category: 'logs', deletable: true, note: 'Qoder 积分归因（删除后归因历史清零）' },
  'traework-credits.jsonl': { category: 'logs', deletable: true, note: 'TRAE 积分归因（删除后归因历史清零）' },
  'points-cursor.jsonl': { category: 'logs', deletable: true, note: '搭子余额游标（下次请求重新建基线）' },
  'balance-hist.jsonl': { category: 'logs', deletable: true, note: '余额变动流水（删除后曲线清零）' },
  'langfuse-local.jsonl': { category: 'logs', deletable: true, note: 'Langfuse 投递失败本地日志' },
  // 缓存（deletable，可再生）
  'expiring-snapshot.json': { category: 'cache', deletable: true, note: '临期积分快照（管理端 /credits 刷新重建）' },
  'dumate-caps.json': { category: 'cache', deletable: true, note: 'max_tokens 上限自学习（撞 400 重建）' },
  'dumate-rate-cache.json': { category: 'cache', deletable: true, note: '实测倍率缓存（计费探针重建）' },
  'qwenwork-daypeak.json': { category: 'cache', deletable: true, note: '历史遗留（2026-11-02 起不再读写，可删）' },
};

const CATEGORIES = [
  { id: 'credentials', label: '凭证', deletable: false },
  { id: 'config', label: '配置与运行态', deletable: false },
  { id: 'logs', label: '流水与日志', deletable: true },
  { id: 'cache', label: '缓存（可再生）', deletable: true },
  { id: 'other', label: '未识别（一律保护）', deletable: false },
];

function classify(name, isDir) {
  if (isDir) {
    if (name === 'browser-profile') return { category: 'credentials', note: '浏览器登录器 profile（含登录态）' };
    if (name === 'runs') return { category: 'config', note: '任务原始产物目录' };
    if (name === 'logs') return { category: 'logs', note: '运行日志归档目录（每日一份，30 天滚动清理；ZIP 导出在用，目录本身不删）' };
    return { category: 'other', note: '未识别目录（保护）' };  }
  if (KNOWN[name]) return { ...KNOWN[name] };
  // 回收站文件（批次十六）与轮转产物按规则归类
  if (/-accounts-trash\.json$/.test(name)) return { category: 'credentials', note: '账号回收站（去账号页管理）' };
  if (/\.log$/.test(name)) return { category: 'logs', deletable: true, note: '运行日志' };
  if (/^requests\.jsonl\.\d+$/.test(name)) return { category: 'logs', deletable: true, note: '埋点轮转产物' };
  if (/\.jsonl\.\d+$/.test(name)) return { category: 'logs', deletable: true, note: '流水轮转产物' };
  return { category: 'other', note: '未识别文件（保护）' };
}

function statTree(p, depth = 0) {
  // 目录体积：递归求和；depth 4 封顶防异常深树
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch (e) {
    return { bytes, files };
  }
  for (const ent of entries) {
    const full = path.join(p, ent.name);
    if (ent.isDirectory()) {
      if (depth < 4) {
        const sub = statTree(full, depth + 1);
        bytes += sub.bytes;
        files += sub.files;
      }
    } else if (ent.isFile()) {
      try { bytes += fs.statSync(full).size; files++; } catch (e) { /* 竞态删除不碍扫描 */ }
    }
  }
  return { bytes, files };
}

// 扫描 data/：每个条目一行（含目录）。分类与可删性只由 classify() 决定。
function scanDir(dataDir) {
  let names = [];
  try {
    names = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const rows = [];
  for (const ent of names) {
    const full = path.join(dataDir, ent.name);
    const isDir = ent.isDirectory();
    const cls = classify(ent.name, isDir);
    let bytes = 0;
    let files = 0;
    let mtimeMs = null;
    try {
      const st = fs.statSync(full);
      mtimeMs = st.mtimeMs;
      if (isDir) {
        const t = statTree(full);
        bytes = t.bytes;
        files = t.files;
      } else if (st.isFile()) {
        bytes = st.size;
        files = 1;
      }
    } catch (e) { /* 扫描中的竞态删除：如实留 0 */ }
    rows.push({
      name: ent.name,
      bytes,
      files,
      mtimeMs,
      isDir,
      category: cls.category,
      deletable: !isDir && cls.deletable === true,
      note: cls.note || '',
    });
  }
  return rows;
}

// 60s 快照（切页签不重扫）。键含 dataDir——测试换临时目录不串。清理后 invalidate。
let snapshotCache = { key: null, at: 0, rows: [] };

function buildSnapshot(dataDir) {
  const rows = scanDir(dataDir);
  const generatedAt = Date.now();
  const categories = CATEGORIES.map((c) => ({
    ...c,
    bytes: 0,
    files: 0,
    count: 0,
  }));
  const byId = new Map(categories.map((c) => [c.id, c]));
  let totalBytes = 0;
  let totalFiles = 0;
  for (const r of rows) {
    const c = byId.get(r.category) || byId.get('other');
    c.bytes += r.bytes;
    c.files += r.files;
    c.count += 1;
    totalBytes += r.bytes;
    totalFiles += r.files;
  }
  const deletableBytes = rows.filter((r) => r.deletable).reduce((s, r) => s + r.bytes, 0);
  return {
    ok: true,
    generatedAt,
    dataDir,
    ttlMs: SNAPSHOT_TTL_MS,
    totals: { bytes: totalBytes, files: totalFiles },
    deletableBytes,
    categories,
    files: rows.sort((a, b) => b.bytes - a.bytes),
    warnings: [
      '流水与日志删除后从零重新累积，其中积分归因/余额曲线的历史不可恢复——预览里逐项确认。',
      '凭证与配置在这里永远只读；删账号去「账号管理」，删配置去对应设置页。',
      '未识别的文件/目录一律保护，不提供删除。',
    ],
  };
}

function scan({ refresh = false } = {}) {
  const dataDir = store.DATA_DIR;
  const fresh = !snapshotCache.key || snapshotCache.key !== dataDir || Date.now() - snapshotCache.at >= SNAPSHOT_TTL_MS;
  if (refresh || fresh) {
    snapshotCache = { key: dataDir, at: Date.now(), rows: buildSnapshot(dataDir) };
    return { ...snapshotCache.rows, cached: false };
  }
  return { ...snapshotCache.rows, cached: true };
}

function invalidateSnapshot() {
  snapshotCache = { key: null, at: 0, rows: [] };
}

// 白名单校验：只收裸文件名（无路径分隔符、无 ..、不在 KNOWN 之外猜）。
// 返回 {ok, name} 或 {ok:false, reason}——refused 列表如实回给预览/执行两处。
function validateName(dataDir, name) {
  if (typeof name !== 'string' || !name) return { ok: false, reason: '空文件名' };
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { ok: false, reason: '只允许 data/ 下的裸文件名' };
  }
  if (name !== path.basename(name)) return { ok: false, reason: '只允许 data/ 下的裸文件名' };
  const full = path.join(dataDir, name);
  let st;
  try {
    st = fs.lstatSync(full);
  } catch (e) {
    return { ok: false, reason: '文件不存在' };
  }
  if (!st.isFile()) return { ok: false, reason: '只允许删除普通文件（目录不删）' };
  const cls = classify(name, false);
  if (cls.deletable !== true) {
    return { ok: false, reason: `「${name}」属于受保护类别（${cls.category}），不提供删除` };
  }
  return { ok: true, name, fullPath: full, bytes: st.size, category: cls.category, note: cls.note || '' };
}

// 预览与执行共用同一份校验与汇总（先预览再确认：两步看到的是同一份清单）
function collect(dataDir, names) {
  if (!Array.isArray(names) || !names.length) {
    return { ok: false, error: '缺少 names（要清理的文件名数组）' };
  }
  const items = [];
  const refused = [];
  const seen = new Set();
  for (const n of names) {
    const v = validateName(dataDir, n);
    if (!v.ok) {
      refused.push({ name: String(n), reason: v.reason });
      continue;
    }
    if (seen.has(v.name)) continue; // 重复请求合并
    seen.add(v.name);
    items.push({ name: v.name, bytes: v.bytes, category: v.category, note: v.note, fullPath: v.fullPath });
  }
  return { ok: true, items, refused, totalBytes: items.reduce((s, i) => s + i.bytes, 0) };
}

function routes() {
  return [
    {
      method: 'GET',
      path: '/scan',
      handler: ({ res, req }) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        sendJSON(res, 200, scan({ refresh: url.searchParams.get('refresh') === '1' }));
      },
    },
    {
      // 预览：零写盘。返回将删的清单 + 拒绝清单（含原因）
      method: 'POST',
      path: '/cleanup/preview',
      handler: ({ res, body }) => {
        const r = collect(store.DATA_DIR, body && body.names);
        if (!r.ok) return sendJSON(res, 400, r);
        // fullPath 是服务器本地路径，界面用不到——不下发
        const items = r.items.map(({ fullPath, ...rest }) => rest);
        sendJSON(res, 200, { ok: true, items, refused: r.refused, totalBytes: r.totalBytes, write: false });
      },
    },
    {
      // 执行：confirm 双确认；逐个 unlink，单项失败不阻断其余；完成后作废快照
      method: 'POST',
      path: '/cleanup',
      handler: ({ res, body, user }) => {
        if (!(body && body.confirm)) {
          return sendJSON(res, 400, { ok: false, error: '清理需要 confirm:true（不可逆操作）' });
        }
        const r = collect(store.DATA_DIR, body && body.names);
        if (!r.ok) return sendJSON(res, 400, r);
        const removed = [];
        const failed = [];
        for (const item of r.items) {
          try {
            fs.unlinkSync(item.fullPath);
            removed.push({ name: item.name, bytes: item.bytes });
          } catch (e) {
            failed.push({ name: item.name, reason: e.message });
          }
        }
        invalidateSnapshot();
        try {
          require('../auth').audit((user && user.username) || 'admin', 'storage_cleanup', '',
            `${removed.length} 个文件 / ${r.totalBytes} 字节${failed.length ? `，失败 ${failed.length}` : ''}`);
        } catch (e) { /* 审计失败不影响结果 */ }
        sendJSON(res, 200, {
          ok: failed.length === 0,
          removed,
          failed,
          refused: r.refused,
          freedBytes: removed.reduce((s, i) => s + i.bytes, 0),
        });
      },
    },
  ];
}

// 供测试钉目录（backup.js 的 _dataDir 同款约定）
function _dataDir() {
  return store.DATA_DIR;
}

module.exports = {
  routes: routes(), // 与其它 route 模块同款：导出数组（server.js mount 直接消费）
  SNAPSHOT_TTL_MS,
  KNOWN,
  CATEGORIES,
  classify,
  scan,
  scanDir,
  invalidateSnapshot,
  _dataDir,
};
