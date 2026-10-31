// test/verify-qoder-error-surface.js - Qoder 上游失败必须**报错**，不能静默空回答
//
// 2026-10-22 修的两个静默失败形态（都表现为「HTTP 200 + 空回答」，不报错）：
//   1. provider 层失败时上游发的是 `{"code":"provider_error","message":"All backends failed"}`
//      —— 字符串 code、首字母小写，旧判据 /^[A-Z]/ 漏掉它，整帧被当正常数据转发。
//   2. 上游 4xx/5xx 时 body 往往不是 SSE（没有 `data:` 行），流式路径一帧都收不到，
//      旧实现当成功返回。
//
// **桩必须遵守真实 postStream 的契约**：无论有没有数据帧，流尾都会回调
// `[DONE]`。第一版桩漏了它，于是测试通过而线上路径不通过——`[DONE]` 把
// `sent` 置 true，`!sent` 兜底永远走不到。这是本文件最重要的回归点。
//
// 离线：打桩 chat.postStream / auth / session / credits，不需要账号与网络。
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// 池状态必须隔离。本文件会制造 429（→ 账号级软冷却）与 5xx（→ 熔断计数）
// 两个惩罚态：写进真实 data/pool-state.json 会污染正在运行的网关，而且
// 冷却态会在用例之间残留——429 那条把账号冷却 5 分钟后，「正常流」及其
// 之后的用例就选不到账号了（此前一直是红的，只是没人跑）。必须在 require
// 之前设：池单例是模块加载时按这个路径建的。
const TMP_STATE = path.join(os.tmpdir(), `dumate-qoder-error-surface-${process.pid}.json`);
process.env.DUMATE_POOL_STATE = TMP_STATE;

const auth = require('../src/qoder/auth');
const session = require('../src/qoder/session');
const chat = require('../src/qoder/chat');
const credits = require('../src/qoder/credits');
const qoder = require('../src/qoder/index');
const { pool } = require('../src/pool');

const ACCOUNT = {
  id: 9901, uid: 'uid-test', nickname: '测试账号', region: 'cn',
  accessToken: 'at', refreshToken: 'rt',
  machineId: 'mid', machineToken: 'mtok', machineType: '5',
  enabled: true,
};
const ACCOUNT2 = { ...ACCOUNT, id: 9902, uid: 'uid-test-2', nickname: '备用账号' };
const MODELS = [{ key: 'gfmodel', name: 'GLM-5.3-Flash', maxInputTokens: 1000000 }];

// ---- 打桩：只替换边界，签名与 body 构造仍走真实实现 ----
auth.findUsable = () => [ACCOUNT];
auth.preferred = () => ACCOUNT;
auth.patch = () => {};
session.ensureAccount = async () => ACCOUNT;
session.cachedModels = () => MODELS;
session.fetchModels = async () => ({ ok: true, models: MODELS });
credits.capture = () => {};

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`[PASS] ${label}`); }
  catch (e) { failures++; console.log(`[FAIL] ${label} — ${e.message}`); }
}

const PAYLOAD = { model: 'qoder/GLM-5.3-Flash', messages: [{ role: 'user', content: 'hi' }] };

async function collect(fn) {
  const chunks = [];
  let error = null;
  try { await fn((c) => chunks.push(c)); }
  catch (e) { error = e; }
  return { chunks, error };
}

/** 每个用例前清掉上一个用例留下的冷却/熔断——否则用例之间互相污染 */
function resetPool() {
  for (const id of [ACCOUNT.id, ACCOUNT2.id]) {
    try { pool.revive(`qoder:${id}`); } catch (e) { /* 无记录也可是正常 */ }
  }
}

