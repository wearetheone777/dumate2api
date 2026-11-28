// test/unit/trash-store.test.js - 账号回收站（批次十六，参考 qoder-trae-workbuddy-switch trash.rs）
//
// 语义定案（参考实现口径 + 本项目偏离）：
// - 软删除搬移到**独立回收站文件**，凭据随记录原样搬走（恢复无损）；live 文件
//   不含回收站成员——pool/keepalive/FEFO 等消费方零改动，漏过滤的静默故障不存在；
// - 恢复 fail-closed：未知 key 拒、live 已有同 id 拒（不覆盖）；
// - 留存策略：30 天 + 200 条先到先出；expiresAt/deletedAt 解析不出（非数字）
//   一律当已过期/最旧——回收站是凭据的临时存放点，不是长期仓库；
// - 时间是毫秒数（本仓库落盘时间戳的统一形态），不是参考实现的 ISO 字符串。
//
// 运行：node --test test/unit/trash-store.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-trash');
process.env.DUMATE_ADMIN_DATA = TMP;

const trash = require('../../src/admin/trash');
const accounts = require('../../src/accounts');

const DAY = 86400000;

// 往搭子网页账号存储写 N 个账号（真实存储模块，走它自己的 save 纪律）
function seedAccounts(rows) {
  accounts.save({
    accounts: rows.map((r) => ({ id: r.id, name: r.name, nickname: r.nickname || '', cookie: r.cookie || `ck-${r.id}` })),
  });
}

// 直接读回收站文件（绕过 list 的视图层，核对落盘原文）
function readTrashRaw(ch) {
  return JSON.parse(fs.readFileSync(path.join(TMP, trash.SPECS[ch].file), 'utf8'));
}
function writeTrashRaw(ch, entries) {
  fs.writeFileSync(path.join(TMP, trash.SPECS[ch].file), JSON.stringify(entries));
}

test('规格表：五通道齐全、回收站文件名一一对应、mod 可加载', () => {
  const ids = Object.keys(trash.SPECS);
  assert.deepStrictEqual(ids.sort(), ['dumate', 'qoder', 'qwenwork', 'traework', 'workbuddy'].sort(), '五个通道各一份规格');
  for (const [ch, spec] of Object.entries(trash.SPECS)) {
    assert.ok(spec.file.endsWith('-trash.json'), `${ch} 回收站是独立文件`);
    const mod = spec.mod();
    for (const fn of ['load', 'save', 'remove', 'filePath']) {
      assert.strictEqual(typeof mod[fn], 'function', `${ch} mod.${fn} 可用`);
    }
    assert.strictEqual(typeof spec.nameOf, 'function', `${ch} nameOf 可用`);
  }
  assert.strictEqual(trash.SPECS.qoder.file, 'qoder-accounts-trash.json', 'qoder 回收站文件名');
  assert.strictEqual(trash.TRASH_MAX_ENTRIES, 200, '上限 200（与参考实现一致）');
  assert.strictEqual(trash.TRASH_RETENTION_DAYS, 30, '保留期 30 天（与参考实现一致）');
});

test('留存策略（纯函数）：过期的清掉、坏 expiresAt 当已过期、正好到期不保留', () => {
  const now = 1_700_000_000_000;
  const entries = [
    { key: 'fresh', deletedAt: now - DAY, expiresAt: now + DAY },
    { key: 'expired', deletedAt: now - 40 * DAY, expiresAt: now - DAY },
    { key: 'badexp', deletedAt: now - DAY, expiresAt: '被手改坏' },
    { key: 'nodel', deletedAt: null, expiresAt: now + DAY },
    { key: 'boundary', deletedAt: now - 30 * DAY, expiresAt: now }, // 正好到期：不保留
  ];
  const { entries: kept, removed } = trash.sweepEntries(entries, now);
  assert.strictEqual(removed, 3, '过期/坏读/到期各清 1');
  assert.deepStrictEqual(kept.map((e) => e.key).sort(), ['fresh', 'nodel'], '只留两条未过期的');
});

