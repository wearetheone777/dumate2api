// tools/ui-shot.js - 无依赖的前端视觉验证（Edge headless + CDP）
//
// **为什么要自己写**：CLAUDE.md 明确要求「改完前端别只看接口返回，要用真实浏览器
// 截图核对可见性」——本项目已经两次栽在「接口 200、界面无感」上（小尺寸 a-switch
// 不渲染 checked-children、缓存头让新构建不生效）。而浏览器扩展（bsk）不总是
// 可用，那时这条纪律就落空。
//
// 本工具只用 Node 内置模块与系统已装的 Edge：
//   1. 用 --remote-debugging-port 起 headless Edge
//   2. 走 CDP：Page.navigate → 等 load → 执行登录脚本 → Runtime.evaluate 取文本
//      → Page.captureScreenshot 存 PNG
//   3. 退出时杀掉 Edge（不留后台进程）
//
// 用法：
//   node tools/ui-shot.js --url http://127.0.0.1:9137/#/web-accounts \
//        --user admin --pass xxx --out out.png --wait 3000 \
//        --text "成长中心" --text "模型繁忙度"
//
// 退出码：0 = 全部断言通过；1 = 有断言失败（或启动失败）。
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
function args(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
      out.push(process.argv[i + 1]);
    }
  }
  return out;
}

const URL_ = String(arg('url', ''));
const USER = String(arg('user', 'admin'));
const PASS = String(arg('pass', ''));
const OUT = String(arg('out', ''));
const WAIT_MS = Number(arg('wait', 3000)) || 3000;
const TEXTS = args('text');
const DEVICE_W = Number(arg('width', 1600)) || 1600;
const DEVICE_H = Number(arg('height', 1000)) || 1000;
// 通道（localStorage 的 lab-channel）：不设就停在默认的「百度搭子」，
// 断言 WorkBuddy 页面的元素必然全失败——第一次跑就是这么失败的
const CHANNEL = arg('channel', '');
// 区域（lab-region）：WorkBuddy 有国内/国际两套账号视图
const REGION = arg('region', '');
// 点击操作：--click "文本" 会找第一个 innerText 完全匹配的可点元素并点击，
// 用于「点开某个按钮后才出现的内容」（如成长中心的「查询」）
const CLICKS = args('click');
const EDGE = arg('edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');

function httpJson(urlPath, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      let b = '';
      res.on('data', (x) => { b += x; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`非 JSON: ${b.slice(0, 200)}`)); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 极简 CDP 客户端（够用即可：发命令、等 id 匹配的回复） */
function makeCdp(ws) {
  let seq = 0;
  const waits = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id != null && waits.has(msg.id)) {
      const { resolve, reject } = waits.get(msg.id);
      waits.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  return {
    send(method, params = {}) {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        waits.set(id, { resolve, reject });
        setTimeout(() => { if (waits.has(id)) { waits.delete(id); reject(new Error(`CDP 超时: ${method}`)); } }, 30000);
      });
    },
    events,
  };
}

