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
   - **keepalive 加 workbuddy adapter**（refresh/balance/checkin）：国内号每日
     低峰自动续期+签到+余额快照；国际版 checkin 如实 unsupported，不假装成功。
   - **重要口径：国内 CLI 对话当前不实时扣套餐**——连打多次请求
     `totalPrecise` 纹丝不动（11288.98），与 `usage.credit=0` 一致（公测/
     活动口径）。计费探针 `delta=null` 是**真实测量结果**，警告已写实
     （「不实时扣套餐…非故障」）；FEFO 的临期优先仍然有意义（包会到期作废）。
   - 离线：`workbuddy-billing` 13 项（真机夹具）、`expiring-fefo` workbuddy
     窗口、`verify-expiring-fefo.js` workbuddy 段（8 项全绿）。
