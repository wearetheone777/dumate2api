// src/reqlog.js - 请求埋点（网关侧）
//
// 目标：回答「今天用了多少 token、多少次请求、谁在调、成功率多少」。
// 上游不提供用量接口，客户端也不落库，所以只能在网关这一跳自己记。
//
// 落盘用 JSONL 追加：一次请求一行，崩了最多丢最后一行，不会像 JSON 数组
// 那样整体不可解析。写入是同步的——埋点失败绝不能影响正在转发的响应，
// 所以出错只吞掉。
const fs = require('fs');
const path = require('path');
const filelock = require('./filelock');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = process.env.DUMATE_ADMIN_DATA || path.join(ROOT, 'data');
const FILE = 'requests.jsonl';
const MAX_BYTES = 32 * 1024 * 1024;

let disabled = false;

// 施工包 C：计量挂钩。分桶聚合挂在 record 里而不是 server.js——网关、
// web 网关、chatlab 三个调用点自动全覆盖。聚合是纯内存累加且自吞异常，
// 失败只少统计，绝不影响埋点。懒加载：首次 record 时才 require，避免
// 无关进程为它付启动成本。DUMATE_USAGE_AGG=0 可整体关停。
let aggHook = null;
let aggHookBroken = false;

function ensureDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* 已存在 */ }
}

// 单文件超限就轮转一次：留一份上一代用于排查，不无限增长
function rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_BYTES) return;
    const prev = `${file}.1`;
    try { fs.unlinkSync(prev); } catch (e) { /* 不存在 */ }
    filelock.renameAtomic(file, prev);
  } catch (e) { /* 文件还不存在 */ }
}

function record(entry) {
  if (disabled) return;
  if (!aggHook && !aggHookBroken) {
    try { aggHook = require('./reqlog-hook'); } catch (e) { aggHookBroken = true; }
  }
  if (aggHook) {
    try { aggHook.feed(entry); } catch (e) { /* 计量失败不影响埋点 */ }
  }
  try {
    // 调用来源开关（livecfg.recordClientInfo，F6e）：关掉时不落 ip / ua。
    // 收口在 record 里而不是调用方——server.js 的 logRequest 与三个协议
    // 翻译器都汇到这里，一处判定全覆盖，server.js 不用动。
    // 开关热生效：livecfg 按 mtime 重读，管理端 PUT 后下一次请求即新口径。
    try {
      if (require('./livecfg').Load().recordClientInfo === false) {
        delete entry.ip;
        delete entry.ua;
      }
    } catch (e) { /* 配置读不到按默认（记录）处理 */ }
    ensureDir();
    const file = path.join(LOG_DIR, FILE);
    rotateIfNeeded(file);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (e) {
    // 只报一次，避免磁盘满时每请求刷屏
    if (!disabled) {
      disabled = true;
      console.error(`[reqlog] 埋点已停用: ${e.message}`);
    }
  }
}

// 请求唯一 id。用于把这一条埋点与别处的采集精确配对——目前是千问通道的
// 积分归因（要等结算，时间戳必然对不上），后续其它异步采集也用得上。
// 进程内自增 + 时间戳前缀：跨进程唯一即可，不需要全局唯一。
let seq = 0;
function newReqId() {
  seq = (seq + 1) % 1e6;
  return `${Date.now().toString(36)}-${seq.toString(36)}`;
}

// 从上游 usage 里取 token 数。OpenAI 风格是 prompt_tokens/completion_tokens，
// Anthropic 风格是 input_tokens/output_tokens，Google 是 promptTokenCount/
// candidatesTokenCount，三条路径共用这一个函数。
//
// 缓存命中（2026-11-04，融合 hub v1.7.22 的 cached_reported 口径）：五种形状
// 都认（标准位 / DeepSeek / Qwen / Anthropic 出口 / 散装）。**reported 区分
// 「上游报了缓存且为 0」与「上游根本没回报缓存字段」**——两者在成本归因里
// 是两回事：前者是「确认零缓存」（全价请求），后者是「未知」（不能当 0 算）。
function pickUsage(u) {
  if (!u || typeof u !== 'object') {
    return { input: 0, output: 0, total: 0, cached: 0, cachedReported: false };
  }
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount ?? 0) || 0;
  const output = Number(u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount ?? 0) || 0;
  const total = Number(u.total_tokens ?? u.totalTokenCount ?? 0) || (input + output);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  const cands = [
    num(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens),
    num(u.prompt_cache_hit_tokens),
    num(u.completion_tokens_details && u.completion_tokens_details.cached_tokens),
    num(u.cache_read_input_tokens),
    num(u.cached_tokens),
  ].filter((v) => v != null);
  const cached = cands.length ? Math.max(...cands) : 0;
  return { input, output, total, cached, cachedReported: cands.length > 0 };
}

