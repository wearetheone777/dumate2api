// src/traework/constants.js - TRAE Work (SOLO CN) 端点与常量
//
// 逆向自 trae-api-proxy / traework2api 两个开源实现，并交叉验证：
// 两处对 ClientID、Function、端点路径的取值一致，可信度较高。
//
// 与搭子/千问不同，TRAE 的接口分成三个 host，各自有独立的请求头：
//   AgentHost  对话 + 模型列表（SOLO 专有头，14 个）
//   UgHost     签到 + 额度（只需 X-User-Region + X-Device-Id）
//   OAuthHost  换票 + 用户信息（几乎裸请求，仅 UA）
// 混用会失败，所以这里按用途分开定义。
const https = require('https');

// ---- 主机 ----
// AGENT_HOST 是**逻辑主机名**（referer 里的名字）：官方客户端不直连它，TTNet
// 按 TNC 下发的域名表改写成具体后端（api5-normal.mchost.guru 等，见 tnc.js）。
// 它目前可用，但上游换分片时（2026-10-15 国服就换过）会静默失效——运行时以
// tnc.js 的候选链优先，这里只作 TNC 不可用时的兜底。
// 国际版（2026-10-31，hub 证据）：llm_raw_chat 走 core-normal.traeapi.us；
// utils_chat 的国际基址未实测——要接国际版先补国际账号验证。
const AGENT_HOST = 'https://trae-api-cn.mchost.guru';
const AGENT_HOST_INTL = 'https://core-normal.traeapi.us';
const UG_HOST = 'https://api.trae.cn';
const OAUTH_HOST = 'https://api.trae.com.cn';
const CONSOLE_HOST = 'https://www.trae.cn';

// ---- 国际版（2026-11-03 接入，端点证据来自 trae2api-hub 的 PROTOCOL 实测）----
// hub 的 REALMS.intl（trae_client.py / trae_accounts.py）：
//   account（OAuth 换票）→ grow-normal.trae.ai，回落 grow-normal.traeapi.us
//   pay（ent_usage/pay_status）→ grow-normal.traeapi.us 200（api.trae.ai 是 404）
//   ug（签到）→ 国际版实测 404，**签到仅国内版可用**
// 登录页走国际版控制台 www.trae.ai（与国内 www.trae.cn 同一套授权参数）。
const CONSOLE_HOST_INTL = 'https://www.trae.ai';
const ACCOUNT_HOST_INTL = 'https://grow-normal.trae.ai';
const ACCOUNT_HOST_INTL_FALLBACK = 'https://grow-normal.traeapi.us';
const PAY_HOST_INTL = 'https://grow-normal.traeapi.us';
const PAY_HOST_INTL_FALLBACK = 'https://grow-normal.trae.ai';

/** 归一化区域：只有明确 intl 才是国际，其余（含缺省）一律国内。
 *  与 keys.js 的 'cn'|'intl' 术语一致；存量账号没有 region 字段按国内。 */
function normalizeRegion(raw) {
  return String(raw || '').trim().toLowerCase() === 'intl' ? 'intl' : 'cn';
}
/** 账号（或 region 串）的区域 */
function regionOf(x) {
  if (x === 'intl' || x === 'cn') return x;
  return normalizeRegion(x && x.region);
}
/** OAuth/账号域基址：换票、用户信息、登录态查询 */
function oauthHostOf(regionOrAuth) {
  return regionOf(regionOrAuth) === 'intl' ? ACCOUNT_HOST_INTL : OAUTH_HOST;
}
/** 国际版账号域的候选链（连接级失败换下一家；国内单主机不轮转） */
function oauthHostCandidates(regionOrAuth) {
  return regionOf(regionOrAuth) === 'intl'
    ? [ACCOUNT_HOST_INTL, ACCOUNT_HOST_INTL_FALLBACK]
    : [OAUTH_HOST];
}

