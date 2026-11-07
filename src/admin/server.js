// src/admin/server.js - 管理系统入口：管理 API + 静态前端托管
//
// 独立进程、独立端口（默认 9081）。它不代理任何模型协议——网关 9080 已经
// 在做那件事，再代理一次只会多一跳延迟和一个故障点。
const http = require('http');
const fs = require('fs');
const path = require('path');

const router = require('./router');
const auth = require('./auth');
const cors = require('../cors');
const { ensureDir } = require('./store');
const { routes: authRoutes } = require('./routes/auth');
const { routes: systemRoutes } = require('./routes/system');
const { routes: keepaliveRoutes } = require('./routes/keepalive');
const { routes: pointsRoutes } = require('./routes/points');
const { routes: statsRoutes } = require('./routes/stats');
const { routes: usageRoutes } = require('./routes/usage');
const { routes: reqlogRoutes } = require('./routes/reqlogs');
const { routes: chatlabRoutes } = require('./routes/chatlab');
const { routes: modelsRoutes } = require('./routes/models');
const { routes: qwenworkRoutes } = require('./routes/qwenwork');
const { routes: traeworkRoutes } = require('./routes/traework');
const { routes: qoderRoutes } = require('./routes/qoder');
const { routes: workbuddyRoutes } = require('./routes/workbuddy');
const { routes: keysRoutes } = require('./routes/keys');
const { routes: ccswitchRoutes } = require('./routes/ccswitch');
const { routes: accountRoutes } = require('./routes/account');
const { routes: webAccountsRoutes } = require('./routes/accounts');
const { routes: checkinRoutes } = require('./routes/checkin');
const { routes: dumateRoutes } = require('./routes/dumate');
const autotask = require('./routes/autotask');
const taskScheduler = require('../task-scheduler');
// 启动接线（集成阶段）：池状态机 / 热配置 / 计量挂钩与本进程优雅停止。
// 保活排程随下方 taskScheduler.schedule() 在本进程唤醒（task-scheduler.js 内部
// 调 keepalive.schedule()），网关进程不排——见 ../boot.js 文件头。
const boot = require('../boot');

const PORT = parseInt(process.env.DUMATE_ADMIN_PORT || '9081', 10);
const HOST = process.env.DUMATE_ADMIN_HOST || '127.0.0.1';
const DIST = path.resolve(__dirname, '..', '..', 'web', 'dist');
const PREFIX = '/api/admin';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.map': 'application/json; charset=utf-8',
};

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function serveStatic(res, urlPath) {
  // 去掉查询串，规范化成 dist 内的相对路径；若越界则回退 index.html。
  // decodeURIComponent 对非法百分号转义会抛 URIError，而本函数由
  // http.createServer 回调直接调用、不在 router.handle 的 catch 之内——
  // 未捕获异常会直接结束进程，且触发条件是未认证的（`/%ZZ` 即可）。
  let clean;
  try {
    clean = decodeURIComponent(urlPath.split('?')[0]);
  } catch (e) {
    return sendFile(res, path.join(DIST, 'index.html'));
  }
  let rel = clean.replace(/^\/+/, '');
  const target = path.resolve(DIST, rel);
  const inside = target === DIST || target.startsWith(DIST + path.sep);
  const candidate = inside && rel ? target : path.join(DIST, 'index.html');

  fs.stat(candidate, (err, st) => {
    if (err || !st.isFile()) {
      // vue-router 走 history 模式：未知路径交回 index.html 由前端路由解析
      return sendFile(res, path.join(DIST, 'index.html'));
    }
    return sendFile(res, candidate);
  });
}

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
    });
    res.end(buf);
  });
}

function sendJSON(res, status, data, extraHeaders) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // CORS fail-closed（P0-1）：见 ../cors.js；默认不发 ACAO
    ...(res._cors || {}),
    // 管理端接口是实时数据（模型表、账号、埋点）。浏览器/中间层一旦缓存
    // 就会把「上游已更新」看成「界面还是旧的」，且普通刷新也不会重新请求。
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

router.mount(PREFIX + '/auth', authRoutes.map((r) => ({ ...r, path: r.path.replace(/^\/auth/, '') })));
router.mount(PREFIX + '/system', systemRoutes);
router.mount(PREFIX + '/keepalive', keepaliveRoutes);
router.mount(PREFIX + '/billing', require('./routes/billing').routes);
router.mount(PREFIX + '/points', pointsRoutes);
router.mount(PREFIX + '/stats', statsRoutes);
router.mount(PREFIX + '/usage', usageRoutes);
router.mount(PREFIX + '/reqlogs', reqlogRoutes);
router.mount(PREFIX + '/chatlab', chatlabRoutes);
router.mount(PREFIX + '/models', modelsRoutes);
router.mount(PREFIX + '/qwenwork', qwenworkRoutes);
router.mount(PREFIX + '/traework', traeworkRoutes);
router.mount(PREFIX + '/qoder', qoderRoutes);
router.mount(PREFIX + '/workbuddy', workbuddyRoutes);
router.mount(PREFIX + '/keys', keysRoutes);
router.mount(PREFIX + '/cc-switch', ccswitchRoutes);
router.mount(PREFIX + '/agent-setup', require('./routes/agent-setup').routes);
router.mount(PREFIX + '/channel-balance', require('./routes/channel-balance').routes);
router.mount(PREFIX + '/account', accountRoutes);
router.mount(PREFIX + '/web-accounts', webAccountsRoutes);
router.mount(PREFIX + '/checkin', checkinRoutes);
router.mount(PREFIX + '/dumate', dumateRoutes);
router.mount(PREFIX + '/auto-checkin', autotask.routes);

