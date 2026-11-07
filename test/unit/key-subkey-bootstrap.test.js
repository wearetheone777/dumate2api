// test/unit/key-subkey-bootstrap.test.js - 首启凭证自举 + 子 Key（P2-9 / P2-8）
//
// 覆盖：
//   1. ensureFirstRun 的触发条件（回环不生成 / 非回环且无 key 生成 / 已有 key 不生成）
//   2. 子 Key 的创建约束（父必须存在、只支持两级）
//   3. 吊销级联（父停用 / 删除 → 子 Key parent_revoked）
//   4. 家庭配额（子的消耗占用父的额度；子自身限额是额外收紧；token 双记）
//   5. update 的父子约束（不能自己当父、已当父的不能变子）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-subkey-'));
process.env.DUMATE_ADMIN_DATA = TMP;
delete process.env.DUMATE_KEY_QUOTA;

const keys = require('../../src/keys');
const quota = require('../../src/key-quota');

// ==================== 首启凭证自举 ====================

test('首启自举：回环地址/空 host 不生成', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1', '']) {
    assert.strictEqual(keys.ensureFirstRun(h), null, `${h || '(空)'} 不该触发`);
  }
  assert.strictEqual(keys.list().length, 0, '回环地址不产生任何 key');
});

test('首启自举：非回环 + 无 key → 生成且 token 可解析', () => {
  const r = keys.ensureFirstRun('0.0.0.0');
  assert.ok(r && r.token, '返回明文 token（由启动日志打印一次）');
  assert.ok(r.token.startsWith(keys.PREFIX), 'token 前缀正确');
  assert.strictEqual(r.key.name, 'first-run');
  assert.strictEqual(r.key.note, '监听非回环地址且无任何 Key 时自动生成');
  const k = keys.resolve(r.token);
  assert.ok(k && k.id === r.key.id, '生成的 token 能通过 resolve');
});

test('首启自举：已有 key 不再生成', () => {
  assert.strictEqual(keys.ensureFirstRun('192.168.1.5'), null);
  assert.strictEqual(keys.list().length, 1, '还是只有 first-run 那一把');
});

// ==================== 子 Key 创建约束 ====================

test('子 Key：create 带 parent_id；父不存在与三级链被拒', () => {
  const parent = keys.create({ name: 'p1' });
  const child = keys.create({ name: 'c1', parent_id: parent.key.id });
  assert.strictEqual(child.key.parent_id, parent.key.id);

  assert.throws(() => keys.create({ name: 'x', parent_id: 99999 }), /不存在/);
  assert.throws(
    () => keys.create({ name: 'g', parent_id: child.key.id }),
    /两级/,
    '父 Key 本身是子 Key 时拒绝（杜绝三级链）',
  );
});

// ==================== 吊销级联 ====================

test('子 Key：父停用/过期/删除 → parent_revoked', () => {
  const parent = keys.create({ name: 'p2' });
  const child = keys.create({ name: 'c2', parent_id: parent.key.id });
  assert.strictEqual(keys.validate(keys.resolve(child.token), '127.0.0.1').ok, true);

  keys.update(parent.key.id, { enabled: false });
  let v = keys.validate(keys.resolve(child.token), '127.0.0.1');
  assert.strictEqual(v.reason, 'parent_revoked', '父停用即子失效');

  keys.update(parent.key.id, { enabled: true });
  assert.strictEqual(keys.validate(keys.resolve(child.token), '127.0.0.1').ok, true, '父恢复即子恢复');

  keys.remove(parent.key.id);
  v = keys.validate(keys.resolve(child.token), '127.0.0.1');
  assert.strictEqual(v.reason, 'parent_revoked', '父删除即子失效（吊销级联）');
});

// ==================== 家庭配额 ====================

test('家庭配额：子的请求占用父的额度', () => {
  const parent = keys.create({ name: 'p3', daily_limit: { requests: 2 } });
  const child = keys.create({ name: 'c3', parent_id: parent.key.id });
  const k = () => keys.resolve(child.token);

  assert.strictEqual(keys.validate(k(), '127.0.0.1').ok, true, '第 1 发');
  assert.strictEqual(keys.validate(k(), '127.0.0.1').ok, true, '第 2 发');
  const v = keys.validate(k(), '127.0.0.1');
  assert.strictEqual(v.reason, 'quota_exceeded', '第 3 发被父配额挡住');
  assert.ok(v.detail.includes('主 Key'), `文案指明是父 Key 的额度：${v.detail}`);
  assert.ok(v.reset_at > Date.now(), 'verdict 带 reset_at');
});

test('家庭配额：子 Key 自己的限额是额外收紧（父还有额度也挡）', () => {
  const parent = keys.create({ name: 'p4', daily_limit: { requests: 100 } });
  const child = keys.create({ name: 'c4', parent_id: parent.key.id, daily_limit: { requests: 1 } });
  const k = () => keys.resolve(child.token);

  assert.strictEqual(keys.validate(k(), '127.0.0.1').ok, true);
  const v = keys.validate(k(), '127.0.0.1');
  assert.strictEqual(v.reason, 'quota_exceeded');
  assert.ok(!v.detail.includes('主 Key'), `是子自身限额而不是父的：${v.detail}`);
});

test('家庭配额：token 双记（子的 token 计入父桶）', () => {
  const parent = keys.create({ name: 'p5', daily_limit: { tokens: 100 } });
  const child = keys.create({ name: 'c5', parent_id: parent.key.id });

  quota.addTokens(child.key.id, 120, { familyId: parent.key.id });
  assert.ok(quota.todayOf(parent.key.id).tokens >= 120, '父桶收到子的 token');

  // 子自身没设 token 限额、父设了 → 下一发被父桶挡住
  const v = keys.validate(keys.resolve(child.token), '127.0.0.1');
  assert.strictEqual(v.reason, 'quota_exceeded');
  assert.ok(v.detail.includes('主 Key'), `父桶 token 判定：${v.detail}`);
});

// ==================== update 的父子约束 ====================

test('update：不能自己当父；已当父的 Key 不能变成子；可设可清', () => {
  const a = keys.create({ name: 'ua' });
  const b = keys.create({ name: 'ub' });
  keys.create({ name: 'uc', parent_id: a.key.id });

  assert.throws(() => keys.update(a.key.id, { parent_id: a.key.id }), /自己/);
  assert.throws(
    () => keys.update(a.key.id, { parent_id: b.key.id }),
    /已被其他 Key 引用为父/,
    'a 已是 uc 的父，不能再变子（否则成三级链）',
  );

  const set = keys.update(b.key.id, { parent_id: a.key.id });
  assert.strictEqual(set.parent_id, a.key.id);
  const cleared = keys.update(b.key.id, { parent_id: null });
  assert.strictEqual(cleared.parent_id, null);
});
