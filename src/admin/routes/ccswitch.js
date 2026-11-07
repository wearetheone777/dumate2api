// src/admin/routes/ccswitch.js - 一键生成 cc-switch 供应商配置
//
// ============================================================================
// 为什么需要它
//
// 往 cc-switch 里加一条通道要手填十来项，其中**上下文窗口与输出上限最容易
// 填错**，而且错了的后果很隐蔽：
//   - 填大了：客户端以为还能塞，到上游真实窗口才被拒 → 整轮 400
//     （实测 TRAE 声明 1M 而真实 256K，长会话一恢复就「6 连 400」）
//   - 填小了：白白浪费窗口（TRAE Doubao 256K 被声明成 52K 就是浪费 80%）
//
// 这两个数不能拍脑袋，本模块按下面的规则推导，并把**每个数的来源**一并
// 返回（upstream 上游下发 / measured 本项目实测 / config 本地配置），
// 界面直接展示依据，而不是丢一个数字出来。
//
// ## 规则：取「所选档位模型」的最小值，不取全部模型的最小值
//
// 为什么不能取全部：TRAE 通道上游下发 42 个模型，最小的只有 53192。
// 按它声明等于把 Doubao 的 256K 浪费掉 80%。
// 为什么不能取最大：同一份 provider 配置对该通道**所有**可选模型生效，
// 声明高于任何一个小窗口模型，切过去就 400。
// 所以只取「用户实际会用的那几个档位模型」的最小值——与
// fix_traework_context.py 同一口径（Doubao 256K / DeepSeek 200K → 200000）。
//
// 档位模型默认取「倍率最低的 4 个」（便宜的通常就是日常主力），
// 也可以由调用方用 `models=` 显式指定，界面据此让用户自己勾。
// ============================================================================
const mi = require('../../model-info');
const channels = require('../../channels');
const { sendJSON } = require('../router');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// cc-switch 是 Tauri 单 exe：没有 CLI、没有本地 API，唯一的接口是它的
// SQLite 库。Node 侧零依赖（没有 better-sqlite3），所以写库借系统的 python3
// ——与用户项目里既有的 fix_*.py 是同一套做法。
const WRITER = path.resolve(__dirname, '..', '..', '..', 'tools', 'ccswitch-writer.py');

// 「装没装 cc-switch」的唯一可靠判据是**它的库在不在**——要写它就得先有它。
// 进程只能说明「此刻在跑」，说明不了装过（刚装完还没启动也是装了）。
const CCSWITCH_DB = path.join(process.env.USERPROFILE || '', '.cc-switch', 'cc-switch.db');
// exe 探测：进程路径最准 → 显式环境变量 → 常见安装位置
const EXE_CANDIDATES = [
  'D:\\Program Files\\toolsProgram\\cc switch\\cc-switch.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cc-switch', 'cc-switch.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'cc-switch', 'cc-switch.exe'),
  path.join(process.env.PROGRAMFILES || '', 'cc-switch', 'cc-switch.exe'),
];

// cc-switch 的 claude 供应商支持四个档位；缺档位时用 ANTHROPIC_MODEL 兜底
const TIER_NAMES = ['OPUS', 'SONNET', 'HAIKU', 'FABLE'];
const DEFAULT_TIER_COUNT = 4;

/** 客户端该连哪个网关：与管理端看的是同一个实例 */
function gatewayBase() {
  const port = process.env.DUMATE_ADMIN_GATEWAY_PORT || process.env.DUMATE2API_PORT || '9080';
  return `http://127.0.0.1:${port}`;
}

/** 该通道的档位模型：有倍率的按倍率升序取前 N，没有的取列表前 N */
function pickTiers(rows, wantIds) {
  if (Array.isArray(wantIds) && wantIds.length) {
    const byId = new Map();
    for (const m of rows) {
      byId.set(String(m.id), m);
      if (m.prefixed) byId.set(String(m.prefixed), m);
    }
    return wantIds.map((id) => byId.get(String(id))).filter(Boolean);
  }
  const withRate = rows.filter((m) => typeof m.rate === 'number');
  const pool = withRate.length ? [...withRate].sort((a, b) => a.rate - b.rate) : [...rows];
  return pool.slice(0, DEFAULT_TIER_COUNT);
}

