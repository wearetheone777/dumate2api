// test/pool.test.js - 账号池状态机离线单测（node:test,零依赖,不触网不碰 data/）
//
// 覆盖（施工包 A 验收）:
//   - 错误类别映射（upstream-errors.classify,Q3）
//   - 状态迁移矩阵:软冷却退避/硬冷却/模型级负缓存/熔断指数退避/401 防误杀/
//     禁用与复活/暂停/冻结/积分保底/在途帽
//   - 持久化恢复:重启恢复、过期态清理、跨进程单记录合并
//   - 并发选号:轮询、排除、在途满跳过
//   - 会话粘性表（src/sticky.js）
//
// 全部用注入时钟（now）与临时目录文件,不依赖真实账号与网络。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPool, msUntilNext4AM } = require('../src/pool');
const { classify } = require('../src/upstream-errors');
const { createSticky } = require('../src/sticky');
const { tmpDir } = require('./helpers/tmpdir');

// ---------------------------------------------------------------------------
// 测试基建:可注入时钟
// ---------------------------------------------------------------------------
const T0 = 1_700_000_000_000;
function makeClock() {
  let now = T0;
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
  };
}

function tmpStateFile() {
  const dir = tmpDir('dumate-pool-test');
  return path.join(dir, 'pool-state.json');
}

// 快速建池:内存态（file=null 不落盘不启 flusher,测试用 flush 手动验证）
function memPool(clock, extra = {}) {
  return createPool({ file: null, flushMs: 0, now: clock.now, ...extra });
}

// ---------------------------------------------------------------------------
// classify:code → 处置类别（Q3 映射表）
// ---------------------------------------------------------------------------
test('classify: 429 → soft', () => {
  assert.equal(classify({ status: 429, message: 'rate limited' }).kind, 'soft');
});

// 上游主动给的排队限流（COSY 通道的 10605）本质是 429 语义，不是服务故障。
// 旧实现落进「其余 403」→ breaker，30 分钟起步的退避把上游 30 秒的条件
// 放大成本地半小时封禁（实测两个账号各被限流 3 次即全池不可用）。
test('classify: COSY 限流（403 + 10605/RESOURCE_LIMIT）→ soft，且带 retryAfterMs', () => {
  const msg = 'qoder 403: {"code":"10605","message":"{\\"isQueued\\":true,\\"retryAfterSeconds\\":30,\\"subCode\\":\\"RESOURCE_LIMIT\\"}"}';
  const cls = classify({ status: 403, message: msg, model: 'dfmodel' });
  assert.equal(cls.kind, 'soft');
  assert.equal(cls.retryAfterMs, 30000);
  // read idle（排队挂起的另一种形态）同样是 soft
  assert.equal(classify({ status: 0, message: 'qoder upstream read idle (120000ms)' }).kind, 'soft');
  // 不带限流信号的 403 仍然是 breaker，模型不可用仍然是 model
  assert.equal(classify({ status: 403, message: 'forbidden' }).kind, 'breaker');
  assert.equal(classify({ status: 403, message: 'Model is not available for this user' }).kind, 'model');
});

test('classify: 401 → session_dead（防误杀类）', () => {
  assert.equal(classify({ status: 401, message: 'token expired' }).kind, 'session_dead');
});

test('classify: 402 / 余额耗尽文案 → hard', () => {
  assert.equal(classify({ status: 402, message: '' }).kind, 'hard');
  assert.equal(classify({ status: 500, message: '余额不足，请充值' }).kind, 'hard');
  assert.equal(classify({ status: 403, message: 'insufficient credits' }).kind, 'hard');
});

test('classify: 403+模型不可用文案 → model;普通 403 → breaker', () => {
  assert.equal(classify({ status: 403, message: 'Model is not available for this user' }).kind, 'model');
  assert.equal(classify({ status: 403, message: 'forbidden' }).kind, 'breaker');
});

test('classify: 5xx 与网络层失败 → breaker', () => {
  assert.equal(classify({ status: 502 }).kind, 'breaker');
  assert.equal(classify({ status: 0, message: 'timeout' }).kind, 'breaker');
  assert.equal(classify('socket hang up').kind, 'breaker');
});

test('classify: 其余 4xx 不惩罚', () => {
  assert.equal(classify({ status: 400, message: 'bad request' }).kind, null);
  assert.equal(classify({ status: 404 }).kind, null);
});

