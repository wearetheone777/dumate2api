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

// —— 批次五：CN Kimi $ref 内联展开（panel kimi_tools.go 移植）——

test('kimiInlineTools：顶层/嵌套 $ref 展开、$defs 剥除、循环与缺目标兜底', () => {
  // 顶层 $ref：整份参数 schema 指向 $defs（实测上游 400 11129）→ 展开成内联定义
  const tools = [{
    type: 'function',
    function: {
      name: 'f',
      parameters: { $ref: '#/$defs/Args', $defs: { Args: { type: 'object', properties: { q: { type: 'string' } } } } },
    },
  }];
  const out = s.kimiInlineTools(tools);
  assert.strictEqual(out[0].function.parameters.$defs, undefined, '$defs 必须剥除');
  assert.strictEqual(out[0].function.parameters.properties.q.type, 'string');

  // 嵌套 $ref + 循环引用：循环处落空 schema 兜底（不可内联）
  const cyc = {
    type: 'object',
    properties: { a: { $ref: '#/$defs/A' } },
    $defs: { A: { type: 'object', properties: { self: { $ref: '#/$defs/A' } } } },
  };
  const p2 = s.kimiInlineTools([{ type: 'function', function: { name: 'g', parameters: cyc } }])[0].function.parameters;
  assert.strictEqual(p2.$defs, undefined);
  assert.strictEqual(Object.keys(p2.properties.a.properties.self).length, 0, '循环引用落空 schema');

  // 缺目标 → {type:'object'}（参考同口径：至少退化成无参工具而不是必 400）
  const miss = [{ type: 'function', function: { name: 'h', parameters: { $ref: '#/$defs/Nope' } } }];
  assert.deepStrictEqual(s.kimiInlineTools(miss)[0].function.parameters, { type: 'object' });

  // JSON Pointer 转义还原（~1 → /、~0 → ~）
  const esc = [{ type: 'function', function: { name: 'i', parameters: { $ref: '#/$defs/a~1b', $defs: { 'a/b': { type: 'string' } } } } }];
  assert.deepStrictEqual(s.kimiInlineTools(esc)[0].function.parameters, { type: 'string' });
});

test('kimiInlineTools：无 $ref 无 $defs 原引用返回；非 function 工具保形；深度保护', () => {
  const clean = [{ type: 'function', function: { name: 'j', parameters: { type: 'object', properties: { x: { type: 'string' } } } } }];
  assert.strictEqual(s.kimiInlineTools(clean), clean, '零改动路径返回原数组（普通 kimi 请求零影响）');

  const mixed = [
    { type: 'custom', x: 1 },
    { type: 'function', function: { name: 'k', parameters: { $ref: '#/$defs/A', $defs: { A: { type: 'string' } } } } },
  ];
  const om = s.kimiInlineTools(mixed);
  assert.strictEqual(om[0], mixed[0], '非 function 工具原样保留');
  assert.deepStrictEqual(om[1].function.parameters, { type: 'string' });

  // >64 层嵌套：栈保护落 {}，不炸调用栈
  let deep = { type: 'object' };
  for (let i = 0; i < 80; i++) deep = { type: 'object', properties: { n: deep } };
  const od = s.kimiInlineTools([{ type: 'function', function: { name: 'l', parameters: { type: 'object', properties: { root: deep } } } }]);
  assert.ok(od[0].function.parameters.properties.root.properties.n, '正常前段保留');
});

test('buildChatBody 门控：只有 cn + kimi 前缀的请求才展开（非 kimi 零改动）', () => {
  const chat = require('../../src/workbuddy/chat');
  process.env.DUMATE_ADMIN_DATA = process.env.DUMATE_ADMIN_DATA || tmpDir('wb-sanitize-tools');
  const acct = { id: 1, uid: 'u1', accessToken: 't' };
  const kimiTools = [{
    type: 'function',
    function: {
      name: 'f',
      parameters: { $ref: '#/$defs/Args', $defs: { Args: { type: 'object', properties: { q: { type: 'string' } } } } },
    },
  }];
  // cn + kimi → 展开（$defs 消失）
  const b1 = chat.buildChatBody({ model: 'kimi-k31', messages: [{ role: 'user', content: 'hi' }], tools: kimiTools }, 'cn', acct);
  const out1 = JSON.parse(b1.body);
  assert.strictEqual(out1.tools[0].function.parameters.$defs, undefined, 'kimi 请求应展开 $ref');
  // cn + 非 kimi → 原样（$defs 还在）
  const kimiTools2 = JSON.parse(JSON.stringify(kimiTools));
  const b2 = chat.buildChatBody({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], tools: kimiTools2 }, 'cn', acct);
  const out2 = JSON.parse(b2.body);
  assert.ok(out2.tools[0].function.parameters.$defs, '非 kimi 请求不动 $defs');
  // cn: 前缀剥掉再判
  const kimiTools3 = JSON.parse(JSON.stringify(kimiTools));
  const b3 = chat.buildChatBody({ model: 'cn:kimi-k31', messages: [{ role: 'user', content: 'hi' }], tools: kimiTools3 }, 'cn', acct);
  const out3 = JSON.parse(b3.body);
  assert.strictEqual(out3.tools[0].function.parameters.$defs, undefined, 'cn: 前缀剥掉后仍命中 kimi 门控');
});
