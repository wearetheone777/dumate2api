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
 * @param {{trace?:string, redirect?:string}} [opts]
 *   trace：回环登录时由 `oauth-callback.js` 生成的 state（**必须与回调校验用同一个**）；
 *          不传就现造一个（手贴回调的老路径行为不变）。
 *   redirect：回环监听的端口可能被 `DUMATE_TRAEWORK_LOGIN_PORT` 改过，
 *            `auth_callback_url` 必须跟着改，否则授权页会跳到没人监听的地址。
 */
function buildAuthUrl(ids, region, opts = {}) {
  const consoleHost = c.regionOf(region) === 'intl' ? c.CONSOLE_HOST_INTL : c.CONSOLE_HOST;
  const params = {
    login_version: '1',
    auth_from: 'solo',
    login_channel: 'native_ide',
    plugin_version: '2.3.62834',
    auth_type: 'local',
    client_id: c.CLIENT_ID,
    redirect: '0',
    login_trace_id: String((opts && opts.trace) || crypto.randomBytes(8).toString('hex')),
    auth_callback_url: String((opts && opts.redirect) || REDIRECT),
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

  // **先按原样解析，再退回去 decode**：真机上粘回来的回调有两种形态——
  // 有的客户端把 userInfo 百分号编码，有的（实测小米平板/国内版）原样带花括号。
  // 反过来做（先 decodeURIComponent）在第二种形态上直接抛错，被 catch 吞掉后
  // uid/nickname/tenant 全是空串——账号照样能落盘，但显示名丢了，界面上会出现
  // 「未命名账号」，而错误原因是静默的。
  const parseJson = (v) => {
    if (!v) return null;
    // 尾部多一个逗号是**真机上遇到过的**：粘回来的 `userJwt={...},&userInfo={...}`
    // 里那个 `,` 落在值内，JSON.parse 直接失败 → uid/昵称/租户全空（账号仍能落盘，
    // 但界面上是「未命名账号」，而失败原因静默）。所以先削尾逗号再解析。
    const attempt = (raw) => {
      try { return JSON.parse(raw); } catch (e) { /* 继续试 */ }
      try { return JSON.parse(String(raw).replace(/,\s*$/, '')); } catch (e) { return null; }
    };
    return attempt(v) || attempt(decodeURIComponent(v));
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
    // `userJwt.RefreshToken` 是**另一个候选**：2026-11-17 实测里，回调顶层
    // `refreshToken` 与 JWT 里那个是两串不同的值（JWT 的 source_id 指向后者）。
    // 谁才是换票认的那个必须实测——解析层两个都交给调用方，别在这里猜。
    jwtRefreshToken: String(userJwt.RefreshToken || ''),
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

// ==================== 授权码 + PKCE（调研 P0-2b）====================
//
// 现有登录走 `auth_type=local`，回调直接给 `refreshToken`——**已经真机验证可用**
// （2026-11-17 实测，见 CHANNEL-TRAEWORK.md）。另一条路是官方新版客户端
// （INTL 1.107.1）的授权码 + PKCE：URL 多一个 `code_challenge`(S256)，
// 回调回 `authCodeInfo.AuthCode`，换票用 `/trae/api/v3/oauth/ExchangeToken`
// 且 body 是 `{ClientID, AuthCode, CodeVerifier, DeviceInfo, IDEVersion}`。
//
// **CN 上这套是否成立仍是未知的**（调研文档明确写着「未用真实账号完成官方授权」）：
//   - CN 授权页会不会接受 `code_challenge`（忽略它照样回 refreshToken？）
//   - CN 的授权码换票路径是 `/trae/...` 还是 `/cloudide/api/v3/trae/oauth/ExchangeToken`
// 两个问题都要一次真实登录才能回答，所以这里**只实现无争议的部分**（PKCE 计算、
// URL 拼装、回调解析），换票发请求留给验证脚本——**不在产品路径里猜端点**。
// 猜错的代价是把一个能用的登录流程改坏，而不是多一个用不了的功能。

/**
 * PKCE 一对（RFC 7636）：verifier 43 字符 base64url，challenge = base64url(sha256(verifier))。
 * verifier **只留在本地**，回调里不该出现它。
 */
function newPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * 在既有授权 URL 上追加 PKCE 参数（其余参数一个不动——它们是逆向出来的，
 * 少一个就会被判非法客户端、页面卡在「认证中…」）。
 * @param {{deviceId:string, machineId:string}} ids
 * @param {string} [region]
 * @param {{challenge:string, trace?:string, redirect?:string}} opts challenge 必填
 */
function buildAuthCodeUrl(ids, region, opts = {}) {
  const base = buildAuthUrl(ids, region, opts);
  if (!opts || !opts.challenge) return base;
  const u = new URL(base);
  u.searchParams.set('code_challenge', String(opts.challenge));
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

/**
 * 从授权码回调里取 `AuthCode`。
 *
 * 回调形状（INTL 1.107.1 静态证据）：`...&authCodeInfo={"AuthCode":"..."}`。
 * 与 `userInfo` 一样**两种编码都容忍**（原样 JSON / 百分号编码 / 值尾多逗号），
 * 理由见 `parseCallback` 里那段注释——同一个页面两种编码都出现过。
 * 取不到返回空串（调用方据此判断「这次登录不是授权码流程」）。
 */
function parseAuthCodeCallback(text) {
  const s = String(text || '').trim();
  const qIdx = s.indexOf('?');
  let qs;
  try { qs = new URLSearchParams(qIdx >= 0 ? s.slice(qIdx + 1) : s); } catch (e) { return ''; }
  const parse = (v) => {
    if (!v) return null;
    const attempt = (raw) => {
      try { return JSON.parse(raw); } catch (e) { /* 继续 */ }
      try { return JSON.parse(String(raw).replace(/,\s*$/, '')); } catch (e) { return null; }
    };
    return attempt(v) || attempt(decodeURIComponent(v));
  };
  const info = parse(qs.get('authCodeInfo')) || {};
  return String(info.AuthCode || info.authCode || qs.get('AuthCode') || qs.get('authCode') || qs.get('code') || '').trim();
}

/**
 * 回环回调地址（与 oauth-callback.js 的监听端口必须一致）。
 * 默认 18080 = REDIRECT 的历史值（2026-11-03 真机验证过的那条 URL）。
 */
function redirectFor(port) {
  const n = Number(port);
  return n > 0 ? `http://127.0.0.1:${n}/authorize` : REDIRECT;
}

module.exports = {
  REDIRECT, redirectFor, newDeviceIds, buildAuthUrl, parseCallback, exchangeAndSave,
  // P0-2b（授权码 + PKCE）：只做无争议的纯计算，见上方注释
  newPkce, buildAuthCodeUrl, parseAuthCodeCallback,
};
