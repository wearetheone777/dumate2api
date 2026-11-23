// src/login-browser.js - 浏览器登录器（弹出独立窗口，登录后自动抓 cookie）
//
// 为什么需要它：百度搭子的登录态载体是浏览器 cookie，而且产品上没有面向
// 第三方程序的登录票据接口（实测过 qianfanproxy 下只有秒哒的 login_ticket，
// 且它校验跳转目标必须是 miaoda.cn）。读系统浏览器（Edge/Chrome）的 cookie
// 库也不行——运行中独占文件锁，且新版 Chromium 用 App-Bound Encryption。
//
// 所以让程序自己开一个受控的浏览器窗口：用户在里面登录，我们从**自己这个
// 窗口**读 cookie。这是唯一不依赖外部状态、也不碰用户浏览器数据的做法。
//
// 复用系统已装的 Edge/Chrome（playwright-core 不下载 Chromium），
// 因此只多了约 14MB 依赖而不是 130MB+。
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const LOGIN_URL = 'https://login.bce.baidu.com/?redirect=' +
  encodeURIComponent('https://console.bce.baidu.com/');
const TARGET_HOST = 'console.bce.baidu.com';

// 登录后必须真正落到 console 域一次：bce-long-term-sessionid 这类会话
// cookie 是访问该域时由服务端种下的，只登录 passport 不会产生它，
// 而调 /api/dumate/* 恰恰依赖它（实测缺它一律 401）。
const SETTLE_URLS = [
  'https://console.bce.baidu.com/',
  'https://console.bce.baidu.com/ai/#/app/dumate/overview',
];

// 常见安装位置。优先 Edge（Windows 自带），再 Chrome；三平台都列，
// 因为本项目虽然主要在 Windows 跑，但管理端可以部署在 macOS / Linux 上。
const CANDIDATES = [
  // Windows
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  // Linux（发行版路径）
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

/**
 * playwright 自带的 Chromium（`~/.cache/ms-playwright/chromium-<版本>/…`）。
 *
 * 为什么需要：本机可能没装系统浏览器，但 `node_modules/playwright-core`
 * 的浏览器缓存可能已经存在（跑过 `npx playwright install chromium`，
 * 或管理端的截图/测试用过）。这种环境下「浏览器登录」是可以工作的，
 * 不该因为找不到系统 Chrome 就判定不可用。
 *
 * **版本目录名会变（chromium-1255），不能写死**——按前缀找最新的一个。
 * 平台子目录也不同：chrome-linux / chrome-linux64 / chrome-linux-arm64 /
 * chrome-mac / chrome-win，所以逐层探测而不是拼固定路径。
 */
function playwrightChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(require('os').homedir(), '.cache', 'ms-playwright'),
    path.join(require('os').homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter(Boolean);
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root).filter((n) => n.startsWith('chromium-')).sort().reverse();
    } catch (e) { continue; }
    for (const d of dirs) {
      const base = path.join(root, d);
      let sub = [];
      try { sub = fs.readdirSync(base); } catch (e) { continue; }
      for (const rel of sub) {
        const exe = path.join(base, rel, 'chrome');
        if (fs.existsSync(exe)) return exe;
        // macOS 的包结构是 Chromium.app/Contents/MacOS/Chromium
        const macExe = path.join(base, rel, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
        if (fs.existsSync(macExe)) return macExe;
        const winExe = path.join(base, rel, 'chrome.exe');
        if (fs.existsSync(winExe)) return winExe;
      }
    }
  }
  return null;
}

/** 服务端有没有图形界面——无头环境里「打开一个窗口」本质上做不到 */
function hasDisplay() {
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  // WSL：窗口由 Windows 宿主弹出，不依赖 WSL 自己的 DISPLAY
  if (isWsl() && windowsBrowserPath()) return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

// ---------------------------------------------------------------------------
// WSL → Windows 宿主浏览器（2026-11）
//
// WSL 里通常没有 Linux 浏览器，但 Windows 宿主一定装了 Edge。WSL2 的
// localhost 转发让「WSL 访问 Windows 监听端口」成为可能（实测 127.0.0.1 可达），
// 于是可以：用 PowerShell 在 Windows 侧拉起 Edge（独立 profile + 远程调试端口），
// 再用 playwright 的 connectOverCDP 连上去读 cookie。
//
// 为什么不用 playwright 直接 executablePath 指向 msedge.exe：playwright 通过
// stdio 管道控制浏览器进程，跨 WSL/Windows 边界这条管道不通（会超时）。CDP 走
// TCP，能跨边界。
//
// 全程零安装、零 sudo：只用宿主已有的 Edge + WSL 的 Windows 互通。
// ---------------------------------------------------------------------------

/** 是否运行在 WSL 里（内核版本带 microsoft 标记） */
function isWsl() {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch (e) { return false; }
}

/** Windows 宿主上的 Edge / Chrome 可执行文件（WSL 视角的 /mnt/c 路径） */
function windowsBrowserPath() {
  const cands = [
    '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  if (process.env.DUMATE_BROWSER_PATH && fs.existsSync(process.env.DUMATE_BROWSER_PATH)) {
    return process.env.DUMATE_BROWSER_PATH;
  }
  for (const p of cands) if (fs.existsSync(p)) return p;
  return null;
}

/** WSL 路径 → Windows 路径（C:\...），失败时回退到手工换算 */
function toWindowsPath(p) {
  try {
    const out = require('child_process').execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim();
    if (out) return out;
  } catch (e) { /* 回退 */ }
  return p.replace(/^\/mnt\/([a-z])\//i, (m, d) => `${d.toUpperCase()}:\\`).replace(/\//g, '\\');
}

/** 端口是否已经在 Windows 侧监听（CDP 的 /json/version 能回话即算就绪） */
function waitCdpReady(port, timeoutMs) {
  const http = require('http');
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 300);
      });
      req.on('timeout', () => { req.destroy(); });
    };
    tick();
  });
}