(async () => {
  console.log('== provider_error 帧 ==');
  chat.postStream = async (url, body, headers, onChunk) => {
    onChunk(JSON.stringify({
      code: 'provider_error', message: 'All backends failed',
      request_id: 'x', type: 'provider_error',
    }));
    onChunk('[DONE]');
    return { status: 200, headers: {}, raw: '' };
  };
  let r = await collect((cb) => qoder.send(PAYLOAD, cb, {}));
  check('provider_error 必须 reject', () => assert.ok(r.error, '应抛出错误，实际成功返回'));
  check('错误里带上游原因', () => assert.ok(/provider_error|All backends failed/.test(r.error.message), r.error && r.error.message));
  check('错误帧不转发给客户端', () => assert.strictEqual(r.chunks.length, 0, JSON.stringify(r.chunks)));

  console.log('');
  resetPool();
  console.log('== HTTP 429 + 非 SSE 错误体 ==');
  chat.postStream = async (url, body, headers, onChunk) => {
    // 真实 postStream 即使一帧 data 都没有，流尾也会补 [DONE]
    onChunk('[DONE]');
    return { status: 429, headers: {}, raw: '{"code":429,"message":"Too many requests"}' };
  };
  r = await collect((cb) => qoder.send(PAYLOAD, cb, {}));
  check('HTTP 429 必须 reject', () => assert.ok(r.error, '应抛出错误，实际成功返回'));
  check('状态码透传 429', () => assert.strictEqual(r.error.statusCode, 429, String(r.error && r.error.statusCode)));
  check('message 带上游原文', () => assert.ok(/Too many requests/.test(r.error.message), r.error && r.error.message));

  console.log('');
  resetPool();
  console.log('== 200 + 纯 provider_error 体（没有 data: 行）==');
  chat.postStream = async (url, body, headers, onChunk) => {
    onChunk('[DONE]');
    return {
      status: 200, headers: {},
      raw: '{"code":"provider_error","message":"All backends failed","type":"provider_error"}',
    };
  };
  r = await collect((cb) => qoder.send(PAYLOAD, cb, {}));
  check('200 错误体也要 reject（[DONE] 不算已吐帧）', () => assert.ok(r.error, '应抛出错误，实际成功返回'));
  check('200 错误体：错误原因来自原始 body', () => assert.ok(/All backends failed/.test(r.error.message), r.error && r.error.message));

  console.log('');
  resetPool();
  console.log('== 正常流不受影响 ==');
  chat.postStream = async (url, body, headers, onChunk) => {
    onChunk(JSON.stringify({ choices: [{ delta: { content: '好' } }] }));
    onChunk('[DONE]');
    return { status: 200, headers: {}, raw: '' };
  };
  r = await collect((cb) => qoder.send(PAYLOAD, cb, {}));
  check('正常流 resolve', () => assert.strictEqual(r.error, null, r.error && r.error.message));
  check('正文已转发', () => assert.ok(r.chunks.some((c) => c.includes('"content":"好"')), JSON.stringify(r.chunks)));
  check('[DONE] 在正文之后补发，且只补一次', () => {
    assert.strictEqual(r.chunks[r.chunks.length - 1], '[DONE]');
    assert.strictEqual(r.chunks.filter((x) => x === '[DONE]').length, 1, JSON.stringify(r.chunks));
  });

  console.log('');
  resetPool();
  console.log('== 换号：首个账号 429，第二个成功 ==');
  auth.findUsable = () => [ACCOUNT, ACCOUNT2];
  session.ensureAccount = async (a) => a;
  let calls = 0;
  chat.postStream = async (url, body, headers, onChunk) => {
    calls++;
    if (calls === 1) {
      onChunk('[DONE]');
      return { status: 429, headers: {}, raw: '{"code":429,"message":"Too many requests"}' };
    }
    onChunk(JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }));
    onChunk('[DONE]');
    return { status: 200, headers: {}, raw: '' };
  };
  r = await collect((cb) => qoder.send(PAYLOAD, cb, {}));
  check('429 会换第二个账号', () => assert.strictEqual(calls, 2, 'calls=' + calls));
  check('换号后成功', () => assert.strictEqual(r.error, null, r.error && r.error.message));
  auth.findUsable = () => [ACCOUNT];
  session.ensureAccount = async () => ACCOUNT;

  console.log('');
  resetPool();
  console.log('== 换号：首个账号回 provider_error，第二个成功 ==');
  auth.findUsable = () => [ACCOUNT, ACCOUNT2];
  session.ensureAccount = async (a) => a;
  let calls2 = 0;
  chat.postStream = async (url, body, headers, onChunk) => {
    calls2++;
    if (calls2 === 1) {
      onChunk(JSON.stringify({ code: 'provider_error', message: 'All backends failed', type: 'provider_error' }));
      onChunk('[DONE]');
      return { status: 200, headers: {}, raw: '' };
    }
    onChunk(JSON.stringify({ choices: [{ delta: { content: 'ok2' } }] }));
    onChunk('[DONE]');
    return { status: 200, headers: {}, raw: '' };
  };
  r = await collect((cb) => qoder.send(PAYLOAD, cb, {}));
  check('provider_error 会换第二个账号', () => assert.strictEqual(calls2, 2, 'calls=' + calls2));
  check('换号后成功（provider_error 场景）', () => assert.strictEqual(r.error, null, r.error && r.error.message));
  auth.findUsable = () => [ACCOUNT];
  session.ensureAccount = async () => ACCOUNT;

  console.log('');
  resetPool();
  console.log('== 模型名解析（缓存为空时补拉）==');
  // 缓存为空 + 名字是显示名 → 补拉后解析成内部 key
  let fetched = 0;
  session.cachedModels = () => null;
  session.fetchModels = async () => { fetched++; return { ok: true, models: MODELS }; };
  // postStream 收到的是 cosy.encode 后的 body（不是 JSON），所以从 buildBody
  // 的入参抓模型 key —— 那才是「解析结果」真正生效的地方。
  let seenKey = null;
  const realBuildBody = chat.buildBody;
  chat.buildBody = (key, payload, opts) => { seenKey = key; return realBuildBody(key, payload, opts); };
  chat.postStream = async () => ({ status: 200, headers: {}, raw: '' });
  await collect((cb) => qoder.send(PAYLOAD, cb, {}));
  check('缓存为空时补拉模型表', () => assert.strictEqual(fetched, 1, 'fetched=' + fetched));
  check('显示名解析成内部 key', () => assert.strictEqual(seenKey, 'gfmodel', String(seenKey)));

  // 埋点要能看到「实际发给上游的 key」，否则这类解析失败在日志里不可见
  let gotModel = null;
  await qoder.send(PAYLOAD, () => {}, { onModel: (k) => { gotModel = k; } }).catch(() => {});
  check('onModel 上报实际 key', () => assert.strictEqual(gotModel, 'gfmodel', String(gotModel)));

  console.log('');
  resetPool();
  console.log('== 无语义渲染码与审核拒绝（2026-11-01，对齐 hub 风控 §7.4）==');
  // 115 < 400：payloadError 认不出，旧代码整帧静默转发 → 200 + 空回答
  chat.postStream = async (url, body, headers, onChunk) => {
    onChunk(JSON.stringify({ code: '115', message: 'upstream limit' }));
    onChunk('[DONE]');
    return { status: 200, headers: {}, raw: '' };
  };
  r = await collect((cb) => qoder.send(PAYLOAD, cb, {}));
  check('无语义渲染码 115 必须 reject（不静默转发）', () => assert.ok(r.error, '应抛出错误，实际成功返回'));
  check('115 的 statusCode 压回 400（80411/100401 同理，writeHead 不炸）', () => {
    assert.strictEqual(r.error.statusCode, 400, String(r.error && r.error.statusCode));
    assert.ok(r.error.opaqueCode === '115', String(r.error && r.error.opaqueCode));
  });
  check('115 不换号（官方对渲染码是弹错误不重试）', () => {
    // 单账号场景下看 errors 即可；直接验 retryable 语义
    assert.strictEqual(qoder.retryable(400, r.error.message), false);
  });

  resetPool();
  // 审核拒绝：HTTP 500 包着的 DataInspectionFailed —— 旧代码会 5xx 换号 + 熔断
  chat.postStream = async (url, body, headers, onChunk) => {
    onChunk(JSON.stringify({
      code: 'InternalError.Algo.DataInspectionFailed',
      message: 'Input text data may contain inappropriate content.',
    }));
    onChunk('[DONE]');
    return { status: 200, headers: {}, raw: '' };
  };
  r = await collect((cb) => qoder.send(PAYLOAD, cb, {}));
  check('审核拒绝帧必须 reject 且带人话', () => {
    assert.ok(r.error, '应抛出错误，实际成功返回');
    assert.ok(r.error.policy === true, '应有 policy 标志');
  });
  check('审核拒绝不换号', () => {
    assert.strictEqual(qoder.retryable(500, r.error.message), false);
  });

  console.log('');
  try { pool.close(); } catch (e) { /* 忽略 */ }
  try { fs.unlinkSync(TMP_STATE); } catch (e) { /* 不存在 */ }
  if (failures) { console.log(`${failures} 项失败`); process.exit(1); }
  console.log('全部通过');
  process.exit(0);
})();
