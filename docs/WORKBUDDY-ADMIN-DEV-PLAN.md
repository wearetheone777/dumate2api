# WorkBuddy 通道管理端 · 开发计划

> 生成于 2026-11-06。依据：bsk 真实浏览管理端（9083）+ 前端组件源码与
> `src/admin/routes/workbuddy.js` 逐页交叉验证；GitHub 上游项目功能调研
> （workbuddy2api-hub / workbuddy2api-panel / workbuddy-manager /
> qoder-trae-workbuddy-switch / CreditDaddy）。
>
> **执行状态（2026-11-07 更新）**：
> - ✅ M1 全部完成（提交 141c24c + 962cc4f：九个页面级缺口 + WorkBuddyLoginState）
> - ✅ M2 全部完成（提交 09e18ed：2.1–2.7 七项，43/43 单测；2.5/2.6 的模型页
>   UI 标注待 ModelsView 并行改动合并后接入——**bb3658e 已合并**，接入仍待做）
> - ✅ M3 部分完成：**账本原子追加**（3bfc3d0，hub 教训吸收）、
>   **GET /v1/usage 下游自查**（05c33ef）
> - ⏸ M3 其余项（Key 配额/通知/自更新/热更新/多粒度聚合）：均为多人分发
>   场景功能，当前单人自用形态边际价值低——触发条件见各条目
> - ✅ 并行会话工作已归位（bb3658e：TRAE 链路状态端点 + keepalive 重启补跑/健康预警）

## 背景

WorkBuddy 是第五条通道（2026-11-03 接入，双区域 cn/global），数据面协议已跑通
（OpenAI 兼容、多账号池、OAuth 设备登录、签到、套餐包额度、计费自检探针），
但**管理端是五条通道里最薄的一条**：积分明细、登录态、用量统计三个页面
没有 WorkBuddy 分支，会回落显示搭子口径的错误内容；仪表盘缺趋势图与过期积分卡。

同时，workbuddy2api 社区（上游项目）在 2026-10-23 之后普遍确认收紧风控，
一批「运维生存型」功能（代理隔离、风控暂停可视化、token 刷新互斥）从可选变必需。

目标：分三个里程碑，把 WorkBuddy 通道的管理端补齐到与 TRAE/Qoder 同构的形态，
再融合上游项目验证过的高价值运维功能。

---

## M1 · 补齐同构通道已有形态（P0，纯对齐，不发明新东西）

工作量大头是项目内部对齐——TRAE/Qoder 的管理端形态就是验收参照。

### 1.1 积分明细页 WorkBuddy 视图

- 现状：`web/src/views/PointsView.vue` 只有 `isTw/isQw/isQd` 三分支，切到
  WorkBuddy 时**回落显示搭子的积分账本**（标题错、数据错）。
- 做法：照 Qoder 分支形态新增 `isWb` 分支。WorkBuddy 没有逐笔账单
  （公测口径 usage.credit=0），页面主体做「额度包台账」：
  逐账号逐包（名称/剩余/总量/到期日）+ FEFO 推算剩余 + 汇总行。
- 数据源：`GET /api/admin/workbuddy/credits?region=` 的 `rows[].packages[]`
  （后端已返回，前端从未展示）与 `summary` / `fefo`。
- 口径红线：推算剩余必须标注「推算」（与 Qoder grants 的 estimated 口径一致）；
  查不到的包如实 null，不补 0。
- 验收：切到 WorkBuddy 通道不再出现搭子账本；每个包能看到到期日；
  国际版账号显示「订阅制无包」而不是空表。

### 1.2 登录态页 WorkBuddyLoginState 组件

- 现状：`web/src/views/AccountView.vue` 中 TRAE 有 `TraeworkLoginState`、
  Qoder 有 `QoderLoginState`，WorkBuddy 落默认分支显示**搭子桌面客户端状态**
  （完全无关内容）。
- 做法：新建 `web/src/components/workbuddy/WorkBuddyLoginState.vue`：
  token/refresh 双到期时间、refreshExpired 状态、凭证来源、最近错误与时间。
  数据全在 `GET /workbuddy/status`（rows 里 hasAccess/hasRefresh/
  expiresAt/refreshExpiresAt/lastError/lastErrorAt）。
- 验收：WorkBuddy 通道下登录态页显示的是 WorkBuddy 账号凭证状态。

### 1.3 用量统计页换口径

- 现状：`web/src/views/UsageView.vue` 只认 isQw/isTw；WorkBuddy 落
  「今日实付 / 按账号积分消耗」——这是搭子积分口径的壳；credits 也没接。
- 做法：`isWb` 时隐藏「今日实付」卡，加「剩余积分合计 / 可用账号 / 今日请求」
  三格；credits 调用补进加载分支（照 644 行 isTw/isQw 的写法）。
- 验收：WorkBuddy 通道下用量页所有卡片数字来自 WorkBuddy 自己的接口。

### 1.4 仪表盘：趋势图 + 即将过期积分卡