test('留存策略：200 条上限先到先出（最旧的先被裁），坏 deletedAt 当最旧', () => {
  const now = 1_700_000_000_000;
  const n = trash.TRASH_MAX_ENTRIES + 5;
  const entries = [];
  for (let i = 0; i < n; i++) {
    entries.push({ key: `k${i}`, deletedAt: now - (n - i) * 1000, expiresAt: now + DAY });
  }
  entries.push({ key: 'broken', deletedAt: null, expiresAt: now + DAY });
  const { entries: kept, removed } = trash.sweepEntries(entries, now);
  assert.strictEqual(removed, 6, '裁掉 5 条超额 + 1 条坏时间');
  assert.strictEqual(kept.length, trash.TRASH_MAX_ENTRIES, '回到上限');
  assert.ok(!kept.some((e) => e.key === 'broken'), '坏 deletedAt 是最旧，先出');
  assert.ok(!kept.some((e) => e.key === 'k0'), '最早删除的先出');
  assert.ok(kept.some((e) => e.key === `k${n - 1}`), '最新删除的保留');
});

test('软删除：账号离开 live、进入回收站，凭据随记录原样搬走', () => {
  seedAccounts([
    { id: 101, name: '甲', cookie: 'ck-secret-101' },
    { id: 102, name: '乙', cookie: 'ck-secret-102' },
  ]);
  const r = trash.trashAccount('dumate', '101');
  assert.strictEqual(r.ok, true, '软删除成功');
  assert.strictEqual(r.name, '甲', '带展示名快照');

  const live = accounts.load().accounts;
  assert.deepStrictEqual(live.map((a) => a.id), [102], 'live 应只剩 102');
  const entry = trash.listTrash('dumate').entries[0];
  assert.strictEqual(entry.key, '101', 'key = String(id)');
  assert.strictEqual(entry.id, 101, 'id 保留数字原值');
  assert.strictEqual(entry.name, '甲', '展示名快照');
  assert.strictEqual(entry.expiresInDays, trash.TRASH_RETENTION_DAYS, '到期 = 删除 + 保留期');
  assert.ok(entry.expiresAt > entry.deletedAt, 'expiresAt 晚于 deletedAt');
  const raw = readTrashRaw('dumate');
  assert.strictEqual(raw[0].account.cookie, 'ck-secret-101', 'cookie 原样入回收站（恢复无损的关键）');
  trash.clearTrash('dumate');
});

test('软删除：不存在的 id 幂等返回 ok:false，不往回收站塞东西', () => {
  const before = trash.listTrash('dumate').entries.length;
  const r = trash.trashAccount('dumate', '99999');
  assert.strictEqual(r.ok, false, '不存在 ⇒ ok:false');
  assert.strictEqual(trash.listTrash('dumate').entries.length, before, '回收站条目数不变');
});

test('恢复：账号回到 live（记录逐字还原）、离开回收站；未知 key 与 live 冲突都被拒', () => {
  seedAccounts([{ id: 201, name: '恢复对象', cookie: 'ck-restore-201' }]);
  assert.strictEqual(trash.trashAccount('dumate', '201').ok, true);

  const r = trash.restoreAccount('dumate', '201');
  assert.strictEqual(r.ok, true, '恢复成功');
  const live = accounts.load().accounts;
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0].id, 201);
  assert.strictEqual(live[0].cookie, 'ck-restore-201', '凭据逐字还原');
  assert.strictEqual(live[0].name, '恢复对象');
  assert.deepStrictEqual(trash.listTrash('dumate').entries, [], '恢复后回收站清空该条目');

  // 认不出的 key ⇒ 拒绝（不静默成功）
  const ghost = trash.restoreAccount('dumate', 'ghost');
  assert.strictEqual(ghost.ok, false);
  assert.ok(/回收站中没有该账号/.test(ghost.error), '未知 key 报「没有该账号」');

  // live 已存在同 id ⇒ 拒绝（恢复不能成为冲掉现有账号的隐蔽入口）
  seedAccounts([{ id: 202, name: '二号', cookie: 'c202' }, { id: 203, name: '三号', cookie: 'c203' }]);
  assert.strictEqual(trash.trashAccount('dumate', '203').ok, true);
  seedAccounts([{ id: 202, name: '二号', cookie: 'c202' }, { id: 203, name: '新三号', cookie: 'c-new' }]);
  const collision = trash.restoreAccount('dumate', '203');
  assert.strictEqual(collision.ok, false, 'live 已有同 id 必须拒绝');
  assert.ok(/已存在该账号/.test(collision.error), '冲突报「已存在」');
  assert.ok(trash.listTrash('dumate').entries.some((e) => e.key === '203'), '拒绝后回收站条目仍在（fail-closed 不丢数据）');
  assert.strictEqual(accounts.load().accounts.find((a) => a.id === 203).cookie, 'c-new', 'live 未被覆盖');
  assert.strictEqual(trash.purgeAccount('dumate', '203').ok, true, '现场清理');
});

