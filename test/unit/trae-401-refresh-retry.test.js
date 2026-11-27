// test/unit/trae-401-refresh-retry.test.js - 401 的第一响应是刷新同账号，不是换号
//
// 真机缺口（2026-11-28）：三个 intl 账号的 `expiresAt` 都还没到（12-08），
// `needsRefresh` 返回 false，于是带着旧 access 发出去被上游 401——而它们的
// refresh token 早已失效。旧实现只把 401 当成普通错误喂池 + 换号，
// 「刷新」这一步从未发生：能自愈的号（access 被上游提前作废、refresh 仍有效）
// 被白白判死。
//
// 锁住四条不变量：
//   1. 401 + 刷新成功 → 用**同一个账号**重试一次，第二次出网用的是新 access
//   2. 401 + 刷新成功 + 重试成功 → 整条请求成功（不是「换个号碰巧成了」）
//   3. 401 + 刷新被拒 → 标 refreshRetiredAt（凭证退场）+ 换号
//   4. 已经吐出内容（e.sent）之后的 401 → 不刷新、不重试（重试会让客户端看到两段回答）
//
// 运行：node --test test/unit/trae-401-refresh-retry.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { Readable } = require('stream');

const { tmpDir } = require('../helpers/tmpdir');
const tmp = tmpDir('dumate-trae-401');
process.env.DUMATE_ADMIN_DATA = tmp;
// 池状态也要隔离（2026-11-28）：不钉的话同一进程里多个用例共用
// 默认 data/pool-state.json，冷却状态跨文件串扰（实测 trae-refresh-failover
// 与 trae-401 一起跑时坏号被前一个文件的快照判成不可选）。
process.env.DUMATE_POOL_STATE = require('path').join(tmp, 'pool-state.json');

const trae = require('../../src/traework');
const auth = require('../../src/traework/auth');
const chat = require('../../src/traework/chat');

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结果 */ }
});

function seed(accounts) {
  const data = { accounts: accounts.map((a, i) => ({ id: i + 1, ...a })) };
  fs.writeFileSync(auth.filePath(), JSON.stringify(data, null, 2));
}

/** 健康的 access（远离 needsRefresh 的 24h 提前量）——让 401 只能来自上游，不是本地预刷新 */
function healthy(id, uid, nickname, token) {
  return {
    id, uid, nickname, accessToken: token, refreshToken: `R-${token}`,
    expiresAt: Date.now() + 60 * 86400000, enabled: true,
  };
}

