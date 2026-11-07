# TRAE Work 通道：协议、账单与链路

> 本文件从 `CLAUDE.md` 的「项目定位」章节按主题拆出，内容为原文照搬（未改写）。
> 改通道细节请改这里；`CLAUDE.md` 只保留核心架构与索引。

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

**TRAE 逐轮账单：三条链路全部可查（2026-11-06 解决，推翻 10-31 定案）。**
`POST /api/v1/commercial/get_session_usage` body `{session_id: <turn id>}` 按**请求体里
主动写的 session_id** 记账——10-31 定案「`llm_utils_chat` 给不出入参 id」的根因是当时
查的是**流 metadata 里上游自分配的 id**（那个不进账单键，所以全零骨架）；正确做法是
`buildBody` 主动写 `session_id`（ObjectId 形状，`chat.oidSessionId()`）。三条链路实测：

- **utils_chat**（solo_work_lite / persona 统一）：`meta.sessionId` 查回真实 credits
  （实测 0.07，input/output 与流内 usage 精确一致）；修复轮复用同一 body → 同一
  账单键（同一次 send 的重试序列合并计费，如实记录）。
- **Remote**（remote.js）：账单键是创建会话返回的 `message_id`（实测 0.13）。
- **SOLO raw**（solo.js）：`conversation_id`/`session_id` 同样按请求体记账（实测 0.13）。

逐轮精确积分管线（`credits.capture` 的 `turnId` 入参）：落行带 `turn_id` → 异步查
账单（3 次 1.5s/3s 退避，`DUMATE_TRAEWORK_SESSION_BILLING=0` 关）→ 追加
`session_usage` 补充行（含 `cache_read/cache_write/input_tokens/output_tokens`——
**SSE 的缓存 0 不能证明未命中**，真机实测 SSE 两轮全 0、账单 `cache_read_token=25344`）。
`computeCosts` 合并：精确值覆盖差值、补充行不进 rows、并发标注只豁免精确行自己。
`attachCosts`/`creditRecords` 带 `source`（`session_usage`/`consumed_delta`）。
`billing-check` 探针的 turn id 优先级：`chat.turnIdOf`（流内 reply_to_message_id/
user_message_id）→ `meta.sessionId` 兜底（10-31「不拿 session_id 兜底」的旧口径只
适用于上游自分配 id，主动写的账单键正是要兜的）。副产品：账号**首条请求**（无差值
参照点）现在也有成本了。离线验证：`node --test test/unit/trae-billing-usage.test.js`
（20 项：精确覆盖差值、并发豁免边界、null 忽略、attachCosts 口径、parseBillCache）。

**额度包要按官方收银台口径过滤，签到两份额度不能相加（2026-10-31）**。
`parsePacks` 剔除 `product_type=3`（促销）/ `is_hide` / `status=3` 三类包——
不剔的话「剩余额」被不可用的包抬高，界面数字是假的；`credits_limit = -1`
表示**不限量**，解析成 `unlimited`，按普通数字算会得到「剩余 0」（读成用完）。
`status()` 增加 `claimable = max(credits, extra_credits)`：这两项是二选一，
**不是两笔相加**（「credits=100 + extra=100 显示 200、实到 100」）。
离线验证：`node --test test/unit/trae-billing-usage.test.js`（13 项）。

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

**TRAE 宝已接入（2026-11-03，`traebao/` 前缀，不是第五个通道）。**
「TRAE 宝」是官方 2026-10-20（v3.4.5）上线的开发者个人助理（桌面悬浮球），
官方 11 月活动**用它问答/下达任务全部不消耗积分**。接入方式对齐 `qianfan/`
模式：`traebao/auto` 与 `traebao/deepseek-v4.1-flash` 路由到 **traework 通道**
（同账号池、同 Cloud-IDE-JWT 凭证、同后端网关），只换对话身份
`function=personal_assistant`（TRAE 宝）。四条实测定案：