// ---------------------------------------------------------------------------
// 状态迁移矩阵
// ---------------------------------------------------------------------------
test('软冷却:429 进入冷却、到期恢复、选号跳过冷却号', () => {
  const clock = makeClock();
  const p = memPool(clock, { softBaseMs: 1000, softMaxMs: 8000 });
  p.noteError('a', { kind: 'soft', message: '429' });
  assert.equal(p.isHealthy('a'), false);
  assert.equal(p.pick(['a']), null);
  assert.equal(p.status('a').cool_kind, 'soft');

  clock.advance(1001);
  assert.equal(p.isHealthy('a'), true);
  assert.equal(p.pick(['a']), 'a');
  assert.equal(p.status('a').cooldown_until < clock.now(), true);
});

test('软冷却有界退避:逐次翻倍、封顶;冷却中重复 429 不叠加', () => {
  const clock = makeClock();
  const p = memPool(clock, { softBaseMs: 1000, softMaxMs: 8000 });

  p.noteError('a', { kind: 'soft' });
  assert.equal(p.status('a').cooldown_until - clock.now(), 1000);

  clock.advance(1001);
  p.noteError('a', { kind: 'soft' });
  assert.equal(p.status('a').cooldown_until - clock.now(), 2000);

  clock.advance(2001);
  p.noteError('a', { kind: 'soft' });
  assert.equal(p.status('a').cooldown_until - clock.now(), 4000);

  clock.advance(4001);
  p.noteError('a', { kind: 'soft' });
  assert.equal(p.status('a').cooldown_until - clock.now(), 8000);

  // 封顶后再触发也不再增长
  clock.advance(8001);
  p.noteError('a', { kind: 'soft' });
  assert.equal(p.status('a').cooldown_until - clock.now(), 8000);

  // 冷却中兜底探测:不推进、不延长（防「越重试越冷」的元凶回归）
  clock.advance(1000); // 仍在 8000 冷却内
  const before = p.status('a').cooldown_until;
  p.noteError('a', { kind: 'soft' });
  assert.equal(p.status('a').cooldown_until, before);
});

test('软冷却:上游给了 retryAfterMs 就按它,不套基数、不递增 streak', () => {
  const clock = makeClock();
  const p = memPool(clock, { softBaseMs: 300_000, softMaxMs: 7_200_000 });

  p.noteError('a', { kind: 'soft', message: 'queue', retryAfterMs: 30_000 });
  assert.equal(p.status('a').cooldown_until - clock.now(), 30_000, '应按上游的 30s 冷却');
  assert.equal(p.status('a').soft_streak, 0, '上游定的时长不是「又超速一次」的证据');
  assert.equal(p.status('a').cool_kind, 'soft');

  // 到点即恢复
  clock.advance(30_001);
  assert.equal(p.pick(['a']), 'a');

  // 过大/过小的值被夹进 [1s, softMaxMs]
  const p2 = memPool(clock, { softBaseMs: 300_000, softMaxMs: 7_200_000 });
  p2.noteError('b', { kind: 'soft', message: 'queue', retryAfterMs: 1 });
  assert.equal(p2.status('b').cooldown_until - clock.now(), 1_000);
  p2.noteError('c', { kind: 'soft', message: 'queue', retryAfterMs: 99 * 3600_000 });
  assert.equal(p2.status('c').cooldown_until - clock.now(), 7_200_000);

  // 没有 retryAfterMs 时仍走基数（429 的老行为不变）
  const p3 = memPool(clock, { softBaseMs: 300_000, softMaxMs: 7_200_000 });
  p3.noteError('d', { kind: 'soft', message: 'too many requests' });
  assert.equal(p3.status('d').cooldown_until - clock.now(), 300_000);
});

