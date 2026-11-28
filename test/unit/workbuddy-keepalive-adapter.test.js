// test/unit/workbuddy-keepalive-adapter.test.js - keepalive 的 WorkBuddy adapter
//
// 背景：`docs/CHANNEL-WORKBUDDY.md` 第 9 条早就写了「keepalive 加 workbuddy
// adapter（refresh/balance/checkin）」，但 `src/keepalive.js` 的 builtinAdapters
// 里一直没有它——文档与实现漂移。本批补的是 refresh + balance，**故意不补
// checkin**（签到归 `workbuddy/autocheckin.js`，两边都签会把上游请求翻倍）。
//
// 锁住：
//   1. 四个 adapter 之外多了 workbuddy，uid 键位是 `workbuddy:<id>`（与池一致）
//   2. refresh：**每轮必刷**（P1-3，misakano #296 上游提前清 session）+ 1h 最小间隔；
//      已判退场（refreshRetiredAt）→ skipped 不白撞
//   3. refresh 被明确拒绝 → keepalive 路径也判废（refreshRetiredAt）；
//      AT 还有 >7 天寿命却换不动票 → 早死观测（refresh_died_early）
//   4. balance：国际版如实 null（不报 0）；精确余额优先；失败如实 error
//   5. **没有 checkin 方法**（签到只有一个排程）
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
    // P1-3 每轮必刷：AT 还有 10 天寿命也刷（上游提前清 session，等窗口就晚了）
    assert.strictEqual(refresh[0].skipped, false, '每轮必刷：10 天寿命也要续（misakano #296）');
    assert.strictEqual(refresh[0].ok, true);
    assert.strictEqual(refresh[0].at_days_left, 20, 'AT 倒计时按 patch 后的 expiresAt 算（20 天）');

    // 第二轮（1h 内）：最小间隔生效，不再打换票端点
    const r2 = await keepalive.runOnce('manual', {
      per_account_delay_ms: 0, sem_cap: 1, checkin: false, pool: null,
    });
    const refresh2 = (r2.results || []).filter((x) => x.channel === 'workbuddy');
    assert.strictEqual(refresh2.length, 1);
    assert.strictEqual(refresh2[0].skipped, true, '1h 最小间隔：刚刷过不再撞换票端点');
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

test('P1-3：refresh 被明确拒绝 → keepalive 路径也判废（refreshRetiredAt）', async () => {
  resetAccounts();
  wbAuth.upsert({
    uid: 'ka-retire', region: 'cn', accessToken: 'at', refreshToken: 'rt',
    expiresAt: Date.now() + 10 * 86400000, enabled: true,
  });
  const origExchange = wbAuth.exchange;
  wbAuth.exchange = async () => ({ ok: false, error: '刷新失败 HTTP 400: Offline user session not found' });
  try {
    const r = await keepalive.runOnce('manual', {
      per_account_delay_ms: 0, sem_cap: 1, checkin: false, pool: null,
    });
    const refresh = (r.results || []).filter((x) => x.channel === 'workbuddy');
    assert.strictEqual(refresh.length, 1);
    assert.strictEqual(refresh[0].ok, false);
    assert.strictEqual(refresh[0].retired, true, '明确拒绝 → 判废标号');
    const cur = wbAuth.get(wbAuth.findUsable()[0].id);
    assert.ok(cur.refreshRetiredAt, 'refreshRetiredAt 必须落盘（send 层之外的第二条判废路径）');
  } finally {
    wbAuth.exchange = origExchange;
  }
});

test('P1-3：AT 还远（>7 天）却换不动票 → 早死观测（refresh_died_early）', async () => {
  resetAccounts();
  wbAuth.upsert({
    uid: 'ka-early', region: 'cn', accessToken: 'at', refreshToken: 'rt',
    expiresAt: Date.now() + 10 * 86400000, enabled: true,
  });
  const origExchange = wbAuth.exchange;
  wbAuth.exchange = async () => ({ ok: false, error: '刷新失败 HTTP 400: invalid_grant' });
  try {
    const r = await keepalive.runOnce('manual', {
      per_account_delay_ms: 0, sem_cap: 1, checkin: false, pool: null,
    });
    const refresh = (r.results || []).filter((x) => x.channel === 'workbuddy');
    assert.strictEqual(refresh[0].refresh_died_early, true, 'misakano #296：AT 有 10 天寿命却换不动票');
    assert.ok(/早死/.test(refresh[0].error), `error 文案要点破早死：${refresh[0].error}`);
    assert.ok(/10 天/.test(refresh[0].error), '文案带 AT 剩余天数');
  } finally {
    wbAuth.exchange = origExchange;
  }
});

test('P1-3：已判退场（refreshRetiredAt）→ skipped 不再白撞换票端点', async () => {
  resetAccounts();
  wbAuth.upsert({
    uid: 'ka-dead', region: 'cn', accessToken: 'at', refreshToken: 'rt',
    expiresAt: Date.now() + 10 * 86400000, enabled: true,
  });
  // upsert 带 refreshToken 会清退场标记（重新登录解废的既有规则）——
  // 这里模拟「已退场」必须用 patch
  wbAuth.patch(wbAuth.findUsable()[0].id, { refreshRetiredAt: Date.now() });
  let called = 0;
  const origExchange = wbAuth.exchange;
  wbAuth.exchange = async () => { called++; return { ok: false, error: 'x' }; };
  const origCredits = wbBilling.fetchCredits;
  wbBilling.fetchCredits = async () => ({ ok: true, total: 5, totalPrecise: 5 });
  try {
    const r = await keepalive.runOnce('manual', {
      per_account_delay_ms: 0, sem_cap: 1, checkin: false, pool: null,
    });
    const refresh = (r.results || []).filter((x) => x.channel === 'workbuddy');
    assert.strictEqual(refresh[0].skipped, true, '退场号不白撞换票端点');
    assert.strictEqual(refresh[0].retired, true);
    assert.strictEqual(called, 0, 'exchange 一次都不该被调');
  } finally {
    wbAuth.exchange = origExchange;
    wbBilling.fetchCredits = origCredits;
  }
});

test('P1-3：认不出措辞的换票失败不判废（网络抖不误标）', async () => {
  resetAccounts();
  wbAuth.upsert({
    uid: 'ka-noise', region: 'cn', accessToken: 'at', refreshToken: 'rt',
    expiresAt: Date.now() + 10 * 86400000, enabled: true,
  });
  const origExchange = wbAuth.exchange;
  wbAuth.exchange = async () => ({ ok: false, error: '刷新失败 HTTP 502: upstream error' });
  try {
    const r = await keepalive.runOnce('manual', {
      per_account_delay_ms: 0, sem_cap: 1, checkin: false, pool: null,
    });
    const refresh = (r.results || []).filter((x) => x.channel === 'workbuddy');
    assert.strictEqual(refresh[0].retired, false, '认不出拒绝措辞 → 不标退场（行字段归一成 boolean）');
    const cur = wbAuth.get(wbAuth.findUsable()[0].id);
    assert.ok(!cur.refreshRetiredAt, '5xx/网络抖绝不标退场');
  } finally {
    wbAuth.exchange = origExchange;
  }
});
