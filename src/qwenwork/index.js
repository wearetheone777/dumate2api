// src/qwenwork/index.js - 千问办公通道对外入口
//
// 上层（server.js / upstream-router.js）只跟这个文件打交道，不碰 wasm、
// 凭证、COSY 签名的细节。
//
// 凭证形态（2026-09-25 改）：以前只读官方客户端的 auth-v2.dat（单账号），
// 现在改成**自持凭证账号池**（data/qwenwork-accounts.json，见 auth.js），
// 与 TRAE Work 同构。选号是「指定主账号 + 故障时转移」。
//
// 导出两个形态，与搭子路径的调用习惯对齐：
//   - chatCompletion(payload)  → 聚合后的 chat.completion 对象（非流式）
//   - chatCompletionStream(payload, onChunk) → 逐块回调 OpenAI chunk
const chat = require('./chat');
const { normalizeUsageCache } = require('../usage-norm');
const bridge = require('./bridge');
const authStore = require('./auth');
const constants = require('./constants');
const wasmPath = require('./wasm-path');
const credits = require('./credits');
const { normalizeError } = require('../errtext');
const { isThrottle } = require('../upstream-errors');
// 「播报即收尾」（共享判定与缓冲门，见 src/repair.js）
const repair = require('../repair');
const crypto = require('crypto');
// 选号接缝（集成阶段）：冷却/熔断/粘性/在途帽统一走池状态机。
// 通道在池里的 uid 键位 = 'qwenwork:<id>'（channel-pool.js 统一裁决）。
const channelPool = require('../channel-pool');
const CHANNEL = 'qwenwork';
// 出站代理工厂（E 包接线）：runOnce 按账号解析 agent
const proxyAgent = require('../proxy-agent');

// 在飞请求计数。积分归因在并发下有个本质限制：两个请求同时在飞时，
// 「前后差值」分不清是谁消耗的——总和正确，单项归属不准。
// 所以并发时如实标记 concurrent，而不是假装精确。
let inFlight = 0;

/** 预热：解析 wasm 路径。失败要早失败，别等到第一个请求才炸 */
function warmup() {
  return bridge.warmup();
}

/** 通道是否可用：签名方式就绪 + 至少有一个可用账号 */
function status() {
  const usable = authStore.findUsable();
  const mode = bridge.signer();
  // 本地签名（默认）没有任何外部依赖，只有 wasm 模式才需要探测 wasm 文件
  const w = mode === 'wasm' ? wasmPath.resolveDetailed() : null;
  const signerReady = mode === 'local' || !!w;
  return {
    ready: !!(signerReady && usable.length),
    signer: mode,
    wasm: w ? { file: w.file, version: w.version } : null,
    loggedIn: usable.length > 0,
    accounts: usable.length,
    error: !signerReady
      ? 'wasm 未找到（DUMATE_QWENWORK_USE_WASM=1 时才需要它）'
      : (usable.length ? '' : '尚未添加千问账号（需先登录一次）'),
  };
}

/**
 * 主账号。
 *
 * 顺序：preferred 标记 → 环境变量 DUMATE_QWENWORK_ACCOUNT → 第一个可用。
 * 由 authStore.preferred() 统一判定（那里也写了为什么是这个顺序）。
 *
 * **只服务辅助路径**（listModels 等不消耗会话状态的动作）。对话请求的
 * 选号走池状态机（send → channel-pool），冷却/熔断账号不会被选中；
 * 这里保持旧口径——查模型表不该因为账号在冷却里就拒绝。
 */
function pickAccount() {
  const a = authStore.preferred();
  if (!a) throw new Error('千问办公没有可用账号，请先添加一个');
  return a;
}

/**
 * 这个错误换账号还有救吗？
 *
 * 判据与 src/web-pool.js:266 同思路：4xx（除 401/402/429/403-模型不可用）是
 * 请求本身的问题，换账号也只是再失败一次，白白把每个账号都试一遍还放大延迟。
 *
 * **只按数字 code 判，绝不匹配 message**：402（额度耗尽）与 400（请求格式错）
 * 的 message 完全相同（都是 "Error in upstream response"），按 message 判会把
 * 「请求格式错」误判成「额度耗尽」，从而对全池空转一遍。
 */
