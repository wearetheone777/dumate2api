// test/unit/trae-fusion-runtime.test.js - TRAE 运行态配置 / 降级 / 选号策略
//
// 全部离线：DUMATE_ADMIN_DATA 指向临时目录，打桩选号余额，不触网、不碰 data/。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-trae-fusion-'));
process.env.DUMATE_ADMIN_DATA = tmp;

const runtime = require('../../src/trae-runtime');
const degrade = require('../../src/traework/degrade');
const policy = require('../../src/traework/policy');

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结果 */ }
});

test('运行态配置：默认全关，Load 返回私有拷贝', () => {
  runtime._resetForTest();
  const c = runtime.Load();
  assert.strictEqual(c.degrade.enabled, false);
  assert.strictEqual(c.maxMode.enabled, false);
  assert.strictEqual(c.pickStrategy, 'round-robin');
  assert.strictEqual(c.gatewayPaused, false);
  c.maxMode.models.push('intruder');
  c.degrade.enabled = true;
  assert.deepStrictEqual(runtime.Load().maxMode.models, []);
  assert.strictEqual(runtime.Load().degrade.enabled, false);
});

test('运行态配置：patch 深合并 + mtime 热读 + 未知键严格拒绝', () => {
  runtime._resetForTest();
  runtime.Store({ degrade: { enabled: true, fallbackModel: 'deepseek-v4.1-flash' } });
  const c = runtime.Store({ maxMode: { enabled: true, models: [' glm-5.2 ', 'glm-5.2'] } });
  assert.strictEqual(c.degrade.enabled, true, 'degrade 不应被后一次 patch 覆盖');
  assert.strictEqual(c.degrade.fallbackModel, 'deepseek-v4.1-flash');
  assert.deepStrictEqual(c.maxMode.models, ['glm-5.2']);
  runtime._resetForTest();                    // 模拟另一个进程
  assert.strictEqual(runtime.Load().maxMode.enabled, true);
  assert.throws(() => runtime.Store({ junk: 1 }), /未知配置键/);
  assert.throws(() => runtime.Store({ pickStrategy: 'random' }), /round-robin/);
  assert.throws(() => runtime.Store({ degrade: { warnBelow: -1 } }), /非负数字/);
});

test('降级判据：只认确证额度/升级错误，限流与参数错误不降级', () => {
  assert.strictEqual(degrade.reasonOf({ statusCode: 402, message: '余额不足' }), 'quota');
  assert.strictEqual(degrade.reasonOf({ message: 'traework 3004: credits exhausted' }), 'quota');
  assert.strictEqual(degrade.reasonOf({ message: 'traework 1005: 订阅专享' }), 'upgrade');
  assert.strictEqual(degrade.reasonOf({ message: 'upgrade_required' }), 'upgrade');
  assert.strictEqual(degrade.reasonOf({ statusCode: 429, message: 'RESOURCE_LIMIT isQueued' }), null);
  assert.strictEqual(degrade.reasonOf({ statusCode: 400, message: 'param is invalid' }), null);
});

test('降级计划：默认关 / 备用名保持前缀 / Key 区域绑定不被越过 / TRAE 宝跳过', () => {
  const off = { enabled: false, fallbackModel: 'x', fallbackRegion: 'intl', onQuota: true, onUpgrade: true };
  assert.strictEqual(degrade.plan(off, { statusCode: 402, message: '额度不足' }, { model: 'traework/glm-5.2' }), null);
  const cfg = { ...off, enabled: true, fallbackModel: 'deepseek-v4.1-flash' };
  const p = degrade.plan(cfg, { statusCode: 402, message: '额度不足' }, {
    model: 'traework/glm-5.2', region: '', persona: false,
  });
  assert.strictEqual(p.model, 'traework/deepseek-v4.1-flash');
  assert.strictEqual(p.region, 'intl');
  assert.match(p.header, /\(quota\)/);
  const bound = degrade.plan(cfg, { statusCode: 402, message: '额度不足' }, {
    model: 'traework/glm-5.2', region: 'cn', persona: false,
  });
  assert.strictEqual(bound.region, 'cn', 'Key 已绑定 cn 时不得切 intl');
  assert.strictEqual(degrade.plan(cfg, { statusCode: 402, message: '额度不足' }, {
    model: 'traebao/deepseek-v4.1-flash', persona: true,
  }), null);
  assert.strictEqual(degrade.plan(cfg, { statusCode: 402, message: '额度不足' }, {
    model: 'traework/glm-5.2', tried: true,
  }), null);
});

test('额度预警：余额未知不参与比较，0 是真实读数', () => {
  const cfg = { enabled: true, warnBelow: 100 };
  const w = degrade.warningsOf(cfg, [
    { id: 1, nickname: 'A', remain: 20 },
    { id: 2, nickname: 'B', remain: null },
    { id: 3, nickname: 'C', remain: 200 },
  ]);
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].accountId, 1);
  assert.strictEqual(degrade.warningsOf({ enabled: false, warnBelow: 100 }, [{ id: 1, remain: 0 }]).length, 0);
});

test('积分优先：已知余额降序，未知值沉底且稳定排序', () => {
  const list = [{ id: 1, credits: null }, { id: 2, credits: 10 }, { id: 3, credits: 50 }, { id: 4, credits: null }];
  const io = { creditsOf: (a) => a.credits };
  assert.deepStrictEqual(policy.orderCandidates(list, 'round-robin', io).map((a) => a.id), [1, 2, 3, 4]);
  assert.deepStrictEqual(policy.orderCandidates(list, 'credits-desc', io).map((a) => a.id), [3, 2, 1, 4]);
});

test('保留积分护栏：未知不跳过、关闭时原样返回', () => {
  const list = [{ id: 1, credits: 20 }, { id: 2, credits: 300 }, { id: 3, credits: null }];
  const io = { creditsOf: (a) => a.credits };
  const g = policy.guardCandidates(list, { enabled: true, reserveCredits: 100 }, io);
  assert.deepStrictEqual(g.rows.map((a) => a.id), [2, 3]);
  assert.deepStrictEqual(g.blocked.map((x) => x.id), [1]);
  assert.deepStrictEqual(policy.guardCandidates(list, { enabled: false }, io).rows, list);
  assert.match(policy.unavailableReason({ total: 2, modelUsable: 0, blocked: [] }), /关闭了「接模型请求」/);
});
