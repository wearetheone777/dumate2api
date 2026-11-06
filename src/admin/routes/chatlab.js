// src/admin/routes/chatlab.js - 聊天测试台（管理端内直接试调模型）
//
// 定位：让管理员在管理端里验证「某个模型名能不能跑通」，不用先去
// 「API 密钥」页签发密钥、再去配客户端。所以这条链路刻意不经密钥与 IP 管控，
// 只要求管理员会话——它走的是与下游 9084 同一套账号池，消耗的是真实积分。
//
// 与 9084（web-gateway）的分工：9084 是给外部客户端用的正式入口，
// 带密钥鉴权、面向协议兼容；这里是内部试调，返回给前端的是便于展示的
// 结构化数据（含每条回答的实测消耗），不做协议翻译。
const crypto = require('crypto');
const pool = require('../../web-pool');
const modelmap = require('../../modelmap');
const reqlog = require('../../reqlog');
const accounts = require('../../accounts');
const pointsCursor = require('../../points-cursor');
const web = require('../../dumate-web');
const router = require('../../upstream-router');
const { sendJSON, readBody } = require('../router');

/**
 * 直连通道的 provider（千问 / TRAE / Qoder）。搭子返回 null——它走网页池转发。
 *
 * 三条通道的凭证、签名、计费都不同，但对外都是同一个 `send(payload, onChunk, opts)`
 * 形状，所以这里可以统一分发（与网关 server.js 的 handleDirectChannel 同一思路）。
 */
function providerOf(channel) {
  if (channel === 'traework') return require('../../traework');
  if (channel === 'qoder') return require('../../qoder');
  if (channel === 'workbuddy') return require('../../workbuddy');
  if (channel === 'qwenwork') return require('../../qwenwork');
  return null;
}

/**
 * 各通道的输出预算。**三套互不套用**（见 budget.js）：
 * 搭子下限 65536，直连通道是 16384——套错会把小请求凭空撑大。
 */
function budgetFor(kind, requested) {
  const b = require('../../budget');
  if (kind === 'qoder') return b.resolveQoderMaxTokens(requested);
  if (kind === 'traework') return b.resolveTraeworkMaxTokens(requested);
  if (kind === 'qwenwork') return b.resolveQwenMaxTokens(requested);
  if (kind === 'workbuddy') return b.resolveWorkBuddyMaxTokens(requested);
  return b.resolveMaxTokens(requested);
}

// 可试调的模型名：暴露列表 + 别名。别名也要给，因为「为什么 glm-5 能用
// 但 claude-3-5-sonnet 不行」这类问题恰恰要先能选中它才试得出来。
function availableModels() {
  const cfg = modelmap.load();
  const exposed = (cfg.exposed || []).map((id) => ({ id, kind: 'upstream', mapped: cfg.aliases?.[id] || id }));
  const aliases = Object.keys(cfg.aliases || {})
    .filter((id) => !(cfg.exposed || []).includes(id))
    .map((id) => ({ id, kind: 'alias', mapped: cfg.aliases[id] }));
  return { exposed, aliases, fallback: cfg.fallback || '' };
}

// TRAE Work 的模型表（只读，来自上游常量）。试调台要能选它，否则在
// TRAE 通道下只能手打前缀——而手打错就会静默跑到搭子上去。
// region（2026-11-03）：cn（缺省）/ intl，两区模型表不同；国际表没有就
// 返回空 + 说明，前端显示「没有国际账号」而不是静默给国内表
async function traeworkModels(region) {
  try {
    const models = require('../../traework/models');
    const reg = region === 'intl' ? 'intl' : 'cn';
    const r = await models.fetchModels({ region: reg });
    const list = (r.models || []).filter(models.isUsableRow);
    if (!list.length) return { region: reg, error: r.error || (reg === 'intl' ? '没有可用的国际账号，无法拉取国际模型表' : '模型表为空'), models: [] };
    return {
      region: reg, error: '',
      models: list.map((m) => ({ id: m.id, name: m.name || m.id, prefixed: `traework/${m.id}` })),
    };
  } catch (e) {
    return { region: region === 'intl' ? 'intl' : 'cn', error: e.message, models: [] };
  }
}

