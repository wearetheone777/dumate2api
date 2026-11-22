# GitHub TRAE 生态最新功能检索 → 本项目可融合项（2026-11-16）

> **口径**：GitHub 上 TRAE 相关仓库在 **2026-10-15 ~ 2026-11-16** 发布的新功能
> （release notes + commit + **已取到的 README/文档正文** 为证据），逐条对照本仓库现有实现。
> **已按你的要求剔除「企业版 / 组织形态」内容**（清单与上游真实标识见 §8）。
> **重点覆盖管理端前端页面**（页面级清单见 §9）。
>
> 与既有调研的分工：`docs/TRAE-GATEWAY-MERGE-FEATURES.md`（2026-11-07，20 项）已落地，
> 见 `docs/TRAE-FUSION-CHECKPOINT-2026-11-08.md`；**本文件只列那批之后新出现、且当前仓库确实没有的**。

---

## 0. 结论摘要

**13 项值得融合**（4 项 P0 / 5 项 P1 / 4 项 P2），**9 类明确不融合/不适用**，**企业版内容整体剔除**。

| 优先 | 项 | 一句话 | 主要落点 |
|---|---|---|---|
| **P0-1 ✅** | 模型目录缓存五维分桶 + 冷读单飞 | **已落地 2026-11-16**：同区多账号不再互相污染能力判定 | `src/traework/models-cache.js` + `models.js` |
| **P0-4 ✅** | 每模型默认思考档 + 未应用如实标记 | **已落地 2026-11-16**：客户端优先 / 无 descriptor 不套 / 只向下钳 | `src/reasoning-apply.js` + `trae-runtime.defaultReasoning` |
| **P0-3 ✅** | 凭证被拒不重放 + 冷却隔离 + 单号人工恢复 | **已落地 2026-11-16**：403 不再一律进熔断；裸 403 保持原判定（Qoder 实测 403 也表达额度）；跨区容灾默认关 | `upstream-errors.js` + `traework/failover.js` + `/accounts/:id/recover` |
| **P0-2a ✅** | 登录本机回环自动回调 + state 单次消费 | **已落地 2026-11-16**：接住回调自动入库，state 单次消费、可取消、10 分钟到期 | `src/traework/oauth-callback.js` + 账号页 |
| P0-2b 授权码 + PKCE | 🟡 **2026-11-17 真机探明契约，卡在 DeviceProof** | 纯计算已落地：`newPkce`（RFC 7636 向量校验）/`buildAuthCodeUrl`（只追加两参）/`parseAuthCodeCallback`（三种编码形态）；真机结论：**CN 授权页支持 PKCE**（回调只给 `authCodeInfo.AuthCode`，10 分钟单次）→ 换票端点 `POST /trae/api/v3/oauth/ExchangeToken`（**不是** `/cloudide/...`）→ `DeviceInfo` 必须是 **P-256 JWK**（传 base64 SPKI 报 `expected map`）→ `DeviceProof` 也必须是 map，内层结构未知 → `20405 Device proof required`。继续需静态分析新版客户端或枚举形状（会消耗单次码）。优先级低：现有 refreshToken 流程真机可用 |
| P0-3 | 认证拒绝不重放 + 冷却隔离 + 单号人工恢复 | 401/403 不该换号重打；模型级冷却别升级成全号冷却 | `channel-pool` / `upstream-errors` |
| P0-4 | 每模型「默认思考档」+「未应用档位如实标记」 | 现在只有档位归一化，没有按模型的默认值 | `trae-runtime` / 新 `reasoning-apply` |
| **P1-5 ✅** | 请求尝试链（只存判据不存报文） | **已落地 2026-11-16**：picked/skip/error/ok/failover 时间轴；闸门拒绝也落日志 | `src/attempts.js` + `reqlog` + 请求日志页 |
| P1-6 | 会话图片压缩（先做零依赖降级版） | 大 base64 图直接打上游，上下文被图片吃满 | `src/images.js` |
| P1-7 路由组 | ✅ **2026-11-17 两批落地（流式换成员刻意不做）** | 第一批：`route-groups.js` + `resolveWithGroup`（显式命中 + 分发前按可用性择优）+ `X-Route-Group` / 尝试链 / 请求日志 / 管理端只读；第二批：`dispatchDirect` 组内**运行时换成员**（`ctx.captureError` 接缝，判据 `res.headersSent === false`），换人时同步 `payload.model`/`_channel`/`_mappedModel`/`_routeGroup`，attempts 实例改成复用（否则 failover 判据被冲掉）。**流式换成员未做**：加上接缝后整条请求挂死（0 字节 + 事件循环卡顿），原因未查清。真账号验证：成员 1 失败 → 改派成员 2 → 200「收到」；`route-groups.test.js` 13 项；全量 866/866 |
| **P1-8 ✅** | 签到补签（睡眠唤醒补跑） | **已落地 2026-11-16**：错过时刻会立刻补跑一次并幂等；另有可见的「今日还差谁」 | `src/traework/makeup.js` + `autotask` + `/checkin/makeup` |
| P1-9 | 账号级风控参数上台（并发/间隔/短故障重试） | 现在只在环境变量里，改一次要重启 | `trae-runtime` + 运行策略页 |
| P2-10 接入配置写入前 diff 预览 | ✅ **2026-11-16 已落地** | `agent-setup.js` 抽 `buildNext`（apply/preview **同一份计算**）+ `diffLines`（零依赖行级 LCS，CRLF/末尾换行/1200 行上限）+ `maskSecret`（长值留后四位、短值整段）+ `POST /agent-setup/preview`（不改文件、不建备份）+ 写入弹窗内差异视图（行号 + `+/−` 前缀，不只靠颜色）；`agent-setup-preview.test.js` 9 项；全量 853/853；9127 真机（HOME 指临时目录）预览零写入、写后幂等、401/400 校验。**未做**：cc-switch 写入路径的同款预览 |
| P2-11 会话指纹含 system + 进日志 | ✅ **2026-11-16 已落地（两小批）** | 键 = `sha1(system 全文 + 首条 user 2048 字)`；`sessionKeyFor` 把「算键」与「回传 `opts.onSessionKey`」绑在一处（5 个 provider 全改）；网关落 `session_key` 到请求日志、前端详情抽屉显示（顺带补 `route_group`）；`session-key-system.test.js` 9 项 + TRAE 接线 2 条断言；全量 862/862；9123 真机（假 Qoder 号）实测「同 system 三次同键 / 不同 system 不同键 / 追加轮次键不变」。**未做**：按会话键筛选与分组的界面 |
| P2-12 页面自动刷新 + 阅读模式 | ✅ **2026-11-16 已落地** | `web/src/stores/ui.ts`：**共享定时器**（不是每页一个）+ 页面不可见不刷（不污染请求日志与用量分桶）+ 同回调单飞 + 抛错不炸 + 间隔持久化；`useAutoRefresh(fn)` 随卸载自动注销，已接仪表盘/请求日志/用量/告警。阅读模式只改排版（侧栏收起、字号与 `.num` 放大），**不隐藏数据**。验证：类型检查 + 构建通过、产物文案核对；**未做真机界面核对**（本会话无浏览器） |
| P2-13 用量 TTFB 与命中率分母 | ✅ **2026-11-16 已落地** | `usage-agg` 加 TTFB（样本/和/min/max/>3s/8 段直方图 → avg+p50+p90，无样本 null）+ 缓存写入 `cache_creation_tokens`（`reqlog.pickUsage` 认 Anthropic 第三段）+ 命中率 `读命中/(读命中+非缓存输入−写入)`、`reported=0` 时 null；桶合并收敛成唯一 `mergeInto`（第三份字段清单 `normalizeBucket` 踩过，已加读写盘回归守卫）+ 用量页「首字延迟与缓存命中」卡；`usage-ttfb-hitrate.test.js` 9 项；全量 844/844；9127 真机种子数据全字段可见 | `usage-agg` + 用量页 |

---

## 1. 取数通道：GitHub 网络问题的定位与修复（本轮先做的事）

### 1.1 症状

第一轮所有正文拉取一律失败，且**不是超时而是 TLS 断开**：

```
$ curl -sv -m 8 https://raw.githubusercontent.com/ | grep -E "Connected|SSL|HTTP"
* Trying [2606:50c0:8002::154]:443...
* Connected to raw.githubusercontent.com (2606:50c0:8002::154) port 443
* OpenSSL SSL_connect: Connection reset by peer in connection to raw.githubusercontent.com:443
```

### 1.2 定位

| 主机 | DNS | TCP 443 | TLS | 结论 |
|---|---|---|---|---|
| `api.github.com` | 20.205.243.168（有 A 记录） | 通 | **通** | 唯一可用 |
| `github.com` | 20.205.243.166 | 不稳 | 时通时断 | 不可依赖 |
| `raw.githubusercontent.com` | 解析先给 **AAAA**（`2606:50c0:*`）；`ahostsv4` 有 `185.199.108-111.133` | 「通」 | **RST**（IPv6 与 IPv4 都 RST） | 封 |
| `cdn.jsdelivr.net` | `2606:4700:*` / `104.16.x` | 通 | RST | 封 |
| `data.jsdelivr.com` | 有 A | 通 | 通 | **可用**（只出文件树，不出正文） |

