// test/unit/agent-setup-preview.test.js - 写入前差异预览（调研 P2-10）
//
// 这套东西**直接改用户本机配置文件**（~/.claude/settings.json、~/.codex/config.toml）。
// 有备份与还原，但「点写入之前会变成什么样」原先看不到，而合并规则（深合并 /
// 受管块替换）对用户是不透明的。本文件钉四条：
//   1. 预览**不碰磁盘**（不写配置、不建备份、不更新索引）
//   2. 预览与写入是**同一份计算**（`buildNext`）：apply 写出去的内容必须等于
//      preview 展示的那一份——两份实现漂移的表现是「预览说没问题、写进去不是那样」
//   3. diff 本身要对（行级 LCS：增/删/改/CRLF/空文件/超上限）
//   4. 预览里**密钥打码**：diff 会原样包含 token 行，明文回显等于把 key 送进浏览器历史
//
// 运行：node --test test/unit/agent-setup-preview.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const setup = require('../../src/agent-setup');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-setup-preview-'));
}

// ---- diffLines：行级 LCS ----

test('diffLines：完全相同 → changed=false 且没有 ops', () => {
  const d = setup.diffLines('a\nb\n', 'a\nb\n');
  assert.strictEqual(d.changed, false);
  assert.deepStrictEqual(d.ops, []);
  assert.strictEqual(d.added, 0);
  assert.strictEqual(d.removed, 0);
});

test('diffLines：增、删、改各一行，行号两侧对齐', () => {
  const d = setup.diffLines('a\nb\nc', 'a\nc\nd');
  assert.strictEqual(d.changed, true);
  assert.strictEqual(d.removed, 1);
  assert.strictEqual(d.added, 1);
  assert.deepStrictEqual(d.ops, [
    { t: ' ', a: 1, b: 1, text: 'a' },
    { t: '-', a: 2, b: null, text: 'b' },
    { t: ' ', a: 3, b: 2, text: 'c' },
    { t: '+', a: null, b: 3, text: 'd' },
  ]);
});

test('diffLines：CRLF 归一、空文件、末尾换行都不制造假差异', () => {
  assert.strictEqual(setup.diffLines('a\r\nb', 'a\nb').changed, false, 'CRLF 与 LF 视为同一内容');
  assert.strictEqual(setup.diffLines('a\nb\n', 'a\nb').changed, false, '末尾换行不算差异');
  const fromEmpty = setup.diffLines('', 'x\ny');
  assert.strictEqual(fromEmpty.added, 2);
  assert.deepStrictEqual(fromEmpty.ops.map((o) => o.t), ['+', '+']);
  const toEmpty = setup.diffLines('x', '');
  assert.strictEqual(toEmpty.removed, 1);
});

test('diffLines：超过上限只报统计，不返回明细（避免一次渲染上万行）', () => {
  const big = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
  const d = setup.diffLines(big, `${big}\nextra`, { maxLines: 10 });
  assert.strictEqual(d.changed, true);
  assert.strictEqual(d.truncated, true);
  assert.deepStrictEqual(d.ops, []);
  assert.ok(d.added > 0);
});

// ---- maskSecret ----

test('maskSecret：长值留后四位，短值整段打码，空密钥不动', () => {
  assert.strictEqual(setup.maskSecret('token = "sk-abcdefgh1234"', 'sk-abcdefgh1234'), 'token = "••••1234"');
  assert.strictEqual(setup.maskSecret('token = "short"', 'short'), 'token = "••••"', '短值留后四位等于泄露一半');
  assert.strictEqual(setup.maskSecret('没有密钥', ''), '没有密钥');
});

// ---- preview：不碰磁盘 + 与 apply 同一份计算 ----

test('preview：不写文件、不建备份、不更新索引，也不再回显明文 token', async () => {
  const root = tmpRoot();
  const writes = [];
  let existsCalls = 0;
  const io = {
    exists: () => { existsCalls += 1; return false; },   // 配置文件不存在
    read: () => { throw new Error('不该读：exists=false'); },
    write: (f, c) => { writes.push([f, c]); },
  };
  try {
    const before = fs.readdirSync(root);
    const r = await setup.preview({ client: 'codex', channel: 'dumate', token: 'sk-previewsecret-9999', root, io });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.exists, false);
    assert.strictEqual(r.changed, true, '从零创建必然有改动');
    assert.strictEqual(writes.length, 0, '预览绝不能写文件');
    assert.deepStrictEqual(fs.readdirSync(root), before, '预览也不能建备份目录');
    assert.ok(existsCalls >= 1);
    // 密钥打码：diff 行里不能出现明文
    const joined = r.ops.map((o) => o.text).join('\n');
    assert.ok(!joined.includes('sk-previewsecret-9999'), 'diff 回显明文等于把 key 送进浏览器历史');
    assert.ok(joined.includes('••••9999'), '打码后应留后四位便于核对');
    assert.match(r.note, /config\.toml|受管块|重启/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preview 展示的就是 apply 会写的内容（同一份 buildNext）', async () => {
  const root = tmpRoot();
  const writes = [];
  const existing = JSON.stringify({ model: 'sonnet', env: { KEEP: '1' } }, null, 2);
  const io = {
    exists: () => true,
    read: () => existing,
    write: (f, c) => { writes.push(c); },
  };
  try {
    const params = { client: 'claude-code', channel: 'dumate', token: 'sk-abcdefgh1234', root, io };
    const pv = await setup.preview(params);
    const next = (await setup.buildNext(params)).next;
    await setup.apply(params);
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0], next, 'apply 写出的内容必须等于 buildNext 的产物');
    // 预览的 + 行应该能把 next 的行覆盖到（不去逐行比对 diff 算法，只锁「预览不是另一套东西」）
    const plus = pv.ops.filter((o) => o.t === '+').map((o) => o.text);
    assert.ok(plus.length > 0, '有新增行');
    assert.ok(plus.some((t) => t.includes('ANTHROPIC_BASE_URL')), '新增行里应有写入的 env 键');
    assert.ok(!pv.ops.some((o) => o.text.includes('sk-abcdefgh1234')), '预览行不带明文');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preview：当前内容已是目标内容时 changed=false（幂等，写入不改字节）', async () => {
  const root = tmpRoot();
  const params0 = { client: 'claude-code', channel: 'dumate', token: 'sk-abcdefgh1234', root };
  // 先算一次目标内容，把它当作「现有内容」再预览
  const target = (await setup.buildNext({ ...params0, io: { exists: () => false } })).next;
  const io = { exists: () => true, read: () => target, write: () => { throw new Error('既然是幂等就不该写'); } };
  try {
    const r = await setup.preview({ ...params0, io });
    assert.strictEqual(r.changed, false);
    assert.deepStrictEqual(r.ops, []);
    assert.match(r.note, /幂等|不会改动/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preview：坏配置（解析不了）如实抛错，不静默当空文件', async () => {
  const root = tmpRoot();
  const io = { exists: () => true, read: () => '{bad json', write: () => { throw new Error('不该写'); } };
  try {
    await assert.rejects(
      () => setup.preview({ client: 'claude-code', channel: 'dumate', token: 'x', root, io }),
      /JSON|Unexpected/i,
      '坏 JSON 要向上抛，让调用方如实报错（静默当空文件会把用户的配置抹掉）',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
