# WorkBuddy 通道 GitHub 生态融合方案（2026-11-28 完整版）

> 范围：**只看个人账号可用的功能**。企业号 / 企业模型目录 / 企业计费 / 会员档位锁的内容一律不纳入（详见第五节）。唯一例外：「`enterpriseId` 非空即跳过成长写腿」这条判据收录进融合清单——它是防误发的免费闸门，不依赖企业号。
> 检索通道：`gh api`（已登录）逐仓库深读源码原文。本轮调研由 5 个并行子代理完成，核对过的关键原文：
> - **misakano7545/workbuddy2api-panel**（1538★，2026-11-27 活跃，本地克隆 232433d——即本机 9084 系容器在跑的那份）：`internal/upstream/{tool_pairing,thinking,conv_fields,sanitize,empty_text_part,kimi_tools,global_register}.go`、`internal/scheduler/{scheduler,windowprobe,travel,streak}.go`、`internal/panel/{autotask,taskcenter,usage_official,logstore,config}.go`、`internal/server/{continue,wafip,upstreamhealth,watchdog,embeddings}.go`、`internal/pool/{modelrules,window}.go`
> - **niyouqianma/workbuddy2api-hub**（480★）：**老 hub（ardeyouxipianyi，已删库）同一维护者的续命仓**——CHANGELOG v2.1.5 明写更新源切换、README 赞助邮箱沿用旧号，非 fork 是重建。`wb_tasks.py`（2107 行任务契约全集）、`wb_audio.py`、`wb_embeddings.py`、`wb_webgateway/providers/workbuddy.py`、`docs/OUTBOUND-HEADER-AUDIT.md`、`docs/CLAUDE-DIRECT-AND-EFFORT.md`
> - **yreidev/workbuddy2api-panel**（199★）：`internal/upstream/{headers,official_body,bizcode,failover,address,httpdns,capqueue,search}.go` + `docs/official-client.md`（1395 行官方协议对照手册，含官方升级后的解包 SOP）
> - **Zhengyuuuui/workbuddy2api**（30★）：`server/{codebuddy_proxy,test_fingerprint_headers,probe_models}.py` + `doc/HANDOFF-intl-token.md`（国际版官方 chat 41 头 MITM 抓包全集 + x-device-token 三轮验证）
> - **xu20060420fan-cell/workbuddy2api-trae-qoder-minimax-panel**（140★）：`internal/panel/{usage_official,autotask,taskcenter}.go`、`internal/scheduler/scheduler.go`、`internal/pool/realm.go`
> - **88lin/workbuddy-auto-signin**（2728★）`signin.py`（2867 行全部写动作）；**L0NE-6/WorkBuddy-Daily**（743★）`workbuddy_{daily,intl_daily,login}.py`；**yingfing/workbuddy-switch-python**（`upstream.py`/`automation.py`/`docs/mobile-pairing-protocol.md`）；**hawklithm/workbuddy2api**（39★，`docs/buddy-upstream-alignment-2026-11-21.md`、`tool_pairing.py`）；**NextAgentX/qoder-trae-workbuddy-switch**（465★）；**magicapple123/workbuddy-shift**（48★）；**KouzakiUmi/dsh-unified-router**
> 对照基准：dumate2api `develop`（3740cbc）。关键「缺口」断言已逐条 grep 现源码核实，不凭报告转述：`X-Machine-ID`/`X-Session-ID` 现在在发（`chatHeaders`）、UA 两段形状且版本常量 5.5.6/5.5.2、无任何 `X-Stainless`/`cache_retention`/`harnessMetadata`、`withoutReasoningFields` 只剥不注、`constants.js` 无 11115/14003/10105、11148 的注释写着「修历史配对能过」但 chat.js 无历史修复实现、`DEFAULT_WARN_HOURS=24`、`get-user-resource-summary` 只有套餐合计用途（无逐请求用量）。
> 上一版：`docs/WORKBUDDY-FUSION.md`（2026-11-07 调研 + 11-08 落地；P0-2 成长任务当时卡「无证据不预编」）与 `docs/WORKBUDDY-ADMIN-DEV-PLAN.md`（M1/M2 全部完成、M3 按需）。本方案是第二轮，**取代 WORKBUDDY-FUSION.md 作为融合依据**；旧文档保留不删。

---

## 一、本轮最高价值发现

### 1. 官方指纹基准已更新到 5.11.x / CLI 2.176.0，我们 11.4 批的头有一半要反转

yreidev 把官方桌面端安装包（国内 5.11.3 / 国际 5.11.7，内置 CLI 2.176.0）逐文件解包对照成 1395 行协议手册；Zhengyuuuui 有国际版真实抓包 41 头全集。两个独立实现交叉一致：

- **`X-Machine-ID` / `X-Session-ID` 官方对话根本不发**（11.4 批按 qoder-trae-workbuddy-switch 推断补的头）。当时的 A/B 对照只证明了「无害」，没证明「像官方」。应默认改为不发、env 开关保留旧形态，减头后跑一次 A/B 复核 11128/11140 无新增。
- UA 官方是**三段** `WorkBuddy/5.11.3 WorkBuddy/5.11.3 CLI/2.176.0`（intl 产品 token 是 `workbuddy-ai` 无空格）；我们是两段且版本停在 5.5.6/5.5.2。
- 缺一批官方真发的头：8 个 `X-Stainless-*`（OpenAI SDK 指纹，值全固定）、`X-Agent-Intent: craft` / `X-Agent-Type: main` / `X-Agent-Runtime: local-agent`（CLI 2.165.0 起必有）、`X-Private-Data: "true"`、`X-Client-Version` / `X-Client-Platform: macos` / `X-Client-Product`、`traceparent` + 单行 `b3`。
- id 形状：`X-Conversation-ID` 是 uuidv7 **带连字符**（36 位）；`X-Conversation-Request-ID`/`-Message-ID`/`X-Request-ID` 是 uuidv7 **去连字符**（32 hex，时间有序）。我们用 `randomBytes(16).toString('hex')`——长度对、版本位不对、无时间序。
- **X-Request-ID 配对对象按平台分治**：intl 官方 = `X-Conversation-Message-ID`（与我们 11.4 一致）；**cn = `X-Conversation-Request-ID`**（Zhengyuuuui 抓包口径，我们国内也镜像了 message id——需真机 A/B 定）。
- 两处证据分歧如实记录、不值得翻案，保持现状：`X-CodeBuddy-Request`（Zhengyuuuui 抓包有 / yreidev 读 5.11.3 包没有）、`X-Root-Request-ID`（主对话是否该发）。

### 2. deepseek 系模型在本项目「从不思考」+ Claude Code 前缀缓存 0% 命中

两个独立实测，都指向 `buildChatBody` 的同两个缺口：

- **思考**（misakano panel `thinking.go`，issue #43 逆向 codebuddy.js）：`isThinkingEnabled = !!(reasoning_summary || reasoning_effort || reasoning?.effort)`——**不带 effort 的裸请求上游按不思考应答**。官方「开思考」= body 带 `thinking:{type:"enabled"}` + 默认档（`reasoning.defaultEffort ?? "high"`）；且 thinking enabled 时**每条 assistant 历史必须带 string 型 `reasoning_content`**（无则补 `""`，官方客户端必带、第三方客户端丢回传是常态）。我们对 workbuddy 是只剥不注（`withoutReasoningFields`），deepseek 系在本项目里从未思考过。
- **前缀缓存**（misakano #293 + yreidev `official_body.go`）：官方 2.176.0 的 body 带 `cache_retention:"long"`；Claude Code 每轮改写 system 导致前缀从第 0 token 分叉，misakano 实测把 system 挪到末尾 + 头部恒定桩后命中率 **0% → 99.3%**。另补 `extra_vars.harnessMetadata`（stepIndex / previous.conversationMessageId）与 `extra_vars.initiator:"user"`。yreidev 同时实测：**`prompt_cache_key` 对哪个模型都没用**——缓存按会话 id 稳定 + `cache_retention` 走（我们按账号硬隔离的设计与「缓存按账号隔离」结论不冲突，继续保留）。

### 3. 11148 会顶死整条会话：修复是出站三步，我们只有一行注释

`constants.js` 注释写着「tool_pair_mismatch 11148 修历史配对能过」，但 chat.js **没有任何历史修复实现**。misakano 的 `tool_pairing.go`（380 行 + 7 组子测试）与 hub #26 三修、hawklithm 的实现三方同构：

① 相邻批合并（Responses 回放 call/output 交错 → 前一批成无结果调用）；② 插在工具结果中间的 developer/system 消息挪到整组之后（Codex `<image_resize_notice>` 实测触发）；③ 孤儿调用整条删 + 同 call_id 重复结果只留第一条。hawklithm 加了关键纪律：**歧义历史不静默截断，回 422 `invalid_tool_history` + reason**，不发上游。

### 4. 成长任务「无证据不预编」的卡点解除（四源交叉）

上轮 P0-2 卡住的证据，本轮五个仓库全部给了，且互相印证：

- **misakano**：`autotask.go` 1636 行 + 18 个任务完成 17 个的完整事件链，连「哪个任务认哪个客户端指纹」（CLI 认 www.codebuddy.cn / 桌面认 copilot.tencent.com / web 认 www.workbuddy.cn 纯 Node 形态 11 头）都标好。
- **hub**：`wb_tasks.py` 2107 行，任务接取是**复数数组** `{"task_codes":[...]}`（旧单数一律 400）、分批 ≤20；进度确认后才领奖。
- **xu20060420fan-cell**：25 个任务动作表，全部标注实测账号数；明确「Expert_Philanthropy 真实捐款无法绕过，不做」。
- **L0NE-6（风控红线证据）**：专家/技能任务的 requestId 必须是**真实会话的服务端 messageId（`cmb-<32hex>` 形态）**，自造 uuid 不计数；夜猫子任务 README 明文「要求真实对话（不能指纹伪造）」；国际版 provider 官方 `growth:false`——国际版写事件一个不接。

结论：全走**真实动作流**（真实对话/真实专家/真实资产分享拿 channel_id），伪造 `/v2/report` 事件族坚决不做。接入分两层：低风险的「补领清扫 + 连登兑换 + 补签」先进，行为链后置。

### 5. 三个新上游能力端点 + 官方逐请求用量账本

- **音频**：`POST /v2/audio/speech`（WAV/PCM，15052→413、15053→400）+ `POST /agenttool/v1/asr`（multipart，3MB 上限）——**ASR 是本项目完全没有的能力**。
- **嵌入**：`POST /v2/embeddings`，`bge-m3`（1024 维）唯一实测可用；**嵌入与对话是两套注册表**，`/v3/config` 查不到。
- **agenttool 搜索/抓取**：`POST /agenttool/v1/search`（→ title/url/snippet/site/favicon）与 `/webfetch`（{url,format:"markdown",…}）；**禁跟随重定向**（防 Authorization 外泄）；不消耗模型额度——千问之外的**第二条免费搜索腿**。
- **官方逐请求用量账本**（xu20060420 `usage_official.go`）：上游存在官方逐请求计费接口（带 Credit），分页终止判据以「本页条数 < pageSize」为主（部分域 Total 恒 0，只看 Total 会首页就断）、第 2 页起失败记 error + `truncated`。直接补「客户端里直接对话的消耗看不到」的缺口（R2 的两本账模型 + reqlog 补 `credit` 字段采集是同一缺口的另一半）。

### 6. 错误码全表：11115 是现行真误伤

yreidev 的 `bizcode.go` 按官方 CLI 枚举归类。对照我们 `constants.js`：**`11115` 上下文超长目前会落进普通错误被换号惩罚**——官方口径是不罚号不换号原文返回。另有整族缺失：14003（临时限流 ~30s 当场换号）、6001/6002/6005/6006（冷却到重置时刻）、6000/6003/6007/6008（按模型冷却）、14001 族（冷却到次日 04:00 且**余额刷新恢复就提前解冻**）、10105（chat 路径缺，webagent 有）、11128 两种文案分治、11140 两种文案分治（带 `request illegal` 才是账号风控）。

---

## 二、旧清单落地状态（不重复造轮子）

