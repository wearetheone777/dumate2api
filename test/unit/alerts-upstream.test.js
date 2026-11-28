// test/unit/alerts-upstream.test.js - 批次七：上游劣化滑窗告警 + 模型目录改版监控
//
// 口径（misakano upstreamhealth.go / watchdog.go）：
//   upstream_degraded —— 5 分钟窗内「TTFB≥8s 占比≥30%」或「5xx 占比≥10%」
//     → 聚合一条 warn（不按通道拆：拆了就是 N 条告警的「狼来了」）。
//     TTFB 分母只数报了首字的请求（与 usage TTFB 分桶同一纪律）；
//     样本不足不判（同 error_rate 的 errorMinRequests 纪律）。
//   catalog_changed —— 目录指纹变化 → warn；首次建档（first）不告警；
//     拉取失败不进 facts，绝不把「拉不到」当成「改版了」。
//
// 运行：node --test test/unit/alerts-upstream.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

// 指纹落盘必须隔离：catalogWatch 读 DUMATE_ADMIN_DATA（调用时读，不缓存），
// 写真实数据目录会污染运行中网关的告警基线
process.env.DUMATE_ADMIN_DATA = path.join(os.tmpdir(), `dumate-alerts-up-${process.pid}`);

const alerts = require('../../src/admin/alerts');
const models = require('../../src/workbuddy/models');

const NOW = 1_000_000_000_000;
const MIN = 60000;

/** 一条请求日志行（ts 相对 NOW，单位分钟） */
const req = (minsAgo, { ttfb = null, status = 200 } = {}) => ({
  ts: NOW - minsAgo * MIN, status,
  first_token_ms: ttfb,
});

const T_ID = 'upstream_degraded:upstream';

test('规则清单包含两条新规则，默认阈值来自计划原文', () => {
  assert.ok(alerts.RULES.includes('upstream_degraded'));
  assert.ok(alerts.RULES.includes('catalog_changed'));
  const d = alerts.defaults();
  assert.strictEqual(d.upstreamWindowMs, 300000);
  assert.strictEqual(d.upstreamTtfbMs, 8000);
  assert.strictEqual(d.upstreamTtfbRatio, 0.3);
  assert.strictEqual(d.upstream5xxRatio, 0.1);
  assert.strictEqual(d.upstreamMinRequests, 3);
});

test('TTFB 占比越界 → 聚合一条 warn（30% 边界）', () => {
  // 3 条请求、1 条慢（33% ≥ 30%）→ 触发
  const facts = { requests: [req(1, { ttfb: 9000 }), req(2, { ttfb: 3000 }), req(3, { ttfb: 4000 })], accounts: [], taskFailStreak: 0 };
  const list = alerts.evaluate(facts, {}, NOW);
  const hit = list.find((a) => a.id === T_ID);
  assert.ok(hit, '应产生 upstream_degraded');
  assert.strictEqual(hit.level, 'warn');
  assert.match(hit.message, /TTFB≥8s 占 33%（1\/3）/);
  assert.match(hit.message, /只观测/);
});

test('5xx 占比越界 → 触发；两个维度都达标也只报一条', () => {
  // 4 条里 1 条 502（25% ≥ 10%）+ TTFB 全慢（100% ≥ 30%）→ 仍只一条
  const facts = {
    requests: [
      req(1, { ttfb: 20000, status: 502 }), req(2, { ttfb: 15000 }),
      req(3, { ttfb: 12000 }), req(4, { ttfb: 9000 }),
    ], accounts: [], taskFailStreak: 0,
  };
  const list = alerts.evaluate(facts, {}, NOW);
  const hits = list.filter((a) => a.rule === 'upstream_degraded');
  assert.strictEqual(hits.length, 1, '聚合一条，不按通道/维度拆');
  assert.match(hits[0].message, /5xx 占 25%（1\/4）/);
});

test('样本不足不判（少于 upstreamMinRequests）', () => {
  const facts = { requests: [req(1, { ttfb: 60000, status: 502 }), req(2, { ttfb: 60000 })], accounts: [], taskFailStreak: 0 };
  assert.ok(!alerts.evaluate(facts, {}, NOW).some((a) => a.id === T_ID), '2 条样本不判');
});

test('TTFB 分母只数报了首字的请求（未标记的行不稀释占比）', () => {
  // 1 条慢（有首字）+ 2 条没报首字：分母 1、占比 100% → 触发；
  // 若拿没标记的行当 0 稀释，占比只有 33% 也会触发——但若当「不慢的样本」
  // 稀释成 1/3，边界行为就错了。锁住「分母 = 有首字的行」。
  const facts = { requests: [req(1, { ttfb: 9000 }), req(2), req(2)], accounts: [], taskFailStreak: 0 };
  const hit = alerts.evaluate(facts, {}, NOW).find((a) => a.id === T_ID);
  assert.ok(hit, '分母 1/1 → 触发');
  assert.match(hit.message, /（1\/1）/, '分母不含未标记行');
});