- 现状：`refreshWb()` 拉了 `usage/overview?days=14` 但 `isWb` 模板分支没渲染——
  数据在手上，图没画。过期积分卡后端数据同样现成。
- 做法：复用 `renderTwChart()` 的画法（TRAE/Qoder 同款两张小倍数图）；
  过期积分卡按 `packages[].expireAt` 聚合（照搭子「即将过期的积分」卡形态，
  窗口用 expiring 快照的 7 天口径）。
- 验收：WorkBuddy 仪表盘出现 14 天请求/Token 趋势与临期积分汇总，
  数字与请求日志页对得上。

### 1.5 账号管理细节补齐（四件小活）

| 项 | 现状 | 做法 |
|---|---|---|
| 额度包明细 | credits 的 `packages[]` 前端只显示 total | 账号卡展开行或详情弹窗列逐包剩余/到期，临期包标橙 |
| 账号改名 | 后端 `PATCH /accounts/:id` 支持 nickname，前端无入口 | 账号卡标题加编辑铅笔 |
| 账号详情 | 搭子有「详情」弹窗，WorkBuddy 只有卡面一行 lastError | 详情弹窗：完整字段 + uid + domain + 创建时间 + 错误历史 |
| FEFO 新鲜度 | `/credits` 响应带 `fefo` 字段，前端没显示 | 页面角落标注快照时间与覆盖范围；超 TTL 标灰 |

---

## M2 · 上游验证过的运维生存功能（P1）

> 共同背景：hub 与 panel 的 README 均记录上游 2026-10-23 起收紧非官方客户端
> 识别。以下功能优先做「不增加上游探测面」的面板侧能力。

### 2.1 每账号独立出口代理

- 出处：hub「每账号独立代理槽（HTTP/SOCKS5+账密认证，登录与调用同出口）」、
  workbuddy-manager「账号出口线路」。
- 落点：`src/proxy-agent.js` 已有 `getAgentFor(a)` 钩子，auth 存储加
  `proxy` 字段 + 管理端 PATCH 入口 + 账号卡代理标识。
- 关键口径：OAuth 浏览器登录也走选中代理（登录 IP = 调用 IP）。
- 验收：给账号配代理后，出站请求源 IP 变化（可用诊断脚本核对）；
  未配代理的账号行为不变。

### 2.2 风控连坐暂停可视化

- 出处：hub「403/11140 全区域暂停 + 面板实时倒计时 + 一键解冻 + 可配时长」。
- 落点：`src/pool.js`（channel-pool 已有冷却状态）暴露暂停态 →
  `GET /workbuddy/status` 加字段 → 管理端顶部横幅（倒计时 + 解除按钮）。
- 验收：模拟风控冷却时仪表盘出现横幅；解冻后立即可用；冷却参数可环境变量覆盖。

### 2.3 Token 刷新互斥守卫（refreshGuard）

- 出处：CreditDaddy。WorkBuddy 是 refreshToken 轮换制（`src/keepalive.js`
  已注明），官方客户端与网关并发刷新会互相踢成 invalid_grant。
- 做法：刷新前重读存储里最新的 refreshToken 对齐（防用过期旧值），
  成功后原子回写；客户端进程持有该账号时跳过自动刷新。
- 验收：并发触发两次刷新只有一次上游调用；invalid_grant 率下降（日志可证）。

### 2.4 账号分组 + 组内批量操作

- 出处：hub #707、workbuddy-manager。
- 做法：auth 存储加 `group` 字段；账号管理页分组筛选/分组启停；
  批量签到/刷新凭证/连通性测试只作用于选中组；导入时可选组。
- 验收：多账号下能按组一键签到；删除组不删账号。

### 2.5 模型输出上限实测探针

- 出处：panel `scripts/probe_max_tokens.py`（实测 16 个 CN 模型 8 个被上游
  静默钳制）。
- 做法：探测脚本按模型二分/阶梯试 max_output，结果落盘
  `data/workbuddy-output-probes.json`（clamped/at_least/inconclusive 三态）；
  模型管理页「最大输出」列红/绿/灰标注 + 超 30 天褪色。
  实测值不写死代码——重跑脚本即刷新。
- 验收：对已知被钳制的模型显示红色；探针请求走 `probe: true`
  （不惩罚账号，与 billing-check 同口径）。

### 2.6 成本分层选号 + 实测单价台账

- 出处：panel costTier / NoteModelCost（EMA 持久化）。
- 做法：billing-check 已能测单次倍率，缺**持久化台账**——每次探测与真实
  流量的 usage 落 EMA（credits ÷ 千 token），存储到
  `data/workbuddy-rate-ledger.jsonl`；模型页显示实测 vs 标称偏离；
  池子按成本档选号（可选开关，默认关）。
- 验收：台账行数随请求增长；模型页能看到「标称 0.34 / 实测 EMA 0.36」。

### 2.7 概览待办清单 + 计划任务抖动