function retryable(code, message) {
  const n = Number(code);
  if (!Number.isFinite(n) || n === 0) return true; // 网络错误/异常：换号试一次
  if (n === 401 || n === 402 || n === 429) return true;
  if (n === 403) {
    // 403 不能一刀切：实测那条是 "Model is not available for this user"——
    // 这是**账号维度**的（模型对该账号不可用），换账号恰恰是正确处置。
    // 其余 403（签名/权限类）换号也一样失败。
    return /not available for this user|not available|无权限|无权访问/i.test(String(message || ''));
  }
  if (n >= 500) return true; // 上游抖动，换号可能落到别的实例
  return false;
}

/** 把一次失败记到账号上（界面要能看到为什么这个号没被用） */
function markFailure(account, msg) {
  try { authStore.patch(account.id, { lastError: normalizeError(msg) }); }
  catch (e) { /* 记不下不影响主流程 */ }
}

/**
 * 用指定账号跑一次请求（非流式 / 流式由 onChunk 决定）。
 *
 * 带工具的请求启用「播报即收尾」修复（共享判定见 src/repair.js——判据、
 * 缓冲门与 TRAE 通道同一套，实测只有「检测 + 一次性重试」可靠）：
 *   - 非流式：聚合后判定，正文是「进度汇报 + 下一步」就追加修复指令重试；
 *   - 流式：正文先过缓冲门（tool_calls 一到先冲刷、超过 HOLD_CAP 转直发），
 *     判定要重试时上一轮的缓冲整轮丢弃，下游只收到重试轮的输出。
 *
 * @returns {Promise<object>} 非流式返回 chat.completion；流式返回 { streamed:true }
 */
