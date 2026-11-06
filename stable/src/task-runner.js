// src/task-runner.js - 任务自动跑（网页凭证，多账号）
//
// 能自动化的边界（实测确认，不是推测）：
//
//   QUERY_INPUT  可自动。任务自带 query 提示词，发一条内容匹配的消息，
//                再把 task_id 上报给 task/complete，服务端就发奖励。
//   USE_SKILL    可自动。走一次带技能的对话即可触发上报。
//   PC_PUSH      不可自动。网页端明确提示「该任务请前往桌面端或移动端完成」。
//   INVITATION   不可自动。需要真人注册。
//   INVITED      不可自动。需要别人的邀请码。
//
// 任务**不是每日重置**：重复完成会被服务端拒（code 410121 该任务次数已发放），
// 完成状态看 completed_count >= repeat_count。所以这个模块的价值在于
// 「有新任务出现时自动做完」，而不是每天刷一遍。
const accounts = require('./accounts');
const web = require('./dumate-web');
const pool = require('./web-pool');
const records = require('./records');

// 可自动完成的任务类型
const AUTO_TYPES = new Set(['QUERY_INPUT', 'USE_SKILL']);

// 每个账号的运行记录。落盘是为了让「今天跑过没」跨重启可见。
const fs = require('fs');
const path = require('path');
const DATA_DIR = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', 'data');
const LOG_FILE = 'task-runs.jsonl';

function appendLog(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // M3 账本原子追加：走 jsonl（锁内轮转 + 单次 Buffer write）
    require('./jsonl').append(path.join(DATA_DIR, LOG_FILE), `${JSON.stringify(entry)}\n`);
  } catch (e) { /* 记录失败不影响任务本身 */ }
  // 同时写进统一记录流，供「记录」页按时间轴展示
  try {
    require('./records').append({
      type: 'task',
      account_id: entry.account_id,
      account: entry.account,
      ok: entry.ok,
      task_id: entry.task_id,
      title: entry.title,
      via: entry.via || '',
      already: !!entry.already,
      task_type: entry.task_type || '',
      ms: entry.ms ?? null,
      model_ms: entry.model_ms ?? null,
      points_delta: entry.points_delta,
      points_before: entry.points_before,
      points_after: entry.points_after,
      expected_points: entry.expected_points ?? null,
      error: entry.error || '',
    });
  } catch (e) { /* 同上 */ }
}

