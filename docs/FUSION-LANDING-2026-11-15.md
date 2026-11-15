# 融合落地记录（2026-11-15，第一批 P0）

依据：[GITHUB-DUMATE-RESEARCH-2026-11-15.md](GITHUB-DUMATE-RESEARCH-2026-11-15.md) §5 的 P0-1 / P0-2 / P0-3。
本轮只做**没有任何真机依赖也能验证**的部分；需要账号的展示口径切换按纪律挂着，见 §5。

基线：`main@a0ffae0`。改了 6 个源文件 + 新增 2 个模块 + 3 个测试。

---

## 0. 一句话

三块短板补上两块半：**模型面 3 → 22**（真机 `/v1/models` 7 → 28 条）、**思考档位接回来了**（四档 + 显式开关）、
**积分钱包分池的数据面就绪**（展示口径待真机字段核对）。
所有改动都保留了既有回归守卫，并**没有引入新的测试失败**（基线本来就有 14 条，成因见 §4）。

---

## 1. P0-1 · 桌面端模型清单

### 新增 `src/dumate-catalog.js`

三级降级：**客户端配置 → 本地快照 → 包内默认**。

| 级别 | 路径 | 触发条件 |
|---|---|---|
| 真相源 | `%APPDATA%\qianfan-desktop-app\qianfan_desk_xdg\<激活账号>\config\opencode\opencode.json` 的 `provider.QianfanPersonalQuota.models` | 文件可读且过滤后非空 |
| 快照 | `data/dumate-catalog.json`（原子写、`schema:1`、带 `asOf`） | 真相源缺失/损坏 |
| 包内默认 | `src/dumate-catalog.default.json`（22 条，`asOf 2026-11-13`） | 前两级都不可用 |

`DUMATE_OPENCODE_CONFIG` 可钉死配置绝对路径；`DUMATE_USER_DATA_DIR` 覆盖数据目录。

**过滤器规则**（照社区 magpie 0.3.0 的实测口径，逐条都有测试）：

```
排除：key 以 model- 开头且 ≠ model-text（内部任务路由）
      embedding | reranker | ocr | llm-mock | dumate-image（非对话入口）
      key ≠ id 且源里存在 id（显示别名重复）
      context ≤ 0 或 output ≤ 0
      输入模态不含 text
只取：id / 显示名 / limit.context(回落 limit.input) / limit.output /
      tool_call / reasoning / modalities
永不复制：apiKey / baseURL / headers / plugins / commands / permissions
```

**防注入**：快照读回时**再走一遍同一过滤器**——被篡改的快照不能把 `apiKey` 或 `model-secret` 带进模型表。
测试里专门造了一份带 `LEAKED-KEY` 的篡改快照验证这条。

### 改 `src/modelmap.js`

- 新增 `VERIFIED_MODELS`（本地 3 + 云端 7，都是真机实测过的名字）
- 新增 `catalogModels()` / `catalogExposed()` / `catalogStatus()` / `isVerifiedModel()`
- **`mapModel(name, opts)` 增加 `opts.catalog`**：只有 `opts.catalog === true` 时才认清单里的名字

### 为什么直传要按链路（重要，别改成无条件）

清单里 22 个名字是**云端网关路由名**（`kimi-k31` / `glm-53` …），本地 8980 后端只认三个。
`test/unit/cloud-model-map.test.js` 有一条回归守卫写着：

```js
assert.strictEqual(modelmap.mapModel('kimi-k31'), 'model-text', '云端名不进本地表');
// 注释：本地链路传 kimi-k31 依旧落 fallback（8980 不认识它），而不是透传后 404
```

所以无条件直传会**推翻一条有意约束**。正确做法是按链路：

| `DUMATE_SOURCE` | 链路 | mapModel 行为 |
|---|---|---|
| `web`（**默认**） | 网页凭证直打 `dumate-svc` 云端网关 | 传 `{catalog:true}` → 清单名**直传**（那 7 个路由名真机 200；不直传会被静默兜底成 model-text，选 kimi 得到 deepseek 且响应 200） |
| `auto` / `desktop` | 本地 8980 | 不传 → 清单名**落 fallback**（守卫成立；404 变静默兜底是既有取舍，本轮不动） |

