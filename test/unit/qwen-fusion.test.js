// test/unit/qwen-fusion.test.js - 千问融合批次 2026-11-06（node:test）
//
// 来源：GitHub 检索 Buddy2api v2.2.17 / tang-bugu/dsh-connect-qwenwork 后的
// 融合清单。本文件覆盖四件改动的离线断言：
//   1. buildBody 的 is_vl 白名单补 qwen3.8-max-preview（cosy-sign/chat）
//   2. 签名头补全：x-request-id / cosy-machinetype / x-internal-model-key
//   3. exchange 失败文案分层 + 官方登录态收编兜底（auth.js）
//   4. ACP 建会话响应的 extra_data.mode 解析（acp.js）
const { test } = require('node:test');
const assert = require('assert');

const chat = require('../../src/qwenwork/chat');
const cosySign = require('../../src/qwenwork/cosy-sign');
const auth = require('../../src/qwenwork/auth');
const acp = require('../../src/qwenwork/acp');

// ---- 1. is_vl 白名单 ----

test('buildBody: is_vl 覆盖 pro / flash / qwen3.8-max-preview', () => {
  for (const key of ['pro', 'flash', 'qwen3.8-max-preview']) {
    const body = JSON.parse(chat.buildBody(key, { messages: [{ role: 'user', content: 'hi' }] }));
    assert.strictEqual(body.model_config.is_vl, true, `${key} 应为 is_vl=true`);
    assert.strictEqual(body.chat_context.extra.modelConfig.key, key);
  }
});

// ---- 2. 签名头补全 ----

test('prepareInfer: 补发 x-request-id / cosy-machinetype / cosy-machineos / traceparent / x-internal-model-key', () => {
  const { headers } = cosySign.prepareInfer({
    uid: 'u1', token: 't1', bodyJson: '{}', modelKey: 'pro', machineId: 'm1',
  });
  assert.strictEqual(headers['cosy-machinetype'], '5');
  assert.strictEqual(headers['cosy-machineos'], 'x86_64_win32');
  assert.ok(/^[0-9a-f-]{36}$/.test(headers['x-request-id']), 'x-request-id 应是 UUID');
  assert.strictEqual(headers['x-internal-model-key'], 'pro');
  assert.strictEqual(headers['x-model-key'], 'pro');
  // W3C traceparent：00-<32hex>-<16hex>-01
  assert.ok(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(headers.traceparent),
    `traceparent 形状: ${headers.traceparent}`);
});

test('prepareInfer: x-request-id 每次请求都是新的（请求级标识）', () => {
  const a = cosySign.prepareInfer({ uid: 'u', token: 't', bodyJson: '{}', modelKey: 'pro', machineId: 'm' });
  const b = cosySign.prepareInfer({ uid: 'u', token: 't', bodyJson: '{}', modelKey: 'pro', machineId: 'm' });
  assert.notStrictEqual(a.headers['x-request-id'], b.headers['x-request-id']);
});

// ---- 3. exchange 兜底 ----

const FUTURE_EXP = Date.now() + 3600 * 1000; // access 还有一个小时

function failingOnce(status, errorCode) {
  return async () => ({
    ok: false, error: `换票失败（${errorCode || `HTTP ${status}`}）`,
    expired: true, status, errorCode: errorCode || '',
  });
}

test('exchange: refresh 失效但 access 仍在有效期时，错误文案带「仍可用到」', async () => {
  const r = await auth.exchange(
    { refreshToken: 'old', expiresAt: FUTURE_EXP },
    { deps: { exchangeOnce: failingOnce(401, 'INVALID_REFRESH_TOKEN') } },
  );
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('仍可用到'), `文案应有剩余时间: ${r.error}`);
  assert.ok(r.error.includes('网关请求暂不受影响'));
});

