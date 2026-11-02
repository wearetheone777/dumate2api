// src/admin/routes/qwenwork.js - 千问办公通道：账号、积分、状态、模型
//
// 2026-09-25 改：这条通道的凭证不再来自官方客户端的 auth-v2.dat，而是
// 我们自己走 device flow 换来的、存在 data/qwenwork-accounts.json 里
// （见 src/qwenwork/auth.js 与 login.js）。所以账号从「单账号只读」变成
// 「多账号可增删」，与 TRAE Work 路由（traework.js）同构。
//
// **对外响应形状保持**：前端三个页面（登录态 / 账号管理 / 仪表盘）在按现有
// 字段渲染，这里只换取值来源，不换字段。
const { sendJSON } = require('../router');
const authStore = require('../../qwenwork/auth');
const login = require('../../qwenwork/login');
const credits = require('../../qwenwork/credits');
// 临期积分快照（FEFO 数据源）：写方在 /accounts，读方在 qwenwork/index.js
const expiringSnap = require('../../expiring');

// 缓存：余额要打站点接口，仪表盘刷新不该每次都穿透。
// 按账号分桶——缓存里存的是「谁有多少」，混在一起会张冠李戴。
let cache = { at: 0, data: new Map() };
const CACHE_MS = 15000;

/** 月度额度的刷新时刻（active_wallet 的 valid_to，上游唯一给出的额度变更点） */
function resetAt(w) {
  if (w && w.refreshAt) return w.refreshAt;
  const list = (w && w.activeWallets) ? w.activeWallets : [];
  for (const x of list) if (x && x.valid_to) return x.valid_to;
  return null;
}

/** 主账号的余额（带 15s 缓存） */
async function walletsOf(account) {
  if (!account) return null;
  const key = String(account.id);
  const hit = cache.data.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.w;
  // 查余额前先按需换票（判据与 chat.ensureAccount 相同）。
  //
  // 为什么必须在这里换：聊天链路的 runOnce 会 ensureAccount，管理端却直接拿
  // 存档里的 accessToken 去打 /user/wallets。备用账号不被使用，token 到期后
  // 永远没人续——于是余额读成 0、到期时间标红，界面看起来像「账号失效」，
  // 其实 refresh token 完全有效、额度也还在（2026-10-21 实测：账号 2 的
  // access token 18:04 过期后，wallets 全 0，而 account-context 报剩余 100）。
  //
  // 换票成功会落盘并清掉 lastError（exchange 返回 lastError:''）——备用号
  // 上一次的瞬时失败（如 5 天前的 402）也就顺手清掉了，不会一直挂在卡上。
  // 换票失败不阻断查询：用旧 token 试一次，结果如实上报（余额取不到显示 —）。
  let acc = account;
  if (authStore.needsRefresh(account)) {
    try {
      const r = await authStore.exchange(account);
      if (r && r.ok) {
        acc = authStore.patch(account.id, r.patch) || { ...account, ...r.patch };
      }
    } catch (e) { /* 换票异常就用旧凭证试，失败会体现在 w.ok 上 */ }
  }
  const w = await credits.fetchWallets({ account: acc });
  cache.data.set(key, { at: Date.now(), w });
  cache.at = Date.now();
  return w;
}

/**
 * 全账号合计的三池视图。
 *
 * 为什么是「合计」：三池是**账号级**的——每个账号各有一份自己的余额。
 * 池子卡回答的是「这条通道我总共还剩多少」，两个账号各 100 就该显示 200。
 *
 * 早先这里只读主账号（authStore.preferred()），于是两账号时池子卡显示 100，
 * 而同一页顶部「积分余额」卡读的是 /accounts 的 summary.pointsTotal，
 * **本来就是全账号合计** = 200——同页两个数字对不上，被读成「少算了一个账号」。
 *
 * 账号范围与 /accounts 保持一致（list() 全量，不只 usable）：两处口径必须同源，
 * 否则「顶部合计」与「池子合计」还是会差。查余额失败的账号不计入合计，
 * 但会在 failedAccounts 里如实报出——否则合计被读成全量。
 *
 * **2026-11-02 起不再有「每日上限」这一套**（上游不再发放每日免费额度，
 * 见 credits.js 顶部）。原来的 limit / peak / calibrated / freeUsed /
 * dailyCap 全部删除：它们的唯一数据来源是「观测到的每日峰值」，而 daily 恒 0
 * 时峰值恒 0，只会产出「上限=配置 100、已用推不出」这种无意义的组合。
 *
 * 每个账号的池子余额在**上游坏读**时是 null（未知），不是 0——合计里按
 * 跳过处理并在 misreadAccounts 里报出，让「部分和」这件事看得见。
 */
