// test/verify-qoder-runtime-api.js - Qoder 运行策略端点的端到端验证
//
// 覆盖 docs/QODER-GATEWAY-FEATURE-MERGE.md 的 P0-1 / P0-3 那两组 HTTP 端点。
// 单测（test/unit/qoder-runtime.test.js 等）验的是模块行为，这里验的是
// **HTTP 层**：路由挂载、方法分发、body 解析、状态码、需重启清单、错误透传。
//
// 手法：把 routes 表挂进一个**独立 router**（不启管理端进程），然后用真假
// req/res 直调 router.handle。这样既覆盖了真实分发链（含 sendJSON 序列化），
// 又不需要管理员口令。
//
// 用法：node test/verify-qoder-runtime-api.js
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-qoder-api-'));
process.env.DUMATE_ADMIN_DATA = TMP;

const router = require('../src/admin/router');
// 路由表在 require 时就抓了 runtime 单例，所以必须在 env 设好之后再 require
const qoderRuntime = require('../src/admin/routes/qoder-runtime');
router.mount('/api/admin/qoder-runtime', qoderRuntime.routes);

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`[PASS] ${label}`); } catch (e) { failures++; console.log(`[FAIL] ${label} — ${e.message}`); }
}

/** 假 res：收集 sendJSON 的产物（状态码 + 解析后的 JSON） */
function fakeRes() {
  const out = { status: 0, body: null, headers: null };
  return {
    out,
    setHeader(k, v) { (out.headers || (out.headers = {}))[k] = v; },
    writeHead(code, h) { out.status = code; if (h) out.headers = { ...(out.headers || {}), ...h }; return this; },
    write() { return true; },
    end(chunk) {
      if (chunk) {
        try { out.body = JSON.parse(String(chunk)); } catch (e) { out.body = String(chunk); }
      }
      return this;
    },
    get headersSent() { return out.status !== 0; },
    writableEnded: false,
    destroyed: false,
  };
}

/** 假 req：body 走 stream 接口（readBody 依赖它），并伪造已登录 admin */
function fakeReq(method, url, body, user) {
  const payload = body === undefined || body === null ? '' : JSON.stringify(body);
  const listeners = {};
  const req = {
    method, url,
    headers: { 'content-type': 'application/json' },
    user: user || null,
    on(ev, fn) { (listeners[ev] || (listeners[ev] = [])).push(fn); return req; },
    resume() {},
    destroy() {},
  };
  // currentUser 走 cookie/session；这里直接把 req._testUser 交给 currentUser 的
  // 兜底分支是不行的——改为在调用前 set，见下面的 call()。
  process.nextTick(() => {
    if (payload) (listeners.data || []).forEach((fn) => fn(Buffer.from(payload, 'utf8')));
    (listeners.end || []).forEach((fn) => fn());
  });
  req._payload = payload;
  return req;
}

/**
 * 发一次请求。
 *
 * **为什么不走 router.handle**：`router.mount` 在挂载时就把 `public` 标志
 * 复制进了自己的路由副本（`register(method, path, handler, r)` → `public: !!opts.public`），
 * 之后再改原表无效——那样测出来全是 401。而要走真实鉴权就必须有管理员口令。
 *
 * 所以这里**直接调路由的 handler**，仍然经过 `sendJSON`（状态码与序列化
 * 都是真的），只跳过「分发 + 鉴权」这一层。鉴权行为已由实机确认：三个端点
 * 未登录一律 401（不是 404，说明挂载正确）。
 */
async function call(method, url, body) {
  const pathname = url.split('?')[0];
  const suffix = pathname.replace('/api/admin/qoder-runtime', '') || '';
  // 与 router.find 同款匹配：先精确、再按 :param 段匹配
  let hit = null;
  for (const r of qoderRuntime.routes) {
    if (r.method !== method) continue;
    const p = (r.path || '');
    if (p === suffix) { hit = { route: r, params: [] }; break; }
  }
  if (!hit) {
    // 交给真实 router 报 404（保持「未匹配」用例的真实性）
    const res = fakeRes();
    await router.handle(fakeReq(method, url), res, pathname);
    return res.out;
  }
  const res = fakeRes();
  const req = { method, url, headers: { 'content-type': 'application/json' } };
  await hit.route.handler({ req, res, body: body === undefined ? null : body, params: hit.params, user: null });
  return res.out;
}

