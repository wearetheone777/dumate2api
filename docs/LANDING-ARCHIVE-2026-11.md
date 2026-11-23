# 2026-11 落地批次全文归档（原 CLAUDE.md「落地批次」章节逐字移入）

> 按日落地的**完整批次记录**（每项的实测依据、验证命令、离线/真机结果、踩坑细节）已整体
> 从 CLAUDE.md 移入本文件（2026-11-23 归档，正文逐字未改）。CLAUDE.md 只留一份**批次索引表**
> （每批一行的钩子），查细节以本文件为准。
> **排查某项行为「为什么是这样」时，先到本文件找对应批次**——那里的「纪律 / 别再试」
> 都是实测换来的，不要凭直觉改回去。

## 2026-11-05 落地（GitHub 融合批次）

> 参照仓库快照在 `%TEMP%\fusion-refs\`（workbuddy2api-hub / Trae2api-cn 浅克隆）；hub 三天三个 release（v1.7.20-22）的功能形态直接融合进网关。

**Qoder 节奏闸门（channel-pool，默认全关）**：`DUMATE_QODER_INFLIGHT_MAX`（通道级在途帽，覆盖池默认 4，`pool.acquire` 支持按次覆盖）与 `DUMATE_QODER_MIN_INTERVAL_MS`（账号最小请求间隔，判据是**上次 pick 时刻**——约束发射节奏不是请求时长；间隔内跳过与 busy 同语义不惩罚）。先埋点看 10605 率再定阈值，不配 env 行为与之前逐字节一致。**2026-11-16 起两者都能在管理端「通道风控」页热改**（`src/throttle.js` 统一解析：面板 > env > 默认）。

**探针无副作用（hub v1.7.20 #134 教训）**：五通道 `billing-check` 全部带 `opts.probe`——失败跳过池惩罚（noteError/markFailure/lastError），错误照常上抛。`test/unit/probe-no-punish.test.js` 锁住「默认路径仍喂池（回归锚）+ probe 不喂」两态。

**工具调用回显（tool echo，hub #135）**：上游把工具调用当**纯 JSON 载荷**吐进正文（Qwen3.8-Flash 实测），客户端静默结束。`repair.js` 新增 `parseToolEchoPayload`（强判据：纯载荷 + 工具名名单锚，与 DSML 的 XML 形状互补）+ gate `echoFixup` + 聚合出口 `aggregateToolEchoFallback`，三通道接线。`DUMATE_TOOL_ECHO_MODE` off（默认，本地无真实样本不改现状）/lenient（还原成 tool_calls）/strict（fail-closed 502）。

**积分三段拆分 + 全价请求（hub v1.7.21/22）**：`reqlog.pickUsage` 提取缓存命中并带 `cached_reported`（区分「确认零命中」与「上游没回报」——全价统计只认前者）；新 `src/credit-split.js`（Qoder 专属三段折算，系数 1.069/0.086/4.277 每千 token，`DUMATE_QODER_CREDIT_COEF` 可覆盖，缓存未回报时缓存段/合计为 null 不编）；usage-agg 桶加 `ci/cc/c0/c0p` 四字段，`snapshot.full_price` 报「prompt≥阈值且确认零缓存且成功」的次数/tokens/占比（`DUMATE_FULL_PRICE_PROMPT_MIN` 默认 100K；积分占比不做——各通道口径不同不编数）。前端：用量页「全价请求洞察」卡、请求详情页 Qoder 三段拆分行。

**千问 ACP 会话通道（P2-17 最小闭环）**：`src/qwenwork/{wsframe,wsclient,acp}.js`——REST `POST /api/chat-sessions` 建会话 + WS `wss://qwenwork.cn/api/chat-ws`（**裸域不是 gateway**）带信封 JSON-RPC（`{"type":"control"|"data","payload":{…}}`，裸 RPC 回 -32700）；结束判据「见过 running 或正文增量之后的 idle」；单条消息 32768 字节硬上限（压缩救不了，`promptOf` 裁剪：保 system+最新、丢最老、留标记）；模型档位由账号/套餐决定（`qwen-acp/auto` 只是标签）——**2026-11-06 三重实测定案**：`session/set_model` RPC 不存在（-32700 Unknown control method）、createSession body 的 model/modelId/model_key 全被忽略（`extra_data.mode` 恒为账号侧档位，账号 3=flash）、`extra_data.mode` 可作会话真实档位观测字段；每请求新会话（复用=上游 agent 会话重跑整段上下文，重复计费），**同账号并发建会话 409 CONCURRENT_OPERATION**（间隔 ≥4s）。附件链路（barn→ACP file_uuid 引用）**阻塞**：发送侧 file_uuid 来源无证据（barn 完成体只有 storage_path；path 直引 404；解包源随客户端卸载消失），等抓包。`qwen-acp/` 前缀独立 provider（qianfan-raw 同款），不进 chat 桥。协议证据：tang-bugu/dsh-connect-qwenwork 实测 README + 本项目探测（假 token 握手回 401 JWT verification fails，端点与鉴权形态独立印证）。真实回合待真机账号。

**TRAE remote manual 策略（P2-13.1 修正定案）**：参照 Trae2api-cn 源码证实 remote 协议**没有 tools 槽**（"tools remain owned by the API caller"）——「带 tools 走 remote」不成立，带工具请求仍走 utils_chat。落地的是**显式模型名**：`DUMATE_TRAEWORK_REMOTE=2` 时显式模型经 manual 策略走 remote（`remote.manualFieldsOf`：bound 校验拒绝静默落默认档，五件套 model_name/config_source/is_preset/provider/custom_model 原始对象，`models.normalize` 新增 `customModel` 原始行）；`=1` 仍是 auto 档纯文本（真机已验证的行为不变）。

**WorkBuddy 每日活跃双通道**：国内版 `src/workbuddy/activity.js`——`/v2/report` 一条 `chat_request_send` 事件点亮 growth 连登（**必须带 userId** 否则 200 但静默丢弃；当日幂等，账号档案 `lastActivityReport`；keepalive 签到后顺带）。国际版 `src/workbuddy/webagent.js`——网页 agent 会话打卡（ACP over streamable HTTP：建会话→取沙箱 link/token→SSE 通道 Acp-Connection-Id→initialize→session/load→**session/set_model**（不设会按网页默认 Auto 付费档计费）→session/prompt→轮询 completed；活跃会话上限 10（429/10105），成功 stop 保留、失败 delete 清理；当日幂等 `lastWebActivity`）。keepalive 的 global 分支由「不支持签到」改为网页打卡。

**前端构建**：`cd web && npm run build` 通过（vue-tsc 0 错误）。全量回归 `npm run verify` 40 项通过。

**2026-11-05 凌晨真机批次**：千问 ACP 真机回合跑通（P2-17 闭环），帧形状按 40 帧采样修正（sessionStatus 在 params、update 事件名在 sessionUpdate 键、文本在 update.content.text、沙箱生命周期帧 ignore）；TRAE `REMOTE=2` 显式模型真机跑通（glm-5.2 manual 钉模）；WorkBuddy 网页 agent 打卡 cn 区真机跑通（178 段输出 6.4s）。千问 billing-check 仍受阻：账号 2 refresh token 失效需重登、账号 3 chat 桥 403「Model is not available for this user」（账号级）——**但账号 3 的 ACP 会话是通的，ACP 与 chat 桥可用性分离，`qwen-acp/auto` 可作千问对话备用链路**。

## 2026-11-06 落地（WorkBuddy 融合批次：hub v1.7.22 → v1.10.11 差集的 P0/P1）

