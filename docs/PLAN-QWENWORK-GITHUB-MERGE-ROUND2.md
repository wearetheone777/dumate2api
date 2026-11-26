# 千问办公 GitHub 融合方案 · 第二轮（网关能力 + 管理端页面）

> 调研日期：2026-11-27
> 调研范围：GitHub 上千问办公（QwenWork）相关的开源实现，**聚焦网关能力与管理端页面**
> 主源：`jianhx189/qwenwork2api`（已落地基线）｜新源：`zhangzhangco/qwenwork-openai-gateway`、`ponm3ay/dsh-connect-qwenwork`、`xinzengxx/cpa-plugin`、`aliyun/agent-exporter-to-langfuse`

---

## 0. 本轮调研的核心发现

第一轮融合（P0-1~P2-2）已落地模型档位表、思考开关、[DONE] 加固、额度转 429。本轮调研**又挖出三类此前未知的东西**：

1. **第二条千问链路 —— MaaS 直连网关**（`zhangzhangco/qwenwork-openai-gateway`）。
   当前我们走的是 `gateway.qwenwork.cn` + wasm 签名 + envelope 剥壳的**应用链路**；
   社区发现了一条**标准 OpenAI/Anthropic/Responses 兼容**的直连网关
   `https://api9.qwenwork.cn/v1`，只用 `Authorization: Bearer <accessKey>`，
   不需要任何签名、不需要剥信封、四个协议入口天然兼容。**架构级简化机会。**

2. **6 个我们没有的模型档位**（MaaS 清单 15/15 实测 200）：
   `qwen3.8-flash`、`glm-5.4`、`ling-3.1-flash`、`minimax-m3.1-flash`（视觉，1M 上下文）、
   `step-5-preview`、`kimi-k3.1-pro`。其中 **minimax 是视觉模型且走 Anthropic Messages 协议**，
   是新的协议映射发现。

3. **管理端页面的"逐模型开关 + 三项能力覆盖层 + 测试按钮"**是社区实现的实质功能，
   我们当前模型管理页是**纯只读展示**（`ModelsView.vue` 明确写"本地不可编辑"）。
   这是本轮管理端融合的核心。

**取舍纪律（沿用第一轮）**：企业专属档（`safety`）、SSO/多用户、每日免费积分（上游已停发，
见 P1-2 定案）不进任何表、不做任何功能。PAT 双登录待证据，本轮不碰。

---

## 一、网关能力融合

### G1. MaaS 直连链路（架构级，重大）

#### 1.1 链路对比

| | 应用链路（现状） | MaaS 直连链路（新发现） |
|---|---|---|
| 上游端点 | `gateway.qwenwork.cn` | `https://api9.qwenwork.cn/v1` |
| 鉴权 | wasm 签名（`qoder_auth_wasm_bg.wasm`）+ Bearer | 仅 `Authorization: Bearer <accessKey>` |
| 请求形状 | envelope 包裹，需 `unwrap()` 剥壳 | 标准 OpenAI / Anthropic / Responses |
| 协议入口 | 自建翻译（chat.js 的 postStream/post） | 上游原生三协议，**四个入口天然兼容** |
| 模型名 | 应用档位（`pro`/`flash`/`qwen3.8-max-preview`…） | MaaS 原生名（`qwen4-max`/`minimax-m3.1-flash`…） |
| `/v1/models` | 本地 `listModels()` 返回 | **上游 404**（无模型列表接口） |
| 凭证来源 | 设备授权 device flow（access/refresh token） | accessKey，TTL 2h，桌面端落盘续期 |

#### 1.2 社区实测结论（`qwenwork-openai-gateway`，2026-11-26 直连实测）

