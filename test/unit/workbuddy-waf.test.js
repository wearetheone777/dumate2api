// test/unit/workbuddy-waf.test.js - WAF / 网关层拦截快速失败（P1-5）
//
// 三层：
//   1. constants.looksLikeWafBody：403 + 无业务信封 + （空 | HTML | 网关指纹）；
//      业务信封（有 "code" 字段）一律不算 WAF——11140 风控与 4xx 业务码不误吃。
//   2. classifyStatus / errorActionOf / statusOf 的 waf 分支：分类排在全部业务
//      判定之后（文案标记永远优先）；不罚号；503「稍后再来」。
//   3. index 的滑窗：窗口内 ≥2 个**不同**账号命中才整区快速失败，单号不拦、
//      同一账号重复命中不拦、到点自动解除、区域互相独立。
//
// 运行：node --test test/unit/workbuddy-waf.test.js
const test = require('node:test');
const assert = require('node:assert');
const c = require('../../src/workbuddy/constants');
const idx = require('../../src/workbuddy/index');

// ---------- 1. looksLikeWafBody ----------

test('WAF 体判定：空体 / HTML / 网关指纹算 WAF', () => {
  assert.equal(c.looksLikeWafBody(''), true);
  assert.equal(c.looksLikeWafBody(null), true);
  assert.equal(c.looksLikeWafBody('<html><body>Request Blocked</body></html>'), true);
  assert.equal(c.looksLikeWafBody('{"error":"Access Denied"}'), true);
  assert.equal(c.looksLikeWafBody('openresty/1.21.4.1'), true);
  assert.equal(c.looksLikeWafBody('cloudflare'), true);
  assert.equal(c.looksLikeWafBody('APISIX gateway rejected the request'), true);
});

test('WAF 体判定：业务信封一律不算（有 "code" 字段）', () => {
  assert.equal(c.looksLikeWafBody('{"code":11140,"message":"账号存在异常行为 request illegal"}'), false);
  assert.equal(c.looksLikeWafBody('{"code":9999,"message":"Access Denied"}'), false);
  assert.equal(c.looksLikeWafBody('{"error":{"data":{"code":14003}}}'), false);
});

test('WAF 体判定：不含信封也不含指纹的普通文本不算（宁可漏判不误判）', () => {
  assert.equal(c.looksLikeWafBody('plain text error'), false);
  assert.equal(c.looksLikeWafBody('upstream connect error'), false);
});

// ---------- 2. 分类与处置 ----------

test('classifyStatus：403 + WAF 体 → waf；业务 403 永远优先', () => {
  assert.equal(c.classifyStatus(403, '<html>blocked</html>'), 'waf');
  assert.equal(c.classifyStatus(403, ''), 'waf');
  assert.equal(c.classifyStatus(403, 'APISIX'), 'waf');
  // 业务信封照旧走原路径：风控、client
  assert.equal(c.classifyStatus(403, '{"code":11140,"message":"账号存在异常行为 request illegal"}'), 'restricted');
  assert.equal(c.classifyStatus(403, '{"code":9999,"message":"x"}'), 'client');
  // 非 403 的 WAF 体不参与分类（只有 403 才有网关层拒绝的语义）
  assert.equal(c.classifyStatus(500, '<html>blocked</html>'), 'server');
  assert.equal(c.classifyStatus(429, ''), 'soft_rate');
  // 文案标记优先于 WAF（顺序纪律）：403 + 信封里的 session dead 措辞
  assert.equal(c.classifyStatus(403, '{"code":1,"message":"Offline user session not found"}'), 'session_dead');
});

test('处置：waf 不罚号（feed none）；503 语义由分类+处置组合锁定', () => {
  const act = idx.errorActionOf({ kind: 'waf' });
  assert.equal(act.feed, 'none', 'WAF 是出口 IP 级，账号没犯错，绝不能喂池冷却');
  assert.equal(act.action, 'throw');
  // statusOf 未导出（与 queue 同约定）：waf 分类存在 + 兜底处置不罚号，
  // 503 的映射在 send 层直接拼（stop.statusCode = 503），不依赖 statusOf
  assert.equal(c.classifyStatus(403, ''), 'waf');
});

// ---------- 3. 滑窗快速失败 ----------

test('滑窗：单号命中不拦，同号重复命中也不拦', () => {
  idx._wafReset();
  idx.noteWafHit('cn', 'a1', 1000);
  assert.equal(idx.wafBlockedRemaining('cn', 1100), 0, '单号命中可能是该号自身的问题');
  idx.noteWafHit('cn', 'a1', 2000);
  assert.equal(idx.wafBlockedRemaining('cn', 2100), 0, '同一账号重复命中 ≠ IP 级');
});

test('滑窗：两个不同账号命中 → 拦到「最后一次命中 + 60s」', () => {
  idx._wafReset();
  idx.noteWafHit('cn', 'a1', 1000);
  idx.noteWafHit('cn', 'a2', 5000);
  const remain = idx.wafBlockedRemaining('cn', 6000);
  assert.ok(remain > 0, '≥2 个不同账号中招，整区快速失败');
  // 最后命中 5000，窗口 60000 → 拦到 65000 为止（此刻剩 59000ms）
  assert.equal(remain, 65000 - 6000);
  assert.equal(idx.wafBlockedRemaining('cn', 65001), 0, '到点自动解除（滑窗语义）');
});

test('滑窗：窗口外的命中被剪枝，不影响判定', () => {
  idx._wafReset();
  idx.noteWafHit('cn', 'a1', 0);        // 60s 前的旧命中
  idx.noteWafHit('cn', 'a2', 70000);    // 现在的新命中
  assert.equal(idx.wafBlockedRemaining('cn', 70001), 0, '旧命中已过期剪枝，只剩单号');
});

test('滑窗：区域互相独立（cn 被拦不影响 global）', () => {
  idx._wafReset();
  idx.noteWafHit('cn', 'a1', 1000);
  idx.noteWafHit('cn', 'a2', 1000);
  assert.ok(idx.wafBlockedRemaining('cn', 1100) > 0);
  assert.equal(idx.wafBlockedRemaining('global', 1100), 0, 'WAF 按出口计，区域间互不连坐');
  idx._wafReset();
  assert.equal(idx.wafBlockedRemaining('cn', 1100), 0, '_wafReset 清空');
});

test('滑窗：region 未知不记（防御）', () => {
  idx._wafReset();
  idx.noteWafHit('', 'a1', 1000);
  idx.noteWafHit(undefined, 'a2', 1000);
  assert.equal(idx.wafBlockedRemaining(''), 0);
});