/** 用 Node 内置 WebSocket（Node 22+ 有全局 WebSocket） */
async function main() {
  if (!URL_) { console.error('缺 --url'); process.exit(1); }
  if (typeof WebSocket !== 'function') {
    console.error('需要 Node 22+（全局 WebSocket）。当前:', process.version);
    process.exit(1);
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shot-'));
  const port = 20000 + (process.pid % 20000);
  const child = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${DEVICE_W},${DEVICE_H}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  const cleanup = () => {
    try { child.kill(); } catch (e) { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 可能被占用 */ }
  };
  process.on('exit', cleanup);

  // 等 devtools 端口就绪
  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const list = await httpJson('/json/list', port);
      const page = (list || []).find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) { target = page; break; }
    } catch (e) { /* 还没起来 */ }
  }
  if (!target) { console.error('Edge 未就绪（devtools 端口无响应）'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = makeCdp(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: DEVICE_W, height: DEVICE_H, deviceScaleFactor: 1, mobile: false,
  });

  // ---- 1. 打开登录页并登录（如果给了密码）----
  const origin = URL_.replace(/#.*$/, '');
  const hash = (URL_.match(/#(\S*)$/) || [, ''])[1];

  if (PASS) {
    await cdp.send('Page.navigate', { url: origin + '#/login' });
    await sleep(2500);
    const loginJs = `
      (async () => {
        const body = JSON.stringify({ username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)} });
        const r = await fetch('/api/admin/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
          credentials: 'include',
        });
        return r.status;
      })()
    `;
    const lr = await cdp.send('Runtime.evaluate', { expression: loginJs, awaitPromise: true, returnByValue: true });
    const status = lr.result && lr.result.value;
    if (status !== 200) { console.error('登录失败 HTTP', status); process.exit(1); }
    console.log('登录 OK');
  }

  // ---- 2. 设置通道/区域（必须在导航到目标页之前：store 从 localStorage 读初始值）----
  if (CHANNEL || REGION) {
    // 先停在 origin（同源）才能写 localStorage
    await cdp.send('Page.navigate', { url: origin + '#/' });
    await sleep(1200);
    const setJs = `
      (() => {
        ${CHANNEL ? `localStorage.setItem('lab-channel', ${JSON.stringify(CHANNEL)});` : ''}
        ${REGION ? `localStorage.setItem('lab-region', ${JSON.stringify(REGION)});` : ''}
        return { channel: localStorage.getItem('lab-channel'), region: localStorage.getItem('lab-region') };
      })()
    `;
    const sr = await cdp.send('Runtime.evaluate', { expression: setJs, returnByValue: true });
    console.log('localStorage:', JSON.stringify(sr.result && sr.result.value));
  }

  // ---- 3. 导航到目标页（登录后 cookie 已在，直接 goto）----
  //
  // **必须带一个会变的 query**：SPA 的 store 在**首次文档加载**时把 localStorage
  // 读进 reactive 初始值，之后只改 hash 不会重新读——所以设完 channel 再 goto
  // 同一个 `/#/xxx` 是**没有任何效果**的（第一版就这样，截图字节数一模一样）。
  // 加一个无意义的 query 让它变成真正的文档加载。
  const bust = `?ui-shot=${Date.now()}`;
  await cdp.send('Page.navigate', { url: origin + bust + '#' + hash });
  await sleep(WAIT_MS);

  // ---- 3.5 按需点击（用于「点开后才出现」的内容）----
  for (const label of CLICKS) {
    const clickJs = `
      (() => {
        const want = ${JSON.stringify(label)};
        // 精确匹配 innerText（去首尾空白），避免点到父容器
        const all = Array.from(document.querySelectorAll('button, a, [role="button"], .ant-btn, .ant-tabs-tab'));
        const hit = all.find((e) => (e.innerText || '').trim() === want)
          || all.find((e) => (e.innerText || '').trim().includes(want));
        if (!hit) return { ok: false, reason: 'not found' };
        hit.click();
        return { ok: true, tag: hit.tagName, text: (hit.innerText || '').trim().slice(0, 40) };
      })()
    `;
    const cr = await cdp.send('Runtime.evaluate', { expression: clickJs, returnByValue: true });
    const v = cr.result && cr.result.value;
    console.log(`${v && v.ok ? 'ok  ' : 'FAIL'} 点击「${label}」${v && v.ok ? '' : '（未找到）'}`);
    await sleep(2500);
  }

  // ---- 4. 滚动到底，让懒渲染的下半页也出来 ----
  await cdp.send('Runtime.evaluate', {
    expression: `(() => { const m = document.querySelector('main') || document.body; m.scrollTop = m.scrollHeight; return m.scrollTop; })()`,
    returnByValue: true,
  });
  await sleep(1500);

  // ---- 4.1 可选：把某个容器单独截一张（--focus "文本"）----
  //
  // 为什么需要：整页截图里两列区块高度差很大时，视觉上会误看成「挤成一列」。
  // 第一次就误判了一次（实际情况是 flex:0 0 50% 两列并排，只是滚动后错位）。
  // 单独截容器能看清它自己的排版，也便于把某个卡片交给别人看。
  const FOCUS = arg('focus', '');
  if (FOCUS) {
    const box = await cdp.send('Runtime.evaluate', {
      expression: `
        (() => {
          const want = ${JSON.stringify(String(FOCUS))};
          const heads = Array.from(document.querySelectorAll('div'));
          const h = heads.find((d) => (d.textContent || '').trim().startsWith(want));
          if (!h) return null;
          const card = h.closest('.ant-card') || h.closest('.ant-col') || h;
          card.scrollIntoView({ block: 'start' });
          const r = card.getBoundingClientRect();
          return { x: Math.max(0, r.x), y: Math.max(0, r.y + window.scrollY), w: r.width, h: r.height };
        })()
      `,
      returnByValue: true,
    });
    const b = box.result && box.result.value;
    if (b && b.w > 0) {
      await sleep(600);
      const shot2 = await cdp.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true,
        clip: { x: b.x, y: b.y, width: Math.ceil(b.w), height: Math.ceil(Math.min(3000, b.h)), scale: 1 },
      });
      const focusOut = OUT.replace(/\.png$/, `-focus.png`);
      fs.writeFileSync(path.resolve(focusOut), Buffer.from(shot2.data, 'base64'));
      console.log(`聚焦截图: ${focusOut} (${Math.round(b.w)}x${Math.round(b.h)})`);
    } else {
      console.log(`FAIL 聚焦目标「${FOCUS}」未找到`);
    }
  }

  // ---- 3. 取可见文本 ----
  const txt = await cdp.send('Runtime.evaluate', {
    expression: `document.body.innerText`,
    returnByValue: true,
  });
  const bodyText = String(txt.result && txt.result.value || '');

  // ---- 4. 断言 ----
  let fail = 0;
  for (const t of TEXTS) {
    const hit = bodyText.includes(t);
    console.log(`${hit ? 'ok  ' : 'FAIL'} 页面可见「${t}」`);
    if (!hit) fail++;
  }

  // ---- 5. 截图 ----
  if (OUT) {
    // 整页截图（captureBeyondViewport 让下半页也进图）
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const h = Math.min(4000, Math.ceil((metrics.cssContentSize && metrics.cssContentSize.height) || DEVICE_H));
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: DEVICE_W, height: h, scale: 1 },
    });
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(OUT), Buffer.from(shot.data, 'base64'));
    console.log(`截图: ${OUT} (${DEVICE_W}x${h})`);
  }

  ws.close();
  cleanup();
  console.log(fail ? `\n${fail} 项断言失败` : '\n全部断言通过');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('ui-shot 出错:', e.message); process.exit(1); });
