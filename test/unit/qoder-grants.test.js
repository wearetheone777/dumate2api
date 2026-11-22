// test/unit/qoder-grants.test.js - Qoder 批次账本与 claimCampaign 新契约（P0-1）
//
// P0-1 背景：claimCampaign 此前不带出 grantId，fromClaim 恒返 ''，
// record 以 grantId 为幂等键拒写——过期提醒自 2026-10-02 起无数据源。
// 这里锁定修复后的契约：**领取结果带 grantId 就必须能落盘**。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const tmp = tmpDir('dumate-qgrants');
process.env.DUMATE_ADMIN_DATA = tmp;

const grants = require('../../src/qoder/grants');
const session = require('../../src/qoder/session');

const ACCOUNT = { id: 7, nickname: '测试号', uid: 'u7' };
const NOW = Date.parse('2026-10-25T01:00:00Z');

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* tmp 清理失败不影响结果 */ }
});

// 修复后 claimCampaign 的返回形状（session.js）：grantId / campaignKey 已带出
function claimShape(over = {}) {
  return {
    ok: true,
    status: 'SUCCEEDED',
    replayed: false,
    grantId: 'g-2026-001',
    campaignKey: 'daily-checkin',
    grantedAt: '2026-10-25T00:59:30Z',
    validityMode: 'RELATIVE_DAYS',
    validityDays: 30,
    amount: 10,
    modelScope: null,
    ...over,
  };
}

test('fromClaim：领取结果带 grantId 时账本记录非空（P0-1 契约）', () => {
  const entry = grants.fromClaim(claimShape(), ACCOUNT, NOW);
  assert.ok(entry, '应产出记录');
  assert.strictEqual(entry.grantId, 'g-2026-001');
  assert.strictEqual(entry.campaignKey, 'daily-checkin');
  assert.strictEqual(entry.accountId, 7);
  assert.strictEqual(entry.amount, 10);
  // 到期 = 服务端领取时刻 + 30 天
  assert.strictEqual(entry.expiresAt, Date.parse('2026-10-25T00:59:30Z') + 30 * 86400000);
});

test('fromClaim：checkin 的 campaignKey 兜底合并（领取响应缺、列表补）', () => {
  // session.checkin 传给 fromClaim 的是 { ...r, campaignKey: r.campaignKey || camp.campaignKey }
  const r = claimShape({ campaignKey: '' });
  const merged = { ...r, campaignKey: r.campaignKey || 'camp-from-list' };
  const entry = grants.fromClaim(merged, ACCOUNT, NOW);
  assert.strictEqual(entry.campaignKey, 'camp-from-list');
});

test('fromClaim：无法确定到期时间时 expiresAt 如实为 null，不编数', () => {
  // 未知有效期形态 → 记录仍保留（grantId/金额还有用），但到期时刻留空
  const entry = grants.fromClaim(claimShape({ validityMode: 'UNKNOWN' }), ACCOUNT, NOW);
  assert.strictEqual(entry.expiresAt, null);
  // 领取失败 / grantedAt 不可解析 → 整条不产出
  assert.strictEqual(grants.fromClaim({ ok: false, error: 'x' }, ACCOUNT, NOW), null);
  assert.strictEqual(grants.fromClaim(claimShape({ grantedAt: 'not-a-date' }), ACCOUNT, NOW), null);
});

test('record：带 grantId 首写成功、同 grantId 幂等拒写（真实文件）', () => {
  const entry = grants.fromClaim(claimShape(), ACCOUNT, NOW);
  assert.strictEqual(grants.record(entry), true, '首写应成功');
  assert.strictEqual(grants.record(entry), false, '同 grantId 不得重复写');
  const rows = grants.readAll();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].grantId, 'g-2026-001');
});

test('record：无 grantId 拒写——这正是 P0-1 期间账本为空的机制', () => {
  const broken = grants.fromClaim(claimShape({ grantId: '' }), ACCOUNT, NOW);
  assert.ok(broken);
  assert.strictEqual(broken.grantId, '');
  assert.strictEqual(grants.record(broken), false);
});

test('expiring：未过期批次按到期升序出现（过期提醒的数据源）', () => {
  const e2 = grants.fromClaim(claimShape({ grantId: 'g-2', validityDays: 60 }), ACCOUNT, NOW);
  grants.record(e2);
  const list = grants.expiring({ now: NOW });
  assert.ok(list.length >= 2);
  assert.strictEqual(list[0].grantId, 'g-2026-001'); // 30 天先到期
  assert.strictEqual(list[1].grantId, 'g-2');
  const soon = grants.expiring({ now: NOW, withinMs: 31 * 86400000 });
  assert.deepStrictEqual(soon.map((r) => r.grantId), ['g-2026-001']);
});

test('claimCampaign 返回契约：源码里必须带出 grantId / campaignKey', () => {
  // 不发网络请求：直接校验 session.js 源码形状（网络层的行为由 verify-* 真机门禁管）。
  // 这条测试的意义是防回归——有人改返回体时若再丢字段，这里先红。
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/qoder/session.js'), 'utf8');
  // 切到 checkin( 带括号：不带的话会先命中 checkinStatus（它在 claimCampaign 之前）
  const body = src.slice(src.indexOf('async function claimCampaign'), src.indexOf('async function checkin('));
  assert.ok(/grantId:\s*d\.grantId \|\| \(d\.benefit && d\.benefit\.grantId\) \|\| ''/.test(body),
    'claimCampaign 返回体缺 grantId 带出（P0-1 回归）');
  assert.ok(/campaignKey:\s*d\.campaignKey \|\| \(d\.benefit && d\.benefit\.campaignKey\) \|\| ''/.test(body),
    'claimCampaign 返回体缺 campaignKey 带出');
});
