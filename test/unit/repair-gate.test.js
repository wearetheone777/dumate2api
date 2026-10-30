// test/unit/repair-gate.test.js - 「播报即收尾」共享模块的纯函数（node:test）
//
// 判定 / 配置 / 追加修复指令 / OpenAI chunk 缓冲门。通道编排（send → 门 → 修复轮）
// 由 test/verify-qwen-repair.js 与 verify-qoder-repair.js 打桩验证。
// 语义基准：TRAE 的 createTextGate / looksUnfinished（test/verify-traework-repair.js
// 已锁定的口径），差异只在输入是标准 OpenAI chunk（COSY 两通道解信封后的形状）。
const { test } = require('node:test');
const assert = require('assert');
const repair = require('../../src/repair');

const BROADCAST = '当前进度：8%｜已完成：枚举文件｜下一步：读取台账。';
const DONE = '当前进度：100%｜三条命令已全部并行执行完成。';

test('looksUnfinished: 含「下一步」判为没干完，100% 收尾不判', () => {
  assert.strictEqual(repair.looksUnfinished(BROADCAST), true);
  assert.strictEqual(repair.looksUnfinished(DONE), false);
  assert.strictEqual(repair.looksUnfinished(''), true);
  assert.strictEqual(repair.looksUnfinished('   '), true);
  assert.strictEqual(repair.looksUnfinished('Done. Next step: none.'), true, '英文 next step 命中');
  assert.strictEqual(repair.looksUnfinished('x'.repeat(700) + ' 下一步'), false, '长正文按真回答处理');
  assert.strictEqual(repair.looksUnfinished('下一步', 2), false, 'cap 生效（超过按真回答）');
});

test('envCaps: 各通道独立的 DUMATE_<前缀>_HOLD_CAP / _REPAIR_RETRY', () => {
  process.env.DUMATE_QWENWORK_HOLD_CAP = '200';
  process.env.DUMATE_QWENWORK_REPAIR_RETRY = '2';
  process.env.DUMATE_QODER_REPAIR_RETRY = '0';
  let c = repair.envCaps('QWENWORK');
  assert.strictEqual(c.HOLD_CAP, 200);
  assert.strictEqual(c.REPAIR_MAX, 2);
  c = repair.envCaps('QODER');
  assert.strictEqual(c.HOLD_CAP, 600, '未设 HOLD_CAP 用默认 600');
  assert.strictEqual(c.REPAIR_MAX, 0, 'REPAIR_RETRY=0 关闭修复');
  c = repair.envCaps('TRAEWORK');
  assert.strictEqual(c.HOLD_CAP, 600);
  assert.strictEqual(c.REPAIR_MAX, 1);
  delete process.env.DUMATE_QWENWORK_HOLD_CAP;
  delete process.env.DUMATE_QWENWORK_REPAIR_RETRY;
  delete process.env.DUMATE_QODER_REPAIR_RETRY;
});

test('appendRepairNudge: 追加一条 user 消息，浅拷贝不改原 payload', () => {
  const p = { model: 'qwen/pro', messages: [{ role: 'user', content: 'hi' }] };
  const n = repair.appendRepairNudge(p);
  assert.strictEqual(p.messages.length, 1, '原 payload 不变');
  assert.notStrictEqual(n, p, '返回新对象');
  assert.notStrictEqual(n.messages, p.messages, 'messages 数组替换（不共享引用）');
  assert.strictEqual(n.messages.length, 2);
  assert.strictEqual(n.messages[0], p.messages[0], '旧消息对象共享（不深拷贝）');
  assert.strictEqual(n.messages[1].role, 'user');
  assert.ok(n.messages[1].content.includes('必须立即调用工具'), '内容是修复指令');
  assert.strictEqual(repair.appendRepairNudge(null), null, 'null 原样返回');
});

test('chunkKind: 五类帧的分类口径', () => {
  const chunk = (d, extra = {}) => ({ choices: [{ delta: d }], ...extra });
  assert.strictEqual(repair.chunkKind(chunk({ tool_calls: [{ id: 'x', function: { name: 'f' } }] })), 'tools');
  assert.strictEqual(repair.chunkKind(chunk({ content: 'hi' })), 'content');
  assert.strictEqual(repair.chunkKind(chunk({ reasoning_content: 'hmm' })), 'reasoning');
  assert.strictEqual(repair.chunkKind(chunk({}, { usage: { total_tokens: 9 } })), 'hold', 'usage 帧暂扣');
  assert.strictEqual(repair.chunkKind({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'hold', 'finish_reason 暂扣');
  assert.strictEqual(repair.chunkKind(chunk({ role: 'assistant', content: '' })), 'pass', '空 delta 放行');
  assert.strictEqual(repair.chunkKind({ choices: [{ message: { content: 'x' } }] }), 'content', 'message 形状也认');
});

/** 驱动一扇门，返回下游收到的帧（解析成对象；[DONE]/非 JSON 用字符串占位） */
function drive(frames, hold, cap) {
  const out = [];
  const gate = repair.createChunkGate((s) => {
    if (s === '[DONE]') { out.push(s); return; }
    try { out.push(JSON.parse(s)); } catch (e) { out.push(s); } // 非 JSON 帧按原样保存
  }, hold, cap);
  for (const f of frames) gate.onInner(f);
  return { out, gate };
}

const txt = (t) => JSON.stringify({ choices: [{ delta: { content: t } }] });
const rsn = (t) => JSON.stringify({ choices: [{ delta: { reasoning_content: t } }] });
const call = (name) => JSON.stringify({
  choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '{}' } }] } }],
});
const usageF = () => JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
const finish = (fr) => JSON.stringify({ choices: [{ delta: {}, finish_reason: fr }] });
const roleFrame = () => JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] });

