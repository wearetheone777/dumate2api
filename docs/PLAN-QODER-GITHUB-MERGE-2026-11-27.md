# Qoder 通道 GitHub 生态融合方案（2026-11-27 完整版）

> 范围：**只看个人账号可用的功能**。企业版 / 团队 VPC / 专属域 / 组织共享池的内容一律不纳入（详见第五节）。
> 检索通道：`github.com` 与 `api.github.com` 可直连；`raw.githubusercontent.com` 在本环境 SSL 失败，`WebFetch` 对 github.com 报域校验失败。**可用解法**：`curl https://api.github.com/repos/<repo>/contents/<path>` 取 JSON 的 `content`（base64），解码后即文件原文。本轮已用该通道拉取并逐条核对下列原文：
> - `shuishuipingan/qoder2api-hub`：README + `CHANGELOG.md`（2388 行）+ docs `accounts/api/clients/configuration/models/risk-control-and-queueing/risk-control-playbook/troubleshooting/internals/official-web-tools.md`
> - `Zhengyuuuui/qoder2api`：README（1447 行，含 11-19 模型清单更新全文）
> - `whyfail/AI-Toolkit`：docs/credits-proxy.md（196 行）
> - `24001/qodercli2api`：README（460 行）
> 对照基准：dumate2api `develop`，端口 9080/9081，`src/qoder/` + `src/admin/routes/qoder*.js` + `web/src/views/QoderRuntimeView.vue`。
> 上一版：`docs/QODER-GATEWAY-FEATURE-MERGE.md`（11-07 检索快照，保留不删）；11-27 首版 `docs/PLAN-QODER-GITHUB-MERGE-2026-11-27.md` 由本文取代。

---

## 一、本轮最高价值发现

### 1. 身份句守卫（受控 A/B 实证，本项目完全没有）

来源：hub v1.10.3 合并 PR #168 + `docs/risk-control-and-queueing.md` §7（2026-11-23 受控实验）。

**实测结论**：部分第三方 Agent 的 system 文本里出现字面子串 `You are ZCode,` / `You are Claude Code,` / `You are Codex,` / `powered by DeepSeekRuntime.` 时，Qoder 上游回 `10605 / queueType:p1 / queueCount:0 / retryAfterSeconds:30 / serviceAvailable:false`——**这是伪装成排队的硬拒绝，等待不会放行**（单请求可拖到 184s 后 502）。同账号、同出口 IP、同模型、同时间的官方客户端与不含特征句的请求正常。

单变量对照排除了出口 IP、账号、机器身份头、cosy-clientip、工具定义、模型。触发条件极窄：品牌名大写开头 + 紧跟逗号/句号，逗号/句号前多一个空格就不命中；大小写变化不命中；裸品牌词不命中；user 消息里的品牌词在样本内不命中。

**对策**：Hub 用通用正则做**字符级最小中和**——只在命中片段的标点前插一个空格（`You are ZCode,` → `You are ZCode ,`），品牌名与语义不变；自家品牌 `Qoder` 豁免以保住官方前缀逐字节一致；处理范围覆盖 system + 全部历史消息文本 part + reasoning_content；天然幂等。默认关闭（`QD_IDENTITY_GUARD=1` 或面板开关）。实测开启后 ZCode / DSH / Claude Code / Codex / 未知品牌经 OpenAI 与 Anthropic 两入口均秒过；缓存命中率实测 99.7%~99.8%，自家品牌豁免使普通请求首轮即命中、前缀零扰动。

**本项目现状**：`src/workbuddy/sanitize.js` 做的是 WorkBuddy 的**整句中性化**（7 种动词 + 指纹清洗），不能被 Qoder 直接复用——整句替换会改变语义且破坏本项目 `sessionKeyOf` 的前缀缓存亲和。`test/probe-qoder-raw.js:28` 的探针 system 正是 `You are Codex, a coding agent.`，说明这个形态在真实调用里存在。

### 2. 模型目录 11-19 变更（本项目兜底表仍是旧名单）

来源：Zhengyuuuui README 11-19 实拉（CN 13 / Global 14）。

| 变化 | 详情 |
|---|---|
| 新增 `gmodel_latest` = GLM-5.4 | 倍率 0.8，三档上下文；Global |
| `qmodel_latest` 显示名 → Qwen4-Max | 原 Qwen4-Max-Preview，key 不变 |
| 倍率变动 | `qmodel_latest` 0.1→0.4；`auto` 0.5→0.3；`efficient` 0.3→0.1 |
| 下线（两区都不再下发） | `smodel` / `cmodel` / `fast` / `qmodel` / `q37fmodel` / `gm51model` |
| 替换做法 | 显示名别名表改为**运行时注册**：每次成功拉 `/algo/api/v2/model/list` 就把 `display_name → key`（含归一化形式）注册进内存；静态表只作「还没拉到清单」时的种子 |

