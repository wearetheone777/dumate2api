// src/admin/routes/dumate.js - 搭子网页端只读查询（会话 / 项目 / MCP connector）
//
// 全部只读：不打模型、不消耗额度、不改账号状态。所以失败**不喂池**
// （读接口的失败与账号健康无关，罚号只会让对话请求被无辜跳过）。
//
// 端点在 `www.dumate.cn`（网页端），鉴权是网页 cookie——不是
// `dumate-svc.baidu.com` 的 app token（打那边一律 nginx 404）。
const { sendJSON } = require('../router');
const api = require('../../dumate-web-api');

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
];

module.exports = { routes };
