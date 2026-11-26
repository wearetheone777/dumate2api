# 千问办公通道 · GitHub 调研合并方案

> 调研日期：2026-11-26。目标：把 GitHub 上千问办公（QwenWork）通道相关的社区成果
> 合并进本项目，**企业版内容不合并**。本文件是方案，不是实施记录；实施按 §7 分批推进，
> 每批过 §8 的验证再进下一批。

## 1. 背景与目标

本项目千问办公通道（`src/qwenwork/`，15 个模块约 4450 行）已实现：直连网关
（`chat.js` + wasm 签名）、ACP 会话通道（`acp.js`，2026-10-22 协议实测）、
device flow 登录（`login.js`）、积分归因（`credits.js`）、搜索/图搜/文件/语音、
桥接（`bridge.js`）。但社区仓库在**思考模式、模型档位、冷却策略、上限口径**
四个方向上有实测结论，是当前实现的明确缺口。

目标：把可落地的增量合并进来，每项有来源、有验证、有落点；企业版（`safety`
档位、SSO 多用户体系等）明确排除。

## 2. 调研范围与方法

- GitHub 搜索 API（`qwenwork` / `千问办公` / `qoderwork` 三组关键词，2026-11-26）
- 逐个拉取候选仓库 README + 关键源码（冷却模块、chat 模块、档位映射）
- 与本项目现状逐项对照（`src/qwenwork/` 源码 + `docs/CHANNEL-QWENWORK.md`）

## 3. 仓库清单与筛选结论

### 3.1 直接相关（千问通道本体）

| 仓库 | ★ | 定位 | 筛选结论 |
|---|---|---|---|
| `jianhx189/qwenwork2api` | 7 | 千问专属网关，零依赖 Node，多档位映射 + 看板 | **主源**。档位枚举、冷却、max_tokens、[DONE] 处理均合并 |
| `wicm84266964/Buddy2api` | 152 | 多通道网关（含千问），Python | **参考**。主动限流思路（最小间隔/最大并发/排队）合并；其千问登录路径与本项目一致，无增量 |
| `icebears111/qoderwork2api` | 4 | QoderWork CN 反代（Go），思考模式全模型开启 | **主源**。思考开关（`is_reasoning` + `source`）、reasoning_effort 透传、冷却分级合并 |
| `fengyinxia/qoder2api` | 31 | QoderWork 反代（Python），动态模型表 + PAT | **参考**。动态模型表思路合并（其 PAT 体系是 Qoder 产品，不并入千问通道） |
| `tang-bugu/dsh-connect-qwenwork` | 4 | DSH 连接器，ACP 协议实测（2026-10-22） | **佐证**。协议结论（结束判据、32KB 上限）本项目已实现，仅用于核对，不合并代码 |
| `tianyn1990/qwenwork-magpie` | 2 | Magpie 插件，协议层来源 | **参考**。[DONE] 信封包裹、额度不足转 429 的思路合并 |
| `rossi-nova/byoked-qwenwork` / `zanderzhng/qwenwork-byok` | 4/3 | BYOK 本地桥 | **不合并**。走客户端 worker 修补路线，与本项目直连架构不同，无实测依据支撑 |
| `REALOIYO/dsh-qwenwork-connector` / `AlaIchhe/dsh-qwenwork-connect` / `gaoqiaoliangjie666/dsh-qwen-connect` | 5/2/5 | DSH 连接器（device flow） | **不合并**。登录链路本项目已实现，仅核对 device flow 参数 |

### 3.2 周边（技能/教程/其他产品，不合并）

`ahang1598/doubao-workbuddy-qwenwork-skills`（技能合集）、
`wangxiaoshuai1998/QwenWorkGuide`（教程）、`tangshiyegit/agent-guide`、
`zhikunqingtao/zhikuncode`（独立产品）、`963072676/qoderwork-account-switcher`、
`1837620622/qoderwork-reset-id`（设备 ID 工具）、`SadPull/cpa-plugin`、
`harwinvoid/magpie-plugin-qwenwork`、`MYCF711/magpie-qwenwork-affiliate` 等——
非通道本体，不合并。

## 4. 企业版内容排除说明

明确排除，不进任何合并批次：