test('全部正常 / 窗外旧数据 → 不告警', () => {
  const okFacts = { requests: [req(1, { ttfb: 2000 }), req(2, { ttfb: 3000 }), req(3, { ttfb: 1000 })], accounts: [], taskFailStreak: 0 };
  assert.ok(!alerts.evaluate(okFacts, {}, NOW).some((a) => a.id === T_ID));
  // 慢请求在 6 分钟前（窗外），窗内只有健康样本 → 不判
  const oldFacts = { requests: [req(6, { ttfb: 9000 }), req(1, { ttfb: 2000 }), req(2, { ttfb: 3000 })], accounts: [], taskFailStreak: 0 };
  assert.ok(!alerts.evaluate(oldFacts, {}, NOW).some((a) => a.id === T_ID), '5 分钟窗只看窗内');
});

// ---- 目录改版监控 ----

const FP_ID_RE = /^catalog_changed:workbuddy:(cn|global)$/;

test('catalogWatch：首次建档 first（不告警），同目录复看 changed=false', async () => {
  models._setCatalog('cn', ['glm-5.3', 'deepseek-v4.1-flash']);
  const w1 = await models.catalogWatch('cn');
  assert.strictEqual(w1.ok, true);
  assert.strictEqual(w1.first, true, '没有基线 → first');
  assert.strictEqual(w1.changed, false, '首次建档不算改版');
  assert.strictEqual(w1.models, 2);
  const w2 = await models.catalogWatch('cn');
  assert.strictEqual(w2.changed, false, '同一目录指纹稳定');
  assert.strictEqual(w2.first, false);
  assert.strictEqual(w2.sha, w1.sha, '同数据哈希一致（parseCatalog 行键序固定）');
});

test('catalogWatch：目录变化 → changed=true 并记录前后模型数', async () => {
  models._setCatalog('cn', ['glm-5.3', 'deepseek-v4.1-flash', 'kimi-k3']);
  const w = await models.catalogWatch('cn');
  assert.strictEqual(w.changed, true);
  assert.strictEqual(w.prevModels, 2, '上一份基线的模型数');
  assert.strictEqual(w.models, 3);
  // 变回旧目录：同样 changed（监控不判方向，变了就报）
  models._setCatalog('cn', ['glm-5.3', 'deepseek-v4.1-flash']);
  const back = await models.catalogWatch('cn');
  assert.strictEqual(back.changed, true, '变回去也是改版（指纹比对不看历史）');
});

test('catalogWatch：拉取失败如实 ok=false，不写指纹（「拉不到」≠「改版了」）', async () => {
  // 清掉缓存 → findUsable 在隔离数据目录里没有账号 → ok:false
  models._setCatalog('cn', null);
  const w = await models.catalogWatch('cn');
  assert.strictEqual(w.ok, false);
  assert.ok(w.error, '带原因');
  // 失败不产生 changed 事实：evaluate 收到空数组就不判
  assert.ok(!alerts.evaluate({ workbuddyCatalog: [], requests: [], accounts: [] }, {}, NOW)
    .some((a) => FP_ID_RE.test(a.id)));
});

test('catalog_changed 评估：changed 才 warn，first 不报', () => {
  const hit = alerts.evaluate({
    workbuddyCatalog: [{ ok: true, region: 'cn', changed: true, first: false, prevModels: 17, models: 16 }],
    requests: [], accounts: [],
  }, {}, NOW).find((a) => a.id === 'catalog_changed:workbuddy:cn');
  assert.ok(hit, 'changed → 告警');
  assert.strictEqual(hit.level, 'warn');
  assert.match(hit.message, /17 → 16 个模型/);
  assert.match(hit.message, /国内/);
  const intl = alerts.evaluate({
    workbuddyCatalog: [{ ok: true, region: 'global', changed: true, first: false, prevModels: 10, models: 12 }],
    requests: [], accounts: [],
  }, {}, NOW).find((a) => a.id === 'catalog_changed:workbuddy:global');
  assert.match(intl.message, /国际/);
  assert.ok(!alerts.evaluate({
    workbuddyCatalog: [{ ok: true, region: 'cn', changed: false, first: true, models: 17 }],
    requests: [], accounts: [],
  }, {}, NOW).some((a) => FP_ID_RE.test(a.id)), '首次建档不告警');
  assert.ok(!alerts.evaluate({ requests: [], accounts: [] }, {}, NOW).some((a) => FP_ID_RE.test(a.id)),
    '没有目录事实不判（监控不可用不拖挂）');
});

test('接线自证：facts() 真的采集目录指纹（防「模块写好、无调用方」）', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../../src/admin/routes/alerts.js'), 'utf8');
  assert.match(src, /models\.catalogWatch\(reg\)/, 'facts() 采集两区指纹');
  assert.match(src, /if \(w && w\.ok\) watches\.push\(w\)/, '拉取失败不进 facts');
  assert.match(src, /out\.workbuddyCatalog = watches/, '事实带 workbuddyCatalog 键');
  const alertsSrc = fs.readFileSync(require.resolve('../../src/admin/alerts.js'), 'utf8');
  assert.match(alertsSrc, /facts\.workbuddyCatalog \|\| \[\]/, 'evaluate 消费目录事实');
});
