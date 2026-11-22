// test/unit/qoder-period.test.js - 订阅周期感知的统计口径（P1-10）
//
// 调研出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P1-10（EchoPing07 的规则
// 密度最高的一节）。
//
// **要修的真问题**：本地账本是无界累计——「本周期扣了多少」没有答案；
// 跨过重置点后总量继续变大，而套餐额度其实已经刷新。
//
// 四条边界治理规则（照抄 EchoPing07，每条都有具体故障对应）：
//   1. 边界以 nextResetAt 为权威、expiresAt 兜底；**≥ 2100-01-01 是哨兵值
//      必须过滤**（无期限套餐填 9999-12-31，采纳会让「本周期」永不到期）
//   2. 首次拿到边界**保留已累计值**
//   3. 边界未推进/后退 → 忽略（上游缓存报旧值）；前进 < 7 天 → 同周期；
//      ≥ 7 天 → 真实续期并清零
//   4. 均值分母是 billed_requests（仅 billable），不是请求总数
//
// 运行：node --test test/unit/qoder-period.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-qoder-period');
process.env.DUMATE_ADMIN_DATA = TMP;

const period = require('../../src/qoder/period');

const DAY = 86400000;
const NOW = new Date(2026, 10, 8, 12, 0, 0).getTime(); // 2026-11-08 12:00

function cleanup() {
  try { fs.unlinkSync(period.filePath()); } catch (e) { /* 不存在 */ }
}

// ---- 1. 边界解析 ----

test('parseBoundary：nextResetAt 权威、expiresAt 兜底、秒/毫秒/ISO 都认', () => {
  // 秒级时间戳（2027-01-15 前后）
  const s = period.parseBoundary({ nextResetAt: 1799999999 });
  assert.strictEqual(s.at, 1799999999 * 1000);
  assert.strictEqual(s.source, 'nextResetAt');
  // 毫秒
  assert.strictEqual(period.parseBoundary({ nextResetAt: 1799999999000 }).at, 1799999999000);
  // ISO 字符串
  assert.strictEqual(period.parseBoundary({ nextResetAt: '2027-01-15T00:00:00Z' }).at, Date.parse('2027-01-15T00:00:00Z'));
  // expiresAt 兜底（nextResetAt 缺失时）
  const fb = period.parseBoundary({ expiresAt: '2027-02-01T00:00:00Z' });
  assert.strictEqual(fb.source, 'expiresAt');
  assert.strictEqual(fb.at, Date.parse('2027-02-01T00:00:00Z'));
  // nextResetAt 优先于 expiresAt
  assert.strictEqual(period.parseBoundary({ nextResetAt: 1799999999000, expiresAt: 1899999999000 }).at, 1799999999000);
  // 全缺 → null
  assert.strictEqual(period.parseBoundary({}).at, null);
  assert.strictEqual(period.parseBoundary(null).at, null);
});

test('parseBoundary：9999-12-31 哨兵值被过滤（无期限套餐不能造一个「永不到期」的边界）', () => {
  const a = period.parseBoundary({ expiresAt: '9999-12-31T00:00:00Z' });
  assert.strictEqual(a.at, null, '哨兵值不采纳');
  assert.strictEqual(a.source, '');
  // 毫秒形态的哨兵（2100-01-01 之后）同样过滤
  assert.strictEqual(period.parseBoundary({ nextResetAt: 4102444800000 }).at, null);
  // 正常值不受影响
  assert.ok(period.parseBoundary({ nextResetAt: 1799999999000 }).at);
});

// ---- 2. 边界接受规则 ----

test('decideBoundary：首次拿到边界保留已累计值（periodStart 回推 31 天并夹到现在）', () => {
  const d = period.decideBoundary(null, NOW + 22 * DAY, NOW);
  assert.strictEqual(d.action, 'init');
  assert.strictEqual(d.boundary, NOW + 22 * DAY);
  // 边界距现在 22 天，回推 31 天落在 NOW − 9 天（过去）→ **不夹**：
  // 周期起点就该是那时（周期真实从 9 天前开始），夹到 now 反而把本周期
  // 前 9 天的消耗算丢。
  assert.strictEqual(d.periodStart, NOW + 22 * DAY - 31 * DAY);
  // 边界在过去（上游报了旧边界且我们没有任何旧记录可依）：回推 31 天仍在
  // 过去，不夹——periodStart = 边界 − 31 天
  const past = period.decideBoundary(null, NOW - 3 * DAY, NOW);
  assert.strictEqual(past.periodStart, NOW - 3 * DAY - 31 * DAY);
  // **硬约束**：periodStart ≤ now 恒成立（周期起点不该落在未来）。
  // 回推值 = 边界 − 31 天 > now ⇔ 边界 > now + 31 天。所以边界远于 31 天时
  // 回推值会落在未来 → 夹到 now（宁可少算也不要凭空造一个未来的起点）。
  const anyBoundary = period.decideBoundary(null, NOW + 90 * DAY, NOW);
  assert.ok(anyBoundary.periodStart <= NOW, `回推值不该落在未来（${anyBoundary.periodStart} > ${NOW}）`);
  // 90 天远：回推 = NOW + 59 天（未来）→ 夹到 NOW
  assert.strictEqual(anyBoundary.periodStart, NOW);
  // 60 天远：回推 = NOW + 29 天（未来）→ 同样夹到 NOW
  const far = period.decideBoundary(null, NOW + 60 * DAY, NOW);
  assert.strictEqual(far.periodStart, NOW);
  // 边界在 31 天内：回推值已落在过去，不夹
  const near = period.decideBoundary(null, NOW + 22 * DAY, NOW);
  assert.strictEqual(near.periodStart, NOW + 22 * DAY - 31 * DAY);
});

