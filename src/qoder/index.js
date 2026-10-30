// src/qoder/index.js - Qoder 通道对外入口
//
// 上层（server.js / upstream-router.js）只跟这个文件打交道。
//
// 与千问办公的关键差异：**签名在进程内完成**（cosy.js），不需要 spawn 子进程
// 调 wasm。所以这条通道没有「签名阻塞事件循环」的问题，代码也简单得多。
//
// 每次请求都要用**该账号的**身份构造一个新的 COSY 会话（cosyKey/info 与
// uid/token 绑定），这也是为什么 buildBody 与签名放在同一次 runOnce 里。
const https = require('https');
const crypto = require('crypto');
const chat = require('./chat');
const cosy = require('./cosy');
const authStore = require('./auth');
const session = require('./session');
const constants = require('./constants');
const { normalizeError } = require('../errtext');
const { isThrottle, unescapeDeep, throttleRetryMs } = require('../upstream-errors');
const ledger = require('../checkin-ledger');
const grants = require('./grants');
const maxOutput = require('./max-output');
// 「播报即收尾」（共享判定与缓冲门，见 src/repair.js）
const repair = require('../repair');
// 选号接缝（集成阶段）：冷却/熔断/粘性/在途帽统一走池状态机。
// 通道在池里的 uid 键位 = 'qoder:<id>'（channel-pool.js 统一裁决）。
const channelPool = require('../channel-pool');
const CHANNEL = 'qoder';
// 出站代理工厂（E 包接线）：runOnce 按账号解析 agent
const proxyAgent = require('../proxy-agent');

/**
 * 预热**模型表**：runOnce 从同步缓存里取「该模型的最大上下文档位」（1M），
 * 缓存为空时只能回落默认档 200K。这里异步拉一次、不阻塞启动——与 TRAE 的
 * warmupModels 同一思路。
 *
 * **每个可用账号都要预热**：模型表缓存按「区域 + 账号」隔离
 * （见 session.modelsCacheKey），只预热主账号时，换号重试落到第二个账号后
 * cachedModels 为空，模型名就解析不出来。
 * 调用点原先**根本不存在**——server.js 只给千问和 TRAE 写了预热块，
 * Qoder 的预热从没被调用过，于是网关进程里的模型表缓存恒为空：
 * 客户端写显示名（qoder/GLM-5.3-Flash）时被原样当 key 发出去，
 * 上游返回 provider_error → 空回答。
 */
async function warmupModels() {
  const accounts = authStore.findUsable();
  if (!accounts.length) return { ok: false, error: '尚未添加 Qoder 账号', models: [] };
  let last = { ok: false, error: 'unknown', models: [] };
  for (const a of accounts) {
    const r = await session.fetchModels(a).catch((e) => ({ ok: false, error: e.message, models: [] }));
    if (r && r.ok && r.models && r.models.length) last = r;
    else if (!last.ok) last = r || last;
  }
  return last;
}

function status() {
  const usable = authStore.findUsable();
  return {
    ready: usable.length > 0,
    // 这条通道没有 wasm 依赖，如实标注（千问的 status 有 wasm 字段）
    needsClient: false,
    accounts: usable.length,
    error: usable.length ? '' : '尚未添加 Qoder 账号（需先登录一次）',
  };
}

function pickAccount() {
  const a = authStore.preferred();
  if (!a) throw new Error('Qoder 没有可用账号，请先添加一个');
  return a;
}

/**
 * 业务码 105（Login expired）→ classify 的 401（session_dead）。
 *
 * Qoder 凭证失效不走 HTTP 401，而是 COSY 信封里的 105；池的防误杀计数
 * 必须能吃到它，否则凭证死了账号永远健康、每次请求都要白撞一次。
 * 放在喂池入口而不是改 classify——105 是 Qoder 通道的私有业务码，
 * upstream-errors 是两条 COSY 通道共用的识别层，不认识通道私有码。
 */
function poolStatusOf(code) {
  const n = Number(code) || 0;
  return n === 105 ? 401 : n;
}

// ---------------------------------------------------------------------------
// Qoder 计费平台的业务码（< 400，payloadError 不认，必须通道层自己识别）。
//
// 信封原文（2026-10-30 对齐 qoder2api-hub #108 的现场日志）：
//   112 额度耗尽    HTTP 403 + {"code":"112","message":"{\"pricingUrl\":...}"}
//   110 每日次数上限 {"code":"110","message":"Billing daily count exceeded"}
//   114 试用账号受限 / 430 客户端版本过低
//
// 处置（对齐 hub #108，四条不变量）：
//   · 112/110/114 → soft 冷却 + **换号**（别的账号可能还有额度）：112/114 冷却
//     30 分钟；110 冷却到本地 0 点（池会夹到软冷却封顶 2h，到期前每 2h 探一次）。
//   · **不禁用账号、不进熔断**——配额问题不是凭证失效/未知故障。
//   · 不写模型级冷却——配额是账号级的。
//   · 430 → 换号无用（每个号都会 430），快速失败 + 明确文案，不惩罚账号。
// ---------------------------------------------------------------------------

/** 112/114 的固定冷却（30 分钟后探一次：期间可能签到到账/充值到账） */
const QUOTA_COOLDOWN_MS = 30 * 60 * 1000;

/** 冷却到下一个本地 0 点（每日次数上限的恢复窗口） */
function msUntilMidnight(now) {
  const d = now ? new Date(now) : new Date();
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
  return Math.max(60 * 1000, target.getTime() - d.getTime());
}

/** 从错误文本认额度类业务码。信封可能多层转义，先剥反斜杠归一化。 */
function quotaKindOfText(text) {
  const s = unescapeDeep(text);
  if (/"code"\s*:\s*"112"|"pricingUrl"/i.test(s)) return 'exhausted';
  if (/"code"\s*:\s*"110"|Billing daily count exceeded/i.test(s)) return 'daily';
  if (/"code"\s*:\s*"114"/.test(s)) return 'trial';
  if (/"code"\s*:\s*"430"/.test(s)) return 'version';
  return '';
}

/**
 * 逐帧识别额度类错误帧。**只看顶层 code 字段**，不匹配帧的字符串全文——
 * 模型输出里讨论到 `{"code":"112"}` 时不能误伤正文。
 * 返回 {code, message, quotaKind} 形状（与 payloadError 同形，code 用 403 语义）。
 */
function quotaFrameError(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const c = String(parsed.code != null ? parsed.code : '').trim();
  if (!/^(112|110|114|430)$/.test(c)) return null;
  const kind = c === '112' ? 'exhausted' : c === '110' ? 'daily' : c === '114' ? 'trial' : 'version';
  const msg = String(parsed.message || '').trim();
  return { code: 403, message: `qoder quota ${kind}(${c})${msg ? ': ' + msg.slice(0, 160) : ''}`, quotaKind: kind };
}

/** 从响应原文（SSE 行或裸 JSON）里找额度类错误帧。逐行解析、只看顶层 code。 */
function quotaFromBody(raw) {
  const text = String(raw || '');
  for (const line of text.split('\n')) {
    const t = line.trim();
    const json = t.startsWith('data:') ? t.slice(5).trim() : t;
    if (!json || json === '[DONE]') continue;
    let o;
    try { o = JSON.parse(json); } catch (e) { continue; }
    const fe = quotaFrameError(o);
    if (fe) return fe;
  }
  return null;
}

/**
 * 喂池的错误形状。105→401 的旧映射保留；额度类改喂「429 + 显式时长」——
 * classify 对显式 retryAfterMs 只透传（见 upstream-errors），applySoftCooldown
 * 拿它做固定冷却且不递增 soft_streak。430 喂 400（不惩罚）。
 */
function poolInfoOf(e, model) {
  const code = Number(e.statusCode) || 0;
  const qk = e.quotaKind || quotaKindOfText(e.message);
  if (qk === 'version') return { status: 400, message: e.message, model };
  if (qk) {
    return {
      status: 429,
      message: e.message,
      model,
      retryAfterMs: qk === 'daily' ? msUntilMidnight() : QUOTA_COOLDOWN_MS,
    };
  }
  return { status: poolStatusOf(code), message: e.message, model };
}

