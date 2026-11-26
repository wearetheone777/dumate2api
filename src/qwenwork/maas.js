// src/qwenwork/maas.js - QwenWork MaaS 直连备选链路（2026-11-27，G1）
//
// 设计纪律：
//   1. 默认关。只有 `DUMATE_QWENWORK_MAAS=1` 才参与路由，避免凭证过期时影响主链路。
//   2. 只从桌面端缓存读凭证，不写、不改官方客户端文件。Windows / WSL2 下走
//      Electron safeStorage OSCrypt（PowerShell DPAPI 桥）；其它 Linux/macOS
//      没有实测路径，available() 如实 false。
//   3. 凭证值绝不打印到日志/错误。只暴露前缀、过期时间等元数据。
//   4. MaaS 是标准 OpenAI 兼容端点，直接用 https 请求；流式用 StringDecoder 逐行解析，
//      非流式聚合 SSE 成 chat.completion。模型名用上游原生名（免费档 minimax3.1flash）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const DEFAULT_BASE = process.env.DUMATE_QWENWORK_MAAS_BASE || 'https://api9.qwenwork.cn/v1';
const FREE_MODEL = 'minimax-m3.1-flash'; // minimax3.1flash（免费，测试专用）
const TIMEOUT_MS = 600000;

let cache = null;
// 失败负缓存 + 单飞：凭证缺失/被拒时不能每个请求都起一次 PowerShell + DPAPI。
// 30s 足够让官方客户端完成轮换，又不会让刚恢复的凭证长时间不可用。
const NEG_TTL_MS = 30000;
let negativeUntil = 0;
let loading = false;

function enabled() {
  return process.env.DUMATE_QWENWORK_MAAS === '1';
}

/** Windows / WSL: 用 PowerShell 读 DPAPI OSCrypt key + 缓存文件，base64 回传。
 *  不落临时明文文件；不打印任何凭证内容。 */
function readWindowsCredentialFile() {
  const isWin = process.platform === 'win32';
  const isWsl = !isWin && process.platform === 'linux' && (() => {
    try { return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch (e) { return false; }
  })();
  if (!isWin && !isWsl) return null;
  try {
    const ps = path.join(os.tmpdir(), 'd2a-maas-read.ps1');
    const script = [
      'Add-Type -AssemblyName System.Security',
      "$ErrorActionPreference='Stop'",
      "$statePath = [IO.Path]::Combine($env:APPDATA, 'QwenWorkCN', 'Local State')",
      "$ls = Get-Content -Raw $statePath | ConvertFrom-Json",
      '$blob = [Convert]::FromBase64String($ls.os_crypt.encrypted_key)',
      '$key = [Security.Cryptography.ProtectedData]::Unprotect($blob[5..($blob.Length-1)], $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
      "$cred = if ($env:DUMATE_QWENWORK_MAAS_CRED_WIN) { $env:DUMATE_QWENWORK_MAAS_CRED_WIN } elseif ($env:DUMATE_QWENWORK_MAAS_CRED) { $env:DUMATE_QWENWORK_MAAS_CRED } else { [IO.Path]::Combine($env:USERPROFILE, '.qwenworkcn', 'engine-maas-key.dat') }",
      '$raw = [IO.File]::ReadAllBytes($cred)',
      "$obj = @{ key = [Convert]::ToBase64String($key); raw = [Convert]::ToBase64String($raw) } | ConvertTo-Json -Compress",
      '[Console]::Out.Write($obj)',
    ].join('\n');
    fs.writeFileSync(ps, script, { encoding: 'utf8', mode: 0o600 });
    const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], {
      encoding: 'utf8', timeout: 20000,
    });
    fs.rmSync(ps, { force: true });
    const start = out.indexOf('{');
    if (start < 0) return null;
    const obj = JSON.parse(out.slice(start));
    const key = Buffer.from(obj.key, 'base64');
    const raw = Buffer.from(obj.raw, 'base64');
    if (raw.length < 16 || String(raw.slice(0, 3)) !== 'v10') return null;
    const iv = raw.subarray(3, 15);
    const ct = raw.subarray(15);
    const { createDecipheriv } = require('crypto');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch (e) {
    return null;
  }
}

