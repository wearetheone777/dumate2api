// test/verify-qoder-grants.js - Qoder 积分批次账本的离线验证
//
// 不依赖网络与运行中的服务。覆盖：
//   - fromClaim：从领取响应推导到期时刻（RELATIVE_DAYS / 绝对时间 / 缺字段）
//   - record：幂等（同 grantId 不重复写）
//   - expiring / expired：时间窗过滤、账号过滤、边界（正好到期）
//   - 数据缺口：上游不给逐批余额，amount 是**领取额**不是剩余额
const fs = require('fs');
const os = require('os');
const path = require('path');

// 用临时数据目录，避免污染真实账本
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-grants-'));
process.env.DUMATE_ADMIN_DATA = TMP;

const grants = require('../src/qoder/grants');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`[PASS] ${label}`); }
  catch (e) { failures++; console.log(`[FAIL] ${label} — ${e.message}`); }
}
const assert = require('assert');

const NOW = Date.parse('2026-10-02T12:00:00Z');
const acc = { id: 1, nickname: '测试账号', uid: 'uid-1' };

console.log('== fromClaim：推导到期时刻 ==');

check('RELATIVE_DAYS 30 天', () => {
  const r = {
    ok: true, grantId: 'g1', amount: 100, campaignKey: 'act-1',
    grantedAt: '2026-10-02T00:00:00Z', validityMode: 'RELATIVE_DAYS', validityDays: 30,
  };
  const g = grants.fromClaim(r, acc, NOW);
  assert.strictEqual(g.grantId, 'g1');
  assert.strictEqual(g.amount, 100);
  const granted = Date.parse('2026-10-02T00:00:00Z');
  assert.strictEqual(g.expiresAt, granted + 30 * 86400000);
});

check('缺 grantedAt 时用本地时间兜底（不报错）', () => {
  const r = { ok: true, grantId: 'g2', amount: 50, validityMode: 'RELATIVE_DAYS', validityDays: 30 };
  const g = grants.fromClaim(r, acc, NOW);
  assert.strictEqual(g.grantedAt, NOW);
  assert.strictEqual(g.expiresAt, NOW + 30 * 86400000);
});

check('有效期字段缺失 → expiresAt 为 null（不编一个假的）', () => {
  const r = { ok: true, grantId: 'g3', amount: 50, grantedAt: '2026-10-02T00:00:00Z', validityMode: '', validityDays: null };
  const g = grants.fromClaim(r, acc, NOW);
  assert.strictEqual(g.expiresAt, null);
});

check('领取失败（ok=false）→ 不产记录', () => {
  assert.strictEqual(grants.fromClaim({ ok: false }, acc, NOW), null);
});

check('amount 是**领取额**（上游不给剩余额，如实标注）', () => {
  const r = { ok: true, grantId: 'g4', amount: 100, grantedAt: '2026-10-02T00:00:00Z', validityMode: 'RELATIVE_DAYS', validityDays: 30 };
  const g = grants.fromClaim(r, acc, NOW);
  assert.strictEqual(g.amount, 100);
  // 记录里没有「remaining」这种字段——不编造
  assert.strictEqual(g.remaining, undefined);
});

console.log('');
console.log('== record：幂等 ==');

check('首次写入返回 true', () => {
  const g = grants.fromClaim({ ok: true, grantId: 'dup-1', amount: 10, grantedAt: '2026-10-02T00:00:00Z', validityMode: 'RELATIVE_DAYS', validityDays: 30 }, acc, NOW);
  assert.strictEqual(grants.record(g), true);
});
check('同 grantId 再写返回 false（不重复）', () => {
  const g = grants.fromClaim({ ok: true, grantId: 'dup-1', amount: 10, grantedAt: '2026-10-02T00:00:00Z', validityMode: 'RELATIVE_DAYS', validityDays: 30 }, acc, NOW);
  assert.strictEqual(grants.record(g), false);
  assert.strictEqual(grants.readAll().filter((r) => r.grantId === 'dup-1').length, 1);
});
check('无 grantId 不写（无法幂等，宁可不记）', () => {
  assert.strictEqual(grants.record({ amount: 10 }), false);
});

console.log('');
console.log('== expiring / expired ==');

// 清空后灌入可控数据
const f = grants.filePath();
try { fs.unlinkSync(f); } catch (e) {}
const mk = (id, daysFromNow, amount, accountId = 1) => grants.record({
  grantId: id, accountId, accountName: 'A' + accountId, amount,
  grantedAt: NOW, expiresAt: NOW + daysFromNow * 86400000, ts: NOW,
});

