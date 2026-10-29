// src/admin/routes/qoder.js - Qoder 通道的管理接口
//
// 与 traework.js 最像（都是自持凭证、可增删账号、有签到），差异：
//   - 登录用 device flow 轮询（同 qwenwork），不是粘回调（traework）
//   - 有**区域**概念（cn / global），登录时要选
//   - 额度分 userQuota（订阅内）与 addOnQuota（签到/赠送）——**两者不能相加**
//
// 端点组：状态、账号（增删改）、签到、额度、模型、登录。
const { sendJSON } = require('../router');
const authStore = require('../../qoder/auth');
const session = require('../../qoder/session');
const login = require('../../qoder/login');
const constants = require('../../qoder/constants');
const qoder = require('../../qoder');

const routes = [
  {
    // 通道状态 + 账号列表（脱敏：token 只给尾部 6 位）
    method: 'GET',
    path: '/status',
    handler: async ({ res }) => {
      // 存量账号补一次脱敏手机号（本功能上线前登录的没有这一项）。
      // 不 await：读路径不该被上游请求拖住，第一次没补上，下次进来自然就有。
      // 幂等 + 每账号只试一次，所以重复调用没有代价。
      authStore.backfillPhone(session).catch(() => {});

      let st = { ready: false, error: '' };
      try { st = qoder.status(); } catch (e) { st = { ready: false, error: e.message }; }
      return sendJSON(res, 200, {
        ready: st.ready,
        error: st.error || '',
        accounts: st.accounts || 0,
        // 明确告诉前端：这条通道**不需要任何客户端**（签名纯本地）
        needsClient: false,
        mode: 'multi',
        modeNote: 'Qoder 的凭证由本项目走 device flow 自取并保存（data/qoder-accounts.json），可多账号并存、可增删。签名是纯本地算法，不需要安装 Qoder 客户端。',
        rows: authStore.list(),
      });
    },
  },
  {
    // 模型表（只读，上游下发）。带**倍率**（price_factor）与上下文窗口。
    // 倍率从上游真值来，不估算——界面据此标「上游下发」。
    method: 'GET',
    path: '/models',
    handler: async ({ res, req }) => {
      const force = /[?&]refresh=1/.test(req.url || '');
      const account = authStore.preferred();
      if (!account) return sendJSON(res, 200, { models: [], total: 0, error: '没有可用账号', fetchedAt: 0 });
      try {
        const raw = await session.fetchModels(account, { force });
        if (!raw.ok) return sendJSON(res, 200, { models: [], total: 0, error: raw.error || '', fetchedAt: 0 });
        return sendJSON(res, 200, {
          models: raw.models,
          total: raw.models.length,
          error: '',
          fetchedAt: Date.now(),
          // 倍率语义写清楚：相对值，不是积分绝对值
          rateNote: '倍率是相对值（上游字段 price_factor），实际扣费 = 倍率 × 用量。0.1 档最省，适合调试。',
        });
      } catch (e) {
        return sendJSON(res, 200, { models: [], total: 0, error: e.message, fetchedAt: 0 });
      }
    },
  },
  {
    // 全部账号的额度（打上游，慢）。**userQuota 与 addOnQuota 分开报**，
    // 界面不能相加——前者是订阅套餐内，后者是签到/赠送。
    method: 'GET',
    path: '/credits',
    handler: async ({ res }) => {
      const list = authStore.list();
      const proxyAgent = require('../../proxy-agent');
      const rows = [];
      for (const a of list) {
        const raw = authStore.get(a.id);
        // 出站代理（E 包收口补点）：额度/签到状态与对话同出口。配置非法
        // 出错误行，不回退直连。
        let agent = null;
        try { agent = proxyAgent.getAgentFor(raw); } catch (e) {
          rows.push({
            id: a.id,
            nickname: a.nickname || a.uid || `账号 ${a.id}`,
            region: a.region,
            planName: a.planName || '',
            userQuota: null, addOnQuota: null, isQuotaExceeded: null,
            checkedIn: null, checkinPending: null, checkinNextAt: null,
            lastCheckin: a.lastCheckin || null,
            error: `出站代理配置错误: ${e.message}`,
          });
          continue;
        }
        const q = await session.fetchQuota(raw.accessToken, a.region, { agent });
        // 签到状态走**只读**的 /campaigns（不领取任何东西），与 TRAE 的
        // checkedIn 同一口径。查失败给 null，不猜成「已签」或「未签」。
        const ck = await session.checkinStatus(raw.accessToken, a.region, { agent });
        rows.push({
          id: a.id,
          nickname: a.nickname || a.uid || `账号 ${a.id}`,
          region: a.region,
          planName: a.planName || '',
          // 取不到时给 null，不补 0——0 会被读成「用完了」
          userQuota: q.ok ? q.userQuota : null,
          addOnQuota: q.ok ? q.addOnQuota : null,
          isQuotaExceeded: q.ok ? q.isQuotaExceeded : null,
          // null = 查不出来；true/false = 今日已签 / 未签
          checkedIn: ck.ok ? ck.checkedIn : null,
          /** 待领额度（还有 CLAIMABLE 的活动时） */
          checkinPending: ck.ok ? ck.pending : null,
          /** 下次可签时刻（活动 endAt，10:00 UTC+8 刷新） */
          checkinNextAt: ck.ok ? ck.nextAt : null,
          /** 上次签到时刻（本地记录；上游不提供） */
          lastCheckin: a.lastCheckin || null,
          error: q.ok ? '' : (q.error || '查询失败'),
        });
      }
      const known = rows.filter((r) => r.addOnQuota || r.userQuota);
      const sumAddOn = known.reduce((s, r) => s + ((r.addOnQuota && r.addOnQuota.remaining) || 0), 0);
      const sumUser = known.reduce((s, r) => s + ((r.userQuota && r.userQuota.remaining) || 0), 0);
      // 即将过期的批次：本地账本，不打上游（数据源见 /grants 的注释）
      const grants = require('../../qoder/grants');
      const now = Date.now();
      const SOON_MS = 7 * 86400000;
      const expiring = grants.expiring({ withinMs: SOON_MS, now });
      return sendJSON(res, 200, {
        count: rows.length,
        rows,
        summary: {
          total: rows.length,
          valid: rows.filter((r) => !r.error).length,
          // 今日已签账号数。只数明确 true 的——查不出的（null）不计入，
          // 否则「已签 2/2」会把查不出的也当成已签，比不显示更糟。
          checkedIn: rows.filter((r) => r.checkedIn === true).length,
          unknown: rows.length - known.length,
          // 两份额度**分开合计**，不合并
          addOnTotal: Number(sumAddOn.toFixed(4)),
          userTotal: Number(sumUser.toFixed(4)),
          exceeded: rows.filter((r) => r.isQuotaExceeded).length,
          // 7 天内到期且有记录的批次数与**领取额合计**（不是剩余额，见 note）
          expiringCount: expiring.length,
          expiringAmount: Number(expiring.reduce((s, r) => s + (r.amount || 0), 0).toFixed(4)),
        },
        // 免费用户实际能用的就是 addOnQuota（签到/赠送）。写清楚避免误读。
        note: 'addOnQuota 是签到/赠送得到的积分（免费用户实际可用）；userQuota 是订阅套餐内的额度（Free 套餐恒为 0）。两者不可相加。',
      });
    },
  },
  {
    // 逐笔消耗明细（按时间倒序），供积分明细页表格。
    //
    // 与 TRAE 的同名端点同形，但**成本来源不同**：TRAE 是 consumed 游标做差
    // （并发时会不精确），Qoder 的 usage.credits 是上游直给的单请求扣费
    // （price_factor × tokens/1000），所以 exact 恒为 true。
    method: 'GET',
    path: '/credits/records',
    handler: async ({ req, res }) => {
      const limit = Math.min(1000, Math.max(1,
        parseInt((req.url.match(/[?&]limit=(\d+)/) || [])[1] || '100', 10) || 100));
      const credits = require('../../qoder/credits');
      const rows = credits.creditRecords(limit);
      // 汇总只统计本次返回的窗口，且不补 0——cost 为 null（上游没给 credits）
      // 的行不计入，界面要写清范围，否则「合计」会被读成全部请求的总和
      const sum = rows.reduce((s, r) => s + (r.cost || 0), 0);
      return sendJSON(res, 200, {
        limit,
        rows,
        window: {
          cost: Number(sum.toFixed(4)),
          requests: rows.length,
          exact: rows.filter((r) => r.exact).length,
        },
        // **账本起点**：本功能上线前经网关的请求没有逐笔记录，无法追溯。
        // 界面必须标出这个起点——否则「合计 0.0259」会被读成「总共只花了这么点」，
        // 而真相是大部分消耗发生在这个时刻之前。
        since: credits.since(),
        // 账本涵盖的请求数（不是全部请求数，只是有记录的那部分）
        recorded: rows.length,
      });
    },
  },
  {
    // 官方积分消耗（credits-summary + credits-heatmap，2026-10-30）。
    // **真实消耗口径**：累计消耗 / 单日峰值 / 近 365 天逐日——上游唯一给出
    // 「花了多少」的地方（逐笔 credits 只覆盖经网关的请求，官方口径含全部）。
    // 按 token 缓存 5 分钟（session 层），?force=1 可强刷。
    method: 'GET',
    path: '/credits/usage',
    handler: async ({ req, res }) => {
      const force = /[?&]force=1/.test(req.url);
      const list = authStore.list();
      const proxyAgent = require('../../proxy-agent');
      const rows = [];
      const dailySum = new Map(); // date → 合计（多账号同日相加）
      for (const a of list) {
        const raw = authStore.get(a.id);
        let agent = null;
        try { agent = proxyAgent.getAgentFor(raw); } catch (e) {
          rows.push({ id: a.id, nickname: a.nickname || a.uid || `账号 ${a.id}`, region: a.region, usage: null, error: `出站代理配置错误: ${e.message}` });
          continue;
        }
        const u = await session.fetchCreditUsage(raw.accessToken, a.region, { agent, force });
        rows.push({
          id: a.id,
          nickname: a.nickname || a.uid || `账号 ${a.id}`,
          region: a.region,
          usage: u.ok ? u : null,
          error: u.ok ? '' : (u.error || '查询失败'),
        });
        // 逐日合计：只累计取到数的日子；取不到的账号不拖垮其余账号的合并
        if (u.ok) {
          for (const d of u.daily) {
            if (!d.date || typeof d.value !== 'number') continue;
            dailySum.set(d.date, Number((((dailySum.get(d.date) || 0) + d.value)).toFixed(4)));
          }
        }
      }
      const daily = [...dailySum.entries()]
        .map(([date, value]) => ({ date, value }))
        .sort((x, y) => (x.date < y.date ? -1 : 1));
      const known = rows.filter((r) => r.usage);
      return sendJSON(res, 200, {
        count: rows.length,
        rows,
        daily,
        summary: {
          valid: known.length,
          // 累计合计：只加取到的（null 不计）；全部取不到就是 null，不补 0
          total: known.length
            ? Number(known.reduce((s, r) => s + (r.usage.total || 0), 0).toFixed(4))
            : null,
          peak: known.length
            ? Number(Math.max(...known.map((r) => r.usage.peak || 0)).toFixed(4))
            : null,
          windowDays: known.length ? Math.max(...known.map((r) => r.usage.daily.length)) : 0,
        },
        note: '官方口径的累计消耗（含不经网关的客户端用量）。逐笔 credits（/credits/records）只覆盖经网关的请求，两者不可相加。',
      });
    },
  },
  {
    // 手动签到：幂等，已领的自动跳过。返回**实际到账差值**（不是总额）。
    method: 'POST',
    path: '/checkin',
    handler: async ({ res, body }) => {
      const id = body && body.id;
      const list = id ? [authStore.get(id)].filter(Boolean) : authStore.findUsable();
      if (!list.length) return sendJSON(res, 200, { ok: false, error: '没有可用账号' });
      const results = [];
      for (const a of list) {
        try {
          const r = await qoder.checkin(a);
          results.push({ id: a.id, nickname: a.nickname || a.uid || '', ...r });
        } catch (e) {
          results.push({ id: a.id, nickname: a.nickname || '', ok: false, error: e.message });
        }
      }
      // 审计（Q4）：签到是真实消耗/获取积分的动作，成败都留痕
      const okCount = results.filter((r) => r.ok).length;
      try { require('../auth').audit('admin', 'qoder_checkin', id || 'all', `${okCount}/${results.length}`); } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, { ok: true, results });
    },
  },
  {
    // 积分过期明细。
    //
    // **为什么需要本地账本**：Qoder 没有「逐批积分余额」接口（实测
    // /api/v2/quota/detail 等一律 503，/sash/.../grants 一律 404）。
    // 唯一带到期信息的是**领取响应本身**（benefit.validity = 30 天 + grantedAt），
    // 所以每次签到落一条本地记录（src/qoder/grants.js），过期信息才不会丢。
    //
    // **诚实边界**：上游只告诉我们「领了多少」，不告诉我们「这批还剩多少」。
    // 所以 amount 是**领取额**不是剩余额——界面上必须说清，当成剩余额会高估。
    method: 'GET',
    path: '/grants',
    handler: async ({ req, res }) => {
      const grants = require('../../qoder/grants');
      const days = Math.min(365, Math.max(1,
        parseInt((req.url.match(/[?&]days=(\d+)/) || [])[1] || '30', 10) || 30));
      const now = Date.now();
      const withinMs = days * 86400000;
      const rows = grants.expiring({ withinMs, now });
      const all = grants.readAll();
      // 每批补上派生字段（剩余天数 / 是否已过期），前端直接渲染
      const decorate = (g) => ({
        grantId: g.grantId,
        accountId: g.accountId,
        accountName: g.accountName,
        campaignKey: g.campaignKey,
        // **领取额**，不是剩余额（上游不给逐批余额）
        amount: g.amount,
        grantedAt: g.grantedAt,
        expiresAt: g.expiresAt,
        validityDays: g.validityDays,
        modelScope: g.modelScope,
        daysLeft: g.expiresAt ? Math.max(0, Math.ceil((g.expiresAt - now) / 86400000)) : null,
        expired: !!(g.expiresAt && g.expiresAt <= now),
      });
      const totalAmount = rows.reduce((s, r) => s + (r.amount || 0), 0);
      // 覆盖范围：账本从功能启用时开始记，**之前领的批次查不到**（上游无回填接口）。
      // 如实报出起点，否则「账本里没有」会被读成「没有积分」。
      const since = all.length ? Math.min(...all.map((r) => r.ts || r.grantedAt || 0)) : null;
      return sendJSON(res, 200, {
        windowDays: days,
        rows: rows.map(decorate),
        // 已过期的批次单列——排查「为什么积分少了」时用得上
        expired: grants.expired({ now }).slice(0, 50).map(decorate),
        total: all.length,
        // 账本最早一条的时刻（null = 账本为空）。界面据此说明覆盖范围。
        since,
        // 合计是**领取额之和**，不是剩余额。界面必须标注这点。
        expiringAmount: Number(totalAmount.toFixed(4)),
        note: 'Qoder 不提供逐批积分余额，这里的「领取额」是该批次**领到的数量**，不是剩余量。'
          + '实际剩余以额度卡的总余额为准。到期时间来自领取响应（签到后 30 天）。'
          + (since ? '' : '账本为空——本功能上线前领的批次无法追溯（上游没有回填接口）。'),
      });
    },
  },
  {
    // 仪表盘用：本地快照，不打上游
    method: 'GET',
    path: '/dashboard',
    handler: async ({ res }) => {
      const all = authStore.list();
      const now = Date.now();
      const accounts = all.map((a) => ({
        id: a.id,
        name: a.nickname || a.uid || `账号 ${a.id}`,
        uid: a.uid || '',
        region: a.region,
        planName: a.planName || '',
        enabled: a.enabled !== false,
        daysAlive: a.createdAt ? Math.floor((now - a.createdAt) / 86400000) : null,
        expiresAt: a.expiresAt || null,
        refreshExpiresAt: a.refreshExpiresAt || null,
        refreshExpired: !!(a.refreshExpiresAt && now >= a.refreshExpiresAt),
        lastError: a.lastError || '',
        lastErrorAt: a.lastErrorAt || null,
        refreshTail: a.refreshTail || '',
      }));
      return sendJSON(res, 200, {
        accounts,
        summary: {
          total: accounts.length,
          enabled: accounts.filter((a) => a.enabled).length,
          refreshExpired: accounts.filter((a) => a.refreshExpired).length,
          errored: accounts.filter((a) => a.lastError).length,
        },
        note: '账号状态为本地落盘快照；额度需查「额度」页（会打上游接口）。',
      });
    },
  },
  {
    // 开一次登录：返回授权链接。用户浏览器登录后前端轮询 /login/poll
    method: 'POST',
    path: '/login/start',
    handler: async ({ res, body }) => {
      try {
        return sendJSON(res, 200, login.startFlow(body && body.region));
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: e.message });
      }
    },
  },
  {
    // 轮询取票。只查一次就返回——等待由前端定时调
    method: 'POST',
    path: '/login/poll',
    handler: async ({ res, body }) => {
      const nonce = body && body.nonce;
      if (!nonce) return sendJSON(res, 400, { error: '缺少 nonce（需先调 /login/start）' });
      const r = await login.pollFlow(nonce);
      // 审计（Q4）：poll 成功即凭据（refresh token）落盘的时刻；pending/error
      // 每秒轮询会来，只审成功避免刷屏
      if (r && r.status === 'ok') {
        try { require('../auth').audit('admin', 'qoder_login', (r.account && r.account.id) || '', '凭据落盘'); } catch (e) { /* 审计失败不影响结果 */ }
      }
      return sendJSON(res, 200, r);
    },
  },
  {
    method: 'POST',
    path: '/login/cancel',
    handler: async ({ res, body }) => {
      login.cancelFlow(body && body.nonce);
      return sendJSON(res, 200, { ok: true });
    },
  },
  {
    method: 'DELETE',
    path: '/accounts/:id',
    handler: async ({ res, params }) => {
      const ok = authStore.remove(params[0]);
      if (!ok) return sendJSON(res, 404, { error: '账号不存在' });
      try { require('../auth').audit('admin', 'qoder_account_delete', params[0]); } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, { ok: true });
    },
  },
  {
    method: 'PATCH',
    path: '/accounts/:id',
    handler: async ({ res, params, body }) => {
      const fields = {};
      if (body && body.enabled !== undefined) fields.enabled = !!body.enabled;
      if (body && body.preferred !== undefined) fields.preferred = !!body.preferred;
      const a = authStore.patch(params[0], fields);
      if (!a) return sendJSON(res, 404, { error: '账号不存在' });
      try { require('../auth').audit('admin', 'qoder_account_patch', params[0], JSON.stringify(fields)); } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, { ok: true, account: authStore.list().find((x) => x.id === a.id) });
    },
  },
];

module.exports = { routes };
