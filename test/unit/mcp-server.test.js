// test/unit/mcp-server.test.js - MCP stdio 协议面离线测试（web-pool 打桩）
//
// 覆盖：initialize 握手（protocolVersion 回显）、通知静默、tools/list、
// tools/call 三工具（chat 打桩链路 / list_models / get_status）、未知方法
// -32601、坏 JSON -32700（startMcpStdio 的行解析在子进程冒烟里验证）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-mcp-'));
process.env.DUMATE_ADMIN_DATA = TMP;
process.env.DUMATE_POOL_STATE = path.join(TMP, 'pool-state.json');

const mcp = require('../../src/mcp-server');
const pool = require('../../src/web-pool');

test('initialize 握手：capabilities + serverInfo，protocolVersion 回显客户端', async () => {
  const out = await mcp.handleRpc({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-desktop' } },
  });
  assert.strictEqual(out.id, 1);
  assert.strictEqual(out.result.protocolVersion, '2025-06-18', '回显客户端版本');
  assert.deepStrictEqual(out.result.capabilities, { tools: {} });
  assert.strictEqual(out.result.serverInfo.name, 'dumate2api-mcp');
  // 客户端没带版本 → 规范默认
  const out2 = await mcp.handleRpc({ jsonrpc: '2.0', id: 2, method: 'initialize' });
  assert.strictEqual(out2.result.protocolVersion, '2024-11-05');
});

test('通知与 ping：notifications/initialized 静默（null），ping 回空 result', async () => {
  assert.strictEqual(await mcp.handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const out = await mcp.handleRpc({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepStrictEqual(out.result, {});
  // 通知形态的 ping 也不回
  assert.strictEqual(await mcp.handleRpc({ jsonrpc: '2.0', method: 'ping' }), null);
});

test('tools/list：三工具声明齐全，chat 的 inputSchema 可校验 prompt', async () => {
  const out = await mcp.handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  const names = out.result.tools.map((t) => t.name);
  assert.deepStrictEqual(names, ['chat', 'list_models', 'get_status']);
  const chat = out.result.tools[0];
  assert.strictEqual(chat.inputSchema.properties.prompt.type, 'string');
  assert.ok(chat.inputSchema.properties.model.description.includes('model-text'));
});

test('tools/call chat：走 web-pool（打桩），正文透出、realmodel 注脚、模型归一', async () => {
  const real = pool.callWithFailover;
  const captured = [];
  pool.callWithFailover = async (p, m, body) => {
    captured.push(body);
    return {
      ok: true, status: 200,
      headers: { 'x-dumate-gw-realmodel': 'kimi-k3.1-pro' },
      json: { choices: [{ message: { role: 'assistant', content: '答案' }, finish_reason: 'stop' }], usage: {} },
    };
  };
  try {
    const out = await mcp.handleRpc({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'chat', arguments: { prompt: '你好', model: 'kimi-k31' } },
    });
    assert.strictEqual(out.result.isError, false);
    assert.ok(out.result.content[0].text.includes('答案'));
    assert.ok(out.result.content[0].text.includes('[realmodel: kimi-k3.1-pro]'));
    assert.strictEqual(captured[0].model, 'kimi-k31', '云端真名直通');
    assert.strictEqual(captured[0].messages[0].content, '你好');

    // 失败如实：isError + 原因
    pool.callWithFailover = async () => ({ ok: false, status: 502, error: '所有账号均调用失败' });
    const bad = await mcp.handleRpc({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'chat', arguments: { prompt: 'x' } },
    });
    assert.strictEqual(bad.result.isError, true);
    assert.ok(bad.result.content[0].text.includes('所有账号均调用失败'));
  } finally {
    pool.callWithFailover = real;
  }
});

test('tools/call：list_models 与 get_status 返回 JSON 文本；未知工具 isError', async () => {
  const models = await mcp.handleRpc({
    jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_models', arguments: {} },
  });
  const parsed = JSON.parse(models.result.content[0].text);
  assert.ok(parsed.some((m) => m.id === 'kimi-k31'), '云端模型在列');

  const st = await mcp.handleRpc({
    jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_status', arguments: {} },
  });
  const stj = JSON.parse(st.result.content[0].text);
  assert.ok(Array.isArray(stj.accounts));
  assert.strictEqual(typeof stj.ready, 'number');

  const unk = await mcp.handleRpc({
    jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope', arguments: {} },
  });
  assert.strictEqual(unk.result.isError, true);
  assert.ok(unk.result.content[0].text.includes('未知工具'));
});

test('未知方法 -32601；坏参数走 -32603 不炸进程', async () => {
  const out = await mcp.handleRpc({ jsonrpc: '2.0', id: 10, method: 'resources/list' });
  assert.strictEqual(out.error.code, -32601);
  // tools/call 缺 params → arguments 兜 {} → chat 空参数走链路失败路径
  const real = pool.callWithFailover;
  pool.callWithFailover = async () => ({ ok: false, status: 503, error: '没有可用账号' });
  try {
    const out2 = await mcp.handleRpc({
      jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'chat' },
    });
    assert.strictEqual(out2.result.isError, true, '空参数不炸，走失败路径');
  } finally {
    pool.callWithFailover = real;
  }
});
