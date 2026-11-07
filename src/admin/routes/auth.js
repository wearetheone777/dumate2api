// src/admin/routes/auth.js - 登录 / 登出 / 当前用户 / 多账户管理 / 踢会话
const crypto = require('crypto');
const auth = require('../auth');
const { clientIP } = require('../iputil');
const { sendJSON } = require('../router');

function setSessionCookie(res, token) {
  const parts = [
    `${auth.COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${24 * 3600}`,
  ];
  // Secure 只在 https 下置位：管理端跑在 127.0.0.1 明文 http，
  // 加了浏览器会直接丢弃 cookie，表现为「登录成功但一刷新就掉线」。
  if (process.env.DUMATE_ADMIN_SECURE_COOKIE === '1') parts.push('Secure');
  const existing = res.getHeader('Set-Cookie');
  const value = parts.join('; ');
  res.setHeader('Set-Cookie', existing ? [].concat(existing, value) : value);
}

function clearSessionCookie(res) {
  const parts = [`${auth.COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  const existing = res.getHeader('Set-Cookie');
  const value = parts.join('; ');
  res.setHeader('Set-Cookie', existing ? [].concat(existing, value) : value);
}

const routes = [
  {
    method: 'POST',
    path: '/auth/login',
    public: true,
    handler: async ({ req, res, body }) => {
      const ip = clientIP(req);
      const username = String((body && body.username) || '').trim();
      const password = String((body && body.password) || '');

      // 前置限流（审计 P1-5）：在锁定计数与 scrypt 校验之前先按 IP 卡窗口，
      // 换用户名稀释锁定键的爆破在这里就被挡下
      if (auth.loginThrottled(ip)) {
        auth.audit(username || 'anonymous', 'login_rate_limited', username, `ip=${ip}`);
        return sendJSON(res, 429, {
          error: 'too_many_attempts',
          retry_after: auth.RATE_WINDOW_MS / 1000,
        });
      }
      auth.recordLoginAttempt(ip);

      if (auth.loginBlocked(ip, username)) {
        auth.audit(username || 'anonymous', 'login_blocked', username, `ip=${ip}`);
        return sendJSON(res, 429, {
          error: 'too_many_attempts',
          retry_after: auth.lockRemaining(ip, username),
        });
      }

      const data = auth.users() || {};
      const user = data[username];
      if (!user || !(await auth.verifyPwd(password, user.hash))) {
        auth.recordFail(ip, username);
        auth.audit(username || 'anonymous', 'login_failed', username, `ip=${ip}`);
        const blocked = auth.loginBlocked(ip, username);
        return sendJSON(res, blocked ? 429 : 401, {
          error: blocked ? 'too_many_attempts' : 'bad_credentials',
          retry_after: auth.lockRemaining(ip, username),
        });
      }

      auth.clearFail(ip, username);
      const token = auth.issueToken(user.username, user.role);
      setSessionCookie(res, token);
      auth.audit(user.username, 'login', '', `ip=${ip}`);
      return sendJSON(res, 200, { username: user.username, role: user.role });
    },
  },
  {
    method: 'POST',
    path: '/auth/logout',
    public: true,
    handler: ({ req, res }) => {
      const user = auth.currentUser(req);
      clearSessionCookie(res);
      if (user) auth.audit(user.username, 'logout');
      return sendJSON(res, 200, { ok: true });
    },
  },
  {
    method: 'GET',
    path: '/auth/me',
    handler: ({ req, res, user }) => sendJSON(res, 200, user),
  },
  {
    method: 'POST',
    path: '/auth/sessions/revoke',
    handler: ({ req, res, user }) => {
      // 递增 session_version：所有已签发的 token 带着旧版本号，立刻全部失效
      auth.revokeSessions(user.username);
      auth.audit(user.username, 'sessions_revoke', user.username);
      return sendJSON(res, 200, { ok: true });
    },
  },

  // ==================== 多账户管理（2026-11-01）====================
  // admin-users.json 本来就是 { username: {username, role, hash, ...} } 的
  // 多账户结构（bootstrap 只生成了 admin 一个），这里补上管理接口。
  // 写操作的 admin-only 由 router 层统一强制（非 GET 一律 admin）。

  {
    method: 'GET',
    path: '/auth/users',
    handler: ({ res, user }) => {
      // 账户管理是 admin 的页面：viewer 没有需要看用户列表的场景
      // （写操作已被 router 层挡掉，这里把读也挡掉，界面不半开）
      if (user.role !== 'admin') return sendJSON(res, 403, { error: 'admin_only' });
      const data = auth.users() || {};
      const users = Object.values(data)
        .map((u) => ({ username: u.username, role: u.role, created_at: u.created_at }))
        .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
      return sendJSON(res, 200, { users, me: user.username });
    },
  },
  {
    method: 'POST',
    path: '/auth/users',
    handler: ({ res, body, user }) => {
      const username = String((body && body.username) || '').trim();
      const password = String((body && body.password) || '');
      const role = String((body && body.role) || 'viewer');
      const problem = userFieldsProblem(username, password, role);
      if (problem) return sendJSON(res, 400, { error: problem });

      const data = auth.users() || {};
      if (data[username]) return sendJSON(res, 400, { error: `用户 ${username} 已存在` });
      data[username] = {
        username,
        role,
        hash: auth.makeHash(password),
        created_at: Date.now(),
        session_version: 0,
      };
      auth.saveUsers(data);
      auth.audit(user.username, 'user_create', username, `role=${role}`);
      return sendJSON(res, 200, { username, role });
    },
  },
  {
    method: 'PATCH',
    path: '/auth/users/:username',
    handler: ({ res, body, user, params }) => {
      const target = params[0];
      const data = auth.users() || {};
      if (!data[target]) return sendJSON(res, 404, { error: '用户不存在' });

      const patch = body || {};
      const password = patch.password !== undefined ? String(patch.password) : undefined;
      const role = patch.role !== undefined ? String(patch.role) : undefined;
      if (password !== undefined && password.length < 8) {
        return sendJSON(res, 400, { error: '密码至少 8 位' });
      }
      if (role !== undefined && !['admin', 'viewer'].includes(role)) {
        return sendJSON(res, 400, { error: 'role 只能是 admin / viewer' });
      }
      // 最后一个 admin 不能被降级成 viewer——包括**自己降自己**（自降后
      // currentUser 读实况角色，会话立刻失去写权限，系统失去管理能力且
      // 无法自救）。先创建另一个 admin 再降级。
      if (role === 'viewer' && data[target].role === 'admin') {
        const admins = Object.values(data).filter((u) => u.role === 'admin');
        if (admins.length <= 1) {
          return sendJSON(res, 400, { error: '不能降级最后一个管理员：先创建另一个 admin' });
        }
      }
      if (role !== undefined) data[target].role = role;
      if (password !== undefined) {
        data[target].hash = auth.makeHash(password);
        // 改密即踢会话：旧 token 带着旧 session_version，立刻失效
        data[target].session_version = (data[target].session_version || 0) + 1;
      }
      auth.saveUsers(data);
      auth.audit(user.username, 'user_update', target,
        `${role !== undefined ? `role=${role} ` : ''}${password !== undefined ? 'password=**' : ''}`.trim());
      return sendJSON(res, 200, { username: target, role: data[target].role });
    },
  },
  {
    method: 'DELETE',
    path: '/auth/users/:username',
    handler: ({ res, user, params }) => {
      const target = params[0];
      if (target === user.username) {
        return sendJSON(res, 400, { error: '不能删除当前登录的账户' });
      }
      const data = auth.users() || {};
      if (!data[target]) return sendJSON(res, 404, { error: '用户不存在' });
      // 最后一个 admin 不能删：删掉后系统失去管理能力且无法自救
      if (data[target].role === 'admin') {
        const admins = Object.values(data).filter((u) => u.role === 'admin');
        if (admins.length <= 1) {
          return sendJSON(res, 400, { error: '不能删除最后一个管理员' });
        }
      }
      delete data[target];
      auth.saveUsers(data);
      auth.audit(user.username, 'user_delete', target);
      return sendJSON(res, 200, { ok: true });
    },
  },
  {
    // 审计日志（2026-11-06 清单项 1）：auth.audit 在 15+ 处埋点（登录/改 key/
    // 改配置/动账号），此前只有落盘没有读取口——这里补上。admin-only：
    // 审计是运维视角（viewer 看到了也只是多一个困惑源，而且里面可能有
    // 账号名/用户名这类敏感字样）。读 data/admin-audit.jsonl，倒序 + 筛选。
    method: 'GET',
    path: '/auth/audit',
    handler: ({ res, req, user }) => {
      if (user.role !== 'admin') return sendJSON(res, 403, { error: 'admin_only' });
      const url = new URL(req.url, 'http://localhost');
      const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
      const action = (url.searchParams.get('action') || '').trim();
      const actor = (url.searchParams.get('actor') || '').trim();
      const all = auth.readAudit();
      const actions = [...new Set(all.map((r) => r.action))].sort();
      let rows = all.slice(-limit).reverse();
      if (action) rows = rows.filter((r) => r.action === action);
      if (actor) rows = rows.filter((r) => r.actor === actor);
      return sendJSON(res, 200, { ok: true, rows, actions, total: all.length });
    },
  },
];

// ---- 多账户的字段校验（纯函数，便于离线测试）----
const USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;
function userFieldsProblem(username, password, role) {
  if (!USERNAME_RE.test(username)) {
    return '用户名须为 2-32 位字母/数字/下划线/连字符';
  }
  if (String(password || '').length < 8) return '密码至少 8 位';
  if (!['admin', 'viewer'].includes(role)) return 'role 只能是 admin / viewer';
  return null;
}

module.exports = { routes, setSessionCookie, clearSessionCookie, userFieldsProblem };
