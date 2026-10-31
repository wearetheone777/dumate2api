// src/web-pool.js - 网页凭证账号池（token 管理 + 轮询 + 故障转移）
//
// 与本地后端链路的区别：那条路依赖 dumate-main-server.exe 且它同一时刻只有
// 一份登录态；这条路用网页 cookie 直接换 token 调云端网关，可以多账号并存。
//
// 实测（2026-09-22）：
//   GET  https://www.dumate.cn/api/dumate/app/token/get   → { token, expired_at }
//   POST https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions
//        Authorization: Bearer <token>
//   流式与非流式都可用，token 有效期约 1 小时，服务端会缓存（同一 token 同一过期时间）。
//
// 调度策略选「轮询 + 故障转移」而不是参考项目那套三因子加权随机：那套是为
// 几十上百个账号打散热点设计的，这里账号数是个位数，可预测性比打散更重要。
//
// 惩罚-恢复状态机（GAP F1,施工包 A）：冷却/熔断/防误杀/保底/在途帽全部收口到
// src/pool.js（落盘 data/pool-state.json,重启恢复）。本模块只保留 token 缓存
// 这个纯网关运行态,每次调用结果按 upstream-errors.classify 的类别喂给池：
//   成功      → pool.noteSuccess（清熔断/软退避/防误杀计数）
//   429       → 软冷却（有界指数退避,冷却中不叠加）
//   401       → session_dead 连续计数,达阈才禁用（防误杀）
//   402/余额  → 硬冷却到下一次签到窗口（B 包签到→解冻闭环可自动恢复）
//   403+模型  → (账号,模型) 级负缓存
//   5xx/网络  → 熔断计数（连续失败指数退避）
//   其余 4xx  → 不惩罚（请求本身的问题,故障转移直接终止）
// 在途帽在 callModel/callModelStream 内 acquire/release；超限返回 busy 标记,
// 故障转移据此换号而不惩罚该账号。
const https = require('https');
const crypto = require('crypto');
const accounts = require('./accounts');
const { classify } = require('./upstream-errors');
const pool = require('./pool').pool;
// per-account 出站代理（施工包 E 接线）：getAgentFor 按账号 proxy 字段 > 全局
// DUMATE_PROXY 解析，无代理返回 null（直连）。账号配了代理就绝不回退直连——
// 解析失败抛错走请求失败路径进冷却，静默回退等于把真实出口 IP 裸奔出去。
const proxyAgent = require('./proxy-agent');

const WEB_BASE = process.env.DUMATE_WEB_BASE || 'https://www.dumate.cn';
const GATEWAY_HOST = process.env.DUMATE_GATEWAY_HOST || 'dumate-svc.baidu.com';
const GATEWAY_PREFIX = '/gateway/apis/v1';
const TOKEN_TIMEOUT = 15000;

// token 提前刷新的余量：留 5 分钟，避免请求刚好压在过期点上
const REFRESH_SKEW_MS = 5 * 60 * 1000;

// 每个账号的 token 缓存（纯网关运行态,不落盘）。惩罚态/计数在 src/pool.js。
const runtime = new Map();

function stateOf(id) {
  const key = String(id);
  if (!runtime.has(key)) {
    runtime.set(key, {
      token: null,
      token_expire_at: 0,
      last_error: '',
      refreshing: null,
    });
  }
  return runtime.get(key);
}

// 上游 JSON 响应的累积上限（审计 P1-1b）：token / JSON 接口的响应都很小，
// 不设限等于把上游（或中间人）的输出全部吃进内存。超限按连接失败处理。
const MAX_JSON_RESP_BYTES = 8 * 1024 * 1024;

// agent 参数：出站代理接线（proxy-agent.getAgentFor 的产物）。null/undefined
// = 直连（Node 用默认全局 agent），传了就走 CONNECT 隧道。
function httpsJSON(hostname, path, method, headers, body, timeout = 30000, agent = null) {
  return new Promise((resolve) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        path,
        method,
        timeout,
        ...(agent ? { agent } : {}),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
          if (data.length > MAX_JSON_RESP_BYTES) {
            data = '';
            req.destroy();
            resolve({ status: 0, headers: null, json: null, raw: 'upstream response too large' });
          }
        });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (e) { json = null; }
          resolve({ status: res.statusCode, headers: res.headers, json, raw: json ? null : data.slice(0, 300) });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, headers: null, json: null, raw: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: null, json: null, raw: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

