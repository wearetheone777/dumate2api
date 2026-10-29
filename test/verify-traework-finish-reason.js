// test/verify-traework-finish-reason.js - TRAE 工具调用时 finish_reason 纠正的离线验证
//
// 背景（2026-10-29 真机抓包，glm-5.3-flash 带工具请求）：TRAE 上游的
// tool_calls 增量正常到达，但 done 帧仍给 {"finish_reason":"stop"}——
// OpenAI 规范应是 tool_calls。网关此前在源头照搬，OpenAI 直通路径
// （/v1/chat/completions 流式 + 非流式）拿到 stop + tool_calls 的
// 不规范组合；生态里 `finish_reason === 'tool_calls'` 是常见的执行判据，
// 拿到 stop 工具就被当正常收尾忽略——「模型说要调工具，但什么都没发生」。
//
// Anthropic 翻译器两处（流式 sentToolUse / 非流式 openAIToAnthropic）此前
// 已各自纠正，本次在源头（traework 模块）归一：
//   1. chat.aggregate          非流式聚合
//   2. chat.createTextGate     流式缓冲门的 done 补帧
//   3. index.runAttempt        无 gate 流式的 done 补帧
//
// 向量为真机抓包原样，不许改。

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const chat = require(path.join(ROOT, 'src/traework/chat.js'));
const authStore = require(path.join(ROOT, 'src/traework/auth.js'));
const credits = require(path.join(ROOT, 'src/traework/credits.js'));
const traework = require(path.join(ROOT, 'src/traework/index.js'));

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ok  ' + name); } else { fail += 1; console.log('  FAIL ' + name); }
}
function section(t) { console.log('\n' + t); }

// ---- 真机抓包向量（2026-10-29，glm-5.3-flash，原样） ----
const CALL_FIRST = { index: 0, id: 'call_2f9a6c3435cc409b9b8b0e18', type: 'function', function_call: { name: 'list_files', arguments: '{"', partial_arguments: null, namespace: null } };
const CALL_ARGS = { index: 0, id: '', type: 'function', function_call: { name: '', arguments: 'path":"."}', partial_arguments: null, namespace: null } };
const DONE_STOP = { event: 'done', data: { finish_reason: 'stop' } };
const DONE_TOOL = { event: 'done', data: { finish_reason: 'tool_calls' } };
const DONE_LENGTH = { event: 'done', data: { finish_reason: 'length' } };
const evUsage = () => ({ event: 'token_usage', data: { prompt_tokens: 484, completion_tokens: 55, total_tokens: 539, reasoning_tokens: 43 } });

// ---------------------------------------------------------------------------
section('1. aggregate（非流式）：上游 stop + 有工具调用 → 纠正为 tool_calls');
{
  const events = [
    { event: 'metadata', data: { session_id: 's1' } },
    { event: 'output', data: { reasoning_content: '需要列目录' } },
    { event: 'output', data: { tool_calls: [CALL_FIRST] } },
    { event: 'output', data: { tool_calls: [CALL_ARGS] } },
    evUsage(),
    DONE_STOP,
  ];
  const out = chat.aggregate(events, 'glm-5.3-flash');
  ok(out.choices[0].finish_reason === 'tool_calls', 'stop 被纠正为 tool_calls（此前原样透传 stop）');
  ok(out.choices[0].message.tool_calls.length === 1, '工具调用本体不受影响');
}
{
  const out = chat.aggregate([
    { event: 'output', data: { response: '正文', tool_calls: [CALL_FIRST] } },
    evUsage(), DONE_LENGTH,
  ], 'm');
  ok(out.choices[0].finish_reason === 'length', 'length 不被覆盖（截断信号优先于工具调用）');
}
section('2. aggregate 回归：无工具 / 上游已给对');
{
  const out = chat.aggregate([{ event: 'output', data: { response: '你好' } }, evUsage(), DONE_STOP], 'm');
  ok(out.choices[0].finish_reason === 'stop', '纯文本 stop 保持 stop');
}
{
  const out = chat.aggregate([{ event: 'output', data: { tool_calls: [CALL_FIRST] } }, evUsage(), DONE_TOOL], 'm');
  ok(out.choices[0].finish_reason === 'tool_calls', '上游自己给对 tool_calls 时原样保留');
}
{
  const out = chat.aggregate([evUsage(), DONE_STOP], 'm');
  ok(out.choices[0].finish_reason === 'stop', '零输出空轮 stop 保持 stop');
}

