// test/unit/trae-models-scope.test.js - 模型表缓存「作用域 + 单飞」纯逻辑（node:test）
//
// 依据：docs/GITHUB-TRAE-RESEARCH-2026-11-16.md 的 P0-1。
// 旧实现 `caches: Map<region, {at,data}>` 让同区第二个账号看到第一个账号的能力表
// （倍率/档位/max_mode/multimodal 都是账号相关字段），响应 200 但能力判断错。
//
// 这个文件锁两件事：
//   1. src/traework/models-cache.js 的策略（TTL / LRU / 单飞 / region 兼容视图）
//   2. src/traework/models.js 的对外口径（账号级隔离、聚合方向、失败不覆盖）
// 全程打桩：不打上游、不读真实账号。
const { test, beforeEach } = require('node:test');
const assert = require('assert');

const { createModelsCache, scopeKey, parseScope, scopeId } = require('../../src/traework/models-cache');

// ---------------------------------------------------------------------------
// 一、纯缓存策略
// ---------------------------------------------------------------------------

test('scopeKey: 四维拼键，脏字符不会拼出同一个键', () => {
  assert.strictEqual(
    scopeKey({ region: 'cn', accountId: 'acc1', fn: 'solo_work_lite', version: '0.1.43' }),
    'cn|acc1|solo_work_lite|0.1.43',
  );
  // '|' 与换行会被替换，否则 acc|a 与 acc 两条能撞成一个键
  assert.strictEqual(scopeKey({ region: 'cn', accountId: 'acc|a' }), 'cn|acc_a|-|-');
  assert.strictEqual(scopeKey({ region: 'cn', accountId: 'acc\na' }), 'cn|acc_a|-|-');
  // 缺省也要稳定：region 必有，其余退化成 '-'
  assert.strictEqual(scopeKey({}), 'cn|-|-|-');
  assert.strictEqual(scopeKey(), 'cn|-|-|-');
  // 解析回去
  assert.deepStrictEqual(parseScope('intl|acc2|f|1.0'), { region: 'intl', accountId: 'acc2', fn: 'f', version: '1.0' });
  assert.strictEqual(scopeId('cn|a|-|-').length, 8);
});

test('cache: TTL 过期后 get 返回 null，stale 仍能区分「过期」与「从没有」', () => {
  let t = 1000;
  const c = createModelsCache({ ttlMs: 100, now: () => t });
  c.set('k', { models: [1] }, { region: 'cn' });
  assert.deepStrictEqual(c.get('k'), { models: [1] });
  t += 99;
  assert.ok(c.get('k'), '差 1ms 到期仍算新鲜');
  t += 2;
  assert.strictEqual(c.get('k'), null);
  assert.strictEqual(c.stale('k'), true, '过期 ≠ 没有：失败回落时要靠它判断要不要复用');
  assert.strictEqual(c.stale('nope'), false);
});

test('cache: 超过 cap 淘汰最久未用的，命中会续期（LRU 不是 FIFO）', () => {
  let t = 0;
  const c = createModelsCache({ ttlMs: 10000, cap: 2, now: () => t });
  c.set('a', { v: 'a' }, { region: 'cn' });
  t = 1; c.set('b', { v: 'b' }, { region: 'cn' });
  t = 2; c.get('a');            // a 续期，变成「最近用过的」
  t = 3; c.set('c', { v: 'c' }, { region: 'cn' });  // 超 cap → 该淘汰 b
  assert.ok(c.get('a'), '刚命中过的 a 不该被淘汰');
  assert.strictEqual(c.get('b'), null, '最久未用的 b 该被淘汰');
  assert.ok(c.get('c'));
  assert.strictEqual(c.stats().evict, 1);
});

