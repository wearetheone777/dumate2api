// src/admin/routes/alerts.js - 运维告警配置 / 规则预览 / 立即评估
//
// 调研 P1-6。规则评估器在 ../alerts.js，投递复用 ../notify.js（已有五种
// webhook 与配置端点 /keepalive/notify）。这里只挂管理端点：
//   GET  /api/admin/alerts          规则、当前活跃告警、配置
//   PUT  /api/admin/alerts/config   更新阈值（管理员写，走审计）
//   POST /api/admin/alerts/evaluate 立即评估一轮（可选推送）
//
// 评估数据源：本地请求日志 + 四通道账号列表 + task-scheduler 最近结果。
// 全部只读；推送开关默认关闭（body.notify=true 才打 webhook）。
const { sendJSON } = require('../router');
const alerts = require('../alerts');
const reqlog = require('../../reqlog');
const notify = require('../../notify');
const { CHANNELS } = require('../../channels');
const taskScheduler = require('../../task-scheduler');

const CONFIG_FILE = 'alerts-config.json';
const { readJSON, writeJSON } = require('../store');

function config() {
  const saved = readJSON(CONFIG_FILE, {}) || {};
  return { ...alerts.defaults(), ...saved };
}

function accountFacts() {
  const out = [];
  for (const channel of CHANNELS) {
    let list = [];
    try {
      const store = channel === 'dumate' ? require('../../accounts') : require(`../../${channel}/auth`);
      list = typeof store.list === 'function' ? store.list() : [];
    } catch (e) { continue; }
    for (const a of list) {
      out.push({
        id: a.id, channel,
        enabled: a.enabled !== false,
        refreshExpiresAt: a.refreshExpiresAt || null,
        expiresAt: a.expiresAt || null,
      });
    }
  }
  return out;
}

function facts(cfg, now = Date.now()) {
  const requests = reqlog.read({ limit: 0, filter: (r) => Number(r.ts) >= now - cfg.windowMs }).rows;
  const accounts = accountFacts();
  const channels = {};
  for (const channel of CHANNELS) {
    // 启用且有凭证的账号数；没有登录态字段的通道按 enabled 计
    channels[channel] = accounts.filter((a) => a.channel === channel && a.enabled !== false).length;
  }
  const last = taskScheduler.state.last_result;
  // 连续失败轮数：任务轮结果只有最近一轮，按「本轮有失败」记 1；
  // 真正的连续 N 轮由 alerts.assess 的迟滞状态跨轮累计（阈值默认 2）。
  const streak = last && Array.isArray(last.results) && last.results.some((r) => r && r.ok === false) ? 1 : 0;
  return { channels, accounts, requests, taskFailStreak: streak };
}

async function deliver(list) {
  const results = [];
  for (const a of list) {
    const r = await notify.sendNotify(`【dumate2api 运维告警】${a.rule} / ${a.object}\n${a.message}`);
    results.push({ id: a.id, ok: !!r.ok, error: r.error || '' });
  }
  return results;
}

// 后台评估排程：**默认关闭**（与 keepalive / balance-refresh 同纪律，新排程
// 不悄悄自启）。DUMATE_ALERTS_SCHEDULE_MINUTES=5 才每 5 分钟自己评估一轮；
// notify 未配置时只更新活跃告警状态，不打任何外部请求。
const SCHEDULE_MINUTES = Math.max(0, parseInt(process.env.DUMATE_ALERTS_SCHEDULE_MINUTES || '0', 10) || 0);
let timer = null;

function tick() {
  const cfg = config();
  const out = alerts.assess(facts(cfg), { config: cfg });
  if (out.notify.length && notify.loadConfig().enabled) {
    deliver(out.notify).catch(() => { /* 推送失败不拖挂下一轮 */ });
  }
  return out;
}

function schedule() {
  stop();
  if (!(SCHEDULE_MINUTES > 0)) return;
  timer = setInterval(() => {
    try { tick(); } catch (e) { console.warn('[alerts] 规则评估失败:', e.message); }
  }, SCHEDULE_MINUTES * 60000);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

const routes = [
  {
    method: 'GET',
    path: '',
    handler: ({ res }) => {
      let active = [];
      try { active = Object.values(alerts.loadState().active || {}); } catch (e) { /* 无状态文件 */ }
      // actionable = 需要人处理的（warn/crit）；hints = 仅提示（info，如 off_hours）。
      // 侧栏角标与「待办」类计数只该用前者——把提示也计入，深夜自己用一下
      // 就会常亮红灯（notify.js 头注释说的「狼来了」）。
      return sendJSON(res, 200, {
        rules: alerts.RULES,
        hint_rules: alerts.HINT_RULES,
        config: config(),
        active,
        actionable: active.filter((a) => a.level !== 'info'),
        hints: active.filter((a) => a.level === 'info'),
        notify_enabled: !!notify.loadConfig().enabled,
        schedule_minutes: SCHEDULE_MINUTES,
        schedule_active: !!timer,
        note: '规则只读本地事实；余额/状态未知不猜 0。info 级（非工作时段）只提示、不计入待办、不推送。推送走 /keepalive/notify 的 webhook 配置。',
      });
    },
  },
  {
    method: 'PUT',
    path: '/config',
    handler: ({ res, body, user }) => {
      const patch = {};
      for (const [k, v] of Object.entries(body || {})) {
        if (!(k in alerts.defaults())) continue;   // 未知键丢弃，不静默写进配置
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return sendJSON(res, 400, { error: `${k} 必须是非负数字` });
        patch[k] = n;
      }
      const next = { ...config(), ...patch };
      writeJSON(CONFIG_FILE, next);
      try { require('../auth').audit(user && user.username, 'alerts_config', '', JSON.stringify(patch)); } catch (e) { /* 审计不影响 */ }
      return sendJSON(res, 200, { ok: true, config: next });
    },
  },
  {
    method: 'POST',
    path: '/evaluate',
    handler: async ({ res, body }) => {
      const cfg = config();
      const out = body && body.auto === true ? tick() : alerts.assess(facts(cfg), { config: cfg });
      // 手动评估且显式要求推送时才打 webhook；后台 tick 自己按 notify 配置决定
      const delivered = body && body.auto !== true && body.notify === true ? await deliver(out.notify) : (out.delivered || []);
      try { require('../auth').audit('admin', 'alerts_evaluate', '', `notify=${delivered.length}`); } catch (e) { /* 忽略 */ }
      return sendJSON(res, 200, { ...out, delivered });
    },
  },
];

module.exports = { routes, facts, tick, schedule, stop };
