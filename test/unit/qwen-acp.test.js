// test/unit/qwen-acp.test.js - 千问 ACP 会话通道（wsframe / wsclient / promptOf /
// normalizeFrame / runTurn 回环 / 路由注册）
//
// 协议剧本取自 dsh-connect-qwenwork 的实测 README（信封、join/new_prompt、
// 遗留 idle 必须忽略、running 后的 idle 才是结束）。runTurn 用**本地回环
// WS 服务**按剧本回帧——不碰真实上游。
// 运行：node --test test/unit/qwen-acp.test.js
const assert = require('assert');
const { test } = require('node:test');
const http = require('http');
const crypto = require('crypto');

process.env.DUMATE_ADMIN_DATA = process.env.DUMATE_ADMIN_DATA || require('os').tmpdir();

const { encodeFrame, encodeClose, FrameDecoder, OP } = require('../../src/qwenwork/wsframe');
const { WsClient } = require('../../src/qwenwork/wsclient');
const acp = require('../../src/qwenwork/acp');
const router = require('../../src/upstream-router');

// ---- wsframe ----

test('wsframe：文本帧编解码往返（掩码可逆）', () => {
  const wire = encodeFrame('你好 ACP');
  const frames = new FrameDecoder().push(wire);
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].opcode, 'text');
  assert.strictEqual(frames[0].data, '你好 ACP');
});

test('wsframe：长度边界 125/126/65535/65536', () => {
  for (const len of [125, 126, 127, 65535, 65536, 70000]) {
    const s = 'x'.repeat(len);
    const frames = new FrameDecoder().push(encodeFrame(s));
    assert.strictEqual(frames[0].data.length, len, `len=${len}`);
  }
});

test('wsframe：分片聚合（fin=0 两段 + fin=1 收束）', () => {
  const dec = new FrameDecoder();
  // 手工拼分片：opcode TEXT fin=0、CONT fin=0、CONT fin=1
  const mk = (payload, opcode, fin) => {
    const body = Buffer.from(payload, 'utf8');
    const header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | body.length]);
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(body);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    return Buffer.concat([header, mask, masked]);
  };
  const frames = dec.push(Buffer.concat([
    mk('{"a":', OP.TEXT, false), mk('"b":', OP.CONT, false), mk('1}', OP.CONT, true),
  ]));
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].data, '{"a":"b":1}');
});

test('wsframe：半包跨 chunk 与 ping/pong/close', () => {
  const wire = encodeFrame('hello');
  const dec = new FrameDecoder();
  assert.deepStrictEqual(dec.push(wire.subarray(0, 3)), []);       // 半帧不出
  const out = dec.push(wire.subarray(3));
  assert.strictEqual(out[0].data, 'hello');
  const ctl = new FrameDecoder().push(Buffer.concat([
    encodeFrame('', { opcode: OP.PING }),
    encodeFrame('', { opcode: OP.PONG }),
    encodeClose(1009, 'too big'),
  ]));
  assert.deepStrictEqual(ctl.map((f) => f.opcode), ['ping', 'pong', 'close']);
  assert.strictEqual(ctl[2].data, 1009);
});

test('wsframe：服务端回帧不掩码（mask:false）也能解码', () => {
  const frames = new FrameDecoder().push(encodeFrame('plain', { mask: false }));
  assert.strictEqual(frames[0].data, 'plain');
});

// ---- promptOf ----

test('promptOf：序列化与图片占位', () => {
  const p = acp.promptOf([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:…' } }] },
    { role: 'assistant', content: '好', tool_calls: [{ function: { name: 'f1', arguments: '{"x":1}' } }] },
    { role: 'tool', content: '结果' },
    { role: 'user', content: '继续' },
  ]);
  assert.ok(p.startsWith('[system] 你是助手'));
  assert.ok(p.includes('[image omitted]'));
  assert.ok(p.includes('[calls f1] {"x":1}'));
  assert.ok(p.includes('[tool result] 结果'));
  assert.ok(p.trimEnd().endsWith('继续'));
});

test('promptOf：32KB 裁剪——从最老丢、留省略标记、保最新', () => {
  const big = 'y'.repeat(20000);
  const p = acp.promptOf([
    { role: 'system', content: 'SYS' },
    { role: 'user', content: `旧1-${big}` },
    { role: 'user', content: `旧2-${big}` },
    { role: 'user', content: '最新消息-keep' },
  ]);
  assert.ok(Buffer.byteLength(p, 'utf8') < 32000, `裁剪后应低于上限，实际 ${Buffer.byteLength(p, 'utf8')}`);
  assert.ok(p.startsWith('[system] SYS'));
  assert.ok(p.includes('已省略较早的'), '应留省略标记');
  assert.ok(p.includes('最新消息-keep'), '最新一条必须保留');
  assert.ok(!p.includes('旧1-'), '最老的先丢');
});

