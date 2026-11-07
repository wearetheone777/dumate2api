// src/admin/alerts.js - 运维告警评估器（调研 P1-6 的规则层）
//
// 已有闭环：`notify.js`（五种 webhook）+ `keepalive` 轮末 crit 推送。
// 这里补的是**规则层**：七类规则、静默窗、迟滞、恢复 resolved_at。
// 保持只读评估：不打上游、不改账号池；投递由调用方（admin/routes/alerts.js）
// 走 notify.sendNotify，测试可注入假 sender。
//
// 判据全部来自本地事实（日志行、账号记录、池状态、任务轮结果），
// 余额/状态未知一律不算告警（不猜 0）。
const fs = require('fs');
const path = require('path');

const FILE = 'alerts-state.json';
const RULES = ['pool_empty', 'task_failed', 'token_expiring', 'error_rate', 'key_burst', 'off_hours', 'budget'];
/** 仅提示、不计入「待处理」与推送的规则（info 级） */
const HINT_RULES = ['off_hours'];

function dataDir() {
  return process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
}
function filePath() { return path.join(dataDir(), FILE); }

function defaults() {
  return {
    minUsable: 1,            // pool_empty：可用账号少于该值
    taskFailStreak: 2,       // task_failed：连续失败轮数
    tokenWarnHours: 24,      // token_expiring：refresh token 剩余寿命
    errorRate: 0.5,          // error_rate：窗口内失败占比
    errorMinRequests: 5,     // error_rate：样本不足不判
    keyBurst: 500,           // key_burst：单 Key 窗口请求数
    offHoursStart: 1,        // off_hours：本地 [start, end) 时段
    offHoursEnd: 6,
    budget: 1000000,         // budget：窗口 token 预算（0 = 关）
    windowMs: 3600000,       // 指标回看窗口
    silenceMs: 3600000,      // 同一规则+对象静默窗
    hysteresis: 2,           // 连续 N 轮触发才告警，M 轮正常才恢复
  };
}

function hourOf(ts) { return new Date(Number(ts) || Date.now()).getHours(); }

function within(rows, now, windowMs) {
  const since = now - windowMs;
  return (rows || []).filter((r) => r && Number(r.ts) >= since && Number(r.ts) <= now);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(filePath(), 'utf8')); }
  catch (e) { return { active: {}, lastSent: {}, streaks: {} }; }
}

function saveState(s) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const p = filePath();
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/** 纯函数：事实快照 → 候选告警（不含静默/迟滞，便于离线断言） */
function evaluate(facts, cfg = {}, now = Date.now()) {
  const c = { ...defaults(), ...cfg };
  const out = [];
  const push = (rule, obj, level, message) => out.push({
    id: `${rule}:${obj}`, rule, object: obj, level, message, at: now,
  });
  const channels = facts.channels || {};
  for (const [channel, n] of Object.entries(channels)) {
    if (Number.isFinite(Number(n)) && Number(n) < c.minUsable) {
      push('pool_empty', channel, 'crit', `可用账号 ${n} 个，低于阈值 ${c.minUsable}`);
    }
  }
  const taskStreak = Number(facts.taskFailStreak) || 0;
  if (taskStreak >= c.taskFailStreak) {
    push('task_failed', 'task-scheduler', 'warn', `任务连续失败 ${taskStreak} 轮`);
  }
  for (const a of facts.accounts || []) {
    const exp = Number(a && a.refreshExpiresAt);
    if (Number.isFinite(exp) && exp > now && exp - now <= c.tokenWarnHours * 3600000) {
      push('token_expiring', `${a.channel || ''}:${a.id}`, 'warn',
        `refresh token ${Math.ceil((exp - now) / 3600000)} 小时后到期，需重新登录`);
    }
  }
  const rows = within(facts.requests, now, c.windowMs);
  if (rows.length >= c.errorMinRequests) {
    const failed = rows.filter((r) => Number(r.status) >= 400 || !Number(r.status)).length;
    if (failed / rows.length >= c.errorRate) {
      push('error_rate', 'gateway', 'warn', `近一小时失败 ${failed}/${rows.length}（阈值 ${Math.round(c.errorRate * 100)}%）`);
    }
  }
  const byKey = new Map();
  for (const r of rows) {
    if (r.key_id == null) continue;
    byKey.set(String(r.key_id), (byKey.get(String(r.key_id)) || 0) + 1);
  }
  for (const [keyId, n] of byKey) {
    if (n >= c.keyBurst) push('key_burst', keyId, 'warn', `单 Key 近一小时 ${n} 次请求（疑似泄露）`);
  }
  const hour = hourOf(now);
  if (hour >= c.offHoursStart && hour < c.offHoursEnd && rows.length > 0) {
    // **级别是 info，不是 warn**（2026-11-08 修正）：个人自用时深夜用一下是常态，
    // 一旦计入「活跃告警」并点亮侧栏角标，它会天天常亮——正是 notify.js 头注释
    // 说的「狼来了」。info 不进侧栏计数、不参与推送，只在评估结果里如实列出。
    push('off_hours', 'gateway', 'info', `非工作时段仍有 ${rows.length} 次请求`);
  }
  if (c.budget > 0) {
    const tokens = rows.reduce((s, r) => s + (Number(r.total_tokens) || 0), 0);
    if (tokens >= c.budget) push('budget', 'gateway', 'warn', `近一小时 ${tokens} tokens，达到预算 ${c.budget}`);
  }
  return out;
}

