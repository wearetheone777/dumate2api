// test/verify-backup-api.js - 备份分区表端点的 HTTP 层验证（批次十四）
//
// 单测（test/unit/backup-sections.test.js）验的是纯函数语义，这里验 **HTTP 层
// 编排**：导出闸门（sensitive/confirm）、预览**零写盘**、导入落盘、策略逐分区
// 回报、灾备还原往返（导出→清空→导入→对得上）。
// 手法同 verify-workbuddy-rules-api.js：routes 表直接调 handler（过真实 sendJSON）。
//
// 运行：node test/verify-backup-api.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-backup-api-'));
process.env.DUMATE_ADMIN_DATA = TMP;

const backupRoutes = require('../src/admin/routes/backup');
const wbAuth = require('../src/workbuddy/auth');

const getRoute = (method, p) => backupRoutes.routes.find((r) => r.method === method && r.path === p);

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

async function call(method, p, body) {
  const r = getRoute(method, p);
  assert.ok(r, `路由 ${method} ${p} 已注册`);
  const res = fakeRes();
  await r.handler({ req: fakeReq(method, p), res, body: body || null, params: [], user: { username: 't', role: 'admin' } });
  return res.out;
}

const fjson = (name) => path.join(TMP, name);
const seedAccounts = [
  { id: 1, uid: 'uid-a', nickname: '甲', region: 'cn', accessToken: 'WB-AT-1', refreshToken: 'WB-RT-1', enabled: true, hasAccess: false, hasRefresh: false },
  { id: 2, uid: 'uid-b', nickname: '乙', region: 'global', accessToken: 'WB-AT-2', refreshToken: 'WB-RT-2', enabled: true, hasAccess: false, hasRefresh: false },
];
function snapshotFile(name) {
  try { return fs.readFileSync(fjson(name), 'utf8'); } catch (e) { return null; }
}

