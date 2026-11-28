// test/unit/workbuddy-system-tail.test.js - system 后置救前缀缓存（P1-1，默认关）
//
// 锁住（全部走 buildChatBody 全管线，与出站字节同源）：
//   1. 默认关：消息顺序一字不动（激进优化必须显式开启）
//   2. enabled + cn：开头连续 system 块挪到末尾（保序），头部放恒定短桩
//   3. 只挪**开头连续**块：中段/尾部的 system 不碰
//   4. global 区域不启用
//   5. 整条都是 system 时不动（没有可救的前缀）
//   6. 桩文本恒定（改文案 = 全量缓存失效）
//   7. convId 不受挪动影响（键位取首条 user）
//
// 运行：node --test test/unit/workbuddy-system-tail.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
process.env.DUMATE_ADMIN_DATA = tmpDir('dumate-wb-systail');
const runtime = require('../../src/workbuddy/runtime');
const chat = require('../../src/workbuddy/chat');

function enable(on) {
  if (on) runtime.Store({ systemTail: { enabled: true } });
  else runtime.Store({ systemTail: { enabled: false } });
}

function build(payload, region, account) {
  const r = chat.buildChatBody(payload, region, account);
  return { body: JSON.parse(r.body), convId: r.convId }; // body 是 JSON 串（透传形态）
}
function roles(body) { return body.messages.map((m) => m.role); }

test('P1-1：默认关——消息顺序一字不动', () => {
  enable(false);
  const payload = {
    model: 'glm-5.3',
    messages: [
      { role: 'system', content: '长系统提示词'.repeat(200) },
      { role: 'user', content: 'hi' },
    ],
  };
  const { body } = build(payload, 'cn', null);
  assert.deepEqual(roles(body), ['system', 'user']);
  assert.equal(body.messages[0].content, '长系统提示词'.repeat(200), '原 system 保持在头部');
});

test('P1-1：enabled + cn——开头 system 挪尾，头部是恒定短桩', () => {
  enable(true);
  const payload = {
    model: 'glm-5.3',
    messages: [
      { role: 'system', content: '长系统提示词'.repeat(200) },
      { role: 'user', content: 'hi' },
    ],
  };
  const { body } = build(payload, 'cn', null);
  assert.deepEqual(roles(body), ['system', 'user', 'system']);
  assert.equal(body.messages[0].content, chat.SYSTEM_TAIL_STUB, '头部是恒定短桩');
  assert.equal(body.messages[2].content, '长系统提示词'.repeat(200), '原 system 完整挪到末尾');
});

test('P1-1：开头多条 system 全挪且保序；中段 system 不碰', () => {
  enable(true);
  const payload = {
    model: 'glm-5.3',
    messages: [
      { role: 'system', content: '头A' },
      { role: 'system', content: '头B' },
      { role: 'user', content: 'q1' },
      { role: 'system', content: '中段规则' },   // 中段：不碰
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ],
  };
  const { body } = build(payload, 'cn', null);
  // 开头两条挪尾，中段那条保持在原相对位置
  assert.deepEqual(body.messages.map((m) => m.content),
    [chat.SYSTEM_TAIL_STUB, 'q1', '中段规则', 'a1', 'q2', '头A', '头B']);
});

test('P1-1：global 区域不启用（即使开关开着）', () => {
  enable(true);
  const payload = {
    model: 'glm-5.3',
    messages: [
      { role: 'system', content: '长系统提示词' },
      { role: 'user', content: 'hi' },
    ],
  };
  const { body } = build(payload, 'global', null);
  assert.deepEqual(roles(body), ['system', 'user'], '国际端点不做激进优化');
});

test('P1-1：整条都是 system 时不动', () => {
  enable(true);
  const payload = {
    model: 'glm-5.3',
    messages: [{ role: 'system', content: '只有系统' }],
  };
  const { body } = build(payload, 'cn', null);
  assert.deepEqual(roles(body), ['system']);
  assert.equal(body.messages[0].content, '只有系统', '没有可救的前缀，不乱挪');
});

test('P1-1：桩文本恒定且非空（首条必须 system 的硬校验由它满足）', () => {
  assert.equal(typeof chat.SYSTEM_TAIL_STUB, 'string');
  assert.ok(chat.SYSTEM_TAIL_STUB.length > 0);
  assert.ok(chat.SYSTEM_TAIL_STUB.length < 30, '桩必须短——它就是被救出来的前缀');
});

test('P1-1：convId 不受挪动影响（键位是首条 user，前缀缓存键稳定）', () => {
  enable(false);
  const payload = {
    model: 'glm-5.3',
    messages: [
      { role: 'system', content: 'S' },
      { role: 'user', content: '锚定消息' },
    ],
  };
  const a = build(payload, 'cn', null).convId;
  enable(true);
  const b = build(payload, 'cn', null).convId;
  assert.equal(a, b, '开关切换不改变会话键（键只取首条 user）');
});