test('cache: 正在单飞的键不淘汰（否则两个读者会打两次上游）', () => {
  let t = 0;
  const c = createModelsCache({ ttlMs: 10000, cap: 2, now: () => t });
  c.set('a', { v: 'a' }, { region: 'cn' });   // usedAt 0（最旧）
  t = 1; c.set('b', { v: 'b' }, { region: 'cn' });
  const p = c.single('a', () => new Promise((r) => setTimeout(() => r('x'), 5)));
  t = 2; c.set('c', { v: 'c' }, { region: 'cn' });
  assert.ok(c.get('a'), '在飞的 a 要活到 producer 结束');
  assert.strictEqual(c.get('b'), null);
  return p.then(() => { c.clear(); });
});

test('cache: 单飞——同键并发只跑一次 producer，其余拿同一个 Promise', async () => {
  const c = createModelsCache();
  let calls = 0;
  const producer = () => new Promise((resolve) => setTimeout(() => { calls += 1; resolve({ ok: true }); }, 10));
  const [r1, r2, r3] = await Promise.all([c.single('k', producer), c.single('k', producer), c.single('k', producer)]);
  assert.strictEqual(calls, 1, '三个并发只打一次上游');
  assert.deepStrictEqual(r1, { ok: true });
  assert.strictEqual(r1, r2);
  assert.strictEqual(r2, r3);
  assert.strictEqual(c.stats().join, 2, '另两个记为 join');
  assert.strictEqual(c.hasInflight('k'), false, '结束后要清掉 inflight');
});

test('cache: producer 失败原样抛给每个调用方，且不留缓存', async () => {
  const c = createModelsCache();
  const boom = () => Promise.reject(new Error('HTTP 500'));
  const results = await Promise.allSettled([c.single('k', boom), c.single('k', boom)]);
  assert.strictEqual(results.length, 2);
  for (const r of results) {
    assert.strictEqual(r.status, 'rejected');
    assert.match(r.reason.message, /HTTP 500/);
  }
  assert.strictEqual(c.get('k'), null, '失败不该写进缓存');
  assert.strictEqual(c.hasInflight('k'), false);
});

test('cache: region 视图只认同区最近一次成功的那份（老读法兼容）', () => {
  const c = createModelsCache();
  c.set('cn|a|-|-', { models: [{ id: 'x' }], tag: 'a' }, { region: 'cn', accountId: 'a' });
  c.set('cn|b|-|-', { models: [{ id: 'x' }], tag: 'b' }, { region: 'cn', accountId: 'b' });
  assert.strictEqual(c.latest('cn').data.tag, 'b');
  assert.strictEqual(c.keysOf('cn').length, 2);
  assert.strictEqual(c.datasOf('cn').length, 2);
  assert.strictEqual(c.scopes('cn').length, 2);
  assert.strictEqual(c.scopes('intl').length, 0);
  // 清一个区不影响另一个区
  c.set('intl|a|-|-', { models: [] }, { region: 'intl', accountId: 'a' });
  c.clear('cn');
  assert.strictEqual(c.latest('cn'), null);
  assert.ok(c.latest('intl'));
});

// ---------------------------------------------------------------------------
// 二、models.js 对外口径（打桩上游）
// ---------------------------------------------------------------------------

const constants = require('../../src/traework/constants');
const authStore = require('../../src/traework/auth');
const tnc = require('../../src/traework/tnc');
const headersMod = require('../../src/traework/headers');
const origRequest = constants.request;
const origHosts = tnc.agentHosts;
const origSoloHeaders = headersMod.soloHeaders;
// **必须在 require models 之前**替换：models.js 是 `const { soloHeaders } = require(...)`
// 解构持有引用，事后改 exports 不生效（第一版踩过）。这里把账号写进请求头，
// 让 constants.request 的替身能按每次调用精确归属——预热是并发的，
// 用「最后一次 agentHosts 的账号」这种共享 mutable 会把两个请求记到同一个号上。
headersMod.soloHeaders = (auth) => ({ 'X-Stub-Account': String((auth && auth.id) || '') });
const models = require('../../src/traework/models');

