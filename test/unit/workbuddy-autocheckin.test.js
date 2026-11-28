// test/unit/workbuddy-autocheckin.test.js - 自动签到调度（P0-1）
//
// 调研文件 docs/WORKBUDDY-FUSION.md P0-1：此前只有手动 /checkin，没有排程。
// 本套件锁住四条生产口径（都是 hawklithm 跑在生产上的设计，放宽任何一条都会
// 变成「白打上游请求」或「白掉一天积分」）：
//   1. 每日时点 + 只后延的随机抖动；今天时点已过且没跑过 → 补跑
//   2. 打开开关立即跑一轮；关掉开关取消排程
//   3. 已签跳过 / 状态未知**不签** / 国际版不处理
//   4. 签成写统一签到账本，失败如实进结果不伪造
//
// 全程打桩：statusOf / claimOf / accounts / perAccountDelayMs 都从 runOnce 的
// opts 注入，不碰网络、不碰真实账号文件（authStore 也可注入）。
// 运行：node --test test/unit/workbuddy-autocheckin.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-wb-autock');
process.env.DUMATE_ADMIN_DATA = TMP;

const autock = require('../../src/workbuddy/autocheckin');
const ledger = require('../../src/checkin-ledger');

function fakeStore() {
  return {
    patches: [],
    async ensureFresh(a) { return a; },
    patch(id, f) { this.patches.push({ id, f }); },
  };
}

const CN = (id, uid) => ({ id, uid, region: 'cn', nickname: `cn-${id}`, enabled: true });
const INTL = (id, uid) => ({ id, uid, region: 'global', nickname: `intl-${id}`, enabled: true });

test('computeNextRunAt：今天时点未到 → 就是今天；已过/恰好 → 明天；抖动只后延', () => {
  const cfg = { hour: 0, minute: 0, jitter_minutes: 10 };
  const at = new Date(2026, 10, 8, 0, 0, 0, 0).getTime();       // 2026-11-08 00:00 本地
  // 边界语义：`at <= now` 一律翻到明天，所以「恰好等于时点」也算过去（补跑
  // 判据 shouldCatchup 用 `>` 承接这一格，两者只允许一处补跑）
  assert.strictEqual(autock.computeNextRunAt(at, cfg, () => 0), at + 24 * 3600 * 1000,
    '恰好等于时点 → 排到明天（今天那一格交给 shouldCatchup）');

  const before = at - 60 * 1000;                                  // 前一天 23:59
  assert.strictEqual(autock.computeNextRunAt(before, cfg, () => 0), at);

  // 抖动上限：rng() 趋近 1 时为 10 分钟
  const delayed = autock.computeNextRunAt(before, cfg, () => 0.9999);
  assert.ok(delayed > at, '抖动只把时刻往后推');
  assert.ok(delayed - at < 10 * 60 * 1000 + 1, '抖动不超过 jitter_minutes');
});

test('shouldCatchup：今天时点已过且今天没跑过 → 补；跑过 → 不补；关着 → 不补', () => {
  const cfg = { enabled: true, hour: 0, minute: 0, jitter_minutes: 0 };
  const now = new Date(2026, 10, 8, 9, 0, 0, 0).getTime();
  assert.strictEqual(autock.shouldCatchup(now, cfg, null), true);
  assert.strictEqual(autock.shouldCatchup(now, cfg, new Date(2026, 10, 8, 0, 30).getTime()), false);
  assert.strictEqual(autock.shouldCatchup(now, cfg, new Date(2026, 10, 7, 0, 30).getTime()), true, '昨天跑过不代表今天补过');
  assert.strictEqual(autock.shouldCatchup(now, { ...cfg, enabled: false }, null), false);
  const early = new Date(2026, 10, 8, 0, 0, 0, 0).getTime();
  assert.strictEqual(autock.shouldCatchup(early, { ...cfg, hour: 23 }, null), false, '时点还早 → 不补');
});

