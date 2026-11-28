// test/unit/workbuddy-tool-pairing.test.js - 出站前工具配对修复（P0-3）
//
// 移植 misakano7545/workbuddy2api-panel tool_pairing_test.go 的七组钉桩
// （缺名调用剔除），加上 repack / reorder / merge 的行为组与 buildChatBody 集成。
//
// 要防的线上事故：客户端把 assistant.tool_calls 写进历史却没写回结果（工具执行
// 失败），之后每一条用户消息都被上游 11148 顶死——网关是最后一道防线，出站前
// 把可机械修复的坏历史修掉，宁可丢一轮工具上下文。
//
// 运行：node --test test/unit/workbuddy-tool-pairing.test.js
const test = require('node:test');
const assert = require('node:assert');

const tp = require('../../src/workbuddy/toolpairing');
const chat = require('../../src/workbuddy/chat');

const assistant = (calls, content = '') => ({ role: 'assistant', content, tool_calls: calls });
const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });
const callNoNameKey = (id) => ({ id, type: 'function', function: {} });
const callNoFunc = (id) => ({ id, type: 'function' });
const tool = (id, out) => ({ role: 'tool', tool_call_id: id, content: out });

// ---- cleanupOrphanToolCalls（对齐 Go TestCleanupOrphanToolCallsNamelessCalls）----

test('cleanup：空 name + 配对结果 → 调用与结果成对剔除，assistant 消息保留', () => {
  const r = tp.cleanupOrphanToolCalls([assistant([call('c1', '')]), tool('c1', 'ok')]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.messages, [{ role: 'assistant', content: '' }]);
  assert.equal('tool_calls' in r.messages[0], false, '过滤后为空删键');
});

test('cleanup：纯空白 name / 无 name 键 / 无 function 键 同样判脏', () => {
  for (const bad of [call('c1', '  '), callNoNameKey('c1'), callNoFunc('c1')]) {
    const r = tp.cleanupOrphanToolCalls([assistant([bad]), tool('c1', 'ok')]);
    assert.equal(r.changed, true);
    assert.deepEqual(r.messages, [{ role: 'assistant', content: '' }]);
  }
});

test('cleanup：空 name 且无结果 → 仍走孤儿路径（不早退漏出站）', () => {
  const r = tp.cleanupOrphanToolCalls([assistant([call('c1', '')])]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.messages, [{ role: 'assistant', content: '' }]);
});

test('cleanup：批内混合只剔脏项，干净调用与其结果原样保留', () => {
  const r = tp.cleanupOrphanToolCalls([
    assistant([call('c1', ''), call('c2', 'Bash')]),
    tool('c1', 'ok1'), tool('c2', 'ok2'),
  ]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.messages, [assistant([call('c2', 'Bash')]), tool('c2', 'ok2')]);
});

test('cleanup：健康流量零改动；两侧对称裁剪不留无主结果', () => {
  const healthy = [assistant([call('c1', 'Bash')]), tool('c1', 'ok')];
  const r1 = tp.cleanupOrphanToolCalls(healthy);
  assert.equal(r1.changed, false);
  assert.equal(r1.messages, healthy, '原 slice 原样返回');
  // 批 [c1,c2] 只回了 c1：调用侧只留 c1，结果 c1 保留（旧整批丢弃会留无主 c1）
  const r2 = tp.cleanupOrphanToolCalls([
    assistant([call('c1', 'A'), call('c2', 'B')]), tool('c1', 'ok1'),
  ]);
  assert.deepEqual(r2.messages, [assistant([call('c1', 'A')]), tool('c1', 'ok1')]);
});

test('cleanup：同一 call_id 的重复结果只留第一条', () => {
  const r = tp.cleanupOrphanToolCalls([
    assistant([call('c1', 'A')]), tool('c1', 'first'), tool('c1', 'second'),
  ]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.messages, [assistant([call('c1', 'A')]), tool('c1', 'first')]);
});

