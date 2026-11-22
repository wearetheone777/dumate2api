// src/workbuddy/busy.js - 模型实时繁忙度探针（2026-11-08 融合批）
//
// 出处：GitHub 生态调研（dsh-connect-workbuddy 的 `POST /v2/chat/busy`；
// linguo2625469/workbuddy2api-panel 母版把它用在选号前的队列规避上）。
//
// **它解决什么问题**：现在选号是「撞上 429 才知道排队」。而这个接口能在
// 请求之前就告诉你目标模型当前是 idle / normal / busy / congested / unavailable，
// 且**免费、不扣额度、不动账号状态**（纯读）。
//
// 三个硬事实（实测，写死在代码里，别凭直觉改）：
//   1. **国际版 404**：只有国内有这个端点。404 必须当成「没有繁忙度信息」，
//      不是「通道坏了」——否则国际账号每次请求都会误判成故障。
//   2. **≤50 个模型 id 一批**：超了上游报错。这里自动分批。
//   3. **免费**：不要把它当模型调用记账，也不要为它做冷却。
//
// 设计取舍：**只做「提示」不做「拦截」**（默认）。繁忙度是上游的瞬时估算，
// 用它硬拦请求会在上游抖动时把整条通道弄停——这与「护栏是选号过滤不是请求
// 拦截」是同一条纪律。要拦截必须显式开 `DUMATE_WORKBUDDY_BUSY_GUARD=1`。
const c = require('./constants');

const MAX_IDS_PER_CALL = 50;

/** 繁忙度档位（上游返回值，从松到紧） */
const LEVELS = ['idle', 'normal', 'busy', 'congested', 'unavailable'];

/** 该档位是否「明显该避开」（默认只把这两档当提示） */
function isCrowded(level) {
  return level === 'congested' || level === 'unavailable';
}

/** 归一化上游返回值：不认识的值归 normal（不编造紧迫性） */
function normalizeLevel(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return LEVELS.includes(s) ? s : 'normal';
}

/**
 * 解析 `/v2/chat/busy` 的响应体。上游形状未完全公开，这里宽容处理三种可能：
 *   { data: { models: [{ id/model, level/status }] } }
 *   { data: { "glm-5": "busy", ... } }
 *   { data: [{ id, level }] }
 * 无法识别的形状返回空对象而不是抛——探针失败不该影响主流程。
 * @returns {Record<string,string>} model → level
 */
function parseBusy(doc) {
  const out = {};
  try {
    const data = doc && typeof doc === 'object' ? (doc.data !== undefined ? doc.data : doc) : null;
    if (!data) return out;
    if (Array.isArray(data)) {
      for (const it of data) {
        if (!it || typeof it !== 'object') continue;
        const id = it.model || it.id || it.model_id;
        if (!id) continue;
        out[String(id)] = normalizeLevel(it.level || it.status || it.busy);
      }
      return out;
    }
    if (typeof data === 'object') {
      const list = data.models || data.list;
      if (Array.isArray(list)) return parseBusy({ data: list });
      for (const [k, v] of Object.entries(data)) {
        // 只收「值是繁忙度词」的键，避免把别的字段（如 total）当成模型
        if (typeof v === 'string' && LEVELS.includes(v.trim().toLowerCase())) {
          out[k] = normalizeLevel(v);
        }
      }
    }
  } catch (e) { /* 形状不认识就当没有信息 */ }
  return out;
}

/** 把 id 列表切成 ≤50 一批 */
function chunkIds(ids) {
  // **先滤空值再 String()**：`String(null)` 得到 'null'、`String(undefined)` 得到
  // 'undefined'——这两个假 id 会被塞进请求体，上游按「未知模型」报错，
  // 整批繁忙度查询因此失败。测试当场抓到的（2026-11-08）。
  const arr = [...new Set((ids || [])
    .filter((x) => x != null && x !== '')
    .map((x) => String(x))
    .filter(Boolean))];
  const out = [];
  for (let i = 0; i < arr.length; i += MAX_IDS_PER_CALL) out.push(arr.slice(i, i + MAX_IDS_PER_CALL));
  return out;
}

/**
 * 查一批模型的繁忙度。
 *
 * @param {'cn'|'global'} region
 * @param {object} account 账号（凭证 + 出站代理）
 * @param {string[]} modelIds
 * @returns {Promise<{ok:boolean, levels:Record<string,string>, unsupported?:boolean,
 *   crowded:string[], error?:string}>}
 *   `unsupported:true` = 国际版（404），**不是错误**，调用方应静默跳过
 */
async function fetchBusy(region, account, modelIds) {
  const reg = c.normalizeRegion(region);
  const ids = (modelIds || []).map((x) => String(x)).filter(Boolean);
  if (!ids.length) return { ok: true, levels: {}, crowded: [] };

  const spec = c.specOf(reg);
  const u = new URL(spec.chatBase + c.EP_CHAT_BUSY);
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
    return { ok: false, levels: {}, crowded: [], error: `出站代理配置错误: ${e.message}` };
  }
  const levels = {};
  let unsupported = false;

  for (const chunk of chunkIds(ids)) {
    const body = JSON.stringify({ models: chunk });
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': reg === 'global' ? 'en-US' : 'zh-CN',
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
      'X-CodeBuddy-Request': '1',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Product': 'SaaS',
      Origin: spec.billingBase,
      Referer: `${spec.billingBase}/`,
      'User-Agent': c.CLIENT_UA,
      Authorization: `Bearer ${(account && account.accessToken) || ''}`,
    };
    if (account && account.uid) headers['X-User-Id'] = account.uid;
    if (account && account.enterpriseId) headers['X-Enterprise-Id'] = account.enterpriseId;
    if (account && account.domain) headers['X-Domain'] = account.domain;

    const r = await new Promise((resolve) => {
      const req = require('https').request({
        hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers,
        ...(agent ? { agent } : {}), timeout: 15000,
      }, (res) => {
        let buf = '';
        const { StringDecoder } = require('string_decoder');
        const dec = new StringDecoder('utf8');
        res.on('data', (x) => { buf += dec.write(x); });
        res.on('end', () => { buf += dec.end(); resolve({ status: res.statusCode, body: buf }); });
      });
      req.on('error', (e) => resolve({ status: 0, body: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
      req.write(body);
      req.end();
    });

    // 国际版没有这个端点：404 = 无繁忙度信息，不是故障
    if (r.status === 404) { unsupported = true; continue; }
    if (r.status < 200 || r.status >= 300) {
      return { ok: false, levels, crowded: [], error: `HTTP ${r.status}: ${String(r.body).slice(0, 160)}` };
    }
    let doc = null;
    try { doc = JSON.parse(r.body); } catch (e) { /* 非 JSON */ }
    Object.assign(levels, parseBusy(doc));
  }

  const crowded = Object.entries(levels).filter(([, v]) => isCrowded(v)).map(([k]) => k);
  return { ok: true, levels, crowded, ...(unsupported ? { unsupported: true } : {}) };
}

/** 是否启用「繁忙度拦选号」（默认关；开了才挡） */
function guardEnabled() {
  return String(process.env.DUMATE_WORKBUDDY_BUSY_GUARD || '').trim() === '1';
}

module.exports = {
  MAX_IDS_PER_CALL, LEVELS,
  isCrowded, normalizeLevel, parseBusy, chunkIds, fetchBusy, guardEnabled,
};
