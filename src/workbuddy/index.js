// src/workbuddy/index.js - WorkBuddy 通道对外入口
//
// 与 traework/index.js 同构：上层（server.js / upstream-router.js）只跟这个
// 文件打交道。差异：
//   - 双区域账号池（cn / global），keys 的 'intl' 在这里映射成 'global'
//   - 上游是标准 OpenAI SSE——流式块原样透传，非流式本地聚合
//   - 失败分类按 upstream.rs：hard_credit→402 / session_dead→401 /
//     soft_rate→429 / 其余按状态码
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
//   restrictedRotateMax 一次请求最多再换几个号（默认 0 = 不换）
//   waveMin             窗口内几个不同账号被限制就整区域暂停（默认 2）
//   waveWindowSec       连坐判定窗口秒（默认 900）
//   holdSeconds         整区域暂停秒（默认 1800；**0 = 彻底关闭连坐暂停**）
//
// **这四个参数 2026-11-08 起是运行期配置**（`src/workbuddy/runtime.js`，
// hub P2-11「自定义时长 + 保存更短时长即时截断倒计时」）：面板改完下一个请求
// 就按新阈值判定，不用重启；env 仍是默认值来源，只设 env 的部署行为不变。
// 读取是「每次判定现读 + mtime 失效重读」，刻意不缓存成模块级常量——
// 常量读死正是当初「改时长必须重启」的根因。
//
// 暂停本身仍是进程内紧急状态（连坐场景下快速失败比持久化重要），只落一份
// 观测快照给管理端。**改短 hold 会截断现有倒计时**：hold 存的是
// { at, until }，现算时把 until 夹到 at + holdMs，所以「面板改小 → 立刻收窄」
// 不需要额外的信号文件，也不需要等下一次触发。
const runtime = require('./runtime');

/** 当前连坐参数（毫秒口径，现读运行期配置） */
function restrictionCfg() {
  let r;
  try { r = runtime.Load().restriction; } catch (e) { r = runtime.defaults().restriction; }
  return {
    waveMin: Math.max(1, Number(r.waveMin) || 1),
    waveWindowMs: Math.max(0, Number(r.waveWindowSec) || 0) * 1000,
    holdMs: Math.max(0, Number(r.holdSeconds) || 0) * 1000,
    restrictedRotateMax: Math.max(0, Number(r.restrictedRotateMax) || 0),
  };
}

const restrictionEvents = new Map(); // region -> Map(uid -> ts)
const restrictionHold = new Map();   // region -> { at, until }

/** 现算的暂停截止时刻（按当前 holdSeconds 截断） */
function holdUntilOf(region, cfg) {
  const h = restrictionHold.get(region);
  if (!h) return 0;
  if (cfg.holdMs <= 0) { restrictionHold.delete(region); return 0; }
  return Math.min(Number(h.until) || 0, (Number(h.at) || 0) + cfg.holdMs);
}

// --- 连坐状态的跨进程观测副本（2026-11-06 加，为管理端 9083 服务）---
//
// 判定权威仍是上面两个内存 Map：连坐场景要的是「立刻失败」，读内存零开销。
// 但**管理端是另一个进程**（9083 跑 admin/server.js，9082 才是网关），两边
// 各自 require 本模块会拿到各自的内存 Map——管理端读到的永远是空的。
// 所以状态变化时顺手落一份快照给管理端读，「一键解除」则反向落一个信号文件，
// 由网关在下一次判定时消费。落盘失败一律不影响判定（观测不该拖垮热路径）。
const filelock = require('../filelock');
function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
}
const RESTRICTION_FILE = 'workbuddy-restriction.json';
const RESTRICTION_CLEAR_FILE = 'workbuddy-restriction-clear.json';
const restrictionFilePath = () => path.join(dataDir(), RESTRICTION_FILE);
const restrictionClearPath = () => path.join(dataDir(), RESTRICTION_CLEAR_FILE);

/** 把当前连坐状态写成观测快照（供管理端跨进程读取）。失败静默 */
function persistRestriction(now = Date.now()) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const cfg = restrictionCfg();
    const regions = {};
    for (const region of [...restrictionHold.keys()]) {
      // 用现算截止时刻（会按当前 hold 截断），快照才能反映「面板改短后已收窄」
      const until = holdUntilOf(region, cfg);
      if (until > now) regions[region] = { until, remainingMs: until - now };
    }
    const events = {};
    for (const [region, ev] of restrictionEvents) {
      const live = [...ev].filter(([, at]) => now - at <= cfg.waveWindowMs);
      if (live.length) {
        events[region] = live.map(([uid, at]) => ({ uid, at, agoMs: now - at }));
      }
    }
    const snap = {
      at: now,
      config: {
        waveMin: cfg.waveMin,
        waveWindowMs: cfg.waveWindowMs,
        holdMs: cfg.holdMs,
        restrictedRotateMax: cfg.restrictedRotateMax,
      },
      regions,
      events,
    };
    const target = restrictionFilePath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8');
    filelock.renameAtomic(tmp, target);
  } catch (e) { /* 观测副本写失败不影响判定 */ }
}

/**
 * 读观测快照（管理端用；网关进程内读内存更准，读这个也可以）。
 * 返回 null 表示从没触发过连坐（或文件不可读）。
 * **注意 until 可能已过期**——调用方要自己比 now，不要直接当成「正在暂停」。
 */
function restrictionSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(restrictionFilePath(), 'utf8'));
  } catch (e) {
    return null;
  }
}

/** 请求解除某区域的连坐暂停（管理端调用；网关下次判定时消费） */
function requestClearRestriction(region) {
  // **先校验原始入参**：c.normalizeRegion('') 会默认成 'cn'，直接用会把
  // 「调用方忘了传 region」变成「清掉国内区域暂停」——危险默认，必须拦。
  const raw = String(region || '').trim().toLowerCase();
  if (!raw) return { ok: false, error: '缺 region（cn / intl）' };
  const r = c.normalizeRegion(raw);
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    // 1) 信号文件：这是给**网关进程**的（它改不了别进程的内存，只能靠文件）
    const target = restrictionClearPath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ region: r, at: Date.now() }), 'utf8');
    filelock.renameAtomic(tmp, target);
    // 2) 乐观更新快照：管理端立刻看到「已解除」，不必等网关下一次请求触发消费。
    //    网关侧仍以信号文件为准——若网关一直没流量，快照与内存短暂不一致，
    //    但那时也没有请求会被暂停，不影响正确性。
    const snap = restrictionSnapshot();
    if (snap && snap.regions && snap.regions[r]) {
      delete snap.regions[r];
      const t2 = `${restrictionFilePath()}.tmp`;
      fs.writeFileSync(t2, JSON.stringify(snap, null, 2), 'utf8');
      filelock.renameAtomic(t2, restrictionFilePath());
    }
    // 3) 本进程内存也清一下：管理端若将来在同进程调 status，口径一致
    if (restrictionHold.has(r)) {
      restrictionHold.delete(r);
      restrictionEvents.delete(r);
    }
    return { ok: true, region: r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 消费解除信号（网关侧）：读到就清该区域内存态并删文件。只在暂停期间调用 */
function consumeClearSignal(now = Date.now()) {
  const p = restrictionClearPath();
  let sig = null;
  try {
    sig = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    // 没有文件是常态；有文件但解析失败就直接删掉，别让它一直挡着
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* 删不掉也无所谓 */ }
    return false;
  }
  try { fs.unlinkSync(p); } catch (e) { /* 已被别的进程消费 */ }
  const region = sig && sig.region;
  if (!region) return false;
  restrictionHold.delete(region);
  restrictionEvents.delete(region);
  persistRestriction(now);
  return true;
}

/** 记一次账号级风控限制；窗口内不同账号数达阈值即整区域暂停，返回暂停到的时刻（0 = 未触发） */
function noteAccountRestriction(region, uid, now = Date.now()) {
  const cfg = restrictionCfg();
  // holdSeconds=0 = 彻底关闭连坐暂停（hub P2-11 的「设 0 关闭」）：仍记事件供
  // 观测，只是不再整区域停服——运维需要能看见「有号在被限制」，否则关掉护栏
  // 就等于蒙眼。事件留着也意味着后续把 0 改回正值时立即按现有窗口判定。
  if (cfg.holdMs <= 0) {
    let ev0 = restrictionEvents.get(region);
    if (!ev0) { ev0 = new Map(); restrictionEvents.set(region, ev0); }
    for (const [k, at] of [...ev0]) {
      if (now - at > cfg.waveWindowMs) ev0.delete(k);
    }
    ev0.set(String(uid || '-'), now);
    persistRestriction(now);
    return 0;
  }
  let ev = restrictionEvents.get(region);
  if (!ev) { ev = new Map(); restrictionEvents.set(region, ev); }
  for (const [k, at] of [...ev]) {
    if (now - at > cfg.waveWindowMs) ev.delete(k);
  }
  ev.set(String(uid || '-'), now);
  if (ev.size < cfg.waveMin) {
    persistRestriction(now); // 不足以连坐，但「哪些号已被限制」本身值得观测
    return 0;
  }
  const until = now + cfg.holdMs;
  const prev = restrictionHold.get(region);
  const prevUntil = prev ? holdUntilOf(region, cfg) : 0;
  if (until > prevUntil) restrictionHold.set(region, { at: now, until });
  persistRestriction(now);
  return until;
}

/** 区域连坐暂停剩余毫秒（0 = 没有暂停） */
function restrictionHoldRemaining(region, now = Date.now()) {
  const cfg = restrictionCfg();
  const until = holdUntilOf(region, cfg);
  if (until <= now) return 0;
  // 只在**确实处于暂停**时才检查解除信号：热路径上暂停期间本来就在快速失败，
  // 多一次 stat 无所谓；正常服务时一次都不查。
  consumeClearSignal(now);
  return Math.max(0, holdUntilOf(region, cfg) - now);
}

