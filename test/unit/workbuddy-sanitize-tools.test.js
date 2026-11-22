// test/unit/workbuddy-sanitize-tools.test.js - 顶层 tools[] 的指纹清洗（2026-11-08 融合批）
//
// 出处：GitHub 生态调研（YehanKD/workbuddy2api 的 WAF 净化覆盖 `tools[]` 数组与
// `tool_calls.arguments`）。本仓库原来只清 `messages[]`，**顶层工具定义完全没清**
// ——而工具名/描述/参数 schema 里的品牌指纹和 system 里的一样会被渠道校验看到。
//
// **这一批最危险的地方是「清过头」**：改成工具名或改坏 schema 结构，
// 工具调用会直接失效（客户端按名字回传，模型按 schema 生成参数）。
// 所以本用例的重点不是「清洗生效」，而是**「只清 description，其余一个字节不动」**。
//
// 运行：node --test test/unit/workbuddy-sanitize-tools.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { tmpDir } = require('../helpers/tmpdir');
process.env.DUMATE_ADMIN_DATA = tmpDir('wb-sanitize-tools');

const s = require('../../src/workbuddy/sanitize');

// 真会命中 IDENTITY_RE 的样本（实测：这三句都被替换成中性身份句）
const FINGERPRINT = 'You are a helpful assistant powered by DeepSeek Harness.';
const CLEAN = 'Read a file from the workspace.';

/** 造一个带指纹的工具定义 */
function toolWith(desc, paramDesc) {
  return {
    type: 'function',
    function: {
      name: 'read_file',
      description: desc,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: paramDesc },
          mode: { type: 'string', enum: ['r', 'w'], default: 'r' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  };
}

test('前置确认：样本真的会命中指纹（否则后面的断言都是空转）', () => {
  assert.equal(s.hasFingerprint(FINGERPRINT, true), true, '样本必须命中，否则测试无意义');
  assert.equal(s.hasFingerprint(CLEAN, true), false, '干净样本不该命中');
});

test('清洗顶层 tools 的 description（这是本批补的缺口）', () => {
  const out = s.sanitizeTools([toolWith(FINGERPRINT, CLEAN)]);
  assert.notEqual(out[0].function.description, FINGERPRINT, '顶层 description 必须被清洗');
  assert.match(out[0].function.description, /helpful AI assistant/i);
});

test('清洗嵌套 parameters 里的 description（schema 内部的自然语言同样会被看到）', () => {
  const out = s.sanitizeTools([toolWith(CLEAN, FINGERPRINT)]);
  assert.equal(out[0].function.parameters.properties.path.description,
    'You are a helpful AI assistant.');
});

test('**绝不改 function.name**（改了 tool_call 回传就对不上）', () => {
  const out = s.sanitizeTools([toolWith(FINGERPRINT, FINGERPRINT)]);
  assert.equal(out[0].function.name, 'read_file', '工具名是契约，一个字符都不能动');
});

test('**绝不改 schema 结构**：type / required / enum / default / additionalProperties', () => {
  const src = toolWith(FINGERPRINT, FINGERPRINT);
  const out = s.sanitizeTools([src]);
  const p = out[0].function.parameters;
  assert.equal(p.type, 'object');
  assert.deepEqual(p.required, ['path'], 'required 决定参数必填性，改了模型生成会失效');
  assert.deepEqual(p.properties.mode.enum, ['r', 'w']);
  assert.equal(p.properties.mode.default, 'r');
  assert.equal(p.properties.path.type, 'string');
  assert.equal(p.additionalProperties, false);
});

test('不改入参（调用方可能还要用原对象）', () => {
  const src = [toolWith(FINGERPRINT, CLEAN)];
  const snapshot = JSON.stringify(src);
  s.sanitizeTools(src);
  assert.equal(JSON.stringify(src), snapshot, '入参对象不能被就地改动');
});

test('干净的工具定义原样返回（零开销，不做无谓改写）', () => {
  const src = [toolWith(CLEAN, CLEAN)];
  const out = s.sanitizeTools(src);
  assert.deepEqual(out, src);
});

test('多工具：只清洗命中的那个，其余不受影响', () => {
  const dirty = toolWith(FINGERPRINT, CLEAN);
  const clean = { type: 'function', function: { name: 'other', description: CLEAN, parameters: { type: 'object' } } };
  const out = s.sanitizeTools([dirty, clean]);
  assert.match(out[0].function.description, /helpful AI assistant/i);
  assert.equal(out[1].function.description, CLEAN);
  assert.equal(out[1].function.name, 'other');
});

test('保留契约开关（PRESERVE_CONTRACT=1）时整个工具数组原样返回', () => {
  process.env.DUMATE_WORKBUDDY_PRESERVE_CONTRACT = '1';
  try {
    const src = [toolWith(FINGERPRINT, FINGERPRINT)];
    assert.deepEqual(s.sanitizeTools(src), src, '开了保留契约就不该动工具定义');
  } finally {
    delete process.env.DUMATE_WORKBUDDY_PRESERVE_CONTRACT;
  }
});

test('异常输入不抛：null / 非数组 / 元素非对象', () => {
  for (const junk of [null, undefined, 'x', 42, {}]) {
    assert.doesNotThrow(() => s.sanitizeTools(junk));
  }
  assert.equal(s.sanitizeTools(null), null);
  assert.doesNotThrow(() => s.sanitizeTools([null, 1, 'x', {}]));
});

test('缺 function / function 非对象的工具不被弄坏', () => {
  const out = s.sanitizeTools([{ type: 'function' }, { function: 'not-an-object' }]);
  assert.deepEqual(out[0], { type: 'function' });
  assert.deepEqual(out[1], { function: 'not-an-object' });
});

test('schema 递归深度有保护（超深不会栈溢出）', () => {
  // 造 30 层嵌套：depth 保护在 12 层，超过的原样返回而不是无限递归
  let deep = { type: 'string', description: FINGERPRINT };
  for (let i = 0; i < 30; i++) deep = { type: 'object', properties: { x: deep } };
  const tool = { type: 'function', function: { name: 'f', description: CLEAN, parameters: deep } };
  assert.doesNotThrow(() => s.sanitizeTools([tool]));
});

test('buildChatBody 会把清洗应用到顶层 tools（端到端串起来）', () => {
  const chat = require('../../src/workbuddy/chat');
  const built = chat.buildChatBody({
    model: 'auto',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [toolWith(FINGERPRINT, FINGERPRINT)],
  }, 'cn', { uid: 'u1' });
  const body = JSON.parse(built.body);
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].function.name, 'read_file', '端到端也不能改名');
  assert.match(body.tools[0].function.description, /helpful AI assistant/i,
    '端到端必须真的清到——只写模块不接进 buildChatBody 等于没做');
});
