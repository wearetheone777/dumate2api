// src/workbuddy/sanitize.js - 11-128 渠道指纹清洗
//
// 上游按 system / assistant 里的**连续文本指纹**判非官方客户端，命中即
// 400 / code 11128（"Illegal API invocation from an unapproved channel"）。
// 本项目整个跑在 DeepSeek Harness 生态里——Codex / Claude Code 会话的
// system prompt 必然带这些串，原样转发就是必撞。
//
// 全套规则与措辞移植自 workbuddy2api-hub 的 wb_proxy.py（v1.10.11 快照，
// %TEMP%\fusion-refs\wb-hub-latest），指纹边界都是社区 A/B 实测定的，不猜：
//   - 身份句「You are … powered by / built by / …」整句中性化（#533/#537/#539，
//     动词表覆盖 7 种搭配，名词可省略，0~3 个修饰词——#574）
//   - DSH GUI 描述段：只调 A 句尾语序（#579）+ 品牌词缩成 DeepSeek（#574）
//   - DSH 文件引用段（@deepseek-ai/dsh-file-reference 的 FILE_REFERENCE_PROMPT）：
//     A 句补一个 that 打断整段连续匹配（#684，实测整段 5 句连排稳定 400）
//   - Codex / Claude Code 自述首段整句中性化（#743 / #733——改写式清洗曾把
//     指纹注入出站 body，替换式才干净）
//   - assistant 历史同样命中（同一句放 user 200、放 assistant 400，#574）；
//     user / tool 是用户数据不改写（#537）
//
// 每条改写都保持语义等价与幂等；改的是措辞，不是内容。

// ---- 快速指纹表（大小写敏感的连续子串）----
const FEATURES = [
  'x-anthropic-billing-header',
  'cc_entrypoint=',
  'You are Claude Code',
  'Main branch (',
  'You are a coding agent running in the Codex CLI',
  'You are an interactive agent in TraeCode',
  'github.com/anthropics/',
  '11128',
];

// ---- 确定性改写（v1.10.5 曾把前两条退化成空操作，#796 加了回归护栏）----
const REWRITES = [
  ['Main branch (you will usually use this for PRs)',
    'Default branch (you will usually use this for PRs)'],
  ['To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues',
    'To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues'],
  // TraeCode 自述首句（2026-11-24 hub 本机 CN 号池实测）：上游按「interactive agent
  // in TraeCode」这一连续短语判非官方渠道，命中即 400 11-128。逐条二分：单独
  // TraeCode / in Trae IDE / in Cursor 均 200；只删掉 in TraeCode 后真实 23KB
  // system 整体 200。故只删这一段，句子其余部分与行为指令原样保留
  ['You are an interactive agent in TraeCode',
    'You are an interactive agent'],
  ['11128', '11-128'],
];

const IDENTITY_REPLACEMENT = 'You are a helpful AI assistant.';

