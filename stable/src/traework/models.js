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

// 模型表基本不变（随客户端版本走），但 341KB 每次拉太重，必须缓存。
// **按区域分缓存**（2026-11-03 国际版接入）：两区的模型表不同（国内 GLM/豆包系、
// 国际 Gemini/Claude/GPT 系），共用一份会互相覆盖。
const CACHE_MS = parseInt(process.env.DUMATE_TRAEWORK_MODELS_CACHE_MS || '300000', 10);
const caches = new Map(); // region('cn'|'intl') -> { at, data }

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
    // 客户端可见性：隐藏的多是内部模型（子代理、自定义占位、压缩用的 summary）
    visible: !m.is_invisible_to_user,
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
  };
}

/**
 * 拉模型表（带缓存，**按区域分**）。
 * @param {{force?:boolean, region?:string}} opts region 'cn'（缺省）| 'intl'
 * @returns {Promise<{ok:boolean, error:string, models:Array, fetchedAt:number}>}
 */
async function fetchModels({ force = false, region = 'cn' } = {}) {
  const reg = c.normalizeRegion(region);
  const hit = caches.get(reg);
  if (!force && hit && hit.data && Date.now() - hit.at < CACHE_MS) return hit.data;

  const auth = accountForRegion(reg);
  if (!auth) {
    return { ok: false, error: reg === 'intl' ? '没有可用的国际账号（需先登录一个国际版账号）' : '没有可用账号（需先登录）', models: [], fetchedAt: 0 };
  }

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
      // **必须带 function**：空 body 上游只回空表（实测 config_info_list: []）
      body: { function: c.FUNCTION },
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
  // 拉失败不覆盖旧缓存——上游抖动不该让界面变成空表
  if (models.length) caches.set(reg, { at: Date.now(), data: out });
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

/** 读某一区域的缓存（未预热返回 null） */
function cacheOf(region) {
  return caches.get(c.normalizeRegion(region)) || null;
}

/** 同步取缓存里的 id（未预热时给静态兜底）。region '' = 只看国内（网关默认口径） */
function cachedModelIds(region = 'cn') {
  const reg = c.normalizeRegion(region);
  const hit = cacheOf(reg);
  if (hit && hit.data && hit.data.models.length) {
    const ids = usableIds(hit.data.models);
    if (ids.length) return ids;
  }
  return reg === 'intl' ? [...INTL_FALLBACK_MODELS] : [c.DEFAULT_MODEL];
}

/**
 * 同步取单个模型的元数据（多模态校验用）。缓存未预热时返回 null——
 * 校验方对 null 放行（宁可不挡，也不能因为模型表没就绪挡住能用的请求）。
 * region ''（未限定）时两份缓存都查——先国内后国际。
 */
function cachedMetaById(id, region = 'cn') {
  const want = String(id || '').trim().toLowerCase();
  const regs = region ? [c.normalizeRegion(region)] : ['cn', 'intl'];
  for (const reg of regs) {
    const hit = cacheOf(reg);
    const models = hit && hit.data && Array.isArray(hit.data.models) ? hit.data.models : null;
    if (!models) continue;
    const found = models.find((m) => String(m.id || '').toLowerCase() === want);
    if (found) return found;
  }
  return null;
}

/** 缓存里客户端可见的多模态模型 id 列表（给「不支持图像」的报错信息用） */
function multimodalIds(region = 'cn') {
  const hit = cacheOf(region);
  if (!hit || !hit.data || !Array.isArray(hit.data.models)) return [];
  return hit.data.models
    .filter((m) => m.visible && m.multimodal && (m.usage === 'chat_completion' || !m.usage))
    .map((m) => m.id);
}

/** 模型表缓存是否就绪（前置校验只在就绪时生效，没就绪一律放行） */
function hasCache(region = 'cn') {
  const hit = cacheOf(region);
  return !!(hit && hit.data && Array.isArray(hit.data.models) && hit.data.models.length);
}

/**
 * 模型名是否已知：顶层 config_name 或任一条目名下的自定义模型。大小写不敏感。
 * region：'cn'/'intl' 查那一区；''（未限定）两区任一命中即算已知——
 * 未限定区域的请求可能被派给任一区的账号，只查一区会把对方区的合法模型误判成未知。
 */
function isKnownModel(id, region = 'cn') {
  const regs = region ? [c.normalizeRegion(region)] : ['cn', 'intl'];
  const want = String(id || '').trim().toLowerCase();
  if (!want) return true;
  let anyCache = false;
  for (const reg of regs) {
    const hit = cacheOf(reg);
    if (!hit || !hit.data || !Array.isArray(hit.data.models) || !hit.data.models.length) continue;
    anyCache = true;
    for (const m of hit.data.models) {
      if (String(m.id || '').toLowerCase() === want) return true;
      if (Array.isArray(m.customModelIds)
        && m.customModelIds.some((x) => String(x).toLowerCase() === want)) return true;
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
 */
function cachedModelEntries(region = 'cn') {
  const hit = cacheOf(region);
  if (hit && hit.data && hit.data.models.length) {
    const list = hit.data.models.filter((m) => m.visible && (m.usage === 'chat_completion' || !m.usage));
    if (list.length) {
      return list.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        // cc-switch 用这个值决定何时压缩历史：优先给**实测硬限**，
        // 没测过才退回上游声明值（宁可保守，也不能虚报导致长会话 400）
        contextWindow: m.contextWindowHard || m.contextWindow || null,
        maxContextWindow: m.contextWindowHard || m.contextWindow || null,
      }));
    }
  }
  if (c.normalizeRegion(region) === 'intl') {
    return INTL_FALLBACK_MODELS.map((k) => ({ id: k, name: k, contextWindow: null, maxContextWindow: null }));
  }
  return [{ id: c.DEFAULT_MODEL, name: c.DEFAULT_MODEL, contextWindow: null, maxContextWindow: null }];
}

module.exports = { fetchModels, listModelIds, cachedModelIds, cachedModelEntries, cachedMetaById, multimodalIds, hasCache, isKnownModel, isUsableRow, usableIds, normalize, CACHE_MS, MEASURED_HARD_CONTEXT, INTL_FALLBACK_MODELS, accountForRegion };
