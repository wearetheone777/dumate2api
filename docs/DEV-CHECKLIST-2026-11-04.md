# dumate2api 后续开发清单（2026-11-04）

> 基线：`main @ ac5d357`（WorkBuddy 第五通道、全页面区域视图已落地）。
> 口径：只列**尚未落地**的项。已完成项以 [FUSION-BACKLOG-2026-10-31.md](FUSION-BACKLOG-2026-10-31.md) §10-13 与根 `CLAUDE.md` 为准，本清单不重复。
> 每条给出：**动机 / 证据 → 落点 → 前置 → 验收**。验收优先离线脚本（`test/unit/*.test.js` 或 `test/verify-*.js` 打桩），真机项单独标注。
> 图例：**P0** 有明确证据、收益直接，随时可开工；**P1** 需一次真机 / 账号取证才能定案；**P2** 战略级或大工程；**⛔** 已定案阻塞（列出防止翻案，不是待办）。

---

## 摘要

| # | 优先级 | 项目 | 通道 | 预估 | 状态 |
|---|---|---|---|---|---|
| 1 | P0 | 「播报即收尾」修复接入 WorkBuddy | WorkBuddy | 低-中 | ✅ 已完成（见 §P0 落地记录） |
| 2 | P0 | 9084 多账号网关补流式 `tool_use` | 9084 | 中 | ✅ 已完成（离线验证；真机未跑） |
| 3 | P0 | 文档漂移修正 | 工程 | 低 | ✅ 已完成 |
| 4 | P0 | WorkBuddy 计费自检探针 | WorkBuddy | 低 | ✅ 已完成（离线验证；真机受阻于账号） |
| 4b | P0 | WorkBuddy 浏览器 OAuth 登录（多账号正路） | WorkBuddy | 中 | ✅ 已实现（协议两实现交叉验证，state 端点实测 200；待你浏览器完成一次登录即入池） |
| 5 | P1 | WorkBuddy 图像输入真机验证 | WorkBuddy | 低 | ✅ 已实测（2026-11-04）：glm-5.3 / deepseek-v4.1-flash 发红色 PNG 都答「红色」，透传天然支持，无需改码 |
| 6 | P1 | WorkBuddy usage 缓存形状实测 | WorkBuddy | 低 | ✅ 已实测（2026-11-04）：上游二次请求 `hit=1024` 且标准位 `cached_tokens=1024` 同步填充，**无需 usage-norm** |
| 7 | P1 | WorkBuddy DSML 解析接入 | WorkBuddy | 低-中 | ✅ 已完成（2026-11-04）：非流式 aggregate 出口接 `repair.aggregateDsmlFallback`（顺带收敛 Qoder 内联、补齐千问当年漏掉的非流式出口）；编排层 4 项测试锁住。真实上游 DSML 样本仍待自然出现 |
| 8 | P1 | WorkBuddy 套餐到期解析 + FEFO | WorkBuddy | 中 | ✅ 已完成（2026-11-04，真机验证）：CycleEndTime 北京时间解析 + 窗口 7 天 + 全量写快照 + fefoUidSet |
| 9 | P1 | TRAE 宝免费豁免活动期结束复核 | TRAE | 低 | ✅ 已复核（2026-11-04 提前触发）：**豁免已结束**——大输出实测 1022 tokens 扣 0.17（≈0.157/千token，与 solo 同量级）；界面「免费」文案已撤 |
| 10 | P1 | Qoder 国际活动域 `center.qoder.sh` | Qoder | 低 | 需一个国际账号 |
| 11 | P1 | Qoder PAT 端到端验证 | Qoder | 低 | 需组织 / SSO 账号签发真 `pt-` |
| 12 | P2 | 千问 ACP 会话通道（P2-17） | 千问 | 高 | 附件 / 图片输入的**唯一**出路 |
| 13 | P2 | TRAE Remote 链路扩展 | TRAE | 中-高 | tools / Max 档位 / 修复轮覆盖待做；**intl 基址已探测（2026-11-04）：SG 分片 403、另两主机 404——证据不足维持拒绝，见 §7 第五批** |
| 14 | P2 | 搭子 `video_elements` 分镜 / 首尾帧 / 对白 | 搭子 | 中 | 文生视频最小版已通，可控管线未做 |
| 15 | P2 | Qoder 单号并发 / 节奏闸门 | Qoder | 中 | 降 10605 排队与风控画像 |
| 16 | P2 | 搭子 Agent 侧能力（逐条见 §七） | 搭子 | 高 | CDP 中继 / IM 桥 / 记忆库 / MCP 写入 / opencode Agent / BOS / 云端 Agent SSE |
| 17 | P2 | 千问企业身份 / automations / 区域端点 | 千问 | 中-高 | 逐条带阻塞原因（§八） |
| 18 | P2 | TRAE `llm_raw_chat` 链路 / 设备绑定 ECDSA | TRAE | 高 | 均等真实需求触发再立项 |
| 19 | P2 | 平台横向：`/v1/models` 元数据统一、per-key 限流 | 平台 | 中低 | 缓办项，需产品设计 |
| 20 | 运维 | `stable/` 快照发布 | 运维 | 低 | 现快照**不含** WorkBuddy、区域视图与本次 P0；发布仍需用户决定 |
| 21 | 工程 | 全量回归聚合脚本 | 工程 | 低 | ✅ 已完成（`npm run verify` = unit + 39 个离线 verify 一条命令；首跑即抓出 6 个陈旧脚本并修复） |

---

## P0 落地记录（2026-11-04）

> 全部改动只在 `src/` 与 `web/`（开发实例 9082/9083 范围），**`stable/` 与 9080 未动**。
> 真机验证受账号阻塞（WorkBuddy 国内登录态 9/18 已死、国际账号 11140），下列条目的
> 编排正确性由离线脚本锁定，真机样本待账号恢复后补。

### 1. WorkBuddy 接入「播报即收尾」修复 ✅

| 文件 | 改动 |
|---|---|
| `src/repair.js` | 注释与 `envCaps` 文档补 WORKBUDDY 段（行为无改动，四通道共用一份实现） |
| `src/workbuddy/chat.js` | 新增 `hasFunctionTools`（与 qwenwork 同名函数同口径） |
| `src/workbuddy/index.js` | `runConversation` 重写：带工具的请求启用修复——流式正文过 `createChunkGate`（reasoning 直发、正文缓冲、tool_calls 先冲刷、usage/finish/[DONE] 轮末补发），非流式聚合后判定；`err.sent` 口径含门放行；**顺带修掉流式结束帧的既有 bug**：原发 `data: [DONE]\n\n`，经 `server.js` 二次加前缀变成 `data: data: [DONE]`，改为裸 `[DONE]`（与千问/Qoder 一致，由桥统一包装） |
| `test/verify-workbuddy-repair.js`（新） | 39 项：重试/上限/正常收尾/无工具不缓冲/长正文/关闭开关/非流式/错误不变形/`err.sent` 两态，全部打桩 `chat.postStream`/`readStream` |

环境变量：`DUMATE_WORKBUDDY_REPAIR_RETRY`（默认 1）、`DUMATE_WORKBUDDY_HOLD_CAP`（默认 600）。
**待补**：真机一次带工具的 Codex 会话样本（等 WorkBuddy 账号可用）。

### 2. 9084 多账号网关补流式 `tool_use` ✅

| 文件 | 改动 |
|---|---|
| `src/web-gateway.js` | `translateStreamToAnthropic` 补工具块：text 块后按顺序发 `content_block_start(tool_use)` + `input_json_delta` + `content_block_stop`，`stop_reason` 有工具即 `tool_use`；空正文+有工具时不发空 text 块；无名工具丢弃并 WARN；导出函数供单测 |
| `test/unit/web-gateway-anthropic-tools.test.js`（新） | 6 项：纯文本序列不变、文本+工具顺序、仅工具、无名工具、空响应旧行为、thinking 块 index 递增 |

**待补**：起 9084（`node src/web-gateway.js`，需网页凭证）跑一次 `/v1/messages` 流式工具真机冒烟。

### 3. 文档漂移修正 ✅

