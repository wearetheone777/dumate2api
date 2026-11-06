// test/unit/tool-echo.test.js - 工具调用回显（tool echo）检测与处置
//
// hub#135 融合（2026-11-04）：上游把工具调用当**正文**吐出（纯 JSON 载荷，
// 不走原生 tool_calls），客户端按「回合完成」静默结束。本测试锁住：
//   - parseToolEchoPayload 的形状与强判据（纯载荷 + 名单锚）；
//   - aggregateToolEchoFallback 的 off/lenient/strict 三态；
//   - createChunkGate finish 阶段的 echoFixup（lenient 还原 / strict fail-closed）。
// 运行：node --test test/unit/tool-echo.test.js
const assert = require('assert');
const { test } = require('node:test');
const repair = require('../../src/repair');

const NAMES = ['get_weather', 'run_cmd'];

test('parseToolEchoPayload：{name, arguments 对象} 形状', () => {
  const calls = repair.parseToolEchoPayload(
    '{"name":"get_weather","arguments":{"city":"北京"}}', NAMES);
  assert.deepStrictEqual(calls, [{ name: 'get_weather', arguments: '{"city":"北京"}' }]);
});

test('parseToolEchoPayload：arguments 字符串原样、缺省补 {}', () => {
  assert.deepStrictEqual(
    repair.parseToolEchoPayload('{"name":"run_cmd","arguments":"ls -la"}', NAMES),
    [{ name: 'run_cmd', arguments: 'ls -la' }]);
  assert.deepStrictEqual(
    repair.parseToolEchoPayload('{"name":"get_weather"}', NAMES),
    [{ name: 'get_weather', arguments: '{}' }]);
});

test('parseToolEchoPayload：{function:{…}} 与 {tool_calls:[…]} 形状', () => {
  assert.deepStrictEqual(
    repair.parseToolEchoPayload('{"function":{"name":"get_weather","arguments":{"city":"上海"}}}', NAMES),
    [{ name: 'get_weather', arguments: '{"city":"上海"}' }]);
  const calls = repair.parseToolEchoPayload(JSON.stringify({
    tool_calls: [
      { function: { name: 'get_weather', arguments: { city: 'a' } } },
      { name: 'run_cmd', arguments: 'x' },
    ],
  }), NAMES);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].name, 'get_weather');
  assert.strictEqual(calls[1].name, 'run_cmd');
});

test('parseToolEchoPayload：不在名单 / 非纯载荷 / 非 JSON 一律 null', () => {
  assert.strictEqual(repair.parseToolEchoPayload('{"name":"evil_tool","arguments":{}}', NAMES), null,
    '名单外的 name 不是 echo（模型在编示例）');
  assert.strictEqual(repair.parseToolEchoPayload('好的，我来调用：{"name":"get_weather"}', NAMES), null,
    '前后有文字 = 讨论，不是纯载荷');
  assert.strictEqual(repair.parseToolEchoPayload('{"name":"get_weather"} 好了吗', NAMES), null);
  assert.strictEqual(repair.parseToolEchoPayload('{"name": "get_weather",,', NAMES), null, '非 JSON');
  assert.strictEqual(repair.parseToolEchoPayload('["get_weather"]', NAMES), null, '顶层数组不算');
  assert.strictEqual(repair.parseToolEchoPayload('{"name":"get_weather"}', []), null, '空名单不判定');
  assert.strictEqual(repair.parseToolEchoPayload('{"name":"get_weather"}', null), null);
  assert.strictEqual(repair.parseToolEchoPayload('{"name":"get_weather"}'.repeat(3000), NAMES), null,
    '超长载荷按正文处理');
});

test('aggregateToolEchoFallback：off / 已有原生调用 → 原样', () => {
  const c1 = new Map();
  const r1 = repair.aggregateToolEchoFallback('t', '{"name":"get_weather"}', c1, NAMES, 'off');
  assert.strictEqual(r1.recovered, false);
  assert.strictEqual(r1.content, '{"name":"get_weather"}');
  const c2 = new Map([[0, { id: 'x', type: 'function', function: { name: 'a', arguments: '{}' } }]]);
  const r2 = repair.aggregateToolEchoFallback('t', '{"name":"get_weather"}', c2, NAMES, 'lenient');
  assert.strictEqual(r2.recovered, false, '已有原生调用时不接管');
  assert.strictEqual(r2.content, '{"name":"get_weather"}');
});

test('aggregateToolEchoFallback：lenient 还原 calls + 清正文', () => {
  const calls = new Map();
  const r = repair.aggregateToolEchoFallback('t', '{"name":"get_weather","arguments":{"city":"北京"}}', calls, NAMES, 'lenient');
  assert.strictEqual(r.recovered, true);
  assert.strictEqual(r.content, '', '正文就是载荷，还原后不再发');
  const call = r.calls.get(0);
  assert.strictEqual(call.function.name, 'get_weather');
  assert.strictEqual(call.type, 'function');
});

