// test/unit/claude-route.test.js - claude-* 路由名按 key 通道解析（2026-11-01）
//
// Claude Desktop 3p 直连网关只发 claude-* 名（cc-switch 直连模式的硬约束），
// 网关按 key 的通道把路由名重写成带前缀的网关模型名。没有这层重写，无前缀
// 名会被 router 归进搭子、再被通道绑定判定 403。
const { test } = require('node:test');
const assert = require('node:assert');
const mm = require('../../src/modelmap');

test('resolveClaudeRoute：四个通道的档位映射（与 cc-switch provider env 一致）', () => {
  assert.equal(mm.resolveClaudeRoute('claude-sonnet-5', 'dumate'), 'dm-auto-model/text.L0');
  assert.equal(mm.resolveClaudeRoute('claude-opus-5', 'dumate'), 'dm-auto-model/text.L1');
  assert.equal(mm.resolveClaudeRoute('claude-haiku-5-5', 'dumate'), 'model-text');
  assert.equal(mm.resolveClaudeRoute('claude-fable-5', 'dumate'), 'dm-auto-model/text.L2');
  assert.equal(mm.resolveClaudeRoute('claude-sonnet-5', 'qwenwork'), 'qwen/flash');
  assert.equal(mm.resolveClaudeRoute('claude-opus-5', 'qwenwork'), 'qwen/pro');
  assert.equal(mm.resolveClaudeRoute('claude-sonnet-5', 'traework'), 'traework/deepseek-v4.1-flash');
  assert.equal(mm.resolveClaudeRoute('claude-fable-5', 'traework'), 'traework/kimi-k3.1-pro');
  assert.equal(mm.resolveClaudeRoute('claude-sonnet-5', 'qoder'), 'qoder/Qwen3.8-Flash');
  assert.equal(mm.resolveClaudeRoute('claude-opus-5', 'qoder'), 'qoder/GLM-5.3-Flash');
  assert.equal(mm.resolveClaudeRoute('claude-haiku-5-5', 'qoder'), 'qoder/DeepSeek-Flash');
  assert.equal(mm.resolveClaudeRoute('claude-fable-5', 'qoder'), 'qoder/Qwen3.8-Max');
});

test('resolveClaudeRoute：anthropic/ 前缀、[1M] 后缀、大小写混合都兼容', () => {
  assert.equal(mm.resolveClaudeRoute('anthropic/claude-sonnet-5', 'dumate'), 'dm-auto-model/text.L0');
  assert.equal(mm.resolveClaudeRoute('claude-sonnet-5[1M]', 'dumate'), 'dm-auto-model/text.L0');
  assert.equal(mm.resolveClaudeRoute('Claude-Opus-5', 'dumate'), 'dm-auto-model/text.L1');
  assert.equal(mm.resolveClaudeRoute('  claude-fable-5  ', 'qoder'), 'qoder/Qwen3.8-Max');
});

test('resolveClaudeRoute：重写幂等——解析结果再过一遍不变', () => {
  const once = mm.resolveClaudeRoute('claude-sonnet-5', 'qoder');
  assert.equal(mm.resolveClaudeRoute(once, 'qoder'), null, '带前缀的解析结果不再是 claude-* 形状');
  // handler 在鉴权段之后再次调用同一函数，靠的就是这一点
});

test('resolveClaudeRoute：非路由名一律返回 null（不劫持既有行为）', () => {
  assert.equal(mm.resolveClaudeRoute('glm-5', 'dumate'), null);
  assert.equal(mm.resolveClaudeRoute('qoder/Qwen3.8-Flash', 'qoder'), null);
  // 旧式名继续走别名表/fallback，历史行为不变
  assert.equal(mm.resolveClaudeRoute('claude-3-5-sonnet-20241022', 'dumate'), null);
  assert.equal(mm.resolveClaudeRoute('claude-sonnet-4-20250514', 'dumate'), null);
  assert.equal(mm.resolveClaudeRoute('', 'dumate'), null);
  assert.equal(mm.resolveClaudeRoute(null, 'dumate'), null);
  assert.equal(mm.resolveClaudeRoute('claude-sonnet-5', ''), null, 'key 未绑通道不解析');
  assert.equal(mm.resolveClaudeRoute('claude-sonnet-5', null), null);
  assert.equal(mm.resolveClaudeRoute('claude-sonnet-5', 'no-such-channel'), null);
});

test('mapModel：[1M] 后缀剥离（历史 bug：glm-5[1M] 曾静默落 fallback）', () => {
  assert.equal(mm.mapModel('glm-5[1M]'), 'glm-5');
  assert.equal(mm.mapModel('dm-auto-model/text.L0[1M]'), 'dm-auto-model/text.L0');
  assert.equal(mm.mapModel('claude-3-5-sonnet-20241022[1M]'), 'model-text');
});

test('normalizeIncomingModel：直连通道的 [1M] 剥离（mapModel 只覆盖搭子路径）', () => {
  // qwen/pro[1M] 不在搭子映射表里，剥离必须发生在 router 之前的入口清理
  assert.equal(mm.normalizeIncomingModel('qwen/pro[1M]', ''), 'qwen/pro');
  assert.equal(mm.normalizeIncomingModel('traework/glm-5.2[1M]', ''), 'traework/glm-5.2');
  assert.equal(mm.normalizeIncomingModel('glm-5[1M]', 'dumate'), 'glm-5');
  assert.equal(mm.normalizeIncomingModel('glm-5', ''), null, '无需改动返回 null');
  // claude-* 重写优先于 [1M] 剥离
  assert.equal(mm.normalizeIncomingModel('claude-sonnet-5[1M]', 'qoder'), 'qoder/Qwen3.8-Flash');
});

test('resolveClaudeRoute 的解析结果经 mapModel 后仍落对的目标', () => {
  // 重写后的名字带通道前缀：dumate 目标是搭子真名（透传），qoder/qwenwork/traework
  // 的目标由 router 剥前缀后交给各通道 buildBody——这里锁 dumate 侧的透传链。
  for (const channel of Object.keys(mm.CLAUDE_ROUTES)) {
    for (const role of Object.keys(mm.CLAUDE_ROUTES[channel])) {
      const mapped = mm.resolveClaudeRoute('claude-sonnet-5', channel);
      assert.ok(mapped, channel + '/' + role + ' 应可解析');
    }
  }
  const l0 = mm.resolveClaudeRoute('claude-haiku-5-5', 'dumate');
  assert.equal(mm.mapModel(l0), l0, 'model-text 透传');
  const sonnet = mm.resolveClaudeRoute('claude-sonnet-5', 'dumate');
  assert.equal(mm.mapModel(sonnet), sonnet, 'L0 透传');
});
