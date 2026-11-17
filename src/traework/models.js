// src/traework/models.js - 模型表（上游下发，含消耗倍率）
//
// 早期版本只硬编码了一个 DEFAULT_MODEL——那是「实测可用」的最小集合，
// 但上游其实下发了完整模型表（get_detail_param 返回 42 个），带显示名、
// 消耗倍率、上下文窗口、会员折扣。硬编码一份等于让用户看不到自己能选什么。
//
// 端点与请求形状（实测 2026-09-25）：
//   POST {AGENT_HOST}/api/ide/v1/get_detail_param
//   body: {"function":"solo_work_lite"}   ← 必须带，空 body 只回空表
//   响应: { allow_tenant_user_add_model, config_info_list: [...], metadata }
//
// **消耗倍率在 display_contact_config 里，且它是 JSON 字符串不是对象**：
//   {"consumption_rate":{"enable":true,"data":{"rate":0.78}},
//    "discount":{"enable":true,"data":{"original_consumption_rate":0.78,
//                                     "consumption_rate":0.39,"member_discount":50,
//                                     "is_discount_matched":false}}}
// 即「原价 0.78 / 会员价 0.39 / 打 5 折，但本账号未命中」。四个都要给出去——
// 只显示一个数字会让人以为自己扣的是会员价。
const c = require('./constants');
const { soloHeaders } = require('./headers');
const authStore = require('./auth');
const tnc = require('./tnc');
const { createModelsCache, scopeKey, scopeId, parseScope } = require('./models-cache');

// 模型表基本不变（随客户端版本走），但 341KB 每次拉太重，必须缓存。
//
// **缓存按「作用域」分，不再只按区域分**（2026-11-16，调研 P0-1）。
//
// 2026-11-03 只按 region 分是因为「两区的模型表不同」，那条结论本身没错；错的是
// 取数账号：`accountForRegion()` 给的是**该区第一个可用账号**，而模型表里有一半
// 字段是账号相关的（消耗倍率/会员折扣、reasoning 档位、max_mode、multimodal）。
// 一个区里第二、第三个账号看到的是第一个号的能力表 —— 响应 200、能力判断可能错，
// 属于本项目最怕的静默故障。口径见 src/traework/models-cache.js 头注释。
//
// 降级路径保持不变：所有老调用方（只传 region）读的是**该区最新一次成功的快照**，
// 行为与改造前一致；只有显式传 accountId 的调用方拿到账号级视图。
const CACHE_MS = parseInt(process.env.DUMATE_TRAEWORK_MODELS_CACHE_MS || '300000', 10);
// 作用域条数上限（每区每账号一条）。默认 8：够覆盖常见「国内 3 号 + 国际 2 号」，
// 又不会让账号多的人把内存和上游请求都撑起来。
const SCOPE_CAP = parseInt(process.env.DUMATE_TRAEWORK_MODELS_CACHE_SCOPES || '8', 10);
const modelsCache = createModelsCache({ ttlMs: CACHE_MS, cap: SCOPE_CAP });
/** 这个进程的客户端身份（进请求头，会影响上游下发的能力字段）——作用域的一维 */
const CLIENT_VERSION = c.IDE_VERSION;

/**
 * 国际版静态兜底（hub 的 trae_catalog_intl.json 快照，2026-11 拉取）。
 * 国际版的模型表接口（get_detail_param）未实测能否下发——拿不到时用这份，
 * 避免 /v1/models 与管理端模型页在国际账号下变成空表。**是快照不是权威**，
 * 拿到上游真表后以此为准。
 */
const INTL_FALLBACK_MODELS = [
  'gemini-2.5-pro-latest', 'aws_claude_4.7_opus', 'aws_claude_4.6_sonnet',
  'gemini_2.5_flash_premium', 'gemini_3_flash', 'gemini_3.1_pro',
  'gpt-5.5', 'gpt-6-astra', 'grok-4', 'kimi-k2',
];

/** 区域内的可用账号（没有该区域账号返回 null，调用方如实报错） */
function accountForRegion(region) {
  const reg = c.normalizeRegion(region);
  const usable = authStore.findUsable().filter((a) => c.regionOf(a) === reg);
  return usable[0] || null;
}

