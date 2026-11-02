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
const CHANNEL = 'workbuddy';

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

/** 上游失败分类 → 对下游的状态码（hard_credit=402 / session_dead=401 / restricted=403 / soft=429） */
function statusOf(kind, httpStatus) {
  if (kind === 'hard_credit') return 402;
  if (kind === 'session_dead') return 401;
  if (kind === 'restricted') return 403;
  if (kind === 'soft_rate') return 429;
  if (kind === 'not_found') return 502;
  if (kind === 'server') return httpStatus >= 500 ? httpStatus : 502;
  return httpStatus >= 400 ? httpStatus : 400;
}

/** 响应体/错误串是否为账号级风控（11140）——换号有意义的种类 */
function isRestricted(status, body) {
  return c.classifyStatus(status, body) === 'restricted';
}

/** 模型名前置校验（缓存就绪且完全不在表中 → 400 + 可用列表；没就绪放行） */
function assertModelKnown(payload, model, region) {
  const hit = models.cachedModelIds(region);
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

  // 区域内选号 + **受限换号**（11140 账号级风控换号有意义，issue #136）：
  // 撞风控换区内下一个账号接替，最多轮完一圈；别卡死在受限账号上
  const sessionKey = channelPool.sessionKeyOf(payload, opts);
  const usable = accountsForRegion(authStore.findUsable(), opts.region);
  if (!usable.length) throw noRegionAccountError(opts.region);
  const tried = new Set();
  let lastErr = null;
  for (let attempt = 0; attempt < usable.length; attempt++) {
    const pool = usable.filter((a) => !tried.has(a.id));
    if (!pool.length) break;
    const sel = channelPool.pickCandidate(CHANNEL, pool, { sessionKey, model });
    if (!sel) break;
    tried.add(sel.account.id);
    const { uid } = sel;
    let auth;
    try {
      auth = await ensureFresh(sel.account);
    } catch (e) {
      channelPool.noteError(CHANNEL, sel.account.id, { status: Number(e.statusCode) || 0, message: e.message, model });
      channelPool.release(uid);
      lastErr = e;
      continue;
    }

    const accountName = auth.nickname || auth.uid || `账号 ${auth.id}`;
    if (opts.onAccount) {
      try { opts.onAccount(accountName, auth.id); } catch (e) { /* 上报失败不影响请求 */ }
    }

    try {
      const result = await runConversation(region || c.normalizeRegion(auth.region), auth, payload, onChunk, model);
      channelPool.noteSuccess(CHANNEL, auth.id);
      if (auth.lastError) {
        try { authStore.patch(auth.id, { lastError: '' }); } catch (e) { /* 清标记失败不影响请求 */ }
      }
      return result;
    } catch (e) {
      channelPool.noteError(CHANNEL, auth.id, { status: Number(e.statusCode) || 0, message: e.message, model });
      try { authStore.patch(auth.id, { lastError: e.message }); } catch (err) { /* 记不下不影响 */ }
      lastErr = e;
      // 账号级风控：换区内下一个账号接替；其余错误不换（协议/参数类换号无意义）
      if (!e.restricted) throw e;
      continue;
    } finally {
      channelPool.release(uid);
    }
  }
  // 全部账号都试过（或全受限）：如实抛最后一个错误
  throw lastErr || noRegionAccountError(opts.region);
}

/** 一次完整对话：出站 body 规范化 → 流式透传 / 非流式聚合 */
async function runConversation(region, auth, payload, onChunk, model) {
  // 输出预算：上游模型带 maxOutputTokens（模型表），客户端没给时兜底
  const body = typeof payload === 'object' && payload ? { ...payload, model } : { ...payload };
  // 预算钳制（与其它通道同一理由：reasoning 与正文抢预算）
  const budget = require('../budget');
  body.max_tokens = budget.resolveWorkBuddyMaxTokens(payload && payload.max_tokens);

  if (!onChunk) {
    // 非流式：强制 stream 收齐再聚合（上游不接受非流式）
    const chunks = [];
    let err = null;
    const r = await chat.postStream(region, auth, body);
    if (r.fatal) throw new Error(r.error);
    if (r.status === 0 && !r.stream) throw new Error(`workbuddy 请求失败: ${r.error || 'network'}`);
    if (r.status >= 400) {
      const text = await readAll(r.stream);
      const kind = c.classifyStatus(r.status, text);
      const e = new Error(`workbuddy ${r.status}: ${text.slice(0, 200)}`);
      e.statusCode = statusOf(kind, r.status);
      // 受限标记：send 的换号循环靠它判定（其余错误换号无意义）
      if (kind === 'restricted') e.restricted = true;
      throw e;
    }
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
    return chat.aggregate(chunks, model);
  }

  // 流式：块原样透传（上游已是 OpenAI 形状）；[DONE] 由本网关补
  const r = await chat.postStream(region, auth, body);
  if (r.fatal) throw Object.assign(new Error(r.error), { statusCode: 502 });
  if (r.status === 0 && !r.stream) throw new Error(`workbuddy 请求失败: ${r.error || 'network'}`);
  if (r.status >= 400) {
    const text = await readAll(r.stream);
    const kind = c.classifyStatus(r.status, text);
    const e = new Error(`workbuddy ${r.status}: ${text.slice(0, 200)}`);
    e.statusCode = statusOf(kind, r.status);
    if (kind === 'restricted') e.restricted = true;
    throw e;
  }
  await chat.readStream(r.stream, (chunk) => {
    if (chunk === null) {
      onChunk('data: [DONE]\n\n');
      return;
    }
    onChunk(JSON.stringify(chunk));
  });
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
  chatCompletion: (p, opts) => send(p, undefined, opts),
  chatCompletionStream: (p, cb, opts) => send(p, cb, opts),
  DEFAULT_MODEL: 'auto',
};