// ---- 端点 ----
const EP_CHAT = '/api/agent/v3/llm_utils_chat';
const EP_MODELS = '/api/ide/v1/get_detail_param';
const EP_EXCHANGE = '/cloudide/api/v3/trae/oauth/ExchangeToken';
const EP_USER_INFO = '/cloudide/api/v3/trae/GetUserInfo';
// 登录态 + 设备绑定查询（2026-11-01，bluechonk/trae-credential-reverse-engineering
// 端点清单实测）：回 IsLogin / BoundDeviceID / DeviceBindStatus / ExpiredAt 等。
// 9074 的诊断入口——不用打对话/签到就能看到上游认为本账号绑的是哪台设备。
const EP_CHECK_LOGIN = '/cloudide/api/v3/trae/CheckLogin';
const EP_CHECKIN_STATUS = '/trae/api/v2/ug/checkin_credits/status';
const EP_CHECKIN_CLAIM = '/trae/api/v2/ug/checkin_credits/claim';
const EP_ENT_USAGE = '/trae/api/v2/pay/ide_user_ent_usage';
// v1 路径（hub 实测国际版只有 v1 注册：fetch_entitlement 对 intl 走
// PATH_ENT_USAGE_V1 / PATH_PAY_STATUS v1；国内 v2 正常，保持不动）
const EP_ENT_USAGE_V1 = '/trae/api/v1/pay/ide_user_ent_usage';
// 付费状态 / 套餐身份 / 活动资格（2026-10-31 实测）。
//
// **v1 与 v2 都返回 200 且字段不同**——v2 多 `can_purchase_pro_oneweek` 与
// 完整的 `detail`/`enable_solo_*` 能力位，v1 只有前半截。用 v2。
// 这个端点解答了「Free 号为什么额度看着不对」：`user_pay_identity_str` 直接给
// 套餐档位（实测 "Free"），`enable_solo_lite/web/coder/builder` 是能力位，
// `is_support_commercialization=false` 说明该账号不在商业化名单里。
//
// `commercial_activities` 是**活动资格表**（不是签到）：
//   activity_type 102=new_user_credits、105=send_message_reward、
//   101/103=work_lite/work_fission（带 work_extra.eligible/grantable/granted）。
// 实测 send_message_reward 的 work_extra 带 `general_credits: 500` 且
// eligible=true——这是**清单里「活动/邀请积分」那一项的数据源**。
const EP_PAY_STATUS = '/trae/api/v2/pay/ide_user_pay_status';
const EP_PAY_STATUS_V1 = '/trae/api/v1/pay/ide_user_pay_status';
// 逐轮账单（2026-10-31，Trae2api-cn 实测）：body {session_id: <本轮 turn id>}，
// 回 data.user_usage_group_by_session.credits_float。turn id 取自流里的
// reply_to_message_id / user_message_id。这是 TRAE 唯一能拿到「单请求扣了多少」
// 的接口——consumed 前后差值只是推断口径。
const EP_SESSION_USAGE = '/api/v1/commercial/get_session_usage';
// ---- Remote 链路（2026-11-01，Trae2api-cn 的 web remote 客户端同款）----
// BASE 与 utils_chat 同一台网关主机（mchost.guru），路径不同。国际版 remote
// 基址未实测（hub 只证实 raw 链路的 core-normal.traeapi.us），不预编。
// 事件流是标准 SSE（event:/data: 行 + [DONE] 哨兵），与 utils_chat 的
// event:output/done 自定义块不同。
const REMOTE_BASE_CN = 'https://trae-api-cn.mchost.guru/api/remote/v1';
const REMOTE_ORIGIN = 'https://solo.trae.cn';
const REMOTE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
// ---- 活动领取（2026-11-01，traework2api-panel 实测：5 个真号 × 两个 host 交叉验证）----
// 三条链路 + 一张清单，全部在国内 ug 网关（国际域没有 ug 接口）：
//   · info 是活动清单（activity_id / type / Enabled / 起止时间只在这里有）；
//   · type==103 的裂变奖励**必须带 activity_id 单独领**（传 activity_type 一律 4001）；
//   · 其余活动走 action：它是唯一回 work_extra（granted/grantable/prize_text）的接口；
//   · grant_work_benefit 是兜底总入口（服务端按账号可领清单自行发放），覆盖
//     action 不认的那几类——新人/发消息（send_message_reward）/学生认证/桌面下载。
const EP_ACTIVITY_INFO = '/trae/api/v2/ug/activity/info';
const EP_ACTIVITY_ACTION = '/trae/api/v2/ug/activity/action';
const EP_FISSION_GRANT = '/trae/api/v2/ug/work_fission/grant';
const EP_GRANT_BENEFIT = '/trae/api/v2/pay/grant_work_benefit';