第三方给的删除理由是：失效 key 让客户端选中上游不认识的模型，请求走兜底返回但**不计 quota**，用户只看到「没用量/一直排队」，比少一个选项更难排查。这一点对本项目同样成立。

### 3. hub 最近版本的其他关键行为

- v1.10.4 #174：**签到反馈显示本轮新增积分总额与逐账号结果，零积分不显示领取成功**；上游明确回报 0 时不按活动标称奖励虚增。
- v1.9.13 #167：**未明确标注已领取的 HTTP 409 与通用 `BLOCKED` 不算已签到**；活动未开放 / 风控限制 / 风控服务异常不误报「新人任务未完成」；已明确拒绝的活动不改走旧接口再领。
- `accounts.md`：`SAME_PERSON_ALREADY_CLAIMED` 的账号 **6 小时内不再重复尝试**；兑换码类活动完成任务后自动领取、当天名额发完次日 10:00 后重试（本项目不做兑换码，只取 6h 跳过）。
- `accounts.md` 调度：每天 09:00/21:00 签到+刷额度、22:00 集中刷 Token、每次巡检提前刷剩余不足 4h 的 Token；暂停状态持久化且启动巡检也尊重暂停。
- `models.md`：模型来源四级降级（官方动态接口 → 7 天磁盘缓存 → 本机客户端目录缓存 → 仓库快照）；官方标 `enable=false` 的模型**也列出来**并附 `disabled_reason`；`/v1/models` 的 `catalog_source` 告诉用户当前用哪份；官方没提供的字段（如最大输出）不填。
- `api.md` `/diag/queue`：**实际发一次上游探测**，消费完整 SSE（含 HTTP 200 流内错误信封），只代表本次账号/端点/模型；`queue_type` 只接受 p0~p9，未公开定义不映射风险等级；`reason` 恒 `unknown`，不冒充根因。`queue_observation` 在 `/health` 公开聚合、读不触发上游。
- v1.10.0 #163：成功用量带 `requested_model` / `resolved_model` / `upstream_model_key`，上游未回报则实际身份为 null；明确的 `Cannot find model` 不重放、不换号、不冷却（与本项目 `code 115` 不换号口径一致）。
- v1.9.9 #157：上游不同工具 ID 复用同一 index 时规范化独立槽位，保留名称与完整参数。

### 4. AI-Toolkit 补充的接口契约

- `GET /v1/models` 的 `context_window` / `max_output_tokens`：**只返回所有可用账号都明确声明的正数容量，取最小值；任一账号缺失就省略**。推理字段 `supports_reasoning` / `reasoning_effort_options` / `default_reasoning_effort` 同样「一致才返回，缺失或不同即视为未知」。
- 倍率取自 `price_factor`，限时优惠显示优惠倍率并列出基准/时段/来源；目录没给就显示「倍率未知」，不按 1× 计费。
- 请求记录：失败时记 HTTP 状态、失败阶段、上游业务错误码、上游请求 ID；只取短标识，不存原文/凭证；流已开始后的错误保持终止事件，不自动重试。
- Messages 的 `tool_result.content` 内图片转 `image_url`，保留调用 ID 与错误标记；Qoder 原生形状带 `model_config.is_vl`。

---

## 二、旧清单落地状态（不重复造轮子）

| 旧编号 | 功能 | 本项目落点 |
|---|---|---|
| P0-1 | 自动签到排程 | `src/qoder/autocheckin.js` + `QoderRuntimeView` |
| P0-2 | 签到归属只读核验 | `session.verifyClaim` + `grants.classifyVerification`（三态，未知不猜） |
| P0-3 | 运行期配置热生效 | `src/qoder/runtime.js` |
| P0-5 | 智能体一键配置 | `src/agent-setup.js`（Claude Code / Codex 直写 + diff 预览） |
| P1-6 | 并发闸门 + 选号策略 | `channel-pool` 的 inflight/minInterval/pickStrategy |
| P1-8 | 轮转探活 + 余额写池 | `balance-refresh.js` `collectQoder` |
| P1-9 | PAT 凭证 | `session.importPat` + `/pat-import` |
| P1-10 | 订阅周期口径 | `src/qoder/period.js` |
| P1-11 | `/health` 风控遥测 | `src/qoder/telemetry.js` |
| P2-15/16/22/23 | 测试台 / 日志筛选 / CORS / 加号热加载 | 既有功能覆盖 |
| P2-17 | 用量分析页 | `/api/admin/qoder/usage` + 积分页卡片 |
| P2-18 | 积分到期分布 | `grants.distribution` + `PointsView` |
| P2-19 | 模型锁池视图 | `src/qoder/model-locks.js` + `QoderRuntimeView` |
| P2-20 | 输出上限主动探测 | `src/qoder/output-probe.js`（真机判定 Qoder 不看 `max_tokens`） |
| P2-21 | 管理端安全加固 | 已核对齐备 |
| P2-24（部分） | 重复 `/v1` 提示 404 / VL 前置校验 | `duplicated-v1-hint` + `src/qoder/vl-guard.js` |