1. **`qwenwork-enterprise` 档位**（上游键 `safety`，企业专属）——
   `jianhx189/qwenwork2api` 的 `PUBLIC_MODELS` 里唯一的企业档，不并入本项目的
   模型映射表。企业版账号体系、专属端点一律不碰。
2. **icebears111/qoderwork2api 的多用户体系 / SSO 接入**——那是该仓库的生产改造
   （users.json + nginx SSO 身份头），不属于千问通道协议层，不合并。
3. **任何「企业版专属端点 / 内网部署 / 团队额度」相关内容**——一律不纳入。

## 5. 现状与缺口对照

| 维度 | 本项目现状 | 社区实测结论 | 缺口 |
|---|---|---|---|
| 思考模式 | `is_reasoning` 硬编码 `false`（`chat.js:171,194`），`reasoning_effort` 不透传 | `is_reasoning: true` + `source:"system"` 才下发 `reasoning_content`；`reasoning_effort` 可透传（low/medium/xhigh） | **缺** |
| 模型档位 | 仅 flash / pro / qwen3.8-max-preview 三个（2026-10-31 实测） | 官方 2.1.0 客户端完整枚举 + 2026-11 第三方档位（deepseek-flash、glm-5.3、kimi-k3.1-pro、minimax-m3.1-flash、step-5-preview、qwen4-max 等） | **缺** |
| 冷却 | 无模型级冷却，无「无可用账号」归因 | 「账号 × 模型」冷却（默认 60s），单模型限流不熔断整号；无可用账号四因分开报 | **缺** |
| max_tokens | 千问下限 16384 / 默认 131072（`budget.js`） | 上游硬上限 **32000**，超限夹到 32000，0/负数按 8192 | **口径需改** |
| [DONE] 收尾 | 已处理：上游用 `event:finish` + 统计帧收尾，本地补发 `[DONE]`（`chat.js:323-327`） | [DONE] 可能包在多层信封里；结束后还有耗时统计帧，需保留结束前真实错误 | 加固（可选） |
| 设备登录 | device flow 已实现（PKCE + nonce + machineId，`login.js`） | 与社区一致 | 无 |
| 指纹 | `machineId` 生成与客户端优先逻辑已实现（`auth.js:447`） | 一号一盐一 machineId | 无 |
| ACP 协议 | 结束判据（running 后 idle）、32KB 上限均已实现（`acp.js`） | 与 `tang-bugu` 实测一致 | 无 |

## 6. 可合并内容清单

按「价值 × 风险」排序，每项给出来源、落点、验证方式。

### 6.1 思考模式：`is_reasoning` 可配置 + `reasoning_effort` 透传（P0）

**来源**：`icebears111/qoderwork2api`（思考模式全模型开启，实测结论）
+ `jianhx189/qwenwork2api`（`reasoning_effort` 判定）。

**内容**：
- `chat.js` 的 `modelConfig.is_reasoning` / `model_config.is_reasoning` 从硬编码
  `false` 改为可配置：默认按档位开启（默认 `true`，与 icebears 一致），可用
  `DUMATE_QWENWORK_REASONING=0` 关闭（对齐 `DUMATE_QWENWORK_AGENT_DISCIPLINE`
  的开关风格）。
- 请求体里已有 `model_config.source: 'system'`（`chat.js:201`），与 icebears 的
  「`source` 是思考开关」结论吻合，**保留不动**，只补 `is_reasoning`。
- `reasoning_effort` 透传：`low/medium/high/xhigh` 原样进 `parameters`
  （`'none'/'off'` 视为关闭），非法值忽略。注意当前 CLAUDE.md 记录「搭子对
  `reasoning_effort` 不敏感」是**搭子**的结论，千问通道没有此结论，按社区实测透传。

**落点**：`src/qwenwork/chat.js`（`buildBody` / `modelConfig`）、`src/qwenwork/constants.js`
（新增环境变量）。
**验证**：离线单测（body 形状断言）+ 真机一轮（确认 `reasoning_content` 增量下发、
正文不丢）。**风险**：思考模式会消耗更多积分与时间，默认开启前先在真机对照一轮
开/关的积分消耗差异，再定默认值。

### 6.2 模型档位映射表补全（P0）

