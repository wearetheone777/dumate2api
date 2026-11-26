// src/admin/routes/account.js - DuMate 登录态与客户端信息（只读）
//
// 定位：把「这个客户端装在哪、是什么版本、哪个账号在用、登录态还有效吗」
// 集中到一页。全部只读——改 auth.json 属于客户端自己的职责，管理端碰它
// 只会让两边状态不一致。
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const launcher = require('../../upstream-launcher');
const discovery = require('../../discovery');
const { sendJSON } = require('../router');

const APPDATA_DIR = () => path.join(process.env.APPDATA || '', 'qianfan-desktop-app');

// 异步执行 PowerShell。同步版（execFileSync）在本机实测冷启动要 5 秒以上，
// 而它阻塞的是整个事件循环——一个「看一眼进程状态」的请求就能让管理端
// 所有页面一起卡死，这是实测过的故障。
//
// 非 Windows（macOS / Linux）：没有 PowerShell，直接短路返回空串。调用点
// 拿到空串自然降级（版本查不到、进程列表为空），不付一次 ENOENT 失败调用。
function runPS(script, timeout = 12000) {
  if (process.platform !== 'win32') return Promise.resolve('');
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? ((err.stdout) ? String(err.stdout) : '') : String(stdout || '')));
  });
}

// PowerShell 查询结果缓存。本机实测单次 PowerShell 冷启动 5 秒以上，
// 两个查询叠加就是 10-23 秒——而客户端版本和进程列表都不会秒级变化。
// 不缓存的话每次打开页面都要等这么久。
const PS_TTL = 30000;
const psCache = {};

async function cachedPS(key, fn) {
  const hit = psCache[key];
  if (hit && Date.now() - hit.at < PS_TTL) return hit.value;
  const value = await fn();
  psCache[key] = { at: Date.now(), value };
  return value;
}

// 客户端版本只能从可执行文件元数据取：app.asar 是加密的，
// 后端二进制没有版本资源，注册表在部分安装方式下也没有条目。
async function clientVersion() {
  return cachedPS('version', async () => {
    const exe = path.join(launcher.installRoot(), 'DuMate.exe');
    if (!fs.existsSync(exe)) return null;
    const out = (await runPS(
      `(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo | ` +
      `ForEach-Object { $_.FileVersion + '|' + $_.ProductVersion + '|' + $_.CompanyName }`,
    )).trim();
    if (!out) return null;
    const [file, product, company] = out.split('|');
    return { file_version: file || '', product_version: product || '', company: company || '' };
  });
}

