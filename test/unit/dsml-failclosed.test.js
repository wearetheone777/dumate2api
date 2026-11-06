// test/unit/dsml-failclosed.test.js - DSML fail-closed 三分判据（hub#120 推广）
//
// 2026-10-31 把 TRAE 的 DSML 解析收敛到 src/repair.js 并补三分判据：
//   recovered 完整块还原；empty 空壳剥离 + WARN；leak 未闭合结构报错；
//   代码围栏内的 DSML 是模型在讨论格式，不碰。TRAE 门与共享 chunk 门同一语义。
const { test } = require('node:test');
const assert = require('assert');
const repair = require('../../src/repair');

const CALLS = '<dsml:calls><dsml:invoke name="read_file">'
  + '<dsml:parameter name="path">/tmp/a.txt</dsml:parameter></dsml:invoke></dsml:calls>';

test('classifyDsml: 无标记 → none', () => {
  assert.strictEqual(repair.classifyDsml('普通正文').kind, 'none');
  assert.strictEqual(repair.classifyDsml('').kind, 'none');
});

test('classifyDsml: 围栏内的 DSML 是讨论格式 → none（原样交付）', () => {
  assert.strictEqual(repair.classifyDsml('看这个格式：\n```xml\n' + CALLS + '\n```').kind, 'none');
});

test('classifyDsml: 完整块 → recovered（calls + 干净正文）', () => {
  const cls = repair.classifyDsml('先读文件\n' + CALLS);
  assert.strictEqual(cls.kind, 'recovered');
  assert.strictEqual(cls.calls.length, 1);
  assert.strictEqual(cls.calls[0].name, 'read_file');
  assert.strictEqual(JSON.parse(cls.calls[0].arguments).path, '/tmp/a.txt');
  assert.strictEqual(cls.clean, '先读文件');
});

test('classifyDsml: 空壳（标签闭合但无 invoke）→ empty', () => {
  assert.strictEqual(repair.classifyDsml('<dsml:calls></dsml:calls>').kind, 'empty');
  assert.strictEqual(repair.classifyDsml('前文 <DSML_calls> </DSML_calls> 后文').kind, 'empty');
});

test('classifyDsml: 未闭合结构 → leak（fail-closed）', () => {
  assert.strictEqual(repair.classifyDsml('<dsml:calls><dsml:invoke name="x">参数写一半').kind, 'leak');
  assert.strictEqual(repair.classifyDsml('<dsml:invoke name="x">').kind, 'leak');
});

test('classifyDsml: 自闭合 parameter 不算未闭合', () => {
  assert.strictEqual(repair.classifyDsml('<dsml:parameter name="x"/>').kind, 'empty');
});

