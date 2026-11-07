// test/unit/trae-fusion-gateway.test.js - 网关侧融合项：Key 通配 / 账号两态 / Max 运行态
//
// 离线：账号与运行态配置都指向临时目录；send 降级编排用注入的假 sendOnce
// 无法直接改造模块，改为锁住「默认关闭时 send 原样透传」与纯判据。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-trae-gateway-'));
process.env.DUMATE_ADMIN_DATA = tmp;

const keys = require('../../src/keys');
const authStore = require('../../src/traework/auth');
const remote = require('../../src/traework/remote');
const runtime = require('../../src/trae-runtime');
const tw = require('../../src/traework');

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结果 */ }
});

test('Key 模型白名单：fnmatch 通配、大小写不敏感、无通配符仍是精确匹配', () => {
  assert.strictEqual(keys.modelMatches(['Gemini-*'], 'gemini-2.5-pro'), true);
  assert.strictEqual(keys.modelMatches(['glm-?.2'], 'glm-5.2'), true);
  assert.strictEqual(keys.modelMatches(['glm-?.2'], 'glm-55.2'), false);
  assert.strictEqual(keys.modelMatches(['glm-5.2'], 'GLM-5.2'), true);
  assert.strictEqual(keys.modelMatches(['glm-5.2'], 'glm-5.2-pro'), false, '未配通配符不模糊匹配');
  assert.strictEqual(keys.modelMatches(['gpt-4o+'], 'gpt-4o+'), true, '正则符号按字面量转义');
  assert.strictEqual(keys.modelMatches([], 'anything'), false);
  const k = { model_allowlist: ['traework/GLM-*'], enabled: true, expires_at: null };
  const verdict = keys.validate(k, '127.0.0.1', 'traework/glm-5.2', 'traework');
  assert.strictEqual(verdict.ok, true);
  assert.strictEqual(keys.validate(k, '127.0.0.1', 'qoder/gfmodel', 'qoder').reason, 'model_not_allowed');
});

test('账号两态：modelEnabled 只拦对话，findUsable 保留签到/保活', () => {
  const file = authStore.filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    accounts: [
      { id: 1, enabled: true, modelEnabled: false, accessToken: 'a', refreshToken: 'r', credits: 10 },
      { id: 2, enabled: true, accessToken: 'a', refreshToken: 'r', credits: 20 },
      { id: 3, enabled: false, accessToken: 'a', refreshToken: 'r', credits: 30 },
    ],
  }), 'utf8');
  assert.deepStrictEqual(authStore.findUsable().map((a) => a.id), [1, 2]);
  assert.deepStrictEqual(authStore.findModelUsable().map((a) => a.id), [2]);
  const list = authStore.list();
  assert.strictEqual(list[0].modelEnabled, false);
  assert.strictEqual(list[1].modelEnabled, true, '存量缺省按 true，行为不变');
  assert.strictEqual(list[2].enabled, false);
  const st = tw.status();
  assert.strictEqual(st.ready, true);
  assert.strictEqual(st.accounts, 1);
  assert.strictEqual(st.pausedModelAccounts, 1);
});

test('全部账号关闭模型请求：status 明确报出且仍是已登录，不伪装成无账号', () => {
  const file = authStore.filePath();
  fs.writeFileSync(file, JSON.stringify({
    accounts: [{ id: 1, enabled: true, modelEnabled: false, accessToken: 'a', refreshToken: 'r' }],
  }), 'utf8');
  const st = tw.status();
  assert.strictEqual(st.ready, false);
  assert.strictEqual(st.loggedIn, true);
  assert.match(st.error, /关闭了「接模型请求」/);
  assert.strictEqual(st.pausedModelAccounts, 1);
});

test('Max 运行态：env 与运行期开关并联，白名单优先于 env', () => {
  const envKey = 'DUMATE_TRAEWORK_REMOTE_MAX_MODELS';
  const old = process.env[envKey];
  try {
    process.env[envKey] = 'glm-5.2';
    assert.strictEqual(remote.maxModeRequested('glm-5.2', {}, { enabled: true, models: [] }), true);
    assert.strictEqual(remote.maxModeRequested('other', {}, { enabled: true, models: [] }), false);
    assert.strictEqual(remote.maxModeRequested('other', {}, { enabled: true, models: ['other'] }), true,
      '运行期白名单优先，不被旧 env 名单挡住');
    assert.strictEqual(remote.maxModeRequested('other', {}, { enabled: false, models: ['other'] }), false);
    assert.strictEqual(remote.maxModeRequested('glm-5.2', { trae_max_mode: true }, { enabled: false, models: [] }), true,
      '单请求显式开关优先级最高');
  } finally {
    if (old === undefined) delete process.env[envKey]; else process.env[envKey] = old;
  }
});

test('全站暂停：默认关，Store 后跨进程热读可见', () => {
  runtime._resetForTest();
  assert.strictEqual(runtime.Load().gatewayPaused, false);
  runtime.Store({ gatewayPaused: true });
  runtime._resetForTest();
  assert.strictEqual(runtime.Load().gatewayPaused, true);
  runtime.Store({ gatewayPaused: false });
  runtime._resetForTest();
  assert.strictEqual(runtime.Load().gatewayPaused, false);
});
