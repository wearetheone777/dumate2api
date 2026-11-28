# WorkBuddy 通道：双区域协议与风控

> 本文件从 `CLAUDE.md` 的「项目定位」章节按主题拆出，内容为原文照搬（未改写）。
> 改通道细节请改这里；`CLAUDE.md` 只保留核心架构与索引。

**WorkBuddy 通道已接入（2026-11-03，第五通道，`workbuddy/` 前缀，双区域 cn/global）。**
腾讯 Copilot 系 AI 编程助手（国内 WorkBuddy / 国际 WorkBuddy AI），与 CodeBuddy 同源。
协议要点移植自 qoder-trae-workbuddy-switch 的 `modules/{upstream,region,account,checkin}.rs`
与 TraeWorkAssistant 的 `wb_*.rs`（两个参照项目交叉实证）：

1. **标准 OpenAI 协议 + SSE**（`/v2/chat/completions`），但有多条硬校验：
   强制 stream:true（非流式 11101）；`developer`→`system`（拒 developer 400/11128）；
   tool_choice 对象扁平化；**首条必须 system**（Go struct 硬校验 400，非 system
   前置最小 system，两版都做）；**conversation_id 必须注入 body + X-Conversation
   三头必带**（dsh-xdpool#58 实证：国际版缺任一头即 400 11128 "request illegal"，
   值不校验只查存在）；prompt_cache_key（`wb-<uid8>-<sha256(uid|conv)[..16]>`）
   按账号硬隔离前缀缓存。**红线：chat 请求绝不带 X-Refresh-Token**。
2. **双区域端点不同**：cn chat=copilot.tencent.com / billing=www.codebuddy.cn /
   模型目录 `/console/enterprises/personal/models`（CLI 形态 UA）；global
   chat=billing=www.workbuddy.ai / 目录 `/v3/config`（App UA `WorkBuddyAI/<v>`
   + X-Product: SaaS）。两区账号不通用，`region` 字段存 cn/global。
3. **失败分类**（classifyStatus）：402/积分标记 → hard_credit；"Offline user
   session not found"/12153 → session_dead；**11140 → restricted（账号级风控，
   换号有意义）**——send() 内做受限换号循环（区内轮完一圈），403 明确报错。
   **码值匹配带负向数字断言**（`"code":11140(?!\d)`）——裸 includes 会误吃 111400。
4. **账号来源**：**浏览器 OAuth 设备授权登录（2026-11-04 接入，推荐）**——
   `POST {chatBase}/v2/plugin/auth/state?platform=CLI` → `{state, authUrl}` →
   浏览器登录 → `GET /v2/plugin/auth/token?state=`（等待中的业务码 **11217**）→
   `accessToken/refreshToken/expiresAt|expiresIn/domain` → `GET /v2/plugin/login/account`
   取 uid/nickname（失败回落 JWT `sub`）。**浏览器只是授权面，token 由上游按
   platform=CLI 签发**——不是抓网页 cookie；多账号 = 每个账号各走一遍（换账号或
   无痕窗口）。协议由 `linguo2625469/workbuddy2api-panel`（Go `cmd/login/main.go`）
   与 `ardeyouxipianyi/workbuddy2api-hub`（Python `wb_accounts.py`
   start_login/poll_login）两个实现交叉验证；state 端点本机实测 200。
   实现 `src/workbuddy/login.js` + 管理端 `POST /workbuddy/login/{url,poll}` +
   账号页「浏览器登录」按钮（2 秒轮询、10 分钟窗口）。
   替代来源保持不变：**导入官方客户端认证文件**（`workbuddy-desktop[-ai].info`，
   结构 `{account, auth:{accessToken, refreshToken, expiresAt, domain}}`，
   `POST /workbuddy/import-client {region}`；注意新版国内客户端对 token/nickname
   做了 at-rest 加密，明文导入可能拿不到 token——hub 有 desktop_decrypt_tokens
   实现，我们未接）或**手动粘贴 token**（`/workbuddy/import-token`）。区域红线：
   凭据域必须与目标区域一致，不符拒绝导入。**刷新单飞 + 到期续期**照 TRAE 同构；
   刷新头按区域区分（2026-11-04 对齐 hub）：国内 `X-Auth-Refresh-Source: workbuddy`，
   国际 `plugin`，另带 `X-User-Id`/`X-Domain`/`X-CodeBuddy-Request`/`Accept-Language`。
5. **签到仅国内版**（`/v2/billing/meter/checkin-activity-status` 回退
   `checkin-status`、领取 `daily-checkin`；幂等，"已签到"按成功）；国际版
   明确报「该版本暂不支持自动签到」（`unsupported`，界面显示「不支持」不是错误）。
   额度是 billing 域 `get-user-resource` 的套餐包列表（ProductCode p_tcaca，
   CycleCapacity 三件套口径），`/workbuddy/credits` 按区域出。
6. **真机验证（2026-11-03）**：国际账号导入成功（wearetheone777，workbuddy.ai），
   国际模型目录 22 个直通（含倍率/免费档/上下文上限+默认档/思考档位）；
   chat 首打 11128（缺会话头）→ 补三头后变 11140（账号风控）= 协议层打通，
   该账号在上游本身受限（issue #136 同款），账号恢复属登录流程后置。
   国内客户端登录态 9/18 已死（12153 refresh invalid），待用户重登客户端再导入。
   离线验证 `node --test test/verify-workbuddy.js`（9 项：规范化/会话注入/
   缓存键/三头红线/分类含 11140 负向断言/区域表/倍率解析白名单）。
7. **「播报即收尾」修复 + 计费自检（2026-11-04）**：`runConversation` 接入共享修复
   （带工具的请求才启用；流式正文过 `createChunkGate`、非流式聚合后判定；
   `DUMATE_WORKBUDDY_REPAIR_RETRY` / `_HOLD_CAP`）。**顺带修掉流式结束帧的既有
   bug**——原来发 `data: [DONE]\n\n`，经 server.js 会再补一次前缀变成
   `data: data: [DONE]`（标准哨兵匹配不上），改为与千问/Qoder 一致的裸 `[DONE]`
   由桥统一包装。计费自检 `GET /api/admin/workbuddy/billing-check?model=`：
   套餐**剩余额**前后差值（**消耗 = 前 − 后**——与 TRAE 的 consumed 递增口径
   相反，照抄会把消耗全算成负数，2026-11-04 单测当场抓到）；国际版没有 credits
   接口，如实 `unsupported`。纯函数在 `workbuddy/billing.js`，模型页有「计费自检」
   按钮（挑最低倍率的付费模型，免费档不做除法）。离线验证：
   `node test/verify-workbuddy-repair.js`（39 项）+ `test/unit/workbuddy-billing.test.js`
   （7 项）。
8. **浏览器 OAuth 登录（2026-11-04，多账号的正路）**：`src/workbuddy/login.js`
   实现设备授权登录（协议细节见上文第 4 条），管理端
   `POST /workbuddy/login/{url,poll}`，账号页「浏览器登录」按钮（2 秒轮询、
   10 分钟窗口）。落盘 `source='oauth'`；uid 取 `login/account`（失败回落 JWT
   `sub`）；`expiresAt` 认毫秒/秒/`expiresIn`/JWT `exp` 四种口径；区域红线按
   hub 的域名标记（cn: `copilot.tencent.com` / `codebuddy.cn` / `workbuddy.cn`；
   intl: `workbuddy.ai` / `codebuddy.ai`）。**这解决了「官方客户端同一时刻只有
   一份登录态、没法多账号」的问题**——浏览器授权天然可重复，每个账号各走一遍
   即可（换账号或无痕窗口）。离线验证：`test/unit/workbuddy-login.test.js`
   （8 项：信封解析/pending=11217/到期归一/区域红线/JWT 回落/端到端入池）。
   至此国内账号不再依赖 9/18 已死的客户端登录态。**真机（2026-11-04）**：
   浏览器 OAuth 登录成功入池（`source=oauth`），`glm-5.3` 对话 →「收到」1.9s。
   两条实测顺带定案：① **usage 缓存字段无需归一**——同一长 prompt 二次请求
   `prompt_cache_hit_tokens=1024` 与标准位 `cached_tokens=1024` 同步填充，
   上游本来就是标准 OpenAI 形状（此前按 DeepSeek 风格推断是错的，未改代码）；
   ② `usage.credit` 在付费档短请求下仍为 0，**不能当单请求扣费**——计费自检
   维持「套餐剩余额前后差值」口径。**计费自检的真机口径补充（同日 UI 实测）**：
   套餐剩余额是**整数积分**（真机 80 个裂变包、remain 全整数），单请求 Δ 最小
   只到 1——倍率测量的分辨率 = 1 ÷ (tokens/1000)，1012 tokens 时 ±0.988，
   比标称 0.08 粗一个数量级，此时 ratio 是量化伪影（首次探针 Δ=1 更可能是
   早先对话的结算延迟串入）。`/billing-check` 响应带 `resolution` 字段、界面显示；
   分辨率 > 标称一半时 warning 明确写「比值不可判读」；`?count=2000`（约 10k
   tokens）可做大样本复测。**计费自检 UI 与整条链路已用 bsk 驱动 Edge 真机走通**：
   OAuth 登录 → 仪表盘账号在线 → 模型页 15 个模型 → 计费自检按钮 → 账号页
   「浏览器登录/导入账号」；网关侧 OpenAI 流式/非流式与 Anthropic 流式/非流式
   均 200，`[DONE]` 正常。
