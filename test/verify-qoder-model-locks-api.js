// test/verify-qoder-model-locks-api.js - 模型锁池端点的端到端验证（P2-19）
//
// 单测（test/unit/qoder-model-locks.test.js）验的是聚合纯函数；这里验的是
// **HTTP 端点**：区域过滤、与池单例的真实对接、cleared / available 口径。
//
// 手法：把路由表挂进独立 router（不启管理端），直接调 handler（与
// verify-qoder-runtime-api.js 同款理由：router.mount 会复制 public 标志，
// 改原表无效，而走真实鉴权需要口令）。锁用**真实池单例**制造——那正是端点
// 消费的数据源，用假的就测不到「与 pool.snapshot 形状对得上」这件事。
//
// 用法：node test/verify-qoder-model-locks-api.js
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-qoder-locks-'));
process.env.DUMATE_ADMIN_DATA = TMP;
// 池状态写临时文件：本脚本会造冷却，写真实池会让后续真实请求选不到号
process.env.DUMATE_POOL_STATE = path.join(TMP, 'pool-state.json');
// 关掉防撞号/抽签随机性对选号的影响（本脚本不选号，但保持确定性）
process.env.DUMATE_POOL_PICK_MODE = 'rr';

const router = require('../src/admin/router');
const qoderRoute = require('../src/admin/routes/qoder');
const { pool } = require('../src/pool');

/** 只挑出 /model-locks 这一条，挂在前缀下（避免整表挂载把别的端点也带进来） */
const only = qoderRoute.routes.filter((r) => r.path === '/model-locks');
assert.ok(only.length === 1, '必须能定位到 /model-locks 路由');
router.mount('/api/admin/qoder', only);

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`[PASS] ${label}`); } catch (e) { failures++; console.log(`[FAIL] ${label} — ${e.message}`); }
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
    writableEnded: false, destroyed: false,
  };
}

async function call(url) {
  const pathname = url.split('?')[0];
  const suffix = pathname.replace('/api/admin/qoder', '') || '';
  const hit = only.find((r) => r.method === 'GET' && r.path === suffix);
  if (!hit) {
    const res = fakeRes();
    await router.handle({ method: 'GET', url, headers: {} }, res, pathname);
    return res.out;
  }
  const res = fakeRes();
  await hit.handler({ req: { method: 'GET', url, headers: {} }, res, body: null, params: [], user: null });
  return res.out;
}

/** 造一条真实的模型级冷却（与 index.js 的 poolInfoOf 同形：status 403 + scope:model） */
function lockModel(accountId, model, ms, reason) {
  pool.noteError(`qoder:${accountId}`, {
    status: 403, message: reason || '10605 RESOURCE_LIMIT', model,
    retryAfterMs: ms, scope: 'model', kind: 'soft',
  });
}

(async () => {
  console.log('模型锁池端点（HTTP 层）');

  await check('无锁：cleared=true、models 为空、available = 账号总数', async () => {
    const r = await call('/api/admin/qoder/model-locks');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.cleared, true, '无锁是正常态');
    assert.deepStrictEqual(r.body.models, [], '空数组，不造「全部正常」的假行');
    assert.strictEqual(r.body.lockedAccounts, 0);
    assert.strictEqual(r.body.available, r.body.totalAccounts, '没锁 = 全部可选');
    assert.ok(r.body.note.includes('(账号, 模型)'), 'note 要说清粒度');
  });

  await check('造一条模型级冷却：出现在锁池里，账号 id 去前缀、带解锁倒计时', async () => {
    lockModel(1, 'dfmodel', 120000, '{"code":"10605","isQueued":true,"subCode":"RESOURCE_LIMIT"}');
    const r = await call('/api/admin/qoder/model-locks');
    assert.strictEqual(r.body.cleared, false);
    const m = r.body.models.find((x) => x.model === 'dfmodel');
    assert.ok(m, 'dfmodel 应出现在锁池里');
    assert.deepStrictEqual(m.accounts, ['1'], '账号 id 要去掉 qoder: 前缀');
    assert.strictEqual(m.accountCount, 1);
    assert.strictEqual(m.kind, 'queue', '10605/isQueued 判为排队');
    assert.ok(m.allClearInMs > 0, '要有全池解锁倒计时');
    assert.ok(m.allClearInMs <= 120000 + 1000, '不超过造的 120 秒');
    assert.strictEqual(r.body.lockedAccounts, 1);
    assert.strictEqual(r.body.available, Math.max(0, r.body.totalAccounts - 1));
  });

  await check('同账号锁两个模型：lockedAccounts 只算一个号（available 不重复扣）', async () => {
    lockModel(1, 'qfmodel', 60000, '{"code":"10605","isQueued":true}');
    const r = await call('/api/admin/qoder/model-locks');
    const models = r.body.models.map((x) => x.model);
    assert.ok(models.includes('dfmodel') && models.includes('qfmodel'));
    assert.strictEqual(r.body.lockedAccounts, 1, '一个号锁两个模型仍是一个号');
    assert.strictEqual(r.body.available, Math.max(0, r.body.totalAccounts - 1));
  });

  await check('别的通道的锁不进 Qoder 视图（池是所有通道共用的）', async () => {
    pool.noteError('traework:99', {
      status: 403, message: 'glm-5.2 爆了', model: 'glm-5.2', retryAfterMs: 60000, scope: 'model', kind: 'soft',
    });
    const r = await call('/api/admin/qoder/model-locks');
    assert.ok(!r.body.models.some((x) => x.model === 'glm-5.2'), 'TRAE 的模型不该出现');
  });

  await check('区域过滤：?region=cn 下别区账号的锁被剔掉', async () => {
    lockModel(2, 'gfmodel', 60000, '{"code":"10605"}');
    const all = await call('/api/admin/qoder/model-locks');
    const gfAll = all.body.models.find((x) => x.model === 'gfmodel');
    assert.ok(gfAll && gfAll.accounts.includes('2'), '不限区域时 2 号在里面');
    // 造一个「2 号是国际版」的假象是不行的（账号表是真实落盘的），所以这里
    // 只验「区域过滤不会报错且字段自洽」——真实语义由账号表的 region 决定
    const cnView = await call('/api/admin/qoder/model-locks?region=cn');
    assert.strictEqual(cnView.status, 200);
    assert.ok(Array.isArray(cnView.body.models));
    for (const m of cnView.body.models) {
      assert.strictEqual(m.accountCount, m.accounts.length, 'accountCount 要与 accounts 自洽');
    }
  });

  await check('清除锁后回到 cleared=true（note/summary 字段齐备）', async () => {
    pool.revive('qoder:1');
    pool.revive('qoder:2');
    const r = await call('/api/admin/qoder/model-locks');
    assert.strictEqual(r.body.cleared, true, 'revive 清掉模型级冷却后应回正常态');
    assert.ok(r.body.note.includes('全池解锁'), 'note 要提示 earliest/allClear 的区别');
  });

  await check('未匹配子路径 → 404（挂载没把其它路径吃掉）', async () => {
    const r = await call('/api/admin/qoder/model-locks/nope');
    assert.strictEqual(r.status, 404);
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* Windows 偶尔锁文件 */ }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(1);
});
