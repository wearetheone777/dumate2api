// test/unit/expiring-fefo.test.js - 临期积分快照（FEFO 数据源）的离线验证
//
// 要锁住的不变量（都是从真实场景反推的）：
//   - 快照 = 管理端写、网关读，中间只隔一个文件——读写形状必须咬合
//   - 陈旧/缺失/窗口外一律返回 null（退回普通轮询是设计好的行为，不能抛）
//   - 窗口按通道不同（搭子 30 / TRAE 7 / 千问 30），env 可覆盖、0 可关闭
//   - update 是全量替换语义（管理端每次刷新都会全量拉，漏掉的账号=无临期）
//   - 已过期的批次不进集合（上游已废止，优先消耗它没有意义）
const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'expiring-fefo-'));
process.env.DUMATE_EXPIRING_SNAPSHOT_FILE = path.join(TMP, 'snapshot.json');

// 在 env 设好之后再加载（filePath() 每次读 env，但模块级清洁从加载前开始）
const snap = require('../../src/expiring');

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-11-01T12:00:00+08:00');

function reset() {
  try { fs.unlinkSync(snap.filePath()); } catch (e) { /* 无文件 */ }
}
reset();
test.after?.(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

test('update 写盘，accountIds 能读回（写读形状咬合）', () => {
  const ok = snap.update('dumate', [
    { accountId: 1, nearest: NOW + 2 * 86400000 },
    { accountId: 2, nearest: NOW + 10 * 86400000 },
  ], { now: NOW });
  assert.strictEqual(ok, true, '首次应有写盘');
  const ids = snap.accountIds('dumate', NOW);
  assert.ok(ids instanceof Set);
  // JSON 对象键只能是字符串——读回来必须是字符串形式（网关用它拼 uid）
  assert.ok(ids.has('1'));
  assert.ok(ids.has('2'));
  assert.strictEqual(ids.size, 2);
});

test('窗口外（过晚到期）的不算临期', () => {
  // 搭子窗口 30 天：40 天后的批次不算临期；窗口内没有别的临期账号时，
  // 整个通道返回 null（退回普通轮询，而不是一个空集合）
  snap.update('dumate', [{ accountId: 9, nearest: NOW + 40 * 86400000 }], { now: NOW });
  assert.deepStrictEqual(
    snap.accountIds('dumate', NOW), null,
    '窗口内无临期 → null（走普通轮询）');
  // env 覆盖窗口到 45 天后变成临期（先锁旧值，测完恢复）
  const prev = process.env.DUMATE_DUMATE_FEFO_DAYS;
  process.env.DUMATE_DUMATE_FEFO_DAYS = '45';
  try {
    snap.update('dumate', [{ accountId: 9, nearest: NOW + 40 * 86400000 }], { now: NOW });
    assert.strictEqual(snap.accountIds('dumate', NOW).has('9'), true);
  } finally {
    if (prev == null) delete process.env.DUMATE_DUMATE_FEFO_DAYS; else process.env.DUMATE_DUMATE_FEFO_DAYS = prev;
  }
});

test('env 设 0 → FEFO 关闭（恒 null，走普通轮询）', () => {
  const prev = process.env.DUMATE_TRAEWORK_FEFO_DAYS;
  process.env.DUMATE_TRAEWORK_FEFO_DAYS = '0';
  try {
    snap.update('traework', [{ accountId: 1, nearest: NOW + HOUR }], { now: NOW });
    assert.strictEqual(snap.accountIds('traework', NOW), null);
  } finally {
    if (prev == null) delete process.env.DUMATE_TRAEWORK_FEFO_DAYS; else process.env.DUMATE_TRAEWORK_FEFO_DAYS = prev;
  }
});

test('TRAE 默认窗口 7 天（与管理端 /credits 的 SOON_MS 同窗）', () => {
  snap.update('traework', [
    { accountId: 3, nearest: NOW + 6 * 86400000 },
    { accountId: 4, nearest: NOW + 8 * 86400000 },
  ], { now: NOW });
  const ids = snap.accountIds('traework', NOW);
  assert.ok(ids.has('3'), '6 天后到期应算临期');
  assert.strictEqual(ids.has('4'), false, '8 天后到期超出 7 天窗口');
});

test('千问默认窗口 30 天兜底（上游 expiring_soon 自带信号）', () => {
  snap.update('qwenwork', [{ accountId: 7, nearest: NOW + 15 * 86400000 }], { now: NOW });
  assert.ok(snap.accountIds('qwenwork', NOW).has('7'));
});

test('WorkBuddy 默认窗口 7 天（套餐 CycleEndTime，2026-11-04 真机实证）', () => {
  snap.update('workbuddy', [
    { accountId: 11, nearest: NOW + 6 * 86400000 },
    { accountId: 12, nearest: NOW + 9 * 86400000 },
  ], { now: NOW });
  const ids = snap.accountIds('workbuddy', NOW);
  assert.ok(ids.has('11'), '6 天后到期应算临期');
  assert.strictEqual(ids.has('12'), false, '9 天后到期超出 7 天窗口');
  assert.strictEqual(snap.windowDays('workbuddy'), 7);
});

test('快照陈旧（超 TTL）→ null，退回普通轮询不报错', () => {
  snap.update('dumate', [{ accountId: 1, nearest: NOW + HOUR }], { now: NOW - 7 * HOUR });
  assert.deepStrictEqual(snap.accountIds('dumate', NOW), null, 'TTL 默认 6 小时，7 小时前写的算陈旧');
});

test('通道隔离：traework 的快照不影响 qwenwork', () => {
  snap.update('traework', [{ accountId: 5, nearest: NOW + HOUR }], { now: NOW });
  snap.update('qwenwork', [{ accountId: 21, nearest: NOW + HOUR }], { now: NOW });
  assert.ok(snap.accountIds('qwenwork', NOW).has('21'));
  assert.strictEqual(snap.accountIds('qwenwork', NOW).has('5'), false);
  assert.ok(snap.accountIds('traework', NOW).has('5'));
  assert.strictEqual(snap.accountIds('traework', NOW).has('21'), false);
});

test('update 全量替换：下次刷新没提到的账号被移除', () => {
  snap.update('traework', [{ accountId: 5, nearest: NOW + HOUR }], { now: NOW });
  snap.update('traework', [{ accountId: 6, nearest: NOW + 2 * HOUR }], { now: NOW });
  const ids = snap.accountIds('traework', NOW);
  assert.ok(ids.has('6'));
  assert.strictEqual(ids.has('5'), false, '掉的账号不该残留');
});

test('过期（nearest <= now）与非法 nearest 都不进集合', () => {
  snap.update('dumate', [
    { accountId: 30, nearest: NOW - 1000 },      // 已过期
    { accountId: 31, nearest: 0 },               // 无效值
    { accountId: 32, nearest: null },            // 无效值
    { accountId: 33, nearest: NOW + HOUR },      // 唯一有效的
  ], { now: NOW });
  const ids = snap.accountIds('dumate', NOW);
  assert.strictEqual(ids.size, 1);
  assert.ok(ids.has('33'));
});

test('窗口内无临期时返回 null（不是空集合）', () => {
  snap.update('dumate', [{ accountId: 30, nearest: NOW - 1000 }], { now: NOW });
  assert.deepStrictEqual(snap.accountIds('dumate', NOW), null);
});

test('info 透出新鲜度（FEFO 没生效要能在管理端看出来）', () => {
  snap.update('traework', [{ accountId: 5, nearest: NOW + HOUR }], { now: NOW });
  const i = snap.info('traework', NOW);
  assert.strictEqual(i.fresh, true);
  assert.strictEqual(i.accounts, 1);
  assert.strictEqual(i.windowDays, 7);
  assert.notStrictEqual(i.at, null);
  const stale = snap.info('traework', NOW + 7 * HOUR);
  assert.strictEqual(stale.fresh, false, '超 TTL 后 fresh=false');
});

test('数字 / 字符串型账号 id 归一（JSON 键只能存字符串）', () => {
  reset();
  snap.update('dumate', [{ accountId: 1, nearest: NOW + HOUR }], { now: NOW });
  // 管理端的来源不同：搭子的 accountId 是数字、千问的已是字符串——
  // 写进去必须长得一样，读回来都是字符串键
  snap.update('dumate', [{ accountId: '1', nearest: NOW + HOUR }], { now: NOW + 60 * 1000 });
  assert.ok(snap.accountIds('dumate', NOW + 60 * 1000).has('1'));
  // 归一后的 accounts 形状相同：第二次写盘应该覆盖成同一份内容
  const raw = JSON.parse(fs.readFileSync(snap.filePath(), 'utf8'));
  assert.deepStrictEqual(raw.channels.dumate.accounts, { '1': NOW + HOUR });
});

test('keepIds：查询失败的账号保留旧条目，不被当成「无临期」抹掉', () => {
  reset();
  snap.update('traework', [
    { accountId: 11, nearest: NOW + HOUR },
    { accountId: 12, nearest: NOW + 2 * HOUR },
  ], { now: NOW });
  // 第二轮：11 号查询失败（没进 entries 但列进 keepIds），12 号确认无临期
  snap.update('traework', [], { now: NOW + 60 * 1000, keepIds: [11] });
  const raw = JSON.parse(fs.readFileSync(snap.filePath(), 'utf8'));
  assert.ok(raw.channels.traework.accounts['11'], '失败账号的旧条目必须保留');
  assert.strictEqual(raw.channels.traework.accounts['12'], undefined, '确认无临期的要清掉');
  const ids = snap.accountIds('traework', NOW + 60 * 1000);
  assert.ok(ids && ids.has('11'));
});

test('keepIds 非空时 at 不推进（部分旧数据不能让快照冒充新鲜）', () => {
  reset();
  // 到期时刻放 3 天后：既在 30 天窗口内，也晚于本用例检查的各个 now。
  // （放 NOW+HOUR 的话，NOW+5.5h 那次读到 null 是「批次已过期」，
  //  不是「快照新鲜度」——两件事必须在同一个断言里分开）
  const nearest = NOW + 3 * 86400000;
  snap.update('qwenwork', [{ accountId: 21, nearest }], { now: NOW });
  snap.update('qwenwork', [], { now: NOW + 5 * HOUR, keepIds: ['21'] });
  // 5 小时后仍 ≤ TTL 6h → 读得到；再往后（>6h）就该陈旧退场
  assert.ok(snap.accountIds('qwenwork', NOW + 5.5 * HOUR));
  const raw = JSON.parse(fs.readFileSync(snap.filePath(), 'utf8'));
  assert.strictEqual(raw.channels.qwenwork.at, NOW, 'at 停在最后一次全成功刷新');
  assert.deepStrictEqual(
    snap.accountIds('qwenwork', NOW + 7 * HOUR), null,
    '超 TTL 后整体退回普通轮询（陈旧快照不驱动流量）');
});