test('401 后刷新成功：同账号用新 access 重试并成功', async () => {
  seed([healthy(1, 'u1', '唯一号', 'OLD')]);

  const exchanged = [];
  const origExchange = auth.exchange;
  auth.exchange = async (a) => {
    exchanged.push({ uid: a.uid, access: a.accessToken });
    return { ok: true, patch: { accessToken: 'NEW', expiresAt: Date.now() + 60 * 86400000 } };
  };

  // 第一次出网用 OLD 回 401，第二次用 NEW 回正常流
  const usedTokens = [];
  const origPost = chat.postStream;
  const origPost2 = chat.post;
  chat.postStream = async (body, a) => {
    usedTokens.push(a.accessToken);
    if (a.accessToken === 'OLD') {
      return { status: 401, stream: Readable.from(['{"error":"token expired"}']) };
    }
    return {
      status: 200,
      stream: Readable.from([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    };
  };
  chat.post = chat.postStream;

  try {
    const attempts = [];
    await trae.send(
      { model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: true },
      () => {},
      { attempts: { add: (e) => attempts.push(e) }, region: 'cn' },
    );
    // 核心断言 1：刷新被触发过，且是同一个账号
    assert.strictEqual(exchanged.length, 1, '401 后必须尝试刷新');
    assert.strictEqual(exchanged[0].uid, 'u1', '刷新的是被 401 的那个账号（不换号）');
    // 核心断言 2：出网两次，第一次 OLD、第二次 NEW
    assert.deepStrictEqual(usedTokens, ['OLD', 'NEW'], `出网 token 序列应为 [OLD, NEW]，实际 ${JSON.stringify(usedTokens)}`);
    // 核心断言 3：整条请求成功（没走到换号路径）
    assert.ok(attempts.some((a) => /refresh_on_401/.test(a.reason || '')), `尝试链应记录 refresh_on_401，实际 ${JSON.stringify(attempts)}`);
    assert.ok(attempts.some((a) => a.outcome === 'ok'), '重试应记为 ok');
    // 刷新成功不该留下退场标记
    assert.ok(!auth.get(1).refreshRetiredAt, '刷新成功不应标退场');
  } finally {
    auth.exchange = origExchange;
    chat.postStream = origPost;
    chat.post = origPost2;
  }
});

test('401 后刷新被拒：标退场并换号（不反复撞同一个废号）', async () => {
  seed([healthy(1, 'u1', '废号', 'A1'), healthy(2, 'u2', '好号', 'A2')]);

  const origExchange = auth.exchange;
  auth.exchange = async (a) => {
    if (a.uid === 'u1') {
      return { ok: false, error: 'HTTP 401 {"Error":{"Code":"20101","Data":{"__Message.error":"refresh token is invalid"}}}' };
    }
    return { ok: true, patch: { accessToken: 'A2new', expiresAt: Date.now() + 60 * 86400000 } };
  };

  const used = [];
  const origPost = chat.postStream;
  const origPost2 = chat.post;
  chat.postStream = async (body, a) => {
    used.push(a.uid);
    if (a.uid === 'u1') {
      return { status: 401, stream: Readable.from(['{"error":"token expired"}']) };
    }
    return { status: 200, stream: Readable.from(['data: [DONE]\n\n']) };
  };
  chat.post = chat.postStream;

  try {
    // 轮询首个可能落到任一账号，连跑几轮覆盖到废号成为首选的情形
    const attempts = [];
    // 每轮换一条内容：池的会话粘性按「首条 user + system」绑定，同一条消息
    // 连发会被粘在首个账号上（实测：坏号永远轮不到，断言假失败）。
    for (let i = 0; i < 6; i++) {
      await trae.send(
        { model: 'glm-5.3-flash', messages: [{ role: 'user', content: `hi-${i}` }], max_tokens: 16, stream: true },
        () => {},
        { attempts: { add: (e) => attempts.push(e) }, region: 'cn' },
      ).catch(() => { /* 空回复可能报错，与断言无关 */ });
    }
    // 废号被 401 后刷新被拒 → 退场
    assert.ok(auth.get(1).refreshRetiredAt, '刷新被拒的号应标 refreshRetiredAt');
    // 出网的只可能是 u1 的第一次（401）与健康号
    const nonGood = used.filter((u) => u !== 'u2');
    assert.ok(nonGood.every((u) => u === 'u1'), `除好号外只允许废号出网一次，实际 ${JSON.stringify(used)}`);
    assert.ok(used.includes('u2'), '必须换到健康号出网');
    assert.ok(attempts.some((a) => /refresh_rejected/.test(a.reason || '')),
      `尝试链应记录 refresh_rejected，实际 ${JSON.stringify(attempts.map((a) => a.reason))}`);
  } finally {
    auth.exchange = origExchange;
    chat.postStream = origPost;
    chat.post = origPost2;
  }
});

test('已吐出内容后的 401：不刷新、不重试（客户端不能看到两段回答）', async () => {
  seed([healthy(1, 'u1', '半途号', 'T1'), healthy(2, 'u2', '备用号', 'T2')]);

  let exchanges = 0;
  const origExchange = auth.exchange;
  auth.exchange = async () => {
    exchanges++;
    return { ok: true, patch: { accessToken: 'T1new', expiresAt: Date.now() + 60 * 86400000 } };
  };

  // 先吐一帧正文，然后抛一个带 sent 标记的 401（模拟 DSML/收尾阶段失败）
  const origConversation = chat.readStream;
  const origPost = chat.postStream;
  const origPost2 = chat.post;
  chat.postStream = async () => ({
    status: 200,
    stream: Readable.from(['data: {"choices":[{"delta":{"content":"先说了一句"}}]}\n\n']),
  });
  chat.post = chat.postStream;
  chat.readStream = async (stream, onEvent) => {
    // 直接驱动一次内容事件，然后以 errored 流结束——runConversation 会把
    // 「已发内容」路径的失败标 e.sent 后抛出（见其 leak 分支）
    onEvent({ event: 'output', data: { choices: [{ delta: { content: '先说了一句' } }] } });
    onEvent({ event: 'error', data: { error: { code: 401, message: 'mid-stream session expired' } } });
  };

  try {
    await trae.send(
      { model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: true },
      () => {},
      { region: 'cn' },
    ).catch(() => { /* 本条请求注定失败，断言看的是「有没有刷新/换号」 */ });
    assert.strictEqual(exchanges, 0, '已发内容的请求不应触发刷新（重试=客户端看到两段回答）');
  } finally {
    auth.exchange = origExchange;
    chat.readStream = origConversation;
    chat.postStream = origPost;
    chat.post = origPost2;
  }
});
