// test/unit/workbuddy-audio.test.js - 批次九：WorkBuddy TTS + ASR
//
// 协议定案来自真机探针（test/probe-workbuddy-audio.js，2026-11-28 闭环通过）：
//   TTS SSE：speech.audio.delta(base64 PCM) → speech.audio.done + [DONE]
//   ASR：multipart 字段 audio → {code?, msg?, text}——code 可能不存在
//
// 打桩：postAudio 走 module.exports（audio.js 内部经模块对象调用，补丁生效）；
// 账号轮转打桩 auth.findUsable/ensureFresh（DUMATE_ADMIN_DATA 隔离目录兜底）。
//
// 运行：node --test test/unit/workbuddy-audio.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.DUMATE_ADMIN_DATA = path.join(os.tmpdir(), `dumate-wb-audio-${process.pid}`);

const audio = require('../../src/workbuddy/audio');
const authStore = require('../../src/workbuddy/auth');

const realPostAudio = audio.postAudio;

function stubAuth(accounts) {
  authStore.findUsable = () => accounts;
  authStore.ensureFresh = async (a) => a;
}

// ---- pcmToWav ----

test('pcmToWav：44 字节 RIFF 头字段逐项正确', () => {
  const pcm = Buffer.alloc(100, 7);
  const wav = audio.pcmToWav(pcm, 24000);
  assert.strictEqual(wav.length, 144);
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.readUInt32LE(4), 36 + 100);
  assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(wav.toString('ascii', 12, 16), 'fmt ');
  assert.strictEqual(wav.readUInt32LE(16), 16);
  assert.strictEqual(wav.readUInt16LE(20), 1);        // PCM
  assert.strictEqual(wav.readUInt16LE(22), 1);        // mono
  assert.strictEqual(wav.readUInt32LE(24), 24000);    // sample rate
  assert.strictEqual(wav.readUInt32LE(28), 48000);    // byte rate = 24000*1*16/8
  assert.strictEqual(wav.readUInt16LE(32), 2);        // block align
  assert.strictEqual(wav.readUInt16LE(34), 16);       // bits
  assert.strictEqual(wav.toString('ascii', 36, 40), 'data');
  assert.strictEqual(wav.readUInt32LE(40), 100);
  assert.strictEqual(wav[44], 7);                     // PCM 原样跟在头后
});

// ---- parseMultipartAudio ----

function buildMultipart(field, filename, bytes, extraFields = {}) {
  const B = '----test-boundary';
  const parts = [];
  parts.push(`--${B}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: audio/wav\r\n\r\n`);
  parts.push(bytes);
  for (const [k, v] of Object.entries(extraFields)) {
    parts.push(`\r\n--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`);
  }
  parts.push(`\r\n--${B}--\r\n`);
  return { body: Buffer.concat(parts.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x, 'utf8')))), type: `multipart/form-data; boundary=${B}` };
}

test('parseMultipartAudio：file 字段（OpenAI 形）+ 文本字段 + 二进制字节保真', () => {
  const pcm = Buffer.from([0, 130, 255, 1, 254, 66, 77]);  // 含高位字节，utf8 会碎
  const { body, type } = buildMultipart('file', 'a.wav', pcm, { response_format: 'text', model: 'whisper-1' });
  const p = audio.parseMultipartAudio(body, type);
  assert.strictEqual(p.filename, 'a.wav');
  assert.strictEqual(p.contentType, 'audio/wav');
  assert.deepStrictEqual([...p.bytes], [...pcm], '二进制逐字节保真');
  assert.deepStrictEqual(p.fields, { response_format: 'text', model: 'whisper-1' });
});

test('parseMultipartAudio：audio 字段（官方工具形）也认；带引号 boundary 也认', () => {
  const { body } = buildMultipart('audio', 'x.mp3', Buffer.from('abc'));
  const p = audio.parseMultipartAudio(body, 'multipart/form-data; boundary="----test-boundary"');
  assert.strictEqual(p.filename, 'x.mp3');
  assert.strictEqual(p.bytes.toString(), 'abc');
});

