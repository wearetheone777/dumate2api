// src/modelmap.js - 模型映射（单一来源）
//
// 之前模型信息散在三处：anthropic.js 的 MODEL_MAP、server.js 里硬编码的
// /v1/models 列表、以及上游实际接受的 ID。三者会各自漂移——实测上游只接受
// model-text / model-artifact-validate / glm-5，而映射表里的 claude-* 与
// gpt-* 全靠 mapModel 兜底转成 model-text 才能用，界面却把它们当成独立模型
// 列出来。
//
// 这里把它收敛成一份可编辑配置，落 data/model-map.json。网关进程与管理端是
// 两个进程，所以读盘按 mtime 失效而不是只在启动时读一次——否则管理端改完
// 必须重启网关才生效，界面无法解释。
const fs = require('fs');
const filelock = require('./filelock');
const path = require('path');

const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
const FILE = 'model-map.json';

// 与改造前 MODEL_MAP 完全一致的默认值：升级不改变既有行为
const DEFAULT_ALIASES = {
  'claude-3-5-sonnet-20241022': 'model-text',
  'claude-3-5-sonnet-latest': 'model-text',
  'claude-3-5-haiku-20241022': 'model-text',
  'claude-3-5-haiku-latest': 'model-text',
  'claude-sonnet-4-20250514': 'model-text',
  'claude-opus-4-20250514': 'model-text',
  'claude-3-opus-20240229': 'model-text',
  'claude-3-haiku-20240307': 'model-text',
  'model-text': 'model-text',
  'model-artifact-validate': 'model-artifact-validate',
  // glm-5 上游直接接受（实测 200），但原表没收录它，于是被兜底转成
  // model-text —— 一个可用模型就这样被静默丢弃了。补上自身映射。
  'glm-5': 'glm-5',
  'gpt-4o': 'model-text',
  'gpt-4o-mini': 'model-text',
  'gpt-4': 'model-text',
  'gpt-4-turbo': 'model-text',
  'o1': 'model-text',
  'o1-mini': 'model-text',
  'o3': 'model-text',
  'o3-mini': 'model-text',
  'gpt-5': 'model-text',
};

// 上游真正认识的 ID。其余名字必须经别名映射后才能用。
const DEFAULT_UPSTREAM = ['model-text', 'model-artifact-validate', 'glm-5'];

// /v1/models 对外暴露的条目。
//
// **只列上游真实模型**（2026-10-21）：`claude-3-5-sonnet-20241022` / `gpt-4o`
// 不是上游模型，只是客户端协议名——网关会经别名把它们转到 model-text。
// 列在模型列表里会让客户端以为它们是独立模型（cc-switch 里会单独显示成
// dumate-proxy 一组）。别名映射本身保留（aliases 不动），所以客户端仍可
// 传这些名字，只是不再出现在「可选模型」清单里。
const DEFAULT_EXPOSED = [
  'model-text',
  'model-artifact-validate',
  'glm-5',
];

const DEFAULTS = {
  aliases: DEFAULT_ALIASES,
  upstream_models: DEFAULT_UPSTREAM,
  exposed: DEFAULT_EXPOSED,
  fallback: 'model-text',
};

let cache = { at: 0, mtime: 0, data: null };

function filePath() {
  return path.join(DATA_DIR, FILE);
}

function readDisk() {
  try {
    return JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch (e) {
    return null;
  }
}

function mtimeOf() {
  try { return fs.statSync(filePath()).mtimeMs; } catch (e) { return 0; }
}

// 规范化。关键点：**文件存在时 aliases 就是文件里的内容**，不再把默认表
// 合回去。原先每次 load 都 `{...DEFAULT_ALIASES, ...aliases}`，导致界面上
// 删掉一个默认别名后它又冒出来——删除永远无效，用户没有任何办法解除映射。
// 默认表只在「文件不存在」时作为初始值。
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : null;
  const hasAliases = r && r.aliases && typeof r.aliases === 'object' && !Array.isArray(r.aliases);
  return {
    aliases: hasAliases ? { ...r.aliases } : { ...DEFAULT_ALIASES },
    upstream_models: r && Array.isArray(r.upstream_models) && r.upstream_models.length
      ? r.upstream_models.map(String)
      : DEFAULT_UPSTREAM.slice(),
    exposed: r && Array.isArray(r.exposed) && r.exposed.length
      ? r.exposed.map(String)
      : DEFAULT_EXPOSED.slice(),
    fallback: r && typeof r.fallback === 'string' && r.fallback ? r.fallback : DEFAULTS.fallback,
  };
}

function load() {
  const mtime = mtimeOf();
  if (cache.data && cache.mtime === mtime) return cache.data;
  const data = normalize(readDisk());
  cache = { at: Date.now(), mtime, data };
  return data;
}

function save(patch) {
  const current = load();
  const next = normalize({
    aliases: patch.aliases !== undefined ? patch.aliases : current.aliases,
    upstream_models: patch.upstream_models !== undefined ? patch.upstream_models : current.upstream_models,
    exposed: patch.exposed !== undefined ? patch.exposed : current.exposed,
    fallback: patch.fallback !== undefined ? patch.fallback : current.fallback,
  });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const target = filePath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  filelock.renameAtomic(tmp, target);
  cache = { at: Date.now(), mtime: mtimeOf(), data: next };
  return next;
}

function reset() {
  try { fs.unlinkSync(filePath()); } catch (e) { /* 本来就不存在 */ }
  cache = { at: Date.now(), mtime: 0, data: null };
  return load();
}

// 与改造前的 mapModel 行为一致：查不到就回落到 fallback
function mapModel(name) {
  const cfg = load();
  if (!name) return cfg.fallback;
  return cfg.aliases[name] || cfg.fallback;
}

/**
 * 上游模型 ID 的**可读标注**。
 *
 * 搭子上游没有模型列表接口（`/models` 404、`/model/list` 400，2026-10-21
 * 用网页凭证复测确认），这三个 ID 是**探测**出来的、上游唯一接受的名字：
 * 传 `glm-5.2` / `glm-5.1` / `glm-4.6` 一律 404 `api not registered`。
 *
 * 因此下面的中文名是**本地标注**，不是百度下发的官方名称——界面必须标明
 * 来源，不能让人以为这是上游给的元信息。
 */
const MODEL_NAMES = {
  'model-text': '文本模型（上游默认）',
  'model-artifact-validate': '制品校验模型',
  'glm-5': 'GLM-5',
  // 自动三档（2026-10-31 真机实证，网页凭证直打云端网关）：模型名即档位，
  // 不需要请求头。括号里是网关响应头 X-Dumate-Gw-Realmodel 回传的真实后端，
  // 仍是本地标注——上游没有模型列表接口
  'dm-auto-model/text.L0': '自动档 L0（实跑 DeepSeek-V4.1-Flash-Low-Latency）',
  'dm-auto-model/text.L1': '自动档 L1（实跑 Kimi-K3）',
  'dm-auto-model/text.L2': '自动档 L2（实跑 Qwen3.8-Max）',
};

/** 上游 ID → 可读名；没有标注就原样返回（别名表里的 claude-* / gpt-* 属于客户端协议名） */
function displayName(id) {
  return MODEL_NAMES[id] || id;
}

module.exports = {
  DEFAULTS,
  MODEL_NAMES,
  displayName,
  DEFAULT_ALIASES,
  DEFAULT_UPSTREAM,
  DEFAULT_EXPOSED,
  filePath,
  load,
  save,
  reset,
  mapModel,
};
