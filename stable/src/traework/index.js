// src/traework/index.js - TRAE Work 通道对外入口
//
// 上层（server.js / upstream-router.js）只跟这个文件打交道，
// 不碰 OAuth、设备标识、SSE 聚合的细节。与 qwenwork/index.js 同构。
const c = require('./constants');
const chat = require('./chat');
const authStore = require('./auth');
const models = require('./models');
const { normalizeError } = require('../errtext');
const images = require('../images');
// 选号接缝（集成阶段）：冷却/熔断/粘性/在途帽统一走池状态机。
// 通道在池里的 uid 键位 = 'traework:<id>'（channel-pool.js 统一裁决）。
const channelPool = require('../channel-pool');
const CHANNEL = 'traework';
// FEFO（临期积分优先）：数据源 expiring.js（写方是管理端 /credits）
const expiringSnap = require('../expiring');

// 临期账号的池 uid 集合（pool 键位 'traework:<id>'）。null = 走普通轮询。
function fefoUidSet() {
  const ids = expiringSnap.accountIds(CHANNEL);
  if (!ids) return null;
  const out = new Set();
  for (const id of ids) out.add(channelPool.uidOf(CHANNEL, id));
  return out;
}

/** 通道是否可用：至少有一个启用且凭证完整的账号。按区域分别计数（2026-11-03 国际版） */
function status() {
  const usable = authStore.findUsable();
  const cn = usable.filter((a) => c.regionOf(a) === 'cn').length;
  const intl = usable.filter((a) => c.regionOf(a) === 'intl').length;
  if (!usable.length) {
    return { ready: false, loggedIn: false, error: '没有可用账号（需先登录）', accounts: 0, cnAccounts: 0, intlAccounts: 0 };
  }
  return { ready: true, loggedIn: true, error: '', accounts: usable.length, cnAccounts: cn, intlAccounts: intl };
}

/**
 * 取一个可用账号，必要时先刷新 token。
 * **只服务辅助路径**（管理端签到/额度等）。对话请求的选号走池状态机
 * （send → channel-pool），冷却/熔断账号不会被选中；签到恰恰要触达
 * 冷却账号（B 包「签到→解冻」闭环），不能被池拦截。
 */
async function pickAccount() {
  const list = authStore.findUsable();
  if (!list.length) throw new Error('traework 没有可用账号');
  return ensureFresh(list[0]);
}

/** token 余量不足就先换票（选号成功后的第一步；失败抛错由调用方喂池） */
async function ensureFresh(a) {
  if (!authStore.needsRefresh(a)) return a;
  const r = await authStore.exchange(a);
  if (!r.ok) {
    authStore.patch(a.id, { lastError: normalizeError(`刷新失败: ${r.error}`) });
    throw new Error(`traework token 刷新失败: ${r.error}`);
  }
  authStore.patch(a.id, { ...r.patch, lastError: '' });
  return authStore.get(a.id);
}

/**
 * 模型列表。
 *
 * 优先用上游下发的完整表（src/traework/models.js，带缓存）。**同步返回**是
 * 为了不破坏调用方：server.js 的 /v1/models 与 upstream-router 都是同步调它。
 * 所以这里只读缓存，未预热时回落静态表——首次请求由 warmupModels() 预热。
 */
function listModels() {
  return models.cachedModelIds();
}

/** 带元信息的模型条目（给 /v1/models 用，客户端据此显示真实模型名） */
function listModelEntries() {
  return models.cachedModelEntries();
}

/** 预热模型表（进程启动时调一次，让 /v1/models 拿到完整列表）。两区各自有账号就各预热一份 */
function warmupModels() {
  return Promise.all([
    models.fetchModels({ region: 'cn' }).catch(() => null),
    models.fetchModels({ region: 'intl' }).catch(() => null),
  ]);
}

/**
 * 跑一次上游流。
 *
 * @param {string} bodyJson 出站请求体
 * @param {object} auth 账号
 * @param {string} model 上游模型名
 * @param {function|null} emit 流式回调（收 OpenAI chunk 的 JSON 串）；为 null 即非流式
 * @param {boolean} hold 是否给正文加缓冲门（只有「带工具的流式请求」需要）
 * @returns {Promise<{events:Array, gate:object|null, streamErr:object|null, fatal:Error|null}>}
 */
