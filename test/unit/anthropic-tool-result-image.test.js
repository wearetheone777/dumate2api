// test/unit/anthropic-tool-result-image.test.js - P0-4 tool_result 内图片保真
//
// 锁住三条口径：
//   1. tool_result.content 里的 image 块转 OpenAI image_url part，不压成文本
//   2. 图片作为独立 user 消息紧跟对应 tool 消息，多个 tool_call_id 不错位
//   3. 无图的 tool_result 行为不变
//
// 运行：node --test test/unit/anthropic-tool-result-image.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const anthropic = require('../../src/anthropic');

const PNG = 'iVBORw0KGgoAAAANSUhEUg==';
const DATA_URL = `data:image/png;base64,${PNG}`;

function translate(content) {
  return anthropic.anthropicToOpenAI({
    model: 'traework/deepseek-v4.1-flash', max_tokens: 1024,
    messages: [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_1', content },
    ] }],
  }, { nativeTools: true }).messages;
}

test('base64 图片从 tool_result 转成独立 user image_url 消息', () => {
  const out = translate([
    { type: 'text', text: '截图如下' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
  ]);
  assert.equal(out.length, 2);
  assert.deepStrictEqual(out[0], { role: 'tool', tool_call_id: 'call_1', content: '截图如下' });
  assert.deepStrictEqual(out[1], {
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: DATA_URL } }],
  });
});

test('url source 原样透传', () => {
  const out = translate([
    { type: 'image', source: { type: 'url', url: 'https://example.com/shot.png' } },
  ]);
  assert.equal(out[1].content[0].image_url.url, 'https://example.com/shot.png');
});

test('多 tool_result 的图片按调用 ID 顺序紧跟各自 tool 消息', () => {
  const out = anthropic.anthropicToOpenAI({
    model: 'traework/deepseek-v4.1-flash', max_tokens: 1024,
    messages: [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_a', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A' } },
      ] },
      { type: 'tool_result', tool_use_id: 'call_b', content: [
        { type: 'text', text: '第二张' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'B' } },
      ] },
    ] }],
  }, { nativeTools: true }).messages;
  assert.deepStrictEqual(out.map((m) => m.role), ['tool', 'user', 'tool', 'user']);
  assert.equal(out[0].tool_call_id, 'call_a');
  assert.equal(out[1].content[0].image_url.url, 'data:image/png;base64,A');
  assert.equal(out[2].tool_call_id, 'call_b');
  assert.equal(out[2].content, '第二张');
  assert.equal(out[3].content[0].image_url.url, 'data:image/jpeg;base64,B');
});

test('无图 tool_result 行为不变：只有一条 role:tool 消息', () => {
  const out = translate('普通输出');
  assert.deepStrictEqual(out, [{ role: 'tool', tool_call_id: 'call_1', content: '普通输出' }]);
});

test('降级路径（nativeTools=false）不生成额外图片消息，不丢文本', () => {
  const out = anthropic.anthropicToOpenAI({
    model: 'glm-5', max_tokens: 1024,
    messages: [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_1', content: [
        { type: 'text', text: '文字' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      ] },
    ] }],
  }, { nativeTools: false });
  assert.equal(out.messages.length, 1);
  assert.ok(out.messages[0].content.includes('[Tool Result]'));
  assert.ok(out.messages[0].content.includes('文字'));
  // 顶层 image 块仍保真（既有行为，别被 P0-4 改坏）
  const withTopImage = anthropic.anthropicToOpenAI({
    model: 'glm-5', max_tokens: 1024,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ] }],
  }, { nativeTools: false });
  assert.equal(withTopImage.messages[0].content[0].image_url.url, DATA_URL);
});
