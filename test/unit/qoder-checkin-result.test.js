// test/unit/qoder-checkin-result.test.js - P0-5 签到反馈三态修正
//
// 锁住三条口径：
//   1. session.checkinOutcome 区分 claimed / already / none_available /
//      exhausted / same_person / blocked / error
//   2. 领取响应成功但 gained<=0 不记成功（避免「零积分显示领取成功」）
//   3. checkinAndSave 只用双证据写 lastCheckin 与账本 claim 行
//
// 运行：node --test test/unit/qoder-checkin-result.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-qoder-checkin-result');
process.env.DUMATE_ADMIN_DATA = TMP;

const session = require('../../src/qoder/session');
const auth = require('../../src/qoder/auth');
const qoder = require('../../src/qoder/index');
const ledger = require('../../src/checkin-ledger');

const ACCOUNT = { id: 501, uid: 'uid-501', nickname: '签到账号', region: 'cn', accessToken: 'at', refreshToken: 'rt', enabled: true };

test('outcome：领取成功 + 实测正数 = claimed', () => {
  assert.equal(session.checkinOutcome({
    ok: true, gained: 100, claimed: [{ ok: true, verification: 'claimed' }],
  }), 'claimed');
});

test('outcome：无可领活动 = already', () => {
  assert.equal(session.checkinOutcome({ ok: true, alreadyChecked: true, claimed: [], gained: 0 }), 'already');
});

test('outcome：领取成功但 gained=0 = none_available（不记成功）', () => {
  assert.equal(session.checkinOutcome({
    ok: true, gained: 0, claimed: [{ ok: true, verification: 'claimed' }],
  }), 'none_available');
});

test('outcome：同人 / 耗尽 / BLOCKED / 错误各自归类', () => {
  assert.equal(session.checkinOutcome({
    ok: true, gained: 0, claimed: [{ ok: true, verification: 'same_person' }],
  }), 'same_person');
  assert.equal(session.checkinOutcome({
    ok: true, gained: 0, claimed: [{ ok: false, error: 'EXHAUSTED' }],
  }), 'exhausted');
  assert.equal(session.checkinOutcome({
    ok: true, gained: 0, claimed: [{ ok: false, error: 'BLOCKED' }],
  }), 'blocked');
  assert.equal(session.checkinOutcome({ ok: false, error: 'HTTP 500' }), 'error');
});

test('outcome：gained 缺失（上游没给余额）不猜成失败', () => {
  assert.equal(session.checkinOutcome({ ok: true, claimed: [{ ok: true }] }), 'claimed');
});

test('checkinAndSave：gained<=0 不写 lastCheckin 与 claim 账本', async () => {
  auth.list = () => [{ ...ACCOUNT }];
  auth.get = (id) => (id === ACCOUNT.id ? { ...ACCOUNT } : null);
  auth.findUsable = () => [{ ...ACCOUNT }];
  auth.preferred = () => ({ ...ACCOUNT });
  auth.patch = () => {};
  auth.save = () => {};
  session.ensureAccount = async (store, a) => a;
  session.checkin = async () => ({
    ok: true, gained: 0, alreadyChecked: false,
    claimed: [{ ok: true, campaignId: 'c1', verification: 'claimed' }],
  });

  const before = ledger.readAll().filter((x) => x.channel === 'qoder' && x.account_id === ACCOUNT.id).length;
  const r = await qoder.checkin({ ...ACCOUNT });
  assert.equal(r.outcome, 'none_available');
  assert.equal(r.gained, null);
  assert.equal(r.measuredGained, 0, '实测差值如实带出，不能抹成 null');
  const after = ledger.readAll().filter((x) => x.channel === 'qoder' && x.account_id === ACCOUNT.id).length;
  assert.equal(after, before, '零到账不写签到账本');
});

test('checkinAndSave：已领过写 already，但不记 claim 积分', async () => {
  session.checkin = async () => ({ ok: true, gained: 0, alreadyChecked: true, claimed: [] });
  const before = ledger.readAll().filter((x) => x.channel === 'qoder' && x.account_id === ACCOUNT.id).length;
  const r = await qoder.checkin({ ...ACCOUNT });
  assert.equal(r.outcome, 'already');
  const rows = ledger.readAll().filter((x) => x.channel === 'qoder' && x.account_id === ACCOUNT.id);
  assert.equal(rows.length, before + 1);
  assert.equal(rows[rows.length - 1].source, 'already');
  assert.equal(rows[rows.length - 1].credits, null);
});
