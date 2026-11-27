// test/unit/qoder-token-refresh.test.js - P1-1 后台 Token 提前续期
//
// 口径：
//   1. 默认关闭；只有 DUMATE_QODER_TOKEN_PREREFRESH=1 才换票
//   2. 每轮只扫一个账号，按 id 轮转；到期窗 24h 内才换（沿用 needsRefresh）
//   3. 成功写回 patch + tokenRefresh 状态；失败只写状态，不写 lastError、不惩罚账号
//
// 运行：node --test test/unit/qoder-token-refresh.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-qoder-token-refresh');
process.env.DUMATE_ADMIN_DATA = TMP;
process.env.DUMATE_POOL_STATE = path.join(TMP, 'pool-state.json');
delete process.env.DUMATE_QODER_TOKEN_PREREFRESH;

const balanceRefresh = require('../../src/balance-refresh');
const { prerefreshQoderToken } = balanceRefresh.internals;

const A = (id, expiresAt) => ({
  id, uid: `uid-${id}`, nickname: `号${id}`, region: 'cn', enabled: true,
  accessToken: `dt-${id}`, refreshToken: `drt-${id}`, expiresAt,
});
const SOON = Date.now() + 60 * 60 * 1000;
const LATER = Date.now() + 72 * 60 * 60 * 1000;

test('默认关闭：不换票、不扫账号', async () => {
  balanceRefresh.state.qoderRefreshCursor = 0;
  const r = await prerefreshQoderToken({ list: () => [A(1, SOON)], exchange: async () => { throw new Error('不该调用'); } });
  assert.deepEqual(r, { enabled: false, skipped: 'disabled' });
});

test('开启后：24h 内到期才换票，24h 外跳过', async () => {
  process.env.DUMATE_QODER_TOKEN_PREREFRESH = '1';
  balanceRefresh.state.qoderRefreshCursor = 0;
  let called = 0;
  const r = await prerefreshQoderToken({
    list: () => [A(1, SOON)],
    exchange: async () => { called++; return { ok: true, patch: { accessToken: 'new', expiresAt: LATER } }; },
    patch: () => {},
  });
  assert.equal(r.refreshed, true);
  assert.equal(called, 1);

  const r2 = await prerefreshQoderToken({
    list: () => [A(2, LATER)],
    exchange: async () => { called++; return { ok: true, patch: {} }; },
    patch: () => {},
  });
  assert.equal(r2.reason, 'not_due');
  assert.equal(called, 1);
  delete process.env.DUMATE_QODER_TOKEN_PREREFRESH;
});

test('轮转：每轮只扫一个账号，按 id 排序且游标回绕', async () => {
  process.env.DUMATE_QODER_TOKEN_PREREFRESH = '1';
  balanceRefresh.state.qoderRefreshCursor = 0;
  const scanned = [];
  const opts = {
    list: () => [A(3, SOON), A(1, SOON), A(2, SOON)],
    exchange: async (a) => ({ ok: true, patch: { accessToken: `new-${a.id}` } }),
    patch: () => {},
  };
  for (let i = 0; i < 3; i++) scanned.push((await prerefreshQoderToken(opts)).scanned);
  assert.deepEqual(scanned, [1, 2, 3]);
  assert.equal((await prerefreshQoderToken(opts)).scanned, 1);
  delete process.env.DUMATE_QODER_TOKEN_PREREFRESH;
});

test('成功写回 patch 与 tokenRefresh 状态（不写 lastError）', async () => {
  process.env.DUMATE_QODER_TOKEN_PREREFRESH = '1';
  balanceRefresh.state.qoderRefreshCursor = 0;
  const patches = [];
  const r = await prerefreshQoderToken({
    list: () => [A(1, SOON)],
    exchange: async () => ({ ok: true, patch: { accessToken: 'new', refreshToken: 'newrt', expiresAt: LATER } }),
    patch: (id, p) => { patches.push({ id, p }); },
  });
  assert.equal(r.refreshed, true);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].p.accessToken, 'new');
  assert.equal(patches[0].p.tokenRefresh.ok, true);
  assert.equal(patches[0].p.lastError, undefined);
  delete process.env.DUMATE_QODER_TOKEN_PREREFRESH;
});

test('失败只记 tokenRefresh 状态，不写 lastError、不抛', async () => {
  process.env.DUMATE_QODER_TOKEN_PREREFRESH = '1';
  balanceRefresh.state.qoderRefreshCursor = 0;
  const patches = [];
  const r = await prerefreshQoderToken({
    list: () => [A(1, SOON)],
    exchange: async () => ({ ok: false, error: 'refresh token 已失效' }),
    patch: (id, p) => { patches.push({ id, p }); },
  });
  assert.equal(r.refreshed, false);
  assert.equal(r.reason, 'failed');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].p.tokenRefresh.ok, false);
  assert.match(patches[0].p.tokenRefresh.error, /失效/);
  assert.equal(patches[0].p.lastError, undefined);
  delete process.env.DUMATE_QODER_TOKEN_PREREFRESH;
});

test('无 refreshToken 的账号不进轮转池', async () => {
  process.env.DUMATE_QODER_TOKEN_PREREFRESH = '1';
  const r = await prerefreshQoderToken({ list: () => [{ ...A(1, SOON), refreshToken: '' }] });
  assert.equal(r.skipped, 'no_accounts');
  delete process.env.DUMATE_QODER_TOKEN_PREREFRESH;
});
