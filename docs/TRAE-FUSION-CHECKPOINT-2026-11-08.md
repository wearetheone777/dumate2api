# TRAE 调研融合批次 — 开发检查点（2026-11-08）

## 目标与依据

调研文件：`docs/TRAE-GATEWAY-MERGE-FEATURES.md`（2026-11-07，20 项）。
用户要求按其开发 TRAE 通道内容。仓库基线：`main @ 60bd5ee`（工作区干净），Node v24.9.0。
按项目纪律：改动只在 `src/` / `web/` / `test/unit/` / `docs/`，`stable/` 与 9080 不动。

## 逐项现状核对（第一性原理，不照抄调研结论）

| 项 | 调研缺口 | 仓库现状（证据） | 结论 |
|---|---|---|---|
| P0-1 9074 自愈 | 未实现 | `src/traework/checkin.js` 已有换设备 + 温和指数退避 + `respectBackoff`；`auth.rotateDevice`、task-scheduler 错峰、前端「退避 Ns」齐全 | 已实现，不重复 |
| P0-2 Key 治理 | 只有基础 CRUD | `keys.js` 有 `daily_limit` / `model_allowlist` / `channel` / `region`，`key-quota.js` 计数，网关统一 429/403 | 已实现；fnmatch 通配为增量 |
| P0-3 自动降级 | 无 | 无 | 实现，默认关闭；只认确证额度/订阅错误，不静默换模型 |
| P0-4 模型开关 | enabled 是总开关 | 无 `modelEnabled` | 实现两态开关 |
| P0-5 Max 可视化 | env 开关要重启 | `models.normalize` 已有 `maxMode`；`remote.maxModeRequested` 认 env/单次字段/白名单 | 实现运行态配置 + 支持模型只读端点 |
| P1-6 告警 | 无主动推送 | `notify.js` 五种 webhook + `keepalive.healthAlerts` crit 推送已在 | 已实现基础闭环；七类规则/静默窗为增量 |
| P1-7 预刷新 | 被动刷新 | `keepalive` 四通道 adapter 24h 预刷新 + 刷新单飞 + 错峰已落地 | 已实现 |
| P1-8 配置备份/恢复 | 无一键快照 | `/system/backup` 已有**配置类**导出（含 keys/admin-users），无恢复 | 实现 restore（备份当前 + 原子写 + 密钥保护） |
| P1-9 实时日志页 | 只能看控制台 | 无 | 实现进程内环形缓冲 + 脱敏 + SSE，只读 |
| P1-10 侧栏角标 | 无跨页汇总 | 无 | 实现汇总端点 + 侧栏角标 |
| P2-11 升级模型标记 | 无 | `upstream-errors` 已把 403/1005「订阅专享」归 model（不是风控），但模型页没有徽标 | 实现字段 + 徽标（只认上游/真机错误证据） |
| P2-12 并发槽位 | 单账号无上限 | `channel-pool` 已有通道级在途帽 `DUMATE_TRAEWORK_INFLIGHT_MAX` + 最小间隔，池 `acquire` 按 uid | 已实现；账号级独立档位为可选增量 |
| P2-13 积分优先 | 仅轮转/FEFO | 无 | 实现纯函数策略 + 可选开关（默认关） |
| P2-14 批量运维 | 无 | 无 | 实现 `/accounts/batch`，逐条隔离，恢复保留上游冷却 |
| P2-15 一号一出口 | 无 | `proxy-agent.js` 已支持 per-account proxy（显式字段） | 已有等价；稳定哈希自动分配不做（无代理池配置证据） |
| P2-16 凭证护栏 | 无 | `pool.floor_blocked` 有保底拦截 | 只实现「保留积分」读判据，默认关；另三项需产品设计 |
| P2-17 /metrics | 无 | 无 | 实现 Prometheus 文本端点，复用 usage 聚合 |
| P2-18 月度账单 CSV | 无 | `usage.js` 有流水聚合 | 实现按月 + CSV（BOM、公式注入防护） |
| P2-19 图片输入 | 无 | `index.assertImageSupport` + `images.hasImageContent` 已落地 | 已实现 |
| P2-20 kill switch | 无 | 无 | 实现热配置开关，只拦 `/v1` 模型面，管理台照常 |

