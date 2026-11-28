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

**倍率差 14 倍，开发调试一律用 0.1 档**：`qfmodel`/`dfmodel`/`gfmodel`/`mmodel`（2026-11-28 真机复核）。
`qmodel` / `q37fmodel` 已于同日确证下线（见下段），兜底快照里仍保留但标 `retiredCandidate`。
实测 5 个 0.1 档请求合计不到 0.01 credits，而 `kmodel_latest`(Kimi-K3) 是 1.4 档。
倍率从模型表接口的 `price_factor` 读，**不硬编码**。

**模型表真机复核（2026-11-28，cn 两账号 + global 两账号）**：cn 14 条 / global 17 条
（global 多 `ultimate`/`efficient`/`smodel`/`cmodel` 四个）。三条结论：

1. **`qmodel` / `q37fmodel` / `gm51model` 确证下线**——四个账号的模型表里都没有。
   按 P0-2 纪律**不删条目**，只把快照里的 `retiredCandidate` 连同真机依据一起落定
   （第三方清单从「声称」升级为「已复核」）。显式调用仍然透传给上游裁决，
   上游若恢复模型可直接复活。
2. **快照原先漏登记 7 个上游真实存在的 key**：`ultimate` / `efficient` / `smodel` /
   `cmodel`（仅 global）/ `gmodel_latest` / `jmodel` / `mmodel`。已补齐。
   `mmodel`（MiniMax-M3.1-Flash，0.1 档）进了便宜档推荐。
3. **`qwen-plus` 别名原指向 `qmodel`——已下线 key**，改指 `qmodel_38max`（0.2 档，
   仍在表里）。这类「别名指到下线模型」不会报错，只会在调用时稳定失败，
   单测 `qoder-model-catalog.test.js` 新增两条把这两个结论钉死。

global 区另有两个高倍率模型：`smodel`（Sonus，8 档）、`cmodel`（Cantus，4 档）；
`ultimate` 是 2 档。国内账号调不到这四个，`listModelEntries` 按 preferred 账号的
region 出表，所以 /v1/models 的可见集合随主账号区域变化。

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

**排队有两种形态，字段能分开（2026-11-28 真机实测）——分开判很重要，因为处置相反。**

| | 真排队 | 伪装成排队的硬拒绝 |
|---|---|---|
| `queueType` | `p4` | `p1` |
| `queueCount` | `≥1`（实测 1） | `0` |
| `serviceAvailable` | `true` | `false` |
| 含义 | 服务在，只是拥堵 | 身份被拒（`identity-guard.js` 记的那类） |
| 处置 | 等着 / 走官方排队轮询，会放行 | **等永远不会放行**，必须中和 system 身份句 |

两者都是 **HTTP 403 + `code 10605` + `subCode RESOURCE_LIMIT` + `isQueued:true`**，
只看错误码分不开——必须解到最内层信封看这四个字段（信封通常嵌三层：
`data:{headers,body}` → `{code,message}` → `{code,message}` → 最内层）。
判别在 `model-locks.js` 的 `queueKindOf()`（返回 `real` / `hard` / `''` 不猜），
锁池视图（`#/qoder-runtime`）据此打「真排队」/「硬拒绝」标签。

这次实测还确认了一件反直觉的事：**四个账号（cn×2 + global×2）、跨 3 个模型同时都是
`p4` 真排队，而额度全部健康**（1574 / 1697 / 299 / 0 credits）——所以 `p4` 不是
额度耗尽导致的降级，是上游此刻的真实负载。判断「是不是额度问题」不该看排队，
要看 `fetchQuota`（注意签名是 `fetchQuota(accessToken, region)`，传 account 对象会 401）。

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

---

## 运行期配置与自动签到（2026-11-08 融合批，P0-1/P0-2/P0-3）

出处：[QODER-GATEWAY-FEATURE-MERGE.md](QODER-GATEWAY-FEATURE-MERGE.md) 的第一批（P0）。
四项一起落地，因为它们互为前提：排程要热配置才敢开、核验要给排程用、面板要能改闸门。

### 1. 运行期配置（P0-3）——修「模块加载时读一次 env 就定死」

`src/qoder/runtime.js`（`data/qoder-runtime.json`，mtime 热读 + 原子写 + filelock）。
此前 `chat.js` 的三个计时器与请求体上限是**模块加载时**读一次 `process.env`，
调阈值必须重启网关——这类「定时器写死」已造成过一次事故（`CONTENT_MS` 取 6s
误杀大上下文 prefill，见本文件前文 90s 修正）。现在 `firstByteMs / contentMs /
readIdleMs / maxBodyMb` 都是**每次现读**（`chat.js` 的同名函数），面板改完下一次
请求就生效。

**纪律四条**（与 `workbuddy/runtime.js`、`trae-runtime.js`、`livecfg.js` 同构）：

