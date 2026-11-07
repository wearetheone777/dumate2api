// src/dumate-points.js - dumate-points 伪模型：把网页池余额变成 Agent 可查的读数
//
// 融合自 Wang-JQ77/dumate-api 的「积分为模型」思路（2026-11-07 调研 P0-1）：
// 它把积分余额暴露成专用模型名 `dumate-points`（查积分不消耗积分）与
// `GET /api/points/balance` 只读端点。本仓库管理端早有 Points / 余额曲线，
// 但那都在 9083 管理端进程里——Agent（Codex / Claude Code）只看得到网关，
// 它们想知道「还能跑多少」时没有任何入口。伪模型把读数搬进 /v1 面。
//
// 三条纪律：
//   1. **零上游消耗**——只打 /api/dumate/points/quota_overview（网页端读接口），
//      不发对话请求；失败也不喂池（读接口的失败与账号健康无关，罚号只会让
//      对话请求被无辜跳过，与 admin/routes/dumate.js 同一结论）。
//   2. **不编数**——某个账号查不到就如实写「查询失败」，合计只累成功行；
//      全部失败时没有「合计」这行。0 会被读成「没额度」，与真相无关。
//   3. **只读网页池**——桌面链路（8980）登录态的余额不在此读数内，文本里
//      明说，不留「这就是全部余额」的误解空间。
//
// 缓存：进程内 TTL（DUMATE_POINTS_TTL_MS，默认 15s，0 关闭）。Agent 每轮
// 都可能查一次，不去重的话每次查询都打满全部账号的上游读接口。
const accounts = require('./accounts');
const web = require('./dumate-web');

const NAME = 'dumate-points';
const TTL_DEFAULT_MS = 15000;

function ttlMs() {
  const n = parseInt(process.env.DUMATE_POINTS_TTL_MS || String(TTL_DEFAULT_MS), 10);
  return Number.isFinite(n) && n >= 0 ? n : TTL_DEFAULT_MS;
}

let cache = null; // { at, summary }

/** 单账号余额行。失败不抛——按 ok:false 行呈现，隔离单账号故障 */
async function fetchRow(a) {
  const name = a.nickname || a.name || `账号 ${a.id}`;
  try {
    // 出站代理与 accounts.js 同源（账号配了代理就绝不回退直连）
    const r = await web.api.quotaOverview(a.cookie, { agent: web.agentFor(a) });
    if (r.ok) {
      return { id: a.id, name, ok: true, left: r.left, total: r.total, used: r.used, throttled: !!r.throttled };
    }
    return { id: a.id, name, ok: false, error: r.error || '上游返回错误' };
  } catch (e) {
    return { id: a.id, name, ok: false, error: e.message };
  }
}

/**
 * 汇总网页池余额。opts.load / opts.quota 供测试注入，缺省走真实模块。
 * 返回 { at, rows, okCount, failCount, disabledCount, totalLeft }；
 * totalLeft 只累成功行，全部失败时为 null（不是 0）。
 */
async function summary(opts = {}) {
  const load = opts.load || (() => accounts.load().accounts);
  const quota = opts.quota || fetchRow;
  const all = load();
  const enabled = all.filter((a) => a.enabled);
  const rows = await Promise.all(enabled.map(quota));
  const okRows = rows.filter((r) => r.ok);
  return {
    at: Date.now(),
    rows,
    okCount: okRows.length,
    failCount: rows.length - okRows.length,
    disabledCount: all.length - enabled.length,
    totalLeft: okRows.length
      ? Math.round(okRows.reduce((s, r) => s + (r.left || 0), 0) * 100) / 100
      : null,
  };
}

/** TTL 缓存包装。TTL=0 时每次现查 */
async function summaryCached(opts = {}) {
  const ttl = ttlMs();
  if (opts.force !== true && cache && ttl > 0 && Date.now() - cache.at < ttl) {
    return cache.summary;
  }
  const s = await summary(opts);
  cache = { at: Date.now(), summary: s };
  return s;
}

function resetCacheForTest() { cache = null; }

/** 人类可读文本（模型回给调用方的正文） */
function renderText(s) {
  const lines = ['DuMate 网页积分余额（dumate-points 伪模型 · 实时查询 · 本次请求零消耗）'];
  if (!s.rows.length) {
    lines.push('网页池没有启用账号：先在管理端 WebAccounts 页添加账号，再查本模型。');
    if (s.disabledCount > 0) lines.push(`另有 ${s.disabledCount} 个停用账号未计入。`);
    return lines.join('\n');
  }
  for (const r of s.rows) {
    if (r.ok) {
      lines.push(`- ${r.name}：剩余 ${r.left} / 总 ${r.total}（已用 ${r.used}）${r.throttled ? '［限速中］' : ''}`);
    } else {
      lines.push(`- ${r.name}：查询失败（${r.error}；到管理端 WebAccounts 检查登录态）`);
    }
  }
  if (s.totalLeft != null) {
    lines.push(`合计剩余：${s.totalLeft}（成功 ${s.okCount} / 失败 ${s.failCount}）`);
  } else {
    lines.push(`合计剩余：无（${s.failCount}/${s.rows.length} 个账号查询失败，不编数）`);
  }
  if (s.disabledCount > 0) lines.push(`另有 ${s.disabledCount} 个停用账号未计入。`);
  lines.push('说明：读数来自网页凭证池（dumate.cn 网页端）；桌面链路（8980）登录态的余额不在此列。');
  return lines.join('\n');
}

// ==================== 协议形状（纯函数，离线可测）====================

function msgId() {
  return `dmpoints-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** OpenAI 非流式响应体。token 全 0 是真实计量（没打模型） */
function openAIBody(text) {
  return {
    id: `chatcmpl-${msgId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: NAME,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** OpenAI 流式 chunk 序列（角色帧 → 内容帧 → 收尾帧，收尾带 usage） */
function openAIChunks(text) {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${msgId()}`;
  const base = { id, object: 'chat.completion.chunk', created, model: NAME };
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
  ];
}

/** Anthropic 非流式响应体 */
function anthropicBody(text) {
  return {
    id: `msg_${msgId()}`,
    type: 'message',
    role: 'assistant',
    model: NAME,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/** Anthropic SSE 事件序列（message_start → 文本块 → message_stop） */
function anthropicEvents(text) {
  const message = {
    id: `msg_${msgId()}`,
    type: 'message',
    role: 'assistant',
    model: NAME,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  return [
    { event: 'message_start', data: { type: 'message_start', message } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

module.exports = {
  NAME, summary, summaryCached, renderText, resetCacheForTest,
  openAIBody, openAIChunks, anthropicBody, anthropicEvents,
};