test('promptOf：单条超限保头尾', () => {
  const huge = 'H'.repeat(40000) + 'TAIL-MARKER';
  const p = acp.promptOf([{ role: 'user', content: huge }]);
  assert.ok(Buffer.byteLength(p, 'utf8') < 32000);
  assert.ok(p.includes('TAIL-MARKER'), '尾部保留（结论常在尾部）');
  assert.ok(p.includes('…已截断…'));
});

// ---- normalizeFrame（README 帧剧本）----

test('normalizeFrame：信封 ping/pong/join_ack/new_prompt result', () => {
  const n = (obj) => acp.normalizeFrame({ data: JSON.stringify(obj) });
  assert.strictEqual(n({ type: 'control', payload: { method: 'ping' } }).kind, 'ping');
  assert.strictEqual(n({ type: 'control', payload: { method: 'pong' } }).kind, 'pong');
  const join = n({ type: 'control', payload: { method: 'join_ack', accepted: true } });
  assert.strictEqual(join.kind, 'join_ack');
  assert.strictEqual(join.accepted, true);
  const res = n({ type: 'control', payload: { id: 1, result: { promptId: 'p1', turnId: 't1' } } });
  assert.strictEqual(res.kind, 'prompt_result');
  assert.strictEqual(res.turnId, 't1');
});

test('normalizeFrame：真机采样形状（2026-11-05，acp-frames.jsonl）', () => {
  const n = (obj) => acp.normalizeFrame({ data: JSON.stringify(obj) });
  // control 帧承载方法：accepted / sessionStatus 在 params 里（真机字段名）
  const join = n({ type: 'control', payload: { jsonrpc: '2.0', method: 'join_ack', params: { accepted: true, currentSeqId: 0, sessionId: 's1' } } });
  assert.strictEqual(join.kind, 'join_ack');
  assert.strictEqual(join.accepted, true);
  const st = n({ type: 'control', payload: { jsonrpc: '2.0', method: 'session_status', params: { sessionId: 's1', sessionStatus: 'starting' } } });
  assert.deepStrictEqual(st, { kind: 'status', state: 'starting' });
  assert.strictEqual(n({ type: 'control', payload: { method: 'session_status', params: { sessionStatus: 'running' } } }).state, 'running');
  // result 形状 {id, result:{promptId, turnId}}
  const res = n({ type: 'control', payload: { jsonrpc: '2.0', id: 1, result: { promptId: 'p1', sessionId: 's1', turnId: 't1' } } });
  assert.strictEqual(res.kind, 'prompt_result');
  assert.strictEqual(res.turnId, 't1');
  // data 帧：update 在 params.update，事件名在 sessionUpdate 键，文本在 content.text
  const msg = n({ type: 'data', seq: 3, payload: { jsonrpc: '2.0', method: 'session/update', params: { _meta: { seq_id: 3 }, sessionId: 's1', update: { _meta: { is_final: false }, content: { text: '你好！我是**', type: 'text' }, messageId: 'm1', sessionUpdate: 'agent_message_chunk' } } } });
  assert.strictEqual(msg.kind, 'message');
  assert.strictEqual(msg.text, '你好！我是**');
  const th = n({ type: 'data', seq: 2, payload: { jsonrpc: '2.0', method: 'session/update', params: { update: { content: { text: '思考', type: 'text' }, sessionUpdate: 'agent_thought_chunk' } } } });
  assert.strictEqual(th.kind, 'thought');
  assert.strictEqual(th.text, '思考');
  // 沙箱生命周期帧归 ignore（不进 DEBUG 日志）
  assert.strictEqual(n({ type: 'control', payload: { method: 'sandbox_status', params: { sandboxStatus: 'pending' } } }).kind, 'ignore');
  assert.strictEqual(n({ type: 'control', payload: { method: 'replay_start', params: {} } }).kind, 'ignore');
  assert.strictEqual(n({ type: 'control', payload: { method: 'refresh_prompt_queue', params: {} } }).kind, 'ignore');
});

test('normalizeFrame：session_status 与增量事件（嵌套形状候选）', () => {
  const n = (obj) => acp.normalizeFrame({ data: JSON.stringify(obj) });
  assert.deepStrictEqual(n({ type: 'data', payload: { seq: 1, update: { type: 'session_status', status: 'running' } } }),
    { kind: 'status', state: 'running' });
  assert.strictEqual(n({ type: 'data', payload: { update: { type: 'session_status', status: 'idle' } } }).state, 'idle');
  const msg = n({ type: 'data', payload: { seq: 2, update: { type: 'agent_message_chunk', text: '你好' } } });
  assert.strictEqual(msg.kind, 'message');
  assert.strictEqual(msg.text, '你好');
  const th = n({ type: 'data', payload: { update: { type: 'agent_thought_chunk', delta: '想' } } });
  assert.strictEqual(th.kind, 'thought');
  assert.strictEqual(th.text, '想');
  assert.strictEqual(n({ type: 'data', payload: { hello: 1 } }).kind, 'unknown');
  assert.strictEqual(acp.normalizeFrame({ data: 'not json' }).kind, 'unknown');
});

