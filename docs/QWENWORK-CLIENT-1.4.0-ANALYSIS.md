# 千问办公客户端 1.4.0 解包分析（2026-10-31）

> 目标：找回「附件上传」协议（P1-11 卡住的那一半）。
> 结论先行：**附件不走 HTTP chat body，走 ACP WebSocket + barn 预上传**；
> 另外挖到三个可直接接入的新端点与一处版本号漂移。

## 0. 样本

| 项 | 值 |
|---|---|
| 安装包 | `qwenworkcn-setup-x64.exe`（301MB，NSIS 3 Unicode） |
| 下载源 | `https://assets.qwenwork.cn/release/latest/qwenworkcn-setup-x64.exe` |
| 签名 | **Valid**，`CN="DingTalk Technology Co., Ltd."`（阿里） |
| 应用版本 | `qwen-work-cn` **1.4.0** |
| agent runtime | `qoder-worker-runtime` **1.1.71**（`@qoder-ai/qoder-agent-sdk`，commit `809347c`） |
| 解包方式 | 7z 拆 NSIS → `app-64.7z` → `app.asar`（直接读 asar header + 切片，绕过 unpacked 缺失） |

样本留在 `D:/dsh-data/downloads/qwenwork-client-20261031/`（2.4G，含原包与解包产物），**未安装、未运行**。

## 1. 版本号漂移（要改我们的常量）

我们 `src/qwenwork/constants.js` 写的是：

| 常量 | 现值（我们） | 1.4.0 实际 | 影响 |
|---|---|---|---|
| `COSY_VERSION` | `1.1.52` | worker runtime **1.1.71** | 与 Qoder 的 1.1.75 已收敛到同一代 |
| `IDE_VERSION` / `RELEASE_VERSION` | `1.1.0` / `1.1.0-26091701` | `1.4.0` | 进 `X-QwenWork-*` 头 |
| 身份头 | 无 | `X-QwenWork-Version` / `-Release-Version` / `-Build` / `-Platform` / `-Arch` / `-Channel` / `-App-Mode` | 官方桌面请求都带 |

**目前 1.1.52 仍能出流**（真机验证过），所以不必立刻改；但上游开始做版本门时会先卡这里。

## 2. 附件：真正的协议是 ACP + barn（P1-11 的答案）

### 2.1 为什么 HTTP 链路上找不到

`chat_context` 的构造是**写死**的：

```js
function ydl(text, modelKey, isReasoning) {
  return { text, features: [], extra: { context: [], modelConfig: { key: modelKey, is_reasoning: isReasoning }, originalContent: text },
           chatPrompt: '', imageUrls: null };   // ← 恒为 null
}
```

即我们这条 `agent_chat_generation` 链路**结构上不支持附件**，不是「没找到字段」。
图片走的是另一条：`messages[].content` 的 `image_url` part（`ContentPart`），
但那是给 **ACP 会话**用的。

### 2.2 真正的两条链路

```text
barn（文件存储）  POST /api/barn/v1/upload {path, size, mime_type, metadata, chunk_size}
                  → session_id
                  POST /api/barn/v1/upload/{session_id}/chunks?chunk_number=N  (application/octet-stream)
                  POST /api/barn/v1/upload/{session_id}                       (完成)
                  DELETE /api/barn/v1/upload/{session_id}                     (取消)
                  下载：GET /api/barn/v1/files/{path}?mode=preview|download → presigned_url

ACP 会话（附件引用）  wss://qwenwork.cn/api/chat-ws
                  消息里带 file_uuid / file_name（`BVu = { file_uuid, file_name }`）
                  取内容：GET /api/oauth/files/{file_uuid}/content  （Bearer）
```

关键证据：
- `uploadBytes`（main.js）：`chunk_size = clamp(1MB, 100MB, ceil(size/10))`，分片 POST，最后不带 body 的 POST 收尾。
- `attachments.download`（worker）：`GET /api/oauth/files/{file_uuid}/content`，`file_uuid` 由**上游下发**（`J.object({file_uuid, file_name})`），不是客户端生成。
- 附件大小上限：单文件 `104857600`（100MB），`3e5` 超时。
- `barn_url` = `getPagesBaseUrl()` = `https://{openapi 域}/api`；CN prod 的 openapi 域解析为
  **`gateway.qwenwork.cn`**（`constants.a2 = Dt = I = to = "gateway.qwenwork.cn"`）。

**所以完整链路是**：先把文件上传进 barn（HTTP，我们有凭证能打）→ 在 ACP 会话里引用它。
**我们缺的是后半段**：ACP WebSocket 会话。

### 2.3 结论