| 上轮项 | 状态 | 备注 |
|---|---|---|
| 自动签到三条腿 / 连坐保护（11140 不换号+区域暂停）/ FEFO / 额度护栏 / 积分下限 / 计费自检 / 模型级冷却（6004）/ 会话粘滞 / 指纹清洗（messages+tools）/ 身份头 / Key 白名单 / 账号分页轮询 / 成长中心只读聚合 / 凭证退场（refreshRetiredAt，11-28） | ✅ 已实现 | 见 WORKBUDDY-FUSION.md 落地表与 CHANNEL-WORKBUDDY.md 11.x |
| P0-2 成长任务 | ⏸ 当时卡「无证据不预编」 | **本轮解除**（见发现 4），进 P0-6 |
| P3-12 CodeArts / P3-14 消息压缩 / P3-15 DSML / 生图生视频 | ⏸ 维持缓办 | 本轮无新证据推翻 |

**本项目强于生态的点**（上游没做或更粗，不要反向抄）：本地 COSY/签名类不依赖客户端、四协议入口 + 三套 SSE 状态机、每账号独立代理槽、连坐跨进程快照、FEFO 零上游调用、账本原子追加（jsonl 单次 os.write）、`verify-*` 离线回归体系、`ui-shot.js` 视觉验证、余额游标（points-cursor）与 balance-hist、prompt_cache_key 按账号+会话派生（misakano 的 crossacct 探针「缓存按账号隔离」恰好佐证我们的设计）、refreshRetiredAt 双条件判废。

---

## 三、推荐融合清单

### P0 — 协议保真与正确性（第一批，多数是 `buildChatBody`/`chatHeaders` 单点改动）

#### P0-1 出站头逐项对齐 + 「官方头集子集」负向回归

- **做法**：`chat.js` 的 `chatHeaders`/`chatUserAgent` + `constants.js` 版本常量按域分（`DUMATE_WORKBUDDY_APP_VERSION` 兜底语义保留）。补：UA 三段（cn/intl 产品 token 分开）+ 版本升 5.11.3/5.11.7 + `CLI/2.176.0`；8 个 `X-Stainless-*`（`Package-Version: 6.25.0`、`Runtime-Version: v22.21.1` 等可 env 覆盖）；`X-Agent-Intent/Type/Runtime` 三件套；`X-Private-Data:"true"`；`X-Client-Version/Platform/Product`；`traceparent` + 单行 `b3`；`Accept` 收敛为 `application/json`。减：`X-Machine-ID`/`X-Session-ID` 默认不发（env 开关保留）、`Accept-Language`/`Origin`/`Referer` 不发。id 全改 uuidv7（conversation 带连字符、request/message 去连字符）；X-Request-ID 配对对象 cn 分支改 `X-Conversation-Request-ID`（真机 A/B 定）。
- **验证**：新增 `test/unit/workbuddy-chat-headers.test.js`——①正向：头值形状断言（uuidv7 版本位、三段 UA）；②**负向清单：出站头集 ⊆ 官方抓包头集**（照 Zhengyuuuui `TestIntlOfficialHeaderParity` 纪律，头一多就会静默偏离官方形状，这是防回退锚）。合入前置：照 11.4 先例做严格 A/B（原始头 vs 新头各打一次真实 chat），减头前后各一次对照 11128/11140 无新增。
- **红线**：分歧带（X-CodeBuddy-Request / X-Root-Request-ID）保持现状并在注释里记录两份证据的分歧，不猜。

#### P0-2 请求体补字段（直接吃前缀缓存的钱）

- **做法**：`buildChatBody` 补四个字段：`cache_retention:"long"`（显式传 short 才改）；`extra_vars.harnessMetadata`（JSON 字符串：`schemaVersion:1`、`harnessVersion:<cliVersion>`、`stepIndex`、续步带 `previous.conversationMessageId`、`agent.depth:0`——stepIndex 先做最简版）；`extra_vars.initiator:"user"`（末条消息 role==user 且未显式指定时）；带 effort 时补 `reasoning_summary:"auto"`。
- **验证**：`test/unit/workbuddy-body-fields.test.js`（显式值不覆盖、字段形状、幂等）；真机 A/B：同一段长 system 连发两次看 usage 缓存命中差值（anthropic 入口 2026-10-31 复核同款方法）。

#### P0-3 tool 配对出站修复（11148 预防）

- **做法**：`buildChatBody` 出站前加三步（全部只动历史不改内容）：相邻批合并、工具结果中间插入的 developer/system 消息挪到整组之后、孤儿调用整条删 + 同 call_id 重复结果只留第一条；**歧义历史回 422 `invalid_tool_history` + reason，不发上游**。只作用于协议翻译入口，不碰裸 chat。
- **验证**：抄 misakano `tool_pairing_hub26_test.go` 的七个子测试形状落 `test/unit/workbuddy-tool-pairing.test.js`；扩展 `verify-workbuddy-repair.js` 确认与「播报即收尾」门不冲突（先修再发，少一次上游重试）。

#### P0-4 DeepSeek 思考注入 + reasoning_content 回填 + 档位映射

- **做法**：①`buildChatBody`：客户端带了任一 effort 信号 → 注入 `thinking:{type:"enabled"}` + 档位归一（复用 TRAE `reasoning-apply.js` 的「客户端优先、只向下钳」与词表，`defaultEffort` 用 models.js 目录已有字段）；**thinking enabled 时每条 assistant 历史补 `reasoning_content:""`**（string 型）。②`withoutReasoningFields` 降为 fallback（11150 命中时剥掉重试，现状保留）。③模型目录声明「固定 effort 不可调」的模型不注档（防 11150）。
- **验证**：`test/unit/workbuddy-thinking.test.js`（裸请求不动 / 带 effort 注入 / 历史回填 / 固定档模型跳过 / 11150 回落）；真机验证：`deepseek-v4.1-flash` 带/不带 effort 各打一次，看 `reasoning_content` 是否出现。
- **红线**：档位映射只向下钳；不伪造签名类字段；策略层复用 reasoning-apply.js 不写第二份词表。

#### P0-5 业务码全表（bizcode）

- **做法**：`constants.js` `classifyStatus` 按 yreidev `bizcode.go` 全表补齐：`11115` → **不罚号不换号，错误原文返回客户端**（新增 kind，修复现行「超长上下文被换号惩罚」的误伤）；`14003` → 按模型冷却 ~30s 当场换号；`6001/6002/6005/6006` → 冷却到上游重置时刻（解析 details 文案）；`6000/6003/6007/6008` → 按模型冷却到重置时刻；`14001/14012/14013/14014/14018/14019` → 账号冷却到次日北京时间 04:00 + **余额刷新发现恢复就提前解冻**；`14015/14016/14017` → 软冷却；`10105` → 账号冷却 ~60s 换号（chat 路径补上，webagent 已有）；`11128` 文案分治（`Illegal API invocation...` = 内容渠道指纹 / 其余 = 渠道校验，都不罚号）；`11140` 文案分治（带 `request illegal` 才是账号级风控）；`11134`/`11150` 补记；`14022/14023` 顺手进额度族（一行正则，不依赖企业号）。
- **验证**：扩展 `verify-workbuddy.js` 分类矩阵；**判定顺序守 11.6 教训**——新分支先确认不被既有标记表吃掉（`credits exhausted` 文案族与 14001 族重叠，顺序要显式断言）。

#### P0-6 成长任务第一批：补领清扫 + 连登兑换 + 补签（真实动作流的低风险层）✅ 已落地（2026-11-28）

- **探针定案**（`test/probe-workbuddy-tasks.js` 账号 1，安全形状零副作用；全文落档 `docs/CHANNEL-WORKBUDDY.md` 11.5）：claim 必须走 **web 域**（CLI 域 reward/claim 400 复现 misakano「路径不存在」）、makeup 字段 **`target_date`** 定案（`date` 变体被拒）、redeem 409=月度业务态、accept 双前缀都通（参数校验先行，实现取 /v2）。
- **落地**：`src/workbuddy/tasks.js`（三动作 + parseTaskRow 双形状 + streak tiers[]/平铺键双形状 + `enterpriseBlocked` 企业号闸单一出处 + `runExclusive` 执行队列骨架）；autocheckin **第四腿**（`DUMATE_WORKBUDDY_TASKS_SWEEP` 默认关，ensureFresh 后执行，汇总进 `tasksAccepted/Claimed/Unverified/Redeemed/Failed`）；管理端 `POST /api/admin/workbuddy/tasks/{sweep,redeem,makeup}`（手动按钮，账号间并发 + 账号内 TryLock）。
- **验证**：`test/unit/workbuddy-tasks.test.js` 11 项 + `test/unit/workbuddy-autocheckin.test.js` 第四腿 3 项；真机单账号（1 号）`sweepDaily` 全程 no-op（任务全已领/无可兑档/无补签卡）＋ `scanGrowthTasks` 如实报 `empty`——空转验证过，无状态变更。

- **前置探针（不探不接）**：①**双前缀探针**——`/v2` 前缀在三个仓库间说法矛盾（88lin 在 copilot.tencent.com 全有 /v2；wbspy 在 www.workbuddy.cn 全无；L0NE-6 混合），本仓 11-08 实测 streak 加 /v2 会 404。纪律：对每个端点在目标账号的实际主机+头族下做双前缀探针，不改 growth.js 现有只读路径（它们现在是绿的）。②补签字段名 `date` vs `target_date` 两说，探针定。
- **做法**：新模块 `src/workbuddy/tasks.js`（与 activity.js 同构，打桩注入）三个动作：
  1. **补领清扫**：只 accept（报名幂等，复数数组形状）+ claim（body `{}`，只对 completed 且未 claimed 的行发）；claim 后**回读任务状态确认**，回执未确认进 `unverified` 本轮不再重复空 claim；`prerequisite not met` 先补跑前置再重试。挂 autocheckin 尾步或独立低频排程。
  2. **连登兑换**：tier 权威取 `GET .../streak` 的 `redemption_status.tiers[].tier`（**不认第三方清单**）；`POST .../redeem` body `{"tier","client_token":"u-<uuid4>"}` 防重放；403 天数不足是业务态，**先于 401/403 认证判断**（否则未解锁档位中止整轮）；实发字段带 `_granted` 后缀（`credit` 恒空，读它必漏计）。直接解决 11.8 记录的「redeemable 不领会过期」痛点。
  3. **断登补签**（手动按钮，每轮 ≤1 张）：候选 = 当月、今天前、≥max(launch_date, 2026-06-17)、score==0、不在 makeup_dates，最近断点优先；`400 date is not broken` 是正常竞争不报错。
- **验证**：`test/unit/workbuddy-tasks.test.js`（三态判定 / claim 回执幂等 / client_token / 403 业务态先判 / 补签候选）；真机先在单账号上手动触发一轮，核对端点与前缀探针结果。
- **红线**：行为链（聊天任务/专家/模板/旅行/盲盒/抽奖）**不进本批**——计数型任务上游校验真实会话 messageId，伪造不计数还增暴露面；抽奖含实物收件、盲盒覆盖旅行记录，均不可逆。第二批（任务中心三桶 + 行为链）见 P1-7，做之前按 misakano/hub 的判据在本机账号抓包核对形状。

### P1 — 稳定性与运维（默认关闭或只读）

#### P1-1 system 后置救前缀缓存（可选开关，默认关）✅ 已落地（离线部分）

- **做法**：`runtime.js` 加 `systemTail.enabled`（env `DUMATE_WORKBUDDY_SYSTEM_TAIL`，默认关；FIELDS/SUBFIELDS/sanitize/Load 四处齐全）。`buildChatBody` 在 sanitize 之后、配对修复之前：开头连续 system 块（headRun）整体挪到末尾（保序），头部换恒定桩 `SYSTEM_TAIL_STUB='你是助手。'`；只挪开头连续块；整条全是 system 不动；仅 cn 域。convId 取首条 user 不受影响。
- **验证**：`test/unit/workbuddy-system-tail.test.js` 7 项（默认关字节不动/挪尾+桩/中段不碰/global 不动/全 system 不动/桩恒定短/convId 稳定）。**真机缓存命中对照未跑**（要真流量；开关默认关，生产行为不变）——真机验证批次补。

#### P1-2 入站非 JSON 统一拒绝 ✅ 已落地