test('恢复 preferred 排他归一：live 已有 preferred 时剥掉恢复副本的标记', () => {
  const qw = require('../../src/qwenwork/auth');
  qw.save({ accounts: [{ id: 1, nickname: '主号', preferred: true, accessToken: 'at-1' }] });
  // 直接造一条带 preferred 的回收站条目（绕过软删除，模拟「删的时候它是主号」）
  writeTrashRaw('qwenwork', [{
    key: '7', id: 7, name: '旧主号', deletedAt: Date.now(), expiresAt: Date.now() + DAY,
    account: { id: 7, nickname: '旧主号', preferred: true, accessToken: 'at-7' },
  }]);
  const r = trash.restoreAccount('qwenwork', '7');
  assert.strictEqual(r.ok, true, '恢复成功');
  const restored = qw.load().accounts.find((a) => a.id === 7);
  assert.strictEqual(restored.preferred, false, 'live 已有 preferred ⇒ 恢复副本不带 preferred');
  assert.strictEqual(restored.accessToken, 'at-7', '凭据不受归一影响');
  assert.strictEqual(qw.load().accounts.find((a) => a.id === 1).preferred, true, '原主号不受影响');
});

test('永久删除：条目消失；再删一次（认不出 key）拒绝', () => {
  seedAccounts([{ id: 301, name: '待销毁', cookie: 'c301' }]);
  assert.strictEqual(trash.trashAccount('dumate', '301').ok, true);
  assert.strictEqual(trash.purgeAccount('dumate', '301').ok, true);
  assert.deepStrictEqual(trash.listTrash('dumate').entries, [], 'purge 后条目消失');
  const again = trash.purgeAccount('dumate', '301');
  assert.strictEqual(again.ok, false, '已不存在的 key 拒绝，不静默成功');
  assert.ok(/回收站中没有该账号/.test(again.error));
});

test('清空：返回被删条数；已空时返回 0 不报错', () => {
  seedAccounts([{ id: 401, name: '一号', cookie: 'c401' }, { id: 402, name: '二号', cookie: 'c402' }]);
  trash.trashAccount('dumate', '401');
  trash.trashAccount('dumate', '402');
  const r = trash.clearTrash('dumate');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.removed, 2, '返回被删条数');
  assert.deepStrictEqual(trash.listTrash('dumate').entries, []);
  assert.strictEqual(trash.clearTrash('dumate').removed, 0, '空回收站返回 0');
});

test('列表：按删除时间倒序（最新在前），条目形状齐全', () => {
  const now = Date.now();
  writeTrashRaw('dumate', [
    { key: 'old', id: 1, name: '旧的', deletedAt: now - 2 * DAY, expiresAt: now + 28 * DAY, account: { id: 1 } },
    { key: 'new', id: 2, name: '新的', deletedAt: now - DAY, expiresAt: now + 29 * DAY, account: { id: 2 } },
    { key: 'brokentime', id: 3, name: '坏时间', deletedAt: 'x', expiresAt: now + DAY, account: { id: 3 } },
  ]);
  const list = trash.listTrash('dumate');
  assert.strictEqual(list.ok, true);
  assert.strictEqual(list.corrupt, false, '可解析的文件不标 corrupt');
  assert.deepStrictEqual(list.entries.map((e) => e.key), ['new', 'old', 'brokentime'], '按删除时间倒序；坏时间当最旧排在末尾');
  const row = list.entries[0];
  assert.strictEqual(row.id, 2);
  assert.strictEqual(row.name, '新的');
  assert.ok(Number.isFinite(row.deletedAt) && Number.isFinite(row.expiresAt), '时间是毫秒数');
  assert.strictEqual(row.expiresInDays, 29, '剩余天数按 ceil 算');
  trash.clearTrash('dumate');
});

