// test/unit/workbuddy-keepalive-snapshot.test.js - keepalive 顺手写 FEFO / 护栏快照
//
// 出处（2026-11-08 补的真实缺口）：
// keepalive 的 workbuddy adapter 每天本来就打一次 `fetchCredits`（每号一次上游），
// 到期时间与精确剩余**已经到手**，却只留了余额——而 FEFO 快照
// （`expiring.js`）与额度护栏快照（`workbuddy/credits-snapshot.js`）原本
// **只有管理端 `/credits` 会写**。运维不点开 WorkBuddy 页面时，两份快照停在
// 上次打开的时刻，6 小时后 FEFO 静默退回普通轮询、护栏自动失效。
//
// 也就是说：一次已经付过费的上游查询，其副产物被白扔了。
//
// 这里钉五条口径（都与 `/credits` 严格一致，不能各写一套）：
//   1. 只把**未过期且在窗口内**的到期时刻写进 FEFO（已过期的包上游已废止）
//   2. 查询失败的账号走 keepIds → 旧条目保留，且 at 不推进（「部分旧」不能让
//      快照看起来同样新鲜）
//   3. 护栏快照 scope='all'，失败的号不写入（不是写 0）
//   4. `precise` 优先于整数 `remain`（整数是 floor，护栏阈值会误判）
//   5. 国际版（没有额度接口）如实失败，不写快照、不报 0
//
// 运行：node --test test/unit/workbuddy-keepalive-snapshot.test.js
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 临时目录必须自己收尾（项目纪律）：`mkdtempSync` 只建不删，本文件最初
// 漏了 `after` 清理，连跑几轮就在 %TEMP% 里堆出一批 wb-ka-snap-*。
const { tmpDir } = require('../helpers/tmpdir');
const DATA = tmpDir('wb-ka-snap');
after(() => { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* 收不掉不判失败 */ } });
process.env.DUMATE_ADMIN_DATA = DATA;
process.env.DUMATE_POOL_STATE = path.join(DATA, 'pool-state.json');

const keepalive = require('../../src/keepalive');
const expiringSnap = require('../../src/expiring');
const creditsSnap = require('../../src/workbuddy/credits-snapshot');

const DAY = 86400000;

/** 造一个只含一个通道的 adapter（避免 builtinAdapters 去读真实账号文件） */
function adapterOf(opts) {
  return {
    channel: 'workbuddy',
    list: () => opts.accounts,
    uid: (a) => `workbuddy:${a.id}`,
    name: (a) => a.nickname || `账号 ${a.id}`,
    refresh: async () => ({ ok: true, skipped: true, expire_at: null }),
    balance: async (a) => opts.balanceOf(a),
    persistSnapshots: opts.snapshotImpl || null,
  };
}

/** 取真实 adapter 的 persistSnapshots 实现（要在 adapter 语境里跑） */
function realPersist() {
  const ads = keepalive.internals.builtinAdapters
    ? keepalive.internals.builtinAdapters()
    : null;
  if (!ads) return null;
  const wb = ads.find((a) => a.channel === 'workbuddy');
  return wb && typeof wb.persistSnapshots === 'function' ? wb.persistSnapshots : null;
}

test('adapter 暴露 persistSnapshots（否则 keepalive 阶段 4.5 会静默跳过）', () => {
  // 这是「可选能力」：没有它整条链路不报错、也不写快照——正是最该锁的形状
  const impl = realPersist();
  assert.equal(typeof impl, 'function', 'workbuddy adapter 必须暴露 persistSnapshots');
});