- `CLAUDE.md`：通道清单补 `workbuddy`；API Key 区域绑定段改为五通道、TRAE 国际版已接入（`traework-intl` 不再是空预留）；环境变量表补 `DUMATE_WORKBUDDY_*` 5 条；数据文件表补 `workbuddy-accounts.json`；WorkBuddy 节新增第 7 条（修复轮 + 计费自检 + `[DONE]` bug）；修复/DSML/验证段落由「三通道」改为四通道。
- `src/keys.js`：注释「四条通道」→ 五条、TRAE 国际链路「未接入」→ 已接入。
- `docs/USER_MANUAL.md`：补 WorkBuddy 行与凭证说明；「四条上游/四通道」→ 五条；API Key 段改为**强制鉴权**现状（原写「默认不校验密钥」已过期）；区域视图、模型前缀、签到通道、安全表同步。

### 4. WorkBuddy 计费自检探针 ✅

| 文件 | 改动 |
|---|---|
| `src/workbuddy/billing.js` | 新纯函数 `billedRate` / `ratioOf` / `attributeDelta`（与 TRAE 同定位）。**符号方向必须与 TRAE 相反**：WorkBuddy 接口给的是套餐**剩余**（递减），消耗 = 前 − 后——照抄 TRAE 的 consumed 递增口径会把消耗全算成负值、探针永远测不到（本次单测当场抓到并修正） |
| `src/admin/routes/workbuddy.js` | `GET /billing-check?model=&region=`：小请求（数 1~400）+ 全账号剩余额前后快照，轮询 4 次约 8 秒；服务账号按 `onAccount` 归属；没测到给 null 不编 0；国际版无 credits 接口如实 `unsupported` |
| `web/src/api/workbuddy.ts` + `web/src/views/ModelsView.vue` | 模型页 WorkBuddy 卡「计费自检」按钮 + 结果条（挑最低倍率付费模型；免费档不做除法） |
| `test/unit/workbuddy-billing.test.js`（新） | 7 项：换算/四舍五入、0 与负值边界、免费档 ratio、归属三态、并发不串账 |

**真机首批（2026-11-04，账号「如约而至」）**：管理端模型页点「计费自检」
（glm-5.3-flash，1012 tokens）→ 首次 Δ=1、ratio 12.35；复测 Δ=null。
**套餐剩余额是整数积分**（该号 80 个裂变包，remain 全为整数），单请求 Δ 最小
只到 1，换算成倍率的分辨率 = 1 ÷ (tokens/1000)——1012 tokens 时 ±0.988，
比标称 0.08 粗一个数量级，**此时 ratio 是量化伪影**（首次的 Δ=1 更可能是早先
几次对话的结算延迟串入）。处置：响应新增 `resolution` 字段并在界面显示；
分辨率 > 标称一半时 warning 明确写「比值不可判读」；新增 `?count=2000`
（约 10k tokens）供大样本复测。**待补**：大样本真机样本（count=2000）。

### 5. WorkBuddy 浏览器 OAuth 登录（追加，2026-11-04）

> 用户指出「浏览器登录过国内版，为什么不行」「不然怎么多账号」。排查结论：
> 浏览器 cookie 与模型接口要的 Bearer token 不是同一套凭证，不能直接复用；
> 但官方有**设备授权流程**把浏览器登录桥接成 CLI token——这正是多账号的正路。
> 协议取自两个开源实现（`linguo2625469/workbuddy2api-panel` 的
> `cmd/login/main.go`、`ardeyouxipianyi/workbuddy2api-hub` 的 `wb_accounts.py`），
> 且 state 端点本机实测 200 返回授权链接。

| 文件 | 改动 |
|---|---|
| `src/workbuddy/login.js`（新） | `startLogin`：`POST /v2/plugin/auth/state?platform=CLI` → `{state, authUrl}`；`pollLogin`：`GET /v2/plugin/auth/token?state=`（等待码 **11217**）→ `accessToken/refreshToken/expiresAt|expiresIn/domain` → `GET /v2/plugin/login/account` 取 uid（失败回落 JWT `sub`）→ 区域红线校验 → `authStore.upsert`（`source='oauth'`） |
| `src/admin/routes/workbuddy.js` | `POST /workbuddy/login/url`、`POST /workbuddy/login/poll`（成功入池写审计） |
| `web/src/api/workbuddy.ts` + `WorkBuddyAccounts.vue` | 账号页「浏览器登录」按钮：打开官方登录页 → 2 秒轮询（10 分钟窗口）→ 自动导入并刷新列表；多账号提示 |
| `src/workbuddy/auth.js` | 刷新头按区域对齐 hub：国内 `X-Auth-Refresh-Source: workbuddy`、国际 `plugin`，补 `X-User-Id` / `X-Domain` / `X-CodeBuddy-Request` / `Accept-Language` |
| `test/unit/workbuddy-login.test.js`（新） | 8 项：state/token 信封、pending=11217、到期四种口径、区域红线、JWT 回落、端到端入池、网络错误按 pending |

**真机（2026-11-04）**：`startLogin('cn'/'global')` 均返回 ok 与官方授权链接
（`copilot.tencent.com/login?platform=CLI…` / `www.workbuddy.ai/login?platform=CLI…`）；
`pollLogin` 未登录时实测走 pending 分支（上游等待码 11217）。

**真机登录成功（2026-11-04）**：用户账号「如约而至」（cn，`source=oauth`）已入池；
随后真机验证 `glm-5.3` 对话 →「收到」，1.9 秒，usage 完整。
顺带取证两条（原 P1 项）：
- **usage 缓存字段无需归一**：同一段长 prompt 连发两次，第二次
  `prompt_cache_hit_tokens=1024` 且标准位 `prompt_tokens_details.cached_tokens=1024`
  同步填充——上游本身就是标准 OpenAI 形状（此前按 DeepSeek 风格推断是错的）。
- `usage.credit` 在付费档（rate 0.08）短请求下仍为 0，**不能当单请求扣费**；
  计费自检维持「套餐剩余额前后差值」口径。

**后续（已验证不再阻塞）**：账号页「浏览器登录」已跑通全链路；WorkBuddy 的
修复轮真机样本与计费探针现在都可以用这个账号补跑。

**UI 真机验证（2026-11-04，bsk 驱动 Edge，管理端 9083）**：
- 浏览器 OAuth 登录全链路成功（账号「如约而至」入池，`source=oauth`）
- 仪表盘显示账号在线、token 2026/12/4 正常、今日 4 请求 100% 成功
- 模型页显示 15 个模型（倍率/上下文/思考档位/多模态）与「计费自检」按钮
- 账号管理页显示「浏览器登录 / 导入账号」按钮、来源「浏览器登录」
- 网关 HTTP 侧：OpenAI 非流式/流式、Anthropic 非流式/流式全部 200，`[DONE]` 正常

### 6. 第三批：图像实测 + FEFO + keepalive 保活（2026-11-04，全部真机验证）

> 账号入池后，原 P1 里「等真实账号」的项全部解锁。除下表外，keepalive 的每日
> 保活排程原本只覆盖 qwenwork/traework/qoder——本次补上 WorkBuddy adapter
> （refresh / balance / checkin；国际版 checkin 如实 unsupported）。

