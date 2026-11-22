// test/unit/qoder-autocheckin.test.js - Qoder 自动签到排程（P0-1）
//
// 调研出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P0-1。
// 比 WorkBuddy 那条更急的原因：Qoder **零额度时聊天是挂起而不是报错**
// （session.fetchQuota 注释），漏签 = 通道直接不可用，用户只看到「点了没反应」。
//
// 锁住的五条口径（放宽任何一条都会变成白打上游或白掉一天积分）：
//   1. 时点 + 只后延的抖动；今天时点已过且没跑过 → 补跑
//   2. 打开开关立即跑一轮；关掉开关取消排程
//   3. 已签跳过 / **状态未知不签** / 无可领活动 = skipped（有意不重试）
//   4. 失败当日退避 30 分钟再试，跨日重置
//   5. 签成写统一签到账本，失败如实进结果不伪造
//
// 全程打桩：statusOf / claimOf / refreshOf / accounts 都从 runOnce 的 opts 注入，
// 不碰网络、不碰真实账号文件。
// 运行：node --test test/unit/qoder-autocheckin.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-qoder-autock');
process.env.DUMATE_ADMIN_DATA = TMP;

const autock = require('../../src/qoder/autocheckin');
const ledger = require('../../src/checkin-ledger');

const CN = (id, uid) => ({ id, uid: uid || `uid-${id}`, region: 'cn', nickname: `cn-${id}`, enabled: true });
const INTL = (id) => ({ id, uid: `uid-intl-${id}`, region: 'global', nickname: `intl-${id}`, enabled: true });

function fakeStore() {
  return {
    patches: [],
    patch(id, f) { this.patches.push({ id, f }); },
    findUsable() { return []; },
  };
}

test('computeNextRunAt：今天时点未到 → 今天；已过/恰好 → 明天；抖动只后延', () => {
  const cfg = { hour: 10, minute: 15, jitter_minutes: 10 };
  const at = new Date(2026, 10, 8, 10, 15, 0, 0).getTime();
  assert.strictEqual(autock.computeNextRunAt(at, cfg, () => 0), at + 24 * 3600 * 1000,
    '恰好等于时点 → 排到明天（今天那一格交给 shouldCatchup）');
  const before = at - 60 * 1000;
  assert.strictEqual(autock.computeNextRunAt(before, cfg, () => 0), at);
  const delayed = autock.computeNextRunAt(before, cfg, () => 0.9999);
  assert.ok(delayed > at, '抖动只把时刻往后推');
  assert.ok(delayed - at < 10 * 60 * 1000 + 1, '抖动不超过 jitter_minutes');
});

test('默认时点 10:15（上游活动 10:00 UTC+8 刷新后 15 分钟）', () => {
  const d = autock.DEFAULTS;
  assert.strictEqual(d.hour, 10);
  assert.strictEqual(d.minute, 15);
  assert.strictEqual(d.enabled, false, '开关默认关——自动打上游必须显式开启');
});

test('shouldCatchup：今天时点已过且今天没跑过 → 补；跑过/关着/时点还早 → 不补', () => {
  const cfg = { enabled: true, hour: 10, minute: 15, jitter_minutes: 0 };
  const now = new Date(2026, 10, 8, 15, 0, 0, 0).getTime();
  assert.strictEqual(autock.shouldCatchup(now, cfg, null), true);
  assert.strictEqual(autock.shouldCatchup(now, cfg, new Date(2026, 10, 8, 10, 20).getTime()), false);
  assert.strictEqual(autock.shouldCatchup(now, cfg, new Date(2026, 10, 7, 10, 20).getTime()), true, '昨天跑过不代表今天补过');
  assert.strictEqual(autock.shouldCatchup(now, { ...cfg, enabled: false }, null), false);
  assert.strictEqual(autock.shouldCatchup(new Date(2026, 10, 8, 8, 0).getTime(), cfg, null), false, '时点还早 → 不补');
});

test('decideCheckin：已签 / 可签 / 无可领活动 skipped / 未知不签', () => {
  assert.strictEqual(autock.decideCheckin({ ok: true, checkedIn: true }), 'already');
  assert.strictEqual(autock.decideCheckin({ ok: true, checkedIn: false, pending: 100 }), 'claim');
  assert.strictEqual(autock.decideCheckin({ ok: true, checkedIn: null, campaigns: 0 }), 'skipped',
    '一个活动都没有 = 当天无可领，不是失败也不重试');
  assert.strictEqual(autock.decideCheckin({ ok: true, checkedIn: null, campaigns: 3 }), 'unknown',
    '有活动却判不出状态 → 未知，不猜');
  assert.strictEqual(autock.decideCheckin({ ok: false, error: 'boom' }), 'unknown');
  assert.strictEqual(autock.decideCheckin(null), 'unknown');
});

