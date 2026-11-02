<template>
  <div class="page chatlab">
    <!-- 顶部标题栏 -->
    <PageHeader
      title="聊天测试台"
      sub="走管理端登录态，不经密钥与 IP 管控 · 真实消耗积分，仅管理员可用"
    >
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="modelsLoading" @click="refreshModels">
          <template #icon><ReloadOutlined /></template>
          刷新模型
        </a-button>
        <a-button size="small" class="ghost-btn" :disabled="!messages.length" @click="clearChat">
          <template #icon><DeleteOutlined /></template>
          清空对话
        </a-button>
      </template>
    </PageHeader>

    <!-- 对话主体 -->
    <div class="lab-body">
      <div ref="scrollEl" class="chat-scroll">
        <!-- 空态 -->
        <div v-if="!messages.length" class="empty">
          <div class="empty-icon">
            <CommentOutlined />
          </div>
          <div class="empty-title">开始一次试调</div>
          <div class="empty-desc">
            在下方输入内容并回车即可。请求会经本管理端转发到上游，与下游调用走同一套账号池；<br>
            回答支持流式输出，每条回答的实际消耗积分会标在气泡下方。
          </div>
          <div class="empty-model">
            当前模型 <span>{{ model || '—' }}</span>
          </div>
        </div>

        <!-- 消息列表 -->
        <div
          v-for="(m, i) in messages"
          :key="i"
          class="msg"
          :class="m.role === 'user' ? 'msg-user' : 'msg-bot'"
        >
          <div class="avatar" :class="m.role === 'user' ? 'avatar-user' : 'avatar-bot'">
            <UserOutlined v-if="m.role === 'user'" />
            <RobotOutlined v-else />
          </div>

          <div class="msg-main">
            <div class="bubble" :class="m.role === 'user' ? 'bubble-user' : 'bubble-bot'">
              <!-- 思维链：默认折叠，正文才是要看的 -->
              <div v-if="m.reasoning" class="reason">
                <button class="reason-toggle" @click="m.showReasoning = !m.showReasoning">
                  <BulbOutlined />
                  思维链
                  <span class="reason-len num">{{ m.reasoning.length }} 字</span>
                  <DownOutlined class="reason-arrow" :class="{ open: m.showReasoning }" />
                </button>
                <pre v-if="m.showReasoning" class="reason-text">{{ m.reasoning }}</pre>
              </div>

              <div class="bubble-text">
                <span class="whitespace-pre-wrap">{{ m.content }}</span>
                <span v-if="m.streaming" class="caret" />
                <span v-if="m.streaming && !m.content && !m.reasoning" class="thinking">
                  <span class="dot" /><span class="dot" /><span class="dot" />
                </span>
              </div>

              <div v-if="m.error" class="bubble-error">
                <ExclamationCircleOutlined />
                {{ m.error }}
              </div>
            </div>

            <!-- 元信息：实测消耗、账号、token、耗时 -->
            <div v-if="m.role === 'assistant' && !m.streaming" class="meta">
              <span class="chip chip-cost num" :class="{ muted: m.cost === null || m.cost === undefined }">
                <ThunderboltOutlined />
                <template v-if="m.cost !== null && m.cost !== undefined">{{ m.cost.toLocaleString('zh-CN', { maximumFractionDigits: 6 }) }} 积分</template>
                <template v-else>{{ m.costNote || '未测到消耗' }}</template>
              </span>
              <span v-if="m.account" class="chip">{{ m.account }}</span>
              <span v-if="m.usage" class="chip num">{{ fmtNum(m.usage.total) }} Token</span>
              <span v-if="m.ms" class="chip num">{{ fmtMs(m.ms) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 输入区 -->
      <div class="composer">
        <a-textarea
          v-model:value="input"
          class="composer-input"
          :auto-size="{ minRows: 2, maxRows: 6 }"
          placeholder="输入内容，Enter 发送，Shift+Enter 换行"
          :disabled="sending"
          @pressEnter="onEnter"
        />

        <div class="composer-bar">
          <div class="bar-left">
            <!-- 通道选择器：不选的话用户得手打 qwen/ 前缀才知道走哪条通道 -->
            <a-select
              v-model:value="labChannel"
              size="small"
              style="width: 122px"
              :options="channelOptions"
              @change="onChannelChange"
            />
            <!-- 区域切换在顶栏（国内版/国际版），这里只读当前区域——
                 模型表与试调请求都按它走，两区账号与模型不同 -->
            <a-tag v-if="labChannel === 'traework' || labChannel === 'qoder' || labChannel === 'workbuddy'"
              :color="regionStore.current === 'intl' ? 'purple' : 'blue'" size="small">
              {{ regionStore.current === 'intl' ? '国际' : '国内' }}
            </a-tag>
            <a-select
              v-model:value="model"
              class="model-select"
              size="small"
              :options="modelOptions"
              show-search
              option-filter-prop="label"
            />
            <a-select v-model:value="streamMode" size="small" style="width: 104px" :options="streamOptions" />
          </div>

          <div class="bar-right">
            <span class="hint num">共 {{ modelCount }} 个可用模型</span>
            <span class="hint session-cost">
              本次消耗
              <b class="num">{{ sessionCost === null ? '—' : sessionCost }}</b>
            </span>
            <button
              class="send-btn"
              :class="{ ready: input.trim() && !sending }"
              :disabled="!input.trim() || sending"
              @click="send"
            >
              <LoadingOutlined v-if="sending" />
              <SendOutlined v-else />
            </button>
          </div>
        </div>
      </div>
    </div>

    <footer class="lab-foot">
      测试台仅用于调试（走管理端登录态，不经密钥与 IP 管控）· 正式接入请用「API 密钥」页签发的密钥<br>
      不支持的推理档位上游会自动降级
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  ReloadOutlined, DeleteOutlined, UserOutlined, RobotOutlined,
  SendOutlined, LoadingOutlined, BulbOutlined, DownOutlined,
  ExclamationCircleOutlined, CommentOutlined,
} from '@ant-design/icons-vue'
import client from '@/api/client'
import PageHeader from '@/components/PageHeader.vue'
import { channelStore, CHANNELS, isDirectChannel } from '@/stores/channel'
import { qwenworkApi as qwenApi } from '@/api/qwenwork'
import { traeworkApi } from '@/api/traework'
import { qoderApi } from '@/api/qoder'
import type { ChatLabModels } from '@/api/chatlab'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  showReasoning?: boolean
  streaming?: boolean
  error?: string
  cost?: number | null
  /** 直连通道测不到消耗时的说明（计费不在搭子余额里） */
  costNote?: string
  account?: string
  usage?: { input: number; output: number; total: number }
  ms?: number
}