// ---------------------------------------------------------------------------
// 国际版推理主机候选链（constants.chatStreamCandidates：api3→api2→api1）。
// 只有**连接建立阶段**的失败才切候选——「已连上但没数据」（首字节/读空闲
// 超时）说明主机可达，换主机无意义，交回上层按限流/换号处置。
// ---------------------------------------------------------------------------
const CONN_PHASE = /^(ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EPROTO)$/;
function isConnPhaseError(e) {
  return !!(e && typeof e.code === 'string' && CONN_PHASE.test(e.code));
}
function hostOf(url) {
  try { return new URL(url).host; } catch (e) { return String(url); }
}

/** 依次尝试候选主机；连接层失败且（流式）还没转发过任何帧时切下一个 */
async function postWithFallback(candidates, fn, isDelivered) {
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      return await fn(candidates[i]);
    } catch (e) {
      lastErr = e;
      if (i >= candidates.length - 1 || (isDelivered && isDelivered()) || !isConnPhaseError(e)) throw e;
      console.warn(`[qoder] 推理端点 ${hostOf(candidates[i])} 连接失败（${e.code}），切换备用端点 ${hostOf(candidates[i + 1])}`);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 排队等待（2026-10-30，官方客户端的轮询协议 + hub 验证过的盲等兜底）。
//
// 官方行为（hub 文档 7.1 逆向）：被 10605（isQueued:true）拒绝后**不结束请求**，
// 带着同一个 requestSetId 轮询 queue/status，每轮先睡 retryAfterSeconds，
// 放行才重发推理，总预算默认 60 分钟。此前我们每次重试都换新的
// request_set_id——等于每次重新排队，这正是「等 30 秒也不保证放行」结论的
// 疑似真因；所以排队模式下 request_set_id 在同一次 send() 内保持稳定
// （buildBody 的 opts.requestSetId）。
//
// 配置**每次现读**：chat.js 曾把 env 读死在模块加载时（测试与调参都不便），
// 这里不重复那个坑。
// ---------------------------------------------------------------------------
function queuePollDeadline() {
  if (process.env.DUMATE_QODER_QUEUE_POLL === '0') return 0;
  const budget = Math.max(0, parseInt(process.env.DUMATE_QODER_QUEUE_POLL_BUDGET_MS || '60000', 10) || 0);
  return budget > 0 ? Date.now() + budget : 0;
}

function queuePollIntervalMs(retryAfterMs) {
  const env = Number(process.env.DUMATE_QODER_QUEUE_POLL_INTERVAL_MS);
  if (Number.isFinite(env) && env > 0) return env; // 测试注入
  return Math.min(Math.max(retryAfterMs || 5000, 5000), 20000);
}

// 只认**信封型**排队（10605 / isQueued / RESOURCE_LIMIT / CALL_COUNT_LIMIT）。
// 另有**静默形态**（上游收了请求、回空 ack 然后沉默 → chat.js 的 content
// deadline / read idle 掐断）——2026-10-30 实测它才是当下最主要的排队形态，
// 同样进等待轮（budget 天然封顶，不会比旧路径更糟：旧路径是掐断后直接失败）。
const QUEUEABLE_TEXT = /10605|isQueued|RESOURCE_LIMIT|CALL_COUNT_LIMIT/i;
function queueableThrottle(text) {
  return QUEUEABLE_TEXT.test(unescapeDeep(String(text || '')));
}
const SILENCE_QUEUED_TEXT = /qoder upstream (queued|read idle|first-byte timeout)/;

function queueTypeOf(message) {
  const m = /"queueType"\s*:\s*"([^"]+)"/i.exec(unescapeDeep(String(message || '')));
  return (m && m[1]) || 'p3';
}

/**
 * FEFO（最早到期优先）候选集：有临期积分批次的账号 uid 集合。
 *
 * 积分领取后 30 天作废、上游没有逐批余额接口（领取额≠剩余额，见 grants.js
 * 头注释）——不用掉就白白过期。池的 expiring 过滤在集合非空时**把候选限制
 * 在集合内**，所以这里只收「真有临期批次」的账号；`DUMATE_QODER_FEFO_DAYS`
 *（默认 3 天）窗口外的批次不参与，`0` 整体关闭。查询失败返回 null（退回
 * 普通选号），绝不因账本问题挡住请求。
 */
function fefoUidSet(usable) {
  const days = Number(process.env.DUMATE_QODER_FEFO_DAYS ?? 3);
  if (!(days > 0)) return null;
  try {
    const set = new Set();
    for (const g of grants.expiring({ withinMs: days * 86400000 })) {
      const acc = usable.find((a) => a.id === g.account_id);
      if (acc) set.add(channelPool.uidOf(CHANNEL, acc.id));
    }
    return set.size ? set : null;
  } catch (e) { return null; }
}

/**
 * 这个错误换账号还有救吗？
 *
 * 判据与千问同一思路：4xx（除 401/402/429/403-模型不可用）是请求本身的问题，
 * 换号也只是再失败一次。**只按数字 code 判，不匹配 message**。
 *
 * Qoder 特有：**额度耗尽时请求会挂起（不报错）**，所以这里看不到 402；
 * 真正会看到的是 `Login expired`（105，凭证失效，换号有用）与模型不可用。
 *
 * **限流（10605 + RESOURCE_LIMIT / CALL_COUNT_LIMIT）必须换号**：
 * 排队的粒度是 (账号, 模型)，两个账号的队列位置不同——实测同一分钟，
 * 一个账号的 dfmodel 在排 2410 位，另一个账号的 gfmodel 直接 200。
 * 旧判据只看 403 + 一组模型/权限文案，限流落到「不可换号」分支，
 * 于是第二个账号白放着、用户拿一个 403。
 */
function retryable(code, message, quotaKind) {
  const n = Number(code);
  if (!Number.isFinite(n) || n === 0) return true; // 网络错误/超时：换号试一次
  // 额度类业务码先于 403 文案判：112/110/114 换号有用（别的号可能还有额度）；
  // 430 是版本门，换号无用——快速失败，客户端拿到明确文案。
  const qk = quotaKind || quotaKindOfText(message);
  if (qk) return qk !== 'version';
  if (n === 401 || n === 402 || n === 429) return true;
  if (n === 105) return true; // Login expired：凭证失效，换号有用
  if (isThrottle(message)) return true; // 上游排队/限流：换号可能落到没排队的那个
  if (n === 403) {
    return /not available|无权限|无权访问|login expired|expired/i.test(String(message || ''));
  }
  if (n >= 500) return true;
  return false;
}

function markFailure(account, msg) {
  try { authStore.patch(account.id, { lastError: normalizeError(msg) }); }
  catch (e) { /* 记不下不影响主流程 */ }
}

// 模型表补拉的退避窗口：失败后这段时间内不再试，避免每个请求都白等一次
// 20s 超时（模型表接口的 TIMEOUT_MS）。成功则清掉。
const MODEL_FETCH_BACKOFF_MS = 60000;
const modelFetchFailedAt = new Map();
// 同一账号的补拉共用一次 in-flight 请求：冷缓存 + 并发请求时，
// 各拉一次就是各等一次 20s。
const modelFetchInflight = new Map();

/**
 * 解析模型名；缓存里认不出来时补拉一次模型表再解析。
 *
 * 返回 `{ key, models }`。补拉失败就沿用现有缓存（可能为空）原样透传——
 * 让上游自己报错，比静默回落到别的模型好。
 *
 * 为什么不能只靠启动预热：模型表缓存按「区域 + 账号」隔离，换号重试会落到
 * 另一个账号，那份缓存可能是空的；启动时上游抖动也会让预热失败且永不重试。
 */