- **做法**：`src/inbound-json.js`（9080 与 9084 共用一份实现，防两份漂移）+ `parseJsonBody` 替换 **12 个**入口的裸 `JSON.parse`（四个协议入口 + count_tokens + 七个工具/媒体端点）。剥 BOM（U+FEFF）与首尾空白，400 各按协议形状 + 前 48 字符回显 + 解析原因；畸形体不打上游——省一次积分往返（misakano #295）。
- **验证**：`test/unit/inbound-json-guard.test.js` 9 项（模块级 BOM/截断/空体/二进制/文案；HTTP 级起临时 9080 打五个入口核对各协议 400 形状与回显；BOM 合法体不再被 400 拒；源码级接线锁定两个网关都不再裸 parse）。

#### P1-3 keepalive 窗口调大 + refresh 早死观测 + AT 倒计时 ✅ 已落地

- **依据**：misakano #296 实测上游**提前批量清 refresh session**（25/29 号 12 天内 refresh 死），窗口外的号到窗口期已死。我们 `DEFAULT_WARN_HOURS=24`，refresh 提前死亡无观测。
- **做法**：workbuddy adapter 改**每轮必刷**（warn_hours 是各通道共享配置，对 workbuddy 换票语义不适用；1h 最小间隔防手动连点；已判退场 skip 不白撞）。keepalive 路径补上**判废**（isRefreshRejected 同判据标 `refreshRetiredAt`——send 层的判废只在对话路径跑，账号不接流量永远标不上）。早死观测：AT 还剩 >7 天却换不动票 → `refresh_died_early` + error 文案带 AT 剩余天数。refresh 行带 `at_days_left`（AT 倒计时，1 位小数）。
- **验证**：`workbuddy-keepalive-adapter.test.js` 7 项全绿（每轮必刷+1h 间隔/判废落盘/早死文案/退场跳过/认不出措辞不误标）。踩坑：upsert 带 refreshToken 会清退场标记（既有规则），测试模拟「已退场」必须用 patch。
- **验证**：`test/unit/workbuddy-keepalive-adapter.test.js` 扩展。

#### P1-4 国内主备入口 failover（一期静态，HTTPDNS 二期）

- **做法**：新模块 `src/workbuddy/failover.js`（照 `throttle.js` 唯一解析点模式）。官方三入口：主 `www.workbuddy.cn`、前门 `copilot.tencent.com`、备 `wb.tencentbuddy.com`。一期：主入口基础设施类失败（408/502/503/传输错误/2xx 空响应体；**504 不算**）→ 换备用入口，每请求最多一次；入口级熔断照官方参数（60s 窗 ≥3 次 → 15s，再败 30/60/120 退避，一次成功清零）；静态备用 IP `162.14.3.241` 兜底；响应体 `retry_policy.retry=false` 两样都不做。二期再接腾讯 HTTPDNS（官方 token 是公开常量，`/d` 解析 + 钉 IP 时 URL/Host/SNI 仍按原域名只改 TCP 目的）。**仅国内版**。
- **验证**：单测（触发矩阵/熔断参数/504 边界）；真机拔主入口演练。

#### P1-5 WAF IP 级 fail-fast ✅ 已落地

- **做法**：`constants.looksLikeWafBody`（403 + 无 `"code"` 信封 + 空/HTML/网关指纹；有信封一律不算——业务 403 与 11140 不误吃）+ `classifyStatus` 的 `waf` kind（排在全部业务判定之后、429 之前——顺序纪律）。`index.js` 60s 滑窗（不持久化、不罚号、无面板配置——止损闸门不是调参对象）：循环内 catch 先 `noteWafHit(regionKey)`，≥2 个**不同**账号命中当场 throw 503；单号命中不罚号换下一个确认（检测本身需要第二个号撞一次）；入口与循环内按区域检查，region 空时另一区照常接。
- **验证**：`test/unit/workbuddy-waf.test.js` 10 项（信封判定矩阵/分类与处置/滑窗计数/单号不触发/同号重复不触发/窗口剪枝/区域独立）。

#### P1-6 官方逐请求用量账本

- **做法**：`src/workbuddy/usage.js` 新模块——并发拉全账号官方逐请求用量（带 Credit），分页终止判据「本页条数 < pageSize」为主（部分域 Total 恒 0）、第 2 页起失败记 error + `truncated`（防「统计了前半段」被静默少算）；聚合 totals/by_account/by_model/按日 series/errors；默认窗口 72h、上限 720h；**只读不写**。管理端积分明细页加「官方账本」区块，与网关侧账本并列呈现（R2 两本账模型：不是「一个总量的两部分」，覆盖条说清各自来源与覆盖范围）。reqlog 顺带补 `credit` 字段采集（上游响应带了就记，R2 口径：`credit==0` 是「该记录没带」=不知道，不是免费）。
- **验证**：`test/unit/workbuddy-usage.test.js`（分页终止/截断/errors 聚合/null 不补 0）。

#### P1-7 任务中心三桶扫描 + 执行回读（成长任务第二批的骨架）✅ 已落地（2026-11-28）

- **落地**：`growth.js` 加 `scanGrowthTasks`（只读）——三桶 `auto/locked_auto/manual`（claimed/过期/无奖励不进桶；mp 与 `Sequential_Tasks_*` 归 manual 只给指引，国际版 manual 带说明），不变量由单测从独立行数复核；`scan_state` 五态齐全，**401/空 body/HTML 一律 error 绝不渲染成「没有待办」**，`skipped_enterprise/skipped_disabled` 不打上游。执行队列骨架在 `tasks.js`：`runExclusive`（账号内 TryLock、重复点击 busy、异常放锁）+ `execBusyIds`；管理端 `/tasks/*` 改账号间并发 + 账号内互斥，新增 `GET /tasks/scan`（`execution_enabled` 与扫描解耦——扫描只读不读执行开关）。
- **验证**：`test/unit/workbuddy-growth-scan.test.js` 8 项（三桶+不变量/empty 与 error 分界/401 与 HTML→error/双 skip 零上游调用/global 指引/TryLock 拒与放锁/并发峰值 2）；真机账号 1 扫描 `scan_state:empty`、`invariant_ok:true`。行为链（第二批）挂这套骨架时只需提供动作函数 + 回读判定。

#### P1-8 会话粘滞键补强 + 单发请求分片亲和 ✅ 已落地

- **做法**：`channel-pool.js` 拆出 `sessionKeyPartsOf`（key + prevKey 双返回）：键含**首条 assistant**（截 2048，有才加分隔符——**第 1 轮键与 P2-11 旧口径逐字节一致**，旧绑定不受影响；P2-11 的 system 全文 + 首 user 2048 完全保留）；`sessionKeyFor` 做 prebind 迁移（旧键绑定迁给新键，幂等，显式 opts.sessionKey 不掺和）。**四个通道同时受益**（sessionKeyFor 是共享入口，会话模式同构）。workbuddy `index.js` 加单发分片：`DUMATE_WB_MSGSTAT_SHARDS=N` 选通（默认关）——非单发不分片；哈希输入 = (会话键, 模型, tools) + 日盐（UTC+8，额度按北京日重置）；先在分片集内选，集全忙/冷却退全量（可用性优先于亲和）。
- **验证**：`test/unit/sticky-key-assistant.test.js` 11 项 + `session-key-system.test.js` 9 项（旧不变量「追加轮次不换键」按 P1-8 修订：第 2 轮起恒定、1→2 分叉由 prebind 兜连续性）。全量回归绿。

### P2 — 能力扩展与呈现（按需逐个，每条自带验证）

