# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

把百度搭子（DuMate）桌面客户端内部的本地 OpenAI 兼容端点，转成 **OpenAI / Anthropic / Google 三协议网关**，供 Codex CLI、Claude Code、cc-switch 使用。它同时是一个**进程管理器**——负责无 GUI 拉起 DuMate 的 Go 后端。

仓库里跑着**四个互不代理对方的独立进程**（外加一个自建上游）：

| 进程 | 端口 | 入口 | 职责 |
|---|---|---|---|
| DuMate 后端 | 8980 | `upstream-launcher.js` 拉起 | 真实模型链路 |
| **稳定版网关** | 9080 | **`stable/src/server.js`** | **对外提供的稳定服务**，给 cc-switch / Codex 长期用 |
| 开发网关 | 9082 | `src/server.js` | 开发调试（**所有改动在这里做**） |
| 管理端 | 9083 | `src/admin/server.js` | 管理 API（`/api/admin/*`）+ 托管 `web/dist`，读 9082 |
| 多账号网关 | 9084 | `src/web-gateway.js` | 网页凭证跑模型，多账号轮询 |

> **9080 是生产实例，不是本地调试实例**：它对外持续提供服务，改动或重启会直接影响使用者。
> 除非明确要发布新版，否则**不要改 `stable/` 下的代码、不要重启 9080**。
> 所有开发与验证一律在 9082（界面看 9083）进行。
> 发布新版的唯一途径：主目录验证通过后按**依赖闭包**同步 `stable/src/` + 更新 `SNAPSHOT_FROM.txt`（不要用 `src/*.js` 覆盖——会漏掉子目录、多带管理端，详见 `docs/STABLE-SNAPSHOT.md`）。
> 原来另有一个 9081 管理端，与 9083 功能完全重复，已停用——不再需要它。

> **9080 不一定在运行**：它是按需启动的对外服务，不是常驻开发环境。动手前先 `netstat -ano | grep ":9080"` 确认。若它没在跑而你被要求「发布新版」，正确做法是**只同步快照文件**，不要顺手把它启动起来——启动一个对外服务是用户的决定，不是发布流程的一部分。

**四条上游通道，靠模型名前缀分流**（`src/upstream-router.js`）：

| 调用方传的模型名 | 路由到 |
|---|---|
| `glm-5` / `gpt-4o` 等（无前缀） | DuMate 8980，**现有客户端零改动** |
| `qwen/pro` / `qwen/flash` / `qwen/auto` | 千问办公（`src/qwenwork/` 直连 `gateway.qwenwork.cn`） |
| `traework/glm-5.2` | TRAE Work（`src/traework/` 直连，凭证自持） |
| `qoder/gfmodel` | Qoder（`src/qoder/` 直连，**签名纯本地、不需要客户端**） |
| `dm-auto-model/text.L0` / `auto-l0` 等 | DuMate（router 显式认领该前缀并**全名透传**——档位编码在模型名里，斜杠不是通道分隔符，见下文「搭子的真实模型」节） |
| `qianfan/qwen3.5-35b-a3b` | **千帆原生透传**（`src/qianfan-raw.js`）：与搭子共用网页凭证与额度，但走 `/gateway/v2/chat/completions`。**只有这个端点支持 `response_format`（JSON mode）**；模型名必须是千帆原生名，应用别名（glm-5 等）在这里会 401 |
| 未知前缀（如 `qwn/pro`） | **400 报错，不静默回落** |

**通道 id 的单一来源是 `src/channels.js`**（`dumate` / `qwenwork` / `traework` / `qoder` / `workbuddy`）。
`keys.js`（网关鉴权）、`admin/routes/keys.js`（校验）、`usage.js` / `reqlogs.js`
（筛选参数）四处都 require 同一份——加一条通道只改这一个文件。

**千问与 TRAE 都是直连通道，但彼此也不同**：千问是单账号只读（登录态在客户端
`auth-v2.dat`）、三个积分池；TRAE 是多账号自持凭证、单一 credits + 签到体系。
前端 `isDirectChannel()` 只分「搭子 vs 直连」，页面内部还要用 `isTraework()` /
`isQwenwork()` 再分一次——共用一套模板会把「能不能加账号」「能不能自动续期」
这类问题说反。

### 通道详细文档（按需查阅）

「项目定位」原本在这里堆了 1500 行通道细节，已按主题拆到 `docs/` 下。**改某个通道前先读对应文档**——里面是实测定案与「别再试」清单，不要凭直觉改。

| 主题 | 文档 |
|---|---|
| Qoder：限流排队、积分账本、缓存亲和、倍率账本 | `docs/CHANNEL-QODER.md` |
| TRAE Work：账单/签到、Remote/SOLO/宝、国际版、错误码 | `docs/CHANNEL-TRAEWORK.md` |
| 千问办公：预算、执行纪律、搜索/ACP/barn、客户端解包 | `docs/CHANNEL-QWENWORK.md` |
| WorkBuddy：双区域、风控连坐、签到与网页打卡 | `docs/CHANNEL-WORKBUDDY.md` |
| 跨通道共用：DSML/工具回显修复、播报即收尾、编码性能、埋点 | `docs/CROSS-CHANNEL.md` |
| 国内/国际区域切换（整页切换约定） | `docs/REGION-SWITCH.md` |
| `stable/` 冻结快照与发布流程 | `docs/STABLE-SNAPSHOT.md` |
| 凭证、账号显示名、桌面→网页回落 | `docs/CREDENTIALS-ACCOUNTS.md` |

### 改动前必读的五条

这几条跨所有通道，违反任何一条都会造成静默故障（不报错、返回 200、结果错）。细节见「必须知道的约定与陷阱」与各通道文档：

1. **通道 id 单一来源是 `src/channels.js`**——新增通道只改这一处，`keys.js`、管理端校验、用量筛选都 require 它。
2. **翻译层禁止 `mapModel`**——直连通道的前缀（`qwen/`、`traework/`、`qoder/`、`workbuddy/`）会在映射后丢失并静默落到搭子。
3. **直连通道失败必须让翻译器收尾，不能裸 `res.end()`**——否则 `ERR_STREAM_WRITE_AFTER_END` 直接打挂网关进程。
4. **流式解析必须用 `StringDecoder`**，不能逐块 `toString('utf8')`——跨 chunk 的多字节汉字会变成 U+FFFD。
5. **余额 `null` ≠ 0**——读成 0 会把「查不到」显示成「用完了」，然后被当故障排查。

## 命令

```bash
npm start                  # 启动网关（默认 9080，会自动拉起 DuMate 后端）
npm run admin              # 启动管理端（默认 9081）
npm run mock               # 启动假上游（端口 52890），离线自测用
npm test                   # 跑 test/smoke.js（32 项断言），需先起网关
node test/verify-ccswitch.js   # 端到端验证 Codex / Claude / 裸路径 / 模型映射四条链路
node test/probe-oai.js         # 只打 OpenAI 格式的流式探测，直接看原始 SSE
node test/probe-anth.js        # 只打 Anthropic 格式的流式探测（含 x-api-key / anthropic-version 头）
node src/admin/server.js --reset-admin --password=xxxxxx   # 重设管理员口令
node src/web-gateway.js    # 启动多账号网关（默认 9084）
node test/traework-login.js login|checkin|chat   # TRAE 命令行自测（交互式，见下）
cd web && npm run dev      # 前端开发（Vite 5173，/api 代理到 9081）
cd web && npm run build    # 前端构建（vue-tsc 类型检查 + vite build → web/dist）
```

**`test/traework-login.js` 是不开管理端也能验证 TRAE 通道的入口**：`login` 生成授权链接（粘回调落盘）→ `checkin` 签到并查额度 → `chat "你好"` 发一条对话。凭证由它自己走 OAuth 换取，不依赖 TRAE 客户端。排查「TRAE 到底通不通」时比在界面里点更快。

**`npm test` 只依赖网关**：它直接打 9080，不需要起 mock。先确认 9080 在线（`curl :9080/health`）。

**`npm test` 之外还有两个单点探针**：`test/probe-oai.js` 与 `test/probe-anth.js` 各只打一种协议、把原始 SSE 打到 stdout，用来区分「网关翻译错」还是「上游返回错」——比跑全套 smoke 更快定位。两者都硬编码打 9080。

**这些脚本的端口都写死在 `req()` 里**（smoke / probe-oai / probe-anth 一律打 9080）。要在 9082 上跑同一套断言，临时把 `port: 9080` 换成读环境变量即可——不要改文件本身，那是开发实例与稳定实例共用的。

**开发端口与稳定端口是分开的**：9082/9083 跑主目录代码，9080 跑 `stable/` 快照，互不干扰。开发实例起管理端时**必须带 `DUMATE_ADMIN_GATEWAY_PORT=9082`**，否则管理端会去读 9080（可能没起）而显示空数据——`start-dev.bat` 里设的就是这个变量。

`start.bat` / `stop.bat` / `restart.bat` 是 Windows 生命周期脚本。`stop.bat` 用 `taskkill /T` 杀进程树（后端是网关的子进程），**不动 DuMate GUI 和 cc-switch**，可重复执行；`stop.bat nopause` 供 `restart.bat` 内部调用。

**桌面快捷方式走的是托盘应用，不是 `start-dev.bat`**：`launcher/dumate2api-tray.vbs`
（隐藏启动）→ `launcher/dumate2api-tray.ps1`（PowerShell + WinForms，零第三方依赖）。
提供启动/关闭服务、打开管理端、完全退出；前台窗口滚动显示两个进程的实时日志；
**点关闭按钮只收进托盘、服务继续跑**，退出必须走「完全退出」。托盘右键是同一套功能。

三个实现细节，改之前先读：

1. **`.ps1` 存成 UTF-8 带 BOM**。PowerShell 5.1 读无 BOM 的 `.ps1` 会按 ANSI
   解码，中文全乱码甚至解析失败。这与下文「新建文件用无 BOM」的约定冲突，
   但 PS 5.1 是硬要求——别「顺手修正」掉。（`.vbs` 反过来必须**纯 ASCII**，
   wscript 按 ANSI 读。）
2. **必须显式 `ShowWindow(SW_SHOW)`**。启动器用窗口样式 0 隐藏控制台，而 Windows
   会把 `STARTUPINFO` 的 `SW_HIDE` 应用到该进程的**第一次 ShowWindow**——那一次
   恰好是 WinForms 显示主窗体。不覆盖就会出现「服务起来了、进程活着、窗口永不出现」
   （`MainWindowHandle = 0`）。所以在 `add_Shown` 里再调一次。
3. **日志靠「重定向到文件 + 轮询字节偏移」**（`data/launcher-9082.log` /
   `-9083.log`），不是抓 stdout：两个进程的输出要合并加前缀，在 PowerShell 里
   跨线程改 UI 很容易死锁；落文件还能事后翻。

`start-dev.bat` 保留，仍是无界面 / 需要看原始终端输出时的入口。

**`.bat` 文件必须保持纯 ASCII——中文提示语会让脚本随机执行乱码片段。**
cmd.exe 按**字节偏移**读取批处理文件；在 `chcp 65001`（UTF-8）下多字节字符
会让偏移失步，某一行从错误位置被读出、尾部被当成命令执行。**且非确定性**：
同一个文件、同一条命令，实测 3 次里 1 次失败 2 次成功。真实损害是
`echo  供 cc-switch / Codex / Claude Code 使用` 的残片 `Code 使用` 被当命令执行，
把 `claude` 当可执行文件启动，**凭空派生出游离的 claude.exe 会话**（表现为
多出几个空终端窗口）。

`chcp` 解决不了：代码页必须在文件被解析之前设好，而 `chcp` 那行本身就是被
解析的文件的一部分。所以规则是**文件内容纯 ASCII**，不是「设对代码页」。
脚本里 `chcp 65001` 仍要保留——它让 **node 子进程**的中文日志正常显示，
与脚本自身文本是两回事。新增脚本请照 `start.bat` / `stop.bat` 的写法。

**改完后端代码必须重启对应的管理端/网关进程。** 后端路由在进程启动时 `require` 一次，不会热更新；而 `web/dist` 是每次请求读磁盘。这个不对称会造成「前端看着是新的、接口返回旧数据」的假象——排查时先看进程启动时间（`netstat -ano | grep ":9083"` 找 pid，再查 `StartTime`），不要先怀疑构建。

重启命令（与 `start-dev.bat` 参数一致）：

```bash
# 9083 开发管理端（日常访问的就是它）
DUMATE_ADMIN_PORT=9083 DUMATE_ADMIN_GATEWAY_PORT=9082 node src/admin/server.js
# 9082 开发网关
DUMATE2API_PORT=9082 node src/server.js
```

纯前端改动才需要 `npm run build`；**纯后端改动不必重新构建**。验证新代码生效的办法：比对 9081 与 9083 同一接口的返回是否一致。

另有两个一键脚本：`start-dev.bat`（同时起开发网关 9082 + 管理端 9083）、`start-web-gateway.bat`（起 9084）。

**`node test/verify-channel.js` 是通道过滤的离线验证**：不依赖任何运行中的服务，直接复用管理端路由与 qwenwork 模块读落盘数据，跑 12 项断言（搭子/千问过滤、历史记录归属、积分 req_id 配对）。改完通道相关代码先跑它。

另有两个同样离线的千问专项验证（都不需要起服务）：
`node test/verify-qwen-discipline.js`（执行纪律的注入条件与幂等）、
`node test/verify-truncated-toolcall.js`（工具参数截断判定 + 纯工具调用轮次不误报 incomplete）。
以及 `node --test test/unit/qwen-billing.test.js`（计费自检纯函数：三池差值口径、
负值坏读、每千 token 成本、消耗归属）与 `test/unit/qwen-billing-probe.test.js`
（探针路由编排打桩）。

另有两个 TRAE 专项离线验证（都不需要起服务）：
`node test/verify-traework-gained.js`（签到到账差值计算，含 0/负数/快照缺失三种边界）、
`node test/verify-traework-repair.js`（「播报即收尾」修复：判据、幂等、正文缓冲门语义、
端到端「首轮只播报→重试带工具调用」；打桩 postStream/readStream，不需要账号与网络）。
以及 `node --test test/unit/trae-billing.test.js`（计费自检的纯函数：期望倍率选择、
实测倍率换算、消耗增量归属）。

**「播报即收尾」的四通道验证**（都离线、都打桩 `chat.postStream`/`chat.post`）：
`node --test test/unit/repair-gate.test.js`（共享模块：判据、配置、追加修复指令、
标准 OpenAI chunk 缓冲门 11 项）、`node test/verify-qwen-repair.js`（36 项）、
`node test/verify-qoder-repair.js`（36 项）、`node test/verify-workbuddy-repair.js`
（39 项，2026-11-04）。四者都自带 `DUMATE_POOL_STATE` 临时文件，
但**用例之间仍要 `pool.revive()`**——驱动 402/500 的用例会把账号打进冷却，
后面的用例会先撞「没有可用账号」而测不到目标路径。

另一个搭子专项离线验证（不需要起服务）：
`node test/verify-display-name.js`（账号显示名解析：占位名识别、优先级、空值边界）。

另一个千问专项离线验证（不需要起服务，假上游按账号返回预设余额）：
`node test/verify-qwen-daily-aggregate.js`（每日额度多账号合计口径：分子分母同源、
`/credits` 与 `/accounts` 两处相等、失败账号如实报出、每账号按各自峰值算）。

另一个千问专项离线验证（不需要起服务，拦截 https 层喂预设响应）：
`node test/verify-qwen-wallets-zero.js`（「每日额度被读成 0」的两层纠错：重试恢复、
`account-context` 交叉验证还原真实 daily、真实归零如实上报并标 retried、
免费扣完转付费不误判）。

**Qoder 专项**（都离线，不需要起服务）：

- `node test/verify-qoder-cosy.js`——签名算法，用**参考实现（Go）生成的确定性测试向量**
  逐字节比对（Encode / AES-128-CBC / MD5 / 身份 JSON 的 key 字母序），22 项。
  RSA 只验长度（PKCS#1 v1.5 padding 随机，无法逐字节比对）。
- `node test/verify-qoder-channel.js`——通道逻辑：模型 key 解析、body 构造（模型 key
  同时进 body 与请求头）、工具过滤、执行纪律注入幂等、信封错误解析、SSE 聚合含 credits、
  区域端点与归一化。
- `node test/verify-qoder-grants.js`——积分批次账本：到期时刻推导（RELATIVE_DAYS /
  缺字段 / 领取失败）、幂等（同 grantId 不重复写）、时间窗与账号过滤、正好到期的边界、
  「amount 是领取额不是剩余额」的数据缺口。
- `node test/verify-qoder-throttle.js`——限流处置：`isThrottle` 识别、`retryAfterSeconds`/
  `waitTime` 取大、classify 分类边界（限流→soft，模型不可用仍是 model）、池不再把 30 秒
  放大成 30 分钟、重试时刻到点即恢复、403 限流换号、全部限流时下游 429、
  排队挂起用 5 秒短冷却、账号轮完一遍后等冷却重试同一账号。
