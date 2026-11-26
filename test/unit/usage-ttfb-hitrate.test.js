// test/unit/usage-ttfb-hitrate.test.js - 用量聚合补 TTFB 与命中率分母（P2-13）
//
// 两件事都属于「口径错了但不会报错」那一类，所以判据写死在这里：
//   1. TTFB 的**分母是「报了首字的请求」**，不是全部请求。老日志没有这个字段时
//      当 0ms 算会把均值拉低——那是最典型的假数字。无样本一律 null。
//   2. 命中率的**分母要剔掉缓存写入**：写入的 token 这一轮没被读过，算进分母等于
//      把「预热轮」当成「没命中」。分母为 0 → null（没样本 ≠ 全 miss）。
// 另外锁一条结构性约束：桶合并只有一处实现（mergeInto），折叠成日桶后
// TTFB 与写入不能凭空消失——漏了不会报错，只会「昨天有、今天没了」。
//
// 运行：node --test test/unit/usage-ttfb-hitrate.test.js
const assert = require('assert');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-usage-ttfb-'));
process.env.DUMATE_ADMIN_DATA = TMP;

const agg = require('../../src/usage-agg');
const reqlog = require('../../src/reqlog');

const base = { ts: Date.now(), channel: 'dumate', model: 'glm-5', status: 200, input_tokens: 1000, output_tokens: 100, ms: 500 };

test('histBucketOf：8 段边界（含最后一段无上界）', () => {
  assert.strictEqual(agg.histBucketOf(0), 0);
  assert.strictEqual(agg.histBucketOf(249), 0);
  assert.strictEqual(agg.histBucketOf(250), 1);
  assert.strictEqual(agg.histBucketOf(999), 2);
  assert.strictEqual(agg.histBucketOf(1000), 3);
  assert.strictEqual(agg.histBucketOf(30000), 7);
  assert.strictEqual(agg.histBucketOf(1e9), 7);
  assert.strictEqual(agg.histBucketOf(-1), -1, '负数不是样本');
  assert.strictEqual(agg.histBucketOf(NaN), -1);
});

test('percentileOf：空直方图是 null（不是 0），分段给 lo/hi，最后一段 hi=null', () => {
  assert.strictEqual(agg.percentileOf([], 0.5), null);
  assert.strictEqual(agg.percentileOf([0, 0, 0], 0.9), null);
  // 10 个样本全在 500~1000 段
  const h = [0, 0, 10, 0, 0, 0, 0, 0];
  assert.deepStrictEqual(agg.percentileOf(h, 0.5), { ms: 1000, lo: 500, hi: 1000 });
  assert.deepStrictEqual(agg.percentileOf(h, 0.9), { ms: 1000, lo: 500, hi: 1000 });
  // 跨段：4 个 <250 + 6 个 5~10s → p50 落在后面那段
  const h2 = [4, 0, 0, 0, 6, 0, 0, 0];
  const p50 = agg.percentileOf(h2, 0.5);
  assert.strictEqual(p50.lo, 2000);
  assert.strictEqual(p50.hi, 5000);
  // 最后一段（>30s）没有上界
  const h3 = [0, 0, 0, 0, 0, 0, 0, 3];
  const p90 = agg.percentileOf(h3, 0.9);
  assert.strictEqual(p90.hi, null);
  assert.strictEqual(p90.lo, 30000);
  // P95（A6）：同一条直方图，p95 >= p90（段上界单调），空样本仍是 null
  assert.strictEqual(agg.percentileOf([], 0.95), null);
  const p95 = agg.percentileOf(h2, 0.95);
  assert.deepStrictEqual(p95, { ms: 5000, lo: 2000, hi: 5000 });
});