test('cleanup：无任何工具流量零改动', () => {
  const msgs = [
    { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
  ];
  const r = tp.cleanupOrphanToolCalls(msgs);
  assert.equal(r.changed, false);
  assert.equal(r.messages, msgs);
});

// ---- repackToolResultBlocks ----

test('repack：插在两份结果中间的 developer 消息后移到整组之后', () => {
  const notice = { role: 'developer', content: '<image_resize_notice>' };
  const r = tp.repackToolResultBlocks([
    assistant([call('c0', 'A'), call('c1', 'B')]),
    tool('c0', 'out0'), notice, tool('c1', 'out1'),
    { role: 'user', content: 'next' },
  ]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.messages, [
    assistant([call('c0', 'A'), call('c1', 'B')]),
    tool('c0', 'out0'), tool('c1', 'out1'), notice,
    { role: 'user', content: 'next' },
  ]);
});

test('repack：中间的孤儿结果不遮挡后续合法结果（不能 break）', () => {
  const r = tp.repackToolResultBlocks([
    assistant([call('c0', 'A'), call('c1', 'B')]),
    tool('orphan', 'x'), tool('c0', 'out0'), tool('c1', 'out1'),
  ]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.messages, [
    assistant([call('c0', 'A'), call('c1', 'B')]),
    tool('c0', 'out0'), tool('c1', 'out1'), tool('orphan', 'x'),
  ]);
});

test('repack：下一组 assistant 组头不当插入物吞掉（真实会话 msg[181] 漏修形态）', () => {
  // 组 1 的插入物在 c0/c1 两条结果**中间**（触发重排 + changed）；扫到组 2 的
  // 组头必须 break 交还外层——若被当插入物吞进 between，组 2 的结果永远
  // 得不到重排（Go 注释里 msg[181] 就是这么漏的）。
  const r = tp.repackToolResultBlocks([
    assistant([call('c0', 'A'), call('c1', 'B')]),
    tool('c0', 'o0'),
    { role: 'developer', content: 'n1' },
    tool('c1', 'o1'),
    assistant([call('d0', 'D')]),
    tool('d0', 'o2'),
  ]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.messages, [
    assistant([call('c0', 'A'), call('c1', 'B')]),
    tool('c0', 'o0'), tool('c1', 'o1'), { role: 'developer', content: 'n1' },
    assistant([call('d0', 'D')]), tool('d0', 'o2'),
  ]);
});

test('repack：移植底本的边界——插入物在首个结果之前时不重排（misakano 生产行为）', () => {
  const msgs = [
    assistant([call('c0', 'A')]),
    { role: 'developer', content: 'n1' }, tool('c0', 'o0'),
  ];
  const r = tp.repackToolResultBlocks(msgs);
  assert.equal(r.changed, false, '首个结果前的插入物不修（宁漏修不改形状）');
});

test('repack：assistant 后没有结果 → 原样（交由 cleanup 处理）', () => {
  const msgs = [assistant([call('c0', 'A')]), { role: 'user', content: 'x' }];
  const r = tp.repackToolResultBlocks(msgs);
  assert.equal(r.changed, false);
});

// ---- reorderEarlyToolResults ----

test('reorder：早于其调用的结果移到对应 assistant 之后（结果区末尾落地）', () => {
  const r = tp.reorderEarlyToolResults([
    tool('c0', 'early'),
    assistant([call('c0', 'A')]),
    { role: 'user', content: 'next' },
  ]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.messages, [
    assistant([call('c0', 'A')]), tool('c0', 'early'),
    { role: 'user', content: 'next' },
  ]);
});

test('reorder：id 跨轮复用——顺序本来对的第一轮结果不被搬走（hub PR#3 同口径）', () => {
  // 两轮各有 call_0：第一轮结果顺序正确，只有第二轮的结果早到
  const msgs = [
    assistant([call('call_0', 'A1')]), tool('call_0', 'ok1'),
    tool('call_0', 'early2'),
    assistant([call('call_0', 'A2')]),
    { role: 'user', content: 'next' },
  ];
  const r = tp.reorderEarlyToolResults(msgs);
  assert.equal(r.changed, true);
  assert.deepEqual(r.messages, [
    assistant([call('call_0', 'A1')]), tool('call_0', 'ok1'),
    assistant([call('call_0', 'A2')]), tool('call_0', 'early2'),
    { role: 'user', content: 'next' },
  ]);
});

test('reorder：本来顺序就对的请求零改动', () => {
  const msgs = [assistant([call('c0', 'A')]), tool('c0', 'ok')];
  const r = tp.reorderEarlyToolResults(msgs);
  assert.equal(r.changed, false);
  assert.equal(r.messages, msgs);
});

// ---- mergeAdjacentToolCalls ----

test('merge：前带 tool_calls 的 assistant 与紧随其后的 assistant 并批', () => {
  const r = tp.mergeAdjacentToolCalls([
    assistant([call('c0', 'A')], '前半'),
    { role: 'assistant', content: '后半', tool_calls: [call('c1', 'B')] },
  ]);
  assert.equal(r.changed, true);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].content, '前半后半');
  assert.deepEqual(r.messages[0].tool_calls.map((x) => x.id), ['c0', 'c1']);
});

