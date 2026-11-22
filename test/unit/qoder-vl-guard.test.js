// test/unit/qoder-vl-guard.test.js - 非视觉模型传图的前置校验（P2-24）
//
// 调研出处：docs/QODER-GATEWAY-FEATURE-MERGE.md P2-24「VL 前置校验」
// （融合自 fengyinxia/qoder2api）：非视觉模型传图**本地 400**，比放行后上游
// 报错省一次上游调用。
//
// 为什么值得做：图片是 base64 data URI，一次请求可能几十 MB。放行后被拒
// 等于白传一遍，还多一次 413 风险（SLB 30MB 硬限）。
//
// 五条口径（每条都有「不这么做会怎样」）：
//   1. 只在模型表**明确说**「不是多模态」时拒绝
//   2. 表不可用 / 模型不在表里 / 字段缺失 → **放行**（误拒比放行重得多）
//   3. 只看结构化 part，不猜文本里的 URL
//   4. 拒绝文案要能指导下一步（报模型名 + 现有哪些支持图的）
//   5. 不惩罚账号（拒绝的是「模型不支持」，与账号健康无关）
//
// 运行：node --test test/unit/qoder-vl-guard.test.js
const test = require('node:test');
const assert = require('node:assert');

const vl = require('../../src/qoder/vl-guard');

const IMG = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
const msgWithImg = (n = 1) => ({
  role: 'user',
  content: [{ type: 'text', text: '看图' }, ...Array.from({ length: n }, () => IMG)],
});

const MODELS = [
  { key: 'gfmodel', name: 'GLM-5.3-Flash', multimodal: false },
  { key: 'vfmodel', name: 'VL-Flash', multimodal: true },
];

test('hasImagePart / countImageParts：只认结构化 part', () => {
  assert.strictEqual(vl.hasImagePart([msgWithImg()]), true);
  assert.strictEqual(vl.countImageParts([msgWithImg(2)]), 2);
  // Responses 形态也认（保底，免得漏判）
  assert.strictEqual(vl.hasImagePart([
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:...' }] },
  ]), true);
  // **文本里的图片链接不算**：那是用户正文，不是图像输入通道
  assert.strictEqual(vl.hasImagePart([
    { role: 'user', content: '看这张 ![](http://x/y.png)' },
  ]), false);
  assert.strictEqual(vl.hasImagePart([]), false);
  assert.strictEqual(vl.hasImagePart(null), false);
});

test('非视觉模型传图 → 本地拒绝，文案点名模型与该换的模型', () => {
  const r = vl.checkVision({ messages: [msgWithImg()], modelKey: 'gfmodel', models: MODELS });
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.code, 'model_not_vision');
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(r.images, 1);
  assert.match(r.error, /gfmodel/, '要点名是哪个模型');
  assert.match(r.error, /1 张图/, '要报图片数量');
  assert.match(r.error, /vfmodel/, '要给出该换哪个（现有哪些支持图的）');
  assert.deepStrictEqual(r.vlModels, ['vfmodel']);
});

test('视觉模型传图 → 放行', () => {
  const r = vl.checkVision({ messages: [msgWithImg()], modelKey: 'vfmodel', models: MODELS });
  assert.strictEqual(r.blocked, false);
  assert.strictEqual(r.images, 1);
});

test('没带图 → 放行（视觉模型也不用管）', () => {
  const r = vl.checkVision({
    messages: [{ role: 'user', content: '读一段文字' }], modelKey: 'gfmodel', models: MODELS,
  });
  assert.strictEqual(r.blocked, false);
  assert.strictEqual(r.images, 0);
});

test('表不可用 → **放行**（不把网关自己的数据缺口变成用户的故障）', () => {
  for (const models of [null, undefined, [], [{ key: 'other' }]]) {
    const r = vl.checkVision({ messages: [msgWithImg()], modelKey: 'gfmodel', models });
    assert.strictEqual(r.blocked, false, `models=${JSON.stringify(models)} 该放行`);
    assert.ok(r.unknown, '要标出为什么放行（便于排障时看出来）');
  }
});

test('模型不在表里 → 放行（未知 ≠ 不支持）', () => {
  const r = vl.checkVision({ messages: [msgWithImg()], modelKey: 'brandnew', models: MODELS });
  assert.strictEqual(r.blocked, false);
  assert.match(r.unknown, /不在表内/);
});

test('表里一个视觉模型都没有 → 拒绝但说清「这条通道可能整体不支持图像」', () => {
  const r = vl.checkVision({
    messages: [msgWithImg()], modelKey: 'gfmodel',
    models: [{ key: 'gfmodel', multimodal: false }, { key: 'dfmodel', multimodal: false }],
  });
  assert.strictEqual(r.blocked, true);
  assert.deepStrictEqual(r.vlModels, []);
  assert.match(r.error, /没有任何模型声明支持图像/, '不能让人白找一个不存在的视觉模型');
});

test('visionError：带 statusCode 与 visionBlocked 标志（供 poolInfoOf 不惩罚）', () => {
  const r = vl.checkVision({ messages: [msgWithImg()], modelKey: 'gfmodel', models: MODELS });
  const err = vl.visionError(r);
  assert.ok(err instanceof Error);
  assert.strictEqual(err.statusCode, 400);
  assert.strictEqual(err.code, 'model_not_vision');
  assert.strictEqual(err.visionBlocked, true);
  // 不阻断时返回 null，调用方可以直接 if (err) throw
  assert.strictEqual(vl.visionError({ blocked: false }), null);
  assert.strictEqual(vl.visionError(null), null);
});

test('接线回归：qoder/index.js 真的会做前置校验，且 poolInfoOf 不惩罚', () => {
  // 防「模块写好了、全库无调用方」——本仓库吃过这个亏
  const src = require('fs').readFileSync(
    require('path').resolve(__dirname, '../../src/qoder/index.js'), 'utf8');
  assert.match(src, /require\('\.\/vl-guard'\)\.checkVision/, 'runOnce 里要调前置校验');
  assert.match(src, /visionError\(vl\)/, '被拒时要抛带 statusCode 的错误');
  assert.match(src, /e\.visionBlocked\) return \{ status: 400/, 'poolInfoOf 要把 visionBlocked 当不惩罚');
});

test('真机现状自证：Qoder 全部 12 个模型 is_vl=true，所以本校验当前放行一切图片请求', () => {
  // **2026-11-08 真机实测**：上游模型表 12/12 都是 is_vl=true，且给 gfmodel 传
  // 1x1 PNG 上游正常接受。这条用例固定「当前实际行为」——它不依赖网络：
  // 用真实形状的模型表（全 multimodal=true）验证「校验不会误拦」。
  const live = [
    'auto', 'fast', 'qmodel_38max', 'qfmodel', 'dmodel', 'dfmodel',
    'gmodel', 'gfmodel', 'kmodel_latest', 'kmodel', 'jmodel', 'mmodel',
  ].map((key) => ({ key, multimodal: true }));
  const r = vl.checkVision({ messages: [msgWithImg(3)], modelKey: 'gfmodel', models: live });
  assert.strictEqual(r.blocked, false, '全 true 时不该拦任何请求');
  assert.strictEqual(r.images, 3);
  // 但判据本身是通的：把表改成 false，同一次请求就会被拒
  const flipped = live.map((m) => (m.key === 'gfmodel' ? { ...m, multimodal: false } : m));
  assert.strictEqual(
    vl.checkVision({ messages: [msgWithImg()], modelKey: 'gfmodel', models: flipped }).blocked,
    true,
    '上游一旦收紧 is_vl，校验自动生效（不必改代码）',
  );
});
