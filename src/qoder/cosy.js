// src/qoder/cosy.js - Qoder 通道的 COSY 请求构造
//
// **算法本体在 src/cosy.js**（与千问办公共用同一套协议栈，只实现一份）。
// 这里只放 Qoder 特有的部分：身份字段、cosyVersion、请求头取值。
//
// 离线验证：node test/verify-qoder-cosy.js
const core = require('../cosy');
const c = require('./constants');

// ---- 身份形态（对齐官方客户端，qoder2api-hub #64 逆向结论）----
// 官方推理/模型请求层注入 Cosy-MachineOS；Cosy-MachineHostname 只在
// infer-sse（流式对话）场景带，且按账号稳定派生——同一账号永远相同，
// 不同账号互不相同（多号不共享设备画像的基础）。
// `DUMATE_QODER_OS_HEADERS=0` 可整体关闭。
const OS_HEADERS = !(process.env.DUMATE_QODER_OS_HEADERS || '').trim().match(/^(0|off|false|no)$/i);

/** cosy-machineos：官方形态 {arch}_{platform}。默认保持 Windows=x86_64_win32
 *  （避免非 x64/非 Windows 宿主升级后设备指纹漂移）；`auto` 按当前系统识别，
 *  也可直接指定任意值（DUMATE_QODER_MACHINE_OS）。 */
function resolveMachineOs() {
  const raw = (process.env.DUMATE_QODER_MACHINE_OS || '').trim();
  if (raw.toLowerCase() === 'auto') {
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const plat = process.platform.startsWith('win') ? 'win32'
      : process.platform === 'darwin' ? 'darwin' : 'linux';
    return `${arch}_${plat}`;
  }
  if (raw) return raw;
  return process.platform.startsWith('win') ? 'x86_64_win32' : 'x86_64_linux';
}
const MACHINE_OS = resolveMachineOs();

/** 按账号稳定派生主机名，形如 DESKTOP-1A2B3C4（md5("hostname:"+uid) 前 7 位）。 */
function machineHostname(uid) {
  const h = core.md5hex('hostname:' + (uid || 'anonymous'));
  return 'DESKTOP-' + h.slice(0, 7).toUpperCase();
}

/** 官方 CLI 的推理请求不设 User-Agent，由其 HTTP 库（undici）补默认值。
 *  我们原先照参考实现发 Go-http-client/2.0——那是 Go 的指纹，不是官方的。
 *  `DUMATE_QODER_UA` 可覆盖。 */
const USER_AGENT = (process.env.DUMATE_QODER_UA || 'undici').trim() || 'undici';

/** 身份 JSON 的字段顺序必须与 Go 的 map 序列化一致（字母序） */
function identityJson(id) {
  return core.sortedJson({
    aid: id.aid || '',
    name: id.name || '',
    organization_id: id.organizationId || '',
    organization_name: id.organizationName || '',
    refresh_token: id.refreshToken || '',
    security_oauth_token: id.securityOauthToken || '',
    uid: id.uid || '',
    user_type: id.userType || '',
    yx_uid: id.yxUid || '',
  });
}

/**
 * 构造一个会话（一次登录对应一个）。
 * 返回结构与拆分前一致——调用方依赖 identity / machine* 这几个字段。
 */
function newSession(id, machineId, machineToken, machineType) {
  const { cosyKey, info } = core.newSession(identityJson(id));
  return { cosyKey, info, identity: id, machineId, machineToken, machineType };
}

/** 每次请求都重新构造 payload（requestId 必须新） */
const buildPayloadB64 = (info) => core.buildPayloadB64(info, c.COSY_VERSION);

/**
 * 旧式签名：md5("cosy&<secret>&<date>")。只有 PAT → jobToken 那条路用得到
 * （见 auth.js 的 exchangeJobToken），device flow 不用。
 *
 * **注意 secret 是 base64 字符串本身**（`d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==`），
 * 不是它解码出来的 "war, war never changes"——参考实现就是直接拼这个字面量。
 * 我第一版按「解码后使用」写，签名对不上。
 */
const SIGN_LEGACY_SECRET = 'd2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==';
const signLegacy = (date) => core.md5hex([c.APP_CODE, SIGN_LEGACY_SECRET, date].join('&'));

/**
 * 构造一次请求的全部头。body 是**已 Encode 的字符串**（空 body 传 ''）。
 * pathSig 是去掉 /algo 前缀的 path（见 constants 的 ChatPathSig）。
 * opts.sse：流式对话（infer-sse）为 true——只有这条场景带 machinehostname。
 */
function buildHeaders(sess, pathSig, body, accept, extra, opts = {}) {
  const payloadB64 = buildPayloadB64(sess.info);
  const date = String(Math.floor(Date.now() / 1000));
  const headers = {
    'cosy-data-policy': 'agree',
    'content-type': 'application/json',
    'cosy-machinetype': sess.machineType,
    'cosy-clienttype': c.CLIENT_TYPE,
    'cosy-date': date,
    'cosy-user': sess.identity.uid || '',
    'cosy-key': sess.cosyKey,
    'cache-control': 'no-cache',
    accept,
    authorization: core.composeBearer(
      payloadB64,
      core.signRequest(payloadB64, sess.cosyKey, date, body, pathSig),
    ),
    'cosy-version': c.COSY_VERSION,
    'cosy-machineid': sess.machineId,
    'cosy-machinetoken': sess.machineToken,
    'login-version': c.LOGIN_VERSION,
    'user-agent': USER_AGENT,
    'cosy-scene': 'assistant',
    'cosy-business-product': 'cli',
    'cosy-business-type': 'agent',
  };
  if (OS_HEADERS) {
    headers['cosy-machineos'] = MACHINE_OS;
    if (opts.sse) headers['cosy-machinehostname'] = machineHostname(sess.identity && sess.identity.uid);
  }
  return Object.assign(headers, extra || {});
}

module.exports = {
  // 算法：转发自 src/cosy.js，保持本模块原有的导出面不变
  // （qoder/chat.js、qoder/index.js、qoder/session.js 与三个测试都按这个面调用）
  encode: core.encode,
  encodeAsync: core.encodeAsync,
  aesEncrypt: core.aesEncrypt,
  rsaEncrypt: core.rsaEncrypt,
  md5hex: core.md5hex,
  newUUID: core.newUUID,
  signRequest: core.signRequest,
  composeBearer: core.composeBearer,
  SERVER_PUBKEY_PEM: core.SERVER_PUBKEY_PEM,
  CUSTOM_ALPHABET: core.CUSTOM_ALPHABET,
  // Qoder 特有
  identityJson, newSession, buildPayloadB64, signLegacy, buildHeaders, SIGN_LEGACY_SECRET,
  machineHostname, MACHINE_OS, USER_AGENT,
};
