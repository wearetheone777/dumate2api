// test/unit/workbuddy-modelrules.test.js - 「模型规则」按账号 deny/allow（批次十二，misakano modelrules.go 移植）
//
// 语义定案（modelrules.go 口径，与 src/workbuddy/rules.js 头注释同源）：
//   deny 并集 / allow 并集 / **deny 优先**；裸名两域命中，cn:/global: 只命中
//   本域；allow 规则在账号所属域零命中 → 这条规则视作没挂（防跨域误挂封死）。
//   全部候选被拦 → 400 model_not_allowed（不是 503：规则不会自愈，503 会被
//   客户端当上游抖动重试白打）。
//
// 与 send() 的接线用**源码自证**锁（防「模块写好、无调用方」——本仓
// qoder-telemetry / workbuddy-free-exempt 的接线回归同一模式）。
//
// 运行：node --test test/unit/workbuddy-modelrules.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-wb-rules');
process.env.DUMATE_ADMIN_DATA = TMP;

const rules = require('../../src/workbuddy/rules');

function reset() {
  fs.rmSync(rules._filePath(), { force: true });
}

test('normalizeRule：校验与归一（名称 / 模式别名 / models 去重排序小写）', () => {
  assert.ok(rules.normalizeRule(null).error, '非对象报错');
  assert.ok(rules.normalizeRule({ mode: 'deny', models: ['hy4std'] }).error, '空名报错');
  assert.ok(
    rules.normalizeRule({ name: 'x'.repeat(41), mode: 'deny', models: ['hy4std'] }).error,
    '超 40 字报错',
  );
  assert.ok(rules.normalizeRule({ name: 'a', mode: 'grey', models: ['hy4std'] }).error, '未知模式报错');
  assert.ok(rules.normalizeRule({ name: 'a', mode: 'deny', models: [] }).error, '空 models 报错');
  assert.ok(rules.normalizeRule({ name: 'a', mode: 'deny', models: ['  '] }).error, '空白 models 报错');

  // 模式别名归一（blacklist/black/white/whitelist 同义）
  for (const [raw, want] of [['blacklist', 'deny'], ['black', 'deny'], ['DENY', 'deny'],
    ['white', 'allow'], ['whitelist', 'allow'], ['Allow', 'allow']]) {
    const r = rules.normalizeRule({ name: 'a', mode: raw, models: ['hy4std'] });
    assert.strictEqual(r.rule.mode, want, `mode ${raw} → ${want}`);
  }

  // models：小写、去重、排序；域前缀保留。注意 global:hy4std 与裸名 hy4std
  // 是**不同条目**（前缀是区分依据）——去重只对完全相同的字符串生效。
  const r = rules.normalizeRule({
    name: 'a', mode: 'deny',
    models: ['Global:Hy4Std', 'global:hy4std', 'CN:AAA', 'cn:aaa', 'Auto'],
  });
  assert.deepStrictEqual(r.rule.models, ['auto', 'cn:aaa', 'global:hy4std']);
  assert.ok(r.rule.updatedAt, 'updatedAt 打点');
  assert.ok(!r.rule.error);
});

test('upsert：新建生成 id；带 id 更新必须已存在（404，不静默建新）', () => {
  reset();
  const created = rules.upsertRule({ name: '黑名单A', mode: 'deny', models: ['hy4std'] });
  assert.ok(created.id, '空 id 自动生成');
  assert.strictEqual(rules.getRule(created.id).name, '黑名单A');

  const updated = rules.upsertRule({ id: created.id, name: '黑名单A改', mode: 'allow', models: ['free-b'] });
  assert.strictEqual(updated.id, created.id, '更新复用同一 id');
  assert.strictEqual(rules.getRule(created.id).mode, 'allow');

  assert.throws(() => rules.upsertRule({ id: 'no-such', name: 'x', mode: 'deny', models: ['m'] }),
    (e) => e.statusCode === 404, '未知 id 更新 → 404');
});