test('缓冲门: reasoning 直发，工具调用先冲刷正文', () => {
  const { out, gate } = drive([rsn('想'), txt('播报'), call('exec_command'), usageF(), finish('stop'), '[DONE]'], true);
  const kinds = out.map((f) => {
    if (typeof f === 'string') return f;
    const d = (f.choices && f.choices[0] && f.choices[0].delta) || {};
    return Object.keys(d)[0] || 'usage';
  });
  assert.strictEqual(kinds[0], 'reasoning_content', 'reasoning 直发');
  const textIdx = kinds.indexOf('content');
  const callIdx = kinds.indexOf('tool_calls');
  assert.ok(textIdx >= 0 && callIdx > textIdx, '正文先冲刷、工具调用随后（顺序不能反）');
  assert.strictEqual(gate.result().toolCalls === 1, true);
  gate.finish();
  const sentFinish = () => out.filter((f) => typeof f === 'object' && f.choices[0] && f.choices[0].finish_reason);
  assert.ok(sentFinish().length >= 1, 'finish_reason 帧在 finish() 后补发');
  assert.ok(out.some((f) => typeof f === 'object' && f.usage), 'usage 帧在 finish() 后补发');
  assert.strictEqual(out[out.length - 1], '[DONE]', '[DONE] 收在最后');
});

test('缓冲门: 播报即收尾场景 → 内容帧全扣住，finish 吐出（修复放弃时也完整收尾）', () => {
  const { out, gate } = drive([txt(BROADCAST), usageF(), finish('stop'), '[DONE]'], true);
  assert.strictEqual(out.length, 0, '无工具调用时内容帧被扣住');
  assert.strictEqual(gate.result().live, false, '未转直发');
  assert.ok(gate.result().text.includes('下一步'), 'text 保留完整正文供判定');
  gate.finish();
  const contents = out.filter((f) => typeof f === 'object' && f.choices[0] && f.choices[0].delta.content);
  assert.strictEqual(contents.length, 1, 'finish() 补发正文');
  assert.ok(contents[0].choices[0].delta.content.includes('下一步'));
  const frIdx = out.findIndex((f) => typeof f === 'object' && f.choices[0] && f.choices[0].finish_reason);
  const usageIdx = out.findIndex((f) => typeof f === 'object' && f.usage);
  assert.ok(frIdx > 0 && usageIdx > 0, 'usage 与 finish_reason 都在 finish() 后补发');
  assert.ok(usageIdx < frIdx, 'held 帧保持上游到达顺序（门不重排，翻译层对顺序不敏感）');
  assert.strictEqual(out[out.length - 1], '[DONE]');
});

test('缓冲门: 超过 HOLD_CAP 转直发（真·长回答不被扣）', () => {
  const long = 'x'.repeat(610);
  const { out, gate } = drive([txt('短'), txt(long)], true);
  assert.strictEqual(gate.result().live, true);
  assert.strictEqual(out.length, 2, '缓冲的短帧 + 触发帧都下发（顺序与原流一致）');
});

test('缓冲门: hold=false 全直发（纯对话行为与旧路径一致）', () => {
  const { out } = drive([roleFrame(), txt('a'), txt('b'), finish('stop')], false);
  assert.strictEqual(out.length, 4);
  assert.strictEqual(out[1].choices[0].delta.content, 'a');
});

test('缓冲门: 重试轮丢弃——不调 finish() 的门不再吐帧', () => {
  const out = [];
  const gate = repair.createChunkGate((s) => out.push(s), true);
  gate.onInner(txt(BROADCAST));
  gate.onInner(usageF());
  gate.onInner(finish('stop'));
  gate.onInner('[DONE]');
  assert.strictEqual(out.length, 0, '缓冲期下游没收到任何内容帧→err.sent=false，换号仍可行');
  gate.finish();
  assert.ok(out.length > 0, 'finish 补发被丢弃轮的缓冲');
});

test('缓冲门: emitted 统计下游实际收到的帧（含 reasoning）', () => {
  const { gate } = drive([rsn('想'), txt('播报')], true);
  assert.strictEqual(gate.result().emitted, 1, '只 reasoning 出去了，正文在缓冲');
});

test('缓冲门: 非 JSON 帧原样转发；result().pending/held 记账', () => {
  const { out, gate } = drive(['not-json', txt(BROADCAST)], true);
  assert.strictEqual(out[0], 'not-json');
  assert.strictEqual(gate.result().pending, 1);
  assert.strictEqual(gate.result().held, 0);
});
