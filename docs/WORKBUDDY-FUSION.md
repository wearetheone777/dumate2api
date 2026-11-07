# WorkBuddy 通道功能融合清单（GitHub 开源项目调研）

> 调研日期：2026-11-07。来源：GitHub 上三个 workbuddy 网关开源项目 + 本项目 `src/workbuddy/` 现状对照。
> 结论先行：**账号池 / 签到 / 连坐保护 / 计费探针 / 模型级冷却 / 会话粘滞** 这些主干本项目已实现且部分更细；
> 真正值得融合的是 **后台自动签到调度、成长任务（积分任务）自动化、取证开关、账号白名单、413 排空** 等，
> 详见分级清单。另有一个重要背景：**workbuddy2api-hub 已于 2026-11-06 宣布停止维护**，对抗性代码要自己养。

---

## 一、调研对象

| 项目 | 定位 | 技术栈 | 活跃度 |
|---|---|---|---|
| [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) | 国际版+国内版+CodeArts 三出口多账号网关中枢，功能最全 | Python（206 套件）+ JS（67 套件） | v2.0.0（2026-11-06），**已宣布停止维护** |
| [hawklithm/workbuddy2api](https://github.com/hawklithm/workbuddy2api) | CodeBuddy 三协议轻量代理（OpenAI/Anthropic/Responses），账号管理精细 | Python（PyPI: workbuddy2api） | 持续更新（2026-10-24） |
| [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) | 多账号网关 + **任务中心全部任务自动完成** + Web 管理面板（账号池可视化/积分任务/配置热更新） | 未知 | 2026-10-21 |

hub 的致谢里还埋着四个上游逆向源头，做成长任务时直接看它们：

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) — 成长任务逆向、设备指纹派生（`derive_id`）、Scheduler、`reasoning_content` 回填
- [L0NE-6/WorkBuddy-Daily](https://github.com/L0NE-6/WorkBuddy-Daily) — 国内版**微信小程序**专属事件指纹与动态专家深链任务
- [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin) — 猫猫日常旅行 + 成长能量开盲盒（Buddy 盲盒）
- [Zhengyuuuui/workbuddy2api](https://github.com/Zhengyuuuui/workbuddy2api) — 国际版 11140 风控识别与冷却规避

---

## 二、本项目（dumate2api）workbuddy 通道现状盘点

融合前先知道自己有什么。以下全部**已实现**，不要重复建设：

| 功能 | 实现位置 | 备注 |
|---|---|---|
| 双区域账号池（cn/global） | `src/workbuddy/auth.js` | 三种导入：客户端认证文件 / 粘贴 token / OAuth 设备授权（`login.js`） |
| 账号 CRUD + 分组 + 出站代理 | `src/admin/routes/workbuddy.js`（M2.1 / M2.4） | 代理经 `normalizeProxyUrl` 校验，配了就不静默回退直连 |
| 模型表（双区域 + credits 倍率） | `src/workbuddy/models.js` | |
| 手动签到（单号/按组/全部） | `/api/admin/workbuddy/checkin` | 国际版明确报 unsupported，不白打 |
| 额度包明细 + 精确合计 + 档位 | `src/workbuddy/billing.js` | `totalPrecise` 精确余额 + tier（24h TTL） |
| FEFO 临期优先选号 | `src/workbuddy/index.js` + `src/expiring.js` | 套餐 `CycleEndTime`，快照跨进程 |
| **风控连坐保护** | `src/workbuddy/index.js`（2026-11-06 融合自 hub #422） | wave 判定 + 区域暂停 + 跨进程快照 + 一键解除；**11140 不换号** |
| 计费自检探针 + 实测单价台账 | `/billing-check` + `rate-ledger.js`（M2.6） | EMA + min/max + 量化分辨率警告——比 hub 原版更细 |
| 模型输出上限探针 | `output-probe.js`（M2.5） | |
| 对话活跃上报（连登） | `src/workbuddy/activity.js`（2026-11-04 融合自 hub） | `chat_request_send` 事件 + keepalive，**必须带 userId** 否则静默丢弃 |
| `developer`→`system` 映射 | `src/workbuddy/chat.js:67` | 上游 400/11128 兼容（hawklithm 同款） |
| 提示词脱敏 | `src/workbuddy/sanitize.js` | 对标 hawklithm `--desensitize` |
| 模型级冷却（6004） | `index.js:451` → `channel-pool.applyModelSoftCooldown` | 账号不动，只冷却模型 |
| 会话粘滞（前缀缓存亲和） | `index.js:398` `sessionKeyOf` → `pickCandidate({sessionKey})` | hub #718 修的就是这个，本项目天然有 |
| 多 API Key：模型白名单 + 通道 + CIDR | `src/keys.js`（`model_allowlist`） | sha256 存储 + 0600 权限 |
| 按 Key 用量透视 | `src/admin/routes/usage.js:238`（`by_key` + `activeKeys`） | |
| 失败分类 402/401/429 | `src/workbuddy/index.js` | hard_credit / session_dead / soft_rate |

---

## 三、可融合功能清单

### P0 — 高价值，建议尽快做

#### 1. 后台自动签到调度器 ⭐ 最直接的缺口

- **来源**：hawklithm（README「每日签到」节）+ hub「自动化福利与签到」。
- **现状差距**：本项目只有手动 `/checkin`，没有任何定时调度。签到是国内版积分的核心来源，忘了签 = 白掉一天积分。
- **融合要点**（hawklithm 的口径，直接照抄设计）：
  - 开关持久化（管理端设置页），默认关；
  - 开启时**立即检查全部账号**，网关启动时也重新检查；
  - 每日北京时间 00:00 检查，**随机等待 0~10 分钟**再执行（错峰防风控）；
  - 签到前先查状态，已签跳过；**未知状态不自动签**（防误判刷请求）；
  - 关闭开关取消等待中的计划。
- **落点**：调度器放**网关进程**（9082，它持有账号刷新权与 `wb.checkin`）；开关状态落 `data/`（管理端 `/settings/save` 同款 JSON 布尔口径，参考 hub `/settings/save` 只收布尔的做法）。管理端加开关 + 各账号当日签到状态展示（hawklithm 账号列表就带当天签到状态）。
- **工作量**：小（1 个调度文件 + 1 个设置项 + 前端开关）。

#### 2. 国内版成长任务 / 积分任务自动化 ⭐ 价值最高、工程量最大

- **来源**：panel 的核心卖点（「自动完成任务中心全部任务」）、hub（「成长任务、加油站签到、猫猫旅行」「连登管家闭环」）。上游逆向细节在致谢的四个项目里（见第一节）。
- **现状差距**：本项目只有**对话活跃上报**（连登一条腿），没有成长任务、加油站、猫猫旅行、开盲盒。这些是免费积分池的主要补给。
- **融合要点**：
  - 先做**成长任务事件上报**（Sliverkiss 的 `derive_id` 设备指纹 + 事件形状）——与 `activity.js` 同构，新增 `wb_tasks` 形态的模块即可，本项目已有成熟的「事件上报 + 打桩测试」模式；
  - 猫猫旅行 / 盲盒（88lin）作为第二阶段——涉及任务状态机，复杂度高；
  - 微信小程序专属事件指纹（L0NE-6）是另一条腿，**无证据不预编**：先抓自己的小程序包验证事件形状，再决定接不接。
- **落点**：新模块 `src/workbuddy/tasks.js`（与 `activity.js` 并排）；管理端任务面板（账号 × 任务完成状态矩阵）；风控口径沿用 `activity.js` 的「每天一次、不多时点高频」。
- **风险**：任务事件指纹是风控最敏感区。hub 都因此进低频维护——调度频次宁少勿多，任务失败如实报，不重试轰炸。
- **工作量**：中到大。第一阶段（任务事件）1~2 天；猫猫/盲盒另计。

#### 3. 自动补积分「只点名缺积分的号」

- **来源**：hub Unreleased（`POST /accounts/credits` 新增 `uids` 列表参数；「每个号每次页面加载最多补一次，不再触发全池逐个刷」）。
- **现状差距**：本项目 `/credits` 每次都是全量账号刷新（每号打签到状态 + 额度 + 档位三个上游），账号一多既慢又容易被风控注意到。
- **融合要点**：路由加 `?uids=` 或 body `uids`；前端积分页只对「额度为 null / 报错」的行点名补刷；配合 P0-1 的调度器顺手刷新（签到时本来就打上游，额度数据一并回来）。
- **落点**：`src/admin/routes/workbuddy.js` 的 `/credits` handler + `web/src/api/workbuddy.ts`。
- **工作量**：小。

### P1 — 有价值，择机做

#### 4. API Key 绑定「账号白名单」维度

- **来源**：hub 多 Key 设计（「账号白名单：可精确限定该 Key 仅允许调度的账号范围」+ 按 Key 用量透视含积分）。
- **现状差距**：`keys.js` 已有 `model_allowlist` + 通道白名单 + CIDR，但**没有账号级白名单**——一把 Key 只能限定「走 workbuddy 通道」，不能限定「只能用某 3 个账号」。
- **融合要点**：`keys.js` 的 key 结构加 `account_allowlist: string[]`（存账号 id，通配符可不做）；网关在通道选号后校验：选中的账号不在名单 → 换下一个候选（复用 `pickCandidate` 的过滤链）或直接 403；`usage.js` 的 `by_key` 透视加账号维度。
- **落点**：`src/keys.js` + `src/workbuddy/index.js` 选号处 + `src/admin/routes/keys.js` 校验 + 前端 Key 编辑表单。
- **工作量**：中。

#### 5. 11-128 / 风控取证开关

- **来源**：hub（`WB_DUMP_11_128`：`1` 只写脱敏摘要、`full` 额外写出站 body，文件落 `usage/11-128-dumps/`；配套 `docs/TROUBLESHOOTING-11-128.md` 的排障纪律——「先收集同一请求的身份、最小请求和提示词对照结果，**不要先轮换账号**」）。
- **为什么现在做**：上游正在收紧非官方客户端识别（hub 10-23 警告 + 停维护），11-128 是 Claude Code 类请求的常见拒绝码。hub 停更后，这个排障能力只能自己养。
- **融合要点**：`chat.js` 出站前埋点；触发条件 = 上游返回 11-128（或做成任意错误码可配）；**默认关**；摘要不含提示词明文，`full` 含明文但要显式开启；落盘走 `filelock.renameAtomic`（项目惯例）。
- **落点**：`src/workbuddy/chat.js` + 环境变量 `DUMATE_WORKBUDDY_DUMP_11_128` + `data/workbuddy-11-128-dumps/`。
- **工作量**：小（半天）。

#### 6. 额度护栏（积分低于阈值提前拦截）

- **来源**：hub 核心特性「额度护栏」（仪表盘）。
- **现状差距**：本项目是**事后**处理——账号积分耗尽 → 上游报错 → `hard_credit` 分类 → 402。每次都白打一个上游请求。
- **融合要点**：`/credits` 已有各账号套餐余额快照；给 `channel-pool` 加一个「额度低于阈值（可配，默认如 1 积分）→ 账号进长冷却（到次日刷新点）」的联动；护栏是**选号过滤**而非请求拦截，额度数据过期不阻塞请求（沿用 FEFO 快照的「陈旧退回普通行为，不报错」口径）。
- **落点**：`src/workbuddy/billing.js`（快照已有）→ `channel-pool` 加过滤条件。
- **工作量**：小~中。

#### 7. 请求体超限 413 先响应再排空

- **来源**：hub #799（「先返回 413，再在有限时间内排空上传，避免连接重置吞掉响应」）+ 上限 `WB_MAX_PAYLOAD_BYTES` 默认 16MB。
- **现状差距**：Qoder 通道有 `assertBodySize`（29MB 前置拒绝，RST 会放大成整池熔断的教训在 CLAUDE.md 里），但 workbuddy 通道链路上没有对齐「413 + 排空」的完整处理——RST 被当瞬态错误换号重放是已知的坑。
- **落点**：`src/workbuddy/chat.js`（前置校验）+ `server.js` 层统一（若已有则只对齐阈值与排空行为）。
- **工作量**：小。

### P2 — 小而美，顺手做

#### 8. 管理端 API Key 配置示例卡

- **来源**：hub #704（设置页可折叠的 Base URL、cURL 与各协议端点示例，一键复制）。
- **落点**：管理端 Key 页加一个可折叠卡。本项目是三协议网关，示例比 hub 还该全（`/v1/chat/completions` / `/v1/responses` / `/v1/messages` 三套）。
- **工作量**：很小（纯前端）。

#### 9. 账号表客户端分页 + 轮询去重

- **来源**：hub Unreleased（每页 50、排序筛选作用于全量再切页、15 秒轮询**数据没变不整表重画**、只在相关页签跑轮询、切回立即拉一次）。
- **现状差距**：本项目账号组件（`web/src/components/workbuddy/WorkBuddyAccounts.vue`）账号一多会有同样的重绘与轮询压力。
- **工作量**：小~中（纯前端）。

#### 10. 启动端口占用检查

- **来源**：hub（`--probe-only`：「端口能连上但一直不答」不再当空闲——Windows `SO_REUSEADDR` 允许重复监听，内核把新连接分给卡死的旧实例，表现为「看板一直是空的」）。
- **落点**：`stable/src/server.js` / `src/server.js` 启动前探 `/health`，占端口时明确报 PID 与退出码 1。对 9080 生产实例尤其有价值。
- **工作量**：小。

#### 11. 连坐暂停参数面板化 + 保存即截断倒计时

- **来源**：hub Unreleased（「风控连坐暂停保护」卡片：实时倒计时、「立即解除暂停」、自定义时长默认 1800 秒、**设 0 彻底关闭**、保存更短时长时**即时截断现有倒计时**）。
- **现状差距**：本项目的四个 `DUMATE_WORKBUDDY_RESTRICTION_*` 都是环境变量，改一次要重启；「立即解除」有了，但改时长没有。
- **融合要点**：`requestClearRestriction` 已有信号文件模式，照抄一个「设置时长」信号文件；网关消费时同步截断 `restrictionHold`。
- **工作量**：小。

### P3 — 大件可选，按需求决定

#### 12. 华为云 CodeArts 第三出口

- **来源**：hub（进程内直连 CodeArts、聊天 SSE 转换、自动签到、`/v1/models?realm=codearts`、模型 ID **精确匹配不别名不回退**、`deepseek-v4.1-flash` 与 `-1017` 是两个独立模型）。
- **判断**：这是「新增一条通道」的工程量（channels.js 五处之一 + 账号体系 + OAuth + 模型目录）。只有你真的需要华为云 CodeArts 的额度时才值得；不做的话知道有这回事即可。

#### 13. workbuddy 通道的生图 / 生视频

- **来源**：hub 媒体模块（`/v1/images/generations`、`/v1/videos` + 异步任务 + 进度轮询 + MP4 下载；commit `feat(media): 接入生图路由：开关、目录端点、派发与记账`）。
- **现状**：本项目已有搭子通道的 `/v1/images/generations` 与 `/v1/videos/generations` 路由骨架（`server.js:2350`）。
- **判断**：若 WorkBuddy 上游确有生图/生视频端点，把现有路由扩展成多通道派发即可；**先抓包验证上游能力，无证据不预编**。

#### 14. 消息压缩（optimize-context）

- **来源**：hawklithm（「智能压缩历史消息，大幅降低 token 使用量，适用于 Codex CLI 等长上下文场景」，`--optimize-context` 开关）。
- **判断**：有价值但与本项目「最小干预透传」哲学冲突——改写了客户端消息语义，出问题极难归因。若做：独立开关、默认关、只压缩命中启发式的超长历史、日志记压缩量。优先级低于 P0/P1。

#### 15. DSML 解析（DeepSeek 标记语言工具调用）

- **来源**：hawklithm（「自动识别和转换 DSML 格式的工具调用」，配套 inline tool calls、residual buffer、ignored regions 等一整套测试）。
- **判断**：CodeBuddy 上游特有形态。本项目 workbuddy 上游是「标准 OpenAI SSE」（`index.js` 头注释），若实际抓到过 DSML 残片才需要；同样「无证据不预编」。做之前先把上游输出的工具调用样本抓下来看。

#### 16. 独立进程监控（静默退出取证）

- **来源**：hawklithm `docs/external-process-monitor.md`（在不重启代理的情况下采集 uv/Python 生命周期、退出码、内存、探活与系统事件；配套 Windows termination-source 证据）。
- **判断**：本机出现过进程崩溃层 0xC0000142 的场景（AGENTS.md 第 11 节），这类取证偶发有用。做一个独立的观察脚本（不侵入网关进程）即可，优先级低。

#### 17. 出站身份头指纹持续对齐

- **来源**：hub `wb_fingerprint.py`（按 5.8.4 抓包对齐出站身份头、补会话头族、**隔离账号级会话标识**，面向 11-128 渠道校验）+ hawklithm `debug_headers.py`（完整 IDE 识别 headers）+ hub `WB_IDENTITY_OS/ARCH/NODE_VERSION`（CLI 身份覆盖 `x-stainless-*`）。
- **判断**：不是一次性功能，是**持续对抗项**。建议：把「身份头对齐」做成 `chatHeaders` 里的一张表 + 环境变量覆盖（对齐 `WB_IDENTITY_*` 三件套的小接口），每次上游收紧时只改表不改逻辑。

---

## 四、不建议融合（已有或不适用）

| hub/hawklithm 功能 | 结论 |
|---|---|
| 多账号池 / 故障转移 / 配额轮转 | 已有（channel-pool） |
| 出口代理槽绑定 | 已有（M2.1 proxy-agent，且更严格：配了不静默回退） |
| 风控连坐保护主体 | 已有（2026-11-06 融合自 hub #422，含一键解除） |
| 会话粘滞（#718） | 已有（sessionKeyOf 亲和） |
| developer→system | 已有 |
| 脱敏 | 已有（sanitize.js） |
| 模型级 429 冷却 | 已有（6004 → applyModelSoftCooldown，口径与 hawklithm 一致：同一账号其他模型不受影响） |
| 每日签到**手动**部分 | 已有（含按组批量，比 hawklithm 全） |
| 计费探针 / 模型倍率透出 | 已有且更细（EMA 台账 + 量化分辨率警告） |
| `reasoning_content` 回填 | 本项目上游是标准 OpenAI 流；Qoder 通道已有 `rememberReasoning` 同款机制，workbuddy 侧按上游实测再定 |
| Anthropic Messages 实验开关 | 不适用——本项目整个网关就是三协议网关，协议转换在 server.js 层统一做 |
| 登录出口代理（OAuth 弹窗选代理槽） | 不适用——本项目登录是设备授权/导入流程，浏览器不在网关侧 |
| 三语言 i18n（简/正體/英） | 单用户场景，低优先 |
| Docker / NAS / OpenWrt 打包 | 与本项目「本机多进程」形态不符 |
| `WB_BACKGROUND_MODEL_TARGET` 后台模型别名改写 | 本项目 `mapModel` 已覆盖别名需求 |

---

## 五、落地注意事项（本项目架构约束）

1. **双进程边界**：网关（9082）持有运行时状态与调度器；管理端（9083）是独立进程，读快照、写信号文件——连坐保护的 `persistRestriction` / `requestClearRestriction` 就是现成范式，所有新功能跨进程交互照抄这个模式，不要发明新通道。
2. **通道注册四处同源**：动 `channels.js` 才加通道；workbuddy 通道内部加功能不碰它。
3. **风控纪律**：所有自动化（签到调度、任务上报、补积分）遵循 `activity.js` 的既有口径——每天一次、随机抖动、未知状态不动作、失败如实报不重试轰炸。hub 都在上游收紧后退场，节奏宁少勿多。
4. **无证据不预编**：成长任务事件、DSML、生图生视频，都先抓包拿到真实形状再写代码；抓不到就先做能做的（P0-1 / P0-3 / P1 全部）。
5. **测试**：每个新模块配 `test/unit/*.test.js` 或 `test/verify-*.js`，外部依赖打桩（`activity.js` 的 `_setRequestImpl` 就是现成的注入点模式）。融合 hub/hawklithm 的功能时，**它们的测试用例本身就是最好的验收标准来源**（hawklithm 的 `test_account_checkin*.py`、`test_rate_limit_proxy.py` 等可以直接翻译成用例清单）。
6. **上游停维护的含义**：hub 2026-11-06 起不再跟上游变化——以后 WorkBuddy 上游改协议（指纹、错误码、任务接口），社区只剩 fork 零散修。本项目融合其功能时把**判据与常量集中放一个文件**（类似 `constants.js` 的 `specOf`），方便上游变化时单点更新。

---

## 附：建议的实施顺序

1. **P0-1 自动签到调度器**（半天~1 天，收益立竿见影）
2. **P0-3 补积分点名刷新**（半天，顺手）
3. **P1-5 11-128 取证开关**（半天，风控收紧期的保险）
4. **P1-7 413 排空** + **P2-10/11**（各半天，都是小改）
5. **P0-2 成长任务自动化**（先跑 Sliverkiss 的逆向资料 + 抓包确认事件形状，再排期）
6. **P1-4 账号白名单 / P1-6 额度护栏**（按使用场景决定）
7. P3 大件（CodeArts / 生图生视频 / 消息压缩）等真实需求出现再评估。