- `POST /v1/chat/completions` → 200，标准 OpenAI 形状，**含 `reasoning_content`**
- `POST /v1/messages` → 200，Anthropic 形状
- `POST /v1/responses` → 存在
- 带 `tools` → 200，`finish_reason: "tool_calls"`
- `GET /v1/models` → 404（与搭子千帆原生端点同形）
- **协议映射表**：`anthropic` provider → `/v1/messages`；`openai` → `/v1/responses`；
  其它 provider → `/v1/chat/completions`。**MiniMax 挂在 anthropic provider 下**——
  协议走 Anthropic Messages，模型是 MiniMax，这是此前未知的协议路由。

#### 1.3 融合方案

**定位：千问通道的备选链路，与应用链路并存，按凭证可用性故障转移。**

- **凭证层**（前置条件，需实测）：
  - accessKey 由桌面端落盘续期，TTL 2h。客户端 2.2.1 的 `engine-maas-key.dat`
    **Windows 实测格式是 Electron `safeStorage` OSCrypt**：`v10\x05` 前缀 + 12 字节 IV
    + AES-256-GCM 密文，明文是 `{schemaVersion:2, identityFingerprint, credentials}`
    JSON。密钥从 `%APPDATA%\QwenWorkCN\Local State` 的 `os_crypt.encrypted_key`
    经 DPAPI(CurrentUser) 解出 32 字节。**社区文档的 PBKDF2/AES-128-CBC 对 2.2.1 不成立**
    （按那套 offset 解全部失败）。
  - 实测：`https://api9.qwenwork.cn/v1/chat/completions` 用 `minimax-m3.1-flash`
    （minimax3.1flash，免费）返回 200；免费档显示名 `MiniMax-M3.1-flash` 
    不是 upstream 键。其它档位测试会消耗真实积分，已把管理端测试按钮限制为只测免费档。
  - 落地：`src/qwenwork/maas.js`，负责 accessKey 读取 → 解密 → 内存缓存（TTL 内复用）→
    到期前刷新。拿不到凭证时 `maas.available() === false`，路由层如实回退应用链路。

- **路由层**：`src/upstream-router.js` 的千问分支增加 `maas` 子链路。`DUMATE_QWENWORK_MAAS=1`
  开启；默认关（凭证层未实测前不默认开启，避免默认路径引入不可控故障）。

- **协议层**：MaaS 是标准协议，**不需要自建翻译**——`src/qwenwork/chat.js` 的 postStream/post
  可直接复用（它已经能处理标准 OpenAI SSE），只需把端点与鉴权头换成 MaaS 的。
  envelope 剥壳（P2-1 的 `unwrap`）在 MaaS 链路下不触发（标准帧直接命中 choices 分支），
  是双链路安全网，不冲突。

- **模型名映射**：MaaS 原生名 ≠ 应用档位名。建立 `MAAS_ALIASES`（见 G2），
  客户端仍用应用档位名，MaaS 链路下翻译层负责名转换。

#### 1.4 落地批次

| 批次 | 做什么 | 前置 |
|---|---|---|
| G1-a | `maas.js` 凭证读取 + 解密 + 缓存骨架，`available()` 探活 | 实测定 WSL2/Linux 凭证路径与解密方式 |
| G1-b | 路由层 `maas` 子链路接入，双链路故障转移 | G1-a |
| G1-c | 真机直连验证四协议入口（chat/messages/responses/tools） | 拿到可用 accessKey |

**若凭证层实测不通过**：G1 降级为"协议层与模型层融合"（G3、G2 照做），MaaS 直连链路
本身不做，不引入不可控的凭证获取逻辑。

---

### G2. 新模型档位补充

MaaS 清单 15 个，与应用链路现有档位对比，**6 个是新的**：

| 模型名 | 类型 | reasoning | vision | context | 备注 |
|---|---|---|---|---|---|
| `qwen3.8-flash` | Qwen 新 flash 档 | false | false | 262144 | 现有 `flash` 之外的新版 |
| `glm-5.4` | GLM 新版 | true | false | 200000 | 现有只有 `glm-5.3` |
| `ling-3.1-flash` | Ling 新厂商 | false | false | 131072 | **新厂商，全新档位** |
| `minimax-m3.1-flash` | MiniMax | true | **true** | **1000000** | 视觉 + 1M 上下文，挂 anthropic provider |
| `step-5-preview` | Step 新厂商 | true | false | 131072 | **新厂商** |
| `kimi-k3.1-pro` | Kimi 新版 | true | false | 262144 | 现有只有 `glm-5.3` 等，Kimi 系补全 |