## 不实现的项（与既有定案冲突，逐条给出理由）

- 会话亲和、`previous_response_id`、一键自更新、三角色、成长中心、自动模型路由、4008 翻译：调研文件第四节已定案不融合。
- P2-15 的「sha256 稳定分配代理」：本机无代理池配置项，按哈希把账号绑到不存在的出口是编数据；现有 `proxy-agent` 已让每个账号显式持有固定出口，且签到/换票/对话共用同一 agent。

## 设计纪律

1. 不写兜底掩盖主流程：错误必须带原因；余额未知 `null` 不填 0；配置非法在入口 400。
2. 显式契约：自动降级、积分优先、护栏、kill switch 一律默认关闭；降级响应带 `X-Trae-Degraded`。
3. 通道 id / 判据单一来源：新逻辑优先复用 `channels.js`、`upstream-errors.classify`、`expiring.js`、`channel-pool`。
4. 跨进程热配置复用 `livecfg.js`（mtime 失效 + 原子写）；运行态 TRAE 专用配置单独落 `data/traework-runtime.json`。
5. 不碰 `stable/`；不启动/重启 9080；真机冒烟只用隔离端口和管理端只读端点。

## 验收

- 新增 `test/unit/trae-fusion-*.test.js`：纯函数 + 编排，离线打桩，不依赖真机账号。
- `node --test "test/unit/*.test.js"` 全量单测绿；`npm run verify` 记录结果。
- `cd web && npm run build` 类型检查通过。
- 隔离端口起管理端，用 admin 登录态冒烟新端点（只读优先），确认路由与鉴权。
- 更新调研文件状态列与 `CLAUDE.md` 融合落地结论（只写实测过的）。

## 实施结果（2026-11-08 收尾）

### 新增文件

| 文件 | 作用 |
|---|---|
| `src/trae-runtime.js` | 运行期配置（降级/Max/选号/护栏/全站暂停），原子写 + mtime 热读 |
| `src/traework/degrade.js` | 降级判据与计划（纯函数）+ 余额预警 |
| `src/traework/policy.js` | 积分优先排序 + 保留积分护栏 + 无可用账号原因 |
| `src/traework/batch.js` | 批量运维编排（逐条隔离、恢复保留冷却） |
| `src/config-restore.js` | 配置恢复（白名单、先备份、原子写） |
| `src/admin/logbuffer.js` | 运行日志环形缓冲（入缓冲前脱敏） |
| `src/admin/alerts.js` | 七类告警规则 + 静默窗/迟滞/恢复 |
| `src/admin/routes/{trae-runtime,alerts,logs,metrics,monthly-billing}.js` | 对应管理端点 |
| `web/src/api/traeruntime.ts` | 前端 API 封装 |
| `web/src/views/{TraeRuntimeView,ServerLogsView}.vue` | `#/trae-runtime`、`#/logs` |
| `test/unit/trae-fusion-*.test.js`（4 个） | 24 项离线测试 |

### 改动文件要点

- `src/traework/auth.js`：`modelEnabled` 字段 + `findModelUsable()`；`list()` 透出两态
- `src/traework/index.js`：`send` 拆成降级编排层 + `runSendOnce`；选号接策略/护栏/模型开关；`status()` 区分「无账号」与「全部关闭模型请求」
- `src/traework/remote.js`：`maxModeRequested` 接受运行期配置，白名单优先级明确
- `src/traework/models.js` / `src/model-info.js`：`upgradeRequired`（只认 descriptor 显式字段）
- `src/server.js`：全站暂停闸门（鉴权前）、`onDegraded` 响应头/SSE 注释帧
- `src/keys.js`：`modelMatches` + fnmatch 通配（无通配符时行为不变）
- `src/admin/routes/traework.js`：`/status.alerts`、`/credits.warnings`、`/links.runtime`、`PATCH modelEnabled`、`/accounts/batch`（注册在动态段之前）
- `src/admin/routes/system.js`：`POST /restore`、备份响应 no-store
- `src/admin/server.js`：挂载五个新路由组、根 `/metrics`、日志缓冲安装、告警排程启停