function recentRuns(limit = 50) {
  try {
    const lines = fs.readFileSync(path.join(DATA_DIR, LOG_FILE), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse();
  } catch (e) { return []; }
}

// 为 QUERY_INPUT 任务生成一条内容匹配的消息。
// 服务端会校验消息内容与任务的 query 是否匹配（bundle 里的 matchQuery），
// 所以直接把 query 作为用户消息发出去是最稳的做法。
function buildQueryMessage(task) {
  const q = String(task.query || '').trim();
  return q || task.title || '你好';
}

// 出站 agent（E 包收口补点）：任务动作与对话同出口。配置非法抛错，调用方
// 让该账号本轮以失败收场，绝不静默回退直连。
function egress(account) {
  return { agent: web.agentFor(account) };
}

// 让指定账号「做」一个任务。
// 返回 { ok, task_id, title, error, via }
async function runTask(account, task) {
  if (!AUTO_TYPES.has(task.task_type)) {
    return { ok: false, task_id: task.task_id, title: task.title, skipped: true, error: `${task.task_type} 无法自动完成` };
  }

  const startedAt = Date.now();
  // 任务奖励的积分不在接口响应里，只能用积分余额差值测。
  // 在动作前取一次快照，完成后再取一次。
  const before = await records.pointsSnapshot(account.cookie, account);

  // QUERY_INPUT：先发一条内容匹配的消息。这一步同时满足「用一次模型」和
  // 「内容匹配」两个条件，服务端据此认定任务已完成。
  let via = 'complete-only';
  let modelMs = null; // 发消息耗时（任务里最慢的一步，通常是它）
  if (task.task_type === 'QUERY_INPUT') {
    const msg = buildQueryMessage(task);
    const t0 = Date.now();
    const r = await pool.callModel(account, '/chat/completions', 'POST', {
      model: 'model-text',
      messages: [{ role: 'user', content: msg }],
      max_tokens: 64,
    });
    modelMs = Date.now() - t0;
    // 任务链路也喂状态机:任务与用户转发用同一批账号,这里绕过了故障转移层,
    // 成败必须显式喂入（401 进防误杀计数、5xx 进熔断、成功清计数）
    if (!r.ok) {
      pool.markFailure(account.id, { status: r.status || 0, message: r.error || `HTTP ${r.status}`, model: 'model-text' });
      return { ok: false, task_id: task.task_id, title: task.title, error: `发消息失败：${r.error || ('HTTP ' + r.status)}`, model_ms: modelMs, ms: Date.now() - startedAt };
    }
    pool.markSuccess(account.id);
    via = 'query-then-complete';
  }

  // 再上报完成
  const c = await web.api.completeTask(account.cookie, task.task_id, egress(account));

  // 完成任务可能发的是抽奖次数而不是积分，所以差值可能为 0；
  // 那不代表失败，只是这次奖励的形式不是积分。
  const after = await records.pointsSnapshot(account.cookie, account);
  const pd = records.pointsDelta(before, after);

  // 任务定义里自带「该得多少奖励」，用来对照实际到账：差着就说明
  // 奖励是抽奖次数/其它形式，或者服务端没有按预期发
  const expected = task.reward_points || 0;

  if (!c.ok) {
    // 已发放不算失败——任务本来就已经完成过
    const already = c.code === 410121 || /已发放/.test(c.error || '');
    return {
      ok: already, task_id: task.task_id, title: task.title,
      already, via, ...pd,
      expected, model_ms: modelMs, ms: Date.now() - startedAt,
      task_type: task.task_type,
      error: already ? '' : c.error,
    };
  }
  return { ok: true, task_id: task.task_id, title: task.title, via, ...pd, expected, model_ms: modelMs, ms: Date.now() - startedAt, task_type: task.task_type };
}

// 跑一个账号的所有可自动任务
async function runForAccount(account) {
  const t = await web.api.tasks(account.cookie, egress(account));
  if (!t.ok) return { account_id: account.id, name: accounts.displayName(account), ok: false, error: t.error, expired: !!t.expired };

  const pending = t.tasks.filter((x) => !x.done && AUTO_TYPES.has(x.task_type));
  const skipped = t.tasks.filter((x) => !x.done && !AUTO_TYPES.has(x.task_type));

  const results = [];
  for (const task of pending) {
    // 单任务失败不该炸掉整个账号的批次——一个任务抛异常，剩余任务和
    // 其他账号就都不跑了，界面上只看到「什么都没发生」
    let r;
    try {
      r = await runTask(account, task);
    } catch (e) {
      r = { ok: false, task_id: task.task_id, title: task.title, error: e.message };
    }
    results.push(r);
    appendLog({
      ts: Date.now(), account_id: account.id, account: accounts.displayName(account),
      task_id: r.task_id, title: r.title, ok: r.ok, via: r.via,
      task_type: r.task_type || '',
      // 耗时：总耗时 + 其中发消息的耗时（QUERY_INPUT 任务的大头）
      ms: r.ms ?? null, model_ms: r.model_ms ?? null,
      // 真实积分：差值实测；expected 是任务定义声明的奖励，两者对照
      points_delta: r.delta, points_before: r.before, points_after: r.after,
      expected_points: r.expected ?? null,
      error: r.error || '',
    });
  }

  // 没有可做任务时也记一条。否则「跑过了但没事可做」和「根本没跑」
  // 在记录页看起来一样——而这两件事的含义完全不同。
  if (!pending.length) {
    appendLog({
      ts: Date.now(), account_id: account.id, account: accounts.displayName(account),
      title: skipped.length ? `无可自动任务（${skipped.length} 个需手动）` : '无可自动任务',
      ok: true, via: 'noop', noop: true,
      points_delta: 0, points_before: null, points_after: null,
      error: '',
    });
  }

  // 完成后重取一次，让界面能看到最新状态
  const after = await web.api.tasks(account.cookie, egress(account));

  return {
    account_id: account.id,
    name: accounts.displayName(account),
    ok: true,
    done_count: results.filter((r) => r.ok && !r.already).length,
    already_count: results.filter((r) => r.already).length,
    fail_count: results.filter((r) => !r.ok).length,
    results,
    // 明确列出「看着没完成但不能自动做」的任务，避免用户以为漏跑了
    not_automatable: skipped.map((x) => ({ task_id: x.task_id, title: x.title, type: x.task_type })),
    tasks: after.ok ? after.tasks : t.tasks,
  };
}

// 跑所有启用账号
async function runAll() {
  const list = accounts.load().accounts.filter((a) => a.enabled);
  const results = [];
  for (const a of list) {
    try {
      results.push(await runForAccount(a));
    } catch (e) {
      results.push({ account_id: a.id, name: accounts.displayName(a), ok: false, error: e.message });
    }
  }
  return results;
}

// 只读：列出各账号的任务状态（不执行任何动作）
async function listTasks() {
  const list = accounts.load().accounts.filter((a) => a.enabled);
  const out = [];
  for (const a of list) {
    let agent = null;
    try { agent = web.agentFor(a); } catch (e) {
      out.push({ account_id: a.id, name: accounts.displayName(a), ok: false, error: e.message, tasks: [], draw_remaining: null, my_prizes: null, expired: false });
      continue;
    }
    const t = await web.api.tasks(a.cookie, { agent });
    const draw = await web.api.drawStatus(a.cookie, { agent });
    out.push({
      account_id: a.id,
      name: accounts.displayName(a),
      nickname: a.nickname || '',
      ok: t.ok,
      error: t.ok ? '' : t.error,
      expired: !!t.expired,
      tasks: t.ok ? t.tasks : [],
      draw_remaining: draw.ok ? draw.remaining_draws : null,
      my_prizes: draw.ok ? (draw.my_prizes || []).length : null,
    });
  }
  return out;
}

module.exports = { runAll, runForAccount, listTasks, recentRuns, AUTO_TYPES, LOG_FILE };