async function runAttempt(bodyJson, auth, model, emit, hold, post = chat.postStream) {
  const r = await post(bodyJson, auth);
  if (!r.stream) {
    return { fatal: new Error(`traework 请求失败: ${r.error || ('HTTP ' + r.status)}`) };
  }
  if (r.status >= 400) {
    let raw = '';
    try {
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      raw = await new Promise((res) => {
        let b = '';
        r.stream.on('data', (x) => { b += dec.write(x); });
        r.stream.on('end', () => res(b + dec.end()));
      });
    } catch (e) { /* 忽略 */ }
    const err = new Error(`traework ${r.status}: ${raw.slice(0, 200)}`);
    err.statusCode = r.status;
    return { fatal: err };
  }

  const events = [];
  let streamErr = null;
  const gate = (emit && hold) ? chat.createTextGate(emit, model, true) : null;

  await chat.readStream(r.stream, (evt) => {
    events.push(evt);
    // 上游报错**不能转给下游**：流式路径的 HTTP 头早已发出（恒 200），
    // 写进去客户端会当成数据帧收下，改不成 4xx 了。所以先记下来，
    // 流结束后统一抛，让上层按错误处理。
    const e = chat.eventError(evt);
    if (e && !streamErr) streamErr = e;

    if (gate) { gate.onEvent(evt); return; }

    if (!emit) return;   // 非流式：只收集事件，聚合交给 chat.aggregate

    // 流式（未启用缓冲门）：把 output 事件转成 OpenAI chunk 形状回调出去
    if (evt.event === 'output') {
      emit(JSON.stringify(chat.toOpenAIChunk(evt, model)));
    } else if (evt.event === 'token_usage') {
      // 用量帧按 OpenAI 的 include_usage 约定补发（choices 空数组 + usage）。
      // 不补的话，流式请求在客户端与埋点里 token 恒为 0，
      // 「这轮花了多少」就再也对不上账。
      const d = evt.data || {};
      emit(JSON.stringify({
        id: 'traework', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [],
        usage: {
          prompt_tokens: d.prompt_tokens || 0,
          completion_tokens: d.completion_tokens || 0,
          total_tokens: d.total_tokens || 0,
          completion_tokens_details: { reasoning_tokens: d.reasoning_tokens || 0 },
        },
      }));
    } else if (evt.event === 'done' && evt.data && evt.data.finish_reason) {
      // 终止原因按 OpenAI 约定补一帧。翻译器靠它判 completed/length——
      // 不补的话 length 截断会被当成正常收尾，客户端无从察觉。
      // 上游给出工具调用时 done 仍报 stop（见 chat.aggregate 内注释），
      // 这里与 gate / aggregate 同口径纠正。done 是最后一个事件，
      // events 里已收齐全部 output，扫一遍即可判定。
      let fr = evt.data.finish_reason;
      if (fr === 'stop' && events.some((x) => x.event === 'output'
        && Array.isArray(x.data && x.data.tool_calls) && x.data.tool_calls.length)) {
        fr = 'tool_calls';
      }
      emit(JSON.stringify({
        id: 'traework', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: {}, finish_reason: fr }],
      }));
    }
  });

  return { events, gate, streamErr, fatal: null };
}

/** 上游报错事件 → 可抛的错误（流式与非流式共用同一套状态码口径） */
function upstreamError(streamErr) {
  const e = new Error(`traework ${streamErr.code}: ${streamErr.message}`);
  e.statusCode = streamErr.code >= 400 && streamErr.code < 600 ? streamErr.code : 400;
  e.upstreamCode = streamErr.code;
  return e;
}

/**
 * 模型名前置校验（2026-10-30，错误码实测后的产物）。
 *
 * llm_utils_chat 对未知模型名回流内 4001「param is invalid」（HTTP 200）——
 * 无信息量：客户端分不清是模型名错了还是别的参数坏了，还得白烧一次上游
 * 请求才知道。模型表缓存就绪且名字**完全不在表中**（含条目名下的自定义
 * 模型）时，网关直接 400 并列出可用模型；表没就绪或名字已知则放行，
 * 让上游当唯一的真相源（在表但不可见的模型照样透传）。
 */
function assertModelKnown(payload, model, region = '') {
  if (models.isKnownModel(model, region)) return;
  const usable = models.cachedModelIds(region || 'cn');
  const err = new Error(
    `模型 ${model} 不在 TRAE 模型表中。可用模型（部分）：${usable.slice(0, 8).join('、')}`
    + `${usable.length > 8 ? ' 等' : ''}`,
  );
  err.statusCode = 400;
  throw err;
}

/**
 * 图像输入的模型能力校验（2026-10-30 图像支持落地）。
 *
 * llm_utils_chat 对「带图像 + 非多模态模型」的上游行为未实测——与其赌上游
 * 报错或静默忽略（客户端以为发了图、模型却看不到），不如在网关侧明确拒绝。
 * 校验只挡**确知不支持**的：模型表就绪且 multimodal=false 才拦；表没就绪
 * （缓存空、拉取失败）放行——宁可不挡，也不能挡住能用的请求。
 *
 * 必须在选号之前：模型能力与账号无关，没必要为注定失败的请求占用池。
 */