async function resolveModelWithFetch(auth, rawName) {
  const cached = session.cachedModels(auth) || [];
  const key = chat.resolveModelKey(rawName, cached);
  const bare = String(rawName || '').trim().replace(/^qoder\//i, '');
  const known = (list) => list.some((m) => m && (
    m.key === bare || String(m.name || '').toLowerCase() === bare.toLowerCase()
  ));
  // 已经解析出来了（别名 / 内部 key / 显示名命中），不需要再拉
  if (cached.length && (key !== bare || known(cached))) return { key, models: cached };

  const ck = `${constants.normalizeRegion(auth.region)}:${auth.uid || auth.id}`;
  if (Date.now() - (modelFetchFailedAt.get(ck) || 0) < MODEL_FETCH_BACKOFF_MS) {
    return { key, models: cached };
  }
  let inflight = modelFetchInflight.get(ck);
  if (!inflight) {
    inflight = session.fetchModels(auth).catch(() => null);
    modelFetchInflight.set(ck, inflight);
    inflight.then(() => { if (modelFetchInflight.get(ck) === inflight) modelFetchInflight.delete(ck); });
  }
  const r = await inflight;
  if (r && r.ok && r.models && r.models.length) {
    modelFetchFailedAt.delete(ck);
    return { key: chat.resolveModelKey(rawName, r.models), models: r.models };
  }
  modelFetchFailedAt.set(ck, Date.now());
  return { key, models: cached };
}

/**
 * 用指定账号跑一次请求。
 *
 * 与千问的 runOnce 结构对应，但签名是本地调用：
 *   buildBody → cosy.encode → newSession(该账号身份) → buildHeaders → post
 */
async function runOnce(account, payload, onChunk, opts, meter) {
  const auth = await session.ensureAccount(authStore, account);
  const region = constants.normalizeRegion(auth.region);
  const ep = constants.endpointsOf(region);
  // 上下文取该模型的**最大档**（模型表 context_config 的 1M/400K/200K）。
  // 缓存没预热时回落到默认档（buildBody 的 200000）。DUMATE_QODER_CONTEXT=default
  // 可整体退回默认档。
  //
  // 模型名解析要拿模型表：调用方写 `qoder/GLM-5.3-Flash`（真实名）或
  // `qoder/gfmodel`（内部 key）都要认，前者是给人看的。
  //
  // **缓存为空时必须补拉一次**（2026-10-22 修）：以前这里是纯同步读缓存，
  // 缓存为空就把显示名原样当 key 发给上游——上游认不出，回
  // `provider_error: All backends failed`，客户端收到 200 + 空回答。
  // 启动预热解决不了换号落到另一个账号的情况（缓存按账号隔离），
  // 所以热路径上留一次带退避的兜底拉取。
  const resolved = await resolveModelWithFetch(auth, payload && payload.model);
  const cachedModels = resolved.models;
  const modelKey = resolved.key;
  // 把**实际发给上游的 key** 报给埋点。不报的话 `mapped_model` 只记录调用方
  // 写的名字，显示名有没有解析成功在日志里看不出来——这次的空回答问题
  // 恰恰就是「名字没解析」却完全不可见。
  if (opts && typeof opts.onModel === 'function') {
    try { opts.onModel(modelKey); } catch (e) { /* 上报失败不影响请求 */ }
  }
  const modelMeta = cachedModels.find((m) => m.key === modelKey);
  const ctxMax = process.env.DUMATE_QODER_CONTEXT === 'default' ? null : (modelMeta && modelMeta.maxInputTokens);

  // COSY 会话与账号身份绑定：uid / device_token 都进签名。
  // machineId/Token/Type 每账号一份（登录时生成并持久化）。
  const sess = cosy.newSession({
    name: auth.nickname || '',
    aid: auth.uid || '',
    uid: auth.uid || '',
    yxUid: '',
    organizationId: '',
    organizationName: '',
    userType: auth.userType || 'personal_standard',
    securityOauthToken: auth.accessToken,
    refreshToken: auth.refreshToken,
  }, auth.machineId || '', auth.machineToken || '', auth.machineType || '5');

  // 「播报即收尾」（共享判定见 src/repair.js）：带工具的请求启用缓冲门 + 修复重试。
  const caps = repair.envCaps('QODER');
  const repairable = chat.hasFunctionTools(payload) > 0 && caps.REPAIR_MAX > 0;
  // request_id 每轮新生成（单次请求的标识，复用可能被上游当幂等重试合并）；
  // session_id 钉住：修复轮是同一段对话的下一句。request_set_id（排队槽位键）
  // 也不钉——修复轮换新槽位，queue/status 查询（queueWaitRound 里的
  // activeSetId）跟着看新槽位。
  const pinnedSession = (payload && payload.session_id) || crypto.randomUUID();
  // 一个修复轮的重建：追加了消息后签名内容变了，body/编码/请求头必须整套重造
  // （签名包含 body 内容）。签名已是纯本地调用，重签没有 wasm 时代的阻塞性代价。
  let activeSetId = '';
  let encBody = '';
  let headers = null;
  const HEADER_EXTRA = {
    'accept-encoding': 'identity',
    // 模型 key 必须同时放请求头——实测只放 body 时上游仍走 auto
    'x-model-key': modelKey,
    'x-model-source': 'system',
  };
  const applyRound = async (p, setId) => {
    activeSetId = setId || '';
    const bodyJson = chat.buildBody(modelKey, p, {
      maxInputTokens: ctxMax,
      // 思考档位归一化要读模型的 thinking_config（见 chat.resolveReasoningEffort）
      modelMeta,
      // max_tokens 上限自学习（max-output.js）：撞过上限的模型出站前自动 clamp
      maxOutputTokens: maxOutput.get(region, modelKey),
      sessionId: pinnedSession,
      // 排队槽位键（官方轮询协议）：queue/status 与请求体必须带同一个值
      requestSetId: activeSetId || undefined,
    });
    // encode 进 worker（审计 P1-5b）：几 MB 请求的编码不再独占事件循环
    encBody = await cosy.encodeAsync(Buffer.from(bodyJson));
    headers = cosy.buildHeaders(sess, ep.ChatPathSig, encBody, 'text/event-stream', HEADER_EXTRA, { sse: true });
  };
  /**
   * 只重签名、不动请求体（排队等待轮用）。
   *
   * **排队重发必须重签**（2026-10-31 实测，这是「Qoder 一直转圈」的主因之一）：
   * 排队等待轮按官方协议用**同一份**加密请求体重发（同一个 request_set_id 是
   * 排队槽位的钥匙），但早先连 `headers` 也一并复用——上游按签名字节去重，
   * 第二次起一律回 `{"code":"103","message":"Duplicate request"}`。
   *
   * 两个致命后果叠加：103 < 400，`payloadError` 认不出（它不是错误信封），
   * 请求于是**静默**挂到内容超时才被掐断；去重判据与时间间隔无关（实测同一份
   * headers 间隔 7 秒重发仍是 103），所以只靠等待永远绕不开。
   *
   * 实测对照（同一 request_set_id 连发）：
   *   · 复用 headers → `103 Duplicate request`，之后沉默
   *   · 每轮重建 headers → 正常拿到 10605 / 放行，第 5 轮出内容
   *
   * 重签只影响 Authorization 里的 payloadB64（`requestId` 每次新生成）与
   * cosy-date，**不动 encBody**，所以排队槽位不受影响。代价实测：小请求 0.1ms、
   * 800KB 请求 18.8ms——相对一轮 5~20 秒的排队等待可以忽略。
   */
  const reSign = () => {
    headers = cosy.buildHeaders(sess, ep.ChatPathSig, encBody, 'text/event-stream', HEADER_EXTRA, { sse: true });
  };
  await applyRound(payload, opts.requestSetId);
  // 出站代理（E 包接线）：账号 proxy 字段 > 全局 DUMATE_PROXY，无代理 null 直连
  const agent = proxyAgent.getAgentFor(account);

  // ---- 排队等待（官方轮询协议）----
  // 预算由 send() 按整次请求下发（opts.queueDeadline），所有账号共享；
  // 0 = 关闭（拿到限流直接交回上层，行为与旧快速轮询一致）。
  const queueDeadline = Number(opts.queueDeadline) > 0 ? Number(opts.queueDeadline) : 0;
  // queue/status 用与推理相同的 COSY 会话签名（签名 body 传空串）；查询主机
  // 用「本次尝试实际打到的那个」（队列跟着主机走）。连续两次不可用就停止
  // 探测、退化为纯盲等重发（hub 验证过的形态），端点不存在不影响主流程。
  //
  // **签名必须每次重建，不能复用**（2026-10-31 实测）：与推理请求同一个去重
  // 机制——同一份 headers 连发，第二次起一律 `403 {"code":"103","message":
  // "Duplicate request"}`，而 `getQueueStatus` 对非 200 返回 null，于是
  // `statusFailures` 两次就把它判成「端点不可用」，官方排队轮询协议**整条
  // 退化成盲等重发**。实测同一份 headers 间隔 7 秒重发仍是 103（判据与时间
  // 无关）；每次重建则连续 3 次全部 200。
  const statusHeaders = () => (queueDeadline > 0
    ? cosy.buildHeaders(sess, '/api/v2/service/ask/queue/status', '', 'application/json')
    : null);
  let statusUsable = queueDeadline > 0;
  let statusFailures = 0;
  let queueWaitStart = 0;
  /**
   * 一轮排队等待：按上游给的 retryAfterSeconds 睡眠（夹在 [5s, 20s]，测试可
   * 注入），然后 best-effort 查一次 queue/status。返回 'retry'（用同一份
   * 加密请求体重发）或 'giveup'（预算耗尽 / 上游明说要排到预算之外——把
   * 节流错误如实交回上层，429 语义不变）。
   * 静默形态传 skipFirstSleep：掐断本身已经等过一轮沉默，立即查状态。
   */
  const queueWaitRound = async (message, origin, { skipFirstSleep = false } = {}) => {
    if (!queueWaitStart) queueWaitStart = Date.now();
    const remaining = queueDeadline - Date.now();
    if (remaining <= 0) return 'giveup';
    // 静默形态跳过首睡的前提是**真的会查状态**——statusUsable 关掉后无睡眠
    // 的盲等会变成每 6s（content deadline）紧循环重撞上游
    if (!skipFirstSleep || !statusUsable) {
      const waitMs = queuePollIntervalMs(throttleRetryMs(message));
      await sleep(Math.min(waitMs, remaining) + Math.floor(Math.random() * 250));
      if (Date.now() >= queueDeadline) return 'giveup';
    }
    // 盲等重发（没查状态也要重签名）——复用 headers 会被判 103 Duplicate
    // request，等待再久也绕不开（见 reSign 的注释）。
    reSign();
    if (!statusUsable || !origin || !activeSetId) return 'retry';
    const st = await chat.getQueueStatus(origin, statusHeaders(), {
      modelKey,
      queueType: queueTypeOf(message),
      requestId: activeSetId, // 当前修复轮自己的槽位键（首轮 = send() 下发的那份）
      agent,
    }).catch(() => null);
    // 排队等待是分钟级行为，没有日志就没法排障（实测 2026-10-30：27s 失败的
    // 请求看不到 status 返回了什么）。每轮一行，排队事件本身低频。
    console.warn(`[qoder] 排队等待 status=${st ? st.state : 'unavailable'}`
      + `${st && st.retryAfterMs > 0 ? `(retryAfter=${Math.round(st.retryAfterMs / 1000)}s)` : ''}`
      + ` 已等 ${Math.round((Date.now() - queueWaitStart) / 1000)}s/${Math.round((queueDeadline - queueWaitStart) / 1000)}s`);
    if (st == null) {
      statusFailures += 1;
      if (statusFailures >= 2) statusUsable = false;
      return 'retry';
    }
    // 早停（不重试）：见上面的 'giveup' 分支
    if (st.state === 'queued' && st.retryAfterMs > 0 && Date.now() + st.retryAfterMs > queueDeadline) {
      return 'giveup';
    }
    // 重发前必须重签名——复用 headers 会被上游判 103 Duplicate request，
    // 请求随之静默挂到内容超时（见 reSign 的注释）。
    reSign();
    return 'retry'; // released → 立即重发；unknown → 盲等重发（hub 形态）
  };

  const startedAt = Date.now();
  // 本条请求的 credits（上游 usage 直给）。流式路径逐帧扫、取最大值——
  // 上游会在多帧里重复带 usage，最后一帧才是整轮合计。
  let peakCredits = null;
  // 最后一帧的完整 usage（tokens 由此取——实测倍率 billedRate 的分母）
  let lastUsage = null;
  // 参数两种形状都收：流式路径给的是整帧（看 j.usage.credits），
  // 非流式给的是聚合后的 usage 对象本身（看 u.credits）。
  const noteCredits = (o) => {
    const u = o && o.usage ? o.usage : o;
    if (!u) return;
    const v = Number(u.credits);
    if (Number.isFinite(v)) peakCredits = peakCredits == null ? v : Math.max(peakCredits, v);
    if (u.total_tokens != null || u.prompt_tokens != null) lastUsage = u;
  };
  try {
    if (onChunk) {
      // 两个「已吐帧」标志要分清：
      //   sawUp —— 上游送来了真实数据帧（老 `sent` 的口径），错误/排队判定用
      //            它：缓冲门扣住的帧也算「上游来过数据」；
      //   sent  —— 帧已**到达下游**，err.sent 用它：缓冲里的帧没交出去，
      //            此刻换号/重试都还来得及（错误被吞、换号不被挡）。
      // `[DONE]` 是哨兵、不是上游数据帧——两把都不算，旧实现把它也算成
      // 「已吐帧」会让「一帧数据都没有」的错误被误判成已开始输出。
      let sawUp = false;
      let sent = false;
      let firstErr = null;
      let doneSeen = false;
      let gate = null;
      const candidates = constants.chatStreamCandidates(region);
      // 排队状态查询打「本次尝试实际用的主机」——队列跟着主机走
      let statusOrigin = '';
      const down = (inner) => { sent = true; onChunk(inner); };
      // 单次尝试封装：排队放行后用**同一份加密请求体**（同一个 request_set_id）
      // 原样重发，四个状态标志随之复位
      const attemptStream = () => {
        firstErr = null; sent = false; doneSeen = false; sawUp = false;
        // 识别到错误帧就立刻中止上游：Qoder 零额度时是**挂起**而不是报错，
        // 不主动断就要等 socket 空闲超时（600s），客户端早已超时。
        const ac = new AbortController();
        const deliver = gate ? (inner) => gate.onInner(inner) : down;
        const onInner = (inner) => {
          if (firstErr) return;
          // 哨兵有门时交门暂扣（finish() 收尾补发，顺序在 usage/finish 之后），
          // 无门维持「延后到状态检查之后再转发，避免先发 200 + [DONE] 再抛错」
          if (inner === '[DONE]') { doneSeen = true; if (gate) deliver(inner); return; }
          let parsed = null;
          try { parsed = JSON.parse(inner); } catch (e) { /* 非 JSON 帧照原样转发 */ }
          if (parsed) {
            const err = chat.payloadError(parsed) || quotaFrameError(parsed);
            if (err) {
              firstErr = err;
              try { ac.abort(); } catch (e) { /* 已结束 */ }
              return;
            }
            noteCredits(parsed);
          // usage 缓存字段归一化（#112）：DeepSeek/Qwen 的缓存命中数字搬到
          // 标准位 prompt_tokens_details.cached_tokens，改写发生在转发前——
          // 原样转发的话按标准协议解析的客户端读到的缓存恒为 0
          if (parsed.usage && chat.normalizeUsageCache(parsed.usage)) inner = JSON.stringify(parsed);
          }
          // 只有**过了错误判定**的帧才算「上游真实数据」——排队信封（10605）
          // 与额度错误帧必须留在 sawUp=false，否则排队等待轮的守卫失效。
          sawUp = true;
          deliver(inner);
        };
        return postWithFallback(candidates, (url) => {
          statusOrigin = new URL(url).origin;
          return chat.postStream(url, encBody, headers, onInner, { signal: ac.signal, agent });
          // 换主机的守卫用 **sawUp**（上游真的送来过数据）而不是「已到达下游」：
          // 缓冲门把正文扣住时「到达下游」恒为 false，用它会让「已经收到正文、
          // 连接随后断了」的请求去切备用主机，从而把两段内容拼在一起。
          // 连接层失败本身发生在收数据之前，sawUp 的语义正合适。
        }, () => sawUp);
      };
      // 「播报即收尾」的修复轮状态：判定在排队轮的正常出口（见下方收尾段）
      let repairAttempt = 0;
      let curPayload = payload;
      let nextRound = false;
      for (;;) {
        // 排队等待轮（官方协议）的重试会重复进这个循环体——它没拿到任何真实
        // 帧（sawUp=false），缓冲门是空的，重建无害；修复轮入口在此重建整轮
        // 状态与下一份请求体（applyRound 的重签是纯本地调用）。
        if (nextRound) {
          await applyRound(curPayload, crypto.randomUUID());  // 修复轮换新槽位键
          peakCredits = null;
          lastUsage = null;       // 每轮独立结算（每轮都是一次真实上游请求）
          nextRound = false;
        }
        gate = repairable ? repair.createChunkGate(down, true, caps.HOLD_CAP) : null;
        // 尝试可能以**异常**结束（静默形态：content deadline / read idle 掐断
        // 时 postStream reject）——不能让它在等待判定之前飞出循环
        let res = null;
        let attemptErr = null;
        try { res = await attemptStream(); } catch (e) { attemptErr = e; }
        // 排队等待判定，两种形态：
        //   信封型：错误帧 / 错误体里带 10605 / isQueued 等（带 !sawUp 守卫——
        //           吐过帧之后 raw 里有模型输出，正文讨论到 10605 不能当排队）；
        //   静默型：上游收了请求、回空 ack 然后沉默，被我们自己的计时器掐断
        //           （掐断即已等过一轮沉默，跳过首睡立即查状态）。
        const silenceForm = attemptErr && SILENCE_QUEUED_TEXT.test(String(attemptErr.message || ''));
        const throttledMsg = silenceForm ? ''
          : firstErr
            ? (queueableThrottle(firstErr.message) ? firstErr.message : '')
            : (!sawUp && res && queueableThrottle(res.raw) ? String(res.raw || '') : '');
        if ((silenceForm || throttledMsg) && !sawUp && Date.now() < queueDeadline) {
          const verdict = await queueWaitRound(
            throttledMsg || String(attemptErr.message || ''),
            statusOrigin,
            { skipFirstSleep: silenceForm },
          );
          if (verdict === 'retry') continue;
          // giveup：预算耗尽 / 上游明说要排到预算之外——落到底下的 throw，
          // 把节流错误如实交回上层（429 语义不变）。
        }
        if (attemptErr) { attemptErr.sent = sent || (gate ? gate.result().emitted > 0 : false); throw attemptErr; }
        if (firstErr) {
          const err = new Error(`qoder ${firstErr.code}: ${firstErr.message}`);
          err.statusCode = firstErr.code;
          if (firstErr.quotaKind) err.quotaKind = firstErr.quotaKind;
          // 门的 emitted 也算：reasoning 是直发的，有一帧到下游就不能再换号
          err.sent = sent || (gate ? gate.result().emitted > 0 : false);
          throw err;
        }
        // HTTP 层错误：上游 4xx/5xx 时 body 往往不是 SSE（没有 `data:` 行），
        // 上面一帧都收不到，旧实现就当成功返回 → 客户端 200 + 空响应。
        // 这里按状态码判，并从原始 body 里取上游的 message 如实报出。
        if (res.status >= 400) {
          const es = chat.envelopeStatus(res.raw);
          const detail = (es && es.message)
            || String(res.raw || '').replace(/\s+/g, ' ').trim().slice(0, 200)
            || 'upstream error';
          const err = new Error(`qoder ${res.status}: ${detail}`);
          err.statusCode = res.status;
          const qk = quotaKindOfText(String(res.raw || ''));
          if (qk) err.quotaKind = qk;
          err.sent = sent || (gate ? gate.result().emitted > 0 : false);
          throw err;
        }
        // 200 但不是 SSE：上游偶尔用 200 回一个纯错误体（provider_error 就是
        // 这种形状）。**判据是「上游一帧真实数据都没来」**，不是「没收到
        // [DONE]」——后者恒为假（postStream 总会补一个）。
        if (!sawUp) {
          // 额度类业务码（112/110/114/430）< 400，envelopeStatus/payloadError
          // 都不认——它们才是「200 + 空回答」的另一半来源，单独兜一层。
          const qf = quotaFromBody(res.raw);
          if (qf) {
            const err = new Error(`qoder ${qf.code}: ${qf.message}`);
            err.statusCode = qf.code;
            err.quotaKind = qf.quotaKind;
            err.sent = false;
            throw err;
          }
          const es = chat.envelopeStatus(res.raw);
          if (es && es.code >= 400) {
            const err = new Error(`qoder ${es.code}: ${es.message}`);
            err.statusCode = es.code;
            err.sent = false;
            throw err;
          }
        }
        // 正常收尾：哨兵有门时交给了门（finish() 收尾补发，顺序正文→usage→
        // finish→[DONE]），无门维持旧口径——「先有内容、再有结束标记」
        if (!gate && doneSeen) onChunk('[DONE]');
        meter.settle(peakCredits, { usage: lastUsage, expectedRate: billingExpectedRate(modelMeta) });
        // ----「播报即收尾」修复判定（与千问 / TRAE 同构）----
        if (!gate) return res;
        const g = gate.result();
        if (g.live || g.toolCalls > 0) { gate.finish(); return res; }          // 正常或在干活
        if (!repair.looksUnfinished(g.text, caps.HOLD_CAP)) { gate.finish(); return res; }
        if (repairAttempt >= caps.REPAIR_MAX) { gate.finish(); return res; }  // 上限到，吐给它收尾
        repairAttempt++;
        curPayload = repair.appendRepairNudge(curPayload);
        repair.logRepair('qoder', opts.reqId, repairAttempt, g.text);
        // 不 finish：本轮缓冲整轮丢弃（含暂扣的 usage / finish_reason），
        // 循环入口的 nextRound 重建门与请求体（applyRound 的重签是纯本地调用）
        nextRound = true;
        continue;
      }
    }
    // 非流式：post 聚合后一次返回，排队等待在返回前发生（客户端本来就在等
    // 完整结果，多等几秒不改变交互）。raw 只在 status>=400 时参与排队判定——
    // 200 的 raw 可能含模型正文，正文讨论到 10605 不能当成排队。
    // 「播报即收尾」的修复轮：判定在聚合出口，重试重建请求体（与流式同构）。
    let repairAttempt = 0;
    let curPayload = payload;
    let statusOrigin = '';
    for (;;) {
      let res = null;
      let attemptErr = null;
      try {
        res = await postWithFallback(
          constants.chatStreamCandidates(region),
          (url) => {
            statusOrigin = new URL(url).origin;
            return chat.post(url, encBody, headers, { agent });
          },
        );
      } catch (e) { attemptErr = e; }
      const silenceForm = attemptErr && SILENCE_QUEUED_TEXT.test(String(attemptErr.message || ''));
      const firstMsg = res && res.firstErr ? res.firstErr.message : '';
      const throttledMsg = silenceForm ? ''
        : firstMsg
          ? (queueableThrottle(firstMsg) ? firstMsg : '')
          : (res && res.status >= 400 && queueableThrottle(res.raw) ? String(res.raw || '') : '');
      if ((silenceForm || throttledMsg) && Date.now() < queueDeadline) {
        const verdict = await queueWaitRound(
          throttledMsg || String((attemptErr && attemptErr.message) || ''),
          statusOrigin,
          { skipFirstSleep: silenceForm },
        );
        if (verdict === 'retry') continue;
      }
      if (attemptErr) throw attemptErr;
      // `post` 现在会在数据块里识别错误信封并当场断流（与 postStream 同一纪律）。
      // 命中的 `firstErr` 是**最准确**的那份（带上游 code 与内层 message），
      // 优先用它——排在 envelopeStatus 之前，否则会先被 raw 的空壳信封盖掉，
      // 让 `retryAfterSeconds` / `modelKey` 这些限流判据丢掉。
      if (res.firstErr) {
      const err = new Error(`qoder ${res.firstErr.code}: ${res.firstErr.message}`);
      err.statusCode = res.firstErr.code;
      if (res.firstErr.quotaKind) err.quotaKind = res.firstErr.quotaKind;
      throw err;
    }
    const es = chat.envelopeStatus(res.raw);
    if (es && es.code >= 400) {
      const err = new Error(`qoder ${es.code}: ${es.message}`);
      err.statusCode = es.code;
      const qk = quotaKindOfText(String(res.raw || ''));
      if (qk) err.quotaKind = qk;
      throw err;
    }
    // 额度类业务码 < 400，envelopeStatus 认不出——聚合前单独兜一层，
    // 否则「零额度挂起结束后回 200 + 112 错误体」会聚合成空回答。
    const qf = quotaFromBody(res.raw);
    if (qf) {
      const err = new Error(`qoder ${qf.code}: ${qf.message}`);
      err.statusCode = qf.code;
      err.quotaKind = qf.quotaKind;
      throw err;
    }
    // 与流式路径同理：非 SSE 的 HTTP 错误体也要认，否则会聚合成一个空回答
    if (res.status >= 400) {
      const err = new Error(`qoder ${res.status}: ${String(res.raw || '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'upstream error'}`);
      err.statusCode = res.status;
      throw err;
    }
    const payloads = [];
    for (const line of String(res.raw || '').split('\n')) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') continue;
      payloads.push(...chat.unwrap(raw));
    }
    // 响应里的 model 回填**真实名**（GLM-5.3-Flash），不是内部 key：
    // 流式帧是原样转发上游的（上游恒为 "auto"），非流式这条却会把
    // gfmodel 这种代号回给客户端，两边观感不一致
    const out = chat.aggregate(payloads, (modelMeta && modelMeta.name) || modelKey);
    if (out && out.usage) noteCredits(out.usage);
    if (opts && opts.onAccount) { /* 非流式也报一次 */ }
    meter.settle(peakCredits, { usage: lastUsage, expectedRate: billingExpectedRate(modelMeta) });
    // ----「播报即收尾」修复判定（与流式同构；不带工具 / 上限到 → 原样返回）----
    if (!repairable || repairAttempt >= caps.REPAIR_MAX) return out;
    const omsg = (out.choices && out.choices[0] && out.choices[0].message) || {};
    if (Array.isArray(omsg.tool_calls) && omsg.tool_calls.length) return out;
    if (!repair.looksUnfinished(omsg.content, caps.HOLD_CAP)) return out;
    repairAttempt++;
    curPayload = repair.appendRepairNudge(curPayload);
    repair.logRepair('qoder', opts.reqId, repairAttempt, omsg.content);
    // 重试轮重建请求体（追加了消息，签名内容变了）：换新槽位键、重置每轮结算
    await applyRound(curPayload, crypto.randomUUID());
    peakCredits = null;
    lastUsage = null;
    continue;
    } // for(;;) 非流式排队重试 + 修复轮
  } catch (e) {
    // 网络错误没有 statusCode，标记一下让上层知道可以换号
    if (!e.statusCode) e.statusCode = 0;
    // max_tokens 上限自学习：上游的超限报错是 N 的唯一来源，在这里记下
    // （第一次如实报 400，之后 chat.buildBody 自动 clamp，不再踩第二次）
    const mt = /Range of max_tokens should be \[1,\s*(\d+)\]/i.exec(String(e.message || ''));
    if (mt) maxOutput.learn(region, modelKey, mt[1]);
    throw e;
  }
}