9. **FEFO + 保活 + 图像 + 精确余额（2026-11-04 第三批，全部真机验证）**：
   - **图像输入**：`glm-5.3` / `deepseek-v4.1-flash` 发 64×64 红色 PNG data URI
     都答「红色」——透传天然支持，无需 assertImageSupport（P1-5 关闭）。
   - **fetchCredits 升级**：解析 `CycleEndTime`（**北京时间字符串**，
     `parseBeijingTime` 的结果与 `DeductionEndTime` 毫秒值逐位对照过）与
     `CycleCapacityRemainPrecise`（**精确余额**，整数 remain 是它的 floor——
     真机 "8.8" vs 8）。返回值新增 `totalPrecise` / `preciseDecimals` /
     `packages[].expireAt`。字段缺失不是 0（`num(undefined)=0` 会污染合计，
     单测当场抓到；局部 `num` 是按键取值、别拿它做按值转换，同款坑踩两次）。
   - **FEFO 接入**：`expiring.js` 加 workbuddy 窗口 7 天；`/credits` 按**全量
     账号**写快照（区域视图只过滤展示，traework 同口径）；`index.js` 的
     `fefoUidSet` → `pickCandidate({expiring})`。真机：账号 1 有今天 09:00
     到期的包，快照 `accounts:{"1":…}`、`fefoUidSet=['workbuddy:1']`。
   - **keepalive 加 workbuddy adapter**（refresh/balance）：国内号每日低峰自动
     续期 + 余额快照；国际版没有额度接口，如实 null（不报 0）。
     **checkin 故意不在这里**（2026-11-08 修文档-实现漂移时定案）：签到归
     `workbuddy/autocheckin.js`，两边都签会把上游请求翻倍，且 22:30 签当天太早。
   - **重要口径：国内 CLI 对话当前不实时扣套餐**——连打多次请求
     `totalPrecise` 纹丝不动（11288.98），与 `usage.credit=0` 一致（公测/
     活动口径）。计费探针 `delta=null` 是**真实测量结果**，警告已写实
     （「不实时扣套餐…非故障」）；FEFO 的临期优先仍然有意义（包会到期作废）。
   - 离线：`workbuddy-billing` 13 项（真机夹具）、`expiring-fefo` workbuddy
     窗口、`verify-expiring-fefo.js` workbuddy 段（8 项全绿）。

---

11. **融合批次（2026-11-08，来源 `docs/WORKBUDDY-FUSION.md`）**：8 项从社区项目
    （workbuddy2api-hub / hawklithm / panel）吸收的运维能力，全部默认关闭或只读。

    | 项 | 模块 | 端点 / 开关 |
    |---|---|---|
    | 自动签到排程（**国内签到 + 国际网页打卡**） | `workbuddy/autocheckin.js`（**管理端进程**） | `GET/PUT /api/admin/workbuddy/autocheckin`、`POST .../autocheckin/run` |
    | 连坐参数面板化 | `workbuddy/runtime.js`（mtime 热读） | `GET/PUT /api/admin/workbuddy/restriction/config` |
    | 额度护栏 | `workbuddy/credits-snapshot.js` + `runtime.guard` | `GET/PUT /api/admin/workbuddy/guard` |
    | 11-128 取证 | `workbuddy/dump.js` | `GET /api/admin/workbuddy/dumps`（只读）、`DUMATE_WORKBUDDY_DUMP_11_128=1` 或 `full` |
    | 点名补刷额度 | `/credits?uids=` | 前端积分页「只补刷缺失的 N 个」 |
    | 签到详情页接入 | `admin/routes/checkin.js` 白名单 + `CheckinDetailCard` | 积分页切到 WorkBuddy 即渲染 |
    | Key 账号白名单 | `keys.account_allowlist` | Key 页「账号白名单」 |
    | 413 先响应再排空 | `src/body-limit.js` | `DUMATE_BODY_DRAIN_MS`（默认 5000） |
    | 启动端口占用检查 | `src/port-probe.js` | `DUMATE_PORT_PROBE=0` 关闭 |

    **三处文档-实现漂移本批修掉（都写着有、实际没有）**：

    1. `CHANNEL-WORKBUDDY.md` 第 9 条写「keepalive 加 workbuddy adapter
       (refresh/balance/checkin)」——`keepalive.builtinAdapters` 里从来没有它。
       补 refresh + balance，**故意不补 checkin**（签到归 autocheckin）。
    2. `CLAUDE.md` 写「keepalive 的 global 分支由『不支持签到』改为网页打卡」
       ——`webagent.dailyActivity` 代码齐全但**全库无调用方**，国际版账号其实
       从来没打过卡。现接到 autocheckin。
    3. `CLAUDE.md` 写「国内版 `/v2/report` …keepalive 签到后顺带」——
       `activity.reportActivity` 实际**只在 webagent 的证书降级分支里**被调用，
       正常路径下国内账号的连登从来不会点亮。现接到 autocheckin。

    签到排程因此变成**三条腿**（每条各自幂等、失败不互相拖累、分开计数）：

    | 腿 | 上游动作 | 幂等依据 | 计数字段 |
    |---|---|---|---|
    | 国内签到 | `daily-checkin` | 先查状态，已签跳过、**未知不签** | `claimed` |
    | 国内活跃 | `POST /v2/report` | 账号档案 `lastActivityReport` | `activity` / `activityUnverified` |
    | 国际网页打卡 | ACP 会话跑一轮 | 账号档案 `lastWebActivity` | `webDaily` |

    **`/v2/report` 不校验凭证（2026-11-08 真机实测）**：假 accessToken 也回
    `{"code":0,"msg":"OK"}`，而同一假 token 打 `/activity/growth/streak` 是 401。
    所以 `code===0` 只证明「请求被接」，**不证明「事件被计入连登」**。
    `reportActivity` 因此拆出 `verified`（回读到天数才算），autocheckin 把
    「送达但未验证」单列成 `activityUnverified`——旧实现把 code=0 当成功，
    凭证失效的账号会每天「成功」一次、连登一天不涨，且结果里完全看不出来。

    六条口径（改动前必读，细节见融合清单第六节）：

    1. **签到只有一个排程**（autocheckin）；keepalive 的 workbuddy adapter 故意
       不含 checkin——两边都签会把上游请求翻倍，且 22:30 签当天太早。
    2. **自动签到的「未知状态不签」不许放宽**：查不到就当没有答案，不拿盲签去赌。
    3. **护栏是选号过滤不是请求拦截**：全被剔除时退回全量；快照陈旧/缺失自动失效。
    4. **点名补刷不推进 FEFO 心跳**（`expiring.js` 的 keepIds 语义），长期只补刷会
       让 FEFO 在 6 小时后退回普通轮询——安全方向，不修。
    5. **连坐四个参数现读运行期配置**，env 仍是默认值；`holdSeconds=0` 关闭暂停但
       仍记事件；改短立即截断现有倒计时（`{at, until}` + 现算夹取）。
    6. **11-128 摘要档不含提示词明文**（可长期开），full 档才有原文且 token 脱敏。
       国际版网页打卡**不写签到账本**（`/v2/report` 与 daily-checkin 是两种上游
       动作，混进同一本账会让「签到日历」说谎）。

    离线验证：`test/unit/workbuddy-{autocheckin,activity,runtime,guard,dump,keepalive-adapter}.test.js`
    + `test/unit/{body-limit,port-probe,keys-account-allowlist}.test.js`
    + `test/verify-workbuddy-endpoints.js`（17 项 handler 级冒烟）
    + `test/verify-checkin-workbuddy.js`（7 项：白名单、国际版标不支持、账本渲染）。



