# 四通道能力融合清单（2026-10-31）

> 调研对象：百度搭子（DuMate）、字节 TRAE Work、阿里千问办公（QwenWork）、阿里 Qoder。
> 目标：找出**上游还有、本项目还没接**的能力，按价值与成本排序，供后续排期。
> 本文只写结论与证据，不写实现代码。已有的架构说明见 [CLAUDE.md](../CLAUDE.md)。

## 证据分级

| 标记 | 含义 |
|---|---|
| 【实测】 | 本次或历史会话里直接打过上游并得到预期结果，可复现 |
| 【源码】 | 已核对参照仓库的具体源文件（不是 README 转述） |
| 【文档】 | 参照仓库的 README / docs / issue 记载，本项目未独立验证 |
| 【推测】 | 依据 schema 或日志推断，无实现证据 |

---

## 0. 摘要：本次改写的三条既有结论

| 结论 | 原状态 | 现在 | 证据 |
|---|---|---|---|
| 搭子是否支持原生 function calling | 「上游不支持，工具降级为纯文本」 | **支持**。非流式与流式都返回标准 `tool_calls` | 【实测】`glm-5` + tools → `finish_reason:"tool_calls"`，流式 `delta.tool_calls` 带完整 `id/name/arguments` |
| 搭子有没有第二条端点 | 只有应用链路 `/gateway/apis/v1/chat/completions` | 还有**千帆原生透传** `/gateway/v2/chat/completions`（JSON mode、视觉、任意千帆模型） | 【实测】 |
| 网关是否只能做对话 | 是 | 搭子还能做**生图 / TTS / 视频**，走同一份网页凭证 | 【实测】生图与 TTS 全链路打通 |

三条都只需要现有网页凭证换的 token，加一个请求头 `X-Appbuilder-From: openclaw`。

---

## 1. 百度搭子（DuMate）

| 能力 | 落点 | 价值 | 难度 | 证据 |
|---|---|---|---|---|
| **原生 tools 全入口打开** | `src/server.js` 的 `anthropicToOpenAI(..., { nativeTools: !route.target.needsModelMap })`；`src/anthropic.js` 的 `opts.nativeTools` | Codex / Claude Code 从文本降级升级到结构化工具 | 低 | 【实测】 |
| **response_format / JSON mode** | 新增：走 `/gateway/v2/chat/completions`（应用端点回 400） | 结构化输出 | 低 | 【实测】 |
| **usage 缓存归一** | `src/usage-norm.js` 已存在，搭子路径未接；上游已给 `prompt_tokens_details.cached_tokens` | 缓存命中对客户端可见 | 低 | 【实测】 |
| **生图 `/v1/images/generations`** | 新模块；上游 `image_generate_v3/async` | 新的营收面 | 中 | 【实测】 |
| **TTS `/v1/audio/speech`** | 新模块；上游 `t2a_v2/sync` | 同上 | 低 | 【实测】 |
| **视频生成** | 上游 `video_generate/async` + `video_elements/async` | 高价值但链路长（分镜/首尾帧/对白） | 高 | 【文档】端点已实测存在 |
| **参考图/文件上传（BOS）** | `appbuilder.baidu.com/v2/tools/bos/upload`；桌面库表 `file_task/file_part` | 生图参考图、文档解析的前置 | 中 | 【文档】 |
| **千帆原生透传通道** | `/gateway/v2/chat/completions`，任意千帆模型 | 绕开模型别名，拿更多模型与视觉 | 中 | 【实测】 |
| **opencode Agent 会话** | `POST /session`、`POST /session/{id}/message`，头 `X-Dumate-AutoModel-Level` | 真·执行型 Agent（落盘、跑命令） | 中 | 【文档】 |
| **MCP connector** | `GET /api/dumate/connector/v2/{list,template/list,mcp_tool_config}` | 接第三方 MCP 的官方通道 | 中 | 【实测】端点通，本账号无配置 |
| **技能广场（101 个）** | 本地 `skills/` 已有 25 个；`POST /api/dumate/skills/square/list` | 文档解析/PPT/深度研究/语音一片接进来 | 中 | 【文档】 |
| **会话/项目历史** | `GET /api/dumate/session/list`、`session/detail`、`projects` | 审计、真 `previous_response_id` | 低 | 【实测】 |
| **浏览器 CDP 中继** | 客户端 relay `127.0.0.1:19228` + relay token | 接管已登录真浏览器 | 中 | 【文档】日志 |
| **IM 桥（含飞书）** | 客户端 `opencode-router` 的 telegram/slack/feishu/weixin/钉钉适配器 | 解锁原「缓办」的飞书推送 | 中 | 【文档】日志 |
| **记忆 / 本地知识库** | `memory.db`（FTS5）、`opencode.db` 的 `memory_chunk`（带 embedding） | 跨会话记忆、代码库 RAG | 中 | 【文档】 |
| **模型路由决策** | `POST /gateway/routing/decide` | 先判任务类型再选通道 | 低 | 【文档】日志 |
| **云端 Agent SSE** | `POST /gateway/v2/agent/ai_assistant/run`，`X-Dumate-Request-Extra-Param: sandbox=true` | 云端沙箱执行 | 高 | 【文档】帧未逆向 |
| **app token** | `GET /api/dumate/app/token/get` | 跨服务复用短期凭证 | 低 | 【实测】 |

