// test/unit/workbuddy-thinking.test.js - DeepSeek 思考注入与 reasoning_content 回填（P0-4）
//
// 移植 misakano thinking.go 语义（issue #43 Hermes 逆向官方客户端 codebuddy.js）：
// 「开思考」= thinking:{type:"enabled"} + 某档 effort，两字段缺一不可——真实上游
// 对不带 reasoning_effort 的裸请求按不思考应答。默认档：面板 > 目录 defaultEffort
// > 硬兜底 high。档位钳制「只向下」。
//
// 锁的行为：
//   1. deepseek 前缀判定 + 非 deepseek 零改动（glm/kimi 不注入）
//   2. off/none/disabled → thinking.type=disabled + effort 删除（先于注入判断）
//   3. 显式 thinking.type 尊重；缺 effort 补默认档
//   4. 显式 effort 不覆盖值，但按目录钳制（只向下；未知词不猜）
//   5. 回填门控 thinkingEnabled||hasTrace；空串不过闸补 " "（len>0 校验实测）
//   6. buildChatBody 集成：目录钳制生效、运行期配置可关、wb_no_thinking 逃生口
//
// 运行：node --test test/unit/workbuddy-thinking.test.js
// 注意：buildChatBody 读运行期配置（runtime.js），测试必须钉住 DUMATE_ADMIN_DATA。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DUMATE_ADMIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-think-'));

const th = require('../../src/workbuddy/thinking');
const chat = require('../../src/workbuddy/chat');
const models = require('../../src/workbuddy/models');
const runtime = require('../../src/workbuddy/runtime');

const DS = 'deepseek-v4.1-flash';
const CAT = { efforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true };

test('injectThinking：裸 deepseek 请求注入 enabled + 默认档（目录 > 硬兜底）', () => {
  const b = { model: DS, messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(th.injectThinking(b, { efforts: CAT.efforts, defaultEffort: 'low' }), true);
  assert.deepEqual(b.thinking, { type: 'enabled' });
  assert.equal(b.reasoning_effort, 'low', '目录 defaultEffort 优先于硬兜底');
  const b2 = { model: DS, messages: [] };
  th.injectThinking(b2, {});
  assert.equal(b2.reasoning_effort, 'high', '无目录时兜底 high（官方 configure 行为）');
});

test('injectThinking：非 deepseek 模型零改动（glm/kimi 不注入）', () => {
  for (const m of ['glm-5.3', 'kimi-k3.1-pro', 'hy4std', '', undefined]) {
    const b = { model: m, messages: [] };
    const before = JSON.stringify(b);
    th.injectThinking(b, { efforts: CAT.efforts, defaultEffort: 'high' });
    assert.equal(JSON.stringify(b), before, `model=${m} 不该被动`);
  }
});

test('injectThinking：off/none/disabled → thinking disabled + effort 删除（先于注入）', () => {
  for (const off of ['off', 'none', 'disabled', 'None', ' OFF ']) {
    const b = { model: DS, messages: [], reasoning_effort: off };
    th.injectThinking(b, { efforts: CAT.efforts, defaultEffort: 'high' });
    assert.deepEqual(b.thinking, { type: 'disabled' }, off);
    assert.equal(b.reasoning_effort, undefined, off);
  }
  // camel 形态同样认
  const b = { model: DS, messages: [], reasoningEffort: 'none' };
  th.injectThinking(b, {});
  assert.deepEqual(b.thinking, { type: 'disabled' });
  assert.equal(b.reasoningEffort, undefined);
});

test('injectThinking：显式 thinking.type 尊重（enabled 缺档补默认；disabled 删档）', () => {
  const b = { model: DS, messages: [], thinking: { type: 'enabled' } };
  th.injectThinking(b, { defaultEffort: 'max' });
  assert.deepEqual(b.thinking, { type: 'enabled' }, '显式 type 不改写');
  assert.equal(b.reasoning_effort, 'max');
  const b2 = { model: DS, messages: [], thinking: { type: 'disabled' }, reasoning_effort: 'high' };
  th.injectThinking(b2, {});
  assert.deepEqual(b2.thinking, { type: 'disabled' });
  assert.equal(b2.reasoning_effort, undefined, 'disabled 分支照抄官方：不带任何 effort');
});

test('clampEffort：目录钳制只向下；支持档原样；未知词不猜；无目录不钳', () => {
  assert.equal(th.clampEffort('xhigh', CAT.efforts), 'high', 'xhigh 不在目录 → 落 ≤xhigh 的最高支持档');
  assert.equal(th.clampEffort('low', CAT.efforts), 'low');
  assert.equal(th.clampEffort('minimal', CAT.efforts), 'low', '全高于目标 → 最低支持档');
  assert.equal(th.clampEffort('auto', CAT.efforts), 'auto', '未知档位词不猜');
  assert.equal(th.clampEffort('high', []), 'high', '目录没声明 efforts 不钳');
  assert.equal(th.clampEffort('high', null), 'high');
  assert.equal(th.clampEffort('HIGH', CAT.efforts), 'high', '大小写归一');
});

test('injectThinking：显式 effort 保留值但按目录钳制', () => {
  const b = { model: DS, messages: [], reasoning_effort: 'xhigh' };
  th.injectThinking(b, { efforts: CAT.efforts, defaultEffort: 'high' });
  assert.deepEqual(b.thinking, { type: 'enabled' }, '已有 effort 也照开开关');
  assert.equal(b.reasoning_effort, 'high', '钳到 ≤xhigh 的最高支持档');
  const b2 = { model: DS, messages: [], reasoning_effort: 'low' };
  th.injectThinking(b2, { efforts: CAT.efforts });
  assert.equal(b2.reasoning_effort, 'low', '支持档原样');
});

test('backfillReasoningContent：门控 thinkingEnabled||hasTrace；空串不过闸补 " "；镜像 reasoning', () => {
  // 无 thinking、无痕迹 → 不动
  const b0 = { model: DS, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] };
  assert.equal(th.backfillReasoningContent(b0), false);
  assert.equal(b0.messages[1].reasoning_content, undefined);
  // thinking enabled → 全部 assistant 补 rc="" 并镜像 reasoning=" "
  const b1 = { model: DS, messages: [
    { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
  ], thinking: { type: 'enabled' } };
  assert.equal(th.backfillReasoningContent(b1), true);
  assert.equal(b1.messages[1].reasoning_content, '');
  assert.equal(b1.messages[1].reasoning, ' ', '空串不过闸（len>0 校验实测）：补单个空格');
  // 已有 rc string 不覆盖；reasoning 镜像取 rc 值
  const b2 = { model: DS, messages: [
    { role: 'assistant', content: 'x', reasoning_content: '已有推理' },
    { role: 'assistant', content: 'y' },
  ], thinking: { type: 'enabled' } };
  th.backfillReasoningContent(b2);
  assert.equal(b2.messages[0].reasoning_content, '已有推理');
  assert.equal(b2.messages[0].reasoning, '已有推理', 'reasoning 缺失时镜像 rc');
  // rc 非 string（null）不算「已有」，落补
  const b3 = { model: DS, messages: [
    { role: 'assistant', content: 'x', reasoning_content: null },
  ], thinking: { type: 'enabled' } };
  th.backfillReasoningContent(b3);
  assert.equal(b3.messages[0].reasoning_content, '', 'null 归一化为 ""（官方 "string"!=typeof 口径）');
  // hasTrace 半边：历史带非空 reasoning 也触发（disabled + 有痕迹照补，官方 #165）
  const b4 = { model: DS, messages: [
    { role: 'assistant', content: 'x', reasoning: '上一轮的推理' },
  ] };
  assert.equal(th.backfillReasoningContent(b4), true);
  assert.equal(b4.messages[0].reasoning_content, '上一轮的推理');
  // 非 deepseek 不动
  const b5 = { model: 'glm-5.3', messages: [{ role: 'assistant', content: 'x' }], thinking: { type: 'enabled' } };
  assert.equal(th.backfillReasoningContent(b5), false);
});

test('buildChatBody 集成：目录注入 + 钳制 + 回填一条龙', () => {
  models._setCatalog('cn', [{ id: DS, reasoning: CAT }, { id: 'glm-5.3' }]);
  const acct = { id: 1, uid: 'u1', accessToken: 't' };
  const b = JSON.parse(chat.buildChatBody({
    model: DS,
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'go' }],
  }, 'cn', acct).body);
  assert.deepEqual(b.thinking, { type: 'enabled' });
  assert.equal(b.reasoning_effort, 'high');
  const asst = b.messages.find((m) => m.role === 'assistant');
  assert.equal(asst.reasoning_content, '');
  // glm 不注入
  const g = JSON.parse(chat.buildChatBody({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }, 'cn', acct).body);
  assert.equal(g.thinking, undefined);
});

