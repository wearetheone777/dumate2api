# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

把百度搭子（DuMate）桌面客户端内部的本地 OpenAI 兼容端点，转成 **OpenAI / Anthropic / Google 三协议网关**，供 Codex CLI、Claude Code、cc-switch 使用。它同时是一个**进程管理器**——负责无 GUI 拉起 DuMate 的 Go 后端。

仓库里跑着几个**互不代理对方的独立进程**（外加一个自建上游）：

| 进程 | 端口 | 入口 | 职责 |
|---|---|---|---|
| DuMate 后端 | 8980 | `upstream-launcher.js` 拉起 | 真实模型链路 |
| **网关** | 9080 | **`src/server.js`** | 对外服务，给 cc-switch / Codex / Claude Code 长期用 |
| 管理端 | 9081 | `src/admin/server.js` | 管理 API（`/api/admin/*`）+ 托管 `web/dist`，读 9080 |
| 多账号网关 | 9084 | `src/web-gateway.js` | 网页凭证跑模型（主网关 `DUMATE_DUMATE_SOURCE=web` 默认承接同链路后按需保留；`src/mcp-server.js` 头注释称该 9084 进程「已废弃」，其入口 web-gateway.js 仍可跑） |
| MCP / CLI | stdio（无端口） | `src/mcp-server.js` | MCP 宿主 / 终端管道直用搭子：进程内调 web-pool（多账号轮询 + 故障转移全套复用），**不经 keys.js 鉴权**——stdio 边界即信任边界 |

> **端口只有一套默认值：网关 9080 / 管理端 9081。** 2026-11 起取消了「稳定版 9080 / 开发版 9082」双轨：
> `stable/` 冻结快照目录已整体删除（它早已落后主目录一百多个文件、且不含管理端，无法独立成一套服务），
> 同步脚本 `scripts/snapshot-closure.js` 与发布流程 `docs/STABLE-SNAPSHOT.md` 一并退役。
> 现在 `npm start` / `npm run admin` / `start.bat` / `start-dev.bat` 全部指向同一套端口与同一份 `src/`。
> `DUMATE2API_PORT` / `DUMATE_ADMIN_PORT` 仍可显式覆盖（并行跑多个实例时用），但**不再是默认行为**。

> **9080 是对外端口，不一定是常驻进程**：动手前先 `netstat -ano | grep ":9080"` 确认是否在跑；
> 要不要启动/重启一个对外服务是用户的决定，不是随手操作的一部分。

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
| ~~`stable/` 冻结快照与发布流程~~ | 已退役（2026-11 端口统一，目录与 `docs/STABLE-SNAPSHOT.md` 均已删除） |
| 凭证、账号显示名、桌面→网页回落 | `docs/CREDENTIALS-ACCOUNTS.md` |
| 模型清单 / 思考档位 / 积分分池（2026-11-15 融合） | `docs/FUSION-LANDING-2026-11-15.md`（调研：`docs/GITHUB-DUMATE-RESEARCH-2026-11-15.md`） |
| **TRAE 调研（2026-11-16）的落地总览 + 发布评估** | `docs/LANDING-2026-11-16.md`（调研：`docs/GITHUB-TRAE-RESEARCH-2026-11-16.md`）。**问「这一轮做了什么/能不能发版」先看它** |
| 完整使用说明（面向使用者，非开发向） | `docs/USER_MANUAL.md` |
| **2026-11 各落地批次全文**（实测依据、验证命令、踩坑细节；2026-11-23 从 CLAUDE.md 逐字归档） | `docs/LANDING-ARCHIVE-2026-11.md`。**查某项行为「为什么是这样」先看它** |
| 新上游接入模板（通道七件套骨架 + 五步清单） | `templates/channel-skel/README.md`（底本 `src/qoder/`） |

### 改动前必读的五条

这几条跨所有通道，违反任何一条都会造成静默故障（不报错、返回 200、结果错）。细节见「必须知道的约定与陷阱」与各通道文档：

1. **通道 id 单一来源是 `src/channels.js`**——新增通道只改这一处，`keys.js`、管理端校验、用量筛选都 require 它。
2. **翻译层禁止 `mapModel`**——直连通道的前缀（`qwen/`、`traework/`、`qoder/`、`workbuddy/`）会在映射后丢失并静默落到搭子。
3. **直连通道失败必须让翻译器收尾，不能裸 `res.end()`**——否则 `ERR_STREAM_WRITE_AFTER_END` 直接打挂网关进程。
4. **流式解析必须用 `StringDecoder`**，不能逐块 `toString('utf8')`——跨 chunk 的多字节汉字会变成 U+FFFD。
5. **余额 `null` ≠ 0**——读成 0 会把「查不到」显示成「用完了」，然后被当故障排查。

**2026-11-15 又加两条**（都是「踩错会静默故障」级）：

6. **桌面端模型清单的名字只能按链路直传**（`modelmap.mapModel(name, {catalog})`）。
   清单里 22 个是**云端网关路由名**（`kimi-k31`/`glm-53`…），本地 8980 只认三个。
   云端链路（`DUMATE_SOURCE=web`，默认）直传，桌面链路仍落 fallback——无条件直传会
   推翻 `test/unit/cloud-model-map.test.js` 的回归守卫，让桌面链路把 8980 不认识的名字
   发过去吃 404。清单三级降级（客户端配置 → `data/dumate-catalog.json` → 包内默认
   `src/dumate-catalog.default.json`）见 `src/dumate-catalog.js`（包内默认必须随代码入库，
   不能放 gitignore 的 `data/`）。
   **三处判据必须一致**：四个协议入口 require 的是 `anthropic.js` 的 `mapModel` 包装
   （必须转发第二个 `opts` 实参）、`server.js` 的 `catalogLink()`（auto 模式下网页池
   可回落也算云端）、`fallback-web` 用的 `toCloudModel`（也要认同一份清单）。任一处漏了，
   清单名都会在链路中途被静默改写成 `model-text`，响应仍是 200。
7. **搭子思考档位只对同后端白名单生效**（`src/dumate-reasoning.js`）：只认 `none/low/high/max`，
   只对 `deepseek-v41-flash` / `model-text` / `dm-auto-model/{text,mm}.L0` 等同一后端生效；
   `minimal`/`medium`（翻译层五档词表里的）刻意不映射。改之前先读该文件头三个边界。
8. **四通道共用「凭证退场」口径，判废只有一处**（2026-11-28）：换票被上游**明确拒绝**
   才标 `refreshRetiredAt`（判据各通道一份：TRAE/WorkBuddy 认原文措辞、Qoder 认
   `exchange` 的 `expired:true`、千问认 401/403 或 `INVALID_REFRESH_TOKEN`/`invalid_grant`；
   **认不出不猜**——网络抖误标要人工重新登录才能解）。标记的语义是「换不了票」**不是**
   「号不能用」：access 未过期时照样能跑，所以判废是**双条件**（标记 + access 已过期）
   且只在 `channel-pool.pickCandidate` 入口做一次（`credentialDead()`）。别在通道里各写
   一遍——TRAE 与 WorkBuddy 曾各自实现，第三第四份必然漂移。`upsert` 带新 refreshToken
   时必须清标记，否则重新登录了也用不了。

## 命令

