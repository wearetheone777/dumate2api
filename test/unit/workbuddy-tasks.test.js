// test/unit/workbuddy-tasks.test.js - 成长任务写路径三动作（P0-6，2026-11-28 融合批）
//
// 锁的是探针（test/probe-workbuddy-tasks.js，真机 2026-11-28 账号 1）换来的定案：
//   - claim 走 web 域路径（任务码在 PATH、无 body、x-client-platform: web 头族），
//     CLI 域 reward/claim 路径不存在（探针 400 task not completed 复现 misakano）
//   - makeup 字段名 target_date（date 变体被上游拒 invalid target_date format）
//   - redeem 实发字段带 _granted 后缀（credit 恒空，读它必漏计）
//   - sweep 只碰 accept（幂等）+ claim（完成且未领），claim 后回读确认
//   - 补签候选 = 当月、今天前（today 取响应的 today.date）、score==0、不在 makeup_dates
//
// 运行：node --test test/unit/workbuddy-tasks.test.js
const assert = require('assert');
const { test } = require('node:test');

const tasks = require('../../src/workbuddy/tasks');

// ---- 请求打桩：路由表驱动的假 https ----

function makeStub(routes, calls) {
  // routes: [{match:(opts)=>boolean, reply:()=>({status,doc})}] 按序取第一个命中
  return function requestImpl(opts, cb) {
    const route = routes.find((r) => r.match(opts));
    calls.push({ method: opts.method, path: opts.path, hostname: opts.hostname, headers: opts.headers, body: null });
    const hit = route || { reply: () => ({ status: 404, doc: { code: 404, msg: 'no route' } }) };
    const { status, doc } = hit.reply();
    const body = Buffer.from(JSON.stringify(doc));
    const res = {
      statusCode: status,
      on(ev, fn) {
        if (ev === 'data') setImmediate(() => fn(body));
        if (ev === 'end') setImmediate(() => fn());
      },
    };
    const req = {
      on() {}, write(p) { calls[calls.length - 1].body = p ? p.toString('utf8') : null; }, end() {}, destroy() {},
    };
    setImmediate(() => cb(res));
    return req;
  };
}

function withStub(routes) {
  const calls = [];
  tasks._setRequestImpl(makeStub(routes, calls));
  return calls;
}

const acc = { id: 1, uid: 'uid-t1', region: 'cn', accessToken: 'tok', enterpriseId: '' };

test('parseTaskRow：progress 对象与平铺双形状，claimable 判定四条边界', () => {
  const obj = tasks.parseTaskRow({
    task_code: 'daily_login', title: '每日登录', task_type: 'single', accept_status: 'accepted',
    has_reward: true, reward_credit: 20, progress: { current: 1, target: 1 }, status: 'complete',
  });
  assert.deepStrictEqual([obj.code, obj.auto, obj.current, obj.target, obj.claimable], ['daily_login', false, 1, 1, true]);

  const flat = tasks.parseTaskRow({
    code: 'chat_5', task_type: 'single', accept_status: 'accepted', has_reward: true,
    current: 3, target: 5, status: 'in_progress',
  });
  assert.strictEqual(flat.claimable, false, '进度未达标不能领');

  const claimed = tasks.parseTaskRow({ code: 'x', accept_status: 'claimed', has_reward: true, progress: { current: 9, target: 1 } });
  assert.strictEqual(claimed.claimable, false, '已领过不能再领');
  const locked = tasks.parseTaskRow({ code: 'x', locked: true, accept_status: 'accepted', has_reward: true, progress: { current: 9, target: 1 } });
  assert.strictEqual(locked.claimable, false, '锁定不领');
  const noReward = tasks.parseTaskRow({ code: 'x', accept_status: 'accepted', progress: { current: 9, target: 1 } });
  assert.strictEqual(noReward.claimable, false, '没奖励位不领（has_reward 缺失）');

  const auto = tasks.parseTaskRow({ code: 'first_buddy', task_type: 'auto', accept_status: 'unknown' });
  assert.strictEqual(auto.auto, true, 'auto 类不接受接取');
});

test('parseTaskRow：valid_end 过期判定（+08:00 语义）', () => {
  const past = tasks.parseTaskRow({ code: 'x', accept_status: 'accepted', has_reward: true, progress: { current: 1, target: 1 }, valid_end: '2026-01-01 00:00:00' });
  assert.strictEqual(past.expired, true, '过去时刻=过期');
  const future = tasks.parseTaskRow({ code: 'x', accept_status: 'accepted', has_reward: true, progress: { current: 1, target: 1 }, valid_end: '2099-01-01 00:00:00' });
  assert.strictEqual(future.expired, false);
  assert.strictEqual(future.claimable, true);
});