// 账号生效的出站 agent（null = 直连）。代理配置非法时抛错，调用方各自转成
// status 0 的请求失败——走既有失败路径进熔断，绝不静默回退直连（E 包契约）。
// 注意入参必须是**原始记录**（getRaw），toPublic 的 proxy 已脱敏连不了。
function agentFor(account) {
  return proxyAgent.getAgentFor(account);
}

// 取（或复用）某账号的 token。并发调用共享同一次刷新，避免同时打多个
// token 请求——服务端虽然会缓存，但并发刷新没有意义。
async function getToken(account, force = false, agent = null) {
  const st = stateOf(account.id);
  const now = Date.now();

  if (!force && st.token && st.token_expire_at - REFRESH_SKEW_MS > now) {
    return { ok: true, token: st.token, cached: true };
  }

  if (st.refreshing) return st.refreshing;

  st.refreshing = (async () => {
    let ag = agent;
    if (ag === null) {
      try { ag = agentFor(account); } catch (e) {
        return { ok: false, error: `出站代理配置错误: ${e.message}`, expired: false };
      }
    }
    const r = await httpsJSON(WEB_BASE.replace(/^https?:\/\//, ''), '/api/dumate/app/token/get',
      'GET', { Cookie: account.cookie }, null, TOKEN_TIMEOUT, ag);

    if (r.status !== 200 || !r.json || !r.json.result || !r.json.result.token) {
      const msg = r.json && r.json.message ? r.json.message : (r.raw || `HTTP ${r.status}`);
      st.last_error = `取 token 失败：${msg}`;
      return { ok: false, error: st.last_error, expired: r.status === 401 };
    }

    const res = r.json.result;
    st.token = res.token;
    // expired_at 是 ISO 时间；解析失败就按 50 分钟兜底，宁可早刷不要晚刷
    const t = res.expired_at ? Date.parse(res.expired_at) : NaN;
    st.token_expire_at = Number.isFinite(t) ? t : now + 50 * 60 * 1000;
    st.last_error = '';
    return { ok: true, token: st.token, cached: false };
  })();

  try {
    return await st.refreshing;
  } finally {
    st.refreshing = null;
  }
}

// 选下一个账号。exclude 用于故障转移时跳过本次已试过的；
// model/paid 透传给池做模型级负缓存与积分保底判据。
// 惩罚态判定（冷却/熔断/禁用/暂停/在途满/保底）全在 pool.pick,这里只提供
// 「启用账号」这个候选集。
function pick(exclude = new Set(), opts = {}) {
  const ids = accounts.load().accounts
    .filter((a) => a.enabled)
    .map((a) => a.id);
  const id = pool.pick(ids, { exclude, model: opts.model, paid: opts.paid });
  if (id == null) return null;
  return { account: accounts.getRaw(id), st: stateOf(id) };
}

// 成功即最强恢复证据：清熔断、软退避计数、401 防误杀计数。
function markSuccess(id) {
  pool.noteSuccess(id);
}

// 失败入池。info 可以是字符串（网络/未知类 → 熔断计数）或
// { status, code, message, model } —— 类别判据统一在 upstream-errors.classify,
// 类别决定池动作（软冷却/硬冷却/模型负缓存/防误杀计数/熔断）。
// 返回 true 表示本次触发了禁用（session_dead 达阈）。
function markFailure(id, info) {
  const cls = (typeof info === 'string' || info instanceof Error)
    ? classify({ status: 0, message: info instanceof Error ? info.message : info })
    : classify(info);
  return pool.noteError(id, cls);
}

// 调云端模型网关。返回 { ok, status, json, raw, account }。
// 在途帽：并发超限 fast-fail（busy 标记让故障转移换号而不惩罚该账号）。
async function callModel(account, path, method, body, opts = {}) {
  if (!pool.acquire(account.id)) {
    return { ok: false, status: 0, error: '账号在途请求已达上限', busy: true, account };
  }
  try {
    let agent;
    try { agent = agentFor(account); } catch (e) {
      return { ok: false, status: 0, error: `出站代理配置错误: ${e.message}`, account };
    }
    const t = await getToken(account, opts.forceToken, agent);
    if (!t.ok) return { ok: false, status: 401, error: t.error, expired: t.expired, account };

    const r = await httpsJSON(GATEWAY_HOST, GATEWAY_PREFIX + path, method, {
      Authorization: `Bearer ${t.token}`,
      // 与桌面客户端一致：标记来源与账号域
      'X-Dumate-Client-Type': 'web',
      'X-Dumate-Account-Id': 'global',
    }, body, opts.timeout || 600000, agent);

    // 云端网关回传的真实后端模型（X-Dumate-Gw-Realmodel）。响应头一到就
    // 回调——埋点在响应结束时落笔，等返回值链路传下去就赶不上了
    const realModel = (r.headers && r.headers['x-dumate-gw-realmodel']) || '';
    if (realModel && typeof opts.onRealModel === 'function') {
      try { opts.onRealModel(realModel); } catch (e) { /* 埋点失败不影响转发 */ }
    }

    // token 失效：强制刷一次再重试一次。不无限重试——真失效（cookie 过期）
    // 时重试再多次也没用，只会放大延迟。
    if (r.status === 401 && !opts._retried) {
      return callModel(account, path, method, body, { ...opts, forceToken: true, _retried: true });
    }

    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: r.json, raw: r.raw, headers: r.headers, account };
  } finally {
    pool.release(account.id);
  }
}

