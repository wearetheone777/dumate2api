// test/unit/workbuddy-keepalive-adapter.test.js - keepalive 的 WorkBuddy adapter
//
// 背景：`docs/CHANNEL-WORKBUDDY.md` 第 9 条早就写了「keepalive 加 workbuddy
// adapter（refresh/balance/checkin）」，但 `src/keepalive.js` 的 builtinAdapters
// 里一直没有它——文档与实现漂移。本批补的是 refresh + balance，**故意不补
// checkin**（签到归 `workbuddy/autocheckin.js`，两边都签会把上游请求翻倍）。
//
// 锁住：
//   1. 四个 adapter 之外多了 workbuddy，uid 键位是 `workbuddy:<id>`（与池一致）
//   2. refresh：未到期 → skipped（不打上游）；到期 → 走 auth.exchange 并落盘
//   3. balance：国际版如实 null（不报 0）；精确余额优先；失败如实 error
//   4. **没有 checkin 方法**（签到只有一个排程）
//
// 运行：node --test test/unit/workbuddy-keepalive-adapter.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-wb-ka');
process.env.DUMATE_ADMIN_DATA = TMP;

const keepalive = require('../../src/keepalive');
const wbAuth = require('../../src/workbuddy/auth');
const wbBilling = require('../../src/workbuddy/billing');

// builtinAdapters 没导出（这是刻意的：它是内部实现），所以断言走真实入口
// `keepalive.runOnce()`——比导出内部函数更接近生产用法。每轮注入 pool:null
// （stub 池）与 per_account_delay_ms:0，避免打到真实上游与真池状态文件。
function resetAccounts() {
  const data = wbAuth.load();
  data.accounts = [];
  wbAuth.save(data);
}

test('keepalive 的 builtinAdapters 含 workbuddy（uid 键位 workbuddy:<id>）', async () => {
  resetAccounts();
  wbAuth.upsert({
    uid: 'ka-1', region: 'cn', accessToken: 'at', refreshToken: 'rt',
    expiresAt: Date.now() + 10 * 86400000, enabled: true,
  });
  // 打桩：exchange 不真打上游；fetchCredits 返回精确余额
  const origExchange = wbAuth.exchange;
  const origCredits = wbBilling.fetchCredits;
  wbAuth.exchange = async () => ({ ok: true, patch: { accessToken: 'at2', expiresAt: Date.now() + 20 * 86400000 } });
  wbBilling.fetchCredits = async () => ({ ok: true, total: 8, totalPrecise: 8.75, packages: [] });
  try {
    const r = await keepalive.runOnce('manual', {
      per_account_delay_ms: 0, sem_cap: 1, checkin: false, pool: null,
    });
    const rows = (r.balance_results || []).filter((x) => x.channel === 'workbuddy');
    assert.strictEqual(rows.length, 1, 'workbuddy 账号应出现在余额阶段');
    assert.strictEqual(rows[0].uid, `workbuddy:${rows[0].uid.split(':')[1]}`);
    assert.ok(rows[0].uid.startsWith('workbuddy:'), `uid 键位应是 workbuddy:<id>，实际 ${rows[0].uid}`);
    assert.strictEqual(rows[0].remain, 8.75, '精确余额优先（整数是 floor）');
    assert.strictEqual(rows[0].ok, true);

    const refresh = (r.results || []).filter((x) => x.channel === 'workbuddy');
    assert.strictEqual(refresh.length, 1);
    assert.strictEqual(refresh[0].skipped, true, 'token 还有 10 天，不该打刷新端点');
  } finally {
    wbAuth.exchange = origExchange;
    wbBilling.fetchCredits = origCredits;
  }
});

test('workbuddy adapter 的 balance：国际版没有额度接口 → remain null（不报 0）', async () => {
  resetAccounts();
  wbAuth.upsert({
    uid: 'ka-intl', region: 'global', accessToken: 'at', refreshToken: 'rt',
    expiresAt: Date.now() + 10 * 86400000, enabled: true,
  });
  const r = await keepalive.runOnce('manual', {
    per_account_delay_ms: 0, sem_cap: 1, checkin: false, pool: null,
  });
  const rows = (r.balance_results || []).filter((x) => x.channel === 'workbuddy');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].remain, null, '国际版查不到余额 → null，绝不能是 0');
  assert.strictEqual(rows[0].ok, false);
  assert.ok(rows[0].error, '失败要带原因（界面据此显示「不支持」而不是「用完了」）');
});

test('workbuddy adapter 没有 checkin 方法（签到只有一个排程）', async () => {
  resetAccounts();
  wbAuth.upsert({
    uid: 'ka-2', region: 'cn', accessToken: 'at', refreshToken: 'rt',
    expiresAt: Date.now() + 10 * 86400000, enabled: true,
  });
  const origCredits = wbBilling.fetchCredits;
  wbBilling.fetchCredits = async () => ({ ok: true, total: 5, totalPrecise: 5 });
  try {
    const r = await keepalive.runOnce('manual', {
      per_account_delay_ms: 0, sem_cap: 1, checkin: true, pool: null,
    });
    // checkin_results 只收「声明了 checkin 的 adapter」——workbuddy 不该在里面
    const wbCheckins = (r.checkin_results || []).filter((x) => x.channel === 'workbuddy');
    assert.deepStrictEqual(wbCheckins, [], 'keepalive 不该签 WorkBuddy（归 autocheckin）');
  } finally {
    wbBilling.fetchCredits = origCredits;
  }
});
