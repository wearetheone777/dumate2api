# 千问办公通道：预算、纪律与端点

> 本文件从 `CLAUDE.md` 的「项目定位」章节按主题拆出，内容为原文照搬（未改写）。
> 改通道细节请改这里；`CLAUDE.md` 只保留核心架构与索引。

**千问的计费自检探针（2026-10-30 同日，与 TRAE 同形不同判据）**。
`GET /api/admin/qwenwork/billing-check?model=flash`（admin/routes/qwenwork.js）——
发一个小请求（数 1~400），**force 读**三池余额前后差值（30s 缓存会吞掉本次
差值），归属口径与 `credits.capture` **逐字一致**（`free = max(0, Δdaily)`、
`paid = max(0, Δmonthly+Δlongterm)`，longterm 负值坏读时不会算出负消耗）。
**2026-10-31 修正：上游模型表确实带 `price_factor`**（真机复核：`flash=0.1`、
`pro=1`、`qwen3.8-max-preview=1.8`，另有 `context_config` 的 200K/400K/1M 三档
与 `is_vl`）。此前「千问无标称倍率」的结论是**解析没做**，不是上游没给。倍率
与上下文现在在模型页展示（`src/qwenwork/index.js` 的 `normalizeModelRow` /
`listModelEntries` → `model-info.qwenworkRows(entries)`）。
但**探针仍不算 ratio**：`price_factor` 是相对倍率，与三池 credits 不是同一单位
（实测 flash 每千 token 成本约 0.002~0.01 credits，而标称倍率是 0.1），直接相除
会得到没有意义的数。所以响应里 `expected`/`ratio` 恒 null，只有 `cost`（本次
三池差值）、逐池 `pools`、`billed`（每千 token 成本）。判读靠历史量级：实测 flash 约 **0.002~0.01
credits / 千 token**，余额 4 位小数，短请求偏差主要来自精度。结算轮询 3 轮
（约 4 秒，依据是 `credits.capture` 的 1.5s 实测余量）；没测到如实 `cost: null`
+ warning，不编 0。纯函数在 `src/qwenwork/billing.js`；前端在千问模型卡有
「计费自检」按钮（默认挑 `flash`），成本为 null 标黄、其余用 info（无标称值
可做 ±5% 着色）。离线验证：`node --test test/unit/qwen-billing.test.js`
（10 项，差值口径/负值坏读/归属）+ `test/unit/qwen-billing-probe.test.js`
（3 项，路由编排打桩：归属、失败如实、没测到不编）。**真机验证受阻于额度**：
落地时两个千问账号都是 402 硬冷却（到本地 0 点），恢复后跑一次
`/billing-check` 即可完成首个真机样本。

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
忽略该字段或它不是推理开关语义。与搭子「调参数无效」同款结论。
**2026-11-06 修订「只有 Qoder 档位可控」的旧口径**：TRAE 的 **Remote/manual 与
SOLO raw 链路的思考档位也可控**（`custom_model.reasoning_effort`，原生
light/high/extra_high，Trae2api-cn 实测 + 我们的协议实现对齐）——旧的「TRAE
档位字段被忽略」是在 utils_chat 链路上实测的，不是链路无关的结论。可控 = Qoder
（parameters.reasoning_effort）+ TRAE remote/solo（custom_model.reasoning_effort，
仅 manual 策略；utils_chat 仍不可控）。

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

**原因已由客户端解包确认（2026-10-31，`docs/QWENWORK-CLIENT-1.4.0-ANALYSIS.md`）**：
官方客户端构造这个对象时 **`imageUrls` 恒为 `null`**（`ydl()` 里写死），
`text` 是唯一载荷。附件与图片走的是**另一条链路**：`barn` 预上传
（`POST /api/barn/v1/upload` → 分片 → 完成，拿到 `session_id`）→ **ACP 会话**
（`wss://qwenwork.cn/api/chat-ws`）里用 `file_uuid` 引用，内容由
`GET /api/oauth/files/{file_uuid}/content` 取。所以「千问不能收图」不是缺陷，
是**这个端点上结构性地不可能**——要图片只有接 ACP（清单 P2-17）。
同一份解包还确认了三个未接入端点（`/algo/api/v1/webSearch/oneSearch`、
`/algo/api/v2/service/pro/imageSearch`、`/algo/api/v5/service/region/endpoints`）
与版本漂移（`COSY_VERSION` 我们写 1.1.52，客户端 worker runtime 已是 1.1.71，
且官方请求带 `X-QwenWork-Version` / `-Release-Version` / `-Build` / `-Platform` /
`-Arch` / `-Channel` / `-App-Mode` 一整套身份头）。

