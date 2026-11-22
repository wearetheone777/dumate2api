// src/image-budget.js - 会话内联图片的体量观测与上限（调研 P1-6，第一批）
//
// 上游产品（Agent2API v3.4.0）的做法是「转发前把 base64 大图缩长边并重编码」。
// 那件事**必须先有编解码器**（PNG 可纯 JS 做，JPEG 要 huffman 解码），而
// 「图片到底多大、有几个、超没超」这件事跟编解码无关，却没人在量——
// 于是本文件先解决**可观测与可守门**，压缩留给下一批：
//
//   1. 观测：每请求数一遍内联图片（张数 / 总字节 / 单张最大 / 格式分布），
//      写进请求日志（image_count / image_bytes / image_max_bytes / image_format）。
//      没有这组数，谈「要不要压缩、压到多少」全是猜。
//   2. 守门：单张与单请求**两个上限**，超了回 413 并说清是哪一张、多大、
//      上限多少、该怎么办。默认全关（0 = 不限），与仓库「默认关、显式开」一致。
//   3. 压缩（第二批，默认关）：长边超过 `maxEdge` 的内联 **PNG** 缩到 maxEdge
//      并重编码（`src/png.js`，纯 JS + zlib）。**结果按原图指纹缓存**——同一条
//      会话每轮都会重发历史里那张图，没有缓存就等于每轮都重算一次缩放。
//      JPEG 不做：要 huffman 解码 + 重编码，量级完全不同（也不是截图的主形态）。
//
// 为什么上限用「解码后字节」而不是 base64 字符串长度：base64 会膨胀 4/3，
// 用户拿到的提示若是「字符串 6.7MB」会跟上游报的 5MB 对不上。这里按
// `len*3/4 - padding` 算，**不真的 decode**（5MB 的 base64 解出来是 5MB 的
// 新字符串，纯为量尺寸而分配内存不值得）。
//
// 边界（别顺手扩）：
//   - 只认 `data:image/...;base64,` 的内联图。外链 http(s) URL 只计数不判上限
//     ——大小在上游手里，我们量不出来，假装量得出来就会误杀。
//   - 不认「非图片的 data URI」（音频/PDF）——那是另一类预算，别混进来。
//   - 不做任何改写：本模块**返回判定**，是否拦截由调用方决定；`apply` 不改 payload。
const crypto = require('crypto');
const livecfg = require('./livecfg');
const png = require('./png');

/** 允许的图片 MIME 前缀（data URI 的 media type 可能带参数，如 png;charset=…） */
const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i;

/** base64 字符串的**解码后**字节数（不 decode） */
function base64Bytes(s) {
  const str = String(s || '');
  if (!str) return 0;
  let pad = 0;
  if (str.endsWith('==')) pad = 2;
  else if (str.endsWith('=')) pad = 1;
  // 每 4 个 base64 字符 → 3 字节，再去掉 padding 占的 1~2 字节
  return Math.max(0, Math.floor((str.length * 3) / 4) - pad);
}

/**
 * data URI → { mime, bytes }；不是内联图片返回 null。
 * 例：`data:image/png;base64,iVBORw0…` → { mime:'image/png', bytes:12345 }
 */
function dataUriOf(url) {
  const u = String(url == null ? '' : url);
  if (!u.startsWith('data:')) return null;
  const comma = u.indexOf(',');
  if (comma < 0) return null;
  const head = u.slice(5, comma);          // image/png;base64
  const payload = u.slice(comma + 1);
  if (!/;base64/i.test(head)) return null;  // 非 base64 的 data URI（极少见）不算
  const mime = head.split(';')[0].trim().toLowerCase();
  if (!IMAGE_MIME.test(mime)) return null;
  return { mime, bytes: base64Bytes(payload) };
}

/** 从一个 part 里取出图像 URL（OpenAI image_url / Responses input_image 两种形状） */
function partUrl(p) {
  if (!p || typeof p !== 'object') return '';
  const t = String(p.type || '');
  if (t && t !== 'image_url' && t !== 'input_image') return '';
  const iu = p.image_url;
  if (typeof iu === 'string') return iu;
  if (iu && typeof iu === 'object' && iu.url) return String(iu.url);
  if (typeof p.url === 'string') return p.url;
  if (iu && typeof iu === 'object' && iu.data) return '';  // 未见过，不猜
  return '';
}

/**
 * 扫一遍 OpenAI 形状的 payload（四个协议入口翻译后都是这个形状）。
 *
 * @returns {{count:number, dataCount:number, externalCount:number, bytes:number,
 *            maxBytes:number, topFormat:string, formats:object, fid:string}}
 *   count  = 全部图片 part 数
 *   bytes  = **内联**图总字节（外链不计）
 *   fid    = 内联图的整体指纹（同一条会话重复发同一张图时它不变，用于日后
 *            做「同一原图复用结果」的缓存键；现在只写日志便于核对）
 */