### 11.1 账号表客户端分页 + 轮询去重（P2-9，2026-11-08 第二批）

落点：`web/src/utils/paging.ts`（纯函数）+ `WorkBuddyAccounts.vue`。
单测：`test/unit/workbuddy-accounts-paging.test.js`（14 项）。

**为什么把判据抽成纯函数**：分页边界（越界、页大小非法、空集合）与「排序作用
于全量还是当页」在界面上看不出来——翻到第 2 页看到 1 个账号，可能与 bug 长得
一模一样。抽出 `.ts` 后 Node 24 的类型擦除能直接 import 断言，不靠目测、不需要
先构建。这是本项目第一次让单测直接吃 `web/src` 的源码；`paging.ts` 因此刻意
保持零 Vue 依赖（不 import 任何 vue/reactivity）。

三条口径：

1. **筛选 → 排序 → 切页**（顺序不能换）。先切页再排序 = 每页各自成序，
   翻页时同一账号在不同位置出现。
2. **页码一律夹紧**；`pageSlice` 对越界页码返回**最后一页**而不是 `[]`——
   返回空数组等于「数据没了」的错误结论。
3. **`null` 排最后**（升降序都一样）。余额取不到是「未知」，按 0 排会让它
   在升序里沉底、在降序里冒充「最紧急」。

轮询两层去重，缺一层都不够：

- **同签名不赋值**：响应体的稳定 JSON 作签名，不变就不写 `ref` → Vue 依赖链
  不触发 → DOM 节点一个不动。「延迟赋值」仍然重画，不是替代方案。
- **在途不叠加**：只有轮询被档掉；操作后的回落必须真读（否则删了账号界面还
  挂着它）。另加**请求序号**，防止轮询那一轮比手动刷新晚回来把旧数据画回去。

三条轮询约束：只在 WorkBuddy 页签跑（组件级定时器随 `v-if` 销毁即停）、
`document.hidden` 时跳过（后台轮询只给管理端加请求）、`visibilitychange` 切回
立即拉一次（额度/连坐恰恰是切回来最想看的）。弹窗打开期间不轮询
（整表重画会刷掉正在输入的框）。

**实测（隔离实例 9133 + 63 个假账号，真浏览器 + MutationObserver 打点）**：

| 场景 | 观测 |
|---|---|
| 63 账号 / 50 每页 | 第 1/2 页、本页 50 个；第 2 页 1 个 |
| 页大小改 100 | 真的生效（1/1 页、本页 51），且分页条**没有消失** |
| 数据未变的 3 个周期 | **DOM 变动 0 条**（childList/characterData/attributes 全 0），52 张卡探针全保留 |
| 数据变化后 | 卡片重渲染、新昵称如实显示 |

页大小选项必须是**纯数字字符串**（`'50'` 不是 `'50 / 页'`）：ant-design-vue 按
`Number(value)` 解析回传，带单位变 `NaN`，表现为「选择器点了没反应」。

边界（没有顺手改）：**只做了 WorkBuddy 账号页**——其余四通道的账号组件是各自
独立的模板、行类型不同，硬套会把三套形状混在一起；`paging.ts` 纯函数，后续直接
import 即可。服务端仍是全量 `/status`：改服务端分页要动 `/status`、`/credits` 与
FEFO 快照三处，且「本页 50 个」与「护栏要知道全部余额」会打架。当前账号量级下
客户端分页够用。

### 11.2 轮询不许打上游（2026-11-08 二次修正，**本批唯一一次自己引入的问题**）

P2-9 首版把 15 秒轮询直接接到 `load()` 上，而 `load()` 同时拉 `/status` 与
`/credits`。两者的上游代价差两个数量级，实测（40 个假账号 + 计数代理）：

| 接口 | 40 账号一次调用 | 说明 |
|---|---|---|
| `/status?region=cn` | **+0** 上游连接 | 只读本地 `workbuddy-accounts.json` 与连坐快照 |
| `/credits?region=cn` | **+160** 上游连接 | 每号 4 次：签到状态 + 备用端点 + 额度 + 档位 |

也就是说首版在 40 个账号时是**每 15 秒 160 次上游请求 ≈ 每小时 3.8 万次**。
这与第 11 条「自动化节奏宁少勿多」正面冲突，而且动机极其薄弱——没人盯着看
「今日签到」在 15 秒内变化，为了它去撞 11140 不值得。

修法：`load(opts)` 增加 `credits` 开关（**默认 true**——进页面/手动刷新/操作后
回落本来就该花这个成本），轮询路径 `pollTick()` 显式传 `credits: false`。
`visibilitychange` 回调也走 `pollTick`，不许直连 `load`。

**轮询本来要解决什么**：不是「余额实时刷新」（那是分钟级数据，也不该实时），
而是「页面开着时，后台刚跑完的自动签到 / 别人改的连坐配置能自己反映出来」——
这两件都在 `/status` 里。想清楚这一点，`credits: false` 就不是妥协而是正解。

配套（否则会制造新的假象）：额度既然只在手动刷新时更新，界面就必须**如实标出
它有多旧**。账号列表头部加「额度更新于 N 分钟前」，超过 5 分钟转橙色并提示
「已过期，点刷新重取」。判据抽到 `web/src/utils/lastError.ts` 的 `isStale()`
（纯函数，6 项单测锁边界：TTL 内/恰好 TTL/超 1ms/空值/TTL<=0/未来时间戳）。
不抽出来的话，这条只能靠肉眼等 5 分钟验证一次，回归必然漂。

真机复核（隔离实例 9135 + 12 个假账号）：进页面显示「额度更新于 刚刚」，
70 秒后自动变成「额度更新于 1 分钟前」——`nowTick` 由轮询推进，
相对时间文案不会停在首次渲染那一刻。

离线验证：`node test/verify-workbuddy-accounts-poll.js`（10 项：轮询路径必须
`credits:false`、`visibilitychange` 不许直连 `load`、全局不许有「静默但打上游」
的 `load` 调用点、`workbuddyApi.credits` 只能出现一处）+ `test/unit/last-error-stale.test.js`（6 项）。
`verify-workbuddy-accounts-poll.js` 断言的是**字面量形状**而非行为——为一条
「参数传没传」的断言去搭 ant-design-vue 全套挂载环境不划算，而这条不变式
恰好在源码里一眼可查、评审时也最容易被看漏。

### 11.3 FEFO / 护栏快照的「谁来保鲜」缺口（2026-11-08 第三批，真机实证）

**先说证据**（不是推测，是 `data/` 里的实际文件）：

```
data/expiring-snapshot.json → channels.workbuddy.at 距今 101.7 小时（TTL 6h）
data/workbuddy-credits-snapshot.json → 文件根本不存在
```

结论：**WorkBuddy 的 FEFO 临期优先在实际环境里长期失效，P1-6 额度护栏从上线
至今一秒钟都没生效过**（它读的护栏快照没有任何数据源，即使把开关打开也不会
拦下任何账号）。两份快照的写方只有管理端 `/credits`——运维不点开 WorkBuddy
的账号页/积分页，它们就永远停在上次打开的时刻。

#### 补的两条腿（都不新增上游请求）

1. **每日 keepalive 顺手写**：workbuddy adapter 每天本来就打一次
   `fetchCredits`，到期时间与精确剩余**已经到手却只留了余额**。新增
   `persistSnapshots()` 把这两个副产物写进两份快照，口径与 `/credits` 严格
   一致（同一个 `expiring.update` / `credits-snapshot.update`）。
   `balance()` 也据此多返回 `precise` / `expireNearest` 两个字段。
2. **低频巡检（`balance-refresh` 扩展）**：keepalive 每天一次只覆盖 6/24 小时，
   剩下 18 小时快照照样过期。把 WorkBuddy 接进**已有的**
   `src/balance-refresh.js`（10 分钟级、默认关闭）而不是再起一个定时器——
   多一个定时器只会让上游看到更密的节奏。它复用同一个 adapter 的
   `balance` + `persistSnapshots`，不重写。