```bash
npm start                  # 启动网关（默认 9080，会自动拉起 DuMate 后端）
npm run admin              # 启动管理端（默认 9081）
npm test                   # 全量单测（test/*.test.js + test/unit/*.test.js）——**离线**，不需要任何运行中的服务
npm run test:smoke         # 旧 smoke 断言套件（node test/smoke.js），直接打 9080，需先起网关
npm run verify             # 全量回归聚合器（node test/run-all.js）：单测 + 全部离线 verify 脚本，全绿才算过
node test/run-all.js --live        # verify 追加需要运行中服务的用例（verify-ccswitch 打 9080）
node test/run-all.js --only qoder  # 只跑名字含 qoder 的 verify 脚本
npm run mcp                # MCP stdio 模式（挂进 Claude Desktop 等 MCP 宿主）
npm run cli "问题"         # CLI 单次问答 / 交互 REPL（进程内走 web-pool，不经 HTTP 鉴权）
npm run mock               # 启动假上游（端口 52890），离线自测用
node test/probe-oai.js         # 只打 OpenAI 格式的流式探测，直接看原始 SSE
node test/probe-anth.js        # 只打 Anthropic 格式的流式探测（含 x-api-key / anthropic-version 头）
node src/admin/server.js --reset-admin --password=xxxxxx   # 重设管理员口令
node src/web-gateway.js    # 启动多账号网关（默认 9084，按需）
node test/traework-login.js login|checkin|chat   # TRAE 命令行自测（交互式，见下）
node test/qoder-cli.js login [cn|global]|status|models|quota|checkin|chat|remove   # Qoder 命令行自测（同定位；先 login）
cd web && npm run dev      # 前端开发（Vite 5173，/api 代理到 9081）
cd web && npm run build    # 前端构建（vue-tsc 类型检查 + vite build → web/dist）
```

**单测与 verify 全部离线**：每个用例自带 `DUMATE_POOL_STATE` 临时文件隔离（读 livecfg 的模块在测试里必须钉住 `DUMATE_ADMIN_DATA`，否则本机面板配置会让断言机器相关）。**两者覆盖面不同，发布前都要绿**：`npm run verify` 的单测步只扫 `test/unit/`；顶层 `test/*.test.js`（pool / cors / keepalive / integration 等约 17 个）只在 `npm test` 里跑。全量跑偶有因并发负载/环境串扰失败的，**单跑复核——单跑绿就不是回归**（多次验证过的模式）。

**`test/traework-login.js` 是不开管理端也能验证 TRAE 通道的入口**：`login` 生成授权链接（粘回调落盘）→ `checkin` 签到并查额度 → `chat "你好"` 发一条对话。凭证由它自己走 OAuth 换取，不依赖 TRAE 客户端。排查「TRAE 到底通不通」时比在界面里点更快。

**需要真流量的三个单点探针**：`test/smoke.js`（全套断言）、`test/probe-oai.js`、`test/probe-anth.js`——后两者各只打一种协议、把原始 SSE 打到 stdout，用来区分「网关翻译错」还是「上游返回错」。三者都硬编码打 9080（`node test/verify-ccswitch.js` 同）。要在别的端口跑同一套断言，临时把 `port: 9080` 换成读环境变量即可——不要改文件本身。

**端口已统一（2026-11）**：网关 9080 / 管理端 9081，全仓库只有这一套默认值。`start-dev.bat` 与 `start.bat` 行为一致，都起 9080 + 9081；管理端默认读 `DUMATE_ADMIN_GATEWAY_PORT`，未设即 9080，因此**不需要再手动指定**。并行跑第二个实例时才用 `DUMATE2API_PORT` / `DUMATE_ADMIN_PORT` / `DUMATE_ADMIN_GATEWAY_PORT` 显式错开。

`start.bat` / `stop.bat` / `restart.bat` 是 Windows 生命周期脚本。`stop.bat` 用 `taskkill /T` 杀进程树（后端是网关的子进程），**不动 DuMate GUI 和 cc-switch**，可重复执行；`stop.bat nopause` 供 `restart.bat` 内部调用。

**桌面快捷方式走的是托盘应用，不是 `start-dev.bat`**：`launcher/dumate2api-tray.vbs`
（隐藏启动）→ `launcher/dumate2api-tray.ps1`（PowerShell + WinForms，零第三方依赖）。
提供启动/关闭服务、打开管理端、完全退出；前台窗口滚动显示两个进程的实时日志；
**点关闭按钮只收进托盘、服务继续跑**，退出必须走「完全退出」。托盘右键是同一套功能。

三个实现细节，改之前先读：

1. **`.ps1` 存成 UTF-8 带 BOM**。PowerShell 5.1 读无 BOM 的 `.ps1` 会按 ANSI
   解码，中文全乱码甚至解析失败。这与仓库其他文本文件（`.md` 等无 BOM UTF-8）的惯例相反，
   但 PS 5.1 是硬要求——别「顺手修正」掉。（`.vbs` 反过来必须**纯 ASCII**，
   wscript 按 ANSI 读。）
2. **必须显式 `ShowWindow(SW_SHOW)`**。启动器用窗口样式 0 隐藏控制台，而 Windows
   会把 `STARTUPINFO` 的 `SW_HIDE` 应用到该进程的**第一次 ShowWindow**——那一次
   恰好是 WinForms 显示主窗体。不覆盖就会出现「服务起来了、进程活着、窗口永不出现」
   （`MainWindowHandle = 0`）。所以在 `add_Shown` 里再调一次。
3. **日志靠「重定向到文件 + 轮询字节偏移」**（`data/launcher-9080.log` /
   `-9081.log`），不是抓 stdout：两个进程的输出要合并加前缀，在 PowerShell 里
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

**改完后端代码必须重启对应的管理端/网关进程。** 后端路由在进程启动时 `require` 一次，不会热更新；而 `web/dist` 是每次请求读磁盘。这个不对称会造成「前端看着是新的、接口返回旧数据」的假象——排查时先看进程启动时间（`netstat -ano | grep ":9081"` 找 pid，再查 `StartTime`），不要先怀疑构建。

重启命令：

```bash
# 管理端（9081）
DUMATE_ADMIN_PORT=9081 DUMATE_ADMIN_GATEWAY_PORT=9080 node src/admin/server.js
# 网关（9080）
DUMATE2API_PORT=9080 node src/server.js
```

纯前端改动才需要 `npm run build`；**纯后端改动不必重新构建**。

另有两个一键脚本：`start-dev.bat`（同时起网关 9080 + 管理端 9081）、`start-web-gateway.bat`（起 9084）。

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

**Qoder 2026-11-08 融合批（P0-1/P0-2/P0-3/P1-6/P1-7/P1-8/P1-11/P2-18）**——七套单测，
全离线：

- `node --test test/unit/qoder-runtime.test.js`（18 项）——运行期配置热生效、白名单、
  越界拒绝、并发闸门读面板值、`Store` 在全新数据目录下不 ENOENT。
