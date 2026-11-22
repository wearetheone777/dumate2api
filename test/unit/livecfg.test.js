// test/unit/livecfg.test.js - 热配置 livecfg 的白名单 / 快照拷贝 / 落盘热生效
//
// 运行：node --test test/unit/（零依赖，不碰真实 data/——DUMATE_ADMIN_DATA
// 指向临时目录，require 之前置好）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// livecfg 按调用时读 env；reqlog 在 require 时固化 LOG_DIR——都必须先设目录
const { tmpDir } = require('../helpers/tmpdir');
const tmp = tmpDir('dumate-livecfg');
process.env.DUMATE_ADMIN_DATA = tmp;

const livecfg = require('../../src/livecfg');
const reqlog = require('../../src/reqlog');

function reset() {
  livecfg._resetForTest();
}

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* tmp 清理失败不影响结果 */ }
});

test('无配置文件时返回默认值（recordClientInfo 默认开，向后兼容既有日志）', () => {
  reset();
  const cfg = livecfg.Load();
  assert.deepStrictEqual(cfg, { recordClientInfo: true, hiddenModels: [], softCooldownMs: 0 });
});

test('sanitize 非严格（磁盘读）：未知键丢弃，不炸', () => {
  const out = livecfg.sanitize({ recordClientInfo: false, junk: 1, hiddenModels: [' m1 ', '', 'm1'] });
  assert.deepStrictEqual(out, { recordClientInfo: false, hiddenModels: ['m1'] });
});

test('sanitize 严格（接口提交）：未知键抛错', () => {
  assert.throws(() => livecfg.sanitize({ nope: true }, { strict: true }), /未知配置键/);
});

test('hiddenModels 清洗：去空白、滤空、去重；非数组严格模式抛错', () => {
  const out = livecfg.sanitize({ hiddenModels: [' a ', 'a', '', null] });
  assert.deepStrictEqual(out.hiddenModels, ['a']);
  assert.throws(() => livecfg.sanitize({ hiddenModels: 'a' }, { strict: true }), /字符串数组/);
});

test('softCooldownMs：非负数取整；负数/非数严格模式抛错', () => {
  assert.strictEqual(livecfg.sanitize({ softCooldownMs: 1500.6 }).softCooldownMs, 1501);
  assert.throws(() => livecfg.sanitize({ softCooldownMs: -1 }, { strict: true }), /非负/);
  assert.throws(() => livecfg.sanitize({ softCooldownMs: 'abc' }, { strict: true }), /非负/);
});

test('Store 是 patch 语义：只改提交的键，其余保留', () => {
  reset();
  livecfg.Store({ hiddenModels: ['glm-5'] });
  const cfg = livecfg.Store({ softCooldownMs: 1000 });
  assert.deepStrictEqual(cfg.hiddenModels, ['glm-5']);
  assert.strictEqual(cfg.softCooldownMs, 1000);
  assert.strictEqual(cfg.recordClientInfo, true);
});

test('Load 返回私有拷贝：改返回值不污染内部状态（审计教训：集合字段必须复制）', () => {
  reset();
  livecfg.Store({ hiddenModels: ['a'] });
  const c1 = livecfg.Load();
  c1.hiddenModels.push('intruder');
  c1.recordClientInfo = false;
  const c2 = livecfg.Load();
  assert.deepStrictEqual(c2.hiddenModels, ['a']);
  assert.strictEqual(c2.recordClientInfo, true);
});

test('Store 落盘且换进程视角可读（mtime 失效重读 = 跨进程热生效）', () => {
  reset();
  livecfg.Store({ recordClientInfo: false, hiddenModels: ['x'] });
  assert.ok(fs.existsSync(livecfg.filePath()));
  // 模拟另一个进程：缓存清零后按 mtime 重读磁盘
  reset();
  const cfg = livecfg.Load();
  assert.strictEqual(cfg.recordClientInfo, false);
  assert.deepStrictEqual(cfg.hiddenModels, ['x']);
});

test('applyHiddenModels：/v1/models 与 /v1beta/models 输出侧过滤（hiddenModels 消费接线）', () => {
  reset();
  livecfg.Store({ hiddenModels: ['glm-5', 'qwen/secret'] });
  // OpenAI 形态:{id} 精确比对
  const openai = livecfg.applyHiddenModels([
    { id: 'glm-5', object: 'model' },
    { id: 'model-text', object: 'model' },
    { id: 'qwen/secret', object: 'model' },
    { id: 'qwen/pro', object: 'model' },
  ]);
  assert.deepStrictEqual(openai.map((m) => m.id), ['model-text', 'qwen/pro']);
  // Google 形态:{name:'models/<id>'} 自剥前缀后比对裸名
  const google = livecfg.applyHiddenModels([
    { name: 'models/glm-5', displayName: 'GLM-5' },
    { name: 'models/model-text', displayName: 'x' },
  ]);
  assert.deepStrictEqual(google.map((m) => m.name), ['models/model-text']);
  // 大小写敏感:名单里是大写,小写 id 不受影响
  reset();
  livecfg.Store({ hiddenModels: ['GLM-5'] });
  assert.strictEqual(livecfg.applyHiddenModels([{ id: 'glm-5' }]).length, 1);
  // 空名单 / 非数组入参原样返回（隐藏是可选能力,故障不放大）
  livecfg.Store({ hiddenModels: [] });
  const rows = [{ id: 'glm-5' }];
  assert.strictEqual(livecfg.applyHiddenModels(rows), rows);
  assert.strictEqual(livecfg.applyHiddenModels('nope'), 'nope');
});

test('reqlog.record 联动（F6e）：开关关→不落 ip/ua，开→照常落', () => {
  reset();
  const file = path.join(reqlog.LOG_DIR, 'requests.jsonl');
  try { fs.unlinkSync(file); } catch (e) { /* 首次不存在 */ }

  livecfg.Store({ recordClientInfo: false });
  reqlog.record({ ts: 1, path: '/v1/x', ip: '127.0.0.1', ua: 'test-agent' });
  let row = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.strictEqual(row.ip, undefined);
  assert.strictEqual(row.ua, undefined);

  livecfg.Store({ recordClientInfo: true });
  reqlog.record({ ts: 2, path: '/v1/x', ip: '127.0.0.1', ua: 'test-agent' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  row = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(row.ip, '127.0.0.1');
  assert.strictEqual(row.ua, 'test-agent');
});