// Codex 自述首段（#743）：整句中性化，改写后不再命中 hasFingerprint
const CODEX_INTRO_RE = /You are a coding agent running in the Codex CLI(?: tool)?[^.\n]*\./gi;
// Claude Code 自述首段（#733）：只锚定这一句，其余 Claude Code 提示词原样保留
const CLAUDE_CODE_INTRO_RE = /You are Claude Code,\s*Anthropic['’]s official CLI(?: tool)? for Claude(?: Code)?\.?/gi;
const CLAUDE_CODE_LOWER = 'you are claude code,';

// billing 头与 cc_* 键值对（Anthropic 转换链路漏进消息文本的客户端痕迹）
const HDR_RE = /x-anthropic-billing-header:[^;\r\n]*;?\s*/gi;
const BARE_HDR_RE = /x-anthropic-billing-header/gi;
const KV_RE = /\bcc_[a-z0-9_]+=[^;\r\n]*;?\s*/gi;

// OmO Sisyphus-Junior 指纹：只中和确认的连续短语，单独 token 上游接受
const OMO_JUNIOR_RE = /Sisyphus-Junior - Focused executor from OhMyOpenCode/gi;
const OMO_JUNIOR_LOWER = 'sisyphus-junior - focused executor from ohmyopencode';

// 身份句：动词表 7 种（hub #574——上游补一条规则就能让漏网变体重新 400，
// 所以在同一判据里补全；名词可省略，冠词后允许 0~3 个修饰词，逗号可有可无。
// 窗口有界：分词修饰宾语的句子（"tools built by …"）不误伤）
const IDENTITY_VERBS = [
  'powered by', 'built on', 'built by', 'created by',
  'developed by', 'made by', 'trained by',
];
const IDENTITY_RE = new RegExp(
  'You are\\s+'
  + '(?:an?\\s+|the\\s+)?(?:[\\w.-]+\\s+){0,3}?'
  + '(?:agent|assistant|model|AI|LLM)?[\\s,]*'
  + '(?:powered by|built on|built by|created by|developed by|made by|trained by)'
  + '[^\\n]*?(?:\\.(?=\\s|$)|(?=\\n|$))',
  'gi');

// DSH GUI 描述段（#570/#579/#574）：A 句 + B 句连续出现即命中 11-128。
// 只把 A 句尾语序换一下，品牌词留给最后一条规则缩——GUI 规则还认全名，先让它匹配原文
const DSH_GUI_RE = /(You are interacting with the user through the DeepSeek[ \t]+Harness[ \t]+Web[ \t]+GUI) whose URL the runtime context names\./gi;
const DSH_GUI_REPLACEMENT = '$1 whose URL is named in the runtime context.';
const DSH_GUI_LOWER = 'whose url the runtime context names';

// DSH 文件引用段（#684）：FILE_REFERENCE_PROMPT 整段是匹配单位，只补一个
// that；负向前瞻保证幂等。A 句单独出现时改写同样安全（DSH 换掉后半段措辞不失效）
const DSH_FILEREF_RE = /(Tokens prefixed with @ are paths )(?!that )(the user explicitly referenced\.)/gi;
const DSH_FILEREF_REPLACEMENT = '$1that $2';
const DSH_FILEREF_LOWER = 'are paths the user explicitly referenced';

// 品牌词缩减（#574）：只匹配散文里的空格/制表符形式。连字符/下划线形式
// （deepseek-harness、/opt/deepseek-harness/app）是路径与标识符，保持原样
const BRAND_RE = /DeepSeek[ \t]+Harness/gi;
const BRAND_REPLACEMENT = 'DeepSeek';
const BRAND_LOWER = 'harness';

// (?i) 与 toLowerCase() 的三处 Unicode 差异（İ/ı/ſ），hub 用翻译表对齐；
// 常规文本不含这三个字符，先做廉价探测，命中才走归一化副本
const FOLD_RE = /[\u0130\u0131\u017f]/;

function lowerFold(text) {
  if (!FOLD_RE.test(text)) return text.toLowerCase();
  return text.replace(/İ/g, 'i').replace(/ı/g, 'i').replace(/ſ/g, 's').toLowerCase();
}

// /g 正则的 test() 会推进 lastIndex——同一正则既做探测又做替换时，
// 探测必须保存/恢复状态，否则下一次调用从残留位置起匹配会漏判
function reTest(re, text) {
  const saved = re.lastIndex;
  re.lastIndex = 0;
  const ok = re.test(text);
  re.lastIndex = saved;
  return ok;
}

/**
 * 文本是否带已确认的渠道指纹。identity=false 时只看与角色无关的通用痕迹
 * （billing 头 / OmO / FEATURES），身份句族不参与——user/tool 内容不做身份改写。
 */
function hasFingerprint(text, identity = true) {
  if (typeof text !== 'string' || !text) return false;
  for (const f of FEATURES) {
    if (text.includes(f)) return true;
  }
  const low = lowerFold(text);
  if (low.includes('x-anthropic-billing-header') || low.includes(OMO_JUNIOR_LOWER)) return true;
  if (!identity) return false;
  if (low.includes(CLAUDE_CODE_LOWER)) return true;
  // 品牌词 / GUI 段 / 文件引用段：廉价字面量前置筛，命中才走正则
  if (low.includes(BRAND_LOWER) && reTest(BRAND_RE, text)) return true;
  if (low.includes(DSH_GUI_LOWER) && reTest(DSH_GUI_RE, text)) return true;
  if (low.includes(DSH_FILEREF_LOWER) && reTest(DSH_FILEREF_RE, text)) return true;
  if (!IDENTITY_VERBS.some((v) => low.includes(v))) return false;
  return reTest(IDENTITY_RE, text);
}

/** 单段文本清洗。无指纹时原串返回（零开销），有指纹才逐条改写 */
function sanitizeText(text, identity = true) {
  if (typeof text !== 'string' || !text) return text;
  if (!hasFingerprint(text, identity)) return text;
  text = text.replace(OMO_JUNIOR_RE, 'Sisyphus-Junior - Focused executor');
  if (identity) {
    // Claude Code / Codex 自述首段先整句换掉：它们本身就是 FEATURES 里的指纹
    text = text.replace(CLAUDE_CODE_INTRO_RE, IDENTITY_REPLACEMENT);
    text = text.replace(CODEX_INTRO_RE, IDENTITY_REPLACEMENT);
    text = text.replace(IDENTITY_RE, IDENTITY_REPLACEMENT);
    text = text.replace(DSH_GUI_RE, DSH_GUI_REPLACEMENT);
    text = text.replace(DSH_FILEREF_RE, DSH_FILEREF_REPLACEMENT);
    // 品牌词缩减放最后：GUI 规则还认全名
    text = text.replace(BRAND_RE, BRAND_REPLACEMENT);
  }
  for (const [oldStr, newStr] of REWRITES) text = text.split(oldStr).join(newStr);
  text = text.replace(HDR_RE, '');
  if (text.includes('cc_')) {
    let prev = '';
    while (prev !== text) {
      prev = text;
      text = text.replace(KV_RE, '');
    }
  }
  text = text.replace(BARE_HDR_RE, 'x-anthropic-billing-hdr');
  return text.trim();
}

// —— 注入身份滚雪球 scrub（批次五 ②，panel sanitize.go issue #187 移植）——
//
// 上游在服务端拼进模型上下文的身份指令（2.73MB dump 逐字取证）：
//   When asked about your model identity, identify yourself as Tencent Hunyuan Hy.
// 它不出现在出站 body 里（dump 看不到），但模型会在 reasoning_content 里复述原文，
// 客户端把这段思维链带回历史，下一轮就原样进出站——「声明 → 进历史 → 再看到 →
// 再声明」的滚雪球。匹配刻意收紧到整句：单独 identify yourself as 会误伤正常指令
// （"Do not identify yourself as an AI." 是合法要求），整句前缀在真实语料里几乎
// 不会自然出现。句尾「后面不接字母数字的句号」：身份名可以带点（GPT-4.1），
// 遇第一个点就收会留半句；句号后那个字符用捕获组原样接回（引号、换行不能吞）。
const INJECTED_IDENTITY_RE = /when asked about your[^.\n]{0,60}?identity[^.\n]{0,60}?,\s*identify yourself as\s+[^\n]{1,80}?\.(\W|$)/gi;
const INJECTED_IDENTITY_REPLACEMENT = 'When asked about your capabilities, answer using only the information available in this conversation.$1';
// 两个探针（门控与正则同样大小写不敏感）：门控若按原文大小写比对，
// "Identify yourself as" 这类复述就会在门口被放过
const INJECTED_PROBE_LOWER = 'identify yourself as';
// <model_identity> 包裹本身去掉（保留内部文本）：真正的危害是标签里那句指令
// （上面那条负责改掉），标签留着会让模型继续把它当「有个身份块」反复提起
const MODEL_IDENTITY_TAG_RE = /<\/?model_identity>/gi;
const MODEL_IDENTITY_TAG_PROBE_LOWER = 'model_identity';

/** 改掉回流历史里的注入身份指令与 <model_identity> 标签。只对滚雪球的载体调用
 * （assistant 正文、reasoning_content / reasoning——见 sanitizeMessages）；
 * system / user 里同形的句子是用户自己写的人设，改写它等于篡改用户提示词。
 * 不命中时原样返回、不 TrimSpace。 */
function scrubInjectedIdentity(text) {
  if (typeof text !== 'string' || !text) return text;
  const low = lowerFold(text);
  if (!low.includes(INJECTED_PROBE_LOWER) && !low.includes(MODEL_IDENTITY_TAG_PROBE_LOWER)) {
    return text;
  }
  let out = text;
  if (low.includes(INJECTED_PROBE_LOWER)) {
    out = out.replace(INJECTED_IDENTITY_RE, INJECTED_IDENTITY_REPLACEMENT);
  }
  if (low.includes(MODEL_IDENTITY_TAG_PROBE_LOWER)) {
    out = out.replace(MODEL_IDENTITY_TAG_RE, '');
  }
  return out;
}

/** content 形态三种：字符串 / 分段数组（只清 type:'text' 的 text 段）/ 其他原样。
 * @param {boolean} scrubAfter 清洗后再过一遍注入身份 scrub（只给回流载体用：
 *   assistant 正文——见 sanitizeMessages）。system / user / tool 不 scrub。 */
function sanitizeContent(content, identity = true, scrubAfter = false) {
  const f = scrubAfter
    ? (s) => scrubInjectedIdentity(sanitizeText(s, identity))
    : (s) => sanitizeText(s, identity);
  if (typeof content === 'string') return f(content);
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part && typeof part === 'object' && part.type === 'text' && 'text' in part) {
        return { ...part, text: f(part.text) };
      }
      return part;
    });
  }
  return content;
}