- `node test/verify-qoder-read-idle.js`——读空闲与「无内容」两个计时器（10 项，见 `docs/CHANNEL-QODER.md`）。
- `node test/verify-qoder-error-surface.js`——上游失败必须报错而不是静默空回答。
  **自带临时池文件**（`DUMATE_POOL_STATE`）：它会造 429/5xx 惩罚态，写真实池会让
  后续用例选不到账号。

**`node test/qoder-cli.js` 是不开管理端也能验证 Qoder 通道的入口**（与 `traework-login.js` 同定位）：
`login [cn|global]` 生成授权链接 → `status` → `models`（带倍率排序）→ `quota` →
`checkin`（领积分）→ `chat "你好" [model]`（**默认用最省的 gfmodel**）→ `remove <id>`。
排查「Qoder 到底通不通」时比在界面里点更快。

离线自测的完整流程（无需安装 DuMate）：两个终端分别跑 `npm start` → `npm test`。

## 架构

依赖方向单向、无循环：

```
server.js ──→ discovery.js ──→ upstream-launcher.js
    ├──────→ anthropic.js ──→ budget.js
    ├──────→ google.js ─────→ budget.js
    ├──────→ responses.js ──→ budget.js + anthropic.js(modelmap)
    ├──────→ reqlog.js / modelmap.js / keys.js
    ├──────→ upstream-router.js ──→ channels.js（通道 id 单一来源）
    │                    ├──→ qwenwork/（直连，进程内）
    │                    └──→ traework/（直连，自持凭证）
    └──────→ fallback-web.js ──→ web-pool.js ──→ accounts.js
                              （桌面凭证不可用时把网页池包装成伪上游响应）
```

**`fallback-web.js` 是「伪上游」而不是第二条链路**：它把网页凭证池包装成带 `statusCode`/`headers` 的 EventEmitter，四个协议处理器原样复用——**不要为它重写翻译层**，那三套 SSE 状态机是踩了十几个坑才稳定的。

**`web-pool.js` 是 9084 与回落机制共用的账号池**，所以它同时被 `web-gateway.js`（独立进程）和 `fallback-web.js`（9080 进程内）依赖。改动它等于同时影响两个入口。

数据流：

```
Codex CLI ── OpenAI/Responses ──┐
Claude Code ── Anthropic ───────┼──→ 网关 :9080 ──→ dumate-main-server :8980 ──→ 百度千帆
任意客户端 ── Google ───────────┘
```

### 网关路由（`src/server.js`）

按 `url`（去 query）精确匹配，未命中返回 404：

| 路径 | 处理方式 |
|---|---|
| `/health` `/ping` | 内联，返回 `{upstream_port, upstream_managed}` |
| `GET /v1/models` | 从 `modelmap.load()` 读 `exposed`，`owned_by` 区分上游真实模型（`dumate`）与别名（`dumate-proxy`） |
| `POST /v1/chat/completions` | **最小干预透传**：只改 `model` 和 `max_tokens`，响应不重打包 |
| `POST /v1/images/generations` | 搭子生图（`src/media.js`）：标准 OpenAI 形状 → 上游异步提交 + 轮询；凭证走网页池 |
| `POST /v1/audio/speech` | 搭子 TTS（`t2a_v2/sync`）：回二进制音频，不回转链接 |
| `POST /v1/search/web` | 千问联网搜索（`src/qwenwork/search.js`）：`{query, allowed_domains?, blocked_domains?}` → `{items:[{title,link,snippet,publishedTime,hostname}]}`。**通道专属**，不占用 `/v1/images/*`（那是搭子的生图） |
| `POST /v1/search/images` | 千问图搜：`{query, count 1~10}` → `{items:[{imageUrl,...}]}` |
| `POST /v1/files/upload` | 千问 barn 附件上传：`{name, content_base64, mime_type?}` → `{path, file_uuid, reference_note?}`。file_uuid 由 ACP 会话下发，当前 HTTP 链路拿不到时如实 null |
| `POST /v1/voice/polish` | 千问语音润色（`{text}` → `{text}`）：把 ASR 转写润色成可直接发送的话。**真机 401（端点疑似按账号/灰度开放）**，协议取证自解包（纯 Bearer、`<transcription>` 包裹、响应十个文本候选位），上游开放即用 |
| `POST /v1/responses` 或 `/responses` | 全量翻译（Responses ↔ Chat），Codex CLI 0.155+ 只认 `wire_api="responses"` |
| `POST /v1/messages` 或 `/messages` 或 `/api/v1/messages` | 全量翻译 Anthropic ↔ OpenAI |
| `POST .../count_tokens` | `字符数/4` 估算（`String.length`，汉字与 ASCII 同等计 1），仅供客户端算上下文预算 |
| `GET/POST /v1beta/models/...` | Google Generative Language 翻译 |

**裸路径 `/messages` 必须保留**：Claude Code 打的是不带 `/v1` 的路径，只认带前缀的版本会直接 404。

### 协议翻译层

- `src/anthropic.js` — Anthropic ↔ OpenAI 双向，含 SSE 状态机
- `src/responses.js` — OpenAI Responses API ↔ Chat Completions（Codex CLI）
- `src/google.js` — Google Generative Language ↔ OpenAI
- `src/budget.js` — 输出预算策略，**三个入口共用同一个 `resolveMaxTokens`**

**四条通道都支持原生 function calling**（2026-10-31 实测推翻旧结论）。搭子
`glm-5` + tools 在应用链路 `/gateway/apis/v1/chat/completions` 上非流式返回
`tool_calls`、流式返回完整 `delta.tool_calls`（`id`/`name`/`arguments`）与
`finish_reason:"tool_calls"`——所以 Anthropic 入口**一律** `nativeTools: true`，
工具调用转成结构化 `tool_use` 块交给 Claude Code。旧实现把搭子当「上游不支持
function calling」而降级成 `[Tool Use: 名字]` 文本，那是历史能力误判，不是上游边界。

**唯一保留文本降级的入口是 9084 多账号网关**（`src/web-gateway.js`）：它的流式
翻译器只发 text/thinking 块、没有 `tool_use`，开 native 会让工具调用在流式路径上
被丢掉。补完那个翻译器之前不要改它。

**图像同样全入口保真**：2026-10-31 真机实证上游认 OpenAI 标准 `image_url` part
（data URI，网页凭证与桌面链路一致、能正确识别图像内容），四个翻译入口全部保真
透传，`flattenImageParts` 压回已删除（见下文「搭子的真实模型」节）。

**usage 的缓存命中要在协议出口换算，不能只搬 input/output**（2026-10-31 修）。
OpenAI 的 `prompt_tokens` **含**缓存，Anthropic 的 `input_tokens` **不含**
（缓存单独报 `cache_read_input_tokens`），Gemini 的 `promptTokenCount` 含、
另列 `cachedContentTokenCount` 子集。取值统一走 `usage-norm.cachedTokensOf`
（认标准位 / DeepSeek / Qwen / Anthropic 四种形状）。此前 Anthropic 与 Google
两个出口漏了这一步：Claude Code 既把缓存算进上下文、又看不到命中。
真机复核（`glm-5`，同一段长 system 连发两次）：首次 `input 3017 / cache 0`，
第二次 `input 201 / cache 2816`，201+2816=3017。

## 搭子的真实模型、自动档与上限（2026-10-31 深度逆向定案）

搭子云网关本质是**按模型转发到四家上游的调度器**，客户端的 `glm-5` 只是逻辑
别名。全部结论经真机实测（网页凭证直打 + 装回的桌面客户端 Gateway.log +
安装包解包静态分析），推翻了三个旧认知：上游不止 3 个模型、max_tokens 范围
不是全局 131072、上游支持图像输入。

**真实模型与各家上限**（`X-Dumate-Gw-Realmodel` 响应头 + 400 错误体泄漏——
错误体会原样透传上游声明，是免费的协议情报来源）：

| 调用名 | 真实模型 | 上游端点 | max_tokens | 输入上限 |
|---|---|---|---|---|
| `model-text` / `dm-auto-model/text.L0` | deepseek-v4.1-flash-low-latency | qianfan.baidubce.com/v2 | [1, 393216] | **1,048,576**（错误体明示） |
| `glm-5` | glm-5.2 | tp.sdns.baidu.com/api/paas/v4 | [1, 131072] | ≈1,048,576（二分夹逼，错误只说「Prompt 超长」） |
| `dm-auto-model/text.L1` | kimi-k3 | 未泄漏（没报过错） | ≥2,000,000（实测） | ≥1M（未探顶） |
| `dm-auto-model/text.L2` | qwen3.8-max | cn-beijing.maas.aliyuncs.com（阿里百炼） | [1, 131072] | **983,616**（错误体明示） |

**自动三档**：`dm-auto-model/text.L0/L1/L2`（客户端 UI 档 standard/turbo/ultra），
**模型名即档位，不需要任何请求头**——`X-Dumate-AutoModel-Level` /
`-Target` / `X-Dumate-Model-Target` 三个头只是客户端运行态信息（OpenCode
运行时 `dumate-opencode.exe` 构造，ID 生成式 `dm-auto-model/{text|mm}.{L0|L1|L2}`），
网关接受但不改变路由。**接入三件套**：`data/model-map.json` 登记自映射 +
免斜杠别名 `auto-l0/l1/l2`（mtime 热加载）；`upstream-router.js` 的 `resolve()`
显式认领 `dm-auto-model` 前缀并**全名透传**（模型名里的 `/` 会被通道前缀路由
误判成 `unknown_channel`——任何带斜杠的新搭子模型名都要在 router 里显式认领，
单测在 `test/unit/router-auto-model.test.js`）；`modelmap.js` 的 `MODEL_NAMES`
带真实后端标注。`mm` 命名空间（`model-mm` / `dm-auto-model/mm.*`）在本账号
路由到 deepseek 低延迟——**视觉由文本模型直接承担**，Kimi-K2.6 只是客户端
显示映射（二进制 gT0 表），别照抄。

**图像输入已支持**（推翻「上游不支持图像」）：上游认 OpenAI 标准 `image_url`
part（data URI），网页凭证与桌面链路一致且能正确识别内容。翻译层全入口保真
（含 anthropic 搭子分支），压回逻辑已删。测试图别用 8x8 退化尺寸（撞千帆
internal_error）。**原生工具调用也已支持**（2026-10-31 实测，推翻旧结论）：
Anthropic 入口一律 `nativeTools: true`，细节与 9084 的例外见上文「协议翻译层」节。

**第二条端点：千帆原生透传 `/gateway/v2/chat/completions`**（2026-10-31 实测）。
与应用链路 `/gateway/apis/v1/chat/completions` 的能力边界不同：

| 端点 | 原生 tools | JSON mode | 视觉 | 模型名 |
|---|---|---|---|---|
| `apis/v1`（应用链路） | 支持 | 400 | 支持 | 应用别名（`glm-5`、`model-text` 等） |
| `v2`（千帆原生） | 支持 | 支持 | 支持 | 千帆原生模型（如 `qwen3.5-35b-a3b`）；应用别名 401 |

两者都带 `Authorization: Bearer <app token>`；`v2` 另需 `X-Appbuilder-From: openclaw`。
app token 来自 `GET https://www.dumate.cn/api/dumate/app/token/get`（带网页 cookie），
与现有网页凭证池同一份。

**v2 端点已接入为 `qianfan/` 前缀**（`src/qianfan-raw.js`，2026-10-31）：它按
provider 接口（`send`）挂进 `handleDirectChannel`，所以四个协议入口（OpenAI /
Responses / Anthropic / Google）都能用，流式/非流式/工具调用全部透传。
三个设计约束别改：

- **通道归属仍是 `dumate`**（同一份凭证、同一份额度、同一套冷却），不是第五个通道；
- **不做预算钳制**（`needsBudget: false`）——透传语义是「调用方给什么发什么」；
- **模型名必须显式**：应用别名在这个端点上回 401 `invalid_model`。`/v1/models`
  只列实测可用的 `qwen3.5-35b-a3b`（上游没有模型列表接口，`/gateway/v2/models`
  回 404），其它名字原样透传由上游报错。

**工具类网关 `/gateway/v2/tools/dumate/*` 用同一份凭证**（2026-10-31 实测）：生图 `image_generate_v3/async`（提交 POST + 查询 GET `?task_id=`）、TTS
`t2a_v2/sync`、视频 `video_generate/async`、BOS 上传
`appbuilder.baidu.com/v2/tools/bos/upload`。**生图 / TTS / 视频已暴露成网关端点**
（`src/media.js` + `POST /v1/images/generations` / `POST /v1/audio/speech` / `POST /v1/videos/generations`）：

- 凭证复用 `web-pool`（同一套选号/冷却/熔断），不要另建 token 缓存。
- 生图是**异步任务**：提交拿 `task_id` → 同路径 GET 轮询到 `imageUrls`。
  默认 `dumate-image2.2`（v3 端点），另有 2.1 / 1.2 / 0.1 三套端点。
- TTS 走 minimax `t2a_v2/sync`，`output_format=url` 拿链接后**下载成字节**
  再回给客户端（OpenAI 的 speech 语义是二进制，不是链接）。
- 视频生成已接入文生视频最小版（2026-11-01）：`POST /v1/videos/generations`，
  模型 `dumate-video2.9`/`3.0`，实测提交到出片 ~20s。请求形状经**探测循环**定案
  （`model_parameters` 必填、`prompt` 顶层与内层双写——哪处被上游消费未实测，
  同值无害）；终态判据 `task_status:"succeed"` + `task_result.videos[].url`。
  轮询超时回 504 + taskId（任务在上游继续）。分镜/首尾帧/对白
  （`video_elements/async`）未做，见 `docs/FUSION-BACKLOG-2026-10-31.md` §13。

**搭子计费自检探针（2026-11-01，`GET /api/admin/dumate/billing-check?model=`）**：
小请求 + **网页余额前后差**（与 chatlab 同一份 `costOf` 实现，从 chatlab 导出
复用——第二份余额口径必然漂移），报实测「每千 token 积分成本」。搭子**没有
标称倍率**（上游不吐 price_factor，连模型列表接口都没有），`expected` 恒 null
不是缺失是如实；四态 verdict 在 `src/dumate-billing.js`（`negative`=结算异常
如实标注、`zero`=低于余额精度不是没花钱、`unmeasured`=并发混入不补 0）。
真机首批：model-text ≈3.73 积分/千token。模型页「模型信息」卡有按钮。

**实测倍率落缓存并显示在倍率列（2026-11-01，用户明确要求）**：探针成功后写
`data/dumate-rate-cache.json`（`DUMATE_DUMATE_RATE_FILE` 可覆盖，7 天 TTL、
原子写），`model-info.dumateRows` 按 **target** 读缓存填 `rate`
（`rateSource:'measured'`，单位**积分/千token**——与 TRAE/Qoder 的 price_factor
不同单位，前端对搭子行不显示「×」后缀防止跨通道比大小）。过期如实回落「—」
——过期数字比缺失更害人。真机五档（2026-11-01）：L2 2.67 / model-text 3.51 /
L0 3.59 / glm-5 6.55 / L1 7.97 积分每千 token（综合输入+输出，余额两位小数
限制精度；未实测的 model-artifact-validate 仍显示「未实测」）。

**搭子的只读查询接口在 `www.dumate.cn`，不是模型网关**（2026-10-31 实测定案，
`src/dumate-web-api.js` + `src/admin/routes/dumate.js`）。清单里记的
`/api/dumate/session/list` 等路径打在 `dumate-svc.baidu.com` 上**一律 nginx 404**
——它们是网页端接口，鉴权是**网页 cookie**（与 web-pool 同一份凭证），
不是 Bearer app token。真机结果：会话列表 9 条、connector 模板 **50 个**、
projects 与已装 connector 均为 0（空列表是真实结果）。

三个细节，改之前先看：

1. **`session/detail` 的参数名是 `sessionID` / `sessionId`**，传 `id` 回
   `{"code":400,"message":"参数错误:SessionID"}` 且 **HTTP 仍是 200**——
   不读 `code`/`success` 就会把「参数错」当成「会话不存在」。统一判据在
   `apiError()`：`code !== 0` 或 `success === false` 都算失败。
2. **detail 只回元数据，不含消息历史**。消息在本地
   `~/.qianfan/workspace/sessions/<uid>/<date>/<slug>/`，上游没有拉整段对话的
   接口——所以它**不能**给 `previous_response_id` 提供真历史，别指望。
3. **`GET /api/dumate/skills/square/list` 是 404**——清单里「技能广场 101 个」
   这条在网页端不成立（技能是桌面客户端内部资产）。`skillsSquare()` 如实返回
   `unsupported: true` 而不是让调用方猜 URL。

全部**只读**且失败**不喂池**：不打模型、不消耗额度、不改账号状态，读接口的
失败与账号健康无关，罚号只会让对话请求被无辜跳过。

