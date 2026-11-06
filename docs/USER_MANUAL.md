# DuMate2API 用户使用手册

> 适用版本：2026-10（四通道 + 管理端 2.0） · 本手册面向**使用者**，面向开发者的架构与实现细节见 [CLAUDE.md](../CLAUDE.md)，快速概览见 [README](../README.md)。

---

## 目录

1. [系统简介](#1-系统简介)
2. [安装与启动](#2-安装与启动)
3. [首次配置](#3-首次配置)
4. [管理端页面指南](#4-管理端页面指南)
5. [客户端接入](#5-客户端接入)
6. [模型名与路由规则](#6-模型名与路由规则)
7. [日常运维：签到与任务](#7-日常运维签到与任务)
8. [常见问题排查（FAQ）](#8-常见问题排查faq)
9. [环境变量参考](#9-环境变量参考)
10. [诊断工具与日志](#10-诊断工具与日志)
11. [安全注意事项](#11-安全注意事项)

---

## 1. 系统简介

DuMate2API 是运行在本机的**模型网关 + 进程管理器**，它把五条上游统一转成标准 API：

| 通道 | 上游 | 凭证 | 是否需要官方客户端 |
|---|---|---|---|
| **百度搭子**（DuMate） | 本地 :8980 后端（千帆 GLM） | 桌面登录态 或 网页 cookie | 桌面链路需要；网页链路不需要 |
| **千问办公**（QwenWork） | 云端网关，进程内直连 | 自持（OAuth Device Flow） | **不需要**（签名纯本地算法） |
| **TRAE Work** | 云端网关，进程内直连 | 自持（OAuth，国内/国际双区域） | 不需要 |
| **Qoder** | 云端网关，进程内直连 | 自持（OAuth Device Flow，国内/国际） | **不需要**（签名纯本地算法） |
| **WorkBuddy** | 云端网关，进程内直连 | 自持（导入客户端认证文件或粘贴 token，国内/国际） | 运行时不需要（导入时用一次客户端登录态） |

调用方（Codex CLI、Claude Code、cc-switch、任意 OpenAI/Anthropic/Google 兼容客户端）按**模型名前缀**选择通道，见[第 6 节](#6-模型名与路由规则)。

---

## 2. 安装与启动

### 2.1 前置条件

- **Windows 10+**（依赖 PowerShell 进程查询、`%APPDATA%` 路径）
- **Node.js >= 18**（网关零第三方依赖；前端构建与管理端登录器另有依赖）
- 至少配置**一条通道**的凭证（任一通道不可用不会阻断网关启动）

### 2.2 启动

```bash
git clone <repo-url> && cd dumate2api
npm install          # 安装依赖（playwright-core 等管理端所需）
npm start            # 网关 :9080，自动拉起 DuMate 后端 :8980
npm run admin        # 管理端 :9081（另开终端）
```

一键脚本（Windows）：

| 脚本 | 作用 |
|---|---|
| `start.bat` | 启动网关 + 后端 |
| `start-dev.bat` | 启动开发网关 :9082 + 管理端 :9083（日常开发用） |
| `start-stable.bat` | 启动稳定版快照 :9080（对外服务用，**必须经它启动**） |
| `start-web-gateway.bat` | 启动网页凭证独立网关 :9084 |
| `stop.bat` | 停止网关进程树（不动 DuMate GUI 与 cc-switch） |
| `restart.bat` | 重启 |

### 2.3 端口一览

| 端口 | 进程 | 说明 |
|---|---|---|
| 9080 | 稳定版网关 | 对外长期服务 |
| 9081 | 管理端（默认） | `npm run admin` |
| 9082 | 开发网关 | 开发调试 |
| 9083 | 开发管理端 | 与 9082 配套，`start-dev.bat` |
| 9084 | 网页凭证网关 | 多账号轮换跑模型 |
| 8980 | DuMate 后端 | 网关自动拉起，无需手动管理 |

---

## 3. 首次配置

### 3.1 登录管理端

1. 首次启动管理端时，终端会打印**随机生成的管理员口令**（只显示这一次，请立即保存）。
2. 浏览器打开 `http://127.0.0.1:9081`（或开发实例 9083），用 `admin` + 该口令登录。
3. 忘记口令时可重设：
   ```bash
   node src/admin/server.js --reset-admin --password=你的新口令
   ```
   重设后其它已登录会话会被踢下线。

> **开发实例注意**：启动管理端时要带 `DUMATE_ADMIN_GATEWAY_PORT=9082`，否则界面读的是 9080（可能没启动）的数据。

### 3.2 配置各通道账号

**百度搭子**（二选一）：

- **桌面凭证**：安装 [DuMate 桌面客户端](https://cloud.baidu.com/doc/Dumate/index.html)并登录一次，之后不必再打开界面。cookie 过期时需重新打开客户端登录（唯一绕不过的一步）。
- **网页凭证（默认，不装客户端）**：管理端「账号管理」→ 浏览器登录器登一次 `www.dumate.cn`（或手动粘贴 cookie）→ 可添加多个账号。**这是默认链路**，跳过桌面探测，短会话里直接可用。

**千问办公 / TRAE Work / Qoder**（均为 OAuth 自取，不需要客户端）：

- **千问**：管理端「登录态」页发起 device flow 登录；支持多账号池、指定主账号、故障转移。
- **TRAE**：「登录态」页两步 OAuth（生成链接 → 粘贴回调）。也可命令行自测：`node test/traework-login.js login|checkin|chat`。
- **Qoder**：设备流登录（国内/国际区）。命令行：`node test/qoder-cli.js login [cn|global]`。

**WorkBuddy**（推荐**浏览器 OAuth 登录**，天然支持多账号）：

- **浏览器登录（推荐）**：管理端「账号管理」→ WorkBuddy → 「浏览器登录」→ 在弹出的官方登录页完成登录（手机号/微信均可），页面自动轮询并导入账号。**要加多个账号就换一个账号再点一次**（浏览器已登录当前账号时可开无痕窗口）。
- **导入客户端认证文件**：没有浏览器条件时的替代。读本机 `workbuddy-desktop[-ai].info`（在 CodeBuddyExtension 的 auth 目录），必须先在客户端里登录对应区域的账号。
- **手动粘贴 token**：最后的替代方式，直接粘 access/refresh token。
- 国际版没有签到与 credits 接口（订阅按请求数计）；国内版有签到（每日一次，幂等）。

### 3.3 签发 API Key（必须）

**模型端点强制鉴权**（2026-11-01 起，不存在「不校验密钥」的形态）：没有合法 key 的模型请求一律 401。

1. 管理端「API Key」页签发密钥，可绑定：
   - **IP 白名单**（CIDR，写错一条会对所有来源拒绝——fail-closed）
   - **模型白名单**
   - **通道绑定**（如只允许千问，调搭子模型返回 403）
   - **区域绑定**（`cn` / `intl`；只对有国际版的通道有意义，intl key 打纯国内通道直接拒绝）
2. 密钥库里存 sha256（校验用）+ 明文（2026-11-01 起管理员可随时查看/复制；启用前创建的旧 key 无明文）。
3. 也可用环境变量 `DUMATE2API_KEY` 直设一把常时密钥。

---

## 4. 管理端页面指南

顶栏可切换查看通道（搭子 / 千问 / TRAE / Qoder / WorkBuddy），各页面显示当前通道的数据。**五条通道的账相互独立，数字不能相加。**
TRAE / Qoder / WorkBuddy 还有**区域视图**（顶栏「国内版 / 国际版」）：切到哪个区域，所有页面只显示那个区域的数据。

<p align="center">
  <img src="../assets/screenshots/dashboard.png" alt="仪表盘" width="640" />
</p>

### 仪表盘
回答「现在系统什么状态」：账号池健康度（总数/有效期内/即将过期积分/积分余额）、近 14 天调用趋势、今日用量、上游状态。搭子通道还会显示桌面凭证与网页凭证两套账号状态。

### 模型管理
回答「有哪些模型、花哪份额度」：各通道模型列表（上下文窗口、输出上限、倍率）+ 通道级额度卡。搭子的「凭证来源」会如实显示三态：桌面凭证 / 网页凭证回落 / 不可用。

### 积分明细
回答「积分从哪来、怎么没的」：额度包、按来源、每日发放、逐笔明细、签到日历。搭子的积分含签到/任务/抽奖/成长计划；直连通道是各自的积分池（千问三池、TRAE 与 Qoder 单一 credits）。

### 用量统计 / 请求日志
回答「用了多少、每一条花的什么」：趋势图（请求数/Token/耗时/成功率/首字延迟）+ 逐条请求明细。每条记录带通道、模型、token 数、积分消耗（可按通道筛选）。

### 账号管理（搭子网页账号）
**操作台**：增删账号、跑签到/任务/抽奖、开启任务自动轮询、浏览器登录器。

### 登录态 / 各通道账号
千问、TRAE、Qoder 的账号管理：查看 token 有效期、添加/删除账号、指定主账号（千问）、多账号切换。**refresh token 已过期的账号会标橙提示**——access token 到期后无法自动续期，需要重新登录。

### API Key
密钥的创建、白名单/通道绑定配置、用量统计（按通道分开计数）。

### 聊天测试台
不签发密钥直接试调某个模型名能否跑通，返回结构化结果（含实测积分消耗）。**走真实账号池，消耗真实积分**——Qoder 调试请用 0.1 倍率档（`gfmodel` 等，档位差 14 倍）。

---

## 5. 客户端接入

### cc-switch

| 标签 | API 格式 | Base URL | Key | 模型 |
|---|---|---|---|---|
| Claude | `anthropic` | `http://127.0.0.1:9080` ← **不加** `/v1` | `nokey` | `model-text` |
| Codex | `openai_responses` | `http://127.0.0.1:9080/v1` ← **要加** `/v1` | `nokey` | `model-text` |

### Codex CLI（config.toml）

```toml
model_provider = "dumate"

[model_providers.dumate]
name = "DuMate local proxy"
base_url = "http://127.0.0.1:9080/v1"
wire_api = "responses"          # Codex 0.155+ 只认 responses
requires_openai_auth = true
```

### Claude Code

Anthropic 协议接入 `http://127.0.0.1:9080`（裸路径 `/messages` 已支持，不必带 `/v1`）。

### 全部端点

| 端点 | 协议 |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat |
| `POST /v1/responses` 或 `/responses` | OpenAI Responses（Codex） |
| `POST /v1/messages` 或 `/messages` 或 `/api/v1/messages` | Anthropic Messages |
| `POST /v1/messages/count_tokens` | Token 计数（估算） |
| `GET /v1beta/models`、`POST .../generateContent` | Google Generative Language |
| `GET /v1/models` | 模型列表（五通道） |
| `GET /health` | 健康检查（含各通道就绪状态） |

---

## 6. 模型名与路由规则

按模型名**前缀**显式分流，不猜名字：

| 调用方传的模型名 | 路由到 | 说明 |
|---|---|---|
| `model-text` / `glm-5` 等（无前缀） | 百度搭子 | 现有客户端零改动 |
| `qwen/pro` / `qwen/flash` | 千问办公 | 重创作/长任务用 `pro`；`flash` 只适合轻量问答 |
| `traework/…` | TRAE Work | 模型名见管理端模型表 |
| `qoder/gfmodel` 等 | Qoder | 调试用 0.1 倍率档：`qfmodel`/`qmodel`/`q37fmodel`/`dfmodel`/`gfmodel` |
| `workbuddy/glm-5.3` 等 | WorkBuddy | 模型名见管理端模型表（按区域，国内/国际目录不同） |
| 未知前缀（如 `qwn/pro`） | **400 报错** | 不静默回落，防止「看起来成功但不是想要的结果」 |

> 为什么用前缀：搭子有 `glm-5`，千问上游也是 GLM 系，猜错了两侧都返回 200，从响应里根本看不出来。

**选型建议**：长任务/重创作优先搭子 `glm-5`（实测最快最省）或千问 `pro`；轻量问答可用 `flash`。

---

## 7. 日常运维：签到与任务

### 签到

- **手动**：管理端「账号管理」逐账号签到，或「登录态」页按通道签到（TRAE / Qoder / WorkBuddy 国内版）。
- **自动**：设环境变量后每日定时执行（默认 9:17）：
  ```bash
  DUMATE_AUTO_CHECKIN_HOUR=9 DUMATE_AUTO_CHECKIN_MINUTE=17   # 两个都要设
  ```
  签到是**幂等**的（当天已签自动跳过），多跑无害。TRAE 的签到结果会报**到账差值**（前 → 后余额）。

### 任务与抽奖

- 任务可开启**自动轮询**（`DUMATE_TASK_POLL_MINUTES`，默认 30，**低于 5 分钟会被拒绝**——过密轮询无收益只有封号风险）。
- **抽奖只留手动**——消耗次数且不可逆，不进定时任务。

### Qoder 通道特别提醒

**零额度时聊天会挂起**（不报错、不超时），所以**新账号必须先签到领积分**。签到积分 30 天作废，每日 10:00（UTC+8）刷新（千问是 00:00，两者不同）。积分批次到期提醒在管理端可见。

---

## 8. 常见问题排查（FAQ）

### 顶栏搭子通道显示黄色「桌面凭证失效 · 网页凭证回落中」

正常现象：桌面客户端没装或凭证失效，但**网页凭证池可用，请求仍能成功**（自动回落）。只有红点「不可用」才代表两条链路都断了（检查网页账号是否启用）。

### 请求报 502 / 上游连接失败

1. `curl http://127.0.0.1:9080/health` 看各通道 `ready` 状态
2. 搭子通道 `ready=false` 且 `fallback.available=false` → 网页账号也没了，去「账号管理」检查
3. 千问报 402 → 额度真耗尽，去签到或换号
4. 网关进程挂了（端口消失）→ 看「诊断工具」一节

### 千问间歇性 403（`Model is not available for this user`）

上游的**间歇性问题**，同一账号过几分钟自愈，网关会自动换号重试。真正要处理的是 **402**（额度耗尽）和换票失败（refresh token 失效，需重新登录）。

### Codex 输出突然中断 / 空回复

- 多为**输出预算**问题：GLM 的思维链与正文共用 `max_tokens`，网关已自动抬到 65536+。若仍出现，检查客户端是否传了过小的 `max_output_tokens`。
- 若收到 `reasoning_budget_exhausted` 错误，是「思维链失控」（整轮烧在推理上），换更明确的指令（如要求落盘到文件）可绕开。

### TRAE 输出「进度播报」就停

网关已内置检测 + 一次重试修复。若仍出现（判据：模型说「下一步」却不发工具调用），可在日志确认触发记录；重试上限用 `DUMATE_TRAEWORK_REPAIR_RETRY` 调整（`0` 关闭）。

### Qoder 调用无响应

检查额度卡是否为 0（零额度时上游挂起）。先签到；调试用 0.1 倍率模型。

### 管理端页面数据是旧的

后端路由在进程启动时加载，**改配置不会热更新**。重启对应管理端/网关进程。前端 `web/dist` 每次请求读磁盘，纯前端改动构建后即生效。

### 上下文超长报错（400/502）

各通道上下文上限不同（搭子 ~128K、千问 ~1M、TRAE 256K/200K、Qoder 按模型）。超限是**整轮失败**而不是截断，客户端的 context window 声明宁小勿大。TRAE 建议在 cc-switch 里设 `model_context_window = 200000`。

---

## 9. 环境变量参考

常用变量（完整列表见 [CLAUDE.md](../CLAUDE.md)）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DUMATE2API_PORT` / `_HOST` | `9080` / `127.0.0.1` | 网关监听 |
| `DUMATE_REQUIRE_KEY` | 关闭 | 设 `1` 启用 API Key 校验。**对外暴露必须打开** |
| `DUMATE_DUMATE_SOURCE` | `auto` | 设 `web` = 搭子只用网页凭证，不需要装客户端 |
| `DUMATE_WEB_FALLBACK` | 开启 | 设 `0` 关闭「桌面失效回落网页池」 |
| `DUMATE_ADMIN_PORT` / `_GATEWAY_PORT` | `9081` / `9080` | 管理端监听 / 读哪个网关（开发实例设 `9082`） |
| `DUMATE_ADMIN_DATA` | `<repo>/data` | 数据目录，管理端与网关**必须一致** |
| `DUMATE_QWENWORK_AUTOSTART` / `DUMATE_TRAEWORK_AUTOSTART` | `auto` | 设 `off` 关闭对应通道 |
| `DUMATE_QWENWORK_USE_WASM` | 本地签名 | 设 `1` 切回官方 wasm 签名（退路，需装千问客户端） |
| `DUMATE_AUTO_CHECKIN_HOUR` / `_MINUTE` | `9` / `17` | 每日自动签到时刻（**两个都要设**） |
| `DUMATE_TASK_POLL_MINUTES` | `30` | 任务轮询间隔（`0` 关闭，<5 分钟会被拒） |
| `DUMATE_LAG_MONITOR` | 开启 | 事件循环卡顿监控；`DUMATE_LAG_WARN_MS` 默认 2000ms 告警 |
| `DUMATE2API_KEY` | — | **历史遗留死变量，无任何作用**。真实开关是 `DUMATE_REQUIRE_KEY` |

---

## 10. 诊断工具与日志

### 快速探测

```bash
node test/probe-oai.js      # 只打 OpenAI 协议，原始 SSE 打到终端
node test/probe-anth.js     # 只打 Anthropic 协议
node test/verify-ccswitch.js  # Codex / Claude / 裸路径 / 模型映射四条链路
npm test                    # 冒烟测试 32 项（需网关在线）
```

各通道离线自测（不开管理端）：

```bash
node test/traework-login.js login|checkin|chat "你好"
node test/qoder-cli.js login [cn|global] | status | quota | checkin | chat "你好"
```

### 排查 Codex 侧问题

1. **会话日志**：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，每条含完整交互记录
2. **网关埋点**：`data/requests.jsonl`（带通道/模型/token/积分），管理端「请求日志」页可视化
3. **进程存活**：网关崩溃时端口直接消失（表现为「连接被拒」）

### 卡顿诊断

网关带事件循环卡顿监控（卡顿 >2s 打日志）。若进程「转圈无输出、CPU 满」：`node -e "process._debugProcess(<pid>)"` 开 inspector 抓调用栈。

---

## 11. 安全注意事项

| 数据 | 存储位置 | 策略 |
|---|---|---|
| API Key | `data/keys.json` | 存 sha256（校验用）+ 明文（管理员可查看；旧 key 可能无明文） |
| 网页账号 cookie | `data/web-accounts.json` | **明文存**（上游要求原样重放） |
| 直连凭证（千问/TRAE/Qoder/WorkBuddy） | `data/*-accounts.json` | 含 refresh token，**等同密码** |
| 管理员口令 | `data/admin-users.json` + `admin.secret` | scrypt 加密 + 独立签名密钥 |

- `data/` 已在 `.gitignore`，**绝不提交、绝不放进备份镜像**——cookie 与直连凭证被复制走是直接可用的。
- 网关/管理端默认只监听 `127.0.0.1`。**模型端点已强制鉴权**（无合法 key 一律 401）；挂反代对外暴露时仍需了解管理端**没有 TRUST_PROXY 判定**（限流会按代理 IP 统计）。
- 所有凭证与日志只存本机，系统**不上报任何数据**。

---

*本手册与代码同步维护于 dev 分支；发现过时或缺失的内容请提 Issue。*