// —— tool_calls.arguments 的指纹清洗（批次五 ③）——
//
// arguments 是**字符串化的 JSON**（不是对象）。旧实现对整串跑文本替换，两个坑：
//   1. 数字撞上改写规则 → 非法 JSON：`{"code":11128}` 被 11128→11-128 规则改成
//      `{"code":11-128}`，上游 JSON 解码失败 11129 bad params——比指纹本身更糟；
//   2. JSON.parse 往返会把大整数转 float64 丢精度（工具参数里的 64 位 id 很常见）。
//
// 修法（panel 参考之上再进一步——参考实现仍是整串文本替换，两个坑都在）：
// **字节级**只重写「发生了变化的字符串值」的字面量，其余字节（数字、键序、转义
// 形态）原样。快路：整串无指纹 → 原样（零成本）。解析失败 / 扫描失败 / 自证失败
// 一律**原文回落**——宁可漏一条指纹，也不把客户端要执行的参数改坏（arguments 会被
// 客户端执行，文本改写 inside 命令/路径会改变行为）。
const { collectStringSpans } = require('./jsonscan');

function sanitizeArgsJson(raw) {
  if (!hasFingerprint(raw, false)) return raw;
  try { JSON.parse(raw); } catch (e) { return raw; } // 非法 JSON：原文回落
  const spans = [];
  if (collectStringSpans(raw, 0, spans) !== raw.length) return raw; // 覆盖不全：原文回落
  const edits = [];
  for (const [s, e] of spans) {
    let val;
    try { val = JSON.parse(raw.slice(s, e)); } catch (err) { return raw; }
    const clean = sanitizeText(val, false);
    if (clean !== val) edits.push({ s, e, repl: JSON.stringify(clean) });
  }
  if (!edits.length) return raw;
  let b = '';
  let prev = 0;
  for (const ed of edits) {
    b += raw.slice(prev, ed.s) + ed.repl;
    prev = ed.e;
  }
  b += raw.slice(prev);
  try { JSON.parse(b); } catch (e) { return raw; } // 自证：产物必须仍是合法 JSON
  return b;
}

