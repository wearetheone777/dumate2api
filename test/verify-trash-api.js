// test/verify-trash-api.js - 账号回收站端点的 HTTP 层验证（批次十六）
//
// 单测（test/unit/trash-store.test.js）验的是模块行为，这里验的是 **HTTP 层**：
// 4 条 /trash 路由的挂载与匹配顺序（字面 /trash 必须先于 /:id 参数路由）、
// confirm 双确认门、软删除响应形状、跨通道（dumate + workbuddy）端到端往返。
// 手法同 verify-workbuddy-rules-api.js：routes 表直接调 handler（过真实
// sendJSON 序列化），跳过「分发 + 鉴权」层。
//
// 运行：node test/verify-trash-api.js
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-trash-api-'));
process.env.DUMATE_ADMIN_DATA = TMP;

const trash = require('../src/admin/trash');
const accounts = require('../src/accounts');
const wbAuth = require('../src/workbuddy/auth');
const accountRoutes = require('../src/admin/routes/accounts');
const wbRoutes = require('../src/admin/routes/workbuddy');

let failures = 0;
let passed = 0;
async function check(label, fn) {
  try { await fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label} — ${e.message}`); }
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

// 按真实 router 的语义解析参数路由（':id'/:key' 按段捕获）
function findRoute(routes, method, p) {
  const segs = p.split('/').filter(Boolean);
  return routes.find((r) => {
    if (r.method !== method) return false;
    const rsegs = r.path.split('/').filter(Boolean);
    if (rsegs.length !== segs.length) return false;
    return rsegs.every((s, i) => s.startsWith(':') || s === segs[i]);
  });
}

async function call(routes, method, p, body) {
  const r = findRoute(routes, method, p);
  assert.ok(r, `路由已注册: ${method} ${p}`);
  const segs = p.split('/').filter(Boolean);
  const rsegs = r.path.split('/').filter(Boolean);
  const params = rsegs.map((s, i) => (s.startsWith(':') ? segs[i] : s)).filter((_, i) => rsegs[i] && rsegs[i].startsWith(':'));
  const res = fakeRes();
  await r.handler({ req: fakeReq(method, p), res, body: body || null, params, user: { username: 't', role: 'admin' } });
  return { status: res.out.status, body: res.out.body };
}

function seedDumate(rows) {
  accounts.save({ accounts: rows.map((r) => ({ id: r.id, name: r.name, cookie: r.cookie })) });
}

(async () => {
  // 1. 四条回收站路由在两个通道 route 表里都已注册，且排在参数路由之前
  await check('dumate/workbuddy 各注册 4 条 /trash 路由且排在最前', async () => {
    for (const routes of [accountRoutes.routes, wbRoutes.routes]) {
      const trashIdx = routes.findIndex((r) => r.path === '/trash');
      assert.ok(trashIdx === 0, `第一条就是 GET /trash（实为 index ${trashIdx}）——字面路由必须先于 /:id 参数路由`);
      assert.ok(findRoute(routes, 'GET', '/trash'), 'GET /trash');
      assert.ok(findRoute(routes, 'POST', '/trash/clear'), 'POST /trash/clear');
      assert.ok(findRoute(routes, 'POST', '/trash/9/restore'), 'POST /trash/:key/restore');
      assert.ok(findRoute(routes, 'DELETE', '/trash/9'), 'DELETE /trash/:key');
    }
  });

  // 2. 空回收站列表
  await check('GET /trash 空表形状', async () => {
    const r = await call(accountRoutes.routes, 'GET', '/trash');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.corrupt, false);
    assert.strictEqual(r.body.retentionDays, 30);
    assert.strictEqual(r.body.maxEntries, 200);
    assert.deepStrictEqual(r.body.entries, []);
  });

  // 3. DELETE /accounts/:id = 软删除：账号出 live、进回收站、响应带 trashed
  await check('DELETE /web-accounts/:id 软删除 + GET /trash 可见', async () => {
    seedDumate([{ id: 11, name: '十一号', cookie: '{{SECRET_fkpzwm6m}}' }, { id: 12, name: '十二号', cookie: '{{SECRET_uz2mmuhg}}' }]);
    const del = await call(accountRoutes.routes, 'DELETE', '/11');
    assert.strictEqual(del.status, 200, `软删除 200（实为 ${del.status}: ${JSON.stringify(del.body)}）`);
    assert.strictEqual(del.body.ok, true);
    assert.strictEqual(del.body.trashed, true, '响应带 trashed 标记');
    assert.strictEqual(del.body.name, '十一号');
    assert.deepStrictEqual(accounts.load().accounts.map((a) => a.id), [12], 'live 只剩 12');
    const list = await call(accountRoutes.routes, 'GET', '/trash');
    assert.strictEqual(list.body.entries.length, 1);
    assert.strictEqual(list.body.entries[0].key, '11');
    assert.strictEqual(list.body.entries[0].name, '十一号');
    // 回收站文件权限收紧（含凭据，0600）
    const mode = fs.statSync(path.join(TMP, trash.SPECS.dumate.file)).mode & 0o777;
    assert.strictEqual(mode, 0o600, `回收站文件 0600（实为 ${mode.toString(8)}）`);
  });

  // 4. 恢复：账号回 live、凭据逐字还原；恢复后条目消失
  await check('POST /trash/:key/restore 往返', async () => {
    const r = await call(accountRoutes.routes, 'POST', '/trash/11/restore');
    assert.strictEqual(r.status, 200, `恢复 200（实为 ${r.status}: ${JSON.stringify(r.body)}）`);
    const back = accounts.load().accounts.find((a) => a.id === 11);
    assert.ok(back, '账号回 live');
    assert.strictEqual(back.cookie, '{{SECRET_fkpzwm6m}}', '凭据逐字还原');
    const list = await call(accountRoutes.routes, 'GET', '/trash');
    assert.deepStrictEqual(list.body.entries, [], '恢复后条目消失');
    const again = await call(accountRoutes.routes, 'POST', '/trash/11/restore');
    assert.strictEqual(again.status, 400, '恢复已不在回收站的 key ⇒ 400');
    assert.ok(/回收站中没有该账号/.test(again.body.error));
  });

  // 5. purge / clear 的 confirm 双确认门（服务端强制，不是只靠前端）
  await check('purge 与 clear 无 confirm ⇒ 400；带 confirm 才执行', async () => {
    seedDumate([{ id: 21, name: '销毁对象', cookie: 'c21' }]);
    assert.strictEqual((await call(accountRoutes.routes, 'DELETE', '/21')).status, 200);
    const noConfirm = await call(accountRoutes.routes, 'DELETE', '/trash/21');
    assert.strictEqual(noConfirm.status, 400, '无 confirm 拒绝');
    assert.ok(/confirm/.test(noConfirm.body.error), '报「需要 confirm」');
    assert.strictEqual(trash.listTrash('dumate').entries.length, 1, '拒绝后条目仍在');
    const yes = await call(accountRoutes.routes, 'DELETE', '/trash/21', { confirm: true });
    assert.strictEqual(yes.status, 200, 'confirm 后 purge 成功');
    assert.deepStrictEqual(trash.listTrash('dumate').entries, []);

    seedDumate([{ id: 22, name: '甲', cookie: 'c22' }, { id: 23, name: '乙', cookie: 'c23' }]);
    await call(accountRoutes.routes, 'DELETE', '/22');
    await call(accountRoutes.routes, 'DELETE', '/23');
    const clearNo = await call(accountRoutes.routes, 'POST', '/trash/clear');
    assert.strictEqual(clearNo.status, 400, '清空无 confirm 拒绝');
    const clearYes = await call(accountRoutes.routes, 'POST', '/trash/clear', { confirm: true });
    assert.strictEqual(clearYes.status, 200);
    assert.strictEqual(clearYes.body.removed, 2, '返回被删条数');
  });

  // 6. workbuddy 通道端到端（跨通道接线：DELETE 软删除 → 恢复 → 记录形状）
  await check('workbuddy 通道 DELETE /accounts/:id + 恢复端到端', async () => {
    wbAuth.save({ accounts: [{ id: 31, nickname: 'wb 三十一', accessToken: 'WB-AT-31', refreshToken: 'WB-RT-31', region: 'cn' }] });
    const del = await call(wbRoutes.routes, 'DELETE', '/accounts/31');
    assert.strictEqual(del.status, 200, `workbuddy 软删除 200（实为 ${del.status}: ${JSON.stringify(del.body)}）`);
    assert.strictEqual(del.body.trashed, true);
    assert.strictEqual(del.body.name, 'wb 三十一', 'nameOf 取 nickname');
    assert.deepStrictEqual(wbAuth.load().accounts, [], 'live 清空');
    const raw = JSON.parse(fs.readFileSync(path.join(TMP, trash.SPECS.workbuddy.file), 'utf8'));
    assert.strictEqual(raw[0].account.refreshToken, 'WB-RT-31', '凭据随记录入回收站');
    const res = await call(wbRoutes.routes, 'POST', '/trash/31/restore');
    assert.strictEqual(res.status, 200);
    const back = wbAuth.load().accounts[0];
    assert.strictEqual(back.refreshToken, 'WB-RT-31', '恢复后凭据完整');
    assert.strictEqual(back.region, 'cn', '其余字段原样');
  });

  // 7. DELETE 不存在的账号 ⇒ 404（形状与旧口径一致）
  await check('DELETE /accounts/:id 不存在 ⇒ 404', async () => {
    const r = await call(accountRoutes.routes, 'DELETE', '/424242');
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.error, '账号不存在');
  });

  console.log(`\n${passed} 项通过，${failures} 项失败`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
