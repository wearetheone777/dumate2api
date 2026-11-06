// src/admin/routes/keepalive.js - 保活排程管理 + 账号健康预警（2026-11-06 清单项）
//
// 两个端点：
//   GET /health   聚合三个内存快照（keepalive 排程态 + web-pool 账号行 +
//                 保活轮 results），输出统一 alerts[] 供仪表盘横幅着色。
//                 **纯只读、零上游调用**——数据全部来自进程内状态与最近
//                 一次保活轮结果，绝不因为打开页面就去打上游（billing-check
//                 探针伤号的教训）。
//   GET /config   保活排程当前配置（enabled/时点/jitter/warn_hours）。
//   PUT /config   改配置（复用 keepalive.configure 的白名单校验），即时生效。
//
// 判据本体是 keepalive.internals.healthAlerts（纯函数，可离线测）。
const keepalive = require('../../keepalive');
const webPool = require('../../web-pool');
const { sendJSON } = require('../router');

// web-pool.snapshot() 的行很宽（池状态机全量字段）——health 只挑横幅要用的，
// 顺带把时间戳转 ISO，前端 dayjs 直接吃。
function slimAccount(a) {
  return {
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    state: a.state,
    cooling: a.cooling,
    cool_remaining_s: a.cool_remaining_s,
    cooldown_reason: a.cooldown_reason || '',
    disabled: a.disabled,
    disabled_reason: a.disabled_reason || '',
    token_expires_in_s: a.token_expires_in_s,
    ok_count: a.ok_count,
    fail_count: a.fail_count,
    last_error: a.last_error || '',
  };
}

const routes = [
  {
    method: 'GET',
    path: '/health',
    handler: async ({ res }) => {
      const ka = keepalive.snapshot();
      let webAccounts;
      try { webAccounts = webPool.snapshot(); } catch (e) { webAccounts = []; }
      const alerts = keepalive.internals.healthAlerts({ ka, webAccounts });

      const last = ka.last_result;
      sendJSON(res, 200, {
        ok: true,
        summary: {
          crit: alerts.filter((a) => a.level === 'crit').length,
          warn: alerts.filter((a) => a.level === 'warn').length,
          accounts: webAccounts.length,
          enabled: webAccounts.filter((a) => a.enabled).length,
          healthy: webAccounts.filter((a) => a.enabled && !a.cooling && !a.disabled).length,
        },
        alerts,
        web: webAccounts.map(slimAccount),
        keepalive: {
          enabled: ka.enabled,
          hour: ka.hour,
          minute: ka.minute,
          warn_hours: ka.warn_hours,
          running: ka.running,
          // ISO 化：前端展示「下次运行 / 上次运行」直接格式化
          next_run_at: ka.next_run_at ? new Date(ka.next_run_at).toISOString() : null,
          last_run_at: ka.last_run_at ? new Date(ka.last_run_at).toISOString() : null,
          last_run_ok: last ? !last.aborted && !last.error : null,
          last_results: last && Array.isArray(last.results) ? last.results : [],
        },
      });
    },
  },
  {
    method: 'GET',
    path: '/config',
    handler: async ({ res }) => {
      const s = keepalive.snapshot();
      sendJSON(res, 200, {
        ok: true,
        config: {
          enabled: s.enabled,
          hour: s.hour,
          minute: s.minute,
          jitter_minutes: s.jitter_minutes,
          warn_hours: s.warn_hours,
          sem_cap: s.sem_cap,
          per_account_delay_ms: s.per_account_delay_ms,
          balance_threshold: s.balance_threshold,
          checkin: s.checkin,
        },
      });
    },
  },
  {
    method: 'PUT',
    path: '/config',
    handler: async ({ res, body }) => {
      try {
        keepalive.configure(body || {});
        keepalive.schedule();
        sendJSON(res, 200, { ok: true });
      } catch (e) {
        sendJSON(res, 400, { ok: false, error: e.message });
      }
    },
  },
  {
    // 立即跑一轮（「保活 + 签到 + 余额 + 解冻」闭环）。**触发式而非等待式**：
    // 一轮可能跑几十秒到几分钟（账号串行 + 余额阶段），同步 await 会把
    // HTTP 请求挂到超时。这里只负责点火，结果靠 GET /health 的 running /
    // last_run_at / last_results 轮询——前端保存按钮的反馈链路就是这么接的。
    method: 'POST',
    path: '/run',
    handler: async ({ res }) => {
      keepalive.runOnce('manual').then((r) => {
        if (r && r.skipped) console.log('[keepalive] 手动触发被跳过：', r.skipped);
      }).catch(() => { /* 轮内失败已落 last_result */ });
      sendJSON(res, 200, { ok: true, started: true });
    },
  },
];

module.exports = { routes };