### 1.1 已核实的请求形状（搭子）

生图（`v3`，提交与查询同路径）：

```json
POST /gateway/v2/tools/dumate/image_generate_v3/async
{ "query": "...", "model": "dumate-image2.2", "quality": "low",
  "resolution": "1K", "aspectRatio": "1:1", "maxImagesNum": 1,
  "imageUrls": ["<可选参考图>"] }
→ { "code": "0", "task_id": "..." }

GET /gateway/v2/tools/dumate/image_generate_v3/async?task_id=<id>
→ { "status": "success", "imageUrls": ["https://..."],
    "ModelVersion": "image2_low", "Resolution": "1K" }
```

可选模型：`dumate-image2.2` / `dumate-image2.1`（走 v2 路径）/ `dumate-image1.2`（v1 路径）/ `dumate-image0.1`（beta 路径）。分辨率 `1K/2K/4K`，宽高比 `1:1 3:2 2:3 3:4 4:3 16:9 9:16 21:9 9:21`。

TTS（minimax）：

```json
POST /gateway/v2/tools/dumate/t2a_v2/sync
{ "model": "dumate-tts", "text": "...", "stream": false,
  "voice_setting": { "voice_id": "Chinese (Mandarin)_Sweet_Lady", "speed": 1, "vol": 1, "pitch": 0 },
  "audio_setting": { "sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1 },
  "subtitle_enable": false, "output_format": "url" }
→ { "base_resp": { "status_code": 0 }, "data": { "audio": "<URL 或 hex>" } }
```

视频：`video_generate/async`，模型 `dumate-video2.9` / `dumate-video3.0`，查询同样是 GET 同路径 `?task_id=`。

### 1.2 端点能力边界（别混用）

| 端点 | 原生 tools | JSON mode | 视觉 | 可用模型 |
|---|---|---|---|---|
| `/gateway/apis/v1/chat/completions`（应用链路） | ✅ | ❌ 400 | ✅ | 应用别名（`glm-5`、`model-text` 等） |
| `/gateway/v2/chat/completions`（千帆原生） | ✅ | ✅ | ✅ | 千帆原生模型（`qwen3.5-35b-a3b` 等）；应用别名回 401 |

---

## 2. 字节 TRAE Work

