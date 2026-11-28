// src/qoder/session.js - token 续期、账号信息、额度、签到
//
// 与 chat.js（聊天）分开：这里都是**非签名**接口（只用 Bearer device_token），
// 聊天才需要 COSY 签名。分开的理由是两者的失败模式与调用时机不同——
// 这里在登录/刷新/管理端读状态时调用，聊天在每次推理时调用。
const https = require('https');
const c = require('./constants');

const TIMEOUT_MS = 20000;

/**
 * 解析模型行的 thinking_config（上游模型表原始字段，2026-10-30 确认形状）：
 *   { disabled: {...}, enabled: { efforts: { high: {...}, max: {is_default:true}, low: {} }, is_default: true } }
 * 返回 { efforts: ['high','max','low'], default: 'max', canDisable: true }；
 * 字段缺失/形状不对时给空值，调用方按「无档位表」处理。
 * 单独成函数是为了离线可测（test/verify-qoder-channel.js）。
 */
function parseThinkingConfig(tc) {
  const out = { efforts: [], default: '', canDisable: false };
  if (!tc || typeof tc !== 'object') return out;
  const en = tc.enabled;
  if (en && typeof en === 'object' && en.efforts && typeof en.efforts === 'object') {
    out.efforts = Object.keys(en.efforts).filter(Boolean);
    out.default = out.efforts.find((k) => en.efforts[k] && en.efforts[k].is_default === true) || '';
  }
  out.canDisable = !!(tc.disabled && typeof tc.disabled === 'object');
  return out;
}

/** 发一个 JSON 请求，返回 { status, data, raw }。永不抛（网络错当 status=0）。
 *  opts.agent 出站代理（E 包接线）：凭证/配额请求与对话同出口，null = 直连。 */
function request(url, { method = 'GET', headers = {}, body = null, timeout = TIMEOUT_MS, agent = null } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ status: 0, data: null, raw: '', error: e.message }); }
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = { accept: 'application/json', 'accept-encoding': 'identity', ...headers };
    if (payload != null) {
      h['content-type'] = h['content-type'] || 'application/json';
      h['content-length'] = Buffer.byteLength(payload);
    }
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method, headers: h, timeout,
      ...(agent ? { agent } : {}),
    }, (res) => {
      let b = '';
      res.on('data', (chunk) => { b += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(b); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, data, raw: b });
      });
      res.on('error', (e) => resolve({ status: 0, data: null, raw: '', error: e.message }));
    });
    req.on('error', (e) => resolve({ status: 0, data: null, raw: '', error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: null, raw: '', error: 'timeout' }); });
    if (payload != null) req.write(payload);
    req.end();
  });
}

/** 带 device_token 的简单请求头 */
function bearerHeaders(token, extra) {
  return { Authorization: `Bearer ${token}`, ...(extra || {}) };
}

/**
 * 拉模型表（带缓存）。返回归一化后的列表，**含倍率 price_factor**。
 *
 * 模型表变化很慢（随上游版本），所以缓存 5 分钟。倍率是上游真值，界面
 * 据此排序/标注——**开发调试要挑 0.1 档**（档位差 14 倍）。
 */
const MODELS_CACHE_MS = parseInt(process.env.DUMATE_QODER_MODELS_CACHE_MS || '300000', 10);
// 缓存按「区域 + 账号」隔离。原先是一个模块级单例，两个后果都是实测踩到的：
//   1. **多账号互相串表**：preferred 账号只返回 2 个模型、另一个账号返回 14 个，
//      先查谁，后面所有账号都拿到那份表（「配置到 cc-switch」里 Qoder 只列出
//      2 个模型就是这个原因）。
//   2. **cn / global 跨区串表**：两个区域的模型集本来就不同（账号也不通用）。
const modelsCache = new Map(); // `${region}:${uid}` -> { at, data }

// 出站 agent（E 包收口补点）：模型表/额度/签到/用户信息与对话同出口。
// 配置非法向上抛（调用方转各自失败形状），绝不静默回退直连。
function agentOf(account) {
  return require('../proxy-agent').getAgentFor(account);
}

function modelsCacheKey(account) {
  const region = c.normalizeRegion(account && account.region);
  const who = (account && (account.uid || account.id)) || '';
  return `${region}:${who}`;
}

