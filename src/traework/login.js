// src/traework/login.js - 独立 OAuth 登录（不依赖 TRAE 客户端）
//
// 这是与千问最大的不同：千问只能读客户端加密文件，而 TRAE Work 的
// 凭证是我们自己走 OAuth 换来的 —— 只要浏览器登录一次即可。
//
// 流程（参考 traework2api 的 login.sh，改成纯 Node）：
//   1. 生成 machine_id / device_id（32 位 hex）
//   2. 拼登录 URL（带 127.0.0.1 回调 + 两个设备标识）
//   3. 用户浏览器打开 → 登录 → 复制回调地址
//   4. 解析回调里的 refreshToken → ExchangeToken 换 access token
//   5. 落盘
//
// 为什么设备标识要在登录时就带上：TRAE 按设备限流（同机多账号会互相顶掉），
// 而这两个 id 一旦参与登录就与账号绑定。**登录后不要再改**，
// 否则会被判成换设备，需要重新登录。
const crypto = require('crypto');
const c = require('./constants');
const { oauthHeaders } = require('./headers');
const authStore = require('./auth');

// 回调固定走本机端口，由用户手动把地址粘回来（不做本地 http server：
// 客户端机器不一定允许监听，且手动粘贴更透明、少一个失败点）
const REDIRECT = 'http://127.0.0.1:18080/authorize';

/** 生成一次登录所需的随机标识（device/machine 各 32 hex） */
function newDeviceIds() {
  return { deviceId: authStore.genId(), machineId: authStore.genId() };
}

/**
 * 拼授权 URL。
 *
 * **参数表是逆向出来的，不是标准 OAuth**：用 redirect_uri/scope/state 那套
 * 标准参数会被 Trae 判为非法客户端，页面永远卡在「认证中…」。
 * 必须带 x_device_* / x_app_* 这组前缀参数，且 auth_callback_url 才是回调字段。
 *
 * region（2026-11-03 国际版接入）：国内 www.trae.cn / 国际 www.trae.ai，
 * 两区账号不通用。client_id 与参数集两区一致（hub 的 ExchangeToken 同一
 * LOGIN_CLIENT_ID 打两个区域的 account host）。
 *
 * @param {{deviceId:string, machineId:string}} ids
 * @param {string} [region] 'cn'（缺省）| 'intl'
 */
function buildAuthUrl(ids, region) {
  const consoleHost = c.regionOf(region) === 'intl' ? c.CONSOLE_HOST_INTL : c.CONSOLE_HOST;
  const params = {
    login_version: '1',
    auth_from: 'solo',
    login_channel: 'native_ide',
    plugin_version: '2.3.62834',
    auth_type: 'local',
    client_id: c.CLIENT_ID,
    redirect: '0',
    login_trace_id: crypto.randomBytes(8).toString('hex'),
    auth_callback_url: REDIRECT,
    machine_id: ids.machineId,
    device_id: ids.deviceId,
    x_device_id: ids.deviceId,
    x_machine_id: ids.machineId,
    x_device_brand: 'PC',
    x_device_type: 'PC',
    x_os_version: '1.0',
    x_app_version: c.IDE_VERSION,
    x_app_type: 'stable',
  };
  return `${consoleHost}/authorization?${new URLSearchParams(params).toString()}`;
}

/**
 * 从用户粘贴的回调地址里取 refreshToken 与用户信息。
 * 回调形如 http://127.0.0.1:18080/authorize?refreshToken=xxx&userInfo={...}&userJwt={...}
 *
 * 字段名是逆向出来的：userInfo 里 uid 叫 UserID、昵称叫 ScreenName。
 * refreshToken 缺失时回落到 userJwt.RefreshToken（参考实现也这么做）。
 *
 * **host 参数是回调自带的账号域**（2026-11-03 国际版真机实测发现）：
 * 国际版回调带 `host=https://api-sg-central.trae.ai`（新加坡落点）——换票
 * 必须打这个主机，而不是我们预置的候选链（grow-normal.trae.ai 是 hub 的
 * 美区实测值，落点在 SG 的账号不认）。回调值优先于区域候选。
 */
function parseCallback(text) {
  const s = String(text || '').trim();
  const qIdx = s.indexOf('?');
  const qs = new URLSearchParams(qIdx >= 0 ? s.slice(qIdx + 1) : s);

  const parseJson = (v) => {
    if (!v) return null;
    try { return JSON.parse(decodeURIComponent(v)); } catch (e) { return null; }
  };

  const userInfo = parseJson(qs.get('userInfo')) || {};
  const userJwt = parseJson(qs.get('userJwt')) || {};

  let refreshToken = qs.get('refreshToken') || qs.get('refresh_token') || '';
  if (!refreshToken) refreshToken = String(userJwt.RefreshToken || '');

  return {
    refreshToken,
    uid: String(userInfo.UserID || ''),
    nickname: String(userInfo.ScreenName || ''),
    tenantId: String(userInfo.TenantID || ''),
    // 回调自带的账号域主机（国内回调没有这个参数，取出来是空串）
    host: String(qs.get('host') || '').trim(),
    // 上游给的区域串（实测国际版是 'sg'/'us' 这类落点名）——只作展示，
    // 本地区域字段仍用 cn/intl 两值
    userRegion: String(qs.get('userRegion') || '').trim(),
    // 回调里有时直接带 access token，省一次 ExchangeToken（但我们仍会换，
    // 因为 refreshToken 轮换后必须落盘新的，不能只存回调给的这个）
    jwtToken: String(userJwt.Token || ''),
  };
}