test('parseMultipartAudio：无 boundary → 400；缺文件部件 → 400', () => {
  assert.throws(() => audio.parseMultipartAudio(Buffer.from('x'), 'application/json'),
    (e) => e.statusCode === 400);
  const B = '----b';
  const onlyText = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${B}--\r\n`);
  assert.throws(() => audio.parseMultipartAudio(onlyText, `multipart/form-data; boundary=${B}`),
    (e) => e.statusCode === 400 && /file（OpenAI）或 audio/.test(e.message));
});

test('parseMultipartAudio：多个文件部件取第一个', () => {
  const B = '----b';
  const body = Buffer.concat([
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="first.wav"\r\nContent-Type: audio/wav\r\n\r\nFIRST`),
    Buffer.from(`\r\n--${B}\r\nContent-Disposition: form-data; name="file"; filename="second.wav"\r\nContent-Type: audio/wav\r\n\r\nSECOND`),
    Buffer.from(`\r\n--${B}--\r\n`),
  ]);
  const p = audio.parseMultipartAudio(body, `multipart/form-data; boundary=${B}`);
  assert.strictEqual(p.filename, 'first.wav');
  assert.strictEqual(p.bytes.toString(), 'FIRST');
});

// ---- speechTTS ----

function sseFrame(obj) {
  return Buffer.from(`data: ${JSON.stringify(obj)}\n\n`);
}

function sseStream(frames) {
  return Buffer.concat([...frames.map(sseFrame), Buffer.from('data: [DONE]\n\n')]);
}

test('speechTTS：delta 累积 + done 收尾 → pcm/wav 双份', async () => {
  stubAuth([{ id: 1, accessToken: 'at', region: 'cn' }]);
  const c1 = Buffer.from([1, 2, 3, 4]);
  const c2 = Buffer.from([5, 6]);
  audio.postAudio = async () => ({
    status: 200,
    body: sseStream([
      { type: 'speech.audio.delta', audio: { data: c1.toString('base64') } },
      { type: 'speech.audio.delta', audio: { data: c2.toString('base64') } },
      { type: 'speech.audio.done' },
    ]),
    location: '',
  });
  const r = await audio.speechTTS({ input: '你好' });
  assert.strictEqual(r.pcm.length, 6);
  assert.deepStrictEqual([...r.pcm], [1, 2, 3, 4, 5, 6]);
  assert.strictEqual(r.wav.length, 44 + 6);
  assert.strictEqual(r.sampleRate, 24000);
});

test('speechTTS：无 done 帧 → 502 truncated（半段音频不能当成功）', async () => {
  stubAuth([{ id: 1, accessToken: 'at', region: 'cn' }]);
  audio.postAudio = async () => ({
    status: 200,
    body: sseStream([{ type: 'speech.audio.delta', audio: { data: Buffer.from([9]).toString('base64') } }]),
    location: '',
  });
  await assert.rejects(() => audio.speechTTS({ input: '你好' }),
    (e) => e.statusCode === 502 && e.truncated === true && /截断/.test(e.message));
});

test('speechTTS：流内 error 帧如实抛（不吞成 truncated）', async () => {
  stubAuth([{ id: 1, accessToken: 'at', region: 'cn' }]);
  audio.postAudio = async () => ({
    status: 200,
    body: sseStream([{ type: 'error', error: { message: 'quota exhausted', code: 42 } }]),
    location: '',
  });
  await assert.rejects(() => audio.speechTTS({ input: '你好' }),
    (e) => e.statusCode === 502 && /quota exhausted/.test(e.message));
});

test('speechTTS：空 PCM → 502；空 input → 400 不打上游', async () => {
  stubAuth([{ id: 1, accessToken: 'at', region: 'cn' }]);
  audio.postAudio = async () => ({ status: 200, body: sseStream([{ type: 'speech.audio.done' }]), location: '' });
  await assert.rejects(() => audio.speechTTS({ input: '你好' }), (e) => e.statusCode === 502);
  audio.postAudio = async () => { throw new Error('不该被调用'); };
  await assert.rejects(() => audio.speechTTS({ input: '  ' }), (e) => e.statusCode === 400);
});

