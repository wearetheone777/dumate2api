// src/dumate-web-api.js - 搭子网页端的只读查询接口（会话 / 项目 / MCP connector）
//
// 这些端点在 **`www.dumate.cn`**（网页端），不是模型网关
// `dumate-svc.baidu.com`——打在网关上一律 404（nginx 404 页）。鉴权是**网页
// cookie**（与 web-pool 同一份凭证），不是 Bearer app token。
//
// 真机实测（2026-10-31，账号 qianwencodework）：
//
//   GET /api/dumate/session/list            200  → { result: [session...] }（9 条）
//   GET /api/dumate/session/detail?sessionID=<id>  200 → 单条会话元数据
//   GET /api/dumate/projects                200  → { result: { data: [], total } }
//   GET /api/dumate/connector/v2/list       200  → { result: { list, total } }（已装）
//   GET /api/dumate/connector/v2/template/list 200 → { result: { list, total } }（50 个模板）
//   GET /api/dumate/skills/square/list      404  ← 不存在（清单里那条是错的）
//
// 三条踩过的细节：
//
//   1. **`session/detail` 的参数名是 `sessionID` 或 `sessionId`，不是 `id`**。
//      传 `id` 会回 `{"code":400,"message":"参数错误:SessionID"}`——HTTP 仍是 200，
//      所以不读 code 就会把空结果当成「会话不存在」。
//   2. **detail 只回元数据，不含消息历史**。消息在本地
//      `~/.qianfan/workspace/sessions/<uid>/<date>/<slug>/` 目录里，上游没有
//      「拉整段对话」的 HTTP 接口。所以这个模块只能做「会话清单 + 单条元数据」，
//      **不要指望它能给 previous_response_id 提供真历史**。
//   3. **`skills/square/list` 是 404**——清单里记的「技能广场 101 个」这条
//      在网页端不存在（可能只在桌面客户端内部）。如实标注，不编端点。
//
// 全部是**只读**：没有任何写操作，不消耗额度，不改账号状态。所以失败不喂池
// （读接口的失败与账号健康无关，罚号只会让对话请求被无辜跳过）。
const https = require('https');
const accounts = require('./accounts');

const WEB_HOST = (process.env.DUMATE_WEB_BASE || 'https://www.dumate.cn').replace(/^https?:\/\//, '').replace(/\/$/, '');
const TIMEOUT_MS = Math.max(5000, Number(process.env.DUMATE_WEB_TIMEOUT) || 20000);

/**
 * 带 cookie 的 GET。返回 { status, json, raw, error }。
 *
 * 网络错误 status=0；非 JSON 保留 raw（上游 4xx 时常是 HTML 错误页）。
 */
function getJson(cookie, path, timeout = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: WEB_HOST,
      path,
      method: 'GET',
      headers: { Cookie: cookie || '', Accept: 'application/json' },
      timeout,
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, raw: b });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, raw: '', error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, raw: '', error: 'timeout' }); });
    req.end();
  });
}

/** 取一个带 cookie 的网页账号。只读接口不需要 token 换票。 */
function pickCookieAccount() {
  try {
    const list = accounts.list();
    for (const a of list) {
      const raw = accounts.getRaw(a.id);
      if (raw && raw.cookie) return { id: a.id, name: accounts.displayName(raw), cookie: raw.cookie };
    }
  } catch (e) { /* 没有可用账号 */ }
  return null;
}

/**
 * 搭子网页接口的统一错误形状。
 *
 * **HTTP 200 不代表成功**：上游把业务结果放在 `code`（`code:0` + `success:true`
 * 才算成功）。不读 code 就会把「参数错误」当成「查到了但结果为空」。
 */
function apiError(r, what) {
  if (r.status === 0) return `请求 ${what} 失败: ${r.error || '网络错误'}`;
  if (r.status !== 200) return `${what} 返回 HTTP ${r.status}: ${String(r.raw || '').replace(/\s+/g, ' ').slice(0, 160)}`;
  if (!r.json) return `${what} 返回非 JSON: ${String(r.raw || '').slice(0, 160)}`;
  const code = Number(r.json.code);
  if (Number.isFinite(code) && code !== 0) {
    return `${what} 业务失败 code=${code}: ${r.json.message || ''}`.trim();
  }
  if (r.json.success === false) return `${what} 业务失败: ${r.json.message || 'success=false'}`;
  return null;
}

/** 归一化一条会话记录。字段缺给 null，不补空串（空串会被读成「有值但为空」） */
function normalizeSession(s) {
  if (!s || typeof s !== 'object') return null;
  const t = s.time && typeof s.time === 'object' ? s.time : {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    id: s.id || null,
    title: s.title || null,
    // 上游的目录是**本机路径**（C:\Users\...\.qianfan\workspace\sessions\...），
    // 换机器就失效——如实透出，界面上要标清楚这是「发起会话那台机器的路径」
    directory: s.directory || null,
    projectId: s.projectID || null,
    slug: s.slug || null,
    type: s.type || null,
    source: s.source || null,
    execEnv: s.execEnv || null,
    autoModelLevel: s.autoModelLevel || null,
    isPinned: typeof s.isPinned === 'boolean' ? s.isPinned : null,
    isSubagent: typeof s.is_subagent === 'boolean' ? s.is_subagent : null,
    created: num(t.created),
    updated: num(t.updated),
    // 代码改动统计（部分会话带，多数没有）
    summary: s.summary && typeof s.summary === 'object'
      ? { additions: num(s.summary.additions), deletions: num(s.summary.deletions), files: num(s.summary.files) }
      : null,
  };
}

/**
 * 会话列表（按更新时间倒序）。
 * @returns {Promise<{ok:boolean, sessions:Array, error?:string}>}
 */
