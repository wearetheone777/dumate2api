// src/traework/oauth-callback.js - 登录回调的本机回环监听（2026-11-16 调研 P0-2a）
//
// ## 它解决什么
//
// 在此之前，加一个 TRAE 账号必须：点「打开授权页」→ 登录 → **手动从地址栏
// 复制那条长 URL** → 粘回管理端。抄错一个字符就换票失败，而且没有取消入口。
//
// 现在多了一条更省事的路径：发起登录时在 **127.0.0.1** 起一个临时监听，
// 官方授权页会自己跳回来，回调直接被接住并换票入库。手贴回调的旧路径**保留**
// （浏览器与网关不在同一台机器、或网关在容器里时，浏览器的 localhost 不是
// 网关的 localhost——那种场景只能粘贴，见 hub v1.6.0 的同款说明）。
//
// ## 端口为什么默认 18080 而不是随机端口
//
// hub v1.6.0 用随机端口是通的（它的文档这么写），但**我们的 18080 是 2026-11-03
// 真机验证过的那条 URL**（`src/traework/login.js` 的 REDIRECT）。登录是「一次不成
// 就白等 10 分钟」的动作，没有收益却要赌上游对随机端口的宽容度，不值得。
// 所以：默认 18080，可用 `DUMATE_TRAEWORK_LOGIN_PORT` 显式改（改了就两边一致，
// 不信的人自己验证）。端口被占用就**明确报错**，不静默换端口——静默换端口会让
// 授权页跳到一个没人监听的地址，表现为「登录完了什么都没发生」。
//
// ## 安全边界（每一条都对应一个真实的攻击面）
//
//   · 只绑 127.0.0.1，不绑 0.0.0.0；
//   · 校验 Host（防 DNS rebinding：恶意站点把自己的域名解析到 127.0.0.1）；
//   · **不发任何 CORS 头**（默认就是拒绝跨源读响应）；
//   · `state`（= 上游的 `login_trace_id`）单次消费、10 分钟到期、
//     收到后立即关闭监听；
//   · 回调 query **不进日志**（里面有 refreshToken）；
//   · 未知 sid / 已取消 / 已过期 → 拒绝，且不泄露别的会话存在与否；
//   · 换票失败时**不重试**（那是换票层的事），状态如实报 failed。
//
// ## 一条刻意的「不严格」
//
// 上游回调是否**一定**回显 `login_trace_id` 没有证据（hub 自己也这么写：官方客户端
// 静态代码没有证明所有地区都回显）。所以这里不做「没带 trace 就拒绝」——那会把
// 国内版可能正常的登录打挂。规则是：**带了 trace 就必须对，没带就放行并标记
// `trace_verified:false`**，把这个不确定性摆在界面上，而不是猜一个方向。
const http = require('http');
const crypto = require('crypto');

const DEFAULT_PORT = Number(process.env.DUMATE_TRAEWORK_LOGIN_PORT || 18080);
const PATH = '/authorize';
const TTL_MS = 10 * 60 * 1000;
const SID_BYTES = 16;
const STATE_BYTES = 32;

/** 回调里可能承载 trace 的字段名（上游不同区域/版本用过不同的） */
const TRACE_KEYS = ['login_trace_id', 'loginTraceID', 'loginTraceId', 'state', 'trace'];

function rand(n) {
  return crypto.randomBytes(n).toString('hex');
}

/** 从回调 URL 里取 trace（取不到返回 ''） */
function traceOf(url) {
  try {
    const q = String(url || '');
    const i = q.indexOf('?');
    const qs = new URLSearchParams(i >= 0 ? q.slice(i + 1) : q);
    for (const k of TRACE_KEYS) {
      const v = qs.get(k);
      if (v) return String(v);
    }
    return '';
  } catch (e) { return ''; }
}

/**
 * 建一个回调代理。
 *
 * @param {{port?:number, ttlMs?:number, now?:()=>number, label?:string}} [opts]
 *   port 监听端口（默认 18080 / env）；ttlMs 会话有效期；now 注入时钟（单测用）
 */
