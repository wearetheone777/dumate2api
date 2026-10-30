// test/unit/qwen-billing-probe.test.js - 千问计费自检探针的路由编排（离线）
//
// 打桩三处外部依赖（authStore.findUsable / credits.fetchWallets / qwenwork.send），
// 验证 handler 的完整编排：前后快照 → 发请求 → 归属差值 → 组装响应。
// 真机验证受额度限制（402 硬冷却到 0 点），所以编排逻辑必须离线锁住。
const { test } = require('node:test');
const assert = require('assert');

const qw = require('../../src/qwenwork');
const credits = require('../../src/qwenwork/credits');
const authStore = require('../../src/qwenwork/auth');
const { routes } = require('../../src/admin/routes/qwenwork');

const route = routes.find((r) => r.path === '/billing-check' && r.method === 'GET');

/** 用 res 桩跑一次 handler，返回解析后的响应体 */
async function call(url) {
  const req = { url };
  let out = '';
  const res = { writeHead() {}, setHeader() {}, end(s) { out += (s || ''); }, writableEnded: false };
  await route.handler({ req, res, body: null, params: [] });
  return JSON.parse(out);
}

/** 打桩：装回原函数。测试之间互不影响 */
function patch(obj, key, fn) {
  const old = obj[key];
  obj[key] = fn;
  return () => { obj[key] = old; };
}

const ACCOUNTS = [
  { id: 2, nickname: 'qianwencodework', enabled: true, accessToken: 't2', refreshToken: 'r2' },
  { id: 3, nickname: 'qianwenWork', enabled: true, accessToken: 't3', refreshToken: 'r3' },
];

test('探针编排：服务账号的 daily 差值被归属，cost/billed 正确', async () => {
  const restoreA = patch(authStore, 'findUsable', () => ACCOUNTS);
  // 每个账号两次快照：前 / 后。只有 argv 的服务账号 3 减少 0.003
  const seq = {
    2: [{ daily: 4.3, monthly: 0, longterm: -4.3 }, { daily: 4.3, monthly: 0, longterm: -4.3 }],
    3: [{ daily: 4.8, monthly: 0, longterm: 0 }, { daily: 4.797, monthly: 0, longterm: 0 }],
  };
  const restoreW = patch(credits, 'fetchWallets', async ({ account }) => {
    const q = seq[account.id];
    const w = q.length > 1 ? q.shift() : q[0];
    return { ok: true, ...w };
  });
  const restoreS = patch(qw, 'send', async (payload, onChunk, opts) => {
    assert.strictEqual(payload.model, 'qwen/flash');
    opts.onAccount('qwenwenWork', 3);
    return { usage: { prompt_tokens: 30, completion_tokens: 900, total_tokens: 930 } };
  });
  try {
    const r = await call('/billing-check?model=flash');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.model, 'flash');
    assert.strictEqual(r.account, 'qwenwenWork');
    assert.strictEqual(r.cost, 0.003);
    assert.strictEqual(r.pools.daily, 0.003);
    assert.strictEqual(r.billed, 0.0032);
    assert.strictEqual(r.ratio, null);
    assert.strictEqual(r.expected, null);
    assert.strictEqual(r.singleAccount, true);
  } finally {
    restoreA(); restoreW(); restoreS();
  }
});

test('探针编排：请求失败如实返回 ok:false（不伪造测量值）', async () => {
  const restoreA = patch(authStore, 'findUsable', () => ACCOUNTS);
  const restoreW = patch(credits, 'fetchWallets', async ({ account }) => ({
    ok: true, ...(account.id === 2
      ? { daily: 4.3, monthly: 0, longterm: -4.3 }
      : { daily: 4.8, monthly: 0, longterm: 0 }),
  }));
  const restoreS = patch(qw, 'send', async () => { throw new Error('upstream 402'); });
  try {
    const r = await call('/billing-check?model=flash');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /402/);
    assert.strictEqual(r.cost, undefined);
  } finally {
    restoreA(); restoreW(); restoreS();
  }
});

test('探针编排：请求成功但余额没动 → cost null + warning（不编成 0）', async () => {
  const restoreA = patch(authStore, 'findUsable', () => ACCOUNTS);
  const restoreW = patch(credits, 'fetchWallets', async ({ account }) => ({
    ok: true, ...(account.id === 2
      ? { daily: 4.3, monthly: 0, longterm: -4.3 }
      : { daily: 4.8, monthly: 0, longterm: 0 }),
  }));
  const restoreS = patch(qw, 'send', async (payload, onChunk, opts) => {
    opts.onAccount('qianwenWork', 3);
    return { usage: { prompt_tokens: 30, completion_tokens: 900, total_tokens: 930 } };
  });
  try {
    const r = await call('/billing-check?model=flash');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.cost, null);
    assert.strictEqual(r.billed, null);
    assert.match(r.warning, /未观测到/);
  } finally {
    restoreA(); restoreW(); restoreS();
  }
});