| 能力 | 落点 | 价值 | 难度 | 证据 |
|---|---|---|---|---|
| **逐轮账单 `get_session_usage`** | `src/traework/credits.js` 的探针路径 | 取代「前后快照差值 + 8 秒轮询」，逐笔精确 | 低 | 【源码】 |
| **`ide_user_pay_status`(v1)** | `src/traework/credits.js` / `models.js` | 补 Free 账号缺失额度 + 并发槽 | 低 | 【文档】 |
| **Remote 链路** `/api/remote/v1/chat_sessions` | 新传输层，与 `chat.postStream` 并列 | 更稳通道 + 1M Max + 原生思考档位 + 中断 | 中 | 【源码】 |
| **IDE `llm_raw_chat`** | 新链路 | 并行工具调用、`builder_with_mcp_v3` | 高 | 【文档】 |
| **额度包过滤口径** | `parsePacks` | 现在剩余额虚高（PROMO/IsHide/Status=3 要剔除） | 低 | 【文档】 |
| **签到 `extra_credits` 口径** | `src/traework/checkin.js` | `credits` 与 `extra_credits` 二选一，不相加 | 低 | 【文档】 |
| **同日 claim 幂等纪律** | `checkinAndSave` | 同日多次 claim 是风控标记 | 低 | 【文档】 |
| **`CheckLogin` 登录/绑定态** | `src/traework/auth.js` | 9074 诊断不用打对话 | 低 | 【文档】 |
| **设备绑定续期（ECDSA）** | `src/traework/device.js` | 9074 根因级修法 | 中 | 【文档】 |
| **错误码补全** | `src/upstream-errors.js` 的 TRAE 分支 | 3003/3004/4008/4011/4023/10101/20405 | 低 | 【文档】 |
| **请求体韧性** | `src/traework/chat.js` 的 `buildBody` | `role=developer`→`system`、剔孤儿 `tool`、剔空 assistant | 低 | 【文档】 |
| **模型目录死键过滤** | `src/traework/models.js` | `agnes-2.0-flash` 等在 `solo_work_lite` 必 4001 | 低 | 【实测】 |
| **提示词注入思考深度** | `src/traework/chat.js` | utils_chat 上唯一可用的档位手段 | 低 | 【实测】 |
| **活动/邀请积分** | `src/admin/routes/traework.js` | 额外积分来源 | 中 | 【文档】 |
| **国际版（另一套协议）** | `constants.js` 的 `AGENT_HOST_INTL` | 海外账号池 | 中 | 【文档】 |

### 2.1 逐轮账单（重点）

```text
POST {host}/api/v1/commercial/get_session_usage
body: { "session_id": "<本轮 turn id>" }
→ data.user_usage_group_by_session.credits_float
```

`turn id` 取自流内的 `reply_to_message_id` / `user_message_id`。拿到它之后，TRAE 的计费自检不再需要「发请求 → 快照所有账号 consumed → 轮询 8 秒」，可以直接读单笔。

### 2.2 Remote 链路（重点）

```text
BASE: https://trae-api-cn.mchost.guru/api/remote/v1
POST /chat_sessions
GET  /chat_sessions/{id}/events?reply_to_message_id=...
POST /chat_sessions/{id}/stop
agent_type: solo_work_remote | solo_agent_remote
```

思考档位在 `custom_model.reasoning_effort_level`（`light/high/extra_high`）。**注意这与现有定案不冲突**：现有定案是「`llm_utils_chat` 不支持请求级档位」，Remote 是另一条链路。

---

## 3. 阿里千问办公（QwenWork）

| 能力 | 落点 | 价值 | 难度 | 证据 |
|---|---|---|---|---|
| **附件/网盘上传（barn）** | 新模块 `src/qwenwork/files.js` | **`imageUrls` 死掉后唯一能真正传文件/图的路** | 中 | 【文档】bundle 代码 |
| **模型元数据** | `src/qwenwork/index.js` 的模型表解析 | 倍率/上下文/多模态；**与现有「无 price_factor」结论冲突** | 低 | 【文档】待复核 |
| **会话历史/续传** | 新模块 | 真 `previous_response_id`、断线重放、审计 | 中低 | 【文档】 |
| **套餐/额度/权益** | `src/admin/routes/qwenwork.js` | 套餐展示、额度预警 | 低 | 【文档】 |
| **ACP 会话协议** | 独立通道（不要塞进现有 chat 桥） | 整个 agent 产品（技能/幻灯片/发布网页） | 高 | 【文档】 |
| **企业身份/组织池** | `src/qwenwork/auth.js` | 企业积分池、多组织 | 中 | 【文档】 |
| **区域端点发现** | `src/qwenwork/constants.js` | 多区域故障转移 | 低中 | 【文档】 |
| **定时任务** | 新模块 | `/v1/automations` 类能力 | 中 | 【文档】路径存在 |
| **业务错误码** | `src/qwenwork/index.js` | 103/105/110/112/114/115-122/406/430/10605 | 低 | 【文档】部分实测 |
| **企业 OpenAPI** | —— | 企业用量对账 | 高 | 【文档】需旗舰版 |