| 文件 | 改动 |
|---|---|
| `src/workbuddy/billing.js` | `parsePackages` 纯函数（真机夹具单测）：解析 `CycleEndTime`（北京时间，`parseBeijingTime` 与 `DeductionEndTime` 毫秒逐位对照）与 `CycleCapacityRemainPrecise`（精确余额，整数 remain 是 floor）；返回 `totalPrecise` / `preciseDecimals` / `packages[].expireAt`。**字段缺失不是 0**——`num(undefined)=0` 会污染合计，单测抓到后修（同文件两个同名 `num` 语义不同，别混用） |
| `src/expiring.js` | `DEFAULT_WINDOW_DAYS` 加 `workbuddy: 7` |
| `src/admin/routes/workbuddy.js` | `/credits` 按**全量账号**写 FEFO 快照（区域视图只过滤展示）；探针快照改用 `totalPrecise`（精确余额摆脱整数量化）；`resolution` 按 `preciseDecimals` 推算并用 `toPrecision(2)`（8 位小数包粒度 1e-8，四舍五入会显示 ±0）；`?count=` 可调输出规模 |
| `src/workbuddy/index.js` | `fefoUidSet()` 导出 + `pickCandidate({expiring})` |
| `src/keepalive.js` | workbuddy adapter（每日低峰 refresh/balance/checkin；国际 checkin 如实 unsupported） |
| `src/repair.js` + `src/{qwenwork,workbuddy,qoder}/chat.js` | **DSML 非流式出口收敛**（P1-7）：新增共享 `repair.aggregateDsmlFallback`（recovered/empty/leak 三分判据 + recovered 时 finish stop→tool_calls）；qoder 内联收编、**qwenwork 补齐当年漏掉的非流式出口**、workbuddy 新接 |
| `src/admin/routes/chatlab.js` | 测试台气泡的通道名走 `channels.label()` 单一来源——硬编码三元是 WorkBuddy 前写的，新通道全显示成「千问」（bsk 测试台实测抓到） |
| 测试 | `workbuddy-billing` 13 项（真机夹具 + `fetchCredits` 带 `ok:true` 的回归——重构时丢过它，下游 `q.ok` 全失效、快照写空，单测当场抓到）；`expiring-fefo` workbuddy 窗口；`verify-expiring-fefo.js` workbuddy 段；`dsml-failclosed` 17 项（+6 共享助手）；`verify-workbuddy-repair` 43 项（+4 DSML）；`verify-qwen-repair` 39 项（+3 DSML） |

**真机结论（两条都要记住）**：
1. **图像输入**：glm-5.3 / deepseek-v4.1-flash 发红色 PNG data URI 都答「红色」——透传天然支持。
2. **国内 CLI 对话当前不实时扣套餐**：连打多次请求 `totalPrecise` 纹丝不动（11288.98），与 `usage.credit=0` 一致（公测/活动口径）。计费探针 `delta=null` 是真实测量结果；FEFO 的临期优先仍有意义（包会到期作废）。

**FEFO 真机验证**：`/credits` 刷新后快照 `accounts:{"1":<今天09:00到期>}`，
`fefoUidSet()` = `['workbuddy:1']`。

### 7. 第五批：回归聚合器 + 六个陈旧脚本修复 + TRAE 宝豁免复核 + 国际 remote 探测（2026-11-04）

| 项 | 结果 |
|---|---|
| `test/run-all.js` + `npm run verify`（#21） | unit 一次跑完 + 39 个离线 verify 逐个跑，汇总退出码；失败才打印输出尾部。`--live` 追加需服务的用例、`--only <名>` 子集 |
| 首跑抓出的 6 个陈旧脚本（全部修复） | ① `verify-stream-error-termination` / `verify-fallback-stream-pipe` / `verify-dumate-source`：起测试网关没带 key——**11-01 强制鉴权后全 401**，补 env 密钥+请求头；② `verify-qwenwork-local-sign`：断言千问 cosyVersion 1.1.52（10-31 已升 1.1.71，测试没跟着改）；③ `verify-checkin-detail`：**时间炸弹**（硬编码当前月 2026-10）+ 打桩缺 `web.agentFor`，改为相对当前日期；④ `verify-qoder-encode-perf`：单独跑 8/8 过，聚合器里偶发（内存/时机），复跑绿 |
| TRAE 宝豁免复核（#9，提前触发） | **豁免已结束**：小请求 Δ 0/0.01 交替是量化噪声；大输出决定性测量 1022 输出 tokens 扣 **0.17**（≈0.157/千token，与 solo 同量级）。前端「（免费）」文案已撤，traebao 正常计费可用 |
| TRAE 国际 remote 探测（P2-13b，现国际账号已具备） | 三个候选基址实测：`trae-api-sg.mchost.guru` **403 空体**（主机活、拒绝请求——TTNet/头部/区域门未知）；`core-normal.traeapi.us` 与 `api-sg-central.trae.ai` 均 404（不路由 `/api/remote`）。**结论：证据不足，`remoteBaseOf` 维持拒绝 intl**，不猜头 |
| 千问 billing-check 样本 | 额度已恢复（74.45 monthly）但对话撞上游间歇性 403（两账号同分钟全 403，池进入冷却）——样本继续等，复活后单次重试即可 |

### 本轮验证结果

```text
node --test test/unit/*.test.js                 → 363 passed, 0 failed
node test/verify-workbuddy-repair.js            → 43 passed, 0 failed
node --test test/verify-workbuddy.js            → 9 passed, 0 failed
node test/verify-qwen-repair.js                 → 39 passed, 0 failed
node test/verify-qoder-repair.js                → 36 passed, 0 failed
node test/verify-traework-repair.js             → 38 passed, 0 failed
node test/verify-expiring-fefo.js               → 8 项全绿（含 workbuddy 段）
node test/verify-chatlab-channel.js             → 16 通过 / 0 失败
node test/verify-channel.js                     → 全部通过
cd web && npm run build                         → vue-tsc 0 错误，构建成功
```

**bsk UI 真机验证（第四批收尾）**：聊天测试台选 WorkBuddy 通道 `hy3`（免费档）
发消息 → 回复正常、归属「如约而至 28 Token」、消耗 0；气泡通道名已从误显示的
「千问」修正为「WorkBuddy」。

---

## 一、P0 — 立即可做（✅ 四项已于 2026-11-04 全部落地，见上方「P0 落地记录」；以下保留动机与实现依据）

### 1. WorkBuddy 接入「播报即收尾」修复

- **证据**：`src/repair.js` 的三件套（`looksUnfinished` / `appendRepairNudge` / `createChunkGate`）已接入 qwenwork、qoder、traework 三条直连通道（各自带 `*_REPAIR_RETRY` / `*_HOLD_CAP` 环境变量）；`src/workbuddy/` 下 grep 零命中。WorkBuddy 同样是面向 agent CLI 的通道，「只播报进度就收尾」是高概率同款问题（未实测，属推导）。
- **落点**：`src/workbuddy/index.js` 的 `runConversation`（流式与非流式两条路径）+ `src/workbuddy/chat.js`。WorkBuddy 上游就是**标准 OpenAI chunk 流**，直接用 `repair.createChunkGate`（它本来就是为标准 chunk 写的）。
- **注意**：
  - `err.sent` 口径要算上门的放行（`sent || gate.result().emitted > 0`）；
  - 重试轮不调 `finish()`，上一轮缓冲整轮丢弃；
  - 重试 = 原请求体末尾追加一条 user 消息（`appendRepairNudge`，幂等）；
  - 环境变量按通道独立：`DUMATE_WORKBUDDY_REPAIR_RETRY`（默认 1）/ `DUMATE_WORKBUDDY_HOLD_CAP`（默认 600），需要在 `repair.envCaps` 里加分支。
- **验收**：新增 `test/verify-workbuddy-repair.js`（照 `test/verify-qwen-repair.js` 的 36 项形态，打桩 `chat.postStream` / `readStream`，自带 `DUMATE_POOL_STATE` 临时文件并在用例间 `pool.revive()`）；真机跑一次带工具的 Codex 会话补样本。

### 2. 9084 多账号网关补流式 `tool_use`

- **证据**：FUSION-BACKLOG §10「P0-1 未覆盖」明确记录；本次复核 `src/web-gateway.js` 的 Anthropic 翻译只发 `thinking` / `text` 块（约 273-295 行），没有任何 `tool_use` / `input_json_delta`。开启 native 会在流式路径上静默丢工具，所以 9084 至今只能文本降级——**这是全项目唯一还在降级的入口**。
- **落点**：`src/web-gateway.js`。对齐 `src/anthropic.js` 的 `tool_use` 状态机：`content_block_start { type:'tool_use', id, name }` → `input_json_delta` → `content_block_stop`，收尾 `stop_reason:'tool_use'`；非流式 `content` 数组补 `tool_use` 项。
- **验收**：打 9084 的 `/v1/messages` 流式工具用例（参考 `test/verify-anth-tools.js` 与 `test/verify-ccswitch.js` 的写法）；离线可先做翻译层单测。

### 3. 文档漂移修正（半小时级，逐条都已核对）