test('decideCheckin：已签跳过 / 可签 / 未知状态不签 / 国际版不支持', () => {
  assert.strictEqual(autock.decideCheckin({ ok: true, todayCheckedIn: true }), 'already');
  assert.strictEqual(autock.decideCheckin({ ok: true, todayCheckedIn: false }), 'claim');
  assert.strictEqual(autock.decideCheckin({ ok: false, error: 'boom' }), 'unknown');
  assert.strictEqual(autock.decideCheckin({ ok: true }), 'unknown', '缺 todayCheckedIn 字段也是未知');
  assert.strictEqual(autock.decideCheckin({ unsupported: true, error: '不支持' }), 'unsupported');
  assert.strictEqual(autock.decideCheckin(null), 'unknown');
});

test('runOnce：已签跳过、未知状态不签、只签可签的；账本只记签成的', async () => {
  const accounts = [CN(1), CN(2), CN(3)];
  const claimed = [];
  const store = fakeStore();
  const r = await autock.runOnce('manual', {
    accounts,
    authStore: store,
    perAccountDelayMs: 0,
    activityReporter: null,   // 本用例只验签到路径，活跃上报另有用例
    statusOf: async (a) => {
      if (a.id === 1) return { ok: true, todayCheckedIn: true, streakDays: 5 };
      if (a.id === 2) return { ok: false, error: '上游 500' };
      return { ok: true, todayCheckedIn: false, dailyCredit: 20 };
    },
    claimOf: async (a) => { claimed.push(a.id); return { ok: true }; },
  });
  assert.deepStrictEqual(claimed, [3], '只有状态为「未签」的账号才真去签');
  assert.strictEqual(r.accounts, 3);
  assert.strictEqual(r.claimed, 1);
  assert.strictEqual(r.already, 1);
  assert.strictEqual(r.unknown, 1);
  const byId = Object.fromEntries(r.results.map((x) => [x.id, x]));
  assert.strictEqual(byId[1].action, 'already');
  assert.strictEqual(byId[2].action, 'unknown');
  assert.ok(/上游 500/.test(byId[2].error), '未知状态要把原因带出来');
  assert.strictEqual(byId[3].action, 'claim');

  const rows = ledger.readAll().filter((x) => x.channel === 'workbuddy');
  assert.strictEqual(rows.length, 1, '只记「签成了」的那一条');
  assert.strictEqual(Number(rows[0].account_id), 3);
  assert.strictEqual(rows[0].credits, 20);
  assert.ok(store.patches.some((p) => p.id === 3 && p.f.lastCheckin), '签成要落 lastCheckin');
});

test('runOnce：国际版账号不进签到队列（不白打签到接口）', async () => {
  let touched = [];
  const r = await autock.runOnce('manual', {
    accounts: [CN(1), INTL(2)],
    authStore: fakeStore(),
    perAccountDelayMs: 0,
    // 关掉网页打卡：本用例只验「签到队列里没有国际版」
    webAgent: null,
    activityReporter: null,
    statusOf: async (a) => { touched.push(a.id); return { ok: true, todayCheckedIn: true }; },
    claimOf: async () => ({ ok: true }),
  });
  assert.deepStrictEqual(touched, [1], '只处理 cn 账号');
  assert.strictEqual(r.accounts, 1);
  assert.strictEqual(r.region, 'cn');
});

test('runOnce：国际版走网页打卡（webagent 此前全库无调用方）', async () => {
  const webCalls = [];
  const r = await autock.runOnce('manual', {
    // 用不与其它用例冲突的 id：账本按 channel+账号+日期幂等，同 id 会串用例
    accounts: [CN(1), INTL(92), INTL(93)],
    authStore: fakeStore(),
    perAccountDelayMs: 0,
    activityReporter: null,
    statusOf: async () => ({ ok: true, todayCheckedIn: false, dailyCredit: 10 }),
    claimOf: async () => ({ ok: true }),
    webAgent: async (a) => {
      webCalls.push(a.id);
      if (a.id === 93) return { ok: false, error: '网页会话超时', skipped: false };
      return { ok: true, skipped: false, msg: '网页会话跑完' };
    },
  });
  assert.deepStrictEqual(webCalls, [92, 93], '两个国际号各打一次，国内号不打');
  assert.strictEqual(r.webDaily, 1, '92 号打卡成功');
  assert.strictEqual(r.webDailyFailed, 1, '93 号失败如实计数');
  assert.strictEqual(r.claimed, 1, '国内号签成');
  const byId = Object.fromEntries(r.results.map((x) => [x.id, x]));
  assert.strictEqual(byId[92].action, 'web-daily', '国际版的动作名要区分于签到');
  assert.match(byId[93].error, /超时/);
  // 国内号的签到账本只有它自己（网页打卡不写签到账本——不是同一种上游动作）。
  // 只断言「国际号没有」：同一天前面用例可能也写了自己的行（账本按
  // channel+账号+日期幂等，不隔离用例）。
  const rows = ledger.readAll().filter((x) => x.channel === 'workbuddy');
  assert.ok(!rows.some((x) => Number(x.account_id) === 92 || Number(x.account_id) === 93),
    '网页打卡不该进签到账本');
});