test('parseRedeemableTiers：实测混合形状（tiers[] 描述 + 平铺 status 键）只挑 unlocked', () => {
  const doc = { data: { redemption_status: {
    tiers: [{ tier: '7d', days: 7, credit: 100 }, { tier: '14d', days: 14 }, { tier: '28d', days: 28 }],
    tier_7d_status: 'claimed', tier_14d_status: 'unlocked', tier_28d_status: 'locked',
  } } };
  assert.deepStrictEqual(tasks.parseRedeemableTiers(doc), [{ tier: '14d', status: 'unlocked' }]);
});

test('parseRedeemableTiers：无 tiers 数组时回退已知档位（growth.js 11-08 的平铺形状）', () => {
  const doc = { data: { redemption_status: { tier_7d_status: 'unlocked', tier_14d_status: 'locked', tier_28d_status: 'locked' } } };
  assert.deepStrictEqual(tasks.parseRedeemableTiers(doc), [{ tier: '7d', status: 'unlocked' }]);
});

test('makeupCandidates：四条过滤 + 最近断点优先 + today 缺失不猜窗口', () => {
  const mk = (cells, today) => ({ data: { today: today === undefined ? { date: '2026-11-28' } : today, cells } });
  const doc = mk([
    { date: '2026-11-27', score: 0 },   // 最近断点
    { date: '2026-11-20', score: 0 },   // 较早断点
    { date: '2026-11-28', score: 0 },   // 今天前？不是——>= today 排除
    { date: '2026-11-29', score: 0 },   // 未来排除
    { date: '2026-11-15', score: 30 },  // 未断排除
    { date: '2026-11-12', score: 0 },   // 在 makeup_dates 里排除
    { date: '2026-10-31', score: 0 },   // 上月排除
    { date: '2026-05-01', score: 0 },   // growth 下界前排除
    { date: 'bad-date', score: 0 },     // 坏行排除
  ]);
  assert.deepStrictEqual(
    tasks.makeupCandidates(doc, ['2026-11-12']),
    ['2026-11-27', '2026-11-20'],
    '只剩两个合法断点，最近在前',
  );
  assert.deepStrictEqual(tasks.makeupCandidates(mk([], { date: '' })), [], 'today 结构缺失 → 空候选（不猜窗口）');
  assert.deepStrictEqual(tasks.makeupCandidates(null, []), []);
});

test('sweepTasks：accept 幂等报名（复数数组）+ claim 走 web 域路径 + 回读翻 claimed 才 verified', async () => {
  const listDoc = () => ({ code: 0, msg: 'OK', data: { tasks: [
    { task_code: 'daily_login', task_type: 'single', accept_status: 'unknown', has_reward: true, progress: { current: 0, target: 1 } },
    { task_code: 'chat_5', task_type: 'single', accept_status: 'accepted', has_reward: true, progress: { current: 5, target: 5 } },
  ] } });
  const listClaimed = () => ({ code: 0, msg: 'OK', data: { tasks: [
    { task_code: 'daily_login', task_type: 'single', accept_status: 'accepted', has_reward: true, progress: { current: 0, target: 1 } },
    { task_code: 'chat_5', task_type: 'single', accept_status: 'claimed', has_reward: true, progress: { current: 5, target: 5 } },
  ] } });
  let listCount = 0; // 第一次列表 → 待领态；回读（第二次）→ 全 claimed
  const calls = withStub([
    { match: (o) => o.method === 'GET' && /\/v2\/activity\/growth\/tasks$/.test(o.path), reply: () => ({ status: 200, doc: ++listCount === 1 ? listDoc() : listClaimed() }) },
    { match: (o) => o.method === 'POST' && /\/v2\/activity\/growth\/tasks\/accept$/.test(o.path), reply: () => ({ status: 200, doc: { code: 0, msg: 'OK' } }) },
    { match: (o) => o.method === 'POST' && /\/activity\/growth\/tasks\/chat_5\/claim$/.test(o.path), reply: () => ({ status: 200, doc: { code: 0, msg: 'OK', data: { already_claimed: false, credit: 20, energy: 5 } } }) },
  ]);
  const r = await tasks.sweepTasks('cn', acc);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.accepted, ['daily_login']);
  const acceptCall = calls.find((x) => x.method === 'POST' && /accept$/.test(x.path));
  assert.strictEqual(acceptCall.body, JSON.stringify({ task_codes: ['daily_login'] }), 'accept 是复数数组形状');
  const claimCall = calls.find((x) => /\/claim$/.test(x.path));
  assert.strictEqual(claimCall.hostname, 'www.workbuddy.cn', 'claim 必须打 web 域（CLI 域路径不存在）');
  assert.strictEqual(claimCall.body, null, 'claim 无 body，任务码在路径');
  assert.strictEqual(claimCall.headers['x-client-platform'], 'web');
  assert.deepStrictEqual(r.claimed, [{ code: 'chat_5', credit: 20, energy: 5, verified: true }]);
  assert.deepStrictEqual(r.unverified, []);
});