本项目**强于生态**的点：本地 COSY 签名免客户端/免 SDK、每轮重签防 103 去重、三计时器、FEFO 零上游调用、批次推算剩余、SAME_PERSON 归属核验、模型锁池双时刻、`output-probe` unbounded 判据、账本原子追加。

---

## 三、推荐融合清单

### P0 — 正确性与用户可见（优先做）

#### P0-1 出站身份句守卫（Qoder 专属，最高优先级）

- **缺口**：本项目 Qoder 通道完全没有这道处理；`test/probe-qoder-raw.js` 的探针 system 就是触发形态。表现为「排队很久后 502」，用户和运维都会误判为上游容量问题。
- **做法**：新增 `src/qoder/identity-guard.js`——通用正则 `You are <品牌名>,` 与 `powered by <品牌名>.`，品牌名 `[A-Z][A-Za-z0-9]*(?:[ -][A-Z0-9][A-Za-z0-9]*)*`，**只在标点前插一个空格**；`Qoder` 自家品牌豁免；纵覆盖 messages 全文 part + reasoning_content（若有回传）；幂等。挂点在 `qoder/index.js` 的 `send()` 里、**会话键派生之后 / `buildBody` 之前**（会话键反映客户端原文，逐轮稳定；升级开启守卫不会把粘性键抖到新值）；沿用 `src/prompt-guard.js` 的「默认关闭 + 显式开关」纪律，新增 `DUMATE_QODER_IDENTITY_GUARD=1` 与面板开关（写 `qoder-runtime.json`，热生效）。
- **验证**：`test/unit/qoder-identity-guard.test.js`（11 项：A/B 两形态命中、逗号/句号前空格不命中、小写不命中、裸词不命中、自家品牌豁免、幂等、system+历史全覆盖、粘性键与 `buildBody` 会话稳定性）。真机验证列入合入前置：用 `test/probe-qoder-raw.js` 的 system 打一次，开/关各一次对照。**已完成（离线）**；真机对照待用户授权。
- **红线**：不做语义改写（不换品牌名、不删句）；不复用 `workbuddy/sanitize.js` 的整句替换；不开默认。

#### P0-2 模型兜底清单治理 + 运行时别名注册

- **缺口**：`src/qoder/constants.js` 的 `FALLBACK_MODELS` / `CHEAP_MODELS` 含 `qmodel`/`q37fmodel`/`gm51model`；`MODEL_ALIASES` 把 `qwen-plus`→`qmodel`；`test/verify-qoder-channel.js:187` 写死 CHEAP_MODELS 精确数组。`session.fetchModels` 已读 `isNew`/`rateOriginal`/`promotion`，但不读 `enable`/`disabled_reason`，模型页与 `/v1/models` 无法区分「官方禁用」与「我们没拉到」。
- **做法**：
  1. `constants.js`：`FALLBACK_MODELS` 每项附静态元数据，下线候选标 `retiredCandidate: true`（**不删条目**——第三方清单不是本项目真机证据）；`CHEAP_MODELS` 去掉候选；静态别名保留兼容但降为种子。
  2. `session.fetchModels`：把 `display_name` 注册进运行时别名表（`chat.resolveModelKey` 优先查它，精确→归一化，歧义不猜），并把 `enable=false` + `disabled_reason` 带进行；**倍率只读 `price_factor`**，不写死第三方数值。
  3. `admin/routes/qoder.js` `/models` 与 `qoder/index.js` `listModelEntries`：回 `catalogSource`（upstream / cache / fallback）与 `status`（active / disabled / retired_candidate）；禁用模型**也列出**并带原因；`/v1/models` 不列被标 retired 的兜底条目。
  4. `ModelsView.vue`：禁用/候选行灰 tag + 说明「官方可能已下线，先用聊天测试台验证」。
  5. 目录来源四级降级照 hub 落地：动态接口 → 7 天内磁盘缓存 → 本机客户端目录缓存 → 仓库快照；任一级成功就写 `catalogSource`，**不静默回落**。
