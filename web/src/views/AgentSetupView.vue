<template>
  <div class="page">
    <PageHeader
      title="接入配置"
      sub="一键把本机 Claude Code / Codex CLI 指向本网关（写前自动备份，可一键还原）"
    />

    <a-alert type="info" show-icon>
      <template #message>
        网关地址 <span class="font-mono">{{ gateway || '—' }}</span>
      </template>
      <template #description>
        写入的是本机文件：Claude Code 的 <span class="font-mono">~/.claude/settings.json</span>
        （只合并 env 里本网关的键，permissions / hooks 等其他键原样保留）；
        Codex CLI 的 <span class="font-mono">~/.codex/config.toml</span>
        （只动托管键与托管 provider 表，用户自己的配置不重排）。
        每次写入前自动备份到 <span class="font-mono">data/agent-setup/</span>，可随时还原。
        cc-switch 请用它自己的入口（API Key 页「配置到 cc-switch」）。
      </template>
    </a-alert>

    <a-card :bordered="false">
      <div class="card-head-row">
        <div>
          <span class="section-title">本机客户端</span>
          <span class="hint-text ml-2">按本机当前配置实时探测</span>
        </div>
        <a-button size="small" :loading="loading" @click="load">刷新</a-button>
      </div>

      <a-spin :spinning="loading">
        <div v-for="c in clients" :key="c.id" class="setup-row">
          <div class="setup-main">
            <div class="setup-name">
              {{ c.name }}
              <a-tag :color="c.configured ? 'green' : c.configExists ? 'orange' : 'default'">
                {{ c.configured ? '已指向本网关' : c.configExists ? '已存在但未配置' : '未配置' }}
              </a-tag>
            </div>
            <div class="text-xs text-slate-400 font-mono break-all">{{ c.configPath }}</div>
            <div class="text-xs text-slate-500 mt-1">{{ c.detail }}</div>
          </div>
          <a-space v-if="c.id !== 'cc-switch'">
            <a-button type="primary" size="small" :disabled="!isAdmin" @click="openApply(c)">
              写入配置
            </a-button>
            <a-popconfirm
              title="用最近一份备份覆盖当前配置？当前态会先留一份档"
              ok-text="还原"
              cancel-text="取消"
              @confirm="doRestore(c)"
            >
              <a-button size="small" danger :disabled="!isAdmin">还原</a-button>
            </a-popconfirm>
          </a-space>
        </div>
        <div v-if="!clients.length && !loading" class="hint-text">没有探测到任何客户端</div>
      </a-spin>
    </a-card>

    <!-- 最近一次写入的结果：备份路径、模型、推导出的上下文与上限。
         放页面上而不是弹窗——这些值是「依据」，用户会想边看边核对 -->
    <a-card v-if="lastResult" :bordered="false" title="最近一次写入">
      <a-descriptions :column="2" size="small" bordered>
        <a-descriptions-item label="客户端">{{ lastResult.client }}</a-descriptions-item>
        <a-descriptions-item label="通道">{{ lastResult.channel }}</a-descriptions-item>
        <a-descriptions-item label="配置文件" :span="2">
          <span class="font-mono text-xs break-all">{{ lastResult.configPath }}</span>
        </a-descriptions-item>
        <a-descriptions-item label="备份文件" :span="2">
          <span v-if="lastResult.backup" class="font-mono text-xs break-all">{{ lastResult.backup }}</span>
          <span v-else class="text-slate-400">原文件不存在，无需备份</span>
        </a-descriptions-item>
        <a-descriptions-item label="默认模型">{{ lastResult.model || '—' }}</a-descriptions-item>
        <a-descriptions-item label="上下文窗口">
          {{ lastResult.derived?.context_window ?? '—' }}
        </a-descriptions-item>
        <a-descriptions-item label="压缩线">
          {{ lastResult.derived?.compact_limit ?? '—' }}
        </a-descriptions-item>
        <a-descriptions-item label="输出上限">
          {{ lastResult.derived?.max_output ?? '—' }}
        </a-descriptions-item>
      </a-descriptions>
      <div class="text-xs text-slate-500 mt-2">{{ lastResult.note }}</div>
      <div v-if="lastResult.accountNote" class="text-xs text-slate-500 mt-1">
        {{ lastResult.accountNote }}
      </div>
      <div v-for="(n, i) in lastResult.derived?.notes || []" :key="i" class="text-xs text-amber-500 mt-1">
        {{ n }}
      </div>
    </a-card>

    <a-modal
      v-model:open="dlgOpen"
      :title="`写入 ${dlgClient?.name || ''} 配置`"
      :confirm-loading="saving"
      ok-text="写入"
      cancel-text="取消"
      @ok="doApply"
    >
      <a-form layout="vertical">
        <a-form-item label="通道">
          <a-select v-model:value="form.channel" :options="channelOptions" />
          <div class="text-xs text-slate-500 mt-1">
            档位模型按该通道的模型表自动推导（有倍率的按倍率升序取前 3 档）。
            当前账号不可用时会在写入时报错，不会写入空配置。
          </div>
        </a-form-item>
        <a-form-item label="API Key">
          <a-select
            v-model:value="form.keyId"
            :options="keyOptions"
            allow-clear
            placeholder="从已登记的 Key 里选一把"
            @change="onPickKey"
          />
          <a-input
            v-model:value="form.token"
            class="mt-2"
            placeholder="或直接填入 token"
          />
          <div class="text-xs text-slate-500 mt-1">
            网关鉴权已强制开启，<span class="font-medium">留空会写入 nokey 占位，该客户端请求将被 401 拒绝</span>。
            只有明文已保存的 Key 能在这里选到。
          </div>
        </a-form-item>
      </a-form>
      <a-alert v-if="applyError" type="error" show-icon class="mt-2" :message="applyError" />
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { App as AntApp } from 'ant-design-vue'
import PageHeader from '@/components/PageHeader.vue'
import client from '@/api/client'
import { agentSetupApi, type SetupApplyResult, type SetupClient } from '@/api/agentsetup'
import { isAdmin } from '@/stores/auth'