// ---- runTurn 本地回环（README 剧本：遗留 idle 必须忽略）----

/** 本地 WS 服务：按剧本回帧。handlers(sessionId) → 帧序列（异步推进） */
function startScriptServer(script) {
  const sent = [];
  const server = http.createServer(() => {});
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    const dec = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const f of dec.push(chunk)) {
        if (f.opcode !== 'text') continue;
        sent.push(f.data);
        const inner = JSON.parse(f.data);
        const payload = inner.payload || {};
        if (payload.method === 'join') {
          socket.write(encodeFrame(JSON.stringify({ type: 'control', payload: { method: 'join_ack', accepted: true } }), { mask: false }));
          script(socket, payload.params && payload.params.sessionId);
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, sent })));
}

test('runTurn：完整回合（遗留 idle 忽略 → running → 增量 → idle 结束）', async () => {
  const { server } = await startScriptServer((socket) => {
    setTimeout(() => {
      // 开始前的遗留 idle：必须被忽略（README 第一坑）
      socket.write(encodeFrame(JSON.stringify({ type: 'data', payload: { seq: 0, update: { type: 'session_status', status: 'idle' } } }), { mask: false }));
      socket.write(encodeFrame(JSON.stringify({ type: 'control', payload: { id: 1, result: { promptId: 'p1', turnId: 't1' } } }), { mask: false }));
      socket.write(encodeFrame(JSON.stringify({ type: 'control', payload: { method: 'new_prompt_ack', accepted: true } }), { mask: false }));
      socket.write(encodeFrame(JSON.stringify({ type: 'data', payload: { seq: 1, update: { type: 'session_status', status: 'running' } } }), { mask: false }));
      socket.write(encodeFrame(JSON.stringify({ type: 'data', payload: { seq: 2, update: { type: 'agent_thought_chunk', text: '思考中' } } }), { mask: false }));
      socket.write(encodeFrame(JSON.stringify({ type: 'data', payload: { seq: 3, update: { type: 'agent_message_chunk', text: '你好，' } } }), { mask: false }));
      socket.write(encodeFrame(JSON.stringify({ type: 'data', payload: { seq: 4, update: { type: 'agent_message_chunk', text: '世界' } } }), { mask: false }));
      socket.write(encodeFrame(JSON.stringify({ type: 'data', payload: { seq: 5, update: { type: 'session_status', status: 'idle' } } }), { mask: false }));
    }, 30);
  });
  try {
    const chunks = [];
    const out = await acp.runTurn({
      token: 'test-token',
      sessionId: 'sess-1',
      prompt: '[user] hi',
      onChunk: (s) => chunks.push(s),
      wsUrl: `ws://127.0.0.1:${server.address().port}/api/chat-ws`,
    });
    assert.strictEqual(out.text, '你好，世界');
    assert.strictEqual(out.reasoning, '思考中');
    const kinds = chunks.map((s) => JSON.parse(s).choices[0].delta.reasoning_content != null
      ? 'reasoning' : 'content');
    assert.deepStrictEqual(kinds, ['reasoning', 'content', 'content']);
  } finally {
    server.close();
  }
});

test('runTurn：收尾前断开 → 报错（1009 提示 32KB）', async () => {
  const { server } = await startScriptServer((socket) => {
    setTimeout(() => {
      socket.write(encodeFrame(JSON.stringify({ type: 'control', payload: { method: 'join_ack', accepted: true } }), { mask: false }));
      socket.write(encodeClose(1009, 'read limited at 32769 bytes'));
    }, 30);
  });
  try {
    await assert.rejects(
      () => acp.runTurn({
        token: 't', sessionId: 's2', prompt: 'x', onChunk: null,
        wsUrl: `ws://127.0.0.1:${server.address().port}/api/chat-ws`,
      }),
      (e) => /32KB/.test(e.message),
    );
  } finally {
    server.close();
  }
});

// ---- 路由注册 ----

test('resolve：qwen-acp/ 前缀 → qwenwork 通道 + acp provider', () => {
  const r = router.resolve('qwen-acp/auto');
  assert.strictEqual(r.channel, 'qwenwork');
  assert.strictEqual(r.target.provider, './qwenwork/acp');
  assert.strictEqual(r.target.direct, true);
  assert.strictEqual(r.model, 'auto');
  assert.strictEqual(router.QWEN_ACP_PREFIX, 'qwen-acp');
});