/**
 * 一次请求最多尝试几次。
 *
 * 每次尝试不一定是不同账号：上游排队是**请求级随机**的（实测同一账号挂起
 * 一次后紧接着的 5 次请求全部成功），所以「换号」不是唯一出路，等掉那几秒
 * 的短冷却再打同一个号往往就过了。MAX_ATTEMPTS 是总尝试次数上限，
 * 排队类失败会把 `tried` 清空重新轮询（见循环里的 transientOnly 分支）。
 */
const MAX_ATTEMPTS = 4;

/**
 * 排队重试的**总预算**（ms），含所有等待与请求本身。
 *
 * 2026-10-29 的结论（「等 30 秒也不保证放行，快速多试几次就交还客户端」）
 * 建立在一个当时不知道的事实上：每次重试都换了新的 request_set_id——等于
 * 每次重新排队。2026-10-30 引入官方轮询协议后（queuePollDeadline：共享
 * request_set_id + 按 retryAfterSeconds 睡眠 + queue/status 放行信号），
 * 等待有了真实的放行机制，两者并存：
 *   · 排队等待模式开启（默认）：runOnce 内按官方协议等待，本预算只兜「账号
 *     都轮过一遍后仍全是限流」的收尾场景；
 *   · 关闭（DUMATE_QODER_QUEUE_POLL=0）：回到纯快速轮询。
 *
 * 默认 6 秒。`0` 关闭（拿到限流就立刻回 429）。
 */