> 参照仓库快照刷新在 `%TEMP%\fusion-refs\wb-hub-latest\`（v1.10.11 浅克隆）；旧快照 `wb\`（v1.7.22）保留。hub 10-23 起挂维护状态：上游对非官方客户端识别持续收紧，本批 P0 是保命项不是优化项。

**11-128 渠道指纹清洗（`src/workbuddy/sanitize.js`，最高优先）**。上游按 system/assistant 里的**连续文本指纹**判非官方客户端回 400/11128，而本项目整个跑在 DSH 生态里——Codex/CC 的 system prompt 必带这些串，原样转发是必撞。全套规则与措辞照 hub v1.10.11 的 wb_proxy.py 移植（指纹边界都是社区 A/B 实测定死的，不猜）：身份句族（7 种动词、名词可省、0~3 修饰词，整句中性化）；DSH GUI 段（只调 A 句尾语序）；DSH 文件引用段（A 句补一个 `that` 打断整段连续匹配）；`DeepSeek Harness` 品牌词缩成 `DeepSeek`（连字符/下划线路径不动）；Codex/Claude Code 自述首段整句换掉（hub 教训：改写式清洗曾把指纹注入出站 body）；billing 头与 `cc_*` kv 清洗。**角色作用域**：identity 只对 system/developer/assistant（assistant 历史同样命中，#574）；user/tool 是用户数据不改写。`chat.js` 的 `buildChatBody` 在首条 system 注入后清洗——清洗不改 user 内容，convId/前缀缓存键稳定。tool arguments 非字符串强制 JSON 序列化（Go struct 11101）。`DUMATE_WORKBUDDY_PRESERVE_CONTRACT=1` 跳过 tool 内容改写（默认关）。离线验证 `node --test test/unit/workbuddy-sanitize.test.js`（13 项，对照 hub `_test_sanitize_fingerprint.py` 收敛 + 出站链路接线断言）。

**风控连坐保护（hub #422 社区复盘代码化，行为级变更）**。**11140 不再默认换号**——原来「受限换号区内轮完一圈」正是 hub 实测把 7 个号在一次任务里全送走的路径：设备/出口指纹被扫到时换号等于把同一指纹挨个报给风控。处置：`noteAccountRestriction` 记窗口内受限账号（默认 900s 窗、2 个不同账号即触发），触发后**整区域暂停 1800s** 快速失败 503；换号数默认 0（`DUMATE_WORKBUDDY_RESTRICTED_ROTATE_MAX` 可调）。暂停是进程内紧急状态不落盘。**新增分类 `model_cap`（6004，hub v1.9.0 #668）**：上游 429 + body code 6004 是 (账号, 模型) 级窗口额度用满，唯一带重置墙钟——`parseRateLimitReset` 认 cn/intl 两种文案（含 `\u` 转义形态，按 UTC 解析再减偏移，不能用 `Date.parse` 裸解析否则宿主机时区带偏几小时），喂池走 `scope:'model'`（复用 Qoder 的 `applyModelSoftCooldown` 机制，`model_cooldowns` 持久化进 pool-state.json），**换号继续打同模型**，绝不按账号级 429 封整号。**401 先刷新再换号（hub #441）**：裸 401 归 `session_dead`（原来落 `client` 没有刷新入口），`errorActionOf` 给 refresh → `authStore.exchange` 成功同账号重试（不喂池——刷新成功=账号健康，喂池会把 token 过期记成 session_dead 计数）、失败才判死喂池换号。挑战头 `WWW-Authenticate: ... error="invalid_token"` 拼进分类输入（hub #686，APISIX 的 401 死因只在头里）。**参数错误不喂池（hub v1.10.11 #794）**：400 + param-invalid 文案 `paramError`，如实 400 不惩罚账号。**max_tokens 按模型目录上限 clamp**（`models.maxOutputOf`，未预热/不在表=0 不 clamp）+ 字符串 `stop` 归一化数组。**`readStream` 的 `[DONE]` 即终态**（hub v1.9.1 的默认开版本）：上游 [DONE] 后保持连接不关，原实现聚合路径一直白等——见哨兵即 destroy + resolve，`DUMATE_WORKBUDDY_STOP_AT_DONE=0` 可关。离线验证 `node --test test/unit/workbuddy-error-surface.test.js`（9 项：6004/401/连坐/errorActionOf/parseRateLimitReset/clamp/停读）；`verify-workbuddy.js`（9 项）与 workbuddy 全部单测（32 项）回归通过。

**账本原子追加排查（hub wb_usage_io 教训，结论：无需改）**：本项目六处 jsonl 写入（jsonl/records/reqlog/task-runner/checkin-ledger/qoder-grants）全部是**单次 `fs.appendFileSync`**——一次调用=一次 O_APPEND 写（NTFS FILE_APPEND_DATA 与 POSIX 均内核级原子），hub 丢行 7.3% 是 Python 文本模式缓冲切分特有形态，本项目无此问题。

**融合遗留（清单见会话，按性价比排序）**：小账号池固定选号（hub #718，防前缀缓存丢失与 token 翻倍）；账号档位权威来源 `get-user-resource-summary`（v1.7.27 #505，国内版零新增请求）；生图/生视频媒体路由（v1.10.6 `wb_media*.py`，COS 预签名上传参考素材 + 按（模型,分辨率,是否带参考素材）分档计价）；CodeArts 第三 realm（v1.10.x，大工程按需）；跨出口回退（v1.7.25 #564，默认关）；growth 任务扩充与网页活跃随机提示词池。**P0-2 出站身份头族对齐（wb_fingerprint 5.8.4 抓包）未做**——现有头族过协议校验（真机 chat 通），等 11-128 复现再对齐头族，避免无抓包依据的盲改。

**网页打卡的 11140 避让与证书降级（webagent.js，hub v1.9.0 / v1.8.0）**：打卡撞 11140 把账号档案记 `webBlockedUntil`（**次日 00:10** 自动恢复——过 0 点边缘，连登按新的一天计），避让期内打卡按 `{ok:true, skipped:true, phase:'restricted'}` 跳过（keepalive 映射成 already，不算失败）；`DUMATE_WORKBUDDY_WEB_CERT_FALLBACK=1`（默认关，与 hub 面板开关同口径）开启后，证书类失败（EdgeOne 给 ACP 沙箱域下发 `*.cdn.myqcloud.com` 通配证书，TLS 层必然拒绝，判据 `altname|certificate|ssl|unable to verify`）降级走 activity 的主域 `POST /v2/report`——打卡目标（点亮连登）不变、路径降级，成功记 `lastWebActivity` 防两路径同日重复。webagent 测试桩新增 error 事件通道（证书/连接类错误在 end 时触发）。

## 2026-11-06 第二批（会话暖账号列表 + 账号档位）

**sticky 单值绑定升级为暖账号列表（`src/sticky.js` + `channel-pool.pickCandidate`，hub #718 的 SessionAffinity）**。原实现 front 唯一：绑定账号冷却/在途满就 unbind + 池轮询随机换号——长会话每轮丢上游前缀缓存重算 prefill，Token 消耗翻倍。现在每会话记 front + 最多 2 个 fallback（`recent(sessionKey)` 按最近使用排序）：front 不可用时**先试会话的其他暖账号**（它们可能还持有上游前缀缓存），全不可用才池轮询，选中的 promote 到 front、原 front 自动降为 fallback（真实换号也保留暖副本）。两处旧 `unbind` 移除（全清暖列表=丢所有暖副本）；只有绑定账号被区域/调用方显式排除才全清。`bind/lookup` API 向后兼容（lookup 仍返回 front 单值），四通道共用一份。hub #718 的「页大小覆盖全池」分支本地无对应物（我们无分页轮转），等价价值就在暖列表。测试 `test/unit/sticky-warm.test.js`（3 项：promote 语义/TTL/池层暖 fallback 接力）。

**账号档位权威来源（`billing.js`，hub v1.7.27 #505）**：`POST {billingBase}/v2/billing/meter/get-user-resource-summary`（body `{}`，**`X-Client-Platform: web`**）的 `IsPaidUser`/`SubscriptionPackageName`/`IsProtectedPriceUser`/`ProTrialStatus` → `parseTierSummary` 纯函数。三条硬口径照抄 hub：**响应没有 `IsPaidUser` 字段 = 没有答案返回 null**（绝不写成「免费」；`IsPaidUser:false` 是「确认免费」，两者不同）；401/非 0 code/网络错误/impl 抛异常 → null，旧值与时间戳原样保留；**企业账号（enterpriseId）跳过**——上游对它们的 IsPaidUser 语义未验证。TTL 24h（`tierIsFresh`），接线在管理端 `/workbuddy/credits`（每账号顺带刷新，不新开定时器），`auth.list()` 带 tier 展示，`_setFetchTier` 注入点可测。注意我们与 hub 的路径差异：hub 的 CN 详细积分路径本来就在打这个端点可复用响应，我们的 `fetchCredits` 走 `get-user-resource`——所以两区都是每账号每天一次摘要请求，成本可接受。测试并入 `workbuddy-billing.test.js`（+5 项）。

**网页打卡随机提示词池（webagent.js，hub wb_webprompts）**：固定 "Hi" 本身是指纹（每天同一账号同一句的会话序列太好认）。`DUMATE_WORKBUDDY_WEB_PROMPTS`（逗号/分号/换行分隔）优先，没配用内置等价问候池；`opts.prompt` 显式指定仍最高优先。活跃计数只看会话跑完不看提示词内容（hub 实测口径）。

**回归基线（第二批后）**：workbuddy 全家桶 50 项 + 池回归 21 项全绿。`npm run verify` 37/40 的 3 个失败单跑全部通过（`verify-qoder-encode-perf` 是性能阈值测试在全量并发负载下超阈、`verify-channel` 环境串扰、单测组同因），与第一批同模式：全量跑的失败要单跑复核，单跑绿就不是回归。

**回归基线（2026-11-06）**：`npm run verify` 37/40——3 个失败均来自工作区**既有未提交改动**、与本批正交：`verify-traework-toolshape.js` 崩在 `traework/chat.js` 的 `meta.sessionId`（meta 未传时 TypeError，用户在改 TRAE 账单键）；搭子 5 个单测断言不同步（mapModel/dumateRows，用户在改 model-info/upstream-router）；`verify-channel.js` 单跑通过（run-all 串扰）。WorkBuddy 全部测试绿。

**融合落地（2026-11-07，docs/DUMATE-GATEWAY-MERGE-FEATURES.md 第一批）**：三件 + P1-4。① **`dumate-points` 伪模型**（`src/dumate-points.js` + server.js 拦截，思路来自 Wang-JQ77/dumate-api「积分为模型」）：OpenAI `/v1/chat/completions` 与 Anthropic `/v1/messages` 双入口，模型名 `dumate-points` 在 `router.resolve` 之后、`availability` 之前拦截（余额读数不依赖搭子通道就绪态），聚合网页池启用账号的 `quotaOverview` 返回余额文本——**拦截点必须早于 needsModelMap**，否则 mapModel 会把它兜底成 model-text 静默打上游；流式/非流式两套协议形状在模块里是纯函数（`openAIBody`/`openAIChunks`/`anthropicBody`/`anthropicEvents`），进程内 TTL 缓存（`DUMATE_POINTS_TTL_MS` 默认 15s，0 关）。三纪律：零上游消耗（只打读接口，失败不喂池）、不编数（失败行不进合计、全部失败无「合计」行——0 会被读成没额度）、只读网页池（桌面 8980 登录态余额不在此列，文本明说）。**/v1/models 也加了 `dumate-points` 条目**（owned_by=dumate-proxy）供客户端发现。② **/v1/models 实测元数据**（P1-4）：搭子条目按映射 target 查 `DUMATE_REAL` 透出 `contextWindow`/`maxContextWindow`/`maxOutputTokens`——**只在有实测依据时带字段**（搭子超限是整轮失败，编造窗口比缺字段害得多）；target 计算抽成 `model-info.dumateTargetOf/dumateRealOf` 单一来源（dumateRows 与 /v1/models 共用，防漂移）。③ **模型能力/链路标注**（P0-3）：dumateRows 的 `multimodal` 从硬编码 false 改为按 target 档位语义判（`dm-auto-model/mm.*`）；新增 `jsonMode:false + jsonModeNote`（response_format 仅 qianfan/ 前缀支持，按命名空间判不按模型判）与 `links:{app,qianfanRaw}`。④ **/health 身份**（P1-6，`src/service-identity.js`）：四进程统一 `service:'dumate2api'` + `role` 字段（gateway/admin/web-gateway，stable/src 目录跑的网关带 `-stable` 后缀，`DUMATE_ROLE` 可覆盖）+ `X-Service` 响应头——web-gateway 的旧值 `dumate-web-gateway` 已统一（grep 确认无消费者）。**P0-1 的坑**：`normalizeIncomingModel` 不认识 `dumate-points`（非 claude-* 名）原样放行，这是对的——伪模型拦截要放 normalize 之后、resolve 之后。离线验证：`node --test test/unit/dumate-points.test.js test/unit/service-identity.test.js test/unit/model-info-dumate.test.js`（17 项）；全量 `node --test "test/unit/*.test.js"` 602/602 绿。真机冒烟（9099 隔离实例，通道 autostart 全 off）：/health 带 X-Service 头 + role=gateway；/v1/models 四个搭子真名全带实测窗口；伪模型三形态（OpenAI 非流式/流式、Anthropic 流式）返回真实余额 22735.32（2 账号），usage 全 0，二次查询 0.3s（TTL 命中）。

**融合落地第二批（2026-11-07 晚，docs/DUMATE-GATEWAY-MERGE-FEATURES.md P0-2 + P1-5）**：两件 + 一处管理端修复。① **智能体一键配置（后端）**（`src/agent-setup.js` + `admin/routes/agent-setup.js`，挂 `/api/admin/agent-setup/{clients,apply,restore}`）：直写本机 Claude Code（`~/.claude/settings.json`，**env 深合并**——只 upsert 我们的键，用户 permissions/hooks 原样保留）与 Codex CLI（`~/.codex/config.toml`，**托管键合并**——顶层键只放首个表头之前（TOML 语义：追加到尾会掉进别的表）、只移除首表头前区域的托管键（`model =` 是常见键，用户 [profiles.x] 表里的不许动）、托管 provider 表整块替换）。档位/上下文推导复用 ccswitch.js 的 `pickTiers`/`derive`/`buildClaudeEnv`/`buildCodexConfig`（已导出为单一来源，cc-switch 与直写文件两边片段不再漂移）；qoder 并集复用 `qoderRowsMerged`。备份：data/agent-setup/<client>/（索引封顶 10 份、旧文件删除）、restore 前再备份当前态；**响应不回显 token**。**测试的坑**：backupConfig 必须吃与 apply/restore 同一份 io 注入，否则真机的 ~/.claude 会被备份进临时目录、结果随真机状态漂移；备份文件是真实落盘的，restore 读它用真实 fs（注入 read 是给用户配置路径的）。cc-switch 不归它写（专用端点已在，/clients 只报状态指路）。② **低频余额刷新**（`src/balance-refresh.js`，端点 `/api/admin/auto-checkin/balance-refresh{,/run-now}`，**默认关闭**——沿用 keepalive「新排程不悄悄自启」纪律；`DUMATE_BALANCE_REFRESH=1` 部署即用 / `DUMATE_BALANCE_REFRESH_MINUTES` 定间隔默认 10）：填的缺口是「管理端不开、FEFO 快照 at 停滞、网关超 TTL 静默退回普通轮询」与「解冻要等每日 keepalive 22:30」——每 N 分钟轻量跑「quotaOverview（串行 800ms 限速）→ FEFO 快照（成功给 entries、失败 keepIds、剩余>0 的包取最早到期）→ 冷却解冻（复用 `keepalive.internals.reconcile`+`normalizePool`，只解硬冷却、余额查不到不动）」。**patchInternal 只更新 points 的 left/total/used 三个数字**——points 里的 expire_at/subscribed/expiring 是 /credits 按包聚合的派生视图，整个覆盖等于把界面临期明细清空。③ admin/server.js 的 `sendJSON` 补第 4 参 extraHeaders（P1-6 的 X-Service 头在管理端被静默丢掉，冒烟抓到的）。离线验证：`node --test test/unit/agent-setup.test.js`（11 项：TOML 幂等/用户表不碰/往返还原、settings 深合并、备份封顶 10 份）+ `test/unit/balance-refresh.test.js`（7 项，DUMATE_ADMIN_DATA 全家桶隔离）——全量 620/620 绿。管理端冒烟（9123 隔离实例）：healthz 带 `role:"admin"`+X-Service 头；agent-setup/clients 未登录 401、登录后真实探测（发现本机 Claude Code 实际指向 15721、codex 无本网关 provider）；balance-refresh 默认 off 文案如实。**前端视图（AgentSetupView）未做**，端点已可脚本调用。

**融合落地第三批（2026-11-08，docs/DUMATE-GATEWAY-MERGE-FEATURES.md 收尾）**：三件。① **AgentSetupView 前端**（`web/src/views/AgentSetupView.vue` + `web/src/api/agentsetup.ts` + 路由 `#/setup`）：补齐第二批「前端视图未做」的尾巴——客户端卡片实时展示探测结果（Claude Code 指向 15721 时如实标「非本网关，apply 会覆盖」，不装作已配置）；写入弹窗的通道下拉按 `src/channels.js` 五条通道列出、API Key 下拉只列**明文已保存**的 key（鉴权强制后 nokey 必 401，默认值就该是能用的），并允许手填；成功后把备份路径/模型/推导出的上下文与输出上限摊在页面上（那是「依据」，不是弹窗里一闪而过的东西）。菜单入口只对 admin 显示（写本机文件属管理操作），与账户管理同款不走 menuKeys 白名单。② **首启凭证自举**（`keys.ensureFirstRun`，P2-9）：网关监听**非回环地址**且一把 key 都没有时自动签发 `first-run` 并把明文打印一次——本机 127.0.0.1 不触发（零打扰），端口暴露时空 key 集合等于所有请求 401，日志里那三行是唯一入口。③ **子 Key**（`keys.js` 的 `parent_id` + `key-quota.js` 家庭桶，P2-8）：父 Key 停用/删除/过期 → 子 Key `parent_revoked`（吊销级联）；**子 Key 的请求同时计入父 Key 的配额桶**（父的限制是全家共享上限，子自己的 daily_limit 是额外收紧），token 双记走「埋点带 `key_parent_id` → reqlog → `addTokens(..., {familyId})`」；只支持两级（父不能再有 parent），`update` 拒绝「自己当父」与「已当父的 Key 变子」。前端 KeysView 加父 Key 下拉（只列独立 Key、编辑时排除自己）、名称列「子 Key · 父 X」标签、删除确认动态提示子 Key 会一并失效。离线验证 `node --test test/unit/key-subkey-bootstrap.test.js`（9 项）；全量 629/629 绿；前端 `npm run build` 通过（vue-tsc 0 错误）。真机（9082/9083，OpenCLI 驱动已登录浏览器）：`#/setup` 渲染真实探测（Claude Code 指向 15721、Codex 无本网关 provider、cc-switch 指路）、写入弹窗通道与 Key 自动选中、`#/keys` 经 API 创建子 Key 后列表显示「子 Key · 父 dumate」，删除清理后恢复六把预置 key。