/** 该区**全部**可用账号（预热要按账号各取一份，不能再只取第一个） */
function accountsForRegion(region) {
  const reg = c.normalizeRegion(region);
  try {
    return authStore.findUsable().filter((a) => c.regionOf(a) === reg);
  } catch (e) { return []; }
}

/**
 * 作用域：region + accountId + raw_chat_function + 客户端身份。
 *
 * 四维都来自**真实请求材料**，没有发明新维度：
 *   region    两区模型表不同（2026-11-03 实测）
 *   accountId 倍率/折扣、档位、max_mode、multimodal 都按账号下发
 *   fn        `get_detail_param` 的 body 字段（solo_work_lite / personal_assistant）
 *   version   客户端身份进请求头，直接影响能力字段（与 TRAE IDE 版本同步）
 *
 * @param {object|null} account 账号记录（可空：空时用 '-'，退化成「该区匿名作用域」）
 * @param {string} [region]
 * @param {string} [fn]
 */
function scopeOf(account, region, fn) {
  const reg = c.normalizeRegion(region || (account ? c.regionOf(account) : 'cn'));
  return {
    region: reg,
    accountId: account && account.id ? String(account.id) : '',
    fn: String(fn || c.FUNCTION),
    version: CLIENT_VERSION,
  };
}

/** 作用域 → 给管理端/接口看的小对象（含短指纹，不含凭证） */
function scopeSummary(scope) {
  const s = scope || {};
  const key = modelsScopeKey(s);
  return {
    key,
    id: scopeId(key),
    region: s.region || '',
    accountId: s.accountId || '',
    fn: s.fn || '',
    version: s.version || '',
  };
}

/** 内部：拼键（单独包一层，方便单测与展示共用同一口径） */
function modelsScopeKey(scope) {
  return scopeKey(scope);
}

/**
 * **实测硬限**（2026-10-21，真实请求打出来的）。
 *
 * 上游的 `context_window_tokens.dev` 是**客户端压缩阈值**，不是服务端硬限：
 * 网关以前把它当「最大上下文」展示，于是 1M 的模型也被写成 200K。
 * 实测（同一段英文重复文本，让 usage.prompt_tokens 自报）：
 *
 *   deepseek-v4.1-flash   1,000,036 通过 · 1,050,036 拒（4026 上下文超限）
 *   glm-5.3-flash         1,000,018 通过（未测更高）
 *   Doubao-Seed-2.1-Turbo   260,051 通过 ·   330,000 拒（4026）
 *
 * 结论是**每个模型的硬限不同**，不能按平台统一值填。这里只收录**真正测过**
 * 的模型，其余一律 null —— 与项目一贯口径一致：不估算、不拿同类模型的值顶上。
 * 新增模型想补这一列，用 test/probe-traework-context.js 实测后再加。
 */
const MEASURED_HARD_CONTEXT = {
  'deepseek-v4.1-flash': {
    max: 1000000,
    note: '实测 1,000,036 token 通过，1,050,036 被拒（4026）；上游声明 200K 只是客户端压缩阈值',
  },
  'glm-5.3-flash': {
    max: 1000000,
    note: '实测 1,000,018 token 通过（未测更高）；上游声明 200K 只是客户端压缩阈值',
  },
  'Doubao-Seed-2.1-Turbo': {
    max: 260000,
    note: '实测 260,051 token 通过、330,000 被拒（4026）；与上游声明的 256K 基本一致',
  },
};

/** 输出上限实测（2026-10-30）：max_tokens=131072（budget.js 顶格值）真机 200
 *  正常出流——TRAE 上游的输出预算接受 131072，与搭子同限，无需独立钳制。 */

/** display_contact_config 是 JSON 字符串，解析失败当空对象 */
function parseContact(raw) {
  try {
    const j = JSON.parse(raw || '{}');
    return j && typeof j === 'object' ? j : {};
  } catch (e) { return {}; }
}

function num(v) {
  return v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
}

