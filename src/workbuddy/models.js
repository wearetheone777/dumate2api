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
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

/**
 * 同步取某模型的 maxOutputTokens（hub v1.10.11 #794：max_tokens 超目录上限
 * 上游回参数错误，出站前 clamp）。未预热 / 模型不在表 / 无上限数据返回 0
 * （调用方不 clamp）。rows 参数仅供测试注入，生产读缓存。
 */
function maxOutputOf(region = 'cn', modelId = '', rows = null) {
  const reg = c.normalizeRegion(region);
  let list = rows;
  if (!list) {
    const hit = caches.get(reg);
    list = hit && hit.data ? hit.data.models : null;
  }
  if (!Array.isArray(list)) return 0;
  const m = list.find((x) => x && x.id === modelId);
  return m ? (Number(m.maxTokens) || 0) : 0;
}

/**
 * 同步取某模型的目录 reasoning 元数据（2026-11-28 融合批 P0-4）：
 * { efforts:[], defaultEffort, canDisableThinking }，供 thinking.js 做档位
 * 钳制与默认档。未预热 / 模型不在表 / 无 reasoning 数据返回 null（调用方不钳）。
 * rows 参数仅供测试注入，生产读缓存——与 maxOutputOf 同一形状。
 */
function reasoningOf(region = 'cn', modelId = '', rows = null) {
  const reg = c.normalizeRegion(region);
  let list = rows;
  if (!list) {
    const hit = caches.get(reg);
    list = hit && hit.data ? hit.data.models : null;
  }
  if (!Array.isArray(list)) return null;
  const m = list.find((x) => x && x.id === modelId);
  return m && m.reasoning && typeof m.reasoning === 'object' ? m.reasoning : null;
}

/**
 * 按模型名推断它属于哪个区域（2026-11-08 融合批，真机事故驱动）。
 *
 * **要解决的真实问题**：`accountsForRegion()` 只在调用方显式传 `opts.region`
 * 时才收窄账号。不传时 `usable` 是**两区账号混在一起**，而模型名是有区域归属的
 * ——国内目录里的 `deepseek-v4.1-flash` 发给国际账号，上游直接回 11140
 * `request illegal`（不是「模型不存在」的 11102，是**风控码**）。这条路径会让
 * 一次正常的请求看起来像「账号被限制」，进而触发连坐暂停，把整条通道弄停。
 *
 * 判据只用**已缓存的目录**（`cachedModelIds`），绝不在这里打上游：
 * 选号在请求热路径上，为判区域多打一次上游是明确的倒退。
 *
 * 返回 null = 判不出来（缓存里两边都没有这个模型名）。**判不出来不要拦**——
 * 宁可让上游自己报 11102，也不要在本地凭猜测拒掉一个可能合法的模型名
 * （自定义别名、上游新上线的模型都会落在这一档）。
 *
 * @param {string} model
 * @returns {'cn'|'global'|null}
 */
function regionOfModel(model) {
  const id = String(model || '').trim();
  if (!id) return null;
  const inCn = cachedModelIds('cn').includes(id);
  const inIntl = cachedModelIds('global').includes(id);
  if (inCn && !inIntl) return 'cn';
  if (inIntl && !inCn) return 'global';
  // 两边都有（同名不同价，如 hy4std）或两边都没有 → 判不出来，交给上游
  return null;
}

/**
 * 测试注入点：直接塞入某区域的模型目录缓存（不走上游）。
 *
 * 为什么需要它：`regionOfModel` 的收窄行为完全由缓存内容决定，而
 * `fetchModels` 会真打上游——没有注入点，这条判据就只能测到「无缓存时
 * 返回 null」这一半，收窄那一半永远没被测到（本项目对这类「没导出的内部
 * 推导就是没测到的内部推导」已有多次教训）。传 null 清空该区域缓存。
 */
function _setCatalog(region, ids) {
  const reg = c.normalizeRegion(region);
  if (ids == null) { caches.delete(reg); return; }
  // 字符串 → {id}；对象 → 原样保留（reasoningOf 的测试也要能注入 reasoning 元数据）
  const list = (Array.isArray(ids) ? ids : []).map((x) => (
    typeof x === 'string' ? { id: x } : { ...x, id: String(x && x.id) }
  ));
  caches.set(reg, { at: Date.now(), data: { models: list, ok: true, fetchedAt: Date.now() } });
}

