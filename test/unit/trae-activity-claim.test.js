// test/unit/trae-activity-claim.test.js - TRAE 活动/权益领取（2026-11-01）
//
// 判据全部取自 traework2api-panel 的 ClaimActivities（5 个真号 × 两个 host
// 实测，见 constants.EP_ACTIVITY_INFO 注释）。纯函数离线验证，不打上游。
const { test } = require('node:test');
const assert = require('node:assert');
const checkin = require('../../src/traework/checkin');

const NOW = 1793550000000; // 固定「当前时间」，时间窗断言可复现

test('parseActivityList：只留启用且在有效期内的', () => {
  const d = { commercial_activities: [
    { activity_id: 'fission_live', activity_type: 103, Enabled: true, start_time_ms: 1, end_time_ms: NOW + 1000 },
    { activity_id: 'fission_dead', activity_type: 103, Enabled: true, start_time_ms: 1, end_time_ms: 2 },
    { activity_id: 'fission_off', activity_type: 103, Enabled: false },
    { activity_id: 'checkin_x', activity_type: 104, Enabled: true },
    { activity_id: '', activity_type: 105, Enabled: true },
    null,
  ] };
  const out = checkin.parseActivityList(d, NOW);
  assert.deepEqual(out.map((x) => x.activityId), ['fission_live', 'checkin_x']);
  assert.equal(out[0].kind, 'work_fission');
  // start 在未来的也过滤
  const out2 = checkin.parseActivityList({ commercial_activities: [
    { activity_id: 'future', activity_type: 105, Enabled: true, start_time_ms: NOW + 1000 },
  ] }, NOW);
  assert.deepEqual(out2, []);
});

test('parseActivityList：start/end 为 0 视为不限（panel 同口径）', () => {
  const out = checkin.parseActivityList({ commercial_activities: [
    { activity_id: 'a105', activity_type: 105, enabled: true, start_time_ms: 0, end_time_ms: 0 },
  ] }, NOW);
  assert.equal(out.length, 1);
  // 小写 enabled 形态也认
  assert.equal(out[0].activityId, 'a105');
});

test('claimVerdict：code=0 + granted=true + grantable=false = 已领过（不报警）', () => {
  const v = checkin.claimVerdict(0, '', { granted: true, grantable: false, prize_text: '测试券' });
  assert.equal(v.state, 'granted');
  assert.equal(v.prizeText, '测试券');
});

test('claimVerdict：code=0 + granted=true（grantable 未给）= 本次领到', () => {
  const v = checkin.claimVerdict(0, '', { granted: true, prize_text: '' });
  assert.equal(v.state, 'claimed');
  assert.equal(v.prizeText, null);
});

test('claimVerdict：9069/9090/9070 是「现在领不到」不是失败', () => {
  for (const code of checkin.GRANT_PENDING_CODES) {
    assert.equal(checkin.claimVerdict(code, '活动暂不可用', null).state, 'pending');
  }
  // panel 实测的三个码一个不多一个不少
  assert.deepEqual([...checkin.GRANT_PENDING_CODES].sort(), [9069, 9070, 9090]);
});

test('claimVerdict：其他非 0 code 是真失败；code=0 无 work_extra 是 noop', () => {
  const e = checkin.claimVerdict(4001, 'param invalid', null);
  assert.equal(e.state, 'error');
  assert.ok(e.error.includes('4001'));
  assert.equal(checkin.claimVerdict(0, '', null).state, 'noop');
  // student_auth_reward 实测：受理了但没有 work_extra 可报
  assert.equal(checkin.claimVerdict(0, '', {}).state, 'noop');
});

test('claimVerdict：granted=false + grantable=false 也归已领（不发不报的变体）', () => {
  const v = checkin.claimVerdict(0, '', { granted: false, grantable: false });
  assert.equal(v.state, 'granted');
  // granted=false + grantable=true：受理但没发，按 pending（下一轮再试）
  assert.equal(checkin.claimVerdict(0, '', { granted: false, grantable: true }).state, 'pending');
});
