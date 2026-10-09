# dumate2api

![license](https://img.shields.io/badge/license-MIT-green)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![platform](https://img.shields.io/badge/platform-Windows-blue)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)

**百度搭子（DuMate）** 本地网关 —— 把百度搭子、千问办公、TRAE Work、Qoder 四条上游统一转成 **OpenAI / Anthropic / Google 兼容 API**，给 Codex CLI、Claude Code、cc-switch 用；无 GUI 拉起搭子后端，自带网页管理端。

> 如果你在找一个「DuMate / 百度搭子 转 OpenAI API」「搭子接 Claude Code / Codex」「千问办公或 Qoder 走标准协议」的方案，就是这里。

```
Codex CLI ──── OpenAI / Responses ─┐
Claude Code ──── Anthropic ────────┼──→ dumate2api :9080 ──┬──→ DuMate 后端 :8980 ──→ 百度千帆
任意客户端 ──── Google ────────────┘                        ├──→ 千问办公（进程内直连）
                                                            ├──→ TRAE Work（进程内直连）
                                                            └──→ Qoder（进程内直连）
```

## 特性

- **三协议网关** —— OpenAI / Anthropic（含原生工具）/ Google Generative Language，外加 Responses 适配层（Codex CLI 0.155+ 只认它）
- **四通道前缀分流** —— 百度搭子 / 千问办公 / TRAE Work / Qoder，靠模型名前缀显式路由，不猜名字
- **零第三方依赖** —— 网关本体只用 Node 内置模块（`playwright-core` 仅管理端登录器需要）
- **凭证自持** —— 千问 / TRAE / Qoder 三条通道走 OAuth Device Flow 自取凭证，不依赖官方客户端
- **无 GUI 运行** —— 自动拉起 `dumate-main-server.exe`，不需要打开搭子界面
- **网页控制台** —— 仪表盘、模型管理、API Key、积分明细、请求日志、聊天测试台
- **积分自动化** —— 签到幂等可定时；抽奖消耗不可逆，只留手动

## 快速开始

```bash
git clone <repo-url> && cd dumate2api
npm start                  # 网关 http://127.0.0.1:9080
npm run admin              # 管理端 http://127.0.0.1:9081（另开终端）
```

首次运行会自动拉起 DuMate 后端（**不需要打开 DuMate 界面**）。自检：

```bash
curl http://127.0.0.1:9080/health     # 应返回 "upstream_managed":true
```

```bash
curl http://127.0.0.1:9080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"model-text","messages":[{"role":"user","content":"hello"}]}'
```

## 四条通道

| 通道 | 上游 | 凭证 | 依赖客户端 |
|---|---|---|---|
| **百度搭子**（DuMate） | 本地 :8980（千帆 GLM） | 桌面登录态 / 网页 cookie | 是（搭子） |
| **千问办公**（QwenWork） | 云端网关，进程内直连 | 自持（OAuth Device Flow） | 否（仅需其 wasm 文件） |
| **TRAE Work** | 云端网关，进程内直连 | 自持（OAuth） | 否 |
| **Qoder** | 云端网关，进程内直连 | 自持（OAuth Device Flow） | **否**（签名纯本地） |

**靠模型名前缀分流**，不猜模型名：

| 调用方传的模型名 | 路由到 |
|---|---|
| `model-text` / `glm-5` 等（无前缀） | 百度搭子 |
| `qwen/pro` / `qwen/flash` | 千问办公 |
| `traework/glm-5.2` | TRAE Work |
| `qoder/gfmodel` | Qoder |
| 未知前缀（如 `qwn/pro`） | **400 报错，不静默回落** |

> 用前缀而不是猜名字：两侧模型名会撞车（搭子有 `glm-5`，千问上游也是 GLM 系），猜错了两侧都返回 200，从响应里根本看不出来。未知前缀若静默跑到搭子，会拿到「看起来成功但完全不是想要的结果」，比直接 400 难查得多。

### Qoder 通道

阿里 AI IDE，与千问办公**同一套 COSY 协议**（同样的 `Encode=1` 编码、同样的 `Bearer COSY.<payload>.<sig>` 信封、同样的 device flow、连 `client_id` 都相同），但有两点关键差异：

1. **签名是纯本地算法**（RSA + AES + MD5，公钥硬编码）——**不需要官方 wasm、不需要装任何客户端**
2. **额度分两块且不能相加** —— `userQuota`（订阅套餐内，Free 恒为 0）与 `addOnQuota`（签到/赠送，免费用户实际能用的就是这个）

**零额度时聊天会挂起**（不报错、不超时），所以**签到是通道可用的前提**。签到积分 **30 天后作废**，每日 10:00 (UTC+8) 刷新（千问是 00:00，两者不同）。

> 上游没有逐批余额接口，批次到期信息只能从领取响应本身取，所以网关在 `data/qoder-grants.jsonl` 本地记账。**「领取额」不是「剩余额」** —— 这是数据缺口，界面一律标注，实际剩余以额度卡总余额为准。

模型倍率差 **14 倍**，调试建议用 0.1 档：`qfmodel` / `qmodel` / `q37fmodel` / `dfmodel` / `gfmodel`。倍率从模型表的 `price_factor` 读，不硬编码。

命令行自测（不开管理端也能验证）：

```bash
node test/qoder-cli.js login [cn|global]   # 生成授权链接
node test/qoder-cli.js quota               # 额度
node test/qoder-cli.js checkin             # 领积分
node test/qoder-cli.js chat "你好"          # 默认用最省的 gfmodel
```

## 进程一览

| 进程 | 端口 | 入口 | 职责 |
|---|---|---|---|
| 网关（稳定版） | 9080 | `stable/src/server.js` | 对外长期服务，冻结快照 |
| 网关（开发） | 9082 | `src/server.js` | 开发调试，改动都在这里 |
| 管理端 | 9083 | `src/admin/server.js` | 管理 API + 托管前端，读 9082 |
| 网页凭证网关 | 9084 | `src/web-gateway.js` | 多账号轮换跑模型 |
| DuMate 后端 | 8980 | 由网关拉起 | 真实模型链路 |

> 开发时用 `start-dev.bat`（9082 + 9083），与稳定版 9080 互不干扰。管理端**不代理模型协议**——网关已经在做，多一跳只多一个故障点。所有进程通过 `data/` 下的文件通信，不通过 IPC。

## 前置条件

- **Node.js >= 18**，**仅 Windows**（依赖 PowerShell 进程查询、`%APPDATA%` 路径、`taskkill`）
- **至少配置一条通道** —— 任一条不可用时网关仍会监听，`/health` 的 `channels.*.ready` 报 false，**不阻断启动**

**百度搭子** —— 安装 DuMate 桌面客户端（[下载](https://cloud.baidu.com/doc/Dumate/index.html)）并登录一次。之后不再需要启动客户端界面。登录态在 `%APPDATA%\qianfan-desktop-app\auth.json`；安装目录非默认时设 `DUMATE_INSTALL_DIR`。

**千问办公** —— 登录一次即可，之后不依赖官方客户端。但需要官方客户端的 wasm 文件（运行时从安装目录读，**不进仓库**），探测不到时设 `DUMATE_QWENWORK_INSTALL` 或 `CB_QWENWORK_WASM`。

**TRAE Work** / **Qoder** —— 独立 OAuth 登录，完全不依赖客户端。

关闭某条通道：`DUMATE_QWENWORK_AUTOSTART=off` / `DUMATE_TRAEWORK_AUTOSTART=off`。

## 客户端配置

### cc-switch

| 标签 | 名称 | API 格式 | Base URL | Key | 模型 |
|---|---|---|---|---|---|
| Claude | DuMate (Claude) | `anthropic` | `http://127.0.0.1:9080` ← 不加 `/v1` | `nokey` | `model-text` |
| Codex | DuMate (Codex) | `openai_responses` | `http://127.0.0.1:9080/v1` ← 要加 `/v1` | `nokey` | `model-text` |

Codex 的 `config.toml`：

```toml
model_provider = "dumate"
model = "model-text"
model_reasoning_effort = "high"

[model_providers.dumate]
name = "DuMate local proxy"
base_url = "http://127.0.0.1:9080/v1"
wire_api = "responses"
requires_openai_auth = true
```

> **`wire_api = "responses"`** —— Codex CLI 0.155+ 已移除 `chat`（配置加载阶段直接报错）。网关自带 `/v1/responses` 适配层，填 `responses` 即可。
>
> URL 一个有 `/v1` 一个没有：Claude 侧 cc-switch 会自己拼 `/v1/messages`；Codex 要求 base_url 本身已含 `/v1`。

配置完验证：`node test/verify-ccswitch.js`（Codex / Claude / 裸路径 / 模型映射四条链路）。

### API 端点

| 端点 | 协议 |
|------|------|
| `GET /v1/models` | OpenAI 模型列表（四通道都列出） |
| `POST /v1/chat/completions` | 聊天补全 |
| `POST /v1/responses` 或 `/responses` | Responses（Codex CLI） |
| `POST /v1/messages` 或 `/messages` 或 `/api/v1/messages` | Anthropic Messages |
| `POST /v1/messages/count_tokens` | Token 计数（估算） |
| `GET /v1beta/models` / `POST .../generateContent` | Google Generative Language |
| `GET /health` | 健康检查，含各通道就绪状态 |

> 裸路径 `/messages` 必须保留 —— Claude Code 打的就是它。

## 管理端

另起终端跑 `npm run admin`。首次启动会生成管理员口令并打印在终端。

**改的是哪个网关端口就要带对应变量**，否则管理端读到别的实例的数据：

```bash
DUMATE_ADMIN_GATEWAY_PORT=9082 npm run admin
```

| 页面 | 回答什么问题 |
|---|---|
| 仪表盘 | 各通道健康、用量、账号状态、即将过期积分 |
| 模型管理 | 有哪些模型、上下文/输出上限、倍率、额度还剩多少 |
| API Key | 签发密钥（IP 白名单、模型白名单、通道绑定） |
| 积分明细 | 积分从哪来、怎么没的（含签到/任务/抽奖、额度包、日历） |
| 账号管理 | 增删账号、跑任务、开轮询（**操作台**） |
| 用量统计 / 请求日志 | 趋势与逐条明细（含每条请求花了多少积分） |
| 聊天测试台 | 不签发密钥直接试调某个模型名能不能跑通 |

顶栏切换通道，各页面据此显示对应数据。**四条通道的账各自独立，不能相加** —— 搭子靠上游账单 + 余额游标，千问是三个积分池，TRAE 是每账号独立 credits，Qoder 是订阅 + 赠送两块额度。

前端开发：`cd web && npm install && npm run dev`。

## 常用环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DUMATE2API_PORT` / `_HOST` | `9080` / `127.0.0.1` | 网关监听 |
| `DUMATE_REQUIRE_KEY` | 未设（关闭） | 设 `1` 才校验 API Key。**对外暴露必须打开** |
| `DUMATE_MIN_MAX_TOKENS` / `_MAX_` | `65536` / `131072` | 输出预算钳制区间（`0` 关下限） |
| `DUMATE_ADMIN_PORT` | `9081` | 管理端监听 |
| `DUMATE_ADMIN_GATEWAY_PORT` | `9080` | 管理端读哪个网关；**开发实例设 `9082`** |
| `DUMATE_ADMIN_DATA` | `<repo>/data` | 数据目录，管理端与网关**必须一致** |
| `DUMATE_QWENWORK_AUTOSTART` | `auto` | `off` 关闭千问通道 |
| `DUMATE_TRAEWORK_AUTOSTART` | `auto` | `off` 关闭 TRAE 通道 |
| `DUMATE_AUTO_CHECKIN_HOUR` / `_MINUTE` | `9` / `17` | 每日自动签到（**两个都要设**） |
| `DUMATE_TASK_POLL_MINUTES` | `30` | 任务轮询（`0` 关闭，低于 5 分钟会被拒） |
| `DUMATE_WEB_FALLBACK` | 未设（开启） | `0` 关闭「桌面凭证失效时回落到网页池」 |

> 完整列表见 [CLAUDE.md](CLAUDE.md)。`DUMATE2API_KEY` 是历史遗留的死变量，代码中从未读取——真实开关是 `DUMATE_REQUIRE_KEY`。

## 已知边界

- **输出预算下限是硬需求，不是可选优化**。GLM 的思维链与正文共用同一个 `max_tokens`，reasoning 实测在 57~8492 tokens 间浮动，预算不足会拿到空正文或半句截断。网关统一抬到 65536 以上。
- **思考强度调不了** —— 上游忽略 `reasoning_effort`，实测各档 reasoning token 数无差异（`is_reasoning` 硬编码 `false`）。想要更深入的分析，只能靠提示词。
- **上游不支持 function calling / 图像** —— 工具调用被降级为纯文本（`[Tool Use: 名字]`），这是能力边界不是实现缺陷。
- **搭子上游只有三个真实模型** —— `model-text` / `model-artifact-validate` / `glm-5`，传别的名字硬性报 `api not registered`。
- **`count_tokens` 是估算**（字节数 / 4），只用于让 Claude Code 的上下文预算不报错。
- **cookie 过期必须开一次 DuMate 客户端重登** —— 这是唯一绕不过去的。

## 项目结构

```
src/
  server.js              网关主入口，协议路由与鉴权
  anthropic.js           Anthropic ↔ OpenAI（含 SSE 状态机）
  responses.js           Responses ↔ Chat（Codex CLI）
  google.js              Google Generative Language ↔ OpenAI
  upstream-router.js     模型名前缀 → 通道
  channels.js            通道 id 单一来源
  qwenwork/  traework/  qoder/    三条直连通道
  admin/                 管理端（路由、存储、鉴权）
stable/                  9080 跑的冻结快照（36 个 .js，不随开发改动）
web/                     管理端前端（Vue 3 + Vite + ant-design-vue）
test/                    冒烟测试与离线验证脚本
data/                    运行时数据（**已 gitignore**，含凭证）
```

### stable/ 是冻结快照

`stable/` 是网关闭包的逐字节拷贝，保证 9080 不被开发中的代码波及，有独立启动脚本 `stable/start-stable.bat`。

发布新版**不要简单「把 `src/*.js` 覆盖过去」** —— 这个 glob 漏掉 `qwenwork/` `traework/` 等子目录（漏了通道直接不可用），还会把管理端一起带进去。正确做法是**按依赖闭包复制**：从 `src/server.js` 出发递归解析 `require('./x')`，复制闭包内文件，然后逐字节比对 + `node --check` + 用临时端口独立启动一次。

> **手工启动 `stable/` 会退回空数据目录**（`reqlog.js` 按 `__dirname` 解析），里面没有任何凭证。启动 9080 必须走 `start-stable.bat`，它设了 `DUMATE_ADMIN_DATA=<repo>/data`。

## 测试

```bash
npm test                        # 冒烟测试（32 项断言，需网关在线）
node test/verify-ccswitch.js    # Codex / Claude / 裸路径 / 模型映射四条链路
node test/probe-oai.js          # 只打 OpenAI，原始 SSE 打到 stdout
node test/probe-anth.js         # 只打 Anthropic
```

离线验证（不需要起服务，改完相关代码先跑这些）：

```bash
node test/verify-channel.js              # 通道过滤 + 积分归因配对
node test/verify-qoder-cosy.js           # Qoder 签名算法（Go 参考实现生成的向量）
node test/verify-qoder-channel.js        # Qoder 通道逻辑
node test/verify-qoder-grants.js         # Qoder 积分批次账本
node test/verify-traework-gained.js      # TRAE 签到到账差值
node test/verify-traework-repair.js      # TRAE「播报即收尾」修复
node test/verify-qwen-daily-aggregate.js # 千问每日额度多账号合计
node test/verify-display-name.js         # 账号显示名解析
```

## 数据与凭证

| 文件 | 内容 | 敏感度 |
|---|---|---|
| `keys.json` | API Key，**只存 sha256** | 低 |
| `web-accounts.json` | 网页账号，**cookie 明文存** | **高** |
| `qwenwork-accounts.json` / `traework-accounts.json` / `qoder-accounts.json` | 直连凭证（含 refresh token） | **高（等同密码）** |
| `admin-users.json` / `admin.secret` | 管理员口令（scrypt）与会话密钥 | **高** |
| `requests.jsonl` / `activity.jsonl` | 埋点与操作记录 | 中 |

> **三种凭证策略不同是刻意的**：API Key 只存哈希（可验证不可还原）；cookie 必须明文（上游要求原样重放）；管理端口令走 scrypt。所以 `data/` 一旦被复制走，网页与直连通道的凭证是**直接可用**的 —— 该目录已在 `.gitignore`，**不要提交，不要放进任何备份镜像**。

## 许可证

[MIT](LICENSE)

---

**免责声明**：本项目是独立的第三方开源项目，与百度 / 阿里（千问办公、Qoder）/ 字节（TRAE）及 Anthropic / OpenAI / Google 等主体无任何隶属、合作或背书关系，文中产品名仅为指代用途。本项目通过协议适配实现与本地已安装客户端的互操作，**不破解、不绕过任何付费墙或授权机制**，**不分发任何上游二进制资产**（千问的 wasm 运行时从你本机安装目录读取），也**不上报任何数据** —— 所有凭证与日志只存本机。积分自动化功能可能违反上游服务条款并导致账号受限，**是否使用及其后果由你自行承担**。本项目按「现状」提供，不附带任何担保。有问题请通过仓库 Issue 联系。
