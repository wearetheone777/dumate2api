// src/workbuddy/webagent.js - WorkBuddy 网页 agent 会话打卡（ACP over streamable HTTP）
//
// 协议全部取自 workbuddy2api-hub 的 wb_webagent.py + wb_accounts.py
// _daily_chat_web_once（2026-11-05 融合）。机制（hub issue #90 实测）：
// **建会话只是排队**——POST /console/as/conversations/ 之后，agent 要等客户端
// 接上这条会话的沙箱（GET /{id}/session 返回的 link + token）并请求这一轮才会
// 跑；只建会话不接沙箱，会话永远停在 CREATING，每日活跃也不计数。
//
// 沙箱接入是 ACP over streamable HTTP：
//   1. GET <link>  Accept: text/event-stream → SSE 流，响应头带 Acp-Connection-Id
//   2. POST <link>（同头）JSON-RPC：initialize → session/load → session/set_model
//      → session/prompt；session/update 通知从 SSE 流回来
//   3. 结束判据：轮询 console API，会话 status === 'completed'
//
// 硬约束（hub 实测，照抄口径）：
//   · 模型必须在 session/load 之后、session/prompt 之前用 session/set_model 单独
//     钉——建会话 body 里的 model 只进 manifest，不设模型会按网页默认 Auto
//     **按付费模型计费**（每天活跃都在扣积分就是这么来的）。失败不致命，本轮
//     照跑，日志留一句。
//   · 活跃会话（working/creating/pending）每账号硬上限 10：HTTP 429 / code 10105。
//     每条会话跑完必须收尾，否则每天漏一条，十天后这个账号再也建不出会话。
//   · 一轮实测十几秒；等待预算默认 120s，至少跑 2 轮留给「会话只是慢」。
'use strict';
const https = require('https');
const crypto = require('crypto');

const WEB_ORIGIN = {
  cn: process.env.DUMATE_WORKBUDDY_WEB_ORIGIN_CN || 'https://www.workbuddy.cn',
  global: process.env.DUMATE_WORKBUDDY_WEB_ORIGIN || 'https://www.workbuddy.ai',
};
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';
const DAILY_MODEL = 'deepseek-v4.1-flash';
const DAILY_PROMPT = 'Hi';
// 打卡提示词池（hub wb_webprompts：固定提示词本身是指纹——每天同一账号同
// 一句 "Hi" 的会话序列太好认）。env 池优先（逗号/分号/换行分隔），没配用
// 内置等价问候池。活跃计数只看会话跑完，提示词内容不影响（hub 实测口径）。
const DAILY_PROMPTS = ['Hi', 'Hello!', 'hi there', 'Hey', 'hello'];
function dailyPromptOf(opts = {}) {
  if (opts.prompt) return String(opts.prompt);
  const env = String(process.env.DUMATE_WORKBUDDY_WEB_PROMPTS || '');
  const list = env.split(/[\n,，;；]/).map((s) => s.trim()).filter(Boolean);
  const src = list.length ? list : DAILY_PROMPTS;
  return src[Math.floor(Math.random() * src.length)];
}
const TURN_WAIT_MS_DEFAULT = 120000;
const POLL_INTERVAL_MS = 3000;
const ACTIVE_LIMIT_HINT = 'maximum number of active';

// 11140 账号级风控（hub v1.9.0：国际版每日活跃 11140 风控持久化避让）：
// 打卡撞风控就把账号档案记 webBlockedUntil（次日 00:10 自动恢复），期间
// 打卡直接跳过——反复对受限账号打活跃只会加重风控画像。
const RESTRICTED_HINT = /11140(?!\d)|unusual activity|已被限制/i;
// 证书类失败（hub v1.8.0 #645/#647）：ACP 沙箱域由 EdgeOne 下发
// `*.cdn.myqcloud.com` 通配证书，与实际域名不匹配，TLS 层必然拒绝。
// 降级路径 = activity 的 POST /v2/report（主域证书正常），默认关、
// DUMATE_WORKBUDDY_WEB_CERT_FALLBACK=1 开（与 hub 面板开关同口径）。
const CERT_HINT = /altname|certificate|ssl|unable to verify/i;

