// test/unit/trae-remote.test.js - TRAE Remote 链路纯函数（2026-11-01，P2-16）
//
// 事件形状与快照语义全部来自真机实测（见 remote.js 顶部注释）；网络层不
// 做离线断言（真机已在落地时跑通：createSession → plan_item/token_usage/done
// → get_session_usage 返回真实 amount_float）。
const { test } = require('node:test');
const assert = require('node:assert');
const remote = require('../../src/traework/remote');

test('flattenQuery：角色前缀与工具历史的 query 形状', () => {
  const q = JSON.parse(remote.flattenQuery([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' },
    { role: 'assistant', content: 'A', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'f', content: 'R' },
  ]));
  assert.ok(q[0].type === 'text' && typeof q[0].data.content === 'string');
  assert.ok(q[0].data.content.startsWith('[System]\nS'));
  assert.ok(q[0].data.content.includes('[Assistant]\nA'));
  assert.ok(q[0].data.content.includes('[called tools: f({})]'));
  assert.ok(q[0].data.content.includes('[Client Tool Result: c1 f status=succeeded]\nR'));
});

test('flattenQuery：长会话保护（Trae2api-cn build_remote_query 同策略）', () => {
  const long = (n) => 'x'.repeat(n);
  // 超限：System 头保护 + 尾部保留 + 中间标记，总长 ≤ 预算
  const msgs = [
    { role: 'system', content: 'SYS-CONTRACT' },
    { role: 'user', content: long(30000) },
    { role: 'user', content: 'TAIL-KEEP' },
  ];
  const q = JSON.parse(remote.flattenQuery(msgs, 5000));
  const c = q[0].data.content;
  assert.ok(c.length <= 5100, `裁剪后应贴近预算，实际 ${c.length}`);
  assert.ok(c.startsWith('[System]\nSYS-CONTRACT'), 'System 头保护');
  assert.ok(c.includes('[Prompt truncated: '), '中间省略标记');
  assert.ok(c.endsWith('TAIL-KEEP'), '尾部（最新）保留');
  assert.ok(!c.includes(long(30000)), '旧历史被裁掉');
  // 无 System：尾部 suffix + 头部标记
  const q2 = JSON.parse(remote.flattenQuery([{ role: 'user', content: long(9000) }], 3000));
  const c2 = q2[0].data.content;
  assert.ok(c2.startsWith('[Prompt truncated: '), '无保护块时标记在头');
  assert.ok(c2.length <= 3100);
  // 保护块自己占满预算：只返回 System（外部工具契约不丢）
  const c3 = JSON.parse(remote.flattenQuery([
    { role: 'system', content: 'S'.repeat(900) },
    { role: 'user', content: long(5000) },
  ], 1000))[0].data.content;
  assert.ok(c3.startsWith('[System]'), '预算被保护块占满时只留 System');
  assert.ok(!c3.includes('x'.repeat(100)), '会话部分整体丢弃');
  // 短 prompt 原样（回归锚）
  const q4 = JSON.parse(remote.flattenQuery([{ role: 'user', content: 'hi' }], 5000));
  assert.strictEqual(q4[0].data.content, 'hi');
});

test('flattenQuery：图像块降级为占位文本（不预编渲染器媒体块）', () => {
  const q = JSON.parse(remote.flattenQuery([
    { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] },
  ]));
  assert.ok(q[0].data.content.includes('看图'));
  assert.ok(q[0].data.content.includes('本链路暂不支持'));
});