/** 在 Windows 侧拉起 Edge，返回 Windows PID；失败返回 { error } */
function launchWindowsBrowser(port) {
  const exe = windowsBrowserPath();
  if (!exe) return { error: 'Windows 侧没找到 Edge / Chrome' };
  const winExe = toWindowsPath(exe);
  // user-data-dir 在 PowerShell 侧用 Join-Path 拼（**不能写 %TEMP%**：
  // 单引号字符串里 PowerShell 不展开环境变量，Edge 会拿到字面量 %TEMP% 路径）
  const profileLeaf = `dumate-login-${process.pid}-${Date.now()}`;
  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
  ];
  // 单引号包路径，避免空格与反斜杠转义问题
  const ps = [
    `$ud = Join-Path $env:TEMP '${profileLeaf}'`,
    `$p = Start-Process -FilePath '${winExe}' -ArgumentList ${[
      `"--user-data-dir=$ud"`,
      ...args.map((a) => `'${a}'`),
    ].join(',')} -PassThru`,
    'Write-Output $p.Id',
  ].join('; ');
  try {
    const out = require('child_process').execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 20000 },
    ).trim();
    const pid = parseInt(out.split(/\r?\n/).pop(), 10);
    return Number.isFinite(pid) ? { pid } : { error: `无法取得 Edge PID（输出: ${out.slice(0, 120)}）` };
  } catch (e) {
    return { error: `启动 Windows 浏览器失败: ${e.message}` };
  }
}

/** 杀掉 Windows 侧进程树（不杀用户的日常 Edge：我们用的是独立 profile 的独立进程） */
function killWindowsBrowser(pid) {
  if (!pid) return;
  try {
    require('child_process').execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`],
      { timeout: 10000 });
  } catch (e) { /* 尽力而为 */ }
}

function findBrowser() {
  const envPath = process.env.DUMATE_BROWSER_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  for (const p of CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  // WSL 兜底：宿主上的 Edge/Chrome（通过 CDP 驱动，见 start()）
  if (isWsl()) {
    const win = windowsBrowserPath();
    if (win) return win;
  }
  return playwrightChromium();
}

// 会话状态。同一时刻只允许一个登录流程——多个窗口同时登录会互相覆盖
// cookie，最后存下来的账号归属不明。
let session = {
  active: false,
  started_at: null,
  status: 'idle',   // idle | waiting | success | failed | cancelled
  message: '',
  cookie: null,
  profile: null,
  browserPath: null,
};

let ctx = null;
let pollTimer = null;
let profileDir = null;

// 每次登录用全新的临时 profile。
// 不能复用固定目录：里面会残留上次的登录态，导致再次点「添加账号」时窗口
// 一打开就已登录、程序立刻判定成功并关窗，用户根本没机会操作；想换账号时
// 也会被旧 cookie 覆盖。
function newProfileDir() {
  const base = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
  const dir = path.join(base, 'browser-profile', `run-${Date.now()}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function removeProfileDir(dir) {
  if (!dir) return;
  // 浏览器刚退出时文件可能还被占用，删不掉不影响下次（会用新目录），
  // 但留着会一直堆垃圾，所以延迟重试一次
  const attempt = (n) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if (n > 0) setTimeout(() => attempt(n - 1), 1500);
    }
  };
  attempt(1);
}

function snapshot() {
  return {
    active: session.active,
    status: session.status,
    message: session.message,
    started_at: session.started_at,
    // cookie 不通过接口回显，只在成功后由调用方取用
    has_cookie: !!session.cookie,
    profile: session.profile,
    browser_path: session.browserPath,
    login_url: LOGIN_URL,
  };
}