- `node --test test/unit/qoder-autocheckin.test.js`（17 项）——时点/只后延抖动/补跑、
  三态判定（已签/可签/无可领 skipped/**未知不签**）、当日 30 分钟退避与跨日重置、
  换票失败如实报 refresh、签成写账本。
- `node --test test/unit/qoder-claim-verify.test.js`（16 项）——归属核验三态
  （claimed / same_person / **unverified 不猜**）、核验端点是 GET 且**只调 /reward
  不调 /claim**、grantId 不一致不认账、核验失败不改变签到结论。
- `node --test test/unit/qoder-balance-probe.test.js`（8 项）——轮转探活（每轮一个号、
  N 轮全覆盖）、有效余额 = addOn + user、`credits==null` 一律不写池。
- `node --test test/unit/qoder-pick-strategy.test.js`（6 项）——least-inflight 排序、
  队首冷却时让位、**粘性优先于策略**、env 按通道隔离。
- `node --test test/unit/qoder-telemetry.test.js`（11 项）——queued/throttled/rejected
  三类计数、环形桶清理、`waitOnly` 保守判据、**接线回归**（防「模块写好、无调用方」）。
- `node --test test/unit/qoder-expiry-distribution.test.js`（8 项）——按自然日聚合、
  日均需耗量、危险度分级、`null` 不参与合计。
- `node --test test/unit/qoder-model-locks.test.js`（11 项）——模型锁池视图（P2-19）：
  按 uid 前缀过滤（池是所有通道共用的）、`earliestInMs` 与 `allClearInMs` 分开给、
  无锁定是正常态（空数组不造假行）、`available = 总数 − 被锁账号数`。
- `node --test test/unit/qoder-output-probe.test.js`（15 项）——输出上限主动探测（P2-20）。
  **真机实测推翻了 workbuddy 那套判据**：Qoder **根本不看 `max_tokens`**（传 4096
  回来 24706/23363），所以判据改为「`completion > requested × 1.05` → `unbounded`
  （没有可测的上限）」，且**第一档即停**；同步 HTTP 必然超时（单档 214~256 秒），
  编排改**触发式**（与 `/autocheckin/run` 同款）。

**Qoder 的 P2 两项**（都离线，另有一个 HTTP 层脚本）：
`node test/verify-qoder-model-locks-api.js`（7 项，用**真实池单例**造锁，验 HTTP 层）；
`node test/verify-qoder-runtime-api.js`（10 项，运行期配置与签到排程的端点）。

**协议杂项批**（P2-24 择项落地，2026-11-08）：
`node --test test/unit/duplicated-v1-hint.test.js`（4 项，重复 `/v1` 的带提示 404，
**从源码抠正则**锁语义防漂移）、`node --test test/unit/qoder-vl-guard.test.js`
（10 项，VL 前置校验——**真机实测 Qoder 12/12 模型 `is_vl=true`，当前不触发拦截**，
保留是为了上游收紧时自动生效）。
**未做的三项各有实测依据**：`code 115` 按既有定案是「无语义渲染码 → 400 + 不换号」
（与调研建议的换号处置相反，已由 `verify-qoder-error-surface.js` 锁定）；
Anthropic 桥 system 改 user 与本项目的前缀缓存实现方向不同（改角色会触及上游对
system 位置的硬约束）；`/v1/usage` 早已存在（`handleKeyUsage`）。逐条理由见
`docs/CHANNEL-QODER.md` 的「协议杂项批」节。

**订阅周期统计（P1-10）**：`node --test test/unit/qoder-period.test.js`（10 项）——
`src/qoder/period.js` 四条边界治理规则（哨兵值 9999 过滤 / 首次保留累计 /
未推进与后退 ignore、<7 天同周期、≥7 天续期 / 均值只数 billable 帧）。
**真机实测：Free 账号不存在订阅周期**（`quota/usage` 无周期字段、`/plan` 的
`end_date=0`），所以 Free 号 `bounded=false` 是正确结论——积分明细页会如实标
「部分账号未观察到周期边界，此为全量累计口径」。等真出现付费账号再验边界字段；
**在 Free 号上反复找周期字段是无效劳动**。

**用量分析页（P2-17）**：`GET /api/admin/qoder/usage`——reqlog ⨝ credits 账本
（按 `req_id`），补 `/usage/overview` 没有的三块：**按账号归因**（埋点前的老行
如实归「(未标注)」，不猜）、**积分/1M Token 折算**（实测成本密度，错峰折扣与
缓存命中都体现在实测值里）、**本周期消耗卡**（P1-10 口径）。口径：成功请求才进
均值、credits 缺失不补 0（折算只将有值的行为分母）、吐字速率只算有值的流式请求。
真机首批：1183 请求 / 39.4M tokens / 密度 176.62 积分每百万 token / 33.4 tok/s。
前端在积分明细页 Qoder 区（「用量分析」卡）。

**管理端安全加固（P2-21 收尾）**：`node --test test/unit/admin-security-headers.test.js`
（9 项）——安全响应头本批补齐（HTML 完整 CSP + 全响应 nosniff/DENY/no-referrer），
清单其余各项（登录退避/timingSafeEqual/Cookie 属性/body-limit/路径穿越/CORS
fail-closed/无 v-html）经核对早已落地，本批加**接线自证**防回退。CSP 的
`style-src 'unsafe-inline'` 是实测必要（Vue :style 与 ECharts 内联样式都是
style 属性），别盲目收紧——真机回归已过（15 菜单/2 画布/0 破图）。
**P2-15/16/22/23 经核对已被现有功能覆盖**（聊天测试台、请求日志筛选+
recordClientInfo、cors.js fail-closed、登录弹窗+文件 mtime 热加载），无需新做。
至此 Qoder 调研清单**全部处理完毕**：管理端公网化前置清单就绪，公网化只剩改
监听地址。

`verify-qoder-read-idle.js` 是「运行期配置」改动的**行为回归锚**：它靠「改 env +
删 require.cache」驱动三种计时器，10 条不变量全绿才说明「模块加载时读一次」确实
改成现读且语义没变。细节见 `docs/CHANNEL-QODER.md` 的「运行期配置与自动签到」节。

**`node test/qoder-cli.js` 是不开管理端也能验证 Qoder 通道的入口**（与 `traework-login.js` 同定位）：
`login [cn|global]` 生成授权链接 → `status` → `models`（带倍率排序）→ `quota` →
`checkin`（领积分）→ `chat "你好" [model]`（**默认用最省的 gfmodel**）→ `remove <id>`。
排查「Qoder 到底通不通」时比在界面里点更快。

离线自测的完整流程（无需安装 DuMate）：`npm test` 与 `npm run verify` 离线直跑，**不需要起任何服务**；需要真流量验证网关链路时才起网关（打 9080 的只有 `npm run test:smoke` / probe 脚本 / `verify-ccswitch`）。

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

**响应写完后必须停手，否则打挂进程。** `send()` 直接 `res.write()` 时，若 `res.end()` 之后还有收尾逻辑补发事件（如 reasoning 的 done），会触发 `ERR_STREAM_WRITE_AFTER_END`——这是**未捕获的 error 事件，会直接让网关进程退出**（网关进程整个挂掉，不是单个请求失败）。修法：`send()` 带 `ended` / `res.writableEnded` / `res.destroyed` 守卫，两处 `res.end()` 都标记 `ended`。

**直连通道失败时必须让翻译器收尾，不能裸 `res.end()`（2026-10-03 修，崩溃级）。**
`handleDirectChannel` 的 catch 原来无条件 `shim.end()` + `res.end()`，有两处后果，
且**三个直连通道（千问/TRAE/Qoder）全部中招**——实测触发它的是千问额度耗尽（402）：

1. 翻译器的 `upstreamRes.on('end')` 是**异步**触发的，在 catch 同步 `res.end()` 之后
   才跑，于是 `sendEvent` 调 `res.write()` 抛 `ERR_STREAM_WRITE_AFTER_END`。
   流式 res 的 `'error'` 事件**没有监听者** → 未捕获异常 → **网关进程直接退出**。
   实测：网关进程于 23:51 退出、00:03 才重启，期间 cc-switch 连报 8 次
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

**`DUMATE2API_KEY` 与 `DUMATE_REQUIRE_KEY` 的现状（2026-11-01）**：`DUMATE2API_KEY` 已接线（命中 env 密钥或任一登记 key 即放行）；`DUMATE_REQUIRE_KEY` 则**因鉴权强制而废除**——「不鉴权」形态已删除，模型端点一律要求 key，设 0/1 都不改变行为（显式设 0 时启动日志告警）。启动脚本里的设置保留（对新代码无害）。

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

**`tools/ui-shot.js` 在 WSL 里要经 Windows node 跑（2026-11-28 实测）。** 本机
WSL 没有 Linux 浏览器，工具默认起的是 Windows Edge——而 WSL node 会把
`os.tmpdir()`（`/tmp/...`）当 `--user-data-dir` 传给 Edge，**Windows 程序读不了
Linux 路径，Edge 起不来、devtools 端口永远无响应**（WSL networkMode=mirrored
不是问题，路径才是）。正确姿势：

```bash
"/mnt/c/Users/zhou/AppData/Local/Author Software/nvm/.nodejs/node.exe" \
  '\\wsl.localhost\Ubuntu-24.04\home\zhou\code\claude\demo\dumate2api\tools\ui-shot.js' \
  --url "http://127.0.0.1:9085/#/页面" --user admin --pass "$PW" \
  --channel workbuddy --out 'C:\Users\zhou\AppData\Local\Temp\x.png' ...
```

脚本经 UNC 访问、profile/输出全落 Windows 侧，Windows→WSL 的 localhost 在
mirrored 模式下可达。要截图的页面若需要登录，用**隔离数据目录** +
`DUMATE_ADMIN_PORT=9085 ... node src/admin/server.js --reset-admin` 起临时管理端，
别在真 9081 上试密码。另：`--click` 匹配按钮 innerText，**AntD 两字按钮自动插
空格**（渲染成「编 辑」「配 置」），--click 传带空格的形态；断言文本避开会自动
换行的长句（innerText 换行会断开 includes 匹配）。

**新增运行态配置字段要改三处，不是一处（2026-11-16 踩过）。**
`src/trae-runtime.js` 里 `defaults()`、`FIELDS`、以及 **`Load()` 的返回体**是三份
独立的字段清单——只加前两个，`Store()` 写盘成功、接口读出来却恒 `undefined`
（`crossRegionFailover` 就是这么"存进去了但看不见"的）。单测锁在
`test/unit/trae-auth-reject.test.js` 的「Load() 覆盖全部 FIELDS」。
这和「通道 id 单一来源」「模型能力三处判据一致」是同一类坑：**同一事实写了两份，
迟早不一致**。

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
| `DUMATE_REQUIRE_KEY` | 已废除 | **鉴权已强制**（2026-11-01），无 key 的模型请求一律 401；设 `0` 不再改变行为，仅启动日志告警 |
| `DUMATE_ADMIN_PORT` / `DUMATE_ADMIN_HOST` | `9081` / `127.0.0.1` | 管理端监听 |
| `DUMATE_ADMIN_DATA` | `<repo>/data` | 覆盖数据目录（管理端与网关必须一致） |
| `DUMATE_MIN_MAX_TOKENS` / `DUMATE_MAX_MAX_TOKENS` | `65536` / `131072` | 输出预算钳制区间（`0` 关闭下限策略） |
| `DUMATE_AUTOSTART` | `auto` | `auto`=无实例才拉起 / `always`=总是自己拉起 / `off`=只用已有实例 |
| `DUMATE_UPSTREAM_PORT` | `8980` | 自建后端端口 |
| `DUMATE_INSTALL_DIR` | DuMate 默认安装路径 | 安装目录不在默认位置时设置 |
| `DUMATE_UPSTREAM_TIMEOUT_MS` | `600000` | 上游请求超时 |
| `DUMATE_UPSTREAM_LOG` / `DUMATE_DEBUG` | - | 设为 `1` 输出后端日志 / 发现过程调试信息 |
| `DUMATE_ADMIN_GATEWAY_PORT` | `9080` | **管理端去读哪个网关的状态**。端口已统一，默认即对；并行跑第二个实例时才需要错开 |
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
| `DUMATE_TRAEWORK_MODELS_CACHE_SCOPES` | `8` | 模型表缓存的**作用域条数上限**（每区每账号一条，LRU 淘汰最久未用）。作用域 = 区域+账号+`raw_chat_function`+客户端版本；写小会让账号多的人反复重拉，写大只多内存 |
| `DUMATE_TRAEWORK_MODELS_WARM_MAX` | `3` | 启动预热时**每区**按账号预热的个数上限。预热是批量请求，账号多不能变成上游风暴；没预热的号在它第一次接请求时按需拉（带单飞） |
| `DUMATE_TRAEWORK_LOGIN_PORT` | `18080` | 登录**回环回调**的监听端口（`oauth-callback.js`）。默认 18080 = 2026-11-03 真机验证过的那条 `auth_callback_url`；**改了要重启管理端**，`auth_callback_url` 会跟着变。被占用时 `/login/start` 明确返回 503 并让前端退回手动粘贴，**不静默换端口** |
| `DUMATE_TRAEWORK_REPAIR_RETRY` | `1` | 「播报即收尾」的重试次数上限。`0` 关闭整个修复（见 `docs/CROSS-CHANNEL.md`）。**可被管理端「通道风控」面板覆盖，面板值现读、无需重启** |
| `DUMATE_TRAEWORK_HOLD_CAP` | `600` | 正文缓冲门的阈值（字符）。超过就转直发，避免长回答被扣住等判定 |
| `DUMATE_QWENWORK_REPAIR_RETRY` / `DUMATE_QODER_REPAIR_RETRY` | `1` | 同上，千问与 Qoder 各一套（`src/repair.js` 的 `envCaps`）。互不影响。**可被管理端「通道风控」面板覆盖** |
| `DUMATE_QWENWORK_HOLD_CAP` / `DUMATE_QODER_HOLD_CAP` | `600` | 同上，千问与 Qoder 各一套 |
| `DUMATE_WORKBUDDY_REPAIR_RETRY` / `_HOLD_CAP` | `1` / `600` | 同上，WorkBuddy 一套（2026-11-04 接入共享修复） |
| `DUMATE_WORKBUDDY_TASKS_SWEEP` | 未设（关闭） | 成长任务补领清扫的**自动化**开关（autocheckin 第四腿：accept 幂等报名 + claim 完成未领 + 连登兑换）。默认关——写操作独立开关纪律；管理端 `/tasks/*` 手动按钮不受它管。端点定案与安全形状见 `docs/CHANNEL-WORKBUDDY.md` 11.5 |
| `DUMATE_WORKBUDDY_WINDOW_PROBE` | 未设（开启） | 设 `0` 关闭 6004 模型额度窗口探针（批次十，`src/workbuddy/windowprobe.js`）：登记侧在 model_cap 分支（带重置墙钟才登记），执行侧网关进程内 30s 巡检、到点发最小请求（auxiliary，真实计费）钉住窗口起点；探针过选号闸门、不喂池。管理端 `/api/admin/workbuddy/windows[/run]` 可查表/立即探针。见 `docs/CHANNEL-WORKBUDDY.md` 11.12 |
| `DUMATE_WORKBUDDY_DAILY_MODELS` | 未设（自动） | 网页打卡候选模型序列（批次十一，逗号/分号/换行分隔）。显式序列**整体优先且不重排**；未设 = 自动模式：实时目录免费模型在先（探针实证 `hy4flash-free` 被沙箱接受，rate 0）+ `deepseek-v4.1-flash` 收尾保连登；目录拉不到 → [flash] 兜底。额度/限流失败自动换候选，11140/401 立即停。见 `docs/CHANNEL-WORKBUDDY.md` 11.13 |
| `DUMATE_WORKBUDDY_WEB_BUDGET_MS` | `600000` | 单账号网页打卡总预算（ms），0 不限：每轮等待与退避都从它里扣，剩余 <30s 不再开新轮，用尽回 phase=budget 明确结论 |
| `DUMATE_WORKBUDDY_WEB_RETRY_BACKOFF` / `_MAX` | `5` / `30` | 打卡候选轮次间退避基数/封顶（**秒**，指数 ×2^n）；只补 create/session 阶段（turn 已等满 waitMs）。0 = 关退避 |
| `DUMATE_WORKBUDDY_MIN_MAX_TOKENS` | `16384` | WorkBuddy 输出预算下限（`budget.js` 的 `WB_FLOOR`，reasoning 与正文抢预算） |
| `DUMATE_WORKBUDDY_MODELS_CACHE_MS` | `600000` | WorkBuddy 模型表缓存时长（10 分钟，按区域分缓存） |
| `DUMATE_WORKBUDDY_APP_VERSION` | 未设（按区域兜底 5.5.6 / 5.5.2） | 覆盖客户端版本号（进 `X-IDE-Version` 与 chat UA） |
| `DUMATE_WORKBUDDY_CLI_UA` | `CLI/2.63.2 CodeBuddy/2.63.2` | 模型目录/刷新请求的 UA（上游按它识别 CLI 客户端形态） |
| WorkBuddy 融合批（2026-11-08）九项 | 见文档 | 连坐四参数（`DUMATE_WORKBUDDY_RESTRICTION_*` / `_RESTRICTED_ROTATE_MAX`，**运行期配置**`data/workbuddy-runtime.json`）、取证（`DUMATE_WORKBUDDY_DUMP_11_128` = `1` 摘要 / `full` 原文、`_DUMP_CODES`）、护栏快照（`_CREDITS_TTL_MS` / `_CREDITS_SNAPSHOT_FILE`）、签到排程（`_CHECKIN_HOUR` / `_MINUTE`）——**逐项口径见 `docs/CHANNEL-WORKBUDDY.md` 第 11 条** |
| `DUMATE_BODY_DRAIN_MS` | `5000` | 请求体超限后「先回 413」的排空时限（ms），到期 destroy。`0` = 立即断开。原实现读完才回，大包上传中的 RST 会把 413 吞成「连接被重置」 |
| `DUMATE_POOL_CREDIT_FLOOR` | 未设（`0` 关闭） | pool 层**保留积分下限**：写进池的余额低于它时该账号不进候选（`floorBlockedFor`）。数据源是 `channel-pool.noteCredits`（WorkBuddy 由 `keepalive.persistSnapshots` 顺带写入）。**`createPool` 时定死，改它要重启网关**——`/api/admin/workbuddy/guard` 会回 `poolFloor` 报当前实际生效值，界面在两边不一致时标红提示。与 `guard.threshold` 不是一回事（那个是快照级选号过滤、有 6h TTL） |
| `DUMATE_PORT_PROBE` | 未设（开启） | 启动前端口占用检查（能连上即算占用，`/health` 不回话也算）。`0` 关闭——容器/编排里端口由外部占用时用 |
| `DUMATE_QODER_FIRST_BYTE_MS` | `60000` | Qoder 上游**首字节**超时（ms），挡「连响应头都不给」的挂起。`0` 关闭 |
| `DUMATE_QODER_CONTENT_MS` | `90000` | Qoder 上游**无内容**超时（ms）：排队时上游先回一个空 ack 帧再沉默，首字节计时器会被它清掉，只有这个计时器兜底。只在**还没转发过真实内容**时计时，有内容即撤销。**90s 的依据是成功请求首字实测 > 6s 占 14.4%、> 30s 占 7.6%、max 63.9s**——旧的 12s/6s 会把大上下文 prefill 当成排队误杀（详见 `docs/CHANNEL-QODER.md`）。真排队由 10605 信封在 200~680ms 内识别，不走这个计时器。`0` 关闭 |
| `DUMATE_QODER_QUEUE_PATIENCE_MS` | `6000` | 排队重试的**总预算**（ms）。实测推翻了「按上游时长耐心等」的旧结论：排队是请求级随机，等 30 秒也不保证放行，所以改为快速轮询几轮（信封本身 150~1000ms 就到）仍失败就如实回 429。`0` = 拿到限流立刻回 429 |
| `DUMATE_QODER_QUEUE_STEP_MS` | `1500` | 排队轮询间隔（ms）。过长恰恰是用户感知的「慢」（原 3000ms × 5 轮 = 15 秒纯等待） |
| `DUMATE_QODER_READ_IDLE_MS` | `120000` | Qoder 上游**读空闲**超时（ms），每块数据重置，挡「先响应后沉默」的限流排队（见 `docs/CHANNEL-QODER.md`）。**必须大于首字节超时**，否则两计时器抢跑。`0` 关闭 |
| `DUMATE_THROTTLE_MAX_MS` | `600000` | 排队/限流冷却的**上限**（ms，千问与 Qoder 共用）。上游按自己的队列长度给 `waitTime`（实测 7015 秒），照单全收会把账号锁近两小时；封顶后最多等这么久再探一次。**管理端「通道风控」页可热改覆盖**（面板 > env > 默认，解析单一实现 `src/throttle.js`），改完不需要重启任何进程 |
| `DUMATE_IMAGE_MAX_MB` | 未设（不限） | **单张内联图片**上限（MB）。超限回 413 并指认「第几张、多大、上限多少」，默认不限（没有实测依据的阈值只会挡住能用的场景）。管理端「通道风控」页可覆盖（面板按字节存，优先级 面板 > env > 不限），解析在 `src/image-budget.js` |
| `DUMATE_IMAGE_MAX_TOTAL_MB` | 未设（不限） | **单请求内联图片合计**上限（MB）。与单张上限是两回事：多张小图加起来照样能把请求体撑到 32MB 的 `DUMATE_MAX_BODY_MB` 线上 |
| `DUMATE_IMAGE_MAX_EDGE` | 未设（不缩） | **长边像素**上限。设了才会压缩：超限的内联 **PNG** 就地缩到这个长边并重编码（`src/png.js`，纯 JS + 内置 zlib）。**JPEG 不缩**（要 huffman 解码，另开一批）。管理端「通道风控」页可覆盖 |
| `DUMATE_IMAGE_CACHE_MB` | `32` | 图片压缩结果的缓存上限（MB，`0` = 关缓存）。键是**原图指纹**，会话每轮重发同一张图时直接复用——实测同一张 1.3MB 截图：首次 264ms（含缩放+重编码），命中后 11ms |
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
| `DUMATE_QODER_INFLIGHT_MAX` | `0`（= 池默认 4） | **单号并发闸门**（`channel-pool` 的通道级在途帽）。Qoder 的 10605 排队是请求级随机，并发越高越容易撞；设 `1` = 单号串行、超出在**本地排队**。调大无意义（超过上游并发窗口就是撞限流）。面板 `concurrency.inflightMax` 优先于本变量 |
| `DUMATE_QODER_MIN_INTERVAL_MS` | `0`（关） | 单号最小请求间隔（ms）：上次选号后不足间隔的账号本轮跳过（busy，不惩罚）。约束**发射节奏**不是请求时长。面板 `concurrency.minIntervalMs` 优先 |
| `DUMATE_QODER_PICK_STRATEGY` | 未设（池默认加权抽签） | 设 `least-inflight` = **最少在途优先**（同分按最久未被选）。加权抽签会把流量压到余额高的号，那恰是最容易排队的时候。**粘性优先于本策略**（前缀缓存命中率比排队概率更值钱）。面板 `concurrency.pickStrategy` 优先 |
| `DUMATE_QODER_CHECKIN_HOUR` / `_MINUTE` | `10` / `15` | 自动签到排程的每日时点。**取 10:15 而不是 00:00**：上游活动 `Daily reset: 10:00 (UTC+8)`，00:00 去签会撞在「昨天已领、今天没开」的格子里。开关默认关，面板 `#/qoder-runtime` 打开 |
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
| `DUMATE_EXPOSE_CATALOG` | 未设（开启） | 设 `0` 关闭「/v1/models 追加桌面端模型清单条目」（回到只列 exposed 三条）。只在 `DUMATE_SOURCE=web` 云端链路生效 |
| `DUMATE_OPENCODE_CONFIG` | 自动探测 | 钉死客户端 `opencode.json` 绝对路径（模型清单真相源；探测路径见 `src/dumate-catalog.js`） |
| `DUMATE_DESENSITIZE` | 未设（关闭） | 设 `1` 开启系统提示词合规词零宽空格脱敏（词表 `data/desensitize-words.txt`，见 prompt-guard.js） |
| `DUMATE_TOOL_OUTPUT_CAP` | 未设（关闭） | 历史 role:'tool' 输出超过此字符数截断并标注原始长度（0/未设关闭） |
| `DUMATE_TRAEWORK_CONNECT_TIMEOUT_MS` | `10000` | TRAE 基址候选轮转的连接超时（tnc.js 候选链；黑洞主机不占满 600s） |
| `DUMATE_TRAEWORK_REMOTE` | 未设（关闭） | 设 `1` 开启 TRAE Remote 链路（auto 档纯文本）；设 `2` 显式模型走 manual 策略。详见 `docs/CHANNEL-TRAEWORK.md`「TRAE Remote 链路已通」节与 `docs/LANDING-ARCHIVE-2026-11.md` 11-05 批次。utils_chat 仍是默认主力 |
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
| `DUMATE_QWENWORK_MAAS` | 未设（关闭） | 设 `1` 启用千问 MaaS 直连备选链路。默认走应用链路；凭证不可用时如实回落。Windows/WSL 凭证来自 `%USERPROFILE%\.qwenworkcn\engine-maas-key.dat` + `%APPDATA%\QwenWorkCN\Local State`（DPAPI + AES-256-GCM），只读取不修改 |
| `DUMATE_QWENWORK_MAAS_BASE` | `https://api9.qwenwork.cn/v1` | MaaS 基址覆盖（缓存文件里的 `baseUrl` 优先） |
| `DUMATE_QWENWORK_MAAS_CRED` / `_CRED_WIN` | `%USERPROFILE%\.qwenworkcn\engine-maas-key.dat` | PowerShell 侧缓存文件路径覆盖（两个变量都认；`_CRED_WIN` 优先）。WSL 下要写 Windows 可见路径 |
| `DUMATE_QWENWORK_LANGFUSE` / `DUMATE_LANGFUSE` | 未设（关闭） | 设 `1` 开启请求埋点导出到 Langfuse。需同时设 URL 与 KEY；失败吞掉，不影响网关 |
| `DUMATE_LANGFUSE_URL` / `_KEY` | 未设 | Langfuse 基址与 API key。POST `{URL}/api/public/ingestion`，不导出正文/token/IP/UA |
| `DUMATE_LANGFUSE_QWENWORK_ONLY` | `1` | 默认只导 qwenwork 通道；设 `0` 导出全部通道 |
| `DUMATE_LANGFUSE_LOCAL_LOG` | `<data>/langfuse-local.jsonl` | Langfuse 投递失败时的本地日志（只记事件 id 与时间，不记正文/凭证）；1MB 轮转留最近 500 条 |

## 数据文件（`data/`，已 gitignore）

> 凭证文件即全部上游权限的边界：`src/fileperm.js` 在创建时收紧权限（POSIX 0600 /
> Windows icacls 目录继承断开），每进程每目录一次、失败静默（尽力而为不碍转发）。
> **`os.tmpdir()` 刻意不收紧**——测试的池状态文件落 Temp，icacls 的 ACE 传播会卡住
> rename 窗口造成锁文件孤儿化（`verify-qoder-throttle.js` 六连败的实测根因）。

| 文件 | 内容 |
|---|---|
| `keys.json` | API key，**存 sha256（校验用）+ plain 明文**（2026-11-01 起管理端可随时查看复制；旧策略「明文仅创建时返回一次」已废，启用前创建的旧 key 明文无法回填，界面标「明文未存」） |
| `model-map.json` | `aliases` / `upstream_models` / `exposed` / `fallback` |
| `admin-users.json` | 管理端账户表（多账户，2026-11-01 起）：`{ username: {username, role: admin/viewer, hash(scrypt N=2^18), session_version} }` |
| `admin.secret` | 会话签名密钥，与用户表分开存 |
| `admin-audit.jsonl` | 管理操作审计 |
| `requests.jsonl` | 网关埋点，超 32MB 轮转一次留 `.1` |
| `web-accounts.json` | 网页账号，**cookie 明文存**（上游要求原样重放，与 keys 的只存哈希是两种策略） |
| `*-trash.json` | 五个账号回收站（批次十六，`web-accounts-trash.json` / `qwenwork-` / `traework-` / `qoder-` / `workbuddy-accounts-trash.json`）：软删除的记录整体搬到这里（**凭据原样保留**，30 天可恢复），live 账号文件根本不含回收站成员——pool/keepalive/FEFO 等消费方零改动。不在备份分区表里（trash 是暂存区不是配置）；解析失败时全部写路径拒绝（宁可不写） |
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
| `logs/run-YYYY-MM-DD.jsonl` | 运行日志每日归档（批次十八）：管理端进程把脱敏后的 console 行按本地日追加一份（`jsonl.append` 单次写），30 天滚动清理挂在日期翻转上。`/api/admin/logs/export?days=N` 打包成 ZIP 下载。**只有管理端进程在写**（网关未 install logbuffer）；存储页只列 data/ 顶层条目，这个目录以一行聚合行出现且不可删 |

**`DUMATE_ADMIN_DATA` 决定数据目录，管理端与网关必须一致**，否则读到的账号/埋点不同。默认都是 `<repo>/data`，正常启动无需设置。容器/自定义部署里如果改了一边没改另一边，症状是「管理端显示空账号、但请求明明成功」——先核对两边的数据目录。

> 历史坑（`stable/` 快照时代）：快照副本的 `__dirname` 是 `stable/src`，未设变量时埋点会落到 `stable/data/`，与管理端读的 `<repo>/data` 分家。目录已删除，该风险不再存在；但**任何把代码复制到别处启动的做法都要显式带 `DUMATE_ADMIN_DATA`**，这个教训仍然适用。

`keys.js` 的 CIDR 匹配是 **fail-closed**：非法条目返回 false（写错一条 CIDR 会让这把 key 对所有来源拒绝，而非意外放行）。token 比对逐条走 `timingSafeEqual`，避免通过响应耗时逐字节猜 token。

## 平台与依赖

- **平台分层，别一概而论**：**网关与四条直连通道（千问/TRAE/Qoder/WorkBuddy）是纯 Node，任何平台都能跑**——`npm test` 与 `npm run verify` 在 Linux/WSL2 实测全绿（verify 的 `verify-channel.js` 有已知的 run-all 串扰，单跑即绿；前提 `npm install` 已跑）。**仅 Windows 的部分**：DuMate 桌面后端链路（`upstream-launcher.js` 拉起 `dumate-main-server.exe`、读 `%APPDATA%\qianfan-desktop-app\auth.json`、依赖 PowerShell/CIM 探测与 `taskkill`）、全部 `.bat`/托盘生命周期脚本、凭证目录的 icacls 收紧（`src/fileperm.js` 在 POSIX 下用 0600，在 Windows 下用 icacls——它自己按平台分流，不用改）。另有两个仅-Windows 功能在 Linux 下**静默跳过、不影响其余功能**（排障时别找错方向）：千问 refresh 被拒后的官方客户端收编（`src/qwenwork/credentials.js` spawn PowerShell 做 DPAPI，失败被吞返回 null）与 WorkBuddy 客户端认证文件导入（`src/workbuddy/constants.js` 的 APPDATA 候选路径，Linux 下改手动粘贴 token）。
- **网关本身零第三方依赖**，只用 Node 内置 `http`/`net`/`child_process`/`fs`/`crypto`。Node >= 18。
- **根 `package.json` 有 `playwright-core`**，但只被管理端的浏览器登录器 `src/login-browser.js` 用到——用来打开受控窗口抓 cookie（系统浏览器 cookies 库运行时被独占锁，读不到）。复用系统已装的 Edge/Chrome，不下载 Chromium。
- **前端有依赖**（Vue 3 + ant-design-vue + Tailwind + ECharts），在 `web/` 下单独 `npm install`。

## 管理端模块（`src/` 下除网关外的部分）

**端口统一后不再有快照同步**（2026-11）：所有进程都直接从 `src/` 加载，改完代码只需重启对应进程，不存在「主目录改了、快照没同步」这类漂移。下面两类只用于**理解加载边界**（哪些模块会被网关进程加载、哪些只在管理端进程里）：

- **网关进程会加载的**（`server.js` 依赖闭包可达）：`dumate-web.js`、`accounts.js`、`web-pool.js`、`points-cursor.js`，以及 `boot.js` 接线带来的 `boot.js` / `cors.js`、`reqlog-hook.js` / `usage-agg.js` / `keepalive.js`、`admin/store.js` / `balance-hist.js`，和 keepalive 签到适配器懒加载可达的 `admin/auth.js` / `admin/router.js` / `admin/routes/accounts.js` / `records.js` / `points-agg.js` / `task-runner.js` / `task-scheduler.js` / `login-browser.js`。
- **只在管理端进程加载的**：`web-gateway.js`（9084 独立网关）、`mcp-server.js`（stdio/CLI 入口）、`admin/iputil.js`、`admin/routes/` 下其余管理路由（traework / qwenwork / qoder / keys / models / usage / reqlogs / chatlab / autotask / keepalive 面板等）。

判断某个模块属于哪边，**从 `src/server.js` 看 require 闭包**，别凭直觉——历史上就出过「以为 admin/ 都只在管理端，结果 keepalive 顶层依赖把它们拉进网关」的判断失误。

| 模块 | 职责 |
|---|---|
| `dumate-web.js` | 网页端 API 封装（签到 / 任务 / 抽奖 / 积分）。**网关闭包内**——回落链路靠它调网页接口 |
| `accounts.js` | 网页账号存储，cookie **明文存**（必须原样重放）。**网关闭包内**（`web-pool.js` 依赖）。显示名解析 `displayName()` / 对外序列化 `toPublic()` 都在这里，见 `docs/CREDENTIALS-ACCOUNTS.md` |
| `web-pool.js` | 网页凭证账号池，轮询 + 故障转移。**被两个入口共用**：9084 独立网关 + 9080 的回落链路 |
| `web-gateway.js` | 9084 独立网关，用网页凭证跑模型（独立进程，不进网关加载闭包） |
| `task-runner.js` / `task-scheduler.js` | 任务自动跑 + 后台轮询（纯管理端） |
| `records.js` | 统一操作记录（签到/任务/抽奖）。**纯管理端**——网关不加载它 |
| `points-agg.js` | 额度包聚合（按来源 / 按发放日 / 临期 / 已过期未用完）。**纯管理端**。本地后端与网页账号拿到的是同一份额度包结构但字段来源不同，两份都要得出同样的派生视图——收敛在这里，否则「一边按到期日、一边按发放日判断还在不在发」这种口径漂移必然发生 |
| `points-cursor.js` | 单请求积分成本（余额游标差）。上游账单无法归因到具体请求（同一时间窗有 1~3 条候选扣费，硬挑一条等于编数字），改用「每条请求结束后记一次余额、相邻两次差值即后一条的成本」。**每账号一条串行队列**——丢一条游标会让下一条的差值跨过两条请求，静默算错，所以宁可排队也不缺档 |
| `login-browser.js` | 浏览器登录器（唯一依赖 playwright-core 的地方，纯管理端）。**WSL 下走 CDP 桥接**：用 PowerShell 在 Windows 宿主拉起 Edge（独立 profile + `--remote-debugging-port`），再用 `chromium.connectOverCDP` 连上去读 cookie——playwright 的 stdio 管道跨不了 WSL/Windows 边界，CDP 走 TCP 可以。端口默认 9333（`DUMATE_WSL_CDP_PORT` 可改）。`%TEMP%` 必须用 PowerShell `Join-Path $env:TEMP` 拼，写进单引号字符串不会展开 |
| `admin/router.js` | `/api/admin/*` 路由分发。**路径匹配锚定整串**，所以 `/models/map` 不会误吞 `/models/map/reset`；注册时 `path: ''` 与前缀拼成 `/api/admin/web-accounts`，`mount` 做了去尾斜杠 |
| `admin/store.js` | JSON / JSONL 原子持久化（先写 `.tmp` 再 `rename`）。管理端的配置写盘都走它 |
| `admin/iputil.js` | 客户端来源 IP。管理端只监听 127.0.0.1，所以直接取 TCP 对端；**没有 TRUST_PROXY 判定**——挂反代前必须先补，否则限流/锁定会按代理 IP 统计 |
| `admin/routes/traework.js` | TRAE Work 通道的管理接口：`/status` 通道健康+账号列表（mode=multi，可增删）、`/models` 模型表（只读）、`/credits` 各账号额度与签到状态、`/checkin` 手动签到（幂等）、`/billing-check` 计费自检探针、**`/login/url` + `/login/callback` 两步 OAuth 登录**、`DELETE/PATCH /accounts/:id` |
| `admin/routes/qwenwork.js` | 千问办公通道的管理接口：`/status` 通道健康、`/credits` 三个池、`/credits/daily` 按天聚合、`/credits/records` 逐笔明细、`/billing-check` 计费自检探针、`/models` 模型表、**`/account` 登录态详情（只读）**、**`/accounts` 账号（`mode='single'` 表示单账号直连，不可增删）** |
| `admin/routes/accounts.js` | 搭子网页账号的管理接口（签到/抽奖/积分/记录）。**回填与显示名的逻辑都在这里**（`backfillNickname` / `backfillAll`），属于管理端 |
| `admin/routes/backup.js` | 备份分区表（批次十四，qoder-trae-workbuddy-switch 移植）：`GET /sections` + `/export` `/preview` `/import`。**SECTION_TABLE 是唯一分区清单**（5 账号分区按身份键合并、其余按顶层键合并），新增可备份类型 = 加一行；预览零写盘；导出默认脱敏（sensitive 分区必须显式含凭据+confirm）；**脱敏记录覆盖本地时保留本地凭据字段**。细节见 `docs/PLAN-WORKBUDDY-GITHUB-MERGE-2026-11-28.md` 批次十四行 |
| `admin/routes/storage.js` | 存储管理（批次十七）：data/ 四类视图 + 先预览再确认的清理 + 60s 快照。**白名单根只收裸文件名**（分隔符/`..` 参数形状上就拒）；**未识别文件一律 other/protected**——分类表（KNOWN）只登记认识的文件名，新增可清理文件 = 在 KNOWN 加一行标 `deletable:true`，绝不给未知文件放行；可删的只有 logs/cache 两类，checkin-ledger/qoder-grants/usage-agg/pool-state/admin-audit 这类「删了有行为后果或不可再生」的刻意归 config 保护。preview 响应不下发 fullPath。新增 data/ 文件后**它默认是保护的**——想让存储页能清理它必须显式登记 |
| `admin/trash.js` | 账号回收站（批次十六）：五通道共用一套（SPECS 表驱动），**软删除搬移到独立回收站文件**而不是 live 里加标记——消费方零改动。写顺序「新增侧先落」（中途失败是两边都有不是数据丢失）；恢复 fail-closed（未知 key 拒/live 已有同 id 拒/preferred 排他归一）；30 天 + 200 条先到先出；损坏时全部写路径拒绝。`routesFor(channel)` 工厂四路由（GET /trash、POST /trash/clear、POST /trash/:key/restore、DELETE /trash/:key），**必须展开在各通道 routes 数组最前**（字面 /trash 先于 /:id 参数路由被匹配）；purge/clear 服务端强制 confirm。清扫循环挂管理端进程（`startSweep`，boot + 每小时）——网关进程从不写回收站文件，**别把清扫挪进网关 keepalive**（会引入跨进程写竞争） |
| `admin/logbuffer.js` / `admin/logarchive.js` | 运行日志（调研 P1-9 + 批次十八）：内存环按行首特征分 **chat/task/sys 三频道**（每频道独立 500 行；`[chat]` 等显式标签直接命中、`[keepalive]` 等巡检前缀归 task、其余 sys；剥 ISO 时间戳前缀后再判，未知频道返回空不回落）。**脱敏在入缓冲之前、中文标签也要认**（密码/口令/密钥/秘钥/令牌/凭据 + 显式分隔符——`--reset-admin` 横幅打「密码:  值」，只认 ASCII 键名时整行漏过，2026-11-28 实测）；敏感行整行丢弃、不进环不落盘。归档走 **sink 管道**（`addSink`，不占 SSE 4 路订阅名额）→ `logarchive.js` 每日一份 JSONL + 30 天清理 + 零依赖 ZIP 导出（手拼 CRC32/本地头/EOCD，`unzip -t` 交叉验证过） |
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

Vue 3 + Vite + ant-design-vue 4 + Tailwind + ECharts（按需引入，不用全量，省约 1MB 首屏）。开发时 Vite 把 `/api` 代理到 9081（`vite.config.ts`），**改的是哪个管理端端口就要对应改这里**——代理写死 9081（即现在的默认管理端端口，无需改）。

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

## 落地批次索引（2026-11，全文在 docs/LANDING-ARCHIVE-2026-11.md）

> 2026-11 各批次的完整落地记录（实测依据、验证、踩坑）已整体移入
> `docs/LANDING-ARCHIVE-2026-11.md`，此处只留钩子。**改某项行为前先到归档里读对应批次**——
> 每条「纪律 / 别再试」都是实测换来的。

| 批次 | 做了什么 | 关键钩子 |
|---|---|---|
| 11-05 GitHub 融合 | Qoder 节奏闸门（inflight/min-interval，默认关，面板热改）；probe 无副作用；工具回显修复（`DUMATE_TOOL_ECHO_MODE`）；积分三段拆分（`credit-split.js`）+ 全价请求；**千问 ACP 会话通道**（`qwen-acp/` 前缀）；TRAE remote manual（`REMOTE=2` 显式模型）；WorkBuddy 每日活跃双通道（activity + webagent） | 千问 ACP 与 chat 桥可用性分离；`session/set_model` RPC 不存在，档位由账号决定；ACP 每请求新会话、同账号并发建会话 409、单条 32768 字节上限 |
| 11-06 WorkBuddy 融合 | 11-128 指纹清洗（`sanitize.js`，DSH 生态必撞）；风控连坐（11140 不换号→整区暂停 1800s）；6004 model_cap（按模型冷却）；401 先刷新再换号；`[DONE]` 即终态 | 清洗规则照 hub 移植别自己措辞；6004 换号继续打同模型，不封整号 |
| 11-06 第二批 | sticky 暖账号列表（front + 2 fallback，防前缀缓存丢失）；账号档位权威来源（`billing.js`，无字段=null 绝不编「免费」）；网页打卡随机提示词池 | front 不可用先试会话暖账号再池轮询 |
| 11-07 融合三批 | `dumate-points` 伪模型；/v1/models 实测元数据；/health 身份（`service-identity.js`）；智能体一键配置（`agent-setup.js`，TOML 托管键合并 + diff 预览见 P2-10）；低频余额刷新（默认关）；首启凭证自举；子 Key（`key-quota.js`）；跨通道额度总览卡（不跨通道相加） | 伪模型拦截在 resolve 之后、availability 之前（早于 needsModelMap）；子 Key 请求计入父配额桶 |
| 11-08 TRAE 调研融合 | 20 项全落地：运行期配置（`trae-runtime.js`，**新字段改三处**）、显式降级（只认确证错误码）、Max 档、七类告警、配置恢复、运行日志脱敏、`/metrics`、kill switch；第四批补 P2-15 代理池稳定分配、P2-16 每日用量护栏（未知不拦） | 降级排除凭证被拒；`X-Trae-Degraded` 头 |
| 11-16 P0-1 | 模型表缓存按作用域隔离（region+account+fn+version，单飞 + LRU），聚合合并方向各异（multimodal OR / maxMode AND / 上下文 min / 倍率不一致标 ambiguous） | 能力判断错先查 `/traework/models/cache`；拉失败不覆盖旧缓存 |
| 11-16 P0-3 | 凭证被拒处置：裸 403 保持 breaker、401=session_dead；单号人工恢复 `POST /api/admin/traework/accounts/:id/recover`；跨区容灾默认关 | **改 403 口径前先跑 `verify-qoder-throttle.js` / `verify-qoder-error-surface.js`**（Qoder 403 还表达额度/限流） |
| 11-16 P1-5 | 请求尝试链（`attempts.js`，最多 8 条；路由闸门拒绝也记 `gate:` 一行） | 吞异常的 catch 只包埋点本身，判据字符串用当前作用域确实存在的变量 |
| 11-16 P1-8 | 签到补签（`makeup.js` + `shouldCatchUp` 睡眠唤醒补跑）；「已签」= 账本行（含 already）+ `lastCheckin` 两证据缺一不可 | `POST /api/admin/traework/checkin/makeup` 默认 dryRun；窗口 09:17–23:30，窗口外如实报不静默空 |
| 11-16 P0-2a | 登录回环自动回调（`oauth-callback.js`，127.0.0.1:18080，state 单次消费 + 10 分钟） | 端口占用明确报错退回手动粘贴，不静默换端口；trace 带了就必须对、没带放行并标 `trace_verified:false` |
| 11-16 P0-4 | 每模型默认思考档（`reasoning-apply.js`：客户端优先、无 descriptor 不套、只向下钳） | 档位词表复用 `remote.js` 单一来源；`defaultReasoning` 整体替换不深合并 |
| 11-16 P1-9 | 通道风控参数上台（`src/throttle.js` 唯一解析点：面板 > env > 默认） | 三个 0 语义不同（inflightMax 的 0=没填回落池默认；minIntervalMs/retryMax 的 0=显式关断）；HOLD_CAP 刻意不进面板 |
| 11-16 P1-6 | 图片体量观测 + 上限 + **PNG 真压缩**（`png.js` 面积平均缩放）+ 原图 data URI sha1 缓存 | JPEG 不缩；没缩小就不重编码（稀疏图会变大）；`image_compressed=0` 且字节变小只有「命中缓存」一种解释，两字段必须分开记 |
| 11-16 P1-7 | 自定义路由组（组名显式命中、不带斜杠、成员非组名、坏文件整体按无组）+ 运行时换成员（**只对非流式**，判据 `res.headersSent===false`） | 换成员同步改 `payload.model` / `req._channel` / 组头，尝试链复用 `req._attempts`；**流式不换成员**（shim 收尾权未查清，宁可 400 不留挂死） |
| 11-16 P2-13 | 用量补 TTFB 分桶（8 段直方图，分母只数报了首字的请求）+ 命中率剔缓存写入；桶字段是**三份**（addEntry / mergeInto / normalizeBucket） | 无样本一律 null 不是 0；分位数是段上界近似值，必须自带区间 |
| 11-16 P2-10 | 接入配置写入前 diff 预览（预览与写入同一 `buildNext`、预览零写盘、密钥打码） | diff 用行级 LCS（零依赖）；超 1200 行只给统计 |
| 11-16 P2-12 | 看板自动刷新（一个共享定时器、页面不可见不刷、单飞、回调抛错只记不炸）+ 阅读模式 | 阅读模式只改排版不藏数据；页面侧用 `useAutoRefresh(load)` 自动注销 |
| 11-16 P2-11 | 会话粘性键含 system（全文不截断、parts 空串拼接、OpenAI/Anthropic 两协议同口径）+ 补批把会话键写进请求日志 | 键只认首条 user（2048）+ system 全文；换键不断在跑会话（粘性绑定只在内存）；`sessionKeyFor` 把键产生与上报绑在同一函数 |
