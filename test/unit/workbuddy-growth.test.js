// test/unit/workbuddy-growth.test.js - 成长中心只读聚合（2026-11-08 融合批）
//
// 出处：GitHub 生态调研把「成长任务引擎」列为本项目最大缺失项。本模块先做
// **只读**部分——这不是保守：
//   1. 调研实证「伪造 /v2/report 成长事件会被上游识别为异常，2026-10-15 起
//      国际版收紧」，写操作收益（积分）与风险（封号）不对称；
//   2. 领奖/接取任务的 body 形状在调研里被标为「未在 unlocked 态验证」。
//
// 端点前缀**不对称**是实测事实，别「顺手统一」：
//   /activity/growth/streak         （无 /v2）
//   /activity/growth/heatmap        （无 /v2）
//   /v2/activity/growth/tasks       （有 /v2）
//   /v2/activity/growth/energy      （有 /v2）
//   /v2/activity/growth/buddy/quota （有 /v2）
//
// 本用例锁解析器的「容忍缺失、不编造」：所有解析函数对残缺文档必须返回
// null 或零值，不能凭空造出天数/积分。
//
// 运行：node --test test/unit/workbuddy-growth.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { tmpDir } = require('../helpers/tmpdir');
process.env.DUMATE_ADMIN_DATA = tmpDir('wb-growth');
process.env.DUMATE_POOL_STATE = path.join(process.env.DUMATE_ADMIN_DATA, 'pool-state.json');

const g = require('../../src/workbuddy/growth');

// ---- 真机夹具（2026-11-08 实测原始形状，字段逐字保留）----
const STREAK_DOC = {
  code: 0, msg: 'OK',
  data: {
    streak: { days: 7, month_total_days: 7, month_consumed_days: 0, next_tier: '14d', next_tier_remaining: 7, makeup_dates: ['2026-11-01'] },
    makeup_cards: { balance: 2, max: 4 },
    redemption_status: { tier_7d_count: 1, tier_14d_count: 0, tier_28d_count: 0, tier_7d_status: 'claimed', tier_14d_status: 'locked', tier_28d_status: 'locked' },
  },
};
const HEAT_DOC = {
  code: 0,
  data: { cells: [
    { date: '2026-11-06', score: 3 }, { date: '2026-11-07', score: 0 }, { date: '2026-11-08', score: 0 },
  ] },
};
const TASKS_DOC = {
  code: 0,
  data: { tasks: [
    { task_code: 'playbook_prompt', title: '探索优秀灵感', task_desc: '体验1款灵感', task_type: 'single', reward_credit: 100, reward_energy: 5, accept_status: 'claimed', progress: { current: 1, target: 1 }, locked: false, has_reward: true },
    { task_code: 'first_buddy', title: '领养 Buddy', task_type: 'auto', reward_credit: 300, reward_energy: 10, accept_status: 'unlocked', progress: { current: 0, target: 1 }, locked: false, has_reward: true },
    { task_code: 'expired_one', title: '过期的', task_type: 'single', reward_credit: 50, accept_status: 'unlocked', valid_end: '2020-01-01 00:00:00' },
    { task_code: 'locked_one', title: '锁着的', task_type: 'single', reward_credit: 80, accept_status: 'unlocked', locked: true },
  ] },
};
const ENERGY_DOC = { code: 0, data: { balance: 5, total_consumed: 170, total_earned: 175 } };
const QUOTA_DOC = { code: 0, data: { affordable: 0, balance: 5, cost_per_open: 10, max_open_count: 5 } };

test('parseStreak：真机字段逐个映射', () => {
  const s = g.parseStreak(STREAK_DOC);
  assert.equal(s.days, 7);
  assert.equal(s.monthTotal, 7);
  assert.equal(s.nextTier, '14d');
  assert.equal(s.nextTierRemaining, 7, '还差 7 天到下一档');
  assert.deepEqual(s.makeupCards, { balance: 2, max: 4 });
  assert.deepEqual(s.tiers.map((t) => [t.tier, t.status]), [[7, 'claimed'], [14, 'locked'], [28, 'locked']]);
});

test('parseStreak：redeemable 只收 unlocked（「必须手动领，不领会过期」）', () => {
  const s = g.parseStreak({ code: 0, data: { redemption_status: { tier_7d_status: 'unlocked', tier_14d_status: 'claimed', tier_28d_status: 'locked' } } });
  assert.deepEqual(s.redeemable, [7], '只有 unlocked 才是「现在能领」');
});

test('parseStreak：残缺文档不编天数（null 而不是 0）', () => {
  assert.equal(g.parseStreak(null), null);
  assert.equal(g.parseStreak({ code: 0 }), null);
  const s = g.parseStreak({ code: 0, data: {} });
  assert.equal(s.days, null, '没有 streak 字段就是 null——0 会被读成「今天没签」');
  assert.equal(s.makeupCards.balance, null);
});

test('parseHeatmap：今天 score=0 时如实报 0（不是 null）', () => {
  const h = g.parseHeatmap(HEAT_DOC, Date.parse('2026-11-08T12:00:00+08:00'));
  assert.equal(h.todayScore, 0, '查到了就是 0；用 null 会让「没点亮」与「查不到」混为一谈');
  assert.equal(h.lit, 1, '只有 11-06 的 score>0');
  assert.equal(h.total, 3);
});