test('withinBackoff：同一自然日内 30 分钟退避；跨日立即重置', () => {
  const now = new Date(2026, 10, 8, 10, 20, 0, 0).getTime();
  assert.strictEqual(autock.withinBackoff(0, now), false, '没失败过');
  assert.strictEqual(autock.withinBackoff(new Date(2026, 10, 8, 10, 0).getTime(), now), true, '20 分钟前失败 → 退避中');
  assert.strictEqual(autock.withinBackoff(new Date(2026, 10, 8, 9, 40).getTime(), now), false, '40 分钟前失败 → 已过退避');
  assert.strictEqual(autock.withinBackoff(new Date(2026, 10, 7, 10, 19).getTime(), now), false,
    '昨天的失败（不到 30 分钟跨日）不挡今天');
});

test('runOnce：已签跳过、未知不签、skipped 不重试，只签可签的', async () => {
  autock.state.failures = {};
  const accounts = [CN(1), CN(2), CN(3), CN(4)];
  const claimedIds = [];
  const r = await autock.runOnce('manual', {
    accounts,
    authStore: fakeStore(),
    perAccountDelayMs: 0,
    refreshOf: async (a) => a,
    statusOf: async (a) => {
      if (a.id === 1) return { ok: true, checkedIn: true, campaigns: 1, claimed: 1 };
      if (a.id === 2) return { ok: false, error: '上游 500' };
      if (a.id === 3) return { ok: true, checkedIn: null, campaigns: 0 };
      return { ok: true, checkedIn: false, pending: 100, campaigns: 1 };
    },
    claimOf: async (a) => {
      claimedIds.push(a.id);
      return { ok: true, gained: 100, claimed: [{ ok: true, grantId: `g-${a.id}` }] };
    },
  });
  assert.deepStrictEqual(claimedIds, [4], '只有「明确未签」的账号才真去领');
  assert.strictEqual(r.accounts, 4);
  assert.strictEqual(r.claimed, 1);
  assert.strictEqual(r.already, 1);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(r.unknown, 1);
  assert.strictEqual(r.failed, 0, 'unknown/skipped 不是失败（没做错事）');
  const byId = Object.fromEntries(r.results.map((x) => [x.id, x]));
  assert.strictEqual(byId[1].action, 'already');
  assert.strictEqual(byId[2].action, 'unknown');
  assert.ok(/上游 500/.test(byId[2].error), '未知状态要把原因带出来');
  assert.strictEqual(byId[3].action, 'skipped');
  assert.strictEqual(byId[4].action, 'claim');
  assert.strictEqual(byId[4].gained, 100);

  const rows = ledger.readAll().filter((x) => x.channel === 'qoder');
  assert.strictEqual(rows.length, 1, '只记「签成了」的那一条');
  assert.strictEqual(Number(rows[0].account_id), 4);
  assert.strictEqual(rows[0].credits, 100);
});

test('runOnce：国际版默认不进签到队列（campaigns 只在 cn 有活动）', async () => {
  autock.state.failures = {};
  const touched = [];
  const r = await autock.runOnce('manual', {
    accounts: [CN(11), INTL(12)],
    authStore: fakeStore(),
    perAccountDelayMs: 0,
    refreshOf: async (a) => a,
    statusOf: async (a) => { touched.push(a.id); return { ok: true, checkedIn: true, campaigns: 1 }; },
    claimOf: async () => ({ ok: true }),
  });
  assert.deepStrictEqual(touched, [11], '只处理 cn 账号');
  assert.strictEqual(r.region, 'cn');
});

test('runOnce：include_intl 打开后国际号也查（查空按 skipped）', async () => {
  autock.state.include_intl = true;
  autock.state.failures = {};
  const touched = [];
  try {
    const r = await autock.runOnce('manual', {
      accounts: [CN(21), INTL(22)],
      authStore: fakeStore(),
      perAccountDelayMs: 0,
      refreshOf: async (a) => a,
      statusOf: async (a) => {
        touched.push(a.id);
        if (a.region === 'global') return { ok: true, checkedIn: null, campaigns: 0 };
        return { ok: true, checkedIn: true, campaigns: 1 };
      },
      claimOf: async () => ({ ok: true }),
    });
    assert.deepStrictEqual(touched.sort(), [21, 22]);
    assert.strictEqual(r.skipped, 1, '国际号无可领活动 → skipped');
  } finally {
    autock.state.include_intl = false;
  }
});

test('runOnce：换票失败如实报 refresh 动作，不静默当未知状态', async () => {
  const store = fakeStore();
  const r = await autock.runOnce('manual', {
    accounts: [CN(31)],
    authStore: store,
    perAccountDelayMs: 0,
    refreshOf: async () => { throw new Error('refresh token 已失效'); },
    statusOf: async () => ({ ok: true, checkedIn: false }),
    claimOf: async () => ({ ok: true }),
  });
  assert.strictEqual(r.results[0].action, 'refresh');
  assert.strictEqual(r.results[0].ok, false);
  assert.match(r.results[0].error, /refresh token 已失效/);
  assert.strictEqual(r.claimed, 0);
});