async function aggregateWallets() {
  const all = authStore.list();
  const rows = [];
  for (const a of all) {
    let w = null;
    try { w = await walletsOf(authStore.get(a.id)); } catch (e) { w = null; }
    rows.push({ a, w });
  }
  const ok = rows.filter((r) => r.w && r.w.ok);
  if (!ok.length) {
    const bad = rows.find((r) => r.w && r.w.error);
    return { ok: false, error: (bad && bad.w.error) || NO_ACCOUNT };
  }

  // 池子合计只累加**已知**的余额：坏读给 null，加法会把它当 0 加进去，
  // 那是把「不知道」写成「没有」。所以显式判空。
  //
  // **daily 池不再出现在对外响应里**：上游 2026-11-01 起已停止发放每日免费
  // 额度，实测两个账号都恒为 0。留着它只会在界面上多一张永远显示 0 的卡。
  // 归因账本里的 free 字段保留（历史数据是真值），但这里不再汇总 daily。
  let monthly = 0; let longterm = 0; let total = 0;
  let totalKnown = 0;
  let reset = null;
  let expiringSoon = { count: 0, total: 0, wallets: [] };
  let retriedCount = 0;
  let misreadCount = 0;
  const accounts = [];
  for (const { a, w } of ok) {
    // 重试过且仍是全 0（上游持续返回可疑响应）。合计照常算，
    // 但要标出来——否则用户看到一个「可能是真耗尽、也可能读失败」的 0 却不知情
    if (w.retried) retriedCount++;
    // 全 0 已被 account-context 校正过的账号：池子分配未知，但总数是权威的。
    // 这类账号的 0 已确认是 wallets 坏读，不是「额度用光」。
    if (w.misread) misreadCount++;
    const tKnown = typeof w.total === 'number' && Number.isFinite(w.total);
    if (typeof w.monthly === 'number' && Number.isFinite(w.monthly)) monthly += w.monthly;
    if (typeof w.longterm === 'number' && Number.isFinite(w.longterm)) longterm += w.longterm;
    if (tKnown) { total += w.total; totalKnown++; }
    if (!reset) reset = resetAt(w);
    if (w.expiringSoon && w.expiringSoon.count > 0) {
      expiringSoon = {
        count: expiringSoon.count + w.expiringSoon.count,
        total: expiringSoon.total + w.expiringSoon.total,
        wallets: expiringSoon.wallets.concat(w.expiringSoon.wallets || []),
      };
    }
    accounts.push({
      id: String(a.id),
      name: a.nickname || a.uid || `账号 ${a.id}`,
      monthly: typeof w.monthly === 'number' ? w.monthly : null,
      longterm: typeof w.longterm === 'number' ? w.longterm : null,
      total: tKnown ? w.total : null,
      refreshAt: resetAt(w),
      // 该账号的余额是上游坏读、已用 account-context 的权威总数校正
      misread: !!w.misread,
      // 重试后仍是全 0（可能真耗尽，也可能上游持续异常）
      retried: !!w.retried,
    });
  }

  // 定点化：浮点累加会给出 199.99349999999998 这种噪声，接口不该外传它。
  // 4 位小数与归因记录（credits.capture）的口径一致。
  const r4 = (v) => Number(v.toFixed(4));
  // 有账号余额未知时合计是**部分和**，界面必须说明（failedAccounts +
  // misreadAccounts 两个来源都算）
  const partial = totalKnown < ok.length;
  return {
    ok: true,
    error: '',
    accountCount: ok.length,
    failedAccounts: rows.length - ok.length,
    // 上游重试后仍返回全 0 的账号数。这类账号的 0 可能是真·额度耗尽，
    // 也可能是上游持续异常——无法区分，界面要如实说明
    retriedAccounts: retriedCount,
    // 其中已被 account-context 校正过的账号数（池子分配未知，总数权威）。
    // 这些账号的 0 已确认是 wallets 坏读——界面要说「已校正」，不是「已用光」。
    misreadAccounts: misreadCount,
    accounts,
    monthly: r4(monthly),
    longterm: r4(longterm),
    total: totalKnown ? r4(total) : null,
    paid: r4(monthly + longterm),
    // 合计里有多少个账号的余额是已知的（其余是未知，不是 0）
    totalKnown,
    partial,
    resetAt: reset,
    expiringSoon,
    // 主账号名保留：旧调用方/日志在按它渲染；注意它**不再代表全体**
    account: accounts[0].name,
  };
}