④ **跨通道额度总览卡**（P2-10，`src/channel-balance.js` + `admin/routes/channel-balance.js` + `ChannelBalanceCard.vue`）：一张卡并排列出五条通道的剩余额度、账号健康、临期账号数。**不跨通道相加**——单位不同（搭子/千问是积分，TRAE/Qoder 是 credits，WorkBuddy 国际版按请求数计），卡片明写「不可相加」且不给总计。口径四条：`remaining=null` 表示取不到（绝不填 0）；部分账号失败显示橙色 tag + tooltip 明细（只显示 `1/2 账号` 不给原因会被当成显示问题）；Qoder 团队共享池 `cap=-1` 标 `unlimited`（不是有限数字，不进合计）；进程内 60s TTL（`DUMATE_CHANNEL_BALANCE_TTL_MS`）。单通道适配器独立 try/catch + 15s 超时（一个通道上游挂了不拖垮整张卡）。搭子复用 `dumate-points.summaryCached`（网页池），千问/TRAE/Qoder/WorkBuddy 各自遍历账号池且**先用 get(id)/findUsable 拿完整账号再换票**——`authStore.list()` 是脱敏视图，直接喂 `session.ensureAccount` 会因拿不到 refreshToken 全 401（真机踩到：Qoder 两账号全 401 而 `/qoder/credits` 正常，差别就在这一行）。临期数据来自 `expiring.info`（四家快照，`info` 新增 `nearest` 字段）与 Qoder 的 grants 账本。卡片挂在五个通道分支**之外**（Dashboard 底部），页头刷新一并触发。离线验证 `node --test test/unit/channel-balance.test.js`（6 项：合计只累已知数值、失败不填 0、超时兜底、TTL、unlimited）；全量 635/635 绿。真机（9083）：五通道真实读数全出（搭子 23735.32 / 千问 14.52（1 账号 401 如实标）/ TRAE 6061.9 / Qoder 3601 / WorkBuddy 10471.61），切 TRAE 通道卡片仍在。

## 2026-11-08 落地（TRAE 调研融合批次，docs/TRAE-GATEWAY-MERGE-FEATURES.md）

> 逐项核对结论、证据与不实现项见 `docs/TRAE-FUSION-CHECKPOINT-2026-11-08.md`。调研文件的 20 项里有 5 项在生成时已有等价实现（9074 自愈、Key 配额/区域、Token 预刷新、图片输入、单号并发上限），未重复开发；P2-15 的「代理池哈希绑定」因无代理池配置证据不做，现有 `proxy-agent.js` 已按账号固定出口。

**通道核心**：① `src/trae-runtime.js` 运行期配置（原子写 + mtime 热读，跨进程），默认全关。管理端 `#/trae-runtime` 可视化；端点 `/api/admin/trae-runtime`、`/max-mode/models`、`/max-mode/apply`。② **P0-4 两态开关**：`auth.js` 的 `modelEnabled` 只拦对话，`findModelUsable` 供 send 用；签到/额度/保活仍走 `findUsable`，全关时 `status().loggedIn=true` 且明确报「关闭了接模型请求」。前端账号卡第二个 switch。③ **P0-3 显式降级**：`traework/degrade.js` 只认 402 / 3003/3004/4008 / 1005 / 订阅专享等确证错误；429 限流、400 参数、内容审核一律不降级；第一尝试吐出任何内容后不降级；API Key 的区域绑定压过 `fallbackRegion`；成功回调 `onDegraded` → 网关非流式写 `X-Trae-Degraded` 头、流式若头已发则写 SSE 注释帧。双失败保留第一次根因。④ **P0-5 Max**：运行期开关 + 白名单与 env 并联，管理端「检测支持的模型 → 一键加入」只认 descriptor `max_mode`，不按名字猜。⑤ **P2-13/16**：积分优先轮询与保留积分护栏默认关；余额未知沉底但不跳过，绝不读成 0。⑥ `keys.modelMatches` 加 fnmatch `*`/`?`（大小写不敏感，无通配符仍是精确匹配），旧 key 行为不变。⑦ **P2-11**：`upgradeRequired` 只认上游 descriptor 显式字段，模型信息表显示「需升级」徽标，不伪装成风控。

**运维与管理端**：⑧ 七类告警规则 + 静默窗/迟滞/恢复（`src/admin/alerts.js` + `/api/admin/alerts`），复用 `notify.js` 的五种 webhook；后台评估 `DUMATE_ALERTS_SCHEDULE_MINUTES`（默认 0 关闭）。⑨ 配置恢复 `POST /api/admin/system/restore`（`src/config-restore.js`）：配置白名单、恢复前自动备份当前态到 `data/config-backup/`（封顶 10 份）、非法整包一口拒掉、响应 no-store；`/system/backup` 补 no-store。⑩ 服务端运行日志：`src/admin/logbuffer.js` 环形 500 行，**入缓冲前整行脱敏**（敏感键/Bearer/sk-/key=value），`/api/admin/logs` 与 SSE `/logs/stream`（回放 + 4 订阅者上限）；前端 `#/logs`。⑪ 侧栏角标：`/traework/status` 的 `alerts` 汇总 + `MainLayout` 的 `a-badge`，余额未知单独计。⑫ 批量凭证运维 `POST /traework/accounts/batch`（`traework/batch.js`，≤200 条、逐条隔离、恢复默认保留上游冷却，`force` 才 `revive`；路由注册在 `/accounts/:id` 之前）。⑬ Prometheus `/metrics`（根路径，另挂 `/api/admin/metrics`；低基数标签、可选 `DUMATE_METRICS_TOKEN`，未配时根路径匿名、管理端路径仍要会话）与月度账单 `/api/admin/monthly-billing{,/export}`（CSV UTF-8 BOM + `= + - @` 公式注入防护，用量页导出按钮）。⑭ 全站 kill switch：`gatewayPaused` 默认关，网关在鉴权**之前**拦所有非 `/health` 请求回 503 `service_paused`，管理台照常。

**验证**：新增 4 个离线单测文件 24 项；全量 `node --test "test/unit/*.test.js"` 655/655 绿；`npm run verify` 41/41 绿；`cd web && npm run build` 通过（vue-tsc 0 错误）。隔离管理端真机（9123，独立 `DUMATE_ADMIN_DATA`，未动 9080/9082/9083）：healthz 身份、七个新只读端点 200、未登录 401、非法运行态键/恢复包/批量 ids 全部 400、运行态 PUT 后热读生效并复位、批量导出脱敏、日志 SSE 回放、CSV 头带 BOM。降级真机链路（额度耗尽/备用模型/响应头）未跑——需要真实额度耗尽账号，编排正确性由打桩端到端单测锁定。

**TRAE 调研收尾（2026-11-08 第四批，`docs/TRAE-GATEWAY-MERGE-FEATURES.md` 20/20 全落地）**：把上一轮标「不做」的 P2-15 与 P2-16 补完——复核后发现它们**不需要外部证据**，此前判断偏保守。

① **P2-16 每日用量护栏**（`src/traework/guard.js`）：与「保留积分」互补——那个看余额快照（还有没有钱），这三项看当日已用量（今天是不是用过头了）：`dailyTokens` / `dailyCredits` / `modelTokens`（按 `(账号, 模型)`）。数据源是本进程落盘事实（`requests.jsonl` 的 `account_id` + `traework-credits.jsonl` 的 consumed 增量），**不打上游、不新增存储**。三条纪律：**未知不拦**（`account_id` 或用量读不到照常放行，把「不知道」当「用完了」会让整池静默不可用）、只拦新请求不打断在途、判定与展示**同一个 `usageOf` 函数**（两处各算一遍必然漂移）。`account_id` 缺失的行不进任何桶，不摊到别人头上。默认关，阈值走 `trae-runtime` 的 `accountGuard`；管理端「运行策略」页有三个输入框 + 「查看今日用量」表（`GET /api/admin/trae-runtime/usage`）。

