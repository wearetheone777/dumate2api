# GitHub 百度搭子生态全面检索与可融合项评估（2026-11-15）

检索时间：2026-11-15 02:30 ~ 03:10（Asia/Shanghai）
检索对象：GitHub 上全部与「百度搭子 / DuMate / 千帆桌面版」相关的公开仓库
本仓基线：`main@a0ffae0`（feat(trae): 调研融合 20 项全落地）
社区数据截止：**2026-11-14**（`s-silt/magpie-dumate-local` 最后一次提交）

---

## 0. 一句话结论

社区在 **2026-11-13 / 11-14 集中出了一批新东西**，全部围绕「桌面端登录态 + 真实模型清单 + 推理档位 + 积分口径」，
方向与本仓「搭子通道最薄」的缺口**正好互补**。可融合项按价值分三档：

| 档 | 数量 | 代表项 |
|---|---|---|
| **P0（高价值 / 低风险 / 有现成实现可移植）** | 3 | 22 个模型清单自动导入、V4.1 推理四档、积分按 product 分池 |
| **P1（中价值 / 需真机验证）** | 2 项（含 3 个子项） | 倍率测量升级为双点解斜率；双凭证域 / cookie 形态 / token 韧性 |
| **P2（可选 / 边缘）** | 3 | 进程环境变量发现、electron.log 取证、地域连通性文档 |

**必须先说清的一件事**：社区 2026-11-02 那批（CLI 模式 + stdio MCP + 端口自愈）**本仓已经对齐**
——`src/mcp-server.js` 有 `chat` / `list_models` / `get_status` 三工具（与参考实现同名），
`package.json` 有 `npm run cli`，是 2026-11-08 那批融合时吸收的。
所以「可融合」真正剩下的是 **11-13/14 那批新发现**，别把已完成的事再排一遍。

> 落地情况与验证证据见 [FUSION-LANDING-2026-11-15.md](FUSION-LANDING-2026-11-15.md)。

**本仓在社区面前并不落后**：模型上限表（400 错误体解析 + 自学习）、四协议翻译、五通道池化、FEFO、
「播报即收尾」修复，社区都没做。真正被社区超过的只有三处：**模型面窄、思考档位被丢弃、积分口径不拆分**。

模型面的准确差距（逐条数过，不是估的）：

| 口径 | 本仓 | 社区 duanz | 差 |
|---|---|---|---|
| `MODEL_NAMES` 名称表条目 | 15 | 22 | −7 |
| `/v1/models` 实际暴露（`DEFAULT_EXPOSED`） | **3** | 22 | **−19** |
| 可对话条目（去掉 `model-artifact-validate` 这种非对话项） | 13 | 22 | −9 |
| 逐模型上下文/输出元数据 | 无 | 22 条齐备 | **全缺** |

**本仓缺的 10 个对话模型**：`deepseek-v4-flash-0731`、`doubao-seed-2-0-pro`、`ernie-4.5-turbo-vl-32k`、
`qwen2.5-vl-32b-instruct`、`qwen3.5-27b`、`qwen3.5-35b-a3b`、`qwen3.5-397b-a17b`、`qwen3.8-max`、
`kimi-k3`、`dm-auto-model/mm.L1`。

---

## 1. 检索方法（可复现）

GitHub 仓库 API 未认证被限流（`403 rate limit exceeded`），改用四条通路：

```bash
# ① 仓库搜索页 HTML（匿名可用，只返回名字/描述匹配）
curl -sSL "https://github.com/search?q=dumate&type=repositories" | grep -oE '"hl_name":"[^"]*"'
curl -sSL "https://github.com/search?q=dumate+api&type=repositories" | grep -oE '"hl_name":"[^"]*"'

# ② raw 直连被 RST，走 ghproxy 镜像
curl -sSL "https://ghproxy.net/https://raw.githubusercontent.com/<owner>/<repo>/main/README.md"

# ③ 整包下载（codeload 直连可用，比逐文件抓快且不漏）
curl -sSL "https://codeload.github.com/<owner>/<repo>/zip/refs/heads/main" -o repo.zip

# ④ 提交历史（atom feed 直连可用，ghproxy 不透传）
curl -sSL "https://github.com/<owner>/<repo>/commits/main.atom"
```

**检索覆盖边界（如实声明）**：
- `in:readme` / 中文关键词（`搭子`）搜索在匿名态被 GitHub 拒（返回空），**只覆盖了仓库名与描述含 dumate 的仓库**。
- 代码级搜索（code search）必须登录，未做 → 可能存在只把 dumate 写在代码里、名字无关的仓库，本轮未发现。
- 已逐个核对 20 个候选仓库，确认 8 个与本仓技术栈相关、1 个边缘相关（业务部署包）、9 个无关（同名词），
  另有 1 个协议方向与本轮目标不同，已按范围剔除。

---

## 2. 仓库全景

