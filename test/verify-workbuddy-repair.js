// test/verify-workbuddy-repair.js - WorkBuddy 通道「播报即收尾」修复的离线验证
//
// 共享判定与缓冲门在 src/repair.js（语义基准是 TRAE 的实测结论，见
// test/verify-traework-repair.js）。本文件锁的是 **WorkBuddy 侧的编排**：
//   send → runConversation → postStream/readStream → 缓冲门 → 判定 → 重试
//
// 打桩方式：替换 authStore / chat.postStream / chat.readStream 的模块属性
// （index.js 通过模块对象调用，补丁生效）；body 规范化与聚合仍走真实实现。
//
// 用法：node test/verify-workbuddy-repair.js
const assert = require('assert');
const os = require('os');
const path = require('path');

// 池状态必须隔离：本文件会走 channelPool.pickCandidate / release，写真实
// data/pool-state.json 会污染正在运行的网关。必须在 require 之前设。
process.env.DUMATE_POOL_STATE = path.join(os.tmpdir(), `dumate-wb-repair-${process.pid}.json`);
// 数据目录同样隔离（auth store 虽是打桩，但 store/reqlog 的模块加载会解析目录）
process.env.DUMATE_ADMIN_DATA = path.join(os.tmpdir(), `dumate-wb-repair-data-${process.pid}`);

const authStore = require('../src/workbuddy/auth');
const chat = require('../src/workbuddy/chat');
const wb = require('../src/workbuddy');
const repair = require('../src/repair');

const ACCOUNT = { id: 9911, uid: 'uid-wb', nickname: 'WorkBuddy 测试账号', accessToken: 'at', region: 'cn', lastError: '' };

let pass = 0; let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name); }
}
function section(t) { console.log('\n' + t); }

// ---- 打桩 ----
authStore.findUsable = () => [ACCOUNT];
// index.js 的本地 ensureFresh 先问 needsRefresh——返回 false 即原样使用账号，
// 不进换票路径（换票要真 refreshToken）
authStore.needsRefresh = () => false;
authStore.ensureFresh = async (a) => a;
authStore.patch = () => ACCOUNT;

const BROADCAST = '当前进度：8%｜已完成：枚举工作区文件｜下一步：读取最新章节与连续性台账。';
const DONE_TEXT = '当前进度：100%｜三条命令已全部执行完成，输出依次为 A/B/C。';

// readStream 给的是**已解析的 chunk 对象**（与 src/workbuddy/chat.js 一致），
// null 是 [DONE] 哨兵
const fText = (t) => ({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
const fReason = (t) => ({ choices: [{ index: 0, delta: { reasoning_content: t }, finish_reason: null }] });
const fCall = (name) => ({
  choices: [{
    index: 0,
    delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '{"cmd":"ls"}' } }] },
    finish_reason: null,
  }],
});
const fUsage = (total) => ({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 90, total_tokens: total } });
const fFinish = (fr) => ({ choices: [{ index: 0, delta: {}, finish_reason: fr }] });

/** 一轮假的 SSE 帧序列（null = [DONE]） */
const ROUND_BROADCAST = [fReason('先看看有什么'), fText(BROADCAST), fUsage(120), fFinish('stop'), null];
const ROUND_TOOL = [fReason('重来'), fText(BROADCAST), fCall('exec_command'), fUsage(150), fFinish('stop'), null];
const ROUND_DONE = [fText(DONE_TEXT), fUsage(100), fFinish('stop'), null];

/** 装一个按脚本逐轮返回帧的桩，返回记录下来的请求体 */
function scriptStream(script) {
  const bodies = [];
  let current = [];
  let i = 0;
  chat.postStream = async (region, auth, body) => {
    // 记录**真实出站 body**：真正的 postStream 内部会做 buildChatBody（首条
    // system、conversation_id、prompt_cache_key 都在那一步注入）
    bodies.push(JSON.parse(chat.buildChatBody(body, region, auth).body));
    current = script[Math.min(i, script.length - 1)];
    i++;
    return { stream: {}, status: 200 };
  };
  chat.readStream = async (stream, cb) => { for (const f of current) cb(f); };
  return bodies;
}

const TOOLS = [{ type: 'function', function: { name: 'exec_command', description: 'x', parameters: { type: 'object' } } }];
const payload = (extra = {}) => ({
  model: 'workbuddy/glm-5.3',
  messages: [{ role: 'user', content: '继续创作下3章' }],
  tools: TOOLS,
  stream: true,
  ...extra,
});

