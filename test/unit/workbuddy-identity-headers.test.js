// test/unit/workbuddy-identity-headers.test.js - 设备标识按账号派生 + 会话四件套
// （2026-11-08 融合批）
//
// 出处：GitHub 生态调研（ardeyoxipianyi/workbuddy2api-hub 的
// X-Machine-ID / X-Session-ID 派生，多份实现交叉实证）。
//
// **这一批防的是「整个账号池被上游看成一台设备」**：
// X-Machine-ID / X-Session-ID 是上游的设备关联键。若用进程级常量，
// 一个账号触发 11140（账号级风控）时，其余账号会跟着连坐——这比 IP 连坐
// 更难处置（IP 有代理槽，设备指纹没有）。
//
// 锁的行为：
//   1. 同账号**跨调用/跨重启稳定**（md5 派生，不是 randomUUID）
//   2. **不同账号必须不同**（这是防连坐的唯一判据）
//   3. UUIDv4 形状（上游按 UUID 校验格式，32 位裸 hex 会被判非法）
//   4. machine ≠ session（同一个 uid 的两个盐不能撞）
//   5. 请求级 id 的对应关系：Request-ID == Message-ID，ConvReq-ID 每次不同
//
// 运行：node --test test/unit/workbuddy-identity-headers.test.js
const test = require('node:test');
const assert = require('node:assert');

const chat = require('../../src/workbuddy/chat');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('deriveDeviceId：同账号稳定（跨调用 = 跨重启都相同）', () => {
  const a = chat.deriveDeviceId('machine', 'uid-1');
  const b = chat.deriveDeviceId('machine', 'uid-1');
  assert.equal(a, b, '必须是确定性派生——randomUUID 会让同一账号每天变成新设备');
  assert.match(a, UUID_V4, '上游按 UUID 校验格式，裸 hex 会被判非法');
});

test('deriveDeviceId：不同账号必须不同（防池子被看成一台设备）', () => {
  const ids = ['uid-1', 'uid-2', 'uid-3', 'a', 'b', '100', '101'];
  const machines = ids.map((u) => chat.deriveDeviceId('machine', u));
  const sessions = ids.map((u) => chat.deriveDeviceId('session', u));
  assert.equal(new Set(machines).size, ids.length, '同盐不同账号不能撞');
  assert.equal(new Set(sessions).size, ids.length);
});

test('deriveDeviceId：machine 与 session 两个盐不撞', () => {
  for (const uid of ['u1', 'u2', 'glm-user']) {
    assert.notEqual(
      chat.deriveDeviceId('machine', uid),
      chat.deriveDeviceId('session', uid),
      `${uid}: 设备标识与会话标识必须是两个不同的值`,
    );
  }
});

test('deriveDeviceId：uid 为空返回空串（不编一个假设备）', () => {
  assert.equal(chat.deriveDeviceId('machine', ''), '');
  assert.equal(chat.deriveDeviceId('machine', null), '');
  assert.equal(chat.deriveDeviceId('machine', undefined), '');
  assert.equal(chat.deriveDeviceId('machine', '   '), '');
});

test('deriveDeviceId：数字 id 也认（导入期账号可能还没有 uid）', () => {
  const a = chat.deriveDeviceId('machine', 42);
  assert.match(a, UUID_V4);
  assert.equal(a, chat.deriveDeviceId('machine', '42'), '数字与字符串形态应一致，否则同一账号会有两个设备身份');
});

test('chatHeaders：带上设备标识，且随账号不同', () => {
  const h1 = chat.chatHeaders('cn', { uid: 'u1', accessToken: 't' }, 10, 'c1');
  const h2 = chat.chatHeaders('cn', { uid: 'u2', accessToken: 't' }, 10, 'c1');
  assert.match(h1['X-Machine-ID'], UUID_V4);
  assert.match(h1['X-Session-ID'], UUID_V4);
  assert.notEqual(h1['X-Machine-ID'], h2['X-Machine-ID'], '**两个账号的设备标识必须不同**');
  assert.notEqual(h1['X-Session-ID'], h2['X-Session-ID']);
});