test('exchange: 401 且官方 refreshToken 已轮换 → 收编成功并写回官方文件', async () => {
  let calls = 0;
  const writes = [];
  const r = await auth.exchange(
    { id: 1, refreshToken: 'old-rt', expiresAt: FUTURE_EXP },
    {
      deps: {
        exchangeOnce: async (a) => {
          calls++;
          if (calls === 1) return failingOnce(401)(a);
          assert.strictEqual(a.refreshToken, 'official-new-rt', '第二次刷新应使用官方 refreshToken');
          return { ok: true, patch: { accessToken: 'new-at', refreshToken: 'rotated-rt', expiresAt: Date.now() + 60000 } };
        },
        credentials: {
          decryptAuth: () => ({ token: 'official-at', refreshToken: 'official-new-rt', user: { id: 'u1' } }),
          encryptAuth: (doc) => writes.push(doc),
        },
      },
    },
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.patch.adoptedFrom, 'official-desktop');
  assert.strictEqual(r.patch.accessToken, 'new-at');
  assert.strictEqual(writes.length, 1, '收编后应写回官方 auth-v2.dat');
  assert.strictEqual(writes[0].refreshToken, 'rotated-rt', '写回的是轮换后的新 refreshToken');
  assert.strictEqual(writes[0].user.id, 'u1', '官方文件的其它字段保留');
});

test('exchange: 官方 refreshToken 与存档相同（没重新登录）→ 不收编', async () => {
  let refreshCalls = 0;
  const r = await auth.exchange(
    { refreshToken: 'same-rt', expiresAt: FUTURE_EXP },
    {
      deps: {
        exchangeOnce: async () => { refreshCalls++; return failingOnce(401)(); },
        credentials: {
          decryptAuth: () => ({ token: 'at', refreshToken: 'same-rt' }),
          encryptAuth: () => { throw new Error('不应写回'); },
        },
      },
    },
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(refreshCalls, 1, '只刷一次，不收编');
  assert.strictEqual(r.patch, undefined);
});

test('exchange: uid 双侧都有且不一致 → 不收编（官方登录的是另一个账号）', async () => {
  let refreshCalls = 0;
  const r = await auth.exchange(
    { id: 1, uid: 'me', refreshToken: 'old-rt', expiresAt: FUTURE_EXP },
    {
      deps: {
        exchangeOnce: async () => { refreshCalls++; return failingOnce(401)(); },
        credentials: {
          decryptAuth: () => ({ token: 'at', refreshToken: 'other-rt', user: { id: 'someone-else' } }),
          encryptAuth: () => { throw new Error('不应写回'); },
        },
      },
    },
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(refreshCalls, 1);
});

test('exchange: 非 401/403 的失败（网络/5xx）不触发收编', async () => {
  let refreshCalls = 0;
  const r = await auth.exchange(
    { refreshToken: 'old-rt', expiresAt: FUTURE_EXP },
    {
      deps: {
        exchangeOnce: async () => { refreshCalls++; return failingOnce(0)(); },
        credentials: {
          decryptAuth: () => { throw new Error('不应读取官方文件'); },
          encryptAuth: () => { throw new Error('不应写回'); },
        },
      },
    },
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(refreshCalls, 1);
});

test('exchange: 成功路径不做任何兜底', async () => {
  const r = await auth.exchange(
    { refreshToken: 'rt', expiresAt: FUTURE_EXP },
    {
      deps: {
        exchangeOnce: async () => ({ ok: true, patch: { accessToken: 'at', refreshToken: 'rt2' } }),
        credentials: {
          decryptAuth: () => { throw new Error('不应读取官方文件'); },
          encryptAuth: () => { throw new Error('不应写回'); },
        },
      },
    },
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.patch.adoptedFrom, undefined);
});

// ---- 4. ACP extra_data.mode ----

test('sessionModeOf: 顶层与 data 包裹两种形状都认', () => {
  assert.strictEqual(acp.sessionModeOf({ extra_data: { mode: 'flash' } }), 'flash');
  assert.strictEqual(acp.sessionModeOf({ data: { extra_data: { mode: 'pro' } } }), 'pro');
  assert.strictEqual(acp.sessionModeOf({ id: 's1' }), '');
  assert.strictEqual(acp.sessionModeOf(null), '');
});