test('livecfg 热接线:hotSoftCooldown 门控下 softCooldownMs 覆盖软冷却基数', () => {
  const dir = tmpDir('dumate-pool-hotcfg');
  const prevData = process.env.DUMATE_ADMIN_DATA;
  process.env.DUMATE_ADMIN_DATA = dir;
  const livecfg = require('../src/livecfg');
  livecfg._resetForTest();
  try {
    livecfg.Store({ softCooldownMs: 100 });
    const clock = makeClock();
    // 门控池（生产单例形态）:livecfg >0 生效
    const hot = createPool({ file: null, flushMs: 0, now: clock.now, hotSoftCooldown: true, softMaxMs: 100000 });
    hot.noteError('a', { kind: 'soft' });
    assert.equal(hot.status('a').cooldown_until - clock.now(), 100, '热配置基数 100ms 应生效');
    // 未门控池（测试形态）:不读机器真实配置,仍用注入基数
    const cold = createPool({ file: null, flushMs: 0, now: clock.now, softBaseMs: 1000, softMaxMs: 100000 });
    cold.noteError('b', { kind: 'soft' });
    assert.equal(cold.status('b').cooldown_until - clock.now(), 1000);
    // 热配置归零/非法 = 回退内置默认
    livecfg.Store({ softCooldownMs: 0 });
    const hot2 = createPool({ file: null, flushMs: 0, now: clock.now, hotSoftCooldown: true });
    hot2.noteError('c', { kind: 'soft' });
    assert.equal(hot2.status('c').cooldown_until - clock.now(), 5 * 60 * 1000);
  } finally {
    livecfg._resetForTest();
    if (prevData === undefined) delete process.env.DUMATE_ADMIN_DATA;
    else process.env.DUMATE_ADMIN_DATA = prevData;
  }
});

test('硬冷却:余额耗尽 → 冷却到下次签到窗口;成功不清硬冷却', () => {
  const clock = makeClock();
  const p = memPool(clock);
  p.noteError('a', { kind: 'hard', message: '余额不足' });
  assert.equal(p.status('a').cool_kind, 'hard');
  // 默认时长 = 到下一个 04:00（毫秒级随机,只验证落在合理区间:≥1s 且 ≤25h）
  const remain = p.status('a').cool_remaining_s;
  assert.ok(remain > 0 && remain <= 25 * 3600, `硬冷却剩余 ${remain}s 不合理`);

  // 成功不解除硬冷却（即时冷却各自到期,只能靠余额恢复/复活）
  p.noteSuccess('a');
  assert.equal(p.isHealthy('a'), false);
});

test('硬冷却默认窗口:凌晨 0-4 点等当天 4 点,之后等次日 4 点', () => {
  const d = (h, m) => new Date(T0).setHours(h, m, 0, 0);
  // 02:00 命中 → 当天 04:00,约 2 小时
  const r1 = msUntilNext4AM(d(2, 0));
  assert.ok(r1 > 3600_000 && r1 <= 2 * 3600_000 + 1000, `02:00 的窗口 ${r1}ms 不对`);
  // 05:00 命中 → 次日 04:00,约 23 小时
  const r2 = msUntilNext4AM(d(5, 0));
  assert.ok(r2 > 22 * 3600_000 && r2 <= 23 * 3600_000 + 1000, `05:00 的窗口 ${r2}ms 不对`);
});

test('模型级负缓存:该模型不可用、其他模型豁免;成功不误清;显式清除恢复', () => {
  const clock = makeClock();
  const p = memPool(clock, { modelBlockBaseMs: 1000, modelBlockMaxMs: 8000 });

  p.noteError('a', { kind: 'model', model: 'm1', message: 'Model is not available' });
  assert.equal(p.pick(['a'], { model: 'm1' }), null);
  assert.equal(p.pick(['a'], { model: 'm2' }), 'a');

  // 其他模型的成功不抹掉本模型的冷却（每模型独立计时）
  p.noteSuccess('a');
  assert.equal(p.pick(['a'], { model: 'm1' }), null);

  // 重复命中退避翻倍
  const first = p.status('a').model_cooldowns[0];
  clock.advance(first.until - clock.now() + 1);
  p.noteError('a', { kind: 'model', model: 'm1' });
  const second = p.status('a').model_cooldowns[0];
  assert.equal(second.hits, 2);
  assert.equal(second.until - clock.now(), 2000);

  // 该模型请求成功 → 负缓存清除
  p.clearModelBlock('a', 'm1');
  assert.equal(p.pick(['a'], { model: 'm1' }), 'a');
});

