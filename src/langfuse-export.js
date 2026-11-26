// src/langfuse-export.js - Langfuse 可选导出（2026-11-27，A7）
//
// 纪律：
//   1. 默认关。必须 DUMATE_QWENWORK_LANGFUSE=1（或 DUMATE_LANGFUSE=1）且 URL/KEY 齐全。
//   2. 只导出 reqlog 已有的请求级字段，不导出请求/响应正文、不导出 API key/账号 token。
//   3. 全异步、单飞有界、失败吞掉；Langfuse 不可达时网关行为完全不变。
//   4. 不做 SDK 依赖：用 Node 内置 https/http POST /api/public/ingestion。
const http = require('http');
const https = require('https');

const ENABLED = ['1', 'true', 'yes'].includes(String(process.env.DUMATE_QWENWORK_LANGFUSE || process.env.DUMATE_LANGFUSE || '').toLowerCase());
const URL_RAW = process.env.DUMATE_LANGFUSE_URL || '';
const KEY = process.env.DUMATE_LANGFUSE_KEY || '';
const QWEN_ONLY = process.env.DUMATE_LANGFUSE_QWENWORK_ONLY !== '0'; // 默认只导千问通道

const fs = require('fs');
const path = require('path');

let queue = [];
let flushing = false;
let broken = false;
const LOG_FILE = process.env.DUMATE_LANGFUSE_LOCAL_LOG
  || path.join(process.env.DUMATE_ADMIN_DATA || path.join(__dirname, '..', 'data'), 'langfuse-local.jsonl');
const LOCAL_LOG_MAX = 500;

function configured() {
  if (broken || !ENABLED || !URL_RAW || !KEY) return false;
  try { new URL(URL_RAW); return true; } catch (e) { return false; }
}

function buildEvent(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (QWEN_ONLY && String(entry.channel || '') !== 'qwenwork') return null;
  const id = String(entry.req_id || `${entry.ts}-${Math.random().toString(36).slice(2)}`);
  const ts = new Date(entry.ts || Date.now()).toISOString();
  const status = Number(entry.status) || 0;
  const usage = {
    input: Number(entry.input_tokens) || 0,
    output: Number(entry.output_tokens) || 0,
    total: Number(entry.total_tokens) || 0,
    unit: 'TOKENS',
  };
  const body = {
    batch: [
      {
        id: `trace-${id}`,
        type: 'trace-create',
        timestamp: ts,
        body: {
          id: `trace-${id}`,
          name: `gateway:${entry.channel || 'dumate'}`,
          timestamp: ts,
          metadata: {
            req_id: id, path: entry.path || '', model: entry.model || '',
            mapped_model: entry.mapped_model || '', real_model: entry.real_model || '',
            stream: !!entry.stream, messages: Number(entry.messages) || 0,
            account: entry.account || '', key_name: entry.key || '',
            status, route_group: entry.route_group || '',
          },
        },
      },
      {
        id: `span-${id}`,
        type: 'span-create',
        timestamp: ts,
        body: {
          id: `span-${id}`,
          traceId: `trace-${id}`,
          name: 'chat.completion',
          startTime: ts,
          endTime: new Date((entry.ts || Date.now()) + (Number(entry.ms) || 0)).toISOString(),
          model: entry.mapped_model || entry.model || undefined,
          usage,
          // 状态未知（0）或 >=400 都标 ERROR：埋点收尾失败时 status 会是 0，
          // 把它当成功会把失败请求记成正常。
          level: status >= 400 || !status ? 'ERROR' : 'DEFAULT',
          statusMessage: status >= 400 || !status ? String(entry.error || (status ? `HTTP ${status}` : 'unknown status')) : undefined,
          metadata: {
            channel: entry.channel || '', latency_ms: Number(entry.ms) || 0,
            first_token_ms: entry.first_token_ms == null ? null : Number(entry.first_token_ms),
          },
        },
      },
    ],
  };
  return { id, body: JSON.stringify(body) };
}

/** 第三层投递（本地日志）：只在“已配置但投递失败”时落盘，且只写事件 id/status，
 *  不写任何正文/凭证。有界轮转，避免 Langfuse 长时间不可达时把磁盘写满。 */
function logLocalFailure(evt) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), id: evt.id, failed: true }) + '\n';
    let st;
    try { st = fs.statSync(LOG_FILE); } catch (e) { st = null; }
    if (st && st.size > 1024 * 1024) {
      try {
        const rows = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-LOCAL_LOG_MAX);
        const tmp = `${LOG_FILE}.tmp`;
        fs.writeFileSync(tmp, rows.join('\n') + '\n');
        fs.renameSync(tmp, LOG_FILE);
      } catch (e) { /* ignore */ }
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) { /* ignore */ }
}

function postEvent(evt) {
  return new Promise((resolve) => {
    try {
      const u = new URL(URL_RAW);
      const path = `${u.pathname.replace(/\/+$/, '')}/api/public/ingestion`;
      const mod = u.protocol === 'https:' ? https : http;
      let done = false;
      const finish = (failed) => {
        if (done) return;
        done = true;
        if (failed) logLocalFailure(evt);
        resolve();
      };
      const req = mod.request({
        hostname: u.hostname, port: u.port || undefined, path,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(evt.body),
        },
        timeout: 5000,
      }, (res) => { res.resume(); res.on('end', () => finish(res.statusCode >= 400)); });
      req.on('error', () => finish(true));
      req.on('timeout', () => { req.destroy(); finish(true); });
      req.write(evt.body);
      req.end();
    } catch (e) { resolve(); }
  });
}

async function flush() {
  if (flushing || !configured() || !queue.length) return;
  flushing = true; // 单飞：多个 exportEntry 可能同时 setImmediate(flush)
  try {
    while (queue.length && configured()) {
      const batch = queue.splice(0, 100);
      for (const evt of batch) await postEvent(evt);
    }
  } catch (e) { /* 外部导出失败不影响网关 */ }
  flushing = false;
}

function exportEntry(entry) {
  if (!configured()) return;
  const evt = buildEvent(entry);
  if (!evt) return;
  queue.push(evt);
  if (queue.length > 1000) queue.shift();
  setImmediate(flush);
}

function meta() {
  return { enabled: ENABLED, configured: configured(), qwenworkOnly: QWEN_ONLY, queued: queue.length, localLog: LOG_FILE };
}

module.exports = { exportEntry, buildEvent, meta, configured };
