// src/workbuddy/search.js - WorkBuddy agenttool 搜索/抓取（批次八，hub + yreidev 双源证据 + 真机探针定案）
//
// 两条只读端点（2026-11-28 真机实测，轻量头集即可 200）：
//   POST {chatBase}/agenttool/v1/search   {"query"} → {query, type, provider,
//     results:[{title,url,snippet,site,favicon}], total_results, response_time_ms}
//   POST {chatBase}/agenttool/v1/webfetch {"url","format"} → {url, title, content}
//
// 纪律（与 dumate-web-api 只读端点同一套）：
//   - **不消耗模型额度**（千问之外的第二条免费搜索腿），也不喂池、不改账号
//     健康状态——检索失败与对话可用性是两回事；
//   - **禁跟随重定向**（hub 口径）：Authorization 不能跟着 30x 走，Node 的
//     https.request 本身不跟随，收到 3xx 如实报错；
//   - 轻量头集：Bearer AT + CLI UA，**不带** X-Stainless-*/b3 链路头
//    （agenttool 是 CLI 的工具子端点，不是对话链路）；
//   - 黑名单域名拼进搜索词 `-site:`（hub 口径，真机验证 -site: 语法上游认）。
const c = require('./constants');
const https = require('https');

const TIMEOUT_MS = 30000;

/** 解析上游信封错误：{code, msg/msg/message, requestId} 或裸文本 */
function envelopeError(status, raw) {
  let j = null;
  try { j = JSON.parse(raw); } catch (e) { /* 非 JSON 信封 */ }
  if (j && (j.code != null || j.msg || j.message)) {
    const code = j.code != null ? `${j.code}: ` : '';
    const msg = String(j.msg || j.message || '').trim();
    const e = new Error(`workbuddy ${code}${msg}`.trim().slice(0, 300));
    if (j.code != null) e.upstreamCode = Number(j.code) || 0;
    if (j.requestId) e.upstreamRequestId = String(j.requestId);
    return e;
  }
  return new Error(`workbuddy HTTP ${status}: ${String(raw || '').replace(/\s+/g, ' ').slice(0, 200)}`);
}

/**
 * agenttool 轻量 POST（搜索/抓取/嵌入共用）。
 * opts.account 显式指定账号（探针/管理端用）；缺省取该区域第一个可用账号。
 * @returns {Promise<{status:number, json:object, raw:string}>} 2xx 才返回；
 *          3xx/4xx/5xx 一律抛错（statusCode 透传，信封 code/msg 进 message）
 */
async function postTool(region, path, bodyObj, opts = {}) {
  const reg = c.normalizeRegion(region);
  const authStore = require('./auth');
  let account = opts.account || null;
  if (!account) {
    const usable = authStore.findUsable().filter((a) => c.normalizeRegion(a.region) === reg);
    account = usable[0] || null;
  }
  if (!account) {
    const err = new Error(`WorkBuddy 没有可用的${reg === 'global' ? '国际' : '国内'}账号（agenttool 需要登录态）`);
    err.statusCode = 503;
    throw err;
  }
  try { account = await authStore.ensureFresh(account); } catch (e) { /* 刷新失败带旧 token 试 */ }
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
    const err = new Error(`出站代理配置错误: ${e.message}`);
    err.statusCode = 500;
    throw err;
  }
  const spec = c.specOf(reg);
  const u = new URL(spec.chatBase + path);
  const body = JSON.stringify(bodyObj || {});
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${account.accessToken}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'User-Agent': c.CLIENT_UA,
  };
  const res = await new Promise((resolve) => {
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers,
      timeout: TIMEOUT_MS, ...(agent ? { agent } : {}),
    }, (r) => {
      let buf = '';
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      r.on('data', (x) => { buf += dec.write(x); });
      r.on('end', () => resolve({ status: r.statusCode, location: r.headers.location || '', raw: buf + dec.end() }));
    });
    req.on('error', (e) => resolve({ status: 0, raw: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, raw: 'timeout' }); });
    req.write(body);
    req.end();
  });
  if (res.status >= 300 && res.status < 400) {
    // 禁跟随重定向（hub 口径）：Authorization 外泄风险，一律拒绝
    const err = new Error(`workbuddy ${path} 返回重定向 ${res.status}（禁跟随，防 Authorization 外泄）${res.location ? ` → ${res.location}` : ''}`);
    err.statusCode = 502;
    throw err;
  }
  if (res.status < 200 || res.status >= 300) {
    const err = envelopeError(res.status, res.raw);
    err.statusCode = res.status >= 400 && res.status < 500 ? res.status : 502;
    throw err;
  }
  let json = null;
  try { json = JSON.parse(res.raw); } catch (e) { json = null; }
  if (!json || typeof json !== 'object') {
    const err = new Error(`workbuddy ${path} 返回非 JSON 响应`);
    err.statusCode = 502;
    throw err;
  }
  return { status: res.status, json, raw: res.raw };
}

/** 黑名单域名拼进搜索词（hub 口径）：`query -site:a -site:b`，长词在后不重复 */
function buildQuery(query, blockedDomains) {
  let q = String(query || '').trim();
  if (!q) return q;
  for (const d of Array.isArray(blockedDomains) ? blockedDomains : []) {
    const s = String(d || '').trim();
    if (s && !q.includes(`-site:${s}`)) q += ` -site:${s}`;
  }
  return q;
}

/**
 * 联网搜索。上游把 query 原样回显（含我们拼的 -site:），results 默认 5 条。
 * @param {{query:string, blockedDomains?:string[]}} p
 * @param {{account?:object}} [opts]
 * @returns {Promise<{items:Array<{title,url,snippet,site,favicon}>, query:string,
 *                     totalResults:number, responseTimeMs:number}>}
 */
async function webSearch(p, opts = {}) {
  const query = buildQuery(p && p.query, p && p.blockedDomains);
  if (!query) {
    const err = new Error('query 不能为空');
    err.statusCode = 400;
    throw err;
  }
  const { json } = await module.exports.postTool(opts.region || 'cn', '/agenttool/v1/search', { query }, opts);
  const results = Array.isArray(json.results) ? json.results : [];
  const items = results.map((x) => ({
    title: String((x && x.title) || ''),
    url: String((x && x.url) || ''),
    snippet: String((x && x.snippet) || ''),
    site: String((x && x.site) || ''),
    favicon: String((x && x.favicon) || ''),
  }));
  return {
    items, query: String(json.query || query),
    totalResults: Number(json.total_results) || items.length,
    responseTimeMs: Number(json.response_time_ms) || null,
  };
}

/**
 * 网页抓取。format 缺省 markdown（hub 口径，真机验证 content 是 markdown 文本）。
 * @param {{url:string, format?:string}} p
 * @returns {Promise<{url,title,content}>}
 */
async function webFetch(p, opts = {}) {
  const url = String((p && p.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    const err = new Error('url 必须是 http(s) 绝对地址');
    err.statusCode = 400;
    throw err;
  }
  const format = String((p && p.format) || 'markdown').trim() || 'markdown';
  const { json } = await module.exports.postTool(opts.region || 'cn', '/agenttool/v1/webfetch', { url, format }, opts);
  return { url: String(json.url || url), title: String(json.title || ''), content: String(json.content || '') };
}

module.exports = { postTool, webSearch, webFetch, buildQuery, TIMEOUT_MS };
