// test/unit/backup-sections.test.js - 备份分区表（批次十四，qoder-trae-workbuddy-switch 移植）
//
// 语义定案（参考实现 backup_sections.rs / export_import.rs 口径）：
// - 表驱动：导出勾选与导入合并读**同一张表**，新增可备份类型 = 加一行；
// - merge 纯内存、write 分开：预览零写盘是安全阀；
// - SectionCounts{added,overwritten,skipped,conflicts} 逐分区回报；
// - 冲突策略 fail-closed 解析：未知拼写报错，绝不静默回落（回落会让「覆盖」
//   被静默当成「保留本地」或反过来）；
// - 导出默认脱敏；**脱敏记录覆盖本地时保留本地凭据字段**（本项目的刻意偏离：
//   导入一份不含凭据的备份不该把账号弄成不可用）。
//
// 运行：node --test test/unit/backup-sections.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-backup');
process.env.DUMATE_ADMIN_DATA = TMP;

const backup = require('../../src/admin/routes/backup');
const { SECTION_TABLE, parseConflictPolicy, mergeSection, mergeAccountsRecords, redactRecord, buildEnvelope } = backup;

const WB_SPEC = SECTION_TABLE.find((s) => s.id === 'accounts-workbuddy');
const MM_SPEC = SECTION_TABLE.find((s) => s.id === 'model-map');

test('分区表：id 唯一、accounts 行带 identity+creds、sensitive 行存在', () => {
  const ids = SECTION_TABLE.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'id 不重复');
  for (const s of SECTION_TABLE.filter((x) => x.kind === 'accounts')) {
    assert.ok(s.identity && s.identity.length, `${s.id} 要有身份键`);
    assert.ok(s.creds && s.creds.length, `${s.id} 要声明凭据字段`);
    assert.ok(s.store, `${s.id} 要有存储模块`);
  }
  assert.ok(SECTION_TABLE.some((s) => s.sensitive), '至少有一个 sensitive 分区（keys）');
  const keys = SECTION_TABLE.find((s) => s.id === 'keys');
  assert.strictEqual(keys.sensitive, true, 'keys.json 整个是明文凭据，必须 sensitive');
});

test('parseConflictPolicy：fail-closed（未知拼写报错，空 = keepLocal 安全默认）', () => {
  assert.strictEqual(parseConflictPolicy(''), 'keepLocal');
  assert.strictEqual(parseConflictPolicy(undefined), 'keepLocal');
  assert.strictEqual(parseConflictPolicy('keepLocal'), 'keepLocal');
  assert.strictEqual(parseConflictPolicy('Overwrite'), 'overwrite');
  assert.strictEqual(parseConflictPolicy('keepBoth'), 'keepBoth');
  // ask 在本期无逐条裁决 UI，按保留本地这一安全默认处理（参考实现同款）
  assert.strictEqual(parseConflictPolicy('ask'), 'keepLocal');
  assert.throws(() => parseConflictPolicy('覆盖'), /未知的冲突策略/);
  assert.throws(() => parseConflictPolicy('owervrite'), /未知的冲突策略/);
});

test('账号合并：一次一个策略——overwrite / keepLocal / keepBoth 三场景分开验', () => {
  const spec = WB_SPEC;
  const local = [
    { id: 1, uid: 'u1', nickname: '本地一', accessToken: 'at-1', refreshToken: 'rt-1' },
    { id: 2, uid: 'u2', nickname: '本地二', accessToken: 'at-2', refreshToken: 'rt-2' },
  ];

  // overwrite：命中同身份的都覆盖；新身份追加
  const over = mergeAccountsRecords(spec, local, [
    { uid: 'u3', nickname: '新增三', accessToken: 'at-3' },
    { uid: 'u1', nickname: '覆盖一', accessToken: 'at-1x', refreshToken: 'rt-1x' },
    { uid: 'u2', nickname: '覆盖二' },
  ], 'overwrite', false);
  assert.deepStrictEqual(over.counts, { added: 1, overwritten: 2, skipped: 0, conflicts: 2 });
  const overByUid = Object.fromEntries(over.merged.map((r) => [r.uid, r]));
  assert.strictEqual(overByUid.u1.nickname, '覆盖一');
  assert.strictEqual(overByUid.u1.id, 1, '覆盖保留本地 id（来件没带 id）');
  assert.strictEqual(overByUid.u2.nickname, '覆盖二');
  assert.strictEqual(overByUid.u2.accessToken, 'at-2', '脱敏来件覆盖 → 本地凭据保留');

  // keepLocal：命中的全保留，新身份照常进
  const keep = mergeAccountsRecords(spec, local, [
    { uid: 'u3', nickname: '新增三' },
    { uid: 'u1', nickname: '改名一' },
  ], 'keepLocal', false);
  assert.deepStrictEqual(keep.counts, { added: 1, overwritten: 0, skipped: 1, conflicts: 1 });
  assert.strictEqual(keep.merged.find((r) => r.uid === 'u1').nickname, '本地一');

  // keepBoth：命中同身份追加为「分身」，id 撞车重赋新 id
  const both = mergeAccountsRecords(spec, local, [
    { uid: 'u2', nickname: '二号分身', accessToken: 'at-2b' },
  ], 'keepBoth', false);
  assert.deepStrictEqual(both.counts, { added: 1, overwritten: 0, skipped: 0, conflicts: 1 });
  assert.strictEqual(both.merged.length, 3);
  const clone = both.merged[2];
  assert.strictEqual(clone.nickname, '二号分身');
  assert.ok(clone.id !== 2 && clone.id > 0, '撞 id 重赋新 id');
});

