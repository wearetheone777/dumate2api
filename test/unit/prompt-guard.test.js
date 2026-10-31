// test/unit/prompt-guard.test.js - 出站提示词卫生（脱敏 + 工具输出截断）
//
// 两项都是默认关闭的选通开关（DUMATE_DESENSITIZE / DUMATE_TOOL_OUTPUT_CAP），
// 关闭时零行为变化。零宽空格脱敏必须幂等（重复应用不二次插入）。
const { test } = require('node:test');
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-guard-'));
process.env.DUMATE_ADMIN_DATA = TMP;
const guard = require('../../src/prompt-guard');

fs.writeFileSync(path.join(TMP, 'desensitize-words.txt'), '# 注释行\n敏感词一\n敏感词二更长\n');

test('未开启开关：desensitizeBody 原样返回（零行为变化）', () => {
  const body = { messages: [{ role: 'system', content: '含敏感词一的提示' }] };
  guard.desensitizeBody(body);
  assert.strictEqual(body.messages[0].content, '含敏感词一的提示');
});

test('开启后：system 字符串与 parts 文本都插零宽空格，user 不动', () => {
  process.env.DUMATE_DESENSITIZE = '1';
  try {
    const body = {
      messages: [
        { role: 'system', content: '含敏感词一的提示' },
        { role: 'system', content: [{ type: 'text', text: '还有敏感词二更长的那句' }] },
        { role: 'user', content: '用户消息带敏感词一不动' },
      ],
    };
    guard.desensitizeBody(body);
    const s0 = body.messages[0].content;
    assert.notStrictEqual(s0, '含敏感词一的提示', '字符串 system 已改写');
    assert.strictEqual(s0.replace(/​/g, ''), '含敏感词一的提示', '去掉 ZWSP 后与原文一致（幂等基准）');
    assert.ok(s0.includes('​'), '字符串 system 已插 ZWSP');
    const t1 = body.messages[1].content[0].text;
    assert.ok(t1.includes('​'), 'parts system 已插 ZWSP');
    assert.strictEqual(t1.replace(/​/g, ''), '还有敏感词二更长的那句');
    assert.ok(!body.messages[2].content.includes('​'), 'user 消息不碰');
    // 幂等：重复应用不再插入
    const once = body.messages[0].content;
    guard.desensitizeBody(body);
    assert.strictEqual(body.messages[0].content, once);
  } finally {
    delete process.env.DUMATE_DESENSITIZE;
  }
});

test('长词优先：敏感词二更长 不被 敏感词二 吃掉一半', () => {
  process.env.DUMATE_DESENSITIZE = '1';
  try {
    const body = { messages: [{ role: 'system', content: '敏感词二更长' }] };
    guard.desensitizeBody(body);
    const t = body.messages[0].content;
    assert.strictEqual(t.replace(/​/g, ''), '敏感词二更长', '原文字符完整保留');
    assert.ok(t.includes('​'), '已插 ZWSP');
    // 长词优先的判据：整词被切分（出现 ≥3 个 ZWSP），而不是短词只吃掉前缀（1 个）
    assert.ok((t.match(/​/g) || []).length >= 3, '按最长词切分');
  } finally {
    delete process.env.DUMATE_DESENSITIZE;
  }
});

test('capToolOutputs: 未设/0 关闭', () => {
  const body = { messages: [{ role: 'tool', content: 'x'.repeat(100) }] };
  guard.capToolOutputs(body, process.env.DUMATE_TOOL_OUTPUT_CAP);
  assert.strictEqual(body.messages[0].content.length, 100);
  guard.capToolOutputs(body, 0);
  assert.strictEqual(body.messages[0].content.length, 100);
});

test('capToolOutputs: 超限截断并标注原始长度，非 tool 消息不碰', () => {
  const body = {
    messages: [
      { role: 'tool', content: 'y'.repeat(300) },
      { role: 'user', content: 'z'.repeat(300) },
    ],
  };
  guard.capToolOutputs(body, 100);
  assert.ok(body.messages[0].content.length < 200);
  assert.ok(body.messages[0].content.includes('原始 300 字符'), '标注原始长度');
  assert.strictEqual(body.messages[1].content.length, 300, 'user 消息不碰');
});