test('runOnce：opts.region 指定区域时不做网页打卡（单区域轮）', async () => {
  let webCalls = 0;
  await autock.runOnce('manual', {
    accounts: [CN(1), INTL(2)],
    authStore: fakeStore(),
    perAccountDelayMs: 0,
    region: 'cn',
    activityReporter: null,
    statusOf: async () => ({ ok: true, todayCheckedIn: true }),
    claimOf: async () => ({ ok: true }),
    webAgent: async () => { webCalls++; return { ok: true }; },
  });
  assert.strictEqual(webCalls, 0, '限定区域时不该顺手打国际版的网页会话');
});

test('runOnce：签到失败如实记结果并写 lastError，不写账本', async () => {
  ledger.appendMany([]);   // 触发一次 mkdir，避免首次写盘路径差异
  const before = ledger.readAll().filter((x) => x.channel === 'workbuddy').length;
  const store = fakeStore();
  const r = await autock.runOnce('manual', {
    accounts: [CN(7)],
    authStore: store,
    perAccountDelayMs: 0,
    activityReporter: null,
    statusOf: async () => ({ ok: true, todayCheckedIn: false }),
    claimOf: async () => ({ ok: false, error: 'code=500 服务繁忙' }),
  });
  assert.strictEqual(r.failed, 1);
  assert.strictEqual(r.claimed, 0);
  assert.ok(/服务繁忙/.test(r.results[0].error));
  assert.ok(store.patches.some((p) => p.id === 7 && /服务繁忙/.test(p.f.lastError || '')),
    '失败要写 lastError（账号卡上才看得见）');
  const after = ledger.readAll().filter((x) => x.channel === 'workbuddy').length;
  assert.strictEqual(after, before, '失败不记账本');
});

test('runOnce：国内对话活跃上报（第三腿，与签到并列）', async () => {
  const actCalls = [];
  const r = await autock.runOnce('manual', {
    accounts: [CN(41), CN(42)],
    authStore: fakeStore(),
    perAccountDelayMs: 0,
    webAgent: null,
    statusOf: async (a) => (a.id === 41
      ? { ok: true, todayCheckedIn: false, dailyCredit: 20 }   // 41 要签到
      : { ok: false, error: '状态查询失败' }),                  // 42 未知不签
    claimOf: async () => ({ ok: true }),
    activityReporter: async (a) => {
      actCalls.push(a.id);
      if (a.id === 42) return { ok: false, error: '/v2/report 500' };
      return { ok: true, verified: true, skipped: false, streakDays: 4, msg: '连续打卡 4 天' };
    },
  });
  assert.deepStrictEqual(actCalls, [41, 42], '两个国内号都要上报活跃（与签到成败无关）');
  assert.strictEqual(r.activity, 1, '41 上报且回读成功');
  assert.strictEqual(r.activityFailed, 1, '42 失败如实计数');
  assert.strictEqual(r.activityUnverified, 0);
  assert.strictEqual(r.claimed, 1, '签到与活跃互不影响');
  // 同一账号会出现两行（签到 + 活跃），不能 Object.fromEntries 只留最后一条
  const rowOf = (id, action) => r.results.find((x) => x.id === id && x.action === action);
  const claim41 = rowOf(41, 'claim');
  assert.ok(claim41, '41 的签到结果照旧');
  assert.strictEqual(claim41.ok, true);
  const act41 = rowOf(41, 'activity');
  assert.strictEqual(act41.streakDays, 4, '连登天数来自活跃上报的回读');
  assert.ok(rowOf(42, 'unknown'), '42 签到仍是未知不签');
  assert.ok(rowOf(42, 'activity'), '42 活跃也照跑');
  // 42 出现了两条：一条 unknown（签到）、一条 activity（活跃）——两件事各记一行
  const fortyTwo = r.results.filter((x) => x.id === 42);
  assert.strictEqual(fortyTwo.length, 2);
  assert.deepStrictEqual(fortyTwo.map((x) => x.action).sort(), ['activity', 'unknown']);
});