test('运行期配置：thinking.enabled=false 全关（env DUMATE_WORKBUDDY_THINKING=0 同义）', () => {
  models._setCatalog('cn', [{ id: DS, reasoning: CAT }]);
  const acct = { id: 1, uid: 'u1', accessToken: 't' };
  runtime.Store({ thinking: { enabled: false } });
  const b = JSON.parse(chat.buildChatBody({ model: DS, messages: [{ role: 'user', content: 'hi' }] }, 'cn', acct).body);
  assert.equal(b.thinking, undefined, '配置关闭后不注入');
  // 回填门控自决：无 thinking 无痕迹 → 不回填
  const asst = b.messages.find((m) => m.role === 'assistant');
  assert.equal(asst, undefined, '单轮无 assistant');
  // defaultEffort 面板覆盖
  runtime.Store({ thinking: { enabled: true, defaultEffort: 'max' } });
  const b2 = JSON.parse(chat.buildChatBody({ model: DS, messages: [{ role: 'user', content: 'hi' }] }, 'cn', acct).body);
  assert.equal(b2.reasoning_effort, 'max', '面板 defaultEffort 优先于目录');
  runtime._resetForTest();
});

test('11150 降级路径：withoutReasoningFields 带 wb_no_thinking 标记 + 剥 reasoning_summary', () => {
  const payload = {
    model: 'glm-5.3',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'high',
    reasoning_summary: 'auto',
  };
  const r = chat.withoutReasoningFields(payload);
  assert.ok(r);
  assert.deepEqual(r.removed.sort(), ['reasoning_effort', 'reasoning_summary']);
  const b = JSON.parse(r.body);
  assert.equal(b.reasoning_effort, undefined);
  assert.equal(b.reasoning_summary, undefined);
  assert.equal(b.wb_no_thinking, true, '重发必须带逃生口标记，否则注入会把剥掉的字段补回来');
  // 无 reasoning 字段时 null（无需降级）
  assert.equal(chat.withoutReasoningFields({ model: 'x', messages: [] }), null);
});
