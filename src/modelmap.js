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

// Claude Desktop 3p 直连网关只发 claude-* 路由名（cc-switch 直连模式的硬约束：
// direct_inference_model_specs 拒绝非 claude-* 名，真实模型只出现在 label 里）。
// 按 **key 的通道** 把路由名解析成带前缀的网关模型名——一个 profile 配一把
// 通道 key，同样的 claude-sonnet-5 在 qoder key 下落 Qwen3.8-Flash、在搭子
// key 下落 L0。映射表与 cc-switch 四个 9082 provider 的 env 档位一一对应。
// key 没绑通道时不解析（返回 null 走原 fallback）——不限通道的 key 配哪个
// profile 都可能，替它选通道等于编造。
const CLAUDE_ROUTES = {
  dumate: {
    sonnet: 'dm-auto-model/text.L0',
    opus: 'dm-auto-model/text.L1',
    haiku: 'model-text',
    fable: 'dm-auto-model/text.L2',
  },
  qwenwork: {
    sonnet: 'qwen/flash',
    opus: 'qwen/pro',
    haiku: 'qwen/flash',
    fable: 'qwen/pro',
  },
  traework: {
    sonnet: 'traework/deepseek-v4.1-flash',
    opus: 'traework/glm-5.3-flash',
    haiku: 'traework/glm-5.3-flash',
    fable: 'traework/kimi-k3.1-pro',
  },
  qoder: {
    sonnet: 'qoder/Qwen3.8-Flash',
    opus: 'qoder/GLM-5.3-Flash',
    haiku: 'qoder/DeepSeek-Flash',
    fable: 'qoder/Qwen3.8-Max',
  },
};

// 旧式名不劫持：claude-3-5-sonnet-20241022（role 前有版本段）与
// claude-sonnet-4-20250514（role 后带 8 位日期串）继续走别名表/fallback，
// 历史行为不变。只认 claude-{role} 后跟短版本号（1-2 位数字，可多段）的
// 新式路由名——Claude Desktop / 新版 Claude Code 的形状。
const CLAUDE_ROUTE_RE = /^claude-(sonnet|opus|haiku|fable)(?:-\d{1,2})*$/i;

/**
 * claude-* 路由名 → 该通道的网关模型名（带通道前缀，router 可直接认领）。
 * 兼容三种写法：anthropic/ 前缀、[1M] 后缀、大小写混合。非路由名或通道
 * 无映射时返回 null，调用方原样放行。
 */
function resolveClaudeRoute(name, channel) {
  if (!name || !channel) return null;
  let s = String(name).trim();
  if (s.toLowerCase().startsWith('anthropic/')) s = s.slice('anthropic/'.length);
  s = s.replace(/\[1M\]$/i, '');
  const m = CLAUDE_ROUTE_RE.exec(s);
  if (!m) return null;
  const table = CLAUDE_ROUTES[channel];
  if (!table) return null;
  return table[m[1].toLowerCase()] || null;
}

/**
 * 入口统一清理（鉴权段与四个协议 handler 的 route 解析之前调用）：
 * claude-* 路由名按通道重写；其余名字只剥 [1M] 标记（Claude Code /
 * Claude Desktop 的「1M 上下文」后缀，qwen/pro[1M] 不剥的话直连通道会
 * 把 'pro[1M]' 当模型名打上游）。返回 null 表示无需改动。
 */
function normalizeIncomingModel(name, channel) {
  if (!name) return null;
  const cl = resolveClaudeRoute(name, channel);
  if (cl) return cl;
  const s = String(name);
  return /\[1M\]$/i.test(s) ? s.replace(/\[1M\]$/i, '') : null;
}

// 与改造前的 mapModel 行为一致：查不到就回落到 fallback
function mapModel(name) {
  const cfg = load();
  if (!name) return cfg.fallback;
  // [1M] 后缀是「1M 上下文」标记（Claude Code / Claude Desktop 的约定），
  // 不是模型身份的一部分——不剥的话 glm-5[1M] 会静默落 fallback（历史
  // 日志里 200 但实际跑的是 model-text，正是这种静默兜底）。
  const base = String(name).replace(/\[1M\]$/i, '');
  // 上游真名**直接透传**（2026-11-01）：upstream_models 是实测过的、上游接受
  // 的名字，它们不需要别名条目就能用——此前别名表是唯一的允许名单，表里
  // 没有自映射条目的真名会静默落 fallback，逼着配置里躺一堆 glm-5 -> glm-5
  // 的自映射。别名表现在只承担「真正的改名映射」（如 auto-l0 简写）。
  if (cfg.upstream_models.includes(base)) return base;
  return cfg.aliases[base] || cfg.fallback;
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
// 显示名 = **真实后端名**（X-Dumate-Gw-Realmodel 实测）+ 档位限定词。
// cc-switch 等客户端的模型列表读 `name` 显示——之前给的是内部 key，用户看不出
// 是哪个模型；现在直接显示实跑模型。model-text 与 L0 实跑同一个后端，
// 靠限定词区分（名字完全相同的话客户端列表里分不清谁是谁）。
// 注意：真实后端串保持 X-Dumate-Gw-Realmodel 的原样小写（忠实于上游回传）。
const MODEL_NAMES = {
  'model-text': 'deepseek-v4.1-flash-low-latency（上游默认档）',
  'model-artifact-validate': 'model-artifact-validate（制品校验，后端未实测）',
  'glm-5': 'glm-5.2',
  'dm-auto-model/text.L0': 'deepseek-v4.1-flash-low-latency（自动档 L0）',
  'dm-auto-model/text.L1': 'kimi-k3（自动档 L1）',
  'dm-auto-model/text.L2': 'qwen3.8-max（自动档 L2）',
  // mm 命名空间（2026-10-31 实测：视觉由文本后端直接承担）
  'model-mm': 'deepseek-v4.1-flash-low-latency（视觉）',
  'dm-auto-model/mm.L0': 'deepseek-v4.1-flash-low-latency（视觉 L0）',
  'dm-auto-model/mm.L2': 'qwen3.8-max（视觉 L2）',
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
  CLAUDE_ROUTES,
  resolveClaudeRoute,
  normalizeIncomingModel,
  filePath,
  load,
  save,
  reset,
  mapModel,
};