// 流式调用：把上游的 SSE 原样透传给调用方，不缓冲。
// 与 callModel 的区别是这里不做 JSON 解析——流式响应的价值就在于
// 首字能尽早到达，整体缓冲会把它变成非流式。
//
// onChunk(text) 每收到一段就回调一次（同时用于转发和累计 usage）；
// 返回 { ok, status, text, account }，text 是完整响应文本。
//
// 成败标记不在本函数做：旧实现在这里与故障转移循环各记一次，同一次失败
// 被计两遍；现在统一由带故障转移语义的调用方（callStreamWithFailover/probe）
// 喂池，直连调用方（chatlab 实验）不污染账号状态。
async function callModelStream(account, path, method, body, onChunk, opts = {}) {
  if (!pool.acquire(account.id)) {
    return { ok: false, status: 0, error: '账号在途请求已达上限', busy: true, account, streamed: true };
  }
  try {
    let agent;
    try { agent = agentFor(account); } catch (e) {
      return { ok: false, status: 0, error: `出站代理配置错误: ${e.message}`, account, streamed: true };
    }
    return await new Promise((resolve) => {
      getToken(account, opts.forceToken, agent).then((t) => {
        if (!t.ok) return resolve({ ok: false, status: 401, error: t.error, expired: t.expired, account });

        const payload = JSON.stringify(body);
        const req = https.request(
          {
            hostname: GATEWAY_HOST,
            path: GATEWAY_PREFIX + path,
            method,
            timeout: opts.timeout || 600000,
            ...(agent ? { agent } : {}),
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              Authorization: `Bearer ${t.token}`,
              'X-Dumate-Client-Type': 'web',
              'X-Dumate-Account-Id': 'global',
              'Content-Length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            // 响应头一到就回调：调用方要在「还没转发任何内容」时决定
            // 是否接受这次响应（否则只能等整条流结束，那就没法做故障转移了）
            if (typeof opts.onStatus === 'function') {
              try { opts.onStatus(res.statusCode); } catch (e) { /* 忽略 */ }
            }
            // 云端网关回传的真实后端模型（X-Dumate-Gw-Realmodel）。响应头
            // 一到就上报——埋点在流结束时落笔，晚一步就赶不上
            const realModel = res.headers['x-dumate-gw-realmodel'] || '';
            if (realModel && typeof opts.onRealModel === 'function') {
              try { opts.onRealModel(realModel); } catch (e) { /* 忽略 */ }
            }
            // text 只用于日志/usage 扫描（usage 在流的最后），转发走 onChunk。
            // 原实现全量累积（审计 P1-1c：号称「不缓冲」实际整条 SSE 又存一份），
            // 这里改为尾部固定窗口——语义不变，内存有界。
            const TEXT_TAIL = 1024 * 1024;
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => {
              text += c;
              if (text.length > TEXT_TAIL) text = text.slice(-TEXT_TAIL);
              try { onChunk(c); } catch (e) { /* 下游写失败不影响上游读取 */ }
            });
            res.on('end', () => {
              const ok = res.statusCode >= 200 && res.statusCode < 300;
              resolve({
                ok, status: res.statusCode, text, account, streamed: true,
                realModel: res.headers['x-dumate-gw-realmodel'] || '',
              });
            });
          },
        );
        req.on('error', (e) => {
          resolve({ ok: false, status: 0, error: e.message, account });
        });
        req.on('timeout', () => {
          req.destroy();
          resolve({ ok: false, status: 0, error: 'timeout', account });
        });
        req.write(payload);
        req.end();
      }).catch((e) => resolve({ ok: false, status: 0, error: e.message, account }));
    });
  } finally {
    pool.release(account.id);
  }
}

