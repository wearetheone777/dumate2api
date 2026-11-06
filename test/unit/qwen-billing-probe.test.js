// test/unit/qwen-billing-probe.test.js - 千问计费自检探针的路由编排（离线）
//
// 打桩三处外部依赖（authStore.findUsable / credits.fetchWallets / qwenwork.send），
// 验证 handler 的完整编排：前后快照 → 发请求 → 归属差值 → 组装响应。
// 真机验证受额度限制（402 硬冷却到 0 点），所以编排逻辑必须离线锁住。
const { test } = require('node:test');
const assert = require('assert');

const qw = require('../../src/qwenwork');
const acp = require('../../src/qwenwork/acp');
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

// ACP 分支（2026-11-05）：chat 桥对账号 3 收紧模型权限（403）时 ACP 仍可用，
// 探针必须能走这条活路。ACP 帧不带计量 → tokens 全 0、billed null，cost 仍出。
test('探针编排：qwen-acp 前缀走 acp.send，billed 恒 null，cost 照出', async () => {
  const restoreA = patch(authStore, 'findUsable', () => ACCOUNTS);
  const seq = [
    { daily: 0, monthly: 15.2162, longterm: 0 },
    { daily: 0, monthly: 15.0243, longterm: 0 },
  ];
  const restoreW = patch(credits, 'fetchWallets', async ({ account }) => {
    // 服务账号 3：前 / 后两次快照；账号 2 恒定值（也会被读，但它不服务）
    if (account.id === 2) return { ok: true, daily: 0, monthly: 0, longterm: 0 };
    const w = seq.length > 1 ? seq.shift() : seq[0];
    return { ok: true, ...w };
  });
  let acpCalls = 0;
  let qwCalls = 0;
  const restoreQ = patch(qw, 'send', async () => { qwCalls += 1; return { usage: {} }; });
  const restoreS = patch(acp, 'send', async (payload, onChunk, opts) => {
    acpCalls += 1;
    assert.strictEqual(payload.model, 'qwen-acp/auto');
    // onChunk 不传 = 非流式聚合（聚合出口才有 usage:{}）；传了函数会走流式
    // 分支返回 {streamed:true}，探针拿不到 usage——这是 2026-11-05 真机踩过的形状。
    assert.strictEqual(onChunk, undefined);
    opts.onAccount('qianwenWork', 3);
    // 桩贴 acp.js 481-496 的真实聚合形状（不要发明新形状）
    return {
      id: 'qacp-x', object: 'chat.completion', model: 'qwen-acp/auto',
      choices: [{ index: 0, message: { role: 'assistant', content: '1 2 3 ...' }, finish_reason: 'stop' }],
      usage: {},
    };
  });
  try {
    const r = await call('/billing-check?model=qwen-acp%2Fauto');
    assert.strictEqual(acpCalls, 1);
    assert.strictEqual(qwCalls, 0);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.model, 'qwen-acp/auto');
    assert.strictEqual(r.cost, 0.1919);
    assert.strictEqual(r.billed, null);
    assert.strictEqual(r.tokens.total, 0);
    assert.strictEqual(r.singleAccount, true);
  } finally {
    restoreA(); restoreW(); restoreQ(); restoreS();
  }
});

test('探针编排：qwen-acp 请求失败如实返回 ok:false', async () => {
  const restoreA = patch(authStore, 'findUsable', () => ACCOUNTS);
  const restoreW = patch(credits, 'fetchWallets', async ({ account }) => (
    account.id === 2
      ? { ok: true, daily: 0, monthly: 0, longterm: 0 }
      : { ok: true, daily: 0, monthly: 15.2162, longterm: 0 }
  ));
  const restoreS = patch(acp, 'send', async () => { throw new Error('qwen-acp: 上游会话超时'); });
  try {
    const r = await call('/billing-check?model=qwen-acp%2Fauto');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /会话超时/);
    assert.strictEqual(r.cost, undefined);
  } finally {
    restoreA(); restoreW(); restoreS();
  }
});
