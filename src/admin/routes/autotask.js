// src/admin/routes/autotask.js - 自动签到定时任务
//
// 签到是幂等的（当天已签就跳过），所以定时任务的安全边界是「多跑无害」。
// 抽奖不同——它消耗次数且不可逆，所以只提供手动触发，不做定时。
const accounts = require('../../accounts');
const { doCheckin } = require('./accounts');
const { sendJSON } = require('../router');
const { readJSON, writeJSON } = require('../store');

const CONFIG_FILE = 'auto-checkin.json';
const DEFAULT_HOUR = parseInt(process.env.DUMATE_AUTO_CHECKIN_HOUR || '9', 10);
const DEFAULT_MINUTE = parseInt(process.env.DUMATE_AUTO_CHECKIN_MINUTE || '17', 10);

// 配置要落盘：定时器本身只活在进程内，重启后得知道上次开没开、几点跑
function loadConfig() {
  const saved = readJSON(CONFIG_FILE, null) || {};
  return {
    enabled: !!saved.enabled,
    hour: Number.isInteger(saved.hour) ? saved.hour : DEFAULT_HOUR,
    minute: Number.isInteger(saved.minute) ? saved.minute : DEFAULT_MINUTE,
  };
}

function saveConfig() {
  writeJSON(CONFIG_FILE, {
    enabled: state.enabled,
    hour: state.hour,
    minute: state.minute,
    updated_at: Date.now(),
  });
}

let state = {
  ...loadConfig(),
  last_run_at: null,
  last_result: null,
  next_run_at: null,
  running: false,
};

let timer = null;

function nextRunAt() {
  const now = new Date();
  const t = new Date(now);
  t.setHours(state.hour, state.minute, 0, 0);
  // 今天的时间点已过就顺延到明天
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

function schedule() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!state.enabled) { state.next_run_at = null; return; }

  state.next_run_at = nextRunAt();
  const delay = state.next_run_at - Date.now();
  timer = setTimeout(async () => {
    await runOnce('scheduled');
    schedule();   // 跑完排下一次
  }, delay);
  // 定时器不应阻止进程退出
  if (timer.unref) timer.unref();
}

async function runOnce(trigger) {
  if (state.running) return { skipped: 'already_running' };
  state.running = true;
  try {
    const targets = accounts.load().accounts.filter((a) => a.enabled);
    const results = await Promise.all(targets.map((a) => doCheckin(a)));
    const ok = results.filter((r) => r.ok).length;
    state.last_run_at = Date.now();
    state.last_result = {
      trigger,
      total: results.length,
      ok_count: ok,
      fail_count: results.length - ok,
      results,
    };
    require('../../admin/auth').audit('system', 'auto_checkin', '', `${ok}/${results.length} (${trigger})`);
    return state.last_result;
  } finally {
    state.running = false;
  }
}

