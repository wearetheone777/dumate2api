# 千问办公（QwenWork）网关与管理端 — 生态功能融合清单

> 检索日期：2026-11-07 · 数据来源：GitHub 公开仓库 README / docs 实测内容
> 对照基准：本项目（dumate2api）当前架构 —— 四通道网关（9080 稳定 / 9082 开发）+ 管理端（9083，`admin/routes/*` + `web/dist`）
> 结论先行：**8 项高价值可融合（P0/P1）**，其中「Codex namespace 工具展开」「智能体一键配置」「主动限流」「模型锁池视图」是当前最大缺口。

---

## 一、检索来源（按相关度排序）

| 仓库 | Star | 技术栈 | 定位与本项目的关系 |
|---|---|---|---|
| [shuishuipingan/qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub) | 459 | Python 零依赖 | Qoder 双区多账号网关，与千问同一套 COSY 协议；文档体系最完整（部署/配置/账号/风控/内部原理），**本项目多份结论源自它** |
| [wicm84266964/Buddy2api](https://github.com/wicm84266964/Buddy2api) | 137 | Python | 多通道本地网关（WorkBuddy/Qoder/**QwenWork**/TraeWork/Loomy/小浣熊），本项目千问通道的前身参考实现，**管理页功能最全** |
| [xu20060420fan-cell/workbuddy2api-trae-qoder-minimax-panel](https://github.com/xu20060420fan-cell/workbuddy2api-trae-qoder-minimax-panel) | — | Go 单文件 | 多平台合集面板（九视图），**可视化运维层做得最好**：账号池可视化、用量时序图、积分构成、任务中心、模型锁池 |
| [Alphaxiaoteng/qwenwork2api](https://github.com/Alphaxiaoteng/qwenwork2api) | 3 | Python 纯标准库 | 千问办公 → OpenAI 兼容 2API；走百炼 API Key 路线（与本项目 COSY 直连不同源），仅参考 MCP/CLI 形态 |
| [wpy030414/xrp-cosy](https://github.com/wpy030414/xrp-cosy) | 6 | TypeScript | Qwenwork/Qoder 反代（需配 XRL Router），架构与本项目重叠，无增量功能 |
| [harwinvoid/magpie-plugin-qwenwork](https://github.com/harwinvoid/magpie-plugin-qwenwork) | 3 | JavaScript | 千问 device flow 登录的 magpie/OpenCode provider |
| [zanderzhng/qwenwork-byok](https://github.com/zanderzhng/qwenwork-byok) | 4 | JavaScript | 千问客户端自定义 API Key 注入，方向不同（改客户端而非网关） |
| [gaoqiaoliangjie666/dsh-qwen-connect](https://github.com/gaoqiaoliangjie666/dsh-qwen-connect) | 4 | JavaScript | 千问桌面 App → DSH 零配置接入插件 |

---

## 二、现状对照（避免重复造轮子）

### 本项目已实现（无需融合）

| 功能 | 本项目落点 | 生态同款 |
|---|---|---|
| COSY 本地签名（免客户端） | `src/cosy.js`（千问/Qoder 共用一份） | hub 的纯 Python 实现 |
| 排队等待轮（requestSetId + queue/status 轮询 + 每轮重签） | `qoder/index.js` `queueWaitRound` | hub `QD_QUEUE_MAX_ROUNDS`（**本项目实现更完整**：重签防 103 去重、静默形态立即查状态） |
| 读空闲/首字节/内容 deadline 三计时器 | `qoder/chat.js` | hub `QD_SSE_HEARTBEAT` + 无此层判定 |
| SSE `: ping` 保活帧 | `src/server.js` 直连通道流式桥 | hub `QD_SSE_HEARTBEAT=5`（本项目覆盖排队等待全程，更强） |
| 前缀缓存亲和（stableSessionId 首条 user 指纹） | `qoder` buildBody / `channel-pool.sessionKeyOf` | hub `QD_AFFINITY_BY_PREFIX`（思路一致） |
| usage 缓存字段归一化 | `src/usage-norm.js` | hub #112 |
| 思考档位四入口透传 + 本地归一化 | qoder P1 / effort-passthrough | Buddy2api 多写法兼容（本项目覆盖面相当） |
| 模型级冷却（(账号，模型) 粒度） | `pool.applyModelSoftCooldown` | workbuddy panel 429 code=6004（同思路） |
| 限流 429 处置 + 冷却封顶 | `upstream-errors.classify` + `DUMATE_THROTTLE_MAX_MS` | hub `isThrottle` 判据先行 |
| FEFO 临期选号（落盘快照零上游调用） | `src/expiring.js` + 三通道 `fefoUidSet` | hub `expiring_window_days`（**本项目零上游调用更优**） |
| 计费自检探针 ×3 通道 | `admin/routes/{qoder,traework,qwenwork}.js` `billing-check` | hub billed_rate / workbuddy panel 探针 |
| billed_rate 账本 + offPeak 错峰透出 | `credits.js` `computeBilledRate` + model-info | hub #113 / promotion 字段 |
| max_tokens 上限自学习（撞墙落盘 7 天 TTL） | `src/qoder/max-output.js` | workbuddy panel probe_max_tokens（被动 vs 主动，见 P2-3） |
| 请求体前置 413 | `chat.assertBodySize` 29MB | hub `QD_MAX_BODY_MB=29`（数值一致） |
| 执行纪律注入 | `qwenwork/chat.js` `withAgentDiscipline`（TRAE 同款移植） | 无生态同款，本项目原创 |
| 官方积分消耗接口（summary + heatmap） | qoder P2 `fetchCreditUsage` | hub 用量洞察（同源接口） |
| Pro 福利包领取 | `pro-eligibility` / `pro-claim`（confirm:true） | hub「仅领 Pro 福利包」按钮 |
| 千问联网搜索/图搜独立端点 | `src/qwenwork/search.js` `/v1/search/*` | 生态无同款 |
| 千帆 JSON mode 原生透传 | `src/qianfan-raw.js` | 无 |
| 事件循环卡顿监控 | `startLagMonitor` | 生态均无 |

### 明确不融合（与本项目既有实测决策冲突）

| 生态功能 | 来源 | 不做的理由（本项目已定案） |
|---|---|---|
| 上下文窗口按请求可调（`X-QD-Context: 1M` 头 + 面板下拉） | hub #106 | 本项目千问默认已按最大档下发，抬窗无意义；CLAUDE.md P2 明确不做 |
| 工具调用泄漏回读 / lenient 收尾（`QD_TOOL_ECHO_MODE`） | hub / workbuddy panel | 本项目发结构化工具历史，部署中无实测案例；P2 明确不做 |
| billed_rate 自动 mismatch 判定 | hub #113 思路 | 错峰优惠合法改变倍率且乘性方向曾未实测，自动判必误报——本项目只落账不判定 |
| 按请求内容智能路由模型 | Trae2api-cn | 隐性替换模型违背显式契约，计费倍率跟着变 |
| 千问图片输入（imageUrls 槽） | hub 生态普遍支持 | 官方客户端 `ydl()` 写死 null，该端点结构性不收图；要图只有接 ACP（清单 P2-17 另议） |
| 成长任务一键完成 / 猫猫旅行 / 连登管家 | workbuddy panel | WorkBuddy 专属成长体系，千问通道无对应端点 |
| 双区路由（cn/intl 自动选区） | hub `QD_AUTO_REALM` | 千问无国际版；Qoder intl 账号本项目未部署 |

---

## 三、可融合清单

### P0 — 直接补当前痛点（建议尽快做）

#### 1. Codex `namespace` 工具容器展开（千问通道功能修复）

- **来源**：hub [docs/clients.md](https://github.com/shuishuipingan/qoder2api-hub/blob/main/docs/clients.md) issue #127
- **现状缺口**：本项目千问 `buildBody` 对 Codex 带来的 `namespace`（`multi_agent_v1` / `mcp__cua_repl`）工具**整包过滤丢弃**——带上任何一个整轮 400，但过滤意味着 Codex 的 MCP 工具全部失效。
- **生态做法**：递归展开 `tools` / `children` / `functions` 容器（深度上限 4）成扁平 `function` 条目，容器本身不出站；回程在 `response.output_item.added` 帧把 `namespace` 字段补回，客户端按 `(name, namespace, kind)` 三元组匹配执行器。重名工具只保留第一个并打 WARN；容器内不带 `type` 的子项按 `function` 处理，`custom` 照常降级。
- **顺带**：Codex Desktop 0.162+ 会把整份工具清单放进 `input` 的 `additional_tools` 条目，需与顶层 `tools` 合并后再展开。
- **落点**：`src/qwenwork/chat.js` `buildBody`（过滤逻辑改为展开-过滤-回程补回三段）；`src/server.js` Responses 翻译层（回程补 namespace）。
- **验证**：离线用例——MCP 单服务器、双服务器重名、嵌套深度 5 截断、`custom` freeform 混合容器。

#### 2. 智能体一键配置页（管理端最大页面缺口）

- **来源**：hub「智能体配置」页（31 客户端 / 13 类自动适配 + 还原）；[docs/clients.md](https://github.com/shuishuipingan/qoder2api-hub/blob/main/docs/clients.md)
- **功能形态**：管理端新页面，检测本机已装 AI 客户端 → 一键把配置指向本网关：
  - Claude Code → `~/.claude/settings.json`；Codex CLI → `~/.codex/config.toml` + `auth.json`；DSH → `~/.dsh/settings.yaml` + `.credentials.yaml`；OpenCode → `~/.config/opencode/opencode.json`；Crush / Aider / Continue / Pi / Factory Droid / GitHub Copilot CLI / OpenHands / Kilo / Mistral Vibe。
- **关键工程约束（生态踩坑已给出）**：
  - **保留其他设置**：YAML/TOML 局部字段增量修改；JSON 字段级合并；JSONC 不盲目重写；
  - **可还原**：写入前备份（每文件保留最近 10 份），还原为逐字节恢复；
  - **全部成功才生效**：多文件客户端任一失败全部回滚；
  - **自动填模型表**：写入时从网关拉 `/v1/models` 顺便验 Key；
  - 网关侧只存 Key 的 sha256 指纹；
  - 只接受 loopback 访问启用（远程/容器场景提供配置器 CLI 下载端点）。
- **落点**：`src/admin/routes/agents.js`（新）+ 管理端新视图；本项目用户主力是 Codex + Claude Code + DSH，**先做这三张卡即可**。
- **注意**：检测只查 PATH 与约定目录，不启动客户端、不读系统凭据库。

#### 3. 主动限流 / 流量守卫层（防风控，本项目完全缺失的一层）

- **来源**：Buddy2api「主动限流」设置页；hub `QD_TEAM_*` 流量守卫 + [docs/accounts.md](https://github.com/shuishuipingan/qoder2api-hub/blob/main/docs/accounts.md) 团队账号节
- **功能项**：
  | 设置 | 默认 | 语义 |
  |---|---|---|
  | 每账号最小请求间隔 | 5s（0 关） | 按两次上游调用开始时间计 |
  | 每账号最大并发 | 1（0 不限） | 流式响应结束/取消才释放 |
  | 最长排队时间 | 120s | 按账号 FIFO，超时尝试队列中其他账号 |
  | 每账号排队深度 | 256 | 满时回本地 429 `local_rate_limit`，**不把账号标成失效** |
- **配套**：登录/签到/额度查询不占名额；关闭跨通道转移时排队失败直接返回；限流参数只在管理端「设置」保存。
- **团队账号增强（Qoder/千问团队号适用）**：`is_team()` 三层判据（`organization_id` > `userType` 含 team/enterprise > 额度快照含共享池）→ 只对团队号默认启用并发闸门；一小时内同账号来自 >3 个不同客户端 IP 打 WARN。
- **落点**：网关层新模块 `src/traffic-guard.js`（与 `channel-pool` 平行）；管理端设置页新增区块。本项目四通道共用一份实现，按通道覆盖参数（千问单账号只读、默认更保守）。

#### 4. 模型锁池视图（把已有的模型级冷却变得可见）

- **来源**：workbuddy panel「模型与档位」视图的模型锁池表；hub #105 billed_model 红标
- **现状缺口**：本项目已有 `(账号, 模型)` 粒度冷却与 `softOnly` 判定，但管理端**看不到**——用户只看到「Qoder 用不了」，不知道是 dfmodel 排队还是账号熔断。
- **功能形态**：
  - 按模型聚合的锁定视图：该模型被限流/排队的账号数、可选/总数、**最早解锁与全池解锁倒计时**、限流原因（10605 排队 / 额度码 112/110 / 版本门 430）；
  - 无锁定时显示「所有模型均可选」；
  - 请求日志页模型列加「计费→auto」红标（usage 返回 model 与请求模型不一致时——本项目 requestSetId 修复后仍可能被上游改路由，这是唯一可见途径）。
- **落点**：`admin/routes/pool.js`（新只读端点，读 `model_cooldowns`）+ 管理端仪表盘新卡片；`reqlogs.js` 加 `billed_model` 字段。

#### 5. API Key 管理升级（多 Key / 绑通道 / 模型白名单 / 日限额）

- **来源**：Buddy2api「API Keys」页；hub「模型闸门」`banned_models` + `api_keys[].models`（fnmatch 通配、不区分大小写、本地拒绝不发上游）
- **现状缺口**：本项目 `keys.js` 只有网关鉴权，无 Key→通道绑定、无白名单、无日限额。
- **功能项**：
  - 每 Key：名称、启停、删除即失效、绑通道（或自动通道按账号优先级选）、模型白名单（fnmatch，如 `qwen/*`）；
  - Key 日限额在账号队列非空后、首次派发前计 1 次；**内部换号与跨通道重试不重复计次，上游失败不退次数**；校验失败与空队列不计次；
  - 503 `channel_unavailable` 语义：该模型当前无可用账号（冷却/过期/额度耗尽），**不计入 Key 日限额**；
  - 400 错误码细分：`model_not_allowed`（不在白名单）/ `unknown_model` / `channel_retired`（通道下线如千帆场景）。
- **落点**：`keys.js`（通道 id 单一来源已就位，加 Key 元数据）；`admin/routes/keys.js` 校验同步；管理端 Keys 页。

### P1 — 管理端与调度增强（1~2 周内值得做）

#### 6. 事实性限额护栏（余额阈值暂停接单，先于上游 402/429）

- **来源**：hub「事实性限额护栏」（全局/区域/Key 三层）；Buddy2api「实测总余额为 0 的账号只退出请求调度，保持 active 仍可签到」
- **功能项**：`reserve_credits`（余额 ≤ 阈值暂停）/ `daily_token_limit` / `daily_credit_limit` / `model_daily_token_limit`（只暂停该模型）；因余额暂停的账号在官方重置时间（千问 00:00 / Qoder 10:00 UTC+8，**两通道不同**）自动恢复，余额提前恢复也提前解封；查询失败不写成 0。
- **落点**：与 FEFO 快照同源（`data/expiring-snapshot.json` 管道已存在，加阈值判定）；管理端三处刷新（`/web-accounts`、`/credits`、`/accounts`）顺手更新。

#### 7. 定时调度中心（签到 / 续期 / 保活 + 重启不重复）

- **来源**：hub 调度器（09/21 签到刷余额、22 点集中刷 Token、每次巡检提前刷剩余 <4h 的 Token、状态落 `scheduler/state.json` **重启不重复签到**）；Buddy2api `CB_GATEWAY_KEEPALIVE`（22 点前 10 分钟）/ `CB_GATEWAY_AUTO_CHECKIN`（9 点）
- **现状缺口**：本项目签到链路（Qoder checkin → grants 账本）只有管理端手动入口，无排程。
- **功能项**：
  - 排程状态持久化，重启幂等；
  - 千问 00:00 重置、Qoder 每日 10:00（UTC+8）、TRAE 10:00——**按通道各自的刷新时点排程**（本项目 CLAUDE.md 已实测记录三通道差异）；
  - 「禁用仍签到」勾选（`checkinWhenDisabled`，默认关）：禁用只关选号不停保号；凭证失效与过期账号始终排除；
  - 领取结果如实四态：已到账 / 今天已领过 / 暂无可领活动 / 失败及原因 + 下次可领时间。
- **落点**：`src/scheduler.js`（新）+ `admin/routes/scheduler.js`；签到链路复用现有 qoder `checkin` 与千问积分领取。

#### 8. 会话缓存保温（闲置续期，防全量重写）

- **来源**：hub `QD_CACHE_KEEPALIVE`（闲置 <5min 用内存登记的上一份 payload 原样重发 `stream=false, max_tokens=1`；命中成本 ≈ 缓存读 10.7 credits，全量重写 ≈ 137）
- **适配判断**：千问/Qoder 上游前缀缓存有 ~5 分钟闲置过期；本项目有 stableSessionId 但**没有保温**——Codex 会话中断顿后下一轮全价。
- **工程约束（生态原文）**：保温是真实上游调用，持续闲置持续小额消耗；同会话高频重复请求的风控容忍度未知——默认关，从小间隔起步观察遥测；保温请求照常记账 `key_id=keepalive` 可审计；LRU 限 2 个会话；超 30min 不保温。
- **落点**：`src/affinity-keepalive.js`（新）；仅对 Qoder/千问 COSY 通道启用（搭子上游缓存行为未实测，不盲开）。

#### 9. 请求日志与用量视图增强

- **来源**：workbuddy panel「运行日志」（请求记录表：来源 IP·UA / X-Request-Id / 时间范围查询 / 分频道）+「用量」视图（Token 时序图 / 按模型积分每 1M token）+「积分构成」（到期分布 / 账号对比 / 逐包明细）
- **现状缺口**：本项目 `reqlogs.js` 有筛选参数与 credits 账本，但缺：调用来源（`X-Forwarded-For` 首段 → `X-Real-IP` → TCP 对端；UA 截 200 字节）、`X-Request-Id` 响应头、时间范围预设（今天/近24h/3d/7d/30d/自定义，**浏览器按本地时区算好发给服务端**防跨时区切错日子）、积分到期分布视图（grants 账本数据已有）。
- **落点**：`reqlogs.js` 加来源与 request_id 字段；管理端仪表盘加「到期分布」「按模型成本」两张卡（数据源：`qoder-grants.jsonl` / `credits.jsonl`，零新增上游调用）。
- **敏感度**：IP 属个人信息，加 `logging.request_client_info` 开关（默认开、热生效、面板可关）。

#### 10. 本地 web 工具代跑（千问通道 tools 丢失的补偿）

- **来源**：hub `QD_WEB_TOOLS`（客户端在 Responses 里声明的 `web_search`/`web_fetch`，Qoder 上游不执行——网关改写成同名 function 代跑，结果回灌继续生成，最多 3 轮）
- **适配判断**：本项目千问 `buildBody` 同样过滤 `web_search`；且千问上游有**未接入的 `/algo/api/v1/webSearch/oneSearch`**（解包已确认存在，见 `docs/QWENWORK-CLIENT-1.4.0-ANALYSIS.md`）——代跑可优先打千问自己的搜索端点，回落本地抓取。
- **安全边界（生态原文）**：只允许 http/https；拒绝带凭据 URL、localhost、私网与链路本地地址；重定向逐跳复检；响应体 4MB / 正文 20000 字上限；每轮多消耗一次账号额度，默认关。
- **落点**：`src/qwenwork/webtools.js`（新）；与已上线的 `/v1/search/web` 共用签名层。

#### 11. Anthropic 入口细节对齐（Claude Code 体验）

- **来源**：hub `QD_ANTHROPIC_MSG_SYSTEM`（messages 里 system 原位改 user 保持前缀缓存命中 / merge / drop 三态）+ `count_tokens` 本地估算端点 + 空签名 thinking block（实验性）
- **适配判断**：千问「system 必须留在 messages 里」与 Claude Code 的顶层 system 形态冲突——桥接层如何放 system 直接影响千问的纪律注入与前缀缓存。
- **落点**：本项目 Anthropic 桥（`src/server.js` 翻译层）；`POST /v1/messages/count_tokens` 本地估算（不请求上游，Claude Code 启动会调用）。

#### 12. 账号表与签到状态的小改进（管理端低成本高感知）

- **来源**：hub #111（表头排序：自然序 `Z Z2` < `Z Z10`；取不到值的沉底不随方向翻转——查询失败的账号不当成 0 混进「额度用尽」；积分列点击=剩余 / Shift+点击=已用）；workbuddy panel（健康色条 / 冷却倒计时 / 状态标签：可用·限流冷却·积分冷却·熔断·连败降权·已禁用·暂停选号）
- **落点**：管理端账号视图。所有数据本项目已有（`pool-state.json` + 三池余额），纯前端工作。

### P2 — 安全加固与锦上添花

#### 13. 凭证与面板安全套件

- **来源**：Buddy2api（Windows DPAPI 加密落盘 Token）；hub（面板密码 PBKDF2-SHA256、会话 7 天、**默认密码时看板不显示明文 Key**）；workbuddy panel（常量时间密钥比较 `subtle.ConstantTimeCompare`、CSP 安全头、UID 白名单 `[A-Za-z0-9_-]{,64}` 防路径穿越、请求归档不含 Authorization）
- **落点**：`keys.js` 比较逻辑、`admin/server.js` 响应头中间件、web 账号凭证落盘。

#### 14. 健康检查身份标识 + 自证 404

- **来源**：workbuddy panel（`/healthz` 带 `service` 字段 + `X-Service` 头，防同端口残留服务假成功）；hub（重复 `/v1/v1` 前缀返回带提示的 404 并记 WARN）
- **落点**：`src/server.js` `/health`。小改动，排障价值高。

#### 15. 输出上限主动探测脚本（TRAE / 千问目前只有 Qoder 有自学习）

- **来源**：workbuddy panel `scripts/probe_max_tokens.py`（区分静默钳制 `finish=length` 与模型主动收尾；断点续测；`--panel-out` 直接进面板显示实测值与钳制倍数，**不写死在代码里**，上游调整重跑即刷新）
- **落点**：`test/probe-max-output.js`（新脚本）+ 模型页「实测上限」列（TRAE 逐轮账本已能精确计量，探测预算可控）。

#### 16. 一键更新（管理页）

- **来源**：Buddy2api（后台核对远端版本优先走 jsDelivr 不挡页面；`git pull --ff-only` + 装依赖 + 重启；Docker/非 git 克隆时按钮说明原因；沿用已有代理环境变量）
- **适配判断**：本项目 9080 是冻结快照 + 依赖闭包同步流程，**一键更新只适用于 9082/9083 开发实例**，且必须提示「9080 发布仍走 SNAPSHOT_FROM.txt 流程」。
- **落点**：`admin/routes/meta.js`。

#### 17. 图片预处理转码（搭子/Qoder 通道适用，千问不适用）

- **来源**：hub `QD_IMAGE_TRANSCODE=auto`（≥256KiB 的 PNG/BMP/TIFF 归一为 quality=95 4:4:4 JPEG 且必须小 20% 才替换；透明图保留无损 PNG；LRU 32 条/32MiB 不落盘；转换超时仅在未输出时允许一次重试，保留 504 与上游 request_id，**不冷却账号不解绑会话**）
- **落点**：统一出站构造层；`/health` 加 `image_preflight.codec_available`。

#### 18. 凭证生命周期仪表（千问客户端凭证 / 网页凭证）

- **来源**：hub 凭证表（access/refresh/PAT 三类前缀区分有效期、按前缀选刷新接口、`TOKEN_EXPIRE`/`12153` → 停用标「需重新登录」、巡检提前刷 <4h 的）；Buddy2api「官方客户端退出时作废旧登录，已保存的号仍会失效，需要在那个号还登录着的时候导入」提示
- **落点**：千问凭证来自客户端 `auth-v2.dat`（本地算法签名后不再依赖客户端在线，但 token 本身有过期）——管理端账号行加「凭证剩余有效期 + 到期前自动提醒」；9084 多账号网页凭证池加自动续期排程（与 P1-7 调度中心合并实现）。

#### 19. Qoder 网页登录领取通道（9084 web-gateway 的补充思路）

- **来源**：workbuddy panel（网页控制台 `qoder.com/account/usage` 同样能领每日 100 Credits；每号独立浏览器 profile 免客户端续期；**SAME_PERSON 归属核验**：只读 `GET /sash/api/v1/me/campaigns/{cid}/reward` 拿本号 grantId 才算真领到，服务端明确回拒才报「额度被同一个人的另一账号领走」，证据不足如实写「归属未核实」**不猜不假报**）
- **适配判断**：本项目 Qoder 签到走 device token + `cosy-clienttype: 10`（无需签名），归属核验的**只读判据**直接适用于千问/Qoder 签到按钮的状态口径——防止把「没领到」显示成「已签到」。

---

## 四、建议落地顺序（结合本项目依赖闭包）

| 批次 | 事项 | 理由 |
|---|---|---|
| 第 1 批 | P0-1 namespace 展开、P0-4 模型锁池视图、P0-5 Key 管理 | namespace 是千问通道功能修复；后两项纯读现有状态/落点已就位 |
| 第 2 批 | P0-2 智能体一键配置（先 Codex/Claude Code/DSH 三卡）、P0-3 主动限流 | 管理端体验与防风控补层 |
| 第 3 批 | P1-6 限额护栏、P1-7 调度中心、P1-12 账号表小改进 | 共用落盘管道与调度框架 |
| 第 4 批 | P1-8 缓存保温、P1-9 日志增强、P1-10 web 工具代跑、P1-11 Anthropic 细节 | 各自独立，按需排 |
| 随手做 | P2-14 健康标识、P2-16 一键更新（限开发实例） | 改动极小 |

> 所有「明确不融合」项见第二节第二张表——这些是本项目经真机实测后**有意保持现状**的决策，生态实现不能作为推翻依据（特别是 hub 的 `X-QD-Context` 抬窗与 `QD_TOOL_ECHO_MODE` lenient）。

## 五、风险与边界提示（来自生态项目的共同教训）

1. **多账号 ≠ 无限额度**：hub 实测同一活动「同人判定」只发一份（`SAME_PERSON_ALREADY_CLAIMED`），设备指纹与 scope 均不参与判定——签到自动化必须做只读归属核验，防止假签到。
2. **版本漂移是常态**：千问客户端 worker runtime 已 1.1.71+、Qoder CLI 1.1.75、Buddy2api UA 2.109.2——所有身份常量都要留环境变量覆盖口（本项目已做到位，融合新功能时延续）。
3. **风控遥测先行再调参**：hub 明确「开启保温/守卫前先观察 `/health` 的 queue/rate/rejected 信号」——P0-3 与 P1-8 都应先上遥测再默认关闭。
4. **日志敏感度分层**：请求归档不含提示词/正文/Authorization（workbuddy panel 口径）；IP/UA 单独开关；Key 只存 sha256 指纹。