- **验证**：`test/unit/qoder-model-catalog.test.js`（别名动态注册、归一化歧义、禁用原因、四级降级、倍率不被静态覆盖）；把 `verify-qoder-channel.js:187` 改为形状断言。

#### P0-3 `/v1/models` 补能力元数据（一致才返回）

- **缺口**：`listModelEntries()` 只给 `id`/`name`/`contextWindow`；`session.fetchModels` 已有 `reasoningEfforts`/`reasoningDefault`/`isReasoning`/`multimodal`/`maxInputTokens`，数据在但出口没接。
- **做法**：出口附加 `supports_reasoning` / `reasoning_effort_options` / `default_reasoning_effort` / `multimodal` / `maxOutputTokens`；跨账号合并时**任一账号缺失或声明不一致就省略整个字段**（不填 false/null），与 AI-Toolkit 同口径；`contextWindow` 继续给最大档（与 `chat.buildBody` 下发的 `maxInputTokens` 一致）。
- **验证**：`test/unit/qoder-model-metadata.test.js`（8~10 项：合并一致性、缺失省略、来源标记、旧客户端不受影响）。

#### P0-4 Anthropic `tool_result` 内图片保真

- **缺口**：`src/anthropic.js` 把 `tool_result` 交 `toolResultText()` 压成文本，`block.content` 里的 image 块丢失。Qoder 12/12 模型真机 `is_vl=true`，工具截图是真丢数据。
- **做法**：把 `tool_result.content` 的 image 块提取为 `image_url` part，作为**独立 user 消息紧跟对应 role:'tool' 消息**（不假设上游接受 tool 消息带 parts 数组）；`tool_call_id` 与 `is_error` 保留；复用 `toImageUrlPart`，不写第二份。
- **验证**：`test/unit/anthropic-tool-result-image.test.js`（图文混排、多调用 ID 不错位、无图行为不变）；真机回传验证作为合入前置。

#### P0-5 签到反馈三态修正（避免「零积分显示领取成功」）

- **缺口**：`checkinAndSave` 以 `(r.claimed||[]).some(x=>x.ok)` 判「领到了」；hub #174/#167 表明上游可能明确回报 0，也可能用 409 / 通用 `BLOCKED` 表达「没领到」，这些都不该记成已领。
- **做法**：`session.checkin` 的结果对象补 `gained`（**实际返回的正数**）与 `outcome`（`claimed` / `already` / `none_available` / `exhausted` / `same_person` / `blocked` / `error`）；409 与通用 BLOCKED 只在有明确「已领」证据时才映射 `already`；`gained <= 0` 一律不写 `lastCheckin`、不写签到账本的 claim 行；面板显示本轮新增总额 + 逐账号结果。
- **验证**：扩展 `test/unit/qoder-autocheckin.test.js` + 新增 `test/unit/qoder-checkin-result.test.js`（零额、409、BLOCKED、同人、未知五态）。

### P1 — 稳定性与治理（默认关闭或只告警）

#### P1-1 后台 Token 提前续期 + 状态可见

- **来源**：hub 调度（提前刷 <4h）+ Zhengyuuuui「Token 自动续期（15 天）」。
- **缺口**：`session.ensureAccount` 是请求时按需刷新；`auth.needsRefresh()` 已有但只在请求链路调用。
- **做法**：挂在现有 `balance-refresh` 轮转探针（不新开定时器）：对 `expiresAt`/`refreshExpiresAt` 在 24h 内且 `needsRefresh()` 为真的账号执行 `session.exchange` → `authStore.patch`；沿用 filelock（refresh token 轮换）；失败不写 `lastError`、不惩罚账号，只记日志与告警。管理端账号表加「Token 续期」列（年龄、状态、失败原因、下次续期）；沿用 `needsRefresh` 的 skew 常量，不引入新的 12/15 天硬编码。`DUMATE_QODER_TOKEN_PREREFRESH=1` 才开。
- **验证**：`test/unit/qoder-token-refresh.test.js`（到期窗、轮换写盘、失败不污染、默认关）。

#### P1-2 账号权重 + 低积分阈值降级口径

- **来源**：hub「事实性限额护栏」+ EchoPing07 权重。
- **现状**：`pickStrategy=least-inflight` 已做；`pool.creditFloor` + `floorBlockedFor()` 已有且 Qoder 已写池（P1-8），阈值排除其实可用。缺的是权重与「全号都低于阈值」时的处理。
- **做法**：`qoder-runtime.js` 增 `concurrency.weights` 与 `concurrency.creditFloor`（**新字段改 `defaults()`/`FIELDS`/`Load()` 三处**，见 TRAE 踩坑）；FEFO 仍优先；全部低于阈值时**照常用最低的那个并打 WARN**，不说成「没有账号」。
- **验证**：扩展 `test/unit/qoder-pick-strategy.test.js` + `qoder-runtime.test.js` 的「Load() 覆盖全部 FIELDS」断言。