async function fetchModels(account, { force = false } = {}) {
  const ck = modelsCacheKey(account);
  const hit = modelsCache.get(ck);
  if (!force && hit && Date.now() - hit.at < MODELS_CACHE_MS) return hit.data;
  const cosy = require('./cosy');
  const region = c.normalizeRegion(account.region);
  const ep = c.endpointsOf(region);
  const sess = cosy.newSession({
    name: account.nickname || '', aid: account.uid || '', uid: account.uid || '',
    userType: account.userType || 'personal_standard',
    securityOauthToken: account.accessToken, refreshToken: account.refreshToken,
  }, account.machineId || '', account.machineToken || '', account.machineType || '5');
  const headers = cosy.buildHeaders(sess, ep.ModelsPathSig, '', 'application/json', { 'accept-encoding': 'identity' });
  const u = new URL(ep.ModelListURL);
  let agent;
  try { agent = agentOf(account); } catch (e) { return { ok: false, error: e.message, models: [] }; }
  const r = await new Promise((resolve) => {
    const req = require('https').request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers, timeout: 20000,
      ...(agent ? { agent } : {}),
    }, (res) => {
      let b = ''; res.on('data', (x) => { b += x; }); res.on('end', () => resolve({ status: res.statusCode, raw: b }));
    });
    req.on('error', (e) => resolve({ status: 0, raw: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, raw: 'timeout' }); });
    req.end();
  });
  if (r.status !== 200) return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}`, models: [] };
  let list;
  try { list = (JSON.parse(r.raw).chat || []); } catch (e) { return { ok: false, error: '响应不是 JSON', models: [] }; }
  // P0-2：**禁用模型也解析**（只从 `active` 列表里剔除，不静默丢字段）。
  // 上游的 `enable:false` + `disabled_reason` 是「官方禁用」的明确声明；
  // 直接过滤掉会让管理端 `/models` 无法区分「官方禁用」与「我们没拉到」，
  // 只能看到模型平白消失。状态由 catalogStatus 带给调用方。
  const models = list.filter((m) => m && typeof m.key === 'string' && m.key.trim()).map((m) => ({
    key: m.key,
    name: m.display_name || m.key,
    prefixed: `qoder/${m.key}`,
    // 目录状态（P0-2）：active / disabled / retired_candidate
    status: m.enable === false ? 'disabled' : 'active',
    disabledReason: m.enable === false ? String(m.disabled_reason || m.disable_reason || '') : '',
    enabled: m.enable !== false,
    // 运行时别名注册（P0-2）：上游每次成功拉表都把 display_name → key 注册进
    // 内存表；chat.resolveModelKey 优先查它（精确 → 归一化，歧义不猜）。
    // 只在内存里，进程重启即丢，下一次拉表重新学。
    aliasOf: m.display_name ? String(m.display_name) : '',
    // 倍率是相对值，不是积分绝对值
    rate: typeof m.price_factor === 'number' ? m.price_factor : null,
    // 原价倍率：**错峰/免费模型的 price_factor 会是 0**（实测 qfmodel=0、
    // original_price_factor=0.1）。只给 rate 会被读成「完全不扣费」，所以两个都带，
    // 界面在 rate 为 0 时并列显示原价。
    rateOriginal: typeof m.original_price_factor === 'number' ? m.original_price_factor : null,
    // 上下文档位。**上游的 max_input_tokens 只是「默认档」的可用输入**：
    // 200K 档给 180000（扣 20K 输出预留），而 context_config 里同一模型
    // 还挂着 400K / 1M 档。网页端让人选档位，API 侧则靠请求体的
    // model_config.max_input_tokens 指定——所以这里把「最大档」取出来，
    // 供 buildBody 下发。
    contextWindow: m.max_input_tokens || null,
    contextTiers: (() => {
      const cfg = m.context_config && typeof m.context_config === 'object' ? m.context_config : null;
      if (!cfg) return [];
      return Object.values(cfg)
        .map((x) => Number(x && x.token_count))
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
    })(),
    // 不传档位时上游按默认档（200K/180K）。网关默认请求最大档，见 chat.buildBody
    maxInputTokens: (() => {
      const cfg = m.context_config && typeof m.context_config === 'object' ? m.context_config : null;
      const tiers = cfg ? Object.values(cfg).map((x) => Number(x && x.token_count)).filter((n) => Number.isFinite(n) && n > 0) : [];
      return tiers.length ? Math.max(...tiers) : (m.max_input_tokens || null);
    })(),
    isDefault: m.is_default === true,
    isFree: m.is_free === true,
    isNew: m.is_new === true,
    isReasoning: m.is_reasoning === true,
    multimodal: m.is_vl === true,
    // 思考档位（thinking_config）。上游对不支持的档位**不报错、悄悄回落默认
    // 档**，所以归一化必须本地做——chat.resolveReasoningEffort 按这两个字段
    // 把客户端写法收敛到合法档（见那里的注释）。
    reasoningEfforts: parseThinkingConfig(m.thinking_config).efforts,
    reasoningDefault: parseThinkingConfig(m.thinking_config).default,
    reasoningCanDisable: parseThinkingConfig(m.thinking_config).canDisable,
    // 错峰优惠：22:00-08:00 打折
    promotion: (m.promotion && m.promotion.active) ? {
      discountFactor: m.promotion.discount_factor || null,
      windowStart: m.promotion.window_start || '',
      windowEnd: m.promotion.window_end || '',
    } : null,
    cheap: typeof m.price_factor === 'number' && m.price_factor <= 0.1,
  }));
  const out = { ok: true, error: '', models };
  if (models.length) {
    modelsCache.set(ck, { at: Date.now(), data: out });
    // 运行时别名注册：失败吞掉，不影响这次拉表
    try { require('./chat').registerAliases(models); } catch (e) { /* 注册失败不阻断 */ }
  }
  return out;
}

/**
 * 用 refresh_token 换新的 device_token。
 *
 * **refresh token 是轮换的**：每次返回新的，必须存下来。实测（2026-10-02）：
 * 新 device_token 有效期 30 天，refresh_token 有效期约 1 年。
 *
 * 不落盘：返回 patch 字段由调用方写回，保持「读-改-写」在一次调用里，
 * 避免并发刷新时后写的覆盖先写的（与 qwenwork/auth.js 同一约定）。
 */
/** access token 的凭证族（hub 同款口径）：device(OAuth) / job(PAT 交换) */
function tokenFamilyOf(account) {
  const rt = String((account && account.refreshToken) || '');
  if (rt.startsWith('drt-')) return 'device';
  if (rt.startsWith('jrt-')) return 'job';
  return (account && account.personalToken) ? 'pat' : 'device';
}

/** jobToken 交换/刷新的公共出口：POST → {token, refresh_token, expires_in(ms)} */
async function jobTokenPost(url, body, account) {
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
    return { ok: false, error: `出站代理配置错误: ${e.message}` };
  }
  const r = await request(url, {
    method: 'POST',
    headers: { 'User-Agent': 'qoder/1.0.0', 'Login-Version': c.LOGIN_VERSION },
    body,
    agent,
  });
  if (r.status !== 200 || !r.data) {
    const detail = (r.data && (r.data.message || r.data.error)) || String(r.raw || '').slice(0, 120) || r.error || `HTTP ${r.status}`;
    return { ok: false, error: detail };
  }
  const token = r.data.token || '';
  if (!token) return { ok: false, error: 'jobToken 交换未返回 token' };
  const out = { accessToken: token };
  if (r.data.refresh_token) out.refreshToken = r.data.refresh_token;
  // expires_in 是毫秒（hub 口径），与 deviceToken 的 expires_at（日期串）不同形
  if (r.data.expires_in) {
    const ms = Number(r.data.expires_in);
    if (Number.isFinite(ms) && ms > 0) out.expiresAt = Date.now() + ms;
  }
  out.lastError = '';
  return { ok: true, patch: out };
}

async function exchange(account) {
  if (!account || !account.refreshToken) return { ok: false, error: '缺少 refreshToken' };
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
    return { ok: false, error: `出站代理配置错误: ${e.message}` };
  }
  const ep = c.endpointsOf(account.region);
  // 凭证族路由（2026-11-01，hub 同款）：drt- 走 deviceToken，jrt- 走 jobToken。
  // PAT（personalToken）只在最后兜底——它永不覆盖仍然有效的 OAuth 会话。
  if (tokenFamilyOf(account) === 'job') {
    const jr = await jobTokenPost(ep.JobRefreshEndpoint, { refresh_token: account.refreshToken }, account);
    if (jr.ok) return jr;
    if (account.personalToken) {
      const pe = await jobTokenPost(ep.JobExchangeEndpoint, { personal_token: account.personalToken }, account);
      if (pe.ok) return pe;
      return { ok: false, error: `换票失败（jrt-: ${jr.error}；PAT: ${pe.error}）`, expired: true };
    }
    return { ok: false, error: `换票失败（${jr.error}）`, expired: true };
  }
  const r = await request(ep.RefreshEndpoint, {
    method: 'POST',
    headers: { 'User-Agent': 'qoder/1.0.0', 'Login-Version': c.LOGIN_VERSION },
    body: { refresh_token: account.refreshToken, target: 'c' },
    agent,
  });
  if (r.status !== 200 || !r.data) {
    // refresh 失败通常是凭证本身失效（refresh token 过期/被吊销）——
    // 该做的是重新登录，不是查网络。所以报错文案要指向重登。
    const detail = (r.data && (r.data.message || r.data.error)) || String(r.raw || '').slice(0, 120) || r.error || `HTTP ${r.status}`;
    // drt- 也死了但账号带着 PAT：最后兜底再试一次（upsert 按 uid 合并后
    // 存量账号也可能持有 personalToken）
    if (account.personalToken) {
      const pe = await jobTokenPost(ep.JobExchangeEndpoint, { personal_token: account.personalToken }, account);
      if (pe.ok) return pe;
      return { ok: false, error: `换票失败（${detail}；PAT: ${pe.error}）`, expired: true };
    }
    return { ok: false, error: `换票失败（${detail}）`, expired: true };
  }
  const token = r.data.device_token || r.data.token || '';
  if (!token) return { ok: false, error: '换票未返回 device_token', expired: true };
  const out = { accessToken: token };
  if (r.data.refresh_token) out.refreshToken = r.data.refresh_token;
  // 到期时间：优先用服务端给的 expires_at
  if (r.data.expires_at) {
    const t = Date.parse(r.data.expires_at);
    if (Number.isFinite(t)) out.expiresAt = t;
  }
  if (r.data.refresh_token_expires_at) {
    const t = Date.parse(r.data.refresh_token_expires_at);
    if (Number.isFinite(t)) out.refreshExpiresAt = t;
  }
  out.lastError = '';
  return { ok: true, patch: out };
}

/**
 * 确保账号的 token 新鲜。需要刷新时刷新并写回。
 * 与 qwenwork/chat.js 的 ensureAccount 同构。
 */
async function ensureAccount(authStore, account) {
  if (!authStore.needsRefresh(account)) return account;
  const r = await exchange(account);
  if (!r.ok) {
    authStore.patch(account.id, { lastError: `换票失败: ${r.error}` });
    // 凭证退场标记（2026-11-28，与 TRAE/WorkBuddy 同源）：`exchange` 的失败
    // 全部带 `expired: true`（换票端点拒绝 / 没回 token / PAT 兜底也失败），
    // 这是上游**明确判死**——再问也是同一个答案。标了之后 needsRefresh
    // 返回 false，不再每次请求都白撞一次换票端点。
    // 网络类失败（`出站代理配置错误` / 缺 refreshToken）不带 expired，不标。
    if (r.expired) {
      try {
        authStore.patch(account.id, {
          lastError: `凭证失效（需重新登录）: ${String(r.error).slice(0, 260)}`,
          refreshRetiredAt: Date.now(),
        });
      } catch (e) { /* 标记失败不影响本次请求 */ }
    }
    const err = new Error(`Qoder token 换票失败: ${r.error}`);
    err.statusCode = 401;
    throw err;
  }
  // 刷新成功说明上游刚承认这份凭证能换票：退场标记必须一并清掉，
  // 否则 needsRefresh 会永远返回 false，新 access 用到过期都不会再刷。
  authStore.patch(account.id, { ...r.patch, refreshRetiredAt: null });
  return authStore.get(account.id) || { ...account, ...r.patch };
}

/**
 * 导入 PAT（pt- 个人访问令牌）：交换 jobToken → 拉身份 → 返回落盘记录。
 *
 * SSO 强制组织下设备授权流程会被组织拦，PAT 是唯一登录路（hub docs/accounts.md）。
 * 返回的记录交 authStore.upsert（按 uid 合并——给存量账号补 PAT 时走同一条路）。
 * machineId/machineToken/machineType 与 login.js 同款生成（COSY 签名身份）。
 */
async function importPat(pat, region) {
  const patStr = String(pat || '').trim();
  if (!patStr.startsWith('pt-')) return { ok: false, error: 'PAT 必须以 pt- 开头' };
  const reg = c.normalizeRegion(region);
  const ep = c.endpointsOf(reg);
  const ex = await jobTokenPost(ep.JobExchangeEndpoint, { personal_token: patStr }, { region: reg });
  if (!ex.ok) return { ok: false, error: `PAT 交换失败: ${ex.error}` };
  const patch = ex.patch || {};
  const crypto = require('crypto');
  const rec = {
    region: reg,
    accessToken: patch.accessToken,
    refreshToken: patch.refreshToken || '',
    personalToken: patStr,
    expiresAt: patch.expiresAt || (Date.now() + 24 * 3600 * 1000),
    source: 'pat',
    platform: 'CLI',
    machineId: crypto.randomUUID(),
    machineToken: crypto.randomBytes(38).toString('base64url').slice(0, 50),
    machineType: crypto.randomBytes(9).toString('hex'),
  };
  // 身份尽力拉一次：失败不阻断入库（uid 缺失时 upsert 会新建一条）
  try {
    const info = await fetchUserInfo(patch.accessToken, reg);
    if (info && typeof info === 'object') {
      rec.uid = String(info.id || '');
      rec.nickname = String(info.name || '');
      rec.email = String(info.email || '');
      rec.userType = String(info.user_type || '');
      rec.organizationId = String(info.organization_id ?? info.organizationId ?? '');
      rec.organizationName = String(info.organization_name ?? info.organizationName ?? '');
    }
  } catch (e) { /* 身份拿不到就先入库，昵称显示 uid */ }
  if (!rec.uid) rec.uid = `p-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  return { ok: true, account: rec };
}