/** tool_calls：arguments 是序列化后的应用数据不是客户端指纹（identity=false）；
 *  非字符串必须转 JSON 串——上游 Go struct 对 dict 报 11101（hub #446） */
function sanitizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return toolCalls;
  const preserve = process.env.DUMATE_WORKBUDDY_PRESERVE_CONTRACT === '1';
  return toolCalls.map((tc) => {
    if (!tc || typeof tc !== 'object') return tc;
    const item = { ...tc };
    if (item.function && typeof item.function === 'object') {
      const fn = { ...item.function };
      const raw = fn.arguments;
      if (typeof raw === 'string') {
        if (!preserve) fn.arguments = sanitizeArgsJson(raw);
      } else if (raw == null) {
        fn.arguments = '{}';
      } else {
        let s;
        try { s = JSON.stringify(raw); } catch (e) { s = String(raw); }
        fn.arguments = preserve ? s : sanitizeArgsJson(s);
      }
      item.function = fn;
    }
    return item;
  });
}

/**
 * 消息级清洗。身份句作用域 = system / developer / assistant（#574：assistant
 * 历史里的同一句稳定 400）；user / tool 是用户数据，只清与角色无关的通用痕迹。
 * 保留契约开关（DUMATE_WORKBUDDY_PRESERVE_CONTRACT=1）跳过 tool/function
 * 内容的文本改写——与 hub 的 WB_PRESERVE_REQUEST_CONTRACT 同语义，默认关。
 */
