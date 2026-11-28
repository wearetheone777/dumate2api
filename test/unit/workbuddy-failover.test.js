// test/unit/workbuddy-failover.test.js - 国内主备入口 failover（P1-4，2026-11-28 融合批）
//
// 锁计划原文的判据：
//   - 触发矩阵：408/502/503/传输错误 → failover；**504 不算**；业务 4xx 不算；
//     响应体 retry_policy.retry===false → 不 failover 也不记熔断
//   - 熔断：60s 窗 ≥3 次 → 退避 15s，再败 30/60/120 封顶；一次成功清零
//   - 链序：主入口在前；两个域名备入口全熔断时静态 IP 兜底（Host/SNI 仍原域名）
//   - 每请求最多一次 failover（备入口再失败就原样交回）
//   - global 无多入口（链单元素）
//
// 运行：node --test test/unit/workbuddy-failover.test.js
const assert = require('assert');
const { test } = require('node:test');

const failover = require('../../src/workbuddy/failover');
const chat = require('../../src/workbuddy/chat');

const CN_CHATBASE = 'https://copilot.tencent.com';

test('isInfraStatus 矩阵：408/502/503 算，504 刻意不算，业务码不算', () => {
  assert.strictEqual(failover.isInfraStatus(408), true);
  assert.strictEqual(failover.isInfraStatus(502), true);
  assert.strictEqual(failover.isInfraStatus(503), true);
  assert.strictEqual(failover.isInfraStatus(504), false, '上游超时换入口没用');
  assert.strictEqual(failover.isInfraStatus(500), false);
  assert.strictEqual(failover.isInfraStatus(429), false);
  assert.strictEqual(failover.isInfraStatus(400), false);
  assert.strictEqual(failover.isTransportFailure({ status: 0 }), true);
  assert.strictEqual(failover.isTransportFailure({ status: 502 }), false);
});

test('熔断：60s 窗 2 次不开，第 3 次开 15s；一次成功清零', () => {
  failover._reset();
  const t = 1_000_000;
  failover.noteFailure('h1', t);
  failover.noteFailure('h1', t + 1000);
  assert.strictEqual(failover.isOpen('h1', t + 2000), false, '2 次不熔断');
  failover.noteFailure('h1', t + 2000);
  assert.strictEqual(failover.isOpen('h1', t + 2001), true, '第 3 次开闸');
  assert.strictEqual(failover.isOpen('h1', t + 2001 + 14998), true, '15s 内仍关着（边界内）');
  assert.strictEqual(failover.isOpen('h1', t + 2001 + 15001), false, '15s 后自动恢复');
  // 成功清零
  failover.noteSuccess('h1');
  assert.deepStrictEqual(failover.status(t + 30000).h1, { open: false, openUntil: null, hitsInWindow: 0, strikes: 0 });
});

test('熔断退避翻倍：15→30→60→120 封顶', () => {
  failover._reset();
  let now = 2_000_000;
  const durations = [];
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 3; i++) failover.noteFailure('h2', now + i);
    const st = failover.status(now + 3).h2;
    durations.push(st.openUntil - (now + 2)); // 第三次失败时刻到放行的时长
    now = st.openUntil + 1; // 越过退避再进下一轮
  }
  assert.deepStrictEqual(durations, [15000, 30000, 60000, 120000, 120000], '15→30→60→120 封顶');
});

test('窗口过期：滑窗只数 60s 内的失败', () => {
  failover._reset();
  const t = 3_000_000;
  failover.noteFailure('h3', t);
  failover.noteFailure('h3', t);
  failover.noteFailure('h3', t + 60001); // 前两个已出窗
  assert.strictEqual(failover.isOpen('h3', t + 60001), false, '窗内只剩 1 次');
});

