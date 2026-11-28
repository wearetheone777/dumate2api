// Qoder 出站身份句守卫（P0-1）离线验证
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// 隔离运行期配置：DUMATE_ADMIN_DATA 必须在 require runtime 之前钉住
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-ig-'));
process.env.DUMATE_ADMIN_DATA = tmp;
delete process.env.DUMATE_QODER_IDENTITY_GUARD;

const guard = require('../../src/qoder/identity-guard');
const runtime = require('../../src/qoder/runtime');
const chat = require('../../src/qoder/chat');
const channelPool = require('../../src/channel-pool');

function setup(on) {
  runtime._resetForTest();
  if (on) runtime.Store({ identityGuard: { enabled: true } });
  else { try { fs.unlinkSync(path.join(tmp, runtime.FILE)); } catch (e) {} runtime._resetForTest(); }
}

test('默认关闭时 guardBody 零改动', () => {
  setup(false);
  const body = { messages: [{ role: 'system', content: 'You are Codex, a coding agent.' }] };
  const ref = JSON.stringify(body);
  assert.equal(guard.enabled(), false);
  guard.guardBody(body);
  assert.equal(JSON.stringify(body), ref);
});

test('模式 A：You are <品牌>, 命中并只插一个空格', () => {
  for (const s of ['You are ZCode, a coding agent.', 'You are Claude Code, official CLI.', 'You are Codex,', 'You are DeepSeek-Harness, ok', 'You are GPT-5, go']) {
    const out = guard.neutralize(s);
    assert.ok(out.includes(' ,'), out);
    assert.equal(out.replace(' ,', ','), s);
  }
});

test('模式 B：powered by <品牌>. 命中并只插一个空格', () => {
  assert.equal(guard.neutralize('You are an AI agent powered by DeepSeekRuntime.'), 'You are an AI agent powered by DeepSeekRuntime .');
  assert.equal(guard.neutralize('powered by Claude Code.'), 'powered by Claude Code .');
});

test('自家品牌 Qoder 豁免（前缀逐字节不变）', () => {
  assert.equal(guard.neutralize('You are Qoder, a coding agent.'), 'You are Qoder, a coding agent.');
  assert.equal(guard.neutralize('powered by Qoder.'), 'powered by Qoder.');
});

test('不命中形态：逗号/句号前已有空格、大小写、裸词、无标点', () => {
  const cases = [
    'You are ZCode , a coding agent.',
    'You are zcode, a coding agent.',
    'You are ZCode.',
    'You are ZCode\nnext',
    'I am using DeepSeekRuntime',
    'You are a helpful assistant,',
    'powered by the DeepSeekRuntime.',
    'powered by DeepSeekRuntime .',
  ];
  for (const s of cases) assert.equal(guard.neutralize(s), s, s);
});

test('幂等：中和两次结果相同', () => {
  const s = 'You are Claude Code, official CLI.';
  const once = guard.neutralize(s);
  assert.equal(guard.neutralize(once), once);
});

test('覆盖字符串 / parts / reasoning_content；tool 消息不碰', () => {
  setup(true);
  const body = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'You are Codex, helper.' }] },
      { role: 'user', content: 'You are ZCode, user?' },
      { role: 'assistant', content: 'ok', reasoning_content: 'powered by DeepSeekRuntime.' },
      { role: 'tool', content: 'You are Codex, tool output.' },
    ],
  };
  guard.guardBody(body);
  assert.equal(body.messages[0].content[0].text, 'You are Codex , helper.');
  assert.equal(body.messages[1].content, 'You are ZCode , user?');
  assert.equal(body.messages[2].reasoning_content, 'powered by DeepSeekRuntime .');
  assert.equal(body.messages[3].content, 'You are Codex, tool output.');
});

test('DUMATE_QODER_IDENTITY_GUARD=1 开关生效', () => {
  setup(false);
  process.env.DUMATE_QODER_IDENTITY_GUARD = '1';
  assert.equal(guard.enabled(), true);
  delete process.env.DUMATE_QODER_IDENTITY_GUARD;
  assert.equal(guard.enabled(), false);
});

test('会话键：守卫在 sessionKeyFor 之后执行，粘性键不被出站改写抖动', () => {
  setup(true);
  const payload = {
    messages: [
      { role: 'system', content: 'You are Codex, a coding agent.' },
      { role: 'user', content: '继续写第 3 章' },
    ],
  };
  // 与 index.send 同顺序：先取会话键（原文），再 guarding（只改出站字节）
  const sticky = channelPool.sessionKeyFor(payload);
  guard.guardBody(payload);
  const a = JSON.parse(chat.buildBody('gfmodel', payload));
  assert.ok(sticky.startsWith('m:'));
  // 同一被守卫的 payload 重跑，session_id 稳定
  const b = JSON.parse(chat.buildBody('gfmodel', payload));
  assert.equal(a.session_id, b.session_id);
});

test('真实探针形态中和后可进入 buildBody，字节稳定', () => {
  setup(true);
  const payload = {
    model: 'kmodel_latest',
    messages: [
      { role: 'system', content: 'You are Codex, a coding agent.\n' + '这是一段填充文本。'.repeat(20) },
      { role: 'user', content: '继续' },
    ],
  };
  guard.guardBody(payload);
  const a = JSON.parse(chat.buildBody('kmodel_latest', payload));
  const b = JSON.parse(chat.buildBody('kmodel_latest', payload));
  assert.equal(a.session_id, b.session_id);
  assert.equal(a.business.id, b.business.id);
  assert.notEqual(a.request_id, b.request_id);  // request_id 每轮必须变，别的都不该变
  assert.ok(a.system.includes('You are Codex ,'));
  assert.ok(!a.system.includes('You are Codex,'));
});

test('配置白名单：identityGuard.enabled 合法值', () => {
  runtime._resetForTest();
  assert.throws(() => runtime.Store({ identityGuard: { bogus: 1 } }), /未知配置键/);
  assert.throws(() => runtime.Store({ identityGuard: { enabled: 'yes' } }), /boolean|true|false/i);
  assert.equal(runtime.Store({ identityGuard: { enabled: false } }).config.identityGuard.enabled, false);
});
