// src/workbuddy/models.js - 模型目录（上游下发，双区域）
//
// 端点与解析（对照 upstream.rs fetch_models / parse_model_catalog）：
//   CN: GET {chat_base}/console/enterprises/personal/models，CLI 形态 UA
//   Global: GET {chat_base}/v3/config，App 形态 UA（WorkBuddyAI/<v>，无空格）
//           + X-Requested-With: XMLHttpRequest + X-Product: SaaS
// 目录形状两种都要接：{code,msg,data} 包装 / 裸文档（顶层直接含 models）。
// 白名单规则：agents[name=='cli'].models 是可用 id 列表；models 按 id 匹配，
// disabled 跳过、maxInput/maxOutput 必须 > 0；上下文取 maxInputTokens（上限档），
// contextWindow.defaultLength（默认档）单列——旧实现拿 defaultLength 当上限
// 会让清单永远只显示下限（参照实现 issue 实测过）。
// credits 字符串 "x0.00 credits" 判免费（issue #65：后缀不影响取数）。
const c = require('./constants');
const https = require('https');

// 目录基本不变，缓存 10 分钟（按区域分——两区目录不同）
const CACHE_MS = parseInt(process.env.DUMATE_WORKBUDDY_MODELS_CACHE_MS || '600000', 10);
const caches = new Map(); // region -> { at, data }

