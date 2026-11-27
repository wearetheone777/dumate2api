// test/unit/qoder-model-locks.test.js - 模型锁池视图（P2-19）
//
// 调研出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P2-19（workbuddy panel「模型与档位」
// 视图的**模型锁池表**）。
//
// 要回答的问题：「Qoder 用不了」是整条通道挂了，还是**某个模型**在排队？
// 限流早就是 (账号, 模型) 粒度（实测同一分钟一个号的 dfmodel 排 4697 位、
// 另一个号的 qfmodel 直接 200），但这个状态此前没有任何可视化面——用户只知道
// 「配了 dfmodel 用不了」，不知道「换 qfmodel 立刻可用」。
//
// 六条口径：
//   1. 按 uid 前缀过滤——池是所有通道共用的，不过滤会混进别的通道的锁
//   2. earliestUntil 与 allClearUntil **分开给**（只给前者会让人以为马上就通了）
//   3. 无锁定是正常态：空数组 + cleared=true，**不造一行「全部正常」**
//   4. 已过期的锁不显示（注入 now 与快照时刻不一致时按 now 重判）
//   5. available = 已登记总数 − 被锁账号数（同账号锁多模型只算一次）
//   6. 类别只做粗分、不做自动处置建议（判错会让人白等或白换模型）
//
// 运行：node --test test/unit/qoder-model-locks.test.js
const test = require('node:test');
const assert = require('node:assert');

const locks = require('../../src/qoder/model-locks');

const NOW = 1_800_000_000_000;
const at = (ms) => NOW + ms;

/** 池快照的一行（与 pool.status() 同形状，只保留本模块消费的字段） */
function row(uid, models) {
  return {
    id: uid,
    model_cooldowns: models.map(([model, ms, hits, reason]) => ({
      model, until: at(ms), hits: hits || 1, reason: reason || '',
    })),
  };
}

test('按前缀过滤：别的通道的锁不进 Qoder 视图（池是所有通道共用的）', () => {
  const snap = [
    row('qoder:1', [['dfmodel', 60000, 2, '10605 RESOURCE_LIMIT']]),
    row('traework:9', [['glm-5.2', 60000, 1, '爆了']]),
    row('qwenwork:3', [['qwen/pro', 60000, 1, '爆了']]),
  ];
  const out = locks.aggregateLocks(snap, { prefix: 'qoder:', total: 3, now: NOW });
  assert.strictEqual(out.models.length, 1);
  assert.strictEqual(out.models[0].model, 'dfmodel');
  assert.deepStrictEqual(out.models[0].accounts, ['1'], '账号 id 要去掉前缀');
  assert.strictEqual(out.lockedAccounts, 1, '只算 qoder 的锁');
});

test('earliestInMs 与 allClearInMs 分开给（最早解锁 ≠ 全池解锁）', () => {
  const snap = [
    row('qoder:1', [['dfmodel', 60_000, 1, '10605']]),
    row('qoder:2', [['dfmodel', 120_000, 3, '10605']]),
  ];
  const out = locks.aggregateLocks(snap, { prefix: 'qoder:', total: 2, now: NOW });
  const m = out.models[0];
  assert.strictEqual(m.accountCount, 2);
  assert.strictEqual(m.earliestInMs, 60_000, '1 号 1 分钟后解锁');
  assert.strictEqual(m.allClearInMs, 120_000, '全池要等 2 分钟');
  assert.strictEqual(m.maxHits, 3, '最多撞了几次');
});

test('无锁定是正常态：空数组 + cleared=true，不造「全部正常」的假行', () => {
  const out = locks.aggregateLocks([row('qoder:1', [])], { prefix: 'qoder:', total: 2, now: NOW });
  assert.deepStrictEqual(out.models, []);
  assert.strictEqual(out.cleared, true);
  assert.strictEqual(out.lockedAccounts, 0);
  assert.strictEqual(out.available, 2, '没锁 = 全部可选');
});

test('已过期的锁不显示（注入 now 与快照时刻不一致时按 now 重判）', () => {
  const snap = [row('qoder:1', [['dfmodel', -1000, 1, 'old']])];  // 1 秒前就到期
  const out = locks.aggregateLocks(snap, { prefix: 'qoder:', total: 1, now: NOW });
  assert.deepStrictEqual(out.models, [], '过期的锁不该留在界面上');
});

test('available = 总数 − 被锁账号数；同账号锁多个模型只算一次', () => {
  const snap = [
    row('qoder:1', [
      ['dfmodel', 60_000, 1, 'a'],
      ['qfmodel', 30_000, 1, 'b'],
    ]),
    row('qoder:2', []),
    row('qoder:3', []),
  ];
  const out = locks.aggregateLocks(snap, { prefix: 'qoder:', total: 3, now: NOW });
  assert.strictEqual(out.lockedAccounts, 1, '一个号锁了两个模型，只算一个号');
  assert.strictEqual(out.available, 2, '3 个号里 1 个被锁 → 2 个可选');
  assert.strictEqual(out.models.length, 2);
});

test('排序：全池解锁最快的排前面（那是用户该换的模型）', () => {
  const snap = [
    row('qoder:1', [['slowmodel', 300_000, 1, '10605']]),
    row('qoder:1', [['fastmodel', 10_000, 1, '10605']]),
  ];
  const out = locks.aggregateLocks(snap, { prefix: 'qoder:', total: 1, now: NOW });
  assert.deepStrictEqual(out.models.map((m) => m.model), ['fastmodel', 'slowmodel']);
});

