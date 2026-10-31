// test/unit/qoder-clock.test.js - 时钟偏差检测（2026-11-01，对齐 hub issue #64）
//
// Date 头解析与阈值判定是纯函数离线验证；HTTP 部分只发无鉴权 HEAD、
// fail-open，不做网络断言（真机已在落地时实测：cn 1.2s / global 0.9s）。
const { test } = require('node:test');
const assert = require('node:assert');
const clock = require('../../src/qoder/clock');

test('skewFromHeader：RFC 7231 Date 头 → 偏差秒（服务端 − 本地）', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  assert.equal(clock.skewFromHeader('Sun, 01 Nov 2026 12:00:00 GMT', now), 0);
  assert.equal(clock.skewFromHeader('Sun, 01 Nov 2026 12:05:00 GMT', now), 300);
  assert.equal(clock.skewFromHeader('Sun, 01 Nov 2026 11:50:00 GMT', now), -600);
});

test('skewFromHeader：垃圾输入如实 null（不编 0）', () => {
  assert.equal(clock.skewFromHeader('', 0), null);
  assert.equal(clock.skewFromHeader('not a date', 0), null);
  assert.equal(clock.skewFromHeader(undefined, 0), null);
});

test('shouldWarn：|skew| > 120s 才报警；null 永远不报（fail-open）', () => {
  assert.equal(clock.shouldWarn(121), true);
  assert.equal(clock.shouldWarn(-121), true);
  assert.equal(clock.shouldWarn(120), false, '阈值内不报——120s 是上游接受的边界');
  assert.equal(clock.shouldWarn(1.2), false);
  assert.equal(clock.shouldWarn(null), false);
});

test('measureSkew：带缓存（第二次不再打网络）', async () => {
  const first = await clock.measureSkew('cn');
  assert.ok(first != null, '真机环境应能测出（HEAD 无鉴权）');
  const second = await clock.measureSkew('cn');
  assert.equal(second, first, '缓存窗口内返回同值');
  // 超标场景的标注（注入缓存：模块内 Map 不可直接塞，走 annotate401 的
  // 空值路径——没缓存/未超标时如实空串）
  assert.equal(clock.annotate401('cn'), '', '偏差在阈值内时不加话');
});

test('annotate401：未知区域回落 cn 缓存，测不出给空串', () => {
  assert.equal(clock.annotate401('no-such-region'), '');
});