test('speechTTS：HTTP 4xx 信封 → 状态码透传 fail-fast 不换号', async () => {
  stubAuth([{ id: 1, accessToken: 'at', region: 'cn' }, { id: 2, accessToken: 'at2', region: 'cn' }]);
  let calls = 0;
  audio.postAudio = async () => { calls++; return { status: 400, body: Buffer.from(JSON.stringify({ code: 11101, msg: 'missing required header' })), location: '' }; };
  await assert.rejects(() => audio.speechTTS({ input: '你好' }),
    (e) => e.statusCode === 400 && e.upstreamCode === 11101);
  assert.strictEqual(calls, 1, '请求级错误不换号');
});

test('speechTTS：上游侧错误（5xx）换号重试，上限 3', async () => {
  stubAuth([{ id: 1, accessToken: 'a1', region: 'cn' }, { id: 2, accessToken: 'a2', region: 'cn' }, { id: 3, accessToken: 'a3', region: 'cn' }, { id: 4, accessToken: 'a4', region: 'cn' }]);
  const tried = [];
  audio.postAudio = async (region, account) => {
    tried.push(account.id);
    return { status: 500, body: Buffer.from('boom'), location: '' };
  };
  await assert.rejects(() => audio.speechTTS({ input: '你好' }), (e) => e.statusCode === 502);
  assert.deepStrictEqual(tried, [1, 2, 3], '轮转以 3 为上限，第 4 个账号不再尝试');
});

test('speechTTS：第一个账号截断（可重试错误）→ 第二个成功', async () => {
  stubAuth([{ id: 1, accessToken: 'a1', region: 'cn' }, { id: 2, accessToken: 'a2', region: 'cn' }]);
  let calls = 0;
  audio.postAudio = async () => {
    calls++;
    if (calls === 1) return { status: 200, body: sseStream([{ type: 'speech.audio.delta', audio: { data: 'AAAA' } }]), location: '' };
    return { status: 200, body: sseStream([{ type: 'speech.audio.delta', audio: { data: 'BQ==' } }, { type: 'speech.audio.done' }]), location: '' };
  };
  const r = await audio.speechTTS({ input: '你好' });
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual([...r.pcm], [5]);
});

// ---- transcribe ----

test('transcribe：code 字段不存在（探针实测 undefined）→ 成功取 text', async () => {
  stubAuth([{ id: 1, accessToken: 'at', region: 'cn' }]);
  audio.postAudio = async () => ({ status: 200, body: Buffer.from(JSON.stringify({ text: '你好，这是探针。' })), location: '' });
  const r = await audio.transcribe({ audio: Buffer.from('abc'), filename: 'a.wav', contentType: 'audio/wav' });
  assert.strictEqual(r.text, '你好，这是探针。');
});

test('transcribe：code=0 显式成功；code=15052 → 413；code=15053 → 400', async () => {
  stubAuth([{ id: 1, accessToken: 'at', region: 'cn' }]);
  audio.postAudio = async () => ({ status: 200, body: Buffer.from(JSON.stringify({ code: 0, text: 'ok' })), location: '' });
  assert.strictEqual((await audio.transcribe({ audio: Buffer.from('a') })).text, 'ok');
  audio.postAudio = async () => ({ status: 200, body: Buffer.from(JSON.stringify({ code: 15052, msg: 'ensure file size is under 3MB' })), location: '' });
  await assert.rejects(() => audio.transcribe({ audio: Buffer.from('a') }),
    (e) => e.statusCode === 413 && e.upstreamCode === 15052);
  audio.postAudio = async () => ({ status: 200, body: Buffer.from(JSON.stringify({ code: 15053, msg: 'unsupported format' })), location: '' });
  await assert.rejects(() => audio.transcribe({ audio: Buffer.from('a') }),
    (e) => e.statusCode === 400 && e.upstreamCode === 15053);
});

