// test/verify-qwen-repair.js - 千问通道「播报即收尾」修复的离线验证
//
// 共享判定与缓冲门在 src/repair.js（语义基准是 TRAE 的实测结论，见
// test/verify-traework-repair.js）。本文件锁的是**千问侧的编排**：
//   send → runOnce → buildRound → postStream/post → 缓冲门 → 判定 → 重试
//
// 打桩方式：替换 authStore / bridge / chat.postStream / chat.post / credits
// 的模块属性（index.js 通过模块对象调用，补丁生效）；签名与 body 构造
// 仍走真实实现（bridge.prepareInferAsync 被打桩，因为那一步要拿真凭证）。
//
// 用法：node test/verify-qwen-repair.js
const assert = require('assert');
const os = require('os');
const path = require('path');

// 池状态必须隔离：本文件会走 channelPool.pickCandidate / release，写真实
// data/pool-state.json 会污染正在运行的网关。必须在 require 之前设。
process.env.DUMATE_POOL_STATE = path.join(os.tmpdir(), `dumate-qwen-repair-${process.pid}.json`);

const authStore = require('../src/qwenwork/auth');
const bridge = require('../src/qwenwork/bridge');
const chat = require('../src/qwenwork/chat');
const credits = require('../src/qwenwork/credits');
const qwen = require('../src/qwenwork/index');
const repair = require('../src/repair');

const ACCOUNT = { id: 9911, uid: 'uid-qw', nickname: '千问测试账号', accessToken: 'at', machineId: 'mid' };

let pass = 0; let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name); }
}
function section(t) { console.log('\n' + t); }

// ---- 打桩 ----
authStore.findUsable = () => [ACCOUNT];
chat.ensureAccount = async () => ACCOUNT;
bridge.prepareInferAsync = async ({ bodyJson }) => ({ url: 'https://mock/infer', body: bodyJson, headers: {} });
credits.capture = () => Promise.resolve();

const BROADCAST = '当前进度：8%｜已完成：枚举工作区文件｜下一步：读取最新章节与连续性台账。';
const DONE_TEXT = '当前进度：100%｜三条命令已全部执行完成，输出依次为 A/B/C。';

const frame = (o) => JSON.stringify(o);
const fText = (t) => frame({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
const fReason = (t) => frame({ choices: [{ index: 0, delta: { reasoning_content: t }, finish_reason: null }] });
const fCall = (name) => frame({
  choices: [{
    index: 0,
    delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '{"cmd":"ls"}' } }] },
    finish_reason: null,
  }],
});
const fUsage = () => frame({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 90, total_tokens: 120 } });
const fFinish = (fr) => frame({ choices: [{ index: 0, delta: {}, finish_reason: fr }] });

/** 一轮假的 SSE 帧序列 */
const ROUND_BROADCAST = [fReason('先看看有什么'), fText(BROADCAST), fUsage(), fFinish('stop'), '[DONE]'];
const ROUND_TOOL = [fReason('重来'), fText(BROADCAST), fCall('exec_command'), fUsage(), fFinish('stop'), '[DONE]'];
const ROUND_DONE = [fText(DONE_TEXT), fUsage(), fFinish('stop'), '[DONE]'];

/** 装一个按脚本逐轮返回帧的 postStream 桩，返回记录下来的请求体 */
function scriptStream(script) {
  const bodies = [];
  let i = 0;
  chat.postStream = async (url, body, headers, onChunk) => {
    bodies.push(JSON.parse(body));
    const frames = script[Math.min(i, script.length - 1)];
    i++;
    for (const f of frames) onChunk(f);
    return { status: 200, headers: {}, raw: '' };
  };
  return bodies;
}

const TOOLS = [{ type: 'function', function: { name: 'exec_command', description: 'x', parameters: { type: 'object' } } }];
const payload = (extra = {}) => ({
  model: 'qwen/pro',
  messages: [{ role: 'user', content: '继续创作下3章' }],
  tools: TOOLS,
  stream: true,
  ...extra,
});

