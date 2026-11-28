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

/**
 * 管理端的上游读/写动作要用**新鲜** access token。
 *
 * 聊天链路的 send() 会 session.ensureAccount 刷新，管理端此前直接用落盘的
 * accessToken——token 过期后整页变成「状态未查询」，签到也必然失败。刷新
 * 失败返回 error 而不抛出：原因交给该账号那一行显示（ensureAccount 已把
 * 换票失败写进 lastError）。
 */
async function fresh(raw) {
  try {
    return { account: await session.ensureAccount(authStore, raw) };
  } catch (e) {
    return { account: null, error: e.message };
  }
}

const routes = [
  // 回收站四路由（批次十六）：列表/清空/恢复/永久删除。放最前，防被参数路由截胡
  ...require('../trash').routesFor('qoder'),
  {
    // 通道状态 + 账号列表（脱敏：token 只给尾部 6 位）
    // ?region=（2026-11-03）：cn / global（intl 也认）——国内/国际独立视图
    method: 'GET',
    path: '/status',
    handler: async ({ res, req }) => {
      // 存量账号补一次脱敏手机号（本功能上线前登录的没有这一项）。
      // 不 await：读路径不该被上游请求拖住，第一次没补上，下次进来自然就有。
      // 幂等 + 每账号只试一次，所以重复调用没有代价。
      authStore.backfillPhone(session).catch(() => {});

      const regionRaw = decodeURIComponent(((req.url.match(/[?&]region=([^&]*)/) || [])[1] || '')).toLowerCase();
      const region = regionRaw === 'intl' ? 'global' : (regionRaw === 'cn' || regionRaw === 'global' ? regionRaw : '');
      const all = authStore.list();
      const rows = region ? all.filter((a) => constants.normalizeRegion(a.region) === region) : all;
      let st = { ready: false, error: '' };
      try { st = qoder.status(); } catch (e) { st = { ready: false, error: e.message }; }
      // 区域视图下 ready / 计数按该区域重算
      let ready = st.ready;
      let error = st.error || '';
      if (region) {
        ready = rows.some((r) => r.enabled);
        if (!rows.length) error = region === 'global' ? '没有国际版账号（先到账号管理 → 国际版添加）' : '没有国内账号';
      }
      return sendJSON(res, 200, {
        ready,
        error,
        accounts: rows.length,
        needsClient: false,
        region: region || undefined,
        mode: 'multi',
        modeNote: 'Qoder 的凭证由本项目走 device flow 自取并保存（data/qoder-accounts.json），可多账号并存、可增删。签名是纯本地算法，不需要安装 Qoder 客户端。',
        rows,
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
      // 区域（页面区分两区模型表）：cn（缺省）/ global。取该区域的
      // 主账号；没有该区域账号时如实报错——不静默拿另一区的表顶上
      const regionRaw = decodeURIComponent(((req.url.match(/[?&]region=([^&]*)/) || [])[1] || '')).toLowerCase();
      const region = regionRaw === 'global' || regionRaw === 'intl' ? 'global' : '';
      let pref;
      if (region) {
        const pool = authStore.findUsable().filter((a) => constants.normalizeRegion(a.region) === region);
        pref = pool.find((a) => a.preferred) || pool[0] || null;
        if (!pref) return sendJSON(res, 200, { models: [], total: 0, region, error: `没有国际（global）账号，无法拉取国际模型表`, fetchedAt: 0 });
      } else {
        pref = authStore.preferred();
      }
      if (!pref) return sendJSON(res, 200, { models: [], total: 0, region: region || undefined, error: '没有可用账号', fetchedAt: 0 });
      const fr = await fresh(pref);
      if (fr.error) return sendJSON(res, 200, { models: [], total: 0, region: region || constants.normalizeRegion(pref.region), error: fr.error, fetchedAt: 0, catalogSource: 'none' });
      try {
        const raw = await session.fetchModels(fr.account, { force });
        if (!raw.ok) return sendJSON(res, 200, { models: [], total: 0, region: constants.normalizeRegion(pref.region), error: raw.error || '', fetchedAt: 0, catalogSource: 'none' });
        const reg = constants.normalizeRegion(pref.region);
        // 叠加**主动探测**结论（P2-20）：模型表声称的输出上限普遍虚高，
        // 实测过的才有数字。没测过的 probe=null，界面不标注（没测 ≠ 没钳制）。
        let models = raw.models;
        try { models = require('../../qoder/output-probe').decorate(raw.models, { region: reg }); }
        catch (e) { models = raw.models; }
        return sendJSON(res, 200, {
          models,
          total: models.length,
          region: reg,
          error: '',
          fetchedAt: Date.now(),
          // P0-2：目录来源如实标注（upstream / disk-cache / client-cache / snapshot）
          catalogSource: 'upstream',
          // 倍率语义写清楚：相对值，不是积分绝对值
          rateNote: '倍率是相对值（上游字段 price_factor），实际扣费 = 倍率 × 用量。0.1 档最省，适合调试。',
          probeNote: 'probe 字段是**实测**输出上限（主动探测落盘）：clamped=被静默钳制（标「32K ⚠ 钳制 4×」）、'
            + 'at_least=追平过该档（标「64K ✓」）、inconclusive=测不出（标「?」）。'
            + '**没测过的不标注**——没测 ≠ 没钳制。30 天视为陈旧。',
        });
      } catch (e) {
        return sendJSON(res, 200, { models: [], total: 0, region: region || constants.normalizeRegion(pref.region), error: e.message, fetchedAt: 0 });
      }
    },
  },
  {
    // 全部账号的额度（打上游，慢）。**userQuota 与 addOnQuota 分开报**，
    // 界面不能相加——前者是订阅套餐内，后者是签到/赠送。
    // ?region=（2026-11-03）：cn / global（intl 也认）——国内/国际独立视图
    method: 'GET',
    path: '/credits',
    handler: async ({ res, req }) => {
      const regionRaw = decodeURIComponent(((req.url.match(/[?&]region=([^&]*)/) || [])[1] || '')).toLowerCase();
      const region = regionRaw === 'intl' ? 'global' : (regionRaw === 'cn' || regionRaw === 'global' ? regionRaw : '');
      let list = authStore.list();
      if (region) list = list.filter((a) => constants.normalizeRegion(a.region) === region);
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
            userQuota: null, addOnQuota: null, orgResourcePackage: null, isQuotaExceeded: null,
            checkedIn: null, checkinPending: null, checkinNextAt: null,
            lastCheckin: a.lastCheckin || null,
            error: `出站代理配置错误: ${e.message}`,
            checkinError: `出站代理配置错误: ${e.message}`,
          });
          continue;
        }
        // 管理端读接口不走聊天链路，拿的是落盘的 accessToken——过期不会
        // 自动刷新，整页会变成「状态未查询」、签到也必然 401。一个账号只
        // 换一次票（换票会轮换 refresh_token，拿旧对象重复换会失败）。
        const fr = await fresh(raw);
        if (fr.error) {
          rows.push({
            id: a.id,
            nickname: a.nickname || a.uid || `账号 ${a.id}`,
            region: a.region,
            planName: a.planName || '',
            userQuota: null, addOnQuota: null, orgResourcePackage: null, isQuotaExceeded: null,
            checkedIn: null, checkinPending: null, checkinNextAt: null,
            lastCheckin: a.lastCheckin || null,
            error: fr.error,
            checkinError: fr.error,
          });
          continue;
        }
        const acc = fr.account;
        const q = await session.fetchQuota(acc.accessToken, a.region, { agent });
        // 订阅周期观察（P1-10）：fetchQuota 打的是 `/api/v2/quota/usage`，
        // 它的响应体里若带周期边界（nextResetAt/expiresAt 一族）就顺手落盘。
        // 失败不改状态——宁可这次不更新，也不因为一次网络抖动把周期清零。
        try { require('../../qoder/period').observe(a.id, q.raw || q.data || null); }
        catch (e) { /* 观察失败不影响额度结果 */ }
        // 签到状态走**只读**的 /campaigns（不领取任何东西），与 TRAE 的
        // checkedIn 同一口径。查失败给 null，不猜成「已签」或「未签」。
        const ck = await session.checkinStatus(acc.accessToken, a.region, { agent });
        rows.push({
          id: a.id,
          nickname: a.nickname || a.uid || `账号 ${a.id}`,
          region: a.region,
          planName: a.planName || '',
          // 取不到时给 null，不补 0——0 会被读成「用完了」
          userQuota: q.ok ? q.userQuota : null,
          addOnQuota: q.ok ? q.addOnQuota : null,
          // 团队共享额度池（团队号才有）。有效余额 = 套餐 + 可用共享池；
          // cap=-1 表示不限量，界面按 unlimited 显示，不按数字比大小。
          orgResourcePackage: q.ok ? q.orgResourcePackage : null,
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
          // 签到状态单独报：额度查得到、签到查不到时，界面不能把两者混成
          // 一条「查询失败」，否则用户不知道自己点签到到底成没成。
          checkinError: ck.ok ? '' : (ck.error || '签到状态查询失败'),
        });
      }
      const known = rows.filter((r) => r.addOnQuota || r.userQuota);
      const sumAddOn = known.reduce((s, r) => s + ((r.addOnQuota && r.addOnQuota.remaining) || 0), 0);
      const sumUser = known.reduce((s, r) => s + ((r.userQuota && r.userQuota.remaining) || 0), 0);
      // 共享池合计只加「可用且不是不限量」的账号——不限量（cap=-1）没有有限
      // 的剩余额可以求和，混进去会让合计看起来像个有限的数字。
      const orgRows = known.filter((r) => r.orgResourcePackage && r.orgResourcePackage.available && !r.orgResourcePackage.unlimited);
      const sumOrg = orgRows.reduce((s, r) => s + (r.orgResourcePackage.remaining || 0), 0);
      // 即将过期的批次：本地账本 + **先领先扣推算**（2026-11-01 起）。
      // 「领取额」不随消耗变——上游无逐批余额，一直显示它就是「都用完了
      // 还挂着」的假数字。总余额（addOnQuota.remaining）是上游权威值，
      // 按先领先扣分配回批次后，窗口内批次的推算剩余之和才是「快过期
      // 积分」的真实口径（grants.estimateRemaining）。
      const grants = require('../../qoder/grants');
      const now = Date.now();
      const SOON_MS = 7 * 86400000;
      const expiring = grants.expiring({ withinMs: SOON_MS, now });
      const allGrants = grants.readAll();
      // 每账号：未过期批次 ← 该账号 remaining 的推算分配。
      // 任一账号 remaining 拿不到就整体回落领取额口径（混合口径更误导）。
      const estByAccount = new Map();
      let estOk = rows.length > 0;
      for (const r of rows) {
        const rem = r.addOnQuota ? r.addOnQuota.remaining : null;
        if (!Number.isFinite(rem)) { estOk = false; continue; }
        const bs = allGrants.filter((g) => g.accountId === r.id && g.expiresAt && g.expiresAt > now);
        estByAccount.set(r.id, grants.estimateRemaining(bs, rem));
      }
      const estOf = (g) => {
        const m = estByAccount.get(g.accountId);
        const v = m ? m.get(g.grantId) : null;
        return v != null ? v : 0;
      };
      const grantedSum = expiring.reduce((s, r) => s + (r.amount || 0), 0);
      // 区域视图：临期批次按当前视图内的账号收窄
      const shownIds = new Set(rows.map((r) => r.id));
      const shownExpiring = region ? expiring.filter((g) => shownIds.has(g.accountId)) : expiring;
      const estSumOf = shownExpiring.reduce((s, r) => s + estOf(r), 0);
      const grantedSumShown = shownExpiring.reduce((s, r) => s + (r.amount || 0), 0);
      // 本周期扣费（P1-10）：按各账号的周期状态切分账本。多账号各是各的周期，
      // 「本周期扣费合计」= 各账号本周期之和；任一账号没有周期信息时，
      // 该账号按全量计并整体标 unbounded（把全量算成本周期是假数据）。
      const periodMod = require('../../qoder/period');
      const creditsMod = require('../../qoder/credits');
      const ledger = creditsMod.readHistory();
      const perAccountPeriod = rows.map((r) => {
        const st = periodMod.stateOf(r.id);
        const sum = periodMod.summarize(ledger, { periodStart: st ? st.periodStart : null, accountId: r.id });
        return { id: r.id, name: r.nickname, bounded: sum.bounded, ...sum };
      });
      const anyUnbounded = perAccountPeriod.some((x) => !x.bounded);
      const periodCost = perAccountPeriod.reduce((s, x) => s + x.cost, 0);
      const periodBilled = perAccountPeriod.reduce((s, x) => s + x.billedRequests, 0);
      return sendJSON(res, 200, {
        count: rows.length,
        region: region || undefined,
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
          // 团队共享池合计（只含可用且有限额的账号；不限量账号不计入）
          orgTotal: Number(sumOrg.toFixed(4)),
          orgUnlimited: known.some((r) => r.orgResourcePackage && r.orgResourcePackage.unlimited),
          exceeded: rows.filter((r) => r.isQuotaExceeded).length,
          // 7 天内到期批次：expiringAmount = **推算剩余**合计（先领先扣）；
          // expiringGrantedAmount = 领取额合计（旧口径，仅作对照）。
          // estimated=false 说明 remaining 拿不到、推不了，回落了领取额。
          expiringCount: shownExpiring.length,
          expiringAmount: Number((estOk ? estSumOf : grantedSumShown).toFixed(4)),
          expiringEstimated: estOk,
          expiringGrantedAmount: Number(grantedSumShown.toFixed(4)),
          // 本周期扣费（P1-10）。**unbounded=true 表示有账号没有周期信息**——
          // 那部分账号按全量累计计入了，界面必须标注，否则「本周期扣费」
          // 会被读成真的只花了这么多。
          period: {
            bounded: !anyUnbounded,
            cost: Number(periodCost.toFixed(4)),
            billedRequests: periodBilled,
            // 均价用 billed 口径（失败/免费帧不进分母，见 period.js 第 4 条）
            avgPerBilledRequest: periodBilled > 0
              ? Number((perAccountPeriod.reduce((s, x) => s + x.billedCost, 0) / periodBilled).toFixed(4))
              : null,
            perAccount: perAccountPeriod.map((x) => ({
              id: x.id, name: x.name, bounded: x.bounded, cost: x.cost,
              billedRequests: x.billedRequests, avg: x.avgPerBilledRequest,
            })),
          },
        },
        // 免费用户实际能用的就是 addOnQuota（签到/赠送）。写清楚避免误读。
        note: 'addOnQuota 是签到/赠送得到的积分（免费用户实际可用）；userQuota 是订阅套餐内的额度（Free 套餐恒为 0）。两者不可相加。'
          + 'period 是**本订阅周期**的扣费口径（按各账号的周期边界切分账本，均值只数计费帧）；'
          + 'bounded=false 说明有账号还没观察到周期边界——那部分按全量累计计入，别把它当成「本周期只花了这些」。',
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
      // 区域过滤（2026-11-03）：行自带 region。「国内」视图包含缺失的历史行
      // （国际版上线前只有国内账号）；「国际」只看明确 intl 的行
      const regionRaw = decodeURIComponent(((req.url.match(/[?&]region=([^&]*)/) || [])[1] || '')).toLowerCase();
      const region = regionRaw === 'intl' || regionRaw === 'global' ? 'intl' : (regionRaw === 'cn' ? 'cn' : '');
      let rows = credits.creditRecords(limit);
      if (region === 'intl') rows = rows.filter((r) => r.region === 'intl');
      else if (region === 'cn') rows = rows.filter((r) => r.region !== 'intl');
      // 汇总只统计本次返回的窗口，且不补 0——cost 为 null（上游没给 credits）
      // 的行不计入，界面要写清范围，否则「合计」会被读成全部请求的总和
      const sum = rows.reduce((s, r) => s + (r.cost || 0), 0);
      return sendJSON(res, 200, {
        limit,
        region: region || undefined,
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
        const fr = await fresh(raw);
        if (fr.error) {
          rows.push({ id: a.id, nickname: a.nickname || a.uid || `账号 ${a.id}`, region: a.region, usage: null, error: fr.error });
          continue;
        }
        const u = await session.fetchCreditUsage(fr.account.accessToken, a.region, { agent, force });
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
    // 用量分析（P2-17）：reqlog（channel=qoder）⨝ credits 账本（按 req_id）。
    //
    // 调研原文「数据源现成，纯前端聚合 + 一个聚合端点」。通用维度（按天/按
    // 模型/按 Key）已在 /usage/overview；这里补的是 **Qoder 特有的三块**：
    //   1. **按账号归因**——多账号下「哪个号烧了多少」是 FEFO/护栏调参的依据
    //   2. **积分 / 1M Token 折算**——上游直给单请求 credits，与 reqlog 的
    //      tokens 相除即可得每百万 token 的真实成本（比倍率标称值可信）
    //   3. **本周期消耗**（P1-10 口径）——累计/本周期/计费请求数/均价
    //
    // 口径：
    //   · 只统计 status 200~399 的「成功请求」进 token/延迟/速率指标——失败
    //     请求单独给 failed 计数，混进均值会把「失败了三次」读成「跑得慢」
    //   · credits 缺失（上游没给 usage.credits）的行**不补 0**：0 会被读成
    //     「没花钱」，而真相是没测到；折算比率只将有值的行为分母
    //   · 吐字速率 = output_tokens ÷ (ms/1000)，只对非零 output 与非零 ms 计算
    method: 'GET',
    path: '/usage',
    handler: async ({ req, res }) => {
      const days = Math.min(90, Math.max(1,
        parseInt((req.url.match(/[?&]days=(\d+)/) || [])[1] || '30', 10) || 30));
      const regionRaw = decodeURIComponent(((req.url.match(/[?&]region=([^&]*)/) || [])[1] || '')).toLowerCase();
      const region = regionRaw === 'intl' ? 'global' : (regionRaw === 'cn' || regionRaw === 'global' ? regionRaw : '');
      const since = Date.now() - days * 86400000;
      const reqlog = require('../../reqlog');
      const credits = require('../../qoder/credits');
      const periodMod = require('../../qoder/period');
      const authStore = require('../../qoder/auth');

      // 账号 id → 名字（账号已删的旧行如实保留 id）
      const nameOf = new Map(authStore.list().map((a) => [a.id, a.nickname || a.uid || `账号 ${a.id}`]));
      // credits 账本按 req_id 索引（与请求日志同一关联键）
      const costByReqId = credits.indexByReqId();

      const rows = reqlog.read({
        limit: 0,
        filter: (r) => r && r.channel === 'qoder'
          && r.ts >= since
          && (!region || String(r.region || '') === region),
      }).rows;

      const okRows = rows.filter((r) => r.status >= 200 && r.status < 400);
      const failed = rows.length - okRows.length;
      const msRows = okRows.filter((r) => Number(r.ms) > 0);
      const ftRows = okRows.filter((r) => typeof r.first_token_ms === 'number' && r.first_token_ms > 0);
      // 吐字速率：output 非零且 ms 非零的流式请求才有意义
      const rateRows = okRows.filter((r) => (r.output_tokens || 0) > 0 && Number(r.ms) > 0);

      const bucket = (keyOf) => {
        const m = new Map();
        for (const r of okRows) {
          const k = keyOf(r) || '(未知)';
          let c = m.get(k);
          if (!c) {
            c = { key: k, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, credits: 0, credited: 0, msTotal: 0, outputTotal: 0 };
            m.set(k, c);
          }
          c.requests++;
          c.inputTokens += r.input_tokens || 0;
          c.outputTokens += r.output_tokens || 0;
          c.totalTokens += r.total_tokens || 0;
          c.msTotal += Number(r.ms) || 0;
          c.outputTotal += r.output_tokens || 0;
          const cost = costByReqId.get(r.req_id);
          if (cost && Number.isFinite(Number(cost.credits))) {
            c.credits += Number(cost.credits);
            c.credited++;
          }
        }
        return [...m.values()].map((c) => ({
          ...c,
          credits: Math.round(c.credits * 10000) / 10000,
          // 积分 / 1M Token：真实成本密度（倍率标称值的实测对照）
          creditsPer1M: c.totalTokens > 0 && c.credited > 0
            ? Math.round((c.credits / c.totalTokens) * 1000000 * 10000) / 10000
            : null,
          avgTokPerSec: c.msTotal > 0 && c.outputTotal > 0
            ? Math.round((c.outputTotal / (c.msTotal / 1000)) * 10) / 10
            : null,
        }));
      };

      const byAccount = bucket((r) => (r.account_id != null ? String(r.account_id) : '(未标注)'))
        .map((c) => ({ ...c, name: /^\d+$/.test(c.key) ? (nameOf.get(Number(c.key)) || `账号 ${c.key}`) : c.key }))
        .sort((a, b) => b.credits - a.credits || b.totalTokens - a.totalTokens);
      const byModel = bucket((r) => r.model).sort((a, b) => b.totalTokens - a.totalTokens);

      // 按天（credits 与 tokens 同轴，前端画双系列）
      const byDayMap = new Map();
      for (const r of rows) {
        const k = credits.dayKey(r.ts);
        let d = byDayMap.get(k);
        if (!d) { d = { day: k, requests: 0, tokens: 0, credits: 0, credited: 0 }; byDayMap.set(k, d); }
        d.requests++;
        d.tokens += r.total_tokens || 0;
        const cost = costByReqId.get(r.req_id);
        if (cost && Number.isFinite(Number(cost.credits))) { d.credits += Number(cost.credits); d.credited++; }
      }
      const daily = [];
      for (let i = days - 1; i >= 0; i--) {
        const k = credits.dayKey(Date.now() - i * 86400000);
        const d = byDayMap.get(k) || { day: k, requests: 0, tokens: 0, credits: 0, credited: 0 };
        daily.push({ ...d, credits: Math.round(d.credits * 10000) / 10000 });
      }

      // 本周期消耗（P1-10 口径）：按各账号周期状态切分账本
      const ledger = credits.readHistory();
      const accounts = authStore.list().filter((a) => !region || constants.normalizeRegion(a.region) === region);
      const perAccount = accounts.map((a) => {
        const st = periodMod.stateOf(a.id);
        const s = periodMod.summarize(ledger, { periodStart: st ? st.periodStart : null, accountId: a.id });
        return {
          id: a.id, name: a.nickname || a.uid || `账号 ${a.id}`,
          bounded: s.bounded, periodStart: s.periodStart,
          cost: s.cost, billedRequests: s.billedRequests, avg: s.avgPerBilledRequest,
        };
      });
      const anyUnbounded = perAccount.some((x) => !x.bounded);

      return sendJSON(res, 200, {
        days,
        region: region || undefined,
        totals: {
          requests: rows.length,
          ok: okRows.length,
          failed,
          inputTokens: rows.reduce((s, r) => s + (r.input_tokens || 0), 0),
          outputTokens: rows.reduce((s, r) => s + (r.output_tokens || 0), 0),
          totalTokens: rows.reduce((s, r) => s + (r.total_tokens || 0), 0),
          credits: Math.round(okRows.reduce((s, r) => {
            const c = costByReqId.get(r.req_id);
            return s + (c && Number.isFinite(Number(c.credits)) ? Number(c.credits) : 0);
          }, 0) * 10000) / 10000,
          avgMs: msRows.length ? Math.round(msRows.reduce((s, r) => s + r.ms, 0) / msRows.length) : null,
          avgFirstTokenMs: ftRows.length ? Math.round(ftRows.reduce((s, r) => s + r.first_token_ms, 0) / ftRows.length) : null,
          avgTokPerSec: rateRows.length
            ? Math.round(rateRows.reduce((s, r) => s + (r.output_tokens / (r.ms / 1000)), 0) / rateRows.length * 10) / 10
            : null,
        },
        byAccount,
        byModel,
        daily,
        period: {
          bounded: !anyUnbounded,
          perAccount,
          cost: Number(perAccount.reduce((s, x) => s + x.cost, 0).toFixed(4)),
          billedRequests: perAccount.reduce((s, x) => s + x.billedRequests, 0),
        },
        note: 'credits 是上游直给的单请求扣费（只有经网关的请求有账）；折算比率只将有值的行为分母，'
          + '缺失不补 0。period 是本订阅周期口径（P1-10）——bounded=false 表示有账号没观察到周期边界，'
          + '那部分按全量累计计入。吐字速率 = output_tokens ÷ 耗时，只统计有值请求。',
      });
    },
  },
  {
    // 计费自检探针：按模型发一个小请求，把「上游实际计费倍率」与模型表
    // 标称值并排返回——上游静默改路由的可见性（融合 qoder2api-hub #113 的
    // /diag/model-billing，数据源是 billed_rate 账本）。**不做自动判定**：
    // ratio ≠ 1 不一定是改路由——错峰优惠（discountFactor）与倍率元数据
    // 过期都会造成合法偏差，判读交给看这条结果的人。
    // 探针消耗真实积分：用免费/低倍率档（qfmodel/gfmodel）即可验证。
    method: 'GET',
    path: '/billing-check',
    handler: async ({ req, res }) => {
      // 区域先解析（自动挑模型要按区域取表）：global 时选号限定国际账号——
      // 国际模型拿国内账号打必然失败，不让池子随机派
      const regionRaw = decodeURIComponent(((req.url.match(/[?&]region=([^&]*)/) || [])[1] || '')).toLowerCase();
      const region = regionRaw === 'global' || regionRaw === 'intl' ? 'global' : (regionRaw === 'cn' ? 'cn' : '');
      const credits = require('../../qoder/credits');
      const modelRaw = decodeURIComponent(((req.url.match(/[?&]model=([^&]*)/) || [])[1] || '')).replace(/^qoder\//, '').trim();
      // 标称倍率从 model-info 的归一化行取（两种上游形状都已摊平）；
      // 表不可用时 expected 如实 null——探针仍然跑，只报实测值
      let expected = null;
      let rows = null;
      try {
        rows = await require('../../model-info').qoderRows({ region });
      } catch (e) { /* 表不可用按 null */ }
      // model 缺省时自动挑默认模型（hub v1.7.20 #134：真 0 价优先，否则最小
      // 正倍率；表不可用不猜，要求显式传 model）
      let model = modelRaw;
      let autoPicked = null;
      if (!model) {
        const picked = require('../../qoder/probe-model').pickProbeModel(rows);
        if (!picked) {
          return sendJSON(res, 400, { ok: false, error: '缺 model 参数（如 ?model=qfmodel）；模型表不可用，无法自动挑选 0 价模型' });
        }
        model = picked.key;
        autoPicked = picked;
      }
      if (rows) {
        const hit = rows.find((m) => m.key === model || m.name === model);
        if (hit) {
          if (Number.isFinite(hit.rate) && hit.rate > 0) expected = hit.rate;
          else if (Number.isFinite(hit.rateOriginal) && hit.rateOriginal > 0) expected = hit.rateOriginal;
          else if (Number.isFinite(hit.rate)) expected = hit.rate;
        }
      }
      const reqId = `billcheck_${Date.now().toString(36)}`;
      const startedAt = Date.now();
      try {
        await qoder.send({
          model: `qoder/${model}`,
          messages: [{ role: 'user', content: 'reply with exactly: pong' }],
          max_tokens: 64,
        }, null, { reqId, probe: true, region: region === 'global' ? 'intl' : region });
      } catch (e) {
        return sendJSON(res, 200, {
          ok: false, model, expected, error: e.message,
          elapsedMs: Date.now() - startedAt,
        });
      }
      // capture 是同步 append，send 正常返回时已落盘——按 reqId 读回
      const row = credits.readHistory().reverse().find((r) => r.req_id === reqId) || null;
      const billed = row ? (row.billed_rate ?? null) : null;
      const ratio = billed != null && expected ? Number((billed / expected).toFixed(3)) : null;
      return sendJSON(res, 200, {
        ok: true,
        model,
        ...(autoPicked ? { auto_picked: autoPicked } : {}),
        account: row ? row.account : null,
        expected,
        billed,
        ratio,
        credits: row ? row.credits : null,
        elapsedMs: Date.now() - startedAt,
        note: 'ratio≈1 正常；≠1 不一定是改路由——错峰优惠与倍率元数据过期都会造成偏差，结合模型页的标称值人工判读。',
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
    // 主动探测模型真实输出上限（P2-20）。**触发式**，不是同步等。
    //
    // **为什么必须触发式（2026-11-08 真机实测）**：单档 `max_tokens=4096` 要
    // 214 秒（completion 24706 / reasoning 23513）。四档串行十几分钟，同步
    // HTTP 必然超时、浏览器先断。所以与 `/autocheckin/run` 同款：立刻返回
    // `started`，结果靠 `GET /output-probes` 与 `GET /output-probe/status` 轮询。
    //
    // **同一时刻只允许一个**：探测是重额度动作，并发跑等于把「最省的 0.1 档」
    // 变成四倍消耗。
    method: 'POST',
    path: '/output-probe',
    handler: async ({ res, body }) => {
      const probe = require('../../qoder/output-probe');
      const model = String((body && body.model) || '').trim().replace(/^qoder\//, '');
      if (!model) return sendJSON(res, 400, { ok: false, error: '缺少 model' });
      const region = constants.normalizeRegion((body && body.region) || 'cn');
      // 声称上限（裁阶梯用）。取不到就按 65536 探——**声称值只作参考下界**
      let claimed = null;
      try {
        const pref = authStore.preferred();
        if (pref) {
          const raw = await session.fetchModels(pref, {});
          const meta = (raw.ok ? raw.models : []).find((m) => m.key === model || m.name === model);
          if (meta && meta.maxOutputTokens) claimed = Number(meta.maxOutputTokens);
        }
      } catch (e) { /* 表不可用照探 */ }
      const r = probe.start(model, { region, modelMaxTokens: claimed });
      if (!r.started) {
        return sendJSON(res, 409, {
          ok: false, started: false, error: `已有探测在跑（${probe.status().model}），等它结束`,
          status: probe.status(),
        });
      }
      try {
        require('../auth').audit('admin', 'qoder_output_probe', `${region}/${model}`, 'started');
      } catch (e) { /* 审计失败不影响探测 */ }
      return sendJSON(res, 200, {
        ok: true, started: true, model, region,
        status: probe.status(),
        note: '已开始探测（异步）。**单档真机约 3~4 分钟**，四档串行可能十几分钟——'
          + '轮询 GET /output-probe/status 看进度，结论落 data/qoder-output-probes.json。',
      });
    },
  },
  {
    // 探测任务状态（不阻塞：只读进程内状态）
    method: 'GET',
    path: '/output-probe/status',
    handler: async ({ res }) => {
      const probe = require('../../qoder/output-probe');
      return sendJSON(res, 200, { ok: true, ...probe.status() });
    },
  },
  {
    // 已探测结论一览（本地落盘，不打上游）
    method: 'GET',
    path: '/output-probes',
    handler: async ({ res, req }) => {
      const probe = require('../../qoder/output-probe');
      const regionRaw = decodeURIComponent(((req.url.match(/[?&]region=([^&]*)/) || [])[1] || '')).toLowerCase();
      const region = regionRaw ? constants.normalizeRegion(regionRaw === 'intl' ? 'global' : regionRaw) : '';
      const doc = probe.loadProbes();
      const rows = Object.entries(doc)
        .map(([k, v]) => ({ key: k, ...v }))
        .filter((r) => !region || r.region === region)
        .map((r) => ({
          model: r.model,
          region: r.region,
          verdict: r.verdict,
          claimed: r.modelMaxTokens || null,
          actual: r.verdict === 'clamped' ? r.clamped
            : (r.verdict === 'at_least' ? r.atLeast
              : (r.verdict === 'unbounded' ? ((r.unbounded && r.unbounded.completion) || null) : null)),
          unbounded: r.unbounded || null,
          label: r.verdict === 'unbounded'
            ? `${probe.fmtK(r.unbounded && r.unbounded.completion)} ۞ 不受 max_tokens（传 ${probe.fmtK(r.unbounded && r.unbounded.requested)}）`
            : (r.verdict === 'clamped' && r.clamped
              ? `${probe.fmtK(r.clamped)} ⚠ 钳制${r.modelMaxTokens && r.modelMaxTokens / r.clamped > 1 ? ` ${Math.round((r.modelMaxTokens / r.clamped) * 10) / 10}×` : ''}`
              : (r.verdict === 'at_least' && r.atLeast ? `${probe.fmtK(r.atLeast)} ✓` : '?')),
          ts: r.ts,
          stale: probe.isStale(r),
        }))
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return sendJSON(res, 200, {
        region: region || undefined,
        count: rows.length,
        rows,
        note: '探测结果落 data/qoder-output-probes.json，30 天视为陈旧。'
          + '**没测过的模型不在此表**——没测 ≠ 没钳制，别把「表里没有」读成「没问题」。'
          + '۞ 表示上游不理 max_tokens（真机实测：传 4096 回来 24706）——'
          + '这不是「上限很大」，而是「没有可测的上限」，别再指望靠它钳制输出量。',
      });
    },
  },
  {
    // Pro 升级福利包：**只读查询**资格，不领取（一次性 +1800，不可逆）。
    // 端点不存在（活动下线）按 eligible=false 返回，不报错。
    method: 'GET',
    path: '/pro-eligibility',
    handler: async ({ res, req }) => {
      const idm = req.url.match(/[?&]id=(\d+)/);
      const id = idm ? Number(idm[1]) : null;
      const list = id ? [authStore.get(id)].filter(Boolean) : authStore.list();
      const proxyAgent = require('../../proxy-agent');
      const rows = [];
      for (const a of list) {
        const raw = authStore.get(a.id);
        const base = { id: a.id, nickname: a.nickname || a.uid || `账号 ${a.id}`, region: a.region };
        let agent = null;
        try { agent = proxyAgent.getAgentFor(raw); } catch (e) {
          rows.push({ ...base, eligible: null, error: `出站代理配置错误: ${e.message}` });
          continue;
        }
        const fr = await fresh(raw);
        if (fr.error) {
          rows.push({ ...base, eligible: null, error: fr.error });
          continue;
        }
        const r = await session.fetchProEligibility(fr.account.accessToken, a.region, { agent });
        rows.push({
          ...base,
          // null = 查不出来，不猜成「不能领」
          eligible: r.ok ? r.eligible : null,
          gone: !!(r.ok && r.gone),
          error: r.ok ? '' : (r.error || '查询失败'),
        });
      }
      return sendJSON(res, 200, {
        rows,
        note: '一次性福利包（+1800）。eligible=false 可能是已领过或活动未覆盖该账号；端点不存在时 gone=true（活动已下线）。',
      });
    },
  },
  {
    // 领取 Pro 福利包。**一次性的不可逆动作**，所以要求 body.confirm === true——
    // 防止误触把每个账号的福利一口气点掉。
    // 领取前后各取一次额度，报**到账差值**（上游只回 success，不告诉我们发了多少）。
    method: 'POST',
    path: '/pro-claim',
    handler: async ({ res, body }) => {
      if (!body || body.confirm !== true) {
        return sendJSON(res, 400, { ok: false, error: '这是一次性不可逆操作，需带 confirm: true' });
      }
      const id = body.id;
      const list = id ? [authStore.get(id)].filter(Boolean) : authStore.list();
      if (!list.length) return sendJSON(res, 200, { ok: false, error: '没有可用账号', results: [] });
      const proxyAgent = require('../../proxy-agent');
      const results = [];
      for (const a of list) {
        const raw = authStore.get(a.id);
        const base = { id: a.id, nickname: a.nickname || a.uid || `账号 ${a.id}` };
        let agent = null;
        try { agent = proxyAgent.getAgentFor(raw); } catch (e) {
          results.push({ ...base, ok: false, error: `出站代理配置错误: ${e.message}` }); continue;
        }
        // 先换票再动上游：token 过期时资格查询会 401，用户看到的就是
        // 「查询失败」，而账号本身完全正常。
        const fr = await fresh(raw);
        if (fr.error) { results.push({ ...base, ok: false, error: fr.error }); continue; }
        const acc = fr.account;
        // 先查资格：不可领就不打领取接口（已领过的账号不会有副作用，但少一次请求）
        const el = await session.fetchProEligibility(acc.accessToken, a.region, { agent });
        if (!el.ok) { results.push({ ...base, ok: false, error: el.error }); continue; }
        if (!el.eligible) { results.push({ ...base, ok: true, skipped: true, reason: el.gone ? '活动已下线' : '不可领取（可能已领过）' }); continue; }
        const before = await session.fetchQuota(acc.accessToken, a.region, { agent });
        const r = await session.claimProBenefit(acc.accessToken, a.region, { agent });
        let gained = null;
        if (r.ok && !r.already) {
          const after = await session.fetchQuota(acc.accessToken, a.region, { agent });
          if (before.ok && after.ok && before.addOnQuota && after.addOnQuota) {
            gained = Number((after.addOnQuota.remaining - before.addOnQuota.remaining).toFixed(4));
          }
        }
        results.push({
          ...base, ok: r.ok, already: !!r.already, gained,
          before: before.ok ? before.addOnQuota : null,
          error: r.ok ? '' : (r.error || '领取失败'),
        });
      }
      const okCount = results.filter((x) => x.ok && !x.skipped).length;
      try { require('../auth').audit('admin', 'qoder_pro_claim', id || 'all', `${okCount}/${results.length}`); } catch (e) { /* 审计失败不影响结果 */ }
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
    // **推算剩余（2026-11-01 起）**：amount 是领取额、不随消耗变——一直
    // 显示它就是「都用完了还挂着」的假数字。总余额（addOnQuota.remaining）
    // 是上游权威值，按「先领先扣」分配回批次（grants.estimateRemaining）
    // 得每批推算剩余。这是推算口径（上游不按批次扣费，先到先用是其标准
    // 消耗顺序），每行带 estimatedRemaining，推不出的给 null 不编数。
    method: 'GET',
    path: '/grants',
    handler: async ({ req, res }) => {
      const grants = require('../../qoder/grants');
      const days = Math.min(365, Math.max(1,
        parseInt((req.url.match(/[?&]days=(\d+)/) || [])[1] || '30', 10) || 30));
      const now = Date.now();
      const withinMs = days * 86400000;
      // 区域过滤（2026-11-03）：批次账本按账号回查区域——国际视图不该
      // 带出国内账号的批次（账号已删的旧批次按国内算，与历史口径一致）
      const regionRaw = decodeURIComponent(((req.url.match(/[?&]region=([^&]*)/) || [])[1] || '')).toLowerCase();
      const region = regionRaw === 'intl' || regionRaw === 'global' ? 'intl' : (regionRaw === 'cn' ? 'cn' : '');
      const accountRegion = new Map();
      if (region) {
        try {
          for (const a of authStore.list()) {
            accountRegion.set(a.id, constants.normalizeRegion(a.region) === 'global' ? 'intl' : 'cn');
          }
        } catch (e) { /* 账号表读不到就不按区域过滤 */ }
      }
      const regionOf = (g) => (accountRegion.get(g.accountId) || 'cn');
      let rows = grants.expiring({ withinMs, now });
      if (region) rows = rows.filter((g) => regionOf(g) === region);
      const all = grants.readAll();
      // 窗口内批次涉及的账号各打一次上游拿总余额（单 GET，快）。
      // 查不到（网络/账号缺失）记 null——该账号批次推不出，如实 null。
      const proxyAgent = require('../../proxy-agent');
      const remainingByAccount = new Map();
      for (const id of new Set(rows.map((g) => g.accountId))) {
        if (id == null) continue;
        const raw = authStore.get(id);
        if (!raw) { remainingByAccount.set(id, null); continue; }
        try {
          const agent = proxyAgent.getAgentFor(raw);
          const fr = await fresh(raw);
          if (fr.error) { remainingByAccount.set(id, null); continue; }
          const q = await session.fetchQuota(fr.account.accessToken, raw.region || 'cn', { agent });
          remainingByAccount.set(id, q.ok && q.addOnQuota ? q.addOnQuota.remaining : null);
        } catch (e) {
          remainingByAccount.set(id, null);
        }
      }
      // 每账号做先领先扣分配（只用未过期批次——已过期批次已作废）
      const estByAccount = new Map();
      for (const [id, rem] of remainingByAccount) {
        if (!Number.isFinite(rem)) continue;
        const bs = all.filter((g) => g.accountId === id && g.expiresAt && g.expiresAt > now);
        estByAccount.set(id, grants.estimateRemaining(bs, rem));
      }
      // 到期分布（P2-18）：按到期日聚合「哪天会一口气作废多少 + 到期前日均需耗量」。
      // 数据源与逐批明细同源（推算剩余），只是换了个视角——明细看不出
      // 「明天同时作废 300」这种真风险。
      const distribution = (() => {
        const withEst = all
          .filter((g) => g.expiresAt && g.expiresAt > now)
          .filter((g) => !region || regionOf(g) === region)
          .map((g) => {
            const m = estByAccount.get(g.accountId);
            const est = m ? m.get(g.grantId) : null;
            return { ...g, estimatedRemaining: est != null ? est : null };
          });
        return grants.expiryDistribution(withEst, now);
      })();
      // 每批补上派生字段（剩余天数 / 是否已过期 / 推算剩余），前端直接渲染
      const decorate = (g) => {
        const m = estByAccount.get(g.accountId);
        const est = m ? m.get(g.grantId) : null;
        return {
          grantId: g.grantId,
          accountId: g.accountId,
          accountName: g.accountName,
          campaignKey: g.campaignKey,
          // **领取额**，不是剩余额（上游不给逐批余额）
          amount: g.amount,
          // **推算剩余**（先领先扣模拟）。null = 总余额拿不到/账号不在
          // 推算范围，不是 0——0 是「按消耗顺序已用完」，两者不能混淆。
          estimatedRemaining: est != null ? est : null,
          grantedAt: g.grantedAt,
          expiresAt: g.expiresAt,
          validityDays: g.validityDays,
          modelScope: g.modelScope,
          daysLeft: g.expiresAt ? Math.max(0, Math.ceil((g.expiresAt - now) / 86400000)) : null,
          expired: !!(g.expiresAt && g.expiresAt <= now),
          // 归属核验三态（P0-2）：界面据此把「领取额」读成「真进账」还是
          // 「额度进了同一个人的另一个号」。老行没有这两个字段 —— 按
          // unverified 显示，**不默认成 claimed**（那是假数据）。
          verification: g.verification || 'unverified',
          verified: g.verified === true ? true : (g.verified === false ? false : null),
          samePerson: g.samePerson === true,
          verifyNote: g.verifyNote || '',
        };
      };
      const totalGranted = rows.reduce((s, r) => s + (r.amount || 0), 0);
      const estOf = (g) => {
        const m = estByAccount.get(g.accountId);
        const v = m ? m.get(g.grantId) : null;
        return v != null ? v : 0;
      };
      const totalEst = rows.reduce((s, r) => s + estOf(r), 0);
      // 推算完整性：窗口内批次是否**全部**拿到了推算值（有账号查询失败时
      // 整体不可信——部分推算+部分领取额的混合口径比单一口径更误导）
      const estimated = rows.length > 0 && rows.every((g) => {
        const m = estByAccount.get(g.accountId);
        return !!(m && m.get(g.grantId) != null);
      });
      // 覆盖范围：账本从功能启用时开始记，**之前领的批次查不到**（上游无回填接口）。
      // 如实报出起点，否则「账本里没有」会被读成「没有积分」。
      const since = all.length ? Math.min(...all.map((r) => r.ts || r.grantedAt || 0)) : null;
      return sendJSON(res, 200, {
        windowDays: days,
        region: region || undefined,
        rows: rows.map(decorate),
        // 已过期的批次单列——排查「为什么积分少了」时用得上（同样按区域收窄）
        expired: (region ? grants.expired({ now }).filter((g) => regionOf(g) === region) : grants.expired({ now }))
          .slice(0, 50).map(decorate),
        total: all.length,
        // 账本最早一条的时刻（null = 账本为空）。界面据此说明覆盖范围。
        since,
        // 合计是**推算剩余**（先领先扣）；expiringGrantedAmount 保留领取额
        // 口径做对照。estimated=false 时界面要标「领取额」而不是推算值。
        expiringAmount: Number(totalEst.toFixed(4)),
        expiringGrantedAmount: Number(totalGranted.toFixed(4)),
        estimated,
        // 到期分布（P2-18）：按到期日聚合。remaining 是**推算剩余**，
        // dailyNeed = 推算剩余 ÷ 剩余天数（「每天要用掉这么多才不亏」）
        distribution,
        note: '「快过期积分」= 7 天窗口内批次按**先领先扣**模拟分到的余额（总余额来自上游额度接口）。'
          + '上游不按批次扣费，逐批剩余是推算值不是上游数据；amount（领取额）是该批次领到的数量，仅作对照。'
          + (estimated ? '' : '（本次有账号总余额查询失败，界面显示的是领取额口径。）')
          + (since ? '' : '账本为空——本功能上线前领的批次无法追溯（上游没有回填接口）。'),
      });
    },
  },
  {
    // 仪表盘用：本地快照，不打上游
    method: 'GET',
    path: '/dashboard',
    handler: async ({ res, req }) => {
      // 区域过滤（2026-11-03）：国内/国际独立视图
      const regionRaw = decodeURIComponent(((req.url.match(/[?&]region=([^&]*)/) || [])[1] || '')).toLowerCase();
      const region = regionRaw === 'intl' ? 'global' : (regionRaw === 'cn' || regionRaw === 'global' ? regionRaw : '');
      const all = authStore.list().filter((a) => !region || constants.normalizeRegion(a.region) === region);
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
        region: region || undefined,
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
    // 模型锁池视图（P2-19）。本地快照，**不打上游**。
    //
    // 回答的是「Qoder 用不了是通道挂了，还是某个模型在排队」——限流早就做成
    // (账号, 模型) 粒度（`pool.applyModelSoftCooldown`），但这个状态此前**没有任何
    // 可视化面**：用户只知道「配了 dfmodel 用不了」，不知道「换 qfmodel 立刻可用」。
    //
    // 数据源是池快照的 `model_cooldowns`（只含未到期项）。**无锁定是正常态**，
    // 如实返回空数组（cleared=true），前端据此显示「所有模型均可选」。
    // 账号总数按区域视图过滤后给，这样「可选 1/2」与账号页的数字同源。
    method: 'GET',
    path: '/model-locks',
    handler: async ({ res, req }) => {
      const locks = require('../../qoder/model-locks');
      const regionRaw = decodeURIComponent(((req.url.match(/[?&]region=([^&]*)/) || [])[1] || '')).toLowerCase();
      const region = regionRaw === 'intl' ? 'global' : (regionRaw === 'cn' || regionRaw === 'global' ? regionRaw : '');
      let list = authStore.list();
      if (region) list = list.filter((a) => constants.normalizeRegion(a.region) === region);
      let snap = [];
      try { snap = require('../../pool').pool.snapshot(); } catch (e) { snap = []; }
      const out = locks.aggregateLocks(snap, {
        prefix: 'qoder:',
        total: list.length,
        now: Date.now(),
      });
      // 区域视图下把只属于另一区的锁定账号剔掉：账号 id 不在本区列表里就算别区。
      // 不剔的话 cn 视图会显示「1 个号被锁」而那个号根本不在 cn 池里。
      let models = out.models;
      let lockedAccounts = out.lockedAccounts;
      if (region) {
        const ids = new Set(list.map((a) => String(a.id)));
        const kept = [];
        for (const m of models) {
          const accs = m.accounts.filter((x) => ids.has(String(x)));
          if (!accs.length) continue;
          kept.push({ ...m, accounts: accs, accountCount: accs.length });
        }
        models = kept;
        lockedAccounts = new Set(kept.flatMap((m) => m.accounts)).size;
      }
      return sendJSON(res, 200, {
        region: region || undefined,
        models,
        cleared: models.length === 0,
        totalAccounts: out.totalAccounts,
        lockedAccounts,
        available: Math.max(0, out.totalAccounts - lockedAccounts),
        note: '模型级冷却是**按 (账号, 模型) 粒度**的：上游同一分钟一个号的 dfmodel 在排队、'
          + '另一个号的 qfmodel 可能直接可用。所以「某个模型用不了」不等于通道挂了——'
          + '换模型往往立刻可用。earliestInMs 是「最早有一个号解锁」，'
          + 'allClearInMs 才是「全池解锁」，两者别混。锁只用于调度，不代表账号健康。',
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
    // 导入 PAT（pt- 个人访问令牌）。SSO 强制组织下设备授权会被拦，
    // PAT 是组织账号的唯一登录路。按 uid upsert：给存量账号补 PAT 走同一条路。
    method: 'POST',
    path: '/pat-import',
    handler: async ({ res, body }) => {
      const pat = body && body.pat;
      const region = (body && body.region) || 'cn';
      if (!pat) return sendJSON(res, 400, { ok: false, error: '缺少 pat' });
      const r = await session.importPat(pat, region);
      if (!r.ok) return sendJSON(res, 200, { ok: false, error: r.error });
      const saved = authStore.upsert(r.account);
      try { require('../auth').audit('admin', 'qoder_pat_import', String(saved.id), `region=${region} uid=${r.account.uid}`); } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, { ok: true, account: authStore.list().find((a) => a.id === saved.id) });
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
      // 批次十六：删除 = 移入回收站（30 天可恢复）；永久删除走 DELETE /trash/:key
      const r = require('../trash').trashAccount('qoder', params[0]);
      if (!r.ok) return sendJSON(res, 404, { error: r.error });
      try { require('../auth').audit('admin', 'qoder_account_delete', params[0]); } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, { ok: true, trashed: true, name: r.name });
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
