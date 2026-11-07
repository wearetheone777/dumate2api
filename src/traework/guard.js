// src/traework/guard.js - 上游账号的用量护栏（调研 P2-16 的另三项）
//
// 与 `policy.js` 的「保留积分」互补：那个看**余额快照**决定「这个号还有没有钱」，
// 这里看**当日已用量**决定「今天这个号是不是用过头了」。
//
// 三项（都默认关，阈值由运行期配置给）：
//   dailyTokens   每账号每日 token 上限
//   dailyCredits  每账号每日积分上限（用当日 consumed 增量，非余额）
//   modelTokens   按 (账号, 模型) 的每日 token 上限
//
// 为什么只做这三项、不做第 4 项（保留积分）以外的东西：这三项都能从
// **本进程已有的落盘事实**算出来（requests.jsonl 的 account_id/channel/model/
// *_tokens + traework-credits.jsonl 的 consumed 游标），不需要打上游、不需要
// 新存储。凭空的「月度预算」「配额分摊」需要产品设计，不在本次范围。
//
// 三条纪律：
//   1. **未知不拦**。account_id 缺失（provider 没上报）、余额/用量读不到，
//      一律放行——把「不知道」当成「用完了」会让整池静默不可用。
//   2. **只拦新请求，不打断在途**。判定发生在选号前，已发出的请求不受影响。
//   3. **判定口径与展示对齐**。同一份统计函数既给护栏用，也给管理端展示，
//      两处各算一遍必然漂移。
const reqlog = require('../reqlog');

/** 本地日期键（与 key-quota / credits.dayKey 同口径：本地零点切分） */
function dayKey(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 当天零点的本地时间戳（统计窗口起点） */
function dayStart(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 从请求日志聚合当天用量。纯函数，rows 由调用方给（便于离线测试）。
 *
 * @param {Array} rows requests.jsonl 行
 * @param {{channel?:string, now?:number}} opts
 * @returns {{byAccount: Map<string,{tokens:number,requests:number}>, byModel: Map<string,number>, total: number}}
 */
function usageOf(rows, opts = {}) {
  const channel = String(opts.channel || 'traework');
  const since = dayStart(opts.now);
  const byAccount = new Map();
  const byModel = new Map();
  let total = 0;
  for (const r of rows || []) {
    if (!r || Number(r.ts) < since) continue;
    if ((r.channel || 'dumate') !== channel) continue;
    // account_id 缺失的行不进任何桶——不知道是谁的用量，不能摊到别人头上
    if (r.account_id == null || r.account_id === '') continue;
    const id = String(r.account_id);
    const tokens = num(r.total_tokens) || (num(r.input_tokens) + num(r.output_tokens));
    const a = byAccount.get(id) || { tokens: 0, requests: 0 };
    a.tokens += tokens;
    a.requests += 1;
    byAccount.set(id, a);
    total += tokens;
    if (r.model) {
      const k = `${id}\x00${String(r.model)}`;
      byModel.set(k, (byModel.get(k) || 0) + tokens);
    }
  }
  return { byAccount, byModel, total };
}

/** 读请求日志并聚合（生产路径；limit:0 = 全量，按 ts 过滤后再聚合） */
function usageNow(opts = {}) {
  const since = dayStart(opts.now);
  const rows = reqlog.read({ limit: 0, filter: (r) => Number(r.ts) >= since }).rows;
  return usageOf(rows, opts);
}

/**
 * 判定一批候选账号里哪些超了当天护栏。
 *
 * @param {Array<{id:number,nickname?:string}>} candidates
 * @param {object} cfg 运行期配置的 accountGuard 段
 * @param {object} ctx { model, usage, creditsByAccount }
 * @returns {{rows:Array, blocked:Array<{id,name,reason,used,limit}>}}
 */
function applyDaily(candidates, cfg, ctx = {}) {
  if (!cfg || cfg.enabled !== true) return { rows: candidates, blocked: [] };
  const usage = ctx.usage || { byAccount: new Map(), byModel: new Map() };
  const tokenCap = Number(cfg.dailyTokens) > 0 ? Number(cfg.dailyTokens) : 0;
  const creditCap = Number(cfg.dailyCredits) > 0 ? Number(cfg.dailyCredits) : 0;
  const modelCap = Number(cfg.modelTokens) > 0 ? Number(cfg.modelTokens) : 0;
  if (!tokenCap && !creditCap && !modelCap) return { rows: candidates, blocked: [] };

  const rows = [];
  const blocked = [];
  for (const a of candidates || []) {
    // account_id 在日志里是数字；候选的 id 同源
    const key = String(a.id);
    const used = usage.byAccount.get(key);
    const push = (reason, u, limit) => blocked.push({
      id: a.id, name: a.nickname || a.uid || `账号 ${a.id}`, reason, used: u, limit,
    });

    // 按 (账号, 模型)：只拦这个模型，其他模型仍可用
    if (modelCap && ctx.model) {
      const mt = usage.byModel.get(`${key}\x00${ctx.model}`) || 0;
      if (mt >= modelCap) { push('model_tokens', mt, modelCap); continue; }
    }
    // 账号级 token
    if (tokenCap && used && used.tokens >= tokenCap) {
      push('daily_tokens', used.tokens, tokenCap);
      continue;
    }
    // 账号级积分（当日 consumed 增量，由 credits 账本算；拿不到就不判）
    if (creditCap && ctx.creditsByAccount) {
      const c = ctx.creditsByAccount.get(key);
      if (Number.isFinite(c) && c >= creditCap) { push('daily_credits', c, creditCap); continue; }
    }
    rows.push(a);
  }
  return { rows, blocked };
}

/** 被护栏拦下时的可读原因（区分是哪一项） */
function blockedReason(blocked) {
  if (!blocked || !blocked.length) return '';
  const label = { daily_tokens: '今日 token', daily_credits: '今日积分', model_tokens: '该模型今日 token' };
  const first = blocked[0];
  return `TRAE 账号用量护栏：${blocked.length} 个账号已达上限`
    + `（如 ${first.name} ${label[first.reason] || first.reason} ${first.used}/${first.limit}），`
    + '到本地零点自动重置；可在「运行策略」页调整或关闭';
}

module.exports = { dayKey, dayStart, usageOf, usageNow, applyDaily, blockedReason };