/** 带静默窗 + 迟滞 + 恢复记录的一次评估（落盘状态；opts.io 可注入测试） */
function assess(facts, opts = {}) {
  const cfg = { ...defaults(), ...(opts.config || {}) };
  const now = Number(opts.now) || Date.now();
  const io = opts.io || { load: loadState, save: saveState };
  const st = io.load() || { active: {}, lastSent: {}, streaks: {} };
  st.active = st.active || {}; st.lastSent = st.lastSent || {}; st.streaks = st.streaks || {};
  const candidates = new Map(evaluate(facts, cfg, now).map((a) => [a.id, a]));
  const notify = [];
  const resolved = [];
  const ids = new Set([...Object.keys(st.streaks), ...Object.keys(st.active), ...candidates.keys()]);
  for (const id of ids) {
    const hit = candidates.get(id);
    const streak = hit ? (Number(st.streaks[id]) || 0) + 1 : 0;
    if (hit) st.streaks[id] = streak;
    else delete st.streaks[id];
    if (hit && streak >= cfg.hysteresis) {
      const last = Number(st.lastSent[id]) || 0;
      // 0 = 从未推送过：不受静默窗约束。按 epoch 时间戳直接比较会把
      // 第一次触发视为「N 年前发过」，迟滞满足后反而永远不推。
      if (!last || now - last >= cfg.silenceMs) {
        st.lastSent[id] = now;
        st.active[id] = { ...hit, notified_at: now };
        // **info 级只进 active，不进 notify**：它是「提示」不是「告警」。
        // 推消息与点侧栏红色的门槛必须一致——off_hours 这类每条深夜请求都会
        // 命中的规则若参与推送，就是 notify.js 头注释里说的「狼来了」。
        if (hit.level !== 'info') notify.push(hit);
      }
    }
    // 恢复：连续 M 轮没有命中才写 resolved_at（避免瞬时抖动反复报恢复）
    if (!hit && st.active[id]) {
      const gone = (Number(st.active[id].clear_streak) || 0) + 1;
      if (gone >= cfg.hysteresis) {
        resolved.push({ id, resolved_at: now, rule: st.active[id].rule, object: st.active[id].object });
        delete st.active[id];
      } else st.active[id].clear_streak = gone;
    }
    if (hit && st.active[id]) st.active[id].clear_streak = 0;
  }
  io.save(st);
  const all = Object.values(st.active);
  return {
    notify,
    resolved,
    // active 里 info 级是提示（off_hours），warn/crit 才是要认真处理的告警。
    // 界面的「活跃告警」计数与侧栏角标应当只看后者，否则深夜用一次就常亮。
    active: all,
    actionable: all.filter((a) => a.level !== 'info'),
    candidates: [...candidates.values()],
  };
}

module.exports = { RULES, HINT_RULES, defaults, evaluate, assess, loadState, saveState, FILE, filePath };