test('aggregateToolEchoFallback：strict fail-closed 抛 502', () => {
  assert.throws(
    () => repair.aggregateToolEchoFallback('t', '{"name":"get_weather"}', new Map(), NAMES, 'strict'),
    (e) => e.statusCode === 502 && /tool echo/.test(e.message));
});

test('gate echoFixup（lenient）：缓冲载荷 finish 后还原 tool_calls，stop 纠正', () => {
  const out = [];
  const gate = repair.createChunkGate((s) => out.push(s), true, 600, {
    model: 'm', channel: 't',
    toolNames: NAMES,
    echoMode: 'lenient',
  });
  gate.onInner(JSON.stringify({
    id: '1', object: 'chat.completion.chunk', model: 'm',
    choices: [{ index: 0, delta: { content: '{"name":"get_weather","arguments":{"city":"北京"}}' } }],
  }));
  gate.onInner(JSON.stringify({
    id: '1', object: 'chat.completion.chunk', model: 'm',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }));
  gate.onInner('[DONE]');
  gate.finish();
  const frames = out.filter((s) => s !== '[DONE]').map((s) => JSON.parse(s));
  const toolFrame = frames.find((f) => f.choices && f.choices[0].delta && f.choices[0].delta.tool_calls);
  assert.ok(toolFrame, '应发出 tool_calls 帧');
  assert.strictEqual(toolFrame.choices[0].delta.tool_calls[0].function.name, 'get_weather');
  const finishFrame = frames.find((f) => f.choices && f.choices[0].finish_reason);
  assert.strictEqual(finishFrame.choices[0].finish_reason, 'tool_calls', 'stop 应纠正成 tool_calls');
  assert.strictEqual(gate.result().toolCalls, 1);
  const rawContent = frames.some((f) => f.choices && f.choices[0].delta && f.choices[0].delta.content);
  assert.ok(!rawContent, '载荷正文不应再以 content 形式发出');
  assert.ok(out[out.length - 1] === '[DONE]', '流尾 [DONE] 保持');
});

test('gate echoFixup（strict）：fail-closed 抛错', () => {
  const gate = repair.createChunkGate(() => {}, true, 600, {
    model: 'm', channel: 't', toolNames: NAMES, echoMode: 'strict',
  });
  gate.onInner(JSON.stringify({
    id: '1', object: 'chat.completion.chunk', model: 'm',
    choices: [{ index: 0, delta: { content: '{"name":"run_cmd"}' } }],
  }));
  assert.throws(() => gate.finish(), (e) => e.statusCode === 502);
});

test('gate echoFixup：off（默认）时正文原样转发——现状不变', () => {
  const out = [];
  const gate = repair.createChunkGate((s) => out.push(s), true, 600, {
    model: 'm', channel: 't', toolNames: NAMES, echoMode: 'off',
  });
  gate.onInner(JSON.stringify({
    id: '1', object: 'chat.completion.chunk', model: 'm',
    choices: [{ index: 0, delta: { content: '{"name":"get_weather"}' } }],
  }));
  gate.onInner('[DONE]');
  gate.finish();
  const frames = out.filter((s) => s !== '[DONE]').map((s) => JSON.parse(s));
  const contentFrame = frames.find((f) => f.choices && f.choices[0].delta && f.choices[0].delta.content);
  assert.ok(contentFrame, 'off 模式载荷按正文原样转发（现状）');
});

test('gate echoFixup：没传 toolNames 时零行为变化', () => {
  const out = [];
  const gate = repair.createChunkGate((s) => out.push(s), true, 600, { model: 'm', channel: 't' });
  gate.onInner(JSON.stringify({
    id: '1', object: 'chat.completion.chunk', model: 'm',
    choices: [{ index: 0, delta: { content: '{"name":"get_weather"}' } }],
  }));
  gate.onInner('[DONE]');
  gate.finish();
  assert.ok(out.some((s) => s.includes('get_weather')), '未启用 echo 时一切照旧');
});

test('gate echoFixup：已直发（超 HOLD_CAP）后不再接管', () => {
  const out = [];
  const gate = repair.createChunkGate((s) => out.push(s), true, 5, {
    model: 'm', channel: 't', toolNames: NAMES, echoMode: 'lenient',
  });
  const long = 'x'.repeat(20) + '{"name":"get_weather"}';
  gate.onInner(JSON.stringify({
    id: '1', object: 'chat.completion.chunk', model: 'm',
    choices: [{ index: 0, delta: { content: long } }],
  }));
  gate.finish();
  assert.ok(out.some((s) => s.includes('get_weather')), '已转直发的正文收不回，原样透传');
  assert.strictEqual(gate.result().toolCalls, 0);
});
