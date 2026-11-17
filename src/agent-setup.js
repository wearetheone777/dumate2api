// src/agent-setup.js - 智能体一键配置：直写 Claude Code / Codex CLI 的本机配置
//
// 融合自 qoder2api-hub「看板智能体配置：31 个客户端，13 类自动配置与还原」
// （2026-11-07 调研 P0-2）。本仓库此前只有 cc-switch 一条写入路径（ccswitch.js
// 直写它的 SQLite），但 Claude Code（~/.claude/settings.json）与 Codex CLI
// （~/.codex/config.toml）是本机文件，管理端进程就在这台机器上——直接写、
// **写前自动备份、一键还原**，比生成文本让用户手贴可靠。
//
// 三条纪律：
//   1. **先备份后写入**——首次 apply（以及每次 apply 前的当前态）都落快照，
//      restore 取最近一份备份原样写回。备份与索引都在 data/agent-setup/ 下，
//      绝不碰用户配置目录以外的文件。
//   2. **只动自己管理的键**——settings.json 是深合并（只 upsert env 里我们的
//      键，其他键原样保留）；config.toml 只移除「我们写入过的」托管键与
//      托管 provider 表，用户自己的配置不重排。
//   3. **不回显密钥**——apply 接受 token，响应与 detect 一律脱敏；token 为空时
//      用 'nokey' 占位（与 ccswitch.js 同一口径：网关鉴权强制后写真实 key）。
//
// cc-switch 不在这里写：它已有专门的 deep-link / 直写库端点（ccswitch.js），
// 本模块的 /clients 只报它的安装状态并指路，避免两个模块各管一套写入逻辑。
const fs = require('fs');
const path = require('path');
const os = require('os');

const ccswitch = require('./admin/routes/ccswitch');
const channels = require('./channels');

/** 备份与索引的落盘根（data/agent-setup/）。DI 用，测试指到临时目录 */
function backupRoot() {
  return process.env.DUMATE_AGENT_SETUP_DIR
    || path.join(__dirname, '..', 'data', 'agent-setup');
}

/** 网关根地址（与 cc-switch 同一判定：管理端看的是同一个实例） */
function gatewayBase() { return ccswitch.gatewayBase(); }

// ==================== 客户端清单与探测 ====================

function claudeSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}
function codexConfigPath() {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

/**
 * 探测一个客户端的当前状态。
 * @returns {{id,name,configPath,configExists,configured,detail}}
 */
function detect(clientId, opts = {}) {
  const read = opts.read || ((p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } });
  const base = gatewayBase();
  if (clientId === 'claude-code') {
    const p = claudeSettingsPath();
    const raw = read(p);
    let configured = false;
    let baseUrl = '';
    if (raw) {
      try {
        const j = JSON.parse(raw);
        baseUrl = String((j.env && j.env.ANTHROPIC_BASE_URL) || '');
        configured = baseUrl === base;
      } catch (e) { /* 解析不了按未配置报，apply 时会如实失败 */ }
    }
    return {
      id: clientId, name: 'Claude Code', configPath: p,
      configExists: raw != null, configured, baseUrl,
      detail: configured ? '已指向本网关' : (baseUrl ? `指向 ${baseUrl}（非本网关，apply 会覆盖）` : '未配置'),
    };
  }
  if (clientId === 'codex') {
    const p = codexConfigPath();
    const raw = read(p);
    const m = raw ? raw.match(/^\[model_providers\.(dumate2api-[a-z]+)\]$/m) : null;
    return {
      id: clientId, name: 'Codex CLI', configPath: p,
      configExists: raw != null, configured: !!m,
      detail: m ? `已配置 provider ${m[1]}` : (raw ? 'config.toml 存在但没有本网关的 provider' : '未配置'),
    };
  }
  if (clientId === 'cc-switch') {
    // 安装判据与 ccswitch.js 同一文件（单一来源）：库在 = 装过
    const db = path.join(process.env.USERPROFILE || '', '.cc-switch', 'cc-switch.db');
    return {
      id: clientId, name: 'cc-switch', configPath: db,
      configExists: fs.existsSync(db), configured: false,
      detail: '写入走管理端「cc-switch」专用端点（deep link / 直写库），这里只报状态',
    };
  }
  return null;
}

function listClients(opts = {}) {
  return ['claude-code', 'codex', 'cc-switch']
    .map((id) => detect(id, opts))
    .filter(Boolean);
}

// ==================== 备份 / 索引 ====================