1. 原子写（tmp + `renameAtomic`）+ 跨进程 filelock；**先 mkdir 再取锁**——
   全新数据目录下锁文件 `openSync` 会 ENOENT（不是 EEXIST），异常会穿成面板 500。
2. mtime 失效重读，网关与管理端**共用同一份**。
3. 白名单：磁盘宽容（未知键丢弃）/ 接口提交严格（未知键 400）。填错键名静默
   无效是最难查的失败。
4. **env 仍是默认值来源**——只设 env 不碰面板的部署行为逐字节不变；面板写入后
   以面板为准，`DELETE /api/admin/qoder-runtime` 删掉面板文件即回落到 env。

**本文件独有的一条**：文件不存在（mtime 0）时**不缓存**默认快照。默认值来自 env，
而 `test/verify-qoder-read-idle.js` 的手法正是「改 env → 删 require.cache → 重
require」；缓存了默认快照，该脚本的 10 条不变量会当场失真。

字段：`timeouts.*` / `queue.*`（pollEnabled、pollBudgetMs、patienceMs、stepMs、
pollIntervalMs、cooldownMs）/ `limits.*`（throttleMaxMs、fefoDays）/ `repair.*`
（retry、holdCap）/ `concurrency.*`（inflightMax、minIntervalMs、pickStrategy）。

`upstream-errors.js` 的 `THROTTLE_MAX_MS` / `QUEUE_THROTTLE_COOLDOWN_MS` 改成
**getter**（`Object.defineProperty`），所以既有值引用写法（含
`verify-qoder-throttle.js`）不用改，而每次读都拿到当前生效值。

### 2. 自动签到排程（P0-1）

`src/qoder/autocheckin.js`（排程在**管理端进程**，与 workbuddy/autocheckin 同处；
两个进程各排一份会把上游请求翻倍）。

**为什么比 WorkBuddy 的更急**：Qoder 零额度时聊天是**挂起**而不是报错，漏签一天
等于通道不可用。**时点默认 10:15 不是 00:00**：上游活动 `Daily reset: 10:00 (UTC+8)`，
00:00 去签会撞在「昨天已领、今天没开」的格子里。

五条口径（放宽任一条都会变成白打上游或白掉一天积分）：

1. 开关默认关，落盘持久化；打开时**立即跑一轮**（点了就想看到结果）。
2. 时点 + **只后延**的随机抖动（0~10 分钟），整池齐发是机器特征。
3. 签到前**先查状态**（只读 `/campaigns`）：已签跳过、**状态未知不签**（不拿盲签
   去赌——盲签失败污染 `lastError`，也在风控画像上白记一笔）、无可领活动 = `skipped`
   （**有意不重试**，那不是失败）。
4. 失败**当日退避 30 分钟**再试一次，跨日重置（`withinBackoff` 纯函数）。
5. 签成写统一签到账本（`channel='qoder'`），失败如实进 `last_result` 不伪造。

统计口径：`failed` 只数**真失败**（领取失败/换票失败），`unknown` 单列——把
「上游查不到状态」算进 failed 会让它看起来像「签到被打挂了」，而两者该做的事完全不同。

端点：`GET/PUT /api/admin/qoder-runtime/autocheckin`、`POST .../autocheckin/run`
（触发式，结果靠 GET 轮询）。面板：`#/qoder-runtime`（侧栏「Qoder 运行策略」，
只在 Qoder 通道下出现）。

### 3. 签到归属只读核验（P0-2）

`session.verifyClaim` + `grants.classifyVerification`。

**核心情报**（workbuddy2api 面板 2026-11-04 真机实测更正版）：每日 100 Credits
**按账号各发一份**，只有服务端判定「同一个人」时才只发一份（后领的被拒
`SAME_PERSON_ALREADY_CLAIMED`）。设备指纹（伪造全套/完全不带 Cosy-* 头）与
`agentAccountScope` **均不参与判定**。

**为什么必须核验**：账本以 `grantId` 为幂等键，但「领过了」与「真领到了」是两回事
——被判同人的号没有积分进账，账本照记领取额就是假数据，FEFO 推算剩余跟着错
（把两个号都当成有积分，选号派给一个其实没额度的号）。

三态严格区分，**问不出结论就 `unverified`，不猜不假报**：

| 核验返回 | 结论 | 含义 |
|---|---|---|
| `CLAIMED` + grantId 与本号一致 | `claimed` | 真进账 |
| `BLOCKED` + `SAME_PERSON` | `same_person` | 额度进了同一个人的另一个号 |
| grantId 不一致 / 未返回 / 请求失败 / 端点 404 | `unverified` | 未核实（附原因） |

