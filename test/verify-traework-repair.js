// test/verify-traework-repair.js - 「播报即收尾」修复的离线验证（不需要起服务）
//
// 背景（实测 2026-10-05，Doubao-Seed-Evolving，同一份真实 Codex 请求各跑 5 次）：
//   现状 / tool_choice=required / 纪律移到末尾 → 1/5、1/4、3/4（都不可靠）
//   重试时追加「只输出工具调用」→ 5/5
// 所以修法是「检测 + 一次性重试」，本文件锁定这条链路的三个部分：
//   1. looksUnfinished 的判据（模型自己说还有下一步）
//   2. withRepairNudge 的幂等
//   3. createTextGate 的缓冲语义（正文先扣住、工具调用一到先冲刷、usage/finish 暂扣后补）
//   4. 端到端：假上游第一轮只播报、第二轮带工具调用 → 下游只该收到一套完整帧
//
// 打桩方式：直接替换 chat.postStream / chat.readStream 与 auth/credits 的模块属性
// （index.js 通过模块对象调用，补丁生效，不需要真账号也不需要网络）。

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const chat = require(path.join(ROOT, 'src/traework/chat.js'));
const authStore = require(path.join(ROOT, 'src/traework/auth.js'));
const credits = require(path.join(ROOT, 'src/traework/credits.js'));
const traework = require(path.join(ROOT, 'src/traework/index.js'));

let pass = 0; let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name); }
}
function section(t) { console.log('\n' + t); }

// ---------------------------------------------------------------------------
section('1. looksUnfinished 判据');
ok(chat.looksUnfinished('当前进度：8%｜已完成：枚举文件｜下一步：读取台账。') === true,
  '进度播报（含「下一步」）→ 判为没干完');
ok(chat.looksUnfinished('当前进度：100%｜三条命令已全部并行执行完成，输出依次为 A/B/C。') === false,
  '100% 完成播报（无「下一步」）→ 不判失败');
ok(chat.looksUnfinished('') === true, '空正文 → 判为没干完');
ok(chat.looksUnfinished('   ') === true, '纯空白 → 判为没干完');
ok(chat.looksUnfinished('x'.repeat(700) + ' 下一步：随便写点什么') === false,
  '长正文（>600 字）即便含「下一步」也按真回答处理');
ok(chat.looksUnfinished('Done. Next step: none.') === true, '英文 next step 同样命中');

// ---------------------------------------------------------------------------
section('2. withRepairNudge 幂等');
const sample = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
const nudged = JSON.parse(chat.withRepairNudge(sample));
ok(nudged.messages.length === 2, '追加了一条消息');
ok(nudged.messages[1].role === 'user', '追加的是 user 消息');
ok(nudged.messages[1].content[0].text.includes(chat.REPAIR_NUDGE), '内容就是修复指令');
const again = JSON.parse(chat.withRepairNudge(JSON.stringify(nudged)));
ok(again.messages.length === 2, '再次追加不重复（幂等）');
ok(chat.withRepairNudge('not json') === null, '非法 JSON 返回 null（调用方据此放弃重试）');

// ---------------------------------------------------------------------------
section('3. createTextGate 缓冲语义');
function drive(events, hold) {
  const out = [];
  const gate = chat.createTextGate((s) => out.push(JSON.parse(s)), 'm', hold);
  for (const e of events) gate.onEvent(e);
  return { out, gate };
}
const evText = (t) => ({ event: 'output', data: { response: t } });
const evReason = (t) => ({ event: 'output', data: { reasoning_content: t } });
const evCall = (name, args, id) => ({
  event: 'output',
  data: { tool_calls: [{ index: 0, id, type: 'function', function_call: { name, arguments: args } }] },
});
const evUsage = () => ({ event: 'token_usage', data: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, reasoning_tokens: 5 } });
const evDone = () => ({ event: 'done', data: { finish_reason: 'stop' } });

{
  const { out, gate } = drive([evReason('想'), evText('播报'), evCall('exec_command', '{"cmd":"ls"}', 'c1'), evUsage(), evDone()], true);
  const kinds = out.map((c) => Object.keys(c.choices[0].delta)[0] || 'empty');
  ok(kinds[0] === 'reasoning_content', 'reasoning 直发（不缓冲）');
  const textIdx = kinds.indexOf('content');
  const callIdx = kinds.indexOf('tool_calls');
  ok(textIdx >= 0 && callIdx > textIdx, '正文先冲刷、工具调用随后（顺序不能反）');
  ok(gate.result().toolCalls === 1, '统计到 1 个工具调用');
  gate.finish();
  ok(out.some((c) => c.usage), 'usage 帧在 finish() 后补发');
  // 该场景带工具调用而上游 done 给 stop（2026-10-29 实测），gate 按新口径
  // 纠正为 tool_calls（见 verify-traework-finish-reason.js）。这里断言的是
  // 「补发确实发生」，纠正语义由专项脚本锁定。
  ok(out.some((c) => c.choices[0] && c.choices[0].finish_reason === 'tool_calls'), 'finish_reason 帧在 finish() 后补发（有工具调用 → tool_calls）');
}

{
  const { out, gate } = drive([evText('当前进度：8%｜下一步：读取台账。'), evUsage(), evDone()], true);
  ok(out.length === 0, '无工具调用时正文被扣住（不下发）');
  ok(gate.result().live === false, '未转直发');
  ok(gate.result().text.includes('下一步'), 'text 保留完整正文供判定');
  gate.finish();
  ok(out.length === 3, 'finish() 补发正文 + usage + finish_reason');
}