### 真机冒烟记录（隔离实例 9123/9124，独立 DUMATE_ADMIN_DATA）

- `/api/admin/healthz` → `{service:"dumate2api",role:"admin"}`；未登录访问新端点 → 401
- 只读端点全部 200：`trae-runtime`、`traework/status`（3 账号 + alerts 汇总）、`logs`、`alerts`、`monthly-billing`、`metrics`、`trae-runtime/max-mode/models`（上游表 51 个、声明 max_mode 0 个）
- 运行态 PUT（credits-desc + 降级开 + warnBelow=100）返回完整快照；随后复位；非法键 400
- `system/restore` 传白名单外路径 → 400；`accounts/batch` 空 ids → 400；批量 export 3 条（2 成功 1 不存在）且不含 token
- `/logs/stream` 先回放再推新；`monthly-billing/export` 头 4 字节为 `EF BB BF`（UTF-8 BOM）
- 根 `/metrics`：未配 token 200，配 token 后无/错 token 401、正确 token 200
- 9080/9082/9083 全程未启动、未重启、未改动

### 未完成/明确不做

- 降级真机链路（额度耗尽 → 备用模型 → `X-Trae-Degraded`）：需真实额度耗尽账号，编排由 `trae-fusion-degrade-flow.test.js` 4 项打桩端到端锁定
- P2-15 代理池哈希分配：无配置项证据，保持现有「账号显式 proxy 字段」
- P2-16 另三项（每日 token/积分上限、按模型 token 上限）：需产品设计与存储，未做
- P1-9 只覆盖管理端进程日志；网关进程日志仍看启动器落盘文件（跨进程搬运需改启动器或 IPC）

---

## 真机可见性返工（2026-11-08 晚）

> 用户反馈「管理端看不到任何新增功能」。排查结论：**功能都在，但有两处交付缺陷
> 让它在界面上不可见**。两条都记进了 `CLAUDE.md` 的陷阱清单。

### 1. `index.html` 被浏览器启发式缓存

`sendFile` 对 html 与带 hash 的 js 都不发缓存头。`index.html` 是入口清单，写死了
本次构建的 chunk hash；新构建删掉旧 hash 的 js 后，浏览器仍按旧清单请求已不存在的
文件 → 界面停在旧版，普通刷新无效。

修：`.html` → `no-cache` + 内容 sha1 `ETag`（命中 304）；其余 → `immutable`。
`serveStatic`/`sendFile` 改为显式接收 `req`（读 `if-none-match`），不用 `res.req`。

### 2. TRAE 账号卡的两个开关「看起来只有一个」

`size="small"` 的 `a-switch` **不渲染 `checked-children` 文字**，总闸与模型开关
外观完全相同且上下相邻。DOM 断言（`kids: 2`）是过的，截图里却只有一个——
这正是「接口 200、界面无感」的典型。

修：两个开关各配外部文字标签（「启用」/「接模型」，关闭态标签变橙）+ 卡片
「不接模型」徽标；同时补上批量运维 UI（勾选框 + 批量签到/探活/暂停/恢复/导出），
切换通道/区域时清空选中集合。

### 3. 顺带修掉的测试环境依赖

`verify-dumate-source.js` 的「auto 模式回落」用例隐含前提「本机 8980 没在跑」。
开发机 8980 在监听时请求会直连成功 → 24/26 假失败（`git stash` 撤掉本批改动
后同样 24/26，确认与功能无关）。修：用例前把 `DUMATE_UPSTREAM_PORT` 指向一个
向 OS 申请后立即释放的端口（`router.targetOf()` 每次请求现读该变量），前提变确定。