const QUEUE_PATIENCE_MS = Math.max(0, parseInt(process.env.DUMATE_QODER_QUEUE_PATIENCE_MS || '6000', 10) || 0);

/**
 * 排队重试的间隔（ms）。
 *
 * 实测：限流信封返回极快（150~1000ms），所以间隔不需要长——**过长的间隔
 * 恰恰是用户感知的「慢」**。原来的 3000ms 让每次空转都要多等 3 秒，
 * 5 轮就是 15 秒纯等待，实测首条请求因此耗到 27~35 秒。
 *
 * 取 1500ms：足够让上游侧翻页；再密则没有额外收益（实测连打 12 次全被拒），
 * 再疏则直接累加到用户等待（原 3000ms × 5 轮 = 15 秒纯等待）。
 */
const QUEUE_RETRY_STEP_MS = Math.max(200, parseInt(process.env.DUMATE_QODER_QUEUE_STEP_MS || '1500', 10) || 1500);

/**
 * 主循环的尝试上限。与上面两个常量匹配：6s ÷ 1.5s = 4 次。
 * 非排队类失败（换号）仍受 MAX_ATTEMPTS 约束，所以取两者较大值。
 */
const MAX_ATTEMPTS_QUEUE = Math.max(MAX_ATTEMPTS, Math.ceil(QUEUE_PATIENCE_MS / QUEUE_RETRY_STEP_MS) + 1);