1. **~~免费豁免~~已失效（2026-11-04 复核实测）**：11-03 的对照实验里
   `personal_assistant` 消耗 0 credits、`solo_agent_lite` 0.05；**11-04 大输出
   决定性测量：traebao 1022 输出 tokens 扣 0.17（每千 token ≈0.157，与 solo
   同量级）——豁免已结束**（小请求 Δ 0/0.01 交替是被两位小数量化淹没的噪声，
   判豁免必须用大输出）。`traework-credits.jsonl` 照记；界面「（免费）」文案
   已撤（测试台模型名、模型页标签）。traebao 仍可用，只是正常计费。
2. **明文链路，不碰 agent/v3 加密**。TRAE 客户端对 agent/v3 的
   create_agent_task 等走 aha 桥接 AES-GCM 加密（请求密文、响应明文 SSE），
   但 `llm_utils_chat` 明文即可——body 必带 `app_id`（UUID）与
   `app_version_code`（数字），缺哪个服务端按序报
   `expr_path=<字段> missing required parameter`；带了
   `x-bridge-transport: aha` 头反而触发服务端解密路径（`base64 decode failed`）。
3. **模型白名单只有一个**：2026-11-03 对 20 个 remote 模型逐个实测，
   persona 身份下只有 `deepseek-v4.1-flash` 可通（其余全部上游 4001），
   与抓包一致（TRAE 宝的 model_config 事件就是 `deepseek-v4.1-flash__dev`）。
   白名单前置校验在 send()（`traebao/` + 其它模型 → 400 明确报错），
   `/v1/models` 只透 `traebao/auto` + `traebao/deepseek-v4.1-flash` 两条。
4. **上下文窗口实测 1M，auto 与显式模型一致**（2026-11-03，逐级加压）：
   1,021,270 token 通过（auto 与显式各验一次）、~1,080,000 token 拒
   **4026** `context length has exceeded the maximum limit`（确定性请求
   错误，已在 traeCodeKind 不惩罚清单）。边界区间 [1.02M, 1.08M] 与模型表
   标称 1,048,576 吻合。**抓包 model_config 的 `prompt_max_tokens:168000`
   不是输入硬限**——那只是自动档的会话预算参数（服务端内部处理/压缩
   预算），别把它当窗口配给客户端；cc-switch 按 1M 配
   （`model_context_window: 1000000` + `model_auto_compact_token_limit: 900000`）。
5. **身份标记经 opts 传**：网关侧 `reqBody.model = route.model` 把前缀剥掉，
   send() 靠 payload.model 认不出身份——`handleDirectChannel` 把
   `route.personalAssistant` 放进 providerOpts；模块直调（不带网关）则靠
   payload.model 前缀识别。两条来源都接。

**逐轮账单的会话键是主动生成的 session_id**（ObjectId 形状）：persona 的
buildBody 生成并记录到 `meta.sessionId`，上游按它记账，
`get_session_usage` 查它返回真实 credits（**与 solo_work_lite 不同**——
那条链路不传 session_id，上游自分配的查出来是全零骨架，见
`chat.turnIdOf` 注释）。例外：**OAuth 自取账号打 commercial 域 401**（code
1001，token 签发体系不被 commercial 域认）——计费自检探针 best-effort
退回 consumed 差值口径，不阻塞主链路；客户端解密账号（bluechonk
byteCrypto → storage.json）则精确口径可用。离线验证：
`node --test test/unit/router-traebao.test.js`（4 项）；真机：四入口冒烟
（OpenAI/Anthropic/流式/白名单 400）全过。

**TRAE 国际版已接入（2026-11-03，全链路真机验证过，区域术语 `cn`/`intl`）。**
账号管理登录弹窗选「国际 trae.ai」→ `www.trae.ai/authorization`（同一套
client_id 与参数集，真机确认接受）→ 回调粘回。真机实测推翻/补齐了 hub
的几个结论：