test('assignRules：整体替换 + 未知规则拒绝 + 空数组清空不留行', () => {
  reset();
  const r1 = rules.upsertRule({ name: 'r1', mode: 'deny', models: ['m1'] });
  const r2 = rules.upsertRule({ name: 'r2', mode: 'allow', models: ['m2'] });

  assert.throws(() => rules.assignRules('acc1', [r1.id, 'wild-id']),
    (e) => e.statusCode === 404, '野 id 拒绝，避免静默进账');

  rules.assignRules('acc1', [r2.id, r1.id]);
  assert.deepStrictEqual(rules.ruleIdsOf('acc1'), [r1.id, r2.id].sort(), '排序稳定');

  rules.assignRules('acc1', [r1.id]);
  assert.deepStrictEqual(rules.ruleIdsOf('acc1'), [r1.id], '整体替换（不是追加）');

  rules.assignRules('acc1', []);
  assert.deepStrictEqual(rules.ruleIdsOf('acc1'), [], '全摘');
  assert.strictEqual(Object.keys(rules.ruleAssignments()).length, 0, '摘空不留 assignment 行');

  assert.deepStrictEqual(rules.assignRules('acc1', 'not-array'), [], '非数组按空处理');
});

test('applyRule：只增删这一条 + 幂等不计入变化', () => {
  reset();
  const r1 = rules.upsertRule({ name: 'r1', mode: 'deny', models: ['m1'] });
  const r2 = rules.upsertRule({ name: 'r2', mode: 'deny', models: ['m2'] });

  assert.throws(() => rules.applyRule('no-such', ['a1'], true), (e) => e.statusCode === 404);

  assert.strictEqual(rules.applyRule(r1.id, ['a1', 'a2'], true), 2, '挂上计变化');
  rules.applyRule(r2.id, ['a1'], true); // 追加走 applyRule（assignRules 是整体替换，会把 r1 冲掉）
  assert.deepStrictEqual(rules.ruleIdsOf('a1'), [r1.id, r2.id].sort(), 'apply 不动账号原有的其它规则');

  assert.strictEqual(rules.applyRule(r1.id, ['a1', 'a2'], true), 0, '已是目标态 → changed=0（幂等）');
  assert.strictEqual(rules.applyRule(r1.id, ['a3'], false), 0, '没挂过的摘 → changed=0');

  assert.strictEqual(rules.applyRule(r1.id, ['a1'], false), 1);
  assert.deepStrictEqual(rules.ruleIdsOf('a1'), [r2.id], '只摘这一条');
});

test('deleteRule：摘掉全部引用 + 删空 assignment 行；不存在返回 false', () => {
  reset();
  const r1 = rules.upsertRule({ name: 'r1', mode: 'deny', models: ['m1'] });
  const r2 = rules.upsertRule({ name: 'r2', mode: 'deny', models: ['m2'] });
  rules.assignRules('a1', [r1.id, r2.id]);
  rules.assignRules('a2', [r1.id]);

  assert.strictEqual(rules.deleteRule('no-such'), false);
  assert.strictEqual(rules.deleteRule(r1.id), true);
  assert.strictEqual(rules.getRule(r1.id), null);
  assert.deepStrictEqual(rules.ruleIdsOf('a1'), [r2.id], '其它规则原样保留');
  assert.deepStrictEqual(rules.ruleIdsOf('a2'), [], '引用被摘');
  assert.strictEqual(rules.ruleAccountCounts()[r2.id], 1, '计数只剩真挂的');
  assert.ok(!('a2' in rules.ruleAssignments()), 'a2 摘空后行被删');
});

