// src/admin/routes/logs.js - 服务端运行日志（只读 + SSE 推送 + ZIP 导出）
//
// 调研 P1-9 + 批次十八。端点：
//   GET /api/admin/logs?level=&keyword=&channel=&limit=     最近日志（先回放）
//   GET /api/admin/logs/stream?level=&keyword=&channel=     SSE 先回放再推新
//   GET /api/admin/logs/export?days=N                       近 N 天归档打包 ZIP
//
// channel 是 logbuffer 的三频道（chat/task/sys）：task 结果单独一环，
// 不被将来可能出现的对话流量冲掉。未知频道返回空集合——不猜。
//
// 与 /reqlogs（业务请求明细）不互相替代：这里看的是进程运行日志
// （启动、排程失败、上游异常），前者看的是一次模型请求的 token/状态。
//
// 鉴权：router.handle 统一要求 admin 会话；非 GET 由路由层一刀切 admin。
// 订阅者上限 4（logbuffer），超出 429——SSE 长连接比普通 GET 贵；
// 归档走 sink 管道，不占这个名额。
const { sendJSON } = require('../router');
const logbuffer = require('../logbuffer');
const logarchive = require('../logarchive');

function filterOf(req) {
  const raw = String(req.url || '');
  const get = (k) => decodeURIComponent((raw.match(new RegExp(`[?&]${k}=([^&]*)`)) || [])[1] || '');
  return { level: get('level'), keyword: get('keyword'), channel: get('channel') };
}

const routes = [
  {
    method: 'GET',
    path: '',
    handler: ({ res, req }) => {
      const raw = String(req.url || '');
      const limit = Math.min(500, Math.max(1, parseInt((raw.match(/[?&]limit=(\d+)/) || [])[1] || '200', 10) || 200));
      const rows = logbuffer.shared.read(filterOf(req)).slice(-limit);
      return sendJSON(res, 200, {
        rows,
        total: logbuffer.shared.size(),
        byChannel: logbuffer.shared.sizeByChannel(),
        capacity: logbuffer.MAX_LINES,
      });
    },
  },
  {
    method: 'GET',
    path: '/stream',
    handler: ({ res, req }) => {
      const filter = filterOf(req);
      const unsub = logbuffer.shared.subscribe((e) => {
        if (filter.level && e.level !== filter.level) return;
        if (filter.channel && e.ch !== filter.channel) return;
        if (filter.keyword && !e.text.toLowerCase().includes(filter.keyword.toLowerCase())) return;
        try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch (err) { /* 连接已断 */ }
      }, filter);
      if (!unsub) return sendJSON(res, 429, { error: 'too_many_log_subscribers' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        ...(res._cors || {}),
      });
      // 回放：先给订阅者看最近的状态，不必等下一条日志
      for (const e of logbuffer.shared.read(filter)) {
        try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch (err) { /* 连接已断 */ }
      }
      const keepAlive = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (err) { clearInterval(keepAlive); }
      }, 15000);
      const cleanup = () => { clearInterval(keepAlive); unsub(); };
      req.once('close', cleanup);
      res.once('close', cleanup);
    },
  },
  {
    method: 'GET',
    path: '/export',
    handler: ({ res, req }) => {
      const raw = String(req.url || '');
      const days = parseInt((raw.match(/[?&]days=(\d+)/) || [])[1] || '7', 10) || 7;
      if (days < 1 || days > logarchive.RETENTION_DAYS) {
        return sendJSON(res, 400, { error: 'days_out_of_range', max: logarchive.RETENTION_DAYS });
      }
      const zip = logarchive.exportZip(days);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zip.name}"`,
        'Content-Length': zip.body.length,
        ...(res._cors || {}),
      });
      res.end(zip.body);
    },
  },
];

module.exports = { routes };