/**
 * 用 refreshToken 换 access token 并落盘。
 * @param {{refreshToken:string, deviceId:string, machineId:string, nickname?:string, uid?:string, apiHost?:string, region?:string}} opts
 */
async function exchangeAndSave(opts) {
  const { refreshToken, deviceId, machineId } = opts || {};
  if (!refreshToken) return { ok: false, error: '缺少 refreshToken' };
  const region = c.normalizeRegion(opts.region);

  // 国际版带候选回落：连接级失败换下一家；拿到响应（含 4xx）就交上层处置。
  // 主机优先级：回调自带的 host（账号落点，实测 api-sg-central.trae.ai）>
  // 显式 apiHost > 区域候选链
  const hosts = opts.host ? [opts.host]
    : opts.apiHost ? [opts.apiHost]
      : c.oauthHostCandidates(region);
  // body 形状是逆向出来的：ClientSecret 必须是 "-"，UserID 空串
  const body = {
    ClientID: c.CLIENT_ID,
    RefreshToken: refreshToken,
    ClientSecret: '-',
    UserID: '',
  };
  // 出站代理（E 包收口补点）：换票时还没有账号，走全局默认代理。
  // 配置非法按换票失败返回，不回退直连。
  let agent;
  try { agent = require('../proxy-agent').getAgentFor(null); } catch (e) {
    return { ok: false, error: e.message };
  }
  let r = null;
  for (const host of hosts) {
    r = await c.request(host, c.EP_EXCHANGE, {
      method: 'POST', body, headers: oauthHeaders(), agent,
    });
    if (r.status === 200 && r.data) { r.__host = host; break; }
    if (r.status !== 0) break;   // HTTP 层有响应，主机没问题
  }
  if (!r || r.status !== 200 || !r.data) {
    return { ok: false, error: `换票失败 HTTP ${r ? r.status : 0} ${String((r && r.raw) || '').slice(0, 160)}` };
  }
  const host = r.__host || hosts[0];
  const res = (r.data && r.data.Result) || r.data || {};
  const accessToken = res.Token || res.token;
  if (!accessToken) return { ok: false, error: '换票响应里没有 Token' };

  const expiresAt = authStore.jwtExp(accessToken) || (res.ExpiresAt ? Number(res.ExpiresAt) : null);
  const newRefresh = res.RefreshToken || refreshToken;

  const rec = {
    accessToken,
    refreshToken: newRefresh,
    expiresAt,
    refreshExpiresAt: res.RefreshExpireAt ? Number(res.RefreshExpireAt) : null,
    deviceId,
    machineId,
    apiHost: host,
    // 区域随登录落盘（2026-11-03 国际版）：换票、对话基址、额度查询都按它分流
    region,
    // 回调里已经带了 uid / 昵称，直接落盘（GetUserInfo 只作补充）
    uid: opts.uid || '',
    nickname: opts.nickname || '',
    lastError: '',
  };

  // 补用户信息。**不只是「uid 缺失时兜底」**（2026-10-29 修）：
  //
  // 早先这段只在 `!rec.uid` 时才跑，且昵称用 `rec.nickname || u.nickname`
  // （回调带了就绝不覆盖）。后果是**用户在 TRAE 平台改了昵称，重登后页面
  // 还是旧的**——回调里的 ScreenName 可能是注册时的默认名 `用户<手机号>`，
  // 而 GetUserInfo 才是当前值；两者不一致时永远取前者。
  //
  // 现在的口径：**上游实时值优先**，回调值只作兜底。
  // `upsert` 是 `{...旧, ...新}`，所以**绝不能把空串写进去**——那会抹掉已有
  // 昵称（重登时回调不带昵称就会这样）。故只在取到非空值时才写入字段。
  try {
    const u = await authStore.fetchUserInfo({ accessToken, apiHost: host });
    if (u) {
      if (u.uid) rec.uid = u.uid;
      if (u.nickname) rec.nickname = u.nickname;
      if (u.email) rec.email = u.email;
    }
  } catch (e) { /* 忽略：取不到就用回调值 */ }

  // uid 是 `upsert` 的匹配键。**缺了它会新建一条重复账号**（`findIndex` 按
  // uid/id 匹配，两者都没有就落到「新增」分支），用户的账号池里就会凭空多出
  // 一个同名同号的新条目。
  //
  // 兜底：access token 是 JWT，`data.id` 就是 uid（实测与回调的 UserID 一致）。
  // 这比 `fetchUserInfo` 可靠——后者需要登录会话票据，我们只存 access token，
  // 实测恒回 401/20310。
  if (!rec.uid) rec.uid = authStore.jwtUid(accessToken);

  // 空昵称/邮箱不要写进记录：`upsert` 会把它盖到旧值上
  if (!rec.nickname) delete rec.nickname;
  if (!rec.email) delete rec.email;

  const saved = authStore.upsert(rec);
  return { ok: true, account: authStore.list().find((a) => a.id === saved.id) };
}

module.exports = { REDIRECT, newDeviceIds, buildAuthUrl, parseCallback, exchangeAndSave };