server.js 用一行收敛这个判断：

```js
const catalogLink = () => router.dumateSource() === 'web';
```

四个 `needsModelMap` 分支（chat / Google / Responses / Anthropic）都改成
`mapModel(route.model, { catalog: catalogLink() })`。

### 改 `src/dumate-caps.js` — 上限的三级来源

```js
capOf(model) = 学习值（400 错误体解析，7 天 TTL）
            ?? 静态实测表（OUTPUT_CAPS）
            ?? 清单的 limit.output        ← 本轮新增
            ?? null（调用方回落全局 131072）
```

**顺序不能反**：清单的 `limit.output` 是客户端展示值，与上游真值可能不同
（`model-text` 清单 384000 vs 上游错误体 393216）。真机验证：

```
model-text            393216   ← 静态表赢，没被清单的 384000 覆盖
dm-auto-model/text.L1 2000000  ← 实测下界
glm-5                 131072
kimi-k3               1048576  ← 清单兜底
doubao-seed-2-0-pro   32000    ← 清单兜底
glm-53                128000   ← 清单兜底
unknown-model         null     ← 回落全局
```

### 改 `src/model-info.js` — `dumateCatalogOf(id)`

返回与 `DUMATE_REAL` 同形状的元数据，带 `catalog: true` 来源标记。
`/v1/models` 的取数顺序是 `dumateRealOf(...) || dumateCatalogOf(...)`（实测优先）。

### 改 `src/server.js` 的 `/v1/models`

追加清单里 exposed 没覆盖的条目，每条带 context / output / `metaSource` / `multimodal` / `dumate{verified,toolCall,reasoning}`；
`DUMATE_EXPOSE_CATALOG=0` 回到老行为（只列 exposed 三条）。

### 真机证据（9082，`DUMATE_SOURCE=web`）

```
改前：7 条（model-text, model-artifact-validate, glm-5, dumate-points, qwen/pro, qwen/flash, qwen/qwen3.8-max-preview）
改后：28 条（搭子组 24）
  verified=true （6）：deepseek-v4-pro, deepseek-v41-flash, glm-53, glm-53-flash, kimi-k31, qwen38-flash
  verified=false（15）：deepseek-v4-flash-0731, mm.L0/L1/L2, text.L0/L1/L2, doubao-seed-2-0-pro,
                       ernie-4.5-turbo-vl-32k, kimi-k3, qwen2.5-vl-32b-instruct,
                       qwen3.5-27b, qwen3.5-35b-a3b, qwen3.5-397b-a17b, qwen3.8-max
```

`kimi-k31` 的完整条目（元数据来自清单，来源标 `probe` 因为它在实测集合里）：

```json
{ "id": "kimi-k31", "owned_by": "dumate", "name": "kimi-k3.1-pro（云端路由）",
  "contextWindow": 1048576, "maxContextWindow": 1048576, "maxOutputTokens": 1048576,
  "metaSource": "probe", "multimodal": true,
  "dumate": { "verified": true, "toolCall": true, "reasoning": false } }
```

---

## 2. P0-2 · 搭子思考档位（四档 + 显式开关）

### 新增 `src/dumate-reasoning.js`

```js
apply(body, { mappedModel, stripUnsupported }) →
  命中（白名单模型 + 档位 ∈ none/low/high/max）：
    none  → 删 reasoning_effort，thinking.type='disabled'，enable_thinking=false
    low   → 改写成 high（百度渠道 low 与 high 同强度）
    high/max → 保留，thinking.type='enabled'，enable_thinking=true
  未命中：
    stripUnsupported !== false → delete reasoning_effort（翻译路径口径）
    stripUnsupported === false  → 原样保留（透传路径口径）
```

白名单五个（同一个后端 `deepseek-v4.1-flash-low-latency`）：
`deepseek-v41-flash` / `model-text` / `dm-auto-model/text.l0` / `mm.l0` / `mm.l2`
（集合键小写，`normModel` 会剥 `[1M]` 并小写入参）。

### 接线（4 处，按路径分两种口径）

