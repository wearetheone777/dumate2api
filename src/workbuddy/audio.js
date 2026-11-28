// src/workbuddy/audio.js - WorkBuddy 语音 TTS + ASR（批次九，misakano speech.go 协议 + 真机探针定案）
//
// 协议证据（misakano internal/upstream/speech.go：官方桌面端包内 main/server.js
// 静态反查 + 2026-11-20 真号闭环；本仓库 2026-11-28 探针复测闭环通过）：
//
//   TTS  POST {chatBase}/v2/audio/speech
//        body {model:"hunyuan-tts-2.5", stream:true,
//              speech:{input, voice, response_format:"pcm", sample_rate:24000}}
//        SSE：speech.audio.delta（audio.data = base64 PCM）→ speech.audio.done
//        → [DONE]；PCM 24kHz 单声道 s16le。**无 done 帧不能当成功**——上游分块流
//        偶发中途 close，半段音频回 200 会让客户端拿到残缺录音（panel issue #277
//        复现：132480 vs 136320 字节）。
//   ASR  POST {chatBase}/agenttool/v1/asr   multipart 字段 audio（带 filename/mime）
//        回 {code?, msg?, text}——**code 字段可能不存在**（探针实测 undefined），
//        成功判据是 code==null || code===0；text 是唯一可靠产物。
//
// 探针实测负证据（2026-11-28，别再试）：
//   - 会话三件套是渠道校验的一部分，X-Conversation-ID 空串 → 400 11101
//     missing required header；音频无会话概念，现造一个 v7 即过；
//   - baggage 不需要（没发也 200）；x-device-token 不需要（账号本就没有）；
//   - 头集 = chat 全套（chatHeaders + chatUserAgent），Content-Type 按需覆盖，
//     TTS 的 Accept 用 text/event-stream（中间层不加缓冲）。
//
// 纪律：换号上限 3（panel audioAttempts 同量级）；请求级错误（11101 / 15052 /
// 15053 / 4xx envelope）fail-fast 不换号——换号改变不了请求构造；上游侧错误
// （SSE error 帧 / 截断 / 空 PCM / 5xx）换号重试。**不喂池**：与 agenttool 同一
// 口径，音频链路失败不改账号健康（喂池误罚健康号的代价 > 少一次自动避让）。
const c = require('./constants');
const https = require('https');
const { StringDecoder } = require('string_decoder');
const { chatHeaders, chatUserAgent, uuidv7Uuid } = require('./chat');

const SPEECH_PATH = '/v2/audio/speech';
const ASR_PATH = '/agenttool/v1/asr';
const TTS_MODEL = 'hunyuan-tts-2.5';
const TTS_DEFAULT_VOICE = 'f191_female_cn_tts2.5_flash';
const TTS_SAMPLE_RATE = 24000;          // 官方固定 24kHz；转 WAV 必须用它
const MAX_AUDIO_BYTES = 3 * 1024 * 1024; // 上游 ASR 硬上限（panel 2026-11-20 实测 3.1MB → 15052）
const ASR_BODY_SLACK = 64 * 1024;        // multipart 分帧余量
const TTS_ATTEMPTS = 3;
const TTS_TIMEOUT_MS = 300000;           // 长文本合成分钟级，SSE 不能短超时
const ASR_TIMEOUT_MS = 60000;

/** 信封错误（{code, msg/message, requestId} 或裸文本）→ Error，语义与 search.js 同一套 */
function envelopeError(status, rawBuf) {
  const raw = String(rawBuf || '');
  let j = null;
  try { j = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
  if (j && (j.code != null || j.msg || j.message)) {
    const code = j.code != null ? `${j.code}: ` : '';
    const msg = String(j.msg || j.message || '').trim();
    const e = new Error(`workbuddy ${code}${msg}`.trim().slice(0, 300));
    if (j.code != null) e.upstreamCode = Number(j.code) || 0;
    if (j.requestId) e.upstreamRequestId = String(j.requestId);
    return e;
  }
  return new Error(`workbuddy HTTP ${status}: ${raw.replace(/\s+/g, ' ').slice(0, 200)}`);
}

/** 请求级错误 = 换号无意义（请求构造/体量问题），fail-fast */
function requestLevelError(e) {
  if (!e) return false;
  if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500 && e.statusCode !== 429) return true;
  // 探针/计划口径：15052（>3MB / multipart 解析失败）→ 413；15053 → 400
  return e.upstreamCode === 11101 || e.upstreamCode === 15052 || e.upstreamCode === 15053;
}