function loadCredential(force = false) {
  const now = Date.now();
  const fresh = cache && (cache.expiresAtMs === 0 || now < cache.expiresAtMs - 60000);
  if (fresh && !force) return cache;
  if (!force && now < negativeUntil) return null;
  // execFileSync 是同步的；同一进程内的并发请求不会真的重叠，但 meta()/status
  // 与请求可能在同一 tick 连续调用，仍用一个门防止重复起 PowerShell。
  if (loading) return fresh ? cache : null;
  loading = true;
  try {
    const json = readWindowsCredentialFile();
    if (!json || json.schemaVersion !== 2 || !json.credentials || typeof json.credentials !== 'object') {
      negativeUntil = Date.now() + NEG_TTL_MS;
      return null;
    }
    const values = Object.values(json.credentials).filter((c) => c && typeof c.accessKey === 'string' && c.accessKey);
    const cred = values.find((c) => !c.expiresAtMs || c.expiresAtMs > Date.now());
    if (!cred) {
      negativeUntil = Date.now() + NEG_TTL_MS;
      return null;
    }
    negativeUntil = 0;
    cache = {
      accessKey: cred.accessKey,
      expiresAtMs: cred.expiresAtMs || 0,
      baseUrl: typeof cred.baseUrl === 'string' && cred.baseUrl ? cred.baseUrl : DEFAULT_BASE,
    };
    return cache;
  } finally {
    loading = false;
  }
}

/** 是否可用（不泄露凭证内容）。 */
function available() {
  if (!enabled()) return false;
  const c = loadCredential();
  return !!(c && c.accessKey);
}

function invalidate() {
  cache = null;
  negativeUntil = 0; // 401/403 后允许立刻重读桌面端缓存
}

function meta() {
  // 默认关时**不要**碰凭证：管理端每次 /status 都调 meta()，若在这里解密，
  // 未启用 MaaS 的部署也会被拖进 PowerShell + DPAPI 调用。
  if (!enabled()) return { enabled: false, available: false };
  const c = loadCredential();
  if (!c) return { enabled: true, available: false };
  return {
    enabled: enabled(), available: true,
    keyPrefix: c.accessKey.slice(0, 3), keyLength: c.accessKey.length,
    expiresAtMs: c.expiresAtMs, baseUrl: c.baseUrl,
  };
}