| 位置 | 过期内容 | 现状 |
|---|---|---|
| `CLAUDE.md`「通道 id 的单一来源」段 | 写「`dumate` / `qwenwork` / `traework` / `qoder`」四通道 | `src/channels.js` 已是五通道（含 `workbuddy`） |
| `CLAUDE.md`「API Key 区域绑定」段 | 写「四通道 × 国内/国际」「traework intl → 明确『未接入』503」「traework-intl 是真预留——国际链路未接入」 | TRAE 国际版 2026-11-03 已全链路接入；`src/keys.js` 区域约束对 qoder/traework/workbuddy 均生效 |
| `CLAUDE.md` 环境变量表 | **完全没有** `DUMATE_WORKBUDDY_*` | `src/` 实有 4 个：`DUMATE_WORKBUDDY_MIN_MAX_TOKENS`（budget.js）/ `_APP_VERSION` / `_CLI_UA` / `_MODELS_CACHE_MS` |
| `CLAUDE.md` 数据文件表 | 缺 `data/workbuddy-accounts.json` | `data/` 下已存在 |
| `src/keys.js` 注释 | 「四条通道…」「traework（国际链路未接入，intl key 会拿到明确的『未接入』报错）」 | 同第二行，均过期 |
| `docs/USER_MANUAL.md` | 只提过 Qoder 的登录区域，**没有** WorkBuddy / 区域视图 / 强制鉴权的说明 | 可选更新，但五通道与区域切换已是用户可见的主功能 |

### 4. WorkBuddy 计费自检探针

- **证据**：dumate / qoder / traework / qwenwork 四通道都有 `GET /api/admin/<ch>/billing-check`，WorkBuddy 没有（`src/admin/routes/workbuddy.js` 现有 status / import-client / import-token / models / credits / checkin / dashboard / accounts）。数据源已就绪：`billing.fetchCredits` 返回各套餐 `remain` / `size`，`models.js` 已解析每个模型的 `credits` 倍率（`parseCreditsRate`，形如 `"x0.34 credits"`）。
- **落点**：`src/admin/routes/workbuddy.js` 加 `GET /billing-check?model=&region=`；纯函数（期望倍率选择、消耗归属、四态 verdict）放 `src/workbuddy/billing.js` 或独立小模块。
- **口径**：小请求（数 1~400，输出够长压过精度误差）→ **前后 `fetchCredits` total 差值**（与 TRAE 的 consumed 差值同族）；预期倍率取模型表 `rate`，`ratio = 实测 ÷ 标称`；国际版没有 credits 接口（`fetchCredits` 直接 `unsupported`）→ 探针如实返回 unsupported，不硬编。没测到给 `null` + warning，**不编 0**。
- **验收**：`node --test test/unit/workbuddy-billing.test.js`（纯函数）+ 真机国内账号跑一次（需一个活着的国内登录态，见 §六 WB-7）。

---

## 二、P1 — 需一次真机 / 账号取证

### 5. WorkBuddy 图像输入真机验证

- **证据**：`src/workbuddy/models.js` 已解析 `supportsImages` → `multimodal`；`chat.buildBody` 对 messages 原样透传（WorkBuddy 上游是标准 OpenAI 协议，理论认 `image_url` part）。但从未实测过图像。
- **动作**：真机发一张 data URI 图（**别用 8x8 这类退化尺寸**——搭子撞过千帆 `internal_error` 502）到两区各一次；能识别内容即直通成立，无需改代码。
- **失败兜底**：若上游拒图，则在 `index.js` 加 `assertImageSupport`（对齐 TRAE 的写法，在**选号之前**，模型表 `multimodal=false` 时回 400 + 可用多模态模型列表）。
- **验收**：真机记录；若加兜底，补 `test/unit/image-passthrough.test.js` 形态的单测。

### 6. WorkBuddy usage 缓存形状实测

- **证据**：`src/workbuddy/` 未 require `src/usage-norm.js`。上游若按标准位给 `prompt_tokens_details.cached_tokens`，什么都不用做；若像 DeepSeek / Qwen 那样放在私有字段，按标准协议读的客户端会恒见 0（Qoder、千问都踩过）。
- **动作**：一次真机请求存下原始 usage 帧，确认字段形状。仅在有非标准字段时接 `usage-norm`（流式帧转发前改写、聚合出口同修）；上游没给缓存字段就不动——**不凭空造字段**。
- **验收**：真机样本 + 需要时补单测。

### 7. WorkBuddy DSML 解析接入

- **前置**：先确认 WorkBuddy 模型表里确实有 DeepSeek 系模型（国际版目录含 `deepseek-v4.1-flash` 等），且该模型会吐 `<dsml:...>` 文本标记。**有实测样本再动手**。
- **落点**：`src/repair.js` 的 `classifyDsml` 已共享，WorkBuddy 在聚合出口 + 门的 `finish` 阶段接入即可（三分判据：recovered / empty / leak，leak 必须 fail-closed 报错）。
- **验收**：并入 `test/unit/dsml-failclosed.test.js` 风格的单测 + 一个 WorkBuddy 打桩用例。

### 8. WorkBuddy 套餐到期解析 + FEFO

- **证据**：`src/expiring.js` 的 `DEFAULT_WINDOW_DAYS` 只有 `dumate` / `traework` / `qwenwork`（Qoder 用自家 grants 账本）；`billing.fetchCredits` 的查询按 `PackageEndTimeRange` 过滤，但**解析结果只保留 name / remain / size，不保留到期时间**。
- **动作**：① `fetchCredits` 解析 `PackageEndTime`（真实字段名先在真机响应里确认）；② 管理端 `/credits` 顺带 `expiring.update('workbuddy', entries)` 落快照；③ `index.js` 加 `fefoUidSet`（uid 形式注意与 channel-pool 的 `${channel}:${id}` 键位对齐——Qoder 曾因字段名写错导致 FEFO 从未生效）；④ `expiring.js` 加默认窗口（参考 traework 的 7 天，按真机包周期再定）。
- **前置**：一个带多套餐、能看得到到期时间的真实账号。
- **验收**：`test/unit/expiring-fefo.test.js` 形态 + `test/verify-expiring-fefo.js` 端到端（喂真实形状快照调通道自己的 `fefoUidSet`）。

### 9. TRAE 宝免费豁免活动期结束复核（时间敏感）

- **证据**：TRAE 宝（`traebao/` 前缀）的免费豁免绑定在 `function=personal_assistant` 上，依据是「官方 11 月活动」。活动结束后豁免是否延续未知，`traework-credits.jsonl` 照记——但需要**主动复核一次**，否则活动悄悄结束只会表现为「用户发现积分在掉」。
- **动作**：2026-11 活动结束后（关注官方公告），同一账号同请求复测 `personal_assistant` 与 `solo_agent_lite` 的 consumed 差值；豁免消失则更新 CLAUDE.md 的 TRAE 宝段落与管理端文案（「免费豁免」要撤）。
- **验收**：真机记录写进 CLAUDE.md。

### 10. Qoder 国际活动域 `center.qoder.sh`

- **证据**：CLAUDE.md 缓办清单：Qoder intl 活动域需国际账号。库内两个 Qoder 账号都是 cn。
- **动作**：加一个国际账号（账号管理 → 添加 → 国际 qoder.sh，device flow 已真机验证指向国际域）→ 实测活动列表/领取端点 → 若形状与 cn 同族，只加常量与路由区域分支。
- **验收**：真机；离线补 `test/unit` 的端点选择断言。

### 11. Qoder PAT 端到端验证

- **证据**：`pt-` 交换端点已接、请求形状被上游接受（假 token 回业务错误而非 404），但从未用真 `pt-` 跑通。需要组织 / SSO 账号签发。
- **动作**：拿到真令牌后 `POST /api/admin/qoder/pat-import` 全链路验证（交换 → 拉身份 → upsert → 对话）。
- **验收**：真机记录 + 账号卡正确显示凭证族。

---

## 三、P2 — 战略级 / 大工程

### 12. 千问 ACP 会话通道（P2-17）