test('损坏的回收站文件：写路径全部拒绝（宁可不写），列表如实标 corrupt', () => {
  seedAccounts([{ id: 501, name: '受害人', cookie: 'c501' }]);
  fs.writeFileSync(path.join(TMP, trash.SPECS.dumate.file), '{broken json');
  const t = trash.trashAccount('dumate', '501');
  assert.strictEqual(t.ok, false, '软删除拒绝在损坏库上覆盖');
  assert.ok(/损坏/.test(t.error), '报「损坏」');
  assert.strictEqual(trash.restoreAccount('dumate', '501').ok, false, '恢复拒绝');
  assert.strictEqual(trash.purgeAccount('dumate', '501').ok, false, 'purge 拒绝');
  const clear = trash.clearTrash('dumate');
  assert.strictEqual(clear.ok, false, '清空拒绝——把损坏当空库写空等于抹掉仅存数据');
  assert.strictEqual(clear.corrupt, true, 'corrupt 标记如实');
  const list = trash.listTrash('dumate');
  assert.strictEqual(list.corrupt, true, '列表标 corrupt');
  assert.deepStrictEqual(list.entries, [], '列表退化为空但损坏可见');
  assert.strictEqual(accounts.load().accounts.length, 1, 'live 未被动过（fail-closed 不丢数据）');
  fs.writeFileSync(path.join(TMP, trash.SPECS.dumate.file), '[]');
  assert.strictEqual(trash.trashAccount('dumate', '501').ok, true, '修复后恢复正常');
  trash.clearTrash('dumate');
});

test('软删除顺序：trash 先落、live 后删——remove 报 false 时回滚回收站条目', () => {
  // 用假存储模块制造「load 找得到、remove 报 false」的并发删除竞态：
  // 真实顺序（先写 trash 后删 live）下这时必须把刚写入的条目撤回来，
  // 否则「账号消失但回收站里也没有」之外还会多出一条幽灵条目
  const fake = {
    load: () => ({ accounts: [{ id: 701, name: '假号', cookie: 'c701' }] }),
    save: () => {},
    remove: () => false, // 并发删除抢了先
    filePath: () => path.join(TMP, 'fake-live.json'),
  };
  const orig = trash.SPECS.dumate.mod;
  trash.SPECS.dumate.mod = () => fake;
  let r;
  try {
    r = trash.trashAccount('dumate', '701');
  } finally {
    trash.SPECS.dumate.mod = orig;
  }
  assert.strictEqual(r.ok, false, 'remove 失败 ⇒ 如实报错');
  assert.deepStrictEqual(readTrashRaw('dumate').filter((e) => e.key === '701'), [], '回滚生效：条目被撤回');
});

test('五通道接线自证：各 route 文件展开 routesFor 且 DELETE 走 trashAccount', () => {
  const wiring = [
    ['src/admin/routes/accounts.js', 'dumate'],
    ['src/admin/routes/qoder.js', 'qoder'],
    ['src/admin/routes/traework.js', 'traework'],
    ['src/admin/routes/workbuddy.js', 'workbuddy'],
    ['src/admin/routes/qwenwork.js', 'qwenwork'],
  ];
  for (const [file, ch] of wiring) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(src.includes(`routesFor('${ch}')`), `${file} 展开 routesFor('${ch}')`);
    assert.ok(src.includes(`trashAccount('${ch}'`), `${file} 的 DELETE 走 trashAccount('${ch}')`);
    assert.ok(src.split("routesFor('").length === 2, `${file} 只展开一次`);
  }
  const server = fs.readFileSync('src/admin/server.js', 'utf8');
  assert.ok(server.includes("require('./trash').startSweep()"), 'admin/server.js 启动留存清扫');
});