`adapter.persistSnapshots` 是**可选能力**：没有它的通道被静默跳过（`typeof
ad.persistSnapshots !== 'function'` → continue），不影响任何现有通道。

#### 五条口径（都有单测，见 `test/unit/workbuddy-keepalive-snapshot.test.js`）

| 口径 | 为什么 |
|---|---|
| 只写**未过期且在窗口内**的到期时刻 | 已过期的包上游已废止，优先消耗没有意义 |
| 查询失败的账号走 `keepIds`，且 **at 不推进** | 「查不到」≠「无临期」；「部分数据是旧的」不能让快照看起来新鲜 |
| 护栏快照失败账号**不写入**（不是写 0） | 写 0 会让护栏把「未知」当成「用完了」 |
| `precise` 优先于整数 `remain` | 整数是 floor，阈值判定会误伤（真机 "8.8" vs 8） |
| 国际版如实失败 | 那边没有额度接口，报 0 = 凭空造数 |

#### 真机验证（隔离实例 + 真实账号副本）

```
余额 1(cn):     ok=true  remain=10471.61 precise=10471.61 expireNearest=1794099617000
余额 2(global): ok=false remain=null
persistSnapshots: {"fefoWrote":true,"guardWrote":true,"entries":1,"failed":1}
FEFO workbuddy:   {"at":...,"accounts":{"1":1794099617000}}
护栏快照:          {"at":...,"accounts":{"1":{"remain":10471.61,...}}}
读方视角:          accountIds → Set{'1'}；lowAccounts(1) → null（余额充足）
```

三条边界也验过：全失败时 at 不推进且旧条目保留；TTL 过期后
`accountIds` 与 `lowAccounts` 都返回 null（退回普通轮询/护栏失效）；窗口外
（已过期 / 60 天后 / 无到期）三种都不进 FEFO 但余额照写。

#### 前端：终于有入口了

`balance-refresh` 此前**只有接口没有界面**（旧文档写着「前端视图未做」），
等于把修复挂在一个运维找不到的开关上。在 WorkBuddy 账号页「自动化与护栏」
卡里补第四块（开关 / 间隔 / 立即巡检一轮 / 上次回执），与已有三块同形。

一个刻意的文案判据：WorkBuddy 段**必须区分「查到了但没有临期」与「一个都没
查到」**。实测全失败时 `entries=0`，若显示「临期 0 个号」就是把「无知」说成
「确认没有」——本项目最忌讳的假象。现在显示「全部查询失败，快照未更新」。

真机点通：界面开开关 → `data/balance-refresh.json` 落盘 `enabled:true` →
点「立即巡检一轮」→ 两份快照被创建（`accounts:{}` 因为 6 个假账号的代理
是死地址，全部查询失败——这正是上面那条文案要表达的状态）。

### 11.4 身份头补全与 11140 归因（2026-11-08 第四批，真机对照实验）

#### 补的头

`chatHeaders` 原先缺两组头，本批补上：

| 头 | 值来源 | 为什么必须有 |
|---|---|---|
| `X-Machine-ID` | `md5("machine:"+uid)` → UUIDv4 形状 | 上游的**设备关联键**。用进程级常量会让整个账号池被看成同一台设备，一个号触发 11140 时其余跟着连坐——比 IP 连坐更难处置（IP 有代理槽，设备指纹没有） |
| `X-Session-ID` | `md5("session:"+uid)` → UUIDv4 形状 | 同上，另一个盐 |
| `X-Root-Request-ID` | 本请求 msgId | 桌面端无父 span，root 与本请求同级 |
| `X-Trace-ID` / `X-B3-TraceId` / `X-B3-SpanId` / `X-B3-Sampled` | 每请求随机 | 链路追踪族，桌面形态实测都带 |

同时修正一处口径错误：`X-Request-ID` 与 `X-Conversation-Message-ID` **必须同值**
（官方客户端把 message id 镜像到 request id）。此前两者各自随机，等于把「一次
用户发送」记成两次请求，配额统计会莫名翻倍。

派生为什么用 md5 而不是 `randomUUID`：**跨重启稳定**——同一账号每天是同一台设备
才像真人；每次启动换一个设备 id 反而是最明显的机器特征。

#### 11140 的归因（严格 A/B 对照，两组各只发一次）

补头之后真机连续两次撞 11140，怀疑是新头诱因。做了严格对照（自己拼 https 请求，
只控制这 7 个头的有无，间隔 3s）：

```
[A] 原始头（无设备头/B3 族）  → OK（流式正文正常返回）
[B] 带新头（设备 + B3 族）    → OK
结论：新头无害。
```

**真实成因**：`wb.send` 的选号在只看模型名、不看区域时会把「国内模型名」发给
国际账号。实测国际账号的错误码分两类：

```
国际账号 + 国内模型名 deepseek-v4.1-flash → 11140
国际账号 + 国际模型名 default-model        → 11140
```

两类都是 11140，说明**那个国际账号本身已在风控态**（chat 被拒，但 `/busy` 这类
只读接口照常返回 `unsupported:true`）。所以：11140 是账号状态，不是头的诱因。

**留给后来者的判据**：`/busy` 与 `/credits` 能通**不代表 chat 能通**——只读接口
不过内容风控。判断一个账号是否可用，必须打一次真实 chat，不能用只读探针代替。

#### 11.5 按模型名收窄区域（2026-11-08 第五批，真机事故驱动）

**事故链**（完整还原）：

1. 补身份头后真机连续撞 `11140 request illegal`，看起来像「新头是诱因」。
2. 严格 A/B 对照（自己拼 https，只控制那 7 个头的有无，各发一次）：
   ```
   [A] 原始头（无设备头/B3 族）→ OK
   [B] 带新头（设备 + B3 族）  → OK
   ```
   **新头无害**。
3. 真因：`accountsForRegion()` 只在调用方显式传 `opts.region` 时才过滤，
   不传时 `usable` 是**两区账号混在一起**，于是国内模型名被发给国际账号。
   上游对这种组合回的是 **11140（风控码）**，不是 11102（模型不存在）——
   一次正常请求因此看起来像「账号被限制」，进而触发连坐暂停把整条通道弄停。

**修法**：`models.regionOfModel(model)` 用**已缓存的目录**推断模型归属区域，
选号时按它再收窄一次。三条纪律：

| 纪律 | 为什么 |
|---|---|
| **只用缓存目录**，不在选号热路径打上游 | 为判区域多打一次上游是明确倒退 |
| 判不出来（两侧同名/两侧都没有）→ **null 不拦** | 宁可让上游报 11102，也不凭猜测拒掉可能合法的名字（自定义别名、新上线模型） |
| 收窄后若一个账号不剩 → **不窄化** | 缓存可能过时，「本地以为只属于某区」不该让请求必失败 |

只在调用方**没指定区域**时按模型收窄——API Key 的 region 是更强的运行期约束。

**真机实测的目录事实**（2026-11-08）：

```
国内 16 个：auto, hy4free, hy4std, hy3, deepseek-v4.1-flash, glm-5.3, glm-5.3-flash,
            glm-5.2, kimi-k3.1-pro, kimi-k3-1, kimi-k2.8-preview, space-bunny,
            minimax-m3.1-flash, deepseek-v4-pro, step-5-preview, mimo-v2.6-pro
国际 21 个：default-model, max-model, hy4free, hy4std, hy3, deepseek-v4.1-flash-sg,
            gpt-6-* / gpt-5.6-* / grok-4.7 / gemini-3.8-flash / glm-5.3 / glm-5.3-flash,
            kimi-k3.1-pro, kimi-k3.1-pro-highspeed, kimi-k3, minimax-m3.1-flash
两区同名 7 个：hy4free, hy4std, hy3, glm-5.3, glm-5.3-flash, kimi-k3.1-pro, minimax-m3.1-flash
```

→ 这 7 个名字**判不出区域是正确的**（两边都能用），界面/文档不要把它们当成「区域未知的异常」。

**修复后真机复核**：不再出现 11140；`deepseek-v4.1-flash` 只选国内账号，
上游回 11102 `model [] service info not found`——注意 `model []` 里的空方括号是
**上游自己内部字段**的取值，同一次请求 `buildChatBody` 出来的 body
`model` 明确是 `"deepseek-v4.1-flash"`（已逐字节核对）。这条 11102 属于该账号
对某类模型的路由缺失，与本次改动无关。