/**
 * 按天聚合归因历史。
 *
 * **不再拆 free / paid 两列**（2026-11-02）：上游已停止发放每日免费额度，
 * 现在的消耗全部落在付费池，free 恒 0。拆成两列会让图上永远有一条贴地的
 * 零线，读者还得自己判断它是不是「坏了」。历史行里的 free 仍然保留在账本
 * 里（那是当时的真数据），但对外只给合计。
 */
function dailyUsage(days) {
  const c = require('../../qwenwork/credits');
  const rows = c.readHistory();
  const since = Date.now() - days * 86400000;
  const byDay = new Map();
  for (const r of rows) {
    if (!r || r.ts < since) continue;
    const d = new Date(r.ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cur = byDay.get(key) || { day: key, total: 0, requests: 0, concurrent: 0 };
    cur.total += r.total || 0;
    cur.requests += 1;
    if (r.concurrent) cur.concurrent += 1;
    byDay.set(key, cur);
  }
  // 补齐没有请求的日期，否则折线图会把间隔压掉
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cur = byDay.get(key) || { day: key, total: 0, requests: 0, concurrent: 0 };
    out.push({
      day: key,
      total: Number(cur.total.toFixed(4)),
      requests: cur.requests,
      concurrent: cur.concurrent,
    });
  }
  return out;
}

/** 今日经本网关的消耗。同样只给合计（见 dailyUsage 的注释） */
function todayUsage() {
  const c = require('../../qwenwork/credits');
  const rows = c.readHistory();
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let total = 0; let n = 0;
  for (const r of rows) {
    if (!r) continue;
    const rd = new Date(r.ts);
    const key = `${rd.getFullYear()}-${String(rd.getMonth() + 1).padStart(2, '0')}-${String(rd.getDate()).padStart(2, '0')}`;
    if (key !== today) continue;
    total += r.total || 0;
    n += 1;
  }
  return { total: Number(total.toFixed(4)), requests: n };
}

const NO_ACCOUNT = '尚未添加千问账号，请到账号管理添加（走浏览器登录，不需要开千问客户端）';

/**
 * 主账号的登录态视图。
 *
 * 形状与以前的「读客户端 auth-v2.dat」版本一致（前端在按这些字段渲染），
 * 只是取值换成账号池里的主账号。file/fileStat 不再有意义——没有客户端文件
 * 这个概念了，如实给 null 而不是编一个路径。
 */
function loginDetail() {
  const out = {
    ok: false,
    error: '',
    // 凭证来源现在是账号池文件，顺手报出来，排查「文件被清了」时用得上
    file: null,
    fileStat: null,
    machineId: '',
    account: null,
    token: { accessExpiresAt: null, refreshExpiresAt: null, accessExpired: false, refreshExpired: false },
    ready: false,
    wasm: null,
  };
  try {
    const w = require('../../qwenwork/wasm-path').resolveDetailed();
    out.wasm = w ? w.version : null;
  } catch (e) { /* wasm 找不到不影响读账号 */ }

  const a = authStore.preferred();
  if (!a) {
    out.error = NO_ACCOUNT;
    return out;
  }
  try {
    const fs = require('fs');
    const p = authStore.filePath();
    out.file = p;
    try {
      const st = fs.statSync(p);
      out.fileStat = { size: st.size, mtime: st.mtimeMs };
    } catch (e) { /* 读不到就留 null */ }
  } catch (e) { /* 路径取不到不影响主流程 */ }

  out.account = {
    id: a.uid || String(a.id),
    name: a.nickname || '',
    username: a.username || '',
    email: a.email || '',
    tier: a.tier || '',
    planName: a.planName || '',
    planId: a.planId || '',
    planSubscriptionActive: false,
    planNextDueDate: null,
    isBiz: false,
    orgName: null,
    // 页面额度（pageQuota / monthRequests / monthTraffic）来自 account-context 的
    // page 段，账号池里没存——不给就留 null，界面显示 —，不编数字
    entitlements: null,
  };
  const parse = (s) => {
    const t = Date.parse(s || '');
    return Number.isFinite(t) ? t : null;
  };
  const aExp = a.expiresAt || null;
  const rExp = a.refreshExpiresAt || parse(a.refreshExpiresAt) || null;
  out.token = {
    accessExpiresAt: aExp,
    refreshExpiresAt: rExp,
    accessExpired: aExp !== null && Date.now() >= aExp,
    refreshExpired: rExp !== null && Date.now() >= rExp,
  };
  out.machineId = a.machineId || '';
  out.ok = true;
  return out;
}

