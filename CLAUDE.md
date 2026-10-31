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
> 发布新版的唯一途径：主目录验证通过后按**依赖闭包**同步 `stable/src/` + 更新 `SNAPSHOT_FROM.txt`（不要用 `src/*.js` 覆盖——会漏掉子目录、多带管理端，详见下文「`stable/` 是冻结快照」）。
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
| 未知前缀（如 `qwn/pro`） | **400 报错，不静默回落** |

**通道 id 的单一来源是 `src/channels.js`**（`dumate` / `qwenwork` / `traework` / `qoder`）。
`keys.js`（网关鉴权）、`admin/routes/keys.js`（校验）、`usage.js` / `reqlogs.js`
（筛选参数）四处都 require 同一份——加一条通道只改这一个文件。

**千问与 TRAE 都是直连通道，但彼此也不同**：千问是单账号只读（登录态在客户端
`auth-v2.dat`）、三个积分池；TRAE 是多账号自持凭证、单一 credits + 签到体系。
前端 `isDirectChannel()` 只分「搭子 vs 直连」，页面内部还要用 `isTraework()` /
`isQwenwork()` 再分一次——共用一套模板会把「能不能加账号」「能不能自动续期」
这类问题说反。

**Qoder 是第四条通道**（2026-10-02 接入，`src/qoder/`）：阿里 AI IDE，
与千问办公**同一套 COSY 协议**（同样的 `Encode=1` 自定义 base64、同样的
`Bearer COSY.<payload>.<sig>` 信封、同样的 device flow 登录，**连 client_id 都相同**）。
但有两点关键差异：

1. **签名不需要官方 wasm**——纯本地算法（RSA 加密临时密钥 + AES 加密身份 + MD5 签名，
   公钥硬编码，见 `src/qoder/cosy.js`）。所以这条通道**不需要装任何客户端**
   （`/health` 的 `needsClient: false`）。**千问现在也是同一套本地算法**
   （2026-10-14 起，见下文「千问通道的硬约束」第 1 条），两个通道共用
   `src/cosy.js` 一份实现。
2. **额度分两块且不能相加**：`userQuota`（订阅套餐内，Free 恒为 0）与
   `addOnQuota`（签到/赠送，**免费用户实际能用的就是这个**）。

**零额度时聊天会挂起**（不报错、不超时失败），所以**签到是通道可用的前提**——
新账号必须先 `checkin` 领积分。签到链路 `GET /sash/api/v1/me/campaigns` →
`POST .../{id}/claim`，**不需要签名**，只要 device token + `cosy-clienttype: 10`。

**积分过期要本地记账，因为上游没有逐批余额接口**（`src/qoder/grants.js`）。
实测 `/api/v2/quota/detail`、`/sash/.../grants`、`/sash/.../credit-packs` 等一律
503/404——**唯一带到期信息的是领取响应本身**（`benefit.validity` = `RELATIVE_DAYS`/30 天
+ `grantedAt`）。所以每次签到往 `data/qoder-grants.jsonl` 落一条（幂等键 `grantId`），
过期提醒才有数据源。**活动列表对已领活动不返回领取时间**，所以无法回填——
账本从功能启用时开始记，界面要如实标出覆盖范围（`/grants` 的 `since` 字段），
否则「账本里没有」会被读成「没有积分」。

**「领取额」不是「剩余额」**——这是本通道的数据缺口，必须如实标注。上游只告诉
我们这批领了多少，不告诉我们还剩多少。千问（每包有独立余额）与 TRAE（每包有
`remain`）都没有这个问题，**不要照搬它们的措辞**。界面一律写「领取额」，
并注明「实际剩余以额度卡总余额为准」。

**签到积分领取后 30 天作废，每日 10:00 (UTC+8) 刷新**——注意**不是 00:00**
（千问是 00:00 重置，两者不同）。`/qoder/grants` 与仪表盘的过期明细按此展示。

**模型选择要同时设 body 与请求头**：body 的 `model_config.key` / `chat_context.extra.modelConfig.key`
**加**请求头 `x-model-key` / `x-model-source`（只设 body 时上游仍走 `auto`）。
而且**响应里的 `model` 字段恒为 `"auto"`**（上游如此），不能据此判断实际模型——
真正的判据是 `system_fingerprint`（实测 `dmodel` → `a307abda…`、`kmodel_latest` → `fpv0_3f6baf1…`）。

**倍率差 14 倍，开发调试一律用 0.1 档**：`qfmodel`/`qmodel`/`q37fmodel`/`dfmodel`/`gfmodel`。
实测 5 个 0.1 档请求合计不到 0.01 credits，而 `kmodel_latest`(Kimi-K3) 是 1.4 档。
倍率从模型表接口的 `price_factor` 读，**不硬编码**。

**Qoder 的 usage 直接返回 credits 消耗**（三条直连通道里唯一如此）：
`usage.credits = price_factor × tokens/1000`，比千问（读余额差）和 TRAE（读 usage_summary）都干净。

**上游限流排队会「先响应后沉默」，读空闲超时负责掐断（2026-10-24 修）。**
限流形态（信封 `code 10605` + `subCode RESOURCE_LIMIT` + `serviceAvailable:false`）实测有两种：
一是直接回错误信封（有信息量）；二是**请求被排队挂起——连接不关、也不出数据，
最后由中间层在 ~360s 处掐断，客户端只拿到无信息的 `aborted`**。首字节超时挡不住第二种
（上游可能先给响应头甚至一帧，然后沉默）。`src/qoder/chat.js` 的 `armReadIdle` 挂一个
读空闲计时器（`DUMATE_QODER_READ_IDLE_MS`，默认 120000，`0` 关闭）：**每块数据到达都重置**，
沉默满时限就 `req.destroy` 主动断开，交上层换号或报错。正常推理的 SSE 持续出帧、不会被误杀；
全零字节仍由首字节超时（`DUMATE_QODER_FIRST_BYTE_MS`，默认 60000）兜底——**读空闲必须大于
首字节，否则两计时器抢跑**。错误串由 `errtext.js` 翻译成「上游排队挂起，长时间无数据」。
注意 `chat.js` 在模块加载时读一次环境变量就定死。离线验证：
`node test/verify-qoder-read-idle.js`（10 项：沉默被掐、正常流不误杀、全零走首字节、
postStream 同语义、`0` 关闭，以及排队「假内容」的五条——见下一段）。

**排队时上游会先回「假内容」，首字节计时器被它清掉——真正起作用的是
「无内容」计时器（2026-10-27 修，这才是『对话一直转圈』的直接原因）。**
实测排队时上游**不是不出数据**，而是先回两种「假内容」之一，然后沉默：

1. **限流信封**：`{"code":"403","message":"{\"code\":\"10605\",…\"subCode\":\"RESOURCE_LIMIT\"}"}`
   （走 `runOnce` 时会被 `payloadError` 立刻认出来，代价 ~0.5s）；
2. **首帧空 delta**：`{"choices":[{"delta":{"content":"","reasoning_content":"","role":"assistant"}}]}`
   ——正常流的**第一帧也是这个形状**，所以不能把它当内容。

两者都会清掉 `armFirstByte`，于是只剩 120 秒的 `armReadIdle` 兜底：每次排队白等
两分钟，两个账号就是四分钟，客户端早就自己超时了。

判据改成「有没有**真实内容**」（`isRealContent`：有正文 / 思维链 / 工具调用 /
finish_reason / usage，**错误信封明确不算**）。`armContentDeadline` 只在还没
转发过真实内容时计时，一旦有内容立刻撤销（长回答完全不受影响）。阈值默认
**90 秒**（`DUMATE_QODER_CONTENT_MS`）。

**12s / 6s 两个旧值都在误杀正常的大上下文 prefill（2026-10-31 修正，可用性级）。**
「12 秒盖住 p99」的依据（1029 条样本，p99=11.9s / max=35.1s）本身没错，但据此
把阈值一路下调到 6s 是错的——那批「干净样本」只跑了小 prompt 与 76K 上下文，
没覆盖真实 Codex 会话的规模。按埋点全量复核（1200+ 条 **200** 请求，只统计
成功样本的首字延迟）：

| 口径 | 数值 |
|---|---|
| 首字 > 6s | **14.4%**（183/1270） |
| 首字 > 30s | **7.6%** |
| 首字 max | **63.9s** |
| 大上下文（>50K token）首字 > 6s | **20.5%** |
| 145K 上下文 GLM-5.3-Flash 实测 | 32.8 / 49.3 / 57.5 / 58.2 秒 |

6s 阈值上线（c00c42f）之后，成功请求里首字 > 6s 的**一条都没有**（0/25），
而 502 里有 36 条 `first_token_ms` 恰好卡在 **5006~5030**——那个数字是计时器
自己造的，不是上游行为。用户报的「要等很久」里相当一部分是我们把本来能成的
请求掐断、再串行换号重来一遍。

**排队不会因此变慢**：真排队时上游在 **200~680ms** 内就回 10605 信封
（`payloadError` 当场识别并断流，见 post/postStream），根本走不到这个计时器。
它只兜「收了请求、回空 ack 后沉默」的未知形态，而那种形态与「prefill 慢」
在**字节层不可区分**，宁可按 prefill 处置。90s 盖住本地实测 max 63.9s 与
qoder2api-hub 记载的 71s 上限（hub 根本没有这一层判定：最短掐断是排队轮预算
90s / socket 600s / SSE 读空闲 900s，靠 5 秒心跳让客户端不超时）。

**这个阈值直接决定用户感知的最坏等待**：两个账号串行时 30s×2=60s（客户端多半
已超时），12s×2=24s。2026-10-27 实测一次排队卡了 33.7 秒才成功，用户侧就是
「点了没反应」——所以默认从 30s 下调到 12s。排队请求是**完全无内容**的
（实测把阈值压到 8s 时，排队请求稳定在 8.0~8.0s 断开），压短不会漏判。
`post`（非流式）用同一判据（`hasPayload`）。

**排队挂起不该冷却账号 5 分钟，也不该换一次号就收工。**
实测同一账号挂起一次后，紧接着的 5 次请求**全部成功**——排队是**请求级随机**的，
与账号健康无关。所以：

- `classify` 给 `qoder upstream queued` / `read idle` 一个 **5 秒**的短冷却
  （`QUEUE_HANG_COOLDOWN_MS`），而不是软冷却默认的 5 分钟基数。否则两个账号
  会互相把对方挡在门外，用户看到的是「全部账号排队中（300 秒后可重试）」。
- `send()` 在**账号都轮过一遍**且失败全是瞬时类（限流/网络）时，会等掉池给的
  短冷却（`DUMATE_QODER_QUEUE_STEP_MS`，默认 1500ms 间隔）、清空 `tried` 再轮询一次
  （`MAX_ATTEMPTS` 因此从 3 提到 4）。只换号不重试的话，按实测约 40% 的挂起率，
  两个账号各挂一次就必然失败。

两条底线没变：**下游拿 429**（客户端自动退避重试），**绝不把限流记成熔断**。

**限流是「稍后再来」，不是「服务坏了」——按 429 处置，绝不能进熔断（2026-10-27 修，可用性级）。**
`upstream-errors.classify` 原来只认 HTTP 429 为 `soft`，而 Qoder 的限流是
**HTTP 403 + 信封 `code 10605`**（`subCode` 为 `RESOURCE_LIMIT` / `CALL_COUNT_LIMIT`，
带 `isQueued:true` / `serviceAvailable:false`），落进了「其余 403」→ `breaker` 分支。
熔断的退避是 **30 分钟起步、每次翻倍到 6 小时**，而限流条件上游自己说得很清楚：
`retryAfterSeconds:30` / `waitTime:66`。实测放大效果（离线复现）：两个账号各被限流
3 次 → `pick()` 连续返回 `null`，整个池被封 **30 分钟**，期间所有请求都是
「Qoder 没有可用账号」——这就是用户报的「Qoder 用不了」，而账号本身完全健康。

四条不变量，改动时别破坏：

1. **判据先于状态码**：`isThrottle()` 用**完整错误串**匹配（限流信号常藏在嵌套 JSON
   的第 150 字符之后，按 `message.slice(0,200)` 判会时灵时不灵），命中即 `kind:'soft'`，
   **必须排在 401/402/403/5xx 那些分支之前**。`qoder upstream read idle` 同样是限流
   （排队挂起的另一种形态），一并算进来。
2. **冷却时长按上游给的来**（`throttleRetryMs`，`retryAfterSeconds` 与 `waitTime` 取大，
   因为后者才是队列里的实际预估）；取不到才回落 5 分钟基数。夹在 `[1s, softMaxMs]`。
   按上游时长冷却时**不递增 `soft_streak`**——时长是上游定的，不是「又超速一次」的证据。
3. **403 的限流必须可换号**（`qoder/index.js` 的 `retryable`）：排队粒度是
   **(账号, 模型)**，实测同一分钟一个账号的 `dfmodel` 排 2410 位、另一个账号的
   `gfmodel` 直接 200。旧判据只看一组模型/权限文案，限流落到「不可换号」分支，
   第二个账号白放着。
4. **下游拿到 429，不是 403/502/503**：Codex / Claude Code 对 429 会自动退避重试，
   对 403/502 只当硬失败。全部尝试都是限流、或池里只剩限流软冷却时，都回 429
   （`channelPool.availability()` 用 `softOnly` + `nextInMs` 区分「限流冷却」与
   「禁用/熔断/在途满」，后者仍是 503）。

**排队必须按 (账号, 模型) 冷却，不能封整个账号（2026-10-27 修，可用性级——这是
「Qoder 整条通道用不了、网页版却正常」的真因）。**
上面第 3 条已经写明排队的粒度是 (账号, 模型)，但那是**选号**层面的认知；
**冷却本身仍是账号级**，于是出现下面这条链路（实测）：

| 环节 | 观测值 |
|---|---|
| 上游 | `dfmodel` 排 4697 位 → `waitTime: 7015`（秒） |
| 池 | 两个账号各进 `soft` 冷却 **7012 秒**（近 2 小时） |
| 同账号的 `qfmodel` | 直连上游 **HTTP 200 / 2.1 秒**，但经网关 10 次全部失败、**响应 4–300ms** |

那 4 毫秒就是「根本没打上游」的证据：`pickCandidate` 因为账号级冷却返回 `null`，
`noAccountError` 直接给 429。用户配的默认模型正是 `qoder/DeepSeek-Flash`，
所以一次排队就把整条通道锁死两小时，客户端每次重试都在毫秒级被本地拒掉。
网页版正常、网关不正常，差别就在这条队列恰好只挡了 dfmodel。