**只读的硬约束**：端点是 `GET /sash/api/v1/me/campaigns/{cid}/reward`，绝不触发领取；
`cid` **只取本账号自己列表里的那个**（拿别人的活动 id 去探账属越界，也会被风控画像
记一笔）。离线断言直接锁这两条（`test/unit/qoder-claim-verify.test.js`）。

核验失败**不改变签到结论**——签到成功仍是成功，只是标未核实；领取环节被拒时
`samePerson` 也透出（与普通 403 区分开）。账本行补 `verification`/`verified`/
`samePerson`/`verifyNote`，老行缺失按 `unverified` 读（**不能默认成 claimed**，
那是假数据）。

### 4. 余额轮转探活（P1-8）

`balance-refresh.js` 的 `collectQoder`：每轮只探**一个**账号（N 个账号 N 轮全覆盖），
写 `channelPool.noteCredits('qoder', ...)`。

**要补的真缺口**：`pool.creditFloor` + `floorBlockedFor()` 早就有，但 Qoder 从来没
往里写过——于是 `DUMATE_POOL_CREDIT_FLOOR` 保底护栏对 Qoder **完全无效**
（`floor_blocked` 恒 false），账号耗到只剩个位数积分仍在接流量，每次请求都是注定
402/挂起的浪费。

有效余额 = `addOnQuota.remaining + userQuota.remaining`（团队共享池 `orgResourcePackage`
**不相加**——它是团队池，口径同 `fetchQuota`）。`credits == null` 一律不写池
（查不到 ≠ 0，写 0 会让保底护栏永久拦住该号）。

### 5. 并发闸门与选号策略（P1-6/P1-7）

`channel-pool` 的 `inflightMaxOf` / `minIntervalMsOf` / `pickStrategyOf` 对 **qoder**
优先读运行期配置，env 只作兜底（别的通道仍是纯 env——不要让这里变成「所有通道都
悄悄改了来源」，那会让既有部署的 env 失效且无从察觉）。

`pickStrategy = 'least-inflight'` 时按「在途少 → 最久未被选」排序，池用
`pickMode:'first'` 取第一个可用项（绕开池判据是不行的：队首可能正被冷却/在途满/
保底拦住）。**粘性优先于 least-inflight**：前缀缓存命中率直接影响实付 token，而在途
均衡只影响排队概率；两者冲突时选前者。

**默认全关（0）**。调研建议 Qoder 默认并发 1，但那是「先埋点观察 10605 率再定阈值」
的结论（`channel-pool` 原注释就写着这句）；升级时静默把吞吐砍四分之三不是该做的事，
要不要收紧是显式决定。

### 6. `/health` 风控遥测（P1-11）

`src/qoder/telemetry.js`：滚动 10 分钟、12 个环形桶，分 `queued`（信封型排队，等多久
都不保证放行）/ `throttled`（调用配额限流，等久了会恢复）/ `rejected`（审核拒绝/模型
不可用，换号无用）三类计数，`/health` 的 `channels.qoder.telemetry` 直接读。

**要回答的问题**：「Qoder 用不了」是通道坏了还是上游让我们等？两者在客户端看起来
完全一样（都要等），处置完全不同（等 vs 换号/重登）。判据**复用 upstream-errors 的
分类**，不另写一套正则（两套必然漂移，「遥测说在排队、实际进了 breaker」比没有遥测
更糟）。计数只用于观测，**绝不参与选号**。

`waitOnly()` 是给探活降级用的保守判据：窗口内全「等」类、无成功、样本 ≥5 才成立；
有 1 条成功就返回 false（通道是通的），`rejected` 存在也不算「只是在等」。

### 验证

全部离线，不需要账号与网络：

```bash
node --test test/unit/qoder-runtime.test.js            # 18 项：热生效/白名单/越界/闸门
node --test test/unit/qoder-autocheckin.test.js        # 17 项：时点/抖动/三态/退避
node --test test/unit/qoder-claim-verify.test.js       # 16 项：三态/只读/GrantId 比对
node --test test/unit/qoder-balance-probe.test.js      # 8 项：轮转/写池/null≠0
node --test test/unit/qoder-pick-strategy.test.js      # 6 项：在途排序/粘性优先
node --test test/unit/qoder-telemetry.test.js          # 11 项：三类计数/环形桶/保守判据
node --test test/unit/qoder-expiry-distribution.test.js # 8 项：按日聚合/日均需耗量
```

`verify-qoder-read-idle.js` 是这批改动的**行为回归锚**：它靠「改 env + 删 require.cache」
驱动三种计时器，10 条不变量全绿才说明「模块加载时读一次」确实改成现读了，且语义没变。

---

## 模型锁池视图与输出上限探测（2026-11-08 融合批，P2-19 / P2-20）

### P2-19 模型锁池视图（`src/qoder/model-locks.js`）

