// test/verify-qoder-channel.js - Qoder 通道的离线验证
//
// 不依赖网络与运行中的服务。覆盖三块：
//   1. 模型倍率解析（price_factor 排序、cheap 判定、兜底表）
//   2. 聊天 body 构造（模型 key 同时进 body 与请求头、工具过滤、执行纪律注入）
//   3. 上游响应解析（信封错误、usage 里的 credits、SSE 聚合）
//
// 为什么不测签名：那是 verify-qoder-cosy.js 的事（用 Go 参考实现的测试向量）。
const assert = require('assert');
const chat = require('../src/qoder/chat');
const constants = require('../src/qoder/constants');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`[PASS] ${label}`); }
  catch (e) { failures++; console.log(`[FAIL] ${label} — ${e.message}`); }
}

console.log('== 模型 key 解析 ==');
check('未知名字原样透传', () => assert.strictEqual(chat.resolveModelKey('gfmodel'), 'gfmodel'));
check('别名 qwen-max → qmodel_latest', () => assert.strictEqual(chat.resolveModelKey('qwen-max'), 'qmodel_latest'));
check('空值回落默认 auto', () => assert.strictEqual(chat.resolveModelKey(''), constants.DEFAULT_MODEL));

// 真实模型名解析：上游 key 是内部代号，cc-switch 里填它分不清是哪个模型，
// 所以 display_name / 归一化写法都要能解析回 key
const MODELS = [
  { key: 'gfmodel', name: 'GLM-5.3-Flash' },
  { key: 'dmodel', name: 'DeepSeek-V4-Pro' },
  { key: 'kmodel', name: 'Kimi-K2.8-Preview' },
  { key: 'auto', name: 'Auto' },
];
check('真实名 → 内部 key', () => assert.strictEqual(chat.resolveModelKey('qoder/GLM-5.3-Flash', MODELS), 'gfmodel'));
check('真实名大小写不敏感', () => assert.strictEqual(chat.resolveModelKey('glm-5.3-flash', MODELS), 'gfmodel'));
check('去掉分隔符也能匹配', () => assert.strictEqual(chat.resolveModelKey('qoder/glm53flash', MODELS), 'gfmodel'));
check('内部 key 仍可用（旧配置不破坏）', () => assert.strictEqual(chat.resolveModelKey('qoder/gfmodel', MODELS), 'gfmodel'));
check('相近名字不串档（Pro ≠ Flash）', () => assert.strictEqual(chat.resolveModelKey('qoder/DeepSeek-V4-Pro', MODELS), 'dmodel'));
check('未知名字仍原样透传', () => assert.strictEqual(chat.resolveModelKey('qoder/nope', MODELS), 'nope'));

console.log('');
console.log('== 聊天 body 构造 ==');
const body = JSON.parse(chat.buildBody('gfmodel', {
  model: 'qoder/gfmodel',
  messages: [{ role: 'user', content: '你好' }],
  max_tokens: 100,
}));
check('model_config.key 是模型名', () => assert.strictEqual(body.model_config.key, 'gfmodel'));
check('chat_context.extra.modelConfig.key 同步', () => assert.strictEqual(body.chat_context.extra.modelConfig.key, 'gfmodel'));
check('stream 为 true（上游只走 SSE）', () => assert.strictEqual(body.stream, true));
check('带 business 对象（缺了会 503）', () => assert.strictEqual(body.business.product, 'qoder_work'));
check('business.model_key 计费归因（hub #119：缺失时所有模型被记成 auto 档）', () => assert.strictEqual(body.business.model_key, 'gfmodel'));
check('session_type 正确', () => assert.strictEqual(body.session_type, 'qoder_work'));
check('max_tokens 透传', () => assert.strictEqual(body.parameters.max_tokens, 100));
check('chat_context.text 取最后一条 user', () => assert.strictEqual(body.chat_context.text, '你好'));

console.log('');
console.log('== 工具过滤（上游只认标准 function 形状）==');
const withTools = JSON.parse(chat.buildBody('gfmodel', {
  messages: [{ role: 'user', content: 'hi' }],
  tools: [
    { type: 'function', function: { name: 'exec_command', parameters: {} } },
    { type: 'namespace', name: 'multi_agent_v1' },   // Codex 会带，必须丢弃
    { type: 'web_search' },                          // 同上
  ],
}));
check('只保留 function 形状', () => assert.strictEqual(withTools.tools.length, 1));
check('保留的是 exec_command', () => assert.strictEqual(withTools.tools[0].function.name, 'exec_command'));