test('transcribe：未知业务码（HTTP 200 信封）按上游侧处置换号，最终 502', async () => {
  stubAuth([{ id: 1, accessToken: 'at', region: 'cn' }, { id: 2, accessToken: 'at2', region: 'cn' }]);
  let calls = 0;
  audio.postAudio = async () => {
    calls++;
    return { status: 200, body: Buffer.from(JSON.stringify({ code: 99, msg: 'mystery' })), location: '' };
  };
  // 不认识的码不猜：按上游侧处置轮转（panel Classify 同款），两个账号都失败如实 502
  await assert.rejects(() => audio.transcribe({ audio: Buffer.from('a') }), (e) => e.statusCode === 502);
  assert.strictEqual(calls, 2, '未知业务码轮转而不是 fail-fast');
  audio.postAudio = async () => ({ status: 401, body: Buffer.from(JSON.stringify({ code: 401, msg: 'unauthorized' })), location: '' });
  await assert.rejects(() => audio.transcribe({ audio: Buffer.from('a') }), (e) => e.statusCode === 401);
});

test('transcribe：3MB 预检 413 不打上游；空音频 → 400', async () => {
  audio.postAudio = async () => { throw new Error('不该被调用'); };
  await assert.rejects(() => audio.transcribe({ audio: Buffer.alloc(4 * 1024 * 1024) }),
    (e) => e.statusCode === 413 && e.code === 'audio_too_large');
  await assert.rejects(() => audio.transcribe({ audio: Buffer.alloc(0) }), (e) => e.statusCode === 400);
  await assert.rejects(() => audio.transcribe({ audio: 'not-a-buffer' }), (e) => e.statusCode === 400);
});

// ---- resolveTTSDispatch ----

test('resolveTTSDispatch：hunyuan/wb 前缀归 workbuddy，tts-1 占位名归搭子', () => {
  assert.strictEqual(audio.resolveTTSDispatch('hunyuan-tts-2.5').workbuddy, true);
  assert.strictEqual(audio.resolveTTSDispatch('wb:hunyuan-tts-2.5').workbuddy, true);
  assert.strictEqual(audio.resolveTTSDispatch('wb/tts').workbuddy, true);
  assert.strictEqual(audio.resolveTTSDispatch('tts-1').workbuddy, false, 'OpenAI 占位名不归 workbuddy');
  assert.strictEqual(audio.resolveTTSDispatch('').workbuddy, false);
  assert.strictEqual(audio.resolveTTSDispatch('dumate-tts-x').workbuddy, false);
});

test('resolveTTSDispatch：cn:/global: 前缀是区域覆写', () => {
  const cn = audio.resolveTTSDispatch('cn:hunyuan-tts-2.5');
  assert.strictEqual(cn.workbuddy, true);
  assert.strictEqual(cn.region, 'cn');
  const g = audio.resolveTTSDispatch('global:hunyuan-tts-2.5');
  assert.strictEqual(g.workbuddy, true);
  assert.strictEqual(g.region, 'global');
  assert.strictEqual(audio.resolveTTSDispatch('hunyuan-tts-2.5').region, null, '无前缀不覆写区域');
});

// ---- 接线自证 ----

test('接线自证：server.js 三处接线（路由 / 鉴权分派 / handler 分派）', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../../src/server.js'), 'utf8');
  assert.ok(src.includes("'/v1/audio/transcriptions'"), 'ASR 路由在位');
  assert.ok(src.includes('handleWorkbuddyTranscriptions'), 'ASR handler 在位');
  // 鉴权：transcriptions 路径归 workbuddy；speech 按 resolveTTSDispatch 分派
  assert.ok(src.includes("/^\\/(v1\\/)?audio\\/transcriptions/"), '鉴权 transcriptions 分支在位');
  assert.ok(src.includes('resolveTTSDispatch(model).workbuddy'), '鉴权 speech 按模型分派在位');
  // handler 分派在搭子 TTS 的 body 解析之后
  assert.ok(src.includes('ttsDispatch.workbuddy'), 'handleSpeech 内分派在位');
  // Buffer 读（二进制 multipart 不能走 utf8 字符串 readBody）
  assert.ok(src.includes('readBodyBuffer(req, wbAudio.MAX_AUDIO_BYTES'), 'ASR 用 Buffer 版读体');
  // 旧路径表不再吞 audio/speech（已由专属分支接管）
  assert.ok(!/images\\\/generations\|videos\\\/generations\|audio\\\/speech/.test(src), '旧路径表已摘除 audio/speech');
});
