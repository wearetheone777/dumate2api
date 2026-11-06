// src/qwenwork/wsframe.js - RFC 6455 帧编解码（纯函数，零依赖）
//
// 为什么不用 Node 内置 WebSocket：engines 是 node>=18（全局 WebSocket 在
// 21 才实验性出现），且握手要带自定义 Authorization 头——浏览器形状的
// WebSocket 构造器不支持。dsh-connect-qwenwork 的 wsclient 同款结论。
//
// 只实现客户端需要的子集：
//   - 客户端帧必须掩码（RFC 6455 §5.3，不掩码服务端直接断开）
//   - 文本帧收发 + ping/pong/close 控制帧
//   - 分片聚合（opcode 0 = continuation，fin=1 收束）在 decoder 内完成，
//     上层只拿完整消息——agent_message_chunk 偶发跨 TCP 包到达。
'use strict';
const crypto = require('crypto');

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** 编一帧。客户端默认掩码（RFC 6455 §5.3）；测试用的本地服务端回帧传 mask:false */
function encodeFrame(payload, opts = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const opcode = opts.opcode != null ? opts.opcode : OP.TEXT;
  const useMask = opts.mask !== false;
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, (useMask ? 0x80 : 0) | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = (useMask ? 0x80 : 0) | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = (useMask ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!useMask) return Buffer.concat([header, body]);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/** close 帧载荷：2 字节 code + reason */
function encodeClose(code, reason) {
  const r = Buffer.from(String(reason || ''), 'utf8');
  const body = Buffer.alloc(2 + r.length);
  body.writeUInt16BE(code & 0xffff, 0);
  r.copy(body, 2);
  return encodeFrame(body, { opcode: OP.CLOSE });
}

/**
 * 增量解码器：push(chunk) → 完整消息数组。
 * 消息形状：{ opcode: 'text'|'binary'|'ping'|'pong'|'close', data }
 *   text  → data 是解码后的字符串
 *   close → data 是数字状态码（1000 正常 / 1009 消息过大，见上游 32KB 限制）
 * 单帧未 fin 的分片在内部聚合；跨 chunk 的半帧按字节累积。
 */
class FrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.msg = null;   // 进行中的分片聚合 { opcode, chunks }
  }

  /** @returns {Array<{opcode:string, data:any}>} */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < off + 2) break;
        len = this.buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (this.buf.length < off + 8) break;
        const big = this.buf.readBigUInt64BE(off);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          // 超出安全整数的帧按协议错误丢弃整段缓冲（防内存放大）
          this.buf = Buffer.alloc(0);
          this.msg = null;
          out.push({ opcode: 'close', data: 1009 });
          break;
        }
        len = Number(big);
        off += 8;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) break;
      let body = Buffer.from(this.buf.subarray(off + maskLen, off + maskLen + len));
      if (masked) {
        const key = this.buf.subarray(off, off + 4);
        for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
      }
      this.buf = Buffer.from(this.buf.subarray(off + maskLen + len));
      out.push(...this._accept(fin, opcode, body));
    }
    return out;
  }

  _accept(fin, opcode, body) {
    const out = [];
    if (opcode === OP.PING) { out.push({ opcode: 'ping', data: body.toString('utf8') }); return out; }
    if (opcode === OP.PONG) { out.push({ opcode: 'pong', data: body.toString('utf8') }); return out; }
    if (opcode === OP.CLOSE) {
      const code = body.length >= 2 ? body.readUInt16BE(0) : 1005;
      out.push({ opcode: 'close', data: code });
      return out;
    }
    if (opcode === OP.TEXT || opcode === OP.BINARY || opcode === OP.CONT) {
      if (!this.msg) {
        if (opcode === OP.CONT) return out; // 没有起点的 continuation：丢弃
        this.msg = { opcode, chunks: [] };
      }
      this.msg.chunks.push(body);
      if (fin) {
        const full = Buffer.concat(this.msg.chunks);
        const kind = this.msg.opcode === OP.TEXT ? 'text' : 'binary';
        const data = kind === 'text' ? full.toString('utf8') : full;
        this.msg = null;
        out.push({ opcode: kind, data });
      }
    }
    return out;
  }
}

module.exports = { encodeFrame, encodeClose, FrameDecoder, OP };
