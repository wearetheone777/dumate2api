// src/traework/checkin.js - 签到 / 额度查询
//
// 三个接口都在 api.trae.cn（UgHost），请求体是空对象 {}，
// 身份全靠请求头（Authorization + X-Device-Id）。
//
// 签到是**幂等**的：已签过再 claim 不会报错，所以定时任务可以放心重跑。
const c = require('./constants');
const { ugHeaders } = require('./headers');
const authStore = require('./auth');
const ledger = require('../checkin-ledger');

/**
 * 签到/额度接口都要**设备指纹匹配**，所以每次请求前先把设备三件套补齐。
 *
 * 旧的账号记录里 deviceId 是随机 hex（格式不对），ensureDevice 会按 uid
 * 重派生并落盘。不补的话签到恒定 9074。
 */
function withDevice(auth) {
  try { return authStore.ensureDevice(auth) || auth; }
  catch (e) { return auth; }
}

/**
 * 签到路径自己的 token 续期。**必须做，不能指望发请求那条路**：
 * pickAccount 只在对话请求时刷新 token，而签到/额度接口直接拿账号里存的
 * accessToken——token 每天过期，点「签到」时若已过期，上游会回
 * "We're sorry, but we are not able to authenticate you"（不是 401 状态码，
 * 就是这句业务文案），并被写进 lastError 挂在账号卡上（2026-10-09 实测）。
 * 刷新失败不阻断签到——让它带着旧 token 试一次，错误如实上报。
 */
async function withFreshToken(auth) {
  try {
    if (!authStore.needsRefresh(auth)) return auth;
    const r = await authStore.exchange(auth);
    if (!r.ok) return auth;
    return authStore.patch(auth.id, { ...r.patch, lastError: '' }) || { ...auth, ...r.patch };
  } catch (e) { return auth; }
}

// 出站 agent（E 包收口补点）：签到/额度与对话同出口。配置非法抛给调用方
// 转失败形状，绝不静默回退直连。
function agentOf(auth) {
  return require('../proxy-agent').getAgentFor(auth);
}

/**
 * 查签到状态：{ checkedIn, credits, extraCredits, enable }
 *
 * 实测返回体（2026-09-25）：
 *   { checked_in: false, credits: 150, extra_credits: 50, did_checked_in: false, enable: true }
 *
 * credits 是**签到可得的额度**（不是余额），did_checked_in 是今天是否已领。
 */