#### 2.1 融合方案

- **应用链路**（`src/qwenwork/constants.js` 的 `FALLBACK_MODELS` / `MODEL_ALIASES`）：
  补充上述 6 个键。**注意**：应用链路的模型名是应用档位名，MaaS 清单里的名是 MaaS 原生名——
  需要实测这 6 个名在**应用链路**上是否可用。社区清单是 MaaS 直连实测，应用链路可能不认。
  **先实测，再入表**：用 `test/traework-login.js` 同款的 chat 自测入口，逐个打一条最小请求，
  确认应用链路返回 200 才入 `FALLBACK_MODELS`，否则只入 `MODEL_ALIASES`（显式请求才透传）。

- **MaaS 链路**（`MAAS_ALIASES`，若 G1 落地）：客户端用应用档位名，MaaS 链路下翻译成
  MaaS 原生名。15 个 MaaS 名全量登记。

#### 2.2 落地批次

- G2-a：应用链路实测 6 个新档位，按结果分流入 `FALLBACK_MODELS` / `MODEL_ALIASES`
- G2-b：若 G1 落地，建 `MAAS_ALIASES` 全量表

**纪律**：`safety`（企业专属）不入任何表；`qwork-*`/`qmodel_latest`/`dmodel_latest`/
`gmodel_latest`（计划拦截键）不入表，沿用第一轮 P0-1 定案。

---

### G3. 模型能力位完整解析

社区实现的模型目录项带完整能力位：

```
{ id, provider, protocol, contextWindow, maxOutputTokens, modalities,
  reasoning, tool_call, temperature }
```

当前我们的 `normalizeModelRow`（`src/qwenwork/constants.js` 或 `src/qwenwork/index.js`）
解析了部分字段，**可能缺 provider/protocol/modalities**。

#### 3.1 融合方案

- 补全能力位解析：`provider`（决定走哪个协议端点）、`protocol`（anthropic/openai/other）、
  `modalities`（text/image）、`maxOutputTokens`。
- **协议映射表**落代码：`anthropic → /messages`、`openai → /responses`、`other → /chat/completions`。
  这是 MaaS 链路（G1）的路由依据，应用链路下也用于理解上游能力。
- **管理端展示**（见 A1）：能力位是逐模型能力覆盖层的依据。

#### 3.2 落地批次

- G3-a：能力位解析补全 + 单测锁形状
- G3-b：协议映射表落代码，MaaS 链路路由复用

---

### G4. is_vl 白名单扩展

当前 `src/qwenwork/chat.js` 的 `is_vl` 白名单只有 3 个（对照 Buddy2api v2.2.17 实测组合）：

```js
is_vl: modelKey === 'pro' || modelKey === 'flash' || modelKey === 'qwen3.8-max-preview',
```

MaaS 清单里 **`minimax-m3.1-flash` 是 vision:true**。若接入 MaaS 链路或补充新档位，
`is_vl` 需要扩展。

#### 4.1 融合方案

- **应用链路**：`minimax-m3.1-flash` 等新档位是否支持视觉，**先实测**再入白名单，不照抄 MaaS 清单。
- **MaaS 链路**：`is_vl` 从模型能力位（G3 的 `modalities`）读，不写死白名单——
  能力位是上游下发的权威，写死必然过期。

#### 4.2 落地批次

- G4-a：应用链路视觉能力实测，按结果扩 `is_vl` 白名单
- G4-b：MaaS 链路下 `is_vl` 改从能力位读（与 G1/G3 同步落地）

---

## 二、管理端页面融合

