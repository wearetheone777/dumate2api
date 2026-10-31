#!/usr/bin/env node
// test/verify-admin-multiuser.js - 多账户 + 强制鉴权端到端验证（2026-11-01）
//
// 起一对**临时**实例（网关 19092 + 管理端 19093，共享一个临时 data 目录，
// 与真实 9080/9082/9083 完全隔离），跑完整矩阵：
//   A. 网关强制鉴权：无 key 401；DUMATE_REQUIRE_KEY=0 也关不掉；/health 豁免
//   B. 多账户：admin/viewer 角色、plain 只给 admin、viewer 写操作 403、
//      用户 CRUD 的保护边界（删自己 / 最后一个 admin / 改密踢会话）
//   C. 强制鉴权下的 key 生命周期：管理端建的 key 网关立刻认
//
// 断言全部走 HTTP，不 mock；跑完清理临时目录与进程。
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-verify-multiuser-'));
const ADMIN_PORT = 19093;
const GW_PORT = 19092;
const ADMIN_PWD = 'admin-test-123';
const VIEWER_PWD = 'viewer-test-123';

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

function req(method, port, p, { body, cookie } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        host: '127.0.0.1', port, path: p, method,
        headers: {
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
          ...(cookie ? { cookie } : {}),
        },
        timeout: 8000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (e) { /* 非 JSON 响应保留 null */ }
          resolve({ status: res.statusCode, json, raw, headers: res.headers });
        });
      },
    );
    r.on('error', (e) => resolve({ status: 0, json: null, raw: String(e), headers: {} }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: 'timeout', headers: {} }); });
    if (data) r.write(data);
    r.end();
  });
}

function waitPort(port, tries = 60) {
  return new Promise((resolveWait) => {
    const tick = async (n) => {
      const r = await req('GET', port, '/health');
      if (r.status === 200) return resolveWait(true);
      if (n <= 0) return resolveWait(false);
      setTimeout(() => tick(n - 1), 500);
    };
    tick(tries);
  });
}

