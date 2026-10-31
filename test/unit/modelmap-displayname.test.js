// test/unit/modelmap-displayname.test.js - 显示名 = 真实后端名（2026-11-01）
//
// cc-switch 读 /v1/models 的 name 字段显示模型名。此前搭子条目的 name 是
// 内部 key（当时没有真实名数据），现在显示 X-Dumate-Gw-Realmodel 实测的
// 真实后端 + 档位限定词。model-text 与 L0 同后端，靠限定词区分。
const { test } = require('node:test');
const assert = require('node:assert');
const mm = require('../../src/modelmap');

test('displayName：真实后端名 + 档位限定词（忠实于上游回传的小写）', () => {
  assert.equal(mm.displayName('model-text'), 'deepseek-v4.1-flash-low-latency（上游默认档）');
  assert.equal(mm.displayName('dm-auto-model/text.L0'), 'deepseek-v4.1-flash-low-latency（自动档 L0）');
  assert.equal(mm.displayName('dm-auto-model/text.L1'), 'kimi-k3（自动档 L1）');
  assert.equal(mm.displayName('dm-auto-model/text.L2'), 'qwen3.8-max（自动档 L2）');
  assert.equal(mm.displayName('glm-5'), 'glm-5.2');
});

test('displayName：未实测/未知名字原样返回（不编显示名）', () => {
  assert.equal(mm.displayName('model-artifact-validate'), 'model-artifact-validate（制品校验，后端未实测）');
  assert.equal(mm.displayName('no-such-model'), 'no-such-model');
});
