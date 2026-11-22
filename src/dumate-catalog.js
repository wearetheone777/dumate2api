// src/dumate-catalog.js - 搭子模型清单（桌面端真相源 + 快照 + 内置默认）
//
// 2026-11-15 融合 P0-1。动机：本仓的模型面是**手工登记**的（modelmap.js 的
// MODEL_NAMES + DEFAULT_EXPOSED 三条），而搭子客户端自己有一份**带完整元数据**
// 的模型清单——22 个对话入口，每个都有 context / output / 视觉 / 工具标记。
// 社区三个 magpie 插件（2026-11-13）都改成读这份清单，本仓此前只有 3 条对外
// 暴露、缺 10 个可对话模型（豆包 / 文心 / Qwen3.5 系 / Qwen3.8-max / kimi-k3）。
//
// 真相源（实测路径，社区三仓一致）：
//   %APPDATA%\qianfan-desktop-app\qianfan_desk_xdg\<激活账号>\config\opencode\opencode.json
//     → provider.QianfanPersonalQuota.models
//
// 三条设计纪律（改之前先读）：
//
// 1. **只导入模型元数据**。endpoint / apiKey / headers / plugins / commands /
//    permissions 一律不跨这条边界——那份 JSON 是客户端自己的运行时配置，
//    把 apiKey 抄进模型清单等于把凭证散落到 data/ 与前端。过滤器在
//    importModels 里，快照读回时**再走一遍同一过滤器**（防篡改注入）。
//
// 2. **快照独立、原子写、失败降级不撒谎**。三级降级：真相源 → 本地快照
//    （data/dumate-catalog.json）→ 包内默认（**src/dumate-catalog.default.json**，
//    asOf 2026-11-13）。包内默认必须与代码一起入库：`data/` 整个目录被
//    gitignore，放在那里等于干净检出/stable 快照上根本不存在这个兜底
//    （review #4）。降级时 `source` 字段如实标注，界面照实显示。
//
// 3. **清单存在 ≠ 有调用权限**。这里给出的是「候选集」，不是「可用集」。
//    有没有权限只能靠实测（test/probe-*.js），别把 catalog 直接当白名单用于
//    计费或告警。
//
// 注意：catalog 的 limit.output 是**客户端展示值**，与上游 400 错误体声明的
// 真值可能不同（实例：model-text 客户端 384000 vs 上游 393216）。所以
// dumate-caps 的实测学习值优先于 catalog，见那边的注释。

const fs = require('fs');
const filelock = require('./filelock');
const path = require('path');

const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
const SNAPSHOT = 'dumate-catalog.json';
// 包内默认放在 src/（与代码同目录）：data/ 被 gitignore，放那里不会入库，
// 干净检出的第三级降级会直接落到 source:'none'。
const DEFAULT_FILE = path.join(__dirname, 'dumate-catalog.default.json');

/** 与社区实现一致的排除规则：内部任务路由 / mock / OCR / 向量 / 重排 / 专用生图 */
const EXCLUDE_KEY_RE = /(?:embedding|reranker|ocr|^llm-mock$|^dumate-image)/i;

const VALID_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/;

const posInt = (n) => Number.isSafeInteger(n) && n > 0;

const INPUT_MODALITIES = new Set(['text', 'image', 'audio', 'video', 'pdf']);

function modalitiesOf(list) {
  if (!Array.isArray(list)) return ['text'];
  const out = [...new Set(list.filter((x) => INPUT_MODALITIES.has(x)))];
  return out.length ? out : ['text'];
}

function filePath() {
  return path.join(DATA_DIR, SNAPSHOT);
}

/** 桌面端 opencode.json 的绝对路径；`DUMATE_OPENCODE_CONFIG` 优先 */
function sourcePath(env = process.env) {
  const override = String(env.DUMATE_OPENCODE_CONFIG || '').trim();
  if (override) return override;
  const dir = String(env.DUMATE_USER_DATA_DIR || '').trim()
    || path.join(env.APPDATA || '', 'qianfan-desktop-app');
  if (!dir) return '';
  // 按当前激活账号找：auth.json 的 activeProfileId 指向 accountProfiles 里的一条，
  // 那条的 bceAccountId 就是 qianfan_desk_xdg 下的目录名。读不到就在唯一账号目录
  // 存在时自动选择；多个账号**不猜**（社区同口径）。
  let accountId = '';
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    const profiles = Array.isArray(auth.accountProfiles) ? auth.accountProfiles : [];
    const active = profiles.find((p) => p && p.profileId === auth.activeProfileId)
      || (profiles.length === 1 ? profiles[0] : null);
    if (active && active.bceAccountId) accountId = String(active.bceAccountId);
  } catch (e) { /* auth.json 读不到就走唯一目录猜测 */ }
  const root = path.join(dir, 'qianfan_desk_xdg');
  const tail = path.join('config', 'opencode', 'opencode.json');
  if (accountId) return path.join(root, accountId, tail);
  try {
    const only = fs.readdirSync(root).filter((n) => {
      try { return fs.statSync(path.join(root, n)).isDirectory(); } catch (e) { return false; }
    });
    if (only.length === 1) return path.join(root, only[0], tail);
  } catch (e) { /* 目录不存在 */ }
  return '';
}

/**
 * 把客户端的 opencode.json 过滤成纯模型清单。
 * 入参是整份配置（或 `{ provider: { QianfanPersonalQuota: { models } } }` 的同形包）。
 * @returns {{ schema:number, models:object, excluded:number }}
 */
