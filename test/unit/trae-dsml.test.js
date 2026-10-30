// test/unit/trae-dsml.test.js - DSML 工具调用回退解析（node:test）
//
// DeepSeek 系模型偶尔把工具调用以 <dsml:calls> 文本标记写进正文（不走原生
// tool_calls 增量），客户端拿到 XML 文本、本轮工具不执行。回退解析融合自
// trae2api-hub 的 parse_dsml_tool_calls（标签名里 DSML 前缀位置不固定）。
// 处置纯兜底：只在零原生调用时解析；原生调用优先，正文原样保留。
const { test } = require('node:test');
const assert = require('assert');
const traeworkChat = require('../../src/traework/chat');
const { parseDsmlToolCalls, aggregate } = traeworkChat;

test('parseDsml: 标准 dsml:calls 块解析出工具调用并剥离正文', () => {
  const text = '我先看一下文件内容。\n<dsml:calls>\n'
    + '<dsml:invoke name="read_file">'
    + '<dsml:parameter name="path">D:/code/a.md</dsml:parameter>'
    + '</dsml:invoke>\n</dsml:calls>';
  const r = parseDsmlToolCalls(text);
  assert.ok(r);
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0].name, 'read_file');
  assert.deepStrictEqual(JSON.parse(r.calls[0].arguments), { path: 'D:/code/a.md' });
  assert.strictEqual(r.clean, '我先看一下文件内容。');
});

test('parseDsml: 大写标签与不同分隔符都认（前缀任意）', () => {
  const text = '<DSML_CALLS><DSML_INVOKE name="exec_command">'
    + '<DSML_PARAMETER name="cmd">dir</DSML_PARAMETER></DSML_INVOKE></DSML_CALLS>';
  const r = parseDsmlToolCalls(text);
  assert.ok(r);
  assert.strictEqual(r.calls[0].name, 'exec_command');
});

test('parseDsml: 多 invoke 多参数，arguments 是合法 JSON', () => {
  const text = '<dsml:calls>'
    + '<dsml:invoke name="a"><dsml:parameter name="p1">v 1</dsml:parameter><dsml:parameter name="p2">v2</dsml:parameter></dsml:invoke>'
    + '<dsml:invoke name="b"></dsml:invoke>'
    + '</dsml:calls>';
  const r = parseDsmlToolCalls(text);
  assert.strictEqual(r.calls.length, 2);
  assert.deepStrictEqual(JSON.parse(r.calls[0].arguments), { p1: 'v 1', p2: 'v2' });
  assert.deepStrictEqual(JSON.parse(r.calls[1].arguments), {});
});

test('parseDsml: 无 DSML 标记返回 null（不误伤普通正文）', () => {
  assert.strictEqual(parseDsmlToolCalls('普通正文，提到 calls 与 invoke 但没有标记。'), null);
  assert.strictEqual(parseDsmlToolCalls(''), null);
  assert.strictEqual(parseDsmlToolCalls(null), null);
});

test('parseDsml: 有 calls 块但无 invoke → null（正文保留）', () => {
  const text = '<dsml:calls>空块</dsml:calls>';
  assert.strictEqual(parseDsmlToolCalls(text), null);
});

test('aggregate: 零原生调用 + DSML 正文 → 工具调用还原 + finish=tool_calls', () => {
  const events = [
    { event: 'output', data: { response: '执行写入。<dsml:calls><dsml:invoke name="write_file"><dsml:parameter name="path">a.txt</dsml:parameter></dsml:invoke></dsml:calls>' } },
    { event: 'done', data: { finish_reason: 'stop' } },
  ];
  const out = aggregate(events, 'deepseek-v4.1-flash');
  assert.strictEqual(out.choices[0].finish_reason, 'tool_calls');
  assert.strictEqual(out.choices[0].message.tool_calls.length, 1);
  assert.strictEqual(out.choices[0].message.tool_calls[0].function.name, 'write_file');
  assert.strictEqual(out.choices[0].message.content, '执行写入。');
});