test('端到端：runOnce 后 FEFO 与护栏两份快照都被写入', async () => {
  const now = Date.now();
  const ads = [{
    channel: 'workbuddy',
    list: () => [{ id: 1, nickname: '甲' }, { id: 2, nickname: '乙' }],
    uid: (a) => `workbuddy:${a.id}`,
    name: (a) => a.nickname,
    refresh: async () => ({ ok: true, skipped: true }),
    balance: async (a) => (a.id === 1
      ? { ok: true, remain: 100, precise: 100.5, expireNearest: now + 3 * DAY }
      : { ok: false, error: '401' }),
    // 挂真实实现（不是抄一份假的——假的永远与实现同步，等于没测）
    persistSnapshots: realPersist(),
  }];

  const fakePool = { snapshot: () => [], noteSuccess() {}, revive() {}, reenableIfCredits: () => ({}) };
  const r = await keepalive.runOnce('manual', { adapters: ads, pool: fakePool, per_account_delay_ms: 0, sem_cap: 1, checkin: false });

  assert.ok(r.snapshots, '结果里要能看见快照写入回执（否则排障时无从判断）');
  const wb = r.snapshots.workbuddy;
  assert.equal(wb.fefoWrote, true);
  assert.equal(wb.guardWrote, true);
  assert.equal(wb.entries, 1, '只有账号 1 有窗口内到期');
  assert.equal(wb.failed, 1, '账号 2 查询失败');

  const fefo = JSON.parse(fs.readFileSync(expiringSnap.filePath(), 'utf8'));
  assert.equal(fefo.channels.workbuddy.accounts['1'] > now, true, 'FEFO 落了账号 1');
  assert.equal(fefo.channels.workbuddy.accounts['2'], undefined, '失败的号不进 entries');

  const guard = JSON.parse(fs.readFileSync(creditsSnap.filePath(), 'utf8'));
  assert.equal(guard.accounts['1'].remain, 100.5, 'precise 优先于整数 remain');
  assert.equal(guard.accounts['2'], undefined, '失败的号不写进护栏快照（不是写 0）');
});

test('窗口外的到期时刻不写 FEFO（已过期/太远都不算临期）', async () => {
  const now = Date.now();
  // 直接测过滤语义：借真实 adapter 的实现
  const persist = realPersist();
  assert.equal(typeof persist, 'function', '工作前提：adapter 有 persistSnapshots');

  const rows = [
    { channel: 'workbuddy', accountId: 11, ok: true, remain: 5, precise: 5, expireNearest: now - DAY },        // 已过期
    { channel: 'workbuddy', accountId: 12, ok: true, remain: 5, precise: 5, expireNearest: now + 60 * DAY },    // 太远
    { channel: 'workbuddy', accountId: 13, ok: true, remain: 5, precise: 5, expireNearest: null },              // 无到期
  ];
  const out = persist(rows);
  assert.equal(out.entries, 0, '三个都不是临期');
  const fefo = JSON.parse(fs.readFileSync(expiringSnap.filePath(), 'utf8'));
  for (const id of ['11', '12', '13']) {
    assert.equal(fefo.channels.workbuddy.accounts[id], undefined, `账号 ${id} 不该进 FEFO`);
  }
  // 但护栏快照要写（余额是有效的，与到期无关）
  const guard = JSON.parse(fs.readFileSync(creditsSnap.filePath(), 'utf8'));
  assert.equal(guard.accounts['11'].remain, 5);
});

test('全部查询失败时不推进 FEFO 的 at（部分旧数据不能让快照看起来新鲜）', async () => {
  const persist = realPersist();
  assert.equal(typeof persist, 'function', '工作前提：adapter 有 persistSnapshots');
  // 先写一次成功，拿到 at
  persist([{ channel: 'workbuddy', accountId: 21, ok: true, remain: 9, precise: 9, expireNearest: Date.now() + DAY }]);
  const before = JSON.parse(fs.readFileSync(expiringSnap.filePath(), 'utf8')).channels.workbuddy.at;
  await new Promise((r) => setTimeout(r, 15));
  // 再全部失败
  persist([{ channel: 'workbuddy', accountId: 21, ok: false, remain: null, precise: null, expireNearest: null }]);
  const after = JSON.parse(fs.readFileSync(expiringSnap.filePath(), 'utf8')).channels.workbuddy;
  assert.equal(after.at, before, '有 keepIds 时 at 不推进');
  assert.equal(after.accounts['21'] > 0, true, '旧条目保留');
});

test('国际版（无额度接口）：不写 FEFO、不写护栏、不报 0', async () => {
  const persist = realPersist();
  assert.equal(typeof persist, 'function', '工作前提：adapter 有 persistSnapshots');
  const out = persist([{ channel: 'workbuddy', accountId: 31, ok: false, remain: null, precise: null, expireNearest: null }]);
  assert.equal(out.entries, 0);
  const guard = JSON.parse(fs.readFileSync(creditsSnap.filePath(), 'utf8'));
  assert.equal(guard.accounts['31'], undefined, '查不到 ≠ 剩 0');
});