test('hitRateOf：分母剔掉缓存写入；写入超过非缓存时钳零；全空是 null', () => {
  // 命中 800，非缓存输入 1200（其中 200 是写入）→ 分母 = 800 + 1000
  const r = agg.hitRateOf(800, 1200, 200, 1);
  assert.strictEqual(r.numerator, 800);
  assert.strictEqual(r.denominator, 1800);
  assert.strictEqual(r.fresh_tokens, 1000);
  assert.strictEqual(r.rate, 0.4444);
  // 写入比非缓存还多（上游数字不一致）：fresh 钳 0，分母只剩命中，不出现负分母
  const clamped = agg.hitRateOf(500, 100, 400, 1);
  assert.strictEqual(clamped.fresh_tokens, 0);
  assert.strictEqual(clamped.denominator, 500);
  assert.strictEqual(clamped.rate, 1);
  // 没有任何 token → 命中率是 null（没样本 ≠ 全 miss）
  const empty = agg.hitRateOf(0, 0, 0, 1);
  assert.strictEqual(empty.denominator, 0);
  assert.strictEqual(empty.rate, null);
  // 有写入但没有命中 → 0（这是真实的 0，不是缺失）
  const miss = agg.hitRateOf(0, 900, 300, 1);
  assert.strictEqual(miss.denominator, 600);
  assert.strictEqual(miss.rate, 0);
});

test('pickUsage：认出 cache_creation_input_tokens，并标 reported', () => {
  const a = reqlog.pickUsage({ input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 400, cache_creation_input_tokens: 250 });
  assert.strictEqual(a.cached, 400);
  assert.strictEqual(a.creation, 250);
  assert.strictEqual(a.creationReported, true);
  const b = reqlog.pickUsage({ prompt_tokens: 100, completion_tokens: 5 });
  assert.strictEqual(b.creation, 0);
  assert.strictEqual(b.creationReported, false, '没报写入 ≠ 写入 0');
  const c = reqlog.pickUsage({ input_tokens: 10, cache_creation_input_tokens: 0 });
  assert.strictEqual(c.creationReported, true, '报了 0 也算 reported');
});

test('桶聚合：TTFB 分母只数报了首字的请求；无样本三件套是 null', () => {
  const p = agg.create({ persist: false, flushMs: 0 });
  p.addEntry({ ...base, first_token_ms: 800 });
  p.addEntry({ ...base, first_token_ms: 1200 });
  p.addEntry({ ...base });                       // 没报首字：不进分母
  const t = p.snapshot({ hours: 24 }).totals;
  assert.strictEqual(t.requests, 3);
  assert.strictEqual(t.ttfb_samples, 2, '分母是报了首字的 2 条，不是 3 条');
  assert.strictEqual(t.ttfb_avg_ms, 1000);
  assert.strictEqual(t.ttfb_min_ms, 800);
  assert.strictEqual(t.ttfb_max_ms, 1200);
  assert.strictEqual(t.ttfb_slow, 0, '>3s 才算慢');
  assert.strictEqual(t.ttfb_p50.ms, 1000, '800/1200 都落在 500~1000 段');
  assert.deepStrictEqual(t.ttfb_p95, { ms: 2000, lo: 1000, hi: 2000 }, 'A6：p95 落最高样本所在段');
  p.dispose();

  const q = agg.create({ persist: false, flushMs: 0 });
  q.addEntry({ ...base });                       // 一条也没报
  const t2 = q.snapshot({ hours: 24 }).totals;
  assert.strictEqual(t2.ttfb_avg_ms, null, '无样本 → null，不是 0');
  assert.strictEqual(t2.ttfb_p90, null);
  assert.strictEqual(t2.ttfb_p95, null, 'A6：无样本 p95 也是 null');
  assert.strictEqual(t2.ttfb_samples, 0);
  q.dispose();
});

test('桶聚合：>3s 计数与命中率（分子分母都摊在行上）', () => {
  const p = agg.create({ persist: false, flushMs: 0 });
  p.addEntry({ ...base, first_token_ms: 5000 });
  p.addEntry({ ...base, first_token_ms: 100 });
  p.addEntry({ ...base, input_tokens: 2000, cached_tokens: 800, cached_reported: true, cache_creation_tokens: 200, cache_creation_reported: true });
  const t = p.snapshot({ hours: 24 }).totals;
  assert.strictEqual(t.ttfb_slow, 1);
  assert.strictEqual(t.cache_creation_tokens, 200);
  assert.strictEqual(t.cache_creation_reported, 1);
  // 命中 800；非缓存输入 = 1000+1000+1200（其中写入 200）→ 分母 800 + 3000
  assert.strictEqual(t.cache_hit.denominator, 3800);
  assert.strictEqual(t.cache_hit.numerator, 800);
  assert.strictEqual(t.cache_hit.fresh_tokens, 3000);
  assert.strictEqual(t.cache_hit.rate, 0.2105);
  p.dispose();
});

