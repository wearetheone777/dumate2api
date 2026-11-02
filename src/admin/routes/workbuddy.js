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
      });
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
    method: 'GET',
    path: '/credits',
    handler: async ({ res, req }) => {
      const region = regionOf(req.url || '');
      const proxyAgent = require('../../proxy-agent');
      const rows = [];
      const all = authStore.findUsable().filter((a) => !region || constants.normalizeRegion(a.region) === region);
      for (const raw of all) {
        const a = await authStore.ensureFresh(raw);
        let agent = null;
        try { agent = proxyAgent.getAgentFor(a); } catch (e) {
          rows.push({ id: a.id, nickname: a.nickname || a.uid || `账号 ${a.id}`, region: a.region, error: `出站代理配置错误: ${e.message}` });
          continue;
        }
        const st = await billing.checkinStatus(a.region, a).catch((e) => ({ ok: false, error: e.message }));
        const q = await billing.fetchCredits(a.region, a).catch((e) => ({ ok: false, error: e.message }));
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
          // 额度包：total 是各套餐剩余之和；明细给界面拆
          total: q.ok ? q.total : null,
          packages: q.ok ? q.packages : [],
          lastCheckin: a.lastCheckin || null,
          error: [st.ok ? '' : (st.unsupported ? '' : st.error), q.ok ? '' : q.error].filter(Boolean).join('；'),
        });
      }
      const known = rows.filter((r) => r.total != null);
      return sendJSON(res, 200, {
        count: rows.length,
        region: region || undefined,
        rows,
        summary: {
          total: rows.length,
          valid: rows.filter((r) => !r.error).length,
          checkedIn: rows.filter((r) => r.checkedIn === true).length,
          unknown: rows.length - known.length,
          remainTotal: Number(known.reduce((s, r) => s + (r.total || 0), 0).toFixed(2)),
        },
      });
    },
  },
  {
    // 手动签到：幂等，已签的自动跳过；国际版明确报「不支持」
    method: 'POST',
    path: '/checkin',
    handler: async ({ res, body }) => {
      const id = body && body.id;
      const list = id ? [authStore.get(id)].filter(Boolean) : authStore.findUsable();
      if (!list.length) return sendJSON(res, 200, { ok: false, error: '没有可用账号' });
      const out = [];
      for (const a of list) {
        const r = await wb.checkin(a);
        out.push({ id: a.id, nickname: a.nickname || a.uid || '', region: a.region, ...r });
        if (r.ok && !r.already) authStore.patch(a.id, { lastCheckin: Date.now(), lastError: '' });
      }
      const okCount = out.filter((r) => r.ok).length;
      try { require('../auth').audit('admin', 'workbuddy_checkin', id || 'all', `${okCount}/${out.length}`); } catch (e) { /* 审计失败不影响结果 */ }
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
      const a = authStore.patch(params[0], fields);
      if (!a) return sendJSON(res, 404, { error: '账号不存在' });
      try { require('../auth').audit('admin', 'workbuddy_account_patch', params[0], JSON.stringify(fields)); } catch (e) { /* 审计失败不影响结果 */ }
      return sendJSON(res, 200, { ok: true, account: authStore.list().find((x) => x.id === a.id) });
    },
  },
];

module.exports = { routes };