// 正在运行的 DuMate 进程。命令行里带着 -port，可用于交叉验证发现结果。
async function runningProcesses() {
  return cachedPS('processes', async () => {
    const out = await runPS(
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'dumate' } | ` +
      `ForEach-Object { $_.ProcessId.ToString() + '|' + $_.Name + '|' + ($_.CommandLine -replace "\\r?\\n", ' ') }`,
    );
    return out.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
      const [pid, name, ...rest] = line.split('|');
      const cmd = rest.join('|');
      const m = cmd.match(/--?port[=\s]+(\d+)/);
      return {
        pid: parseInt(pid, 10) || 0,
        name: name || '',
        port: m ? parseInt(m[1], 10) : null,
        managed_by_proxy: null,
      };
    });
  });
}

// 登录态：只读取身份与时间，绝不回传任何凭证字段。
// auth.json 里 cookies 是加密串、encryptedCookies 是各账号的加密凭证，
// 两者都不出现在响应里。
function loginState() {
  const dir = APPDATA_DIR();
  const authFile = path.join(dir, 'auth.json');
  if (!fs.existsSync(authFile)) {
    return { ok: false, reason: 'auth.json 不存在，可能从未登录过' };
  }
  let j;
  try {
    j = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  } catch (e) {
    return { ok: false, reason: `auth.json 解析失败：${e.message}` };
  }

  const profiles = Array.isArray(j.accountProfiles) ? j.accountProfiles : [];
  const now = Date.now();
  const accounts = profiles.map((p) => {
    const lastLogin = p.lastLogin || 0;
    const active = p.profileId === j.activeProfileId;
    const hasCredentials = !!p.encryptedCookies || active;
    return {
      name: p.displayName || '(未命名)',
      user_id: p.bceUserId || '',
      account_id: p.bceAccountId || '',
      login_type: p.loginType || '',
      last_login: lastLogin,
      age_days: lastLogin ? Math.floor((now - lastLogin) / 86400000) : null,
      active,
      has_credentials: hasCredentials,
      // 上游不提供登录态过期时间，按凭证存在性 + 最后登录时间推断
      state: !hasCredentials ? 'stale' : (lastLogin && now - lastLogin > 30 * 86400000 ? 'stale' : 'active'),
    };
  });

  let stat = null;
  try {
    const st = fs.statSync(authFile);
    stat = { size: st.size, mtime: st.mtimeMs };
  } catch (e) { /* 读不到就算了 */ }

  return {
    ok: true,
    file: authFile,
    file_stat: stat,
    has_top_level_cookies: typeof j.cookies === 'string' && j.cookies.length > 0,
    cookie_key_present: fs.existsSync(path.join(dir, '.cookie-key')),
    active_provider: j.activeProviderType || '',
    accounts,
  };
}

// 安装完整性：可执行文件、配置、登录态目录逐项检查。
//
// 桌面客户端（DuMate.exe + 桌面后端链路）是 Windows 专属：macOS / Linux
// 上没有安装包，逐项检查只会给出一串 D:\ 假路径的「缺失」行，用户会对着
// 不存在的路径排查。非 Windows 整体返回说明，界面明确「当前平台不适用」。
function installCheck() {
  if (process.platform !== 'win32') {
    return {
      platform_note: '桌面客户端（DuMate.exe / 桌面后端链路）仅支持 Windows；macOS / Linux 请使用网页凭证链路',
      checks: [],
    };
  }
  const root = launcher.installRoot();
  const items = [
    { key: 'install_dir', label: '安装目录', path: root, kind: 'dir' },
    { key: 'client_exe', label: '客户端主程序', path: path.join(root, 'DuMate.exe'), kind: 'file' },
    { key: 'backend_exe', label: '后端可执行文件', path: launcher.exePath(), kind: 'file' },
    { key: 'backend_config', label: '后端配置', path: launcher.configPath(), kind: 'file' },
    { key: 'auth_file', label: '登录态文件', path: path.join(APPDATA_DIR(), 'auth.json'), kind: 'file' },
    { key: 'cookie_key', label: '凭证密钥', path: path.join(APPDATA_DIR(), '.cookie-key'), kind: 'file' },
  ];
  return items.map((it) => {
    let exists = false;
    let size = null;
    try {
      const st = fs.statSync(it.path);
      exists = it.kind === 'dir' ? st.isDirectory() : st.isFile();
      if (it.kind === 'file') size = st.size;
    } catch (e) { exists = false; }
    return { key: it.key, label: it.label, path: it.path, kind: it.kind, exists, size };
  });
}

const routes = [
  {
    method: 'GET',
    path: '/',
    handler: async ({ res }) => {
      // 发现链路复用同一个入口，避免与仪表盘给出不一致的端口
      let upstreamPort = null;
      try { upstreamPort = await discovery.discoverPort(); } catch (e) { upstreamPort = null; }

      const ic = installCheck();
      return sendJSON(res, 200, {
        install: {
          // 非 Windows 没有桌面客户端，安装目录无从谈起，如实给 null
          dir: process.platform === 'win32' ? launcher.installRoot() : null,
          platform_note: ic.platform_note,
          checks: ic.checks,
        },
        version: await clientVersion(),
        login: loginState(),
        processes: await runningProcesses(),
        upstream: {
          port: upstreamPort,
          managed_port: discovery.MANAGED_PORT,
          is_managed: upstreamPort === discovery.MANAGED_PORT,
        },
        // 让界面能说明「只读」的边界
        readonly_note: '本页只读取客户端状态，不修改登录态或客户端文件',
      });
    },
  },
];

module.exports = { routes };
