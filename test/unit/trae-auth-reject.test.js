// test/unit/trae-auth-reject.test.js - 凭证被拒的处置（node:test）
//
// 依据：docs/GITHUB-TRAE-RESEARCH-2026-11-16.md 的 P0-3。
// NextAgentX v2026.11.141713 的原始症状是「账号被所有模型排除」——根因之一是
// 把「这份凭证被拒」当成「上游服务坏了」：后者会按指数退避把账号锁到 6 小时，
// 而且是账号级。等多久都不会自愈的错误，只能靠重新登录解。
//
// 这里锁四件事：
//   ① 401/403 家族归 session_dead（防误杀计数），**不再归 breaker**；
//   ② 403 的两条例外照旧：模型不可用 → model（换模型）、订阅专享 → model；
//      内容审核 → 不惩罚账号（policy）；
//   ③ 降级不因凭证被拒触发（同一份凭证换模型/换区都是白试）；
//   ④ 人工恢复（pool.revive）能把 session_dead 计数清掉。
process.env.DUMATE_POOL_STATE = require('path').join(
  require('os').tmpdir(), `trae-auth-reject-${process.pid}.json`,
);

const { test } = require('node:test');
const assert = require('assert');
const ue = require('../../src/upstream-errors');
const degrade = require('../../src/traework/degrade');
const channelPool = require('../../src/channel-pool');
const { pool } = require('../../src/pool');

// ---------------------------------------------------------------------------
// 一、分类
// ---------------------------------------------------------------------------

test('403 + 凭证文案 → session_dead（不再进熔断：等多久都不会自愈）', () => {
  for (const message of ['Forbidden: invalid token', '请重新登录', 'unauthorized: 凭证已过期']) {
    const cls = ue.classify({ status: 403, message });
    assert.strictEqual(cls.kind, 'session_dead', message);
  }
});

test('裸 403（没有语义线索）仍按原判定 breaker —— 403 在上游是多义的', () => {
  // Qoder 实测：403 还可能是额度（112/110/114）和限流（RESOURCE_LIMIT）。
  // 把「不知道」当「凭证失效」会累计 N 次禁用账号，那是另一种误伤。
  assert.strictEqual(ue.classify({ status: 403, message: 'qoder 403: forbidden' }).kind, 'breaker');
});

test('401 仍是 session_dead（回归：不许因为加 403 分支而改口径）', () => {
  assert.strictEqual(ue.classify({ status: 401, message: 'unauthorized' }).kind, 'session_dead');
});

test('403 + 模型不可用 → model（换模型就好，不该当凭证问题）', () => {
  const cls = ue.classify({ status: 403, message: 'model not available for this account' });
  assert.strictEqual(cls.kind, 'model');
});

test('403 + 订阅专享/1005 → model（Free 号打订阅模型，换模型即可用）', () => {
  assert.strictEqual(ue.classify({ status: 403, message: 'subscription-only model' }).kind, 'model');
  assert.strictEqual(ue.classify({ status: 403, message: '{"code":1005,"message":"no permission"}' }).kind, 'model');
});

test('403 + 内容审核 → 不惩罚账号（policy 标志，kind 为 null）', () => {
  const cls = ue.classify({ status: 403, message: 'DataInspectionFailed: content rejected' });
  assert.strictEqual(cls.kind, null);
  assert.strictEqual(cls.policy, true);
});

test('5xx / 网络 仍是 breaker（服务故障，等一会儿确实会好）', () => {
  assert.strictEqual(ue.classify({ status: 500, message: 'internal error' }).kind, 'breaker');
  assert.strictEqual(ue.classify({ status: 502, message: 'bad gateway' }).kind, 'breaker');
  assert.strictEqual(ue.classify({ status: 0, message: 'ECONNRESET' }).kind, 'breaker');
});

test('isAuthReject 的边界：401 无歧义；403 要正向证据；审核与订阅专享排除', () => {
  assert.strictEqual(ue.isAuthReject(401, ''), true);
  assert.strictEqual(ue.isAuthReject(403, ''), false, '裸 403 无证据 → 不归凭证');
  assert.strictEqual(ue.isAuthReject(403, 'invalid token'), true);
  assert.strictEqual(ue.isAuthReject(403, 'permission denied'), true);
  assert.strictEqual(ue.isAuthReject(429, 'too many requests'), false);
  assert.strictEqual(ue.isAuthReject(500, 'boom'), false);
  assert.strictEqual(ue.isAuthReject(403, 'DataInspectionFailed'), false);
  assert.strictEqual(ue.isAuthReject(403, '订阅专享模型'), false);
  assert.strictEqual(ue.isAuthReject(403, 'code 1005'), false);
});

// ---------------------------------------------------------------------------
// 二、降级不该被凭证问题触发
// ---------------------------------------------------------------------------

const CFG = { enabled: true, fallbackModel: 'traework/deepseek-v4.1-flash', fallbackRegion: 'cn', onQuota: true, onUpgrade: true };

test('降级：403 凭证被拒 → 不做降级（同一凭证换模型还是被拒）', () => {
  const err = new Error('Forbidden: invalid token');
  err.statusCode = 403;
  assert.strictEqual(degrade.plan(CFG, err, { model: 'traework/glm-5.2' }), null);
});

test('降级：额度耗尽仍照旧降级（别把修复做过头）', () => {
  const err = new Error('额度已耗尽，请充值');
  err.statusCode = 402;
  const plan = degrade.plan(CFG, err, { model: 'traework/glm-5.2' });
  assert.ok(plan, '额度类必须仍能降级');
  assert.strictEqual(plan.reason, 'quota');
});