- **证据**：`docs/QWENWORK-CLIENT-1.4.0-ANALYSIS.md` 与 FUSION-BACKLOG §3.2：`chat_context.imageUrls` 恒 `null`，附件与图片走「barn 预上传 → ACP 会话（`wss://qwenwork.cn/api/chat-ws`）用 `file_uuid` 引用」。HTTP 半边（`/v1/files/upload`）已通，但拿不到 `file_uuid`。**这是千问图片 / 附件的唯一结构性出路**。
- **阻塞**：ACP WS 帧协议无证据（`join` / `new_prompt` / `session/cancel` 等方法名在明文里搜不到；worker runtime 是 agent 侧 stdio 传输）。按「无证据不预编」纪律，需先从 `tang-bugu/dsh-connect-qwenwork` 或抓官方客户端 WS 取帧样本。
- **动作**：独立通道实现（不要塞进现有 chat 桥——它引入第二套 agent 语义）；先做最小闭环：建会话 → 发文本 → 收帧。
- **验收**：真机对照官方客户端行为；离线帧解析单测。

### 13. TRAE Remote 链路扩展

- **现状**：`DUMATE_TRAEWORK_REMOTE=1` 时仅 **auto 档纯文本**请求走 remote（`src/traework/remote.js`），带 tools 与显式模型名仍走 utils_chat。
- **待做**（各自独立，按需立项）：
  1. 带 tools 请求走 remote——需实现 `custom_model` 的 manual 策略对象（参照 Trae2api-cn 的 resolve_model_config）；
  2. ~~国际版 remote 基址实测~~（2026-11-04 已探测，用国际账号 wearetheone777）：`trae-api-sg.mchost.guru` 403 空体（主机活、拒绝请求）、`core-normal.traeapi.us` 与 `api-sg-central.trae.ai` 404（不路由 `/api/remote`）——**证据不足，`remoteBaseOf` 维持拒绝 intl**；若要续攻，方向是 SG 主机的头/区域门（需抓官方国际客户端的 remote 流量），不猜头；
  3. 1M Max 档位与 `custom_model.reasoning_effort_level`（需 Max 账号）；
  4. 「播报即收尾」修复不覆盖 remote——执行型会话的观测形态未实测，先取证再决定要不要接。
- **验收**：每条都要真机 + 单测（现有 `test/unit/trae-remote.test.js` 扩展）。

### 14. 搭子 `video_elements` 分镜 / 首尾帧 / 对白

- **现状**：文生视频最小版已通（`POST /v1/videos/generations`，实测提交到出片 ~20s）。`video_elements/async` 是可控视频生产管线，未做。
- **动作**：按 §13 的探测循环方法论定案请求形状（从上游 400 错误体逐轮定案，不猜）；无证据的可选参数不放开。
- **验收**：`test/unit/media-payload.test.js` 扩展 + 真机一次。

### 15. Qoder 单号并发 / 节奏闸门

- **证据**：FUSION-BACKLOG §4「单号并发/节奏闸门」——降 10605 与风控画像。当前排队已有完整处置（429 + 短冷却 + 官方排队轮询），但「主动限速」没有。
- **动作**：`channel-pool` 或 Qoder 通道内加 per-account 并发上限 + 最小请求间隔（可配、默认关）；先埋点统计每账号 RPM 与 10605 率再定阈值。
- **验收**：打桩单测 + 真机观察 10605 率下降。

### 16. 搭子 Agent 侧能力（逐条，多为阻塞）

| 项 | 状态 / 阻塞原因 |
|---|---|
| 浏览器 CDP 中继（`127.0.0.1:19228`） | 文档级证据，未逆向 relay token |
| IM 桥 / 飞书推送 | 需 webhook 配置与产品设计（缓办清单同款） |
| 记忆库 / 本地知识库（`memory.db` FTS5） | 文档级证据，无接口形状 |
| MCP connector 写入侧 | 只读已接；安装 / 授权链路缺证据（`plugin/*` POST 过不了网页 cookie） |
| opencode Agent 会话 | **本机依赖型**：打的是桌面客户端内部服务，鉴权 key 要从客户端进程内存读——网关集成价值有限，待真实使用场景再立项 |
| BOS 上传 | 缺 BOS AK/SK 证据（生图参考图 / 文档解析的前置） |
| 云端 Agent SSE（`v2/agent/ai_assistant/run`） | 帧未逆向 |

### 17. 千问：企业身份 / automations / 区域端点

| 项 | 状态 / 阻塞原因 |
|---|---|
| 企业身份 / 组织池 | device flow 账号不带机器身份，需企业账号做证据 |
| 定时任务 automations | 解包只到「路径存在」，无请求体 / 响应证据——不预编 |
| 区域端点发现 | `/api/v3` 与 `/algo/api/v5` 实测 404；v5 需要机器身份 + 响应解密，均缺——**已定案不做**（列在此处仅作提醒） |
| 语音润色 `/v1/voice/polish` | 已接，上游 401（端点疑似按账号 / 灰度开放）——**跟踪项**，上游开放即用，无需开发 |

### 18. TRAE：`llm_raw_chat` 链路 / 设备绑定 ECDSA 续期

- **`llm_raw_chat`**：并行工具调用、`builder_with_mcp_v3`，高难度；与 utils_chat 能力重叠，等真实需求（比如 Coding Agent 场景）再评估。
- **设备绑定 ECDSA 续期**：bluechonk 有 DeviceProof 实现可参照，但现有 9074 自愈（`rotateDevice`）已覆盖实际故障场景，且 CheckLogin 实测确认 `BoundDeviceID` 与派生 deviceId 是两套命名空间、不影响签到。**等真实出现「rotateDevice 也修不了」的设备级风控再立项。**

### 19. 平台横向（缓办）

- **`/v1/models` 元数据统一**：五通道字段名各不相同（rate / contextWindow / multimodal / reasoning），前端已能各自渲染；收敛收益有限，等有新客户端接入需求再做。
- **per-key 限流 / 账号级限额护栏**：缓办清单原话「要存储与界面设计」；低价值场景，暂不动。
- **统一错误码字典**：TRAE 业务码已收进 `upstream-errors.js`，COSY 私有码留在通道层是**既定架构决策**（共用层不认识通道私有码），不再推进。

---

## 四、运维 / 工程

### 20. `stable/` 快照发布（按需）

- **现状**：快照冻结在 WorkBuddy 接入与区域视图改版**之前**——`workbuddy/`（6 个文件）不在快照里，`channels.js`、`server.js`、`upstream-router.js` 等主链路文件也与当前 main 不一致。
- **动作**（发布是用户的决定，不是本清单自动执行）：按依赖闭包从 `src/server.js` 递归同步 → 逐字节比对 → `node --check` + 独立端口（如 `DUMATE2API_PORT=19099`）启动验证 → 更新 `stable/SNAPSHOT_FROM.txt`（指纹算法：`sha256(按相对路径排序后 [相对路径 + LF + 内容] 拼接)`）。
- **注意**：`stable/start-stable.bat` 必须带 `DUMATE_ADMIN_DATA`，别手工裸启动（会退回空数据目录）。

### 21. 全量回归聚合脚本（可选，低价值但省事）

- **现状**：`test/unit/` 45 个文件（`node --test`），`test/verify-*.js` 二十来个散装脚本，各自手动跑。
- **动作**：加一个 `npm run verify`（或 `test/run-all.js`）依次跑 unit + 全部 verify，汇总退出码。注意 verify 脚本多数自带临时池文件，个别需真机账号（如 qoder-cli）要显式跳过。

---

## 五、推荐开工顺序（P0 已完成，以下是 P1 的顺序）

0. ~~P0 四项~~（2026-11-04 已完成，见 §P0 落地记录）。
1. **P1 取证类优先**：WorkBuddy 图像实测 → usage 形状 → DSML 样本 → FEFO（等多套餐账号）。
2. **TRAE 宝活动结束复核**（#9）有明确时间点，11 月内必须做一次。

---

## 六、验证 / 未竟的验证任务（非编码）

