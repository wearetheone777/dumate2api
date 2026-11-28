// test/unit/workbuddy-chat-headers.test.js - chat 出站头对齐官方 5.11.x（P0-1）
//
// 2026-11-28 融合批，取代 workbuddy-identity-headers.test.js：
// 11.4 批把 X-Machine-ID/X-Session-ID 当成官方形态——GitHub 调研（yreidev
// official-client.md 实包核对）推翻了它：官方对话**不发**这两个头，也不发
// Accept-Language / Origin / Referer / X-Requested-With / chat 上的 X-No-*。
// 11.4 的教训原话：「A/B 证明无害 ≠ 官方形态」——所以这批的判据是
// **负向清单**：出站头集必须 ⊆ 官方抓包头集，多一个都是指纹。
//
// 锁的行为：
//   1. 负向清单：官方不发的 7 类头一律不出站（默认）
//   2. 正向清单：官方必发的 X-Stainless-*/X-Agent-*/X-Client-*/W3C trace 都在场
//   3. id 形态 uuidv7 去连字符；cn/intl 的 X-Request-ID 镜像对象不同
//   4. deriveDeviceId 保留（兜底开关用）：按账号派生、跨调用稳定、防连坐
//   5. DUMATE_WORKBUDDY_LEGACY_DEVICE_HEADERS=1 才带回设备头
//
// 运行：node --test test/unit/workbuddy-chat-headers.test.js
const test = require('node:test');
const assert = require('node:assert');

const chat = require('../../src/workbuddy/chat');
const c = require('../../src/workbuddy/constants');

const UUID_V7_HEX = /^[0-9a-f]{32}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 官方对话头集（Zhengyuuuui intl 抓包 + yreidev 5.11.3 实包核对并集）。
 * 出站头集 ⊆ 它 + 传输层基础头（Content-Type/Length、Authorization、UA）——
 * 多出来的任何头都是指纹，测试失败就要对着这个集合解释。 */
const OFFICIAL_CHAT_HEADERS = new Set([
  'accept', 'authorization', 'content-type', 'content-length', 'user-agent',
  'x-product', 'x-agent-purpose', 'x-agent-intent', 'x-agent-type', 'x-agent-runtime',
  'x-private-data', 'x-client-version', 'x-client-platform', 'x-client-product',
  'x-ide-type', 'x-ide-name', 'x-ide-version',
  'x-stainless-retry-count', 'x-stainless-timeout', 'x-stainless-lang',
  'x-stainless-package-version', 'x-stainless-os', 'x-stainless-arch',
  'x-stainless-runtime', 'x-stainless-runtime-version',
  'x-conversation-id', 'x-conversation-request-id', 'x-conversation-message-id',
  'x-request-id', 'x-root-request-id', 'x-codebuddy-request',
  'x-trace-id', 'x-b3-traceid', 'x-b3-spanid', 'x-b3-sampled',
  'traceparent', 'b3',
  'x-user-id', 'x-enterprise-id', 'x-domain',
]);

test('负向清单：官方对话不发的头一律不出站', () => {
  const h = chat.chatHeaders('cn', { uid: 'u1', accessToken: 't' }, 10, 'c1');
  for (const k of ['Accept-Language', 'Origin', 'Referer', 'X-Requested-With',
    'X-Machine-ID', 'X-Session-ID', 'X-No-User-Id', 'X-No-Enterprise-Id', 'X-No-Department-Info']) {
    assert.equal(h[k], undefined, `${k} 官方对话不发（yreidev 实包核对）`);
  }
});

test('负向清单：出站头集 ⊆ 官方抓包头集（多一个都是指纹）', () => {
  // 账号字段齐全 + 缺失两种形态都要过（X-No-* 已删，缺字段就是不带，不是占位）
  for (const acct of [
    { uid: 'u1', accessToken: 't', enterpriseId: 'e', domain: 'd' },
    { accessToken: 't' },
    null,
  ]) {
    for (const region of ['cn', 'global']) {
      const h = chat.chatHeaders(region, acct, 10, 'c1');
      for (const k of Object.keys(h)) {
        assert.ok(
          OFFICIAL_CHAT_HEADERS.has(k.toLowerCase()),
          `${region} 出现官方对话不发的头: ${k}`,
        );
      }
    }
  }
});

