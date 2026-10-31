// test/unit/router-auto-model.test.js - 搭子自动档模型名的前缀路由
//
// dm-auto-model/text.L0 的档位编码在模型名里，斜杠不是通道分隔符。
// 回归点：resolve() 必须把 dm-auto-model/* 认领给搭子通道并**原样透传全名**
// （mapModel 的 aliases 已登记自映射）；既不能撞 unknown_channel 400，
// 也不能把前缀剥掉只发 text.L0。
const { test } = require('node:test');
const assert = require('assert');
const router = require('../../src/upstream-router');

test('dm-auto-model 三档都路由到搭子且全名透传', () => {
  for (const m of ['dm-auto-model/text.L0', 'dm-auto-model/text.L1', 'dm-auto-model/text.L2']) {
    const r = router.resolve(m);
    assert.strictEqual(r.channel, 'dumate', m);
    assert.strictEqual(r.model, m, m);
    assert.strictEqual(r.target.needsModelMap, true, m);
  }
});

test('带档位头的写法不受影响（完整名+空格等仍走搭子）', () => {
  const r = router.resolve('dm-auto-model/text.L0');
  assert.strictEqual(r.channel, 'dumate');
});

test('真实三通道前缀不被误吞', () => {
  assert.strictEqual(router.resolve('qwen/pro').channel, 'qwenwork');
  assert.strictEqual(router.resolve('traework/glm-5.2').channel, 'traework');
  assert.strictEqual(router.resolve('qoder/gfmodel').channel, 'qoder');
});

test('未知前缀仍报错不回落', () => {
  assert.ok(router.resolve('qwn/pro').error);
});

test('无前缀名字照旧走搭子', () => {
  const r = router.resolve('glm-5');
  assert.strictEqual(r.channel, 'dumate');
  assert.strictEqual(r.model, 'glm-5');
});