/** 造一条上游模型（形状照实测：display_contact_config 是 JSON 字符串） */
function upstreamRow(over) {
  const o = over || {};
  return {
    config_name: o.name || 'glm-5.2',
    display_config: { display_name: o.display || 'GLM 5.2', multimodal: o.multimodal === true },
    display_contact_config: JSON.stringify({
      consumption_rate: { enable: true, data: { rate: o.rate == null ? 0.78 : o.rate } },
    }),
    model_detail_list: [{ max_tokens: o.maxTokens == null ? 64000 : o.maxTokens, prompt_max_tokens: o.promptMax == null ? 200000 : o.promptMax }],
    context_window_tokens: { dev: o.context == null ? 200000 : o.context },
    usage: 'chat_completion',
    max_mode: o.maxMode === true,
  };
}

/**
 * 打桩：每个账号回一份不同的表，记录调用次数。
 *
 * **不能靠改 headers 区分账号**：models.js 在加载时 `const { soloHeaders } = require('./headers')`
 * 已经解构持有函数引用，事后替换 exports 不生效（第一版就是这么写错的）。
 * 正确切面是 `tnc.agentHosts(auth)`——它每次调用都拿到本次账号，正好当钩子；
 * 而 `constants.request` 是对象属性，可以安全替换。
 */
function stubUpstream(byAccount) {
  const calls = [];
  tnc.agentHosts = async () => ['https://stub.invalid'];
  constants.request = async (host, path, opts) => {
    const acc = String(((opts && opts.headers) || {})['X-Stub-Account'] || '');
    const fn = (opts && opts.body && opts.body.function) || '';
    calls.push({ host, path, body: opts && opts.body, acc, fn });
    const hit = byAccount[acc] != null ? byAccount[acc] : byAccount[`${acc}|${fn}`];
    if (hit === 'ERROR') return { status: 500, data: null, raw: 'boom' };
    const rows = typeof hit === 'function' ? hit() : hit;
    return { status: 200, data: { config_info_list: rows || [] }, raw: '' };
  };
  return { calls, restore: () => { constants.request = origRequest; tnc.agentHosts = origHosts; } };
}

const ACC_A = { id: 'accA', region: 'cn', nickname: 'A' };
const ACC_B = { id: 'accB', region: 'cn', nickname: 'B' };

beforeEach(() => {
  models.clearModelCache('');
  authStore.findUsable = () => [ACC_A, ACC_B];
  authStore.get = (id) => [ACC_A, ACC_B].find((a) => a.id === id) || null;
});

test('fetchModels: 两个账号各拿各的能力表（不再互相覆盖）', async () => {
  const s = stubUpstream({
    accA: [upstreamRow({ multimodal: true, maxMode: true, context: 200000, rate: 0.78 })],
    accB: [upstreamRow({ multimodal: false, maxMode: false, context: 100000, rate: 0.39 })],
  });
  try {
    const a = await models.fetchModels({ region: 'cn', accountId: 'accA' });
    const b = await models.fetchModels({ region: 'cn', accountId: 'accB' });
    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(a.models[0].multimodal, true);
    assert.strictEqual(b.models[0].multimodal, false, 'B 的不能是 A 的表');
    assert.strictEqual(b.models[0].rate, 0.39);
    // 作用域摘要要能被管理端看见
    assert.strictEqual(a.scope.accountId, 'accA');
    assert.strictEqual(a.scope.fn, constants.FUNCTION);
    assert.notStrictEqual(a.cacheScope, b.cacheScope);
    assert.strictEqual(s.calls.length, 2, '两个账号各打一次上游');
  } finally { s.restore(); }
});

