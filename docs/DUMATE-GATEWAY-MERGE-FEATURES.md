# 搭子（DuMate）通道网关与管理端 — 可融合功能调研

> 生成时间：2026-11-07。检索来源：GitHub（检索词：百度搭子 / dumate / dumate2api / qoder2api / trae2api / workbuddy 面板 / 多账号签到看板），
> 共 9 个同类生态项目——其中搭子专属仅 1 个，其余为同类 web2api 网关与多账号面板。
> 对比基线：本仓库搭子双链路（客户端 8980 / 网页凭证 9084）、`src/web-pool.js`、`src/admin/routes/dumate.js`（8 个端点）、
> `src/admin/routes/accounts.js`、`src/modelmap.js` 与 CLAUDE.md 已沉淀的结论。
> 每条只列**本仓库尚不具备**的功能；与同日生成的 `TRAE-GATEWAY-MERGE-FEATURES.md` 重叠的通用管理端项只在文末交叉引用，不重复展开。

---

## 一、检索到的项目

| 项目 | 语言 | Stars | 定位 | 与本项目的相关度 |
|---|---|---|---|---|
| [Wang-JQ77/dumate-api](https://github.com/Wang-JQ77/dumate-api) | Python | — | **搭子专属**：积分余额 + AI 执行能力暴露为 OpenAI / Claude 双协议本地 API（`/api/points/balance`、`dumate-lite/turbo/ultra/points` 四模型名） | ★★★ |
| [shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub) | Python | 459 | 本项目已大量参考的社区权威；本文只取此前未吸收的「智能体一键配置」 | ★★★（管理端） |
| [xu20060420fan-cell/workbuddy2api-trae-qoder-minimax-panel](https://github.com/xu20060420fan-cell/workbuddy2api-trae-qoder-minimax-panel) | Go | — | 九视图合集面板：请求来源 IP/UA、到期分布、输出上限实测、余额后台刷新 | ★★（管理端） |
| [shuishuipingan/trae2api-hub](https://github.com/shuishuipingan/trae2api-hub) | Python | — | 双区多账号网关 + 8 页签看板；本文取其「仅 App」模型状态与模型库元数据 | ★★ |
| [smart-open/TraeWorkAssistant](https://github.com/smart-open/TraeWorkAssistant) | Tauri/Rust | — | 桌面工作台：四池调度、慢请求竞速对冲、`ck_` 子 Key、到期日历 | ★★ |
| [NextAgentX/qoder-trae-workbuddy-switch](https://github.com/NextAgentX/qoder-trae-workbuddy-switch) | Rust/Tauri | 325 | Buddy Switch：账号分组、多作用域、随机抖动排程、会话副本同步 | ★（交互参考） |
| [JeffHu0912/trae2api](https://github.com/JeffHu0912/trae2api) | Go | 56 | Web 登录闭环（本地回调端口自动换 Token 热加载）、Token 预刷新 | ★ |
| [techysy/CreditDaddy](https://github.com/techysy/CreditDaddy) | Node | — | 10 平台积分领取 + 额度总览 / 网页会话额度卡 | ★（看板参考） |
| [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) | — | — | WorkBuddy 国际国内多账号反代 | ★（同类对照） |

> 注：`wearetheone777/dumate2api` 是本仓库自身的 GitHub 站点，不列入对比。
> 搭子生态在 GitHub 上明显比 TRAE / Qoder / WorkBuddy 薄——**签到、抽奖、成长任务这类「保号自动化」没有任何第三方实现**，
> 本仓库的 `accounts.js`（签到 / 抽奖 / 领奖）与 `checkin.js`（签到账本）已经领先生态，这部分没有可抄的。

---

## 二、本项目搭子通道现状基线（对比用，已具备的能力）

- 双链路：客户端通道（8980，`upstream-launcher.js` 无 GUI 拉起）+ 网页凭证通道（9084 `src/web-gateway.js` + `src/web-pool.js` 多账号轮询换号，`probe:true` 观测动作不伤号）
- 档位编码在模型名（`dm-auto-model/text.L0` 等，router 显式认领、全名透传）；`mapModel` 别名兜底 + **Claude 系按通道分档映射**（`modelmap.js:173-208`：搭子 sonnet→L0 / opus→L1 / haiku→model-text）
- `qianfan-raw` 千帆原生透传（唯一支持 `response_format` 的端点）
- FEFO 临期选号（`data/expiring-snapshot.json`，搭子窗口 30 天，网页池数字 id 映射）
- 计费自检探针 `GET /api/admin/dumate/billing-check`（网页余额差值口径，billed 落 7 天缓存）
- 网页账号管理（`accounts.js`）：登录链接 + **受控浏览器登录闭环（自动抓 cookie、轮询落库）** + 手动粘贴三条入口；签到 / 登录奖励 / 抽奖 / 领奖 / 积分曲线（from/to）
- 管理端只读端点：`/sessions` `/sessions/:id` `/projects` `/connectors` `/connectors/templates` `/local-files`（路径锚定会话目录）+ `/skills`（明确 unsupported）
- 管理端视图：Dashboard / Keys（含 Key 级日配额 `keyQuota`）/ Usage / Points / ReqLogs（已记来源 IP + UA）/ Models / ChatLab / WebAccounts
- 网关层：限流 429 分类、账号/模型级冷却、SSE ping 保活、usage 缓存归一、稳定 session_id 前缀缓存亲和、max_tokens 上限自学习

---

## 三、可融合功能清单

### P0 — 高价值、与现有架构直接咬合

#### 1. ✅ 已落地 2026-11-07：点数余额透出到网关侧：只读端点 + `dumate-points` 伪模型
- **来源**：[dumate-api](https://github.com/Wang-JQ77/dumate-api)（`GET /api/points/balance` + `dumate-points`「查积分不消耗积分」专用模型名）
- **机制**：把「本 Key 还能跑多少」变成 Agent 自己可查的接口——伪模型 `dumate-points` 在网关层拦截（不打上游、零消耗），把余额/今日消耗包装成 chat 响应返回；Codex / Claude Code 会话里模型自己就能报quota。
- **本仓库差距**：管理端 Points / 余额曲线齐全，但都在 9083 管理端进程里；网关侧（Agent 可达面）没有余额读数。全仓 grep `dumate-points` / `points/balance` 无命中。
- **融合落点**：`src/server.js` 的 `needsModelMap` 分支加伪模型拦截（搭子通道唯一适合做伪模型的位置，其他通道别开）；余额读数复用 `web.api.quotaOverview`（accounts.js 同源）。鉴权沿用 `keys.js`——注意这是**网关**端点，不能照搬管理端会话鉴权。

#### 2. ✅ 已落地 2026-11-07（后端）、2026-11-08（AgentSetupView 前端）：智能体一键配置向导（多客户端写入 + 还原）
- **来源**：[qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub)「看板智能体配置覆盖 31 个热门客户端 / Harness，13 类支持自动配置与还原」（Claude Code、Codex CLI、OpenCode、DSH、Crush、Aider、Continue、Pi、Factory Droid、GitHub Copilot CLI、OpenHands CLI、Kilo CLI、Mistral Vibe）
- **机制**：检测本机已装客户端 → 生成/写入 base_url + API Key + 模型名 → **写前自动备份原配置** → 面板一键还原；API 示例只用 `YOUR_API_KEY` 占位。
- **本仓库差距**：`ccswitch.js` 已能生成 cc-switch 配置（haikuModel/sonnetModel/opusModel 三档注入，:372-374），但只覆盖 cc-switch 一个客户端；Claude Code 的 `settings.json`、Codex 的 `config.toml`、Aider / Continue 等没有写入器。全仓 grep `agent-setup` 无命中。
- **融合落点**：把 `ccswitch.js` 升级为 `agent-setup.js`（保留 cc-switch 出口，按客户端拆 writer）；每个 writer 三件套：`detect()`（读现有配置判断是否已配）→ `apply()`（备份 + 写入）→ `restore()`（从备份还原）。管理端 System 页或独立「接入」视图。**搭子通道是首批默认档位**（现有 `modelmap` 分档直接可引用）。

#### 3. ✅ 已落地 2026-11-07（jsonMode/multimodal/links 字段层）：模型双通道可用性标注（「仅客户端」/「仅网页」/「仅千帆」）
- **来源**：[trae2api-hub](https://github.com/shuishuipingan/trae2api-hub) 1.1.5「官方客户端可用、但网关 raw_chat 未接入的模型标为『仅 App』，不再误显示为『不可用』」
- **机制**：同一模型在不同链路的可用性不同，界面要按**链路**给状态，而不是笼统的「可用/不可用」；不可用的写明原因（套餐/链路未接），不伪装成风控。
- **本仓库差距**：搭子的模型能力天然分裂在三条链路——8980 客户端链路、9084 网页凭证链路、`qianfan-raw`（唯一支持 `response_format`/JSON mode）——但模型页与 `/v1/models` 不区分「这条链路能不能跑」。全仓 grep `webOnly` / `clientOnly` / 模型级 `availability` 无命中。
- **融合落点**：`model-info.js` 的搭子行加 `links: { client: bool, web: bool, qianfan: bool }`（数据源：router 认领规则 + ChatLab 实测缓存）；`ModelsView.vue` 搭子卡加三枚链路徽标；`/v1/models` 的搭子条目透出该字段，客户端可据此选模型。

### P1 — 运维与接入体验

#### 4. ✅ 已落地 2026-11-07：`/v1/models` 元数据透出（上下文 / 最大输出 / 思考档位）
- **来源**：[workbuddy2api 面板](https://github.com/xu20060420fan-cell/workbuddy2api-trae-qoder-minimax-panel)（`/v1/models` 附带 `supported_efforts` / `default_effort` / 倍率 / 输入输出上限，四级查找链：上游目录 → 内置知识表 → model.json 缓存 → models.dev）；trae2api-hub 模型库（上下文/最大输出/思考档位）
- **机制**：客户端靠 `/v1/models` 声明窗口与行为；元数据越真，客户端侧截断/退避越准。
- **本仓库差距**：搭子的上下文约束实测过硬（超限**整轮失败**而非截断，CLAUDE.md 明确「客户端声明的窗口宁小一点」），但 `/v1/models` 对搭子条目是否携带 `context_length` / `max_output_tokens` 未见保障；管理端 models.js 已有 max_tokens 自学习观测数据（:143）却只落在管理端。
- **融合落点**：网关 `/v1/models` 的搭子行带 `context_length` / `max_output_tokens`，数据源优先级：实测自学习（models.js 已有）→ 档位默认表 → 不编。只透出有依据的值，取不到就不带字段（与「不编数」纪律一致）。

#### 5. ✅ 已落地 2026-11-07（src/balance-refresh.js，默认关闭）：网页池余额后台刷新 + 冷却自动解冻
- **来源**：[workbuddy2api 面板](https://github.com/xu20060420fan-cell/workbuddy2api-trae-qoder-minimax-panel)（`schedule.balance_refresh_minutes` 默认 5 分钟周期查余额并更新池，「冷却账号余额恢复自动解冻」）
- **机制**：两次签到时点之间积分保持新鲜；账号进冷却后由余额巡检判断是否已恢复，而不是等下一个整点任务。
- **本仓库差距**：FEFO 快照只在管理端三处刷新（`/web-accounts`、`/credits`、`/accounts`）时更新，网关侧选号读的是落盘快照——**管理端页面不开，快照就不新**；网页池冷却的解除依赖请求失败路径。
- **融合落点**：`autotask.js` 挂一个低频任务（默认 10 分钟，可 `0` 关）批量 `quotaOverview` → 更新账号积分 + 调 `expiring.update` 落快照；网页池冷却恢复判定读这份数据。注意限速（账号间间隔，参照 accounts.js 现有节流）。

#### 6. ✅ 已落地 2026-11-07：健康检查身份标识（防「假成功」探测）
- **来源**：[workbuddy2api 面板](https://github.com/xu20060420fan-cell/workbuddy2api-trae-qoder-minimax-panel)（`/healthz` 响应带 `service` 字段 + `X-Service` 头——同端口上残留的其他服务即使 2xx 也不带该字段，宿主探测据此避免假成功）
- **机制**：强校验用带 Key 的 `/status`（别的服务 401/404）；弱校验用无鉴权 `/health` + 身份字段。
- **本仓库差距**：`/health` 已有（含各通道状态），但没有「我是谁」标识——多进程多端口（9080/9082/9083/9084）混跑时，端口探活无法确认命中的是哪个实例。
- **融合落点**：`/health` 响应加 `service: "dumate2api"` + `role` 字段（stable/dev/admin/web-gateway，各入口启动时注一行常量）；响应头同步加 `X-Service`。四进程各一行改动，成本极低。

### P2 — 锦上添花（按需取用）

#### 7. 慢请求竞速对冲（hedged request）
- **来源**：TraeWorkAssistant 网关「慢请求竞速对冲」
- **机制**：首帧超过阈值 T 时向第二账号发起同一请求，先完成者胜、另一个取消——与现有「失败才换号」互补，治「没失败但慢」。
- **本仓库差距**：`channel-pool` / `web-pool` 只有失败换号路径，无对冲。
- **⚠️ 前置警告**：搭子按次扣积分，**两个请求都跑完就双扣**；且快速排队场景上游 200~680ms 就回错误信封，对冲窗口本来就窄。若做：只挂首帧等待期、取消必须发生在出内容前、默认关闭 + 环境变量开启；建议先只对 9084 网页池（积分便宜、可观测）灰度。优先级放低正是因为收益/风险比不如前三条。

#### 8. ✅ 已落地 2026-11-08：子 Key（`parent_id` 派生受限子钥）
- **来源**：TraeWorkAssistant（`ck_` 子 Key）
- **机制**：从主 Key 派生前缀受限的子 Key，继承/收紧配额与模型白名单，可单独吊销——临时分发给别人或给某个工具用，不暴露主 Key。
- **本仓库差距**：`keys.js` 已有 Key 级日配额（`keyQuota`），但 Key 之间是平的，没有父子关系与派生吊销。
- **落地口径**：`keys.js` 的 `parent_id`（只支持两级）；父 Key 停用/删除/过期 → 子 Key `parent_revoked`（吊销级联）；**子 Key 的请求同时计入父 Key 的配额桶**（`key-quota.js` 的 family 桶，父的限制是全家共享上限，子自己的 daily_limit 是额外收紧）；token 双记走埋点 `key_parent_id` → reqlog → `addTokens(..., {familyId})`。前端 KeysView 加父 Key 下拉、名称列「子 Key · 父 X」标签、删除确认动态提示级联。离线验证 `test/unit/key-subkey-bootstrap.test.js`（9 项）。

#### 9. ✅ 已落地 2026-11-08：首启凭证自举（随机 Key 生成一次并打印）
- **来源**：[dumate-api](https://github.com/Wang-JQ77/dumate-api)（首启自动生成随机 Token 存 `token.txt`，删除即重置）；workbuddy2api 面板（首启无配置时自动生成含随机 `api_key` 的推荐配置）
- **机制**：零配置启动也不裸奔——生成随机 Key、只打印一次，用户确认后启用。
- **本仓库差距**：本机 127.0.0.1 场景当前靠「不配 Key 即放行」；若未来端口暴露到局域网，这个空窗就是裸奔窗口。
- **落地口径**：`keys.ensureFirstRun(host)`——监听**非回环地址**且一把 key 都没有时签发 `first-run` 并返回明文，由网关启动日志打印一次；本机 127.0.0.1 / localhost / ::1 不触发（零打扰）。回环判定按监听地址字符串（`0.0.0.0` 与具体网卡都算已暴露），不做可达性探测。

#### 10. ✅ 已落地 2026-11-08：Dashboard 跨通道额度总览卡
- **来源**：[CreditDaddy](https://github.com/techysy/CreditDaddy)（10Router 额度总览 / 网页会话额度卡）
- **机制**：所有通道的剩余额度、今日消耗、临期额度聚合在一张卡里，异常（某通道余额取不到）显式标注而不是缺角。
- **本仓库差距**：各通道额度分散在 Points / 各通道账号页；Dashboard 是否已有跨通道聚合未见保障。
- **落地口径**：`src/channel-balance.js` 并发查五通道（单通道独立超时 + try/catch），`GET /api/admin/channel-balance[?force=1]`，前端 `ChannelBalanceCard.vue` 挂在 Dashboard 底部（五个通道分支之外）。**不跨通道相加**（单位不同），`remaining=null` 不填 0，部分账号失败给橙 tag + tooltip 明细，Qoder `cap=-1` 标不限量，进程内 60s TTL。**今日消耗未做**——各通道口径与单位不同，并排三套数字会被读成可相加；各通道 Dashboard 已有自己的今日用量卡。离线验证 `test/unit/channel-balance.test.js`（6 项）。

---

## 四、明确不建议融合的（已有等价实现或与架构冲突）

| 上游功能 | 不采纳原因 |
|---|---|
| dumate-api 的 Claude 名 → 档位映射（haiku→Lite / sonnet→Turbo / opus→Ultra） | **已有且更细**：`modelmap.js:173-208` 按通道分档（搭子 sonnet→L0 / opus→L1 / haiku→model-text），且旧式全名不劫持 |
| dumate-api 的进程发现 / 代理机制层 | `upstream-launcher.js` 已负责无 GUI 拉起 8980，职责重叠 |
| trae2api-hub 的网页登录闭环（本地回调端口自动换 Token） | `accounts.js:362` 的受控浏览器登录闭环（登录后自动抓 cookie、轮询落库）已覆盖同类需求，且不依赖百度 SSO 回调参数 |
| workbuddy2api 面板的浏览器抓 Cookie 入池（每号独立 profile） | 同上——本仓库 `loginBrowser` 就是同一模式的已有实现 |
| workbuddy2api 面板的请求来源 IP / UA 记录 | **已有**：`server.js:776-778` 每条请求日志记 `ip`（`reqlog.clientIP`）与 `ua`（截 200B） |
| workbuddy2api 面板的输出上限实测探测（probe_max_tokens） | **已有**：`admin/routes/models.js:143` 的 max_tokens 上限自学习观测 |
| workbuddy2api 面板的多平台「一键签到」合集 | 签到 / 抽奖 / 领奖 / 自动签到任务本仓库已有原生实现（accounts.js + autotask.js + checkin.js 账本），且合集面板的平台（WB/Qoder/MiniMax/豆包）与本仓库通道集不同 |
| workbuddy2api 面板的会话粘性内容哈希回退 | **已有且更深**：`channel-pool.sessionKeyOf` 以首条 user 消息指纹派生稳定 session_id（前缀缓存亲和） |
| 档位自动降级 / 按内容智能路由模型 | CLAUDE.md 定案：隐性替换模型违背显式契约；quota 耗尽走 429 + 换号，不静默换档 |
| trae2api-hub 的版本检测 + 一键自更新 | stable/ 冻结快照发布制（SNAPSHOT_FROM 依赖闭包同步），自动替换代码会破坏发布流程（与 TRAE 融合文档同判） |
| Redis 状态镜像（Upstash） | 单机自用，JSON/JSONL 原子落盘已够；多一个外部依赖多一个故障点 |
| 多租户账单 / 预算体系 | 单人自用管理端，引租户模型不划算 |

---

## 五、与其他融合文档的交叉引用

以下**通道无关**的管理端项已在 `TRAE-GATEWAY-MERGE-FEATURES.md`（2026-11-07）详细展开，对搭子通道同等适用，此处不重复：

- 运维告警（七类规则 + Webhook）／Token 预刷新（过期前 24h）／配置备份与恢复／服务端实时日志页（SSE + 脱敏）／侧栏角标／批量凭证运维／凭证限额护栏／Prometheus /metrics／月度账单 CSV／kill switch／账号级「模型请求开关」（暂停 ≠ 禁用）

---

## 六、建议的落地顺序

> **进度（2026-11-07 第二批）**：P0-2 后端（`src/agent-setup.js` + `/api/admin/agent-setup/*`，
> Claude Code settings.json 深合并 + Codex config.toml 托管键合并，写前备份/一键还原；
> cc-switch 沿用专用端点）与 P1-5（`src/balance-refresh.js` 低频余额刷新 + FEFO 快照随行 +
> 冷却解冻，默认关闭，端点 `/api/admin/auto-checkin/balance-refresh*`）已落地。
> 单测 +18 项、全量 620/620 绿；管理端冒烟通过（healthz 身份、路由鉴权、clients 真实探测）。
> **前端视图未做**——功能已可用 curl / 脚本调用，AgentSetupView 待下一批。
> 第一批（P0-1/P0-3/P1-6/P1-4）已于同日早些时候落地，结论在 CLAUDE.md「融合落地（2026-11-07）」节。

1. **第一批（Agent 接入体验）**：✅ P0-1 `dumate-points` 伪模型 → ✅ P1-6 健康检查身份标识 → ✅ P0-3 模型双链路可用性标注（三个都是小改动，一行常量级起步）
2. **第二批（配置治理）**：✅ P0-2 智能体一键配置（后端；前端视图待做）→ ✅ P1-4 `/v1/models` 元数据
3. **第三批（池运维）**：✅ P1-5 余额后台刷新 + 解冻 → ✅ P2-9 首启凭证自举（2026-11-08）
4. **第四批（按需）**：✅ P2-8 子 Key（2026-11-08）→ P2-7 慢请求对冲（先灰度网页池）→ ✅ P2-10 总览卡（2026-11-08）

> **进度（2026-11-08）**：AgentSetupView 前端已补（`#/setup`，admin 专属菜单）、P2-9 首启凭证自举、
> P2-8 子 Key、P2-10 跨通道额度总览卡均已落地——单测 +15（`key-subkey-bootstrap` 9 项 +
> `channel-balance` 6 项），全量 635/635 绿，`npm run build` 通过，9082/9083 真机走查通过
> （客户端探测、写入弹窗、子 Key 标签、五通道额度真实读数、切通道卡片常驻）。
> **剩余仅 P2-7 慢请求对冲**——有「双扣积分」前置警告（两个请求都跑完就双扣），需单独评估。

每批按本项目惯例：先离线验证脚本（`node --test test/unit/...`），再真机冒烟，CLAUDE.md 记结论。
