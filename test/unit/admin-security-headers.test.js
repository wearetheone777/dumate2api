// test/unit/admin-security-headers.test.js - 管理端安全响应头（P2-21）
//
// 调研出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P2-21「管理端安全加固包」。
//
// **清单大部分此前已逐项落地**（登录退避+限流 audit P1-5、timingSafeEqual、
// HttpOnly+SameSite、请求体上限 body-limit、路径穿越防护、CORS fail-closed、
// 前端无 v-html）——本套件锁的是最后补的一块：**安全响应头**，外加「清单
// 其余各项真的存在」的接线自证（防被后人当冗余删掉）。
//
// CSP 的取舍写在 server.js 的 CSP_HTML 注释里（style-src 必须放开
// unsafe-inline：Vue 的 :style 绑定与 ECharts 内联样式都是 style 属性）。
// **本套件不含 CSP 收紧判据**——收緊要配合真实浏览器回归（页面裸奔是
// 静默失败），离线测不出来。
//
// 运行：node --test test/unit/admin-security-headers.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../src/admin/server.js'), 'utf8');

test('sendFile：HTML 带完整 CSP，静态资源至少带 nosniff/DENY/no-referrer', () => {
  assert.match(SRC, /applySecurityHeaders\(isEntry \? 'html' : 'static'\)/,
    'sendFile 要按扩展名分流（html 给 CSP）');
  // CSP 关键指令齐全
  assert.match(SRC, /default-src 'self'/);
  assert.match(SRC, /script-src 'self'/);
  assert.match(SRC, /style-src 'self' 'unsafe-inline'/);
  assert.match(SRC, /frame-ancestors 'none'/, '防点击劫持（等价 XFO: DENY）');
  assert.match(SRC, /object-src 'none'/);
  assert.match(SRC, /base-uri 'none'/);
  assert.match(SRC, /form-action 'self'/);
});

test('sendJSON：API 带 nosniff / X-Frame-Options / Referrer-Policy', () => {
  assert.match(SRC, /\.\.\.applySecurityHeaders\('json'\)/,
    'sendJSON 要并入最小安全头集');
});

test('三个头的值正确（nosniff / DENY / no-referrer）', () => {
  assert.match(SRC, /'X-Content-Type-Options': 'nosniff'/);
  assert.match(SRC, /'X-Frame-Options': 'DENY'/);
  assert.match(SRC, /'Referrer-Policy': 'no-referrer'/);
});

test('noindex：X-Robots-Tag 头 + index.html robots meta（P3，公网化前置）', () => {
  assert.match(SRC, /'X-Robots-Tag': 'noindex, nofollow'/, 'applySecurityHeaders 全 kind 都带 noindex');
  const html = fs.readFileSync(path.resolve(__dirname, '../../web/index.html'), 'utf8');
  assert.match(html, /<meta name="robots" content="noindex, nofollow"\s*\/?>/, '入口模板带 robots meta（覆盖静态托管不经 server.js 的场景）');
});

// ---- 清单其余各项的接线自证（防被当冗余删掉） ----

test('登录失败退避与限流存在（audit P1-5）', () => {
  const auth = fs.readFileSync(
    path.resolve(__dirname, '../../src/admin/routes/auth.js'), 'utf8');
  assert.match(auth, /loginThrottled\(ip\)/, 'IP 级窗口限流');
  assert.match(auth, /loginBlocked\(ip, username\)/, '账号级锁定');
  assert.match(auth, /retry_after/, '要告诉客户端多久后再来');
});

test('恒定时间比较存在（口令与会话两处）', () => {
  const authMod = fs.readFileSync(
    path.resolve(__dirname, '../../src/admin/auth.js'), 'utf8');
  const n = (authMod.match(/timingSafeEqual/g) || []).length;
  assert.ok(n >= 2, `verifyPwd 与 session 校验都要用 timingSafeEqual（实际 ${n} 处）`);
});

test('Cookie 是 HttpOnly + SameSite=Lax', () => {
  const auth = fs.readFileSync(
    path.resolve(__dirname, '../../src/admin/routes/auth.js'), 'utf8');
  assert.match(auth, /'HttpOnly'/);
  assert.match(auth, /'SameSite=Lax'/);
});

test('请求体上限存在（body-limit 接线）', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/server.js'), 'utf8');
  assert.match(src, /body-limit/, '网关要接线 body-limit（管理端的在 admin/server.js 经 cors/bodyLimit 各自接）');
});

test('静态服务有路径穿越防护（inside 判定）', () => {
  assert.match(SRC, /target\.startsWith\(DIST \+ path\.sep\)/,
    '越界路径必须回落 index.html');
});

test('前端无 v-html（Vue 默认 textContent 渲染——XSS 面干净）', () => {
  const dir = path.resolve(__dirname, '../../web/src');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(d, e.name);
    return e.isDirectory() ? walk(full) : (e.name.endsWith('.vue') ? [full] : []);
  });
  const offenders = walk(dir)
    .filter((f) => /v-html/.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(offenders, [], `发现 v-html：${offenders.join(', ')}`);
});