test('decideBoundary：边界未变/后退 → ignore（上游缓存报旧值不能清零累计）', () => {
  const prev = { boundary: NOW + 10 * DAY, periodStart: NOW - 20 * DAY };
  assert.strictEqual(period.decideBoundary(prev, NOW + 10 * DAY, NOW).action, 'ignore');
  const back = period.decideBoundary(prev, NOW + 5 * DAY, NOW);
  assert.strictEqual(back.action, 'ignore', '后退是缓存旧值，按旧边界继续');
  assert.strictEqual(back.boundary, NOW + 10 * DAY, '不改边界');
  // 本次没读到边界：也不动
  const none = period.decideBoundary(prev, null, NOW);
  assert.strictEqual(none.action, 'ignore');
  assert.strictEqual(none.boundary, NOW + 10 * DAY);
});

test('decideBoundary：前进 < 7 天视为同周期（只更新边界，不清零）', () => {
  const prev = { boundary: NOW + 10 * DAY, periodStart: NOW - 20 * DAY };
  const d = period.decideBoundary(prev, NOW + 10 * DAY + 3 * DAY, NOW);
  assert.strictEqual(d.action, 'same');
  assert.strictEqual(d.boundary, NOW + 10 * DAY + 3 * DAY);
  assert.strictEqual(d.periodStart, NOW - 20 * DAY, 'periodStart 不变——累计不清零');
});

test('decideBoundary：前进 ≥ 7 天判定真实续期（periodStart 顺延）', () => {
  const prev = { boundary: NOW + 10 * DAY, periodStart: NOW - 20 * DAY };
  const d = period.decideBoundary(prev, NOW + 40 * DAY, NOW);
  assert.strictEqual(d.action, 'renew');
  assert.strictEqual(d.boundary, NOW + 40 * DAY);
  // 新周期起点 = 新边界 − 实际周期跨度（旧边界 − 旧起点 = 30 天）
  assert.strictEqual(d.periodStart, NOW + 40 * DAY - 30 * DAY);
});

// ---- 3. 落盘与读取 ----

test('observe：落盘并读回；失败不改状态', () => {
  cleanup();
  const r = period.observe(1, { nextResetAt: NOW + 10 * DAY }, NOW);
  assert.strictEqual(r.action, 'init');
  const st = period.stateOf(1);
  assert.strictEqual(st.boundary, NOW + 10 * DAY);
  assert.strictEqual(st.lastAction, 'init');
  // 观察一个「缓存旧值」（后退）：状态不动
  period.observe(1, { nextResetAt: NOW + 5 * DAY }, NOW + 1000);
  assert.strictEqual(period.stateOf(1).boundary, NOW + 10 * DAY);
  // observe 不抛（上游响应是垃圾时也不该把额度页带崩）
  assert.doesNotThrow(() => period.observe(1, 'garbage', NOW + 2000));
  assert.doesNotThrow(() => period.observe(1, null, NOW + 3000));
  cleanup();
});

// ---- 4. summarize 口径 ----

const LEDGER = [
  // 本周期内（periodStart = NOW - 20 DAY）
  { ts: NOW - 10 * DAY, credits: 1.5, account_id: 1, billable: true },
  { ts: NOW - 5 * DAY, credits: 0.5, account_id: 1, billable: true },
  // billable=false（免费帧/错误帧）：进 requests、不进 billed
  { ts: NOW - 4 * DAY, credits: 0.0, account_id: 1, billable: false },
  // 别的账号：不该串进来
  { ts: NOW - 3 * DAY, credits: 9.9, account_id: 2, billable: true },
  // 上个周期的（periodStart 之前）：不进本周期
  { ts: NOW - 25 * DAY, credits: 100, account_id: 1, billable: true },
];

test('summarize：按 periodStart 切分 + 按账号隔离；均值分母只数 billable', () => {
  const s = period.summarize(LEDGER, { periodStart: NOW - 20 * DAY, accountId: 1 });
  assert.strictEqual(s.bounded, true);
  assert.strictEqual(s.cost, 2, '1.5 + 0.5（免费帧 0 与别账号 9.9 与上周期 100 都不进）');
  assert.strictEqual(s.requests, 3, '1.5/0.5/免费帧三行');
  assert.strictEqual(s.billedRequests, 2, '免费帧不进均值分母');
  assert.strictEqual(s.avgPerBilledRequest, 1, '(1.5+0.5)/2');
});

test('summarize：没有周期信息时全量给并标 bounded=false（不能假装是本周期）', () => {
  const s = period.summarize(LEDGER, { periodStart: null, accountId: 1 });
  assert.strictEqual(s.bounded, false);
  assert.strictEqual(s.cost, 102, '全量：1.5+0.5+100（别账号不进）');
  assert.strictEqual(s.requests, 4);
});

test('summarize：billable 字段缺失的老账本按「有 credits 就算计费」处理', () => {
  const s = period.summarize([
    { ts: NOW - 1 * DAY, credits: 2.0, account_id: 1 },   // 无 billable 字段
    { ts: NOW - 1 * DAY, credits: 3.0, account_id: 1, billable: true },
  ], { periodStart: NOW - 20 * DAY, accountId: 1 });
  assert.strictEqual(s.billedRequests, 2, '老行不能被丢出分母');
  assert.strictEqual(s.avgPerBilledRequest, 2.5);
});
