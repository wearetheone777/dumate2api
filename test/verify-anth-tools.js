// test/verify-anth-tools.js - 离线验证：Anthropic → OpenAI → SOLO 整条转换链
//
// 覆盖 2026-10-04 的工具链路修复。不需要起服务、不打上游，纯函数比对。
//
// 断言的核心不变量：
//   1. nativeTools=true 时 tools 真的进了 body，且 parameters 被 SOLO 形状
//      改写成**字符串**（traework/chat.js 的 buildBody 要求）
//   2. assistant 的 tool_use → tool_calls（function_call 形状），
//      user 的 tool_result → role:'tool' 且**紧跟在 tool_calls 之后**
//      （中间夹一条 user 文本会让上游认为「工具结果没有对应的调用」）
//   3. 执行纪律在「带工具」时注入、幂等、且能关（与千问同一口径）
//   4. nativeTools=false 时 tools 被丢弃、工具块降级为文本——现在只有 9084
//      多账号网关还用这条路（它的流式翻译器没有 tool_use 块），行为必须不变
const assert = require('assert');
const anthropic = require('../src/anthropic');
const traeworkChat = require('../src/traework/chat');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const tools = [
  { name: 'Glob', description: '列出文件', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Read', description: '读文件', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

// 贴近 Claude Code 的真实形状：system 是块数组（带 cache_control）、
// 历史里有一轮 tool_use / tool_result
const anthReq = {
  model: 'traework/Doubao-Seed-Evolving',
  max_tokens: 8192,
  stream: true,
  system: [{ type: 'text', text: '你是编码代理。', cache_control: { type: 'ephemeral' } }],
  messages: [
    { role: 'user', content: '看看有哪些章节文件。' },
    { role: 'assistant', content: [
      { type: 'text', text: '我先列一下。' },
      { type: 'tool_use', id: 'toolu_1', name: 'Glob', input: { pattern: '**/*.md' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '001.md\n002.md\n' },
    ] },
  ],
  tools,
  tool_choice: { type: 'auto' },
};

console.log('nativeTools=true（直连通道）');
const oai = anthropic.anthropicToOpenAI(anthReq, { nativeTools: true });

check('tools 被转发且保留名称', () => {
  assert.ok(Array.isArray(oai.tools), 'tools 缺失');
  assert.deepStrictEqual(oai.tools.map((t) => t.function.name), ['Glob', 'Read']);
});
check('tools 是 OpenAI function 形状', () => {
  assert.strictEqual(oai.tools[0].type, 'function');
  assert.strictEqual(oai.tools[0].function.parameters.type, 'object');
});
check('tool_choice 映射 auto', () => assert.strictEqual(oai.tool_choice, 'auto'));
check('system 块数组被拼成字符串（cache_control 被忽略）', () => {
  const sys = oai.messages.find((m) => m.role === 'system');
  assert.strictEqual(sys.content, '你是编码代理。');
});
check('assistant 的 tool_use → tool_calls', () => {
  const a = oai.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.ok(a, 'assistant tool_calls 缺失');
  assert.strictEqual(a.tool_calls[0].id, 'toolu_1');
  assert.strictEqual(a.tool_calls[0].function.name, 'Glob');
  assert.strictEqual(JSON.parse(a.tool_calls[0].function.arguments).pattern, '**/*.md');
  assert.strictEqual(a.content, '我先列一下。');
});
check('tool_result → role:"tool"，且紧跟 tool_calls 之后', () => {
  const i = oai.messages.findIndex((m) => m.tool_calls);
  const t = oai.messages[i + 1];
  assert.strictEqual(t.role, 'tool', `下一条不是 tool 消息，而是 ${t.role}`);
  assert.strictEqual(t.tool_call_id, 'toolu_1');
  assert.ok(String(t.content).includes('001.md'));
});

console.log('\nSOLO 形状改写（traework/chat.js buildBody）');
const body = JSON.parse(traeworkChat.buildBody(oai, 'Doubao-Seed-Evolving'));

check('强制 stream=true + 顶层 function=solo_work_lite', () => {
  assert.strictEqual(body.stream, true);
  assert.strictEqual(body.function, 'solo_work_lite');
});
check('tools 的 parameters 被改成 JSON 字符串', () => {
  assert.strictEqual(typeof body.tools[0].function.parameters, 'string');
  assert.strictEqual(JSON.parse(body.tools[0].function.parameters).type, 'object');
});
check('assistant 的 tool_calls 被改成 function_call 形状', () => {
  const a = body.messages.find((m) => m.tool_calls);
  assert.ok(a.tool_calls[0].function_call, 'function_call 形状缺失');
  assert.strictEqual(a.tool_calls[0].function, undefined, '旧的 function 字段没被清掉');
});
check('role:"tool" 消息被保留（工具结果能回到上游）', () => {
  const t = body.messages.find((m) => m.role === 'tool');
  assert.ok(t, 'tool 消息被丢了');
  assert.strictEqual(t.tool_call_id, 'toolu_1');
});
check('执行纪律已注入（带工具的请求）', () => {
  const sys = body.messages.find((m) => m.role === 'system');
  const text = Array.isArray(sys.content) ? sys.content.map((p) => p.text || '').join('') : String(sys.content);
  assert.ok(text.includes('【执行纪律'), '纪律文本没进 system');
});
check('纪律幂等：重复 buildBody 不叠加', () => {
  const again = JSON.parse(traeworkChat.buildBody(oai, 'Doubao-Seed-Evolving'));
  const sys = again.messages.find((m) => m.role === 'system');
  const text = Array.isArray(sys.content) ? sys.content.map((p) => p.text || '').join('') : String(sys.content);
  assert.strictEqual(text.split('【执行纪律').length - 1, 1, '纪律文本出现了多次');
});
check('纪律可关：DUMATE_TRAEWORK_AGENT_DISCIPLINE=0', () => {
  process.env.DUMATE_TRAEWORK_AGENT_DISCIPLINE = '0';
  try {
    const off = JSON.parse(traeworkChat.buildBody(oai, 'Doubao-Seed-Evolving'));
    const sys = off.messages.find((m) => m.role === 'system');
    const text = Array.isArray(sys.content) ? sys.content.map((p) => p.text || '').join('') : String(sys.content);
    assert.ok(!text.includes('【执行纪律'), '开关没生效');
  } finally { delete process.env.DUMATE_TRAEWORK_AGENT_DISCIPLINE; }
});

console.log('\nnativeTools=true（搭子模型名同样走 native，2026-10-31 实测上游支持）');
check('glm-5 的 tools 同样被转发', () => {
  const out = anthropic.anthropicToOpenAI(
    { ...anthReq, model: 'glm-5' },
    { nativeTools: true },
  );
  assert.deepStrictEqual(out.tools.map((t) => t.function.name), ['Glob', 'Read']);
  const a = out.messages.find((m) => m.role === 'assistant');
  assert.ok(Array.isArray(a.tool_calls), 'tool_use 应转成 tool_calls');
});

console.log('\nnativeTools=false（9084 多账号网关，旧行为必须不变）');
const oaiText = anthropic.anthropicToOpenAI(anthReq, { nativeTools: false });

check('tools 被丢弃', () => assert.strictEqual(oaiText.tools, undefined));
check('tool_choice 不传', () => assert.strictEqual(oaiText.tool_choice, undefined));
check('tool_use 降级为 [Tool Use: ...] 文本', () => {
  const a = oaiText.messages.find((m) => m.role === 'assistant');
  assert.ok(String(a.content).includes('[Tool Use: Glob]'));
  assert.strictEqual(a.tool_calls, undefined);
});
check('tool_result 降级为 [Tool Result] 文本', () => {
  const all = oaiText.messages.map((m) => String(m.content)).join('\n');
  assert.ok(all.includes('[Tool Result]'));
});
check('不带 tools 的请求不注入纪律', () => {
  const plain = JSON.parse(traeworkChat.buildBody(
    anthropic.anthropicToOpenAI({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }, { nativeTools: true }),
    'Doubao-Seed-Evolving',
  ));
  const sys = plain.messages.find((m) => m.role === 'system');
  const text = sys ? (Array.isArray(sys.content) ? sys.content.map((p) => p.text || '').join('') : String(sys.content)) : '';
  assert.ok(!text.includes('【执行纪律'), '纯对话请求被注入了纪律');
});

console.log('\n响应侧（openAIToAnthropic）');
check('tool_calls → tool_use，且 stop_reason=tool_use（哪怕上游报 stop）', () => {
  const resp = anthropic.openAIToAnthropic({
    choices: [{ message: { content: '我来查。', tool_calls: [{ id: 'call_1', function: { name: 'Glob', arguments: '{"pattern":"**/*.md"}' } }] }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }, 'm');
  const tu = resp.content.find((c) => c.type === 'tool_use');
  assert.ok(tu, 'tool_use 块缺失');
  assert.strictEqual(tu.name, 'Glob');
  assert.deepStrictEqual(tu.input, { pattern: '**/*.md' });
  assert.strictEqual(resp.stop_reason, 'tool_use', `stop_reason 应为 tool_use，实际 ${resp.stop_reason}`);
});
check('半截 JSON 的 arguments 如实带出（不编空对象）', () => {
  const resp = anthropic.openAIToAnthropic({
    choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'X', arguments: '{"a":' } }] }, finish_reason: 'length' }],
  }, 'm');
  const tu = resp.content.find((c) => c.type === 'tool_use');
  assert.ok(tu.input._raw_arguments, '截断的原始参数没被带出');
});
check('无工具调用时 stop_reason 照旧映射', () => {
  const resp = anthropic.openAIToAnthropic({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }, 'm');
  assert.strictEqual(resp.stop_reason, 'max_tokens');
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
