// test/verify-qoder-repair.js - Qoder 通道「播报即收尾」修复的离线验证
//
// 共享判定与缓冲门在 src/repair.js；本文件锁 Qoder 侧的编排：
//   send → runOnce(排队轮) → 缓冲门 → 判定 → applyRound 重建 → 重试
//
// 与千问相比多两条不变量：
//   1. 修复轮必须**重新签名**（body 追加了消息，签名内容随之变化）；
//   2. request_id / session_id 跨轮钉住，但**排队槽位键（request_set_id）不钉**
//      ——修复轮是新的一次排队。
//
// 打桩：auth / session / cosy.encodeAsync / chat.postStream / chat.post /
// credits，不需要账号与网络。池状态必须隔离（见下）。
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DUMATE_POOL_STATE = path.join(os.tmpdir(), `dumate-qoder-repair-${process.pid}.json`);
// 关掉排队等待轮：本文件只验修复，排队行为由 verify-qoder-throttle.js 锁
process.env.DUMATE_QODER_QUEUE_POLL = '0';

const auth = require('../src/qoder/auth');
const session = require('../src/qoder/session');
const cosy = require('../src/qoder/cosy');
const chat = require('../src/qoder/chat');
const credits = require('../src/qoder/credits');
const qoder = require('../src/qoder/index');
const repair = require('../src/repair');

const ACCOUNT = {
  id: 9931, uid: 'uid-qoder', nickname: 'Qoder 测试账号', region: 'cn',
  accessToken: 'at', refreshToken: 'rt',
  machineId: 'mid', machineToken: 'mtok', machineType: '5',
};
const MODELS = [{ key: 'gfmodel', name: 'GLM-5.3-Flash', maxInputTokens: 1000000 }];

let pass = 0; let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name); }
}
function section(t) { console.log('\n' + t); }

auth.findUsable = () => [ACCOUNT];
auth.preferred = () => ACCOUNT;
auth.patch = () => {};
session.ensureAccount = async () => ACCOUNT;
session.cachedModels = () => MODELS;
session.fetchModels = async () => ({ ok: true, models: MODELS });
credits.capture = () => {};
credits.computeBilledRate = () => null;

// 签名打桩：记录每轮的原始 body（encodeAsync 真跑要起 worker，慢且与修复无关）
const signedBodies = [];
cosy.encodeAsync = async (buf) => { signedBodies.push(JSON.parse(buf.toString('utf8'))); return Buffer.from('enc'); };

const fText = (t) => JSON.stringify({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
const fReason = (t) => JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: t }, finish_reason: null }] });
const fCall = (name) => JSON.stringify({
  choices: [{
    index: 0,
    delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '{"cmd":"ls"}' } }] },
    finish_reason: null,
  }],
});
const fUsage = () => JSON.stringify({
  choices: [], usage: { prompt_tokens: 40, completion_tokens: 60, total_tokens: 100, credits: 0.02 },
});
const fFinish = (fr) => JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: fr }] });

const BROADCAST = '当前进度：8%｜已完成：读取目录｜下一步：写入第 3 章。';
const DONE_TEXT = '当前进度：100%｜三章已全部落盘并自检完成。';
const ROUND_BROADCAST = [fReason('先看看'), fText(BROADCAST), fUsage(), fFinish('stop'), '[DONE]'];
const ROUND_TOOL = [fReason('重来'), fText(BROADCAST), fCall('exec_command'), fUsage(), fFinish('stop'), '[DONE]'];
const ROUND_DONE = [fText(DONE_TEXT), fUsage(), fFinish('stop'), '[DONE]'];

function scriptStream(script) {
  const calls = [];
  let i = 0;
  chat.postStream = async (url, body, headers, onChunk) => {
    calls.push({ url, body: body.toString('utf8'), headers });
    const frames = script[Math.min(i, script.length - 1)];
    i++;
    for (const f of frames) onChunk(f);
    return { status: 200, headers: {}, raw: '', aborted: false };
  };
  return calls;
}

