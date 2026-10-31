// src/qwenwork/voice.js - 千问语音润色（2026-11-01，客户端 1.4.0 解包定案）
//
// 协议全部取自解包 main.js 的 `polishVoiceText` / `fetchVoicePolishApi` /
// `buildVoicePolishMessages`（不是猜的）：
//
//   POST {GATEWAY}/algo/api/v2/service/voice/polish
//   Headers: Content-Type: application/json / User-Agent: QoderWork /
//            Authorization: Bearer <accessToken>     ← **纯 Bearer，无 COSY 签名**
//            （与 barn 上传同族：客户端这条链路只发这三个头）
//   Body: { session_id, request_id, client_type: 0, messages: [{role, content}...] }
//     末条 user 消息是 `<transcription>转写文本</transcription>` 包裹——
//     XML 包裹是协议的一部分（模型按它识别哪段是待润色的转写）。
//   30 秒超时（客户端AbortController 3e4 同款）。
//
// 响应是普通 JSON，**文本位置有多个候选**（解包 extractVoicePolishText 的
// 候选序）：messages / message / text / result.content / result.message /
// result.text / data.messages / data.message / data.text / data.result.content。
// 401 时刷新 token 重试一次（客户端同款逻辑）。
//
// 价值：语音输入场景——把 ASR 转写的原始文本润色成可直接发送的话
// （纠错、去填充词、保持原意；不回答内容、不加新信息）。客户端的
// system_voice_input 指令与 memory hints 是会话内场景，网关版不带
// （调用方没有那个上下文；带半截上下文反而误导模型）。
const crypto = require('crypto');
const c = require('./constants');
const authStore = require('./auth');

const VOICE_POLISH_PATH = '/algo/api/v2/service/voice/polish';
const CLIENT_TYPE = 0;
const TIMEOUT_MS = Number(process.env.DUMATE_QWENWORK_VOICE_TIMEOUT_MS || 30000);

/** 官方响应文本候选序（解包 extractVoicePolishText，逐字对照） */
function extractPolishedText(data) {
  if (!data || typeof data !== 'object') return null;
  const candidates = [
    data.messages, data.message, data.text,
    data.result && data.result.content,
    data.result && data.result.message,
    data.result && data.result.text,
    data.data && data.data.messages,
    data.data && data.data.message,
    data.data && data.data.text,
    data.data && data.data.result && data.data.result.content,
  ];
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** 单次请求。返回 { status, json, raw, error } */
function postPolish(token, body, account) {
  return new Promise((resolve) => {
    let agent = null;
    try { agent = require('../proxy-agent').getAgentFor(account || null); } catch (e) { /* 直连 */ }
    const u = new URL(c.GATEWAY + VOICE_POLISH_PATH);
    const payload = JSON.stringify(body);
    const req = require('https').request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'QoderWork',
        Authorization: `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: TIMEOUT_MS,
      ...(agent ? { agent } : {}),
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (x) => { b += x; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, raw: b });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, raw: '', error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, raw: '', error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

/**
 * 润色一段语音转写文本。
 * @param {string} text ASR 原始转写（必填）
 * @param {object} [opts] { accountId } 指定账号（缺省池首选）
 * @returns {{ok:true, text, model?:undefined} | {ok:false, status, error}}
 */
async function polishVoiceText(text, opts = {}) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { ok: false, status: 400, error: 'text 不能为空（待润色的转写文本）' };
  const account = (opts.accountId && authStore.get(opts.accountId))
    || authStore.preferred();
  if (!account || !account.accessToken) return { ok: false, status: 503, error: '千问没有可用账号' };

  const body = {
    session_id: crypto.randomUUID(),
    request_id: crypto.randomUUID(),
    client_type: CLIENT_TYPE,
    messages: [{ role: 'user', content: `<transcription>${raw}</transcription>` }],
  };
  let r = await postPolish(account.accessToken, body, account);
  // 401 换票重试一次（客户端同款；换票失败如实报）
  if (r.status === 401) {
    try {
      const ex = await authStore.exchange(account);
      if (ex && ex.ok) {
        const fresh = authStore.get(account.id) || account;
        r = await postPolish(fresh.accessToken, body, fresh);
      }
    } catch (e) { /* 换票失败用原错误 */ }
  }
  if (r.status !== 200 || !r.json) {
    return { ok: false, status: r.status || 502, error: (r.json && (r.json.message || r.json.error)) || String(r.raw || '').slice(0, 160) || r.error || `HTTP ${r.status}` };
  }
  const out = extractPolishedText(r.json);
  if (!out) {
    return { ok: false, status: 502, error: `润色响应无可识别文本: ${JSON.stringify(r.json).slice(0, 160)}` };
  }
  return { ok: true, text: out };
}

module.exports = { polishVoiceText, extractPolishedText, VOICE_POLISH_PATH };
