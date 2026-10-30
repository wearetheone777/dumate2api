// test/verify-errtext.js - 验证 lastError 的错误串翻译
//
// ============================================================
// 为什么要有这个脚本
//
// 账号卡上的 lastError 此前直接存 `e.message`，于是界面出现 `aborted`、
// `socket hang up` 这类 Node 原生错误名——用户看到无法判断是网络断了、
// 上游挂了、还是账号废了（2026-10-04 实测：Qoder 账号显示「8 小时前：aborted」）。
//
// 三条不变量，改动时别破坏：
//   1. **原串必须保留在括号里**。排查靠它 grep 代码与比对日志，抹掉等于
//      毁掉排障线索（所以是「上游连接中断（aborted）」而不是只留中文）。
//   2. **认不出来就原样返回**。编一个不认识的错误的解释比不翻译更糟。
//   3. **空串进空串出**。没有错误的账号不该显示任何括号。
//
// 用法：node test/verify-errtext.js
// ============================================================
const assert = require('assert');
const { explainError, normalizeError } = require('../src/errtext');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

console.log('错误串翻译（errtext.js）');

// ---- 1. 原生错误名 ----
check('aborted → 上游连接中断，且保留原串', () => {
  const r = explainError('aborted');
  assert.strictEqual(r, '上游连接中断（aborted）');
  assert.ok(r.includes('aborted'), '原串丢失，排查时无法比对日志');
});

check('socket hang up → 上游连接被挂断', () => {
  assert.strictEqual(explainError('socket hang up'), '上游连接被挂断（socket hang up）');
});

check('ECONNRESET / ECONNREFUSED / ETIMEDOUT 都能翻译', () => {
  assert.strictEqual(explainError('ECONNRESET'), '连接被上游重置（ECONNRESET）');
  assert.strictEqual(explainError('ECONNREFUSED'), '连接被拒绝（上游未监听）（ECONNREFUSED）');
  assert.strictEqual(explainError('ETIMEDOUT'), '连接超时（ETIMEDOUT）');
});

check('带 Error: 前缀也能翻译（e.message 的常见形态）', () => {
  assert.strictEqual(explainError('Error: aborted'), '上游连接中断（Error: aborted）');
});

// ---- 2. 本项目自建的超时串 ----
check('qoder upstream timeout → 上游响应超时', () => {
  assert.strictEqual(
    explainError('qoder upstream timeout'),
    '上游响应超时（qoder upstream timeout）',
  );
});

check('裸 timeout → 响应超时', () => {
  assert.strictEqual(explainError('timeout'), '响应超时（timeout）');
});

// ---- 2.5 Qoder 限流信封与读空闲（2026-10-23~24 实测）----
check('RESOURCE_LIMIT 限流信封 → 上游限流中（服务级过载），保留原串', () => {
  const s = 'qoder 403: {"code":"10605","subCode":"RESOURCE_LIMIT","serviceAvailable":false,"isQueued":true,"queueType":"p3","retryAfterSeconds":30}';
  const r = explainError(s);
  assert.ok(r.startsWith('上游限流中（服务过载，稍后重试）（'), `前缀不对: ${r}`);
  assert.ok(r.includes('10605') && r.includes('RESOURCE_LIMIT'), '原串丢失，排查时无法比对日志');
});

check('read idle → 上游排队挂起已主动断开，保留原串', () => {
  assert.strictEqual(
    explainError('qoder upstream read idle (120000ms)'),
    '上游排队挂起，长时间无数据（限流，已主动断开）（qoder upstream read idle (120000ms)）',
  );
});

// ---- 3. 不该动的情况 ----
check('已经有信息量的错误保持原样（HTTP 502）', () => {
  assert.strictEqual(explainError('HTTP 502'), 'HTTP 502');
});
// 402 在 da9b011 起带额度语义（冷却到次日 00:00），翻译时保留原串——
// 此用例原本期望 402 原样，是那次提交漏同步的漂移（2026-10-30 批量回归补上）
check('402 翻译成额度语义且保留原串（da9b011 行为）', () => {
  assert.strictEqual(explainError('qwenwork 402: Error in upstream response'),
    '额度已用完（该账号暂停使用，次日 00:00 重置后自动恢复）（qwenwork 402: Error in upstream response）');
});

check('认不出的错误原样返回（不编解释）', () => {
  const s = 'some unknown failure mode';
  assert.strictEqual(explainError(s), s);
});

check('换票失败这类带前缀的保持原样', () => {
  const s = '换票失败: invalid_grant';
  assert.strictEqual(explainError(s), s);
});

// ---- 4. 边界 ----
check('空值/空串进空串出（没错误的账号不显示括号）', () => {
  assert.strictEqual(explainError(''), '');
  assert.strictEqual(explainError(null), '');
  assert.strictEqual(explainError(undefined), '');
  assert.strictEqual(explainError('   '), '');
});

check('接受 Error 对象（取 message）', () => {
  assert.strictEqual(explainError(new Error('aborted')), '上游连接中断（aborted）');
});

check('normalizeError 截断到 200 字符（与既有 lastError 上限一致）', () => {
  const long = 'x'.repeat(500);
  assert.strictEqual(normalizeError(long).length, 200);
});

check('翻译后仍带原串（中文说明不会吃掉它）', () => {
  const r = normalizeError('socket hang up');
  assert.ok(r.includes('socket hang up'));
});

// ---- 5. 幂等：翻译两次不再叠加括号 ----
// 读取侧会对已翻译过的存量值再调一次 explainError，重复前缀会让界面
// 显示「上游连接中断（上游连接中断（aborted））」这种俄罗斯套娃。
check('幂等：已翻译的串再翻一次不叠加', () => {
  const once = explainError('aborted');
  const twice = explainError(once);
  assert.strictEqual(twice, once, `重复翻译产生了叠加: ${twice}`);
});

// 无锚的子串匹配（限流信封 / read idle / upstream timeout）最容易套娃：
// 翻译结果里保留的原串本身还会再命中正则，必须靠「已带中文说明就跳过」兜住。
check('幂等：无锚条目（限流信封 / read idle / upstream timeout）重翻不叠加', () => {
  const envelope = 'qoder 403: {"code":"10605","subCode":"RESOURCE_LIMIT","serviceAvailable":false}';
  for (const raw of [envelope, 'qoder upstream read idle (120000ms)', 'qoder upstream timeout']) {
    const once = explainError(raw);
    const twice = explainError(once);
    assert.strictEqual(twice, once, `重复翻译产生了叠加: ${twice}`);
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