test('正向清单：官方必发的头都在场', () => {
  const h = chat.chatHeaders('cn', { uid: 'u1', accessToken: 't' }, 10, 'c1');
  assert.equal(h.Accept, 'application/json');
  assert.equal(h['X-Product'], 'SaaS');
  assert.equal(h['X-Agent-Purpose'], 'conversation');
  assert.equal(h['X-Agent-Intent'], 'craft');
  assert.equal(h['X-Agent-Type'], 'main');
  assert.equal(h['X-Agent-Runtime'], 'local-agent');
  assert.equal(h['X-Private-Data'], 'true');
  assert.equal(h['X-Client-Platform'], 'macos');
  assert.equal(h['X-Client-Product'], 'WorkBuddy');
  assert.equal(h['X-IDE-Type'], 'WorkBuddy');
  assert.equal(h['X-IDE-Name'], 'WorkBuddy');
  assert.equal(h['X-Stainless-Retry-Count'], '0');
  assert.equal(h['X-Stainless-Timeout'], '1200');
  assert.equal(h['X-Stainless-Lang'], 'js');
  assert.equal(h['X-Stainless-Package-Version'], '6.25.0');
  assert.equal(h['X-Stainless-OS'], 'MacOS');
  assert.equal(h['X-Stainless-Arch'], 'arm64');
  assert.equal(h['X-Stainless-Runtime'], 'node');
  assert.equal(h['X-Stainless-Runtime-Version'], 'v22.21.1');
  // intl 的产品 token 是 workbuddy-ai（无空格）
  const gi = chat.chatHeaders('global', { uid: 'u1', accessToken: 't' }, 10, 'c1');
  assert.equal(gi['X-Client-Product'], 'workbuddy-ai');
});

test('id 形态：请求级 id 是 uuidv7 去连字符（时间有序 + version/variant 位正确）', () => {
  const h = chat.chatHeaders('cn', { uid: 'u1', accessToken: 't' }, 10, 'c1');
  for (const k of ['X-Request-ID', 'X-Conversation-Request-ID', 'X-Conversation-Message-ID', 'X-Trace-ID']) {
    assert.match(h[k], UUID_V7_HEX, k);
  }
  // version 7 位（每 2 个 hex 一字节：第 13 个 hex = version 高位）
  for (const k of ['X-Request-ID', 'X-Conversation-Request-ID']) {
    assert.equal(h[k][12], '7', `${k} 第 13 位是 version 7`);
  }
  // 真实时钟有序：晚生成的 id 按字符串比较更大（uuidv7 的核心性质）
  const a = chat.uuidv7hex();
  const b = chat.uuidv7hex(Date.now() + 50);
  assert.ok(b > a, 'uuidv7 必须时间有序');
});

test('id 配对：cn 镜像 Conversation-Request-ID，intl 镜像 Conversation-Message-ID', () => {
  const cn = chat.chatHeaders('cn', { uid: 'u1', accessToken: 't' }, 10, 'c1');
  assert.equal(cn['X-Request-ID'], cn['X-Conversation-Request-ID'],
    'Zhengyuuuui 抓包口径：cn 的 X-Request-ID 是聚合主键的镜像');
  assert.notEqual(cn['X-Request-ID'], cn['X-Conversation-Message-ID']);
  const gi = chat.chatHeaders('global', { uid: 'u1', accessToken: 't' }, 10, 'c1');
  assert.equal(gi['X-Request-ID'], gi['X-Conversation-Message-ID'],
    'intl 的 X-Request-ID 镜像 Message-ID');
  assert.notEqual(gi['X-Request-ID'], gi['X-Conversation-Request-ID']);
  // 会话三件套每次不同（同会话内 ConvReq 也每请求新值）
  const h2 = chat.chatHeaders('cn', { uid: 'u1', accessToken: 't' }, 10, 'c1');
  assert.notEqual(cn['X-Conversation-Request-ID'], h2['X-Conversation-Request-ID']);
  assert.notEqual(cn['X-Conversation-Message-ID'], h2['X-Conversation-Message-ID']);
});

