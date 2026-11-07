# Qoder 通道网关与管理端 — 生态功能融合清单

> 检索日期：2026-11-07 · 数据来源：GitHub 公开仓库 README / docs 实测内容（逐条标注出处）
> 对照基准：本项目（dumate2api）当前架构 —— 四通道网关（9080 稳定 / 9082 开发）+ 管理端（9083，`admin/routes/*` + `web/dist`），Qoder 通道 `src/qoder/`
> 结论先行：**P0×5 + P1×8 + P2×10**。最大缺口：「签到自动排程 + 归属核验」「运行时配置面板化（本项目计时器 env 变量模块加载时定死）」「负载均衡策略与低积分排除」「管理端可视化（到期分布 / 模型锁池 / 用量分析）」。
> 姊妹篇：千问侧同类清单见 [QWENWORK-GATEWAY-FEATURE-MERGE.md](QWENWORK-GATEWAY-FEATURE-MERGE.md)（智能体一键配置、namespace 展开等跨通道共享项在彼处详述，本文只引用不重复）。

---

## 一、检索来源（按相关度排序）

| 仓库 | Star | 技术栈 | 定位与本项目的关系 |
|---|---|---|---|
| [shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub) | 459 | Python 零依赖 | Qoder 双区（cn/intl）多账号网关，文档体系最完整（风控/排队/客户端接入）。**本项目多份结论源自它**；「智能体一键配置」「/health 风控遥测」是独有亮点 |
| [EchoPing07/Qoder-2API-Go](https://github.com/EchoPing07/Qoder-2API-Go) | — | Go 单文件 | **管理面板工程化最完整**：负载均衡三策略、签到调度（抖动+三态）、订阅周期感知、安全加固包、国际版 OpenAPI 额度链路。README 协议细节密度最高 |
| [xu20060420fan-cell/workbuddy2api-trae-qoder-minimax-panel](https://github.com/xu20060420fan-cell/workbuddy2api-trae-qoder-minimax-panel) | — | Go 单文件 | 多平台合集面板（九视图），**可视化运维最强**；Qoder 独有：**签到归属只读核验（grantId 比对）**、**网页控制台领取通道**、积分到期分布、模型锁池、输出上限主动探测 |
| [fengyinxia/qoder2api](https://github.com/fengyinxia/qoder2api) | — | Python | 原始参考实现（Qoder-2API-Go 的上游）：PAT→jobToken 冷交换、动态模型目录 TTL 缓存、VL 前置校验 |
| [foxy1402/qoder-proxy](https://github.com/foxy1402/qoder-proxy) | — | Docker | qodercli 包装器；看板四页（Endpoints/Playground/请求日志全量/系统日志）是页面层参考 |
| [D3-vin/Qoder2Api](https://github.com/D3-vin/Qoder2Api) | — | Go | 单二进制+内嵌看板；`code 115`（agent limit）failover、`/v1/usage`、`/api/promo` |
| [Liki4/qodercli2api](https://github.com/Liki4/qodercli2api) / [mmqz/cpa-multi-plugins](https://github.com/mmqz/cpa-multi-plugins) | — | — | 协议逆向记录（PKCE、deviceToken/jobToken、SSE 信封、双区常量表），hub 的致谢上游，仅作情报源 |

---

## 二、现状对照（避免重复造轮子）

### 本项目已实现（无需融合）

| 功能 | 本项目落点 | 生态同款 |
|---|---|---|
| COSY 本地签名（免客户端） | `src/cosy.js`（千问/Qoder 共用一份） | hub / fengyinxia 纯 Python 复刻 wasm |
| 官方排队轮询协议（requestSetId 稳定 + 每轮重签防 103 去重 + queue/status best-effort + 静默形态立即查状态） | `qoder/index.js` `queueWaitRound` | hub 排队轮询（**本项目更完整**：重签机制是独有修复） |
| 首字节/读空闲/内容期限三计时器（「假内容」识别） | `qoder/chat.js` | EchoPing07 `QODER_CHAT/IDLE_TIMEOUT`（本项目判据更细：空 delta/错误信封不算内容） |
| SSE `: ping` 保活帧（覆盖排队等待全程） | `src/server.js` 直连通道流式桥 | hub `QD_SSE_HEARTBEAT` |
| 前缀缓存亲和（首条 user 指纹 → UUIDv5 + business 派生） | qoder `buildBody` / `channel-pool.sessionKeyOf` | workbuddy「粘性内容回退」（system+首条 user 哈希，同思路） |
| 限流判据先行 + (账号,模型) 粒度冷却 + 下游 429 + 时长封顶 | `upstream-errors.classify` + `pool.applyModelSoftCooldown` | hub `isThrottle` / workbuddy 429 code=6004（同思路） |
| 额度类业务码 112/110/430/114 单独处置（不禁用不熔断、换号有用） | `qoder/index.js` `quotaFrameError` | D3-vin code 115 failover（同族，115 待补，见 P2-10） |
| FEFO 临期选号（落盘快照零上游调用） | `src/expiring.js` + 三通道 `fefoUidSet` | workbuddy「快过期积分加权」（**本项目零上游调用更优**） |
| 推算剩余（先领先扣 `estimateRemaining`，非「领取额」口径） | `qoder/grants.js` | **无生态同款**（hub/Go 项目都只有领取额或官方余额，无批次推算） |
| usage 缓存字段归一 + `credits`/`original_credits` 落账 | `src/usage-norm.js` + `credits.js` | EchoPing07 usage 扩展字段同源（#112） |
| billed_rate 账本 + 计费自检探针 | `credits.js` `computeBilledRate` + `billing-check` | hub #113 / EchoPing07 by_model 均价 |
| max_tokens 上限自学习（被动撞墙落盘 7 天 TTL） | `src/qoder/max-output.js` | workbuddy probe 主动探测（互补，见 P2-6） |
| 官方积分消耗接口（summary + heatmap） | `session.fetchCreditUsage` | EchoPing07 额度页同源接口 |
| offPeak 错峰透出 + 折扣实测化（credits/original） | model-info + credits 账本 | EchoPing07「生效价+划线牌价」/ hub 峰谷价 |
| Pro 福利包 eligibility/claim（confirm:true） | `admin/routes/qoder.js` | hub Pro 领取按钮 |
| orgResourcePackage 解析（cap=-1 → unlimited） | `fetchQuota` | EchoPing07 unlimited 处理一致 |
| 端点 failover（api3→api2→api1，转发过帧不切换） | `qoder/constants.js` + chat | EchoPing07 国际版钉 api1 单点（**本项目按 0.4.8 客户端缓存选 api3 更稳**） |
| 派生身份头（machineos/machinehostname 跨账号互异 + undici UA） | `cosy.js` | hub「身份形态对齐官方客户端」 |
| 请求体前置 413（29MB，对齐 SLB 30MB 硬限） | `chat.assertBodySize` | EchoPing07 10MiB |
| DeepSeek 族 reasoning_content 回填 + tool_call.id 补全 | `qoder/chat.js` | workbuddy 同款（上游同族行为） |
| Codex custom_tool_call / custom_tool_call_output 转换 | `src/server.js` Responses 入口 | hub custom freeform 降级 |
| 事件循环卡顿监控 | `startLagMonitor` | 生态均无 |

### 明确不融合（与本项目既有实测决策冲突）

| 生态功能 | 来源 | 不做的理由（本项目已定案） |
|---|---|---|
| 参数 verbatim 完全透传（不校验不钳制不映射） | EchoPing07 | 本项目归一化有实测依据：非法档静默回落是「用户无感丢档位」，max_tokens 撞上限要自学习钳制防反复 400 |
| 智能模型别名映射（gpt-4o→auto，未知名启发式兜底） | foxy1402 | 本项目契约：未知前缀 400 不静默回落 |
| 移除请求体上限（超限交上游自然报错） | workbuddy panel | 本项目实测 SLB 30MB RST 会被当瞬态错误换号重放、整池熔断——前置 413 是可用性修复 |
| Redis 状态镜像 / RAM-only 无状态 | workbuddy / foxy1402 | 本项目单机落盘场景，grants/credits 账本必须持久化 |
| CodeBuddy 成长任务一键完成（17/18） | workbuddy panel | 平台专属体系，Qoder 无对应任务端点（Qoder 只有签到活动与 Pro 福利） |
| `previous_response_id` 进程内续接 | workbuddy panel | 上游无状态、Codex 全量回传 input，已定案忽略 |
| baseprompt/CLI dump 模板注入 | fengyinxia / D3-vin | 本机 COSY 直连链路无此需要（那是包装 CLI 会话形态的做法） |
| billed_rate 自动 mismatch 判定 | hub #113 | 错峰优惠合法改变倍率，自动判必误报——只落账不判定 |

---

## 三、可融合清单

### P0 — 直接补当前痛点

#### 1. 签到自动排程（三态结果 + 抖动防惊群 + 失败退避）

- **来源**：EchoPing07「每日签到」节；hub「签到与保活：自动领取每日 Credits 活动，定时刷新 Token」
- **现状缺口**：本项目签到是通道可用的前提（零额度聊天挂起），但签到目前靠管理端手动触发；grants 账本「从功能启用时开始记」——漏签一天就少一天账本，过期提醒随之失真。
- **生态做法**：全局默认时点（EchoPing07 取 **10:15 服务器本地时间**——恰在本项目实测的「每日 10:00 (UTC+8) 刷新」之后 15 分钟，天然吻合）+ 账号级开关与时间覆盖（空串=用全局默认）；后台每分钟检查，到点后**按账号 ID 抖动几秒**避免整池同时打接口；结果三态 `success`/`already`/`skipped`（skipped=当天无可领活动，**有意不重试**），真失败单独记 `error` 并写 `last_checkin_msg`（界面悬停可见）；失败 30 分钟内不重试，之后每轮再试一次（仍在当天内）。
- **落点**：`src/qoder/` 新增 scheduler（签到逻辑本身已有：campaigns→claim，无需签名）；`admin/routes/qoder.js` 加 `GET /checkin-status`（每账号今日状态 + 最近结果 + 下次时点）。
- **验证**：离线用例——时点计算（10:00 刷新后的时区边界）、抖动不越天、skipped 不重试、失败 30 分钟退避、跨日重置。

#### 2. 签到归属只读核验 + 同人多号轮转（本项目多账号场景的真坑）

- **来源**：workbuddy panel FAQ「Qoder 号池两个号为什么只有一个能领到那 100 积分」（2026-11-04 真机实测更正版结论）
- **核心情报**：每日 100 Credits **按账号各发一份**（两个号 grantId/领取时刻/余额各自独立），**只有服务端判定「同一个人」时才只发一份**（后领的被拒 `SAME_PERSON_ALREADY_CLAIMED`）。设备指纹（伪造全套/完全不带 Cosy-* 头）与 `agentAccountScope` **均不参与判定**。
- **生态做法**：签到后对该号做一次**只读**核验 `GET /sash/api/v1/me/campaigns/{cid}/reward`，拿服务端返回的 `grantId` 与本号比对，三种结果严格区分：`CLAIMED` + 本号 grantId → 真领到；`BLOCKED` + SAME_PERSON → 「额度已被同一个人的另一账号领走」（点名是谁）；问不出结论 → 「归属未核实」，**不猜不假报**。POST（领取）与 GET（核验）必须用同一套判据，否则出现「一个说已签一个说未核实」的自相矛盾。被判同人的号按「**最久没真正领到的号优先**」自动轮转，隔天轮流拿那一份。
- **为何对本项目要紧**：本项目 grants 账本以 `grantId` 为幂等键，但「领过了」与「真领到了」是两回事——若两个号被服务端判同人，后签的那个**没有积分进账**，账本若照记领取额就是假数据，FEFO 推算剩余跟着错。
- **落点**：`qoder/grants.js` 加 `verifyClaim`（只读，绝不拿别人的活动实例去领）；账本行补 `verified`/`samePerson` 字段；管理端签到卡片三态徽标（已签灰 / 可签蓝 / 同人已领点名）。
- **验证**：离线剧本——CLAIMED 本号 / BLOCKED 同人 / 未知三态的账本写入与界面口径。

#### 3. 运行时配置面板化（热生效）——修「模块加载时读一次 env 就定死」这一类坑

- **来源**：EchoPing07（超时配置页保存即时生效）+ workbuddy panel（在线改配置：深合并 + 原子替换 + 保留未知键 + 返回「需重启字段清单」）
- **现状缺口**：CLAUDE.md 明确记录 `chat.js` 在模块加载时读一次环境变量就定死（`DUMATE_QODER_READ_IDLE_MS`/`CONTENT_MS`/`FIRST_BYTE_MS`/`QUEUE_*` 等），调阈值必须重启 9082；这类「定时器写死」已经造成过一次 6s 误杀事故。
- **生态做法**：管理端「配置」视图直接改运行参数，校验 → 落盘 → 热应用；装配期依赖的字段（监听端口等）保存后提示需重启。配置写入深合并、原子替换，用户手写的未知键原样保留。
- **落点**：新增 `src/runtime-config.js`（getter 语义 + JSON 落盘 + 热生效字段白名单）；首批只收 Qoder 稳定性参数（READ_IDLE/CONTENT_MS/FIRST_BYTE/QUEUE_POLL*/FEFO_DAYS/THROTTLE_MAX/MAX_BODY_MB）；`admin/routes/config.js` + 面板配置页。
- **验证**：离线用例——getter 读新值、非法值拒绝落盘、未知键保留、需重启清单正确。

#### 4. 网页控制台领取通道（免客户端签到的第二链路）

- **来源**：workbuddy panel「Qoder 网页登录」节
- **核心情报**：Qoder 网页控制台（`qoder.com/account/usage`）**同样能领每日 100 Credits**——它的成长页（`openapi.qoder.sh/growth-page/activity-iframe`）就是同一个领取入口。做法是给每个号建一个**独立浏览器 profile**（本机持久化），登录一次后会话留在 profile 里，之后每天自动领取，不需要客户端也不需要每天登网页。
- **价值**：设备 token 签到链路被活动平台过滤（hub 实测假机器头会被整条过滤「每日领取」）或风控升级时的兜底通道；对「每号各领各的」同样成立。
- **落点**：评估项——本项目无浏览器自动化依赖（workbuddy 用 CDP）；若接受引入，做成 `src/qoder/web-claim.js` 独立通道 + 面板每号 profile 管理；否则仅记录入口情报，优先做 P0-1/P0-2 的纯 API 链路。
- **成本提示**：引入无头浏览器是重依赖，建议放在纯 API 签到链路稳定之后。

#### 5. 智能体一键配置（跨通道共享项）

- **来源**：hub「智能体配置」页——31 个热门客户端 / Harness，13 类自动配置与还原，含 **DSH 本身**（`~/.dsh/settings.yaml` + `~/.dsh/.credentials.yaml`）、Claude Code、Codex CLI；写入前备份（每文件留 10 份）、全部成功才生效、自动拉 `/v1/models` 验 Key、网关侧只存 Key 的 sha256 指纹、仅接受本机 loopback 访问；跨机器场景提供配置器 CLI（`/agents/cli` 公开只读端点）。
- **说明**：这是整个网关的管理端缺口而非 Qoder 通道专属，详见 [QWENWORK-GATEWAY-FEATURE-MERGE.md](QWENWORK-GATEWAY-FEATURE-MERGE.md) P0-2，此处不重复。**Qoder 通道的增量点**：配置模板要能按通道挑默认模型（如 `qoder/dfmodel` 0.1 档做调试默认，对齐本项目「开发调试一律用 0.1 档」纪律）。

### P1 — 稳定性与额度治理

#### 6. 单号并发闸门 + 请求节奏控制

- **来源**：hub「可选的单号并发闸门与请求节奏控制」；EchoPing07 `QODER_MAX_CONCURRENCY`（默认 1：单 PAT 同时发往上游的聊天请求数上限，超出**本地排队等待**）
- **依据**：调大并发会提升吞吐，但超过 Qoder 账号的并发窗口时上游回 10605——本地排队比撞限流再走换号/冷却链路便宜得多。
- **落点**：`channel-pool` 或 `qoder/index.js` 加 per-account inflight 租约 + 本地等待队列；`DUMATE_QODER_MAX_CONCURRENCY` 环境变量 + 纳入 P0-3 的配置面板。

#### 7. 负载均衡策略可选 + 账号权重 + 低积分阈值排除

- **来源**：EchoPing07「多账号负载均衡」节
- **生态做法**：三策略——**粘性轮换**（同一会话优先复用，连续 N 次（默认 30）切换）/ **纯轮询** / **最少在途**；账号权重 1..100 按权重分配；**剩余积分 ≤ 阈值（默认 20）的账号停接新请求**（面板可调），全部账号都低于阈值才继续用；硬耗尽的账号冷却到下次重置点；最大重试账号数（默认 3）。
- **与现有机制的关系**：本项目已有会话亲和（sessionKeyOf）与 FEFO——FEFO 决定「临期优先」，本项补「常态分配策略」；权重与阈值参与候选打分，FEFO 集合非空时仍先收窄候选（优先级：FEFO > 阈值排除 > 权重/策略）。
- **落点**：`channel-pool.pick` 打分函数扩展 + `admin/routes/qoder.js` 策略配置端点；面板「账号」卡加策略与权重编辑。

#### 8. 轮转探活 / 余额后台刷新 + 冷却自动解冻

- **来源**：EchoPing07「轮转探活」（后台每分钟探测**一个**账号的额度，N 个账号最多 N 分钟全部刷新，上游调用恒约 1 次/分钟）；workbuddy panel（`balance_refresh_minutes` 默认 5 周期刷新，**冷却账号余额恢复自动解冻**）
- **价值**：阈值排除（P1-7）与 FEFO 推算剩余都吃「额度新鲜度」；打散探测避免整池同时打上游。
- **落点**：`src/qoder/` 定时器（复用 P0-1 的调度器骨架）；`/quota` 查询结果回写池状态；解冻钩子挂在 `pool.revive` 现有入口。

#### 9. PAT 凭证通道（第三种凭证形态）

- **来源**：hub「PAT 导入」；fengyinxia（PAT 作为 Bearer 由客户端携带，服务端按 PAT 哈希建独立 Bridge 实例；PAT→jobToken **冷交换** + refreshToken 周期续期）；EchoPing07（PAT 加账号时必须选区域，**区域与令牌不匹配上游回 `personal token is invalid`**）；workbuddy panel（捕获本机客户端登录态通道）
- **价值**：本项目 Qoder 目前只有 OAuth device flow 一条凭证链；PAT（`pt-xxxx_...`）是官方「服务集成」页签发的形态，适合无头导入与批量迁移；「捕获本机客户端登录态」则是免浏览器加号的另一路。
- **落点**：`qoder/index.js` 凭证抽象补 `pat` 类型（PAT→会话令牌交换 + 续期）；管理端加号弹窗加「PAT 粘贴」页签；校验失败文案透传「区域不匹配」提示。

#### 10. 订阅周期感知的统计口径（本地累计不被周期切换污染）

- **来源**：EchoPing07「额度与计费周期」节（规则密度最高的协议情报）
- **生态做法**：
  - 重置时刻以 `/algo/api/v3/user/status` 的 `nextResetAt` 为权威，OpenAPI `expiresAt` 仅兜底，且**必须 < 2100-01-01 才采纳**（无期限套餐填 `9999-12-31` 哨兵值要过滤）；
  - 本地周期起点按自然月回退推导（3/31 → 2/28 月末夹取）；
  - **边界变更接受规则**：首次拿到边界**保留**已累计值；边界未推进（接口缓存可能报旧值）直接忽略；前进 < 7 天视为同一周期不清零；≥ 7 天才判定真实续期并清零上一周期；
  - 均值分母是 `billed_requests`（仅 `billable=true` 的 usage 帧），不是请求总数——总数含失败/免费帧/断流无 usage 帧，会低估均价；
  - by_model / hourly 归因行内各带自己的均价（该模型无计费请求显示 `—` 而非 `0`，避免把「未计费」读成「免费」）。
- **与本项目的关系**：本项目 credits 账本已有 `billed_rate`/`original_credits`，缺的是**周期边界治理**这组规则（跨月清零抖动是真实风险——上游接口有缓存、会报旧边界）。
- **落点**：`credits.js` 加周期状态机；管理端统计卡补「本周期扣费 + 重置倒计时」。

#### 11. `/health` 风控信号遥测 + 健康端点身份标识

- **来源**：hub「`/health` 提供排队 / 限流 / 拒绝信号遥测」；workbuddy panel（`/healthz` 带 `service` 身份字段 + `X-Service` 头，宿主探活据此区分「本网关」与同端口残留服务，避免假成功；**探活计入模型豁免形态**——全号被单模型限流时不误报 503）
- **落点**：`src/server.js` `/health` 扩展（聚合窗口内的 queued/throttled/rejected 计数）；可用性判定与 `channelPool.availability()` 的 `softOnly` 语义对齐检查（模型级冷却不应让整体健康变红）。

#### 12. 国际版双区支持（条件项：本项目尚未部署 intl 账号）

- **来源**：hub（国内/国际独立账号池与出口，**按模型自动选区**；`X-Realm: cn|intl` 请求头或 `?realm=` 参数；API Key 绑定出口）；EchoPing07（模型名前缀 `cn/`、`gl/`、`auto/` 只用于路由不传上游，统计按裸名聚合；池中无国内账号时自动跨区；**国际版额度走 openapi.qoder.sh，不接受 COSY 会话令牌，需用 PAT 单独换 OpenAPI 令牌并自动刷新**）
- **前提**：CLAUDE.md 记录「Qoder intl 账号本项目未部署」；本项目已有 `DUMATE_QODER_INTL_GATEWAY` 与 api3 候选链，缺的是账号级 `region` 字段 + 选区路由。
- **落点**：账号元数据加 `region`；`channel-pool` 选号按 region 过滤；模型名前缀解析放 `upstream-router`；国际版额度链路（见 P1-13）随账号 region 生效。**未部署 intl 账号前只做数据结构预留。**

#### 13. 国际版 OpenAPI 额度链路 + userType 前置修复

- **来源**：EchoPing07「额度与计费周期 / `userType` 修复」
- **协议情报**：
  - 主数据 `GET openapi.qoder.com.cn/api/v2/quota/usage`，用现有 jobToken 交换返回的 **`securityOauthToken` 作 Bearer**（与官方客户端 /usage 面板同源），提供 `userQuota` / `addOnQuota` / `orgResourcePackage`（含 `available` 状态）/ `isQuotaExceeded`（官方超额判定）/ `expiresAt`；
  - `total`/`cap` 为 0 的池视为不存在不展示；`available=false` 的池单独成行但**不计入合计**（否则汇总与明细自相矛盾）；免费账号首行直接展示真正持有额度的池子；
  - `/user/status` 的 `quota: 0` 是精简字段，**不能解释为套餐无上限**——权威额度以 OpenAPI `userQuota` 为准；
  - **`userType` 必须在构建会话之前从 `/user/status` 取真实层级**（该值被 AES 签入 bearer 载荷，事后无法修改）；临时不可用时按「上次已知 → 空值 → 历史默认」降级，避免把团队账号静默降级。
- **与本项目的关系**：本项目 cn 账号额度链路可用；intl 账号（若部署）额度查询必须走这条；userType 前置对**团队号**（orgResourcePackage 非空的账号）立即相关。
- **落点**：`qoder/session.js` 补 token 交换与 `fetchQuotaV2`；`buildBody`/签名会话构建前取 userType。

#### 14. 真实设备指纹 helper（real-or-none 策略）

- **来源**：EchoPing07「设备指纹」节
- **生态做法**：上游对机器头敏感——**只有在能读到已安装 Qoder 桌面 App 的真实指纹时才发六个机器头**（Windows：`%LOCALAPPDATA%\Programs\Qoder[ CN]\resources\umid\runtime-info.exe`；macOS：`/Applications/Qoder[CN].app/.../umid/runtime-info`），读不到时**一个机器头都不发**（通用「每日领 100」照常可领）；`QODER_RUNTIME_INFO` 可指向外部 helper（标准输出 `machineToken/machineType/machineCode`）。
- **与本项目的关系**：本项目聊天链路用**派生**机器头（实测可用）；签到链路已遵守「不加派生头」。real-or-none 是第三态：装了官方客户端的机器上用真指纹，可解锁**设备定向活动**（纯 none 领不到的那类）；workbuddy 2026-11-04 实测确认指纹不参与同人判定，真指纹无副作用。
- **落点**：`qoder/session.js` 签到链路加 real-or-none 探测（存在 runtime-info 才带）；聊天链路维持派生现状。

### P2 — 管理端页面增强

#### 15. Playground + Endpoints 页

- **来源**：foxy1402 看板
- **内容**：Playground——浏览器内实时测试 API、切换可用模型；Endpoints——各协议（OpenAI/Responses/Anthropic）接入代码片段一键复制。本项目管理端已有模型/账号视图，缺「试一下」的入口。

#### 16. 请求日志增强（筛选 / 来源 / 时间范围 / 保留策略）

- **来源**：EchoPing07（按模型/密钥/状态筛选 + 分页；保留天数与条数上限可配、超限自动删最旧）；workbuddy panel（**来源 IP/UA**：`X-Forwarded-For` 首段 → `X-Real-IP` → TCP 对端，UA 截 200B 入库，记录开关热生效；**时间范围控件**：今天/24h/3d/7d/30d/自定义，「今天」与自定义由**浏览器本地时区**算好发服务端（容器时区未必一致），滚动预设走服务端 `hours` 口径，过滤在**归档侧**完成——区间落在更早时段也能取到）
- **落点**：`reqlogs.js` 加 from/to/来源字段；面板日志页加范围控件；JSONL 归档加保留天数/容量上限清理。

#### 17. 用量分析页（时序图 + 多维归因）

- **来源**：workbuddy panel「用量」视图 + EchoPing07 `/admin/api/stats`
- **内容**：指标卡（请求数/总 token/prompt·completion 占比/失败尝试/平均延迟/TTFB/吐字速率 tok/s）；Token 时序图（堆叠柱 + 均值参考线 + 峰值标注）；按账号/模型/通道切换与排序；**积分扣除历史（折算「积分 / 1M Token」）**；本服务实际消耗单独成卡（累计/本周期/计费请求数/均价，口径见 P1-10）。
- **落点**：数据源现成（`usage.js` + credits 账本 + `fetchCreditUsage`），纯前端聚合 + 一个聚合端点。

#### 18. 积分构成 / 到期分布页

- **来源**：workbuddy panel「积分构成」视图
- **内容**：**积分到期分布**（按批次到期日聚合、颜色区分账号、危险度色点、**到期前日均需耗量**——拿「推算剩余 ÷ 剩余天数」直接算）；账号对比卡（面额/余额/包数/混合构成条）；逐包明细（最近到期展开，其余与已用完的折叠，单账号默认展示条数可配）。
- **与本项目的关系**：grants 账本 + `estimateRemaining` 推算剩余是现成数据源（本项目口径比生态更准——生态只有领取额），**缺的只是可视化**；「日均需耗量」能把「快过期」变成「每天要用 X 才不亏」。

#### 19. 模型条件查询 + 模型锁池视图

- **来源**：workbuddy panel「模型与档位」视图
- **内容**：条件筛选（关键词分词 AND / 域 / 能力（工具/视觉/思考）/ 思考档位 / 价格（折扣/限时免费））+ 按倍率/上下文/最大输出排序；**模型锁池表**：被限流的模型聚合视图（可选与总数、锁定账号数、最早解锁与全池解锁倒计时、限流原因；无锁定显示「所有模型均可选」）。
- **与本项目的关系**：`pool.model_cooldowns`（(账号,模型) 粒度冷却）数据现成，缺视图——这正是「Qoder 用不了、网页版正常」那类事故的可视化诊断面。

#### 20. 探测模型真实输出上限（主动式，与现有被动自学习互补）

- **来源**：workbuddy panel `scripts/probe_max_tokens.py`
- **生态做法**：上游目录的 `max_output_tokens` 是**声称值**、普遍虚高（实测 16 个模型 8 个被静默钳制，最狠声称 1M 实际 32K）；探测脚本区分两种停止——`finish=length`（被钳制，可信）vs 模型主动收尾（未测出）；结果写数据文件**不写死在代码里**，面板最大输出列叠加标注（`32K ⚠ 钳制 12×` / `48K ✓` / `≥40K` 下界 / `?`）。
- **与本项目的关系**：`max-output.js` 是被动撞墙自学习（第一次撞上限才落盘）；主动探测提前发现「声称 131072 实际 32K」这类静默钳制——本项目千问实测「传 4000 输出 7808」就是主动收尾形态，判据可复用。
- **落点**：管理端「计费自检」按钮旁加「输出上限探测」（发长输出请求到各模型，按 finish_reason 判定，结果落 `data/qoder-output-probes.json`）。

#### 21. 管理端安全加固包

- **来源**：EchoPing07「安全」节 + workbuddy panel「安全响应头/鉴权实现」+ hub（Key 只存 sha256 指纹）
- **清单**：管理面板登录失败按客户端 IP 指数退避（1s→30s 封顶，429 + `Retry-After`）；API Key 与密码比对用**恒定时间比较**；会话 Cookie `HttpOnly` + `SameSite=Lax`（HTTPS 反代下自动加 `Secure`）；安全响应头（CSP `default-src 'none'` + `frame-ancestors 'none'`、nosniff、DENY、no-referrer）；上游 uid 白名单（`[A-Za-z0-9_-]`，≤64）后才拼文件名**防路径穿越**；前端用户输入 `textContent` 渲染防 XSS；管理 API 请求体上限（64KiB 量级）。
- **落点**：`admin/server.js` 中间件层一次收齐；本项目管理端只绑本机，优先级可后置，但「公网化」之前必须做。

#### 22. CORS 配置

- **来源**：EchoPing07（面板「设置 → 跨域」开关 + 来源列表；自动处理 OPTIONS 预检；按完整 Origin 比对，忽略大小写与默认端口，不支持子域通配；环境变量设置时锁定面板编辑）+ foxy1402 `CORS_ORIGIN`
- **落点**：`src/server.js` 与 `admin/server.js` 各一份；默认关闭（本项目客户端均为 CLI，无浏览器跨域需求，纯为后续 Web 客户端预留）。

#### 23. 浏览器内添加账号（热加载免重启）+ JSON 批量导入

- **来源**：workbuddy panel（面板「添加账号」完成授权 → 凭证落盘 → **热加载进池免重启**；「导入 JSON」批量迁移 `auths/` 凭证文件；设备码授权拿到的是**独立 refresh token 链，不会顶掉客户端正在用的那根**——对 Qoder 的 device flow 同样成立，值得在面板文案里写明）
- **落点**：`admin/routes/qoder.js` 加号端点 + 池热注册（`channel-pool` 已有运行时状态，补一个 `addAccount` 入口即可）。

#### 24. 协议杂项补丁包（小而独立，可顺手做）

| 项 | 来源 | 说明 |
|---|---|---|
| `code 115`（agent limit）入额度码表 | D3-vin | 本项目额度码表是 112/110/430/114；115 是第 D3-vin 项目用作 failover 触发的账号限额码，补进 `quotaKindOfText`（冷却策略对齐 112） |
| VL 前置校验 | fengyinxia | 非视觉模型传图直接本地 400（模型表 `is_vl` 现成），比放行后上游报错省一次上游调用 |
| 动态模型目录拉取失败显式 WARN + 回退 | fengyinxia | 回退内置表**不静默**（本项目千问曾因静默回落静态表掩盖签名 bug——同一教训的防回归） |
| `/v1/usage` 客户端端点 | D3-vin | 客户端可查当前账号额度（轻量，复用池内快照，不打上游） |
| `/api/promo` 活动透出 | D3-vin | 签到活动与免费额度对客户端只读透出（本项目管理端已有，客户端侧没有） |
| 重复 `/v1` 前缀带提示的 404 | hub | base URL 已带 `/v1` 客户端又拼一次是接入第一高频错误；返回带提示的 404 + 日志 WARN 便于自证 |
| `/v1/messages/count_tokens` 本地估算 | hub | Claude Code 会调；不上游、纯本地估 |
| Anthropic 桥 system 原位改 user | hub（`QD_ANTHROPIC_MSG_SYSTEM`） | `messages` 里的 system 原位改 user、顶层 system 每轮不变 → **保住上游前缀缓存命中率**（与本项目 cache-affinity 同目标，检查 Anthropic 翻译层是否已做） |
| 优雅关闭 | EchoPing07 | SIGINT/SIGTERM 停接新连接、等在途（15s）、统计最终落盘——对账本完整性有益 |
| 流内错误状态码映射 | EchoPing07 | 尚未向客户端写出内容时，流内错误帧按内嵌状态码映射回真实状态码（本项目已有「头推迟到真实首帧」机制，检查流内 error 分支口径一致） |

---

## 四、协议层新情报汇总（可直接增强现有判据）

| 情报 | 出处 | 对本项目的用途 |
|---|---|---|
| `GET /sash/api/v1/me/campaigns/{cid}/reward` 是**只读**归属核验端点（返回 status + grantId） | workbuddy panel | P0-2 归属核验；绝不拿它去领别人的活动实例 |
| `SAME_PERSON_ALREADY_CLAIMED`：同人多号只有服务端判同人才互斥；先打先得 | workbuddy panel（2026-11-04 实测） | 多账号签到归因；误判会错杀已到账积分（生态真 bug 案例） |
| 设备指纹（伪造/缺失/改 hostname）与 `agentAccountScope` 均不参与同人判定 | workbuddy panel 实测 | 派生头聊天链路安全性的旁证 |
| 网页控制台成长页 `openapi.qoder.sh/growth-page/activity-iframe` 与 API 签到是同一领取入口 | workbuddy panel | P0-4 第二领取通道的入口依据 |
| jobToken ↔ `securityOauthToken` 交换；国际版额度必须走 OpenAPI 令牌链路 | EchoPing07 | P1-13；`/api/v2/quota/detail` 一族 503/404 时的正确端点形态 |
| `/user/status` 的 `quota: 0` 是精简字段 ≠ 无上限；`expiresAt` 哨兵值 9999 要过滤 | EchoPing07 | 额度解析防误读（本项目 `cap=-1 → unlimited` 已处理同类，补 expiresAt 哨兵） |
| `userType` 被签入 bearer 载荷，会话构建后不可改；须先取真实层级 | EchoPing07 | 团队号签名载荷正确性（本项目实测账号若含组织号即相关） |
| runtime-info.exe 真实指纹路径 + helper 协议（stdout：machineToken/machineType/machineCode） | EchoPing07 | P1-14 real-or-none |
| 签到区域端点走 OpenAPI 令牌（`jt-`，自动换+刷新，401 强刷重试一次） | EchoPing07 | 本项目实测 device token + `cosy-clienttype: 10` 无签名链路可用——两条路线并存情报，维持现状，jt- 作备选 |
| EchoPing07 国际版聊天钉 `api1.qoder.sh`；本项目按 0.4.8 客户端缓存 api3 优先且实测 api1 常年超时 | EchoPing07 vs 本项目 | 维持本项目 api3 候选链；记录分歧依据，勿被生态 README 反向带偏 |
| 上游目录 `max_output_tokens` 是声称值，静默钳制普遍存在（`finish=length` 判据） | workbuddy panel | P2-20 主动探测；千问「传 4000 出 7808」即主动收尾形态 |
| 粘性会话绑定的账号被**模型级**限流后，换模型的请求应自动解绑重分配；健康探活要计入模型豁免形态 | workbuddy panel | 检查项：本项目 `sessionKeyOf` 亲和与 `applyModelSoftCooldown` 的交互——粘住的号若恰好对该模型冷却，请求应换号而非失败 |

---

## 五、建议落地顺序

| 批次 | 内容 | 理由 |
|---|---|---|
| 第一批（P0） | ① 签到自动排程 → ② 归属核验 → ③ 配置面板化 → ⑤ 智能体一键配置（跨通道，可与千问清单合并做） | ①②直接决定账本真实性与通道可用性（本项目最重的两笔资产）；③消除「改阈值要重启」这类已造成过事故的工程债 |
| 第二批（P1） | ⑥ 并发闸门 → ⑦ 负载均衡策略/权重/阈值 → ⑧ 探活/余额刷新 → ⑩ 周期口径 → ⑪ /health 遥测 | 全部是池治理，依赖第一批的调度器骨架；⑫⑬⑭ 等 intl/团队号真实出现再做 |
| 第三批（P2） | ⑱ 到期分布页 → ⑲ 模型锁池视图 → ⑰ 用量分析 → ②20 输出上限探测 → 其余 | 纯管理端可视化，数据源现成；安全加固包（㉑）在公网化前置 |
| 网页领取通道（P0-4） | 单独立项评估 | 引入浏览器自动化是重依赖，纯 API 链路（①②）稳定后再议 |

**验证纪律**（对齐本项目惯例）：每项配离线测试——单测 `node --test test/unit/*.test.js` + 端到端 `node test/verify-*.js`；协议判据（grantId 核验三态、周期边界规则、钳制判型）全部用剧本驱动，不依赖真机时序。

---

## 六、参考链接

- [shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub) · [客户端接入文档（智能体一键配置）](https://github.com/shuishuipingan/qoder2api-hub/blob/main/docs/clients.md) · [风控与排队](https://github.com/shuishuipingan/qoder2api-hub/blob/main/docs/risk-control-and-queueing.md)
- [EchoPing07/Qoder-2API-Go](https://github.com/EchoPing07/Qoder-2API-Go)（负载均衡 / 签到调度 / 周期感知 / 安全节均在其 README）
- [xu20060420fan-cell/workbuddy2api-trae-qoder-minimax-panel](https://github.com/xu20060420fan-cell/workbuddy2api-trae-qoder-minimax-panel)（Qoder 归属核验 / 网页领取 / 九视图面板）
- [fengyinxia/qoder2api](https://github.com/fengyinxia/qoder2api)（原始实现：PAT 冷交换 / 动态目录）
- [foxy1402/qoder-proxy](https://github.com/foxy1402/qoder-proxy)（看板四页）
- [D3-vin/Qoder2Api](https://github.com/D3-vin/Qoder2Api)（code 115 / /v1/usage / /api/promo）