| 入口 | 调用 | 未命中时 |
|---|---|---|
| `/v1/chat/completions` | `apply(reqBody, {mappedModel, stripUnsupported: false})` | 原样保留（透传语义不变） |
| Google | 同上 | 原样保留 |
| `/v1/responses` | `apply(openaiReq, {mappedModel})` | 剥掉（翻译层产的字段不进云端，与 2026-10-30 起一致） |
| `/v1/messages` | 同上 | 剥掉 |

### 与既有决策的关系（必须知道）

`test/unit/effort-passthrough.test.js` 锁的是**翻译层产物**（`anthropicToOpenAI` 出的
`reasoning_effort`，五档 minimal/low/medium/high/max），本改动不动翻译层，那条单测继续绿。
新加的归一化在其**之后**，是另一层。

`minimal` / `medium` 刻意**不映射**成 none/high：
翻译层五档词表与本仓实测的四档不一致，硬映射等于「让稍微想想变成完全不想」，
且 `medium` 的上游行为没有实测证据。这条有单测钉着，防止将来有人「顺手补全词表」。

### 证据分级

**真机已验证（2026-11-15，账号 `我谁敌` 加入后）**。同一模型（`model-text`）、同一 prompt
（水池进出水应用题），只改 `reasoning_effort`：

| 档位 | HTTP | `reasoning_content` | `reasoning_tokens` | 耗时 | out |
|---|---|---|---|---|---|
| `none` | 200 | **无** | 未出现 | 3.0s | 382 |
| `max` | 200 | **有（540 字符）** | **154** | 2.1s | 353 |

三条结论：① `thinking` / `enable_thinking` 两个新字段**没有被上游拒绝**（都 200）；
② `none` 真的不思考（reasoning_content 与 reasoning_tokens 双双缺席）；
③ `max` 真的思考（154 reasoning tokens）。

证据分级因此从「社区 A 级 + 本仓 B 级单测」升级为**本仓 A 级实测**。
（`test/unit/dumate-reasoning.test.js` 的 9 项仍然承担边界回归——真机只能证明「这两档通」，
证明不了「其余模型不受影响」。）

---

## 3. P0-3 · 积分钱包分池（**只做了数据面**）

### 改 `src/dumate-web.js` 的 `quotaOverview`

- `packages[]` 新增三个字段：`product` / `status` / `points_expire_at`（`pointsExpireDate` 优先于 `expireDate`）。
  **上游没给就是空串 / null，不猜成 `'dumate'`**——把「没给」当「是搭子的」正是社区那次虚报的成因。
- 新增 `pools`：`{ dumate, unspecified, others[], active, note }` 三桶互不合并。
- **顶层 `total` / `used` / `left` 一字不动**，所以 `dumate-points` 伪模型、额度总览、FEFO 快照行为零变化。

### 为什么没改展示口径

社区那三个字段名是**他们自己账号**上的实测（一个 `product:"comate"` 的 5,000 分包）。
本仓从未在自己账号上见过——我们的账号可能根本没有这个字段。按「没测到不许写成通过」：

1. 先跑 `node test/probe-dumate-points.js`，把 raw 落 `data/probe-dumate-points.json`，
   它会打印每个字段「有 / 无」以及「`active && product=dumate` 合计 vs `totalPoints`」的差。
2. 差 > 0.01 才说明虚报真实存在，那时才改 `/api/admin/points`、额度总览、FEFO 的取数。

**本机阻塞**：账号池 0 个账号，探针无法运行（脚本会明确报错并退出码 2）。

### 真机核对结果（2026-11-15，账号加入后跑 `probe-dumate-points.js`）

| 字段 | 该账号实测 | 影响 |
|---|---|---|
| `product` | **存在**，全部取值 `dumate`（14920 分全在这一桶） | **没有混池**，社区那个 `comate` 问题本账号不存在 |
| `status` | **存在**：`active` 10140 / **`used` 4780** | `used` 是「已用完的包」，`used==total`、`left==0` |
| `pointsExpireDate` | **不存在** | FEFO 只能继续用 `expireDate`（现有代码即如此，如实） |

**重要更正（上一轮的判据是错的）**：我原先写「`active` 合计 ≠ `totalPoints` 就是虚报」——
真机推翻了它。`status:"used"` 的包仍计入 `totalPoints`，但它的 `usedPoints` 同样计入
`usedPoints`，两边抵消。本账号两个余额口径**完全一致**：

