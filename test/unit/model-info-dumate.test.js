// test/unit/model-info-dumate.test.js - 搭子模型行：真实后端/上下文/输出上限
//
// 数据全部来自 2026-10-31 深度逆向实测（CLAUDE.md「搭子的真实模型」节）：
// 400 错误体明示 / 二分夹逼 / X-Dumate-Gw-Realmodel 响应头。此前的 192K
// 区间是过时数据（当时只有探测，没有逆向），这批断言钉住新口径。
//
// 2026-11-15：本文件改为**自带临时 data 目录**（原先读真机 data/，在干净
// 检出上 exposed 是默认三条，断言与真实配置耦合）。同时关掉清单追加行
// （DUMATE_EXPOSE_CATALOG=0），只钉 exposed 行的实测元数据；清单行为由
// test/model-info.test.js 与 test/verify-dumate-catalog.js 覆盖。
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { makeTmpData } = require('../helpers/tmpdata');

const tmp = makeTmpData('model-info-dumate');
fs.writeFileSync(tmp.file('model-map.json'), JSON.stringify({
  aliases: {
    'deepseek-v4.1-flash-low-latency': 'dm-auto-model/text.L0',
    'glm-5.2': 'glm-5',
    'kimi-k3': 'dm-auto-model/text.L1',
    'qwen3.8-max': 'dm-auto-model/text.L2',
  },
  upstream_models: ['model-text', 'model-artifact-validate', 'glm-5'],
  exposed: [
    'deepseek-v4.1-flash-low-latency',
    'glm-5.2',
    'kimi-k3',
    'qwen3.8-max',
  ],
  fallback: 'model-text',
}), 'utf8');

process.env.DUMATE_ADMIN_DATA = tmp.dir;
process.env.DUMATE_EXPOSE_CATALOG = '0';
const mi = require('../../src/model-info');
const billing = require('../../src/dumate-billing');

after(() => tmp.cleanup());

const rowOf = (rows, id) => rows.find((r) => r.id === id);

test('dumateRows：暴露列表是真实后端名，元数据按映射 target 查表', () => {
  const rows = mi.dumateRows();
  const ids = rows.map((r) => r.id);
  // 暴露的就是 cc-switch 里显示/发送的真实后端名（2026-11-01 起取代内部 key）
  assert.deepEqual([...ids].sort(), ['deepseek-v4.1-flash-low-latency', 'glm-5.2', 'kimi-k3', 'qwen3.8-max']);
  const ds = rowOf(rows, 'deepseek-v4.1-flash-low-latency');
  assert.equal(ds.target, 'dm-auto-model/text.L0', '真实名经别名映射到上游槽位');
  assert.equal(ds.realModel, 'deepseek-v4.1-flash-low-latency');
  assert.equal(ds.contextWindow, 1048576);
  assert.equal(ds.maxTokens, 393216);
  const glm = rowOf(rows, 'glm-5.2');
  assert.equal(glm.target, 'glm-5');
  assert.equal(glm.realModel, 'glm-5.2');
  assert.ok(/二分夹逼/.test(glm.contextNote));
  const l2 = rowOf(rows, 'qwen3.8-max');
  assert.equal(l2.contextWindow, 983616, '阿里云错误体明示值，不是 1M 取整');
  const l1 = rowOf(rows, 'kimi-k3');
  assert.equal(l1.realModel, 'kimi-k3');
  assert.equal(l1.maxTokens, 2000000, '实测下界（未探顶），如实给下界 + note');
  assert.ok(/未探顶/.test(l1.maxTokensNote));
});

test('dumateRows：暴露的四个名字全部有实测元数据（不拿同类值顶上）', () => {
  for (const r of mi.dumateRows()) {
    assert.equal(r.contextSource, 'measured', r.id + ' 不应混入清单行（本用例已关闭追加）');
    assert.ok(r.realModel, r.id + ' 应有实跑标注');
    assert.ok(r.contextWindow, r.id + ' 应有实测上下文');
    assert.equal(r.rateSource === 'measured' || r.rate == null, true, r.id);
  }
});

