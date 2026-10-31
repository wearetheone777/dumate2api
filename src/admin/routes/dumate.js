// src/admin/routes/dumate.js - 搭子网页端只读查询（会话 / 项目 / MCP connector）
//
// 全部只读：不打模型、不消耗额度、不改账号状态。所以失败**不喂池**
// （读接口的失败与账号健康无关，罚号只会让对话请求被无辜跳过）。
//
// 端点在 `www.dumate.cn`（网页端），鉴权是网页 cookie——不是
// `dumate-svc.baidu.com` 的 app token（打那边一律 nginx 404）。
const { sendJSON } = require('../router');
const api = require('../../dumate-web-api');
const chatlab = require('./chatlab');

/** 计费自检的默认提示（与 Qoder/TRAE/千问探针同族，但口径不同——见路由内注释） */
const BILLING_NOTE = '搭子没有标称倍率（上游不吐 price_factor），billed 是实测「每千 token 积分成本」，'
  + '与其他通道的倍率数字不可互比。cost=null 表示没测到（并发流量混入 / 结算延迟），不补 0。';

const routes = [
  {
    // 会话列表。含标题/时间/目录/模型档位/代码改动统计。
    method: 'GET',
    path: '/sessions',
    handler: async ({ res }) => {
      const r = await api.listSessions();
      if (!r.ok) return sendJSON(res, 200, { sessions: [], count: 0, error: r.error });
      return sendJSON(res, 200, {
        sessions: r.sessions,
        count: r.sessions.length,
        account: r.account || '',
        // 目录是**发起会话那台机器**的本机路径，换机器就失效——界面要标出来
        note: 'directory 是发起会话那台机器的本机路径，不代表当前机器上存在',
      });
    },
  },
  {
    // 单条会话元数据。**参数名必须是 sessionID**（传 id 上游回参数错误）。
    // 且它**不含消息历史**——消息在本地目录里，上游没有拉整段对话的接口。
    method: 'GET',
    path: '/sessions/:id',
    handler: async ({ res, params }) => {
      const r = await api.sessionDetail(params[0]);
      if (!r.ok) return sendJSON(res, 200, { session: null, error: r.error });
      return sendJSON(res, 200, {
        session: r.session,
        note: '这是会话元数据，不含消息历史（消息在本地 session 目录里）',
      });
    },
  },
  {
    method: 'GET',
    path: '/projects',
    handler: async ({ res }) => {
      const r = await api.listProjects();
      return sendJSON(res, 200, {
        projects: r.projects || [], total: r.total || 0, error: r.error || '',
      });
    },
  },
  {
    // 已装的 MCP connector。空列表是**真实结果**（本账号一个都没装），
    // 不是错误——要证明端点活着看 /connectors/templates（50 个模板恒有）。
    method: 'GET',
    path: '/connectors',
    handler: async ({ res }) => {
      const r = await api.listConnectors();
      return sendJSON(res, 200, {
        connectors: r.connectors || [], total: r.total || 0, error: r.error || '',
        note: '空列表 = 该账号未安装任何 connector（不是接口失败）',
      });
    },
  },
  {
    // 官方内置 MCP connector 模板（50 个）。每条带 serverUrl 与 transProtocol。
    method: 'GET',
    path: '/connectors/templates',
    handler: async ({ res }) => {
      const r = await api.connectorTemplates();
      return sendJSON(res, 200, {
        templates: r.templates || [], total: r.total || 0, error: r.error || '',
        note: 'authType=oauth2 的模板需要各自授权流程，不能只塞 token',
      });
    },
  },
  {
    // 技能广场：端点不存在。这里给明确的「不支持」而不是让前端猜 URL。
    method: 'GET',
    path: '/skills',
    handler: async ({ res }) => {
      const r = await api.skillsSquare();
      return sendJSON(res, 200, { skills: [], unsupported: true, error: r.error });
    },
  },
  {
    // 计费自检探针（2026-11-01，与 Qoder/TRAE/千问的同名端点对齐）。
    // 口径：发一个小请求，**网页余额前后差值** = 本次实测消耗（与 chatlab
    // 的 costOf 同一份实现）→ 每千 token 积分成本。搭子没有标称倍率，
    // 所以没有 expected/ratio——这不是缺失，是上游真没有这个字段。
    // **会真实消耗积分**：数数请求 + 512 预算，单次成本实测在分毫级。
    method: 'GET',
    path: '/billing-check',
    handler: async ({ req, res }) => {
      const raw = decodeURIComponent(((req.url.match(/[?&]model=([^&]*)/) || [])[1] || '')).replace(/^dumate\//, '').trim();
      const modelmap = require('../../modelmap');
      const pool = require('../../web-pool');
      const reqlog = require('../../reqlog');
      const billing = require('../../dumate-billing');
      // mapModel 兜底是网关的真实行为——探针沿用并把映射结果透出
      // （传错名测到 fallback 至少看得见，比静默好；带 mapped 字段）。
      const mapped = modelmap.mapModel(raw || 'model-text');
      const startedAt = Date.now();
      const before = await chatlab.snapshotBalances();
      const payload = {
        model: mapped,
        messages: [{ role: 'user', content: 'Count from 1 to 200, digits separated by spaces only, no other text.' }],
        max_tokens: 512,
        stream: false,
      };
      let r;
      try {
        r = await pool.callWithFailover('/chat/completions', 'POST', payload, { timeout: 120000 });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, model: raw || 'model-text', mapped, error: e.message, elapsedMs: Date.now() - startedAt });
      }
      if (!r.ok) {
        return sendJSON(res, 200, { ok: false, model: raw || 'model-text', mapped, error: r.error || `HTTP ${r.status}`, elapsedMs: Date.now() - startedAt });
      }
      const j = r.json || {};
      const u = reqlog.pickUsage(j.usage);
      const after = await chatlab.snapshotBalances();
      const acct = r.account || null;
      const cost = chatlab.costOf(acct && acct.id, before, after);
      const total = u.total || 0;
      const v = billing.verdictOf(cost);
      // 实测值落缓存：模型页「消耗倍率」列按 target 读这里（7 天 TTL）。
      // 只在测到正数时写——unmeasured/zero/negative 都不能当倍率展示。
      const billed = billing.billedRate(cost, total);
      if (billed != null && billed > 0) {
        billing.saveRateEntry(mapped, {
          billed, cost, tokens: total,
          account: acct ? (acct.nickname || acct.name || acct.id) : null,
        });
      }
      try { require('../auth').audit('admin', 'dumate_billing_check', mapped, `cost=${cost} tokens=${total}`); } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, {
        ok: true,
        model: raw || 'model-text',
        mapped,
        account: acct ? (acct.nickname || acct.name || acct.id) : null,
        expected: null, // 搭子无标称倍率，恒 null（不编）
        cost,
        costState: v.state,
        tokens: total,
        billed: billing.billedRate(cost, total),
        elapsedMs: Date.now() - startedAt,
        note: BILLING_NOTE,
      });
    },
  },
];

module.exports = { routes };
