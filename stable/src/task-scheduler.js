// src/task-scheduler.js - 任务自动轮询（后台定时检查有无可完成任务）
//
// 间隔怎么定才不会触发风控——三条依据，不是拍脑袋：
//
//   1. 客户端自己的轮询是 10 秒（bundle 里 `POLL_INTERVAL = 10000`），
//      但它**只在页面可见时**轮询（document.hidden 就 stopPolling）。
//      也就是说正常用户不会 24 小时持续请求。
//   2. 实测任务接口没有频率限制（连打 12 次全 200，无 Retry-After），
//      但这不等于可以高频——风控通常在设备指纹/行为层，封禁可能延迟触发。
//   3. 任务**不是每日重置**（重复完成被拒 code 410121），只在有活动时新增。
//      所以高频轮询的收益是零：查得再勤也不会多出任务。
//
// 结论：默认 30 分钟查一次，并且每次加 ±20% 随机抖动。
// 固定整点节奏（每 30 分钟整点触发）本身就是明显的机器特征；
// 抖动让请求间隔看起来像人。抽奖/完成动作之间再串行加小延迟。
//
// 环境变量：
//   DUMATE_TASK_POLL_MINUTES  轮询间隔分钟，默认 30（设 0 关闭）
const accounts = require('./accounts');
const taskRunner = require('./task-runner');
const { readJSON, writeJSON } = require('./admin/store');

// 保活与余额联动调度（施工包 B / GAP F2）：keepalive 有自己的每日排程与
// 配置，但它的启动/重排挂在本模块的 schedule() 链路上——admin/server.js
// 只调 taskScheduler.schedule() 一处，server.js 与 admin/server.js 都不必
// 感知 keepalive。加载失败不拖累任务轮询。
let keepalive = null;
try { keepalive = require('./keepalive'); } catch (e) { /* keepalive 缺失/故障时任务轮询照常 */ }

const CONFIG_FILE = 'task-scheduler.json';
const DEFAULT_MINUTES = parseInt(process.env.DUMATE_TASK_POLL_MINUTES || '30', 10);
const MIN_MINUTES = 5;          // 低于这个值拒绝——太快了
const JITTER_RATIO = 0.2;       // ±20% 抖动
// 同一轮里账号之间的间隔：并发打同一个上游更容易被识别
const PER_ACCOUNT_DELAY_MS = 2000;

function loadConfig() {
  const saved = readJSON(CONFIG_FILE, null) || {};
  return {
    enabled: !!saved.enabled,
    minutes: Number.isInteger(saved.minutes) ? saved.minutes : DEFAULT_MINUTES,
    last_run_at: null,
    last_result: null,
    next_run_at: null,
    running: false,
  };
}

function saveConfig() {
  writeJSON(CONFIG_FILE, {
    enabled: state.enabled,
    minutes: state.minutes,
    updated_at: Date.now(),
  });
}

let state = loadConfig();
let timer = null;

// 下一次触发时间 = 间隔 + 随机抖动。
// 抖动的意义在于打散固定节奏，不是为了性能。
function nextDelayMs() {
  const base = state.minutes * 60 * 1000;
  const jitter = base * JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(60 * 1000, Math.round(base + jitter));
}