async function runOnce(account, payload, onChunk, opts) {
  const auth = await chat.ensureAccount(authStore, account);
  const modelKey = chat.resolveModelKey(payload && payload.model);
  // 出站代理（E 包接线）：账号 proxy 字段 > 全局 DUMATE_PROXY，无代理 null 直连。
  // 千问账号记录暂无 proxy 字段（代理字段只在搭子 web 账号上），走全局默认。
  const agent = proxyAgent.getAgentFor(account);

  // 修复配置（每通道独立的环境变量，默认 600 字 / 1 次）
  const caps = repair.envCaps('QWENWORK');
  const repairable = chat.hasFunctionTools(payload) > 0 && caps.REPAIR_MAX > 0;
  // 会话 id 钉住：修复轮是同一段对话的下一句（request_id 仍是每轮新生成——
  // 它是单次请求的标识，复用可能被上游当幂等重试合并）
  const pinnedSession = (payload && payload.session_id) || crypto.randomUUID();

  /** 一个修复轮的构造与签名：追加了消息后签名内容必然变，每轮重建 */
  const buildRound = async (p) => {
    const bodyJson = chat.buildBody(modelKey, p, { sessionId: pinnedSession });
    // encode 进 worker（审计 P1-5b），签名构造不再独占事件循环
    return bridge.prepareInferAsync({
      uid: auth.uid,
      token: auth.accessToken,
      bodyJson,
      modelKey,
      // machineId 与 token 配套：登录时生成并存在账号记录里，不能用全局那份
      machineId: auth.machineId || '',
    });
  };

  /** 开一轮：在飞计数归位，返回本轮的结算器（幂等，恰好一次） */
  const beginRound = () => {
    const startedAt = Date.now();
    const wasConcurrent = inFlight > 0;
    inFlight++;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      inFlight = Math.max(0, inFlight - 1);
      // reqId 由调用方（server.js）生成，与请求埋点同源：归因要等结算，
      // 时间戳对不上，只有这个键能把两边精确配对
      credits.capture({
        account: auth,
        model: modelKey,
        startedAt,
        reqId: opts.reqId,
        concurrent: wasConcurrent,
      }).catch(() => { /* 采集失败绝不影响已发出的响应 */ });
    };
  };

  if (onChunk) {
    // ---- 流式：正文先过缓冲门，轮末再判定是否需要修复重试 ----
    let attempt = 0;
    let curPayload = payload;
    let gate = null;
    let res = null;
    for (;;) {
      const built = await buildRound(curPayload);
      const settle = beginRound();
      let firstErr = null;
      // sent 只表示**真实数据帧已到达下游**（门放行才算——缓冲里的帧还没
      // 交出去，此刻换号/重试都还来得及）。[DONE] 是哨兵、不是数据帧。
      let sent = false;
      let doneSeen = false;
      const down = (inner) => { sent = true; onChunk(inner); };
      // 每轮新开一扇门：重试轮要丢弃上一轮的缓冲（含暂扣的 usage/finish）。
      // opts 带模型与通道名：finish 阶段的 DSML fail-closed 兜底要用
      // （recovered 帧要合成 OpenAI chunk，leak 日志要通道前缀）
      gate = repairable ? repair.createChunkGate(down, true, caps.HOLD_CAP, { model: modelKey, channel: 'qwenwork' }) : null;
      const deliver = gate ? (inner) => gate.onInner(inner) : down;
      try {
        res = await chat.postStream(built.url, built.body, built.headers, (inner) => {
          // 错误帧**不能**转给下游：一旦写进 SSE，客户端会把它当数据帧收下，
          // 而 HTTP 头早已发出（恒 200），改不成 4xx 了。
          // 所以先判错、判出错误就吞掉不转发，最后统一抛出去让上层回 4xx。
          if (firstErr) return;
          // 哨兵延后到状态检查之后再转发，避免「先发 200 + [DONE] 再抛错」；
          // 有门时交门暂扣（finish() 在收尾补发，顺序保证在 usage/finish 之后）
          if (inner === '[DONE]') { doneSeen = true; if (gate) deliver(inner); return; }
          let parsed = null;
          try { parsed = JSON.parse(inner); } catch (e) { /* 非 JSON 帧照原样转发 */ }
          if (parsed) {
            const err = chat.payloadError(parsed);
            if (err) { firstErr = err; return; }
            // 缓存命中归一进标准位（usage-norm.js 头注释）：DeepSeek 系模型的
            // prompt_cache_hit_tokens 原样透传会让按标准读的客户端恒见 0。
            if (parsed.usage && normalizeUsageCache(parsed.usage)) {
              inner = JSON.stringify(parsed);
            }
          }
          deliver(inner);
        }, { agent });
      } catch (e) {
        // postStream 自己抛的是网络错误，也要收尾，否则 inFlight 会一直涨。
        // 同样要把「下游已收到输出」标出来：reasoning 是直发的，有一帧出去了
        // 就不能再换号重来（客户端会看到两段内容）。
        settle();
        if (!e.statusCode) e.sent = sent || !!(gate && gate.result().emitted > 0);
        throw e;
      }
      if (firstErr) {
        settle();
        const err = new Error(`qwenwork ${firstErr.code}: ${firstErr.message}`);
        err.statusCode = firstErr.code;
        // 「客户端是否已经收到过输出」要把门的放行也算上：正文虽然被扣在缓冲里，
        // reasoning_content 是**直发**的——只要有一帧到了下游，换号重试就会让
        // 客户端看到两段内容。
        err.sent = sent || !!(gate && gate.result().emitted > 0);
        throw err;
      }
      settle();
      if (!gate) {
        // 无门（纯对话 / 修复关闭）：与旧路径一致，[DONE] 在此处补发
        if (doneSeen) onChunk('[DONE]');
        return res;
      }
      const g = gate.result();
      // 已转直发（正文超长 / 出现过工具调用）→ 正常一轮，收尾
      if (g.live || g.toolCalls > 0) break;
      if (!repair.looksUnfinished(g.text, caps.HOLD_CAP)) break;
      if (attempt >= caps.REPAIR_MAX) break;
      attempt++;
      curPayload = repair.appendRepairNudge(curPayload);
      repair.logRepair('qwenwork', opts.reqId, attempt, g.text);
      // 不 finish：本轮缓冲整轮丢弃（含暂扣的 usage / finish_reason），重开会新门
    }
    gate.finish();
    return res;
  }

  // ---- 非流式：聚合后判定（chatlab / 聚合客户端同样能享受到修复）----
  let attempt = 0;
  let curPayload = payload;
  for (;;) {
    const built = await buildRound(curPayload);
    const settle = beginRound();
    const res = await chat.post(built.url, built.body, built.headers, { agent })
      .catch((e) => { settle(); throw e; });
    const es = chat.envelopeStatus(res.raw);
    if (es && es.code >= 400) {
      settle();
      const err = new Error(`qwenwork ${es.code}: ${es.message}`);
      err.statusCode = es.code;
      throw err;
    }
    const payloads = [];
    for (const line of String(res.raw || '').split('\n')) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') continue;
      payloads.push(...chat.unwrap(raw));
    }
    settle();
    const agg = chat.aggregate(payloads, modelKey);
    const msg = (agg.choices && agg.choices[0] && agg.choices[0].message) || {};
    const hasCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    if (hasCalls || !repairable || attempt >= caps.REPAIR_MAX
      || !repair.looksUnfinished(msg.content, caps.HOLD_CAP)) return agg;
    attempt++;
    curPayload = repair.appendRepairNudge(curPayload);
    repair.logRepair('qwenwork', opts.reqId, attempt, msg.content);
  }
}