三处改动，缺一不可：

1. **`classify` 给排队标 `scope:'model'`**（信封带 `modelKey` 时）。判据用
   `MODEL_QUEUE_TEXT`，能容忍转义引号（`\"modelKey\"`）。
2. **`pool.applyModelSoftCooldown`**：只写 `model_cooldowns[model]`，**不碰账号的
   `cooldown` 域**——账号保持健康，别的模型照常可用。
3. **`channel-pool.availability` 把「账号健康、仅模型排队」算进 `softOnly`**。
   少了这条，模型冷却会掉进 `!st.cooling` 分支被当成通道故障，下游拿到 **503**
   直接放弃重试，而不是 429。

**冷却时长必须封顶**（`DUMATE_THROTTLE_MAX_MS`，默认 10 分钟）：上游的 `waitTime`
是它自己队列长度的估算（4697 人 → 7015 秒），队列随时在变，照单全收等于锁死。
封顶后最多等 10 分钟再探一次；真还在排队就继续 429，不影响别的模型。

顺带修掉一个**一直存在但被 subCode 掩盖**的匹配 bug：`THROTTLE_TEXT` 里写的是
`"isQueued"\s*:\s*true`，而真实串是 `\"isQueued\":true`（引号前多一个转义反斜杠），
**这条分支从来没命中过**，一直是靠 `RESOURCE_LIMIT` / `CALL_COUNT_LIMIT` 兜住的。
现在两种编码都认。

离线验证：`node test/verify-qoder-throttle.js`（30 项：限流识别、`retryAfterSeconds`/
`waitTime` 取值、classify 分类边界、池不再放大成熔断、30 秒后恢复、换号、下游 429，
以及新增的 **3b 节**：`scope=model` 判定、dfmodel 排队时 qfmodel 仍可选、7015 秒
被封顶到 10 分钟、模型排队时 `availability` 报 `softOnly`）。
顺带修掉 `test/verify-qoder-error-surface.js` 的非隔离问题：它会造 429/5xx 惩罚态，
原来写的是真实 `data/pool-state.json`，429 那条把账号冷却 5 分钟后，后面所有用例都
选不到账号（**该文件在修之前就已经是 11 项全红**）。现在它自带 `DUMATE_POOL_STATE`
临时文件、每个用例前 `pool.revive()` 重置。

**身份形态与额度类业务码对齐官方客户端（2026-10-30 修，源自 qoder2api-hub 的逆向结论）。**
四件事，判据全部取自 [shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub)
（459★，Qoder 协议逆向的社区权威，带风控文档与实测夹具）：

1. **global 推理主力换成 api3.qoder.sh**（`constants.js`）。官方 0.4.8 客户端的
   endpoint 缓存是 inference=api3、securityInference=api2；api1 是旧配置首位，
   **常年直连超时**——我们原来用的正是它。连接层失败（ECONNREFUSED/ECONNRESET
   等，不含首字节超时）按官方候选顺序 api3→api2→api1 切换，且只在还没转发过
   任何帧时切（转发过再切会让客户端收到两段拼接内容）。`DUMATE_QODER_INTL_GATEWAY`
   可钉死单主机（上游支持服务端「选举」导流端点，被导流时用它）。
2. **额度类业务码 112/110/430/114 单独处置**（`qoder/index.js` 的
   `quotaKindOfText` / `quotaFrameError` / `poolInfoOf`）。这些码 **< 400**，
   `payloadError`（只认 ≥400）不认——裸的 `{"code":"112"}` 信封帧此前会被当
   正常数据转发，客户端拿到 200 + 空回答。处置对齐 hub #108：112（额度耗尽，
   message 带 pricingUrl）/114（试用受限）冷却 30 分钟；110（当日次数上限，
   `Billing daily count exceeded`）冷却到本地 0 点；**不禁用、不进熔断、不写
   模型级冷却**（配额是账号级的），且**换号有用**（别的号可能还有额度）；
   430（版本门）换号无用，快速失败 + 明确文案，账号不进冷却。识别层放
   **通道本地**而不是 upstream-errors——105→401 的同一架构先例：共用层不认识
   通道私有码。喂池走「429 + 显式 retryAfterMs」，classify 只做通用透传。
3. **身份头对齐官方推理请求**（`cosy.js`）：推理与模型表带 `cosy-machineos`
   （`{arch}_{platform}`，默认 x86_64_win32）；流式对话另带
   `cosy-machinehostname`（`DESKTOP-` + md5("hostname:"+uid) 前 7 位，按账号
   稳定派生、跨账号互异）。User-Agent 从 Go-http-client/2.0（Go 参考实现的
   指纹）改为官方 CLI 形态的 `undici`。**签到链路千万不要加派生机器头**——
   hub 实测发了假机器头会被活动平台整条过滤掉「每日领取」。
4. **cosy-version 从 1.0.10（旧桌面端）升到 1.1.75（官方 CLI 当前值）**，
   `DUMATE_QODER_COSY_VERSION` 可覆盖。上游对过低版本回 430，提前对齐省一次
   被版本门拦住。cn 账号真机验证：1.1.75 + 新身份头请求正常出流。

离线验证：`node test/verify-qoder-throttle.js`（新增 **3c 节** 16 项：112/110/430/114
识别与处置、10605 不被额度判据误吃、池固定冷却不递增 soft_streak、errtext 翻译；
e2e 用例与 rr 游标位置无关——轮转两轮、A 起手轮才断言）+
`node test/verify-qoder-channel.js`（新增候选链顺序、machineos/hostname 的 sse
场景区分、UA 形态）。

**P1 增强（2026-10-30 同日落地，四件）**：

1. **思考档位透传 + 本地归一化**。上游参数是 `parameters.reasoning_effort`，
   收到不支持的档位**不报错、悄悄回落默认档**——不归一化用户就无感地丢了档位。
   合法档集合来自模型表原始行的 `thinking_config`（`enabled.efforts` +
   `is_default`，session.parseThinkingConfig 解析）。四个入口写法都收：
   `reasoning_effort`（OpenAI）、`reasoning.effort`（Codex）、`thinking.effort` /
   `thinking.level`（Anthropic 系）；Claude Code 的 adaptive 形态强度在
   `output_config.effort`，显式 `thinking.budget_tokens` 按区间映射
   （≤1024 minimal / ≤4096 low / ≤16384 medium / ≤32768 high / 更大 max）。
   归一规则：合法原样；非法取最近合法档（同距偏默认档——qfmodel 的
   high→medium、max→xhigh 与 hub 实测一致）；`none`/disabled 不下发；
   模型表没带档位集合时原样透传。**搭子是最小干预透传，reasoning_effort 会在
   server.js 的 needsModelMap 分支被剥掉**——多余字段进百度云端行为未知。
2. **max_tokens 上游上限自学习**（`qoder/max-output.js`）：模型表不带
   maxOutputTokens，超限报错 `Range of max_tokens should be [1, N]` 就是 N 的
   唯一来源。第一次撞上限如实报 400 并按（区域，模型）落盘
   `data/qoder-max-output.json`（7 天 TTL，原子写），之后 buildBody 出站前
   自动 clamp。`DUMATE_QODER_MAX_OUTPUT_FILE` 可改路径（测试用）。
3. **FEFO 选号**：积分领取后 30 天作废而上游没有逐批余额接口，临期不用就废。
   `qoder/index.js` 的 `fefoUidSet` 从 grants 账本取临期批次（默认 3 天窗口，
   `DUMATE_QODER_FEFO_DAYS=0` 关），经 channel-pool 透传给 pool.pick 的
   `expiring` 过滤——集合非空时候选**限制**在临期账号内；临期号不健康时池自动
   退回全量候选。已知缺口如实存在：领取额≠剩余额，FEFO 可能把流量打向已花完
   的号——代价只是一次快速失败 + 换号，比让积分作废划算。
4. **流式 `: ping` 保活帧**（server.js 直连通道流式桥）：上游首字实测可长达
   40~70 秒（高思考档位 + 长上下文），期间 Codex / Claude Code 或中间代理会
   因空闲超时断连。每 5s 写一个 SSE 注释帧——三套翻译器与 OpenAI 直通都按
   `data: ` 前缀过滤、天然忽略；首帧到达即停。OpenAI 分支的头必须推迟到真实
   首帧（要保住回 4xx 的能力），所以头发出前不写 ping。

离线验证（新增）：`node test/verify-qoder-max-output.js`（学习/TTL/钳制/落盘）、
`node --test test/unit/effort-passthrough.test.js`（两个翻译层的 effort 映射）、
verify-qoder-channel.js（档位归一化 9 项）、verify-qoder-throttle.js（FEFO 3 项）。

**官方排队轮询协议（2026-10-30，P1 收官）**。hub 文档 7.1 的逆向结论：官方客户端被
10605（`isQueued:true`）拒绝后**不结束请求**——带着**同一个 requestSetId** 轮询
`GET /api/v2/service/ask/queue/status?requestSetId=…&modelKey=…&queueType=…`，
每轮先睡 `retryAfterSeconds`，`isQueued===false` 才继续真正的推理，总预算默认 60
分钟。这直接推翻了我们对 10-29「排队请求级随机、等多久都不保证放行」结论的归因：
**每次重试都换新的 request_set_id，等于每次重新排队**。

实现（`qoder/index.js` 的 `queueWaitRound` + `chat.getQueueStatus`）三件套：

1. **request_set_id 在同一次 send() 内稳定**（`buildBody` 的 `opts.requestSetId`）——
   这是排队槽位的钥匙。queue/status 与请求体必须带同一个值，否则查的是别的槽位
   （P1 落地时曾漏传 buildBody，离线测试当场抓住——status 与 body 各带各的 UUID）。
2. **两种排队形态都进等待轮**：信封型（错误帧/错误体带 10605/isQueued 等）按
   上游给的 `retryAfterSeconds` 睡眠（夹在 [5s, 20s]）后重发；**静默型**（上游
   收了请求、回空 ack 后沉默 → content deadline / read idle 掐断——2026-10-30
   实测它才是当下最主要的排队形态）**跳过首睡立即查状态**（掐断本身已等过一轮
   沉默）。重发用**同一份加密请求体**（同一个 request_set_id）。预算天然封顶，
   静默形态不会比旧路径更糟（旧路径是掐断后直接失败）。
3. **queue/status 是 best-effort 放行信号**：端点真实存在（2026-10-30 实测
   cn 网关 200，形状 `{"isQueued":false,"modelKey":…,"queueCount":0,"waitTime":0,
   "retryAfterSeconds":2,"serviceAvailable":true}`，我们的 COSY 签名头被接受）。
   说 released → 立即重发；说还要排很久且超出预算 → 早停（不烧满预算干等）；
   连续两次不可用 → 停止探测、退化为纯盲等重发（hub 网关自己验证过的形态——
   它逆向了协议但实现里只做 sleep+reopen）。
4. **请求体复用，但签名必须每轮重建**（2026-10-31 修，这是「Qoder 一直转圈」
   的真因之一）。上面的第 2 条只说了「重发用同一份加密请求体」，于是 `headers`
   也被一并复用——而上游按**签名字节**去重：第二次起一律回
   `{"code":"103","message":"Duplicate request"}`。两个致命后果叠加：

   - **103 < 400**，`payloadError`（只认 ≥400）认不出，请求于是**静默**挂到
     内容超时才被掐断，日志里只留一句无信息的 `no content in 6000ms`；
   - 去重判据**与时间无关**——实测同一份 headers 间隔 7 秒重发仍是 103，
     所以「多等一会儿再发」永远绕不开。

   修法是 `reSign()`：只重建 `headers`（新 `requestId` + 新 `cosy-date`），
   **不动 `encBody`**，排队槽位不受影响。实测对照（同一 request_set_id 连发）：
   复用 headers → 103 后沉默；每轮重签 → 正常拿到 10605 / 放行，第 5 轮出内容。
   代价：小请求 0.1ms、800KB 请求 18.8ms，相对一轮 5~20 秒的排队等待可忽略。

   **queue/status 同样是这个机制**（`statusHeaders` 由常量改成函数）：复用签名
   时第二次查询起全部 403/103，而 `getQueueStatus` 对非 200 返回 null，于是
   `statusFailures` 两次就把它判成「端点不可用」——**官方排队轮询协议整条退化
   成盲等重发**，第 1~3 条的成果全部作废。实测每次重建则连续 3 次全部 200。

预算：`DUMATE_QODER_QUEUE_POLL_BUDGET_MS` 默认 60000（**整次请求**所有账号共享，
send() 下发 deadline）；`DUMATE_QODER_QUEUE_POLL=0` 整体关闭（回到纯快速轮询）；
`DUMATE_QODER_QUEUE_POLL_INTERVAL_MS` 仅供测试注入短间隔。等待期间流式客户端靠
`: ping` 保活帧保持连接（与上一节的保活帧天然配合——ping 跑在 provider.send
未返回的整个期间，覆盖排队等待）。

离线验证：verify-qoder-throttle.js **第 5 节**（信封放行重发 + request_set_id 字节级
判等、早停、端点不可用退盲等、静默形态立即查状态重发；剧本用**信封在流里 / 掐断
throw** 两种形态——只有它们才走等待轮）。注意该套件前 4 节的三个 6 秒用例是
10-29 快速轮询的既有节奏，不是排队等待。

**P2 增强（2026-10-30 同日，数据与档位批次）**：

1. **官方积分消耗接口**（`/sash/api/v1/ai-conversations/credits-summary` +
   `credits-heatmap`，0.4.3 客户端新增，hub v1.7.5 实测 cn/intl 均 200）。
   形状：summary = `{totalCredits, peakCredits, peakDate, unit}`；heatmap =
   `{items:[{date,value}]}`。**上游唯一给出「真实消耗口径」的地方**——逐笔
   credits 只覆盖经网关的请求，官方口径含全部客户端用量；与 grants（只有领取额）
   互补但不可相加。实现：`session.fetchCreditUsage`（按 token 缓存 5 分钟，
   全量聚合接口别跟着轮询打；解析抽成纯函数 `parseCreditUsage` 可离线测）+
   管理端 `GET /api/admin/qoder/credits/usage`（逐账号 + 逐日合并，`?force=1`
   强刷）。取不到的字段给 null 不补 0。真机实测：累计 3078.50 credits、峰值
   776.44（10-29）、371 天逐日。
