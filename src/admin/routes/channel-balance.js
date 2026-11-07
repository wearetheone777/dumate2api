// src/admin/routes/channel-balance.js - 跨通道额度总览（2026-11-08，P2-10）
//
// 只读端点：GET /api/admin/channel-balance[?force=1]
// 聚合逻辑与缓存都在 src/channel-balance.js（可离线测），这里只做 HTTP 编排。
const balance = require('../../channel-balance');
const { sendJSON } = require('../router');

const routes = [
  {
    method: 'GET',
    path: '',
    handler: async ({ res, req }) => {
      const force = /[?&]force=1\b/.test(req.url || '');
      try {
        const data = await balance.snapshot({ force });
        return sendJSON(res, 200, { ok: true, ...data });
      } catch (e) {
        // 聚合本身崩了如实报错，不返回一张「全部未知」的卡冒充成功
        return sendJSON(res, 200, { ok: false, error: e.message });
      }
    },
  },
];

module.exports = { routes };
