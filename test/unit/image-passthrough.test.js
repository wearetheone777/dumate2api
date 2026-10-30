// test/unit/image-passthrough.test.js - 图像输入经翻译层与通道层（node:test）
//
// 背景：三个翻译层此前把图像一律降级成占位文本——那是搭子的能力边界，
// 被错套到所有通道。实测（2026-10-30 真机）TRAE llm_utils_chat 直接认
// OpenAI 标准 image_url part（data URI），故翻译层保真、通道层消歧：
//   TRAE 直通 + 多模态校验；千问/Qoder 展开占位文本（COSY 只有纯文本槽）；
//   搭子压回占位文本（恢复保真前的行为）。
const { test } = require('node:test');
const assert = require('assert');
const images = require('../../src/images');
const anthropic = require('../../src/anthropic');
const responses = require('../../src/responses');
const google = require('../../src/google');
const traeworkChat = require('../../src/traework/chat');

const RED_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg==';

// ---- images.js 基元 ----

test('images: toImageUrlPart 空 url 返回 null，不编 part', () => {
  assert.strictEqual(images.toImageUrlPart(''), null);
  assert.strictEqual(images.toImageUrlPart(null), null);
  assert.deepStrictEqual(images.toImageUrlPart('data:image/png;base64,x'),
    { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } });
});

test('images: contentText 展开数组为纯文本，图像换占位（防 [object Object]）', () => {
  const content = [
    { type: 'text', text: '看这张图' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PNG_B64}` } },
  ];
  assert.strictEqual(images.contentText(content, '[图]'), '看这张图\n[图]');
  assert.strictEqual(images.contentText('纯文本', '[图]'), '纯文本');
  assert.strictEqual(images.contentText(null, '[图]'), '');
});

test('images: imagePartsFromContent 兼容 input_image 字符串/对象/顶层 url 三种写法', () => {
  const parts = images.imagePartsFromContent([
    { type: 'input_image', image_url: 'data:image/png;base64,a' },
    { type: 'input_image', image_url: { url: 'data:image/png;base64,b' } },
    { type: 'image_url', url: 'data:image/png;base64,c' },
    { type: 'text', text: 'x' },
  ]);
  assert.strictEqual(parts.length, 3);
  assert.strictEqual(parts[0].image_url.url, 'data:image/png;base64,a');
  assert.strictEqual(parts[2].image_url.url, 'data:image/png;base64,c');
});

test('images: flattenImageParts 就地把图像压回占位文本（搭子路径）', () => {
  const req = {
    messages: [
      { role: 'user', content: [
        { type: 'text', text: '图里是什么' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PNG_B64}` } },
      ] },
      { role: 'user', content: '纯文本保持原样' },
    ],
  };
  images.flattenImageParts(req);
  assert.strictEqual(typeof req.messages[0].content, 'string');
  assert.ok(req.messages[0].content.includes('图里是什么'));
  assert.ok(req.messages[0].content.includes('not supported'));
  assert.strictEqual(req.messages[1].content, '纯文本保持原样');
});

// ---- Anthropic 入口 ----

test('anthropic: base64 source → data URI image_url part（结构化路径保真）', () => {
  const out = anthropic.anthropicToOpenAI({
    model: 'traework/deepseek-v4.1-flash', max_tokens: 1024,
    messages: [{ role: 'user', content: [
      { type: 'text', text: '主色调' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_PNG_B64 } },
    ] }],
  }, { nativeTools: true });
  const last = out.messages[out.messages.length - 1];
  assert.ok(Array.isArray(last.content));
  assert.strictEqual(last.content[0].text, '主色调');
  assert.strictEqual(last.content[1].image_url.url, `data:image/png;base64,${RED_PNG_B64}`);
});

test('anthropic: url source 原样透传', () => {
  const out = anthropic.anthropicToOpenAI({
    model: 'traework/deepseek-v4.1-flash', max_tokens: 1024,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
    ] }],
  }, { nativeTools: true });
  const last = out.messages[out.messages.length - 1];
  assert.strictEqual(last.content[0].image_url.url, 'https://example.com/a.png');
});

test('anthropic: 搭子路径（nativeTools=false）保持占位文本降级', () => {
  const out = anthropic.anthropicToOpenAI({
    model: 'glm-5', max_tokens: 1024,
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'hi' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_PNG_B64 } },
    ] }],
  }, { nativeTools: false });
  const last = out.messages[out.messages.length - 1];
  assert.strictEqual(typeof last.content, 'string');
  assert.ok(last.content.includes('not supported'));
});

// ---- Responses 入口 ----