/** 取用户信息（登录后 / 补昵称时用）。opts.agent 出站代理（E 包收口补点） */
async function fetchUserInfo(token, region, opts = {}) {
  const ep = c.endpointsOf(region);
  const r = await request(ep.UserinfoBase, { headers: bearerHeaders(token), agent: opts.agent || null });
  if (r.status !== 200 || !r.data) return null;
  return r.data;
}

/** 取套餐信息。opts.agent 出站代理（E 包收口补点） */
async function fetchPlan(token, region, opts = {}) {
  const ep = c.endpointsOf(region);
  const r = await request(ep.PlanEndpoint, { headers: bearerHeaders(token), agent: opts.agent || null });
  if (r.status !== 200 || !r.data) return null;
  return r.data;
}

/**
 * 取额度。
 *
 * 返回三块，**语义不同，界面不能相加**：
 *   - userQuota     订阅套餐内的额度（Free 套餐恒为 0）
 *   - addOnQuota    签到/赠送得到的积分（**这才是免费用户实际能用的**）
 *   - isQuotaExceeded 是否已超额（超额时聊天会挂起而非报错，见下）
 *
 * 实测（2026-10-02）：新账号 userQuota 与 addOnQuota 都是 0，
 * 此时聊天请求**会挂起不返回**（既不报错也不超时失败），必须先签到领积分。
 */
