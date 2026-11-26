// test/unit/qwen-reasoning.test.js - 千问思考模式（2026-11-27 融合 P1-1）
//
// 锁两件事：
//   1. is_reasoning 由 DUMATE_QWENWORK_REASONING 控制（默认开启，设 0 关闭）
//   2. reasoning_effort 透传：low/medium/high/xhigh 进 parameters，
//      none/off 不注入，非法值忽略
const { test } = require('node:test');
const assert = require('assert');

const CONSTANTS = '../../src/qwenwork/constants';
const CHAT = '../../src/qwenwork/chat';
const mods = [CONSTANTS, CHAT];

function dropCache() {
  for (const m of mods) delete require.cache[require.resolve(m)];
}

function build(chat, model, payload) {
  return JSON.parse(chat.buildBody(model, payload));
}

test('is_reasoning: 默认开启', () => {
  dropCache();
  const chat = require(CHAT);
  const body = build(chat, 'pro', { messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(body.chat_context.extra.modelConfig.is_reasoning, true);
  assert.strictEqual(body.model_config.is_reasoning, true);
  dropCache();
});

test('is_reasoning: DUMATE_QWENWORK_REASONING=0 时关闭（两处同步）', () => {
  const saved = process.env.DUMATE_QWENWORK_REASONING;
  process.env.DUMATE_QWENWORK_REASONING = '0';
  dropCache();
  const chat = require(CHAT);
  const body = build(chat, 'pro', { messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(body.chat_context.extra.modelConfig.is_reasoning, false, 'modelConfig 处应关闭');
  assert.strictEqual(body.model_config.is_reasoning, false, 'model_config 处应关闭');
  // 恢复环境与缓存
  if (saved === undefined) delete process.env.DUMATE_QWENWORK_REASONING;
  else process.env.DUMATE_QWENWORK_REASONING = saved;
  dropCache();
});

test('reasoning_effort: low/medium/high/xhigh 原样进 parameters', () => {
  dropCache();
  const chat = require(CHAT);
  for (const eff of ['low', 'medium', 'high', 'xhigh']) {
    const body = build(chat, 'pro', { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: eff });
    assert.strictEqual(body.parameters.reasoning_effort, eff, `${eff} 应透传`);
  }
  dropCache();
});

test('reasoning_effort: none/off 视为关闭，不注入', () => {
  dropCache();
  const chat = require(CHAT);
  for (const eff of ['none', 'off', 'NONE', 'Off']) {
    const body = build(chat, 'pro', { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: eff });
    assert.strictEqual(body.parameters.reasoning_effort, undefined, `${eff} 不应注入`);
  }
  dropCache();
});

test('reasoning_effort: 非法值忽略，不注入', () => {
  dropCache();
  const chat = require(CHAT);
  for (const eff of ['turbo', 'max', '1', '', '  ']) {
    const body = build(chat, 'pro', { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: eff });
    assert.strictEqual(body.parameters.reasoning_effort, undefined, `非法值 ${eff} 不应注入`);
  }
  dropCache();
});

test('reasoning_effort: 缺失时不注入，不影响其它参数', () => {
  dropCache();
  const chat = require(CHAT);
  const body = build(chat, 'pro', { messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 });
  assert.strictEqual(body.parameters.reasoning_effort, undefined);
  assert.strictEqual(body.parameters.temperature, 0.7, '其它参数不受影响');
  dropCache();
});