**测试注入点**：`models._setCatalog(region, ids)`（传 null 清空）。没有它，
`regionOfModel` 只能测到「无缓存返回 null」那一半，收窄那一半永远测不到——
本项目对「没导出的内部推导就是没测到的内部推导」已有多次教训。

#### 11.6 判定顺序的一次自我修正（2026-11-08，单测当场抓到）

加 14018（积分耗尽）时，第一版把它插在 `HARD_CREDIT_MARKERS` 之前、
`RESTRICTED_CODE_RE`（11140 账号风控）之后，自认为顺序没问题。单测立刻报：

```
AssertionError: 'hard_credit' == 'restricted'
```

**真因**：`HARD_CREDIT_MARKERS` 里本来就有 `credits exhausted` / `额度已耗尽`
这类文案，而它排在 11140 判定**之前**。于是一个「账号被限制」的响应，只要文案里
带一句 quota 相关词，就会被判成积分耗尽，账号进 12 小时硬冷却；而真正该做的是
**停止整个区域的换号**（11140 的处置是「不换号 + 连坐计数 + 区域暂停」）。

**修正后的判定顺序**（改动前必读）：

```
402
-> 11140 账号风控        必须最先：风控时「积分够不够」没有意义
-> 硬额度文案（原有）
-> 会话作废标记 / 裸 401
-> 14018 积分耗尽        高于 6004：账号级耗尽时模型级窗口已无意义
-> 6004 模型级额度
-> 请求级四类（queue / model_unavailable / reasoning / tool_pair）
-> 429 / 404 / 5xx / client
```

**教训**：往一个「按文案匹配」的分类器里插新分支，先确认**已有分支的匹配集
会不会先吃掉它**。这次的 `credits exhausted` 就同时属于两套标记表。

#### 11.7 顶层 tools[] 的指纹清洗（2026-11-08）

原来只清 `messages[]`，**顶层工具定义完全没清**——而工具名/描述/参数 schema 里
的品牌指纹和 system 里的一样会被渠道校验看到。

`buildChatBody` 里新增一行：`if (Array.isArray(body.tools)) body.tools = sanitize.sanitizeTools(body.tools)`。

三条硬约束（`test/unit/workbuddy-sanitize-tools.test.js` 13 项全锁）：

| 约束 | 为什么 |
|---|---|
| **绝不改 `function.name`** | 客户端按这个名字回传 tool_call，改了对不上，工具调用直接失败 |
| **绝不改 schema 结构**（type/required/enum/default/additionalProperties） | 动结构等于让模型的参数生成失效——比留下指纹更糟 |
| 只清 `description`（含递归 schema 内的） | 那是 schema 里唯一的自然语言 |

**写这一批时被单测抓到的真 bug**：第一版用 `sanitizeText(desc, false)`，
而 `identity=false` 会**跳过 `IDENTITY_RE`**——正好是「powered by …」这类品牌句
的规则。结果整个清洗对 tool description 完全无效，13 项里 2 项直接失败。
改成 `identity=true` 才对。

保留契约开关 `DUMATE_WORKBUDDY_PRESERVE_CONTRACT=1` 时整个工具数组原样返回。

#### 11.8 成长中心只读聚合（2026-11-08）

调研把「成长任务引擎」列为本项目最大缺失项。本批只做**只读**部分：

| 端点 | 前缀 | 真机结果（2026-11-08） |
|---|---|---|
| `/activity/growth/streak` | 无 `/v2` | 连登 7 天，下一档 14d 还差 7 天，补签卡 2/4 |
| `/activity/growth/heatmap` | 无 `/v2` | 365 格点亮 79 格，今日 score=0 |
| `/v2/activity/growth/tasks` | **有 `/v2`** | 19 项全部 claimed，累计 2300 积分 |
| `/v2/activity/growth/energy` | **有 `/v2`** | 余额 5，累计获得 175、消耗 170 |
| `/v2/activity/growth/buddy/quota` | **有 `/v2`** | 可开 0 次（能量 5 < 单次 10），上限 5 次 |

**前缀不对称是实测事实**，别「顺手统一」：加 `/v2` 的 streak 会 404，去掉 `/v2`
的 tasks 也会 404。

**一个写接口都不调**（不接取任务、不领奖、不开盲盒），依据：
1. 调研实证「伪造 /v2/report 成长事件会被上游识别为异常，2026-10-15 起国际版
   收紧」——收益（积分）与风险（封号）不对称；
2. 接取/领奖的 body 形状在调研里被标为「未在 unlocked 态验证」。

**一条界面必须守的口径**：`todayScore === 0` 是「查到了、今天没点亮」，
`null` 是「查不到」。混成一句「未点亮」会把上游故障说成「你今天没活跃」。
`redeemable`（已解锁未领取的连登档位）最该提醒——调研说「必须手动领，不领会过期」。

真机复核实现在隔离实例 9137 上做了端到端（HTTP 200 / ok:true / 账号「如约而至」/
errors 空），但**浏览器扩展当时未连接，界面渲染未经肉眼验证**——这条如实记在
待办里，不能算作已验证。

#### 11.9 14018 积分耗尽（2026-11-08）

调研点名的两个坑都在判据里处理了：

1. **码可能藏在 `error.data.code` 嵌套层**，不是顶层 `code`；
2. 文案有**单复数**（`credit exhausted` / `credits exhausted`）。

判成 `hard_credit`（硬冷却到次日重置）而不是 `soft_rate`。漏判的代价是调研原话：
**退化成每 2 分钟重试一次**——14018 常带 429，软冷却几分钟后无限重试。

#### 11.10 视觉验证能力：`tools/ui-shot.js`（2026-11-08）

**为什么需要自建**：CLAUDE.md 明确要求「改完前端别只看接口返回，要用真实浏览器
截图核对可见性」，本项目已经两次栽在「接口 200、界面无感」上（小尺寸 `a-switch`
不渲染 `checked-children`；缓存头让新构建不生效）。而浏览器扩展（bsk）不总是
连着——本批就遇到了「no browser is currently connected」，那条纪律当场落空。

`tools/ui-shot.js` 只用 Node 内置模块与系统已装的 Edge（156）：

```
node tools/ui-shot.js --url http://127.0.0.1:9138/#/web-accounts \
  --user admin --pass xxx --channel workbuddy --region cn \
  --wait 7000 --out docs/shots/x.png --focus "自动化与护栏" \
  --text "成长中心" --text "模型繁忙度"
```

断言失败退出码 1；`--focus` 单独截某个卡片；`--click` 点开按需出现的内容。
自检脚本 `test/verify-ui-shot.js`（8 项，已进 `npm run verify`）锁住**踩过的 7 个坑**。

##### 工具自己踩的两个坑（都被自检锁住了）

1. **只换 hash 不会让 SPA 重读 localStorage**。设完 `lab-channel=workbuddy`
   再 goto 同一个 `/#/web-accounts`，截图**字节数与上一次完全相同**——store 的
   reactive 初始值在首次文档加载时就定了。必须带一个会变的 query 强制整页加载。
2. **整页截图会误判布局**。两列区块高度差大时，滚动到底后截出的整页图看起来像
   「挤成一列」。实测几何是 `flex: 0 0 50%`、宽 634px 两列并排——**是截图方式的
   问题，不是缺陷**。所以加了 `--focus` 单容器截图，量几何而不是肉眼猜。

##### 视觉验证当场查出的两个真 UI 缺陷

| 缺陷 | 表现 | 修法 |
|---|---|---|
| 浮点数未格式化 | 「16 个包 7 天内到期（**1569.4200000000001**）」 | `toLocaleString('zh-CN', {maximumFractionDigits: 2})` |
| 按钮夹在说明文字中间 | 「探测」「查询」落在第 2 行文字的垂直位置，看起来像挤在文字里 | 按钮提到**标题行**右端，说明文字独占下面整行（与「额度护栏」的开关位置一致）。实测几何没重叠（按钮 x=833、左块宽 556），纯粹是「多行文字 + 垂直居中」的视觉错位 |

两处都是**纯看接口永远发现不了**的问题。第二处尤其典型：DOM 结构合法、
元素不重叠、点击也正常，只有人眼看到才会觉得不对劲。

留档：`docs/shots/wb-accounts.png`（整页）与 `wb-accounts-focus.png`（自动化与护栏卡片）。

#### 11.11 保留积分下限（creditFloor）接线（2026-11-08）