test('dumateRows：倍率来自实测缓存（写入口径统一，老键仍可读）', () => {
  // 缓存文件指到临时文件，断言才不依赖真机探针的落盘状态
  const rateFile = tmp.file('dumate-rate-cache.json');
  process.env.DUMATE_DUMATE_RATE_FILE = rateFile;
  try {
    // 无缓存：全部 null（未实测，不是 0）
    for (const r of mi.dumateRows()) {
      assert.equal(r.rate, null, r.id + ' 无缓存应 null');
      assert.equal(r.rateSource, null, r.id);
    }

    // 新口径：键 = 真实后端（探针合并脚本写的就是这个）
    fs.writeFileSync(rateFile, JSON.stringify({
      'deepseek-v4.1-flash-low-latency': {
        pointsPerKOut: 2.0179, pointsPerKOutAt: Date.now(), tokens: '12+900/12+1700',
      },
    }));
    let mt = rowOf(mi.dumateRows(), 'deepseek-v4.1-flash-low-latency');
    assert.equal(mt.rate, 2.0179, '真实后端键直接命中');
    assert.equal(mt.rateUnit, 'pts/1k_out');
    assert.equal(mt.rateSource, 'measured');

    // 老口径：键 = 映射 target（2026-11-01 的计费自检写的就是这个）。
    // 读取按 backendOf 归一后回退扫描——不认老键会让已测值凭空消失。
    fs.writeFileSync(rateFile, JSON.stringify({
      'dm-auto-model/text.L0': { billed: 3.5135, cost: 1.04, tokens: 296, account: 't', measuredAt: Date.now() },
    }));
    mt = rowOf(mi.dumateRows(), 'deepseek-v4.1-flash-low-latency');
    assert.equal(mt.rate, 3.5135, '真实名行的倍率 = 同后端老条目的实测值');
    assert.equal(mt.rateUnit, 'pts/1k_tok');
    assert.ok(/实测于/.test(mt.rateNote), mt.rateNote);

    // 过期（8 天前）：如实回落 null——过期数字比「—」更害人
    fs.writeFileSync(rateFile, JSON.stringify({
      'model-text': { billed: 3.5135, cost: 1.04, tokens: 296, account: 't', measuredAt: Date.now() - 8 * 24 * 3600 * 1000 },
    }));
    assert.equal(rowOf(mi.dumateRows(), 'deepseek-v4.1-flash-low-latency').rate, null);
  } finally {
    delete process.env.DUMATE_DUMATE_RATE_FILE;
  }
});

test('倍率缓存：键归一到真实后端；两种口径各有时间戳，互不覆盖', () => {
  const rateFile = tmp.file('dumate-rate-cache-2.json');
  process.env.DUMATE_DUMATE_RATE_FILE = rateFile;
  try {
    const old = Date.now() - 6 * 24 * 3600 * 1000;   // 双点解 6 天前（仍在 TTL 内）
    const fresh = Date.now();
    // 先用 target 名写双点解（模拟 merge 脚本/探针），再用请求名写单点（模拟计费自检）
    assert.equal(billing.saveRateEntry('model-text', { pointsPerKOut: 2.0, tokens: 'a', measuredAt: old }), true);
    assert.equal(billing.saveRateEntry('dm-auto-model/text.L0', { billed: 3.5, tokens: 'b' }), true);

    const cache = billing.readRateCache();
    const keys = Object.keys(cache);
    assert.deepEqual(keys, ['deepseek-v4.1-flash-low-latency'], '两个写入口径落到同一个后端键');
    const e = cache[keys[0]];
    assert.equal(e.pointsPerKOut, 2.0, '后写的 billed 不能冲掉双点解');
    assert.equal(e.billed, 3.5);
    assert.equal(e.billedAt > old, true, '单点用新时间戳');
    assert.equal(e.pointsPerKOutAt, old, '双点解保留自己的测量时刻');

    // 双点解仍在 TTL 内 → 优先展示它；把双点解改成过期后回落到单点
    let v = billing.rateValueForTarget('deepseek-v4.1-flash-low-latency');
    assert.equal(v.unit, 'pts/1k_out');
    const cache2 = billing.readRateCache();
    cache2['deepseek-v4.1-flash-low-latency'].pointsPerKOutAt = Date.now() - 8 * 24 * 3600 * 1000;
    fs.writeFileSync(rateFile, JSON.stringify(cache2));
    v = billing.rateValueForTarget('deepseek-v4.1-flash-low-latency');
    assert.equal(v.unit, 'pts/1k_tok', '过期口径不比「另一个新鲜口径」优先');
    assert.equal(v.value, 3.5);

    // saveRateEntry 支持显式 measuredAt（合并历史报告时不能盖章成今天）。
    // 注意 6 天前仍在 7 天 TTL 内、8 天前已过期——这里用 30 天前验过期。
    const monthAgo = Date.now() - 30 * 24 * 3600 * 1000;
    billing.saveRateEntry('glm-5', { pointsPerKOut: 9.9, measuredAt: monthAgo });
    const gv = billing.rateValueForTarget('glm-5');
    assert.equal(gv, null, '历史报告合并进来时按原测量时刻算 TTL，不冒充新鲜数据');
    const raw = billing.readRateCache()['glm-5.2'];
    assert.equal(raw.pointsPerKOutAt, monthAgo, '测量时刻按报告时间落盘');
  } finally {
    delete process.env.DUMATE_DUMATE_RATE_FILE;
  }
});

