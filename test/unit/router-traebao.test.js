// test/unit/router-traebao.test.js - TRAE 宝（traebao/）前缀路由
//
// traebao/ 不是第五个通道：与 traework 同账号池/凭证/后端，差异只有对话身份
// （function=personal_assistant）。回归点：resolve() 必须把通道归属记成
// traework 且带 personalAssistant 标记——归属错了会绕开 traework 的池状态
// 与埋点；标记丢了 send() 就不会换身份，免费豁免悄悄失效。
const { test } = require('node:test');
const assert = require('assert');
const router = require('../../src/upstream-router');

test('traebao/auto 路由到 traework 通道并带 personalAssistant 标记', () => {
  const r = router.resolve('traebao/auto');
  assert.strictEqual(r.channel, 'traework');
  assert.strictEqual(r.model, 'auto');
  assert.strictEqual(r.personalAssistant, true);
  assert.strictEqual(r.target.personalAssistant, true);
  // 与 traework 共用同一套直连语义（provider 选择、预算）
  assert.strictEqual(r.target.direct, true);
  assert.strictEqual(r.target.needsBudget, true);
});

test('traebao/<模型名> 剥前缀透传模型名', () => {
  const r = router.resolve('traebao/deepseek-v4.1-flash');
  assert.strictEqual(r.channel, 'traework');
  assert.strictEqual(r.model, 'deepseek-v4.1-flash');
  assert.strictEqual(r.personalAssistant, true);
});

test('traework/ 前缀不受影响（无 personalAssistant 标记）', () => {
  const r = router.resolve('traework/glm-5.2');
  assert.strictEqual(r.channel, 'traework');
  assert.strictEqual(r.model, 'glm-5.2');
  assert.strictEqual(r.personalAssistant, undefined);
  assert.strictEqual(r.target.personalAssistant, undefined);
});

test('traebao 不是独立通道：availability/exposedFor 走 traework 形状', () => {
  // exposedFor 只认通道 id，traebao 归属 traework——模型清单不因前缀分家
  const models = router.exposedFor('traework', ['glm-5.2']);
  assert.deepStrictEqual(models, ['traework/glm-5.2']);
});
