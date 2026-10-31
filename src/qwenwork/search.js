// src/qwenwork/search.js - 千问办公的联网搜索与图搜
//
// 两个端点是 2026-10-31 解包官方 1.4.0 客户端时挖到的
// （docs/QWENWORK-CLIENT-1.4.0-ANALYSIS.md §3），此前清单里没有：
//   POST /algo/api/v1/webSearch/oneSearch   联网搜索
//   POST /algo/api/v2/service/pro/imageSearch 图片搜索
//
// 它们与对话链路**不是同一套请求形状**：不是 `chat_context`，而是
// `{payload: JSON.stringify(<业务参数>), encodeVersion:"1"}` —— 业务参数被
// **二次序列化**进 payload 字段。签名仍是 COSY（客户端的 `withWasmSigning()`
// 就是我们已实现的 Encode=1 那套），所以能直接复用 cosy-sign。
//
// 客户端原始代码（worker runtime obf，两处）：
//
//   webSearch（mUt.search）：
//     e = { query, [allowed_domains], [blocked_domains],
//           timeRange:"NoLimit",
//           contents:{ mainText:false, markdownText:false, summary:false } }
//     builder().post("/algo/api/v1/webSearch/oneSearch")
//             .withWasmSigning().requireLogin()
//             .json({ payload: JSON.stringify(e), encodeVersion:"1" })
//
//   imageSearch（hUt.search）：
//     .post("/algo/api/v2/service/pro/imageSearch").query({Encode:"1"})
//     .withBearerToken().withWasmSigning().requireLogin()
//     .json({ payload: JSON.stringify({query, count}), encodeVersion:"1",
//             requestId, timestamp:String(Math.floor(Date.now()/1e3)) })
//
// 注意 imageSearch **多两个字段**（requestId / timestamp），且 count 必须在
// [1, 10]——客户端自己就先校验了，越界直接抛错不发请求。
//
// 响应解析（客户端 tkd / rkd，这里按同一套字段名归一）：搜索结果是
// `pageItems`（也写作 `page_items`），每项 title/link/snippet/publishedTime/
// hostname；图搜结果字段名上游有多种写法，客户端按候选表取第一个命中的。
const https = require('https');
const crypto = require('crypto');
const c = require('./constants');
const sign = require('./cosy-sign');
const authStore = require('./auth');
const chat = require('./chat');

const TIMEOUT_MS = 60000;

/** 图搜的 count 范围（客户端硬校验，越界直接拒） */
const IMAGE_COUNT_MIN = 1;
const IMAGE_COUNT_MAX = 10;

/**
 * webSearch 的请求体（纯函数，便于离线验证形状）。
 *
 * `contents` 三个开关客户端一律 false（正文/降级正文/摘要都不要）——它只要
 * 标题+链接+片段。保持 false 有两个好处：响应体小、上游不为我们没用到的东西
 * 做额外抓取。想要全文时再开，但那是产品决策，不是网关默认。
 */
function buildWebSearchPayload({ query, allowedDomains, blockedDomains } = {}) {
  const q = String(query || '').trim();
  if (!q) {
    const err = new Error('搜索关键词不能为空（query）');
    err.statusCode = 400;
    throw err;
  }
  const body = { query: q };
  if (Array.isArray(allowedDomains) && allowedDomains.length) body.allowed_domains = allowedDomains;
  if (Array.isArray(blockedDomains) && blockedDomains.length) body.blocked_domains = blockedDomains;
  body.timeRange = 'NoLimit';
  body.contents = { mainText: false, markdownText: false, summary: false };
  return body;
}

/** imageSearch 的请求体（纯函数）。count 越界按客户端同一规则拒绝 */
function buildImageSearchPayload({ query, count } = {}) {
  const q = String(query || '').trim();
  if (!q) {
    const err = new Error('图片搜索关键词不能为空（query）');
    err.statusCode = 400;
    throw err;
  }
  const n = count == null ? IMAGE_COUNT_MAX : Number(count);
  if (!Number.isInteger(n) || n < IMAGE_COUNT_MIN || n > IMAGE_COUNT_MAX) {
    const err = new Error(`图片搜索的 count 必须是 ${IMAGE_COUNT_MIN}~${IMAGE_COUNT_MAX} 的整数`);
    err.statusCode = 400;
    throw err;
  }
  return { query: q, count: n };
}