**又一个「机制有、接线没接」**：`pool.js` 早就有 `creditFloor` +
`floorBlockedFor()`（余额低于保底线时选号跳过），但 `channel-pool` 从来没暴露
`setCredits`——于是**直连通道的余额从未写进池**，`floor_blocked` 恒为 false、
保底护栏对 WorkBuddy 完全无效。

补的三处：

| 位置 | 改动 |
|---|---|
| `channel-pool.js` | 新增 `noteCredits(channel, id, credits, total)` 与 `creditsOf(channel, id)`（后者给界面与排障用） |
| `keepalive.js` 的 `workbuddy.persistSnapshots` | 顺带把余额写进池。放在 adapter 里而不是各调用点，`balance-refresh` 自动获得该能力、无需二次接线 |
| `pool.js` | `creditFloor` 从 env `DUMATE_POOL_CREDIT_FLOOR` 读（原来硬编码 0，**没有任何数据源**） |

##### 一个当场修掉的真 bug

`noteCredits` 第一版直接 `Number(credits)` 再判有限性：

```js
const c = Number(credits);          // Number(null) === 0 ← 这里就错了
if (!Number.isFinite(c)) return false;
```

于是 `noteCredits(ch, id, null)` 返回 `true`、池里写进 `credits: 0`。
后果不是「显示不对」，而是**保底线永久拦住该账号**——表现是「这个号明明有额度
却从不被选中」，且从任何界面都看不出原因。

修法：**先判 `null/undefined/''`，再 `Number()`**。单测锁住五个值
（`null` / `undefined` / `''` / `NaN` / `'abc'` 全拒绝；`0` 是合法余额、要写入）。

##### 生效路径的诚实说明

`pool` 的配置在 `createPool` 时定死（`const o`），没有运行期改入口，所以
`creditFloor` **只能启动时读 env、重启才生效**。而 `runtime.guard.creditFloor`
是运行期配置——两者会不一致。

这条不一致必须在界面上说清，否则「改了没反应」会被当成 bug。做法：
- `/guard` 响应里多带一个 `poolFloor`（pool 当前**实际生效**值）
- 界面在两者不等时标红「需重启网关才生效（当前生效 N）」
- 保存时提示「保底线已保存（需重启网关才生效）」

真机验证（9140，`DUMATE_POOL_CREDIT_FLOOR=100`，配置值 0）：
界面显示「保底线 0 积分（0 = 关闭）**需重启网关才生效（当前生效 100）**」。

##### 边界

`creditFloor` 与 `guard.threshold` **不是一回事**，两者叠加生效：

| | 语义 | 数据源 | 陈旧处理 |
|---|---|---|---|
| `guard.threshold` | 选号过滤：快照里余额低于它就不选这个号 | `credits-snapshot.json`（6h TTL） | 快照陈旧 → 护栏自动失效 |
| `creditFloor` | pool 层保底线：写进池的余额低于它就整个跳过 | pool state（`noteCredits` 写入） | 没有 TTL，靠下一次写池覆盖 |

**默认值 0（关闭）**：保底线是运维策略，不是通用最优——有人希望榨干、有人希望
留余量。默认拦会让「明明还有额度却不用」变成难解释的行为。

#### 11.12 排队位次的人话化（2026-11-08 收尾批）

调研（dsh-connect-workbuddy）专门做过这件事：把上游 6020/6021/6022 的排队事实
翻成一句用户能懂的话，而不是让用户看到「429 限流」。

两处改动：

1. `statusOf` 显式给 `queue` 返回 **429**（原来靠兜底分支掰出 429/400）——
   429 是「稍后再来」的正确语义，客户端会退避重试；给 400 就直接失败了。
2. **`e.message` 换成人话**。只挂 `queueInfo` 字段是不够的：客户端读的是 message，
   用户看到的仍然只有「429」。现在 message 变成
   `workbuddy 排队：上游排队中（第 3 位，队列 10），建议 8 秒后重试`。

处置仍是 `feed:'none'`：排队不是账号故障，绝不能喂池冷却。否则一次排队
会把健康账号打进冷却，接下来所有请求都选不到它。

**判据**：`/api/admin/workbuddy/busy` 是「事前探」，这条是「事后说清楚」——
两者互补，都不能省。前者要人工点，后者自动生效。

#### 11.13 凭证退场标记（2026-11-28，与 TRAE 同源的一处缺口）

`auth.ensureFresh` 刷新失败时**静默带旧 token 继续**（`return a`，错误只在请求
真正失败时才浮出来）。这带来两个白白消耗的上游请求：

1. 死号的换票被上游明确拒（`12153` / `invalid_grant`）之后，下一次轮到它
   又白撞一次换票端点——上游答案不会变。
2. 那个 401 走池的 `session_dead` 防误杀计数（**连续 3 次才禁用**，见
   `pool.DEFAULTS.sessionDeadThreshold`），中间两次全是白打的。

修法与 TRAE 完全同构：

| 环节 | 位置 | 行为 |
|---|---|---|
| 判据 | `auth.isRefreshRejected(msg)` | 只认上游原文：`12153` / `Offline user session not found` / `invalid_grant` / `refresh token …invalid/expired/not found`。**认不出不猜**——网络抖/5xx 误标要人工重新登录才能解 |
| 写标记 | `auth.ensureFresh` 失败分支 + `index.js` 的 401 刷新分支 | 标 `refreshRetiredAt`，`lastError` 写成「凭证失效（需重新登录）」 |
| 生效 | `auth.needsRefresh` | 有标记 → 返回 false，不再反复打换票端点 |
| 判废 | `index.js` 选号层 | 标记 + access 也过期 → 直接换号，不带过期 token 吃注定失败的 401 |
| 清除 | `auth.ensureFresh` 成功分支 + `auth.upsert`（带新 refreshToken 时） | 刷新成功 / 重新导入客户端凭证都清标记 |

**`refreshRetiredAt` 的语义边界**：它表示「换不了票」，**不是**「这个号不能用」
——access 若还没过期照样能跑。真正拦它是 `pool` 的冷却/禁用与本层的
「标记 + access 已过期」双条件。

**`invalid_grant` 为什么算终态**：`exchange` 的 guard 2 已经在失败后重读过存储
（别人可能抢先换好了、采纳对方新值）——走到标记这一步说明存储里也没有可用
新值，确属终态。

离线验证：`test/unit/workbuddy-refresh-retired.test.js`（6 项：判据正反、
被拒打标、抖动不打标、成功清标、upsert 清标/保留）。

### 11.5 成长任务写路径探针定案（P0-6，2026-11-28，账号 1 cn）

探针脚本 `test/probe-workbuddy-tasks.js`（可重跑：`node test/probe-workbuddy-tasks.js <账号id>`），
全部安全形状（空 accept 数组 / 已领码 claim / 未断签日期 / locked 档）——**零副作用**：

| 端点 | 探针结论 | 实现 |
|---|---|---|
| accept | `POST /v2/activity/growth/tasks/accept`（chatBase）与**无 /v2 前缀双路由都存在**——空数组双双回 `400 task_codes is empty`（参数校验先于前缀分流，本形状区分不了前缀）。字段名 `task_codes`（复数数组）确认 | 取 /v2（misakano 口径） |
| claim | **必须走 web 域** `POST https://www.workbuddy.cn/activity/growth/tasks/<task_code>/claim`：任务码在**路径**、无 body、头族带 `x-client-platform: web` + Origin/Referer workbuddy.cn；已领码回 `200 code=0`（幂等）。CLI 域的 `/v2/activity/growth/tasks/reward/claim` 回 `400 task not completed`——**路径不存在**（misakano 同结论复现）：400 不是「任务没完成」的意思，别误读成该重试 | `tasks.js` webClaimHeaders |
| redeem | `POST {chatBase}/activity/growth/redeem`（无 /v2），body `{tier, client_token:"u-<uuid4>"}`；locked 档误发回 `409 该档位本月已兑换`（月度业务态）。实发字段带 `_granted` 后缀（`credit_granted` 等；`credit` 恒 null，读它必漏计） | `tasks.redeemUnlocked` |
| makeup | `POST {chatBase}/activity/growth/makeup-cards/use`，字段名定案 **`target_date`**——`date` 变体被上游拒 `invalid target_date format`；未断签日回 `400 date is not broken, no makeup needed`（正常竞争，不耗卡） | `tasks.makeupBrokenDay` |