1. **换票主机按账号落点给，回调里自带**：国际版回调 URL 带
   `host=https://api-sg-central.trae.ai`（新加坡落点）与 `userRegion=sg`——
   **解析回调的 `host` 参数优先于一切预置候选**（hub 的 grow-normal.trae.ai
   是美区实测值，SG 落点账号不认；候选链只作没有 host 时的回落）。
   `login.parseCallback` 取 host、`exchangeAndSave` 存进账号 `apiHost`，
   之后换票/用户信息/CheckLogin/usage/payStatus 全部优先打账号自己的域。
2. **国际版模型表可用**：utils_chat 链路的 `get_detail_param` 在国际主机
   实测 200（22 个模型）——hub 记载的「国际版 model_list 403」是 **raw
   链路**的 `/api/ide/v1/model_list`，别混。国际表 GPT-6.1 系/Kimi-K3/
   GPT-5.2 多数 `is_invisible_to_user=true`（订阅档隐藏模型），Free 账号
   实际可对话的是 `deepseek-v4.1-flash` / `deepseek-v4-pro-0813`；
   国际表**没有 consumption_rate**（倍率如实「无此数据」）。
   模型表按区域分缓存（`models.caches`），`/traework/models?region=intl`。
3. **国际版是订阅制「按请求数计」，不是积分**（真机 Free plan）：
   没有 `usage_summary`（国内 total/consumed 口径不存在），额度形态是
   `product_extra.subscription_extra.quota` 的请求数限额（premium fast 10 /
   slow 50 / advanced 1000 / auto_completion 5000 / solo 并行 2）。解析在
   `checkin.parseIntlPlan`，落 `/credits` 行的 `intlPlan` 字段——界面显示
   套餐名 +「按请求数计」。**坑：国内额度包里也带 subscription_extra 字段**，
   parseIntlPlan 必须只在 `regionOf(auth)==='intl'` 时调用，否则国内号的
   积分口径会被误显示成「按请求数计」（真机踩过当场修）。
4. **国际版没有签到/活动接口**（与 hub 实测一致，ug 族 404）：`status`/
   `claim`/`claimActivities` 对 intl 直接明确报出；`/credits` 行的 error
   在「usage 成功、仅签到不可用」时为空（否则国际账号永远挂「查询失败」）；
   `known` 口径把有 intlPlan 的行算「已知额度」。
5. **模型-区域亲和（混合池的正确性）**：`send()` 里模型只存在于某一区的
   表时（cnKnown && !intlKnown）把选号约束到该区——否则池子会把 glm-5.2
   派给国际账号白撞上游。只认「正据」：某区表没就绪不猜，维持普通轮询；
   两区都有的模型（deepseek-v4.1-flash）不约束。真机验证：不带 region 打
   glm-5.2 实际派给国内账号。TRAE 宝（persona）恒限国内；Remote 链路
   intl 账号不走（remoteBaseOf 对 intl 如实拒绝）。
6. **pay 族走 v1 路径**：国际版 `ide_user_ent_usage`/`ide_user_pay_status`
   只有 v1（`/trae/api/v1/pay/...`），国内保持 v2；ugHeaders 的区域身份
   （X-User-Region/Package-Type/X-Lscbd-Aid）按区域出值。

真机验证记录（2026-11-03）：国际账号 wearetheone777（id=3，SG 落点）登录
落盘；`/traework/models?region=intl` 22 个模型；billing-check
`region=intl` + deepseek-v4.1-flash 真实出流（output 1866 token，国际版无
credits 口径 → delta 如实 null）；glm-5.2 不带 region 派给国内账号
（ratio 0.954 正常）。前端：账号卡区域徽标 + 登录区域选择（TraeworkAccounts）、
模型页区域切换（ModelsView，两通道）、仪表盘徽标、登录态表区域列、
KeysView 文案更新。区域约束的运行时过滤（`accountsForRegion`）与
keys.js 的 region 绑定自 2026-11-01 就位，本次补齐的是「国际账号本身」。

