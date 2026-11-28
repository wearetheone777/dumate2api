// 探针：直接打 Qoder 上游，dump 原始 SSE 帧（不经网关翻译层）
// 目的：定位「首帧到达后 5ms 流就结束」的根因
const authStore = require('../src/qoder/auth');
const session = require('../src/qoder/session');
const chat = require('../src/qoder/chat');
const cosy = require('../src/qoder/cosy');
const c = require('../src/qoder/constants');

const MODEL = process.argv[2] || 'kmodel_latest';
const BIG = process.argv.includes('--big');
const TOOLS = process.argv.includes('--tools');

async function main() {
  const account = authStore.preferred();
  if (!account) throw new Error('无可用账号');
  const auth = await session.ensureAccount(authStore, account);
  const region = c.normalizeRegion(auth.region);
  const ep = c.endpointsOf(region);

  const messages = [];
  // 模拟 Codex：developer 指令 + 大段历史 + 用户「继续」
  let hist = '';
  if (BIG) {
    for (let i = 0; i < 200; i++) {
      hist += `## 第 ${i} 章\n` + '这是一段用于填充上下文的正文内容，用来模拟长会话历史。'.repeat(6) + '\n\n';
    }
  }
  messages.push({ role: 'system', content: 'You are Codex, a coding agent.\n' + hist });
  messages.push({ role: 'user', content: '继续' });

  const tools = TOOLS ? [
    { type: 'function', function: { name: 'exec_command', description: 'Run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } },
    { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  ] : [];

  const payload = { model: MODEL, messages, tools, max_tokens: 16384 };
  const modelKey = chat.resolveModelKey(MODEL);
  // 身份句守卫对照（P0-1 真机 A/B）：``--guard`` 走与真实链路**同一段**
  // `identity-guard.guardBody`（`qoder/index.js` 的挂点），不另写一份逻辑。
  // 不带该参数 = 原样出站，两组唯一变量就是守卫本身。
  // 旧版探针只调 chat.buildBody，绕过了挂点，所以 2026-11-28 那轮 A/B 无效。
  if (process.argv.includes('--guard')) {
    const g = require('../src/qoder/identity-guard');
    // guardBody 原地改 body，没有返回值 —— 自己比对 system 文本算命中证据
    const before = String(payload.messages[0] && payload.messages[0].content || '');
    g.guardBody(payload);
    const after = String(payload.messages[0] && payload.messages[0].content || '');
    const changed = before !== after;
    console.log(`[guard] enabled=${g.enabled()} 命中=${changed} system=「${after.slice(0, 40)}」`);
  }
  const bodyJson = chat.buildBody(modelKey, payload);
  const encBody = cosy.encode(Buffer.from(bodyJson));

  const sess = cosy.newSession({
    name: auth.nickname || '', aid: auth.uid || '', uid: auth.uid || '', yxUid: '',
    organizationId: '', organizationName: '', userType: auth.userType || 'personal_standard',
    securityOauthToken: auth.accessToken, refreshToken: auth.refreshToken,
  }, auth.machineId || '', auth.machineToken || '', auth.machineType || '5');

  const headers = cosy.buildHeaders(sess, ep.ChatPathSig, encBody, 'text/event-stream', {
    'accept-encoding': 'identity', 'x-model-key': modelKey, 'x-model-source': 'system',
  });

  console.log(`model=${MODEL} big=${BIG} tools=${TOOLS} bodyBytes=${Buffer.byteLength(bodyJson)}`);
  const t0 = Date.now();
  let n = 0, firstAt = null;
  await chat.postStream(ep.ChatStreamURL, encBody, headers, (inner) => {
    n++;
    if (!firstAt) firstAt = Date.now() - t0;
    if (n <= 12) console.log(`  [${Date.now() - t0}ms] frame#${n}: ${String(inner).slice(0, 300)}`);
  });
  console.log(`共 ${n} 帧，首帧 ${firstAt}ms，总耗时 ${Date.now() - t0}ms`);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
