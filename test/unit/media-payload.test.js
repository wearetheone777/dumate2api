// test/unit/media-payload.test.js - 搭子媒体端点的请求形状（纯函数）
//
// 形状依据：客户端自带 skills 的 submit.py / postprocess.py + 2026-10-31 真机探测。
// 这里锁住「OpenAI 参数 → 上游字段」的映射，避免以后改坏。
const { test } = require('node:test');
const assert = require('assert');
const media = require('../../src/media');

test('生图：默认模型走 v3 端点，quality=low，2K 1:1', () => {
  const b = media.buildImagePayload({ prompt: '一只猫' });
  assert.strictEqual(b.model, 'dumate-image2.2');
  assert.strictEqual(b.path, '/v2/tools/dumate/image_generate_v3/async');
  assert.strictEqual(b.payload.query, '一只猫');
  assert.strictEqual(b.payload.quality, 'low');
  assert.strictEqual(b.payload.resolution, '2K');
  assert.strictEqual(b.payload.aspectRatio, '1:1');
  assert.strictEqual(b.payload.maxImagesNum, 1);
});

test('生图：像素尺寸走 size 字段（不带 resolution）', () => {
  const b = media.buildImagePayload({ prompt: 'x', size: '1024x1024' });
  assert.strictEqual(b.payload.size, '1024x1024');
  assert.strictEqual(b.payload.resolution, undefined);
});

test('生图：分辨率档 1K/2K/4K', () => {
  assert.strictEqual(media.buildImagePayload({ prompt: 'x', size: '4k' }).payload.resolution, '4K');
});

test('生图：n 钳到 [1,4]', () => {
  assert.strictEqual(media.buildImagePayload({ prompt: 'x', n: 9 }).payload.maxImagesNum, 4);
  assert.strictEqual(media.buildImagePayload({ prompt: 'x', n: 0 }).payload.maxImagesNum, 1);
});

test('生图：参考图透传 imageUrls', () => {
  const b = media.buildImagePayload({ prompt: 'x', imageUrls: ['data:image/png;base64,AA'] });
  assert.deepStrictEqual(b.payload.imageUrls, ['data:image/png;base64,AA']);
});

test('生图：未知模型回落默认；大小写与 dumate/ 前缀都认', () => {
  assert.strictEqual(media.buildImagePayload({ prompt: 'x', model: 'no-such' }).model, 'dumate-image2.2');
  assert.strictEqual(media.buildImagePayload({ prompt: 'x', model: 'DUMATE-IMAGE2.1' }).model, 'dumate-image2.1');
  assert.strictEqual(media.buildImagePayload({ prompt: 'x', model: 'dumate/dumate-image1.2' }).model, 'dumate-image1.2');
});

test('生图：空 prompt 报错', () => {
  assert.ok(media.buildImagePayload({ prompt: '   ' }).error);
});

test('TTS：OpenAI voice 映射到 minimax voice_id', () => {
  const b = media.buildTtsPayload({ input: '你好', voice: 'alloy' });
  assert.strictEqual(b.voice, 'Chinese (Mandarin)_Gentle_Youth');
  assert.strictEqual(b.payload.voice_setting.voice_id, b.voice);
});

test('TTS：未知 voice 原样透传（可直接写 minimax id）', () => {
  const b = media.buildTtsPayload({ input: '你好', voice: 'Cantonese_ProfessionalHost（F)' });
  assert.strictEqual(b.voice, 'Cantonese_ProfessionalHost（F)');
});

test('TTS：speed 钳到 [0.5,2]，格式进 audio_setting', () => {
  const b = media.buildTtsPayload({ input: 'x', speed: 9, responseFormat: 'wav' });
  assert.strictEqual(b.payload.voice_setting.speed, 2);
  assert.strictEqual(b.payload.audio_setting.format, 'wav');
});

test('TTS：不支持的格式报错', () => {
  assert.ok(media.buildTtsPayload({ input: 'x', responseFormat: 'flac' }).error);
});

test('TTS：空 input 报错', () => {
  assert.ok(media.buildTtsPayload({ input: '' }).error);
});
