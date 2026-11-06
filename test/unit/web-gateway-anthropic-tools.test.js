// test/unit/web-gateway-anthropic-tools.test.js - 9084 的 Anthropic 流式翻译补 tool_use
//
// 9084（web-gateway.js）的上游调用恒为非流式（callWithFailover 返回完整
// JSON），Anthropic 的「流式」是把完整结果改写成 SSE 事件序列。此前这个
// 翻译器只发 thinking / text 块，工具调用被静默丢弃——这是全项目唯一还在
// 文本降级的入口（FUSION-BACKLOG §10 P0-1 未覆盖项）。
//
// 本测试锁定事件序列：块顺序、input_json_delta、stop_reason='tool_use'、
// 无名工具丢弃、空响应保留空 text 块。
const { test } = require('node:test');
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// 数据目录隔离：logRequest → reqlog.record 会写 requests.jsonl
process.env.DUMATE_ADMIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-wg-anth-'));
const { translateStreamToAnthropic } = require('../../src/web-gateway');

function fakeRes() {
  const out = { headStatus: null, body: '' };
  const res = {
    out,
    headersSent: false,
    writeHead(code) { out.headStatus = code; res.headersSent = true; },
    write(s) { out.body += s; },
    end() { out.ended = true; },
  };
  return res;
}

/** 解析 SSE（event: X / data: {json} 成对出现） */
function parseEvents(body) {
  const events = [];
  for (const chunk of body.split('\n\n')) {
    if (!chunk.trim()) continue;
    let ev = null;
    let data = null;
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) ev = line.slice(7);
      else if (line.startsWith('data: ')) data = JSON.parse(line.slice(6));
    }
    if (ev) events.push({ event: ev, data });
  }
  return events;
}

function run(json) {
  const res = fakeRes();
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
  translateStreamToAnthropic({ json, account: null }, req, res, Date.now(), { model: 'glm-5', stream: true, messages: 1 }, 'glm-5');
  return { res, events: parseEvents(res.out.body) };
}

test('纯文本：事件序列不变（无 tool_use 块，end_turn）', () => {
  const { res, events } = run({
    id: 'chatcmpl-1',
    choices: [{ message: { content: '你好' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  });
  assert.equal(res.out.headStatus, 200);
  assert.ok(res.out.ended);
  const names = events.map((e) => e.event);
  assert.deepEqual(names, [
    'message_start',
    'content_block_start', 'content_block_delta', 'content_block_stop',
    'message_delta', 'message_stop',
  ]);
  assert.equal(events[1].data.content_block.type, 'text');
  assert.equal(events[2].data.delta.text, '你好');
  assert.equal(events[4].data.delta.stop_reason, 'end_turn');
});

test('文本 + 工具调用：text 块在前，tool_use 块在后，stop_reason=tool_use', () => {
  const { events } = run({
    choices: [{
      message: {
        content: '我来看一下',
        tool_calls: [{
          id: 'call_abc',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
        }],
      },
      // 上游可能同时报 stop——翻译层必须按「有工具就是 tool_use」纠正
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 },
  });
  const blocks = events.filter((e) => e.event === 'content_block_start').map((e) => e.data.content_block);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[1].type, 'tool_use');
  assert.equal(blocks[1].id, 'call_abc');
  assert.equal(blocks[1].name, 'read_file');
  // input_json_delta 携带完整参数（9084 的上游结果是非流式的，无需累积）
  const delta = events.find((e) => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta');
  assert.ok(delta);
  assert.equal(delta.data.delta.partial_json, '{"path":"a.txt"}');
  const md = events.find((e) => e.event === 'message_delta');
  assert.equal(md.data.delta.stop_reason, 'tool_use');
});

test('只有工具调用（无正文）：不发空 text 块', () => {
  const { events } = run({
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec', arguments: '{}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  });
  const blocks = events.filter((e) => e.event === 'content_block_start').map((e) => e.data.content_block);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'tool_use');
  const md = events.find((e) => e.event === 'message_delta');
  assert.equal(md.data.delta.stop_reason, 'tool_use');
});

test('无名工具被丢弃且不把 stop_reason 翻成 tool_use', () => {
  const { events } = run({
    choices: [{
      message: { content: '好', tool_calls: [{ id: 'call_x', function: { arguments: '{}' } }] },
      finish_reason: 'stop',
    }],
  });
  const blocks = events.filter((e) => e.event === 'content_block_start').map((e) => e.data.content_block);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  const md = events.find((e) => e.event === 'message_delta');
  assert.equal(md.data.delta.stop_reason, 'end_turn');
});

test('空响应（无正文无工具）：保留空 text 块（旧行为不回归）', () => {
  const { events } = run({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
  const blocks = events.filter((e) => e.event === 'content_block_start').map((e) => e.data.content_block);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  const md = events.find((e) => e.event === 'message_delta');
  assert.equal(md.data.delta.stop_reason, 'end_turn');
});

test('thinking 块仍在最前，index 递增', () => {
  const { events } = run({
    choices: [{
      message: {
        reasoning_content: '想一想',
        content: '答',
        tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"x":1}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  });
  const starts = events.filter((e) => e.event === 'content_block_start');
  assert.deepEqual(starts.map((e) => e.data.content_block.type), ['thinking', 'text', 'tool_use']);
  assert.deepEqual(starts.map((e) => e.data.index), [0, 1, 2]);
});
