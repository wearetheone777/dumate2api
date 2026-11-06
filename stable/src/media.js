// src/media.js - 搭子的媒体工具端点（生图 / TTS）
//
// 来源：客户端自带的 skills（baidu-image-gen / baidu-video-gen）与真机探测
// （2026-10-31）。这些能力与对话走**同一份网页凭证**：`GET /api/dumate/app/token/get`
// 换到的 token + 请求头 `X-Appbuilder-From: openclaw` 就能打
// `dumate-svc.baidu.com/gateway/v2/tools/dumate/*`。
//
// 与 web-pool 的关系：凭证获取、账号池选号、成功/失败喂池都复用它，本模块
// 只负责「工具接口的请求形状 + 异步任务轮询」。**不要**在这里另建 token 缓存
// ——两处缓存必然漂移，池子的冷却/熔断也就看不见这些调用了。
const https = require('https');
const webPool = require('./web-pool');

const GATEWAY_HOST = webPool.GATEWAY_HOST;
// 工具路径挂在 /gateway 前缀下：skills 里的 DUMATE_GATEWAY_URL 就是
// `https://dumate-svc.baidu.com/gateway`，再拼 `/v2/tools/...`。
const TOOLS_PREFIX = '/gateway';

const IMAGE_ENDPOINTS = {
  'dumate-image2.2': '/v2/tools/dumate/image_generate_v3/async',
  'dumate-image2.1': '/v2/tools/dumate/image_generate_v2/async',
  'dumate-image1.2': '/v2/tools/dumate/image_generate/async',
  'dumate-image0.1': '/beta/image/qianfan-image-v1',
};
const DEFAULT_IMAGE_MODEL = 'dumate-image2.2';
const TTS_PATH = '/v2/tools/dumate/t2a_v2/sync';
const DEFAULT_TTS_MODEL = 'dumate-tts';
// 视频生成（2026-11-01 真机探测定案）。上游是千帆 AigcVideoTask 的代理，
// 必填字段靠 400 错误体逐轮吐出：model_parameters 必填、prompt 必填。
const VIDEO_PATH = '/v2/tools/dumate/video_generate/async';
const DEFAULT_VIDEO_MODEL = 'dumate-video2.9';
// 视频生成比生图慢一个量级（实测提交后分钟级 processing），轮询预算单独给。
// DUMATE_MEDIA_POLL_* 是生图/TTS 共用的，不要混用。
const VIDEO_POLL_TIMEOUT_MS = Math.max(30000, Number(process.env.DUMATE_MEDIA_VIDEO_POLL_TIMEOUT_MS) || 900000);
const VIDEO_POLL_INTERVAL_MS = Math.max(1000, Number(process.env.DUMATE_MEDIA_VIDEO_POLL_INTERVAL_MS) || 10000);

const POLL_TIMEOUT_MS = Math.max(5000, Number(process.env.DUMATE_MEDIA_POLL_TIMEOUT_MS) || 120000);
const POLL_INTERVAL_MS = Math.max(500, Number(process.env.DUMATE_MEDIA_POLL_INTERVAL_MS) || 1500);

// OpenAI 的 voice 名 → minimax voice_id（客户端技能里那套中文音色）。
// 不是 OpenAI 的名字就原样透传——调用方也可以直接写 `Chinese (Mandarin)_Sweet_Lady`。
const VOICE_MAP = {
  alloy: 'Chinese (Mandarin)_Gentle_Youth',
  echo: 'Chinese (Mandarin)_Radio_Host',
  fable: 'Chinese (Mandarin)_Gentle_Senior',
  onyx: 'Chinese (Mandarin)_Radio_Host',
  nova: 'Chinese (Mandarin)_Sweet_Lady',
  shimmer: 'Chinese (Mandarin)_Sweet_Lady',
};
const DEFAULT_VOICE = 'Chinese (Mandarin)_Sweet_Lady';

