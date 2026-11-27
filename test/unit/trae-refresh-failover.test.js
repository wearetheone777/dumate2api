// test/unit/trae-refresh-failover.test.js - 换票失败必须换号（2026-11-28 真机驱动）
//
// 真机事故：导入的过期账号（access 过期 + refresh 被上游拒 10101
// `refresh token is not matched`）被池选中后，`ensureFresh` 直接 throw，
// **整个请求失败**，而健康账号就在旁边没被用到。表现为「TRAE 明明有号却全失败」。
//
// 锁住四条不变量：
//   1. 凭证失效判据只认上游原文措辞，认不出不猜（不误杀能自愈的号）
//   2. 换票失败 → 排除该号 → 换下一个（本轮内不重复选同一个号）
//   3. 凭证失效的号被标 refreshRetiredAt，且 needsRefresh 因此不再每次都打上游
//   4. 重新登录（upsert 带新 refreshToken）清掉该标记，否则新凭证用不了
//
// 运行：node --test test/unit/trae-refresh-failover.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { tmpDir } = require('../helpers/tmpdir');
const tmp = tmpDir('dumate-trae-refresh');
process.env.DUMATE_ADMIN_DATA = tmp;
// 池状态也要隔离（2026-11-28）：不钉的话同一进程里多个用例共用
// 默认 data/pool-state.json，冷却状态跨文件串扰（实测 trae-refresh-failover
// 与 trae-401 一起跑时坏号被前一个文件的快照判成不可选）。
process.env.DUMATE_POOL_STATE = require('path').join(tmp, 'pool-state.json');

const trae = require('../../src/traework');
const auth = require('../../src/traework/auth');

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结果 */ }
});

// ---- 1. 判据：只认明确措辞，认不出不猜 ----

test('isRefreshRejected：真机上出现过的两种原文都认', () => {
  const fn = trae.internals.isRefreshRejected;
  // TRAE 国际版实测原文（HTTP 401 + code 20101）
  assert.strictEqual(fn('HTTP 401 {"ResponseMetadata":{"Error":{"Code":"20101",'
    + '"Data":{"__Message.error":"refresh token is invalid"}}}}'), true);
  // TRAE 国内版实测原文（HTTP 400 + code 10101）
  assert.strictEqual(fn('HTTP 400 {"ResponseMetadata":{"Error":{"Code":"10101",'
    + '"Data":{"__Message.error":"refresh token is not matched to the ..."}}}}'), true);
  // 业务码 + refresh 关键字兜底
  assert.strictEqual(fn('HTTP 400 {"Code":"10101","message":"refresh rejected"}'), true);
});

test('isRefreshRejected：认不出时不猜（不误杀能自愈的号）', () => {
  const fn = trae.internals.isRefreshRejected;
  // 网络类：下次可能成功，必须按瞬时故障处理
  assert.strictEqual(fn('HTTP 0 ECONNRESET'), false);
  assert.strictEqual(fn('timeout'), false);
  assert.strictEqual(fn('换票失败：无可用主机'), false);
  // 上游临时故障
  assert.strictEqual(fn('HTTP 502 Bad Gateway'), false);
  // 有业务码但没提 refresh —— 不认（可能是别的语义）
  assert.strictEqual(fn('HTTP 400 {"Code":"10101"}'), false);
  // 空值
  assert.strictEqual(fn(''), false);
  assert.strictEqual(fn(null), false);
});

// ---- 3. needsRefresh 认退场标记 ----

function seed(accounts) {
  const data = { accounts: accounts.map((a, i) => ({ id: i + 1, ...a })) };
  fs.writeFileSync(auth.filePath(), JSON.stringify(data, null, 2));
  auth._resetCacheForTest ? auth._resetCacheForTest() : null;
  // 池状态也要清：**id 是复用的**（seed 每次从 1 编号），上一个用例把 id=1
  // 打成冷却/禁用后，下一个用例的 id=1 会继承那份状态而被跳过——
  // 表现为「坏号应被尝试换票」假失败（实测：先跑退场用例再跑换号用例必挂）。
  resetPool();
}