test('熔断:连续失败达阈触发指数退避、成功清零、封顶生效', () => {
  const clock = makeClock();
  const p = memPool(clock, { breakerThreshold: 3, breakerCooldownMs: 1000, breakerCooldownMaxMs: 8000 });

  p.noteError('a', { kind: 'breaker' });
  p.noteError('a', { kind: 'breaker' });
  assert.equal(p.isHealthy('a'), true); // 未达阈不影响选号

  p.noteError('a', { kind: 'breaker' });
  assert.equal(p.isHealthy('a'), false);
  assert.equal(p.status('a').cool_kind, 'breaker');
  assert.equal(p.status('a').breaker_retry_count, 1);
  assert.equal(p.status('a').breaker_fails, 0); // 触发后重新计数

  clock.advance(1001);
  p.noteError('a', { kind: 'breaker' });
  p.noteError('a', { kind: 'breaker' });
  p.noteError('a', { kind: 'breaker' });
  assert.equal(p.status('a').breaker_retry_count, 2);
  assert.equal(p.status('a').cool_remaining_s, 2); // 第二轮时长翻倍

  // 成功清熔断运行态
  clock.advance(2001);
  p.noteSuccess('a');
  assert.equal(p.isHealthy('a'), true);
  assert.equal(p.status('a').breaker_retry_count, 0);

  // 封顶:连续多轮熔断后时长不再增长（轮间让熔断自然过期再累计）
  for (let round = 0; round < 6; round++) {
    if (round > 0) clock.advance(8000 + 1);
    p.noteError('a', { kind: 'breaker' });
    p.noteError('a', { kind: 'breaker' });
    p.noteError('a', { kind: 'breaker' });
  }
  assert.equal(p.status('a').cool_remaining_s, 8); // 8000ms 封顶
});

test('401 防误杀:连续达阈才禁用;成功/复活清计数', () => {
  const clock = makeClock();
  const p = memPool(clock, { sessionDeadThreshold: 3 });

  assert.equal(p.noteSessionDead('a'), false);
  assert.equal(p.noteSessionDead('a'), false);
  assert.equal(p.isHealthy('a'), true); // 抖动不杀号

  // 中途成功清零:重新计满 3 次才禁用
  p.noteSuccess('a');
  assert.equal(p.noteSessionDead('a'), false);
  assert.equal(p.noteSessionDead('a'), false);
  assert.equal(p.isHealthy('a'), true);

  assert.equal(p.noteSessionDead('a'), true); // 第 3 次 → 禁用
  assert.equal(p.status('a').state, 'disabled');
  assert.equal(p.pick(['a']), null);

  // 复活回到池子
  p.revive('a');
  assert.equal(p.isHealthy('a'), true);
  assert.equal(p.status('a').session_dead_fails, 0);
});

test('禁用清冷却域但保留熔断观测;复活全清', () => {
  const clock = makeClock();
  const p = memPool(clock, { breakerThreshold: 3, breakerCooldownMs: 1000, breakerCooldownMaxMs: 8000 });

  p.noteError('a', { kind: 'soft' });
  p.noteError('a', { kind: 'breaker' });
  p.noteError('a', { kind: 'breaker' }); // fails=2
  p.disable('a', '人工禁用');
  const st = p.status('a');
  assert.equal(st.disabled, true);
  assert.equal(st.cooling, false);       // 冷却域随禁用作废
  assert.equal(st.cooldown_until, 0);
  assert.equal(st.breaker_fails, 2);     // 熔断观测保留

  // 复活全清（对齐 Revive 语义）:retry/fails/until 归零,熔断重新累计
  p.revive('a');
  assert.equal(p.status('a').breaker_fails, 0);
  assert.equal(p.status('a').breaker_retry_count, 0);
  assert.equal(p.isHealthy('a'), true);
  p.noteError('a', { kind: 'breaker' });
  p.noteError('a', { kind: 'breaker' });
  p.noteError('a', { kind: 'breaker' });
  assert.equal(p.status('a').cool_kind, 'breaker');
});

test('冻结/暂停/恢复:freeze 是 hard 冷却;pause 不动惩罚域', () => {
  const clock = makeClock();
  const p = memPool(clock);

  p.freeze('a', 5000, '运维排查');
  assert.equal(p.status('a').cool_kind, 'hard');
  assert.equal(p.isHealthy('a'), false);
  p.revive('a');
  assert.equal(p.isHealthy('a'), true);

  p.noteError('a', { kind: 'soft' });
  p.pause('a');
  assert.equal(p.status('a').state, 'paused');
  assert.equal(p.status('a').cooldown_kind, 'soft'); // 惩罚域保留
  p.resume('a');
  assert.equal(p.isHealthy('a'), false); // 暂停解除但软冷却仍在
});

