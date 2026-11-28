// src/workbuddy/windowprobe.js - 6004 模型额度窗口探针（批次十，misakano windowprobe.go 移植）
//
// 登记侧在 index.js 的 model_cap 分支：6004 带重置墙钟（parseRateLimitReset
// 解析出的绝对时刻）时登记一条窗口，落盘跨重启。本模块是执行侧——到点后为
// 那个 (账号, 模型) 发一个最小请求，把新一轮配额窗口的计时起点钉在重置那一刻。
//
// **为什么必须主动发**（windowprobe.go 原文口径）：上游按**首次请求**起算窗口。
// 重置时刻到了却没人发请求，窗口就不开始，额度一直空转；等下一条真实请求进来，
// 起点落到那一刻——通常晚了几分钟到几十分钟，那段时间的额度等于白扔。我们原来的
// 处理只到「解除冷却」（允许请求进来），是被动的。
//
// 结果处置（windowprobe.go 四分支）：
//   - 首个有效帧带 choices → 窗口已开：清掉该 (账号,模型) 的 6004 模型冷却，
//     删窗口记录；
//   - 仍限流且给了更晚的重置时刻（> 现在 + 30s）→ 上游确实开了新一轮等待期，
//     ResetAt 换成新的、计数归零；
//   - 仍限流、时刻没变（服务端时钟/处理延迟）→ 15s 后重试，连续 20 次（≈5 分钟，
//     覆盖「上游声明时刻比实际早几分钟」的常见偏差）后放弃（删记录，下一次
//     真实 429 会重新登记）；
//   - 其它错误（网络、鉴权、5xx、200 流里的非限流错误帧）→ 不重试，删记录：
//     探针是真实计费的对话请求，不值得为它反复打上游。
//
// 刻意**不**做的事：主动扫描还没被限流的「账号 × 模型」配额线（hub 的
// wb_quota_scan）。那是另一种功能：请求量随账号×模型数增长，与「已经知道满了、
// 只等起窗」不是一件事。
//
// 探针与选号同一套闸门（windowprobe.go WindowProbeBlocked）：账号退场/停用/
// 被连坐暂停时不发，直接删记录（记录留着只会每轮都被取出来；真实请求照常会开窗）。
// 探针请求本身**不喂池**（成功不清账号状态、失败不罚号——失败原因已在窗口处置里）。
const fs = require('fs');
const path = require('path');
const c = require('./constants');

const FILE = 'workbuddy-model-windows.json';

// 与 windowprobe.go 同值
const PROBE_PROMPT = 'Hi';
const PROBE_MAX_TOKENS = 16;
const PROBE_TIMEOUT_MS = 60000;      // 上游劣化期 TTFB 可能到几十秒，但探针不值得等更久
const RETRY_DELAY_MS = 15000;        // 到点后上游常还没真正放开（服务端时钟/处理延迟）
const MAX_ATTEMPTS = 20;             // 20 × 15s ≈ 5 分钟
const FRESH_MIN_MS = 30000;          // 比「现在+30s」更远的重置点才算上游真开了新一轮
const BATCH_LIMIT = 8;               // 一个卡住的上游不该把巡检占满
const GAP_MS = 400;                  // 多窗口同时到点时错开
const IDLE_MS = 30000;               // 无待处理窗口时的巡检间隔

function enabled() {
  return String(process.env.DUMATE_WORKBUDDY_WINDOW_PROBE || '').trim() !== '0';
}

function filePath() {
  const dir = process.env.DUMATE_ADMIN_DATA || path.resolve(__dirname, '..', '..', 'data');
  return path.join(dir, FILE);
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return Array.isArray(j.windows) ? j.windows : [];
  } catch (e) { return []; }
}

// 原子写（tmp + rename）——窗口表跨重启，半截 JSON 等于丢光登记
function save(windows) {
  const p = filePath();
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ windows }, null, 1), 'utf8');
  fs.renameSync(tmp, p);
}

/**
 * 登记一条窗口（登记侧：index.js model_cap 分支，只在重置墙钟解析出来时调用）。
 * upsert 按 (accountId, model)：新墙钟无条件覆盖旧值、计数归零（panel
 * RecordWindowProbe 口径——重试期间的每次 429 都可能带来更准的时刻）。
 */
function registerWindow(accountId, model, resetAt, opts = {}) {
  if (!Number.isFinite(Number(resetAt)) || Number(resetAt) <= Date.now()) return false;
  const id = Number(accountId);
  const mdl = String(model || '').trim();
  if (!Number.isFinite(id) || !mdl) return false;
  const windows = load().filter((w) => !(w.accountId === id && w.model === mdl));
  windows.push({
    accountId: id,
    region: c.normalizeRegion(opts.region || 'cn'),
    model: mdl,
    resetAt: Number(resetAt),
    attempts: 0,
    detail: String(opts.detail || '').slice(0, 200),
    registeredAt: Date.now(),
  });
  try { save(windows); } catch (e) { return false; }
  return true;
}