/**
 * 清空池状态（账号级冷却/禁用/熔断/计数）。**必须走单例的 `revive`**：
 * 删文件没用——池在模块加载时把状态读进内存、后续写入走自己的副本，
 * 而 `channel-pool` 的 uid 是 `traework:<id>`，账号 id 又每次 seed 从 1 重编，
 * 于是上一个用例的 id=1 状态会被下一个用例的 id=1 继承（实测：先跑退场用例
 * 再跑换号用例，「坏号应被尝试换票」必挂）。
 */
function resetPool() {
  try {
    const { pool } = require('../../src/pool');
    const cp = require('../../src/channel-pool');
    for (const id of [1, 2, 3, 4, 5]) {
      try { pool.revive(cp.uidOf('traework', id)); } catch (e) { /* uid 不存在 */ }
    }
  } catch (e) { /* 池不可用不影响账号级断言 */ }
}

test('needsRefresh：refreshRetiredAt 存在时不再反复打换票端点', () => {
  // access 已过期，正常会 needsRefresh=true
  const expired = { id: 1, expiresAt: Date.now() - 86400000, refreshToken: 'r', accessToken: 'a', enabled: true };
  assert.strictEqual(auth.needsRefresh(expired), true, '没标记时过期就该刷新');
  // 标记退场后不再刷新（否则每次请求都白撞一次上游换票）
  const retired = { ...expired, refreshRetiredAt: Date.now() };
  assert.strictEqual(auth.needsRefresh(retired), false);
});

// ---- 4. 重新登录清标记 ----

test('upsert：带新 refreshToken 时清掉退场标记（否则新凭证用不了）', () => {
  seed([{
    uid: 'u1', nickname: 'old', accessToken: 'oldA', refreshToken: 'oldR',
    expiresAt: Date.now() - 1000, enabled: true, refreshRetiredAt: Date.now(),
  }]);
  const before = auth.get('1');
  assert.ok(before.refreshRetiredAt, '前置：标记在');

  // 重新登录（带新 refreshToken）
  const after = auth.upsert({ uid: 'u1', accessToken: 'newA', refreshToken: 'newR', expiresAt: Date.now() + 86400000 });
  assert.strictEqual(after.refreshRetiredAt, null, '新凭证必须能生效');
  assert.strictEqual(after.accessToken, 'newA');

  // 不带 refreshToken 的普通更新不该清标记（否则退场标记形同虚设）
  seed([{ uid: 'u2', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() - 1000,
    enabled: true, refreshRetiredAt: 12345 }]);
  const keep = auth.upsert({ uid: 'u2', nickname: 'renamed' });
  assert.strictEqual(keep.refreshRetiredAt, 12345, '没有新凭证时保留标记');
});

// ---- 5. 退场 + access 已过期 = 直接判废，不再出网白撞 ----

test('退场标记 + access 已过期：选号阶段直接判废（换号，不吃 401）', async () => {
  // 真机形态：refresh 被拒过（有退场标记），access 也已过期。
  // needsRefresh 因退场标记返回 false，旧实现会放它带过期 access 出网
  // ——每次白打一个上游 401。正确处置是选号阶段就换下一个。
  seed([
    { uid: 'retired', nickname: '退场号', accessToken: 'X1', refreshToken: 'XR1',
      expiresAt: Date.now() - 86400000, enabled: true, refreshRetiredAt: Date.now() - 3600000 },
    { uid: 'good', nickname: '好号', accessToken: 'A2', refreshToken: 'R2',
      expiresAt: Date.now() + 30 * 86400000, enabled: true },
  ]);

  const exchanged = [];
  const origExchange = auth.exchange;
  auth.exchange = async (a) => {
    exchanged.push(a.uid);
    return { ok: true, patch: { accessToken: 'A2new', expiresAt: Date.now() + 30 * 86400000 } };
  };

  const chat = require('../../src/traework/chat');
  const origPost = chat.postStream;
  const origPost2 = chat.post;
  const used = [];
  chat.postStream = async (body, a) => {
    used.push(a && a.uid);
    return { status: 200, stream: require('stream').Readable.from(['data: [DONE]\n\n']) };
  };
  chat.post = chat.postStream;

  try {
    for (let i = 0; i < 6; i++) {
      await trae.send(
        { model: 'glm-5.3-flash', messages: [{ role: 'user', content: `retired-${i}` }], max_tokens: 16, stream: true },
        () => {},
        {},
      ).catch(() => { /* 空回复可能报错，与断言无关 */ });
    }
    assert.ok(!exchanged.includes('retired'), `退场+过期的号不该再换票，实际交换 ${JSON.stringify(exchanged)}`);
    assert.ok(used.length > 0, '必须仍有请求出网');
    assert.ok(used.every((u) => u === 'good'), `出网账号必须全是健康号，实际 ${JSON.stringify(used)}`);
  } finally {
    auth.exchange = origExchange;
    chat.postStream = origPost;
    chat.post = origPost2;
  }
});