const AUDIO_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/L16', ogg: 'audio/ogg' };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 带 token 的 JSON 请求。
 * 返回 { status, json, raw }；网络错误 status=0。
 */
function requestJson(token, method, path, body, timeout = 60000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL('https://' + GATEWAY_HOST + TOOLS_PREFIX + path); } catch (e) {
      return resolve({ status: 0, json: null, raw: '', error: e.message });
    }
    const payload = body == null ? null : JSON.stringify(body);
    const headers = {
      Authorization: 'Bearer ' + token,
      'X-Appbuilder-From': 'openclaw',
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
    };
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method, headers, timeout,
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, raw: b });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, raw: '', error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, raw: '', error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

/** 下载二进制（图片 b64 / 音频）。跟随一次重定向。 */
function download(url, timeout = 120000, redirects = 2) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(download(next, timeout, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}` });
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ ok: true, buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || '' }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

/**
 * 用池里的一个账号执行一次工具调用。
 * 失败时喂池（与对话请求同一套惩罚/恢复状态机），必要时换下一个账号。
 */
async function withAccount(fn) {
  const tried = new Set();
  let lastErr = { status: 502, error: '没有可用账号' };
  for (let i = 0; i < 3; i++) {
    const p = webPool.pick(tried);
    if (!p) break;
    const id = p.account.id;
    tried.add(id);
    const t = await webPool.getToken(p.account);
    if (!t.ok) {
      lastErr = { status: t.expired ? 401 : 502, error: t.error || '取 token 失败' };
      webPool.markFailure(id, { status: t.expired ? 401 : 502, message: lastErr.error, model: 'media' });
      continue;
    }
    try {
      const r = await fn(t.token, p.account);
      if (r && r.ok) { webPool.markSuccess(id); return r; }
      // 上游明确拒绝（401/403/402/429/5xx）才算账号问题；4xx 参数错误不罚账号
      const st = Number(r && r.status) || 0;
      if (st === 401 || st === 402 || st === 429 || st >= 500) {
        webPool.markFailure(id, { status: st, message: (r && r.error) || `HTTP ${st}`, model: 'media' });
        lastErr = r;
        continue;
      }
      return r;
    } catch (e) {
      webPool.markFailure(id, { status: 0, message: e.message, model: 'media' });
      lastErr = { status: 502, error: e.message };
    }
  }
  return { ok: false, ...lastErr };
}

function normalizeVideoModel(name) {
  const raw = String(name || '').trim().replace(/^dumate\//, '');
  // 只认实测存在过的两个模型名（其他名字上游是否可用无证据，不放开）
  if (raw === 'dumate-video2.9' || raw === 'dumate-video3.0') return raw;
  const hit = ['dumate-video2.9', 'dumate-video3.0'].find((k) => k.toLowerCase() === raw.toLowerCase());
  return hit || DEFAULT_VIDEO_MODEL;
}

function normalizeImageModel(name) {
  const raw = String(name || '').trim().replace(/^dumate\//, '');
  if (IMAGE_ENDPOINTS[raw]) return raw;
  const hit = Object.keys(IMAGE_ENDPOINTS).find((k) => k.toLowerCase() === raw.toLowerCase());
  return hit || DEFAULT_IMAGE_MODEL;
}

/**
 * 构造生图请求（纯函数，便于离线验证形状）。
 * 返回 `{ model, path, payload }` 或 `{ error }`。
 */
function buildImagePayload(o = {}) {
  const prompt = String(o.prompt || '').trim();
  if (!prompt) return { error: 'prompt 不能为空' };
  const model = normalizeImageModel(o.model);
  const payload = {
    query: prompt,
    model,
    quality: String(o.quality || '').toLowerCase() === 'high' ? 'high' : 'low',
    maxImagesNum: Math.min(4, Math.max(1, Number(o.n) || 1)),
  };
  const size = String(o.size || '').trim();
  if (/^\d+x\d+$/i.test(size)) {
    payload.size = size;
  } else {
    payload.resolution = ['1K', '2K', '4K'].includes(size.toUpperCase()) ? size.toUpperCase() : '2K';
    payload.aspectRatio = '1:1';
  }
  if (Array.isArray(o.imageUrls) && o.imageUrls.length) payload.imageUrls = o.imageUrls;
  return { model, path: IMAGE_ENDPOINTS[model], payload };
}

/**
 * 构造 TTS 请求（纯函数）。返回 `{ format, voice, payload }` 或 `{ error }`。
 */
function buildTtsPayload(o = {}) {
  const text = String(o.input || '').trim();
  if (!text) return { error: 'input 不能为空' };
  const format = String(o.responseFormat || o.format || 'mp3').toLowerCase();
  if (!AUDIO_TYPES[format]) return { error: `不支持的 response_format: ${format}` };
  const speed = Math.min(2, Math.max(0.5, Number(o.speed) || 1));
  const voiceRaw = String(o.voice || '').trim();
  const voice = VOICE_MAP[voiceRaw.toLowerCase()] || voiceRaw || DEFAULT_VOICE;
  return {
    format,
    voice,
    payload: {
      model: String(o.model || DEFAULT_TTS_MODEL).replace(/^dumate\//, '') || DEFAULT_TTS_MODEL,
      text,
      stream: false,
      voice_setting: { voice_id: voice, speed, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format, channel: 1 },
      subtitle_enable: false,
      output_format: 'url',
    },
  };
}

/**
 * 构造视频生成请求（纯函数，形状 2026-11-01 真机探测定案）。
 *
 * 必填字段是**探测循环**从上游 400 错误体逐轮拿到的（不是猜的）：
 *   R1 `{query, model}`            → 「字段 'model_parameters' 是必填的」
 *   R2 `+ model_parameters:{}`     → 「字段 'prompt' 是必填的」
 *   R3 `+ prompt（两处都带）`       → 200 + task_id
 * prompt 在顶层与 model_parameters 里**都带**——哪一处被上游真正消费未实测，
 * 两处同值无害；query 按生图同款保留（对齐工具族形状）。
 * 可选参数（时长/分辨率/首尾帧）没有探测证据，**不放开**——开了就是赌。
 *
 * 返回 `{ model, path, payload }` 或 `{ error }`。
 */
function buildVideoPayload(o = {}) {
  const prompt = String(o.prompt || '').trim();
  if (!prompt) return { error: 'prompt 不能为空' };
  const model = normalizeVideoModel(o.model);
  const payload = {
    query: prompt,
    prompt,
    model,
    model_parameters: { prompt },
  };
  return { model, path: VIDEO_PATH, payload };
}

/**
 * 文生视频（异步提交 + 轮询）。视频是分钟级任务，轮询预算独立于生图
 * （DUMATE_MEDIA_VIDEO_POLL_TIMEOUT_MS，默认 15 分钟）。
 *
 * 返回 `{ ok, model, created, data:[{url}], taskId }`。任务在轮询超时后仍会
 * 继续生成（上游异步），此时如实报 504 + taskId——调用方可以直接拿 taskId
 * 去轮询，不算钱白花。
 */
async function generateVideo(o = {}) {
  const built = buildVideoPayload(o);
  if (built.error) return { ok: false, status: 400, error: built.error };
  const { model, path, payload } = built;

  const r = await withAccount(async (token) => {
    const sub = await requestJson(token, 'POST', path, payload, 60000);
    if (sub.status !== 200 || !sub.json) {
      return { ok: false, status: sub.status || 502, error: textError(sub) };
    }
    if (sub.json.code != null && String(sub.json.code) !== '0' && sub.json.code !== 0) {
      return { ok: false, status: 400, error: sub.json.message || `upstream code ${sub.json.code}` };
    }
    const taskId = sub.json.data && sub.json.data.task_id;
    if (!taskId) return { ok: false, status: 502, error: '上游未返回 task_id' };
    return pollVideo(token, path, taskId);
  });

  if (!r.ok) return r;
  const urls = r.videoUrls || [];
  if (!urls.length) return { ok: false, status: 502, error: '上游返回成功但没有视频地址' };
  return { ok: true, model, created: Math.floor(Date.now() / 1000), data: urls.map((url) => ({ url })), taskId: r.taskId };
}

/**
 * 视频任务轮询。成功/失败字段是实测过的（task_status: processing → 终态），
 * 视频地址的字段名以终态响应为准——探测任务完成前先认 videoUrls /
 * video_urls / data.videoUrls 三个候选位，终态响应到手后在单测里钉死。
 */
async function pollVideo(token, path, taskId) {
  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const q = await requestJson(token, 'GET', path + '?task_id=' + encodeURIComponent(taskId), null, 30000);
    if (q.status === 200 && q.json) {
      last = q.json;
      const d = q.json.data || q.json;
      const st = String(d.task_status || q.json.task_status || q.json.status || '').toLowerCase();
      // 终态形状（2026-11-01 真机实测）：task_status:"succeed" +
      // task_result.videos[].url。注意是 succeed 不是 success；url 可能每次
      // 轮询重新签发（BOS 签名 URL），任取一个可用。
      const result = d.task_result || {};
      const rawUrls = Array.isArray(result.videos) ? result.videos
        : (Array.isArray(d.videoUrls) ? d.videoUrls : []);
      const urls = rawUrls
        .map((v) => (typeof v === 'string' ? v : String((v && (v.url || v.video_url)) || '')))
        .filter(Boolean);
      if (urls.length) return { ok: true, videoUrls: urls, taskId };
      if (st === 'succeed') {
        return { ok: false, status: 502, error: '上游任务成功但没有返回视频地址', taskId };
      }
      if (/fail|error|reject/.test(st)) {
        return { ok: false, status: 400, error: `视频生成失败: ${d.task_status_msg || q.json.message || st}`, taskId };
      }
    }
    await sleep(VIDEO_POLL_INTERVAL_MS);
  }
  return {
    ok: false, status: 504,
    error: `视频生成超时（${Math.round(VIDEO_POLL_TIMEOUT_MS / 1000)}s，任务仍在上游继续）${last ? `，最后状态: ${JSON.stringify(last).slice(0, 160)}` : ''}`,
    taskId,
  };
}

/**
 * 文生图 / 图生图（异步提交 + 轮询）。
 *
 * @param {object} o
 * @param {string} o.prompt   提示词（必填）
 * @param {string} [o.model]  dumate-image2.2 / 2.1 / 1.2 / 0.1
 * @param {number} [o.n]      张数（上游 maxImagesNum）
 * @param {string} [o.size]   `1024x1024`（像素）或 `1K/2K/4K`（分辨率）
 * @param {string} [o.quality] low（默认）/ high
 * @param {string[]} [o.imageUrls] 参考图（图生图）
 * @param {string} [o.responseFormat] url（默认）/ b64_json
 */
async function generateImage(o = {}) {
  const built = buildImagePayload(o);
  if (built.error) return { ok: false, status: 400, error: built.error };
  const { model, path, payload } = built;

  const r = await withAccount(async (token) => {
    const sub = await requestJson(token, 'POST', path, payload);
    if (sub.status !== 200 || !sub.json) {
      return { ok: false, status: sub.status || 502, error: textError(sub) };
    }
    if (sub.json.code != null && String(sub.json.code) !== '0' && sub.json.code !== 0) {
      return { ok: false, status: 400, error: sub.json.message || `upstream code ${sub.json.code}` };
    }
    const taskId = sub.json.task_id;
    if (!taskId) return { ok: false, status: 502, error: '上游未返回 task_id' };
    return pollImage(token, path, taskId);
  });

  if (!r.ok) return r;
  const urls = r.imageUrls || [];
  if (!urls.length) return { ok: false, status: 502, error: '上游返回成功但没有图片地址' };
  if (String(o.responseFormat || 'url') === 'b64_json') {
    const data = [];
    for (const url of urls) {
      const d = await download(url);
      if (!d.ok) return { ok: false, status: 502, error: `下载图片失败: ${d.error}` };
      data.push({ b64_json: d.buffer.toString('base64') });
    }
    return { ok: true, model, created: Math.floor(Date.now() / 1000), data };
  }
  return { ok: true, model, created: Math.floor(Date.now() / 1000), data: urls.map((url) => ({ url })) };
}

async function pollImage(token, path, taskId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const q = await requestJson(token, 'GET', path + '?task_id=' + encodeURIComponent(taskId), null, 30000);
    if (q.status === 200 && q.json) {
      last = q.json;
      const urls = Array.isArray(q.json.imageUrls) ? q.json.imageUrls.filter(Boolean) : [];
      const st = String(q.json.status || '').toLowerCase();
      if (urls.length) return { ok: true, imageUrls: urls };
      if (/fail|error|reject/.test(st)) {
        return { ok: false, status: 400, error: `生图失败: ${q.json.message || st}` };
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return {
    ok: false, status: 504,
    error: `生图超时（${Math.round(POLL_TIMEOUT_MS / 1000)}s）${last ? `，最后状态: ${JSON.stringify(last).slice(0, 120)}` : ''}`,
  };
}

/**
 * 语音合成（minimax t2a_v2 同步接口，不分长短）。
 *
 * 返回 `{ ok, buffer, contentType }`——OpenAI 的 /v1/audio/speech 语义是直接
 * 回音频字节，不是回 URL。
 */
async function synthesizeSpeech(o = {}) {
  const built = buildTtsPayload(o);
  if (built.error) return { ok: false, status: 400, error: built.error };
  const { format, payload } = built;

  const r = await withAccount(async (token) => {
    const res = await requestJson(token, 'POST', TTS_PATH, payload, 120000);
    if (res.status !== 200 || !res.json) return { ok: false, status: res.status || 502, error: textError(res) };
    const base = res.json.base_resp || {};
    if (Number(base.status_code) !== 0) {
      return { ok: false, status: 400, error: `TTS 失败: ${base.status_msg || `code ${base.status_code}`}` };
    }
    const audio = res.json.data && res.json.data.audio;
    if (!audio) return { ok: false, status: 502, error: '上游未返回音频' };
    return { ok: true, audio: String(audio) };
  });

  if (!r.ok) return r;
  let buffer;
  if (/^https?:\/\//i.test(r.audio)) {
    const d = await download(r.audio);
    if (!d.ok) return { ok: false, status: 502, error: `下载音频失败: ${d.error}` };
    buffer = d.buffer;
  } else if (/^[0-9a-f]+$/i.test(r.audio)) {
    buffer = Buffer.from(r.audio, 'hex');
  } else {
    buffer = Buffer.from(r.audio, 'base64');
  }
  if (!buffer || !buffer.length) return { ok: false, status: 502, error: '音频内容为空' };
  return { ok: true, buffer, contentType: AUDIO_TYPES[format] };
}

function textError(r) {
  if (!r) return '上游无响应';
  if (r.error) return r.error;
  const body = String(r.raw || '').replace(/\s+/g, ' ').trim();
  return body ? body.slice(0, 200) : `HTTP ${r.status}`;
}

module.exports = {
  generateImage, synthesizeSpeech, generateVideo,
  buildImagePayload, buildTtsPayload, buildVideoPayload, normalizeImageModel, normalizeVideoModel,
  IMAGE_ENDPOINTS, DEFAULT_IMAGE_MODEL, DEFAULT_TTS_MODEL, DEFAULT_VIDEO_MODEL, VOICE_MAP, AUDIO_TYPES,
  VIDEO_PATH, VIDEO_POLL_TIMEOUT_MS,
  // 探测循环与后续工具端点实现共用（带 token 的 JSON 请求壳）
  requestJson,
};
