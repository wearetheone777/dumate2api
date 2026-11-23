// test/probe-anth-multiturn.js - 探针：Anthropic 路径的工具调用**闭环**
//
// 单轮能出 tool_use 只是第一步。真实工作流是：
//   user → assistant(tool_use) → user(tool_result) → assistant(继续)
// 第二轮的请求里带着 assistant 的 tool_use 与 user 的 tool_result，
// 而 anthropic.js 在 native 模式下要把它们转成 OpenAI 的
// `assistant.tool_calls` + `role:"tool"` 消息。**上游认不认这个形状**，
// 决定了 Claude Code 到底能不能连续干活。
//
// 用法：node test/probe-anth-multiturn.js [port] [model]
const http = require('http');

const PORT = parseInt(process.argv[2] || '9080', 10);
const MODEL = process.argv[3] || 'traework/Doubao-Seed-Evolving';

const tools = [
  {
    name: 'Glob',
    description: '按 glob 模式列出文件，返回匹配的路径列表。',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'glob 模式，例如 **/*.md' } },
      required: ['pattern'],
    },
  },
  {
    name: 'Read',
    description: '读取一个文件的完整内容。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } },
      required: ['path'],
    },
  },
];

function postAnth(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'anthropic-version': '2023-06-01',
          'x-api-key': 'nokey',
        },
        timeout: 300000,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          const events = [];
          for (const block of text.split('\n\n')) {
            const lines = block.split('\n');
            const ev = (lines.find((l) => l.startsWith('event: ')) || '').slice(7).trim();
            const dt = (lines.find((l) => l.startsWith('data: ')) || '').slice(6);
            if (!ev) continue;
            try { events.push({ event: ev, data: JSON.parse(dt) }); } catch (e) { /* 非 JSON */ }
          }
          resolve({ status: res.statusCode, events, raw: text });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

const summarize = (r) => {
  const text = r.events
    .filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta')
    .map((e) => e.data.delta.text).join('');
  const toolUses = r.events
    .filter((e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')
    .map((e) => {
      const idx = e.data.index;
      const args = r.events
        .filter((x) => x.event === 'content_block_delta' && x.data.index === idx && x.data.delta.type === 'input_json_delta')
        .map((x) => x.data.delta.partial_json).join('');
      return { id: e.data.content_block.id, name: e.data.content_block.name, args };
    });
  const stop = (r.events.find((e) => e.event === 'message_delta') || {}).data;
  return { text, toolUses, stop: stop && stop.delta ? stop.delta.stop_reason : '', usage: stop && stop.usage };
};

(async () => {
  console.log(`=== 第 1 轮：user 提问（model=${MODEL}）===`);
  const r1 = await postAnth({
    model: MODEL,
    max_tokens: 4096,
    stream: true,
    system: '你是一个编码代理。要查看目录内容时必须调用 Glob 工具，不要自己编造文件列表。',
    messages: [{ role: 'user', content: '请列出当前小说项目里的全部 markdown 文件。先调用 Glob。' }],
    tools,
    tool_choice: { type: 'auto' },
  });
  const s1 = summarize(r1);
  console.log(`HTTP ${r1.status} | stop_reason=${s1.stop} | tool_use=${s1.toolUses.length} | 正文=${JSON.stringify(s1.text).slice(0, 120)}`);
  if (!s1.toolUses.length) {
    console.log('第 1 轮没有 tool_use，后续闭环无从验证。原始响应尾部：');
    console.log(r1.raw.slice(-600));
    return;
  }
  const tu = s1.toolUses[0];
  console.log(`  → ${tu.name}(${tu.args})  id=${tu.id}`);

  console.log('\n=== 第 2 轮：把 tool_result 发回去（这一步验证 role:"tool" 形状）===');
  const r2 = await postAnth({
    model: MODEL,
    max_tokens: 4096,
    stream: true,
    system: '你是一个编码代理。要查看目录内容时必须调用 Glob 工具，不要自己编造文件列表。',
    messages: [
      { role: 'user', content: '请列出当前小说项目里的全部 markdown 文件。先调用 Glob。' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: tu.id, name: tu.name, input: (() => { try { return JSON.parse(tu.args); } catch (e) { return {}; } })() },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: tu.id, content: '001-第1章.md\n002-第2章.md\n003-第3章.md\nAGENTS.md\n' },
        ],
      },
    ],
    tools,
    tool_choice: { type: 'auto' },
  });
  const s2 = summarize(r2);
  console.log(`HTTP ${r2.status} | stop_reason=${s2.stop} | tool_use=${s2.toolUses.length} | usage=${JSON.stringify(s2.usage)}`);
  console.log(`正文: ${JSON.stringify(s2.text).slice(0, 300)}`);
  if (s2.toolUses.length) console.log(`再调工具: ${s2.toolUses.map((t) => `${t.name}(${t.args})`).join(', ')}`);

  console.log('\n===== 判定 =====');
  const ok = r2.status === 200 && (!!s2.text || s2.toolUses.length > 0);
  console.log(`闭环可用: ${ok ? '是 ✓（tool_result 被上游接受，模型继续作答）' : '否 ✗'}`);
  if (!ok) console.log('原始响应尾部:\n' + r2.raw.slice(-800));
})();