/**
 * 该模型是否「确认免费」（批次五：免费模型豁免额度护栏，hub v2.2.2）。
 *
 * 两层数据源，**实测是终审**：
 *   ① 实测账本（rate-ledger，billing-check 探针的 EMA）：有样本就按它——
 *      EMA=0 免费、>0 不豁免（上游改口径/目录元数据过期时当场暴露，这正是
 *      台账存在的意义；EMA 淡忘机制让口径改回后 5~10 次探测内恢复豁免）；
 *   ② 目录缓存（fetchModels 的解析结果带 free 字段，rate===0）——只在
 *      实测无样本时生效。
 * 计划里的「内置快照」层刻意缺席：本仓没有 workbuddy 的内置目录快照，
 * 也没有经核实的免费模型名单——编一个名单比缺一层更糟（无证据不预编）。
 *
 * 判不出来返回 false（不豁免）——错放一个付费模型只会让请求照旧打上游
 * （等同今日行为）；错豁免一个付费模型才会真的绕过护栏。'auto' 档位永远
 * 不豁免（auto 的实际模型由账号决定，免费性不可知）。
 * rows 参数仅供测试注入，生产读缓存——与 maxOutputOf/reasoningOf 同一形状。
 */
function isFreeModel(region = 'cn', modelId = '', rows = null) {
  const reg = c.normalizeRegion(region);
  const m = String(modelId || '').trim().replace(/^workbuddy\//, '');
  if (!m || m === 'auto') return false;
  try {
    const led = require('./rate-ledger').getRate(m, reg);
    if (led) return Number(led.ema) === 0; // 有实测样本：实测终审
  } catch (e) { /* 账本异常不豁免（继续走目录层） */ }
  let list = rows;
  if (!list) {
    const hit = caches.get(reg);
    list = hit && hit.data ? hit.data.models : null;
  }
  if (!Array.isArray(list)) return false;
  const row = list.find((x) => x && x.id === m);
  return !!(row && row.free === true);
}

// ---- 目录改版监控（批次七，misakano watchdog.go）----
//
// 上游改目录（加/删/改名/调倍率/调上下文）是静默的：本地映射不跟着改，
// 请求就会 404 或计错费，而界面上看不到任何征兆。周期取一次目录指纹
// （sha256），变了就交告警层报。**复用已有模型拉取**——指纹走 fetchModels
// 的缓存（CACHE_MS），不新增端点与调用节奏。
//
// 哈希的是 parseCatalog 的归一化行（固定键序构造，同一份上游数据哈希稳定；
// fetchedAt 在包装层不进行内）。首次建档只存基线不告警——没有基线谈不上
// 「改版」。落盘跨重启，`DUMATE_ADMIN_DATA` 与告警状态同目录。
const FP_FILE = 'workbuddy-catalog-fp.json';
function fpPath() {
  const dir = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
  return path.join(dir, FP_FILE);
}
function loadFp() {
  try { return JSON.parse(fs.readFileSync(fpPath(), 'utf8')); } catch (e) { return {}; }
}
function saveFp(d) {
  const p = fpPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/**
 * 取一次目录指纹并与上一份比对。返回 {ok, region, sha, models, prevSha,
 * prevModels, changed, first}；拉取失败返回 {ok:false, error}（评估层没有
 * 事实就不判，绝不把「拉不到」当成「改版了」）。
 */
async function catalogWatch(region = 'cn') {
  const reg = c.normalizeRegion(region);
  let m;
  try { m = await fetchModels({ region: reg }); } catch (e) {
    return { ok: false, region: reg, error: e.message || String(e) };
  }
  if (!m || !m.ok) return { ok: false, region: reg, error: (m && m.error) || '目录不可用' };
  const models = Array.isArray(m.models) ? m.models : [];
  const sha = crypto.createHash('sha256').update(JSON.stringify(models)).digest('hex');
  const store = loadFp();
  const prev = store[reg];
  const changed = !!(prev && prev.sha !== sha);
  const out = {
    ok: true, region: reg, sha, models: models.length,
    prevSha: prev ? prev.sha : null, prevModels: prev ? prev.models : null,
    changed, first: !prev,
  };
  if (!prev || changed) {
    store[reg] = { sha, models: models.length, at: Date.now() };
    try { saveFp(store); } catch (e) { /* 存不上就本轮告警重发一次，不影响请求 */ }
  }
  return out;
}

module.exports = {
  fetchModels, parseCatalog, parseCreditsRate, cachedModelIds, maxOutputOf, reasoningOf,
  regionOfModel, isFreeModel, _setCatalog, catalogWatch, CACHE_MS,
};