test('账号合并：无身份键的记录只能追加（不猜身份）', () => {
  const out = mergeAccountsRecords(WB_SPEC, [{ id: 1, uid: 'u1' }], [{ nickname: '无身份' }], 'keepLocal', false);
  assert.strictEqual(out.counts.added, 1);
  assert.strictEqual(out.merged.length, 2);
  assert.ok(out.merged[1].id, '追加赋新 id');
});

test('账号合并：脱敏来件覆盖时保留本地凭据字段（刻意偏离参考实现）', () => {
  const local = [{ id: 1, uid: 'u1', nickname: '旧名', accessToken: 'at-1', refreshToken: 'rt-1' }];
  const incoming = [{ uid: 'u1', nickname: '新名' }]; // redacted 导出形态：没带凭据
  const out = mergeAccountsRecords(WB_SPEC, local, incoming, 'overwrite', true);
  assert.strictEqual(out.counts.overwritten, 1);
  assert.strictEqual(out.merged[0].nickname, '新名', '非凭据字段被覆盖');
  assert.strictEqual(out.merged[0].accessToken, 'at-1', '凭据保留（没带 ≠ 没有）');
  assert.strictEqual(out.merged[0].refreshToken, 'rt-1');
  // 来件带了凭据才整条覆盖
  const out2 = mergeAccountsRecords(WB_SPEC, local, [{ uid: 'u1', nickname: '新', accessToken: 'new' }], 'overwrite', false);
  assert.strictEqual(out2.merged[0].refreshToken, undefined, '带凭据的来件整条替换，不被旧凭据污染');
});

test('对象分区合并：顶层键 added/overwritten/skipped；来件非对象原样保留', () => {
  const local = { aliases: { a: 'b' }, fallback: 'model-text' };
  const incoming = { aliases: { a: 'x' }, exposed: ['glm-5'] };
  const over = mergeSection(MM_SPEC, local, incoming, 'overwrite', false);
  assert.deepStrictEqual(over.counts, { added: 1, overwritten: 1, skipped: 0, conflicts: 0 });
  assert.deepStrictEqual(over.merged, { aliases: { a: 'x' }, fallback: 'model-text', exposed: ['glm-5'] });

  const keep = mergeSection(MM_SPEC, local, incoming, 'keepLocal', false);
  assert.deepStrictEqual(keep.counts, { added: 1, overwritten: 0, skipped: 1, conflicts: 1 });
  assert.strictEqual(keep.merged.aliases.a, 'b', 'keepLocal 保留本地键');
  assert.strictEqual(keep.merged.exposed.length, 1, '本地没有的键照常新增');

  const bad = mergeSection(MM_SPEC, local, 'not-object', 'overwrite', false);
  assert.strictEqual(bad.counts.added, 0, '来件不是对象 = 该分区没带东西');
  assert.deepStrictEqual(bad.merged, local);
});

test('redactRecord / buildEnvelope：脱敏导出里**搜不到任何凭据原文**', () => {
  const spec = WB_SPEC;
  // buildEnvelope 读的是**落盘数据**（mtime 缓存模块），先种文件
  fs.writeFileSync(path.join(TMP, 'workbuddy-accounts.json'), JSON.stringify({
    accounts: [
      { id: 1, uid: 'u1', nickname: '一', accessToken: 'AT-SECRET-ONE', refreshToken: 'RT-SECRET-ONE' },
      { id: 2, uid: 'u2', nickname: '二', accessToken: 'AT-SECRET-TWO', refreshToken: 'RT-SECRET-TWO' },
    ],
  }));
  const env = buildEnvelope([spec, MM_SPEC], { includeCredentials: false });
  const text = JSON.stringify(env);
  for (const secret of ['AT-SECRET-ONE', 'RT-SECRET-ONE', 'AT-SECRET-TWO', 'RT-SECRET-TWO']) {
    assert.ok(!text.includes(secret), `脱敏导出不得含 ${secret}`);
  }
  assert.strictEqual(env.sections['accounts-workbuddy'].redacted, true, '分区标 redacted');
  assert.strictEqual(env.sections['accounts-workbuddy'].data[0].nickname, '一', '非凭据字段保留');

  // 含凭据形态：原文在
  const envFull = buildEnvelope([spec], { includeCredentials: true });
  assert.ok(JSON.stringify(envFull).includes('AT-SECRET-ONE'));
  assert.strictEqual(envFull.sections['accounts-workbuddy'].redacted, false);
});

test('信封形状：format/version/generatedAt 齐全', () => {
  const env = buildEnvelope([MM_SPEC], { includeCredentials: false });
  assert.strictEqual(env.format, 'dumate2api-backup');
  assert.strictEqual(env.version, 1);
  assert.ok(env.generatedAt, 'generatedAt 打点');
  assert.strictEqual(env.includeCredentials, false);
});

test('接线自证：4 条路由注册进 admin/server.js（防模块写好、无调用方）', () => {
  const b = fs.readFileSync('src/admin/routes/backup.js', 'utf8');
  for (const p of ['/sections', '/export', '/preview', '/import']) {
    assert.ok(b.includes(`path: '${p}'`), `路由存在: ${p}`);
  }
  const s = fs.readFileSync('src/admin/server.js', 'utf8');
  assert.ok(s.includes("require('./routes/backup').routes"), 'server.js 已挂载 /backup');
});
