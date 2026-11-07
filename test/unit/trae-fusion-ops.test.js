// test/unit/trae-fusion-ops.test.js - 批量运维 / 日志脱敏 / 告警 / 账单 / 指标 / 配置恢复
//
// 全部离线：注入临时数据目录与内存 io，不打上游、不写真实 data/。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-trae-ops-'));
process.env.DUMATE_ADMIN_DATA = tmp;

const batch = require('../../src/traework/batch');
const logbuffer = require('../../src/admin/logbuffer');
const alerts = require('../../src/admin/alerts');
const monthly = require('../../src/admin/routes/monthly-billing');
const metrics = require('../../src/admin/routes/metrics');
const restore = require('../../src/config-restore');

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结果 */ }
});

test('批量运维：ids 去重、上限 200、非法 action 不执行', async () => {
  assert.deepStrictEqual(batch.normalizeIds([1, 1, '2', null, 0]), { ok: true, ids: [1, 2] });
  assert.strictEqual(batch.normalizeIds([]).ok, false);
  assert.strictEqual(batch.normalizeIds(Array.from({ length: 201 }, (_, i) => i + 1)).ok, false);
  const bad = await batch.runBatch({ ids: [1], action: 'destroy', io: {} });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /action 只能是/);
});

test('批量运维：逐条隔离、恢复默认保留上游冷却、导出不泄漏 token', async () => {
  const patched = [];
  const revived = [];
  const out = await batch.runBatch({
    ids: [1, 2, 3], action: 'resume', options: {},
    io: {
      get: (id) => id === 3 ? null : { id, uid: `u${id}`, nickname: `n${id}`, enabled: false, refreshToken: 'SECRET', accessToken: 'SECRET' },
      patch: (id, fields) => patched.push([id, fields]),
      revive: (id) => revived.push(id),
      probe: async () => { throw new Error('probe 不该被调用'); },
    },
  });
  assert.strictEqual(out.succeeded, 2);
  assert.strictEqual(out.failed, 1);
  assert.strictEqual(out.results[2].error, '账号不存在');
  assert.deepStrictEqual(patched, [[1, { enabled: true }], [2, { enabled: true }]]);
  assert.deepStrictEqual(revived, [], '默认保留冷却，不调 revive');
  assert.strictEqual(out.results[0].keptCooldown, true);

  const forced = await batch.runBatch({
    ids: [1], action: 'resume', options: { force: true },
    io: { get: (id) => ({ id }), patch: () => {}, revive: (id) => revived.push(id) },
  });
  assert.deepStrictEqual(revived, [1]);
  assert.strictEqual(forced.results[0].keptCooldown, false);

  const exported = await batch.runBatch({
    ids: [1], action: 'export',
    io: { get: () => ({ id: 1, uid: 'u', nickname: 'n', refreshToken: 'SECRET', accessToken: 'SECRET' }) },
  });
  assert.strictEqual(JSON.stringify(exported).includes('SECRET'), false);
});

test('日志缓冲：敏感整行丢弃、级别/关键字过滤、环形上限、订阅者上限与清理', () => {
  const b = logbuffer.create({ capacity: 3, maxSubscribers: 1 });
  b.push('log', ['正常启动']);
  b.push('warn', ['Authorization: Bearer abc.def.ghi']);
  b.push('error', ['api_key=sk-abcdefgh12345678 出错']);
  b.push('log', ['cookie: sid=xyz']);
  b.push('log', ['第二条正常']);
  b.push('log', ['第三条正常']);
  assert.strictEqual(b.size(), 3, '敏感行压根不进环形缓冲');
  assert.deepStrictEqual(b.read({ level: 'warn' }), []);
  assert.strictEqual(b.read({ keyword: '正常' }).length, 3);
  const seen = [];
  const unsub = b.subscribe((e) => seen.push(e.text));
  assert.strictEqual(b.subscribe(() => {}), null, '订阅者上限 1');
  b.push('log', ['第四条']);
  assert.deepStrictEqual(seen, ['第四条']);
  unsub();
  b.push('log', ['第五条']);
  assert.strictEqual(seen.length, 1, '取消订阅后不再推送');
});

