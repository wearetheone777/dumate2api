// test/unit/qoder-credit-floor.test.js - P1-2 账号权重与低积分阈值降级
//
// 口径：
//   1. Qoder 专属 creditFloor（面板 > env > 0），允许小数；其它通道不受影响
//   2. 低于保底线的账号不进候选（按次覆盖，面板热改下一次选号即生效）
//   3. 全部账号都低于保底时：如实按余额最高者继续，不报「没有账号」
//
// 运行：node --test test/unit/qoder-credit-floor.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-qoder-floor');
process.env.DUMATE_ADMIN_DATA = TMP;
process.env.DUMATE_POOL_STATE = path.join(TMP, 'pool-state.json');
process.env.DUMATE_POOL_PICK_GAP_MS = '0';
delete process.env.DUMATE_QODER_CREDIT_FLOOR;

const runtime = require('../../src/qoder/runtime');
const channelPool = require('../../src/channel-pool');
const { pool } = require('../../src/pool');

const A = (id) => ({ id, uid: `uid-${id}`, nickname: `号${id}`, region: 'cn', enabled: true });

test.after(() => { delete process.env.DUMATE_QODER_CREDIT_FLOOR; });

test('运行期配置：FIELDS / SUBFIELDS / defaults 三处一致，且允许小数', () => {
  assert.ok(runtime.FIELDS.includes('concurrency'));
  assert.ok(runtime.SUBFIELDS.concurrency.includes('creditFloor'));
  assert.equal(runtime.defaults().concurrency.creditFloor, 0, '默认关，不改变既有行为');
  const s = runtime.sanitize({ concurrency: { creditFloor: 0.5 } }, { strict: true });
  assert.equal(s.concurrency.creditFloor, 0.5);
  assert.throws(() => runtime.sanitize({ concurrency: { creditFloor: -1 } }, { strict: true }), /creditFloor/);
});

test('creditFloorOf 只对 qoder 生效', () => {
  runtime.Store({ concurrency: { creditFloor: 10 } });
  assert.equal(channelPool.creditFloorOf('qoder'), 10);
  assert.equal(channelPool.creditFloorOf('traework'), 0);
  runtime.Store({ concurrency: { creditFloor: 0 } });
});

test('低积分账号被排除；余额未知（null）不拦（null 不等于 0）', () => {
  const a = A(7901);   // 余额 5
  const b = A(7902);   // 余额 0.1
  channelPool.noteCredits('qoder', a.id, 5);
  channelPool.noteCredits('qoder', b.id, 0.1);
  runtime.Store({ concurrency: { creditFloor: 3 } });

  const picked = new Set();
  for (let i = 0; i < 20; i++) {
    channelPool.release(channelPool.pickCandidate('qoder', [a, b], { model: 'gfmodel' }).uid);
    picked.add(i);
  }
  // pool.status 的 floor_blocked 是池创建时的全局阈值（环境可能配了别的值）。
  // P1-2 验证的是通道级按次覆盖的判据，直接查纯函数。
  assert.equal(require('../../src/pool').createPool().internals.floorBlockedFor({ credits: 5 }, 3), false);
  assert.equal(require('../../src/pool').createPool().internals.floorBlockedFor({ credits: 0.1 }, 3), true);

  // 多次选号不会落到低余额账号（在途释放干净）
  for (let i = 0; i < 20; i++) {
    const sel = channelPool.pickCandidate('qoder', [a, b], { model: 'gfmodel' });
    assert.equal(sel.account.id, a.id);
    channelPool.release(sel.uid);
  }
  runtime.Store({ concurrency: { creditFloor: 0 } });
});

test('全部低于保底：按余额最高者继续派发，不报没有账号', () => {
  const a = A(7911);   // 0.2
  const b = A(7912);   // 0.8
  channelPool.noteCredits('qoder', a.id, 0.2);
  channelPool.noteCredits('qoder', b.id, 0.8);
  runtime.Store({ concurrency: { creditFloor: 3 } });
  const warns = [];
  const orig = console.warn;
  console.warn = (x) => { warns.push(String(x)); };
  try {
    const best = channelPool.fallbackLowestFloor('qoder', [a, b]);
    assert.equal(best.id, b.id);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /低于保底线/);
  } finally { console.warn = orig; runtime.Store({ concurrency: { creditFloor: 0 } }); }
});

test('接线：pickCandidate 在「全部低于保底」时兜底派发（不再返回 null）', () => {
  const a = A(7921);   // 0.2
  const b = A(7922);   // 0.8
  channelPool.noteCredits('qoder', a.id, 0.2);
  channelPool.noteCredits('qoder', b.id, 0.8);
  runtime.Store({ concurrency: { creditFloor: 3 } });
  const orig = console.warn;
  console.warn = () => { /* 静音兜底 WARN */ };
  try {
    const sel = channelPool.pickCandidate('qoder', [a, b], { model: 'gfmodel' });
    assert.ok(sel, '不该返回 null——那不是「没有账号」');
    assert.equal(sel.account.id, b.id, '按余额最高者派发');
    channelPool.release(sel.uid);
  } finally { console.warn = orig; runtime.Store({ concurrency: { creditFloor: 0 } }); }
});

test('兜底不越权：有账号在冷却时返回 null（保底不是唯一拦截原因）', () => {
  const a = A(7931);
  const b = A(7932);
  channelPool.noteCredits('qoder', a.id, 0.5);
  channelPool.noteCredits('qoder', b.id, 0.5);
  runtime.Store({ concurrency: { creditFloor: 3 } });
  const orig = console.warn;
  console.warn = () => { /* 静音 */ };
  try {
    // b 进冷却（池里真实发生的事：429 限流）。**必须给 status/message**——
    // channel-pool.noteError 会走 upstream-errors.classify 重新分类，
    // 只传 {kind:'soft'} 会被它按「status 0 无文案」判成 breaker。
    channelPool.noteError('qoder', b.id, { status: 429, message: 'rate limited', retryAfterMs: 30000 });
    const sel = channelPool.pickCandidate('qoder', [a, b], { model: 'gfmodel' });
    assert.equal(sel, null, '有账号在冷却时兜底不可越权——让客户端重试');
    channelPool.noteSuccess('qoder', b.id);
    require('../../src/pool').pool.setCredits(channelPool.uidOf('qoder', b.id), 5);
  } finally { console.warn = orig; runtime.Store({ concurrency: { creditFloor: 0 } }); }
});

test('池纯函数：floor 可覆盖，null 余额不拦', () => {
  const custom = require('../../src/pool').createPool({ creditFloor: 0 });
  assert.equal(custom.internals.floorBlockedFor({ credits: 0.5 }, 1), true);
  assert.equal(custom.internals.floorBlockedFor({ credits: 0.5 }, 0), false);
  assert.equal(custom.internals.floorBlockedFor({ credits: null }, 1), false);
  assert.equal(custom.internals.floorBlockedFor({ credits: 1 }, 1), false);
  custom.close();
});