function sanitizeMessages(messages) {
  const preserve = process.env.DUMATE_WORKBUDDY_PRESERVE_CONTRACT === '1';
  return (messages || []).map((m) => {
    if (!m || typeof m !== 'object') return m;
    const item = { ...m };
    const preserveToolResult = preserve && (item.role === 'tool' || item.role === 'function');
    const identity = item.role === 'system' || item.role === 'developer' || item.role === 'assistant';
    // 滚雪球载体（批次五 ②）：assistant 正文与 reasoning_content / reasoning——
    // 上游注入的身份指令经模型复述回流进出站。system / user 同形句是用户人设，
    // 不 scrub（作用域测试锁字节不动）
    const isAssistant = item.role === 'assistant';
    if ('content' in item && !preserveToolResult) {
      item.content = sanitizeContent(item.content, identity, isAssistant);
    }
    if (typeof item.reasoning_content === 'string') {
      item.reasoning_content = scrubInjectedIdentity(sanitizeText(item.reasoning_content, false));
    }
    if (typeof item.reasoning === 'string') {
      item.reasoning = scrubInjectedIdentity(sanitizeText(item.reasoning, false));
    }
    if ('tool_calls' in item) item.tool_calls = sanitizeToolCalls(item.tool_calls);
    return item;
  });
}

/**
 * 顶层 `tools[]` 数组的清洗（2026-11-08 融合批）。
 *
 * 出处：GitHub 生态调研（YehanKD/workbuddy2api 的 WAF 净化覆盖 `tools[]`
 * 数组与 `tool_calls.arguments`）。本仓库原来只清 `messages[]`，
 * **顶层工具定义完全没清**——而工具名/描述/参数 schema 里的品牌指纹与
 * 提示词痕迹和 system 里的一样会被渠道校验看到。
 *
 * 三个必须注意的点：
 *   1. **不能改 `function.name`**：客户端会用这个名字回传 tool_call，改了对不上，
 *      工具调用直接失败（这是「保留契约」的核心，不是保守）；
 *   2. `parameters`（JSON Schema）里只有 `description` 是自然语言，**键名与类型
 *      不能动**——改 schema 结构等于让模型的参数生成失效；
 *   3. `description` 走 **identity=true** 的清洗（`identity=false` 会跳过
 *      `IDENTITY_RE`，而「powered by …」这类品牌句正是它在管——第一版写 false，
 *      被单测当场抓到：整个清洗对 tool description 完全无效）。
 *
 * @param {Array} tools OpenAI 形状的 tools 数组
 * @returns {Array} 清洗后的新数组（不改入参）
 */
function sanitizeTools(tools) {
  if (!Array.isArray(tools)) return tools;
  const preserve = process.env.DUMATE_WORKBUDDY_PRESERVE_CONTRACT === '1';
  if (preserve) return tools;
  return tools.map((t) => {
    if (!t || typeof t !== 'object') return t;
    const item = { ...t };
    const fn = item.function && typeof item.function === 'object' ? { ...item.function } : null;
    if (!fn) return item;
    // name / strict / 其它字段原样：改名会让 tool_call 回传对不上
    if (typeof fn.description === 'string') {
      fn.description = sanitizeText(fn.description, true);
    }
    if (fn.parameters && typeof fn.parameters === 'object') {
      fn.parameters = sanitizeSchemaDescriptions(fn.parameters);
    }
    item.function = fn;
    return item;
  });
}

/**
 * 递归清洗 JSON Schema 里的 `description` 字段。
 * **只动 description**：键名、type、required、enum、$ref 等一律原样——
 * 动结构会让模型生成不出合法参数（比留下指纹更糟）。
 * @param {object} schema
 * @param {number} depth 递归深度保护（schema 可能很深，也可能有循环引用）
 */