async function assertImageSupport(payload, model, region = 'cn') {
  const msgs = Array.isArray(payload && payload.messages) ? payload.messages : [];
  const hasImage = msgs.some((m) => m && m.role === 'user' && images.hasImageContent(m.content));
  if (!hasImage) return;
  const meta = models.cachedMetaById(model, region);
  if (!meta || meta.multimodal) return;
  const mm = models.multimodalIds(region);
  const err = new Error(
    `模型 ${model} 不支持图像输入。可用多模态模型：${mm.slice(0, 6).join('、') || '（模型表暂不可用）'}`
    + `${mm.length > 6 ? ' 等' : ''}`,
  );
  err.statusCode = 400;
  throw err;
}

/** 按区域过滤账号（keys.region 的运行时约束）。'' = 不限；traework 账号缺省按国内 */
function accountsForRegion(usable, region) {
  if (!region) return usable;
  return usable.filter((a) => (String(a.region || 'cn').toLowerCase() === 'cn' ? 'cn' : 'intl') === region);
}

/**
 * 发对话请求。
 * @param {object} payload OpenAI 格式请求体
 * @param {function} [onChunk] 流式回调（收到解出来的 OpenAI 行）
 * @param {object} [opts] { reqId } 请求埋点的 id，用于把积分归因与日志精确配对
 */
