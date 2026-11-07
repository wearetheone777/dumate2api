# 跨通道共用约定：工具调用修复、编码性能与埋点

> 本文件从 `CLAUDE.md` 的「项目定位」章节按主题拆出，内容为原文照搬（未改写）。
> 改通道细节请改这里；`CLAUDE.md` 只保留核心架构与索引。

**Codex 自由格式工具（custom_tool_call）与 model=auto 兜底（2026-10-30）**。
Responses 入口此前把 `custom_tool_call` / `custom_tool_call_output` 落进 default
分支**静默丢弃**——Codex 配了 freeform 工具（如 apply_patch）时调用了凭空消失。
现在转成标准 function 调用（input 包装成 `{input}` 单字段对象），`*_call_output`
再解回 tool 消息。`model=auto` 在直连通道的兜底：搭子有 mapModel 兜底、千问有
别名表（auto→pro）、Qoder 上游原生 auto 档，**只有 TRAE 会撞 assertModelKnown
的 400**——`traework/auto` 现在兜底到 DEFAULT_MODEL（glm-5.2，真机 200 验证）；
不做 Trae2api-cn 的「按请求内容智能路由」（隐性替换模型违背显式契约，计费倍率
跟着变）。`previous_response_id` 维持忽略（上游无状态，Codex 全量回传 input）。

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

**DSML fail-closed 三分判据（2026-10-31，hub#120 推广到三条 COSY 系通道，解析器
收敛到 `src/repair.js`；2026-11-04 WorkBuddy 的门也接同一兜底）**。Qoder/千问同跑
DeepSeek 系，一样会犯——只救「正文还在缓冲
（未转直发）」的场景。分类器 `repair.classifyDsml(text)`：
`recovered`（完整 calls 块还原成 tool_calls + 干净正文，finish 的 stop 纠正）、
`empty`（标签闭合但没有 invoke 的空壳——剥离标记 + WARN，**不剥离会被
「播报即收尾」的判据反复捞出形成无限重试**）、`leak`（calls/invoke/parameter
开了没收——**报错 fail-closed**，把半截协议喂给客户端比明确失败更糟）。
代码围栏内的 DSML 是模型在讨论格式，不碰（`stripFences` 先判）。TRAE 门
（createTextGate）与千问/Qoder/WorkBuddy 共享门（createChunkGate，finish 阶段兜底，
需传 `{model, channel}`）同一语义；**非流式在各自 aggregate 出口接
`repair.aggregateDsmlFallback`（2026-11-04 收敛成共享助手：qoder 内联收编、
qwenwork 补齐当年漏掉的非流式出口、workbuddy 新接；recovered 时调用方把
finish 的 stop 纠正成 tool_calls）**。traework
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

**「播报即收尾」现在是四通道共用一条修法（2026-10-30 收敛到 `src/repair.js`，
2026-11-04 WorkBuddy 接入）**。
TRAE 2026-10-05 的实测结论（见下一条）推广到千问、Qoder 与 WorkBuddy：同样会「只播报
进度不调工具就收尾」，同一份判定与缓冲门在四条直连通道上语义一致，只差上游帧形状
（TRAE 是 `event:output`，千问/Qoder/WorkBuddy 是标准 OpenAI chunk——WorkBuddy 的上游
本身就是标准 OpenAI SSE，直接复用 `createChunkGate`，连解析层都不用改）。

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

配置按通道独立：`DUMATE_TRAEWORK_*` / `DUMATE_QWENWORK_*` / `DUMATE_QODER_*` /
`DUMATE_WORKBUDDY_*` 的 `HOLD_CAP` 与 `REPAIR_RETRY`（见环境变量表）。离线验证：
`node --test test/unit/repair-gate.test.js`（共享模块 11 项）+
`node test/verify-qwen-repair.js`（36 项）+ `node test/verify-qoder-repair.js`
（36 项）+ `node test/verify-traework-repair.js`（38 项）+
`node test/verify-workbuddy-repair.js`（39 项，2026-11-04）。五者都打桩
`chat.postStream` / `chat.post`，不需要账号与网络；**池状态必须隔离**（脚本自带
`DUMATE_POOL_STATE` 临时文件，且失败用例之间要 `pool.revive()`——402/500 会让账号进冷却）。

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

**工具参数被截断必须报 `incomplete`，不能报 `completed`**（`src/responses.js` 的 `truncatedArguments`）。
上游在 `finish_reason=length` 处会把 `arguments` 停在半句 JSON（实测 `{"cmd": "... @('第三章　第七户','',`，字符串都没闭合）。网关若当正常工具调用交给 Codex，Codex 会**执行一条语法残缺的命令**：命令必然失败，模型看到失败后往往只回一句「下一步：写入第 N 章」就结束回合。现在这种参数会被判成 incomplete，埋点带 `error=tool_arguments_truncated`。离线验证：`node test/verify-truncated-toolcall.js`。
顺带修掉一个误报：`emptyButTruncated` 原来只排除 `stop`，把**纯工具调用轮次**（`finish_reason=tool_calls` + 正文 0，Codex 里大量存在）也算成了截断。

**`channel` 字段是必须项**：`reqlog` 每条记录带 `channel`（`dumate` / `qwenwork`）。千问首帧实测 6.7s，与搭子混在同一均值里会让「平均首字延迟」无法归因。

**历史记录（无 `channel` 字段的旧日志）归入搭子**：分通道埋点上线前只有搭子一条通道，单列「未标注」会让用户切到搭子时数字凭空变小。只有「查看全部通道」时才显示 `untagged` 一栏。服务端过滤在 `usage.js` / `reqlogs.js` 的 `channel` 参数里做——前端筛只能筛掉当前页的行，分页总数仍是全通道的。