| 项 | 来源 | 做法 | 落点 |
|---|---|---|---|
| 6020 官方排队协议 | yreidev `capqueue.go` | `6020 WAITING` 不罚号，查 `POST /v2/chat/queue/status` 按排位轮询（前 5 名 2s / 前 20 名 5s / 前 50 名 10s / 其余 15s，20 分钟封顶），到号后**同一份请求体 + 同组会话头**原样重发；6021/6022 直接 503/换号。**撞到真机 6020 再做**（yreidev 自己也没见过实际响应） | chat.js 失败分支 + index.js |
| agenttool 搜索/抓取 | hub + yreidev | ✅ **已落地（批次八）**：探针先行定形状（轻量头集三端点全 200；search 回 `{results:[{title,url,snippet,site,favicon}]×5, total_results, response_time_ms}`，webfetch 回 `{url,title,content(markdown)}`，http scheme 也认）。`search.js`：postTool 轻量头集（Bearer AT + CLI UA，**不带** X-Stainless/b3）+ 禁跟随重定向（3xx→502，防 Authorization 外泄）+ 信封错误解析（4xx 透传、5xx 收 502）；黑名单 `-site:` 拼进搜索词（真机验证上游认）。**只读纪律**：失败不喂池不改账号健康（与 dumate-web-api 同一套） | `src/workbuddy/search.js` + server.js `/v1/search/agenttool` `/v1/webfetch`；workbuddy-agenttool.test.js 17 项 |
| embeddings | hub + misakano | ✅ **已落地（批次八）**：探针定案 OpenAI 形状信封（1024 维 bge-m3）；坏模型上游报 **HTTP 500 `{code:11351}`**——按状态码透传会让客户端当上游抖动重试，必须拆 body 收成 400（错误码在 message 里也要兜一网）；11353→400 `input_too_large` 不换号；8MiB 本地预检 413 不发上游；**条数不符→502 宁可不返回**（按位置配对，缺一条就是静默错位）。**鉴权陷阱**：/v1/embeddings 的 body.model 是嵌入注册表名字，按它 resolve 会落 dumate 兜底→通道绑定 key 被 403——路径归通道分支必须**先于** body.model resolve；qwenwork 的 search 匹配同时收窄到 `search/(web|images)` 防 `/v1/search/agenttool` 被吞 | `src/workbuddy/embeddings.js` + server.js `/v1/embeddings` + 鉴权映射重排；workbuddy-agenttool.test.js（11351 双路径/413/条数不符/接线自证） |
| 音频 TTS+ASR | hub `wb_audio.py` | ✅ **已落地（批次九）**：探针先行闭环（TTS 2.92s 音频 → WAV → ASR 转写回原文，协议逐帧确认）。TTS `speech.audio.delta`(base64 PCM)→`speech.audio.done`+`[DONE]`，**无 done 帧不能当成功**（分块流偶发中途 close，半段音频回 200 = 残缺录音，panel issue #277）；ASR multipart 字段 `audio` 回 `{code?,msg?,text}`——**code 字段可能不存在**（探针实测 undefined），成功判据 `code==null||0`。头集 = chat 全套 + 现造 v7 会话 ID（**X-Conversation-ID 空串 → 400 11101 missing required header**，panel 注释原文「官方客户端 chat/speech 都带」）；baggage 与 x-device-token 探针实测**不需要**。`/v1/audio/speech` 双通道分派：hunyuan-tts/wb: 前缀 → workbuddy，tts-1 占位名仍归搭子（resolveTTSDispatch 单一来源，鉴权段与 handler 共用）；`/v1/audio/transcriptions` 是本项目**第一条 ASR**。15052→413、15053→400 fail-fast；3MB 入口预检（Buffer 读——readBody 的 utf8 字符串路径会打碎二进制）；换号上限 3、不喂池 | `src/workbuddy/audio.js` + server.js 两 handler + 鉴权分支；workbuddy-audio.test.js 19 项 |
| 免费模型豁免额度护栏 | hub v2.2.2 | ✅ **已落地（批次五）**：`models.isFreeModel(region, model)` 两层——**实测终审**（rate-ledger EMA=0 免费 / >0 不豁免，上游改口径当场暴露）→ 目录 free 字段；计划里的「内置快照」层刻意缺席（无证据不预编）。接线两处：send 的 lowIds 过滤跳过免费模型；pickCandidate 传 `paid: !freeModel`（pool 层 floorBlockedFor 天然跳过）。'auto' 永不豁免 | models.js + index.js send + workbuddy-free-exempt.test.js 4 项（含接线自证）；顺带修 rate-ledger recordRate 的 mkdir 缺口 |
| reset 文案解析冷却 | Zhengyuuuui | ✅ **已落地（批次四）**：三形状（措辞前缀 / UTC 后缀 / 裸墙钟兜底），小时位 `\d{1,2}`（上游写过 9:00:00 不补零），**无时区标记按北京时间墙钟**（旧实现按 UTC 会把重置时刻提早 8h、冷却缩水）；6004 解析不出默认 300s | constants.js `parseRateLimitReset` + index.js model_cap；error-surface 扩展 2 项 |
| b3 链路随会话延续 | Zhengyuuuui | ✅ **已落地（批次四，实现优于计划）**：TraceId 从首条 user 指纹**种子派生**（与 stableConversationId 同锚 + `|trace` 盐）——比 LRU 好：无状态、无淘汰失忆；span 每请求随机；postStream 接线（failover 两跳同 trace）；chatHeaders 第五参形状校验，脏值回落新 uuidv7 | chat.js `sessionTraceId`/`seedTraceHex`；chat-headers 扩展 3 项（含 postStream 跨跳接线） |
| 11151 空 text 段补位 | misakano + hub | ✅ **已落地（批次四）**：`guardEmptyTextParts`（empty_text_part.go 忠实移植）——数组形态克隆只补空段（`"   "` 放行不动、textarea 不动、对象形态不嗅探）；字符串形态**字节级**补位（扫描器定位 + 切片自证，大整数/转义/键序零改动，不做 JSON 往返）；漏网形状由 PARAM_ERROR_TEXT_RE 扩展（`a message has empty content` + `"code":11151(?!\d)`）走 400 快速失败不喂池不换号 | chat.js `buildChatBody` + constants.js；body-fields 扩展 3 项 + error-surface 1 项 |
| 指纹清洗三件加固 | misakano + hawklithm | ✅ **已落地（批次五）**：① TraeCode 句进 FEATURES+REWRITES（只删 in TraeCode 段，幂等）；② `scrubInjectedIdentity`（注入句正则 + `<model_identity>` 标签剥除），载体 = assistant 正文 + reasoning_content/reasoning，system/user 字节不动（scope 测试锁）；③ `sanitizeToolCalls` 改**字节级**（jsonscan 扫描器只重写变化的字符串值字面量）——比计划更进一步：JSON.parse 往返会丢大整数精度，参数里的 64 位 id 必须保真；非法 JSON 原文回落 | sanitize.js + 新 `jsonscan.js`（与 11151 补位共享扫描器，避免 chat↔sanitize 循环 require）；sanitize +5 项 |
| body 轮级字段 | misakano `conv_fields.go` | ✅ **已落地（批次十）**：postStream 级**头体同源**——一份 `convReqId`（uuidv7hex，failover 重发不换）同时进 `X-Conversation-Request-ID` 头与最后一条 user 的 `conversationRequestId` 体字段，外加 `startsNewUserRequest:true` / `agent:'cli'`；注入点在 thinking 之后（后续处理不触碰）。**不伪造边界**：只写当前轮最后一条 user，历史消息轮级 ID 无从得知不编造；assistant 的 messageId/usage/model 由真实调用产出不补；客户端已带的值原值优先（显式值是意图）；opts.convReqId 为空（独立调用方没走 postStream）整个跳过不写空值。**A/B 探针真机 PASS**（A 无注入 / B 注入均 200 正常出文，B 的体字段与头同值确认）——注入即默认开，无需开关 | chat.js `buildChatBody` opts.convReqId + `chatHeaders` 第六参；workbuddy-convfields.test.js 9 项 |
| Kimi $ref 展开 | misakano | ✅ **已落地（批次五）**：`sanitize.kimiInlineTools`（kimi_tools.go 忠实移植）——JSON Pointer 转义还原（~1/~0）、循环引用落空 schema、缺目标 `{type:'object'}`、$defs/$schema 剥除、depth 64 + budget 10000 双保护、预算耗尽整体回落原 tools、无改动返回原引用（零分配）；非 function 工具保形不裁剪。门控在 buildChatBody：cn + /^kimi/i（剥 `cn:` 前缀） | sanitize.js + chat.js；sanitize-tools +3 项 |
| 零输出守卫 | misakano | ✅ **已落地（批次六）**：200 + `finish_reason=length` + 正文/思考/工具全空 → 首帧否决窗口内换号重发（客户端无痕）；全池失败如实 `502 zero_output_length` + 可行动 hint，不罚账号。三处判定点：非流式聚合后 / 流式带门 `gate.result()`（缓冲门新增 `finishReason`/`reasoningSeen` 记账）/ 流式无门回调跟踪（finish/usage/[DONE] 尾部暂扣，裸关闭同判）。无痕口径 = 「无可见输出帧」而非字节级：role/空 delta 允许透传（四个翻译器对它们零可见事件，Anthropic message_start 在翻译器初始化即发、本来就无法避免） | index.js 三判定点 + errorActionOf `zeroOutput → {feed:none, rotate}` + repair.js 门记账；verify-workbuddy-zero-output.js 43 项（含接线自证）+ repair-gate +1 |
| 6004 窗口探针 | misakano `windowprobe.go` | ✅ **已落地（批次十）**：登记侧在 index.js model_cap 分支（带重置墙钟才登记，`data/workbuddy-model-windows.json` 原子落盘跨重启）；执行侧 `windowprobe.js`——到点发最小请求（`"Hi"` + `max_tokens:16` **必须 stream:true**，`X-Agent-Type: auxiliary`，走 chat.postStream 真实代码路径）钉住窗口计时起点（上游按**首次请求**起算，没人发请求额度空转）。四分支处置：opened→清 (账号,模型) 模型冷却+删记录 / 更晚 resetAt→换新墙钟计数归零 / 同时刻→15s 重试 20 次(≈5min)后放弃 / 其它错误→删记录不重试。**探针过同一套选号闸门**（退场/停用/区域不符→直接删记录不发），探针本身不喂池。巡检循环挂在网关进程（`startLoop`，30s 空转检查，`DUMATE_WORKBUDDY_WINDOW_PROBE=0` 关）；批量 8 个、间隔 400ms。管理端 `GET /windows`（窗口表+due 状态）与 `POST /windows/run`（立即探针，支持 account_id+model 点名，未到点窗口不提前探） | 新 `src/workbuddy/windowprobe.js` + index.js 登记钩子 + channel-pool `clearModelBlock` 透传 + server.js startLoop + admin 路由；workbuddy-windowprobe.test.js 15 项 + verify-workbuddy-window-api.js 7 项 |
| 国际版打卡模型回退链 | hub v2.1.1 | ✅ **已落地（批次十一）**：`dailyChatCandidates(region)` 三层——env `DUMATE_WORKBUDDY_DAILY_MODELS` 显式序列整体优先不重排 > 自动模式**免费优先**（实时目录 catalog free 字段，探针实证 hy4flash-free 被网页沙箱 `session/set_model` 接受且会话跑完 rate 0；flash 实时目录双区域 x0.11 付费）+ flash 收尾保连登 > 目录拉不到 [flash] 兜底。候选循环：轮数 = max(2, 候选数)（第二轮留给「会话只是慢」），额度/限流/模型类失败（14018/6004/6005/402/408/429/5xx/文案）换候选，**11140/401 立即停不换模型**（风控避让不变）。**set_model 失败判本轮失败**（hub 原口径「本轮仍跑」）——免费优先序列下 set_model 被拒意味着静默按付费 Auto 计费，比换候选更贵且更难看见，拒绝 prompt。单账号预算 600s（`DUMATE_WORKBUDDY_WEB_BUDGET_MS`，0 不限）+ 退避 5s×2^n 封顶 30s（只补 create/session 阶段，turn 已等满 waitMs）；结果带 attempts/models_tried。真机端到端：hy4flash-free 一次过（1 段输出 3.5s，零回退） | webagent.js `dailyChatCandidates`/`dailyActivityOnce`/候选循环 + runTurn setModelOk；workbuddy-webmodel.test.js 12 项；探针 test/probe-workbuddy-webmodel.js（set_model 失败即删会话不 prompt，零计费风险） |
| 模型规则页（按账号 deny/allow） | misakano `modelrules.go` | ✅ **已落地（批次十二后端 + 批次十三前端）**：`src/workbuddy/rules.js`——规则 = 命名模型组 + deny/allow 挂账号，多条 deny 并集、allow 并集、**deny 优先**；模型名带 `cn:`/`global:` 前缀（裸名两域命中，`global:x` 与裸名 `x` 是不同条目）；allow 在账号所属域零命中视作没挂（防跨域误挂封死）；`'auto'` 不做模型级判断。send 选号处 `filterAccounts` 过滤，部分被拦照常跑，**全被挡回 400 `model_not_allowed`**（不是 503——503 会被当上游抖动重试）。存储 `data/workbuddy-model-rules.json`（规则+挂载，原子写 mtime 热读，凭证文件不掺配置）。管理端 5 条路由（GET 列表/POST upsert/DELETE 摘引用/assign 整体替换/apply 单规则批量挂摘，审计 `workbuddy_rule_*`）。**前端（批次十三）**：`ModelRulesView.vue` + `#/model-rules`（adminOnly，WorkBuddy 通道专属菜单）——规则表 + 账号挂载表 + 编辑/挂载/批量应用三弹窗；真机截图验证（隔离数据目录 + 临时管理端） | 新 `src/workbuddy/rules.js` + index.js 选号过滤 + admin/routes/workbuddy.js 5 路由 + web ModelRulesView；workbuddy-modelrules.test.js 11 项 + verify-workbuddy-rules-api.js 9 项 |
| 备份分区表 | qoder-trae-workbuddy-switch | ✅ **已落地（批次十四后端 + 批次十五前端）**：`src/admin/routes/backup.js` 表驱动（SECTION_TABLE 一行=一个可备份类型，5 个账号分区 + model-map/livecfg/三通道运行期配置/model-rules/auto-checkin/task-scheduler + keys/admin-users 两个 sensitive），导出勾选与导入合并读**同一张表**；merge 纯内存与 write 落盘分开——`POST /preview` 零写盘（安全阀），`POST /import` 才落盘；`SectionCounts{added,overwritten,skipped,conflicts}` 逐分区回报（身份/键名清单以 conflictKeys 并列）；冲突策略 fail-closed 解析（未知拼写 400，绝不静默回落；`ask` 按保留本地）。**导出默认脱敏**：账号记录剥 token/cookie、分区标 redacted，导出正文搜不到凭据原文；sensitive 分区（keys 整文件明文 / admin-users 哈希）不勾含凭据直接 400，含凭据必须 confirm（双确认）。**刻意偏离参考实现两处**：①单网关不分产品×region 作用域，每通道一行；②**脱敏记录覆盖本地时保留本地凭据字段**（「备份没带」≠「账号没有」，导入脱敏备份不该把账号弄成不可用）。信封 `{format:'dumate2api-backup', version:1, sections:{id:{data,redacted}}}`；信封未知分区如实 ignored 不猜（前向兼容）。accounts 写走各通道 auth 模块 save（文件锁+权限收紧+缓存一致性），object 走原子写。**前端（批次十五）**：`BackupView.vue` + `#/backup`（adminOnly，**与通道无关**——覆盖全部通道，不走 menuKeys 白名单）——分区勾选表（现状/条目数/最后写入，缺失文件如实「尚未写入」）+ 导出确认弹窗（敏感分区红字警示 + 双确认）+ 导入卡（文件校验信封 → 冲突策略三选 → 预览结果表含 conflictKeys → 导入确认弹窗）；真机截图验证（隔离数据目录 + 临时管理端 9085，导出零凭据原文、预览零写盘、覆盖导入后本地凭据保留三项都过了实弹往返） | 新 `src/admin/routes/backup.js` + server.js 挂载 `/api/admin/backup` + web BackupView；backup-sections.test.js 9 项 + verify-backup-api.js 10 项（含预览零写盘证明与灾备还原往返） |
| 账号回收站 | qoder-trae-workbuddy-switch | ✅ **已落地（批次十六）**：`src/admin/trash.js` 五通道表驱动（SPECS 一通道一规格：回收站文件/lazy auth 模块/显示名提取）。**刻意偏离计划原案与参考实现**：①存储用**独立回收站文件**（`*-trash.json`）而不是「live 里加 trashedAt 标记」——pool 选号/keepalive/FEFO/积分视图都直接读 live accounts 列表，标记方案要求每个消费方都记得过滤，漏一处就是「已删账号继续接流量」的静默故障；搬走记录让消费方零改动。②保留期清扫跑**管理端进程**（boot 一轮 + 每小时 + 列表时顺带），不在网关 keepalive——删除/恢复/清空全部只发生在管理端，单进程写就单进程清。时间用毫秒数（仓库落盘时间戳统一形态），不是参考实现的 ISO。语义照搬参考实现：凭据随记录原样搬走（恢复无损）、**先写接收方后写来源方**（中途失败是两边都有不是数据丢失；软删除 live 侧失败回滚刚写的条目）、恢复 fail-closed（未知 key 拒、live 已有同 id 拒不覆盖、preferred 排他归一）、30 天 + 200 条先到先出、坏 expiresAt 当已过期/坏 deletedAt 排最旧、**回收站文件损坏时全部写路径拒绝**（宁可不写，不在损坏库上覆盖）。五处 `DELETE /accounts/:id` 全部改软删除（审计名不变），回收站四路由 `routesFor(channel)` 工厂各展开一行接入（放 routes 数组**最前**——字面 /trash 必须先于 /:id 参数路由被匹配）；purge/clear 服务端强制 confirm:true（双确认）。**前端**：`TrashDrawer.vue` 五通道共用壳（账号管理页右上入口，channel 是唯一取数维度；恢复后重挂子组件/重拉列表；corrupt 如实标红）+ 五处删除反馈文案改「已移入回收站（30 天内可恢复）」；真机截图验证（隔离 9085） | 新 `src/admin/trash.js` + 五 route 文件接线 + admin/server.js 挂清扫 + web TrashDrawer/trash.ts；trash-store.test.js 13 项 + verify-trash-api.js 7 项 |
| 存储管理 | workbuddy-shift | ✅ **已落地（批次十七）**：`src/admin/routes/storage.js`——data/ 四类视图（凭证/配置与运行态/流水与日志/缓存 + 未识别兜底），四条纪律照搬参考实现一条收窄：①**白名单根只有 DUMATE_ADMIN_DATA 且只收裸文件名**（路径分隔符/`..` 在参数形状上就被拒，路径穿越不成立）；②**先预览再确认**（`/cleanup/preview` 零写盘 → `/cleanup` 需 confirm:true，两步读同一份校验语义，拒绝项带原因如实回显）；③**60s 快照**切页不重扫（`?refresh=1` 强制重扫，清理后作废——页面紧接的重新扫描必须拿到新数字）；④**未识别文件一律保护**（本仓库收窄：分类表只登记认识的文件名，data/ 里出现不认识的 → other 类 protected——这里是「回收空间」的入口不是「删配置」的入口）。可删除的只有流水与日志（JSONL 埋点与 *.log，预览里如实标注「积分归因/余额曲线历史不可恢复」）与缓存（expiring-snapshot/caps/rate-cache/daypeak 均可再生）两类；checkin-ledger/qoder-grants/usage-agg/pool-state/审计这类「删了有行为后果或不可再生」的一律 config 保护。preview 响应不下发服务器本地路径（fullPath 只在服务端内部用）。**前端**：`StorageView.vue` + `#/storage`（adminOnly，与通道无关）——五类统计卡 + 分类过滤表 + 勾选 → 预览弹窗（将删清单+拒绝清单）→ 确认清理；真机截图验证（隔离 9085） | 新 `src/admin/routes/storage.js` + server.js 挂载 `/api/admin/storage` + web StorageView/storage.ts；storage-scan.test.js 7 项（分类/快照/白名单穿越/confirm 门/审计/URL 解析/接线自证） |
| 运行日志频道环 + ZIP 导出 | xu20060420 + misakano | ✅ **已落地（批次十八）**：①**三频道内存环**——`logbuffer.channelOf()` 按行首特征分 chat/task/sys（判据只有行首：`[chat]`/`[task]`/`[sys]` 显式标签直接命中——剥掉 server.js log() 的 ISO 时间戳前缀后匹配；`[keepalive]`/`[workbuddy-window]` 等已有巡检前缀归 task；其余一律 sys，不猜正文）。**每频道独立 500 行环**——task 结果不被 chat 流量冲掉；合并视图按 seq 归一排序，未知频道名返回空不回落。②**每日 JSONL 归档**——新 `src/admin/logarchive.js`：`data/logs/run-YYYY-MM-DD.jsonl` 按本地日切分，走 `jsonl.append` 单次 Buffer 写（自带跨进程锁）；同日重启追加同文件。30 天滚动清理挂在日期翻转上（每天第一条日志触发一次）。**只收脱敏后的行**：sink 挂在 logbuffer.push 之后，敏感行在 entry() 就被整行丢弃——第二份判据不引入（引入必漂移）。③**`GET /api/admin/logs/export?days=N` ZIP 导出**（1..30 越界 400）：零依赖手拼 ZIP（`zlib.deflateRawSync` + CRC32 表 + 本地头/中央目录/EOCD），压不动的内容退 stored；系统 `unzip -t` 交叉验证通过。sink 管道**不占 SSE 订阅者名额**（addSink 与 4 路订阅上限分开）。**前端**：ServerLogsView 频道选择器 + 频道列 + 分频道计数 + 导出天数/ZIP 按钮（ZIP 按天数取原始归档，不做频道二次过滤）。**三个如实的边界**：chat 频道今天为空（本仓库 console 无按请求日志，入口是显式 `[chat]` 标签，为将来预留）；只有管理端进程在写归档（网关未 install logbuffer）；存储页只列 data/ 顶层条目，run-*.jsonl 不单独出行（生命周期由 30 天清理 + ZIP 覆盖，目录行 note 如实说明）。**额外收获（实测抓到的真实缺口）**：`--reset-admin` 启动横幅打中文标签「密码:  <值>」，SECRET_PAIR 原来只认 ASCII 键名——整行漏进归档；已在判据补中文标签（密码/口令/密钥/秘钥/令牌/凭据，带显式分隔符才命中，「凭据不可用」这类正文词不误伤），复现验证带值行整行缺席、良性完成行保留 | `src/admin/logbuffer.js` 扩展 + 新 `src/admin/logarchive.js` + routes/logs.js `/export` + admin/server.js 挂 sink + storage.js 登记日志目录 + web ServerLogsView；logbuffer-channels.test.js 7 项 + logarchive.test.js 6 项 |
| 余额趋势视图 | misakano | ✅ **已落地（批次十九）**：纯前端批（数据层与 `/points/balance-*` 三端点早已有，零后端改动）。**`BalanceTrendView.vue` + `#/balance-trend`**（全局视图：账本覆盖网页账号与各通道池账号，不走 menuKeys 白名单、viewer 可看；菜单位于积分明细之后）：①**30 分钟独立采样折线**——事件驱动的原始流水只在变动时有点，直接画会断线；按固定网格 carry-forward（每桶取「≤桶末的最后一条观测」），每账号另拉一条「窗口开始前最新观测」做 carry-in 基线（取窗口前最新 2000 行前缀，更久未动的账号如实从窗口内首条观测起线）；②**20 万点自动折叠**——总采样点超上限倍增步长整体重建（所有账号共享同一网格），顶栏提示如实报当前步长；③**「下界估计」标注**——观测/估计分双系列：实线 = 桶内有新观测，同色虚线 = 估计（沿用上次观测，不进图例防双倍噪音），tooltip 标「估计 · 沿用 HH:mm」；信息卡写明方向：估计值是真实余额的**上界**（期间若有消耗只会更低），所以窗口消耗是**下界**（未观测时段不计入）。窗口消耗/获取/净变动/每小时按带符号 delta 汇总（口径同 `balance-hist.rate()`：delta=null 基线行跳过）——**前端就地算**（行已缓存，支持任意账号子集），不走只支持单账号或全部的 rate 端点。账号筛选只重画不重拉；web 裸数字键解析成网页账号昵称，`channel:id` 池键原样展示。真机验证：种子流水（1 高频账号 + 1 稀疏账号）→ 密集账号实线连续、稀疏账号长 gap 正确呈虚线、统计卡口径自洽（456.72 − 666.92 = −210.20；÷168h ≈ 3.97） | `web/BalanceTrendView.vue` + router `balance-trend` + MainLayout 菜单（LineChartOutlined）+ points.ts `balanceApi`；零后端改动，vue-tsc 构建过 + 隔离 9085 真机截图 |
| 上游劣化滑窗告警 | misakano `upstreamhealth.go` | ✅ **已落地（批次七）**：规则 `upstream_degraded`——5 分钟短窗（劣化是短时停摆，1h 窗被均值淹没）两维度任一越界聚合报**一条** warn：TTFB≥8s 占比≥30%、5xx 占比≥10%。三口径：TTFB 分母只数报首字的请求（与 usage 分桶同纪律）、样本 <3 不判、只观测不联动。思考重的智能体流量要调高 TTFB 阈值（首字含思考时间） | alerts.js + alerts-upstream.test.js 11 项 |
| 模型目录改版监控 | misakano `watchdog.go` | ✅ **已落地（批次七）**：`models.catalogWatch(region)`——sha256(parseCatalog 归一化行，固定键序哈希稳定)；复用 fetchModels 的 10 分钟缓存（零新增上游调用）；首次建档只存基线不告警，变了即报并更新基线（变回去也是改版）；**「拉不到」≠「改版了」**（失败不进 facts）。采集点 facts() 改 async（tick/evaluate 调用方同步改） | models.js + routes/alerts.js + 同上测试（含接线自证） |
| 用量 CSV / Top10 / 预热 | workbuddy-shift | ✅ **已落地（批次二十）**：①**用量聚合表 CSV 导出**——UsageView 页头「导出 CSV」下拉（按天聚合/按模型/按密钥三份），客户端生成：UTF-8 BOM + CRLF + 公式注入防护（与 monthly-billing.js 的 csvCell 同款：前导单引号 + 引号转义）；②**模型 Top 10**——横向条形图新卡（窗口内 Token 前十，回答「大头在哪」，按模型表仍是全量明细）；跟随页面 days/通道筛选，类目轴反转让最大者停在顶部；③**统计预热**——先摸清我们仓库的真实重活：`usage-agg` 已是增量分桶无需预热，`/overview` 真正慢的是**逐网页账号的上游积分往返**（usageRecords 一号一次）。新 `src/points-usage-cache.js`：计算逻辑只有一份（usage.js 的 pointsUsage/pointsTodayUsage 改为委托同一实现——第二份必然漂移），落盘 `data/points-usage-cache.json`（store.writeJSON 原子写，重启不冷启动）；**serve-then-warm**——/overview 命中新鲜缓存（窗口与今日两部分**独立**判新鲜，TTL 默认 30 分钟，env `DUMATE_POINTS_USAGE_CACHE_TTL_MS`）直接回并标 `points_cache{cached,cached_at}`，陈旧则现算 + 后台预热（先回账再暖，下次刷新即热）；**keepalive runOnce 空闲收尾**（阶段 4.7，fire-and-forget）每日预热 30 天窗口。**缓存数字必须带时间出仓**——前端在按账号积分消耗卡标「数字缓存于 HH:mm（后台自动预热）」，缓存与实时混着看不标时间就是编数据。真机验证：首载 cached:false（错误行如实显示）→ 次载 cached:true + cached_at；TTL 过窗按窗口参数独立判定（预热 7 天窗口后 30 天视图仍现算） | `src/points-usage-cache.js` 新 + usage.js 委托与缓存接线 + keepalive.js 阶段 4.7 + storage.js 登记缓存文件（cache 可清）+ UsageView（Top10 卡/CSV 下拉/缓存标注）+ api/usage.ts 类型；points-usage-cache.test.js 6 项（含接线自证） |
| 临期角标 | workbuddy-shift | ✅ **已落地（批次二十一）**：两个如实修正后落地——①**快照没有金额**（写入方刻意只记 nearest 时刻），「标注到期额度」在快照通道里改成「最早 MM-DD 到期 · 剩 N 天」，金额如实指回积分明细页（qoder 例外：它的临期在 grants 账本，credits 行新挂 expiringCount/Amount/Nearest/Estimated 四字段，**金额与时刻都有**，推算口径带 ≈、回落领取额时如实不带）；②**各通道窗口不同**（搭子/千问 30 天、TRAE/WorkBuddy 7 天）——照搬「7 天内」会把搭子做成恒空窗口，角标按各自 windowDays 出。**落地**：`expiring.js` 新 `view()`（与网关 `accountIds()` 同一套窗口/TTL/未过期判据，只把 Set 展开成明细——不得漂移；陈旧 fresh=false 条目照常返回由界面隐藏——过期数据比没有数据更害人）→ 只读端点 `GET /api/admin/expiring`（qoder 不在快照，前端走 credits 行）。**前端**：共享 `useExpiring()` composable + `ExpiringTag.vue`（红 ≤3 天 / 橙其余 + 紫「建议优先使用」= 全频道最早到期的那张卡；悬浮说明窗口与金额出处 + 「网关 FEFO 本来就优先用这些账号」）；五个账号卡视图接线——搭子/千问/TRAE 三视图角标 + **按紧迫度排序**（有临期的浮到列表前面，内部按 nearest 升序，其余保持原序不打乱既有约定）；WorkBuddy **已有**临期包金额（soonPackText）与「最快到期」排序（paging.ts expiring 模式），只补「建议优先使用」标记不重复造。真机验证：/expiring 四通道形状正确（7h 旧快照如实 fresh=false）+ 截图（红标+紫标+排序+无条目不显示） | `src/expiring.js` view + 新 `src/admin/routes/expiring.js` + server.js 挂载 + qoder.js credits 行字段 + web（api/expiring.ts、utils/expiringBadge.ts、components/ExpiringTag.vue、五视图接线）；expiring-view.test.js 3 项（判据与 accountIds 一致性自证 + 接线） |
| channels.js 能力声明建模 | dsh-unified-router | 每条通道加 `capabilities`（checkin/credits/growth/media/search…）与 `kind`；管理端 menuKeys、前端门控、路由白名单改读声明——**能力位是声明不是分支** | channels.js（单一来源四处 require 的自然延伸） |
| RT >10 天强制续期 | L0NE-6 | ✅ **经核对已被既有行为覆盖，不新做（批次七核对）**：keepalive workbuddy 腿自 P1-3（misakano #296）起**每轮必刷**（720h 窗口恒真，1h 最小间隔 + lastRefreshAt 落盘 + 退场跳过）——「>10 天强制刷」在它面前恒不触发，加判据只会是死代码。L0NE-6 关心的 30 天 RT 链断，真正防线是「keepalive 开着」（默认关是排程纪律的显式选择；开着则 RT 链永远 <1 天新鲜；关 10~30 天后重开，首轮必刷照样救回） | keepalive.js（已具备） |
| 国际版「网页会话才算当日活跃」对照 | L0NE-6 | 上游国际版当日活跃计数只认 `POST /console/as/conversations/`（ACP 打卡之外的正腿）；先验证现有 ACP 打卡 verified 的长期趋势，连登长期不涨再加这条 | webagent.js（真机对照后） |
| x-device-token 负知识 | Zhengyuuuui | ✅ **已落档（批次七）**：国际版官方客户端**不产 x-device-token**（三轮抓包+二进制验证）；国内版才有且一设备一账号。给国际版补这个头不是「更像官方」而是更像非官方——官方根本没有 | CHANNEL-WORKBUDDY.md 11.9（别再试清单） |
| 短信登录 | L0NE-6 | `POST /v2/plugin/login/send-sms` + `/token`（login_method:"phone"）→ AT+RT 直取。只留情报，本机 OAuth 够用，无浏览器环境的新入口时再接 | 情报记录 |

