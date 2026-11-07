// test/unit/agent-setup.test.js - 智能体一键配置（2026-11-07 融合项 P0-2）
//
// 全部走临时目录 + IO 注入，不读写真实 ~/.claude / ~/.codex。
// 钉三条纪律：只动自己的键（深合并 / 托管键移除）、写前备份可还原、
// 响应不回显密钥。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const setup = require('../../src/agent-setup');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-setup-test-'));
}

// ---- Claude Code：settings.json 深合并 ----

test('mergeClaudeSettings：只 upsert env 里我们的键，其他键原样保留', () => {
  const existing = JSON.stringify({
    model: 'sonnet',
    permissions: { allow: ['Bash'] },
    env: { CUSTOM_VAR: 'keep-me', ANTHROPIC_BASE_URL: 'http://old:1' },
  });
  const out = JSON.parse(setup.mergeClaudeSettings(existing, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9080' }));
  assert.equal(out.model, 'sonnet');
  assert.deepEqual(out.permissions, { allow: ['Bash'] });
  assert.equal(out.env.CUSTOM_VAR, 'keep-me', '用户自己的 env 键不动');
  assert.equal(out.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9080');
});

test('mergeClaudeSettings：幂等；空文件/坏 JSON 的行为', () => {
  const once = setup.mergeClaudeSettings('', { A: '1' });
  assert.equal(setup.mergeClaudeSettings(once, { A: '1' }), once, '重复 apply 产出一致');
  assert.throws(() => setup.mergeClaudeSettings('{bad json', { A: '1' }), SyntaxError, '坏 JSON 向上抛，调用方如实报错');
});

// ---- Codex：config.toml 托管键合并 ----

const TOP = ['model_provider = "dumate2api-dumate"', 'model = "dm-auto-model/text.L0"'];
const PROVIDER = ['[model_providers.dumate2api-dumate]', 'base_url = "http://127.0.0.1:9080/v1"'];

test('mergeCodexToml：顶层键插在首个表头之前（TOML 语义——追加到尾会掉进别的表）', () => {
  const existing = ['model = "gpt-5"', 'favorite = true', '', '[profiles.work]', 'model = "o3"'].join('\n');
  const out = setup.mergeCodexToml(existing, { topLines: TOP, providerLines: PROVIDER });
  const lines = out.split('\n');
  const topIdx = lines.findIndex((l) => l.startsWith('model_provider ='));
  const firstHeader = lines.findIndex((l) => l.startsWith('['));
  assert.ok(topIdx !== -1 && topIdx < firstHeader, '托管顶层键必须在任何表头之前');
  assert.ok(lines.includes('model = "o3"'), '用户 [profiles.work] 表里的 model 不许动');
  assert.ok(!lines.includes('model = "gpt-5"'), '顶层默认 model 被接管（apply 的本意）');
  assert.equal(lines.filter((l) => l.startsWith('model_provider =')).length, 1, '不产生重复顶层键');
});

test('mergeCodexToml：幂等——重复 apply 不叠出第二份 provider 表', () => {
  const once = setup.mergeCodexToml('', { topLines: TOP, providerLines: PROVIDER });
  const twice = setup.mergeCodexToml(once, { topLines: TOP, providerLines: PROVIDER });
  assert.equal(twice, once);
  const withUser = setup.mergeCodexToml('[profiles.x]\nkey = "v"\n', { topLines: TOP, providerLines: PROVIDER });
  const withUserTwice = setup.mergeCodexToml(withUser, { topLines: TOP, providerLines: PROVIDER });
  assert.equal(withUserTwice, withUser, '带用户表时同样幂等');
  assert.equal(withUserTwice.match(/^\[model_providers\.dumate2api/gm).length, 1);
});

test('mergeCodexToml：旧的托管 provider 表整块替换，用户的 provider 不碰', () => {
  const existing = [
    '[model_providers.dumate2api-qoder]',
    'base_url = "http://old/v1"',
    'extra = "stale"',
    '',
    '[model_providers.mine]',
    'base_url = "http://mine/v1"',
  ].join('\n');
  const out = setup.mergeCodexToml(existing, { topLines: TOP, providerLines: PROVIDER });
  assert.ok(!out.includes('dumate2api-qoder'), '旧托管表被整块移除');
  assert.ok(out.includes('[model_providers.mine]'), '用户自己的 provider 原样保留');
  assert.ok(out.includes('http://mine/v1'));
  assert.ok(out.includes('[model_providers.dumate2api-dumate]'));
});

test('codexSnippet：顶层段在 provider 段之前（与 buildCodexConfig 同源拆分）', () => {
  const s = setup.codexSnippet('dumate', [{ prefixed: 'glm-5.2', name: 'GLM-5.2' }], { context_window: 1048576, compact_limit: 891289 }, 'tok', 'http://127.0.0.1:9080');
  assert.ok(s.topLines[0].startsWith('model_provider ='));
  assert.ok(s.providerLines[0].startsWith('[model_providers.'));
  assert.ok(s.providerLines.some((l) => l.includes('experimental_bearer_token = "tok"')), '内联鉴权');
});

// ---- 备份 / 还原 ----

test('backupConfig：留档 + 索引封顶 10 份 + 超出文件清理', () => {
  const root = tmpRoot();
  const cfg = path.join(root, 'fake-settings.json');
  try {
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(cfg, `v${i}`);
      setup.backupConfig('claude-code', cfg, root);
    }
    const idx = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
    assert.equal(idx['claude-code'].backups.length, 10);
    const dirFiles = fs.readdirSync(path.join(root, 'claude-code'));
    assert.equal(dirFiles.length, 10, '旧备份文件本体也删掉，目录不无界增长');
    assert.ok(setup.latestBackup('claude-code', root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply → restore 往返（Claude Code）：备份落盘、env 写入、还原回原样', async () => {
  const root = tmpRoot();
  const written = [];
  const original = JSON.stringify({ permissions: { allow: ['X'] }, env: { OLD: '1' } });
  const io = {
    exists: () => true,
    read: (f) => (written.length ? written[written.length - 1] : original),
    write: (f, c) => written.push(c),
  };
  try {
    const r = await setup.apply({
      client: 'claude-code', channel: 'dumate', token: 'sk-secret-1', root, io,
    });
    assert.equal(r.ok, true);
    assert.ok(r.backup, '配置文件存在时必须先备份');
    assert.ok(!JSON.stringify(r).includes('sk-secret-1'), '响应不回显密钥');
    const applied = JSON.parse(written[written.length - 1]);
    assert.equal(applied.env.ANTHROPIC_AUTH_TOKEN, 'sk-secret-1');
    assert.equal(applied.permissions.allow[0], 'X', '用户 permissions 保留');
    assert.ok(applied.env.ANTHROPIC_MODEL, '默认档位模型写入');

    const rr = setup.restore({ client: 'claude-code', root, io });
    assert.equal(rr.ok, true);
    assert.equal(written[written.length - 1], original, '还原 = 最近一份备份原样写回（逐字节）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply → restore 往返（Codex）：幂等重写 + 还原', async () => {
  const root = tmpRoot();
  const written = [];
  const io = {
    exists: () => false, // 首次 apply：无既有配置，也不备份
    read: () => { throw new Error('不该读不存在的文件'); },
    write: (f, c) => written.push(c),
  };
  try {
    const r = await setup.apply({ client: 'codex', channel: 'dumate', token: '', root, io });
    assert.equal(r.ok, true);
    assert.equal(r.backup, '', '文件不存在时没有备份可做');
    const first = written[written.length - 1];
    assert.ok(first.includes('[model_providers.dumate2api-dumate]'));
    assert.ok(first.includes('experimental_bearer_token = "nokey"'), '空 token 用 nokey 占位（与 cc-switch 同口径）');

    // 模拟重启用注入：把第一次产物当现有内容再 apply（幂等）
    const io2 = { exists: () => true, read: () => first, write: (f, c) => written.push(c) };
    const r2 = await setup.apply({ client: 'codex', channel: 'dumate', token: '', root, io: io2 });
    assert.equal(r2.ok, true);
    const second = written[written.length - 1];
    assert.equal(second.match(/^\[model_providers\.dumate2api/gm).length, 1, '重申请后仍只有一份 provider 表');

    const rr = setup.restore({ client: 'codex', root, io: io2 });
    assert.equal(rr.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply：非法 client 拒绝；restore 无备份时如实 404 语义', async () => {
  await assert.rejects(() => setup.apply({ client: 'cc-switch', root: tmpRoot(), io: { exists: () => false, read: () => '', write: () => {} } }),
    /cc-switch 走专用端点/);
  const root = tmpRoot();
  try {
    const rr = setup.restore({ client: 'codex', root, io: { exists: () => false, read: () => '', write: () => {} } });
    assert.equal(rr.ok, false);
    assert.ok(/没有.*备份/.test(rr.error));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detect：注入 read 时按网关地址判 configured', () => {
  const base = setup.gatewayBase();
  const ok = setup.detect('claude-code', { read: () => JSON.stringify({ env: { ANTHROPIC_BASE_URL: base } }) });
  assert.equal(ok.configured, true);
  const other = setup.detect('claude-code', { read: () => JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://1.2.3.4:9' } }) });
  assert.equal(other.configured, false);
  assert.ok(/非本网关/.test(other.detail), '指向别的地址要能看出来');
  const codex = setup.detect('codex', { read: () => '[model_providers.dumate2api-dumate]\nbase_url = "x"' });
  assert.equal(codex.configured, true);
});