const models = ref<ChatLabModels | null>(null)
const modelsLoading = ref(false)
const model = ref('')
const input = ref('')
const sending = ref(false)
const streamMode = ref('stream')
const messages = ref<ChatMessage[]>([])
const sessionCost = ref<number | null>(null)
const scrollEl = ref<HTMLElement | null>(null)

const streamOptions = [
  { label: '流式输出', value: 'stream' },
  { label: '非流式', value: 'plain' },
]

// 通道选择：测试台原本只能靠手打 `qwen/` 前缀走千问，这里给个下拉。
// 选项与全局切换器同源（stores/channel），避免两处各维护一份通道表。
// 它跟随顶栏的全局切换：两处必须一致，否则会出现「顶栏显示千问、
// 测试台下拉却是搭子」这种自相矛盾的状态。
const labChannel = ref(channelStore.current)
const channelOptions = CHANNELS.map((c) => ({ label: c.label, value: c.id }))

// 千问模型：从管理端接口拿（含中文名），选中的值带上 `qwen/` 前缀
const qwModels = ref<Array<{ id: string; name: string; prefixed: string }>>([])
const qwModelsLoading = ref(false)

// TRAE 模型：同样从管理端拿。与千问分开存——两者前缀不同（qwen/ vs
// traework/），混在一份里会让「切通道后下拉还留着上一个通道的模型名」，
// 而那个名字在新通道下根本不存在。内容是**可用对话模型 + TRAE 宝两条**
// （loadTwModels 里过滤），不是上游表全量——全量里 subagent / 占位条目
// 只会让下拉错乱。
const twModels = ref<Array<{ id: string; name: string; prefixed: string }>>([])
const twModelsLoading = ref(false)