// 从 SSE 文本里扫出 usage。流式响应没有单一的 usage 字段，
// 必须逐行解析 data: 负载，取最后一个带 usage 的块。
function usageFromSSE(text) {
  let best = { input: 0, output: 0, total: 0, cached: 0, cachedReported: false };
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      const u = j.usage || (j.message && j.message.usage) ||
        (j.response && j.response.usage) || j.usageMetadata;
      if (u) {
        const picked = pickUsage(u);
        if (picked.total || picked.input || picked.output) best = picked;
      }
    } catch (e) { /* 非 JSON 行跳过 */ }
  }
  return best;
}

// 从请求体里推断模型名与是否流式，供日志展示。
// Google 协议把模型放在 URL 路径而不是 body，所以额外接受一个回退名。
function describeRequest(body, fallbackModel) {
  let model = '';
  let stream = false;
  let messages = 0;
  try {
    if (body && typeof body === 'object') {
      model = body.model || '';
      stream = !!body.stream;
      const m = body.messages || (body.contents || []);
      messages = Array.isArray(m) ? m.length : 0;
    }
  } catch (e) { /* 忽略 */ }
  if (!model && fallbackModel) model = fallbackModel;
  return { model, stream, messages };
}

function clientIP(req) {
  const raw = (req.socket && req.socket.remoteAddress) || '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

// 读日志，最新的在前。limit 与 offset 都按行计。
function read(opts = {}) {
  const { limit = 50, offset = 0, filter = null } = opts;
  let lines = [];
  try {
    lines = fs.readFileSync(path.join(LOG_DIR, FILE), 'utf8').split('\n').filter(Boolean);
  } catch (e) {
    return { rows: [], total: 0 };
  }
  let rows = lines
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean);
  if (filter) rows = rows.filter(filter);
  const total = rows.length;
  rows = rows.reverse();
  // limit <= 0 表示不限：统计接口要拿全量窗口自己聚合，
  // 按 slice(offset, offset+limit) 处理会把它当成取 0 条。
  rows = limit > 0 ? rows.slice(offset, offset + limit) : rows.slice(offset);
  return { rows, total };
}

// 标记首字时刻。多次调用只记第一次——流式响应会持续吐字节，
// 我们要的是「第一个」，不是最后一个。
//
// 放在这里而不是留在 server.js：三个协议翻译器（Responses / Anthropic /
// Google）手里也有 res，它们必须和透传分支用**同一个**口径。此前这个函数
// 只在 server.js 内部可见，翻译器只能干看着——于是 /v1/responses 与
// /v1/messages 的流式请求一条 first_token_ms 都记不下来（实测 dumate
// /v1/responses 1295 条全为 0，而直连通道 1987/1987 正常）。
function markFirstToken(res) {
  if (res && !res._firstTokenAt) res._firstTokenAt = Date.now();
}

module.exports = {
  record, read, pickUsage, usageFromSSE, describeRequest, clientIP, newReqId,
  markFirstToken, LOG_DIR,
};