/**
 * 推导上下文窗口与输出上限：**取所选模型的最小值**。
 * 同时报出是哪个模型决定了这个最小值（界面要显示依据，不能只说结论）。
 *
 * 上下文有个额外规则：**模型带「实测区间」时取下界**。
 * 搭子的 model-info 给的是 `contextWindowMin=32768 / contextWindow=192000`
 * 并注明「配置声明 192K；32K 级实测通过，128K 级 10 分钟未返回」。
 * 超限在上游是**整轮失败**（不是截断），所以声明宁可小——取 192K 会让
 * 客户端放心塞满，然后撞上那个「10 分钟不返回」的区间。
 */
function ctxOf(m) {
  const min = m.contextWindowMin;
  const max = m.contextWindow;
  if (typeof min === 'number' && min > 0 && typeof max === 'number' && min < max) {
    return { value: min, note: `实测区间 ${min}~${max}，取保守下界`, ranged: true };
  }
  return { value: typeof max === 'number' ? max : null, note: '', ranged: false };
}

function derive(models) {
  const ctxs = models.map((m) => ({ m, c: ctxOf(m) })).filter((x) => typeof x.c.value === 'number');
  const outs = models.filter((m) => typeof m.maxTokens === 'number');

  let ctxOwner = null;
  let minCtx = null;
  for (const x of ctxs) {
    if (minCtx === null || x.c.value < minCtx) { minCtx = x.c.value; ctxOwner = x; }
  }
  const minOut = outs.length ? Math.min(...outs.map((m) => m.maxTokens)) : null;
  const outOwner = outs.find((m) => m.maxTokens === minOut) || null;

  const notes = [];
  if (ctxOwner && ctxOwner.c.note) notes.push(`${ctxOwner.m.id}：${ctxOwner.c.note}`);
  if (ctxOwner && ctxOwner.c.ranged) notes.push('该通道上下文来自实测区间而非上游下发，切模型前请先确认');

  return {
    context_window: minCtx,
    context_source: ctxOwner ? (ctxOwner.m.contextSource || '') : '',
    context_owner: ctxOwner ? ctxOwner.m.id : '',
    context_note: ctxOwner ? ctxOwner.c.note : '',
    compact_limit: minCtx ? Math.round(minCtx * 0.85) : null,
    max_output: minOut,
    max_output_source: outOwner ? (outOwner.maxTokensSource || '') : '',
    max_output_owner: outOwner ? outOwner.id : '',
    rule: '上下文 = 所选模型的最小值（带实测区间时取下界，因为超限是整轮失败而不是截断）；压缩线 = 上下文的 85%；输出上限 = 所选模型的最小值',
    notes,
  };
}

/** Claude Code（Anthropic 协议）的 env 片段 */
function buildClaudeEnv(channel, tiers, d, token, base) {
  const env = {
    ANTHROPIC_BASE_URL: base,
    // 网关默认不校验 key（DUMATE_REQUIRE_KEY 未设），所以默认写 nokey；
    // 开了鉴权就把真实 token 填进来
    ANTHROPIC_AUTH_TOKEN: token || 'nokey',
    ANTHROPIC_API_KEY: token || 'nokey',
    ANTHROPIC_MODEL: tiers[0] ? tiers[0].prefixed : '',
  };
  tiers.forEach((m, i) => {
    const tier = TIER_NAMES[i];
    if (!tier) return;
    env[`ANTHROPIC_DEFAULT_${tier}_MODEL`] = m.prefixed;
    env[`ANTHROPIC_DEFAULT_${tier}_MODEL_NAME`] = m.name || m.id;
  });
  if (d.context_window) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(d.context_window);
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(d.compact_limit);
  }
  return env;
}

/**
 * Codex（Responses 协议）的 config.toml 片段。
 * 顶层两行是关键：codex 的全局 common_config 会注入 1M，必须在 provider
 * config 里显式覆盖，否则长会话必挂。
 */
