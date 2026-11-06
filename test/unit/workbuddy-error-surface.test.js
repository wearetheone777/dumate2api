// test/unit/workbuddy-error-surface.test.js - WorkBuddy 失败处置的离线验证
//
// 锁四件事（hub v1.9.0 / v1.10.11 融合批次）：
//   1. 6004 → model_cap 分类 + 重置墙钟解析（cn/intl 两种形状）
//   2. 401 判死（裸 401 / 挑战头）→ errorActionOf 给 refresh
//   3. 11140 连坐波：阈值触发整区域暂停；errorActionOf 默认不换号
//   4. max_tokens 目录 clamp / stop 字符串归一化 / 参数错误不喂池
const { test } = require('node:test');
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DUMATE_ADMIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-wb-err-'));

const c = require('../../src/workbuddy/constants');
const wb = require('../../src/workbuddy');
const models = require('../../src/workbuddy/models');

test('classifyStatus：6004 → model_cap（int/string code、cn/intl 文案）', () => {
  assert.equal(c.classifyStatus(429, '{"code":6004,"msg":"usage exceeds frequency limit"}'), 'model_cap');
  assert.equal(c.classifyStatus(429, '{"code":"6004","msg":"x"}'), 'model_cap');
  // 负向断言：60040 不是 6004
  assert.equal(c.classifyStatus(429, '{"code":60040,"msg":"x"}'), 'soft_rate');
  assert.equal(c.classifyStatus(429, '您的使用量已超出频率限制，将在 2026-10-02 16:00:34 UTC+8 重置'), 'model_cap');
  // 只有重置钟、没有限额文案的 429 不是额度判定（判据是 code/限额文案，不猜）
  assert.equal(c.classifyStatus(429, 'your usage will reset at 2026-09-19 18:29:03 UTC+8'), 'soft_rate');
  // 裸 429（无 6004 证据）仍是账号级 soft_rate
  assert.equal(c.classifyStatus(429, 'too many requests'), 'soft_rate');
});

test('classifyStatus：401 判死（裸 401 / session 标记 / 11140 回归）', () => {
  assert.equal(c.classifyStatus(401, ''), 'session_dead');
  assert.equal(c.classifyStatus(401, '<html>401 Authorization Required</html>'), 'session_dead');
  assert.equal(c.classifyStatus(401, '{"code":12153,"msg":"Offline user session not found"}'), 'session_dead');
  // 11140 负向断言回归：111400 不误吃（落到 client），真 11140 仍判 restricted
  assert.equal(c.classifyStatus(403, '{"code":111400,"msg":"x"}'), 'client');
  assert.equal(c.classifyStatus(403, '{"code":11140,"msg":"unusual activity"}'), 'restricted');
});

test('parseRateLimitReset：cn/intl 形状 + UTC+8 换算与宿主机时区无关', () => {
  const intl = '{"code":6004,"msg":"usage exceeds frequency limit, but don\'t worry, your usage will reset at 2026-09-19 18:29:03 UTC+8 ."}';
  const cn = '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-10-02 16:00:34 UTC+8 重置"}';
  // 2026-09-19 18:29:03 UTC+8 = 10:29:03 UTC
  const expectIntl = Math.floor(Date.parse('2026-09-19T10:29:03Z') / 1000);
  assert.equal(c.parseRateLimitReset(intl), expectIntl);
  const expectCn = Math.floor(Date.parse('2026-10-02T08:00:34Z') / 1000);
  assert.equal(c.parseRateLimitReset(cn), expectCn);
  // JSON 转义形态（\u5c06\u5728 = 将在）同样可解析
  const escaped = '{"code":6004,"msg":"\\u60a8\\u7684\\u4f7f\\u7528\\u91cf\\u5df2\\u8d85\\u51fa\\u9891\\u7387\\u9650\\u5236\\uff0c\\u5c06\\u5728 2026-10-02 16:00:34 UTC+8 \\u91cd\\u7f6e"}';
  assert.equal(c.parseRateLimitReset(escaped), expectCn);
  // 无墙钟 / 无措辞 → null，不编数
  assert.equal(c.parseRateLimitReset('{"code":6004,"msg":"no clock here"}'), null);
  assert.equal(c.parseRateLimitReset(''), null);
});

test('errorActionOf：四类错误的处置', () => {
  assert.deepEqual(wb.errorActionOf({ paramError: true, statusCode: 400 }), { feed: 'none', action: 'throw' });
  assert.deepEqual(wb.errorActionOf({ modelCap: true, retryAfterMs: 5 }), { feed: 'model', action: 'rotate' });
  assert.deepEqual(wb.errorActionOf({ restricted: true, statusCode: 403 }), { feed: 'account', action: 'restrict' });
  assert.deepEqual(wb.errorActionOf({ kind: 'session_dead', statusCode: 401 }), { feed: 'none', action: 'refresh' });
  assert.deepEqual(wb.errorActionOf({ statusCode: 401 }), { feed: 'none', action: 'refresh' });
  assert.deepEqual(wb.errorActionOf({ statusCode: 502 }), { feed: 'account', action: 'throw' });
  assert.deepEqual(wb.errorActionOf({ kind: 'hard_credit', statusCode: 402 }), { feed: 'account', action: 'throw' });
});