const server = http.createServer((req, res) => {
  // 整个回调包一层：静态分支与同步抛错都不在 router.handle 的 catch 之内，
  // 一个未捕获异常会让管理端整个进程退出（界面、key、审计全下线）
  try {
    handleRequest(req, res);
  } catch (err) {
    log('request error:', err.message);
    if (!res.headersSent) sendJSON(res, 500, { error: 'internal_error' });
    else res.end();
  }
});

function handleRequest(req, res) {
  // CORS 白名单判定（fail-closed，P0-1）：入口算一次挂到 res 上，
  // router/admin 的 sendJSON 与下面的 preflight 统一取用。
  res._cors = cors.headersFor(req);
  // CORS preflight：仅白名单命中的 Origin 才回 ACAO。开发期 Vite(5173) 直连
  // 本端口需在 DUMATE_CORS_ORIGINS 里显式列出；生产同源不需要 CORS。
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...res._cors,
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  const url = req.url.split('?')[0];

  if (url === PREFIX + '/healthz') {
    // 进程身份（2026-11-07 融合项 P1-6）：与网关 /health 同口径——service 是
    // 品牌级判据，role 区分入口。管理端没有独立的 X-Service 探测需求，
    // 头也一并带上，四个进程口径完全一致。
    const identity = require('../service-identity').identity('admin');
    return sendJSON(res, 200, {
      status: 'ok',
      service: identity.service,
      role: identity.role,
    }, { 'X-Service': identity.service });
  }

  if (url.startsWith(PREFIX + '/')) {
    // 异步链上的拒绝也要收在这里：router.handle 内部对 JSON 解析失败等
    // 会 reject，不加 catch 就是 unhandledRejection → 进程退出
    return router.handle(req, res, url).catch((err) => {
      log('route error:', err.message);
      if (!res.headersSent) sendJSON(res, 500, { error: 'internal_error' });
      else res.end();
    });
  }

  return serveStatic(res, url);
}

function start() {
  ensureDir();
  // 定时器只在进程内，重启后按保存的配置重新排期
  autotask.schedule();
  // 任务轮询定时器同样只活在进程内，重启后按保存的配置重新排期
  taskScheduler.schedule();
  // 低频余额刷新（2026-11-07 融合项 P1-5）：默认关闭，配置落盘后重启自恢复
  try { require('../balance-refresh').schedule(); } catch (e) { log(`⚠ 余额刷新排程异常（不阻断启动）: ${e.message}`); }
  // 运行时模块接线（池恢复 / livecfg / 计量探活），失败不阻断管理端启动
  try { boot.init({ log }); } catch (e) { log(`⚠ 启动接线异常（不阻断启动）: ${e.message}`); }
  // 优雅停止：保活排程与进行中的一轮、池状态、计量分桶落盘后再退
  process.once('SIGINT', () => {
    log('收到 SIGINT，刷盘退出…');
    try { require('../balance-refresh').stop(); } catch (e) { /* 停不掉就随进程退 */ }
    boot.shutdown('SIGINT', true);
  });
  process.once('SIGTERM', () => {
    log('收到 SIGTERM，刷盘退出…');
    try { require('../balance-refresh').stop(); } catch (e) { /* 同上 */ }
    boot.shutdown('SIGTERM', true);
  });
  process.once('exit', () => { try { boot.shutdown('exit'); } catch (e) { /* 退出路径不再抛 */ } });
  log('dumate2api admin starting...');

  if (process.argv.includes('--reset-admin')) {
    // 支持 --password=xxx：默认随机串要手抄，输错一个字符就白跑一轮
    const arg = process.argv.find((a) => a.startsWith('--password='));
    const plain = arg ? arg.slice('--password='.length) : null;
    if (plain !== null && plain.length < 6) {
      log('  ✗ 密码至少 6 位，未做修改');
      process.exit(1);
    }
    const pwd = auth.resetAdminPassword(plain);
    log('');
    log('  管理员密码已重设');
    log(`    用户名: admin`);
    log(`    密码:   ${pwd}`);
    log('  旧会话已全部失效。');
    log('');
  } else {
    const { created } = auth.bootstrapUsers();
    if (created) {
      // 只在首次启动出现一次：写进文件等于在磁盘上留一份明文口令。
      // 丢了就用 `node src/admin/server.js --reset-admin` 重设。
      log('');
      log('  初始管理员已创建');
      log(`    用户名: admin`);
      log(`    密码:   ${created}`);
      log('  请登录后立即修改，此密码不会再显示。');
      log('');
    }
  }

  server.listen(PORT, HOST, () => {
    log(`✓ admin listening on http://${HOST}:${PORT}`);
    if (!fs.existsSync(path.join(DIST, 'index.html'))) {
      log('⚠ web/dist/index.html missing — run `cd web && npm run build` to serve the UI');
    }
  });
}

start();

module.exports = { server };