test('fetchModels: 同账号并发只打一次上游；force 也参与单飞', async () => {
  let n = 0;
  const s = stubUpstream({
    accA: () => { n += 1; return [upstreamRow({})]; },
  });
  try {
    await Promise.all([
      models.fetchModels({ region: 'cn', accountId: 'accA' }),
      models.fetchModels({ region: 'cn', accountId: 'accA' }),
      models.fetchModels({ region: 'cn', accountId: 'accA' }),
    ]);
    assert.strictEqual(n, 1, '并发冷读共享一次上游请求');
    // 缓存命中：再来一次不再打上游
    await models.fetchModels({ region: 'cn', accountId: 'accA' });
    assert.strictEqual(n, 1);
    // force 绕缓存，但仍与在飞的合并
    await Promise.all([
      models.fetchModels({ region: 'cn', accountId: 'accA', force: true }),
      models.fetchModels({ region: 'cn', accountId: 'accA', force: true }),
    ]);
    assert.strictEqual(n, 2, '两次 force 并发也只打一次');
  } finally { s.restore(); }
});

test('cachedMetaById: 跨账号聚合方向 —— 能力取宽、上限取窄、倍率不一致要标出来', async () => {
  const s = stubUpstream({
    accA: [upstreamRow({ multimodal: true, maxMode: true, context: 200000, maxTokens: 64000, rate: 0.78 })],
    accB: [upstreamRow({ multimodal: false, maxMode: false, context: 100000, maxTokens: 32000, rate: 0.39 })],
  });
  try {
    await models.fetchModels({ region: 'cn', accountId: 'accA' });
    await models.fetchModels({ region: 'cn', accountId: 'accB' });
    const meta = models.cachedMetaById('glm-5.2', 'cn');
    assert.strictEqual(meta.multimodal, true, 'multimodal 取 OR：任一账号支持就算能用（只挡确知不支持）');
    assert.strictEqual(meta.maxMode, false, 'maxMode 取 AND：虚报 1M 会直接吃上游 400');
    assert.strictEqual(meta.contextWindow, 100000, '上下文取最小值');
    assert.strictEqual(meta.maxTokens, 32000);
    assert.strictEqual(meta.mergedScopes, 2);
    assert.strictEqual(meta.rateScopeAmbiguous, true, '两号倍率不同要标出来，不能假装一个数');

    // 指定账号时就是那一份，不合并
    const onlyB = models.cachedMetaById('glm-5.2', 'cn', { accountId: 'accB' });
    assert.strictEqual(onlyB.multimodal, false);
    assert.strictEqual(onlyB.contextWindow, 100000);
    assert.strictEqual(onlyB.mergedScopes, undefined, '单作用域不标 mergedScopes');
  } finally { s.restore(); }
});

test('cachedModelIds / cachedModelEntries: 跨作用域取并集，上下文取最小', async () => {
  const s = stubUpstream({
    accA: [upstreamRow({ name: 'glm-5.2', context: 200000 }), upstreamRow({ name: 'only-a', context: 50000 })],
    accB: [upstreamRow({ name: 'glm-5.2', context: 100000 }), upstreamRow({ name: 'only-b', context: 80000 })],
  });
  try {
    await models.fetchModels({ region: 'cn', accountId: 'accA' });
    await models.fetchModels({ region: 'cn', accountId: 'accB' });
    const ids = models.cachedModelIds('cn');
    assert.deepStrictEqual(ids.sort(), ['glm-5.2', 'only-a', 'only-b'], '只报一份会把能用的模型藏起来');
    const entries = models.cachedModelEntries('cn');
    const glm = entries.find((e) => e.id === 'glm-5.2');
    assert.strictEqual(glm.contextWindow, 100000, 'cc-switch 的压缩阈值取最小，写大了必 400');
    assert.strictEqual(models.isKnownModel('only-b', 'cn'), true);
    assert.strictEqual(models.hasCache('cn'), true);
  } finally { s.restore(); }
});