test('积分保底:余额低于保底线拦收费模型,免费模型与无数据不拦', () => {
  const clock = makeClock();
  const p = memPool(clock, { creditFloor: 100 });

  assert.equal(p.pick(['a'], { paid: true }), 'a'); // 无数据源不拦

  p.setCredits('a', 50, 1000);
  assert.equal(p.pick(['a'], { paid: true }), null);
  assert.equal(p.pick(['a'], { paid: false }), 'a'); // 免费模型放行
  assert.equal(p.status('a').floor_blocked, true);

  p.setCredits('a', 150, 1000);
  assert.equal(p.pick(['a'], { paid: true }), 'a');
});

test('余额恢复解冻:只解硬冷却,软冷却/模型级/熔断保留', () => {
  const clock = makeClock();
  const p = memPool(clock);

  // 硬冷却 + 余额回正 → 解冻
  p.noteError('a', { kind: 'hard', message: '余额不足' });
  let r = p.reenableIfCredits('a', 200, 1000);
  assert.equal(r.unfrozen, true);
  assert.equal(p.isHealthy('a'), true);

  // 软冷却 + 余额回正 → 不解（限流恢复证据是墙钟到期,不是有钱）
  p.noteError('a', { kind: 'soft' });
  r = p.reenableIfCredits('a', 300, 1000);
  assert.equal(r.unfrozen, false);
  assert.equal(p.isHealthy('a'), false);

  // 余额为 0 不解硬冷却
  p.noteError('a', { kind: 'hard', message: '余额不足' });
  r = p.reenableIfCredits('a', 0, 1000);
  assert.equal(r.unfrozen, false);
  assert.equal(p.isHealthy('a'), false);
});

test('在途帽:acquire/release 配额正确,pick 跳过满载账号', () => {
  const clock = makeClock();
  const p = memPool(clock, { inFlightMax: 2 });

  assert.equal(p.acquire('a'), true);
  assert.equal(p.acquire('a'), true);
  assert.equal(p.acquire('a'), false); // 满载

  assert.equal(p.pick(['a', 'b']), 'b'); // 跳过满载的 a
  p.release('a');
  assert.equal(p.acquire('a'), true);
  p.release('a');
  p.release('a');
  p.release('a'); // 多 release 不下溢
  assert.equal(p.status('a').in_flight, 0);
});

// ---------------------------------------------------------------------------
// 并发选号
// ---------------------------------------------------------------------------
test('并发选号:轮询均摊、排除生效、冷却号跳过', () => {
  const clock = makeClock();
  const p = memPool(clock);

  assert.equal(p.pick(['1', '2', '3']), '1');
  assert.equal(p.pick(['1', '2', '3']), '2');
  assert.equal(p.pick(['1', '2', '3']), '3');
  assert.equal(p.pick(['1', '2', '3']), '1'); // 回绕

  assert.equal(p.pick(['1', '2', '3'], { exclude: new Set(['2']) }), '1');

  // 2 进冷却 → 剩 1、3 轮询（游标延续,5%2=1 先出 3）
  p.noteError('2', { kind: 'soft' });
  assert.equal(p.pick(['1', '2', '3']), '3');
  assert.equal(p.pick(['1', '2', '3']), '1');

  // 全部冷却 → 无号可选
  p.noteError('1', { kind: 'soft' });
  p.noteError('3', { kind: 'soft' });
  assert.equal(p.pick(['1', '2', '3']), null);
});

test('并发选号:在途占满时 pick 返回其余账号或 null（busy 不死锁）', () => {
  const clock = makeClock();
  const p = memPool(clock, { inFlightMax: 1 });

  assert.equal(p.acquire('1'), true);
  assert.equal(p.pick(['1', '2']), '2');
  assert.equal(p.acquire('2'), true);
  assert.equal(p.pick(['1', '2']), null); // 全满
  p.release('1');
  assert.equal(p.pick(['1', '2']), '1');
});