当前管理端千问模型管理页是**纯只读**（`ModelsView.vue` 第 6 行明示"本地不可编辑"，
`ModelInfoTable.vue` 的 switch 只是 visibleOnly 过滤，不是模型开关）。社区实现的
逐模型开关 + 能力覆盖 + 测试按钮是明确的功能缺口。

### A1. 逐模型开关 + 三项能力覆盖层（核心，管理端）

#### 1.1 社区实现（`ponm3ay/dsh-connect-qwenwork` 的 DETAIL.md）

**模型开关**：
- 每个模型一行，左边总开关。关掉是**本机偏好**，从选择器（`/v1/models`）消失，
  **适配层发出前拒绝**（不扣积分）。
- **刷新目录不重置开关**（开关是持久偏好，不是会话状态）。
- **目录里没有的模型自动清掉**（开关跟着目录走，目录删了的模型开关也删，不残留）。

**每模型三项能力覆盖层**（没动过 = 跟随目录，动过标「已改」+「跟随目录」按钮撤回）：
- **上下文**：200K / 500K / 1M / 2M。改小省积分，改大塞更多。
- **图片**：是否接受图片输入。**两个方向都能改**——目录说纯文本的可以打开，说有视觉的可以关掉。
  改完连上游请求里的 `is_vl` 标志都跟着变（与 G4 联动）。
- **思考强度**：该模型默认思考等级。**只对目录里标「会推理」的模型出现**。
  跟随默认 / 关闭 / 其余等级。

#### 1.2 融合方案

**后端**：
- 落盘 `data/qwenwork-model-overrides.json`（原子写，mtime 热读——与 `modelmap.js`/`keys.js`
  同款，改完立即生效，不重启）。结构：
  ```json
  {
    "disabled": ["ling-3.1-flash"],
    "overrides": {
      "minimax-m3.1-flash": {
        "context": "1000000", "vision": true, "reasoning": "high", "dirty": true
      }
    }
  }
  ```
  `dirty: true` 标记"已改，跟随目录可撤回"。
- 路由：
  - `GET /api/admin/qwenwork/model-overrides` —— 读覆盖层（合并目录默认 + 覆盖）
  - `POST /api/admin/qwenwork/model-overrides` —— 写覆盖（单字段更新，原子写）
  - `DELETE /api/admin/qwenwork/model-overrides/:model` —— 跟随目录（清覆盖）
- **发出前拦截**：`src/qwenwork/index.js` 的 `send()` 在选号后检查该模型是否被禁用，
  禁用则回 403（明确报错，不静默兜底、不扣积分）。**与 `model_allowlist` 的拦截语义一致**。
- **`/v1/models` 过滤**：`listModels()` 出口过滤禁用模型。

**前端**（`web/src/views/ModelsView.vue` 千问分支）：
- 模型表加"启用"开关列（`a-switch`，见 CLAUDE.md 的"小尺寸开关"教训——开关外写标签）。
- 三项能力用展开行或弹窗配置，动过标「已改」+「跟随目录」按钮。
- 思考强度只对 `reasoning:true` 的模型显示（G3 能力位）。

#### 1.3 落地批次

- A1-a：`qwenwork-model-overrides.json` + 路由 + 单测（覆盖层合并、撤回、目录删模型清开关）
- A1-b：`send()` 发出前拦截 + `/v1/models` 过滤
- A1-c：前端开关列 + 能力覆盖层 UI

---

### A2. 测试按钮 + 判定分档（管理端）

#### 2.1 社区实现

- **测连接**：读只读账号接口，**零消耗**，证明凭据有效 + 网关通 + 账号正常。
- **测全部模型**：逐个**串行**发最小请求，输出上限 8 token，读到第一个字节就断开。
- **测试**：单个模型。
- **判定分档**：`可用 / 无输出 / 不支持 / 登录失效 / 积分不足 / 被限流 / 超时网络失败`。
- **探测串行执行**，避免并发触发限流。

#### 2.2 融合方案