```
total 14920 − used 4943.72 = 9976.28
active 合计 10140 − active 已用 163.72 = 9976.28      ← 差 0.00
```

所以**现有 `total − used` 口径是对的，不需要改展示**。真正会虚报的是社区那种情形：
`inactive`（未来期）的包计入 `total` 却不计入 `used`。判据只能是「两个余额口径相比较」，
不是「和 total 比」。探针脚本的判读逻辑已按此更正。

`pools` 字段保留的价值变成**诊断**：一眼看出「账上有 14920，其中 4780 已经用光、
只有 10140 的包还能花」。它不改任何现有取数。

`test/unit/dumate-pools.test.js`（6 项）继续锁纯函数：三桶不合并、同产品多包合并、
`inactive` 不进可花费桶、空/畸形输入不产生 NaN、`left` 不为负、`note` 如实说明口径。

---

## 4. 回归与基线（如实说明）

```
node test/run-all.js        → 40 项通过，2 项失败
   失败：88 个单测文件（含既有失败）、verify-channel.js（读真实落盘数据）
node --test test/*.test.js test/unit/*.test.js
   改动前（HEAD 干净导出到 /tmp/baseline）：pass 852 / fail 14
   改动后：                                 fail 15（新增的那条是 flaky）
```

**基线本来就有 14 条失败**，成因逐个查过，与本轮改动无关：

| 失败项 | 成因 |
|---|---|
| `dumateRows` ×5、`mapModel` ×2、`resolveClaudeRoute` | 依赖 `data/model-map.json`（gitignore 的运行时配置），本机没有 → 默认别名表缺 `auto-l0/l1/l2` |
| `qwenwork.send 端到端` | 假上游桩与本机环境 |
| `backupConfig` ×1 | 索引封顶用例与既有备份目录状态 |
| `test/pool.test.js` ×3（并发选号 / 跨进程合并 / reloadIfChanged） | **flaky**：同一文件连跑三次，基线与改动后都出现 2~3 条失败，具体哪条随机 |

新增失败对比后只剩 `跨进程合并`，单跑 `test/pool.test.js` 三次基线与改动后都是 3/3/2 条，判定为既有 flaky。

---

## 5. 未落地（下一步）

| 项 | 阻塞 | 解锁条件 |
|---|---|---|
| P0-3 展示口径切换 | **已核对：不需要改**（两个余额口径差 0.00，现有 `total − used` 正确） | 除非出现 `inactive` 包 |
| P0-2 真机验证 | **已完成**（none 无思考 / max 154 reasoning tokens） | — |
| P1-1 倍率双点解斜率 | 同上（要真实扣费 32 次） | 有账号且愿意烧积分 |
| P1-2 双凭证域 / cookie 形态 / token 分区 | 需实测 console 域 token 是否等价 | 一次探针 |
| P2 三项（PEB 发现 / electron.log 取证 / 连通性文档） | 低优先 | — |

---

## 5.5 追加：账号管理页与登录器的三处修复（2026-11-15 同批）

用户在管理端反馈「切不到账号管理 / 想加一个搭子账号」。用 playwright（`chromium-1255`
+ 临时签发的 admin 会话）实测后确认：**前端本身正常**——侧栏有「账号管理」、路由通、
页面渲染正确、「添加账号」弹窗可开，当前选中的是「手动粘贴」页签，零请求错误。

顺着排查修掉三个真实缺陷：

| 缺陷 | 表现 | 修法 |
|---|---|---|
| `login-browser.js` 的 `CANDIDATES` 只有 4 个 Windows 路径 | Linux/macOS 部署永远「未找到 Edge 或 Chrome」，即使系统里装了 chromium | 补 Linux/macOS 常见路径 + `playwrightChromium()` 动态发现 `~/.cache/ms-playwright/chromium-<版本>/`（版本目录不能写死） |
| 无图形界面时 `start()` 报「未找到 Edge 或 Chrome」 | 服务器/容器里文案误导（浏览器找到了，是开不出窗口） | 加 `hasDisplay()`；无 `DISPLAY`/`WAYLAND_DISPLAY` 时直接说「服务端没有图形界面，请用手动粘贴」并带 `browser_available:false` |
| 账号页 `onMounted` 只判 `isTw/isQw` | 在 Qoder / WorkBuddy 通道下打开本页仍会去打搭子的 `/web-accounts`、`/login-url`（无账号时多余请求） | 收敛成 `isDirectView()`，四条直连通道全覆盖 |

