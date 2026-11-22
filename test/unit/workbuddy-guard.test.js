// test/unit/workbuddy-guard.test.js - 额度护栏（P1-6）
//
// 出处：docs/WORKBUDDY-FUSION.md P1-6（hub 核心特性「额度护栏」）。本项目原来
// 是**事后**：积分耗尽 → 上游 402 → hard_credit → 402 给客户端。每次白打一个
// 上游请求，且账号在池里被记一次失败。
//
// 护栏是**选号过滤**而不是请求拦截，三条口径都必须成立（少一条就变成故障源）：
//   1. 默认关：不配就一行都不多算
//   2. 快照陈旧/缺失 → 护栏失效（绝不拿 6 小时前的余额把请求全拦死）
//   3. 全被剔除 → 退回全量（护栏只是省一次注定失败的请求，不能把通道弄停）
//
// 运行：node --test test/unit/workbuddy-guard.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-wb-guard');
process.env.DUMATE_ADMIN_DATA = TMP;

const snap = require('../../src/workbuddy/credits-snapshot');
const runtime = require('../../src/workbuddy/runtime');
const wb = require('../../src/workbuddy');

function clean() {
  for (const p of [snap.filePath(), `${snap.filePath()}.tmp`, runtime.filePath()]) {
    try { fs.unlinkSync(p); } catch (e) { /* 没有更正常 */ }
  }
  runtime._resetForTest();
  delete process.env.DUMATE_WORKBUDDY_CREDITS_TTL_MS;
}

test('快照：查不到（remain=null）的账号不写进去（不是 0）', () => {
  clean();
  snap.update([
    { id: 1, remain: 42, precise: 42.5 },
    { id: 2, remain: null, precise: null },
  ]);
  const doc = JSON.parse(fs.readFileSync(snap.filePath(), 'utf8'));
  assert.strictEqual(doc.accounts['1'].remain, 42.5, '有精确值时优先用精确值');
  assert.ok(!doc.accounts['2'], '查不到的账号不进快照');
});

test('快照：负值/非数字一律不写（坏读不能变成「欠费」）', () => {
  clean();
  snap.update([
    { id: 1, remain: -5 },
    { id: 2, remain: 'abc' },
    { id: 3, remain: 3 },
  ]);
  const doc = JSON.parse(fs.readFileSync(snap.filePath(), 'utf8'));
  assert.deepStrictEqual(Object.keys(doc.accounts), ['3']);
});

test('lowAccounts：低于阈值才进集合；无快照/无低额返回 null', () => {
  clean();
  assert.strictEqual(snap.lowAccounts(1), null, '没有快照 → null（护栏不生效）');
  snap.update([{ id: 1, remain: 0.4 }, { id: 2, remain: 100 }]);
  const low = snap.lowAccounts(1);
  assert.ok(low instanceof Set);
  assert.deepStrictEqual([...low], ['1']);
  assert.strictEqual(snap.lowAccounts(0.1), null, '没有账号低于阈值 → null');
});

test('lowAccounts：快照超 TTL → null（不拿旧余额拦请求）', () => {
  clean();
  const now = Date.now();
  snap.update([{ id: 1, remain: 0 }], { now: now - 2 * 3600 * 1000 });
  process.env.DUMATE_WORKBUDDY_CREDITS_TTL_MS = String(3600 * 1000);   // 1 小时
  assert.strictEqual(snap.lowAccounts(1, now), null, '2 小时前的快照已过期');
  process.env.DUMATE_WORKBUDDY_CREDITS_TTL_MS = String(3 * 3600 * 1000); // 3 小时
  assert.deepStrictEqual([...(snap.lowAccounts(1, now) || [])], ['1'], '3 小时窗口内仍有效');
  delete process.env.DUMATE_WORKBUDDY_CREDITS_TTL_MS;
});

test('info：新鲜度与管理端口径', () => {
  clean();
  assert.strictEqual(snap.info().fresh, false);
  assert.strictEqual(snap.info().at, null);
  snap.update([{ id: 1, remain: 5 }]);
  const i = snap.info();
  assert.strictEqual(i.fresh, true);
  assert.strictEqual(i.accounts, 1);
  assert.ok(i.at > 0);
});

test('update partial：未点名的账号原样保留（它们没被查，不是剩 0）', () => {
  clean();
  const now = Date.now();
  snap.update([{ id: 1, remain: 10 }, { id: 2, remain: 20 }], { now });
  snap.update([{ id: 1, remain: 3 }], { scope: 'partial', now: now + 1000 });
  const low = snap.lowAccounts(1, now + 1000);
  assert.strictEqual(low, null, '两个账号都还有钱');
  const doc = JSON.parse(fs.readFileSync(snap.filePath(), 'utf8'));
  assert.strictEqual(doc.accounts['1'].remain, 3);
  assert.strictEqual(doc.accounts['2'].remain, 20, '未点名的账号保留旧值');
  assert.strictEqual(doc.at, now, 'partial 不推进快照心跳（旧数据不能显得同样新鲜）');
});

test('lowCreditIdSet：默认关 → null；打开后按快照过滤', () => {
  clean();
  snap.update([{ id: 1, remain: 0 }, { id: 2, remain: 50 }]);
  assert.strictEqual(wb.lowCreditIdSet(), null, 'guard.enabled=false 时护栏不生效');

  runtime.Store({ guard: { enabled: true, threshold: 1 } });
  const ids = wb.lowCreditIdSet();
  assert.deepStrictEqual([...ids], ['1']);
});

test('guard 配置：阈值必须 > 0（填 0 不静默变成关闭）', () => {
  clean();
  assert.throws(() => runtime.Store({ guard: { threshold: 0 } }), /threshold/);
  assert.throws(() => runtime.Store({ guard: { threshold: -1 } }), /threshold/);
  assert.throws(() => runtime.Store({ guard: { nope: 1 } }), /未知配置键/);
  const out = runtime.Store({ guard: { enabled: true, threshold: 2.5 } });
  assert.strictEqual(out.config.guard.threshold, 2.5);
  assert.strictEqual(out.config.guard.enabled, true);
  runtime.Store({ guard: { enabled: false } });
});

test('快照模块异常时护栏不生效（观测面故障不拦请求）', () => {
  clean();
  // 把快照路径指到一个「目录位置是文件」的地方，loadSnap 会读到坏 JSON
  const blocker = path.join(TMP, 'blocker');
  fs.writeFileSync(blocker, 'x');
  process.env.DUMATE_WORKBUDDY_CREDITS_SNAPSHOT_FILE = path.join(blocker, 'nested.json');
  try {
    runtime.Store({ guard: { enabled: true, threshold: 1 } });
    assert.strictEqual(wb.lowCreditIdSet(), null, '读不到快照 → 护栏失效而不是全拦');
  } finally {
    delete process.env.DUMATE_WORKBUDDY_CREDITS_SNAPSHOT_FILE;
    runtime.Store({ guard: { enabled: false } });
  }
});