**千问探活 `/algo/api/v1/ping`**（`src/qwenwork/search.js` 的 `ping()`）：
真机 164ms 回纯文本 `pong`，**带不带 COSY 签名都 200**（裸 Bearer 即可）。
价值是区分「凭证被整体拒（401/403）」与「额度耗尽（对话 402 但探活仍 200）」
——处置完全不同（换号 vs 等重置）。

**千问区域端点发现没做成（缺证据，别翻出来重试）**：
`/api/v3/service/region/endpoints` 与 `/algo/api/v5/service/region/endpoints`
实测都 **404**。客户端代码显示 v5 需要
`withBearerToken().withMachineIdentity().withResponseDecryption()`——**机器身份
与响应解密**我们都没有（device flow 账号不带机器身份）。v3 只需 wasm 签名但
仍 404（可能按 region/灰度路由）。按纪律不猜 header。

**按模型 max_tokens 钳制**（`src/dumate-caps.js`）：静态实测表 + 自学习（撞
400 时从错误体解析各家范围声明，7 天 TTL 落 `data/dumate-caps.json`），
`budget.resolveMaxTokens(requested, cap)` 接入，四个协议入口都带映射后模型名；
学习钩子挂在 web-pool 的 400 路径。cap 低于 floor 时上游范围优先。

**real_model 埋点**：web-pool 在响应头到达时捕获 `X-Dumate-Gw-Realmodel` 写进
请求日志——上游静默改路由从此可见。桌面链路拿不到该头，如实留空。

**桌面客户端链路备忘**（2026-10-31 装回 `D:/dsh-data/apps/DuMate`）：桌面后端
就是 OpenAI 体**原样转发** + 身份头（真实 uid 的 `X-Dumate-Account-Id`、设备
指纹 `X-Dumate-Device-Id`、AB 位 `X-Dumate-Abexpids`）；调用方传的档位头被
原样中继；本地代理端口**动态分配**（本轮实测 52806 而非 8980），必须走
discovery；鉴权固定 `Bearer nokey`。排障第一入口是
`%APPDATA%/qianfan-desktop-app/log/desktop-main/Gateway.log`（记录完整上游
请求/响应头与 body 摘要）。

## 必须知道的约定与陷阱

**输出预算下限是硬需求，不是可选优化。** GLM 的思维链（`reasoning_content`）和正文**共用同一个 `max_tokens`**，且 reasoning 长度实测在 57~8492 tokens 之间浮动。Claude Code 默认传 150/1024 这类小值，不兜底就会拿到空正文或半句截断（客户端表现为「能快就停」）。`src/budget.js` 把预算钳到 `[DUMATE_MIN_MAX_TOKENS, DUMATE_MAX_MAX_TOKENS]`，默认下限 **65536**（原为 32768，2026-09-26 上调）。

**下限取 65536 的依据是「思维链失控」实测**：Codex 写小说时（一次 3 章 + 完整项目上下文），模型会在 reasoning 里做「全景回顾」——逐条罗列全部素材，停不下来。该轮零工具调用、零正文输出，`output` 恰好撞满上限：
- 预算 32768 → `output=32768 / reasoning=32768 / 正文 0`，耗时 7.5 分钟，整轮空转
- 实测 reasoning 峰值约 28743（占 32768 的 88%）→ 65536 下降到 44%，留出余量

~~上游搭子自身接受 `[1, 131072]`~~（**2026-10-31 推翻**：那是 glm-5/GLM 系一家的约束，不是全局的——云网关按模型转发，各家范围不同，见下文「搭子的真实模型」节与 `src/dumate-caps.js`）。**32768 从来不是上游限制，是本地默认值**。

**「思维链失控」必须报错而不是 incomplete**（`src/responses.js` 收尾处）。Codex 收到 `status: "incomplete"` 会当成正常收尾（会话日志里 `model_needs_follow_up=false`），前端不提示，用户只看到界面卡回初始态——静默失败，最难排查。现在这种情形发 `response.failed` + `error.code = "reasoning_budget_exhausted"`，客户端会明确报错，埋点也带上 `error` 字段。

**提示词形状会改变是否触发**：若明确要求「落盘到文件」，模型直接调 `exec_command` 写文件，工具调用打断 reasoning，反而不触发；越接近「你想清楚再动手」的指令越容易撞上。

**配置读盘按 mtime 失效，不需要重启网关。** `src/modelmap.js` 和 `src/keys.js` 都落在 `data/` 下，网关与管理端是两个进程，所以两者都在每次调用时比对 mtime 重读。改完模型映射或 API key 立即生效——如果加了启动时读一次的缓存，管理端改完必须重启网关，界面无法解释。

**写盘一律原子。** `store.js` 的 `writeJSON` / `keys.js` 的 `save` / `modelmap.js` 的 `save` 都是先写 `.tmp` 再 `rename`。直接 `writeFileSync` 中途被 kill 会留下半个 JSON，用户表/配置全丢。

**SSE 事件顺序被实测修正过，不要改回去。** Anthropic 规范要求 `message_delta` 在 `content_block_stop` **之后**。早期版本收到 `finish_reason` 就立刻发 `message_delta`，顺序违规。现在只记录 `lastFinishReason`，等流结束统一补发——既修正顺序也保证只发一次。同理 `usage` 只从 `message_delta` 取：`message_start` 里也有一个全 0 的 usage 占位，正则取第一个匹配会误判成 0。

**Responses 路径的 output item 顺序也是硬要求（踩过）。** `reasoning` 与 `function_call` 是并列 item，reasoning 的 `output_item.done` **必须在 function_call 的 `arguments.delta` 之前发出**。原实现只在正文出现时关 reasoning，纯工具调用场景（reasoning 之后直接出工具、没有正文）会把 reasoning 的 done 拖到流末尾——Codex 收到那个 done 后以为 item 已结束，紧接着又收到 `arguments.done`，报 `failed to parse function arguments: trailing characters`，**工具调用直接失败**。修法：开 function_call 前先 `closeReasoningLater()`（`src/responses.js`）。

**流式解析必须用 `StringDecoder`，不能逐块 `toString('utf8')`。** TCP chunk 不按字符边界切，逐块解码会让跨 chunk 的多字节汉字变成 U+FFFD（流式输出里随机出现「�」）。四个解析点都要用：`src/qwenwork/chat.js`（流式 + 非流式）、`src/google.js`、`src/responses.js`、`src/server.js`。

**响应写完后必须停手，否则打挂进程。** `send()` 直接 `res.write()` 时，若 `res.end()` 之后还有收尾逻辑补发事件（如 reasoning 的 done），会触发 `ERR_STREAM_WRITE_AFTER_END`——这是**未捕获的 error 事件，会直接让网关进程退出**（9082 整个挂掉，不是单个请求失败）。修法：`send()` 带 `ended` / `res.writableEnded` / `res.destroyed` 守卫，两处 `res.end()` 都标记 `ended`。

**直连通道失败时必须让翻译器收尾，不能裸 `res.end()`（2026-10-03 修，崩溃级）。**
`handleDirectChannel` 的 catch 原来无条件 `shim.end()` + `res.end()`，有两处后果，
且**三个直连通道（千问/TRAE/Qoder）全部中招**——实测触发它的是千问额度耗尽（402）：

1. 翻译器的 `upstreamRes.on('end')` 是**异步**触发的，在 catch 同步 `res.end()` 之后
   才跑，于是 `sendEvent` 调 `res.write()` 抛 `ERR_STREAM_WRITE_AFTER_END`。
   流式 res 的 `'error'` 事件**没有监听者** → 未捕获异常 → **网关进程直接退出**。
   实测：9082 于 23:51 退出、00:03 才重启，期间 cc-switch 连报 8 次
   「502 上游连接失败」；对旧代码跑 `test/verify-stream-error-termination.js`
   可稳定复现该崩溃。
2. 翻译器想补发的终结事件（`response.completed` / `message_stop`）因 res 已结束
   被丢弃 → Codex 报 `stream disconnected before completion: stream closed before
   response.completed`，用户看到「思考很久然后失败」，且那一轮记成 0 token
   （因为没收到任何 item）。

**关键认知：翻译器一进入就 `writeHead(200)` 并写 `response.created`，所以
`res.headersSent` 恒为 true**——「首帧前失败就回 4xx JSON」那条分支对翻译器路径
**永远不会走到**（只对 OpenAI 路径有效，它才延迟发头）。

修法（按路径分三种，不要合并成一种）：
- **有翻译器 + 已发头** → `shim.emit('error', e)`，让翻译器发它自己的失败终结事件
  （Responses 的 `response.failed`、Anthropic 的 `message_delta`+`message_stop`、
  Google 的裸关流）。**必须先补一个空 `error` 监听兜底**——翻译器若没有
  `'error'` 监听者，Node 会抛未捕获异常打挂进程（与上面第 1 条同一机制）。
- **无翻译器（OpenAI 路径）+ 已发头** → 写 `data: {"error":...}` + `data: [DONE]` 再关流。
  不写就是裸关闭，客户端只能报「响应未完成」。
- **未发头** → 回正经的 4xx JSON（只有 OpenAI 路径会走到）。

离线验证：`node test/verify-stream-error-termination.js`（11 项）。支持
`FAKE_QODER_MODE=post|pre` 两种错误形态——`post` 是「先吐一帧再报错」（与
`err.sent` 同形），`pre` 是「一帧都不吐就报错」（模拟额度耗尽）。

**失败原因必须一路传到客户端，不能在中途被抹成一句通用文案（2026-10-27 修）。**
两个翻译器各自丢过一次，症状都是「用户只知道失败了，不知道为什么」：

- `translateStreamToResponses`（Codex）原来硬编码
  `error: { code: 'upstream_error', message: 'upstream stream error' }` 且 `finish(502)`。
  改成一透传 `e.message`、状态码透传（`429` → `code: 'rate_limit_exceeded'`，
  其余 `server_error`）。否则排队限流、额度耗尽、凭证失效在 Codex 里长得一模一样。
- `translateStreamToAnthropic`（Claude Code）在**一个内容块都没发出去**时，
  原来收成「正常但空」的 `message_delta` + `message_stop`（0 token）。Claude Code
  会把它当成一次合法的空回合，**不重试**，用户看到的是「模型什么都不回答」。
  现在改发 Anthropic SSE 的 `event: error`
  （`{type:'error', error:{type: anthErrorType(status, message), message}}`）：
  429/529/排队挂起 → `rate_limit_error` / `overloaded_error`（客户端会退避重试），
  401/403/400 各按自己的类型。**已经吐过内容时不走这条**——协议上收不回去，
  只能按 `message_delta` + `message_stop` 正常收尾。

离线验证：`node test/unit/stream-error-surface.test.js`（3 项，锁定 Responses
那条的真实 message 与状态码）。Anthropic 那条是 `server.js` 内的脚本函数、
不可 require，靠实机验证（喂一个不存在的模型名，应看到 `event: error` +
真实 message）。

**上游转发只回调一次。** `forwardToUpstream` 用 `settled` 标志 + `once()` 包装；`collectAndFinish` 把 `end`/`aborted`/`error` 三路收拢到同一入口。上游 socket 出错时 Node 会同时触发 error 与后续事件，重复回调会让响应被写两次、客户端永久挂在半开的流上（表现为「输出突然停止」）。

**模型名兜底是唯一可行的容错，也是最容易静默吞模型的闸。** 上游接受的模型名远不止三个（`dm-auto-model/text.L0/L1/L2` 三档已登记，见下文「搭子的真实模型」节），但 `mapModel` 查不到一律回落 `fallback`（默认 `model-text`）——**任何新模型名必须显式登记进 `data/model-map.json` 的 `aliases`，否则被静默兜底且响应 200 无从察觉**。改 `fallback` 会影响全部未知模型名。注意它与 router 的 `unknown_channel` 是两道不同的闸：router 拦「带斜杠的未知前缀」，mapModel 兜「无前缀/已认领前缀的未知名字」。

**`DUMATE2API_KEY` 与 `DUMATE_REQUIRE_KEY` 的现状（2026-11-01）**：`DUMATE2API_KEY` 已接线（命中 env 密钥或任一登记 key 即放行）；`DUMATE_REQUIRE_KEY` 则**因鉴权强制而废除**——「不鉴权」形态已删除，模型端点一律要求 key，设 0/1 都不改变行为（显式设 0 时启动日志告警）。`stable/` 旧快照仍认 `DUMATE_REQUIRE_KEY=1`，所以启动脚本里的设置保留（对新主分支代码无害）。

**`model_allowlist` 只在配了白名单时才读请求体。** 网关鉴权段先判断 `key.model_allowlist` 非空才预读 body 取 `model`——否则给默认路径凭空加一次完整读取。结果存 `req._rawBody`，`readBody` 直接复用，**流只能读一次，重复读会拿到空串**。Google 路径的模型名在 URL 里，走正则从路径提取。

**引用代码位置时不要写行号。** 本文件历史上写过 `src/server.js:14` / `:709` 这类行号，改动几次后全部失效——后来者照着行号去看会读到无关代码。写函数名或常量名（`API_KEY`、`model_allowlist`），它们靠 grep 就能定位且不会漂移。

**请求埋点失败必须吞掉。** `reqlog.record` 是同步写 JSONL，出错只报一次然后自禁用——埋点绝不能影响正在转发的响应。`logRequest` 用 `res._logged` 去重，因为流式路径会同时挂 `end`/`error`/`aborted` 三个收尾点。

**`req_id` 是埋点与异步采集的唯一关联键。** `logRequest` 生成（或复用 `req._reqId`），写进埋点；千问的积分归因也带同一个值。归因要等 1.5s 结算，`ts` 必然晚于埋点——靠时间戳配对会让同一秒内的两条请求互相串账。`handleDirectChannel` 在进入时就把 `req_id` 定下来并传给 provider，就是这个原因。请求日志按 `indexByReqId()` 把积分明细附到行上。

**流式请求必须显式要 usage 帧，且注入点必须在 `target.direct` 之后。** 云端网关 `dumate-svc.baidu.com` 只在 body 带 `stream_options: {include_usage: true}` 时才在流尾补一个 `choices: []` + `usage` 的块；8980 桌面后端默认就发。所以漏注入的症状是「请求全部 200、token 全记 0」，且**只在网页凭证链路上暴露**（实测网页凭证 `/v1/responses` 流式 134/134 条 output_tokens 为 0）。四个协议入口（`handleOpenAIChat` / `handleOpenAIResponses` / `handleGoogleGenerateContent` / `handleAnthropicMessages`）都要注入，一个都不能省。位置要求：**必须放在 `if (target.direct) return ...` 之后**——千问/TRAE/Qoder 的 `buildBody` 不认识这个字段，提前注入等于给它塞脏数据。

**`first_token_ms` 由 `reqlog.markFirstToken` 统一实现，四个协议入口都要调。** 它原先私有在 `server.js` 里，只有透传分支和直连通道调得到，三个翻译器（`translateStreamToResponses` / `translateStreamToAnthropic` / `translateStreamToGoogle`）拿不到——于是 `/v1/responses` 与 `/v1/messages` 的流式请求一条首字都记不下来（实测 dumate `/v1/responses` 1295 条全为 null，而直连通道 1987/1987 正常；这是长期缺口，与凭证来源无关）。现在函数归 `reqlog` 导出，三个翻译器在 `upstreamRes.on('data')` 的第一行调用它。**口径是「上游第一个字节到达」，不是「我们写出第一个 SSE 事件」**——后者会把翻译器自己造的事件（如 Responses 的 `response.created`）也算进去，量出来的只是本地耗时。

**千问（直连通道）的 OpenAI 路径要自己补埋点。** 翻译器分支各自在 `done` 回调里记，只有 OpenAI 分支没有翻译器——漏了就一条都不记。补埋点时扫 usage 要注意：`provider.send` 回调给的是解信封后的裸 JSON，拼进 `seen` 时必须补上 `data: ` 前缀，否则 `usageFromSSE`（按 `data:` 行扫描）扫不到，token 恒为 0。

**`index.html` 必须 `no-cache`，带 hash 的 chunk 才能长缓存（2026-11-08 踩过）。**
管理端静态托管原来对两类资源一视同仁，什么缓存头都不发——浏览器于是启发式缓存
`index.html`。而它是**入口清单**，里面写死本次构建的 chunk hash；新构建把旧 hash
的 js 删掉后，用户浏览器仍按旧清单请求已不存在的文件，表现为「后端明明加了功能，
界面上一个都没有」，而且普通刷新也不会好（只有 Ctrl+Shift+R 能救）。现在
`sendFile` 按扩展名分流：`.html` → `Cache-Control: no-cache` + 内容 sha1 ETag
（命中回 304，不整包重下）；其余 → `public, max-age=31536000, immutable`。
ETag 用内容哈希而不是 `statSync` 的 mtime：后者在异步回调里阻塞事件循环、文件被外部删掉时还会抛。

