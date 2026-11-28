// test/verify-workbuddy-rules-api.js - WorkBuddy 模型规则端点的 HTTP 层验证（批次十二/十三）
//
// 单测（test/unit/workbuddy-modelrules.test.js）验的是模块行为，这里验的是
// **HTTP 层**：5 条 /model-rules 路由的挂载、body 解析、审计、错误码在端点
// 口径下的表现。手法同 verify-workbuddy-window-api.js：routes 表直接调
// handler（过真实 sendJSON 序列化），跳过「分发 + 鉴权」层。
//
// 运行：node test/verify-workbuddy-rules-api.js
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-wb-rules-'));
process.env.DUMATE_ADMIN_DATA = TMP;

const rules = require('../src/workbuddy/rules');
const auth = require('../src/workbuddy/auth');
const wbRoutes = require('../src/admin/routes/workbuddy');

const findRoute = (method, p) => wbRoutes.routes.find((r) => r.method === method && r.path === p);
assert.ok(findRoute('GET', '/model-rules'), 'GET /model-rules 已注册');
assert.ok(findRoute('POST', '/model-rules'), 'POST /model-rules 已注册');
assert.ok(findRoute('DELETE', '/model-rules/:id'), 'DELETE /model-rules/:id 已注册');
assert.ok(findRoute('POST', '/model-rules/assign'), 'POST /model-rules/assign 已注册');
assert.ok(findRoute('POST', '/model-rules/apply'), 'POST /model-rules/apply 已注册');

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

async function call(method, p, body, url, params) {
  const r = findRoute(method, p);
  const res = fakeRes();
  await r.handler({
    req: fakeReq(method, url || p), res, body: body || null,
    params: params || [], user: { username: 't', role: 'admin' },
  });
  return res.out;
}

