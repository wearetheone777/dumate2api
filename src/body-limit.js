// src/body-limit.js - 请求体超限的「先回 413、再限时排空」（P1-7）
//
// 出处：docs/WORKBUDDY-FUSION.md P1-7（hub #799：「先返回 413，再在有限时间内
// 排空上传，避免连接重置吞掉响应」）。原实现（server.js 的 readBody）是
// **读完才回**：超过上限时把 chunks 丢掉、`req.resume()` 继续读，但要等 'end'
// 才 resolve——客户端若在传一个 100MB 的大包，413 会被拖到整个上传结束，
// 而中途的 RST 会让客户端只看到「连接被重置」，**看不到那句 413**，于是把它
// 当瞬态网络错误重试/换号重放（Qoder 那条「RST 放大成整池熔断」的教训同源）。
//
// 本模块的口径：
//   1. 一超限就 **立刻 resolve(null)**，handler 当场回 413（带 `Connection: close`
//      让客户端知道别再传了）；
//   2. 后台**限时**排空（默认 5s，`DUMATE_BODY_DRAIN_MS` 可调），到期直接
//      destroy——排空只是为了让内核缓冲与响应有机会送出去，不是义务读完；
//   3. 缓存语义保持原样：`req._rawBody`（鉴权阶段预读）优先返回，`req._bodyTooLarge`
//      短路（同一流只能消费一次）。
//
// 为什么单独成模块：server.js 是「一 require 就监听端口」的脚本，逻辑留在里面
// 就没法离线测。这里只做流的读法与超限处置，不碰响应对象。
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_DRAIN_MS = 5000;

/** 请求体上限（`DUMATE_MAX_BODY_MB`，与 server.js 历史口径一致） */
function maxBodyBytes() {
  const mb = parseInt(process.env.DUMATE_MAX_BODY_MB || '32', 10);
  const n = Number.isFinite(mb) && mb > 0 ? mb : 32;
  return n * 1024 * 1024;
}

/** 排空时限（ms）：0 = 不排空，立即 destroy */
function drainMs() {
  const raw = process.env.DUMATE_BODY_DRAIN_MS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_DRAIN_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DRAIN_MS;
}

/**
 * 读请求体。
 * @param {import('http').IncomingMessage} req
 * @param {{maxBytes?:number, drain?:number, onTooLarge?:Function}} [opts]
 *   onTooLarge(size) 超限时同步回调一次（调用方可在此埋点；不要在里面写响应，
 *   响应由 handler 拿 null 之后发——保持「读」与「写」分离）
 * @returns {Promise<string|null>} null = 超限（或鉴权阶段已判超限）
 */
function readBody(req, opts = {}) {
  const cacheKey = '_rawBody';
  if (req._bodyTooLarge) return Promise.resolve(null);
  if (typeof req[cacheKey] === 'string') return Promise.resolve(req[cacheKey]);

  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : maxBodyBytes();
  const drainFor = Number.isFinite(opts.drain) ? opts.drain : drainMs();

  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let drainTimer = null;
    const finish = (v) => { if (!settled) { settled = true; if (drainTimer) clearTimeout(drainTimer); resolve(v); } };

    req.on('data', (c) => {
      if (settled) return;                       // 已判超限：后台排空阶段不再累积
      size += c.length;
      if (size > maxBytes) {
        req._bodyTooLarge = true;
        chunks.length = 0;
        // 1) 立刻让 handler 拿到 null → 当场回 413
        finish(null);
        // 2) 后台限时排空：读掉内核里已到的数据，让响应有机会送出去
        try { req.resume(); } catch (e) { /* 已结束 */ }
        if (typeof opts.onTooLarge === 'function') {
          try { opts.onTooLarge(size); } catch (e) { /* 埋点失败不影响请求 */ }
        }
        if (drainFor > 0) {
          drainTimer = setTimeout(() => {
            try { req.destroy(); } catch (e) { /* 已销毁 */ }
          }, drainFor);
          if (drainTimer.unref) drainTimer.unref();
        } else {
          try { req.destroy(); } catch (e) { /* 已销毁 */ }
        }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (req._bodyTooLarge) return finish(null);
      finish(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/** 读干净（不需要内容时用）：超限/正常都只关心「流走完了」 */
function drain(req) {
  return new Promise((resolve) => {
    try { req.resume(); } catch (e) { return resolve(); }
    req.on('end', resolve);
    req.on('aborted', resolve);
  });
}

module.exports = { DEFAULT_MAX_BODY_BYTES, DEFAULT_DRAIN_MS, maxBodyBytes, drainMs, readBody, drain };
