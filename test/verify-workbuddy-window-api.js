// test/verify-workbuddy-window-api.js - WorkBuddy 6004 窗口端点的 HTTP 层验证
//
// 单测（test/unit/workbuddy-windowprobe.test.js）验的是模块行为，这里验的是
// **HTTP 层**：路由挂载、body 解析、形状、闸门语义在端点口径下的表现。
// 手法同 verify-qoder-runtime-api.js：routes 表直接调 handler（过真实
// sendJSON 序列化），跳过「分发 + 鉴权」层——鉴权行为已由实机确认。
//
// 运行：node test/verify-workbuddy-window-api.js
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-wb-window-'));
process.env.DUMATE_ADMIN_DATA = TMP;

const wp = require('../src/workbuddy/windowprobe');
const auth = require('../src/workbuddy/auth');
const chat = require('../src/workbuddy/chat');
const wbRoutes = require('../src/admin/routes/workbuddy');

// 路由表按 path 找 handler（mount 拼前缀前的原始 path）
const findRoute = (method, p) => wbRoutes.routes.find((r) => r.method === method && r.path === p);
assert.ok(findRoute('GET', '/windows'), 'GET /windows 已注册');
assert.ok(findRoute('POST', '/windows/run'), 'POST /windows/run 已注册');

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`[PASS] ${label}`); }
  catch (e) { failures++; console.log(`[FAIL] ${label} — ${e.message}`); }
}

function fakeRes() {
  const out = { status: 0, body: null };
  return {
    out,
    setHeader() {},
    writeHead(code) { out.status = code; return this; },
    write() { return true; },
    end(chunk) {
      if (chunk) { try { out.body = JSON.parse(String(chunk)); } catch (e) { out.body = String(chunk); } }
      return this;
    },
    get headersSent() { return out.status !== 0; },
    writableEnded: false,
    destroyed: false,
  };
}

function fakeReq(method, url) {
  return { method, url, headers: {}, on() { return this; }, resume() {}, destroy() {} };
}

async function call(method, p, body, url) {
  const r = findRoute(method, p);
  const res = fakeRes();
  await r.handler({ req: fakeReq(method, url || p), res, body: body || null, params: {}, user: { username: 't', role: 'admin' } });
  return res.out;
}

const STORE = () => path.join(TMP, 'workbuddy-model-windows.json');
function backdate(accountId, model) {
  const j = JSON.parse(fs.readFileSync(STORE(), 'utf8'));
  const w = j.windows.find((x) => x.accountId === accountId && x.model === model);
  w.resetAt = Date.now() - 1000;
  fs.writeFileSync(STORE(), JSON.stringify(j));
}

(async () => {
  // 清场：其它验证可能留下的窗口不影响本脚本断言
  fs.rmSync(STORE(), { force: true });

  await check('GET /windows：空表形状（ok/enabled/windows/next_due_in_ms）', async () => {
    const out = await call('GET', '/windows');
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.enabled, true);
    assert.deepEqual(out.body.windows, []);
    assert.equal(out.body.next_due_in_ms, null);
  });

  await check('GET /windows：未来窗口 due:false + in_ms>0', async () => {
    assert.equal(wp.registerWindow(7, 'glm-5.3', Date.now() + 60_000, { region: 'cn' }), true);
    const out = await call('GET', '/windows');
    const row = out.body.windows.find((w) => w.model === 'glm-5.3');
    assert.ok(row);
    assert.equal(row.due, false);
    assert.ok(row.in_ms > 0);
    assert.ok(out.body.next_due_in_ms > 0);
  });

  await check('GET /windows：回拨后 due:true', async () => {
    backdate(7, 'glm-5.3');
    const out = await call('GET', '/windows');
    assert.equal(out.body.windows.find((w) => w.model === 'glm-5.3').due, true);
  });

  await check('POST /windows/run：到点+未到点混合 → 只探到点的，skipped_not_due 如实', async () => {
    wp.registerWindow(7, 'future-model', Date.now() + 600_000, { region: 'cn' });
    // 隔离数据目录没有账号 → glm-5.3 被闸门拦下（dropped，不计入 sent）
    const out = await call('POST', '/windows/run', {});
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.sent, 0, '拦下的不计入 sent');
    assert.deepEqual(out.body.results.map((x) => x.model), ['glm-5.3'], '未来窗口不处理');
    assert.equal(out.body.results[0].action, 'dropped');
    assert.ok(out.body.results[0].reason);
    assert.equal(out.body.skipped_not_due, 1);
    assert.ok(wp.listWindows().some((w) => w.model === 'future-model'), '未来窗口原样保留');
  });

  await check('POST /windows/run：account_id+model 过滤只探点名窗口', async () => {
    backdate(7, 'future-model');
    const realFindUsable = auth.findUsable;
    let probeCalls = 0;
    const realPostStream = chat.postStream;
    auth.findUsable = () => [{ id: 7, region: 'cn', accessToken: 't' }];
    chat.postStream = async () => { probeCalls++; return { fatal: true, error: 'stop here' }; };
    try {
      const out = await call('POST', '/windows/run', { account_id: 7, model: 'future-model' });
      assert.equal(out.body.sent, 1);
      assert.equal(probeCalls, 1, '过滤后只发一次探针');
      assert.equal(out.body.results[0].action, 'failed');
    } finally {
      auth.findUsable = realFindUsable;
      chat.postStream = realPostStream;
    }
  });

  await check('POST /windows/run：点名不存在窗口 → sent:0 + not_due 如实', async () => {
    const out = await call('POST', '/windows/run', { account_id: 42, model: 'nope' });
    assert.equal(out.body.sent, 0);
    assert.deepEqual(out.body.results, []);
    assert.equal(out.body.not_due, 0);
    assert.ok(out.body.note);
  });

  await check('DUMATE_WORKBUDDY_WINDOW_PROBE=0：GET 报 enabled:false，run 明确拒绝', async () => {
    const prev = process.env.DUMATE_WORKBUDDY_WINDOW_PROBE;
    process.env.DUMATE_WORKBUDDY_WINDOW_PROBE = '0';
    try {
      const g = await call('GET', '/windows');
      assert.equal(g.body.enabled, false);
      const out = await call('POST', '/windows/run', {});
      assert.equal(out.body.ok, false);
      assert.ok(/关闭/.test(out.body.error));
    } finally {
      if (prev === undefined) delete process.env.DUMATE_WORKBUDDY_WINDOW_PROBE;
      else process.env.DUMATE_WORKBUDDY_WINDOW_PROBE = prev;
    }
  });

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})();