/** 测试与运维观测：清空连坐状态 */
function _restrictionReset(now = Date.now()) {
  restrictionEvents.clear();
  restrictionHold.clear();
  persistRestriction(now);
  try { if (fs.existsSync(restrictionClearPath())) fs.unlinkSync(restrictionClearPath()); } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------------------
// WAF / 网关层拦截的快速失败（P1-5，2026-11-28）
//
// WAF（403 + 无业务信封，判据在 constants.looksLikeWafBody）拦的是**出口 IP**，
// 不是账号：窗口内 ≥2 个**不同**账号都吃到它，说明再换号也没用（换的是身份
// 不是出口），60 秒内整区快速失败。单号命中不算——那可能是该号自身的问题，
// 换下一个号确认（第二个号也中才升级），这正是滑窗的判定方式。
//
// 与连坐暂停的三点差异，都是刻意为之：
//   - **不持久化**：60s 级瞬态，进程重启即清零（连坐是 30 分钟级，要落快照）；
//   - **不罚号**：feed='none'，账号本身没犯错，喂池冷却只会白伤健康号；
//   - **不设运行期配置**：阈值与窗口写死（2 号 / 60s）——它只是止损闸门，
//     不是调参对象；真要关，上游侧解除即可。
const WAF_WINDOW_MS = 60000;
const WAF_MIN_UIDS = 2;
const wafHits = new Map(); // region -> Map(uid -> lastHitAt)

/** 记一次 WAF 命中（uid 用账号 id；区域未知不记——循环内都会带 regionKey） */
function noteWafHit(region, uid, now = Date.now()) {
  if (!region) return;
  let m = wafHits.get(region);
  if (!m) { m = new Map(); wafHits.set(region, m); }
  for (const [k, at] of [...m]) {
    if (now - at > WAF_WINDOW_MS) m.delete(k);
  }
  m.set(String(uid === undefined || uid === null ? '-' : uid), now);
}

/**
 * WAF 快速失败剩余毫秒（0 = 不拦）。窗口内 ≥2 个不同 uid 中招才拦，
 * 拦到「最后一次命中 + 窗口」为止（滑窗语义：不再有新命中就自动解除）。
 */
function wafBlockedRemaining(region, now = Date.now()) {
  const m = wafHits.get(region);
  if (!m) return 0;
  const uids = new Set();
  let last = 0;
  for (const [k, at] of [...m]) {
    if (now - at > WAF_WINDOW_MS) { m.delete(k); continue; }
    uids.add(k);
    if (at > last) last = at;
  }
  if (uids.size < WAF_MIN_UIDS) return 0;
  return Math.max(0, last + WAF_WINDOW_MS - now);
}

/** 测试：清空 WAF 滑窗 */
function _wafReset() {
  wafHits.clear();
}

/**
 * 重刷观测快照（管理端改完连坐参数后调用）：把内存态按**当前配置**重新
 * 夹一遍写回文件，界面不必等下一个请求就能看到「改短已生效」。
 * 读不到内存（管理端进程）时 also 不改写什么——快照由网关 owner 写，
 * 那边下一次判定自然更新，这里只是提前一瞬间。
 */
function repersistRestriction(now = Date.now()) {
  persistRestriction(now);
  return restrictionState(now);
}

/**
 * 当前连坐状态（管理端与网关同一口径）：内存为准，内存空则回落读落盘快照。
 *
 * 为什么要回落：管理端 9083 与网关 9082 是不同进程，各自 require 本模块拿到
 * 各自的内存 Map。管理端内存恒空，只能读网关落下的快照。
 * regions 只保留**仍有效**的暂停（快照里的 until 可能已过期）。
 */
function restrictionState(now = Date.now()) {
  const cfg = restrictionCfg();
  const config = {
    waveMin: cfg.waveMin,
    waveWindowMs: cfg.waveWindowMs,
    holdMs: cfg.holdMs,
    restrictedRotateMax: cfg.restrictedRotateMax,
  };
  const liveRegions = {};
  for (const region of [...restrictionHold.keys()]) {
    const until = holdUntilOf(region, cfg);
    if (until > now) liveRegions[region] = { until, remainingMs: until - now };
  }
  if (Object.keys(liveRegions).length) {
    const events = {};
    for (const [region, ev] of restrictionEvents) {
      const live = [...ev].filter(([, at]) => now - at <= cfg.waveWindowMs);
      if (live.length) events[region] = live.map(([uid, at]) => ({ uid, at, agoMs: now - at }));
    }
    return { at: now, source: 'memory', config, regions: liveRegions, events };
  }
  const snap = restrictionSnapshot();
  if (!snap) return { at: null, source: 'none', config, regions: {}, events: {} };
  const fromFile = {};
  for (const [region, v] of Object.entries(snap.regions || {})) {
    // 快照里的 until 是**写入时**按当时 hold 算的；面板改短后要按当前配置再夹一次，
    // 否则管理端会在网关还没写入新快照前显示旧倒计时（「改了没生效」的假象）
    const at = Number(v && v.at) || Number(snap.at) || now;
    const until = cfg.holdMs > 0 ? Math.min(Number(v.until) || 0, at + cfg.holdMs) : 0;
    if (until > now) fromFile[region] = { until, remainingMs: until - now };
  }
  return { at: snap.at || null, source: 'snapshot', config, regions: fromFile, events: snap.events || {} };
}

/**
 * send 失败处置的纯判定（可离线测）：
 *   feed    池动作：none=不喂（参数错/请求级）/ model=模型级（6004）/ account=账号级
 *   action  rotate=换号 / restrict=记连坐（默认不换号）/ refresh=先刷新重试 / throw=直接抛
 *
 * 2026-11-08 融合批补的四类**请求级**失败（GitHub 生态调研：xu20060420fan-cell
 * 的 14 个 ErrKind 分类机）：
 *   model_unavailable     (账号,模型) 不可用 → **模型级**喂池（scope:model 负缓存），
 *                         换号打同模型没意义（模型本身该账号没有），但**不罚账号**
 *   queue                 排队 → 完全不喂、不换号，如实报位次
 *   reasoning_unsupported 补默认档能过 → 不喂、不换号（重发由 send 层做）
 *   tool_pair_mismatch    修历史配对能过 → 不喂、不换号
 *
 * 这四类原来都落进 'client' → errorActionOf 的兜底 `feed:'account', action:'throw'`，
 * 于是「换模型就能过」的请求把健康账号喂成了账号级失败。**这是真实事故形态，
 * 不是理论洁癖**：一个账号连续被几个不支持 reasoning 的模型请求打中，10 分钟内
 * 所有模型都会被池标记不可用。
 */
/**
 * 零输出守卫（批次六，hub sse.go HeadVetoError 移植）：上游 200 + 流正常收尾
 * （finish_reason=length）但正文/思考/工具全空——客户端只会拿到一个空回答。
 * 判定点都安排在「客户端尚未收到任何可见输出」的首帧否决窗口内（见
 * runConversation 三处判定点注释），抛给 send() 换号重发。不罚账号：
 * 空输出与账号健康无关（多半是上游侧临时故障），喂池只会让健康号背锅。
 */
function zeroOutputError(model) {
  const e = new Error(`WorkBuddy 上游返回空输出（200 + finish_reason=length，正文/思考/工具全空），正在换号重发`);
  e.zeroOutput = true;
  e.statusCode = 502;
  e.code = 'zero_output_length';
  e.model = model;
  return e;
}

function errorActionOf(e) {
  if (e && e.paramError) return { feed: 'none', action: 'throw' };
  if (e && e.zeroOutput) return { feed: 'none', action: 'rotate' };
  if (e && e.modelCap) return { feed: 'model', action: 'rotate' };
  if (e && e.restricted) return { feed: 'account', action: 'restrict' };
  const kind = e && (e.kind || '');
  if (kind === 'session_dead' || Number(e && e.statusCode) === 401) {
    // 刷新是第一响应（hub #441）：刷新成功 = 账号健康，喂池反而会把
    // 「token 过期」记成 session_dead 计数。刷新失败由 send 分支补喂
    return { feed: 'none', action: 'refresh' };
  }
  // ---- 请求级四类：都不许动账号 ----
  if (kind === 'model_unavailable') return { feed: 'model', action: 'throw' };
  if (kind === 'queue') return { feed: 'none', action: 'throw', queue: true };
  if (kind === 'reasoning_unsupported') return { feed: 'none', action: 'throw', reasoning: true };
  if (kind === 'tool_pair_mismatch') return { feed: 'none', action: 'throw', toolPair: true };
  // ---- P0-5 四类（2026-11-28，yreidev bizcode 全表）----
  if (kind === 'context_overflow') return { feed: 'none', action: 'throw' };     // 11115 原文返回
  if (kind === 'channel_check') return { feed: 'none', action: 'throw' };        // 11128 补头即过
  if (kind === 'temp_rate') return { feed: 'model', action: 'rotate' };          // 14003 当场换号
  if (kind === 'session_limit') return { feed: 'account', action: 'rotate' };    // 10105 短冷却换号
  if (kind === 'waf') return { feed: 'none', action: 'throw' };                  // P1-5 IP 级——send 层滑窗处置，这里兜底不罚号
  if (kind === 'client' || kind === 'not_found') return { feed: 'none', action: 'throw' };
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
  // 排队也是 429：语义就是「稍后再来」，客户端会退避重试。
  // 单独列出来是为了让下面 message 里的位次文案有确定的落点，
  // 而不是靠兜底分支掰出 429/400。
  if (kind === 'queue') return 429;
  if (kind === 'soft_rate') return 429;
  // P0-5 四类：11115/11128 请求级 400；14003/10105 语义是「稍后再来」429
  if (kind === 'context_overflow') return 400;
  if (kind === 'channel_check') return 400;
  if (kind === 'temp_rate') return 429;
  if (kind === 'session_limit') return 429;
  if (kind === 'waf') return 503;   // P1-5：出口级拦截，语义是「稍后再来」
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

/**
 * 额度护栏的排除集合（P1-6）：套餐剩余低于阈值的账号 **id（裸 id）**。
 *
 * 三条口径，缺一条就会把护栏变成故障源：
 *   1. **默认关**：guard.enabled 为假直接返回 null，一行都不多算；
 *   2. **快照陈旧/缺失 → null**：不拿 6 小时前的余额把请求全拦死，
 *      退回普通选号（护栏是选号过滤，不是请求拦截）；
 *   3. **探针不享受豁免也不受罚**：探针本身就要发请求测扣费，被护栏拦掉就
 *      永远测不出来——调用方（send）按 opts.probe 跳过这层过滤。
 * @returns {Set<string>|null} 裸 id 集合（字符串）；null = 护栏不生效
 */
function lowCreditIdSet(now = Date.now()) {
  let cfg;
  try { cfg = runtime.Load().guard; } catch (e) { return null; }
  if (!cfg || !cfg.enabled) return null;
  try {
    return require('./credits-snapshot').lowAccounts(cfg.threshold, now);
  } catch (e) {
    return null;   // 快照模块异常 → 护栏不生效（观测面故障不拦请求）
  }
}

// ---------------------------------------------------------------------------
// 单发请求分片亲和（P1-8，hub v2.0.7 #842；DUMATE_WB_MSGSTAT_SHARDS 选通，默认关）
//
// 单发请求（messages 里没有 assistant 回复）与多轮会话不同：粘滞键虽然也会
// 绑定，但绑定表只在内存——**进程重启后同一请求会被随机分给任何账号**，
// 而上游 prompt 缓存按账号存放，换号 = 整段前缀重付。分片把「同一内容指纹」
// 的单发请求钉到固定 ≤N 个账号上（哈希来自请求内容 + 日盐，跨重启稳定）；
// 亲和集全忙/冷却时自然落回全量轮询（可用性永远优先于亲和）。
// 日盐（UTC+8，额度按北京时间日重置）每天轮换一次映射，让单发流量的消耗
// 在账号间摊匀。
// 多轮请求不受影响：它们有粘滞键兜着，isSingleShot 直接放行。
// ---------------------------------------------------------------------------

/** 日盐：北京时间日期串 YYYYMMDD */
function msgstatDaySalt(now = Date.now()) {
  const d = new Date(now + 8 * 3600000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** 单发判定：messages 里没有任何 assistant 回复（[system,user] 型及其变体） */
function isSingleShot(payload) {
  const msgs = payload && Array.isArray(payload.messages) ? payload.messages : [];
  return !msgs.some((m) => m && m.role === 'assistant');
}

/**
 * 分片亲和账号 id 集合。非单发 / 未开启 / 候选 ≤1 个时返回 null（不分片）。
 * 哈希输入 = (会话键, 模型, tools) + 日盐——会话键本身已含 system 全文与
 * 首条 user（P2-11 口径），所以「+user 哈希」不需要再单独拼一遍。
 * 返回 Set（裸 id 字符串）；空 Set 不会出现（take ≥ 1）。
 */
function msgstatShardIds(usable, { sessionKey, model, payload } = {}) {
  const n = parseInt(process.env.DUMATE_WB_MSGSTAT_SHARDS || '0', 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!Array.isArray(usable) || usable.length <= 1) return null;
  if (!payload || !isSingleShot(payload)) return null;
  let toolsJson = '';
  try { toolsJson = JSON.stringify(payload.tools || []); } catch (e) { toolsJson = ''; }
  const basis = `${sessionKey || ''}|${model || ''}|${toolsJson}|${msgstatDaySalt()}`;
  const start = crypto.createHash('sha1').update(basis).digest().readUInt32BE(0) % usable.length;
  const take = Math.min(Math.max(1, n), usable.length);
  const rotated = usable.slice(start).concat(usable.slice(0, start));
  return new Set(rotated.slice(0, take).map((a) => String(a.id)));
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
    // WAF 快速失败（P1-5）：出口 IP 级拦截，换号无效，到点自动解除
    const wafMs = wafBlockedRemaining(region);
    if (wafMs > 0) {
      const e = new Error(`WorkBuddy ${region === 'global' ? '国际' : '国内'}区域 WAF 快速失败中：窗口内多个账号被网关层拦截（出口 IP 级风控，换号无效），${Math.ceil(wafMs / 1000)}s 后自动恢复`);
      e.statusCode = 503;
      e.wafFailFast = true;
      throw e;
    }
  }

  // 区域内选号 + 失败处置（errorActionOf）：
  //   11140 restricted → 默认不换号（换号=设备指纹连坐，hub #422）+ 连坐波记档
  //   401 session_dead → 先刷新 token 重试同账号（hub #441），刷新失败才判死换号
  //   6004 model_cap   → 只冷却 (账号, 模型)（scope:model 喂池），换号继续打同模型
  //   参数错误         → 不喂池不写 lastError，如实 400（hub v1.10.11 #794）
  const sessionKey = channelPool.sessionKeyFor(payload, opts);
  let allUsable = accountsForRegion(authStore.findUsable(), opts.region);
  // **按模型名的区域归属再收窄一次**（2026-11-08 融合批，真机事故驱动）：
  // 调用方不传 opts.region 时上面那步不做任何过滤，于是两区账号混在一起，
  // 而模型名是有区域归属的——国内目录的 deepseek-v4.1-flash 发给国际账号，
  // 上游回的是 **11140 风控码**（不是 11102「模型不存在」），会被误当成
  // 账号被限制，进而触发连坐暂停把整条通道弄停。
  //
  // 只在「显式没限区域」时按模型收窄：调用方已经指定区域时以它为准
  // （那是 API Key 的运行期约束，语义更强）。判不出区域（null）不拦。
  let modelRegion = null;
  if (!opts.region) {
    try { modelRegion = require('./models').regionOfModel(model); } catch (e) { modelRegion = null; }
    if (modelRegion) {
      const narrowed = allUsable.filter((a) => c.normalizeRegion(a.region) === modelRegion);
      // 收到 0 个就**不窄化**：宁可让上游报 11102，也不要因为「本地以为
      // 该模型只属于某区」就拒掉一个有账号可用的请求（缓存可能过时）
      if (narrowed.length) allUsable = narrowed;
    }
  }
  if (!allUsable.length) throw noRegionAccountError(opts.region);
  // 账号白名单（调研 P1-4）：key.account_allowlist 限定这把 key 能调度哪些账号。
  // **必须在这里判**——鉴权阶段判不了（那时还不知道会选中谁），而池轮询 / 粘性 /
  // FEFO 都可能改变最终选中的账号。
  let scoped = allUsable;
  let scopeBlocked = 0;
  if (opts.key && Array.isArray(opts.key.account_allowlist) && opts.key.account_allowlist.length) {
    const keysvc = require('../keys');
    scoped = allUsable.filter((a) => keysvc.accountAllowed(opts.key, CHANNEL, a.id));
    if (!scoped.length) {
      const e = new Error('该 API Key 的账号白名单（account_allowlist）里没有可用的 WorkBuddy 账号——名单里配的账号不存在、被停用或不在本区域');
      e.statusCode = 403;
      throw e;
    }
    scopeBlocked = allUsable.length - scoped.length;
  }
  // 免费模型豁免（批次五，hub v2.2.2）：确认免费的模型不消耗套餐余额，低余额
  // 账号打免费模型既不失败也不花钱——护栏两层（guard.threshold 快照过滤 +
  // pool creditFloor）对它放行，被拦纯属误伤。判据 models.isFreeModel：
  // 实测账本 EMA=0 → 目录 free；判不出来不豁免（保守，等同今日行为）。
  // 'auto' 档位永远不豁免（实际模型由账号决定，免费性不可知）。
  let freeModel = false;
  try {
    freeModel = require('./models').isFreeModel(
      modelRegion || opts.region || 'cn', model,
    );
  } catch (e) { freeModel = false; }
  // 额度护栏（P1-6）：低于阈值的账号从候选里剔除。**全被剔除时退回全量**
  // ——「全拦掉」等于把通道弄停，而护栏只是省一次注定失败的上游请求，
  // 不该比上游本身更严。探针（opts.probe）与免费模型（freeModel）不过滤：
  // 探针就是要发请求测扣费；免费请求不被低余额误拦。
  const lowIds = (opts.probe || freeModel) ? null : lowCreditIdSet();
  let usable = scoped;
  let guardSkipped = 0;
  if (lowIds && lowIds.size) {
    const kept = scoped.filter((a) => !lowIds.has(String(a.id)));
    if (kept.length) { usable = kept; guardSkipped = scoped.length - kept.length; }
  }
  const tried = new Set();
  const refreshTried = new Set();
  let rotated = 0;
  // 零输出守卫（批次六）：换号重发的发生次数，全池耗尽时把「试了几个号」讲清
  let zeroOutCount = 0;
  // FEFO：集合非空时候选先限制在临期账号内（快照由管理端 /credits 写）
  const fefo = fefoUidSet();
  let lastErr = null;
  // 分片亲和集（P1-8）：单发 + 开关开启时非空。整个 send 过程算一次
  //（候选集在本轮内不变——tried 只从 usable 里划掉）
  const shardSet = msgstatShardIds(usable, { sessionKey, model, payload });
  let shardFallback = false;
  for (let attempt = 0; attempt < usable.length; attempt++) {
    const pool = usable.filter((a) => !tried.has(a.id));
    if (!pool.length) break;
    // 先在分片集内选（亲和）；分片集全忙/冷却（pickCandidate null）→ 本轮
    // 退全量。分片集是可用列表的子集，不会选出可用性之外的东西。
    let sel = null;
    if (shardSet && !shardFallback) {
      const sub = pool.filter((a) => shardSet.has(String(a.id)));
      if (sub.length && sub.length < pool.length) {
        sel = channelPool.pickCandidate(CHANNEL, sub, { sessionKey, model, expiring: fefo, paid: !freeModel });
        if (!sel) shardFallback = true;
      }
    }
    if (!sel) sel = channelPool.pickCandidate(CHANNEL, pool, { sessionKey, model, expiring: fefo, paid: !freeModel });
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
    {
      const wafMs = wafBlockedRemaining(regionKey);
      if (wafMs > 0) {
        // 该区域已进入 WAF 快速失败：不再向上游发任何请求（region 空时
        // 另一区的账号照常接）。region 明确且全拦时由循环末尾的 lastErr 兜底
        channelPool.release(uid);
        lastErr = lastErr || (() => {
          const e = new Error(`WorkBuddy ${regionKey === 'global' ? '国际' : '国内'}区域 WAF 快速失败中（出口 IP 级风控），${Math.ceil(wafMs / 1000)}s 后自动恢复`);
          e.statusCode = 503;
          e.wafFailFast = true;
          return e;
        })();
        continue;
      }
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
      // WAF（P1-5）：先记滑窗再谈处置。第二个不同账号也中 → 整区快速失败
      // 当场生效（入口/循环检查都会拦）；单号命中 → 不罚号，换下一个确认。
      // 必须插在 errorActionOf 之前——waf 不该走任何 feed/rotate 语义。
      if (e && e.kind === 'waf') {
        noteWafHit(regionKey, auth.uid || auth.id);
        const wafMs = wafBlockedRemaining(regionKey);
        if (wafMs > 0) {
          const stop = new Error(`WorkBuddy ${regionKey === 'global' ? '国际' : '国内'}区域触发 WAF 快速失败：窗口内多个账号被网关层拦截（出口 IP 级风控，换号无效），${Math.ceil(wafMs / 1000)}s 后自动恢复`);
          stop.statusCode = 503;
          stop.wafFailFast = true;
          throw stop;
        }
        lastErr = lastErr || e;
        continue;
      }
      const act = errorActionOf(e);
      // 零输出守卫（批次六）：feed='none' + rotate——不罚账号，只换号重发。
      // 计数只为耗尽时的报错文案服务。
      if (e && e.zeroOutput) zeroOutCount++;
      if (!opts.probe) {
        if (act.feed === 'model') {
          // 模型级失败：6004 冷却（scope:model + retryAfterMs）与
          // 11102/11103/11158 负缓存（kind:'model_unavailable' 由 channel-pool
          // 升级成 kind:'model'）走同一处——账号本身都不动
          channelPool.noteError(CHANNEL, auth.id, {
            status: Number(e.statusCode) || 429,
            message: e.message,
            model,
            kind: e.kind,
            scope: 'model',
            retryAfterMs: e.retryAfterMs,
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
        if (rotated < restrictionCfg().restrictedRotateMax) { rotated++; continue; }
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
          // 上游**明确拒绝**换票（12153 / invalid_grant / refresh token invalid）
          // 才标退场：后续请求不再每次白撞换票端点。认不出措辞就不标
          // （网络抖/5xx 下次可能就好了，误标要人工重新登录才能解）。
          const refreshErr = rr && rr.error ? String(rr.error) : '';
          if (authStore.isRefreshRejected(refreshErr)) {
            try {
              authStore.patch(auth.id, {
                lastError: `凭证失效（需重新登录）: ${refreshErr}`.slice(0, 300),
                refreshRetiredAt: Date.now(),
              });
            } catch (err) { /* 标记失败不影响换号 */ }
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
  // 全部账号都试过（或全受限）：如实抛最后一个错误。
  // 护栏/白名单挡掉过账号时把这件事写进错误串——否则「为什么少了几个号」
  // 只能靠翻快照或 key 配置才知道。
  const notes = [];
  if (guardSkipped > 0) notes.push(`${guardSkipped} 个账号因套餐剩余低于护栏阈值被跳过`);
  if (scopeBlocked > 0) notes.push(`${scopeBlocked} 个账号不在该 Key 的账号白名单内`);
  if (notes.length) {
    const note = `（另有 ${notes.join('；')}）`;
    if (lastErr && lastErr.message) lastErr.message = `${lastErr.message}${note}`;
  }
  // 零输出守卫（批次六）：全池耗尽且死因是空输出时，把「试了几个号 + 怎么办」
  // 讲清——不然客户端只看到一句 502，无从判断是网络还是账号问题。
  // statusCode 502 / code zero_output_length 已在 zeroOutputError 里带上。
  if (lastErr && lastErr.zeroOutput) {
    lastErr.message = `WorkBuddy 上游空输出（finish_reason=length，正文/思考/工具全空）已连续出现 ${Math.max(zeroOutCount, 1)} 次（含换号重发，全部账号都这样）——通常是上游侧临时故障或该模型当前异常：可稍后重试、换一个模型，或到管理端通道页看上游健康`;
  }
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
      // 11-128 取证（P1-5，默认关）：只在命中取证码时写文件，写失败不影响
      // 请求。**必须带的是我们实际发出去的头与 body**——11-128 判的是请求
      // 形态，重建一份会有偏差。这里放在分类之后、抛错之前，任何分支都能覆盖。
      try {
        const dumpMod = require('./dump');
        if (dumpMod.mode() !== 'off') {
          const hit = dumpMod.matchesCode(classifyInput);
          if (hit) {
            dumpMod.dump({
              region, model, status: r.status, code: hit,
              headers: r.reqHeaders || {}, bodyText: r.bodyText || '',
            });
          }
        }
      } catch (e) { /* 取证面任何异常都不影响请求 */ }
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
        // 600x 族模型窗口额度用满：模型级冷却 + 重置墙钟（上游写的恢复时刻）。
        // send 层据 retryAfterMs 喂池（scope:model）并换号。解析不出墙钟时
        // 默认 5 分钟：6004 是模型窗口用满（不是瞬时抖动、也不是次日重置），
        // 落 undefined 会让池按账号级默认处置，量级不对
        e.modelCap = true;
        const reset = c.parseRateLimitReset(text);
        if (reset) e.retryAfterMs = Math.max(0, reset * 1000 - Date.now());
        else e.retryAfterMs = 300000;
      }
      if (kind === 'temp_rate') {
        // 14003 临时限流：有重置墙钟就按它，没有兜底 ~30s（yreidev 口径）
        const reset = c.parseRateLimitReset(text);
        e.retryAfterMs = reset ? Math.max(0, reset * 1000 - Date.now()) : 30000;
      }
      // 排队：把位次翻成人话挂到 error 上，下游（与界面）能说清「为什么慢」。
      // **message 也要换成人话**：客户端看到的是 message，不是 queueInfo 字段。
      // 只挂字段不换 message，用户仍然只看到「429 限流」——调研里
      // dsh-connect-workbuddy 专门做过这件事，不然「排队 3 位」和「账号被限」
      // 在用户眼里一模一样。
      if (kind === 'queue') {
        const q = c.parseQueueInfo(text);
        if (q) {
          e.queueInfo = q;
          e.message = `workbuddy 排队：${q.text}`;
          if (q.retryAfter != null) e.retryAfterMs = q.retryAfter * 1000;
        }
      }
      throw e;
    }
    return r;
  };

  if (!onChunk) {
    // ---- 非流式：强制 stream 收齐再聚合（上游不接受非流式），聚合后判定 ----
    let attempt = 0;
    let curPayload = payload;
    // 11150 降级（2026-11-08 融合批）：只降一次，剥完还撞就不再重试
    let reasoningStripped = false;
    for (;;) {
      let r;
      try {
        r = await post(buildBody(curPayload));
      } catch (e) {
        // 模型不吃 effort 参数：剥掉重发一次。**这是在救一个本来能成功的请求**，
        // 不是掩盖错误——上游文案明确说「reasoning effort is not supported」，
        // 剥掉即合法请求。剥完仍失败则照常抛，不无限降级。
        if (e && e.kind === 'reasoning_unsupported' && !reasoningStripped) {
          const nr = chat.withoutReasoningFields(curPayload);
          if (nr) {
            reasoningStripped = true;
            curPayload = nr.body;
            continue;
          }
        }
        throw e;
      }
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
      // 零输出守卫判定点①（非流式）：聚合全部完成后客户端还什么都没收到，
      // 否决窗口天然完整——直接抛给 send() 换号。放在修复判定之前：
      // 空正文对 looksUnfinished 是「收尾正常」，不走守卫就会原样回空回答。
      {
        const fin0 = (agg.choices && agg.choices[0] && agg.choices[0].finish_reason) || '';
        if (fin0 === 'length' && !hasCalls && !msg.content && !msg.reasoning_content) {
          throw zeroOutputError(model);
        }
      }
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
    // 零输出守卫（批次六）的无门跟踪：正文/思考/工具是否出现过、上游给了什么
    // finish_reason。只在无门路径用——有门时这些状态 gate.result() 全带。
    // tail 暂扣 finish/usage 帧：否决时整批丢弃，非否决轮在 [DONE] 前按原序补发
    //（与门的 hold 语义一致；readStream 会吞回调里的异常，所以用标记不抛）。
    let sawOut = false;
    let lastFinish = null;
    let vetoHit = false;
    const tail = [];
    try {
      await chat.readStream(r.stream, (chunk) => {
        if (vetoHit) return;   // 已判定否决：丢弃残帧（含迟到的数据帧）
        // 哨兵裸值交给下游桥（server.js 统一补 `data: ` 前缀并收尾）；
        // 带门时交门暂扣，finish() 在收尾补发以保证顺序在 usage/finish 之后。
        if (chunk === null) {
          if (!gate && !sawOut && lastFinish === 'length') { vetoHit = true; return; }   // [DONE] 不写出
          if (!gate) { for (const f of tail) deliver(f); tail.length = 0; }
          deliver('[DONE]'); return;
        }
        if (!gate) {
          const ch0 = (chunk.choices || [])[0];
          const d = ch0 ? (ch0.delta || ch0.message || {}) : {};
          if ((d.content && String(d.content).length)
            || (d.reasoning_content && String(d.reasoning_content).length)
            || (Array.isArray(d.tool_calls) && d.tool_calls.length)) sawOut = true;
          if ((ch0 && ch0.finish_reason) || chunk.usage) {
            if (ch0 && ch0.finish_reason) lastFinish = ch0.finish_reason;
            tail.push(JSON.stringify(chunk));   // finish/usage 暂扣到 [DONE] 前
            return;
          }
        }
        deliver(JSON.stringify(chunk));
      });
    } catch (e) {
      // 流错误同样要把「下游是否已收到输出」标出来：reasoning 是直发的，
      // 有一帧出去了就不能再换号重来（客户端会看到两段内容）。
      if (!e.statusCode) e.sent = sent || !!(gate && gate.result().emitted > 0);
      throw e;
    }
    // 零输出守卫判定点②（流式无门，纯对话/修复关闭）：此刻 [DONE] 与
    // finish/usage 都没写出，角色帧/空 delta 虽已透传但四个翻译器对它们
    // 零可见事件（Anthropic 只记 lastFinishReason，Responses/Google 同为
    // 缓存字段）——换号重发对客户端无痕。裸关闭（上游没发 [DONE]）同判。
    if (!gate && !sawOut && lastFinish === 'length') vetoHit = true;
    if (vetoHit) throw zeroOutputError(model);
    if (!gate) {
      // 裸关闭也要把暂扣的 finish/usage 补出去，别让尾部帧凭空消失
      for (const f of tail) deliver(f);
      tail.length = 0;
      return { streamed: true };
    }
    const g = gate.result();
    // 零输出守卫判定点③（流式带门）：finish/usage/[DONE] 全部还在门里，
    // 一轮缓冲整批丢弃即可，连透传帧都不用补。reasoningSeen 挡住「思考已
    // 直发」的半空轮——那不是零输出，客户端已经看见思考内容了。
    if (g.finishReason === 'length' && !g.text && !g.toolCalls && !g.reasoningSeen) {
      throw zeroOutputError(model);
    }
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
  // 额度护栏（P1-6）：纯推导导出，便于离线测「默认关 / 陈旧失效 / 全拦退回」
  lowCreditIdSet,
  // 风控连坐 + 失败处置（可离线测的纯函数）
  noteAccountRestriction, restrictionHoldRemaining, _restrictionReset, errorActionOf,
  // WAF 快速失败（P1-5）：滑窗记数与判定 + 测试复位
  noteWafHit, wafBlockedRemaining, _wafReset,
  // 单发分片（P1-8）：纯推导导出，离线锁「哈希稳定 / 日盐轮换 / 非单发不分片」
  msgstatShardIds, isSingleShot, msgstatDaySalt,
  // 跨进程观测（管理端 9083 读快照、写解除信号；网关侧消费信号）
  restrictionSnapshot, requestClearRestriction, consumeClearSignal,
  restrictionState, repersistRestriction, restrictionCfg,
  chatCompletion: (p, opts) => send(p, undefined, opts),
  chatCompletionStream: (p, cb, opts) => send(p, cb, opts),
  DEFAULT_MODEL: 'auto',
};
