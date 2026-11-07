// test/unit/dumate-points.test.js - dumate-points 伪模型（2026-11-07 融合项 P0-1）
//
// 钉住四条纪律：零上游消耗（不打对话请求）、不编数（失败行不进合计、全部
// 失败没有合计）、只读网页池（文本明说桌面链路不在列）、协议形状正确
// （OpenAI / Anthropic 各有流式与非流式两套）。
const { test } = require('node:test');
const assert = require('node:assert');
const dp = require('../../src/dumate-points');

// 测试注入：两启用（一好一坏）+ 一停用
const load = () => [
  { id: 1, name: '账号 1', nickname: '张三', enabled: true, cookie: 'c1' },
  { id: 2, name: '账号 2', enabled: true, cookie: 'c2' },
  { id: 3, name: 'B', enabled: false, cookie: 'c3' },
];
const quota = async (a) => {
  if (a.id === 1) return { id: 1, name: '张三', ok: true, left: 1234.56, total: 2000, used: 765.44 };
  if (a.id === 2) return { id: 2, name: '账号 2', ok: false, error: '登录态过期' };
  return { id: a.id, name: a.name, ok: false, error: '不该被查到' };
};

test('summary：只查启用账号；合计只累成功行；停用计数单列', async () => {
  const s = await dp.summary({ load, quota });
  assert.equal(s.rows.length, 2, '停用账号不查');
  assert.equal(s.okCount, 1);
  assert.equal(s.failCount, 1);
  assert.equal(s.disabledCount, 1);
  assert.equal(s.totalLeft, 1234.56, '合计只累成功行');
});

test('summary：全部失败时 totalLeft 是 null 不是 0（0 会被读成「没额度」）', async () => {
  const s = await dp.summary({
    load: () => [{ id: 1, enabled: true, cookie: 'c' }],
    quota: async () => ({ id: 1, ok: false, error: '网络错误' }),
  });
  assert.equal(s.totalLeft, null);
  assert.equal(s.okCount, 0);
});

test('renderText：好行带数字、坏行带原因、合计带成败计数', async () => {
  const s = await dp.summary({ load, quota });
  const t = dp.renderText(s);
  assert.ok(/剩余 1234\.56 \/ 总 2000（已用 765\.44）/.test(t), t);
  assert.ok(/查询失败（登录态过期/.test(t), t);
  assert.ok(/合计剩余：1234\.56（成功 1 \/ 失败 1）/.test(t), t);
  assert.ok(/另有 1 个停用账号未计入/.test(t), t);
  assert.ok(/桌面链路（8980）登录态的余额不在此列/.test(t), '只读网页池的边界要写明');
});

test('renderText：全部失败不编合计；空池给指引', async () => {
  const allFail = dp.renderText(await dp.summary({
    load: () => [{ id: 1, enabled: true, cookie: 'c' }],
    quota: async () => ({ id: 1, ok: false, error: '超时' }),
  }));
  assert.ok(/不编数/.test(allFail), allFail);
  assert.ok(!/合计剩余：0/.test(allFail), '不能出现「合计 0」——那是「没额度」的假读数');
  const empty = dp.renderText({ rows: [], okCount: 0, failCount: 0, disabledCount: 2, totalLeft: null });
  assert.ok(/没有启用账号/.test(empty), empty);
  assert.ok(/另有 2 个停用账号/.test(empty), empty);
});

test('OpenAI 形状：非流式体与流式 chunk 序列', () => {
  const body = dp.openAIBody('余额文本');
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.model, dp.NAME);
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(body.choices[0].message.content, '余额文本');
  assert.deepEqual(body.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

  const chunks = dp.openAIChunks('余额文本');
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks[1].choices[0].delta.content, '余额文本');
  assert.equal(chunks[2].choices[0].finish_reason, 'stop');
  assert.deepEqual(chunks[2].usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  for (const c of chunks) assert.equal(c.object, 'chat.completion.chunk');
});

test('Anthropic 形状：非流式体与 SSE 事件序列', () => {
  const body = dp.anthropicBody('余额文本');
  assert.equal(body.type, 'message');
  assert.equal(body.stop_reason, 'end_turn');
  assert.equal(body.content[0].text, '余额文本');
  assert.deepEqual(body.usage, { input_tokens: 0, output_tokens: 0 });

  const evs = dp.anthropicEvents('余额文本');
  assert.deepEqual(evs.map((e) => e.event),
    ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  const delta = evs.find((e) => e.event === 'content_block_delta');
  assert.equal(delta.data.delta.type, 'text_delta');
  assert.equal(delta.data.delta.text, '余额文本');
  assert.equal(evs.find((e) => e.event === 'message_delta').data.delta.stop_reason, 'end_turn');
});

test('summaryCached：TTL 内不重查；TTL=0 每次现查', async () => {
  dp.resetCacheForTest();
  let fetches = 0;
  const countingQuota = async (a) => { fetches += 1; return { id: a.id, ok: true, left: 1, total: 1, used: 0 }; };
  const load2 = () => [{ id: 1, enabled: true, cookie: 'c' }];
  process.env.DUMATE_POINTS_TTL_MS = '60000';
  try {
    await dp.summaryCached({ load: load2, quota: countingQuota });
    await dp.summaryCached({ load: load2, quota: countingQuota });
    assert.equal(fetches, 1, 'TTL 内第二次命中缓存');
    dp.resetCacheForTest();
    process.env.DUMATE_POINTS_TTL_MS = '0';
    await dp.summaryCached({ load: load2, quota: countingQuota });
    assert.equal(fetches, 2, 'TTL=0 关闭缓存');
  } finally {
    delete process.env.DUMATE_POINTS_TTL_MS;
    dp.resetCacheForTest();
  }
});
