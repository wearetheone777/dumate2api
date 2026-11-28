// 长度截断无缝续写（批次二十三）——闸门单测 + web-pool 接线（https.request
// 劫持剧本，手法同 verify-web-pool-token.js，全离线）。
// 剧本对齐注意：token 缓存按账号 id 记忆，每个接线用例用**独立账号 id**
// 重新种账号表，保证「先取票、后流式」的剧本顺序稳定。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const EventEmitter = require('events');

// env 必须先于 src 模块加载（pool 落盘目录在 require 时固化）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd2a-continue-'));
process.env.DUMATE_ADMIN_DATA = TMP;
process.env.DUMATE_POOL_STATE = path.join(TMP, 'pool-state.json');
delete process.env.DUMATE_PROXY;
delete process.env.DUMATE_CONTINUE_RETRY;
delete process.env.DUMATE_CONTINUE_MAX;

const cont = require('../../src/continue');
const pool = require('../../src/web-pool');

// ---------------- 工具 ----------------

function sse(frames) {
  return frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join('');
}
const delta = (content) => ({ choices: [{ delta: { content } }] });
const finish = (reason, usage) => ({ choices: [{ delta: {}, finish_reason: reason }], ...(usage ? { usage } : {}) });
const usageFrame = (usage) => ({ choices: [], usage });
const contentAll = (text) => [...text.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join('');

// ---------------- Part A：闸门单测 ----------------

test('gate：finish=stop 单段透传——输出逐字节等于输入', () => {
  const out = [];
  const gate = cont.createGate((c) => out.push(c), { body: { messages: [] } });
  const raw = sse([delta('hello'), finish('stop'), usageFrame({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), '[DONE]']);
  gate.onChunk(raw);
  gate.segmentDone();
  const fin = gate.finalize();
  assert.strictEqual(out.join(''), raw, '单段不重写 usage，收尾帧原样放出（顺序与字节）');
  assert.strictEqual(fin.segments, 1);
  assert.deepStrictEqual(fin.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test('gate：finish=length + 纯文本 → 判续写，收尾帧扣住，请求体带 assistant 预填', () => {
  const out = [];
  const body = { model: 'model-text', messages: [{ role: 'user', content: '写个长故事' }], max_tokens: 65536 };
  const gate = cont.createGate((c) => out.push(c), { body });
  gate.onChunk(sse([delta('第一段'), delta('第二段'), finish('length')]));
  const outBeforeFinalize = out.join('');
  assert.ok(!outBeforeFinalize.includes('"finish_reason":"length"'), 'finish 帧已扣住不透传（delta 帧无 finish_reason 字段）');
  assert.ok(outBeforeFinalize.includes('第一段'), '正文帧照常透传（首字延迟不受影响）');
  const seg = gate.segmentDone();
  assert.strictEqual(seg.continue, true);
  assert.strictEqual(seg.body.messages.length, 3);
  assert.strictEqual(seg.body.messages[1].role, 'assistant');
  assert.strictEqual(seg.body.messages[1].content, '第一段第二段');
  assert.strictEqual(seg.body.messages[2].role, 'user');
  assert.ok(/continue/i.test(seg.body.messages[2].content), '续写指令在 user 消息里');
  assert.strictEqual(seg.body.model, 'model-text', '其余请求字段原样保留');
});

test('gate：跨段 usage 合并——prompt 取末段、completion 相加、total 重算，usage 帧按合并值重写', () => {
  const out = [];
  const gate = cont.createGate((c) => out.push(c), { body: { messages: [] } });
  // 段 1：usage 100/50
  gate.onChunk(sse([delta('AB'), finish('length'), usageFrame({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }), '[DONE]']));
  const seg = gate.segmentDone();
  assert.strictEqual(seg.continue, true);
  // 段 2：usage 130/40（prompt 含前文 100 + 30）
  gate.onChunk(sse([delta('CD'), finish('stop'), usageFrame({ prompt_tokens: 130, completion_tokens: 40, total_tokens: 170 }), '[DONE]']));
  const seg2 = gate.segmentDone();
  assert.strictEqual(seg2.continue, false, 'finish=stop 不再续');
  const fin = gate.finalize();
  assert.deepStrictEqual(fin.usage, { prompt_tokens: 130, completion_tokens: 90, total_tokens: 220 });
  const text = out.join('');
  assert.strictEqual((text.match(/\[DONE\]/g) || []).length, 1, '两条流只放出一个 [DONE]');
  assert.strictEqual((text.match(/"finish_reason":"(length|stop)"/g) || []).length, 1, '只放出最后一个 finish 帧');
  // usage 帧被重写为合并值
  const usageLine = text.split('\n').find((l) => l.includes('"usage"'));
  const parsed = JSON.parse(usageLine.replace(/^data:\s*/, ''));
  assert.strictEqual(parsed.usage.completion_tokens, 90, '客户端读到的是合并后的 completion');
  assert.strictEqual(parsed.usage.prompt_tokens, 130);
  assert.strictEqual(contentAll(text), 'ABCD', '续写段 delta 接进同一条流');
});

test('gate：段内出现 tool_calls → 不续写（半截 JSON 不补），帧原样透传', () => {
  const out = [];
  const gate = cont.createGate((c) => out.push(c), { body: { messages: [] } });
  const toolFrame = { choices: [{ delta: { tool_calls: [{ id: 'call_1', function: { name: 'f', arguments: '{"a"' } }] } }] };
  const raw = sse([delta('x'), toolFrame, finish('length'), '[DONE]']);
  gate.onChunk(raw);
  const seg = gate.segmentDone();
  assert.strictEqual(seg.continue, false, '有工具调用的段绝不续');
  const fin = gate.finalize();
  assert.strictEqual(out.join(''), raw, '帧原样放出（含截断的工具参数）');
  assert.strictEqual(fin.segments, 1);
});

test('gate：跨 chunk 的行切分正确解析（不丢帧不重复）', () => {
  const out = [];
  const gate = cont.createGate((c) => out.push(c), { body: { messages: [] } });
  const raw = sse([delta('你好'), finish('length')]);
  const mid = Math.floor(raw.length / 2);
  gate.onChunk(raw.slice(0, mid));
  gate.onChunk(raw.slice(mid));
  assert.strictEqual(gate.segText(), '你好', '跨块 content 不丢');
  const seg = gate.segmentDone();
  assert.strictEqual(seg.continue, true);
  gate.finalize();
  // 续写发生后第一段的 finish 帧按设计被丢弃（流被接续，不是独立结束）——
  // 帧集合 = 原始集合减去那条 length finish
  const lines = (s) => s.split('\n').filter((x) => x.startsWith('data:')).sort();
  const expected = lines(raw).filter((l) => !l.includes('"finish_reason":"length"'));
  assert.deepStrictEqual(lines(out.join('')), expected);
});

test('gate：续写段的 reasoning_content 纯思考帧丢弃、混合帧重建只留正文', () => {
  const out = [];
  const gate = cont.createGate((c) => out.push(c), { body: { messages: [] } });
  gate.onChunk(sse([delta('A'), finish('length')]));
  gate.segmentDone();
  gate.onChunk(sse([
    { choices: [{ delta: { reasoning_content: '内部思考' } }] },          // 纯思考 → 丢弃
    { choices: [{ delta: { reasoning_content: 'x', content: 'B' } }] }, // 混合 → 重建只留 B
    delta('C'),
    finish('stop'),
    '[DONE]',
  ]));
  gate.segmentDone();
  const text = out.join('');
  assert.ok(!text.includes('内部思考'), '续写段思考帧不出现在流里');
  assert.ok(text.includes('"content":"C"'), '后续正文帧原样透传');
  assert.strictEqual(contentAll(text), 'ABC');
});

test('gate：开关与上限——RETRY=0 逐字节透传；MAX=0 不续；达上限放收尾帧', () => {
  process.env.DUMATE_CONTINUE_RETRY = '0';
  try {
    const out1 = [];
    const g1 = cont.createGate((c) => out1.push(c), { body: { messages: [] } });
    const raw = sse([delta('x'), finish('length'), '[DONE]']);
    g1.onChunk(raw);
    assert.strictEqual(out1.join(''), raw, '开关关闭时逐字节透传（连解析都不做）');
    assert.strictEqual(g1.segmentDone().continue, false);
  } finally {
    delete process.env.DUMATE_CONTINUE_RETRY;
  }
  const out2 = [];
  const g2 = cont.createGate((c) => out2.push(c), { body: { messages: [] }, maxSegments: 0 });
  g2.onChunk(sse([delta('x'), finish('length'), '[DONE]']));
  assert.strictEqual(g2.segmentDone().continue, false);
  const out3 = [];
  const g3 = cont.createGate((c) => out3.push(c), { body: { messages: [] }, maxSegments: 2 });
  for (let i = 0; i < 3; i++) {
    g3.onChunk(sse([delta(`s${i}`), finish('length'), '[DONE]']));
    if (i < 2) assert.strictEqual(g3.segmentDone().continue, true, `第 ${i + 1} 段后仍续`);
  }
  assert.strictEqual(g3.segmentDone().continue, false, '第 3 段后达上限不续');
  g3.finalize();
});

test('continuationBody / mergeUsage 纯函数', () => {
  const b = cont.continuationBody({ model: 'm', messages: [{ role: 'user', content: 'u' }] }, '已生成');
  assert.strictEqual(b.messages[0].content, 'u');
  assert.strictEqual(b.messages[1].content, '已生成');
  assert.strictEqual(b.messages.length, 3);
  assert.strictEqual(cont.mergeUsage(null, null), null, '无 usage 不编 0');
  assert.deepStrictEqual(
    cont.mergeUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, { prompt_tokens: 130, completion_tokens: 40, total_tokens: 170 }),
    { prompt_tokens: 130, completion_tokens: 90, total_tokens: 220 },
  );
});

// ---------------- Part B：web-pool 接线（https.request 劫持） ----------------

const script = [];
const reqlog = [];
const reqBodies = [];
const realRequest = https.request;
https.request = function hijack(opts, cb) {
  const entry = script.shift();
  reqlog.push({ hostname: opts.hostname, path: opts.path, auth: (opts.headers && opts.headers.Authorization) || '' });
  const req = new EventEmitter();
  req.write = (d) => { reqBodies.push(String(d)); };
  req.destroy = () => {};
  req.end = () => {
    const spec = entry ? entry() : { status: 599, headers: {}, body: '{"error":"script exhausted"}' };
    const res = new EventEmitter();
    res.statusCode = spec.status;
    res.headers = spec.headers || {};
    res.setEncoding = () => {};
    res.resume = () => {};
    process.nextTick(() => {
      cb(res);
      res.emit('data', spec.body == null ? '{}' : spec.body);
      res.emit('end');
    });
  };
  return req;
};

const FUTURE = () => new Date(Date.now() + 3600e3).toISOString();
const TOKEN_OK = (t) => () => ({ status: 200, headers: {}, body: JSON.stringify({ result: { token: t, expired_at: FUTURE() } }) });
// usage 只放在独立的尾部帧（真实上游 stream_options.include_usage 的形态）
const segStream = (content, reason, usage) => () => ({
  status: 200,
  headers: {},
  body: sse([delta(content), finish(reason), usageFrame(usage), '[DONE]']),
});

function resetScript() {
  script.length = 0;
  reqlog.length = 0;
  reqBodies.length = 0;
}

function seedOne(id, name) {
  fs.writeFileSync(path.join(TMP, 'web-accounts.json'), JSON.stringify({ accounts: [
    { id, name, nickname: name, cookie: 'demo-cookie-' + id, enabled: true },
  ] }));
}

const gwChatCalls = () => reqlog.filter((x) => x.path.includes('/chat/completions')).length;

test('接线：finish=length 自动续写——同账号两段接进同一条流，usage 合并出仓', async () => {
  seedOne(601, '续写号');
  resetScript();
  script.push(
    TOKEN_OK('TK1'),
    segStream('AB', 'length', { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }),
    segStream('CD', 'stop', { prompt_tokens: 130, completion_tokens: 40, total_tokens: 170 }),
  );
  const chunks = [];
  const r = await pool.callStreamWithFailover('/chat/completions', 'POST',
    { model: 'model-text', messages: [{ role: 'user', content: '长文' }], stream: true, stream_options: { include_usage: true } },
    (c) => chunks.push(String(c)), { model: 'model-text' });
  assert.ok(r.ok, '流式调用成功');
  assert.strictEqual(r.continued, true, '响应元数据标记续写发生');
  assert.strictEqual(r.segments, 2);
  const text = chunks.join('');
  assert.strictEqual(contentAll(text), 'ABCD', '续写段帧接进同一条流');
  assert.strictEqual((text.match(/\[DONE\]/g) || []).length, 1);
  // 续写请求体：assistant 预填 AB + 继续指令
  const contBody = JSON.parse(reqBodies[reqBodies.length - 1]);
  assert.strictEqual(contBody.messages[1].content, 'AB');
  assert.ok(/continue/i.test(contBody.messages[2].content));
  assert.strictEqual(contBody.stream_options.include_usage, true, '续写请求同样要 usage 帧');
  // usage 帧合并（重写后的那条）
  const usageLine = text.split('\n').find((l) => l.includes('"usage"'));
  assert.ok(usageLine, '流里有 usage 帧');
  const parsed = JSON.parse(usageLine.replace(/^data:\s*/, ''));
  assert.strictEqual(parsed.usage.completion_tokens, 90);
});

test('接线：tool_calls 段不续写——只有一次网关调用，帧原样透传', async () => {
  seedOne(602, '工具号');
  resetScript();
  script.push(
    TOKEN_OK('TK2'),
    () => ({
      status: 200,
      headers: {},
      body: sse([
        delta('x'),
        { choices: [{ delta: { tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a"' } }] } }] },
        finish('length'),
        '[DONE]',
      ]),
    }),
  );
  const chunks = [];
  const r = await pool.callStreamWithFailover('/chat/completions', 'POST',
    { model: 'model-text', messages: [], stream: true }, (c) => chunks.push(String(c)), { model: 'model-text' });
  assert.ok(r.ok);
  assert.strictEqual(r.continued, undefined, '未续写无标记');
  assert.strictEqual(gwChatCalls(), 1, `只有一次网关调用（实际 ${gwChatCalls()}）`);
  const text = chunks.join('');
  assert.ok(text.includes('tool_calls'), '工具调用帧原样透传');
  assert.strictEqual((text.match(/\[DONE\]/g) || []).length, 1);
});

test('接线：续写请求失败 → 降级放出已扣收尾帧（客户端拿到截断但完整收口）', async () => {
  seedOne(603, '降级号');
  resetScript();
  script.push(
    TOKEN_OK('TK3'),
    segStream('AB', 'length', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
    () => ({ status: 500, headers: {}, body: '{"error":{"message":"upstream boom"}}' }), // 续写段失败
  );
  const chunks = [];
  const r = await pool.callStreamWithFailover('/chat/completions', 'POST',
    { model: 'model-text', messages: [], stream: true }, (c) => chunks.push(String(c)), { model: 'model-text' });
  assert.ok(r.ok, '主段成功即整体成功（降级）');
  const text = chunks.join('');
  assert.ok(text.includes('"AB"'), '第一段正文已透传');
  assert.strictEqual((text.match(/\[DONE\]/g) || []).length, 1, '收尾仍完整');
  assert.ok(text.includes('"finish_reason":"length"'), '扣住的 finish 帧已放出');
  assert.ok(!text.includes('upstream boom'), '续写失败的错误体不进流');
});

test('接线：开关关闭（RETRY=0）→ 单段直通，无续写', async () => {
  seedOne(604, '直通号');
  resetScript();
  process.env.DUMATE_CONTINUE_RETRY = '0';
  try {
    script.push(TOKEN_OK('TK4'), segStream('AB', 'length', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }));
    const chunks = [];
    const r = await pool.callStreamWithFailover('/chat/completions', 'POST',
      { model: 'model-text', messages: [], stream: true }, (c) => chunks.push(String(c)), { model: 'model-text' });
    assert.ok(r.ok);
    assert.strictEqual(r.continued, undefined);
    assert.strictEqual(gwChatCalls(), 1);
    assert.ok(chunks.join('').includes('"finish_reason":"length"'), 'finish 帧未扣（直通）');
  } finally {
    delete process.env.DUMATE_CONTINUE_RETRY;
  }
});