/** 上游条目 → 界面用的扁平结构 */
function normalize(m) {
  const hard = MEASURED_HARD_CONTEXT[m && m.config_name] || null;
  const dc = m.display_config || {};
  const cc = parseContact(m.display_contact_config);
  const cr = (cc.consumption_rate && cc.consumption_rate.data) || {};
  const disc = (cc.discount && cc.discount.data) || {};
  // model_detail_list 里第一条是本模型的运行参数（max_tokens / 上下文上限）
  const detail = (m.model_detail_list || [])[0] || {};
  return {
    id: m.config_name,
    // 显示名可能为空（内部模型），回落 id
    name: dc.display_name || m.config_name,
    prefixed: `traework/${m.config_name}`,
    // 消耗倍率。接口不给就留 null——界面显示 —，补 0 会被读成「免费」
    rate: num(cr.rate),
    // 会员折扣：原价 / 折后价 / 折扣力度 / 本账号是否命中
    rateOriginal: num(disc.original_consumption_rate),
    rateDiscounted: num(disc.consumption_rate),
    memberDiscount: num(disc.member_discount),
    discountMatched: !!disc.is_discount_matched,
    contextWindow: num(m.context_window_tokens && m.context_window_tokens.dev),
    // 服务端实测硬限（上面 MEASURED_HARD_CONTEXT）。为 null 表示**没测过**，
    // 界面应显示「未实测」，而不是拿 contextWindow 充数
    contextWindowHard: hard ? hard.max : null,
    contextHardNote: hard ? hard.note : '',
    maxTokens: num(detail.max_tokens),
    promptMaxTokens: num(detail.prompt_max_tokens),
    capability: dc.model_capability || '',
    multimodal: !!dc.multimodal,
    isBeta: !!dc.is_beta,
    isNew: !!dc.is_new,
    isDefault: !!m.is_default,
    // 客户端可见性：隐藏的多是内部模型（子代理、自定义占位、压缩用 summary）
    visible: !m.is_invisible_to_user,
    // 套餐门槛（调研 P2-11）：**只认上游 descriptor 的显式字段**。
    // 上游没给就是 null（界面不显示徽标），不按模型名/隐藏状态猜
    // ——国际表里隐藏的也可能只是内部子代理，猜成「需升级」会误导。
    upgradeRequired: (m.upgrade_required === true || m.require_upgrade === true
      || m.subscription_only === true || m.paid_only === true) ? true : null,
    // 上游声明的用途，chat_completion 之外的多半不是给对话用的
    usage: m.usage || '',
    // 该条目名下的自定义模型名（如 "gemini//gemini-3-flash-preview"）。
    // 它们不是顶层 config_name，模型名前置校验要把它们也算「已知」，
    // 否则用自定义模型的请求会被误判成「模型不在表中」
    customModelIds: Array.isArray(m.custom_models) ? m.custom_models.map((x) => String(x)) : [],
    // **上游原始对象**（remote manual 策略的 custom_model 字段要它的完整
    // 形状——Trae2api-cn 的 resolve_model_config 产物就是上游返回的整行，
    // 归一化字段子集重构不出来）。只读引用，归一化行不序列化落盘。
    customModel: m || null,
    // 思考档位摘要（2026-11-06，前端模型卡展示）：descriptor 显式声明
    // support_thinking 且给出 options 才有——模型名不是能力证据。
    // 判据与 remote.supportedLevels 一致（内联避免数据层依赖传输层）。
    reasoningEfforts: (() => {
      const cfg = m.reasoning_effort_config || m.reasoningEffortConfig;
      if (!cfg || typeof cfg !== 'object' || cfg.support_thinking !== true) return null;
      const opts = Array.isArray(cfg.options) ? cfg.options : [];
      const levels = ['light', 'high', 'extra_high'].filter((l) => opts.map(String).includes(l));
      return levels.length ? levels : null;
    })(),
    // 1M Max 摘要：descriptor 显式 max_mode + detail 的输入/输出上限齐备。
    // 与 remote.supportsMaxMode 同判据（≥1M 的上下文由 maxModeFields 从
    // context_window_size(s) 取，这里只做「声明了没」的摘要）。
    maxMode: m.max_mode === true
      && Number(detail.prompt_max_tokens) > 0
      && Number(detail.max_tokens) > 0,
  };
}