/** 拉取 raw 目录文档。返回 { ok, status, error, data } */
function fetchCatalogRaw(region, account, agent) {
  return new Promise((resolve) => {
    const spec = c.specOf(region);
    const u = new URL(spec.chatBase + spec.modelsPath);
    const international = spec.catalogUa === 'app';
    const clientVersion = (process.env.DUMATE_WORKBUDDY_APP_VERSION || '').trim()
      || spec.fallbackAppVersion;
    const ua = international ? `WorkBuddyAI/${clientVersion}` : c.CLIENT_UA;
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${(account && account.accessToken) || ''}`,
      Origin: spec.billingBase,
      Referer: `${spec.billingBase}/`,
      'User-Agent': ua,
      ...(agent ? {} : {}),
    };
    if (international) {
      headers['X-Requested-With'] = 'XMLHttpRequest';
      headers['X-Product'] = 'SaaS';
    }
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers,
      ...(agent ? { agent } : {}), timeout: 30000,
    }, (res) => {
      let buf = '';
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      res.on('data', (x) => { buf += dec.write(x); });
      res.on('end', () => { buf += dec.end(); resolve({ status: res.statusCode, body: buf }); });
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.end();
  }).then((r) => {
    let doc = null;
    try { doc = JSON.parse(r.body); } catch (e) { /* 非 JSON */ }
    if (!doc) return { ok: false, status: r.status, error: `非 JSON 响应 (HTTP ${r.status})` };
    const code = Number(doc.code);
    if (r.status < 200 || r.status >= 300 || (Number.isFinite(code) && code !== 0)) {
      return { ok: false, status: r.status, error: (doc.msg || doc.message) || `HTTP ${r.status}` };
    }
    // 两种目录形状：{code,data} 包装 / 裸文档（顶层直接含 models 或 agents）
    const data = doc.data && typeof doc.data === 'object' ? doc.data
      : (doc.models || doc.agents ? doc : {});
    return { ok: true, status: r.status, data };
  });
}

/** credits 字符串 → 倍率数字（"x0.34 credits" / "0.34" / "x0.00 credits"） */
function parseCreditsRate(raw) {
  const s = String(raw || '').trim();
  const m = /(\d+(?:\.\d+)?)/.exec(s.replace(/^x/i, ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** 目录文档 → 归一化模型行（含 reasoning / free / badges） */
function parseCatalog(data) {
  const rawModels = Array.isArray(data.models) ? data.models : [];
  const agents = Array.isArray(data.agents) ? data.agents : [];
  let cliIds = null;
  for (const a of agents) {
    if (a && typeof a === 'object' && a.name === 'cli' && Array.isArray(a.models)) {
      cliIds = a.models.map(String);
      break;
    }
  }
  if (!cliIds || !cliIds.length) {
    return { ok: false, error: '模型目录没有 cli agent 的模型清单' };
  }
  const byId = new Map();
  for (const m of rawModels) {
    if (!m || typeof m !== 'object') continue;
    const id = String(m.id || '');
    if (!id || m.disabled === true) continue;
    const input = Number(m.maxInputTokens) || 0;
    const output = Number(m.maxOutputTokens) || 0;
    if (input <= 0 || output <= 0) continue;
    // 上下文取**上限档**（maxInputTokens / maxAllowedSize）；defaultLength 是默认档
    const contextWindow = (Number(m.maxInputTokens) > 0 ? Number(m.maxInputTokens)
      : (Number(m.maxAllowedSize) > 0 ? Number(m.maxAllowedSize) : input));
    let defaultWindow = null;
    const cw = m.contextWindow && typeof m.contextWindow === 'object' ? m.contextWindow : null;
    if (cw && Number(cw.defaultLength) > 0 && Number(cw.defaultLength) < contextWindow) {
      defaultWindow = Number(cw.defaultLength);
    }
    const rate = parseCreditsRate(m.credits);
    // reasoning 块三种形态：完整档位表 / 只给默认档（effort 等价 defaultEffort）/ 缺失
    let reasoning = null;
    if (m.reasoning && typeof m.reasoning === 'object') {
      const efforts = Array.isArray(m.reasoning.supportedEfforts)
        ? m.reasoning.supportedEfforts.map((x) => String(x).trim()).filter(Boolean) : [];
      const def = String(m.reasoning.defaultEffort || m.reasoning.effort || '').trim() || null;
      const canDisable = typeof m.reasoning.canDisableThinking === 'boolean'
        ? m.reasoning.canDisableThinking : null;
      if (efforts.length || def || canDisable != null) {
        reasoning = { efforts, defaultEffort: def, canDisableThinking: canDisable };
      }
    }
    // badges：tags 里 badge:<label>[:color] 的 label
    const badges = [];
    if (Array.isArray(m.tags)) {
      for (const t of m.tags) {
        const s = String(t || '');
        if (s.toLowerCase().startsWith('badge:')) {
          const label = s.slice(6).split(':')[0];
          if (label) badges.push(label);
        }
      }
    }
    byId.set(id, {
      id,
      name: String(m.name || '').trim() || id,
      contextWindow,
      contextWindowDefault: defaultWindow,
      maxTokens: output,
      multimodal: m.supportsImages === true && m.disabledMultimodal !== true,
      credits: String(m.credits || '').trim() || null,
      rate,
      free: rate != null ? rate === 0 : false,
      badges,
      reasoning,
    });
  }
  const models = cliIds.map((id) => byId.get(id)).filter(Boolean);
  if (!models.length) return { ok: false, error: '模型目录解析结果为空' };
  return { ok: true, models };
}

/**
 * 拉模型表（带缓存，按区域分）。
 * @returns {Promise<{ok:boolean, error:string, models:Array, fetchedAt:number}>}
 */
async function fetchModels({ force = false, region = 'cn' } = {}) {
  const reg = c.normalizeRegion(region);
  const hit = caches.get(reg);
  if (!force && hit && hit.data && Date.now() - hit.at < CACHE_MS) return hit.data;
  const authStore = require('./auth');
  const usable = authStore.findUsable().filter((a) => c.normalizeRegion(a.region) === reg);
  if (!usable.length) {
    return { ok: false, error: reg === 'global' ? '没有国际版账号（先到账号管理 → 国际版添加）' : '没有国内账号（需先导入）', models: [], fetchedAt: 0 };
  }
  // token 过期先续期：客户端导入的 access token 有效期有限（实测 9/18 的
  // 登录态直接 401），目录请求与对话同一刷新路径
  let account = usable[0];
  try { account = await authStore.ensureFresh(account); } catch (e) { /* 刷新失败带旧 token 试 */ }
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
    return { ok: false, error: e.message, models: [], fetchedAt: 0 };
  }
  const r = await fetchCatalogRaw(reg, account, agent);
  if (!r.ok && r.status === 401) {
    // 换过票再试一次（首次可能读到的还是旧 token）
    try {
      const rr = await authStore.exchange(usable[0]);
      if (rr.ok) {
        const fresh = authStore.get(usable[0].id);
        const r2 = await fetchCatalogRaw(reg, fresh, agent);
        if (r2.ok) {
          const parsed2 = parseCatalog(r2.data);
          if (parsed2.ok) {
            const out2 = { ok: true, error: '', models: parsed2.models, fetchedAt: Date.now() };
            caches.set(reg, { at: Date.now(), data: out2 });
            return out2;
          }
        }
      }
    } catch (e) { /* 重试失败走下面的错误返回 */ }
  }
  if (!r.ok) return { ok: false, error: r.error, models: [], fetchedAt: 0 };
  const parsed = parseCatalog(r.data);
  if (!parsed.ok) return { ok: false, error: parsed.error, models: [], fetchedAt: 0 };
  const out = { ok: true, error: '', models: parsed.models, fetchedAt: Date.now() };
  caches.set(reg, { at: Date.now(), data: out });
  return out;
}

/** 同步取缓存 id（未预热回落静态兜底） */
function cachedModelIds(region = 'cn') {
  const reg = c.normalizeRegion(region);
  const hit = caches.get(reg);
  if (hit && hit.data && hit.data.models.length) return hit.data.models.map((m) => m.id);
  return reg === 'global' ? [] : ['glm-5.3'];
}

module.exports = { fetchModels, parseCatalog, parseCreditsRate, cachedModelIds, CACHE_MS };