/**
 * 发对话请求。主账号失败且错误「换号有救」时，按可用列表顺序转移。
 */
/**
 * 积分归因的记账器。
 *
 * 与千问/TRAE 的关键差别：**Qoder 上游直给本条请求的 credits**
 * （`倍率 × tokens/1000`），所以不用做「相邻两条的差值」——每条独立可归因，
 * 首条也有值、并发也不会串账。传 null 表示没测到，如实留空不补 0。
 */
/** 比对用的期望倍率：price_factor 为 0（错峰免费档）时按原价倍率比对——
 *  实测错峰窗口内上游按 original_price_factor 计费（credits ≈ 原价 × tokens/1000），
 *  只看 rate 会把整条通道的 billed_rate 都记成 null。 */
function billingExpectedRate(modelMeta) {
  if (!modelMeta) return null;
  if (Number.isFinite(modelMeta.rate) && modelMeta.rate > 0) return modelMeta.rate;
  if (Number.isFinite(modelMeta.rateOriginal) && modelMeta.rateOriginal > 0) return modelMeta.rateOriginal;
  return null;
}

function makeMeter(account, opts) {
  return {
    settle(credits, extra = {}) {
      try {
        require('./credits').capture(account, credits, {
          reqId: opts.reqId || '',
          model: opts.model || '',
          ms: opts.startedAt ? Date.now() - opts.startedAt : null,
          // 实测倍率（上游改路由的可见性，见 credits.computeBilledRate）
          billedRate: require('./credits').computeBilledRate(credits, extra.usage, extra.expectedRate),
        });
      } catch (e) { /* 记账失败绝不影响已发出的响应 */ }
    },
  };
}