function cleanup() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  const c = ctx;
  ctx = null;
  const dir = profileDir;
  profileDir = null;
  // WSL 分支：浏览器是 Windows 侧独立进程，CDP 断开不会杀它，需显式收尾
  const wp = session.winPid;
  session.winPid = 0;
  if (wp) killWindowsBrowser(wp);
  if (c) {
    c.close()
      .catch(() => {})
      .then(() => removeProfileDir(dir));
  } else {
    removeProfileDir(dir);
  }
  session.active = false;
}

// 判断 cookie 是否已具备登录态。光有 BDUSS 不够：调 /api/dumate/* 需要的是
// console 域的会话（bce-long-term-sessionid），它只在访问过该域之后才存在。
// 两者都齐了才算登录完成。
function extractAuthCookie(cookies) {
  const pick = (name) => {
    let best = null;
    for (const c of cookies) {
      if (c.name !== name || !c.value) continue;
      // 同名 cookie 取域更具体的那个
      if (!best || (c.domain || '').length > (best.domain || '').length) best = c;
    }
    return best;
  };

  if (!pick('BDUSS')) return null;
  // 缺会话 cookie 时返回 null，让轮询继续等——此时页面多半还在跳转中
  if (!pick('bce-long-term-sessionid')) return null;

  const byName = new Map();
  for (const c of cookies) {
    if (!c.value) continue;
    const prev = byName.get(c.name);
    if (!prev || (c.domain || '').length > (prev.domain || '').length) byName.set(c.name, c);
  }
  return [...byName.values()].map((c) => `${c.name}=${c.value}`).join('; ');
}

async function start(opts = {}) {
  if (session.active) {
    return { ok: false, error: '已有登录流程进行中，请先完成或取消' };
  }

  // 无图形界面时「打开一个窗口让人登录」根本做不到，提前说清楚——
  // 否则用户会看到 playwright 抛的 X server 错误，或者对着点不动的按钮。
  if (!hasDisplay()) {
    return {
      ok: false,
      error: '服务端没有图形界面（无 DISPLAY），浏览器登录用不了。请改用「手动粘贴」：'
        + '在你自己的浏览器里登录 dumate.cn，从开发者工具复制 Cookie 整行',
      browser_available: false,
    };
  }
  const exe = findBrowser();
  if (!exe) {
    return {
      ok: false,
      error: '未找到可用的浏览器（Edge / Chrome / Chromium / playwright 自带 chromium 都没找到）。'
        + '可设置 DUMATE_BROWSER_PATH 指定可执行文件路径，或改用「手动粘贴」',
      browser_available: false,
    };
  }

  session = {
    active: true,
    started_at: Date.now(),
    status: 'waiting',
    message: '已打开登录窗口，请在其中完成登录',
    cookie: null,
    profile: opts.name || '',
    browserPath: exe,
  };

  // WSL + 宿主浏览器：走 CDP 桥接（见文件中部注释），与下面的本地启动互斥
  if (isWsl() && /^\/mnt\/[a-z]\//i.test(exe)) {
    return startViaWindowsBrowser(exe);
  }

  try {
    // 每次一个全新 profile：隔离登录态，也避免读到上次的残留
    const userDataDir = newProfileDir();
    profileDir = userDataDir;

    ctx = await chromium.launchPersistentContext(userDataDir, {
      executablePath: exe,
      headless: false,
      // 不用固定 viewport，跟随窗口大小，避免页面被压成移动端布局
      viewport: null,
      args: ['--start-maximized', '--no-first-run', '--no-default-browser-check'],
    });

    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 窗口被用户手动关掉时收尾，否则会一直显示「等待登录」
    ctx.on('close', () => {
      if (session.status === 'waiting') {
        session.status = 'cancelled';
        session.message = '登录窗口已关闭';
      }
      session.active = false;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    });

    // 轮询 cookie：登录成功后百度会写入 BDUSS，随后需要落到 console 域
    // 才能拿到会话 cookie。检测到 BDUSS 但还没有会话时，主动导航一次。
    let navigatedToSettle = false;
    pollTimer = setInterval(async () => {
      if (!ctx) return;
      try {
        const cookies = await ctx.cookies();
        const ck = extractAuthCookie(cookies);
        if (ck) {
          session.cookie = ck;
          session.status = 'success';
          session.message = '登录成功，已获取凭证';
          cleanup();
          return;
        }
        // 有 BDUSS 说明已登录，但缺 console 会话：主动访问一次把它种下来
        const hasBduss = cookies.some((c) => c.name === 'BDUSS' && c.value);
        if (hasBduss && !navigatedToSettle) {
          navigatedToSettle = true;
          session.message = '已登录，正在建立控制台会话…';
          const pages = ctx.pages();
          const p = pages[pages.length - 1];
          if (p) {
            for (const u of SETTLE_URLS) {
              try { await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) { /* 继续试下一个 */ }
            }
          }
        }
      } catch (e) {
        // 上下文已关闭，交给 close 事件处理
      }
    }, 1500);
    if (pollTimer.unref) pollTimer.unref();

    return { ok: true, ...snapshot() };
  } catch (e) {
    session.status = 'failed';
    session.message = e.message;
    session.active = false;
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
    return { ok: false, error: e.message };
  }
}

