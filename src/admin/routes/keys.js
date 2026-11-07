// src/admin/routes/keys.js - API Key 管理
const http = require('http');
const keysvc = require('../../keys');
const reqlog = require('../../reqlog');
const keyQuota = require('../../key-quota');
const { sendJSON } = require('../router');

// 网关的鉴权开关是**网关进程**的环境变量，管理端读自己的 process.env 永远
// 是错的（两个进程环境不同，曾导致页面恒显示「鉴权关闭」而 9082 实际已开）。
// 探测网关 /health 的 require_key 字段才是实况；网关不在线时给 null，
// 前端显示「未知」而不是编一个关闭。
function gatewayRequireKey() {
  const port = parseInt(
    process.env.DUMATE_ADMIN_GATEWAY_PORT || process.env.DUMATE2API_PORT || '9080',
    10,
  );
  return new Promise((resolveProbe) => {
    const r = http.request(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 2500 },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolveProbe({ online: true, requireKey: !!JSON.parse(raw).require_key }); }
          catch (e) { resolveProbe({ online: true, requireKey: null }); }
        });
      },
    );
    r.on('timeout', () => { r.destroy(); resolveProbe({ online: false, requireKey: null }); });
    r.on('error', () => resolveProbe({ online: false, requireKey: null }));
    r.end();
  });
}

// 每个 key 的用量从请求日志聚合，而不是在 key 记录里累加计数：
// 累加会写坏（进程被杀就丢），日志是既成事实，重算总是对的。
// 按 key_id 聚合而非名字——改名不该让历史用量凭空消失。
//
// 按通道分开统计：同一个 key 可能同时用于搭子与千问（网关按模型名前缀
// 分流，不按 key 分流），合并成一个数字就分不清「这把 key 到底在跑哪条通道」。
function usageByKey(days = 30) {
  const since = Date.now() - days * 86400000;
  const { rows } = reqlog.read({ limit: 0, filter: (r) => r.ts >= since && r.key_id });
  const map = {};
  for (const r of rows) {
    const k = r.key_id;
    if (!map[k]) {
      map[k] = {
        requests: 0, total_tokens: 0, failed: 0, last_at: 0,
        // 历史记录没有 channel 字段，归入搭子（分通道前只有搭子一条通道）
        channels: {},
      };
    }
    const m = map[k];
    m.requests++;
    m.total_tokens += r.total_tokens || 0;
    if (r.status >= 400 || r.status === 0) m.failed++;
    if (r.ts > m.last_at) m.last_at = r.ts;
    const ch = r.channel || 'dumate';
    if (!m.channels[ch]) m.channels[ch] = { requests: 0, total_tokens: 0, failed: 0 };
    m.channels[ch].requests++;
    m.channels[ch].total_tokens += r.total_tokens || 0;
    if (r.status >= 400 || r.status === 0) m.channels[ch].failed++;
  }
  return map;
}

// 合法的通道 id。keys.js 存 channel 字段，网关鉴权段据此决定这把 key
// 允许走哪条通道（缺省 = 不限通道，兼容已有 key）
const { CHANNELS, normalize } = require('../../channels');

function checkLists(body) {
  const problems = [];
  for (const field of ['ip_allowlist', 'model_allowlist']) {
    if (body[field] === undefined) continue;
    if (!Array.isArray(body[field])) {
      problems.push(`${field} 必须是数组`);
      continue;
    }
    if (field === 'ip_allowlist') {
      for (const item of body[field]) {
        const v = keysvc.validateCIDR(item);
        if (!v.ok) problems.push(v.reason);
      }
    }
  }
  // 通道：'' / null / undefined 表示不限通道（兼容已有 key）
  if (body.channel !== undefined && body.channel !== null && body.channel !== '') {
    if (!CHANNELS.includes(body.channel)) {
      problems.push(`channel 只能是 ${CHANNELS.join(' / ')} 或留空（不限）`);
    }
  }
  return problems;
}