// 带故障转移的调用：从轮询位置起依次尝试，直到成功或全部失败。
async function callWithFailover(path, method, body, opts = {}) {
  const tried = new Set();
  const errors = [];
  const maxAttempts = Math.max(1, opts.maxAttempts || 3);
  // 模型名/收费标记随选号下传：模型级负缓存与积分保底都要按 (账号,模型) 判
  const model = body && body.model ? String(body.model) : (opts.model || '');

  for (let i = 0; i < maxAttempts; i++) {
    const item = pick(tried, { model, paid: opts.paid });
    if (!item) break;
    tried.add(item.account.id);

    const r = await callModel(item.account, path, method, body, opts);
    if (r.ok) {
      markSuccess(item.account.id);
      return { ...r, attempts: i + 1 };
    }

    const status = r.status || 0;
    // 在途满：不是账号的错，换下一个但不惩罚
    if (r.busy) {
      errors.push({ account: accounts.displayName(item.account), status, error: r.error });
      continue;
    }

    // 4xx（除 401/402/429）是请求本身的问题，换账号也一样失败——直接返回，
    // 不要为了一个必然失败的请求把所有账号都试一遍。
    // 402（余额耗尽）与 429（限流）是账号级状态，换号有意义，且各自进冷却域。
    if (status >= 400 && status < 500 && status !== 401 && status !== 402 && status !== 429) {
      // 400 里可能带 max_tokens 范围声明（上游按模型转发，各家不同）——
      // 顺手学习（dumate-caps.js）：认不出格式就丢弃，不影响转发
      if (status === 400) {
        try {
          require('./dumate-caps').learn(body && body.model,
            (r.json && r.json.error && r.json.error.message) || r.raw || r.error || '');
        } catch (e) { /* 学习失败不影响主流程 */ }
      }
      return { ...r, attempts: i + 1, no_retry: true };
    }

    markFailure(item.account.id, {
      status,
      code: r.json && r.json.error && r.json.error.code,
      message: r.error || (r.json && r.json.error && r.json.error.message) || `HTTP ${status}`,
      model,
    });
    errors.push({ account: accounts.displayName(item.account), status, error: r.error || r.last_error });
  }

  return {
    ok: false,
    status: errors.length ? 502 : 503,
    error: errors.length ? '所有账号均调用失败' : '没有可用账号（全部禁用或冷却中）',
    errors,
    attempts: tried.size,
  };
}

// 带故障转移的流式调用。
//
// 与 callWithFailover 的关键差别：**故障转移只能在「还没转发任何内容」时做**。
// 一旦首块已经交给客户端，就不能换账号重来——那会让客户端收到两段拼接的
// 回答。所以这里靠 opts.onStatus 在响应头到达时先判断状态码：非 2xx 就换下
// 一个账号，此时还没有 data 流过，是安全的。
//
// onChunk 一旦被调用过就视为「已提交」，后续失败只上报不重试。
async function callStreamWithFailover(path, method, body, onChunk, opts = {}) {
  const tried = new Set();
  const errors = [];
  const maxAttempts = Math.max(1, opts.maxAttempts || 3);
  const model = body && body.model ? String(body.model) : (opts.model || '');
  let committed = false;
  const guardedChunk = (c) => { committed = true; onChunk(c); };

  for (let i = 0; i < maxAttempts; i++) {
    const item = pick(tried, { model, paid: opts.paid });
    if (!item) break;
    tried.add(item.account.id);

    let accepted = false;
    const r = await callModelStream(item.account, path, method, body, guardedChunk, {
      ...opts,
      onStatus: (code) => {
        // 2xx 才接受这次响应；否则标记未接受，让下面走故障转移
        accepted = code >= 200 && code < 300;
        if (typeof opts.onStatus === 'function') { try { opts.onStatus(code); } catch (e) { /* 忽略 */ } }
      },
    });

    if (r.ok && accepted) {
      markSuccess(item.account.id);
      return { ...r, attempts: i + 1 };
    }

    const status = r.status || 0;
    const failInfo = () => ({ status, message: r.error || `HTTP ${status}`, model });

    // 已经吐过内容就不能重试了——客户端已经收到半截回答
    if (committed) {
      if (!r.busy) markFailure(item.account.id, failInfo());
      return { ...r, attempts: i + 1, committed: true };
    }

    // 在途满：不是账号的错，换下一个但不惩罚
    if (r.busy) {
      errors.push({ account: accounts.displayName(item.account), status, error: r.error });
      continue;
    }

    // 4xx（除 401/402/429）是请求本身的问题，换账号也一样失败
    if (status >= 400 && status < 500 && status !== 401 && status !== 402 && status !== 429) {
      // 与 callWithFailover 同款学习：流式失败体在 r.text 尾部窗口里
      if (status === 400) {
        try {
          require('./dumate-caps').learn(body && body.model, r.text || r.error || '');
        } catch (e) { /* 学习失败不影响主流程 */ }
      }
      return { ...r, attempts: i + 1, no_retry: true };
    }
    markFailure(item.account.id, failInfo());
    errors.push({ account: accounts.displayName(item.account), status, error: r.error });
  }

  return {
    ok: false,
    status: errors.length ? 502 : 503,
    error: errors.length ? '所有账号均调用失败' : '没有可用账号（全部禁用或冷却中）',
    errors,
    attempts: tried.size,
  };
}