async function collect(p) {
  const chunks = [];
  await wb.send(p, (s) => chunks.push(s === '[DONE]' ? s : JSON.parse(s)), { reqId: 'wb-repair-test' });
  return chunks;
}
const textOf = (chunks) => chunks
  .filter((c) => typeof c === 'object' && c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.content)
  .map((c) => c.choices[0].delta.content).join('');
const finishCount = (chunks) => chunks.filter((c) => typeof c === 'object' && c.choices && c.choices[0] && c.choices[0].finish_reason).length;
const hasTool = (chunks) => chunks.some((c) => typeof c === 'object' && c.choices && c.choices[0]
  && Array.isArray(c.choices[0].delta && c.choices[0].delta.tool_calls));
const lastText = (b) => {
  const m = b.messages[b.messages.length - 1];
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
};

(async () => {
  // ---------------------------------------------------------------------
  section('1. 首轮只播报 → 重试后带工具调用');
  {
    const bodies = scriptStream([ROUND_BROADCAST, ROUND_TOOL]);
    const chunks = await collect(payload());
    ok(bodies.length === 2, '上游被调 2 次（检测到播报即收尾后重试一次）');
    ok(lastText(bodies[0]).includes('继续创作下3章'), '首轮末尾还是原用户消息');
    ok(lastText(bodies[1]) === repair.REPAIR_NUDGE, '重试轮末尾追加了修复指令');
    ok(bodies[0].conversation_id === bodies[1].conversation_id,
      'conversation_id 跨轮稳定（首条 user 不变，前缀缓存不被打散）');
    ok(hasTool(chunks), '工具调用被下发到下游');
    ok(textOf(chunks) === BROADCAST, '正文只下发重试轮那一份（首轮的被丢弃）');
    const textIdx = chunks.findIndex((c) => typeof c === 'object' && c.choices && c.choices[0]
      && c.choices[0].delta && c.choices[0].delta.content);
    const toolIdx = chunks.findIndex((c) => typeof c === 'object' && c.choices && c.choices[0]
      && Array.isArray(c.choices[0].delta && c.choices[0].delta.tool_calls));
    ok(textIdx >= 0 && toolIdx > textIdx, '正文先于工具调用吐出（缓冲门冲刷顺序）');
    ok(finishCount(chunks) === 1, 'finish_reason 恰好一次（首轮的被丢弃）');
    ok(chunks[chunks.length - 1] === '[DONE]', '[DONE] 收在最后（裸哨兵，bridge 统一补 data: 前缀）');
    const usageFrames = chunks.filter((c) => typeof c === 'object' && c.usage);
    ok(usageFrames.length === 1, 'usage 帧恰好一次');
    ok(usageFrames[0].usage.total_tokens === 150, '留下的是重试轮的 usage');
    ok(chunks.filter((x) => x === '[DONE]').length === 1, '[DONE] 恰好一次');
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
    ok(chunks[chunks.length - 1] === '[DONE]', '无门路径 [DONE] 也在流尾');
  }

  // ---------------------------------------------------------------------
  section('5. 长正文（> HOLD_CAP）按真回答处理');
  {
    const long = 'x'.repeat(700);
    const bodies = scriptStream([[fText(long), fUsage(90), fFinish('stop'), null]]);
    const chunks = await collect(payload());
    ok(bodies.length === 1, '长正文不触发重试');
    ok(textOf(chunks) === long, '长正文完整透传');
  }

  // ---------------------------------------------------------------------
  section('6. 关闭修复（DUMATE_WORKBUDDY_REPAIR_RETRY=0）');
  {
    process.env.DUMATE_WORKBUDDY_REPAIR_RETRY = '0';
    const bodies = scriptStream([ROUND_BROADCAST, ROUND_TOOL]);
    const chunks = await collect(payload());
    ok(bodies.length === 1, '关掉后只调一次上游');
    ok(textOf(chunks) === BROADCAST, '正文照常下发');
    ok(chunks[chunks.length - 1] === '[DONE]', '[DONE] 照常下发');
    delete process.env.DUMATE_WORKBUDDY_REPAIR_RETRY;
  }

  // ---------------------------------------------------------------------
  section('7. 非流式：聚合后判定同样生效');
  {
    const bodies = scriptStream([ROUND_BROADCAST, ROUND_TOOL]);
    const agg = await wb.chatCompletion(payload({ stream: false }), { reqId: 'wb-repair-test' });
    ok(bodies.length === 2, '非流式也会重试一次');
    ok(lastText(bodies[1]) === repair.REPAIR_NUDGE, '非流式重试轮同样追加修复指令');
    const msg = agg.choices[0].message;
    ok(Array.isArray(msg.tool_calls) && msg.tool_calls.length === 1, '聚合结果带工具调用');
    ok(msg.content === BROADCAST, '聚合正文来自重试轮');
  }

  // ---------------------------------------------------------------------
  section('8. 上游错误不因修复而变形（错误仍如实抛出）');
  {
    require('../src/pool').pool.revive('workbuddy:9911');
    const { EventEmitter } = require('events');
    // 500 的错误体读取走 readAll（要一个会 end 的流，否则 readAll 永不 resolve）
    const endStream = () => { const s = new EventEmitter(); setImmediate(() => s.emit('end')); return s; };
    let calls = 0;
    chat.postStream = async () => {
      calls++;
      return { stream: endStream(), status: 500 };
    };
    chat.readStream = async () => { /* 不应被调用 */ };
    let err = null;
    try { await collect(payload()); } catch (e) { err = e; }
    ok(!!err, '错误被抛出（不吞成空回答）');
    ok(err && Number(err.statusCode) === 500, '状态码透传：' + (err && err.statusCode));
    ok(calls === 1, '错误不触发修复重试');
  }

  // ---------------------------------------------------------------------
  section('9. 已吐出 reasoning 后上游报错 → err.sent=true（不能再换号）');
  {
    require('../src/pool').pool.revive('workbuddy:9911');
    chat.postStream = async () => ({ stream: {}, status: 200 });
    chat.readStream = async (stream, cb) => {
      cb(fReason('先想想'));                 // 门直发（reasoning 从不缓冲）
      throw new Error('socket hang up');
    };
    let err = null;
    try { await collect(payload()); } catch (e) { err = e; }
    ok(!!err, '错误被抛出');
    ok(err && err.sent === true, 'err.sent=true（客户端已看到 reasoning，换号会输出两段）');
  }

  // ---------------------------------------------------------------------
  section('10. err.sent 口径：只缓冲未放行时 sent=false（可安全重试）');
  {
    require('../src/pool').pool.revive('workbuddy:9911');
    chat.postStream = async () => ({ stream: {}, status: 200 });
    chat.readStream = async (stream, cb) => {
      cb(fText('进度：10%'));                 // 正文被门扣住，没到下游
      throw new Error('socket hang up');
    };
    let err = null;
    try { await collect(payload()); } catch (e) { err = e; }
    ok(!!err && err.sent !== true, '正文未放行时 err.sent 不为 true');
  }

  // ---------------------------------------------------------------------
  section('11. 非流式 DSML 兜底（aggregate 出口，2026-11-04 接入）');
  {
    const CALLS = '<dsml:calls><dsml:invoke name="exec_command">'
      + '<dsml:parameter name="cmd">ls</dsml:parameter></dsml:invoke></dsml:calls>';
    // recovered：正文里的 DSML 还原成结构化调用 + finish 纠正
    scriptStream([[fText('先执行。' + CALLS), fUsage(60), fFinish('stop'), null]]);
    const agg = await wb.chatCompletion(payload({ stream: false }), { reqId: 'wb-repair-test' });
    const msg = agg.choices[0].message;
    ok(Array.isArray(msg.tool_calls) && msg.tool_calls[0].function.name === 'exec_command',
      'DSML 还原成结构化调用');
    ok(msg.content === '先执行。', '正文是剥离后的干净版');
    ok(agg.choices[0].finish_reason === 'tool_calls', 'finish stop 已纠正（模型没走原生调用必报 stop）');
    // leak：未闭合结构 fail-closed，如实 502 而不是喂半截协议
    scriptStream([[fText('<dsml:calls><dsml:invoke name="x">'), fUsage(10), fFinish('stop'), null]]);
    let err = null;
    try { await wb.chatCompletion(payload({ stream: false }), { reqId: 'wb-repair-test' }); } catch (e) { err = e; }
    ok(!!err && Number(err.statusCode) === 502 && /fail-closed/.test(err.message),
      '未闭合结构 fail-closed 抛 502');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