test('runOnce：活跃「送达但未验证」不冒充成功（真机 /v2/report 对假 token 也回 code=0）', async () => {
  const r = await autock.runOnce('manual', {
    accounts: [CN(61)],
    authStore: fakeStore(),
    perAccountDelayMs: 0,
    webAgent: null,
    statusOf: async () => ({ ok: true, todayCheckedIn: true }),
    claimOf: async () => ({ ok: true }),
    // 上游回 code=0 但 /activity/growth/streak 401 → verified=false
    activityReporter: async () => ({
      ok: true, verified: false, skipped: false, streakDays: null,
      msg: '活跃事件已送达上游（code=0），但连登天数回读失败——无法验证是否真的计入',
      error: '连登回读失败（/activity/growth/streak 未返回天数；凭证或该端点权限可能有问题）',
    }),
  });
  assert.strictEqual(r.activity, 0, '未验证不能算成功');
  assert.strictEqual(r.activityUnverified, 1, '要单列出来，不能吞掉');
  const row = r.results.find((x) => x.action === 'activity');
  assert.strictEqual(row.verified, false);
  assert.ok(/无法验证/.test(row.msg));
  assert.ok(row.error, '未验证必须带原因');
});
test('runOnce：活跃上报抛异常不拖垮签到（第三腿隔离）', async () => {
  const r = await autock.runOnce('manual', {
    accounts: [CN(51)],
    authStore: fakeStore(),
    perAccountDelayMs: 0,
    webAgent: null,
    statusOf: async () => ({ ok: true, todayCheckedIn: false, dailyCredit: 20 }),
    claimOf: async () => ({ ok: true }),
    activityReporter: async () => { throw new Error('boom'); },
  });
  assert.strictEqual(r.claimed, 1, '签到不受活跃上报异常影响');
  assert.strictEqual(r.activityFailed, 1);
  assert.match(r.results.find((x) => x.action === 'activity').error, /boom/);
});
test('runOnce：并发保护（running 时第二轮直接跳过）', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = autock.runOnce('manual', {
    accounts: [CN(1)],
    authStore: fakeStore(),
    perAccountDelayMs: 0,
    activityReporter: null,
    statusOf: async () => { await gate; return { ok: true, todayCheckedIn: true }; },
    claimOf: async () => ({ ok: true }),
  });
  await new Promise((r) => setTimeout(r, 5));
  const second = await autock.runOnce('manual', {
    accounts: [CN(1)], authStore: fakeStore(), perAccountDelayMs: 0,
    statusOf: async () => ({ ok: true, todayCheckedIn: true }),
    claimOf: async () => ({ ok: true }),
  });
  assert.deepStrictEqual(second, { skipped: 'already_running' });
  release();
  await first;
});

test('configure：打开时立即跑一轮；关掉时取消排程', async () => {
  autock.stop();
  // 打开：enabled=true 会 fire-and-forget 一轮 runOnce('enable')。
  // 没有真实账号 → 空跑，但 last_run_at 必须被写上（否则界面看不出「执行过」）。
  autock.configure({ enabled: true });
  await new Promise((r) => setTimeout(r, 50));
  const s1 = autock.snapshot();
  assert.strictEqual(s1.enabled, true);
  assert.ok(s1.next_run_at > Date.now(), '打开后应有下一次触发时刻');
  assert.ok(s1.last_run_at, '打开开关应立即跑一轮（哪怕 0 个账号）');

  autock.configure({ enabled: false });
  const s2 = autock.snapshot();
  assert.strictEqual(s2.enabled, false);
  assert.strictEqual(s2.next_run_at, null, '关掉后不该还有排程');
});

test('configure：参数越界 400 式抛错（不静默吞成默认值）', () => {
  assert.throws(() => autock.configure({ hour: 24 }), /hour/);
  assert.throws(() => autock.configure({ minute: 60 }), /minute/);
  assert.throws(() => autock.configure({ jitter_minutes: 121 }), /jitter_minutes/);
  autock.configure({ enabled: false, hour: 0, minute: 0, jitter_minutes: 10 });
});