(async () => {
  // 造两个假账号（hasAccess:false → /models 等上游路径快速失败，不出网）
  auth.upsert({ uid: 'uid-r1', nickname: '验证甲', region: 'cn', refreshToken: 'r', accessToken: 'a', enabled: false });
  auth.upsert({ uid: 'uid-r2', nickname: '验证乙', region: 'global', refreshToken: 'r', accessToken: 'a', enabled: false });
  const accs = auth.list();
  const accCN = accs.find((a) => a.region === 'cn');
  const accGL = accs.find((a) => a.region === 'global');

  let ruleId = '';

  await check('POST upsert：新建回 {ok,rule}，models 去重排序小写', async () => {
    const out = await call('POST', '/model-rules', { rule: { name: '贵模型白名单', mode: 'allow', models: ['B', 'A', 'A'] } });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.ok, true);
    assert.ok(out.body.rule.id, '生成 id');
    ruleId = out.body.rule.id;
    assert.deepStrictEqual(out.body.rule.models, ['a', 'b']);
  });

  await check('POST upsert：校验错误回 400 + error（空名 / 空 models）', async () => {
    const a = await call('POST', '/model-rules', { name: '', mode: 'deny', models: ['x'] });
    assert.strictEqual(a.status, 400); assert.ok(a.body.error);
    const b = await call('POST', '/model-rules', { name: 'x', mode: 'deny', models: [] });
    assert.strictEqual(b.status, 400); assert.ok(b.body.error);
  });

  await check('POST upsert：未知 id 更新回 404（不静默建新）', async () => {
    const out = await call('POST', '/model-rules', { rule: { id: 'no-such', name: 'x', mode: 'deny', models: ['m'] } });
    assert.strictEqual(out.status, 404);
    assert.match(out.body.error, /规则不存在/);
  });

  await check('POST assign：整体替换 + 未知规则 404 + 空数组清空', async () => {
    const ok1 = await call('POST', '/model-rules/assign', { account_id: accCN.id, ids: [ruleId] });
    assert.strictEqual(ok1.body.ok, true);
    assert.deepStrictEqual(ok1.body.ids, [ruleId]);
    const bad = await call('POST', '/model-rules/assign', { account_id: accCN.id, ids: ['wild'] });
    assert.strictEqual(bad.status, 404);
    const ok2 = await call('POST', '/model-rules/assign', { account_id: accCN.id, ids: [] });
    assert.strictEqual(ok2.body.ok, true);
    assert.deepStrictEqual(ok2.body.ids, []);
    assert.ok(!rules.ruleAssignments()[String(accCN.id)], '摘空不留行');
  });

  await check('POST apply：只增删这一条，回真实变化数；未知规则 404', async () => {
    const ok1 = await call('POST', '/model-rules/apply', { id: ruleId, account_ids: [accCN.id, accGL.id], assigned: true });
    assert.strictEqual(ok1.body.changed, 2);
    const ok2 = await call('POST', '/model-rules/apply', { id: ruleId, account_ids: [accCN.id], assigned: false });
    assert.strictEqual(ok2.body.changed, 1);
    const idem = await call('POST', '/model-rules/apply', { id: ruleId, account_ids: [accCN.id], assigned: false });
    assert.strictEqual(idem.body.changed, 0, '幂等');
    const bad = await call('POST', '/model-rules/apply', { id: 'no-such', account_ids: [], assigned: true });
    assert.strictEqual(bad.status, 404);
  });

  await check('GET 列表：rules/counts/assignments 形状齐全', async () => {
    const out = await call('GET', '/model-rules', null, '/model-rules');
    assert.strictEqual(out.body.ok, true);
    assert.ok(Array.isArray(out.body.rules) && out.body.rules.length === 1);
    assert.strictEqual(out.body.counts[ruleId], 1, '只有 global 号还挂着');
    assert.deepStrictEqual(out.body.assignments[String(accGL.id)], [ruleId]);
  });

  await check('GET ?account_id=&model=：账号视角 + 指定模型判定', async () => {
    rules.assignRules(accGL.id, [ruleId]);
    // 这条 allow 规则的模型清单用 global 域内名字，保证判定可见
    rules.upsertRule({ id: ruleId, name: '贵模型白名单', mode: 'allow', models: ['global:cheap-a'] });
    const url = `/model-rules?account_id=${accGL.id}&model=${encodeURIComponent('other-model')}`;
    const out = await call('GET', '/model-rules', null, url);
    assert.ok(out.body.account, '账号视图存在');
    assert.strictEqual(out.body.account.id, accGL.id);
    assert.strictEqual(out.body.account.region, 'global');
    assert.deepStrictEqual(out.body.account.ruleIds, [ruleId]);
    assert.strictEqual(out.body.account.blocked, true, '白名单之外 → 拦');
    const out2 = await call('GET', '/model-rules', null, `/model-rules?account_id=${accGL.id}&model=${encodeURIComponent('cheap-a')}`);
    assert.strictEqual(out2.body.account.blocked, false, '白名单之内 → 放行');
  });

  await check('GET ?account_id= 不存在的账号：account=null 不是报错', async () => {
    const out = await call('GET', '/model-rules', null, '/model-rules?account_id=999');
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.account, null);
  });

  await check('DELETE：摘引用后 counts/assignments 同步；不存在回 404', async () => {
    const out = await call('DELETE', '/model-rules/:id', null, '/model-rules/no-such', ['no-such']);
    assert.strictEqual(out.status, 404);
    const ok = await call('DELETE', '/model-rules/:id', null, `/model-rules/${ruleId}`, [ruleId]);
    assert.strictEqual(ok.body.ok, true);
    const list = await call('GET', '/model-rules', null, '/model-rules');
    assert.strictEqual(list.body.rules.length, 0);
    assert.deepStrictEqual(list.body.assignments, {}, '挂载关系一并清空');
  });

  if (failures) { console.log(`\n${failures} 项失败`); process.exit(1); }
  console.log('\n全部通过');
})().catch((e) => { console.error(e); process.exit(1); });
