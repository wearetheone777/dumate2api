// src/admin/routes/trae-runtime.js - TRAE 运行期开关与管理端点
//
// 调研 P0-3（降级）/ P0-5（Max）/ P2-13（积分优先）/ P2-16（护栏）/
// P2-20（全站暂停）共用此入口。写操作需要 admin（router.handle 统一判定）。
//
// 配置本身在 src/trae-runtime.js（跨进程热读），这里只做：
//   - 字段级校验与审计（未知键在 Store 里 400，不静默丢弃）
//   - /status 把运行态与账号/模型事实并排给出（界面不用拼四份响应）
//   - /max-mode/models 按 descriptor 过滤，支持「一键加入白名单」
const { sendJSON } = require('../router');
const runtime = require('../../trae-runtime');
const models = require('../../traework/models');
const authStore = require('../../traework/auth');

function regionOf(req) {
  const raw = decodeURIComponent((String(req.url || '').match(/[?&]region=([^&]*)/) || [])[1] || '').toLowerCase();
  return raw === 'intl' ? 'intl' : 'cn';
}

/** 账号健康汇总（P1-10 的 TRAE 数据源）：只读本地落盘，不打上游 */
function accountStatus() {
  const rows = authStore.list();
  const now = Date.now();
  const needRelogin = rows.filter((a) => a.refreshExpiresAt && now >= a.refreshExpiresAt).length;
  const exhausted = rows.filter((a) => a.credits != null && a.credits <= 0).length;
  const pausedModel = rows.filter((a) => a.modelEnabled === false).length;
  const disabled = rows.filter((a) => a.enabled === false).length;
  // 池里的硬冷却/熔断：用只读快照，不为不存在的 uid 创建状态行
  const snap = require('../../pool').pool.snapshot();
  const byUid = new Map(snap.map((s) => [String(s.id), s]));
  const cooling = rows.filter((a) => {
    const st = byUid.get(require('../../channel-pool').uidOf('traework', a.id));
    return !!(st && (st.cooling || st.state === 'disabled' || st.state === 'paused'));
  }).length;
  return {
    total: rows.length, enabled: rows.filter((a) => a.enabled).length,
    needRelogin, exhausted, pausedModel, disabled, cooling,
    // 额度未知不进「耗尽」计数，单独给出来（0 与取不到是两件事）
    creditsUnknown: rows.filter((a) => a.credits == null).length,
  };
}

const routes = [
  {
    method: 'GET',
    path: '',
    handler: ({ res }) => sendJSON(res, 200, {
      file: runtime.FILE, fields: runtime.FIELDS,
      config: runtime.Load(), accounts: accountStatus(),
      note: '所有开关默认关闭；保存后网关按 mtime 热读，不需要重启。自动降级会在响应头显式带 X-Trae-Degraded。',
    }),
  },
  {
    method: 'PUT',
    path: '',
    handler: ({ res, body, user }) => {
      try {
        const config = runtime.Store(body || {});
        try { require('../auth').audit(user && user.username, 'trae_runtime_config', '', JSON.stringify(body || {})); }
        catch (e) { /* 审计失败不影响生效 */ }
        return sendJSON(res, 200, { ok: true, config });
      } catch (e) {
        return sendJSON(res, 400, { ok: false, error: e.message });
      }
    },
  },
  {
    // 支持 1M Max 的模型：只认 descriptor 显式 max_mode=true，
    // 不按名字猜、不合成 1M/936K 参数（项目既有定案）。
    method: 'GET',
    path: '/max-mode/models',
    handler: async ({ res, req }) => {
      const region = regionOf(req);
      let out = { ok: false, error: '', models: [] };
      try { out = await models.fetchModels({ region }); }
      catch (e) { out.error = e.message; }
      const supported = (out.models || []).filter((m) => m.maxMode === true).map((m) => ({
        id: m.id, name: m.name, contextWindow: m.contextWindowHard || m.contextWindow || null,
      }));
      return sendJSON(res, 200, {
        region, ok: out.ok, error: out.error || '', models: supported,
        total: (out.models || []).length,
        note: '只有上游 descriptor 显式声明 max_mode 且带输入/输出上限的模型才列出；空列表是上游未声明，不是网关未实现。',
      });
    },
  },
  {
    // 检测到的模型一键加入运行期白名单（只写名单，不改 enabled）
    method: 'POST',
    path: '/max-mode/apply',
    handler: async ({ res, req, user }) => {
      const region = regionOf(req);
      let out = { ok: false, error: '', models: [] };
      try { out = await models.fetchModels({ region }); }
      catch (e) { out.error = e.message; }
      const ids = (out.models || []).filter((m) => m.maxMode === true).map((m) => m.id);
      const config = runtime.Store({ maxMode: { models: ids } });
      try { require('../auth').audit(user && user.username, 'trae_max_mode_apply', region, `${ids.length} 个模型`); }
      catch (e) { /* 忽略 */ }
      return sendJSON(res, 200, { ok: true, region, applied: ids, config, error: out.error || '' });
    },
  },
  {
    // 当日用量护栏的实时读数（P2-16 另三项）：界面要能回答「为什么这个号
    // 被拦了」。口径与护栏判定**同一个函数**（guard.usageOf），两处各算
    // 一遍必然漂移，界面显示的用量与实际拦截依据对不上。
    method: 'GET',
    path: '/usage',
    handler: ({ res }) => {
      const guard = require('../../traework/guard');
      let usage = null;
      let error = '';
      try { usage = guard.usageNow({ channel: 'traework' }); }
      catch (e) { error = e.message; }
      let creditsByAccount = {};
      try {
        creditsByAccount = Object.fromEntries(require('../../traework/credits').creditsTodayByAccount());
      } catch (e) { /* 账本读不到就只给 token 维度 */ }
      const cfg = runtime.Load().accountGuard;
      const rows = [];
      for (const a of authStore.list()) {
        const u = usage && usage.byAccount.get(String(a.id));
        rows.push({
          id: a.id,
          name: a.nickname || a.uid || `账号 ${a.id}`,
          region: a.region || 'cn',
          tokens: u ? u.tokens : null,       // null = 今天没请求（不是 0 消耗的证据）
          requests: u ? u.requests : 0,
          credits: Object.prototype.hasOwnProperty.call(creditsByAccount, String(a.id))
            ? creditsByAccount[String(a.id)] : null,
        });
      }
      return sendJSON(res, 200, {
        ok: !error, error, day: guard.dayKey(Date.now()),
        config: cfg,
        rows,
        totals: {
          // 与账号行同口径：一条带 account_id 的记录都没有 → null（今天没数据），
          // 不是 0。行里显示「—」而合计显示 0 会让人以为「合计确实为零」，
          // 而真相是这两处都没测到东西。
          tokens: usage && usage.byAccount.size > 0 ? usage.total : null,
          // 只累加已知值：部分账号读不到时不能当成 0 求和
          credits: (() => {
            const vals = Object.values(creditsByAccount).filter((v) => Number.isFinite(v));
            // 一个账号的积分都没有 → null（同上，不把「没数据」写成 0）
            return vals.length ? Number(vals.reduce((s, v) => s + v, 0).toFixed(4)) : null;
          })(),
        },
        note: 'token 来自本进程 requests.jsonl（account_id 由 provider 上报）；积分来自 credits 账本当日增量。'
          + 'null = 今天没有该维度的记录，不等于 0。到本地零点自动重置。',
      });
    },
  },
];

module.exports = { routes, accountStatus };