async function send(payload, onChunk, opts = {}) {
  const tried = new Set();
  const errors = [];
  const model = payload && payload.model ? String(payload.model).replace(/^qoder\//, '') : '';
  const startedAt = Date.now();
  // 会话粘性 + 池选号（冷却/熔断/禁用/暂停/在途满跳过），见 channel-pool.js
  const sessionKey = channelPool.sessionKeyOf(payload, opts);
  const usable = authStore.findUsable();
  if (!usable.length) throw new Error('Qoder 没有可用账号，请先添加一个');
  // 排队等待预算 + 共享 request_set_id（官方轮询协议，2026-10-30）。
  // 预算是**整次请求**的（所有账号共享）——runOnce 内的排队等待受它约束，
  // 耗尽后 throttle 错误按旧路交回（换号/429）。request_set_id 在多次尝试间
  // 保持稳定：上游按它记排队槽位，每次换新值等于每次重新排队（2026-10-29
  // 「等多久都不保证放行」结论的疑似真因）。
  const queueDeadline = queuePollDeadline();
  const requestSetId = queueDeadline > 0 ? crypto.randomUUID() : '';
  const runOpts = queueDeadline > 0 ? { ...opts, queueDeadline, requestSetId } : opts;
  // FEFO 候选集只算一次（账本是静态的，轮询内不会变）
  const expiring = fefoUidSet(usable);
  let sel = channelPool.pickCandidate(CHANNEL, usable, { exclude: tried, sessionKey, model, expiring });
  if (!sel) {
    // 入口被**排队软冷却**挡住时，等掉它再试——**不能秒失败**。
    //
    // 实测（2026-10-29，端到端经 9082 打了一遍）：客户端每 3 秒发一次，
    // 每次都落在上一条留下的 5 秒模型冷却里，于是连续 4 次都在 **1~3ms**
    // 返回 429。用户看到的是「点了立刻失败」，比等 5 秒糟得多——连一次
    // 真实的上游尝试都没有。
    //
    // 排队是**请求级随机**的，冷却只有 5 秒（QUEUE_THROTTLE_COOLDOWN_MS），
    // 等掉它再发一次很可能就过了。所以这里等（封顶到重试预算），而不是
    // 直接拒。只有「禁用/熔断/在途满」这类要人介入的才立刻报 503。
    const av = channelPool.availability(CHANNEL, usable, { model });
    if (av.softOnly && av.nextInMs > 0 && av.nextInMs <= QUEUE_PATIENCE_MS) {
      await sleep(av.nextInMs);
      sel = channelPool.pickCandidate(CHANNEL, usable, { exclude: tried, sessionKey, model, expiring });
    }
    if (!sel) throw noAccountError(usable, model);
  }

  for (let i = 0; i < MAX_ATTEMPTS_QUEUE; i++) {
    const account = sel.account;
    const uid = sel.uid; // 本次尝试占用的池记录；catch 里换号后 finally 只放它
    tried.add(account.id);
    if (opts.onAccount) {
      const name = account.nickname || account.uid || `账号 ${account.id}`;
      try { opts.onAccount(name); } catch (e) { /* 上报失败不影响请求 */ }
    }
    // 每个账号一份：换号重试时归因要记到**实际成功的那个**账号上
    const meter = makeMeter(account, { ...opts, model, startedAt });
    try {
      const result = await runOnce(account, payload, onChunk, runOpts, meter);
      // 成功喂池：清熔断/软退避/防误杀计数
      channelPool.noteSuccess(CHANNEL, account.id);
      // 成功即清除上次的失败标记（与千问同一约定：一次瞬时失败不该永远挂着）
      if (account.lastError) {
        try { authStore.patch(account.id, { lastError: '' }); }
        catch (e) { /* 忽略 */ }
      }
      return result;
    } catch (e) {
      const code = Number(e.statusCode) || 0;
      const throttled = isThrottle(e.message);
      // 失败喂池：105（Login expired）按 401 进防误杀计数；额度类业务码
      // （112/110/114/430）按 poolInfoOf 的专门处置（固定冷却/不惩罚），
      // 其余按 classify。
      channelPool.noteError(CHANNEL, account.id, poolInfoOf(e, model));
      markFailure(account, e.message);
      errors.push({ account: account.nickname || account.uid || account.id, status: code || '网络错误', error: e.message, throttled, quotaKind: e.quotaKind || '' });
      if (e.sent) throw e; // 流式已吐帧，不能再换号
      if (!retryable(code, e.message, e.quotaKind)) throw e;
      sel = channelPool.pickCandidate(CHANNEL, usable, { exclude: tried, sessionKey, model, expiring });
      if (!sel) {
        // 账号都轮过一遍了。
        //
        // **不再在网关里「耐心等窗口」**（2026-10-29 实测推翻了旧结论）：
        // 排队是请求级随机，照上游给的 retryAfterSeconds 等 30 秒**并不保证
        // 放行**——连测等 10s / 30s 仍全部 stillThrottled，而间隔 20 秒的
        // 单发请求 925ms 就成功。等待全部累加到用户感知上（实测首条请求因此
        // 耗到 27~35 秒），用户看到的就是「点了半天没反应」。
        //
        // 正确做法：**快速轮询几轮，仍不行就如实回 429 交还客户端**。
        // 拿到限流信封本身只要 150~1000ms，所以多试几次成本很低；而
        // Codex / Claude Code 对 429 会自动退避重试，用户还能看到明确提示，
        // 比网关静默空转透明得多。
        const transientOnly = errors.every((x) => x.throttled || x.status === '网络错误');
        if (transientOnly && i < MAX_ATTEMPTS_QUEUE - 1 && Date.now() - startedAt < QUEUE_PATIENCE_MS) {
          // 还有预算：等一个短间隔让上游侧翻页，再按可用列表轮转。
          // **绕过 pickCandidate 的冷却过滤**——冷却只是防打爆的观测，
          // 不是上游的判决，排队期间它会挡住本该发出去的尝试。
          await sleep(QUEUE_RETRY_STEP_MS);
          tried.clear();
          const idx = i % usable.length;
          const cand = usable[idx];
          sel = cand ? { account: cand, uid: channelPool.uidOf(CHANNEL, cand.id), sessionKey } : null;
        }
        if (!sel) {
          const av2 = channelPool.availability(CHANNEL, usable, { model });
          if (av2.softOnly && av2.nextInMs > 0 && errors.every((x) => x.throttled)) {
            throw throttleError(av2.nextInMs);
          }
          break;
        }
      }
    } finally {
      channelPool.release(uid);
    }
  }

  // 带上每个账号的失败原因：只给状态码时，`(500)` / `(网络错误)` 无法区分
  // 「上游限流」「provider 挂了」「凭证失效」——排障只能去翻日志。
  const brief = (x) => {
    const m = String(x.error || '').replace(/\s+/g, ' ').trim();
    return `${x.account}(${x.status}${m ? ': ' + m.slice(0, 120) : ''})`;
  };
  const err = new Error(`Qoder 所有账号均失败：${errors.map(brief).join('；')}`);
  // 额度类业务码的类别透传到聚合错误：换号全试过之后，「额度耗尽 / 每日次数 /
  // 试用受限」之间的区别对上层（埋点、客户端提示）仍然有意义，而在
  // `errors` 里被压成一段文案就再也取不回来了。
  const lastQuotaKind = errors.length ? errors[errors.length - 1].quotaKind : '';
  if (lastQuotaKind) err.quotaKind = lastQuotaKind;
  // 全部失败都是**瞬时类**（限流或网络错误）时回 429：客户端（Codex /
  // Claude Code）对 429 会自动退避重试，对 502 只当硬失败。判据与上面
  // transientOnly 同口径——实测 2026-10-28：5 次 403 排队后夹进 1 次 DNS
  // 解析失败，只认限流的旧判据把本该 429 的响应降级成 502，客户端不再重试；
  // 而网络抖动与排队同为「换一次也许就好」的瞬时类。
  if (errors.length && errors.every((x) => x.throttled || x.status === '网络错误')) {
    err.statusCode = 429;
    err.throttled = true;
  } else {
    // 状态码 0 = 网络层失败（连接被拒/中断/首字节超时）。映射成 502 让客户端
    // 知道是上游不可用，而不是把 0 原样回出去（0 会被某些客户端当成「无错误」）。
    err.statusCode = Number(errors[errors.length - 1].status) || 502;
  }
  throw err;
}

/**
 * 选不到账号时的错误。**限流软冷却要与「禁用/熔断/在途满」区分**：
 * 前者是上游让我们等几十秒（429 + 可重试），后者要人介入（503）。
 * 混成一句话时用户只看到「Qoder 没有可用账号」，而账号本身完全健康。
 */
function noAccountError(usable, model) {
  const av = channelPool.availability(CHANNEL, usable, { model });
  if (!av.usable && av.softOnly && av.nextInMs > 0) {
    // 入口被冷却挡住时**直接报 429，不在入口 sleep**。
    //
    // 早先这里是「等掉 nextInMs 再送进主循环」，前提是「上游按时间窗口放行，
    // 等一等就能过」。实测 2026-10-29 推翻了它：排队是请求级随机，等 30 秒
    // 也不保证放行，而**在入口干等只是把这段时间加进用户等待**——实测首条
    // 请求因此耗到 27 秒。冷却本身已经降到 5 秒（QUEUE_THROTTLE_COOLDOWN_MS），
    // 客户端拿到 429 后自己的退避往往就跨过了它；真要等，交还客户端更透明。
    return throttleError(av.nextInMs);
  }
  const err = new Error('Qoder 没有可用账号（全部处于冷却/禁用/在途满，可到管理端账号池复活）');
  err.statusCode = 503;
  return err;
}

/**
 * 429：上游在排队/限流，让客户端等一会儿重试。
 * Codex 与 Claude Code 对 429 会自动退避重试，对 403/502 只当硬失败，
 * 所以这个状态码本身就是「还可救」的信号。
 */
function throttleError(nextInMs) {
  const err = new Error(`Qoder 上游限流，全部账号排队中（${Math.ceil(nextInMs / 1000)} 秒后可重试）`);
  err.statusCode = 429;
  err.throttled = true;
  err.retryAfterMs = nextInMs;
  return err;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

/**
 * 模型列表：问服务端，失败回落静态表。
 *
 * 复用 session.fetchModels（带 5 分钟缓存）——**不要在这里重写一遍拉取逻辑**，
 * 否则 model-info 与管理端会各拿一份形状不同的表。
 */
async function listModels() {
  const entries = await listModelEntries();
  return entries.map((e) => e.id.slice('qoder/'.length));
}

/**
 * 模型条目：**带真实显示名与上下文**。
 *
 * 为什么单独一个方法：`/v1/models` 要的不只是 id 列表——cc-switch 解析模型
 * 列表时读的是 `name` 字段（实测其二进制里与 `owned_by` 相邻的字段是
 * id / name / cost / contextWindow / maxContextWindow）。只给 `{id, owned_by}`
 * 的话客户端只能显示内部 key（`qoder/qfmodel`），看不出是哪个模型。
 *
 * 上下文也带上：cc-switch 会读它；声明虚高会让客户端到接近上限才压缩历史，
 * 而 Qoder 多数模型只有 180K。
 */
async function listModelEntries() {
  try {
    const account = authStore.preferred();
    if (account) {
      const r = await session.fetchModels(account);
      if (r.ok && r.models.length) {
        // 顺手告诉 model-info 上游下发的完整表（带倍率），界面据此标「上游下发」
        try { require('../model-info').setQoderModels(r.models); } catch (e) { /* 不影响返回 */ }
        return r.models.map((m) => ({
          // **id 用真实模型名**（GLM-5.3-Flash），不用内部代号（gfmodel）：
          // cc-switch 里填的是这个字段，代号根本分不清是哪个模型。
          // 两种写法都能被 resolveModelKey 解析，旧配置不受影响。
          id: `qoder/${m.name || m.key}`,
          name: m.name || m.key,
          // cc-switch 用这个值决定何时压缩历史。给**最大档**而不是默认档：
          // 上游多数模型挂着 1M 档，声明 180K 会让长会话提前压缩。
          contextWindow: m.maxInputTokens || m.contextWindow || null,
          maxContextWindow: m.maxInputTokens || m.contextWindow || null,
        }));
      }
    }
  } catch (e) { /* 拿不到就用兜底 */ }
  return constants.FALLBACK_MODELS.map((k) => ({
    id: `qoder/${k}`, name: k, contextWindow: null, maxContextWindow: null,
  }));
}

/** 账号的额度与签到（管理端用） */
function checkin(account) {
  const a = account || pickAccount();
  return checkinAndSave(a);
}

/**
 * 签到并把结果落盘到账号（`lastCheckin`）。
 *
 * 为什么要这层包装：session.checkin 是纯网络动作，不认识本地存储。而界面
 * 要回答「上次什么时候签的」——这个上游不提供（campaigns 只给当前活动的
 * claimStatus，不给领取时刻），只能本地记。与 TRAE 的 checkinAndSave 同一定位。
 *
 * 失败不打 lastError：签到失败是**瞬时**结果，写进去会让账号永久带着一个
 * 已经自愈的错误（千问/搭子的 lastError 就是这个坑）。只有确实领到了才记时间。
 */
async function checkinAndSave(account) {
  const a = account || pickAccount();
  let r;
  try {
    // 把账号传下去：签到成功时顺手写本地批次账本（过期提醒的数据源）
    r = await session.checkin(a.accessToken, a.region, { account: a });
  } catch (e) {
    return { ok: false, error: e.message, claimed: [] };
  }
  const got = (r.claimed || []).some((x) => x.ok);
  try {
    const auth = require('./auth');
    if (got) auth.patch(a.id, { lastCheckin: Date.now() });
  } catch (e) { /* 落盘失败不影响本次签到结果 */ }
  // 签到账本：某天某账号签到了（按月/按年的签到详情用它）。
  // 今天已领过（一个活动都不可领）也算「这天签过」，如实记 already。
  if (got || r.alreadyChecked) {
    ledger.append({
      channel: 'qoder', account_id: a.id, account: a.nickname || a.uid || '',
      at: Date.now(), credits: got ? r.gained : null, source: got ? 'claim' : 'already',
    });
  }
  return r;
}

function quota(account) {
  const a = account || pickAccount();
  let agent;
  try { agent = proxyAgent.getAgentFor(a); } catch (e) {
    return Promise.resolve({ ok: false, error: e.message });
  }
  return session.fetchQuota(a.accessToken, a.region, { agent });
}

module.exports = {
  warmupModels, status, send, listModels, listModelEntries, pickAccount, checkin, quota,
  chatCompletion: (p, opts) => send(p, undefined, opts),
  chatCompletionStream: (p, cb, opts) => send(p, cb, opts),
  // 额度类业务码的识别与处置（离线验证用：test/verify-qoder-throttle.js）
  quotaKindOfText, quotaFrameError, quotaFromBody, retryable, poolInfoOf,
};