补签候选判据（misakano 移植）：heatmap score==0、≥ 当月月首、< **响应的 `today.date`**（不用宿主机时钟——UTC 机器北京 08:00 前会算错天）、不在 `streak.makeup_dates`（已补过的日期上游会记账）、≥ 2026-06-17（成长体系上线前无意义）；最近断点优先，每轮 ≤1 张。

企业号闸：`enterpriseId` 非空的账号跳过全部成长写腿（组织账号行为自动化不碰）。判据单一出处 `tasks.enterpriseBlocked()`，autocheckin 第四腿与管理端共用。

**行为链红线（重申）**：聊天任务/专家/模板/旅行/盲盒/抽奖不接——计数型任务上游校验真实会话 messageId，伪造不计数还增暴露面；抽奖含实物收件、盲盒覆盖旅行记录，不可逆。

落地：`src/workbuddy/tasks.js`（三动作 + 执行队列骨架 runExclusive）＋ autocheckin 第四腿（`DUMATE_WORKBUDDY_TASKS_SWEEP` 默认关）＋ 管理端 `POST /api/admin/workbuddy/tasks/{sweep,redeem,makeup}`（手动按钮，账号间并发 + 账号内 TryLock）＋ `GET /tasks/scan`（三桶扫描，P1-7）。任务列表 accept 双形状（progress 对象 / 平铺字段）与 streak 双形状（`tiers[]` 描述数组 + 平铺 `tier_Nd_status` 键）都已实测并用单测锁（`test/unit/workbuddy-tasks.test.js` 11 项、`test/unit/workbuddy-growth-scan.test.js` 8 项）。

### 11.6 批次四：failover / 官方用量账本 / P2 三件（2026-11-28）

**P1-4 failover 一期（`src/workbuddy/failover.js`）**。基础设施三态 408/502/503 计入熔断（504 刻意排除——网关超时重放无意义还拉长尾延迟）；60 秒窗口 ≥3 次打开，退避 15→30→60→120s 封顶，任一成功全重置。cn 链 `[copilot.tencent.com, www.workbuddy.cn, wb.tencentbuddy.com]`，**两备用都开着才插静态 IP `162.14.3.241` 影子候选**（Host/SNI 仍原域名，只换连接目标）；每请求最多一跳；body 带 `retry_policy.retry===false` 时既不切换也不记熔断（上游明说别重试）。global 单元素链——没有备用入口的证据就不编。chat 层两跳全败如实 status 0，`bufferStream` 用 PassThrough 与 readAll/readStream 消费端兼容。

**P1-6 官方逐请求用量账本（`src/workbuddy/usage.js`）**。`POST {chatBase}/billing/meter/get-user-request-usage`（xu20060420 usage_official.go 取证）：RFC3339(+08:00) 字符串 + pageNum/pageSize，CN/global 同路径无 /v2。分页终止判据「本页条数 < pageSize」为主（部分域 Total 恒 0，只看 Total 会首页即断）；**第 2 页起失败记 error + truncated**——统计了前半段必须可见，绝不静默少算。口径两条钉死：`credit` 显式 null ≠ 0（`Number(null)===0` 会把「不知道」洗成「免费」）；官方账本（含客户端直连）与网关 reqlog（只覆盖经本网关）是**覆盖面不同的两本账**，不是「一个总量的两部分」。管理端 `GET /api/admin/workbuddy/usage-official` + 积分明细页「官方账本（逐请求）」卡。

**P2 reset 解析放宽（constants.js `parseRateLimitReset`）**。三种形状：措辞前缀（reset at/将在）→ UTC 后缀 → 裸墙钟兜底；小时位一律 `\d{1,2}`（上游写过 9:00:00 不补零，`\d{2}` 会漏）；**无时区标记按北京时间墙钟**——旧实现按 UTC 会让重置时刻提早 8 小时，冷却缩水 8h、账号提前解冻反复撞墙。6004 解析不出墙钟时默认 300s（模型窗口用满的量级：比瞬时抖动长、比次日重置短）。

**P2 11151 空 text 段补位（chat.js `guardEmptyTextParts`）**。形状表（misakano empty_text_part.go，kimi-k3.1-pro + cn 号池逐形态实测）：`text` 空串/null/缺失 → 400/11151「a message has empty content」**不可自愈**（重试重放同一段历史，多号池只会把坏请求撞满一轮）；`"   "` 放行（只判零长度不 trim）；textarea 等未知 type 不校验；对象形态不嗅探。**字符串 content 跳过空白后以 `[` 开头会被当 parts 数组解析**——工具结果里的表单/按钮抓取恰好是这个形状。修法只补值不删段（补一个空格对模型无语义影响）；字符串形态**字节级**补位（扫描器定位 + 每段切片与整体解析 stringify 自证），大整数精度/HTML 实体/键序/前后空白零改动——整体 JSON 往返会把工具输出改得不是客户端发来的那份；**不能用加前缀空格规避嗅探**（上游先跳过空白再解析）。漏网形状兜底：PARAM_ERROR_TEXT_RE 扩 `a message has empty content` + `"code":11151(?!\d)`（负向边界：11151 是 111510 的前缀，必须 `(?!\d)`）→ 400 快速失败不喂池不换号。接线点在 convId/traceId 派生**之前**。

**P2 b3 链路随会话延续（chat.js `sessionTraceId`）**。TraceId 从首条 user 指纹种子派生（与 stableConversationId 同锚 + `|trace` 盐）——比计划里的 LRU 好：无状态、无淘汰失忆、天然「同会话稳定跨会话不同」。span 每请求随机；postStream 接线后 failover 两跳共用同一 TraceId（同一条 trace 的两个 span）；chatHeaders 第五参做 32-hex 形状校验，脏值回落新 uuidv7 绝不外发。

### 11.7 批次五：指纹清洗加固 / 免费模型豁免 / Kimi $ref（2026-11-28）

**指纹清洗三件加固（sanitize.js + 新共享模块 jsonscan.js）**。
① **TraeCode 自述句**：hub 2026-11-24 CN 号池逐条二分实测——上游按「interactive agent in TraeCode」连续短语判非官方渠道（单独 TraeCode / in Trae IDE / in Cursor 均 200，只删 in TraeCode 后真实 23KB system 整体 200），故只删这一段、行为指令原样保留，幂等。
② **注入身份滚雪球**（panel issue #187）：上游服务端注入的身份指令不出现在出站 body，但模型会在 reasoning_content 里复述原文，客户端带回历史下一轮原样进出站——「声明→进历史→再看到→再声明」。正则刻意收紧到整句（单独 `identify yourself as` 会误伤 "Do not identify yourself as an AI." 这类合法指令）；句尾「不接字母数字的句号」收口（身份名可带点，GPT-4.1 不能留半句），句号后字符用捕获组原样接回；`<model_identity>` 标签剥除、内部文本保留。**作用域只洗 assistant 正文与 reasoning_content / reasoning**——system/user 里同形句是用户自己写的人设，字节不动（scope 测试锁）。
③ **工具参数清洗改字节级**：参考实现把 arguments 整串跑文本替换，`{"code":11128}` 会被 11128→11-128 规则改成非法 JSON（上游 11129 bad params——比指纹本身更糟）。现用 jsonscan 扫描器只重写**发生了变化的字符串值**的字面量：数字/键序/转义形态/大整数精度零改动（工具参数里的 64 位 id 很常见，JSON.parse 往返会丢精度）；非法 JSON 原文回落——arguments 会被客户端执行，文本改写 inside 命令/路径会改变行为，宁可漏一条指纹。jsonscan.js 同时服务 chat.js 的 11151 补位（共享扫描器，避免 sanitize↔chat 循环 require）。

**免费模型豁免额度护栏（models.isFreeModel）**。两层判据、**实测终审**：rate-ledger 有样本就按它（EMA=0 免费 / >0 不豁免——上游改口径当场暴露，EMA 淡忘让口径改回后 5~10 次探测内恢复豁免），没有样本才看目录 free 字段。计划的「内置快照」层刻意缺席：没有经核实的免费模型名单，编一个比缺一层更糟（无证据不预编）。'auto' 永不豁免（实际模型由账号决定）。接线两处：send 的 guard.threshold 快照过滤跳过免费模型；pickCandidate 传 `paid: !freeModel`（pool 层 floorBlockedFor 天然跳过）。判不出来不豁免——错放付费模型等同今日行为，错豁免才真绕护栏。顺带修 `rate-ledger.recordRate` 的 mkdir 缺口（全新数据目录首次探针 ENOENT：锁文件先于 saveLedger 的 mkdir 被打开）。