test('chainFor cn：主入口在前 + 官方两备入口；global 单元素', () => {
  failover._reset();
  const cn = failover.chainFor('cn', CN_CHATBASE);
  assert.deepStrictEqual(cn.map((x) => x.base), [CN_CHATBASE, 'https://www.workbuddy.cn', 'https://wb.tencentbuddy.com']);
  assert.strictEqual(cn[0].shadowHost, undefined);
  const g = failover.chainFor('global', 'https://www.workbuddy.ai');
  assert.strictEqual(g.length, 1, '国际版没有多入口实测证据');
});

test('chainFor：两域名备入口全熔断 → 静态 IP 兜底（Host/SNI 仍原域名）', () => {
  failover._reset();
  const t = 4_000_000;
  for (const h of ['https://www.workbuddy.cn', 'https://wb.tencentbuddy.com']) {
    failover.noteFailure(h, t); failover.noteFailure(h, t); failover.noteFailure(h, t);
  }
  const cn = failover.chainFor('cn', CN_CHATBASE, Date.now());
  // 用真实 now（isOpen 内部用 Date.now 的默认参数——传 t 会让状态过期判断错位）
  const now = Date.now();
  failover._reset();
  for (const h of ['https://www.workbuddy.cn', 'https://wb.tencentbuddy.com']) {
    failover.noteFailure(h, now); failover.noteFailure(h, now); failover.noteFailure(h, now);
  }
  const cn2 = failover.chainFor('cn', CN_CHATBASE);
  assert.strictEqual(cn2.length, 2, '[主入口, 静态IP]');
  const ip = cn2[1];
  assert.strictEqual(ip.base, `https://${failover.STATIC_BACKUP_IP}`);
  assert.strictEqual(ip.shadowHost, 'copilot.tencent.com', '兜底 IP 的 Host/SNI 仍是主域名');
  assert.ok(cn.startsWith || cn2[0].base === CN_CHATBASE);
});

// ---- chat 层端到端（stub requestImpl）----

const payload = {
  model: 'kimi-k31',
  stream: true,
  messages: [{ role: 'system', content: '你是测试助手。' }, { role: 'user', content: 'hi' }],
};
const acc = { id: 9, uid: 'uid-fo', region: 'cn', accessToken: 'tok' };

function fakeRes(status, bodyText, headers) {
  const buf = Buffer.from(bodyText || '');
  return {
    statusCode: status,
    headers: headers || {},
    on(ev, fn) {
      if (ev === 'data') setImmediate(() => fn(buf));
      if (ev === 'end') setImmediate(() => fn());
      if (ev === 'error') setImmediate(() => fn());
    },
    destroy() {},
  };
}

function stubChat(routes) {
  const calls = [];
  chat._setRequestImpl((opts, cb) => {
    calls.push({ hostname: opts.hostname, headers: opts.headers, servername: opts.servername });
    const route = routes.find((r) => r.hostname === opts.hostname);
    const req = {
      on(ev, fn) { if (ev === 'error' && route && route.transportError) setImmediate(() => fn(new Error(route.transportError))); },
      write() {}, end() {}, destroy() {},
    };
    // 传输错误路由：不回响应，只触发 error（与真实 socket 一致）
    if (route && route.transportError) return req;
    const safe = route || { reply: () => [404, 'no route'] };
    const rr = safe.reply();
    setImmediate(() => cb(fakeRes(...(Array.isArray(rr) ? rr : [rr.status, rr.body]))));
    return req;
  });
  return calls;
}

