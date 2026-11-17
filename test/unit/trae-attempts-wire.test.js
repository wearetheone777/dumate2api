// test/unit/trae-attempts-wire.test.js - 尝试链真的进了 TRAE 的发送路径（node:test）
//
// 2026-11-16 调研 P1-5。纯逻辑在 attempts.test.js；这里验证**接线**：
// picked → ok / error 有没有按真实路径写进 opts.attempts，以及池子空时那条 skip。
// 打桩方式与 trae-reasoning-wire.test.js 一致（替换 chat.postStream 等模块属性），
// 不需要真账号、不需要网络。
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-att-'));
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
const attempts = require(path.join(ROOT, 'src/attempts.js'));
const rt = require(path.join(ROOT, 'src/trae-runtime.js'));
const { pool } = require(path.join(ROOT, 'src/pool.js'));
const channelPool = require(path.join(ROOT, 'src/channel-pool.js'));

const ACC = { id: 21, uid: 'u21', accessToken: 't', nickname: '假号21', region: 'cn' };
const real = {};

before(() => {
  real.postStream = chat.postStream;
  real.readStream = chat.readStream;
  real.findUsable = authStore.findUsable;
  real.get = authStore.get;
  real.needsRefresh = authStore.needsRefresh;
  real.patch = authStore.patch;
  real.capture = credits.capture;
  real.cachedMeta = models.cachedMetaById;
  authStore.get = (id) => (Number(id) === ACC.id ? ACC : null);
  authStore.needsRefresh = () => false;
  authStore.patch = () => true;
  credits.capture = () => Promise.resolve();
  models.cachedMetaById = () => null;
  try { rt.Store({ defaultReasoning: {} }); } catch (e) { /* 配置不可写也不影响本测 */ }
  pool.revive(channelPool.uidOf('traework', ACC.id));
});

after(() => {
  chat.postStream = real.postStream;
  chat.readStream = real.readStream;
  authStore.findUsable = real.findUsable;
  authStore.get = real.get;
  authStore.needsRefresh = real.needsRefresh;
  authStore.patch = real.patch;
  credits.capture = real.capture;
  models.cachedMetaById = real.cachedMeta;
  pool.revive(channelPool.uidOf('traework', ACC.id));
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** 跑一次 send，返回尝试链 + 抛出的错误（若有） */
async function run({ fail = false } = {}) {
  authStore.findUsable = () => [ACC];
  pool.revive(channelPool.uidOf('traework', ACC.id));
  chat.postStream = async () => {
    if (fail) {
      const e = new Error('upstream 500 boom');
      e.statusCode = 500;
      throw e;
    }
    return { stream: {}, status: 200 };
  };
  chat.readStream = async (s, onEvent) => {
    onEvent({ event: 'output', data: { response: '好' } });
    onEvent({ event: 'done', data: { finish_reason: 'stop' } });
  };
  const log = attempts.create({ limit: 8 });
  let error = null;
  try {
    await traework.send(
      { model: 'traework/glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: true },
      () => {},
      { attempts: log, startedAt: Date.now() },
    );
  } catch (e) { error = e; }
  return { chain: log.list(), error, json: log.json() };
}

test('成功：链是 picked → ok，且都带账号与原因', async () => {
  const { chain, error } = await run({});
  assert.strictEqual(error, null);
  assert.deepStrictEqual(chain.map((x) => x.outcome), ['picked', 'ok']);
  assert.strictEqual(chain[0].accountId, ACC.id);
  // 这里只断言**选号策略**：链路归属（utils_chat/remote/solo）由 onLink 单独上报，
  // picked 条目刻意不引用 remoteOpts（它在后面的 try 块里才声明——第一次实现
  // 因此抛 ReferenceError 被外层 catch 吞掉，picked 静默丢失）。
  assert.match(chain[0].reason, /^strategy=(round-robin|credits-desc)$/, '选号策略要写进判据');
  assert.strictEqual(typeof chain[1].ms, 'number', '成功条目带耗时');
});

test('上游 500：链是 picked → error，reason 带分类（breaker）', async () => {
  const { chain, error } = await run({ fail: true });
  assert.ok(error, '应当抛出');
  assert.deepStrictEqual(chain.map((x) => x.outcome), ['picked', 'error']);
  assert.match(chain[1].reason, /^breaker:500$/);
});

test('池子空：链里有一条 skip，原因是可读的中文/错误串（不是空白）', async () => {
  authStore.findUsable = () => [];
  const log = attempts.create({ limit: 8 });
  let error = null;
  try {
    await traework.send(
      { model: 'traework/glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: true },
      () => {},
      { attempts: log, startedAt: Date.now() },
    );
  } catch (e) { error = e; }
  assert.ok(error);
  const chain = log.list();
  assert.strictEqual(chain.length, 1);
  assert.strictEqual(chain[0].outcome, 'skip');
  assert.match(chain[0].reason, /no_usable_account/);
});

test('不传 attempts 也不炸（老调用方零改动）', async () => {
  authStore.findUsable = () => [ACC];
  pool.revive(channelPool.uidOf('traework', ACC.id));
  chat.postStream = async () => ({ stream: {}, status: 200 });
  chat.readStream = async (s, onEvent) => { onEvent({ event: 'done', data: { finish_reason: 'stop' } }); };
  const out = await traework.send(
    { model: 'traework/glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: true },
    () => {},
    {},
  );
  assert.ok(out, '没有 attempts 时照常返回结果');
});