- 路由：`POST /api/admin/qwenwork/models/test { model? }`
  - 不带 `model` → 测全部（串行）
  - 带 `model` → 测单个
  - 返回每模型分档结果：`{ model, tier, latencyMs, message }`
- **零消耗口径**：测连接走只读接口（已有 `ping()` 或账号接口）；测模型用
  `max_tokens=8` 最小请求，**读到首字即断开**（不等整轮，省积分）。
- **分档判定**复用现有错误分类：
  - 200 有内容 → `可用`
  - 200 无内容 → `无输出`
  - 403 模型不可用 → `不支持`
  - 401 → `登录失效`
  - 402 / 额度类 → `积分不足`（复用 P2-2 的 `isQuotaOrModel`）
  - 429 → `被限流`
  - 超时/网络 → `超时网络失败`
- **前端**：ModelsView 加"测试"按钮（单个）+"测全部"按钮（顶部），结果用标签列展示分档。

#### 2.3 落地批次

- A2-a：`/models/test` 路由 + 分档判定 + 单测（各错误码 → 正确分档）
- A2-b：前端测试按钮 + 结果列

**与 A1 联动**：测试结果的"不支持"档，可直接触发用户去关模型或调能力覆盖层。

---

### A3. 模型可用性自检（与 A2 合并）

主源 `qwenwork2api` 的设置页有"模型可用性自检"：一键逐个真实打一条，记录每个模型在当前
套餐下是否放行（`Model is not available for this user` 一眼分清是套餐问题还是链路问题）。
**与 A2 的"测全部"是同一件事**，合并落地，不单列。

---

### A4. 导入已有登录态

#### 4.1 社区实现

主源 `qwenwork2api`：`POST /admin/api/import {access, refresh?, uid?}` 直接把客户端解出来的
token 灌进来，不用重新授权。

#### 4.2 融合方案

- 路由：`POST /api/admin/qwenwork/accounts/import { accessToken, refreshToken?, uid? }`
- **与现有 device flow 登录并存**：device flow 是默认入口，import 是给"已从客户端解出 token"
  的用户的快捷通道。
- **安全**：token 等同密码，落盘走 `web-accounts.json` 同款明文存储（上游要求原样重放），
  `fileperm.js` 收紧权限。
- **前端**：账号管理页加"导入登录态"按钮（粘贴 token 或上传解出文件）。

#### 4.3 落地批次

- A4-a：import 路由 + 落盘 + 单测
- A4-b：前端导入入口

---

### A5. 单号换指纹

#### 5.1 社区实现

主源 `qwenwork2api`：一号一盐一 `machineId`，平台/架构稳定派生，客户端版本永远跟运行时一致；
**控制台可单号换指纹**。

#### 5.2 融合方案

- 当前 `machineId` 是稳定派生（与设备绑定）。补"单号换指纹"：
  - 路由：`POST /api/admin/qwenwork/accounts/:id/rotate-fingerprint`
  - 生成新的 `machineId`（+ 盐），落盘覆盖该账号。
- **用途**：排查"某号被风控"时换指纹重试，与 Qoder 的"换号"思路一致但更轻（不换号，只换指纹）。
- **前端**：账号管理页该账号行加"换指纹"按钮。

#### 5.3 落地批次

- A5-a：rotate-fingerprint 路由 + 单测
- A5-b：前端按钮

---

### A6. 数据看板增强（可选，中等价值）

主源数据看板：今日调用 / 成功率 / 平均耗时（**含 P95**）/ 剩余积分，24h 堆叠柱，
模型分布，账号积分条，账号调用量，最近调用。

当前我们有 `DashboardView.vue` + 用量统计 + 请求日志。**对照补 P95 与模型分布**即可，
不重做看板。

- A6-a：`/api/admin/usage` 补 P95 耗时分桶（已有 P2-13 的 TTFB 分桶，复用口径扩展）
- A6-b：看板加模型分布图

---