#### P1-3 请求诊断字段：业务码 / 请求 ID / 失败阶段

- **来源**：AI-Toolkit 的失败日志契约 + hub #163 模型身份审计。
- **缺口**：`attempts.js` 只记 `account/outcome/reason`（reason 截 120 字），Qoder 信封码只在错误文本里；`mapped_model` 有，但没有「上游实际身份」。
- **做法**：`frameThrown`/`bizFrameError` 抛错带 `upstreamCode`/`upstreamRequestId`（取不到留空）；
  尝试链每条带 `stage`（auth / throttle / quota / network / model / http，**我们**判定的失败阶段，
  与上游给的码分开）；成功响应记 **`upstream_fingerprint`**（`system_fingerprint`）——
  **不是** `resolved_model`：`x-model-key` 是我们发出去的请求头、上游不回显，
  响应里的 `model` 恒为 `"auto"`，唯一能区分真实后端的就是指纹（实测 dmodel → a307abda…）。
  指纹是哈希，不冒充模型名；拿不到如实留空。`ReqLogsView` 详情加指纹一行、尝试链加阶段/码/请求 ID。
  **不记报文正文/凭证**。
- **验证**：`test/unit/qoder-error-diagnostics.test.js`（有/无信封、截断、与 `verify-qoder-error-surface.js` 不冲突）。

#### P1-4 同人拒绝 6h 跳过 + 跨号轮转

- **来源**：hub accounts.md + 本项目 P0-2 核验情报。
- **缺口**：核验三态已落地，但自动签到仍按列表顺序；被判 `same_person` 的号次日仍可能先签再被拒。
- **做法**：`autocheckin.js` 候选排序读 `grants` 最近 `verification`：`same_person` 号按 hub 的 6h 窗口跳过（窗口从上次被拒时刻算，不是自然日）；`unverified` 保持原位不猜，轮转时把「最久没真正领到」的号提前；核验失败不改变签到结论。
- **验证**：扩展 `test/unit/qoder-autocheckin.test.js`（三态排序、6h 边界、跨日重置）。

#### P1-5 排队观察（只读聚合，不做主动探测）

- **来源**：hub `/diag/queue` + `/health.queue_observation`。
- **缺口**：`telemetry.js` 已有 rolling 计数与 `waitOnly()`，但 `/health` 只给聚合，面板看不到「哪个账号/模型在排队」，且有人会想加主动探测。
- **做法**：`telemetry.js` 增按 `(area, account, model)` 隔离的有界观察（24h TTL、进程内、读不触发上游），`/health` 公开脱敏聚合；`queueType` 只接受 p0~p9，其余 `unknown`；`reason` 恒 unknown，不冒充根因；**不做 `/diag/queue` 式主动探测**（烧额度且只代表一次），需要时由用户显式手动发一次探针。
- **验证**：`test/unit/qoder-telemetry.test.js` 扩展（按作用域隔离、TTL、并发记账、成功只清匹配项）。

#### P1-6 Qoder 专属风控告警（观测先行）

- **缺口**：`src/admin/alerts.js` 七类规则没有 Qoder 的 `rejected` 信号。
- **做法**：增 `qoder_rejected`：回看窗内 `channels.qoder.telemetry.rejected >= N`（默认 3）且无任何 `ok` → warn；**只告警，不换号、不熔断、不暂停整区**（没有 Qoder 侧连坐证据，照搬 WorkBuddy 会误杀）。复用静默窗/迟滞/通知。
- **验证**：新建 `test/unit/admin-alerts.test.js`（阈值、样本不足、有成功不告警、恢复迟滞）。

### P2 — 管理端呈现

- **P2-1 凭证健康卡**：`QoderRuntimeView` 展示 `refreshExpiresAt`/`hasRefresh`/`source`(pat/device)/最近换票结果；`null` 显示「未知」不显示 0；不新增上游调用。
- **P2-2 聊天测试台接入片段 Tab**：复用 `src/agent-setup.js` 的 `codexSnippet`/`buildClaudeEnv`（同一份，不写第二套），只读展示，写入仍走智能体配置页。
- **P2-3 请求日志保留策略**：`reqlog.js` 32MB 轮转之外加 days/maxLines（env + 面板），只清归档 `.1`，不碰在写文件。