**来源**：`jianhx189/qwenwork2api` 的 `PUBLIC_MODELS`（2026-11 实测修正版）。

**内容**：把千问模型表从 3 个扩为完整枚举。**只收已实测可用的键**，被套餐挡的键
（`standard` / `premium` / `qwork-lite` / `qmodel_latest` / `dmodel_latest` /
`gmodel_latest`）**不写进映射**（写了会在无权限账号上吃 403）：

| 对外模型名 | 上游档位 | 说明 |
|---|---|---|
| `flash` | `flash` | 保留现有 |
| `pro` | `pro` | 保留现有 |
| `qwen3.8-max-preview` | `qwen3.8-max-preview` | 保留现有 |
| `qwen3.8-max` | `qwen3.8-max-preview` | `qmodel_latest` 被套餐挡，用预览档承接 |
| `qwen3.8max` / `qwen3.8` | `qwork-advanced` | 兼容旧调用（实测 200） |
| `qwen3.6-plus` | `q35model_preview` | 套餐不含回 403 |
| `deepseek-flash` | `deepseek-flash` | 别名三连（`deepseek-v4.1-flash` / `deepseek-v4-flash` / `deepseek-flash`） |
| `deepseek-v4-pro` | `deepseek-v4-pro` | |
| `glm-5.3` / `glm-5.3-flash` | 同名 | 2026-11-18 客户端新增 |
| `kimi-k3.1-pro` | 同名 | 2026-11-18 新增 |
| `minimax-m3.1-flash` | 同名 | 2026-11-18 新增 |
| `step-5-preview` | 同名 | 2026-11-18 新增 |
| `qwen4-max` / `qwen4-max-preview` | `qwen4-max` | 上游没有 `qwen4-max-preview` 键，落到 `qwen4-max` |
| `qwenwork-lite` / `qwenwork-standard` / `qwenwork-advanced` / `qwenwork-ultimate` | `lite` / `flash` / `pro` / `flagship` | 官方标签（经济/标准/高级/旗舰） |

**落点**：`src/qwenwork/constants.js`（模型表）+ `data/model-map.json` 的千问别名
（若走模型名映射）+ `/v1/models` 暴露清单。
**验证**：离线单测（映射表形状）+ 真机逐档位打一条（记录每个档位在当前套餐下
是否放行，403 的如实标注「套餐不含」而不是报错）。**纪律**：`qwenwork-enterprise`
（`safety`）不写进表。

### 6.3 模型级冷却与选号归因（P0）

**来源**：`jianhx189/qwenwork2api` 的 `lib/cooldown.mjs`（2026-11-19 抽模块，
两次线上故障的直接教训）。

**内容**：
- **「账号 × 模型」冷却表**（内存态，进程重启即清空）：上游对该模型回 429 时
  只冷却该账号的该模型（默认 60s，`DUMATE_QWENWORK_MODEL_COOLDOWN_MS` 可覆盖），
  **不把整号标成 `quota_exhausted`**。这是防雪崩的核心：单模型限流不该熔断整个账号。
- **选号过滤**：`pickAccount` 按模型过滤冷却中的账号；优先没试过的号，都试过允许
  同号重试；该模型全部账号冷却 → 如实返回「限流，N 秒后重试」。
- **「没有可用账号」归因**：账号不存在 / 全在冷却 / 额度用尽 / 全停用 四种原因
  分开报，不压成一句「请先在后台授权」（当前文案会把排查带偏）。
- 冷却概况（几个号在冷却、等多久）可带进错误响应，客户端能看到恢复时间。

**落点**：新增 `src/qwenwork/cooldown.js`（纯函数，无副作用，可单测）；
`chat.js` / 选号处接线；错误文案归因。
**验证**：离线单测（冷却记账、选号过滤、归因四态）+ 真机制造一次 429 观察冷却
生效且同号其他档位不受影响。

### 6.4 max_tokens 上限口径（P1，先核实再改）

**来源**：`jianhx189/qwenwork2api`（上游硬上限 32000，实测）。

**内容**：千问通道的 max_tokens 口径改为：
- 上游硬上限 **32000**：请求超过则夹到 32000，**不直接 400**（直接 400 会让上游
  分流器判定失败并换线）。
