// test/unit/qoder-output-probe.test.js - 主动探测模型真实输出上限（P2-20）
//
// 调研出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P2-20。模型表里的
// max_output_tokens 是**声称值**、普遍虚高（实测 16 个模型 8 个被静默钳制，
// 最狠声称 1M 实际 32K）。
//
// 与 max-output.js 的分工（互补，别合并）：
//   被动  撞到 400 `Range of max_tokens should be [1, N]` 才学 → 第一次必然先失败
//   主动  显式运维动作，提前发现「声称 131072 实际 32K」
//
// 七条口径：
//   1. 判据**复用 workbuddy/output-probe.judgeStep**（两套阈值必然漂移）
//   2. 撞顶即 break（更高档只会得到同样的钳制，不再烧额度）
//   3. `finish=stop` 只能说明「没撞顶」，记 at_least 而不是 clamped
//   4. 上游 400 的显式范围声明是**最权威真值**：命中即判 clamped 并顺手学习
//   5. 阶梯按声称上限裁剪，但声称值只作参考下界
//   6. 结果落数据文件，**不写死在代码里**
//   7. `decorate`：无记录不标注（没测过 ≠ 没钳制）
//
// 运行：node --test test/unit/qoder-output-probe.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-qoder-probe');
process.env.DUMATE_ADMIN_DATA = TMP;

const probe = require('../../src/qoder/output-probe');

/** 打桩的 send：按 requested max_tokens 返回预设的 usage + finish */
function fakeSend(map) {
  return async (payload) => {
    const n = payload.max_tokens;
    const cell = map[n];
    if (!cell) throw new Error(`未预设 ${n}`);
    if (cell.throw) throw new Error(cell.throw);
    return {
      usage: { completion_tokens: cell.completion, total_tokens: cell.completion + 10 },
      choices: [{ finish_reason: cell.finish, message: { content: 'x' } }],
    };
  };
}

test('judgeStep：**上游不理 max_tokens** 时判 exceeded（真机形态：传 4096 回 24706）', () => {
  // 2026-11-08 真机实测：max_tokens=4096 → completion_tokens=24706、finish=stop
  assert.strictEqual(probe.judgeStep(4096, 24706, 'stop'), 'exceeded',
    'completion 远超请求值 → 它压根没看 max_tokens');
  // 略超 5% 也算（上游常按自己的量化单位取整）
  assert.strictEqual(probe.judgeStep(4096, 4400, 'stop'), 'exceeded');
  // 正常范围不受影响
  assert.strictEqual(probe.judgeStep(4096, 4000, 'stop'), 'below');
});

test('judgeStep：clamped / at_least / below / inconclusive 的边界（保留 workbuddy 语义）', () => {
  assert.strictEqual(probe.judgeStep(4096, 4096, 'length'), 'at_least', '追平');
  assert.strictEqual(probe.judgeStep(4096, 1000, 'length'), 'clamped', 'finish=length 但明显不足');
  assert.strictEqual(probe.judgeStep(4096, 500, 'stop'), 'below', '模型自己收尾');
  assert.strictEqual(probe.judgeStep(4096, 0, 'stop'), 'inconclusive');
  assert.strictEqual(probe.judgeStep(4096, null, 'stop'), 'inconclusive');
  assert.strictEqual(probe.judgeStep(4096, 100, 'weird'), 'inconclusive', '未知 finish 不猜');
  assert.strictEqual(probe.judgeStep(0, 100, 'stop'), 'inconclusive', '请求值非法');
});

test('probeOne：exceeded 第一档即停（它没被我们的值约束，再探只白烧几分钟）', async () => {
  const calls = [];
  const row = await probe.probeOne('qfmodel', {
    region: 'cn',
    send: async (p) => {
      calls.push(p.max_tokens);
      return { usage: { completion_tokens: 24706 }, choices: [{ finish_reason: 'stop' }] };
    },
  });
  assert.strictEqual(row.verdict, 'unbounded', '判为「没有可测的上限」');
  assert.deepStrictEqual(row.unbounded, { requested: 4096, completion: 24706 }, '要留证据（传了多少回来多少）');
  assert.deepStrictEqual(calls, [4096], '第一档就够，不该再探');
});

test('clamped：上游在到达请求值前就 finish=length 且明显不足 → 撞顶即 break', async () => {
  const calls = [];
  const row = await probe.probeOne('gfmodel', {
    region: 'cn',
    send: async (p) => {
      calls.push(p.max_tokens);
      return fakeSend({ 4096: { completion: 4096, finish: 'length' }, 16384: { completion: 8000, finish: 'length' } })(p);
    },
  });
  assert.strictEqual(row.verdict, 'clamped');
  assert.strictEqual(row.clamped, 8000);
  assert.deepStrictEqual(calls, [4096, 16384], '撞顶后不该再探更高档（不烧额度）');
  assert.strictEqual(row.steps.length, 2);
});

