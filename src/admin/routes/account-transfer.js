// src/admin/routes/account-transfer.js - 账号导入 / 导出（admin only）
//
// 与 /system/backup 的分工：那个搬**配置**（模型映射、key、用户表），
// 这个搬**账号凭证**（cookie / refresh token）。两者都不含账本 jsonl。
//
// 安全口径（三条，改之前先读）：
//   1. **导出体含明文凭证**。响应带 `Content-Disposition: attachment` +
//      `Cache-Control: no-store`，前端按文件下载，不留在浏览器缓存里。
//   2. **整组接口只有 admin 能调**。router 的默认规则是「非 GET 一律 admin」，
//      但这里四条里有三条是 GET——GET 默认对 viewer 开放，所以每条都显式查
//      角色。**不要只守 /export**：/summary 与 /fields 虽然不含凭证，但它们
//      是这个功能的观测面，viewer 能读就等于功能对 viewer 可见（用户要求
//      「只有管理员才能操作和显示这些功能」）。守一层 `adminOnly()` 而不是
//      四个 handler 各写一遍，避免新增路由时漏掉。
//   3. **每次导出/导入落审计**，只记通道与条数，不记凭证内容。
const { sendJSON } = require('../router');
const { audit } = require('../auth');
const transfer = require('../../account-transfer');
const CH = require('../../channels');

/**
 * 整组接口的 admin 闸门。返回 true 表示已拒绝（响应已写出），调用方直接 return。
 *
 * 为什么不用 route 上的 `write: true` 之类声明式开关：router 的默认规则是
 * 「**非 GET** 才要 admin」，而本组三个读接口都是 GET——声明式开关只能放宽
 * 不能收紧，收紧必须落在 handler 里。
 */
function denied(res, user) {
  if (user && user.role === 'admin') return false;
  sendJSON(res, 403, { error: 'admin_only' });
  return true;
}

const routes = [
  {
    // 本地账号概览（无凭证）：界面在导出前显示「本机各通道有几个」
    method: 'GET',
    path: '/summary',
    handler: ({ res, user }) => {
      if (denied(res, user)) return;
      return sendJSON(res, 200, {
        ok: true,
        channels: transfer.summarize(),
        fields: transfer.FIELDS,
        note: '导出文件含账号明文凭证；导入按通道 upsert，id 一律重新分配',
      });
    },
  },
  {
    // 导出。GET 便于浏览器直接下载（前端也可以拿 blob 自己存）。
    method: 'GET',
    path: '/export',
    handler: ({ res, req, user }) => {
      // 导出是敏感读：GET 不受 router 的写操作拦截，必须自己判角色
      if (denied(res, user)) return;
      const q = new URL(req.url, 'http://x').searchParams;
      const channel = q.get('channel') || '';
      const region = q.get('region') || '';
      const out = transfer.exportPayload({ channel, region });
      if (!out.ok) return sendJSON(res, 400, out);
      const name = `dumate2api-accounts-${channel || 'all'}-${new Date().toISOString().slice(0, 10)}.json`;
      const body = JSON.stringify(out.payload, null, 2);
      const count = Object.values(out.payload.channels)
        .reduce((n, c) => n + c.accounts.length, 0);
      try { audit(user.username, 'accounts_export', channel || 'all', `${count} 条`); } catch (e) { /* 审计失败不影响导出 */ }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
        'Pragma': 'no-cache',
        'Content-Length': Buffer.byteLength(body),
      });
      return res.end(body);
    },
  },
  {
    // 导入。body: 导出信封 / {channel, accounts} / 裸数组 + ?channel=
    // ?mode=skip|overwrite（默认 skip）、?region=cn|intl（记录自己没带区域时用）
    method: 'POST',
    path: '/import',
    // 整包账号：一个账号记录含 token 约 1KB，几百个账号就过默认的 1MB。
    // 16MB 与网关的 DUMATE_MAX_BODY_MB 默认同一量级，够几百个账号。
    maxBody: 16 * 1024 * 1024,
    handler: ({ res, body, req, user }) => {
      // POST 已被 router 的默认规则拦到 admin；这里仍显式判一次——
      // 整组口径统一，且将来若有人给这条路由加 write:true 放宽，闸门还在。
      if (denied(res, user)) return;
      const q = new URL(req.url, 'http://x').searchParams;
      const mode = q.get('mode') === 'overwrite' ? 'overwrite' : 'skip';
      const channel = q.get('channel') || '';
      const region = q.get('region') || '';
      const out = transfer.importPayload(body, { mode, channel, region });
      if (!out.ok) return sendJSON(res, 400, out);
      const t = out.totals;
      const ids = out.channels.map((c) => c.channel).join(',');
      try {
        audit(user && user.username, 'accounts_import', ids || channel || 'auto',
          `${t.created} 新增 / ${t.updated} 更新 / ${t.skipped} 跳过 / ${t.failed} 失败（mode=${mode}）`);
      } catch (e) { /* 同上 */ }
      return sendJSON(res, 200, {
        ...out,
        note: '导入后按账号池既有规则选号；已过期凭证会如实标在 refreshExpired 计数里，需重新登录才能用',
      });
    },
  },
  {
    // 单通道的导出字段清单（界面「高级」折叠里展示，让人知道搬什么、不搬什么）
    method: 'GET',
    path: '/fields',
    handler: ({ res, user }) => {
      if (denied(res, user)) return;
      return sendJSON(res, 200, {
        ok: true,
        channels: CH.CHANNELS.map((id) => ({
          channel: id,
          label: CH.label(id),
          fields: transfer.FIELDS[id] || [],
          required: transfer.REQUIRED[id] || [],
        })),
        excluded: ['id', 'lastError', 'lastErrorAt'],
        excludedNote: 'id 由目标机重新分配（否则会与已有账号撞号）；lastError 属于源机此刻的状态，搬过来会把早已自愈的错误当成当前故障',
      });
    },
  },
];

module.exports = { routes };