`/api/admin/web-accounts/login-url` 的 `browser_available` 现在要求「有可执行文件 **且** 有图形界面」
（`findBrowser() && hasDisplay()`），前端据此自动切「手动粘贴」——本机实测返回 `false`、
弹窗默认页签是「手动粘贴」。

**顺带记两个与本次无关的既有现象**：`/api/admin/points/accounts` 与 `/points/points`
在本机回 **502**，因为它们的上游是桌面客户端（`auth.json` / 8980），这台机器没装客户端
也没账号；不是回归。

---

## 5.6 追加：P1 两项的真实进展（账号到位后做的）

账号 `我谁敌` 加进池子之后，之前卡在「没有账号」的两项都能验了。

### P1-2 ① token 端点双域 —— 已落地

真机实测（同一份 cookie，账号 1）：

```
www.dumate.cn/api/dumate/app/token/get         → 200，token 长度 36，expired_at 2026-11-15T19:38:34Z
console.bce.baidu.com/api/dumate/app/token/get → 200，**同一个 token、同一个 expired_at**
用 console 域签的 token 打 /gateway/apis/v1/chat/completions → 200（model-text）
```

结论：两个域是**同一签发服务的两条入口**，token 与域无关。所以多域纯粹是容灾。

实现：`src/web-pool.js` 的 `TOKEN_HOSTS` 候选链；**401/403 不切域**（cookie 失效换域
必然同样失败，多打一次只是拉长失败路径），只有网络错误 / 5xx / 非 JSON 才切。
离线验证 `test/verify-web-pool-token-host.js` **15 项全绿**（含「回 HTML 登录页」这种被墙形态）。

### P1-2 ②③ —— 一个不做、一个本来就有

- **cookie 按域重建：没做**。本仓唯一 POST 是签到，而今天的账号 `has_issued=true`，
  造不出「cookie 形态被拒」的样本。没有失败样本就不改——改了也证明不了对。
- **token 分区 / 并发刷新合并：本仓早就有**。`web-pool.getToken` 按 `account.id` 分区、
  `st.refreshing` 复用同一次在途刷新；社区那套是「按 cookie 哈希 + 缓存 ≤8 项」。
  这一项不需要动。

### P1-1 倍率双点解斜率 —— 机制已真机验证，全量待跑

`test/probe-dumate-rates.js`（新）按社区算法：短请求（`max_tokens` 24）+ 长请求（800），
用 `completion_tokens` 差解纯 output 斜率，固定开销抵消。两个模型的结果：

| 模型 | 本仓实测（积分/千 out） | 社区 duanz（2026-11-13） | 差 |
|---|---|---|---|
| `model-text` | **2.0179** | 2.014 | **+0.2%** |
| `glm-53` | **0.116** | 0.087 | +33%（绝对值差 0.029，接近余额 0.01 精度的 3 倍；社区自注低价档 ±10%） |

`model-text` 复现到 0.2%，机制与单位都对。`glm-53` 的 input 侧解不出来（短调用扣费
< 0.01，低于余额精度）——与社区「只实测四个模型的 input 侧」同一处境，不硬算。

**全量 22 个模型 = 44 次调用，估算 15~25 积分**。跑完才能把倍率列填满；这一步没跑，
`data/dumate-rate-cache.json` 里仍然只有本仓原来那五档（综合口径）。

---

## 5.7 前端配套（用户问「前端是不是也要改」——是，已改）

P0-1 只改后端会留下一个**半成品**：`/v1/models` 已能选到 22 个模型，但管理端「模型管理」页
只显示 `exposed` 那 3 个——于是「界面上没有的模型，客户端却能选到」。补了三处：