// ---------------------------------------------------------------------------
// 三、池的处置与人工恢复
// ---------------------------------------------------------------------------

test('池：403 凭证被拒只累计 session_dead，不碰熔断计数', () => {
  const id = 9101;
  const uid = channelPool.uidOf('traework', id);
  pool.revive(uid);
  channelPool.noteError('traework', id, { status: 403, message: 'Forbidden: invalid token' });
  const st = pool.status(uid);
  assert.strictEqual(st.breaker_fails, 0, '不该记成「连续失败 → 熔断」');
  assert.ok(st.session_dead_fails >= 1, '要走防误杀计数（连续 N 次才禁用）');
});

test('池：500 才累计熔断计数（对照）', () => {
  const id = 9102;
  const uid = channelPool.uidOf('traework', id);
  pool.revive(uid);
  channelPool.noteError('traework', id, { status: 500, message: 'internal error' });
  assert.ok(pool.status(uid).breaker_fails >= 1);
});

test('人工恢复：清掉 session_dead 计数并解除禁用', () => {
  const id = 9103;
  const uid = channelPool.uidOf('traework', id);
  // 打满防误杀阈值（默认 3 次连续 401）
  for (let i = 0; i < 4; i += 1) channelPool.noteError('traework', id, { status: 401, message: 'unauthorized' });
  const bad = pool.status(uid);
  assert.ok(bad.session_dead_fails >= 1);
  assert.strictEqual(pool.revive(uid), true);
  const good = pool.status(uid);
  assert.strictEqual(good.session_dead_fails, 0);
  assert.strictEqual(good.disabled, false);
  assert.strictEqual(good.cooling, false);
});

// ---------------------------------------------------------------------------
// 四、跨区容灾的判定（纯函数；执行部分在 index.js，靠真机/打桩链路验证）
// ---------------------------------------------------------------------------

const failover = require('../../src/traework/failover');

const ON = { enabled: true, to: '' };
const hasAll = () => true;
const knownAll = () => true;

test('容灾：默认关 → 永不跨区', () => {
  assert.strictEqual(failover.plan({
    cfg: { enabled: false }, poolRegion: '', curRegion: 'cn', model: 'glm-5.2',
    hasAccount: hasAll, known: knownAll,
  }), null);
});

test('容灾：Key 绑了区域就不跨（否则等于绕过鉴权约束）', () => {
  assert.strictEqual(failover.plan({
    cfg: ON, poolRegion: 'cn', curRegion: 'cn', model: 'glm-5.2',
    hasAccount: hasAll, known: knownAll,
  }), null);
});

test('容灾：只试一次（tried=true 不再弹回）', () => {
  assert.strictEqual(failover.plan({
    cfg: ON, poolRegion: '', curRegion: 'cn', model: 'glm-5.2', tried: true,
    hasAccount: hasAll, known: knownAll,
  }), null);
});

test('容灾：对方区没有账号 / 模型在对方区未知 → 不跨（不拿请求去赌）', () => {
  assert.strictEqual(failover.plan({
    cfg: ON, poolRegion: '', curRegion: 'cn', model: 'glm-5.2',
    hasAccount: () => false, known: knownAll,
  }), null);
  assert.strictEqual(failover.plan({
    cfg: ON, poolRegion: '', curRegion: 'cn', model: 'glm-5.2',
    hasAccount: hasAll, known: () => false,
  }), null);
});

test('容灾：auto 档（无显式模型）不跨——对方区认不认这个 auto 没有依据', () => {
  assert.strictEqual(failover.plan({
    cfg: ON, poolRegion: '', curRegion: 'cn', model: '',
    hasAccount: hasAll, known: knownAll,
  }), null);
});

test('容灾：条件齐备才跨，方向按 to 或自动取对方区', () => {
  assert.deepStrictEqual(failover.plan({
    cfg: ON, poolRegion: '', curRegion: 'cn', model: 'deepseek-v4.1-flash',
    hasAccount: hasAll, known: knownAll,
  }), { from: 'cn', to: 'intl' });
  assert.deepStrictEqual(failover.plan({
    cfg: { enabled: true, to: 'cn' }, poolRegion: '', curRegion: 'intl', model: 'glm-5.2',
    hasAccount: hasAll, known: knownAll,
  }), { from: 'intl', to: 'cn' });
  // to 与当前区相同 → 无处可去
  assert.strictEqual(failover.plan({
    cfg: { enabled: true, to: 'cn' }, poolRegion: '', curRegion: 'cn', model: 'glm-5.2',
    hasAccount: hasAll, known: knownAll,
  }), null);
});

// ---------------------------------------------------------------------------
// 五、运行态配置的字段白名单（防止「加了 FIELDS 却忘了 Load 的返回体」）
// ---------------------------------------------------------------------------

test('trae-runtime：Load() 覆盖全部 FIELDS（写盘成功但读出来 undefined 的坑）', () => {
  const rt = require('../../src/trae-runtime');
  const snap = rt.Load();
  for (const k of rt.FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(snap, k),
      `Load() 缺字段 ${k}：defaults()/Store() 有它，但返回体是另一份白名单`);
  }
  // 默认关：跨区容灾不能因为「字段存在」就被当成开启
  assert.strictEqual(snap.crossRegionFailover.enabled, false);
});