**小尺寸 `a-switch` 不渲染 `checked-children` 文字。** 两个 `size="small"` 的开关
上下相邻、外观完全相同时，**DOM 里是两个、人眼里只有一个**——判定「功能没做」会
误判，判定「做了」也是假的。多开关必须把标签写在开关外面（`<label><span>启用</span>
<a-switch/></label>`），并给关闭态一个不同颜色的标签。同理：改完前端别只看接口
返回，要用真实浏览器截图核对可见性（本次两处问题都是接口 200、界面无感）。

**`count_tokens` 是字符数/4，不是字节数/4。** `estimateTokens` 用的是 `String.length`，即 UTF-16 码元数：100 个汉字和 100 个 ASCII 都算出 29 token（实测一致）。中文按真分词约 1 字 1 token，所以这个估算在中文场景下偏小约 4 倍——只够给客户端做上下文预算，不能当计费依据。文档里写「字节数/4」的地方都是错的。

**测试断言校验「形状」而非字面值。** 早期断言写死 mock 的固定返回（"Hello world"、token 11/7），接真上游时一批失败。现在只断言「非空」「大于 0」这类形状，mock 和真上游都能过。新增断言请沿用这个原则。

**出站提示词卫生（2026-10-31，`src/prompt-guard.js`，两项都是默认关闭的选通
开关）**：① 合规词零宽空格脱敏（`DUMATE_DESENSITIZE=1` 开启）——上游关键词
审查会把系统提示词里的敏感词整轮拒掉，在命中词的字符间插 U+200B 让匹配失效
而肉眼不变；词表在 `data/desensitize-words.txt`（一行一词，# 注释），长词优先，
天然幂等；**只动 system，user 消息不碰**。② 超大工具输出截断
（`DUMATE_TOOL_OUTPUT_CAP=<字符数>` 开启）——历史里 role:'tool' 的超限输出
截断并显式标注原始长度（客户端看得见截断发生，不是静默丢失）。两项只对搭子
路径生效（四个协议入口的 needsModelMap 分支）。离线验证：
`node --test test/unit/prompt-guard.test.js`（5 项）。

**2026-10-31 调研缓办清单（每项都有明确的阻塞原因，别翻出来重做）**：
`/algo/api/v3/user/status` 订阅周期端点与「新版推理协议解锁隐藏模型」（两者都
要官方**机器身份** machine_id/machine_token——device flow 账号不带，需真实
指纹；EchoPing07 实现里 userType 是 AES 签进 bearer 的）；~~TRAE 国际版直连的
活验证~~（**2026-11-03 已完成**，见 `docs/CHANNEL-TRAEWORK.md`——全链路真机
验证过，从缓办清单移除）；ASR 语音
转写（搭子要 BOS AK/SK 证据、千问要 WS 协议逆向）；飞书推送（要 webhook
配置与产品设计）；账号级限额护栏（要存储与界面设计）；remote 端点备选链路
（要 Max 账号）；Qoder intl 活动域 center.qoder.sh（要国际账号——添加
Qoder 国际账号走登录弹窗「国际 qoder.sh」）；多时段签到、
per-key 限流（低价值场景）。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `DUMATE2API_PORT` / `DUMATE2API_HOST` | `9080` / `127.0.0.1` | 网关监听 |
| `DUMATE_REQUIRE_KEY` | 已废除 | **鉴权已强制**（2026-11-01），无 key 的模型请求一律 401；设 `0` 不再改变行为，仅启动日志告警。旧快照 `stable/` 仍认 `=1` |
| `DUMATE_ADMIN_PORT` / `DUMATE_ADMIN_HOST` | `9081` / `127.0.0.1` | 管理端监听 |
| `DUMATE_ADMIN_DATA` | `<repo>/data` | 覆盖数据目录（管理端与网关必须一致） |
| `DUMATE_MIN_MAX_TOKENS` / `DUMATE_MAX_MAX_TOKENS` | `65536` / `131072` | 输出预算钳制区间（`0` 关闭下限策略） |
| `DUMATE_AUTOSTART` | `auto` | `auto`=无实例才拉起 / `always`=总是自己拉起 / `off`=只用已有实例 |
| `DUMATE_UPSTREAM_PORT` | `8980` | 自建后端端口 |
| `DUMATE_INSTALL_DIR` | DuMate 默认安装路径 | 安装目录不在默认位置时设置 |
| `DUMATE_UPSTREAM_TIMEOUT_MS` | `600000` | 上游请求超时 |
| `DUMATE_UPSTREAM_LOG` / `DUMATE_DEBUG` | - | 设为 `1` 输出后端日志 / 发现过程调试信息 |
| `DUMATE_ADMIN_GATEWAY_PORT` | `9080` | **管理端去读哪个网关的状态**；开发实例应设为 `9082`，否则会显示稳定版的数字 |
| `DUMATE_WEB_GATEWAY_PORT` / `_HOST` | `9084` / `127.0.0.1` | 多账号网关（网页凭证）监听 |
| `DUMATE_TASK_POLL_MINUTES` | `30` | 任务自动轮询间隔（`0` 关闭）；**低于 5 分钟会被拒绝**——过密轮询无收益只有封号风险 |
| `DUMATE_AUTO_CHECKIN_HOUR` / `_MINUTE` | `9` / `17` | 每日自动签到时刻（**两个都要**，只设 HOUR 不生效） |
| `DUMATE_BROWSER_PATH` | 自动探测 Edge/Chrome | 登录器找不到浏览器时手动指定 |
| `DUMATE_QWENWORK_AUTOSTART` | `auto` | `auto`=启用千问通道 / `off`=关闭（进程内直连，不拉起外部服务） |
| `DUMATE_QWENWORK_USE_WASM` | 未设（本地签名） | 设 `1` 切回官方 wasm 签名（本地签名被上游拒时的退路；需要装千问办公客户端） |
| `DUMATE_QWENWORK_INSTALL` | 自动探测 | 千问办公安装根（**仅 wasm 模式用**；wasm 探测失败时手动指定） |
| `CB_QWENWORK_WASM` | 自动探测 | 直接指定 `qoder_auth_wasm_bg.wasm` 的完整路径（**仅 wasm 模式用**） |
| ~~`DUMATE_QWENWORK_DAILY_CREDITS`~~ | 已停用 | 千问每日免费额度的配置兜底。**2026-11-01 起上游不再发放每日额度**（实测 `daily_credits` 恒 0），整套「观测峰值 + 配置兜底推断上限」已删除，该变量不再被读取 |
| `DUMATE_QWENWORK_MIN_MAX_TOKENS` | `16384` | 千问输出预算下限（与搭子的 `DUMATE_MIN_MAX_TOKENS` 分开） |
| `DUMATE_QWENWORK_DEFAULT_MAX_TOKENS` | `131072` | 千问**默认**输出预算（客户端未给 `max_tokens` 时；搭子用 `DEFAULT_BUDGET=32768`，但会被 FLOOR 抬到 65536——**下限优先于默认值**）。取上游上限，见 `docs/CHANNEL-QWENWORK.md` |
| `DUMATE_QWENWORK_AGENT_DISCIPLINE` | 未设（注入） | 设 `0` 关闭「执行纪律」注入（见 `docs/CHANNEL-QWENWORK.md`） |
| `DUMATE_QWENWORK_CREDIT_CACHE_MS` | `30000` | 千问余额缓存时长，避免每次请求都打站点接口 |
| `DUMATE_QWENWORK_ACCOUNT` | 未设 | 千问指定用哪个账号（填账号 **id**）。优先级：**环境变量 > 账号文件里的 `preferred` 标记 > 池里第一个**。环境变量是临时覆盖（改启动参数不改文件），删号后「第一个」会变，所以只作兜底 |
| `DUMATE_TRAEWORK_AUTOSTART` | `auto` | `auto`=启用 TRAE 通道 / `off`=关闭（与 `DUMATE_QWENWORK_AUTOSTART` 同形） |
| `DUMATE_TRAEWORK_MIN_MAX_TOKENS` | `16384` | TRAE 输出预算下限（三通道各一套，不要互相套用） |
| `DUMATE_TRAEWORK_MODELS_CACHE_MS` | `300000` | TRAE 模型表缓存时长（5 分钟）。模型表只在登录/刷新时变，不必每次打上游 |
| `DUMATE_TRAEWORK_REPAIR_RETRY` | `1` | 「播报即收尾」的重试次数上限。`0` 关闭整个修复（见 `docs/CROSS-CHANNEL.md`） |
| `DUMATE_TRAEWORK_HOLD_CAP` | `600` | 正文缓冲门的阈值（字符）。超过就转直发，避免长回答被扣住等判定 |
| `DUMATE_QWENWORK_REPAIR_RETRY` / `DUMATE_QODER_REPAIR_RETRY` | `1` | 同上，千问与 Qoder 各一套（`src/repair.js` 的 `envCaps`）。互不影响 |
| `DUMATE_QWENWORK_HOLD_CAP` / `DUMATE_QODER_HOLD_CAP` | `600` | 同上，千问与 Qoder 各一套 |
| `DUMATE_WORKBUDDY_REPAIR_RETRY` / `_HOLD_CAP` | `1` / `600` | 同上，WorkBuddy 一套（2026-11-04 接入共享修复） |
| `DUMATE_WORKBUDDY_MIN_MAX_TOKENS` | `16384` | WorkBuddy 输出预算下限（`budget.js` 的 `WB_FLOOR`，reasoning 与正文抢预算） |
| `DUMATE_WORKBUDDY_MODELS_CACHE_MS` | `600000` | WorkBuddy 模型表缓存时长（10 分钟，按区域分缓存） |
| `DUMATE_WORKBUDDY_APP_VERSION` | 未设（按区域兜底 5.5.6 / 5.5.2） | 覆盖客户端版本号（进 `X-IDE-Version` 与 chat UA） |
| `DUMATE_WORKBUDDY_CLI_UA` | `CLI/2.63.2 CodeBuddy/2.63.2` | 模型目录/刷新请求的 UA（上游按它识别 CLI 客户端形态） |
| `DUMATE_QODER_FIRST_BYTE_MS` | `60000` | Qoder 上游**首字节**超时（ms），挡「连响应头都不给」的挂起。`0` 关闭 |
| `DUMATE_QODER_CONTENT_MS` | `90000` | Qoder 上游**无内容**超时（ms）：排队时上游先回一个空 ack 帧再沉默，首字节计时器会被它清掉，只有这个计时器兜底。只在**还没转发过真实内容**时计时，有内容即撤销。**90s 的依据是成功请求首字实测 > 6s 占 14.4%、> 30s 占 7.6%、max 63.9s**——旧的 12s/6s 会把大上下文 prefill 当成排队误杀（详见 `docs/CHANNEL-QODER.md`）。真排队由 10605 信封在 200~680ms 内识别，不走这个计时器。`0` 关闭 |
| `DUMATE_QODER_QUEUE_PATIENCE_MS` | `6000` | 排队重试的**总预算**（ms）。实测推翻了「按上游时长耐心等」的旧结论：排队是请求级随机，等 30 秒也不保证放行，所以改为快速轮询几轮（信封本身 150~1000ms 就到）仍失败就如实回 429。`0` = 拿到限流立刻回 429 |
| `DUMATE_QODER_QUEUE_STEP_MS` | `1500` | 排队轮询间隔（ms）。过长恰恰是用户感知的「慢」（原 3000ms × 5 轮 = 15 秒纯等待） |
| `DUMATE_QODER_READ_IDLE_MS` | `120000` | Qoder 上游**读空闲**超时（ms），每块数据重置，挡「先响应后沉默」的限流排队（见 `docs/CHANNEL-QODER.md`）。**必须大于首字节超时**，否则两计时器抢跑。`0` 关闭 |
| `DUMATE_THROTTLE_MAX_MS` | `600000` | 排队/限流冷却的**上限**（ms，千问与 Qoder 共用）。上游按自己的队列长度给 `waitTime`（实测 7015 秒），照单全收会把账号锁近两小时；封顶后最多等这么久再探一次 |
| `DUMATE_QODER_COSY_VERSION` | `1.1.75` | Qoder 的 cosy 版本（进 payload 与请求头）。默认对齐官方 CLI；上游行为变化时可覆盖回退，不用改代码 |
| `DUMATE_QODER_UA` | `undici` | Qoder 推理请求的 User-Agent（官方 CLI 由 undici 补默认值） |
| `DUMATE_QODER_MACHINE_OS` | 按 Windows/其他取 `x86_64_win32` / `x86_64_linux` | `cosy-machineos` 头的值。`auto` 按当前系统与架构识别，也可直接指定 |
| `DUMATE_QODER_OS_HEADERS` | 未设（发送） | 设 `0` 关闭 `cosy-machineos` / `cosy-machinehostname` 两个身份头（见 `docs/CHANNEL-QODER.md`） |
| `DUMATE_QODER_INTL_GATEWAY` | 未设（候选链） | 钉死国际版推理主机（替代 api3→api2→api1 候选链）。上游服务端「选举」导流端点时用它 |
| `DUMATE_QODER_FEFO_DAYS` | `3` | FEFO 选号的临期窗口（天）：账号有 N 天内到期的积分批次时优先接流量。`0` 关闭 |
| `DUMATE_DUMATE_FEFO_DAYS` / `DUMATE_TRAEWORK_FEFO_DAYS` / `DUMATE_QWENWORK_FEFO_DAYS` / `DUMATE_WORKBUDDY_FEFO_DAYS` | `30` / `7` / `30` / `7` | 各通道的 FEFO 窗口（天），`0` 关闭。数据源是管理端刷新的临期快照 `data/expiring-snapshot.json`（`DUMATE_EXPIRING_SNAPSHOT_TTL_MS` 默认 6 小时陈旧退回普通轮询；`DUMATE_EXPIRING_SNAPSHOT_FILE` 改路径，测试用） |
| `DUMATE_QODER_QUEUE_POLL` | 未设（开启） | 设 `0` 关闭官方排队轮询协议（信封型限流按 `retryAfterSeconds` 睡眠后重发 + queue/status 放行信号），回到纯快速轮询（429 交还客户端） |
| `DUMATE_QODER_QUEUE_POLL_BUDGET_MS` | `60000` | 排队等待的**整次请求**预算（ms，所有账号共享）。耗尽后 throttle 错误按旧路交回（429） |
| `DUMATE_QODER_QUEUE_POLL_INTERVAL_MS` | 按 `retryAfterSeconds`（夹 [5s, 20s]） | 每轮排队等待的睡眠时长。仅供测试注入短间隔，生产别调小——上游明说的等待要尊重 |
| `DUMATE_DUMATE_SOURCE` | 未设（`web`） | 搭子凭证来源。未设 = **只用网页凭证**（桌面链路不参与，跳过启动那次约 3 秒的探测；池子不可用时路由层直接拒绝并说明原因，不静默退回桌面链路）。设 `auto`（别名 `desktop`）= 桌面优先、不可用时回落网页池。**无法识别的值按 `web` 处理并在启动日志告警** |
| `DUMATE_WEB_FALLBACK` | 未设（开启） | 设 `0` 关闭「桌面凭证不可用时回落到网页池」（见 `docs/CREDENTIALS-ACCOUNTS.md`）。关闭后桌面凭证失效即请求全失败 |
| `DUMATE_POINTS_METER` | 未设（开启） | 设 `0` 关闭搭子的余额游标采集（`points-cursor.js`）。关闭后请求日志不再有逐条消耗 |
| `DUMATE_LAG_MONITOR` | 未设（开启） | 设 `0` 关闭事件循环卡顿监控（`startLagMonitor`）。开启时同步代码卡顿超阈值会打日志 |
| `DUMATE_LAG_WARN_MS` | `2000` | 卡顿监控的告警阈值（ms）。低于此值的 GC 停顿与大请求编码不报 |
| `DUMATE_WEB_BASE` | `https://www.dumate.cn` | 搭子网页端基址。只在需要指向测试环境时改 |
| `DUMATE_WEB_TIMEOUT` | `20000` | 搭子网页接口超时（ms）。**注意前端 axios 是 30s**，改大这里会让整页请求先超时 |
| `DUMATE_GATEWAY_HOST` | `dumate-svc.baidu.com` | 网页凭证换模型 token 的目标主机。上游换域名时改这里 |
| `DUMATE_UPSTREAM_CWD` | DuMate 安装根 | 拉起 `dumate-main-server.exe` 时的工作目录。后端读相对路径配置时用得上 |
| `DUMATE_ADMIN_SECURE_COOKIE` | 未设（不置 Secure） | 设 `1` 才给会话 cookie 加 Secure（本地 http 下会被浏览器丢弃） |
| `DUMATE_DESENSITIZE` | 未设（关闭） | 设 `1` 开启系统提示词合规词零宽空格脱敏（词表 `data/desensitize-words.txt`，见 prompt-guard.js） |
| `DUMATE_TOOL_OUTPUT_CAP` | 未设（关闭） | 历史 role:'tool' 输出超过此字符数截断并标注原始长度（0/未设关闭） |
| `DUMATE_TRAEWORK_CONNECT_TIMEOUT_MS` | `10000` | TRAE 基址候选轮转的连接超时（tnc.js 候选链；黑洞主机不占满 600s） |
| `DUMATE_TRAEWORK_REMOTE` | 未设（关闭） | 设 `1` 开启 TRAE Remote 链路（auto 档纯文本；见「TRAE Remote 链路已通」节）。utils_chat 仍是默认主力 |
| `DUMATE_TRAEWORK_SOLO` | 未设（关闭） | 设 `1` 开启 TRAE SOLO/IDE raw 链路（`llm_raw_chat`，显式模型纯文本；原生 tools 槽待证据暂不接）。**纯国内链路**——启用时池层强制国内选号 |
| `DUMATE_TRAEWORK_SESSION_BILLING` | 开启 | TRAE 逐轮精确账单（`get_session_usage` 查单请求扣费 + 缓存计数）异步 enrichment；设 `0` 关闭（退回纯差值口径） |
| `DUMATE_TRAEWORK_REMOTE_MAX_MODE` | 未设（关闭） | 设 `1` 全局开启 remote 1M Max 档（descriptor `max_mode` 硬门仍生效）；`_MAX_MODELS` 白名单（逗号分隔，`*` 全放行）；`_MAX_MODE_TYPE` 默认 `1` |
| `DUMATE_TRAEWORK_9074_RETRY_SECONDS` / `_MAX_BACKOFF_SECONDS` | `60` / `3600` | 签到 9074 自愈的退避基数 / 封顶（换一代设备立即重试一次，仍失败才进退避） |
| `DUMATE_TRAEWORK_REMOTE_CONNECT_MS` / `_FIRST_EVENT_MS` | `15000` / `120000` | Remote 建会话连接超时 / 首模型事件超时（排队与心跳帧不算模型活动） |
| `DUMATE_ALERTS_SCHEDULE_MINUTES` | `0`（关闭） | 运维告警后台规则评估间隔；`0` 只在管理端手动评估时跑。推送仍受 `/keepalive/notify` 的 webhook 配置控制 |
| `DUMATE_METRICS_TOKEN` | 未设 | 设了才要求 `/api/admin/metrics` 带 `Bearer <token>`；未设时沿用管理端会话鉴权 |
| `DUMATE_METRICS_WINDOW_MS` | `86400000` | `/metrics` 默认回看窗口（ms）；端点 `?hours=` 可单次覆盖 |
| `DUMATE_ADMIN_DATA`（TRAE 运行期配置） | `data/traework-runtime.json` | 降级 / Max / 选号策略 / 护栏 / 全站暂停的落盘位置；管理端 `#/trae-runtime` 写入，网关按 mtime 热读，全部默认关闭 |
| `DUMATE_DUMATE_CAPS_FILE` | 未设 | 搭子按模型 max_tokens 上限学习表的落盘路径覆盖（测试用） |
| `DUMATE_MEDIA_POLL_TIMEOUT_MS` | `120000` | 生图异步任务的轮询总超时（ms），超时回 504 |
| `DUMATE_MEDIA_POLL_INTERVAL_MS` | `1500` | 生图轮询间隔（ms） |
| `DUMATE_MEDIA_VIDEO_POLL_TIMEOUT_MS` | `900000` | 视频生成轮询总超时（ms）——视频是分钟级任务，与生图的 120s 分开。超时回 504 + taskId，任务在上游继续 |
| `DUMATE_MEDIA_VIDEO_POLL_INTERVAL_MS` | `10000` | 视频轮询间隔（ms） |
| `DUMATE_QWENWORK_COSY_VERSION` | `1.1.71` | 千问的 cosy 版本（进 payload 与请求头，2026-10-31 对齐官方 1.4.0）。上游做版本门时可覆盖回退 |
| `DUMATE_QWENWORK_IDE_VERSION` / `_RELEASE_VERSION` / `_BUILD` | `1.4.0` / `1.4.0-26102705` / `26102705` | 千问客户端身份（进 `X-QwenWork-*` 头）。release 与 build **必须成对改**（build 由 release 派生） |
| `DUMATE_QWENWORK_OS_HEADERS` | 未设（发送） | 设 `0` 关闭 `X-QwenWork-*` 六个身份头（排障对照用） |