即：**不是本地 DNS 错、不是本机没网**，是 `raw.githubusercontent.com` 与 jsDelivr 的
TLS 被重置；`api.github.com` 这条 Azure 落点通，但匿名额度只有 **60 次/小时**，第一轮
42 次元数据调用 + 正文调用就把它打空了（`core remaining 0/60`）。

### 1.3 修复：三条镜像通道，按「不耗额度优先」排序

实测（同一份 `README.md`，14006 字节）：

| 通道 | 结果 |
|---|---|
| `https://gh-proxy.com/<完整 raw URL>` | **200**，14006 |
| `https://ghproxy.net/<完整 raw URL>` | **200**，14006 |
| `https://gcore.jsdelivr.net/gh/<o>/<r>@<branch>/<path>` | **200**，14006 |
| `ghfast.top` / `github.moeyy.xyz` / `raw.gitmirror.com` / `cdn.statically.io` / `r.jina.ai` | 000 |
| `fastly.jsdelivr.net` | 301（要跟随跳转） |

固化成一个脚本，以后不用再试错：

```bash
# 取正文（依次试 jsDelivr → gh-proxy → ghproxy.net → 官方 API base64）
./scripts/gh-fetch.sh file shuishuipingan/trae2api-hub docs/OAUTH.md /tmp/hub_OAUTH.md

# 列出仓库全部文件（走 data.jsdelivr.com，能发现 docs/ 下有哪些设计文档）
./scripts/gh-fetch.sh tree autumnsentiment/Trae2api-cn | grep '\.md$'

# 直接给 raw URL 也行
./scripts/gh-fetch.sh url https://raw.githubusercontent.com/<o>/<r>/main/README.md /tmp/r.md
```

**本轮结果**：10 个仓库的 README + `hub/docs/OAUTH.md` + `hub/CHANGELOG.md` +
`240xu/docs/PORTING.md` 全部取回（共 ~300 KB）。下面所有结论都以这些正文为依据，
不再有「未取到证据」的推断项。

> 附带发现：`hub` 当前分支树里**没有** `docs/OAUTH.md`（只有 `docs/img/*.png`），
> 该文件存在于 **tag `v1.6.0`** —— 所以取文档要能指定 tag：
> `https://gcore.jsdelivr.net/gh/shuishuipingan/trae2api-hub@v1.6.0/docs/OAUTH.md`。
> 「按 `main` 取不到就当没有」会误判成「上游没写文档」。

---

## 2. 检索方法与证据边界

| 项 | 内容 |
|---|---|
| 检索时间 | 2026-11-16 |
| 功能时间窗 | 2026-10-15 ~ 2026-11-16 |
| 元数据 | GitHub REST `/repos` `/releases` `/commits`（14 仓库，42 次调用，额度已耗尽） |
| 正文 | jsDelivr / gh-proxy 镜像（§1.3），10 份 README + 4 份专项文档 |
| 仍未取得 | 各仓库**源码实现**（只读了文档与 release notes，没有逐行对照其代码） |
| 写作纪律 | 文档没写的细节一律标「待真机核对」，不拿别家的字段名当我们的结论 |

---

## 3. 检索到的仓库（按最近活跃排序）