### A7. Langfuse 可观测性（可选，外部依赖）

`aliyun/agent-exporter-to-langfuse`：把会话数据（对话轮次、模型调用、工具使用、token 消耗）
导出到 Langfuse，三层投递（本地缓冲 → SDK 直推 → 本地日志）。

**融合价值**：可观测性外部集成。**但需要 Langfuse 服务**，是外部依赖。

- 方案：`DUMATE_QWENWORK_LANGFUSE=1` + `DUMATE_LANGFUSE_URL` + `DUMATE_LANGFUSE_KEY` 开启，
  把 `reqlog.record` 的请求数据异步导出。关闭时零开销。
- **优先级最低**，外部依赖 + 非核心链路，放最后。

---

## 三、不融合清单（带依据）

| 项 | 来源 | 不融合依据 |
|---|---|---|
| 企业专属 `safety` 档 | qwenwork2api | 企业内容，第一轮已定案，不入任何表 |
| 每日免费积分领取 | qwenwork2api | **上游已停发每日额度**（P1-2 实测 `daily_credits` 恒 0），功能无意义。"没有接口时如实报"的口径已落地 |
| PAT 双登录 | cpa-plugin | 千问是否支持 PAT **未确认**，我们已有 device flow，不贸然做 |
| SSO / 多用户 | 各源 | 企业特性，排除 |
| Qoder/WorkBuddy 专属功能 | cpa-plugin | 本轮聚焦千问，跨通道功能另立方案 |

---

## 四、实施批次与验证计划

### 优先级排序

| 优先级 | 批次 | 价值 | 依赖 |
|---|---|---|---|
| P0 | G2-a 新模型档位实测入表 | 直接扩模型面，低风险 | 无 |
| P0 | G3-a 能力位解析补全 | A1/G4 的地基 | 无 |
| P0 | A1 逐模型开关 + 能力覆盖层 | 管理端核心缺口 | G3 |
| P1 | A2 测试按钮 + 判定分档 | 管理端诊断能力 | G3（能力位）、P2-2（额度分类） |
| P1 | A4 导入登录态 | 账号管理补全 | 无 |
| P1 | A5 单号换指纹 | 风控排查工具 | 无 |
| P1 | G4-a is_vl 实测扩展 | 视觉能力补全 | G2 实测 |
| P2 | G1 MaaS 直连链路 | 架构级简化，但凭证层未实测 | G3、G4-b、凭证实测 |
| P2 | A6 看板增强 | 锦上添花 | P2-13 已落地 |
| P3 | A7 Langfuse | 外部依赖，非核心 | 无 |

### 验证计划

- **离线单测**：每个后端批次配 `test/unit/qwen-*.test.js`，锁形状与边界。
- **离线 verify**：A1 的覆盖层合并、A2 的分档判定、G2 的模型表形状，配 `test/verify-qwen-*.js`。
- **真机验证**：
  - G2-a：用 `test/traework-login.js` 同款 chat 自测入口，逐个打 6 个新档位，确认 200。
  - A2：管理端点"测全部"，逐模型确认分档。
  - G1：拿到可用 accessKey 后，四协议入口各打一条最小请求。
- **回归**：`npm run verify` 全绿；改完后端代码重启对应进程（9080/9081）。

### 风险与纪律

1. **MaaS 凭证层是 G1 的硬前置**。实测已通过（Windows/WSL），但**不默认开启
   `DUMATE_QWENWORK_MAAS`**——只有显式设 `1` 且凭证可用才切链路，否则回落应用链路。
2. **新模型档位先实测再入表**。MaaS 清单是 MaaS 直连实测，应用链路可能不认同名——
   **不照抄**，逐个打一条确认。
3. **is_vl 不照抄 MaaS 清单**。应用链路视觉能力独立实测，MaaS 链路下改从能力位读。
4. **覆盖层是持久偏好，不是会话状态**。刷新目录不重置，目录删模型清开关——与社区实现一致。
5. **测试按钮零消耗口径**：测连接走只读接口，测模型 `max_tokens=8` 首字即断。

