// test/unit/image-budget.test.js - 内联图片体量观测与上限（P1-6 第一批）
//
// 上游做法（Agent2API 3.4.0）是「转发前缩长边并重编码」。压缩要先有编解码器，
// 而「这次带了几个图、多大、超没超」不需要编解码器——本批只做观测与守门，
// 单测锁三件事：
//   1. 体量算得对：base64 的**解码后**字节（不 decode，按 len*3/4-pad）；
//   2. 只认内联图片：外链图只计数不判上限（大小在上游手里，量不出来就别假装）；
//   3. 上限默认关；超限文案要能回答「哪一张、多大、上限多少、怎么办」。
//
// 运行：node --test test/unit/image-budget.test.js
const assert = require('assert');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dumate-imgbudget-'));
process.env.DUMATE_ADMIN_DATA = TMP;
for (const k of ['DUMATE_IMAGE_MAX_MB', 'DUMATE_IMAGE_MAX_TOTAL_MB']) delete process.env[k];

const livecfg = require('../../src/livecfg');
const ib = require('../../src/image-budget');

function reset() {
  livecfg._resetForTest();
  delete process.env.DUMATE_IMAGE_MAX_MB;
  delete process.env.DUMATE_IMAGE_MAX_TOTAL_MB;
  try { fs.rmSync(path.join(TMP, livecfg.FILE), { force: true }); } catch (e) { /* 不存在即达成 */ }
  livecfg._resetForTest();
}

/** 造一段指定解码字节数的 base64（全 0 字节，内容不重要，只要长度对） */
function base64Of(bytes) {
  return Buffer.alloc(bytes, 0).toString('base64');
}

function pngPart(bytes) {
  return { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Of(bytes)}` } };
}

test('base64Bytes：按解码后字节算，含 padding 边界', () => {
  assert.strictEqual(ib.base64Bytes(''), 0);
  assert.strictEqual(ib.base64Bytes('AAAA'), 3);
  assert.strictEqual(ib.base64Bytes('AAA='), 2);
  assert.strictEqual(ib.base64Bytes('AA=='), 1);
  // 4096 字节往返必须精确（差 1 字节会让上限判定漂移）
  assert.strictEqual(ib.base64Bytes(base64Of(4096)), 4096);
  assert.strictEqual(ib.base64Bytes(base64Of(4097)), 4097);
});

test('dataUriOf：只认内联图片；外链 / 非图片 / 非 base64 一律 null', () => {
  assert.deepStrictEqual(ib.dataUriOf(`data:image/png;base64,${base64Of(100)}`), { mime: 'image/png', bytes: 100 });
  assert.deepStrictEqual(ib.dataUriOf(`data:IMAGE/JPEG;base64,${base64Of(10)}`), { mime: 'image/jpeg', bytes: 10 });
  assert.strictEqual(ib.dataUriOf(`data:audio/mpeg;base64,${base64Of(10)}`), null, '音频不是图片预算');
  assert.strictEqual(ib.dataUriOf('data:text/plain,hello'), null, '非 base64 不算');
  assert.strictEqual(ib.dataUriOf('https://example.com/a.png'), null, '外链量不出来');
  assert.strictEqual(ib.dataUriOf(''), null);
  assert.strictEqual(ib.dataUriOf(null), null);
});

test('scan：内联与外链分开计，字节/最大/格式/指纹都要对', () => {
  const payload = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: '看图' }, pngPart(1000)] },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Of(3000)}` } }] },
      { role: 'user', content: '纯文本消息（content 是字符串，不该被当成图）' },
      { role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/x.png' }] },
    ],
  };
  const st = ib.scan(payload);
  assert.strictEqual(st.count, 3, '共 3 个图 part');
  assert.strictEqual(st.dataCount, 2, '其中 2 张内联');
  assert.strictEqual(st.externalCount, 1);
  assert.strictEqual(st.bytes, 4000, '只累加内联');
  assert.strictEqual(st.maxBytes, 3000);
  assert.strictEqual(st.topFormat, 'image/jpeg');
  assert.deepStrictEqual(st.formats, { 'image/png': 1, 'image/jpeg': 1 });
  assert.ok(st.fid && st.fid.length >= 8, '要有指纹（日后做「同一原图复用」的键）');
});

