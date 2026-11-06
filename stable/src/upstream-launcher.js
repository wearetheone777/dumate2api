// src/upstream-launcher.js
// Spawns dumate-main-server.exe directly, without the Electron GUI.
//
// The desktop app normally injects the login context over IPC. Run standalone,
// the binary refuses to boot unless that context arrives through env vars:
//   DUMATE_LOGIN_MODE        -> "standalone" is what triggers the env path
//   DUMATE_LOGIN_USER_ID     -> bceUserId from %APPDATA%\qianfan-desktop-app\auth.json
//   DUMATE_LOGIN_USER_NAME   -> displayName (cosmetic)
//   DUMATE_LOGIN_BCE_ACCOUNT_ID
// Credentials themselves still come from the saved cookies/auth.json on disk;
// if they expire you must re-login through the real DuMate app once.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const DEFAULT_INSTALL = 'D:\\Program Files\\code program\\baidudazi\\DuMate';

function installRoot() {
  return process.env.DUMATE_INSTALL_DIR || DEFAULT_INSTALL;
}

function exePath() {
  return path.join(installRoot(), 'resources', 'extra-resource', 'backend', 'bin', 'dumate-main-server.exe');
}

function configPath() {
  return path.join(installRoot(), 'resources', 'config', 'desktop-main', 'config.yml');
}

// Read the active BCE profile out of auth.json (Electron stores it here).
function activeProfile() {
  const file = path.join(process.env.APPDATA || '', 'qianfan-desktop-app', 'auth.json');
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
  const profiles = j.accountProfiles || [];
  if (!profiles.length) return null;
  const active = profiles.find((p) => p.profileId && p.profileId === j.activeProfileId);
  // Prefer the active profile; fall back to the most recently used one.
  const chosen = active || profiles.slice().sort((a, b) => (b.lastLogin || 0) - (a.lastLogin || 0))[0];
  const id = chosen.bceUserId || chosen.bceAccountId;
  if (!id) return null;
  return { userId: id, accountId: chosen.bceAccountId || id, name: chosen.displayName || '' };
}

function waitForPort(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const s = net.connect({ host, port });
      let done = false;
      const ok = () => { if (!done) { done = true; s.destroy(); resolve(true); } };
      s.once('connect', ok);
      s.once('error', () => {
        if (done) return;
        done = true;
        s.destroy();
        if (Date.now() >= deadline) reject(new Error('timeout waiting for upstream on port ' + port));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

// 无条件 spawn 一个新 backend 并把端口钉死在 -port（2026-11-06 验证记录）：
// GUI 客户端拉起的 backend 端口是**随机的**（electron.log 实测 52721/52806，
// 社区项目 Alphaxiaoteng/dumate2api 的「重启端口随机变化」结论只对 GUI 链路
// 成立）；config.yml 的 port 字段被注释，唯一可靠端口来源就是这个 CLI 参数。
// 所以本链路不存在端口漂移，也不探测已运行实例（含注释与实现曾不符的修正）。
async function ensureUpstreamProcess(port) {
  const exe = exePath();
  if (!fs.existsSync(exe)) {
    throw new Error('dumate-main-server.exe not found at ' + exe + ' (set DUMATE_INSTALL_DIR)');
  }
  const cfg = configPath();
  const profile = activeProfile();
  if (!profile) {
    throw new Error('No logged-in DuMate account found in auth.json. Log in via the DuMate app once.');
  }

  const env = { ...process.env };
  env.DUMATE_LOGIN_MODE = 'standalone';
  env.DUMATE_LOGIN_USER_ID = profile.userId;
  env.DUMATE_LOGIN_USER_NAME = profile.name;
  env.DUMATE_LOGIN_BCE_ACCOUNT_ID = profile.accountId;

  const args = ['-port', String(port)];
  if (fs.existsSync(cfg)) args.unshift('-c', cfg);
  if (process.env.DUMATE_UPSTREAM_LOG === '1') args.push('-log-stdout', '-log-level', 'info');

  const child = spawn(exe, args, {
    env,
    cwd: process.env.DUMATE_UPSTREAM_CWD || installRoot(),
    stdio: 'ignore',
    detached: false,
    windowsHide: true,
  });
  child.on('error', () => {});
  return { pid: child.pid, port, profile };
}

module.exports = { ensureUpstreamProcess, waitForPort, activeProfile, exePath, configPath, installRoot };