**要回答的问题**：「Qoder 用不了」是整条通道挂了，还是**某个模型**在排队？

限流早就是 (账号, 模型) 粒度（`pool.applyModelSoftCooldown`——实测同一分钟一个
账号的 `dfmodel` 排 4697 位、另一个账号的 `qfmodel` 直接 200），但**这个状态此前
没有任何可视化面**：用户只知道「配了 dfmodel 用不了」，不知道「换 qfmodel 立刻
可用」。这正是「Qoder 用不了、网页版正常」那类误诊的根源。

端点 `GET /api/admin/qoder/model-locks`（本地快照，不打上游）。五条口径：

1. **按 uid 前缀过滤**（`qoder:`）——池是所有通道共用的，不过滤会混进别的通道的锁
2. `earliestInMs` 与 `allClearInMs` **分开给**：前者是「有一个号能用了」，后者才是
   「这个模型彻底恢复」。只给前者会让人以为马上就通了
3. **无锁定是正常态**：空数组 + `cleared=true`，不造一行「全部正常」的假数据
4. `available` = 已登记总数 − 被锁账号数（同一账号锁多个模型只算一次）
5. `kind` 只做粗分（queue / quota / model / other），**不给处置建议**——
   判错的代价是让人白等或白换模型，两个都不轻

### P2-20 输出上限主动探测（`src/qoder/output-probe.js`）

与 `max-output.js` 的分工（互补，别合并）：

| | 触发时机 | 代价 |
|---|---|---|
| `max-output.js`（被动） | 撞到 400 `Range of max_tokens should be [1, N]` 才学 | **第一次必然先撞一次，用户那一轮是失败的** |
| `output-probe.js`（主动） | 显式运维动作，提前测 | 烧额度（单档 3~4 分钟） |

**真机实测推翻了两条原本的设计（2026-11-08，`qfmodel` / `max_tokens=4096`）**：

1. **上游根本不看 `max_tokens`**：传 4096，回来 `completion_tokens=24706`
   （第二次复测 23363），其中 reasoning 23513、`finish_reason=stop`。所以
   workbuddy 那套「`finish=length` 且明显不足 → clamped」在 Qoder 上**永远测不出
   东西**——判据改为按 Qoder 的真实形态：`completion > requested × 1.05` 即判
   **`unbounded`（没有可测的上限）**，这本身就是结论。
2. **同步 HTTP 必然超时**：单档 214~256 秒，四档串行十几分钟。所以编排改成
   **触发式**（与 `/autocheckin/run` 同款）：`POST /output-probe` 立刻返回
   `started`，进度靠 `GET /output-probe/status` 轮询。**同一时刻只允许一个**
   （重额度动作，并发跑等于把「最省的 0.1 档」变成四倍消耗）。

判据（`judgeStep`，纯函数）：

| 形态 | 判定 |
|---|---|
| `completion > requested × 1.05` | `exceeded` → verdict `unbounded`（**第一档即停**，再探只白烧几分钟） |
| `finish=length` 且 ≥90% 请求值 | `at_least`（真实上限 ≥ 该档，升阶继续） |
| `finish=length` 且明显不足 | `clamped`（撞了别的顶；此形态真机还没出现，保留以防上游行为变化） |
| `finish=stop` 且 ≤ 请求值 | `below`（模型自己收尾，没撞顶） |
| 无 usage / 未知 finish | `inconclusive`（如实记，不猜） |

**上游 400 的显式范围声明是最权威真值**：命中 `Range of max_tokens should be
[1, N]` 即判 `clamped`、记 `steps[].verdict='declared'`，并顺手
`max-output.learn(region, model, N)`——之后出站自动 clamp，不再踩第二次。

结果落 `data/qoder-output-probes.json`（30 天视为陈旧）。标注口径：

| verdict | 标注 |
|---|---|
| `unbounded` | `23K ۞ 不受 max_tokens（传 4K）`——**要给证据**，否则读者会当成测错了 |
| `clamped` | `32K ⚠ 钳制 4×`（声称 ÷ 实测） |
| `at_least` | `64K ✓` |
| `inconclusive` | `?` |
| **无记录** | **不标注**——没测过 ≠ 没钳制 |

`fmtK` 按 **1024** 换算（32768 → 32K），与上下游文档的读法一致；按 1000 会写成
33K/66K，反而增加认知成本。

**这条结论对上游使用的实际影响**：Qoder 的输出长度**无法靠 `max_tokens` 钳制**，
要控长度只能用提示词。网关层不再为「Qoder 输出太长」做任何 clamp 尝试。

### 验证

```bash
node --test test/unit/qoder-model-locks.test.js     # 11 项：前缀过滤/双时刻/空态/排序
node --test test/unit/qoder-output-probe.test.js    # 15 项：判据/第一档即停/触发式编排/标注
node test/verify-qoder-model-locks-api.js           # 7 项：HTTP 层（真实池单例）
```