### P3 — 大件可选 / 观望

| 项 | 说明 |
|---|---|
| 长度截断无缝续写 | misakano `continue.go`（1107 行）：`deepseek-v4.1-flash` 单次输出硬上限 32000，`finish_reason=length` 且纯文本时同账号补发续写、帧接进同一条 SSE、usage 跨段合并；**工具参数截断（半截 JSON）不续**。对 Codex 写长文件场景价值明显，工程量中，单独排批 |
| Key 级三维限额 | hub：日 token 限量 / 累计积分额度 / Key 级并发上限（有界排队 `Condition` 唤醒不瞬时 429）。多人分发时触发（M3 同口径） |
| 随机排程窗口 | hub PR #32：签到/旅行在北京时间 08:00-10:00 抽取时段（只后延）；autocheckin 抖动窗口参数化，小改 |
| 出口 IP 画像 | hub `wb_ipintel.py`：经代理取出口 IP → ip-api 查 hosting 标志分住宅/机房，失败报 unknown；纯本地 lookup |
| 管理端 noindex | hub #842：`X-Robots-Tag: noindex,nofollow` + robots 元标签（管理端公网化前置项，P2-21 安全头批次没做这条） |
| restrictedUntil 持久化对照 | hub v2.1.0 的 11140 永久封禁我们不做（保留自动恢复），但「restrictedUntil 落盘、重启/刷新凭证不放回池、**只有真正成功一次才清**」值得对照我们的冷却持久化查漏 |
| TLS JA3 一次性核对 | 我们本身就是 Node（官方 chat 也走 Node 主进程），天然接近官方 ClientHello——不用移植 Go uTLS，做一次 MITM 抓本项目 JA3 与官方对比即可 |
| 订阅类型徽标 | 账号行展示档位（TRAE tier 已有数据），「无数据源的渠道不显示，不编造」 |

