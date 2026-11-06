// src/qwenwork/constants.js - 千问办公数据面常量
//
// 全部实测自本机千问办公 1.1.0-26091701（2026-09-23 直连 gateway.qwenwork.cn
// 验证通过）。这些值随官方客户端版本变化，写在这里而不是散在代码里，
// 便于版本升级时一处改完。
//
// 已知的版本敏感项：
//   - COSY_VERSION 来自 qoderclicn 二进制（1.1.0 桌面端实测 1.1.52）
//   - CHAT_QUERY 必须带 Encode=1（1.1.0 起要求，缺了会 400）
//   - 请求体必须带 business 对象，否则无论签名是否正确都 503
//     "Model catalog unavailable"
const CHANNEL_ID = 'qwenwork';
const DISPLAY_NAME = '千问办公 / QwenWork';

const GATEWAY = 'https://gateway.qwenwork.cn';
const CHAT_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation';
const CHAT_QUERY = 'FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';
const REFRESH_PATH = '/api/v1/deviceToken/refresh';
const MODELS_PATH = '/api/v2/model/list';
// ---- 工具类端点（2026-10-31 解包 1.4.0 客户端确认）----
//
// 两者都走 COSY 签名（`withWasmSigning()` = 我们已实现的 Encode=1 那套），
// 且与对话链路**独立**：请求体是 `{payload: JSON.stringify(...), encodeVersion:"1"}`，
// 不是 chat_context 形状。
//
// 国际版把 webSearch 换成 `/api/v1/webSearch/unifiedSearch`（客户端按
// `LINGMA_ENV` / `LINGMACLI_INTEGRATION_MODE` 切换，见 RNl()）。我们只接了
// CN（当前账号是 CN），国际版等有账号再补——**不预编一条没验证过的路径**。
const WEB_SEARCH_PATH = '/algo/api/v1/webSearch/oneSearch';
const IMAGE_SEARCH_PATH = '/algo/api/v2/service/pro/imageSearch';
// 探活端点（客户端 `pingEndpoint` 用的就是它）。**实测真机回 `pong`**，
// 且**带不带 COSY 签名都能通**（裸 Bearer 也 200）——所以它是判断
// 「网关侧网络可达 + 凭证未被整体拒绝」的最轻量探针，不消耗额度。
const PING_PATH = '/algo/api/v1/ping';
// 两个搜索端点的 query 串。imageSearch 的 `Encode=1` 是客户端明写的
// （`.query({Encode:"1"})`），webSearch 的取自 CNl="Encode=1"。
const SEARCH_QUERY = 'Encode=1';
// 账号信息。登录/换票后取 uid 用——wasm 签名必需（prepareInfer 的 uid 参数）
const ACCOUNT_CONTEXT_PATH = '/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing';
// 真实手机号在 c_site_user 里（account-context 只有 phone_<uid>@phone.local 占位邮箱）
const IDENTITIES_PATH = '/api/v1/adapter/auth/identities';

// ---- device flow 登录（逆向自客户端 startDeviceFlow / pollDeviceToken）----
// 授权页在 gateway 上，它 302 到 qwenwork.cn 的标准 OAuth 授权端点；
// 取票轮询也在 gateway 上，且**不需要 Authorization**——持有 nonce+verifier 即可。
// 所以这套流程可以完全脱离桌面客户端跑。
const DEVICE_SELECT_PATH = '/device/selectAccounts';
const DEVICE_POLL_PATH = '/api/v1/deviceToken/poll';
const OAUTH_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb'; // QWENWORK_CN_CLIENT_ID
const OAUTH_REDIRECT_URI = 'qwenwork-cn://';
/** 客户端的轮询窗口也是 5 分钟，超时后 nonce 就废了 */
const DEVICE_FLOW_TIMEOUT_MS = 300000;
const DEVICE_POLL_INTERVAL_MS = 1000;