// ---------------------------------------------------------------------------
section('3. createTextGate（流式缓冲门）：同口径纠正');
function driveGate(events) {
  const out = [];
  const gate = chat.createTextGate((s) => out.push(JSON.parse(s)), 'm', true);
  for (const e of events) gate.onEvent(e);
  gate.finish();
  return out;
}
{
  const out = driveGate([
    { event: 'output', data: { reasoning_content: '想' } },
    { event: 'output', data: { tool_calls: [CALL_FIRST] } },
    { event: 'output', data: { tool_calls: [CALL_ARGS] } },
    evUsage(), DONE_STOP,
  ]);
  const fr = out.map((c) => c.choices[0] && c.choices[0].finish_reason).filter(Boolean);
  ok(fr.length === 1 && fr[0] === 'tool_calls', 'gate 模式 stop 被纠正为 tool_calls，恰好一帧');
}
{
  const out = driveGate([{ event: 'output', data: { response: '播报' } }, evUsage(), DONE_STOP]);
  const fr = out.map((c) => c.choices[0] && c.choices[0].finish_reason).filter(Boolean);
  ok(fr.length === 1 && fr[0] === 'stop', '纯文本 stop 保持 stop（回归）');
}

// ---------------------------------------------------------------------------
section('4. 端到端（打桩上游）：流式与非流式');
const realPost = chat.postStream;
const realRead = chat.readStream;
const realUsable = authStore.findUsable;
const realCapture = credits.capture;
authStore.findUsable = () => [{ id: 1, uid: 'u1', accessToken: 't', nickname: '测试账号' }];
authStore.needsRefresh = () => false;
credits.capture = () => Promise.resolve();

const TOOL_STREAM_EVENTS = [
  { event: 'output', data: { reasoning_content: '需要列目录' } },
  { event: 'output', data: { tool_calls: [CALL_FIRST] } },
  { event: 'output', data: { tool_calls: [CALL_ARGS] } },
  evUsage(),
  DONE_STOP,
];

(async () => {
  // 流式带工具（gate 路径）：done stop → 下游收到 tool_calls
  {
    chat.postStream = async () => ({ stream: { events: TOOL_STREAM_EVENTS }, status: 200 });
    chat.readStream = async (stream, onEvent) => { for (const e of stream.events) onEvent(e); };
    const chunks = [];
    await traework.send({
      model: 'traework/glm-5.3-flash',
      messages: [{ role: 'user', content: '列出当前目录' }],
      tools: [{ type: 'function', function: { name: 'list_files', description: 'x', parameters: { type: 'object' } } }],
      stream: true,
    }, (s) => chunks.push(JSON.parse(s)));
    const fr = chunks.map((c) => c.choices[0] && c.choices[0].finish_reason).filter(Boolean);
    ok(fr.length === 1 && fr[0] === 'tool_calls', '流式端到端：下游 finish_reason 是 tool_calls（实测此前是 stop）');
    ok(chunks.some((c) => c.choices[0] && c.choices[0].delta.tool_calls), '工具调用增量照常下发');
  }

  // 非流式（aggregate 路径）：done stop → 返回体 tool_calls
  {
    chat.postStream = async () => ({ stream: { events: TOOL_STREAM_EVENTS }, status: 200 });
    const out = await traework.send({
      model: 'traework/glm-5.3-flash',
      messages: [{ role: 'user', content: '列出当前目录' }],
      tools: [{ type: 'function', function: { name: 'list_files', description: 'x', parameters: { type: 'object' } } }],
    });
    ok(out.choices[0].finish_reason === 'tool_calls', '非流式端到端：返回体 finish_reason 是 tool_calls');
    ok(Array.isArray(out.choices[0].message.tool_calls) && out.choices[0].message.tool_calls.length === 1, '工具调用聚合一如既往');
  }

  // 纯对话流式（无 gate 路径）：stop 保持 stop（回归）
  {
    chat.postStream = async () => ({ stream: { events: [
      { event: 'output', data: { response: '你好' } }, evUsage(), DONE_STOP,
    ] }, status: 200 });
    const chunks = [];
    await traework.send({
      model: 'traework/glm-5.3-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, (s) => chunks.push(JSON.parse(s)));
    const fr = chunks.map((c) => c.choices[0] && c.choices[0].finish_reason).filter(Boolean);
    ok(fr.length === 1 && fr[0] === 'stop', '无工具纯对话流式 stop 保持（回归）');
  }

  chat.postStream = realPost;
  chat.readStream = realRead;
  authStore.findUsable = realUsable;
  credits.capture = realCapture;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('RUNNER ERROR', e);
  process.exit(1);
});