// ── 批次十一：打卡候选模型序列 + 预算 + 退避（hub v2.1.1 移植）──────────────
// 一次打卡 = **一个候选序列 + 一个预算**：按候选顺序一轮一轮试，额度/限流失败
// 落到下一个候选；风控（11140）/鉴权（401）立即停不换模型。轮数由候选序列推出
// （至少两轮：第二轮留给「会话只是慢」），不再有「最多尝试次数」这个与候选数量
// 互相覆盖的旋钮。
//
// 自动模式的候选顺序是**免费模型优先**（探针 test/probe-workbuddy-webmodel.js
// 实证：目录免费榜 hy4flash-free 被网页沙箱 session/set_model 接受且会话跑完，
// rate 0；deepseek-v4.1-flash 在实时目录双区域都是 x0.11 付费）——免费榜在先
// 省积分，flash 收尾保住打卡连登。显式序列（env）永远整体优先且不重排。
const DAILY_MODELS_ENV = 'DUMATE_WORKBUDDY_DAILY_MODELS';
const WEB_RETRY_BACKOFF_MS = Number(process.env.DUMATE_WORKBUDDY_WEB_RETRY_BACKOFF || '') > 0
  ? Number(process.env.DUMATE_WORKBUDDY_WEB_RETRY_BACKOFF) * 1000 : 5000;
const WEB_RETRY_BACKOFF_MAX_MS = Number(process.env.DUMATE_WORKBUDDY_WEB_RETRY_BACKOFF_MAX || '') > 0
  ? Number(process.env.DUMATE_WORKBUDDY_WEB_RETRY_BACKOFF_MAX) * 1000 : 30000;