async function status(auth) {
  let agent;
  try { agent = agentOf(auth); } catch (e) { return { ok: false, error: e.message }; }
  const r = await c.request(c.UG_HOST, c.EP_CHECKIN_STATUS, {
    method: 'POST', body: {}, headers: ugHeaders(withDevice(auth)), agent,
  });
  if (r.status !== 200 || !r.data) {
    return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}` };
  }
  // 上游把结果包在 data 里，也可能是平铺——两种都认
  const d = r.data.data || r.data;
  const credits = Number(d.credits ?? d.credit ?? 0) || 0;
  const extraCredits = Number(d.extra_credits ?? d.extraCredits ?? 0) || 0;
  return {
    ok: true,
    checkedIn: !!(d.checked_in ?? d.did_checked_in ?? d.checkedIn),
    credits,
    // 额外赠送（如连续签到奖励）。没有就如实给 0，不编
    extraCredits,
    // **credits 与 extra_credits 是二选一，不是两笔相加**（traework2api-panel
    // 实测：「credits=100 + extra=100 显示 200，实到 100」）。要给「本次可得」
    // 一个数时取较大的那个；两者都保留是为了让界面能如实展示上游原值。
    claimable: Math.max(credits, extraCredits),
    enable: d.enable !== false,
  };
}

/**
 * 执行签到。已签过也返回 ok（幂等）。
 *
 * **HTTP 200 不代表成功**：上游在 body 里用 code 表达业务结果。
 * 只看状态码会把失败当成签到成功，界面显示「签到成功」而额度没变。
 *
 * 9074「当前参与用户太多」的真相（2026-09-25 查清）：**不是限流，是设备指纹
 * 不匹配**。原实现的 deviceId 是随机 hex，而服务端要求 15 位数字且与账号
 * 绑定。对照 smart-open/TraeWorkAssistant 后改成从 uid 确定性派生
 * （见 device.js），并补齐 sessionId / marketUserId 与客户端身份头。
 * 请求体用空对象——参考实现也是 `send_string("{}")`。
 */
const CODE_RATE_LIMITED = 9074;

// ---- 9074 自愈（2026-10-30，方案对齐 Trae2api-cn 的 device_generation）----
//
// 9074 实测是**设备级**校验而非账号级：同一 token 换一个新派生的设备 id 就能
// 签到成功（我们 2026-09-25 修好 15 位派生格式后签到成功也证明格式对就行）。
// 所以 claim 撞 9074 先「换一代设备 → 立即重试一次」；仍 9074 才进退避。
// 退避是温和指数（60s × 2^min(count,3)，封顶 3600s）：9074 是上游容量信号
// 不是对本账号的惩罚，当天内保持尝试比一小时封顶更有机会签上。

const RETRY_BASE_MS = Number(process.env.DUMATE_TRAEWORK_9074_RETRY_SECONDS || 60) * 1000;
const RETRY_MAX_MS = Number(process.env.DUMATE_TRAEWORK_9074_MAX_BACKOFF_SECONDS || 3600) * 1000;
const RETRY_EXPONENT_CAP = 3;

/** 退避时长：base × 2^min(count, cap)，夹在 [base, max]。纯函数可离线测 */
function backoffMs(count) {
  const base = Math.max(1, RETRY_BASE_MS);
  const backoff = base * (2 ** Math.min(Math.max(0, Number(count) || 0), RETRY_EXPONENT_CAP));
  return Math.max(base, Math.min(backoff, Math.max(base, RETRY_MAX_MS)));
}

/** 读账号当前的 9074 退避剩余毫秒（0 = 无退避） */
function backoffRemaining(auth) {
  const until = Number(auth && auth.checkin9074Until) || 0;
  return until > Date.now() ? until - Date.now() : 0;
}

/**
 * claim + 9074 自愈：撞 9074 先换一代设备立即重试一次，仍失败才记账退避。
 * 成功路径清空退避记账。返回 { ...claim结果, rotated, backoffMs }。
 */
async function claimWithRetry(auth) {
  let r = await claim(auth);
  if (!r.rateLimited) {
    if (r.ok && (auth.checkin9074Count || auth.checkin9074Until)) {
      authStore.patch(auth.id, { checkin9074Count: 0, checkin9074Until: 0 });
    }
    return r;
  }
  const rotated = authStore.rotateDevice(auth);
  if (rotated) {
    const retry = await claim(rotated);
    if (!retry.rateLimited) {
      if (retry.ok) authStore.patch(rotated.id, { checkin9074Count: 0, checkin9074Until: 0 });
      return { ...retry, rotated: true };
    }
    auth = rotated;
    r = retry;
  }
  const count = (Number(auth.checkin9074Count) || 0) + 1;
  const ms = backoffMs(count - 1);
  authStore.patch(auth.id, {
    checkin9074Count: count,
    checkin9074Until: Date.now() + ms,
    lastError: `9074 ${r.error || ''}（已换设备重试，${Math.round(ms / 1000)}s 后自动再试）`.trim(),
  });
  return { ...r, rotated: !!rotated, backoffMs: ms };
}

async function claim(auth) {
  let agent;
  try { agent = agentOf(auth); } catch (e) { return { ok: false, error: e.message }; }
  const r = await c.request(c.UG_HOST, c.EP_CHECKIN_CLAIM, {
    method: 'POST', body: {}, headers: ugHeaders(withDevice(auth)), agent,
  });
  if (r.status !== 200) {
    return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}` };
  }
  const d = (r.data && (r.data.data || r.data)) || {};
  // code 非 0 即业务失败。0 与缺省都按成功（有些返回体不带 code）
  const code = Number(d.code ?? 0) || 0;
  if (code !== 0) {
    const msg = String(d.message || `上游返回 code ${code}`);
    return {
      ok: false,
      code,
      error: code === CODE_RATE_LIMITED
        ? `${msg}（设备指纹或活动侧校验未通过；详见 checkin.js 顶部注释）`
        : msg,
      rateLimited: code === CODE_RATE_LIMITED,
    };
  }
  return {
    ok: true,
    // 有些返回体带本次获得的积分，没有就留 null（界面显示 —，不编 0）
    gained: d.credits != null ? Number(d.credits) : (d.gained != null ? Number(d.gained) : null),
    raw: d,
  };
}