function scan(payload) {
  const stats = {
    count: 0, dataCount: 0, externalCount: 0, bytes: 0, maxBytes: 0,
    topFormat: '', formats: {}, fid: '',
  };
  const msgs = payload && Array.isArray(payload.messages) ? payload.messages : [];
  const seen = [];
  for (const m of msgs) {
    const content = m && m.content;
    if (!Array.isArray(content)) continue;
    for (const p of content) {
      const url = partUrl(p);
      if (!url) continue;
      stats.count += 1;
      const d = dataUriOf(url);
      if (!d) { stats.externalCount += 1; continue; }
      stats.dataCount += 1;
      stats.bytes += d.bytes;
      stats.formats[d.mime] = (stats.formats[d.mime] || 0) + 1;
      if (d.bytes > stats.maxBytes) { stats.maxBytes = d.bytes; stats.topFormat = d.mime; }
      // 指纹只对内联图算，且**用长度+头尾**做键：整串 sha1 5MB 是白花的 CPU，
      // 而「同图」在这三个量上几乎不会撞（撞了也只是指纹相同，不影响判定）。
      seen.push(`${d.mime}:${d.bytes}:${url.length}:${url.slice(-24)}`);
    }
  }
  if (seen.length) {
    stats.fid = crypto.createHash('sha1').update(seen.join('|')).digest('hex').slice(0, 16);
  }
  return stats;
}

// ---------------------------------------------------------------------------
// 上限：面板 > 环境变量 > 0（不限）
//
// 单位刻意不同：面板按**字节**存（前端用 MB 输入并按 1024² 换算），环境变量
// 按 **MB**（与 DUMATE_MAX_BODY_MB 同风格）。混着用最容易出的错是「填了 4 当
// 4MB，实际 4 字节」——所以两个来源各写一个名字，解析只在这里做一次。
// ---------------------------------------------------------------------------
const ENV_MAX_MB = 'DUMATE_IMAGE_MAX_MB';
const ENV_TOTAL_MB = 'DUMATE_IMAGE_MAX_TOTAL_MB';

function envMb(name) {
  const raw = process.env[name];
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1024 * 1024) : 0;
}

/** 当前生效上限（字节；0 = 不限）。source 供界面解释「为什么拦了」。 */
function limits() {
  let cfg = {};
  try { cfg = livecfg.Load().imageBudget || {}; } catch (e) { cfg = {}; }
  const panelMax = Number(cfg.maxBytes) > 0 ? Math.round(Number(cfg.maxBytes)) : 0;
  const panelTotal = Number(cfg.maxTotalBytes) > 0 ? Math.round(Number(cfg.maxTotalBytes)) : 0;
  const envMax = envMb(ENV_MAX_MB);
  const envTotal = envMb(ENV_TOTAL_MB);
  const pick = (panel, env) => (panel > 0
    ? { value: panel, source: 'panel' }
    : (env > 0 ? { value: env, source: 'env' } : { value: 0, source: 'default' }));
  const max = pick(panelMax, envMax);
  const total = pick(panelTotal, envTotal);
  // 长边上限（压缩用）也并进来：界面上它们是同一张卡，分开取等于两次 mtime 读
  const edge = maxEdge();
  return {
    maxBytes: max.value, maxTotalBytes: total.value, maxEdge: edge.value,
    source: { maxBytes: max.source, maxTotalBytes: total.source, maxEdge: edge.source },
  };
}