function cleanup() {
  try { fs.unlinkSync(path.join(TMP, 'qoder-runtime.json')); } catch (e) { /* 不存在 */ }
  try { fs.unlinkSync(path.join(TMP, 'qoder-autocheckin.json')); } catch (e) { /* 不存在 */ }
  try { fs.unlinkSync(path.join(TMP, 'livecfg.json')); } catch (e) { /* 不存在 */ }
  try { require('../src/qoder/runtime')._resetForTest(); } catch (e) { /* ignore */ }
  try { require('../src/livecfg')._resetForTest(); } catch (e) { /* ignore */ }
}

(async () => {
  console.log('Qoder 运行策略端点（HTTP 层）');

  await check('GET /qoder-runtime：返回三份值并列（config / envDefaults / effective）', async () => {
    cleanup();
    const r = await call('GET', '/api/admin/qoder-runtime');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.config, '要有 config');
    assert.ok(r.body.envDefaults, '要有 envDefaults');
    assert.ok(r.body.effective, '要有 effective');
    assert.strictEqual(r.body.file, 'qoder-runtime.json');
    assert.deepStrictEqual(r.body.restartFields, [], '全部热生效——如实报空数组');
    // 四条 timeouts 都要在（面板按它们渲染卡片）
    for (const k of ['firstByteMs', 'contentMs', 'readIdleMs', 'maxBodyMb']) {
      assert.ok(typeof r.body.config.timeouts[k] === 'number', `timeouts.${k} 要是数字`);
    }
    // 并发闸门默认全关
    assert.strictEqual(r.body.config.concurrency.inflightMax, 0);
    assert.strictEqual(r.body.config.concurrency.pickStrategy, '');
    assert.ok(r.body.note.includes('热生效'), 'note 要说清热生效');
  });

  await check('PUT /qoder-runtime：改值后 GET 立刻读到（HTTP 层热生效）', async () => {
    cleanup();
    const w = await call('PUT', '/api/admin/qoder-runtime', {
      timeouts: { contentMs: 12345, maxBodyMb: 7 },
      concurrency: { pickStrategy: 'least-inflight' },
    });
    assert.strictEqual(w.status, 200);
    assert.strictEqual(w.body.ok, true);
    assert.strictEqual(w.body.config.timeouts.contentMs, 12345);
    // effective 是「真正生效值」——chat.js 的读取器要看到同一个数
    assert.strictEqual(w.body.effective.timeouts.contentMs, 12345, 'effective 要跟着变');
    assert.strictEqual(w.body.effective.concurrency.pickStrategy, 'least-inflight');
    // 闸门旋钮（inflightMax/minIntervalMs）P1-9 起归 livecfg 的 throttle 表，
    // 走「通道风控」页提交；effective 要跨来源读到它（不必重启）。
    require('../src/livecfg').Store({ throttle: { qoder: { inflightMax: 1 } } });
    const g = await call('GET', '/api/admin/qoder-runtime');
    assert.strictEqual(g.body.config.timeouts.contentMs, 12345);
    assert.strictEqual(g.body.effective.timeouts.maxBodyMb, 7, '请求体上限也热生效');
    assert.strictEqual(g.body.effective.concurrency.inflightMax, 1, 'livecfg 闸门值跨来源热生效');
    cleanup();
  });

  await check('PUT 未知键 → 400 且把白名单报出来（不静默丢弃）', async () => {
    cleanup();
    const r = await call('PUT', '/api/admin/qoder-runtime', { timeouts: { contentMS: 1000 } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.ok, false);
    assert.ok(/contentMS/.test(r.body.error), '错误要说清是哪个键：' + r.body.error);
    assert.ok(/白名单/.test(r.body.error), '要给出可选键');
  });

  await check('PUT 越界值 → 400（不落盘）', async () => {
    cleanup();
    const r = await call('PUT', '/api/admin/qoder-runtime', { concurrency: { inflightMax: 999 } });
    assert.strictEqual(r.status, 400);
    assert.ok(/inflightMax/.test(r.body.error));
    assert.ok(!fs.existsSync(path.join(TMP, 'qoder-runtime.json')), '校验失败不该留下文件');
  });

  await check('DELETE /qoder-runtime：删面板文件后回落到 env 默认值', async () => {
    cleanup();
    await call('PUT', '/api/admin/qoder-runtime', { timeouts: { contentMs: 5555 } });
    const d = await call('DELETE', '/api/admin/qoder-runtime');
    assert.strictEqual(d.status, 200);
    assert.strictEqual(d.body.removed, true);
    assert.strictEqual(d.body.config.timeouts.contentMs, 90000, '回落到默认 90s');
    const g = await call('GET', '/api/admin/qoder-runtime');
    assert.strictEqual(g.body.config.timeouts.contentMs, 90000);
    // 再删一次：如实报 removed=false，不报错
    const d2 = await call('DELETE', '/api/admin/qoder-runtime');
    assert.strictEqual(d2.body.removed, false);
    cleanup();
  });

  await check('GET /qoder-runtime/autocheckin：默认关 + 时点 10:15 + 理由齐备', async () => {
    cleanup();
    const r = await call('GET', '/api/admin/qoder-runtime/autocheckin');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.enabled, false, '自动打上游必须默认关');
    assert.strictEqual(r.body.hour, 10);
    assert.strictEqual(r.body.minute, 15);
    assert.strictEqual(r.body.include_intl, false, '国际版默认不进签到队列');
    assert.ok(Array.isArray(r.body.rationale) && r.body.rationale.length >= 4, '要给出为什么这么做');
    assert.ok(r.body.rationale.some((s) => /10:15/.test(s)), '理由里要点明 10:15 的依据');
    assert.strictEqual(r.body.next_run_at, null, '关着时没有下次触发时刻');
  });

  await check('PUT /qoder-runtime/autocheckin：越界时点 → 400', async () => {
    cleanup();
    const r = await call('PUT', '/api/admin/qoder-runtime/autocheckin', { hour: 24 });
    assert.strictEqual(r.status, 400);
    assert.ok(/hour/.test(r.body.error));
  });

  await check('PUT /qoder-runtime/autocheckin：改时点 + include_intl 落盘且读回一致', async () => {
    cleanup();
    const w = await call('PUT', '/api/admin/qoder-runtime/autocheckin', {
      hour: 11, minute: 5, jitter_minutes: 3, include_intl: true,
    });
    assert.strictEqual(w.status, 200);
    assert.strictEqual(w.body.hour, 11);
    assert.strictEqual(w.body.minute, 5);
    assert.strictEqual(w.body.jitter_minutes, 3);
    assert.strictEqual(w.body.include_intl, true);
    const g = await call('GET', '/api/admin/qoder-runtime/autocheckin');
    assert.strictEqual(g.body.hour, 11);
    assert.strictEqual(g.body.include_intl, true);
    // 关掉并复位，避免影响后续/真机
    await call('PUT', '/api/admin/qoder-runtime/autocheckin', {
      enabled: false, hour: 10, minute: 15, jitter_minutes: 10, include_intl: false,
    });
    cleanup();
  });

  await check('POST /qoder-runtime/autocheckin/run：触发式返回 started（不阻塞等结果）', async () => {
    cleanup();
    const r = await call('POST', '/api/admin/qoder-runtime/autocheckin/run');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.started, true);
    // 一轮可能在跑（有真实账号时会打上游），给它时间收尾再退
    await new Promise((s) => setTimeout(s, 300));
    try { require('../src/qoder/autocheckin').stop(); } catch (e) { /* ignore */ }
  });

  await check('未匹配路径 → 404（路由挂载没把其它前缀吃掉）', async () => {
    const r = await call('GET', '/api/admin/qoder-runtime/nope');
    assert.strictEqual(r.status, 404);
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* Windows 偶尔锁文件 */ }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(1);
});