/**
 * 查额度（ide_user_ent_usage）。
 *
 * 实测返回体（2026-09-25）：
 *   {
 *     is_credits_billing: true,
 *     usage_summary: { consumed_amount: 1690.06, total_amount: 5100, consumption_ratio: 0.33 },
 *     user_entitlement_pack_list: [ { display_desc:'免费', entitlement_base_info:{...} }, ... ]
 *   }
 *
 * 关键：**额度不在 credits_remain / credits_limit 这类字段里**，而在
 * usage_summary 的 total_amount（总额）与 consumed_amount（已消耗）。
 * 剩余 = 总额 − 已消耗。早先按 pack_list 里的字段求和恒得 0，界面就会
 * 显示「额度 0」——被读成「用完了」，而真相是没解析到。
 *
 * total_amount 缺失时返回 null（不补 0）：0 会被当成「额度为零」。
 */
async function usage(auth) {
  let agent;
  try { agent = agentOf(auth); } catch (e) { return { ok: false, error: e.message }; }
  const r = await c.request(c.UG_HOST, c.EP_ENT_USAGE, {
    method: 'POST', body: {}, headers: ugHeaders(withDevice(auth)), agent,
  });
  if (r.status !== 200 || !r.data) {
    return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}` };
  }
  const d = r.data.data || r.data;

  let limit = null;
  let consumed = 0;
  let anyConsumed = false;
  const s = d && d.usage_summary;
  if (s && typeof s === 'object') {
    if (s.total_amount != null && Number.isFinite(Number(s.total_amount))) {
      limit = Number(s.total_amount);
    }
    if (s.consumed_amount != null && Number.isFinite(Number(s.consumed_amount))) {
      consumed = Number(s.consumed_amount);
      anyConsumed = true;
    }
  }

  // 兜底：usage_summary 缺失时退回扫额度包里的 remain/limit 字段
  // （上游结构可能变，两条路都留着，但主路径是 usage_summary）
  if (limit == null) {
    const list = Array.isArray(d) ? d : (Array.isArray(d && d.list) ? d.list
      : Array.isArray(d && d.user_entitlement_pack_list) ? d.user_entitlement_pack_list : [d]);
    let sum = 0;
    let any = false;
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const base = it.entitlement_base_info || it;
      const v = Number(base.credits_limit ?? base.creditsLimit ?? base.limit ?? base.total_amount);
      // 负数 = 不限量，不能计入「总额」——加个 -1 只会让合计变小
      if (Number.isFinite(v) && v >= 0) { sum += v; any = true; }
    }
    if (any) limit = sum;
  }

  // 剩余 = 总额 − 已消耗；总额拿不到时如实返回 null
  const remain = limit == null ? null : Math.max(0, limit - consumed);
  return { ok: true, remain, limit, consumed: anyConsumed ? consumed : null, packs: parsePacks(d), raw: d };
}

/**
 * 解析额度包列表，取出「每个包还剩多少、什么时候到期」。
 *
 * 字段含义是**实测确认**的，不要照字段名猜：
 *   entitlement_base_info.quota.credits_limit  该包的面额
 *   usage.credits_amount                       该包**已消耗**（不是剩余！）
 *   expire_time（或 base.end_time）            到期时刻（Unix 秒）
 * 验证依据：各包 credits_amount 之和 == usage_summary.consumed_amount
 * （1504.84），各包 credits_limit 之和 == usage_summary.total_amount（5350）。
 * 所以剩余 = credits_limit − credits_amount。
 *
 * 漏掉包维度时界面只能给「总额还剩多少」一个数，答不出「哪些积分快过期了」
 * ——而签到奖励是一批批到期的（实测 32 个包、到期日从明天排到下月），
 * 那正是最该提醒的部分。
 */
function parsePacks(d) {
  const list = (d && Array.isArray(d.user_entitlement_pack_list))
    ? d.user_entitlement_pack_list : [];
  const out = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const b = it.entitlement_base_info || {};
    const q = b.quota || {};
    // 官方收银台同口径剔除三类包（traework2api-panel 的 creditspool_test）：
    // 促销包（product_type=3）、隐藏包（is_hide）、已失效包（status=3）。
    // 不剔除的话「剩余额」会被这些不可用的包抬高，界面显示的数字是假的。
    const productType = Number(it.product_type ?? it.ProductType ?? b.product_type);
    const hidden = it.is_hide === true || it.IsHide === true || it.hide === true || b.is_hide === true;
    const statusNum = it.status == null ? null : Number(it.status);
    if (productType === 3 || hidden || statusNum === 3) continue;

    const limit = Number(q.credits_limit ?? b.credits_limit);
    const used = Number((it.usage || {}).credits_amount);
    const exp = Number(it.expire_time || b.end_time) || null;
    if (!Number.isFinite(limit) && !Number.isFinite(used) && !exp) continue;
    // credits_limit = -1 表示**不限量**（官方语义）。按普通数字算会得到
    // 「剩余 0」，把不限量读成用完了。
    const unlimited = Number.isFinite(limit) && limit < 0;
    const lim = Number.isFinite(limit) && !unlimited ? limit : null;
    const usd = Number.isFinite(used) ? used : 0;
    out.push({
      name: String(it.display_desc || it.group_name || '额度包'),
      // 面额拿不到就 null——补 0 会被读成「这个包是空的」
      limit: lim,
      unlimited,
      used: Number.isFinite(used) ? usd : null,
      // 剩余按 limit − used；面额缺失/不限量时推不出来，如实 null
      remain: lim == null ? null : Math.max(0, Number((lim - usd).toFixed(4))),
      expireAt: exp ? exp * 1000 : null,
      status: statusNum,
    });
  }
  // 先按到期时间排，让「最快过期的」排在最前
  return out.sort((a, b) => (a.expireAt || Infinity) - (b.expireAt || Infinity));
}

/**
 * 付费状态 / 套餐身份 / 活动资格（`ide_user_pay_status`，2026-10-31 实测）。
 *
 * 这个端点补上了两块此前拿不到的信息：
 *
 *   1. **套餐档位**：`user_pay_identity_str`（实测 "Free"）+ `is_pay_freshman`。
 *      TRAE 的账一直是「单 credits + 签到」，看不出账号是什么套餐——
 *      界面只能说「额度还剩多少」，答不出「为什么这么少」。
 *   2. **活动资格**：`commercial_activities[]` 里带 `activity_type` 与
 *      `work_extra`（eligible/grantable/granted/general_credits）。
 *      实测 `send_message_reward`（type 105）`eligible:true` +
 *      `general_credits:500`——这是清单里「活动/邀请积分」的数据源，
 *      也是「为什么我这号没有活动」这个问题的答案。
 *
 * **解析口径**：只搬上游原值，不推断。`commercial_activities` 原样透出
 * （activity_type 的语义映射单独给一份，但**不改写原数组**）；能力位
 * （`enable_solo_*`）原样保留——它们是布尔，缺字段就是 null 而不是 false
 * （false 会被读成「明确不支持」，而真相是「上游没说」）。
 *
 * 失败不阻断任何东西：调用方（管理端 /status）拿不到就当没有这组信息，
 * 界面显示「—」而不是编一个 Free。
 */
async function payStatus(auth) {
  let agent;
  try { agent = agentOf(auth); } catch (e) { return { ok: false, error: e.message }; }
  const r = await c.request(c.UG_HOST, c.EP_PAY_STATUS, {
    method: 'POST', body: {}, headers: ugHeaders(withDevice(auth)), agent,
  });
  if (r.status !== 200 || !r.data) {
    return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}` };
  }
  const d = r.data.data || r.data;
  return { ok: true, ...parsePayStatus(d), raw: d };
}