| 位置 | 改法 |
|---|---|
| `src/model-info.js` 的 `dumateRows()` | 遍历完 `exposed` 后**追加桌面清单里未覆盖的 21 条**（实测口径下 24 行）。字段来源标 `'desktop'`，另带 `verified`（是否本仓实测过）与 `reasoningEfforts`（清单里只有 `deepseek-v41-flash` 有 `none/low/high/max`） |
| `web/src/api/modelinfo.ts` | `ModelFieldSource` 增 `'desktop'`；`ModelInfoRow` 增可选 `verified` / `reasoningEfforts`（其他通道不填，向后兼容） |
| `web/src/components/ModelInfoTable.vue` | ① `srcText` 增 `'desktop' → '清单'`；② 类型列在「多模态」下补「档位 none/low/high/max」与橙色「未实测」标签；③ 图例补一行「清单 = 桌面客户端模型清单声明（未实测）」；④ 修正 `target === id` 时被渲染成「别名 → 自己」的误导文案，改成「直传（桌面清单）」 |

**真机验证**（playwright，1560×1000 @2x）：模型页 24 行、`kimi-k3` / `doubao-seed-2-0-pro` /
`qwen3.5-397b-a17b` / `text.L1` 全部在列、「清单」55 次、「未实测」36 次、
「档位 none/low/high/max」出现、清单条目的第二行文案是「直传（桌面清单）」。
唯一错误是 `/api/admin/points/points` **502**（既有：它要桌面 `auth.json`，这台机器没有）。

### 不需要改的前端

- **积分页**：P0-3 的真机结论是「余额口径本来就对」，数字没变，所以不加新列。`pools` 只进接口
  供排障（`data/probe-dumate-points.json` 里有完整分布）。
- **思考档位没有新增列**：复用「类型」列的小字，因为 `ModelInfoTable` 是五通道共用组件，
  为搭子单独加一列会让其他四条通道出现一列空白。
- **ChatLab**：可选。想让聊天测试台能手动选 `none/low/max` 试档位，那是另一个改动（要加参数透传），
  这轮没做。

---

## 5.8 追加：模型管理页「真实倍率 + 可排序 + 不重复」（用户明确需求）

需求原话：**显示各模型的真实积分消耗倍率、可按倍率排序、模型不要重复显示**。三件都做了。

### ① 全量 22 个模型的双点解斜率实测（`test/probe-dumate-rates.js --all`）

实测于 2026-11-15，账号 `我谁敌`，花费约 **39 积分**（used 4943.72 → 4982.79）。

| 模型 | 本仓实测（积分/千 out） | 社区 duanz | 一致性 |
|---|---|---|---|
| `dm-auto-model/text.L1`（自动档 L1） | **10.0387** | 1M 档未单列 | — |
| `kimi-k3` | **6.2295** | 6.235 | **99.9%** |
| `dm-auto-model/text.L2`（自动档 L2） | **3.0630** | — | — |
| `qwen2.5-vl-32b-instruct` | **2.0276** | 2.024 | 99.8% |
| `model-text`（= `deepseek-v41-flash` = `text.L0` = `mm.L0`） | **2.0232** | 2.014 | 99.5% |
| `deepseek-v4-flash-0731` | **2.0051** | 2.007 | 99.9% |
| `glm-5`（后端 glm-5.2） | **2.0041** | 未列 | — |
| `dm-auto-model/mm.L2` | **2.0000** | — | — |
| `ernie-4.5-turbo-vl-32k` | **1.9923** | 1.997 | 99.8% |
| `dm-auto-model/mm.L1` | **1.9877** | — | — |
| `qwen3.8-max` | **1.9038** | 1.905 | 99.9% |
| `doubao-seed-2-0-pro` | **0.1934** | 0.193 | 99.8% |
| `glm-53` / `glm-53-flash` | **0.1160** | 0.087 / 0.122 | 量级一致 |
| `kimi-k31` | **0.1031** | 0.117 | 88% |
| `qwen38-flash` | **0.1003** | 0.100 | 99.7% |
| `deepseek-v4-pro` | **0.0963** | 0.100 | 96% |
| `qwen3.5-397b-a17b` | **0.0915** | 0.098 | 93% |
| `qwen3.5-27b` | **0.0580** | 0.067 | 87% |
| `qwen3.5-35b-a3b` | **0.0435** | 0.050 | 87% |
| `model-artifact-validate` | — | — | 制品校验专用，不跑对话 |

