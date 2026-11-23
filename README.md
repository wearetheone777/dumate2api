# dumate2api

> 架构与代码详解见 [ARCHITECTURE.md](ARCHITECTURE.md)。

![license](https://img.shields.io/badge/license-MIT-green)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Docker-blue)
![deps](https://img.shields.io/badge/gateway%20deps-0-brightgreen)

**五条上游 → 三协议网关。** 把百度搭子（DuMate）、千问办公、TRAE Work、Qoder、WorkBuddy 统一转成 **OpenAI / Anthropic / Google 兼容 API**，供 Codex CLI、Claude Code、cc-switch 等客户端使用；附带网页控制台，管理账号、签到、积分与请求埋点。完整使用说明见 **[用户使用手册](docs/USER_MANUAL.md)**。

<p align="center">
  <img src="assets/screenshots/dashboard.png" alt="管理端仪表盘" width="860" />
</p>

```
Codex CLI ──── OpenAI / Responses ─┐
Claude Code ──── Anthropic ────────┼──→ dumate2api ──┬──→ 百度搭子（网页凭证 / 本地 :8980）
任意客户端 ──── Google ────────────┘                 ├──→ 千问办公（进程内直连）
                                                    ├──→ TRAE Work（进程内直连）
                                                    ├──→ Qoder（进程内直连）
                                                    └──→ WorkBuddy（进程内直连，双区域 cn / global）
```

## 特性

- **三协议 + Responses** —— OpenAI / Anthropic / Google 全覆盖，含 Codex CLI 0.155+ 只认的 `responses` 线格式
- **五通道前缀分流** —— 靠模型名前缀显式路由，未知前缀直接 400，不静默回落
- **零客户端依赖** —— 五条通道凭证均自持；千问与 Qoder 的签名是纯本地算法，WorkBuddy 的浏览器只是授权面，都不需要官方客户端
- **网关零第三方依赖** —— 只用 Node 内置模块（`playwright-core` 仅管理端浏览器登录器使用）
- **网页控制台** —— 仪表盘、模型管理、积分明细（含按月/按年签到详情）、用量统计、请求日志、聊天测试台
- **签到与积分** —— 签到幂等、可定时；抽奖消耗不可逆，只留手动

## 快速开始

```bash
git clone <repo-url> && cd dumate2api
npm install
npm start                  # 网关 http://127.0.0.1:9080
npm run admin              # 管理端 http://127.0.0.1:9081（另开终端）
```

首次启动管理端会打印随机管理员口令，**只显示一次**。

> 端口只有一套默认值：网关 `9080` / 管理端 `9081`。`start-dev.bat` 与 `start.bat` 行为一致（同起这两个端口）。要并行跑第二个实例时，用 `DUMATE2API_PORT` / `DUMATE_ADMIN_PORT` / `DUMATE_ADMIN_GATEWAY_PORT` 显式错开。

自检：

```bash
curl http://127.0.0.1:9080/health     # 看 channels 里各通道的 ready 状态

curl http://127.0.0.1:9080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"model-text","messages":[{"role":"user","content":"hello"}]}'
```

**默认凭证来源是网页池**：网关启动时不探测、也不拉起桌面后端。要跑搭子通道，先在管理端「账号管理」登录一个网页账号（或粘贴 cookie）；想用桌面登录态则设 `DUMATE_DUMATE_SOURCE=auto`。千问 / TRAE / Qoder 走 OAuth；WorkBuddy 在「账号管理」页用「浏览器登录」（浏览器只是授权面，token 由上游签发），多账号每个账号各走一遍。全部无需官方客户端。

## Docker 部署

```bash
docker compose up -d --build
docker compose logs | grep -A3 "初始管理员"   # 首次启动的管理员口令只打印一次
```

镜像分两阶段构建（前端 pnpm 构建 → 纯 Node 运行时），单容器跑两个进程——管理端查网关状态硬编码 `127.0.0.1`，拆成两个容器就读不到网关，不能拆。

| 端口 | 用途 |
|---|---|
| 9080 | 网关（OpenAI / Anthropic / Google） |
| 9081 | 管理端网页控制台 |
| 18080 | TRAE OAuth 回环回调（compose 里默认注释：宿主端口空闲且浏览器与 Docker 同机时取消注释才有自动回调，否则登录时手动粘贴） |

端口默认只绑宿主回环（`127.0.0.1:` 前缀），要局域网/公网访问改映射地址或上反向代理。鉴权强制开启——启动后在管理端「API Key」页签发，或设 `DUMATE2API_KEY`。

- 数据（凭证、埋点、密钥）在 named volume `dumate2api-data`，升级镜像不丢；**凭证敏感，不要导出、不要打进镜像**
- 容器内可用：五条通道全部功能 + 管理端。搭子走网页凭证；千问 / TRAE / Qoder / WorkBuddy 走 OAuth（WorkBuddy 是打开授权链接 + 服务端轮询，容器内照常可用）
- 容器内不可用：Windows 桌面后端链路（`DUMATE_DUMATE_SOURCE=auto` 无意义）；搭子「浏览器登录」抓 cookie（需要本机浏览器，改用「粘贴 cookie」）

## 五条通道

| 通道 | 上游 | 凭证 | 需要官方客户端 |
|---|---|---|---|
| **百度搭子**（DuMate） | 网页接口 / 本地 :8980 | 网页 cookie（默认）/ 桌面登录态 | **否**（`DUMATE_DUMATE_SOURCE=auto` 才用桌面链路） |
| **千问办公**（QwenWork） | 云端网关，进程内直连 | 自持（OAuth Device Flow） | **否**（签名纯本地） |
| **TRAE Work** | 云端网关，进程内直连 | 自持（OAuth） | 否 |
| **Qoder** | 云端网关，进程内直连 | 自持（OAuth Device Flow） | **否**（签名纯本地） |
| **WorkBuddy** | 云端网关，进程内直连 | 自持（浏览器授权 / 导入客户端认证文件 / 粘贴 token） | **否**（浏览器只是授权面） |

| 调用方传的模型名 | 路由到 |
|---|---|
| `model-text` / `glm-5` 等（无前缀） | 百度搭子 |
| `qwen/pro` / `qwen/flash` | 千问办公 |
| `traework/glm-5.2` | TRAE Work |
| `qoder/gfmodel` | Qoder |
| `workbuddy/glm-5.3` | WorkBuddy |
| 未知前缀（如 `qwn/pro`） | **400 报错，不静默回落** |

> 千问与 Qoder 共用同一套 COSY 协议和一份本地签名实现（`src/cosy.js`）。千问做重创作/长任务用 `pro`（`flash` 会播报进度就收尾）；Qoder 零额度时聊天会挂起，**签到是通道可用的前提**，且倍率差 14 倍、调试用 0.1 档（`gfmodel` 等）。细节与实测数据见 [CLAUDE.md](CLAUDE.md)。

> **WorkBuddy** 是腾讯 Copilot 系 AI 编程助手（与 CodeBuddy 同源），**双区域独立账号池**：国内 WorkBuddy（`copilot.tencent.com`）与国际 WorkBuddy AI（`workbuddy.ai`），端点、模型表、凭证域都不通用。模型名前缀 `workbuddy/`（如 `workbuddy/glm-5.3`），上游是标准 OpenAI SSE，流式原样透传；图像输入透传天然支持。要点：
>
> - **登录走浏览器授权**（账号管理页「浏览器登录」）：浏览器只是授权面，token 由上游按 CLI 形态签发——多账号即每个账号各走一遍（换账号或无痕窗口），不依赖官方客户端的单一登录态
> - **签到仅国内版**（幂等、可定时）；国际版如实显示「不支持」，不是错误
> - **风控连坐保护**：账号级受限（11140）默认**不换号**、整区域暂停一段时间——出口指纹被上游扫到时，换号等于把同一指纹挨个报给风控；宁可少服务一会儿，也别把账号送走
> - **国内 CLI 对话当前不实时扣套餐**（公测/活动口径）：计费探针 `delta=null` 是如实测量，不是故障；FEFO 临期优先仍有意义（套餐包会到期作废）
>
> 细节与实测数据见 [docs/CHANNEL-WORKBUDDY.md](docs/CHANNEL-WORKBUDDY.md)。

## 客户端配置

| 标签 | API 格式 | Base URL | Key | 模型 |
|---|---|---|---|---|
| Claude | `anthropic` | `http://127.0.0.1:9080` ← 不加 `/v1` | `nokey` | `model-text` |
| Codex | `openai_responses` | `http://127.0.0.1:9080/v1` ← 要加 `/v1` | `nokey` | `model-text` |

Codex 的 `config.toml`：

```toml
model_provider = "dumate"

[model_providers.dumate]
name = "DuMate local proxy"
base_url = "http://127.0.0.1:9080/v1"
wire_api = "responses"          # 0.155+ 只认 responses
requires_openai_auth = true
```

| 端点 | 协议 |
|------|------|
| `POST /v1/chat/completions` | 聊天补全 |
| `POST /v1/responses` 或 `/responses` | Responses（Codex CLI） |
| `POST /v1/messages` 或 `/messages` | Anthropic Messages |
| `GET /v1beta/models` / `POST .../generateContent` | Google Generative Language |
| `GET /v1/models` / `GET /health` | 模型列表 / 健康检查 |

## 管理端

<p align="center">
  <img src="assets/screenshots/models.png" alt="模型管理" width="420" />
  <img src="assets/screenshots/usage.png" alt="用量统计" width="420" />
  <img src="assets/screenshots/points.png" alt="积分明细" width="420" />
</p>

<p align="center">
  <img src="assets/screenshots/checkin.png" alt="签到详情（按月/按年）" width="860" />
</p>

<p align="center"><sub>签到详情：每个账号的当月日历 + 全年各月汇总，切换月份即可回看。搭子 / TRAE / Qoder 共用同一视图，本地账本覆盖起点如实标出。</sub></p>

<p align="center">
  <img src="assets/screenshots/tasks-lottery.png" alt="签到、任务与抽奖" width="860" />
</p>

<p align="center"><sub>账号管理页：一键签到 / 单账号签到与抽奖 / 跑任务 / 一键抽奖，后台自动轮询的间隔策略如实展示；任务记录并入积分明细的操作流水。</sub></p>

顶栏切换通道，各页面据此显示对应数据。

| 页面 | 回答什么问题 |
|---|---|
| 仪表盘 | 各通道健康、用量、账号状态、即将过期积分 |
| 模型管理 | 有哪些模型、上下文/输出上限、倍率、额度还剩多少 |
| 积分明细 | 积分从哪来、怎么没的；签到详情按月/按年查看 |
| 用量统计 / 请求日志 | 趋势与逐条明细（含每条请求花的积分） |
| API Key / 账号管理 / 聊天测试台 | 签发密钥 / 增删账号跑任务 / 免密钥试调模型 |

> **五条通道的账各自独立，不能相加**：搭子靠上游账单 + 余额游标，千问是三个积分池，TRAE 是每账号独立 credits，Qoder 是订阅 + 赠送两块，WorkBuddy 是套餐剩余额（精确到小数；国内 CLI 对话当前不实时扣套餐）。

## 常用环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DUMATE2API_PORT` / `_HOST` | `9080` / `127.0.0.1` | 网关监听（容器镜像内已绑 `0.0.0.0`） |
| `DUMATE2API_KEY` | 未设 | env 兜底 API key（命中即放行）；正式签发与管理在管理端「API Key」页。**鉴权强制开启**，无 key 的模型请求一律 401，`DUMATE_REQUIRE_KEY` 已废除 |
| `DUMATE_DUMATE_SOURCE` | `web` | 搭子凭证来源。默认 `web` = 只用网页凭证，不需要客户端；`auto`（别名 `desktop`）= 桌面优先、不可用回落网页池 |
| `DUMATE_ADMIN_PORT` / `DUMATE_ADMIN_GATEWAY_PORT` | `9081` / `9080` | 管理端监听 / 管理端读哪个网关（默认即对；并行多实例时才需错开） |
| `DUMATE_QWENWORK_AUTOSTART` / `DUMATE_TRAEWORK_AUTOSTART` | `auto` | 设 `off` 关闭对应通道 |
| `DUMATE_WORKBUDDY_CHECKIN_HOUR` / `_MINUTE` | `0` / `0` | WorkBuddy 国内版自动签到时刻（默认关；**两个都要设**） |
| `DUMATE_AUTO_CHECKIN_HOUR` / `_MINUTE` | `9` / `17` | 每日自动签到（**两个都要设**） |

> 完整列表见 [CLAUDE.md](CLAUDE.md)。`DUMATE_REQUIRE_KEY` 是已废除的死变量（鉴权恒开），真实开关就是 `DUMATE2API_KEY` 本身。

## 测试

```bash
npm test                                  # 离线单测（不需要任何运行中的服务）
npm run test:smoke                        # 冒烟测试（需网关在线，默认打 9080）
node test/verify-ccswitch.js              # Codex / Claude / 裸路径 / 模型映射四条链路
node test/verify-checkin-detail.js        # 签到账本与按月/按年查询（离线）
node test/verify-qoder-cosy.js            # 签名算法逐字节比对（离线）
node test/verify-workbuddy-repair.js      # WorkBuddy「播报即收尾」修复门（离线）
node --test test/unit/workbuddy-login.test.js   # WorkBuddy 浏览器授权登录（离线）
node test/verify-fallback-stream-pipe.js  # 回落路径流式转发（离线）
```

更多离线验证脚本见 `test/verify-*.js`，改完对应模块先跑它们。

## 数据与凭证

| 文件 | 内容 | 敏感度 |
|---|---|---|
| `keys.json` | API Key，**只存 sha256** | 低 |
| `web-accounts.json` | 网页账号，**cookie 明文存** | **高** |
| `*-accounts.json`（qwenwork / traework / qoder / workbuddy） | 直连凭证（含 refresh token） | **高（等同密码）** |
| `admin-users.json` / `admin.secret` | 管理员口令与会话密钥 | **高** |

> `data/` 已在 `.gitignore`。**不要提交，不要放进任何备份镜像**——凭证被复制走是直接可用的。

## 许可证

[MIT](LICENSE)

---

**免责声明**：本项目是独立的第三方开源项目，与百度 / 阿里（千问办公、Qoder）/ 字节（TRAE）/ 腾讯（WorkBuddy）及 Anthropic / OpenAI / Google 等主体无隶属、合作或背书关系。它通过协议适配与本地客户端互操作，**不破解、不绕过任何付费墙或授权机制**，**不分发任何上游二进制资产**，也**不上传任何数据**——凭证与日志只存本机。积分自动化可能违反上游服务条款并导致账号受限，后果自负。本项目按「现状」提供，不附带任何担保。