---

## 五、与第一轮的衔接

第一轮（P0-1~P2-2）已落地：模型档位表、思考开关（`DUMATE_QWENWORK_REASONING`）、
`reasoning_effort` 透传、[DONE] 信封加固、额度转 429。本轮在此基础上：

- **网关层**：补 MaaS 直连链路（G1）、新档位（G2）、能力位（G3）、is_vl（G4）。
- **管理端**：补逐模型开关与能力覆盖（A1）、测试按钮（A2）、导入登录态（A4）、换指纹（A5）。
- **不碰**：企业档、每日额度、PAT（与第一轮纪律一致）。

两轮合并后，千问通道在网关能力与管理端页面上达到社区实现的同等水平，且保留
"计划拦截键不入表""上游停发的功能不做""凭证未实测不默认开启"三条纪律。

---

## 六、落地记录（2026-11-27）

### 已落地

| 批次 | 内容 | 文件 | 验证 |
|---|---|---|---|
| **G2-a** | 三个 MaaS 新档位（`qwen3.8-flash`/`glm-5.4`/`ling-3.1-flash`）入 `MODEL_ALIASES`；另外三个（`kimi-k3.1-pro`/`minimax-m3.1-flash`/`step-5-preview`）第一轮已入表 | `src/qwenwork/constants.js` | `test/unit/qwen-model-tiers.test.js` |
| **G3-a** | `normalizeModelRow` 补 provider/protocol/maxOutputTokens/modalities/reasoning/toolCall；`resolveProtocol` 按 provider 映射协议（anthropic→messages / openai→responses / 其它→chat）；静态兜底同步 | `src/qwenwork/index.js`、`constants.js` | `test/unit/qwen-model-capabilities.test.js`（10 项） |
| **A1** | `model-overrides.js` 原子写 + mtime 热读；逐模型开关（send 发出前 403 拦截、`/v1/models` 过滤）、三项能力覆盖、prune 目录清理；三个管理 API；前端开关列 + 覆盖层 UI | `src/qwenwork/model-overrides.js`、`index.js`、`src/admin/routes/qwenwork.js`、`web/src/views/ModelsView.vue`、`web/src/api/qwenwork.ts` | `test/unit/qwen-model-overrides.test.js`（10 项） |
| **A2** | `test-probe.js` 分档判定（社区七档 + server/forbidden 两档细分）；`/models/test` 路由串行测试（`max_tokens=8`）；前端测试按钮 + 结果标签 | `src/qwenwork/test-probe.js`、`src/admin/routes/qwenwork.js`、`web/src/views/ModelsView.vue` | `test/unit/qwen-test-probe.test.js`（11 项） |
| **A4** | `POST /accounts/import` 导入 access/refresh/uid（有 uid 拉用户信息补昵称/套餐，失败不阻断）；前端账号页导入弹窗 | `src/admin/routes/qwenwork.js`、`web/src/api/qwenwork.ts`、`web/src/views/AccountView.vue` | `test/unit/qwen-import-fingerprint.test.js`（3 项导入） |
| **A5** | `POST /accounts/:id/rotate-fingerprint` 换指纹（只改 machineId + 清 lastError，不动 token/uid）；前端换指纹按钮 | 同上 | `test/unit/qwen-import-fingerprint.test.js`（3 项指纹） |
| **A6** | TTFB 分桶补 P95（复用 `percentileOf` 同一条直方图，无样本 null）；UsageView 加 p95 卡；模型分布已有（"今日按模型"+"按模型"卡），不重做 | `src/usage-agg.js`、`web/src/views/UsageView.vue`、`test/unit/usage-ttfb-hitrate.test.js` | 单测 9/9（含 3 项 P95 边界） |
| **G4** | `is_vl` 改为**上游目录优先**（实测 14 档全 `is_vl:true`），目录未拉到回落旧 3 档白名单；`toolCall` 无字段时给 null 不编 false；导出 `cachedModelCapabilities()` 供 chat.js 同步查 | `src/qwenwork/index.js`、`chat.js`、`test/unit/qwen-vl-catalog.test.js` | 单测 4/4 + 真机 14 档目录验证 |
| **G2 补完** | 真机逐档验证 6 个新档位全部 200，`FALLBACK_MODELS` 从 9 档扩到 15 档（14 目录档 + lite/flagship 两个隐藏档）；断网时 `/v1/models` 不再缺档 | `src/qwenwork/constants.js`、`test/unit/qwen-model-tiers.test.js` | 单测 6/6 + 6 档真机对话 |

