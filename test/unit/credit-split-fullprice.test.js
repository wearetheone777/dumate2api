// test/unit/credit-split-fullprice.test.js - 积分三段拆分 + 全价请求统计
//
// hub v1.7.21/22 融合（2026-11-04）：
//   - reqlog.pickUsage 提取缓存命中与 cached_reported（区分「确认零命中」
//     与「上游没回报」）；
//   - credit-split 三段折算（只适用 Qoder，系数可覆盖）；
//   - usage-agg 全价请求（prompt ≥ 阈值且确认零缓存且成功，行级判定入桶）。
// 运行：node --test test/unit/credit-split-fullprice.test.js
const assert = require('assert');
const { test } = require('node:test');
const reqlog = require('../../src/reqlog');
const split = require('../../src/credit-split');
const usageAgg = require('../../src/usage-agg');

test('pickUsage：四种上游缓存形状 + 散装位', () => {
  assert.deepStrictEqual(
    [reqlog.pickUsage({ prompt_tokens: 3000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 2816 } }).cached,
      reqlog.pickUsage({ prompt_tokens: 3000, completion_tokens: 100, prompt_cache_hit_tokens: 1024 }).cached,
      reqlog.pickUsage({ prompt_tokens: 3000, completion_tokens: 100, completion_tokens_details: { cached_tokens: 7 } }).cached,
      reqlog.pickUsage({ input_tokens: 201, output_tokens: 117, cache_read_input_tokens: 2816 }).cached,
      reqlog.pickUsage({ prompt_tokens: 10, completion_tokens: 1, cached_tokens: 5 }).cached],
    [2816, 1024, 7, 2816, 5]);
});

test('pickUsage：reported 区分「真零命中」与「没回报」', () => {
  const zero = reqlog.pickUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } });
  assert.strictEqual(zero.cached, 0);
  assert.strictEqual(zero.cachedReported, true, '报了 0 也是 reported（确认零命中）');
  const missing = reqlog.pickUsage({ prompt_tokens: 10, completion_tokens: 1 });
  assert.strictEqual(missing.cached, 0);
  assert.strictEqual(missing.cachedReported, false, '没回报不是零命中（全价统计不认）');
  const none = reqlog.pickUsage(null);
  assert.strictEqual(none.cachedReported, false);
});

test('splitOf：Qoder 三段折算（默认系数）', () => {
  const s = split.splitOf({
    channel: 'qoder',
    input_tokens: 100000, output_tokens: 2000,
    cached_tokens: 90000, cached_reported: true,
  });
  // 非缓存输入 10K × 1.069 + 缓存 90K × 0.086 + 输出 2K × 4.277
  assert.strictEqual(s.input, 10.69);
  assert.strictEqual(s.cached, 7.74);
  assert.strictEqual(s.output, 8.554);
  assert.strictEqual(s.sum, 26.984);
  assert.deepStrictEqual(s.tokens, { noncached_input: 10000, cached: 90000, output: 2000 });
});

test('splitOf：缓存未回报时 cached/sum 为 null（不编 0）', () => {
  const s = split.splitOf({ channel: 'qoder', input_tokens: 1000, output_tokens: 100, cached_tokens: 0, cached_reported: false });
  assert.strictEqual(s.cached, null);
  assert.strictEqual(s.sum, null);
  assert.strictEqual(s.input, 1.069);
});

test('splitOf：非 Qoder / 无 token → null；系数 env 覆盖与非法回落', () => {
  assert.strictEqual(split.splitOf({ channel: 'traework', input_tokens: 1000, output_tokens: 1 }), null);
  assert.strictEqual(split.splitOf({ channel: 'qoder', input_tokens: 0, output_tokens: 0 }), null);
  process.env.DUMATE_QODER_CREDIT_COEF = '2, 0.1, 3';
  assert.deepStrictEqual(split.coefsOf(), [2, 0.1, 3]);
  const s = split.splitOf({ channel: 'qoder', input_tokens: 1000, output_tokens: 0, cached_tokens: 0, cached_reported: true });
  assert.strictEqual(s.input, 2);
  process.env.DUMATE_QODER_CREDIT_COEF = 'bad,data';
  assert.deepStrictEqual(split.coefsOf(), split.DEFAULT_COEFS, '非法系数整体回落');
  delete process.env.DUMATE_QODER_CREDIT_COEF;
});

test('usage-agg：缓存三段入桶 + finish 输出', () => {
  const agg = usageAgg.create({ persist: false, now: () => 1730000000000 });
  agg.addEntry({ ts: 1730000000000, channel: 'qoder', model: 'qfmodel', status: 200, input_tokens: 1000, output_tokens: 100, total_tokens: 1100, cached_tokens: 400, cached_reported: true });
  const snap = agg.snapshot();
  assert.strictEqual(snap.totals.input_tokens, 1000);
  assert.strictEqual(snap.totals.input_noncached_tokens, 600);
  assert.strictEqual(snap.totals.cached_tokens, 400);
});

test('usage-agg：全价请求 = prompt≥阈值 且 确认零缓存 且 成功', () => {
  const agg = usageAgg.create({ persist: false, fullPriceMin: 1000, now: () => 1730000000000 });
  agg.addEntry({ ts: 1730000000000, channel: 'qoder', model: 'm', status: 200, input_tokens: 1200, output_tokens: 10, cached_tokens: 0, cached_reported: true });
  agg.addEntry({ ts: 1730000000000, channel: 'qoder', model: 'm', status: 200, input_tokens: 1200, output_tokens: 10, cached_tokens: 0, cached_reported: false }); // 没回报
  agg.addEntry({ ts: 1730000000000, channel: 'qoder', model: 'm', status: 200, input_tokens: 1200, output_tokens: 10, cached_tokens: 800, cached_reported: true }); // 有缓存
  agg.addEntry({ ts: 1730000000000, channel: 'qoder', model: 'm', status: 502, input_tokens: 1200, output_tokens: 0, cached_tokens: 0, cached_reported: true }); // 失败
  agg.addEntry({ ts: 1730000000000, channel: 'qoder', model: 'm', status: 200, input_tokens: 900, output_tokens: 10, cached_tokens: 0, cached_reported: true }); // 低于阈值
  const snap = agg.snapshot();
  assert.strictEqual(snap.full_price.requests, 1, '只有第一条满足全价口径');
  assert.strictEqual(snap.full_price.prompt_tokens, 1200);
  assert.strictEqual(snap.full_price.threshold, 1000);
  assert.strictEqual(snap.full_price.prompt_share, Number((1200 / (1200 * 4 + 900)).toFixed(4)));
});

test('usage-agg：多桶 rollup 不丢三段字段', () => {
  const t0 = 1730000000000;
  const agg = usageAgg.create({ persist: false, hourlyKeepMs: 1, now: () => t0 });
  agg.addEntry({ ts: t0 - 86400000 * 2, channel: 'qoder', model: 'm', status: 200, input_tokens: 100, output_tokens: 5, cached_tokens: 0, cached_reported: true });
  agg.rollup(t0); // 两天前的小时桶折叠成日桶
  agg.addEntry({ ts: t0, channel: 'qoder', model: 'm', status: 200, input_tokens: 100, output_tokens: 5, cached_tokens: 0, cached_reported: true });
  const snap = agg.snapshot();
  assert.strictEqual(snap.totals.input_noncached_tokens, 200);
  assert.strictEqual(snap.totals.cached_tokens, 0);
});