// 池状态快照，供管理端展示。惩罚态/计数从 src/pool.js 读（落盘、重启恢复），
// token 缓存仍在本进程内存。旧字段（cooldown_until/fail_count/consecutive_fails）
// 按新口径继续填充,管理端展示不需要改。
function snapshot() {
  const now = Date.now();
  return accounts.load().accounts.map((a) => {
    const st = stateOf(a.id);
    const ps = pool.status(a.id);
    return {
      id: a.id,
      // 显示名统一走 displayName：占位名「账号 N」会被真实昵称顶掉
      name: accounts.displayName(a),
      nickname: a.nickname || '',
      enabled: a.enabled,
      has_token: !!st.token,
      token_expire_at: st.token_expire_at || null,
      token_expires_in_s: st.token_expire_at ? Math.max(0, Math.round((st.token_expire_at - now) / 1000)) : null,
      // 状态机视图（state: healthy|cooling|paused|disabled）
      state: ps.state,
      cooling: ps.cooling,
      cool_kind: ps.cool_kind,
      cool_remaining_s: ps.cool_remaining_s,
      cooldown_until: ps.until || 0,
      cooldown_reason: ps.cooling ? ps.cooldown_reason : '',
      disabled: ps.disabled,
      disabled_reason: ps.disabled_reason,
      paused: ps.paused,
      breaker_fails: ps.breaker_fails,
      breaker_retry_count: ps.breaker_retry_count,
      session_dead_fails: ps.session_dead_fails,
      credits: ps.credits,
      floor_blocked: ps.floor_blocked,
      in_flight: ps.in_flight,
      ok_count: ps.ok_count,
      fail_count: ps.err_total,
      consecutive_fails: ps.breaker_fails,
      last_used_at: ps.last_used_at || null,
      last_error: ps.last_error || st.last_error || '',
    };
  });
}

// 探测某个账号是否可用（管理端「测试」按钮）
async function probe(id) {
  const a = accounts.load().accounts.find((x) => x.id === Number(id));
  if (!a) return { ok: false, error: '账号不存在' };
  const t = await getToken(a, true);
  if (!t.ok) {
    // 取 token 失败也进状态机：401 类走防误杀连续计数，网络类走熔断
    markFailure(a.id, { status: t.expired ? 401 : 0, message: t.error });
    return { ok: false, error: t.error };
  }
  const r = await callModel(a, '/chat/completions', 'POST',
    { model: 'model-text', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
  if (r.ok) markSuccess(a.id);
  else markFailure(a.id, { status: r.status || 0, message: r.error || `HTTP ${r.status}`, model: 'model-text' });
  return { ok: r.ok, status: r.status, error: r.error, model: r.json && r.json.model };
}

// 清掉某账号的运行态（删除账号时调用，避免 Map 泄漏）
function forget(id) {
  runtime.delete(String(id));
}

module.exports = {
  getToken, callWithFailover, callStreamWithFailover, callModel, callModelStream,
  pick, snapshot, probe, forget,
  // 状态机喂入（task-runner 等绕过故障转移层的直连调用方也要喂,漏喂=状态机失明）
  markSuccess, markFailure,
  GATEWAY_HOST, GATEWAY_PREFIX, stateOf,
};
