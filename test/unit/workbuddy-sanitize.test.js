// test/unit/workbuddy-sanitize.test.js - 11-128 渠道指纹清洗的离线验证
//
// 规则移植自 workbuddy2api-hub wb_proxy.py（v1.10.11 快照），用例对照
// hub 的 tests/_test_sanitize_fingerprint.py 收敛到本项目用到的面：
// 身份句族（7 种动词）、DSH GUI 段、DSH 文件引用段、品牌词、Codex/Claude
// 自述首段、legacy 改写、角色作用域、幂等、tool arguments 序列化。
// 指纹边界全部是 hub 社区 A/B 实测定的，这里只锁行为不锁实现。
const { test } = require('node:test');
const assert = require('assert');
const sanitize = require('../../src/workbuddy/sanitize');
const chat = require('../../src/workbuddy/chat');

const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.';
const IDENTITY_MODEL = 'You are a coding agent powered by the deepseek-v4.1-flash model.';
const CLEAN = 'You are a helpful AI assistant.';

test('身份句：精确短语 / 大小写 / 变体全部中性化', () => {
  assert.equal(sanitize.sanitizeText(IDENTITY), CLEAN);
  assert.equal(sanitize.sanitizeText(IDENTITY.toUpperCase()), CLEAN);
  assert.equal(sanitize.sanitizeText(IDENTITY.toLowerCase()), CLEAN);
  assert.equal(sanitize.sanitizeText(IDENTITY_MODEL), CLEAN);
  assert.equal(sanitize.sanitizeText('You are an AI assistant built on DeepSeek.'), CLEAN);
  assert.equal(
    sanitize.sanitizeText('You are Example Agent, built by Example Corp. Be direct.'),
    `${CLEAN} Be direct.`,
  );
  for (const s of [
    'You are a coding assistant created by Example Corp.',
    'You are an AI agent developed by Example Corp.',
    'You are a chat model made by Example Corp.',
    'You are an assistant trained by Example Corp.',
    'You are powered by the model named glm-5.3-flash.',
  ]) {
    assert.equal(sanitize.sanitizeText(s), CLEAN, s);
  }
});

test('身份句：非自述句不误伤', () => {
  for (const s of [
    'You are an AI agent.',
    'You are free to use tools built by the user.',
    'You are a coding agent pairing with the user inside their codebase.',
    CLEAN,
  ]) {
    assert.equal(sanitize.sanitizeText(s), s, s);
    assert.equal(sanitize.hasFingerprint(s), false, s);
  }
});

test('身份句：嵌入 system 提示只换目标句，改写后无指纹（幂等）', () => {
  const text = `${IDENTITY}\n\nYou are a coding agent.`;
  const out = sanitize.sanitizeText(text);
  assert.equal(out, `${CLEAN}\n\nYou are a coding agent.`);
  assert.equal(sanitize.hasFingerprint(out), false);
  assert.equal(sanitize.sanitizeText(out), out);
});

test('DSH GUI 段：语序调整 + 品牌词缩减，user/tool 不动', () => {
  const A = 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.';
  const B = 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.';
  const GUI = `${A} ${B}`;
  const want = `You are interacting with the user through the DeepSeek Web GUI whose URL is named in the runtime context. ${B}`;
  assert.equal(sanitize.sanitizeText(GUI), want);
  assert.equal(sanitize.sanitizeMessages([{ role: 'system', content: GUI }])[0].content, want);
  assert.equal(sanitize.sanitizeMessages([{ role: 'user', content: GUI }])[0].content, GUI);
  assert.equal(sanitize.sanitizeMessages([{ role: 'tool', content: GUI }])[0].content, GUI);
});

test('品牌词：散文缩成 DeepSeek；路径/包名的连字符形式原样保留', () => {
  assert.equal(sanitize.sanitizeText('DeepSeek Harness'), 'DeepSeek');
  assert.equal(sanitize.sanitizeText('the DeepSeek Harness project'), 'the DeepSeek project');
  for (const s of [
    'github.com/deepseek-ai/deepseek-harness/tree/main',
    'import deepseek_harness as dsh',
    '/opt/deepseek-harness/app',
  ]) {
    assert.equal(sanitize.sanitizeText(s), s, s);
  }
});