---

## 四、落地批次与验收

| 批次 | 内容 | 前置 / 验收 |
|---|---|---|
| **批次一：协议保真**（P0-1~P0-5）✅ **已落地（2026-11-28）** | 头对齐 + 负向清单、body 补字段、tool 配对修复、思考注入、bizcode 全表 | P0-1 动头前**严格 A/B**（11.4 先例）；P0-4 真机验证思考开关；P0-5 判定顺序单测防标记表互吃。全部带 `test/unit/workbuddy-*.test.js` + 真机 chat 回归（OpenAI/Anthropic 两入口流式+非流式） |

> **批次一落地记录（2026-11-28）**：
> - **A/B 前置**：`test/probe-workbuddy-ab.js` 三变体（现行 / 仅换头 / 头+body）各打一次真实 chat——三变体全 200，无 11128/11140；hy4flash-free 撞 6004（与形态无关，模型窗口限流）。
> - **P0-1**：`chat.js` 头集重写（39 头，官方对齐）——减 Accept-Language/Origin/Referer/X-Requested-With/X-Machine-ID/X-Session-ID/X-No-*（负向清单测试锁 ⊆ 官方抓包集），加 8×X-Stainless/X-Agent-Intent|Type|Runtime/X-Private-Data/X-Client-*/traceparent+单行 b3；UA 三段 `WorkBuddy/5.11.3 WorkBuddy/5.11.3 CLI/2.176.0`（intl token `workbuddy-ai`）；id 全升 uuidv7；**cn 的 X-Request-ID 改镜像 X-Conversation-Request-ID**（intl 镜像 Message-ID）；X-IDE-Name/Type 改 `WorkBuddy`（抓包值）；分歧带（X-Root-Request-ID/X-CodeBuddy-Request）保留。`DUMATE_WORKBUDDY_LEGACY_DEVICE_HEADERS=1` 可带回设备头。
> - **P0-2**：body 补 `cache_retention:"long"` / `extra_vars.harnessMetadata`（JSON 字符串，stepIndex 0）/ `extra_vars.initiator:"user"`（末条 user 时）/ `reasoning_summary:"auto"`——只补缺省，显式值不覆盖。
> - **P0-3**：`src/workbuddy/toolpairing.js`（misakano tool_pairing.go 忠实移植）：merge→repack→reorder→cleanup 四步，keepCalls 对称裁剪按构造保证配对完整 → **不设 422 分支**（修不动的歧义态不存在，与 hub 的 422 取舍不同）。注意移植底本边界：插入物在首个结果之前时不修（`len(results)==0 break`，misakano 生产行为）。
> - **P0-4**：`src/workbuddy/thinking.js`（misakano thinking.go 移植）：deepseek 前缀注入 `thinking:{type:"enabled"}`+默认档（面板 > 目录 defaultEffort > high），off/none/disabled→disabled，目录钳制只向下；`reasoning_content` 回填（rc 保留 / 镜像 reasoning / 皆无补**空格**——len>0 校验实测）；`wb_no_thinking:true` 单请求逃生口（11150 降级自动带）。真机证据：数学题注入后 reasoning_len=247；**平凡提问 reasoning_len=0 是 adaptive 跳过不是失效**。
> - **P0-5**：新增 kind：`context_overflow`(11115，不罚号原文返回)、`temp_rate`(14003，当场换号+重置墙钟/兜底 30s)、`session_limit`(10105，短冷却换号)、`channel_check`(11128)；14001/14012/14013/14014/14019/14022/14023 并入 hard_credit；14015/14016/14017 软冷却；600x 族并入 model_cap（600[0-8]）；**11140 文案分治**（request illegal 才是风控，码+文案双条件——纯码形态按状态码走）。
> - **验证**：npm test 1662/1662、verify 51/51 全绿；真码路径（chat.postStream 全链路）真机 200×4。新测试：chat-headers（12）/body-fields（7）/tool-pairing（20）/thinking（10）/error-kinds 扩展（+12）。旧 identity-headers 测试被 chat-headers 取代（deriveDeviceId 覆盖保留）。
> - **未做**：OpenAI/Anthropic 两入口的隔离实例回归（本轮改动不触及协议翻译层，已由真码路径探针覆盖）；面板 thinking 配置 UI（API 已就绪：PUT /restriction/config 支持 thinking 键）。
| **批次二：稳定性**（P1-2 / P1-3 / P1-5 / P1-8，P1-1 并入）✅ **已落地（2026-11-28）** | 入站校验、保活窗口、WAF fail-fast、粘滞键补强、system 后置（开关默认关） | 全部离线回归绿（npm test 1703 + verify 51）；**P1-1 的真机缓存命中对照未跑**（开关默认关，生产行为不变；待真机验证批次补） |
| **批次三：成长任务**（P0-6 → P1-7）✅ | 探针先行落档 11.5；补领清扫/连登兑换/补签 + 任务中心三桶扫描 + 执行队列骨架全落地；**行为链不进本批**（做前按 misakano/hub 判据抓包核对事件形状） | 单测 1725 全绿 + verify 51 项全绿；真机账号 1 空转 no-op 验证过 |
| **批次四：能力扩展**（P1-4 / P1-6 + P2 三件）✅ **已落地（2026-11-28）** | failover 一期（INFRA 3 态熔断 + 备用入口链 + 静态 IP 影子候选）、官方逐请求用量账本（/billing/meter + 管理端「官方账本」卡）、reset 解析放宽、11151 补位、b3 会话 trace | npm test 1751 全绿 + verify 51 项全绿 + vue-tsc 过；**后端改动待重启 9080/9081 生效** |
| **批次五：指纹加固与豁免**（P2 三件）✅ **已落地（2026-11-28）** | 指纹清洗三件加固（TraeCode / 滚雪球 scrub / 工具参数字节级清洗）、免费模型豁免护栏、Kimi $ref 内联展开 | npm test 1763 全绿 + verify 51 项全绿；**后端改动待重启 9080/9081 生效** |
| **批次六：零输出守卫**（P2 一件）✅ **已落地（2026-11-28）** | 零输出守卫（HeadVetoError 移植）：三处判定点 + 不罚账号换号 + 全池耗尽 502 hint | npm test 1764 全绿 + verify 52 项全绿；**后端改动待重启 9080/9081 生效** |
| **批次七：观测三件 + 负知识**（小件聚合）✅ **已落地（2026-11-28）** | 上游劣化滑窗告警、模型目录改版监控、RT>10 天续期（经核对已覆盖不新做）、x-device-token 负知识落档 | npm test 1775 全绿；**后端改动（alerts/models 路由）待重启 9081 生效** |
| **批次八：agenttool 搜索/抓取 + embeddings**（P2 两件）✅ **已落地（2026-11-28）** | 探针先行（三端点形状全定案）→ search.js/webfetch/embeddings 三条新网关端点 + 鉴权路径映射重排（workbuddy 分支先于 body.model） | npm test 1792 全绿 + verify 52 项全绿 + workbuddy-agenttool 17 项 + **隔离实例（9085）六项活体冒烟全过**；**9080 未重启，新端点待重启生效** |
| **批次九：音频 TTS+ASR**（P2 一件）✅ **已落地（2026-11-28）** | 探针先行闭环（TTS→WAV→ASR 转写回原文）→ speech.go 协议移植：SSE PCM 聚合 + done 帧闸 + multipart ASR + 3MB 入口预检 + 换号 3 不喂池；/v1/audio/speech 双通道分派 + /v1/audio/transcriptions（首条 ASR） | npm test 1811 全绿 + verify 52 项全绿 + workbuddy-audio 19 项 + **隔离实例冒烟六项全过**（TTS wav/pcm 200、mp3 400、ASR 闭环转写精确回原文、4MB 413、无 key 401）；**9080 未重启，新端点待重启生效** |