test('runOnce：签到失败当日进退避，第二轮跳过不白打上游', async () => {
  autock.state.failures = {};
  const store = fakeStore();
  let claimCalls = 0;
  const opts = {
    accounts: [CN(41)],
    authStore: store,
    perAccountDelayMs: 0,
    refreshOf: async (a) => a,
    statusOf: async () => ({ ok: true, checkedIn: false, pending: 100 }),
    claimOf: async () => { claimCalls++; return { ok: false, error: 'code=500 服务繁忙' }; },
  };
  const r1 = await autock.runOnce('manual', opts);
  assert.strictEqual(r1.failed, 1);
  assert.ok(/服务繁忙/.test(r1.results[0].error));
  assert.ok(autock.state.failures[41], '失败要记下时刻');

  // 同一轮之后（还没过 30 分钟）再来一轮：应当被退避挡住
  const r2 = await autock.runOnce('manual', opts);
  assert.strictEqual(claimCalls, 1, '退避期内不该再打上游');
  assert.strictEqual(r2.results[0].action, 'backoff');
  assert.strictEqual(r2.backoff, 1);

  // 跨日（把失败时刻挪到昨天）后恢复
  autock.state.failures[41] = Date.now() - 25 * 3600 * 1000;
  const r3 = await autock.runOnce('manual', opts);
  assert.strictEqual(claimCalls, 2, '跨日重置后重试');
  assert.strictEqual(r3.results[0].action, 'claim');
  autock.state.failures = {};
});

test('runOnce：签成后清掉退避标记', async () => {
  autock.state.failures = { 51: Date.now() - 40 * 60 * 1000 };
  await autock.runOnce('manual', {
    accounts: [CN(51)],
    authStore: fakeStore(),
    perAccountDelayMs: 0,
    refreshOf: async (a) => a,
    statusOf: async () => ({ ok: true, checkedIn: false, pending: 100 }),
    claimOf: async () => ({ ok: true, gained: 100, claimed: [{ ok: true }] }),
  });
  assert.strictEqual(autock.state.failures[51], undefined, '签成要清掉退避（否则明天首轮会被误挡）');
});

test('runOnce：注入的 claimOf 走账本补写路径（默认路径由 index.checkinAndSave 写）', async () => {
  autock.state.failures = {};
  const before = ledger.readAll().filter((x) => x.channel === 'qoder').length;
  await autock.runOnce('manual', {
    accounts: [CN(61)],
    authStore: fakeStore(),
    perAccountDelayMs: 0,
    refreshOf: async (a) => a,
    statusOf: async () => ({ ok: true, checkedIn: false, pending: 100 }),
    claimOf: async () => ({ ok: true, gained: 50, claimed: [{ ok: true }] }),
  });
  const after = ledger.readAll().filter((x) => x.channel === 'qoder').length;
  assert.strictEqual(after, before + 1, '注入实现时本模块负责记账');
});

test('runOnce：状态说可领、领取时已无可领 → 记 already 而不是失败', async () => {
  autock.state.failures = {};
  const r = await autock.runOnce('manual', {
    accounts: [CN(71)],
    authStore: fakeStore(),
    perAccountDelayMs: 0,
    refreshOf: async (a) => a,
    statusOf: async () => ({ ok: true, checkedIn: false, pending: 100 }),
    claimOf: async () => ({ ok: true, alreadyChecked: true, claimed: [] }),
  });
  assert.strictEqual(r.results[0].action, 'already');
  assert.strictEqual(r.results[0].ok, true);
  assert.strictEqual(r.failed, 0);
});

test('runOnce：并发保护（running 时第二轮直接跳过）', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = autock.runOnce('manual', {
    accounts: [CN(81)],
    authStore: fakeStore(),
    perAccountDelayMs: 0,
    refreshOf: async (a) => a,
    statusOf: async () => { await gate; return { ok: true, checkedIn: true, campaigns: 1 }; },
    claimOf: async () => ({ ok: true }),
  });
  await new Promise((r) => setTimeout(r, 5));
  const second = await autock.runOnce('manual', {
    accounts: [CN(81)], authStore: fakeStore(), perAccountDelayMs: 0,
    statusOf: async () => ({ ok: true, checkedIn: true }), claimOf: async () => ({ ok: true }),
  });
  assert.deepStrictEqual(second, { skipped: 'already_running' });
  release();
  await first;
});

test('configure：打开时立即跑一轮；关掉时取消排程', async () => {
  autock.stop();
  autock.configure({ enabled: true });
  await new Promise((r) => setTimeout(r, 60));
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
  autock.configure({ enabled: false, hour: 10, minute: 15, jitter_minutes: 10 });
});

test('配置落盘并在新进程读回（重启不丢开关）', () => {
  autock.configure({ enabled: true, hour: 10, minute: 20, jitter_minutes: 5 });
  const disk = JSON.parse(fs.readFileSync(path.join(TMP, autock.CONFIG_FILE), 'utf8'));
  assert.strictEqual(disk.enabled, true);
  assert.strictEqual(disk.hour, 10);
  assert.strictEqual(disk.minute, 20);
  assert.strictEqual(disk.jitter_minutes, 5);
  autock.configure({ enabled: false, hour: 10, minute: 15, jitter_minutes: 10 });
});
