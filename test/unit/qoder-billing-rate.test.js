// test/unit/qoder-billing-rate.test.js - 实测倍率（上游改路由可见性）的离线验证
//
// 背景（融合自 qoder2api-hub #113 的 billed_model 思路，保守版）：Qoder 响应
// 的 model 恒为 "auto"，请求的模型可能被上游静默换掉。不做自动 mismatch 判定
// （错峰优惠 discountFactor 会合法改变倍率且乘性方向未实测，自动判必误报），
// 把实测倍率 billed_rate 记进积分账本，比对交给管理端人工探针。
const { test } = require('node:test');
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-rate-'));
process.env.DUMATE_ADMIN_DATA = TMP; // 在 require credits 之前
const credits = require('../../src/qoder/credits');

let failures = 0;
function check(label, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`[${mark}] ${label}${detail != null ? ' — ' + detail : ''}`);
}

check('标准：0.1 credits / 1000 tokens / 期望 0.1 → 0.1',
  credits.computeBilledRate(0.1, { total_tokens: 1000 }, 0.1) === 0.1);
check('tokens 用 prompt+completion 合计（无 total_tokens）',
  credits.computeBilledRate(0.2, { prompt_tokens: 1500, completion_tokens: 500 }, 0.1) === 0.1);
check('上游改路由（实测 0.04 vs 期望 0.1）→ 如实记 0.04 不判不藏',
  credits.computeBilledRate(0.04, { total_tokens: 1000 }, 0.1) === 0.04);
check('倍率四舍五入到 4 位（不外传浮点噪声）',
  credits.computeBilledRate(0.19999, { total_tokens: 2000 }, 0.1) === 0.1);
check('无 usage → null', credits.computeBilledRate(0.1, null, 0.1) === null);
check('tokens 为 0 → null', credits.computeBilledRate(0.1, { total_tokens: 0 }, 0.1) === null);
check('期望倍率缺失（模型表没给）→ null', credits.computeBilledRate(0.1, { total_tokens: 1000 }, null) === null);
check('期望倍率为 0（免费档）→ null（除法无意义，不编）',
  credits.computeBilledRate(0, { total_tokens: 1000 }, 0) === null);
check('credits 缺失 → null', credits.computeBilledRate(null, { total_tokens: 1000 }, 0.1) === null);

console.log('== capture 落盘 ==');
const acc = { id: 1, nickname: '倍率测试' };
const entry = credits.capture(acc, 0.05, {
  reqId: 'req_rate_1', model: 'qfmodel', ms: 100,
  billedRate: credits.computeBilledRate(0.05, { total_tokens: 500 }, 0.1),
});
check('capture 写入 billed_rate', entry && entry.billed_rate === 0.1, entry && entry.billed_rate);
const hit = credits.readHistory().find((r) => r.req_id === 'req_rate_1');
check('账本里能按 req_id 读回 billed_rate', hit && hit.billed_rate === 0.1);
const entry2 = credits.capture(acc, 0.05, { reqId: 'req_rate_2', model: 'qfmodel' });
check('没传 billedRate 时不写字段（null 不补 0）', entry2 && entry2.billed_rate === undefined);

// 折扣前额度（2026-10-31，社区项目实测 usage.original_credits 字段）：
// discount = credits/original_credits 即真实折扣，discountFactor 的方向从此实测化
const entry3 = credits.capture(acc, 0.04, {
  reqId: 'req_rate_3', model: 'qfmodel', originalCredits: 0.1,
});
check('original_credits 落账 + discount=credits/original',
  entry3 && entry3.original_credits === 0.1 && entry3.discount === 0.4,
  entry3 && `${entry3.original_credits}/${entry3.discount}`);
const entry4 = credits.capture(acc, 0.05, { reqId: 'req_rate_4', model: 'qfmodel' });
check('上游没给 original_credits 时不凭空造字段',
  entry4 && entry4.original_credits === undefined && entry4.discount === undefined);
const hit3 = credits.readHistory().find((r) => r.req_id === 'req_rate_3');
check('账本能按 req_id 读回 original_credits/discount',
  hit3 && hit3.original_credits === 0.1 && hit3.discount === 0.4);

console.log('');
if (failures) { console.log(`✗ ${failures} 项失败`); process.exit(1); }
console.log('✓ 全部通过');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 留给系统清 */ }
