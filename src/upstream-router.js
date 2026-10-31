// src/upstream-router.js - 模型名 → 上游目标
//
// 本项目有两个上游：
//   - dumate（8980）：DuMate 后端，本地 HTTP，**转发**过去即可
//   - qwenwork：千问办公，云端 HTTPS，必须经官方 wasm 封装请求体，
//     **不走转发**（src/qwenwork/ 自己发请求）
//
// 两者模型命名空间、预算策略、鉴权方式都不同，必须在分发前分开。
// 注意 qwenwork 不是「另一个 HTTP 上游」——它没有本地端口，target 里
// 的 host/port 对它无意义，路由到它时上层要调用 provider 而不是转发。
//
// 分流靠**显式前缀**而不是猜模型名。理由：
//   - 模型名会撞车（搭子有 glm-5，千问上游也是 GLM 系），猜错了从响应
//     里根本看不出来——两侧都会正常返回 200。
//   - 隐式路由会让排障变成猜谜：同一个名字今天走 A 明天走 B。
//   - 前缀是显式契约，客户端配置里一眼可见。
//
// 无前缀一律归搭子，保证现有 cc-switch / Codex / Claude Code 配置零改动。
// 未知前缀**报错而不回落**——拼错 `qwn/pro` 若静默跑到搭子，会拿到一个
// 看起来成功但完全不是想要的结果，比直接 400 难查得多。
/** 千问办公通道的前缀。`qwen/pro` → 上游模型 `pro` */
const QWEN_PREFIX = 'qwen';
/** TRAE Work 通道的前缀。`traework/glm-5.2` → 上游模型 `glm-5.2` */
const TRAEWORK_PREFIX = 'traework';
/** Qoder 通道的前缀。`qoder/gfmodel` → 上游模型 `gfmodel` */
const QODER_PREFIX = 'qoder';
/**
 * 搭子自动档的前缀：`dm-auto-model/text.L0` 的**档位编码在模型名里**，
 * 斜杠不是通道分隔符（2026-10-31 真机实证：L0/L1/L2 分别实跑
 * DeepSeek-V4.1-Flash-Low-Latency / Kimi-K3 / Qwen3.8-Max）。整个名字
 * 原样交给搭子（model-map aliases 已登记自映射，mapModel 不会兜底掉）。
 */
const DUMATE_AUTO_PREFIX = 'dm-auto-model';