// 单账号总预算（ms）；0 = 不限制。默认 600s——一个卡住的账号不该把整轮巡检拖住数小时
const WEB_BUDGET_MS = (() => {
  const v = String(process.env.DUMATE_WORKBUDDY_WEB_BUDGET_MS || '').trim();
  if (!v) return 600000;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 600000;
})();
const WEB_BUDGET_MIN_ROUND_MS = 30000; // 剩余预算低于它不再开新轮：一轮至少要能等到会话真的跑起来
const WEB_MIN_ROUNDS = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 候选序列清洗：保序去重、去空串，**不截断**（轮数由调用方按候选数推出） */
function cleanCandidates(models) {
  const seen = new Set();
  const out = [];
  for (const m of models || []) {
    const name = String(m || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 实时目录的免费模型 id（catalog free 字段，rate===0）。失败回 []——上层落 flash 兜底 */
async function freeModelCandidates(region) {
  try {
    const r = await require('./models').fetchModels({ region });
    return ((r && r.models) || [])
      .filter((x) => x && x.free === true)
      .map((x) => String(x.id || '').trim())
      .filter(Boolean);
  } catch (e) { return []; }
}

/**
 * 打卡候选模型序列（hub daily_chat_candidates 同构，两腿共用）：
 *   1. env `DUMATE_WORKBUDDY_DAILY_MODELS`（逗号/分号/换行分隔）显式配置整体
 *      优先且**不重排**——那是操作者的优先级，不是建议；
 *   2. 自动模式 = 实时目录免费模型（catalog 顺序）+ flash 收尾。
 *      目录拉不到（无账号/网络失败）→ [flash]（旧行为，打卡不因目录抖动停摆）。
 */
async function dailyChatCandidates(region) {
  const env = String(process.env[DAILY_MODELS_ENV] || '');
  const list = env.split(/[\n,，;；]/).map((s) => s.trim()).filter(Boolean);
  if (list.length) return cleanCandidates(list);
  const free = await freeModelCandidates(region);
  return cleanCandidates([...free, DAILY_MODEL]);
}

/** 第 roundIndex 轮（0 起）失败后的退避：base × 2^n，封顶 cap；base<=0 = 关 */
function webRetryBackoffMs(roundIndex, base = WEB_RETRY_BACKOFF_MS, cap = WEB_RETRY_BACKOFF_MAX_MS) {
  if (base <= 0) return 0;
  return Math.min(base * (2 ** roundIndex), Math.max(cap, base));
}

/** 建会话业务拒绝的「值得换候选再试」判定（hub _web_conversation_create 口径）：
 *  额度/限流/模型类失败换免费候选有意义；其它（参数/会话态）再发也一样被拒 */
function createRejectRetryable(code, text) {
  if ([14018, 6004, 6005].includes(Number(code))) return true;
  const s = String(text || '').toLowerCase();
  return ['credit', 'quota', 'limit', 'model not found', 'no such model',
    'invalid model', '额度', '积分', '限流', '不存在'].some((t) => s.includes(t));
}

function envOn(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** 次日 00:10 的本地时刻（避让恢复点：过 0 点边缘，连登已按新的一天计） */
function nextDayResetMs(now = Date.now()) {
  const d = new Date(now);
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 10, 0, 0);
  return t.getTime();
}

function webOriginOf(region) {
  return String(region || '').toLowerCase() === 'global' ? WEB_ORIGIN.global : WEB_ORIGIN.cn;
}

function conversationsUrl(region) {
  return `${webOriginOf(region)}/console/as/conversations/`;
}

/** 网页版出站头：只有 Bearer 与 X-User-Id，没有桌面端指纹（hub web_headers 字面） */
function webHeaders(region, account, extra = {}) {
  return {
    Authorization: `Bearer ${(account && account.accessToken) || ''}`,
    'X-User-Id': String((account && account.uid) || ''),
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Origin: webOriginOf(region),
    Referer: `${webOriginOf(region)}/app`,
    'User-Agent': WEB_UA,
    ...extra,
  };
}

/** 测试注入点 */
let requestImpl = (opts, cb) => https.request(opts, cb);
function _setRequestImpl(f) { requestImpl = f; }

/** 单次 JSON 请求。返回 {ok, status, code, data, detail} */
function jsonRequest(region, account, path, { method = 'GET', body = null, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    let agent = null;
    try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
      return resolve({ ok: false, status: 0, detail: `出站代理配置错误: ${e.message}` });
    }
    const u = new URL(path.startsWith('http') ? path : webOriginOf(region) + path);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = requestImpl({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      agent,
      timeout,
      headers: webHeaders(region, account, payload ? { 'Content-Length': String(payload.length) } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let j = null;
        try { j = JSON.parse(raw); } catch (e) { /* 非 JSON 原样给 detail */ }
        resolve({
          ok: res.statusCode < 400,
          status: res.statusCode,
          code: j && j.code != null ? j.code : null,
          data: j && j.data != null ? j.data : j,
          detail: raw.slice(0, 300),
        });
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, detail: e.message }));
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* 已结束 */ } resolve({ ok: false, status: 0, detail: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

/** 「活跃会话已满」（HTTP 429 + code 10105）：先清理再重试的信号 */
function isActiveLimit(status, detail) {
  return status === 429 && /10105|maximum number of active/i.test(String(detail || ''));
}

/**
 * 建一条网页会话。body 按 hub 抓包字面（conversationOrigin + plugins）。
 * 返回 {ok, id, error, limit, status}。
 */
async function createConversation(region, account, { prompt, model } = {}) {
  const r = await jsonRequest(region, account, conversationsUrl(region), {
    method: 'POST',
    body: {
      prompt: String(prompt || DAILY_PROMPT),
      model: String(model || DAILY_MODEL),
      conversationOrigin: 'workbuddy-app',
      plugins: [{ name: 'weixinpay', marketplace: 'codebuddy-builtin' }],
    },
  });
  if (!r.ok) {
    return {
      ok: false, status: r.status,
      limit: isActiveLimit(r.status, r.detail),
      error: `建会话失败 HTTP ${r.status}: ${String(r.detail || '').slice(0, 120)}`,
    };
  }
  const id = r.data && (r.data.id || r.data.conversationId);
  if ((r.code != null && r.code !== 0) || !id) {
    // code 单列：候选回退要按业务码判「值得换候选再试」（额度/限流/模型类）还是终止
    return { ok: false, code: r.code, error: `建会话被拒 code=${r.code} data=${JSON.stringify(r.data || {}).slice(0, 120)}` };
  }
  return { ok: true, id: String(id) };
}

/** 会话沙箱信息（link/token/sessionId/cwd）。缺 link 或 token 视为未就绪 */
async function getConversationSession(region, account, conversationId) {
  const r = await jsonRequest(region, account,
    `${conversationsUrl(region)}${encodeURIComponent(conversationId)}/session`);
  if (!r.ok) return { ok: false, error: `session 查询失败 HTTP ${r.status}` };
  const d = (r.data && typeof r.data === 'object' ? r.data : {}) || {};
  const link = d.link || d.endpoint || '';
  const token = d.token || '';
  const sessionId = d.sessionId || d.session_id || conversationId;
  const cwd = d.cwd || '/workspace';
  if (!link || !token) return { ok: false, error: '沙箱未就绪（没有 link/token）' };
  return { ok: true, link, token, sessionId, cwd };
}

/** 会话当前状态（completed 即本轮跑完）。失败返回 ''（轮询层不因抖动提前放弃） */
async function conversationStatus(region, account, conversationId) {
  const r = await jsonRequest(region, account,
    `${conversationsUrl(region)}${encodeURIComponent(conversationId)}`);
  const d = (r.data && typeof r.data === 'object' ? r.data : {}) || {};
  return String(d.status || '').toLowerCase();
}

/** 收尾（stop 保留 / delete 删除）。清理动作不冒泡——一轮已经跑完的活跃不能因收尾失败被改判 */
async function releaseConversation(region, account, conversationId, { remove = false } = {}) {
  const action = remove ? 'delete' : 'stop';
  const r = await jsonRequest(region, account,
    `${conversationsUrl(region)}${encodeURIComponent(conversationId)}/${action}`,
    { method: 'POST', body: {}, timeout: 20000 });
  return r.ok && (r.code === 0 || r.code == null);
}

// ---- ACP over streamable HTTP ----

/**
 * 一条沙箱通道：open() 建立 SSE 长连接拿 Acp-Connection-Id；
 * request() 向同一 link POST JSON-RPC（200/202 都算接受）。
 * agent：账号的出站代理（hub 对沙箱入口同样走 CONNECT，缺了认证代理 407）。
 */
class AcpChannel {
  constructor(link, token, { timeout = 30000, agent = null } = {}) {
    this.link = new URL(link);
    this.token = token;
    this.timeout = timeout;
    this.agent = agent;
    this.connectionId = '';
    this.updates = 0;
    this.chunks = 0;
    this.res = null;
    this.req = null;
    this._buf = '';
    this.error = null;
    this.onUpdate = null;   // (update) => void，测试用
  }

  /** 建立 SSE 通道，resolve connection id */
  open() {
    return new Promise((resolve, reject) => {
      const req = requestImpl({
        hostname: this.link.hostname,
        path: this.link.pathname + this.link.search,
        method: 'GET',
        timeout: 0,
        ...(this.agent ? { agent: this.agent } : {}),
        headers: webHeaders('', null, {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${this.token}`,
          'User-Agent': WEB_UA,
        }),
      }, (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => reject(new Error(`SSE 通道返回 HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 120)}`)));
          return;
        }
        const cid = res.headers['acp-connection-id'] || '';
        if (!cid) {
          res.resume();
          return reject(new Error('SSE 通道没有返回 Acp-Connection-Id'));
        }
        this.connectionId = cid;
        this.res = res;
        res.setEncoding('utf8');
        res.on('data', (chunk) => this._onData(chunk));
        res.on('end', () => { if (!this.error) this.error = new Error('SSE 流在回合结束前关闭'); });
        res.on('error', (e) => { if (!this.error) this.error = e; });
        resolve(cid);
      });
      req.on('error', reject);
      req.on('timeout', () => { try { req.destroy(); } catch (e) { /* 已结束 */ } reject(new Error('SSE 通道连接超时')) ; });
      req.end();
    });
  }

  _onData(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).replace(/\r$/, '').trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let msg = null;
      try { msg = JSON.parse(payload); } catch (e) { continue; }
      if (msg && msg.method === 'session/update') {
        this.updates++;
        const update = (msg.params || {}).update || {};
        if (update.sessionUpdate === 'agent_message_chunk') this.chunks++;
        if (this.onUpdate) { try { this.onUpdate(update); } catch (e) { /* 回调异常不掐流 */ } }
      }
    }
  }

  /** 发一个 JSON-RPC 请求；resolve HTTP 状态码（200/202 正常） */
  request(method, params, requestId) {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({
        jsonrpc: '2.0', id: requestId, method, params,
      }), 'utf8');
      const req = requestImpl({
        hostname: this.link.hostname,
        path: this.link.pathname + this.link.search,
        method: 'POST',
        timeout: this.timeout,
        ...(this.agent ? { agent: this.agent } : {}),
        headers: webHeaders('', null, {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Acp-Connection-Id': this.connectionId,
          Authorization: `Bearer ${this.token}`,
          'User-Agent': WEB_UA,
          'Content-Length': String(body.length),
        }),
      }, (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode !== 200 && res.statusCode !== 202) {
            return reject(new Error(`${method} 返回 HTTP ${res.statusCode}`));
          }
          resolve(res.statusCode);
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { try { req.destroy(); } catch (e) { /* 已结束 */ } reject(new Error(`${method} 超时`)); });
      req.write(body);
      req.end();
    });
  }

  close() {
    try { if (this.res) this.res.destroy(); } catch (e) { /* 已断 */ }
  }
}

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

/**
 * 接上沙箱、把这一轮跑完（wb_webagent.run_turn 同构）。
 * pollStatus 由调用方注入（查 console API 的会话状态）。
 * 返回 {ok, status, updates, chunks, elapsedMs, error}。
 */
async function runTurn({ link, token, sessionId, cwd, prompt, model, pollStatus, waitMs = TURN_WAIT_MS_DEFAULT, pollIntervalMs = POLL_INTERVAL_MS, channelFactory = AcpChannel, agent = null }) {
  const started = Date.now();
  const channel = new channelFactory(link, token, { agent });
  let status = '';
  let error = '';
  let finished = false;
  let setModelOk = false;
  try {
    await channel.open();
    await channel.request('initialize', { protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES }, 1);
    await channel.request('session/load', { sessionId, cwd: cwd || '/workspace', mcpServers: [] }, 2);
    // 不设模型 = 网页默认 Auto 按付费档计费（hub _set_model 注释）。批次十一起
    // set_model 失败判**本轮失败**（hub 原口径是「本轮仍跑」）：候选序列是免费
    // 模型在先，set_model 失败意味着这一轮会静默按 Auto 付费——比换下一个候选
    // 更贵，也更难看见。失败轮的会话由调用方删掉，换候选重来。
    try {
      await channel.request('session/set_model', { sessionId, modelId: String(model || DAILY_MODEL) }, 3);
      setModelOk = true;
    } catch (e) {
      error = `set_model 失败（模型 ${model || DAILY_MODEL} 未被沙箱接受，拒绝按付费 Auto 计费）: ${e.message}`;
    }
    if (setModelOk) {
      await channel.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, 4);
      const deadline = Date.now() + Math.max(1000, waitMs);
      while (Date.now() < deadline) {
        if (pollStatus) {
          try { status = String((await pollStatus()) || ''); } catch (e) { /* 抖动下一轮再查 */ }
          if (status === 'completed') { finished = true; break; }
          if (status === 'failed' || status === 'error') { error = `会话状态=${status}`; break; }
        }
        if (pollIntervalMs) await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    }
  } catch (e) {
    error = error || e.message;
  } finally {
    channel.close();
  }
  const elapsedMs = Date.now() - started;
  if (setModelOk && !status && pollStatus) {
    try { status = String((await pollStatus()) || ''); } catch (e) { /* 已尽力 */ }
  }
  if (!finished && !error) error = `会话在 ${waitMs}ms 内没有跑完（状态=${status || '未知'}）`;
  return { ok: finished && !error, status, updates: channel.updates, chunks: channel.chunks, elapsedMs, error, setModelOk };
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 单轮尝试（hub _daily_chat_web_once 同构）：建会话 → 取沙箱 → runTurn → 收尾。
 * 成功保留会话（stop），失败删除——网页历史里不堆满「Hi」。
 * phase 标出失败停在哪一步：create（建会话）/ session（取沙箱）/ turn（跑这轮）；
 * retryable 说明该失败值不值得换下一个候选再试（候选循环用）。
 *
 * @returns {Promise<{ok, phase, error, model, turn?}>}
 */
async function dailyActivityOnce(region, account, { prompt, model, waitMs, pollIntervalMs, channelFactory, agent, authStore, certFallback }) {
  const created = await createConversation(region, account, { prompt, model });
  if (!created.ok) {
    // 11140 风控：记避让（持久化在账号档案），立即停不换模型
    if (RESTRICTED_HINT.test(created.error || '')) {
      const until = nextDayResetMs();
      try { authStore.patch(account.id, { webBlockedUntil: until }); } catch (e) { /* 记不下不影响结论 */ }
      return { ok: false, phase: 'create', retryable: false, restricted: true, error: `${created.error}（已记风控避让，次日 00:10 自动恢复）` };
    }
    // 活跃会话已满：没有 prune 机制，如实让调用方去网页端收尾（重试撞同一堵墙）
    if (created.limit) {
      return { ok: false, phase: 'create', retryable: false, error: `${created.error}；活跃会话达上限，请到网页端结束或删除旧对话后重试` };
    }
    if (created.status != null) {
      // HTTP 层失败：5xx/408/429 值得换候选（上游抖动），4xx 换了也一样
      const retryable = created.status === 408 || created.status === 429 || created.status >= 500;
      return { ok: false, phase: 'create', retryable, error: created.error };
    }
    // 业务拒绝（code != 0）：按 hub 口径判额度/限流/模型类
    return { ok: false, phase: 'create', retryable: createRejectRetryable(created.code, created.error), error: created.error };
  }
  const conversationId = created.id;
  let keep = false;
  try {
    const sess = await getConversationSession(region, account, conversationId);
    if (!sess.ok) return { ok: false, phase: 'session', retryable: true, error: sess.error };
    const turn = await runTurn({
      link: sess.link,
      token: sess.token,
      sessionId: sess.sessionId,
      cwd: sess.cwd,
      prompt,
      model,
      agent,
      pollStatus: () => conversationStatus(region, account, conversationId),
      waitMs,
      pollIntervalMs,
      channelFactory,
    });
    if (!turn.ok) {
      if (RESTRICTED_HINT.test(turn.error || '')) {
        const until = nextDayResetMs();
        try { authStore.patch(account.id, { webBlockedUntil: until }); } catch (e) { /* 记不下不影响结论 */ }
        return { ok: false, phase: 'turn', retryable: false, restricted: true, error: `${turn.error}（已记风控避让，次日 00:10 自动恢复）` };
      }
      // 证书类失败降级（默认关）：沙箱通配证书必然 TLS 拒绝时，改走
      // 主域 /v2/report 活跃上报——打卡目标（点亮连登）不变，路径降级。
      // TLS 错误对任何候选都一样 → retryable:false，重试是纯浪费
      if (CERT_HINT.test(turn.error || '') && (certFallback ?? envOn('DUMATE_WORKBUDDY_WEB_CERT_FALLBACK'))) {
        const activity = require('./activity');
        const fb = await activity.reportActivity(account, { authStore });
        if (fb.ok) {
          try { authStore.patch(account.id, { lastWebActivity: `${today()} cert-fallback` }); } catch (e) { /* 记不下不影响 */ }
        }
        return {
          ok: fb.ok, phase: 'cert-fallback', retryable: false,
          msg: `ACP 沙箱证书不可用（${String(turn.error).slice(0, 80)}），已降级 /v2/report：${fb.msg || fb.error}`,
          error: fb.ok ? '' : fb.error,
        };
      }
      if (CERT_HINT.test(turn.error || '')) {
        return { ok: false, phase: 'turn', retryable: false, error: turn.error };
      }
      // 其余 turn 失败（set_model 被拒 / 会话超时 / 状态 failed）值得换候选
      return { ok: false, phase: 'turn', retryable: true, error: turn.error };
    }
    keep = true;
    return { ok: true, phase: 'turn', retryable: false, model, turn };
  } finally {
    // 收尾必须发生：不收尾这条会话一直占上游活跃名额（上限 10）
    try { await releaseConversation(region, account, conversationId, { remove: !keep }); } catch (e) { /* 不冒泡 */ }
  }
}

/**
 * 每日活跃打卡编排（hub _daily_chat_web_upstream 同构，批次十一候选序列版）：
 * **一个候选序列 + 一个预算**。按候选顺序一轮一轮试（dailyChatCandidates：
 * env 显式序列 > 免费优先自动序列），额度/限流失败落到下一个候选，风控/鉴权
 * 立即停；轮数 = max(2, 候选数)——第二轮留给「会话只是慢」。预算用尽必定给出
 * 结论（phase='budget'），不再有「跑了几小时没动静」的状态。
 * 当日幂等：账号档案 lastWebActivity 是今天就跳过。
 *
 * @returns {Promise<{ok, skipped, phase, msg, error, attempts?, models_tried?}>}
 */
async function dailyActivity(account, opts = {}) {
  const region = String((account && account.region) || '').toLowerCase() === 'global' ? 'global' : 'cn';
  const authStore = opts.authStore || require('./auth');
  const prev = String((account && account.lastWebActivity) || '');
  if (prev.startsWith(today())) {
    return { ok: true, skipped: true, phase: 'idempotent', msg: '今日网页活跃已打过卡', error: '' };
  }
  // 11140 风控避让（持久化在账号档案）：避让期内跳过，与当日幂等同形态
  const blockedUntil = Number((account && account.webBlockedUntil) || 0);
  if (blockedUntil && Date.now() < blockedUntil) {
    return {
      ok: true, skipped: true, phase: 'restricted',
      msg: `账号 11140 风控避让中（${new Date(blockedUntil).toLocaleString()} 自动恢复）`, error: '',
    };
  }
  const prompt = dailyPromptOf(opts);
  const candidates = await dailyChatCandidates(region);
  const rounds = Math.max(WEB_MIN_ROUNDS, candidates.length);
  const budgetMs = Number(opts.budgetMs !== undefined ? opts.budgetMs : WEB_BUDGET_MS);
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : null;
  const turnCap = Number(opts.waitMs) > 0 ? Number(opts.waitMs) : TURN_WAIT_MS_DEFAULT;
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) { agent = null; }
  const tried = [];
  let last = null;
  let budgetHit = false;
  for (let i = 0; i < rounds; i++) {
    if (deadline) {
      const remaining = deadline - Date.now();
      if (remaining < WEB_BUDGET_MIN_ROUND_MS) { budgetHit = true; break; }
    }
    const model = candidates[i % candidates.length];
    const waitMs = deadline ? Math.min(turnCap, Math.max(1000, deadline - Date.now())) : turnCap;
    const r = await dailyActivityOnce(region, account, {
      prompt, model, waitMs,
      pollIntervalMs: opts.pollIntervalMs,
      channelFactory: opts.channelFactory,
      agent,
      authStore,
      certFallback: opts.certFallback,
    });
    r.attempts = i + 1;
    r.models_tried = tried.concat([model]);
    r.model = model;
    // cert-fallback 是自带结论的终态（成功已由 once 内补档案），原样透传，
    // 不进下面的通用 ok/fail 分支
    if (r.phase === 'cert-fallback') {
      return { ...r, skipped: false, attempts: r.attempts, models_tried: r.models_tried };
    }
    if (r.ok) {
      try { authStore.patch(account.id, { lastWebActivity: `${today()} ${new Date().toTimeString().slice(0, 8)}` }); } catch (e) { /* 记不下不影响结论 */ }
      return {
        ok: true, skipped: false, phase: 'turn',
        msg: `网页会话跑完（${model}）：${r.turn.chunks} 段输出，${r.turn.elapsedMs} ms`,
        error: '', attempts: r.attempts, models_tried: r.models_tried,
      };
    }
    last = r;
    if (!r.retryable) break;
    tried.push(model);
    if (i + 1 >= rounds) break;
    // 只有 create/session 阶段没花掉等待预算才退避（turn 阶段已等满 waitMs）；
    // 背靠背重试会把所有尝试挤进同一个上游故障窗口（hub _web_retry_pause 口径）
    if (r.phase === 'create' || r.phase === 'session') {
      const d = webRetryBackoffMs(i);
      if (d > 0 && (!deadline || deadline - Date.now() > WEB_BUDGET_MIN_ROUND_MS)) await sleep(d);
    }
  }
  if (!last) {
    return { ok: false, skipped: false, phase: 'budget', msg: '', error: `单账号预算 ${budgetMs}ms 不足一轮（至少需要 ${WEB_BUDGET_MIN_ROUND_MS}ms）`, attempts: 0 };
  }
  if (budgetHit) {
    return { ok: false, skipped: false, phase: 'budget', msg: '', error: `单账号预算 ${budgetMs}ms 用尽（尝试 ${tried.length} 轮，最后错误：${last.error}）`, attempts: tried.length, models_tried: tried };
  }
  return { ok: false, skipped: false, phase: last.phase, msg: '', error: last.error, attempts: last.attempts, models_tried: last.models_tried };
}

module.exports = {
  webOriginOf, conversationsUrl, webHeaders, createConversation,
  getConversationSession, conversationStatus, releaseConversation,
  isActiveLimit, AcpChannel, runTurn, dailyActivity, dailyPromptOf,
  dailyChatCandidates, freeModelCandidates, cleanCandidates,
  webRetryBackoffMs, createRejectRetryable,
  _setRequestImpl, DAILY_MODEL, DAILY_PROMPT, CLIENT_CAPABILITIES,
  DAILY_MODELS_ENV, WEB_RETRY_BACKOFF_MS, WEB_RETRY_BACKOFF_MAX_MS,
  WEB_BUDGET_MS, WEB_BUDGET_MIN_ROUND_MS, WEB_MIN_ROUNDS,
};