/** 人类可读的体量（MB 保留一位；<1MB 用 KB） */
function human(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

/**
 * 对一条 payload 出判定（**不改 payload**）。
 *
 * @param {object} payload OpenAI 形状的请求体（翻译后的）
 * @param {{maxBytes?:number,maxTotalBytes?:number,stats?:object}} [opts]
 * @returns {{ok:boolean, stats:object, limits:object, oversize:Array, message:string, code:string}}
 */
function apply(payload, opts = {}) {
  const lim = opts.maxBytes !== undefined || opts.maxTotalBytes !== undefined
    ? { maxBytes: Number(opts.maxBytes) || 0, maxTotalBytes: Number(opts.maxTotalBytes) || 0, source: { maxBytes: 'explicit', maxTotalBytes: 'explicit' } }
    : limits();
  const stats = opts.stats || scan(payload);
  const oversize = [];
  if (lim.maxBytes > 0) {
    for (const item of thumbnails(payload)) {
      if (item.bytes > lim.maxBytes) oversize.push({ ...item, limit: lim.maxBytes, kind: 'single' });
    }
  }
  const totalHit = lim.maxTotalBytes > 0 && stats.bytes > lim.maxTotalBytes;
  const ok = !oversize.length && !totalHit;
  const message = ok ? '' : describe(stats, lim, oversize);
  return {
    ok, stats, limits: lim, oversize,
    code: ok ? '' : 'image_too_large',
    message,
  };
}

/** 逐张内联图的小档案（只在需要指认「第几张」时才枚举） */
function thumbnails(payload) {
  const out = [];
  const msgs = payload && Array.isArray(payload.messages) ? payload.messages : [];
  let n = 0;
  for (const m of msgs) {
    const content = m && m.content;
    if (!Array.isArray(content)) continue;
    for (const p of content) {
      const url = partUrl(p);
      if (!url) continue;
      const d = dataUriOf(url);
      if (!d) continue;
      n += 1;
      out.push({ n, bytes: d.bytes, mime: d.mime });
    }
  }
  return out;
}

/**
 * 413 的文案。要能回答四个问题：**哪一张、多大、上限多少、怎么办**。
 * 只报「请求过大」等于让用户去猜（而压缩是我们的活，不该是用户的）。
 */
function describe(stats, lim, oversize) {
  const parts = [];
  if (oversize.length) {
    const head = oversize.slice(0, 3).map((o) => `第 ${o.n} 张 ${human(o.bytes)}（${o.mime}）`).join('、');
    const more = oversize.length > 3 ? ` 等 ${oversize.length} 张` : '';
    parts.push(`${head}${more} 超过单张上限 ${human(lim.maxBytes)}`);
  }
  if (lim.maxTotalBytes > 0 && stats.bytes > lim.maxTotalBytes) {
    parts.push(`本请求内联图合计 ${human(stats.bytes)}（${stats.dataCount} 张）超过上限 ${human(lim.maxTotalBytes)}`);
  }
  return `内联图片过大：${parts.join('；')}。`
    + '请把长边缩到 1568px 以内或改用 JPEG 后重发；多张图可分批发送。';
}

module.exports = {
  IMAGE_MIME, ENV_MAX_MB, ENV_TOTAL_MB,
  base64Bytes, dataUriOf, partUrl, scan, thumbnails, limits, apply, describe, human,
};

// ---------------------------------------------------------------------------
// 压缩（P1-6 第二批）：PNG 长边超限才缩，结果按原图指纹缓存
//
// 为什么必须缓存：会话历史每轮都重发同一张图（客户端把整段 messages 再传一次），
// 没有缓存就等于每轮重算一次面积平均 + deflate。上游产品也是同一条设计
// （「同一原图复用结果」）。
//
// 为什么只做 PNG：JPEG 要 huffman 解码 + 重编码，量级差一个数量级；而粘进
// Codex/Claude Code 的截图几乎都是 PNG。不做的事就不假装做——JPEG 原样放行，
// 由 413 那条路给用户处置建议。
// ---------------------------------------------------------------------------

const ENV_MAX_EDGE = 'DUMATE_IMAGE_MAX_EDGE';
const ENV_CACHE_MB = 'DUMATE_IMAGE_CACHE_MB';
const DEFAULT_CACHE_MB = 32;

/** 生效的长边上限（0 = 不缩）。面板 > env > 0。 */
function maxEdge() {
  let cfg = {};
  try { cfg = livecfg.Load().imageBudget || {}; } catch (e) { cfg = {}; }
  const panel = Number(cfg.maxEdge) > 0 ? Math.round(Number(cfg.maxEdge)) : 0;
  if (panel > 0) return { value: panel, source: 'panel' };
  const env = Number(process.env[ENV_MAX_EDGE]);
  if (Number.isFinite(env) && env > 0) return { value: Math.round(env), source: 'env' };
  return { value: 0, source: 'default' };
}

/** 缓存键：原图**完整 data URI** 的 sha1（同图同键，改一个字节就换键） */
function keyOfUrl(url) {
  return crypto.createHash('sha1').update(url).digest('hex');
}

// LRU：Map 的插入序当队列用，命中时先删再插。上限按**输出 base64 的字节数**算，
// 不按条目数——一张 4MB 的图和一张 40KB 的图不该占同一份额度。
const cache = new Map();
let cacheBytes = 0;

function cacheCapBytes() {
  const n = Number(process.env[ENV_CACHE_MB]);
  const mb = Number.isFinite(n) && n >= 0 ? n : DEFAULT_CACHE_MB;
  return Math.round(mb * 1024 * 1024);
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);           // 重插到队尾 = 最近使用
  return hit;
}