test('fetchModels: 拉失败不覆盖旧缓存（能力校验不能从「已知」退化成「未知」）', async () => {
  const s = stubUpstream({ accA: [upstreamRow({ multimodal: false })] });
  try {
    await models.fetchModels({ region: 'cn', accountId: 'accA' });
    assert.strictEqual(models.cachedMetaById('glm-5.2', 'cn').multimodal, false);
    s.restore();
    const s2 = stubUpstream({ accA: 'ERROR' });
    try {
      const bad = await models.fetchModels({ region: 'cn', accountId: 'accA', force: true });
      assert.strictEqual(bad.ok, false);
      assert.match(bad.error, /HTTP 500/);
      assert.strictEqual(models.cachedMetaById('glm-5.2', 'cn').multimodal, false, '旧快照仍在');
    } finally { s2.restore(); }
  } finally { s.restore(); }
});

test('fetchModels: 没有该区账号时如实报错，不静默借别的区的号', async () => {
  authStore.findUsable = () => [ACC_A];
  const s = stubUpstream({ accA: [upstreamRow({})] });
  try {
    const r = await models.fetchModels({ region: 'intl' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /国际账号/);
    assert.strictEqual(s.calls.length, 0, '没有账号就不该打上游');
  } finally { s.restore(); }
});

test('fetchModels: 指定不存在的 accountId 也是如实报错（不拿别人的表顶）', async () => {
  const s = stubUpstream({ accA: [upstreamRow({})] });
  try {
    const r = await models.fetchModels({ region: 'cn', accountId: 'ghost' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(s.calls.length, 0);
  } finally { s.restore(); }
});

test('clearModelCache: 清完之后下次必打上游', async () => {
  let n = 0;
  const s = stubUpstream({ accA: () => { n += 1; return [upstreamRow({})]; } });
  try {
    await models.fetchModels({ region: 'cn', accountId: 'accA' });
    await models.fetchModels({ region: 'cn', accountId: 'accA' });
    assert.strictEqual(n, 1);
    const cleared = models.clearModelCache('');
    assert.strictEqual(cleared.ok, true);
    await models.fetchModels({ region: 'cn', accountId: 'accA' });
    assert.strictEqual(n, 2, '清缓存后必须重新取');
  } finally { s.restore(); }
});

test('warmupModels: 按账号各预热一份，返回值仍是「单个结果」形状（启动日志依赖它）', async () => {
  // 这条是回归守卫：warmupModels 改成 Promise.all 之后，若直接返回数组，
  // server.js 的启动日志会读 m.ok / m.models.length 全部 undefined，
  // 表现为「模型表拉取失败（unknown）」——一句假失败，而且没人会去查。
  const s = stubUpstream({
    accA: [upstreamRow({ name: 'glm-5.2' })],
    accB: [upstreamRow({ name: 'glm-5.2' }), upstreamRow({ name: 'only-b' })],
  });
  try {
    const tw = require('../../src/traework/index');
    const r = await tw.warmupModels();
    assert.strictEqual(r.ok, true, '有任一账号取到表就算 ok');
    assert.strictEqual(r.models.length, 2, 'models 取最全的那一份（供日志报数）');
    assert.strictEqual(r.scopes.length, 2, 'scopes 只列预热成功的作用域（intl 无账号不算）');
    assert.strictEqual(r.failed, 1, 'intl 无账号那一次如实计为失败');
    assert.strictEqual(r.warmed, 2);
    assert.strictEqual(s.calls.length, 2, '每账号一次（intl 无账号不打上游）');
  } finally { s.restore(); }
});

test('warmupModels: 全部失败时 ok=false 且 error 是真实原因（不吞成 unknown）', async () => {
  const s = stubUpstream({ accA: 'ERROR', accB: 'ERROR' });
  try {
    const tw = require('../../src/traework/index');
    const r = await tw.warmupModels();
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /HTTP 500/);
    assert.strictEqual(r.warmed, 0);
  } finally { s.restore(); }
});
