// test/unit/qoder-runtime.test.js - Qoder 运行期配置（P0-3）
//
// 调研出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P0-3「运行时配置面板化（热生效）」
// ——要修的真问题是 `qoder/chat.js` 的三个计时器在**模块加载时**读一次 env 就
// 定死，调阈值必须重启网关（这类「定时器写死」造成过一次 6s 误杀大上下文的事故）。
//
// 锁住的纪律（与 workbuddy/runtime、trae-runtime、livecfg 同构）：
//   1. 白名单：磁盘宽容（未知键丢弃）/ 接口提交严格（未知键 400）
//   2. env 是默认值来源——只设 env 不碰面板，行为逐字节不变
//   3. Store 后**同一进程内立刻读到新值**（mtime 失效），且返回私有拷贝
//   4. 越界/类型错一律抛错，不静默吞成默认值
//   5. 文件不存在时不缓存默认快照（否则「改 env 再重读」的离线脚本会失真）
//
// 运行：node --test test/unit/qoder-runtime.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { tmpDir } = require('../helpers/tmpdir');
const TMP = tmpDir('dumate-qoder-runtime');
process.env.DUMATE_ADMIN_DATA = TMP;

const runtime = require('../../src/qoder/runtime');

function cleanup() {
  try { fs.unlinkSync(runtime.filePath()); } catch (e) { /* 不存在 */ }
  runtime._resetForTest();
}

test('默认值来自 env：只设环境变量时行为与手写常量一致', () => {
  cleanup();
  const oldFb = process.env.DUMATE_QODER_FIRST_BYTE_MS;
  process.env.DUMATE_QODER_FIRST_BYTE_MS = '45000';
  runtime._resetForTest();
  const d = runtime.defaults();
  assert.strictEqual(d.timeouts.firstByteMs, 45000);
  assert.strictEqual(d.timeouts.contentMs, 90000, '无内容阈值默认 90s（6s 那次误杀的修正）');
  assert.strictEqual(d.timeouts.readIdleMs, 120000);
  assert.strictEqual(d.timeouts.maxBodyMb, 29, '对齐阿里云 SLB 30MB');
  assert.strictEqual(d.queue.pollEnabled, true, '官方排队轮询默认开');
  assert.strictEqual(d.limits.fefoDays, 3);
  if (oldFb === undefined) delete process.env.DUMATE_QODER_FIRST_BYTE_MS;
  else process.env.DUMATE_QODER_FIRST_BYTE_MS = oldFb;
});

test('env 非法值回落到默认（不让配置错把热路径弄崩）', () => {
  cleanup();
  const old = process.env.DUMATE_QODER_READ_IDLE_MS;
  process.env.DUMATE_QODER_READ_IDLE_MS = 'abc';
  runtime._resetForTest();
  assert.strictEqual(runtime.defaults().timeouts.readIdleMs, 120000);
  process.env.DUMATE_QODER_READ_IDLE_MS = '-5';
  runtime._resetForTest();
  assert.strictEqual(runtime.defaults().timeouts.readIdleMs, 120000, '负数越界也回默认');
  if (old === undefined) delete process.env.DUMATE_QODER_READ_IDLE_MS;
  else process.env.DUMATE_QODER_READ_IDLE_MS = old;
});

test('Store 后同进程立刻读到新值，且 Load 返回私有拷贝', () => {
  cleanup();
  const before = runtime.Load().timeouts.contentMs;
  runtime.Store({ timeouts: { contentMs: 6000 } });
  assert.strictEqual(runtime.Load().timeouts.contentMs, 6000, '写完立刻可见（mtime 失效重读）');
  // 私有拷贝：调用方改返回值不能污染后续读者
  const snap = runtime.Load();
  snap.timeouts.contentMs = 1;
  snap.queue.patienceMs = 1;
  assert.strictEqual(runtime.Load().timeouts.contentMs, 6000);
  assert.strictEqual(runtime.Load().queue.patienceMs, 6000);
  // patch 语义：只改传入的子字段，其余保持
  runtime.Store({ timeouts: { contentMs: before } });
  assert.strictEqual(runtime.Load().timeouts.contentMs, before);
});

test('Store 是 patch 语义：不同族互不影响', () => {
  cleanup();
  runtime.Store({ limits: { fefoDays: 7 } });
  runtime.Store({ repair: { retry: 0 } });
  const cfg = runtime.Load();
  assert.strictEqual(cfg.limits.fefoDays, 7, '第二次写不该把第一次的族冲掉');
  assert.strictEqual(cfg.repair.retry, 0);
  assert.strictEqual(cfg.queue.patienceMs, 6000, '没动过的字段保持默认');
  cleanup();
});

test('未知顶层键 400 式抛错（不静默丢弃）', () => {
  cleanup();
  assert.throws(() => runtime.Store({ timeout: { contentMs: 1 } }), /未知配置键/);
  assert.throws(() => runtime.Store({ nope: 1 }), /白名单/);
});

