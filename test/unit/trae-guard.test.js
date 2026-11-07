// test/unit/trae-guard.test.js - 每日用量护栏（调研 P2-16 另三项）
//
// 全部离线：用量桶由固定行喂，不读 requests.jsonl、不打上游。
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const guard = require('../../src/traework/guard');

const NOW = new Date(2026, 10, 8, 12, 0).getTime();   // 本地 11-08 12:00
const row = (o = {}) => ({ ts: NOW - 1000, channel: 'traework', account_id: 1, model: 'glm-5.2', total_tokens: 100, ...o });

test('dayStart 是本地零点，跨日行不进当天桶', () => {
  const start = guard.dayStart(NOW);
  assert.strictEqual(new Date(start).getHours(), 0);
  const rows = [
    row({ ts: NOW - 1000, total_tokens: 500 }),
    row({ ts: start - 1, total_tokens: 9999 }),   // 昨天
  ];
  const u = guard.usageOf(rows, { now: NOW });
  assert.strictEqual(u.byAccount.get('1').tokens, 500);
  assert.strictEqual(u.total, 500);
});

test('account_id 缺失或跨通道的行不进任何桶（不摊到别人头上）', () => {
  const u = guard.usageOf([
    row({ account_id: null, total_tokens: 777 }),
    row({ account_id: '', total_tokens: 777 }),
    row({ channel: 'qoder', account_id: 1, total_tokens: 777 }),
    row({ account_id: 2, total_tokens: 50 }),
  ], { now: NOW });
  assert.strictEqual(u.byAccount.has('1'), false);
  assert.strictEqual(u.byAccount.get('2').tokens, 50);
  assert.strictEqual(u.total, 50);
});

test('按 (账号, 模型) 分桶；无 total_tokens 时用 in+out 兜底', () => {
  const u = guard.usageOf([
    row({ account_id: 1, model: 'a', total_tokens: 0, input_tokens: 30, output_tokens: 20 }),
    row({ account_id: 1, model: 'b', total_tokens: 70 }),
  ], { now: NOW });
  assert.strictEqual(u.byModel.get('1\x00a'), 50);
  assert.strictEqual(u.byModel.get('1\x00b'), 70);
  assert.strictEqual(u.byAccount.get('1').requests, 2);
});

test('护栏关闭时原样放行（默认行为逐字节不变）', () => {
  const list = [{ id: 1 }, { id: 2 }];
  const out = guard.applyDaily(list, { enabled: false, dailyTokens: 1 }, { usage: { byAccount: new Map([['1', { tokens: 999 }]]), byModel: new Map() } });
  assert.deepStrictEqual(out.rows, list);
  assert.strictEqual(out.blocked.length, 0);
});

test('三项阈值：模型级优先、账号级 token、账号级积分；未知不拦', () => {
  const usage = {
    byAccount: new Map([['1', { tokens: 900, requests: 3 }], ['2', { tokens: 10, requests: 1 }]]),
    byModel: new Map([['2\x00m1', 500]]),
  };
  const credits = new Map([['3', 50]]);
  const list = [{ id: 1, nickname: 'A' }, { id: 2, nickname: 'B' }, { id: 3, nickname: 'C' }, { id: 4, nickname: 'D' }];
  const out = guard.applyDaily(list, { enabled: true, dailyTokens: 800, dailyCredits: 20, modelTokens: 400 }, {
    model: 'm1', usage, creditsByAccount: credits,
  });
  const byId = Object.fromEntries(out.blocked.map((b) => [b.id, b]));
  assert.strictEqual(byId[1].reason, 'daily_tokens', '账号 1 token 超限');
  assert.strictEqual(byId[2].reason, 'model_tokens', '账号 2 只有该模型超限');
  assert.strictEqual(byId[3].reason, 'daily_credits', '账号 3 积分超限');
  assert.deepStrictEqual(out.rows.map((a) => a.id), [4], '账号 4 无用量记录 → 未知不拦');
});

test('模型级只拦指定模型：换了模型仍可用', () => {
  const usage = { byAccount: new Map(), byModel: new Map([['1\x00m1', 999]]) };
  const cfg = { enabled: true, modelTokens: 100 };
  const blockedOnM1 = guard.applyDaily([{ id: 1 }], cfg, { model: 'm1', usage });
  assert.strictEqual(blockedOnM1.rows.length, 0);
  const okOnM2 = guard.applyDaily([{ id: 1 }], cfg, { model: 'm2', usage });
  assert.strictEqual(okOnM2.rows.length, 1);
});

test('阈值全 0 = 不限（等于没开）', () => {
  const usage = { byAccount: new Map([['1', { tokens: 1e9 }]]), byModel: new Map([['1\x00m', 1e9]]) };
  const out = guard.applyDaily([{ id: 1 }], { enabled: true, dailyTokens: 0, dailyCredits: 0, modelTokens: 0 }, { model: 'm', usage });
  assert.strictEqual(out.rows.length, 1);
  assert.strictEqual(out.blocked.length, 0);
});

test('blockedReason 给出可读原因与上限来源，不发散成通用文案', () => {
  const msg = guard.blockedReason([{ id: 1, name: '测150', reason: 'daily_tokens', used: 900, limit: 800 }]);
  assert.match(msg, /测150/);
  assert.match(msg, /今日 token 900\/800/);
  assert.match(msg, /本地零点/);
  assert.strictEqual(guard.blockedReason([]), '');
});
