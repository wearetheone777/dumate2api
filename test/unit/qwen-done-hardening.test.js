// test/unit/qwen-done-hardening.test.js - 千问 [DONE] 信封加固（2026-11-27 融合 P2-1）
//
// 锁 src/qwenwork/chat.js 的 unwrap：多层 body 信封剥壳 + 任意层识别 [DONE]。
// 上游把 [DONE] 包在信封里时，只认裸 [DONE] 会漏判，表现为流不结束、
// 上层一直等（doneSeen 永不置位）。
const { test } = require('node:test');
const assert = require('assert');

const { unwrap } = require('../../src/qwenwork/chat');

// 构造多层 body 信封。inner 是**要包裹的原始内容**（字符串或 JSON 串），
// 不再先 JSON.stringify——否则会双重编码（body 变成带引号的字符串）。
function envelope(inner, layers) {
  let s = inner;
  for (let i = 0; i < layers; i++) s = JSON.stringify({ body: s });
  return s;
}

test('裸 [DONE]：透传为结束标记', () => {
  assert.deepStrictEqual(unwrap('[DONE]'), ['[DONE]']);
});

test('一层信封包裹 [DONE]：识别并透传', () => {
  assert.deepStrictEqual(unwrap(envelope('[DONE]', 1)), ['[DONE]']);
});

test('多层信封包裹 [DONE]（2~6 层）：逐层剥到 [DONE]', () => {
  for (const layers of [2, 3, 4, 5, 6]) {
    assert.deepStrictEqual(unwrap(envelope('[DONE]', layers)), ['[DONE]'],
      `${layers} 层信封应识别 [DONE]`);
  }
});

test('内层 payload（choices）：原样返回，不再剥', () => {
  const payload = JSON.stringify({ choices: [{ delta: { content: 'hi' } }] });
  assert.deepStrictEqual(unwrap(payload), [payload]);
});

test('多层信封包裹真实 payload：剥到最内层 choices（旧实现只剥一层会丢）', () => {
  const payload = JSON.stringify({ choices: [{ delta: { content: 'hi' } }] });
  const wrapped = envelope(payload, 3);
  assert.deepStrictEqual(unwrap(wrapped), [payload],
    '3 层信封应剥到 choices，而不是返回中间信封');
});

test('空壳信封（{} / [] / null）：丢弃', () => {
  assert.deepStrictEqual(unwrap('{}'), []);
  assert.deepStrictEqual(unwrap('[]'), []);
  assert.deepStrictEqual(unwrap('null'), []);
  assert.deepStrictEqual(unwrap(envelope('{}', 1)), []);
});

test('非 JSON 帧：原样返回，不抛', () => {
  assert.deepStrictEqual(unwrap('plain text frame'), ['plain text frame']);
});

test('超过最大层数（7 层）：不无限循环，返回最后一层', () => {
  const wrapped = envelope('[DONE]', 7);
  const result = unwrap(wrapped);
  // 不挂死、返回数组；7 层超出 6 层上限，最后一层信封原样返回
  assert.ok(Array.isArray(result), '应返回数组，不挂死');
  assert.ok(result.length >= 1);
});

test('无 body 字段的非信封 JSON：原样返回让上层判断', () => {
  const s = JSON.stringify({ status: 'ok' });
  assert.deepStrictEqual(unwrap(s), [s]);
});

test('空输入：返回空数组', () => {
  assert.deepStrictEqual(unwrap(''), []);
  assert.deepStrictEqual(unwrap(null), []);
  assert.deepStrictEqual(unwrap(undefined), []);
});