test('responses: input_image → image_url part 保留', () => {
  const out = responses.responsesToOpenAI({
    model: 'traework/deepseek-v4.1-flash',
    input: [{ type: 'message', role: 'user', content: [
      { type: 'input_text', text: '图里是什么' },
      { type: 'input_image', image_url: `data:image/png;base64,${RED_PNG_B64}` },
    ] }],
  }, false);
  const last = out.messages[out.messages.length - 1];
  assert.ok(Array.isArray(last.content));
  assert.strictEqual(last.content[1].image_url.url, `data:image/png;base64,${RED_PNG_B64}`);
});

// ---- Google 入口 ----

test('google: inlineData → data URI image_url part 保留', () => {
  const out = google.googleToOpenAI({
    contents: [{ role: 'user', parts: [
      { text: '主色调' },
      { inlineData: { mimeType: 'image/png', data: RED_PNG_B64 } },
    ] }],
  });
  const last = out.messages[out.messages.length - 1];
  assert.ok(Array.isArray(last.content));
  assert.strictEqual(last.content[1].image_url.url, `data:image/png;base64,${RED_PNG_B64}`);
});

// ---- TRAE 通道层 ----

test('traework buildBody: user 的 image_url part 原样透传', () => {
  const body = JSON.parse(traeworkChat.buildBody({
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [
      { type: 'text', text: '主色调' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PNG_B64}` } },
    ] }],
  }, 'deepseek-v4.1-flash', {}));
  const m = body.messages[0];
  assert.ok(Array.isArray(m.content));
  assert.strictEqual(m.content[1].image_url.url, `data:image/png;base64,${RED_PNG_B64}`);
});

test('traework buildBody: 非 user 消息的图像 part 剥除', () => {
  const body = JSON.parse(traeworkChat.buildBody({
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
  }, 'deepseek-v4.1-flash', {}));
  assert.strictEqual(body.messages[0].content.length, 1);
  assert.strictEqual(body.messages[0].content[0].text, 'sys');
});

// ---- 千问/Qoder 的 contentText 展开（COSY text 槽防 [object Object]）----

test('qwenwork buildBody: 带图数组 content 展开为纯文本占位，不再 [object Object]', () => {
  const qwen = require('../../src/qwenwork/chat');
  // 千问的签名是 buildBody(modelKey, payload)——参数顺序与 TRAE 相反
  const body = JSON.parse(qwen.buildBody('pro', {
    model: 'qwen/pro',
    messages: [{ role: 'user', content: [
      { type: 'text', text: '图里是什么' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PNG_B64}` } },
    ] }],
  }));
  const text = body.chat_context && body.chat_context.text;
  assert.strictEqual(typeof text, 'string');
  assert.ok(text.includes('图里是什么'));
  assert.ok(text.includes('not supported by Qwen'));
  assert.ok(!text.includes('[object Object]'));
});

test('qoder buildBody: 带图数组 content 展开为纯文本占位，不再 [object Object]', () => {
  const qoder = require('../../src/qoder/chat');
  // 签名同千问：buildBody(modelKey, payload, opts)
  const body = JSON.parse(qoder.buildBody('gfmodel', {
    model: 'qoder/gfmodel',
    messages: [{ role: 'user', content: [
      { type: 'text', text: '图里是什么' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PNG_B64}` } },
    ] }],
  }));
  const text = body.chat_context && body.chat_context.text;
  assert.strictEqual(typeof text, 'string');
  assert.ok(text.includes('图里是什么'));
  assert.ok(text.includes('not supported by Qoder'));
  assert.ok(!text.includes('[object Object]'));
});

test('responses: custom_tool_call（Codex 自由格式工具）转标准 function 调用', () => {
  const out = responses.responsesToOpenAI({
    model: 'qoder/dfmodel',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'patch it' }] },
      { type: 'custom_tool_call', call_id: 'ctc1', name: 'apply_patch', input: '*** Begin Patch\n+line' },
      { type: 'custom_tool_call_output', call_id: 'ctc1', output: 'Done!' },
    ],
  }, false);
  const asst = out.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.ok(asst, 'assistant tool_calls 缺失');
  assert.strictEqual(asst.tool_calls[0].function.name, 'apply_patch');
  assert.deepStrictEqual(JSON.parse(asst.tool_calls[0].function.arguments), { input: '*** Begin Patch\n+line' });
  const tool = out.messages.find((m) => m.role === 'tool');
  assert.ok(tool, 'tool 消息缺失');
  assert.strictEqual(tool.tool_call_id, 'ctc1');
  assert.strictEqual(tool.content, 'Done!');
});