2. **usage 缓存字段归一化**（对齐 hub #112）：上游按模型族把缓存命中放不同
   字段（DeepSeek `prompt_cache_hit_tokens`、Qwen
   `completion_tokens_details.cached_tokens`）——按标准协议解析的客户端读
   `usage.prompt_tokens_details.cached_tokens` 恒为 0。`chat.normalizeUsageCache`
   把数字搬进标准位、原字段保留（已适配上游形态的客户端不受影响），流式在
   转发前改写 usage 帧、非流式在 aggregate 出口改写；上游没给缓存时不凭空造
   字段，已有标准位时不覆盖。
3. **错峰优惠透出**（model-info.js 的 `offPeak` 字段 + 界面橙色徽标）：上游
   `promotion` 字段原样透出（discountFactor + 窗口）。**不解读成「x 折」**——
   discount_factor 的乘性方向没实测过，编一个口径会被对账打脸。真机实测
   qmodel_38max 带 `{discountFactor:0.4, window:"22:00-08:00"}`。
   **2026-10-31 补**：上游 `usage.original_credits`（折扣前额度，社区项目
   EchoPing07/Qoder-2API-Go 实测字段）若下发则随积分账本落 `original_credits`
   + `discount` 两字段——credits/original 即真实折扣，乘性方向从此实测化；
   上游没给不造字段（usage-norm 同款口径）。

**P2 明确不做的两项（别再翻出来做）**：上下文窗口按请求可调（hub 的默认是
200K 档才需要「抬窗」，我们已经默认按最大档下发，覆盖只能往下调没有意义）；
工具调用泄漏回读（hub 的场景是文本标记工具历史被模型照抄进正文——我们发的是
结构化工具历史，且部署中无实测案例，不值得为它给热路径加跨帧缓冲门）。


**Qoder 的实测倍率账本（2026-10-30 落地，上游改路由的可见性）**。融合自
qoder2api-hub #113 的 billed_model 思路（保守版）：Qoder 响应的 model 恒为
"auto"，请求的模型可能被服务端静默换掉。每条积分账本现在带 `billed_rate`
（`credits.js` 的 `computeBilledRate`：credits ÷ (tokens/1000)），与模型表的
price_factor 人工比对——**不做自动 mismatch 判定**：错峰优惠
（discountFactor）会合法改变倍率且乘性方向未实测（CLAUDE.md 明确不解读），
自动判必误报。期望倍率取 `rate > 0 ? rate : rateOriginal`——**错峰窗口内
（22:00-08:00）免费档的 price_factor 标 0 但实际按 original_price_factor
计费**（实测 qfmodel：credits 0.136 / 91 tokens → billed_rate 1.4947，与
标称的 0/0.1 严重不符——要么上游改路由要么倍率元数据过期，这正是要暴露的
信号）。期望倍率缺失（两者都 ≤0）时如实 null 不编。**2026-10-31 补：悬案的第三种解释已确认并修复**——官方 CLI 在 business 块带 `model_key`，缺失时**所有模型被记成 auto 档计费**（hub #119）；我们 `buildBody` 的 business 块正是缺这个字段，已补（`chat.js`），离线断言在 verify-qoder-channel。离线验证：
`node --test test/unit/qoder-billing-rate.test.js`（13 项）。管理端探针端点：
`GET /api/admin/qoder/billing-check?model=qfmodel`（admin/routes/qoder.js）——按
模型发一个小请求，从账本读回 billed_rate 与标称值并排返回（expected/billed/
ratio），panel 会话鉴权后；ratio≠1 的判读口径写在响应 note 里（错峰优惠与
倍率元数据过期都是合法偏差）。**模型页有「计费自检」按钮**（ModelsView.vue
的 Qoder 卡 extra，对模型表里倍率最低的模型跑探针，结果按 ratio 偏离 ±5%
着色成 success/warning）。

**TRAE 的计费自检探针（2026-10-30 落地，与 Qoder 同名端点对齐）**。
`GET /api/admin/traework/billing-check?model=X`（admin/routes/traework.js）按模型
发一个小请求（数 1~400，让输出够长以压过 consumed 两位小数的量化误差），
比对「实测倍率 vs 模型表标称」。**数据源与 Qoder 不同**：Qoder 的
`usage.credits` 是上游直给的单请求扣费；TRAE 没有逐笔账单，只能读
`usage_summary.consumed_amount` 的前后差值——所以探针先快照**所有**可用账号的
consumed（选号交给池，事先不知用哪个号），请求完成后轮询（4 次约 8 秒）直到
增量出现；8 秒内没涨就如实报 `delta: null` + warning，**不把「没测到」编成 0**。
服务账号 id 由 `send` 的 `onAccount(name, id)` 上报（本次给回调加了第二个参数，
向后兼容），并发流量让多个账号同时涨时只取服务账号自己的增量。
判定逻辑是纯函数 `src/traework/billing.js`：`expectedRate`（命中会员折扣取折后价，
否则标称价；都缺失如实 null）、`billedRate`（Δconsumed ÷ tokens/1000，**推断
口径**——依据是历史账本里 glm-5.2 的实测比值落在 0.69~0.75、与标称 0.78 同量级，
不是上游文档）、`attributeDelta`（增量归属）。期望倍率从 `models.fetchModels`
的归一化行取（admin 进程自己拉表，不依赖网关进程的快照）。前端在 TRAE 模型卡
有「计费自检」按钮（挑 `usage=chat_completion` 里倍率最低的模型；`billed` 为
null 或 ratio 缺失比偏差更常见，单独标黄）。**真机首批结果（2026-10-30）**：
glm-5.2 ratio≈0.96（Δ1.79 / 2393 tokens，正常）；**DeepSeek-V4-Flash 两个账号
都稳定在 ratio≈1.35**（Δ0.23 / ~850 tokens，标称 0.2 实测≈0.27）；
**deepseek-v4.1-flash（按钮默认选中的 0.06 档）ratio≈2.6**（Δ0.15 / ~970 tokens，
标称 0.06 实测≈0.15）——后两者要么是倍率元数据过期、要么是有未文档化的计费
差异，正是这个探针要暴露的信号；判读永远结合标称值与多次结果，不做自动判定。
（历史 `traework-credits.jsonl` 的差值受 60 秒采集节流影响会合并多条请求，
不能用来反推单模型倍率——只有探针的前后快照是单请求的干净测量。）离线验证：
`node --test test/unit/trae-billing.test.js`（11 项）。

**千问的计费自检探针（2026-10-30 同日，与 TRAE 同形不同判据）**。
`GET /api/admin/qwenwork/billing-check?model=flash`（admin/routes/qwenwork.js）——
发一个小请求（数 1~400），**force 读**三池余额前后差值（30s 缓存会吞掉本次
差值），归属口径与 `credits.capture` **逐字一致**（`free = max(0, Δdaily)`、
`paid = max(0, Δmonthly+Δlongterm)`，longterm 负值坏读时不会算出负消耗）。
**千问上游没有标称倍率/单价**（模型表无 price_factor），所以没有 ratio 可比——
响应里 `expected`/`ratio` 恒 null，只有 `cost`（本次三池差值）、逐池 `pools`、
`billed`（每千 token 成本）。判读靠历史量级：实测 flash 约 **0.002~0.01
credits / 千 token**，余额 4 位小数，短请求偏差主要来自精度。结算轮询 3 轮
（约 4 秒，依据是 `credits.capture` 的 1.5s 实测余量）；没测到如实 `cost: null`
+ warning，不编 0。纯函数在 `src/qwenwork/billing.js`；前端在千问模型卡有
「计费自检」按钮（默认挑 `flash`），成本为 null 标黄、其余用 info（无标称值
可做 ±5% 着色）。离线验证：`node --test test/unit/qwen-billing.test.js`
（10 项，差值口径/负值坏读/归属）+ `test/unit/qwen-billing-probe.test.js`
（3 项，路由编排打桩：归属、失败如实、没测到不编）。**真机验证受阻于额度**：
落地时两个千问账号都是 402 硬冷却（到本地 0 点），恢复后跑一次
`/billing-check` 即可完成首个真机样本。

**Codex 自由格式工具（custom_tool_call）与 model=auto 兜底（2026-10-30）**。
Responses 入口此前把 `custom_tool_call` / `custom_tool_call_output` 落进 default
分支**静默丢弃**——Codex 配了 freeform 工具（如 apply_patch）时调用了凭空消失。
现在转成标准 function 调用（input 包装成 `{input}` 单字段对象），`*_call_output`
再解回 tool 消息。`model=auto` 在直连通道的兜底：搭子有 mapModel 兜底、千问有
别名表（auto→pro）、Qoder 上游原生 auto 档，**只有 TRAE 会撞 assertModelKnown
的 400**——`traework/auto` 现在兜底到 DEFAULT_MODEL（glm-5.2，真机 200 验证）；
不做 Trae2api-cn 的「按请求内容智能路由」（隐性替换模型违背显式契约，计费倍率
跟着变）。`previous_response_id` 维持忽略（上游无状态，Codex 全量回传 input）。

**千问通道的 usage 缓存归一（2026-10-30，qoder2api-hub #112 的另一半）**。
Qoder 通道 P2 修过 usage 缓存字段归一，**千问的流式透传一直没修**——DeepSeek 系
模型的 `prompt_cache_hit_tokens` 原样透传，按标准读的客户端恒见 0。归一化实现
提升到共享模块 `src/usage-norm.js`（两个 COSY 通道 require 同一份，与
upstream-errors.js 的收敛同一理由），千问在流式帧转发前改写（有改写才重新
序列化，无缓存字段时帧原样——真机冒烟：上游自带标准位时不覆盖）。非流式
aggregate 出口同修（chat.aggregate 的 usage 在返回前归一）。

**千问的 `is_reasoning` 字段同样不可控（2026-10-30 实测定案，别再试）**。
buildBody 的 modelConfig/model_config 两处 `is_reasoning` 硬编码 false——曾想
按 Qoder P1 的思路做成档位开关，对照实测（qwen/pro 同一水壶谜题 × 2+2）：
false 组 reasoning 2788/16336，true 组 **1482/1**（方向相反、噪声级）——上游
忽略该字段或它不是推理开关语义。与搭子「调参数无效」、TRAE「档位字段被忽略」
同款结论：**四条通道里只有 Qoder 的思考档位真实可控**。

**`cosy.encode` 是同步的，它一慢就「假死」整个网关（2026-10-03 修，性能级）。**
自定义 base64 编码在 `runOnce` 里**直接同步调用**，所以它的耗时会**阻塞事件循环**：
期间 `/health` 不响应、其他通道的请求全部排队、进程 CPU 跑满却**不崩也不打日志**。
客户端表现是「一直转圈、没有任何输出」（cc-switch 侧报
`504 流式响应首包超时: 600s`，两次重试 ≈ 23 分钟，与用户看到的一致）。

原实现是 `let out=''; for(...) out += mapped;`——V8 的字符串拼接近似 **O(n²)**，
再叠上 `std.slice()` 三段重排的临时字符串。实测：

| 输入 | 原实现 | 现实现 |
|---|---|---|
| 16 MB | 3.1 s | 0.26 s |
| 64 MB | **15.2 s** | 1.05 s |
| 128 MB | **4 GB heap OOM 崩溃** | 1.77 s |

改法是**下标置换 + 预计算查表（Uint8Array 按码点直索引）+ 一次性 Buffer**，
全程 O(n)、无中间大字符串——重排本质是纯下标置换（新串第 i 位 = 原串第 perm(i) 位），
不必真的拼字符串。正确性由 `test/verify-qoder-encode-perf.js` 与朴素实现
**穷举比对**（2200+ 组，含 len 0-400 × 5 种填充 + 随机字节）+ 固定向量锁定。

**同类风险**：翻译层也有 `fullText += delta.content` 这类累积，但它们累积的是
**模型输出**（KB 级），而 `encode` 处理的是**整个请求体**（Codex 一次能发几十 MB），
量级差三个数量级——**不要把两者混为一谈，后者才是真瓶颈**。

**排查这类「静默假死」的办法**：`node -e "process._debugProcess(<pid>)"` 打开
inspector，再用 WebSocket 连 `:9229` 发 `Debugger.pause` 抓调用栈。
**注意**：若阻塞发生在**原生代码**里（如 RSA/AES 或 GC），`pause` 会超时无响应——
那本身就是「阻塞在 native」的信号。本次正是靠它抓到 `encode @ cosy.js`。

**网关现在带事件循环卡顿监控**（`startLagMonitor`，`src/server.js`）：卡顿超过
`DUMATE_LAG_WARN_MS`（默认 2000ms）就打一条带时长的日志。它不解决卡顿，
但把「静默假死」变成「日志里有明确时间点」。`DUMATE_LAG_MONITOR=0` 关闭。

**跨进程陷阱**：`model-info.js` 的 `qoderRows` **必须自己拉模型表**（`session.fetchModels`），
不能只读 `setQoderModels` 写的快照——快照由网关进程写入，而 `/models/info` 跑在管理端进程，
两者模块状态独立。TRAE 同理（`traeworkRows` 直接 `fetchModels`）。

**千问办公是进程内直连，不需要任何外部服务、也不再需要客户端。** 早期版本经 Buddy2api（8787）中转，后来发现它的 `wasm_helper.mjs` 本身就是纯 Node ESM 脚本、Python 只是一层没必要的壳，改为直连后少一个进程、少一层鉴权、少一个故障点。`src/qwenwork/` 现在**默认用本地算法签名**（`cosy-sign.js`，见下文「硬约束」第 1 条），请求直接发到云端网关。