## 数据文件（`data/`，已 gitignore）

| 文件 | 内容 |
|---|---|
| `keys.json` | API key，**存 sha256（校验用）+ plain 明文**（2026-11-01 起管理端可随时查看复制；旧策略「明文仅创建时返回一次」已废，启用前创建的旧 key 明文无法回填，界面标「明文未存」） |
| `model-map.json` | `aliases` / `upstream_models` / `exposed` / `fallback` |
| `admin-users.json` | 管理端账户表（多账户，2026-11-01 起）：`{ username: {username, role: admin/viewer, hash(scrypt N=2^18), session_version} }` |
| `admin.secret` | 会话签名密钥，与用户表分开存 |
| `admin-audit.jsonl` | 管理操作审计 |
| `requests.jsonl` | 网关埋点，超 32MB 轮转一次留 `.1` |
| `web-accounts.json` | 网页账号，**cookie 明文存**（上游要求原样重放，与 keys 的只存哈希是两种策略） |
| `activity.jsonl` | 统一操作记录（签到/任务/抽奖），按时间排序 |
| `task-runs.jsonl` / `task-scheduler.json` | 任务执行历史 / 轮询配置 |
| `auto-checkin.json` | 自动签到配置 |
| `qwenwork-credits.jsonl` | 千问积分归因（每请求一条，带 `req_id` 与请求日志配对） |
| `qwenwork-daypeak.json` | 千问每日额度观测峰值的**历史遗留文件**（用于推断「每日上限」）。2026-11-02 起不再读写——上游已停发每日额度，峰值法的前提不成立。文件可安全删除 |
| `qwenwork-accounts.json` | 千问自持凭证账号池（**含 refresh token，等同密码**） |
| `qoder-accounts.json` | Qoder 自持凭证账号池（device flow 换取，含 refresh token） |
| `qoder-grants.jsonl` | Qoder 积分批次账本（**签到领取记录**，用于过期提醒；上游无逐批余额接口） |
| `expiring-snapshot.json` | 四家通道（搭子/TRAE/千问/WorkBuddy）的临期积分快照：管理端 /credits 顺带写、网关选号读（FEFO）。WorkBuddy 的到期来自套餐 `CycleEndTime`（北京时间，2026-11-04 接入）。陈旧即退回普通轮询，进程间靠它通信，不通过 IPC（`src/expiring.js`） |
| `dumate-caps.json` | 搭子按模型 max_tokens 上限的自学习记录（7 天 TTL，`src/dumate-caps.js`；静态实测表在代码里） |
| `traework-accounts.json` | TRAE 自持凭证账号池（OAuth 换取，含轮换的 refreshToken） |
| `workbuddy-accounts.json` | WorkBuddy 自持凭证账号池（客户端认证文件导入或手动粘贴 token，含 refresh token；区域字段 cn/global） |
| `traework-credits.jsonl` | TRAE 逐请求积分归因（按账号的 consumed 游标，见 `traework/credits.js`） |
| `points-cursor.jsonl` | 搭子的余额游标（每请求一条，相邻差值即该请求成本） |
| `browser-profile/` | 浏览器登录器用的受控 profile 目录（`DUMATE_BROWSER_PATH` 找不到浏览器时才用） |

**两个 `data/` 目录的陷阱**：`DUMATE_ADMIN_DATA` 决定数据目录，管理端与网关必须一致，否则读到的账号/埋点不同。`stable/` 快照若也跑起来，默认用 `<repo>/data`——与开发实例共享同一份数据，这是有意的（账号池共用）。

**`stable/` 手工启动会退回到一个空目录。** `reqlog.js` 的 `ROOT = path.resolve(__dirname, '..')`——stable 副本的 `__dirname` 是 `stable/src`，所以**未设 `DUMATE_ADMIN_DATA` 时埋点落 `stable/data/`**。该目录当前不存在（已被清理），但风险仍在：手工启动且不带环境变量时，网关会退回到这个空目录，**里面没有任何凭证**，千问与 TRAE 通道直接不可用，且 9083 管理端读的是 `<repo>/data`、看不到 9080 的流量——排查时会得出「请求根本没经过网关」这种错误结论。

所以启动 9080 **必须**走 `start-stable.bat`（它设了 `DUMATE_ADMIN_DATA=%~dp0..\data`），或手工带上该变量。历史上 9080 曾被手工启动过（没有该变量），埋点因此落在 `stable/data/`——那段数据已合并回 `<repo>/data`。

**核对 9080 的埋点时先确认它用的是哪个目录**：`stable/start-stable.bat` 启动的看 `<repo>/data/requests.jsonl`，手工启动且未设变量的看 `stable/data/requests.jsonl`。

`keys.js` 的 CIDR 匹配是 **fail-closed**：非法条目返回 false（写错一条 CIDR 会让这把 key 对所有来源拒绝，而非意外放行）。token 比对逐条走 `timingSafeEqual`，避免通过响应耗时逐字节猜 token。

## 平台与依赖

- **仅 Windows**：依赖 PowerShell / CIM 查询进程命令行与监听端口、`%APPDATA%\qianfan-desktop-app\auth.json`、`taskkill`。
- **网关本身零第三方依赖**（`stable/` 快照更是如此），只用 Node 内置 `http`/`net`/`child_process`/`fs`/`crypto`。Node >= 18。
- **根 `package.json` 有 `playwright-core`**，但只被管理端的浏览器登录器 `src/login-browser.js` 用到——用来打开受控窗口抓 cookie（系统浏览器 cookies 库运行时被独占锁，读不到）。复用系统已装的 Edge/Chrome，不下载 Chromium。
- **前端有依赖**（Vue 3 + ant-design-vue + Tailwind + ECharts），在 `web/` 下单独 `npm install`。

## 管理端模块（`src/` 下除网关外的部分）

**先分清两类**，它们的归属决定了改动要不要同步进 `stable/` 快照：

- **属于网关闭包**（会进快照）：`server.js` 依赖闭包可达的全部文件。除了 `dumate-web.js`、`accounts.js`、`web-pool.js`、`points-cursor.js` 这些老的，**`boot.js` 接线后闭包又长了一截**：`boot.js` / `cors.js`（server.js 顶层引用）、`reqlog-hook.js` / `usage-agg.js` / `keepalive.js`（boot 探活与优雅停止）、`admin/store.js` / `balance-hist.js`（keepalive **顶层**依赖），以及 keepalive 签到适配器懒加载可达的 `admin/auth.js` / `admin/router.js` / `admin/routes/accounts.js` / `records.js` / `points-agg.js` / `task-runner.js` / `task-scheduler.js` / `login-browser.js`。**改这些都要同步快照**——别被「admin/ 不进快照」的旧印象骗了。
- **真正不进快照的只剩**：`web-gateway.js`（9084 独立网关）、`admin/iputil.js`、`admin/routes/` 下其余管理路由（traework / qwenwork / qoder / keys / models / usage / reqlogs / chatlab / autotask / keepalive 面板等）。判断方法永远是**从 `src/server.js` 重算一次依赖闭包**，别凭直觉。

> **闭包比对必须从 `src/server.js` 算起**。2026-10-29 的教训：上一版快照同步只按 `src/qoder/index.js` 的 31 文件子闭包做逐字节比对，结果 server.js / responses.js / web-pool.js 等 34 个文件自 `41863ef` 起**一直没同步**，其中 server.js 顶层新 require 的 `./boot` / `./cors` 不在快照里——**9080 会直接起不来**。子闭包比对会静默漏掉主链路的演进。

| 模块 | 职责 |
|---|---|
| `dumate-web.js` | 网页端 API 封装（签到 / 任务 / 抽奖 / 积分）。**网关闭包内**——回落链路靠它调网页接口 |
| `accounts.js` | 网页账号存储，cookie **明文存**（必须原样重放）。**网关闭包内**（`web-pool.js` 依赖）。显示名解析 `displayName()` / 对外序列化 `toPublic()` 都在这里，见 `docs/CREDENTIALS-ACCOUNTS.md` |
| `web-pool.js` | 网页凭证账号池，轮询 + 故障转移。**被两个入口共用**：9084 独立网关 + 9080 的回落链路 |
| `web-gateway.js` | 9084 独立网关，用网页凭证跑模型（纯管理端，不进快照） |
| `task-runner.js` / `task-scheduler.js` | 任务自动跑 + 后台轮询（纯管理端） |
| `records.js` | 统一操作记录（签到/任务/抽奖）。**纯管理端**——网关不加载它 |
| `points-agg.js` | 额度包聚合（按来源 / 按发放日 / 临期 / 已过期未用完）。**纯管理端**。本地后端与网页账号拿到的是同一份额度包结构但字段来源不同，两份都要得出同样的派生视图——收敛在这里，否则「一边按到期日、一边按发放日判断还在不在发」这种口径漂移必然发生 |
| `points-cursor.js` | 单请求积分成本（余额游标差）。上游账单无法归因到具体请求（同一时间窗有 1~3 条候选扣费，硬挑一条等于编数字），改用「每条请求结束后记一次余额、相邻两次差值即后一条的成本」。**每账号一条串行队列**——丢一条游标会让下一条的差值跨过两条请求，静默算错，所以宁可排队也不缺档 |
| `login-browser.js` | 浏览器登录器（唯一依赖 playwright-core 的地方，纯管理端） |
| `admin/router.js` | `/api/admin/*` 路由分发。**路径匹配锚定整串**，所以 `/models/map` 不会误吞 `/models/map/reset`；注册时 `path: ''` 与前缀拼成 `/api/admin/web-accounts`，`mount` 做了去尾斜杠 |
| `admin/store.js` | JSON / JSONL 原子持久化（先写 `.tmp` 再 `rename`）。管理端的配置写盘都走它 |
| `admin/iputil.js` | 客户端来源 IP。管理端只监听 127.0.0.1，所以直接取 TCP 对端；**没有 TRUST_PROXY 判定**——挂反代前必须先补，否则限流/锁定会按代理 IP 统计 |
| `admin/routes/traework.js` | TRAE Work 通道的管理接口：`/status` 通道健康+账号列表（mode=multi，可增删）、`/models` 模型表（只读）、`/credits` 各账号额度与签到状态、`/checkin` 手动签到（幂等）、`/billing-check` 计费自检探针、**`/login/url` + `/login/callback` 两步 OAuth 登录**、`DELETE/PATCH /accounts/:id` |
| `admin/routes/qwenwork.js` | 千问办公通道的管理接口：`/status` 通道健康、`/credits` 三个池、`/credits/daily` 按天聚合、`/credits/records` 逐笔明细、`/billing-check` 计费自检探针、`/models` 模型表、**`/account` 登录态详情（只读）**、**`/accounts` 账号（`mode='single'` 表示单账号直连，不可增删）** |
| `admin/routes/accounts.js` | 搭子网页账号的管理接口（签到/抽奖/积分/记录）。**回填与显示名的逻辑都在这里**（`backfillNickname` / `backfillAll`），属于管理端、不进快照 |
| `admin/routes/*.js` | 其余管理 API，按 `mount()` 挂载到 `/api/admin/<前缀>` |

**千问登录态只读，管理端绝不写入。** 它存在官方客户端的 `auth-v2.dat` 里（Electron safeStorage：DPAPI 解 `Local State` 的 `encrypted_key` → 32B AES key → AES-256-GCM 解密）。官方客户端和我们各写一次会互相把对方的登录态刷掉，所以换账号必须开客户端操作。**不复制这个文件到 `data/`**——它会过期，复制一份立刻失效。`refresh_token` 过期（`refreshExpired`）要提前告警：access token 到期后无法自动续期。

**API Key 区域绑定（2026-11-01 落地；2026-11-03/04 随 TRAE 国际版与 WorkBuddy 补全，
五通道 × 国内/国际）**：`keys.js` 的 `region`
字段（`''` 不限 / `cn` / `intl`）。**intl key 打纯国内通道（dumate/qwenwork）
在 validate 直接拒** `region_not_available`——上游连国际端点都不存在；qoder/
traework/workbuddy 的区域约束落在**账号池选择**（`accountsForRegion`，send 里过滤——
模型名不编码区域，约束只能落在这里；qoder 与 workbuddy 的 intl 映射到 global
术语，**TRAE 国际版 2026-11-03 起已全链路接入，traework-intl key 不再是空预留**）。
无 model 字段的工具端点按路径归通道
（搜索/语音润色/文件上传=千问、媒体=搭子），否则区域 key 可绕过判定。
**区域约束随鉴权强制生效**（2026-11-01 起鉴权恒开，不存在未校验形态）
预留六把 key：dumate / qwenwork / qoder-cn / qoder-intl / traework-cn /
traework-intl（明文已交付；traework-intl 自国际版接入起可用）。WorkBuddy 未单独
预留——用通用 key + `channel`/`region` 字段绑定即可。搭子与千问**没有国际版**
（纯国内产品）。