test('merge：纯文本相邻回复不动（那是两轮真实对话）', () => {
  const msgs = [
    { role: 'assistant', content: '一' },
    { role: 'assistant', content: '二' },
  ];
  const r = tp.mergeAdjacentToolCalls(msgs);
  assert.equal(r.changed, false);
  assert.equal(r.messages, msgs);
});

test('merge：content 是结构化 parts 时不动（形状未知，宁可漏修）', () => {
  const msgs = [
    assistant([call('c0', 'A')]),
    { role: 'assistant', content: [{ type: 'text', text: 'x' }], tool_calls: [call('c1', 'B')] },
  ];
  const r = tp.mergeAdjacentToolCalls(msgs);
  assert.equal(r.changed, false);
});

// ---- 管线与 buildChatBody 集成 ----

test('repairToolPairing 管线：四步顺序生效，健康历史零改动', () => {
  const healthy = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'q' },
    assistant([call('c1', 'Bash')]),
    tool('c1', 'ok'),
    { role: 'user', content: 'again' },
  ];
  const r = tp.repairToolPairing(healthy);
  assert.equal(r.changed, false);
  assert.deepEqual(r.steps, []);

  const broken = [
    { role: 'user', content: 'q' },
    assistant([call('c1', 'Bash'), call('ghost', 'G')]), // ghost 无结果 → cleanup
    tool('c1', 'ok'),
  ];
  const r2 = tp.repairToolPairing(broken);
  assert.equal(r2.changed, true);
  assert.deepEqual(r2.steps, ['cleanup']);
  assert.deepEqual(r2.messages[1].tool_calls.map((x) => x.id), ['c1']);
});

test('buildChatBody 集成：坏历史出站前被修好（客户端无感自愈）', () => {
  const payload = {
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'user', content: '跑一下 ls' },
      assistant([{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{}' } },
        callNoFunc('c2')], ''),
      tool('c1', 'total 0'), tool('c2', 'err'),
      { role: 'user', content: '再来一次' },
    ],
  };
  const out = JSON.parse(chat.buildChatBody(payload, 'cn', { id: 1, uid: 'u1', accessToken: 't' }).body);
  const asst = out.messages.find((m) => m.role === 'assistant');
  assert.deepEqual(asst.tool_calls.map((x) => x.id), ['c1'], '缺名调用被剔（上游 11133 判据）');
  const tools = out.messages.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 1, '孤儿结果成对剔除');
  // 修复不改 user 内容 → 会话 id 稳定
  const convBefore = chat.stableConversationId([{ role: 'user', content: '跑一下 ls' }]);
  assert.equal(out.conversation_id, convBefore);
});