console.log('');
console.log('== 执行纪律注入 ==');
check('有工具时注入', () => {
  const b = JSON.parse(chat.buildBody('gfmodel', {
    system: '你是助手',
    messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
  }));
  assert.ok(b.system.includes('【执行纪律'));
});
check('无工具时不注入（纯对话不该干扰）', () => {
  const b = JSON.parse(chat.buildBody('gfmodel', {
    system: '你是助手',
    messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: 'hi' }],
  }));
  assert.ok(!b.system.includes('【执行纪律'));
});
check('幂等：重复注入不叠加', () => {
  const once = chat.withAgentDiscipline('X', true);
  const twice = chat.withAgentDiscipline(once, true);
  assert.strictEqual(once, twice);
});
check('system 留在 messages 里（上游只认它）', () => {
  const b = JSON.parse(chat.buildBody('gfmodel', {
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }],
  }));
  assert.ok(b.messages.some((m) => m.role === 'system' && m.content.includes('SYS')));
});

console.log('');
console.log('== 响应解析 ==');
check('unwrap 剥信封', () => {
  const inner = '{"choices":[{"delta":{"content":"hi"}}]}';
  const outer = JSON.stringify({ body: inner, statusCodeValue: 200 });
  assert.deepStrictEqual(chat.unwrap(outer), [inner]);
});
check('envelopeStatus 抓业务错误', () => {
  const outer = JSON.stringify({ body: '{"code":"105","message":"Login expired"}', statusCodeValue: 403 });
  const es = chat.envelopeStatus(`data:${outer}`);
  assert.strictEqual(es.code, 403);
  assert.ok(es.message.includes('Login expired'));
});
check('payloadError 抓内层错误码', () => {
  const e = chat.payloadError({ code: 500, message: 'boom' });
  assert.strictEqual(e.code, 500);
});
check('正常帧不误判为错误', () => {
  assert.strictEqual(chat.payloadError({ choices: [{ delta: { content: 'hi' } }] }), null);
});

// 2026-10-22：上游 provider 层失败时发的是**字符串 code**，且首字母小写。
// 旧判据只认 /^[A-Z]/，这一帧被当正常数据转发 → 翻译器没有 choices 可读 →
// 客户端拿到 200 + 空回答（实测 /v1/responses 只有 created/in_progress/completed）。
check('payloadError 抓 provider_error（小写字符串 code）', () => {
  const e = chat.payloadError({
    code: 'provider_error', message: 'All backends failed',
    request_id: 'x', type: 'provider_error',
  });
  assert.ok(e, '必须判定为错误');
  assert.ok(e.message.includes('All backends failed'));
});
check('payloadError 抓 type=provider_error（无 code）', () => {
  const e = chat.payloadError({ type: 'provider_error', message: 'All backends failed' });
  assert.ok(e);
});
check('payloadError 的 error 对象优先于 type（不产出 [object Object]）', () => {
  const e = chat.payloadError({ type: 'error', error: { code: 503, message: 'All backends failed' } });
  assert.ok(e, '必须判定为错误');
  assert.strictEqual(e.code, 503);
  assert.ok(e.message.includes('All backends failed'), e.message);
  assert.ok(!e.message.includes('[object Object]'), e.message);
});
check('payloadError 抓 error 对象', () => {
  const e = chat.payloadError({ error: { code: 503, message: 'unavailable' } });
  assert.strictEqual(e.code, 503);
});
check('payloadError 仍认大写字符串 code', () => {
  const e = chat.payloadError({ code: 'LoginExpired', message: 'login expired' });
  assert.ok(e);
});
check('payloadError 不误伤 code=0 / 成功标记', () => {
  assert.strictEqual(chat.payloadError({ code: 0, message: 'ok' }), null);
  assert.strictEqual(chat.payloadError({ code: '0' }), null);
  assert.strictEqual(chat.payloadError({ code: 'success' }), null);
});
check('envelopeStatus 抓非信封的纯错误体', () => {
  const es = chat.envelopeStatus('{"code":"provider_error","message":"All backends failed","type":"provider_error"}');
  assert.ok(es, '非 SSE 的错误体也要认');
  assert.ok(es.message.includes('All backends failed'));
});

