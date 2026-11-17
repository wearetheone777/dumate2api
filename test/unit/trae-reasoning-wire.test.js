// test/unit/trae-reasoning-wire.test.js - 默认思考档的**接线**验证（node:test）
//
// 纯函数在 reasoning-default.test.js 里锁；这里锁「它真的进了发往上游的 body」。
// 打桩方式与 test/verify-traework-repair.js 一致：替换 chat.postStream /
// chat.readStream 与 auth/credits 的模块属性（index.js 通过模块对象调用，
// 补丁生效），不需要真账号、不需要网络。
//
// 三条断言对应三条纪律：
//   ① 客户端没给 → body 里出现网关的默认档；
//   ② 客户端给了 → 原样保留（网关不覆盖调用方意图）；
//   ③ descriptor 没声明支持档位 → body 里**没有** reasoning_effort（不猜能力）。
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-rsn-'));
process.env.DUMATE_POOL_STATE = path.join(TMP, 'pool.json');
process.env.DUMATE_ADMIN_DATA = TMP;

const { test, before, after } = require('node:test');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const chat = require(path.join(ROOT, 'src/traework/chat.js'));
const authStore = require(path.join(ROOT, 'src/traework/auth.js'));
const credits = require(path.join(ROOT, 'src/traework/credits.js'));
const models = require(path.join(ROOT, 'src/traework/models.js'));
const traework = require(path.join(ROOT, 'src/traework/index.js'));
const rt = require(path.join(ROOT, 'src/trae-runtime.js'));

const real = {
  postStream: chat.postStream,
  readStream: chat.readStream,
  findUsable: authStore.findUsable,
  get: authStore.get,
  needsRefresh: authStore.needsRefresh,
  patch: authStore.patch,
  capture: credits.capture,
  cachedMetaById: models.cachedMetaById,
};

let bodies = [];
let lastReasoning = null;

before(() => {
  authStore.findUsable = () => [{ id: 7, uid: 'u7', accessToken: 't', nickname: '假号', region: 'cn' }];
  authStore.get = (id) => (Number(id) === 7 ? { id: 7, uid: 'u7', accessToken: 't', nickname: '假号', region: 'cn' } : null);
  authStore.needsRefresh = () => false;
  authStore.patch = () => true;
  credits.capture = () => Promise.resolve();
  // postStream 收到的是**序列化后的字符串**（chat.buildBody 的产物），
  // 与 verify-traework-repair.js 一致；这里解析后再存，断言直接读字段。
  chat.postStream = async (body) => {
    bodies.push(typeof body === 'string' ? JSON.parse(body) : JSON.parse(JSON.stringify(body)));
    return { stream: {}, status: 200 };
  };
  chat.readStream = async (stream, onEvent) => {
    onEvent({ event: 'output', data: { response: '好' } });
    onEvent({ event: 'done', data: { finish_reason: 'stop' } });
  };
  rt.Store({ defaultReasoning: { 'glm-5.2': 'high' } });
});

after(() => {
  chat.postStream = real.postStream;
  chat.readStream = real.readStream;
  authStore.findUsable = real.findUsable;
  authStore.get = real.get;
  authStore.needsRefresh = real.needsRefresh;
  authStore.patch = real.patch;
  credits.capture = real.capture;
  models.cachedMetaById = real.cachedMetaById;
  try { rt.Store({ defaultReasoning: {} }); } catch (e) { /* 清配置失败不影响断言 */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function run(payload, supported) {
  bodies = [];
  lastReasoning = null;
  models.cachedMetaById = () => (supported ? { reasoningEfforts: supported } : null);
  await traework.send(
    { model: 'traework/glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: true, ...payload },
    () => {},
    { onReasoning: (r) => { lastReasoning = r; } },
  );
  assert.strictEqual(bodies.length, 1, '应当只打一次上游');
  return bodies[0];
}

test('客户端没给档位 + descriptor 声明支持 → body 带网关默认档 high', async () => {
  const body = await run({}, ['light', 'high', 'extra_high']);
  assert.strictEqual(body.reasoning_effort, 'high');
  assert.strictEqual(lastReasoning.source, 'default');
  assert.strictEqual(lastReasoning.effective, 'high');
});

test('客户端明确给了 light → 原样保留（默认档不覆盖调用方意图）', async () => {
  const body = await run({ reasoning_effort: 'light' }, ['light', 'high', 'extra_high']);
  assert.strictEqual(body.reasoning_effort, 'light');
  assert.strictEqual(lastReasoning.source, 'client');
});

test('descriptor 没声明支持档位 → body 里没有 reasoning_effort（不猜能力）', async () => {
  const body = await run({}, null);
  assert.strictEqual(body.reasoning_effort, undefined);
  assert.strictEqual(lastReasoning.source, 'none');
  assert.match(lastReasoning.note, /未声明/);
});

test('默认档超出该模型支持范围 → 向下钳（extra_high 配置 / 只支持 light）', async () => {
  rt.Store({ defaultReasoning: { 'glm-5.2': 'extra_high' } });
  try {
    const body = await run({}, ['light']);
    assert.strictEqual(body.reasoning_effort, 'light');
    assert.match(lastReasoning.note, /钳到 light/);
  } finally {
    rt.Store({ defaultReasoning: { 'glm-5.2': 'high' } });
  }
});
