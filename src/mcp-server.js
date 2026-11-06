// src/mcp-server.js - MCP stdio 服务 + CLI 交互模式（零运行时依赖）
//
// 来源（2026-11-06，清单项「MCP stdio 模式 + CLI 模式」）：融合自社区项目
// Alphaxiaoteng/dumate2api 的 `--mcp` 与 `cli` 子命令形态——让 Claude Desktop
// 等 MCP 宿主与终端管道免配 OpenAI 端点直接用搭子。
//
// 与参考实现的差异：chat 链路走 **web-pool（云端网关）** 而不是本地 8980——
// 不依赖桌面客户端在跑，与 9084 同一条多账号链路（含 token 生命周期与
// 故障转移）。stdio 边界即信任边界：本机进程直接进程内调 web-pool，
// **不经** keys.js 鉴权（HTTP 鉴权对 stdio 无意义）。
//
// 协议：MCP 2024-11-05 的 stdio 传输——**newline-delimited JSON**（一行一条
// JSON-RPC 消息，消息内不得有裸换行）。只实现核心面：
//   initialize / notifications/initialized / ping / tools/list / tools/call
// 其余方法（resources/prompts/logging）如实回 -32601，不编空实现。
//
// 用法：
//   node src/mcp-server.js --mcp                 MCP stdio 模式（挂进 MCP 宿主）
//   node src/mcp-server.js cli "问题"            单次问答（可接管道）
//   node src/mcp-server.js cli                   交互式 REPL
const readline = require('readline');
const pool = require('./web-pool');
const modelmap = require('./modelmap');
const { resolveMaxTokens } = require('./budget');

const SERVER_INFO = { name: 'dumate2api-mcp', version: '1.1.0' };

// -------------------- 链路（chat / 状态） --------------------

/** 单轮问答：走 web-pool 故障转移，非流式聚合。返回 { ok, text, usage, model, error } */
async function chatOnce({ prompt, messages, model }) {
  const list = Array.isArray(messages) && messages.length
    ? messages
    : [{ role: 'user', content: String(prompt == null ? '' : prompt) }];
  if (!list.length) return { ok: false, error: 'prompt 或 messages 至少给一个' };
  const body = {
    model: modelmap.toCloudModel(model || 'model-text'),
    messages: list.map((m) => ({
      role: m && m.role ? String(m.role) : 'user',
      content: m && m.content != null
        ? (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
        : '',
    })),
    max_tokens: resolveMaxTokens(undefined),
    stream: false,
  };
  const r = await pool.callWithFailover('/chat/completions', 'POST', body, { timeout: 300000 });
  if (!r.ok) {
    return { ok: false, error: r.error || `HTTP ${r.status}`, status: r.status };
  }
  const choice = (r.json && r.json.choices || [])[0] || {};
  const msg = choice.message || {};
  const parts = [];
  if (msg.reasoning_content) parts.push(`<think>\n${msg.reasoning_content}\n</think>`);
  parts.push(msg.content == null ? '' : String(msg.content));
  return {
    ok: true,
    text: parts.join(''),
    finish_reason: choice.finish_reason || null,
    usage: r.json && r.json.usage ? r.json.usage : null,
    realModel: (r.headers && r.headers['x-dumate-gw-realmodel']) || '',
  };
}

/** 状态摘要：账号健康 + token 余量，管理端快照的只读切片 */
function statusSummary() {
  const snap = pool.snapshot();
  const now = Date.now();
  return {
    accounts: snap.map((a) => ({
      name: a.name,
      enabled: a.enabled,
      state: a.state,
      cooling: a.cooling,
      cooldown_remaining_s: a.cooling ? a.cool_remaining_s : 0,
      token_expires_in_s: a.token_expire_at
        ? Math.max(0, Math.round((a.token_expire_at - now) / 1000))
        : null,
      ok_count: a.ok_count,
      fail_count: a.fail_count,
    })),
    ready: snap.filter((a) => a.enabled && !a.cooling && !a.disabled).length,
    total: snap.length,
    gateway: `${pool.GATEWAY_HOST}${pool.GATEWAY_PREFIX}`,
  };
}

/** 可用模型清单（云端名空间 + 实测身份标注） */
function listModels() {
  return modelmap.load().cloud_upstream.map((id) => ({
    id,
    name: modelmap.displayName(id),
  }));
}

// -------------------- MCP 工具声明 --------------------

const TOOLS = [
  {
    name: 'chat',
    description: '向百度搭子（云端网关，多账号自动轮询）提问。给 prompt 做单轮问答，或给 messages 做多轮对话。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '单轮提问（与 messages 二选一）' },
        messages: {
          type: 'array',
          description: '多轮对话（与 prompt 二选一）',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['user', 'assistant', 'system'] },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
          },
        },
        model: { type: 'string', description: `模型名，默认 model-text。可用：${modelmap.DEFAULT_CLOUD_UPSTREAM.join(' / ')}` },
      },
    },
  },
  {
    name: 'list_models',
    description: '列出云端网关接受的模型（含实测身份标注）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_status',
    description: '账号池健康状态：启用数、冷却、token 余量、成败计数。',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args) {
  if (name === 'chat') {
    const r = await chatOnce(args || {});
    return r.ok
      ? { isError: false, text: r.text + (r.realModel ? `\n\n[realmodel: ${r.realModel}]` : '') }
      : { isError: true, text: `chat 失败: ${r.error}` };
  }
  if (name === 'list_models') {
    return { isError: false, text: JSON.stringify(listModels(), null, 2) };
  }
  if (name === 'get_status') {
    return { isError: false, text: JSON.stringify(statusSummary(), null, 2) };
  }
  return { isError: true, text: `未知工具: ${name}` };
}

