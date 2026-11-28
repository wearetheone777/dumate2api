// src/admin/routes/workbuddy.js - WorkBuddy 通道的管理接口
//
// 与 traework.js / qoder.js 同构（自持凭证、可增删、有签到），差异：
//   - 登录流程后置（用户要求）：账号来源是「导入官方客户端认证文件」或
//     「手动粘贴 token」——不做浏览器 OAuth
//   - 双区域（cn / global），各接口都认 ?region=（国内/国际独立视图）
//   - 签到仅国内版（国际版明确报「不支持」，不白打）
//   - 额度是 billing 域的套餐包列表（get-user-resource）
const { sendJSON } = require('../router');
const authStore = require('../../workbuddy/auth');
const models = require('../../workbuddy/models');
const billing = require('../../workbuddy/billing');
const wb = require('../../workbuddy');
const constants = require('../../workbuddy/constants');

/** 解析 ?region= 查询参数（intl 也认，归一成 global 术语） */
function regionOf(url) {
  const raw = decodeURIComponent(((url.match(/[?&]region=([^&]*)/) || [])[1] || '')).toLowerCase();
  if (raw === 'intl') return 'global';
  if (raw === 'cn' || raw === 'global') return raw;
  return '';
}

/**
 * 解析 ?uids=1,2,3（P0-3「只点名缺积分的号」，hub Unreleased）。
 *
 * 返回 null = 没点名（全量刷新，旧行为逐字节不变）；Set = 只刷这些账号。
 * **空串/全是垃圾值也返回 null**——`?uids=` 传空应当被当成「没点名」而不是
 * 「点名了一个都不刷」，否则前端拼错参数会让页面安然显示空表。
 */
function uidsOf(url) {
  const m = url.match(/[?&]uids=([^&]*)/);
  if (!m) return null;
  const raw = decodeURIComponent(m[1] || '');
  const ids = new Set();
  for (const part of raw.split(',')) {
    const n = Number(String(part).trim());
    if (Number.isInteger(n) && n > 0) ids.add(n);
  }
  return ids.size ? ids : null;
}

/** 成长任务写路径（/tasks/* 三个端点共用）的账号选择：body.id 单号、body.group
 *  分组、缺省全量可用；企业号在这里统一闸掉（判据单一出处 tasks.enterpriseBlocked）。 */
function taskAccountsOf(body) {
  const tasks = require('../../workbuddy/tasks');
  const id = body && body.id;
  const group = body && body.group ? String(body.group).trim() : '';
  let list;
  if (id) {
    list = [authStore.get(id)].filter(Boolean);
    if (!list.length) return { err: `账号 ${id} 不存在` };
  } else if (group) {
    list = authStore.findUsable().filter((a) => (a.group || '') === group);
    if (!list.length) return { err: `分组「${group}」下没有可用账号` };
  } else {
    list = authStore.findUsable();
  }
  if (!list.length) return { err: '没有可用账号' };
  const blocked = list.filter((a) => tasks.enterpriseBlocked(a));
  if (blocked.length === list.length) return { err: '选中的全是企业号——组织账号不做成长写腿' };
  return { list: list.filter((a) => !tasks.enterpriseBlocked(a)), skippedEnterprise: blocked.length };
}

