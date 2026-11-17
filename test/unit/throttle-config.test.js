// test/unit/throttle-config.test.js - 通道风控参数上台（P1-9）的离线验证
//
// 调研项：账号并发 / 账号间隔 / 短故障重试原来只认环境变量，改一次要重开
// 三个进程。现在三个旋钮都能被管理端热改（落 livecfg.json），**解析优先级
// 只有一份实现**（src/throttle.js：面板 > env > 内置默认）。
//
// 本文件锁四件事：
//   1. 清单不漂移——livecfg 的存储清单与 throttle.js 的解析清单必须一致；
//   2. 优先级与「0 的语义」（三个旋钮**刻意不同**，照抄会错）；
//   3. 消费方真的现读：channel-pool / repair / upstream-errors 改完即生效；
//   4. 管理端两个新端点：/throttle 报「生效值 + 来源」，/pool-revive 只动本通道。
//
// 运行：node --test test/unit/throttle-config.test.js
const assert = require('assert');
const { test } = require('node:test');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-throttle-'));
process.env.DUMATE_ADMIN_DATA = TMP;
process.env.DUMATE_POOL_STATE = path.join(TMP, 'pool-state.json');
// 清掉可能被外部 shell 带进来的相关 env，否则「默认值」断言会看到宿主环境
for (const k of ['DUMATE_THROTTLE_MAX_MS', 'DUMATE_QODER_INFLIGHT_MAX',
  'DUMATE_QODER_MIN_INTERVAL_MS', 'DUMATE_QODER_REPAIR_RETRY',
  'DUMATE_TRAEWORK_INFLIGHT_MAX', 'DUMATE_TRAEWORK_MIN_INTERVAL_MS',
  'DUMATE_TRAEWORK_REPAIR_RETRY', 'DUMATE_QWENWORK_REPAIR_RETRY']) {
  delete process.env[k];
}

const livecfg = require('../../src/livecfg');
const throttle = require('../../src/throttle');
const repair = require('../../src/repair');
const { pool } = require('../../src/pool');
const channelPool = require('../../src/channel-pool');

function reset() {
  livecfg._resetForTest();
  for (const k of Object.keys(process.env)) if (k.startsWith('DUMATE_') && /INFLIGHT_MAX|MIN_INTERVAL_MS|REPAIR_RETRY|THROTTLE_MAX_MS/.test(k)) delete process.env[k];
  try { fs.rmSync(path.join(TMP, livecfg.FILE), { force: true }); } catch (e) { /* 不存在即目的达成 */ }
  livecfg._resetForTest();
}

/** sendJSON 只用得到 writeHead/end（见 src/admin/router.js） */
function fakeRes() {
  const out = { status: 0, body: null };
  return {
    out,
    writeHead(code) { out.status = code; },
    setHeader() {},
    end(buf) { try { out.body = JSON.parse(buf); } catch (e) { out.body = buf; } },
  };
}

function routeOf(method, p) {
  const { routes } = require('../../src/admin/routes/system.js');
  return routes.find((r) => r.method === method && r.path === p);
}

// ---------------------------------------------------------------------------
test('清单不漂移：livecfg 的存储清单与 throttle.js 的解析清单一致', () => {
  assert.deepStrictEqual([...livecfg.THROTTLE_CHANNELS], [...throttle.CHANNELS]);
  assert.deepStrictEqual([...livecfg.THROTTLE_KNOBS], [...throttle.KNOBS]);
  for (const k of livecfg.FIELDS) {
    assert.ok(!String(k).includes(' '), `FIELDS 项不应含空格: ${k}`);
  }
  assert.ok(livecfg.FIELDS.includes('throttle'), 'FIELDS 必须含 throttle');
  assert.ok(livecfg.FIELDS.includes('throttleMaxMs'), 'FIELDS 必须含 throttleMaxMs');
});

test('默认：三个旋钮都回落默认（value=null，source=default）', () => {
  reset();
  for (const ch of throttle.CHANNELS) {
    for (const k of throttle.KNOBS) {
      const r = throttle.resolve(ch, k);
      assert.strictEqual(r.value, null, `${ch}.${k} 应为未设`);
      assert.strictEqual(r.source, 'default');
      assert.ok(r.env.startsWith('DUMATE_'), 'en 名要能显示给用户');
    }
  }
});

test('env 生效：source=env，面板仍为空', () => {
  reset();
  process.env.DUMATE_QODER_MIN_INTERVAL_MS = '1500';
  const r = throttle.resolve('qoder', 'minIntervalMs');
  assert.strictEqual(r.value, 1500);
  assert.strictEqual(r.source, 'env');
  assert.strictEqual(r.panel, null);
});

test('面板覆盖 env（并发帽）', () => {
  reset();
  process.env.DUMATE_QODER_INFLIGHT_MAX = '2';
  livecfg.Store({ throttle: { qoder: { inflightMax: 5 } } });
  const r = throttle.resolve('qoder', 'inflightMax');
  assert.strictEqual(r.value, 5, '面板优先');
  assert.strictEqual(r.source, 'panel');
  assert.strictEqual(r.envValue, 2, 'env 值仍要能显示出来（解释「为什么不是 2」）');
});

