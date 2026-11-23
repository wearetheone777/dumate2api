// WSL → Windows 宿主浏览器桥接的纯函数单测（离线，不启动任何浏览器）
//
// 背景：WSL 里通常没有 Linux 浏览器，但 Windows 宿主有 Edge。原来的登录器
// 只认 Linux 路径 + playwright 缓存，于是 WSL 用户只能手动粘 cookie。
// 现在通过「PowerShell 拉起 Edge + CDP 连接」实现自动登录。
//
// 这里锁住的是**纯函数语义**（路径换算、探测顺序、WSL 判定），
// 真正的 CDP 往返依赖真机，不在单测里做。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lb = require('../../src/login-browser');

test('isWsl：本机 /proc/version 判定与平台一致', () => {
  const v = (() => { try { return fs.readFileSync('/proc/version', 'utf8'); } catch (e) { return ''; } })();
  const expect = process.platform === 'linux' && /microsoft/i.test(v);
  assert.equal(lb.isWsl(), expect);
});

test('toWindowsPath：/mnt/c 前缀换算成 C:\\（wslpath 缺失时的回退逻辑也要对）', () => {
  // 有 wslpath 时走系统命令；没有时走正则回退。两者结果都应是 Windows 路径。
  const out = lb.toWindowsPath('/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe');
  assert.match(out, /^C:\\/, `应换算为 C:\\ 开头，实际: ${out}`);
  assert.ok(!out.includes('/mnt/'), `不应残留 /mnt/，实际: ${out}`);
});

test('toWindowsPath：小写盘符也要大写（d: → D:）', () => {
  const out = lb.toWindowsPath('/mnt/d/some/dir/file.exe');
  assert.match(out, /^D:\\/i);
});

test('windowsBrowserPath：DUMATE_BROWSER_PATH 优先于内置候选', () => {
  const tmp = path.join(os.tmpdir(), `fake-browser-${process.pid}.exe`);
  fs.writeFileSync(tmp, '');
  const saved = process.env.DUMATE_BROWSER_PATH;
  process.env.DUMATE_BROWSER_PATH = tmp;
  try {
    assert.equal(lb.windowsBrowserPath(), tmp);
  } finally {
    if (saved === undefined) delete process.env.DUMATE_BROWSER_PATH;
    else process.env.DUMATE_BROWSER_PATH = saved;
    fs.rmSync(tmp, { force: true });
  }
});

test('windowsBrowserPath：候选不存在时返回 null（不抛错）', () => {
  const saved = process.env.DUMATE_BROWSER_PATH;
  process.env.DUMATE_BROWSER_PATH = '/definitely/not/here.exe';
  try {
    const got = lb.windowsBrowserPath();
    // WSL 本机若真装了 /mnt/c 下的 Edge 会返回它；否则 null。两者都合法，
    // 唯一不允许的是抛异常或返回空串。
    assert.ok(got === null || (typeof got === 'string' && got.length > 0));
  } finally {
    if (saved === undefined) delete process.env.DUMATE_BROWSER_PATH;
    else process.env.DUMATE_BROWSER_PATH = saved;
  }
});

test('hasDisplay：WSL 且有 Windows 浏览器时视为有界面', () => {
  if (!lb.isWsl()) return; // 非 WSL 环境跳过
  const win = lb.windowsBrowserPath();
  if (!win) return;         // 没有 Windows 浏览器时跳过
  assert.equal(lb.hasDisplay(), true);
});

test('findBrowser：WSL 下能返回 Windows 浏览器路径而不是 null', () => {
  if (!lb.isWsl()) return;
  const win = lb.windowsBrowserPath();
  if (!win) return;
  const found = lb.findBrowser();
  assert.ok(found, 'findBrowser 不应返回 null');
});
