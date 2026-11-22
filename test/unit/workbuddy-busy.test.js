// test/unit/workbuddy-busy.test.js - 模型繁忙度探针（2026-11-08 融合批）
//
// 出处：GitHub 生态调研。`POST /v2/chat/busy` 是唯一「免费、不扣额度、
// 不动账号状态」的上游接口：一次批量问 ≤50 个模型的繁忙度。
//
// 三条硬事实都要锁（违反任一条都会把探针变成故障源）：
//   1. **国际版 404** —— 必须当成「无繁忙度信息」，不是通道故障
//   2. **≤50 一批** —— 超了上游报错，必须自动分批
//   3. **只提示不拦截（默认）** —— 繁忙度是瞬时估算，硬拦会在上游抖动时
//      把整条通道弄停；要拦必须显式开 DUMATE_WORKBUDDY_BUSY_GUARD=1
//
// 运行：node --test test/unit/workbuddy-busy.test.js
const test = require('node:test');
const assert = require('node:assert');

const busy = require('../../src/workbuddy/busy');

test('chunkIds：≤50 一批、去重、保序', () => {
  const ids = Array.from({ length: 120 }, (_, i) => `m${i}`);
  const chunks = busy.chunkIds(ids);
  assert.deepEqual(chunks.map((c) => c.length), [50, 50, 20], '50 一批，余数单独一批');
  assert.equal(chunks.flat().length, 120);
  assert.deepEqual(chunks.flat(), ids, '保序（上游返回按批对应）');

  assert.deepEqual(busy.chunkIds(['a', 'a', 'b']), [['a', 'b']], '去重');
  assert.deepEqual(busy.chunkIds([]), []);
  assert.deepEqual(busy.chunkIds(null), []);
  assert.deepEqual(busy.chunkIds([null, undefined, '']), [], '空值丢掉');
});

test('normalizeLevel：认识的档位原样，不认识归 normal（不编造紧迫性）', () => {
  for (const lv of busy.LEVELS) {
    assert.equal(busy.normalizeLevel(lv.toUpperCase()), lv);
  }
  for (const junk of ['weird', '', null, undefined, 0, {}]) {
    assert.equal(busy.normalizeLevel(junk), 'normal',
      `不认识的值 ${JSON.stringify(junk)} 应归 normal —— 猜成 busy 会让选号无谓地避开健康模型`);
  }
});

test('isCrowded：只有 congested / unavailable 算明显该避开', () => {
  assert.equal(busy.isCrowded('idle'), false);
  assert.equal(busy.isCrowded('normal'), false);
  assert.equal(busy.isCrowded('busy'), false, 'busy 只是偏忙，不该当拥挤');
  assert.equal(busy.isCrowded('congested'), true);
  assert.equal(busy.isCrowded('unavailable'), true);
  assert.equal(busy.isCrowded('whatever'), false);
});

test('parseBusy：三种可能的响应形状都认', () => {
  // 形状 A：{data:{models:[{id,level}]}}
  assert.deepEqual(
    busy.parseBusy({ data: { models: [{ id: 'glm-5', level: 'busy' }, { model: 'kimi', status: 'IDLE' }] } }),
    { 'glm-5': 'busy', kimi: 'idle' },
  );
  // 形状 B：{data:{ "model": "level" }}
  assert.deepEqual(busy.parseBusy({ data: { 'glm-5': 'congested' } }), { 'glm-5': 'congested' });
  // 形状 C：{data:[{model_id, busy}]}
  assert.deepEqual(busy.parseBusy({ data: [{ model_id: 'x', busy: 'unavailable' }] }), { x: 'unavailable' });
});

test('parseBusy：非繁忙度字段不被误收成模型', () => {
  const out = busy.parseBusy({ data: { total: 3, updated_at: '2026-11-08', 'glm-5': 'idle' } });
  assert.deepEqual(out, { 'glm-5': 'idle' }, '数字/时间串不是 level，不能当模型收进来');
});

test('parseBusy：异常输入返回空对象而不是抛', () => {
  for (const junk of [null, undefined, 'str', 123, [], {}, { data: null }]) {
    assert.doesNotThrow(() => busy.parseBusy(junk));
    const out = busy.parseBusy(junk);
    assert.equal(typeof out, 'object');
  }
});

test('guardEnabled：默认关闭（只提示不拦截）', () => {
  delete process.env.DUMATE_WORKBUDDY_BUSY_GUARD;
  assert.equal(busy.guardEnabled(), false,
    '默认必须是「不拦」——繁忙度是上游瞬时估算，硬拦会在抖动时停掉整条通道');

  process.env.DUMATE_WORKBUDDY_BUSY_GUARD = '1';
  assert.equal(busy.guardEnabled(), true);

  process.env.DUMATE_WORKBUDDY_BUSY_GUARD = '0';
  assert.equal(busy.guardEnabled(), false, '0 也是关');

  process.env.DUMATE_WORKBUDDY_BUSY_GUARD = 'true';
  assert.equal(busy.guardEnabled(), false, '只认字面量 1（避免 "true" 这类模糊值意外开启拦截）');

  delete process.env.DUMATE_WORKBUDDY_BUSY_GUARD;
});

test('fetchBusy：空 id 列表不发请求（返回 ok 空结果）', async () => {
  const r = await busy.fetchBusy('cn', { accessToken: 'x' }, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.levels, {});
  assert.deepEqual(r.crowded, []);
});

test('fetchBusy：出站代理配置非法时如实报错（不静默直连）', async () => {
  const r = await busy.fetchBusy('cn', { accessToken: 'x', proxy: 'not-a-url' }, ['glm-5']);
  assert.equal(r.ok, false);
  assert.match(r.error, /出站代理配置错误/,
    '配了代理就必须走代理，配错了要报错——静默直连会暴露真实出口 IP');
});