- 出处：Buddy Switch「概览待办」、多时点 + 随机抖动。
- 做法：仪表盘顶部三类待办（需重登 / 今日未签到 / 积分将过期）一点直达；
  keepalive 的签到/保活排程补 ±20% 抖动与多时点配置。
- 验收：待办项与实际状态一致、处理后消失；任务触发时间不再整点齐发。
- **状态：✅ 完成（bb3658e 时核对）**。待办清单见 DashboardView；抖动核对时
  发现项目已有比 ±20% 更合理的实现——`computeNextRunAt` 的
  `[时点, 时点+jitter_minutes]` 随机后延（默认 30 分钟，管理端可调 0~120，
  只后延不提前以留在低峰窗口），「防整点齐发」目标已达成；多时点配置
  无真实需求（单账号组每日一轮），不造。

---

## M3 · 看需求再决定（P2）

> **触发条件**：以下均为多人/分发场景功能。单人自用（Codex CLI / Claude Code /
> cc-switch 直连）时按兵不动；出现「把 key 发给别人用」「部署到公网」的需求
> 时再按此表实施。

| 项 | 出处 | 说明 | 状态 |
|---|---|---|---|
| 下游密钥自查端点 `GET /v1/usage` | workbuddy-manager | 给下游 Key 使用方查已用/剩余 | ✅ 05c33ef |
| **账本原子追加** | hub 实测文本追加并发丢行 7.3% | 整行单次 os.write + 跨进程锁 + rotate/append 窗口互斥；6 个写路径全部收口 src/jsonl.js | ✅ 3bfc3d0 |
| Key 配额维度（上限×重置周期、模型通配符白名单、吊销/恢复三态） | Buddy Switch / hub | KeysView 扩展；`/v1/usage` 的 quota 字段已留位 | ⏸ 多人分发时 |
| 用量多粒度聚合（小时层/分钟环、Key×模型×账号透视） | hub `usage/` | 与 M2.6 台账共用存储 | ⏸ 对账需求出现时 |
| 自更新/回滚体系 | hub wb_updates | 检查更新、sha256 校验、备份保留、面板回滚 | ⏸ 远程部署时 |
| 在线配置热更新 | panel livecfg | 密钥/冷却/池参数面板改完即生效（livecfg 已有底座） | ⏸ 参数频繁调整时 |
| 国际版每日活跃打卡的管理端开关与执行记录 | hub wb_webagent（协议已在 `src/workbuddy/webagent.js` 移植） | 只差定时开关 UI 与执行历史 | ⏸ 国际版跑量时 |
| 全量调用审计 + 入站 IP 白名单 + 只读 API Token | workbuddy-manager | 多人用时再上 | ⏸ 多人用时 |
| 通知推送（邮件/QQ 机器人） | workbuddy-manager | 签到失败/账号异常/积分临期 | ⏸ 多账号上量时 |

## 明确不做

- **媒体生图/生视频网关、CodeArts 第三出口**（hub）：新增上游请求形态，
  扩大风控探测面，与本项目运维取向相反。
- **照抄 panel 的 UI**：已停维护（2026-10-21），单文件面板与本项目 Vue
  多页架构不同构——只吸收探针落盘/成本台账/livecfg 三个设计思想。
- **多上游实例管理**（workbuddy-manager）：单网关多通道架构不适配。

---

## 里程碑与依赖

| 里程碑 | 内容 | 依赖 | 预估相对工作量 |
|---|---|---|---|
| M1 | 1.1–1.5（九个页面级缺口） | 无，后端数据全部现成 | 基准（纯前端 + 少量路由字段） |
| M2 | 2.1–2.7 | 2.1/2.3 动 auth 与 keepalive，建议先做；2.5/2.6 依赖探针框架统一 | ≈ M1 的 1.5 倍 |
| M3 | 按需挑选 | 多数依赖 M2 的台账/审计存储 | 按项另估 |

## 执行纪律（沿用项目既有约定）

- 所有改动在 9082 开发网关验证，界面看 9083；不动 `stable/`、不重启 9080。
- 每项带离线验证：M1 的前端改动用 `pnpm --dir web build` + bsk 真机走查；
  M2 的守卫/探针/台账各配 `test/verify-*.js` 或 `test/unit/*.test.js`，
  参照 verify-expiring-fefo.js 的「内部推导必须可从外部喂真实形状数据」教训。
- 数据落盘一律原子写 + TTL 口径标注；查不到给 null 不编数；
  推算口径必须带 estimated 标记——三条是本项目反复用血换来的界面口径红线。

## 调研来源

- [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub)（3582★，v1.10.11，活跃）
- [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel)（4723★，2026-10-21 停维护）
- [ithtelab/workbuddy-manager](https://github.com/ithtelab/workbuddy-manager)（2438★，纯管理面板）
- [NextAgentX/qoder-trae-workbuddy-switch](https://github.com/NextAgentX/qoder-trae-workbuddy-switch)（314★，桌面工作台）
- [techysy/CreditDaddy](https://github.com/techysy/CreditDaddy)（155★，多产品线签到聚合）