const routes = [
  {
    method: 'GET',
    path: '',
    handler: async ({ res, req, user }) => {
      const usage = usageByKey(30);
      // plain 是敏感信息（2026-11-01 多账户）：只给 admin。viewer 的会话
      // 虽然能看 key 列表（名称/前缀/用量），但完整明文一律置 null——
      // 过滤必须落在服务端，前端藏按钮挡不住直接 curl。
      const isAdmin = !!user && user.role === 'admin';
      // 通道过滤：管理端切到千问时只列与千问相关的 key
      // （channel 为 qwenwork，或未限定通道的通用 key）
      const chRaw = decodeURIComponent((req.url.match(/[?&]channel=([^&]*)/) || [])[1] || '');
      const ch = normalize(chRaw);
      let list = keysvc.list().map((k) => ({
        ...k,
        plain: isAdmin ? (k.plain || null) : null,
        usage: usage[k.id] || { requests: 0, total_tokens: 0, failed: 0, last_at: 0, channels: {} },
        // 当日配额用量：读**落盘**（网关进程 5s 防抖落盘）——管理端进程的
        // 内存计数器是空的，读内存会恒显示 0
        quota_today: keyQuota.readTodayFromDisk(k.id),
      }));
      if (ch) list = list.filter((k) => !k.channel || k.channel === ch);
      const gw = await gatewayRequireKey();
      return sendJSON(res, 200, {
        keys: list,
        channel: ch,
        // 鉴权开关读网关实况（/health 的 require_key），不读管理端自己的环境变量
        require_key: gw.requireKey,
        gateway_online: gw.online,
        days: 30,
      });
    },
  },
  {
    method: 'POST',
    path: '',
    handler: ({ res, body }) => {
      const problems = checkLists(body || {});
      if (body && body.name !== undefined && !String(body.name).trim()) {
        problems.push('名称不能只有空白');
      }
      if (problems.length) return sendJSON(res, 400, { error: problems.join('；') });

      try {
        const created = keysvc.create(body || {});
        require('../../admin/auth').audit('admin', 'key_create', created.key.name);
        // 明文已随 key 落盘（plain 字段），之后可在列表随时查看复制；
        // 这里仍返回一次方便当场保存
        return sendJSON(res, 200, created);
      } catch (e) {
        // 父 Key 校验失败（不存在 / 超出两级）如实 400，不静默落一把坏 key
        return sendJSON(res, 400, { error: e.message });
      }
    },
  },
  {
    method: 'PATCH',
    path: '/:id',
    handler: ({ res, body, params }) => {
      const problems = checkLists(body || {});
      if (problems.length) return sendJSON(res, 400, { error: problems.join('；') });
      try {
        const updated = keysvc.update(params[0], body || {});
        if (!updated) return sendJSON(res, 404, { error: 'key 不存在' });
        require('../../admin/auth').audit('admin', 'key_update', updated.name);
        return sendJSON(res, 200, updated);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    },
  },
  {
    method: 'DELETE',
    path: '/:id',
    handler: ({ res, params }) => {
      const ok = keysvc.remove(params[0]);
      if (!ok) return sendJSON(res, 404, { error: 'key 不存在' });
      require('../../admin/auth').audit('admin', 'key_delete', params[0]);
      return sendJSON(res, 200, { ok: true });
    },
  },
  {
    // 校验 IP 白名单写法：写错一个 CIDR 会让这把 key 对所有来源都拒绝，
    // 所以在保存前就给明确提示，而不是等请求被拒时才发现
    method: 'POST',
    path: '/check-ip',
    handler: ({ res, body }) => {
      const items = Array.isArray(body && body.items) ? body.items : [];
      return sendJSON(res, 200, {
        results: items.map((i) => ({ item: i, ...keysvc.validateCIDR(i) })),
      });
    },
  },
];

module.exports = { routes };