test('chat 层：主入口 502（无 retry_policy）→ failover 打备用入口成功；熔断记主入口', async () => {
  failover._reset();
  const calls = stubChat([
    { hostname: 'copilot.tencent.com', reply: () => [502, '<html>bad gateway</html>'] },
    { hostname: 'www.workbuddy.cn', reply: () => [200, 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'] },
  ]);
  const r = await chat.postStream('cn', acc, payload);
  assert.strictEqual(r.status, 200, '备用入口接住了');
  assert.strictEqual(calls.length, 2, '主备各一次');
  assert.strictEqual(calls[0].hostname, 'copilot.tencent.com');
  assert.strictEqual(calls[1].hostname, 'www.workbuddy.cn');
  assert.strictEqual(failover.status()['https://copilot.tencent.com'].hitsInWindow > 0 || failover.status()['https://copilot.tencent.com'].open, true, '主入口记了一次失败');
  failover._reset();
});

test('chat 层：502 带 retry_policy.retry=false → 不 failover、不记熔断', async () => {
  failover._reset();
  const calls = stubChat([
    { hostname: 'copilot.tencent.com', reply: () => [502, '{"retry_policy":{"retry":false},"code":502}'] },
    { hostname: 'www.workbuddy.cn', reply: () => [200, 'should-not-be-hit'] },
  ]);
  const r = await chat.postStream('cn', acc, payload);
  assert.strictEqual(r.status, 502, '上游明说别重试，原样交回');
  assert.strictEqual(calls.length, 1, '没有第二次尝试');
  const st = failover.status()['https://copilot.tencent.com'];
  assert.ok(!st || (!st.open && st.hitsInWindow === 0), '不记熔断');
  failover._reset();
});

test('chat 层：504 不 failover（单次尝试）', async () => {
  failover._reset();
  const calls = stubChat([
    { hostname: 'copilot.tencent.com', reply: () => [504, 'gateway timeout'] },
  ]);
  const r = await chat.postStream('cn', acc, payload);
  assert.strictEqual(r.status, 504);
  assert.strictEqual(calls.length, 1);
  failover._reset();
});

test('chat 层：主入口传输错误 → 备用入口接住；两处全挂 → status 0 如实回', async () => {
  failover._reset();
  const calls = stubChat([
    { hostname: 'copilot.tencent.com', transportError: 'ECONNRESET' },
    { hostname: 'www.workbuddy.cn', reply: () => [200, 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'] },
  ]);
  const r1 = await chat.postStream('cn', acc, payload);
  assert.strictEqual(r1.status, 200, '传输错误也触发 failover');
  failover._reset();
  const calls2 = stubChat([
    { hostname: 'copilot.tencent.com', transportError: 'ECONNREFUSED' },
    { hostname: 'www.workbuddy.cn', transportError: 'ECONNREFUSED' },
  ]);
  const r2 = await chat.postStream('cn', acc, payload);
  assert.strictEqual(r2.status, 0, '两处全挂如实回 status 0');
  assert.match(r2.error, /ECONNREFUSED/);
  assert.strictEqual(calls2.length, 2, '最多一次 failover，不再打第三入口');
  failover._reset();
});

test('chat 层：静态 IP 兜底候选携带 shadowHost 的 Host 头与 SNI', async () => {
  failover._reset();
  // 两个域名备入口先熔断（3 次 × 2 入口）
  const now = Date.now();
  for (const h of ['https://www.workbuddy.cn', 'https://wb.tencentbuddy.com']) {
    failover.noteFailure(h, now); failover.noteFailure(h, now); failover.noteFailure(h, now);
  }
  const calls = stubChat([
    { hostname: 'copilot.tencent.com', reply: () => [502, '<html>bad gateway</html>'] },
    { hostname: failover.STATIC_BACKUP_IP, reply: () => [200, 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'] },
  ]);
  const r = await chat.postStream('cn', acc, payload);
  assert.strictEqual(r.status, 200, '静态 IP 兜底接住');
  const ipCall = calls.find((x) => x.hostname === failover.STATIC_BACKUP_IP);
  assert.ok(ipCall, '确实打了兜底 IP');
  assert.strictEqual(ipCall.headers.Host, 'copilot.tencent.com', 'Host 仍原域名');
  assert.strictEqual(ipCall.servername, 'copilot.tencent.com', 'SNI 仍原域名');
  failover._reset();
});