function dropWindow(accountId, model) {
  const id = Number(accountId);
  const windows = load().filter((w) => !(w.accountId === Number(id) && w.model === String(model)));
  try { save(windows); } catch (e) { /* 写失败下次再删 */ }
}

function dueWindows(now = Date.now()) {
  return load()
    .filter((w) => Number(w.resetAt) <= now)
    .sort((a, b) => a.resetAt - b.resetAt);
}

function nextDue() {
  const list = load().map((w) => Number(w.resetAt)).filter((t) => t > Date.now());
  return list.length ? Math.min(...list) : null;
}

function listWindows() {
  return load().sort((a, b) => a.resetAt - b.resetAt);
}

/** 选号闸门（windowprobe.go WindowProbeBlocked）：返回拦截原因，'' = 可发 */
function blockedReason(w) {
  const authStore = require('./auth');
  const acc = authStore.findUsable().find((a) => Number(a.id) === Number(w.accountId));
  if (!acc) return '账号已退场或停用';
  if (c.normalizeRegion(acc.region) !== c.normalizeRegion(w.region)) return '账号区域与登记不符';
  return '';
}

/**
 * 发一次最小探针（真实计费对话请求，X-Agent-Type: auxiliary——panel 口径：
 * 内部维护请求不是用户主对话，上游看到的仍是一个正常 chat 请求）。
 * 走 chat.postStream = 真实代码路径（与真实流量同一套 body 构造/头集/failover）。
 *
 * @returns {Promise<{opened:boolean, limited:boolean, resetAt:number|null, detail:string}>}
 */
async function fireProbe(region, account, model) {
  const chat = require('./chat');
  let r;
  try {
    r = await chat.postStream(region, account, {
      model,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      stream: true,
      max_tokens: PROBE_MAX_TOKENS,
    }, { agentType: 'auxiliary' });
  } catch (e) {
    return { opened: false, limited: false, resetAt: null, detail: `probe error: ${e.message}`.slice(0, 200) };
  }
  if (r.fatal) return { opened: false, limited: false, resetAt: null, detail: String(r.error || 'fatal').slice(0, 200) };
  const status = r.status;
  if (status >= 400) {
    // 限流判定按状态码与原始报文——*Error.msg 只留前 200 字节，重置时刻排在
    // 后面就会被截掉，所以要自己读流（panel 同款教训）
    let text = '';
    try { text = await readAll(r.stream); } catch (e) { /* 空 */ }
    const reset = c.parseRateLimitReset(text);
    const limited = status === 429 || reset != null;
    return { opened: false, limited, resetAt: reset != null ? reset * 1000 : null, detail: `HTTP ${status}: ${text.slice(0, 160)}` };
  }
  return scanProbeStream(r.stream);
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const { StringDecoder } = require('string_decoder');
    const dec = new StringDecoder('utf8');
    let buf = '';
    stream.on('data', (d) => { buf += dec.write(d); });
    stream.on('end', () => resolve(buf + dec.end()));
    stream.on('error', reject);
  });
}

/**
 * 读到第一个有效帧为止（panel scanProbeStream 口径）：上游常把限流与拦截塞进
 * HTTP 200 的 SSE 帧里，只看状态码会把「仍在限流」当成打通，清掉冷却、钉错窗口起点。
 */
async function scanProbeStream(stream) {
  let text = '';
  try { text = await readAll(stream); } catch (e) {
    return { opened: false, limited: false, resetAt: null, detail: `stream error: ${e.message}`.slice(0, 200) };
  }
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let j = null;
    try { j = JSON.parse(payload); } catch (e) { continue; }
    // choices 帧（哪怕内容为空）→ 窗口已开：上游放行了这次请求
    if (j.choices) return { opened: true, limited: false, resetAt: null, detail: '' };
    // 错误帧（裸 error 或内嵌业务码）→ 分类判限流；reset 从原始 payload 解析
    const kind = c.classifyStatus(200, payload);
    if (j.error || kind && kind !== 'none') {
      const reset = c.parseRateLimitReset(payload);
      const limited = reset != null || kind === 'model_cap' || kind === 'temp_rate';
      return { opened: false, limited, resetAt: reset != null ? reset * 1000 : null, detail: payload.slice(0, 200) };
    }
  }
  return { opened: false, limited: false, resetAt: null, detail: '流结束前没有有效帧' };
}

/**
 * 处理单个窗口（windowprobe.go probeWindow 四分支）。每条路径都会删记录或把
 * 到点时刻推后——循环不会空转。
 */
