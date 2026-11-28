// expiring.view()（批次二十一角标读方）——与 accountIds 同判据的自证 + 接线。
// expiring.js 的文件路径每次读 env，用 DUMATE_EXPIRING_SNAPSHOT_FILE 钉到临时
// 目录即可，无需动 store。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const expiring = require('../../src/expiring');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'd2a-expview-')), 'expiring-snapshot.json');
}

const NOW = 1700000000000;
const DAY = 86400000;

test('view：窗口内未过期才进门；按最早到期升序；daysLeft 向上取整', () => {
  const f = tmpFile();
  process.env.DUMATE_EXPIRING_SNAPSHOT_FILE = f;
  expiring.update('traework', [
    { accountId: 1, nearest: NOW + 3 * DAY },
    { accountId: 2, nearest: NOW + 20 * DAY },           // 超出 7 天窗口 → 不进门
    { accountId: 3, nearest: NOW - DAY },                // 已过期 → 不进门
    { accountId: 4, nearest: NOW + 1.5 * DAY },          // 向上取整 = 2 天
    { accountId: 5, nearest: NOW + DAY },
  ], { now: NOW });
  const v = expiring.view('traework', NOW);
  assert.ok(v.fresh);
  assert.strictEqual(v.windowDays, 7);
  assert.deepStrictEqual(v.accounts.map((a) => a.id), ['5', '4', '1'], '过期/窗外不进门，按 nearest 升序');
  assert.strictEqual(v.accounts[0].daysLeft, 1);
  assert.strictEqual(v.accounts[1].daysLeft, 2, '1.5 天向上取整');
  assert.strictEqual(v.accounts[2].daysLeft, 3);
  // 与网关 accountIds 同判据：集合一致
  const ids = [...expiring.accountIds('traework', NOW)].sort();
  assert.deepStrictEqual(ids, ['1', '4', '5']);
});

test('view：陈旧快照 fresh=false 但条目照常返回（展示与否由调用方决定）；无快照窗口如实空', () => {
  const f = tmpFile();
  process.env.DUMATE_EXPIRING_SNAPSHOT_FILE = f;
  expiring.update('dumate', [{ accountId: 9, nearest: NOW + 10 * DAY }], { now: NOW });
  // dumate 窗口 30 天：10 天后仍在窗口内
  const v = expiring.view('dumate', NOW + 7 * 3600000 + 1); // 超过 6h TTL
  assert.strictEqual(v.fresh, false);
  assert.strictEqual(v.accounts.length, 1, '条目照常返回，界面据此隐藏');
  assert.strictEqual(expiring.view('dumate', NOW).windowDays, 30);
  // 没有快照的通道：空明细 + fresh=false，不编数据
  process.env.DUMATE_EXPIRING_SNAPSHOT_FILE = path.join(path.dirname(f), 'missing.json');
  const none = expiring.view('qwenwork', NOW);
  assert.strictEqual(none.fresh, false);
  assert.deepStrictEqual(none.accounts, []);
  // qoder 没有 FEFO 窗口（不在 DEFAULT_WINDOW_DAYS）→ windowDays 0
  assert.strictEqual(expiring.view('qoder', NOW).windowDays, 0);
});

test('接线：只读端点挂载 + qoder credits 行带 expiring* + 四视图接角标', () => {
  process.env.DUMATE_EXPIRING_SNAPSHOT_FILE = tmpFile();
  const routes = require('../../src/admin/routes/expiring').routes;
  assert.ok(routes.some((r) => r.path === ''), '/expiring 只读端点已注册');
  assert.deepStrictEqual(require('../../src/admin/routes/expiring').CHANNELS, ['dumate', 'qwenwork', 'traework', 'workbuddy']);
  const serverSrc = fs.readFileSync(path.join(__dirname, '../../src/admin/server.js'), 'utf8');
  assert.match(serverSrc, /'\/expiring', require\('\.\/routes\/expiring'\)/, 'server.js 挂载');
  const qoder = fs.readFileSync(path.join(__dirname, '../../src/admin/routes/qoder.js'), 'utf8');
  assert.match(qoder, /r\.expiringNearest = /, 'qoder credits 行带逐账号临期明细');
  for (const [file, channel] of [
    ['web/src/components/qwenwork/QwenworkAccounts.vue', "useExpiring('qwenwork')"],
    ['web/src/components/traework/TraeworkAccounts.vue', "useExpiring('traework')"],
    ['web/src/components/workbuddy/WorkBuddyAccounts.vue', "useExpiring('workbuddy')"],
    ['web/src/views/WebAccountsView.vue', "useExpiring('dumate')"],
    ['web/src/components/qoder/QoderAccounts.vue', 'expiringOf(a.id)'],
  ]) {
    const src = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    assert.ok(src.includes(channel), `${file} 接入角标（${channel}）`);
  }
});