**CN Kimi $ref 内联展开（sanitize.kimiInlineTools）**。CN Kimi 不接受 parameters 里的 $ref/#/$defs（实测 400 11129）。展开语义（kimi_tools.go 忠实移植）：JSON Pointer 转义还原（~1→/、~0→~）、循环引用落空 schema `{}`、缺目标退 `{type:'object'}`、展开后 $defs/$schema 剥除、depth 64 + budget 10000 双保护、预算耗尽整体回落原 tools、**无改动返回原数组引用**（零分配路径）；只展开不裁剪工具（按名裁剪是把某个部署的绕行手段写进共享路径，其它用户的 MCP 工具会静默消失）；非 function 工具保形。门控在 buildChatBody：cn 区域 + /^kimi/i（剥 `cn:` 前缀），非 kimi 零解析零改动，global 不启用。

### 11.8 批次六：零输出守卫（2026-11-28，hub sse.go HeadVetoError 移植）

**病状**：上游 200、流正常收尾（`finish_reason=length`），但正文/思考/工具全空——客户端拿到一个空回答，无从判断是上游故障还是模型真的没话说。panel 的做法是首帧否决（HeadVetoError）：第一个字节写出前发现「上游 error 帧或零有效帧」→ 不写任何字节返回，调用方换号重试，客户端无痕。

**我们的三处判定点**（`runConversation`）：

1. **非流式**：聚合完成后判（`fin0==='length' && !hasCalls && !msg.content && !msg.reasoning_content`）。此时客户端什么都没收到，窗口天然完整。**必须放在修复判定之前**——空正文对 `looksUnfinished` 是「收尾正常」，不先判守卫就原样回空回答。
2. **流式带门**（有工具、修复启用）：`gate.result()` 判 `finishReason==='length' && !text && !toolCalls && !reasoningSeen`。finish/usage/[DONE] 全部还在门里暂扣，否决 = 一轮缓冲整批丢弃，连透传帧都不用补。
3. **流式无门**（纯对话/修复关闭）：回调里跟踪 `sawOut`/`lastFinish`，**尾部暂扣** finish/usage 帧到 [DONE] 前；[DONE] 时刻判定，否决则 [DONE] 不写出。裸关闭（上游没发 [DONE]）同判；**非否决轮的裸关闭要把暂扣帧补发**，别让尾部帧凭空消失。

**无痕口径是「无可见输出帧」而非字节级**（与 panel 的差异，架构约束）：role/空 delta 帧照旧透传——chunkKind 'pass' 的既有语义就是「下游翻译层要它们保持顺序」，四个翻译器对它们零可见事件（逐行核对过 `translateStreamToAnthropic`：空 delta 不开 content_block_start；`message_start` 在翻译器初始化就发，本来就无法避免）。真正的可见帧（正文/思考/工具/finish/usage/[DONE]）被否决轮**零下发**，测试逐帧断言。

**`reasoningSeen` 是半空轮的闸**：思考帧是直发的，客户端已看见——reasoning 非空就不算零输出（计划原文「正文/思考/工具全空」三条件），如实交付不换号（换号会让思考内容出现两段）。缓冲门为此新增 `finishReason`/`reasoningSeen` 两个记账字段（hold 帧暂扣时顺手记 finish_reason；reasoning 直发时置位）。

**处置（`errorActionOf`）**：`zeroOutput → {feed:'none', action:'rotate'}`——不罚账号、不写 lastError、不喂池（空输出与账号健康无关，多半是上游侧临时故障，喂池只会让健康号背锅）。`tried` 集合保证换号不重复，轮转天然以池大小封顶。全池耗尽且死因是零输出时改写 message：连续次数 + 可行动 hint（稍后重试/换一个模型/看管理端通道页），`statusCode 502` + `code zero_output_length`。

**两个实现陷阱**：
- `chat.readStream` 会吞回调异常（`try { onData(...) } catch` 包住了 onData 本身）——回调里只能置标记不能抛；判定点③用 `vetoHit` 标记在 readStream 返回后抛。
- 判定点③的否决条件**不含 `emitted===0`**：emitted 计 role/空 delta 的透传（pass 帧也计数），按它判会把最常见的「role 帧 + finish 帧」零输出形状放过去。

**验证**：`node test/verify-workbuddy-zero-output.js`（43 项：换号无痕端到端 ×3 路径、裸关闭两向、四种不否决形状、耗尽 hint、池不罚、接线自证）+ `node --test test/unit/repair-gate.test.js`（+1 门记账项）。**接线自证必须锁**——零输出守卫是典型的「模块写好、无调用方」温床（qoder-telemetry 教训）。

**明确不做**：finish_reason=stop + 全空**不拦**（「说完了但什么都没说」不是 length 语义，守卫只认 length）；length + 有正文/思考/工具**不拦**（内容已可见，换号会重复）；上游流内 error 帧（200 + error JSON 帧）的否决不在本批（计划只写了 length 形状，error 帧形状没有独立证据，不预编）。

### 11.9 批次七：上游劣化告警 / 目录改版监控 / RT 续期核对 / x-device-token 负知识（2026-11-28）

**上游劣化滑窗告警（alerts 规则 `upstream_degraded`，misakano upstreamhealth.go）**。「全 200 但每个请求 20 秒」的停摆 `error_rate` 看不见——它只数失败。新规则在**5 分钟短窗**内观测两个维度，任一越界聚合报**一条** warn（不按通道拆，拆了就是 N 条告警的「狼来了」）：TTFB≥8s 占比≥30%、5xx（含 502 上游不可达）占比≥10%。三个口径：① TTFB 分母只数报了首字的请求（与 usage TTFB 分桶同一纪律，未标记行不稀释占比）；② 样本不足（默认 <3 条）不判；③ 5 分钟窗刻意短于默认的 1h 指标窗——劣化是短时停摆，长窗会被均值淹没。阈值全部可配（`upstreamWindowMs/upstreamTtfbMs/upstreamTtfbRatio/upstream5xxRatio/upstreamMinRequests`，PUT /api/admin/alerts/config）。**思考重的智能体流量请调高 TTFB 阈值**——首字含思考时间，Claude Code 这种流量 8s 是常态。只观测不联动：劣化不喂池不冷却，账号健康与上游慢是两回事。

**模型目录改版监控（models.catalogWatch + 规则 `catalog_changed`，misakano watchdog.go）**。上游改目录（加/删/改名/调倍率/调上下文）是静默的：本地映射不跟着改，请求就会 404 或计错费。指纹 = sha256(parseCatalog 归一化行)，**复用已有目录拉取**（走 fetchModels 的 10 分钟缓存，零新增上游调用节奏）；首次建档只存基线不告警（没有基线谈不上「改版」），变了就告警并即时更新基线（不判方向——变回去也是改版）。落盘 `data/workbuddy-catalog-fp.json` 跨重启。**「拉不到」≠「改版了」**：fetchModels 失败（无账号/上游 5xx）返回 `ok:false`，根本不进 facts，绝不告警。采集点在 `routes/alerts.js` 的 `facts()`（改 async），评估器只看结论。

**RT >10 天强制续期（L0NE-6）——经核对已被既有行为覆盖，不新做**。keepalive 的 workbuddy 刷新腿自 P1-3（misakano #296 早死观测）起就是**每轮必刷**（720h 窗口恒真等价无条件，带 1h 最小间隔 + `lastRefreshAt` 落盘 + 退场跳过）——「距上次刷新 >10 天强制刷」这个条件在每轮必刷面前恒不触发，加上去只会是死代码。L0NE-6 关心的事（离线 30 天 RT 链断）真正的防线是「keepalive 开着」：keepalive 默认关（新排程不悄悄自启纪律），关着期间本来就没有任何续期路径，这是排程开关的显式选择，不是判据缺口；只要开着，RT 链永远 <1 天新鲜。唯一残值场景（keepalive 关 10~30 天后重开）首轮必刷照样救回来——不需要新判据。

**x-device-token 负知识（Zhengyuuuui，写进「别再试」清单）**：**国际版官方客户端不产 `x-device-token`**（三轮抓包 + 二进制验证）；国内版才有，且一设备一账号。给国际版请求补这个头不是「更像官方」而是**更像非官方**——官方根本没有。别再试。