- 0 / 负数 / 缺失 → 用默认值（建议 8192，与 qwenwork2api 一致；与本项目
  `DUMATE_QWENWORK_DEFAULT_MAX_TOKENS` 的关系需对齐，避免两套默认值打架）。
- 当前 `budget.js` 的千问下限 16384 / 默认 131072 与 32000 硬上限冲突，**必须
  先核实**：131072 是否真被上游接受（qwenwork2api 实测 32000 是 chat 链路的
  硬上限，本项目走的是同一条 `agent_chat_generation` 链路，大概率同口径）。
  核实方式：真机打一条 `max_tokens=131072` 的请求看上游回什么；若 400/502 则
  按 32000 改，若正常则保留并记录差异原因。

**落点**：`src/budget.js`（千问档）+ `src/qwenwork/chat.js`（body 构造）。
**验证**：离线单测（夹取口径）+ 真机边界（32000 通过 / 超限夹取不报错）。
**纪律**：改前先跑 `npm test` 与 `npm run verify`，预算改动影响所有协议入口。

### 6.5 [DONE] 信封包裹与完整性检查（P2，加固）

**来源**：`jianhx189/qwenwork2api` 的 `decodeFrame`（多层剥壳）+
`tianyn1990/qwenwork-magpie`（beta.2：识别结束标记 + 保留结束前真实错误）。

**内容**：当前 `chat.js` 已处理「上游用 `event:finish` + 统计帧收尾、本地补发
`[DONE]`」（`chat.js:323-327`），与 magpie 的发现一致。加固点：
- 剥壳循环（最多 6 层 `body`）里识别字符串形态的 `[DONE]`（当前只识别裸
  `[DONE]`，若上游把 `[DONE]` 包在信封里会漏判）。
- 结束前若已有真实错误，优先保留错误而不是被统计帧覆盖。

**落点**：`src/qwenwork/chat.js` 的 `postStream` 帧解析。
**验证**：离线单测（构造信封包裹的 `[DONE]` 帧）。**风险**：低，纯解析加固。

### 6.6 动态模型表（P2，可选）

**来源**：`fengyinxia/qoder2api`（600s 缓存动态拉取）+ `icebears111/qoderwork2api`
（每小时拉 `/v3`，失败回退静态表）。

**内容**：千问模型表改为「静态表为底 + 定期拉取上游 `/api/v2/model/list`
（或 `/v3`）合并」，拉取失败保留旧表不覆盖。当前 `constants.js` 的静态表是
兜底，动态表只做增量合并（新档位加进来，不删静态表里的键）。

**落点**：`src/qwenwork/constants.js` + 新增缓存逻辑（对齐
`DUMATE_TRAEWORK_MODELS_CACHE_MS` 的既有模式）。
**验证**：离线单测（缓存 TTL、失败回退）。**风险**：中——动态表可能带来
未经实测的键，只做「合并增量」不做「替换」，且动态键默认不进 `/v1/models`
暴露清单（避免把没验证的档位推给客户端）。

### 6.7 额度不足转 429（P2，可选）

**来源**：`tianyn1990/qwenwork-magpie`（尚未输出模型内容时，把可识别的额度
不足错误转成 HTTP 429，供路由层选择下一路）。

**内容**：千问通道在**一个内容块都没发出**时，把额度不足类错误（上游 403
`Model is not available for this user` / 积分耗尽）转成 429 并带可重试语义；
已开始输出则按正常收尾（协议上收不回）。与搭子通道的既有处置对齐。

**落点**：`src/qwenwork/chat.js` + 翻译层错误映射。
**验证**：离线单测（未输出→429 / 已输出→正常收尾两态）。

### 6.8 每日积分接口（不合并，仅佐证）

`jianhx189/qwenwork2api` 实测：`/api/v1/adapter/user/daily-credit-notice/claim`
只存在于 daily 栈，prod 主栈（`gateway.qwenwork.cn`）没有该路由，prod token 在
daily 栈是 `INVALID_TOKEN`。**与本项目 2026-11-01 删除每日额度体系的决定一致**，
佐证现有结论正确，不合并、不翻出来重做。

## 7. 合并实施计划