test('未知子键 400 式抛错（填错键名不能被静默吞掉）', () => {
  cleanup();
  assert.throws(() => runtime.Store({ timeouts: { contentMS: 6000 } }), /未知配置键: timeouts\.contentMS/);
  assert.throws(() => runtime.Store({ queue: { poll: true } }), /queue\.poll/);
});

test('越界/小数/类型错一律抛错，不落盘', () => {
  cleanup();
  assert.throws(() => runtime.Store({ timeouts: { maxBodyMb: 0 } }), /maxBodyMb/);
  assert.throws(() => runtime.Store({ timeouts: { contentMs: 1.5 } }), /contentMs/);
  assert.throws(() => runtime.Store({ queue: { stepMs: 100 } }), /stepMs/);
  assert.throws(() => runtime.Store({ limits: { fefoDays: 400 } }), /fefoDays/);
  assert.throws(() => runtime.Store({ repair: { retry: 9 } }), /retry/);
  // 抛错的写不该留下文件
  assert.strictEqual(fs.existsSync(runtime.filePath()), false);
});

test('0 在各族的语义都被接受（关闭类取值不是「非法」）', () => {
  cleanup();
  runtime.Store({
    timeouts: { firstByteMs: 0, contentMs: 0, readIdleMs: 0 },
    queue: { pollBudgetMs: 0, pollIntervalMs: 0 },
    limits: { fefoDays: 0 },
    repair: { retry: 0 },
  });
  const cfg = runtime.Load();
  assert.strictEqual(cfg.timeouts.firstByteMs, 0);
  assert.strictEqual(cfg.timeouts.contentMs, 0);
  assert.strictEqual(cfg.queue.pollIntervalMs, 0);
  assert.strictEqual(cfg.limits.fefoDays, 0);
  cleanup();
});

test('pollEnabled 是布尔：非 true 一律 false', () => {
  cleanup();
  runtime.Store({ queue: { pollEnabled: false } });
  assert.strictEqual(runtime.Load().queue.pollEnabled, false);
  runtime.Store({ queue: { pollEnabled: 'yes' } });
  assert.strictEqual(runtime.Load().queue.pollEnabled, false, '字符串不等于 true');
  runtime.Store({ queue: { pollEnabled: true } });
  assert.strictEqual(runtime.Load().queue.pollEnabled, true);
  cleanup();
});

test('磁盘上的未知键被丢弃、坏文件不挡住启动', () => {
  cleanup();
  fs.writeFileSync(runtime.filePath(), JSON.stringify({
    timeouts: { contentMs: 5000, bogus: 1 },
    garbage: { x: 1 },
  }), 'utf8');
  runtime._resetForTest();
  const cfg = runtime.Load();
  assert.strictEqual(cfg.timeouts.contentMs, 5000, '合法字段照读');
  assert.strictEqual(cfg.timeouts.bogus, undefined, '未知子键丢弃');
  assert.strictEqual(cfg.garbage, undefined, '未知顶层键丢弃');
  // 坏 JSON：整份回默认，不抛
  fs.writeFileSync(runtime.filePath(), '{ not json', 'utf8');
  runtime._resetForTest();
  assert.strictEqual(runtime.Load().timeouts.contentMs, 90000);
  cleanup();
});

test('pick：热路径安全取值，读不到回默认且不抛', () => {
  cleanup();
  assert.strictEqual(runtime.pick('timeouts.contentMs', 1), 90000);
  runtime.Store({ timeouts: { contentMs: 12345 } });
  assert.strictEqual(runtime.pick('timeouts.contentMs', 1), 12345);
  assert.strictEqual(runtime.pick('nope.nothing', 'x'), 'x');
  cleanup();
});

test('文件不存在时不缓存默认快照（离线脚本改 env 后重读要能看到新值）', () => {
  cleanup();
  const old = process.env.DUMATE_QODER_CONTENT_MS;
  process.env.DUMATE_QODER_CONTENT_MS = '30000';
  runtime._resetForTest();
  assert.strictEqual(runtime.pick('timeouts.contentMs', 0), 30000);
  // 不删 require.cache、不调 _resetForTest，直接改 env 再读——必须看到新值
  process.env.DUMATE_QODER_CONTENT_MS = '31000';
  assert.strictEqual(runtime.pick('timeouts.contentMs', 0), 31000,
    '文件不存在时默认快照不能被缓存');
  if (old === undefined) delete process.env.DUMATE_QODER_CONTENT_MS;
  else process.env.DUMATE_QODER_CONTENT_MS = old;
  cleanup();
});

