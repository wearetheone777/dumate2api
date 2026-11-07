// test/unit/channel-balance.test.js - 跨通道额度总览（P2-10）
//
// 覆盖聚合口径与编排，不打上游：适配器经 opts.adapters 注入。
//   1. 合计只累「已知」数值——余额未知的账号不进合计，但算查询成功
//   2. 失败如实标注——通道挂掉 remaining=null（不是 0）+ error
//   3. 超时被兜住（注入极短超时）
//   4. 缓存：第二次 snapshot 命中 TTL
//   5. Qoder 不限量 / 无账号 / 全部失败 三种边界
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-chanbal-'));
process.env.DUMATE_ADMIN_DATA = TMP;
// 固定 TTL，避免受外部 env 影响
process.env.DUMATE_CHANNEL_BALANCE_TTL_MS = '60000';

const balance = require('../../src/channel-balance');

function row(id) {
  return balance.rowOf(id, '积分', '');
}

test('fillFromResults：合计只累已知数值，未知余额算「成功但不参与合计」', () => {
  const r = balance.fillFromResults(row('dumate'), [
    { ok: true, name: 'a', remain: 100.456 },
    { ok: true, name: 'b', remain: null },      // 查询成功但无积分口径（如国际账号）
    { ok: true, name: 'c', remain: 49.544 },
  ]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.accounts.total, 3);
  assert.strictEqual(r.accounts.ok, 3);
  assert.strictEqual(r.accounts.fail, 0);
  assert.strictEqual(r.remaining, 150, '100.456 + 49.544 四舍五入到 150');
});

test('fillFromResults：全部失败 → remaining=null 不是 0，带 error 与失败明细', () => {
  const r = balance.fillFromResults(row('qoder'), [
    { ok: false, name: 'a', error: 'HTTP 500' },
    { ok: false, name: 'b', error: '超时' },
  ]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.remaining, null, '取不到时给 null——0 会被读成「用完了」');
  assert.strictEqual(r.error, '全部账号查询失败');
  assert.strictEqual(r.failed.length, 2);
  assert.ok(r.failed.some((f) => f.name === 'a' && f.error === 'HTTP 500'));
});

test('fillFromResults：通道没有账号 → 明确报「没有账号」，不是失败', () => {
  const r = balance.fillFromResults(row('traework'), []);
  assert.strictEqual(r.remaining, null);
  assert.strictEqual(r.error, '通道没有账号');
});

test('snapshot：单通道抛错被隔离，其余通道照常出数；超时行带明确文案', async () => {
  balance.resetCacheForTest();
  const rows = {
    dumate: async () => ({ ...row('dumate'), ok: true, remaining: 12, accounts: { total: 1, ok: 1, fail: 0 } }),
    qwenwork: async () => { throw new Error('boom'); },
    traework: () => new Promise(() => {}), // 永不 resolve → 超时分支
    qoder: async () => balance.fillFromResults(row('qoder'), [{ ok: true, name: 'q', remain: 3 }]),
    workbuddy: async () => balance.fillFromResults(row('workbuddy'), [
      { ok: true, name: 'w', remain: null, unsupported: true },
    ]),
  };
  const s = await balance.snapshot({ force: true, adapters: rows, rowTimeoutMs: 50 });
  assert.strictEqual(s.cached, false);
  assert.strictEqual(s.channels.length, 5);

  const byId = Object.fromEntries(s.channels.map((c) => [c.id, c]));
  assert.strictEqual(byId.dumate.remaining, 12);
  assert.strictEqual(byId.qwenwork.ok, false);
  assert.strictEqual(byId.qwenwork.remaining, null, '抛错的通道不填 0');
  assert.match(byId.qwenwork.error, /boom/);
  assert.match(byId.traework.error, /超时/);
  assert.strictEqual(byId.qoder.remaining, 3);
  // WorkBuddy 只有「无积分口径」账号：查询成功但 remaining 为 null
  assert.strictEqual(byId.workbuddy.ok, true);
  assert.strictEqual(byId.workbuddy.remaining, null);
});

test('snapshot：第二次调用命中 TTL 缓存，force 绕过', async () => {
  balance.resetCacheForTest();
  let calls = 0;
  const adapter = async () => {
    calls++;
    return { ...row('dumate'), ok: true, remaining: 1, accounts: { total: 1, ok: 1, fail: 0 } };
  };
  const adapters = {
    dumate: adapter, qwenwork: adapter, traework: adapter, qoder: adapter, workbuddy: adapter,
  };
  const a = await balance.snapshot({ force: true, adapters });
  assert.strictEqual(a.cached, false);
  const b = await balance.snapshot({ adapters });
  assert.strictEqual(b.cached, true, 'TTL 内命中缓存');
  assert.strictEqual(calls, 5, '第二次没有再调适配器');
  const c = await balance.snapshot({ force: true, adapters });
  assert.strictEqual(c.cached, false, 'force 绕过缓存');
  assert.strictEqual(calls, 10);
});

test('Qoder 不限量：unlimited 为 true 且 remaining 保持 null', async () => {
  balance.resetCacheForTest();
  const qoderAdapter = async () => {
    const r = balance.fillFromResults(row('qoder'), [
      { ok: true, name: 'team', remain: null, unlimited: true },
    ]);
    r.unlimited = true;
    return r;
  };
  const s = await balance.snapshot({
    force: true,
    rowTimeoutMs: 50,
    adapters: {
      dumate: async () => row('dumate'),
      qwenwork: async () => row('qwenwork'),
      traework: async () => row('traework'),
      qoder: qoderAdapter,
      workbuddy: async () => row('workbuddy'),
    },
  });
  const q = s.channels.find((c) => c.id === 'qoder');
  assert.strictEqual(q.unlimited, true);
  assert.strictEqual(q.remaining, null, '不限量不是有限数字，不能加进合计');
});