/** activity_type 的语义（来自上游 activity_id 对照，非官方文档） */
const ACTIVITY_KINDS = {
  101: 'work_lite',
  102: 'new_user_credits',
  103: 'work_fission',
  105: 'send_message_reward',
};

/**
 * 纯函数：上游 pay_status 体 → 界面用的扁平结构。便于离线验证。
 *
 * `capabilities` 里每个值都可能是 null（上游没给这个字段），
 * **不用 `!!` 兜成 false**——见函数头注释。
 */
function parsePayStatus(d) {
  const src = d && typeof d === 'object' ? d : {};
  const boolOrNull = (v) => (typeof v === 'boolean' ? v : null);
  const numOrNull = (v) => (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

  const acts = Array.isArray(src.commercial_activities) ? src.commercial_activities : [];
  const activities = acts.map((a) => {
    if (!a || typeof a !== 'object') return null;
    const type = numOrNull(a.activity_type);
    const we = a.work_extra && typeof a.work_extra === 'object' ? a.work_extra : {};
    return {
      activityId: String(a.activity_id || ''),
      activityType: type,
      // 语义映射只作展示辅助；映射不上就 null，不改写 type
      kind: ACTIVITY_KINDS[type] || null,
      enabled: typeof a.Enabled === 'boolean' ? a.Enabled : boolOrNull(a.enabled),
      startAt: numOrNull(a.start_time_ms),
      endAt: numOrNull(a.end_time_ms),
      // 活动资格三态（work_extra 只在这几类活动里出现）
      eligible: boolOrNull(we.eligible),
      grantable: boolOrNull(we.grantable),
      granted: boolOrNull(we.granted),
      // 可领的通用积分（实测 send_message_reward=500）
      generalCredits: numOrNull(we.general_credits),
    };
  }).filter(Boolean);

  return {
    // 套餐档位（实测 "Free"）；上游没给就 null
    payIdentity: src.user_pay_identity_str || null,
    payIdentityCode: numOrNull(src.user_pay_identity),
    isFreshman: boolOrNull(src.is_pay_freshman),
    isCreditsBilling: boolOrNull(src.is_credits_billing),
    supportCommercialization: boolOrNull(src.is_support_commercialization),
    // 能力位：null = 上游没说，不是「不支持」
    capabilities: {
      soloLite: boolOrNull(src.enable_solo_lite),
      soloWeb: boolOrNull(src.enable_solo_web),
      soloCoder: boolOrNull(src.enable_solo_coder),
      soloBuilder: boolOrNull(src.enable_solo_builder),
      fission: boolOrNull(src.enable_fission),
    },
    activities,
    // 服务端时间（用来对活动起止做本地时区换算，不依赖本机时钟）
    serverTimeMs: numOrNull(src.server_time_ms),
  };
}

// ---------------------------------------------------------------------------
// 活动/权益领取（2026-11-01，traework2api-panel 实测结论，清单 P2「活动/邀请积分」）。
//
// 与签到的关系：签到领的是 checkin_credits（固定 150）；这里是 commercial
// 活动——send_message_reward（type 105，实测 500 积分）、新人/学生认证/裂变等。
// payStatus 的 activities 只给**资格**（eligible/grantable），真正的 activity_id
// 与有效期只在 activity/info 清单里。
//
// 两条纪律（panel 的 ClaimActivities 同款，照抄不猜）：
//   · 9069/9090/9070 是「现在领不到」而不是错误——记成错误会让调度器每天报警；
//   · notes 只写「哪条、什么结论」，不写积分数字——响应体里没有可信的到账
//     额度（与签到不同，这里连 gained 字段都没有）。到账与否用 usage 前后
//     差值看总量。
// ---------------------------------------------------------------------------

/** 「现在领不到」的业务码：不是失败，下一轮自然再试 */
const GRANT_PENDING_CODES = new Set([9069, 9090, 9070]);

/**
 * 纯函数：activity/info 清单体 → 待领列表。
 * 过滤掉未启用与不在有效期内的（start/end 为 0 = 不限，panel 同口径）。
 */
function parseActivityList(d, nowMs) {
  const now = Number(nowMs) || Date.now();
  const list = (d && Array.isArray(d.commercial_activities)) ? d.commercial_activities : [];
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const id = String(a.activity_id || '');
    if (!id) continue;
    const enabled = typeof a.Enabled === 'boolean' ? a.Enabled : a.enabled === true;
    if (!enabled) continue;
    const start = Number(a.start_time_ms) || 0;
    const end = Number(a.end_time_ms) || 0;
    if ((start && now < start) || (end && now > end)) continue;
    const type = Number(a.activity_type) || 0;
    out.push({ activityId: id, activityType: type, kind: ACTIVITY_KINDS[type] || null });
  }
  return out;
}

