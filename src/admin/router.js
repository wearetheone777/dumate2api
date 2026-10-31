// src/admin/router.js - /api/admin/* 路由分发（对应参考 main.py 的 include_router）
const { currentUser, audit } = require('./auth');

const routes = [];

function register(method, pattern, handler, opts = {}) {
  routes.push({ method, pattern, handler, public: !!opts.public });
}

function mount(prefix, table) {
  for (const r of table) {
    // 规范化尾部斜杠：`path: '/'` 与前缀拼出 '/api/admin/x/'，锚定后正则
    // 会要求双斜杠（'/api/admin/x//?$'），该路由永远匹配不上。
    const combined = prefix + r.path;
    register(r.method, combined.replace(/\/+$/, '') || '/', r.handler, r);
  }
}

// 把注册的路径模式锚定到整串：不锚定的话 `/models/map` 会匹配
// `/models/map/reset`（子串命中），于是更具体的路由永远走不到，
// 请求被前一条带着空 body 处理掉。`:name` 段允许带参数。
function anchor(pattern) {
  if (pattern.startsWith('^')) return pattern;
  const escaped = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) return `([^/]+)`;
      if (seg.startsWith('*')) return `(.*)`;
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return `^${escaped}/?$`;
}

function find(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(anchor(r.pattern));
    if (m) return { route: r, params: m.slice(1).map(decodeURIComponent) };
  }
  return null;
}

function unauthorized(res) {
  sendJSON(res, 401, { error: 'unauthorized' });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // CORS fail-closed（P0-1）：ACAO 仅在 res._cors（入口按白名单算好）里出现。
    // 管理前端与 API 同源，生产不需要 CORS；开发期 Vite 直连用
    // DUMATE_CORS_ORIGINS=http://localhost:5173 显式放行。
    ...(res._cors || {}),
    // 管理端接口是实时数据（模型表、账号、埋点）。浏览器/中间层一旦缓存
    // 就会把「上游已更新」看成「界面还是旧的」，且普通刷新也不会重新请求。
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// 请求体上限。管理接口的载荷都很小（配置、key、探测列表），
// 不设限等于让任何调用者用一次请求把内存吃满。
const MAX_BODY = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        // 不再累积，但要把剩余数据读掉，否则连接不会正常结束
        reject(new Error('body too large'));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res, pathname) {
  const hit = find(req.method, pathname);
  if (!hit) {
    return sendJSON(res, 404, { error: 'not_found', path: pathname });
  }
  if (!hit.route.public) {
    const user = currentUser(req);
    if (!user) return unauthorized(res);
    // 角色强制（2026-11-01 多账户）：viewer 是只读角色——**所有**非 GET 的
    // 管理操作一律 admin，集中在这里判定而不是让几十条路由各自记得判。
    // 一刀切的依据：管理端没有「viewer 也该能写」的场景（签到/改配置/发
    // 消息全部消耗资源或改状态）；具体路由需要放开时在 route 上加
    // `write: true` 白名单即可。
    if (req.method !== 'GET' && user.role !== 'admin' && !hit.route.write) {
      audit(user.username, 'forbidden_write', pathname, `role=${user.role}`);
      return sendJSON(res, 403, { error: 'admin_only' });
    }
    req.user = user;
  }

  let body = null;
  if (req.method !== 'GET') {
    const raw = await readBody(req);
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch (e) {
        // 不回显解析器原文：它会带上出错字节的位置，而登录请求体里是密码。
        // 统一 400，而不是让它冒到 500。
        return sendJSON(res, 400, { error: 'invalid_json' });
      }
    }
  }

  return hit.route.handler({ req, res, body, params: hit.params, user: req.user || null });
}

module.exports = { register, mount, handle, sendJSON, readBody };
