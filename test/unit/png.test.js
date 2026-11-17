// test/unit/png.test.js - 纯 JS PNG 编解码 / 缩放的离线验证（P1-6b）
//
// 这里**不复用被测模块的编码器当夹具**（那等于自己证明自己）：解码类的用例
// 用下面手写的 `buildPng` 直接拼 PNG 块与滤波，五种滤波器、灰度、调色板
// 全部覆盖；编码类用例才用 encode → decode 往返比对像素。
//
// 判据：
//   1. 五种滤波器都能反滤波回原始像素（Average 只有解码侧支持，编码侧不选它）
//   2. 灰度/灰度+A/调色板 → 统一展开成 RGB/RGBA，值正确
//   3. 隔行 / 16 位 / 坏图 → 返回 null（**不猜**，调用方原样放行）
//   4. 面积平均缩放：整数倍与非整数倍都对，长边达标，宽高比保持
//   5. shrink 的三条放弃判据：非 PNG / 没超长边 / 缩完更大
//
// 运行：node --test test/unit/png.test.js
const assert = require('assert');
const { test } = require('node:test');
const zlib = require('zlib');
const png = require('../../src/png');

// ---------------------------------------------------------------------------
// 夹具：手写 PNG 写入器（只依赖 zlib + 模块导出的 crc32）
// ---------------------------------------------------------------------------
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(png.crc32(Buffer.concat([head.subarray(4, 8), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * @param {object} o
 *   width/height, colorType, [bitDepth=8], pixels（已按通道展开的 8 位数据）,
 *   filter（0-4，逐行同一滤波器）, plte(Buffer), trns(Buffer), interlace
 */
function buildPng(o) {
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[o.colorType];
  const bpp = ch;
  const stride = o.width * bpp;
  const raw = Buffer.alloc(o.height * (stride + 1));
  const ft = o.filter || 0;
  for (let y = 0; y < o.height; y++) {
    const cur = o.pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? o.pixels.subarray((y - 1) * stride, y * stride) : null;
    const base = y * (stride + 1);
    raw[base] = ft;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      let pred = 0;
      if (ft === 1) pred = a;
      else if (ft === 2) pred = b;
      else if (ft === 3) pred = (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      raw[base + 1 + x] = (cur[x] - pred) & 0xff;
    }
  }
  // 强制改滤波器字节（只改标记不改数据）——用于验证解码侧「未知滤波器返回 null」
  if (o.forceFilter != null) {
    for (let y = 0; y < o.height; y++) raw[y * (stride + 1)] = o.forceFilter;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(o.width, 0);
  ihdr.writeUInt32BE(o.height, 4);
  ihdr[8] = o.bitDepth == null ? 8 : o.bitDepth;
  ihdr[9] = o.colorType;
  ihdr[12] = o.interlace || 0;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (o.plte) parts.push(chunk('PLTE', o.plte));
  if (o.trns) parts.push(chunk('tRNS', o.trns));
  parts.push(chunk('IDAT', zlib.deflateSync(raw)));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function ramp(w, h, ch) {
  const d = Buffer.alloc(w * h * ch);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < ch; c++) d[i * ch + c] = (i * 7 + c * 31) & 0xff;
  }
  return d;
}

// ---------------------------------------------------------------------------
test('五种滤波器都能反滤波回原始像素（Average 只有解码侧支持）', () => {
  const w = 5; const h = 4; const ch = 3;
  const px = ramp(w, h, ch);
  for (const f of [0, 1, 2, 3, 4]) {
    const buf = buildPng({ width: w, height: h, colorType: 2, pixels: px, filter: f });
    const img = png.decode(buf);
    assert.ok(img, `filter=${f} 应能解码`);
    assert.strictEqual(img.width, w);
    assert.strictEqual(img.height, h);
    assert.strictEqual(Buffer.compare(img.data, px), 0, `filter=${f} 像素必须一致`);
  }
});

test('灰度 → RGB，灰度+A → RGBA（值不复用、通道要补齐）', () => {
  const g = buildPng({ width: 3, height: 2, colorType: 0, pixels: Buffer.from([0, 64, 128, 200, 250, 255]) });
  const gi = png.decode(g);
  assert.strictEqual(gi.channels, 3);
  assert.deepStrictEqual([...gi.data.subarray(0, 3)], [0, 0, 0]);
  assert.deepStrictEqual([...gi.data.subarray(3, 6)], [64, 64, 64]);

  const ga = buildPng({
    width: 2, height: 1, colorType: 4,
    pixels: Buffer.from([10, 255, 20, 128]),
  });
  const gai = png.decode(ga);
  assert.strictEqual(gai.channels, 4);
  assert.deepStrictEqual([...gai.data], [10, 10, 10, 255, 20, 20, 20, 128]);
});

test('调色板（含 tRNS）展开成 RGB / RGBA', () => {
  const plte = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const idx = Buffer.from([0, 1, 2, 2]);
  const plain = png.decode(buildPng({ width: 2, height: 2, colorType: 3, pixels: idx, plte }));
  assert.strictEqual(plain.channels, 3);
  assert.deepStrictEqual([...plain.data.subarray(0, 6)], [255, 0, 0, 0, 255, 0]);

  const withTrns = png.decode(buildPng({
    width: 2, height: 2, colorType: 3, pixels: idx, plte,
    trns: Buffer.from([128]),  // 索引 0 半透明，其余不透明
  }));
  assert.strictEqual(withTrns.channels, 4);
  assert.deepStrictEqual([...withTrns.data.subarray(0, 4)], [255, 0, 0, 128]);
  assert.deepStrictEqual([...withTrns.data.subarray(4, 8)], [0, 255, 0, 255], 'tRNS 没覆盖到的索引按不透明');
});

test('不支持的形状一律 null（隔行 / 16 位 / 坏图 / 非 PNG）', () => {
  const px = ramp(3, 3, 3);
  assert.strictEqual(png.decode(buildPng({ width: 3, height: 3, colorType: 2, pixels: px, interlace: 1 })), null, 'Adam7');
  assert.strictEqual(png.decode(buildPng({ width: 3, height: 3, colorType: 2, pixels: px, bitDepth: 16 })), null, '16 位');
  assert.strictEqual(png.decode(Buffer.from('not a png at all')), null);
  assert.strictEqual(png.decode(Buffer.alloc(0)), null);
  // 签名对、块被截断
  const good = buildPng({ width: 3, height: 3, colorType: 2, pixels: px });
  assert.strictEqual(png.decode(good.subarray(0, 30)), null);
  // 未知滤波器值（5）：不猜
  const bad = buildPng({ width: 2, height: 1, colorType: 2, pixels: ramp(2, 1, 3), forceFilter: 5 });
  assert.strictEqual(png.decode(bad), null, '未知滤波器不猜');
  assert.ok(png.isPng(good));
  assert.strictEqual(png.isPng(Buffer.from('GIF89a')), false);
});

test('encode → decode 往返：RGB 与 RGBA 都不失真', () => {
  for (const ch of [3, 4]) {
    const w = 7; const h = 5;
    const px = ramp(w, h, ch);
    const buf = png.encode({ width: w, height: h, channels: ch, data: px });
    assert.ok(png.isPng(buf));
    const back = png.decode(buf);
    assert.strictEqual(back.width, w);
    assert.strictEqual(back.channels, ch);
    assert.strictEqual(Buffer.compare(back.data, px), 0, `${ch} 通道往返必须逐字节一致`);
  }
});

test('面积平均缩放：整数倍取块均值，非整数倍长边达标且保持比例', () => {
  // 2x2 黑 + 白 → 1x1 应为中灰（面积平均，不是取第一个像素）
  const px = Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0]);
  const img = { width: 2, height: 2, channels: 3, data: px };
  const r = png.resize(img, 1);
  assert.strictEqual(r.width, 1);
  assert.strictEqual(r.height, 1);
  assert.deepStrictEqual([...r.data], [128, 128, 128], '四个像素面积相等，均值应约 127~128');

  // 非整数倍：1200x800 → 长边 500 → 500x333
  const big = { width: 1200, height: 800, channels: 3, data: ramp(1200, 800, 3) };
  const s = png.resize(big, 500);
  assert.strictEqual(Math.max(s.width, s.height), 500);
  assert.strictEqual(s.width, 500);
  assert.strictEqual(s.height, 333);
  assert.ok(Math.abs((s.width / s.height) - (1200 / 800)) < 0.01, '宽高比要保住');

  // 没超长边：返回同一对象（调用方用 === 判断「有没有真的缩」）
  assert.strictEqual(png.resize(big, 5000), big);
});

test('shrink 的三条放弃判据：非 PNG / 没超长边 / 缩完不比原图小', () => {
  assert.strictEqual(png.shrink(Buffer.from('fake'), 100), null, '非 PNG');

  const small = png.encode({ width: 20, height: 10, channels: 3, data: ramp(20, 10, 3) });
  assert.strictEqual(png.shrink(small, 100), null, '长边没超就不重编码（重编码只会丢元数据）');

  // 2x2 纯色缩到 1x1：像素少了但 PNG 头部开销占比更大 → 很可能「更大」，如实放弃
  const tiny = png.encode({ width: 2, height: 2, channels: 3, data: Buffer.alloc(12, 7) });
  const out = png.shrink(tiny, 1);
  if (out) assert.ok(out.buffer.length < tiny.length, '若返回了结果就必须真的更小');
});

test('shrink 真缩：大图变小、尺寸达标、还能再解回来', () => {
  const w = 600; const h = 400;
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      data[o] = x & 0xff; data[o + 1] = y & 0xff; data[o + 2] = (x ^ y) & 0xff;
    }
  }
  const src = png.encode({ width: w, height: h, channels: 3, data });
  const out = png.shrink(src, 150);
  assert.ok(out, '应缩成功');
  assert.strictEqual(out.width, 150);
  assert.strictEqual(out.height, 100);
  assert.strictEqual(out.fromWidth, 600);
  assert.ok(out.buffer.length < src.length, '缩完必须更小');
  const back = png.decode(out.buffer);
  assert.strictEqual(back.width, 150);
  assert.strictEqual(back.height, 100);
});