**全量回归**：`npm test` 1495/1495 通过、`npm run verify` 50/50 通过、`web npm run build` 通过。

### 未落地（按方案纪律暂缓）

- **A7 Langfuse**：可选导出模块已落地（默认关，需 URL/KEY）；没有 Langfuse 服务时保持关闭。

### G1 落地（2026-11-27）

- `src/qwenwork/maas.js`：Windows/WSL 凭证桥（PowerShell 读 DPAPI OSCrypt key +
  base64 回传，不落明文临时文件），AES-256-GCM 解密 `engine-maas-key.dat`，
  内存缓存到过期前 1 分钟；只暴露元数据不打印 accessKey。
- `src/server.js`：千问直连 provider 在 `DUMATE_QWENWORK_MAAS=1` 且凭证可用时切到
  MaaS；凭证不可用自动保持应用链路，默认关。
- `src/qwenwork/index.js`：`status().maas` 暴露启用/可用/过期时间；测试路由只测免费档。
- 真机验证（免费档 `minimax-m3.1-flash`）：网关 `/v1/chat/completions` 非流式/流式、
  `/v1/messages`、`/v1/responses`、`tools` 工具调用全 200；`/v1/models` 404（预期）。
- 测试纪律：第三方档位不测（烧积分）；minimax3.1flash 免费，按钮与后端都只放行这一档。

### A7 落地（2026-11-27）

- `src/langfuse-export.js`：默认关；`DUMATE_QWENWORK_LANGFUSE=1` + `DUMATE_LANGFUSE_URL`
  + `DUMATE_LANGFUSE_KEY` 才启用；默认只导 qwenwork 通道，`DUMATE_LANGFUSE_QWENWORK_ONLY=0`
  可导出全部通道。用内置 http/https POST `/api/public/ingestion`，无第三方 SDK。
- `src/reqlog.js`：懒加载 hook，异步导出、失败吞掉、队列有界；不导出请求/响应正文、key/token/IP/UA。
- 管理端 `/api/admin/qwenwork/status` 和管理页「模型信息」区显示 MaaS/Langfuse 状态元数据。
- `test/unit/langfuse-export.test.js` 锁白名单字段与默认关行为。
- 投递失败有界落 `data/langfuse-local.jsonl`（只记事件 id/时间，不记正文/凭证）。
- MaaS 凭证读取加 30 秒负缓存 + 单飞：凭证缺失/轮换间隙不会每请求起一次 PowerShell/DPAPI。
- MaaS 流式收尾去重 `[DONE]`，`mapped_model` 埋点上报原生名，`link=maas` 标记备选链路。

### 落地踩坑

1. **覆盖层的 `effectiveReasoning` 类型**：后端 `mergedView` 里可能是布尔（目录值）或字符串
   （覆盖值），前端类型是 `boolean | string`——不能写成 `boolean` 或 `number`，否则 vue-tsc 报错。
2. **`modelColumns` 的响应式依赖**：`modelRows` computed 里读 `qwOverrides.value` 后，
   开关状态才会随覆盖层变化更新——漏了这一步界面会显示旧的禁用状态。
3. **测试请求不要传 `skipRepair`**：`send()` 的修复判定是无工具请求时为 false，
   多传一个不存在的 opts 字段只会误导后来者。