/** 归一化一条搜索结果为统一形状。字段缺就 null，不补空串（空串会被读成「有值但为空」） */
function normalizeSearchItem(x) {
  if (!x || typeof x !== 'object') return null;
  const pick = (...keys) => {
    for (const k of keys) {
      const v = x[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  };
  const item = {
    title: pick('title'),
    link: pick('link', 'url'),
    snippet: pick('snippet', 'summary', 'description'),
    publishedTime: pick('publishedTime', 'published_time', 'publishTime'),
    hostname: pick('hostname', 'host', 'siteName'),
  };
  // 一条都没有效字段就不算结果，避免把空壳塞进列表
  if (!Object.values(item).some((v) => v != null)) return null;
  return item;
}

/**
 * 解析 webSearch 响应（纯函数）。
 *
 * 客户端 `tkd()` 认的是 `pageItems ?? page_items`；错误码在 `errorCode` /
 * `error_code`（非零 = 业务失败）。它没有外层信封——这个端点直接回业务体。
 */
function parseWebSearchResponse(raw) {
  let j;
  try { j = JSON.parse(String(raw || '').trim()); } catch (e) {
    return { ok: false, error: `响应不是 JSON: ${String(raw || '').slice(0, 160)}` };
  }
  if (!j || typeof j !== 'object') return { ok: false, error: '响应不是对象' };
  const code = Number(j.errorCode ?? j.error_code ?? 0) || 0;
  if (code !== 0) {
    return { ok: false, errorCode: code, error: String(j.errorMsg || j.error_msg || `上游返回 errorCode ${code}`) };
  }
  const list = Array.isArray(j.pageItems) ? j.pageItems
    : Array.isArray(j.page_items) ? j.page_items : [];
  const items = list.map(normalizeSearchItem).filter(Boolean);
  return {
    ok: true,
    requestId: j.requestId || j.request_id || null,
    items,
  };
}

/** 图搜结果的候选字段名（客户端 rkd 的候选表，取第一个命中的） */
function pickFrom(x, keys) {
  for (const k of keys) {
    const v = x[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function normalizeImageItem(x) {
  if (typeof x === 'string' && x.trim()) return { imageUrl: x.trim(), thumbnailUrl: null, sourceUrl: null, title: null, hostname: null, width: null, height: null };
  if (!x || typeof x !== 'object') return null;
  const imageUrl = pickFrom(x, ['imageUrl', 'image_url', 'image', 'url', 'originalUrl', 'originUrl', 'ossUrl', 'link']);
  const thumbnailUrl = pickFrom(x, ['thumbnailUrl', 'thumbnail_url', 'thumbUrl', 'thumb_url', 'thumbnail', 'previewUrl', 'preview_url']);
  const sourceUrl = pickFrom(x, ['sourceUrl', 'source_url', 'pageUrl', 'page_url', 'webpageUrl', 'webpage_url', 'contextUrl', 'context_url', 'hostPageUrl', 'host_page_url']);
  const title = pickFrom(x, ['title', 'name', 'alt', 'description', 'snippet']);
  const hostname = pickFrom(x, ['hostname', 'host', 'source', 'siteName']);
  const w = Number(x.width ?? x.imageWidth);
  const h = Number(x.height ?? x.imageHeight);
  if (!imageUrl && !thumbnailUrl && !sourceUrl && !title) return null;
  return {
    imageUrl: imageUrl || thumbnailUrl || sourceUrl,
    thumbnailUrl,
    sourceUrl,
    title,
    hostname,
    width: Number.isFinite(w) ? w : null,
    height: Number.isFinite(h) ? h : null,
  };
}

/**
 * 解析图搜响应（纯函数）。
 *
 * 结果数组的位置上游有多种写法（客户端 `y5s()` 先按顶层候选名找，再往
 * `data`/`result`/`payload` 里递归一层）。这里实现同一套搜索顺序，
 * **不做无限递归**——客户端也只递归一层。
 */
function parseImageSearchResponse(raw) {
  let j;
  try { j = JSON.parse(String(raw || '').trim()); } catch (e) {
    return { ok: false, error: `响应不是 JSON: ${String(raw || '').slice(0, 160)}` };
  }
  const findArray = (o) => {
    if (!o || typeof o !== 'object') return null;
    for (const k of ['results', 'data', 'items', 'imageItems', 'images', 'pageItems']) {
      if (Array.isArray(o[k])) return o[k];
    }
    return null;
  };
  let list = findArray(j);
  if (!list) {
    for (const k of ['data', 'result', 'payload']) {
      const inner = j && j[k];
      if (inner && typeof inner === 'object') {
        list = findArray(inner);
        if (list) break;
      }
    }
  }
  if (!list) return { ok: true, items: [] };
  return { ok: true, items: list.map(normalizeImageItem).filter(Boolean) };
}

/**
 * 打一次工具类 POST。
 *
 * 与对话链路共用 cosy-sign 的 buildHeaders（同一套签名与身份头），
 * 差别只在 pathSig 与 query：**签名串里的 pathSig 必须是该端点自己的路径**
 * （去掉 `/algo` 前缀，与聊天路径同一约定）。复用聊天路径的签名会被上游判
 * `Signature invalid`（403）——这正是 2026-10-31 修 `listModels` 时踩过的坑。
 */
async function postTool(path, query, payloadObj, extraBody, opts = {}) {
  const account = await chat.ensureAccount(authStore, opts.account || authStore.preferred());
  if (!account) {
    const err = new Error('千问办公没有可用账号，请先添加一个');
    err.statusCode = 503;
    throw err;
  }
  const sess = sign.newSession({
    uid: account.uid,
    token: account.accessToken,
    machineId: account.machineId || '',
  });
  const pathSig = path.replace(/^\/algo/, '');
  const bodyJson = JSON.stringify({ payload: JSON.stringify(payloadObj), encodeVersion: '1', ...(extraBody || {}) });
  const body = require('../cosy').encode(bodyJson);
  const url = `${c.GATEWAY}${path}${query ? `?${query}` : ''}`;
  const headers = sign.buildHeaders(sess, pathSig, body, 'application/json', {
    Accept: 'application/json',
  });
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
    const err = new Error(`出站代理配置错误: ${e.message}`);
    err.statusCode = 500;
    throw err;
  }
  const res = await new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
      ...(agent ? { agent } : {}),
    }, (r) => {
      let buf = '';
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      r.on('data', (x) => { buf += dec.write(x); });
      r.on('end', () => resolve({ status: r.statusCode, raw: buf + dec.end() }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('qwenwork search timeout')); });
    req.write(body);
    req.end();
  });
  if (res.status !== 200) {
    const err = new Error(`千问 ${path} 返回 HTTP ${res.status}: ${String(res.raw || '').replace(/\s+/g, ' ').slice(0, 200)}`);
    err.statusCode = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }
  return res.raw;
}

/**
 * 联网搜索。
 * @param {{query:string, allowedDomains?:string[], blockedDomains?:string[]}} p
 * @param {{account?:object}} [opts]
 * @returns {Promise<{items:Array}>}
 */
async function webSearch(p, opts = {}) {
  const payloadObj = buildWebSearchPayload(p || {});
  const raw = await postTool(c.WEB_SEARCH_PATH, c.SEARCH_QUERY, payloadObj, null, opts);
  const r = parseWebSearchResponse(raw);
  if (!r.ok) {
    const err = new Error(`千问联网搜索失败: ${r.error}`);
    err.statusCode = r.errorCode && r.errorCode >= 400 && r.errorCode < 600 ? r.errorCode : 502;
    throw err;
  }
  return { items: r.items, requestId: r.requestId };
}

/**
 * 图片搜索。
 * @param {{query:string, count?:number}} p
 * @param {{account?:object}} [opts]
 * @returns {Promise<{items:Array}>}
 */
async function imageSearch(p, opts = {}) {
  const payloadObj = buildImageSearchPayload(p || {});
  // requestId / timestamp 是客户端明写的两个附加字段（hUt.search 的 body）。
  // requestId 用 crypto.randomUUID（客户端是 node:crypto 的 randomUUID，同一个）；
  // timestamp 是**秒**的字符串（`String(Math.floor(Date.now()/1e3))`）。
  const requestId = crypto.randomUUID();
  const extra = { requestId, timestamp: String(Math.floor(Date.now() / 1000)) };
  const raw = await postTool(c.IMAGE_SEARCH_PATH, c.SEARCH_QUERY, payloadObj, extra, opts);
  const r = parseImageSearchResponse(raw);
  if (!r.ok) {
    const err = new Error(`千问图片搜索失败: ${r.error}`);
    err.statusCode = 502;
    throw err;
  }
  return { items: r.items, requestId };
}

/**
 * 探活（`GET /algo/api/v1/ping`，客户端 `pingEndpoint` 用的同一路径）。
 *
 * 实测真机回纯文本 `pong`，且**带不带 COSY 签名都 200**——所以用裸 Bearer，
 * 少一层签名开销。不消耗额度、不改账号状态。
 *
 * 用途：`/health` 的千问条目可以据此区分「凭证被整体拒（401/403）」与
 * 「额度耗尽（对话 402 但探活仍 200）」，这两者的处置完全不同。
 *
 * @returns {Promise<{ok:boolean, latencyMs:number|null, error?:string}>}
 */
async function ping(opts = {}) {
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(opts.account || null); } catch (e) {
    return { ok: false, latencyMs: null, error: `出站代理配置错误: ${e.message}` };
  }
  const account = await chat.ensureAccount(authStore, opts.account || authStore.preferred());
  if (!account) return { ok: false, latencyMs: null, error: '千问办公没有可用账号' };
  const startedAt = Date.now();
  const r = await new Promise((resolve) => {
    let u;
    try { u = new URL(c.GATEWAY + c.PING_PATH); } catch (e) { return resolve({ status: 0, error: e.message }); }
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { ...sign.clientHeaders(), Authorization: `Bearer ${account.accessToken}`, Accept: '*/*' },
      timeout: 10000,
      ...(agent ? { agent } : {}),
    }, (res) => {
      let b = '';
      res.on('data', (x) => { b += x; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.end();
  });
  const latencyMs = Date.now() - startedAt;
  if (r.status !== 200) {
    return { ok: false, latencyMs, error: r.error || `HTTP ${r.status}: ${String(r.body || '').slice(0, 120)}` };
  }
  return { ok: true, latencyMs, body: String(r.body || '').trim() };
}

module.exports = {
  webSearch, imageSearch, ping,
  buildWebSearchPayload, buildImageSearchPayload,
  parseWebSearchResponse, parseImageSearchResponse,
  normalizeSearchItem, normalizeImageItem,
  IMAGE_COUNT_MIN, IMAGE_COUNT_MAX,
};