/** 单账号单次请求。3xx 禁跟随（与 agenttool 同口径）；≥400 抛信封错误。 */
function postAudio(region, account, path, bodyBuf, contentType, accept, timeoutMs) {
  return new Promise((resolve) => {
    const spec = c.specOf(region);
    const u = new URL(spec.chatBase + path);
    const h = chatHeaders(region, account, bodyBuf.length, uuidv7Uuid(), '');
    h['Content-Type'] = contentType;
    if (accept) h.Accept = accept;
    // UA 不在 chatHeaders 里（chat 的 postStream 单独补）——缺了即 11101
    h['User-Agent'] = chatUserAgent(region);
    let agent = null;
    try { agent = require('../proxy-agent').getAgentFor(account); } catch (e) { /* 无代理配置 */ }
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: h,
      timeout: timeoutMs, ...(agent ? { agent } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), location: res.headers.location || '' }));
    });
    req.on('error', (e) => resolve({ status: 0, body: Buffer.from(e.message), location: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: Buffer.from('timeout'), location: '' }); });
    req.write(bodyBuf);
    req.end();
  });
}

/** 账号轮转骨架：usable 账号逐个试（上限 attempts），请求级错误 fail-fast。 */
async function withRotation(region, opts, fn) {
  const reg = c.normalizeRegion(region);
  const authStore = require('./auth');
  let accounts = (opts && opts.account) ? [opts.account] : null;
  if (!accounts) {
    accounts = authStore.findUsable().filter((a) => c.normalizeRegion(a.region) === reg);
  }
  if (!accounts.length) {
    const err = new Error(`WorkBuddy 没有可用的${reg === 'global' ? '国际' : '国内'}账号（音频端点需要登录态）`);
    err.statusCode = 503;
    throw err;
  }
  const tried = [];
  let lastErr = null;
  for (const raw of accounts.slice(0, TTS_ATTEMPTS)) {
    let account = raw;
    try { account = await authStore.ensureFresh(account); } catch (e) { /* 刷新失败带旧 token 试 */ }
    tried.push(account.id);
    try {
      return await fn(account);
    } catch (e) {
      lastErr = e;
      if (requestLevelError(e)) throw e;
      // 账号级/上游侧错误 → 下一个账号
    }
  }
  if (lastErr) {
    if (!lastErr.statusCode) lastErr.statusCode = 502;
    throw lastErr;
  }
  const err = new Error(`WorkBuddy 音频请求失败：已试 ${tried.length} 个账号全部失败`);
  err.statusCode = 502;
  throw err;
}

/**
 * 文本转语音。返回 PCM + WAV 双份（封装格式是对外契约，由 server 层按
 * response_format 决定用哪份）。
 * @param {{input:string, voice?:string, region?:string}} p
 * @param {{account?:object}} [opts]
 * @returns {Promise<{pcm:Buffer, wav:Buffer, sampleRate:number, ms:number}>}
 */
async function speechTTS(p, opts = {}) {
  const input = String((p && p.input) || '').trim();
  if (!input) {
    const err = new Error('input 不能为空');
    err.statusCode = 400;
    throw err;
  }
  const voice = String((p && p.voice) || '').trim() || TTS_DEFAULT_VOICE;
  const body = JSON.stringify({
    model: TTS_MODEL,
    stream: true,
    speech: { input, voice, response_format: 'pcm', sample_rate: TTS_SAMPLE_RATE },
  });
  const startedAt = Date.now();
  // 经 module.exports 调用（测试缝）：单测打桩替换 postAudio 才能生效
  return withRotation(p && p.region, opts, async (account) => {
    const r = await module.exports.postAudio(p && p.region, account, SPEECH_PATH,
      Buffer.from(body, 'utf8'), 'application/json', 'text/event-stream', TTS_TIMEOUT_MS);
    if (r.status >= 300 && r.status < 400) {
      const err = new Error(`workbuddy TTS 返回重定向 ${r.status}（禁跟随，防 Authorization 外泄）${r.location ? ` → ${r.location}` : ''}`);
      err.statusCode = 502;
      throw err;
    }
    if (r.status < 200 || r.status >= 300) {
      const err = envelopeError(r.status, r.body);
      err.statusCode = r.status >= 400 && r.status < 500 ? r.status : 502;
      throw err;
    }
    // SSE 解析：delta 累积 base64 PCM；done 即收尾；error 帧如实抛（不认它就会
    // 掉到 truncated，把上游原因咽掉——panel 同款教训）
    const dec = new StringDecoder('utf8');
    const text = dec.write(r.body) + dec.end();
    const pcmParts = [];
    let sawDone = false;
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let j;
      try { j = JSON.parse(payload); } catch (e) {
        const err = new Error('workbuddy TTS 流出现非 JSON 帧');
        err.statusCode = 502;
        throw err;
      }
      if (j.error && (j.error.message || j.error.code != null)) {
        const err = new Error(`workbuddy TTS 流内错误：${String(j.error.message || '').slice(0, 160)}`);
        err.statusCode = 502;
        throw err;
      }
      if (j.type === 'speech.audio.delta' && j.audio && j.audio.data) {
        pcmParts.push(Buffer.from(j.audio.data, 'base64'));
      }
      if (j.type === 'speech.audio.done') sawDone = true;
    }
    const pcm = Buffer.concat(pcmParts);
    if (!sawDone) {
      // 无 done 帧不能当成功：半段音频回 200 比报错更糟（客户端拿到残缺录音）
      const err = new Error(`workbuddy TTS 流被截断：已收 ${pcm.length} 字节但没有 speech.audio.done`);
      err.statusCode = 502;
      err.truncated = true;
      throw err;
    }
    if (pcm.length === 0) {
      const err = new Error('workbuddy TTS 流完成但没有任何音频');
      err.statusCode = 502;
      throw err;
    }
    return { pcm, wav: pcmToWav(pcm, TTS_SAMPLE_RATE), sampleRate: TTS_SAMPLE_RATE, ms: Date.now() - startedAt };
  });
}