/**
 * Qoder 的模型清单（**带前缀** + 倍率）。
 *
 * **必须是 `qoder/gfmodel` 这种完整前缀名**，不能只给 `gfmodel`——前端把选中值
 * 原样回传，网关靠前缀分流；不带前缀的名字会被 `resolve()` 判成搭子，
 * 于是「明明选了 Qoder 模型，跑的却是搭子」，而且两侧都返回 200，看不出来。
 *
 * 倍率从模型信息行拿（model-info.qoderRows 在管理端进程内自己拉模型表）：
 * 试调台的默认模型要按「倍率最低」挑。**名字硬编码的清单已经失效**——
 * 上游模型表从内部代号（qfmodel/gfmodel）改成了显示名（Fast/DeepSeek-Flash），
 * 按旧名单匹配不到任何条目，默认就落到列表第一个（Auto，倍率未知）。
 *
 * 上游拿不到时回落静态表（含 0.1 档的便宜模型），避免下拉框空着。
 */
async function qoderModels(region) {
  // 区域（2026-11-03）：cn（缺省）/ global——按该区域的主账号拉表，
  // 没有该区域账号时明确报错（不静默回落另一区的表）
  const reg = region === 'global' || region === 'intl' ? 'global' : 'cn';
  const rates = new Map();
  let rows = [];
  let error = '';
  try {
    rows = await require('../../model-info').qoderRows({ region: reg });
    for (const r of rows) rates.set(r.prefixed, r.rate);
    if (!rows.length) error = reg === 'global' ? '没有国际（global）账号，无法拉取国际模型表' : '没有可用账号';
  } catch (e) { error = e.message; }
  if (rows.length) {
    return {
      region: reg, error: '',
      models: rows.map((r) => ({ id: r.id, name: r.name || r.id, prefixed: r.prefixed, rate: r.rate })),
    };
  }
  // 上游拿不到时回落静态表（含 0.1 档的便宜模型），避免下拉框空着
  return {
    region: reg, error,
    models: require('../../qoder/constants').FALLBACK_MODELS.map((k) => ({
      id: k, name: k, prefixed: `qoder/${k}`, rate: null,
    })),
  };
}

// 每个会话的游标起点，用于算「本次对话消耗了多少」。
// 放在内存里，不落盘——这是界面上的一次试调，重启后重新开始即可。
const sessionStart = new Map();

function ssKey(req) {
  // 按管理员会话区分，避免两个管理员互相把对方的消耗算进自己的「本次消耗」
  const cookie = (req.headers.cookie || '').slice(0, 200);
  return crypto.createHash('sha1').update(cookie).digest('hex');
}

async function currentBalance() {
  const list = accounts.load().accounts.filter((a) => a.enabled);
  let sum = 0;
  let ok = false;
  for (const a of list) {
    // 出站代理（E 包收口补点）：配置非法走 catch 按「查不到余额」计
    const bal = await web.api.quotaOverview(a.cookie, { agent: web.agentFor(a) }).catch(() => ({ ok: false }));
    if (bal.ok) { sum += bal.left; ok = true; }
  }
  return ok ? sum : null;
}

// 单个账号的余额。试调的实际消耗按「该账号请求前 - 请求后」算，
// 比全池合计更准（并发时别的账号的消耗不会混进来）。
async function balanceOf(account) {
  const r = await web.api.quotaOverview(account.cookie, { agent: web.agentFor(account) }).catch(() => ({ ok: false }));
  return r.ok ? r.left : null;
}

// 拍一张「账号 id → 余额」的快照。请求前后各拍一次，差值即实测消耗。
// 为什么不在请求后再问一次就够：余额是累计值，没有参照点算不出单次消耗。
async function snapshotBalances() {
  const list = accounts.load().accounts.filter((a) => a.enabled);
  const out = new Map();
  await Promise.all(list.map(async (a) => {
    const left = await balanceOf(a);
    if (left !== null) out.set(a.id, left);
  }));
  return out;
}

// 实测消耗。拿不到快照返回 null——前端显示 —，不补 0
// （0 会被读成「这次没花钱」，而真相是「没测到」）。
function costOf(accountId, before, after) {
  if (!accountId || !before || !after) return null;
  const b = before.get(accountId);
  const a = after.get(accountId);
  if (typeof b !== 'number' || typeof a !== 'number') return null;
  return Math.round((b - a) * 100) / 100;
}