test('chat.js 的三个计时器与请求体上限走运行期配置（热生效）', () => {
  cleanup();
  const chat = require('../../src/qoder/chat');
  assert.strictEqual(chat.firstByteMs(), 60000);
  assert.strictEqual(chat.contentMs(), 90000);
  assert.strictEqual(chat.readIdleMs(), 120000);
  assert.strictEqual(chat.maxBodyMb(), 29);

  runtime.Store({ timeouts: { firstByteMs: 1000, contentMs: 2000, readIdleMs: 3000, maxBodyMb: 2 } });
  assert.strictEqual(chat.firstByteMs(), 1000, '不重启网关就生效');
  assert.strictEqual(chat.contentMs(), 2000);
  assert.strictEqual(chat.readIdleMs(), 3000);
  assert.strictEqual(chat.maxBodyMb(), 2);
  // 请求体上限也跟着变：2MB 上限下 3MB 应被拒
  assert.throws(() => chat.assertBodySize('a'.repeat(3 * 1024 * 1024)), (e) => {
    assert.strictEqual(e.statusCode, 413);
    assert.ok(/2MB/.test(e.message));
    return true;
  });
  cleanup();
});

test('upstream-errors 的两个冷却常量是懒读（面板改上限后不必重启）', () => {
  cleanup();
  const ue = require('../../src/upstream-errors');
  assert.strictEqual(ue.THROTTLE_MAX_MS, 600000);
  assert.strictEqual(ue.QUEUE_THROTTLE_COOLDOWN_MS, 5000);
  runtime.Store({ limits: { throttleMaxMs: 120000 }, queue: { cooldownMs: 2000 } });
  assert.strictEqual(ue.THROTTLE_MAX_MS, 120000, 'getter 每次读当前生效值');
  assert.strictEqual(ue.QUEUE_THROTTLE_COOLDOWN_MS, 2000);
  // 分类结果跟着变：排队类限流用新的短冷却
  const msg = '{"isQueued":true,"modelKey":"dfmodel","retryAfterSeconds":30,"serviceAvailable":false}';
  const c = ue.classify({ status: 403, message: msg, model: 'dfmodel' });
  assert.strictEqual(c.kind, 'soft');
  assert.strictEqual(c.retryAfterMs, 2000);
  cleanup();
});

test('并发闸门（P1-6）：面板值热生效，0 = 用池默认，env 仍是兜底', () => {
  cleanup();
  const cp = require('../../src/channel-pool');
  // 默认：0 = 不改变现有行为（不给 Qoder 静默加限制）
  assert.strictEqual(runtime.defaults().concurrency.inflightMax, 0);
  assert.strictEqual(cp.inflightMaxOf('qoder'), 0);
  assert.strictEqual(cp.minIntervalMsOf('qoder'), 0);
  assert.strictEqual(cp.pickStrategyOf('qoder'), '');

  runtime.Store({ concurrency: { inflightMax: 1, minIntervalMs: 800, pickStrategy: 'least-inflight' } });
  assert.strictEqual(cp.inflightMaxOf('qoder'), 1, '面板设 1 立刻生效（不必重启）');
  assert.strictEqual(cp.minIntervalMsOf('qoder'), 800);
  assert.strictEqual(cp.pickStrategyOf('qoder'), 'least-inflight');
  cleanup();
});

test('并发闸门：只认白名单策略名（填错不静默变成关闭）', () => {
  cleanup();
  assert.throws(() => runtime.Store({ concurrency: { pickStrategy: 'round-robin' } }), /pickStrategy/);
  runtime.Store({ concurrency: { pickStrategy: '' } });
  assert.strictEqual(runtime.Load().concurrency.pickStrategy, '', '空串 = 池默认，是合法值');
  assert.throws(() => runtime.Store({ concurrency: { inflightMax: 65 } }), /inflightMax/);
  cleanup();
});

test('并发闸门：别的通道不受影响（只对 qoder 开了配置面）', () => {
  cleanup();
  const cp = require('../../src/channel-pool');
  runtime.Store({ concurrency: { inflightMax: 1 } });
  assert.strictEqual(cp.inflightMaxOf('qoder'), 1);
  assert.strictEqual(cp.inflightMaxOf('traework'), 0, 'TRAE 仍走 env（未配置时为 0）');
  cleanup();
});

test('Store 在全新数据目录下也能成功（先建目录再取锁）', () => {
  cleanup();
  const dir = path.join(TMP, 'fresh', 'nested');
  const old = process.env.DUMATE_ADMIN_DATA;
  process.env.DUMATE_ADMIN_DATA = dir;
  runtime._resetForTest();
  try {
    // 目录不存在时 filelock 的锁文件 openSync 会 ENOENT，Store 必须先建目录
    assert.doesNotThrow(() => runtime.Store({ timeouts: { contentMs: 45000 } }));
    assert.strictEqual(runtime.Load().timeouts.contentMs, 45000);
  } finally {
    process.env.DUMATE_ADMIN_DATA = old;
    runtime._resetForTest();
    cleanup();
  }
});