**TRAE Remote 链路已通（2026-11-01，P2-16 最小版，默认关）。**
`DUMATE_TRAEWORK_REMOTE=1` 时 **auto 档纯文本请求**走 remote
（`trae-api-cn.mchost.guru/api/remote/v1`），带 tools 与显式模型名继续走
utils_chat（工具矩阵与 manual 策略未实现，边界刻意收窄）。三条实测铁律：
① 事件流终结判据是 `event:done`，**没有 `data:[DONE]` 哨兵**；② `plan_item`
的 thought/reasoning_content 是**累积快照**不是增量，翻译层要快照/增量双判
（判错=复读机）；③ 逐轮账单在这条链路上**真实可查**——拿创建会话返回的
`message_id` 查 `get_session_usage` 返回真实 `amount_float`，P0-7 保留的
`parseSessionUsage` 由此激活，计费自检自动切精确口径。实现见
`src/traework/remote.js`，单测 `test/unit/trae-remote.test.js`。

**TRAE 融合批次（2026-11-06，GitHub 检索 Trae2api-cn/trae2api-hub 后逐项落地，六件）。**

1. **思考档位可控（remote/manual）**：`reasoning_effort`（全入口写法归一）→
   `custom_model.reasoning_effort`，原生三档 `light/high/extra_high`。钳制是
   **向下**的（不高于请求档的最高支持档）；descriptor 必须 `support_thinking===true`
   且给 `options`——51 个模型里 31 个 `support_thinking:false`，唯一支持的
   minimax-m3.1-flash 在 remote 上游 4001（**等上游放开自动生效**）。字段按模型
   对象已有键二选一（`reasoning_effort_level` 优先），不支持时删残留字段防降档。
   仅 manual 策略（REMOTE=2）；auto 档无 custom_model 槽不下发。观测走
   `logRemoteEffort`（生效/未生效都打一行——档位静默丢失用户无感）。
2. **1M Max 模式**：`payload.trae_max_mode` 或 `DUMATE_TRAEWORK_REMOTE_MAX_MODE=1`
   （+ `_MAX_MODELS` 白名单）→ `model_selection_strategy:"max"` + descriptor 显式
   上限（`max_mode===true` + ≥1M + prompt_max_tokens/max_tokens>0 三项齐备，缺一
   不启用——**不合成 1M 参数**）；会话键加 max 变体。当前上游 0/51 模型声明
   `max_mode`，协议就绪等放开。
3. **remote 缓存透传**：`cache_read_input_tokens` → OpenAI 标准位
   `prompt_tokens_details.cached_tokens`（utils_chat 同口径），写缓存平铺保留。
   **SSE 的缓存 0 不能证明未命中**（实测两轮全 0、账单 25344）——账本层以
   `get_session_usage` 的 `extra_info` 为权威（`credits.parseBillCache`）。
4. **事件名驼峰归一**：上游事件名有驼峰形态（`tokenUsage`/`responseDone`/
   `streamDone`），只做小写会漏进 message 分支——`normEventName` 驼峰→蛇形 +
   别名表。
5. **`isAuto` 修复**：`send` 的 remote 分流看 `payload.model`（未剥前缀），模块
   直调 `traework/auto` 时静默退回 utils_chat——改为按剥前缀后的原始意图判定。
6. **4028 端点信号**：errtext 翻译「该模型在此链路不可用，改走其他链路」——
   Trae2api-cn 实测部分模型（deepseek-v4-pro）在 Remote/raw 上固定 4028/502，
   换账号/重试无效。

