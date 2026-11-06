// src/qwenwork/files.js - 千问办公的附件上传（barn）
//
// **这是 P2-17（ACP 会话）的 HTTP 半边**：附件真正进入上游的方式是
// 「barn 预上传拿到 file_uuid」→「在 ACP 会话里引用 file_uuid」。我们目前
// 只做了前半段（HTTP，证据完整、端点已真机验证），后半段（ACP WebSocket
// 帧协议）**没有证据**，见本文件末尾的「未做」说明。
//
// 链路（解包 1.4.0 客户端的 `uploadBytes`，out/main/main.js）：
//
//   POST {barn_url}/barn/v1/upload
//     { path, size, mime_type, metadata, chunk_size }
//     → 201 { session_id, chunk_size }
//   POST {barn_url}/barn/v1/upload/{session_id}/chunks?chunk_number=N
//     Content-Type: application/octet-stream，body = 该分片字节
//   POST {barn_url}/barn/v1/upload/{session_id}     ← 不带 body，收尾
//     → 返回完成体（客户端 `credentialRequest` 解 `data ?? 自身`）
//   失败路径：DELETE {barn_url}/barn/v1/upload/{session_id}
//
// 三个必须照抄的细节：
//
//   1. **分片大小是 `clamp(1MB, 100MB, ceil(size/10))`**——按文件大小均分十份，
//      夹在 1MB~100MB。客户端不是固定 5MB/10MB，照抄才不会在大文件上撞上限。
//   2. **`barn_url` 是 `https://gateway.qwenwork.cn/api`**（`getPagesBaseUrl()`
//      的 CN prod 解析结果），所以完整路径是 `/api/barn/v1/upload`。
//      少写 `/api` 会 404。
//   3. **这些请求走纯 `Authorization: Bearer <token>`，不是 COSY 签名**——
//      `credentialRequest` 只带 `getQwenWorkClientHeaders()` + Bearer，
//      没有 cosy-* 那套头。混用签名头不会失败，但没必要，而且 Bearer 就够了。
//
// 单文件上限：客户端自己校验的是 100MB（`104857600`）；清单里记的「500MB」
// 来自另一处配置，**没有实测依据**，这里按客户端的 100MB 走。
const https = require('https');
const crypto = require('crypto');
const c = require('./constants');
const authStore = require('./auth');
const chat = require('./chat');
const sign = require('./cosy-sign');

const TIMEOUT_MS = 300000; // 大文件上传给足时间（客户端侧是 3e5 超时）

/** barn 的基址：GATEWAY + '/api'（`getPagesBaseUrl()` 的 CN prod 结果） */
function barnBase() {
  return `${c.GATEWAY}/api`;
}

/** 单文件上限（客户端 `104857600`） */
const MAX_FILE_BYTES = 104857600;

/**
 * 分片大小：`clamp(1MB, 100MB, ceil(size/10))`。
 * 纯函数，便于离线验证边界（0 字节 / 10MB / 1GB 超限）。
 */
function chunkSizeFor(size) {
  const n = Math.max(0, Number(size) || 0);
  return Math.max(1024 * 1024, Math.min(100 * 1024 * 1024, Math.ceil(n / 10)));
}

/**
 * 上传一个字节缓冲到 barn，返回 { file_uuid, ... }。
 *
 * `path` 是上游文件树里的相对路径（客户端传的是页面发布用的相对路径）。
 * 我们这边由调用方给（通常是原始文件名），上游不校验它是否真实存在。
 *
 * @param {Buffer} bytes
 * @param {{path:string, mimeType?:string, metadata?:object, account?:object, onProgress?:function}} opts
 */