/** 给裸 PCM 套 44 字节 RIFF 头（24kHz 单声道 s16le） */function pcmToWav(pcm, sampleRate = TTS_SAMPLE_RATE) {
  const ch = 1, bits = 16;
  const byteRate = sampleRate * ch * bits / 8;
  const blockAlign = ch * bits / 8;
  const b = Buffer.alloc(44 + pcm.length);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + pcm.length, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);          // fmt 块长度
  b.writeUInt16LE(1, 20);           // PCM
  b.writeUInt16LE(ch, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(bits, 34);
  b.write('data', 36);
  b.writeUInt32LE(pcm.length, 40);
  pcm.copy(b, 44);
  return b;
}

/**
 * 极简 multipart 解析：只取第一个带 filename 的文件部件（字段 file|audio 都认，
 * OpenAI 用 file、官方工具用 audio）与全部小型文本字段。
 * 零依赖实现——Node 没有内置 multipart 解析器，为这一个用途引第三方不值。
 * @param {Buffer} body 原始请求体
 * @param {string} contentTypeHeader 请求的 Content-Type（取 boundary）
 * @returns {{filename:string, contentType:string, bytes:Buffer, fields:Record<string,string>}}
 */
function parseMultipartAudio(body, contentTypeHeader) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentTypeHeader || ''));
  if (!m) {
    const err = new Error('Content-Type 缺少 multipart boundary');
    err.statusCode = 400;
    throw err;
  }
  const boundary = `--${(m[1] || m[2]).trim()}`;
  const bBuf = Buffer.from(boundary);
  const fields = {};
  let audioPart = null;
  // 按 boundary 切分：找每段起点与 \r\n\r\n 头体分界
  let pos = body.indexOf(bBuf);
  while (pos !== -1) {
    const lineEnd = body.indexOf('\r\n', pos + bBuf.length);
    if (lineEnd === -1) break;
    // closing boundary（--boundary--）→ 结束
    if (body.slice(pos + bBuf.length, lineEnd).toString().trim() === '--') break;
    const headStart = lineEnd + 2;
    const headEnd = body.indexOf('\r\n\r\n', headStart);
    if (headEnd === -1) break;
    const headers = body.slice(headStart, headEnd).toString('utf8');
    const next = body.indexOf(bBuf, headEnd + 4);
    if (next === -1) break;
    // 部件体在 headEnd+4 与下一个 boundary 前的 \r\n 之间
    const value = body.slice(headEnd + 4, next - 2);
    const dispLine = /Content-Disposition:[^\r\n]*/i.exec(headers);
    const disp = dispLine ? /name="([^"]*)"(?:; filename="([^"]*)")?/.exec(dispLine[0]) : null;
    const name = disp ? disp[1] : '';
    const filename = disp && disp[2] ? disp[2] : '';
    if (filename) {
      // 多个文件部件取第一个
      if (!audioPart) {
        audioPart = {
          filename,
          contentType: (/Content-Type:\s*([^\r\n]+)/i.exec(headers) || [, ''])[1].trim(),
          bytes: value,
        };
      }
    } else if (name) {
      fields[name] = value.toString('utf8');
    }
    pos = next;
  }
  if (!audioPart) {
    const err = new Error('缺少音频文件：multipart 字段需为 file（OpenAI）或 audio');
    err.statusCode = 400;
    throw err;
  }
  return { ...audioPart, fields };
}

