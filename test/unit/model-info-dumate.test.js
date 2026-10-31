// test/unit/model-info-dumate.test.js - 搭子模型行：真实后端/上下文/输出上限（2026-11-01）
//
// 数据全部来自 2026-10-31 深度逆向实测（CLAUDE.md「搭子的真实模型」节）：
// 400 错误体明示 / 二分夹逼 / X-Dumate-Gw-Realmodel 响应头。此前的 192K
// 区间是过时数据（当时只有探测，没有逆向），这批断言钉住新口径。
const { test } = require('node:test');
const assert = require('node:assert');
const mi = require('../../src/model-info');

test('dumateRows：暴露列表是真实后端名，元数据按映射 target 查表', () => {
  const rows = mi.dumateRows();
  const ids = rows.map((r) => r.id);
  // 暴露的就是 cc-switch 里显示/发送的真实后端名（2026-11-01 起取代内部 key）
  assert.deepEqual([...ids].sort(), ['deepseek-v4.1-flash-low-latency', 'glm-5.2', 'kimi-k3', 'qwen3.8-max']);
  const ds = rows.find((r) => r.id === 'deepseek-v4.1-flash-low-latency');
  assert.equal(ds.target, 'dm-auto-model/text.L0', '真实名经别名映射到上游槽位');
  assert.equal(ds.realModel, 'deepseek-v4.1-flash-low-latency');
  assert.equal(ds.contextWindow, 1048576);
  assert.equal(ds.maxTokens, 393216);
  const glm = rows.find((r) => r.id === 'glm-5.2');
  assert.equal(glm.target, 'glm-5');
  assert.equal(glm.realModel, 'glm-5.2');
  assert.ok(/二分夹逼/.test(glm.contextNote));
  const l2 = rows.find((r) => r.id === 'qwen3.8-max');
  assert.equal(l2.contextWindow, 983616, '阿里云错误体明示值，不是 1M 取整');
  const l1 = rows.find((r) => r.id === 'kimi-k3');
  assert.equal(l1.realModel, 'kimi-k3');
  assert.equal(l1.maxTokens, 2000000, '实测下界（未探顶），如实给下界 + note');
  assert.ok(/未探顶/.test(l1.maxTokensNote));
});

test('dumateRows：暴露的四个名字全部有实测元数据（不拿同类值顶上）', () => {
  for (const r of mi.dumateRows()) {
    assert.ok(r.realModel, r.id + ' 应有实跑标注');
    assert.ok(r.contextWindow, r.id + ' 应有实测上下文');
    assert.equal(r.rateSource === 'measured' || r.rate == null, true, r.id);
  }
});

test('dumateRows：倍率来自实测缓存（按 target 命中；无缓存/过期如实 null）', () => {
  // 缓存文件指到临时文件，断言才不依赖真机探针的落盘状态
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const tmp = path.join(os.tmpdir(), `dumate-rate-test-${process.pid}.json`);
  process.env.DUMATE_DUMATE_RATE_FILE = tmp;
  // 无缓存：全部 null（未实测，不是 0）
  const empty = mi.dumateRows();
  for (const r of empty) {
    assert.equal(r.rate, null, r.id + ' 无缓存应 null');
    assert.equal(r.rateSource, null, r.id);
  }
  // 有缓存：倍率按映射 target 命中（探针把实测记在上游槽位名下）
  fs.writeFileSync(tmp, JSON.stringify({
    'dm-auto-model/text.L0': { billed: 3.5135, cost: 1.04, tokens: 296, account: 't', measuredAt: Date.now() },
  }));
  const rows = mi.dumateRows();
  const mt = rows.find((r) => r.id === 'deepseek-v4.1-flash-low-latency');
  assert.equal(mt.rate, 3.5135, '真实名行的倍率 = target 槽位的实测值');
  assert.equal(mt.rateSource, 'measured');
  assert.ok(/实测于/.test(mt.rateNote), mt.rateNote);
  // 过期（8 天前）：如实回落 null——过期数字比「—」更害人
  fs.writeFileSync(tmp, JSON.stringify({
    'model-text': { billed: 3.5135, cost: 1.04, tokens: 296, account: 't', measuredAt: Date.now() - 8 * 24 * 3600 * 1000 },
  }));
  // 重新取行：rows 是改写缓存前算好的，不能复用
  const expired = mi.dumateRows();
  assert.equal(expired.find((r) => r.id === 'deepseek-v4.1-flash-low-latency').rate, null);
  fs.unlinkSync(tmp);
  delete process.env.DUMATE_DUMATE_RATE_FILE;
});
