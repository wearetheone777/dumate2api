// test/unit/trae-solo.test.js - TRAE SOLO/IDE raw 链路纯函数（2026-11-06，#12）
//
// 帧形状与 body 契约全部来自真机实测（探测记录见 solo.js 顶部注释）：
//   · raw v2 的 SSE 与 utils_chat 同族（output/token_usage/done）——消费层
//     chat.js 复用，不重复测；
//   · body 契约：九字段 + encrypted_model_params **字符串原样** + model_name
//     用 model_detail_list 的 __dev 全名（解析成对象 / 剥后缀都被上游拒）；
//   · 版本身份必须与 JWT 一致（我们的 0.1.43，不是 Trae2api-cn 的 3.4.4）。
const { test } = require('node:test');
const assert = require('node:assert');
const solo = require('../../src/traework/solo');
const chat = require('../../src/traework/chat');

const ROW = {
  id: 'deepseek-v4.1-flash',
  customModel: {
    config_name: 'deepseek-v4.1-flash',
    config_source: 1,
    model_detail_list: [{
      model_name: 'deepseek-v4.1-flash__dev',
      encrypted_model_params: '{"RequestPin":"abc","RequestAt":"1793917877","EncryptedStr":"xyz"}',
      max_tokens: 64000,
      prompt_max_tokens: 200000,
    }],
  },
};

test('buildBody：九字段 + __dev 全名 + 信封字符串原样（真机 4001/400 的三个教训）', () => {
  const meta = {};
  const r = solo.buildBody(
    { messages: [{ role: 'user', content: '只回答：好' }] },
    ROW, meta, { model: 'deepseek-v4.1-flash' },
  );
  assert.ok(!r.error);
  const b = JSON.parse(r.body);
  assert.equal(r.providerId, 'deepseek-v4.1-flash__dev');
  assert.equal(b.config_name, 'deepseek-v4.1-flash', 'config_name 是族名');
  assert.equal(b.model_name, 'deepseek-v4.1-flash__dev', 'model_name 用 detail_list 的 __dev 全名（剥后缀实测 4001）');
  assert.equal(b.raw_chat_function, 'solo_agent');
  assert.equal(b.config_source, 1);
  assert.equal(b.stream, true);
  assert.equal(typeof b.encrypted_model_params, 'string', '信封必须字符串原样（解析成对象实测 400）');
  assert.equal(b.session_id, b.conversation_id);
  assert.equal(b.session_id, meta.sessionId, '账单键写进 meta（capture 的 turnId 管线）');
  assert.match(b.session_id, /^[0-9a-f]{24}$/, 'ObjectId 形状');
  assert.deepStrictEqual(b.messages, [{ role: 'user', content: [{ type: 'text', text: '只回答：好' }] }]);
  assert.ok(!('tools' in b), '无 tools 不带槽');
});

test('buildBody：缺信封明确报错（静默发等于制造一次上游 4001）', () => {
  const r = solo.buildBody(
    { messages: [{ role: 'user', content: 'hi' }] },
    { id: 'm', customModel: { config_name: 'm', model_detail_list: [] } },
    {}, { model: 'm' },
  );
  assert.ok(r.error && /encrypted_model_params/.test(r.error));
  const r2 = solo.buildBody({ messages: [] }, ROW, {}, {});
  assert.ok(r2.error && /messages 为空/.test(r2.error));
});

test('nativeToolCalls：function_call 包装（非 OpenAI 的 function 嵌套）', () => {
  const out = solo.nativeToolCalls([
    { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } },
    { function: { name: 'no_id', arguments: { a: 1 } } },   // 无 id + 对象 arguments
  ]);
  assert.deepStrictEqual(out, [
    { id: 'c1', type: 'function', function_call: { name: 'read_file', arguments: '{"path":"x"}' } },
    { id: '', type: 'function', function_call: { name: 'no_id', arguments: '{"a":1}' } },
  ]);
  assert.deepStrictEqual(solo.nativeToolCalls(null), []);
});

test('nativeToolsOf：function 形状过滤 + **parameters 保持对象**（raw v2 不转字符串）', () => {
  const out = solo.nativeToolsOf([
    { type: 'function', function: { name: 'list_files', description: 'd', parameters: { type: 'object', properties: {} } } },
    { type: 'web_search' },                                   // 非 function 形状剔除
    { function: { name: 'bare' } },                           // 无 type 补 function
  ]);
  assert.strictEqual(out.length, 2);
  assert.equal(out[0].function.name, 'list_files');
  assert.equal(typeof out[0].function.parameters, 'object', 'TraeWork legacy 才转字符串，raw v2 保持对象');
  assert.equal(out[1].function.name, 'bare');
});

test('buildMessages：developer→system、assistant 历史带 function_call、tool 回灌', () => {
  const out = solo.buildMessages([
    { role: 'developer', content: 'S' },
    { role: 'user', content: [{ type: 'text', text: '读文件' }, { type: 'image_url', image_url: { url: 'x' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'contents' },
  ]);
  assert.equal(out[0].role, 'system');
  assert.equal(out[1].role, 'user');
  assert.ok(out[1].content[0].text.includes('读文件'));
  assert.ok(out[1].content[0].text.includes('本链路暂不支持'), '图像块降级占位（渲染层媒体块未实测不预编）');
  assert.equal(out[2].tool_calls[0].function_call.name, 'read_file');
  assert.equal(out[3].tool_call_id, 'c1');
  assert.equal(out[3].name, 'read_file');
});

test('oidSessionId 复用：solo 账单键与 utils_chat 同算法（chat.js 导出）', () => {
  const a = chat.oidSessionId();
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.notEqual(a, chat.oidSessionId());
});

test('RAW_ENDPOINTS：v2 → v1 → api5 候选链（Trae2api-cn 同顺序）', () => {
  assert.deepStrictEqual(solo.RAW_ENDPOINTS.map((e) => e.path), [
    '/api/ide/v2/llm_raw_chat',
    '/api/ide/v1/llm_raw_chat',
    '/api/ide/v2/llm_raw_chat',
  ]);
  assert.ok(solo.RAW_ENDPOINTS[2].host.includes('api5-normal'), '第三候选是已知调度主机');
});
