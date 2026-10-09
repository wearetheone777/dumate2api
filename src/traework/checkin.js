// src/traework/checkin.js - 签到 / 额度查询
//
// 三个接口都在 api.trae.cn（UgHost），请求体是空对象 {}，
// 身份全靠请求头（Authorization + X-Device-Id）。
//
// 签到是**幂等**的：已签过再 claim 不会报错，所以定时任务可以放心重跑。
const c = require('./constants');
const { ugHeaders } = require('./headers');
const authStore = require('./auth');

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

/**
 * 查签到状态：{ checkedIn, credits, extraCredits, enable }
 *
 * 实测返回体（2026-09-25）：
 *   { checked_in: false, credits: 150, extra_credits: 50, did_checked_in: false, enable: true }
 *
 * credits 是**签到可得的额度**（不是余额），did_checked_in 是今天是否已领。
 */
async function status(auth) {
  const r = await c.request(c.UG_HOST, c.EP_CHECKIN_STATUS, {
    method: 'POST', body: {}, headers: ugHeaders(withDevice(auth)),
  });
  if (r.status !== 200 || !r.data) {
    return { ok: false, error: `HTTP ${r.status} ${String(r.raw).slice(0, 120)}` };
  }
  // 上游把结果包在 data 里，也可能是平铺——两种都认
  const d = r.data.data || r.data;
  return {
    ok: true,
    checkedIn: !!(d.checked_in ?? d.did_checked_in ?? d.checkedIn),
    credits: Number(d.credits ?? d.credit ?? 0) || 0,
    // 额外赠送（如连续签到奖励）。没有就如实给 0，不编
    extraCredits: Number(d.extra_credits ?? d.extraCredits ?? 0) || 0,
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

async function claim(auth) {
  const r = await c.request(c.UG_HOST, c.EP_CHECKIN_CLAIM, {
    method: 'POST', body: {}, headers: ugHeaders(withDevice(auth)),
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
  const r = await c.request(c.UG_HOST, c.EP_ENT_USAGE, {
    method: 'POST', body: {}, headers: ugHeaders(withDevice(auth)),
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
      if (Number.isFinite(v)) { sum += v; any = true; }
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
    const limit = Number(q.credits_limit ?? b.credits_limit);
    const used = Number((it.usage || {}).credits_amount);
    const exp = Number(it.expire_time || b.end_time) || null;
    if (!Number.isFinite(limit) && !Number.isFinite(used) && !exp) continue;
    const lim = Number.isFinite(limit) ? limit : null;
    const usd = Number.isFinite(used) ? used : 0;
    out.push({
      name: String(it.display_desc || it.group_name || '额度包'),
      // 面额拿不到就 null——补 0 会被读成「这个包是空的」
      limit: lim,
      used: Number.isFinite(used) ? usd : null,
      // 剩余按 limit − used；面额缺失时推不出来，如实 null
      remain: lim == null ? null : Math.max(0, Number((lim - usd).toFixed(4))),
      expireAt: exp ? exp * 1000 : null,
      status: it.status == null ? null : Number(it.status),
    });
  }
  // 先按到期时间排，让「最快过期的」排在最前
  return out.sort((a, b) => (a.expireAt || Infinity) - (b.expireAt || Infinity));
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
 * **签到前后各取一次余额**，用差值算「本次实际到账多少」。
 * 上游 claim 只回 {code:0, message:"success"}，不告诉发放数额；status 的
 * credits 是「签到可得」的固定值，也不等于实际入账。只报总额时用户看到
 * 「签到成功 + 余额」无从判断签到是否生效——上游 status 与 usage 不同步时
 * （status 说没签、usage 已含奖励）还会出现「签到成功但余额没变」，
 * 被读成「显示的是旧积分」。快照失败不影响签到本身，拿不到就如实 null。
 */
async function checkinAndSave(rawAuth, authStore) {
  const auth = await withFreshToken(rawAuth);
  const st = await status(auth);
  if (!st.ok) return { ok: false, error: st.error, stage: 'status' };
  if (st.checkedIn) {
    const u = await usage(auth);
    const fields = { lastCheckin: auth.lastCheckin || null, lastError: '' };
    if (u.ok) fields.credits = u.remain;
    authStore.patch(auth.id, fields);
    return { ok: true, already: true, credits: u.ok ? u.remain : null };
  }
  const before = await usage(auth);
  const cl = await claim(auth);
  if (!cl.ok) {
    authStore.patch(auth.id, { lastError: cl.error });
    return { ok: false, error: cl.error, stage: 'claim' };
  }
  const u = await usage(auth);
  authStore.patch(auth.id, {
    lastCheckin: Date.now(),
    lastError: '',
    ...(u.ok ? { credits: u.remain } : {}),
  });
  const creditsBefore = before.ok ? before.remain : null;
  const credits = u.ok ? u.remain : null;
  return {
    ok: true,
    already: false,
    gained: computeGained(creditsBefore, credits, cl.gained),
    creditsBefore,
    credits,
  };
}

module.exports = { status, claim, usage, checkinAndSave, computeGained, withFreshToken };