console.log('');
console.log('== SSE 聚合（含 usage 里的 credits）==');
const agg = chat.aggregate([
  '{"id":"x","choices":[{"delta":{"reasoning_content":"想"}}]}',
  '{"choices":[{"delta":{"content":"你"}}]}',
  '{"choices":[{"delta":{"content":"好"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"credits":0.0065},"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}',
], 'gfmodel');
check('正文拼接', () => assert.strictEqual(agg.choices[0].message.content, '你好'));
check('reasoning 拼接', () => assert.strictEqual(agg.choices[0].message.reasoning_content, '想'));
check('usage 里的 credits 保留', () => assert.strictEqual(agg.usage.credits, 0.0065));
check('finish_reason 透传', () => assert.strictEqual(agg.choices[0].finish_reason, 'stop'));

console.log('');
console.log('== 常量 ==');
check('两个区域都有端点', () => {
  assert.ok(constants.endpointsOf('cn').ChatStreamURL.includes('qoder.com.cn'));
  assert.ok(constants.endpointsOf('global').ChatStreamURL.includes('qoder.sh'));
});
check('global 推理主力是 api3（官方 0.4.8 候选首位；api1 是旧配置，常年超时）', () => {
  assert.ok(constants.endpointsOf('global').ChatStreamURL.startsWith('https://api3.qoder.sh/'));
});
check('区域归一化', () => {
  assert.strictEqual(constants.normalizeRegion('cn'), 'cn');
  assert.strictEqual(constants.normalizeRegion('CN'), 'cn');
  assert.strictEqual(constants.normalizeRegion(''), 'global');
  assert.strictEqual(constants.normalizeRegion('us'), 'global');
});
check('便宜模型表都是 0.1 档', () => {
  assert.deepStrictEqual(constants.CHEAP_MODELS, ['qfmodel', 'qmodel', 'q37fmodel', 'dfmodel', 'gfmodel']);
});

console.log('');
console.log('== 推理主机候选链（2026-10-30 对齐官方客户端候选顺序）==');
check('cn 单主机（国内版没有候选链）', () => {
  assert.strictEqual(constants.chatStreamCandidates('cn').length, 1);
  assert.ok(constants.chatStreamCandidates('cn')[0].includes('gateway.qoder.com.cn'));
});
check('global 按 api3→api2→api1 排列', () => {
  const hosts = constants.chatStreamCandidates('global').map((u) => new URL(u).host);
  assert.deepStrictEqual(hosts, ['api3.qoder.sh', 'api2.qoder.sh', 'api1.qoder.sh']);
});
check('候选链的 path 与签名 path 一致', () => {
  for (const u of constants.chatStreamCandidates('global')) {
    assert.ok(new URL(u).pathname.startsWith('/algo/api/v2/service/pro/sse/agent_chat_generation'));
  }
});

console.log('');
console.log('== 身份头（对齐官方客户端，qoder2api-hub #64 逆向）==');
const cosy = require('../src/qoder/cosy');
const SESS = cosy.newSession({
  name: 'tester', aid: 'uid-h1', uid: 'uid-h1', yxUid: '',
  organizationId: '', organizationName: '', userType: 'personal_standard',
  securityOauthToken: 'at', refreshToken: 'rt',
}, 'mid-h', 'mtok-h', '5');
check('流式请求带 cosy-machineos（官方 {arch}_{platform} 形态）', () => {
  const h = cosy.buildHeaders(SESS, '/api/v2/service/pro/sse/agent_chat_generation', '', 'text/event-stream', {}, { sse: true });
  assert.ok(/^x86_64_(win32|linux|darwin)|^aarch64_/.test(h['cosy-machineos']), h['cosy-machineos']);
});
check('流式请求带 cosy-machinehostname，非流式（模型表）不带', () => {
  const sse = cosy.buildHeaders(SESS, '/p', '', 'text/event-stream', {}, { sse: true });
  const api = cosy.buildHeaders(SESS, '/p', '', 'application/json', {});
  assert.ok(/^DESKTOP-[0-9A-F]{7}$/.test(sse['cosy-machinehostname']), sse['cosy-machinehostname']);
  assert.strictEqual(api['cosy-machinehostname'], undefined);
  // 模型表请求也带 machineos（官方对所有请求注入）
  assert.ok(api['cosy-machineos']);
});
check('hostname 按账号稳定派生：同账号恒同、跨账号不同', () => {
  const a1 = cosy.machineHostname('uid-a');
  const a2 = cosy.machineHostname('uid-a');
  const b1 = cosy.machineHostname('uid-b');
  assert.strictEqual(a1, a2);
  assert.notStrictEqual(a1, b1);
});
check('User-Agent 是 undici（官方 CLI 形态），不再是 Go 指纹', () => {
  const h = cosy.buildHeaders(SESS, '/p', '', 'text/event-stream', {}, { sse: true });
  assert.strictEqual(h['user-agent'], 'undici');
});

