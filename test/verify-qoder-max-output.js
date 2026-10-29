// test/verify-qoder-max-output.js - max_tokens 上限自学习的离线验证
//
// 上游模型表不带 maxOutputTokens；超限时上游回 400 `Range of max_tokens
// should be [1, N]`。第一次撞上限如实报错（网关靠它才知道 N），learn 记下后
// chat.buildBody 出站前自动 clamp（对齐 qoder2api-hub #101）。
//
// 离线：自带 DUMATE_QODER_MAX_OUTPUT_FILE 临时文件，不碰真实 data/。
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), `dumate-qoder-max-output-${process.pid}.json`);
process.env.DUMATE_QODER_MAX_OUTPUT_FILE = TMP;

// learn/get 是模块级函数但每次现读盘（与 keys.js/modelmap.js 的 mtime 失效
// 同一思路：管理端与网关是两个进程），require 之前设好 env 即可。
const maxOutput = require('../src/qoder/max-output');
const chat = require('../src/qoder/chat');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`[PASS] ${label}`); }
  catch (e) { failures++; console.log(`[FAIL] ${label} — ${e.message}`); }
}

check('未学习时 get 返回 null（不编默认值）', () => {
  assert.strictEqual(maxOutput.get('cn', 'dfmodel'), null);
});

check('learn 后 get 取到；同模型不同区域互不干扰', () => {
  assert.strictEqual(maxOutput.learn('cn', 'dfmodel', 131072), true);
  assert.strictEqual(maxOutput.get('cn', 'dfmodel'), 131072);
  assert.strictEqual(maxOutput.get('global', 'dfmodel'), null, '区域是键的一部分');
  assert.strictEqual(maxOutput.get('cn', 'qfmodel'), null, '模型是键的一部分');
});

check('重复 learn 覆盖旧值（上游放开上限后要能跟上）', () => {
  maxOutput.learn('cn', 'dfmodel', 200000);
  assert.strictEqual(maxOutput.get('cn', 'dfmodel'), 200000);
});

check('非法输入忽略（不落盘、不抛错）', () => {
  assert.strictEqual(maxOutput.learn('cn', 'x', 0), false);
  assert.strictEqual(maxOutput.learn('cn', 'x', -5), false);
  assert.strictEqual(maxOutput.learn('cn', 'x', NaN), false);
  assert.strictEqual(maxOutput.learn('cn', '', 100), false);
  assert.strictEqual(maxOutput.get('cn', 'x'), null);
});

check('落盘为原子写且 JSON 可解析（learn 即写，同步可读）', () => {
  const j = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  assert.ok(j['cn:dfmodel'] && j['cn:dfmodel'].n === 200000, JSON.stringify(j));
});

check('端到端：buildBody 按 clamp 收口（runOnce 传 maxOutputTokens）', () => {
  const b = JSON.parse(chat.buildBody('dfmodel', {
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 500000,
  }, { maxOutputTokens: maxOutput.get('cn', 'dfmodel') }));
  assert.strictEqual(b.parameters.max_tokens, 200000, 'learn 到的 200000 应生效');
});

check('TTL 过期后 get 返回 null（7 天，注入时钟验证）', () => {
  const now = Date.now();
  // 直接手写记录，绕过 learn——get 现读盘，写的形态即 learn 落盘的形态
  fs.writeFileSync(TMP, JSON.stringify({ 'cn:stale': { n: 4096, at: now - maxOutput.TTL_MS - 1000 } }));
  assert.strictEqual(maxOutput.get('cn', 'stale', now), null, '过期不返回');
  fs.writeFileSync(TMP, JSON.stringify({ 'cn:fresh': { n: 4096, at: now - 1000 } }));
  assert.strictEqual(maxOutput.get('cn', 'fresh', now), 4096);
});

try { fs.unlinkSync(TMP); } catch (e) { /* 不存在 */ }
console.log('');
if (failures) { console.log(`${failures} 项失败`); process.exit(1); }
console.log('全部通过');
process.exit(0);