/** 积分逐笔明细：从归因历史读，按时间倒序 */
function creditRecords(limit) {
  const c = require('../../qwenwork/credits');
  const rows = c.readHistory();
  return rows
    .slice()
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit)
    .map((r) => ({
      ts: r.ts,
      req_id: r.req_id || '',
      model: r.model || '',
      ms: r.ms ?? null,
      // free/paid 不再外传（见 dailyUsage 的注释）：上游停发每日额度后
      // free 恒 0，界面上那一列永远是 0，读者还得自己判断是不是坏了
      total: r.total || 0,
      concurrent: !!r.concurrent,
      balance: r.balance || null,
      account: r.account || null,
    }));
}

const routes = [
  {
    method: 'GET',
    path: '/account',
    handler: async ({ req, res }) => {
      return sendJSON(res, 200, loginDetail());
    },
  },
  {
    method: 'GET',
    path: '/credits/records',
    handler: async ({ req, res }) => {
      const limit = Math.min(1000, Math.max(1, parseInt((req.url.match(/[?&]limit=(\d+)/) || [])[1] || '100', 10) || 100));
      const rows = creditRecords(limit);
      const sum = rows.reduce((s, r) => ({
        total: s.total + r.total,
      }), { total: 0 });
      return sendJSON(res, 200, {
        limit,
        rows,
        // 汇总只统计本次返回的窗口，界面要写清范围
        window: {
          total: Number(sum.total.toFixed(4)),
          requests: rows.length,
        },
      });
    },
  },
  {
    /**
     * 计费自检探针（千问版）：发一个小请求，报本次请求的三池余额差值。
     * 对齐 TRAE/Qoder 的同名端点，但**千问上游没有标称倍率**（模型表无
     * price_factor），所以没有 ratio——只回答「这一次实际扣了多少、折算
     * 每千 token 多少」。探针消耗真实额度（flash 一次约 0.002~0.01 credits）。
     */
    method: 'GET',
    path: '/billing-check',
    handler: async ({ req, res }) => {
      const model = decodeURIComponent(((req.url.match(/[?&]model=([^&]*)/) || [])[1] || ''))
        .replace(/^qwen\//, '').trim();
      if (!model) return sendJSON(res, 400, { ok: false, error: '缺 model 参数（如 ?model=flash）' });
      const billing = require('../../qwenwork/billing');
      const qw = require('../../qwenwork');

      const usable = authStore.findUsable();
      if (!usable.length) return sendJSON(res, 200, { ok: false, model, error: NO_ACCOUNT });

      // 三池快照。**force 读**：探针要看实时值，30s 缓存会把本次差值吞掉。
      // 只收「三个池子余额都已知」的账号——坏读（null）时差值无从计算，
      // 混进去会让 billed 变成一个凭空来的数。
      const snapshot = async () => {
        const m = new Map();
        for (const raw of usable) {
          const w = await credits.fetchWallets({ account: raw, force: true });
          if (w.ok && typeof w.daily === 'number' && typeof w.monthly === 'number'
              && typeof w.longterm === 'number') {
            m.set(String(raw.id), { daily: w.daily, monthly: w.monthly, longterm: w.longterm });
          }
        }
        return m;
      };

      const before = await snapshot();
      if (!before.size) {
        return sendJSON(res, 200, { ok: false, model, error: '三池余额全部读取失败（先到额度页确认账号可用）' });
      }
      const reqId = `billcheck_${Date.now().toString(36)}`;
      const startedAt = Date.now();
      let servedId = null;
      let servedName = '';
      let tokens = null;
      try {
        const agg = await qw.send({
          model: `qwen/${model}`,
          // 输出足够长才能让四位小数的余额差值远离量化误差（成本量级见 note）
          messages: [{ role: 'user', content: '请从 1 数到 400，每个数字之间用一个空格分隔，只输出数字本身，不要输出任何其他文字。' }],
          max_tokens: 4096,
        }, undefined, {
          reqId,
          onAccount: (name, id) => { servedName = name || ''; if (id != null) servedId = id; },
        });
        const u = (agg && agg.usage) || null;
        if (u) tokens = { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, total: u.total_tokens || 0 };
      } catch (e) {
        return sendJSON(res, 200, { ok: false, model, error: e.message, elapsedMs: Date.now() - startedAt });
      }

      // 结算延迟：credits.capture 的实测余量是 1.5s；最多 3 轮（约 4 秒），
      // 仍没有就如实报 null——不把「没测到」编成 0。
      let last = null;
      for (let i = 0; i < 3; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, [1500, 2500][i - 1]));
        const after = await snapshot();
        last = billing.attributeWalletDelta(before, after, servedId);
        if (last.delta && last.delta.total > 0) break;
        // 别的账号先减（并发流量）也停——再等只会把对方的消耗卷进来
        if (last.charged.length) break;
      }
      const delta = last ? last.delta : null;
      const billed = billing.perKTokens(delta && delta.total, tokens && tokens.total);
      return sendJSON(res, 200, {
        ok: true,
        model,
        account: servedName || null,
        accountId: servedId,
        // 千问的 price_factor 是**相对倍率**（上游模型表），与三池 credits
        // 不是同一单位——直接算 ratio 会得到 0.02 这种没有意义的数。
        // 所以这里如实 null，倍率只在模型页展示，判读靠历史量级。
        expected: null,
        billed,
        ratio: null,
        cost: delta ? delta.total : null,
        pools: delta || null,
        tokens,
        charged: last ? last.charged.map((c) => ({ id: c.id, total: c.delta.total })) : [],
        singleAccount: last ? last.singleAccount : false,
        elapsedMs: Date.now() - startedAt,
        warning: !delta || delta.total == null
          ? '请求成功，但约 4 秒内未观测到三池余额减少（结算延迟，或本次未计费）'
          : '',
        note: '千问上游模型表有 price_factor（相对倍率，2026-10-31 起解析并在模型页展示），'
          + '但它与三池 credits 不是同一单位，所以这里不算 ratio；只报本次实测成本：'
          + 'cost 取三池余额差值（与逐笔归因同口径），billed 是折算的每千 token 成本。'
          + '实测量级 flash 约 0.002~0.01 credits / 千 token；余额 4 位小数，短请求的偏差主要来自精度。'
          + '注意 2026-11-01 起上游不再发放每日免费额度，daily 池恒为 0，'
          + '本探针的消耗全部落在 monthly（pools.daily 恒 0 是上游现状，不是测量失败）。',
      });
    },
  },
  {
    // 账号列表。多账号：可增删、可停用、可指定主账号
    method: 'GET',
    path: '/accounts',
    handler: async ({ req, res }) => {
      const d = loginDetail();
      const accounts = [];
      // 余额查询失败的账号（FEFO 快照的 keepIds 用）
      const walletsUnknown = [];
      const all = authStore.list();
      for (const a of all) {
        let wallets = null;
        // 即将过期的积分（上游 expiring_soon 段）——**这才是真会作废的那部分**。
        let expiringSoon = { count: 0, total: 0, wallets: [] };
        // walletsKnown：本次查询成功。查询失败时 expiringSoon 停留在默认空值，
        // 分不清「没有临期」还是「没查到」——FEFO 写方要靠它保留旧条目
        let walletsKnown = false;
        try {
          const w = await walletsOf(authStore.get(a.id));
          if (w && w.ok) {
            walletsKnown = true;
            wallets = {
              // daily 池不再外传：上游已停发每日免费额度，恒 0
              monthly: w.monthly, longterm: w.longterm, total: w.total,
              // 上游 active_wallet 的到期时刻 = 月度额度刷新点（实测月初）
              refreshAt: resetAt(w),
              // 该账号余额是上游坏读、已用 account-context 的权威总数校正：
              // 池子分配未知（monthly/longterm 为 null），total 可信
              misread: !!w.misread,
            };
            if (w.expiringSoon) expiringSoon = w.expiringSoon;
          }
        } catch (e) { /* 余额取不到不影响账号信息 */ }
        if (!walletsKnown) walletsUnknown.push(String(a.id));
        accounts.push({
          id: String(a.id),
          name: a.nickname || a.uid || `账号 ${a.id}`,
          username: a.username || '',
          email: a.email || '',
          // 只给脱敏形式（157****1251）。完整号码是 PII，留在账号文件里
          phone: a.phoneMasked || '',
          tier: a.tier || '',
          planName: a.planName || '',
          // active = 主账号（前端用它标「当前在用」）
          active: !!a.preferred,
          // 用 list() 带出的布尔判定，不要碰 refreshToken 本身（它没被外传）
          usable: a.enabled !== false && a.hasRefresh && a.hasAccess && !a.refreshExpired,
          enabled: a.enabled !== false,
          // 仪表盘账号健康快照：账号存活天数 + 总积分
          daysAlive: a.daysAlive,
          // 读上面查到的 wallets，不是 a.wallets——a 是 list() 的脱敏视图，
          // 它没有余额字段，写成 a.wallets 会让这里恒为 null
          points: wallets ? wallets.total : null,
          expiringSoon,
          tokenExpiresAt: a.expiresAt || null,
          refreshExpiresAt: a.refreshExpiresAt || null,
          refreshExpired: !!(a.refreshExpiresAt && Date.now() >= a.refreshExpiresAt),
          machineId: a.machineId || '',
          lastError: a.lastError || '',
          // lastError 的写入时刻，界面显示「N 分钟前」用。没有它会把几小时前
          // 的瞬时错误误读成当前故障
          lastErrorAt: a.lastErrorAt || null,
          refreshTail: a.refreshTail || '',
          wallets,
        });
      }

      // 临期快照（FEFO 数据源）：千问的 expiring_soon 是上游点名「真会作废」
      // 的积分（`expiring_soon.wallets` 里那些按有效期消失的钱包）。这里本就
      // 在拉余额，顺手按账号落盘最早到期时刻（src/expiring.js）；快照陈旧
      // 则网关退回普通轮询，可用性不依赖这份数据。
      //
      // **不要把 active_wallets 的 valid_to 当成临期**：那是月度额度的刷新点
      // （实测 12-01，两个账号一致），不是「会作废」。拿它当临期会让 FEFO
      // 常驻开启、天天把流量钉在同几个账号上。
      // 余额查询失败的账号走 keepIds 保留旧条目——「查不到」不等于「无临期」
      expiringSnap.update('qwenwork',
        accounts.filter((a) => a.expiringSoon && a.expiringSoon.count > 0).map((a) => {
          const valids = (a.expiringSoon.wallets || [])
            .map((w) => Date.parse(w.valid_to || ''))
            .filter((n) => Number.isFinite(n) && n > Date.now());
          return { accountId: a.id, nearest: valids.length ? Math.min(...valids) : null };
        }),
        { keepIds: walletsUnknown });

      return sendJSON(res, 200, {
        mode: 'multi',
        modeNote: '千问办公的凭证由本项目自行 device flow 换取并保存（data/qwenwork-accounts.json），可多账号并存、可增删；换账号不需要打开千问客户端。',
        count: accounts.length,
        accounts,
        // 顶部指标卡用。口径与搭子那边对齐（账号总数 / 有效期内 / 即将过期 /
        // 积分余额），让切通道时读到的是一回事。
        summary: (() => {
          const enabled = accounts.filter((a) => a.enabled);
          // 「有效期内」= 凭证可用（enabled 且未 refreshExpired）。
          // 千问没有订阅到期日这个概念（免费版无 next_due_date），
          // 所以这里用凭证可用性而不是搭子的「会员剩余天数」。
          const valid = enabled.filter((a) => a.usable).length;
          const soon = accounts.filter((a) => (a.expiringSoon && a.expiringSoon.count > 0));
          return {
            total: accounts.length,
            enabled: enabled.length,
            disabled: accounts.length - enabled.length,
            valid,
            expiringSoon: soon.length,
            // 即将过期积分的**总量**（不是账号数）——用户关心的是「有多少积分
            // 会作废」，账号数只是它的来源分布
            expiringSoonPoints: Number(soon
              .reduce((s, a) => s + (a.expiringSoon.total || 0), 0).toFixed(4)),
            // 定点化：浮点累加会外传 90.11019999999999 这种噪声，与各池合计
            // 的 4 位小数口径保持一致
            pointsTotal: Number(accounts
              .reduce((s, a) => (a.points == null ? s : s + a.points), 0).toFixed(4)),
          };
        })(),
        error: accounts.length ? '' : (d.error || NO_ACCOUNT),
        // FEFO 快照的新鲜度（排障用：网关有没有在按临期优先选号）
        fefo: expiringSnap.info('qwenwork'),
      });
    },
  },
  {
    // 发起一次登录：返回给用户打开的授权地址
    method: 'POST',
    path: '/login/start',
    handler: async ({ req, res }) => {
      try {
        return sendJSON(res, 200, login.startFlow());
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: e.message });
      }
    },
  },
  {
    // 轮询取票。只查一次就返回——等待由前端定时调，不把 HTTP 请求挂 5 分钟
    method: 'POST',
    path: '/login/poll',
    handler: async ({ res, body }) => {
      const nonce = body && body.nonce;
      if (!nonce) return sendJSON(res, 400, { error: '缺少 nonce（需先调 /login/start）' });
      const r = await login.pollFlow(nonce);
      // 审计（Q4）：poll 成功即凭据（refresh token）落盘的时刻；pending/error
      // 每秒轮询会来，只审成功避免刷屏
      if (r && r.status === 'ok') {
        try { require('../auth').audit('admin', 'qwenwork_login', (r.account && r.account.id) || '', '凭据落盘'); } catch (e) { /* 审计失败不影响结果 */ }
      }
      return sendJSON(res, 200, r);
    },
  },
  {
    method: 'POST',
    path: '/login/cancel',
    handler: async ({ res, body }) => {
      const nonce = body && body.nonce;
      if (!nonce) return sendJSON(res, 400, { error: '缺少 nonce' });
      login.cancelFlow(nonce);
      return sendJSON(res, 200, { ok: true });
    },
  },
  {
    // 回填手机号。加这个接口之前登录的账号没有 phone 字段，
    // 用这条补一次（对全部可用账号逐个问一次 identities）
    method: 'POST',
    path: '/accounts/refresh-phone',
    handler: async ({ res, body }) => {
      const id = body && body.id;
      const list = id ? [authStore.get(id)].filter(Boolean) : authStore.findUsable();
      if (!list.length) return sendJSON(res, 200, { ok: false, error: '没有可用账号' });
      const out = [];
      for (const a of list) {
        try {
          const p = await authStore.fetchPhone(a);
          if (p && p.phone) {
            authStore.patch(a.id, { phone: p.phone });
            out.push({ id: a.id, name: a.nickname || '', ok: true, phone: authStore.maskPhone(p.phone) });
          } else {
            out.push({ id: a.id, name: a.nickname || '', ok: false, error: '接口没返回手机号' });
          }
        } catch (e) {
          out.push({ id: a.id, name: a.nickname || '', ok: false, error: e.message });
        }
      }
      // 审计（Q4）：phone 字段落进凭据文件，改了什么留痕
      const filled = out.filter((r) => r.ok).length;
      try { require('../auth').audit('admin', 'qwenwork_phone_refresh', id || 'all', `${filled}/${out.length}`); } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, { ok: true, results: out });
    },
  },
  {
    method: 'DELETE',
    path: '/accounts/:id',
    handler: async ({ res, params }) => {
      const a = authStore.get(params[0]);
      const ok = authStore.remove(params[0]);
      if (!ok) return sendJSON(res, 404, { error: '账号不存在' });
      // 基准/队列/缓存都按账号存着，删号后清掉，否则 Map 会一直涨
      try { require('../../qwenwork/credits').forget(a); } catch (e) { /* 清理失败不影响 */ }
      cache.data.delete(String(params[0]));
      try { require('../auth').audit('admin', 'qwenwork_account_delete', params[0]); } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, { ok: true });    },
  },
  {
    // 停用/启用 + 指定主账号。preferred 是排他的（authStore.patch 内部会清掉其他）
    method: 'PATCH',
    path: '/accounts/:id',
    handler: async ({ res, params, body }) => {
      const fields = {};
      if (body && body.enabled !== undefined) fields.enabled = !!body.enabled;
      if (body && body.preferred !== undefined) fields.preferred = !!body.preferred;
      if (!Object.keys(fields).length) return sendJSON(res, 400, { error: '没有可更新的字段' });
      const a = authStore.patch(params[0], fields);
      if (!a) return sendJSON(res, 404, { error: '账号不存在' });
      try { require('../auth').audit('admin', 'qwenwork_account_patch', params[0], JSON.stringify(fields)); } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, { ok: true, account: authStore.list().find((x) => x.id === a.id) });
    },
  },
  {
    method: 'GET',
    path: '/status',
    handler: async ({ req, res }) => {
      let st = { ready: false, error: '未加载', accounts: 0 };
      let acct = {};
      try {
        const qw = require('../../qwenwork');
        st = qw.status();
        const a = authStore.preferred();
        acct = a ? {
          account: a.nickname || a.uid || '',
          tier: a.tier || '',
          planId: a.planId || '',
          tokenExpiresAt: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
          refreshExpiresAt: a.refreshExpiresAt ? new Date(a.refreshExpiresAt).toISOString() : null,
          refreshExpired: !!(a.refreshExpiresAt && Date.now() >= a.refreshExpiresAt),
          tokenExpired: !!(a.expiresAt && Date.now() >= a.expiresAt),
        } : {};
      } catch (e) {
        st = { ready: false, error: e.message, accounts: 0 };
      }
      // token 绝不外传：只给到期时间与账号名
      return sendJSON(res, 200, {
        ready: st.ready,
        wasm: st.wasm ? st.wasm.version : null,
        loggedIn: !!st.loggedIn,
        error: st.error || '',
        accounts: st.accounts || 0,
        ...acct,
      });
    },
  },
  {
    method: 'GET',
    path: '/credits',
    handler: async ({ req, res }) => {
      try {
        const agg = await aggregateWallets();
        if (!agg.ok) return sendJSON(res, 200, { ok: false, error: agg.error || NO_ACCOUNT });
        return sendJSON(res, 200, {
          ok: true,
          error: '',
          // 两个池子**平级**上报，不做「订阅 vs 充值」的合并——
          // 月度来自订阅套餐、长期来自充值赠送，性质不同，界面要能分开看。
          // **余额是全账号合计**——与 /accounts 的 summary.pointsTotal 同源，
          // 同页两个数字必须对得上。
          //
          // **daily 池已移除**（2026-11-02）：上游不再发放每日免费额度，
          // 两个账号实测都恒为 0。留一张永远显示 0 的卡只会被读成「今天用光了」。
          //
          // `balance` 为 null 表示「该池余额未知」（上游坏读），**不是 0**。
          // 界面对 null 显示「—」，显示 0 会被读成「用完了」。
          wallets: [
            { id: 'monthly', label: '月度额度', kind: 'paid', balance: agg.monthly, resetAt: agg.resetAt },
            { id: 'longterm', label: '长期积分', kind: 'paid', balance: agg.longterm, resetAt: null },
          ],
          // 汇总：paid = monthly + longterm
          paid: agg.paid,
          monthly: agg.monthly,
          longterm: agg.longterm,
          total: agg.total,
          accountCount: agg.accountCount,
          // 余额没查到的账号数。>0 时合计是**部分和**，界面要说明，
          // 否则会被读成「账号都算进去了」
          failedAccounts: agg.failedAccounts,
          // 上游重试后仍返回全 0 的账号数（可能是真耗尽，也可能上游持续异常）
          retriedAccounts: agg.retriedAccounts,
          // 其中已由 account-context 的权威总数校正过的账号数（池子分配未知）。
          // 这类账号的 0 已确认是 wallets 坏读——界面要说「已校正」，不是「已用光」。
          misreadAccounts: agg.misreadAccounts,
          // 合计里余额**已知**的账号数。小于 accountCount 时合计是部分和，
          // 界面的数字后面必须带上这个说明（partial=true 就是这个意思）
          totalKnown: agg.totalKnown,
          partial: agg.partial,
          // 每账号明细：池子卡显示合计，这里给「合计由谁构成」
          accounts: agg.accounts,
          // 额度刷新时刻（上游 active_wallet 的 valid_to，实测月初）。
          // **这不是「每日重置」**：Free 号的月度额度按这个时刻刷新。
          resetAt: agg.resetAt,
          // 今日经本网关的消耗（**唯一有实测依据的消耗口径**，见 todayUsage）。
          // 2026-11-02 起不再提供「今日全部消耗（含客户端内对话）」——
          // 那需要「每日上限 − 余额」，而上游已不再发放每日额度，推不出来。
          today: { ...todayUsage(), scope: 'gateway' },
          // 上游自己给的即将过期列表（真会作废的那部分）
          expiringSoon: agg.expiringSoon,
          fetchedAt: Date.now(),
          // 主账号名（保留字段）。合计口径下它不再代表全体，改用 accountCount
          account: agg.account,
        });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: e.message });
      }
    },
  },
  {
    method: 'GET',
    path: '/credits/daily',
    handler: async ({ req, res }) => {
      const days = Math.min(90, Math.max(1, parseInt((req.url.match(/[?&]days=(\d+)/) || [])[1] || '14', 10) || 14));
      return sendJSON(res, 200, { days, rows: dailyUsage(days) });
    },
  },
  {
    method: 'GET',
    path: '/models',
    handler: async ({ req, res }) => {
      let models = [];
      let error = '';
      try {
        const qw = require('../../qwenwork');
        const keys = await qw.listModels();
        // 中文名来自上游 display_name（pro→高级 / flash→标准）。
        // 硬编码一份必然过期——1.1.0 实测模型表已与旧版不同。
        const names = { pro: '高级', flash: '标准', 'qwen3.8-max-preview': 'Qwen3.8-Max' };
        models = keys.map((k) => ({ id: k, name: names[k] || k, prefixed: `qwen/${k}` }));
      } catch (e) {
        error = e.message;
      }
      return sendJSON(res, 200, { models, error });
    },
  },
];

/**
 * 清空余额缓存。生产路径由 DELETE /accounts/:id 调用（删号后不清会留脏数据）；
 * 也供离线验证脚本在每个场景之间重置——否则第二个场景读到的是第一个的缓存。
 */
function resetCache() {
  cache = { at: 0, data: new Map() };
}

module.exports = { routes, resetCache };