### 3.1 附件上传（重点）

```text
POST /api/barn/v1/upload            { path, size, mime_type, chunk_size } → session_id
POST /upload/{id}/chunks?chunk_number=N
POST /upload/{id}                   → ossId
GET  /api/barn/v1/files/{path}?mode=preview|download → presigned URL
```

约束：≤9 个附件/条，单文件 500MB。这是比占位文本正得多的图片/文档输入方案。

### 3.2 ACP 会话（战略级，但建议独立）

```text
wss://qwenwork.cn/api/chat-ws
方法：join / new_prompt / session/cancel / session/publish / session/request_permission
事件：agent_message_chunk / agent_thought_chunk / tool_call / plan / current_mode_update
```

它会引入第二套 agent 语义，和现在的「OpenAI 兼容 chat 桥」不是一类东西。

---

## 4. 阿里 Qoder

| 能力 | 落点 | 价值 | 难度 | 证据 |
|---|---|---|---|---|
| **Pro 福利包（一次性 +1800）** | `src/qoder/index.js` + 管理端 | 单号一次性白拿 18 倍日额度 | 低 | 【文档】 |
| **团队共享额度 `orgResourcePackage`** | `src/qoder/credits.js` | 团队号不再被误判余额 0 | 低 | 【实测】hub #39 |
| **前缀缓存亲和 + 历史字节稳定** | `src/channel-pool.js` 的 sticky + 序列化 | **同时降钱和降延迟**（命中率 95%→8%） | 中 | 【实测】hub #48 |
| **出站 29MB 前置 413** | `src/qoder/chat.js` 发送前 | 挡「大图/长历史反复重试 → 整池熔断」 | 低 | 【实测】 |
| **DeepSeek `reasoning_content` 回填** | `src/qoder/chat.js` | 修 dmodel/dfmodel 偶发多轮失败 | 低 | 【实测】 |
| **`tool_call.id` 缺失补全** | `src/qoder/chat.js` | 防整轮工具失败 | 低 | 【实测】 |
| **错误码/审核拒绝分类** | `src/upstream-errors.js` | 115-122/406/80411/80412；`content_policy_rejected` 重试无用 | 低 | 【文档】 |
| **企业/组织识别** | `src/qoder/session.js` | 团队号走共享额度账 | 低 | 【实测】 |
| **PAT 导入（`pt-`→`jt-/jrt-`）** | `src/qoder/login.js` | SSO 组织下的唯一登录路 | 低 | 【文档】 |
| **导入本机客户端凭证** | `src/qoder/login.js` | 已登录即零交互加号 | 低 | 【文档】 |
| **单号并发/节奏闸门** | `src/channel-pool.js` | 降 10605 与风控画像 | 中 | 【文档】 |
| **时钟偏差检测** | `/health` | 401 从「凭证坏了」区分成「机器时间不对」 | 低 | 【文档】 |
| **兑换码/成就** | `src/qoder/index.js` | 活动自动领 + 解释「为何没活动」 | 低 | 【文档】 |

### 4.1 前缀缓存亲和（重点）

两条独立的要求，缺一不可：