test('expandFor：裸名两域命中；cn:/global: 只命中账号本域', () => {
  reset();
  const denyBare = rules.upsertRule({ name: 'd-bare', mode: 'deny', models: ['hy4std'] });
  const denyCN = rules.upsertRule({ name: 'd-cn', mode: 'deny', models: ['cn:onlycn', 'global:onlygl'] });

  rules.assignRules('acc-cn', [denyBare.id, denyCN.id]);

  const cnView = rules.expandFor('acc-cn', 'cn');
  assert.ok(cnView.deny.has('hy4std'), '裸名在 cn 生效');
  assert.ok(cnView.deny.has('onlycn'), 'cn: 在 cn 生效');
  assert.ok(!cnView.deny.has('onlygl'), 'global: 在 cn 不生效');

  const glView = rules.expandFor('acc-cn', 'global');
  assert.ok(glView.deny.has('hy4std'), '裸名在 global 生效');
  assert.ok(glView.deny.has('onlygl'), 'global: 在 global 生效');
  assert.ok(!glView.deny.has('onlycn'), 'cn: 在 global 不生效');

  // 大写域前缀同样归一（normalizeRuleModel 已小写，splitRealmModel 再兜一层）
  const d2 = rules.upsertRule({ name: 'd-upper', mode: 'deny', models: ['CN:upper'] });
  rules.assignRules('acc2', [d2.id]);
  assert.ok(rules.expandFor('acc2', 'cn').deny.has('upper'));
  assert.ok(!rules.expandFor('acc2', 'global').deny.has('upper'));
});

test('expandFor：allow 本域零命中 → 这条规则视作没挂（防跨域误挂封死）', () => {
  reset();
  const allowCNOnly = rules.upsertRule({ name: 'w-cn', mode: 'allow', models: ['cn:hy4std', 'cn:free-a'] });
  rules.assignRules('gl-acc', [allowCNOnly.id]);

  const glView = rules.expandFor('gl-acc', 'global');
  assert.strictEqual(glView.hasAllow, false, 'global 号挂纯 cn: 白名单 → 规则没挂');
  assert.strictEqual(glView.allow.size, 0);
  assert.strictEqual(rules.blockedByRules('gl-acc', 'global', 'whatever'), false,
    '没有被白名单封死所有模型');

  // 同一条规则挂在 cn 号上就正常生效
  rules.assignRules('cn-acc', [allowCNOnly.id]);
  const cnView = rules.expandFor('cn-acc', 'cn');
  assert.strictEqual(cnView.hasAllow, true);
  assert.ok(cnView.allow.has('hy4std'));
  assert.strictEqual(rules.blockedByRules('cn-acc', 'cn', 'other'), true, '白名单之外被拦');
});

test('blockedByRules：deny 优先于 allow；auto/空不判；入参带域前缀剥掉比对', () => {
  reset();
  const deny = rules.upsertRule({ name: 'd', mode: 'deny', models: ['dangerous'] });
  const allow = rules.upsertRule({ name: 'w', mode: 'allow', models: ['dangerous', 'safe-a', 'safe-b'] });
  rules.assignRules('acc', [deny.id, allow.id]);

  // deny 与 allow 并存：deny 里的模型即使进了白名单也拦（显式禁用更明确）
  assert.strictEqual(rules.blockedByRules('acc', 'cn', 'dangerous'), true);
  assert.strictEqual(rules.blockedByRules('acc', 'cn', 'safe-a'), false);
  assert.strictEqual(rules.blockedByRules('acc', 'cn', 'not-in-list'), true, '白名单之外');

  // 入参带域前缀：选号链路传裸名，排查链路可能带前缀，两种都能比对
  assert.strictEqual(rules.blockedByRules('acc', 'cn', 'cn:safe-a'), false);
  assert.strictEqual(rules.blockedByRules('acc', 'cn', 'global:dangerous'), true);

  // 'auto' 档位实际模型由账号决定，规则无从比对；空模型同理
  assert.strictEqual(rules.blockedByRules('acc', 'cn', 'auto'), false);
  assert.strictEqual(rules.blockedByRules('acc', 'cn', ''), false);
  assert.strictEqual(rules.blockedByRules('acc', 'cn', undefined), false);

  // 没挂任何规则的账号不拦任何模型
  assert.strictEqual(rules.blockedByRules('bare-acc', 'cn', 'anything'), false);
});

