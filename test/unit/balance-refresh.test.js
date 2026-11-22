// test/unit/balance-refresh.test.js - 低频余额刷新（2026-11-07 融合项 P1-5）
//
// 进程级隔离：DUMATE_ADMIN_DATA 指到临时目录（store / accounts / balance-hist /
// expiring 全家桶都在模块加载时读它），绝不碰真实 data/。
// 钉四条纪律：FEFO 快照只算剩余>0 的包、失败账号走 keepIds、解冻复用
// keepalive 的 reconcile（只解硬冷却）、running 互斥。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// env 必须在 require 业务模块之前就位（各家 DATA_DIR 都在模块加载时定型）
const { tmpDir } = require('../helpers/tmpdir');
process.env.DUMATE_ADMIN_DATA = tmpDir('balance-refresh-data');
process.env.DUMATE_POOL_STATE = path.join(process.env.DUMATE_ADMIN_DATA, 'pool-state.json');

const br = require('../../src/balance-refresh');
const expiringSnap = require('../../src/expiring');

function fefoFile() {
  return path.join(process.env.DUMATE_ADMIN_DATA, 'expiring-snapshot.json');
}

// 两启用（一好一坏）+ 一停用；好的账号有 3 个包，剩余>0 的取最早到期
const list = () => [
  { id: 1, name: 'A', nickname: '好号', enabled: true, cookie: 'c1' },
  { id: 2, name: '账号 2', enabled: true, cookie: 'c2' },
  { id: 3, name: 'B', enabled: false, cookie: 'c3' },
];
const quota = async (a) => {
  if (a.id === 1) {
    return {
      ok: true, left: 500, total: 1000, used: 500,
      packages: [
        { kind: 'subscription', left: 100, expire_at: 2000000000000 },
        { kind: 'incremental', left: 0, expire_at: 1500000000000 },   // 用完的包不算临期
        { kind: 'incremental', left: 400, expire_at: 1900000000000 }, // 最早剩余包
      ],
    };
  }
  if (a.id === 2) return { ok: false, error: '登录态过期' };
  return { ok: false, error: '不该被查到' };
};

test('collect：只查启用账号；FEFO 取「剩余>0 的包」的最早到期；失败行带原因', async () => {
  const rows = await br.internals.collect({ list, quota, delay: 0 });
  assert.equal(rows.length, 2);
  const good = rows.find((r) => r.id === 1);
  assert.equal(good.ok, true);
  assert.equal(good.left, 500);
  assert.equal(good.expireNearest, 1900000000000, '用完的包（left=0）不算临期');
  const bad = rows.find((r) => r.id === 2);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, '登录态过期');
  assert.equal(bad.expireNearest, null);
});

test('runOnce：FEFO 快照按账号落盘；失败账号不进 entries', async () => {
  const r = await br.runOnce('manual', { list, quota, delay: 0 });
  assert.equal(r.ok_count, 1);
  assert.equal(r.fail_count, 1);
  assert.equal(r.fefo_wrote, true);
  const snap = JSON.parse(fs.readFileSync(fefoFile(), 'utf8'));
  const acc = snap.channels.dumate.accounts;
  assert.equal(acc['1'], 1900000000000);
  assert.equal(acc['2'], undefined, '查询失败不是「无临期」的证据，不能进 entries');
  assert.equal(snap.channels.dumate.at > 0, true);
});

test('runOnce：失败账号走 keepIds——旧条目保留且 at 不推进', async () => {
  // 预置：账号 2 有一条旧临期记录
  expiringSnap.update('dumate', [{ accountId: 2, nearest: 1800000000000 }], {});
  const r = await br.runOnce('manual', { list, quota, delay: 0 });
  assert.equal(r.fefo_wrote, true);
  const snap = JSON.parse(fs.readFileSync(fefoFile(), 'utf8'));
  assert.equal(snap.channels.dumate.accounts['2'], 1800000000000, '查不到 ≠ 无临期，旧条目保留');
  assert.equal(snap.channels.dumate.at > 0, true);
});

test('runOnce：冷却账号余额>0 自动解冻（复用 keepalive.reconcile，只解硬冷却）', async () => {
  const reenableCalls = [];
  const fakePool = {
    snapshot: () => [
      { id: '1', cooling: true, cooldown_until: Date.now() + 3600000 },
      { id: '2', cooling: true, cooldown_until: Date.now() + 3600000 },
    ],
    noteSuccess() {},
    reenableIfCredits(id, credits) {
      reenableCalls.push([id, credits]);
      return { unfrozen: id === '1' }; // 池语义自己决定（软冷却等不解）
    },
    revive() {},
  };
  const r = await br.runOnce('manual', { list, quota, delay: 0, pool: fakePool });
  assert.deepEqual(reenableCalls, [['1', 500]], '只有余额查到的冷却账号才进解冻判定；余额 500');
  assert.equal(r.unfrozen_count, 1);
  assert.deepEqual(r.unfrozen, [{ uid: '1', remain: 500 }]);
});

