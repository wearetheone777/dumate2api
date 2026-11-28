#!/usr/bin/env node
// test/probe-workbuddy-audio.js - WorkBuddy 音频探针（批次九，探针先行）
//
// 协议证据：misakano internal/upstream/speech.go（官方桌面端包内 main/server.js
// 静态反查 + 2026-11-20 真号闭环实测，未抓包对照）：
//   TTS POST {chatBase}/v2/audio/speech   SSE：speech.audio.delta(base64 PCM)
//         → speech.audio.done → [DONE]；PCM 24kHz 单声道 s16le
//   ASR POST {chatBase}/agenttool/v1/asr  multipart 字段 audio → {code, msg, text}
//
// 本探针做 TTS→ASR 闭环：合成「探针文本」→ 套 WAV 头 → 喂回 ASR → 对照转写。
// 绝不打印 token；只打印帧型序列、字节数、耗时与转写文本。
'use strict';

const authStore = require('../src/workbuddy/auth');
const c = require('../src/workbuddy/constants');
const { chatHeaders, chatUserAgent, uuidv7Uuid } = require('../src/workbuddy/chat');
const https = require('https');
const { StringDecoder } = require('string_decoder');

const REGION = c.normalizeRegion(process.argv[2] || 'cn');
const PROBE_TEXT = '你好，这是 WorkBuddy 语音探针。';

function post(account, path, bodyBuf, contentType, accept) {
  return new Promise((resolve) => {
    const spec = c.specOf(REGION);
    const u = new URL(spec.chatBase + path);
    // 会话头三件套是渠道校验的一部分——官方客户端 chat/**speech** 都带，缺任一即
    // 400 11101 missing required header（panel injectConversationHeaders 空 meta
    // 现造 v7 的注释原文）。音频无会话概念，现造一个 v7 即可。
    const h = chatHeaders(REGION, account, Buffer.isBuffer(bodyBuf) ? bodyBuf.length : Buffer.byteLength(bodyBuf), uuidv7Uuid(), '');
    h['Content-Type'] = contentType;
    if (accept) h.Accept = accept;
    // UA 不在 chatHeaders 里（chat 的 postStream 单独补）——漏了就是 11101 missing required header
    h['User-Agent'] = chatUserAgent(REGION);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: h,
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', (e) => resolve({ status: 0, body: Buffer.from(e.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: Buffer.from('timeout') }); });
    req.write(bodyBuf);
    req.end();
  });
}

// 44 字节 RIFF 头（24kHz 单声道 s16le）——misakano wavFromPCM 同款
function pcmToWav(pcm, sampleRate) {
  const ch = 1, bits = 16;
  const byteRate = sampleRate * ch * bits / 8;
  const blockAlign = ch * bits / 8;
  const b = Buffer.alloc(44 + pcm.length);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + pcm.length, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);          // PCM
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

async function main() {
  const usable = authStore.findUsable().filter((a) => c.normalizeRegion(a.region) === REGION);
  if (!usable.length) { console.log(`no usable ${REGION} account`); process.exit(1); }
  const account = await authStore.ensureFresh(usable[0]);
  console.log(`account#${account.id} region=${REGION} chatBase=${c.specOf(REGION).chatBase}`);

  // ---- 1. TTS：SSE + base64 PCM ----
  const ttsBody = JSON.stringify({
    model: 'hunyuan-tts-2.5', stream: true,
    speech: { input: PROBE_TEXT, voice: 'f191_female_cn_tts2.5_flash', response_format: 'pcm', sample_rate: 24000 },
  });
  const t0 = Date.now();
  const r = await post(account, '/v2/audio/speech', ttsBody, 'application/json', 'text/event-stream');
  const ttsMs = Date.now() - t0;
  console.log(`\n== tts == status=${r.status} bytes=${r.body.length} ${ttsMs}ms`);
  if (r.status !== 200) { console.log(`body: ${r.body.toString('utf8').slice(0, 400)}`); process.exit(3); }

  // SSE 解析：帧型序列 + PCM 累积
  const dec = new StringDecoder('utf8');
  const text = dec.write(r.body) + dec.end();
  const types = [];
  let pcm = Buffer.alloc(0);
  let sawDone = false, sawBracket = false, sseError = null;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') { sawBracket = true; continue; }
    let j;
    try { j = JSON.parse(payload); } catch (e) { console.log(`non-json frame: ${payload.slice(0, 120)}`); continue; }
    if (j.type && !types.includes(j.type)) types.push(j.type);
    if (j.type === 'speech.audio.delta' && j.audio && j.audio.data) {
      pcm = Buffer.concat([pcm, Buffer.from(j.audio.data, 'base64')]);
    }
    if (j.type === 'speech.audio.done') sawDone = true;
    if (j.type === 'error' || j.error) sseError = JSON.stringify(j).slice(0, 200);
  }
  console.log(`frame types: ${types.join(', ')}${sawDone ? ' +done' : ''}${sawBracket ? ' +[DONE]' : ''}`);
  if (sseError) console.log(`sse error frame: ${sseError}`);
  console.log(`pcm=${pcm.length} bytes (~${(pcm.length / 2 / 24000).toFixed(2)}s audio)`);
  if (!sawDone || pcm.length === 0) { console.log('MISSING speech.audio.done or empty PCM — truncated stream'); process.exit(4); }

  // ---- 2. WAV 封装 ----
  const wav = pcmToWav(pcm, 24000);
  console.log(`\nwav=${wav.length} bytes`);

  // ---- 3. ASR：multipart 字段 audio → {code, text} ----
  const B = '----dumate2api-probe-' + Date.now();
  const head = Buffer.from(
    `--${B}\r\nContent-Disposition: form-data; name="audio"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${B}--\r\n`);
  const mp = Buffer.concat([head, wav, tail]);
  const t1 = Date.now();
  const r2 = await post(account, '/agenttool/v1/asr', mp, `multipart/form-data; boundary=${B}`, null);
  const asrMs = Date.now() - t1;
  console.log(`\n== asr == status=${r2.status} ${asrMs}ms`);
  const bodyStr = r2.body.toString('utf8');
  let j2 = null;
  try { j2 = JSON.parse(bodyStr); } catch (e) { /* 非 JSON */ }
  if (j2) {
    console.log(`code=${j2.code} msg=${String(j2.msg || '')}`);
    console.log(`text: ${String(j2.text || '').slice(0, 200)}`);
    if (Number(j2.code) === 0) {
      const ok = String(j2.text || '').includes('语音探针') || String(j2.text || '').includes('探针');
      console.log(`round-trip: ${ok ? 'OK（转写含探针词）' : '内容有偏差，人工核对'}`);
    }
  } else {
    console.log(`non-json body: ${bodyStr.slice(0, 400)}`);
  }
}

main().catch((e) => { console.log(`ERROR ${e.message}`); process.exit(3); });