真机留痕：`qfmodel|cn` → `verdict=unbounded, requested=4096, completion=23363,
elapsed=256s, steps=1`。

---

## 协议杂项批（2026-11-08，P2-24 择项落地）

调研清单的 P2-24 是一包「小而独立」的杂项。逐项核对后**只做了两项、写清三项
不做的依据**——因为其中几项与本项目已有的实测定案冲突，照抄会破坏现状。

### 做了：重复 `/v1` 前缀的带提示 404

这是接入第一高频错误：base URL 已含 `/v1`，客户端又拼一次 → 打到
`/v1/v1/chat/completions`。用户看到「网关 404」会去怀疑网关坏了/模型不存在，
真因却是 base URL 重了一段。

判据 `^/v1(/v1)+(/.*)?$`，命中回 404 + `code: 'duplicated_v1_prefix'` +
`hint: {received, expected}`，并打一条 WARN（这类错误靠用户自报很难定位）。
**不静默重写**——重写等于替用户猜意图，而他明明配错了。

真机对照：`/v1/v1/chat/completions` → 404 + 两种改法；`/v1/chat/completions`
→ 200 且模型链路完好（`GLM-5.3-Flash` 正常回话）。`/v1beta/...`、`/v2/v1/...`
不误伤。离线断言 `test/unit/duplicated-v1-hint.test.js`（4 项，**从源码抠正则**
锁语义，防「提示还在、判据被改窄」）。

### 做了：VL 前置校验（`src/qoder/vl-guard.js`）

判据：模型表 `is_vl=false` 且有 `image_url` part → 本地 400，省掉一次注定失败的
上游调用与几十 MB 图片传输。

**但 2026-11-08 真机实测：本通道目前不会触发拦截**。Qoder 模型表里**全部 12 个
模型的 `is_vl` 都是 true**（auto / fast / qmodel_38max / qfmodel / dmodel /
dfmodel / gmodel / gfmodel / kmodel_latest / kmodel / jmodel / mmodel），且实测给
`gfmodel` 传 1x1 PNG 上游**正常接受**——它只在 reasoning 里用 `<image>` 元描述
替代真实图像内容（上游自己的降级行为，不是拒绝）。

保留这份校验的三个理由：`is_vl` 是上游下发字段、随时可能收紧（那时自动生效）；
判据放行优先（表不可用/模型不在表里一律放行），现在留着不误伤；「实测无拦截」
这件事必须写下来，否则后人会以为忘了接线。

不惩罚账号：`visionBlocked` 在 `poolInfoOf` 里走 400 + 不惩罚——拒绝的是「模型
不支持」，与账号健康无关（否则一次误配能把整池打冷）。离线断言
`test/unit/qoder-vl-guard.test.js`（10 项，含一条**真机现状自证**：全 true 时
不拦、翻一个 false 就拦）。

### 不做：`code 115` 入额度码表（与既有实测冲突）

调研（出处 D3-vin）建议把 115 补进 `quotaKindOfText` 并按 112 处置（换号）。
**本项目已有相反定案**：115 属「无语义渲染码」，处置是**400 + 不换号**
（`OPAQUE_SUB400`，见 `index.js` 的码表注释），理由是官方对渲染类错误码是
「弹错误不重试」，而 hub 的 i18n 里没有 115 的含义。D3-vin 的依据强度低于本项目
的实测，照抄会把「确定性渲染错误」变成「换号白试三次」。已由
`verify-qoder-error-surface.js` 锁定（115 必须 reject、不换号、statusCode 压回 400）。

### 不做：Anthropic 桥 system 原位改 user

调研建议 `messages` 里的 system 原位改 user 以保住前缀缓存命中率。**本项目已从
另一个方向解决了同一问题**：Qoder 的前缀缓存靠 `channel-pool.sessionKeyOf` 的
会话亲和 + `chat.buildBody` 的 business 派生（缓存亲和单测在
`test/unit/qoder-cache-affinity.test.js`），不需要改动消息角色。改角色会触及
上游对 system 位置的硬约束（`repair.js` 头注释记载「system 留在 messages 里是
上游的硬约束」），风险大于收益。

### 不做：`/v1/usage` 客户端自查端点（已存在）

`handleKeyUsage`（`GET /v1/usage`）早在 M3 就落地了，按请求日志聚合 key 自身的
用量（today / 7d / 30d，`quota` 如实 null）。与通道无关，Qoder 的请求自动在内。
无需改动。

### 验证

```bash
node --test test/unit/duplicated-v1-hint.test.js   # 4 项：判据/不误伤/不静默重写
node --test test/unit/qoder-vl-guard.test.js       # 10 项：放行优先/文案/不惩罚/现状自证
```