// -------------------- JSON-RPC dispatch（导出供离线测试） --------------------

/** 处理一条 MCP 消息。返回要写回 stdio 的对象；通知类返回 null。 */
async function handleRpc(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const isNotification = msg.id === undefined || msg.id === null;
  try {
    if (msg.method === 'initialize') {
      // protocolVersion 回显客户端的（2024-11-05 规范：server 响应 client 支持的版本）
      return {
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: msg.params && msg.params.protocolVersion
            ? String(msg.params.protocolVersion) : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    }
    if (msg.method === 'ping') {
      return isNotification ? null : { jsonrpc: '2.0', id: msg.id, result: {} };
    }
    if (msg.method === 'tools/list') {
      return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
    }
    if (msg.method === 'tools/call') {
      const p = msg.params || {};
      const out = await callTool(String(p.name || ''), p.arguments || {});
      return {
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: out.text }], isError: out.isError },
      };
    }
    // notifications/initialized 等通知：静默收下
    if (isNotification) return null;
    return {
      jsonrpc: '2.0', id: msg.id,
      error: { code: -32601, message: `method not found: ${msg.method}` },
    };
  } catch (e) {
    if (isNotification) return null;
    return {
      jsonrpc: '2.0', id: msg.id,
      error: { code: -32603, message: `internal error: ${e.message}` },
    };
  }
}

function startMcpStdio() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const s = String(line || '').trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch (e) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32700, message: 'parse error' },
      }) + '\n');
      return;
    }
    handleRpc(msg).then((out) => {
      if (out) process.stdout.write(JSON.stringify(out) + '\n');
    }).catch(() => { /* handleRpc 已兜内错误 */ });
  });
  // stdin 关闭即退出（MCP 宿主断开）
  rl.on('close', () => process.exit(0));
  console.error(`[mcp] dumate2api MCP server ready (${SERVER_INFO.name})`);
}

// -------------------- CLI 模式 --------------------

async function cliOnce(text) {
  const r = await chatOnce({ prompt: text });
  if (!r.ok) {
    console.error(`✗ ${r.error}`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(r.text + '\n');
  if (r.realModel) console.error(`[realmodel: ${r.realModel}]`);
}

async function cliRepl() {
  console.error(`dumate2api REPL（${listModels().map((m) => m.id).join(' / ')}）— Ctrl+C 退出`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  for await (const line of rl) {
    const s = String(line || '').trim();
    if (!s) continue;
    await cliOnce(s);
  }
}

async function cli(args) {
  // 管道输入：stdin 非 TTY 且有内容时拼进 prompt（git diff | cli "review this"）
  if (!process.stdin.isTTY) {
    const piped = await new Promise((resolve) => {
      const chunks = [];
      let total = 0;
      process.stdin.on('data', (c) => { total += c.length; if (total <= 4 * 1024 * 1024) chunks.push(c); });
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
      process.stdin.on('error', () => resolve(''));
      // TTY 挂起时 end 不会来——3 秒兜底放行
      setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8').trim()), 3000).unref();
    });
    if (piped) {
      const q = args.join(' ');
      return cliOnce(q ? `${q}\n\n<input>\n${piped}\n</input>` : piped);
    }
  }
  const q = args.join(' ').trim();
  if (q) return cliOnce(q);
  return cliRepl();
}

module.exports = { handleRpc, chatOnce, statusSummary, listModels, callTool, TOOLS, startMcpStdio, cli };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--mcp') {
    startMcpStdio();
  } else if (argv[0] === 'cli') {
    cli(argv.slice(1)).catch((e) => { console.error(e.message); process.exit(1); });
  } else {
    console.log('用法: node src/mcp-server.js --mcp | cli ["问题"]');
    process.exit(argv.length ? 1 : 0);
  }
}
