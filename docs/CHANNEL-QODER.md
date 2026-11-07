# Qoder 通道：限流、排队、积分与计费

> 本文件从 `CLAUDE.md` 的「项目定位」章节按主题拆出，内容为原文照搬（未改写）。
> 改通道细节请改这里；`CLAUDE.md` 只保留核心架构与索引。

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

**「领取额」不是「剩余额」，但界面显示的是**推算剩余**（2026-11-01 改口径）**。
上游只告诉我们这批领了多少，不告诉我们还剩多少（千问每包有独立余额、TRAE 每包有
`remain`，都没有这个问题，**不要照搬它们的措辞**）。领取额不随消耗变——一直显示它
就是「都用完了还挂着」的假数字（用户实测被误导：10-02 领的 100 早已用完，界面还挂着
「快过期 100」）。改法：`grants.estimateRemaining(batches, remaining)` 按**先领先扣**
把上游权威总余额（addOnQuota.remaining）从最新批次往回分配（与「30 天作废」产品
设计和 FEFO 消耗顺序一致），得每批推算剩余；`/qoder/credits` 与 `/qoder/grants` 的
`expiringAmount` 由此而来，领取额保留在 `expiringGrantedAmount` / 行内 `amount`
仅作对照。推算是**模拟口径**（上游按总池扣费不按批次扣），每行带
`estimatedRemaining`，推不出（余额查询失败）给 null 不编数；任一账号余额拿不到时
整体回落领取额口径并标 `estimated/expiringEstimated=false`。amount=null 的批次按 0
参与分配（领取额未知，不凭空持有余额）。

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
   **2026-11-01 修：FEFO 自落地起从未生效**——`fefoUidSet` 里读的是
   `g.account_id`，而账本写入的字段是 `accountId`（grants.fromClaim 的驼峰
   命名），`usable.find` 恒失败 → 集合恒空 → 恒返回 null → 流量一直是普通
   轮询，临期批次从未被优先消耗。测试此前只覆盖了池层的 expiring 过滤
   （直接传构造的 Set），没有从账本推导这步——现在 `fefoUidSet` 已导出，
   verify-qoder-throttle.js 的 3f 节用真实形状账本回归（字段名再写错必红）。
   **三家通道的 FEFO（2026-11-01，`src/expiring.js`）**：搭子/TRAE/千问的临期数据
   只能打上游才有，而选号在请求热路径上——所以不现查，改用**落盘快照**
   `data/expiring-snapshot.json`：管理端三处刷新（`/web-accounts`、`/credits`、
   `/accounts`）本就在拉这些数据，顺手 `update(channel, entries)` 落盘；网关三处
   选号（`web-pool.pick`、`qwenwork/index.js` 与 `traework/index.js` 的 `fefoUidSet`）
   只读文件、零上游调用。四条口径：
   - **陈旧退回普通轮询，不报错**：快照缺失/超 TTL（默认 6h）时 `accountIds` 返回
     null，上层不传 expiring——行为退回加这功能之前，可用性不依赖快照。
   - **窗口按通道不同**（`DUMATE_{DUMATE,TRAEWORK,QWENWORK}_FEFO_DAYS`，`0` 关）：
     搭子 30 天（额度包天然落在 25~30 天区间，窗口小了会恒空）、TRAE 7 天（与管理端
     `/credits` 的 `SOON_MS` 同窗）、千问 30 天兜底（上游 `expiring_soon` 本身即信号）。
   - **「查不到」≠「没有临期」**：本轮查询失败的账号走 `update` 的 `keepIds` 保留旧条目，
     且 `at` 不推进（部分旧数据不能让快照冒充新鲜）。写空会在一次网络抖动后把临期
     账号忘干净。
   - **id 形式两族不同**（易错点）：channel-pool 的键位是 `${channel}:${id}`，千问/TRAE
     的 `fefoUidSet` 要经 `uidOf` 转换；搭子 web-pool 直接给 `pool.pick` 数字 id，快照的
     字符串 id 需 `map(Number)`——形式错了 `has` 恒 false，就是 Qoder 字段名 bug 的复刻。
   离线验证：`node --test test/unit/expiring-fefo.test.js`（14 项：写读形状咬合、窗口、
   TTL、通道隔离、keepIds、at 不推进）+ `node test/verify-expiring-fefo.js`（7 项端到端：
   喂真实形状快照调**通道自己的** `fefoUidSet`，uid 前缀/id 形式写错当场红——
   这是 3f 教训的应用：内部推导不导出就等于没测到）。三个管理端响应新增 `fefo` 字段
   （`info()` 的新鲜度），FEFO 没生效要能在管理端看出来而不是静默退化。
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
未返回的整个期间，覆盖排队等待）。**2026-11-06 补：OpenAI 直通分支的头发出
前完全静默**（`!translated && !headersSent` 挡住一切写入）——ACP 首帧 14~35s、
qoder 大上下文 30~70s，静默窗口内保活等于没做。已改为 send 起跑 5s
（`DUMATE_PING_QUIET_MS`）仍无首帧就先发头放开 ping：5s 足够快速错误以 4xx
返回，之后失败走流内错误帧；真机 ACP 流式 10.9s 出 2 条 ping（改前 0 条）。

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