> **批次九落地记录（2026-11-28）**：
> - **探针先行的三步闭环**（`test/probe-workbuddy-audio.js`）：TTS 合成 2.92s 音频（140160 字节 PCM）→ 现场套 44 字节 WAV 头 → 喂回 ASR 转写回原文（「你好，这是workbuddy语音探针。」）。探针两次踩坑都成了实测证据：**漏 UA → 400 11101**（我们 chat 的 UA 在 postStream 单独补、chatHeaders 不含），**X-Conversation-ID 空串 → 400 11101**（panel injectConversationHeaders 空 meta 现造 v7 的注释明说「头族是渠道校验的一部分，官方客户端 chat/speech 都带」）。两条负证据同时落袋：baggage 不需要、x-device-token 不需要（都没发也 200）。
> - **协议移植的关键闸**：① TTS 无 `speech.audio.done` 帧不能当成功——上游分块流偶发中途 close，半段音频回 200 会让客户端拿到残缺录音（panel issue #277 实测 132480 vs 136320 字节识别成乱码）；`truncated` 错误可换号重试。② ASR 成功判据 `code==null||code===0`——**code 字段可能不存在**（探针实测响应体只有 text），Go 零值口径在 JSON 里同样成立。③ SSE 流内 error 帧必须认——不认它就会掉到 truncated，把上游原因咽掉。
> - **错误处置口径**：请求级（HTTP 4xx 信封、11101/15052/15053）fail-fast 不换号；上游侧（SSE error 帧、截断、空 PCM、5xx、未知业务码）换号重试上限 3；**不喂池**（与 agenttool 同口径——音频链路失败不改账号健康）。15052→413、15053→400（计划口径 + panel 2026-11-20 实测 3.1MB → 15052）。
> - **`/v1/audio/speech` 双通道分派**：搭子 TTS（media.js）与 WorkBuddy TTS 共用该路径。分派判据 `resolveTTSDispatch` 单一来源（audio.js 导出，鉴权段与 handler 共用）：hunyuan-tts*/wb:/wb/ 前缀 → workbuddy；tts-1 占位名/搭子模型/空 → 搭子；cn:/global: 前缀同时是区域覆写（panel audioRealm 口径）。鉴权段的旧路径表相应摘除 audio/speech（专属分支接管），audio/transcriptions 按路径归 workbuddy（multipart 的 model/realm 字段在鉴权段不可得）。
> - **二进制请求体必须 Buffer 读**：readBody 是 utf8 字符串路径——跨 chunk 的多字节序列会打碎音频字节（与流式 SSE 的 StringDecoder 同一条铁律）。新增 `readBodyBuffer`（语义复刻 body-limit：超限当场 null + 后台限时排空），ASR 的 3MB+64KiB 入口预检用它。零依赖 multipart 解析器（`parseMultipartAudio`）：boundary quoted/裸两形都认、file|audio 字段都认（OpenAI/官方工具）、文本字段（response_format/realm/model）一并取出、多文件部件取第一个。
> - **冒烟 502 假象的教训**：4MB ASR 用例首测得 502 空体——排查发现 curl 走了本机 `http_proxy=127.0.0.1:7897`，代理在「413 提前断连」场景下向上报 502。**`--noproxy '*'` 直连复测 413 正确**。冒烟脚本凡是「预期短响应 + 大上传」的用例都要绕代理，否则测的是代理不是网关。
> - **验证**：`node --test test/unit/workbuddy-audio.test.js` 19/19；`npm test` 1811/1811；`npm run verify` 52/52；隔离实例（9085）冒烟：TTS wav 200（RIFF 头核对）/ TTS pcm 200 / mp3 → 400 / ASR 闭环转写精确回原文 / 4MB → 413 audio_too_large / 无 key → 401。

> **批次八落地记录（2026-11-28）**：
> - **探针先行**（`test/probe-workbuddy-agenttool.js`）：三条端点轻量头集真机全 200，形状与本仓库现有约定对齐后落码——search 回显拼好的 query（`-site:` 上游认）、webfetch content 是 markdown 文本、embeddings 是标准 OpenAI 信封（usage.prompt_tokens=total_tokens）。
> - **11351 分诊是本批唯一的「非显然」错误处理**：上游对坏嵌入模型报 **HTTP 500**（不是 400），body 里才有 `{code:11351}`。按状态码透传 = 客户端拿 502 当上游抖动无限重试。收编路径两条都锁了测试：`e.upstreamCode`（postTool 解析的信封）与 message 里的五位数正则（上游 500 的信封走 envelopeError 后 code 仍在 message 里）。
> - **鉴权映射重排的因果**：`/v1/embeddings` 的 `body.model='bge-m3'` 若先走 `router.resolve(model)` 会落 dumate fallback → 通道绑定 key 触发 `channel_not_allowed` 403。workbuddy 工具端点的路径归通道分支放在 body.model resolve **之前**；同一提交把 qwenwork 的 search 匹配从宽收窄到 `search/(web|images)`，否则 `/v1/search/agenttool` 会被它先吞。接线自证用 indexOf 顺序锁（wbIdx < modelIdx）。
> - **postTool 复用而不进 provider**：三条端点不走 `handleDirectChannel`（无对话、无预算、无翻译层），独立轻量实现 + 只读纪律（失败不喂池不改账号健康）。账号选择 = opts.account 或区域第一个可用，`ensureFresh` 失败带旧 token 试（只读端点不值得为它走换票重试链）。
> - **测试基建的两个坑**：① stub `module.exports.postTool` 时，**恢复必须写在测试体内**——顶层代码在文件加载时执行，随后 webSearch 用例会把桩换回去（「Missing expected rejection」的根因）；② 接线自证 grep 正则字面量时，源码里 `/` 写作 `\/`，按转义后文本 `includes('search\\/(web|images)')` 比对。
> - **验证**：`node --test test/unit/workbuddy-agenttool.test.js` 17/17；`npm test` 1792/1792；`npm run verify` 52/52；隔离实例冒烟（`DUMATE_ADMIN_DATA=scratch + 账号文件拷贝 + DUMATE_POOL_STATE=scratch`，9085 端口，不动 9080）：search 200 真实结果 / webfetch 200 markdown / embeddings 200 OpenAI 形状 / 坏模型 400（分诊生效）/ 空 query 400 / 无 key 401。

> **批次七落地记录（2026-11-28）**：
> - **告警两条规则**（`src/admin/alerts.js`）：`upstream_degraded`（5 分钟窗 TTFB≥8s 占比≥30% 或 5xx≥10%，聚合一条不按通道拆）与 `catalog_changed`（目录指纹变化，按区域分对象）。`routes/alerts.js` 的 `facts()` 改 **async**（catalogWatch 要 await fetchModels）——tick 与 POST /evaluate 两个调用方同步改，schedule 定时器补 .catch。PUT /config 的未知键过滤读 `alerts.defaults()`，新阈值自动可配，前端不用改。
> - **目录指纹**（`src/workbuddy/models.js`）：哈希 parseCatalog 的归一化行（固定键序构造，同一份上游数据哈希稳定；fetchedAt 在包装层不进行内）；落盘 `data/workbuddy-catalog-fp.json`（DUMATE_ADMIN_DATA，原子写）；首次建档 first 只存基线。
> - **RT>10 天续期核对结论**：keepalive workbuddy 腿 P1-3 起每轮必刷，条件恒不触发——不新做，残值场景（keepalive 关若干天后重开）首轮必刷已覆盖。
> - **验证**：新增 `test/unit/alerts-upstream.test.js` 11 项（占比边界/样本下限/分母纪律/窗外数据/first 不报/失败不写指纹/接线自证）；`npm test` 1775/1775。

> **批次六落地记录（2026-11-28）**：
> - **判定点与窗口语义**：非流式在聚合完成后判（客户端什么都没收到，窗口天然完整，且放在修复判定之前——空正文对 `looksUnfinished` 是「收尾正常」，不先判守卫就原样回空回答）；流式带门在 `gate.result()` 判（finish/usage/[DONE] 全在门里，整批丢弃即可）；流式无门在回调里跟踪 + **尾部暂扣**（finish/usage 扣到 [DONE] 前，否决时整批丢弃；裸关闭——上游没发 [DONE]——同判，非否决轮裸关闭也要把暂扣帧补发，别让尾部帧凭空消失）。
> - **无痕口径是「无可见输出帧」而非字节级**：role/空 delta 帧照旧透传（panel sse.go 的 chunkKind 'pass' 同语义——下游翻译层要它们保持顺序），四个翻译器对它们零可见事件（Anthropic 的 `message_start` 在翻译器初始化就发、本来就无法避免；content_block_start 只在真实内容出现时发——逐行核对过 translateStreamToAnthropic 的空 delta 分支）。真正的可见帧（正文/思考/工具/finish/usage/[DONE]）被否决轮零下发，测试逐帧断言。
> - **`reasoningSeen` 是半空轮的闸**：思考帧是直发的，客户端已看见——reasoning 非空就不算零输出（计划原文「正文/思考/工具全空」三条件），如实交付不换号（换号会让思考内容出现两段）。
> - **处置**：`errorActionOf` 加 `zeroOutput → {feed:'none', action:'rotate'}`——不罚账号不写 lastError 不喂池（空输出与账号健康无关，喂池只会让健康号背锅）；`tried` 集合保证换号不重复，轮转天然以池大小封顶（「重发一次」按每次否决一轮计，全池都空才耗尽）。全池耗尽且死因是零输出时改写 message：次数 + 可行动 hint（稍后重试/换模型/看管理端通道页），statusCode 502 + code `zero_output_length` 由 `zeroOutputError` 带上。
> - **readStream 会吞回调异常**（`try { onData(JSON.parse(payload)) } catch` 包住了 onData 本身）——回调里只能置标记不能抛，判定点②用 `vetoHit` 标记在 readStream 返回后抛。
> - **验证**：repair-gate +1（finishReason/reasoningSeen 记账）；新增 `test/verify-workbuddy-zero-output.js` 43 项（换号无痕端到端 ×3 路径、裸关闭两向、四种不否决形状、耗尽 hint、池不罚、接线自证）；`npm test` 1764/1764、`npm run verify` 52/52。

> **批次五落地记录（2026-11-28）**：
> - **指纹清洗三件加固**：① TraeCode 自述句（hub 2026-11-24 CN 号池实测：上游按「interactive agent in TraeCode」连续短语判非官方渠道，只删 in TraeCode 段，单独 TraeCode / in Trae IDE / in Cursor 均 200）；② 注入身份滚雪球（panel issue #187——上游服务端注入「When asked about your model identity, identify yourself as …」经模型 reasoning 复述回流进出站；正则收紧到整句防误伤合法指令，句号后字符捕获组接回保引号/换行，`<model_identity>` 标签剥除；**作用域只洗 assistant 正文与 reasoning_content/reasoning**，system/user 同形句是用户人设字节不动）；③ 工具参数清洗改字节级：参考实现仍是整串文本替换，`{"code":11128}` 会被改成非法 JSON——用 jsonscan 扫描器只重写**变化的字符串值**的字面量，数字/键序/转义/大整数零改动，非法 JSON 原文回落（宁可漏一条指纹也不改坏客户端要执行的参数）。
> - **免费模型豁免**：`isFreeModel` 实测终审语义——账本有样本就按它（EMA=0 免费 / >0 不豁免），没有才看目录 free；「实测付费否决目录免费」比瀑布序安全（错豁免才真绕护栏，错不豁免只是等同今日行为）。'auto' 永不豁免。顺带修 `rate-ledger.recordRate` 的 mkdir 缺口（全新数据目录首次探针 ENOENT——锁文件先于 saveLedger 的 mkdir）。
> - **Kimi $ref 展开**：与 description 清洗分开；无 $ref 无 $defs 的 schema 原引用返回（普通请求零影响）。
> - **验证**：新增 jsonscan.js 共享模块（chat.js 11151 补位同步迁移，避免 sanitize↔chat 循环 require）；sanitize +5、sanitize-tools +3、free-exempt 4 项；`npm test` 1763/1763、`npm run verify` 51/51。