test('0 的语义各不相同：minIntervalMs/retryMax 的 0 是显式关断，inflightMax 的 0 等于未设', () => {
  reset();
  process.env.DUMATE_QODER_MIN_INTERVAL_MS = '800';
  process.env.DUMATE_QODER_REPAIR_RETRY = '2';
  process.env.DUMATE_QODER_INFLIGHT_MAX = '3';
  livecfg.Store({ throttle: { qoder: { minIntervalMs: 0, retryMax: 0, inflightMax: 0 } } });
  assert.strictEqual(throttle.resolve('qoder', 'minIntervalMs').value, 0, '间隔 0 = 关断');
  assert.strictEqual(throttle.resolve('qoder', 'minIntervalMs').source, 'panel');
  assert.strictEqual(throttle.resolve('qoder', 'retryMax').value, 0, '重试 0 = 关断');
  assert.strictEqual(throttle.resolve('qoder', 'inflightMax').value, 3, '并发帽 0 = 未设，回 env');
  assert.strictEqual(throttle.resolve('qoder', 'inflightMax').source, 'env');
});

test('livecfg 按通道局部合并：只改 qoder 不动 traework', () => {
  reset();
  livecfg.Store({ throttle: { traework: { inflightMax: 2 } } });
  livecfg.Store({ throttle: { qoder: { minIntervalMs: 500 } } });
  const t = livecfg.Load().throttle;
  assert.strictEqual(t.traework.inflightMax, 2, '先写的通道不能被后来的写抹掉');
  assert.strictEqual(t.qoder.minIntervalMs, 500);
});

test('{通道:null} 是整条重置；通道内 null 是单项未设', () => {
  reset();
  livecfg.Store({ throttle: { qoder: { inflightMax: 1, retryMax: 2 } } });
  assert.strictEqual(livecfg.Load().throttle.qoder.inflightMax, 1);
  livecfg.Store({ throttle: { qoder: { retryMax: null } } });
  assert.strictEqual(livecfg.Load().throttle.qoder.retryMax, null, '单项 null = 未设');
  assert.strictEqual(livecfg.Load().throttle.qoder.inflightMax, 1, '逐项合并：清一项不连带清兄弟项');
  livecfg.Store({ throttle: { qoder: null } });
  const row = livecfg.Load().throttle.qoder;
  assert.deepStrictEqual(row, { inflightMax: null, minIntervalMs: null, retryMax: null }, '整条重置');
});

test('Load 形状固定：全通道 × 全旋钮都有键（缺的一个是 null）', () => {
  reset();
  livecfg.Store({ throttle: { workbuddy: { retryMax: 3 } } });
  const t = livecfg.Load().throttle;
  for (const ch of livecfg.THROTTLE_CHANNELS) {
    assert.ok(t[ch], `缺通道 ${ch}`);
    for (const k of livecfg.THROTTLE_KNOBS) {
      assert.ok(k in t[ch], `缺旋钮 ${ch}.${k}`);
    }
  }
  assert.strictEqual(t.workbuddy.retryMax, 3);
  assert.strictEqual(t.workbuddy.inflightMax, null);
});

test('非法输入：未知通道/旋钮、非法数值在接口侧抛错（strict），磁盘侧静默丢弃', () => {
  assert.throws(() => livecfg.Store({ throttle: { nope: { inflightMax: 1 } } }), /未知通道/);
  assert.throws(() => livecfg.Store({ throttle: { qoder: { bogus: 1 } } }), /未知旋钮/);
  assert.throws(() => livecfg.Store({ throttle: { qoder: { inflightMax: -1 } } }), /非负/);
  assert.throws(() => livecfg.Store({ throttle: { qoder: { inflightMax: 'abc' } } }), /非负/);
  // 磁盘宽容：坏字段不炸进程，整项丢弃
  const clean = livecfg.sanitize({ throttle: { nope: { x: 1 }, qoder: { inflightMax: 'abc', minIntervalMs: 7 } } });
  assert.deepStrictEqual(clean.throttle, { qoder: { minIntervalMs: 7 } });
});

test('消费方现读 1：channel-pool 的间隔闸门改了立即生效（不重启）', () => {
  reset();
  const a = { id: 3101, uid: 'uid-th-3101', nickname: '闸门3101', region: 'cn', enabled: true };
  const uid = `qoder:${a.id}`;
  pool.revive(uid);
  const s1 = channelPool.pickCandidate('qoder', [a], { model: 'gfmodel' });
  assert.ok(s1, '第一次应选中');
  channelPool.release(s1.uid);
  pool.revive(uid);

  livecfg.Store({ throttle: { qoder: { minIntervalMs: 60000 } } });
  const s2 = channelPool.pickCandidate('qoder', [a], { model: 'gfmodel' });
  assert.strictEqual(s2, null, '面板设了间隔就应跳开（无需重启进程）');
  // availability 要把原因报成 interval，而不是一句「没有可用账号」
  const av = channelPool.availability('qoder', [a], { model: 'gfmodel' });
  assert.strictEqual(av.usable, false);
  assert.ok((av.details || []).some((d) => d.reason === 'interval'), `details 应给出 interval: ${JSON.stringify(av.details)}`);

  livecfg.Store({ throttle: { qoder: null } });
  const s3 = channelPool.pickCandidate('qoder', [a], { model: 'gfmodel' });
  assert.ok(s3, '重置后立即恢复');
  channelPool.release(s3.uid);
  pool.revive(uid);
});