function normalizeModel(model) {
  const { resolveModelKey } = require('./chat');
  const resolved = resolveModelKey(String(model || '').replace(/^qwen\//, ''));
  // MaaS 只收原生名；免费档两个别名指向同一上游键。
  if (resolved === 'minimax3.1flash' || /^minimax/i.test(resolved)) return FREE_MODEL;
  return resolved;
}

function headers(ak) {
  return { Authorization: `Bearer ${ak}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' };
}

/** 单次 https POST；复用 qwenwork/chat 的 StringDecoder 纪律。 */
function post(url, body, hdrs, onChunk) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { ...hdrs, 'Content-Length': Buffer.byteLength(body) }, timeout: TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      const dec = new (require('string_decoder').StringDecoder)('utf8');
      const flush = (line) => {
        const t = line.trim();
        if (!t.startsWith('data:')) return;
        const raw = t.slice(5).trim();
        if (raw === '[DONE]') { if (onChunk) onChunk('[DONE]'); return; }
        if (onChunk) onChunk(raw);
      };
      res.on('data', (c) => {
        buf += dec.write(c);
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { flush(buf.slice(0, i)); buf = buf.slice(i + 1); }
      });
      res.on('end', () => {
        buf += dec.end();
        if (buf) flush(buf);
        resolve({ status: res.statusCode, headers: res.headers, raw: buf });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('MaaS upstream timeout')));
    req.write(body);
    req.end();
  });
}

function aggregate(payloads, model) {
  let content = '';
  let reasoning = '';
  let finish = 'stop';
  let usage = null;
  const toolCalls = [];
  for (const p of payloads) {
    let j; try { j = JSON.parse(p); } catch (e) { continue; }
    if (j.usage) usage = j.usage;
    for (const ch of j.choices || []) {
      const d = ch.delta || ch.message || {};
      if (d.content) content += d.content;
      if (d.reasoning_content) reasoning += d.reasoning_content;
      if (ch.finish_reason) finish = ch.finish_reason;
      for (const tc of d.tool_calls || []) {
        const idx = Number(tc.index) || 0;
        toolCalls[idx] = toolCalls[idx] || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.type) toolCalls[idx].type = tc.type;
        if (tc.function && tc.function.name) toolCalls[idx].function.name += tc.function.name;
        if (tc.function && tc.function.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
      }
    }
  }
  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls.filter(Boolean);
  return {
    id: '', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, finish_reason: finish, message }],
    ...(usage ? { usage } : {}),
  };
}

function parseError(raw, status) {
  try {
    const j = JSON.parse(raw);
    const msg = (j.error && j.error.message) || j.message || '';
    const err = new Error(`qwenwork maas ${status}: ${msg || 'upstream error'}`);
    err.statusCode = status;
    return err;
  } catch (e) {
    const err = new Error(`qwenwork maas ${status}`);
    err.statusCode = status;
    return err;
  }
}

/** 发对话请求。payload 已是 OpenAI chat 形状；返回聚合 chat.completion 或流式回调。 */
async function send(payload, onChunk, opts = {}) {
  const c = loadCredential();
  if (!c) {
    const e = new Error('MaaS 凭证不可用（需开启 DUMATE_QWENWORK_MAAS=1 且桌面端已缓存 accessKey）');
    e.statusCode = 503;
    throw e;
  }
  const body = { ...payload, model: normalizeModel(payload && payload.model) };
  // mapped_model 埋点：MaaS 链路下客户端名可能被别名改写，不报就落空。
  if (opts && typeof opts.onModel === 'function') {
    try { opts.onModel(body.model); } catch (e) { /* 上报失败不影响请求 */ }
  }
  // link 字段：请求日志据此区分主链路与 MaaS 备选链路。
  if (opts && typeof opts.onLink === 'function') {
    try { opts.onLink('maas'); } catch (e) { /* 上报失败不影响请求 */ }
  }
  // MaaS 直连不需要、也不认识应用链路的 chat_context/business/chat_task。
  // 网关发来的是干净 OpenAI chat 形状；这里白名单化避免把私有字段带过去。
  const clean = {
    model: body.model,
    messages: body.messages,
    stream: body.stream,
    // 预算字段：server.js 直连通道已按 qwenwork 档位钳过 max_tokens，不能丢。
    ...(body.max_tokens != null ? { max_tokens: body.max_tokens } : {}),
    ...(body.max_completion_tokens != null ? { max_completion_tokens: body.max_completion_tokens } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { top_p: body.top_p } : {}),
    ...(body.tools ? { tools: body.tools } : {}),
    ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
    ...(body.response_format ? { response_format: body.response_format } : {}),
    ...(body.stream_options ? { stream_options: body.stream_options } : {}),
  };
  const stream = !!(payload && payload.stream);
  const url = `${String(c.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  if (stream) {
    const frames = [];
    const res = await post(url, JSON.stringify(clean), headers(c.accessKey), (inner) => {
      frames.push(inner);
      if (onChunk) onChunk(inner);
    });
    if (res.status === 401 || res.status === 403) {
      invalidate(); // 凭证被拒：下次请求重读缓存，不再拿坏 key 连打
      throw parseError(res.raw, res.status);
    }
    if (res.status >= 400) throw parseError(res.raw, res.status);
    // server.js 的流式分支会自己补 [DONE]。MaaS 已经发了就不要重复。
    // 不在这里补 [DONE]：server.js 的直连分支会在 provider.send 返回后补。
    // post() 已把 MaaS 自己发的 [DONE] 回调给 onChunk，server.js 也会再补一个；
    // 重复 [DONE] 对 OpenAI 客户端无害，但不额外制造。
    return { status: res.status, headers: res.headers, frames };
  }
  const res = await post(url, JSON.stringify(clean), headers(c.accessKey), null);
  if (res.status === 401 || res.status === 403) {
    invalidate();
    throw parseError(res.raw, res.status);
  }
  if (res.status >= 400) throw parseError(res.raw, res.status);
  // 实测 MaaS 即使 stream=false 也回 SSE（text/event-stream）。按同样规则聚合。
  const payloads = [];
  for (const line of String(res.raw || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const inner = t.slice(5).trim();
    if (inner && inner !== '[DONE]') payloads.push(inner);
  }
  if (payloads.length) {
    return aggregate(payloads, body.model);
  }
  // stream=false 实测回 application/json。server.js 的 OpenAI 分支直接把这个
  // 对象送回客户端，所以必须返回标准 chat.completion 形状，不能包 {raw}。
  try {
    return JSON.parse(res.raw);
  } catch (e) {
    throw parseError(res.raw, res.status);
  }
}

module.exports = { enabled, available, meta, normalizeModel, send, invalidate, FREE_MODEL };