test('共享 chunk 门 finish：recovered → 干净正文 + tool_calls + finish 纠正', () => {
  const out = [];
  const gate = repair.createChunkGate((s) => out.push(s), true, 600, { model: 'm', channel: 'qoder' });
  gate.onInner(JSON.stringify({ choices: [{ delta: { reasoning_content: '思考' } }] }));
  gate.onInner(JSON.stringify({ choices: [{ delta: { content: '先读文件\n' + CALLS } }] }));
  gate.onInner(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
  gate.finish();
  const frames = out.map((s) => JSON.parse(s));
  const contents = frames.filter((f) => f.choices[0].delta && f.choices[0].delta.content != null);
  assert.ok(contents.some((f) => f.choices[0].delta.content === '先读文件'));
  const tcs = frames.filter((f) => f.choices[0].delta.tool_calls);
  assert.strictEqual(tcs.length, 1);
  assert.strictEqual(tcs[0].choices[0].delta.tool_calls[0].function.name, 'read_file');
  const fins = frames.filter((f) => f.choices[0].finish_reason);
  assert.ok(fins.every((f) => f.choices[0].finish_reason === 'tool_calls'), 'stop 已纠正');
  assert.ok(!out.some((s) => s.includes('<dsml')), '协议标记不外泄（call_dsml_ 前缀的还原 id 不算）');
});

test('共享 chunk 门 finish：围栏内 DSML 原样放行', () => {
  const out = [];
  const gate = repair.createChunkGate((s) => out.push(s), true, 600, { model: 'm', channel: 'qoder' });
  gate.onInner(JSON.stringify({ choices: [{ delta: { content: '```xml\n' + CALLS + '\n```' } }] }));
  gate.finish();
  assert.ok(out.some((s) => s.includes('dsml')), '围栏内容原样下发');
});

test('共享 chunk 门 finish：empty → 标记剥离 + 正文保留', () => {
  const out = [];
  const gate = repair.createChunkGate((s) => out.push(s), true, 600, { model: 'm', channel: 'qwenwork' });
  gate.onInner(JSON.stringify({ choices: [{ delta: { content: '前文 <dsml:calls></dsml:calls> 后文' } }] }));
  gate.finish();
  const joined = out.join('');
  assert.ok(joined.includes('前文'), '正文保留');
  assert.ok(!joined.includes('<dsml'), '标记剥离');
});

test('共享 chunk 门 finish：leak → 抛错（fail-closed）', () => {
  const out = [];
  const gate = repair.createChunkGate((s) => out.push(s), true, 600, { model: 'm', channel: 'qoder' });
  gate.onInner(JSON.stringify({ choices: [{ delta: { reasoning_content: '思考' } }] }));
  gate.onInner(JSON.stringify({ choices: [{ delta: { content: '<dsml:calls><dsml:invoke name="x">' } }] }));
  assert.throws(() => gate.finish(), /fail-closed/);
  // reasoning 已直发：emitted 计数如实，调用方据此标 sent
  assert.ok(out.some((s) => s.includes('思考')));
});

test('共享 chunk 门：不传 opts.model 时不启用 DSML 兜底（向后兼容）', () => {
  const out = [];
  const gate = repair.createChunkGate((s) => out.push(s), true, 600);
  gate.onInner(JSON.stringify({ choices: [{ delta: { content: CALLS } }] }));
  gate.finish();
  assert.ok(out.some((s) => s.includes('dsml')), '原样转发');
});

// ---------------------------------------------------------------------------
// 非流式聚合出口的共享兜底（2026-11-04 收敛：qoder 内联 → 三通道同一份；
// qwenwork 当年整个漏接非流式，这里一并锁住）
// ---------------------------------------------------------------------------

test('aggregateDsmlFallback: recovered → 结构化调用 + 干净正文', () => {
  const calls = new Map();
  const r = repair.aggregateDsmlFallback('qoder', '我先看一下。' + CALLS, calls);
  assert.strictEqual(r.recovered, true);
  assert.strictEqual(r.content, '我先看一下。');
  assert.strictEqual(r.calls.get(0).function.name, 'read_file');
  assert.strictEqual(JSON.parse(r.calls.get(0).function.arguments).path, '/tmp/a.txt');
});

test('aggregateDsmlFallback: 原生调用优先——有 calls 时正文不碰', () => {
  const calls = new Map([[0, { id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }]]);
  const body = '正文 ' + CALLS;
  const r = repair.aggregateDsmlFallback('qoder', body, calls);
  assert.strictEqual(r.recovered, false);
  assert.strictEqual(r.content, body, '可能是模型在讨论格式，原样保留');
  assert.strictEqual(r.calls.get(0).function.name, 'x');
});

test('aggregateDsmlFallback: 围栏内 DSML 原样返回', () => {
  const body = '格式讨论：\n```xml\n' + CALLS + '\n```';
  const r = repair.aggregateDsmlFallback('qwenwork', body, new Map());
  assert.strictEqual(r.recovered, false);
  assert.strictEqual(r.content, body);
});

test('aggregateDsmlFallback: empty → 剥标签 + WARN（不剥离会被判据反复捞出）', () => {
  const r = repair.aggregateDsmlFallback('workbuddy', '<dsml:calls></dsml:calls>', new Map());
  assert.strictEqual(r.recovered, false);
  assert.strictEqual(r.content, '');
});

test('aggregateDsmlFallback: leak → 抛 502（fail-closed）', () => {
  assert.throws(
    () => repair.aggregateDsmlFallback('workbuddy', '<dsml:calls><dsml:invoke name="x">', new Map()),
    (e) => e.statusCode === 502 && /fail-closed/.test(e.message),
  );
});

test('aggregateDsmlFallback: 无标记正文原样（含 calls.size 守卫短路）', () => {
  const r = repair.aggregateDsmlFallback('qwenwork', '普通回答', new Map());
  assert.strictEqual(r.content, '普通回答');
  assert.strictEqual(r.recovered, false);
});