test('告警规则：七类判据、样本不足不报、未知余额不猜 0', () => {
  const now = new Date(2026, 10, 8, 2, 30).getTime();
  const req = (o = {}) => ({ ts: now - 1000, status: 200, total_tokens: 10, ...o });
  const facts = {
    channels: { traework: 0 },
    taskFailStreak: 2,
    accounts: [{ id: 1, channel: 'traework', refreshExpiresAt: now + 3600000 }],
    requests: [
      req({ key_id: 'k1', status: 500 }),
      req({ key_id: 'k1', status: 500 }),
      req({ key_id: 'k1', status: 500 }),
      req({ key_id: 'k1', status: 500 }),
      req({ key_id: 'k1', status: 200 }),
    ],
  };
  const cfg = { ...alerts.defaults(), keyBurst: 5, budget: 40, errorRate: 0.5, errorMinRequests: 5 };
  const rules = new Set(alerts.evaluate(facts, cfg, now).map((a) => a.rule));
  for (const r of alerts.RULES) assert.ok(rules.has(r), `缺少规则 ${r}`);
  const few = alerts.evaluate({ ...facts, requests: facts.requests.slice(0, 3) }, cfg, now);
  assert.strictEqual(few.some((a) => a.rule === 'error_rate'), false, '样本不足不判错误率');
});

test('告警编排：迟滞触发、静默窗、连续 M 轮恢复', () => {  let state = { active: {}, lastSent: {}, streaks: {} };
  const io = { load: () => JSON.parse(JSON.stringify(state)), save: (s) => { state = s; } };
  const cfg = { ...alerts.defaults(), hysteresis: 2, silenceMs: 1000, minUsable: 1, errorRate: 2, budget: 0 };
  const facts = { channels: { traework: 0 }, requests: [], accounts: [] };
  const first = alerts.assess(facts, { io, cfg, now: 1000 });
  assert.strictEqual(first.notify.length, 0, '第一轮只累计迟滞');
  const second = alerts.assess(facts, { io, cfg, now: 1500 });
  assert.strictEqual(second.notify.length, 1);
  assert.strictEqual(second.active[0].rule, 'pool_empty');
  const quiet = alerts.assess(facts, { io, cfg, now: 1600 });
  assert.strictEqual(quiet.notify.length, 0, '静默窗内不重发');
  const recovered = { channels: { traework: 2 }, requests: [], accounts: [] };
  assert.strictEqual(alerts.assess(recovered, { io, cfg, now: 2000 }).resolved.length, 0);
  const done = alerts.assess(recovered, { io, cfg, now: 2100 });
  assert.strictEqual(done.resolved.length, 1);
  assert.ok(done.resolved[0].resolved_at);
});