**千问通道的硬约束**：
1. **签名默认走本地算法，不依赖 wasm、也不依赖客户端**（2026-10-14 改）。原实现只有 wasm 一条路，理由是「本地自实现的编码会被服务端拒（`400 Invalid agent chat JSON body`）」——那是 2026-09-23 的结论，当时还没有 `cosy.js`（Qoder 通道 10-02 才接入，其签名算法与参考实现逐字节比对过 22 项测试向量）。而千问与 Qoder **是同一套协议栈**：同一个 client_id、同一个聊天路径、同一套 `Encode=1` 自定义 base64、连服务端公钥都是同一把。所以那份算法直接适用于千问——差异只有 cosyVersion（1.1.52 vs 1.0.10）与几个客户端身份头。实测用同一套算法签名 → `gateway.qwenwork.cn` 返回 200 并正常出流（19 帧、正文 "OK"、usage 完整）。实现见 `src/qwenwork/cosy-sign.js`，算法本体在 `src/cosy.js`（与 Qoder 共用一份，**不要再复制第二份**）。官方 wasm 保留为退路：`DUMATE_QWENWORK_USE_WASM=1` 切回；wasm 是客户端二进制资产，**不能复制进仓库**，只能运行时从安装目录读（`src/qwenwork/wasm-path.js` 自动探测并取版本号最大的目录）。**顺带解决两件事**：客户端卸载后通道不再直接死（wasm 随卸载消失，用户 2026-10-14 卸载后即遇到），且不再每请求 spawn 一个 Node 子进程跑 wasm。
2. **不套 `mapModel`**。千问的模型名（`pro`/`flash`）不在搭子别名表里，过 `mapModel` 会被兜底成 `model-text`，前缀随之失效。
3. **外层永远 HTTP 200**，真实错误在信封的 `statusCodeValue` 里。**且它不发 `data: [DONE]`**，而是用 `event:finish` 收尾——转发时必须按 OpenAI 规范补发 `[DONE]`，否则 Codex 等客户端认为响应未完成。
4. **请求体必须带 `business` 对象**，否则无论签名是否正确都 `503 Model catalog unavailable`。
5. **`tools` 必须过滤成只留 `function` 形状**。上游只认标准 OpenAI 形状；Codex 每次请求都会带 `namespace`（`multi_agent_v1` / `mcp__cua_repl`）与 `web_search`，**带上任何一个都整轮 400**（不是丢弃那个工具，而是整个请求失败）。过滤在 `src/qwenwork/chat.js` 的 `buildBody`。
6. **`system` 必须留在 `messages` 里**。上游**不读顶层 `system` 字段**——原实现把 system 摘出来单独传，导致系统提示词（含 skills 定义、行为约束）全部丢失，表现为模型「随口答两句就停、不按要求做事」。顶层字段可以照旧带上做兼容，但权威来源是 messages。

**千问的 `listModels` 签名必须覆盖模型表自己的路径（2026-10-31 修，此前从未拉通）**：
签名串带 `pathSig`，旧实现复用聊天路径的签名去打 `/api/v2/model/list`，上游判
`Signature invalid`（403）且**静默回落静态表**——管理端模型表从来没真正来自上游。
现按 `cosy-sign.buildHeaders(sess, constants.MODELS_PATH, '', 'application/json')`
重签（GET 空体签名，与 Qoder 的 queue/status 同一约定）。

**千问的 `imageUrls` 槽定案（2026-10-31，别再试）**：body 里的 `chat_context.imageUrls`
槽上游**不消费**——dataURL 数组、裸 base64、pro 档重试全部「看不到图片」。槽位存在
（Buddy2api 也发 None）但纯文本才是有效载荷，占位文本方案维持。

**千问的预算与上下文（实测值，别照抄搭子的）**：
- 预算走 `resolveQwenMaxTokens`，下限 **16384**（`DUMATE_QWENWORK_MIN_MAX_TOKENS`），**默认值 131072**（`DUMATE_QWENWORK_DEFAULT_MAX_TOKENS`，与搭子的 `DEFAULT_BUDGET=32768` 分开）。搭子的 32768 对千问偏大，但 4096 又太小——实测 4096 时 reasoning 会把预算吃光，模型陷入反复推演后只吐一句话。
- **上游接受的 `max_tokens` 范围是 `[1, 131072]`**（实测 2026-09-27）：131072 通过，**131073 起一律 400**（`pro` / `flash` 边界一致）。**省略该字段不报错**，实测一次输出到 66807 token 才自然收尾（`finish=stop`）——说明上游自己的默认值远大于 66807。
- 因此默认值直接取上游上限 131072：原来网关发 32768，**是网关自己把上限压低了**。代价实测过——Codex 不发 `max_output_tokens`，网关按默认值下发，实测「一次写 3 章」的单轮输出（≈8400 字正文 + 工具参数里又写一遍正文 + 两万多 token 推理）正好撞满 32768，上游报 `length`，断在工具参数中间那一章就丢了（实测断在 `@('第三章　第七户','',`）。取上限后网关不再是那个约束，与官方客户端行为一致（客户端自己也不带这个字段）。
- 上下文上限 **~1,024,000 token**（1250K 汉字 = 1,022,745 token 通过；1262K 起 502，1300K 起 400）。`pro` 与 `flash` 边界一致。
- **超限不是截断而是整轮失败**（400/502），所以客户端声明的 `model_context_window` 宁可小一点。
- 输出侧 `max_tokens` 约束比搭子松：传 4000 实测能输出 7808，且自然收尾（`stop`）而非被截断。
- 上游模型表（**2026-10-31 真机复核**——修复 `listModels` 签名 bug 后首次真正从上游拉通）：`pro`（高级）/ `flash`（标准）/ `qwen3.8-max-preview`（千问最强，已实测可用并补进 `FALLBACK_MODELS`）。社区项目（Buddy2api）提到的 `qwork-auto/advanced/ultimate` 在当前上游**不存在**。

**千问通道必须给带工具的请求注入「执行纪律」**（`src/qwenwork/chat.js` 的 `withAgentDiscipline`）。
千问上游是**对话型**产品，其脚手架鼓励「每完成一步汇报一句」；Codex 的 `AGENTS.md` 里也有同样的进度播报要求。两者叠加后模型会把播报当成一次完整回合：只输出 `进度：N/8｜下一步：写第 N 章` 就结束，**不调用任何工具**——Codex 收到「无工具调用」的回合即判定任务完成并退出，用户看到的就是「没按要求做完就退出」。**TRAE 通道同样会犯这个毛病**（2026-10-03 实测：139-141 续写任务在 15% 处播报即收工），所以 `src/traework/chat.js` 移植了同一份注入（`DUMATE_TRAEWORK_AGENT_DISCIPLINE=0` 关闭），与千问共用文本与判定口径。实测（2026-09-27，真实 Codex 会话 `01a0e205`，一次写 3 章小说）：

- 不加纪律：连续多轮都只播报进度就收尾（把第 4 章之后的任务全丢下）；重放同一上下文 10 次有 2 次触发
- 加了纪律：**同一会话同一指令**，模型连续调用工具写完第 5、6、7 章才收尾（对比：该会话此前每轮只调 1 次工具）

只对「最终确实带工具」的请求注入（工具全被过滤掉的纯对话注入会干扰正常回答），且幂等。`DUMATE_QWENWORK_AGENT_DISCIPLINE=0` 关闭。离线验证：`node test/verify-qwen-discipline.js`。

**第二类诱因是「项目自带的技能」**（2026-09-27 补，会话 `01a0e346` 实测）。
sanguo 项目的 `novel-creator` 技能把写作拆成分阶段门控（「起草前先声明本章目标/POV/节拍」→「写完更新连续性台账」→「每章过连续性检查」，还写着「让用户审定基调后才继续」）。模型会在第一个门控处就停下播报，于是 `继续创作下3章内容` 变成「盘点项目 → 读 3 章 → 播报 20% → 结束」，0 章落盘。

**根因不是纪律、也不是 agent 侧——是 `flash` 档位**（2026-09-28 对照实测，同一会话 `01a0e346`、同一指令「继续一次3章写完ai审查」、同一份 AGENTS.md 与技能）：

| 上游 | 上游请求数 | 工具调用 | 写文件 | 产出 | 耗时 | reasoning 合计 |
|---|---|---|---|---|---|---|
| **搭子 `glm-5`**（8980） | 24 | 23 | 7 | **090-092 三章 + AI 审查 + 报告 + 台账** | **317s** | **172** |
| **workBuddy `global:hy4-preview-f`**（7864） | 20 | 19 | 5 | **084-086 三章 + AI 审查 + 报告 + 台账** | 997s | — |
| 千问 `qwen/pro`（9082） | 28 | 27 | 5 | **087-089 三章 + AI 审查 + 报告 + 台账** | 361s | 743 |
| 千问 `qwen/flash` 原始纪律 | 3 | 2 | 0 | **0 章**，停在核对 | 78s | 2000-6400/轮 |
| 千问 `qwen/flash` 加强纪律（技能流程+交付纪律） | 2 | 1 | 0 | 0 章 | 55s | 2000+/轮 |
| 千问 `qwen/flash` 无条件纪律（任何无工具回复都算失败） | 3 | 2 | 0 | 0 章 | 66s | 2000+/轮 |

**三个上游（搭子 glm-5 / workBuddy 前沿档 / 千问 pro）都完整跑通，只有 `flash` 三种纪律写法全失败**——所以这不是提示词能修的，是档位能力差异。`flash` 的失败形态很一致：推理很长（单轮 reasoning 2000~6400 token），只做「核对/确认」这类准备动作，然后把结论（「086 有一处道具冲突要先修」「核对 085/086 与貂蝉化名」）当作回合终点输出，**推理里写了「让我读 086 原文再精准改」却不发那个工具调用**。对照：搭子 glm-5 整轮 reasoning 只有 172 token、`pro` 743 token，预算全用在工具调用上。

**结论：千问通道做重创作/长任务用 `pro`，不要用 `flash`**（`flash` 只适合轻量问答）。搭子是这批里最快也最省的（317s / 172 reasoning），适合作为长任务首选。这条与「纪律注入」无关，纪律本身仍然保留（它解决的是另一类「播报即收尾」，在 `01a0e205` 会话实测有效）。

判定这类问题时要**分清「网关行为」与「模型行为」**：把出问题的那次请求（从会话日志重建 input + instructions）经网关重放，如果稳定调工具（本次 5/5、多轮循环 6 轮 × 3 次全正常），说明是概率性的模型行为而不是网关丢帧——**不要为了一个复现不出来的现象去改翻译层**。本次排查还顺带确认：sanguo 会话上下文其实只有 1.3~2.5 万 token（网关日志里 25 万那条属于另一个会话），所以与长上下文无关。

**TRAE 通道支持图像输入（2026-10-30 落地），且形状就是 OpenAI 标准的——不要发明新转换。**
实测（真机对照）：`llm_utils_chat` 请求体的 user 消息 content 里直接放 OpenAI 标准
`{type:'image_url', image_url:{url:'data:image/png;base64,…'}}`，上游接受（纯红色 PNG →
deepseek-v4.1-flash 答「红色」）；而 Trae2api-cn 的「渲染层媒体块」形状
`{type:'image_url', value:{mimeType,data}}` 会被 4001 拒——那是 raw（llm_raw_chat）链路的
形状，**两条链路的图像协议不同**，照搬别人的会翻车。HTTP(S) 外链未实测（上游是否代拉外网
未知），data URI 已实测可用。

分层架构（`src/images.js` 是共享层）：

- **翻译层保真**（`anthropic.js` 结构化分支 / `responses.js` 的 inputToMessages /
  `google.js` 的 googleToOpenAI）：各家图像块统一转 OpenAI image_url part。
  Anthropic 的 `source:{type:'base64'}` → data URI、`source:{type:'url'}` → 原样；
  Responses 的 `input_image` 兼容字符串/对象/顶层 url 三种写法；Google 的
  `inlineData` → data URI。此前占位文案「not supported by DuMate backend」是
  搭子的能力边界被错套到所有通道。
- **通道层消歧**：TRAE 直通 + **多模态校验**（`traework/index.js` 的
  `assertImageSupport`，在**选号之前**——模型能力与账号无关，不占池）；模型表
  `multimodal=false` 时回 400 并列出可用多模态模型（表没就绪则放行，宁可不挡）。
  buildBody 剥掉非 user 消息的图像 part（上游对 assistant/tool 带图的行为未知）。
  千问的 COSY 协议只有纯文本槽（`chat_context.text`），图像展开成占位文本
  ——**必须走 `images.contentText`，不能 `String(content)`**：翻译层保真后 content
  可能是数组，`String([{type:'text',…},{type:'image_url',…}])` 会得到
  `"[object Object]"`，模型看到垃圾（千问 buildBody 的签名是
  `buildBody(modelKey, payload)`，与 TRAE 相反，改的时候别搞混）。
  Qoder 的 COSY 协议**有 `imageUrls` 数组槽**，实测上游接受 dataURL 字符串数组
  形状（HTTP 200，裸 base64 也可）；模型对图像的识别准确度由上游决定，
  网关层面只负责透传。实测：纯红色 PNG 发过去，Qoder 返回 200 并尝试回答
  颜色（回答不准属上游模型问题，非网关透传问题）。
- **搭子图像透传**（2026-10-31 起，推翻 10-30 的压回）：真机实证搭子云网关认 OpenAI 标准 `image_url` part（data URI，网页凭证与桌面链路一致，能正确识别图像内容如颜色），`server.js` 两处 `flattenImageParts` 压回已删除、`anthropic.js` 搭子分支图像保真、`images.js` 的 `flattenImageParts` 已删。**测试图不要用 8x8 这类退化尺寸**——会撞千帆 v2 `internal_error`（502），与权益无关。OpenAI 直通路径不经翻译层，客户端自己发的图像照旧直达上游。

离线验证：`node --test test/unit/image-passthrough.test.js`（12 项：翻译层三个入口
的保真、搭子降级、TRAE 透传与非 user 剥除、千问防 [object Object]、images.js 基元）。
真机验证：Anthropic 入口带图打 `traework/deepseek-v4.1-flash` → 答「红色」；
`traework/glm-5.3-flash`（非多模态）→ 400 + 多模态模型列表；Responses 入口
`input_image` 同样通过；搭子 glm-5 带图 → 200 且模型如实说看不到图片。

**TRAE 的 llm_utils_chat 链路不支持请求级思考档位——实测定案，别再试（2026-10-30）。**
Qoder P1 的思考档位透传想同样接到 TRAE，实测（11 次真实请求，minimax-m3.1-flash，
同一道水壶谜题、light × 3 vs extra_high × 3 对照）：请求体顶层的
`reasoning_effort` 与 `reasoning_effort_level` 两个字段**上游都忽略**——light 组
6891~10733 token、extra_high 组 5645~7847 token，区间完全重叠且均值方向相反，
纯噪声。模型表条目确实带 `reasoning_effort_config`（`{support_thinking, options:
["light","high","extra_high"], default_level}`，51 个模型里 32 个带、多数
`support_thinking:false`），但档位是**服务端模型配置**（`config_name` 引用）的一部分，
请求级覆写不生效——与 Trae2api-cn 端点表里 Solo/IDE 标注的「思考强度由模型
CustomModel 声明决定」自洽。想提升推理深度只能靠提示词。**与千问通道「调参数无效」
同款结论**（见下文「is_reasoning 是硬编码的 false」），Qoder 是四条通道里唯一支持
请求级档位的。