test('kindOf：只做粗分（排队 / 配额 / 模型 / 其它），不给处置建议', () => {
  assert.strictEqual(locks.kindOf([{ text: '{"code":"10605","isQueued":true}' }]), 'queue');
  assert.strictEqual(locks.kindOf([{ text: 'RESOURCE_LIMIT' }]), 'queue');
  assert.strictEqual(locks.kindOf([{ text: 'quota exhausted (112)' }]), 'quota');
  assert.strictEqual(locks.kindOf([{ text: 'Billing daily count exceeded' }]), 'quota');
  assert.strictEqual(locks.kindOf([{ text: 'model not available' }]), 'model');
  assert.strictEqual(locks.kindOf([{ text: '乱七八糟' }]), 'other');
  assert.strictEqual(locks.kindOf([]), 'other');
});

test('queueKindOf：真排队(p4) 与伪装硬拒绝(p1) 分开（2026-11-28 真机实测）', () => {
  // 真排队：服务在、队列里有人 → 等着会放行
  const real = '{"code":"10605","isQueued":true,"queueCount":1,"queueType":"p4",'
    + '"serviceAvailable":true,"subCode":"RESOURCE_LIMIT","waitTime":60}';
  assert.strictEqual(locks.queueKindOf(real), 'real');
  // 伪装硬拒绝：服务不在、队列空 → 等也不会放行（identity-guard 中和的那种）
  const hard = '{"code":"10605","isQueued":true,"queueCount":0,"queueType":"p1",'
    + '"serviceAvailable":false,"subCode":"RESOURCE_LIMIT"}';
  assert.strictEqual(locks.queueKindOf(hard), 'hard');
  // 只有 code 10605、形态字段都没给 → 不猜
  assert.strictEqual(locks.queueKindOf('{"code":"10605","isQueued":true}'), '');
  // 根本不是排队的文本 → 恒空（不臆造排队形态）
  assert.strictEqual(locks.queueKindOf('quota exhausted'), '');
  assert.strictEqual(locks.queueKindOf(''), '');
});

test('queueKind：只对排队类锁给形态，其它锁恒空', () => {
  const snap = [
    row('qoder:1', [['gfmodel', 60_000, 1,
      '{"code":"10605","isQueued":true,"queueCount":1,"queueType":"p4","serviceAvailable":true}']]),
    row('qoder:2', [['dfmodel', 60_000, 1, 'quota exhausted (112)']]),
  ];
  const out = locks.aggregateLocks(snap, { prefix: 'qoder:' });
  const gf = out.models.find((m) => m.model === 'gfmodel');
  const df = out.models.find((m) => m.model === 'dfmodel');
  assert.strictEqual(gf.kind, 'queue');
  assert.strictEqual(gf.queueKind, 'real');
  // 额度锁不是排队，不该带排队形态
  assert.strictEqual(df.kind, 'quota');
  assert.strictEqual(df.queueKind, '');
});

test('同模型的多种原因按次数排序，主因取最多的那条', () => {
  const snap = [
    row('qoder:1', [['dfmodel', 60_000, 1, 'RESOURCE_LIMIT']]),
    row('qoder:2', [['dfmodel', 60_000, 1, 'RESOURCE_LIMIT']]),
    row('qoder:3', [['dfmodel', 60_000, 1, 'CALL_COUNT_LIMIT']]),
  ];
  const out = locks.aggregateLocks(snap, { prefix: 'qoder:', total: 3, now: NOW });
  const m = out.models[0];
  assert.strictEqual(m.reason, 'RESOURCE_LIMIT', '2 次 vs 1 次');
  assert.strictEqual(m.reasons.length, 2);
  assert.strictEqual(m.reasons[0].count, 2);
});

test('reason 截断到 160 字（上游信封可能很长），空原因不占位', () => {
  const long = 'x'.repeat(500);
  const snap = [
    row('qoder:1', [['dfmodel', 60_000, 1, long]]),
    row('qoder:2', [['dfmodel', 60_000, 1, '']]),
  ];
  const out = locks.aggregateLocks(snap, { prefix: 'qoder:', total: 2, now: NOW });
  const m = out.models[0];
  assert.ok(m.reason.length <= 161, '截断到 160 + 省略号，实际 ' + m.reason.length);
  assert.strictEqual(m.reasons.length, 1, '空原因不占一行');
});

test('未给 total 时 available 按「未锁账号数」给，不编总数', () => {
  const snap = [row('qoder:1', [['dfmodel', 60_000, 1, 'x']]), row('qoder:2', [])];
  const out = locks.aggregateLocks(snap, { prefix: 'qoder:', now: NOW });
  assert.strictEqual(out.totalAccounts, 2, '退回快照里的账号数');
  assert.strictEqual(out.available, 1);
});

test('脏入参不抛：null / 缺 model_cooldowns / 缺 id', () => {
  assert.doesNotThrow(() => locks.aggregateLocks(null, { prefix: 'qoder:', now: NOW }));
  const out = locks.aggregateLocks([
    null,
    {},
    { id: 'qoder:1' },
    { id: 'qoder:2', model_cooldowns: null },
    { id: 'qoder:3', model_cooldowns: [{ model: '', until: at(1000) }] },
  ], { prefix: 'qoder:', total: 3, now: NOW });
  assert.deepStrictEqual(out.models, [], '缺数据的行跳过，不造行');
});