console.log('');
console.log('== 思考档位归一化（2026-10-30，thinking_config 实测形状）==');
const session = require('../src/qoder/session');
// thinking_config 原文取自 hub 的 qoder_catalog_cn.json 快照（dfmodel/qfmodel）
check('parseThinkingConfig：efforts 集合 + is_default 默认档 + disabled 开关', () => {
  const df = session.parseThinkingConfig({
    disabled: { description: 'Disable thinking' },
    enabled: {
      description: 'Enable thinking',
      efforts: { high: {}, max: { description: 'x', is_default: true }, low: {} },
      is_default: true,
    },
  });
  assert.deepStrictEqual(df, { efforts: ['high', 'max', 'low'], default: 'max', canDisable: true });
});
check('parseThinkingConfig：缺失/坏形状给空值（按无档位表处理）', () => {
  assert.deepStrictEqual(session.parseThinkingConfig(null), { efforts: [], default: '', canDisable: false });
  assert.deepStrictEqual(session.parseThinkingConfig({}), { efforts: [], default: '', canDisable: false });
  assert.deepStrictEqual(session.parseThinkingConfig({ enabled: { efforts: 'x' } }).efforts, []);
});
const QF = { key: 'qfmodel', reasoningEfforts: ['xhigh', 'low', 'medium'], reasoningDefault: 'medium' }; // Qwen3.8-Flash
const DF = { key: 'dfmodel', reasoningEfforts: ['high', 'max', 'low'], reasoningDefault: 'max' };        // DeepSeek-Flash
check('合法档位原样透传', () => {
  assert.strictEqual(chat.resolveReasoningEffort({ reasoning_effort: 'high' }, DF), 'high');
  assert.strictEqual(chat.resolveReasoningEffort({ reasoning_effort: 'xhigh' }, QF), 'xhigh');
});
check('无效档位归一到最近合法档（hub 实测：qfmodel high→medium、max→xhigh）', () => {
  assert.strictEqual(chat.resolveReasoningEffort({ reasoning_effort: 'high' }, QF), 'medium');
  assert.strictEqual(chat.resolveReasoningEffort({ reasoning_effort: 'max' }, QF), 'xhigh');
  assert.strictEqual(chat.resolveReasoningEffort({ reasoning_effort: 'xhigh' }, DF), 'max');
});
check('距离相同偏向默认档（dfmodel medium→high 而非 low）', () => {
  assert.strictEqual(chat.resolveReasoningEffort({ reasoning_effort: 'medium' }, DF), 'high');
});
check('四种入口写法都认（OpenAI / Codex / thinking.effort / thinking.level）', () => {
  assert.strictEqual(chat.resolveReasoningEffort({ reasoning: { effort: 'low' } }, DF), 'low');
  assert.strictEqual(chat.resolveReasoningEffort({ thinking: { effort: 'low' } }, DF), 'low');
  assert.strictEqual(chat.resolveReasoningEffort({ thinking: { level: 'low' } }, DF), 'low');
});
check('minimal 别名 → low；显式 none → 不下发（null）', () => {
  assert.strictEqual(chat.resolveReasoningEffort({ reasoning_effort: 'minimal' }, DF), 'low');
  assert.strictEqual(chat.resolveReasoningEffort({ reasoning_effort: 'none' }, DF), null);
  assert.strictEqual(chat.resolveReasoningEffort({ thinking: { type: 'disabled' }, reasoning_effort: 'high' }, DF), 'high',
    'disabled 标志由翻译层剥（不发 effort 字段），这里只看档位');
});
check('无档位表的模型原样透传（上游自会回落默认档）', () => {
  assert.strictEqual(chat.resolveReasoningEffort({ reasoning_effort: 'high' }, null), 'high');
});
check('buildBody 下发 parameters.reasoning_effort；none 不下发', () => {
  const b1 = JSON.parse(chat.buildBody('dfmodel', {
    messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'xhigh',
  }, { modelMeta: DF }));
  assert.strictEqual(b1.parameters.reasoning_effort, 'max');
  const b2 = JSON.parse(chat.buildBody('dfmodel', {
    messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'none',
  }, { modelMeta: DF }));
  assert.strictEqual(b2.parameters.reasoning_effort, undefined);
});

