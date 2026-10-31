// test/unit/qwen-voice-polish.test.js - 语音润色的响应文本提取（2026-11-01）
//
// 候选序逐字对照解包 extractVoicePolishText（客户端 1.4.0 main.js）；
// 请求形状断言钉死 transcription XML 包裹（协议一部分）。
const { test } = require('node:test');
const assert = require('node:assert');
const voice = require('../../src/qwenwork/voice');

test('extractPolishedText：候选序与解包一致（messages 优先，result.content 居中）', () => {
  assert.equal(voice.extractPolishedText({ messages: '直接串' }), '直接串');
  assert.equal(voice.extractPolishedText({ message: 'msg' }), 'msg');
  assert.equal(voice.extractPolishedText({ text: 't' }), 't');
  assert.equal(voice.extractPolishedText({ result: { content: 'rc' } }), 'rc');
  assert.equal(voice.extractPolishedText({ result: { message: 'rm' } }), 'rm');
  assert.equal(voice.extractPolishedText({ data: { text: 'dt' } }), 'dt');
  // 高位候选空串时落到低位
  assert.equal(voice.extractPolishedText({ messages: '', text: 'fallback' }), 'fallback');
  // 全空如实 null（不编 0/空串）
  assert.equal(voice.extractPolishedText({}), null);
  assert.equal(voice.extractPolishedText(null), null);
  // 非字符串形状跳过
  assert.equal(voice.extractPolishedText({ messages: { deep: 'obj' } }), null);
});

test('extractPolishedText：前后空白裁剪', () => {
  assert.equal(voice.extractPolishedText({ text: '  你好  ' }), '你好');
});