const routes = [
  {
    method: 'GET',
    path: '',
    handler: ({ res }) => sendJSON(res, 200, {
      enabled: state.enabled,
      hour: state.hour,
      minute: state.minute,
      last_run_at: state.last_run_at,
      last_result: state.last_result,
      next_run_at: state.next_run_at,
      running: state.running,
      // 说明安全边界，避免误以为抽奖也会自动跑
      note: '自动签到每日执行一次（幂等，重复执行无副作用）。抽奖消耗次数且不可逆，仅支持手动触发。',
    }),
  },
  {
    method: 'POST',
    path: '',
    handler: ({ res, body }) => {
      if (body && body.enabled !== undefined) state.enabled = !!body.enabled;
      if (body && body.hour !== undefined) {
        const h = parseInt(body.hour, 10);
        if (!Number.isInteger(h) || h < 0 || h > 23) {
          return sendJSON(res, 400, { error: 'hour 需为 0-23' });
        }
        state.hour = h;
      }
      if (body && body.minute !== undefined) {
        const m = parseInt(body.minute, 10);
        if (!Number.isInteger(m) || m < 0 || m > 59) {
          return sendJSON(res, 400, { error: 'minute 需为 0-59' });
        }
        state.minute = m;
      }
      schedule();
      saveConfig();
      require('../../admin/auth').audit('admin', 'auto_checkin_config',
        state.enabled ? 'on' : 'off', `${state.hour}:${String(state.minute).padStart(2, '0')}`);
      return sendJSON(res, 200, {
        enabled: state.enabled,
        hour: state.hour,
        minute: state.minute,
        next_run_at: state.next_run_at,
      });
    },
  },
  {
    // 立即跑一次，用于验证配置是否正确
    method: 'POST',
    path: '/run-now',
    handler: async ({ res }) => {
      const r = await runOnce('manual');
      return sendJSON(res, 200, r);
    },
  },
  // ── keepalive 保活与余额联动（施工包 B / GAP F2 的管理面）──
  // 排程器本体在本进程（task-scheduler.schedule() 唤醒 keepalive.schedule()），
  // 配置端点必须与排程同进程，改完 configure() 内部会立刻重排。
  {
    method: 'GET',
    path: '/keepalive',
    handler: ({ res }) => {
      const keepalive = require('../../keepalive');
      return sendJSON(res, 200, { ok: true, ...keepalive.snapshot() });
    },
  },
  {
    method: 'POST',
    path: '/keepalive',
    handler: ({ res, body }) => {
      const keepalive = require('../../keepalive');
      try {
        keepalive.configure(body || {});
      } catch (e) {
        return sendJSON(res, 400, { ok: false, error: e.message });
      }
      const s = keepalive.snapshot();
      require('../../admin/auth').audit('admin', 'keepalive_config',
        s.enabled ? 'on' : 'off', `${s.hour}:${String(s.minute).padStart(2, '0')} jitter=${s.jitter_minutes}m`);
      return sendJSON(res, 200, { ok: true, ...s });
    },
  },
  {
    // 立即跑一轮完整闭环（保活刷新 → 签到 → 查余额 → 解冻）
    method: 'POST',
    path: '/keepalive/run-now',
    handler: async ({ res }) => {
      const keepalive = require('../../keepalive');
      const r = await keepalive.runOnce('manual');
      require('../../admin/auth').audit('admin', 'keepalive_run', '', `${r.accounts || 0} 号，解冻 ${r.unfrozen_count || 0}`);
      return sendJSON(res, 200, r);
    },
  },
  // ── 低频余额刷新（2026-11-07 融合项 P1-5，本体在 src/balance-refresh.js）──
  // 轻量读接口轮询 + FEFO 快照 + 冷却解冻；与 keepalive（每日全量闭环）分工。
  // 端点挂在 /auto-checkin 前缀下——保号类运维聚在一处，端点形态与 keepalive 同款。
  {
    method: 'GET',
    path: '/balance-refresh',
    handler: ({ res }) => sendJSON(res, 200, { ok: true, ...require('../../balance-refresh').snapshot() }),
  },
  {
    method: 'POST',
    path: '/balance-refresh',
    handler: ({ res, body }) => {
      const br = require('../../balance-refresh');
      try { br.configure(body || {}); } catch (e) {
        return sendJSON(res, 400, { ok: false, error: e.message });
      }
      const s = br.snapshot();
      require('../../admin/auth').audit('admin', 'balance_refresh_config',
        s.enabled ? 'on' : 'off', `${s.minutes}min`);
      return sendJSON(res, 200, { ok: true, ...s });
    },
  },
  {
    method: 'POST',
    path: '/balance-refresh/run-now',
    handler: async ({ res }) => {
      const br = require('../../balance-refresh');
      const r = await br.runOnce('manual');
      require('../../admin/auth').audit('admin', 'balance_refresh_run', '',
        `${r.ok_count || 0}/${r.accounts || 0}，解冻 ${r.unfrozen_count || 0}`);
      return sendJSON(res, 200, r);
    },
  },
];

module.exports = { routes, schedule, state };