| 仓库 | ⭐ | 语言 | 最近 push | 窗口内版本 | 定位 | 相关度 |
|---|---|---|---|---|---|---|
| [aimod-cc/Agent2API](https://github.com/aimod-cc/Agent2API) | 2316 | Rust | 2026-11-09 | v3.5.0-beta.1 / 3.4.2 / 3.4.0 | 50+ 客户端统一路由网关，管理面板最全 | ★★★（管理端） |
| [smart-open/TraeWorkAssistant](https://github.com/smart-open/TraeWorkAssistant) | 483 | Rust/TS | 2026-11-11 | v3.9.3 / 3.9.2 / 3.9.1 | 五应用多账号桌面工作台 + 网关 | ★★★ |
| [NextAgentX/qoder-trae-workbuddy-switch](https://github.com/NextAgentX/qoder-trae-workbuddy-switch) | 383 | Rust | **2026-11-14** | v2026.11.141713 / 141118 / 131828 / 131448 | 三产品账号切换 + 网关（**本窗口最新**） | ★★★ |
| [autumnsentiment/Trae2api-cn](https://github.com/autumnsentiment/Trae2api-cn) | 110 | Python | 2026-11-05 | v1.0.11 / 1.0.10 / 1.0.9 | Trae CN 四端点反代，协议细节最深 | ★★★ |
| [shuishuipingan/trae2api-hub](https://github.com/shuishuipingan/trae2api-hub) | 54 | Python | 2026-11-11 | v1.6.0 / 1.5.1 / 1.5.0 / 1.4.3 | 双区多账号网关 + 图形看板 | ★★★ |
| [XCool-603/trae2api](https://github.com/XCool-603/trae2api) | 10 | Go | 2026-11-09 | v0.2.6 / 0.2.5 | 双域融合网关 + Web 控制台 | ★★ |
| [connectedGraph/trae2api-web](https://github.com/connectedGraph/trae2api-web) | 55 | Go | 2026-10-11 | 无 release | SOLO 反代 + 内置面板 | ★★ |
| [JeffHu0912/trae2api](https://github.com/JeffHu0912/trae2api) | 59 | Go | 2026-09-08 | 无 release | SOLO 反代 + 加权防惊群 | ★（窗口外） |
| [240xu/trae2api-more](https://github.com/240xu/trae2api-more) | 3 | Go | 2026-09-12 | 无 release | trae2api-web 衍生，有逐行为对照文档 | ★（窗口外） |
| [wangqi233/trae2api](https://github.com/wangqi233/trae2api) | 12 | TS | 2026-09-20 | 无 release | 双区多账号 OpenAI/Anthropic | ★（窗口外） |
| [ZedeX/trae-local-api](https://github.com/ZedeX/trae-local-api) | 84 | JS | 2026-07-07 | 无 release | IDE → 本地 API + 会话式 Web 门户 | ★（窗口外） |
| [A-23187/trae-api](https://github.com/A-23187/trae-api) | 172 | Python | 2026-06-22 | 无 release | 内置模型转 OpenAI（早期） | – |
| [linqiu919/trae2api](https://github.com/linqiu919/trae2api) | 39 | Go | 2025-06-27 | v1.1.3 | **已归档** | – |
| [bytedance/trae-agent](https://github.com/bytedance/trae-agent) | 12202 | Python | 2026-02-05 | 无 release | 官方 agent 框架（非网关形态） | – |

---

## 4. 窗口内的新功能清点（含引文）

### 4.1 NextAgentX/qoder-trae-workbuddy-switch（2026-11-14，最新）

来源：[v2026.11.141713](https://github.com/NextAgentX/qoder-trae-workbuddy-switch/releases/tag/v2026.11.141713)、
[v2026.11.131448](https://github.com/NextAgentX/qoder-trae-workbuddy-switch/releases/tag/v2026.11.131448)、
[v2026.11.110949](https://github.com/NextAgentX/qoder-trae-workbuddy-switch/releases/tag/v2026.11.110949)

| 功能 | 机制 | 本项目对照 |
|---|---|---|
| Responses 状态链 | 按「产品线 + 区域 + API Key + 客户端会话身份（不可逆指纹）」隔离；缺会话身份时**只有该 `previous_response_id` 在当前范围唯一才继承**；命中续期、LRU 淘汰、输入历史预算 256 KiB | 我们故意不存状态（见 §10） |
| 缓存命中语义 | 区分「上游没上报」与「明确未命中」 | **已具备**（`cachedReported` + `confirmedZero`） |
| 会话→账号绑定 | 无会话头时用 **system + 首条 user** 内容指纹绑号 | 仅首条 user → **P2-11** |
| 账号终态处置 | 认证拒绝/限流/排队/余额耗尽**不自动换号**，原样返回；被拒账号进冷却，其它不受牵连 | 取「认证拒绝不重放 + 冷却隔离」→ **P0-3** |
| 三平台风控设置 | 按平台/区域配速率、账号并发、全局并发、账号间隔、短故障重试、限流冷却；状态独立保存；**提供人工恢复入口** | 仅 env → **P1-9**；单号恢复 → **P0-3** |
| 按模型默认思考档 | **客户端未指定时**才套默认值；客户端明确传入的保留；非支持模型不发字段 | 缺 → **P0-4** |
| 计划任务睡眠唤醒补跑 | 睡眠错过执行点后补跑（issue #175，v3.9.2 同款） | 缺 → **P1-8** |

### 4.2 aimod-cc/Agent2API

来源：[v3.5.0-beta.1](https://github.com/aimod-cc/Agent2API/releases/tag/v3.5.0-beta.1)、
[v3.4.2](https://github.com/aimod-cc/Agent2API/releases/tag/v3.4.2)、
[v3.4.0](https://github.com/aimod-cc/Agent2API/releases/tag/v3.4.0)、
[v3.3.0-beta.6](https://github.com/aimod-cc/Agent2API/releases/tag/v3.3.0-beta.6)

| 功能 | 机制 | 本项目对照 |
|---|---|---|
| 会话图片压缩（3.4.0） | 转发前把内联 base64 大图缩长边并重编码，**同一原图复用结果**；默认开，参数可调 | 缺（`images.js` 只转形状）→ **P1-6** |
| 自定义路由组（3.4.2） | 多提供商/模型组合成一个对外模型 ID，配成员、顺序、失败后备选 | 缺 → **P1-7** |
| 请求回放（3.4.2） | 按请求快照展示**尝试/切换/跳过原因**，区分首帧与响应到达 | 缺尝试链 → **P1-5** |
| 客户端识别（3.4.2） | 内置 + 自定义规则 + 来源声明，报表展示 | 可选，收益低（§10） |
| 工具服务页（3.4.1） | 搜索 + 视觉，Skill/MCP/API 三接入 | 端点已有，缺管理端试验页 |
| 临期凭证与模型目录自动维护、批量刷新（3.5.0） | 账号列表批量刷新 | 预刷新已有；「批量刷新」可用既有 `accounts/batch probe` |
| 页面自动刷新 / 阅读模式（3.5.0） | 前端 UX | 缺 → **P2-12** |
| 接入多配置 + **写入前预览**（3.5.0） | 写入前预览并自动备份 | 备份有、预览缺 → **P2-10** |
| 整库加密备份 `.a2ab`（3.3.0） | 含账号/Key/云同步凭据，12 位密码 | **剔除**（§8） |
| 签到定时补签 / 活动窗口重试 / 计划按时刻分组（3.3.0） | 补签只补当天未签到账号 | 缺 → **P1-8** |

### 4.3 shuishuipingan/trae2api-hub（2026-11-11）—— OAuth 有完整文档

来源：[v1.6.0](https://github.com/shuishuipingan/trae2api-hub/releases/tag/v1.6.0)、
[`docs/OAUTH.md` @v1.6.0](https://github.com/shuishuipingan/trae2api-hub/blob/v1.6.0/docs/OAUTH.md)

**这篇文档是本轮最有价值的一份**：它把「浏览器 OAuth」从「大概这么做」变成了可核对的协议事实。

引文（协议依据）：

> 国际版官方桌面客户端静态代码证据：版本 1.107.1、tronBuildVersion 2.3.93439;产品配置中
> stable IDE client_id 为 `ono9krqynydwx5`。授权 URL 使用 `/authorization`、
> `login_channel=native_ide`、`auth_callback_url`、`login_trace_id`、`code_challenge` 和 S256。
> 授权码来自 `authCodeInfo` JSON 的 `AuthCode`，verifier 留在本地。
>
> 交换接口为官方账号主机下 `/trae/api/v3/oauth/ExchangeToken`，请求体 `ClientID`、`AuthCode`、
> `CodeVerifier`、`DeviceInfo`（P-256 SPKI 公钥）与 `IDEVersion`；`x-cloudide-token` 为空。
> 无可信 UID 时通过带令牌的 `/cloudide/api/v3/trae/GetUserInfo` 获取；不信任回调 query 的
> `userInfo` UID，也不把未验签 JWT 解析当身份验证。

引文（面板契约）：

| 方法 | 路径 | 要点 |
|---|---|---|
| POST | `/accounts/login/start` | `{"realm":"cn"|"intl"}` → `state / authorization_url / redirect_uri / expires_at / interval` |
| GET | `/accounts/login/poll?state=` | `pending / exchanging / success / failed / expired / cancelled / not_found`；**不返回**令牌、verifier、私钥 |
| POST | `/accounts/login/cancel` | `{"state"}` |
| POST | `/accounts/login/callback` | `{"state","callback_url"}`；**只接受当前会话的回环地址、端口、路径及 trace** |

其余可执行要点：

- 本机回调由**独立、仅绑 `127.0.0.1`** 的监听器处理，单次 trace/PKCE 会话负责关联；
- 远程浏览器/容器：粘贴完整回调 URL，**不能用另一场授权去粘上一场的回调**；
- 会话 **10 分钟**到期，失败后重新发起，旧回调不可复用；
- 「这不是 device-code flow；没有用户码或设备码」——与我们既有结论一致（别再试）；
- 交换与用户信息只走各区域官方主机精确白名单，**跨区/带凭据/非 443 一律拒绝**；
- 身份只认 `ExchangeToken` 或带令牌的 `GetUserInfo`；**不解析未验签 JWT 当身份**；
- 凭证**先原子落盘再报成功**，写盘失败不污染内存账号池；
- 诚实边界：**国内版授权域没有本地 product.json**，靠交叉证据；**未用真实账号完成官方授权**，
  CN/INTL/企业分支的实际登录结果以用户操作为准。

#### 4.3.1 与我们现有登录实现的差异（关键，决定 P0-2 怎么拆）

| 维度 | 我们（`src/traework/login.js`，2026-11-03 真机验证过） | hub（INTL 客户端 1.107.1 静态证据） |
|---|---|---|
| 授权参数 | `login_channel=native_ide`、`auth_type=local`、`auth_callback_url`、`login_trace_id`(16 hex)、`x_device_*`/`x_app_*` | 同 + **`code_challenge`（S256）** |
| 回调产物 | `refreshToken` + `userInfo{UserID,ScreenName,TenantID}` + `userJwt`（+ `host`/`userRegion`） | `authCodeInfo.AuthCode`（verifier 留在本地） |
| 换票契约 | 账号主机 `EP_EXCHANGE`，body `ClientID / RefreshToken / ClientSecret='-' / UserID=''` | 账号主机 `/trae/api/v3/oauth/ExchangeToken`，body `ClientID / AuthCode / CodeVerifier / DeviceInfo(P-256 SPKI) / IDEVersion` |
| 身份校验 | 回调 `userInfo.UserID`，缺失时用 JWT 的 `data.id` | `GetUserInfo`（带令牌）为唯一可信来源，**不信任回调 UID / 不解析未验签 JWT** |
| 本机回调 | **不监听**，固定 `127.0.0.1:18080`，用户手抄 | 随机端口回环监听 + `state` 单次消费 + 10 分钟到期 + 可取消 |
| `login_trace_id` 校验 | **只生成，回调侧不校验** | 必须回显且一致，重放拒绝 |

**结论（也是最重要的一条）**：PKCE **不是给我们现有 URL 加两个参数**的事——它连着
**另一套换票请求体**（`AuthCode`+`CodeVerifier`+`DeviceInfo`）。只加 `code_challenge`
不换交换契约，等于把登录打挂（本项目历史上已经踩过「标准 OAuth 参数被判非法客户端、
页面永远卡在认证中」）。所以拆成：

- **P0-2a（低风险、立即收益）**：本机回环自动回调 + `state` 单次消费 + 取消/到期 + 远程粘贴；
  **换票契约不动**（继续用 refreshToken 流程），失败仍可回落手贴。
- **P0-2b（独立评估）**：授权码 + PKCE 全链路。它的收益是「与新版客户端一致、未来 refreshToken
  流程若被关停仍有路」，成本是**新的换票契约 + P-256 设备公钥 + 真机验证**。
  进入条件：先在隔离实例上用真账号跑通一次 `ExchangeToken(AuthCode)`，拿到 200 与 Token；
  拿不到就不写代码（同 `docs/CHANNEL-*` 的「没证据不猜 header」纪律）。

### 4.4 autumnsentiment/Trae2api-cn（2026-11-05）

来源：[v1.0.11](https://github.com/autumnsentiment/Trae2api-cn/releases/tag/v1.0.11) 与 README

| 功能 | 引文要点 | 本项目对照 |
|---|---|---|
| 模型目录缓存隔离 | 「模型目录缓存按**账号、Agent/Work 档位、原生 `raw_chat_function`、网关与客户端身份参数**隔离；同一范围的并发冷读取共享一次上游请求」 | 我们只按 region → **P0-1** |
| 缓存明细缺失补查 | 「Remote 与旧版 `llm_utils_chat` 的缓存明细缺失或全零时，用本次账号和已验证的账单 ID 查询商业账单；**输入 token 总数必须精确匹配**，旧端还需匹配输出总数」；`TRAE_CACHE_USAGE_LOOKUP_TIMEOUT_SECONDS` 默认 3、上限 10、0 禁用 | 无（我们靠 `session_usage`）→ **P2-13** |
| 上游 0 不等于未命中 | 「已观察到 Remote SSE 缓存读写均为 0、同一 turn 的商业账单却报告真实缓存读取」→ 不拿 SSE 的 0 当证据 | 与我们 `cachedReported` 同源 |
| Responses 会话缓存 | `RESPONSES_SESSION_TTL_SECONDS=3600`、`RESPONSES_SESSION_MAX_ENTRIES=1024`；「未知、过期、容器重启后失效或超上限的 response id 返回明确的 `400 previous_response_id`」；同时兼容客户端全量重放并**重叠去重** | 我们不做（§10），但这段是将来若要做的完整规格 |
| 工具请求约束端点 | 「请求包含调用方工具定义、工具选择参数或工具历史时，先约束到支持该协议的端点；工具请求不回落 Remote/Work」 | **已具备**（`hasTools` 分支） |
| 端点回落 | 「空响应仅在**允许重试且未观察到模型活动**时可跨端点回落；已收到输出/provider/usage/工具事件则不重放」 | 已具备（repair gate + 已写不重试） |
| 视觉能力 | 「只取当前账号、tier 和 raw function 返回的 descriptor；不按官方模型名猜」；`TRAE_MULTIMODAL_AUTO_SWITCH`；**远程图片 URL 原样转发不代下载** | 已具备（`assertImageSupport`） |
| 思考档位 | Chat/Responses/Messages 统一接 `reasoning_effort` / `reasoning.effort` / `thinking.effort`；按 descriptor 映射，**未应用的档位在追踪信息里明确标记** | 缺「默认值」与「生效标记」→ **P0-4** |
| 企业 Raw（实验性） | `UPSTREAM_MODE=raw`、`TRAE_ENTERPRISE_ENABLED`、`TRAE_ENTERPRISE_ACCOUNT_ID`、`TRAE_RAW_BASE_URL`、`POST /api/enterprise` | **剔除**（§8） |

### 4.5 smart-open/TraeWorkAssistant（2026-11-11）

| 功能 | 引文/事实 | 本项目对照 |
|---|---|---|
| 计划任务睡眠唤醒补跑 | v3.9.2（#175） | 缺 → **P1-8** |
| 6 层设备标识重置 | README 明写是**桌面客户端文件级**：`machineid / storage.json 遥测 / aha.device / 注册表 MachineGuid / webview 追踪数据 / aha TinyStorage` | **不适用**：我们不动客户端文件，且已移植其 `accounts.rs` 的 `derive_device` 算法（见 `src/traework/device.js` 头注释） |
| 登录态切换 / 积分看板 / 成长中心 | 桌面壳能力 | 不适用（形态不同） |
| 结构化请求日志 / API 日志路径穿越收口 | v3.9.2 | 我们已是 JSONL + `serveStatic` 有前缀校验 |

### 4.6 XCool-603/trae2api（2026-11-02）

**注意：一处需要纠正的认知。** 该仓库 commit 写作「跨版本域自动容灾切换（国内版账号耗尽/冷却时
自动切至国际版）」，但 README 的功能对照表明确写：

> **跨域 failover：❌ 未实现。**`trae` 与 `solo` 是两个**模型池**……国内版 ↔ 国际版之间**有**兜底
> （该域一个渠道都没有时），但那是"部署事实"级兜底，不是故障转移。

所以它能提供的是「**该域完全没有可用渠道**」时的兜底，**不是**「某个号冷却就切区」。
这直接影响我们的设计：跨区切换只能作为**默认关的显式开关**，且触发条件写死为
「本区域 `availability()` 判定无可用账号」，不能做成「一遇 429 就跨区」。

其余可取：

| 功能 | 引文要点 | 对照 |
|---|---|---|
| `/v1/models` 能力与倍率透出 | `multiplier`（来自 `fee_model_level`）、`reasoning_efforts`、`reasoning_default`、`context_window` / `dev_context` / `max_context` / `max_tokens` | 我们已有 `rate` / `reasoningEfforts` / `maxMode`；**`reasoning_default` 未取**（字段映射待真机核对）→ P0-4 |
| `/v1/stats` 聚合 | global / by_model / by_account / by_realm / by_day，含 TTFB、耗时、token、**缓存命中率**、积分消耗，**带保留窗口** | 我们分在 `usage-agg` / `points`；缺 TTFB → **P2-13** |
| 无观测哨兵 | `avg_ttfb_ms: -1` 表示「无观测」，控制台渲染「—」并注明「不是 0」；作者自述 `AvgCredits` 的 Go 零值曾被单测抓出来 | 与我们「`null` ≠ 0」同源，可借鉴到 TTFB |
| 命中率分母 | `hit / (hit + miss)`，**排除 cacheWrite**；否则首次请求永远显示未命中 | 核对我们的口径 → P2-13 |

---

## 5. 本项目基线（已具备，不重复造）

| 能力 | 证据（文件/函数） |
|---|---|
| 三链路 TRAE（utils_chat / Remote / SOLO raw）+ tools 端点约束 | `src/traework/index.js` 的 `hasTools`、`remote.js`、`solo.js` |
| 双区域账号 + 区域整页切换 | `constants.regionOf`、`docs/REGION-SWITCH.md` |
| 逐轮精确账单 + 缓存计数 | `traework/billing.js`、`credits.js` |
| 缓存「已上报/未上报」口径 | `reqlog.cachedReported`、`usage-agg.confirmedZero` |
| FEFO 临期选号 | `src/expiring.js` |
| 9074 自愈（换设备 + 退避 + 错峰） | `traework/checkin.js`、`auth.rotateDevice` |
| 设备标识按 uid 确定性派生 | `traework/device.js`（移植自 TraeWorkAssistant `accounts.rs`） |
| 会话粘性（暖账号 + TTL + LRU） | `src/sticky.js`、`channel-pool.sessionKeyOf` |
| 冷却分类 soft/hard/breaker + 模型级冷却 | `channel-pool.noteError` / `availability` |
| 降级 / Max / 护栏 / 全站暂停 | `src/trae-runtime.js`、`degrade.js`、`policy.js`、`guard.js`、`TraeRuntimeView.vue` |
| 告警七规则 + 日志页 + 角标 | `admin/alerts.js`、`logbuffer.js`、`OpsAlertsView.vue` |
| 批量运维 | `traework/batch.js`（export / pause / resume / probe / checkin） |
| 接入配置备份 + 恢复 | `agent-setup.backupConfig` / `restore` |
| 静态托管防穿越 | `admin/server.js` 的 `serveStatic`（`startsWith(DIST + path.sep)`） |
| 模型能力只认 descriptor | `traework/models.normalize`（multimodal / maxMode / upgradeRequired / reasoningEfforts） |

---

## 6. 逐项差异总表

| 新功能 | 现状 | 结论 |
|---|---|---|
| 模型目录缓存五维分桶 + 冷读单飞 | 仅 region | **P0-1** |
| 本机回环自动回调 + state 单次消费 + 取消/到期 | 手抄、无校验 | **P0-2a** |
| 授权码 + PKCE + P-256 DeviceInfo 换票 | 无（走 refreshToken） | **P0-2b（先验证再写）** |
| 认证拒绝不重放 / 冷却隔离 / 单号恢复 | 换号偏激进；仅批量恢复 | **P0-3** |
| 每模型默认思考档 + 未应用标记 | 无 | **P0-4** |
| 请求尝试链 | 无 | **P1-5** |
| 会话图片压缩 | 无 | **P1-6** |
| 自定义路由组 | 无 | **P1-7** |
| 签到补签 / 计划分组 | 无 | **P1-8** |
| 账号级风控参数上台 | 仅 env | **P1-9** |
| 接入配置 diff 预览 | 无 | **P2-10** |
| 会话指纹含 system | 仅首条 user | **P2-11** |
| 自动刷新 / 阅读模式 | 无 | **P2-12** |
| TTFB 聚合 / 命中率分母 | 无 TTFB | **P2-13** |
| 缓存明细按账单补查 | 无 | **P2-14（备选）** |
| Responses 状态链 | 明确不存 | 不采纳（§10） |
| 一律不自动换号 | 池需要换号 | 不采纳（取冷却隔离） |
| 6 层设备标识重置 | 不适用（客户端文件级） | 不适用 |
| 企业 Raw / 企业账号 / SSO | 无 | **剔除（§8）** |

---

## 7. 可融合项详述

### P0-1 模型目录缓存五维分桶 + 冷读单飞

- **来源**：Trae2api-cn v1.0.11 + README（引文见 §4.4）
- **代码证据**：`src/traework/models.js` 里 `const caches = new Map(); // region -> {at,data}`，
  `fetchModels` 注释就写着「带缓存，**按区域分**」。一个区内两个账号（免费 / Pro、不同 `tier`、
  不同 `raw_chat_function`）共用同一份能力表 → `multimodal` / `maxMode` / `upgradeRequired`
  会对某个账号说谎，**且不报错**。这与本项目「能力只认当前账号 descriptor」的纪律直接冲突。
- **落点**：
  1. `models.js`：缓存键 `region|accountId|tier|nativeFunction|clientIdentity`；`normalize` 结果按该键写；
     `cacheOf/cachedModelIds/cachedMetaById/hasCache/cachedModelEntries` 全部接同一 `scope`；
     **未传 scope 的调用方退回 region 视图**（`isKnownModel` 这类行为不变）。
  2. `fetchModels` 增 `inflight: Map` 单飞（同键共享 Promise，`finally` 清），结果**深拷贝**后再分发
     （取消单个等待者不影响其它）。
  3. 缓存条数上限：每 scope LRU 8 条，避免账号多时无限增长。
- **管理端**：模型页「模型信息」卡加 `cacheScope` 列 + 「清缓存重取」按钮
  （`POST /api/admin/models/refresh?channel=traework`）。**没有 scope 显示不许上线**——
  否则下次「能力判断错了」还是查不出来。
- **验收**：`test/unit/trae-models-scope.test.js`（键构造、跨账号不串、单飞只打一次、
  取消单个等待者不影响、无 scope 时行为不变）。

### P0-2a 登录本机回环自动回调 + state 单次消费

- **来源**：hub v1.6.0 + `docs/OAUTH.md`（§4.3）
- **代码证据**：`src/traework/login.js` 头注释「不做本地 http server…手动粘贴更透明」，
  `REDIRECT` 写死 `127.0.0.1:18080`，`login_trace_id` 生成后**回调侧不校验**，
  没有取消/到期概念。每加一个号都要手抄一次长 URL。
- **落点**：
  1. 新文件 `src/traework/oauth-callback.js`：`start({region, deviceIds})` → `{state, url, expiresAt, wait, cancel}`；
     监听 `127.0.0.1` **随机端口**（`listen(0)`），路径 `/authorize`；校验 `Host`；
     **无 CORS**；`state` 必须一致且**单次消费**；10 分钟到期自动 `close()`；
     终态清理 verifier/私钥；**不记录 query**。
  2. `login.js`：`buildAuthUrl` 的 `login_trace_id` 改由会话提供；新增 `completeFromCallback(url)` 复用
     现有 `exchangeAndSave`（**换票契约不动**）；原手贴路径保留为降级。
  3. 管理端点（`admin/routes/traework.js`，全部 admin）：
     `POST /accounts/login/start`、`GET /accounts/login/poll?state=`、
     `POST /accounts/login/cancel`、`POST /accounts/login/callback`；
     状态取值照抄 hub 的六态（`pending/exchanging/success/failed/expired/cancelled/not_found`）；
     **poll 不返回** access/refresh token、verifier、私钥；**另一个面板会话不能查/取消/提交**已有会话。
  4. 前端 `components/traework/TraeworkAccounts.vue`：「添加账号」三步向导
     （选区 → 授权中/倒计时 → 成功入库或「粘贴回调」降级）+ 取消按钮。
- **纪律**：监听只在会话期内存在；只绑 `127.0.0.1`；不写死端口；
  失败原因如实回传（「state 不匹配」不能笼统说成「登录失败」）；
  `reqlog` 对回调查询串做白名单截断。
- **验收**：`test/unit/trae-oauth-callback.test.js`（state 单次消费、过期、取消、Host 校验、
  非回环拒绝、日志无完整 query、跨会话不可操作）。

### P0-2b 授权码 + PKCE 换票链路（先验证，后实现）

- **来源**：同上（INTL 客户端 1.107.1 静态证据）
- **为什么单独一项**：换票契约不同（`AuthCode + CodeVerifier + DeviceInfo(P-256 SPKI) + IDEVersion`），
  且必须「不信任回调 UID / 不解析未验签 JWT」。加参数而不同时改契约 = 登录直接挂。
- **进入条件（缺一不写代码）**：
  1. 隔离实例上真账号跑通一次 `ExchangeToken`，拿到 200 与 Token（可只记「成功/失败」不落凭证）；
  2. 确认 `code_challenge` 与 `login_trace_id` 在**国内版**是否都回显（hub 自己承认国内版没有 product.json 证据）；
  3. 确认 P-256 公钥的生成与保存方式（每账号一份、随账号原子落盘、刷新沿用）。
- **落点（验证通过后）**：`login.js` 增 `pkce` 分支；`device.js` 增 `p256Spki()`；
  账号记录加 `devicePublicKey`；`ExchangeToken` 走独立函数，失败回落 refreshToken 流程并如实标注用了哪条。
- **不做的代价**：如果上游某天关掉 refreshToken 换票，我们要重开一次逆向。**这是风险，不是缺陷**，
  写进 §10 备查。

### P0-3 认证拒绝不重放 + 冷却隔离 + 单账号人工恢复

- **来源**：NextAgentX v2026.11.141713 / v2026.11.141118；XCool 的「解除冷却」入口
- **机制**：① 认证拒绝（401/403 形态且非限流码）**不换号重打**；② 限流/排队/余额只冷却
  「当前模型 + 当前账号」，不升级成全号；③ 冷却跨重启保留 + 人工恢复入口。
- **现状**：`channel-pool` 有 soft/hard/breaker 与 `model_cooldowns`；`batch.js` 的 `resume`
  默认保留冷却、`force` 才清。缺：**认证拒绝的显式判据与测试锁定**、**单号恢复入口**、跨区容灾。
- **落点**：
  1. `src/upstream-errors.js` 增 `isAuthReject(e)`（单一来源，四通道共用）。
  2. `traework/index.js` + `channel-pool`：命中即终结该请求并标记 `cool_kind:'hard'`，
     **不进换号循环**；状态码与上游 message 透传。
  3. `trae-runtime.js` 增 `crossRegionFailover:{enabled:false,to:'intl'}`；触发条件写死为
     「本区 `availability()` 判定无可用账号」；仅对**未绑定 region 的 Key** 生效；
     命中写 `X-Traework-Failover: cn->intl` + reqlog。默认关。
  4. `POST /accounts/:id/recover`（admin）→ `pool.revive(id,'manual')` + 写 `logs` 审计；
     前端账号卡加「恢复」按钮。
- **验收**：`test/unit/trae-auth-reject.test.js`（只尝试 1 次、不透传成 429）、
  `trae-cool-scope.test.js`（模型级冷却不污染其它模型）、`trae-failover.test.js`（默认关、
  仅「本区无可用」触发、仅未绑定 Key 生效）。

### P0-4 每模型「默认思考档」+ 未应用档位如实标记

- **来源**：NextAgentX v2026.11.110949（默认档）、Trae2api-cn v1.0.11（descriptor 映射 + 如实标记）、
  XCool `/v1/models` 的 `reasoning_default` 字段（**字段名待真机核对**）
- **现状**：`qoder/chat.js` 有「最近合法档」归一化；`traework/remote.js` 认 `xhigh`；
  `models.normalize` 已解析 `reasoningEfforts`（`support_thinking` + `options`）。
  **没有「客户端未指定时套用默认值」这一层，也没有「档位是否真的生效」的回执。**
- **落点**：
  1. `src/trae-runtime.js` 增 `defaultReasoning: {"traework/glm-5.2":"high","qoder/*":"medium"}`（最长匹配优先）。
  2. 新 `src/reasoning-apply.js`：`applyDefault(payload,{channel,model,table,capabilities})` →
     `{payload, source:'client'|'default'|'none', requested, effective}`；四通道共用。
  3. 埋点与响应头：`reqlog` 加 `reasoning_requested / reasoning_effective / reasoning_source`；
     `X-Reasoning-Applied`（流式首帧也带）。
  4. 前端 `TraeRuntimeView.vue` 增「默认思考档」表（模型模式 / 默认档 / 上游是否声明支持 /
     24h 实际生效分布）。
- **纪律**：绝不按模型名猜支持；默认值只进运行态配置（`data/traework-runtime.json`）；
  上游没声明就标 `unsupported`，不静默吞掉客户端的档位。
- **验收**：`test/unit/reasoning-default.test.js`（客户端优先、通配最长匹配、非法值 400、
  unsupported 如实标记、无默认配置时零变化）。

### P1-5 请求尝试链（请求回放，只存判据）

- **来源**：Agent2API v3.4.2
- **现状**：`reqlog.record` 一条请求一行；`channel-pool.availability()` 已算出「为什么不可用」
  但**不落盘**，请求结束后无人可见。
- **落点**：
  1. `reqlog.js` 增 `attempts:[{accountId, at, outcome:'ok'|'error'|'skipped'|'cooling'|'inflight', reason, ms}]`，
     上限 8 条，超限记 `attempts_truncated:true`；**不存报文**。
  2. `channel-pool.pickCandidate` 返回 `{uid, reason}`，`availability()` 判据字符串直接进 `attempts`。
  3. 前端 `ReqLogsView.vue` 行内「尝试链」抽屉（时间轴 + 判据中文解释 + 首帧/完整响应两个时间）。
- **纪律**：只读观测，不参与路由；写失败必须吞掉。
- **验收**：`test/unit/reqlog-attempts.test.js`（上限截断、判据透传、写失败不影响响应）。

### P1-6 会话图片压缩（先零依赖降级版）

- **来源**：Agent2API v3.4.0
- **现状**：`src/images.js` 只做形状转换，**没有任何重编码**（`grep resize|sharp|jimp` 为空）。
- **三条路线，先选 C**：
  - C（零依赖，**先做**）：不压缩，但超阈值图返回明确 413 + 可读原因 + reqlog 记「大图告警」。
  - A（推荐后续）：纯 JS 编解码（`@jsquash/*` 或 `jimp`），5~15 MB，无原生编译。
  - B（不推荐）：`sharp` —— native 依赖，破坏「Windows 双击即用」。
- **落点**：`images.js` 增 `shrinkDataUri(url,{maxEdge,quality,threshold})`（C/A 共用接口）；
  `DUMATE_IMAGE_SHRINK=1` / `_MAX_EDGE=1536` / `_QUALITY=82` / `_THRESHOLD_KB=256`；
  命中写 `reqlog.image_shrunk:[{before,after}]`（**证明它真发生了，不是静默改图**）。
- **验收**：`test/unit/image-shrink.test.js`（阈值边界、同图复用、关闭后逐字节不变、非图片不受影响）。

### P1-7 自定义路由组（显式 + 有痕迹）

- **来源**：Agent2API v3.4.2
- **现状**：`model-map.json` 只有 1:1 `aliases`；未知前缀一律 400（「不静默回落」是既有定案）。
  所以路由组必须满足三条：**配置里显式声明** / **每次命中留痕迹** / **跨通道回落默认关**。
- **落点**：
  1. `data/model-map.json` 增 `groups:[{id:'fast', members:['qoder/gfmodel','traework/glm-5.2'], fallback:true}]`。
  2. `upstream-router.resolve()` 先查 `groups` → `{group, member}`；`/v1/models` 列为
     `owned_by:'dumate-proxy'` 且带 `group:true`。
  3. `server.js` 写 `X-Route-Group: fast;member=qoder/gfmodel;attempt=1`；reqlog 记 `group/member/attempt`。
  4. 前端 `ModelsView.vue` 增「路由组」tab（成员拖拽、后备选开关、试跑）。
- **纪律**：只允许「成员尚未产出任何字节」时换成员；已输出不重放（与 P0-3 同一铁律）。
- **验收**：`test/unit/router-group.test.js`（未声明仍 400、成员顺序、fallback 开关、已输出不重放、痕迹字段）。

### P1-8 签到补签（含睡眠唤醒补跑）+ 计划按时刻分组

- **来源**：Agent2API v3.3.0-beta.6、TraeWorkAssistant v3.9.2（#175）
- **现状**：`grep 补签` 无命中；`task-scheduler` 只在固定时刻触发；`keepalive` 的 `catchup` 是
  **token 刷新**的补跑，不是签到。
- **落点**：
  1. `task-scheduler.js`：启动时 + 每 N 分钟检查「今天应有签到但 `checkin-ledger` 无记录」→ 补跑
     （窗口默认 09:17~23:30，幂等靠 ledger 日期键）。
  2. `POST /api/admin/checkin/makeup`（admin，`{ids?, dryRun?}`）→ `{skipped:['已签'], run:[...]}`。
  3. 前端 `CheckinDetailCard.vue`：拆「签到 / 补签 / 活动领取」三 tab；计划卡按时刻分组；
     记录表加列显隐 + 列宽拖动。
  4. 侧栏角标加「待补签 N」。
- **纪律**：补签是用户可见的补跑（每次写 `logs`），不是静默重试。
- **验收**：`test/unit/checkin-makeup.test.js`（幂等、窗口外不跑、dryRun 不落库、已签跳过）。

### P1-9 账号级风控参数上台

- **来源**：NextAgentX v2026.11.131448 / 131828
- **现状**：`channel-pool` 的 `inflightMaxOf` / `minIntervalMsOf` 读环境变量，改一次要重启。
- **落点**：`trae-runtime.js` 增 `throttle:{inflightMax,minIntervalMs,retryOnTransient,coolingSeconds}`；
  `channel-pool` 先读运行态、回落 env（**env 仍是最后保险**）；
  `TraeRuntimeView.vue` 增「请求风控」卡（每平台独立 + 恢复默认）。
- **验收**：`test/unit/trae-throttle-runtime.test.js`（运行态覆盖 env、非法值 400、恢复默认）。

### P2-10 接入配置「写入前 diff 预览」

- **现状**：`agent-setup.js` 有 `backupConfig`（10 份滚动索引）+ `restore`，**没有 apply 前预览**。
- **落点**：`apply` 增 `dryRun:true` → `{path,before,after,diff}`；`AgentSetupView.vue` 两步
  「预览 → 确认写入」（行级高亮，**保留原文件注释**）。
- **验收**：`test/unit/agent-setup-preview.test.js`（dryRun 不写盘、注释保留、备份仍先落）。

### P2-11 会话指纹含 system

- **现状**：`channel-pool.sessionKeyOf` 只取首条 user 文本（`m:<sha1>`）；同一句「继续」
  在不同 system/项目下会撞键 → 粘错账号、白丢前缀缓存。
- **落点**：新键 `m:<sha1(system 前 512 字 + 首条 user 前 2048 字)>`；灰度期两者都写、
  优先新键；开关 `DUMATE_STICKY_V2=1`。
- **验收**：`test/unit/sticky-key.test.js`（新键区分 system、旧键仍命中、关开关零变化）。

### P2-12 页面自动刷新间隔 + 阅读模式

- **落点**：`MainLayout.vue` 全局「关/10s/30s/60s」（localStorage）+ 复用 composable；
  请求日志详情「阅读模式」（隐藏工具栏、放大正文）。
- **验收**：`cd web && npm run build` + **真实浏览器截图**核对（本项目有过「接口 200、界面无感」）。

### P2-13 用量统计补 TTFB 与命中率分母口径

- **来源**：XCool `/v1/stats` 与「无观测哨兵」一节
- **现状**：`usage-agg.js` 没有 TTFB 聚合；每请求 `first_token_ms` 已落盘但没被聚合。
- **落点**：`usage-agg` 增 `ttfb:{count,avg_ms|null}`——**分母只用真有首字节的请求**，
  非流式记 `null`（不是 0）；前端显示「—」并注明「无观测，不是 0」。
  同时核对缓存命中率分母**排除 cacheWrite**。
- **验收**：`test/unit/usage-ttfb.test.js`（无首字节不参与均值、全无观测回 null、命中率分母）。

### P2-14（备选）缓存明细缺失时按账单 ID 补查

- **来源**：Trae2api-cn v1.0.11
- **为什么只做备选**：需要「按账号 + 账单 ID 查商业账单」的端点证据，且必须严守
  「输入 token 精确匹配、旧端还需匹配输出、不重复相加、超时 3s 上限 10s、失败保留原始计数」。
  我们靠 `session_usage` 已覆盖大部分场景；误配风险（把别人的消耗记到自己头上）大于收益。
- **进入条件**：真机跑一次「SSE 缓存全 0 但账单有缓存读取」的对照，拿到确切证据。

---

## 8. 已剔除的企业版 / 组织形态内容（按你的要求）

> 判定：需要多租户、组织身份、集中托管、付费许可或运营增长形态。个人自用网关用不上，
> 管理端**也不给入口**。

| 被剔除 | 上游真实标识（便于将来一眼认出） | 剔除理由 |
|---|---|---|
| **企业账号 / 企业模式** | `UPSTREAM_MODE=raw`、`TRAE_ENTERPRISE_ENABLED`、`TRAE_ENTERPRISE_ACCOUNT_ID`、`TRAE_RAW_BASE_URL`、`POST /api/enterprise`；企业 Raw body 固定六字段 | 上游未联调（个人号缺 app config 恒回 `2001 failed to get app config: record not found`）；属企业身份范畴 |
| 企业 SSO / App ID / PAT | 同上 | 需组织侧注册，不具备 |
| 多租户 / 角色权限 | 三角色、一次性激活链接 | 单人自用（既有调研已否） |
| 整库加密备份 `.a2ab` | 含账号、网关 Key、GitHub 令牌、云同步恢复密钥 | 集中凭据托管；`data/` 就在本机，加密层只增加「密码丢了全丢」 |
| 云同步（WebDAV / S3） | 自定义 UA 兼容 | 会把凭证送出本机 |
| 插件市场 / WASM 沙箱 / npm 安装 | 插件目录、固定提交安装 | 平台化；本项目是单二进制手改源码 |
| 邀请返利 / 新人奖励 | Trae 邀请送 5000 积分（其 README） | 增长运营，与网关能力无关 |
| 订阅/套餐营销、成长中心 | 活动合并、体验套餐 | 面向终端用户的产品化 |
| 六语文案 / 桌面壳 / 手机端 / Android | Tauri、APK 更新 | 形态不同 |
| Docker / GHCR / Watchtower | 多架构镜像、自动更新 | 部署形态不同 |
| 代理订阅 / 内置代理内核 | 3.3.0 已自行下线 | 上游自己移除 |

---

## 9. 管理端前端页面级改造清单

| 页面（现有文件） | 新增元素 | 数据来源 | 优先 |
|---|---|---|---|
| `components/traework/TraeworkAccounts.vue` | 添加账号三步向导（选区 → 授权中/倒计时 → 成功或粘贴回调）+ 取消 | `login/start|poll|cancel|callback` | P0-2a |
| 同上（账号卡） | 单账号「恢复」；冷却原因分「模型级/账号级」两行 | `POST /accounts/:id/recover` | P0-3 |
| `views/TraeRuntimeView.vue` | ①默认思考档表 ②请求风控卡 ③跨域容灾开关（默认关，提示 Key 绑定 region 会失效） | `trae-runtime` 读写 | P0-4 / P1-9 / P0-3 |
| `views/ModelsView.vue` | ①信息卡加 `cacheScope` + 清缓存重取 ②「路由组」tab | `models/refresh`、`model-map.groups` | P0-1 / P1-7 |
| `views/ReqLogsView.vue` | 「尝试链」抽屉（时间轴 + 判据 + 首帧/完整响应） | `reqlogs.attempts[]` | P1-5 |
| `views/PointsView.vue` + `components/CheckinDetailCard.vue` | 三 tab（签到/补签/活动领取）、计划按时刻分组、记录表列显隐+列宽 | `checkin/makeup` | P1-8 |
| `views/UsageView.vue` | TTFB 卡（无观测显示「—」）、命中率分母说明 | `usage-agg.ttfb` | P2-13 |
| `views/AgentSetupView.vue` | 「预览 diff → 确认写入」两步；模型目录复制 | `agent-setup dryRun` | P2-10 |
| `layouts/MainLayout.vue` | 自动刷新间隔选择器；日志详情阅读模式 | 纯前端 | P2-12 |
| 侧栏角标 | 新增「待补签 N」 | `/traework/status.alerts` 扩展 | P1-8 附带 |

**不做**：Logo/名称自定义、六语、手机端、营销弹窗（§8 已剔除）。

---

## 10. 明确不融合 / 不适用（附理由）

| 项 | 来源 | 理由 |
|---|---|---|
| Responses 状态链 / `previous_response_id` | NextAgentX v2026.11.141713、Trae2api-cn（TTL 3600 / 上限 1024 / 400 语义齐全） | 与 `CLAUDE.md` 定案冲突（上游无状态、Codex 全量回传）。**但要记清：这是可用性设计，不是没人做过的空想**——两家都实现了，规格见 §4.4；将来若要接，照那份规格做，别再重新调研 |
| 「认证拒绝/限流/余额耗尽一律不换号」 | NextAgentX | 与多账号池的存在意义相反。只取「冷却隔离 + 认证拒绝不重放」 |
| 6 层设备标识重置 | TraeWorkAssistant | 桌面客户端**文件级**操作（注册表 MachineGuid、storage.json 遥测、aha.device…）；我们不动客户端文件，且 `device.js` 已移植其派生算法 |
| 全自动静默更新 / Watchtower | XCool、Agent2API | `stable/` 是冻结快照发布制，自动替换会毁掉 `SNAPSHOT_FROM.txt` 依赖闭包 |
| 工具服务台（搜索/视觉做成 MCP + 插件） | Agent2API v3.4.1 | 端点已有；再叠插件体系属平台化 |
| 客户端识别规则引擎 | Agent2API v3.4.2 | `UA` 已入 reqlog；规则引擎收益低于维护成本 |
| 「思考链路输出」呈现开关 | Trae2api-cn v1.0.11 | 只改它自家控制台的呈现；我们透传，是否产思考不由网关决定 |
| 会话式 Web 门户（重命名/置顶/KaTeX） | ZedeX/trae-local-api | `ChatLabView` 定位是探针，不是聊天产品 |
| `bytedance/trae-agent` 的 agent/swebench 工作流 | 官方仓库 | 形态是 agent 框架，无可复用协议面 |
| PKCE **降级为「先验证」** | hub `docs/OAUTH.md` | 不是不采纳，而是**换票契约不同**，必须真机验证后再写（见 P0-2b） |

---

## 11. 建议实施顺序与工作量

| 批次 | 内容 | 估时 | 前置 |
|---|---|---|---|
| 1（正确性） | P0-1 缓存分桶 → P0-3 认证拒绝不重放 / 冷却隔离 | 1.5 天 | 无 |
| 2（可用性） | P0-2a 自动回调 → P1-8 补签 | 2 天 | 先定「监听器生命周期」写法 |
| 3（可观测） | P1-5 尝试链 → P1-9 风控上台 → P0-4 默认档 → P2-13 TTFB | 2.5 天 | 尝试链先给 P0-3 的判据留字段 |
| 4（能力） | P1-7 路由组 → P1-6 图片压缩（先 C） | 1.5 天 | 路由组先定痕迹字段名 |
| 5（体验） | P2-10 / P2-11 / P2-12 | 1 天 | 无 |
| 单列 | P0-2b PKCE（**先验证**） | 验证 0.5 天 + 实现看结果 | 真账号 + 隔离实例 |
| 备选 | P2-14 账单补查 | 2 天 | 先拿真机对照证据 |

**每批固定动作**：先离线单测 → 隔离端口冒烟（`DUMATE_ADMIN_PORT=9123 DUMATE_ADMIN_GATEWAY_PORT=9124`）
→ 前端 `npm run build` + 浏览器截图 → 结论回写 `CLAUDE.md`（只写实测过的）。
**不碰 `stable/`，不启动/重启 9080/9082/9083。**

---

## 12. 验收清单

```bash
# 1) 全量离线单测
node --test "test/unit/*.test.js"

# 2) 既有专项回归
node test/verify-channel.js
node test/verify-traework-repair.js
node test/verify-qoder-throttle.js

# 3) 隔离实例冒烟（独立数据目录，不碰 9080~9084）
DUMATE_ADMIN_DATA=/tmp/trae-admin-smoke \
DUMATE_ADMIN_PORT=9123 DUMATE_ADMIN_GATEWAY_PORT=9124 \
node src/admin/server.js &
curl -s localhost:9123/api/admin/healthz

# 4) 前端类型检查 + 构建
cd web && npm run build
```

| 项 | 判据 |
|---|---|
| P0-1 | 同区两账号不同 tier → `models` 结果不同、`cacheScope` 不同；并发 5 次冷读只打 1 次上游 |
| P0-2a | 本机自动入库；`state` 错 → 400 且不消费；10 分钟过期；取消后回调不入库；日志无完整 query |
| P0-3 | 401/403 只尝试 1 次账号；429 只冷却该模型；重启后冷却仍在；单号「恢复」可点且留审计 |
| P0-4 | 未传 → `reasoning_source=default`；传了 → `client`；不支持 → `none` + 明确标记 |
| P1-5 | 一次「首号冷却→二号成功」的请求，`attempts` 恰好 2 条且原因可读 |
| P1-6 | 超阈值图被拦或缩（视方案）且 reqlog 有记录；关开关后字节不变 |
| P1-7 | 未声明仍 400；声明后带 `X-Route-Group`；已输出不重放 |
| P1-8 | 错过时刻后启动 → 补签一次；再启动不重复；`dryRun` 不落库 |
| P1-9 | 运行态改并发立即生效；env 仍兜底；非法值 400 |
| P2-13 | 非流式请求不参与 TTFB 均值；全无观测回 `null` 并显示「—」 |

---

## 13. 证据附录

### 13.1 窗口内 release 时间线

```
2026-11-14  NextAgentX v2026.11.141713  会话隔离 / 缓存命中语义 / 账号终态不换号
2026-11-14  NextAgentX v2026.11.141118  Qoder 429 只冷却当前模型
2026-11-13  NextAgentX v2026.11.131828  风控统一设置 + 记忆迁移
2026-11-13  NextAgentX v2026.11.131448  三平台风控 + 人工恢复入口
2026-11-12  trae2api-hub v1.6.0         浏览器 OAuth（PKCE / 回环回调 / 远程粘贴 / 取消超时）
2026-11-11  trae2api-hub v1.5.1 / 1.5.0 看板迭代
2026-11-11  TraeWorkAssistant v3.9.3    指纹清洗 + 凭证失败徽标
2026-11-11  NextAgentX v2026.11.110949  prompt_cache_key 绑会话 / 按模型默认思考档
2026-11-10  TraeWorkAssistant v3.9.2    睡眠唤醒补跑 / 结构化请求日志 / 跨池重试
2026-11-09  Agent2API v3.5.0-beta.1     插件(剔除) / 接入多配置+预览 / 图片兼容
2026-11-09  XCool 提交                   邀请返利(剔除) / 跨域兜底 / SSE 卡顿修复
2026-11-05  Trae2api-cn v1.0.11         模型目录缓存分桶 / reasoning 三协议统一 / 账单补查
2026-11-05  Agent2API v3.4.2            自定义路由组 / 请求回放 / 客户端识别
2026-11-05  trae2api-hub v1.4.3         看板
2026-11-04  Agent2API v3.4.1            工具服务页 / 面板 gzip
2026-11-03  Agent2API v3.4.0            会话图片压缩 / 模型 ID 收敛
2026-11-02  XCool v0.2.6                单次调用积分展示 / Docker 更新检测
2026-10-30  Agent2API v3.3.0-beta.6     签到补签与活动窗口重试 / 仅清空报文原文 / 加密整包(剔除)
2026-10-28  XCool v0.2.5                签到 UG host 归一
2026-10-23  Trae2api-cn v1.0.10         账号容量(并发槽) / descriptor-only 能力
2026-10-22  Trae2api-cn v1.0.9          长历史增量前缀哈希 / 空流明确错误 / 输出后不重放
```

### 13.2 本地核对点（可复验）

| 结论 | 命令 |
|---|---|
| 模型缓存只按 region | `grep -n "按区域分\|caches = new Map" src/traework/models.js` |
| 登录不做回环监听、state 不校验 | `sed -n '1,30p' src/traework/login.js` |
| 换票 body 是 refreshToken 契约 | `grep -n "ClientSecret\|RefreshToken" src/traework/login.js` |
| 无图片重编码 | `grep -n "resize\|sharp\|jimp" src/images.js` → 空 |
| 无补签 | `grep -rn "补签" src web/src` → 空 |
| 无尝试链 | `grep -n "attempts" src/reqlog.js` → 空 |
| 无 TTFB 聚合 | `grep -n "ttfb\|first_token" src/usage-agg.js` → 空 |
| 无默认思考档 | `grep -rn "defaultReasoning" src` → 空 |
| 会话键不含 system | `sed -n '35,58p' src/channel-pool.js` |
| 静态托管防穿越 | `grep -n "startsWith(DIST" src/admin/server.js` |
| 缓存「未上报 ≠ 未命中」已做 | `grep -n "cachedReported" src/reqlog.js` |

### 13.3 取数通道复现

```bash
# 元数据（额度 60/h，建议带 token 提到 5000/h）
curl -s "https://api.github.com/repos/<o>/<r>/releases?per_page=5"

# 正文（三条镜像，见 scripts/gh-fetch.sh）
./scripts/gh-fetch.sh file <o>/<r> README.md /tmp/r.md
./scripts/gh-fetch.sh tree <o>/<r> | grep '\.md$'          # 发现 docs/
curl -s "https://gcore.jsdelivr.net/gh/<o>/<r>@v1.6.0/docs/OAUTH.md"   # 按 tag 取
```

---

## 14. 落地状态（待更新）

> **收口文档**：`docs/LANDING-2026-11-16.md`（落地一览 / 复验命令 / 未做项与阻塞 / 快照发布评估）。
> 本节的逐项状态以那张表为准，这里只保留每项的技术要点。

| 项 | 状态 | 备注 |
|---|---|---|
| P0-1 模型目录缓存分桶 + 冷读单飞 | ✅ **2026-11-16 已落地** | `src/traework/models-cache.js`（新）+ `models.js` / `traework/index.js` / `admin/routes/{traework,models}.js` / `model-info.js` / 前端模型页；`test/unit/trae-models-scope.test.js` 17 项；全量 716/716；隔离 9123 冒烟通过。见 `CLAUDE.md` 的「2026-11-16 落地」节 |
| P0-2a 登录自动回调 | ✅ **2026-11-16 已落地** | `src/traework/oauth-callback.js` + 4 个端点 + 前端三步向导（保留粘贴退路）；`test/unit/trae-oauth-callback.test.js` 12 项；真上游冒烟（假 token 得 `401/20101`，状态如实 failed，监听关闭）。换票契约未动 |
| P0-2b PKCE 换票 | **待验证** | 需真账号跑通 `ExchangeToken(AuthCode)` |
| P0-3 认证拒绝不重放 / 冷却隔离 / 单号恢复 | ✅ **2026-11-16 已落地** | `upstream-errors.isAuthReject`（403 要正向证据，裸 403 不动）+ `trae-auth-reject.test.js` 20 项 + `POST /accounts/:id/recover` + 前端「恢复」；跨区容灾默认关（`src/traework/failover.js`）。全量 736/736，Qoder 三个专项回归通过 |
| P0-4 默认思考档 | ✅ **2026-11-16 已落地** | `src/reasoning-apply.js` + `defaultReasoning` 运行态配置 + `X-Reasoning-Applied` + 前端卡片；`test/unit/reasoning-default.test.js`(10) + `trae-reasoning-wire.test.js`(4)；只读探针 `test/probe-traework-reasoning.js`。**上游无「默认档」字段证据**，默认值只用我们自己的配置 |
| P1-5 请求尝试链 | ✅ **2026-11-16 已落地** | `src/attempts.js` + `availability.details` + TRAE 五类判据 + `logGateReject`（闸门拒绝也落日志）+ 前端时间轴；`attempts.test.js` 8 + `trae-attempts-wire.test.js` 4；全量 785/785；真网关冒烟四条拒绝都有行与原因 |
| P1-6 图片压缩 | ✅ **2026-11-16 已落地（两批）** | `src/image-budget.js` + 四入口接线 + 请求日志五个字段 + 前端两张面（日志详情「内联图片」、风控页「内联图片上限」）；`test/unit/image-budget.test.js` 10 项；全量 809/809；9123 真机 413 与「关掉上限回到 503」双向验证。第二批：`src/png.js`（纯 JS PNG 解码/面积平均缩小/重编码，只用内置 zlib）+ 按原图指纹的 LRU 缓存（同图复用结果）+ `maxEdge` 与 `DUMATE_IMAGE_MAX_EDGE` + 缓存统计与清缓存端点；`png.test.js` 8 项、`image-budget.test.js` 追加 6 项；全量 823/823；9123 真机三向对照（1.3MB→27KB 不再 413 / 同图命中缓存 264ms→11ms / 关掉 maxEdge 立刻 413）。**JPEG 不缩**（要 huffman 解码）；另三个入口的 413 与压缩无账号未实测 |
| P1-7 路由组 | 🟡 **第一批已落地（配置 + 分发前择优），跨成员重试待做** | `src/route-groups.js` + `router.resolveWithGroup`（4 个入口替换 resolve）+ `X-Route-Group` / 尝试链 `group:` 判据 / 请求日志 `route_group` + `/v1/models` 列出组名 + `GET /api/admin/route-groups`（逐成员可用性 + 被丢弃的配置项）+ 模型页只读卡；`route-groups.test.js` 12 项；全量 835/835；9123 真机四向对照（零账号 503 逐条原因 / 普通模型无副作用 / `DUMATE_SOURCE=auto` 下改派到第 3 个成员 / 管理端读数）。**未做**：运行时失败后的跨成员重试、组写入接口与编辑界面、成员权重 |
| P1-8 补签 | ✅ **2026-11-16 已落地** | `src/traework/makeup.js`（plan + shouldCatchUp）+ `autotask` 睡眠唤醒补跑（`last_run_day` 幂等）+ `POST /traework/checkin/makeup`（默认 dryRun）+ 前端「今日补签」；`test/unit/checkin-makeup.test.js` 11 项；全量 773/773。展示部分（计划按时刻分组/记录表列宽）留到界面批次 |
| P1-9 风控上台 | ✅ **2026-11-16 已落地** | `src/throttle.js`（新，唯一解析点：面板 > env > 默认）+ `livecfg` 的 `throttle`/`throttleMaxMs` + `channel-pool`/`repair`/`upstream-errors` 三处现读（`THROTTLE_MAX_MS` 由常量改函数）+ `GET /system/throttle`、`POST /system/pool-revive` + 前端「通道风控」页；`test/unit/throttle-config.test.js` 14 项；全量 799/799；隔离 9127 冒烟（PUT 往返 / 稀疏落盘 / 整条重置 / 未知通道 400）。**只搬了真正影响上游行为的三项 + 全局冷却上限**，「全局并发」本项目没有该维度（并发帽是每账号的），不造字段 |
| P2-10 / 11 / 12 / 13 | 未开始 | |
| P2-14 账单补查 | 备选 | 需真机对照 |

**存量问题（2026-11-16 发现，与本轮批次无关，已在干净 HEAD 上用 `git worktree` 复现）**：
`test/verify-qoder-throttle.js` 的「status 明说还要排很久 → 早停（不烧满预算）」一项失败
（实测 8.3~9.0s，阈值 7s）。口径是：早停（`giveup`）之后外层仍按 `QUEUE_PATIENCE_MS`(6s)
换号重试，两个账号累加就到了 9s。**要么改判据要么改测试测量的口径，别只调阈值把失败藏起来**
——改 Qoder 换号节奏需要真账号验证，本轮未动。