test('月度账单：按月/通道/Key 聚合 + BOM + 公式注入防护', () => {
  const t = new Date(2026, 10, 8).getTime();
  const rows = monthly.aggregate([
    { ts: t, channel: 'traework', key_id: 'k1', status: 200, input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    { ts: t, channel: 'traework', key_id: 'k1', status: 500, total_tokens: 0 },
    { ts: t, channel: 'qoder', key_id: 'k2', status: 200, total_tokens: 7 },
  ], { month: '2026-11' });
  assert.strictEqual(rows.length, 2);
  const g = rows.find((r) => r.key_id === 'k1');
  assert.strictEqual(g.requests, 2);
  assert.strictEqual(g.failed, 1);
  assert.strictEqual(g.total_tokens, 15);
  assert.strictEqual(monthly.monthKey(t), '2026-11');
  assert.strictEqual(monthly.csvCell('=1+1'), "'=1+1");
  assert.strictEqual(monthly.csvCell(' @SUM(A1)'), "' @SUM(A1)".trimStart() === '@SUM(A1)' ? "' @SUM(A1)" : "' @SUM(A1)");
  assert.strictEqual(monthly.csvCell('a,b"c'), '"a,b""c"');
  assert.ok(monthly.toCsv(rows).startsWith('﻿'));
});

test('Prometheus：低基数标签、token 累计、错误合并、转义', () => {
  const text = metrics.render([
    { channel: 'traework', model: 'glm-5.2', status: 200, input_tokens: 10, output_tokens: 20 },
    { channel: 'traework', model: 'glm-5.2', status: 429 },
    { channel: 'qoder', model: 'gf"model', status: 500 },
  ], { states: [{ channel: 'traework', state: 'healthy', count: 2 }] });
  assert.match(text, /dumate2api_requests_total\{channel="traework",model="glm-5.2",status="200"\} 1/);
  assert.match(text, /dumate2api_tokens_total\{channel="traework",model="glm-5.2",status="200",direction="input"\} 10/);
  assert.match(text, /dumate2api_errors_total\{channel="traework",model="glm-5.2"\} 1/);
  assert.match(text, /model="gf\\"model"/, '标签值转义');
  assert.match(text, /dumate2api_accounts\{channel="traework",state="healthy"\} 2/);
  assert.strictEqual(text.includes('key_id'), false, '高基数维度不进标签');
});

test('配置恢复：白名单、非法整包拒绝、恢复前备份当前态', () => {
  assert.strictEqual(restore.validate({ config: { '../../evil.json': { x: 1 } } }).ok, false);
  assert.strictEqual(restore.validate({ config: { 'keys.json': { __error: 'EACCES' } } }).ok, false);
  assert.strictEqual(restore.validate({ config: {} }).ok, false);
  const payload = {
    exported_at: '2026-11-08T00:00:00Z',
    config: { 'model-map.json': { aliases: { a: 'b' } }, 'keys.json': { keys: [] } },
  };
  const out = restore.restore(payload);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.restored, ['model-map.json', 'keys.json']);
  assert.ok(out.backup.startsWith('config-backup-'));
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'model-map.json'), 'utf8'));
  assert.deepStrictEqual(saved.aliases, { a: 'b' });
  const backup = JSON.parse(fs.readFileSync(path.join(restore.backupDir(), out.backup), 'utf8'));
  assert.ok(Object.prototype.hasOwnProperty.call(backup.config, 'model-map.json'));
});

test('info 级只提示：进 active 但不进 notify，actionable 不含它（防狼来了）', () => {
  let state = { active: {}, lastSent: {}, streaks: {} };
  const io = { load: () => JSON.parse(JSON.stringify(state)), save: (s) => { state = s; } };
  const cfg = { ...alerts.defaults(), hysteresis: 1, silenceMs: 0, minUsable: 0, errorRate: 2, budget: 0 };
  // 凌晨 3 点 + 有请求 → 只命中 off_hours（info）
  const at3am = new Date(2026, 10, 8, 3, 0).getTime();
  const facts = {
    channels: { traework: 5 }, taskFailStreak: 0, accounts: [],
    requests: [{ ts: at3am - 1000, status: 200, total_tokens: 1 }],
  };
  const out = alerts.assess(facts, { io, config: cfg, now: at3am });
  assert.strictEqual(out.candidates.some((a) => a.rule === 'off_hours'), true, '规则本身要命中');
  assert.strictEqual(out.notify.length, 0, 'info 级不进推送队列');
  assert.strictEqual(out.active.length, 1, '仍记进 active（页面能看到发生过）');
  assert.strictEqual(out.actionable.length, 0, '不计入待办/侧栏角标');
  // warn 级照常可推
  // minUsable=0 时 0<0 为假，pool_empty 不会命中——要用明确低于阈值的配置
  const warnCfg = { ...cfg, minUsable: 3 };
  const warnFacts = { ...facts, channels: { traework: 0 } };
  const warnOut = alerts.assess(warnFacts, { io, config: warnCfg, now: at3am + 10 });
  assert.ok(warnOut.notify.some((a) => a.rule === 'pool_empty'), 'warn/crit 照常推送');
  assert.ok(warnOut.actionable.some((a) => a.rule === 'pool_empty'), 'warn 计入待办');
  assert.strictEqual(alerts.HINT_RULES.includes('off_hours'), true, '提示规则清单可枚举');
});