function readIndex(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8')); }
  catch (e) { return {}; }
}
function writeIndex(root, idx) {
  fs.mkdirSync(root, { recursive: true });
  const tmp = path.join(root, 'index.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), 'utf8');
  fs.renameSync(tmp, path.join(root, 'index.json'));
}

/**
 * 备份一个配置文件到 data/agent-setup/<client>/。
 * 文件不存在时不备份（restore 没有可回退的对象，apply 从零创建也无需回退
 * ——删除配置文件等于还原「未配置」态，由 restore 的 no_backup 语义覆盖）。
 * io 与 apply/restore 同一份注入（测试里存在性/内容也要走注入，否则会把
 * 真机的 ~/.claude 备份进临时目录，测试结果随真机状态漂移）。
 * @returns {{file:string,at:number}|null}
 */
function backupConfig(clientId, configPath, root = backupRoot(), io = {}) {
  const existsF = io.exists || ((f) => fs.existsSync(f));
  const readF = io.read || ((f) => fs.readFileSync(f, 'utf8'));
  if (!existsF(configPath)) return null;
  const dir = path.join(root, clientId);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // 同一毫秒内的多次备份会撞名并互相覆盖（实测连续 apply 12 次只剩 8 份）。
  // 撞名时追加序号，保证每次备份都有独立文件、索引与目录始终一致。
  const base = path.basename(configPath);
  let file = path.join(dir, `${stamp}-${base}`);
  for (let i = 2; fs.existsSync(file); i += 1) {
    file = path.join(dir, `${stamp}-${i}-${base}`);
  }
  fs.writeFileSync(file, readF(configPath), 'utf8');
  const entry = { file, at: Date.now(), size: fs.statSync(file).size };
  const idx = readIndex(root);
  const cell = idx[clientId] || (idx[clientId] = { configPath, backups: [] });
  cell.configPath = configPath;
  cell.backups.unshift(entry);
  // 索引只留最近 10 份的指针；旧文件本体也删掉——备份目录无界增长
  // 迟早吃满盘，而 10 份对「回退最近一次误操作」绰绰有余
  cell.backups = cell.backups.slice(0, 10);
  writeIndex(root, idx);
  // 删除超出 10 份的旧备份文件（指针已裁掉，按目录扫描兜底）
  const keep = new Set(cell.backups.map((b) => b.file));
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (!keep.has(full)) { try { fs.unlinkSync(full); } catch (e) { /* 竞态跳过 */ } }
  }
  return entry;
}

function latestBackup(clientId, root = backupRoot()) {
  const cell = readIndex(root)[clientId];
  return cell && cell.backups && cell.backups[0] ? cell.backups[0] : null;
}

// ==================== Claude Code：settings.json 深合并 ====================

/**
 * 纯函数：env 深合并。只 upsert 我们的键，用户 settings.json 里的其他键
 * （permissions、hooks、model…）原样保留——覆盖整个文件等于把用户的
 * 权限配置一起抹掉，那是事故。
 */
function mergeClaudeSettings(existingRaw, envPatch) {
  let out = {};
  if (existingRaw && existingRaw.trim()) {
    const j = JSON.parse(existingRaw); // 解析失败向上抛，调用方转 400/500
    if (j && typeof j === 'object' && !Array.isArray(j)) out = { ...j };
  }
  out.env = { ...(out.env && typeof out.env === 'object' && !Array.isArray(out.env) ? out.env : {}), ...envPatch };
  return JSON.stringify(out, null, 2) + '\n';
}

// ==================== Codex：config.toml 托管键合并 ====================

