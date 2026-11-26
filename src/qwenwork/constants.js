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
// cosy-machineos：官方形态 {arch}_{platform}。按本机平台生成（macOS / Linux
// 上跑千问通道时不再伪装 Windows），可覆盖 `DUMATE_QWENWORK_MACHINE_OS`
// （与 Qoder 的 DUMATE_QODER_MACHINE_OS 同形）。架构统一取 x86_64——上游
// 只认这个形态，arm64 机器同样发 x86_64_darwin，不自作主张换 arch。
const MACHINE_OS = process.env.DUMATE_QWENWORK_MACHINE_OS
  || (process.platform === 'win32' ? 'x86_64_win32'
    : process.platform === 'darwin' ? 'x86_64_darwin'
    : 'x86_64_linux');
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

// 模型目录会随服务端变化。**2026-11-26 合并 GitHub 调研**（jianhx189/qwenwork2api
// 的 2026-11 实测修正 + 本项目真机复核）：上游档位键已远不止三个。
//
// **纪律（改之前先读）**：
//   1. 被套餐挡的键**不写进任何表**——`standard` / `premium` / `qwork-lite` /
//      `qmodel_latest` / `dmodel_latest` / `gmodel_latest` 在无权限账号上吃
//      403 `Model is not available for this user`。写进去等于让客户端撞墙。
// FALLBACK_MODELS 只收**本项目或社区实测可用**的键，作动态拉取失败的兜底。
// 2026-11-27 真机复核：上游目录 14 档全部可用，另有 lite/flagship 两个隐藏档
// （目录不返但实测 200）——全部入表，断网/上游临时故障时 /v1/models 不缺档。
// 第三方档位（kimi/minimax/step/qwen4）此前"没在本项目实测过"的纪律已由本轮
// 真机逐档验证解除。仍不收被套餐挡的键（standard/premium/qwork-lite/...）。
// **测试纪律（2026-11-27 用户定案）**：第三方档位不能用积分测——之前逐档测试
// 消耗的是真实额度。minimax3.1flash（上游键 minimax-m3.1-flash，缓存里显示名
// MiniMax-M3.1-flash）为免费模型，后续测试只用这一档。
const FALLBACK_MODELS = [
  'pro', 'flash', 'qwen3.8-max-preview',
  'lite', 'flagship',
  'deepseek-flash', 'deepseek-v4-pro', 'glm-5.3', 'glm-5.3-flash',
  // 2026-11-27 新增（上游目录 14 档中缺的 6 个，全部真机 200）
  'qwen4-max', 'qwen3.8-flash', 'glm-5.4', 'ling-3.1-flash',
  'kimi-k3.1-pro', 'minimax-m3.1-flash', 'step-5-preview',
];
const DEFAULT_MODEL = 'pro';
// 思考模式开关（2026-11-27 融合 P1-1，见 docs/PLAN-QWENWORK-GITHUB-MERGE.md §6.1）。
// 默认开启（与 icebears111/qoderwork2api 的实测结论一致）；设
// DUMATE_QWENWORK_REASONING=0 关闭。**默认值经真机对照后定**（见方案 §10 P1-1）。
// 注意：搭子对 reasoning_effort 不敏感是**搭子**的结论，千问通道按社区实测透传。
const REASONING_ON = process.env.DUMATE_QWENWORK_REASONING !== '0';
// 协议映射（2026-11-27 融合 G3，见 docs/PLAN-QWENWORK-GITHUB-MERGE-ROUND2.md §G3）。
// 依据 zhangzhangco/qwenwork-openai-gateway 的 MECHANISM.md 直连实测：模型目录项带
// provider 字段，anthropic provider 走 /v1/messages、openai 走 /v1/responses、
// 其它走 /v1/chat/completions。**MiniMax 挂在 anthropic provider 下**——协议走
// Anthropic Messages，模型是 MiniMax（此前未知的协议路由）。
const PROTOCOL_BY_PROVIDER = {
  anthropic: 'messages',
  openai: 'responses',
};
const PROTOCOL_DEFAULT = 'chat';
// 对外名 → 上游档位键。映射方向与 chat.js 的 resolveModelKey 一致：
// 表里有就用映射，没有就原样透传（上游键本身也是合法请求名）。
const MODEL_ALIASES = {
  // ---- 原有（保留）----
  auto: 'pro',
  'qwork-advanced': 'pro',
  'qwork-auto': 'pro',
  // ---- 2026-11 社区实测补全（jianhx189/qwenwork2api，2026-11-18 客户端枚举）----
  'qwen3.8-max': 'qwen3.8-max-preview',   // qmodel_latest 被套餐挡，用能跑的预览档承接
  'qwen3.8max': 'qwork-advanced',         // 兼容旧调用（实测 200）
  'qwen3.8': 'qwork-advanced',
  'qwen3.6-plus': 'q35model_preview',     // 套餐不含时上游回 403，显式请求才透传
  'deepseek-v4.1-flash': 'deepseek-flash', // 中转站侧通用名（fast-router/WB 一致）
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-flash': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'glm-5.3': 'glm-5.3',
  'glm-5.3-flash': 'glm-5.3-flash',
  'kimi-k3.1-pro': 'kimi-k3.1-pro',
  'minimax-m3.1-flash': 'minimax-m3.1-flash',
  'step-5-preview': 'step-5-preview',
  'qwen4-max': 'qwen4-max',              // 上游没有 qwen4-max-preview 键，落到 qwen4-max
  'qwen4-max-preview': 'qwen4-max',
  // ---- 2026-11-27 第二轮融合 G2：MaaS 清单新档位（zhangzhangco/qwenwork-openai-gateway
  // 2026-11-26 直连实测 15/15）。**第三方档位未在本项目应用链路实测过，只进别名
  // （显式请求才透传），不进 FALLBACK_MODELS、不进 /v1/models**——与第一轮纪律一致。
  'qwen3.8-flash': 'qwen3.8-flash',
  'glm-5.4': 'glm-5.4',
  'ling-3.1-flash': 'ling-3.1-flash',
  'qwenwork-lite': 'lite',               // 经济
  'qwenwork-standard': 'flash',          // 标准 = flash（`standard` 键被挡）
  'qwenwork-advanced': 'pro',            // 高级
  'qwenwork-ultimate': 'flagship',       // 旗舰
  // 企业专属档位（上游键 safety）**刻意不映射**：企业版内容不合并
};

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
  REASONING_ON,
  PROTOCOL_BY_PROVIDER,
  PROTOCOL_DEFAULT,
};