**前置修复**：埋点原来只记 `account`（显示名，可改可重名可空），没有账号 id。补 `req._upstreamAccountId` → 埋点 `account_id` 字段——按显示名聚合会把两个账号的用量并成一个桶。`onAccount(name, id)` 早就有 id，只是没落。

② **P2-15 代理池稳定分配**（`proxy-agent.js`）：`DUMATE_PROXY_POOL`（逗号/换行分隔）→ `sha256(channel:id) % len` **稳定落点**。三要点：**稳定哈希不是轮询**（重启、增删别的账号不能让出口漂移——出口跳变本身就是异常信号）；**账号显式 `proxy` 永远优先**（手填的出口不被悄悄改掉）；**池空 = 行为不变**。非法条目启动时 fail-fast 抛错，不静默跳过（否则「以为配了 8 个出口、实际只有 3 个」无从发现）。键位用 `__channel` 显式传入——各通道 id 是各自文件里的自增数字，只用 id 会让不同通道的同号账号挤在一个出口。

**验证**：新增 `test/unit/trae-guard.test.js`（8 项）+ `test/unit/proxy-pool.test.js`（8 项）；全量单测 **676/676**、`npm run verify` **41/41**、`npm run build` 通过。真机（9083）：`/trae-runtime/usage` 返回三账号当日用量，`null` 与 `0` 区分正确（无记录显示「—」，账本有记录但消耗为 0 才显示 0）；界面三输入框 + 用量表渲染正常，无前端报错。

## 2026-11-16 落地（GitHub TRAE 调研 P0-1：模型表缓存按「作用域」隔离）

> 调研文件 `docs/GITHUB-TRAE-RESEARCH-2026-11-16.md`（13 项可融合，另 9 类明确不融合、企业版内容整体剔除）。本批只做 P0-1，其余待做。

**问题（静默型，不报错但结果错）**：`src/traework/models.js` 的缓存原先就是 `Map<region, {at,data}>`，而取数账号来自 `accountForRegion()`——**该区第一个可用号**。但上游模型表里一半字段是**账号相关**的：`consumption_rate`/`discount`（倍率与会员折扣）、`reasoning_effort_config`（思考档位）、`max_mode`（1M）、`multimodal`（视觉）。于是同区第二、第三个号看到的是第一个号的能力表：`/v1/models` 与管理端「模型信息」全部 200，能力判断却可能错。口径依据 Trae2api-cn v1.0.11（2026-11-05）：「模型目录缓存按账号、Agent/Work 档位、原生 `raw_chat_function`、网关与客户端身份参数隔离；同一范围的并发冷读取共享一次上游请求。」

**做法**：
① 新增 `src/traework/models-cache.js`——缓存策略独立成纯模块（能离线单测）：TTL + LRU 上限 + **单飞**（同键并发只跑一次 producer，失败原样抛给每个调用方且不缓存错误）+ `region` 兼容视图 + 自检 `stats()`。**正在单飞的键不淘汰**，否则两个读者会打两次上游。
② `models.js` 的 `fetchModels({region, accountId, fn, force})` 走四维作用域键（`region|accountId|fn|version`，脏字符替换防撞键）；`doFetchModels` 作单飞 producer；**拉失败不覆盖旧缓存**（否则能力校验会从「已知不支持」退化成「未知放行」，那是另一种错）。所有老调用方只传 `region`，行为与改造前一致。
③ **同步读者改成聚合**，每个字段的合并方向不同（不是「取最新」）：`multimodal` 取 **OR**（校验口径是「只挡确知不支持」）、`maxMode` 取 **AND**（虚报 1M 直接吃上游 400）、`upgradeRequired` 任一为 true、上下文与 `maxTokens` 取 **min**（写大了必 400）、`reasoningEfforts` 全都有才取交集、倍率不一致标 `rateScopeAmbiguous` 并露出 `mergedScopes`——**合并过的事实必须能被看见**。
④ **预热按账号各一份**：`warmupModels()` 每区最多 `DUMATE_TRAEWORK_MODELS_WARM_MAX`（默认 3）个账号；**返回值仍是「单个结果」形状**（`ok/models/error` + `scopes/warmed/failed`），因为 `server.js` 的启动日志读 `m.ok`/`m.models.length`——直接返回 `Promise.all` 的数组会把成功打成「拉取失败（unknown）」，这条被回归测试锁住。
⑤ send 路径两处 `fetchModels`（remote 与 solo 取 `customModel` 原始行）改为**带 `auth.id`**：必须是被选中那个号的行，不能是该区第一个号的。
⑥ 管理端：`/traework/models` 回 `scope/cacheScope/cached/scopes`；新增 `GET /traework/models/cache`（作用域清单 + 命中统计，只读）与 `POST /traework/models/cache/clear`（admin）；`/models/info?channel=traework` 透出同样字段 + 行级 `mergedScopes/rateScopeAmbiguous`。模型页「模型信息」显示**缓存作用域**（账号/function/版本/指纹/命中与否/本区份数）与「清缓存重取」按钮——**没有作用域显示就不许上线**，否则下次「能力判断错了」还是查不出来。

**边界（别顺手改）**：`assertImageSupport` 仍在**选号之前**，拿不到本次账号，所以它读的是聚合视图（OR 语义）而不是某个号——这是刻意的；表没预热仍放行（宁可不挡）。P2-11 的会话指纹口径（是否含 system）本批**没动**。

### P0-3（同批）：凭证被拒的处置 + 冷却隔离 + 单号人工恢复 + 跨区容灾（默认关）

**问题**：`classify` 把**裸 403** 归进 `breaker`（服务故障：指数退避到 6 小时、账号级）。
但 403 多半是「这份凭证/这个身份不被允许」——等多久都不会自愈，只有重登能解。
NextAgentX v2026.11.141713 的原始症状就是「账号被所有模型排除」。

**做法**：① `upstream-errors.isAuthReject` 分状态码判——`401` 直接 `session_dead`；
`403` **要正向的凭证/授权文案证据**才归 `session_dead`；**裸 403 保持 `breaker` 不动**
（Qoder 实测 403 还表达额度 112/110/114 与限流 RESOURCE_LIMIT，把「不知道」当「凭证失效」
会累计 N 次禁用账号，那是另一种误伤）。两条例外必须排在前面：`403 + 模型不可用` → `model`、
`403 + 1005/订阅专享` → `model`、内容审核 → `kind: null`。② `degrade.js` 显式排除凭证被拒
（同一凭证换模型/换区都是白试，把「请重登」拖成两倍耗时）。③ **单账号恢复**
`POST /api/admin/traework/accounts/:id/recover`：清冷却/熔断/401 计数/禁用 + 清 `lastError`，
回 `before` 快照；与批量 `resume` **刻意不同语义**（批量默认保留上游冷却防手滑，单号总是清）。
④ **跨区容灾默认关**（`crossRegionFailover`）：只有本区**一个可用账号都没有**时才改派，
且要求 Key 未绑区域 + 对方区真有账号 + 该模型在对方区**表已就绪且已知**（`isKnownModel`
在未预热时是放行语义，单独用等于没证据）+ 只试一次；命中写 `X-Trae-Failover`/SSE 注释帧。
判定抽成纯函数 `src/traework/failover.js`，执行留在 `index.js`。

**验证**：新增 `test/unit/trae-auth-reject.test.js` 20 项（分类边界、降级排除、池的计数归属、
人工恢复、容灾判定 6 项、Load 字段白名单）；全量 **736/736**；
`node test/verify-qoder-throttle.js` / `verify-qoder-error-surface.js` / `verify-traework-repair.js`
（38 项）/ `verify-channel.js` 全部通过——**403 的口径是 Qoder 实测约束的，改这条前先跑它们**；
`npm run build` 通过。隔离管理端 9123：`recover` 未登录 401、不存在的 id 404；
`crossRegionFailover` 默认 `{enabled:false,to:''}`、PUT 往返、非法 `to` 400、复位正常。

**未跑**：真机 403 凭证失效（需要让一个账号的 token 真过期）与真机跨区（需要两区各一个账号）。

### P1-5（同批）：请求尝试链——把「为什么失败」摊成时间轴

**问题**：请求日志原来只有一行结论（状态码/账号/耗时），于是「为什么这个号被跳过」
「为什么最后 503」只能翻代码猜。P0-3 那批判据（认证拒绝不重放、冷却隔离、跨区容灾、
降级）缺少**验收面**。冒烟时还发现更硬的一条：**被路由闸门拒掉的请求一条日志都没有**
（`requests.jsonl` 里连行都不存在），「为什么 503」在管理端查不到。

**做法**：① 新 `src/attempts.js`（纯函数）：`create({t0, limit:8})` → `add({accountId,
account, outcome, reason, at, ms})` + `json()`；**只记判据，不记请求/响应报文**；
超过 8 条置 `attempts_truncated`；`ms` 非有限值不落（避免界面显示 NaN）；
账号名/原因各截断 60/120 字（一条脏数据不能撑爆日志行）。② `channel-pool.availability`
增 `details`（最多 20 条逐账号原因：`disabled`/`paused`/`floor_blocked`/`interval`/
`inflight`/`cooling:soft|hard|breaker`/`model_cooling:<模型>`）。③ `traework/index.js`
在真实路径上写链：无可用账号 → `skip`（带原因）、选中 → `picked`（带选号策略）、
上游报错 → `error`（带 `classify` 的 kind + 状态码）、成功 → `ok`（带耗时）、
跨区 → `failover`。④ `server.js`：每请求建链并透传；`logRequest` 把 `attempts/
attempts_truncated` 写进埋点；**新增 `logGateReject()`**——`route.error`（未知前缀）
与 `availability` 不通过的八个分支各记一行 + 一条 `gate: <原因>`，原因与原响应文案同源。
⑤ 前端请求详情抽屉加「尝试链」：时间轴 + 颜色标签 + 逐条原因。

**一个踩到的坑（值得记）**：`picked` 条目最初引用了 `remoteOpts`——它在下面的 `try`
块里才声明，引用抛 `ReferenceError` 被外层 `catch` 吞掉，于是链里只剩 `error`，
看起来像「没选号就失败了」。教训：**吞异常的 catch 只该包住埋点本身**，判据字符串要
用当前作用域确实存在的变量拼；接线测试因此对 `picked` 的 reason 断言得很死。

**验证**：`test/unit/attempts.test.js` 8 项（上限截断、字段白名单、NaN 不落、截断长度、
summary、availability.details 的四类原因）+ `test/unit/trae-attempts-wire.test.js` 4 项
（成功 = picked→ok、上游 500 = picked→error(breaker:500)、池空 = skip、不传 attempts 不炸）；
全量 **785/785**；`cd web && npm run build` 通过。
真网关冒烟（9125 + mock 上游 52890，未动 9080）：搭子/TRAE/Qoder 各回 503、未知前缀回 400，
**四条都落了日志**，`attempts` 分别为
`gate: 搭子当前只用网页凭证…` / `gate: 没有可用账号（需先登录）` /
`gate: unknown_channel: qwn` / `gate: 尚未添加 Qoder 账号…`。