test('sweepTasks：回读没翻状态 → unverified（本轮不再重复空 claim）', async () => {
  const listDoc = () => ({ code: 0, msg: 'OK', data: { tasks: [
    { task_code: 'chat_5', task_type: 'single', accept_status: 'accepted', has_reward: true, progress: { current: 5, target: 5 } },
  ] } });
  const calls = withStub([
    { match: (o) => o.method === 'GET', reply: () => ({ status: 200, doc: listDoc() }) }, // 回读仍 accepted
    { match: (o) => o.method === 'POST' && /accept$/.test(o.path), reply: () => ({ status: 200, doc: { code: 0, msg: 'OK' } }) },
    { match: (o) => o.method === 'POST' && /\/claim$/.test(o.path), reply: () => ({ status: 200, doc: { code: 0, msg: 'OK', data: { already_claimed: false, credit: 20 } } }) },
  ]);
  const r = await tasks.sweepTasks('cn', acc);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.unverified, ['chat_5'], '没证据就是没证据，不冒认');
  assert.deepStrictEqual(r.claimed, []);
  const claimCalls = calls.filter((x) => /\/claim$/.test(x.path));
  assert.strictEqual(claimCalls.length, 1, '同轮只 claim 一次');
});

test('sweepTasks：prerequisite 报错先补跑前置（first_buddy）再重试一次', async () => {
  const listDoc = () => ({ code: 0, msg: 'OK', data: { tasks: [
    { task_code: 'buddy_task', task_type: 'single', accept_status: 'unknown', has_reward: true, progress: { current: 1, target: 1 } },
  ] } });
  let claimCount = 0;
  const calls = withStub([
    { match: (o) => o.method === 'GET', reply: () => ({ status: 200, doc: listDoc() }) },
    { match: (o) => o.method === 'POST' && /accept$/.test(o.path), reply: () => ({ status: 200, doc: { code: 0, msg: 'OK' } }) },
    { match: (o) => o.method === 'POST' && /\/claim$/.test(o.path), reply: () => {
      claimCount++;
      return claimCount === 1
        ? { status: 400, doc: { code: 400, msg: 'prerequisite task first_buddy not completed' } }
        : { status: 200, doc: { code: 0, msg: 'OK', data: { already_claimed: false, credit: 50 } } };
    } },
  ]);
  const r = await tasks.sweepTasks('cn', acc);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.unverified, ['buddy_task']); // 回读没翻（stub 列表恒 unknown）→ unverified，但 claim 成功了
  const acceptCalls = calls.filter((x) => /accept$/.test(x.path));
  assert.strictEqual(acceptCalls.length, 2, '第一次 accept 任务本身 + 补跑前置');
  assert.strictEqual(acceptCalls[0].body, JSON.stringify({ task_codes: ['buddy_task'] }));
  assert.strictEqual(acceptCalls[1].body, JSON.stringify({ task_codes: ['first_buddy'] }));
  assert.strictEqual(claimCount, 2, '前置补跑后重试');
});

test('redeemUnlocked：403 天数不足 / 409 已兑是业务态，成功读 _granted 实发字段', async () => {
  const streakDoc = () => ({ code: 0, msg: 'OK', data: { redemption_status: {
    tiers: [{ tier: '7d' }, { tier: '14d' }, { tier: '28d' }],
    tier_7d_status: 'claimed', tier_14d_status: 'unlocked', tier_28d_status: 'unlocked',
  } } });
  const calls = withStub([
    { match: (o) => /streak$/.test(o.path), reply: () => ({ status: 200, doc: streakDoc() }) },
    { match: (o) => /redeem$/.test(o.path), reply: ((n = 0) => () => {
      n++;
      return n === 1
        ? { status: 403, doc: { code: 403, msg: '连续登录天数不足' } }
        : { status: 200, doc: { code: 0, msg: 'OK', data: { credit: null, credit_granted: 300, energy_granted: 10, cards_granted: 1, chances_granted: 0 } } };
    })() },
  ]);
  const r = await tasks.redeemUnlocked('cn', acc);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.skipped, [{ tier: '14d', reason: '连续登录天数不足（业务态）' }]);
  assert.deepStrictEqual(r.redeemed, [{ tier: '28d', granted: { credit: 300, energy: 10, cards: 1, chances: 0 } }],
    'credit 恒 null（_granted 后缀才是实发），读错必漏计');
  const redeemCall = calls.filter((x) => /redeem$/.test(x.path)).pop(); // 最后一条 = 28d（成功的那个）
  const body = JSON.parse(redeemCall.body);
  assert.ok(/^u-[0-9a-f-]{36}$/.test(body.client_token), 'client_token 是 u-<uuid4> 形状');
  assert.strictEqual(body.tier, '28d');
});