// 客户端身份：必须与请求头声明的一致。用 CLI 的 cli/5/assistant 三元组
// 会让 body 与 header 自相矛盾，服务端直接拒。
//
// **2026-10-31 对齐官方 1.4.0 客户端解包值**（见
// docs/QWENWORK-CLIENT-1.4.0-ANALYSIS.md §1）：worker runtime 是 1.1.71
// （runtime-info.json 的 version，也是 `cosy-version` 头的实际取值，obf 代码里
// 写作 `ZLe = UH || "1.1.71"`）；应用版本 1.4.0。旧的 1.1.52 / 1.1.0 是
// 1.1.0-26091701 那一代，**当时仍能出流**，但上游做版本门时第一个卡的就是它。
//
// 可覆盖（`DUMATE_QWENWORK_COSY_VERSION` / `_IDE_VERSION` / `_RELEASE_VERSION` /
// `_BUILD`）：上游再换版本时不用改代码，也便于对照实验。
const IDE_VERSION = process.env.DUMATE_QWENWORK_IDE_VERSION || '1.4.0';
// release 与 build 是**成对**的：`X-QwenWork-Build` 由 release 里 `-` 之后那段
// 派生（`getBuildNumberFromUpgradeVersion`），所以两者不能各写一个值。
// 实际值取自解包后 `package.json` 的 `qoderworkUpgradeVersion`。
const RELEASE_VERSION = process.env.DUMATE_QWENWORK_RELEASE_VERSION || '1.4.0-26102705';
const BUILD = process.env.DUMATE_QWENWORK_BUILD || '26102705';
const COSY_VERSION = process.env.DUMATE_QWENWORK_COSY_VERSION || '1.1.71';
const CLIENT_TYPE = '6';
const BUSINESS_PRODUCT = 'qoder_work';
const BUSINESS_TYPE = 'agent';
const SCENE = 'qwork';
const MACHINE_OS = 'x86_64_win32';
const LOGIN_VERSION = 'v2';
const USER_AGENT = 'qoderwork/1.1.0';

// ---- ACP 会话通道（2026-11-04，P2-17 前置解锁）----
// 协议证据：tang-bugu/dsh-connect-qwenwork 的实测 README（2026-10-22 真机
// 跑通、10-29 补 32KB 上限）——REST 建会话 + 带信封的 JSON-RPC over WS。
// **域是 qwenwork.cn 裸域，不是 gateway.qwenwork.cn**（README 字面）。
// 单条消息 32768 字节硬上限：1009 关闭、reason "read limited at 32769 bytes"，
// permessage-deflate 压缩救不了——发送前必须裁剪（acp.promptOf）。
const ACP_ORIGIN = process.env.DUMATE_QWENWORK_ACP_ORIGIN || 'https://qwenwork.cn';
const ACP_SESSIONS_PATH = '/api/chat-sessions';
const ACP_WS_PATH = '/api/chat-ws';
const ACP_MAX_PROMPT_BYTES = 32768;

// 模型目录会随服务端变化。**2026-10-31 真机复核**（/api/v2/model/list，修复了
// 签名路径 bug 后首次拉通）：上游当前只有 flash（标准）/ pro（高级）/
// qwen3.8-max-preview（Qwen3.8-Max，千问最强）三个，Buddy2api 等社区项目
// 提到的 qwork-auto/advanced/ultimate 在当前上游**不存在**。此表只作兜底，
// 实际以 /api/v2/model/list 为准。
const FALLBACK_MODELS = ['pro', 'flash', 'qwen3.8-max-preview'];
const DEFAULT_MODEL = 'pro';
const MODEL_ALIASES = { auto: 'pro', 'qwork-advanced': 'pro', 'qwork-auto': 'pro' };

module.exports = {
  CHANNEL_ID,
  DISPLAY_NAME,
  GATEWAY,
  CHAT_PATH,
  CHAT_QUERY,
  REFRESH_PATH,
  MODELS_PATH,
  WEB_SEARCH_PATH,
  IMAGE_SEARCH_PATH,
  PING_PATH,
  SEARCH_QUERY,
  ACCOUNT_CONTEXT_PATH,
  IDENTITIES_PATH,
  DEVICE_SELECT_PATH,
  DEVICE_POLL_PATH,
  OAUTH_CLIENT_ID,
  OAUTH_REDIRECT_URI,
  DEVICE_FLOW_TIMEOUT_MS,
  DEVICE_POLL_INTERVAL_MS,
  IDE_VERSION,
  RELEASE_VERSION,
  BUILD,
  COSY_VERSION,
  CLIENT_TYPE,
  BUSINESS_PRODUCT,
  BUSINESS_TYPE,
  SCENE,
  MACHINE_OS,
  LOGIN_VERSION,
  USER_AGENT,
  ACP_ORIGIN,
  ACP_SESSIONS_PATH,
  ACP_WS_PATH,
  ACP_MAX_PROMPT_BYTES,
  FALLBACK_MODELS,
  DEFAULT_MODEL,
  MODEL_ALIASES,
};