1. **同一会话固定账号**：`src/sticky.js` 已接入 `channel-pool`，直接复用即可。
2. **历史序列化字节恒定**：一条结果一旦被截短，之后每一轮生成的字节必须完全相同——否则上游前缀缓存失效。现有 `chat.buildBody` 每轮重建 `request_id`（这是对的），但要检查历史消息是否有任何「每轮变化」的字段。

---

## 5. 跨通道横向机会

1. **统一媒体层**：`/v1/images/generations`、`/v1/audio/speech`、`/v1/videos`，按通道能力路由。当前只有搭子具备。
2. **统一 usage 归一**：搭子是四条通道里唯一没接 `src/usage-norm.js` 的。
3. **统一错误码字典**：Qoder 115-122、千问 110/112/430、TRAE 3003/4023、搭子信封码收进一张表。
4. **统一计费账本**：TRAE 逐轮账单 + Qoder `billed_rate` + 千问三池 + 搭子余额游标，四套口径并列展示，**不得相加**。
5. **统一会话粘性**：`src/sticky.js` 一张表服务四通道。
6. **统一 `/v1/models` 元数据**：倍率 / 上下文 / 多模态 / 思考档位，四通道目前字段名各不相同。

---

## 6. 落地路线

### P0（低成本高收益）

| # | 项目 | 通道 | 预估 |
|---|---|---|---|
| 1 | 打开搭子 Anthropic 入口的 `nativeTools` | 搭子 | ✅ 已完成 2026-10-31（见 §10） |
| 2 | 搭子接 `usage-norm` | 搭子 | ✅ 已完成 2026-10-31（见 §10） |
| 3 | Qoder Pro 福利包 + 团队共享额度 | Qoder | 小 |
| 4 | Qoder 29MB 前置 413 | Qoder | 小 |
| 5 | Qoder DeepSeek `reasoning_content` 回填 | Qoder | 小 |
| 6 | Qoder `tool_call.id` 补全 | Qoder | 小 |
| 7 | TRAE `get_session_usage` 逐轮账单 | TRAE | 小 |
| 8 | TRAE 额度包过滤 + 签到 `extra_credits` 口径 | TRAE | 小 |

### P1

| # | 项目 | 通道 |
|---|---|---|
| 9 | 媒体层：生图 + TTS（视频后置） | 搭子 |
| 10 | JSON mode（走千帆原生端点） | 搭子 |
| 11 | 千问附件上传 | 千问 |
| 12 | 千问模型元数据复核与接入 | 千问 |
| 13 | TRAE `ide_user_pay_status` + 错误码补全 + 请求体韧性 | TRAE |
| 14 | Qoder 前缀缓存亲和 + 历史字节稳定 | Qoder |
| 15 | 统一错误码字典 | 全部 |

### P2 / P3

| # | 项目 | 通道 |
|---|---|---|
| 16 | TRAE Remote 链路 | TRAE |
| 17 | 千问 ACP 会话（独立通道） | 千问 |
| 18 | 搭子 opencode Agent / MCP connector / 技能广场 | 搭子 |
| 19 | 搭子浏览器 CDP 中继 / IM 桥 / 记忆库 | 搭子 |
| 20 | 千问企业身份 / 区域发现 / 定时任务 | 千问 |

---

## 7. 明确不做

| 项 | 原因 |
|---|---|
| Qoder Quest / Repo Wiki / Bugbot / MCP / browser-use | 翻遍上游端点无对应协议入口，是 IDE 前端功能 |
| 千问隐藏档位 `qwork-auto/advanced/ultimate/lite` | 实测已下线，裸请求 403 |
| 千问语音输入 | 依赖操作系统引擎，无上游端点 |
| TRAE `create_agent_task` 全量复刻 | 200KB body、无公开可用实现 |
| TRAE IDE raw legacy | 个人账号固定 `2001` |
| TRAE 支付类接口 | 非网关职责，且有资金动作 |
| Qoder 逐包剩余额度 | 上游接口 503/404，grants 账本已是唯一解 |
| 搭子 `session_share` / 埋点上报 / 心跳 ACK | 无网关价值 |
| 搭子 `plugin/*` / `skills/square/list`（POST） | 现有网页 cookie 过不了（GET 类可通） |