真机对照（9082，Qoder key）：
- `/v1/v1/chat/completions` → **404** + `duplicated_v1_prefix` + 两种改法
- `/v1/chat/completions` → **200**，`model: GLM-5.3-Flash`，credits 0.301
- `qoder/gfmodel` + 1x1 PNG → **200**（上游接受图片，模型表 12/12 `is_vl=true`）

---

## 订阅周期感知的统计口径（2026-11-08，P1-10）

`src/qoder/period.js`：把「本周期扣了多少」这个问题做出来——本地账本原本是
**无界累计**，跨过重置点后总量继续变大，而套餐额度其实已经刷新。

### 四条边界治理规则（照抄 EchoPing07，每条都有具体故障对应）

1. **边界以 `nextResetAt` 为权威**、`expiresAt` 兜底（秒/毫秒/ISO 三种形态都认）；
   **≥ 2100-01-01 是哨兵值必须过滤**——无期限套餐填 `9999-12-31`，采纳会让
   「本周期」永不到期。
2. **首次拿到边界保留已累计值**（periodStart 按边界 − 31 天回推；只有回推值
   落到未来时才夹到 now——那是「边界远于 31 天」的形态，宁可少算也不要凭空
   造一个未来的起点）。
3. **边界未推进/后退 → ignore**（上游接口有缓存，会报旧值）；**前进 < 7 天 →
   同周期**（只更新边界不清零）；**≥ 7 天 → 真实续期**（periodStart 顺延）。
4. **均值分母是 `billed_requests`**（仅 billable 帧），不是请求总数——总数含
   失败/免费帧/断流无 usage 帧，会低估均价。

**接线点**：`/qoder/credits` 在每次 `fetchQuota` 后顺手 `period.observe()`（失败
不改状态——宁可这次不更新，也不因为一次网络抖动把周期清零）；summary 里新增
`period` 段（`bounded / cost / billedRequests / avgPerBilledRequest / perAccount`）。
多账号各是各的周期，「本周期扣费合计」= 各账号本周期之和；**任一账号没有周期
信息时整体标 `bounded=false`**——把全量算成本周期是假数据。

### 真机实测（2026-11-08）：Free 账号不存在「订阅周期」

- `quota/usage` 响应里**没有任何周期字段**（nextReset/resetAt/periodEnd/
  expiresAt/cycle 全 none）
- `/api/v2/user/plan` 的 `end_date=0`（无期限）

所以 Free 号的 `bounded=false` 是**正确结论而不是缺口**——积分明细页显示
「本周期扣费 7,717.1311（计费 1042 次，均价 7.4061/次）· 部分账号未观察到周期
边界，此为全量累计口径」。等真出现付费账号（`is_paid_plan=true`）再验一次
边界是否出现；**在 Free 号上反复找周期字段是无效劳动**。

### 验证

```bash
node --test test/unit/qoder-period.test.js   # 10 项：哨兵过滤/四条治理规则/null≠0/均值口径
```

---

## 用量分析页（2026-11-08，P2-17）

端点 `GET /api/admin/qoder/usage?days=N&region=`：reqlog（channel=qoder）⨝
credits 账本（按 `req_id`）。调研原文「数据源现成，纯前端聚合 + 一个聚合端点」
——通用维度（按天/按模型/按 Key/指标卡）已在 `/usage/overview`，这里补
**Qoder 特有的三块**：

1. **按账号归因**——多账号下「哪个号烧了多少」是 FEFO/护栏调参的依据。
   埋点上线前的老行（无 `account_id`）如实归「(未标注)」，**不按模型表猜归属**。
2. **积分 / 1M Token 折算**——上游直给单请求 credits，与 reqlog 的 tokens
   相除得每百万 token 的真实成本密度（比倍率标称值可信：错峰折扣、缓存命中
   都已体现在实测值里）。
3. **本周期消耗卡**（P1-10 口径）——`period.perAccount` + 合计；
   `bounded=false` 时界面如实标「部分账号未观察到周期边界，此为全量累计口径」。

口径三条：

- 只统计 status 200~399 的成功请求进 token/延迟/速率均值——失败请求单独给
  `failed` 计数，混进均值会把「失败了三次」读成「跑得慢」。
- credits 缺失（上游没给 usage.credits）的行**不补 0**；折算比率只将有值的
  行为分母（`credited` 字段）。
- 吐字速率 = `output_tokens ÷ (ms/1000)`，只对非零 output 与非零 ms 计算。

真机首批（近 30 天，9083 实测）：1183 成功请求 / 172 失败 / 39.4M tokens /
credits 6,954.38 / 密度 **176.62 积分每百万 token** / 吐字 33.4 tok/s /
首字 8.7s。前端在积分明细页 Qoder 区新增「用量分析」卡（六指标块 + 按账号 +
按模型 Top 8 两张表），`fetch` 失败不挡本页其它卡。