**TRAE（llm_utils_chat）的错误形态实测（2026-10-30）——错误码分类按实测过的做，别照抄 raw 链路的码表。**
trae2api-hub 的码表（1001/4001/4015/4019/4023/3003）是 agent/v3 业务码体系，但
**我们链路上实测只出现两种形态**：

1. **模型名未知 → 流内 `event:error` + `{"code":4001,"message":"...param is invalid"}`**
   （HTTP 200，aggregate 已正确抛 400）。4001 的文案无信息量——分不清模型名错了
   还是别的参数坏了。所以做了**模型名前置校验**（`traework/index.js` 的
   `assertModelKnown`）：模型表缓存就绪且名字**完全不在表中**（含条目名下的
   `custom_models` 自定义模型，大小写不敏感）时直接 400 + 可用模型列表，不白烧
   上游请求；表没就绪或名字已知一律放行（在表但不可见的模型照样透传，上游当
   唯一真相源）。判定函数是 `models.isKnownModel`（`normalize` 现在保留
   `customModelIds`——自定义模型名不是顶层 config_name，漏了它会把自定义模型
   误判成「不在表中」）。
2. **鉴权失效 → HTTP 401 直接拒绝**（**不是**流内事件）——`runAttempt` 的
   `r.status >= 400` 分支已把 statusCode 透传，classify 归 session_dead（防误杀
   连续计数），无需改动。

4015/4019（风控）与 4008（额度，国际版）在我们的链路上**未实测出现**——前者
大概率以 HTTP 状态码形态出现（同 401 路径，现有分类已覆盖），后者是 raw 链路
的额度码；CN 额度耗尽在对话链路上报什么码**没有实测依据**，遇到时再补，
不预编分类。离线验证：`node --test test/unit/trae-model-known.test.js`；
真机：模型表就绪后打 `traework/no-such-model-xyz` 应立即 400 + 列表
（不再等上游 4001）。

**DSML 工具调用回退解析（2026-10-30 落地，`src/traework/chat.js` 的 `parseDsmlToolCalls`）**。
DeepSeek 系模型偶尔把工具调用以**文本标记**写进正文（`<dsml:calls>` 包
`<dsml:invoke name="…">` 包 `<dsml:parameter name="…">`，不走原生 tool_calls 增量），
客户端拿到 XML 文本、本轮工具不执行。处置是**纯兜底**：只在「正文含 DSML 标记
（大小写不敏感）且本轮零原生 tool_calls」时解析还原并从正文剥离；**原生调用永远
优先**——有原生调用时正文里的 DSML 文本原样保留（那可能是模型在讨论格式）。
标签名里 dsml 的位置与分隔符不固定（`dsml:` / `DSML_` 都认），大小写不敏感。
解析出的调用走与原生相同的 finish 纠正（`stop` → `tool_calls`）。**流式路径**
在正文缓冲门（createTextGate）的 finish 里做：整轮零工具调用、正文还在缓冲
（未转直发）时解析并补发 tool_calls，正文发剥离后的干净版；**已转直发（live，
>600 字）的场景正文出去了收不回，维持现状不劣化**。不要在 delta 层做——DSML
块跨帧，逐帧解析必然切碎。离线验证：`node --test test/unit/trae-dsml.test.js`（8 项）。
踩过的坑：`exec` 循环的正则**必须带 `g` 标志**（无 `g` 的 exec 永远返回第一个
匹配，while 循环死循环挂死进程——单测超时就是这么暴露的）。

**DSML fail-closed 三分判据（2026-10-31，hub#120 推广到三通道，解析器收敛到
`src/repair.js`）**。Qoder/千问同跑 DeepSeek 系，一样会犯——只救「正文还在缓冲
（未转直发）」的场景。分类器 `repair.classifyDsml(text)`：
`recovered`（完整 calls 块还原成 tool_calls + 干净正文，finish 的 stop 纠正）、
`empty`（标签闭合但没有 invoke 的空壳——剥离标记 + WARN，**不剥离会被
「播报即收尾」的判据反复捞出形成无限重试**）、`leak`（calls/invoke/parameter
开了没收——**报错 fail-closed**，把半截协议喂给客户端比明确失败更糟）。
代码围栏内的 DSML 是模型在讨论格式，不碰（`stripFences` 先判）。TRAE 门
（createTextGate）与千问/Qoder 共享门（createChunkGate，finish 阶段兜底，
需传 `{model, channel}`）同一语义；非流式在各自 aggregate 出口接。traework
流式的 leak 抛错已标 `e.sent=true`（reasoning 早已直发，不标会让上层换号
重试导致客户端看到两段内容）。离线验证：`node --test
test/unit/dsml-failclosed.test.js`（11 项）。

**agent 网关的动态发现（2026-10-31，`src/traework/tnc.js`，misakano
traework2api-panel 同源逆向）**：官方客户端**不写死** agent 网关——它请求逻辑
主机名（`trae-api-cn.mchost.guru`），TTNet 按 TNC 下发的域名表在传输层改写成
具体后端（api5-normal.mchost.guru 等）。上游换分片时（国服 2026-10-15 刚换过）
写死的基址就静默失效。`tnc.js` 拉表（免鉴权，aid 分区：国服 787976 / 国际
677332，`cronet_version`/`ttnet_version` 不能空——清空退化成 0 条规则），按
区域段过滤（国服无段/国际带段）、分片号降序，10 分钟缓存 + 60 秒负缓存。
`chat.postStream` 与 `models.fetchModels` 走候选链轮转：**连接级失败换下一家**
（拿到响应含 4xx 就交上层处置），连接阶段独立超时（`CONNECT_TIMEOUT_MS` 默认
10s，黑洞主机不该占满 600s），全部失败清缓存下轮重拉；TNC 不可用回落
`AGENT_HOST` 常量——发现机制自己坏掉不能影响出流。2026-10-31 真机验证：国服
表含 api3/api5-normal，实弹对话 200。账号的 `region` 字段（缺省 cn）决定
候选链；国际版 utils_chat 基址未实测（hub 只证实了 raw 链路的
`core-normal.traeapi.us`），接国际版先补国际账号。

**TRAE 的 usage 缓存镜像（2026-10-31，traework2api-panel issue#3）**：上游
token_usage 报顶层 `cache_read_input_tokens`，不镜像进
`prompt_tokens_details.cached_tokens` 的话按标准协议解析的客户端恒显示缓存
未命中。门与非流式两处都镜像（真机实测字段已出现）；原字段保留，上游没给
不造字段。**业务码 1005「订阅专享」（2026-10-31 分类，语义对齐
traework2api-panel）**：Free 号打订阅模型上游回 403/业务码 1005——换模型即可
用，进 (账号,模型) 负缓存并明确报错，不罚账号、不进熔断。判据在
`upstream-errors.classify` 里、5xx 分支之前（1005 > 500 会被 breaker 误吃）；
真机暂无订阅模型可打，分类为对齐实现、待首个真实样本校准。

**「播报即收尾」现在是三通道共用一条修法（2026-10-30，收敛到 `src/repair.js`）**。
TRAE 2026-10-05 的实测结论（见下一条）推广到千问与 Qoder：两家同样会「只播报进度
不调工具就收尾」，同一份判定与缓冲门在三条直连通道上语义一致，只差上游帧形状
（TRAE 是 `event:output`，两条 COSY 通道是标准 OpenAI chunk）。

- **判定**（`looksUnfinished`）：`无工具调用 + 正文 < HOLD_CAP + 命中「下一步/next step」`
  （空正文也算）。**不要放宽成「只要没有工具调用就重试」**——真·收尾也会被逼着
  再调一次工具，变成永不结束。
- **重试**：请求末尾追加一条 user 消息（`appendRepairNudge`，文本 `REPAIR_NUDGE`
  与 TRAE 逐字一致），上限 `REPAIR_MAX`（默认 1）。
- **两条 COSY 通道的 id 语义不同**：`request_id` **每轮新生成**（单次请求的标识，
  复用可能被上游当幂等重试合并）；`session_id` **跨轮钉住**（修复轮是同一段对话
  的下一句）；Qoder 的 `request_set_id`（排队槽位键）**也不钉**——修复轮是新的一次
  排队，`queue/status` 跟着看新槽位（`activeSetId`）。
- **缓冲门**（`createChunkGate`，标准 OpenAI chunk 版）：`reasoning_content` 直发、
  正文先扣住、`tool_calls` 一到先冲刷正文再直发、`usage`/`finish_reason`/`[DONE]`
  暂扣到轮末。重试轮**不调 `finish()`**，上一轮的缓冲整轮丢弃（下游只收到重试轮）。
- **`err.sent` 的口径要算上门的放行**：正文虽被扣住，但 **reasoning 是直发的**——
  `sent || gate.result().emitted > 0`。漏了这一半，一次「已吐出思考内容后上游报错」
  会被当成没开始输出而换号重试，客户端看到两段内容。
- **流式与上游错误/排队的交互**（Qoder）：`sawUp`（上游送来过真实数据）与 `sent`
  （到达下游）必须分开——排队守卫与换主机守卫用前者，`err.sent` 用后者。排队信封
  与额度错误帧**留在 `sawUp=false`**，否则排队等待轮的 `!sawUp` 守卫直接失效
  （这是收敛时踩到的真 bug：`sawUp` 一度写在错误判定之前）。

配置按通道独立：`DUMATE_TRAEWORK_*` / `DUMATE_QWENWORK_*` / `DUMATE_QODER_*` 的
`HOLD_CAP` 与 `REPAIR_RETRY`（见环境变量表）。离线验证：`node --test
test/unit/repair-gate.test.js`（共享模块 11 项）+ `node test/verify-qwen-repair.js`
（36 项）+ `node test/verify-qoder-repair.js`（36 项）+ 原有的
`node test/verify-traework-repair.js`（38 项）。三者都打桩 `chat.postStream` /
`chat.post`，不需要账号与网络；**池状态必须隔离**（脚本自带 `DUMATE_POOL_STATE`
临时文件，且失败用例之间要 `pool.revive()`——402/500 会让账号进冷却）。

**真机首批结果（2026-10-30）**：
- **Qoder（qfmodel）**：正常请求经门后行为不变（3.2s / 39 帧 / 正文完整 / `finish=stop`）；
  强制模型只播报进度时**修复轮确实触发**（日志 `[qoder] 播报即收尾：第 1 次重试`，
  被丢弃正文含「下一步：等待你的下一条任务指令」）。但重试轮撞上上游排队
  （`no content in 6000ms`），没拿到最终工具调用——**修复轮是一次真实的新请求，
  会重新排队**，这是排队的已知代价，不是修复引入的缺陷（重试换成新
  `request_set_id`，见上文）。
- **千问**：落地时两个账号都是 402 硬冷却（池 `cool_remaining_s≈7041`，
  到本地 0 点），真机跑不了；编排逻辑由 `verify-qwen-repair.js` 的 36 项打桩锁住，
  恢复额度后跑一次带工具的真实 Codex 会话即可补齐样本。
- **TRAE（glm-5.2）**：收敛共享常量后回归正常（2.3s / 15 帧 / 正文完整 / `finish=stop`）。

**TRAE 的「播报即收尾」靠「检测 + 重试」修，提示词修不动**（2026-10-05，`src/traework/`）。
现象：`Doubao-Seed-Evolving`（Codex `model_reasoning_effort=high`）在**带工具的**请求上
有 20~67% 的概率只输出一条进度播报（`当前进度：8%｜已完成：…｜下一步：读取…`）就结束回合，
Codex 把「无工具调用」判定成任务完成退出——用户看到「没按要求做完就退出」。
**排障关键**：上游 SSE **没有被截断**——流式 `reasoning_content` 与收尾帧 `extra_info.content`
**长度完全相等**（实测都是 244 字符），`done` 帧也正常到达。模型是真的在「Need list chapters concise.」
这种半句推理后跳到播报、不发工具调用。所以这不是丢帧，不能去改翻译层。

实测（同一份真实 Codex 请求，各跑 4~5 次，判据＝该轮有没有发出工具调用）：

| 手段 | 成功率 |
|---|---|
| 现状（纪律注入已在 `system[0]` 尾部） | 1/5 |
| 去掉纪律（对照） | 1/4 |
| 纪律移到消息末尾 | 3/4 |
| `tool_choice:"required"` | 1/4 |
| 只留 `exec_command` 一个工具 | 2/4 |
| **重试时追加「只输出工具调用」** | **5/5** |

**结论：只有重试可靠**，`tool_choice` 上游并不真的强制。所以 `send()` 里做的是
**检测 + 一次性重试**（`DUMATE_TRAEWORK_REPAIR_RETRY`，默认 1；`0` 关闭）：

- **正文缓冲门**（`chat.createTextGate`，TRAE 版；两条 COSY 通道用共享的
  `repair.createChunkGate`）：`reasoning_content` 直发；`content` 先扣住；
  `tool_calls` 一到就先冲刷正文再直发；`token_usage` / `finish_reason` 暂扣到整轮结束。
  **正文总在工具调用之前、只有几十字，所以缓冲几乎不增加首字延迟**——不要改成「全量缓冲」，
  那会把每一轮的流式效果全丢掉。超过 `DUMATE_TRAEWORK_HOLD_CAP`（默认 600 字）转直发，
  避免长回答被扣住。
- **判据是「模型自己说还有下一步」**（`chat.looksUnfinished` → `repair.looksUnfinished`）：
  无工具调用 + 正文 < 600 字 + 命中 `下一步|next step`（空正文也算）。既然模型声明了
  下一步，回合就不该在这里结束。
  **不要放宽成「只要没有工具调用就重试」**——那样真·收尾也会被逼着再调一次工具，会变成永不结束。
- **重试 = 原请求体末尾追加一条 user 消息**（`chat.withRepairNudge`，幂等）；重试轮若仍没调工具，
  就把它的正文吐给下游收尾，不再重试。
- 触发时打一行日志（含被丢弃的正文片段），用来区分「真·播报即收尾」与「判据误伤」。

**验证**：`node test/verify-traework-repair.js`（38 项，离线，打桩 `chat.postStream`/`readStream`
与 auth/credits，不需要账号与网络）。真机验证（2026-10-05，sanguo 项目副本，
`traework/Doubao-Seed-Evolving`）：修复前 1~2 次工具调用后停在 8~18%；修复后 17 轮请求、
10 次修复触发，**第 164/165/166 三章正文（2742/2706/3298 字）＋ 正文台账 ＋ 情欲清单全部落盘**，
最后自然收尾在 `当前进度：100%`。