test('at_least：输出追平请求值 → 升阶继续；全部追平记最高档', async () => {
  const row = await probe.probeOne('qfmodel', {
    region: 'cn',
    send: fakeSend({
      4096: { completion: 4096, finish: 'length' },
      16384: { completion: 16384, finish: 'length' },
      32768: { completion: 32768, finish: 'length' },
      65536: { completion: 65536, finish: 'length' },
    }),
  });
  assert.strictEqual(row.verdict, 'at_least');
  assert.strictEqual(row.atLeast, 65536, '四档全追平 → 下界是最高档');
  assert.strictEqual(row.steps.length, 4);
});

test('finish=stop（模型主动收尾）记 at_least 而不是 clamped', () => {
  // 判据本身：stop 且 completion 远小于 requested
  assert.strictEqual(probe.judgeStep(4096, 500, 'stop'), 'below');
  // probeOne 把 below 折成 at_least（诚实的「没撞顶」口径）
  return probe.probeOne('gfmodel', {
    region: 'cn',
    send: fakeSend({ 4096: { completion: 500, finish: 'stop' }, 16384: { completion: 600, finish: 'stop' } }),
  }).then((row) => {
    assert.strictEqual(row.verdict, 'at_least', 'stop 不是钳制证据');
    assert.strictEqual(row.clamped, null);
  });
});

test('上游 400 显式范围声明：直接判 clamped 并顺手学习（省一次真实探测）', async () => {
  const row = await probe.probeOne('kmodel', {
    region: 'cn',
    send: async (p) => {
      if (p.max_tokens === 4096) return { usage: { completion_tokens: 4096 }, choices: [{ finish_reason: 'length' }] };
      throw new Error('400 Range of max_tokens should be [1, 16384]');
    },
  });
  assert.strictEqual(row.verdict, 'clamped');
  assert.strictEqual(row.clamped, 16384, '取上游声明的真值');
  assert.strictEqual(row.steps[row.steps.length - 1].verdict, 'declared');
  assert.strictEqual(row.steps[row.steps.length - 1].declared, 16384);
  // 顺手写进被动自学习缓存（之后出站自动 clamp，不再踩第二次）
  const learned = require('../../src/qoder/max-output').get('cn', 'kmodel');
  assert.strictEqual(learned, 16384, '要接上 max-output.learn');
});

test('单档失败（限流）不终止探测：继续下一档', async () => {
  const row = await probe.probeOne('dfmodel', {
    region: 'cn',
    send: fakeSend({
      4096: { throw: '10605 RESOURCE_LIMIT' },
      16384: { completion: 16384, finish: 'length' },
      32768: { completion: 20000, finish: 'length' },
    }),
  });
  assert.strictEqual(row.steps[0].verdict, 'inconclusive');
  assert.strictEqual(row.verdict, 'clamped');
  assert.strictEqual(row.clamped, 20000);
});

test('stepsFor：按声称上限裁剪，声称值只作参考下界', () => {
  assert.deepStrictEqual(probe.stepsFor(131072), [4096, 16384, 32768, 65536]);
  assert.deepStrictEqual(probe.stepsFor(16384), [4096, 16384], '声称 16K 就不探 32K');
  assert.deepStrictEqual(probe.stepsFor(null), [4096, 16384, 32768, 65536], '没声称按最大探');
  assert.deepStrictEqual(probe.stepsFor(1000), [4096], '声称比最低档还小 → 至少探最低档');
});

test('saveProbe / loadProbes：键 model|region，覆盖写，结果落数据文件', () => {
  const row = { model: 'gfmodel', region: 'cn', verdict: 'clamped', clamped: 32768, atLeast: null, ts: Date.now(), steps: [] };
  assert.strictEqual(probe.saveProbe(row), true);
  const doc = probe.loadProbes();
  assert.ok(doc['gfmodel|cn'], '键要是 model|region');
  assert.strictEqual(doc['gfmodel|cn'].clamped, 32768);
  // 覆盖：同键再写一次不重复
  probe.saveProbe({ ...row, clamped: 16000 });
  assert.strictEqual(probe.loadProbes()['gfmodel|cn'].clamped, 16000);
  assert.ok(fs.existsSync(probe.filePath()), '要真的落盘（可重跑刷新）');
});