test('makeupBrokenDay：无卡早退不打 heatmap；400 date is not broken 是正常竞争不报错', async () => {
  // 无卡早退：只有一次 streak 调用
  const noCardCalls = withStub([
    { match: () => true, reply: () => ({ status: 200, doc: { code: 0, data: { makeup_cards: { balance: 0, max: 4 } } } }) },
  ]);
  const r1 = await tasks.makeupBrokenDay('cn', acc);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.used, null);
  assert.match(r1.error, /没有可用补签卡/);
  assert.strictEqual(noCardCalls.length, 1, 'balance=0 直接早退，不打 heatmap');

  // 未断签（正常竞争）
  withStub([
    { match: (o) => /streak$/.test(o.path), reply: () => ({ status: 200, doc: { code: 0, data: { streak: { makeup_dates: [] }, makeup_cards: { balance: 2, max: 4 } } } }) },
    { match: (o) => /heatmap$/.test(o.path), reply: () => ({ status: 200, doc: { code: 0, data: { today: { date: '2026-11-28' }, cells: [{ date: '2026-11-20', score: 0 }] } } }) },
    { match: (o) => /makeup-cards\/use$/.test(o.path), reply: () => ({ status: 400, doc: { code: 400, msg: 'date is not broken, no makeup needed' } }) },
  ]);
  const r2 = await tasks.makeupBrokenDay('cn', acc);
  assert.strictEqual(r2.ok, true, '正常竞争不算失败');
  assert.strictEqual(r2.used, null, '不冒认补签成功');
  assert.match(r2.error, /正常竞争/);

  // 成功：body 字段名是 target_date（探针定案，date 变体被上游拒）
  const calls = withStub([
    { match: (o) => /streak$/.test(o.path), reply: () => ({ status: 200, doc: { code: 0, data: { streak: { makeup_dates: [] }, makeup_cards: { balance: 2, max: 4 } } } }) },
    { match: (o) => /heatmap$/.test(o.path), reply: () => ({ status: 200, doc: { code: 0, data: { today: { date: '2026-11-28' }, cells: [{ date: '2026-11-13', score: 0 }, { date: '2026-11-20', score: 0 }] } } }) },
    { match: (o) => /makeup-cards\/use$/.test(o.path), reply: () => ({ status: 200, doc: { code: 0, msg: 'OK', data: { cards_granted: 1 } } }) },
  ]);
  const r3 = await tasks.makeupBrokenDay('cn', acc);
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(r3.used, '2026-11-20', '最近断点优先，每轮 ≤1 张');
  const makeupCall = calls.find((x) => /makeup-cards\/use$/.test(x.path));
  assert.deepStrictEqual(JSON.parse(makeupCall.body), { target_date: '2026-11-20' }, '字段名是 target_date');
  assert.strictEqual(r3.granted, 1);
});

test('sweepEnabled：默认关（写操作独立开关纪律）', () => {
  const old = process.env.DUMATE_WORKBUDDY_TASKS_SWEEP;
  try {
    delete process.env.DUMATE_WORKBUDDY_TASKS_SWEEP;
    assert.strictEqual(tasks.sweepEnabled(), false);
    process.env.DUMATE_WORKBUDDY_TASKS_SWEEP = '1';
    assert.strictEqual(tasks.sweepEnabled(), true);
    process.env.DUMATE_WORKBUDDY_TASKS_SWEEP = '0';
    assert.strictEqual(tasks.sweepEnabled(), false);
  } finally {
    if (old === undefined) delete process.env.DUMATE_WORKBUDDY_TASKS_SWEEP; else process.env.DUMATE_WORKBUDDY_TASKS_SWEEP = old;
  }
});
