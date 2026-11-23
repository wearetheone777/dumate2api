// test/probe-anth-scale.js - 探针：真实规模的 Anthropic 请求能不能过
//
// Claude Code 发的请求不是「2 个小工具 + 一句话」：
//   - tools 有 15 个左右，每个带长 description 与完整 input_schema
//   - system 里有 skills / 行为约束（几 KB）
//   - tool_result 常常是一整个文件的内容（几十 KB）
//
// 探针按这个量级构造请求，验证上游是否接受（有些上游对 tools 数量或
// 单次 body 大小有限制，超了会直接 400/413）。
//
// 用法：node test/probe-anth-scale.js [port] [model]
const http = require('http');

const PORT = parseInt(process.argv[2] || '9080', 10);
const MODEL = process.argv[3] || 'traework/Doubao-Seed-Evolving';

// 按 Claude Code 的实际工具集构造（名字与语义贴近，描述长度也贴近）
const TOOL_DEFS = [
  ['Task', '启动一个子代理去处理多步骤任务。子代理有独立的上下文，可以并行执行搜索、分析等工作。'],
  ['Bash', '在持久化的 shell 会话里执行 bash 命令。工作目录在会话之间保持不变。可用 & 把长命令放后台运行。'],
  ['Glob', '按 glob 模式快速匹配文件路径，例如 **/*.ts 或 src/**/*.vue。返回按修改时间排序的路径列表。'],
  ['Grep', '基于 ripgrep 的内容搜索。支持正则、文件类型过滤、上下文行数。适合在大仓库里定位实现。'],
  ['Read', '读取文件的完整内容，或按 offset/limit 读一段。可以读图片与 PDF。读大文件前先用 Grep 定位。'],
  ['Edit', '对文件做精确的字符串替换。old_string 必须在文件里唯一，否则会失败。'],
  ['Write', '写入文件（整体覆盖）。已存在时必须先用 Read 读过，否则会被拒绝。'],
  ['NotebookEdit', '编辑 Jupyter notebook 的某个 cell。'],
  ['WebFetch', '抓取一个 URL 并把内容转成 markdown 后分析。只读，不改任何状态。'],
  ['WebSearch', '搜索网络，返回标题与摘要。用于获取超出知识截止时间的信息。'],
  ['TodoWrite', '维护当前会话的任务清单。用于把多步骤任务显式化并跟踪进度。'],
  ['BashOutput', '读取后台 shell 的输出。'],
  ['KillShell', '结束一个后台 shell。'],
  ['ExitPlanMode', '在计划模式下，把计划交给用户审批。'],
  ['SlashCommand', '执行一个自定义斜杠命令。'],
];

const tools = TOOL_DEFS.map(([name, description]) => ({
  name,
  description,
  input_schema: {
    type: 'object',
    properties: {
      [name === 'Bash' ? 'command' : name === 'Glob' || name === 'Grep' ? 'pattern' : 'path']: {
        type: 'string',
        description: '参数说明：' + description.slice(0, 60),
      },
      description: { type: 'string', description: '这次调用要做什么，用一句话说明。' },
      timeout: { type: 'number', description: '超时毫秒数，默认 120000。' },
      options: { type: 'object', properties: { recursive: { type: 'boolean' }, limit: { type: 'number' } } },
    },
    required: [name === 'Bash' ? 'command' : 'path'],
  },
}));

// 长 system：模拟 Claude Code 注入的 skills / 行为约束
const system = [
  '你是一个交互式命令行编码代理。',
  '【输出风格】回答要简短、直接。不要写「好的，我来帮你」这类开场白。',
  '【工具使用】任何涉及文件内容的判断都必须先读文件，不要凭猜测作答。',
  '【执行纪律】任务未完成之前，任何不含工具调用的回复都算任务失败。',
  '【写作规范】续写小说时保持人物口吻一致，章节之间要有连续性台账。',
  '以下是项目技能说明：' + '技能条款：每次落盘后更新台账，并做一次连续性自检。'.repeat(40),
].join('\n');

// 大 tool_result：模拟读了一个 40KB 的文件
const bigFile = Array.from({ length: 400 }, (_, i) => `${String(i + 1).padStart(4, '0')}　这是第 ${i + 1} 行的正文内容，用于把 tool_result 撑到真实量级。`).join('\n');

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
          resolve({ status: res.statusCode, events, raw: text, bytes: Buffer.byteLength(payload) });
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
    .map((e) => e.data.content_block.name);
  const stop = (r.events.find((e) => e.event === 'message_delta') || {}).data;
  return { text, toolUses, stop: stop && stop.delta ? stop.delta.stop_reason : '', usage: stop && stop.usage };
};

(async () => {
  console.log(`工具数=${tools.length} | system=${system.length} 字 | tool_result≈${Math.round(bigFile.length / 1024)}KB | model=${MODEL}`);

  const r1 = await postAnth({
    model: MODEL,
    max_tokens: 8192,
    stream: true,
    system,
    messages: [{ role: 'user', content: '先读 001-第1章.md，然后用一句话概括它写了什么。' }],
    tools,
    tool_choice: { type: 'auto' },
  });
  const s1 = summarize(r1);
  console.log(`第 1 轮: HTTP ${r1.status} | 请求 ${Math.round(r1.bytes / 1024)}KB | stop=${s1.stop} | tool_use=[${s1.toolUses.join(',')}] | usage=${JSON.stringify(s1.usage)}`);
  if (!s1.toolUses.length) { console.log('未产生工具调用，原始尾部:\n' + r1.raw.slice(-700)); return; }

  const name = s1.toolUses[0];
  const r2 = await postAnth({
    model: MODEL,
    max_tokens: 8192,
    stream: true,
    system,
    messages: [
      { role: 'user', content: '先读 001-第1章.md，然后用一句话概括它写了什么。' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_scale_1', name, input: { path: '001-第1章.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_scale_1', content: bigFile }] },
    ],
    tools,
    tool_choice: { type: 'auto' },
  });
  const s2 = summarize(r2);
  console.log(`第 2 轮: HTTP ${r2.status} | 请求 ${Math.round(r2.bytes / 1024)}KB | stop=${s2.stop} | tool_use=[${s2.toolUses.join(',')}] | usage=${JSON.stringify(s2.usage)}`);
  console.log(`正文: ${JSON.stringify(s2.text).slice(0, 300)}`);

  console.log('\n===== 判定 =====');
  const ok = r1.status === 200 && r2.status === 200;
  console.log(`真实规模可用: ${ok ? '是 ✓' : '否 ✗'}`);
  if (!ok) console.log('原始响应尾部:\n' + r2.raw.slice(-800));
})();