/**
 * 语音转文本。音频字节原样转发不转码（转码只引入失真与依赖——panel 同口径）。
 * @param {{audio:Buffer, filename?:string, contentType?:string, region?:string,
 *          responseFormat?:string}} p
 * @param {{account?:object}} [opts]
 * @returns {Promise<{text:string, ms:number}>}
 */
async function transcribe(p, opts = {}) {
  const audio = p && p.audio;
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    const err = new Error('音频内容为空');
    err.statusCode = 400;
    throw err;
  }
  if (audio.length > MAX_AUDIO_BYTES) {
    const err = new Error(`音频 ${(audio.length / 1048576).toFixed(2)}MB 超过上游 3MB 上限`);
    err.statusCode = 413;
    err.code = 'audio_too_large';
    throw err;
  }
  const filename = String((p && p.filename) || 'audio.wav');
  const partType = String((p && p.contentType) || 'application/octet-stream');
  const B = '----dumate2api-asr-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const head = Buffer.from(
    `--${B}\r\nContent-Disposition: form-data; name="audio"; filename="${filename.replace(/"/g, '')}"\r\nContent-Type: ${partType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${B}--\r\n`);
  const body = Buffer.concat([head, audio, tail]);
  const startedAt = Date.now();
  const region = p && p.region;
  return withRotation(region, opts, async (account) => {
    const r = await module.exports.postAudio(region, account, ASR_PATH, body,
      `multipart/form-data; boundary=${B}`, null, ASR_TIMEOUT_MS);
    if (r.status >= 300 && r.status < 400) {
      const err = new Error(`workbuddy ASR 返回重定向 ${r.status}（禁跟随，防 Authorization 外泄）${r.location ? ` → ${r.location}` : ''}`);
      err.statusCode = 502;
      throw err;
    }
    if (r.status < 200 || r.status >= 300) {
      const err = envelopeError(r.status, r.body);
      // 15052（体量/multipart 解析）→ 413；其余 4xx 透传
      if (err.upstreamCode === 15052) err.statusCode = 413;
      else err.statusCode = r.status >= 400 && r.status < 500 ? r.status : 502;
      throw err;
    }
    let j = null;
    try { j = JSON.parse(r.body.toString('utf8')); } catch (e) { /* 非 JSON */ }
    if (!j || typeof j !== 'object') {
      const err = new Error('workbuddy ASR 返回非 JSON 响应');
      err.statusCode = 502;
      throw err;
    }
    // code 字段可能不存在（探针实测 undefined）——成功判据 code==null || 0
    const code = j.code == null ? 0 : Number(j.code);
    if (code !== 0) {
      const err = new Error(`workbuddy ASR code=${code}: ${String(j.msg || '').slice(0, 200)}`);
      err.upstreamCode = code;
      err.statusCode = code === 15052 ? 413 : (code === 15053 ? 400 : (r.status >= 400 && r.status < 500 ? r.status : 502));
      throw err;
    }
    return { text: String(j.text || ''), ms: Date.now() - startedAt };
  });
}

/**
 * /v1/audio/speech 的模型名分派（搭子 TTS 与 WorkBuddy TTS 共用该路径）。
 * WorkBuddy 认：hunyuan-tts*（上游写死模型，OpenAI 客户端的 tts-1 是占位名
 * 继续归搭子）、wb:/wb/ 前缀、cn:/global: 域前缀（后两者来自 panel audioRealm
 * 口径——前缀同时是区域覆写）。
 * @returns {{workbuddy:boolean, region:('cn'|'global'|null)}} region 为模型名前缀
 *          覆写（无前缀 null → 调用方按 key 区域/默认 cn）
 */
function resolveTTSDispatch(model) {
  const raw = String(model || '').trim();
  if (!raw) return { workbuddy: false, region: null };
  let region = null;
  let name = raw;
  const pm = /^(cn|global)[:/](.+)$/i.exec(raw);
  if (pm) {
    region = pm[1].toLowerCase() === 'global' ? 'global' : 'cn';
    name = pm[2];
  }
  const workbuddy = /^wb[:/]/i.test(name) || /^hunyuan-tts/i.test(name);
  return { workbuddy, region };
}

module.exports = {
  speechTTS, transcribe, pcmToWav, parseMultipartAudio, envelopeError, resolveTTSDispatch,
  postAudio,
  SPEECH_PATH, ASR_PATH, TTS_MODEL, TTS_DEFAULT_VOICE, TTS_SAMPLE_RATE,
  MAX_AUDIO_BYTES, ASR_BODY_SLACK, TTS_ATTEMPTS,
};