---

## 管理端安全加固包（2026-11-08，P2-21 收尾）

调研清单逐项核对后发现**大部分早已落地**（分批来自此前的审计与融合），本批
只补最后一块——**安全响应头**——并加一套接线自证单测防回退。

### 清单核对结果

| 项 | 状态 |
|---|---|
| 登录失败指数退避 + IP 窗口限流（429 + Retry-After） | ✅ 已有（audit P1-5：`loginThrottled` / `loginBlocked` / `recordFail`） |
| API Key 与密码恒定时间比较 | ✅ 已有（`verifyPwd` 与 session 校验都用 `crypto.timingSafeEqual`） |
| Cookie HttpOnly + SameSite=Lax（Secure 可控） | ✅ 已有（`DUMATE_ADMIN_SECURE_COOKIE` 只在 https 下置位——127.0.0.1 明文 http 下加了会被浏览器丢弃） |
| 管理 API 请求体上限 | ✅ 已有（body-limit.js：先回 413 再限时排空） |
| 静态服务路径穿越防护 | ✅ 已有（`target.startsWith(DIST + path.sep)` 判定，越界回落 index.html） |
| 前端 XSS | ✅ 干净（全库无 `v-html`——Vue 默认 textContent 渲染） |
| CORS fail-closed | ✅ 已有（cors.js，P0-1；默认不发 ACAO——这也覆盖了 P2-22） |
| **安全响应头** | ✅ **本批补齐** |

### 本批新增：安全响应头