**工具参数被截断必须报 `incomplete`，不能报 `completed`**（`src/responses.js` 的 `truncatedArguments`）。
上游在 `finish_reason=length` 处会把 `arguments` 停在半句 JSON（实测 `{"cmd": "... @('第三章　第七户','',`，字符串都没闭合）。网关若当正常工具调用交给 Codex，Codex 会**执行一条语法残缺的命令**：命令必然失败，模型看到失败后往往只回一句「下一步：写入第 N 章」就结束回合。现在这种参数会被判成 incomplete，埋点带 `error=tool_arguments_truncated`。离线验证：`node test/verify-truncated-toolcall.js`。
顺带修掉一个误报：`emptyButTruncated` 原来只排除 `stop`，把**纯工具调用轮次**（`finish_reason=tool_calls` + 正文 0，Codex 里大量存在）也算成了截断。

**`channel` 字段是必须项**：`reqlog` 每条记录带 `channel`（`dumate` / `qwenwork`）。千问首帧实测 6.7s，与搭子混在同一均值里会让「平均首字延迟」无法归因。

**历史记录（无 `channel` 字段的旧日志）归入搭子**：分通道埋点上线前只有搭子一条通道，单列「未标注」会让用户切到搭子时数字凭空变小。只有「查看全部通道」时才显示 `untagged` 一栏。服务端过滤在 `usage.js` / `reqlogs.js` 的 `channel` 参数里做——前端筛只能筛掉当前页的行，分页总数仍是全通道的。

**千问通道失败不阻断启动**：搭子是主链路。没有可用账号时网关照常监听，`/health` 的 `channels.qwenwork.ready` 报 false（本地签名不依赖任何外部文件，所以 2026-10-14 起唯一会缺的就是账号）。

**TRAE Work 的额度要按 `usage_summary` 解析，不是额度包字段。**
`ide_user_ent_usage` 返回的是 `{ usage_summary: { total_amount, consumed_amount } }`，
剩余 = 总额 − 已消耗。早先按 `credits_remain` / `credits_limit` 求和恒得 0，
界面显示「额度 0」被读成「用完了」，而真相是没解析到。
`total_amount` 缺失时返回 `null` 而不是 0。

**TRAE 的签到是 HTTP 200 + body 里的 code**：被限流时返回
`{"code":9074,"message":"当前参与用户太多，请稍后再试"}`。只看状态码会把这次
当成成功，界面显示「签到成功」而额度没变，用户无从察觉——必须读 `code`。

**9074 有自愈闭环（2026-10-30，方案对齐 Trae2api-cn 的 device_generation）**：
9074 实测是**设备级**校验而非账号级——同一 token 换一个新派生的设备 id 就能签到
成功（这正是 2026-09-25 修好 15 位派生格式后签到恢复的原因，格式对就行）。所以
`checkin.claimWithRetry` 撞 9074 先 `authStore.rotateDevice`（`deviceGeneration`+1
重派生三件套并落盘）**立即重试一次**；仍 9074 才记退避：`60s × 2^min(count,3)`
封顶 3600s（`DUMATE_TRAEWORK_9074_RETRY_SECONDS` / `_MAX_BACKOFF_SECONDS` 可调），
温和指数的依据是「9074 是上游容量信号不是对本账号的惩罚，当天内保持尝试比
一小时封顶更有机会签上」。记账在账号记录的 `checkin9074Count` / `checkin9074Until`
（成功即清零），`checkinAndSave` 的 `respectBackoff: true`（定时任务路径）在退避
窗口内跳过不打上游；**手动触发不拦**——用户明确要求就试一次。退避到期后由
task-scheduler 下一轮（30 分钟粒度）自然重试，签到幂等且当天签上即可，不需要
独立的秒级重试循环。三个边界：`rotateDevice` 只轮换「确实是派生的」设备
（`deviceDerivedFrom` 缺失 = 手填的，轮换它不是我们的决定）；`deriveDevice` 的
gen 0 种子与原算法**逐字节一致**（uid 原样），既有账号的设备 id 不漂移；
task-scheduler 原来的「9074 就短路跳过剩余账号」已移除——设备级问题不传染，
各账号独立处置。**管理端账号卡透出退避状态**（`TraeworkAccounts.vue` 的
`checkinText`）：退避窗口内显示橙色「9074 退避 Ns」（语义是「等自动重试」，
不是故障也不是可签到）；数据来自 `/status` 的 rows——`authStore.list()` 直出
全部落盘字段，后端不用再加透出层。离线验证：`node test/verify-traework-9074.js`（25 项：代数派生、
退避序列、轮换落盘、自愈闭环打桩、退避尊重与手动不拦）。

**签到结果必须报「到账差值」，不能只报总额**（`checkin.js` 的 `computeGained`）。
上游 `claim` 只回 `{code:0, message:"success"}`，**从不告诉发了多少**；`status` 的
`credits`（实测恒为 150）是「签到可得」的固定值，**不等于实际入账**。早先只报
一个余额总额，用户看到「签到成功 + 4144.95」无从判断签到生效没有——实测
`status.checked_in` 与 `usage_summary` 会不同步（status 说没签、usage 已含奖励），
这时网关走「签到成功」分支而余额纹丝不动，被读成「显示的是旧积分」。
现在签到前后各取一次 `usage.remain`，差值即实际到账，并把「前 → 后」一并报出。
边界都如实给：差值为 **0** 说明奖励延迟入账（不粉饰成 null），为**负数**说明
上游结算异常或并发消耗（不吞掉）。快照失败才退回 `null`——**不补 0**，0 会被
读成「签到没发积分」。离线验证：`node test/verify-traework-gained.js`。

**TRAE 的账与千问、搭子都不同，界面三套分开显示**：搭子靠上游账单 + 余额游标，
千问是三个积分池，TRAE 是每个账号独立的一份 credits（签到领取）。
三边数字**不能相加**。

**TRAE 上游的工具调用增量字段叫 `function_call`，不是 OpenAI 的 `function`**
（2026-10-03 修，Codex 全挂级）。实测上游发的是
`{"index":0,"id":"call_x","function_call":{"name":"read_file","arguments":""}}`
且**后续增量里 name 是空串、只有 arguments**。网关此前流式裸透传
`toOpenAIChunk`，Responses 翻译器按 `tc.function.name` 取名落空——Codex 收到
**空名工具调用**，报 `unsupported call:`（一轮回 4 个），随即断流重连 5 次全 502
（重连与未断的上游流并发，同账号第二条请求被上游瞬拒，`statusCode` 缺失记成 502）。
非流式 `aggregate` 的 `tc.function || tc` 兜底同样取不到 `function_call` 里的名字，
chatlab 试调台的工具调用名字也一直是空的。修法：`chat.normalizeToolCall()` 把
`function_call` / `function` / 平铺三种形状统一归一成 OpenAI 形状，**流式与非流式
必须走同一个归一化**（只改一处，另一处照旧瞎）。离线验证：
`node test/verify-traework-toolshape.js`（向量取自实测抓包，不要改）。

**TRAE 流式的 usage 与 finish_reason 由 `index.js` 补帧**（2026-10-03）：
上游的 `token_usage` / `done` 事件此前在流式路径被丢弃，客户端与埋点的
token 恒为 0、length 截断被当成正常收尾。现按 OpenAI 的 include_usage 约定补发
`{choices: [], usage}` 与 `{choices: [{delta: {}, finish_reason}]}` 两类帧——
三个翻译器（responses/anthropic/google）都按 `cj.usage` 与 `choice.finish_reason`
消费，字段名不能改。

**cc-switch 的全局 `common_config_codex` 会把 `model_context_window = 1000000`
注入每一个 codex provider**（为 qwen/gfmodel 这类 1M 模型设的）。TRAE 四个模型
只有 256K（Doubao 系）/200K（DeepSeek 系），provider config 不自带覆盖时，激活后
Codex 到 90 万 token 才压缩历史，上游 25.6 万就 400 拒——**续写小说这类长会话
一恢复就死**，表现是「一连 6 次 400/断流后重试全失败」（09-29/09-30/10-02 三个
晚上的 6 连 400 与此吻合，当时还误判成账号 token 问题）。修法与 Qoder 同模式：
provider config 自带顶层 `model_context_window = 200000` +
`model_auto_compact_token_limit = 170000`（**取四个模型的最小值**，声明不得高于
任何一个可选模型），catalog 条目另补 per-model 的 context_window。
脚本：`~/.cc-switch/fix_traework_context.py`（幂等，带备份）。

**每请求 spawn 一次 Node 子进程**（调 wasm_helper.mjs）——**这已是历史**：2026-10-14 起千问默认走本地签名（`src/qwenwork/cosy-sign.js`），不再 spawn 子进程。只有 `DUMATE_QWENWORK_USE_WASM=1` 时才回到 wasm 那条路；那时若成为延迟瓶颈，改成长驻子进程只需改 `src/qwenwork/bridge.js`——`wasm_helper.mjs` 已预留 `serve` 模式，上层 `chat.js` 不受影响。

用前缀而不是猜模型名的理由：两侧模型名会撞车（搭子有 `glm-5`，千问上游也是 GLM 系），猜错了两侧都返回 200，从响应里根本看不出来；且隐式路由会让同一名字今天走 A 明天走 B。未知前缀若静默跑到搭子，会拿到「看起来成功但完全不是想要的结果」，比直接 400 难查得多。


**`stable/` 是冻结快照**——网关闭包的拷贝（当前 **73 个 `.js`**：顶层 43 个 + `qwenwork/` 9 个 + `traework/` 9 个 + `qoder/` 8 个 + `admin/` 4 个），**不随主目录开发改动**，保证 9080 不被开发中的代码波及。快照有自己的启动脚本 `stable/start-stable.bat`，默认用 `<repo>/data`——与开发实例共享同一份数据，这是有意的（账号池共用）。

**发布新版时不要简单地「把 `src/*.js` 覆盖过去」**，两个坑：

1. **`src/*.js` 这个 glob 漏掉子目录**——`qwenwork/` 与 `traework/` 共 17 个文件不在里面。漏了它们，网关能启动但通道直接不可用。
2. **会把管理端一起带进去**——`login-browser.js`、`task-runner.js`、`task-scheduler.js`、`web-gateway.js`、`records.js`、`points-agg.js` 都不属于网关闭包（快照历来只含网关），带进去会让快照无谓膨胀、还引入 playwright 依赖。

正确做法是**按依赖闭包复制**：从 `src/server.js` 出发递归解析 `require('./x')`，把闭包内的文件逐个复制到 `stable/src/` 同路径。这样既不会漏（`fallback-web.js`、`web-pool.js` 就是靠这个补上的——它们在 09-27 加入后快照漏了两版），也不会多。复制后必须做三件事：

- **逐字节比对**确认 `stable/src` 与 `src` 的闭包完全一致（数量相等且内容相同）
- 对快照跑 `node --check` 与一次**独立启动**（换个临时端口，如 `DUMATE2API_PORT=19099`），确认三条通道就绪
- 更新 `stable/SNAPSHOT_FROM.txt`：**指纹 + 算法 + 来源提交 + 本次覆盖了什么 + 验证记录**

**指纹算法必须写进 `SNAPSHOT_FROM.txt`**。历史上记过一个 `f7e7a810…` 但没记算法，后来试了二十多种拼接变体都复现不出来，那个值永久失效。现行算法：`sha256( 按相对路径排序后 [相对路径 + LF + 内容] 拼接 )`，UTF-8 编码。

管理端刻意**不代理模型协议**——网关已经在做，多一跳只会多一个故障点。所有进程通过 `data/` 目录下的文件通信，不通过 IPC。

**三套凭证，互不干扰**：

| 凭证 | 存储 | 特点 |
|---|---|---|
| 桌面凭证 | `%APPDATA%\qianfan-desktop-app\auth.json` | 客户端登录态，**同一时刻只有一份**；cookie 由 Go 后端读，本项目不接触 |
| 网页凭证 | `data/web-accounts.json` | 浏览器 cookie，**明文存**（必须原样重放），可多账号并存 |
| API Key | `data/keys.json` | 我们签发给调用方的，**只存 sha256** |

**关键分界**：桌面端同一时刻只有一个账号可用，网页端可以管多个。所以「两个账号都有效」只在网页端成立——仪表盘的「账号状态」表（桌面）与「账号健康快照」（网页）是两套数据，**不要互相替代**。

**网页账号的显示名一律走 `accounts.displayName()`，不要直接用 `a.name`**（2026-09-29 修）。`accounts.create()` 在用户没填名字时会写入占位名「账号 N」，而 `nickname` 早先**只在浏览器登录那条路径**（`/login/poll`）回填——手动粘贴 cookie 添加的账号走 `POST /web-accounts`，那条路径从不写 `nickname`。结果：这些账号的显示名永久停在「账号 1」，哪怕上游 `user/info` 明明返回了「张三」。用户报的「为什么显示账号 1 而不是真实用户名」就是这个。

两半修法，缺一不可：

1. **自愈回填**（`backfillNickname` / `backfillAll`，`admin/routes/accounts.js`）：触达上游的路径顺手补一次 `nickname`/`uid`。**三层保护，都因为这是读路径**：幂等（已有昵称不打上游）、**负缓存**（取不到昵称的账号 10 分钟内不重试——桌面凭证失效的账号永远取不到，没有这层每次进仪表盘都要白等一次超时）、**并发去重**（同账号并发只打一次）、**显式超时 8s**（`userInfo` 自身 20s 而前端 axios 30s，几个失效账号叠加就能把整页拖垮）。挂载点：`/dashboard`、`/checkin-all`、`/points-all`——只挂一处的话，「只签到不开仪表盘」的账号昵称永远补不上，`activity.jsonl` 会一直记「账号 N」。
2. **显示名解析**（`displayName` + `toPublic`，`accounts.js`）：优先级 **用户填的名字 > 上游昵称 > 占位名**。关键是识别占位名 `^账号\s*\d+$` 并跳过——**只匹配这一种形态**，用户真想起名叫「账号 1 号机」时不该被覆盖。

**`accounts.js` 的所有访问器必须经过 `toPublic()`**，这是「改了 9 个模块漏了 3 个调用点」的根因所在：早先 `list()` 解析了显示名而 `get()` 没有，同一个账号在两个接口里叫两个名字。收敛到一处后 `list`/`get`/`create`/`update` 必然给出同一个 `name`（原始标签在 `label`）。

**`get()` 现在返回对外形状（cookie 被抹掉），内部改盘一律用 `getRaw()`**——拿 `get()` 的返回值回写会把显示名写进 `name`、把 cookie 抹成 undefined。两者不要混用。