// WSL 专用：在 Windows 宿主拉起 Edge（独立 profile），通过 CDP 连上读 cookie。
// 与本地 start() 的区别只在「浏览器怎么起来」——轮询/收尾语义完全一致。
async function startViaWindowsBrowser(exe) {
  const port = parseInt(process.env.DUMATE_WSL_CDP_PORT || '9333', 10);
  let winPid = 0;
  try {
    // 端口若被上一轮残留占着，先让用户知道（不盲目复用别人的调试端口）
    if (await waitCdpReady(port, 300)) {
      session.status = 'failed';
      session.active = false;
      session.message = `调试端口 ${port} 已被占用（可能是上次残留的窗口）`;
      return { ok: false, error: session.message };
    }

    session.message = '正在 Windows 上打开登录窗口…';
    const launched = launchWindowsBrowser(port);
    if (launched.error) {
      session.status = 'failed';
      session.active = false;
      session.message = launched.error;
      return { ok: false, error: launched.error };
    }
    winPid = launched.pid;
    session.winPid = winPid;

    // 等 CDP 端点就绪（Edge 启动 + 调试端口监听约 1~3 秒）
    const ready = await waitCdpReady(port, 20000);
    if (!ready) {
      throw new Error(`Windows 浏览器未在 20 秒内开放调试端口 ${port}。`
        + '若 Edge 已开但端口不通，可能是 WSL localhost 转发被关闭（.wslconfig 的 localhostForwarding）');
    }

    ctx = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    session.message = '已打开登录窗口，请在其中完成登录';

    // connectOverCDP 拿到的是既有上下文（含启动时的空白页）
    const contexts = ctx.contexts();
    const bctx = contexts[0] || null;
    if (!bctx) throw new Error('CDP 连接成功但没有可用的浏览器上下文');

    // 用第一个页面导航到登录页；没有就新建
    const pages = bctx.pages();
    const page = pages[0] || (await bctx.newPage());
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

    ctx.on('close', () => {
      if (session.status === 'waiting') {
        session.status = 'cancelled';
        session.message = '登录窗口已关闭';
      }
      session.active = false;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    });

    let navigatedToSettle = false;
    pollTimer = setInterval(async () => {
      if (!ctx) return;
      try {
        // 读全部上下文的 cookie（BDUSS 在 .baidu.com，会话 cookie 在 console 域）
        const cookies = await bctx.cookies();
        const ck = extractAuthCookie(cookies);
        if (ck) {
          session.cookie = ck;
          session.status = 'success';
          session.message = '登录成功，已获取凭证';
          cleanup();
          return;
        }
        const hasBduss = cookies.some((c) => c.name === 'BDUSS' && c.value);
        if (hasBduss && !navigatedToSettle) {
          navigatedToSettle = true;
          session.message = '已登录，正在建立控制台会话…';
          const ps = bctx.pages();
          const p = ps[ps.length - 1];
          if (p) {
            for (const u of SETTLE_URLS) {
              try { await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) { /* 下一个 */ }
            }
          }
        }
      } catch (e) { /* 上下文已关闭，交给 close 事件 */ }
    }, 1500);
    if (pollTimer.unref) pollTimer.unref();

    return { ok: true, ...snapshot() };
  } catch (e) {
    session.status = 'failed';
    session.message = e.message;
    session.active = false;
    if (ctx) { try { await ctx.close(); } catch (x) { /* ignore */ } ctx = null; }
    if (winPid) { killWindowsBrowser(winPid); session.winPid = 0; }
    return { ok: false, error: e.message };
  }
}

// 取走成功的 cookie。取走即清空——同一份凭证不应被重复入库两次。
function takeCookie() {
  const c = session.cookie;
  session.cookie = null;
  return c;
}

function cancel() {
  if (!session.active && !ctx) return { ok: true };
  session.status = 'cancelled';
  session.message = '已取消';
  cleanup();
  return { ok: true };
}

module.exports = {
  start, cancel, snapshot, takeCookie, findBrowser, hasDisplay, LOGIN_URL, extractAuthCookie,
  // 测试/排障用
  isWsl, windowsBrowserPath, toWindowsPath,
};