check('时间窗过滤：7 天内的只返回 7 天内的', () => {
  mk('a-3d', 3, 100);
  mk('a-10d', 10, 200);
  const r = grants.expiring({ withinMs: 7 * 86400000, now: NOW });
  assert.deepStrictEqual(r.map((x) => x.grantId), ['a-3d']);
});
check('按到期时间升序', () => {
  mk('a-1d', 1, 50);
  const r = grants.expiring({ withinMs: 30 * 86400000, now: NOW });
  assert.deepStrictEqual(r.map((x) => x.grantId), ['a-1d', 'a-3d', 'a-10d']);
});
check('已过期的**不**算「即将过期」', () => {
  mk('a-past', -1, 999);
  const r = grants.expiring({ withinMs: 30 * 86400000, now: NOW });
  assert.ok(!r.some((x) => x.grantId === 'a-past'));
});
check('已过期的单独能查到（排查用）', () => {
  const r = grants.expired({ now: NOW });
  assert.deepStrictEqual(r.map((x) => x.grantId), ['a-past']);
});
check('账号过滤', () => {
  mk('b-2d', 2, 300, 2);
  const r = grants.expiring({ withinMs: 30 * 86400000, accountId: 2, now: NOW });
  assert.deepStrictEqual(r.map((x) => x.grantId), ['b-2d']);
});
check('正好到期的边界：<= now 算已过期', () => {
  mk('a-now', 0, 77);
  const soon = grants.expiring({ withinMs: 30 * 86400000, now: NOW });
  assert.ok(!soon.some((x) => x.grantId === 'a-now'), '正好到期不该出现在即将过期里');
  assert.ok(grants.expired({ now: NOW }).some((x) => x.grantId === 'a-now'));
});

console.log('');
console.log('== estimateRemaining：先领先扣推算（真实快过期口径的数据源） ==');
// 分配规则：从最新批次往回分 remaining，每批最多拿满领取额，分完为止。
// 这对应上游「先到先用」的消耗顺序（老批次先扣，余额留在最新批次上）。
// grantedAt 按「30 天有效期、越早领的越早到期」派生——排序键是 grantedAt，
// 全部相同会让「谁新谁老」无从判断。
const batch = (id, daysFromNow, amount) => ({
  grantId: id, accountId: 1, amount,
  grantedAt: NOW - (30 - daysFromNow) * 86400000,
  expiresAt: NOW + daysFromNow * 86400000, ts: NOW,
});

check('老批次先扣完：余额全留在最新批次上', () => {
  // 总发放 300、余额 150 ⇒ 消耗了 150，先领先扣吃掉 old(100)+mid(50)
  const bs = [batch('old', 1, 100), batch('mid', 5, 100), batch('new', 20, 100)];
  const est = grants.estimateRemaining(bs, 150);
  assert.strictEqual(est.get('old'), 0, '最老的批次应被消耗光');
  assert.strictEqual(est.get('mid'), 50, '中间批次被吃掉一半');
  assert.strictEqual(est.get('new'), 100, '最新批次持满');
  assert.strictEqual(est.get('old') + est.get('mid') + est.get('new'), 150, '合计 = 总余额');
});

check('余额充足时每批都拿满领取额', () => {
  const bs = [batch('x', 2, 100), batch('y', 10, 200)];
  const est = grants.estimateRemaining(bs, 1000);
  assert.strictEqual(est.get('x'), 100);
  assert.strictEqual(est.get('y'), 200);
});

check('余额为 0 → 全部批次推算剩余 0（都用完了）', () => {
  const est = grants.estimateRemaining([batch('a', 1, 100), batch('b', 9, 100)], 0);
  assert.strictEqual(est.get('a'), 0);
  assert.strictEqual(est.get('b'), 0);
});

check('amount=null 的批次按 0 参与（领取额未知，不凭空持有余额）', () => {
  const bs = [batch('n', 2, null), batch('m', 9, 100)];
  const est = grants.estimateRemaining(bs, 50);
  assert.strictEqual(est.get('n'), 0);
  assert.strictEqual(est.get('m'), 50);
});

check('remaining 缺失/非法（null/负数）→ 全 0，不编数', () => {
  for (const rem of [null, -5, NaN, undefined]) {
    const est = grants.estimateRemaining([batch('a', 1, 100)], rem);
    assert.strictEqual(est.get('a'), 0, `remaining=${rem} 应得 0`);
  }
});

check('输入顺序无关（内部按 grantedAt 新→老排序）', () => {
  const bs = [batch('new', 20, 100), batch('old', 1, 100), batch('mid', 5, 100)];
  const est = grants.estimateRemaining(bs, 150);
  assert.strictEqual(est.get('old'), 0);
  assert.strictEqual(est.get('mid'), 50);
  assert.strictEqual(est.get('new'), 100);
});

check('返回 Map，不改动输入批次对象', () => {
  const bs = [batch('a', 3, 100)];
  const before = JSON.stringify(bs);
  grants.estimateRemaining(bs, 30);
  assert.strictEqual(JSON.stringify(bs), before, '纯函数不改输入');
});

check('端到端口径：复现 2026-11-01 真实场景，老批次推 0、快过期合计如实为 0', () => {
  // 10-02 领的 100（1 天后到期）早已被消耗吃掉，总余额由最新批次持有——
  // 快过期合计必须如实为 0，而不是「领取额 100」一直挂着。
  const bs = [
    batch('oct02', 1, 100), batch('m1', 5, 100), batch('m2', 10, 100),
    batch('m3', 15, 100), batch('m4', 20, 100), batch('nov01', 30, 100),
  ];
  const est = grants.estimateRemaining(bs, 250);
  const soon = bs.filter((b) => b.expiresAt - NOW <= 7 * 86400000);
  const sum = soon.reduce((s, b) => s + (est.get(b.grantId) || 0), 0);
  assert.strictEqual(sum, 0, '快过期的老批次已按消耗顺序用完');
  assert.strictEqual(est.get('m3'), 50, '消耗停在中段批次（250 = 100×2 + 50）');
  assert.strictEqual(est.get('nov01'), 100, '最新批次持满');
});

console.log('');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
if (failures) { console.log(`${failures} 项失败`); process.exit(1); }
console.log('全部通过');
process.exit(0);
