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
    // 全部账号的签到状态与额度。?region= 区域视图
    //
    // **快照按全量账号更新**（traework 同口径）：区域视图只过滤返回行，不缩窄
    // 查询/写入范围——否则国内视图会把国际临期条目忘干净，反过来也一样。
    // 国际版的 checkinStatus / fetchCredits 都是 immediate unsupported（不打
    // 上游），全量查询的额外成本只有国内号本身。
    method: 'GET',
    path: '/credits',
    handler: async ({ res, req }) => {
      const region = regionOf(req.url || '');
      const proxyAgent = require('../../proxy-agent');
      const rows = [];
      const all = authStore.findUsable();
      for (const raw of all) {
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
      const expiringSnap = require('../../expiring');
      const winMs = expiringSnap.windowDays('workbuddy') * 86400000;
      const nowMs = Date.now();
      const fefoEntries = [];
      const fefoKeep = [];
      for (const r of rows) {
        const expires = (r.packages || [])
          .map((p) => p.expireAt)
          .filter((x) => Number.isFinite(x) && x > nowMs && x <= nowMs + winMs);
        if (r.total == null && r.error) fefoKeep.push(r.id);
        else if (expires.length) fefoEntries.push({ accountId: r.id, nearest: Math.min(...expires) });
      }
      expiringSnap.update('workbuddy', fefoEntries, { keepIds: fefoKeep });

      // 区域视图：返回的行 / 汇总都按该区域收窄（快照已按全量更新）
      const shown = region ? rows.filter((r) => constants.normalizeRegion(r.region) === region) : rows;
      const known = shown.filter((r) => r.total != null);
      return sendJSON(res, 200, {
        count: shown.length,
        region: region || undefined,
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