async function listSessions(opts = {}) {
  const acc = opts.account || pickCookieAccount();
  if (!acc) return { ok: false, sessions: [], error: '没有可用的网页账号（需先添加搭子网页凭证）' };
  const r = await getJson(acc.cookie, '/api/dumate/session/list');
  const err = apiError(r, '会话列表');
  if (err) return { ok: false, sessions: [], error: err };
  const list = Array.isArray(r.json.result) ? r.json.result : [];
  const sessions = list.map(normalizeSession).filter(Boolean)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return { ok: true, sessions, account: acc.name };
}

/**
 * 单条会话元数据。
 *
 * **参数名必须是 `sessionID`**（`id` / `session_id` / `session` 都回参数错误）。
 * 且它**不含消息历史**——见文件头注释第 2 条。
 */
async function sessionDetail(sessionId, opts = {}) {
  const id = String(sessionId || '').trim();
  if (!id) return { ok: false, error: 'sessionID 不能为空' };
  const acc = opts.account || pickCookieAccount();
  if (!acc) return { ok: false, error: '没有可用的网页账号（需先添加搭子网页凭证）' };
  const r = await getJson(acc.cookie, `/api/dumate/session/detail?sessionID=${encodeURIComponent(id)}`);
  const err = apiError(r, '会话详情');
  if (err) return { ok: false, error: err };
  const s = normalizeSession(r.json.result);
  if (!s) return { ok: false, error: '会话详情为空' };
  return { ok: true, session: s, account: acc.name };
}

/** 项目列表（多数账号为空数组，如实返回） */
async function listProjects(opts = {}) {
  const acc = opts.account || pickCookieAccount();
  if (!acc) return { ok: false, projects: [], error: '没有可用的网页账号（需先添加搭子网页凭证）' };
  const r = await getJson(acc.cookie, '/api/dumate/projects');
  const err = apiError(r, '项目列表');
  if (err) return { ok: false, projects: [], error: err };
  const res = r.json.result || {};
  const data = Array.isArray(res.data) ? res.data : [];
  return { ok: true, projects: data, total: Number(res.total) || data.length, account: acc.name };
}

/** 归一化一个 connector（已装或模板，两者字段几乎相同） */
function normalizeConnector(c) {
  if (!c || typeof c !== 'object') return null;
  const cfg = c.config && typeof c.config === 'object' ? c.config : {};
  return {
    id: c.id || null,
    code: c.code || c.templateCode || null,
    name: c.name || null,
    remark: c.remark || null,
    source: c.source || null,
    // `builtin` = 官方内置模板；`installed` 才是本账号已接入的
    connectionStatus: c.connectionStatus || null,
    enabled: typeof c.enabled === 'boolean' ? c.enabled : null,
    // 接入方式（实测模板里是 streamablehttp + serverUrl）
    transProtocol: cfg.transProtocol || null,
    serverUrl: cfg.serverUrl || null,
    authType: cfg.authType || null,
    icon: c.icon || null,
  };
}

/**
 * 已安装的 MCP connector 列表。
 *
 * 实测本账号 `total: 0`（没装任何 connector）——**空列表是真实结果，不是错误**。
 * 要证明端点活着看 `connectorTemplates()`（50 个模板恒有）。
 */
async function listConnectors(opts = {}) {
  const acc = opts.account || pickCookieAccount();
  if (!acc) return { ok: false, connectors: [], error: '没有可用的网页账号（需先添加搭子网页凭证）' };
  const r = await getJson(acc.cookie, '/api/dumate/connector/v2/list');
  const err = apiError(r, 'connector 列表');
  if (err) return { ok: false, connectors: [], error: err };
  const res = r.json.result || {};
  const list = Array.isArray(res.list) ? res.list : [];
  return {
    ok: true,
    connectors: list.map(normalizeConnector).filter(Boolean),
    total: Number(res.total) || list.length,
    account: acc.name,
  };
}

/**
 * MCP connector **模板**列表（官方内置，50 个）。
 *
 * 这是「搭子能接哪些第三方 MCP」的权威清单——每条带 `serverUrl` 与
 * `transProtocol`，理论上可以据此自己接（不经搭子）。但注意 `authType: oauth2`
 * 的那些需要走各自的授权流程，不是塞一个 token 就能用。
 */
async function connectorTemplates(opts = {}) {
  const acc = opts.account || pickCookieAccount();
  if (!acc) return { ok: false, templates: [], error: '没有可用的网页账号（需先添加搭子网页凭证）' };
  const r = await getJson(acc.cookie, '/api/dumate/connector/v2/template/list');
  const err = apiError(r, 'connector 模板列表');
  if (err) return { ok: false, templates: [], error: err };
  const res = r.json.result || {};
  const list = Array.isArray(res.list) ? res.list : [];
  return {
    ok: true,
    templates: list.map(normalizeConnector).filter(Boolean),
    total: Number(res.total) || list.length,
    account: acc.name,
  };
}

/**
 * 技能广场：**端点不存在**（`GET /api/dumate/skills/square/list` 回 404）。
 *
 * 保留这个函数是为了让调用方拿到一条**明确的**「不支持」而不是自己猜一个
 * URL 去试。清单里「技能广场 101 个」那条在网页端不成立——技能是桌面客户端
 * 内部资产（`skills/` 目录），没有 HTTP 列表接口。
 */
async function skillsSquare() {
  return {
    ok: false,
    skills: [],
    error: '技能广场在网页端没有列表接口（GET /api/dumate/skills/square/list 实测 404）；技能是桌面客户端内部资产',
    unsupported: true,
  };
}

module.exports = {
  listSessions, sessionDetail, listProjects, listConnectors, connectorTemplates, skillsSquare,
  normalizeSession, normalizeConnector, apiError, pickCookieAccount, WEB_HOST,
};
