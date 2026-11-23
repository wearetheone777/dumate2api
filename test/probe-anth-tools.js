// test/probe-anth-tools.js - 探针：Anthropic 路径下的工具调用是否真的传到上游
//
// 用途：Claude Code（claude-cli）走 /v1/messages，而 Codex 走 /v1/responses。
// 两条路径的工具处理**不是同一套代码**（responses.js 有 convertTools，
// anthropic.js 历史上只有文本降级），所以「Codex 能用工具」不代表
// 「Claude Code 也能用」。
//
// 本探针发一个必须用工具才能回答的请求，把原始 SSE 打到 stdout：
//   - 有 content_block_start(type:"tool_use") + input_json_delta → 工具链路通
//   - 只有 text 块，正文里出现 <seed:tool_call> 之类文本 → 工具定义没到上游
//
// 用法：
//   node test/probe-anth-tools.js                        # 打 9080，Doubao-Seed-Evolving
//   node test/probe-anth-tools.js 9080                   # 换端口
//   node test/probe-anth-tools.js 9080 traework/DeepSeek-V4-Flash
//   node test/probe-anth-tools.js 9080 traework/Doubao-Seed-Evolving 1   # 第三个参数=1 时不带 tools（对照组）
//   node test/probe-anth-tools.js 9080 traework/Doubao-Seed-Evolving 0 131072  # 第四个参数=max_tokens
const http = require('http');

const PORT = parseInt(process.argv[2] || '9080', 10);
const MODEL = process.argv[3] || 'traework/Doubao-Seed-Evolving';
const NO_TOOLS = process.argv[4] === '1';
const MAX_TOKENS = parseInt(process.argv[5] || '4096', 10);

const tools = [
  {
    name: 'Glob',
    description: '按 glob 模式列出文件，返回匹配的路径列表。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，例如 **/*.md' },
      },
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

const body = {
  model: MODEL,
  max_tokens: MAX_TOKENS,
  stream: true,
  system: '你是一个编码代理。要查看目录内容时必须调用 Glob 工具，不要自己编造文件列表。',
  messages: [
    { role: 'user', content: '请列出当前小说项目里的全部 markdown 文件。先调用 Glob。' },
  ],
  ...(NO_TOOLS ? {} : { tools, tool_choice: { type: 'auto' } }),
};

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
    console.log(`HTTP ${res.statusCode}`);
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      text += c;
      process.stdout.write(c);
    });
    res.on('end', () => {
      console.log('\n\n===== 判定 =====');
      const hasToolUse = /"type":"tool_use"/.test(text);
      const hasInputJson = /input_json_delta/.test(text);
      // 正文要把所有 text_delta 拼起来再判——文本式工具调用是**逐字分片**到达的
      // （实测 `tool`、`_call`、`>` 各一帧），在单帧上正则匹配必然漏判。
      const joined = (text.match(/"text":"(?:[^"\\]|\\.)*"/g) || [])
        .map((s) => { try { return JSON.parse(`{${s}}`).text; } catch (e) { return ''; } })
        .join('');
      const hasTextToolCall = /seed:tool_call|<function name=|tool_call>/.test(joined);
      const stop = (text.match(/"stop_reason":"([^"]+)"/g) || []).join(',');
      console.log(`tool_use 块:      ${hasToolUse ? '有 ✓' : '没有 ✗'}`);
      console.log(`input_json_delta: ${hasInputJson ? '有 ✓' : '没有 ✗'}`);
      console.log(`正文里的文本式工具调用: ${hasTextToolCall ? '有 ✗（说明上游没拿到工具定义）' : '没有 ✓'}`);
      console.log(`正文拼接结果: ${JSON.stringify(joined).slice(0, 400)}`);
      console.log(`stop_reason: ${stop || '(无)'}`);
      console.log(`带 tools: ${NO_TOOLS ? '否（对照组）' : '是'}`);
    });
  },
);

req.on('error', (e) => console.error('请求失败:', e.message));
req.on('timeout', () => { req.destroy(); console.error('超时'); });
req.write(payload);
req.end();
