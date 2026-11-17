// src/admin/routes/agent-setup.js - 智能体一键配置端点（2026-11-07 融合项 P0-2）
//
// 直写本机 Claude Code（settings.json）与 Codex CLI（config.toml），
// 写前自动备份、一键还原。纯逻辑在 src/agent-setup.js（DI 可测），
// 这里只做 HTTP 编排 + 审计 + 密钥脱敏。
//
// 密钥纪律：body 里的 token 只进配置文件与审计摘要（不记值），
// 响应一律不回显——管理端日志与前端历史里不该出现明文 key。
const setup = require('../../agent-setup');
const channels = require('../../channels');
const { sendJSON } = require('../router');

const CLIENT_IDS = 'claude-code|codex';

const routes = [
  {
    // 客户端清单：装没装、配置文件在哪、是否已指向本网关
    method: 'GET',
    path: '/clients',
    handler: async ({ res }) => {
      return sendJSON(res, 200, {
        ok: true,
        clients: setup.listClients(),
        gateway: setup.gatewayBase(),
        note: 'cc-switch 的写入走专用端点（/api/admin/cc-switch/*），这里只报安装状态',
      });
    },
  },
  {
    // 写入前预览（调研 P2-10）：返回**将写入的差异**，不改任何文件。
    // body 与 /apply 完全一致——用户先在这里看清楚，再点写入。
    // 预览与写入共用 buildNext（同一份计算），所以不可能出现
    // 「预览说没问题、写进去不是那样」。
    method: 'POST',
    path: '/preview',
    handler: async ({ res, body }) => {
      const b = body || {};
      const client = String(b.client || '').trim();
      if (!new RegExp(`^(${CLIENT_IDS})$`).test(client)) {
        return sendJSON(res, 400, { ok: false, error: `client 必须是 ${CLIENT_IDS}` });
      }
      try {
        const r = await setup.preview({
          client,
          channel: b.channel,
          token: b.token,
          models: b.models,
          baseUrl: b.baseUrl,
        });
        // 审计只记「谁预览了谁」，不记内容（diff 里本来也已把 token 打码）
        try { require('../auth').audit('admin', 'agent_setup_preview', `${client}/${r.channel}`, `${r.stats.added}+/${r.stats.removed}-`); } catch (e) { /* 忽略 */ }
        return sendJSON(res, 200, r);
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: `预览失败：${e.message}` });
      }
    },
  },
  {
    // 直写配置。body: {client, channel?, token?, models?, baseUrl?}
    method: 'POST',
    path: '/apply',
    handler: async ({ res, body }) => {
      const b = body || {};
      const client = String(b.client || '').trim();
      if (!new RegExp(`^(${CLIENT_IDS})$`).test(client)) {
        return sendJSON(res, 400, { ok: false, error: `client 必须是 ${CLIENT_IDS}` });
      }
      try {
        const r = await setup.apply({
          client,
          channel: b.channel,
          token: b.token,
          models: b.models,
          baseUrl: b.baseUrl,
        });
        try { require('../auth').audit('admin', 'agent_setup_apply', `${client}/${r.channel}`, `model=${r.model}`); } catch (e) { /* 忽略 */ }
        return sendJSON(res, 200, r);
      } catch (e) {
        // 常见失败：用户 settings.json / config.toml 本身是坏的（解析不了）。
        // 如实报错不静默——静默等于让用户以为配好了。
        return sendJSON(res, 500, { ok: false, error: `写入失败：${e.message}` });
      }
    },
  },
  {
    // 还原最近一份备份。body: {client}
    method: 'POST',
    path: '/restore',
    handler: async ({ res, body }) => {
      const client = String((body || {}).client || '').trim();
      if (!new RegExp(`^(${CLIENT_IDS})$`).test(client)) {
        return sendJSON(res, 400, { ok: false, error: `client 必须是 ${CLIENT_IDS}` });
      }
      const r = setup.restore({ client });
      if (r.ok) {
        try { require('../auth').audit('admin', 'agent_setup_restore', client, r.restoredFrom); } catch (e) { /* 忽略 */ }
        return sendJSON(res, 200, r);
      }
      return sendJSON(res, 404, r);
    },
  },
];

module.exports = { routes };