async function send(payload, onChunk, opts = {}) {
  const rawModel = payload && payload.model ? String(payload.model) : '';
  // TRAE 宝身份（2026-11-03）：`traebao/` 前缀 → function=personal_assistant。
  // 与 traework/ **同一个账号池、同一份 Cloud-IDE-JWT 凭证、同一个后端**，
  // 差异只有对话身份——免费豁免（官方 11 月活动）绑定在 personal_assistant
  // 上（实测对照：同一请求 personal 0 credits / solo_agent_lite 0.05）。
  // 通道归属仍是 traework：池状态、埋点 channel、管理端账号卡全部复用。
  // 身份来源两处：模块直调时 payload.model 带前缀；经网关时 handleDirectChannel
  // 已把前缀剥成 route.model（reqBody.model = route.model），标记走 opts 传。
  const persona = rawModel.startsWith('traebao/') || !!opts.personalAssistant;
  if (persona) opts.personalAssistant = true;
  // TRAE 宝是国内身份（personal_assistant 的免费豁免与活动都在国内活动域），
  // 不让区域未限定的请求把它派给国际账号白撞一次上游 4001
  if (persona && opts.region !== 'cn') opts.region = 'cn';
  let model = rawModel.replace(/^(traework|traebao)\//, '');
  // 调用方的 auto 意图（剥前缀后的原始名，在 DEFAULT_MODEL 填充前判定）。
  // 不能看 payload.model——模块直调带 `traework/auto` 时它没剥前缀，
  // remote 分流会误判成显式模型（2026-11-06 真机验证抓到）。
  const isAuto = !model || model === 'auto';
  if (persona && (model === 'auto' || !model)) {
    // TRAE 宝自动档：**不传 config_name**，服务端自选（实测默认
    // deepseek-v4.1-flash__dev）。传了显式名反而换掉官方默认行为。
    model = '';
  } else if (persona) {
    // TRAE 宝的可用模型白名单（2026-11-03 实测 20 个 remote 模型逐个验证：
    // 只有 deepseek-v4.1-flash 可通，其余全部上游 4001「param is invalid」——
    // 与抓包一致：TRAE 宝的 model_config 事件就是 deepseek-v4.1-flash__dev，
    // 免费豁免绑定这个单一模型）。前置校验不烧上游请求；上游将来放开
    // 更多模型时白名单会过时——那时上游 4001 仍会兜底如实透传。
    if (model !== 'deepseek-v4.1-flash') {
      const e = new Error(
        `TRAE 宝身份（traebao/）只支持 deepseek-v4.1-flash（2026-11-03 实测，免费豁免绑定该模型）。`
        + `其他模型请走 traework/ 前缀（同一账号池，正常计费）`
      );
      e.statusCode = 400;
      throw e;
    }
  } else if (model === 'auto' || !model) {
    model = c.DEFAULT_MODEL;
  }
  // 前置校验按请求的区域限定走（'' = 未限定，两区任一命中即放行）。
  // 模型能力校验同因：区域未限定时按国内表判（与 /v1/models 的默认口径一致）。
  const region = opts.region === 'intl' ? 'intl' : (opts.region === 'cn' ? 'cn' : '');
  if (model) assertModelKnown(payload, model, region);
  await assertImageSupport(payload, model, region || 'cn');
  // 选号经池状态机：冷却/熔断/禁用/暂停/在途满跳过 + 会话粘性。
  // traework 单账号时代不做故障转移；多账号后由池提供「跳过坏号」能力，
  // 换号重试仍交给上层（一次会话内修不动模型行为问题）。
  const sessionKey = channelPool.sessionKeyOf(payload, opts);
  // 区域约束（API Key 的 region，2026-11-01）：'intl' → 只用国际账号。
  // 国际版已接入（2026-11-03）：没有国际账号时明确报出，而不是静默派给国内。
  let poolRegion = opts.region === 'intl' ? 'intl' : (opts.region === 'cn' ? 'cn' : '');
  // 模型-区域亲和（混合区域池的正确性）：glm-5.2 只在国内表、GPT 系只在
  // 国际表——不约束的话池子可能把国内模型派给国际账号，白撞一次上游。
  // 只在「有正据」时约束：该区域的模型表已就绪且**不含**此模型才算缺席；
  // 表没就绪（缓存空）不猜，维持普通轮询。deepseek-v4.1-flash 两区都有，
  // 两边都命中 → 不约束，池子按健康度选。
  if (!poolRegion && model) {
    const cnKnown = models.isKnownModel(model, 'cn');
    const intlKnown = models.isKnownModel(model, 'intl');
    if (cnKnown && !intlKnown) poolRegion = 'cn';
    else if (!cnKnown && intlKnown) poolRegion = 'intl';
  }
  // SOLO/IDE raw 链路是**纯国内**（国际 JWT 打国内 raw 端点恒 1001，真机实测
  // ——deepseek-v4.1-flash 两区都有、池把请求派给国际账号时 1001）。solo 启用
  // 且本请求会走 solo（纯文本、REMOTE=2 未接管显式模型）时强制国内选号，
  // 而不是选号后静默回落 utils_chat——那样 solo 对两区模型永远不生效。
  // 选号后若仍选中国际账号（无国内可用），soloEligible 的 region 校验回落。
  // remoteLevel/hasTools 声明在选号之后，这里用等价内联判定。
  const soloWanted = process.env.DUMATE_TRAEWORK_SOLO === '1'
    && !opts.personalAssistant && !!model
    && String(process.env.DUMATE_TRAEWORK_REMOTE || '') !== '2'
    && !(Array.isArray(payload && payload.tools) && payload.tools.length > 0);
  if (!poolRegion && soloWanted) poolRegion = 'cn';
  const usable = accountsForRegion(authStore.findUsable(), poolRegion);
  if (!usable.length) {
    const e = poolRegion === 'intl'
      ? new Error('TRAE 没有可用的国际账号（先到账号管理 → 添加账号 → 选「国际版」登录）。该请求的模型或 API Key 限定国际区域')
      : poolRegion === 'cn'
        ? new Error('traework 没有可用的国内账号')
        : new Error('traework 没有可用账号（全部处于冷却/禁用/在途满，可到管理端账号池复活）');
    e.statusCode = 503;
    throw e;
  }
  const sel = channelPool.pickCandidate(CHANNEL, usable, {
    sessionKey, model,
    // FEFO：集合非空时候选先限制在临期账号内（快照由管理端 /credits 写）
    expiring: fefoUidSet(),
  });
  if (!sel) {
    const err = new Error('traework 没有可用账号（全部处于冷却/禁用/在途满，可到管理端账号池复活）');
    err.statusCode = 503;
    throw err;
  }
  const { uid } = sel;
  let auth;
  try {
    auth = await ensureFresh(sel.account);
  } catch (e) {
    // 换票失败也进池：网络类按熔断计数，凭证失效类按防误杀计数（classify 判）。
    // 探针模式（opts.probe）不喂池——观测动作不把健康账号打成冷却。
    if (!opts.probe) {
      channelPool.noteError(CHANNEL, sel.account.id, { status: Number(e.statusCode) || 0, message: e.message, model });
    }
    channelPool.release(uid);
    throw e;
  }

  const accountName = auth.nickname || auth.uid || `账号 ${auth.id}`;
  if (opts.onAccount) {
    // 第二个参数是账号 id：计费自检探针要按 id 回读该账号的 consumed 增量
    // （名字可能重名）。既有调用方只取第一个参数，不受影响。
    try { opts.onAccount(accountName, auth.id); } catch (e) { /* 上报失败不影响请求 */ }
  }

  try {
    // Remote 链路（2026-11-01，P2-16）：DUMATE_TRAEWORK_REMOTE=1 时，**纯文本的
    // auto 档请求**走 remote（逐轮账单可查、上游自选模型）。边界刻意收窄：
    //   · 带 tools 的请求**永不收**——remote 协议没有 tools 槽（Trae2api-cn
    //     明文 "tools remain owned by the API caller"），把网关的 function
    //     calling 降级进 query 没有实测证据上游会走原生 tool_calls。
    //   · 显式模型名（2026-11-05，P2-13.1）：DUMATE_TRAEWORK_REMOTE=2 时经
    //     **manual 策略**走 remote——Trae2api-cn 实测：manual 请求省略完整
    //     custom_model 对象会被上游**静默落默认档**，所以必须带模型表的
    //     上游原始 config（models.normalize 的 customModel 字段）。
    //     表不可用/模型不在表 = 回落 utils_chat（显式名在 utils_chat 本来
    //     就能跑，没有静默换模型问题）。
    // 实际模型由 model_config 事件上报（auto 档上游自选，实测 Doubao 系）。
    const remoteLevel = process.env.DUMATE_TRAEWORK_REMOTE === '1' ? 1
      : process.env.DUMATE_TRAEWORK_REMOTE === '2' ? 2 : 0;
    const hasTools = Array.isArray(payload && payload.tools) && payload.tools.length > 0;
    // isAuto 在模型名解析处按剥前缀后的原始意图判定（本函数上方）
    // remote 链路是纯国内的（remoteBaseOf 对 intl 如实拒绝）——国际账号不走
    const remoteEligible = remoteLevel > 0 && !hasTools && c.regionOf(auth) !== 'intl'
      && (remoteLevel === 2 || isAuto);
    // level 2 的显式模型：取模型表原始 config（取不到回落 utils_chat）。
    // effortPayload：原始请求体——manual 策略下解析思考档位写入 custom_model。
    // maxMode：单次 trae_max_mode / env 开关（descriptor 硬门在 createSession）
    let remoteOpts = null;
    if (remoteEligible && remoteLevel === 2) {
      try {
        const remoteMod = require('./remote');
        const rows = await models.fetchModels({ region: c.regionOf(auth) === 'intl' ? 'intl' : 'cn' });
        const hit = (rows.models || []).find((m) => m.id === model);
        if (hit && hit.customModel) {
          remoteOpts = {
            model, strategy: 'manual', customModelRow: hit, effortPayload: payload,
            maxMode: remoteMod.maxModeRequested(model, payload),
          };
        }
      } catch (e) { /* 表不可用回落 utils_chat */ }
    }
    // SOLO/IDE raw 链路（2026-11-06，#12）：DUMATE_TRAEWORK_SOLO=1 且显式模型
    // 且模型表条目可用。**第一版只接纯文本**——tools 的原生槽形状待证据
    // （带 tools 实测上游 400，仍走 utils_chat）；纯文本在 REMOTE 开启时仍
    // 优先 remote（已验证 + 逐轮账单）。链路互斥：remote > solo(text) > utils_chat。
    // **纯国内**（与 remote 同边界）：国际 JWT 打国内 raw 端点恒 1001
    // （真机实测：deepseek-v4.1-flash 两区都有、池把请求派给国际账号时 1001）。
    let soloTransport = null;
    const soloEligible = process.env.DUMATE_TRAEWORK_SOLO === '1' && !persona && !!model
      && !remoteOpts && !hasTools && !remoteEligible && c.regionOf(auth) !== 'intl';
    if (soloEligible) {
      try {
        const rows = await models.fetchModels({ region: c.regionOf(auth) === 'intl' ? 'intl' : 'cn' });
        const hit = (rows.models || []).find((m) => m.id === model);
        if (hit && hit.customModel) {
          const solo = require('./solo');
          const fn = 'solo_agent';
          soloTransport = {
            post: (b, a) => solo.postSoloStream(b, a, fn),
            makeBody: (meta) => solo.buildBody(payload, hit, meta, { model, rawChatFunction: fn }),
          };
        }
      } catch (e) { /* 表不可用回落 utils_chat */ }
    }
    const result = remoteEligible && (remoteLevel === 1 || remoteOpts)
      ? await runRemoteConversation(auth, payload, onChunk, opts, model, remoteOpts)
      : await runConversation(auth, payload, onChunk, opts, model, soloTransport);
    // 成功喂池：清熔断/软退避/防误杀计数（修复重试属于模型行为，不算失败）
    channelPool.noteSuccess(CHANNEL, auth.id);
    // lastError 是「最近一次结果」，不是「历史故障」（qwenwork 2026-10-02 同款
    // 修复，TRAE 当年漏了这条不变量）：成功即清除。不清的话一次瞬时限流会
    // 永久挂在账号卡上——实测（2026-11-02）：测150 在 09:27 撞一次 3004 限流
    // 后又有 50 次成功请求，牌子却一直挂着，被读成「当前故障」。
    // 只在确实有 lastError 时才写盘，避免每次成功都触发一次文件写入。
    if (auth.lastError) {
      try { authStore.patch(auth.id, { lastError: '' }); }
      catch (e) { /* 清标记失败不影响请求结果 */ }
    }
    return result;
  } catch (e) {
    // 探针模式（opts.probe）不喂池、不写 lastError：错误照常上抛如实展示
    if (!opts.probe) {
      channelPool.noteError(CHANNEL, auth.id, { status: Number(e.statusCode) || 0, message: e.message, model });
      try { authStore.patch(auth.id, { lastError: normalizeError(e.message) }); } catch (err) { /* 记不下不影响 */ }
    }
    throw e;
  } finally {
    channelPool.release(uid);
  }
}

/** 档位观测：请求了档位就打一行——生效与被钳制都如实记录（Qoder P1 的
 *  教训：档位静默丢失用户无感，排障时无从下手） */
function logRemoteEffort(effort, model) {
  if (!effort || !effort.requested) return;
  console.log(effort.level
    ? `[traework] remote 思考档位 ${effort.level}（请求 ${effort.requested}，model=${model || 'auto'}）`
    : `[traework] remote 思考档位未生效：模型 descriptor 不支持 ${effort.requested}（model=${model || 'auto'}），上游落默认档`);
}

/** 1M Max 观测：请求了 max 就打一行——descriptor 没声明时如实说明 */
function logRemoteMax(maxMode, model) {
  if (!maxMode || !maxMode.requested) return;
  console.log(maxMode.applied
    ? `[traework] remote 1M Max 已启用（model=${model}，descriptor 显式声明 max_mode）`
    : `[traework] remote 1M Max 未启用：模型 descriptor 未声明 max_mode（model=${model}），按普通档执行`);
}

/**
 * Remote 链路的一次完整对话。auto 档（model 为空 = 上游自选）或显式模型
 * （remoteOpts.strategy='manual'，Trae2api-cn：省略完整 custom_model 会被
 * 上游静默落默认档）。事件形状见 remote.js 顶部注释。
 * 不做「播报即收尾」修复（remote 是执行型会话，观测形态不同，未实测不预编）；
 * 不做换号重试（会话粘在选定的账号上，失败如实抛给上层）。
 */
async function runRemoteConversation(auth, payload, onChunk, opts, model, remoteOpts) {
  const remote = require('./remote');
  const startedAt = Date.now();
  // turnId（2026-11-06）：remote 的记账键是创建会话返回的 message_id，settle
  // 前就已可知——直接传给 capture 落 turn_id + 异步查逐轮精确扣费。
  // 失败轮也传（事件流中途 error 时扣费可能已发生，messageId 失败分支同样有）
  const settle = (turnId) => {
    require('./credits')
      .capture(auth, { reqId: opts.reqId, model, startedAt, ...(turnId ? { turnId } : {}) })
      .catch(() => { /* 采集失败绝不影响已发出的响应 */ });
  };
  const messages = Array.isArray(payload && payload.messages) ? payload.messages : [];
  // createSession 的策略参数：auto 档 model 留空（上游自选）；manual 带请求
  // 模型 + 原始 config（bound 校验在 remote.manualFieldsOf 里，失败明确报错）
  const sessionOpts = remoteOpts && remoteOpts.strategy === 'manual'
    ? { messages, model: remoteOpts.model, mode: 'code', strategy: 'manual', customModelRow: remoteOpts.customModelRow }
    : { messages, model: '', mode: 'code' };
  const turnIdReport = (messageId) => {
    // Remote 的逐轮账单键是**创建会话返回的 message_id**（2026-11-01 真机实测：
    // 拿它查 get_session_usage 返回真实 amount_float 与明细——utils_chat 链路
    // 拿不到的 turn id 在这条链路上有）。计费自检探针经此自动切精确口径。
    if (opts.onTurnId && messageId) {
      try { opts.onTurnId(messageId, auth); } catch (e) { /* 上报失败不影响响应 */ }
    }
  };

  // ---- 非流式：聚合整轮 ----
  if (!onChunk) {
    const r = await remote.runTurn(auth, sessionOpts);
    settle(r.messageId);
    if (!r.ok) {
      const e = new Error(r.error);
      e.statusCode = Number(r.status) || 502;
      throw e;
    }
    logRemoteEffort(r.effort, sessionOpts.model);
    logRemoteMax(r.maxMode, sessionOpts.model);
    turnIdReport(r.messageId);
    return r.aggregate;
  }

  // ---- 流式：plan_item 快照 → content/reasoning delta，usage/finish 补帧 ----
  const text = remote.textAccumulator();
  const reasoning = remote.textAccumulator();
  const chunk = (delta, finishReason) => JSON.stringify({
    id: 'traework', object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finishReason || null }],
  });
  let errData = null;
  let finishData = null;
  const cs = await remote.createSession(auth, sessionOpts);
  if (!cs.ok) {
    const e = new Error(cs.error);
    e.statusCode = Number(cs.status) || 502;
    throw e;
  }
  logRemoteEffort(cs.effort, sessionOpts.model);
  logRemoteMax(cs.maxMode, sessionOpts.model);
  const sr = await remote.streamEvents(auth, cs.sessionId, cs.messageId, (ev) => {
    const d = ev.data || {};
    if (ev.event === 'plan_item') {
      const td = text.push(d.thought);
      if (td) onChunk(chunk({ content: td }));
      const rd = reasoning.push(d.reasoning_content);
      if (rd) onChunk(chunk({ reasoning_content: rd }));
    } else if (ev.event === 'token_usage') {
      // 缓存字段透传与聚合出口同口径（remoteUsageOf：读命中镜像标准位、写缓存平铺）
      onChunk(JSON.stringify({
        id: 'traework', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
        choices: [],
        usage: remote.remoteUsageOf(d),
      }));
    } else if (ev.event === 'done') {
      finishData = d;
      // remote 的 done.status 实测恒 "completed"；非 completed 在流后抛错
      onChunk(chunk({}, 'stop'));
    } else if (ev.event === 'error') {
      errData = d;
    }
  }, {});
  settle(cs.messageId);
  if (errData) {
    const e = new Error(`traework remote ${errData.code || ''}: ${errData.message || '上游错误'}`);
    e.statusCode = 502;
    throw e;
  }
  if (!sr.ok) {
    const e = new Error(sr.error);
    e.statusCode = 502;
    throw e;
  }
  turnIdReport(cs.messageId);
  // 返回值与 runConversation 的流式返回对齐：聚合形状（调用方只用其存在性）
  const agg = remote.aggregateEvents([], model);
  agg.choices[0].message.content = text.value();
  agg.usage = null;
  return agg;
}