test('filterAccounts：部分被拦保留其余；全拦 blockedCount 全量；auto 全保留', () => {
  reset();
  const deny = rules.upsertRule({ name: 'd', mode: 'deny', models: ['costly-model'] });
  rules.assignRules('acc-1', [deny.id]);

  const accs = [
    { id: 'acc-1', region: 'cn' },
    { id: 'acc-2', region: 'cn' },
  ];
  const part = rules.filterAccounts(accs, 'cn', 'costly-model');
  assert.deepStrictEqual(part.kept.map((a) => a.id), ['acc-2']);
  assert.deepStrictEqual(part.blockedIds, ['acc-1']);
  assert.strictEqual(part.blockedCount, 1);

  // 全拦：调用方据 blockedCount && !kept.length 回 400（send 集成见接线自证）
  const denyAll = rules.upsertRule({ name: 'd2', mode: 'deny', models: ['costly-model'] });
  rules.assignRules('acc-2', [denyAll.id]);
  const all = rules.filterAccounts(accs, 'cn', 'costly-model');
  assert.strictEqual(all.blockedCount, 2);
  assert.strictEqual(all.kept.length, 0);

  // 'auto' 档位不做模型级判断
  const auto = rules.filterAccounts(accs, 'cn', 'auto');
  assert.strictEqual(auto.kept.length, 2);
  assert.strictEqual(auto.blockedCount, 0);

  // 每账号按**自己的域**比对：cn 号拦 cn:xxx，global 号不拦
  const denyCN = rules.upsertRule({ name: 'd3', mode: 'deny', models: ['cn:cnonly'] });
  rules.assignRules('acc-cn', [denyCN.id]);
  const mixed = rules.filterAccounts(
    [{ id: 'acc-cn', region: 'cn' }, { id: 'acc-gl', region: 'global' }],
    '', 'cnonly',
  );
  assert.deepStrictEqual(mixed.kept.map((a) => a.id), ['acc-gl']);
});

test('mtime 热读：外部改文件后下次 load 重读（管理端改完网关零重启生效）', () => {
  reset();
  const r1 = rules.upsertRule({ name: 'r1', mode: 'deny', models: ['m1'] });
  // 外部进程直改文件（模拟另一进程的管理端写入）
  const p = rules._filePath();
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  data.rules[r1.id].models = ['m2'];
  const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  wait(5); // 让 mtime 走出同毫秒
  fs.writeFileSync(p, JSON.stringify(data));
  assert.deepStrictEqual(rules.getRule(r1.id).models, ['m2'], 'mtime 变化触发重读');
});

test('接线自证：send() 调 filterAccounts 且全拦回 modelNotAllowed；管理端 5 条路由带审计', () => {
  const idx = fs.readFileSync('src/workbuddy/index.js', 'utf8');
  assert.ok(idx.includes("require('./rules').filterAccounts"), 'send 选号链调用 filterAccounts');
  assert.ok(idx.includes('e.modelNotAllowed'), '全拦带 modelNotAllowed 标记');
  assert.ok(idx.includes('400'), '全拦回 4xx（不是 503）');

  const rt = fs.readFileSync('src/admin/routes/workbuddy.js', 'utf8');
  for (const path of ['/model-rules', '/model-rules/:id', '/model-rules/assign', '/model-rules/apply']) {
    assert.ok(rt.includes(`path: '${path}'`), `路由存在: ${path}`);
  }
  for (const audit of ['workbuddy_rule_upsert', 'workbuddy_rule_delete', 'workbuddy_rule_assign', 'workbuddy_rule_apply']) {
    assert.ok(rt.includes(`'${audit}'`), `审计存在: ${audit}`);
  }
});
