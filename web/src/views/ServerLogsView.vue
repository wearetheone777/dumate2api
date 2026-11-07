<template>
  <div class="page">
    <PageHeader title="运行日志" sub="本管理端进程的控制台输出 · 敏感行整行丢弃">
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
      </template>
    </PageHeader>

    <a-alert type="warning" show-icon class="mb-3">
      <template #message>只读进程内缓冲</template>
      <template #description>
        只收本管理端进程的 console 输出，重启即清空；网关进程日志请到启动器的日志文件看。
        命中 token / secret / authorization / cookie / password / api_key / Bearer / sk- 形状的
        <b>整行不进缓冲</b>，不是发出后再打码。最多 500 行、SSE 订阅者上限 4。
      </template>
    </a-alert>

    <a-card :bordered="false">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <a-select v-model:value="level" size="small" style="width: 130px" :options="levelOptions" />
        <a-input v-model:value="keyword" size="small" allow-clear placeholder="关键字" style="width: 220px" />
        <a-switch v-model:checked="follow" size="small" checked-children="跟随" un-checked-children="暂停" />
        <a-tag :color="connected ? 'green' : 'default'">{{ connected ? 'SSE 已连接' : 'SSE 未连接' }}</a-tag>
        <span class="text-xs text-slate-400">共 {{ total }} 行 / 容量 {{ capacity }}</span>
      </div>

      <a-table
        size="small"
        :loading="loading"
        :columns="columns"
        :data-source="rows"
        row-key="seq"
        :pagination="{ pageSize: 20, size: 'small', showSizeChanger: false }"
        :scroll="{ y: 520 }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'ts'">
            <span class="num">{{ fmtTime(record.ts) }}</span>
          </template>
          <template v-else-if="column.key === 'level'">
            <a-tag :color="record.level === 'error' ? 'red' : record.level === 'warn' ? 'orange' : 'default'">
              {{ record.level }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'text'">
            <code class="log-line">{{ record.text }}</code>
          </template>
        </template>
      </a-table>
    </a-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { App } from 'ant-design-vue'
import PageHeader from '@/components/PageHeader.vue'
import { logsApi } from '@/api/traeruntime'
import type { ServerLogRow } from '@/api/traeruntime'

const { message } = App.useApp()
const rows = ref<ServerLogRow[]>([])
const total = ref(0)
const capacity = ref(0)
const loading = ref(false)
const level = ref('')
const keyword = ref('')
const follow = ref(true)
const connected = ref(false)
let source: EventSource | null = null

const levelOptions = [
  { label: '全部级别', value: '' },
  { label: 'info', value: 'log' },
  { label: 'warn', value: 'warn' },
  { label: 'error', value: 'error' },
]
const columns = [
  { title: '时间', key: 'ts', width: 170 },
  { title: '级别', key: 'level', width: 90 },
  { title: '内容', key: 'text' },
]

const fmtTime = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false })

async function load() {
  loading.value = true
  try {
    const { data } = await logsApi.list({ level: level.value, keyword: keyword.value, limit: 500 })
    rows.value = data.rows
    total.value = data.total
    capacity.value = data.capacity
  } catch (e: any) {
    message.error(e?.response?.data?.error || '读取日志失败')
  } finally {
    loading.value = false
  }
}

function connect() {
  source?.close()
  source = null
  connected.value = false
  if (!follow.value) return
  try {
    source = new EventSource(logsApi.streamUrl(level.value, keyword.value))
    source.onopen = () => { connected.value = true }
    source.onerror = () => { connected.value = false }
    source.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as ServerLogRow
        rows.value = [...rows.value.filter((x) => x.seq !== e.seq), e].sort((a, b) => a.seq - b.seq).slice(-500)
        total.value = rows.value.length
      } catch { /* 非法帧跳过 */ }
    }
  } catch (e: any) {
    message.error(e?.message || 'SSE 连接失败')
  }
}

watch([level, keyword, follow], () => { load(); connect() })
onMounted(() => { load(); connect() })
onUnmounted(() => { source?.close(); source = null })
</script>

<style scoped>
.log-line {
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