// Qoder 模型：同样从管理端拿，且**必须带 `qoder/` 前缀**。
// 不带前缀的名字会被网关判成搭子——「选了 Qoder 模型却跑搭子」正是这么来的。
// rate 用来挑默认模型（倍率最低档）；上游模型表已从内部代号改成显示名，
// 按名字硬编码的「便宜档清单」匹配不到任何条目。
const qdModels = ref<Array<{ id: string; name: string; prefixed: string; rate?: number | null }>>([])
const qdModelsLoading = ref(false)

// WorkBuddy 模型（第五通道，双区域目录）
const wbModels = ref<Array<{ id: string; name: string; prefixed: string; rate?: number | null }>>([])
const wbModelsLoading = ref(false)

async function loadWbModels() {
  if (wbModelsLoading.value) return
  wbModelsLoading.value = true
  try {
    const { data } = await client.get(`/chatlab/workbuddy-models?region=${regionStore.current}`)
    wbModels.value = data.models || []
  } catch { /* 拿不到就空列表，不阻断 */ } finally {
    wbModelsLoading.value = false
  }
}

// 区域（2026-11-03）：顶栏统一切换（国内版/国际版），测试台只读。
// 单选器统一用 'cn'|'intl'，发请求时按通道映射（qoder/workbuddy 的后端都认 intl）
import { regionStore } from '@/stores/region'
import { watch as vueWatch } from 'vue'

function regionParam(): 'cn' | 'intl' | 'global' | undefined {
  if (labChannel.value === 'traework' || labChannel.value === 'workbuddy') return regionStore.current
  if (labChannel.value === 'qoder') return regionStore.current === 'intl' ? 'global' : 'cn'
  return undefined
}

// 区域切换后重拉当前通道的模型表（顶栏切换不经过本页的 change 事件）
vueWatch(() => regionStore.current, () => {
  model.value = ''
  applyChannel(labChannel.value)
})

async function loadQdModels() {
  if (qdModelsLoading.value) return
  qdModelsLoading.value = true
  try {
    const { data } = await qoderApi.chatlabModels(regionParam() as 'cn' | 'global' | undefined)
    qdModels.value = data.models || []
  } catch { /* 拿不到就空列表，不阻断 */ } finally {
    qdModelsLoading.value = false
  }
}

async function loadTwModels() {
  if (twModelsLoading.value) return
  twModelsLoading.value = true
  try {
    const { data } = await traeworkApi.models({ region: regionParam() as 'cn' | 'intl' | undefined })
    // 与网关 /v1/models 的 usableIds 同口径（可见 + 对话用途）——上游全量表
    // 里混着 computer_use_subagent 这类内部模型、custom_model_* 占位与
    // summary，全列出来下拉就是「错乱」的；模型名调不通的也不该出现
    const chat = (data.models || []).filter(
      (m) => m.visible && (m.usage === 'chat_completion' || !m.usage),
    )
    const list = chat.map((m) => ({ id: m.id, name: m.name, prefixed: m.prefixed }))
    // TRAE 宝（traebao/ 前缀 → personal_assistant 身份，当前免费豁免）。
    // 实测白名单只有 deepseek-v4.1-flash（其余上游 4001），不列调不通的。
    // **国内身份**：国际区域不列（personal_assistant 的豁免绑国内活动域）
    if (regionStore.current === 'cn') {
      list.push({ id: 'auto', name: 'TRAE 宝自动档（免费）', prefixed: 'traebao/auto' })
      if (chat.some((m) => m.id === 'deepseek-v4.1-flash')) {
        list.push({
          id: 'deepseek-v4.1-flash',
          name: 'TRAE 宝 · DeepSeek-V4.1-Flash（免费）',
          prefixed: 'traebao/deepseek-v4.1-flash',
        })
      }
    }
    twModels.value = list
  } catch { /* 拿不到就空列表，不阻断 */ } finally {
    twModelsLoading.value = false
  }
}

async function loadQwModels() {
  if (qwModelsLoading.value) return
  qwModelsLoading.value = true
  try {
    const { data } = await qwenApi.models()
    qwModels.value = data.models || []
  } catch { /* 拿不到就空列表，不阻断 */ } finally {
    qwModelsLoading.value = false
  }
}