/**
 * 直连通道（千问 / TRAE / Qoder）的试调。
 *
 * 与搭子分支的关键差异，改的时候别合并：
 *
 * 1. **不走网页池**：网页 cookie 换的是搭子的模型 token，用它去打千问/TRAE/Qoder
 *    根本不通。所以这里直接调 provider（与网关 server.js 同一条路）。
 * 2. **模型名已去前缀**（route.model）。千问/TRAE 的 provider 自己也剥前缀，
 *    Qoder 的不剥——统一在调用前剥掉，两边都对。
 * 3. **消耗测不到就不补 0**：这三条通道的计费不在搭子的余额里
 *    （Qoder 扣 credits、千问扣三个池、TRAE 扣单 credits），
 *    用搭子的网页余额算差值必然是 0，显示成「0 积分」会被读成「这次没花钱」。
 *    所以直连通道的 cost 一律 null，并附一句 costNote 指到该通道的额度页。
 * 4. **账号名由 provider 上报**（onAccount）：多账号轮询下只有它知道选中的是哪个。
 */
async function handleDirect(req, res, ctx) {
  const { provider, payload, channel, model, mapped, stream, startedAt, personalAssistant } = ctx;
  // 区域（2026-11-03 页面区分）：试调台选的国内/国际，随行记进埋点，
  // 请求日志的区域拆分对试调的行同样生效
  const region = ctx.region || '';
  const messageCount = Array.isArray(payload && payload.messages) ? payload.messages.length : 0;
  const reqId = reqlog.newReqId();
  let accountName = '';
  const onAccount = (name) => { if (name) accountName = String(name); };

  const record = (status, usage, err) => {
    reqlog.record({
      ts: Date.now(), ms: Date.now() - startedAt,
      // req_id 必须写进埋点：Qoder / TRAE / 千问的逐请求积分归因按它配对。
      // 漏了这个字段，试调台的消耗就永远配不到日志行上——界面只能显示「—」
      req_id: reqId,
      path: '/admin/chatlab', model, mapped_model: mapped,
      stream, messages: messageCount,
      status,
      input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.total,
      ip: reqlog.clientIP(req), ua: 'admin-chatlab',
      key_id: 0, key: '', upstream: channel,
      // 通道必须标对：不标会被归成「分通道前的历史记录」，而它是当下跑的
      channel,
      account: accountName,
      region,
      error: err || '',
    });
  };

  // 通道显示名走 channels.js 单一来源——硬编码三元是 WorkBuddy 接入前写的，
  // 新通道全落进「千问」（2026-11-04 WorkBuddy 测试台实测抓到）
  const costNote = `${require('../../channels').label(channel)} 的计费不在搭子余额里，本条消耗请到该通道的额度页看`;

  // TRAE 宝身份走 opts（payload.model 已去前缀，provider 认不出）；
  // 千问/Qoder 的 send 不认识这个字段，多传无害。
  // **必须在流式/非流式两个分支之外**——流式分支也用它，定义进分支
  // 里就是 ReferenceError: sendOpts is not defined（实测踩过）
  const sendOpts = { reqId, onAccount, personalAssistant: !!personalAssistant, region };

  // ---- 非流式 ----
  if (!stream) {
    try {
      const out = await provider.send(payload, undefined, sendOpts);
      const choice = (out.choices || [])[0] || {};
      const msg = choice.message || {};
      const u = reqlog.pickUsage(out.usage);
      // Qoder 的 usage 直接带 credits（倍率 × tokens/1000）——三条直连通道里
      // 唯一能精确归因单条请求的消耗，有就展示
      const cr = out && out.usage && Number.isFinite(Number(out.usage.credits))
        ? Math.round(Number(out.usage.credits) * 10000) / 10000 : null;
      record(200, u, '');
      return sendJSON(res, 200, {
        ok: true,
        model, mapped_model: mapped,
        account: accountName,
        content: msg.content || '',
        reasoning: msg.reasoning_content || '',
        usage: u,
        cost: cr,
        // 测不到才给说明——不补 0，0 会被读成「这次没花钱」
        costNote: cr == null ? costNote : undefined,
        ms: Date.now() - startedAt,
      });
    } catch (e) {
      const status = Number(e.statusCode) || 502;
      record(status, { input: 0, output: 0, total: 0 }, e.message);
      const code = status >= 400 && status < 600 ? status : 502;
      return sendJSON(res, code, { error: e.message });
    }
  }

  // ---- 流式 ----
  // SSE 协议与搭子分支一致（meta / reasoning / delta / error / done），
  // 前端不用分通道改解析。差别只在 provider 的调用方式。
  let settled = false;
  const send = (obj) => {
    if (!settled) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...(res._cors || {}),
      });
      settled = true;
      try {
        res.write(`data: ${JSON.stringify({
          type: 'meta', model, mapped_model: mapped, account: accountName,
        })}\n\n`);
      } catch (e) { /* ignore */ }
    }
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) { /* 客户端断开 */ }
  };

  let seen = '';
  let usage = { input: 0, output: 0, total: 0 };
  let err = '';
  // Qoder 的 usage 直接带 credits（`倍率 × tokens/1000`），是三条直连通道里
  // 唯一能精确归因单条请求的消耗——扫到就展示，界面不必再去额度页猜。
  let credits = null;
  const noteCredits = (j) => {
    if (j && j.usage && typeof j.usage.credits === 'number' && Number.isFinite(j.usage.credits)) {
      const prev = credits == null ? 0 : credits;
      credits = Math.max(prev, j.usage.credits);
    }
  };
  try {
    await provider.send(payload, (inner) => {
      if (inner === '[DONE]') return;
      // usageFromSSE 按 `data:` 行扫描，而 inner 是解信封后的裸 JSON——
      // 必须补前缀才扫得到，否则流式请求的 token 恒为 0
      seen += `data: ${inner}\n`;
      if (seen.length > 65536) seen = seen.slice(-65536);
      for (const line of String(inner).split('\n')) {
        const p = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
        if (!p || p === '[DONE]') continue;
        try {
          const j = JSON.parse(p);
          noteCredits(j);
          const d = ((j.choices || [])[0] || {}).delta || {};
          if (d.reasoning_content) send({ type: 'reasoning', text: d.reasoning_content });
          if (d.content) send({ type: 'delta', text: d.content });
        } catch (e) { /* 非 JSON 帧跳过 */ }
      }
    }, sendOpts);
    const scanned = reqlog.usageFromSSE(seen);
    if (scanned && scanned.total) usage = scanned;
  } catch (e) {
    err = e.message;
  }

  // 测到 credits 就报真实消耗，测不到才给 null + 说明（不补 0）
  const cost = credits == null ? null : Math.round(credits * 10000) / 10000;
  send(err
    ? { type: 'error', error: err, usage, account: accountName }
    : { type: 'done', usage, account: accountName, cost, costNote: cost == null ? costNote : undefined });
  record(err ? 502 : 200, usage, err);
  res.end();
  return undefined;
}