**API Key 可选绑定通道**（`keys.js` 的 `channel` 字段，`''` = 不限）。网关鉴权段用 `upstream-router.resolve(model).channel` 解析请求走哪条通道再传给 `validate()`——设了 `qwenwork` 的 key 调搭子模型会被 403 `channel_not_allowed`。注意鉴权段**只在 key 真的配了模型白名单或通道绑定时才预读请求体**，否则给默认路径凭空加一次完整读取。key 用量按通道分开统计（`usage.channels`），因为网关按模型名前缀分流、不按 key 分流，同一把 key 可能两条通道都在用。

**两套「用量」视图不要互相替代**：`stats.js` 与 `usage.js` 都读 `data/requests.jsonl`，但 `usage.js` 还额外查上游计费记录——本地只知道「发了多少 token」，不知道「扣了多少积分」，计费规则在上游。`reqlogs.js` 则是逐条明细与单条详情（聚合看趋势、明细查个案）。

**`chatlab.js` 刻意绕过密钥与 IP 管控**：它只要求管理员会话，走的是与 9084 同一套账号池、消耗真实积分。定位是「在管理端里验证某个模型名能不能跑通」，不必先去签发密钥。与 9084 的分工是：9084 面向外部客户端、带鉴权、做协议兼容；chatlab 是内部试调、返回便于展示的结构化数据（含每条回答的实测消耗）、不做协议翻译。

**`autotask.js` 只给签到做定时，抽奖只留手动**：签到幂等（当天已签就跳过），多跑无害；抽奖消耗次数且不可逆。定时配置落盘到 `data/auto-checkin.json`——定时器只活在进程内，重启后得知道上次开没开、几点跑。

## 前端（`web/`）

Vue 3 + Vite + ant-design-vue 4 + Tailwind + ECharts（按需引入，不用全量，省约 1MB 首屏）。开发时 Vite 把 `/api` 代理到 9081（`vite.config.ts`），**改的是哪个管理端端口就要对应改这里**——代理写死 9081，跑开发实例 9083 时前端页面会拿到 9081 的数据。

**设计方向是深色控制台，不是浅色后台。** 这套系统的本体是「模型网关的控制室」：请求量、账号池、上游健康、积分流水，信息密度高、看数时间长。三层共享设施各管一段，**改一处全站生效**：

| 位置 | 管什么 | 为什么必须在这一层 |
|---|---|---|
| `App.vue` 的 `ConfigProvider` | AntD `darkAlgorithm` + token | Select 下拉、Modal、DatePicker、Message 这些浮层不在卡片内，scoped 样式够不到，只有 token 能一次改干净 |
| `src/style.css` 的 `--lab-*` | 分层底色、青色信号色、卡片/表格/按钮基线 | 各页面各写一遍圆角阴影必然漂移 |
| `tailwind.config.js` | **把 `slate` 槽位整体重映射为控制台灰阶** | 全站 100+ 处 `text-slate-400` 这类工具类因此一次性换到深色语义。**新增页面继续用 `slate-*`，不要为了「准确」改成语义色名**——那样等于把这层映射废掉，回到逐页维护 |
| `src/utils/chartTheme.ts` | 图表色板与轴样式 | 分类色按固定槽位取用、不按排名重排（否则筛掉一条序列会让其余序列换色，读者刚建立的对应关系就废了） |

**通道切换是全局状态，不是各页各存一份。** `web/src/stores/channel.ts` 管「当前在看哪个通道」，持久化到 localStorage，顶栏切（不是侧栏——侧栏可折叠，折叠后切换器会消失，而通道是任何时候都不该丢的上下文）。`CHANNELS` 里的 `menuKeys` 是该通道**有意义**的菜单白名单：千问与 TRAE 都没有「操作流水」（无签到/抽奖/任务体系），账号管理只做只读展示。

**「任务记录」已并入「积分明细」，不再是独立页**（2026-09-29）。判定依据是**职责而非数据来源**：

- 签到 / 任务 / 抽奖 / 自动发放这四类记录，**全都是积分的来源**。积分明细页其余区块（额度包、按来源、每日发放、逐笔发放）回答的是同一个问题——「积分从哪来、怎么没的」。拆成两页会让「查一笔积分的来历」在页面之间来回跳。
- 账号管理页保留的是**操作台**：增删账号、跑任务、开轮询。记录是结果，不该堆在操作台上。它原来那块「任务执行记录」与任务记录页的「操作明细」是**同一份数据**（`task-runner.js` 的 `appendLog` 同时写 `task-runs.jsonl` 与统一记录流 `records.append`），留着就是同一件事三个视图，已删掉；本页只留「跑完的即时反馈」提示条，历史去积分明细查。
- 因此 `/records` 路由、`RecordsView.vue`、侧栏菜单项、`menuKeys` 里的 `records` 全部移除。后端接口（`/web-accounts/records`、`/web-accounts/checkin-calendar`）**保持不变**，只是换了调用方。

**别按「数据存哪个文件」划页面，按「用户要回答什么问题」划。** 同一个 `records.js` 的数据既支撑「操作流水」也支撑签到日历，它们是同一页的两个视图；而 `task-runs.jsonl` 虽然单独落盘，内容却是 `records` 的真子集——按文件划分会把一条任务拆到两个页面。

**各页面必须 `watch` 通道变化并重新拉数据**，不能只在 `onMounted` 读一次——否则顶栏切了、页面还是旧通道的内容。两个数据源结构不同的页面（登录态、积分明细、账号管理、模型管理、API Key）用 `v-if="isQw"` / `<template v-else>` 分开两套模板，共用同一个路由；只差筛选条件的页面（用量统计、请求日志、聊天测试台）同一套模板，只换请求参数。

**千问办公的账与搭子完全不同，界面必须分开显示**：搭子靠上游账单 + 余额游标（`points-cursor.js`），千问是三个积分池按 `req_id` 归因。两边数字**不能相加**。

**千问的积分体系 2026-11-01 变过一次，代码与界面都已按新体系重写**（当天实测：`daily_credits.total_balance` 两个账号都恒为 0，`monthly_credits` 从 0 变成 100 左右、`active_wallets` 只剩一条且 `valid_to = 2026-12-01`；归因账本一致——11-01 起每条请求 `free=0`、`paid>0`，10-31 之前大量 `free>0`）：

| 池子 | 现状 | 界面口径 |
|---|---|---|
| `daily_credits` | **上游已停止发放**，恒 0 | **已从接口与界面整体移除**（用户 2026-11-02 明确要求「可以删除，不要再显示」）。留一张永远显示 0 的卡会被读成「今天用光了」，进而被当故障排查 |
| `monthly_credits` | **唯一有余额的池**，Free 号月初刷新（`active_wallet` 的 `valid_to`，实测 12-01） | 「月度额度 · 按有效期（N 月 N 日刷新）」 |
| `longterm_credits` | 充值/赠送，按有效期 | 「长期积分」 |

`/credits` 的 `wallets` 数组现在只有两项（monthly / longterm）；`today` 只有 `total` 与 `requests`（不再拆 `free`/`paid`）；`/credits/records` 只有 `total`（不再透出 `free`/`paid`/`pool`）；`/credits/daily` 只有 `total`（图上一条线）。归因账本 `qwenwork-credits.jsonl` 里 `free`/`paid`/`pool` **仍然照写**——那是历史与当时的事实，只是不再对外透出。

随之**整体删除**的东西（别再翻出来做）：`credits.dailyUsageFromBalance` 的观测峰值推断、`DUMATE_QWENWORK_DAILY_CREDITS`、`data/qwenwork-daypeak.json` 的读写、响应里的 `limit` / `limitSource` / `peak` / `calibrated` / `freeUsed` / `dailyCap` / `dailyCapPerAccount` / `daily` / `free`，以及界面上的「每日额度 x / 100」「今日已用 N / 上限」「免费/付费」两列。「今日全部消耗（含客户端内对话）」也一并删除——它靠「上限 − 余额」，没有上限就推不出来，**宁可不出这个数也不编**。

现在**唯一有实测依据的消耗口径是「经本网关」**（`today`，按 `req_id` 逐条前后余额差值）。界面上要写清「客户端/网页里直接对话的消耗不经过本网关，这里看不到」。

**余额未知（`null`）不等于 0，这是改版后最容易写错的一条**。`fetchWallets` 在「三池全 0 且重试也没恢复」时会去打 `account-context` 的 `quota.remaining`（权威总数），校正成功后 `daily/monthly/longterm` 一律 `null`、`total` 用权威值、标 `misread` + `poolsUnknown`——`remaining` 分不出池子分配，硬拆回某个池就是编数字（旧实现正是这么做的，daily 版）。聚合时 `(a.total || 0)` 或 `n(null)=0` 会把「不知道」写成「没有」，所以合计只累加已知值，并给 `partial` / `totalKnown` 让「部分和」看得见。

**交叉验证的触发条件也从「daily 读数为 0」改成「三池全 0」**：daily 现在常态就是 0，按旧条件每次余额查询都会多打一次 `account-context`（把每条请求的归因从 2 次上游调用放大成 3 次），而它想救的「daily 被谎报成 0」已经不存在了。

**`/credits` 与 `/accounts` 的账号范围必须同源**（都走 `authStore.list()` 全量，不只 `usable`），否则「顶部合计」与「池子合计」还是会差。余额查询失败的账号不计入合计，但必须在 `failedAccounts` 里如实报出——否则部分和被读成全量。聚合值统一 4 位小数（与归因记录口径一致），否则浮点累加会外传 `90.11019999999999` 这种噪声。离线验证：`node test/verify-qwen-daily-aggregate.js`（含「余额未知不参与求和」「坏读校正的账号池子 null 但 total 可信」两类）。

**FEFO 的临期数据只认 `expiring_soon`，不要把 `active_wallets` 的 `valid_to` 当临期**：后者是月度额度的**刷新点**（实测 12-01，两账号一致），不是「会作废」。拿它当临期会让 FEFO 常驻开启、天天把流量钉在同几个账号上（`admin/routes/qwenwork.js` 的 `expiringSnap.update` 只喂 `expiringSoon.count > 0` 的账号）。

**模型管理页的三条通道共用一套骨架，但账各自独立**（2026-09-29 对齐）。页面结构固定为「通道元信息行 → 模型信息表 → 该通道的额度卡 → 通道专有区块」：

- **通道元信息行**（`.qw-channel-row` 三联卡）：TRAE 给「可用账号 / 当前账号 / token 状态」，千问给「账号 / 套餐 / token 状态」，搭子给「上游端口 / 桌面登录账号 / 凭证来源」。放的是**通道级**信息，不随模型变。
- **模型信息表**：三条通道共用 `ModelInfoTable.vue` + 后端 `/models/info?channel=`。**倍率只有 TRAE 有**（上游下发），搭子与千问如实 `null` → 显示「—」，**不估算**——编一个单价会让人以为真能按那个价扣。
- **额度卡**：回答「这些模型花的是哪份额度」。TRAE 是单 credits（签到补充）、千问是三池、搭子是上游账单 + 余额游标。**三套账的数字不能相加**，所以各写各的卡片，不抽成一个通用组件。

**搭子模型页的「凭证来源」必须区分「未加载」与「已回落」**：`channelStore.infos['dumate']` 为空时显示 `—`，不能默认成任一侧。桌面凭证不可用时会自动回落到网页池（`fallback-web.js`），把一次「还没拉到状态」显示成「网页凭证回落」等于凭空报一个不存在的故障。

**搭子的「今日消耗」取 `/usage/overview` 的 `cards.today.consumed_points`**（来自上游账单，`points-cursor.js` 的余额游标差）。这个字段**只有搭子有**，直连通道为 `null`——界面据此显示「上游未给出账单」而不是 0，0 会被读成「今天没花钱」。

**新页面的骨架约定**：

- 外层用 `.page`，页头用 `PageHeader.vue`。`.page` 用 `gap` 统管间距并清掉直接子元素自带的 `mt/mb`——否则「gap + margin」会叠成双倍间距，且各页面各不相同。
- 所有数值加 `.num`（或 `mono`）类：等宽 + `tabular-nums`。比例字体下数字宽度不一，逐行累加会让整列看起来在抖。
- 状态色用 AntD 的语义名（`color="green" | "red" | "orange"`），不写十六进制。深色下这些色值已在 `tailwind.config.js` 里提亮（默认的 `#52c41a` 压不住近黑底）。
- 载入动效是 `.page > *` 的错峰浮起，一次编排好过满屏微动效；已用 `prefers-reduced-motion` 兜住。

## 排查 Codex / 客户端侧问题

**先分清「网关错」还是「客户端侧错」**，否则会改错地方：

1. **看 Codex 的会话日志**：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`。每条都是完整交互记录（含 system 提示词、工具调用、上游返回）。用第一行的 `payload.cwd` 认出是哪次会话。
2. **看网关埋点**：`data/requests.jsonl` 有 `channel` / `model` / `mapped_model` / `real_model` / `input_tokens` / `output_tokens`。`mapped_model` 能立刻看出前缀有没有生效（`qwen/flash` 应映射成 `flash`，若变成 `model-text` 说明路由错了）。`real_model` 是上游真实执行的模型（网页链路云端回传 `X-Dumate-Gw-Realmodel`，桌面链路拿不到如实留空）——上游会静默改路由（`model-text` 实跑 `deepseek-v4.1-flash-low-latency`、`glm-5` 实跑 `glm-5.2`），排「请求的模型和回答的模型对不上」时先看它。
3. **看进程存活**：网关崩溃（如 `ERR_STREAM_WRITE_AFTER_END`）会让端口直接消失，表现为客户端「连接被拒」而不是报错。

**Codex 的本地工具走 PowerShell（`pwsh.exe`），不是 bash。** 排查 Codex 工具行为（读文件乱码、命令语法、路径）要按 PowerShell 语义判断。一个真实坑：项目里的 `.md` 是**无 BOM 的 UTF-8**，中文 Windows 上 PowerShell 的 `Get-Content` 默认按 GBK 解码，会把中文读成乱码（`世界观` → `涓栫晫瑙?`），让 Codex 基于垃圾输入工作、反复纠结编码。这是客户端/环境侧的事，网关改不了。

**HTTP 402 是额度问题，不是代码问题。** 千问额度耗尽时所有请求（含最简单的 `hi`）都返回 402。判断方法：拿一个极小请求做对照——若它也 402，就是额度；若小请求成功而大请求失败，才是上下文/格式问题。查余额：`require('./src/qwenwork/credits').fetchWallets({force:true})`。

**`is_reasoning` 是硬编码的 `false`**（`src/qwenwork/chat.js`），`reasoning_effort` 也不透传给上游。实测搭子对 `reasoning_effort` 不敏感（none/low/medium/high/xhigh 的 reasoning token 数不单调：922/503/434/426/829，属噪声）。**想提升推理深度只能靠提示词，调参数无效。**

## 无 GUI 运行的前提

`src/upstream-launcher.js` 是整个项目唯一的逆向成果：`dumate-main-server.exe` 平时由 Electron 通过 IPC 注入登录态，单独启动会报 `loginMode is required`；逆向发现它支持从 `DUMATE_LOGIN_MODE=standalone` 等 4 个环境变量读登录上下文，账户信息从 `auth.json` 的 `activeProfileId` 取。

**cookie 本身不由本项目处理**——它仍留在 `auth.json` 里由 Go 后端自己读，本项目不接触也不复制凭证。因此 **cookie 过期后必须打开一次 DuMate 客户端重新登录**，这个绕不过去。

更细的逆向结论与实测数据见 [ARCHITECTURE.md](ARCHITECTURE.md)（含端口发现三级降级、预算实测表、SSE 状态机细节）。

## 2026-11-05 落地（GitHub 融合批次）

> 参照仓库快照在 `%TEMP%\fusion-refs\`（workbuddy2api-hub / Trae2api-cn 浅克隆）；hub 三天三个 release（v1.7.20-22）的功能形态直接融合进网关。

**Qoder 节奏闸门（channel-pool，默认全关）**：`DUMATE_QODER_INFLIGHT_MAX`（通道级在途帽，覆盖池默认 4，`pool.acquire` 支持按次覆盖）与 `DUMATE_QODER_MIN_INTERVAL_MS`（账号最小请求间隔，判据是**上次 pick 时刻**——约束发射节奏不是请求时长；间隔内跳过与 busy 同语义不惩罚）。先埋点看 10605 率再定阈值，不配 env 行为与之前逐字节一致。

**探针无副作用（hub v1.7.20 #134 教训）**：五通道 `billing-check` 全部带 `opts.probe`——失败跳过池惩罚（noteError/markFailure/lastError），错误照常上抛。`test/unit/probe-no-punish.test.js` 锁住「默认路径仍喂池（回归锚）+ probe 不喂」两态。

**工具调用回显（tool echo，hub #135）**：上游把工具调用当**纯 JSON 载荷**吐进正文（Qwen3.8-Flash 实测），客户端静默结束。`repair.js` 新增 `parseToolEchoPayload`（强判据：纯载荷 + 工具名名单锚，与 DSML 的 XML 形状互补）+ gate `echoFixup` + 聚合出口 `aggregateToolEchoFallback`，三通道接线。`DUMATE_TOOL_ECHO_MODE` off（默认，本地无真实样本不改现状）/lenient（还原成 tool_calls）/strict（fail-closed 502）。

**积分三段拆分 + 全价请求（hub v1.7.21/22）**：`reqlog.pickUsage` 提取缓存命中并带 `cached_reported`（区分「确认零命中」与「上游没回报」——全价统计只认前者）；新 `src/credit-split.js`（Qoder 专属三段折算，系数 1.069/0.086/4.277 每千 token，`DUMATE_QODER_CREDIT_COEF` 可覆盖，缓存未回报时缓存段/合计为 null 不编）；usage-agg 桶加 `ci/cc/c0/c0p` 四字段，`snapshot.full_price` 报「prompt≥阈值且确认零缓存且成功」的次数/tokens/占比（`DUMATE_FULL_PRICE_PROMPT_MIN` 默认 100K；积分占比不做——各通道口径不同不编数）。前端：用量页「全价请求洞察」卡、请求详情页 Qoder 三段拆分行。

**千问 ACP 会话通道（P2-17 最小闭环）**：`src/qwenwork/{wsframe,wsclient,acp}.js`——REST `POST /api/chat-sessions` 建会话 + WS `wss://qwenwork.cn/api/chat-ws`（**裸域不是 gateway**）带信封 JSON-RPC（`{"type":"control"|"data","payload":{…}}`，裸 RPC 回 -32700）；结束判据「见过 running 或正文增量之后的 idle」；单条消息 32768 字节硬上限（压缩救不了，`promptOf` 裁剪：保 system+最新、丢最老、留标记）；模型档位由账号/套餐决定（`qwen-acp/auto` 只是标签）——**2026-11-06 三重实测定案**：`session/set_model` RPC 不存在（-32700 Unknown control method）、createSession body 的 model/modelId/model_key 全被忽略（`extra_data.mode` 恒为账号侧档位，账号 3=flash）、`extra_data.mode` 可作会话真实档位观测字段；每请求新会话（复用=上游 agent 会话重跑整段上下文，重复计费），**同账号并发建会话 409 CONCURRENT_OPERATION**（间隔 ≥4s）。附件链路（barn→ACP file_uuid 引用）**阻塞**：发送侧 file_uuid 来源无证据（barn 完成体只有 storage_path；path 直引 404；解包源随客户端卸载消失），等抓包。`qwen-acp/` 前缀独立 provider（qianfan-raw 同款），不进 chat 桥。协议证据：tang-bugu/dsh-connect-qwenwork 实测 README + 本项目探测（假 token 握手回 401 JWT verification fails，端点与鉴权形态独立印证）。真实回合待真机账号。