console.log('');
console.log('== max_tokens 上限自学习钳制（buildBody 侧）==');
check('超上限自动压到 maxOutputTokens', () => {
  const b = JSON.parse(chat.buildBody('dfmodel', {
    messages: [{ role: 'user', content: 'hi' }], max_tokens: 999999,
  }, { maxOutputTokens: 131072 }));
  assert.strictEqual(b.parameters.max_tokens, 131072);
});
check('未学到上限时不钳制', () => {
  const b = JSON.parse(chat.buildBody('dfmodel', {
    messages: [{ role: 'user', content: 'hi' }], max_tokens: 999999,
  }, {}));
  assert.strictEqual(b.parameters.max_tokens, 999999);
});
check('客户端没带 max_tokens 时的默认值也受上限约束', () => {
  const b = JSON.parse(chat.buildBody('dfmodel', { messages: [{ role: 'user', content: 'hi' }] }, { maxOutputTokens: 16000 }));
  assert.strictEqual(b.parameters.max_tokens, 16000);
});

console.log('');
console.log('== usage 缓存字段归一化（#112：DeepSeek/Qwen 缓存数字搬标准位）==');
check('DeepSeek 形态：prompt_cache_hit_tokens → 标准位，原字段保留', () => {
  const u = { prompt_tokens: 100, prompt_cache_hit_tokens: 80, completion_tokens: 5 };
  assert.strictEqual(chat.normalizeUsageCache(u), true);
  assert.strictEqual(u.prompt_tokens_details.cached_tokens, 80);
  assert.strictEqual(u.prompt_cache_hit_tokens, 80, '原字段保留');
});
check('Qwen 形态：completion_tokens_details.cached_tokens → 标准位', () => {
  const u = { prompt_tokens: 100, completion_tokens_details: { cached_tokens: 60 } };
  assert.strictEqual(chat.normalizeUsageCache(u), true);
  assert.strictEqual(u.prompt_tokens_details.cached_tokens, 60);
  assert.strictEqual(u.completion_tokens_details.cached_tokens, 60, '原字段保留');
});
check('已有标准位时不覆盖（不编数字）', () => {
  const u = { prompt_cache_hit_tokens: 80, prompt_tokens_details: { cached_tokens: 99 } };
  assert.strictEqual(chat.normalizeUsageCache(u), false);
  assert.strictEqual(u.prompt_tokens_details.cached_tokens, 99);
});
check('上游没给缓存时不凭空造字段', () => {
  const u = { prompt_tokens: 100 };
  assert.strictEqual(chat.normalizeUsageCache(u), false);
  assert.strictEqual(u.prompt_tokens_details, undefined);
  assert.strictEqual(chat.normalizeUsageCache(null), false);
});
check('aggregate 出口带归一化后的 usage', () => {
  const agg = chat.aggregate([
    '{"choices":[{"delta":{"content":"hi"}}]}',
    '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"credits":0.01,"prompt_cache_hit_tokens":7}}',
  ], 'gfmodel');
  assert.strictEqual(agg.usage.prompt_tokens_details.cached_tokens, 7);
});

console.log('');
console.log('== 官方积分消耗解析（credits-summary / credits-heatmap）==');
check('标准形状：summary 三字段 + heatmap 逐日', () => {
  const r = session.parseCreditUsage(
    { totalCredits: 12.3456, peakCredits: 3.2, peakDate: '2026-10-28', unit: 'credits' },
    { items: [{ date: '2026-10-28', value: 3.2 }, { date: '2026-10-27', value: 1.1 }, { junk: 1 }] },
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.total, 12.3456);
  assert.strictEqual(r.peak, 3.2);
  assert.strictEqual(r.peakDate, '2026-10-28');
  assert.strictEqual(r.daily.length, 2, '坏条目跳过');
  assert.strictEqual(r.heatmapOk, true);
});
check('summary 字段缺失给 null（不补 0——0 会被读成没消耗）', () => {
  const r = session.parseCreditUsage({}, null);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.total, null);
  assert.strictEqual(r.peak, null);
  assert.strictEqual(r.daily.length, 0);
  assert.strictEqual(r.heatmapOk, false);
});
check('summary 不是对象 → ok:false', () => {
  assert.strictEqual(session.parseCreditUsage(null, null).ok, false);
  assert.strictEqual(session.parseCreditUsage('x', null).ok, false);
});

console.log('');
if (failures) { console.log(`${failures} 项失败`); process.exit(1); }
console.log('全部通过');
process.exit(0);