按「先核实、后落地、每批验证」推进：

| 批次 | 内容 | 关键动作 | 验证 |
|---|---|---|---|
| **P0-核实** | max_tokens 硬上限 | 真机打 `max_tokens=131072` 观察上游响应；记录结论 | 实机日志 + 埋点 |
| **P0-1** | 6.2 模型档位映射表 | 扩 `constants.js` 模型表 + 模型映射 + 暴露清单；剔除被套餐挡的键 | 离线单测 + 真机逐档位 |
| **P0-2** | 6.3 模型级冷却 | 新增 `cooldown.js` 纯函数 + 选号接线 + 归因四态 | 离线单测 + 429 真机 |
| **P1-1** | 6.1 思考模式 | `is_reasoning` 可配置 + `reasoning_effort` 透传；先对照开/关积分消耗再定默认 | 离线单测 + 真机对照 |
| **P1-2** | 6.4 max_tokens 口径 | 按 P0-核实 结论改 `budget.js` 千问档 + body 夹取 | 离线单测 + 边界真机 |
| **P2-1** | 6.5 [DONE] 加固 | 剥壳循环识别信封内 `[DONE]` + 错误保留 | 离线单测 |
| **P2-2** | 6.6 / 6.7 可选项 | 动态模型表（增量合并）、额度不足转 429 | 离线单测 |

每批完成后跑 `npm test` + `npm run verify`，涉及预算/翻译层的批次加跑
`npm run test:smoke`（需起网关）。

## 8. 验证计划

1. **离线**：每批的纯函数单测（冷却记账、选号过滤、档位映射、夹取口径、
   帧解析）进 `test/unit/`，沿用「断言形状而非字面值」原则。
2. **真机**：逐档位打一条最小请求，记录放行/403；制造一次 429 观察冷却；
   思考模式开/关各一轮对照积分消耗。
3. **回归**：`npm test`（全量单测）+ `npm run verify`（离线脚本集）+
   涉及协议入口的批次跑 smoke。

## 9. 纪律（别试清单）

- **企业版不碰**：`safety` 档位、企业账号体系、SSO/多用户改造一律不合并。
- **被套餐挡的键不进映射表**：`standard` / `premium` / `qwork-lite` /
  `qmodel_latest` / `dmodel_latest` / `gmodel_latest`——写了在无权限账号上吃 403。
- **每日积分不翻出来重做**：prod 主栈无该路由，已有实测佐证。
- **`reasoning_effort` 敏感的是搭子不是千问**：别把搭子的结论套到千问。
- **max_tokens 改前先核实**：32000 是 qwenwork2api 的 chat 链路实测，与本项目
  同链路但仍需真机确认，不凭单一来源直接改预算。
- **动态模型表只合并增量**：动态键不进 `/v1/models` 暴露清单。

## 10. 实施记录

### P0-1 模型档位映射表补全 ✅（2026-11-27）

**改动**：`src/qwenwork/constants.js` 的 `FALLBACK_MODELS` / `MODEL_ALIASES`。

- `FALLBACK_MODELS`：3 档 → 9 档（pro / flash / qwen3.8-max-preview / lite /
  flagship / deepseek-flash / deepseek-v4-pro / glm-5.3 / glm-5.3-flash）。
  **只收本项目或社区实测可用的键**。
- `MODEL_ALIASES`：补全 2026-11 社区实测的对外名 → 上游键映射。
- 被套餐挡的六键（`standard` / `premium` / `qwork-lite` / `qmodel_latest` /
  `dmodel_latest` / `gmodel_latest`）与企档（`safety`）**均未入表**，
  由 `test/unit/qwen-model-tiers.test.js`（6 项）锁死。
- 第三方档位（kimi / minimax / step / qwen4）没在本项目实测过，只进
  `MODEL_ALIASES`（显式请求才透传），不进兜底表、不进 `/v1/models`。

**离线验证**：`npm test` 1422 项全绿（原 1416 + 新增 6）；`npm run verify`
50 项全绿。

**真机逐档位**（网关 9080，`qwen/<key>` 每档一条最小请求）：