**TRAE remote manual 策略（P2-13.1 修正定案）**：参照 Trae2api-cn 源码证实 remote 协议**没有 tools 槽**（"tools remain owned by the API caller"）——「带 tools 走 remote」不成立，带工具请求仍走 utils_chat。落地的是**显式模型名**：`DUMATE_TRAEWORK_REMOTE=2` 时显式模型经 manual 策略走 remote（`remote.manualFieldsOf`：bound 校验拒绝静默落默认档，五件套 model_name/config_source/is_preset/provider/custom_model 原始对象，`models.normalize` 新增 `customModel` 原始行）；`=1` 仍是 auto 档纯文本（真机已验证的行为不变）。

**WorkBuddy 每日活跃双通道**：国内版 `src/workbuddy/activity.js`——`/v2/report` 一条 `chat_request_send` 事件点亮 growth 连登（**必须带 userId** 否则 200 但静默丢弃；当日幂等，账号档案 `lastActivityReport`；keepalive 签到后顺带）。国际版 `src/workbuddy/webagent.js`——网页 agent 会话打卡（ACP over streamable HTTP：建会话→取沙箱 link/token→SSE 通道 Acp-Connection-Id→initialize→session/load→**session/set_model**（不设会按网页默认 Auto 付费档计费）→session/prompt→轮询 completed；活跃会话上限 10（429/10105），成功 stop 保留、失败 delete 清理；当日幂等 `lastWebActivity`）。keepalive 的 global 分支由「不支持签到」改为网页打卡。

**前端构建**：`cd web && npm run build` 通过（vue-tsc 0 错误）。全量回归 `npm run verify` 40 项通过。

**2026-11-05 凌晨真机批次**：千问 ACP 真机回合跑通（P2-17 闭环），帧形状按 40 帧采样修正（sessionStatus 在 params、update 事件名在 sessionUpdate 键、文本在 update.content.text、沙箱生命周期帧 ignore）；TRAE `REMOTE=2` 显式模型真机跑通（glm-5.2 manual 钉模）；WorkBuddy 网页 agent 打卡 cn 区真机跑通（178 段输出 6.4s）。千问 billing-check 仍受阻：账号 2 refresh token 失效需重登、账号 3 chat 桥 403「Model is not available for this user」（账号级）——**但账号 3 的 ACP 会话是通的，ACP 与 chat 桥可用性分离，`qwen-acp/auto` 可作千问对话备用链路**。

## 2026-11-06 落地（WorkBuddy 融合批次：hub v1.7.22 → v1.10.11 差集的 P0/P1）

> 参照仓库快照刷新在 `%TEMP%\fusion-refs\wb-hub-latest\`（v1.10.11 浅克隆）；旧快照 `wb\`（v1.7.22）保留。hub 10-23 起挂维护状态：上游对非官方客户端识别持续收紧，本批 P0 是保命项不是优化项。

**11-128 渠道指纹清洗（`src/workbuddy/sanitize.js`，最高优先）**。上游按 system/assistant 里的**连续文本指纹**判非官方客户端回 400/11128，而本项目整个跑在 DSH 生态里——Codex/CC 的 system prompt 必带这些串，原样转发是必撞。全套规则与措辞照 hub v1.10.11 的 wb_proxy.py 移植（指纹边界都是社区 A/B 实测定死的，不猜）：身份句族（7 种动词、名词可省、0~3 修饰词，整句中性化）；DSH GUI 段（只调 A 句尾语序）；DSH 文件引用段（A 句补一个 `that` 打断整段连续匹配）；`DeepSeek Harness` 品牌词缩成 `DeepSeek`（连字符/下划线路径不动）；Codex/Claude Code 自述首段整句换掉（hub 教训：改写式清洗曾把指纹注入出站 body）；billing 头与 `cc_*` kv 清洗。**角色作用域**：identity 只对 system/developer/assistant（assistant 历史同样命中，#574）；user/tool 是用户数据不改写。`chat.js` 的 `buildChatBody` 在首条 system 注入后清洗——清洗不改 user 内容，convId/前缀缓存键稳定。tool arguments 非字符串强制 JSON 序列化（Go struct 11101）。`DUMATE_WORKBUDDY_PRESERVE_CONTRACT=1` 跳过 tool 内容改写（默认关）。离线验证 `node --test test/unit/workbuddy-sanitize.test.js`（13 项，对照 hub `_test_sanitize_fingerprint.py` 收敛 + 出站链路接线断言）。

**风控连坐保护（hub #422 社区复盘代码化，行为级变更）**。**11140 不再默认换号**——原来「受限换号区内轮完一圈」正是 hub 实测把 7 个号在一次任务里全送走的路径：设备/出口指纹被扫到时换号等于把同一指纹挨个报给风控。处置：`noteAccountRestriction` 记窗口内受限账号（默认 900s 窗、2 个不同账号即触发），触发后**整区域暂停 1800s** 快速失败 503；换号数默认 0（`DUMATE_WORKBUDDY_RESTRICTED_ROTATE_MAX` 可调）。暂停是进程内紧急状态不落盘。**新增分类 `model_cap`（6004，hub v1.9.0 #668）**：上游 429 + body code 6004 是 (账号, 模型) 级窗口额度用满，唯一带重置墙钟——`parseRateLimitReset` 认 cn/intl 两种文案（含 `\u` 转义形态，按 UTC 解析再减偏移，不能用 `Date.parse` 裸解析否则宿主机时区带偏几小时），喂池走 `scope:'model'`（复用 Qoder 的 `applyModelSoftCooldown` 机制，`model_cooldowns` 持久化进 pool-state.json），**换号继续打同模型**，绝不按账号级 429 封整号。**401 先刷新再换号（hub #441）**：裸 401 归 `session_dead`（原来落 `client` 没有刷新入口），`errorActionOf` 给 refresh → `authStore.exchange` 成功同账号重试（不喂池——刷新成功=账号健康，喂池会把 token 过期记成 session_dead 计数）、失败才判死喂池换号。挑战头 `WWW-Authenticate: ... error="invalid_token"` 拼进分类输入（hub #686，APISIX 的 401 死因只在头里）。**参数错误不喂池（hub v1.10.11 #794）**：400 + param-invalid 文案 `paramError`，如实 400 不惩罚账号。**max_tokens 按模型目录上限 clamp**（`models.maxOutputOf`，未预热/不在表=0 不 clamp）+ 字符串 `stop` 归一化数组。**`readStream` 的 `[DONE]` 即终态**（hub v1.9.1 的默认开版本）：上游 [DONE] 后保持连接不关，原实现聚合路径一直白等——见哨兵即 destroy + resolve，`DUMATE_WORKBUDDY_STOP_AT_DONE=0` 可关。离线验证 `node --test test/unit/workbuddy-error-surface.test.js`（9 项：6004/401/连坐/errorActionOf/parseRateLimitReset/clamp/停读）；`verify-workbuddy.js`（9 项）与 workbuddy 全部单测（32 项）回归通过。

**账本原子追加排查（hub wb_usage_io 教训，结论：无需改）**：本项目六处 jsonl 写入（jsonl/records/reqlog/task-runner/checkin-ledger/qoder-grants）全部是**单次 `fs.appendFileSync`**——一次调用=一次 O_APPEND 写（NTFS FILE_APPEND_DATA 与 POSIX 均内核级原子），hub 丢行 7.3% 是 Python 文本模式缓冲切分特有形态，本项目无此问题。

**融合遗留（清单见会话，按性价比排序）**：小账号池固定选号（hub #718，防前缀缓存丢失与 token 翻倍）；账号档位权威来源 `get-user-resource-summary`（v1.7.27 #505，国内版零新增请求）；生图/生视频媒体路由（v1.10.6 `wb_media*.py`，COS 预签名上传参考素材 + 按（模型,分辨率,是否带参考素材）分档计价）；CodeArts 第三 realm（v1.10.x，大工程按需）；跨出口回退（v1.7.25 #564，默认关）；growth 任务扩充与网页活跃随机提示词池。**P0-2 出站身份头族对齐（wb_fingerprint 5.8.4 抓包）未做**——现有头族过协议校验（真机 chat 通），等 11-128 复现再对齐头族，避免无抓包依据的盲改。

**网页打卡的 11140 避让与证书降级（webagent.js，hub v1.9.0 / v1.8.0）**：打卡撞 11140 把账号档案记 `webBlockedUntil`（**次日 00:10** 自动恢复——过 0 点边缘，连登按新的一天计），避让期内打卡按 `{ok:true, skipped:true, phase:'restricted'}` 跳过（keepalive 映射成 already，不算失败）；`DUMATE_WORKBUDDY_WEB_CERT_FALLBACK=1`（默认关，与 hub 面板开关同口径）开启后，证书类失败（EdgeOne 给 ACP 沙箱域下发 `*.cdn.myqcloud.com` 通配证书，TLS 层必然拒绝，判据 `altname|certificate|ssl|unable to verify`）降级走 activity 的主域 `POST /v2/report`——打卡目标（点亮连登）不变、路径降级，成功记 `lastWebActivity` 防两路径同日重复。webagent 测试桩新增 error 事件通道（证书/连接类错误在 end 时触发）。

## 2026-11-06 第二批（会话暖账号列表 + 账号档位）

**sticky 单值绑定升级为暖账号列表（`src/sticky.js` + `channel-pool.pickCandidate`，hub #718 的 SessionAffinity）**。原实现 front 唯一：绑定账号冷却/在途满就 unbind + 池轮询随机换号——长会话每轮丢上游前缀缓存重算 prefill，Token 消耗翻倍。现在每会话记 front + 最多 2 个 fallback（`recent(sessionKey)` 按最近使用排序）：front 不可用时**先试会话的其他暖账号**（它们可能还持有上游前缀缓存），全不可用才池轮询，选中的 promote 到 front、原 front 自动降为 fallback（真实换号也保留暖副本）。两处旧 `unbind` 移除（全清暖列表=丢所有暖副本）；只有绑定账号被区域/调用方显式排除才全清。`bind/lookup` API 向后兼容（lookup 仍返回 front 单值），四通道共用一份。hub #718 的「页大小覆盖全池」分支本地无对应物（我们无分页轮转），等价价值就在暖列表。测试 `test/unit/sticky-warm.test.js`（3 项：promote 语义/TTL/池层暖 fallback 接力）。

**账号档位权威来源（`billing.js`，hub v1.7.27 #505）**：`POST {billingBase}/v2/billing/meter/get-user-resource-summary`（body `{}`，**`X-Client-Platform: web`**）的 `IsPaidUser`/`SubscriptionPackageName`/`IsProtectedPriceUser`/`ProTrialStatus` → `parseTierSummary` 纯函数。三条硬口径照抄 hub：**响应没有 `IsPaidUser` 字段 = 没有答案返回 null**（绝不写成「免费」；`IsPaidUser:false` 是「确认免费」，两者不同）；401/非 0 code/网络错误/impl 抛异常 → null，旧值与时间戳原样保留；**企业账号（enterpriseId）跳过**——上游对它们的 IsPaidUser 语义未验证。TTL 24h（`tierIsFresh`），接线在管理端 `/workbuddy/credits`（每账号顺带刷新，不新开定时器），`auth.list()` 带 tier 展示，`_setFetchTier` 注入点可测。注意我们与 hub 的路径差异：hub 的 CN 详细积分路径本来就在打这个端点可复用响应，我们的 `fetchCredits` 走 `get-user-resource`——所以两区都是每账号每天一次摘要请求，成本可接受。测试并入 `workbuddy-billing.test.js`（+5 项）。

**网页打卡随机提示词池（webagent.js，hub wb_webprompts）**：固定 "Hi" 本身是指纹（每天同一账号同一句的会话序列太好认）。`DUMATE_WORKBUDDY_WEB_PROMPTS`（逗号/分号/换行分隔）优先，没配用内置等价问候池；`opts.prompt` 显式指定仍最高优先。活跃计数只看会话跑完不看提示词内容（hub 实测口径）。

**回归基线（第二批后）**：workbuddy 全家桶 50 项 + 池回归 21 项全绿。`npm run verify` 37/40 的 3 个失败单跑全部通过（`verify-qoder-encode-perf` 是性能阈值测试在全量并发负载下超阈、`verify-channel` 环境串扰、单测组同因），与第一批同模式：全量跑的失败要单跑复核，单跑绿就不是回归。

**回归基线（2026-11-06）**：`npm run verify` 37/40——3 个失败均来自工作区**既有未提交改动**、与本批正交：`verify-traework-toolshape.js` 崩在 `traework/chat.js` 的 `meta.sessionId`（meta 未传时 TypeError，用户在改 TRAE 账单键）；搭子 5 个单测断言不同步（mapModel/dumateRows，用户在改 model-info/upstream-router）；`verify-channel.js` 单跑通过（run-all 串扰）。WorkBuddy 全部测试绿。

**融合落地（2026-11-07，docs/DUMATE-GATEWAY-MERGE-FEATURES.md 第一批）**：三件 + P1-4。① **`dumate-points` 伪模型**（`src/dumate-points.js` + server.js 拦截，思路来自 Wang-JQ77/dumate-api「积分为模型」）：OpenAI `/v1/chat/completions` 与 Anthropic `/v1/messages` 双入口，模型名 `dumate-points` 在 `router.resolve` 之后、`availability` 之前拦截（余额读数不依赖搭子通道就绪态），聚合网页池启用账号的 `quotaOverview` 返回余额文本——**拦截点必须早于 needsModelMap**，否则 mapModel 会把它兜底成 model-text 静默打上游；流式/非流式两套协议形状在模块里是纯函数（`openAIBody`/`openAIChunks`/`anthropicBody`/`anthropicEvents`），进程内 TTL 缓存（`DUMATE_POINTS_TTL_MS` 默认 15s，0 关）。三纪律：零上游消耗（只打读接口，失败不喂池）、不编数（失败行不进合计、全部失败无「合计」行——0 会被读成没额度）、只读网页池（桌面 8980 登录态余额不在此列，文本明说）。**/v1/models 也加了 `dumate-points` 条目**（owned_by=dumate-proxy）供客户端发现。② **/v1/models 实测元数据**（P1-4）：搭子条目按映射 target 查 `DUMATE_REAL` 透出 `contextWindow`/`maxContextWindow`/`maxOutputTokens`——**只在有实测依据时带字段**（搭子超限是整轮失败，编造窗口比缺字段害得多）；target 计算抽成 `model-info.dumateTargetOf/dumateRealOf` 单一来源（dumateRows 与 /v1/models 共用，防漂移）。③ **模型能力/链路标注**（P0-3）：dumateRows 的 `multimodal` 从硬编码 false 改为按 target 档位语义判（`dm-auto-model/mm.*`）；新增 `jsonMode:false + jsonModeNote`（response_format 仅 qianfan/ 前缀支持，按命名空间判不按模型判）与 `links:{app,qianfanRaw}`。④ **/health 身份**（P1-6，`src/service-identity.js`）：四进程统一 `service:'dumate2api'` + `role` 字段（gateway/admin/web-gateway，stable/src 目录跑的网关带 `-stable` 后缀，`DUMATE_ROLE` 可覆盖）+ `X-Service` 响应头——web-gateway 的旧值 `dumate-web-gateway` 已统一（grep 确认无消费者）。**P0-1 的坑**：`normalizeIncomingModel` 不认识 `dumate-points`（非 claude-* 名）原样放行，这是对的——伪模型拦截要放 normalize 之后、resolve 之后。离线验证：`node --test test/unit/dumate-points.test.js test/unit/service-identity.test.js test/unit/model-info-dumate.test.js`（17 项）；全量 `node --test "test/unit/*.test.js"` 602/602 绿。真机冒烟（9099 隔离实例，通道 autostart 全 off）：/health 带 X-Service 头 + role=gateway；/v1/models 四个搭子真名全带实测窗口；伪模型三形态（OpenAI 非流式/流式、Anthropic 流式）返回真实余额 22735.32（2 账号），usage 全 0，二次查询 0.3s（TTL 命中）。

**融合落地第二批（2026-11-07 晚，docs/DUMATE-GATEWAY-MERGE-FEATURES.md P0-2 + P1-5）**：两件 + 一处管理端修复。① **智能体一键配置（后端）**（`src/agent-setup.js` + `admin/routes/agent-setup.js`，挂 `/api/admin/agent-setup/{clients,apply,restore}`）：直写本机 Claude Code（`~/.claude/settings.json`，**env 深合并**——只 upsert 我们的键，用户 permissions/hooks 原样保留）与 Codex CLI（`~/.codex/config.toml`，**托管键合并**——顶层键只放首个表头之前（TOML 语义：追加到尾会掉进别的表）、只移除首表头前区域的托管键（`model =` 是常见键，用户 [profiles.x] 表里的不许动）、托管 provider 表整块替换）。档位/上下文推导复用 ccswitch.js 的 `pickTiers`/`derive`/`buildClaudeEnv`/`buildCodexConfig`（已导出为单一来源，cc-switch 与直写文件两边片段不再漂移）；qoder 并集复用 `qoderRowsMerged`。备份：data/agent-setup/<client>/（索引封顶 10 份、旧文件删除）、restore 前再备份当前态；**响应不回显 token**。**测试的坑**：backupConfig 必须吃与 apply/restore 同一份 io 注入，否则真机的 ~/.claude 会被备份进临时目录、结果随真机状态漂移；备份文件是真实落盘的，restore 读它用真实 fs（注入 read 是给用户配置路径的）。cc-switch 不归它写（专用端点已在，/clients 只报状态指路）。② **低频余额刷新**（`src/balance-refresh.js`，端点 `/api/admin/auto-checkin/balance-refresh{,/run-now}`，**默认关闭**——沿用 keepalive「新排程不悄悄自启」纪律；`DUMATE_BALANCE_REFRESH=1` 部署即用 / `DUMATE_BALANCE_REFRESH_MINUTES` 定间隔默认 10）：填的缺口是「管理端不开、FEFO 快照 at 停滞、网关超 TTL 静默退回普通轮询」与「解冻要等每日 keepalive 22:30」——每 N 分钟轻量跑「quotaOverview（串行 800ms 限速）→ FEFO 快照（成功给 entries、失败 keepIds、剩余>0 的包取最早到期）→ 冷却解冻（复用 `keepalive.internals.reconcile`+`normalizePool`，只解硬冷却、余额查不到不动）」。**patchInternal 只更新 points 的 left/total/used 三个数字**——points 里的 expire_at/subscribed/expiring 是 /credits 按包聚合的派生视图，整个覆盖等于把界面临期明细清空。③ admin/server.js 的 `sendJSON` 补第 4 参 extraHeaders（P1-6 的 X-Service 头在管理端被静默丢掉，冒烟抓到的）。离线验证：`node --test test/unit/agent-setup.test.js`（11 项：TOML 幂等/用户表不碰/往返还原、settings 深合并、备份封顶 10 份）+ `test/unit/balance-refresh.test.js`（7 项，DUMATE_ADMIN_DATA 全家桶隔离）——全量 620/620 绿。管理端冒烟（9123 隔离实例）：healthz 带 `role:"admin"`+X-Service 头；agent-setup/clients 未登录 401、登录后真实探测（发现本机 Claude Code 实际指向 15721、codex 无本网关 provider）；balance-refresh 默认 off 文案如实。**前端视图（AgentSetupView）未做**，端点已可脚本调用。

**融合落地第三批（2026-11-08，docs/DUMATE-GATEWAY-MERGE-FEATURES.md 收尾）**：三件。① **AgentSetupView 前端**（`web/src/views/AgentSetupView.vue` + `web/src/api/agentsetup.ts` + 路由 `#/setup`）：补齐第二批「前端视图未做」的尾巴——客户端卡片实时展示探测结果（Claude Code 指向 15721 时如实标「非本网关，apply 会覆盖」，不装作已配置）；写入弹窗的通道下拉按 `src/channels.js` 五条通道列出、API Key 下拉只列**明文已保存**的 key（鉴权强制后 nokey 必 401，默认值就该是能用的），并允许手填；成功后把备份路径/模型/推导出的上下文与输出上限摊在页面上（那是「依据」，不是弹窗里一闪而过的东西）。菜单入口只对 admin 显示（写本机文件属管理操作），与账户管理同款不走 menuKeys 白名单。② **首启凭证自举**（`keys.ensureFirstRun`，P2-9）：网关监听**非回环地址**且一把 key 都没有时自动签发 `first-run` 并把明文打印一次——本机 127.0.0.1 不触发（零打扰），端口暴露时空 key 集合等于所有请求 401，日志里那三行是唯一入口。③ **子 Key**（`keys.js` 的 `parent_id` + `key-quota.js` 家庭桶，P2-8）：父 Key 停用/删除/过期 → 子 Key `parent_revoked`（吊销级联）；**子 Key 的请求同时计入父 Key 的配额桶**（父的限制是全家共享上限，子自己的 daily_limit 是额外收紧），token 双记走「埋点带 `key_parent_id` → reqlog → `addTokens(..., {familyId})`」；只支持两级（父不能再有 parent），`update` 拒绝「自己当父」与「已当父的 Key 变子」。前端 KeysView 加父 Key 下拉（只列独立 Key、编辑时排除自己）、名称列「子 Key · 父 X」标签、删除确认动态提示子 Key 会一并失效。离线验证 `node --test test/unit/key-subkey-bootstrap.test.js`（9 项）；全量 629/629 绿；前端 `npm run build` 通过（vue-tsc 0 错误）。真机（9082/9083，OpenCLI 驱动已登录浏览器）：`#/setup` 渲染真实探测（Claude Code 指向 15721、Codex 无本网关 provider、cc-switch 指路）、写入弹窗通道与 Key 自动选中、`#/keys` 经 API 创建子 Key 后列表显示「子 Key · 父 dumate」，删除清理后恢复六把预置 key。