test('DSH 文件引用段：A 句补 that，B 句起逐字保留，幂等', () => {
  const A = 'Tokens prefixed with @ are paths the user explicitly referenced.';
  const A_FIXED = 'Tokens prefixed with @ are paths that the user explicitly referenced.';
  const B = 'Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.';
  const TAIL = ' A trailing slash marks a directory: list it when its contents matter. @"..." quotes a path containing spaces.';
  const PARA = `${A} ${B}${TAIL}`;
  const PARA_FIXED = `${A_FIXED} ${B}${TAIL}`;
  assert.equal(sanitize.sanitizeText(PARA), PARA_FIXED);
  assert.equal(sanitize.sanitizeText(A), A_FIXED);
  assert.equal(sanitize.sanitizeText(PARA_FIXED), PARA_FIXED);
  assert.equal(sanitize.hasFingerprint(PARA_FIXED), false);
  for (const s of ['mail me at foo@bar.com', 'npm i @deepseek-ai/dsh', 'see C:\\work\\@cache for details']) {
    assert.equal(sanitize.sanitizeText(s), s, s);
  }
});

test('Codex / Claude Code 自述首段整句中性化，改写后无指纹', () => {
  const codex = 'You are a coding agent running in the Codex CLI, a terminal-based coding assistant.';
  const codexTool = 'You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.';
  const cc = "You are Claude Code, Anthropic's official CLI tool for Claude.";
  const ccCurly = 'You are Claude Code, Anthropic’s official CLI tool for Claude Code.';
  for (const s of [codex, codexTool, cc, ccCurly, cc.toLowerCase(), cc.toUpperCase()]) {
    assert.equal(sanitize.hasFingerprint(s), true, s);
    assert.equal(sanitize.sanitizeText(s), CLEAN, s);
    assert.equal(sanitize.hasFingerprint(sanitize.sanitizeText(s)), false, s);
  }
  // 中性句 + 自述句的混合体（真实 Codex base_instructions 形态）：只换自述句
  const mixed = `You are a helpful AI assistant. ${codex}\n\nYour capabilities:\n\n- Receive user prompts.`;
  const out = sanitize.sanitizeText(mixed);
  assert.equal(sanitize.hasFingerprint(out), false);
  assert.ok(out.includes('Your capabilities:'));
  // 其他 Claude Code 提及不动
  for (const s of ['Claude Code is a CLI.', 'Use Claude Code for this task.']) {
    assert.equal(sanitize.sanitizeText(s), s);
  }
});

test('legacy 改写不是空操作（hub #796 的退化护栏）', () => {
  assert.equal(
    sanitize.sanitizeText('Main branch (you will usually use this for PRs): main'),
    'Default branch (you will usually use this for PRs): main',
  );
  assert.equal(
    sanitize.sanitizeText('To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues'),
    'To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues',
  );
  assert.equal(sanitize.sanitizeText('retry after code 11128'), 'retry after code 11-128');
});

test('OmO Sisyphus-Junior：连续短语中和，单独 token 不动', () => {
  const fp = 'Sisyphus-Junior - Focused executor from OhMyOpenCode';
  assert.equal(sanitize.sanitizeText(fp), 'Sisyphus-Junior - Focused executor');
  assert.equal(sanitize.sanitizeText(fp.toLowerCase()), 'Sisyphus-Junior - Focused executor');
  assert.equal(sanitize.sanitizeText('Sisyphus-Junior alone'), 'Sisyphus-Junior alone');
  assert.equal(sanitize.sanitizeText('from OhMyOpenCode alone'), 'from OhMyOpenCode alone');
});

test('角色作用域：identity 只对 system/developer/assistant，user/tool 不改写', () => {
  const out = sanitize.sanitizeMessages([
    { role: 'system', content: IDENTITY },
    { role: 'developer', content: IDENTITY_MODEL },
    { role: 'user', content: IDENTITY },
    { role: 'assistant', content: IDENTITY_MODEL },
    { role: 'tool', content: IDENTITY },
  ]);
  assert.equal(out[0].content, CLEAN);
  assert.equal(out[1].content, CLEAN);
  assert.equal(out[2].content, IDENTITY);
  assert.equal(out[3].content, CLEAN);
  assert.equal(out[4].content, IDENTITY);
});