**TRAE SOLO/IDE raw 链路已通（2026-11-06，#12 第一版，`DUMATE_TRAEWORK_SOLO=1` 默认关）。**
`/api/ide/v2/llm_raw_chat`（v2→v1→api5-normal 候选链），帧形状与 utils_chat
**完全同族**（metadata/timing_cost/output/token_usage/done）——chat.js 的
readStream/aggregate/gate **零改动复用**。三个硬门槛（三轮真机探测的教训）：
① `model_name` 必须用 `model_detail_list` 的 `__dev` 全名（剥后缀/族名都 4001）；
② `encrypted_model_params`（上游下发的现成加密信封）**字符串原样**，解析成对象
被 400 拒；③ **版本身份必须与 JWT 一致**——`X-Ide-Version` 用我们自己的
`0.1.43`+动态版本码，Trae2api-cn 的 3.4.4 是它的凭证身份，套到我们的
TraeWork JWT 上判 1001。**纯国内链路**（国际 JWT 恒 1001）：solo 启用时池层
强制国内选号（不能选号后静默回落 utils_chat——那样 solo 对两区模型永不生效）。
账单键 `conversation_id`/`session_id` 与 utils_chat 同机制（`get_session_usage`
实测 0.13）。raw v2 协议上有原生 tools 槽（`parameters` 保持对象、assistant 历史
用 `function_call` 包装），但带 tools 实测 400——形状证据不足不预编，带工具仍走
utils_chat。实现 `src/traework/solo.js`，单测 `test/unit/trae-solo.test.js`（7 项）。
链路优先级：REMOTE=2 manual > solo（纯文本）> utils_chat（互斥不叠加）。

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

**TRAE 业务码分类与请求体韧性（2026-10-31，P1-13）。** 三件事：

1. **业务码收进 `upstream-errors.js`**（`traeCodeKind`/`traeCodeOf`）：
   1005→model（订阅专享）、3003/3004/4008→soft（额度，换号有用）、
   4015/4019→soft（风控，不进熔断）、1001/4001/4011/4023/4026/10101/20405→
   不惩罚（确定性请求错误）。**判据带 `traework <code>` 前缀**（`traeCodeOf`
   只在 TRAE 语境认码）——否则会把别的通道的数字误判进来。这些分支必须排在
   5xx/403 的 breaker 分支之前：码值都 ≥1000，放后面会被误吃。除 4001 与
   HTTP 401 外**其余码值未在本项目链路实测**（来源是社区参照），只做保守分类。
2. **`ide_user_pay_status` 已接**（`/trae/api/v2/pay/ide_user_pay_status`；
   v1 与 v2 都 200，v2 多 `detail`/`enable_solo_*`，取 v2）。
   `checkin.payStatus` + 纯函数 `parsePayStatus`。它解答了「Free 号为什么
   额度看着不对」：`user_pay_identity_str` 直接给档位（实测 "Free"）、
   `enable_solo_*` 是能力位（**缺失给 null 不是 false**——false 会被读成
   「明确不支持」，null 是「上游没说」）；`commercial_activities` 是活动资格表，
   实测 `send_message_reward`(type 105) `eligible:true` + `general_credits:500`
   ——**当前账号有一笔可领的 500 积分活动**（此前清单记「本账号无配置」是错的）。
   管理端 `/credits` 行带 `payIdentity` / `capabilities` / `claimableActivities`。
3. **buildBody 请求体韧性**（三类会把上游炸成无信息量 4001 的形状）：
   `role:'developer'`→`system`（OpenAI/Anthropic 都归一）、孤儿 tool 消息剔除
   （先收集 assistant 声明的 tool_call id，再剔引用不到的）、空 assistant 剔除、
   首条 system 移到最前。计数进 `meta.dropped`（`orphanTool`/`emptyAssistant`/
   `roleFixed`/`images`），排障能看到动了什么。离线验证：
   `node --test test/unit/trae-pay-status.test.js`（9 项）+
   `test/unit/trae-error-codes.test.js`（9 项）。

**TRAE 的 usage 缓存镜像（2026-10-31，traework2api-panel issue#3）**：上游
token_usage 报顶层 `cache_read_input_tokens`，不镜像进
`prompt_tokens_details.cached_tokens` 的话按标准协议解析的客户端恒显示缓存
未命中。门与非流式两处都镜像（真机实测字段已出现）；原字段保留，上游没给
不造字段。**业务码 1005「订阅专享」（2026-10-31 分类，语义对齐
traework2api-panel）**：Free 号打订阅模型上游回 403/业务码 1005——换模型即可
用，进 (账号,模型) 负缓存并明确报错，不罚账号、不进熔断。判据在
`upstream-errors.classify` 里、5xx 分支之前（1005 > 500 会被 breaker 误吃）；
真机暂无订阅模型可打，分类为对齐实现、待首个真实样本校准。

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