test('trace 双族：X-B3-* 与 W3C traceparent/b3 同源在场', () => {
  const h = chat.chatHeaders('cn', { uid: 'u1', accessToken: 't' }, 10, 'c1');
  assert.match(h['X-Trace-ID'], UUID_V7_HEX);
  assert.equal(h['X-B3-TraceId'], h['X-Trace-ID']);
  assert.match(h['X-B3-SpanId'], /^[0-9a-f]{16}$/);
  assert.equal(h['X-B3-Sampled'], '1');
  assert.equal(h.traceparent, `00-${h['X-Trace-ID']}-${h['X-B3-SpanId']}-01`);
  assert.equal(h.b3, `${h['X-Trace-ID']}-${h['X-B3-SpanId']}-1`);
});

test('UA：三段 WorkBuddy/<v> WorkBuddy/<v> CLI/<cli>；intl token 无空格', () => {
  const cn = chat.chatUserAgent('cn');
  assert.equal(cn, `WorkBuddy/5.11.3 WorkBuddy/5.11.3 CLI/${c.CHAT_CLI_VERSION}`);
  const gi = chat.chatUserAgent('global');
  assert.equal(gi, `workbuddy-ai/5.11.7 workbuddy-ai/5.11.7 CLI/${c.CHAT_CLI_VERSION}`);
  // env 覆盖仍生效
  process.env.DUMATE_WORKBUDDY_APP_VERSION = '9.9.9';
  try {
    assert.ok(chat.chatUserAgent('cn').startsWith('WorkBuddy/9.9.9 WorkBuddy/9.9.9 '));
  } finally { delete process.env.DUMATE_WORKBUDDY_APP_VERSION; }
});

test('兜底开关：LEGACY_DEVICE_HEADERS=1 才带回设备头（按账号派生、防连坐语义不变）', () => {
  process.env.DUMATE_WORKBUDDY_LEGACY_DEVICE_HEADERS = '1';
  try {
    const h1 = chat.chatHeaders('cn', { uid: 'u1', accessToken: 't' }, 10, 'c1');
    const h2 = chat.chatHeaders('cn', { uid: 'u2', accessToken: 't' }, 10, 'c1');
    assert.match(h1['X-Machine-ID'], UUID_V4);
    assert.match(h1['X-Session-ID'], UUID_V4);
    assert.notEqual(h1['X-Machine-ID'], h2['X-Machine-ID'], '两个账号必须不同（防连坐）');
    const h3 = chat.chatHeaders('cn', { uid: 'u1', accessToken: 't' }, 10, 'c1');
    assert.equal(h1['X-Machine-ID'], h3['X-Machine-ID'], '同账号跨调用稳定');
  } finally { delete process.env.DUMATE_WORKBUDDY_LEGACY_DEVICE_HEADERS; }
  // 关掉后不带
  const h = chat.chatHeaders('cn', { uid: 'u1', accessToken: 't' }, 10, 'c1');
  assert.equal(h['X-Machine-ID'], undefined);
});

test('deriveDeviceId：确定性派生、跨账号不同、uid 空不编（11.4 批语义原样保留）', () => {
  assert.equal(chat.deriveDeviceId('machine', 'uid-1'), chat.deriveDeviceId('machine', 'uid-1'));
  assert.match(chat.deriveDeviceId('machine', 'uid-1'), UUID_V4);
  const machines = ['uid-1', 'uid-2', 'a', 'b'].map((u) => chat.deriveDeviceId('machine', u));
  assert.equal(new Set(machines).size, 4);
  assert.notEqual(chat.deriveDeviceId('machine', 'u1'), chat.deriveDeviceId('session', 'u1'));
  assert.equal(chat.deriveDeviceId('machine', ''), '');
  assert.equal(chat.deriveDeviceId('machine', null), '');
});