/** 我们写入的顶层键（re-apply 时先移除旧值再插入新值，保证幂等） */
const CODEX_MANAGED_KEY_RE = [
  /^model_provider\s*=/,
  /^model_context_window\s*=/,
  /^model_auto_compact_token_limit\s*=/,
  /^model\s*=/, // 顶层 model 也是我们要接管的（默认模型 = 档位模型）
  /^# 显式覆盖 codex 全局的 model_context_window/,
];
const CODEX_PROVIDER_HEADER_RE = /^\[model_providers\.dumate2api-/;

/**
 * 纯函数：把托管片段合并进 config.toml 文本。
 *
 * 规则（TOML 语义敏感，别「优化」掉任何一条）：
 *   - 顶层键只能出现在**第一个表头之前**——追加到文件尾时如果后面已有
 *     其他表，键会掉进那张表里，Codex 读不到还报奇怪的表缺失。
 *     所以顶层键固定插在首个表头之前（没有表头就插到文件头）。
 *   - 旧托管顶层键只在「首个表头之前」的区域移除——`model =` 是常见键，
 *     用户的 [profiles.x] 表里也可能有，动了那是事故。
 *   - 托管 provider 表（[model_providers.dumate2api-*]）整块移除后追加到
 *     文件尾；只认我们自己的表头，用户的 provider 不碰。
 *
 * @param {string} existingRaw 现有 config.toml（可为空串）
 * @param {{topLines:string[], providerLines:string[]}} snippet
 * @returns {string}
 */
function mergeCodexToml(existingRaw, snippet) {
  const src = String(existingRaw || '');
  const lines = src ? src.replace(/\r\n/g, '\n').split('\n') : [];
  const firstHeader = lines.findIndex((l) => /^\[/.test(l.trim()));
  const topEnd = firstHeader === -1 ? lines.length : firstHeader;

  const head = lines.slice(0, topEnd).filter((l) => !CODEX_MANAGED_KEY_RE.some((re) => re.test(l.trim())));
  const rest = lines.slice(topEnd);

  // 移除旧的托管 provider 表（从我们的表头到下一个任意表头之前）
  const cleaned = [];
  let dropping = false;
  for (const l of rest) {
    if (CODEX_PROVIDER_HEADER_RE.test(l.trim())) { dropping = true; continue; }
    if (dropping && /^\[/.test(l.trim())) dropping = false;
    if (!dropping) cleaned.push(l);
  }

  const out = [...head, ...snippet.topLines, ...cleaned, ...snippet.providerLines];
  let text = out.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  return text;
}

/**
 * 组装 Codex 托管片段（与 ccswitch.buildCodexConfig 同一份内容，
 * 拆成顶层键与 provider 表两段以便按上述规则插入）。
 */
function codexSnippet(channel, tiers, d, token, base) {
  const full = ccswitch.buildCodexConfig(channel, tiers, d, token, base).split('\n');
  const providerIdx = full.findIndex((l) => l.startsWith('[model_providers.'));
  return {
    topLines: full.slice(0, providerIdx),
    providerLines: full.slice(providerIdx),
  };
}

// ==================== apply / restore ====================

/**
 * 推导档位与上下文（与 cc-switch /apply 完全同一套推导，保证两边配置一致）。
 * @returns {{tiers, derived}} 直接可喂 buildClaudeEnv / codexSnippet
 */
async function deriveTiers(channel, wantIds) {
  const mi = require('./model-info');
  let rows;
  let accountNote = '';
  if (channel === 'qoder') {
    // Qoder 模型表**按账号不同**（ccswitch.js 有实测结论），取可用账号并集
    // ——导出复用同一实现，与 cc-switch /apply 的档位推导保持一致
    const m = await ccswitch.qoderRowsMerged();
    rows = m.rows;
    accountNote = `Qoder 取 ${m.accounts.length} 个可用账号的模型并集（${m.accounts.join('、')}）`;
  } else {
    const r = await mi.rowsFor(channel, { visibleOnly: true });
    rows = (r.rows || []).filter((x) => x.id);
  }
  if (!rows.length) throw new Error(`${channel} 没有可用模型`);
  const tiers = ccswitch.pickTiers(rows, wantIds);
  return { tiers, derived: ccswitch.derive(tiers), accountNote };
}

/**
 * 把配置直写进客户端文件。
 * @param {object} p
 * @param {'claude-code'|'codex'} p.client
 * @param {string} [p.channel] 默认 dumate
 * @param {string} [p.token] API key；空 → 'nokey'
 * @param {string[]} [p.models] 显式档位模型（prefixed）
 * @param {string} [p.baseUrl] 覆盖网关地址（默认 gatewayBase()）
 * @param {object} [p.io] 测试注入 {read,write,exists,homedir}
 */
// ==================== 写入前的差异预览（调研 P2-10）====================
//
// 为什么要有：这套东西**直接改用户本机的配置文件**（~/.claude/settings.json、
// ~/.codex/config.toml）。有备份与还原，但「点写入之前看不到会变成什么样」——
// 合并规则（深合并 / 受管块替换）对用户是不透明的，改错了只能靠还原兜。
//
// 三条纪律：
//   1. **预览与写入必须同一份计算**（`buildNext`）。两份实现必然漂移，而漂移的
//      表现是「预览说没问题、写进去不是那样」——比没有预览更坏。
//   2. 预览**不碰磁盘**：不写配置、不建备份、不更新索引（备份是写入的副作用）。
//   3. 预览里**密钥打码**：diff 会原样包含 token 行，回显明文等于把密钥送进
//      浏览器历史与日志。打码只影响展示，真写入用的仍是调用方给的 token。

/** 行级 diff 的行数上限：超过就只报「变了」而不列明细（配置文件的 100 倍有余） */
const DIFF_MAX_LINES = 1200;

function splitLines(text) {
  const s = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  if (!s) return [];
  const lines = s.split('\n');
  // 末尾换行制造的空串不算一行（否则每份文件都会多一条「假的删除」）
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 行级 diff（LCS）。返回 `{changed, truncated, added, removed, ops}`，
 * `ops` 里每项是 `{t:' '|'-'|'+', a, b, text}`（a/b 是两侧行号，缺侧为 null）。
 *
 * 没有引第三方 diff 库：配置文件的量级（几 KB）用不着 Myers，LCS 的 DP 足够，
 * 且**不引依赖**本身有价（这个仓库的离线测试全靠零依赖）。
 */
function diffLines(before, after, opts = {}) {
  const cap = Math.max(1, Number(opts.maxLines) || DIFF_MAX_LINES);
  const A = splitLines(before);
  const B = splitLines(after);
  const out = { changed: A.join('\n') !== B.join('\n'), truncated: false, added: 0, removed: 0, ops: [] };
  if (!out.changed) return out;
  if (A.length > cap || B.length > cap) {
    out.truncated = true;
    out.added = B.length;
    out.removed = A.length;
    return out;
  }
  // LCS 长度表（arr[i][j] = A[i..] 与 B[j..] 的最长公共子序列长度）
  const n = A.length;
  const m = B.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = A[i] === B[j]
        ? dp[(i + 1) * w + (j + 1)] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.ops.push({ t: ' ', a: i + 1, b: j + 1, text: A[i] });
      i++; j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      out.ops.push({ t: '-', a: i + 1, b: null, text: A[i] });
      out.removed++; i++;
    } else {
      out.ops.push({ t: '+', a: null, b: j + 1, text: B[j] });
      out.added++; j++;
    }
  }
  for (; i < n; i++) { out.ops.push({ t: '-', a: i + 1, b: null, text: A[i] }); out.removed++; }
  for (; j < m; j++) { out.ops.push({ t: '+', a: null, b: j + 1, text: B[j] }); out.added++; }
  return out;
}

/** 把密钥打码成 `••••后四位`；短值整段打码（后四位等于泄露一半） */
function maskSecret(text, secret) {
  const s = String(secret || '').trim();
  if (!s) return String(text || '');
  const shown = s.length >= 12 ? `••••${s.slice(-4)}` : '••••';
  return String(text || '').split(s).join(shown);
}

/**
 * 算出「要写什么」，**不落盘**。`apply` 与 `preview` 共用这一份——
 * 两份实现必然漂移，而漂移的表现是「预览说没问题、写进去不是那样」。
 */
async function buildNext(p = {}) {
  const io = p.io || {};
  const readF = io.read || ((f) => fs.readFileSync(f, 'utf8'));
  const existsF = io.exists || ((f) => fs.existsSync(f));

  const client = p.client;
  if (client !== 'claude-code' && client !== 'codex') {
    throw new Error(`client 只支持 claude-code / codex（cc-switch 走专用端点），收到 ${client}`);
  }
  const channel = channels.normalize(p.channel || 'dumate') || 'dumate';
  const token = String(p.token || '').trim();
  const base = String(p.baseUrl || '').trim() || gatewayBase();
  const { tiers, derived, accountNote } = await deriveTiers(channel, Array.isArray(p.models) ? p.models.map(String) : []);

  const configPath = client === 'claude-code' ? claudeSettingsPath() : codexConfigPath();
  const exists = existsF(configPath);
  const existing = exists ? readF(configPath) : '';

  let next;
  if (client === 'claude-code') {
    const env = ccswitch.buildClaudeEnv(channel, tiers, derived, token, base);
    next = mergeClaudeSettings(existing, env);
  } else {
    next = mergeCodexToml(existing, codexSnippet(channel, tiers, derived, token, base));
  }
  return { client, channel, token, base, tiers, derived, accountNote, configPath, exists, existing, next };
}

/** 预览的说明文案与 apply 同源（一句话说清「这次会改成什么」） */
function explain(client) {
  return client === 'codex'
    ? '将写入 ~/.codex/config.toml 的受管块（含内联 bearer token）；Codex 重启后生效'
    : '将把 env 深合并进 ~/.claude/settings.json（其它键原样保留）；Claude Code 重启后生效';
}

/**
 * 写入前预览：返回**将写入的差异**，不改任何文件。
 * @returns {object} 与 apply 同形的元数据 + {exists, changed, stats, ops, truncated}
 */
async function preview(p = {}) {
  const b = await buildNext(p);
  const d = diffLines(b.existing, b.next);
  const mask = (t) => maskSecret(t, b.token);
  return {
    ok: true,
    client: b.client,
    configPath: b.configPath,
    exists: b.exists,
    changed: d.changed,
    truncated: d.truncated,
    stats: { added: d.added, removed: d.removed, lines: splitLines(b.next).length },
    // 密钥打码后再出门：diff 会包含 token 行，明文回显等于把 key 送进浏览器历史
    ops: d.ops.map((op) => ({ ...op, text: mask(op.text) })),
    channel: b.channel,
    gateway: b.base,
    model: b.tiers[0] ? b.tiers[0].prefixed : '',
    derived: b.derived,
    ...(b.accountNote ? { accountNote: b.accountNote } : {}),
    note: d.changed ? explain(b.client) : '当前文件已经就是这个内容（幂等，写入不会改动任何字节）',
  };
}

async function apply(p) {
  const io = p.io || {};
  const writeF = io.write || ((f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c, 'utf8'); });
  const root = p.root || backupRoot();

  // 要写什么只算一次（`buildNext` 同时被 preview 用），然后才备份+落盘
  const b = await buildNext(p);
  const { client, channel, configPath, next, tiers, derived, accountNote, base } = b;

  // 先备份当前态（文件不存在就不备份——「未配置」没有可回退对象）
  const backup = backupConfig(client, configPath, root, io);
  writeF(configPath, next);

  const idx = readIndex(root);
  const cell = idx[client] || (idx[client] = { configPath, backups: [] });
  cell.configPath = configPath;
  cell.lastApply = { at: Date.now(), channel, gateway: base };
  writeIndex(root, idx);

  return {
    ok: true,
    client,
    configPath,
    backup: backup ? backup.file : '',
    channel,
    gateway: base,
    model: tiers[0] ? tiers[0].prefixed : '',
    derived,
    ...(accountNote ? { accountNote } : {}),
    note: client === 'codex'
      ? 'config.toml 已写入（experimental_bearer_token 内联鉴权，不需要环境变量）；Codex 重启后生效'
      : 'settings.json 的 env 已合并（其他键原样保留）；Claude Code 重启后生效',
  };
}

/**
 * 还原：把最近一份备份原样写回配置文件。
 * 写回前把当前态再备份一份（还原本身也可能是误操作）。
 */
function restore(p = {}) {
  const io = p.io || {};
  const readF = io.read || ((f) => fs.readFileSync(f, 'utf8'));
  const writeF = io.write || ((f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c, 'utf8'); });
  const existsF = io.exists || ((f) => fs.existsSync(f));
  const root = p.root || backupRoot();

  const client = p.client;
  const cell = readIndex(root)[client];
  const backup = cell && cell.backups && cell.backups[0];
  if (!backup || !existsF(backup.file)) {
    return { ok: false, error: `没有 ${client} 的可用备份（apply 过才有）` };
  }
  const configPath = cell.configPath;
  if (existsF(configPath)) backupConfig(client, configPath, root, io); // 当前态留档
  // 备份文件是 backupConfig 用真实 fs 落的盘，读它也用真实 fs——注入的 read
  // 是给「用户配置路径」的（测试的 io.read 是内容模拟器，不认备份路径）
  writeF(configPath, fs.readFileSync(backup.file, 'utf8'));
  return { ok: true, client, configPath, restoredFrom: backup.file, at: backup.at };
}

module.exports = {
  listClients, detect, apply, restore,
  preview, buildNext, diffLines, maskSecret, explain,
  mergeClaudeSettings, mergeCodexToml, codexSnippet, deriveTiers,
  backupConfig, latestBackup, backupRoot, gatewayBase,
  claudeSettingsPath, codexConfigPath,
  CODEX_MANAGED_KEY_RE, CODEX_PROVIDER_HEADER_RE,
};