// ---------------------------------------------------------------------------
// 持久化恢复
// ---------------------------------------------------------------------------
test('持久化:flush 后新实例恢复冷却/禁用/余额;过期态不复活', () => {
  const clock = makeClock();
  const file = tmpStateFile();
  const a = createPool({ file, flushMs: 0, now: clock.now, softBaseMs: 1000 });

  a.noteError('1', { kind: 'soft', message: '429' });
  a.setCredits('2', 50, 1000);
  a.noteSessionDead('3');
  a.noteSessionDead('3');
  a.noteSessionDead('3'); // 第 3 次 → 禁用
  a.freeze('4', 60000, '运维');
  a.flush();
  assert.equal(fs.existsSync(file), true);

  const b = createPool({ file, flushMs: 0, now: clock.now });
  assert.equal(b.status('1').cooling, true);
  assert.equal(b.status('1').cool_kind, 'soft');
  assert.equal(b.status('2').credits, 50);
  assert.equal(b.status('3').disabled, true);
  assert.equal(b.status('4').cool_kind, 'hard');
  b.close();

  // 过期态不复活:冷却自然到期后落盘,新实例恢复出来是健康
  clock.advance(2000);
  a.noteSuccess('9');
  a.flush();
  const c = createPool({ file, flushMs: 0, now: clock.now });
  assert.equal(c.status('1').cooling, false);
  assert.equal(c.isHealthy('1'), true);
  c.close();
});

test('持久化:熔断未过期恢复 retryCount,过期归零', () => {
  const clock = makeClock();
  const file = tmpStateFile();
  const a = createPool({ file, flushMs: 0, now: clock.now, breakerThreshold: 2, breakerCooldownMs: 1000, breakerCooldownMaxMs: 8000 });

  a.noteError('1', { kind: 'breaker' });
  a.noteError('1', { kind: 'breaker' }); // 熔断,retryCount=1
  a.flush();

  let b = createPool({ file, flushMs: 0, now: clock.now });
  assert.equal(b.status('1').cooling, true);
  assert.equal(b.status('1').breaker_retry_count, 1);
  b.close();

  clock.advance(1001); // 熔断过期
  a.noteSuccess('x');  // 触发一次落盘
  a.flush();
  b = createPool({ file, flushMs: 0, now: clock.now });
  assert.equal(b.status('1').cooling, false);
  assert.equal(b.status('1').breaker_retry_count, 0); // 退避指数不背无用包袱
  b.close();
});

test('跨进程合并:运维冻结立即落盘,热进程落盘前吸纳（不被全量写覆盖）', () => {
  const clock = makeClock();
  const file = tmpStateFile();
  // A = 网关进程（热路径）,B = 管理端进程（运维动作）
  const gw = createPool({ file, flushMs: 0, now: clock.now, breakerThreshold: 3 });
  const adm = createPool({ file, flushMs: 0, now: clock.now });

  gw.noteError('1', { kind: 'breaker' });
  gw.noteError('1', { kind: 'breaker' });

  // 管理端冻结:单记录立即写盘
  adm.freeze('1', 60000, '运维');
  assert.equal(adm.status('1').cool_kind, 'hard');

  // 网关此时才落盘它的全量内存态——必须先吸纳 B 的冻结,不能盖回去
  gw.noteSuccess('2');
  gw.flush();
  assert.equal(gw.status('1').cool_kind, 'hard');

  // 反向:热进程的惩罚态落盘后,管理端 reload 能看到
  gw.noteError('3', { kind: 'soft' });
  gw.flush();
  assert.equal(adm.reloadIfChanged(), true);
  assert.equal(adm.status('3').cooling, true);

  // 运维复活跨进程生效
  adm.revive('1');
  assert.equal(adm.status('1').cooling, false);
  gw.close();
  adm.close();
});

test('reloadIfChanged 不清在途计数:管理端重读不破坏并发帽', () => {
  const clock = makeClock();
  const file = tmpStateFile();
  const a = createPool({ file, flushMs: 0, now: clock.now });
  a.acquire('1');
  a.noteError('2', { kind: 'soft' });
  a.flush();

  // 另一「进程」写过盘后,a 重读——在途名额是本进程运行态,不能被清零
  const b = createPool({ file, flushMs: 0, now: clock.now });
  b.noteError('9', { kind: 'soft' });
  b.flush();
  assert.equal(a.reloadIfChanged(), true);
  assert.equal(a.status('1').in_flight, 1);
  a.close();
  b.close();
});

