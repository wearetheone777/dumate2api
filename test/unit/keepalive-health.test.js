// test/unit/keepalive-health.test.js - 健康预警判据（healthAlerts）离线测试
//
// 背景（2026-11-06 清单项「登录态健康预警 UI」）：判据在后端
// keepalive.internals.healthAlerts（纯函数，吃两个内存快照），前端只着色
// 展示不重复判级——两端判据漂移的口子在这里堵死。本文件用构造快照把判据
// 表过一遍；真机造不出 401 场景（不真打上游），判据正确性由这里保证。
const test = require('node:test');
const assert = require('node:assert');

const { internals } = require('../../src/keepalive');
const { healthAlerts } = internals;

// web-pool.snapshot() 行的构造器（只带判据消费的字段）
const acct = (over = {}) => ({
  id: 1, name: '甲', enabled: true, state: 'healthy',
  cooling: false, cool_remaining_s: 0, cooldown_reason: '',
  disabled: false, disabled_reason: '',
  token_expires_in_s: 3600, ok_count: 10, fail_count: 0, last_error: '',
  ...over,
});

// keepalive.snapshot() 的裁剪版构造器
const ka = (over = {}) => ({ enabled: true, last_result: null, ...over });

const count = (alerts, level) => alerts.filter((a) => a.level === level).length;

test('全绿：健康账号 + 保活正常 → alerts 为空', () => {
  const out = healthAlerts({ ka: ka(), webAccounts: [acct()] });
  assert.deepStrictEqual(out, [], '无告警行');
});

test('红：disabled（session_dead 达阈）→ crit + 原因透出', () => {
  const out = healthAlerts({ ka: ka(), webAccounts: [acct({ disabled: true, disabled_reason: '连续 401' })] });
  assert.strictEqual(count(out, 'crit'), 1);
  assert.strictEqual(out[0].reason, 'disabled');
  assert.ok(out[0].message.includes('连续 401'), '禁用原因透传');
});

test('红：last_error 带 401/expired → cookie_dead crit', () => {
  for (const err of ['取 token 失败：HTTP 401', 'token expired']) {
    const out = healthAlerts({ ka: ka(), webAccounts: [acct({ last_error: err })] });
    assert.strictEqual(count(out, 'crit'), 1, err);
    assert.strictEqual(out[0].reason, 'cookie_dead');
  }
});

test('红：保活轮续期失败且错误串是登录态类 → refresh_auth_fail crit', () => {
  const out = healthAlerts({
    ka: ka({ last_result: { aborted: false, results: [
      { channel: 'qwenwork', uid: 'qwenwork:3', name: '乙', ok: false, skipped: false, error: 'HTTP 401 unauthorized' },
    ] } }),
    webAccounts: [],
  });
  assert.strictEqual(count(out, 'crit'), 1);
  assert.strictEqual(out[0].reason, 'refresh_auth_fail');
  assert.strictEqual(out[0].account, '乙');
});

test('黄：保活轮续期失败但错误串是网络类 → refresh_fail warn（不冤成登录态死）', () => {
  const out = healthAlerts({
    ka: ka({ last_result: { aborted: false, results: [
      { channel: 'traework', uid: 'traework:1', name: '丙', ok: false, skipped: false, error: 'timeout after 15000ms' },
    ] } }),
    webAccounts: [],
  });
  assert.strictEqual(count(out, 'warn'), 1);
  assert.strictEqual(count(out, 'crit'), 0);
  assert.strictEqual(out[0].reason, 'refresh_fail');
});

test('黄：token 余量 < 10 分钟 → token_low（带「自动续期」口径，不吓人）', () => {
  const out = healthAlerts({ ka: ka(), webAccounts: [acct({ token_expires_in_s: 300 })] });
  assert.strictEqual(count(out, 'warn'), 1);
  assert.strictEqual(out[0].reason, 'token_low');
  assert.ok(out[0].message.includes('自动续期'));
  // 余量健康（≥10min）不报
  assert.deepStrictEqual(healthAlerts({ ka: ka(), webAccounts: [acct({ token_expires_in_s: 3600 })] }), []);
});

test('黄：冷却中 → cooling，剩余分钟数换算；登录态死的不再叠冷却行', () => {
  const out = healthAlerts({ ka: ka(), webAccounts: [acct({ cooling: true, cool_remaining_s: 1800, cooldown_reason: '限流' })] });
  assert.strictEqual(count(out, 'warn'), 1);
  assert.strictEqual(out[0].reason, 'cooling');
  assert.ok(out[0].message.includes('30 分钟'));
  assert.ok(out[0].message.includes('限流'));
  // cookie 死 + 冷却：只有一条 crit（continue 短路，不给一个账号挂两行）
  const dead = healthAlerts({ ka: ka(), webAccounts: [acct({ cooling: true, last_error: 'HTTP 401' })] });
  assert.strictEqual(dead.length, 1);
  assert.strictEqual(dead[0].level, 'crit');
});

test('黄：保活排程未启用 → keepalive_off 提示；被中断的轮 → keepalive_aborted', () => {
  const off = healthAlerts({ ka: ka({ enabled: false }), webAccounts: [] });
  assert.strictEqual(off.length, 1);
  assert.strictEqual(off[0].reason, 'keepalive_off');
  const aborted = healthAlerts({
    ka: ka({ last_result: { aborted: true, results: [] } }), webAccounts: [],
  });
  assert.strictEqual(count(aborted, 'warn'), 1);
  assert.strictEqual(aborted[0].reason, 'keepalive_aborted');
});

test('skipped 的保活行不算失败（running 互斥跳过不是病）', () => {
  const out = healthAlerts({
    ka: ka({ last_result: { aborted: false, results: [
      { channel: 'web', uid: '1', name: '甲', ok: false, skipped: true, error: '' },
    ] } }),
    webAccounts: [],
  });
  assert.deepStrictEqual(out, []);
});

test('未启用账号不进健康面；红排黄前（界面明细的阅读顺序）', () => {
  const out = healthAlerts({
    ka: ka({ last_result: { aborted: false, results: [
      { channel: 'traework', uid: 'traework:1', name: '丙', ok: false, skipped: false, error: 'timeout' },
    ] } }),
    webAccounts: [
      acct({ id: 2, name: '未启用', enabled: false, last_error: 'HTTP 401' }),
      acct({ id: 3, name: '乙死', last_error: '取 token 失败：HTTP 401' }),
    ],
  });
  assert.strictEqual(out.length, 2, '未启用账号被跳过');
  assert.strictEqual(out[0].level, 'crit', 'crit 在前');
  assert.strictEqual(out[1].level, 'warn');
});

test('字段缺失不编成因：空输入返回空 alerts', () => {
  assert.deepStrictEqual(healthAlerts({}), []);
  assert.deepStrictEqual(healthAlerts({ ka: null, webAccounts: null }), []);
});