| # | 仓库 | ★ | 最后提交 | 形态 | 与本仓关系 |
|---|---|---|---|---|---|
| 1 | [DuanZGit/dumate-duanz](https://github.com/DuanZGit/dumate-duanz) | — | 2026-11-13 | magpie 插件 | **实测倍率 + 积分分池 + 22 模型清单** |
| 2 | [RanceLee233/dumate-rance](https://github.com/RanceLee233/dumate-rance) | 3 | 2026-11-13 | magpie 插件 | **V4.1 推理四档映射** |
| 3 | [R227BOUT/magpie-dumate](https://github.com/R227BOUT/magpie-dumate) | 7 | 2026-11-13 | magpie 插件（上游） | **模型清单导入规则、cookie 序列化、token 韧性** |
| 4 | [Alphaxiaoteng/dumate2api](https://github.com/Alphaxiaoteng/dumate2api) | 7 | 2026-11-02 | Python 网关 | **CLI/MCP 已于本仓 11-08 批次对齐**；日志取证与端口自愈可参考 |
| 5 | [s-silt/magpie-dumate-local](https://github.com/s-silt/magpie-dumate-local) | — | **2026-11-14** | magpie 插件 | 威胁模型、地域连通性实测 |
| 6 | [Wang-JQ77/dsh-llm-dumate](https://github.com/Wang-JQ77/dsh-llm-dumate) | 1 | 2026-08-28 | DSH 插件 | 进程环境变量发现（PEB） |
| 7 | [Wang-JQ77/dumate-api](https://github.com/Wang-JQ77/dumate-api) | 1 | 2026-08-28 | Python 网关 | 积分伪模型、档位别名映射 |
| 8 | [baidubce/dumate-bench](https://github.com/baidubce/dumate-bench) | — | 官方 | 评测框架 | 模型能力基准（非网关） |
| 9 | [yangqxuan-work/Dumate-Agent](https://github.com/yangqxuan-work/Dumate-Agent) | — | — | 业务部署包 | 无关（商机转化 Agent） |
| — | 同名词无关仓库 | — | — | — | `duppcc-a/dumate`、`see-lift/dumate`(Edumate)、`361698/*`、`Alexis-7ero/*`、`pipiwolve/*` |

> 本仓 `wearetheone777/dumate2api`（★34）仍是该生态星标最高的实现，社区三个插件都在 README 里
> 引用彼此的派生化关系（duanz → rance → magpie-dumate），说明**这一层是「一个协议、多处包装」**，
> 协议情报直接复用，不必重写。

---

## 2.5 能力矩阵（本仓 vs 社区最好实现）

> 这张表回答「到底哪些是真差距」。✅ = 有且可用；⚠️ = 有但口径/覆盖不足；❌ = 没有。

| 能力 | 本仓 | 社区最好实现 | 状态 |
|---|---|---|---|
| 四协议翻译（OpenAI / Anthropic / Google / Responses） | ✅ 四套独立翻译层 | ❌ 最多 OpenAI + Anthropic | **本仓领先** |
| 按模型上限钳制 + 400 错误体解析 + 自学习 | ✅ 三家上游三种错误形态 | ❌ | **本仓领先** |
| 多账号池化 / 冷却 / 熔断 / FEFO | ✅ 五通道共用 | ❌ | **本仓领先** |
| 管理端（模型/账号/用量/告警/日志） | ✅ Vue 全功能 | ❌ 社区全是命令行插件 | **本仓领先** |
| 「播报即收尾」修复 / DSML 去污染 | ✅ 四通道验证 | ❌ | **本仓领先** |
| 22 个模型 + 逐模型上下文元数据 | ❌ 13 个可对话、无上下文声明 | ✅ duanz | **可融合（P0-1）** |
| 模型清单自动导入（读客户端 opencode.json） | ❌ 纯手工登记 | ✅ magpie 0.3.0 | **可融合（P0-1）** |
| 搭子推理档位（none/low/high/max） | ❌ 主动剥掉 | ✅ rance 0.3.1 | **可融合（P0-2）** |
| 积分按 product 分池 / active 过滤 | ❌ 读拍平总额 | ✅ duanz | **可融合（P0-3）** |
| 倍率覆盖 | ⚠️ 5 档（口径稳） | ✅ 16 个 output | 可扩展（P1-1） |
| 倍率测量方法 | ⚠️ 单点前后差 | ✅ 双点解斜率 | 可升级（P1-1） |
| Cookie 形态（按域 + 引号 + csrf） | ⚠️ 全量拼串 | ✅ magpie | 可改进（P1-2） |
| token 缓存分区 / 并发刷新合并 | ⚠️ 按账号，无合并 | ✅ 按 cookie 哈希 + pending | 可改进（P1-2） |
| 桌面登录态导入 | ✅（tag 前置，早于社区） | ✅ | 平 |
| 签到 | ✅ 自建 + 账本 | ✅ | 平 |
| MCP / CLI | ✅ 三工具同名 + `npm run cli` | ✅ | 平（已对齐） |
| 进程发现 | ⚠️ 只解析 `--port=` | ✅ 命令行 + PEB 环境变量 | 可补充（P2） |
| `X-Dumate-Inapp-Key` 身份头 | ❌ 从未发 | ✅ 从 electron.log 读 | 可补（P2） |
| 地域连通性结论 | ❌ 无记录 | ✅ 美国超时 / 香港可通 | 补文档（P2） |
| 独立威胁模型文档 | ❌ 只有散落约定 | ✅ s-silt 2026-11-14 | 补文档（P2） |

**读法**：社区领先的 6 项里有 4 项是「数据 vs 没有数据」（模型清单、倍率、分池、地域），
2 项是「一行 if 的协议细节」（推理档位、cookie 引号）。本仓领先的 5 项都是**结构性工程投入**，
不是社区短期能补的。

---

## 3. 最新开发批次时间线

```text
2026-08-19/28  Wang-JQ77 两条：Windows 桌面代理封装 + DSH 插件（早期路线，端口 8765/动态）
2026-11-02     Alphaxiaoteng：初始提交即带 CLI + stdio MCP（本仓 11-08 已对齐）
2026-11-13     R227BOUT 0.3.0：跨平台登录 + 真实模型清单（致谢 RanceLee 的问题发现）
2026-11-13     RanceLee233 0.3.1：V4.1 reasoning 四档 + 显式关闭 thinking
2026-11-13     DuanZGit：可读模型名 + 实测倍率（16 模型）+ 积分分池
2026-11-13     微信公众号 HelloRanceLee 发文（问题源头，被 R227BOUT 引用）
2026-11-14     s-silt：安全威胁模型 + 美国/香港 VPS 连通性实测
```

**判断**：11-13/14 这一批不是「功能堆叠」，而是围绕同一组新发现（客户端 `opencode.json` 是模型真相源、
`deepseek-v41-flash` 独占思考开关、`totalPoints` 混了别的产品）的**并发修复**。三条独立证据互相对上，
可信度高。

---

## 4. 逐仓详解

### 4.1 DuanZGit/dumate-duanz —— 信息密度最高

**最新功能（2026-11-13）**

1. **实测积分倍率表**（16 个模型的 output 倍率、4 个 input 倍率）：

| 模型 id | 积分/千 output | 积分/千 input |
|---|---|---|
| `kimi-k3` | 6.235 | 1.213 |
| `qwen2.5-vl-32b-instruct` | 2.024 | 0.30×估 |
| `model-text` | 2.014 | 0.30×估 |
| `deepseek-v4-flash-0731` | 2.007 | 0.30×估 |
| `deepseek-v41-flash` | 2.000 | 0.611 |
| `ernie-4.5-turbo-vl-32k` | 1.997 | 0.30×估 |
| `qwen3.8-max` | 1.905 | 0.625 |
| `doubao-seed-2-0-pro` | 0.193 | 0.30×估 |
| `glm-53-flash` | 0.122 | 0.30×估 |
| `kimi-k31` | 0.117 | 0.30×估 |
| `qwen38-flash` | 0.100 | 0.30×估 |
| `deepseek-v4-pro` | 0.100 | 0.089 |
| `qwen3.5-397b-a17b` | 0.098 | 0.30×估 |
| `glm-53` | 0.087 | 0.30×估 |
| `qwen3.5-27b` | 0.067 | 0.30×估 |
| `qwen3.5-35b-a3b` | 0.050 | 0.30×估 |

   - 方法：**双长度双点解斜率**。短请求 `"请只回复两个字：收到"`（max_tokens 24）+ 长请求 `"请从 1 数到 200…"`（max_tokens 800），
     两次读 `usedPoints` 差值，用 completion_tokens 差解出纯 output 斜率，固定开销自然抵消。
   - 429 退避：`sleep(20s × (attempt+1))`，最多 8 次（"the limit is per account"）。
   - 换算锚点：Pro ¥59 / 25000 积分 → ¥0.00236/积分；汇率 7.10；`cost(USD/M) = 积分每千 × 1000 × 0.000332`。
   - 缓存：网关不公布，读按 input 10%、写按 input 100%（"usual vendor shape, nothing measured"）。
   - **`dm-auto-model/*` 六个别名刻意不给价格**（"具体模型由百度侧在请求时决定，钉一个数字就是撒谎"）。

2. **积分分池**：`quota_overview` 把所有钱包拍平成一个 `totalPoints`，其中有一个 5,000 积分的包
   标记 `product:"comate"`（另一个百度产品共用同一钱包）。拆分规则：
   - `isDuMate = (p) => (p?.product ?? "dumate") === "dumate"`
   - 只统计 `status === "active"`（排队的月度 Pro 授予是 `status:"inactive"`，未来期；计入会虚报 7 倍余额）
   - 订阅期号：`第 N/M 期`（active 那条在数组里的位置）
   - 最早到期：`pointsExpireDate`（积分死）优先于 `expireDate`（订阅死）
   - `usedPoints` 包级为 0 时回落到 `Math.min(全站 used, duTotal)`

3. **22 个对话入口清单**（`models.default.json`，`asOf: 2026-11-13`，过滤掉 21 个非对话入口）：

| id | 上下文 | 输出 | 视觉 | 推理 |
|---|---|---|---|---|
| `deepseek-v4-flash-0731` | 200,000 | 32,000 | — | — |
| `deepseek-v4-pro` | 1,000,000 | 384,000 | — | — |
| `deepseek-v41-flash` | 1,000,000 | 384,000 | ✓ | — |
| `dm-auto-model/mm.L0` | 1,000,000 | 384,000 | ✓ | — |
| `dm-auto-model/mm.L1` | 1,000,000 | 384,000 | ✓ | — |
| `dm-auto-model/mm.L2` | 1,000,000 | 384,000 | ✓ | — |
| `dm-auto-model/text.L0` | 1,000,000 | 384,000 | ✓ | — |
| `dm-auto-model/text.L1` | 1,048,576 | 1,048,576 | ✓ | — |
| `dm-auto-model/text.L2` | 983,000 | 128,000 | ✓ | — |
| `doubao-seed-2-0-pro` | 200,000 | 32,000 | — | — |
| `ernie-4.5-turbo-vl-32k` | 200,000 | 32,000 | — | — |
| `glm-53` | 1,000,000 | 128,000 | — | — |
| `glm-53-flash` | 1,000,000 | 128,000 | ✓ | — |
| `kimi-k3` | 1,048,576 | 1,048,576 | ✓ | — |
| `kimi-k31` | 1,048,576 | 1,048,576 | ✓ | — |
| `model-text` | 1,000,000 | 384,000 | ✓ | — |
| `qwen2.5-vl-32b-instruct` | 200,000 | 32,000 | — | — |
| `qwen3.5-27b` | 200,000 | 32,000 | — | — |
| `qwen3.5-35b-a3b` | 200,000 | 32,000 | — | — |
| `qwen3.5-397b-a17b` | 200,000 | 32,000 | — | — |
| `qwen3.8-max` | 983,000 | 128,000 | ✓ | — |
| `qwen38-flash` | 983,000 | 128,000 | ✓ | — |

4. UA 版本跟随官方：`DuMate/1.0.91`（文档公布的个人版最新）。

**与本仓差异**

| 能力 | 本仓 | duanz | 差 |
|---|---|---|---|
| 模型条目 | `MODEL_NAMES` 15 条 / 对外暴露 3 条 / 可对话 13 条 | 22 | **缺 10 个**（豆包/文心/Qwen3.5 系/Qwen3.8-max/kimi-k3/deepseek-v4-flash-0731/mm.L1） |
| 模型元数据 | `MODEL_NAMES` 人工标注真实后端名 | 每模型 context/output/视觉/工具 | 本仓**没有**逐模型上下文声明 |
| 倍率表 | 5 档（L2/model-text/L0/glm-5/L1） | 16 个 output + 4 个 input | 本仓覆盖窄，但**口径更稳**（400 错误体 + 自学习） |
| 积分分池 | 无 `product` 拆分 | 有 | **本仓会把其他产品积分算进搭子余额** |
| 到期口径 | `expireDate` | `pointsExpireDate` 优先 | 本仓 FEFO 用错字段会误判临期 |

**融合评级：P0（模型清单 + 分池）、P1（倍率表口径扩展）**

---

### 4.2 RanceLee233/dumate-rance —— V4.1 推理档位的唯一实现

**最新功能（0.3.1，2026-11-13）**：`reasoning.mjs` 的 `normalizeReasoningBody`，全文 16 行，逻辑完整：

```
仅当 model === "deepseek-v41-flash" 且 reasoning_effort ∈ {none, low, high, max}：
  none  → 删除 reasoning_effort，thinking.type = "disabled"，enable_thinking = false
  low   → 改写为 "high"（百度渠道 low 与 high 实际同强度）
  high  → 保留，thinking.type = "enabled"，enable_thinking = true
  max   → 同上
其他情况：原样返回（含畸形的 body / 其他模型 / 未知档位）
```

关键设计（`test/reasoning.test.mjs` 锁死）：
- 其他模型、缺失档位、未知档位（`future-level`）、`invalid JSON`、`null`、`undefined` **一律不动**
- 入参可以是 `string` / `Uint8Array` / `ArrayBuffer` 三种形态（SDK 的 fetch 可能给任意一种）
- 映射后 `messages` / `tools` **深度相等**（不允许顺手改请求体）

**真机验证记录（作者，2026-11-13）**：显式关闭时网关不返回推理内容；`max` 能返回推理 token；
`high` 下普通计算正确、SSE 工具调用完整返回、接收工具结果后续答正确。
**明确声明**："短请求不能证明实际计算预算"。

**与本仓差异**

本仓 `src/server.js` 有**两处** `delete openaiReq.reasoning_effort`，都在
`if (route.target.needsModelMap)` 分支里（也就是「所有搭子路径」）：
- 一处是通用/OpenAI 路径，注释「reasoning_effort 只给直连通道，搭子透传前剥掉」
- 一处是 Anthropic 路径（`anthropicToOpenAI` 之后），注释「思考强度是直连通道（Qoder）才下发的字段……
  翻译层加的，这里剥干净」

后果：
- 客户端传 `max` → 被丢弃 → 上游按默认档跑，**用户无法把思考预算拉满**
- 客户端传 `none` → 被丢弃 → 上游仍然思考 → `budget.js` 的下限 65536 照样被 reasoning 吃掉

这与本仓 `FUSION-BACKLOG` 里记录的「思维链失控」（32768 撞满、正文 0、耗时 7.5 分钟）是**同一问题的另一半**：
本仓用「抬高下限」兜，社区用「关掉思考」解。两者叠加才对。

**本仓的既有决策（必须尊重，不能当成「没做」）**

`test/unit/effort-passthrough.test.js` 锁定了一条 2026-10-30 的决定：

```
翻译层（anthropic.js / responses.js）把 Anthropic 的 output_config.effort、
thinking.effort、budget_tokens 区间（≤1024 minimal / ≤4096 low / ≤16384 medium /
≤32768 high / 更大 max）统一翻译成 reasoning_effort；
直连通道（Qoder）按模型合法档归一化后下发；
搭子路径则 delete 掉——理由是「多余字段原样进云端，行为未知——剥掉」。
```

**所以 P0-2 不是「新增一个功能」，而是「用 2026-11-13 的新证据推翻一条保守决策」。**
新证据是：`deepseek-v41-flash` 认 `none/low/high/max` 四档，且 `none` 必须**显式**发
`thinking:{type:'disabled'}` + `enable_thinking:false` 才真的不思考；`low` 与 `high` 实际同强度。

**词表不一致的坑（本报告最重要的一条工程细节）**：本仓翻译层产出的是
`minimal/low/medium/high/max` 五档，rance 只处理 `none/low/high/max` 四档，**其余原样不动**。
所以照抄 rance 会出现：客户端传 `budget_tokens: 16384`（本仓翻成 `medium`）→ 归一化函数不认识
`medium` → 原样发给上游 → 上游行为未知。三种处理：

| 方案 | 做法 | 风险 |
|---|---|---|
| **A 严格照抄**（推荐先做） | 只对 `none/low/high/max` 生效；`minimal`/`medium` 与现在一样**剥掉**（不回退到旧行为就等于没改） | 无新增风险；`medium` 仍不可用 |
| **B 扩展词表** | `minimal → none`、`medium → high` | 需实测上游是否接受；`minimal→none` 会让「稍微想想」变成「完全不想」 |
| **C 只做开关** | 不碰档位字符串，只补 `thinking` / `enable_thinking` 两个开关 | 最小改动；但 `none` 靠 `reasoning_effort:"none"` 未必被上游识别 |

**结论**：先做 A（一条 `if` 的事，可测可回滚），B 要一次真机探针确认 `medium` 的行为再上。

**融合评级：P0**（改动小、有测试可抄、直接解一类线上问题）

---

### 4.3 R227BOUT/magpie-dumate 0.3.0 —— 模型清单导入的参考实现

**最新功能（2026-11-13）**

1. **跨平台桌面登录识别**：macOS `~/Library/Application Support/qianfan-desktop-app/`、
   Windows `%APPDATA%\qianfan-desktop-app\`、Linux `$XDG_CONFIG_HOME/qianfan-desktop-app/`；
   `DUMATE_USER_DATA_DIR` 任何平台优先。0.2.1 只拼 `%APPDATA%`，在 Mac/Linux 上退化成相对路径
   ——这是 0.3.0 的修复缘由（公众号文章指出的问题）。**对本仓无影响（Windows 专用），但路径探测的写法可以借。**

2. **模型清单导入（`models.mjs` 的 `importModels`）—— 这是全生态最严谨的一份**：

```js
源：<数据目录>/qianfan_desk_xdg/<当前激活账号>/config/opencode/opencode.json
    → provider.QianfanPersonalQuota.models
只取：id / 显示名 / limit.context(回落 limit.input) / limit.output / modalities.input /
      tool_call / reasoning
永不复制：endpoint、apiKey、headers、plugins、commands、permissions
过滤：key 以 model- 开头且 ≠ model-text → 排除
      embedding | reranker | ocr | llm-mock | dumate-image → 排除
      key ≠ id 且源里存在 id → 视为重复别名，排除
必须：context > 0 且 output > 0 且 输入模态含 text
特例：id === deepseek-v41-flash → variants: { none, low, high, max }
快照：独立目录（不与任何 fork 共用）、原子写（tmp + rename）、0600、
      schema:1、读回时**再走一次同一过滤器**（防篡改快照注入 endpoint/key）
降级：源缺失 → 快照 → 包内带日期的参考清单 → 硬编码兜底
```

3. **cookie 序列化（`buildCookieHeader`）**—— 复刻客户端 `utils/cookie.js`：

```
• 按 hostname 过滤 domain（去掉前导 "." 再比 host 或后缀）
• 值两端引号剥掉
• 值含 [:|;=空格] 时重新加引号  ← POST 端点报「登录凭证已过期」的根因就在这里
• csrftoken = bce-user-info cookie 的值（同域过滤）
• REQUIRED_COOKIES = ["bce-sessionid"]
```

4. **token 韧性**：`tokenCache` 按 cookieHeader 分区；服务端 `expired_at` 优先，兜底 1 小时（"server gives ~14h"）；
   提前 5 分钟失效；并发刷新合并（`pending`）。

**与本仓差异**

| 项 | 本仓 | magpie 0.3.0 |
|---|---|---|
| 桌面登录态 | `auth-import.js`（tag 前置排布已实测，**比社区早**） | `readDesktopLogin`，排布同 |
| cookie 拼接 | 全量拼串，只排除统计域 | **按域过滤 + 引号规则 + csrf** |
| 模型清单来源 | 无（纯手工登记） | 读 `opencode.json` + 快照 |
| 快照防注入 | 无 | 读回再过滤一遍 |

**融合评级：P0（清单导入规则）、P1（cookie 形态）**

---

### 4.4 Alphaxiaoteng/dumate2api —— 三模（HTTP / CLI / MCP）与日志取证

**最新功能（2026-11-02）**

1. **凭证发现走客户端日志**（新的取证路径）：

```text
macOS   ~/Library/Application Support/qianfan-desktop-app/log/electron.log(.1)
Windows %APPDATA%\qianfan-desktop-app\log\electron.log
取最后 3000 行，匹配：
  "DUMATE_INAPP_KEY:"     → inapp_key
  "DUMATE_ACCOUNT_ID:"    → account_id
  "DUMATE_USER_ID:"       → user_id
```

   请求头含 `X-Dumate-Account-Id` / `X-Dumate-Device-Id` / **`X-Dumate-Inapp-Key`**。
   **本仓从未发送 `X-Dumate-Inapp-Key`** —— 这是一个真实缺口（虽然目前 200，但上游一旦按它做校验就会 403）。

   ⚠️ 该仓库把作者的 `account_id` / `inapp_key` / `device_id`（`1|darwin.<64hex>`）**硬编码成默认值**。
   那是作者机器的指纹，业务侧可能据此识别/封禁，**不可照抄**。只借「从日志读」的机制。

3. **stdio MCP server**：`--mcp` 暴露三工具 `chat` / `list_models` / `get_status`，JSON-RPC over stdio。
4. **CLI 模式**：`cli "问题"` 单次、`git diff | cli "review"` 管道、无参进 REPL。
5. **端口自愈**：3 秒 TCP 存活探测 + 缓存，离线自动重新拉起客户端，对外固定 `8792`。

**与本仓差异**

| 项 | 本仓 | Alphaxiaoteng |
|---|---|---|
| 端口发现 | PowerShell 查 `dumate-main-server` 的 `--port=`（`discovery.js`） | TCP 探测 + 自动拉起 |
| 身份头 | Account-Id / Device-Id / Abexpids | 多一个 **Inapp-Key** |
| MCP | **已有** `src/mcp-server.js`（三工具同名） | 有 |
| CLI | **已有** `npm run cli` | 有 |

**已对齐项（本轮不需要重做）**：`src/mcp-server.js` 的注释写着
「与参考实现的差异：chat 链路走 **web-pool（云端网关）** 而不是本地 8980」——
说明 2026-11-08 那批融合就是对着这个仓库做的，MCP 三工具、CLI 子命令都已到位，
`test/unit/mcp-server.test.js` 覆盖了 initialize 握手 / tools/list / tools/call / 错误码。

**融合评级：P1（Inapp-Key 取证，见 §5 的 P2 表）；其余无新增**

---

### 4.5 s-silt/magpie-dumate-local —— 威胁模型与地域实测

**最新（2026-11-14，全生态最近一次提交）**

1. **地域连通性实测（重要运维情报）**：

> 2026-11-14 实测：一台**美国 VPS 能登录百度控制台、查积分，但到模型网关 `dumate-svc.baidu.com:443` 的 TCP 连接超时。
> 香港 VPS 能连通。** → 出口 IP 决定模型网关可达性，控制台可达 ≠ 模型网关可达。

本仓没有这条记录。它解释了一类「凭证没问题、余额正常、但请求全部超时」的排障场景，
而且直接给出处置：给搭子通道单独配香港出口。

2. **威胁模型里的安全控制（可直接对照 `web-pool.js`）**：

```
• Cookie 校验：禁换行 / 非允许字符 / 超长 / 重复或空 bce-sessionid；错误不回显输入
• 目标固定 HTTPS，redirect: manual（拒绝跟随重定向）
• 聊天重新构建请求头，只发网关 Bearer，不透传调用方 Cookie / Authorization
• token 按 Cookie SHA-256 分区：缓存 ≤ 8 项、限存活时间、并发刷新合并、401 最多刷新重试一次
• 错误用固定消息；响应头只转发 content-type / cache-control / retry-after
• 控制台请求 20 秒超时
```

**与本仓差异**：本仓 `web-pool.js` 按账号分区、有 401 强刷一次、有原子写缓存；但
**没有** 对 `redirect` 的显式拒绝、**没有** 对「不把调用方 Authorization 透传给上游」的显式保证（目前是重写头，等价）、
**没有** MAX body 上限。属于加固项而非功能项。

**融合评级：P2（加固 + 文档）**

---

### 4.6 Wang-JQ77/dsh-llm-dumate —— 进程环境变量发现

**机制（2026-08-20，虽然旧但独立）**：PowerShell `Add-Type` 编译 C# P/Invoke，
`OpenProcess(NtQueryInformationProcess)` → PEB → `RTL_USER_PROCESS_PARAMETERS` → 读目标进程**环境变量**：

```text
目标进程：dumate-main-server / dumate-opencode / DuMate
目标变量：DUMATE_HOST_URL / DUMATE_INAPP_KEY / OPENCODE_SERVER_PORT / DUMATE_USER_ID / DUMATE_ACCOUNT_ID
```

**价值**：本仓 `discovery.js` 只解析命令行里的 `--port=`。若某版本后端不写 `--port`（或换进程名），
就发现不了。环境变量里有 `DUMATE_HOST_URL`（完整地址）与 `OPENCODE_SERVER_PORT`，是**独立的第二条发现通路**。

**风险**：需要管理员权限读别的进程内存（本仓当前以普通权限跑 PowerShell CIM 查询即可，
换 PEB 会抬高权限门槛）→ **只作 fallback，不替换现有通路**。

**融合评级：P2**

---

### 4.7 Wang-JQ77/dumate-api —— 早期网关的取舍参考

**功能（2026-08-19/28）**：OpenAI + Anthropic 双协议、`X-API-Key`/`Bearer`/`x-api-key` 三种鉴权、
`dumate-points` 伪模型（查积分不消耗）、Claude 模型名自动映射：

```
*haiku*  → dumate-lite (L0)
*sonnet* → dumate-turbo (L1)
*opus*   → dumate-ultra (L2)
```

**与本仓差异**：伪模型本仓已有（`dumate-points`）；本仓 `modelmap.js` 的 `DEFAULT_ALIASES` 把
`claude-3-5-sonnet-latest` 等**全部**映射到 `model-text`，没有按 haiku/sonnet/opus 分档。
这是**可选增强**：让 Claude Code 用户的 `opus` 自动走 L2（最强档）而不是默认档。

**融合评级：P2**（一次改动，低风险；但会让同一条告警链路行为变化，需评估）

---

### 4.8 baidubce/dumate-bench（官方）

**内容**：DuMateBench 评测框架——沙箱工作区 + 工具 + 任务专属评估器 + `reward.json`；
`dumate` CLI 与 Harbor 导出；200 任务公开数据（HuggingFace `Annihi/dumate_bench`）；
论文 arXiv `2608.26546`；榜单 `dumatebench.com/leaderboard`。

**对本仓的价值**：**不是功能，是选型依据**。本仓有 16 个模型的价格（社区实测）却没有任何能力数据，
现在可以拿官方榜单做「性价比」象限（便宜且强 / 贵且弱）。README 里那句
"A model name alone is not an agent: the harness, API endpoint, task container, and evaluator are all part of the run"
恰好是本仓「模型名兜底是唯一可行的容错，也是最容易静默吞模型的闸」的另一种表述。

**融合评级：不做代码，只做文档引用**（可选：在模型页加「官方基准」外链）。

---

## 5. 融合清单

### P0-1 · 22 个模型清单自动导入（对外暴露 3 → 22）　✅ **已落地 2026-11-15**

**为什么是 P0**：本仓 `DEFAULT_EXPOSED` 只有 3 个、`MODEL_NAMES` 15 条（其中可对话 13 条）；社区有 22 个带完整元数据的入口。
差距直接表现为「Codex/Claude Code 里选不到豆包、文心、Qwen3.5 系」。

**落地**

1. 新增 `src/dumate-catalog.js`：
   - `sourcePath()`：`%APPDATA%\qianfan-desktop-app\qianfan_desk_xdg\<激活账号>\config\opencode\opencode.json`
     （激活账号从 `auth.json` 的 `activeProfileId` / `accountProfiles` 取；`DUMATE_OPENCODE_CONFIG` 可覆盖绝对路径）
   - `importModels(config)`：**照抄 magpie `models.mjs` 的过滤规则**（`model-*` 除 `model-text`、
     `embedding|reranker|ocr|llm-mock|dumate-image`、重复别名、`context>0 && output>0`、输入含 `text`）
   - `load()`：源 → 快照 `data/dumate-catalog.json`（原子写、`schema:1`、读回再过滤）→
     包内 `src/dumate-catalog.default.json`（本轮 22 条，`asOf: 2026-11-13`）
   - 按 mtime 热读（与本仓 `modelmap.js` / `keys.js` 同一约定）
2. 改 `src/modelmap.js`：`exposed` 的默认值改为「catalog 中 `tool_call === true` 的 id」；
   `MODEL_NAMES` **保留**（它带真实后端名，社区没有这个信息，是本仓的独有资产）
3. 改 `src/dumate-caps.js`：`OUTPUT_CAPS` 用 catalog 的 `limit.output` 初始化；
   **实测学习值仍优先于 catalog**（catalog 是客户端展示值，400 错误体是上游真值，两者冲突时后者赢——见 §6）
4. 改 `src/model-info.js`：模型卡读 catalog 的 context/output/视觉/工具，标 `source: 'desktop' | 'default'`
5. 新增 `test/verify-dumate-catalog.js`（离线）：
   - 过滤规则（7 类排除各一例）
   - 重复别名去重
   - 快照回退（源缺失/损坏/新装无快照）
   - **防注入**：源里有 `apiKey` / `baseURL` / `headers` 时，导出的 catalog 不含任何字段

**验证**：`/v1/models` 条目数从 3 → 实测通过的条数（预期 ≥15）；
`curl -s localhost:9082/v1/models -H "Authorization: Bearer $KEY" | jq '.data[].id'` 与 catalog 对比；离线测试全绿。

**风险**：清单存在 ≠ 账号有调用权限（社区原话）。→ 用现有 `test/probe-*.js` 对新增条目各打一次，
**只把实测 200 的放进 `exposed`**，其余标 `unverified`。

---

### P0-2 · V4.1 推理四档（把被丢弃的 reasoning_effort 接回来）　✅ **已落地 2026-11-15**

**为什么是 P0**：本仓在搭子路径**删掉**了 `reasoning_effort`（两处 `needsModelMap` 分支），
等于把「思考预算」这道闸焊死。它和 `budget.js` 的下限 65536 是同一问题的两端（抬价 vs 关闸）。
**但这是 2026-10-30 的有意决策**（理由：上游行为未知），所以要先补证据再改——
`test/unit/effort-passthrough.test.js` 锁着「直连通道透传、搭子剥掉」的边界，改之前必须读懂它。

**落地**

1. 新增 `src/dumate-reasoning.js`：`normalize(body, mappedModel)`，逐字复刻 `reasoning.mjs` 的语义
   - 白名单**只放同后端**的：`deepseek-v41-flash`、`model-text`、`dm-auto-model/text.L0`、
     `dm-auto-model/mm.L0`、`dm-auto-model/mm.L2`（这五个在 `MODEL_NAMES` 里都标注为
     `deepseek-v4.1-flash-low-latency`）；其余模型**保持现状不注入**
   - `none` → 删 `reasoning_effort` + `thinking:{type:'disabled'}` + `enable_thinking:false`
   - `low` → `high`；`high`/`max` → 保留 + `thinking:{type:'enabled'}` + `enable_thinking:true`
2. 改 `src/server.js`：把**两处** `delete openaiReq.reasoning_effort` 换成
   `openaiReq = normalizeReasoning(openaiReq, mappedModel)`。
   - 位置一：通用/OpenAI 路径的 `needsModelMap` 分支（`req._mappedModel` 刚设好之后）
   - 位置二：Anthropic 路径 `anthropicToOpenAI` 之后的同一分支（**这里是翻译层刚产出的 body，
     必须在这里归一化，不能提前**）
   - Responses / Google 两个入口走的是同一段通用逻辑，改一次即覆盖
   - 归一化必须**在 `if (route.target.needsBudget)` 之前、`if (target.direct) return` 之后**
     （直连通道根本不进 `needsModelMap` 分支，天然不受影响；但 `stream_options` 注入的
     位置纪律同理，别把两处顺序写反）
3. 新增 `test/unit/dumate-reasoning.test.js`：照抄 `reasoning.test.mjs` 三项
   （不动其他模型/畸形 body、`Uint8Array`/`ArrayBuffer` 等价、`messages`+`tools` 深相等），
   另加：白名单内五个模型全部命中、白名单外九个模型全部不动、
   **`minimal`/`medium` 两个档位按方案 A 被剥掉**（这条是防止将来有人「顺手补全词表」）。

**与既有测试的关系**：`test/unit/effort-passthrough.test.js` 断言的是**翻译层产物**
（`anthropicToOpenAI` 出来的 `reasoning_effort`），本改动不动翻译层，所以那条测试**应该继续绿**。
新增的归一化在 `server.js` 的 `needsModelMap` 分支里，是翻译层之后另一层。

**验证**：真机发 `none` → 响应无 `reasoning_content` 且 `usage.completion_tokens` 显著下降；
发 `max` → 有 `reasoning_content`。**两次都要在同一模型同一 prompt 下对比**。

**风险**：`thinking` / `enable_thinking` 是本仓从未发过的字段；若上游对未知 body 字段严格校验会 400。
→ 先在 9082 用 `test/probe-oai.js` 打一次，确认 200 再合。

---

### P0-3 · 积分按 product 分池 + active 过滤 + 正确到期字段　◐ **数据面已落地，展示待真机**

**为什么是 P0**：本仓 `/api/admin/points`、额度总览、FEFO 快照全部读**拍平后的 `totalPoints`**。
社区实测该账号钱包里有一个 5,000 积分的 `product:"comate"` 包（另一个百度产品共用钱包）——
本仓会把它算进「搭子余额」。同理排队的月度授予（`status:"inactive"`）若被计入会虚报 **7 倍**余额。

**落地**

1. 改 `src/dumate-web.js` 的 `quotaOverview()`：
   - URL 加 `&ignoreLoginBonus=true`（社区在测量脚本里用的口径；本仓目前没有）。
     ⚠️ **未验证**：社区打的是 `console.bce.baidu.com`，本仓打的是 `www.dumate.cn`（`WEB_BASE`）——
     两域同路径，但该参数是否被认需要一次探针确认；不认也只是多一个被忽略的查询参数，不会 400。
   - `packages[]` 新增字段：`product`（默认 `'dumate'`）、`status`、`points_expire_at`（`pointsExpireDate` 优先）
   - 新增 `pools: { dumate: {total, used, left}, others: [{product, total, used}] }`
   - 顶层 `total/used/left` **保持原样**（不破坏既有调用方），分池只做新增
2. 改 `src/admin/routes/points.js`：对外展示用 `pools.dumate`；其他产品单独一行「XX 共享积分」
3. 改 `src/points-cursor.js`（余额游标）与 `src/balance-refresh.js`（低频刷新）：
   记账基准改用 `pools.dumate.left` —— **否则游标和余额会各说一套**
4. 改 `src/admin/routes/accounts.js` 的临期快照：`points_expire_at` 优先，`expire_at` 作兜底
   （影响 FEFO 排序：现在按订阅到期排，应按积分到期排）

**验证**：真机读一次 `quota_overview`，人工核对
`sum(active && product==='dumate' 的 totalPoints)` 与 `pools.dumate.total` 一致；
若账号里确实有 comate 包，屏幕上应出现两行。

**风险**：`product` / `status` / `pointsExpireDate` 三个字段名是社区从真实响应里读出来的，
本仓**未在自己账号上见过**（本仓账号可能根本没有 comate 包）。→ 先加一个
`node test/probe-dumate-points.js` 打真机把 `raw` 落盘核对字段名，再改展示。

---

### P1-1 · 倍率测量从「单点前后差」升级为「双点解斜率」　◐ **机制已真机验证，全量待跑**

**现状**：本仓 `src/dumate-billing.js` 是「小请求 + 网页余额前后差」，只能测被点的那一个模型，
且把固定开销（每次调用的固定扣费）算进了斜率。缓存单位是「**积分/千token（综合输入+输出）**」。

**社区做法**：两次不同长度 → 用 `completion_tokens` 差解出**纯 output 斜率**，固定开销自然抵消。

**落地**

1. 改 `src/dumate-billing.js`：
   - 加 `measureModel(model)`：短（`max_tokens: 24`，「只回复两个字」）+ 长（`max_tokens: 800`，「数到 200」），
     `dTokens > 50` 才计算，否则回 `output too short to separate the slope`
   - 加 `measureAll()`：对 catalog 全部模型跑一遍，每模型 3 秒间隔，429 退避 `20s × n`（上限 8 次）
2. `data/dumate-rate-cache.json` **新增字段而不是改单位**：
   ```json
   { "model": { "pointsPerKOut": 2.014, "pointsPerKIn": 0.611,
                "unit": "pts/1k_out", "source": "two-point", "measuredAt": "...", "asOf": "2026-11-13" } }
   ```
   旧字段（综合口径）保留，前端按 `unit` 决定显示哪一列——**两个口径不能混在一列里比大小**。
3. 预置社区 16 个 output + 4 个 input 实测值（`RATE_BASIS: 2026-11-13`）作为**未实测模型的初值**，
   标 `source: 'community'`，过期如实显示「—」（与本仓既有「过期数字比缺失更害人」一致）
4. `dm-auto-model/*` 六个别名**不给价格**（上游请求时决定模型）

**验证**：真机跑 `measureAll()`，与社区表逐行比对；差异 >30% 的模型标红。

**风险**：每个模型 2 次调用 = 32 次真实扣费。→ 只在管理端手动触发，不做定时任务。

---

### P1-2 · 双凭证域并存 + cookie 形态 + token 韧性　◐ **双域已落地；cookie 形态待样本；token 分区本仓已有**

**三个独立子项**

1. **token 端点双域**：
   - 本仓：`https://www.dumate.cn/api/dumate/app/token/get`（`web-pool.js` 的 `WEB_BASE`）
   - 社区全部：`https://console.bce.baidu.com/api/dumate/app/token/get`（`CONSOLE_BASE`）
   - 两者都真机验证过（各自），说明**同一 token 有两套签发入口**。加一个 `account.tokenBase` 字段：
     账号创建时来源是「搭子官网 cookie」→ `www.dumate.cn`；来源是「百度云控制台 cookie」→ `console.bce.baidu.com`。
     收益：用户只要登录过百度云就能加号，不必打开搭子网页。
   - **未验证**：console 域签出的 token 是否与 dumate 域等价（社区从未交叉验证）。
     → 先加探针 `test/probe-token-domains.js`，同账号两域各签一次，各打一次模型，比对是否都 200。

2. **cookie 形态（按 hostname 重建）**：
   - 新增 `buildCookieHeader(cookies, hostname)`：域过滤 → 剥引号 → 值含 `[:|;=空格]` 时加引号
   - `extractCsrfToken(cookies, hostname)`：从 `bce-user-info` 取值
   - 用于 `claimLoginBonus`（本仓唯一的 POST 端点）；`auth-import.js` 保存**结构化 cookies**而不只是拼好的串
     （现在存的是一整条串，无法按域重建）

3. **token 缓冲**：
   - 本仓已有 `expired_at` 优先 + 50 分钟兜底 + 401 强刷一次
   - 补：**按 cookie 哈希分区**（多账号共用一份 token 缓存时的串号风险）、**并发刷新合并**（同一账号 5 个请求同时 401 时会演变成 5 次 token/get）

**融合评级：P1（2 值得做，1 待实测）**

---

### P2 · 三项可选（原「MCP / CLI」两项已在本仓落地，见下）

| 项 | 来源 | 落地 | 价值 | 成本 |
|---|---|---|---|---|
| **env 发现（PEB）** | Wang-JQ77 | `discovery.js` 加 fallback：读 `dumate-main-server`/`dumate-opencode` 的 `DUMATE_HOST_URL`/`OPENCODE_SERVER_PORT` | 命令行无 `--port` 时的第二条通路 | 中（要 C# P/Invoke，权限门槛高） |
| **electron.log 取证** | Alphaxiaoteng | 管理端「桌面登录态」页加「从日志读身份头」，补齐 `X-Dumate-Inapp-Key` | 本仓从未发这个头 | 低 |
| **地域连通性** | s-silt | 文档 + `/health` 加一句「模型网关按出口 IP 可达」 | 解释「控制台通、模型不通」 | 极低 |

**已落地、不要重做的两项**（上一轮 2026-11-08 已吸收）：

```
MCP   src/mcp-server.js —— chat / list_models / get_status 三工具，
      JSON-RPC over stdio，initialize 握手 / 通知静默 / 错误码全覆盖
      （口径差异：chat 走 web-pool 云端网关，不依赖本地 8980）
CLI   package.json 的 "cli": "node src/mcp-server.js cli"
      测试 test/unit/mcp-server.test.js
```

**关于 Inapp-Key 的判断**：本仓桌面链路已经能跑通（`DUMATE_SOURCE=auto`），说明当前上游**不强制**这个头。
但它是客户端身份的一部分，`X-Dumate-Account-Id`/`X-Dumate-Device-Id` 本仓都发了，唯独漏了它——
补齐是「一致性」问题，不是「能不能用」问题。**先做取证（读日志看看值长什么样），再决定要不要发。**

---

## 6. 口径冲突与待实测（**读这份报告最容易踩的坑**）

| 项 | 本仓记录 | 社区数据 | 判断 |
|---|---|---|---|
| `model-text` 输出上限 | **393,216**（来自 400 错误体 `max_tokens range is [1,393216]`） | 384,000（客户端 `limit.output`） | **不冲突，是两个口径**。393216 = 384×1024 的二进制表示，384000 是十进制展示。本仓用错误体是对的（上游真值），catalog 只作展示 |
| `dm-auto-model/text.L1` 输出 | **≥2,000,000（实测接受，未探顶）** | 1,048,576（客户端声明） | 实测下界 > 声明值。**以实测为准，但「≥2M」不能写成「=2M」**——没探到顶 |
| `model-text` 真实后端 | `deepseek-v4.1-flash-low-latency`（`X-Dumate-Gw-Realmodel`） | 「自动路由（默认）」（duanz 的显示名） | 不冲突。duanz 是**产品视角**命名，本仓是**上游回传**命名。本仓信息更硬，保留 |
| `glm-5` vs `glm-53` | `glm-5` 实跑 `glm-5.2`，上限 [1,131072] | `glm-53` 上限 128,000 | **不同模型**（5.2 vs 5.3），不是冲突。本仓 `cloud_aliases` 已有 `glm-5 → glm-53` 的代偿映射并注明「同系换代代偿，不是同模型」 |
| 积分单位 | 积分/千token（**综合**输入+输出） | 积分/千**output** | **口径不同，数学上不可比**。合并时必须分列，否则「搭子 L2 2.67」与「社区 glm-53 0.087」会被误读成 30 倍差 |
| `kimi-k31` 上下文 | 本仓未记 | 1,048,576 | 待实测 |

**「没测到不许写成通过」的具体含义**：上面 22 个模型清单来自客户端配置文件，
**没有一条经过本仓实测**。它的正确用法是「候选集」，不是「可用集」。

---

## 7. 明确不融合（附理由，避免后人翻出来重做）

| 项 | 来源 | 不做的理由 |
|---|---|---|
| magpie 图标双路径（`auth.icon` + `package.json` 的 `magpie.icon`） | magpie-dumate | magpie 宿主特有机制；本仓是 HTTP 网关 + Vue 管理端 |
| magpie 的 `checkin` / `usage` hook 语义 | magpie 三个插件 | 宿主协议；本仓已有自己的签到与余额链路（`loginBonusInfo`/`claimLoginBonus`/`points-cursor`） |
| 插件快照目录隔离（防 fork 互相覆盖） | magpie 三个插件 | 同一问题在 magpie 生态里是「三个 fork 共存」造成的；本仓只有一个实现 |
| 硬编码 `account_id` / `inapp_key` / `device_id` | Alphaxiaoteng | 那是作者机器的指纹与密钥；照抄等于共用别人身份，可能被风控针对 |
| 社区对外别名 `deepseek-v4.1` / `kimi-k3.1-pro` / `glm-5.3` / `qwen-3.8-flash` | Alphaxiaoteng | 本仓 2026-11-06 真机实测：这 4 个名字在云端网关**一律 404**（`modelmap.js` 的 `DEFAULT_CLOUD_UPSTREAM` 注释已记录）。Alphaxiaoteng 的别名表是给**它自己本地 8980 后端**用的，不是云端路由名 |
| 跨平台路径（macOS/Linux 桌面登录目录） | magpie-dumate 0.3.0 | 本仓 Windows 专用（`start.bat`/托盘/`%APPDATA%`），无收益 |
| 美国 VPS 部署建议 | s-silt | 本仓面向本机；但**连通性事实**已作为文档项收入 §4.5 |

---

## 8. 建议执行顺序

```
第 1 批（半天，全离线可验）
  P0-2 推理四档      → 新增 dumate-reasoning.js + 两处 needsModelMap 分支接线 + 单测
                       （注意：这是推翻 10-30 的保守决策，PR 里要写清「新证据是什么」）
  P0-1 模型清单      → 新增 dumate-catalog.js + 22 条 default + 离线验证
  两者都不碰余额口径，风险最低，且 P0-1 的 catalog 是 P1-1 的前置

第 2 批（半天 + 一次真机探针）
  P0-3 积分分池      → 先写 probe-dumate-points.js 落 raw 核对字段名，再改展示

第 3 批（一天）
  P1-1 倍率升级      → 双点解斜率 + catalog 全覆盖（复用 P0-1 的清单）

第 4 批（碎片时间）
  P1-2 cookie 形态 / token 分区   P2 三项（env 发现 / 日志取证 / 连通性文档）
```

**发布纪律照旧**：全部改动只在 9082/9083 验证，`stable/` 快照按依赖闭包同步，不重启 9080。
**不 commit**：本轮只产出调研报告，未改任何代码。

---

## 9. 附录

### 9.1 本轮抓取到的关键常量（可直接抄进代码）

```js
// 桌面登录数据目录（三平台）
macOS   ~/Library/Application Support/qianfan-desktop-app/
Windows %APPDATA%\qianfan-desktop-app/
Linux   $XDG_CONFIG_HOME/qianfan-desktop-app/  (默认 ~/.config/...)
覆盖    DUMATE_USER_DATA_DIR

// 加密排布（与本仓 auth-import.js 一致，社区独立得出同一结论）
cookies = base64( iv[12] + authTag[16] + ciphertext )   // tag 前置
.cookie-key = 32 字节

// 模型真相源
<数据目录>/qianfan_desk_xdg/<激活账号>/config/opencode/opencode.json
  → provider.QianfanPersonalQuota.models
覆盖  DUMATE_OPENCODE_CONFIG

// 积分与身份（社区用 console 域，本仓用 dumate 域）
GET https://console.bce.baidu.com/api/dumate/user/info
GET https://console.bce.baidu.com/api/dumate/app/token/get
GET https://console.bce.baidu.com/api/dumate/points/quota_overview
      ?timezone=Asia%2FShanghai&clientType=desktop&ignoreLoginBonus=true
GET https://console.bce.baidu.com/api/dumate/points/loginBonusInfo
POST https://console.bce.baidu.com/api/dumate/points/loginBonus

// 身份头（本仓缺 Inapp-Key）
X-Dumate-Account-Id / X-Dumate-Device-Id / X-Dumate-Inapp-Key / X-Dumate-Abexpids

// 个人版 UA（社区 2026-11-13 跟随官方）
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
DuMate/1.0.91 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36
Referer https://console.bce.baidu.com/ai_apaas/dumate
Origin  https://console.bce.baidu.com
```

### 9.2 价格换算（社区口径，仅作相对比较）

```
Pro ¥59 / 25000 积分  →  ¥0.00236 / 积分
汇率 7.10             →  $0.000332 / 积分
cost(USD/M output) = pointsPerKOut × 1000 × 0.000332
缓存：读 = input × 10%，写 = input × 100%（均为假设，网关不公布）
```

### 9.3 复现命令

```bash
# 拉全部社区源码（10 分钟内）
mkdir -p /tmp/dumate-research && cd /tmp/dumate-research
for r in DuanZGit/dumate-duanz RanceLee233/dumate-rance R227BOUT/magpie-dumate \
         Alphaxiaoteng/dumate2api s-silt/magpie-dumate-local Wang-JQ77/dsh-llm-dumate; do
  n=$(echo $r | tr '/' '_')
  curl -sSL "https://codeload.github.com/$r/zip/refs/heads/main" -o "$n.zip"
  python3 -c "import zipfile;zipfile.ZipFile('$n.zip').extractall('src')"
done

# 看某仓最近提交
curl -sSL "https://github.com/DuanZGit/dumate-duanz/commits/main.atom"
```

### 9.4 证据分级（本报告内部约定）

| 级别 | 含义 | 本报告中的例子 |
|---|---|---|
| **A 实测** | 有人在真机上发出请求并读到响应 | 22 模型清单（客户端文件）、16 模型倍率（真实网关扣费）、V4.1 推理档位（真机开关验证） |
| **B 代码** | 从源码读出的逻辑，未运行 | reasoning 四档映射、cookie 序列化规则、清单过滤规则 |
| **C 声明** | README 文字，无代码或数据支撑 | 「美国 VPS 到网关超时」、「香港可通」（有实测描述但无抓包） |
| **D 推断** | 本报告的判断 | 「console 域签出的 token 可能与 dumate 域等价」——**未验证** |

**凡 D 级项，落地前必须先用探针验证，不得直接改线上逻辑。**

---

## 10. 一句话给决策者

这轮社区更新里，**只有三件事值得立刻做**：把 22 个模型接进来（模型面翻倍）、
把思考档位接回来（解一类线上问题）、把积分分池（额度不再虚报）。

本仓在协议深度、上限学习、四协议翻译、池化与告警上的投入，社区没有任何一项超过——
**这不是追赶，是补三块短板。**