async function uploadBytes(bytes, opts = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buf.length > MAX_FILE_BYTES) {
    const err = new Error(`文件 ${(buf.length / 1048576).toFixed(1)}MB 超过单文件上限 ${MAX_FILE_BYTES / 1048576}MB`);
    err.statusCode = 413;
    throw err;
  }
  const account = await chat.ensureAccount(authStore, opts.account || authStore.preferred());
  if (!account) {
    const err = new Error('千问办公没有可用账号，请先添加一个');
    err.statusCode = 503;
    throw err;
  }
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
    const err = new Error(`出站代理配置错误: ${e.message}`);
    err.statusCode = 500;
    throw err;
  }

  const size = buf.length;
  const chunkSize = chunkSizeFor(size);
  const filePath = String(opts.path || 'upload.bin');
  const headers = {
    ...sign.clientHeaders(),
    Authorization: `Bearer ${account.accessToken}`,
    Accept: 'application/json',
    'X-QwenWork-App-Mode': 'desktop',
  };

  const req1 = await httpJson({
    method: 'POST',
    url: `${barnBase()}/barn/v1/upload`,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: filePath,
      size,
      mime_type: opts.mimeType || 'application/octet-stream',
      metadata: opts.metadata || {},
      chunk_size: chunkSize,
    }),
    agent,
  });
  const sessionId = req1.body && req1.body.session_id;
  if (!sessionId) {
    const err = new Error(`barn 未创建上传会话: HTTP ${req1.status} ${String(req1.raw || '').slice(0, 200)}`);
    err.statusCode = 502;
    throw err;
  }

  try {
    let chunkNo = 0;
    for (let off = 0; off < size; off += chunkSize, chunkNo += 1) {
      const part = buf.subarray(off, Math.min(off + chunkSize, size));
      const r = await httpJson({
        method: 'POST',
        url: `${barnBase()}/barn/v1/upload/${encodeURIComponent(sessionId)}/chunks?chunk_number=${chunkNo}`,
        headers: { ...headers, 'Content-Type': 'application/octet-stream' },
        body: part,
        agent,
      });
      if (r.status !== 200 && r.status !== 201) {
        const err = new Error(`barn 分片 ${chunkNo} 上传失败: HTTP ${r.status} ${String(r.raw || '').slice(0, 200)}`);
        err.statusCode = r.status >= 400 && r.status < 600 ? r.status : 502;
        throw err;
      }
      if (typeof opts.onProgress === 'function') {
        try { opts.onProgress(Math.min(off + chunkSize, size), size); } catch (e) { /* 回调失败不影响上传 */ }
      }
    }
    // 收尾：**不带 body**（客户端传 `void 0`）
    const done = await httpJson({
      method: 'POST',
      url: `${barnBase()}/barn/v1/upload/${encodeURIComponent(sessionId)}`,
      headers,
      body: null,
      agent,
    });
    if (done.status !== 200 && done.status !== 201) {
      const err = new Error(`barn 收尾失败: HTTP ${done.status} ${String(done.raw || '').slice(0, 200)}`);
      err.statusCode = done.status >= 400 && done.status < 600 ? done.status : 502;
      throw err;
    }
    // 客户端的 credentialRequest 解 `data ?? 自身`：完成体可能在 data 里
    const d = (done.body && typeof done.body.data === 'object' && done.body.data) || done.body || {};
    return {
      ok: true,
      sessionId,
      size,
      path: filePath,
      // file_uuid 由**上游下发**（客户端代码里 `J.object({file_uuid, file_name})`），
      // 不是客户端生成。字段名上游可能有变体，这里按候选取，取不到如实 null。
      fileUuid: d.file_uuid || d.fileUuid || d.uuid || null,
      fileName: d.file_name || d.fileName || filePath,
      raw: d,
    };
  } catch (e) {
    // 失败清理：DELETE 同一 session（客户端同样在 catch 里发，且不 await 结果）
    httpJson({
      method: 'DELETE',
      url: `${barnBase()}/barn/v1/upload/${encodeURIComponent(sessionId)}`,
      headers,
      body: null,
      agent,
    }).catch(() => {});
    throw e;
  }
}

/**
 * 取附件内容（`GET /api/oauth/files/{file_uuid}/content`，Bearer）。
 *
 * 客户端 worker 侧 `attachments.download` 用的就是它——这是把上游文件读回来的
 * 唯一方式。**注意它走的是 `/api/oauth/files/...` 而不是 barn 路径**。
 */
async function downloadFile(fileUuid, opts = {}) {
  const id = String(fileUuid || '').trim();
  if (!id) {
    const err = new Error('file_uuid 不能为空');
    err.statusCode = 400;
    throw err;
  }
  const account = await chat.ensureAccount(authStore, opts.account || authStore.preferred());
  if (!account) {
    const err = new Error('千问办公没有可用账号，请先添加一个');
    err.statusCode = 503;
    throw err;
  }
  let agent = null;
  try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) {
    const err = new Error(`出站代理配置错误: ${e.message}`);
    err.statusCode = 500;
    throw err;
  }
  const r = await httpJson({
    method: 'GET',
    url: `${c.GATEWAY}/api/oauth/files/${encodeURIComponent(id)}/content`,
    headers: { ...sign.clientHeaders(), Authorization: `Bearer ${account.accessToken}` },
    body: null,
    agent,
    raw: true,
  });
  if (r.status !== 200) {
    const err = new Error(`取附件失败: HTTP ${r.status} ${String(r.raw || '').slice(0, 200)}`);
    err.statusCode = r.status >= 400 && r.status < 600 ? r.status : 502;
    throw err;
  }
  return { buffer: r.buffer, contentType: r.contentType || 'application/octet-stream' };
}

/**
 * 一次 HTTP 往返。body 可以是字符串（JSON）、Buffer（二进制）或 null。
 *
 * 不用 chat.post 是因为那个强制 `Accept: text/event-stream` 且假设 SSE 语义，
 * 而 barn 是普通 REST。这里保持独立、最小。
 */
function httpJson({ method, url, headers, body, agent, raw = false }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) {
      const err = new Error(`非法 URL: ${url}`);
      err.statusCode = 500;
      return reject(err);
    }
    const payload = body == null ? null
      : Buffer.isBuffer(body) ? body
        : Buffer.from(String(body));
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        ...headers,
        ...(payload ? { 'Content-Length': payload.length } : {}),
      },
      timeout: TIMEOUT_MS,
      ...(agent ? { agent } : {}),
    }, (res) => {
      if (raw) {
        // 二进制下载：不累积成字符串，直接拼 Buffer
        const chunks = [];
        res.on('data', (x) => chunks.push(x));
        res.on('end', () => resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          buffer: Buffer.concat(chunks),
          raw: Buffer.concat(chunks).toString('utf8').slice(0, 400),
        }));
        res.on('error', reject);
        return;
      }
      let buf = '';
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      res.on('data', (x) => { buf += dec.write(x); });
      res.on('end', () => {
        const raw2 = buf + dec.end();
        let parsed = null;
        try { parsed = JSON.parse(raw2); } catch (e) { /* 非 JSON 保留 raw */ }
        resolve({ status: res.statusCode, body: parsed, raw: raw2, contentType: res.headers['content-type'] || '' });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('qwenwork barn timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = {
  uploadBytes, downloadFile, chunkSizeFor, barnBase,
  MAX_FILE_BYTES,
};