function schedule() {
  // keepalive 排程与本轮询互相独立（它有自己的 enabled/时点），这里只负责
  // 「进程启动或重排时把它的定时器也架上」；无论本模块开关状态如何都要调。
  if (keepalive) { try { keepalive.schedule(); } catch (e) { /* 同上，不阻塞主排程 */ } }
  if (timer) { clearTimeout(timer); timer = null; }
  if (!state.enabled || state.minutes <= 0) { state.next_run_at = null; return; }

  const delay = nextDelayMs();
  state.next_run_at = Date.now() + delay;
  timer = setTimeout(async () => {
    await runOnce('scheduled');
    schedule();   // 跑完再排下一次（每次都重新抖动）
  }, delay);
  if (timer.unref) timer.unref();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 跑一轮：串行处理账号，每个之间隔一小段。
// 串行而不是并发，是为了不把多账号的请求在同一瞬间打到上游。
async function runOnce(trigger) {
  if (state.running) return { skipped: 'already_running' };
  state.running = true;
  try {
    const list = accounts.load().accounts.filter((a) => a.enabled);
    const results = [];

    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (i > 0) await sleep(PER_ACCOUNT_DELAY_MS);
      try {
        const r = await taskRunner.runForAccount(a);
        results.push({
          name: accounts.displayName(a), ok: r.ok, done: r.done_count || 0,
          already: r.already_count || 0, fail: r.fail_count || 0,
          not_automatable: (r.not_automatable || []).length,
          error: r.error || '',
        });
      } catch (e) {
        results.push({ name: accounts.displayName(a), ok: false, error: e.message });
      }
    }

    // TRAE Work 的签到跑同一轮。与搭子串行而非并发：
    // 两边都往上打折同一批上游，并发只会把瞬时请求量翻倍。
    // 通道不可用时静默跳过——不该让任务轮询因为一条可选通道失败。
    try {
      const traework = require('./traework');
      if (traework.status().ready) {
        const authStore = require('./traework/auth');
        const checkin = require('./traework/checkin');
        for (const a of authStore.findUsable()) {
          // respectBackoff：上轮 9074 的退避窗口内跳过（退避的意义就是错峰）。
          // 退避到期后由这里下一轮自然重试——签到幂等且当天签上即可，
          // 30 分钟粒度天然错峰，不需要独立的秒级重试循环。
          const r = await checkin.checkinAndSave(a, authStore, { respectBackoff: true });
          results.push({
            name: `TRAE:${a.nickname || a.uid || a.id}`,
            ok: r.ok,
            // done 记「本次真正领到」的，already 记「已签跳过」的
            done: r.ok && !r.already ? 1 : 0,
            already: r.already ? 1 : 0,
            fail: r.ok ? 0 : 1,
            error: r.error || '',
          });
          // 9074 已在 checkin.claimWithRetry 里自愈：撞到先换一代设备 id
          // 立即重试，仍失败才记退避（设备级校验，不传染其他账号——
          // 2026-10-30 对齐 Trae2api-cn 的 device_generation 方案）。
          // 所以这里不再短路跳过剩余账号，各账号独立处置。
          await sleep(PER_ACCOUNT_DELAY_MS);
        }
      }
    } catch (e) {
      results.push({ name: 'TRAE Work', ok: false, error: e.message });
    }

    const done = results.reduce((s, r) => s + (r.done || 0), 0);
    state.last_run_at = Date.now();
    state.last_result = { trigger, total: results.length, done_count: done, results };
    require('./admin/auth').audit('system', 'task_poll', '', `${trigger}: 完成 ${done}`);
    return state.last_result;
  } finally {
    state.running = false;
  }
}

function snapshot() {
  return {
    enabled: state.enabled,
    minutes: state.minutes,
    min_minutes: MIN_MINUTES,
    jitter_ratio: JITTER_RATIO,
    per_account_delay_ms: PER_ACCOUNT_DELAY_MS,
    last_run_at: state.last_run_at,
    last_result: state.last_result,
    next_run_at: state.next_run_at,
    running: state.running,
    // 保活调度的排程与运行态（施工包 B）：null = 模块缺失/加载失败
    keepalive: keepalive ? keepalive.snapshot() : null,
    // 把「为什么是这个间隔」写进接口，界面直接展示，避免被当成随便设的
    rationale: [
      '任务不是每日重置，只在有活动时新增——高频轮询收益为零',
      '客户端自身轮询是 10 秒，但仅在页面可见时；正常用户不会 24 小时持续请求',
      `默认 ${DEFAULT_MINUTES} 分钟一次，每次 ±${JITTER_RATIO * 100}% 随机抖动，避免固定整点节奏`,
      `多账号串行处理，账号之间间隔 ${PER_ACCOUNT_DELAY_MS / 1000} 秒`,
    ],
  };
}

function configure(patch = {}) {
  if (patch.enabled !== undefined) state.enabled = !!patch.enabled;
  if (patch.minutes !== undefined) {
    const m = parseInt(patch.minutes, 10);
    if (!Number.isInteger(m) || m < 0) throw new Error('minutes 需为不小于 0 的整数');
    // 0 表示关闭轮询；其余低于下限的拒绝，避免把账号暴露在无谓的风险里
    if (m > 0 && m < MIN_MINUTES) {
      throw new Error(`间隔不能低于 ${MIN_MINUTES} 分钟——过密轮询对封号没有收益，只有风险`);
    }
    state.minutes = m;
  }
  schedule();
  saveConfig();
  return snapshot();
}

module.exports = { schedule, runOnce, snapshot, configure, state, MIN_MINUTES, DEFAULT_MINUTES };
