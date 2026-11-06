// src/qwenwork/wsclient.js - 无依赖 WebSocket 客户端（RFC 6455 子集）
//
// 协议证据与结论来自 dsh-connect-qwenwork 的实测（2026-10-22，本仓库
// README 全文记录）：ACP 会话走 wss://qwenwork.cn/api/chat-ws，握手要带
// Authorization: Bearer——浏览器形状的 WebSocket 构造器不支持自定义头，
// Node>=18 也还没有稳定的全局 WebSocket，所以手写握手。
//
// 只做客户端需要的部分：upgrade 握手、文本帧收发、自动回 pong、close、
// 读空闲看门狗（上游 agent 会话卡死时断开而不是永远挂着——与 qoder 通道
// armReadIdle 同一教训）。
'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { encodeFrame, encodeClose, FrameDecoder } = require('./wsframe');

const DEFAULT_IDLE_MS = 120000;   // 读空闲：2 秒沙箱启动 vs 分钟级卡死之间的折中

class WsClient {
  /**
   * @param {string} url wss://… 或 ws://…
   * @param {object} headers 额外握手头（Authorization 等）
   * @param {object} [opts] { idleMs, onMessage(msg), onClose(code), onError(e) }
   */
  constructor(url, headers = {}, opts = {}) {
    this.url = new URL(url);
    this.headers = headers;
    this.opts = opts;
    this.socket = null;
    this.decoder = new FrameDecoder();
    this.closed = false;
    this.idleMs = Number(opts.idleMs) > 0 ? Number(opts.idleMs) : DEFAULT_IDLE_MS;
    this._idleTimer = null;
  }

  /** 完成升级握手。resolve 后可以 send() */
  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const isTls = this.url.protocol === 'wss:';
      const mod = isTls ? https : http;
      const req = mod.request({
        hostname: this.url.hostname,
        port: this.url.port || (isTls ? 443 : 80),
        path: this.url.pathname + this.url.search,
        headers: {
          ...this.headers,
          Host: this.url.host,
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
        // ACP 网关对 Agent 会话可能走重定向/代理场景，跟随由上层控制——
        // 这里不做重定向（upgrade 响应不会有 3xx 的正常语义）
        setHost: false,
      });
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('qwenwork ACP: websocket 握手超时'));
      });
      req.on('upgrade', (res, socket) => {
        req.setTimeout(0);
        // 服务端必须回 Sec-WebSocket-Accept = base64(sha1(key + GUID))
        const expect = crypto.createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (res.headers['sec-websocket-accept'] !== expect) {
          socket.destroy();
          return reject(new Error('qwenwork ACP: websocket 握手校验失败'));
        }
        this.socket = socket;
        socket.setNoDelay(true);
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('close', () => this._onClose(1006));
        socket.on('error', (e) => this._onError(e));
        this._armIdle();
        resolve(this);
      });
      req.on('response', (res) => {
        // 服务端拒绝升级：拿状态码如实报（401 = 凭证失效）
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => {
          req.destroy();
          const e = new Error(`qwenwork ACP: websocket 握手被拒 HTTP ${res.statusCode}${b ? ': ' + b.slice(0, 160) : ''}`);
          e.statusCode = res.statusCode;
          reject(e);
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  _onData(chunk) {
    this._armIdle();
    for (const m of this.decoder.push(chunk)) {
      if (m.opcode === 'ping') {
        this._raw(encodeFrame(m.data || '', { opcode: 0xa }));
        continue;
      }
      if (m.opcode === 'close') { this._onClose(m.data); return; }
      if (m.opcode === 'text' || m.opcode === 'binary') {
        try { if (this.opts.onMessage) this.opts.onMessage(m); } catch (e) { this._onError(e); }
      }
    }
  }

  _onClose(code) {
    if (this.closed) return;
    this.closed = true;
    this._clearIdle();
    try { if (this.socket) this.socket.destroy(); } catch (e) { /* 已断 */ }
    if (this.opts.onClose) try { this.opts.onClose(code); } catch (e) { /* 回调失败不影响 */ }
  }

  _onError(e) {
    if (this.opts.onError) try { this.opts.onError(e); } catch (err) { /* 同上 */ }
  }

  _armIdle() {
    this._clearIdle();
    if (!this.idleMs || this.closed) return;
    this._idleTimer = setTimeout(() => {
      const e = new Error(`qwenwork ACP: websocket 读空闲 ${this.idleMs}ms，连接掐断`);
      e.idle = true;
      this._onError(e);
      this._onClose(1006);
    }, this.idleMs);
    if (typeof this._idleTimer.unref === 'function') this._idleTimer.unref();
  }

  _clearIdle() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }

  _raw(buf) {
    if (!this.socket || this.closed) return false;
    try { this.socket.write(buf); return true; } catch (e) { return false; }
  }

  /** 发一条文本帧（自动掩码） */
  send(text) { return this._raw(encodeFrame(String(text), { opcode: 0x1 })); }

  /** 主动关闭（发 close 帧后断开） */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    this._raw(encodeClose(code, reason));
    // 给对端一个冲刷窗口再销毁——不发 close 直接 destroy 在部分网关侧算异常断开
    setTimeout(() => this._onClose(code), 50);
    if (typeof this.socket !== 'undefined' && this.socket) {
      try { this.socket.end(); } catch (e) { /* 已断 */ }
    }
  }
}

module.exports = { WsClient, DEFAULT_IDLE_MS };