- [x] ~~WorkBuddy 国内签到真机验证~~（2026-11-04 已解决）：不再依赖客户端登录态——浏览器 OAuth 登录入池，账号页显示「今日已签」；keepalive 已接 WorkBuddy adapter，国内号每日低峰自动签到。
- [ ] WorkBuddy 国际账号 11140（账号级风控）：协议层已打通，账号本身在上游受限（issue #136 同款），恢复属登录流程后置；也可用「浏览器登录」在国际区再加新号。
- [x] ~~桌面子链路复测~~（2026-11-04）：`verify-dumate-source`（26 项）覆盖 auto/web/非法值的启动与回落逻辑（客户端未安装 → auto 探测失败回落网页池，与真机场景同构）；修复后随聚合器全绿。真桌面凭证（装回客户端）场景等客户端装回再测。
- [x] ~~千问 `billing-check` 首个真机样本~~（2026-11-05 **ACP 路线完成**，第六批）：chat 桥路线仍阻塞（账号 2 refresh token 死需重新登录；账号 3 上游账号级模型权限 403，网关侧无解），但 **ACP 链路可用**——billing-check 加 qwen-acp 分支后真机四连测（cost 0.1919/0.2294/0.075/0.1376，全落 monthly，方差 3 倍见第六批）+ 完整 HTTP 链路通过。chat 桥首个样本等账号 2 重新登录。
- [ ] Qoder 国际账号：库内两个账号都是 cn，国际页面区分已做但无国际账号数据（§10 同源）。
- [ ] WorkBuddy 计费探针大样本（`?count=2000`）：当前口径已实证「对话不实时扣套餐」，等上游公测口径变化后再跑才有意义。

---

## 七、⛔ 已定案不做 / 阻塞清单（防翻案，摘自 backlog 与本轮核对）

| 项 | 原因 | 出处 |
|---|---|---|
| 千问 `imageUrls` 收图 | 官方客户端写死 `null`，端点上结构性不可能；只有 ACP 一条路（本清单 #12） | 解包分析 / CLAUDE.md |
| 千问 `is_reasoning` 开关 | 实测上游忽略该字段（false 组 reasoning 反而更多） | CLAUDE.md |
| TRAE `llm_utils_chat` 请求级档位 | 11 次实测上游忽略 `reasoning_effort` / `reasoning_effort_level` | CLAUDE.md |
| 搭子 `reasoning_effort` | 实测不敏感（token 数不单调） | CLAUDE.md |
| 千问 `qwork-auto/advanced/ultimate` | 实测已下线，裸请求 403 | FUSION-BACKLOG §7 |
| Qoder Quest / Repo Wiki / Bugbot / MCP / browser-use | 无协议入口，是 IDE 前端功能 | FUSION-BACKLOG §7 |
| TRAE `create_agent_task` 全量复刻 | 200KB body、无公开可用实现 | FUSION-BACKLOG §7 |
| TRAE 支付类接口 | 非网关职责，有资金动作 | FUSION-BACKLOG §7 |
| Qoder 逐包剩余额度 | 上游 503/404，grants 账本 + 推算口径已是唯一解 | CLAUDE.md |
| 搭子 `session_share` / 埋点 / 心跳 ACK | 无网关价值 | FUSION-BACKLOG §7 |
| 搭子技能广场 POST 列表 | 网页 cookie 过不了（GET 类可通） | FUSION-BACKLOG §7 |
| 千问区域端点发现 | 实测 404，需机器身份 + 响应解密，缺证据 | CLAUDE.md 缓办清单 |
| ASR 语音转写 | 搭子要 BOS AK/SK 证据、千问要 WS 协议逆向 | CLAUDE.md 缓办清单 |
| 多时段签到、per-key 限流 | 低价值场景 | CLAUDE.md 缓办清单 |
| 千问语音润色 | 已接，上游 401；非开发任务，跟踪即可 | CLAUDE.md |
| remote 端点备选链路（Max 账号） | 需 Max 账号 | CLAUDE.md 缓办清单 |

---

## 附：本清单的核对方式（立项时快照，P0 完成后已不再零命中）

```text
grep -rn "repair" src/workbuddy/                    # 立项时零命中 → WB-1（现已接入）
grep -n "tool_use" src/web-gateway.js               # 立项时零命中 → #2（现已补齐）
grep -rn "DUMATE_WORKBUDDY" CLAUDE.md               # 立项时零命中 → #3（现已补文档）
grep -n "billing-check" src/admin/routes/workbuddy.js   # 立项时零命中 → #4（现已实现）
grep -rn "usage-norm" src/workbuddy/                # 仍零命中 → #6（待真机取证）
sed -n '1,40p' src/expiring.js                      # 窗口仍只有三家 → #8（待做）
```

---

## 八、2026-11-05 落地记录（GitHub 融合批次：清单 #1/#2/#12/#13/#15 + hub 四件）

> 参照仓库快照 `%TEMP%\fusion-refs\`（workbuddy2api-hub / Trae2api-cn 浅克隆）。全部离线验证，真机受阻项如实标注。

### #12 千问 ACP 会话通道——阻塞解除，最小闭环落地 ✅

原阻塞「WS 帧协议无证据」解除：[dsh-connect-qwenwork](https://github.com/tang-bugu/dsh-connect-qwenwork) 给出完整实测帧协议；本项目探测再添半手证据——假 token 连 `wss://qwenwork.cn/api/chat-ws` 回 **401 JWT verification fails**（端点存在、鉴权确为 Bearer JWT）。

| 文件 | 内容 |
|---|---|
| `src/qwenwork/wsframe.js`（新） | RFC 6455 帧 codec：客户端掩码、分片聚合、ping/pong/close、1009 防护；`mask:false` 供测试服务端回帧 |
| `src/qwenwork/wsclient.js`（新） | 无依赖 WS 客户端（Node>=18 无全局 WebSocket + 需自定义 Authorization 头，dsh-connect 同结论）：upgrade 握手 + Sec-WebSocket-Accept 校验、读空闲看门狗 |
| `src/qwenwork/acp.js`（新） | provider：REST 建会话 → WS 信封 JSON-RPC（`{"type":"control"\|"data","payload":{…}}`）→ join/new_prompt → 事件归一（标记搜索宽松解析，`DUMATE_QWENWORK_ACP_DEBUG=1` 打未知帧）→ 「见过 running 或正文增量之后的 idle」结束判据；`promptOf` 32KB 裁剪（保 system+最新、丢最老留标记、单条超限保头尾）；probe 模式不喂池 |
| `src/qwenwork/constants.js` | `ACP_ORIGIN`（qwenwork.cn **裸域**，不是 gateway）/`ACP_SESSIONS_PATH`/`ACP_WS_PATH`/`ACP_MAX_PROMPT_BYTES=32768` |
| `src/upstream-router.js` | `qwen-acp/` 前缀 → qwenwork 通道 + provider `./qwenwork/acp`（qianfan-raw 同款） |
| `src/server.js` | `/v1/models` 列 `qwen-acp/auto`（有可用账号才列；模型档位由账号/套餐决定，模型名只是标签） |
| 测试 | `test/unit/qwen-acp.test.js` 13 项：帧编解码边界（125/126/65535/65536、分片、半包、控制帧）、promptOf 裁剪、normalizeFrame 剧本（遗留 idle 忽略）、runTurn **本地回环 WS 服务**全回合 + 1009 收尾、路由注册 |

边界如实：真实回合未跑通（等千问账号额度/状态）；协议细节（JSON 路径）按 README 标记宽松解析，真机联调时按 DEBUG 日志收紧。

### #13 TRAE remote manual 策略——**定案修正**：remote 无 tools 槽，落地的是显式模型名 ✅

Trae2api-cn 源码证实 remote 协议**没有 tools 槽**（`trae_remote_client.py` 明文 "tools remain owned by the API caller"）——原清单 #13.1「带 tools 走 remote」不成立，**防翻案**：带工具请求永不走 remote。落地的是显式模型名（`DUMATE_TRAEWORK_REMOTE=2`）：

| 文件 | 内容 |
|---|---|
| `src/traework/remote.js` | `modelFamilyOf`（_model_family 逐字对照：trae/ 前缀、__ 档位、deepseek 族、ali- 前缀）+ `manualFieldsOf`（bound 校验**拒绝静默落默认档**；五件套 model_name/config_source(缺省1)/is_preset(缺省true)/provider/custom_model）+ `createSession` manual 分支（解析失败**发请求前**拒绝） |
| `src/traework/models.js` | `normalize` 新增 `customModel` 字段（上游原始整行——manual 的 custom_model 要完整形状，归一化字段子集重构不出来） |
| `src/traework/index.js` | remote 分级：`=1` auto 档纯文本（真机已验证行为不变）；`=2` 显式模型经 manual（表不可用/模型不在表回落 utils_chat——显式名在 utils_chat 本来就能跑，无静默换模型问题）；tools 永不走 |
| 测试 | `test/unit/trae-remote.test.js` 7→12 项：族归一逐字对照、五件套缺省、不匹配拒绝、createSession 请求体断言（打桩 https）、校验失败不发请求 |