---

## 8. 复现记录

```text
# 1. 原生 tools（应用链路）
POST https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions
Authorization: Bearer <app token>
{ "model": "glm-5", "tools": [ ... ], "messages": [ ... ] }
→ 200 finish_reason="tool_calls"
       tool_calls[0].function = { name: "get_weather", arguments: "{\"city\": \"北京\"}" }

# 流式同端点：delta.tool_calls 带完整 id/name/arguments，结尾 finish_reason="tool_calls" + [DONE]

# 2. 千帆原生透传
POST https://dumate-svc.baidu.com/gateway/v2/chat/completions
X-Appbuilder-From: openclaw
{ "model": "qwen3.5-35b-a3b", ... }
→ 200（文本 / response_format=json_object / 64x64 红图答「红色」均正常）
→ glm-5.2 / kimi-k3 / model-text 返回 401（只认千帆原生模型）

# 3. 生图
POST /gateway/v2/tools/dumate/image_generate_v3/async
→ 200 { code:"0", task_id:"..." }
GET  同路径 ?task_id=...
→ 200 { status:"success", imageUrls:["https://..."] }

# 4. TTS
POST /gateway/v2/tools/dumate/t2a_v2/sync
→ 200 { base_resp:{status_code:0}, data:{ audio:"https://..." } }

# token 来源：GET https://www.dumate.cn/api/dumate/app/token/get（带网页 cookie）
```

本次实测消耗：1 张 1K 低质图 + 1 条短 TTS + 十余次极小对话请求。

---

## 9. 待复核与风险

1. **千问模型表是否有 `price_factor`**：参照仓库记录为 `flash 0.1 / pro 1 / qwen3.8-max 1.8`，与本项目「千问上游不提供标称倍率」的结论冲突。本次因千问账号 token 缺失无法真机复核，恢复额度后应第一时间验证。
2. **千问附件上传**来自前端 bundle 代码，未真机跑通。
3. **搭子技能广场**的 POST 列表接口需要另一套鉴权（网页 cookie 过不了），GET 类（`connector/*`、`session/*`）实测可通。
4. **搭子原生 tools 的稳定性**：单次实测通过，但上游是否对工具数量、`tool_choice:"required"` 有额外限制未做矩阵测试。
5. **TRAE Remote 链路**的 `region` 与鉴权头尚未在本项目验证，接之前应先跑通一条最小对话。

---

## 10. 落地记录

### 2026-10-31 · P0-1 搭子原生工具调用

**改动**

| 文件 | 内容 |
|---|---|
| `src/server.js` | Anthropic 入口 `nativeTools: !route.target.needsModelMap` → `nativeTools: true`，注释重写 |
| `src/anthropic.js` | 头部两种模式的说明改为「主网关四通道全 native；text 只剩 9084」 |
| `test/verify-anth-tools.js` | 新增「glm-5 同样走 native」用例；文本模式的说明改指 9084 |

**验证（离线）**

```text
node test/verify-anth-tools.js        → 通过 22 项，失败 0 项
node --test test/unit/image-passthrough.test.js test/unit/effort-passthrough.test.js
                                      → 20/20 通过
```

**验证（真机，9082 开发实例，模型 `glm-5`）**

```text
流式  POST /v1/messages
  → content_block_start { type:"tool_use", id:"call_...", name:"get_weather" }
  → content_block_delta { type:"input_json_delta", partial_json:"{\"city\": \"北京\"}" }
  → message_delta { stop_reason:"tool_use" }

非流式 POST /v1/messages
  → { stop_reason:"tool_use",
      content:[ thinking, text, { type:"tool_use", name:"get_weather", input:{city:"北京"} } ] }
```

**未覆盖**

- `src/web-gateway.js`（9084）仍走文本降级：它的 `translateStreamToAnthropic` 只发
  text/thinking 块。要让 9084 也支持工具，得先补 `tool_use` 块与非流式对齐，
  否则流式路径会静默丢工具。