// 按通道切换模型列表。**必须清空已选模型**：搭子的模型名（如 glm-5）
// 在直连通道下无效，留着会让「当前模型」显示一个根本不存在的名字。
async function applyChannel(id: string) {
  model.value = ''
  if (id === 'qwenwork') {
    if (!qwModels.value.length) await loadQwModels()
    model.value = qwModels.value[0]?.prefixed || ''
  } else if (id === 'traework') {
    if (!twModels.value.length) await loadTwModels()
    // 默认 TRAE 宝自动档：当前免费豁免，试调不该默认烧积分（与 Qoder
    // 分支默认挑 0.1 档同一逻辑）；活动结束或列表异常时退第一个
    model.value = twModels.value.find((m) => m.prefixed === 'traebao/auto')?.prefixed
      || twModels.value[0]?.prefixed || ''
  } else if (id === 'qoder') {
    if (!qdModels.value.length) await loadQdModels()
    // 默认挑**倍率最低**的：档位差 14 倍，试调不该默认烧最贵的那个。
    // rate>0 才参与（price_factor=0 是错峰免费档，窗口外按原价计费，
    // 拿它当「默认便宜」会误导）；倍率全缺失退列表第一个
    const cheapest = qdModels.value
      .filter((m) => m.rate != null && m.rate > 0)
      .sort((a, b) => (a.rate as number) - (b.rate as number))[0]
    model.value = cheapest?.prefixed || qdModels.value[0]?.prefixed || ''
  } else if (id === 'workbuddy') {
    if (!wbModels.value.length) await loadWbModels()
    // 默认挑**免费档**（credits x0.00 的模型），没有免费再挑倍率最低的
    const free = wbModels.value.find((m) => (m.rate ?? 1) === 0)
    const cheapest = wbModels.value
      .filter((m) => m.rate != null && m.rate > 0)
      .sort((a, b) => (a.rate as number) - (b.rate as number))[0]
    model.value = free?.prefixed || cheapest?.prefixed || wbModels.value[0]?.prefixed || ''
  } else {
    if (!models.value) await loadModels()
    model.value = models.value?.exposed?.[0]?.id || models.value?.aliases?.[0]?.id || ''
  }
}

// 顶栏切换通道时同步过来（下拉自己的 change 走 onChannelChange）
watch(() => channelStore.current, (id) => {
  if (labChannel.value === id) return
  labChannel.value = id
  applyChannel(id)
})

function onChannelChange(id: string) {
  channelStore.set(id)
  applyChannel(id)
}

// 上游模型与别名都列出来：别名能不能用恰恰是要试的东西
const modelOptions = computed(() => {
  const out: Array<{ label: string; value: string }> = []
  if (labChannel.value === 'qwenwork') {
    for (const m of qwModels.value) {
      // value 带前缀：网关靠前缀分流，不带就跑到搭子上去了
      out.push({ label: `${m.name} (${m.prefixed})`, value: m.prefixed })
    }
    return out
  }
  if (labChannel.value === 'traework') {
    for (const m of twModels.value) {
      out.push({ label: `${m.name} (${m.prefixed})`, value: m.prefixed })
    }
    return out
  }
  if (labChannel.value === 'qoder') {
    for (const m of qdModels.value) {
      // value 必须是带前缀的全名——网关靠前缀分流
      out.push({ label: `${m.name} (${m.prefixed})`, value: m.prefixed })
    }
    return out
  }
  if (labChannel.value === 'workbuddy') {
    for (const m of wbModels.value) {
      out.push({ label: `${m.name} (${m.prefixed})`, value: m.prefixed })
    }
    return out
  }
  for (const m of models.value?.exposed ?? []) {
    out.push({ label: `${m.id}（上游）`, value: m.id })
  }
  for (const m of models.value?.aliases ?? []) {
    out.push({ label: `${m.id} → ${m.mapped}`, value: m.id })
  }
  return out
})
const modelCount = computed(() => modelOptions.value.length)