async function fetchQuota(token, region, opts = {}) {
  const ep = c.endpointsOf(region);
  const r = await request(ep.QuotaEndpoint, { headers: bearerHeaders(token, { 'cosy-clienttype': c.CHECKIN_CLIENT_TYPE }), agent: opts.agent || null });
  if (r.status !== 200 || !r.data) return { ok: false, error: r.error || `HTTP ${r.status}` };
  const bucket = (o) => {
    if (!o || typeof o !== 'object') return null;
    const total = num(o.total), used = num(o.used), remaining = num(o.remaining);
    return { total, used, remaining, percentage: num(o.percentage), unit: o.unit || 'credits' };
  };
  // 团队共享额度池（qoder2api-hub #39 实测）：团队号的有效余额 = 套餐 + 可用共享池。
  // cap = -1 表示不限量（不是 0，别按数字大小判断）。个人号通常没有这个对象。
  const org = r.data.orgResourcePackage && typeof r.data.orgResourcePackage === 'object'
    ? (() => {
      const cap = num(r.data.orgResourcePackage.cap);
      return {
        used: num(r.data.orgResourcePackage.used),
        remaining: num(r.data.orgResourcePackage.remaining),
        cap,
        unlimited: cap < 0,
        available: r.data.orgResourcePackage.available === true,
      };
    })()
    : null;
  return {
    ok: true,
    userQuota: bucket(r.data.userQuota),
    addOnQuota: bucket(r.data.addOnQuota),
    orgResourcePackage: org,
    isQuotaExceeded: r.data.isQuotaExceeded === true,
    userType: r.data.userType || '',
  };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// ---- Pro 升级福利包（一次性 +1800，2026-10-31 融合 hub）----
//
// 免费号一次性福利，额度是每日签到（100）的 18 倍。**只领一次**，所以调用方
// 必须把它当成不可逆动作：先查资格、再让用户点。
//
// 端点不存在（404/403/410）= 活动已下线，按「不可领取」返回，不当成错误——
// 不同区域/账号类型覆盖的活动不同，报错会把「没有这个活动」误显示成故障。
async function fetchProEligibility(token, region, opts = {}) {
  const ep = c.endpointsOf(region);
  const r = await request(ep.ProEligibilityEndpoint, { headers: bearerHeaders(token), agent: opts.agent || null });
  if (r.status === 404 || r.status === 403 || r.status === 410) return { ok: true, eligible: false, gone: true };
  if (r.status !== 200 || !r.data) return { ok: false, error: r.error || `HTTP ${r.status}`, eligible: null };
  return { ok: true, eligible: r.data.eligible === true, raw: r.data };
}

/**
 * 领取 Pro 福利包。返回 `{ ok, already?, error? }`。
 *
 * 已领过：上游回 409 或 body 含 ALREADY——按成功但 `already:true` 处理，
 * 不当成失败（否则界面会让人反复点，而每次都是同一个结果）。
 */
async function claimProBenefit(token, region, opts = {}) {
  const ep = c.endpointsOf(region);
  const r = await request(ep.ProClaimEndpoint, {
    method: 'POST', body: {}, headers: bearerHeaders(token), agent: opts.agent || null,
  });
  if (r.status === 409 || /ALREADY/i.test(String(r.raw || ''))) {
    return { ok: true, already: true };
  }
  if (r.status !== 200) return { ok: false, error: `HTTP ${r.status} ${String(r.raw || '').slice(0, 160)}` };
  if (r.data && r.data.success === false) {
    return { ok: false, error: String(r.data.message || r.raw || '').slice(0, 160) };
  }
  return { ok: true, data: r.data };
}


// ---- 官方积分消耗（credits-summary / credits-heatmap，2026-10-30）----
// 上游唯一给出「真实消耗口径」的接口：累计消耗 + 单日峰值 + 近 365 天逐日。
// 结果按 token 缓存 5 分钟——全量聚合接口，别跟着界面轮询打（hub 同值）。
const CREDIT_USAGE_TTL_MS = 5 * 60 * 1000;
const creditUsageCache = new Map(); // accessToken → { at, data }

/**
 * 解析 credits-summary + credits-heatmap 的响应体（单独成函数为了离线可测）。
 * 字段形状实测自 qoder2api-hub v1.7.5：summary = {totalCredits, peakCredits,
 * peakDate, unit}；heatmap = {items: [{date, value}]}。
 * 取不到的字段给 null 不补 0——0 会被读成「没消耗」。
 */
function parseCreditUsage(sum, heat) {
  if (!sum || typeof sum !== 'object') {
    return { ok: false, error: '响应不是 JSON 对象', total: null, peak: null, peakDate: '', unit: '', daily: [], heatmapOk: false };
  }
  const daily = [];
  const items = (heat && typeof heat === 'object' && Array.isArray(heat.items)) ? heat.items : [];
  for (const it of items) {
    // 没有 date 的条目对热力图无用，跳过（上游坏读/形状漂移时不画错）
    if (!it || typeof it !== 'object' || !it.date) continue;
    const v = Number(it.value);
    daily.push({ date: String(it.date), value: Number.isFinite(v) ? v : 0 });
  }
  return {
    ok: true,
    total: typeof sum.totalCredits === 'number' ? sum.totalCredits : null,
    peak: typeof sum.peakCredits === 'number' ? sum.peakCredits : null,
    peakDate: String(sum.peakDate || ''),
    unit: String(sum.unit || 'credits'),
    daily,
    heatmapOk: !!(heat && typeof heat === 'object'),
  };
}

async function fetchCreditUsage(token, region, opts = {}) {
  const ep = c.endpointsOf(region);
  const hit = creditUsageCache.get(token);
  if (!opts.force && hit && Date.now() - hit.at < CREDIT_USAGE_TTL_MS) return hit.data;
  const headers = bearerHeaders(token, { 'cosy-clienttype': c.CHECKIN_CLIENT_TYPE });
  const sum = await request(ep.CreditsSummaryEndpoint, { headers, agent: opts.agent || null });
  if (sum.status !== 200 || !sum.data) {
    // 失败给 null 不补 0——0 会被读成「没消耗」
    return { ok: false, error: sum.error || `HTTP ${sum.status}`, total: null, peak: null, peakDate: '', unit: '', daily: [], heatmapOk: false };
  }
  // 热力图失败不拖垮摘要：逐日给空数组并标注 heatmapOk
  const heat = await request(ep.CreditsHeatmapEndpoint, { headers, agent: opts.agent || null });
  const out = parseCreditUsage(sum.data, heat.status === 200 ? heat.data : null);
  creditUsageCache.set(token, { at: Date.now(), data: out });
  return out;
}

/**
 * 签到：查活动列表 → 领取可领的。
 *
 * **这条接口不需要签名**（实测）：只要 `Authorization: Bearer <device_token>`
 * + `cosy-clienttype: 10`。比聊天简单得多。
 *
 * 幂等：已领的活动 claimStatus 不是 CLAIMABLE，会跳过；重复调用不会重复领。
 */
async function listCampaigns(token, region, opts = {}) {
  const ep = c.endpointsOf(region);
  const r = await request(ep.CampaignsBase, { headers: bearerHeaders(token, { 'cosy-clienttype': c.CHECKIN_CLIENT_TYPE }), agent: opts.agent || null });
  if (r.status !== 200 || !r.data) return { ok: false, error: r.error || `HTTP ${r.status}`, campaigns: [] };
  return {
    ok: true,
    claimable: r.data.claimable === true,
    campaigns: Array.isArray(r.data.campaigns) ? r.data.campaigns : [],
  };
}

/**
 * 只读地判断「今天签到了没」——**不领取任何东西**。
 *
 * 关键前提：/campaigns 是 GET 且只读（`checkin()` 才 POST claim），所以
 * 拿它查状态不会把「未签到」变成「已签到」。这是与 TRAE 的 status() 同一个
 * 定位（那边也是只读接口），界面要显示的正是这个。
 *
 * 判定口径（实测）：
 *   claimStatus = 'CLAIMABLE' → 还没领（今天可签）
 *   claimStatus = 'CLAIMED'   → 已领（今天已签）
 *   一个活动都没有          → 查不出，给 null（不猜成已签）
 *
 * 顺带把「下次可签时刻」算出来：活动的 endAt（Unix 秒）就是刷新时刻——
 * 官方活动描述写着 Daily reset: 10:00 (UTC+8)，与本项目记载一致，
 * 不是 00:00。查不到时返回 null，界面显示「—」而不是编一个。
 */
async function checkinStatus(token, region, opts = {}) {
  const list = await listCampaigns(token, region, opts);
  if (!list.ok) return { ok: false, error: list.error, checkedIn: null, nextAt: null, pending: null };

  const camps = list.campaigns || [];
  if (!camps.length) {
    // 上游没给任何活动：既不能说已签也不能说未签，如实 null
    return { ok: true, checkedIn: null, nextAt: null, pending: null, campaigns: 0 };
  }

  const claimable = camps.filter((c) => c.claimStatus === 'CLAIMABLE');
  const claimed = camps.filter((c) => c.claimStatus === 'CLAIMED');

  // 待领总额：只有 CLAIMABLE 的才算「今天还没领」
  const pending = claimable.reduce(
    (s, c) => s + ((c.benefit && typeof c.benefit.amount === 'number') ? c.benefit.amount : 0), 0);

  // 下次可签时刻：取活动最早的 endAt（今天这批的截止 = 明天这批的开始）
  const ends = camps.map((c) => (typeof c.endAt === 'number' ? c.endAt : 0)).filter((n) => n > 0);
  const nextAt = ends.length ? Math.min(...ends) * 1000 : null;

  return {
    ok: true,
    checkedIn: claimable.length === 0 && claimed.length > 0,
    // 有可领的 → 明确「未签」；一个活动都没 → null
    pending: claimable.length ? Number(pending.toFixed(4)) : (claimed.length ? 0 : null),
    nextAt,
    campaigns: camps.length,
    claimable: claimable.length,
    claimed: claimed.length,
  };
}

async function claimCampaign(token, region, campaignId, opts = {}) {
  const ep = c.endpointsOf(region);
  const url = `${ep.CampaignsBase}/${encodeURIComponent(campaignId)}/claim`;
  const r = await request(url, {
    method: 'POST',
    headers: bearerHeaders(token, { 'cosy-clienttype': c.CHECKIN_CLIENT_TYPE }),
    body: {},
    agent: opts.agent || null,
  });
  if (r.status !== 200 || !r.data) {
    // 同人多号被拒（P0-2）：`SAME_PERSON_ALREADY_CLAIMED` 会以 4xx 回来。
    // 这不是「签到失败」，而是「额度被同一个人的另一个号领走了」——
    // 两种处置完全不同（前者该重试/排查，后者该换号轮转），所以单独标记，
    // 免得界面把它显示成一条普通错误。
    const blob = String(r.raw || '') + ' ' + String((r.data && (r.data.message || r.data.code)) || '');
    const samePerson = /SAME_PERSON/i.test(blob);
    return {
      ok: false,
      error: r.error || `HTTP ${r.status}`,
      raw: r.raw,
      samePerson,
      status: samePerson ? 'BLOCKED' : '',
    };
  }
  const d = r.data;
  // **领取响应里带到期信息**（benefit.validity），这是「这批积分什么时候作废」
  // 的唯一权威来源——Qoder 没有逐批余额接口（实测 /quota/detail 等一律 503）。
  // 所以要原样带出来落盘，否则过期信息永久丢失。
  const validity = (d.benefit && d.benefit.validity) || {};
  return {
    ok: true,
    status: d.status || '',
    benefit: d.benefit || null,
    replayed: d.replayed === true,
    // **grantId 是本地批次账本的幂等键**（grants.record 靠它去重）。响应原文
    // d.grantId 存在（benefit 里部分活动形态也带）。此前没有带出，
    // fromClaim 恒返 ''、record 以空键拒写——过期提醒自 2026-10-02 起实际
    // 无数据源（P0-1）。两个位置都试，缺失如实空串（不编造）。
    grantId: d.grantId || (d.benefit && d.benefit.grantId) || '',
    // campaignKey 优先取领取响应，列表条目（camp.campaignKey）由调用方兜底
    campaignKey: d.campaignKey || (d.benefit && d.benefit.campaignKey) || '',
    // grantedAt 是服务端给的领取时刻（ISO）；缺失时由调用方用本地时间兜底
    grantedAt: d.grantedAt || '',
    // 有效期：mode=RELATIVE_DAYS + days=30 是最常见形态
    validityMode: validity.mode || '',
    validityDays: typeof validity.days === 'number' ? validity.days : null,
    amount: (d.benefit && typeof d.benefit.amount === 'number') ? d.benefit.amount : null,
    modelScope: (d.benefit && d.benefit.modelScope) || null,
  };
}

/**
 * **只读**地核验「某个活动到底发给了谁」（P0-2，2026-11-07 调研）。
 *
 * 出处：workbuddy2api 面板 FAQ「Qoder 号池两个号为什么只有一个能领到那 100 积分」
 * （2026-11-04 真机实测更正版）——每日 100 Credits **按账号各发一份**，只有
 * 服务端判定「同一个人」时才只发一份（后领的被拒 `SAME_PERSON_ALREADY_CLAIMED`）。
 * 设备指纹（伪造全套/完全不带 Cosy-* 头）与 agentAccountScope **均不参与判定**。
 *
 * 为什么必须核验：本项目 grants 账本以 `grantId` 为幂等键，但「领过了」与
 * 「真领到了」是两回事——被判同人的号没有积分进账，账本若照记领取额就是
 * 假数据，FEFO 推算剩余跟着错（会把两个号都当成有积分，实际只有一个有）。
 *
 * **端点是 GET**（`/sash/api/v1/me/campaigns/{cid}/reward`），只读、绝不触发
 * 领取。**绝不拿别的账号的活动实例去调**——那属于用别人的 id 探别人的账，
 * 越界且会被风控画像记一笔；cid 必须来自本账号自己的 /campaigns 列表。
 *
 * 返回：{ ok, status, grantId, samePerson, campaignId, error }
 *   ok=true 时 status 是上游原值（CLAIMED / BLOCKED / …），**不做二次解释**
 *   ——判三态是 grants.classifyVerification 的事（纯函数，离线可测）。
 */
async function verifyClaim(token, region, campaignId, opts = {}) {
  const ep = c.endpointsOf(region);
  if (!campaignId) return { ok: false, error: '缺少 campaignId', status: '', grantId: '', samePerson: false };
  const url = `${ep.CampaignsBase}/${encodeURIComponent(campaignId)}/reward`;
  const r = await request(url, {
    headers: bearerHeaders(token, { 'cosy-clienttype': c.CHECKIN_CLIENT_TYPE }),
    agent: opts.agent || null,
  });
  if (r.status === 404 || r.status === 405) {
    // 端点不存在＝这个上游版本没这个接口。**如实报不支持**，不猜成「未领取」。
    return { ok: false, unsupported: true, error: `核验端点不可用（HTTP ${r.status}）`, status: '', grantId: '', samePerson: false };
  }
  if (r.status !== 200 || !r.data) {
    return { ok: false, error: r.error || `HTTP ${r.status}`, status: '', grantId: '', samePerson: false };
  }
  const d = r.data;
  // 形状兜底：status 可能在顶层，也可能包在 reward/benefit 里（上游两种形态都见过）
  const reward = (d.reward && typeof d.reward === 'object') ? d.reward : d;
  const status = String(reward.status || d.status || reward.claimStatus || '').trim();
  const grantId = String(reward.grantId || d.grantId
    || (reward.benefit && reward.benefit.grantId) || '').trim();
  // 同人标记：上游用错误码/文案表达（SAME_PERSON_ALREADY_CLAIMED）。
  // 只看**结构化字段与文案**，不猜。code 也可能就是那串字符串。
  const blob = [
    d.code, d.subCode, d.errorCode, reward.code, d.message, d.reason,
  ].filter(Boolean).map(String).join(' ');
  const samePerson = /SAME_PERSON/i.test(blob)
    || /同一(个)?(人|用户)|同人|already claimed by the same/i.test(blob);
  return { ok: true, status, grantId, samePerson, campaignId, raw: d };
}

/**
 * 签到一次（查列表 + 领所有可领的）。返回领取明细。
 * 领之前/之后各读一次额度，报出**实际到账差值**——与 TRAE 同一约定：
 * 上游从不直接告诉你发了多少，只看总额会把「没生效」误读成成功。
 *
 * @param {object} [opts.account] 账号对象。给了就顺手把每个批次写进本地账本
 *   （src/qoder/grants.js）——**过期提醒靠它**，因为上游没有逐批余额接口。
 *   同时也是出站代理的解析来源（E 包收口补点）：签到全链路与对话同出口，
 *   代理配置非法时以首次网络动作的失败收场，不回退直连。
 */
/**
 * 签到结果三态判定（P0-5）。
 *
 * `r.ok` 是「上游接口回 200」，不等于「领到了」。三类事实必须分开：
 *   claimed      — 领取响应成功且**实际到账 > 0**
 *   already      — 明确已领过（无可领活动 / 上游 409 / BLOCKED 且有已领证据）
 *   none_available / exhausted / same_person / blocked / error — 没领到，原因不同
 *
 * 关键纪律：`gained <= 0` 一律不写 lastCheckin / 账本 claim 行——上游结算延迟时
 * 读成 0 只是「没测出来」，不是没领；但把它写成成功会永久掩盖真实失败。
 */
function checkinOutcome(r) {
  if (!r || r.ok !== true) return 'error';
  const claims = Array.isArray(r.claimed) ? r.claimed : [];
  const hasPositiveGain = Number(r.gained) > 0;
  const successful = claims.filter((x) => x && x.ok);
  if (successful.length) {
    // 没有实测差值时（注入的 claimOf / 上游余额查不到）不把 0/null 当失败，
    // 但仍以「领取响应成功」为成功证据——这是 autocheckin 既有口径。
    if (r.gained == null) return 'claimed';
    if (hasPositiveGain) {
      const verified = successful.filter((x) => x.verification === 'claimed');
      if (verified.length && verified.length === successful.length) return 'claimed';
      // 同人已领：领取接口报成功但归属核验点名「进了另一个号」
      if (successful.some((x) => x.verification === 'same_person' || x.samePerson)) return 'same_person';
      return 'claimed';
    }
    const verified = successful.filter((x) => x.verification === 'claimed');
    if (verified.length && verified.length === successful.length) return 'none_available';
    if (successful.some((x) => x.verification === 'same_person' || x.samePerson)) return 'same_person';
    return 'none_available';
  }
  if (r.alreadyChecked) return 'already';
  if (claims.some((x) => x && x.samePerson)) return 'same_person';
  if (claims.some((x) => x && /BLOCKED/i.test(String(x.error || '')))) return 'blocked';
  if (claims.some((x) => x && /EXHAUST|NO_AVAILABLE/i.test(String(x.error || x.status || '')))) return 'exhausted';
  return 'none_available';
}

async function checkin(token, region, opts = {}) {
  let agent = null;
  try { agent = opts.account ? agentOf(opts.account) : null; } catch (e) {
    return { ok: false, error: e.message, claimed: [] };
  }
  const before = await fetchQuota(token, region, { agent });
  const list = await listCampaigns(token, region, { agent });
  if (!list.ok) return { ok: false, error: list.error, claimed: [] };
  const claimed = [];
  for (const camp of list.campaigns) {
    if (camp.claimStatus !== 'CLAIMABLE') continue;
    const r = await claimCampaign(token, region, camp.campaignId, { agent });
    // campaignKey 两个来源都可信：领取响应（claimCampaign 现已带出）与列表条目。
    // 领取响应缺失时用列表值兜底——账本里它参与标识批次，空着没法对账。
    const campaignKey = r.campaignKey || camp.campaignKey || '';
    // 归属核验（P0-2）：**只读** GET /campaigns/{cid}/reward，绝不触发领取，
    // cid 只取本账号自己列表里的那个。核验失败不影响签到结论——三态里的
    // 'unverified' 就是为这种情况准备的（如实标未核实，不猜）。
    let verification = null;
    if (r.ok) {
      try {
        verification = await verifyClaim(token, region, camp.campaignId, { agent });
      } catch (e) {
        verification = { ok: false, error: e.message };
      }
    }
    const cls = r.ok
      ? require('./grants').classifyVerification(verification, r.grantId || '')
      : null;
    claimed.push({
      campaignId: camp.campaignId,
      key: campaignKey,
      // grantId 只有领取响应里有：账本幂等键（P0-1 补齐后才会非空）
      grantId: r.grantId || '',
      amount: (r.amount != null ? r.amount : (camp.benefit && camp.benefit.amount)),
      ok: r.ok,
      status: r.status || '',
      error: r.error || '',
      // 领取环节被判「同人已领」时也要透出（不是普通失败）——管理端据此
      // 显示「额度已被同一个人的另一账号领走」而不是一条模糊的 403。
      samePerson: r.samePerson === true,
      // 到期信息：领取响应里才有（上游唯一的权威来源）
      grantedAt: r.grantedAt || '',
      validityMode: r.validityMode || '',
      validityDays: r.validityDays,
      // 三态核验结果透出到管理端（已签灰 / 同人已领点名 / 未核实）
      ...(cls || {}),
    });
    // 落本地账本：过期提醒的数据源。写失败不影响签到结果本身。
    if (r.ok && opts.account) {
      try {
        const grants = require('./grants');
        grants.record(grants.fromClaim({ ...r, campaignKey, ...(cls || {}) }, opts.account));
      } catch (e) { /* 记账失败不影响签到 */ }
    }
  }
  // 结算有延迟，等一拍再读
  if (claimed.some((x) => x.ok)) await new Promise((s) => setTimeout(s, 1500));
  const after = await fetchQuota(token, region, { agent });
  // 到账差值：以 addOnQuota 为准（免费用户的积分都进这里）
  let gained = null;
  if (before.ok && after.ok && before.addOnQuota && after.addOnQuota) {
    gained = Number((after.addOnQuota.remaining - before.addOnQuota.remaining).toFixed(4));
  }
  return {
    ok: true,
    claimed,
    gained,
    before: before.ok ? before.addOnQuota : null,
    after: after.ok ? after.addOnQuota : null,
    // 一个活动都没领到（今天已签过）不是错误，如实报出
    alreadyChecked: claimed.filter((x) => x.ok).length === 0 && !list.claimable,
  };
}

/**
 * 同步读模型缓存（不触发网络）。给 runOnce 取「该模型最大档的上下文」用——
 * 那里在请求热路径上，不能再等一次 20s 的上游调用。缓存为空时返回 null，
 * 调用方回落到默认档。
 */
function cachedModels(account) {
  const hit = modelsCache.get(modelsCacheKey(account));
  return hit && hit.data && Array.isArray(hit.data.models) ? hit.data.models : null;
}

module.exports = {
  request, bearerHeaders, exchange, ensureAccount, fetchUserInfo, fetchPlan, importPat, tokenFamilyOf, jobTokenPost,
  fetchQuota, fetchCreditUsage, parseCreditUsage, fetchProEligibility, claimProBenefit, fetchModels, cachedModels, listCampaigns, claimCampaign, checkin, checkinOutcome, checkinStatus, verifyClaim, TIMEOUT_MS,
  parseThinkingConfig,
};