// ---- 2. 换号：这是本轮的核心修复（集成式，走真实 runSendOnce） ----

test('选号循环：换票失败后会换号并最终成功', async () => {
  // 两个号：bad 的 access 已过期且 refresh 被拒，good 完全健康。
  // 池是轮询的，首轮落到哪个号取决于全局轮转状态，所以这里**连跑几轮**
  // 覆盖到 bad 成为首选的情形；断言与轮次无关：
  //   · bad 一定被尝试换票（只要它被选到）
  //   · 最终出网的账号永远是 good（换号生效）
  seed([
    { uid: 'bad', nickname: '坏号', accessToken: 'A1', refreshToken: 'R1',
      expiresAt: Date.now() - 86400000, enabled: true },
    { uid: 'good', nickname: '好号', accessToken: 'A2', refreshToken: 'R2',
      expiresAt: Date.now() + 30 * 86400000, enabled: true },
  ]);

  const exchanged = [];
  const origExchange = auth.exchange;
  auth.exchange = async (a) => {
    exchanged.push(a.uid);
    if (a.uid === 'bad') {
      return { ok: false, error: 'HTTP 400 {"Error":{"Code":"10101","Data":{"__Message.error":"refresh token is not matched"}}}' };
    }
    return { ok: true, patch: { accessToken: 'A2new', expiresAt: Date.now() + 30 * 86400000 } };
  };

  // 桩掉真正出网的那一层：chat.postStream（返回形状必须是 {stream, status}）
  const chat = require('../../src/traework/chat');
  const origPost = chat.postStream;
  const used = [];
  chat.postStream = async (body, a) => {
    used.push(a && a.uid);
    return { status: 200, stream: require('stream').Readable.from(['data: [DONE]\n\n']) };
  };
  const origPost2 = chat.post;
  chat.post = chat.postStream;

  try {
    const attempts = [];
    // 每轮换一条内容：池的会话粘性按「首条 user + system」绑定，同一条消息
    // 连发会被粘在首个账号上（实测：坏号永远轮不到，断言假失败）。
    for (let i = 0; i < 6; i++) {
      await trae.send(
        { model: 'glm-5.3-flash', messages: [{ role: 'user', content: `hi-${i}` }], max_tokens: 16, stream: true },
        () => {},
        { attempts: { add: (e) => attempts.push(e) } },
      ).catch(() => { /* 空回复可能报错，与断言无关 */ });
    }

    assert.ok(exchanged.includes('bad'), '坏号应被尝试换票');
    // 核心断言：出网的永远是健康号——旧实现这里会抛错，一次都不会出网
    assert.ok(used.length > 0, '必须有请求真正出网');
    assert.ok(used.every((u) => u === 'good'), `出网账号必须全是健康号，实际 ${JSON.stringify(used)}`);
    assert.ok(attempts.some((a) => /refresh_rejected/.test(a.reason || '')),
      '尝试链应记录 refresh_rejected');
    assert.ok(auth.get('1').refreshRetiredAt, '凭证失效的号应被标记退场');
  } finally {
    auth.exchange = origExchange;
    chat.postStream = origPost;
    chat.post = origPost2;
  }
});