const TOOLS = [{ type: 'function', function: { name: 'exec_command', description: 'x', parameters: { type: 'object' } } }];
const payload = (extra = {}) => ({
  model: 'qoder/GLM-5.3-Flash',
  messages: [{ role: 'user', content: '继续写第 3 章' }],
  tools: TOOLS,
  stream: true,
  ...extra,
});

async function collect(p) {
  signedBodies.length = 0;
  const chunks = [];
  await qoder.send(p, (s) => chunks.push(s === '[DONE]' ? s : JSON.parse(s)));
  return chunks;
}
const textOf = (chunks) => chunks
  .filter((c) => typeof c === 'object' && c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.content)
  .map((c) => c.choices[0].delta.content).join('');
const finishCount = (chunks) => chunks.filter((c) => typeof c === 'object' && c.choices && c.choices[0] && c.choices[0].finish_reason).length;
const hasTool = (chunks) => chunks.some((c) => typeof c === 'object' && c.choices && c.choices[0]
  && Array.isArray(c.choices[0].delta && c.choices[0].delta.tool_calls));
const lastMsg = (b) => {
  const m = b.messages[b.messages.length - 1];
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
};

(async () => {
  // ---------------------------------------------------------------------
  section('1. 首轮只播报 → 重试后带工具调用');
  {
    const calls = scriptStream([ROUND_BROADCAST, ROUND_TOOL]);
    const chunks = await collect(payload());
    ok(calls.length === 2, '上游被调 2 次');
    ok(signedBodies.length === 2, '每轮都重新签了名（body 变了签名必须重算）');
    ok(lastMsg(signedBodies[0]).includes('继续写第 3 章'), '首轮末尾是原用户消息');
    ok(lastMsg(signedBodies[1]) === repair.REPAIR_NUDGE, '重试轮末尾追加修复指令');
    ok(signedBodies[0].request_id !== signedBodies[1].request_id, 'request_id 每轮新生成');
    ok(signedBodies[0].session_id === signedBodies[1].session_id, 'session_id 跨轮钉住');
    ok(signedBodies[0].request_set_id !== signedBodies[1].request_set_id,
      '排队槽位键不钉（修复轮是新的一次排队）');
    ok(hasTool(chunks), '工具调用下发');
    ok(textOf(chunks) === BROADCAST, '正文只下发重试轮那一份');
    ok(finishCount(chunks) === 1, 'finish_reason 恰好一次');
    ok(chunks[chunks.length - 1] === '[DONE]', '[DONE] 收在最后');
    const usages = chunks.filter((c) => typeof c === 'object' && c.usage);
    ok(usages.length === 1 && usages[0].usage.total_tokens === 100, '留下重试轮的 usage');
  }

  // ---------------------------------------------------------------------
  section('2. 重试轮仍只播报 → 放弃并吐正文');
  {
    const calls = scriptStream([ROUND_BROADCAST, ROUND_BROADCAST]);
    const chunks = await collect(payload());
    ok(calls.length === 2, '上限 1 次');
    ok(textOf(chunks) === BROADCAST, '正文恰好一次');
    ok(finishCount(chunks) === 1, 'finish_reason 恰好一次');
    ok(chunks[chunks.length - 1] === '[DONE]', '[DONE] 收在最后');
  }

  // ---------------------------------------------------------------------
  section('3. 正常收尾 / 首轮调工具 → 不重试');
  {
    const calls = scriptStream([ROUND_TOOL]);
    const chunks = await collect(payload());
    ok(calls.length === 1, '首轮调工具不重试');
    ok(hasTool(chunks), '工具调用直达');
  }
  {
    const calls = scriptStream([ROUND_DONE]);
    const chunks = await collect(payload());
    ok(calls.length === 1, '100% 完成播报不重试');
    ok(textOf(chunks) === DONE_TEXT, '正文完整');
  }

  // ---------------------------------------------------------------------
  section('4. 纯对话（无工具）不缓冲、不重试');
  {
    const calls = scriptStream([ROUND_BROADCAST]);
    const chunks = await collect(payload({ tools: [] }));
    ok(calls.length === 1, '无工具请求不重试');
    ok(textOf(chunks) === BROADCAST, '正文照常下发');
  }

  // ---------------------------------------------------------------------
  section('5. 关闭修复（DUMATE_QODER_REPAIR_RETRY=0）');
  {
    process.env.DUMATE_QODER_REPAIR_RETRY = '0';
    const calls = scriptStream([ROUND_BROADCAST, ROUND_TOOL]);
    const chunks = await collect(payload());
    ok(calls.length === 1, '关掉后只调一次上游');
    ok(textOf(chunks) === BROADCAST, '正文照常下发');
    delete process.env.DUMATE_QODER_REPAIR_RETRY;
  }

  // ---------------------------------------------------------------------
  section('6. 非流式：聚合后判定同样生效');
  {
    let i = 0;
    const rounds = [ROUND_BROADCAST, ROUND_TOOL];
    const calls = [];
    chat.post = async (url, body) => {
      calls.push({ url });
      const frames = rounds[Math.min(i, rounds.length - 1)];
      i++;
      return { status: 200, headers: {}, raw: frames.map((f) => `data: ${f}`).join('\n') + '\n' };
    };
    signedBodies.length = 0;
    const out = await qoder.chatCompletion(payload({ stream: false }));
    const msg = out.choices[0].message;
    ok(calls.length === 2, '非流式也触发重试');
    ok(Array.isArray(msg.tool_calls) && msg.tool_calls.length === 1, '返回重试轮的工具调用');
    ok(lastMsg(signedBodies[1]) === repair.REPAIR_NUDGE, '重试轮带修复指令');
    ok(signedBodies[0].request_set_id !== signedBodies[1].request_set_id, '非流式同理换槽位键');
  }
  {
    const calls = [];
    chat.post = async (url) => {
      calls.push(url);
      return { status: 200, headers: {}, raw: ROUND_DONE.map((f) => `data: ${f}`).join('\n') + '\n' };
    };
    const out = await qoder.chatCompletion(payload({ stream: false }));
    ok(calls.length === 1, '正常收尾不重试');
    ok(out.choices[0].message.content === DONE_TEXT, '正文完整');
  }

  // ---------------------------------------------------------------------
  section('7. 上游错误不因修复而变形');
  {
    const calls = [];
    chat.postStream = async (url, body, headers, onChunk) => {
      calls.push(url);
      onChunk(JSON.stringify({ code: '112', message: '{"pricingUrl":"https://x"}' }));
      onChunk('[DONE]');
      return { status: 200, headers: {}, raw: '', aborted: true };
    };
    let err = null;
    try { await collect(payload()); } catch (e) { err = e; }
    ok(!!err, '额度类业务码被抛出');
    ok(err && Number(err.statusCode) === 403, '按 403 语义抛出：' + (err && err.statusCode));
    ok(err && err.quotaKind === 'exhausted', 'quotaKind 保留（换号判据要用）');
    ok(calls.length === 1, '错误不触发修复');
  }

  // ---------------------------------------------------------------------
  section('8. 已吐出 reasoning 后上游报错 → err.sent=true（不能再换号）');
  {
    // 上一节喂了额度错误，账号已进冷却——不复活会先撞「没有可用账号」。
    require('../src/pool').pool.revive('qoder:9931');
    chat.postStream = async (url, body, headers, onChunk) => {
      onChunk(fReason('先想想'));                 // 门直发（reasoning 从不缓冲）
      onChunk(JSON.stringify({ code: 500, message: 'boom' }));
      onChunk('[DONE]');
      return { status: 200, headers: {}, raw: '', aborted: true };
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
