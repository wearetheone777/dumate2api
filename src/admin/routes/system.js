// src/admin/routes/system.js - 网关与上游状态
const http = require('http');
const discovery = require('../../discovery');
const launcher = require('../../upstream-launcher');
const livecfg = require('../../livecfg');

// 要观察的网关端口。默认 9080（稳定版），开发实例通过 DUMATE_ADMIN_GATEWAY_PORT
// 指向 9082——管理端与网关是两个独立进程，各自监听不同端口，不能让管理端
// 写死去看 9080，否则开发实例会显示稳定版的数字。
const PROXY_PORT = parseInt(
  process.env.DUMATE_ADMIN_GATEWAY_PORT || process.env.DUMATE2API_PORT || '9080',
  10,
);

function probeJSON(port, path, method = 'GET', body = null) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        timeout: 3000,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve({ ok: true, status: res.statusCode, data: JSON.parse(data) }); }
          catch (e) { resolve({ ok: true, status: res.statusCode, data: data }); }
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

// 复用发现链路即可，不另造一套判定：三级降级各查一次，
// 让界面能回答「端口是怎么找到的」，而不只是报一个数字。
// 全部走异步版本——PowerShell 冷启动 5 秒以上，同步调用会把管理端
// 整个事件循环卡住，期间所有页面都无响应。
async function discoveryTrail() {
  const cli = await discovery.discoverViaCommandLineAsync();
  const sockets = await discovery.discoverViaListeningSocketsAsync();
  const trail = [];
  if (cli) trail.push({ method: 'command-line --port', port: cli, hit: false });
  for (const p of sockets) trail.push({ method: 'listening socket', port: p, hit: false });
  return { trail, cli };
}

/** 区域视图参数（2026-11-03）：'cn' / 'intl'，缺省 = ''（全量，行为不变） */
function regionOf(url) {
  const m = String(url || '').match(/[?&]region=([^&]*)/);
  if (!m) return '';
  const raw = decodeURIComponent(m[1]).toLowerCase();
  if (raw === 'cn') return 'cn';
  if (raw === 'intl' || raw === 'global') return 'intl';
  return '';
}

/** 账号的区域归一：只有明确 global/intl 才是国际，其余（含缺省）一律国内 */
function normRegion(v) {
  const s = String(v || '').toLowerCase();
  return (s === 'global' || s === 'intl') ? 'intl' : 'cn';
}