function createBroker(opts = {}) {
  const port = Number(opts.port) > 0 ? Number(opts.port) : DEFAULT_PORT;
  const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : TTL_MS;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  /** sid -> session */
  const sessions = new Map();

  function redirectUrl() {
    return `http://127.0.0.1:${port}${PATH}`;
  }

  function closeServer(s) {
    if (!s || !s.server) return;
    const srv = s.server;
    s.server = null;
    // 只 stop 监听，**不动在途连接**：`closeAllConnections()` 会把还没写完的
    // 响应直接掐断（浏览器看到「连接被重置」而不是「登录成功」）。
    // 到达这里时响应通常还没写出去，所以必须让这一次自己写完。
    try { srv.close(); } catch (e) { /* 已关 */ }
  }

  function settle(s, status, extra) {
    if (!s) return;
    if (s.status !== 'pending' && s.status !== 'exchanging') return;
    s.status = status;
    Object.assign(s, extra || {});
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    closeServer(s);
  }

  function page(title, body) {
    // 极简自包含页面：不引外部资源（宿主机可能离线），也不回显任何 query
    return `<!doctype html><meta charset="utf-8"><title>${title}</title>`
      + '<style>body{font:14px/1.7 system-ui,sans-serif;margin:48px auto;max-width:560px;'
      + 'color:#1f2937;padding:0 20px}h2{font-size:18px;margin:0 0 12px}'
      + 'code{background:#f3f4f6;padding:1px 5px;border-radius:4px}</style>'
      + `<h2>${title}</h2><div>${body}</div>`;
  }

  /** 内部：处理一次回调（本机监听与手动粘贴共用同一条路） */
  async function finish(s, url, handler) {
    if (!s) return { ok: false, status: 404, error: '会话不存在或已结束' };
    if (s.consumed) return { ok: false, status: 409, error: '这次回调已经用过了（单次消费）；请重新发起登录' };
    if (s.status === 'cancelled') return { ok: false, status: 410, error: '登录会话已取消' };
    if (s.status === 'expired' || now() > s.expiresAt) {
      settle(s, 'expired');
      return { ok: false, status: 410, error: '登录会话已过期（10 分钟）；请重新发起' };
    }
    const trace = traceOf(url);
    // 带了 trace 就必须对（防把别人的回调塞进来）；没带只记录，不拒绝（见头注释）
    if (trace && s.state && trace !== s.state) {
      return { ok: false, status: 403, error: 'state 不匹配：这条回调不属于当前登录会话' };
    }
    s.consumed = true;
    s.trace = trace;
    s.traceVerified = !!trace;
    s.status = 'exchanging';
    try {
      const r = await handler(url, s);
      if (r && r.ok) {
        settle(s, 'success', { account: r.account || null });
        return { ok: true, status: 200, account: r.account || null, ...r };
      }
      settle(s, 'failed', { error: (r && r.error) || '换票失败' });
      return { ok: false, status: 200, error: (r && r.error) || '换票失败' };
    } catch (e) {
      settle(s, 'failed', { error: e.message });
      return { ok: false, status: 200, error: e.message };
    }
  }

  /**
   * 发起一次登录会话。
   *
   * @param {{onCallback:function, port?:number}} p
   *   onCallback(url, session) → {ok, account?, error?}：由调用方决定怎么换票入库
   * @returns {Promise<{sessionId, state, redirect, port, expiresAt}>}
   */
  async function start(p = {}) {
    const sid = rand(SID_BYTES);
    const state = rand(STATE_BYTES);
    const session = {
      sid, state, createdAt: now(), expiresAt: now() + ttlMs,
      status: 'pending', consumed: false, trace: '', traceVerified: false,
      account: null, error: '', server: null, timer: null,
      // port 0 表示让 OS 分配（单测用；生产默认 18080——那条 URL 是真机验证过的）
      port: (p.port != null && Number(p.port) >= 0) ? Number(p.port) : port,
      // 调用方上下文（region / deviceId / machineId / accountId…）原样挂着，
      // onCallback 从第二个参数取——broker 不关心业务字段
      context: (p && p.context) || {},
    };

    const server = http.createServer((req, res) => {
      // 只认 GET /authorize：Host 校验挡 DNS rebinding；其余一律 404
      const host = String(req.headers.host || '');
      const okHost = host === `127.0.0.1:${session.realPort}` || host === `localhost:${session.realPort}`;
      if (!okHost) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('forbidden host');
      }
      const pathname = String(req.url || '').split('?')[0];
      if (pathname !== PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('not found');
      }
      // 注意：req.url 里有 refreshToken，任何情况下都不打日志
      const url = `http://${host}${req.url}`;
      finish(session, url, p.onCallback)
        .then((r) => {
          res.writeHead(r.status || 200, {
            'Content-Type': 'text/html; charset=utf-8',
            // 明确不给缓存：这条页面含「登录成功」这种一次性状态
            'Cache-Control': 'no-store',
          });
          res.end(r.ok
            ? page('登录成功', '账号已加入池子，可以关掉这个页面回到管理端。')
            : page('登录未完成', `<code>${String(r.error || '').replace(/[<>&]/g, '')}</code>`));
          // 响应写完之后再回收**空闲**连接：Node 19+ 的默认 agent 会 keep-alive，
          // 不回收的话这条一次性监听在客户端侧看起来还活着（会再收到 409）。
          // 只关 idle（`closeIdleConnections`），不掐正在写的响应。
          setImmediate(() => {
            try { server.closeIdleConnections && server.closeIdleConnections(); } catch (e) { /* 老 Node 没有 */ }
          });
        })
        .catch((e) => {
          try {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('internal error');
          } catch (err) { /* 连接已断 */ }
          settle(session, 'failed', { error: e.message });
        });
    });

    session.realPort = session.port;
    session.server = server;
    await new Promise((resolve, reject) => {
      const onErr = (e) => {
        // 端口占用是最常见的失败：明确告诉用户怎么办，不静默换端口
        const msg = e && e.code === 'EADDRINUSE'
          ? `本机回调端口 ${session.port} 已被占用。关掉占用它的进程，或设 DUMATE_TRAEWORK_LOGIN_PORT=<其他端口> 后重启管理端再试`
          : `本机回调监听失败：${(e && e.message) || e}`;
        reject(new Error(msg));
      };
      server.once('error', onErr);
      server.listen(session.port, '127.0.0.1', () => {
        server.removeListener('error', onErr);
        // port:0 时端口由 OS 给：回填真实值，Host 校验与 redirect 都用它
        try {
          const addr = server.address();
          if (addr && addr.port) { session.port = addr.port; }
        } catch (e) { /* 取不到就沿用请求的端口 */ }
        session.realPort = session.port;
        // 不阻止进程退出（管理端被 kill 时不该被这个监听拖住）
        try { server.unref(); } catch (e) { /* 无 unref 也无所谓 */ }
        resolve();
      });
    });

    session.timer = setTimeout(() => settle(session, 'expired'), ttlMs);
    try { session.timer.unref && session.timer.unref(); } catch (e) { /* ignore */ }
    sessions.set(sid, session);
    return {
      sessionId: sid, state, port: session.port,
      redirect: `http://127.0.0.1:${session.port}${PATH}`,
      expiresAt: session.expiresAt,
    };
  }

  /** 查状态（不返回 refreshToken / 任何凭证） */
  function status(sid) {
    const s = sessions.get(String(sid || ''));
    if (!s) return { status: 'not_found' };
    if (s.status === 'pending' && now() > s.expiresAt) settle(s, 'expired');
    return {
      status: s.status,
      account: s.account || null,
      error: s.error || '',
      // trace 是否被上游回显：这是**证据**，界面要显示（国内版可能不回显）
      trace_verified: s.traceVerified === true,
      expiresAt: s.expiresAt,
      redirect: `http://127.0.0.1:${s.port}${PATH}`,
    };
  }

  /** 手动粘贴回调（浏览器与网关不同机 / 容器部署） */
  async function complete(sid, callbackUrl, handler) {
    const s = sessions.get(String(sid || ''));
    if (!s) return { ok: false, status: 404, error: '会话不存在或已结束' };
    if (!callbackUrl) return { ok: false, status: 400, error: '缺少 callback' };
    return finish(s, String(callbackUrl), handler);
  }

  function cancel(sid) {
    const s = sessions.get(String(sid || ''));
    if (!s) return { ok: false, status: 404, error: '会话不存在或已结束' };
    settle(s, 'cancelled');
    return { ok: true, status: 'cancelled' };
  }

  /** 进程退出/测试用：关掉所有监听 */
  function shutdown() {
    for (const s of sessions.values()) {
      if (s.timer) clearTimeout(s.timer);
      closeServer(s);
    }
    sessions.clear();
  }

  return { start, status, complete, cancel, shutdown, redirectUrl, port, ttlMs, sessions };
}

module.exports = { createBroker, traceOf, DEFAULT_PORT, PATH, TTL_MS, TRACE_KEYS };