P1-11 不是一个「补一个字段」的活，它是 **P2-17（接 ACP 通道）的前置**。
在 HTTP 链路上做不了，因为 `imageUrls: null` 是写死的、`text` 是唯一载荷。

## 3. 新挖到的可接入端点（worker runtime 里 10 个 `/algo` 端点）

| 端点 | 方法 | 请求体 | 价值 |
|---|---|---|---|
| `/algo/api/v1/webSearch/oneSearch`（国际版 `/unifiedSearch`） | POST | `{query, allowed_domains?, blocked_domains?, timeRange:"NoLimit", contents:{mainText,markdownText,summary}}`，`withWasmSigning` | **联网搜索**，独立于对话 |
| `/algo/api/v2/service/pro/imageSearch` | POST | `{query, count}`，`query:{Encode:"1"}` | **图搜** |
| `/algo/api/v2/service/voice/polish` | POST | 未细读 | 语音润色 |
| `/algo/api/v1/ping` | GET | — | 探活（比 `/health` 更贴近上游） |
| `/algo/api/v2/service/business/finish` | POST | 业务结束上报 | 计费/统计口径 |
| `/algo/api/v2/byok/check` `/byok/config` | — | — | 自带 Key（BYOK） |
| `/algo/api/v5/service/region/endpoints` | GET | — | **区域端点发现**（比 v3 新一版） |

其中 **webSearch 与 imageSearch 是我们清单里没有的新能力**，且都走 COSY 签名（我们已实现）。

## 4. 结构上的其它发现

1. **agent 侧跑的是 ACP 协议**：`flash-cli` 组件 `protocol: "acp-stdio"`，版本 `1.18.18-26102002`，
   入口 `runtime/flash-cli-acp.mjs`。主进程通过 `ELECTRON_RUN_AS_NODE=1` spawn 它。
   这印证了 P2-17 的判断：ACP 是**独立通道**，不是 chat 桥的一层。
2. **`proto/chat.proto` 是 OpenAI 兼容的 gRPC schema**（`ChatCompletionRequest` 含
   `response_format` / `json_schema` / `parallel_tool_calls` / `patches` / `custom_model`），
   但**当前代码里没有任何地方 import 它**（只在 vendor 里躺着）。属未启用能力，不追。
3. **官方客户端的 `chat_context` 与我们的构造逐字段一致**（`text`/`features`/`extra.context`/
   `modelConfig`/`originalContent`/`chatPrompt`/`imageUrls`），说明我们的 body 构造是对的。
4. **模型表元数据**在客户端也是同一套（`price_factor` / `context_config` / `is_vl`），
   与我们 P1-12 的解析一致。
5. **本地推理（`windows-product-local-inference`）** 是 Windows 专属 facade，当前只在
   `constants.L` 为真时注册，且配置非法时直接 warn 跳过——不是主力链路。

## 5. 对清单的修订

| 项 | 原判断 | 修订 |
|---|---|---|
| P1-11 千问附件上传 | 「证据不足，暂缓」 | **确认不可行（HTTP 侧）**：`imageUrls: null` 写死，必须走 ACP。转 P2-17 的前置 |
| P2-17 ACP 会话 | 「独立通道，高难度」 | 证据补齐：`wss://qwenwork.cn/api/chat-ws` + barn 预上传 + `file_uuid` 引用 |
| **新增** 千问联网搜索 | — | `POST /algo/api/v1/webSearch/oneSearch`，可独立暴露 |
| **新增** 千问图搜 | — | `POST /algo/api/v2/service/pro/imageSearch` |
| 千问区域端点发现 | 「低中难度」 | 已有 v5 版本，比 v3 新 |
| 千问版本常量 | 未列 | `COSY_VERSION` 1.1.52 → 1.1.71、`X-QwenWork-*` 身份头 |

## 6. 复现方式

```bash
# 1. 下载（301MB）
curl -L -o qwenworkcn-setup-x64.exe https://assets.qwenwork.cn/release/latest/qwenworkcn-setup-x64.exe
# 2. 验签（必须 Valid + DingTalk Technology）
#    PowerShell: Get-AuthenticodeSignature <exe>
# 3. 解 NSIS
7z x qwenworkcn-setup-x64.exe -oextract
# 4. 解内层
7z x 'extract/$PLUGINSDIR/app-64.7z' -oextract/app
# 5. 解 asar（直接读 header，绕开 unpacked 缺失）
#    header: [4B][pickleSize][4B][strLen][JSON...]，文件区偏移 = 8 + pickleSize + 4
```

**不要安装**：解包已足够，安装会改系统状态（服务、注册表、代理设置）。