---

## 四、落地批次与验收

| 批次 | 内容 | 前置条件 |
|---|---|---|
| 第一批 | P0-1 ~ P0-5 | P0-1 / P0-4 各需一次真机对照（用户授权后做单点验证）；其余纯离线 |
| 第二批 | P1-1 ~ P1-6 | 默认关闭或只告警，不改变既有流量行为 |
| 第三批 | P2-1 ~ P2-3 | 纯前端/配置 |

**验证纪律**：每项配离线测试（`node --test test/unit/qoder-*.test.js` + `node test/verify-qoder-*.js`），`npm run verify` 全绿；全量偶发失败先单跑复核；改后端重启进程、改前端才 `npm run build`；不提交（用户未授权）。

**2026-11-27 落地状态**：P0-1 ~ P0-5、P1-1 ~ P1-6、P2-1 ~ P2-3 **全部完成**并通过离线回归
（`npm test` 1589 项、`npm run verify` 51 项、`cd web && npm run build` 全绿）。

P0-2（模型目录治理）按方案原话「**不删条目**」落地——此前记的「阻塞于没有真机账号」
只对「判断哪些模型真的下线」成立，而方案本来就不要求判断：第三方 11-19 清单里声称
下线的 3 个条目（`qmodel` / `q37fmodel` / `gm51model`）在 `src/qoder/qoder-catalog.snapshot.json`
里标 `retiredCandidate: true` 并带原因，**条目保留**、`/v1/models` 默认不列、管理端
灰显「疑似下线」，显式调用仍原样透传由上游裁决。四级降级（upstream → 7 天磁盘缓存 →
本机客户端缓存 → 仓库快照）每级都带 `catalogSource`，界面能看出「模型少了」是第几级兜底。
运行时别名注册（display_name → key，歧义不猜）已接在 `session.fetchModels` 成功路径上。

复核补记（2026-11-27 第二轮）：逐条对照方案时发现三处「模块写好但接线没接」，
本轮补齐并加回归：`fallbackLowestFloor` 从未被 `pickCandidate` 调用（P1-2 第三条
不变量「全部低于保底时按余额最高者继续」实际不生效）；尝试链缺 `stage`；
埋点缺上游指纹。P1-3 原写的 `resolved_model` 改为 `upstream_fingerprint`（理由见上）。

真机待验证（需用户授权 / Qoder 账号，不影响离线交付）：
- P0-1 身份句守卫的 A/B 对照（`test/probe-qoder-raw.js`）
- P0-4 `tool_result` 内图片保真的真机确认

**2026-11-28 真机批次（用户授权，账号从 CreditDaddy 导入）**

导入：`qoder` 4 个（cn×2 / global×2）、`traework` 5 个（cn×2 / intl×3）、
`workbuddy` 2 个（cn）、`dumate` 2 个（网页 cookie），全部走项目自带的
`src/account-transfer.js`（白名单 + upsert + 原子写 + 0600），无自建落盘逻辑。

探活结论（只读，不消耗额度）：

| 通道 | 结果 |
|---|---|
| Qoder cn ×2 | `fetchUserInfo` + `fetchQuota` 全部 ok；推理请求此刻全部撞 `p4` 真排队 |
| Qoder global ×2 | 同上（其中一个账号全部模型 `enable=false`，属上游账号状态） |
| TRAE cn ×2 | 模型表 57 / 54 条；`traework-login.js chat` 端到端出字（glm-5.3-flash） |
| TRAE intl ×3 | **凭证已失效**：三个账号 `refresh token is invalid`（HTTP 401 / code 20101），`soloHeaders`/`ugHeaders`/国际字段组合三种头都 401——源数据侧就废了，重新登录才能用 |
| WorkBuddy cn ×2 | `status` ready；流式对话端到端出字（auto → glm-5.3-flash） |
| DuMate ×2 | `api.userInfo` 两个 cookie 都有效（BDUSS 在） |

**P0-2 真机复核完成**（本轮最有价值的产出）：四个 Qoder 账号（cn 两 + global 两）
的模型表**都不含** `qmodel` / `q37fmodel` / `gm51model` —— 第三方清单的「声称下线」
升级为**真机确证**，快照里三个条目改带真机依据的 `retiredCandidate` 并保留条目。
同批发现快照**漏登记 7 个上游真实存在的 key**（`ultimate` / `efficient` / `smodel` /
`cmodel` / `gmodel_latest` / `jmodel` / `mmodel`），已补齐；`mmodel`（0.1 档）
进便宜档推荐。查这条时还揪出一个真 bug：`MODEL_ALIASES['qwen-plus'] = 'qmodel'`
指向已下线 key，改指 `qmodel_38max`。三条都由 `test/unit/qoder-model-catalog.test.js`
新增用例钉死（17 项）。