(async () => {
  // 种子：账号 + 模型映射
  fs.writeFileSync(fjson('workbuddy-accounts.json'), JSON.stringify({ accounts: seedAccounts }));
  fs.writeFileSync(fjson('model-map.json'), JSON.stringify({ aliases: { 'glm-5': 'glm-5' }, fallback: 'model-text' }));

  await check('GET /sections：表驱动行形状齐全（kind/sensitive/count/exists）', async () => {
    const out = await call('GET', '/sections');
    assert.strictEqual(out.status, 200);
    const rows = out.body.sections;
    assert.ok(rows.length >= 14, `分区行数合理（实际 ${rows.length}）`);
    const wb = rows.find((r) => r.id === 'accounts-workbuddy');
    assert.strictEqual(wb.kind, 'accounts');
    assert.strictEqual(wb.count, 2);
    assert.strictEqual(wb.exists, true);
    const keys = rows.find((r) => r.id === 'keys');
    assert.strictEqual(keys.sensitive, true);
    assert.strictEqual(keys.exists, false, 'keys.json 没种：如实 exists=false');
  });

  await check('POST /export：sensitive 不勾含凭据 → 400；含凭据缺 confirm → 400', async () => {
    const a = await call('POST', '/export', { sections: ['keys'] });
    assert.strictEqual(a.status, 400);
    assert.match(a.body.error, /凭据分区/);
    const b = await call('POST', '/export', { sections: ['keys'], includeCredentials: true });
    assert.strictEqual(b.status, 400);
    assert.match(b.body.error, /confirm/);
    const c = await call('POST', '/export', { sections: ['no-such'] });
    assert.strictEqual(c.status, 400);
    assert.match(c.body.error, /未知分区/);
    const d = await call('POST', '/export', { sections: [] });
    assert.strictEqual(d.status, 400);
  });

  let env = null;
  await check('POST /export：脱敏形态——正文里搜不到凭据原文，分区标 redacted', async () => {
    const out = await call('POST', '/export', { sections: ['accounts-workbuddy', 'model-map'] });
    assert.strictEqual(out.status, 200);
    env = out.body.envelope;
    const text = JSON.stringify(env);
    for (const secret of ['WB-AT-1', 'WB-RT-1', 'WB-AT-2', 'WB-RT-2']) {
      assert.ok(!text.includes(secret), `脱敏导出不得含 ${secret}`);
    }
    assert.strictEqual(env.sections['accounts-workbuddy'].redacted, true);
    assert.strictEqual(env.sections['model-map'].data.fallback, 'model-text', '配置分区原样导出');
    assert.strictEqual(env.format, 'dumate2api-backup');
    assert.strictEqual(env.version, 1);
  });

  await check('POST /preview：逐分区计数正确且**零写盘**（文件字节不变）', async () => {
    const before = snapshotFile('workbuddy-accounts.json');
    const beforeMM = snapshotFile('model-map.json');
    const incoming = JSON.parse(JSON.stringify(env));
    incoming.sections['model-map'].data = { fallback: 'changed', newKey: 1 };
    const out = await call('POST', '/preview', { envelope: incoming, policy: 'overwrite' });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.write, false);
    const r = out.body.results;
    // 账号：两号全命中（脱敏来件）→ overwrite 2；配置：fallback 覆盖 + newKey 新增
    assert.strictEqual(r['accounts-workbuddy'].overwritten, 2);
    assert.strictEqual(r['accounts-workbuddy'].conflicts, 2);
    assert.strictEqual(r['model-map'].overwritten, 1);
    assert.strictEqual(r['model-map'].added, 1);
    assert.strictEqual(snapshotFile('workbuddy-accounts.json'), before, '预览不动账号文件');
    assert.strictEqual(snapshotFile('model-map.json'), beforeMM, '预览不动配置文件');
  });

  await check('POST /import keepLocal：命中全跳过，内容不变（格式化差异不算改动）', async () => {
    const before = JSON.parse(snapshotFile('workbuddy-accounts.json'));
    const out = await call('POST', '/import', { envelope: env, policy: 'keepLocal' });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.results['accounts-workbuddy'].skipped, 2);
    assert.strictEqual(out.body.results['accounts-workbuddy'].added, 0);
    assert.strictEqual(out.body.results['accounts-workbuddy'].conflicts, 2, 'conflicts 是计数不是清单');
    assert.deepStrictEqual(JSON.parse(snapshotFile('workbuddy-accounts.json')), before);
  });

  await check('POST /import overwrite（脱敏来件）：改昵称但**凭据保留**', async () => {
    const out = await call('POST', '/import', {
      envelope: {
        format: 'dumate2api-backup', version: 1,
        sections: { 'accounts-workbuddy': { redacted: true, data: [
          { uid: 'uid-a', nickname: '甲改' }, { uid: 'uid-b', nickname: '乙改' },
        ] } },
      },
      policy: 'overwrite',
    });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.results['accounts-workbuddy'].overwritten, 2);
    const stored = wbAuth.load().accounts;
    const a = stored.find((x) => x.uid === 'uid-a');
    assert.strictEqual(a.nickname, '甲改', '非凭据字段被覆盖');
    assert.strictEqual(a.accessToken, 'WB-AT-1', '凭据保留（没带 ≠ 没有）');
    assert.strictEqual(a.refreshToken, 'WB-RT-1');
  });

  await check('POST /import keepBoth：同身份追加分身并重赋 id', async () => {
    const out = await call('POST', '/import', {
      envelope: {
        format: 'dumate2api-backup', version: 1,
        sections: { 'accounts-workbuddy': { redacted: true, data: [{ uid: 'uid-a', nickname: '甲分身' }] } },
      },
      policy: 'keepBoth',
    });
    const stored = wbAuth.load().accounts;
    assert.strictEqual(stored.length, 3);
    const clone = stored.find((x) => x.nickname === '甲分身');
    assert.ok(clone && clone.id !== 1 && clone.id > 0, '分身拿新 id');
    assert.strictEqual(out.body.results['accounts-workbuddy'].added, 1);
  });

  await check('闸门：坏信封 / 坏策略 / 未知名 id → 400；信封未知分区 → ignored 回报', async () => {
    const badEnv = await call('POST', '/preview', { envelope: { format: 'x' }, policy: 'keepLocal' });
    assert.strictEqual(badEnv.status, 400);
    const badPolicy = await call('POST', '/preview', { envelope: env, policy: '覆盖' });
    assert.strictEqual(badPolicy.status, 400);
    assert.match(badPolicy.body.error, /未知的冲突策略/);
    const fwd = await call('POST', '/preview', {
      envelope: { format: 'dumate2api-backup', version: 1, sections: { 'future-section': { data: {} } } },
      policy: 'keepLocal',
    });
    assert.strictEqual(fwd.status, 400); // 没有可导入分区
    const fwd2 = await call('POST', '/preview', {
      envelope: { format: 'dumate2api-backup', version: 1, sections: { 'future-section': { data: {} }, 'model-map': { data: { a: 1 } } } },
      policy: 'keepLocal',
    });
    assert.strictEqual(fwd2.status, 200);
    assert.deepStrictEqual(fwd2.body.ignored, ['future-section'], '未知分区如实回报不猜');
  });

  let fullEnv = null;
  await check('灾备还原往返：含凭据导出 → 清空 → 导入 → 逐字节对得上', async () => {
    const out = await call('POST', '/export', {
      sections: ['accounts-workbuddy', 'model-map'],
      includeCredentials: true, confirm: true,
    });
    assert.strictEqual(out.status, 200);
    fullEnv = out.body.envelope;
    assert.ok(JSON.stringify(fullEnv).includes('WB-AT-1'), '含凭据形态原文在');

    // 清空（模拟新机器）
    wbAuth.load().accounts = [];
    wbAuth.save({ accounts: [] });
    fs.rmSync(fjson('model-map.json'), { force: true });

    const restored = await call('POST', '/import', { envelope: fullEnv, policy: 'keepLocal' });
    assert.strictEqual(restored.status, 200);
    const r = restored.body.results;
    // keepBoth 造出的「甲分身」与正身同 uid：同批导入按身份配对，先入者占位、
    // 后到者 skipped——还原不会把分身复制成第三条（可取的副作用，如实断言）
    assert.strictEqual(r['accounts-workbuddy'].added, 2, '空库导入：正身 + 乙（分身与正身同身份被去重）');
    assert.strictEqual(r['accounts-workbuddy'].skipped, 1);
    assert.strictEqual(r['model-map'].added, 2, 'aliases + fallback 两键新增');
    assert.strictEqual(r['model-map'].overwritten, 0, '导出时缺失的分区不补 0');

    const accounts = wbAuth.load().accounts;
    assert.strictEqual(accounts.length, 2);
    const a = accounts.find((x) => x.uid === 'uid-a');
    assert.strictEqual(a.accessToken, 'WB-AT-1');
    assert.strictEqual(a.refreshToken, 'WB-RT-1');
    assert.strictEqual(a.nickname, '甲改', '正身字段原样还原（overwrite 步的改名）');
    const mm = JSON.parse(fs.readFileSync(fjson('model-map.json'), 'utf8'));
    assert.strictEqual(mm.fallback, 'model-text');
  });

  if (failures) { console.log(`\n${failures} 项失败`); process.exit(1); }
  console.log('\n全部通过');
})().catch((e) => { console.error(e); process.exit(1); });