function waitSilent(proc, ms = 1500) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const gwEnv = {
    ...process.env,
    DUMATE2API_PORT: String(GW_PORT),
    DUMATE2API_HOST: '127.0.0.1',
    DUMATE_ADMIN_DATA: TMP,
    // 故意设 0：强制鉴权不能被环境变量关掉（用户要求「去掉不鉴权」）
    DUMATE_REQUIRE_KEY: '0',
    DUMATE_QWENWORK_AUTOSTART: 'off',
    DUMATE_TRAEWORK_AUTOSTART: 'off',
    DUMATE_AUTOSTART: 'off',
    DUMATE_LAG_MONITOR: '0',
  };
  const adminEnv = {
    ...process.env,
    DUMATE_ADMIN_PORT: String(ADMIN_PORT),
    DUMATE_ADMIN_HOST: '127.0.0.1',
    DUMATE_ADMIN_DATA: TMP,
    DUMATE_ADMIN_GATEWAY_PORT: String(GW_PORT),
  };

  console.log('启动临时实例（data=%s）', TMP);
  const gw = spawn(process.execPath, ['src/server.js', '--reset-admin', `--password=${ADMIN_PWD}`], { env: gwEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const admin = spawn(process.execPath, ['src/admin/server.js', '--reset-admin', `--password=${ADMIN_PWD}`], { env: adminEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  gw.stdout.on('data', () => {});
  admin.stdout.on('data', () => {});

  try {
    const gwUp = await waitPort(GW_PORT);
    const adminUp = await waitPort(ADMIN_PORT);
    ok(gwUp, '临时网关 19092 启动');
    ok(adminUp, '临时管理端 19093 启动');
    if (!gwUp || !adminUp) return;

    // ---------- A. 网关强制鉴权 ----------
    console.log('\n[A] 网关强制鉴权（DUMATE_REQUIRE_KEY=0 也关不掉）');
    const h = await req('GET', GW_PORT, '/health');
    ok(h.status === 200 && h.json && h.json.require_key === true, '/health 豁免且 require_key=true');
    const m0 = await req('GET', GW_PORT, '/v1/models');
    ok(m0.status === 401, '无 key 打 /v1/models → 401（强制）');
    const c0 = await req('POST', GW_PORT, '/v1/messages', { body: { model: 'x', messages: [] } });
    ok(c0.status === 401, '无 key 打 /v1/messages → 401（强制）');

    // ---------- B1. admin 登录与 key 生命周期 ----------
    console.log('\n[B1] admin 登录 + key 创建（plain 只在 admin 响应里）');
    const lg = await req('POST', ADMIN_PORT, '/api/admin/auth/login', { body: { username: 'admin', password: ADMIN_PWD } });
    ok(lg.status === 200 && lg.json.username === 'admin', 'admin 登录');
    const adminCookie = (lg.headers['set-cookie'] || [])[0];

    const mk = await req('POST', ADMIN_PORT, '/api/admin/keys', {
      cookie: adminCookie,
      body: { name: 'verify-qoder', channel: 'qoder', region: 'cn' },
    });
    ok(mk.status === 200 && mk.json.token && mk.json.token.startsWith('dmk_'), 'admin 创建 qoder key（返回明文一次）');
    const verifyKey = mk.json.token;

    const kl = await req('GET', ADMIN_PORT, '/api/admin/keys', { cookie: adminCookie });
    const adminRow = (kl.json.keys || []).find((k) => k.name === 'verify-qoder');
    ok(adminRow && adminRow.plain === verifyKey, 'admin 的列表带完整 plain');
    ok(kl.json.require_key === true, '管理端探测到网关强制鉴权');

    const mv = await req('GET', GW_PORT, '/v1/models', { cookie: undefined, headers: {} });
    // 用 Bearer 头重发
    const mv2 = await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: GW_PORT, path: '/v1/models', headers: { authorization: `Bearer ${verifyKey}` } }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode, raw }));
      });
      r.on('error', () => resolve({ status: 0, raw: '' })); r.end();
    });
    const qoderOnly = mv2.status === 200 && JSON.parse(mv2.raw).data.every((x) => String(x.id).startsWith('qoder/'));
    ok(mv2.status === 200 && qoderOnly, '网关带新 key /v1/models → 200 且只见 qoder 通道模型');

    // ---------- B2. viewer 生命周期与权限矩阵 ----------
    console.log('\n[B2] viewer 创建与权限矩阵');
    const cv = await req('POST', ADMIN_PORT, '/api/admin/auth/users', {
      cookie: adminCookie,
      body: { username: 'ops-01', password: VIEWER_PWD, role: 'viewer' },
    });
    ok(cv.status === 200 && cv.json.role === 'viewer', 'admin 创建 viewer 用户');
    const dup = await req('POST', ADMIN_PORT, '/api/admin/auth/users', {
      cookie: adminCookie, body: { username: 'ops-01', password: VIEWER_PWD, role: 'viewer' },
    });
    ok(dup.status === 400, '重名用户被拒');
    const bad = await req('POST', ADMIN_PORT, '/api/admin/auth/users', {
      cookie: adminCookie, body: { username: 'ops-02', password: 'short', role: 'viewer' },
    });
    ok(bad.status === 400, '弱密码被拒');

    const lv = await req('POST', ADMIN_PORT, '/api/admin/auth/login', { body: { username: 'ops-01', password: VIEWER_PWD } });
    ok(lv.status === 200 && lv.json.role === 'viewer', 'viewer 登录');
    const viewerCookie = (lv.headers['set-cookie'] || [])[0];

    const vl = await req('GET', ADMIN_PORT, '/api/admin/keys', { cookie: viewerCookie });
    ok(vl.status === 200, 'viewer 可读 key 列表（只读职责）');
    ok((vl.json.keys || []).every((k) => k.plain === null), 'viewer 的列表 plain 全为 null（服务端过滤）');
    ok(vl.json.keys.some((k) => k.name === 'verify-qoder'), 'viewer 能看到 key 的名称/前缀/用量');

    const vme = await req('GET', ADMIN_PORT, '/api/admin/auth/me', { cookie: viewerCookie });
    ok(vme.status === 200 && vme.json.role === 'viewer', 'viewer 的 /auth/me 正常');

    const vw = await req('POST', ADMIN_PORT, '/api/admin/keys', {
      cookie: viewerCookie, body: { name: 'nope', channel: 'qoder' },
    });
    ok(vw.status === 403 && vw.json.error === 'admin_only', 'viewer 创建 key → 403 admin_only');
    const vd = await req('DELETE', ADMIN_PORT, `/api/admin/keys/${adminRow.id}`, { cookie: viewerCookie });
    ok(vd.status === 403, 'viewer 删除 key → 403');
    const vu = await req('GET', ADMIN_PORT, '/api/admin/auth/users', { cookie: viewerCookie });
    ok(vu.status === 403, 'viewer 读用户列表 → 403');
    const vrev = await req('POST', ADMIN_PORT, '/api/admin/auth/sessions/revoke', { cookie: viewerCookie });
    ok(vrev.status === 403, 'viewer 踢会话（写操作）→ 403');

    // ---------- B3. 账户管理的保护边界 ----------
    console.log('\n[B3] 账户管理保护边界');
    const delSelf = await req('DELETE', ADMIN_PORT, '/api/admin/auth/users/admin', { cookie: adminCookie });
    ok(delSelf.status === 400, 'admin 删自己 → 400');
    // 唯一 admin 自降 = 自锁（currentUser 读实况角色，会话立刻失去写权限），
    // 必须被拦——这是修过的真实缺陷，别再放宽
    const demoteSelf = await req('PATCH', ADMIN_PORT, '/api/admin/auth/users/admin', {
      cookie: adminCookie, body: { role: 'viewer' },
    });
    ok(demoteSelf.status === 400, '唯一 admin 自降为 viewer → 400（防自锁）');

    const demoteLast = await req('POST', ADMIN_PORT, '/api/admin/auth/users', {
      cookie: adminCookie, body: { username: 'tmp-admin', password: 'tmp-admin-123', role: 'admin' },
    });
    ok(demoteLast.status === 200, '创建第二个 admin');
    // 降级**另一个** admin（不是自己）：自己会话的实况角色保持 admin，后续恢复才可能
    const demoteTmp = await req('PATCH', ADMIN_PORT, '/api/admin/auth/users/tmp-admin', {
      cookie: adminCookie, body: { role: 'viewer' },
    });
    ok(demoteTmp.status === 200, '有两个 admin 时可以降级其中一个');
    const delTmp = await req('DELETE', ADMIN_PORT, '/api/admin/auth/users/tmp-admin', { cookie: adminCookie });
    ok(delTmp.status === 200, '降级后的账户可删除');

    const chpw = await req('PATCH', ADMIN_PORT, '/api/admin/auth/users/ops-01', {
      cookie: adminCookie, body: { password: 'new-viewer-pass-1' },
    });
    ok(chpw.status === 200, 'admin 改 viewer 密码');
    const oldSess = await req('GET', ADMIN_PORT, '/api/admin/auth/me', { cookie: viewerCookie });
    ok(oldSess.status === 401, '改密后 viewer 旧会话立即失效');
    const relog = await req('POST', ADMIN_PORT, '/api/admin/auth/login', { body: { username: 'ops-01', password: 'new-viewer-pass-1' } });
    ok(relog.status === 200, 'viewer 用新密码可登录');
    const newViewerCookie = (relog.headers['set-cookie'] || [])[0];

    const duser = await req('DELETE', ADMIN_PORT, '/api/admin/auth/users/ops-01', { cookie: adminCookie });
    ok(duser.status === 200, 'admin 删除 viewer');
    const gone = await req('GET', ADMIN_PORT, '/api/admin/auth/me', { cookie: newViewerCookie });
    ok(gone.status === 401, '被删账户的会话立即失效');

    // 未登录的写操作仍是 401（不是 403）
    const anon = await req('POST', ADMIN_PORT, '/api/admin/keys', { body: { name: 'x' } });
    ok(anon.status === 401, '未登录写操作 → 401');

    // ---------- 汇总 ----------
    console.log(`\n通过 ${passed} / ${passed + failed}`);
    if (failed) process.exitCode = 1;
  } finally {
    gw.kill();
    admin.kill();
    await waitSilent(null, 500);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* Windows 句柄延迟 */ }
  }
}

main().catch((e) => { console.error('verify failed:', e); process.exit(1); });