/**
 * 一次完整对话（原 send 主体）：选号之后的事——构造请求体、修复重试、
 * 积分归因采集。成败喂池统一在 send 里做，这里不碰池。
 *
 * transport（2026-11-06，#12）：SOLO/IDE raw 链路的接缝——
 *   { post: (bodyJson, auth) => stream, makeBody: (meta) => {body}|{error} }
 *   post 换成 solo.postSoloStream（端点候选链内聚在 solo.js），makeBody 延迟
 *   构造 raw 请求体（meta.sessionId 账单键在本函数内生成后回传给调用方的
 *   turnId 上报）。null = utils_chat（默认）。
 */
async function runConversation(auth, payload, onChunk, opts, model, transport = null) {
  const meta = {};
  // persona（TRAE 宝）模式下 model 为空 = 自动档：buildBody 不写 config_name。
  // 埋点/账本的 model 字段用 'traebao/auto' 占位（空串会让归因行没法归因模型），
  // 协议体里保持无 config_name——显示名与协议名分开，别混。
  const persona = !!opts.personalAssistant;
  let body;
  if (transport && transport.makeBody) {
    const built = transport.makeBody(meta);
    if (built.error) {
      const e = new Error(built.error);
      e.statusCode = 400;
      throw e;
    }
    body = built.body;
  } else {
    body = chat.buildBody(payload, model, meta, { persona });
  }
  const post = (transport && transport.post) || chat.postStream;
  const ledgerModel = persona && !model ? 'traebao/auto' : model;
  const startedAt = Date.now();

  // 账号上报已在 send 里做过（选号完成即上报），这里只管发请求与采集。

  // 积分归因：**必须在请求完成后**采集（请求要几秒，提前读会读到没结算的状态）。
  // 不 await —— 采集在响应发出后进行，不占请求延迟。
  // 记的是**本次实际使用的账号**（send 经池选出的那个），多账号下
  // 「池里的第一个」与「实际用的那个」不是一回事。
  // turnId（2026-11-06）：buildBody 主动写的 session_id 是**请求级账单键**
  // （上游按请求体 session_id 累计商业账单——Trae2api-cn 对旧版端点的实测；
  // persona 链路 2026-11-03 同款实测）。buildBody 后即可知，两条 utils_chat
  // 链路（persona/solo_work_lite）统一传；remote 链路用 message_id。
  // 修复轮共用同一账单键，查回的是该序列的累计扣费，如实记录。
  const ledgerTurnId = meta.sessionId || null;
  const settle = () => {
    require('./credits')
      .capture(auth, {
        reqId: opts.reqId, model: ledgerModel, startedAt,
        ...(ledgerTurnId ? { turnId: ledgerTurnId } : {}),
      })
      .catch(() => { /* 采集失败绝不影响已发出的响应 */ });
  };

  // ---- 非流式：聚合整轮，同样做「播报即收尾」修复 ----
  if (!onChunk) {
    let attempt = 0;
    let curBody = body;
    let agg = null;
    let fatal = null;
    let lastEvents = null;
    for (;;) {
      const r = await runAttempt(curBody, auth, ledgerModel, null, false, post);
      settle();
      if (r.fatal) { fatal = r.fatal; break; }
      if (r.streamErr) { fatal = upstreamError(r.streamErr); break; }
      lastEvents = r.events;
      agg = chat.aggregate(r.events, ledgerModel);
      const msg = (agg.choices && agg.choices[0] && agg.choices[0].message) || {};
      const hasCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      if (hasCalls || !needsRepair(meta, msg.content) || attempt >= chat.REPAIR_MAX) break;
      attempt++;
      const nudged = chat.withRepairNudge(curBody);
      if (!nudged) break;
      curBody = nudged;
      logRepair(opts.reqId, attempt, msg.content);
    }
    if (fatal) throw fatal;
    // 逐轮账单的 turn id（计费自检探针用）：取**最终那一轮**的 id，
    // 修复轮的请求已重建，前面几轮的 id 与本次交付内容无关。
    // buildBody 主动写的 meta.sessionId 是请求级账单键（两条 utils_chat
    // 链路统一，2026-11-06 真机实测非 persona 查它返回真实 credits）；
    // 流事件里若还有 reply_to_message_id/user_message_id 则优先取它
    // （turnIdOf 的语义不变，session_id 只兜底——与 10-31「不拿 session_id
    // 兜底」的区别：那是流 metadata 里上游自分配的 id，这里是主动写的键）。
    if (opts.onTurnId) {
      try {
        const tid = chat.turnIdOf(lastEvents) || (meta.sessionId || null);
        if (tid) opts.onTurnId(tid, auth);
      } catch (e) { /* 上报失败不影响响应 */ }
    }
    return agg;
  }

  // ---- 流式：正文先缓冲，整轮结束再判定是否需要重试 ----
  // 详见 src/traework/chat.js 顶部「播报即收尾」的实测数据。
  let attempt = 0;
  let curBody = body;
  let res = null;
  for (;;) {
    res = await runAttempt(curBody, auth, ledgerModel, onChunk, needsRepair(meta, ''), post);
    settle();
    if (res.fatal || res.streamErr) break;
    if (!res.gate) break;
    const g = res.gate.result();
    // 已经转为直发（正文超长 / 出现过工具调用）→ 这是正常一轮，收尾
    if (g.live || g.toolCalls > 0) break;
    if (!chat.looksUnfinished(g.text)) break;
    if (attempt >= chat.REPAIR_MAX) break;
    attempt++;
    const nudged = chat.withRepairNudge(curBody);
    if (!nudged) break;
    curBody = nudged;
    logRepair(opts.reqId, attempt, g.text);
  }

  // finish() 内的 DSML fail-closed（leak 分支）会抛错：reasoning 帧此前已直发
  // （缓冲门对 reasoning 不扣），必须如实标 sent，否则上层会当成「没开始输出」
  // 而换号重试——客户端就会看到两段内容。
  if (res && res.gate) {
    try {
      res.gate.finish();
    } catch (e) {
      e.sent = true;
      throw e;
    }
  }
  if (res && res.fatal) throw res.fatal;
  if (res && res.streamErr) throw upstreamError(res.streamErr);
  // TRAE 宝流式同样上报 session_id（见非流式分支的注释——上游按它记账，
  // 计费自检的精确口径靠它）。utils_chat（solo_work_lite）链路维持不报。
  if (persona && meta.sessionId && opts.onTurnId) {
    try { opts.onTurnId(meta.sessionId, auth); } catch (e) { /* 上报失败不影响响应 */ }
  }
  return { streamed: true };
}

/** 这一轮该不该重试：请求确实带了工具，且回复没调工具又说还有下一步 */
function needsRepair(meta, text) {
  if (chat.REPAIR_MAX <= 0) return false;
  if (!meta || !meta.toolCount) return false;
  return chat.looksUnfinished(text);
}

/** 修复触发时留一行日志——这是「模型行为」而不是「网关行为」，不记下来就无从归因。
 *  带上被丢弃的正文片段，用来区分「真·播报即收尾」与「判据误伤」（两者处置完全不同）。 */
function logRepair(reqId, attempt, text) {
  try {
    const snip = String(text || '').replace(/\s+/g, ' ').slice(0, 120);
    console.log(`[traework] 播报即收尾：第 ${attempt} 次重试（req_id=${reqId || '-'}）丢弃正文=「${snip}」`);
  } catch (e) { /* 日志失败不影响请求 */ }
}

module.exports = {
  status, send, listModels, listModelEntries, warmupModels, pickAccount,
  // FEFO 集合推导导出：端到端回归用（verify-expiring-fefo.js）
  fefoUidSet,
  DEFAULT_MODEL: c.DEFAULT_MODEL,
};
