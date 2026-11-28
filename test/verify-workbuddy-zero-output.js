// test/verify-workbuddy-zero-output.js - 零输出守卫（批次六）的离线验证
//
// 判据（hub sse.go HeadVetoError 移植，计划原文：200 + finish_reason=length +
// 正文/思考/工具全空 → 首帧否决窗口内换号重发一次（客户端无痕）；全池失败
// 如实 502 zero_output_length + 可行动 hint，不罚账号）：
//   - 三处判定点：非流式聚合后 / 流式带门 gate.result() / 流式无门回调跟踪
//   - 无痕口径：角色帧/空 delta 允许透传（四个翻译器对它们零可见事件），
//     但正文/思考/工具/finish/usage/[DONE] 一帧都不能来自被否决的那一轮
//   - 处置：feed='none' + rotate——不罚账号不喂池，换下一个号重发
//   - 耗尽：全池都空输出 → 502 zero_output_length + 可行动 hint
//
// 打桩方式：替换 authStore / chat.postStream / chat.readStream /
// channelPool.{pickCandidate,noteError,noteSuccess,release} 的模块属性
//（index.js 通过模块对象调用，补丁生效）；runConversation 的门与聚合走真实实现。
//
// 用法：node test/verify-workbuddy-zero-output.js
const assert = require('assert');
const os = require('os');
const path = require('path');

// 池状态必须隔离（本文件会走 channelPool，写真实池会污染运行中的网关）
process.env.DUMATE_POOL_STATE = path.join(os.tmpdir(), `dumate-wb-zeroout-${process.pid}.json`);
process.env.DUMATE_ADMIN_DATA = path.join(os.tmpdir(), `dumate-wb-zeroout-data-${process.pid}`);

const authStore = require('../src/workbuddy/auth');
const chat = require('../src/workbuddy/chat');
const channelPool = require('../src/channel-pool');
const wb = require('../src/workbuddy');

const ACCOUNT_A = { id: 9901, uid: 'uid-wb-a', nickname: '空输出号', accessToken: 'at-a', region: 'cn', lastError: '' };
const ACCOUNT_B = { id: 9902, uid: 'uid-wb-b', nickname: '健康号', accessToken: 'at-b', region: 'cn', lastError: '' };

let pass = 0; let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name); }
}
function section(t) { console.log('\n' + t); }

// ---- 打桩基座：authStore 恒可用，池按 pickOrder 确定性选号 ----
authStore.findUsable = () => [ACCOUNT_A, ACCOUNT_B];
authStore.needsRefresh = () => false;
authStore.ensureFresh = async (a) => a;
const patchCalls = [];
authStore.patch = (id, p) => { patchCalls.push({ id, p }); return ACCOUNT_A; };