- 桌面凭证链路（`DUMATE_DUMATE_SOURCE=auto`）未单独复测；它与网页链路打同一个
  云端网关，预期一致，接入前建议跑一次同样的请求。

### 2026-10-31 · P0-2 usage 缓存字段的协议出口映射

**问题**：上游一直在报缓存命中（搭子直给 `prompt_tokens_details.cached_tokens`），
但 Anthropic 与 Google 两个出口只搬 `input_tokens`/`output_tokens`，缓存命中在
翻译层被丢掉；而且 OpenAI 的 `prompt_tokens` **含**缓存、Anthropic 的
`input_tokens` **不含**，直接照搬会让 Claude Code 把缓存部分既算进上下文、
又看不到命中。

**改动**

| 文件 | 内容 |
|---|---|
| `src/usage-norm.js` | 新增 `cachedTokensOf(usage)`：认标准位 / DeepSeek / Qwen / Anthropic 四种形状，没有返回 0 |
| `src/anthropic.js` | `openAIToAnthropic` 的 usage：`input_tokens` 减去缓存、补 `cache_read_input_tokens` 与 `cache_creation_input_tokens` |
| `src/google.js` | 非流式与流式都补 `cachedContentTokenCount`（`promptTokenCount` 口径不变，Gemini 里它是总量） |
| `src/server.js` | Anthropic 流式收尾统一走 `usageOut()`，流式与非流式两个出口同一口径 |
| `src/responses.js` | 缓存取值改为委托 `cachedTokensOf`，去掉重复的形状清单 |
| `test/unit/usage-protocol-mapping.test.js` | 新增 10 项：四种上游形状、减法、钳零、Google 字段 |

**验证（离线）**：`node --test test/unit/usage-protocol-mapping.test.js` → 10/10；
全量单测 150/150。

**验证（真机，9082，`glm-5`，同一段长 system 连发两次）**

```text
第 1 次  anthropic  usage { input_tokens: 3017, output_tokens: 122,
                            cache_read_input_tokens: 0 }
第 2 次  anthropic  usage { input_tokens: 201,  output_tokens: 117,
                            cache_read_input_tokens: 2816 }
google               usageMetadata { promptTokenCount: 3017,
                            cachedContentTokenCount: 2816 }
```

201 + 2816 = 3017，与首次的 prompt 完全对上——减法与缓存字段都正确。

**注意**：`src/web-gateway.js`（9084）的 usage 走 `pickUsage`，本次未改。



---

## 附录：参照仓库

| 平台 | 仓库 | 用途 |
|---|---|---|
| Qoder | [shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub) | Qoder 协议逆向的社区权威（含风控与排队文档） |
| Qoder | [EchoPing07/Qoder-2API-Go](https://github.com/EchoPing07/Qoder-2API-Go) | 订阅周期、`user/status` 字段 |
| TRAE | [autumnsentiment/Trae2api-cn](https://github.com/autumnsentiment/Trae2api-cn) | Remote 链路、逐轮账单、错误码 |
| TRAE | [misakano7545/traework2api-panel](https://github.com/misakano7545/traework2api-panel) | 设备绑定、PayStatus、额度包口径 |
| TRAE | bluechonk/trae-credential-reverse-engineering | 端点清单 |
| 千问 | [Buddy2api](https://github.com/wicm84266964/Buddy2api) | COSY 协议与模型枚举 |
| 千问 | [tang-bugu/dsh-connect-qwenwork](https://github.com/tang-bugu/dsh-connect-qwenwork) | ACP 会话逆向 |
| 千问 | [wpy030414/xrp-cosy](https://github.com/wpy030414/xrp-cosy) | 企业身份、模型元数据 |
| 搭子 | [Wang-JQ77/dumate-api](https://github.com/Wang-JQ77/dumate-api) | opencode Agent 会话 API |
| 地图 | [baidu-maps/map-skills](https://github.com/baidu-maps/map-skills) | 地图技能（官方公开） |