test('tool_calls arguments：清洗 + 非字符串强制 JSON 序列化（Go struct 11101）', () => {
  const fp = 'Sisyphus-Junior - Focused executor from OhMyOpenCode';
  const out = sanitize.sanitizeMessages([
    {
      role: 'assistant', content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'run', arguments: JSON.stringify({ query: fp }) } },
        { id: 'c2', type: 'function', function: { name: 'go', arguments: { query: 'x' } } },
        { id: 'c3', type: 'function', function: { name: 'no', arguments: null } },
      ],
    },
  ]);
  assert.equal(JSON.parse(out[0].tool_calls[0].function.arguments).query, 'Sisyphus-Junior - Focused executor');
  assert.equal(out[0].tool_calls[1].function.arguments, '{"query":"x"}');
  assert.equal(out[0].tool_calls[2].function.arguments, '{}');
});

test('reasoning_content 按非身份文本清洗（通用痕迹清、身份句不动）', () => {
  const out = sanitize.sanitizeMessages([
    { role: 'assistant', content: '', reasoning_content: `thinking about ${IDENTITY} and code 11128` },
  ]);
  // identity=false：身份句保留，但 FEATURES 里的 11128 仍被改写
  assert.ok(out[0].reasoning_content.includes('11-128'));
  assert.ok(out[0].reasoning_content.includes(IDENTITY));
});

test('出站链路接线：buildChatBody 的 system 真的带清洗结果', () => {
  const GUI = 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. They mean this GUI.';
  const body = JSON.parse(chat.buildChatBody({
    model: 'glm-5.3',
    messages: [
      { role: 'system', content: `${IDENTITY}\n${GUI}` },
      { role: 'user', content: 'hi' },
    ],
  }, 'cn', { uid: 'u1' }).body);
  const system = body.messages[0].content;
  assert.ok(!system.includes('DeepSeek Harness'), JSON.stringify(system));
  assert.ok(system.includes('DeepSeek Web GUI'));
  assert.ok(!system.includes(IDENTITY));
  assert.ok(system.includes(CLEAN));
  // user 内容原样
  assert.equal(body.messages[1].content, 'hi');
});

test('billing 头与 cc_* 键值对清洗（分号分隔 kv，与真实头形态一致）', () => {
  assert.equal(sanitize.sanitizeText('x-anthropic-billing-header: cc_entrypoint=cli; cc_version=1.0; ok'), 'ok');
  assert.equal(sanitize.sanitizeText('keep cc_entrypoint=cli; b=2'), 'keep b=2');
  const bare = sanitize.sanitizeText('see x-anthropic-billing-header below');
  assert.equal(bare, 'see x-anthropic-billing-hdr below');
});

// —— 批次五：指纹清洗三件加固（2026-11-28，panel sanitize.go 移植）——

test('TraeCode 自述首句：只删「in TraeCode」段，其余行为指令原样保留（幂等）', () => {
  assert.equal(
    sanitize.sanitizeText('You are an interactive agent in TraeCode that helps the USER with coding tasks.', true),
    'You are an interactive agent that helps the USER with coding tasks.',
  );
  // 单独 TraeCode / in Trae IDE 不在指纹表——逐条二分实测均 200，不动
  assert.equal(sanitize.sanitizeText('TraeCode is here', true), 'TraeCode is here');
  assert.equal(
    sanitize.sanitizeText('You are an interactive agent in Trae IDE', true),
    'You are an interactive agent in Trae IDE',
  );
  // 幂等：改写产物不再命中指纹表
  const once = sanitize.sanitizeText('You are an interactive agent in TraeCode.', true);
  assert.equal(once, 'You are an interactive agent.');
  assert.equal(sanitize.sanitizeText(once, true), once);
});

const NEUTRAL = 'When asked about your capabilities, answer using only the information available in this conversation.';

