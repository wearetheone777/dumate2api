// src/admin/routes/traework.js - TRAE Work 通道的管理接口
//
// 与千问路由（qwenwork.js）的关键差异：
//   千问是「单账号、只读客户端登录态」——账号不能增删，界面只能展示。
//   TRAE Work 的凭证是**我们自己持有的**，所以这里支持增删与手动登录。
//
// 三个接口组：账号管理、签到、登录。
const { sendJSON } = require('../router');
const authStore = require('../../traework/auth');
const checkin = require('../../traework/checkin');
const login = require('../../traework/login');
const models = require('../../traework/models');
const credits = require('../../traework/credits');
const tw = require('../../traework');

const routes = [
  {
    // 通道状态 + 账号列表（脱敏：refreshToken 只给尾部 6 位）
    method: 'GET',
    path: '/status',
    handler: async ({ res }) => {
      let st = { ready: false, error: '' };
      try { st = tw.status(); } catch (e) { st = { ready: false, error: e.message }; }
      return sendJSON(res, 200, {
        ready: st.ready,
        error: st.error || '',
        accounts: st.accounts || 0,
        // 明确告诉前端这条通道的结构：可增删，与千问的 single 模式不同
        mode: 'multi',
        modeNote: 'TRAE Work 的凭证由本项目自行 OAuth 换取并保存，可多账号并存、可增删。',
        rows: authStore.list(),
      });
    },
  },
  {
    // 模型表（只读，上游下发）。带消耗倍率、上下文窗口、会员折扣。
    // ?visible=1 只看客户端可见的模型（默认全部返回，隐藏的多是内部模型，
    // 排查「为什么某个名字调不通」时需要看到它们）。
    method: 'GET',
    path: '/models',
    handler: async ({ res, req }) => {
      const onlyVisible = /[?&]visible=1/.test(req.url || '');
      const force = /[?&]refresh=1/.test(req.url || '');
      let out = { ok: false, error: '', models: [], fetchedAt: 0 };
      try {
        out = await models.fetchModels({ force });
      } catch (e) {
        out = { ok: false, error: e.message, models: [], fetchedAt: 0 };
      }
      let list = out.models || [];
      if (onlyVisible) list = list.filter((m) => m.visible);
      return sendJSON(res, 200, {
        models: list,
        total: (out.models || []).length,
        // 取不到时如实报错，前端显示错误而不是一张空表
        error: out.error || '',
        fetchedAt: out.fetchedAt || 0,
        // 倍率的单位与来源写清楚：接口给的是相对倍率，不是积分绝对值
        rateNote: '倍率是相对值（接口字段 consumption_rate.rate），实际扣费 = 倍率 × 用量；折扣未命中时按原价扣。',
      });
    },
  },
  {
    // 全部账号的签到状态与额度。不落盘——只读快照，避免刷新动作本身触发签到
    method: 'GET',
    path: '/credits',
    handler: async ({ res }) => {
      const rows = [];
      for (const raw of authStore.findUsable()) {
        // 额度/签到状态接口直接用账号里存的 accessToken——先续期一次，
        // 否则 token 过期后本页恒报 "not able to authenticate"（与 /checkin 同根因）
        const a = await checkin.withFreshToken(raw);
        const st = await checkin.status(a);
        const u = await checkin.usage(a);
        rows.push({
          id: a.id,
          nickname: a.nickname || '',
          uid: a.uid || '',
          credits: a.credits == null ? null : a.credits,
          checkedIn: st.ok ? st.checkedIn : null,
          // 额度接口的实时值。remain/limit 取不到时给 null——
          // 补 0 会被读成「额度用完了」，而真相是没解析到
          remain: u.ok ? u.remain : null,
          limit: u.ok ? u.limit : null,
          consumed: u.ok ? u.consumed : null,
          // 签到可得的额度（不是余额），来自 status 接口
          checkinCredits: st.ok ? st.credits : null,
          checkinExtra: st.ok ? st.extraCredits : null,
          lastCheckin: a.lastCheckin || null,
          // 额度包明细（含各自到期时间）。仪表盘据此回答「哪些积分快过期了」
          // ——签到奖励是一批批到期的，只给总额答不出这个问题。
          packs: u.ok ? (u.packs || []) : [],
          // error 只表示「这次状态查询失败」——别把上次签到尝试的失败消息
          // 塞进来。两者是不同的东西：前者是「查不到」，后者是「查到了，
          // 但上一次签到被上游拒了」。混在一起时前端只能显示「查询失败」，
          // 把「今天还没签」这个已经查到的事实盖掉了（真踩过）。
          // 上次签到的结果由 /status 的 lastError 单独报，账号卡上已有告警位。
          error: st.ok ? '' : st.error,
        });
      }
      // 顶部指标卡用。**在这里算而不是 /dashboard**：到期数据要打上游才有，
      // 而 /dashboard 刻意不打（见它的注释），所以汇总跟着 /credits 走。
      const nowMs = Date.now();
      const SOON_MS = 7 * 86400000;
      const expiring = [];
      for (const r of rows) {
        for (const p of (r.packs || [])) {
          // 只算「还有剩余」且「7 天内到期」的包——已用完的包到期不构成损失，
          // 报出来只会制造噪音
          if (!p.expireAt || !(p.remain > 0)) continue;
          if (p.expireAt - nowMs > SOON_MS) continue;
          expiring.push({
            account: r.nickname || r.uid || `账号 ${r.id}`,
            accountId: r.id,
            name: p.name,
            remain: p.remain,
            limit: p.limit,
            expireAt: p.expireAt,
            daysLeft: Math.max(0, Math.ceil((p.expireAt - nowMs) / 86400000)),
          });
        }
      }
      expiring.sort((a, b) => a.expireAt - b.expireAt);
      // 额度取不到的账号单独计数：它既不算「有效」也不该被当成 0 额度
      const known = rows.filter((r) => r.remain !== null || r.limit !== null);
      return sendJSON(res, 200, {
        count: rows.length,
        rows,
        summary: {
          total: rows.length,
          // 凭证可用性口径与千问一致（rows 都来自 findUsable，所以这里
          // 等价于「查询没报错」）。留字段是为了两边形状一致。
          valid: rows.filter((r) => !r.error).length,
          checkedIn: rows.filter((r) => r.checkedIn).length,
          unknown: rows.length - known.length,
          remainTotal: Number(known.reduce((s, r) => s + (r.remain || 0), 0).toFixed(2)),
          limitTotal: Number(known.reduce((s, r) => s + (r.limit || 0), 0).toFixed(2)),
        },
        // 7 天内到期且还有剩余的额度包。空数组 = 无风险，界面据此显示「暂无」
        expiring,
        expiringPoints: Number(expiring.reduce((s, x) => s + x.remain, 0).toFixed(4)),
      });
    },
  },
  {
    /**
     * 账号健康快照 + 今日用量（仪表盘用）。
     *
     * 与 /credits 的分工：/credits 打上游取实时额度（慢，每账号两次请求），
     * 这里是**本地数据**——账号文件 + 归因历史，不打上游。仪表盘每进一次
     * 都要拉，若每次都去上游问一遍，既慢又平白增加被风控的概率。
     * 所以这里给的是「上次落盘的状态 + 本地归因」，界面标清数据来源。
     */
    method: 'GET',
    path: '/dashboard',
    handler: async ({ res }) => {
      const all = authStore.list();
      const now = Date.now();
      const accounts = all.map((a) => {
        // 存活天数：从 createdAt 算到今天。与搭子的「会员剩余天数」语义
        // 不同——这里衡量的是「这个号用了多久」，不是「还能用多久」。
        const daysAlive = a.createdAt
          ? Math.floor((now - a.createdAt) / 86400000) : null;
        return {
          id: a.id,
          name: a.nickname || a.uid || `账号 ${a.id}`,
          uid: a.uid || '',
          phone: a.phone || '',
          phoneSource: a.phoneSource || '',
          enabled: a.enabled !== false,
          credits: a.credits == null ? null : a.credits,
          daysAlive,
          // 凭证到期（access token 到期能自动续，所以这不是故障信号）
          expiresAt: a.expiresAt || null,
          refreshExpiresAt: a.refreshExpiresAt || null,
          refreshExpired: !!(a.refreshExpiresAt && now >= a.refreshExpiresAt),
          lastCheckin: a.lastCheckin || null,
          checkedInToday: a.lastCheckin
            ? credits.dayKey(a.lastCheckin) === credits.dayKey(now) : false,
          lastError: a.lastError || '',
          refreshTail: a.refreshTail || '',
        };
      });
      const today = credits.todayUsage();
      return sendJSON(res, 200, {
        accounts,
        summary: {
          total: accounts.length,
          enabled: accounts.filter((a) => a.enabled).length,
          checkedInToday: accounts.filter((a) => a.checkedInToday).length,
          refreshExpired: accounts.filter((a) => a.refreshExpired).length,
          errored: accounts.filter((a) => a.lastError).length,
          creditsTotal: accounts.reduce((s, a) => (a.credits == null ? s : s + a.credits), 0),
        },
        today,
        // 额度上限要打上游才知道，仪表盘不打。这里只报本地能算的消耗，
        // 剩余额度由 /credits 那侧给——两个来源不要混在一张卡里。
        note: '账号状态为本地落盘快照；剩余额度需查「额度」页（会打上游接口）。',
      });
    },
  },
  {
    /**
     * 按天聚合的消耗（仪表盘趋势图）。
     *
     * **成本取相邻 consumed 的差值**，不是 consumed 本身——后者是累计值，
     * 直接按天求和等于把历史总量重复计入每一天。
     */
    method: 'GET',
    path: '/credits/daily',
    handler: async ({ req, res }) => {
      const days = Math.min(90, Math.max(1,
        parseInt((req.url.match(/[?&]days=(\d+)/) || [])[1] || '14', 10) || 14));
      return sendJSON(res, 200, { days, rows: credits.dailyUsage(days) });
    },
  },
  {
    /** 逐笔消耗明细（按时间倒序），供仪表盘表格 */
    method: 'GET',
    path: '/credits/records',
    handler: async ({ req, res }) => {
      const limit = Math.min(1000, Math.max(1,
        parseInt((req.url.match(/[?&]limit=(\d+)/) || [])[1] || '100', 10) || 100));
      const rows = credits.creditRecords(limit);
      // 汇总只统计本次返回的窗口，且只累加算得出的成本——首条无参照点
      // （cost=null）不计入，界面要写清范围
      const sum = rows.reduce((s, r) => s + (r.cost || 0), 0);
      return sendJSON(res, 200, {
        limit,
        rows,
        window: {
          cost: Number(sum.toFixed(4)),
          requests: rows.length,
          exact: rows.filter((r) => r.exact).length,
        },
      });
    },
  },
  {
    // 手动签到：幂等，已签的自动跳过
    method: 'POST',
    path: '/checkin',
    handler: async ({ res, body }) => {
      const id = body && body.id;
      const list = id ? [authStore.get(id)].filter(Boolean) : authStore.findUsable();
      if (!list.length) return sendJSON(res, 200, { ok: false, error: '没有可用账号' });
      const out = [];
      for (const a of list) {
        const r = await checkin.checkinAndSave(a, authStore);
        out.push({ id: a.id, nickname: a.nickname || a.uid || '', ...r });
      }
      return sendJSON(res, 200, { ok: true, results: out });
    },
  },
  {
    // 生成一次登录所需的设备标识 + 授权链接。
    // 前端拿到后开浏览器；用户把回调地址粘回来，再调 /login/callback。
    method: 'POST',
    path: '/login/url',
    handler: async ({ res }) => {
      const ids = login.newDeviceIds();
      return sendJSON(res, 200, {
        ok: true,
        url: login.buildAuthUrl(ids),
        deviceId: ids.deviceId,
        machineId: ids.machineId,
        // 提示：回调地址要原样粘回来
        hint: '浏览器登录后跳到 127.0.0.1:18080（打不开是正常的），复制地址栏完整 URL。',
      });
    },
  },
  {
    method: 'POST',
    path: '/login/callback',
    handler: async ({ res, body }) => {
      const cb = body && body.callback;
      const deviceId = body && body.deviceId;
      const machineId = body && body.machineId;
      if (!cb) return sendJSON(res, 400, { error: '缺少 callback' });
      if (!deviceId || !machineId) {
        return sendJSON(res, 400, { error: '缺少 deviceId / machineId（需先调 /login/url 拿到）' });
      }
      const parsed = login.parseCallback(cb);
      if (!parsed.refreshToken) {
        return sendJSON(res, 400, { error: '回调里没有 refreshToken，检查是否粘了完整地址' });
      }
      const r = await login.exchangeAndSave({
        refreshToken: parsed.refreshToken,
        deviceId, machineId,
        uid: parsed.uid, nickname: parsed.nickname,
      });
      if (!r.ok) return sendJSON(res, 200, { ok: false, error: r.error });
      return sendJSON(res, 200, { ok: true, account: r.account });
    },
  },
  {
    // 回填手机号。
    //
    // TRAE 的 GetUserInfo 已 401，拿不到官方身份字段，昵称是唯一线索。
    // 但「昵称 = 用户 + 手机号」这个假设**实测不成立**（本机这个号是
    // 「用户23062830688」，以 2 开头，不是手机号），所以这里只在昵称
    // 严格匹配标准手机号时才填，抽不到就不给——不猜、不凑。
    //
    // 这条**不发任何网络请求**，只重扫一遍已有的 nickname。
    method: 'POST',
    path: '/accounts/refresh-phone',
    handler: async ({ res, body }) => {
      const id = body && body.id;
      const list = id ? [authStore.get(id)].filter(Boolean) : authStore.findUsable();
      if (!list.length) return sendJSON(res, 200, { ok: false, error: '没有可用账号' });
      const out = [];
      for (const a of list) {
        const p = authStore.phoneFromNickname(a.nickname);
        if (p) {
          authStore.patch(a.id, { phone: p, phoneSource: 'inferred-nickname' });
          out.push({ id: a.id, name: a.nickname || '', ok: true, phone: authStore.maskPhone(p) });
        } else {
          out.push({
            id: a.id, name: a.nickname || '', ok: false,
            error: '昵称不是「用户+手机号」格式，无法推断',
          });
        }
      }
      return sendJSON(res, 200, {
        ok: true, results: out,
        // 如实说明：TRAE 侧拿不到官方手机号，能填上纯属昵称恰好合格式
        note: 'TRAE Work 无官方手机号接口（GetUserInfo 已 401）。仅当昵称形如「用户13800138000」时才能取到，否则显示「手机号未知」。',
      });
    },
  },
  {
    method: 'DELETE',
    path: '/accounts/:id',
    handler: async ({ res, params }) => {
      const ok = authStore.remove(params[0]);
      if (!ok) return sendJSON(res, 404, { error: '账号不存在' });
      return sendJSON(res, 200, { ok: true });
    },
  },
  {
    method: 'PATCH',
    path: '/accounts/:id',
    handler: async ({ res, params, body }) => {
      const fields = {};
      if (body && body.enabled !== undefined) fields.enabled = !!body.enabled;
      const a = authStore.patch(params[0], fields);
      if (!a) return sendJSON(res, 404, { error: '账号不存在' });
      return sendJSON(res, 200, { ok: true, account: authStore.list().find((x) => x.id === a.id) });
    },
  },
];

module.exports = { routes };