- **HTML**（`sendFile` 的 `.html` 分支）带完整 CSP：
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; connect-src 'self'; font-src 'self' data:;
  frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`
- **JSON API**（`sendJSON`）与静态资源带最小集：
  `X-Content-Type-Options: nosniff` + `X-Frame-Options: DENY` +
  `Referrer-Policy: no-referrer`

**CSP 的取舍**（实测调出来的，别盲目收紧）：`style-src` 必须放开
`unsafe-inline`——Vue 的 `:style` 绑定与 ECharts 的内联样式都是 style **属性**
（由 `style-src-attr` 继承），不放开整页裸奔；`img-src` 要带 `data:`（antd 内嵌
svg 图标）；`script-src 'self'` 够用（Vite chunk 全是同源文件，无内联 script）。
真机回归：15 个菜单、2 个 ECharts 画布、51 个样式表、0 破图——CSP 未误伤。

**接线自证单测**（`test/unit/admin-security-headers.test.js`，9 项）：除锁本批
的头之外，还把清单其余各项的存在性一并锁住——防后人把它们当冗余删掉
（「登录退避是防爆破的唯一防线」这类依赖是隐性的）。

至此管理端公网化前置清单**全部就绪**：公网化只剩改监听地址一件事。

## 凭证退场标记（2026-11-28，四通道统一口径）

Qoder 的 `session.ensureAccount` 换票失败时原本只有「抛 401 + 换号」，没有
「这份凭证已经废了」的记忆：同一个死号每次被池选中都白撞一次换票端点。

现在与 TRAE / WorkBuddy / 千问共用一套口径（判据各有形状，纪律相同）：

| 环节 | Qoder 的实现 |
|---|---|
| 判据 | `exchange()` 的 `expired: true`——比字符串可靠，上游明确判死才带 |
| 写标记 | `session.ensureAccount` 失败分支写 `refreshRetiredAt` + `lastError='凭证失效（需重新登录）…'` |
| 生效 | `auth.needsRefresh` 见标记返回 false，不再反复打换票端点 |
| 判废 | **`channel-pool` 的 `credentialDead()`**（四通道共用）：标记 + access 已过期 → 不进候选 |
| 清除 | 刷新成功分支 + `auth.upsert` 带新 refreshToken 时 |

**判废为什么上移到池层**：四个通道的选号循环各异，而「标记 + access 已过期」
是**与通道无关**的凭证事实。TRAE 与 WorkBuddy 曾各自实现过一次，Qoder/千问
再抄就是第三、第四份——必然漂移。现在 `pickCandidate` 入口统一过滤。

**语义边界（别改）**：`refreshRetiredAt` 只表示「换不了票」，**不是**「号不能
用」——access 未过期时照样能跑（TRAE 实测 `expiresIn=0d` 仍成功出网一次），
所以 `findUsable` 与 `pickCandidate` 都只在**双条件**下判废；没有 `expiresAt`
的账号不敢判死（无法证明 access 已失效）。

离线验证：`test/unit/credential-retired.test.js`（8 项：池层三条边界 + 四通道判据）。

## 活动模型补充：HungerG（2026-11-29，issue #9；hub v1.10.1 同款设计）

官方限时活动模型**不在动态模型清单里**（12 个数组都没有 `hunger` 字样——4 个
账号 cn/global 原始响应逐字节搜过），只进官方应用/IDE 的选择器，但上游可直接按
key 调用。hub 对 QoDuck 验证过同款链路（v1.9.2「discover QoDuck app-only
model」，key `lmodel` 仅出现在 `app` 数组）。

**key 是 `hmodel`，不是 "HungerG"**（这是本仓库比 hub 静态表更进一步的证据）：

- 官方 0.5.21 应用（2026-11-27 构建，fast-update 包 360MB）内置文案表
  `out/qoder-text/global-prod/bundle.json`：`modelPresentations.models.hmodel.label
  = "HungerG"`（detail 就是五个 🔥）。
- 同表 `lmodel = QoDuck`，与 hub 真机验证过的 API key 一致——**presentation 键
  就是 API key**。hub 把显示名当 key（它自己的活动日志只见过 10605 排队，无成功
  调用记录）；两个拼写都注册成别名，出站统一 `hmodel`，上游裁决。

**免费窗口**：2026-11-23 24:00 ~ 11-30 24:00（UTC+8，官方活动页
docs.qoder.com/zh/events/hungerg-free）。国际版个人账号（Free~Ultra）免费、不消耗
Credits（Max 思考档也按 0.0× 计费）；Team/Enterprise 不显示。每账号有每日公平
使用上限。四个思考档 low/medium/high/max；多模态；上下文 1M（默认档 200K）。

**实现**（`catalog.js` 的「活动模型补充」节 + 三处接线）：

| 环节 | 做法 |
|---|---|
| 条目来源 | `catalog.js` 的 `SUPPLEMENTS` 静态表（形状与 fetchModels 归一化行同形） |
| /v1/models | `mergeSupplementEntries` 追加到三个出口（upstream / 兜底 / snapshot）——`qoder/HungerG`，`catalogSource: 'supplement'`；**动态表已列不覆盖**（官方哪天放进清单以官方为准），**过期自动隐藏** |
| 别名 | `constants.MODEL_ALIASES`：`HungerG`/`hungerg`/`hungerg-free`/`hungerg_free` → `hmodel`（静态表先行，运行时别名不抢） |
| runOnce meta | `modelMeta` 缺席时回落 `supplementMetaOf`——思考档位归一化与 1M 档位不丢失 |
| 区域提示 | `send()`：key 未绑区域时按 `supplementRegionOf` 提示区选号（HungerG → intl）；**key 显式绑定的区域优先**，绑 cn 的调用照常放行由上游裁决 |
| 过期语义 | `HUNGERG_FREE_UNTIL_MS = 1796054400000`（2026-11-30 24:00 UTC+8，hub 同值）；过期只是**不自动列出**，显式调用照常透传 |

**倍率纪律**：活动期 `rate: 0`（官方口径）；窗口结束后的倍率官方未公布——
`rateOriginal: null` 不编。快照（`qoder-catalog.snapshot.json`）**不收** hmodel：
快照是「第三方清单疑似下线」的领地，活动模型走补充表，两套语义不混。

**验证状态（如实）**：2026-11-29 真机探测时四个账号**全部模型**（含 0.1 档
qfmodel 与乱写的 no-such-model-xyz）统一回 p4 排队（queueCount=1 / retryAfter 60s /
serviceAvailable=true，账号级 RESOURCE_LIMIT）——免费窗口高峰的账号级排队，
**在模型校验之前**，所以 p4 信封不能证明也不能证伪 `hmodel` 的有效性；对照实验
（hub 文档）表明无效 key 在放行后会得到明确的 `Cannot find model`。**600s 长预算
探针（两个国际账号轮转）同样全程未放行**（2026-11-29 午后）——端到端验证待队列
缓解（错峰时段 22:00-08:00 是自然的重试窗口；免费窗口内探测 0 成本）：

```bash
DUMATE_QODER_QUEUE_POLL_BUDGET_MS=600000 node -e "
const qoder = require('./src/qoder');
qoder.send({ model: 'qoder/HungerG',
  messages: [{ role: 'user', content: 'reply with exactly: pong' }], max_tokens: 64 },
  null, { reqId: 'hunger_e2e', probe: true }).then(
  (o) => console.log('OK', JSON.stringify(o).slice(0, 400)),
  (e) => console.log('ERR', e.message));"
```

离线验证：`node --test test/unit/qoder-hungerg.test.js`（8 项：key 收敛 / 行形状 /
思考档位 / 过期纪律 / 动态表优先 / 区域提示 / 接线自证）；
`qoder-model-catalog` 与 `qoder-model-metadata` 的名单断言已改为
supplement-aware（锁「启用者在、禁用者不在」，不再锁字面名单——窗口结束后照样成立）。