**未做**：直连通道「真的选中账号后」的 picked/ok/error 落在真实网关日志里（本机没有
TRAE/Qoder 账号，`handleDirectChannel` 之前的闸门就返回了）——这段由打桩接线测试锁定。

### P1-8（同批）：签到补签——「今天还差谁」+ 睡眠唤醒补跑

**问题（两种形态，都是「根本没人跑」，重试救不了）**：
① `admin/routes/autotask.js` 的 `nextRunAt()` 把「今天已过的时刻」**顺延到明天**——
进程在 09:17 之后启动、或机器那时在睡眠，当天就整天空转；
② TRAE 侧的 `task-scheduler` 是「从现在起每 30 分钟」（重启后自然补），但它**默认关闭**，
关着的时候同样一整天没人签。而 `/checkin` 只回答「现在给这些号签一次」，
**不回答「今天还差谁」**——于是界面上看不出缺口。

**做法**：① 新 `src/traework/makeup.js`（纯函数）：
`plan({accounts, rows, now, window, ids})` → `{day, window, due, skipped, counts}`，
`shouldCatchUp({enabled, hour, minute, now, lastRunDay})` → 该不该补跑。
② `admin/routes/autotask.js`：配置落盘加 `last_run_day`（幂等键）；`schedule()` 先问
`shouldCatchUp`——**时间点已过 + 今天没跑过 → 立刻 `runOnce('catchup')`**，跑完再排下一次；
`runOnce` 结束时写 `last_run_day` 并落盘。GET/POST 统一走 `snapshot()`（形状不一致会让前端读到 undefined）。
③ 新端点 `POST /api/admin/traework/checkin/makeup {ids?, dryRun?}`：**默认 dryRun 预览**
（这是会在上游产生动作的接口），只对 `due` 跑幂等 `checkinAndSave`，账号之间留 2s 间隔
（与 `task-scheduler` 同口径）。前端签到卡加「今日补签」区：待补/已签/停用计数、
跳过原因逐条显示、执行后逐账号结果。

**「今天签过了」的两条证据，缺一不可**：① 本地账本今天有该账号的行（**`source:'claim'`
与 `'already'` 都算**——后者是上游说已签，比如用户在 TRAE 客户端签的）；② 账号
`lastCheckin` 落在今天。只认①会把「账本上线前就签过」的号误判成没签，
每次补签都白打一次上游。**不采用**「不确定就当已签」——那会让真没签的号永远不补；
这里的代价不对称（多问一次上游 vs 一整天没签）。

**窗口**：默认 09:17–23:30（与 `DUMATE_AUTO_CHECKIN_HOUR/_MINUTE` 的默认一致），
窗口外不产生 `due` 并在 `skipped` 里写明原因（`outside_window` + 可读文案），
**不静默返回空**。它是安全边界不是排程：改每日签到时刻不影响它。

**验证**：`test/unit/checkin-makeup.test.js` 11 项（窗口三个边界、两条证据、
昨天不算、ids 过滤、停用跳过、别的通道行不算、shouldCatchUp 四种分支）；
全量 **773/773**；`cd web && npm run build` 通过。
隔离管理端 9123：`/checkin/makeup` 未登录 401、默认返回 `dryRun:true` + 窗口原因；
`/auto-checkin` 开启并把时刻设成已过（00:01）→ 立即 `trigger=catchup` 跑一次、
落盘 `last_run_day` 为当天；**重启进程后不再补跑**（幂等），`next_run_at` 顺延明天；
POST/GET 返回同一形状（`snapshot()`）。

**未做**：真机补签（需要账号且要在 09:17 之后）；签到「计划按时刻分组」与记录表列宽/显隐
（P1-8 的展示部分，等 P1-5 的尝试链一起做界面批次更划算）。

### P0-2a（同批）：登录的本机回环自动回调

**问题**：加一个账号要「点开授权页 → 登录 → 从地址栏抄那条长 URL → 粘回来」，
抄错一个字符就换票失败；而且 `login_trace_id` **只生成、回调侧从不校验**，
没有取消入口、没有到期。

**做法**：新 `src/traework/oauth-callback.js`（`createBroker`）——发起登录时在
**127.0.0.1** 起临时监听，授权页自己跳回来就接住并换票入库；四条管理端点
`/login/start`（POST）、`/login/status`（GET 轮询）、`/login/cancel`（POST）、
`/login/complete`（POST，手动粘贴退路）。老的 `/login/url` + `/login/callback`
**原样保留**（同一条换票逻辑，抽成 `exchangeFromBroker` 给两条路共用）。

**端口默认 18080，不用随机端口**：18080 是 2026-11-03 真机验证过的那条 URL
（`login.REDIRECT`）；hub v1.6.0 用随机端口是通的，但登录是「一次不成白等 10 分钟」
的动作，没有收益不该赌上游对随机端口的宽容度。可用
`DUMATE_TRAEWORK_LOGIN_PORT` 显式改；**被占用时明确报错**（附可执行建议）并让前端
退回手动粘贴，**不静默换端口**——那会让授权页跳到一个没人监听的地址。

**安全边界六条**：只绑 127.0.0.1 · 校验 Host（防 DNS rebinding）· 不发任何 CORS 头 ·
`state`（= 上游 `login_trace_id`，32 字节）单次消费 + 10 分钟到期 + 收到即关监听 ·
回调 query **不进日志**（里面有 refreshToken）· 未知/已取消/已过期一律拒绝且不泄露
别的会话。响应写完后 `closeIdleConnections`（Node 19+ 默认 agent 会 keep-alive，
不回收的话客户端会再收到一次 409，看起来像"监听没关"）。

**一条刻意的「不严格」**：上游回调是否一定回显 `login_trace_id` 没有证据
（hub 自己也说国内版没有 product.json 证据）。所以规则是「**带了就必须对，没带就放行
并标记 `trace_verified:false`**」，把这个不确定性摆在界面上——而不是猜一个方向
（严格拒绝可能打挂国内版登录；一律放行等于 state 校验形同虚设）。

**验证**：`test/unit/trae-oauth-callback.test.js` 12 项（真实 HTTP 到 127.0.0.1：
正常回调 / state 不匹配且不消费 / 无 trace 放行并标记 / 单次消费 / Host 伪造 403 /
非 `/authorize` 404 / 取消 / 到期（注入时钟）/ 换票失败只调一次 / 未知 sid / 端口占用 /
traceOf 字段兼容）；全量 **762/762**；`cd web && npm run build` 通过。
隔离管理端 9123 + **真上游**冒烟：`/login/start` 返回 32 位 sessionId、URL 里
`login_trace_id` 64 位且与 `auth_callback_url` 同为 18080；监听确实起在 18080；
打一条假 `refreshToken` 的回调 → 页面「登录未完成」、状态 `failed` 且原因是上游真话
（`401 / 20101 refresh token is invalid`）、**回调后监听已关**；取消后端口释放；
state 不匹配 403 且不消费；缺 refreshToken 如实失败；未知 sid 404；未登录 401。

**未做**：真账号完整走一遍（要人点浏览器登录）；界面视觉核对（本机无浏览器工具）。

### P0-4（同批）：每模型默认思考档（客户端没给档位时才套）

**问题**：客户端（Codex / Claude Code / 散装脚本）经常不带 `reasoning_effort`，不带时上游按
**它自己的**默认走，用户无法表达「这个模型我就要 high」。但也不能因此把网关的默认值塞进请求
——档位是**模型能力**，不是全局设定。

**做法**：① 新 `src/reasoning-apply.js`（纯函数）：`applyDefault(payload, {table, model, supported})`
→ `{payload, source: client|default|none, requested, effective, note}`。三条纪律：**客户端优先**
（任何形态的档位都算，含 `thinking.budget_tokens` 换算）、**没有 descriptor 就不套**
（`supported` 为空即「不知道支持什么」，此时套默认等于拿用户的钱赌）、**只向下钳**并如实说明被钳过。
档位词表**复用 `remote.js` 的 `EFFORT_LEVELS/normalizeLevel/clampLevel`**（单一来源，不写第二份）。
② `trae-runtime.js` 增 `defaultReasoning: {模式: 档位}`（模式支持 精确名 / `前缀*` / `*`，最长前缀优先），
**写入口就归一化**（`ultra` → `extra_high`，配置里不该出现两套词表）+ 非法档位 400；
`merge()` 对这张表是**整体替换**而非深合并（否则「删掉一行」永远删不掉）。
③ 接线在 `traework/index.js` 选号之后（那里才同时有本次**账号**与**模型**）：只认该账号的 descriptor；
套用经 `onReasoning` 上报 → 网关写 `X-Reasoning-Applied: default:<档位>`（头已发则 SSE 注释帧），
埋点加 `reasoning_source / reasoning_requested / reasoning_effective`。
④ **只读探针** `test/probe-traework-reasoning.js [cn|intl] [--all]`：只打模型表、不发对话，
打印每个模型的 `support_thinking`/`options`/相关键，并明确回答「上游 descriptor 到底有没有
默认档字段」。**当前结论：没有证据**（XCool 的 `reasoning_default` 是它自己的命名），
所以默认值只能是我们的配置，不按那个名字去猜字段。

**验证**：新增 `test/unit/trae-models-scope.test.js` 17 项（纯缓存 7 + 打桩上游 10：两账号各拿各的表、并发只打一次、force 也参与单飞、聚合三个方向、失败不覆盖、无账号/幽灵 accountId 如实报错、warmup 返回值形状与失败原因）；全量 `node --test "test/unit/*.test.js"` **716/716**（连跑 3 次稳定）；`cd web && npm run build` 通过（vue-tsc 0 错误）。隔离管理端 9123（独立 `DUMATE_ADMIN_DATA`，全程未启停 9080/9082/9083）：未登录新端点 401、`/traework/models/cache` 200 带 `cap=8/ttlMs`、`clear`（带/不带 region）200、`/traework/models` 与 `/models/info` 均带 `scope{key,id,fn,version}` 且错误如实为「没有可用账号（需先登录）」。**未跑**：真机多账号（需要两个不同会员等级的 TRAE 账号）——隔离方向由打桩单测锁定。

### P1-9（同批）：通道风控参数上台（并发 / 间隔 / 短故障重试 / 限流冷却上限）

**问题**：四个旋钮里有两个只认环境变量（`DUMATE_<CH>_INFLIGHT_MAX`、`DUMATE_<CH>_MIN_INTERVAL_MS`），
另外两个更糟——`DUMATE_THROTTLE_MAX_MS` 与 TRAE 的 `REPAIR_MAX/HOLD_CAP` 是
**`require` 时算一次的模块常量**，改完要重启三个进程才生效。调风控参数本来就是
「现场试一个值、看 10605 率再改」的活，重启一次就把正在跑的会话打断。