async function collect(p) {
  const chunks = [];
  await qwen.send(p, (s) => chunks.push(s === '[DONE]' ? s : JSON.parse(s)));
  return chunks;
}
const textOf = (chunks) => chunks
  .filter((c) => typeof c === 'object' && c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.content)
  .map((c) => c.choices[0].delta.content).join('');
const finishCount = (chunks) => chunks.filter((c) => typeof c === 'object' && c.choices && c.choices[0] && c.choices[0].finish_reason).length;
const hasTool = (chunks) => chunks.some((c) => typeof c === 'object' && c.choices && c.choices[0]
  && Array.isArray(c.choices[0].delta && c.choices[0].delta.tool_calls));

(async () => {
  // ---------------------------------------------------------------------
  section('1. 首轮只播报 → 重试后带工具调用');
  {
    const bodies = scriptStream([ROUND_BROADCAST, ROUND_TOOL]);
    const chunks = await collect(payload());
    ok(bodies.length === 2, '上游被调 2 次（检测到播报即收尾后重试一次）');
    const lastText = (b) => {
      const m = b.messages[b.messages.length - 1];
      return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    };
    ok(lastText(bodies[0]).includes('继续创作下3章'), '首轮末尾还是原用户消息');
    ok(lastText(bodies[1]) === repair.REPAIR_NUDGE, '重试轮末尾追加了修复指令');
    ok(bodies[0].request_id !== bodies[1].request_id, 'request_id 每轮新生成（单次请求的标识）');
    ok(bodies[0].session_id === bodies[1].session_id, 'session_id 跨轮钉住（同一段对话的下一句）');
    ok(hasTool(chunks), '工具调用被下发到下游');
    ok(textOf(chunks) === BROADCAST, '正文只下发重试轮那一份（首轮的被丢弃）');
    ok(finishCount(chunks) === 1, 'finish_reason 恰好一次（首轮的被丢弃）');
    ok(chunks[chunks.length - 1] === '[DONE]', '[DONE] 收在最后');
    const usageFrames = chunks.filter((c) => typeof c === 'object' && c.usage);
    ok(usageFrames.length === 1, 'usage 帧恰好一次');
    ok(usageFrames[0].usage.total_tokens === 120, '留下的是重试轮的 usage');
  }

  // ---------------------------------------------------------------------
  section('2. 重试轮仍只播报 → 不再重试，把正文吐给下游');
  {
    const bodies = scriptStream([ROUND_BROADCAST, ROUND_BROADCAST]);
    const chunks = await collect(payload());
    ok(bodies.length === 2, '上限 1 次，不会无限重试');
    ok(textOf(chunks) === BROADCAST, '放弃时正文恰好下发一次');
    ok(finishCount(chunks) === 1, '放弃时 finish_reason 恰好一次');
    ok(chunks[chunks.length - 1] === '[DONE]', '[DONE] 收在最后');
  }

  // ---------------------------------------------------------------------
  section('3. 正常收尾 / 首轮就调工具 → 不重试');
  {
    const bodies = scriptStream([ROUND_TOOL]);
    const chunks = await collect(payload());
    ok(bodies.length === 1, '首轮调工具不重试');
    ok(hasTool(chunks), '工具调用直达下游');
    ok(textOf(chunks) === BROADCAST, '正文先于工具调用吐出');
  }
  {
    const bodies = scriptStream([ROUND_DONE]);
    const chunks = await collect(payload());
    ok(bodies.length === 1, '100% 完成播报不重试（判据不是「没有工具调用」）');
    ok(textOf(chunks) === DONE_TEXT, '正常收尾正文完整下发');
  }

  // ---------------------------------------------------------------------
  section('4. 纯对话（无工具）不缓冲、不重试');
  {
    const bodies = scriptStream([ROUND_BROADCAST]);
    const chunks = await collect(payload({ tools: [] }));
    ok(bodies.length === 1, '无工具请求不重试');
    ok(textOf(chunks) === BROADCAST, '正文照样下发（含「下一步」也不拦）');
  }

  // ---------------------------------------------------------------------
  section('5. 长正文（> HOLD_CAP）按真回答处理');
  {
    const long = 'x'.repeat(700);
    const bodies = scriptStream([[fText(long), fUsage(), fFinish('stop'), '[DONE]']]);
    const chunks = await collect(payload());
    ok(bodies.length === 1, '长正文不触发重试');
    ok(textOf(chunks) === long, '长正文完整透传');
  }

  // ---------------------------------------------------------------------
  section('6. 关闭修复（DUMATE_QWENWORK_REPAIR_RETRY=0）');
  {
    process.env.DUMATE_QWENWORK_REPAIR_RETRY = '0';
    const bodies = scriptStream([ROUND_BROADCAST, ROUND_TOOL]);
    const chunks = await collect(payload());
    ok(bodies.length === 1, '关掉后只调一次上游');
    ok(textOf(chunks) === BROADCAST, '正文照常下发');
    delete process.env.DUMATE_QWENWORK_REPAIR_RETRY;
  }

  // ---------------------------------------------------------------------
  section('7. 非流式：聚合后判定同样生效');
  {
    const bodies = [];
    let i = 0;
    const rounds = [ROUND_BROADCAST, ROUND_TOOL];
    chat.post = async (url, body) => {
      bodies.push(JSON.parse(body));
      const frames = rounds[Math.min(i, rounds.length - 1)];
      i++;
      const raw = frames.map((f) => `data: ${f}`).join('\n') + '\n';
      return { status: 200, headers: {}, raw };
    };
    const out = await qwen.chatCompletion(payload({ stream: false }));
    const msg = out.choices[0].message;
    ok(bodies.length === 2, '非流式也触发重试');
    ok(Array.isArray(msg.tool_calls) && msg.tool_calls.length === 1, '返回的是重试轮的工具调用');
    ok(bodies[1].messages[bodies[1].messages.length - 1].content === repair.REPAIR_NUDGE, '重试轮带修复指令');
  }
  {
    const bodies = [];
    chat.post = async (url, body) => {
      bodies.push(JSON.parse(body));
      const raw = ROUND_DONE.map((f) => `data: ${f}`).join('\n') + '\n';
      return { status: 200, headers: {}, raw };
    };
    const out = await qwen.chatCompletion(payload({ stream: false }));
    ok(bodies.length === 1, '正常收尾不重试');
    ok(out.choices[0].message.content === DONE_TEXT, '正文完整');
  }

  // ---------------------------------------------------------------------
  section('8. 上游错误帧不因修复而变形（错误仍如实抛出）');
  {
    const bodies = [];
    chat.postStream = async (url, body, headers, onChunk) => {
      bodies.push(JSON.parse(body));
      onChunk(frame({ code: 402, message: 'quota exhausted' }));
      onChunk('[DONE]');
      return { status: 200, headers: {}, raw: '' };
    };
    let err = null;
    try { await collect(payload()); } catch (e) { err = e; }
    ok(!!err, '错误被抛出（不吞成空回答）');
    ok(err && Number(err.statusCode) === 402, '状态码透传：' + (err && err.statusCode));
    ok(bodies.length === 1, '错误不触发修复重试');
  }

  // ---------------------------------------------------------------------
  section('9. 已吐出 reasoning 后上游报错 → err.sent=true（不能再换号）');
  {
    // 前两节故意喂了 402/500，账号已进冷却——不复活的话这里会先撞「没有可用
    // 账号」的 503，测的根本不是本节的路径。
    require('../src/pool').pool.revive('qwenwork:9911');
    chat.postStream = async (url, body, headers, onChunk) => {
      onChunk(fReason('先想想'));                 // 门直发（reasoning 从不缓冲）
      onChunk(frame({ code: 500, message: 'boom' }));
      onChunk('[DONE]');
      return { status: 200, headers: {}, raw: '' };
    };
    let err = null;
    try { await collect(payload()); } catch (e) { err = e; }
    ok(!!err, '错误被抛出');
    ok(err && err.sent === true, 'err.sent=true（客户端已看到 reasoning，换号会输出两段）');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