test('chatHeaders：同一账号多次请求，设备标识稳定而请求 id 每次不同', () => {
  const acc = { uid: 'stable-user', accessToken: 't' };
  const h1 = chat.chatHeaders('cn', acc, 10, 'c1');
  const h2 = chat.chatHeaders('cn', acc, 10, 'c1');
  assert.equal(h1['X-Machine-ID'], h2['X-Machine-ID'], '设备标识要稳定（同一个人同一台机器）');
  assert.equal(h1['X-Session-ID'], h2['X-Session-ID']);
  assert.notEqual(h1['X-Request-ID'], h2['X-Request-ID'], '请求 id 必须每次不同');
  assert.notEqual(h1['X-Conversation-Request-ID'], h2['X-Conversation-Request-ID']);
});

test('chatHeaders：Request-ID 与 Conversation-Message-ID 同值（官方把 message 镜像到 request）', () => {
  const h = chat.chatHeaders('cn', { uid: 'u1', accessToken: 't' }, 10, 'c1');
  assert.equal(h['X-Request-ID'], h['X-Conversation-Message-ID'],
    '两份不同会让上游把「一次用户发送」记成两次请求，配额莫名翻倍');
  assert.equal(h['X-Root-Request-ID'], h['X-Request-ID'], '桌面端无父 span，root 与本请求同级');
  assert.notEqual(h['X-Request-ID'], h['X-Conversation-Request-ID'],
    'Conversation-Request-ID 是聚合主键，每次发送独立');
});

test('chatHeaders：链路追踪三个头在场且 TraceId 一致', () => {
  const h = chat.chatHeaders('global', { uid: 'u1', accessToken: 't' }, 10, 'c1');
  assert.equal(h['X-B3-TraceId'], h['X-Trace-ID'], 'B3 与自有 trace 头同源');
  assert.match(h['X-B3-TraceId'], /^[0-9a-f]{32}$/);
  assert.match(h['X-B3-SpanId'], /^[0-9a-f]{16}$/);
  assert.equal(h['X-B3-Sampled'], '1');
});

test('chatHeaders：没有 uid 时退回 id 派生（仍保证跨账号不同）', () => {
  const h1 = chat.chatHeaders('cn', { id: 1, accessToken: 't' }, 10, 'c1');
  const h2 = chat.chatHeaders('cn', { id: 2, accessToken: 't' }, 10, 'c1');
  assert.match(h1['X-Machine-ID'], UUID_V4);
  assert.notEqual(h1['X-Machine-ID'], h2['X-Machine-ID']);
  assert.equal(h1['X-No-User-Id'], '1', '没有 uid 时仍要带 X-No-User-Id 约定');
});

test('chatHeaders：完全没有账号信息时不编设备标识', () => {
  const h = chat.chatHeaders('cn', null, 10, 'c1');
  assert.equal(h['X-Machine-ID'], undefined, '没有账号就不该有设备身份');
  assert.equal(h['X-Session-ID'], undefined);
  assert.equal(h['X-No-User-Id'], '1');
});

test('chatHeaders：区域相关的头仍按区域给（没有被新头挤掉）', () => {
  const cn = chat.chatHeaders('cn', { uid: 'u', accessToken: 't' }, 10, 'c');
  const intl = chat.chatHeaders('global', { uid: 'u', accessToken: 't' }, 10, 'c');
  assert.equal(cn['Accept-Language'], 'zh-CN');
  assert.equal(intl['Accept-Language'], 'en-US');
  assert.ok(cn.Origin.includes('codebuddy.cn'), '国内 Origin 是 codebuddy.cn');
  assert.ok(intl.Origin.includes('workbuddy.ai'));
});