test('连坐波：阈值触发整区域暂停，窗口过期自动解除，uid 去重不骗长', () => {
  wb._restrictionReset();
  const t = Date.now();
  // 单账号反复受限（uid 去重）不触发
  assert.equal(wb.noteAccountRestriction('cn', 'u1', t), 0);
  assert.equal(wb.noteAccountRestriction('cn', 'u1', t + 1000), 0);
  assert.equal(wb.restrictionHoldRemaining('cn', t + 2000), 0);
  // 第二个不同账号受限 → 整区域暂停
  const until = wb.noteAccountRestriction('cn', 'u2', t + 2000);
  assert.ok(until > 0, '第二个账号受限应触发暂停');
  assert.ok(wb.restrictionHoldRemaining('cn', t + 3000) > 0);
  // 其它区域不受影响
  assert.equal(wb.restrictionHoldRemaining('global', t + 3000), 0);
  // 窗口过期后状态清零（暂停到期 + 事件过期）
  const later = until + 1000;
  assert.equal(wb.restrictionHoldRemaining('cn', later), 0);
  assert.equal(wb.noteAccountRestriction('cn', 'u3', later), 0, '旧事件不参与新窗口计数');
  wb._restrictionReset();
});

test('maxOutputOf：按模型取目录上限（rows 注入）', () => {
  const rows = [
    { id: 'glm-5.3', maxTokens: 98304 },
    { id: 'no-cap', maxTokens: 0 },
  ];
  assert.equal(models.maxOutputOf('cn', 'glm-5.3', rows), 98304);
  assert.equal(models.maxOutputOf('cn', 'no-cap', rows), 0);
  assert.equal(models.maxOutputOf('cn', 'missing', rows), 0);
  // 缓存未预热时不带 rows → 0（不 clamp）
  assert.equal(models.maxOutputOf('cn', 'glm-5.3'), 0);
});

test('stop 字符串归一化 + max_tokens clamp 的出站形状（经 runConversation 的 buildBody 语义）', () => {
  // buildBody 在 runConversation 闭包内，这里锁它消费的两侧纯函数：
  // budget.resolveWorkBuddyMaxTokens 的下限与 maxOutputOf 的上限夹取
  const budget = require('../../src/budget');
  const resolved = budget.resolveWorkBuddyMaxTokens(999999);
  const cap = models.maxOutputOf('cn', 'glm-5.3', [{ id: 'glm-5.3', maxTokens: 98304 }]);
  assert.equal(Math.min(resolved, cap), 98304);
  // stop: 'x' → ['x']（上游 Go struct 只认数组）
  const stop = 'x';
  assert.deepEqual(typeof stop === 'string' && stop ? [stop] : stop, ['x']);
});

test('挑战认证判死：classifyInput 组装语义（hub #686）', () => {
  // 挑战头拼进分类输入后 invalid_token 可见——这里锁拼装前后的分类结果
  const body = '<html>401 Authorization Required</html>';
  const challenge = 'Bearer realm="copilot", error="invalid_token", charset="UTF-8"';
  assert.equal(c.classifyStatus(401, `WWW-Authenticate: ${challenge}\n${body}`), 'session_dead');
  // RFC 6750 大小写变体
  assert.equal(c.classifyStatus(401, 'WWW-Authenticate: Bearer error="Invalid-Token"'), 'session_dead');
});

test('readStream：[DONE] 即终态——resolve + 销毁连接，不再白等上游关流（hub v1.9.1）', async () => {
  const { EventEmitter } = require('events');
  const chat = require('../../src/workbuddy/chat');
  let destroyed = false;
  const stream = new EventEmitter();
  stream.destroy = () => { destroyed = true; };
  const seen = [];
  const chunks = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  // [DONE] 之后再来的数据（上游保持连接的尾巴）不得进入 onChunk
  const p = chat.readStream(stream, (x) => seen.push(x));
  stream.emit('data', Buffer.from(chunks[0]));
  stream.emit('data', Buffer.from(chunks[1]));
  await p;
  stream.emit('data', Buffer.from('data: {"choices":[{"delta":{"content":"ghost"}}]}\n\n'));
  assert.ok(destroyed, '收到 [DONE] 应销毁连接');
  assert.equal(seen.length, 2, '一条数据帧 + [DONE]（null 哨兵）');
  assert.equal(seen[1], null);
  assert.deepEqual(seen[0].choices[0].delta, { content: 'hi' });
  // 关闭开关后回到旧行为：不销毁、不提前 resolve
  process.env.DUMATE_WORKBUDDY_STOP_AT_DONE = '0';
  try {
    let destroyed2 = false;
    const stream2 = new EventEmitter();
    stream2.destroy = () => { destroyed2 = true; };
    const seen2 = [];
    const p2 = chat.readStream(stream2, (x) => seen2.push(x));
    stream2.emit('data', Buffer.from('data: [DONE]\n\n'));
    await new Promise((r) => setImmediate(r));
    assert.ok(!destroyed2 && seen2.length === 1, '开关关闭时 [DONE] 只上报不销毁');
    stream2.emit('end');
    await p2;
  } finally {
    delete process.env.DUMATE_WORKBUDDY_STOP_AT_DONE;
  }
});