**P0-1 身份句守卫 A/B 仍未完成**：上游此刻对 gfmodel 持续回 `p4` 真排队
（`serviceAvailable:true`、`queueCount:1`），带/不带守卫两组**都拿到同一个排队信封**，
无法分辨差异。排队掩盖了守卫本要验证的 `p1` / `serviceAvailable:false` 硬拒绝形态。
**不能据此宣称验证通过**，等上游空闲时再跑。

后续（同日更晚）：排队一度放行，Qoder 端到端跑通（`gfmodel` 真实回答「收到」，
`usage.credits=0.010023024`，耗时 252s，绝大部分是排队）。放行后用
`DUMATE_QODER_IDENTITY_GUARD=0` 与 `=1` 各打一次带 `You are Codex, a coding agent.`
的 system——**两组都是 `served`**。这只能说明「守卫开着不坏且上游此刻不拦」，
**仍不构成 A/B 结论**：探针走的是 `chat.buildBody`，没经过 `guardBody`，
且上游当前根本不回 `p1`。验证前提（上游对身份句回 `p1`）此刻不存在，
**不宣称通过**，待上游收紧时用真实链路（`server.js` → `qoder.send`）重跑。

**排队形态辨析（本轮实测）**：真排队 = `queueType:p4` + `queueCount:1` +
`serviceAvailable:true`；identity-guard 记录的伪装硬拒绝 = `queueType:p1` +
`queueCount:0` + `serviceAvailable:false`。两者都是 HTTP 403 + 10605 + RESOURCE_LIMIT，
**只看错误码分不开**，必须解到最内层信封看这四个字段。

**本轮顺手落地（从真机证据直接长出来的）**：`model-locks.js` 新增 `queueKindOf()`，
把这两态分成 `real` / `hard` / `''`（不猜），`aggregateLocks` 的每行带 `queueKind`
（只在 `kind==='queue'` 时给，其它锁恒空——不给错处置提示）。管理端锁池视图
（`#/qoder-runtime`）据此打「真排队」/「硬拒绝」标签。单测
`test/unit/qoder-model-locks.test.js` 新增 2 项（现 13 项）钉死判别。
**另一个反直觉的实测**：四个账号跨 3 个模型同时 `p4`，而额度全部健康
（1574/1697/299/0 credits）——`p4` 不是额度耗尽的降级，是上游真实负载。
判断额度问题要看 `fetchQuota(accessToken, region)`（传 account 对象会 401，我今天踩了）。

**P0-4 `tool_result` 内图片保真——真机确认完成（2026-11-28）**。
绕过排队走 **TRAE cn** 通道（`glm-5.3-flash`，非流式被上游回空，流式正常）：

1. 翻译层：`anthropicToOpenAI` 把 tool_result 内的 base64 PNG 转成独立 user
   `image_url` 消息（5 条消息，2 处 image_url 出现——1 个 part + 1 次 JSON 键名匹配）
2. 上游回答：**「红色」**
3. 上游推理链原文：`The image shows a solid red color.`

第 3 条是关键证据——**模型确实看到了那张 64×64 纯红 PNG 的像素**，不是靠 prompt
文本猜的。P0-4 从「离线单测覆盖」升级为「真机确认」。

附带发现一个 TRAE 侧的真实缺口——**2026-11-28 已修**（用户「修掉吧」）。
`src/traework/index.js` 的 `ensureFresh` 换票失败时原来直接 `throw e`，**不换下一个账号**。
本轮实测：导入了过期账号 `最好的权威157`（`expiresAt` 已过、`refreshToken`
报 `10101 refresh token is not matched`），池选中它后整个请求直接失败，
而健康账号 `测飞的企鹅150` 就在旁边。

修复分两段（合在 `runSendOnce` 的选号层）：

1. **换票失败 → 换号**：判据 `isRefreshRejected`（只认上游原文措辞，认不出不猜）区分
   「凭证彻底废了」与「网络抖」；前者标 `refreshRetiredAt` 让后续请求不再白撞换票端点，
   两者都换下一个号（最多 3 轮）。
2. **401 → 先刷新同账号再试一次**：`needsRefresh` 只看 `expiresAt`，而**上游的 401 才是真相**
   ——intl 三号 `expiresAt` 还有 11 天但 refresh 早已失效。`forceRefresh` 绕过 24h 提前量；
   刷新被拒才退场换号。已吐内容后的 401 不重试。

真机验证（intl 三号，20101 全是 dead refresh）：