> **批次四落地记录（2026-11-28）**：
> - **P1-4 failover 一期**：`src/workbuddy/failover.js`——INFRA_STATUS={408,502,503}（504 明确排除：网关超时重放无意义且会拉长尾延迟）；60s 窗 ≥3 次熔断，退避 [15,30,60,120]s 指数翻倍封顶，成功全重置；cn 链 = [主 chatBase, www.workbuddy.cn, wb.tencentbuddy.com]，两备用**都开时**才插静态 IP `162.14.3.241` 影子候选（Host/SNI 仍原域名）；每请求最多一跳；body 带 `retry_policy.retry===false` 时不 failover 不记熔断（上游明说别重试）；global 单元素链（没有备用入口证据）。chat.js `postStream` 重写为链式尝试：infra 失败读兜 1MB 判 retry_policy → 记熔断 → 下一跳；传输错误同处置；两跳全败如实 status 0。`bufferStream` 用 PassThrough 包装，与 index.js readAll/readStream 消费端兼容。
> - **P1-6 官方用量账本**：端点取证自 xu20060420 `usage_official.go`（克隆核对）：`POST {chatBase}/billing/meter/get-user-request-usage`，body RFC3339(+08:00) + pageNum/pageSize；CN/global 同路径无 /v2。**分页终止判据「本页条数 < pageSize」为主**（部分域 Total 恒 0）；第 2 页起失败记 error + truncated（统计了前半段必须可见，绝不静默少算）。`src/workbuddy/usage.js`：rfc3339Cn（毫秒非零也不漏换）、parseUsageRow（**credit 显式 null ≠ 0**——`Number(null)===0` 会把「不知道」洗成「免费」）、单账号上限 10 页×100 条、并发拉全账号聚合（totals/by_account/by_model/按日 series）。R2 两本账：官方账本（含客户端直连）≠ 网关 reqlog（只覆盖经本网关），不是「一个总量的两部分」。reqlog 顺带记 `credit`/`credit_reported`（chat SSE 帧带了就记，不带不编）。管理端 `GET /api/admin/workbuddy/usage-official?hours=&region=`（企业号跳过）+ 前端积分明细页「官方账本（逐请求）」卡（72h/7d/30d 窗口、creditsUnknown 橙色注记、by_model Top8、近 7 日 series）。
> - **P2 reset 解析**：见 P2 表行注。
> - **P2 11151 补位**：见 P2 表行注。接线点在 convId/traceId 派生**之前**（锚取补位后的出站内容，幂等第二轮起稳定）。
> - **P2 b3 会话 trace**：见 P2 表行注。buildChatBody 返回 `{body, convId, traceId}`，postStream 传给 chatHeaders；activity.js 四参调用不受影响。
> - **验证**：新增/扩展测试 failover 11 项、usage 7 项、error-surface +2、body-fields +3、chat-headers +3（13/13）；`npm test` 1751/1751、`npm run verify` 51/51、`vue-tsc --noEmit` 过。
| **批次四：能力扩展**（P1-4 / P1-6 + P2 按需挑） | failover 一期、官方用量账本、agenttool 搜索、免费豁免、reset 解析等 | 每项独立开关默认关或只读；P1-6 与积分明细页合并验收 |

**全程红线**（沿用 + 本轮新增）：
1. 动出站头/体的改动一律先 A/B 对照，防「无害但不像官方」。
2. 写动作（成长中心）不探针不接、不幂等不接、不回读不记 done。
3. 指纹伪造族（`/v2/report` 事件链 / 自造 messageId）坚决不做——三仓实证上游校验真实会话。
4. 新错误码分支先确认不被既有文案标记表吃掉（11.6 教训）。
5. 管理端每个新视图遵守：查不到给 null 不编数、扫描失败不能渲染成「没有待办」、推算口径带 estimated 标记。

---

## 五、企业版内容（已排除）

以下依赖企业号（auth 带 `enterpriseId` 或账号类型 ultimate/exclusive）或会员档位，**不进融合清单**，仅记录出处备查：

1. **企业号判据与门控**（四源一致）：`enterpriseId` 非空即企业版 → 个人成长体系全拒（`/activity/growth/*` 403、daily-checkin 400 `code 10001`、`/v2/report` 200 但零收益）→ 上游实现都是「识别后跳过全部成长写腿只留 Token 续期」（L0NE-6：企业号误报成凭据失效曾是真 bug）。**这条判据本身例外收录**（P1-7 的 scan_state `skipped_enterprise` 依赖它），成本一行。
2. 企业身份头：`X-Enterprise-Id` + `X-Tenant-Id`（同值）、`X-Department-Info`（`departmentFullName` 原样，仅有部门全名时发）。
3. 企业模型目录：`GET /console/enterprises/{企业ID}/config/models`（每账号独立拉，5s 超时；`/console/enterprises/personal/models` 的 personal 路径双路探测）。
4. 企业计费：`POST /v2/billing/meter/get-enterprise-user-usage`。
5. 额度码 `14022`（部门额度）/`14023`（企业资源包）——**例外**：两个码顺手进 P0-5 额度族正则，不依赖企业号。
6. `X-Private-Data` 企业号恒 `"true"`（个人版才受 model_optimization 开关影响——我们按个人版固定 true 即可）。
7. **会员档位（非企业版，区分标注）**：Pro Only 模型 / `11158` entitlement（hub 口径：只在真撞 11158 时写表；池里无付费账号时 `/v1/models` 不列 PRO-only——我们的 models 目录如遇同样形状可借用口径）。
8. 企业号专属测试族（misakano enterprise_*_test.go）、TRAE 企业号用量探针（qoder-trae-workbuddy-switch）、豆包飞书企业号不参与（wbspy）、私有化部署形态（chatBase 非官方前门时 failover 整套不生效）。

---

## 六、明确不融合

| 项 | 理由 |
|---|---|
| 指纹伪造计数型任务（`/v2/report` 事件链、自造 messageId、小程序事件族） | 三实证：requestId 必须真实会话服务端 id（`cmb-` 形态）、夜猫子明文要求真实对话、链式任务单点伪造不推进；国际版 provider `growth:false`——写事件一个不接 |
| 抽奖 / Buddy 盲盒自动化 | 不可逆（抽奖含实物需人工收件；盲盒覆盖旅行记录）；两派保守口径都限每轮一次，说明作者自己不敢放开 |
| 移动端配对协议（wbspy mobile-pairing） | 纯设备伪装面（remote-view + Centrifuge WS），收益（手机操控）与网关定位不符 |
| TLS 字节级伪装（uTLS / HPACK without-indexing） | Node 侧做不到字节级；且我们本身就是 Node 天然接近官方——只做 P3 的 JA3 一次性核对 |
| 双域合池负载均衡（`cross_realm: merge`） | 与 11.5 的 11140 事故教训方向相反；`cn_first` 单向后备若做也只做单向，P3 |
| 11140 直接永久封禁（hub v2.1.0） | 比我们激进；保留自动恢复更符合单人多号（restrictedUntil 持久化进 P3 对照项） |
| SQLite 会话路由 / 消息压缩 optimize-context / DSML 解析 | 上轮已定案，本轮无新证据（misakano 的 DSML 孤儿 invoke 只计数不转——等真机日志见 invoke 残片再回来抄判据） |
| hawklithm 的 TRAE 全家桶（aha_* 设备注册） | 我们 TRAE 通道已成熟（remote/SOLO/账单/补签）；仅作对抗性参考 |
| sj13423888110 fork / zhiflo-bot/wb2api-search / 老快照 fork | 被 niyouqianma hub 与 misakano 分支全面超越；agenttool 搜索 hub 覆盖三协议更完整 |
| 新通道（MiniMax/豆包/CodeArts/Gemini） | 五通道之外无需求 |
| go:embed 单文件前端 / 手写 WebSocket·CDP / React 面板 / Docker/selfupdate/OpenWrt/Magisk/APK 等部署形态 | 我们有 Vue 工程与既有部署链路，形态不符 |
| upstash redis / Prometheus /metrics 重复建设 / MCP HTTP 端点 / 图片去水印 | 已有等价物（metrics 端点已存在、MCP 有 stdio 入口）；去水印无消费者 |
| 账号切换器本体（切换/会话副本/设置同步/CLI 自动轮换） | 我们是网关，FEFO/粘滞在流量层已覆盖同一目标；桌面客户端登录态写入不做 |
| 统一模型命名空间 `ns/model` 斜杠改名 | dm-auto-model 的斜杠教训已在案，不做跨通道改名 |

---

## 七、参考链接

| 仓库 | 星 | 活跃 | 本轮价值 |
|---|---|---|---|
| [misakano7545/workbuddy2api-panel](https://github.com/misakano7545/workbuddy2api-panel) | 1538 | 2026-11-27 | tool 修复/思考注入/system 后置/成长任务全链/模型规则页/窗口探针（本机在跑） |
| [niyouqianma/workbuddy2api-hub](https://github.com/niyouqianma/workbuddy2api-hub) | 480 | 2026-11-27 | 任务契约全集/音频/嵌入/agenttool/粘滞键补强/免费豁免 |
| [yreidev/workbuddy2api-panel](https://github.com/yreidev/workbuddy2api-panel) | 199 | 2026-11-27 | 官方协议对照手册（头/body/bizcode/failover/HTTPDNS/排队协议） |
| [xu20060420fan-cell/workbuddy2api-trae-qoder-minimax-panel](https://github.com/xu20060420fan-cell/workbuddy2api-trae-qoder-minimax-panel) | 140 | 2026-11-27 | 官方用量账本/任务动作表/任务中心三桶/日志频道环 |
| [hawklithm/workbuddy2api](https://github.com/hawklithm/workbuddy2api) | 39 | 2026-11-24 | 11148 修复纪律（422 不静默截断）/指纹清洗 JSON 值级/reasoning 差分 |
| [Zhengyuuuui/workbuddy2api](https://github.com/Zhengyuuuui/workbuddy2api) | 30 | 2026-11-26 | 国际版 41 头抓包全集/x-device-token 负知识/reset 文案解析/负向清单测试 |
| [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin) | 2728 | 2026-11-25 | 写动作端点形状全集（补签/兑换/抽奖/盲盒/旅行）+ 幂等纪律 |
| [L0NE-6/WorkBuddy-Daily](https://github.com/L0NE-6/WorkBuddy-Daily) | 743 | 2026-11-27 | 风控红线证据/任务三源回读/国际版活跃正腿/Token 永续触发条件 |
| [yingfing/workbuddy-switch-python](https://github.com/yingfing/workbuddy-switch-python) | — | 2026-11-16 | 前缀矛盾样本/托管编排顺序/补签字段冲突样本 |
| [NextAgentX/qoder-trae-workbuddy-switch](https://github.com/NextAgentX/qoder-trae-workbuddy-switch) | 465 | 2026-11-27 | 两本账模型/Token 统计口径/备份分区表/回收站/待办聚合 |
| [magicapple123/workbuddy-shift](https://github.com/magicapple123/workbuddy-shift) | 48 | 2026-11-27 | 统计视图组/临期角标/存储管理纪律 |
| [KouzakiUmi/dsh-unified-router](https://github.com/KouzakiUmi/dsh-unified-router) | — | 2026-11-26 | 通道 capabilities 声明建模/选号策略面板化 |