/**
 * 一次请求最多试几个账号。
 *
 * 夹住是因为 prepareInfer 走 execFileSync（bridge.js:46）——它**阻塞整个 Node
 * 事件循环**，一次签名要独占进程几百毫秒（起 Node + 实例化 289KB wasm），
 * 期间搭子链路的请求也一起卡住。无上限重试会把搭子主链路拖垮。
 * 另有 3 次上限，但受可用账号数夹逼（只有 1 个账号时不做任何重试）。
 */
const MAX_ATTEMPTS = 3;

/**
 * 发对话请求。主账号失败且错误「换号有救」时，按可用列表顺序转移。
 *
 * 每个账号只试一次，不重复试同一个：同一账号连着失败两次几乎必然还是失败，
 * 而重试要重新签名（execFileSync），代价不小。
 *
 * bodyJson 在 runOnce 里按账号构造（签名需要该账号的 uid/token/machineId）。
 */
async function send(payload, onChunk, opts = {}) {
  const tried = new Set();
  const errors = [];
  // 上游模型名（去掉通道前缀）：池的模型级负缓存与故障喂入都按它记
  const model = payload && payload.model ? String(payload.model).replace(/^qwen\//, '') : '';
  // 会话粘性键：同一会话尽量落到同一账号（TRAE/长上下文场景省重放），
  // channel-pool 内部判定不健康即解绑换号
  const sessionKey = channelPool.sessionKeyOf(payload, opts);
  const usable = authStore.findUsable();
  if (!usable.length) throw new Error('千问办公没有可用账号，请先添加一个');

  // 选号经池状态机：冷却/熔断/禁用/暂停/在途满的账号直接跳过（不再作为
  // 主账号去撞一次失败）；全池不可用时报 503 而不是拿冷却账号空转。
  let sel = channelPool.pickCandidate(CHANNEL, usable, { exclude: tried, sessionKey, model });
  if (!sel) {
    const err = new Error('千问办公没有可用账号（全部处于冷却/禁用/在途满，可到管理端账号池复活）');
    err.statusCode = 503;
    throw err;
  }

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const account = sel.account;
    const uid = sel.uid; // 本次尝试占用的池记录；catch 里 sel 会被换号，finally 只放它
    tried.add(account.id);
    // 多账号下「这次实际用了哪个」只有这里知道，由 provider 上报给埋点。
    // 在别处猜（比如「池里的第一个」）在转移场景下必然记错。
    if (opts.onAccount) {
      const name = account.nickname || account.uid || `账号 ${account.id}`;
      // 第二个参数是账号 id：计费自检探针要按 id 回读该账号的余额差值
      // （名字可能重名）。既有调用方只取第一个参数，不受影响。
      try { opts.onAccount(name, account.id); } catch (e) { /* 上报失败不影响请求 */ }
    }

    try {
      const result = await runOnce(account, payload, onChunk, opts);
      // 成功喂池：清熔断/软退避/防误杀计数（最强恢复证据）
      channelPool.noteSuccess(CHANNEL, account.id);
      // 请求成功就把上次的失败标记清掉。**不能只在换票成功时清**——那样
      // 一次瞬时失败（上游抖动的 403）会永远挂在账号上，用户看到的是早已
      // 自愈的旧错误（2026-10-02 实测：账号页显示的 403 其实几小时前就恢复了）。
      // 只在确实有 lastError 时才写盘，避免每次成功都触发一次文件写入。
      if (account.lastError) {
        try { authStore.patch(account.id, { lastError: '' }); }
        catch (e) { /* 清标记失败不影响请求结果 */ }
      }
      return result;
    } catch (e) {
      const code = Number(e.statusCode) || 0;
      // 失败喂池：类别判定在 upstream-errors.classify，池动作按类别分发
      channelPool.noteError(CHANNEL, account.id, { status: code, message: e.message, model });
      markFailure(account, e.message);
      // 限流要单独标出来：千问的限流是 **HTTP 403 + 信封 10605**，只看状态码
      // 会把它和「签名错/无权限」混为一谈（isThrottle 才是判据）。
      errors.push({
        account: account.nickname || account.uid || account.id,
        status: code || '-',
        error: e.message,
        throttled: isThrottle(e.message),
      });
      // 流式已经吐过帧，客户端收到了半截输出，再换号会输出两遍
      if (e.sent) throw e;
      if (!retryable(code, e.message)) throw e;
      // 下一个候选仍经池选：刚失败的账号若进了冷却，这里自然跳过
      sel = channelPool.pickCandidate(CHANNEL, usable, { exclude: tried, sessionKey, model });
      if (!sel) break;
    } finally {
      // 每次尝试结束必须放还在途名额（pickCandidate 命中即占用）
      channelPool.release(uid);
    }
  }

  const brief = (x) => `${x.account}(${x.status}${
    String(x.error || '').trim() ? `: ${String(x.error).replace(/\s+/g, ' ').trim().slice(0, 120)}` : ''
  })`;
  const err = new Error(`千问办公所有账号均失败：${errors.map(brief).join('；')}`);
  // 全部失败原因都是**限流**时回 429，与 Qoder 通道同口径。
  //
  // 为什么必须在这里翻译：千问上游的限流回的是 **HTTP 403 + 信封 code 10605**，
  // 把 403 原样回给客户端，Codex / Claude Code 会当成硬失败（对 403 只报一次错、
  // 不退避重试），用户看到的就是「点了没反应」——而上游的条件其实是「稍后再来」，
  // 其信封里还带了自己的 retryAfterSeconds。429 才能让客户端自动退避重试。
  if (errors.length && errors.every((x) => x.throttled)) {
    err.statusCode = 429;
    err.throttled = true;
    // 带上最近一次限流的冷却时刻 → server.js 会翻译成 Retry-After 头，
    // 客户端退避时长才能对齐上游节奏，而不是盲退避。
    try {
      const av = channelPool.availability(CHANNEL, usable, { model });
      if (av && av.softOnly && av.nextInMs > 0) err.retryAfterMs = av.nextInMs;
    } catch (e) { /* 取不到就不带头，429 语义本身仍然正确 */ }
  } else {
    // 状态码 0 = 网络层失败（连接被拒/中断/超时）。映射成 502 让客户端知道是
    // 上游不可用，而不是把 0 原样回出去（0 会被某些客户端当成「无错误」）。
    err.statusCode = Number(errors[errors.length - 1].status) || 502;
  }
  throw err;
}