test('消费方现读 2：repair.envCaps 的 REPAIR_MAX 面板覆盖 env，HOLD_CAP 仍只认 env', () => {
  reset();
  process.env.DUMATE_QWENWORK_REPAIR_RETRY = '1';
  process.env.DUMATE_QWENWORK_HOLD_CAP = '300';
  assert.strictEqual(repair.envCaps('QWENWORK').REPAIR_MAX, 1);
  livecfg.Store({ throttle: { qwenwork: { retryMax: 0 } } });
  const c = repair.envCaps('QWENWORK');
  assert.strictEqual(c.REPAIR_MAX, 0, '面板 0 = 关闭修复（穿透 env）');
  assert.strictEqual(c.HOLD_CAP, 300, 'HOLD_CAP 不进面板');
});

test('消费方现读 3：throttleMaxMs 热读、封顶下限 1000', () => {
  reset();
  assert.strictEqual(throttle.throttleMaxMs().value, 600000, '默认');
  process.env.DUMATE_THROTTLE_MAX_MS = '120000';
  assert.strictEqual(throttle.throttleMaxMs().value, 120000);
  livecfg.Store({ throttleMaxMs: 30000 });
  assert.strictEqual(throttle.throttleMaxMs().value, 30000, '面板优先');
  livecfg.Store({ throttleMaxMs: 5 });
  assert.strictEqual(throttle.throttleMaxMs().value, 1000, '5ms 会被抬到 1000（封顶不能变 0）');
  // 真正的作用点：classifyType 的 retryAfterMs 被这个值夹住
  const { classify } = require('../../src/upstream-errors');
  livecfg.Store({ throttleMaxMs: 5000 });
  const cls = classify({ status: 429, body: '{"retryAfterSeconds":7015}' });
  if (cls.kind === 'soft' && cls.retryAfterMs) {
    assert.ok(cls.retryAfterMs <= 5000, `retryAfterMs 应被夹到 5000，实为 ${cls.retryAfterMs}`);
  }
});

// ---------------------------------------------------------------------------
test('管理端 GET /throttle：报「生效值 + 来源 + 兜底」，不只是面板数字', () => {
  reset();
  livecfg.Store({ throttle: { qoder: { inflightMax: 2 } }, throttleMaxMs: 40000 });
  process.env.DUMATE_QODER_MIN_INTERVAL_MS = '900';
  const res = fakeRes();
  routeOf('GET', '/throttle').handler({ res });
  assert.strictEqual(res.out.status, 200);
  const body = res.out.body;
  assert.strictEqual(body.throttleMaxMs.value, 40000);
  const qoder = body.channels.find((c) => c.channel === 'qoder');
  assert.strictEqual(qoder.label, 'Qoder', '标签来自 channels.js 单一来源');
  assert.strictEqual(qoder.knobs.inflightMax.source, 'panel');
  assert.strictEqual(qoder.knobs.inflightMax.effective, 2);
  assert.strictEqual(qoder.knobs.minIntervalMs.source, 'env');
  assert.strictEqual(qoder.knobs.minIntervalMs.effective, 900);
  assert.strictEqual(qoder.knobs.retryMax.source, 'default');
  assert.strictEqual(qoder.knobs.retryMax.effective, 1, '未设时兜底是 repair 的默认 1（单一来源）');
  const trae = body.channels.find((c) => c.channel === 'traework');
  assert.strictEqual(trae.knobs.inflightMax.fallback, 4, '并发帽兜底是池默认');
});

test('管理端 POST /pool-revive：只复位本通道账号，未知通道 400', () => {
  reset();
  pool.disable('qoder:4401', '测试禁用');
  pool.disable('traework:4402', '测试禁用');
  const res = fakeRes();
  routeOf('POST', '/pool-revive').handler({ res, body: { channel: 'traework' } });
  assert.strictEqual(res.out.status, 200);
  const st = Object.fromEntries((pool.snapshot() || []).map((r) => [r.id, r.state]));
  assert.strictEqual(st['traework:4402'], 'healthy', '本通道应复位');
  assert.strictEqual(st['qoder:4401'], 'disabled', '别的通道不该被顺手复位');
  assert.strictEqual(res.out.body.revived, 1);

  const bad = fakeRes();
  routeOf('POST', '/pool-revive').handler({ res: bad, body: { channel: 'dumate' } });
  assert.strictEqual(bad.out.status, 400, '网页池通道不归它管，要明确拒绝');
  assert.match(bad.out.body.error, /未知通道/);

  // 收尾：别把测试态留在共享池文件里
  pool.revive('qoder:4401');
});