### hub 融合四件（v1.7.20-22 → 网关）

| 项 | 实现 | 测试 |
|---|---|---|
| 探针无副作用（#134） | 五通道 billing-check 加 `opts.probe`：失败跳过 noteError/markFailure/lastError，错误照常上抛；web-pool.callWithFailover 同款 | `probe-no-punish.test.js` 2 项（默认仍喂池回归锚 + probe 不喂） |
| 工具调用回显（#135） | `repair.js`：`parseToolEchoPayload`（纯载荷+工具名名单强判据，与 DSML XML 形状互补）+ gate `echoFixup` + `aggregateToolEchoFallback`；三通道接线；`DUMATE_TOOL_ECHO_MODE` off(默认)/lenient/strict | `tool-echo.test.js` 12 项；三通道 repair 回归 36/39/43 绿 |
| 积分三段拆分（#129 后续） | `reqlog.pickUsage` 带缓存提取+`cached_reported`；新 `credit-split.js`（Qoder 专属，系数 `DUMATE_QODER_CREDIT_COEF`）；reqlogs 行级 `credit_split`（缓存未回报 cached/sum=null 不编） | `credit-split-fullprice.test.js` 共 8 项 |
| 全价请求洞察（#129） | usage-agg 桶加 `ci/cc/c0/c0p`；`snapshot.full_price`（prompt≥`DUMATE_FULL_PRICE_PROMPT_MIN`(默认100K) 且确认零缓存且成功）；积分占比不做（口径不同不编数） | 同上 |

### WorkBuddy 每日活跃双通道 ✅

| 项 | 实现 | 测试 |
|---|---|---|
| 国内版事件上报 | 新 `src/workbuddy/activity.js`：`/v2/report` 一条 `chat_request_send`（**必须带 userId** 否则 200 静默丢弃）；当日幂等（档案 `lastActivityReport`）；keepalive 签到后顺带，结果附 `activity` 字段不改签到结论 | `workbuddy-activity.test.js` 6 项 |
| 国际版网页 agent 打卡 | 新 `src/workbuddy/webagent.js`：ACP over streamable HTTP（建会话→取沙箱 link/token→SSE 通道 Acp-Connection-Id→initialize→session/load→**session/set_model**（不设会按网页默认 Auto 付费档计费）→session/prompt→轮询 completed；活跃会话上限 10（429/10105）；成功 stop 保留/失败 delete 清理；当日幂等 `lastWebActivity`）。keepalive 的 global 分支由「不支持签到」改为网页打卡 | `workbuddy-webagent.test.js` 5 项 |

真机受阻：WorkBuddy 国际账号 11140 账号级风控；协议已由 hub 多账号实测背书。

### #15 Qoder 单号并发/节奏闸门 ✅（默认全关）

`channel-pool.js`：`DUMATE_QODER_INFLIGHT_MAX`（通道级在途帽，`pool.acquire` 支持按次覆盖池默认 4）+ `DUMATE_QODER_MIN_INTERVAL_MS`（最小请求间隔，判据=**上次 pick 时刻**，约束发射节奏；间隔内跳过与 busy 同语义不惩罚；availability 同口径报 busy）。env 不配行为与之前逐字节一致（回归锚锁定）。测试 `channel-gate.test.js` 4 项。**先埋点观察 10605 率再定阈值。**

### #19（部分）前端展示 ✅

- 用量页「全价请求洞察」卡（`/usage/agg` 的 full_price + totals 三段；无全价请求给正面文案「前缀复用良好」）。
- 请求详情页 Qoder 行「积分三段拆分」（缓存「?」= 上游没回报，不显示合计当完整）；`web/src/api/reqlogs.ts` 类型补 `credit_split`。
- `cd web && npm run build` 通过（vue-tsc 0 错误）。

### 本批验证汇总

```text
node --test test/unit/probe-no-punish.test.js   → 2/2
node --test test/unit/tool-echo.test.js         → 12/12
node --test test/unit/credit-split-fullprice.test.js → 8/8
node --test test/unit/qwen-acp.test.js          → 13/13
node --test test/unit/trae-remote.test.js       → 7→12 项
node --test test/unit/workbuddy-activity.test.js → 6/6
node --test test/unit/workbuddy-webagent.test.js → 5/5
node --test test/unit/channel-gate.test.js      → 4/4
npm run verify（unit 全部 + 39 verify 聚合）      → 40 项通过 0 失败
cd web && npm run build                          → vue-tsc 0 错误
```

### 待办（下批）

- 千问 ACP 真机回合（等账号）；`DUMATE_QWENWORK_ACP_*` 联调收紧 normalizeFrame 的 JSON 路径。
- TRAE remote manual 真机（`DUMATE_TRAEWORK_REMOTE=2` + 显式模型）。
- WorkBuddy 网页打卡真机（等国际账号）；10105 触发时的 `web_conversation_prune` 自动清理未实现（手工在网页端收尾即可，不做高风险自动 stop）。

### 真机验证批次（2026-11-05 凌晨，紧随第八批）

| 项 | 结果 |
|---|---|
| **千问 ACP 真实回合** ✅ | **P2-17 真机闭环达成**：REST 建会话 → WS join/new_prompt → 完整回合（正文「Hi! 我是千问办公(QwenWork)…」+ reasoning 聚合）。真机采样（40 帧）修正 normalizeFrame 三处：control 帧承载方法（accepted/sessionStatus 在 **params** 里）；data 帧的 update 事件名在 **sessionUpdate** 键（不是 type）；文本在 **update.content.text**；`sandbox_status`/`replay_*`/`refresh_prompt_queue` 归 ignore。测试 13→14 项。**千问对话的新备用链路就此可用**（见下） |
| TRAE remote=2 显式模型 ✅ | **P2-13.1 真机闭环**：`DUMATE_TRAEWORK_REMOTE=2` + `traework/glm-5.2`（probe 模式）→ manual 策略钉模成功，model_config 回填 glm-5.2，正文/usage 完整（prompt 21989 tokens 是 remote agent 会话自带大脚手架的特征） |
| WorkBuddy 网页打卡（cn 区） ✅ | 账号「如约而至」：会话跑完（deepseek-v4.1-flash）178 段输出 / 6355ms，收尾 stop 保留，`lastWebActivity` 落档 |
| 千问 billing-check ❌ 受阻 | 账号 2（qianwencodework）**refresh token 已失效**（INVALID_REFRESH_TOKEN，需重新登录）；账号 3（qianwenWork）chat 桥 403 "Model is not available for this user"（flash 与 pro 都拒，**账号级**对话收窄）。**重要观察：账号 3 的 ACP 会话同时是通的**——ACP 与 chat 桥可用性分离，ACP 可作千问对话备用链路（`qwen-acp/auto` 走同一个账号池） |

### 第四批补充（2026-11-05 凌晨二批）

| 项 | 结果 |
|---|---|
| 千问 ACP 流式真机 ✅ | 15 帧：reasoning → content×N → finish:stop → [DONE]；首帧 13.7s（agent 沙箱开销）；正文完整聚合 |
| 千问 ACP Anthropic 出口真机 ✅ | 9082 dev 网关 `/v1/messages`：content 块 thinking+text、stop_reason end_turn、usage 如实 0（ACP 上游不回报计量，不编数）。OpenAI 出口非流式/流式同步验证通过 |
| 千问账号 3 chat 桥 403 定案 | 上游模型表正常（pro/flash/qwen3.8-max-preview 都在），但 flash/pro/auto **三档全部 403**「Model is not available for this user」——chat 桥端点（agent_chat_generation）对该账号**整体收窄**，不是特定模型问题；同账号 ACP 会话正常。恢复途径只能等上游/官方客户端登录，非网关侧可修 |
| Qoder 探针自动选模型 ✅ | 新 `src/qoder/probe-model.js`：`pickProbeModel`（真 0 价 price_factor==0 优先 → 最小正倍率 → 空表 null 要求显式传 model，hub v1.7.20 #134 融合剩余项）；billing-check 缺省 model 时自动挑选并回 `auto_picked`。测试 4/4 |