test('isStale：30 天后视为陈旧（UI 褪色标注）', () => {
  const now = Date.now();
  assert.strictEqual(probe.isStale({ ts: now }), false);
  assert.strictEqual(probe.isStale({ ts: now - 31 * 86400000 }), true);
  assert.strictEqual(probe.isStale(null), true, '没有记录也算陈旧（UI 不显示数字）');
});

test('decorate：clamped 标「N ⚠ 钳制 X×」、unbounded 标「N ۞ 不受 max_tokens」、无记录不标注', () => {
  const now = Date.now();
  const probes = {
    'gfmodel|cn': { model: 'gfmodel', region: 'cn', verdict: 'clamped', clamped: 32768, modelMaxTokens: 131072, ts: now },
    'qfmodel|cn': { model: 'qfmodel', region: 'cn', verdict: 'at_least', atLeast: 65536, modelMaxTokens: 131072, ts: now },
    'kmodel|cn': { model: 'kmodel', region: 'cn', verdict: 'inconclusive', clamped: null, atLeast: null, ts: now },
    'dfmodel|cn': { model: 'dfmodel', region: 'cn', verdict: 'unbounded', unbounded: { requested: 4096, completion: 24706 }, ts: now },
  };
  const rows = probe.decorate([
    { key: 'gfmodel' }, { key: 'qfmodel' }, { key: 'kmodel' }, { key: 'dfmodel' }, { key: 'untested' },
  ], { region: 'cn', now, probes });
  assert.strictEqual(rows[0].probe.label, '32K ⚠ 钳制 4×');
  assert.strictEqual(rows[0].probe.ratio, 4);
  assert.strictEqual(rows[1].probe.label, '64K ✓');
  assert.strictEqual(rows[2].probe.label, '?', '测不出就标 ?，不猜');
  assert.strictEqual(rows[3].probe.label, '24K ۞ 不受 max_tokens（传 4K）',
    '不受 max_tokens 要给证据，否则读者会当成测错了');
  assert.strictEqual(rows[3].probe.actual, 24706, 'actual 给实际回吐量');
  assert.strictEqual(rows[4].probe, null, '没测过 ≠ 没钳制——不标注');
});

test('decorate：区域隔离（cn 的结论不套到 global）', () => {
  const probes = { 'gfmodel|cn': { model: 'gfmodel', region: 'cn', verdict: 'clamped', clamped: 1000, ts: Date.now() } };
  const cn = probe.decorate([{ key: 'gfmodel' }], { region: 'cn', probes })[0];
  const gl = probe.decorate([{ key: 'gfmodel' }], { region: 'global', probes })[0];
  assert.ok(cn.probe, 'cn 有结论');
  assert.strictEqual(gl.probe, null, 'global 没有该模型的结论');
});

test('触发式编排：start 立刻返回、同一时刻只允许一个、结果落盘并可供轮询', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const opts = {
    region: 'cn',
    send: async () => { await gate; return { usage: { completion_tokens: 24706 }, choices: [{ finish_reason: 'stop' }] }; },
  };
  const first = probe.start('gfmodel', opts);
  assert.strictEqual(first.started, true, 'start 要立刻返回（不 await 探测本体）');
  const st1 = probe.status();
  assert.strictEqual(st1.running, true);
  assert.strictEqual(st1.model, 'gfmodel');

  const second = probe.start('qfmodel', opts);
  assert.strictEqual(second.started, false, '同一时刻只允许一个（重额度动作）');
  assert.ok(/已在探测中/.test(second.reason));

  release();
  // 等编排收尾
  for (let i = 0; i < 50 && probe.status().running; i++) await new Promise((r) => setTimeout(r, 10));
  const st2 = probe.status();
  assert.strictEqual(st2.running, false);
  assert.ok(st2.finishedAt, '要有结束时刻');
  assert.strictEqual(st2.last.verdict, 'unbounded', '结论在 status.last 里可供轮询');
  // 落盘：GET /output-probes 读的就是它
  const doc = probe.loadProbes();
  assert.ok(doc['gfmodel|cn'], 'start 内部要 saveProbe');
});

test('fmtK：千级缩写按 1024（与上下游文档的 32K/64K 读法一致）', () => {
  assert.strictEqual(probe.fmtK(32768), '32K');
  assert.strictEqual(probe.fmtK(65536), '64K');
  assert.strictEqual(probe.fmtK(500), '500');
  assert.strictEqual(probe.fmtK(null), '?');
  assert.strictEqual(probe.fmtK(-1), '?');
});