/** ug 族 POST 的统一小包装：HTTP 非 200 或 body 不带 code 时如实报错 */
async function ugPost(auth, ep, body) {
  let agent;
  try { agent = agentOf(auth); } catch (e) { return { ok: false, error: e.message }; }
  const r = await c.request(c.UG_HOST, ep, {
    method: 'POST', body, headers: ugHeaders(withDevice(auth)), agent,
  });
  if (r.status !== 200) {
    return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}` };
  }
  const d = (r.data && (r.data.data || r.data)) || {};
  // code 缺省按 0（成功）——与签到 claim 的判法同口径
  const code = Number(d.code ?? 0) || 0;
  return { ok: true, code, message: String(d.message || ''), workExtra: d.work_extra || null, raw: d };
}

/**
 * 领取单条活动的结论归一（纯函数，便于离线验证）。
 * 返回 { state: 'claimed'|'granted'|'pending'|'error'|'noop', prizeText?, error? }
 *   claimed = 本次领到；granted = 已领过（granted=true + grantable=false，panel 实测）；
 *   pending = 现在领不到（不报警）；noop = 受理了但没有 work_extra 可报（学生认证实测如此）；
 *   error   = 真失败。
 */
function claimVerdict(code, message, workExtra) {
  if (code === 0) {
    // 空对象（{}）与缺失等价：没有 granted/grantable 键就没有可报的结论
    const we = workExtra && typeof workExtra === 'object'
      && (workExtra.granted != null || workExtra.grantable != null) ? workExtra : null;
    if (!we) return { state: 'noop' };
    if (we.granted === true) {
      return { state: we.grantable === false ? 'granted' : 'claimed', prizeText: String(we.prize_text || '') || null };
    }
    // granted=false：受理但没发（可能 grantable=false 上游没给 granted 的变体）
    return { state: we.grantable === false ? 'granted' : 'pending' };
  }
  if (GRANT_PENDING_CODES.has(code)) return { state: 'pending', error: `code=${code} ${message}`.trim() };
  return { state: 'error', error: `code=${code} ${message}`.trim() };
}

/**
 * 领取当前可领的活动 + 权益（三条链路，panel 同构）。
 * 返回 { ok, notes: [{activityId, kind, state, prizeText?, error?}], benefit, error? }。
 * 领不到不是失败（pending 不进 error）；网络/HTTP 层错误单独记但不中断其余链路。
 */
async function claimActivities(rawAuth) {
  const auth = await withFreshToken(rawAuth);
  const notes = [];
  let hardError = null;
  // 清单：拿 activity_id / type / 有效期。失败时其余链路没有入参，直接返回
  const listR = await ugPost(auth, c.EP_ACTIVITY_INFO, { req_source: 1 });
  if (!listR.ok) return { ok: false, notes, error: `活动清单: ${listR.error}` };
  const acts = parseActivityList(listR.raw);
  for (const act of acts) {
    // 103 裂变必须带 activity_id 单独领；其余走 action（panel 实测，见 constants 注释）
    const ep = act.activityType === 103 ? c.EP_FISSION_GRANT : c.EP_ACTIVITY_ACTION;
    const r = await ugPost(auth, ep, { activity_id: act.activityId, req_source: 1 });
    if (!r.ok) {
      notes.push({ ...act, state: 'error', error: r.error });
      continue;
    }
    const v = claimVerdict(r.code, r.message, r.workExtra);
    notes.push({ ...act, ...v });
    if (v.state === 'error' && !hardError) hardError = `${act.activityId}: ${v.error}`;
  }
  // 兜底总入口：action 不认的那几类（send_message_reward 实测落在这里）
  const deviceId = (withDevice(auth) || {}).deviceId || '';
  const b = await ugPost(auth, c.EP_GRANT_BENEFIT, { trae_client: 'Lite', device_id: deviceId });
  let benefit;
  if (!b.ok) {
    benefit = { state: 'error', error: b.error };
  } else {
    const v = claimVerdict(b.code, b.message, b.workExtra);
    // benefit 没有 activity 维度，prize_text 同样透出
    benefit = { ...v };
    if (v.state === 'error') hardError = hardError || `权益: ${v.error}`;
  }
  return { ok: !hardError, notes, benefit, error: hardError || '' };
}

/**
 * 领活动并回写账号（供管理端手动触发与定时任务调用）。
 *
 * 前后各取一次余额算总差值（与签到 computeGained 同口径）：活动领取的响应
 * 不带发放数额，差值是「这次到底到账没有」的唯一可见依据。差值为 0 也如实
 * 返回——可能是领到的都是「已领过」，也可能是延迟入账，不在这一层粉饰。
 * 快照失败不影响领取本身（gained 如实 null）。
 */
async function claimActivitiesAndSave(rawAuth, authStore, opts = {}) {
  const auth = await withFreshToken(rawAuth);
  const before = await usage(auth);
  const r = await claimActivities(auth);
  const after = r.ok ? await usage(auth) : null;
  const creditsBefore = before.ok ? before.remain : null;
  const credits = after && after.ok ? after.remain : null;
  const gained = (r.ok && credits != null && creditsBefore != null)
    ? computeGained(creditsBefore, credits, null)
    : null;
  const claimed = r.notes.filter((n) => n.state === 'claimed' || n.state === 'granted');
  if (r.ok) {
    const fields = { lastError: '' };
    if (credits != null) fields.credits = credits;
    authStore.patch(auth.id, fields);
    // 只有确实有结论（领到/已领）才记账，全是 pending 的不刷流水
    if (claimed.length || r.benefit.state === 'claimed' || r.benefit.state === 'granted') {
      ledger.append({
        channel: 'traework', account_id: auth.id, account: auth.nickname || auth.uid || '',
        at: Date.now(), credits: gained, source: 'activity',
        detail: claimed.map((n) => n.activityId).join(','),
      });
    }
  } else {
    authStore.patch(auth.id, { lastError: `活动领取失败: ${r.error}` });
  }
  return {
    ok: r.ok,
    error: r.error || '',
    notes: r.notes,
    benefit: r.benefit,
    creditsBefore,
    credits,
    gained,
  };
}

/**
 * 算「本次签到实际到账多少」。
 *
 * 两侧余额都拿得到时取差值；算不出就退回上游直接给的 gained（通常为 null）。
 * **不补 0**——0 会被读成「签到没发积分」，而真相可能是没测到（奖励延迟入账）。
 * 差值为 0 或负数**如实返回**，交给界面解释（0 = 可能延迟入账，负数 =
 * 上游结算异常），不在这一层粉饰成 null。
 *
 * 抽成纯函数是为了能离线验证——它是「签到到底生效没有」的唯一依据，
 * 逻辑漂了用户就会重新看到「签到成功但余额没变」。
 *
 * @param {number|null} before 签到前剩余
 * @param {number|null} after 签到后剩余
 * @param {number|null} upstreamGained 上游 claim 直接给的数额（通常 null）
 * @returns {number|null}
 */
function computeGained(before, after, upstreamGained) {
  if (before != null && after != null) return Number((after - before).toFixed(4));
  return upstreamGained != null ? Number(upstreamGained) : null;
}

/**
 * 签到并回写账号（含额度刷新）。供 task-runner 调用。
 *
 * opts.respectBackoff=true 时（定时任务路径），账号还处在上一次 9074 的退避
 * 窗口内就跳过不打上游——退避的意义就是错峰，定时器反复提前打等于没退避；
 * 手动触发（管理端点「签到」）不拦：用户明确要求就试一次。
 *
 * **签到前后各取一次余额**，用差值算「本次实际到账多少」。
 * 上游 claim 只回 {code:0, message:"success"}，不告诉发放数额；status 的
 * credits 是「签到可得」的固定值，也不等于实际入账。只报总额时用户看到
 * 「签到成功 + 余额」无从判断签到是否生效——上游 status 与 usage 不同步时
 * （status 说没签、usage 已含奖励）还会出现「签到成功但余额没变」，
 * 被读成「显示的是旧积分」。快照失败不影响签到本身，拿不到就如实 null。
 */
async function checkinAndSave(rawAuth, authStore, opts = {}) {
  const auth = await withFreshToken(rawAuth);
  const bo = backoffRemaining(auth);
  if (opts.respectBackoff && bo > 0) {
    return { ok: false, backoffRemaining: bo, error: `9074 退避中（${Math.round(bo / 1000)}s 后自动重试）`, stage: 'backoff' };
  }
  const st = await status(auth);
  if (!st.ok) return { ok: false, error: st.error, stage: 'status' };
  if (st.checkedIn) {
    const u = await usage(auth);
    const fields = { lastCheckin: auth.lastCheckin || null, lastError: '' };
    if (u.ok) fields.credits = u.remain;
    authStore.patch(auth.id, fields);
    ledger.append({
      channel: 'traework', account_id: auth.id, account: auth.nickname || auth.uid || '',
      at: Date.now(), source: 'already',
    });
    return { ok: true, already: true, credits: u.ok ? u.remain : null };
  }
  const before = await usage(auth);
  const cl = await claimWithRetry(auth);
  if (!cl.ok) {
    if (!cl.rateLimited) authStore.patch(auth.id, { lastError: cl.error });
    return { ok: false, error: cl.error, stage: 'claim', rotated: cl.rotated, backoffMs: cl.backoffMs };
  }
  const u = await usage(auth);
  authStore.patch(auth.id, {
    lastCheckin: Date.now(),
    lastError: '',
    ...(u.ok ? { credits: u.remain } : {}),
  });
  const creditsBefore = before.ok ? before.remain : null;
  const credits = u.ok ? u.remain : null;
  const gained = computeGained(creditsBefore, credits, cl.gained);
  ledger.append({
    channel: 'traework', account_id: auth.id, account: auth.nickname || auth.uid || '',
    at: Date.now(), credits: gained, source: 'claim',
  });
  return {
    ok: true,
    already: false,
    gained,
    creditsBefore,
    credits,
  };
}

module.exports = { status, claim, claimWithRetry, usage, checkinAndSave, computeGained, withFreshToken, backoffMs, backoffRemaining, parsePacks, payStatus, parsePayStatus, ACTIVITY_KINDS, claimActivities, claimActivitiesAndSave, parseActivityList, claimVerdict, GRANT_PENDING_CODES };
