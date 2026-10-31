// test/errtext.test.js - errtext.js 行为测试（错误串人话翻译）
//
// 原则（文件头注释）：保留原串不替换——输出形如「中文说明（原串）」；
// 已翻译过的存量值重翻不套娃；匹配不上原样返回；写入侧 normalizeError
// 截断 200 字。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { explainError, normalizeError } = require('../src/errtext');

test('空串与 null：返回空串', () => {
  assert.equal(explainError(''), '');
  assert.equal(explainError(null), '');
  assert.equal(explainError(undefined), '');
});

test('网络层原生错误名 → 中文 + 保留原串', () => {
  assert.equal(explainError('aborted'), '上游连接中断（aborted）');
  assert.equal(explainError('socket hang up'), '上游连接被挂断（socket hang up）');
  assert.equal(explainError('ECONNRESET'), '连接被上游重置（ECONNRESET）');
  assert.equal(explainError('ENOTFOUND'), '域名解析失败（ENOTFOUND）');
  assert.equal(explainError('ETIMEDOUT'), '连接超时（ETIMEDOUT）');
});

test('Error: 前缀剥离后仍能匹配', () => {
  assert.equal(explainError('Error: ECONNRESET'), '连接被上游重置（Error: ECONNRESET）');
  assert.equal(explainError('TypeError: aborted'), '上游连接中断（TypeError: aborted）');
});

test('Error 对象直接传入（取 message）', () => {
  assert.equal(explainError(new Error('ECONNREFUSED')), '连接被拒绝（上游未监听）（ECONNREFUSED）');
});

test('qoder 信封限流（RESOURCE_LIMIT 子串，无锚匹配）', () => {
  const raw = '{"code":10605,"subCode":"RESOURCE_LIMIT","serviceAvailable":false}';
  assert.equal(explainError(raw), `上游限流中（服务过载，稍后重试）（${raw}）`);
});

test('qoder 读空闲', () => {
  assert.equal(
    explainError('qoder upstream read idle 120s'),
    '上游排队挂起，长时间无数据（限流，已主动断开）（qoder upstream read idle 120s）'
  );
});

test('自有超时串统一说法', () => {
  assert.equal(explainError('upstream timeout after 300s'), '上游响应超时（upstream timeout after 300s）');
  assert.equal(explainError('timeout'), '响应超时（timeout）');
});

test('已翻译的存量值重翻不套娃', () => {
  const once = explainError('aborted');
  assert.equal(explainError(once), once);
  const limit = explainError('{"subCode":"RESOURCE_LIMIT"}');
  assert.equal(explainError(limit), limit);
  const to = explainError('upstream timeout');
  assert.equal(explainError(to), to);
});

test('带冒号前缀的 HTTP 错误（已有信息量）保持原样', () => {
  assert.equal(explainError('HTTP 502: bad gateway'), 'HTTP 502: bad gateway');
});

test('完全陌生的错误原样返回', () => {
  assert.equal(explainError('weird custom failure'), 'weird custom failure');
});

test('内容审核拒绝翻成人话（2026-11-01，DataInspectionFailed 家族）', () => {
  const m1 = 'qoder 500: {"code":"InternalError.Algo.DataInspectionFailed","message":"Input text data may contain inappropriate content."}';
  const t1 = explainError(m1);
  assert.ok(t1.startsWith('上游内容安全审核未通过'), t1);
  assert.ok(t1.includes('换账号无效'), t1);
  assert.ok(t1.includes('DataInspectionFailed'), '原串要保留');
  // 多层转义形态
  assert.ok(explainError('x {\\"code\\":\\"DataInspectionFailed\\"} y').includes('内容安全审核'));
  // ContentFilter / content_policy_rejected 家族
  assert.ok(explainError('ContentFilter blocked').includes('内容安全审核'));
  assert.ok(explainError('content_policy_rejected').includes('内容安全审核'));
  // 重翻不套娃
  assert.equal(explainError(t1), t1);
  // 普通错误不误翻
  assert.ok(!explainError('ECONNRESET').includes('内容安全审核'));
});

test('normalizeError：翻译一致且截断 200 字', () => {
  assert.equal(normalizeError('aborted'), '上游连接中断（aborted）');
  const long = 'x'.repeat(500);
  const out = normalizeError(long);
  assert.equal(out.length, 200);
  assert.equal(normalizeError(''), '');
});