function cachePut(key, b64) {
  const bytes = b64.length;
  const cap = cacheCapBytes();
  if (!cap) return;              // 0 = 关缓存
  if (bytes > cap) return;       // 单条就超过总容量：不进（否则一条就把缓存清空）
  if (cache.has(key)) { cacheBytes -= cache.get(key).b64.length; cache.delete(key); }
  cache.set(key, { b64 });
  cacheBytes += bytes;
  while (cacheBytes > cap && cache.size > 1) {
    const oldest = cache.keys().next().value;
    cacheBytes -= cache.get(oldest).b64.length;
    cache.delete(oldest);
  }
}

function cacheStats() {
  return { entries: cache.size, bytes: cacheBytes, cap: cacheCapBytes(), hits: cacheHits, misses: cacheMisses };
}
let cacheHits = 0;
let cacheMisses = 0;

function cacheClear() {
  cache.clear();
  cacheBytes = 0;
  cacheHits = 0;
  cacheMisses = 0;
}

/** 从 data URI 的 base64 头部读 PNG 尺寸（不解整幅）——先看要不要缩 */
function pngDimsOfDataUri(url) {
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  // PNG 的 IHDR 数据在 16~28 字节，48 个 base64 字符（36 字节）足够覆盖
  const head = Buffer.from(url.slice(comma + 1, comma + 1 + 48), 'base64');
  if (!png.isPng(head) || head.length < 29) return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/**
 * 就地压缩 payload 里的内联 PNG（**唯一一处会改 payload 的地方**）。
 *
 * @param {object} payload OpenAI 形状
 * @param {{maxEdge?:number}} [opts]
 * @returns {{changed:boolean, items:Array, bytesBefore:number, bytesAfter:number, skipped:Array}}
 */
function compressPayload(payload, opts = {}) {
  const edge = Number(opts.maxEdge) > 0 ? Math.round(Number(opts.maxEdge)) : maxEdge().value;
  const out = { changed: false, items: [], cacheHits: 0, bytesBefore: 0, bytesAfter: 0, skipped: [] };
  if (!(edge > 0)) return out;
  const msgs = payload && Array.isArray(payload.messages) ? payload.messages : [];
  let n = 0;
  for (const m of msgs) {
    const content = m && m.content;
    if (!Array.isArray(content)) continue;
    for (const p of content) {
      const url = partUrl(p);
      if (!url) continue;
      const d = dataUriOf(url);
      if (!d) continue;
      n += 1;
      out.bytesBefore += d.bytes;
      let replaced = url;
      if (d.mime === 'image/png') {
        const key = keyOfUrl(url);
        const hit = cacheGet(key);
        if (hit) {
          cacheHits += 1;
          out.cacheHits += 1;
          replaced = `data:image/png;base64,${hit.b64}`;
        } else {
          cacheMisses += 1;
          const dims = pngDimsOfDataUri(url);
          if (dims && Math.max(dims.width, dims.height) > edge) {
            const raw = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
            const small = png.shrink(raw, edge);
            if (small) {
              const b64 = small.buffer.toString('base64');
              cachePut(key, b64);
              replaced = `data:image/png;base64,${b64}`;
              out.items.push({
                n,
                fromWidth: small.fromWidth,
                fromHeight: small.fromHeight,
                toWidth: small.width,
                toHeight: small.height,
                bytesBefore: d.bytes,
                bytesAfter: small.buffer.length,
              });
            } else {
              out.skipped.push({ n, reason: 'shrunk_not_smaller_or_undecodable' });
            }
          } else if (!dims) {
            out.skipped.push({ n, reason: 'undecodable_head' });
          }
        }
      } else {
        out.skipped.push({ n, reason: 'not_png' });
      }
      if (replaced !== url) {
        // 写回 part（形状可能是 image_url:{url} 或顶层 url，两种都覆盖）
        const applied = setPartUrl(p, replaced);
        if (applied) {
          const d2 = dataUriOf(replaced);
          out.bytesAfter += d2 ? d2.bytes : d.bytes;
          out.changed = true;
          continue;
        }
      }
      out.bytesAfter += d.bytes;
    }
  }
  return out;
}

/** 把新的 data URI 写回 part；形状不认时不硬改（返回 false 让调用方按原样计） */
function setPartUrl(p, url) {
  if (!p || typeof p !== 'object') return false;
  const iu = p.image_url;
  if (typeof iu === 'string') { p.image_url = url; return true; }
  if (iu && typeof iu === 'object' && iu.url) { iu.url = url; return true; }
  if (typeof p.url === 'string') { p.url = url; return true; }
  return false;
}

module.exports.maxEdge = maxEdge;
module.exports.compressPayload = compressPayload;
module.exports.pngDimsOfDataUri = pngDimsOfDataUri;
module.exports.cacheStats = cacheStats;
module.exports.cacheClear = cacheClear;
module.exports.ENV_MAX_EDGE = ENV_MAX_EDGE;
module.exports.ENV_CACHE_MB = ENV_CACHE_MB;
