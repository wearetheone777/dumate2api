// src/qoder/constants.js - Qoder 数据面常量
//
// Qoder 是阿里的 AI IDE（qoder.com / qoder.com.cn），与千问办公**同一套
// COSY 协议栈**（同样的 Encode=1 自定义 base64、同样的 Bearer COSY.<payload>.<sig>
// 信封、同样的 device flow 登录、连 client_id 都相同）。
//
// **关键差异**：千问的请求体必须由官方 wasm 生成，Qoder 的签名是**纯本地算法**
// （RSA + AES + MD5，公钥硬编码，见 cosy.js）——所以这条通道**不需要客户端、
// 不需要 wasm**，比千问干净。
//
// 双区域：CN（qoder.com.cn / openapi.qoder.com.cn）与 Global（qoder.com /
// openapi.qoder.sh）。两者端点不同、账号不通用，各自独立。
const CHANNEL_ID = 'qoder';
const DISPLAY_NAME = 'Qoder';

// ---- 协议常量（实测自 Qoder 客户端 2026-10-02）----
/** 自定义 base64 的 cosy 版本，写进 payload 与请求头。
 *  官方 CLI 2026-10 实测已到 1.1.75（qoder2api-hub 逆向同值）；我们原用桌面端
 *  的 1.0.10。上游对过低版本会回 430（版本门），所以默认对齐官方 CLI 当前值，
 *  `DUMATE_QODER_COSY_VERSION` 可覆盖（上游行为变化时不用改代码）。 */
const COSY_VERSION = (process.env.DUMATE_QODER_COSY_VERSION || '1.1.75').trim() || '1.1.75';
/** 签名算法标识（SignLegacy 用） */
const APP_CODE = 'cosy';
/** 桌面客户端的 client_id。与千问办公**完全相同**——同一平台的两个产品 */
const OAUTH_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb';
/** 客户端类型：桌面端 5，签到类接口要 10 */
const CLIENT_TYPE = '5';
const CHECKIN_CLIENT_TYPE = '10';
const LOGIN_VERSION = 'v2';

// ---- 区域端点 ----
// 每个区域一整套。缺省 global（与参考实现一致：空值/未知视为 global）。
const ENDPOINTS = {
  cn: {
    DeviceLoginBase: 'https://qoder.com.cn/device/selectAccounts',
    PollEndpoint: 'https://openapi.qoder.com.cn/api/v1/deviceToken/poll',
    RefreshEndpoint: 'https://openapi.qoder.com.cn/api/v1/deviceToken/refresh',
    UserinfoBase: 'https://openapi.qoder.com.cn/api/v1/userinfo',
    PlanEndpoint: 'https://openapi.qoder.com.cn/api/v2/user/plan',
    QuotaEndpoint: 'https://openapi.qoder.com.cn/api/v2/quota/usage',
    CampaignsBase: 'https://openapi.qoder.com.cn/sash/api/v1/me/campaigns',
    ChatStreamURL: 'https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1',
    ModelListURL: 'https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1',
    JobTokenURL: 'https://gateway.qoder.com.cn/algo/api/v3/user/jobToken?Encode=1',
    // 参与签名的 path（去掉 /algo 前缀）。聊天与模型列表都用它。
    ChatPathSig: '/api/v2/service/pro/sse/agent_chat_generation',
    ModelsPathSig: '/api/v2/model/list',
  },
  global: {
    DeviceLoginBase: 'https://qoder.com/device/selectAccounts',
    PollEndpoint: 'https://openapi.qoder.sh/api/v1/deviceToken/poll',
    RefreshEndpoint: 'https://openapi.qoder.sh/api/v1/deviceToken/refresh',
    UserinfoBase: 'https://openapi.qoder.sh/api/v1/userinfo',
    PlanEndpoint: 'https://openapi.qoder.sh/api/v2/user/plan',
    QuotaEndpoint: 'https://openapi.qoder.sh/api/v2/quota/usage',
    CampaignsBase: 'https://openapi.qoder.sh/sash/api/v1/me/campaigns',
    // 主力推理主机。官方 0.4.8 客户端 endpoint 缓存实测（qoder2api-hub 逆向）：
    // inference=api3、securityInference=api2；api1 是旧配置首位，常年直连超时。
    ChatStreamURL: 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1',
    ModelListURL: 'https://api2.qoder.sh/algo/api/v2/model/list?Encode=1',
    JobTokenURL: 'https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1',
    ChatPathSig: '/api/v2/service/pro/sse/agent_chat_generation',
    ModelsPathSig: '/api/v2/model/list',
  },
};

// 国际版推理主机候选链（连接层失败时依次切换，与官方客户端候选顺序一致）。
// `DUMATE_QODER_INTL_GATEWAY` 可钉死单主机（官方客户端支持服务端「选举」覆盖
// 端点，被上游导流到别处时用它）。
const CHAT_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';
const INTL_GATEWAY_PIN = (process.env.DUMATE_QODER_INTL_GATEWAY || '').trim();
const INTL_CHAT_CANDIDATES = INTL_GATEWAY_PIN
  ? [INTL_GATEWAY_PIN.replace(/\/+$/, '') + CHAT_PATH]
  : ['https://api3.qoder.sh' + CHAT_PATH, 'https://api2.qoder.sh' + CHAT_PATH, 'https://api1.qoder.sh' + CHAT_PATH];

/** 推理请求的主机候选：cn 单主机；global 按官方候选顺序 api3→api2→api1 */
function chatStreamCandidates(region) {
  return region === 'cn' ? [ENDPOINTS.cn.ChatStreamURL] : INTL_CHAT_CANDIDATES;
}

function endpointsOf(region) {
  return ENDPOINTS[region === 'cn' ? 'cn' : 'global'];
}

/** 归一化区域：只有明确 cn 才是 cn，其余一律 global */
function normalizeRegion(raw) {
  return String(raw || '').trim().toLowerCase() === 'cn' ? 'cn' : 'global';
}

// ---- 模型 ----
// 上游下发 14 个（见 listModels）。这里只作兜底——拿不到真实表时用它，
// 避免客户端看到「没有可用模型」。
//
// **倍率差别很大（0.1 ~ 1.4，差 14 倍）**，所以开发调试一律用 0.1 档的
// Flash 模型，别用 auto/Kimi 烧额度。
const FALLBACK_MODELS = [
  'auto', 'qmodel_38max', 'qfmodel', 'qmodel_latest', 'qmodel', 'q37fmodel',
  'dmodel', 'dfmodel', 'gmodel', 'gfmodel', 'gm51model', 'kmodel_latest',
  'kmodel', 'mmodel',
];
const DEFAULT_MODEL = 'auto';
/** 开发调试推荐的最低倍率模型（0.1） */
const CHEAP_MODELS = ['qfmodel', 'qmodel', 'q37fmodel', 'dfmodel', 'gfmodel'];
/** 模型别名：客户端可能传这些名字 */
const MODEL_ALIASES = { 'qwen-max': 'qmodel_latest', 'qwen-plus': 'qmodel', 'qwen-flash': 'qfmodel' };

module.exports = {
  CHANNEL_ID,
  DISPLAY_NAME,
  COSY_VERSION,
  APP_CODE,
  OAUTH_CLIENT_ID,
  CLIENT_TYPE,
  CHECKIN_CLIENT_TYPE,
  LOGIN_VERSION,
  ENDPOINTS,
  endpointsOf,
  normalizeRegion,
  chatStreamCandidates,
  FALLBACK_MODELS,
  DEFAULT_MODEL,
  CHEAP_MODELS,
  MODEL_ALIASES,
};