### 第五批（2026-11-05 凌晨）

| 项 | 结果 |
|---|---|
| TRAE remote 长会话保护 ✅ | `flattenQuery` 加裁剪（Trae2api-cn `build_remote_query` 同策略，默认 480000 对齐 `TRAE_REMOTE_QUERY_MAX_CHARS` 缺省，`DUMATE_TRAEWORK_REMOTE_QUERY_MAX_CHARS` 可调）：头部连续 [System] 块保护 + 会话取尾部 suffix + 中间 `[Prompt truncated: N chars omitted]`；保护块占满预算时只留 System（外部工具契约不丢）。消息级配对挑选不做（我们的前缀自解释，差异注释）。测试 12→13 项 |
| #14 video_elements 探测循环 ⏳ 部分定案 | 探测循环 R1-R9（探测脚本不走仓库，消耗 3 张 1K 低质生图）：**已定案**——端点 `POST /gateway/v2/tools/dumate/video_elements/async`（GET 同路径 ?task_id= 轮询）；模型名**唯一合法值 `dumate-elements3.0`**（上游 400 detail 明示）；必填对 `model`+`model_parameters`；`model_parameters` 内 `element_name`、`element_frontal_image`（BOS 图片 URL）、`element_description` 已过校验；任务名 `CreateAigcAdvancedCustomElement`（自定义元素/数字人形象管线）；**校验在任务期异步返回**（task_status:"failed" + task_status_msg 点名，提交本身 200）。**未定案**：「element refer images must be between 1 and 3」的**确切字段名**（`element_refer_images` 数组未命中）——错误信息只给约束不给字段名，继续盲猜每轮烧一张生图，按纪律停手。续探入口：R9 剧本在 `%TEMP%\fusion-refs\live-video-elements-probe2.js`，下一个候选字段名（refer_images/element_images/images）需官方客户端抓包佐证后再打 |

### 第六批（2026-11-05 深夜）

| 项 | 结果 |
|---|---|
| qwen-acp 端到端冒烟 ✅ | 9082 网关（17:26 进程已含第五批代码）：`/v1/chat/completions`（14.8s，回答正确）与 `/v1/responses` SSE（42 帧完整事件流，output_text.delta/done 正常）双入口真机通过。`usage:{}` 是既定口径且**有证据**——40 帧真机样本 0 处 token/usage/credit/meter 字段，不编数 |
| **ACP 计费实证（新知识）** ✅ | ACP 会话**真实扣费**且**全落 monthly 池**（daily/longterm 零动），结算 <1.5s：同 prompt（数到 400）四轮实测 0.1919 / 0.2294 / 0.075 / 0.1376 credits——**方差 3 倍**，ACP 按会话内实际推理轮数扣费，单次探针读不准，判读须多跑几轮。ACP 帧不带计量 → 差值法是唯一计量途径 |
| 千问 billing-check ACP 分支 ✅ | `admin/routes/qwenwork.js`：`?model=qwen-acp/auto` 走 `acp.send`（**不传 onChunk**——「onChunk 存在 = 流式」分叉，传函数返回 `{streamed:true}` 拿不到 usage，这是真机踩出来的形状）；tokens 如实全 0、billed 恒 null、cost 仍是三池差值。**这是 chat 桥被账号级模型权限拦住（403 Model is not available）时的活路**——账号 3 恰好 chat 桥 403 而 ACP 可用（同一 accessToken 两条链路一封一通）。handler 级真机 4 连测 + 完整 HTTP 链路（cookie 鉴权）真机通过。测试 3→5 项（桩贴 acp.js 481-496 真实聚合形状） |
| 千问模型页「自检·ACP」按钮 ✅ | `web/src/views/ModelsView.vue`：`runQwBillingCheck(override?)` 接受显式模型参数（Vue 事件不传参陷阱规避——`@click="runQwBillingCheck()"` 显式空括号），按钮旁新增「自检·ACP」。模板渲染块零改动（model 名/cost/tokens 全兼容）。vue-tsc 0 错误 |
| GitHub 融合扫描 | wb（workbuddy2api-hub）停在 11-04 v1.10.9、trae（Trae2api-cn）停在 10-24——与第五批 clone 时一致，无新提交，无新融合点 |

### 第七批（2026-11-06 凌晨）

| 项 | 结果 |
|---|---|
| #14 后置：千问图片输入（barn + ACP 附件引用）⏳ **阻塞定案** | barn 真机复探：完成体**只有 storage_path（=/path），无 file_uuid**；`/api/oauth/files/{x}/content` 用 path / uuid / session_id 三候选全 404（file_uuid ≠ path）；客户端 1.4.0 解包源已随卸载消失；社区无逆向成果、alibabacloud 官方文档只有企业管理面（qwk_* openapi/v1），无客户端协议。**file_uuid 的发送侧来源没有证据**，ACP 引用形状盲探无判据（失败形态是「模型当文本处理」，看不出对错），按纪律停手。解锁条件：装回官方客户端抓 ACP WS 发送帧（看带附件的 session/prompt 形状与 file_uuid 出现时机） |
| qwen-acp 模型档位 ⛔ **三重定案：不可开** | ①`session/set_model` RPC **方法不存在**（-32700 `Unknown control method`，pro/flash/qwen3.8-max/auto/乱值五候选同错）；②createSession REST body 的 `model`/`modelId`/`model_key` 全被忽略（HTTP 201 但 `extra_data.mode` **恒 flash**——账号 3 现状档位）；③档位由账号/套餐侧决定，客户端不可选。**不写路由代码**。顺带收获：`extra_data.mode` 是会话真实档位的可观测字段。同账号并发建会话会 409 `CONCURRENT_OPERATION`（间隔 ≥4s 可避） |
| 千问模型卡 ACP 说明行 ✅ | ModelsView 千问卡底部加说明：qwen-acp/auto 的定位（chat 桥 403 时的活路）、档位不可选实测结论、自检·ACP 按钮（结果只有成本无千 token 单价）。vue-tsc 0 错 + vite build 通过 |
| ACP 计费自检（第六批的补充验证） | chat 桥 billing-check 真机路径维持阻塞（账号 2 refresh 死 + 账号 3 chat 桥 403）；ACP 路线真机样本再+1（累计 4 轮，成本 0.075~0.2294 方差 3 倍特征稳定） |

### 第八批（2026-11-06 凌晨）

| 项 | 结果 |
|---|---|
| **OpenAI 直通流式的首帧静默缺口 ✅** | `server.js` ping 桥实证缺口：`!translated && !headersSent` 恒 return——OpenAI 直通分支（qwen/qwen-acp/qianfan/qoder 的 chat completions 流式）在首帧前**一条 ping 都发不出**，而 ACP 首帧实测 14~35s、qoder 大上下文 30~70s，中间代理空闲超时照样断（保活等于没做）。修法：send 起跑 5s（`DUMATE_PING_QUIET_MS`）仍无首帧 → 先发头放开 ping。5s 足够快速错误以 4xx 返回；5s 后失败走 catch 既有的流内错误帧路径，客户端照样看到原因。**真机验证**：ACP 流式 10.9s 出 2 条 ping（改前 0 条）；快速失败仍 4xx。翻译器分支（responses/anthropic/google）语义未动 |
| **ACP 请求零记账的展示误导 ✅** | ACP 请求经网关后 reqlog `cost=null`、tokens 恒 0——acp.send 成功路径无 credits.capture（差值法每请求要 +2 次上游调用，不做），但扣费真实发生，界面 0 token 会被读成「没花钱」、管理端「今日消耗」与真实余额脱节。修法：reqlog 加 `metering: 'wallet-delta'` 标记（按模型前缀判定）+ ReqLogsView 的 tokens 列对标记行显示「无计量」徽标 + 说明文字。API 全量透传无需改 |
| 千问附件（上批 A 项）维持阻塞 | 本批未新增证据，解锁条件不变（官方客户端抓 ACP 发送帧） |