**做法**：
① 新增 **`src/throttle.js`（唯一解析点）**：`resolve(通道, 旋钮) → {value, source, panel, envValue, env}`，
优先级 **面板 > 环境变量 > 内置默认**。三个消费方（`channel-pool` / `repair` / `upstream-errors`）
**一律经它取值，不再各自读 `process.env`**——两套读法会让界面显示 3 而实际生效 1。
② `livecfg.js` 加两个白名单字段：`throttle: {通道: {inflightMax, minIntervalMs, retryMax}}`
与全局 `throttleMaxMs`。存储稀疏（只存真被设过的项），`Load()` 补成全通道 × 全旋钮形状
（未设 = null），**合并是逐层 patch**：`{通道: null}` = 整条重置、`{旋钮: null}` = 只清这一项、
兄弟项保留（整体替换会让「清一项重试次数」连带清掉并发帽）。
③ `repair.envCaps` 的 `REPAIR_MAX` 多一层面板覆盖；**`HOLD_CAP` 刻意不进面板**——它是
「多长算真回答」的判据阈值，不是节奏参数，改了会让同一段回答时而被扣时而直发。
④ TRAE 那条最绕：`chat.js` 原先把 `repair.envCaps('TRAEWORK')` 快照成模块常量，
现在改成 `repairMax()/holdCap()` **现读**；`createTextGate` 的缓冲阈值在**创建时取一次**
（每个 SSE 事件都 stat 一次 livecfg 是浪费，且同一条流必须用同一个判据）。
`test/verify-traework-repair.js` 里「关掉重试」原来是改模块常量，改成设 env——改常量
已经没有任何效果，那样「测过了」是假的。
⑤ 管理端：`GET /system/throttle` 回**生效值 + 来源 + 兜底 + env 名**（回答「我填了 2
怎么还是 4」）；`POST /system/pool-revive {channel}` 按 `${channel}:` 前缀**只复位本通道**
（四通道共用一台池，但故障原因是各自上游给的）。前端新页 `通道风控`（`ChannelPolicyView`，
admin 专属），每格下方显示生效值与来源标签，带「恢复本通道 / 重置」。

**三个 0 的语义**（照抄会错，单测锁着）：`inflightMax` 的 0 = **没填**（0 个在途名额是死锁，
回落到池默认 4）；`minIntervalMs` / `retryMax` 的 0 = **显式关断**，必须能穿透 env——
否则 env 一旦设过值，界面上就再也关不掉了。

**验证**：新增 `test/unit/throttle-config.test.js` 14 项（清单不漂移、优先级、三个 0 的语义、
逐层合并与两条重置、Load 形状、非法输入 strict 抛错、channel-pool 间隔闸门现读 + 复位、
repair 面板覆盖、throttleMaxMs 热读与 1000 下限、两个新端点的形状与通道隔离）；
`test/unit/repair-gate.test.js` / `test/verify-traework-repair.js` 补了 `DUMATE_ADMIN_DATA`
临时目录（读 livecfg 的模块在测试里必须钉住，否则本机面板配置会让断言机器相关）；
全量 `node --test "test/unit/*.test.js"` **799/799**；`cd web && npm run build` 通过（vue-tsc 0 错误）。
隔离管理端 9127（独立 `DUMATE_ADMIN_DATA`，全程未启停 9080/9082/9083）：`GET /system/throttle`
默认全 `default`、PUT 面板值后读回 `source=panel` 且 **`livecfg.json` 里只写被设过的项**、
`{通道:null}` 重置后回落到 4、`POST /pool-revive` 空池 200、未知通道（`dumate`）400 并列出可用通道。
**未做**：`public` 之外没有新暴露面；跨进程生效走的是与 `softCooldownMs` 同一条 mtime 路径，
未再单独起网关验证（本机无账号，网关侧没有可观测点）。

**顺带发现的存量问题（不是本批引入，已在 HEAD 复现）**：`test/verify-qoder-throttle.js`
的「status 明说还要排很久 → 早停」一项失败（实测 8.3~9.0s，阈值 7s）。用 `git worktree`
在干净 HEAD 上同样失败。口径：早停（`giveup`）之后外层仍按 `QUEUE_PATIENCE_MS`(6s)
换号重试，两个账号累加就到了 9s。**要么改判据要么改文案，别只调阈值把失败藏起来**——
本批没动它（改 Qoder 换号节奏需要真账号验证）。

### P1-6（同批，第一批）：内联图片的体量观测与上限（**不做压缩**）

**为什么先不做压缩**：上游产品（Agent2API v3.4.0）是「转发前缩长边并重编码」，
那件事必须先有编解码器（PNG 可纯 JS 做，JPEG 要 huffman 解码 + 重编码），是另一个
量级的改动。而「这次到底带了几个图、多大、超没超」跟编解码无关却**没人在量**——
没有这组数，谈「要不要压、压到多少」全是猜。所以本批先做**可观测 + 可守门**。

**做法**：① 新 `src/image-budget.js`（纯函数）：`dataUriOf` 解析内联图、
`scan(payload)` 出统计（张数/内联张数/总字节/单张最大/格式分布/指纹）、
`apply(payload, limits)` 出判定、`describe` 出 413 文案。**字节按 base64 解码后算**
（`len*3/4 - padding`），不真的 decode——为量尺寸分配 5MB 新字符串不值得；
且报「字符串 6.7MB」会跟上游说的 5MB 对不上。② 统计与判定**只读 profile**，
一律不改 payload（压缩要另开一批，别在这里偷偷改字节）。
③ 上限两个维度（单张 / 单请求合计），默认 0 = 不限；面板 > env > 不限，解析只在这一个文件里。
④ 接线在四入口的「翻译之后、分流之前」——到那里 payload 都已是 OpenAI 形状
（图像统一成 `image_url` part），扫描只有一份实现。**chat 入口例外地放在可用性闸门之前**：
图太大是客户端自己能修的问题，先回「没有可用账号」会把人带去查错方向；顺带这条
判定不需要账号，可离线验证。⑤ 埋点：`image_count / image_inline / image_bytes /
image_max_bytes / image_format` 写进请求日志（**超限与否都记**），超限时另加一条
闸门判据 `gate: 图片超限：第 N 张 4 MB > 1 MB`；请求日志详情抽屉显示「内联图片」一行。

**边界（别顺手扩）**：只认 `data:image/...;base64,`；外链 http(s) 只计数不判上限
（大小在上游手里，量不出来就别假装量得出来）；非图片的 data URI（音频/PDF）不算图片预算；
扫描抛错**不阻断请求**（守门是附加能力，不能变成 503）。

**验证**：新增 `test/unit/image-budget.test.js` 10 项（base64 字节含 padding 边界、
只认内联图、内外链分开计、指纹稳定性、默认不限、单张/合计两种超限的文案口径、
判定只读、limits 优先级、空形状不炸）；全量 `node --test "test/unit/*.test.js"` **809/809**；
`cd web && npm run build` 通过。**隔离网关 9123 真机验证**（`DUMATE_AUTOSTART=off`、
无任何账号、`DUMATE_IMAGE_MAX_MB=0.001`）：4KB 内联图 → **413** 且文案是
「第 1 张 4 KB（image/png）超过单张上限 1 KB。请把长边缩到 1568px 以内或改用 JPEG 后重发」，
`requests.jsonl` 里该行的 `image_*` 与 `gate:` 判据齐全；去掉上限后同一请求回到
**503（没有可用账号）**且图片体量照样入账——证明守门没打断正常链路。
隔离管理端 9127：`GET /system/throttle` 的 `imageBudget` 默认 `source=default`、
PUT 面板值后读回 `panel`、`livecfg.json` 落字节。

**未做**：`responses` / `anthropic` / `google` 三个入口的 413 与压缩 **未实测**：
它们的判定在可用性闸门之后（翻译才拿得到图），本机无任何账号。三条都走同一个
helper、同一个 `openaiReq` 变量，接线由 `node --check` 与代码结构保证。

### P1-6 第二批（同批）：PNG 真压缩 + 同一原图复用（`src/png.js`）

**为什么自己做编解码器**：JPEG 要 huffman 解码 + 重编码（量级完全不同），而插进
Codex/Claude Code 的**截图几乎都是 PNG**；PNG 只需要 inflate + 反滤波 + 重压，
Node 自带 zlib。所以先做这一半，并把「不做」写死：**JPEG 原样放行**，由 413 那条路
给用户处置建议。三条不猜的边界：隔行（Adam7）→ null、位深 16 / 小于 8 → null、
未知滤波器值 → null（一律返回 null 让调用方走原路）。

**做法**：① `decode` 支持灰度/RGB/调色板/灰度+A/RGBA 五种 colorType，**统一展开成
RGB 或 RGBA**（编码侧只有 2/6 两种）；`encode` 逐行在 None/Sub/Up/Paeth 里按
「残差绝对值之和」挑一个（带早停），比固定 None 小 10~30%。② 缩放用**面积平均**
（`resize` 按源像素落在目标像素矩形内的面积加权）而不是最近邻——截图里的文字用
最近邻会断笔画，面积平均仍可读。③ `shrink` 三条放弃判据：不是 PNG / 长边本来没超
（**没缩小就不重编码**，重编码只会丢元数据）/ 缩完**不比原图小**（稀疏内容真的会
变大：实测一张「白底 + 28 行字」的 1200x800 图缩到 200 后反而从 5197 涨到 5655——
长平坦段被缩没了，而文字边缘的熵还在）。④ 压缩在**判定之前**跑：压完可能就不超限，
那这条请求就该正常走而不是被拒。⑤ 结果按**原图完整 data URI 的 sha1** 缓存
（LRU，上限按输出字节算，单条超过总容量就不进），命中即整条替换——会话历史每轮
都重发同一张图，没缓存等于每轮重算。缓存键**不含 maxEdge**，所以改参数后旧结果仍会
命中：界面在这个字段一变就顺手 `POST /system/image-cache/clear`，并给了独立入口。

**埋点**：`image_compressed`（这次真缩了几张）、`image_cached`（命中缓存几张）、
`image_bytes_before`、`image_skip`（为什么没缩：`not_png` / `undecodable_head` /
`shrunk_not_smaller_or_undecodable`）。**`image_compressed=0` 且字节数变小只有
「命中缓存」一种解释**，两个字段必须分开记，否则日志里判断不了压缩到底发生没有。

**验证**：新增 `test/unit/png.test.js` 8 项 + `test/unit/image-budget.test.js` 追加 6 项
（压缩/png 解编/缩放/缓存/JPEG 放行/压完放行/maxEdge 优先级）；全量 **823/823**；
`cd web && npm run build` 通过。**隔离网关 9123 真机**（无账号，压缩在可用性闸门之前）：

| 场景 | 结果 |
|---|---|
| 1.3MB 密集 PNG + `DUMATE_IMAGE_MAX_EDGE=200` + 单张上限 50KB | 缩到 27KB → **不再 413**（走到 503 没有账号），`image_compressed=1`，264ms |
| 同原图第二次 | `image_cached=1`，11ms，结果字节完全相同 |
| 去掉 maxEdge、只留 50KB 上限 | **413** 且文案报「第 1 张 1.3 MB > 51 KB」——对照证明压缩是那一步救回请求的 |
| 隔离管理端 9127 | `maxEdge` 默认 `default`、PUT 后 `panel`、`POST /image-cache/clear` 200、`maxEdge:-5` → 400 |

**顺带修掉的存量测试缺陷**：`test/unit/trae-fusion-gateway.test.js` 的「全部账号关闭
模型请求」会**随机失败**（本机 3 次中 1 次）。原因不是产品 bug：该用例与上一条用例
写同一个 accounts 文件，两次写落在同一毫秒时 `auth.js` 的 mtime 缓存不失效，读到上一条
的账号。修法是写完把 mtime 推远 2 秒（`fs.utimesSync`），比 sleep 确定。

### P1-7（同批，第一批）：自定义路由组——分发前按可用性择优

**要解决的问题**：同一个「对外模型名」在多条通道上都有等价能力，但**今天谁有号**是浮动的
（某通道没登录、账号全冷却、全站暂停）。客户端不该为此改配置。

