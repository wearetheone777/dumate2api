// src/png.js - 纯 JS 的 PNG 解码 / 缩小 / 重编码（零依赖，只用内置 zlib）
//
// 为什么自己写：调研 P1-6 要「转发前把 base64 大图缩长边并重编码」，而 JPEG
// 需要 huffman 解码 + 重编码（量大），PNG 只需要 inflate + 反滤波 + 重压——
// 而**截图粘贴进 Codex/Claude Code 恰好几乎都是 PNG**。所以先做 PNG 这一半，
// 不求通用（不做 Adam7 隔行、不做 16 位、不做 <8 位调色板），求**可自证**：
// 解码 → 缩小 → 编码 → 再解码，尺寸与像素都能逐字节比对。
//
// 边界（每一条都是「宁可返回 null 让调用方走原来的路」）：
//   - 隔行（Adam7）→ null。截图非隔行，且隔行反滤波要重排整幅，收益为零。
//   - 位深 16 / 小于 8（含 1/2/4 位调色板）→ null。
//   - 灰度/灰度+Alpha/调色板 → **统一输出 RGB 或 RGBA**（编码侧只有 2/6 两种
//     colorType）。调色板展开后体积会变大，但缩小后的像素数少得多，净效果仍是变小。
//   - CRC 不校验：这里只做「能不能安全地重编码」，不做完整性认定；坏图在
//     inflate/反滤波阶段就会抛，由上层吞掉。
//
// 缩放用**面积平均（box filter）**而不是最近邻：截图里的文字用最近邻会出现
// 锯齿和笔画断裂，面积平均仍然可读。alpha 直接平均**不做预乘**——截图 alpha
// 基本恒为 255，为它引入预乘/反预乘只会在半透明边缘引入色偏。
const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 该 Buffer 是不是 PNG（只看 8 字节签名） */
function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 8).equals(SIGNATURE);
}

/** PNG colorType → 通道数（0=灰,2=RGB,3=调色板,4=灰+A,6=RGBA） */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** 把 Buffer 按 PNG 块拆开（不校验 CRC） */
function readChunks(buf) {
  const out = { ihdr: null, plte: null, trns: null, idat: [], end: false };
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const start = off + 8;
    const end = start + len;
    if (len < 0 || end + 4 > buf.length) break;   // 坏块：停在这里，已读到的够用
    const data = buf.subarray(start, end);
    if (type === 'IHDR') out.ihdr = data;
    else if (type === 'PLTE') out.plte = data;
    else if (type === 'tRNS') out.trns = data;
    else if (type === 'IDAT') out.idat.push(data);
    else if (type === 'IEND') { out.end = true; break; }
    off = end + 4; // 跳过 CRC
  }
  return out;
}

/**
 * 解码成 { width, height, channels, data }（8 位；channels 只可能是 1~4）。
 * @returns {object|null} null = 不支持/坏图（调用方原样放行，不猜）
 */
function decode(buf) {
  if (!isPng(buf)) return null;
  const c = readChunks(buf);
  if (!c.ihdr || c.ihdr.length < 13 || !c.idat.length) return null;
  const width = c.ihdr.readUInt32BE(0);
  const height = c.ihdr.readUInt32BE(4);
  const bitDepth = c.ihdr[8];
  const colorType = c.ihdr[9];
  const compression = c.ihdr[10];
  const filterMethod = c.ihdr[11];
  const interlace = c.ihdr[12];
  if (!width || !height) return null;
  if (bitDepth !== 8) return null;              // 16 位 / 亚字节位深不支持
  if (compression !== 0 || filterMethod !== 0) return null;
  if (interlace !== 0) return null;             // Adam7 不做
  const srcCh = CHANNELS[colorType];
  if (!srcCh) return null;
  if (colorType === 3 && !c.plte) return null;

  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(c.idat)); } catch (e) { return null; }
  const bpp = srcCh;                             // 8 位下 bpp == 通道数
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return null;

  // 反滤波（PNG 规范 9.2 的五种滤波器）
  const pix = Buffer.alloc(height * stride);
  let ro = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[ro++];
    const line = raw.subarray(ro, ro + stride);
    ro += stride;
    const cur = pix.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pix.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const cc = (prev && x >= bpp) ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 0) { /* None */ }
      else if (ft === 1) v = (v + a) & 0xff;
      else if (ft === 2) v = (v + b) & 0xff;
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (ft === 4) v = (v + paeth(a, b, cc)) & 0xff;
      else return null;                          // 未知滤波器：不猜
      cur[x] = v;
    }
  }

  // 调色板 / 灰度 → 统一展开成 RGB(A)，编码侧只有 2/6 两种 colorType
  if (colorType === 2 || colorType === 6) {
    return { width, height, channels: srcCh, data: pix };
  }
  const hasAlpha = colorType === 4 || (colorType === 3 && !!c.trns);
  const outCh = hasAlpha ? 4 : 3;
  const out = Buffer.alloc(width * height * outCh);
  for (let i = 0, o = 0; i < width * height; i++, o += outCh) {
    if (colorType === 0) {                     // 灰度 → RGB
      const g = pix[i];
      out[o] = g; out[o + 1] = g; out[o + 2] = g;
    } else if (colorType === 4) {              // 灰度+A → RGBA
      const g = pix[i * 2];
      out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = pix[i * 2 + 1];
    } else {                                   // 调色板
      const idx = pix[i];
      const p = idx * 3;
      if (p + 2 >= c.plte.length) return null;
      out[o] = c.plte[p]; out[o + 1] = c.plte[p + 1]; out[o + 2] = c.plte[p + 2];
      if (hasAlpha) out[o + 3] = idx < c.trns.length ? c.trns[idx] : 0xff;
    }
  }
  return { width, height, channels: outCh, data: out };
}

