// src/admin/routes/expiring.js - 临期快照只读出仓（批次二十一，账号卡角标数据源）
//
// expiring-snapshot 本来就是现成的（FEFO 选号的写方在管理端 /credits），这里
// 只补一个**只读**出口给前端账号卡：逐账号的最早到期时刻 + 剩余天数 + 快照
// 新鲜度。写方/判据都不动——view() 与网关 accountIds() 是同一套窗口/TTL/未
// 过期判据（src/expiring.js 内部，不得漂移）。
//
// qoder 不在此列：它的临期在自己的 grants 账本里（/qoder/credits 的
// expiringAmount 已按账号透出金额），快照没有它的条目，前端直接用 credits 行。
const { sendJSON } = require('../router');
const expiring = require('../../expiring');

const CHANNELS = ['dumate', 'qwenwork', 'traework', 'workbuddy'];

const routes = [
  {
    method: 'GET',
    path: '',
    handler: ({ res }) => {
      const channels = {};
      for (const ch of CHANNELS) channels[ch] = expiring.view(ch);
      return sendJSON(res, 200, { ok: true, channels, generatedAt: Date.now() });
    },
  },
];

module.exports = { routes, CHANNELS };
