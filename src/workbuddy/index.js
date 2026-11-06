// src/workbuddy/index.js - WorkBuddy 通道对外入口
//
// 与 traework/index.js 同构：上层（server.js / upstream-router.js）只跟这个
// 文件打交道。差异：
//   - 双区域账号池（cn / global），keys 的 'intl' 在这里映射成 'global'
//   - 上游是标准 OpenAI SSE——流式块原样透传，非流式本地聚合
//   - 失败分类按 upstream.rs：hard_credit→402 / session_dead→401 /
//     soft_rate→429 / 其余按状态码
const c = require('./constants');
const chat = require('./chat');
const authStore = require('./auth');
const models = require('./models');
const billing = require('./billing');
const channelPool = require('../channel-pool');
// FEFO（临期积分优先）：数据源 expiring.js（写方是管理端 /credits；到期来自
// 套餐 CycleEndTime，见 billing.parseBeijingTime 注释）
const expiringSnap = require('../expiring');
// 「播报即收尾」共享判定与缓冲门（见 src/repair.js，四通道同一套语义）。
// WorkBuddy 上游就是标准 OpenAI chunk 流，直接用共享的 createChunkGate。
const repair = require('../repair');
const CHANNEL = 'workbuddy';

// ---------------------------------------------------------------------------
// 风控连坐保护（hub #422 社区复盘的代码化，2026-11-06 融合）
//
// **11140 不再默认换号**。原来「受限换号循环区内轮完一圈」正是 hub 实测把
// 7 个号在一次任务里全送走的路径：设备 / 出口指纹被上游扫到时，换号等于
// 把同一个指纹挨个报给风控。默认值按「宁可少服务一会儿，也别把账号送走」取：
//   DUMATE_WORKBUDDY_RESTRICTED_ROTATE_MAX   一次请求最多再换几个号（默认 0 = 不换）
//   DUMATE_WORKBUDDY_RESTRICTION_WAVE_MIN    窗口内几个不同账号被限制就整区域暂停（默认 2）
//   DUMATE_WORKBUDDY_RESTRICTION_WAVE_WINDOW 连坐判定窗口秒（默认 900）
//   DUMATE_WORKBUDDY_RESTRICTION_HOLD_SECONDS 整区域暂停秒（默认 1800；0 = 关闭）
// 暂停是进程内紧急状态（连坐场景下快速失败比持久化重要），不落盘。
const RESTRICTED_ROTATE_MAX = (() => {
  const n = parseInt(process.env.DUMATE_WORKBUDDY_RESTRICTED_ROTATE_MAX || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();
const RESTRICTION_WAVE_MIN = Math.max(1, (() => {
  const n = parseInt(process.env.DUMATE_WORKBUDDY_RESTRICTION_WAVE_MIN || '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 2;
})());
const RESTRICTION_WAVE_WINDOW_MS = Math.max(0, (() => {
  const n = parseInt(process.env.DUMATE_WORKBUDDY_RESTRICTION_WAVE_WINDOW || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 900;
})()) * 1000;
const RESTRICTION_HOLD_MS = Math.max(0, (() => {
  const n = parseInt(process.env.DUMATE_WORKBUDDY_RESTRICTION_HOLD_SECONDS || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 1800;
})()) * 1000;

const restrictionEvents = new Map(); // region -> Map(uid -> ts)
const restrictionHold = new Map();   // region -> untilMs

/** 记一次账号级风控限制；窗口内不同账号数达阈值即整区域暂停，返回暂停到的时刻（0 = 未触发） */
function noteAccountRestriction(region, uid, now = Date.now()) {
  if (RESTRICTION_HOLD_MS <= 0) return 0;
  let ev = restrictionEvents.get(region);
  if (!ev) { ev = new Map(); restrictionEvents.set(region, ev); }
  for (const [k, at] of [...ev]) {
    if (now - at > RESTRICTION_WAVE_WINDOW_MS) ev.delete(k);
  }
  ev.set(String(uid || '-'), now);
  if (ev.size < RESTRICTION_WAVE_MIN) return 0;
  const until = now + RESTRICTION_HOLD_MS;
  if (until > (restrictionHold.get(region) || 0)) restrictionHold.set(region, until);
  return until;
}

/** 区域连坐暂停剩余毫秒（0 = 没有暂停） */
function restrictionHoldRemaining(region, now = Date.now()) {
  return Math.max(0, (restrictionHold.get(region) || 0) - now);
}

/** 测试与运维观测：清空连坐状态 */
function _restrictionReset() {
  restrictionEvents.clear();
  restrictionHold.clear();
}

/**
 * send 失败处置的纯判定（可离线测）：
 *   feed    池动作：none=不喂（参数错）/ model=模型级（6004）/ account=账号级
 *   action  rotate=换号 / restrict=记连坐（默认不换号）/ refresh=先刷新重试 / throw=直接抛
 */
function errorActionOf(e) {
  if (e && e.paramError) return { feed: 'none', action: 'throw' };
  if (e && e.modelCap) return { feed: 'model', action: 'rotate' };
  if (e && e.restricted) return { feed: 'account', action: 'restrict' };
  const kind = e && (e.kind || '');
  if (kind === 'session_dead' || Number(e && e.statusCode) === 401) {
    // 刷新是第一响应（hub #441）：刷新成功 = 账号健康，喂池反而会把
    // 「token 过期」记成 session_dead 计数。刷新失败由 send 分支补喂
    return { feed: 'none', action: 'refresh' };
  }
  return { feed: 'account', action: 'throw' };
}

/** 通道是否可用：至少有一个启用且凭证完整的账号。按区域分别计数 */
function status() {
  const usable = authStore.findUsable();
  const cn = usable.filter((a) => c.normalizeRegion(a.region) === 'cn').length;
  const intl = usable.filter((a) => c.normalizeRegion(a.region) === 'global').length;
  if (!usable.length) {
    return { ready: false, loggedIn: false, error: '没有可用账号（先到账号管理导入客户端登录态或粘贴 token）', accounts: 0, cnAccounts: 0, intlAccounts: 0 };
  }
  return { ready: true, loggedIn: true, error: '', accounts: usable.length, cnAccounts: cn, intlAccounts: intl };
}

/** 按区域取可用账号（keys.region 的运行时约束：intl → global） */
function accountsForRegion(usable, region) {
  if (!region) return usable;
  const want = region === 'intl' ? 'global' : 'cn';
  return usable.filter((a) => c.normalizeRegion(a.region) === want);
}

function noRegionAccountError(region) {
  if (!region) return new Error('WorkBuddy 没有可用账号，请先到账号管理导入');
  const e = new Error(`WorkBuddy 没有可用的${region === 'intl' ? '国际' : '国内'}账号（该 API Key 或区域视图限定：${region === 'intl' ? '国际' : '国内'}）`);
  e.statusCode = 503;
  return e;
}

/** token 余量不足就先换票（失败抛错由调用方喂池） */
async function ensureFresh(a) {
  if (!authStore.needsRefresh(a)) return a;
  const r = await authStore.exchange(a);
  if (!r.ok) {
    const e = new Error(`workbuddy token 刷新失败: ${r.error}`);
    e.statusCode = 401;
    authStore.patch(a.id, { lastError: r.error });
    throw e;
  }
  return authStore.patch(a.id, r.patch) || authStore.get(a.id);
}

/** 模型列表（带区域；未预热时回落静态兜底） */
function listModels(region = 'cn') {
  return models.cachedModelIds(region);
}

async function listModelEntries(region = 'cn') {
  const r = await models.fetchModels({ region });
  if (!r.ok || !r.models.length) {
    return (region === 'global' ? [] : ['glm-5.3']).map((k) => ({
      id: `workbuddy/${k}`, name: k, contextWindow: null, maxContextWindow: null,
    }));
  }
  return r.models.map((m) => ({
    id: `workbuddy/${m.id}`,
    name: m.name || m.id,
    contextWindow: m.contextWindow,
    maxContextWindow: m.contextWindow,
  }));
}

/** 预热两区模型表（进程启动时调一次） */
function warmupModels() {
  return Promise.all([
    models.fetchModels({ region: 'cn' }).catch(() => null),
    models.fetchModels({ region: 'global' }).catch(() => null),
  ]);
}

/** 上游失败分类 → 对下游的状态码（hard_credit=402 / session_dead=401 / restricted=403 / model_cap=429 / soft=429） */
function statusOf(kind, httpStatus) {
  if (kind === 'hard_credit') return 402;
  if (kind === 'session_dead') return 401;
  if (kind === 'restricted') return 403;
  if (kind === 'model_cap') return 429;
  if (kind === 'soft_rate') return 429;
  if (kind === 'not_found') return 502;
  if (kind === 'server') return httpStatus >= 500 ? httpStatus : 502;
  return httpStatus >= 400 ? httpStatus : 400;
}

/** 响应体/错误串是否为账号级风控（11140）——换号有意义的种类 */
function isRestricted(status, body) {
  return c.classifyStatus(status, body) === 'restricted';
}

/**
 * 临期账号的池 uid 集合（accountIds 给 Set<string>，池键位是 'workbuddy:<id>'）。
 * null = FEFO 关闭 / 快照陈旧 / 窗口内无临期——走普通轮询，不报错。
 * 导出供端到端回归（verify-expiring-fefo.js；Qoder 3f 的教训——没导出的
 * 内部推导就是没测到的内部推导）。
 */
function fefoUidSet() {
  const ids = expiringSnap.accountIds(CHANNEL);
  if (!ids) return null;
  const out = new Set();
  for (const id of ids) out.add(channelPool.uidOf(CHANNEL, id));
  return out;
}

/** 模型名前置校验（缓存就绪且完全不在表中 → 400 + 可用列表；没就绪放行） */
function assertModelKnown(payload, model, region) {  const hit = models.cachedModelIds(region);
  const ready = hit && hit.length && hit[0] !== 'glm-5.3';
  if (!ready) return;
  const want = String(model || '').trim().toLowerCase();
  if (hit.some((m) => m.toLowerCase() === want)) return;
  const e = new Error(`模型 ${model} 不在 WorkBuddy ${region === 'global' ? '国际' : '国内'}模型表中。可用模型（部分）：${hit.slice(0, 8).join('、')}`);
  e.statusCode = 400;
  throw e;
}

/**
 * 发对话请求。
 * @param {object} payload OpenAI 格式请求体
 * @param {function} [onChunk] 流式回调（收 OpenAI chunk 的 JSON 串）
 * @param {object} [opts] { reqId, region('intl'|'cn'|''), onAccount(name,id) }
 */
async function send(payload, onChunk, opts = {}) {
  const rawModel = payload && payload.model ? String(payload.model) : '';
  const model = rawModel.replace(/^workbuddy\//, '') || 'auto';
  const region = opts.region === 'intl' ? 'global' : (opts.region === 'cn' ? 'cn' : '');
  assertModelKnown(payload, model, region || 'cn');

  // 区域连坐暂停检查（region 明确时在入口拦；region 空时循环内按账号区域拦）
  if (region === 'global' || region === 'cn') {
    const holdMs = restrictionHoldRemaining(region);
    if (holdMs > 0) {
      const e = new Error(`WorkBuddy ${region === 'global' ? '国际' : '国内'}区域风控连坐暂停中，${Math.ceil(holdMs / 1000)}s 后自动恢复（窗口内多个账号被限制，防设备指纹连坐）`);
      e.statusCode = 503;
      throw e;
    }
  }

  // 区域内选号 + 失败处置（errorActionOf）：
  //   11140 restricted → 默认不换号（换号=设备指纹连坐，hub #422）+ 连坐波记档
  //   401 session_dead → 先刷新 token 重试同账号（hub #441），刷新失败才判死换号
  //   6004 model_cap   → 只冷却 (账号, 模型)（scope:model 喂池），换号继续打同模型
  //   参数错误         → 不喂池不写 lastError，如实 400（hub v1.10.11 #794）
  const sessionKey = channelPool.sessionKeyOf(payload, opts);
  const usable = accountsForRegion(authStore.findUsable(), opts.region);
  if (!usable.length) throw noRegionAccountError(opts.region);
  const tried = new Set();
  const refreshTried = new Set();
  let rotated = 0;
  // FEFO：集合非空时候选先限制在临期账号内（快照由管理端 /credits 写）
  const fefo = fefoUidSet();
  let lastErr = null;
  for (let attempt = 0; attempt < usable.length; attempt++) {
    const pool = usable.filter((a) => !tried.has(a.id));
    if (!pool.length) break;
    const sel = channelPool.pickCandidate(CHANNEL, pool, { sessionKey, model, expiring: fefo });
    if (!sel) break;
    tried.add(sel.account.id);
    const { uid } = sel;
    let auth;
    try {
      auth = await ensureFresh(sel.account);
    } catch (e) {
      // 探针模式（opts.probe）不喂池：观测动作不把健康账号打成冷却
      if (!opts.probe) {
        channelPool.noteError(CHANNEL, sel.account.id, { status: Number(e.statusCode) || 0, message: e.message, model });
      }
      channelPool.release(uid);
      lastErr = e;
      continue;
    }
    const regionKey = region || c.normalizeRegion(auth.region);
    const holdMs = restrictionHoldRemaining(regionKey);
    if (holdMs > 0) {
      // 账号所在区域连坐暂停中：跳过（region 空时另一区的账号照常接）
      channelPool.release(uid);
      lastErr = lastErr || (() => { const e = new Error(`WorkBuddy ${regionKey === 'global' ? '国际' : '国内'}区域风控连坐暂停中，${Math.ceil(holdMs / 1000)}s 后自动恢复`); e.statusCode = 503; return e; })();
      continue;
    }

    const accountName = auth.nickname || auth.uid || `账号 ${auth.id}`;
    if (opts.onAccount) {
      try { opts.onAccount(accountName, auth.id); } catch (e) { /* 上报失败不影响请求 */ }
    }

    try {
      const result = await runConversation(regionKey, auth, payload, onChunk, model, opts);
      channelPool.noteSuccess(CHANNEL, auth.id);
      if (auth.lastError) {
        try { authStore.patch(auth.id, { lastError: '' }); } catch (e) { /* 清标记失败不影响请求 */ }
      }
      return result;
    } catch (e) {
      const act = errorActionOf(e);
      if (!opts.probe) {
        if (act.feed === 'model') {
          // 6004 模型级冷却：scope 透传给池（applyModelSoftCooldown），账号本身不动
          channelPool.noteError(CHANNEL, auth.id, {
            status: 429, message: e.message, model,
            scope: 'model', retryAfterMs: e.retryAfterMs,
          });
        } else if (act.feed === 'account') {
          channelPool.noteError(CHANNEL, auth.id, { status: Number(e.statusCode) || 0, message: e.message, model });
        }
        // feed==='none'：参数错误/刷新重试中——请求本身或凭证待换票，不惩罚账号
        if (act.feed !== 'none') {
          try { authStore.patch(auth.id, { lastError: e.message }); } catch (err) { /* 记不下不影响 */ }
        }
      }
      lastErr = e;
      if (act.action === 'throw') throw e;
      if (act.action === 'restrict') {
        // 11140：先记连坐波，触发整区域暂停就快速失败；否则按 ROTATE_MAX
        // 决定是否换号（默认 0 = 不换——11140 是设备/出口级风控，换号会连坐）
        noteAccountRestriction(regionKey, auth.uid || auth.id);
        const remain = restrictionHoldRemaining(regionKey);
        if (remain > 0) {
          const stop = new Error(`WorkBuddy ${regionKey === 'global' ? '国际' : '国内'}区域触发风控连坐保护：窗口内多个账号被限制，全区域暂停 ${Math.ceil(remain / 1000)}s（防设备指纹连坐，hub #422）`);
          stop.statusCode = 503;
          throw stop;
        }
        if (rotated < RESTRICTED_ROTATE_MAX) { rotated++; continue; }
        throw e;
      }
      if (act.action === 'refresh') {
        // 401 判死：先刷新 token 再换号。刷新成功 = 账号健康，同账号重试
        if (!refreshTried.has(auth.id)) {
          refreshTried.add(auth.id);
          const rr = await authStore.exchange(auth).catch(() => null);
          if (rr && rr.ok) {
            authStore.patch(auth.id, rr.patch);
            tried.delete(auth.id);
            continue;
          }
          // 刷新失败：凭证真死。此时才判死喂池 + 换下一个账号
          if (!opts.probe) {
            channelPool.noteError(CHANNEL, auth.id, { status: 401, message: e.message, model });
            try { authStore.patch(auth.id, { lastError: e.message }); } catch (err) { /* 记不下不影响 */ }
          }
          continue;
        }
        throw e;
      }
      // rotate（6004 模型级冷却）：换下一个账号继续打同模型
      continue;
    } finally {
      channelPool.release(uid);
    }
  }
  // 全部账号都试过（或全受限）：如实抛最后一个错误
  throw lastErr || noRegionAccountError(opts.region);
}

/** 一次完整对话：出站 body 规范化 → 流式透传 / 非流式聚合
 *
 * 带工具的请求启用「播报即收尾」修复（共享判定与缓冲门见 src/repair.js，
 * 与千问 / Qoder / TRAE 同一套）：
 *   - 非流式：聚合后判定，正文是「进度汇报 + 下一步」就追加修复指令重试；
 *   - 流式：正文先过缓冲门（tool_calls 一到先冲刷、超过 HOLD_CAP 转直发），
 *     判定要重试时上一轮的缓冲整轮丢弃，下游只收到重试轮的输出。
 * 判据不要放宽成「只要没有工具调用就重试」——真·收尾会被逼着再调工具。
 */
async function runConversation(region, auth, payload, onChunk, model, opts = {}) {
  // 修复配置（每通道独立的环境变量，默认 600 字 / 1 次）
  const caps = repair.envCaps('WORKBUDDY');
  const repairable = chat.hasFunctionTools(payload) > 0 && caps.REPAIR_MAX > 0;

  const budget = require('../budget');
  /** 每轮的出站 body：浅拷贝 + 模型名 + 预算（修复轮追加消息后必然重建） */
  const buildBody = (p) => {
    const body = p && typeof p === 'object' ? { ...p, model } : { ...p };
    body.max_tokens = budget.resolveWorkBuddyMaxTokens(p && p.max_tokens);
    // max_tokens 按模型目录上限收敛（hub v1.10.11 #794）：超限上游回参数错误，
    // 目录没预热 / 模型不在表时 maxOutputOf 返回 0 = 不 clamp
    const cap = models.maxOutputOf(region, model);
    if (cap > 0 && body.max_tokens > cap) body.max_tokens = cap;
    // 字符串 stop 归一化成数组（上游 Go struct 对裸字符串报参数错误）
    if (typeof body.stop === 'string' && body.stop) body.stop = [body.stop];
    return body;
  };

  /** 发一轮请求并处理 HTTP 层失败（fatal / 网络 / >=400 分类） */
  const post = async (body) => {
    const r = await chat.postStream(region, auth, body);
    if (r.fatal) throw Object.assign(new Error(r.error), { statusCode: 502 });
    if (r.status === 0 && !r.stream) throw new Error(`workbuddy 请求失败: ${r.error || 'network'}`);
    if (r.status >= 400) {
      const text = await readAll(r.stream);
      // 挑战头置前（hub #686）：APISIX 的 401 死因只在
      // `WWW-Authenticate: Bearer ..., error="invalid_token"` 里，body 可能是
      // 一页 HTML。拼进分类输入，invalid_token 随 body 判据一起可见。
      const challenge = r.headers && String(r.headers['www-authenticate'] || '');
      const classifyInput = challenge
        ? `WWW-Authenticate: ${challenge}\n${text}`
        : text;
      const kind = c.classifyStatus(r.status, classifyInput);
      // 参数错误（hub v1.10.11 #794）：请求本身的问题——换号、冷却都无意义
      if (r.status === 400 && c.PARAM_ERROR_TEXT_RE.test(text)) {
        const pe = new Error(`workbuddy 400: ${text.slice(0, 200)}`);
        pe.paramError = true;
        pe.statusCode = 400;
        throw pe;
      }
      const e = new Error(`workbuddy ${r.status}: ${text.slice(0, 200)}`);
      e.kind = kind;
      e.statusCode = statusOf(kind, r.status);
      // 受限标记：send 的处置循环靠它判定
      if (kind === 'restricted') e.restricted = true;
      if (kind === 'model_cap') {
        // 6004 模型窗口额度用满：模型级冷却 + 重置墙钟（上游写的恢复时刻，
        // 只在 6004 里出现）。send 层据 retryAfterMs 喂池（scope:model）并换号
        e.modelCap = true;
        const reset = c.parseRateLimitReset(text);
        if (reset) e.retryAfterMs = Math.max(0, reset * 1000 - Date.now());
      }
      throw e;
    }
    return r;
  };

  if (!onChunk) {
    // ---- 非流式：强制 stream 收齐再聚合（上游不接受非流式），聚合后判定 ----
    let attempt = 0;
    let curPayload = payload;
    for (;;) {
      const r = await post(buildBody(curPayload));
      const chunks = [];
      let err = null;
      await chat.readStream(r.stream, (chunk) => {
        if (chunk === null) return;
        chunks.push(chunk);
        if (chunk.error && !err) err = chunk.error;
      });
      if (err) {
        const e = new Error(`workbuddy: ${err.message || JSON.stringify(err)}`);
        e.statusCode = 502;
        throw e;
      }
      const agg = chat.aggregate(chunks, model, {
        toolNames: repair.toolNamesOf(payload),
        echoMode: repair.toolEchoMode(),
      });
      const msg = (agg.choices && agg.choices[0] && agg.choices[0].message) || {};
      const hasCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      if (hasCalls || !repairable || attempt >= caps.REPAIR_MAX
        || !repair.looksUnfinished(msg.content, caps.HOLD_CAP)) return agg;
      attempt++;
      curPayload = repair.appendRepairNudge(curPayload);
      repair.logRepair('workbuddy', opts.reqId, attempt, msg.content);
    }
  }

  // ---- 流式：正文先过缓冲门，轮末再判定是否需要修复重试 ----
  let attempt = 0;
  let curPayload = payload;
  let gate = null;
  for (;;) {
    const r = await post(buildBody(curPayload));
    // sent 只表示**真实数据帧已到达下游**（门放行才算——缓冲里的帧还没
    // 交出去，此刻换号/重试都还来得及）。[DONE] 是哨兵、不是数据帧。
    let sent = false;
    const down = (inner) => { sent = true; onChunk(inner); };
    // 每轮新开一扇门：重试轮要丢弃上一轮的缓冲（含暂扣的 usage/finish）。
    // opts 带模型与通道名：finish 阶段的 DSML fail-closed 兜底要用
    gate = repairable ? repair.createChunkGate(down, true, caps.HOLD_CAP, {
      model, channel: 'workbuddy',
      toolNames: repair.toolNamesOf(payload),
      echoMode: repair.toolEchoMode(),
    }) : null;
    const deliver = gate ? (inner) => gate.onInner(inner) : down;
    try {
      await chat.readStream(r.stream, (chunk) => {
        // 哨兵裸值交给下游桥（server.js 统一补 `data: ` 前缀并收尾）；
        // 带门时交门暂扣，finish() 在收尾补发以保证顺序在 usage/finish 之后。
        if (chunk === null) { deliver('[DONE]'); return; }
        deliver(JSON.stringify(chunk));
      });
    } catch (e) {
      // 流错误同样要把「下游是否已收到输出」标出来：reasoning 是直发的，
      // 有一帧出去了就不能再换号重来（客户端会看到两段内容）。
      if (!e.statusCode) e.sent = sent || !!(gate && gate.result().emitted > 0);
      throw e;
    }
    if (!gate) return { streamed: true };
    const g = gate.result();
    // 已转直发（正文超长 / 出现过工具调用）→ 正常一轮，收尾
    if (g.live || g.toolCalls > 0) break;
    if (!repair.looksUnfinished(g.text, caps.HOLD_CAP)) break;
    if (attempt >= caps.REPAIR_MAX) break;
    attempt++;
    curPayload = repair.appendRepairNudge(curPayload);
    repair.logRepair('workbuddy', opts.reqId, attempt, g.text);
    // 不 finish：本轮缓冲整轮丢弃（含暂扣的 usage / finish_reason），重开会新门
  }
  gate.finish();
  return { streamed: true };
}

/** 读整个流为文本（错误体用） */
function readAll(stream) {
  return new Promise((resolve) => {
    if (!stream) return resolve('');
    const { StringDecoder } = require('string_decoder');
    const dec = new StringDecoder('utf8');
    let b = '';
    stream.on('data', (x) => { b += dec.write(x); });
    stream.on('end', () => resolve(b + dec.end()));
    stream.on('error', () => resolve(b));
  });
}

/** 管理端用：签到（幂等；国际版明确不支持） */
async function checkin(account) {
  const a = await authStore.ensureFresh(account);
  const region = c.normalizeRegion(a.region);
  const st = await billing.checkinStatus(region, a);
  if (st.unsupported) return { ok: false, error: st.error, unsupported: true };
  if (st.ok && st.todayCheckedIn) return { ok: true, already: true };
  const r = await billing.checkinClaim(region, a);
  return r;
}

/** 管理端用：额度包 */
function quota(account) {
  const region = c.normalizeRegion(account.region);
  return billing.fetchCredits(region, account);
}

module.exports = {
  status, send, listModels, listModelEntries, warmupModels, checkin, quota,
  // FEFO 集合推导导出：端到端回归用（verify-expiring-fefo.js）
  fefoUidSet,
  // 风控连坐 + 失败处置（可离线测的纯函数）
  noteAccountRestriction, restrictionHoldRemaining, _restrictionReset, errorActionOf,
  chatCompletion: (p, opts) => send(p, undefined, opts),
  chatCompletionStream: (p, cb, opts) => send(p, cb, opts),
  DEFAULT_MODEL: 'auto',
};