| 档位 | 结果 | 档位 | 结果 |
|---|---|---|---|
| pro / flash / qwen3.8-max-preview | 200 | deepseek-flash / deepseek-v4-pro | 200 |
| lite / flagship | 200 | glm-5.3 / glm-5.3-flash | 200 |
| kimi-k3.1-pro | 200（自称 Kimi） | minimax-m3.1-flash / step-5-preview | 200 |
| qwen4-max | 200（回答风格不同） | | |

别名映射真机验证：`qwen3.8-max`→预览档、`qwenwork-standard`→flash、
`qwenwork-ultimate`→flagship、`deepseek-v4.1-flash`→deepseek-flash 全部 200，
且落到的档位回答身份与直连该档一致——**证明是真实分流，不是静默回落**。

### P0-2 模型级冷却归因 ✅（2026-11-27）

**机制已在池层**：`src/pool.js` 的 `model_cooldowns` / `applyModelSoftCooldown`
（5min 基数、指数退避、2h 封顶）/ `applyModelBlock`（模型负缓存 6h 起、命中翻倍、
24h 封顶），与 `src/channel-pool.js` 的 `pickCandidate(opts.model)` 选号过滤、
`availability()` 逐账号归因——**比社区仓库的 60s 默认更精细，不回退调优**。

**本次补的是归因层**（原缺口）：`send()` 在「无可用账号」时压成一句笼统文案，
现改为四态分开报 + 冷却概况。

- 新增 `src/qwenwork/cooldown.js`（纯函数 `attributeNoAccount`）：把
  `availability()` 的逐账号原因压成四态——账号不存在 / 全停用 / 额度用尽（硬冷却）
  / 全在冷却（软/模型级）/ 在途满/间隔 / 保底。软冷却回 429（客户端自动退避），
  其余回 503。
- `src/qwenwork/index.js` 的 `send()`：初始无账号与重试耗尽两处接归因；
  重试耗尽时把 `noAccountDetails` / `retryAfterMs` 挂到最终错误上。

**离线验证**：`test/unit/qwen-cooldown.test.js`（10 项，四态 + 冷却概况 + 容错）；
`npm test` 1432 项全绿、`npm run verify` 50 项全绿。

**真机**：网关重启后正常请求 HTTP 200 无回归。429 冷却真机触发属池层既有机制
（已有单测覆盖），归因层由离线单测锁定。

### P1-1 思考模式 ✅（2026-11-27）

**改动**：
- `src/qwenwork/constants.js`：新增 `REASONING_ON`（`DUMATE_QWENWORK_REASONING`，
  默认开，设 `0` 关闭）。
- `src/qwenwork/chat.js`：`modelConfig.is_reasoning` 与 `model_config.is_reasoning`
  从硬编码 `false` 改为读 `constants.REASONING_ON`（两处同步）；`reasoning_effort`
  透传：`low/medium/high/xhigh` 进 `parameters`，`none/off` 不注入，非法值忽略。
  翻译层（anthropic.js / responses.js）已把三协议入口的 `reasoning_effort`
  归一化进 OpenAI 体，直连通道直接读到。

**真机对照**（同一推理题，`qwen/pro` + `reasoning_effort:medium`）：

| 状态 | reasoning tokens | completion | total | 耗时 |
|---|---|---|---|---|
| 开（默认） | 510 | 754 | 806 | 11.4s |
| 关（`DUMATE_QWENWORK_REASONING=0`） | 243 | 547 | 599 | 12.1s |

**关键发现**：`is_reasoning: false` 时上游**仍返回 reasoning_content**（243
tokens）——该标志是**思考深度控制**而非二进制开关，开启约多 33% token。
质量收益真实，按方案默认开，`DUMATE_QWENWORK_REASONING=0` 可关。

**离线验证**：`test/unit/qwen-reasoning.test.js`（6 项，env 开关 + 透传四态）；
`npm test` 1438 项全绿、`npm run verify` 50 项全绿。

### P1-2 max_tokens 口径 ✅ 无需改动（2026-11-27）

**P0-核实 已真机确认**：打 `max_tokens=32000 / 131072 / 200000 / 500000` 全部
HTTP 200——**上游没有 32000 硬上限**。qwenwork2api 的 32000 是它自己的夹取策略，
不是上游约束。本项目 `budget.js` 的千问下限 16384 / 默认 131072 **保留不动**，
不照搬社区口径（避免把上游能接受的请求人为夹小）。此条为「核实后不改」。