function importModels(config) {
  const src = config && config.provider && config.provider.QianfanPersonalQuota
    && config.provider.QianfanPersonalQuota.models;
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    throw new Error('配置里没有 provider.QianfanPersonalQuota.models');
  }
  const models = Object.create(null);
  let excluded = 0;
  for (const [key, value] of Object.entries(src)) {
    const id = (value && typeof value.id === 'string') ? value.id : key;
    if (!VALID_ID_RE.test(key) || !VALID_ID_RE.test(id) || !value || typeof value !== 'object') continue;
    // 内部任务路由（model-*，model-text 除外）、mock、OCR、向量、重排、专用生图 —— 都不是对话入口
    if ((key.startsWith('model-') && key !== 'model-text') || EXCLUDE_KEY_RE.test(key)) { excluded++; continue; }
    // 显示别名指向源里另一个真实条目 → 重复，丢掉别名那份
    if (key !== id && Object.prototype.hasOwnProperty.call(src, id)) { excluded++; continue; }
    const limit = value.limit || {};
    const context = limit.context !== undefined ? limit.context : limit.input;
    const output = limit.output;
    if (!posInt(context) || !posInt(output)) continue;
    const input = modalitiesOf(value.modalities && value.modalities.input);
    if (!input.includes('text')) continue;
    models[key] = {
      id,
      // 显示别名 → 带上真实 id（实例：旧的 glm-5 键实际指向 model-text）
      name: key === id ? id : `${key} (API: ${id})`,
      limit: { context, output },
      tool_call: value.tool_call !== false,
      // 「能思考」的判据：白名单后端，或客户端/新配置显式声明
      reasoning: id === 'deepseek-v41-flash' || value.reasoning === true
        || (value.capabilities && value.capabilities.reasoning === true),
      ...(id === 'deepseek-v41-flash' ? { variants: { none: {}, low: {}, high: {}, max: {} } } : {}),
      attachment: input.some((x) => x !== 'text'),
      modalities: { input, output: ['text'] },
    };
  }
  if (!Object.keys(models).length) throw new Error('清单里没有可用的对话模型');
  return { schema: 1, models, excluded };
}

function readJson(p, maxBytes) {
  const st = fs.statSync(p);
  if (!st.isFile() || st.size <= 0 || st.size > (maxBytes || 2 * 1024 * 1024)) {
    throw new Error(`文件尺寸异常：${p}`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 快照值再走一遍过滤器：被篡改的快照不能把 endpoint / key 带进模型表 */
function fromSnapshot(snap) {
  if (!snap || snap.schema !== 1) throw new Error('快照 schema 不支持');
  return importModels({ provider: { QianfanPersonalQuota: { models: snap.models } } }).models;
}

function writeSnapshot(catalog) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const target = filePath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  filelock.renameAtomic(tmp, target);
}

let cache = { at: 0, mtime: 0, srcMtime: 0, data: null };

/**
 * 读清单。返回 `{ models, source, asOf, excluded }`：
 *   source = 'desktop'（来自客户端配置）/ 'snapshot'（本地快照）/ 'default'（包内默认）
 * 任何一步失败都不会抛——降级到下一级，全失败时返回空表（调用方自行兜底）。
 */
function load(env = process.env) {
  const src = sourcePath(env);
  let srcMtime = 0;
  try { srcMtime = src ? fs.statSync(src).mtimeMs : 0; } catch (e) { /* 不存在 */ }
  let snapMtime = 0;
  try { snapMtime = fs.statSync(filePath()).mtimeMs; } catch (e) { /* 不存在 */ }
  const stamp = `${srcMtime}|${snapMtime}`;
  if (cache.data && cache.mtime === stamp) return cache.data;

  let result = null;
  // ① 客户端配置（真相源）
  if (src) {
    try {
      const imported = importModels(readJson(src));
      result = { ...imported, source: 'desktop', asOf: '' };
      // 变更才写快照（避免每次请求都写盘；内容比较在 saveIfChanged 里）
      saveIfChanged(imported);
    } catch (e) { /* 落下一级 */ }
  }
  // ② 本地快照
  if (!result) {
    try {
      const snap = readJson(filePath());
      result = { models: fromSnapshot(snap), excluded: snap.excluded || 0, schema: 1, source: 'snapshot', asOf: snap.asOf || '' };
    } catch (e) { /* 落下一级 */ }
  }
  // ③ 包内默认
  if (!result) {
    try {
      const def = readJson(DEFAULT_FILE);
      result = { models: fromSnapshot(def), excluded: def.excluded || 0, schema: 1, source: 'default', asOf: def.asOf || '' };
    } catch (e) { result = { models: {}, excluded: 0, schema: 1, source: 'none', asOf: '' }; }
  }

  cache = { at: Date.now(), mtime: stamp, srcMtime, data: result };
  return result;
}

/** 内容有变化才落快照（桌面配置每次启动都可能重写，mtime 变化不代表内容变化） */
function saveIfChanged(imported) {
  try {
    const cur = readJson(filePath());
    if (JSON.stringify(cur.models) === JSON.stringify(imported.models)) return;
  } catch (e) { /* 没有快照或坏了 → 写一份新的 */ }
  try {
    const now = new Date();
    const asOf = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    writeSnapshot({ schema: 1, models: imported.models, excluded: imported.excluded, asOf });
  } catch (e) { /* 只读目录不该让服务起不来 */ }
}

/** 对话模型 id 列表（稳定顺序：按 id 字典序，界面与 /v1/models 不抖） */
function ids(env) {
  return Object.keys(load(env).models).sort();
}

/** 单模型元数据；查不到返回 null */
function get(id, env) {
  const cat = load(env);
  return cat.models[id] || null;
}

/** 测试用：清掉进程内缓存 */
function resetCache() {
  cache = { at: 0, mtime: 0, srcMtime: 0, data: null };
}

module.exports = {
  load, ids, get, resetCache,
  importModels, sourcePath, filePath,
  SNAPSHOT, DEFAULT_FILE, EXCLUDE_KEY_RE,
};