const routes = [
  {
    // 通道状态 + 账号列表（脱敏）。?region= 区域视图
    method: 'GET',
    path: '/status',
    handler: async ({ res, req }) => {
      const region = regionOf(req.url || '');
      let st = { ready: false, error: '' };
      try { st = wb.status(); } catch (e) { st = { ready: false, error: e.message }; }
      const all = authStore.list();
      const rows = region ? all.filter((a) => a.region === region) : all;
      let ready = st.ready;
      let error = st.error || '';
      if (region) {
        ready = rows.some((r) => r.enabled && r.hasAccess && r.hasRefresh);
        if (!rows.length) error = region === 'global' ? '没有国际版账号（先导入客户端登录态或粘贴 token）' : '没有国内账号';
      }
      return sendJSON(res, 200, {
        ready,
        error,
        accounts: rows.length,
        needsClient: false,
        region: region || undefined,
        mode: 'multi',
        modeNote: 'WorkBuddy 的凭证由本项目自持（登录流程后置期：从官方客户端认证文件导入或手动粘贴 token），可多账号并存。国内（copilot.tencent.com）与国际（workbuddy.ai）账号不通用。',
        rows,
        // 风控连坐状态（跨进程：网关写快照、这里读快照）。
        // regions 只含**仍有效**的暂停；events 是窗口内被限制过的账号——两者
        // 一起才说清「为什么暂停」，只给倒计时会让运维不知道触发源。
        restriction: wb.restrictionState(),
      });
    },
  },
  {
    // 风控连坐暂停状态（仪表盘横幅轮询用，比 /status 轻——不查账号文件）
    method: 'GET',
    path: '/restriction',
    handler: async ({ res }) => {
      return sendJSON(res, 200, wb.restrictionState());
    },
  },
  {
    // 连坐参数（P2-11，hub Unreleased「自定义时长面板化」）。
    //
    // 这四个值 2026-11-08 前只是 env、改一次要重启网关。现在读运行期配置
    // （`src/workbuddy/runtime.js`），env 仍是默认值来源：只设 env 不碰面板的
    // 部署行为不变。
    //   GET  → 当前生效值 + env 默认值（界面能看出「哪些是文件覆盖的」）
    //   PUT  → 保存并**立即按新阈值重算倒计时**（改短 = 现有暂停当场收窄）
    method: 'GET',
    path: '/restriction/config',
    handler: async ({ res }) => {
      const runtime = require('../../workbuddy/runtime');
      let config;
      try { config = runtime.Load(); } catch (e) { config = runtime.defaults(); }
      return sendJSON(res, 200, {
        ok: true,
        config: config.restriction,
        thinking: config.thinking,
        envDefaults: runtime.defaults().restriction,
        thinkingDefaults: runtime.defaults().thinking,
        file: runtime.FILE,
        note: 'holdSeconds=0 彻底关闭连坐暂停（仍记「哪些号被限制」供观测）；改短时长会立即截断现有倒计时。thinking.defaultEffort 留空 = 用模型目录的 defaultEffort。',
      });
    },
  },
  {
    method: 'PUT',
    path: '/restriction/config',
    handler: async ({ res, body }) => {
      const runtime = require('../../workbuddy/runtime');
      let out;
      try {
        // 兼容两种提交形状：{restriction:{...}, thinking:{...}}（新面板一次提交两组）
        // 与裸 restriction 字段对象（旧面板）。thinking 不在 body 里时不下发
        // （patch 语义：不传 = 不改动）。
        const hasThinking = body && body.thinking && typeof body.thinking === 'object'
          && !Array.isArray(body.thinking);
        const patch = hasThinking
          ? { restriction: body.restriction || {}, thinking: body.thinking }
          : { restriction: body || {} };
        out = runtime.Store(patch);
      } catch (e) {
        return sendJSON(res, 400, { ok: false, error: e.message });
      }
      // 截断立即生效的落地动作：
      // 1) 本进程（管理端）内存里若也有暂停，重算快照——restrictionState 已按
      //    现读配置夹 until，不用额外做事
      // 2) 网关进程下次判定时自然读到新配置（mtime 失效重读），无需信号文件
      // 3) 把新的观测快照刷一次，界面不必等下一个请求
      try { wb.repersistRestriction(); } catch (e) { /* 观测快照刷失败不影响配置落盘 */ }
      try {
        require('../auth').audit('admin', 'workbuddy_restriction_config', '',
          JSON.stringify(out.changed));
      } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, {
        ok: true,
        config: out.config.restriction,
        thinking: out.config.thinking,
        changed: out.changed.restriction || {},
        thinkingChanged: out.changed.thinking || {},
        state: wb.restrictionState(),
      });
    },
  },
  {
    // 一键解除连坐暂停。body: {region:'cn'|'intl'}（也接受 global）
    //
    // 跨进程：管理端改不了网关内存，所以写的是**信号文件**，由网关在下一次
    // 判定时消费；同时乐观更新快照，管理端立刻看到解除。
    method: 'POST',
    path: '/restriction/clear',
    handler: async ({ res, body }) => {
      const region = (body && body.region) || '';
      const r = wb.requestClearRestriction(region);
      if (r.ok) {
        try { require('../auth').audit('admin', 'workbuddy_restriction_clear', r.region); } catch (e) { /* 审计失败不影响结果 */ }
      }
      return sendJSON(res, r.ok ? 200 : 400, r);
    },
  },
  {
    // 从官方客户端认证文件导入（登录流程后置期的账号来源）。
    // body: { region: 'cn'|'global' }。区域红线：凭据域必须与目标区域一致。
    method: 'POST',
    path: '/import-client',
    handler: async ({ res, body }) => {
      const region = (body && body.region) || 'cn';
      const r = await authStore.importFromClient(region);
      if (r.ok) {
        try { require('../auth').audit('admin', 'workbuddy_import_client', String(r.account && r.account.id), `region=${region}`); } catch (e) { /* 审计失败不影响结果 */ }
      }
      return sendJSON(res, 200, r);
    },
  },
  {
    // 手动粘贴 token 导入。body: {region, accessToken, refreshToken, uid?, nickname?, domain?}
    method: 'POST',
    path: '/import-token',
    handler: async ({ res, body }) => {
      const r = authStore.importManual(body || {});
      if (r.ok) {
        try { require('../auth').audit('admin', 'workbuddy_import_token', String(r.account && r.account.id), `region=${(body && body.region) || 'cn'}`); } catch (e) { /* 审计失败不影响结果 */ }
      }
      return sendJSON(res, 200, r);
    },
  },
  {
    // OAuth 设备授权登录 · 第一步：生成授权链接（浏览器登录，天然多账号）。
    // body: {region:'cn'|'global'}。协议见 src/workbuddy/login.js 头注释。
    method: 'POST',
    path: '/login/url',
    handler: async ({ res, body }) => {
      const login = require('../../workbuddy/login');
      const region = constants.normalizeRegion((body && body.region) || 'cn');
      const r = await login.startLogin(region);
      return sendJSON(res, 200, r);
    },
  },
  {
    // OAuth 设备授权登录 · 第二步：轮询一次。
    // body: {region, state}。pending 时前端隔 2 秒再调；ok 时账号已入池。
    method: 'POST',
    path: '/login/poll',
    handler: async ({ res, body }) => {
      const login = require('../../workbuddy/login');
      const region = constants.normalizeRegion((body && body.region) || 'cn');
      const state = String((body && body.state) || '').trim();
      if (!state) return sendJSON(res, 400, { status: 'error', error: '缺 state（先调 login/url）' });
      const r = await login.pollLogin(region, state);
      if (r.status === 'ok' && r.account) {
        try { require('../auth').audit('admin', 'workbuddy_oauth_login', String(r.account.id), `region=${region}`); } catch (e) { /* 审计失败不影响结果 */ }
      }
      return sendJSON(res, 200, r);
    },
  },
  {
    // 模型实时繁忙度（2026-11-08 融合批）
    //
    // 用途：**选号/发请求之前**就知道目标模型是否在排队，而不是撞满 429 才退避。
    // 上游 `/v2/chat/busy` 是唯一「免费、不扣额度、不动账号状态」的接口。
    //
    // 三条口径（违反任一条都会把探针变成故障源）：
    //   1. **国际版 404** → 回 `unsupported: true` 而不是 error，界面显示
    //      「国际版没有该接口」而不是红字报错；
    //   2. **≤50 一批**，`busy.js` 内部自动分批；
    //   3. **只读不拦**：本端点只报告繁忙度，不参与选号。要拦必须显式开
    //      `DUMATE_WORKBUDDY_BUSY_GUARD=1`（默认关，见 busy.guardEnabled）。
    method: 'GET',
    path: '/busy',
    handler: async ({ res, req }) => {
      const url = new URL(req.url || '', 'http://x');
      const region = regionOf(req.url || '') || 'cn';
      const want = String(url.searchParams.get('models') || '').trim();
      const busy = require('../../workbuddy/busy');
      const authStore = require('../../workbuddy/auth');

      // 没点名就取模型表里的全部 id（目录为空时如实返回空，不编）
      let ids = want ? want.split(',').map((x) => x.trim()).filter(Boolean) : [];
      if (!ids.length) {
        try {
          const m = await require('../../workbuddy/models').fetchModels({ region });
          ids = (m.models || []).map((x) => x.id).filter(Boolean);
        } catch (e) { ids = []; }
      }
      if (!ids.length) {
        return sendJSON(res, 200, {
          ok: true, region, models: [], levels: {}, crowded: [],
          unsupported: false,
          guardEnabled: busy.guardEnabled(),
          note: '没有模型 id 可查（模型目录为空，或 ?models= 未点名）',
          at: Date.now(),
        });
      }

      const usable = authStore.findUsable().filter(
        (a) => require('../../workbuddy/constants').normalizeRegion(a.region) === region,
      );
      if (!usable.length) {
        return sendJSON(res, 200, {
          ok: false, region, models: ids, levels: {}, crowded: [],
          error: `没有可用的${region === 'global' ? '国际' : '国内'}账号，无法探测繁忙度`,
          // 三个「恒在」字段每个分支都要给：界面靠它们渲染，缺一个就是 undefined，
          // 而 undefined 在模板里既不是 true 也不是 false（会静默显示成「关」）
          unsupported: false,
          guardEnabled: busy.guardEnabled(),
          note: '没有可用账号，繁忙度不可用——这不代表模型不可用',
          at: Date.now(),
        });
      }
      // 探针只用第一个账号：繁忙度是**模型级**的上游事实，与哪个账号问无关，
      // 轮询全部账号只会把上游请求放大 N 倍
      const acc = await authStore.ensureFresh(usable[0]).catch(() => usable[0]);
      let r;
      try {
        r = await busy.fetchBusy(region, acc, ids);
      } catch (e) {
        r = { ok: false, levels: {}, crowded: [], error: e.message };
      }
      return sendJSON(res, 200, {
        ok: !!r.ok,
        region,
        models: ids,
        levels: r.levels || {},
        crowded: r.crowded || [],
        unsupported: !!r.unsupported,
        error: r.error || '',
        note: r.unsupported
          ? '国际版没有 /v2/chat/busy 接口（上游 404），繁忙度信息不可用——这是如实的「查不到」，不是通道故障'
          : '繁忙度是上游的瞬时估算：只作参考，不参与选号（要拦请显式开 DUMATE_WORKBUDDY_BUSY_GUARD=1）',
        guardEnabled: busy.guardEnabled(),
        at: Date.now(),
      });
    },
  },
  {
    // 成长中心（2026-11-08 融合批，**只读**）
    //
    // 调研把「成长任务引擎」列为本项目最大缺失项。这里只做只读聚合：
    // 连登档位 / 热力墙 / 任务进度 / 成长能量 / 盲盒额度。
    //
    // **一个写接口都不调**（不接取任务、不领奖、不开盲盒）：
    //   1. 调研实证「伪造 /v2/report 成长事件会被上游识别为异常，2026-10-15
    //      起国际版收紧」——写操作收益（积分）与风险（封号）不对称；
    //   2. 领奖/接取的 body 形状在调研里被标为「未在 unlocked 态验证」。
    //
    // 每次请求打 5 个只读端点，所以**只由界面按需触发**，不进任何自动排程。
    method: 'GET',
    path: '/growth',
    handler: async ({ res, req }) => {
      const region = regionOf(req.url || '') || 'cn';
      const url = new URL(req.url || '', 'http://x');
      const wantId = Number(url.searchParams.get('id') || 0);
      const growth = require('../../workbuddy/growth');
      const authStore = require('../../workbuddy/auth');
      const constants = require('../../workbuddy/constants');

      const usable = authStore.findUsable().filter(
        (a) => constants.normalizeRegion(a.region) === region,
      );
      if (!usable.length) {
        return sendJSON(res, 200, {
          ok: false, region, streak: null, heatmap: null, tasks: null,
          energy: null, buddyQuota: null, errors: {},
          error: `没有可用的${region === 'global' ? '国际' : '国内'}账号`,
          note: '只读：不接取任务、不领奖、不开盲盒',
          at: Date.now(),
        });
      }
      const acc = wantId ? (usable.find((a) => Number(a.id) === wantId) || usable[0]) : usable[0];
      // 只读查询前先确保 token 新鲜（与 /credits 同口径；失败也用旧 token 试一次）
      const fresh = await authStore.ensureFresh(acc).catch(() => acc);
      let out;
      try {
        out = await growth.fetchGrowth(region, fresh);
      } catch (e) {
        out = {
          ok: false, region, streak: null, heatmap: null, tasks: null, energy: null,
          buddyQuota: null, errors: { all: e.message }, note: '', at: Date.now(),
        };
      }
      return sendJSON(res, 200, {
        ...out,
        accountId: acc.id,
        accountName: acc.nickname || acc.uid || `账号 ${acc.id}`,
      });
    },
  },
  {
    // 模型表（只读，上游下发，双区域目录）
    method: 'GET',
    path: '/models',
    handler: async ({ res, req }) => {
      const force = /[?&]refresh=1/.test(req.url || '');
      const region = regionOf(req.url || '') || 'cn';
      let out = { ok: false, error: '', models: [], fetchedAt: 0 };
      try { out = await models.fetchModels({ force, region }); } catch (e) {
        out = { ok: false, error: e.message, models: [], fetchedAt: 0 };
      }
      return sendJSON(res, 200, {
        models: out.models || [],
        total: (out.models || []).length,
        region,
        error: out.error || '',
        fetchedAt: out.fetchedAt || 0,
        // credits 字符串是上游原值（"x0.34 credits"），解析后的倍率在 rate
        rateNote: 'credits 是上游标注的倍率（x0.00 = 免费）；实际扣费按账号套餐积分。',
      });
    },
  },
  {
    // 全部账号的签到状态与额度。?region= 区域视图 / ?uids=1,2 只点名刷新
    //
    // **快照按全量账号更新**（traework 同口径）：区域视图只过滤返回行，不缩窄
    // 查询/写入范围——否则国内视图会把国际临期条目忘干净，反过来也一样。
    // 国际版的 checkinStatus / fetchCredits 都是 immediate unsupported（不打
    // 上游），全量查询的额外成本只有国内号本身。
    //
    // **?uids=（P0-3，hub Unreleased「只点名缺积分的号」）**：每号一次刷新要打
    // 三个上游端点（签到状态 + 额度 + 按 TTL 的档位），账号一多既慢又更容易被
    // 风控注意到。前端积分页只对「额度为 null / 报错」的行点名补刷，其余账号
    // 一次不发。区域视图与快照口径不变：只刷新点名的号、其余账号的临期条目
    // 原样保留（`keepIds`），响应带 `scope: 'partial'` 让界面如实标注。
    method: 'GET',
    path: '/credits',
    handler: async ({ res, req }) => {
      const region = regionOf(req.url || '');
      const uids = uidsOf(req.url || '');
      const proxyAgent = require('../../proxy-agent');
      const rows = [];
      const all = authStore.findUsable();
      const wanted = uids ? all.filter((a) => uids.has(Number(a.id))) : all;
      for (const raw of wanted) {
        const a = await authStore.ensureFresh(raw);
        let agent = null;
        try { agent = proxyAgent.getAgentFor(a); } catch (e) {
          rows.push({ id: a.id, nickname: a.nickname || a.uid || `账号 ${a.id}`, region: a.region, error: `出站代理配置错误: ${e.message}` });
          continue;
        }
        const st = await billing.checkinStatus(a.region, a).catch((e) => ({ ok: false, error: e.message }));
        const q = await billing.fetchCredits(a.region, a).catch((e) => ({ ok: false, error: e.message }));
        // 档位（hub #505）：计费摘要是唯一可信的档位来源。TTL 24h 内读档案
        // 缓存、过期才打上游（每账号每天最多一次）；失败保留旧值。与签到/
        // 额度同一处顺带刷新，不新开定时器。
        const tier = await billing.maybeRefreshTier(a).catch(() => (a.tier || null));
        rows.push({
          id: a.id,
          nickname: a.nickname || a.uid || `账号 ${a.id}`,
          uid: a.uid || '',
          region: a.region,
          // 签到仅国内版：国际行标 unsupported，界面显示「不支持」而不是错误
          checkedIn: st.ok ? st.todayCheckedIn : null,
          unsupportedCheckin: !!st.unsupported,
          dailyCredit: st.ok ? st.dailyCredit : null,
          streakDays: st.ok ? st.streakDays : null,
          tier: tier ? { paid: !!tier.paid, package: tier.package || '', at: tier.at || null } : null,
          // 额度包：total 是各套餐剩余之和；明细给界面拆。
          // totalPrecise 是精确合计（整数 remain 是 floor），FEFO 快照也用它
          total: q.ok ? q.total : null,
          totalPrecise: q.ok ? (q.totalPrecise != null ? q.totalPrecise : null) : null,
          packages: q.ok ? q.packages : [],
          lastCheckin: a.lastCheckin || null,
          error: [st.ok ? '' : (st.unsupported ? '' : st.error), q.ok ? '' : q.error].filter(Boolean).join('；'),
        });
      }

      // FEFO 快照：到期取各套餐 CycleEndTime 的最早值，窗口内才进门（与读方
      // 同窗）；查询失败的账号进 keepIds 保留旧条目——「查不到」不是「没有
      // 临期」，写空会让 FEFO 在一次网络抖动后把临期账号忘干净。
      //
      // 点名刷新（?uids=）时同理：**没被点名的账号一律进 keepIds**，它们这次
      // 根本没查，保留旧条目是唯一正确的处置（否则一次补刷会清掉其余账号的
      // 临期信息，FEFO 立刻退回普通轮询）。
      //
      // **代价如实说**：带 keepIds 时 expiring.js **不推进快照心跳 at**（它的
      // 语义是「部分数据是旧的，不能让快照看起来同样新鲜」），所以只做点名
      // 补刷不会延长 FEFO 的 TTL。前端进页面本来就走一次全量刷新，正常使用
      // 不受影响；若长期只补刷，6 小时后 FEFO 会自动退回普通轮询（安全方向）。
      const expiringSnap = require('../../expiring');
      const winMs = expiringSnap.windowDays('workbuddy') * 86400000;
      const nowMs = Date.now();
      const fefoEntries = [];
      const fefoKeep = [];
      const refreshed = new Set(rows.map((r) => Number(r.id)));
      for (const raw of all) {
        if (!refreshed.has(Number(raw.id))) fefoKeep.push(raw.id);
      }
      for (const r of rows) {
        const expires = (r.packages || [])
          .map((p) => p.expireAt)
          .filter((x) => Number.isFinite(x) && x > nowMs && x <= nowMs + winMs);
        if (r.total == null && r.error) fefoKeep.push(r.id);
        else if (expires.length) fefoEntries.push({ accountId: r.id, nearest: Math.min(...expires) });
      }
      expiringSnap.update('workbuddy', fefoEntries, { keepIds: fefoKeep });

      // 额度快照（P1-6 护栏的数据源）：与 FEFO 同源同一次查询，落全部账号的
      // 剩余额。查不到的账号不写（不进快照 = 护栏不知道，不是「剩 0」）；
      // 点名刷新时未点名的账号原样保留（scope:'partial'）。
      try {
        require('../../workbuddy/credits-snapshot').update(
          rows.map((r) => ({ id: r.id, remain: r.total, precise: r.totalPrecise })),
          { scope: uids ? 'partial' : 'all' },
        );
      } catch (e) { /* 快照写失败不影响 /credits 返回 */ }

      // 区域视图：返回的行 / 汇总都按该区域收窄（快照已按全量更新）
      const shown = region ? rows.filter((r) => constants.normalizeRegion(r.region) === region) : rows;
      const known = shown.filter((r) => r.total != null);
      return sendJSON(res, 200, {
        count: shown.length,
        region: region || undefined,
        // 本次刷新范围：'all' = 全量；'partial' = 只刷了点名的号（其余沿用旧值，
        // 界面据此提示「未刷新的行显示的是上次结果」）
        scope: uids ? 'partial' : 'all',
        requested: uids ? [...uids] : undefined,
        rows: shown,
        summary: {
          total: shown.length,
          valid: shown.filter((r) => !r.error).length,
          checkedIn: shown.filter((r) => r.checkedIn === true).length,
          unknown: shown.length - known.length,
          remainTotal: Number(known.reduce((s, r) => s + (r.total || 0), 0).toFixed(2)),
        },
        fefo: expiringSnap.info('workbuddy'),
      });
    },
  },
  {
    // 手动签到：幂等，已签的自动跳过；国际版明确报「不支持」。
    // body: {id?} 单账号，{group?} 按组批量（M2.4），都不传 = 全部可用账号
    method: 'POST',
    path: '/checkin',
    handler: async ({ res, body }) => {
      const id = body && body.id;
      const group = body && body.group ? String(body.group).trim() : '';
      let list;
      if (id) {
        list = [authStore.get(id)].filter(Boolean);
      } else if (group) {
        list = authStore.findUsable().filter((a) => (a.group || '') === group);
        if (!list.length) return sendJSON(res, 200, { ok: false, error: `分组「${group}」下没有可用账号` });
      } else {
        list = authStore.findUsable();
      }
      if (!list.length) return sendJSON(res, 200, { ok: false, error: '没有可用账号' });
      const out = [];
      for (const a of list) {
        const r = await wb.checkin(a);
        out.push({ id: a.id, nickname: a.nickname || a.uid || '', region: a.region, group: a.group || '', ...r });
        if (r.ok && !r.already) authStore.patch(a.id, { lastCheckin: Date.now(), lastError: '' });
      }
      const okCount = out.filter((r) => r.ok).length;
      try { require('../auth').audit('admin', 'workbuddy_checkin', id || (group ? `group:${group}` : 'all'), `${okCount}/${out.length}`); } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, { ok: true, results: out });
    },
  },
  {
    // ── 成长任务写路径（P0-6，2026-11-28 融合批；手动触发，端点本身就是独立开关）──
    //
    // 三个动作各自幂等/低风险（探针定案见 docs/CHANNEL-WORKBUDDY.md 11.x）：
    //   sweep  补领清扫：accept（幂等报名）+ claim（完成未领）+ 回读确认
    //   redeem 连登兑换：只兑 unlocked 档，403/409 是业务态如实报
    //   makeup 断登补签：每轮 ≤1 张补签卡，最近断点优先，无卡早退
    // 企业号（enterpriseId 非空）一律跳过——组织账号的行为自动化不碰。
    // 自动化入口在 autocheckin 第四腿，受 DUMATE_WORKBUDDY_TASKS_SWEEP（默认关）管；
    // 这里是手动按钮，操作人点了就是明确授权。
    method: 'POST',
    path: '/tasks/sweep',
    handler: async ({ res, body }) => {
      const tasks = require('../../workbuddy/tasks');
      const { list, err, skippedEnterprise } = taskAccountsOf(body);
      if (err) return sendJSON(res, 200, { ok: false, error: err });
      // 账号间并发、账号内互斥（runExclusive；同账号重复点击报 busy）
      const results = await Promise.all(list.map((a) => tasks.runExclusive(a, async () => ({
        id: a.id, nickname: a.nickname || a.uid || '', region: constants.normalizeRegion(a.region),
        ...(await tasks.sweepTasks(constants.normalizeRegion(a.region), a)),
      }))));
      try { require('../auth').audit('admin', 'workbuddy_tasks_sweep', (body && body.id) || 'all', results.map((r) => `#${r.id} 领${(r.claimed || []).length}/未验${(r.unverified || []).length}`).join(' ')); } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, { ok: results.some((r) => r.ok), skippedEnterprise: skippedEnterprise || 0, results });
    },
  },
  {
    method: 'POST',
    path: '/tasks/redeem',
    handler: async ({ res, body }) => {
      const tasks = require('../../workbuddy/tasks');
      const { list, err, skippedEnterprise } = taskAccountsOf(body);
      if (err) return sendJSON(res, 200, { ok: false, error: err });
      const results = await Promise.all(list.map((a) => tasks.runExclusive(a, async () => ({
        id: a.id, nickname: a.nickname || a.uid || '', region: constants.normalizeRegion(a.region),
        ...(await tasks.redeemUnlocked(constants.normalizeRegion(a.region), a)),
      }))));
      try { require('../auth').audit('admin', 'workbuddy_tasks_redeem', (body && body.id) || 'all', results.map((r) => `#${r.id} 兑${(r.redeemed || []).length}`).join(' ')); } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, { ok: results.some((r) => r.ok), skippedEnterprise: skippedEnterprise || 0, results });
    },
  },
  {
    method: 'POST',
    path: '/tasks/makeup',
    handler: async ({ res, body }) => {
      const tasks = require('../../workbuddy/tasks');
      const { list, err, skippedEnterprise } = taskAccountsOf(body);
      if (err) return sendJSON(res, 200, { ok: false, error: err });
      const results = await Promise.all(list.map((a) => tasks.runExclusive(a, async () => ({
        id: a.id, nickname: a.nickname || a.uid || '', region: constants.normalizeRegion(a.region),
        ...(await tasks.makeupBrokenDay(constants.normalizeRegion(a.region), a)),
      }))));
      try { require('../auth').audit('admin', 'workbuddy_tasks_makeup', (body && body.id) || 'all', results.map((r) => `#${r.id} ${r.used || '未用卡'}`).join(' ')); } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, { ok: results.some((r) => r.ok), skippedEnterprise: skippedEnterprise || 0, results });
    },
  },
  {
    // ── 官方逐请求用量账本（P1-6，只读）──
    //
    // R2 两本账：这里是**官方账本**（含官方客户端直连的消耗，reqlog 看不到的那
    // 一半）；网关侧账本在用量页。两者不是「一个总量的两部分」——覆盖范围不同，
    // 前端并排呈现时各自标来源。企业号跳过（成长/账本域对组织号 403，问了也是白问）。
    method: 'GET',
    path: '/usage-official',
    handler: async ({ res, req }) => {
      const usageMod = require('../../workbuddy/usage');
      const hoursRaw = Number(((req.url.match(/[?&]hours=(\d+)/) || [])[1]) || 0) || undefined;
      const regionQ = regionOf(req.url || '');
      const all = authStore.findUsable();
      const skipped = all.filter((a) => require('../../workbuddy/tasks').enterpriseBlocked(a)).length;
      let targets = all
        .filter((a) => !require('../../workbuddy/tasks').enterpriseBlocked(a))
        .map((a) => ({ account: a, region: constants.normalizeRegion(a.region), name: a.nickname || a.uid || `账号 ${a.id}`, id: a.id }));
      if (regionQ) targets = targets.filter((t) => t.region === regionQ);
      if (!targets.length) return sendJSON(res, 200, { ok: false, error: '没有可拉取账号' });
      const data = await usageMod.fetchOfficialUsage(targets, { hours: hoursRaw });
      data.skipped_enterprise = skipped;
      return sendJSON(res, 200, data);
    },
  },
  {
    // 模型规则（批次十二，misakano modelrules.go 移植）：命名模型组 + deny/allow
    // 挂账号。规则与「账号 → 规则 id」都进 workbuddy-model-rules.json（mtime 热
    // 读，网关零重启生效）。deny 并集 / allow 并集 / deny 优先，见 rules.js。
    method: 'GET',
    path: '/model-rules',
    handler: async ({ res, req }) => {
      const rules = require('../../workbuddy/rules');
      // ?account_id= 附加单账号视图：挂的规则 + 对指定模型的判定结果（排查用）
      const accId = Number(((req.url.match(/[?&]account_id=(\d+)/) || [])[1]) || 0);
      const model = decodeURIComponent(((req.url.match(/[?&]model=([^&]*)/) || [])[1]) || '').trim();
      const out = {
        ok: true,
        rules: rules.listRules(),
        counts: rules.ruleAccountCounts(),
        assignments: rules.ruleAssignments(),
      };
      if (accId) {
        const authStore = require('../../workbuddy/auth');
        const acc = authStore.get(accId);
        out.account = acc ? {
          id: acc.id, nickname: acc.nickname || acc.uid || `账号 ${acc.id}`,
          region: acc.region || 'cn', ruleIds: rules.ruleIdsOf(accId),
        } : null;
        if (model && out.account) {
          out.account.blocked = rules.blockedByRules(accId, out.account.region, model);
        }
      }
      return sendJSON(res, 200, out);
    },
  },
  {
    method: 'POST',
    path: '/model-rules',
    handler: async ({ res, body, user }) => {
      const rules = require('../../workbuddy/rules');
      try {
        const rule = rules.upsertRule((body && body.rule) || body || {});
        try { require('../auth').audit(user && user.username, 'workbuddy_rule_upsert', rule.id, `${rule.mode} ${rule.name}`); } catch (e) { /* 审计失败不影响结果 */ }
        return sendJSON(res, 200, { ok: true, rule });
      } catch (e) {
        return sendJSON(res, e.statusCode || 400, { ok: false, error: e.message });
      }
    },
  },
  {
    method: 'DELETE',
    path: '/model-rules/:id',
    handler: async ({ res, params, user }) => {
      const rules = require('../../workbuddy/rules');
      const ok = rules.deleteRule(params[0]);
      if (ok) { try { require('../auth').audit(user && user.username, 'workbuddy_rule_delete', params[0]); } catch (e) { /* 审计失败不影响结果 */ } }
      return sendJSON(res, ok ? 200 : 404, { ok, error: ok ? '' : `规则不存在: ${params[0]}` });
    },
  },
  {
    // 整体替换某账号挂的规则集合（编辑弹窗用）
    method: 'POST',
    path: '/model-rules/assign',
    handler: async ({ res, body, user }) => {
      const rules = require('../../workbuddy/rules');
      try {
        const ids = rules.assignRules(Number((body && body.account_id) || 0), (body && body.ids) || []);
        try { require('../auth').audit(user && user.username, 'workbuddy_rule_assign', String((body && body.account_id) || ''), ids.join(',')); } catch (e) { /* 审计失败不影响结果 */ }
        return sendJSON(res, 200, { ok: true, ids });
      } catch (e) {
        return sendJSON(res, e.statusCode || 400, { ok: false, error: e.message });
      }
    },
  },
  {
    // 把一条规则批量挂/摘（规则卡片「应用」用：账号多的池子里逐个配置太慢）
    method: 'POST',
    path: '/model-rules/apply',
    handler: async ({ res, body, user }) => {
      const rules = require('../../workbuddy/rules');
      try {
        const changed = rules.applyRule((body && body.id) || '', (body && body.account_ids) || [], !!(body && body.assigned));
        try { require('../auth').audit(user && user.username, 'workbuddy_rule_apply', String((body && body.id) || ''), `${(body && body.assigned) ? '挂' : '摘'} ${changed}`); } catch (e) { /* 审计失败不影响结果 */ }
        return sendJSON(res, 200, { ok: true, changed });
      } catch (e) {
        return sendJSON(res, e.statusCode || 400, { ok: false, error: e.message });
      }
    },
  },
  {
    // 6004 额度窗口表（批次十）：登记侧在 index.js model_cap 分支（带重置墙钟
    // 才登记），执行侧 windowprobe.js 到点发最小探针钉住新一轮窗口起点。
    method: 'GET',
    path: '/windows',
    handler: async ({ res }) => {
      const wp = require('../../workbuddy/windowprobe');
      const now = Date.now();
      const rows = wp.listWindows().map((w) => ({
        ...w,
        due: Number(w.resetAt) <= now,
        in_ms: Math.max(0, Number(w.resetAt) - now),
      }));
      return sendJSON(res, 200, {
        ok: true,
        enabled: wp.enabled(),
        next_due_in_ms: wp.nextDue() != null ? Math.max(0, wp.nextDue() - now) : null,
        windows: rows,
      });
    },
  },
  {
    // 立即探针：不等到点，把当前所有已登记窗口（或指定 账号+模型）立刻探一遍。
    // panel RunModelWindowProbeNow 同款——探针是真实计费对话请求，按钮要慎重。
    method: 'POST',
    path: '/windows/run',
    handler: async ({ res, req, body }) => {
      const wp = require('../../workbuddy/windowprobe');
      if (!wp.enabled()) return sendJSON(res, 200, { ok: false, error: '窗口探针已关闭（DUMATE_WORKBUDDY_WINDOW_PROBE=0）' });
      const accId = Number(body && body.account_id);
      const mdl = String((body && body.model) || '').trim();
      let targets = wp.listWindows();
      if (accId && mdl) targets = targets.filter((w) => w.accountId === accId && w.model === mdl);
      const due = targets.filter((w) => Number(w.resetAt) <= Date.now());
      // 未到点的窗口不提前探——提前探会把「还没重置」误记成一次尝试，纯浪费
      const notDue = targets.length - due.length;
      if (!due.length) {
        return sendJSON(res, 200, { ok: true, sent: 0, results: [], not_due: notDue, note: '没有到点的窗口（探针只在到点后才有意义）' });
      }
      const r = await wp.runDue();
      return sendJSON(res, 200, { ok: true, sent: r.sent, results: r.results, skipped_not_due: notDue });
    },
  },
  {
    method: 'GET',
    path: '/tasks/scan',
    handler: async ({ res, req }) => {
      const growth = require('../../workbuddy/growth');
      const tasks = require('../../workbuddy/tasks');
      const regionQ = regionOf(req.url || '');
      const idQ = Number(((req.url.match(/[?&]id=(\d+)/) || [])[1]) || 0);
      let list = idQ ? [authStore.get(idQ)].filter(Boolean) : authStore.findUsable();
      if (regionQ) list = list.filter((a) => constants.normalizeRegion(a.region) === regionQ);
      if (!list.length) return sendJSON(res, 200, { ok: false, error: '没有可扫描账号' });
      const executionEnabled = tasks.sweepEnabled();
      // 扫描是只读的，账号间并发（每账号 1 个 GET，低频手动触发）
      const results = await Promise.all(list.map((a) => growth.scanGrowthTasks(constants.normalizeRegion(a.region), a, { execution_enabled: executionEnabled })));
      return sendJSON(res, 200, {
        ok: results.some((r) => r.scan_state === 'ok' || r.scan_state === 'empty'),
        execution_enabled: executionEnabled,
        results: results.map((r, i) => ({ id: list[i].id, nickname: list[i].nickname || list[i].uid || '', region: constants.normalizeRegion(list[i].region), ...r })),
      });
    },
  },
  {
    // ── 11-128 取证（P1-5，默认关）──
    //
    // hub 的 `WB_DUMP_11_128`：上游收紧非官方客户端识别后，11-128 是 Claude Code
    // 类请求最常见的拒绝码。开关走 env（`DUMATE_WORKBUDDY_DUMP_11_128`，
    // `1`=摘要 / `full`=含原文），这里只读地告诉操作人「它开没开、落了哪些文件」。
    //
    // 为什么不在界面上直接改开关：它是**进程环境变量**，管理端改自己的
    // process.env 对网关无效（两个进程），做成界面开关会出现「界面显示开了、
    // 网关其实没开」的假象——那条坑本项目已经踩过（keys.js 的 require_key）。
    // 所以只读展示 + 操作指引，档位要靠启动参数。
    method: 'GET',
    path: '/dumps',
    handler: async ({ res, req }) => {
      const dump = require('../../workbuddy/dump');
      const limit = Math.min(200, Math.max(1, Number((req.url.match(/[?&]limit=(\d+)/) || [])[1]) || 50));
      return sendJSON(res, 200, {
        ok: true,
        ...dump.status(),
        files: dump.list(limit),
        howTo: {
          summary: 'DUMATE_WORKBUDDY_DUMP_11_128=1（只写脱敏摘要：头名清单、body 结构、指纹命中位置，不含提示词）',
          full: 'DUMATE_WORKBUDDY_DUMP_11_128=full（额外写出站 body 原文，token 已脱敏；排查完请删除文件）',
          extraCodes: 'DUMATE_WORKBUDDY_DUMP_CODES=11128,6004（默认只认 11-128 / 11128）',
        },
        discipline: '11-128 是请求形态判定、不是账号问题：先对照摘要里的身份头与消息形状，不要先轮换账号（换号只会让更多号暴露在同一形态下）。',
      });
    },
  },
  {
    // ── 额度护栏（P1-6，调研「积分低于阈值提前拦截」）──
    //
    // 现状是**事后**：积分耗尽 → 上游报错 → hard_credit → 402，每次都白打一个
    // 上游请求。护栏把这件事提前到选号：剩余低于阈值的账号不进候选（护栏是
    // **选号过滤**而非请求拦截，全被剔除时退回全量，不会把通道弄停）。
    //
    // 数据源是 `credits-snapshot`（/credits 顺手写的落盘快照）：快照陈旧/缺失
    // 时护栏自动失效——不拿旧余额把请求拦死。
    method: 'GET',
    path: '/guard',
    handler: async ({ res }) => {
      const runtime = require('../../workbuddy/runtime');
      let cfg;
      try { cfg = runtime.Load().guard; } catch (e) { cfg = runtime.defaults().guard; }
      const snap = require('../../workbuddy/credits-snapshot').info();
      // pool 层的保底线是启动时读 env（`const o` 定死，没有运行期入口），
      // 所以这里要如实报「当前生效值」与「文件里的值」——两者不一致时
      // 运维必须看得见，否则改了没反应会被当成 bug。
      let poolFloor = null;
      try { poolFloor = require('../../pool').DEFAULTS.creditFloor; } catch (e) { poolFloor = null; }
      return sendJSON(res, 200, {
        ok: true,
        config: cfg,
        snapshot: snap,
        // 保底线的真实生效值来自 env（重启才变），与上面的 cfg.creditFloor 可能不同
        poolFloor,
        note: '护栏是选号过滤：剩余低于阈值的账号不进候选；快照陈旧/缺失时自动失效（不拿旧余额拦请求）。'
          + `保留积分下限（creditFloor）由环境变量 DUMATE_POOL_CREDIT_FLOOR 控制，**重启网关才生效**；`
          + `当前 pool 实际生效值 = ${poolFloor == null ? '未知' : poolFloor}。`,
      });
    },
  },
  {
    method: 'PUT',
    path: '/guard',
    handler: async ({ res, body }) => {
      const runtime = require('../../workbuddy/runtime');
      let out;
      try {
        out = runtime.Store({ guard: body || {} });
      } catch (e) {
        return sendJSON(res, 400, { ok: false, error: e.message });
      }
      try {
        require('../auth').audit('admin', 'workbuddy_guard_config', '',
          JSON.stringify(out.changed.guard || {}));
      } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, {
        ok: true,
        config: out.config.guard,
        snapshot: require('../../workbuddy/credits-snapshot').info(),
      });
    },
  },
  {
    // ── 自动签到排程（P0-1，调研文件 docs/WORKBUDDY-FUSION.md）──
    //
    // 排程器本体在**管理端进程**（src/workbuddy/autocheckin.js），与 autotask /
    // task-scheduler / keepalive / balance-refresh 同一处——两个进程各排一份会
    // 把上游请求翻倍（boot.js 头注释的同一条纪律）。
    //
    // **国内版=签到、国际版=网页打卡**（2026-11-08 接通）：上游国际版没有签到
    // 接口，只有网页 agent 会话打卡（`webagent.dailyActivity`，ACP 建会话跑一轮）。
    // 那条代码早就写好却全库无调用方——CLAUDE.md 写着「keepalive 的 global 分支
    // 改为网页打卡」，实际没接。现在由本排程覆盖，`webDaily` 与 `claimed` 分开计数。
    //
    // GET  → 开关/时点/抖动/上次结果/下次触发（前端开关与状态展示的数据源）
    // PUT  → 改配置；**打开时立即跑一轮**，关闭时取消等待中的计划并中断进行中一轮
    method: 'GET',
    path: '/autocheckin',
    handler: async ({ res }) => {
      const autock = require('../../workbuddy/autocheckin');
      return sendJSON(res, 200, { ok: true, ...autock.snapshot() });
    },
  },
  {
    method: 'PUT',
    path: '/autocheckin',
    handler: async ({ res, body }) => {
      const autock = require('../../workbuddy/autocheckin');
      try {
        const s = autock.configure(body || {});
        try {
          require('../auth').audit('admin', 'workbuddy_autocheckin_config',
            s.enabled ? 'on' : 'off',
            `${s.hour}:${String(s.minute).padStart(2, '0')} jitter=${s.jitter_minutes}m`);
        } catch (e) { /* 审计失败不影响结果 */ }
        return sendJSON(res, 200, { ok: true, ...s });
      } catch (e) {
        return sendJSON(res, 400, { ok: false, error: e.message });
      }
    },
  },
  {
    // 立即跑一轮（不依赖开关状态）。**触发式**：一轮可能跑几秒到几十秒，
    // 同步 await 会把 HTTP 挂在超时上；结果靠 GET /autocheckin 的 running /
    // last_result 轮询——与 keepalive/run 同款交付形态。
    method: 'POST',
    path: '/autocheckin/run',
    handler: async ({ res }) => {
      const autock = require('../../workbuddy/autocheckin');
      autock.runOnce('manual').catch(() => { /* 轮内失败已落 last_result */ });
      return sendJSON(res, 200, { ok: true, started: true });
    },
  },
  {
    // 账号健康快照（仪表盘用，本地数据不打上游）。?region= 区域视图
    method: 'GET',
    path: '/dashboard',
    handler: async ({ res, req }) => {
      const region = regionOf(req.url || '');
      const all = authStore.list().filter((a) => !region || a.region === region);
      const now = Date.now();
      const accounts = all.map((a) => ({
        id: a.id,
        name: a.nickname || a.uid || `账号 ${a.id}`,
        uid: a.uid || '',
        region: a.region,
        enabled: a.enabled !== false,
        daysAlive: a.createdAt ? Math.floor((now - a.createdAt) / 86400000) : null,
        expiresAt: a.expiresAt || null,
        refreshExpiresAt: a.refreshExpiresAt || null,
        refreshExpired: !!(a.refreshExpiresAt && now >= a.refreshExpiresAt),
        lastError: a.lastError || '',
        refreshTail: a.refreshTail || '',
      }));
      return sendJSON(res, 200, {
        accounts,
        region: region || undefined,
        summary: {
          total: accounts.length,
          enabled: accounts.filter((a) => a.enabled).length,
          refreshExpired: accounts.filter((a) => a.refreshExpired).length,
          errored: accounts.filter((a) => a.lastError).length,
        },
      });
    },
  },
  {
    // 计费自检探针：按模型发一条小请求，用「套餐剩余合计」的前后快照差值
    // 实测扣费，与模型表标称 credits 倍率并排返回（口径对齐 TRAE 的同名端点）。
    // 国际版没有 credits 额度接口（订阅按请求数计）——如实 unsupported，不硬编。
    method: 'GET',
    path: '/billing-check',
    handler: async ({ req, res }) => {
      const model = decodeURIComponent(((req.url.match(/[?&]model=([^&]*)/) || [])[1] || ''))
        .replace(/^workbuddy\//, '').trim();
      if (!model) return sendJSON(res, 400, { ok: false, error: '缺 model 参数（如 ?model=glm-5.3）' });
      // 输出规模：套餐积分是整数，Δ 的分辨率 = 1 ÷ (tokens/1000)。默认数到 400
      // （约 1k tokens，快）；要压过量化噪声可传 ?count=2000（约 10k tokens）。
      const count = Math.min(4000, Math.max(100,
        Number((req.url.match(/[?&]count=(\d+)/) || [])[1]) || 400));
      const region = regionOf(req.url || '');
      if (region === 'global') {
        return sendJSON(res, 200, {
          ok: false,
          unsupported: true,
          model,
          expected: null,
          error: '国际版没有 credits 额度接口（订阅制按请求数计），无法测扣费',
        });
      }

      // 标称倍率：模型表可用的就取归一化行；取不到如实 null，探针仍然跑
      let expected = null;
      let free = false;
      try {
        const r = await models.fetchModels({ region: 'cn' });
        const meta = (r.models || []).find((m) => m.id === model) || null;
        if (meta) {
          expected = meta.rate != null ? Number(meta.rate) : null;
          free = meta.free === true;
        }
      } catch (e) { /* 表不可用按 null */ }

      const usable = authStore.findUsable()
        .filter((a) => constants.normalizeRegion(a.region) === 'cn');
      if (!usable.length) {
        return sendJSON(res, 200, { ok: false, unsupported: true, model, expected, error: '没有可用的国内账号' });
      }

      // 快照所有国内账号的套餐剩余合计：选号交给池，探针事先不知道用哪个号。
      // 取不到额度的账号不进 map——后面按缺失跳过，不补 0。
      // **优先精确余额**（totalPrecise，来自上游 "…Precise" 字段）：整数 remain
      // 是 floor，会把小请求的扣费吞成 0/1（2026-11-04 首次探针的教训）。
      let preciseDecimals = null;
      const snapshot = async () => {
        const remain = new Map();
        for (const raw of usable) {
          try {
            const a = await authStore.ensureFresh(raw);
            const q = await billing.fetchCredits('cn', a);
            if (q.ok && q.total != null) {
              remain.set(String(a.id), q.totalPrecise != null ? q.totalPrecise : q.total);
              if (q.preciseDecimals != null && (preciseDecimals == null || q.preciseDecimals > preciseDecimals)) {
                preciseDecimals = q.preciseDecimals;
              }
            }
          } catch (e) { /* 单账号失败不影响快照其余账号 */ }
        }
        return remain;
      };

      const before = await snapshot();
      const startedAt = Date.now();
      let servedId = null;
      let servedName = '';
      let tokens = null;
      try {
        const agg = await wb.send({
          model: `workbuddy/${model}`,
          // 让输出足够长：余额是两位小数，几百 token 的输出才能把量化误差
          // 压到可判读的范围内（与 TRAE / 千问探针同一个理由）
          messages: [{ role: 'user', content: `请从 1 数到 ${count}，每个数字之间用一个空格分隔，只输出数字本身，不要输出任何其他文字。` }],
          max_tokens: 4096,
        }, undefined, {
          region: 'cn',
          // 探针不惩罚账号：撞风控/限流时不给账号写冷却与 lastError（hub v1.7.20 #134）
          probe: true,
          onAccount: (name, id) => { servedName = name || ''; if (id != null) servedId = id; },
        });
        const u = (agg && agg.usage) || null;
        if (u) tokens = { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, total: u.total_tokens || 0 };
      } catch (e) {
        return sendJSON(res, 200, { ok: false, model, expected, error: e.message, elapsedMs: Date.now() - startedAt });
      }

      // 结算延迟：剩余额不会在响应返回的瞬间更新。轮询到增量出现为止
      // （4 次尝试共约 8 秒）；仍没有就如实报 null——不把「没测到」编成 0。
      let delta = null;
      let charged = [];
      let singleAccount = false;
      let last = null;
      for (let i = 0; i < 4; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, [1500, 2500, 4000][i - 1]));
        const after = await snapshot();
        last = billing.attributeDelta(before, after, servedId);
        if (last.delta != null && last.delta > 0) break;
        // 别的账号先涨（并发流量）也停——再等只会把对方的消耗卷进来
        if (last.charged.length) break;
      }
      delta = last ? last.delta : null;
      charged = last ? last.charged : [];
      singleAccount = last ? last.singleAccount : false;

      const billed = billing.billedRate(delta, tokens && tokens.total);
      const ratio = billing.ratioOf(billed, expected);
      // 实测单价台账（M2.6）：delta 是干净样本（前后快照差值），喂进 EMA。
      // 真实流量不喂——公测口径 usage.credit=0，没有可信计量字段
      let ledgerRow = null;
      if (billed != null) {
        try {
          ledgerRow = require('../../workbuddy/rate-ledger').recordRate(model, 'cn', billed, { nominal: expected });
        } catch (e) { /* 台账失败不影响探针结果 */ }
      }
      // 量化分辨率：套餐剩余额的粒度 = 上游小数位（precise 缺失时按整数 1）。
      // 单请求可分辨的最小倍率 = 粒度 ÷ (tokens/1000)——大于标称一半时 ratio
      // 只是量化伪影（2026-11-04 首次探针 1012 tokens ±0.988 的教训）。
      // 真机补充：该账号 8 位小数的 precise 包让粒度到 1e-8，量化可忽略——
      // 但**对话当前根本不实时扣这些套餐**（连打数请求 totalPrecise 纹丝不动，
      // 与 usage.credit=0 一致，公测/活动口径），delta=null 是真实测量结果。
      const unit = preciseDecimals != null ? Math.pow(10, -preciseDecimals) : 1;
      const resolution = tokens && tokens.total > 0
        ? Number((unit / (tokens.total / 1000)).toPrecision(2)) : null;
      const unresolved = resolution != null && expected != null && expected > 0 && resolution > expected / 2;
      return sendJSON(res, 200, {
        ok: true,
        model,
        account: servedName || null,
        accountId: servedId,
        expected,
        billed,
        ratio,
        delta,
        tokens,
        resolution,
        charged,
        singleAccount,
        free,
        elapsedMs: Date.now() - startedAt,
        ledger: ledgerRow ? { ema: ledgerRow.ema, samples: ledgerRow.samples, min: ledgerRow.min, max: ledgerRow.max } : null,
        warning: delta == null
          ? '请求成功，但 8 秒内未观测到套餐剩余额的变化——真机实证该账号的对话当前不实时扣套餐（公测/活动口径，与 usage.credit=0 一致），此为真实测量结果而非故障；免费模型不扣费同理'
          : (free ? '该模型标称免费（x0.00）——测到扣费说明上游可能改了计费口径'
            : (unresolved
              ? `套餐积分按整数扣减：本次 Δ=${delta}（${tokens.total} tokens），测量分辨率 ±${resolution} 积分/千token，大于标称 ${expected} 的一半——比值不可判读；请用更大输出重测（?count=2000 约 10k tokens）`
              : '')),
        note: 'delta = 请求前剩余 − 请求后剩余（套餐剩余额下降即本次消耗；推断口径，受结算延迟/并发影响）。'
          + '倍率 = delta ÷ (total_tokens/1000)；标称取模型表 credits（x0.34 credits → 0.34，x0.00 = 免费）。'
          + '测量分辨率 = 剩余额粒度 ÷ (tokens/1000)（见 resolution 字段），'
          + '分辨率大于标称一半时 ratio 只是量化伪影——用 ?count=2000 加大输出可压过。'
          + '与 TRAE/Qoder 的倍率数字**不可跨通道互比**（各通道积分体系不同）。',
      });
    },
  },
  {
    // 模型输出上限探测结果（M2.5）：读 data/workbuddy-output-probes.json。
    // UI 按行红/绿/灰标注 + 超 30 天褪色——实测值不写死代码，重跑探针即刷新
    method: 'GET',
    path: '/output-probes',
    handler: async ({ res }) => {
      const probe = require('../../workbuddy/output-probe');
      const doc = probe.loadProbes();
      const rows = Object.values(doc);
      return sendJSON(res, 200, {
        count: rows.length,
        staleAfterMs: 30 * 86400 * 1000,
        rows,
      });
    },
  },
  {
    // 跑一次输出上限探针。body: {model, region?}。耗时可达 1~3 分钟
    //（最多 4 档、每档一次真实请求），前端要给长超时并明示进度
    method: 'POST',
    path: '/probe-output',
    handler: async ({ res, body }) => {
      const probe = require('../../workbuddy/output-probe');
      const model = String((body && body.model) || '').trim().replace(/^workbuddy\//, '');
      if (!model) return sendJSON(res, 400, { ok: false, error: '缺 model 参数' });
      const region = (body && body.region) || undefined;
      try {
        const row = await probe.probeOne(model, region ? { region } : {});
        probe.saveProbe(row);
        try { require('../auth').audit('admin', 'workbuddy_probe_output', `${model}@${row.region}`, row.verdict); } catch (e) { /* 审计失败不影响结果 */ }
        return sendJSON(res, 200, { ok: true, row });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: e.message });
      }
    },
  },
  {
    // 实测单价台账（M2.6）：每模型 EMA（credits ÷ 千 token）+ min/max 全距。
    // 样本源是 billing-check 探针；模型页/积分页可与标称并排展示
    method: 'GET',
    path: '/rate-ledger',
    handler: async ({ res }) => {
      const ledger = require('../../workbuddy/rate-ledger');
      const doc = ledger.loadLedger();
      const rows = Object.values(doc).sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return sendJSON(res, 200, {
        count: rows.length,
        alpha: ledger.ALPHA,
        rows,
      });
    },
  },
  {
    method: 'DELETE',
    path: '/accounts/:id',
    handler: async ({ res, params }) => {
      const ok = authStore.remove(params[0]);
      if (!ok) return sendJSON(res, 404, { error: '账号不存在' });
      try { require('../auth').audit('admin', 'workbuddy_account_delete', params[0]); } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, { ok: true });
    },
  },
  {
    method: 'PATCH',
    path: '/accounts/:id',
    handler: async ({ res, params, body }) => {
      const fields = {};
      if (body && body.enabled !== undefined) fields.enabled = !!body.enabled;
      if (body && body.nickname !== undefined) fields.nickname = String(body.nickname || '').trim();
      // 分组（M2.4）：空串 = 移出分组。组名限 40 字符，防手滑贴一大段
      if (body && body.group !== undefined) fields.group = String(body.group || '').trim().slice(0, 40);
      // 出站代理（M2.1）：保存前必须过 normalizeProxyUrl——非法地址在保存时
      // 就暴露，而不是等第一次请求失败才发现。空串 = 清除（回到直连）。
      // 配了代理就绝不静默回退直连（proxy-agent 的约定），所以校验失败直接 400。
      if (body && body.proxy !== undefined) {
        const raw = String(body.proxy || '').trim();
        if (!raw) {
          fields.proxy = ''; // 清除
        } else {
          try {
            const proxyAgent = require('../../proxy-agent');
            fields.proxy = proxyAgent.normalizeProxyUrl(raw);
          } catch (e) {
            return sendJSON(res, 400, { error: `代理地址无效: ${e.message}` });
          }
        }
      }
      const a = authStore.patch(params[0], fields);
      if (!a) return sendJSON(res, 404, { error: '账号不存在' });
      try {
        require('../auth').audit('admin', 'workbuddy_account_patch', params[0],
          JSON.stringify({ ...fields, proxy: fields.proxy !== undefined ? (fields.proxy ? 'set' : 'cleared') : undefined }));
      } catch (e) { /* 审计失败不影响结果 */ }
      // 返回脱敏形态——原始 URL（含可能的 user:pass）不出进程
      const proxyAgent = require('../../proxy-agent');
      return sendJSON(res, 200, {
        ok: true,
        proxy: a.proxy ? proxyAgent.describeProxy(a) : null,
        account: authStore.list().find((x) => x.id === a.id),
      });
    },
  },
];

module.exports = { routes };
