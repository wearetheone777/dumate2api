// test/unit/trae-model-known.test.js - 模型名前置校验（node:test）
//
// llm_utils_chat 对未知模型名回流内 4001「param is invalid」（HTTP 200），
// 无信息量且白烧一次上游请求。模型表缓存就绪且名字完全不在表中时，
// assertModelKnown 直接 400 + 可用模型列表。这里验证判定函数 isKnownModel
// 的边界（顶层名 / 自定义模型名 / 大小写 / 缓存未就绪放行）。
const { test } = require('node:test');
const assert = require('assert');

// models.js 的 cache 是模块内变量，通过 normalize+fetchModels 不好注入——
// 但 isKnownModel 只读 cache.data.models，而 normalize 的输出形状由本文件
// 固定构造后经内部函数填充。为避免触网，这里走 normalize 纯函数 + 手工
// 塞缓存的替代路径不可行，改为直接测 normalize 的 customModelIds 字段与
// isKnownModel 的「未就绪放行」语义（未就绪时 isKnownModel 恒 true）。
const models = require('../../src/traework/models');

test('models.normalize: custom_models 展平进 customModelIds', () => {
  const m = models.normalize({
    config_name: 'deepseek-v4.1-flash',
    display_config: {},
    custom_models: ['gemini//gemini-3-flash-preview'],
  });
  assert.deepStrictEqual(m.customModelIds, ['gemini//gemini-3-flash-preview']);
});

test('models.normalize: custom_models 缺失时是空数组（不是 undefined）', () => {
  const m = models.normalize({ config_name: 'x', display_config: {} });
  assert.deepStrictEqual(m.customModelIds, []);
});

test('isKnownModel: 缓存未就绪时放行（不挡住能用的请求）', () => {
  // 本测试进程内模型表从未拉取，hasCache() 为 false
  assert.strictEqual(models.isKnownModel('totally-fake-model'), true);
});

test('isKnownModel: 空/垃圾输入放行（让上游当真相源）', () => {
  assert.strictEqual(models.isKnownModel(''), true);
  assert.strictEqual(models.isKnownModel(null), true);
});