// ---- 2026-11-07 融合项 P0-3（双链路标注）与 P1-4（/v1/models 元数据）----

test('dumateTargetOf / dumateRealOf：与 dumateRows 同一映射算法（单一来源）', () => {
  assert.equal(mi.dumateTargetOf('deepseek-v4.1-flash-low-latency'), 'dm-auto-model/text.L0');
  assert.equal(mi.dumateTargetOf('glm-5.2'), 'glm-5');
  assert.equal(mi.dumateRealOf('glm-5').real, 'glm-5.2');
  assert.equal(mi.dumateRealOf('dm-auto-model/text.L2').context, 983616);
  assert.equal(mi.dumateRealOf('no-such-target'), null, '查不到如实 null，不编');
  // 清单路由名：云端链路解析成自己，桌面链路仍回落 fallback。
  // 解析错会借用 model-text 的实测窗口/上限（review #8）。
  assert.equal(mi.dumateTargetOf('kimi-k31', { catalog: true }), 'kimi-k31');
  assert.equal(mi.dumateTargetOf('kimi-k31', { catalog: false }), 'model-text');
  assert.equal(mi.dumateRealOf(mi.dumateTargetOf('kimi-k31', { catalog: true })), null,
    '清单名没有本仓实测元数据，不拿 model-text 顶替');
});

test('dumateRows：JSON mode 按命名空间判（应用别名一律 false + 说明）', () => {
  for (const r of mi.dumateRows()) {
    assert.equal(r.jsonMode, false, r.id + ' 应用链路不支持 response_format');
    assert.equal(r.jsonModeSource, 'measured');
    assert.ok(/qianfan\//.test(r.jsonModeNote), r.id + ' 的说明要指向 qianfan/ 前缀');
    assert.deepEqual(r.links, { app: true, qianfanRaw: false }, r.id);
  }
});

test('dumateRows：multimodal 按 target 档位语义判（mm 档位不再恒 false）', () => {
  for (const r of mi.dumateRows()) {
    // 本用例关掉了清单追加，全部是 exposed 行：multimodal 按 target 名字里的
    // `/mm.` 判。当前暴露列表全是 text 档位——false 是正确值。
    assert.equal(r.multimodal, /\/mm\./.test(r.target), r.id + '（target=' + r.target + '）');
    assert.equal(r.multimodalSource, 'config');
  }
  // 档位语义本身：mm target 必须判 true（一旦 mm 进暴露列表不再标错）
  assert.equal(mi.dumateRealOf('dm-auto-model/mm.L0').real, 'deepseek-v4.1-flash-low-latency', 'mm 档位在实测表里，语义判断有数据支撑');
});