/** 模型列表：优先问服务端，失败回落静态表。用选中账号的凭证 */
async function listModels() {
  try {
    const account = await chat.ensureAccount(authStore, pickAccount());
    // **签名必须覆盖模型表自己的路径**（2026-10-31 实测）：签名串里带 pathSig，
    // 复用聊天路径的签名去打 /api/v2/model/list，上游判 Signature invalid（403）。
    // 旧实现在这里静默回落静态表——模型表从未真正来自上游。
    const sign = require('./cosy-sign');
    const sess = sign.newSession({
      uid: account.uid,
      token: account.accessToken,
      machineId: account.machineId || '',
    });
    // GET 无请求体，按空串签名（与 Qoder 的 queue/status 同一约定）
    const headers = sign.buildHeaders(sess, constants.MODELS_PATH, '', 'application/json');
    const u = new URL(constants.GATEWAY);
    const res = await new Promise((resolve, reject) => {
      const req = require('https').request({
        hostname: u.hostname,
        path: constants.MODELS_PATH,
        method: 'GET',
        headers: { ...headers, Accept: 'application/json' },
        timeout: 20000,
      }, (r) => {
        let b = '';
        r.on('data', (c) => { b += c; });
        r.on('end', () => resolve({ status: r.statusCode, raw: b }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('models timeout')));
      req.end();
    });
    if (res.status === 200) {
      const j = JSON.parse(res.raw);
      const keys = ((j && j.qwork) || []).filter((m) => m && m.enable !== false).map((m) => m.key);
      if (keys.length) {
        // 成功拉到就告诉 model-info：界面据此把上下文等字段标成「上游下发」，
        // 而不是回落静态表（两者可信度不同）
        try { require('../model-info').setQwenKeys(keys); } catch (e) { /* 不影响返回 */ }
        return keys;
      }
    }
  } catch (e) { /* 拿不到就用兜底，不阻断 */ }
  return constants.FALLBACK_MODELS.slice();
}

module.exports = {
  warmup, status, send, listModels, pickAccount,
  chatCompletion: (p, opts) => send(p, undefined, opts),
  chatCompletionStream: (p, cb, opts) => send(p, cb, opts),
};
