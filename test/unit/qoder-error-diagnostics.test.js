// test/unit/qoder-error-diagnostics.test.js - P1-3 请求诊断字段
//
// 口径：
//   1. thrownFrameErr 把上游业务码/请求 ID 放到 Error 属性，不拼进 message
//   2. 取不到请求 ID 留空，不拿本地 requestSetId 冒充
//   3. attempts.add 只多带两个标识字段，不记报文正文/凭证
//
// 运行：node --test test/unit/qoder-error-diagnostics.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const qoder = require('../../src/qoder/index');
const attempts = require('../../src/attempts');

const { thrownFrameErr } = (() => {
  // 通过行为验证导出：模块导出的 frameThrown/thrownFrameErr 需可见
  return qoder;
})();

test('frameThrown：鉴权码映射仍保留（回归锚）', () => {
  const e = thrownFrameErr({ code: 100401, message: 'auth failed' }, false);
  assert.equal(e.statusCode, 401);
  assert.match(e.message, /qoder auth biz\(100401\)/);
});

test('thrownFrameErr：业务码与请求 ID 单独带出', () => {
  const e = thrownFrameErr({ code: 115, message: 'no model', requestId: 'req-abc' }, false);
  assert.equal(e.upstreamCode, '115');
  assert.equal(e.upstreamRequestId, 'req-abc');
  assert.equal(e.statusCode, 400);
});

test('thrownFrameErr：取不到请求 ID 时留空', () => {
  const e = thrownFrameErr({ code: '10605', message: 'queued' }, true);
  assert.equal(e.upstreamCode, '10605');
  assert.equal(e.upstreamRequestId, undefined);
  assert.equal(e.sent, true);
});

test('thrownFrameErr：请求 ID 截断，不带入正文', () => {
  const e = thrownFrameErr({ code: 429, message: 'too many requests', request_id: 'x'.repeat(500) }, false);
  assert.equal(e.upstreamRequestId.length, 120);
  assert.ok(!e.message.includes('x'.repeat(121)));
});

test('attempts：诊断字段可选，不出现时保持旧形状', () => {
  const log = attempts.create({ t0: 1000, now: () => 1010 });
  log.add({ outcome: 'note', reason: 'plain' });
  const row = log.list()[0];
  assert.equal(row.upstreamCode, undefined);
  assert.equal(row.upstreamRequestId, undefined);
  assert.equal(row.reason, 'plain');
});

test('attempts：诊断字段只存标识，reason 仍截 120 字', () => {
  const log = attempts.create({ t0: 1000, now: () => 1010 });
  log.add({
    outcome: 'error', reason: 'x'.repeat(300),
    upstreamCode: '10605', upstreamRequestId: 'req-long', stage: 'throttle',
  });
  const row = log.list()[0];
  assert.equal(row.reason.length, 120);
  assert.equal(row.upstreamCode, '10605');
  assert.equal(row.upstreamRequestId, 'req-long');
  assert.equal(row.stage, 'throttle');
  assert.equal(JSON.stringify(row).includes('x'.repeat(121)), false);
});

test('attempts：stage 截断到 20 字，缺省不出字段', () => {
  const log = attempts.create({ t0: 1000, now: () => 1010 });
  log.add({ outcome: 'error', reason: 'r', stage: 's'.repeat(50) });
  assert.equal(log.list()[0].stage.length, 20);
  log.add({ outcome: 'note', reason: 'plain' });
  assert.equal(log.list()[1].stage, undefined);
});