async function probeWindow(w) {
  const channelPool = require('../channel-pool');
  const why = blockedReason(w);
  if (why) {
    dropWindow(w.accountId, w.model);
    return { action: 'dropped', reason: why };
  }
  const authStore = require('./auth');
  const acc = authStore.findUsable().find((a) => Number(a.id) === Number(w.accountId));
  const r = await fireProbe(w.region || 'cn', acc, w.model);
  const now = Date.now();
  if (r.opened) {
    // 探针通了：这条额度线已经重置。清 6004 模型冷却 + 删窗口记录。
    // 清冷却的对齐点是这条窗口自己的 ResetAt（panel ClearQuotaCooldown 口径）：
    // 探针证明的是「ResetAt 那轮限额已过去」，探针期间撞上的更新一轮限额
    // （冷却 until 更晚）不属于这轮，不能被这次成功抹掉——按 (账号,模型) 清，
    // 更新轮的冷却由它自己的真实 429 重新登记。
    channelPool.clearModelBlock('workbuddy', w.accountId, w.model);
    dropWindow(w.accountId, w.model);
    return { action: 'opened', detail: r.detail };
  }
  if (r.limited && r.resetAt && r.resetAt > now + FRESH_MIN_MS) {
    // 上游给了更晚的重置点：确实进入新的等待期，换新墙钟、计数归零
    registerWindow(w.accountId, w.model, r.resetAt, { region: w.region, detail: r.detail });
    return { action: 'rescheduled', resetAt: r.resetAt, detail: r.detail };
  }
  if (r.limited && (w.attempts || 0) + 1 < MAX_ATTEMPTS) {
    registerWindow(w.accountId, w.model, now + RETRY_DELAY_MS, {
      region: w.region, detail: r.detail,
    });
    // attempts 语义在 registerWindow 里被归零（panel 同款：RecordWindowProbe 传 0/计数由调用方管）
    // 这里补回计数：直接改文件不如把 attempts 塞回 detail——简化为在记录上重写 attempts
    bumpAttempts(w.accountId, w.model, (w.attempts || 0) + 1);
    return { action: 'retry', attempts: (w.attempts || 0) + 1, detail: r.detail };
  }
  if (r.limited) {
    dropWindow(w.accountId, w.model);
    return { action: 'gave_up', attempts: MAX_ATTEMPTS, detail: r.detail };
  }
  dropWindow(w.accountId, w.model);
  return { action: 'failed', detail: r.detail };
}

/** 重试分支的 attempts 补记（registerWindow 归零后的唯一修正点） */
function bumpAttempts(accountId, model, attempts) {
  const windows = load().map((w) => (w.accountId === Number(accountId) && w.model === String(model))
    ? { ...w, attempts } : w);
  try { save(windows); } catch (e) { /* 下轮重记 */ }
}

/**
 * 处理一轮到点的窗口。返回实际发出的探针数（不含被闸门拦掉的）。
 * 面板「立即探针」与测试用；常驻由 startLoop 驱动。
 */
async function runDue(now = Date.now()) {
  let due = dueWindows(now);
  if (due.length > BATCH_LIMIT) due = due.slice(0, BATCH_LIMIT);
  let sent = 0;
  const results = [];
  for (const w of due) {
    if (sent > 0) await new Promise((res) => setTimeout(res, GAP_MS));
    const r = await probeWindow(w);
    // 被闸门拦掉的不计入「发出」
    if (r.action !== 'dropped') sent++;
    results.push({ accountId: w.accountId, model: w.model, ...r });
  }
  return { sent, results };
}

let loopTimer = null;

/**
 * 常驻巡检循环（windowprobe.go StartModelWindowProbe 同构）：有到点窗口就处理，
 * 否则按「最近一个未来 ResetAt」精确醒来（30s 兜底）。独立 env 开关
 * DUMATE_WORKBUDDY_WINDOW_PROBE=0 关闭。只该由**网关进程**调一次（冷却与
 * 选号状态都在网关进程里）。
 */
function startLoop() {
  if (!enabled() || loopTimer) return;
  const tick = async () => {
    loopTimer = null;
    let wait = IDLE_MS;
    try {
      const due = dueWindows();
      if (due.length) {
        await runDue();
      } else {
        const next = nextDue();
        if (next != null) wait = Math.max(1000, Math.min(IDLE_MS, next - Date.now()));
      }
    } catch (e) {
      console.warn(`[workbuddy-window] 巡检异常: ${e.message}`);
    }
    loopTimer = setTimeout(tick, wait);
    if (loopTimer.unref) loopTimer.unref();
  };
  loopTimer = setTimeout(tick, 3000);
  if (loopTimer.unref) loopTimer.unref();
}

module.exports = {
  enabled, registerWindow, dropWindow, dueWindows, nextDue, listWindows,
  blockedReason, fireProbe, scanProbeStream, probeWindow, runDue, startLoop,
  bumpAttempts,
  PROBE_PROMPT, PROBE_MAX_TOKENS, RETRY_DELAY_MS, MAX_ATTEMPTS, FRESH_MIN_MS, BATCH_LIMIT,
};