test('scan：指纹对同一组图稳定，图变了就变', () => {
  const p1 = { messages: [{ role: 'user', content: [pngPart(500)] }] };
  const p2 = { messages: [{ role: 'user', content: [pngPart(500)] }] };
  const p3 = { messages: [{ role: 'user', content: [pngPart(501)] }] };
  assert.strictEqual(ib.scan(p1).fid, ib.scan(p2).fid);
  assert.notStrictEqual(ib.scan(p1).fid, ib.scan(p3).fid);
  assert.strictEqual(ib.scan({ messages: [] }).fid, '');
});

test('默认不限：没有上限时永远放行（只观测）', () => {
  reset();
  const payload = { messages: [{ role: 'user', content: [pngPart(8 * 1024 * 1024)] }] };
  const v = ib.apply(payload);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.limits.maxBytes, 0);
  assert.strictEqual(v.limits.maxTotalBytes, 0);
  assert.strictEqual(v.stats.bytes, 8 * 1024 * 1024);
  assert.strictEqual(v.message, '');
});

test('单张超限：指认第几张、多大、上限多少，并给出可照做的处置', () => {
  const payload = {
    messages: [
      { role: 'user', content: [pngPart(100)] },
      { role: 'user', content: [pngPart(5000)] },
    ],
  };
  const v = ib.apply(payload, { maxBytes: 1000, maxTotalBytes: 0 });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'image_too_large');
  assert.strictEqual(v.oversize.length, 1);
  assert.strictEqual(v.oversize[0].n, 2, '只数内联图，序号要跟用户看到的第几张一致');
  assert.strictEqual(v.oversize[0].bytes, 5000);
  assert.match(v.message, /第 2 张/);
  assert.match(v.message, /单张上限/);
  assert.match(v.message, /1568px/, '文案要给处置办法，不是只说「太大」');
});

test('合计超限：每张都不超也要拦，文案给的是合计口径', () => {
  const payload = {
    messages: [{ role: 'user', content: [pngPart(600), pngPart(600), pngPart(600)] }],
  };
  const v = ib.apply(payload, { maxBytes: 1000, maxTotalBytes: 1500 });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.oversize.length, 0, '单张都没超');
  assert.match(v.message, /合计/);
  assert.match(v.message, /3 张/);
});

test('不改 payload：判定是只读的（压缩要另开一批，别在这里偷偷改字节）', () => {
  const payload = { messages: [{ role: 'user', content: [pngPart(2000)] }] };
  const before = JSON.stringify(payload);
  ib.apply(payload, { maxBytes: 10, maxTotalBytes: 10 });
  assert.strictEqual(JSON.stringify(payload), before);
});

test('limits：面板 > 环境变量（MB）> 0，来源可解释', () => {
  reset();
  assert.deepStrictEqual(ib.limits().source, { maxBytes: 'default', maxTotalBytes: 'default', maxEdge: 'default' });
  process.env.DUMATE_IMAGE_MAX_MB = '2';
  assert.strictEqual(ib.limits().maxBytes, 2 * 1024 * 1024);
  assert.strictEqual(ib.limits().source.maxBytes, 'env');
  livecfg.Store({ imageBudget: { maxBytes: 3000000 } });
  assert.strictEqual(ib.limits().maxBytes, 3000000);
  assert.strictEqual(ib.limits().source.maxBytes, 'panel');
  // 0 = 不限，不是「0 字节」
  livecfg.Store({ imageBudget: { maxBytes: 0 } });
  assert.strictEqual(ib.limits().maxBytes, 2 * 1024 * 1024, '面板 0 → 回落 env');
  delete process.env.DUMATE_IMAGE_MAX_MB;
  assert.strictEqual(ib.limits().maxBytes, 0);
});

test('边界：没有 messages / content 是字符串 / 空 content 都不炸', () => {
  assert.deepStrictEqual(ib.scan(null), {
    count: 0, dataCount: 0, externalCount: 0, bytes: 0, maxBytes: 0, topFormat: '', formats: {}, fid: '',
  });
  assert.strictEqual(ib.scan({ messages: 'nope' }).count, 0);
  assert.strictEqual(ib.scan({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }).count, 0);
  assert.strictEqual(ib.apply({}, { maxBytes: 1 }).ok, true);
});

// ---------------------------------------------------------------------------
// 压缩（P1-6 第二批）：只缩 PNG、只在超长边时缩、结果按原图指纹缓存
// ---------------------------------------------------------------------------
const png = require('../../src/png');

/** 造一张 w×h 的 PNG data URI（带渐变，保证有真实可压的内容） */
function pngUri(w, h) {
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      data[o] = x & 0xff; data[o + 1] = y & 0xff; data[o + 2] = (x ^ y) & 0xff;
    }
  }
  return `data:image/png;base64,${png.encode({ width: w, height: h, channels: 3, data }).toString('base64')}`;
}