const UPSTREAMS = {
  dumate: {
    id: 'dumate',
    label: '百度搭子',
    host: '127.0.0.1',
    portEnv: 'DUMATE_UPSTREAM_PORT',
    defaultPort: 8980,
    prefix: null,
    // 搭子后端挂在 /api/qianfanproxy/v1 下，鉴权固定 Bearer nokey
    basePath: '/api/qianfanproxy/v1',
    auth: () => 'Bearer nokey',
    // 搭子的模型名要经 modelmap 映射，且要套输出预算下限
    needsModelMap: true,
    needsBudget: true,
  },
  // 千问办公：没有本地端口。请求由 src/qwenwork/ 直接发到
  // gateway.qwenwork.cn（经官方 wasm 封装），不经过本地转发。
  // 早期版本走 Buddy2api（8787）中转，后来发现 wasm_helper.mjs 本身就是
  // 纯 Node 脚本，Python 只是没必要的壳，所以改为直连——少一个进程、
  // 少一层鉴权、少一个故障点。
  qwenwork: {
    id: 'qwenwork',
    label: '千问办公',
    host: null,
    portEnv: null,
    defaultPort: null,
    prefix: QWEN_PREFIX,
    direct: true,          // true = 不转发，走 provider
    basePath: null,
    auth: () => null,
    needsModelMap: false,
    // 千问**也要**走预算兜底：实测 max_tokens=100 时 reasoning 吃掉 88，
    // 正文直接为 0（finish_reason=length）。Codex 默认就传小值，
    // 症状是「几秒就停、只走了开头」。
    // 但下限是独立的（4096 而非搭子的 32768）——它的 reasoning 峰值只有百级，
    // 套搭子的下限会把每个小请求凭空撑大。
    needsBudget: true,
    budgetKind: 'qwenwork',
  },
  // TRAE Work（SOLO CN）：同样是进程内直连，凭证由我们自己走 OAuth 换取
  // （见 src/traework/login.js），**不依赖 TRAE 客户端**。
  // 与千问的区别：千问只能读客户端的加密文件，而这里的账号是我们自己持有的。
  traework: {
    id: 'traework',
    label: 'TRAE Work',
    host: null,
    portEnv: null,
    defaultPort: null,
    prefix: TRAEWORK_PREFIX,
    direct: true,
    basePath: null,
    auth: () => null,
    // 模型名就是上游名（glm-5.2 等），不过搭子的别名表
    needsModelMap: false,
    // 与千问同理：reasoning 与正文抢预算，小 max_tokens 会截断正文
    needsBudget: true,
    budgetKind: 'traework',
  },
  // Qoder（阿里 AI IDE）：进程内直连，与千问办公**同一套 COSY 协议**，
  // 但签名是**纯本地算法**（src/qoder/cosy.js，不需要官方 wasm）。
  // 凭证走 device flow 自取（src/qoder/login.js），**不依赖 Qoder 客户端**。
  // 双区域：cn（qoder.com.cn）/ global（qoder.sh），账号各自独立。
  qoder: {
    id: 'qoder',
    label: 'Qoder',
    host: null,
    portEnv: null,
    defaultPort: null,
    prefix: QODER_PREFIX,
    direct: true,
    basePath: null,
    auth: () => null,
    needsModelMap: false,
    // 与千问/TRAE 同理：reasoning 与正文抢预算，小 max_tokens 会截断正文
    needsBudget: true,
    budgetKind: 'qoder',
  },
};

function portOf(up) {
  const raw = process.env[up.portEnv];
  const n = parseInt(raw || String(up.defaultPort), 10);
  return Number.isFinite(n) ? n : up.defaultPort;
}

function targetOf(up) {
  return {
    id: up.id,
    label: up.label,
    host: up.host,
    port: up.defaultPort === null ? null : portOf(up),
    basePath: up.basePath,
    // direct=true 的通道没有本地端口，上层必须调 provider 而不是转发
    direct: !!up.direct,
    needsModelMap: up.needsModelMap,
    needsBudget: up.needsBudget,
    budgetKind: up.budgetKind || (up.needsBudget ? 'dumate' : ''),
    authHeader: up.auth(),
  };
}

/**
 * 解析模型名 → { channel, target, model } 或 { error }
 * 例：'qwen/pro' → qwenwork 通道、上游模型 'pro'
 *     'glm-5'    → dumate 通道、模型 'glm-5'
 */
function resolve(model) {
  const name = String(model || '');
  const slash = name.indexOf('/');
  if (slash > 0) {
    const head = name.slice(0, slash);
    // 搭子自动档的名字自带斜杠，先于通道前缀匹配认领——否则会撞进
    // unknown_channel 被 400（网关能调的模型因此少一半）
    if (head === DUMATE_AUTO_PREFIX) {
      return { channel: 'dumate', target: targetOf(UPSTREAMS.dumate), model: name };
    }
    const rest = name.slice(slash + 1);
    for (const up of Object.values(UPSTREAMS)) {
      if (up.prefix && up.prefix === head) {
        return { channel: up.id, target: targetOf(up), model: rest };
      }
    }
    return { error: `unknown_channel: ${head}` };
  }
  return { channel: 'dumate', target: targetOf(UPSTREAMS.dumate), model: name };
}