test('aggregate: 原生 tool_calls 存在时 DSML 正文原样保留（原生优先）', () => {
  const events = [
    { event: 'output', data: { response: '参考格式：<dsml:calls><dsml:invoke name="x"></dsml:invoke></dsml:calls>' } },
    { event: 'output', data: { tool_calls: [{ index: 0, id: 'call_real', function_call: { name: 'real_fn', arguments: '{}' } }] } },
    { event: 'done', data: { finish_reason: 'stop' } },
  ];
  const out = aggregate(events, 'deepseek-v4.1-flash');
  assert.strictEqual(out.choices[0].finish_reason, 'tool_calls');
  assert.strictEqual(out.choices[0].message.tool_calls.length, 1);
  assert.strictEqual(out.choices[0].message.tool_calls[0].function.name, 'real_fn');
  assert.ok(out.choices[0].message.content.includes('<dsml:calls>'));
});

test('gate 流式: 零工具调用 + 未 flush 的 DSML 正文 → 补发解析出的 tool_calls', () => {
  const lines = [];
  const gate = traeworkChat.createTextGate((s) => lines.push(JSON.parse(s)), 'deepseek-v4.1-flash', true);
  gate.onEvent({ event: 'output', data: { response: '执行写入。<dsml:calls><dsml:invoke name="write_file"><dsml:parameter name="path">a.txt</dsml:parameter></dsml:invoke></dsml:calls>' } });
  gate.onEvent({ event: 'done', data: { finish_reason: 'stop' } });
  gate.finish();
  const contents = lines.flatMap((l) => (l.choices[0].delta && l.choices[0].delta.content) ? [l.choices[0].delta.content] : []);
  const tcs = lines.flatMap((l) => (l.choices[0].delta && l.choices[0].delta.tool_calls) ? l.choices[0].delta.tool_calls : []);
  const frs = lines.map((l) => l.choices[0].finish_reason).filter(Boolean);
  // 正文发的是剥离后的干净版（不发 DSML 原文）
  assert.strictEqual(contents.join(''), '执行写入。');
  assert.strictEqual(tcs.length, 1);
  assert.strictEqual(tcs[0].function.name, 'write_file');
  assert.strictEqual(frs.includes('tool_calls'), true);
  assert.ok(!contents.join('').includes('dsml'));
});

test('gate 流式: 已转直发（live）后正文含 DSML 维持现状不解析', () => {
  const lines = [];
  const gate = traeworkChat.createTextGate((s) => lines.push(JSON.parse(s)), 'deepseek-v4.1-flash', true);
  const long = '前'.repeat(700) + '<dsml:calls><dsml:invoke name="x"></dsml:invoke></dsml:calls>';
  gate.onEvent({ event: 'output', data: { response: long } });
  gate.onEvent({ event: 'done', data: { finish_reason: 'stop' } });
  gate.finish();
  const all = lines.map((l) => JSON.stringify(l)).join('');
  // live 场景正文原样直发（含 DSML 文本），不产生解析出的 tool_calls
  assert.ok(all.includes('dsml:calls'));
  assert.strictEqual(lines.some((l) => l.choices[0].delta && l.choices[0].delta.tool_calls), false);
});

test('gate 流式: 正常正文（无 DSML）不受影响', () => {
  const lines = [];
  const gate = traeworkChat.createTextGate((s) => lines.push(JSON.parse(s)), 'glm-5.3', true);
  gate.onEvent({ event: 'output', data: { response: '你好' } });
  gate.onEvent({ event: 'done', data: { finish_reason: 'stop' } });
  gate.finish();
  const contents = lines.flatMap((l) => (l.choices[0].delta && l.choices[0].delta.content) ? [l.choices[0].delta.content] : []);
  assert.strictEqual(contents.join(''), '你好');
  assert.strictEqual(lines.some((l) => l.choices[0].delta && l.choices[0].delta.tool_calls), false);
});

test('aggregate: 普通 stop 正文不受影响', () => {
  const events = [
    { event: 'output', data: { response: '你好' } },
    { event: 'done', data: { finish_reason: 'stop' } },
  ];
  const out = aggregate(events, 'glm-5.3');
  assert.strictEqual(out.choices[0].finish_reason, 'stop');
  assert.strictEqual(out.choices[0].message.content, '你好');
  assert.strictEqual(out.choices[0].message.tool_calls, undefined);
});