function buildCodexConfig(channel, tiers, d, token, base) {
  const providerId = `dumate2api-${channel}`;
  const lines = [
    `model_provider = "${providerId}"`,
    `model = "${tiers[0] ? tiers[0].prefixed : ''}"`,
    '# 显式覆盖 codex 全局的 model_context_window（那是给 1M 模型设的）',
    `model_context_window = ${d.context_window || 0}`,
    `model_auto_compact_token_limit = ${d.compact_limit || 0}`,
    '',
    `[model_providers.${providerId}]`,
    `name = "${channels.label(channel)} (dumate2api)"`,
    `base_url = "${base}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    `experimental_bearer_token = "${token || 'nokey'}"`,
  ];
  return lines.join('\n');
}

/** Codex 的模型目录：cc-switch 用它渲染模型列表，每个模型带自己的窗口 */
function buildCodexCatalog(tiers) {
  return tiers.map((m) => ({
    model: m.prefixed,
    displayName: m.name || m.id,
    contextWindow: m.contextWindow || null,
    maxContextWindow: m.contextWindow || null,
    // codex 到「窗口的 85%」触发压缩，与顶层 compact_limit 同一口径
    effectiveContextWindowPercent: 85,
  }));
}

/**
 * Qoder 的模型表**按账号不同**（实测：preferred 账号只返回 2 个模型，
 * 另一个账号返回 14 个含 GLM-5.2 / Kimi-K3）。网关请求时按
 * preferred → 失败换号 自动选号，所以客户端**能配的是并集**——
 * 配了 kmodel_latest 时 preferred 账号若不支持，上游报错后网关会换号。
 * 这里合并并集并标注来源账号，避免用户误以为「只有 2 个模型可用」。
 */
async function qoderRowsMerged() {
  const authStore = require('../../qoder/auth');
  const session = require('../../qoder/session');
  const budget = require('../../budget');
  const accounts = authStore.findUsable();
  const merged = new Map();
  const accountNames = [];
  for (const acc of accounts) {
    const name = acc.nickname || acc.uid || `账号 ${acc.id}`;
    accountNames.push(name);
    let r;
    try { r = await session.fetchModels(acc); } catch (e) { continue; }
    for (const m of (r.models || [])) {
      if (!merged.has(m.key)) {
        merged.set(m.key, {
          id: m.key,
          prefixed: m.prefixed || `qoder/${m.key}`,
          name: m.name || m.key,
          rate: typeof m.rate === 'number' ? m.rate : null,
          contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
          contextWindowMin: null,
          contextSource: m.contextWindow ? 'upstream' : '',
          // Qoder 上游不给输出上限，用本地预算配置（与模型管理页同一口径）
          maxTokens: budget.resolveQoderMaxTokens(0),
          maxTokensSource: 'config',
          accounts: [],
        });
      }
      merged.get(m.key).accounts.push(name);
    }
  }
  return { rows: [...merged.values()], accounts: accountNames };
}

/** PowerShell 一次性执行（discovery.js 已有同样做法，异步避免阻塞事件循环） */
function ps(script, timeout = 15000) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout, windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout || '').trim()));
  });
}

/**
 * cc-switch 的安装 / 运行状态。三件事分开报，因为处置不同：
 *
 *   installed  库不存在 → 写无可写，直接提示用户先装并至少启动一次
 *   running    在运行 → **不需要关它**。实测：库里没有 -wal/-shm（说明它不持有
 *              长连接），写入后 10 秒 mtime 不变、记录仍在——它运行中不主动
 *              写库，所以直接写是安全的。但它只在启动时读库，新记录要重启
 *              才会出现在它的列表里。
 *   exe        没在运行时用它把 cc-switch 拉起来，让用户马上看到新供应商。
 */
async function ccSwitchState() {
  const installed = fs.existsSync(CCSWITCH_DB);
  const out = await ps('$p = Get-Process cc-switch -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { "$($p.Id)|$($p.Path)" }');
  let running = false;
  let pid = 0;
  let exe = '';
  if (out) {
    const i = out.indexOf('|');
    running = true;
    pid = Number(out.slice(0, i)) || 0;
    exe = i >= 0 ? out.slice(i + 1).trim() : '';
  }
  if (!exe) {
    const envPath = process.env.DUMATE_CCSWITCH_PATH || '';
    exe = (envPath && fs.existsSync(envPath))
      ? envPath
      : (EXE_CANDIDATES.find((p) => p && fs.existsSync(p)) || '');
  }
  return { installed, running, pid, exe, db: CCSWITCH_DB };
}

/** 调 python writer 写 cc-switch 的库 */
function writeProvider(spec) {
  return new Promise((resolve) => {
    execFile('python', [WRITER, JSON.stringify({ action: 'upsert', provider: spec })],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const hint = /ENOENT/.test(String(err.message))
            ? '（系统里没有 python，无法写 cc-switch 的库）' : '';
          return resolve({ ok: false, error: `${err.message}${hint} ${String(stderr || '').slice(0, 200)}` });
        }
        const line = String(stdout || '').trim().split('\n').filter(Boolean).pop() || '';
        try { resolve(JSON.parse(line)); }
        catch (e) { resolve({ ok: false, error: `writer 输出无法解析: ${line.slice(0, 200)}` }); }
      });
  });
}

/** 组装要写进 cc-switch 的 provider 记录（/apply 直写 SQLite 用） */
function buildProviderSpec(channel, app, tiers, d, token, base) {
  const id = `dumate2api-${channel}-${app}`;
  const main = tiers[0] ? (tiers[0].name || tiers[0].id) : channels.label(channel);
  const name = `${channels.label(channel)} · ${main} (dumate2api)`;
  const notes = `由 dumate2api 管理端生成｜${tiers.length} 个档位｜上下文 ${d.context_window ?? '?'}（${d.context_source || '-'}）｜输出 ${d.max_output ?? '?'}`;
  if (app === 'codex') {
    return {
      id,
      app_type: 'codex',
      name,
      notes,
      settings_config: {
        auth: { OPENAI_API_KEY: token || 'nokey' },
        config: buildCodexConfig(channel, tiers, d, token, base),
        modelCatalog: { models: buildCodexCatalog(tiers) },
      },
    };
  }
  return {
    id,
    app_type: 'claude',
    name,
    notes,
    settings_config: { env: buildClaudeEnv(channel, tiers, d, token, base) },
  };
}

// ============================================================================
// cc-switch 官方 deep link（ccswitch://v1/import?resource=provider&…）
//
// 为什么用它而不是直写库：点击链接会**唤起 cc-switch 并弹出它自己的
// 「确认导入」对话框**（DeepLinkImportDialog），把应用/名称/endpoint/
// 脱敏 key/模型/逐行 env（含完整 TOML）全部预填展示，**用户不点「导入」
// 什么都不写**。这把「加不加」的决定权交回 cc-switch，也不再需要
// python writer、备份、重启等一套直写库的副作用。
//
// config 参数走标准 Base64 + encodeURIComponent——cc-switch 的解码器对
// STANDARD / URL_SAFE（含无填充）四种都兼容并自动补 padding。
//
// ⚠ Codex 有 cc-switch 自身的限制（3.20.4 与 main 一致）：其 deep-link
//   导入器 build_codex_settings 用固定模板重建 config.toml，只吸收
//   name/model/endpoint/apiKey，**inline config 里的 model_context_window、
//   model_auto_compact_token_limit、modelCatalog 全部带不进去**。而上下文
//   覆盖正是这个功能存在的核心（挡 cc-switch 全局 common_config 的 1M）。
//   所以 codex 的 deeplink 只预填基础项，上下文两行需导入后手工补；
//   需要完整 codex 配置时仍可用 /apply 直写（它原样保留 TOML+catalog）。
//   Claude 路径的 inline env 则被 build_claude_settings 完整保留，无此问题。
// ============================================================================

/** provider 显示名（与直写库同一命名，便于用户认出） */
function providerName(channel, tiers) {
  const main = tiers[0] ? (tiers[0].name || tiers[0].id) : channels.label(channel);
  return `${channels.label(channel)} · ${main} (dumate2api)`;
}

/** 拼一个 query 参数（值已 URL 编码）；空值跳过 */
function qp(parts, key, value) {
  if (value === undefined || value === null || value === '') return;
  parts.push(`${key}=${encodeURIComponent(String(value))}`);
}

/**
 * 生成 cc-switch deep link。
 * @returns {{url:string, configJson:object|null, limitation:string|null}}
 */
function buildDeepLink(channel, app, tiers, d, token, base) {
  const name = providerName(channel, tiers);
  const parts = [];
  qp(parts, 'resource', 'provider');
  qp(parts, 'app', app);
  qp(parts, 'name', name);
  // cc-switch 校验 endpoint 必须是合法 http(s) URL；网关根地址即可
  qp(parts, 'endpoint', base);
  qp(parts, 'homepage', base);
  // apiKey 必填（cc-switch 对空串直接报错）；网关默认不鉴权就用占位
  qp(parts, 'apiKey', token || 'nokey');
  qp(parts, 'enabled', 'false');
  qp(parts, 'notes', `由 dumate2api 生成｜上下文 ${d.context_window ?? '?'}｜输出 ${d.max_output ?? '?'}`);

  let configJson = null;
  let limitation = null;

  if (app === 'claude') {
    // inline config 的 env 会被 cc-switch 完整保留（四档位 + 上下文 + 压缩线）
    configJson = { env: buildClaudeEnv(channel, tiers, d, token, base) };
    const t0 = tiers[0];
    if (t0) qp(parts, 'model', t0.prefixed);
    // 三个档位别名也用 URL 参数显式带一份（cc-switch 会在确认框里单独展示）
    if (tiers[1]) qp(parts, 'haikuModel', tiers[1].prefixed);
    if (tiers[2]) qp(parts, 'sonnetModel', tiers[2].prefixed);
    if (tiers[3]) qp(parts, 'opusModel', tiers[3].prefixed);
  } else {
    // codex：基础项靠 URL 参数即可；上下文/catalog 带不进（见上方说明）
    const t0 = tiers[0];
    if (t0) qp(parts, 'model', t0.prefixed);
    limitation =
      'cc-switch 的 deep-link 对 Codex 用固定模板重建 config.toml，'
      + '带不进 model_context_window / model_auto_compact_token_limit / modelCatalog；'
      + `链接已预填地址、Key、模型，但上下文窗口（${d.context_window ?? '?'}）与压缩线`
      + `（${d.compact_limit ?? '?'}）需导入后在 cc-switch 里手工补上，或改用「直接写入」。`;
  }

  if (configJson) {
    const b64 = Buffer.from(JSON.stringify(configJson), 'utf8').toString('base64');
    qp(parts, 'config', b64);
    qp(parts, 'configFormat', 'json');
  }

  return { url: `ccswitch://v1/import?${parts.join('&')}`, configJson, limitation };
}

const routes = [
  {
    method: 'GET',
    path: '/preview',
    handler: async ({ res, req }) => {
      const q = (req.url.match(/\?([^#]*)/) || [])[1] || '';
      const params = new URLSearchParams(q);
      const channel = channels.normalize(params.get('channel')) || 'dumate';
      const app = String(params.get('app') || 'claude').toLowerCase();
      const token = String(params.get('token') || '').trim();
      const want = String(params.get('models') || '').split(',').map((s) => s.trim()).filter(Boolean);

      let r;
      let accountNote = '';
      try {
        if (channel === 'qoder') {
          const m = await qoderRowsMerged();
          r = { rows: m.rows, error: '' };
          accountNote = `Qoder 的模型表按账号不同，这里是 ${m.accounts.length} 个可用账号的并集（${m.accounts.join('、')}），网关会自动选号`;
        } else {
          // visibleOnly：TRAE 上游把工具型/内部模型标成 visible=false
          // （browser_use_subagent、file_search_agent、explore_sub_agent_v2…），
          // 它们倍率最低，不过滤就会被优先选进档位——用户拿到的是
          // 「Opus 档 = 浏览器子代理」，而且上下文被拖到 160768。
          r = await mi.rowsFor(channel, { visibleOnly: true });
        }
      } catch (e) {
        return sendJSON(res, 502, { error: `读取 ${channel} 模型表失败: ${e.message}` });
      }
      const rows = (r.rows || []).filter((m) => m.id);
      if (!rows.length) return sendJSON(res, 404, { error: `${channel} 没有可用模型` });

      const tiers = pickTiers(rows, want);
      const d = derive(tiers);
      const base = gatewayBase();

      const warnings = [];
      if (!d.context_window) warnings.push('上游没给上下文窗口，无法推导——请手工确认后再保存');
      if (!d.max_output) warnings.push('上游没给输出上限，config.toml 未声明 max_output');
      if (d.context_source && d.context_source !== 'upstream') {
        warnings.push(`上下文来源是「${d.context_source === 'measured' ? '本项目实测' : '本地配置'}」，不是上游下发——切模型前先确认`);
      }
      for (const n of d.notes || []) warnings.push(n);
      if (accountNote) warnings.push(accountNote);

      const dl = buildDeepLink(channel, app, tiers, d, token, base);
      if (dl.limitation) warnings.push(dl.limitation);

      return sendJSON(res, 200, {
        ok: true,
        channel,
        channel_label: channels.label(channel),
        app,
        gateway: base,
        deeplink: dl.url,
        deeplink_limitation: dl.limitation,
        all_models: rows.map((m) => ({
          id: m.id,
          prefixed: m.prefixed,
          name: m.name || m.id,
          rate: m.rate ?? null,
          contextWindow: m.contextWindow ?? null,
          contextWindowMin: m.contextWindowMin ?? null,
          contextSource: m.contextSource || '',
          maxTokens: m.maxTokens ?? null,
          maxTokensSource: m.maxTokensSource || '',
          picked: tiers.some((t) => t.id === m.id),
        })),
        tiers: tiers.map((m, i) => ({
          tier: TIER_NAMES[i] || `TIER${i}`,
          id: m.id,
          prefixed: m.prefixed,
          name: m.name || m.id,
          rate: m.rate ?? null,
          contextWindow: m.contextWindow ?? null,
          contextWindowMin: m.contextWindowMin ?? null,
          contextSource: m.contextSource || '',
          maxTokens: m.maxTokens ?? null,
          maxTokensSource: m.maxTokensSource || '',
        })),
        derived: d,
        claude_env: buildClaudeEnv(channel, tiers, d, token, base),
        codex_config: buildCodexConfig(channel, tiers, d, token, base),
        codex_catalog: buildCodexCatalog(tiers),
        warnings,
      });
    },
  },
  {
    // 直接把配置写进 cc-switch（不是生成文本让用户粘）
    method: 'POST',
    path: '/apply',
    handler: async ({ res, body }) => {
      const b = body || {};
      const channel = channels.normalize(b.channel) || 'dumate';
      const app = String(b.app || 'claude').toLowerCase() === 'codex' ? 'codex' : 'claude';
      const token = String(b.token || '').trim();
      const want = Array.isArray(b.models) ? b.models.map(String) : [];

      // 1) 与 preview 同一套推导
      let rows;
      let accountNote = '';
      try {
        if (channel === 'qoder') {
          const m = await qoderRowsMerged();
          rows = m.rows;
          accountNote = `${m.accounts.length} 个账号的并集（${m.accounts.join('、')}）`;
        } else {
          const r = await mi.rowsFor(channel, { visibleOnly: true });
          rows = (r.rows || []).filter((x) => x.id);
        }
      } catch (e) {
        return sendJSON(res, 502, { ok: false, error: `读取 ${channel} 模型表失败: ${e.message}` });
      }
      if (!rows || !rows.length) return sendJSON(res, 404, { ok: false, error: `${channel} 没有可用模型` });

      const tiers = pickTiers(rows, want);
      const d = derive(tiers);
      const base = gatewayBase();
      const spec = buildProviderSpec(channel, app, tiers, d, token, base);

      // 2) 先判装没装——库不存在就无从写起（进程只能说明此刻在跑）
      const st = await ccSwitchState();
      if (!st.installed) {
        return sendJSON(res, 200, {
          ok: false,
          installed: false,
          error: `未检测到 cc-switch（找不到 ${st.db}）。请先安装并至少启动一次 cc-switch，再回来添加。`,
        });
      }

      // 3) 写库。**不关闭 cc-switch**：实测它运行中不会主动写库
      //    （无 -wal/-shm 长连接，写入后 10 秒 mtime 不变），直接写是安全的。
      //    代价是它只在启动时读库，所以新记录要重启它才会出现在列表里。
      const w = await writeProvider(spec);
      if (!w.ok) return sendJSON(res, 500, { ok: false, error: w.error || '写入 cc-switch 失败' });

      // 4) 没在运行就顺手拉起来（用户立刻能在列表里看到新供应商）
      let started = false;
      if (!st.running && st.exe) {
        await ps(`Start-Process -FilePath "${String(st.exe).replace(/"/g, '')}"`, 20000);
        started = true;
      }

      try { require('../auth').audit('admin', 'ccswitch_apply', spec.id); } catch (e) { /* 审计失败不影响结果 */ }

      return sendJSON(res, 200, {
        ok: true,
        id: spec.id,
        name: spec.name,
        updated: !!w.updated,
        backup: w.backup || '',
        started,
        running: st.running,
        // 在运行时写库，它内存里没有这条记录 —— 需要重启才显示
        need_manual_restart: st.running,
        account_note: accountNote,
        derived: d,
        tiers: tiers.map((m, i) => ({
          tier: TIER_NAMES[i] || '',
          id: m.id,
          name: m.name || m.id,
          contextWindow: m.contextWindow ?? null,
        })),
      });
    },
  },
  {
    // 唤起 cc-switch 并让它弹「确认导入」框（不直写库）。
    // 在服务端重新推导一遍——**不信任前端传来的 URL**，避免被构造任意
    // endpoint/apiKey 的钓鱼链接。服务端本机用 Start-Process 走系统协议
    // 关联调起 cc-switch，比浏览器跳转自定义 scheme 更稳（不弹浏览器的
    // 「是否打开」中间框，cc-switch 没运行也能被协议处理器拉起来）。
    method: 'POST',
    path: '/open',
    handler: async ({ res, body }) => {
      const b = body || {};
      const channel = channels.normalize(b.channel) || 'dumate';
      const app = String(b.app || 'claude').toLowerCase() === 'codex' ? 'codex' : 'claude';
      const token = String(b.token || '').trim();
      const want = Array.isArray(b.models) ? b.models.map(String) : [];

      let rows;
      try {
        if (channel === 'qoder') {
          rows = (await qoderRowsMerged()).rows;
        } else {
          const r = await mi.rowsFor(channel, { visibleOnly: true });
          rows = (r.rows || []).filter((x) => x.id);
        }
      } catch (e) {
        return sendJSON(res, 502, { ok: false, error: `读取 ${channel} 模型表失败: ${e.message}` });
      }
      if (!rows || !rows.length) return sendJSON(res, 404, { ok: false, error: `${channel} 没有可用模型` });

      const tiers = pickTiers(rows, want);
      const d = derive(tiers);
      const base = gatewayBase();
      const dl = buildDeepLink(channel, app, tiers, d, token, base);

      // 装没装：协议处理器注册了才算数（exe/库可能在但协议没注册）
      const st = await ccSwitchState();
      if (!st.installed) {
        return sendJSON(res, 200, {
          ok: false,
          installed: false,
          error: `未检测到 cc-switch（找不到 ${st.db}）。请先安装并至少启动一次。`,
        });
      }

      // Start-Process 走 shell 协议关联。URL 内不会有单引号
      // （encodeURIComponent 不产生它，name 只有中文/固定 ASCII），再兜一层。
      // 用 try/catch 显式回传成败（Start-Process 成功时 stdout 为空，无法靠它判断）。
      const safeUrl = dl.url.replace(/'/g, '');
      const probe = await ps(
        `try { Start-Process -FilePath '${safeUrl}'; 'OK' } catch { 'ERR:' + $_.Exception.Message }`,
        20000,
      );
      const ok = /^OK/.test(probe);

      try { require('../auth').audit('admin', 'ccswitch_deeplink_open', `${channel}/${app}`); } catch (e) { /* 忽略 */ }

      return sendJSON(res, 200, {
        ok,
        installed: true,
        running: st.running,
        url: dl.url,
        limitation: dl.limitation,
        name: providerName(channel, tiers),
        error: ok ? '' : (probe.replace(/^ERR:/, '') || '唤起 cc-switch 失败，可手动复制链接'),
      });
    },
  },
];

module.exports = {
  routes, derive, pickTiers, buildDeepLink,
  // agent-setup（2026-11-07 融合项 P0-2）直写 Claude Code / Codex 配置文件时
  // 复用同一份 env / TOML 生成器——两处各写一份必然漂移（cc-switch 里的
  // 片段和直写文件的片段不同步，用户两边配置对不上还以为是网关坏了）。
  buildClaudeEnv, buildCodexConfig, gatewayBase, TIER_NAMES, qoderRowsMerged,
};