/**
 * 搭子的凭证来源：`'web'`（默认）或 `'auto'`。
 *
 * 默认值已从 `auto` 改成 `web`（2026-10-22）。依据是实测而非偏好：
 * 客户端卸载后桌面链路必然失败（`auth.json` 不存在），`auto` 只是让它
 * 先花约 3 秒探测、再在每个请求上撞一次 ECONNREFUSED 才回落；而网页链路
 * 实测首字 p50 826ms，比桌面链路的 1570ms 快近一倍（少了本地 Go 中转那一跳），
 * 四条协议与三个模型在网页链路上全部验证通过。
 *
 * `DUMATE_DUMATE_SOURCE=auto`（等价写法 `desktop`）恢复旧行为：桌面优先、
 * 不可用时回落网页池。桌面链路仍然保留——它唯一的独占价值是「凭证明文
 * 不进网关进程」，留着作为网页接口被风控时的退路，只是不再默认启用。
 *
 * 无法识别的值按默认（web）处理，由启动日志告警，不静默当 auto。
 */
function dumateSource() {
  const v = String(process.env.DUMATE_DUMATE_SOURCE || '').trim().toLowerCase();
  if (!v) return 'web';
  if (v === 'web') return 'web';
  if (v === 'auto' || v === 'desktop') return 'auto';
  return 'web';
}

/**
 * 某通道是否可用。
 * 千问的可用来判断两件事：官方 wasm 能不能找到、登录态能不能解出来——
 * 它不再依赖本地 8787 的 Key（那是走 Buddy2api 中转时的遗留）。
 *
 * 三条直连通道（qwenwork / traework / qoder）走**同一个判定形状**：各通道
 * index.js 的 status()（ready + error），路由层只认这个约定。此前 qoder 没有
 * 分支、落到末尾默认恒 ok——零账号也报可用，预检形同虚设，且三条通道
 * 语义不一致（CODE_REVIEW 问题 3 / GAP F7-2）。
 */
function availability(channel) {
  if (channel === 'dumate') {
    // 只用网页凭证时，桌面链路根本不参与，这个通道的可用性就是
    // 「网页池里有没有可用账号」。
    // 在这里判而不是在转发层判：四个协议入口都走这个函数，一处改动全覆盖，
    // 且能给出明确原因——转发层只能回一句笼统的 upstream unavailable。
    if (dumateSource() === 'web') {
      try {
        const fb = require('./fallback-web');
        return fb.available()
          ? { ok: true }
          : { ok: false, reason: '搭子当前只用网页凭证，但网页账号池里没有可用账号（想用桌面链路请设 DUMATE_DUMATE_SOURCE=auto）' };
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    }
    return { ok: true };
  }
  if (channel === 'qwenwork') {
    try {
      const st = require('./qwenwork').status();
      return st.ready ? { ok: true } : { ok: false, reason: st.error || 'not_ready' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }
  if (channel === 'traework') {
    try {
      const st = require('./traework').status();
      return st.ready ? { ok: true } : { ok: false, reason: st.error || 'not_ready' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }
  if (channel === 'qoder') {
    try {
      const st = require('./qoder').status();
      return st.ready ? { ok: true } : { ok: false, reason: st.error || 'not_ready' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }
  return { ok: true };
}

/** 对外暴露的模型名列表：直连通道的加前缀，避免与搭子撞名 */
function exposedFor(channel, models) {
  if (channel === 'qwenwork') return models.map((m) => `${QWEN_PREFIX}/${m}`);
  if (channel === 'traework') return models.map((m) => `${TRAEWORK_PREFIX}/${m}`);
  if (channel === 'qoder') return models.map((m) => `${QODER_PREFIX}/${m}`);
  return models.slice();
}

module.exports = {
  QWEN_PREFIX,
  TRAEWORK_PREFIX,
  QODER_PREFIX,
  DUMATE_AUTO_PREFIX,
  UPSTREAMS,
  resolve,
  availability,
  dumateSource,
  exposedFor,
};
