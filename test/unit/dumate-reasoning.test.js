// test/unit/dumate-reasoning.test.js - 搭子思考档位归一化（node:test）
//
// 锁的是 2026-11-15 融合 P0-2 的四条边界（见 src/dumate-reasoning.js 文件头）：
//   ① 只对同后端白名单五个模型生效；
//   ② 只认 none / low / high / max 四档，minimal / medium 保持「不命中」；
//   ③ 未命中时按 stripUnsupported 决定剥不剥（翻译路径剥、透传路径留）；
//   ④ 只动三个键，messages / tools 深相等。
const { test } = require('node:test');
const assert = require('assert');
const R = require('../../src/dumate-reasoning');

const WL = ['deepseek-v41-flash', 'model-text', 'dm-auto-model/text.L0', 'dm-auto-model/mm.L0', 'dm-auto-model/mm.L2'];

test('白名单五个模型 × 四档：全部命中且开关正确', () => {
  for (const model of WL) {
    for (const effort of ['none', 'low', 'high', 'max']) {
      const body = { model, reasoning_effort: effort, messages: [{ role: 'user', content: 'hi' }] };
      const hit = R.apply(body, { mappedModel: model });
      assert.strictEqual(hit, true, `${model}/${effort} 应命中`);

      const enabled = effort !== 'none';
      assert.strictEqual(body.enable_thinking, enabled, `${model}/${effort} enable_thinking`);
      assert.strictEqual(body.thinking.type, enabled ? 'enabled' : 'disabled', `${model}/${effort} thinking.type`);

      if (effort === 'none') {
        assert.strictEqual('reasoning_effort' in body, false, 'none 必须删掉 reasoning_effort');
      } else if (effort === 'low') {
        assert.strictEqual(body.reasoning_effort, 'high', 'low 归一成 high（百度渠道同强度）');
      } else {
        assert.strictEqual(body.reasoning_effort, effort, `${effort} 原样保留`);
      }
    }
  }
});

test('白名单外模型：不命中，默认剥掉 reasoning_effort（翻译路径口径）', () => {
  for (const model of ['glm-5', 'glm-53', 'kimi-k31', 'qwen38-flash', 'deepseek-v4-pro', 'kimi-k3']) {
    const body = { model, reasoning_effort: 'max' };
    assert.strictEqual(R.apply(body, { mappedModel: model }), false, `${model} 不应命中`);
    assert.strictEqual('reasoning_effort' in body, false, `${model} 应被剥掉`);
    assert.strictEqual('enable_thinking' in body, false, `${model} 不应被注入开关`);
    assert.strictEqual('thinking' in body, false, `${model} 不应被注入 thinking`);
  }
});

test('白名单外模型 + stripUnsupported:false（透传路径）：原样保留、不注入', () => {
  const body = { model: 'glm-53', reasoning_effort: 'max' };
  assert.strictEqual(R.apply(body, { mappedModel: 'glm-53', stripUnsupported: false }), false);
  assert.strictEqual(body.reasoning_effort, 'max');
  assert.strictEqual('enable_thinking' in body, false);
  assert.strictEqual('thinking' in body, false);
});

test('minimal / medium 不命中（本仓翻译层五档词表与搭子四档不一致，刻意不映射）', () => {
  for (const effort of ['minimal', 'medium']) {
    for (const strip of [true, false]) {
      const body = { model: 'model-text', reasoning_effort: effort };
      const hit = R.apply(body, { mappedModel: 'model-text', stripUnsupported: strip });
      assert.strictEqual(hit, false, `${effort} 不应命中`);
      if (strip) assert.strictEqual('reasoning_effort' in body, false, `${effort} 应被剥掉`);
      else assert.strictEqual(body.reasoning_effort, effort, `${effort} 应原样保留`);
      assert.strictEqual('enable_thinking' in body, false, `${effort} 不应被注入开关`);
    }
  }
});

test('没有档位 / 档位不是字符串：不命中、不注入任何键', () => {
  for (const body of [
    { model: 'model-text' },
    { model: 'model-text', reasoning_effort: undefined },
    { model: 'model-text', reasoning_effort: null },
    { model: 'model-text', reasoning_effort: 42 },
    { model: 'model-text', reasoning_effort: { effort: 'high' } },
    { model: 'model-text', reasoning_effort: '' },
  ]) {
    assert.strictEqual(R.apply(body, { mappedModel: 'model-text' }), false);
    assert.strictEqual('enable_thinking' in body, false);
    assert.strictEqual('thinking' in body, false);
  }
});

test('畸形 body 不抛异常（null / undefined / 字符串 / 数组）', () => {
  for (const body of [null, undefined, 'invalid JSON', 42, []]) {
    assert.doesNotThrow(() => R.apply(body, { mappedModel: 'model-text' }));
    assert.strictEqual(R.apply(body, { mappedModel: 'model-text' }), false);
  }
});

test('只动三个键：messages / tools / 其他字段深度不变', () => {
  const messages = [{ role: 'user', content: '你好' }];
  const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }];
  const body = {
    model: 'deepseek-v41-flash', reasoning_effort: 'low', messages, tools,
    max_tokens: 4096, temperature: 0.7, metadata: { k: 'v' },
  };
  const before = JSON.stringify({ messages: body.messages, tools: body.tools, max_tokens: body.max_tokens, temperature: body.temperature, metadata: body.metadata });
  assert.strictEqual(R.apply(body, { mappedModel: 'deepseek-v41-flash' }), true);
  assert.deepStrictEqual(body.messages, messages);
  assert.deepStrictEqual(body.tools, tools);
  const after = JSON.stringify({ messages: body.messages, tools: body.tools, max_tokens: body.max_tokens, temperature: body.temperature, metadata: body.metadata });
  assert.strictEqual(after, before, '除三个思考键外，其余字段必须一字不改');
});

test('已有 thinking 的其他键被保留（只覆盖 type）', () => {
  const body = { model: 'model-text', reasoning_effort: 'high', thinking: { budget_tokens: 8192, type: 'adaptive' } };
  assert.strictEqual(R.apply(body, { mappedModel: 'model-text' }), true);
  assert.strictEqual(body.thinking.type, 'enabled');
  assert.strictEqual(body.thinking.budget_tokens, 8192, 'budget_tokens 不应被丢');
});

test('模型名归一：剥 [1M] 后缀、大小写不敏感', () => {
  for (const model of ['model-text[1M]', 'MODEL-TEXT', 'DeepSeek-V41-Flash[1M]']) {
    const body = { model, reasoning_effort: 'max' };
    assert.strictEqual(R.apply(body, { mappedModel: model }), true, `${model} 应命中`);
  }
  assert.strictEqual(R.supportsEffort('model-text[1M]'), true);
  assert.strictEqual(R.supportsEffort('qwen38-flash'), false);
});