test('配置落盘并在新进程读回（重启不丢开关）', () => {
  autock.configure({ enabled: true, hour: 3, minute: 7, jitter_minutes: 5 });
  const disk = JSON.parse(fs.readFileSync(path.join(TMP, autock.CONFIG_FILE), 'utf8'));
  assert.strictEqual(disk.enabled, true);
  assert.strictEqual(disk.hour, 3);
  assert.strictEqual(disk.minute, 7);
  assert.strictEqual(disk.jitter_minutes, 5);
  autock.configure({ enabled: false, hour: 0, minute: 0, jitter_minutes: 10 });
});

// ---- 第四腿（成长任务清扫，P0-6；taskSweeper 注入接管，开关不陪 env 玩）----

test('runOnce：第四腿默认关——taskSweeper 不注入且 env 未开时不产生 tasks 行', async () => {
  const r = await autock.runOnce('manual', {
    accounts: [CN(51)],
    authStore: fakeStore(),
    perAccountDelayMs: 0,
    webAgent: null,
    activityReporter: null,
    statusOf: async () => ({ ok: true, todayCheckedIn: true }),
    claimOf: async () => ({ ok: true }),
    // taskSweeper 缺省 → env 开关判定（测试环境未设 DUMATE_WORKBUDDY_TASKS_SWEEP → 关）
  });
  assert.strictEqual(r.results.filter((x) => x.action === 'tasks').length, 0, '开关没开就没有第四腿');
  assert.strictEqual(r.tasksClaimed, 0);
});

test('runOnce：第四腿注入即跑——计数进汇总、企业号跳过不调清扫器', async () => {
  const swept = [];
  const sweeper = async (a) => {
    swept.push(a.id);
    if (a.id === 31) {
      return {
        sweep: { ok: true, accepted: ['t1'], claimed: [{ code: 't1', credit: 20, energy: 1, verified: true }], unverified: [], skipped: [], error: '' },
        redeem: { ok: true, redeemed: [{ tier: '14d', granted: { credit: 300, energy: 10, cards: 1, chances: 0 } }], skipped: [] },
      };
    }
    return { sweep: { ok: true, accepted: [], claimed: [], unverified: [], skipped: [], error: '' }, redeem: { ok: true, redeemed: [], skipped: [] } };
  };
  const r = await autock.runOnce('manual', {
    accounts: [CN(31), { ...CN(32), enterpriseId: 'corp-x' }],
    authStore: fakeStore(),
    perAccountDelayMs: 0,
    webAgent: null,
    activityReporter: null,
    statusOf: async () => ({ ok: true, todayCheckedIn: true }),
    claimOf: async () => ({ ok: true }),
    taskSweeper: sweeper,
  });
  assert.deepStrictEqual(swept, [31], '企业号（enterpriseId 非空）不调清扫器');
  const taskRows = r.results.filter((x) => x.action === 'tasks');
  assert.strictEqual(taskRows.length, 2);
  const byId = Object.fromEntries(taskRows.map((x) => [x.id, x]));
  assert.strictEqual(byId[31].claimed, 1);
  assert.strictEqual(byId[31].redeemed, 1);
  assert.strictEqual(byId[32].skipped, true, '企业号行如实标注，不冒充清扫成功');
  assert.strictEqual(r.tasksAccepted, 1);
  assert.strictEqual(r.tasksClaimed, 1);
  assert.strictEqual(r.tasksRedeemed, 1);
  assert.strictEqual(r.tasksUnverified, 0);
});

test('runOnce：第四腿失败如实计数（清扫器抛错 → tasksFailed）', async () => {
  const r = await autock.runOnce('manual', {
    accounts: [CN(41)],
    authStore: fakeStore(),
    perAccountDelayMs: 0,
    webAgent: null,
    activityReporter: null,
    statusOf: async () => ({ ok: true, todayCheckedIn: true }),
    claimOf: async () => ({ ok: true }),
    taskSweeper: async () => { throw new Error('网络炸了'); },
  });
  const row = r.results.find((x) => x.action === 'tasks');
  assert.strictEqual(row.ok, false);
  assert.match(row.error, /清扫无结果/);
  assert.strictEqual(r.tasksFailed, 1);
});