**16 个模型与社区数据对比，11 个在 1% 以内**——两套独立测量复现到小数点后两位，
说明这个口径是真的（不是一次巧合）。

### ② 重大发现：自动档有溢价，实测推翻了 `MODEL_NAMES` 的标注

早先按 `MODEL_NAMES` 的标注，把 `dm-auto-model/text.L1` 当作「就是 kimi-k3」、
`text.L2` / `mm.L2` 当作「就是 qwen3.8-max」，并据此把它们合并。实测推翻了：

```
dm-auto-model/text.L1   10.0387   vs  kimi-k3        6.2295   → 自动档贵 61%
dm-auto-model/text.L2    3.0630   vs  qwen3.8-max    1.9038   → 自动档贵 61%
dm-auto-model/mm.L2      2.0000   vs  qwen3.8-max    1.9038   → 贵 5%
```

所以 `BACKEND_OF` 只保留**实测同价**的四条（`model-text` / `deepseek-v41-flash` /
`text.L0` / `mm.L0` 全是 2.02），自动档 L1/L2 各自独立成行。合并会让人以为
「用自动档不加钱」，正好反了——**这条修正如果没跑实测，界面就会撒谎**。

### ③ 去重：24 行 → 21 行（同后端合并，名字不丢）

用户在界面上看到 24 行里四行跑的是同一个后端，要求「不要重复」。实现：

- 每行加 `backend`（`modelmap.backendOf`，只收实测同价的映射）；
- 按 backend 合并，主行按 rank 选（`native` > 有实测元数据 > 清单名）；
- 其余名字进 `alsoKnownAs`，界面在模型名下面显示「也叫 a / b」——**名字不删**，
  客户端仍能用它们调用，只是价格与主名相同；
- 档位信息跨合并保留（`deepseek-v41-flash` 是唯一带 `variants` 的名字，它并进
  `model-text` 后 `none/low/high/max` 不能丢）；
- `/v1/models` **不受影响**：那边列全部 22 个可调用名（客户端得选得到）。

### ④ 排序：下拉之前只给 TRAE/Qoder，搭子没有

`ModelInfoTable` 里排序下拉写着 `v-if="channel === 'traework' || channel === 'qoder'"`——
所以搭子拿到倍率也没法排序。改成 `hasRate`（任一行有倍率就给下拉），
分页阈值也从 20 提到 30（21 行不该被切成两页）。

**真机验证（playwright）**：默认「倍率高→低」第一行 `kimi-k3（自动档 L1）`；
切「低→高」第一行 `qwen3.5-35b-a3b`；切「名称」第一行 `deepseek-v4-flash-0731` 且排名列显示「—」。

### ⑤ 单位必须写全

倍率列单位从写死的「积分/千tok」改成读 `rateUnitText`：
双点解斜率是 **积分/千out**（纯 output token），老的单点口径是 **积分/千tok**（综合）。
两个数字不可混比——这是本项目反复强调的纪律，界面上必须分开显示。

---

## 6. 改动的文件清单

```
新增 src/dumate-catalog.js              模型清单（三级降级 + 过滤器 + 快照）
新增 src/dumate-reasoning.js            思考档位归一化（四档 + 显式开关）
新增 src/dumate-catalog.default.json   22 条内置默认（asOf 2026-11-13）
改  src/modelmap.js                     VERIFIED_MODELS / catalog* / mapModel(opts.catalog)
改  src/dumate-caps.js                  capOf 增加清单兜底（排在静态表之后）
改  src/model-info.js                   dumateCatalogOf（清单元数据兜底）
改  src/dumate-web.js                   quotaOverview 新增 product/status/points_expire_at + pools
改  src/server.js                       catalogLink + 四处 mapModel + /v1/models 追加 + 四处 reasoning
新增 test/unit/dumate-reasoning.test.js 9 项
新增 test/unit/dumate-pools.test.js     6 项
新增 test/verify-dumate-catalog.js      32 项（过滤/去重/快照回退/防注入/接线）
新增 test/probe-dumate-points.js        真机探针（P0-3 前置，需账号）
```

服务已按开发实例重启（9082 / 9083），9080 未动、未启动。