**ACP 链路的计费实证（2026-11-05，第六批）**：ACP 会话**真实扣费**且**全落
monthly 池**（daily/longterm 零动），结算 <1.5s。同 prompt 四轮实测
0.1919 / 0.2294 / 0.075 / 0.1376 credits——**方差 3 倍**：ACP 按会话内实际
推理轮数扣费，单次探针读不准，判读必须多跑几轮。ACP 帧不带 token 计量
（40 帧真机样本 0 处计量字段），三池差值法是唯一计量途径。计费自检探针
因此多了一条 ACP 活路：`?model=qwen-acp/auto` 走 `acp.send`——**必须不传
onChunk**（「onChunk 存在 = 流式」分叉，传函数返回 `{streamed:true}` 拿不到
usage），tokens 如实全 0、billed 恒 null。这条路线的价值：chat 桥被账号级
模型权限拦住时（403 `Model is not available for this user`，账号 3 现状，
网关侧无解）ACP 仍可用——同一 accessToken 两条链路可以一封一通。

**版本漂移已于 2026-10-31 同日对齐**（真机 1.1.71 + 新头正常出流）：
`COSY_VERSION=1.1.71`、`IDE_VERSION=1.4.0`、`RELEASE_VERSION=1.4.0-26102705`
（取自解包 `package.json` 的 `qoderworkUpgradeVersion`，`BUILD=26102705` 由
release 派生、两者必须成对）。六个有字面量依据的 `X-QwenWork-*` 头已随签名
发出；`X-QwenWork-App-Mode` **刻意不发**——它的取值是解包里的运行时配置
（`constants$4.a.appModeId`），没有字面量依据，不编假值。四个常量与头都有
环境变量开关（`DUMATE_QWENWORK_COSY_VERSION` 等，见环境变量表）。

**联网搜索与图搜已接入**（`src/qwenwork/search.js` + `POST /v1/search/web`
与 `/v1/search/images`）。与对话链路的形状**完全不同**：请求体是
`{payload: JSON.stringify(业务参数), encodeVersion:"1"}`（业务参数二次序列化），
不是 `chat_context`；`imageSearch` 还多 `requestId`（UUID）与 `timestamp`
（秒字符串）两个字段，count 硬校验 [1,10]；响应没有信封，直接是业务体
（`pageItems` / 结果数组在 `results`/`data.items` 等多个候选位置——按客户端
`tkd()`/`rkd()` 的候选表解析）。国际版 webSearch 是 `/unifiedSearch`
（按 LINGMA_ENV 切换），**只接了 CN，不预编没验证的路径**。

**barn 附件上传已接 HTTP 半边**（`src/qwenwork/files.js` +
`POST /v1/files/upload`）：分片公式 `clamp(1MB,100MB,ceil(size/10))`、
基址 `https://gateway.qwenwork.cn/api`（少写 `/api` 404）、**纯 Bearer
不走 COSY 签名**。真机 32B 与 3MB（3 片）都成功。但**这不等于附件能用**：
barn 完成体只回 `storage_path`，`file_uuid` 由上游在 **ACP 会话侧**下发；
ACP WebSocket（Go 后端的 `/api/chat-ws`）的帧协议没有证据（二进制里只有路径
字符串，方法名搜不到；worker runtime 里是 ACP agent 侧、stdio 传输）——
按「无证据不预编」纪律 WS 通道不做。`/v1/files/upload` 在上游没给
`file_uuid` 时如实回 null + `reference_note`，**不要拿 session_id 当引用键**。

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

**千问通道失败不阻断启动**：搭子是主链路。没有可用账号时网关照常监听，`/health` 的 `channels.qwenwork.ready` 报 false（本地签名不依赖任何外部文件，所以 2026-10-14 起唯一会缺的就是账号）。

**每请求 spawn 一次 Node 子进程**（调 wasm_helper.mjs）——**这已是历史**：2026-10-14 起千问默认走本地签名（`src/qwenwork/cosy-sign.js`），不再 spawn 子进程。只有 `DUMATE_QWENWORK_USE_WASM=1` 时才回到 wasm 那条路；那时若成为延迟瓶颈，改成长驻子进程只需改 `src/qwenwork/bridge.js`——`wasm_helper.mjs` 已预留 `serve` 模式，上层 `chat.js` 不受影响。

用前缀而不是猜模型名的理由：两侧模型名会撞车（搭子有 `glm-5`，千问上游也是 GLM 系），猜错了两侧都返回 200，从响应里根本看不出来；且隐式路由会让同一名字今天走 A 明天走 B。未知前缀若静默跑到搭子，会拿到「看起来成功但完全不是想要的结果」，比直接 400 难查得多。

**千问上游的 403 是间歇性的**（2026-10-02 实测）：同一账号、同一模型、同一分钟，
直接请求可能成功、`send()` 可能失败，几分钟后自愈。表现为 `Model is not available
for this user`（账号维度，网关会据此换号）。**这不是配置错误、不是额度、不是 token
问题**——遇到就重试。真正需要处理的是 **402**（额度真耗尽）和 **`换票失败`**
（refresh token 失效，要重新登录），这两种才会持续失败。