**三条纪律**（比功能重要，都是本仓库踩过的静默故障形态）：
① **组名必须显式命中**——请求的 `model` 恰好等于组名才算，绝不猜名字。与 router「未知前缀
报错、不静默回落」同一条纪律：静默替换模型名会让客户端拿到「看起来成功、其实不是想要的东西」。
② **组名不带斜杠**——带斜杠会被通道前缀路由当成通道名（`qwen/xxx`），两套语义叠在同一个
字符串上必然出错，配置阶段就去掉。③ **成员不能再是组名**——A→B→A 是死循环，而配置错误只会在
请求到来时才暴露；校验一次做完，**坏文件整体按「没有组」处理**（路由表坏掉不能把网关带下去）。

**落在哪**：新 `src/route-groups.js` + `data/route-groups.json`（mtime 热读，与 keys/modelmap/livecfg
同一套纪律）。**故意不写进 `model-map.json`**：那张表管「模型名怎么改写成上游名」，组管「从哪条
通道走」；混进一个文件后 `mapModel` 的兜底会把组名安静地改写成 `model-text`——正是本仓库反复踩的
那类静默故障。文件形状：

```json
{ "groups": [ { "name": "fast", "members": ["qwen/pro", "traework/glm-5.2", "glm-5"] } ] }
```

**只有一个新函数**：`upstream-router.resolveWithGroup(model, {availability})`——命中组名就按成员
顺序查 `availability()`，挑第一个可用的；跳过的成员记下原因。四个协议入口把 `router.resolve`
换成它（4 行），其余逻辑一字未动。**第一批只做分发前的择优**：判定在分发之前，所以不存在
「响应已经开始写还要换成员」的危险路径；上游运行时失败后的跨成员重试要动翻译器收尾语义
（`res.headersSent` 恒 true、直连通道失败必须让翻译器收尾），留给第二批。
`availability` 可注入，纯粹为了能离线测——生产不传。

**状态码刻意不同**：成员全部不可用回 **503**（暂时性故障，客户端该退避重试）而不是 400。
依据是本仓库既有的 `availability` 语义（软冷却 → 429、其它 → 503）；组只是把这套原因**逐条**
报出来，不是新造一种判定。

**可观测**（三个出口回答三类人的问题）：客户端看 `X-Route-Group: fast 3/3`（头已发就跳过，
与 `X-Trae-Failover` 同一纪律）；排查的人看尝试链（`group:fast 跳过 qwen/pro: …` +
`group:fast→glm-5（第 3/3 个）`）；统计看请求日志的 `route_group` 字段。**失败时也记**——
全不可用时 `route_group = "fast 0/3"` 且尝试链带满三条跳过原因，否则那条 503 在日志里只剩一句
被截断的文本（attempts 上限 90 字符）。`/v1/models` 也列出组名（`owned_by: dumate-proxy`，
`route_group.members` 如实给出顺序）。

**管理端**：`GET /api/admin/route-groups` 返回**此刻**的择优结果（逐成员 `resolve` +
`availability`，与真实请求同一对函数，不另写判据）、以及配置里**被丢弃的条目和原因**
（手写文件的错别字只会在请求时才见效，这里当场报出来）。模型页新增「路由组」卡（只读）。
写入留给第二批：组的写入是「改路由表」，先把读数做出来。

**验证**：新增 `test/unit/route-groups.test.js` 12 项（坏形态逐条丢弃/重名/成环/超限/坏 JSON、
plan 大小写敏感、无组时与 `resolve` 逐字节一致、首个可用/跳过首个/错前缀跳过/全不可用 503/
availability 抛错按不可用、真实 availability 下的退化路径）；全量 **835/835**；
`cd web && npm run build` 通过。**隔离网关 9123 真机**（`data/route-groups.json` 含 `fast` 与一条
故意写错的 `a/b`）：

| 场景 | 结果 |
|---|---|
| `GET /v1/models` | 多出 `fast`（`name` 里带成员顺序），`a/b` 被拒不在列表 |
| 零账号请求 `fast` | **503** `route_group_unavailable: fast（1.qwen/pro: …；2.…；3.…）`，`X-Route-Group: fast 0/3`，尝试链 3 条 skip + gate |
| 普通模型 `glm-5` | 无组头、`route_group=''`——**无副作用**（回归锚） |
| `DUMATE_SOURCE=auto`（让 dumate 视为可用） | `X-Route-Group: fast 3/3` + `failover group:fast→glm-5（第 3/3 个）`；随后因 8980 没起回 502——**证明改派真的发生了** |
| 隔离管理端 9127 | `/route-groups` 逐成员 `ok/reason`、`chosen`、`dropped:[{name:'a/b', why:'组名不能含斜杠…'}]`；模型页卡渲染同样数据 |

### P1-7 第二批（同批）：运行时失败后的跨成员换人（**只对非流式**）

**判据只有一个：`res.headersSent === false`。** 换成员的安全边界不是「错误种类」，而是
「客户端有没有收到过字节」——收到过就不能换，否则客户端会看到两段拼接内容（翻译器路径
更糟：第二个 `response.created`）。

**接缝放在 `handleDirectChannel` 的 catch 里**（新增 `ctx.captureError`）：走到外层 catch
说明一个字节都没写出去，此时**不写响应**，把错误交给 `dispatchDirect` 决定换人还是收尾。
非流式与流式共用同一个外层 catch，但**流式走不到这里**（见下）。

**换成员时必须同步三样东西**，少一样就静默出错（都实测踩过）：
① `payload.model`——入口在分发前已经写成第一个成员的模型名，只换 route 会让第二次尝试
   仍带旧模型名打上游（实测：换人后错误还是「`__no_such_model__` 不在模型表中」）；
② `req._channel` / `req._mappedModel`——跨通道的组不换会让埋点记到上一个通道头上；
③ `req._routeGroup` 与 `X-Route-Group`——仍写 `1/N` 会让人以为走的还是第一个。

**尝试链不能被覆盖**：`handleDirectChannel` 原来每次都 `new` 一个 attempts 实例，换成员
再进函数会把上一次的 `failover` 判据冲掉（链里只剩最后一段）。改成**复用 `req._attempts`**。

**流式请求目前刻意不换成员**（实测结论，不是省事）：在流式分支的「首帧前失败」处也加过
同样的接缝，结果整条请求挂死——客户端 120s 超时、响应 0 字节，伴随 2~5s 的事件循环卡顿。
原因没查清（失败前已经建过 shim 并 pipe 到 res，换成员要重开 shim，谁持有 res 的收尾权说不清）。
**没查清就不上**：留一条明确的 400，比留一个偶发挂死好。

**验证**（用 2026-11-17 新加的真账号）：
`data/route-groups.json` 配 `rt: ["traework/__no_such_model__", "traework/Doubao-Seed-2.1-Turbo"]`，
普通对话请求 → 成员 1 在分发前 400（模型不在表里）→ **改派成员 2 成功**：
`HTTP 200 / 1.3~3.3s / 回复「收到」/ X-Route-Group: rt 2/2`，尝试链完整留
`failover group:rt→…（第 2/2 个；前一个失败：…）` + `picked` + `ok`。
流式同类请求：**0.02s 快速 400**（不复现挂死）。代码注释已写明「流式不换成员」的原因。

**未做**：① 组的**写入**接口与编辑界面（先做读数）；② 成员的权重/并行（不做——组是优先级表，
不是负载均衡器）；③ 流式路径的换成员（需先把「shim 收尾权」查清）。

### P2-13（同批）：用量补 TTFB 与命中率的分母口径

**两件事都属于「口径错了也不会报错」那一类**，所以判据写死在单测里。

**① TTFB 进分桶账本。** 以前只有 `/usage/overview` 现扫 `requests.jsonl` 算今日均值——
明细一滚（32MB 轮转）就没了，按月/趋势看不到。现在桶里累加 `样本数/和/min/max/>3s 计数/`
**8 段直方图**（250/500/1s/2s/5s/10s/30s），`finish()` 出 `ttfb_avg_ms / ttfb_samples /
ttfb_min_ms / ttfb_max_ms / ttfb_slow / ttfb_p50 / ttfb_p90`。
两条硬纪律：**分母只数「报了首字的请求」**（老日志没这个字段，当 0ms 算会把均值拉低——
最典型的假数字）；**无样本一律 null 不是 0**（`ttfb_avg_ms`/分位数都是 null，页面显示「—」）。
p50/p90 是**段上界的近似值**，`percentileOf` 同时回 `{ms, lo, hi}`，页面显示成
「≈ 1s（500–1s）」——近似值必须自带区间，否则读的人没法判断精度。

**② 命中率的分母剔掉缓存写入。** `cache_creation_input_tokens`（Anthropic 系第三段）
以前**根本没记进日志**，只在响应里回给客户端。现在 `reqlog.pickUsage` 认它（带
`creationReported` 区分「报了写入 0」与「这条协议没有写入概念」）、`logRequest` 落
`cache_creation_tokens` 与 `cache_creation_reported`、桶里累加 `cw/cwn`。
口径：`命中率 = 读命中 / (读命中 + 纯新输入)`，`纯新 = 非缓存输入 − 写入`。
理由：写入的 token 这一轮没被读过，算进分母等于把「预热轮」当成「没命中」，每加一段
前缀就凭空掉几个百分点。**分母 0 或窗口内没人上报缓存字段（`reported=0`）时是 null**——
「不上报」≠「全 miss」，显示成 0% 会让人去查一个不存在的问题。

**踩到的坑（新形态，已加回归守卫）**：桶的字段清单其实是**三份**——`addEntry` 造桶、
`mergeInto` 同键合并、`normalizeBucket` 从磁盘读回。前两处加了新字段、第三处没加的表现是
「种子数据写盘成功，管理端读回来 `ttfb_samples` 恒 0」。修完把 `normalizeBucket` 的注释
点明「这是第三份」，并加了一条走真实写盘/读盘的用例（`roundtrip.json`）。

顺带把桶合并收敛成**唯一实现 `mergeInto`**：原来 `addEntry` 与 `rollup`（小时桶折叠日桶）
各写一份累加，任何新字段只要漏一处就会出现「今天有、昨天没了」，且不报错。

**验证**：新增 `test/unit/usage-ttfb-hitrate.test.js` 9 项（直方图分段边界、分位数落段与
最后一段无上界、命中率剔写入/钳零/空分母 null、`pickUsage` 认写入并标 reported、
聚合分母只数有样本的请求、>3s 计数、**折叠成日桶后字段不丢**、**落盘重启后字段不丢**、
没人上报缓存时 rate=null）；全量 `node --test "test/unit/*.test.js"` **844/844**；
`cd web && npm run build` 通过。**隔离管理端 9127 真机**：喂 3 条（2 条带首字、1 条带
缓存三段）后 `GET /usage/agg?hours=24` 回
`ttfb_samples=2 / avg=2600 / min-max=700-4500 / slow=1 / p50=1000(500–1000) / p90=5000(2000–5000)`，
命中率 `800/3800=0.2105` 且 `cache_write_tokens=200`；分通道 `dumate reported=1 rate=0.2857`、
`qwenwork reported=0 rate=null`（不给缓存字段的通道如实显示不可知）。用量页新增
「首字延迟与缓存命中」卡（p50/p90/均值/>3s 占比 + 命中率/分子分母/写入/上报条数）。

**未做**：TTFB 与命中率的**逐模型/逐账号**展示（数据已在 `by_model`/`by_account` 行上，
只是页面还没开列）；per-key 维度（聚合桶里没有 key 维度，加它要动桶键，另开批）。

### P2-10（同批）：接入配置「写入前 diff 预览」