function sanitizeSchemaDescriptions(schema, depth = 0) {
  if (depth > 12 || !schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) {
    return schema.map((x) => sanitizeSchemaDescriptions(x, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'description' && typeof v === 'string') {
      // 同上：必须走 identity=true，否则品牌句（IDENTITY_RE 管的那些）原样漏出去
      out[k] = sanitizeText(v, true);
    } else if (v && typeof v === 'object') {
      out[k] = sanitizeSchemaDescriptions(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// —— Kimi $ref 内联展开（批次五，panel kimi_tools.go 移植）——
//
// CN Kimi 不接受 parameters 里的 $ref/#/$defs（实测 400 11129 invalid_function_call_
// parameters）。出站前把本地 $ref 展开成内联定义；**只做展开不裁剪工具**——按工具名
// 前缀裁剪是把某个部署的绕行手段写进共享路径，其它用户的 MCP 工具会静默消失。
//
// 与 description 清洗完全独立（分开开关）；门控（cn + kimi 前缀）在 buildChatBody，
// 非 kimi 模型零解析零改动。无 $ref 的 schema 若也没有 $defs/$schema，原引用返回
// （普通请求零影响）；budget/depth 双保护对抗性 schema，耗尽整体放弃回落原 tools
// （参考同口径）。
function inlineKimiRefs(node, defs, seen, depth, budget) {
  if (budget.n <= 0) return null;
  budget.n--;
  if (depth > 64) return {}; // 循环/对抗 schema 的栈保护
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((x) => {
      if (budget.n <= 0) return x;
      const y = inlineKimiRefs(x, defs, seen, depth + 1, budget);
      if (y === null) return x;
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : node;
  }
  if (node && typeof node === 'object') {
    const ref = typeof node.$ref === 'string' ? node.$ref : null;
    if (ref && ref.startsWith('#/$defs/')) {
      // JSON Pointer 转义还原：~1 → /、~0 → ~（RFC 6901）
      const name = ref.slice(8).replace(/~1/g, '/').replace(/~0/g, '~');
      if (seen.has(name)) return {}; // 循环引用不可内联，空 schema 兜底
      const target = defs && Object.prototype.hasOwnProperty.call(defs, name)
        ? defs[name] : undefined;
      if (target === undefined) return { type: 'object' };
      const next = new Set(seen);
      next.add(name);
      return inlineKimiRefs(target, defs, next, depth + 1, budget);
    }
    let changed = false;
    const out = {};
    for (const [k, x] of Object.entries(node)) {
      if (k === '$defs' || k === '$schema') { changed = true; continue; }
      if (budget.n <= 0) { out[k] = x; continue; }
      const y = inlineKimiRefs(x, defs, seen, depth + 1, budget);
      if (y === null) { out[k] = x; continue; }
      if (y !== x) changed = true;
      out[k] = y;
    }
    return changed ? out : node;
  }
  return node;
}

/**
 * tools[] 的 Kimi $ref 展开（入口，门控由调用方做）。非 function 工具保形；
 * 无参数 / 参数非对象的工具原样；无改动时返回原数组引用（零分配路径）。
 */
function kimiInlineTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return tools;
  const budget = { n: 10000 };
  const out = [];
  let changed = false;
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) { out.push(tool); continue; }
    const fn = (tool.function && typeof tool.function === 'object' && !Array.isArray(tool.function))
      ? tool.function : null;
    if (!fn) { out.push(tool); continue; } // 非 function 工具保形，不改协议
    const params = fn.parameters;
    if (!params || typeof params !== 'object' || Array.isArray(params)) { out.push(tool); continue; }
    const defs = (params.$defs && typeof params.$defs === 'object' && !Array.isArray(params.$defs))
      ? params.$defs : null;
    const expanded = inlineKimiRefs(params, defs, new Set(), 0, budget);
    if (expanded === null || budget.n <= 0) return tools; // 预算耗尽：整体放弃（参考同口径）
    if (expanded !== params) {
      out.push({ ...tool, function: { ...fn, parameters: expanded } });
      changed = true;
    } else {
      out.push(tool);
    }
  }
  return changed ? out : tools;
}

module.exports = {
  hasFingerprint, sanitizeText, sanitizeContent, sanitizeToolCalls, sanitizeMessages,
  sanitizeTools, sanitizeSchemaDescriptions, scrubInjectedIdentity, sanitizeArgsJson,
  kimiInlineTools,
  FEATURES, REWRITES, IDENTITY_RE,
};
