// test/unit/qoder-cache-affinity.test.js - 前缀缓存亲和（2026-10-31）
//
// 上游按 (session, 历史) 做前缀缓存。三件必须跨轮稳定，一件必须每轮变：
//   session_id      稳定（会话键取首条 user 消息指纹）
//   business.id     稳定（由 session_id 派生）
//   business.begin_at 稳定（由 session_id 派生，完全确定性）
//   request_id      每轮**必须变**（单次请求标识，复用会被当幂等重试合并）
const { test } = require('node:test');
const assert = require('node:assert');
const chat = require('../../src/qoder/chat');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function body(payload, opts) {
  return JSON.parse(chat.buildBody('gfmodel', payload, opts || {}));
}

test('同一会话连发两次：session_id / business.id / begin_at 全部相同', () => {
  const p = { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '第一句' }] };
  const a = body(p);
  const b = body(p);
  assert.equal(a.session_id, b.session_id);
  assert.equal(a.business.id, b.business.id);
  assert.equal(a.business.begin_at, b.business.begin_at);
});

test('request_id 每轮必须不同（否则被上游当幂等重试合并）', () => {
  const p = { messages: [{ role: 'user', content: 'x' }] };
  assert.notEqual(body(p).request_id, body(p).request_id);
});

test('会话追加轮次后 session_id 不变（首条 user 是锚点）', () => {
  const p1 = { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '第一句' }] };
  const p2 = {
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '答' },
      { role: 'user', content: '第二句' },
    ],
  };
  assert.equal(body(p1).session_id, body(p2).session_id);
});

test('不同首条 user 消息 → 不同 session_id（不能跨会话撞 id）', () => {
  const a = body({ messages: [{ role: 'user', content: '甲' }] });
  const b = body({ messages: [{ role: 'user', content: '乙' }] });
  assert.notEqual(a.session_id, b.session_id);
});

test('派生的 id 是合法 UUIDv5 形状（上游期望 UUID）', () => {
  const b = body({ messages: [{ role: 'user', content: 'x' }] });
  assert.match(b.session_id, UUID_RE);
  assert.match(b.business.id, UUID_RE);
});

test('显式 session_id 优先于派生值（客户端说了算）', () => {
  const b = body({ messages: [{ role: 'user', content: 'x' }] }, { sessionId: 'pinned-session' });
  assert.equal(b.session_id, 'pinned-session');
});

test('payload.session_id 优先级最高', () => {
  const b = body({ session_id: 'from-payload', messages: [{ role: 'user', content: 'x' }] }, { sessionId: 'pinned' });
  assert.equal(b.session_id, 'from-payload');
});

test('取不到首条 user 消息时回落随机 UUID（不硬凑稳定键）', () => {
  const a = body({ messages: [{ role: 'system', content: 'sys' }] });
  const b = body({ messages: [{ role: 'system', content: 'sys' }] });
  assert.notEqual(a.session_id, b.session_id);
  // 回落的是 crypto.randomUUID()（v4），不是派生出来的 v5
  assert.match(a.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('begin_at 是确定值，不随当前时间漂移', () => {
  const b1 = body({ messages: [{ role: 'user', content: 'x' }] });
  // 用同一 session 的派生值再算一次（跨调用、跨时刻都相同）
  const b2 = body({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(b1.business.begin_at, b2.business.begin_at);
  // 落在合理的年份区间（不是 1970，也不是未来）
  const d = new Date(b1.business.begin_at);
  assert.ok(d.getUTCFullYear() >= 2026 && d.getUTCFullYear() <= 2027, `实际 ${d.toISOString()}`);
});

test('buildBody 不改写调用方传的 payload（副作用检查）', () => {
  const p = { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'x' }] };
  const before = JSON.stringify(p);
  chat.buildBody('gfmodel', p, {});
  assert.equal(JSON.stringify(p), before);
});