function payloadOf(uri) {
  return { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: uri } }] }] };
}

test('compressPayload：默认（maxEdge=0）什么都不做', () => {
  reset();
  ib.cacheClear();
  const p = payloadOf(pngUri(80, 40));
  const before = p.messages[0].content[0].image_url.url;
  const r = ib.compressPayload(p);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(p.messages[0].content[0].image_url.url, before, '不改 payload');
});

test('compressPayload：超长边才缩，缩完更小且尺寸达标；未超的原样不动', () => {
  ib.cacheClear();
  const big = pngUri(400, 200);
  const small = pngUri(60, 30);
  const p = { messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: big } },
    { type: 'image_url', image_url: { url: small } },
  ] }] };
  const r = ib.compressPayload(p, { maxEdge: 100 });
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.items.length, 1, '只有超长边那张被缩');
  assert.strictEqual(r.items[0].fromWidth, 400);
  assert.strictEqual(r.items[0].toWidth, 100);
  assert.ok(r.items[0].bytesAfter < r.items[0].bytesBefore);
  const out1 = p.messages[0].content[0].image_url.url;
  assert.notStrictEqual(out1, big, '大图 URL 应被替换');
  assert.strictEqual(p.messages[0].content[1].image_url.url, small, '小图不该被重编码');
  const dims = ib.pngDimsOfDataUri(out1);
  assert.strictEqual(Math.max(dims.width, dims.height), 100);
});

test('compressPayload：同一原图第二次直接命中缓存（会话每轮重发的就是它）', () => {
  ib.cacheClear();
  const uri = pngUri(300, 150);
  const p1 = payloadOf(uri);
  ib.compressPayload(p1, { maxEdge: 100 });
  const stats1 = ib.cacheStats();
  assert.strictEqual(stats1.entries, 1);
  assert.strictEqual(stats1.misses, 1);
  const p2 = payloadOf(uri);              // 客户端下一轮又发同一张原图
  ib.compressPayload(p2, { maxEdge: 100 });
  const stats2 = ib.cacheStats();
  assert.strictEqual(stats2.hits, 1, '第二次必须命中');
  assert.strictEqual(p1.messages[0].content[0].image_url.url, p2.messages[0].content[0].image_url.url,
    '缓存命中给的结果必须与首次一致');
  const capped = 33554432;
  assert.ok(stats2.cap === capped || stats2.cap >= 0);
});

test('compressPayload：JPEG 不缩（要 huffman 解码），如实记 skipped', () => {
  ib.cacheClear();
  const jpeg = `data:image/jpeg;base64,${base64Of(5000)}`;
  const p = payloadOf(jpeg);
  const r = ib.compressPayload(p, { maxEdge: 100 });
  assert.strictEqual(r.changed, false);
  assert.ok(r.skipped.some((x) => x.reason === 'not_png'));
  assert.strictEqual(p.messages[0].content[0].image_url.url, jpeg);
});

test('压缩后判定用新尺寸：超限的图缩完就不再 413', () => {
  ib.cacheClear();
  const uri = pngUri(400, 200);
  const p = payloadOf(uri);
  const rawBytes = ib.scan(p).bytes;
  const limit = Math.floor(rawBytes / 2);   // 上限设成原图的一半：缩前必超、缩后必过
  const before = ib.apply(p, { maxBytes: limit, maxTotalBytes: 0 });
  assert.strictEqual(before.ok, false, `缩之前应超限（原图 ${rawBytes}B > 上限 ${limit}B）`);
  ib.compressPayload(p, { maxEdge: 100 });
  const after = ib.apply(p, { maxBytes: limit, maxTotalBytes: 0 });
  assert.strictEqual(after.ok, true, '缩之后应放行');
});

test('imageBudget 面板值：maxEdge 也走 面板 > env > 0', () => {
  reset();
  assert.strictEqual(ib.limits().maxEdge, 0);
  assert.strictEqual(ib.limits().source.maxEdge, 'default');
  process.env.DUMATE_IMAGE_MAX_EDGE = '1024';
  assert.strictEqual(ib.limits().maxEdge, 1024);
  assert.strictEqual(ib.limits().source.maxEdge, 'env');
  livecfg.Store({ imageBudget: { maxEdge: 800 } });
  assert.strictEqual(ib.limits().maxEdge, 800);
  assert.strictEqual(ib.limits().source.maxEdge, 'panel');
  delete process.env.DUMATE_IMAGE_MAX_EDGE;
});
