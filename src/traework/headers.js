// src/traework/headers.js - 三套请求头
//
// TRAE 的三个 host 各有各的头，混用会失败（实测开源实现里也是分开写的）：
//   soloHeaders  对话 / 模型列表 —— 14 个头，最复杂
//   ugHeaders    签到 / 额度     —— 设备指纹敏感，头最多（19 个）
//   OAuthHeaders 换票 / 用户信息 —— 几乎裸请求
//
// 关键：**token 走 Cloud-IDE-JWT 前缀**，且对话路径要同时带
// X-Cloudide-Token 与 X-Ide-Token 两个头（上游两个都读）。
//
// 2026-09-25 修正（ugHeaders）：签到恒定返回 9074，根因是**设备指纹**。
// 对照 smart-open/TraeWorkAssistant 的实现后重写了 ugHeaders：
//   - deviceId 必须是 **15 位数字**（从 uid 派生），不是随机 hex
//   - 还要带 sessionId / marketUserId，以及 package-type、x-lgw-req-sdk-type
//     这类客户端身份头
//   - User-Agent 要装成 VSCode（客户端本身就是 VSCode 内核）
// 参考实现实测能签到成功，所以这套头是有效的。
const crypto = require('crypto');
const c = require('./constants');

/** 对话 / 模型列表。auth 需含 accessToken / uid / machineId / deviceId */
function soloHeaders(auth, stream = false) {
  const at = (auth && auth.accessToken) || '';
  const h = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': c.USER_AGENT,
    Authorization: `Cloud-IDE-JWT ${at}`,
    // 两个都要带：上游对这两条路径的取值不完全一致，缺一个可能 401
    'X-Cloudide-Token': at,
    'X-Ide-Token': at,
    'X-App-Id': c.APP_ID,
    'X-App-Version': 'default',
    'X-Ide-Version': c.IDE_VERSION,
    'X-Ide-Version-Code': c.IDE_VERSION_CODE,
    'X-App-Version-Code': c.IDE_VERSION_CODE,
    'X-Ide-Version-Type': 'stable',
    'X-Device-Type': 'windows',
    'X-OS-Version': c.OS_VERSION,
    'X-Device-Brand': c.DEVICE_BRAND,
    'Request-Traffic-Type': 'prod',
  };
  if (auth && auth.uid) h['X-Uid'] = auth.uid;
  if (auth && auth.machineId) h['X-Machine-Id'] = auth.machineId;
  if (auth && auth.deviceId) h['X-Device-Id'] = auth.deviceId;
  return h;
}

/**
 * 签到 / 额度（国内 api.trae.cn；国际 grow-normal.traeapi.us）。
 *
 * **设备指纹敏感**：这三个接口会校验「设备标识是否与该账号匹配」，
 * 所以 deviceId / sessionId / marketUserId 必须是从 uid 派生的那一组
 * （见 device.js），不能用随机值。
 *
 * 头的集合对齐 TraeWorkAssistant 的 build_headers（实测有效）。
 * auth 需含 accessToken / deviceId / sessionId / marketUserId。
 *
 * 区域差异（2026-11-03 国际版接入，取值对齐 hub REALMS + tnc.js 的 aid 分区）：
 * 国际版 X-User-Region=US、Package-Type 不带 _cn 后缀、aid 用国际应用号。
 */
function ugHeaders(auth) {
  const at = (auth && auth.accessToken) || '';
  const intl = c.regionOf(auth) === 'intl';
  const authVal = at.startsWith('Cloud-IDE-JWT ') ? at : `Cloud-IDE-JWT ${at}`;
  return {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'Accept-Language': 'zh-CN',
    Authorization: authVal,
    // 客户端是 VSCode 内核，UA 要跟着装；写 Trae/0.1.43 会被识别为非客户端
    'User-Agent': c.UA_VSCODE,
    'X-Market-Client-Id': c.MARKET_CLIENT_ID,
    'X-Market-User-Id': (auth && auth.marketUserId) || '',
    'X-User-Region': intl ? 'US' : 'CN',
    'X-Device-Id': (auth && auth.deviceId) || '',
    'X-Lgw-Req-Sdk-Type': '3',
    'Package-Type': intl ? 'stable' : 'stable_cn',
    'X-Request-Id': crypto.randomBytes(16).toString('hex'),
    'X-Lscbd-Aid': intl ? '677332' : '787976',
    'X-Lscbd-Platform': 'windows',
    'App-Version': c.APP_VERSION,
    'X-Tt-Trace-Id': `00-${crypto.randomBytes(8).toString('hex')}-01`,
    'Vscode-Sessionid': (auth && auth.sessionId) || '',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'none',
  };
}

/** 换票 / 用户信息（OAuth host）。注意：这里不带 Authorization */
function oauthHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': c.USER_AGENT,
  };
}

module.exports = { soloHeaders, ugHeaders, oauthHeaders };