**Qoder 稳定性四件 + Pro 福利包（2026-10-31 落地）**：

1. **请求体 29MB 前置拒绝**（`chat.assertBodySize`，`DUMATE_QODER_MAX_BODY_MB`）。
   阿里云 SLB 对单 POST 有 30MB 硬限，超限直接 RST；不前置拦的话，RST 会被
   当成瞬态网络错误 → 换号重试 → 每次重放几十 MB → 整池熔断。抛 413 +
   `tooLarge`，`retryable(413)=false` 所以不换号。
2. **DeepSeek 族的 `reasoning_content` 回填**（`chat.rememberReasoning` /
   `backfillReasoning`）：该族多轮一致性依赖上一轮思维链，而客户端只回传正文。
   按 session 记「最后一条 assistant 的正文 → reasoning」（LRU 200 条 / 30 分钟），
   下一轮匹配得上才补；只对 DeepSeek 族（`dmodel`/`dfmodel`/`deepseek`），
   客户端自带时不覆盖。
3. **`tool_call.id` 补全**（`chat.backfillToolCallIds`）：上游偶发不带 id 的
   增量帧，按 index 稳定补一个 `call_qd_*`；流式与聚合出口同一口径。
4. **Pro 福利包 + 团队共享额度**：`ProEligibilityEndpoint` / `ProClaimEndpoint`
   （cn/global 各一套，`/sash/api/v1/me/pro-upgrade/{eligibility,claim}`）；
   管理端 `GET /pro-eligibility`、`POST /pro-claim`（**必须 `confirm:true`**，
   一次性不可逆）。`fetchQuota` 现在解析 `orgResourcePackage`（团队号；
   `cap=-1` = 不限量，按 `unlimited` 处理，别当数字比大小）。**实测 CN 账号的
   eligibility 返回 gone=true（端点 404/403/410）**——活动不覆盖当前账号，
   界面据此不显示按钮，不是故障。

离线验证：`node --test test/unit/qoder-stability.test.js`（9 项）。


**前缀缓存亲和（2026-10-31 落地，hub #48：命中率 95% ↔ 8% 的分界线）。**
上游按 (session, 历史) 做前缀缓存。改动前 `buildBody` 实测复现的问题：客户端
（Codex / Claude Code）从不带 `session_id`，只有「播报即收尾」的修复轮才有
`opts.sessionId`——所以**每一轮都拿到新的随机 UUID**，`business.id` 与
`business.begin_at` 同样每轮变。缓存键每轮换，等于每轮从零算 prefill。

四个字段两条规则，**不能一起稳定化也不能一起随机化**：

| 字段 | 规则 | 原因 |
|---|---|---|
| `session_id` | 跨轮稳定：首条 user 消息指纹 → UUIDv5 形状（`stableSessionId`，截断 2048 字符与 `channel-pool.sessionKeyOf` 同锚点） | 追加轮次后不变；显式传入（payload/opts）仍最高优先 |
| `business.id` / `begin_at` | 由 session_id 确定性派生（`deriveUuid`/`deriveEpochMs`，基准点固定 2026-01-01） | 会话级字段，每轮变等于改缓存键 |
| `request_id` | **每轮必须新** | 单次请求标识，复用被上游按签名字节去重判 103（与排队重发同族机制） |

取不到首条 user 消息时回落随机 UUID——没有稳定锚点时不硬凑（凑出来的会在
不同会话间撞 id）。离线验证：`node --test test/unit/qoder-cache-affinity.test.js`
（10 项：跨轮稳定、追加轮不变、跨会话互异、UUID 形状、request_id 必变、
不篡改调用方 payload）。

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
