// test/unit/dumate-caps.test.js - 搭子按模型 max_tokens 上限（实测表 + 自学习）
//
// 背景：全局 DUMATE_MAX_MAX_TOKENS=131072 来自 GLM 一家的范围。2026-10-31
// 真机复测：云网关按模型转发（千帆 GLM / 千帆 DeepSeek / Kimi / 阿里百炼），
// 各家范围不同，400 错误体原样透传上游声明。静态表存实测值，学习器在撞 400
// 时从错误体解析范围并落盘（7 天 TTL），clamp 用学习值优先。
const { test } = require('node:test');
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-caps-'));
process.env.DUMATE_ADMIN_DATA = TMP; // 在 require 之前
delete process.env.DUMATE_DUMATE_CAPS_FILE;
const caps = require('../../src/dumate-caps');
const budget = require('../../src/budget');

test('parseCap: 三种上游声明格式都能解析', () => {
  assert.strictEqual(caps.parseCap('parameter check failed, max_tokens range is [1, 393216]'), 393216);
  assert.strictEqual(caps.parseCap('max_tokens参数非法：限制数值范围[1,131072]'), 131072);
  assert.strictEqual(caps.parseCap('Range of max_tokens should be [1, 131072]'), 131072);
});

test('parseCap: 网关包装层（转义引号 + 前缀噪声）不影响解析', () => {
  const wrapped = 'Post "https://qianfan.baidubce.com/v2/chat/completions": 后端服务返回非2xx状态码. '
    + 'Backend response status code[400]: bad request. {\\"error\\":{\\"code\\":\\"invalid_argument\\",'
    + '\\"message\\":\\"parameter check failed, max_tokens range is [1, 393216]\\",\\"type\\":\\"invalid_request_error\\"}}';
  assert.strictEqual(caps.parseCap(wrapped), 393216);
});

test('parseCap: 无关错误体返回 null', () => {
  assert.strictEqual(caps.parseCap('Prompt 超长'), null);
  assert.strictEqual(caps.parseCap(''), null);
  assert.strictEqual(caps.parseCap(null), null);
});

test('capOf: 静态表按映射后模型名取值', () => {
  assert.strictEqual(caps.capOf('dm-auto-model/text.L0'), 393216);
  assert.strictEqual(caps.capOf('model-text'), 393216);
  assert.strictEqual(caps.capOf('dm-auto-model/text.L1'), 2000000);
  assert.strictEqual(caps.capOf('dm-auto-model/text.L2'), 131072);
  assert.strictEqual(caps.capOf('glm-5'), 131072);
});

test('capOf: 未收录模型返回 null（回落全局 CEIL）', () => {
  assert.strictEqual(caps.capOf('model-artifact-validate'), null);
  assert.strictEqual(caps.capOf(''), null);
  assert.strictEqual(caps.capOf(undefined), null);
});

test('learn + capOf: 学习值覆盖静态表并落盘', () => {
  const wrapped = '{"error":{"code":"invalid_argument","message":"parameter check failed, '
    + 'max_tokens range is [1, 262144]","type":"invalid_request_error"}}';
  assert.strictEqual(caps.learn('dm-auto-model/text.L0', wrapped), true);
  assert.strictEqual(caps.capOf('dm-auto-model/text.L0'), 262144);
  const persisted = JSON.parse(fs.readFileSync(caps.filePath(), 'utf8'));
  assert.strictEqual(persisted['dm-auto-model/text.L0'].n, 262144);
  assert.ok(persisted['dm-auto-model/text.L0'].at > 0);
});

test('learn: 认不出的错误体不写盘', () => {
  const before = fs.readFileSync(caps.filePath(), 'utf8');
  assert.strictEqual(caps.learn('glm-5', 'Prompt 超长'), false);
  assert.strictEqual(fs.readFileSync(caps.filePath(), 'utf8'), before);
});

test('capOf: 超过 TTL（7 天）的学习值失效，回落静态表', () => {
  const data = {};
  data['dm-auto-model/text.L0'] = { n: 999, at: Date.now() - caps.TTL_MS - 1000 };
  fs.writeFileSync(caps.filePath(), JSON.stringify(data));
  assert.strictEqual(caps.capOf('dm-auto-model/text.L0'), 393216);
});

test('budget.resolveMaxTokens: cap 缺失时与旧行为一致（全局 CEIL）', () => {
  assert.strictEqual(budget.resolveMaxTokens(500000), 131072);
  assert.strictEqual(budget.resolveMaxTokens(0), 65536);
  assert.strictEqual(budget.resolveMaxTokens(1000), 65536);
});

test('budget.resolveMaxTokens: 按模型 cap 放宽与收紧', () => {
  assert.strictEqual(budget.resolveMaxTokens(500000, 393216), 393216); // 放宽：L0
  assert.strictEqual(budget.resolveMaxTokens(2000000, 2000000), 2000000); // L1 不压
  assert.strictEqual(budget.resolveMaxTokens(500000, 131072), 131072); // glm-5 维持
  assert.strictEqual(budget.resolveMaxTokens(0, 393216), 65536); // 默认值 + floor 不受 cap 影响
});

test('budget.resolveMaxTokens: cap 低于 floor 时上游范围优先（宁可发小也别 400）', () => {
  assert.strictEqual(budget.resolveMaxTokens(100000, 32768), 32768);
});