/** Paeth 预测器（PNG 规范 9.4） */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 重编码成 PNG。**总是 8 位**：无 alpha → colorType 2（RGB），有 alpha → 6（RGBA）。
 *
 * 逐行在三/四种滤波器里挑代价最小的（None / Sub / Up / Paeth 的近似：残差
 * 绝对值之和）。比固定 None 小 10~30%，比全试 5 种省一次遍历。
 */
function encode(img) {
  const { width, height, channels, data } = img;
  const colorType = channels === 4 ? 6 : 2;
  const bpp = channels;
  const stride = width * bpp;
  const raw = Buffer.alloc(height * (stride + 1));
  const cand = [0, 1, 2, 4];
  for (let y = 0; y < height; y++) {
    const cur = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    let best = null;
    let bestCost = Infinity;
    let bestFt = 0;
    for (const ft of cand) {
      const line = Buffer.alloc(stride);
      let cost = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0;
        const b = prev ? prev[x] : 0;
        const cc = (prev && x >= bpp) ? prev[x - bpp] : 0;
        let pred = 0;
        if (ft === 1) pred = a;
        else if (ft === 2) pred = b;
        else if (ft === 4) pred = paeth(a, b, cc);
        const v = (cur[x] - pred) & 0xff;
        line[x] = v;
        cost += v < 128 ? v : 256 - v;           // 有符号残差的绝对值
        if (cost >= bestCost) break;             // 早停：已经不可能更优
      }
      if (cost < bestCost) { bestCost = cost; best = line; bestFt = ft; }
    }
    const o = y * (stride + 1);
    raw[o] = bestFt;
    best.copy(raw, o + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;            // bitDepth
  ihdr[9] = colorType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4, 8), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

// PNG 用的是标准 CRC-32（与 IEEE 802.3 同多项式）。Node 的 zlib.crc32 在
// 20.x 才有，这里自带一张查表，避免版本差异。
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 面积平均缩小。长边超过 maxEdge 才缩；否则**返回同一对象**（调用方可用
 * `===` 判断有没有真的缩）。
 *
 * 权重按源像素落在目标像素矩形内的**面积**算，所以非整数倍缩放也不会走样。
 */
function resize(img, maxEdge) {
  const { width, height, channels, data } = img;
  const long = Math.max(width, height);
  if (!(maxEdge > 0) || long <= maxEdge) return img;
  const scale = maxEdge / long;
  const dw = Math.max(1, Math.round(width * scale));
  const dh = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(dw * dh * channels);

  // 预计算每条目标边界的源区间与权重（横向、纵向各一次，避免重复算）
  const xw = weights(width, dw);
  const yw = weights(height, dh);
  const acc = new Float64Array(channels);
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      acc.fill(0);
      let wsum = 0;
      for (const [sy, wy] of yw[dy]) {
        const rowOff = sy * width;
        for (const [sx, wx] of xw[dx]) {
          const w = wx * wy;
          const p = (rowOff + sx) * channels;
          for (let ch = 0; ch < channels; ch++) acc[ch] += data[p + ch] * w;
          wsum += w;
        }
      }
      const o = (dy * dw + dx) * channels;
      for (let ch = 0; ch < channels; ch++) {
        out[o + ch] = wsum ? Math.round(acc[ch] / wsum) : 0;
      }
    }
  }
  return { width: dw, height: dh, channels, data: out };
}

/** 一维的「目标像素 → 源像素与权重」表（面积加权） */
function weights(srcLen, dstLen) {
  const ratio = srcLen / dstLen;
  const table = [];
  for (let d = 0; d < dstLen; d++) {
    const s0 = d * ratio;
    const s1 = Math.min(srcLen, (d + 1) * ratio);
    const list = [];
    for (let s = Math.floor(s0); s < Math.ceil(s1); s++) {
      const lo = Math.max(s, s0);
      const hi = Math.min(s + 1, s1);
      if (hi > lo) list.push([s, hi - lo]);
    }
    table.push(list.length ? list : [[Math.min(srcLen - 1, Math.floor(s0)), 1]]);
  }
  return table;
}

/**
 * PNG Buffer → 缩到 maxEdge 后重编码。三层判据全在这里，调用方只看返回值：
 *   - 不是 PNG / 解不动 → null（原样放行，不猜）
 *   - 长边本来就没超 → null（没缩小就没必要重编码，重编码只会丢元数据）
 *   - 缩完编码后**不比原图小** → null（缩小但编码变大是白忙，如实放弃）
 *
 * @returns {{buffer:Buffer, width:number, height:number, fromWidth:number, fromHeight:number}|null}
 */
function shrink(buf, maxEdge) {
  const img = decode(buf);
  if (!img) return null;
  const small = resize(img, maxEdge);
  if (small === img) return null;
  let out;
  try { out = encode(small); } catch (e) { return null; }
  if (!out || out.length >= buf.length) return null;
  return {
    buffer: out,
    width: small.width,
    height: small.height,
    fromWidth: img.width,
    fromHeight: img.height,
  };
}

module.exports = { isPng, decode, encode, resize, shrink, crc32 };