前端直接渲染 `a.name` 即可，**不要再写 `nickname || name` 兜底**——那会把优先级反过来（昵称压过用户填的名字）。

**历史记录（`activity.jsonl`）里的 `account` 是写入当时冻结的字符串**，改昵称前写的行会永远停在占位名。记录本身是既成事实不该改写，但**显示名是账号的属性**——所以 `/records` 读取时按 `account_id` 重解析一次（账号已删除则回落到冻结值）。

注意 TRAE/千问账号是另一套存储（`traework/auth.js`、`qwenwork/auth.js`），它们的 `nickname || uid` 兜底是合法的，不要一起改。离线验证：`node test/verify-display-name.js`。

**桌面凭证不可用时，搭子会自动回落到网页凭证池**（`src/fallback-web.js`）。
回落把网页池包装成伪上游响应交给四个协议处理器复用，所以**能力与桌面链路
一致**——四条协议（含 Codex 只认的 `responses`）与 `count_tokens` 都实测通过
（2026-10-14）。**别再把「网页链路没有 responses」当成回落的局限**：那是
**9084 独立网关**（`web-gateway.js`）的，两者常被混为一谈。
桌面凭证唯一的硬伤是「同一时刻只有一份登录态、过期必须开客户端重登」，
回落正好补上。两边是同一个账号，不会造成额度混用。

**默认就是「不要客户端」（2026-10-22 改）**：`DUMATE_DUMATE_SOURCE` 未设时
凭证来源是 `web`——桌面链路完全不参与，跳过启动那次 `discoverPort`（PowerShell
查询，实测约 3 秒），池子不可用时由路由层（`router.availability`）给出明确原因
而不是笼统的 502。依据是实测而非偏好：客户端卸载后桌面链路必然失败
（`auth.json` 不存在），`auto` 只是让它先探测再撞 ECONNREFUSED 才回落；而
网页链路首字 p50 **826ms**，比桌面链路的 **1570ms** 快近一倍（少了本地 Go 中转
那一跳），长尾差距更大（p90 2819ms vs 12569ms）。桌面链路保留为显式退路：
`DUMATE_DUMATE_SOURCE=auto`（别名 `desktop`）恢复「桌面优先、不可用回落」。
它唯一的独占价值是「凭证明文不进网关进程」，留着是为了网页接口被风控时还有
一条路。无法识别的取值按默认（web）处理并在启动日志告警，**不静默当 auto**。

**一个容易误判的点（2026-10-14 实测）**：客户端没装时，回落路径上**每个请求
并不会跑探测链**。`upstream-router` 给 dumate 的 `defaultPort` 是 8980 且
`portOf()` 保证返回有效数字，所以 `target.port` 恒有值，`forwardWithFallback`
里 `!t.port` 那条分支（会调 `ensureUpstream` → `discoverPort`）**走不到**
（默认 `web` 模式下更早就在来源分支返回了；`auto` 模式下它同样走不到）。
真实路径是 `startForward` → 连一次本地 8980 → ECONNREFUSED（回环，毫秒级）
→ 回调里 `tryWebFallback()`。所以**不需要给探测失败加缓存**——曾经加过一版
静默窗口，打桩 discovery 计数实测（连发 5 个请求，`discoverPort` 一次都没被
调用）证明是死代码，已移除。真正的探测开销只在启动那一次，且只有 `auto` 模式会跑。

回落把网页池包装成**伪上游响应**（EventEmitter + statusCode + headers），
四个协议处理器原样复用——**不要为它重写翻译层**，那三套 SSE 状态机是踩了
十几个坑才稳定的。三个易错点：

- **状态码时序**：处理器拿到上游响应会立刻 `res.writeHead(statusCode)`，
  而网页池的状态码要等云端响应头。所以必须「缓冲 → 等 ready → 交出去 → flush」，
  否则失败时头已按 200 发出，客户端收到空的 200（静默失败）。
- **伪响应没有 `pipe`**：OpenAI 直通分支曾经无条件 `upstreamRes.pipe(res)`，
  回落时抛未捕获的 TypeError **打挂整个进程**（2026-10-14 修，
  `test/verify-fallback-stream-pipe.js` 锁定）。
- **`!t.port` 那条分支默认走不到**（见上），但保留着——它是为「target 没有
  端口」的形态准备的，删掉会让那种情况在调用点先抛错、走不到回落。

触发条件严格限定为「还没交给回调」：后端连不上（fakeResponse）或回 4xx/5xx。
一旦开始写下游就不再换链路（半截响应 + 换链路会让客户端收到两段拼接的内容）。
埋点带 `credential_source`（仅回落时有值）；`/health` 的
`channels.dumate.fallback` 报回落是否可用——桌面 `ready=false` 而
`fallback.available=true` 时请求仍能成功但走的是网页池，排障时必须知道这点。
`DUMATE_WEB_FALLBACK=0` 可关掉。

**千问没有网页凭证这个概念**：它的「两套」是**先后两代**（旧的只读客户端
`auth-v2.dat` → 现在的自持凭证账号池），不是并行两条链路。所以上面那张表里
「网页凭证」只适用于搭子。

**千问不需要「走客户端」，安装目录也不再是必需**（2026-10-14 起）：

1. **签名默认本地算**，不读 wasm（见上文「千问通道的硬约束」第 1 条）。
   只有 `DUMATE_QWENWORK_USE_WASM=1` 才回到官方 wasm 那条路：它运行时从安装目录读
   （`wasm-path.js` 取版本号最大的目录），**不复制进仓库**。
   客户端升级后新 wasm 若签名规则变了，wasm 路径会失效——但实测 1.1.0 与 1.2.0 的
   wasm **完全相同**（同 md5），所以升级客户端本身不影响签名。
2. **machineId**（`credentials.machineId()` 读 `~/.qoderworkcn/.auth/machine_id`）——
   登录时生成，之后每账号固定不变（改了等于换设备）。**装过客户端才有这个值**；
   没装就退回随机 UUID，实测也能登录与推理。注意本机两个账号**共用同一个
   machineId**（都取自客户端那份），这是预期行为，不是 bug。

凭证本身（access/refresh token）走 `login.js` 的 **OAuth device flow + PKCE** 自取，
存在 `data/qwenwork-accounts.json`，**不碰客户端的 `auth-v2.dat`**——所以换账号
不需要开客户端，两个账号也能并存。`credentials.js` 现在只剩 `machineId()` 在用。

**`lastError` 是「最近一次结果」，不是「历史故障」**（2026-10-02 修）。三条不变量：

- **成功即清除**：`send()` 里一次请求成功就清掉该账号的 `lastError`（只在确实
  有值时写盘）。早先只在换票成功时清，于是一次瞬时失败（上游抖动的 403）会
  **永远挂着**——账号页显示的 403 其实几小时前就自愈了，用户被误导成「当前坏了」。
- **带时间戳**：`patch()` 集中给 `lastError` 打 `lastErrorAt`（写入 `lastError`
  时同步写入时刻，清空时置 null）。时间戳逻辑收敛在 `patch()` 一处：所有写
  `lastError` 的调用方（`index.js` 的 `markFailure`、`chat.js` 的换票失败）都走它，
  漏一处就会出现两种形状。
- **无时间戳 = 陈旧**（`web/src/utils/lastError.ts` 的 `lastErrorFresh`）。判据是
  「有 `lastErrorAt` 且未过 30 分钟」才算新鲜。**旧数据（本功能上线前写入的）没有
  时间戳，一律当陈旧**——第一版实现写反了（把「无时间戳」保守当成新鲜），结果
  acc2 那条修复前的旧 403 一直被标红，用户再次报「为什么还显示这个 403」。
  陈旧错误降级为灰色警告（`errorWhen` 显示「较早：」），仍显示错误串供排查。

  **为什么必须「无时间戳 = 陈旧」而不是「新鲜」**：`lastError` 只在**换票成功**或
  **请求成功**时才清——一个**不被使用**的账号（非主账号、主账号一直成功）永远
  拿不到这两次清空机会，一次瞬时失败就永久挂在那里，且永远不会有时间戳。
  把无时间戳当新鲜 = 把这类遗留错误永久标红。**宁可少报，也不要凭空报一个旧故障。**

  两个界面（仪表盘账号卡、账号管理页）共用这个工具，不要各写一份——上一版就是
  因为各写一份且判据写反，才出现「同一账号一处红一处不红」的漂移。旧的无时间戳
  遗留值已一次性清理（2026-10-02）。

**千问上游的 403 是间歇性的**（2026-10-02 实测）：同一账号、同一模型、同一分钟，
直接请求可能成功、`send()` 可能失败，几分钟后自愈。表现为 `Model is not available
for this user`（账号维度，网关会据此换号）。**这不是配置错误、不是额度、不是 token
问题**——遇到就重试。真正需要处理的是 **402**（额度真耗尽）和 **`换票失败`**
（refresh token 失效，要重新登录），这两种才会持续失败。

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

**「播报即收尾」的三通道验证**（都离线、都打桩 `chat.postStream`/`chat.post`）：
`node --test test/unit/repair-gate.test.js`（共享模块：判据、配置、追加修复指令、
标准 OpenAI chunk 缓冲门 11 项）、`node test/verify-qwen-repair.js`（36 项）、
`node test/verify-qoder-repair.js`（36 项）。三者都自带 `DUMATE_POOL_STATE` 临时文件，
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
- `node test/verify-qoder-read-idle.js`——读空闲与「无内容」两个计时器（10 项，见上文）。
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

上游不支持 function calling，工具调用被**降级为纯文本**（`[Tool Use: 名字]`、`[Tool Result]`）——工具降级维持（搭子的 function calling 未实测通过，别顺手放开）；**图像则相反**：2026-10-31 真机实证上游认 OpenAI 标准 `image_url` part（data URI，网页凭证与桌面链路一致、能正确识别图像内容），四个翻译入口全部保真透传，`flattenImageParts` 压回已删除（见下文「搭子的真实模型」节）。

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
internal_error）。工具调用降级维持——搭子的 function calling 未实测，别顺手放开。

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

**`DUMATE2API_KEY` 是死变量。** `src/server.js` 顶部把它读进 `API_KEY`，但代码里从未参与任何校验（可以 grep `API_KEY` 确认只有那一处赋值）。真正的鉴权开关是 `DUMATE_REQUIRE_KEY=1` + `data/keys.json`。（README 已加说明标注它是历史遗留。）

**`model_allowlist` 只在配了白名单时才读请求体。** 网关鉴权段先判断 `key.model_allowlist` 非空才预读 body 取 `model`——否则给默认路径凭空加一次完整读取。结果存 `req._rawBody`，`readBody` 直接复用，**流只能读一次，重复读会拿到空串**。Google 路径的模型名在 URL 里，走正则从路径提取。

**引用代码位置时不要写行号。** 本文件历史上写过 `src/server.js:14` / `:709` 这类行号，改动几次后全部失效——后来者照着行号去看会读到无关代码。写函数名或常量名（`API_KEY`、`model_allowlist`），它们靠 grep 就能定位且不会漂移。

**请求埋点失败必须吞掉。** `reqlog.record` 是同步写 JSONL，出错只报一次然后自禁用——埋点绝不能影响正在转发的响应。`logRequest` 用 `res._logged` 去重，因为流式路径会同时挂 `end`/`error`/`aborted` 三个收尾点。

**`req_id` 是埋点与异步采集的唯一关联键。** `logRequest` 生成（或复用 `req._reqId`），写进埋点；千问的积分归因也带同一个值。归因要等 1.5s 结算，`ts` 必然晚于埋点——靠时间戳配对会让同一秒内的两条请求互相串账。`handleDirectChannel` 在进入时就把 `req_id` 定下来并传给 provider，就是这个原因。请求日志按 `indexByReqId()` 把积分明细附到行上。

**流式请求必须显式要 usage 帧，且注入点必须在 `target.direct` 之后。** 云端网关 `dumate-svc.baidu.com` 只在 body 带 `stream_options: {include_usage: true}` 时才在流尾补一个 `choices: []` + `usage` 的块；8980 桌面后端默认就发。所以漏注入的症状是「请求全部 200、token 全记 0」，且**只在网页凭证链路上暴露**（实测网页凭证 `/v1/responses` 流式 134/134 条 output_tokens 为 0）。四个协议入口（`handleOpenAIChat` / `handleOpenAIResponses` / `handleGoogleGenerateContent` / `handleAnthropicMessages`）都要注入，一个都不能省。位置要求：**必须放在 `if (target.direct) return ...` 之后**——千问/TRAE/Qoder 的 `buildBody` 不认识这个字段，提前注入等于给它塞脏数据。

**`first_token_ms` 由 `reqlog.markFirstToken` 统一实现，四个协议入口都要调。** 它原先私有在 `server.js` 里，只有透传分支和直连通道调得到，三个翻译器（`translateStreamToResponses` / `translateStreamToAnthropic` / `translateStreamToGoogle`）拿不到——于是 `/v1/responses` 与 `/v1/messages` 的流式请求一条首字都记不下来（实测 dumate `/v1/responses` 1295 条全为 null，而直连通道 1987/1987 正常；这是长期缺口，与凭证来源无关）。现在函数归 `reqlog` 导出，三个翻译器在 `upstreamRes.on('data')` 的第一行调用它。**口径是「上游第一个字节到达」，不是「我们写出第一个 SSE 事件」**——后者会把翻译器自己造的事件（如 Responses 的 `response.created`）也算进去，量出来的只是本地耗时。

