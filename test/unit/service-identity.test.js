// test/unit/service-identity.test.js - 进程身份（2026-11-07 融合项 P1-6）
//
// service 是品牌级判据（四进程相同），role 区分入口；stable 快照目录跑的
// gateway 额外带 -stable 后缀。DUMATE_ROLE 环境变量永远最高优先。
const { test } = require('node:test');
const assert = require('node:assert');
const si = require('../../src/service-identity');

test('identity：service 恒 dumate2api，role 按入口', () => {
  const prev = process.env.DUMATE_ROLE;
  delete process.env.DUMATE_ROLE;
  try {
    assert.deepEqual(si.identity('gateway'), { service: 'dumate2api', role: 'gateway' });
    assert.deepEqual(si.identity('admin'), { service: 'dumate2api', role: 'admin' });
    assert.deepEqual(si.identity('web-gateway'), { service: 'dumate2api', role: 'web-gateway' });
  } finally {
    if (prev !== undefined) process.env.DUMATE_ROLE = prev;
  }
});

test('identity：DUMATE_ROLE 覆盖一切（含 stable 判定）', () => {
  const prev = process.env.DUMATE_ROLE;
  process.env.DUMATE_ROLE = 'gateway-prod-9080';
  try {
    assert.equal(si.identity('gateway').role, 'gateway-prod-9080');
  } finally {
    if (prev === undefined) delete process.env.DUMATE_ROLE;
    else process.env.DUMATE_ROLE = prev;
  }
});

test('STABLE_DIR：本检出是开发目录（src/），不是 stable 快照', () => {
  assert.equal(si.STABLE_DIR, false, '测试跑在 src/ 下；stable/src/ 的副本自带 stable 路径判定');
});

test('identity：stable 路径判定规则本身正确（正则口径钉住）', () => {
  const RE = /[\\/]stable[\\/]/;
  assert.ok(RE.test('D:\\x\\dumate2api\\stable\\src'), 'Windows 反斜杠');
  assert.ok(RE.test('/x/dumate2api/stable/src'), 'POSIX 斜杠');
  assert.ok(!RE.test('D:\\x\\dumate2api\\src'), '开发目录不命中');
  assert.ok(!RE.test('D:\\x\\stable-not\\src'), '同名前缀不误命中');
});