const routes = [
  {
    // 模型清单。前端据此渲染下拉框
    method: 'GET',
    path: '/models',
    handler: ({ res }) => sendJSON(res, 200, availableModels()),
  },
  {
    // TRAE Work 的模型清单（只读）。与搭子分开一个接口：那份映射表描述的是
    // 搭子的别名，混进来会让人以为改它能影响 TRAE 路由。
    // ?region=intl 看国际模型表（2026-11-03 区域区分）
    method: 'GET',
    path: '/traework-models',
    handler: async ({ res, req }) => {
      const regionRaw = decodeURIComponent(((req.url.match(/[?&]region=([^&]*)/) || [])[1] || '')).toLowerCase();
      const r = await traeworkModels(regionRaw);
      return sendJSON(res, 200, r);
    },
  },
  {
    // Qoder 的模型清单（带 `qoder/` 前缀 + 真实显示名）。
    // 与搭子分开一个接口：那份映射表描述的是搭子的别名，混进来会让人以为
    // 改它能影响 Qoder 路由。?region=global 看国际模型表（2026-11-03）
    method: 'GET',
    path: '/qoder-models',
    handler: async ({ res, req }) => {
      const regionRaw = decodeURIComponent(((req.url.match(/[?&]region=([^&]*)/) || [])[1] || '')).toLowerCase();
      const r = await qoderModels(regionRaw);
      return sendJSON(res, 200, r);
    },
  },
  {
    // WorkBuddy 的模型清单（带 `workbuddy/` 前缀）。?region=intl 看国际目录
    method: 'GET',
    path: '/workbuddy-models',
    handler: async ({ res, req }) => {
      const regionRaw = decodeURIComponent(((req.url.match(/[?&]region=([^&]*)/) || [])[1] || '')).toLowerCase();
      const reg = regionRaw === 'intl' || regionRaw === 'global' ? 'global' : 'cn';
      try {
        const r = await require('../../workbuddy/models').fetchModels({ region: reg });
        return sendJSON(res, 200, {
          region: reg,
          error: r.error || '',
          models: (r.models || []).map((m) => ({
            id: m.id,
            name: m.free ? `${m.name}（免费）` : m.name,
            prefixed: `workbuddy/${m.id}`,
            rate: m.rate,
          })),
        });
      } catch (e) {
        return sendJSON(res, 200, { region: reg, error: e.message, models: [] });
      }
    },
  },
  {
    // 本次会话已消耗的积分（相对打开页面时的余额）
    method: 'GET',
    path: '/session-cost',
    handler: async ({ res, req }) => {
      const bal = await currentBalance();
      if (bal === null) return sendJSON(res, 200, { ok: false, consumed: null, balance: null });
      const k = ssKey(req);
      if (!sessionStart.has(k)) sessionStart.set(k, bal);
      const start = sessionStart.get(k);
      return sendJSON(res, 200, {
        ok: true,
        balance: Math.round(bal * 100) / 100,
        consumed: Math.round((start - bal) * 100) / 100,
        since: start,
      });
    },
  },
  {
    // 重置「本次消耗」的基准（点「清空对话」时调）
    method: 'POST',
    path: '/session-cost/reset',
    handler: async ({ res, req }) => {
      const bal = await currentBalance();
      sessionStart.set(ssKey(req), bal === null ? 0 : bal);
      return sendJSON(res, 200, { ok: true, since: sessionStart.get(ssKey(req)) });
    },
  },
  {
    // 试调。流式：上游 SSE 原样透传，同时解析出正文与 usage。
    //
    // 不走 callWithFailover：那条路要求 JSON 响应，会把 SSE 整体缓冲成
    // 一个字符串，首字延迟就没了。这里自己做账号轮询 + 故障转移。
    method: 'POST',
    path: '/chat',
    handler: async ({ res, req, body }) => {
      const messages = Array.isArray(body && body.messages) ? body.messages : [];
      const model = String((body && body.model) || '').trim();
      if (!messages.length) return sendJSON(res, 400, { error: 'messages 不能为空' });

      // 通道分流：靠**前缀**判定（与网关同一份 upstream-router）。
      //
      // 原来这里一律 `modelmap.mapModel(model)`——`qoder/gfmodel` 不在别名表里，
      // 被兜底成搭子的 `model-text`，于是「选了 Qoder 模型、跑的却是搭子」，
      // 而且两侧都返回 200，从响应里看不出来。千问/TRAE 同样中招。
      const route = router.resolve(model);
      if (route.error) {
        return sendJSON(res, 400, { error: `未知通道：${route.error.replace('unknown_channel: ', '')}（模型名应为 qoder/xxx、traework/xxx、qwen/xxx 或搭子模型名）` });
      }
      const channel = route.channel;
      const direct = providerOf(channel);

      const stream = !!(body && body.stream);
      // 预算按通道取：搭子下限 65536，直连通道 16384，套错会把小请求凭空撑大
      const maxTokens = budgetFor(channel, body && body.max_tokens);

      const startedAt = Date.now();
      // 请求前拍一次余额快照，用于算这次试调的实测消耗
      const before = await snapshotBalances();

      // ---- 直连通道（千问 / TRAE / Qoder）：走 provider，不打搭子网页池 ----
      // 模型名传**去前缀**的上游名（route.model），与网关 server.js 同一约定。
      if (direct) {
        const payload = {
          model: route.model,
          messages,
          max_tokens: maxTokens,
          stream,
        };
        if (stream) payload.stream_options = { include_usage: true };
        // 区域（2026-11-03）：试调台选的国内/国际，随 send 的 opts.region
        // 约束选号——否则国际模型可能被国内账号接走（反之亦然）。
        // qoder 的术语是 global，traework 是 intl，统一归一成 intl
        const rawRegion = String((body && body.region) || '').toLowerCase();
        const region = (rawRegion === 'intl' || rawRegion === 'global') ? 'intl'
          : rawRegion === 'cn' ? 'cn' : '';
        return handleDirect(req, res, {
          provider: direct, payload, channel, model, mapped: route.model,
          stream, startedAt, before, messages, region,
          // TRAE 宝身份（traebao/ 前缀 → function=personal_assistant）：
          // 前缀在 payload.model 里已被剥掉，provider 靠这个标记认身份。
          // 漏传的话 traebao/auto 会静默走 solo 链路并正常计费——界面选了
          // 「免费」跑的却是扣积分的，比报错更难察觉。
          personalAssistant: route.personalAssistant,
        });
      }

      const cfg = modelmap.load();
      const mapped = modelmap.mapModel(model || cfg.fallback);

      const payload = {
        model: mapped,
        messages,
        max_tokens: maxTokens,
        stream,
      };
      if (stream) payload.stream_options = { include_usage: true };

      if (!stream) {
        // 非流式直接用池里的故障转移：它会依次换账号，并把 4xx 判为
        // 「请求本身的问题」不再重试（换账号也一样失败）
        const r = await pool.callWithFailover('/chat/completions', 'POST', payload,
          { timeout: 300000 });
        const j = r.json || {};
        const choice = (j.choices || [])[0] || {};
        const msg = choice.message || {};
        const u = reqlog.pickUsage(j.usage);
        const acct = r.account || null;
        const cost = r.ok ? costOf(acct && acct.id, before, await snapshotBalances()) : null;
        reqlog.record({
          ts: Date.now(), ms: Date.now() - startedAt,
          path: '/admin/chatlab', model: model || mapped, mapped_model: mapped,
          stream: false, messages: messages.length,
          status: r.status || 0,
          input_tokens: u.input, output_tokens: u.output, total_tokens: u.total,
          ip: reqlog.clientIP(req), ua: 'admin-chatlab',
          key_id: 0, key: '', upstream: 'web',
          // 通道标搭子：chatlab 走的仍是搭子上游（模型名与计费都是搭子的），
          // 只是凭证来自网页 cookie。不标会让这条行在界面上被归成
          // 「分通道前的历史记录」——而它其实不是历史，是当下跑的
          channel: 'dumate',
          account: acct ? accounts.displayName(acct) : '',
          error: r.ok ? '' : (r.error || 'upstream_error'),
        });
        // 审计（Q4）：试调消耗真实积分，成败都留痕（与 reqlog 同口径的通道/模型）
        try { require('../auth').audit('admin', 'chatlab_chat', `${channel}/${model || mapped}`,
          r.ok ? `tokens ${u.total}` : (r.error || 'upstream_error')); } catch (e) { /* 审计失败不影响结果 */ }
        if (!r.ok) {
          return sendJSON(res, r.status || 502, {
            error: r.error || (j.error && j.error.message) || `HTTP ${r.status}`,
          });
        }
        return sendJSON(res, 200, {
          ok: true,
          model: model || mapped,
          mapped_model: mapped,
          account: acct ? accounts.displayName(acct) : '',
          content: msg.content || '',
          reasoning: msg.reasoning_content || '',
          usage: u,
          cost,
          ms: Date.now() - startedAt,
        });
      }

      // 流式：边收边转发。响应头一到达就先判断状态码——若不是 2xx，
      // 此时还没写出任何字节，可以换账号重试；一旦开始转发就不能换了。
      //
      // 这里只发一次上游请求：早先的写法先「探活」再正式发，会把
      // 同一次试调打两遍，真实扣两笔积分。
      const tried = new Set();
      let settled = false;      // 已写出 SSE 头，不能再换账号
      let accepted = false;     // 当前这次上游响应可用（2xx），chunk 才是正文
      let account = null;
      let text = '';
      let usage = { input: 0, output: 0, total: 0 };
      let upstreamStatus = 0;
      let upstreamErr = '';

      // send 必须定义在循环外：循环结束后还要发 done/error，
      // 定义在循环里会 ReferenceError（实测「send is not defined」，done 事件丢失）
      const send = (obj) => {
        if (!accepted) return;
        if (!settled) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...(res._cors || {}),
          });
          settled = true;
          sendMeta();
        }
        try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) { /* 客户端断开 */ }
      };
      const sendMeta = () => {
        try {
          res.write(`data: ${JSON.stringify({
            type: 'meta', model: model || mapped, mapped_model: mapped,
            account: account ? accounts.displayName(account) : '',
          })}\n\n`);
        } catch (e) { /* 忽略 */ }
      };
      // 循环结束后的收尾事件要绕过 accepted 检查：此时 accepted 可能
      // 因「上游 4xx」为 false，但错误本身必须告诉前端
      const sendFinal = (obj) => {
        if (!settled) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...(res._cors || {}),
          });
          settled = true;
          sendMeta();
        }
        try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) { /* 忽略 */ }
      };

      for (let i = 0; i < 3 && !settled; i++) {
        const item = pool.pick(tried);
        if (!item) break;
        tried.add(item.account.id);
        account = item.account;
        text = '';
        accepted = false;

        const r = await pool.callModelStream(
          item.account, '/chat/completions', 'POST', payload,
          (chunk) => {
            // 非 2xx 时这段是错误体，不能当正文转发
            if (!accepted) return;
            text += chunk;
            // 上游 SSE 增量转成前端好用的格式：前端不必再解一遍
            // OpenAI 的 chunk 结构，也便于把 reasoning 与正文分开显示
            for (const line of chunk.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const p = line.slice(5).trim();
              if (!p || p === '[DONE]') continue;
              try {
                const j = JSON.parse(p);
                const d = ((j.choices || [])[0] || {}).delta || {};
                if (d.reasoning_content) send({ type: 'reasoning', text: d.reasoning_content });
                if (d.content) send({ type: 'delta', text: d.content });
              } catch (e) { /* 非 JSON 行跳过 */ }
            }
          },
          {
            timeout: 600000,
            onStatus: (code) => {
              // 状态码决定「这次响应能不能用」；能用的才把后续 chunk
              // 当正文转发，不能用的让循环换账号
              if (code >= 200 && code < 300) accepted = true;
              else { upstreamStatus = code; upstreamErr = `HTTP ${code}`; }
            },
          },
        );

        upstreamStatus = r.status || upstreamStatus || 0;
        if (r.ok && accepted) {
          usage = reqlog.usageFromSSE(text);
          break;
        }
        upstreamErr = r.error || upstreamErr || `HTTP ${r.status}`;
        // 4xx（除 401/429）是请求本身的问题，换账号也一样失败
        if (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429) break;
      }

      if (!settled) {
        return sendJSON(res, upstreamStatus || 503, { error: upstreamErr || '没有可用账号（全部禁用或冷却中）' });
      }

      const cost = upstreamErr ? null : costOf(account.id, before, await snapshotBalances());

      reqlog.record({
        ts: Date.now(), ms: Date.now() - startedAt,
        first_token_ms: null,
        path: '/admin/chatlab', model: model || mapped, mapped_model: mapped,
        stream: true, messages: messages.length,
        status: upstreamStatus || 0,
        input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.total,
        ip: reqlog.clientIP(req), ua: 'admin-chatlab',
        key_id: 0, key: '', upstream: 'web',
        // 同非流式分支：走的是搭子上游，凭证来自网页 cookie
        channel: 'dumate',
        account: accounts.displayName(account),
        error: upstreamErr,
      });
      // 与请求日志同一条余额游标链：「本次消耗」和日志里的实测值才能对上
      if (!upstreamErr) pointsCursor.capture(Date.now(), accounts.displayName(account));
      // 审计（Q4）：试调消耗真实积分，成败都留痕（与 reqlog 同口径的通道/模型）
      try { require('../auth').audit('admin', 'chatlab_chat', `${channel}/${model || mapped}`,
        upstreamErr || `tokens ${usage.total}`); } catch (e) { /* 审计失败不影响结果 */ }

      if (upstreamErr) sendFinal({ type: 'error', error: upstreamErr });
      sendFinal({ type: 'done', usage, account: accounts.displayName(account), cost });
      res.end();
    },
  },
];

// 余额快照/实测消耗导出：搭子的计费自检探针（admin/routes/dumate.js）与
// chatlab 用**同一份**余额口径——第二份实现必然漂移（一边修余额接口另一边不知道）。
module.exports = { routes, balanceOf, snapshotBalances, costOf };