const { message } = AntApp.useApp()

const loading = ref(false)
const clients = ref<SetupClient[]>([])
const gateway = ref('')

const dlgOpen = ref(false)
const dlgClient = ref<SetupClient | null>(null)
const saving = ref(false)
const applyError = ref('')
const lastResult = ref<SetupApplyResult | null>(null)

const form = reactive({
  channel: 'dumate',
  keyId: undefined as number | undefined,
  token: '',
})

// 与后端 apply 的通道白名单一致（通道 id 单一来源在 src/channels.js）
const channelOptions = [
  { label: '百度搭子', value: 'dumate' },
  { label: '千问办公', value: 'qwenwork' },
  { label: 'TRAE Work', value: 'traework' },
  { label: 'Qoder', value: 'qoder' },
  { label: 'WorkBuddy', value: 'workbuddy' },
]

const keyOptions = ref<Array<{ label: string; value: number }>>([])
const keyPlain = new Map<number, string>()

function onPickKey(v: number | undefined) {
  if (v == null) return
  form.token = keyPlain.get(v) || ''
}

async function load() {
  loading.value = true
  try {
    const { data } = await agentSetupApi.clients()
    clients.value = data.clients || []
    gateway.value = data.gateway || ''
  } catch (e: any) {
    message.error(e?.response?.data?.error || '读取客户端状态失败')
  } finally {
    loading.value = false
  }
}

async function loadKeys() {
  try {
    const { data } = await client.get('/keys')
    const list = (data.keys || []) as Array<{ id: number; name: string; plain: string | null }>
    keyOptions.value = list
      .filter((k) => k.plain)
      .map((k) => ({ label: k.name, value: k.id }))
    keyPlain.clear()
    for (const k of list) if (k.plain) keyPlain.set(k.id, k.plain)
  } catch (e) {
    /* Key 列表拉不到不影响手填 token */
  }
}

function openApply(c: SetupClient) {
  dlgClient.value = c
  applyError.value = ''
  // 默认用已有明文 Key 的第一把：鉴权强制后 nokey 必 401，默认值就该是能用的
  const first = keyOptions.value[0]
  form.keyId = first ? first.value : undefined
  form.token = first ? keyPlain.get(first.value) || '' : ''
  dlgOpen.value = true
}

async function doApply() {
  if (!dlgClient.value) return
  applyError.value = ''
  saving.value = true
  try {
    const { data } = await agentSetupApi.apply({
      client: dlgClient.value.id,
      channel: form.channel,
      token: form.token.trim(),
    })
    lastResult.value = data
    message.success(`${dlgClient.value.name} 配置已写入`)
    dlgOpen.value = false
    await load()
  } catch (e: any) {
    applyError.value = e?.response?.data?.error || '写入失败'
  } finally {
    saving.value = false
  }
}

async function doRestore(c: SetupClient) {
  try {
    const { data } = await agentSetupApi.restore(c.id)
    message.success(`${c.name} 已还原（来源：${data.restoredFrom}）`)
    await load()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '还原失败')
  }
}

onMounted(async () => {
  await Promise.all([load(), loadKeys()])
})
</script>

<style scoped>
.setup-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid rgba(148, 163, 184, 0.14);
}
.setup-row:last-child {
  border-bottom: none;
}
.setup-main {
  min-width: 0;
}
.setup-name {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}
</style>