const fmtNum = (n: number) => (n || 0).toLocaleString('zh-CN')
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`)

async function loadModels() {
  modelsLoading.value = true
  try {
    const { data } = await client.get('/chatlab/models')
    models.value = data
    // 只在搭子通道下补默认值——直连通道的模型名不带前缀会跑到搭子上。
    // 用 isDirectChannel() 而不是逐个比对 id：Qoder 接入时这里漏过一次
    // （判定只写了 qwenwork / traework），漏了会把 Qoder 当搭子补默认值。
    if (!model.value && !isDirectChannel(labChannel.value)) {
      model.value = data.exposed?.[0]?.id || data.aliases?.[0]?.id || ''
    }
  } finally {
    modelsLoading.value = false
  }
}

/** 刷新按钮：跟着当前通道走，别在直连通道下刷搭子的模型表 */
function refreshModels() {
  if (labChannel.value === 'qwenwork') return loadQwModels()
  if (labChannel.value === 'traework') return loadTwModels()
  if (labChannel.value === 'qoder') return loadQdModels()
  if (labChannel.value === 'workbuddy') return loadWbModels()
  return loadModels()
}

async function loadSessionCost() {
  try {
    const { data } = await client.get('/chatlab/session-cost')
    sessionCost.value = data.consumed ?? null
  } catch (e) { /* 拿不到就显示 — */ }
}

function onEnter(e: KeyboardEvent) {
  // Shift+Enter 换行，单独 Enter 发送
  if (e.shiftKey) return
  e.preventDefault()
  send()
}

function clearChat() {
  messages.value = []
  // 基准重置：否则「本次消耗」会把清空前的那部分也算进来
  client.post('/chatlab/session-cost/reset').then(() => loadSessionCost()).catch(() => {})
}

async function scrollToBottom() {
  await nextTick()
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
}

async function send() {
  const text = input.value.trim()
  if (!text || sending.value) return
  input.value = ''
  messages.value.push({ role: 'user', content: text })
  messages.value.push({
    role: 'assistant', content: '', reasoning: '', streaming: true, showReasoning: false,
  })
  const target = messages.value[messages.value.length - 1]
  sending.value = true
  await scrollToBottom()

  const history = messages.value
    .filter((m) => m.content && !m.streaming)
    .map((m) => ({ role: m.role, content: m.content }))

  try {
    if (streamMode.value === 'plain') {
      const { data } = await client.post('/chatlab/chat', {
        model: model.value, messages: history, stream: false,
        region: regionParam(),
      })
      target.content = data.content || '(空回答)'
      target.reasoning = data.reasoning || ''
      target.account = data.account
      target.usage = data.usage
      target.cost = data.cost
      target.costNote = data.costNote
      target.ms = data.ms
      target.streaming = false
      await loadSessionCost()
      return
    }

    // 流式：用 fetch 读 SSE（axios 不方便逐块读）
    const resp = await fetch('/api/admin/chatlab/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ model: model.value, messages: history, stream: true, region: regionParam() }),
    })
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}))
      throw new Error(j.error || `HTTP ${resp.status}`)
    }
    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() || ''
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        let evt: any
        try { evt = JSON.parse(line.slice(5).trim()) } catch (e) { continue }
        if (evt.type === 'delta') { target.content += evt.text; await scrollToBottom() }
        else if (evt.type === 'reasoning') {
          target.reasoning = (target.reasoning || '') + evt.text
          // 思维链默认折叠：只有用户展开时才跟着滚，否则每帧都强制滚到底
          if (target.showReasoning) await scrollToBottom()
        }
        else if (evt.type === 'meta') { target.account = evt.account }
        else if (evt.type === 'usage') { target.usage = evt.usage }
        else if (evt.type === 'error') { target.error = evt.error }
        else if (evt.type === 'done') {
          target.usage = evt.usage
          target.account = evt.account || target.account
          target.cost = evt.cost
          target.costNote = evt.costNote
        }
      }
    }
    target.streaming = false
    if (!target.content) target.content = target.error ? '' : '(空回答)'
    await loadSessionCost()
  } catch (e: any) {
    target.error = e?.message || '请求失败'
    target.streaming = false
  } finally {
    sending.value = false
    await scrollToBottom()
  }
}

onMounted(async () => {
  // 按**当前通道**初始化，而不是永远先加载搭子的模型表：
  // 顶栏已切到千问时进这个页面，下拉与模型列表都该是千问的
  await applyChannel(labChannel.value)
  loadSessionCost()
})
</script>

<style scoped>
/* 整页铺满内容区：对话要占满高度，输入框贴底。
   纵向布局与间距由全局 .page（flex + gap）负责，这里只补高度 */
.chatlab {
  height: calc(100vh - 96px);
}

/* ---------- 主体 ---------- */
.lab-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--lab-surface);
  border: 1px solid var(--lab-border);
  border-radius: var(--lab-radius);
  box-shadow: var(--lab-shadow);
  overflow: hidden;
}

.chat-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 28px 28px 12px;
  scroll-behavior: smooth;
}
.chat-scroll::-webkit-scrollbar {
  width: 6px;
}
.chat-scroll::-webkit-scrollbar-thumb {
  background: #c8d0db;
  border-radius: 3px;
}
.chat-scroll::-webkit-scrollbar-thumb:hover {
  background: #a8b4c4;
}

/* ---------- 空态 ---------- */
.empty {
  height: 100%;
  min-height: 320px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 48px 24px;
  animation: empty-in 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes empty-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: none; }
}
.empty-icon {
  width: 64px;
  height: 64px;
  border-radius: 20px;
  background: linear-gradient(135deg, var(--lab-primary-dim), rgba(8, 145, 178, 0.15));
  color: var(--lab-primary);
  font-size: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 20px;
  box-shadow: 0 4px 16px rgba(8, 145, 178, 0.12);
}
.empty-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--lab-text);
  margin-bottom: 10px;
  letter-spacing: 0.3px;
}
.empty-desc {
  font-size: 12.5px;
  color: var(--lab-text-mute);
  line-height: 2;
}
.empty-model {
  margin-top: 20px;
  font-size: 12px;
  color: var(--lab-text-mute);
}
.empty-model span {
  display: inline-block;
  margin-left: 6px;
  padding: 3px 12px;
  border-radius: 999px;
  background: var(--lab-primary-dim);
  color: var(--lab-primary);
  font-family: var(--lab-mono);
  font-weight: 500;
  font-size: 11.5px;
}

/* ---------- 消息 ---------- */
.msg {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
  align-items: flex-start;
  animation: msg-in 0.35s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes msg-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
.msg-user {
  flex-direction: row-reverse;
}
.msg-main {
  min-width: 0;
  max-width: 76%;
  display: flex;
  flex-direction: column;
}
.msg-user .msg-main {
  align-items: flex-end;
}

.avatar {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  margin-top: 2px;
  flex-shrink: 0;
}
.avatar-user {
  background: linear-gradient(135deg, #0891b2, #0e7490);
  color: #ffffff;
  box-shadow: 0 2px 8px rgba(8, 145, 178, 0.25);
}
.avatar-bot {
  background: var(--lab-surface-3);
  color: var(--lab-text-sub);
  border: 1px solid var(--lab-border);
}

.bubble {
  padding: 12px 16px;
  border-radius: 14px;
  font-size: 14px;
  line-height: 1.8;
  word-break: break-word;
  transition: box-shadow 0.2s ease;
}
.bubble-user {
  background: linear-gradient(135deg, #0e7490, #155e75);
  color: #e8faff;
  border-top-right-radius: 4px;
  box-shadow: 0 2px 12px rgba(14, 116, 144, 0.3);
}
.bubble-user:hover {
  box-shadow: 0 4px 18px rgba(14, 116, 144, 0.38);
}
.bubble-bot {
  background: var(--lab-surface-2);
  color: var(--lab-text);
  border: 1px solid var(--lab-border);
  border-top-left-radius: 4px;
}
.bubble-bot:hover {
  box-shadow: var(--lab-shadow-card);
}
.bubble-error {
  margin-top: 10px;
  padding: 8px 12px;
  border-top: 1px dashed rgba(220, 38, 38, 0.35);
  font-size: 12px;
  color: var(--lab-danger);
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--lab-danger-dim);
  border-radius: 10px;
}

/* 思维链 */
.reason {
  margin-bottom: 10px;
}
.reason-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border: 1px solid var(--lab-border-strong);
  background: var(--lab-surface);
  border-radius: 999px;
  font-size: 12px;
  color: var(--lab-text-sub);
  cursor: pointer;
  transition: all 0.2s ease;
}
.reason-toggle:hover {
  border-color: var(--lab-primary-line);
  color: var(--lab-primary);
  background: var(--lab-primary-dim);
}
.reason-len {
  color: var(--lab-text-mute);
  font-size: 11px;
}
.reason-arrow {
  font-size: 10px;
  transition: transform 0.25s ease;
}
.reason-arrow.open {
  transform: rotate(180deg);
}
.reason-text {
  margin: 10px 0 0;
  padding: 12px 14px;
  background: var(--lab-bg-2);
  border: 1px solid var(--lab-border);
  border-left: 3px solid var(--lab-primary);
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--lab-text-sub);
  white-space: pre-wrap;
  max-height: 240px;
  overflow-y: auto;
  font-family: var(--lab-mono);
}

/* 流式光标与等待点 */
.caret {
  display: inline-block;
  width: 2px;
  height: 16px;
  margin-left: 3px;
  vertical-align: -2px;
  background: var(--lab-primary);
  border-radius: 1px;
  animation: blink 0.9s step-end infinite;
}
@keyframes blink {
  50% { opacity: 0; }
}
.thinking {
  display: inline-flex;
  gap: 5px;
  margin-left: 6px;
}
.thinking .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--lab-text-mute);
  animation: bounce 1.3s infinite ease-in-out;
}
.thinking .dot:nth-child(2) { animation-delay: 0.18s; }
.thinking .dot:nth-child(3) { animation-delay: 0.36s; }
@keyframes bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-5px); opacity: 1; }
}

/* 元信息芯片 */
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--lab-surface-2);
  border: 1px solid var(--lab-border);
  font-size: 11px;
  color: var(--lab-text-mute);
  transition: all 0.15s ease;
}
.chip:hover {
  border-color: var(--lab-border-strong);
  background: var(--lab-surface);
}
.chip-cost {
  background: var(--lab-ok-dim);
  border-color: rgba(5, 150, 105, 0.25);
  color: var(--lab-ok);
  font-weight: 500;
}
.chip-cost.muted {
  background: var(--lab-surface-2);
  border-color: var(--lab-border);
  color: var(--lab-text-mute);
  font-weight: 400;
}

/* ---------- 输入区 ---------- */
.composer {
  flex: none;
  border-top: 1px solid var(--lab-border);
  padding: 14px 20px 16px;
  background: var(--lab-bg-2);
}
.composer-input {
  border-radius: var(--lab-radius-sm) !important;
  border-color: var(--lab-border) !important;
  font-size: 14px;
  resize: none;
  background: var(--lab-surface) !important;
  transition: all 0.2s ease;
}
.composer-input:hover {
  border-color: var(--lab-border-strong) !important;
}
.composer-input:focus,
.composer-input:focus-within {
  border-color: var(--lab-primary) !important;
  box-shadow: 0 0 0 3px var(--lab-primary-dim) !important;
}
.composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.bar-left,
.bar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 通道/模型/模式三个下拉在窄屏放不下时换行，别把右侧按钮挤出去 */
.bar-left {
  flex-wrap: wrap;
}
.model-select {
  min-width: 240px;
}
.hint {
  font-size: 11px;
  color: var(--lab-text-mute);
}
.session-cost b {
  color: var(--lab-text-sub);
  font-weight: 600;
  font-family: var(--lab-mono);
}
.send-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: var(--lab-surface-3);
  color: var(--lab-text-mute);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: not-allowed;
  transition: all 0.2s cubic-bezier(0.22, 1, 0.36, 1);
  font-size: 15px;
}
.send-btn.ready {
  background: linear-gradient(135deg, #0891b2, #0e7490);
  color: #ffffff;
  cursor: pointer;
  box-shadow: 0 3px 12px rgba(8, 145, 178, 0.28);
}
.send-btn.ready:hover {
  transform: translateY(-2px) scale(1.05);
  box-shadow: 0 6px 20px rgba(8, 145, 178, 0.36);
}
.send-btn.ready:active {
  transform: translateY(0) scale(1);
}

/* ---------- 页脚 ---------- */
.lab-foot {
  flex: none;
  text-align: center;
  font-size: 11px;
  color: var(--lab-text-mute);
  line-height: 1.9;
  opacity: 0.75;
}

/* 窄屏：模型下拉允许收缩换行，桌面（>=769px）保持 240px 不动 */
@media (max-width: 768px) {
  .model-select {
    flex: 1 1 160px;
    min-width: 0;
  }
}

/* 用户要求减少动效时：只保留静态呈现 */
@media (prefers-reduced-motion: reduce) {
  .empty, .msg, .caret, .thinking .dot {
    animation: none;
  }
}
</style>