// ---- 客户端标识 ----
// 这些值随客户端版本变化。升级 TRAE 后若接口报错，优先核对这几个。
const CLIENT_ID = 'en1oxy7wnw8j9n';           // SOLO stable
const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const IDE_VERSION = '0.1.43';
// **上游按「最低版本门槛」下发模型表**：版本码 >= 门槛就回最新表，且不校验上限
// （实测 20261020 / 20261231 / 20270101 / 20300101 / 20991231 返回的 50 个模型
//  id 集合完全相同，md5 一致）。0.1.43 配的 20260716 低于门槛，只能拿到 42 个旧模型。
//
// 所以这里**用当天日期动态生成**，不抄某个客户端版本号：写死一个值意味着上游
// 每次上新模型都得改代码，管理端的「刷新」按钮也就成了摆设（刷到的还是旧表）。
// 只改这一个头就够——X-Ide-Version / X-App-Version 的字符串不影响下发
// （0.1.43 字符串 + 新码 = 50 个）；X-App-Version-Code 与本值共用，实测无副作用。
// 对话接口同样正常：glm-5.2 / deepseek-v4.1-flash 均 200 且带完整 usage。
//
// 排查时想固定某个版本，用 DUMATE_TRAEWORK_IDE_VERSION_CODE 覆盖。
function todayVersionCode() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}${mm}${dd}`;
}
const IDE_VERSION_CODE = process.env.DUMATE_TRAEWORK_IDE_VERSION_CODE || todayVersionCode();
const DEVICE_BRAND = '83DG';
const OS_VERSION = 'Windows 11 Pro';
// 对话必须带这个 function，否则上游不认（等同千问的 business 字段）
const FUNCTION = 'solo_work_lite';
// TRAE 宝（开发者个人助理）的对话身份（2026-11-03 实测打通）：
// `traebao/` 前缀路由到这里。与 solo_work_lite 同一后端/同一账号，
// 免费豁免（官方 11 月活动）绑定此 function——同一请求实测
// personal_assistant 0 credits、solo_agent_lite 0.05。活动结束后是否
// 延续未知；账本照记，豁免消失会自动体现在 credits 里。
const FUNCTION_ASSISTANT = 'personal_assistant';
// 默认模型：实测可用
const DEFAULT_MODEL = 'glm-5.2';

const USER_AGENT = `Trae/${IDE_VERSION}`;

// ---- 客户端身份（签到/额度接口的设备指纹校验用）----
// 客户端是 VSCode 内核，UA 与 market-client-id 都要跟着装成 VSCode——
// 写 Trae/0.1.43 会被服务端识别为非客户端，签到被拒（实测 9074）。
// 取值对齐 TraeWorkAssistant 的 build_headers。
const UA_VSCODE = 'VSCode 1.107.1 (TRAE SOLO CN)';
const MARKET_CLIENT_ID = 'VSCode 1.107.1';
const APP_VERSION = '0.1.45';

// 超时：对话是长流，必须用无总超时的客户端，否则 SSE 会被截断
const TIMEOUT_MS = 30000;
const STREAM_TIMEOUT_MS = 600000;
// 基址候选轮转的**连接**超时：黑名单主机（DNS 悬空/黑洞）不该占满 600s——
// 到点换下一家候选（tnc.js 的候选链）
const CONNECT_TIMEOUT_MS = Math.max(3000,
  parseInt(process.env.DUMATE_TRAEWORK_CONNECT_TIMEOUT_MS || '10000', 10) || 10000);

/** 统一发 JSON 请求。返回 { status, data, raw, error }。
 *  opts.agent 出站代理（E 包接线）：凭证请求与对话同出口，null = 直连。 */
function request(host, path, { method = 'POST', body = null, headers = {}, timeout = TIMEOUT_MS, agent = null } = {}) {
  return new Promise((resolve) => {
    const u = new URL(host + path);
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      ...(agent ? { agent } : {}),
      headers: {
        ...headers,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout,
    }, (res) => {
      let buf = '';
      // StringDecoder：跨 chunk 的汉字不能逐块解码（会变 U+FFFD）
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      res.on('data', (c) => { buf += dec.write(c); });
      res.on('end', () => {
        buf += dec.end();
        let data = null;
        try { data = JSON.parse(buf); } catch (e) { /* 非 JSON 保留 raw */ }
        resolve({ status: res.statusCode, data, raw: buf, error: null });
      });
    });
    req.on('error', (e) => resolve({ status: 0, data: null, raw: '', error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: null, raw: '', error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = {
  AGENT_HOST, AGENT_HOST_INTL, UG_HOST, OAUTH_HOST, CONSOLE_HOST,
  CONSOLE_HOST_INTL, ACCOUNT_HOST_INTL, ACCOUNT_HOST_INTL_FALLBACK,
  PAY_HOST_INTL, PAY_HOST_INTL_FALLBACK,
  normalizeRegion, regionOf, oauthHostOf, oauthHostCandidates,
  EP_CHAT, EP_MODELS, EP_EXCHANGE, EP_USER_INFO, EP_CHECK_LOGIN,
  EP_CHECKIN_STATUS, EP_CHECKIN_CLAIM, EP_ENT_USAGE, EP_ENT_USAGE_V1,
  EP_SESSION_USAGE, EP_PAY_STATUS, EP_PAY_STATUS_V1,
  EP_ACTIVITY_INFO, EP_ACTIVITY_ACTION, EP_FISSION_GRANT, EP_GRANT_BENEFIT,
  REMOTE_BASE_CN, REMOTE_ORIGIN, REMOTE_UA,
  CLIENT_ID, APP_ID, IDE_VERSION, IDE_VERSION_CODE,
  DEVICE_BRAND, OS_VERSION, FUNCTION, FUNCTION_ASSISTANT, DEFAULT_MODEL,
  USER_AGENT, UA_VSCODE, MARKET_CLIENT_ID, APP_VERSION,
  TIMEOUT_MS, STREAM_TIMEOUT_MS, CONNECT_TIMEOUT_MS,
  request,
};