### P2-1 [DONE] 信封加固 ✅（2026-11-27）

**改动**：`src/qwenwork/chat.js` 的 `unwrap`。

- **多层剥壳**（最多 6 层 `body`）：旧实现只剥一层，多层信封里的真实 payload
  会被丢（中间信封原样返回，上层 `JSON.parse` 后找不到 `choices`）。
- **任意层识别 [DONE]**：旧实现把信封内的 `[DONE]` 静默丢弃（返回 `[]`），
  表现为流不结束、上层 `doneSeen` 永不置位。现在任何一层出现字符串形态的
  `[DONE]` 都透传为结束标记。
- **错误保留已由 `firstErr` 覆盖**（`index.js` 流式回调）：错误帧后所有帧被吞，
  最后统一抛出，统计帧不会覆盖真实错误——方案 #2 无需另改。

**离线验证**：`test/unit/qwen-done-hardening.test.js`（10 项，裸/1~6 层信封
[DONE]、多层 payload 剥壳、深度上限、空壳、非 JSON）；`npm test` 1448 项全绿、
`npm run verify` 50 项全绿。

**真机**：流式请求 31 数据帧 + `[DONE]` 正常收尾，内容正确，无回归。

### P2-2 动态模型表 + 额度不足转 429 ✅（2026-11-27）

**6.6 动态模型表——已实现，刻意不按方案改**：

`src/qwenwork/index.js` 的 `fetchModelList` 早已实现动态拉取（`/api/v2/model/list`，
60s 缓存，签名覆盖模型表自身路径，拉取失败保留旧表不覆盖）。**当前行为优于
方案建议**：暴露的是**上游权威清单**（该账号实际可用的档位），而非只暴露静态表。
方案的「动态键不入 /v1/models」会把上游已开放但静态表没收录的档位藏起来，
反而不准确。故不做「增量合并 + 限制暴露」的改动，记录为刻意偏离。

**6.7 额度不足转 429——已实现**：

- `src/qwenwork/index.js`：新增 `isQuotaOrModel(code, message)`——认 402（积分
  耗尽）与 403+模型不可用文案（对齐 `upstream-errors.js` 的 MODEL_TEXT 口径）。
- `send()` 最终错误处理新增分支：全部错误都是额度/模型类、且一个内容块都没
  发出时（否则早在 `if (e.sent) throw e` 抛了），回 **429** 带可重试语义，
  而不是 402/403——客户端对后两者按硬失败处理（只报一次、不退避），而额度/
  模型条件是换号/换模型/等重置能解的。带 `retryAfterMs`（池的恢复时刻）。

**离线验证**：`test/unit/qwen-quota-429.test.js`（6 项，分类口径）；
`test/verify-qwen-repair.js` 第 8 节断言更新（402 → 429，反映 P2-2 刻意分类）；
`npm test` 1454 项全绿、`npm run verify` 50 项全绿。

**真机**：非流式 + 流式请求均 HTTP 200 无回归。

---

## 合并完成总览

| 批次 | 内容 | 状态 |
|---|---|---|
| P0-核实 | max_tokens 硬上限 | ✅ 真机确认无 32000 上限，不改 |
| P0-1 | 6.2 模型档位映射表 | ✅ 扩表 + 单测 + 真机 13 档全 200 |
| P0-2 | 6.3 模型级冷却归因 | ✅ 池层已有机制，补归因四态 + 冷却概况 |
| P1-1 | 6.1 思考模式 | ✅ is_reasoning 可配 + reasoning_effort 透传 + 真机对照 |
| P1-2 | 6.4 max_tokens 口径 | ✅ 核实后不改 |
| P2-1 | 6.5 [DONE] 信封加固 | ✅ 多层剥壳 + 任意层识别 [DONE] |
| P2-2 | 6.6 / 6.7 | ✅ 6.6 已实现不另改；6.7 额度/模型错误转 429 |

全部离线验证（`npm test` 1454 项 + `npm run verify` 50 项）通过，真机无回归。
企业版内容（`safety` 档位 / SSO / 多用户）全程未碰。