**千问（直连通道）的 OpenAI 路径要自己补埋点。** 翻译器分支各自在 `done` 回调里记，只有 OpenAI 分支没有翻译器——漏了就一条都不记。补埋点时扫 usage 要注意：`provider.send` 回调给的是解信封后的裸 JSON，拼进 `seen` 时必须补上 `data: ` 前缀，否则 `usageFromSSE`（按 `data:` 行扫描）扫不到，token 恒为 0。

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
指纹；EchoPing07 实现里 userType 是 AES 签进 bearer 的）；TRAE 国际版直连的
活验证（region 管道已铺，utils_chat 国际基址未实测，需国际账号）；ASR 语音
转写（搭子要 BOS AK/SK 证据、千问要 WS 协议逆向）；飞书推送（要 webhook
配置与产品设计）；账号级限额护栏（要存储与界面设计）；remote 端点备选链路
（要 Max 账号）；Qoder intl 活动域 center.qoder.sh（要国际账号）；多时段签到、
per-key 限流（低价值场景）。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `DUMATE2API_PORT` / `DUMATE2API_HOST` | `9080` / `127.0.0.1` | 网关监听 |
| `DUMATE_REQUIRE_KEY` | 未设（关闭） | 设为 `1` 才对模型端点校验 `data/keys.json` |
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
| `DUMATE_QWENWORK_DAILY_CREDITS` | `100` | 千问每日免费额度的**配置兜底下限**（接口不返回上限，只作推断的下界） |
| `DUMATE_QWENWORK_MIN_MAX_TOKENS` | `16384` | 千问输出预算下限（与搭子的 `DUMATE_MIN_MAX_TOKENS` 分开） |
| `DUMATE_QWENWORK_DEFAULT_MAX_TOKENS` | `131072` | 千问**默认**输出预算（客户端未给 `max_tokens` 时；搭子用 `DEFAULT_BUDGET=32768`，但会被 FLOOR 抬到 65536——**下限优先于默认值**）。取上游上限，见上文实测 |
| `DUMATE_QWENWORK_AGENT_DISCIPLINE` | 未设（注入） | 设 `0` 关闭「执行纪律」注入（见上文「千问通道必须给带工具的请求注入执行纪律」） |
| `DUMATE_QWENWORK_CREDIT_CACHE_MS` | `30000` | 千问余额缓存时长，避免每次请求都打站点接口 |
| `DUMATE_QWENWORK_ACCOUNT` | 未设 | 千问指定用哪个账号（填账号 **id**）。优先级：**环境变量 > 账号文件里的 `preferred` 标记 > 池里第一个**。环境变量是临时覆盖（改启动参数不改文件），删号后「第一个」会变，所以只作兜底 |
| `DUMATE_TRAEWORK_AUTOSTART` | `auto` | `auto`=启用 TRAE 通道 / `off`=关闭（与 `DUMATE_QWENWORK_AUTOSTART` 同形） |
| `DUMATE_TRAEWORK_MIN_MAX_TOKENS` | `16384` | TRAE 输出预算下限（三通道各一套，不要互相套用） |
| `DUMATE_TRAEWORK_MODELS_CACHE_MS` | `300000` | TRAE 模型表缓存时长（5 分钟）。模型表只在登录/刷新时变，不必每次打上游 |
| `DUMATE_TRAEWORK_REPAIR_RETRY` | `1` | 「播报即收尾」的重试次数上限。`0` 关闭整个修复（见上文三通道共用的修复段落） |
| `DUMATE_TRAEWORK_HOLD_CAP` | `600` | 正文缓冲门的阈值（字符）。超过就转直发，避免长回答被扣住等判定 |
| `DUMATE_QWENWORK_REPAIR_RETRY` / `DUMATE_QODER_REPAIR_RETRY` | `1` | 同上，千问与 Qoder 各一套（`src/repair.js` 的 `envCaps`）。互不影响 |
| `DUMATE_QWENWORK_HOLD_CAP` / `DUMATE_QODER_HOLD_CAP` | `600` | 同上，千问与 Qoder 各一套 |
| `DUMATE_QODER_FIRST_BYTE_MS` | `60000` | Qoder 上游**首字节**超时（ms），挡「连响应头都不给」的挂起。`0` 关闭 |
| `DUMATE_QODER_CONTENT_MS` | `90000` | Qoder 上游**无内容**超时（ms）：排队时上游先回一个空 ack 帧再沉默，首字节计时器会被它清掉，只有这个计时器兜底。只在**还没转发过真实内容**时计时，有内容即撤销。**90s 的依据是成功请求首字实测 > 6s 占 14.4%、> 30s 占 7.6%、max 63.9s**——旧的 12s/6s 会把大上下文 prefill 当成排队误杀（详见上文）。真排队由 10605 信封在 200~680ms 内识别，不走这个计时器。`0` 关闭 |
| `DUMATE_QODER_QUEUE_PATIENCE_MS` | `6000` | 排队重试的**总预算**（ms）。实测推翻了「按上游时长耐心等」的旧结论：排队是请求级随机，等 30 秒也不保证放行，所以改为快速轮询几轮（信封本身 150~1000ms 就到）仍失败就如实回 429。`0` = 拿到限流立刻回 429 |
| `DUMATE_QODER_QUEUE_STEP_MS` | `1500` | 排队轮询间隔（ms）。过长恰恰是用户感知的「慢」（原 3000ms × 5 轮 = 15 秒纯等待） |
| `DUMATE_QODER_READ_IDLE_MS` | `120000` | Qoder 上游**读空闲**超时（ms），每块数据重置，挡「先响应后沉默」的限流排队（见上文）。**必须大于首字节超时**，否则两计时器抢跑。`0` 关闭 |
| `DUMATE_THROTTLE_MAX_MS` | `600000` | 排队/限流冷却的**上限**（ms，千问与 Qoder 共用）。上游按自己的队列长度给 `waitTime`（实测 7015 秒），照单全收会把账号锁近两小时；封顶后最多等这么久再探一次 |
| `DUMATE_QODER_COSY_VERSION` | `1.1.75` | Qoder 的 cosy 版本（进 payload 与请求头）。默认对齐官方 CLI；上游行为变化时可覆盖回退，不用改代码 |
| `DUMATE_QODER_UA` | `undici` | Qoder 推理请求的 User-Agent（官方 CLI 由 undici 补默认值） |
| `DUMATE_QODER_MACHINE_OS` | 按 Windows/其他取 `x86_64_win32` / `x86_64_linux` | `cosy-machineos` 头的值。`auto` 按当前系统与架构识别，也可直接指定 |
| `DUMATE_QODER_OS_HEADERS` | 未设（发送） | 设 `0` 关闭 `cosy-machineos` / `cosy-machinehostname` 两个身份头（见上文 2026-10-30 段） |
| `DUMATE_QODER_INTL_GATEWAY` | 未设（候选链） | 钉死国际版推理主机（替代 api3→api2→api1 候选链）。上游服务端「选举」导流端点时用它 |
| `DUMATE_QODER_FEFO_DAYS` | `3` | FEFO 选号的临期窗口（天）：账号有 N 天内到期的积分批次时优先接流量。`0` 关闭 |
| `DUMATE_QODER_QUEUE_POLL` | 未设（开启） | 设 `0` 关闭官方排队轮询协议（信封型限流按 `retryAfterSeconds` 睡眠后重发 + queue/status 放行信号），回到纯快速轮询（429 交还客户端） |
| `DUMATE_QODER_QUEUE_POLL_BUDGET_MS` | `60000` | 排队等待的**整次请求**预算（ms，所有账号共享）。耗尽后 throttle 错误按旧路交回（429） |
| `DUMATE_QODER_QUEUE_POLL_INTERVAL_MS` | 按 `retryAfterSeconds`（夹 [5s, 20s]） | 每轮排队等待的睡眠时长。仅供测试注入短间隔，生产别调小——上游明说的等待要尊重 |
| `DUMATE_DUMATE_SOURCE` | 未设（`web`） | 搭子凭证来源。未设 = **只用网页凭证**（桌面链路不参与，跳过启动那次约 3 秒的探测；池子不可用时路由层直接拒绝并说明原因，不静默退回桌面链路）。设 `auto`（别名 `desktop`）= 桌面优先、不可用时回落网页池。**无法识别的值按 `web` 处理并在启动日志告警** |
| `DUMATE_WEB_FALLBACK` | 未设（开启） | 设 `0` 关闭「桌面凭证不可用时回落到网页池」（见上文回落机制）。关闭后桌面凭证失效即请求全失败 |
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
| `DUMATE_DUMATE_CAPS_FILE` | 未设 | 搭子按模型 max_tokens 上限学习表的落盘路径覆盖（测试用） |

## 数据文件（`data/`，已 gitignore）

| 文件 | 内容 |
|---|---|
| `keys.json` | API key，**只存 sha256**，明文仅在创建时返回一次 |
| `model-map.json` | `aliases` / `upstream_models` / `exposed` / `fallback` |
| `admin-users.json` | 管理员口令（scrypt，N=2^18）与 `session_version` |
| `admin.secret` | 会话签名密钥，与用户表分开存 |
| `admin-audit.jsonl` | 管理操作审计 |
| `requests.jsonl` | 网关埋点，超 32MB 轮转一次留 `.1` |
| `web-accounts.json` | 网页账号，**cookie 明文存**（上游要求原样重放，与 keys 的只存哈希是两种策略） |
| `activity.jsonl` | 统一操作记录（签到/任务/抽奖），按时间排序 |
| `task-runs.jsonl` / `task-scheduler.json` | 任务执行历史 / 轮询配置 |
| `auto-checkin.json` | 自动签到配置 |
| `qwenwork-credits.jsonl` | 千问积分归因（每请求一条，带 `req_id` 与请求日志配对） |
| `qwenwork-daypeak.json` | 千问每日额度的观测峰值，用于推断「每日上限」 |
| `qwenwork-accounts.json` | 千问自持凭证账号池（**含 refresh token，等同密码**） |
| `qoder-accounts.json` | Qoder 自持凭证账号池（device flow 换取，含 refresh token） |
| `qoder-grants.jsonl` | Qoder 积分批次账本（**签到领取记录**，用于过期提醒；上游无逐批余额接口） |
| `dumate-caps.json` | 搭子按模型 max_tokens 上限的自学习记录（7 天 TTL，`src/dumate-caps.js`；静态实测表在代码里） |
| `traework-accounts.json` | TRAE 自持凭证账号池（OAuth 换取，含轮换的 refreshToken） |
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
| `accounts.js` | 网页账号存储，cookie **明文存**（必须原样重放）。**网关闭包内**（`web-pool.js` 依赖）。显示名解析 `displayName()` / 对外序列化 `toPublic()` 都在这里，见下文约定 |
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

**千问办公的账与搭子完全不同，界面必须分开显示**：搭子靠上游账单 + 余额游标（`points-cursor.js`），千问是三个积分池（`daily` 免费 / `monthly` 订阅 / `longterm` 充值）按 `req_id` 归因。两边数字**不能相加**。千问的「每日上限」接口不返回，由「观测峰值 + 配置兜底」推断（`credits.js` 的 `dailyUsageFromBalance`），界面要标出 `limitSource` 是 `observed` 还是 `config-lower-bound`。

**千问的每日额度是账号级的，池子卡的余额与分母都必须是全账号合计**（2026-09-30 修）。用户报「两个账号每日额度应该是 200，今天都还没用」——根因是 `/api/admin/qwenwork/credits` 只读**主账号**（`authStore.preferred()`），池子卡显示单个账号的 100；而同一页顶部「积分余额」卡读 `/accounts` 的 `summary.pointsTotal`，**本来就是全账号合计** = 200。同页两个数字口径不同，被读成「少算了一个账号」。

三条不变量，改动时别破坏：

- **分子与分母同口径**。每个账号各有一份每日免费额度（各自 00:00 重置），所以池子卡的余额是合计、分母也必须是合计（`dailyCap = 单账号上限 × 账号数`）。只把分子改成合计会得到「200 / 100」这种读不出来的数。
- **`/credits` 与 `/accounts` 的账号范围必须同源**（都走 `authStore.list()` 全量，不只 `usable`），否则「顶部合计」与「池子合计」还是会差。余额查询失败的账号不计入合计，但必须在 `failedAccounts` 里如实报出——否则部分和被读成全量。
- **两个分母分开给**：`dailyCap`（合计，池子卡用）与 `dailyCapPerAccount`（单账号，账号健康快照每张卡用）。账号快照问的是「这一个号今天还能用多少」，那里**不能**用合计分母。

每个账号的 `limit`/`freeUsed` 仍按**各自**的观测峰值算（峰值文件按账号分桶），再相加；只要有一个账号没校准，`freeUsed` 整体给 `null`——部分求和会低估消耗，比不给数字更容易被误读。聚合值统一 4 位小数（与归因记录口径一致），否则浮点累加会外传 `199.99349999999998` 这种噪声。离线验证：`node test/verify-qwen-daily-aggregate.js`。

**每日额度是「每天 00:00 自动重置」，不需要当天先使用一次**（2026-09-30 实测确认）。重置时刻就是 wallet 的 `valid_to`（`2026-10-01T00:00:00+08:00`）。证据：账号 2 当天**零请求**，前一日收尾 `4.9657`，次日读到满额 `100`——中间没有任何请求。所以「必须先跑一次才刷新」这个说法不成立。

但用户看到的那个「0」是**真实存在**的，成因不是「没刷新」，而是 `/user/wallets` 偶尔返回坏读——它会把**每日免费额度读成 0**（付费池仍准确）。`fetchWallets` 现在有两层纠错：

1. **重试一次**（针对「三池全 0 + `active_wallets` 空」这种最明显的形态）：重试即恢复 → 用重试结果（瞬时抖动，不标任何标记）。
2. **交叉验证**（2026-10-02 加，针对重试也没恢复、以及更隐蔽的形态）：只要 `daily` 读数为 0，就去 gateway 的 `account-context` 取 `quota.remaining`。它是**权威口径**且**恰好等于三池之和**（实测 `100 + (−4.8222) = 95.1778`），所以 `daily = remaining − monthly − longterm` 能还原出真实的每日额度。还原出的 daily > 0.005 就采用并标 `dailyCorrected: true`（经 `correctedAccounts` 汇总到界面，显示「已校正」而非「已用尽」）。

**为什么触发条件从 `allZero` 放宽到「daily 读数为 0」**：账号 2 的坏读形态是「`daily=0` 但 `longterm` 为负」，三池不全是 0，**根本不进 `allZero` 分支**，却同样把每日额度显示成了 0——用户 2026-10-02 报的正是这个（界面显示「每日额度 0.00 积分」，而 `account-context` 报 `remaining=95.1778`）。只看 `allZero` 会漏掉它。

**不能一律把 0 当读失败**：真·额度耗尽时三池确实都是 0，那时显示 0 是**正确的**（历史上 95 条 `daily=0` 全部伴随付费池 >0，即免费扣完转扣付费）。判据是「还原出的 daily > 0.005」——真耗尽时 `remaining` 也≈0，差值不 > 0.005，于是不校正、如实报 0 + `retried`。**不要**改成「读数为 0 就报错」或「读数为 0 就沿用旧值」，前者会掩盖真实耗尽，后者会长期显示过期数字。`account-context` 取不到（网络错/结构变了）时也不校正，回落成「如实报 0 + `retried`」，不编数字。离线验证：`node test/verify-qwen-wallets-zero.js`（含「谎报 0 被校正」「付费池为负时还原」「真耗尽不误判」「account-context 取不到则回落」四类）。

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