const routes = [
  {
    // 热配置读（F5/F6c）。返回当前生效的快照与落盘文件名——界面上
    // 「这个开关到底存在哪」要能被回答。只有白名单字段，见 src/livecfg.js。
    method: 'GET',
    path: '/config',
    handler: async ({ res }) => {
      require('../router').sendJSON(res, 200, {
        ok: true,
        file: livecfg.FILE,
        fields: livecfg.FIELDS,
        config: livecfg.Load(),
      });
    },
  },
  {
    // 热配置写。patch 语义：只传要改的键；未知键 400（白名单外不收，
    // 手滑写错键名让它静默无效比报错更伤）。写完立即生效：网关进程按
    // mtime 重读，不需要重启。
    method: 'PUT',
    path: '/config',
    handler: async ({ res, body }) => {
      try {
        const config = livecfg.Store(body || {});
        require('../router').sendJSON(res, 200, { ok: true, config });
      } catch (e) {
        require('../router').sendJSON(res, 400, { ok: false, error: e.message });
      }
    },
  },
  {
    method: 'GET',
    path: '/status',
    handler: async ({ req, res }) => {
      const proxy = await probeJSON(PROXY_PORT, '/health');

      let upstreamPort = proxy.ok && proxy.data ? proxy.data.upstream_port : null;
      let upstreamManaged = proxy.ok && proxy.data ? proxy.data.upstream_managed : false;
      let source = proxy.ok ? 'gateway /health' : 'unavailable';

      // 网关起了就直接用它的答案，不再跑发现链路：那两次 PowerShell 探测
      // 在本机实测合计要 20 秒以上，而结果对界面只是「端口是怎么找到的」
      // 这句说明——为一个展示字段付 20 秒延迟不值得。
      // 只有网关不可用时才真的需要自己去发现。
      let trail = [];
      if (proxy.ok) {
        trail = [{ method: 'gateway /health', port: upstreamPort, hit: true }];
      } else {
        const found = await discoveryTrail();
        trail = found.trail;
        const port = await discovery.discoverPort();
        if (port) {
          upstreamPort = port;
          source = 'admin direct discovery';
          upstreamManaged = port === discovery.MANAGED_PORT;
        }
        for (const step of trail) {
          if (step.port === upstreamPort) step.hit = true;
        }
      }

      const install = {
        dir: launcher.installRoot(),
        exe_exists: require('fs').existsSync(launcher.exePath()),
        config_exists: require('fs').existsSync(launcher.configPath()),
      };

      const profile = launcher.activeProfile();

      require('../router').sendJSON(res, 200, {
        admin: { port: req.socket.localPort, pid: process.pid },
        gateway: {
          port: PROXY_PORT,
          online: proxy.ok,
          upstream_port: upstreamPort,
          upstream_managed: upstreamManaged,
          source,
        },
        upstream: {
          port: upstreamPort,
          managed: upstreamManaged,
          managed_port: discovery.MANAGED_PORT,
          discovery: trail,
        },
        install,
        account: profile ? { name: profile.name, user_id: profile.userId } : null,
        versions: { node: process.version, admin: 'module-2' },
        // 两个上游通道并列报出。搭子是本地 HTTP 上游（有端口），
        // 千问办公是进程内直连（无端口，靠 wasm + 登录态）。
        // 分开报是为了让界面能回答「qwen/ 请求会在哪一步失败」。
        channels: (() => {
          // 搭子的账号信息与回落状态。
          //
          // 为什么必须报这两样：桌面凭证不可用时网关会**自动回落到网页凭证池**
          // （fallback-web.js），此时 ready=false 但请求仍然成功——界面若只看
          // ready，会把「正在用网页池」说成「凭证坏了」；而桌面凭证失效且回落
          // 也不可用时请求是真的全失败，此时又必须能说出来。
          // 网关的 /health 已经有 channels.dumate.fallback，这里补上同一口径。
          const dumateExtra = (() => {
            const out = { fallback: null, account: null, accounts: 0 };
            try {
              const launcher = require('../../upstream-launcher');
              const p = launcher.activeProfile();
              if (p) out.account = p.name || p.userId || '';
            } catch (e) { /* 读不到就留 null */ }
            try {
              // 网页凭证池：可用账号数 + 回落开关。回落可用性看「有没有可用账号」
              // 与开关状态，与网关 /health 的 fallback.available 同口径
              const pool = require('../../web-pool');
              const state = pool.snapshot ? pool.snapshot() : [];
              out.accounts = state.filter((a) => a.enabled).length;
              out.fallback = {
                enabled: process.env.DUMATE_WEB_FALLBACK !== '0',
                available: state.some((a) => a.enabled),
              };
            } catch (e) { /* 池读不到就留 null */ }
            return out;
          })();
          const out = {
            dumate: {
              id: 'dumate', label: '百度搭子', kind: 'http',
              port: upstreamPort, ready: !!upstreamPort, managed: upstreamManaged,
              ...dumateExtra,
            },
          };
          try {
            const qw = require('../../qwenwork');
            const st = qw.status();
            const authStore = require('../../qwenwork/auth');
            // 账号信息必须从**账号池**读（自持凭证），不是客户端的 auth-v2.dat。
            // 早先这里读 credentials.decryptAuth()，那条链路在改成账号池后就废弃了，
            // 结果是：报出来的名字是旧文件的残留（可能根本不是主账号），
            // 且 refreshExpiresAt 取的是客户端那份早已过期的值，
            // 界面因此常驻「refresh token 已过期」的假告警。
            let acct = {};
            try {
              const a = authStore.preferred();
              if (a) {
                acct = {
                  account: a.nickname || a.username || String(a.id),
                  tier: a.tier || '',
                  // 多账号：报账号数，顶栏与仪表盘据此提示「池里还有几个」
                  accounts: st.accounts || 0,
                  tokenExpiresAt: a.expiresAt || null,
                  refreshExpiresAt: a.refreshExpiresAt || null,
                  refreshExpired: !!(a.refreshExpiresAt && Date.now() >= a.refreshExpiresAt),
                  // <24h 临期预警：过期即必须重新 device flow，提前亮牌
                  refreshExpiringSoon: !!(a.refreshExpiresAt && a.refreshExpiresAt > Date.now()
                    && a.refreshExpiresAt - Date.now() < 24 * 3600 * 1000),
                };
              }
            } catch (e) { /* 账号池读不到就只报通道状态 */ }
            out.qwenwork = {
              id: 'qwenwork', label: '千问办公', kind: 'direct',
              ready: st.ready, wasm: st.wasm ? st.wasm.version : null,
              loggedIn: !!st.loggedIn, error: st.error || '',
              // ACP 链路上游实定档位（最近一次建会话的 extra_data.mode）
              acpMode: st.acpMode || null,
              ...acct,
            };
          } catch (e) {
            out.qwenwork = { id: 'qwenwork', label: '千问办公', kind: 'direct', ready: false, error: e.message };
          }
          try {
            const tw = require('../../traework');
            const st = tw.status();
            const authStore = require('../../traework/auth');
            // TRAE 是多账号自持凭证：报账号数与最早到期的 token，
            // 顶栏徽标与仪表盘据此提示「要不要重新登录」。
            // 区域视图（2026-11-03）：顶栏切国内/国际时只报该区域的账号——
            // 否则国际视图的通道状态卡会写着国内账号名（bsk 真机抓到）
            const reg = regionOf(req.url || '');
            const usableAll = authStore.findUsable();
            const usable = reg ? usableAll.filter((a) => normRegion(a.region) === reg) : usableAll;
            const soonest = usable.reduce((m, a) => {
              const t = a.expiresAt || Infinity;
              return t < m ? t : m;
            }, Infinity);
            const refreshSoonest = usable.reduce((m, a) => {
              const t = a.refreshExpiresAt || Infinity;
              return t < m ? t : m;
            }, Infinity);
            out.traework = {
              id: 'traework', label: 'TRAE Work', kind: 'direct',
              // 区域视图下 ready 按该区域重算：该区没账号就是不可用
              ready: reg ? usable.length > 0 : st.ready,
              loggedIn: reg ? usable.length > 0 : !!st.loggedIn,
              accounts: reg ? usable.length : (st.accounts || 0),
              region: reg || undefined,
              account: usable[0] ? (usable[0].nickname || usable[0].uid || `账号 ${usable[0].id}`) : '',
              tokenExpiresAt: Number.isFinite(soonest) ? new Date(soonest).toISOString() : null,
              refreshExpiresAt: Number.isFinite(refreshSoonest) ? new Date(refreshSoonest).toISOString() : null,
              refreshExpired: Number.isFinite(refreshSoonest) ? Date.now() >= refreshSoonest : false,
              error: reg && !usable.length ? (reg === 'intl' ? '没有国际版账号' : '没有国内账号') : (st.error || ''),
            };
          } catch (e) {
            out.traework = { id: 'traework', label: 'TRAE Work', kind: 'direct', ready: false, error: e.message };
          }
          // Qoder：与 TRAE 同构（多账号自持凭证），但没有 wasm 依赖——
          // 签名纯本地，所以顶栏徽标不该显示「wasm 未知」。
          try {
            const qoder = require('../../qoder');
            const authStore = require('../../qoder/auth');
            const st = qoder.status();
            const usableAll = authStore.findUsable();
            // 区域视图：qoder 内部 global → 日志/界面统一 intl
            const reg = regionOf(req.url || '');
            const usable = reg ? usableAll.filter((a) => (String(a.region || 'cn').toLowerCase() === 'cn' ? 'cn' : 'intl') === reg) : usableAll;
            const soonest = usable.reduce((m, a) => {
              const t = a.expiresAt || Infinity;
              return t < m ? t : m;
            }, Infinity);
            const refreshSoonest = usable.reduce((m, a) => {
              const t = a.refreshExpiresAt || Infinity;
              return t < m ? t : m;
            }, Infinity);
            out.qoder = {
              id: 'qoder', label: 'Qoder', kind: 'direct',
              ready: reg ? usable.length > 0 : st.ready,
              loggedIn: usable.length > 0,
              accounts: reg ? usable.length : (st.accounts || 0),
              region: reg || undefined,
              // 明确标记：不需要任何客户端（与千问的 wasm 依赖形成对照）
              needsClient: false,
              account: usable[0] ? (usable[0].nickname || usable[0].uid || `账号 ${usable[0].id}`) : '',
              tokenExpiresAt: Number.isFinite(soonest) ? new Date(soonest).toISOString() : null,
              refreshExpiresAt: Number.isFinite(refreshSoonest) ? new Date(refreshSoonest).toISOString() : null,
              refreshExpired: Number.isFinite(refreshSoonest) ? Date.now() >= refreshSoonest : false,
              error: reg && !usable.length ? (reg === 'intl' ? '没有国际版账号' : '没有国内账号') : (st.error || ''),
            };
          } catch (e) {
            out.qoder = { id: 'qoder', label: 'Qoder', kind: 'direct', ready: false, needsClient: false, error: e.message };
          }
          // WorkBuddy：第五通道（双区域）
          try {
            const wb = require('../../workbuddy');
            const authStore = require('../../workbuddy/auth');
            const st = wb.status();
            const usableAll = authStore.findUsable();
            const reg = regionOf(req.url || '');
            const usable = reg ? usableAll.filter((a) => (String(a.region || '').toLowerCase() === 'global' ? 'intl' : 'cn') === reg) : usableAll;
            out.workbuddy = {
              id: 'workbuddy', label: 'WorkBuddy', kind: 'direct',
              ready: reg ? usable.length > 0 : st.ready,
              loggedIn: usable.length > 0,
              accounts: reg ? usable.length : (st.accounts || 0),
              region: reg || undefined,
              needsClient: false,
              account: usable[0] ? (usable[0].nickname || usable[0].uid || `账号 ${usable[0].id}`) : '',
              error: reg && !usable.length ? (reg === 'intl' ? '没有国际版账号' : '没有国内账号') : (st.error || ''),
            };
          } catch (e) {
            out.workbuddy = { id: 'workbuddy', label: 'WorkBuddy', kind: 'direct', ready: false, needsClient: false, error: e.message };
          }
          return out;
        })(),
      });
    },
  },
  {
    // ── 运维动作（2026-11-07 清单项 11）──三个写操作都是 admin-only
    //（router 层对非 GET 统一强制），每个都落审计。

    // 池一键复活：把所有非健康账号（冷却/熔断/禁用/暂停）逐个 revive。
    // 用途：明确知道是「误伤」（比如限流被放大成熔断的那次教训）后的快速复位，
    // 不是日常操作——日常恢复走 keepalive 的余额解冻闭环。
    method: 'POST',
    path: '/pool-revive-all',
    handler: ({ res }) => {
      const { pool } = require('../../pool');
      const rows = pool.snapshot() || [];
      const sick = rows.filter((r) => r.state !== 'healthy');
      const revived = [];
      for (const r of sick) {
        try { pool.revive(String(r.id)); revived.push({ id: r.id, uid: r.uid || String(r.id) }); } catch (e) { /* 单个失败不影响其余 */ }
      }
      require('../../admin/auth').audit('admin', 'pool_revive_all', '', `${revived.length}/${sick.length} 复位`);
      return require('../router').sendJSON(res, 200, { ok: true, revived: revived.length, sick: sick.length, detail: revived });
    },
  },
  {
    // 上游拉起：8980 活着就不动（already_running）；死了 spawn 一个新的并等端口。
    // launcher 是无条件 spawn + 钉死 -port 8980（见 upstream-launcher.js 注释），
    // 所以「重拉」的正确语义是先探测再决定，不是无脑 spawn（端口被占时新进程
    // 绑定失败白死一个）。
    method: 'POST',
    path: '/upstream-relaunch',
    handler: async ({ res }) => {
      const launcher = require('../../upstream-launcher');
      const alive = await launcher.waitForPort(8980, '127.0.0.1', 1500).catch(() => false);
      if (alive) {
        return require('../router').sendJSON(res, 200, { ok: true, action: 'already_running', detail: '8980 已在监听，未动它' });
      }
      try {
        const { pid } = await launcher.ensureUpstreamProcess(8980);
        const up = await launcher.waitForPort(8980, '127.0.0.1', 20000).catch(() => false);
        require('../../admin/auth').audit('admin', 'upstream_relaunch', '8980', up ? 'spawned' : 'spawn 后端口未就绪');
        return require('../router').sendJSON(res, 200, {
          ok: up, action: 'spawned', pid,
          detail: up ? '已拉起并确认 8980 就绪' : '进程已 spawn 但 20 秒内端口未就绪——看登录态是否有效（launcher 需要 auth.json 有已登录账号）',
        });
      } catch (e) {
        require('../../admin/auth').audit('admin', 'upstream_relaunch', '8980', `失败: ${e.message}`);
        return require('../router').sendJSON(res, 200, { ok: false, action: 'failed', detail: e.message });
      }
    },
  },
  {
    // 配置备份导出（2026-11-07 清单项 14）：**配置类**文件合并成单 JSON 下载；
    // 账本（requests/credits 等，最大的 11MB+）不进包，只给行数清单——
    // 备份的目的是「换机/重装时把配置带走」，账本要整目录拷贝。
    method: 'GET',
    path: '/backup',
    handler: async ({ res }) => {
      const fs = require('fs');
      const path = require('path');
      const { DATA_DIR } = require('../store');
      const CONFIG_FILES = ['model-map.json', 'keepalive.json', 'notify.json', 'keys.json', 'hot-config.json', 'admin-users.json'];
      const config = {};
      for (const f of CONFIG_FILES) {
        const p = path.join(DATA_DIR, f);
        if (fs.existsSync(p)) {
          try { config[f] = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { config[f] = { __error: e.message }; }
        }
      }
      const ledgers = {};
      for (const f of fs.readdirSync(DATA_DIR).filter((x) => x.endsWith('.jsonl'))) {
        try {
          ledgers[f] = fs.readFileSync(path.join(DATA_DIR, f), 'utf8').split('\n').filter(Boolean).length;
        } catch (e) { ledgers[f] = -1; }
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="dumate2api-backup-${new Date().toISOString().slice(0, 10)}.json"`,
        'Cache-Control': 'no-store',
        'Pragma': 'no-cache',
      });
      return res.end(JSON.stringify({
        exported_at: new Date().toISOString(),
        note: 'keys.json 含 API key 明文与 admin-users.json 含密码哈希——备份文件请按敏感凭据保管；账本（jsonl）请直接拷贝 data/ 目录',
        config,
        ledgers,
      }, null, 2));
    },
  },
  {
    // 桌面客户端版本（2026-11-07 清单项 13）：从注册表 Uninstall 键读
    // DisplayVersion。客户端自动升级会改变端点行为（社区实测的端口漂移
    // 就是升级带来的），管理端先要能「看见当前装的是哪个版本」。
    // reg query 走异步 exec + 5 秒超时——PowerShell 冷启动 5 秒以上的教训
    // 在 system.js 头注释里写着，绝不能同步 exec 卡事件循环。
    method: 'GET',
    path: '/dumate-version',
    handler: async ({ res }) => {
      const { exec } = require('child_process');
      const version = await new Promise((resolve) => {
        const cmd = 'reg query HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s /f "DuMate" /d';
        const t = setTimeout(() => resolve(null), 5000);
        exec(cmd, { timeout: 4500 }, (err, stdout) => {
          clearTimeout(t);
          if (err) return resolve(null);
          const m = String(stdout || '').match(/DuMate\s+([\d.]+)/);
          resolve(m ? m[1] : null);
        });
      });
      return require('../router').sendJSON(res, 200, { ok: true, version, hint: version ? null : '注册表查询失败或未安装（5 秒超时也可能只是机器忙）' });
    },
  },
  {
    // 配置恢复（调研 P1-8）：与 /backup 成对。恢复前自动把当前配置打进
    // data/config-backup/，逐文件原子写，非法整包一口拒掉（不做半恢复）。
    // 响应带 no-store——备份/恢复体含 key 明文与口令哈希。
    method: 'POST',
    path: '/restore',
    handler: ({ res, body, user }) => {
      const out = require('../../config-restore').restore(body);
      if (!out.ok) return require('../router').sendJSON(res, 400, out);
      try {
        require('../auth').audit(user && user.username, 'config_restore', out.backup, `${out.restored.length} 个文件`);
      } catch (e) { /* 审计失败不影响已完成的恢复 */ }
      return require('../router').sendJSON(res, 200, {
        ...out,
        note: '已恢复配置类文件；账本 jsonl 与账号凭证不在恢复范围，需整目录拷贝。其他进程按 mtime 热读，无需重启。',
      });
    },
  },
];

module.exports = { routes };