/**
 * 找账号（按 id）。取不到返回 null——调用方要如实报错，不要静默换成别人的号。
 * @param {string} id
 */
function findAccount(id) {
  const want = String(id || '').trim();
  if (!want) return null;
  try { return authStore.get(want) || null; } catch (e) { return null; }
}

/** 该区没有账号时的错误文案（两区不同，别混成一句） */
function regionError(reg) {
  return reg === 'intl'
    ? '没有可用的国际账号（需先登录一个国际版账号）'
    : '没有可用账号（需先登录）';
}

/**
 * 拉模型表（带缓存，作用域见 scopeOf）。
 *
 * 三种读法，语义不同，不要混：
 *   1. 传 accountId → **账号级**：这份表就是这个账号的能力（倍率/档位/max_mode 都对）
 *   2. 只传 region  → 该区最近一次成功的快照（老行为，保持兼容）
 *   3. 同步读者（cachedXxx）→ 该区所有作用域**聚合**，能力字段按「不虚报」方向合并
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]     跳过缓存（管理端「刷新」；仍参与单飞）
 * @param {string}  [opts.region]    'cn'（缺省）| 'intl'
 * @param {string}  [opts.accountId] 指定取数账号（缺省 = 该区第一个可用账号）
 * @param {string}  [opts.fn]        `get_detail_param` 的 function（缺省 solo_work_lite）
 * @param {boolean} [opts.noJoin]    不用单飞（只在单测里用，生产别传）
 * @returns {Promise<{ok:boolean, error:string, models:Array, fetchedAt:number,
 *                    scope:object, cacheScope:string, cached?:boolean}>}
 */
async function fetchModels({ force = false, region = 'cn', accountId = '', fn = '', noJoin = false } = {}) {
  const reg = c.normalizeRegion(region);
  const auth = accountId ? findAccount(accountId) : accountForRegion(reg);
  const scope = scopeOf(auth, reg, fn);
  const summary = scopeSummary(scope);
  const key = modelsScopeKey(scope);

  if (!auth) {
    return {
      ok: false, error: regionError(reg), models: [], fetchedAt: 0,
      scope: summary, cacheScope: summary.id,
    };
  }

  if (!force) {
    const hit = modelsCache.get(key);
    // 命中即续期（get 内部已 touch usedAt），并把作用域摘要带上——
    // 管理端要能回答「这张表是谁取的」
    if (hit) return { ...hit, scope: summary, cacheScope: summary.id, cached: true };
  }

  const run = () => doFetchModels({ auth, reg, fn, scope });
  let out;
  try {
    out = noJoin ? await run() : await modelsCache.single(key, run);
  } catch (e) {
    out = { ok: false, error: e.message, models: [], fetchedAt: 0 };
  }
  return { ...(out || {}), scope: summary, cacheScope: summary.id };
}

/**
 * 真正打上游那一段（单飞 producer：同一作用域并发只跑一次）。
 *
 * 拉失败**不覆盖旧缓存**——上游抖动不该让界面变成空表，也不该让能力校验
 * 从「已知不支持」退化成「未知放行」（那是另一种错）。
 */