test('remoteSessionId：同账号同模型稳定、跨账号互异、UUID 形状', () => {
  const a = remote.remoteSessionId('u1', 'm');
  assert.equal(a, remote.remoteSessionId('u1', 'm'));
  assert.notEqual(a, remote.remoteSessionId('u2', 'm'));
  assert.notEqual(a, remote.remoteSessionId('u1', 'm2'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('commonParams：**返回 JSON 字符串**且会话键在 biz_session_id（Trae2api-cn 断言同款）', () => {
  const s = remote.commonParams({ uid: 'u1' }, 'code', 'sess-1');
  assert.equal(typeof s, 'string', '请求体里 common_params 是序列化后的串，不是对象');
  const o = JSON.parse(s);
  assert.equal(o.biz_session_id, 'sess-1');
  assert.equal(o.solo_chat_mode, 'code');
  assert.equal(o.tenant, 'marscode');
});

test('remoteBaseOf：cn 给基址，intl 如实拒绝（未实测不预编）', () => {
  assert.equal(remote.remoteBaseOf('cn'), require('../../src/traework/constants').REMOTE_BASE_CN);
  assert.equal(remote.remoteBaseOf('intl'), null);
  assert.equal(remote.remoteBaseOf(undefined), remote.remoteBaseOf('cn'));
});

test('textAccumulator：快照取新增量、增量追加、旧快照忽略', () => {
  const t = remote.textAccumulator();
  assert.equal(t.push('收到'), '收到');
  // 累积快照：新帧是全文 → 只发新增量
  assert.equal(t.push('收到了'), '了');
  assert.equal(t.push('收到了吗'), '吗');
  // 旧快照迟到（乱序）：不发
  assert.equal(t.push('收到了'), '');
  // 真增量（不是前缀扩展）：追加
  assert.equal(t.push('！'), '！');
  assert.equal(t.value(), '收到了吗！');
});

test('aggregateEvents：plan_item 聚合、usage/model_config/done 归位', () => {
  const agg = remote.aggregateEvents([
    { event: 'plan_item', data: { thought: '你' } },
    { event: 'plan_item', data: { thought: '你好', reasoning_content: 'th' } },
    { event: 'model_config', data: { config_name: 'Doubao-Seed-2.1-Turbo' } },
    { event: 'token_usage', data: { prompt_tokens: 10, completion_tokens: 2, reasoning_tokens: 1, total_tokens: 12 } },
    { event: 'done', data: { status: 'completed' } },
  ], 'auto');
  assert.equal(agg.choices[0].message.content, '你好');
  assert.equal(agg.choices[0].message.reasoning_content, 'th');
  assert.equal(agg.model, 'Doubao-Seed-2.1-Turbo', '实际模型回填（上游恒 auto 时唯一真相）');
  assert.equal(agg.choices[0].finish_reason, 'stop');
  assert.equal(agg.usage.total_tokens, 12);
  assert.equal(agg.usage.completion_tokens_details.reasoning_tokens, 1);
});

// ---- manual 策略（2026-11-05，P2-13.1；协议取自 Trae2api-cn）----

test('modelFamilyOf：_model_family 逐字对照', () => {
  const f = remote.modelFamilyOf;
  assert.equal(f('trae/glm-5.2'), 'glm-5.2');
  assert.equal(f('DeepSeek-V4-Flash'), 'deepseek-v4-flash');
  assert.equal(f('deepseek-v4-flash__dev'), 'deepseek-v4-flash', '__ 运行档后缀剥掉');
  assert.equal(f('deepseek-v4-flash-20251101'), 'deepseek-v4-flash', '日期后缀归族');
  assert.equal(f('deepseek-v4-flash-official'), 'deepseek-v4-flash');
  assert.equal(f('ali-deepseek-v4-pro'), 'deepseek-v4-pro', 'ali- 前缀剥掉');
  assert.equal(f(''), '');
});

test('manualFieldsOf：候选命中产出五件套，config_source/is_preset 缺省对齐 Trae2api-cn', () => {
  const raw = { config_name: 'deepseek-v4-flash__dev', usage: 'chat_completion' };
  const r = remote.manualFieldsOf('deepseek-v4-flash', { id: 'deepseek-v4-flash', customModel: raw });
  assert.ok(!r.error);
  assert.equal(r.boundModel, 'deepseek-v4-flash__dev', 'bound 是 config 的精确 id');
  assert.equal(r.fields.model_name, 'deepseek-v4-flash__dev');
  assert.equal(r.fields.model_config_source, 1, '缺省 1（Trae2api-cn 字面）');
  assert.equal(r.fields.model_is_preset, true, '缺省 true（Trae2api-cn 字面）');
  assert.equal(r.fields.model_provider, '');
  assert.strictEqual(r.fields.custom_model, raw, '原样透传上游原始对象');
  const raw2 = { config_name: 'glm-5.2', config_source: 3, is_preset: false, provider: 'zhipu' };
  const r2 = remote.manualFieldsOf('glm-5.2', { customModel: raw2 });
  assert.equal(r2.fields.model_config_source, 3);
  assert.equal(r2.fields.model_is_preset, false);
  assert.equal(r2.fields.model_provider, 'zhipu');
});

test('manualFieldsOf：模型族不匹配 / 缺原始对象 → 明确拒绝（不静默落默认档）', () => {
  const r = remote.manualFieldsOf('kimi-k3', { customModel: { config_name: 'deepseek-v4-flash' } });
  assert.ok(r.error && /不匹配/.test(r.error));
  const r2 = remote.manualFieldsOf('glm-5.2', { id: 'glm-5.2' });
  assert.ok(r2.error && /没有上游原始配置对象/.test(r2.error));
});

test('createSession（manual）：initial_message 带五件套 + strategy=manual', async () => {
  const https = require('node:https');
  const realRequest = https.request;
  let captured = null;
  https.request = function fake(opts, cb) {
    const req = {
      on(ev, cb2) { if (ev === 'error' || ev === 'timeout') this[`_${ev}`] = cb2; return this; },
      write(b) { captured = JSON.parse(String(b)); },
      end() {
        setImmediate(() => {
          const res = {
            statusCode: 200,
            on(ev, cb2) {
              if (ev === 'data') setImmediate(() => cb2(Buffer.from(JSON.stringify({ data: { chat_session_id: 'cs-1', message_id: 'm-1' } }))));
              if (ev === 'end') setImmediate(() => cb2());
              return res;
            },
            resume() {},
          };
          cb(res);
        });
      },
      destroy() {},
    };
    return req;
  };
  try {
    const auth = { uid: 'u1', accessToken: 'at', region: 'cn', payIdentity: 'Free' };
    const raw = { config_name: 'deepseek-v4-flash__dev', usage: 'chat_completion' };
    const r = await remote.createSession(auth, {
      messages: [{ role: 'user', content: 'hi' }],
      model: 'deepseek-v4-flash',
      mode: 'code',
      strategy: 'manual',
      customModelRow: { id: 'deepseek-v4-flash', customModel: raw },
    });
    assert.ok(r.ok, `createSession 失败: ${r.error || '(无错误信息)'}`);
    assert.ok(captured, '请求体应被捕获');
    const im = captured.initial_message;
    assert.equal(im.model_selection_strategy, 'manual');
    assert.equal(im.model_name, 'deepseek-v4-flash__dev', 'model_name 用 bound 精确 id');
    assert.equal(im.model_config_source, 1);
    assert.equal(im.model_is_preset, true);
    assert.equal(im.agent_id, im.agent_type);
    assert.deepStrictEqual(im.custom_model, raw, 'custom_model 原样透传（序列化往返后值相等）');
  } finally {
    https.request = realRequest;
  }
});

test('createSession（manual 校验失败）：不发请求直接拒绝', async () => {
  const r = await remote.createSession(
    { uid: 'u1', accessToken: 'at', region: 'cn' },
    { messages: [{ role: 'user', content: 'hi' }], model: 'kimi-k3', strategy: 'manual', customModelRow: { customModel: { config_name: 'deepseek-v4-flash' } } },
  );
  assert.strictEqual(r.ok, false);
  assert.ok(/不匹配/.test(r.error));
});

// ---- 思考档位（2026-11-06，协议取自 Trae2api-cn reasoning_effort.py）----

test('normalizeLevel：别名表逐字对照（none→light 是 Trae 口径，不是省略）', () => {
  const n = remote.normalizeLevel;
  assert.equal(n('ultra'), 'extra_high');
  assert.equal(n('max'), 'extra_high');
  assert.equal(n('x-high'), 'extra_high');
  assert.equal(n('medium'), 'high');
  assert.equal(n('default'), 'high');
  assert.equal(n('minimal'), 'light');
  assert.equal(n('none'), 'light', 'Trae 侧没有「不下发」槽，显式关闭=压到最低档');
  assert.equal(n(''), '');
  assert.equal(n('nonsense'), '');
});

test('budgetLevel：区间 <4096 light / <16384 high / 更大 extra_high', () => {
  const b = remote.budgetLevel;
  assert.equal(b(1), 'light');
  assert.equal(b(4095), 'light');
  assert.equal(b(4096), 'high');
  assert.equal(b(16383), 'high');
  assert.equal(b(16384), 'extra_high');
  assert.equal(b(0), '');
  assert.equal(b(-5), '');
  assert.equal(b('abc'), '');
});

test('requestedEffort：全入口写法（翻译层已统一 + 散装形态全收）', () => {
  const q = remote.requestedEffort;
  assert.equal(q({ reasoning_effort: 'high' }), 'high');
  assert.equal(q({ reasoningEffort: 'ultra' }), 'extra_high');
  assert.equal(q({ thinking_effort: 'low' }), 'light');
  assert.equal(q({ reasoning: { effort: 'medium' } }), 'high');
  assert.equal(q({ output_config: { effort: 'xhigh' } }), 'extra_high');
  assert.equal(q({ thinking: { effort: 'min' } }), 'light');
  assert.equal(q({ thinking: { level: 'max' } }), 'extra_high');
  assert.equal(q({ thinking: { budget_tokens: 5000 } }), 'high');
  assert.equal(q({ thinking: { budget_tokens: 100000 } }), 'extra_high');
  assert.equal(q({}), '');
  assert.equal(q(null), '');
});

const THINK_DESC = {
  config_name: 'glm-5.2',
  reasoning_effort_config: { support_thinking: true, options: ['light', 'high', 'extra_high'] },
};

test('supportedLevels：对象/字符串 JSON/别名键三形态；support_thinking 不是 true 一律空', () => {
  assert.deepStrictEqual(remote.supportedLevels(THINK_DESC), ['light', 'high', 'extra_high']);
  // descriptor 字段可能是字符串化 JSON（model_limits._mapping 同款）
  const strDesc = { reasoning_effort_config: JSON.stringify({ support_thinking: 'true', reasoning_effort_options: '["light","high"]' }) };
  assert.deepStrictEqual(remote.supportedLevels(strDesc), ['light', 'high']);
  assert.deepStrictEqual(remote.supportedLevels({ reasoning_effort_config: { options: ['light', 'high'] } }), [], '缺 support_thinking 不给档（模型名不是能力证据）');
  assert.deepStrictEqual(remote.supportedLevels({ reasoning_effort_config: { support_thinking: false, options: ['light'] } }), []);
  assert.deepStrictEqual(remote.supportedLevels(null), []);
});

test('clampLevel：向下钳（不高于请求档的最高支持档），无更低档落最低', () => {
  const c = remote.clampLevel;
  assert.equal(c('extra_high', ['light', 'high']), 'high');
  assert.equal(c('high', ['light', 'high', 'extra_high']), 'high');
  assert.equal(c('light', ['high', 'extra_high']), 'high', '没有 ≤ 请求档 → 支持档里最低兜底');
  assert.equal(c('light', ['light']), 'light');
  assert.equal(c('high', []), '');
  assert.equal(c('', ['light']), '');
});

test('applyReasoningEffort：写入档位、字段二选一、不支持删残留、不污染原对象', () => {
  // 常规写入：reasoning_effort
  const r1 = remote.applyReasoningEffort(THINK_DESC, { reasoning_effort: 'ultra' });
  assert.equal(r1.level, 'extra_high');
  assert.equal(r1.requested, 'extra_high');
  assert.equal(r1.row.reasoning_effort, 'extra_high');
  assert.ok(!('reasoning_effort_level' in r1.row), '两键永不同时存在');
  assert.notStrictEqual(r1.row, THINK_DESC, '浅拷贝，不改模型表缓存原对象');
  assert.ok(!('reasoning_effort' in THINK_DESC), '原对象未被污染');
  // 模型对象已有 reasoning_effort_level 键 → 写 level 键并删另一个
  const withLevelKey = { config_name: 'm', reasoning_effort_level: 'light', reasoning_effort_config: { support_thinking: true, options: ['light', 'high', 'extra_high'] } };
  const r2 = remote.applyReasoningEffort(withLevelKey, { reasoning_effort: 'max' });
  assert.equal(r2.row.reasoning_effort_level, 'extra_high');
  assert.ok(!('reasoning_effort' in r2.row));
  // 不支持：删残留字段，requested 如实返回
  const noSupport = { config_name: 'm', reasoning_effort: 'high' };
  const r3 = remote.applyReasoningEffort(noSupport, { reasoning_effort: 'max' });
  assert.equal(r3.level, '');
  assert.equal(r3.requested, 'extra_high');
  assert.ok(!('reasoning_effort' in r3.row), '残留档位字段被删，防上游按残留值降档');
  // 未请求：原样拷贝，不写不删
  const r4 = remote.applyReasoningEffort(THINK_DESC, {});
  assert.equal(r4.level, '');
  assert.equal(r4.requested, '');
  assert.deepStrictEqual(r4.row, THINK_DESC);
  // 钳制走 supportedLevels：请求 ultra、只支持 light/high → high
  const partial = { config_name: 'm', reasoning_effort_config: { support_thinking: true, options: ['light', 'high'] } };
  const r5 = remote.applyReasoningEffort(partial, { reasoning_effort: 'ultra' });
  assert.equal(r5.row.reasoning_effort, 'high');
});

test('manualFieldsOf：带 effortPayload 时 custom_model 被改写且 effort 观测返回', () => {
  const row = { id: 'glm-5.2', customModel: THINK_DESC };
  const r = remote.manualFieldsOf('glm-5.2', row, { reasoning_effort: 'medium' });
  assert.ok(!r.error);
  assert.equal(r.effort.requested, 'high');
  assert.equal(r.effort.level, 'high');
  assert.equal(r.fields.custom_model.reasoning_effort, 'high');
  assert.notStrictEqual(r.fields.custom_model, THINK_DESC, '带档位请求时返回浅拷贝（不改缓存原对象）');
  const r2 = remote.manualFieldsOf('glm-5.2', row);
  assert.strictEqual(r2.fields.custom_model, THINK_DESC, '未请求档位（第三参缺省）仍传原引用');
  assert.equal(r2.effort.requested, '');
});

// ---- usage 缓存透传（2026-11-06，真机形状）----

test('remoteUsageOf：读命中镜像标准位、写缓存平铺、无缓存字段不造', () => {
  const u = remote.remoteUsageOf({
    prompt_tokens: 25442, completion_tokens: 63, total_tokens: 25505, reasoning_tokens: 52,
    cache_read_input_tokens: 25344, cache_creation_input_tokens: 1024,
  });
  assert.equal(u.prompt_tokens, 25442);
  assert.equal(u.prompt_tokens_details.cached_tokens, 25344, '读命中镜像 OpenAI 标准位（chat.js 567 同口径）');
  assert.equal(u.cache_creation_input_tokens, 1024, '写缓存无标准位，平铺保留');
  assert.equal(u.completion_tokens_details.reasoning_tokens, 52);
  const u2 = remote.remoteUsageOf({ prompt_tokens: 18, completion_tokens: 94, total_tokens: 112, reasoning_tokens: 92 });
  assert.ok(!u2.prompt_tokens_details, '上游没给缓存字段时不凭空造');
  assert.ok(!('cache_creation_input_tokens' in u2));
});

// ---- 1M Max 与事件名归一（2026-11-06）----

test('normEventName：驼峰归一 + 已知别名表 + 空入空出', () => {
  const n = remote.normEventName;
  assert.equal(n('tokenUsage'), 'token_usage', '上游会发驼峰事件名，只做小写会漏进 message 分支');
  assert.equal(n('modelConfig'), 'model_config');
  assert.equal(n('responseDone'), 'done');
  assert.equal(n('stream-done'), 'done');
  assert.equal(n('plan_item'), 'plan_item');
  assert.equal(n(''), '', '空入空出——调用方用 || 链回退 data.event');
});

test('contextLimitsOf/maxContextOf：只取显式字段，绝不合成', () => {
  // 真机形状：{dev: 256000} 没有 max 键 → maxContext null
  assert.strictEqual(remote.maxContextOf({ context_window_tokens: { dev: 256000 } }), null);
  assert.deepStrictEqual(remote.maxContextOf({}), null);
  assert.strictEqual(remote.maxContextOf(null), null);
  // mapping 形态取 max
  assert.strictEqual(remote.maxContextOf({ context_window_size: { max: 1048576 } }), 1048576);
  assert.strictEqual(remote.maxContextOf({ context_window_size: 1000000 }), 1000000, '直接数字形态');
  // limits 字段只挑显式存在的
  const l = remote.contextLimitsOf({ max_mode: true, prompt_max_tokens: 200000, usage: 'chat_completion' });
  assert.deepStrictEqual(Object.keys(l).sort(), ['max_mode', 'prompt_max_tokens']);
});

const MAX_DESC = {
  config_name: 'kimi-k3',
  max_mode: true,
  context_window_size: { max: 1048576 },
  prompt_max_tokens: 64000,
  max_tokens: 64000,
};

test('supportsMaxMode：max_mode + ≥1M + 输出上限三项缺一即 false', () => {
  assert.strictEqual(remote.supportsMaxMode(MAX_DESC), true);
  assert.strictEqual(remote.supportsMaxMode({ ...MAX_DESC, max_mode: false }), false);
  assert.strictEqual(remote.supportsMaxMode({ ...MAX_DESC, max_mode: true, context_window_size: { max: 256000 } }), false, '<1M 不算 max 档');
  assert.strictEqual(remote.supportsMaxMode({ ...MAX_DESC, max_tokens: 0 }), false, '输出上限缺失');
  assert.strictEqual(remote.supportsMaxMode({}), false);
  assert.strictEqual(remote.supportsMaxMode(null), false);
});

test('maxModeFields：strategy 升 max + model_auto_selection + 显式上限 + mode_type', () => {
  const f = remote.maxModeFields(MAX_DESC, 1);
  assert.equal(f.model_selection_strategy, 'max');
  assert.deepStrictEqual(f.model_auto_selection, { strategy: 'max', fallback_to_advance_model: null, entitlement_id: null });
  assert.equal(f.context_window_size, 1048576);
  assert.equal(f.prompt_max_tokens, 64000);
  assert.equal(f.max_tokens, 64000);
  assert.equal(f.mode_type, 1);
  assert.ok(!('mode_type' in remote.maxModeFields(MAX_DESC, 0)), 'mode_type<=0 不带');
});

test('maxModeRequested：单次开关 / env 开关 / 白名单', () => {
  delete process.env.DUMATE_TRAEWORK_REMOTE_MAX_MODE;
  delete process.env.DUMATE_TRAEWORK_REMOTE_MAX_MODELS;
  try {
    assert.strictEqual(remote.maxModeRequested('glm-5.2', {}), false, '无开关不请求');
    assert.strictEqual(remote.maxModeRequested('glm-5.2', { trae_max_mode: true }), true, '单次开关');
    process.env.DUMATE_TRAEWORK_REMOTE_MAX_MODE = '1';
    assert.strictEqual(remote.maxModeRequested('glm-5.2', {}), true, 'env 全局开关');
    process.env.DUMATE_TRAEWORK_REMOTE_MAX_MODELS = 'kimi-k3, minimax-m3.1-flash';
    assert.strictEqual(remote.maxModeRequested('kimi-k3', {}), true);
    assert.strictEqual(remote.maxModeRequested('glm-5.2', {}), false, '白名单外不放行');
    process.env.DUMATE_TRAEWORK_REMOTE_MAX_MODELS = '*';
    assert.strictEqual(remote.maxModeRequested('glm-5.2', {}), true, '* 全放行');
  } finally {
    delete process.env.DUMATE_TRAEWORK_REMOTE_MAX_MODE;
    delete process.env.DUMATE_TRAEWORK_REMOTE_MAX_MODELS;
  }
});

test('remoteSessionId：max 变体与普通档互异、各自稳定', () => {
  const plain = remote.remoteSessionId('u1', 'm');
  const max = remote.remoteSessionId('u1', 'm', 'max');
  assert.notEqual(plain, remote.remoteSessionId('u1', 'm2'));
  assert.notEqual(plain, max, 'max 变体是不同的上游配置，会话键必须分开');
  assert.equal(max, remote.remoteSessionId('u1', 'm', 'max'));
});
