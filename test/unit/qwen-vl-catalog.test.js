// test/unit/qwen-vl-catalog.test.js - 千问 is_vl 目录优先（2026-11-27 融合 G4）
//
// 锁 src/qwenwork/chat.js 的 isVlOf：上游模型目录（实测 14 档全 is_vl:true）
// 是权威；目录未拉到时回落旧白名单，不会把所有模型标成 false。
const { test, beforeEach } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DUMATE_ADMIN_DATA = path.join(os.tmpdir(), `qw-vl-${process.pid}`);
fs.mkdirSync(process.env.DUMATE_ADMIN_DATA, { recursive: true });

const chatPath = require.resolve('../../src/qwenwork/chat');
const idxPath = require.resolve('../../src/qwenwork/index');

let chat;
beforeEach(() => {
  delete require.cache[chatPath];
  delete require.cache[idxPath];
  chat = require('../../src/qwenwork/chat');
});

test('目录未拉到：回落旧白名单（pro/flash/qwen3.8-max-preview）', () => {
  assert.strictEqual(chat.isVlOf('pro'), true);
  assert.strictEqual(chat.isVlOf('flash'), true);
  assert.strictEqual(chat.isVlOf('qwen3.8-max-preview'), true);
  assert.strictEqual(chat.isVlOf('glm-5.4'), false, '目录没到时新档位不在旧白名单');
});

test('目录已拉到：按上游 is_vl 判定（14 档全 true）', () => {
  const idx = require('../../src/qwenwork/index');
  // 直接喂 parseModelsResponse 的形状到内部缓存——通过 cachedModelCapabilities
  // 读的是 modelsCache，只能靠真实拉取填充；这里改测导出的纯函数与 buildBody 形状。
  const entries = idx.parseModelsResponse({
    qwork: [
      { key: 'glm-5.4', is_vl: true },
      { key: 'lite', is_vl: false },
    ],
  });
  assert.strictEqual(entries[0].multimodal, true);
  assert.strictEqual(entries[1].multimodal, false);
});

test('buildBody：目录未拉到时新档位走旧白名单（不误判为视觉）', () => {
  const body = JSON.parse(chat.buildBody('glm-5.4', { messages: [{ role: 'user', content: 'hi' }] }));
  assert.strictEqual(body.chat_context.extra.modelConfig.key, 'glm-5.4');
  assert.strictEqual(body.model_config.is_vl, false, '无目录时回落白名单，glm-5.4 不在其中');
});

test('buildBody：pro 在白名单里，is_vl=true', () => {
  const body = JSON.parse(chat.buildBody('pro', { messages: [{ role: 'user', content: 'hi' }] }));
  assert.strictEqual(body.model_config.is_vl, true);
});
