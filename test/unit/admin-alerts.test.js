// test/unit/admin-alerts.test.js - P1-6 Qoder 专属风控告警
//
// 口径：回看窗内 Qoder rejected >= N（默认 3）且没有 ok → warn；
// 只告警，不换号/熔断/暂停整区。没有 Qoder 侧连坐证据，照搬 WorkBuddy 会误杀。
// 复用 alerts.assess 的静默窗 / 迟滞 / 恢复，测试用 io 注入避免落盘。
//
// 运行：node --test test/unit/admin-alerts.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const alerts = require('../../src/admin/alerts');

const qoderFacts = (telemetry) => ({
  channels: { qoder: { telemetry } },
  accounts: [], requests: [], taskFailStreak: 0,
});

const ID = 'qoder_rejected:qoder';

function fakeIo() {
  let state = { active: {}, lastSent: {}, streaks: {} };
  return {
    load: () => state,
    save: (s) => { state = s; },
    get state() { return state; },
  };
}

test('规则清单包含 qoder_rejected，默认阈值 3', () => {
  assert.ok(alerts.RULES.includes('qoder_rejected'));
  assert.strictEqual(alerts.defaults().qoderRejectedMin, 3);
});

test('rejected 达到阈值且无成功 → warn', () => {
  const list = alerts.evaluate(qoderFacts({ rejected: 3, ok: 0 }), {}, 1000000);
  const hit = list.find((a) => a.id === ID);
  assert.ok(hit, '应产生 qoder_rejected');
  assert.strictEqual(hit.level, 'warn');
  assert.match(hit.message, /仅观测/);
});

test('样本不足不告警', () => {
  const list = alerts.evaluate(qoderFacts({ rejected: 2, ok: 0 }), {}, 1000000);
  assert.ok(!list.some((a) => a.id === ID));
});

test('有 1 条成功就不告警（通道是通的）', () => {
  const list = alerts.evaluate(qoderFacts({ rejected: 20, ok: 1 }), {}, 1000000);
  assert.ok(!list.some((a) => a.id === ID));
});

test('缺少遥测数据不告警（未知不猜）', () => {
  assert.ok(!alerts.evaluate({ channels: { qoder: {} } }, {}, 1000000).some((a) => a.id === ID));
  assert.ok(!alerts.evaluate({ channels: {} }, {}, 1000000).some((a) => a.id === ID));
  assert.ok(!alerts.evaluate(qoderFacts({ rejected: null, ok: 0 }), {}, 1000000).some((a) => a.id === ID));
});

test('assess：迟滞满足才推送，静默窗内不重复推送', () => {
  const io = fakeIo();
  const cfg = { hysteresis: 2, silenceMs: 3600000 };
  const first = alerts.assess(qoderFacts({ rejected: 4, ok: 0 }), { config: cfg, now: 1000000, io });
  assert.strictEqual(first.notify.length, 0, '第一轮只攒迟滞');
  const second = alerts.assess(qoderFacts({ rejected: 4, ok: 0 }), { config: cfg, now: 1060000, io });
  assert.strictEqual(second.notify.length, 1, '第二轮推送');
  const third = alerts.assess(qoderFacts({ rejected: 4, ok: 0 }), { config: cfg, now: 1070000, io });
  assert.strictEqual(third.notify.length, 0, '静默窗内不重复');
  assert.strictEqual(third.actionable.length, 1, 'active 里仍保留');
});

test('assess：恢复也要连续 N 轮正常，不因一次抖动反复报恢复', () => {
  const io = fakeIo();
  const cfg = { hysteresis: 2, silenceMs: 0 };
  alerts.assess(qoderFacts({ rejected: 4, ok: 0 }), { config: cfg, now: 1000000, io });
  alerts.assess(qoderFacts({ rejected: 4, ok: 0 }), { config: cfg, now: 1060000, io });
  const cleared1 = alerts.assess(qoderFacts({ rejected: 0, ok: 3 }), { config: cfg, now: 1070000, io });
  assert.strictEqual(cleared1.resolved.length, 0, '第一轮正常不报恢复');
  const cleared2 = alerts.assess(qoderFacts({ rejected: 0, ok: 3 }), { config: cfg, now: 1080000, io });
  assert.strictEqual(cleared2.resolved.length, 1);
  assert.strictEqual(cleared2.resolved[0].rule, 'qoder_rejected');
});