test('runOnce：running 互斥', async () => {
  const slow = async () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, left: 1, total: 1, used: 0, packages: [] }), 50));
  const p1 = br.runOnce('manual', { list: () => [{ id: 1, enabled: true }], quota: slow, delay: 0 });
  const p2 = br.runOnce('manual', { list, quota, delay: 0 });
  const r2 = await p2;
  assert.equal(r2.skipped, 'already_running');
  await p1;
});

test('configure / schedule / stop：间隔合法校验 + interval 生命周期', () => {
  assert.throws(() => br.configure({ minutes: 5000 }), /minutes/);
  const s = br.configure({ enabled: true, minutes: 7 });
  assert.equal(s.enabled, true);
  assert.equal(s.interval_active, true);
  const cfgFile = path.join(process.env.DUMATE_ADMIN_DATA, 'balance-refresh.json');
  const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.equal(saved.minutes, 7, '配置落盘，重启自恢复');
  br.stop();
  assert.equal(br.snapshot().interval_active, false);
  br.configure({ enabled: false, minutes: 10 });
});

test('snapshot：未启用时说明文案要点出「FEFO 只靠管理端页面」这个缺口', () => {
  const s = br.snapshot();
  assert.equal(s.enabled, false);
  assert.ok(/管理端/.test(s.note));
});

// ---- 直连通道段（2026-11-08 补）：WorkBuddy 的 FEFO / 护栏快照 ----
//
// 背景：WorkBuddy 的两份快照 TTL 都是 6 小时，写方原来只有管理端 /credits
// （真机上 workbuddy 段的 at 停了 100+ 小时，护栏快照文件从未被创建）。
// 接进本模块复用 keepalive 的 adapter（取数 + 落盘同一份实现），不重写。

function wbAdapter(calls) {
  return {
    channel: 'workbuddy',
    list: () => [{ id: 41, nickname: '甲' }, { id: 42, nickname: '乙' }],
    uid: (a) => `workbuddy:${a.id}`,
    name: (a) => a.nickname,
    refresh: async () => ({ ok: true, skipped: true }),
    balance: async (a) => {
      calls.push(a.id);
      return a.id === 41
        ? { ok: true, remain: 10, precise: 10.5, expireNearest: Date.now() + 86400000 }
        : { ok: false, error: '国际版没有额度接口' };
    },
    persistSnapshots: (rows) => {
      calls.push(['persist', rows.length, rows.filter((r) => r.ok).length]);
      return { fefoWrote: true, guardWrote: true, entries: 1, failed: 1 };
    },
  };
}

test('collectWorkbuddy：串行取余额 + 一次落盘；失败账号也算进总数', async () => {
  const calls = [];
  const out = await br.internals.collectWorkbuddy({ adapter: wbAdapter(calls), delay: 0 });
  assert.deepEqual(calls, [41, 42, ['persist', 2, 1]], '两个账号各查一次，最后统一落盘一次');
  assert.equal(out.accounts, 2);
  assert.equal(out.ok_count, 1);
  assert.equal(out.fail_count, 1);
  assert.equal(out.fefoWrote, true);
  assert.equal(out.rows.find((r) => r.accountId === 41).precise, 10.5, 'precise 透传给落盘层');
});

test('collectWorkbuddy：无可用账号 → null（不落空快照，避免把旧条目清光）', async () => {
  const ad = wbAdapter([]);
  ad.list = () => [];
  assert.equal(await br.internals.collectWorkbuddy({ adapter: ad, delay: 0 }), null);
});

test('collectWorkbuddy：adapter 没有 persistSnapshots → null（可选能力缺失要静默退化）', async () => {
  const ad = wbAdapter([]);
  ad.persistSnapshots = undefined;
  assert.equal(await br.internals.collectWorkbuddy({ adapter: ad, delay: 0 }), null);
});

test('runOnce：直连段失败不拖累主通道结果（单独回执）', async () => {
  const bad = {
    channel: 'workbuddy',
    list: () => [{ id: 51 }],
    uid: () => 'workbuddy:51',
    name: () => '丙',
    refresh: async () => ({ ok: true, skipped: true }),
    balance: async () => ({ ok: false, error: 'boom' }),
    persistSnapshots: () => { throw new Error('落盘炸了'); },
  };
  const r = await br.runOnce('manual', { list, quota, delay: 0, workbuddy: { adapter: bad, delay: 0 } });
  assert.equal(r.ok_count, 1, '主通道结果不受影响');
  assert.ok(r.workbuddy, '直连段要有回执');
  assert.match(r.workbuddy.error, /落盘炸了/, '异常如实报出，不吞');
});

test('runOnce：opts.workbuddy = null 可跳过直连段（老用例 / 单通道场景）', async () => {
  const r = await br.runOnce('manual', { list, quota, delay: 0, workbuddy: null });
  assert.equal(r.workbuddy, null);
});