{
  const long = 'x'.repeat(chat.HOLD_CAP + 50);
  const { out, gate } = drive([evText(long)], true);
  ok(gate.result().live === true, '超过 HOLD_CAP 转直发');
  ok(out.length === 1, '超阈值后正文立即下发');
}

{
  const { out } = drive([evText('a'), evText('b'), evCall('t', '{}', 'c')], false);
  ok(out.length === 3, 'hold=false 时全部直发（行为与旧实现一致）');
  ok(out[0].choices[0].delta.content === 'a', '正文逐块直发');
}

// ---------------------------------------------------------------------------
section('4. 端到端：第一轮只播报 → 重试后带工具调用');
const realPost = chat.postStream;
const realRead = chat.readStream;
const realUsable = authStore.findUsable;
const realCapture = credits.capture;

const BROADCAST = '当前进度：8%｜已完成：枚举工作区文件｜下一步：读取最新章节与连续性台账。';
const ATTEMPT1 = [evReason('先看看有什么'), evText(BROADCAST), evUsage(), evDone()];
const ATTEMPT2 = [evReason('重来'), evText(BROADCAST), evCall('exec_command', '{"cmd":"Get-ChildItem"}', 'call_9'), evUsage(), evDone()];

authStore.findUsable = () => [{ id: 1, uid: 'u1', accessToken: 't', nickname: '测试账号' }];
authStore.needsRefresh = () => false;
credits.capture = () => Promise.resolve();

async function runScenario(script) {
  const bodies = [];
  let i = 0;
  chat.postStream = async (body) => {
    bodies.push(body);
    const events = script[Math.min(i, script.length - 1)];
    i++;
    return { stream: { events }, status: 200 };
  };
  chat.readStream = async (stream, onEvent) => { for (const e of stream.events) onEvent(e); };
  const chunks = [];
  await traework.send({
    model: 'traework/Doubao-Seed-Evolving',
    messages: [{ role: 'user', content: '继续创作小说的内容一次3章' }],
    tools: [{ type: 'function', function: { name: 'exec_command', description: 'x', parameters: { type: 'object' } } }],
    stream: true,
  }, (s) => chunks.push(JSON.parse(s)));
  return { bodies, chunks };
}

(async () => {
  {
    const { bodies, chunks } = await runScenario([ATTEMPT1, ATTEMPT2]);
    ok(bodies.length === 2, '只重试一次（上游被调 2 次）');
    const lastMsgText = (b) => {
      const m = JSON.parse(b).messages.slice(-1)[0];
      return Array.isArray(m.content) ? m.content.map((p) => p.text || '').join('') : String(m.content || '');
    };
    ok(lastMsgText(bodies[1]).includes(chat.REPAIR_NUDGE), '第二次请求带上了修复指令');
    ok(!lastMsgText(bodies[0]).includes(chat.REPAIR_NUDGE), '第一次请求不带修复指令');
    const finishCount = chunks.filter((c) => c.choices[0] && c.choices[0].finish_reason).length;
    ok(finishCount === 1, 'finish_reason 只出现一次（第一轮的被扣住丢弃）');
    ok(chunks.some((c) => c.choices[0] && c.choices[0].delta.tool_calls), '工具调用被下发');
    const textChunks = chunks.filter((c) => c.choices[0] && c.choices[0].delta.content);
    ok(textChunks.length === 1, '正文只下发一次（不重复两轮播报）');
    ok(textChunks[0].choices[0].delta.content === BROADCAST, '下发的是重试轮的正文');
  }

  {
    const { bodies, chunks } = await runScenario([ATTEMPT1, ATTEMPT1]);
    ok(bodies.length === 2, '重试轮仍失败时不再重试（上限 1 次）');
    const textChunks = chunks.filter((c) => c.choices[0] && c.choices[0].delta.content);
    ok(textChunks.length === 1, '放弃时也把正文吐给下游一次');
    const finishCount = chunks.filter((c) => c.choices[0] && c.choices[0].finish_reason).length;
    ok(finishCount === 1, '放弃时 finish_reason 恰好一次');
  }

  {
    // 首轮就调工具 → 不该重试
    const { bodies } = await runScenario([ATTEMPT2]);
    ok(bodies.length === 1, '首轮正常调用工具时不重试');
  }

  {
    // 纯对话（无工具）→ 不缓冲、不重试
    chat.postStream = async (body, auth) => {
      return { stream: { events: [evText('你好呀'), evDone()] }, status: 200 };
    };
    const chunks = [];
    await traework.send({ model: 'traework/glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: true }, (s) => chunks.push(JSON.parse(s)));
    ok(chunks.some((c) => c.choices[0] && c.choices[0].delta.content === '你好呀'), '无工具请求正文直发');
    ok(!chunks.some((c) => c.choices[0] && c.choices[0].delta.content && c.choices[0] && c.choices[0].delta.content.includes(chat.REPAIR_NUDGE)), '无工具请求不触发修复');
  }

  {
    // 关闭修复（REPAIR_MAX=0）→ 只调一次上游
    const saved = chat.REPAIR_MAX;
    chat.REPAIR_MAX = 0;
    const { bodies } = await runScenario([ATTEMPT1, ATTEMPT2]);
    ok(bodies.length === 1, 'DUMATE_TRAEWORK_REPAIR_RETRY=0 时不重试');
    chat.REPAIR_MAX = saved;
  }

  chat.postStream = realPost;
  chat.readStream = realRead;
  authStore.findUsable = realUsable;
  credits.capture = realCapture;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
