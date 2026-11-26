// test/unit/qwen-model-tiers.test.js - 千问模型档位映射表形状（2026-11-26 合并批次 P0-1）
//
// 来源：docs/PLAN-QWENWORK-GITHUB-MERGE.md §6.2（jianhx189/qwenwork2api 的
// 2026-11 实测修正）。锁四件事：
//   1. 被套餐挡的键不进任何表（写了在无权限账号上吃 403）
//   2. 企业专属档位（safety）不进表（企业版不合并）
//   3. 关键映射的方向正确（对外名 → 上游档位键）
//   4. 兜底表的键都是真实上游键（不与别名表的值冲突）
const { test } = require('node:test');
const assert = require('assert');

const c = require('../../src/qwenwork/constants');

// 上游在无权限账号上回 403 "Model is not available for this user" 的键
const PLAN_BLOCKED = ['standard', 'premium', 'qwork-lite', 'qmodel_latest', 'dmodel_latest', 'gmodel_latest'];
// 企业专属档位（上游键 safety）——企业版内容不合并
const ENTERPRISE = ['safety', 'qwenwork-enterprise'];

test('FALLBACK_MODELS: 不含被套餐挡的键与企档', () => {
  for (const key of c.FALLBACK_MODELS) {
    assert.ok(!PLAN_BLOCKED.includes(key), `兜底表含被套餐挡的键 ${key}`);
    assert.ok(!ENTERPRISE.includes(key), `兜底表含企档 ${key}`);
  }
});

test('MODEL_ALIASES: 值与键都不含被套餐挡的键与企档', () => {
  for (const [alias, upstream] of Object.entries(c.MODEL_ALIASES)) {
    assert.ok(!PLAN_BLOCKED.includes(alias), `别名键是被挡键 ${alias}`);
    assert.ok(!ENTERPRISE.includes(alias), `别名键是企档 ${alias}`);
    assert.ok(!PLAN_BLOCKED.includes(upstream), `${alias} 映射到被挡键 ${upstream}`);
    assert.ok(!ENTERPRISE.includes(upstream), `${alias} 映射到企档 ${upstream}`);
  }
});

test('关键映射方向正确（对外名 → 上游档位键）', () => {
  // 原有三个
  assert.strictEqual(c.MODEL_ALIASES.auto, 'pro');
  assert.strictEqual(c.MODEL_ALIASES['qwork-advanced'], 'pro');
  assert.strictEqual(c.MODEL_ALIASES['qwork-auto'], 'pro');
  // qmodel_latest 被挡 → 预览档承接
  assert.strictEqual(c.MODEL_ALIASES['qwen3.8-max'], 'qwen3.8-max-preview');
  // 官方标签四档
  assert.strictEqual(c.MODEL_ALIASES['qwenwork-lite'], 'lite');
  assert.strictEqual(c.MODEL_ALIASES['qwenwork-standard'], 'flash'); // standard 键被挡
  assert.strictEqual(c.MODEL_ALIASES['qwenwork-advanced'], 'pro');
  assert.strictEqual(c.MODEL_ALIASES['qwenwork-ultimate'], 'flagship');
  // deepseek 别名三连收敛到同一上游键
  assert.strictEqual(c.MODEL_ALIASES['deepseek-v4.1-flash'], 'deepseek-flash');
  assert.strictEqual(c.MODEL_ALIASES['deepseek-v4-flash'], 'deepseek-flash');
  assert.strictEqual(c.MODEL_ALIASES['deepseek-flash'], 'deepseek-flash');
  // 上游没有 qwen4-max-preview 键，落到 qwen4-max
  assert.strictEqual(c.MODEL_ALIASES['qwen4-max-preview'], 'qwen4-max');
});

test('兜底表的键都是真实上游键（与别名表的值一致或本身是别名键）', () => {
  const upstreamKeys = new Set(Object.values(c.MODEL_ALIASES));
  for (const key of c.FALLBACK_MODELS) {
    // 兜底键要么是上游真实键，也是别名表里的键（如 pro/flash 本身就是上游键）
    assert.ok(upstreamKeys.has(key) || c.MODEL_ALIASES[key],
      `兜底键 ${key} 既不是别名表的值也不是别名键`);
  }
});

test('FALLBACK_MODELS 保留原有三档 + 新增实测档', () => {
  for (const key of ['pro', 'flash', 'qwen3.8-max-preview']) {
    assert.ok(c.FALLBACK_MODELS.includes(key), `原有档位丢失 ${key}`);
  }
  // 新增：经济/旗舰 + deepseek + glm
  for (const key of ['lite', 'flagship', 'deepseek-flash', 'deepseek-v4-pro', 'glm-5.3', 'glm-5.3-flash']) {
    assert.ok(c.FALLBACK_MODELS.includes(key), `实测档位未入兜底表 ${key}`);
  }
  // 2026-11-27 真机复核：第三方档位（kimi/minimax/step/qwen4）逐档打最小请求
  // 全部 200，纪律已解除——入兜底表，与上游 14 档目录对齐。
  for (const key of ['kimi-k3.1-pro', 'minimax-m3.1-flash', 'step-5-preview', 'qwen4-max', 'qwen3.8-flash', 'glm-5.4', 'ling-3.1-flash']) {
    assert.ok(c.FALLBACK_MODELS.includes(key), `已实测档位应在兜底表 ${key}`);
    assert.ok(Object.keys(c.MODEL_ALIASES).includes(key), `档位应有显式别名 ${key}`);
  }
});

test('DEFAULT_MODEL 仍在兜底表内', () => {
  assert.ok(c.FALLBACK_MODELS.includes(c.DEFAULT_MODEL));
});