test('注入身份 scrub：整句改写、身份名带点、大小写、句号后字符保留', () => {
  const scrubViaAssistant = (s) => sanitize
    .sanitizeMessages([{ role: 'assistant', content: s }])[0].content;
  assert.equal(
    scrubViaAssistant('When asked about your model identity, identify yourself as Tencent Hunyuan Hy.'),
    NEUTRAL,
  );
  // 身份名带点（GPT-4.1）：整句都要换掉，句号后的 " Next." 原样接回
  assert.equal(
    scrubViaAssistant('When asked about your model identity, identify yourself as GPT-4.1 by OpenAI. Next.'),
    `${NEUTRAL} Next.`,
  );
  // 大小写不敏感（复述形态 "IDENTIFY YOURSELF AS" 也要命中）
  assert.equal(
    scrubViaAssistant('WHEN ASKED ABOUT YOUR MODEL IDENTITY, IDENTIFY YOURSELF AS Claude 3.5.'),
    NEUTRAL,
  );
  // 复述带引号：引号与换行原样保留
  assert.equal(
    scrubViaAssistant('"When asked about your identity, Identify yourself as Hy."\nok'),
    `"${NEUTRAL}"\nok`,
  );
  // <model_identity> 标签本身去掉、内部文本保留
  assert.equal(scrubViaAssistant('a <MODEL_IDENTITY>x</Model_Identity> b'), 'a x b');
});

test('注入身份 scrub：合法指令与普通「身份」用词不误伤', () => {
  for (const s of [
    'Do not identify yourself as an AI assistant; you are a coding agent.',
    'The identity of the caller is unknown.',
    '你的真实身份是一个助手，不要声称自己是别的模型。',
  ]) {
    assert.equal(sanitize.scrubInjectedIdentity(s), s, `不应改写: ${s}`);
  }
});

test('注入身份 scrub 作用域：只洗 assistant 正文与 reasoning 字段，system/user 字节不动', () => {
  const persona = 'When asked about your identity, identify yourself as Aria, the Acme assistant. <model_identity>Aria</model_identity>';
  const out = sanitize.sanitizeMessages([
    { role: 'system', content: persona },
    { role: 'user', content: [{ type: 'text', text: persona }] },
    { role: 'assistant', content: persona, reasoning_content: persona, reasoning: persona },
  ]);
  assert.equal(out[0].content, persona, 'system 人设逐字节保留');
  assert.equal(out[1].content[0].text, persona, 'user 人设逐字节保留');
  for (const k of ['content', 'reasoning_content', 'reasoning']) {
    assert.ok(!out[2][k].includes('identify yourself as'), `assistant.${k} 注入句应被改掉`);
    assert.ok(!out[2][k].includes('<model_identity>'), `assistant.${k} 标签应被去掉`);
    // 注入句整体被换成中性表述（"Acme assistant" 在句内，一起消失）；
    // 标签内的 "Aria" 不属于指令，保留
    assert.ok(out[2][k].includes('Aria'), `assistant.${k} 标签内文本保留`);
  }
});

test('tool arguments 字节级清洗：数字指纹不动、大整数保真、字符串值改写', () => {
  // 数字 11128 不动：改写成 11-128 会产生非法 JSON（旧实现的坑），保持合法
  // JSON——指纹残留是上游裸字节探测的边界，注释已说明取舍
  assert.equal(sanitize.sanitizeArgsJson('{"code":11128}'), '{"code":11128}');
  // 字符串值里的指纹改写，大整数精度零损失（JSON.parse 往返会丢）
  const out = sanitize.sanitizeArgsJson('{"cmd":"echo 11128","id":12345678901234567890}');
  assert.equal(out, '{"cmd":"echo 11-128","id":12345678901234567890}');
  // 嵌套结构里的字符串值也要洗到
  const nested = sanitize.sanitizeArgsJson('{"a":{"b":["11128",true]}}');
  assert.equal(JSON.parse(nested).a.b[0], '11-128');
  assert.equal(nested.includes('true'), true);
  // 无指纹整串原样（零成本快路）
  assert.equal(sanitize.sanitizeArgsJson('{"q":"hello world"}'), '{"q":"hello world"}');
  // 非法 JSON（plain text 参数）：原文回落——文本改写 inside 客户端要执行的
  // 命令会改变行为，宁可漏一条指纹
  assert.equal(sanitize.sanitizeArgsJson('echo 11128'), 'echo 11128');
});