### 界面实测（系统 Edge 无人值守驱动 9083，admin 会话）

- 侧栏：`… 账号管理 | 运行策略 | 运行日志 | 接入配置 | 账户管理`
- `#/trae-runtime` 含「自动降级」、`#/logs` 含「只读进程内缓冲」、无前端报错
- TRAE 账号卡：两个带标签开关 + 批量勾选框可见
- 勾选 → 批量条「已选 1 个」出现；点「接模型」→ 接口 `[[1,true]]` → `[[1,false]]`
  真的落库，随后还原
- 健康卡「额度未知 1」与 `/trae-runtime.accounts.creditsUnknown` 一致
  （首次截图是 1.5s 中间态，2.6s 后正确）

### 回归

全量单测 659/659、`npm run verify` **41/41**、前端 `npm run build` 通过。
9083 已按 `DUMATE_ADMIN_PORT=9083 DUMATE_ADMIN_GATEWAY_PORT=9082` 重启；9080/9082 未动。

---

## 补齐「后端有、界面没有」的剩余项（2026-11-08 第三段）

用户反馈后做的系统性复查：**逐个新端点对照前端引用**，发现两个真缺口。

### 1. 运维告警没有界面（`/api/admin/alerts` 只有后端）

新增 `web/src/views/OpsAlertsView.vue`（`#/alerts`）+ `web/src/api/alerts.ts`：
七类规则的阈值可改（viewer 只读禁用）、当前活跃告警表、立即评估/评估并推送、
最近一次评估结果（区分「命中」与「实际推送」并解释静默窗）、Prometheus 抓取地址与预览。
菜单入口走 `menuKeys`（五条通道都注册，因为这功能与通道无关），带未恢复告警角标。

### 2. `/metrics` 完全无入口

同一页底部给出抓取地址、标签纪律说明（不含账号 id / Key / req_id）、前 20 行预览。

### 3. 顺带修掉一个「狼来了」设计缺陷

真机评估后 `off_hours`（非工作时段请求）进了「活跃告警」并点亮侧栏红色角标——
个人自用深夜用一下是常态，这会让红灯天天常亮，正是 `notify.js` 头注释警告的情形。

改：`off_hours` 定为 **info 级 = 提示**，保留在 `active` 里（页面能看到发生过），
但 `notify` 不推、`actionable` 不计、侧栏角标不数。`assess()` 新增返回
`actionable`（warn/crit），`/api/admin/alerts` 同时给 `actionable` 与 `hints`，
新增 `HINT_RULES` 常量。测试锁住「info 进 active、不进 notify、不进 actionable」。

另修：`a-badge` 的 `count=0` 仍渲染 0，加 `:show-zero="false"`。

### 界面实测（系统 Edge，admin 会话）

- 菜单含「运维告警」；页面含「当前活跃告警 / 规则阈值 / 账号池见底 / Prometheus 指标 / Token 即将到期」
- 12 个阈值输入框；点「立即评估」出现「最近一次评估」卡
- 告警分级：`active=1, actionable=1 (budget/warn), hints=off_hours`；侧栏只显示角标 1
- 无前端报错

### 测试过程中发现的两个测试自身错误（如实记录）

1. `assess(facts, { cfg })` 参数名应为 `config`——传错会被静默忽略、落回默认
   `hysteresis=2`，表现为「规则不触发」。这是测试写法错误，不是实现缺陷。
2. `minUsable: 0` 时 `0 < 0` 为假，`pool_empty` 不命中——阈值必须严格大于计数。

### 回归

全量单测 **660/660**、`npm run verify` **41/41**、`npm run build` 通过。
9083 已重启（PID 13212）并带全部改动；清理了手动评估写入的 `off_hours` 历史状态
（保留真实的 `budget` 告警：今日 1.62 亿 token 属实）。