test('stableConversationId：uuidv7 形状 + 内容派生稳定 + 无锚回落', () => {
  const a = chat.stableConversationId([{ role: 'user', content: 'A' }]);
  const b = chat.stableConversationId([{ role: 'user', content: 'A' }]);
  assert.equal(a, b, '同会话跨轮稳定');
  assert.notEqual(a, chat.stableConversationId([{ role: 'user', content: 'B' }]));
  assert.match(a, UUID_V7, '官方会话 id 是标准 uuid');
  const r = chat.stableConversationId([]);
  assert.match(r, UUID_V7, '无锚回落也是合法 uuid（真实 uuidv7）');
});

// —— P2「b3 链路随会话延续」（2026-11-28 批）——

test('sessionTraceId：会话级稳定、跨会话不同、uuidv7 形状（32-hex）', () => {
  const m = [{ role: 'user', content: 'A' }];
  const t1 = chat.sessionTraceId(m);
  assert.equal(t1, chat.sessionTraceId(m), '同会话跨轮稳定（种子派生，无 LRU 失忆）');
  assert.notEqual(t1, chat.sessionTraceId([{ role: 'user', content: 'B' }]));
  assert.match(t1, UUID_V7_HEX);
  assert.equal(t1[12], '7', 'version 位');
  assert.ok('89ab'.includes(t1[16]), 'variant 位 10xx');
  assert.match(chat.sessionTraceId([]), UUID_V7_HEX, '无锚回落真实 uuidv7');
});

test('chatHeaders 第五参：传入会话 TraceId 时 trace 双族用它，span 每请求新值', () => {
  const tid = chat.sessionTraceId([{ role: 'user', content: 'A' }]);
  const h1 = chat.chatHeaders('cn', { uid: 'u1', accessToken: 't' }, 10, 'c1', tid);
  const h2 = chat.chatHeaders('cn', { uid: 'u1', accessToken: 't' }, 10, 'c1', tid);
  assert.equal(h1['X-Trace-ID'], tid);
  assert.equal(h2['X-Trace-ID'], tid, '同会话两轮共用 TraceId');
  assert.notEqual(h1['X-B3-SpanId'], h2['X-B3-SpanId']);
  assert.equal(h1.traceparent, `00-${tid}-${h1['X-B3-SpanId']}-01`);
  assert.equal(h1.b3, `${tid}-${h1['X-B3-SpanId']}-1`);
  // 形状不对（脏值）→ 回落新 uuidv7，绝不外发
  assert.match(
    chat.chatHeaders('cn', { uid: 'u1', accessToken: 't' }, 10, 'c1', 'not-a-trace')['X-Trace-ID'],
    UUID_V7_HEX,
  );
  // 不传 → 每请求新值（旧行为，activity.js 等调用方不受影响）
  const a = chat.chatHeaders('cn', { uid: 'u1', accessToken: 't' }, 10, 'c1');
  const b = chat.chatHeaders('cn', { uid: 'u1', accessToken: 't' }, 10, 'c1');
  assert.notEqual(a['X-Trace-ID'], b['X-Trace-ID']);
});

test('postStream 接线：同一请求跨 failover 尝试共用会话 TraceId', async () => {
  const failover = require('../../src/workbuddy/failover');
  const wbPayload = {
    model: 'kimi-k31',
    stream: true,
    messages: [{ role: 'system', content: '你是测试助手。' }, { role: 'user', content: 'hi' }],
  };
  failover._reset();
  const seen = [];
  chat._setRequestImpl((opts, cb) => {
    seen.push(opts.headers['x-trace-id'] || opts.headers['X-Trace-ID']);
    const buf = Buffer.from('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    setImmediate(() => cb({
      statusCode: seen.length === 1 ? 502 : 200,
      headers: {},
      on(ev, fn) {
        if (ev === 'data') setImmediate(() => fn(buf));
        if (ev === 'end') setImmediate(() => fn());
        if (ev === 'error') setImmediate(() => fn());
      },
      destroy() {},
    }));
    return { on() {}, write() {}, end() {}, destroy() {} };
  });
  const r = await chat.postStream('cn', { id: 9, uid: 'uid-t', region: 'cn', accessToken: 'tok' }, wbPayload);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(seen.length, 2, '主备各一次');
  assert.strictEqual(seen[0], seen[1], 'failover 两跳是同一条 trace（同 TraceId 不同 span）');
  chat._setRequestImpl(undefined);
  failover._reset();
});