```
picked:wearetheone777 → error:session_dead:401 → skip:refresh_on_401
→ error:refresh_rejected（401 后刷新被拒，换号）→ picked:githubfan452 → …（三号各一轮）
```

修复前同一场景：第一个号 401 即整请求失败、不标退场、下次重来。
另发现 `refreshRetiredAt` 的语义边界：它只表示「换不了票」，access 未过期时照样能用
（实测 `expiresIn=0d` 的坏号仍成功出网一次）；但 access 一过期就必须在选号阶段直接判废，
否则每次轮到它都白撞一个 401。
离线验证：`test/unit/trae-refresh-failover.test.js`（6 项）+
`test/unit/trae-401-refresh-retry.test.js`（3 项），`npm test` 1606/1606、
`npm run verify` 51/51 全绿。

---

## 五、明确不融合

| 项 | 来源 | 理由 |
|---|---|---|
| **企业版 / 团队 VPC / 专属域 / 组织共享池 / 账号级多实例** | hub v1.9.6/v1.9.7 + accounts.md「团队与企业账号」 | 用户明确要求忽略；本项目个人账号场景用不到 |
| 注册机 / 邮箱 OTP / CAPTCHA 工具包 | Zhengyuuuui `qoder-register-kit`、qoder-farm | 超出网关职责；源码自身声明不提供绕过验证的成品工具 |
| 官方 SDK 包装（33MB worker） | qoder-proxy | 本项目纯本地 COSY 签名已免客户端/免 SDK，引入是退化 |
| i18n JSON 体系 | hub v1.10.4 | 管理端面向本机中文用户，16 文件 2398 行纯 UI 成本 |
| 硬编码模型倍率 / 显示名表 | 第三方清单快照 | 官方 11-18 刚调价、11-19 刚下线；倍率唯一来源是上游 `price_factor` |
| 钉死 CLI v1.1.34 基线 | qodercli2api | 官方 CLI 已到 1.1.95；本项目不包装 CLI |
| 主动排队探测 `/diag/queue` | hub api.md | 烧额度且只代表一次；本项目已有只读遥测，P1-5 只做观察 |
| `code 115` 改额度码 + 换号 | D3-vin（旧清单） | 本项目真机定案是 400 + 不换号，由 `verify-qoder-error-surface.js` 锁定 |
| Anthropic 桥 system 原位改 user | hub | 上游对 system 位置有硬约束；缓存命中已由 `sessionKeyOf` 亲和解决 |
| 移除请求体上限 / Redis 镜像 / 参数 verbatim 透传 | 多个生态项目 | 沿用旧清单依据（30MB SLB RST 会把整池打冷；账本必须持久化；非法档静默回落要本地归一化） |
| 在 Free 账号上找订阅周期字段 | EchoPing07 | 真机实测 Free 无周期，`period.js` 已覆盖付费场景 |
| 自动暂停整区的风控连坐 | WorkBuddy 11140 | Qoder 无同等强度证据；按 P1-6 先观测 |

---

## 六、参考链接（本轮已通过 API 原文核实）

- [shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub) · CHANGELOG v1.10.4/v1.10.3/v1.9.13 · [排队与风控笔记](https://github.com/shuishuipingan/qoder2api-hub/blob/main/docs/risk-control-and-queueing.md) · [账号与签到](https://github.com/shuishuipingan/qoder2api-hub/blob/main/docs/accounts.md) · [模型](https://github.com/shuishuipingan/qoder2api-hub/blob/main/docs/models.md) · [接口](https://github.com/shuishuipingan/qoder2api-hub/blob/main/docs/api.md) · [配置](https://github.com/shuishuipingan/qoder2api-hub/blob/main/docs/configuration.md)
- [Zhengyuuuui/qoder2api](https://github.com/Zhengyuuuui/qoder2api)（11-19 模型清单 / Token 自动续期 / 签到）
- [whyfail/AI-Toolkit credits-proxy](https://github.com/whyfail/AI-Toolkit/blob/main/docs/credits-proxy.md)（模型能力字段一致性、错误诊断、工具图片）
- [24001/qodercli2api](https://github.com/24001/qodercli2api)（三协议 / 工具 ID 槽位 / CLI 基线对照）
- [Qoder 官方模型下线通知](https://docs.qoder.com/zh/release-notes/model-retirement-notice) · [倍率调整](https://docs.qoder.com/zh/release-notes/model-tier-credit-multiplier-reduction)
- 本仓：`docs/QODER-GATEWAY-FEATURE-MERGE.md`（11-07 快照）· `docs/CHANNEL-QODER.md`（实测定案）