// 帧构造器（readStream 给的是已解析 chunk 对象，null = [DONE]）
const fRole = () => ({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
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

const TOOLS = [{ type: 'function', function: { name: 'exec_command', description: 'x', parameters: { type: 'object' } } }];
const payload = (extra = {}) => ({
  model: 'workbuddy/glm-5.3',
  messages: [{ role: 'user', content: '跑一下检查' }],
  stream: true,
  ...extra,
});

let poolNotes = [];        // channelPool.noteError/noteSuccess 调用记录
const released = [];
/** 装桩：pickOrder 决定每轮 pick 返回的账号（确定性轮转）；
 *  scriptByAccount 决定每个账号的帧序（缺省 = 正常轮） */
function stub({ pickOrder, scriptByAccount = {} }) {
  const calls = [];
  const queue = [...pickOrder];
  channelPool.pickCandidate = (channel, pool) => {
    while (queue.length) {
      const acc = queue.shift();
      if (pool.some((p) => p.id === acc.id)) return { account: acc, uid: `u${acc.id}` };
    }
    return null;
  };
  channelPool.noteError = (channel, id, info) => { poolNotes.push({ kind: 'error', id, info }); };
  channelPool.noteSuccess = (channel, id) => { poolNotes.push({ kind: 'success', id }); };
  channelPool.release = (uid) => { released.push(uid); };
  chat.postStream = async (region, auth, body) => {
    chat._currentAuthId = auth.id;
    calls.push({ region, authId: auth.id, model: body && body.model });
    return { stream: {}, status: 200 };
  };
  chat.readStream = async (stream, cb) => {
    const frames = scriptByAccount[chat._currentAuthId] || ROUND_NORMAL;
    for (const f of frames) cb(f);
  };
  return calls;
}

const B_TEXT = '检查完成：三条命令全部通过。';
const ROUND_NORMAL = [fText(B_TEXT), fUsage(200), fFinish('stop'), null];
// 零输出一轮的完整帧序：只有 role/finish/usage/[DONE]
const ROUND_ZERO = [fRole(), fFinish('length'), fUsage(1), null];

async function collectStream(p) {
  const chunks = [];
  await wb.send(p, (s) => chunks.push(s === '[DONE]' ? s : JSON.parse(s)), { reqId: 'wb-zeroout-test' });
  return chunks;
}
const textOf = (chunks) => chunks
  .filter((c) => typeof c === 'object' && c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.content)
  .map((c) => c.choices[0].delta.content).join('');
const finishCount = (chunks) => chunks.filter((c) => typeof c === 'object' && c.choices && c.choices[0] && c.choices[0].finish_reason).length;
const usageCount = (chunks) => chunks.filter((c) => typeof c === 'object' && c.usage).length;

(async () => {
  // ---------------------------------------------------------------------
  section('1. errorActionOf：零输出 → feed=none + rotate（不罚账号，只换号）');
  {
    const e = new Error('x');
    e.zeroOutput = true;
    const act = wb.errorActionOf(e);
    ok(act.feed === 'none' && act.action === 'rotate', `zeroOutput → ${JSON.stringify(act)}`);
    ok(wb.errorActionOf(new Error('y')).feed === 'account', '普通错误仍是兜底喂池（对照）');
  }

  // ---------------------------------------------------------------------
  section('2. 非流式：A 空输出 → 换号 B 成功；客户端只见到 B 的结果');
  {
    const calls = stub({ pickOrder: [ACCOUNT_A, ACCOUNT_B], scriptByAccount: { 9901: ROUND_ZERO, 9902: ROUND_NORMAL } });
    patchCalls.length = 0; poolNotes = []; released.length = 0;
    const p = payload({ stream: false });
    const agg = await wb.send(p, null, { reqId: 'zo-nonstream' });
    ok(calls.length === 2, `上游被调 2 次（${calls.length}）`);
    ok(agg.choices[0].message.content === B_TEXT, '客户端拿到的是 B 的正文');
    ok(agg.choices[0].finish_reason === 'stop', 'finish_reason=stop（A 的 length 被整轮丢弃）');
    ok(agg.usage && agg.usage.total_tokens === 200, 'usage 是 B 那一轮的');
    ok(poolNotes.every((n) => n.kind === 'success'), `池只记成功（${JSON.stringify(poolNotes)}）`);
  }

  // ---------------------------------------------------------------------
  section('3. 流式带门（有工具）：A 空输出 → 换号 B；A 的可见帧零下发');
  {
    const calls = stub({ pickOrder: [ACCOUNT_A, ACCOUNT_B], scriptByAccount: { 9901: ROUND_ZERO, 9902: ROUND_NORMAL } });
    patchCalls.length = 0; poolNotes = []; released.length = 0;
    const chunks = await collectStream(payload({ tools: TOOLS }));
    ok(calls.length === 2, `上游被调 2 次（${calls.length}）`);
    ok(textOf(chunks) === B_TEXT, '正文只来自 B');
    ok(finishCount(chunks) === 1, 'finish_reason 恰好一次（A 的被丢弃）');
    ok(usageCount(chunks) === 1, 'usage 恰好一次');
    ok(chunks[chunks.length - 1] === '[DONE]', '[DONE] 收在最后');
    const usageFrames = chunks.filter((c) => typeof c === 'object' && c.usage);
    ok(usageFrames[0].usage.total_tokens === 200, '留下的是 B 的 usage');
    ok(poolNotes.every((n) => n.kind === 'success'), `池只记成功不记失败（${JSON.stringify(poolNotes)}）`);
    ok(!patchCalls.some((c) => c.id === ACCOUNT_A.id && c.p.lastError), 'A 的 lastError 没被写（feed=none）');
    ok(released.length >= 2, '两个号都正常归还');
  }

  // ---------------------------------------------------------------------
  section('4. 流式无门（纯对话）：A 空输出 → 换号 B；可见帧同样零下发');
  {
    const calls = stub({ pickOrder: [ACCOUNT_A, ACCOUNT_B], scriptByAccount: { 9901: ROUND_ZERO, 9902: ROUND_NORMAL } });
    patchCalls.length = 0; poolNotes = [];
    const chunks = await collectStream(payload({ tools: [] }));
    ok(calls.length === 2, `上游被调 2 次（${calls.length}）`);
    ok(textOf(chunks) === B_TEXT, '正文只来自 B');
    ok(finishCount(chunks) === 1 && usageCount(chunks) === 1, 'finish/usage 恰好各一次');
    ok(chunks[chunks.length - 1] === '[DONE]', '[DONE] 收在最后');
    ok(poolNotes.every((n) => n.kind === 'success'), '无门路径同样不罚账号');
  }

  // ---------------------------------------------------------------------
  section('5. 无门裸关闭（上游没发 [DONE]）的空输出：同样否决');
  {
    const calls = stub({ pickOrder: [ACCOUNT_A, ACCOUNT_B], scriptByAccount: { 9901: [fRole(), fFinish('length'), fUsage(1)], 9902: ROUND_NORMAL } });
    patchCalls.length = 0;
    const chunks = await collectStream(payload({ tools: [] }));
    ok(calls.length === 2, `上游被调 2 次（${calls.length}）`);
    ok(textOf(chunks) === B_TEXT, '正文来自 B');
    ok(finishCount(chunks) === 1, 'finish 恰好一次');
  }

  // ---------------------------------------------------------------------
  section('6. 无门裸关闭但内容正常：不否决，暂扣的 finish/usage 照常补发');
  {
    stub({ pickOrder: [ACCOUNT_A], scriptByAccount: { 9901: [fText('结果在这'), fUsage(80), fFinish('stop')] } });
    patchCalls.length = 0; poolNotes = [];
    const chunks = await collectStream(payload({ tools: [] }));
    ok(textOf(chunks) === '结果在这', '正文下发');
    ok(finishCount(chunks) === 1 && usageCount(chunks) === 1, '裸关闭下 tail 暂扣帧也补发（不凭空消失）');
    ok(chunks[chunks.length - 1] !== '[DONE]', '上游没发 [DONE]，下游也不伪造');
  }

  // ---------------------------------------------------------------------
  section('7. 不否决的形状：stop+空 / length+正文 / length+思考 / length+工具');
  {
    // stop + 空：上游说「说完了」但什么都没说——不是 length 语义，不拦（守卫只认 length）
    stub({ pickOrder: [ACCOUNT_A], scriptByAccount: { 9901: [fFinish('stop'), fUsage(5), null] } });
    const a1 = await wb.send(payload({ stream: false }), null, { reqId: 'zo-stop-empty' });
    ok(a1.choices[0].finish_reason === 'stop' && !a1.choices[0].message.content, 'stop+空 原样交付');

    // length + 正文：真截断（内容已可见），不否决——客户端已收到正文，换号会重复
    stub({ pickOrder: [ACCOUNT_A], scriptByAccount: { 9901: [fText('写到一半被截'), fFinish('length'), fUsage(100), null] } });
    const chunks2 = await collectStream(payload({ tools: [] }));
    ok(textOf(chunks2) === '写到一半被截' && finishCount(chunks2) === 1, 'length+正文 如实交付（断流截断语义）');

    // length + 思考：reasoning 已直发（客户端看见思考），不否决
    stub({ pickOrder: [ACCOUNT_A, ACCOUNT_B], scriptByAccount: { 9901: [fReason('想了但没写'), fFinish('length'), fUsage(60), null], 9902: ROUND_NORMAL } });
    const chunks3 = await collectStream(payload({ tools: TOOLS }));
    ok(chunks3.some((c) => typeof c === 'object' && c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.reasoning_content),
      '思考帧如实下发');

    // length + 只有工具调用：工具帧可见，不否决
    stub({ pickOrder: [ACCOUNT_A], scriptByAccount: { 9901: [fCall('exec_command'), fFinish('length'), fUsage(40), null] } });
    const chunks4 = await collectStream(payload({ tools: TOOLS }));
    ok(chunks4.some((c) => typeof c === 'object' && c.choices && c.choices[0]
      && Array.isArray(c.choices[0].delta && c.choices[0].delta.tool_calls)), '工具调用如实下发');
  }

  // ---------------------------------------------------------------------
  section('8. 全池空输出（单账号）：502 zero_output_length + 可行动 hint');
  {
    authStore.findUsable = () => [ACCOUNT_A];
    stub({ pickOrder: [ACCOUNT_A], scriptByAccount: { 9901: ROUND_ZERO } });
    patchCalls.length = 0; poolNotes = [];
    let caught = null;
    try { await wb.send(payload({ stream: false }), null, { reqId: 'zo-exhausted' }); } catch (e) { caught = e; }
    ok(!!caught, '抛错');
    ok(caught.statusCode === 502, `statusCode=502（${caught.statusCode}）`);
    ok(caught.code === 'zero_output_length', `code=zero_output_length（${caught.code}）`);
    ok(/连续出现 1 次/.test(caught.message) && /换一个模型/.test(caught.message), 'message 带次数与可行动 hint');
    ok(/finish_reason=length/.test(caught.message), 'message 说明死因');
    ok(poolNotes.every((n) => n.kind !== 'error'), '全池空输出也不罚账号');
    authStore.findUsable = () => [ACCOUNT_A, ACCOUNT_B];
  }

  // ---------------------------------------------------------------------
  section('9. 接线自证：判定点/处置分支都真的接在线上（防「模块写好、无调用方」）');
  {
    const fs = require('fs');
    const idx = fs.readFileSync(require.resolve('../src/workbuddy/index.js'), 'utf8');
    ok(/fin0 === 'length' && !hasCalls && !msg\.content && !msg\.reasoning_content/.test(idx),
      '判定点①（非流式聚合）在位');
    ok(/!gate && !sawOut && lastFinish === 'length'/.test(idx), '判定点②（流式无门）在位');
    ok(/g\.finishReason === 'length' && !g\.text && !g\.toolCalls && !g\.reasoningSeen/.test(idx),
      '判定点③（流式带门）在位');
    ok(/if \(e && e\.zeroOutput\) return \{ feed: 'none', action: 'rotate' \}/.test(idx),
      'errorActionOf 的 zeroOutput 分支在位');
    ok(/lastErr && lastErr\.zeroOutput/.test(idx), '耗尽时的 hint 改写接线在位');
    const rep = fs.readFileSync(require.resolve('../src/repair.js'), 'utf8');
    ok(/reasoningSeen/.test(rep) && /finishReason/.test(rep), '缓冲门记账字段在位');
  }

  console.log(`\n===== ${pass} ok, ${fail} FAIL =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