test('parseHeatmap：今天不在 cells 里时 todayScore 为 null', () => {
  const h = g.parseHeatmap(HEAT_DOC, Date.parse('2026-12-01T12:00:00+08:00'));
  assert.equal(h.todayScore, null);
  assert.equal(h.today, '2026-12-01');
});

test('parseHeatmap：无 cells 返回零值不抛', () => {
  for (const junk of [null, {}, { data: {} }, { data: { cells: 'x' } }]) {
    const h = g.parseHeatmap(junk);
    assert.equal(h.lit, 0);
    assert.equal(h.total, 0);
  }
});

test('parseTasks：claimed 计数与积分合计', () => {
  const t = g.parseTasks(TASKS_DOC, Date.parse('2026-11-08T12:00:00+08:00'));
  assert.equal(t.total, 4);
  assert.equal(t.claimed, 1);
  assert.equal(t.creditTotal, 100 + 300 + 50 + 80);
  assert.equal(t.creditClaimed, 100);
});

test('parseTasks：claimable 排除 locked 与已过期（这两个都是「点了会失败」）', () => {
  const t = g.parseTasks(TASKS_DOC, Date.parse('2026-11-08T12:00:00+08:00'));
  assert.deepEqual(t.pending.map((x) => x.code), ['first_buddy'],
    'expired_one 已过期、locked_one 被锁，都不该出现在「可做」里');
});

test('parseTasks：auto 类如实标记（不接受接取，且是 single 的前置）', () => {
  const t = g.parseTasks(TASKS_DOC);
  const auto = t.rows.find((x) => x.code === 'first_buddy');
  assert.equal(auto.auto, true);
  const single = t.rows.find((x) => x.code === 'playbook_prompt');
  assert.equal(single.auto, false);
});

test('parseTasks：pending 按奖励从大到小（先看值钱的）', () => {
  const doc = { code: 0, data: { tasks: [
    { task_code: 'a', reward_credit: 10, accept_status: 'single' },
    { task_code: 'b', reward_credit: 500, accept_status: 'single' },
    { task_code: 'c', reward_credit: 100, accept_status: 'single' },
  ] } };
  const t = g.parseTasks(doc);
  assert.deepEqual(t.pending.map((x) => x.code), ['b', 'c', 'a']);
});

test('parseTasks：无 tasks 返回零值不抛', () => {
  for (const junk of [null, {}, { data: {} }]) {
    const t = g.parseTasks(junk);
    assert.equal(t.total, 0);
    assert.equal(t.claimable, 0);
    assert.deepEqual(t.pending, []);
  }
});

test('parseEnergy / parseBuddyQuota：真机字段映射', () => {
  assert.deepEqual(g.parseEnergy(ENERGY_DOC), { balance: 5, earned: 175, consumed: 170 });
  assert.deepEqual(g.parseBuddyQuota(QUOTA_DOC), { affordable: 0, balance: 5, costPerOpen: 10, maxOpenCount: 5 });
  assert.equal(g.parseEnergy(null), null);
  assert.equal(g.parseBuddyQuota({}), null);
});

test('fetchGrowth：五个端点各自失败不影响其它（错误逐项记明）', async () => {
  // 用注入点伪造：只有 streak 成功，其余报错
  g._setRequestImpl((opts, cb) => {
    const isStreak = String(opts.path).includes('/activity/growth/streak');
    const { EventEmitter } = require('node:events');
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      if (!isStreak) { req.emit('error', new Error('boom')); return; }
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = () => {};
      cb(res);
      res.emit('data', JSON.stringify(STREAK_DOC));
      res.emit('end');
    };
    return req;
  });
  try {
    const r = await g.fetchGrowth('cn', { accessToken: 't' });
    assert.equal(r.ok, true, '有任一成功就算 ok');
    assert.equal(r.streak.days, 7);
    assert.equal(r.tasks, null, '失败的那项是 null，不是空对象');
    assert.ok(r.errors.tasks, '失败原因要逐项记明，不能只给一个总错');
    assert.ok(r.errors.energy);
    assert.match(r.note, /只读/);
  } finally {
    g._setRequestImpl(null);
  }
});

test('fetchGrowth：全部失败时 ok=false 且不编造任何数据', async () => {
  g._setRequestImpl(() => {
    const { EventEmitter } = require('node:events');
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => req.emit('error', new Error('down'));
    return req;
  });
  try {
    const r = await g.fetchGrowth('cn', { accessToken: 't' });
    assert.equal(r.ok, false);
    assert.equal(r.streak, null);
    assert.equal(r.tasks, null);
    assert.equal(Object.keys(r.errors).length, 5);
  } finally {
    g._setRequestImpl(null);
  }
});

test('fetchGrowth：出站代理配错时不静默直连（如实报错）', async () => {
  const r = await g.fetchGrowth('cn', { accessToken: 't', proxy: 'not-a-url' });
  assert.equal(r.ok, false);
  for (const k of Object.keys(r.errors)) {
    assert.match(r.errors[k], /出站代理配置错误/);
  }
});