④ **跨通道额度总览卡**（P2-10，`src/channel-balance.js` + `admin/routes/channel-balance.js` + `ChannelBalanceCard.vue`）：一张卡并排列出五条通道的剩余额度、账号健康、临期账号数。**不跨通道相加**——单位不同（搭子/千问是积分，TRAE/Qoder 是 credits，WorkBuddy 国际版按请求数计），卡片明写「不可相加」且不给总计。口径四条：`remaining=null` 表示取不到（绝不填 0）；部分账号失败显示橙色 tag + tooltip 明细（只显示 `1/2 账号` 不给原因会被当成显示问题）；Qoder 团队共享池 `cap=-1` 标 `unlimited`（不是有限数字，不进合计）；进程内 60s TTL（`DUMATE_CHANNEL_BALANCE_TTL_MS`）。单通道适配器独立 try/catch + 15s 超时（一个通道上游挂了不拖垮整张卡）。搭子复用 `dumate-points.summaryCached`（网页池），千问/TRAE/Qoder/WorkBuddy 各自遍历账号池且**先用 get(id)/findUsable 拿完整账号再换票**——`authStore.list()` 是脱敏视图，直接喂 `session.ensureAccount` 会因拿不到 refreshToken 全 401（真机踩到：Qoder 两账号全 401 而 `/qoder/credits` 正常，差别就在这一行）。临期数据来自 `expiring.info`（四家快照，`info` 新增 `nearest` 字段）与 Qoder 的 grants 账本。卡片挂在五个通道分支**之外**（Dashboard 底部），页头刷新一并触发。离线验证 `node --test test/unit/channel-balance.test.js`（6 项：合计只累已知数值、失败不填 0、超时兜底、TTL、unlimited）；全量 635/635 绿。真机（9083）：五通道真实读数全出（搭子 23735.32 / 千问 14.52（1 账号 401 如实标）/ TRAE 6061.9 / Qoder 3601 / WorkBuddy 10471.61），切 TRAE 通道卡片仍在。

## 2026-11-08 落地（TRAE 调研融合批次，docs/TRAE-GATEWAY-MERGE-FEATURES.md）

> 逐项核对结论、证据与不实现项见 `docs/TRAE-FUSION-CHECKPOINT-2026-11-08.md`。调研文件的 20 项里有 5 项在生成时已有等价实现（9074 自愈、Key 配额/区域、Token 预刷新、图片输入、单号并发上限），未重复开发；P2-15 的「代理池哈希绑定」因无代理池配置证据不做，现有 `proxy-agent.js` 已按账号固定出口。

**通道核心**：① `src/trae-runtime.js` 运行期配置（原子写 + mtime 热读，跨进程），默认全关。管理端 `#/trae-runtime` 可视化；端点 `/api/admin/trae-runtime`、`/max-mode/models`、`/max-mode/apply`。② **P0-4 两态开关**：`auth.js` 的 `modelEnabled` 只拦对话，`findModelUsable` 供 send 用；签到/额度/保活仍走 `findUsable`，全关时 `status().loggedIn=true` 且明确报「关闭了接模型请求」。前端账号卡第二个 switch。③ **P0-3 显式降级**：`traework/degrade.js` 只认 402 / 3003/3004/4008 / 1005 / 订阅专享等确证错误；429 限流、400 参数、内容审核一律不降级；第一尝试吐出任何内容后不降级；API Key 的区域绑定压过 `fallbackRegion`；成功回调 `onDegraded` → 网关非流式写 `X-Trae-Degraded` 头、流式若头已发则写 SSE 注释帧。双失败保留第一次根因。④ **P0-5 Max**：运行期开关 + 白名单与 env 并联，管理端「检测支持的模型 → 一键加入」只认 descriptor `max_mode`，不按名字猜。⑤ **P2-13/16**：积分优先轮询与保留积分护栏默认关；余额未知沉底但不跳过，绝不读成 0。⑥ `keys.modelMatches` 加 fnmatch `*`/`?`（大小写不敏感，无通配符仍是精确匹配），旧 key 行为不变。⑦ **P2-11**：`upgradeRequired` 只认上游 descriptor 显式字段，模型信息表显示「需升级」徽标，不伪装成风控。

**运维与管理端**：⑧ 七类告警规则 + 静默窗/迟滞/恢复（`src/admin/alerts.js` + `/api/admin/alerts`），复用 `notify.js` 的五种 webhook；后台评估 `DUMATE_ALERTS_SCHEDULE_MINUTES`（默认 0 关闭）。⑨ 配置恢复 `POST /api/admin/system/restore`（`src/config-restore.js`）：配置白名单、恢复前自动备份当前态到 `data/config-backup/`（封顶 10 份）、非法整包一口拒掉、响应 no-store；`/system/backup` 补 no-store。⑩ 服务端运行日志：`src/admin/logbuffer.js` 环形 500 行，**入缓冲前整行脱敏**（敏感键/Bearer/sk-/key=value），`/api/admin/logs` 与 SSE `/logs/stream`（回放 + 4 订阅者上限）；前端 `#/logs`。⑪ 侧栏角标：`/traework/status` 的 `alerts` 汇总 + `MainLayout` 的 `a-badge`，余额未知单独计。⑫ 批量凭证运维 `POST /traework/accounts/batch`（`traework/batch.js`，≤200 条、逐条隔离、恢复默认保留上游冷却，`force` 才 `revive`；路由注册在 `/accounts/:id` 之前）。⑬ Prometheus `/metrics`（根路径，另挂 `/api/admin/metrics`；低基数标签、可选 `DUMATE_METRICS_TOKEN`，未配时根路径匿名、管理端路径仍要会话）与月度账单 `/api/admin/monthly-billing{,/export}`（CSV UTF-8 BOM + `= + - @` 公式注入防护，用量页导出按钮）。⑭ 全站 kill switch：`gatewayPaused` 默认关，网关在鉴权**之前**拦所有非 `/health` 请求回 503 `service_paused`，管理台照常。

**验证**：新增 4 个离线单测文件 24 项；全量 `node --test "test/unit/*.test.js"` 655/655 绿；`npm run verify` 41/41 绿；`cd web && npm run build` 通过（vue-tsc 0 错误）。隔离管理端真机（9123，独立 `DUMATE_ADMIN_DATA`，未动 9080/9082/9083）：healthz 身份、七个新只读端点 200、未登录 401、非法运行态键/恢复包/批量 ids 全部 400、运行态 PUT 后热读生效并复位、批量导出脱敏、日志 SSE 回放、CSV 头带 BOM。降级真机链路（额度耗尽/备用模型/响应头）未跑——需要真实额度耗尽账号，编排正确性由打桩端到端单测锁定。

**TRAE 调研收尾（2026-11-08 第四批，`docs/TRAE-GATEWAY-MERGE-FEATURES.md` 20/20 全落地）**：把上一轮标「不做」的 P2-15 与 P2-16 补完——复核后发现它们**不需要外部证据**，此前判断偏保守。

① **P2-16 每日用量护栏**（`src/traework/guard.js`）：与「保留积分」互补——那个看余额快照（还有没有钱），这三项看当日已用量（今天是不是用过头了）：`dailyTokens` / `dailyCredits` / `modelTokens`（按 `(账号, 模型)`）。数据源是本进程落盘事实（`requests.jsonl` 的 `account_id` + `traework-credits.jsonl` 的 consumed 增量），**不打上游、不新增存储**。三条纪律：**未知不拦**（`account_id` 或用量读不到照常放行，把「不知道」当「用完了」会让整池静默不可用）、只拦新请求不打断在途、判定与展示**同一个 `usageOf` 函数**（两处各算一遍必然漂移）。`account_id` 缺失的行不进任何桶，不摊到别人头上。默认关，阈值走 `trae-runtime` 的 `accountGuard`；管理端「运行策略」页有三个输入框 + 「查看今日用量」表（`GET /api/admin/trae-runtime/usage`）。

**前置修复**：埋点原来只记 `account`（显示名，可改可重名可空），没有账号 id。补 `req._upstreamAccountId` → 埋点 `account_id` 字段——按显示名聚合会把两个账号的用量并成一个桶。`onAccount(name, id)` 早就有 id，只是没落。

② **P2-15 代理池稳定分配**（`proxy-agent.js`）：`DUMATE_PROXY_POOL`（逗号/换行分隔）→ `sha256(channel:id) % len` **稳定落点**。三要点：**稳定哈希不是轮询**（重启、增删别的账号不能让出口漂移——出口跳变本身就是异常信号）；**账号显式 `proxy` 永远优先**（手填的出口不被悄悄改掉）；**池空 = 行为不变**。非法条目启动时 fail-fast 抛错，不静默跳过（否则「以为配了 8 个出口、实际只有 3 个」无从发现）。键位用 `__channel` 显式传入——各通道 id 是各自文件里的自增数字，只用 id 会让不同通道的同号账号挤在一个出口。

**验证**：新增 `test/unit/trae-guard.test.js`（8 项）+ `test/unit/proxy-pool.test.js`（8 项）；全量单测 **676/676**、`npm run verify` **41/41**、`npm run build` 通过。真机（9083）：`/trae-runtime/usage` 返回三账号当日用量，`null` 与 `0` 区分正确（无记录显示「—」，账本有记录但消耗为 0 才显示 0）；界面三输入框 + 用量表渲染正常，无前端报错。