test('跨进程合并:同毫秒写入不互相覆盖（rev 单调序,updated_at 同值也能吸纳）', () => {
  const clock = makeClock(); // 时钟全程冻结:所有记录的 updated_at 恒相等
  const file = tmpStateFile();
  const gw = createPool({ file, flushMs: 0, now: clock.now });
  const adm = createPool({ file, flushMs: 0, now: clock.now });

  gw.noteSuccess('1'); // gw 落盘:记录 { updated_at: T0, rev: 1 }
  gw.flush();
  assert.equal(adm.reloadIfChanged(), true);

  adm.freeze('1', 60000, '运维'); // adm 在同一毫秒写:updated_at 仍是 T0,rev 升到 2
  gw.noteSuccess('2'); // gw 全量落盘前必须按 rev 吸纳 adm 的冻结
  gw.flush();
  assert.equal(gw.status('1').cool_kind, 'hard');

  // 反向:rev 序下运维复活也不被热进程旧态回滚
  adm.revive('1');
  gw.noteSuccess('3');
  gw.flush();
  assert.equal(gw.status('1').cooling, false);
  gw.close();
  adm.close();
});

test('落盘失败回置脏标记:flush 抛错后状态仍待写,恢复后能补写成功（P1-2 教训）', async () => {
  const clock = makeClock();

  // flush() 同步路径:写失败必须把 dirty 还回来,否则第二次 flush 直接空转
  const file = tmpStateFile();
  const p = createPool({ file, flushMs: 0, now: clock.now });
  fs.mkdirSync(`${file}.tmp`); // 占住临时文件路径:writeFileSync 必然 EISDIR
  p.noteError('1', { kind: 'soft' });
  assert.throws(() => p.flush());
  fs.rmdirSync(`${file}.tmp`);
  assert.equal(p.flush(), true); // 脏标记被回置:第二次 flush 真的落盘
  const b = createPool({ file, flushMs: 0, now: clock.now });
  assert.equal(b.status('1').cooling, true);
  b.close();
  p.close();

  // flusher 周期路径:写失败静默,但下个周期必须重试成功而不是丢弃
  const file2 = tmpStateFile();
  const q = createPool({ file: file2, flushMs: 10, now: clock.now });
  fs.mkdirSync(`${file2}.tmp`);
  q.noteError('1', { kind: 'soft' });
  await new Promise((r) => setTimeout(r, 50)); // 跨一个周期:写失败,脏标记保留
  fs.rmdirSync(`${file2}.tmp`);
  await new Promise((r) => setTimeout(r, 50)); // 下一周期补写
  const c = createPool({ file: file2, flushMs: 0, now: clock.now });
  assert.equal(c.status('1').cooling, true);
  c.close();
  q.close();
});

// ---------------------------------------------------------------------------
// 会话粘性（src/sticky.js）
// ---------------------------------------------------------------------------
test('sticky:绑定/命中/解绑/TTL 过期/LRU 上限', () => {
  const clock = makeClock();
  const s = createSticky({ ttlMs: 1000, max: 3, now: clock.now });

  assert.equal(s.bind('s1', 'u1'), true);
  assert.equal(s.lookup('s1'), 'u1');
  assert.equal(s.unbind('s1'), true);
  assert.equal(s.lookup('s1'), null);

  s.bind('s2', 'u2');
  clock.advance(1001);
  assert.equal(s.lookup('s2'), null); // TTL 过期
  assert.equal(s.size(), 0);

  // LRU:上限 3,第 4 个挤掉最久未用的
  s.bind('a', '1');
  s.bind('b', '2');
  s.bind('c', '3');
  s.lookup('a'); // 刷新 a
  s.bind('d', '4');
  assert.equal(s.lookup('a'), '1'); // 刚用过,保留
  assert.equal(s.lookup('b'), null); // 最久未用,被挤掉
  assert.equal(s.lookup('c'), '3');
  assert.equal(s.lookup('d'), '4');
});

// 进程退出清理:close() 幂等
test('close 幂等且 flush 落盘', () => {
  const clock = makeClock();
  const file = tmpStateFile();
  const p = createPool({ file, flushMs: 0, now: clock.now });
  p.noteError('1', { kind: 'soft' });
  p.close();
  p.close();
  assert.equal(fs.existsSync(file), true);
});