async function doFetchModels({ auth, reg, fn, scope }) {
  const key = modelsScopeKey(scope);
  // 出站代理（E 包收口补点）：模型表与对话同出口。配置非法按拉取失败返回。
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(auth); } catch (e) {
    return { ok: false, error: e.message, models: [], fetchedAt: 0 };
  }
  // 基址候选链（tnc.js）：连接级失败换下一家，与 chat.postStream 同一规则
  const hosts = await tnc.agentHosts(auth);
  let r = null;
  for (const host of hosts) {
    r = await c.request(host, c.EP_MODELS, {
      method: 'POST',
      // **必须带 function**：空 body 上游只回空表（实测 config_info_list: []）。
      // 这个值也进作用域——不同 function 下发的表不同（Agent/Work 档位就是它）。
      body: { function: String(fn || c.FUNCTION) },
      headers: soloHeaders(auth),
      timeout: 60000,
      agent,
    });
    if (r.status !== 0) break;   // 拿到响应（含 4xx/5xx）就不再换基址
    if (!/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|connect timeout|socket hang up|certificate|timeout/i.test(String(r.error || ''))) break;
  }
  if (r.status !== 200 || !r.data) {
    return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}`, models: [], fetchedAt: 0 };
  }
  const raw = Array.isArray(r.data.config_info_list) ? r.data.config_info_list : [];
  const models = raw.filter(Boolean).map(normalize);
  const out = { ok: true, error: '', models, fetchedAt: Date.now() };
  if (models.length) modelsCache.set(key, out, scope);
  return out;
}

/**
 * 单条目是不是「可用对话模型」。usableIds 与管理端模型信息表共用这一份判定——
 * 口径写两份必然漂移（测试台/模型页已经吃过全量 51 条的亏：subagent、
 * custom_model 占位、summary 全混在对话模型里）。
 *
 * 过滤条件是「对话模型 + 客户端可见」：上游的 usage 字段把 27 个标成
 * chat_completion，但其中 9 个是**内部模型**（computer_use_subagent、
 * browser_use_subagent、file_search_agent、explore_sub_agent_v2 这类
 * 子代理，以及种子模型的历史版本），它们 is_invisible_to_user=true；
 * 另有 custom_model_* 占位与 summary（usage 不是 chat_completion），
 * 全列出来会让下拉里塞满用户根本不该选的名字。
 */
function isUsableRow(m) {
  return !!m && m.visible && (m.usage === 'chat_completion' || !m.usage);
}

/**
 * 可调用模型 id 列表（给网关 /v1/models 用）。
 *
 * 取不到时回落静态表里的 DEFAULT_MODEL——网关的模型列表空了会让客户端
 * 直接报「没有可用模型」，比少列几个严重。
 */
function usableIds(list) {
  return list.filter(isUsableRow).map((m) => m.id);
}

async function listModelIds() {
  const r = await fetchModels();
  const ids = usableIds(r.models);
  return ids.length ? ids : [c.DEFAULT_MODEL];
}

/**
 * 该区所有**有数据**的作用域（新→旧）。聚合读法的唯一原料来源。
 * 只用未过期条目：过期数字比缺失更害人（与搭子倍率缓存同一条纪律）。
 */
function regionDatas(region) {
  const reg = c.normalizeRegion(region);
  return modelsCache.datasOf(reg)
    .map((e) => e.data)
    .filter((d) => d && Array.isArray(d.models) && d.models.length);
}

/**
 * 读缓存。两种语义：
 *   cacheOf(region)                 → 该区最新一次成功的快照（老行为）
 *   cacheOf(region, {accountId})    → **该账号**那一份（不存在就 null，不拿别人的顶）
 */
function cacheOf(region, opts = {}) {
  const reg = c.normalizeRegion(region);
  const acc = opts.accountId ? String(opts.accountId).trim() : '';
  if (!acc) return modelsCache.latest(reg);
  const key = modelsScopeKey(scopeOf({ id: acc, region: reg }, reg, opts.fn));
  return modelsCache.entry(key);
}

/**
 * 多作用域合并成一行。**每个字段的合并方向不同，不是「取最新」了事**：
 *
 *   multimodal      OR   —— 校验口径是「只挡确知不支持」，任一账号支持就算能用
 *   maxMode         AND  —— 虚报 1M 会直接吃上游 400，宁可少开
 *   upgradeRequired any  —— 有账号需要升级就别把它标成免费
 *   contextWindow / maxTokens / promptMaxTokens  min —— 上限只能保守，写大了必 400
 *   reasoningEfforts     全都有才取交集；任一没声明就 null（不承诺不存在的档位）
 *   rate           一致才用；不一致标 rateScopeAmbiguous（会员折扣按账号不同，正常现象）
 *
 * @param {Array<object>} rows 同一模型在不同作用域下的归一化行（新→旧）
 */
function mergeRows(rows) {
  const list = (rows || []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const base = { ...list[0] };
  const minOf = (field) => {
    const vals = list.map((r) => r[field]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    return vals.length ? Math.min(...vals) : null;
  };

  base.multimodal = list.some((r) => r.multimodal === true);
  base.maxMode = list.every((r) => r.maxMode === true);
  base.upgradeRequired = list.some((r) => r.upgradeRequired === true) ? true : null;
  base.contextWindow = minOf('contextWindow');
  base.contextWindowHard = minOf('contextWindowHard');
  base.maxTokens = minOf('maxTokens');
  base.promptMaxTokens = minOf('promptMaxTokens');

  const efforts = list.map((r) => (Array.isArray(r.reasoningEfforts) ? r.reasoningEfforts : null));
  base.reasoningEfforts = efforts.every((e) => Array.isArray(e) && e.length)
    ? efforts.reduce((acc, cur) => acc.filter((x) => cur.includes(x)))
    : null;

  const rates = list.map((r) => r.rate).filter((v) => typeof v === 'number');
  const ratesAgree = rates.length < 2 || rates.every((v) => v === rates[0]);
  if (!ratesAgree) base.rateScopeAmbiguous = true;

  // 合并过的事实要能被看见：否则「为什么这里说支持图像」无从回答
  base.mergedScopes = list.length;
  return base;
}

/**
 * 同步取可用模型 id。**跨作用域取并集**：同一区里 A 号能用的模型 B 号可能没有，
 * 只报一份会把能用的模型藏起来（模型列表空了，客户端直接说「没有可用模型」）。
 */
function cachedModelIds(region = 'cn') {
  const datas = regionDatas(region);
  const seen = new Set();
  const ids = [];
  for (const d of datas) {
    for (const id of usableIds(d.models)) {
      const k = String(id).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      ids.push(id);
    }
  }
  if (ids.length) return ids;
  const reg = c.normalizeRegion(region);
  return reg === 'intl' ? [...INTL_FALLBACK_MODELS] : [c.DEFAULT_MODEL];
}

/**
 * 同步取单个模型的元数据（多模态 / Max 校验用）。
 *
 * 未预热返回 null——校验方对 null 放行（宁可不挡，也不能因为模型表没就绪
 * 挡住能用的请求）。region ''（未限定）时两区都查，先国内后国际。
 * 多作用域命中时按 mergeRows 的方向合并（能力取宽、上限取窄）。
 */
function cachedMetaById(id, region = 'cn', opts = {}) {
  const want = String(id || '').trim().toLowerCase();
  if (!want) return null;
  const regs = region ? [c.normalizeRegion(region)] : ['cn', 'intl'];
  const rows = [];
  for (const reg of regs) {
    const datas = opts.accountId
      ? (() => {
        const hit = cacheOf(reg, { accountId: opts.accountId, fn: opts.fn });
        return hit && hit.data && Array.isArray(hit.data.models) ? [hit.data] : [];
      })()
      : regionDatas(reg);
    for (const d of datas) {
      const found = d.models.find((m) => String(m.id || '').toLowerCase() === want);
      if (found) rows.push(found);
    }
  }
  return rows.length ? mergeRows(rows) : null;
}

/** 缓存里客户端可见的多模态模型 id（跨作用域并集；给「不支持图像」的报错信息用） */
function multimodalIds(region = 'cn') {
  const byId = new Map();
  for (const d of regionDatas(region)) {
    for (const m of d.models) {
      if (!m.visible || !m.multimodal) continue;
      if (m.usage && m.usage !== 'chat_completion') continue;
      byId.set(String(m.id).toLowerCase(), m.id);
    }
  }
  return [...byId.values()];
}

/** 模型表缓存是否就绪（任一作用域有数据即就绪；前置校验只在就绪时生效） */
function hasCache(region = 'cn') {
  return regionDatas(region).length > 0;
}

/**
 * 模型名是否已知：顶层 config_name 或任一条目名下的自定义模型。大小写不敏感。
 *
 * region：'cn'/'intl' 查那一区；''（未限定）两区任一命中即算已知——
 * 未限定区域的请求可能被派给任一区的账号，只查一区会把对方区的合法模型误判成未知。
 * 任一作用域认识即算认识（同一区多账号的表可能不同）。
 */
function isKnownModel(id, region = 'cn') {
  const regs = region ? [c.normalizeRegion(region)] : ['cn', 'intl'];
  const want = String(id || '').trim().toLowerCase();
  if (!want) return true;
  let anyCache = false;
  for (const reg of regs) {
    for (const d of regionDatas(reg)) {
      anyCache = true;
      for (const m of d.models) {
        if (String(m.id || '').toLowerCase() === want) return true;
        if (Array.isArray(m.customModelIds)
          && m.customModelIds.some((x) => String(x).toLowerCase() === want)) return true;
      }
    }
  }
  // 没有任何就绪缓存：放行（与旧口径一致——表没就绪不当闸）
  return !anyCache;
}

/**
 * 带元信息的模型条目（给 /v1/models 用）。
 *
 * 为什么需要：cc-switch 解析模型列表读 `name` / `contextWindow`
 * （实测其二进制里与 `owned_by` 相邻的字段是 id/name/cost/contextWindow/
 * maxContextWindow）。只给 id 的话客户端只能显示 `traework/glm-5.2`
 * 这种内部 key，看不出是哪个模型。
 *
 * 跨作用域按 id 合并：contextWindow 取**最小**——它是 cc-switch 的压缩阈值，
 * 写大了会让客户端带着超限历史来撞 400。顺序保持「第一个作用域里的顺序」。
 */
function cachedModelEntries(region = 'cn') {
  const datas = regionDatas(region);
  const order = [];
  const rowsById = new Map();
  for (const d of datas) {
    for (const m of d.models) {
      if (!m.visible) continue;
      if (m.usage && m.usage !== 'chat_completion') continue;
      const k = String(m.id || '').toLowerCase();
      if (!rowsById.has(k)) { rowsById.set(k, []); order.push(k); }
      rowsById.get(k).push(m);
    }
  }
  if (order.length) {
    return order.map((k) => {
      const merged = mergeRows(rowsById.get(k));
      return {
        id: merged.id,
        name: merged.name || merged.id,
        // cc-switch 用这个值决定何时压缩历史：优先给**实测硬限**，
        // 没测过才退回上游声明值（宁可保守，也不能虚报导致长会话 400）
        contextWindow: merged.contextWindowHard || merged.contextWindow || null,
        maxContextWindow: merged.contextWindowHard || merged.contextWindow || null,
      };
    });
  }
  if (c.normalizeRegion(region) === 'intl') {
    return INTL_FALLBACK_MODELS.map((k) => ({ id: k, name: k, contextWindow: null, maxContextWindow: null }));
  }
  return [{ id: c.DEFAULT_MODEL, name: c.DEFAULT_MODEL, contextWindow: null, maxContextWindow: null }];
}

/** 管理端：当前缓存里的作用域清单（谁取的表、多久前、过期没、几条） */
function cacheScopes(region = '') {
  return modelsCache.scopes(region ? c.normalizeRegion(region) : '');
}

/** 管理端「清缓存重取」：清掉该区（'') = 全部）后下次 fetch 必打上游 */
function clearModelCache(region = '') {
  modelsCache.clear(region ? c.normalizeRegion(region) : '');
  return { ok: true, region: region ? c.normalizeRegion(region) : '', scopes: cacheScopes(region) };
}

/** 缓存命中统计（排查「为什么又打了一次上游」） */
function cacheStats() {
  return modelsCache.stats();
}

module.exports = {
  fetchModels, listModelIds, cachedModelIds, cachedModelEntries, cachedMetaById, multimodalIds,
  hasCache, isKnownModel, isUsableRow, usableIds, normalize,
  // 作用域相关（2026-11-16 P0-1）
  scopeOf, scopeSummary, mergeRows, accountsForRegion, findAccount,
  cacheOf, cacheScopes, cacheStats, clearModelCache,
  CACHE_MS, SCOPE_CAP, MEASURED_HARD_CONTEXT, INTL_FALLBACK_MODELS, accountForRegion,
};