**为什么重要**：这套东西**直接改用户本机的配置文件**（`~/.claude/settings.json`、
`~/.codex/config.toml`）。有备份与还原，但「点写入之前会变成什么样」看不到，而合并规则
（env 深合并 / TOML 受管块替换）**对用户是不透明的**——改错了只能靠还原兜，
而还原是另一件需要理解的事。

**三条纪律**（第一条是本批的核心，其余是它的推论）：
① **预览与写入必须是同一份计算**。抽 `buildNext(p)` 出来，`apply` 与 `preview` 都调它；
两份实现必然漂移，而漂移的表现是「预览说没问题、写进去不是那样」——比没有预览更坏。
② **预览不碰磁盘**：不写配置、不建备份、不更新索引（备份是写入的副作用，不是预览的）。
③ **预览里密钥打码**：diff 会原样包含 token 行，明文回显等于把 key 送进浏览器历史与日志。
`maskSecret` 按长度决定打码方式——长值留后四位（便于核对是哪把 key），短值整段打掉
（留一半等于泄露一半）。

**实现**：`src/agent-setup.js` 新增 `diffLines`（行级 LCS，**没引 diff 库**：配置文件几 KB
用不着 Myers，而这个仓库的离线测试全靠零依赖）、`maskSecret`、`buildNext`、`preview`；
`apply` 改成调 `buildNext`（重构后行为不变，既有 `test/unit/agent-setup.test.js` 全绿即证据）。
`diffLines` 有三条边界：CRLF 归一、末尾换行不算一行（否则每份文件都多一条「假删除」）、
超过 1200 行只给统计不列明细（避免一次渲染上万行；LCS 的 DP 表也要有上限）。

**接口与界面**：`POST /api/admin/agent-setup/preview`（body 与 `/apply` 完全一致，审计只记
「谁预览了谁 + 行数」不记内容）；接入配置页的写入弹窗里加「预览将写入的差异」，
等宽滚动区里带行号与 `+/−` 前缀（**不能只靠颜色**——深色主题与色觉差异下都会失效），
幂等时明说「写入不会改动任何字节」。改了通道/Key 之后旧预览自动作废
（否则上一份 diff 会被当成这一份的真相）。

**验证**：新增 `test/unit/agent-setup-preview.test.js` 9 项（LCS 的增/删/改/CRLF/空文件/
超上限、打码三种长度、**预览零写入且不建备份目录**、**apply 写出的内容 === buildNext 的
`next`**、幂等时 `changed=false` 且 ops 为空、坏 JSON 如实抛错不静默当空文件）；
全量 `node --test "test/unit/*.test.js"` **853/853**；`cd web && npm run build` 通过。
**隔离管理端 9127 真机**（`HOME` 指向临时目录，不碰真机 `~/.claude`）：首次预览
`changed=true / exists=false / +18 行`、token 显示 `••••1234` 且响应里无明文、
**预览后 `/tmp/…/.claude` 与备份目录都不存在**；`/apply` 写入 858 字节后再次预览
`changed=false / ops=[] / note=幂等`；第二次 `/apply` 产生备份文件；未登录 401、非法
client 400。

**未做**：cc-switch 那条写入路径（`/api/admin/cc-switch/*`）也值得同款预览——它的合并
规则比这两家都复杂，但端点与前端是另一处，留作后续；预览的「一键采纳差异」不做
（我们只让用户看清楚，不做逐行挑选——那会变成半个编辑器）。

### P2-12（同批）：看板自动刷新 + 阅读模式

**问题**：挂看板（第二个显示器/投影）时全靠手点刷新；数字一多也不适合远看。

**自动刷新的四个决定**（都在 `web/src/stores/ui.ts`）：
① **一个共享定时器**，不是每页各开一个 `setInterval`——十几个页面各持定时器时，
切页与后台标签都会各打各的接口，而它们打的是同一批 API。
② **页面不可见时不刷**（`document.visibilityState`）。挂一夜的看板不该白打几万次请求，
而且这些请求会写进请求日志与用量分桶——那是在**污染统计**。
③ 同一个回调**单飞**：上一轮没回来就跳过这一轮，慢接口不堆积成雪崩。
④ 回调抛错**只记不炸**：一个页面的接口坏了不能让定时器停摆（否则「刷新还在跑」这种
假象更难查）。间隔（关 / 10s / 30s / 1m / 5m）与「不自动刷新」是同一份常量，
状态落 `localStorage`，跨页与刷新后保留。
页面侧一行接入：`useAutoRefresh(load)` —— 内部用 `onUnmounted` 自动注销，
这就是「页面卸载后定时器还在打接口」那个坑的解法（手写注册很容易忘掉注销）。
已接：仪表盘 / 请求日志 / 用量统计 / 运维告警。

**阅读模式只改排版，不隐藏任何数据**：侧栏收起（此模式下不给折叠按钮，避免「按了没反应」）、
内容字号 15px、`.num`（全站数字）放大 1.12em、表格行距放宽。
**刻意没做**的是「为了清爽把次要列/提示藏起来」——这个仓库的纪律是每个事实必须可观测，
看板上少的那一列就是下一次排障时的盲点。

**验证**：`cd web && npm run build` 通过（`MainLayout` 5.29 kB CSS / 30.92 kB JS，
产物里含「阅读模式 / 自动刷新」文案）。**未做真机界面核对**：本会话没有浏览器，
按仓库纪律这一条本该用截图确认可见性（历史上吃过「接口 200、界面无感」的亏）——
留给下次在真实浏览器里点一遍：切换间隔后看 Network 是否按间隔发请求、
切到后台标签是否停、阅读模式是否只放大不藏列。

### P2-11（同批）：会话粘性键含 system

**症状**：`channel-pool.sessionKeyOf` 只看「首条 user 消息」的指纹。两个项目都用一句
「继续」开场时，**system 不同却撞同一个粘性键**——两条长会话被绑到同一个账号上，
前一秒还在 A 项目上下文里，后一秒被塞进 B 项目的前缀缓存：命中率与上下文恢复成本
双双恶化，而日志上什么都看不出来。

**做法**：键 = `sha1(system 全文 + \u0000 + 首条 user 前 2048 字)`（`m:` 前缀不变，
显式 `opts.sessionKey` 仍是 `k:` 且优先）。三个细节都是有依据的：
① **system 取全文不截断**——项目约定常追加在尾部，截断会把「改过的 system」认成
同一个；user 侧仍截 2048（既有稳定锚点）。
② **拼接 parts 用空串不用换行**：`[{text:'同一段'},{text:'话'}]` 与 `'同一段话'` 是同一段
话的两种编码，键必须一致，否则同一段 system 经不同协议/客户端进来会分裂成两个键
（粘性等于没做）。指纹只用于本地选号，不需要保留换行语义。
③ **两种协议同一个口径**：Anthropic 入口的 system 在顶层 `system`，OpenAI 入口在
`messages` 里 role=system 的第一条——`systemTextOf` 两处都认，否则同一段话跨协议会分键。

**为什么这次换键不会打断在跑的会话**（三条都实测过）：
① 本机**没有任何网关在跑**（9080/9082/9083/9084/8980 全无监听），`data/requests.jsonl`
49 行、最新一条在 40 小时前、近 24 小时 0 条——没有在用的长对话；
② 粘性绑定**只在内存**（`sticky.js`），进程重启即清空，所以「换键」本身不需要迁移；
③ 改动只在主目录，**`stable/` 快照一行没动**——9080 的对外服务不受影响，要发布才会同步。
两个协议都**每轮重发** system（Claude Code 顶层 `system`、Codex 在 messages 里），
所以同一会话的 system 在轮次之间稳定，键也稳定。

**验证**：新增 `test/unit/session-key-system.test.js` 8 项（不同 system 不同键、同会话
追加 20 轮键不变、system 三种形状等价、无 system 也出键且与有 system 不同、system 尾部
不同必须区分、显式 sessionKey 优先、取不到 user 时不粘、**端到端**「A 项目粘回同一个号
且 B 项目不串号」）；全量 `node --test "test/unit/*.test.js"` **861/861**；四通道修复回归
全绿（千问 39 / Qoder 36 / WorkBuddy 43 / TRAE 40）。

**已知缺口（下一批）**：**会话键没进请求日志**，所以「这条会话为什么换号」目前只能靠
账号列前后对比，不能按会话分组看。加上它要改 4 个 provider 的埋点，单独一批做。

**顺带核到的存量问题**：`test/integration.test.js` 的「qwenwork.send 端到端（假上游）：
失败账号进冷却、故障转移换号成功」**在干净 HEAD 上同样失败**（用 `git worktree` 复现），
不是本轮引入；同一个文件里的「keepalive 管理面」那条在 HEAD 失败、现在已通过。

### P2-11 补批：会话键进请求日志（补上一批留下的缺口）

**为什么要补**：上一批换了键的口径，但键**没进日志**——「这条会话为什么换号」只能靠
账号列前后对比，看不出两行是不是同一个会话。这是我自己在上一批写下的已知缺口，本批收口。

**做法**：① `channel-pool.sessionKeyFor(payload, opts)` = `sessionKeyOf` + 顺手通知
`opts.onSessionKey(key)`。**键的产生与上报绑在同一个函数里**——让 5 个调用点各自记得回调，
迟早漏一个，而漏了的表现是「某些通道的会话键恒空」且不报错。回调抛错一律吞掉（埋点不能
影响选号），取不到键（无首条 user）**不回调**（否则每行都写一个空值）。
② 5 个调用点（qoder / traework / workbuddy / qwenwork / qwenwork-acp）全部改走它。
③ 网关在 `handleDirectChannel` 的 `providerOpts` 里挂 `onSessionKey` → `req._sessionKey`，
`logRequest` 写 `session_key`；前端请求日志详情抽屉显示「会话键」（顺带把上一批的
`route_group` 也补进类型与抽屉，之前只落了日志没进类型）。

**踩的坑（值得记）**：我一开始用正则 `const providerOpts = \{([\s\S]*?)\n  \};` 去定位
插入点，而 `providerOpts` 是**单行对象字面量**，正则一路吃到了后面 `forwardToUpstream` 的
`options` 块，把 `onSessionKey,` 插进了 `headers` 里 → `node --check` 立刻报错。
`const X = {…};` 这种形状**不能按 `\n};` 收尾去猜**：确切的改法是用完整的单行串做锚点
（或按行号定位）。

**验证**：`session-key-system.test.js` 加 1 项（`sessionKeyFor`：键不变、回调拿到同一个键、
回调抛错不影响返回、无回调照常出键、空键不回调）；`verify-traework-repair.js` 加 2 条断言
（provider 真的回调、且同一会话两轮同一个键）——42 passed。
全量 `node --test "test/unit/*.test.js"` **862/862**；`cd web && npm run build` 通过。
**隔离网关 9123 真机**（假 Qoder 账号，`FIRST_BYTE_MS=1500` 让它快速失败，不真打外网）：

| 请求 | 结果 |
|---|---|
| 同 system + 同首条 user（连发 3 次） | `session_key` 三条完全相同 `m:9b3c2742…` ✓ |
| 同 user、**不同 system** | `m:4c094fcd…` —— 与前三条不同 ✓（这正是本项要修的串号） |
| 同会话**追加两轮消息** | 仍是 `m:9b3c2742…` ✓（键只认首条 user + system） |
| 每一行 | `session_key` 都非空且以 `m:` 开头 ✓ |

**未做**：按会话键**筛选/分组**的前端界面（现在只有详情抽屉里的只读展示）。要按会话聚合
请求，得在 `reqlogs` 读路径上加过滤参数并写聚合，单独一批更干净。