test('折叠成日桶后 TTFB 与缓存写入仍在（合并只有一处实现）', () => {
  const p = agg.create({ persist: false, flushMs: 0, hourlyKeepMs: 0 });
  const ts = Date.now() - 3600000 * 3;
  p.addEntry({ ...base, ts, first_token_ms: 900 });
  p.addEntry({ ...base, ts, first_token_ms: 4000 });
  p.addEntry({ ...base, ts, input_tokens: 1000, cached_tokens: 300, cached_reported: true, cache_creation_tokens: 100, cache_creation_reported: true });
  p.rollup();
  const t = p.snapshot({}).totals;
  assert.strictEqual(t.ttfb_samples, 2, '折叠后样本不能丢');
  assert.strictEqual(t.ttfb_max_ms, 4000);
  assert.strictEqual(t.ttfb_slow, 1);
  assert.strictEqual(t.cache_creation_tokens, 100, '折叠后写入也不能丢');
  assert.strictEqual(t.cache_hit.numerator, 300);
  p.dispose();
});

test('落盘→重启后字段不丢（normalizeBucket 是第三份字段清单，必须同进同退）', () => {
  // 2026-11-16 实测过的坑：addEntry 与 mergeInto 都加了新字段，但读盘用的
  // normalizeBucket 没加 → 种子数据写盘成功、管理端读回来 ttfb_samples 恒 0。
  // 这条用例走真实的写盘/读盘，不靠打桩。
  const p = agg.create({ dir: TMP, file: path.join(TMP, 'roundtrip.json'), flushMs: 0 });
  const ts = Date.now();
  p.addEntry({ ...base, ts, first_token_ms: 1500, input_tokens: 1000, cached_tokens: 200, cached_reported: true, cache_creation_tokens: 100, cache_creation_reported: true });
  p.flushNow();
  p.dispose();

  const q = agg.create({ dir: TMP, file: path.join(TMP, 'roundtrip.json'), flushMs: 0 });
  const t = q.snapshot({}).totals;
  assert.strictEqual(t.ttfb_samples, 1, '从磁盘读回后样本数不能变 0');
  assert.strictEqual(t.ttfb_avg_ms, 1500);
  assert.strictEqual(t.ttfb_p50.ms, 2000, '1500 落在 1~2s 段，上界 2000');
  assert.strictEqual(t.cache_creation_tokens, 100, '缓存写入也要读回来');
  assert.strictEqual(t.cache_creation_reported, 1);
  assert.strictEqual(t.cache_hit.numerator, 200);
  q.dispose();
});

test('没人上报缓存时命中率是 null（不是 0%）——「不上报」≠「全 miss」', () => {
  const p = agg.create({ persist: false, flushMs: 0 });
  // 这类通道（实测 qwenwork 的部分链路）只给 input/output，不给缓存字段
  p.addEntry({ ...base, input_tokens: 1000, cached_tokens: 0, cached_reported: false });
  const t = p.snapshot({ hours: 24 }).totals;
  assert.strictEqual(t.cache_reported, 0);
  assert.strictEqual(t.cache_hit.reported, 0);
  assert.strictEqual(t.cache_hit.rate, null, '不可知 → null');
  assert.ok(t.cache_hit.denominator > 0, '分母仍算出来，供人看「有多少 token」');
  p.dispose();

  // 报了缓存且为 0 → 这才是真实的 0%
  const q = agg.create({ persist: false, flushMs: 0 });
  q.addEntry({ ...base, input_tokens: 1000, cached_tokens: 0, cached_reported: true });
  const t2 = q.snapshot({ hours: 24 }).totals;
  assert.strictEqual(t2.cache_hit.rate, 0, '确认零缓存是真实的 0');
  assert.strictEqual(t2.cache_reported, 1);
  q.dispose();
});
