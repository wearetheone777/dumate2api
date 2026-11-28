<template>
  <div class="page">
    <PageHeader title="运行日志" sub="本管理端进程的控制台输出 · 敏感行整行丢弃">
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
      </template>
    </PageHeader>

    <a-alert type="warning" show-icon class="mb-3">
      <template #message>只读进程内缓冲 + 每日归档</template>
      <template #description>
        内存环按行首特征分 chat / task / sys 三频道（[chat] 等显式标签直接命中；
        [keepalive] 等巡检前缀归 task，其余 sys），task 结果不被对话流量冲掉。
        每天一份 JSONL 落 <code>data/logs/</code>（30 天滚动清理），可按天数导出 ZIP。
        命中 token / secret / authorization / cookie / password / api_key / Bearer / sk- 形状的
        <b>整行不进缓冲也不落盘</b>，不是发出后再打码。每频道最多 {{ capacity }} 行、SSE 订阅者上限 4。
      </template>
    </a-alert>

    <a-card :bordered="false">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <a-select v-model:value="channel" size="small" style="width: 130px" :options="channelOptions" />
        <a-select v-model:value="level" size="small" style="width: 110px" :options="levelOptions" />
        <a-input v-model:value="keyword" size="small" allow-clear placeholder="关键字" style="width: 200px" />
        <a-switch v-model:checked="follow" size="small" checked-children="跟随" un-checked-children="暂停" />
        <a-tag :color="connected ? 'green' : 'default'">{{ connected ? 'SSE 已连接' : 'SSE 未连接' }}</a-tag>
        <span class="text-xs text-slate-400">
          共 {{ total }} 行<template v-if="channel === ''">（chat {{ byChannel.chat || 0 }} / task {{ byChannel.task || 0 }} / sys {{ byChannel.sys || 0 }}）</template>/ 每频道容量 {{ capacity }}
        </span>
        <span class="flex-1" />
        <a-select v-model:value="exportDays" size="small" style="width: 110px" :options="exportDayOptions" />
        <a-button size="small" @click="doExport">导出 ZIP</a-button>
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
          <template v-else-if="column.key === 'ch'">
            <a-tag :color="chColor(record.ch)">{{ record.ch }}</a-tag>
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
import type { ServerLogRow, ServerLogChannel } from '@/api/traeruntime'

const { message } = App.useApp()
const rows = ref<ServerLogRow[]>([])
const total = ref(0)
const byChannel = ref<Record<string, number>>({})
const capacity = ref(0)
const loading = ref(false)
const channel = ref('')
const level = ref('')
const keyword = ref('')
const follow = ref(true)
const connected = ref(false)
const exportDays = ref(7)
let source: EventSource | null = null

const channelOptions = [
  { label: '全部频道', value: '' },
  { label: 'chat（对话）', value: 'chat' },
  { label: 'task（任务）', value: 'task' },
  { label: 'sys（系统）', value: 'sys' },
]
const levelOptions = [
  { label: '全部级别', value: '' },
  { label: 'info', value: 'log' },
  { label: 'warn', value: 'warn' },
  { label: 'error', value: 'error' },
]
const exportDayOptions = [1, 3, 7, 14, 30].map((d) => ({ label: `${d} 天`, value: d }))
const columns = [
  { title: '时间', key: 'ts', width: 170 },
  { title: '级别', key: 'level', width: 90 },
  { title: '频道', key: 'ch', width: 80 },
  { title: '内容', key: 'text' },
]

const fmtTime = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false })
const chColor = (ch: ServerLogChannel) => (ch === 'chat' ? 'blue' : ch === 'task' ? 'purple' : 'default')

// 导出按天数取，频道筛选只作用于当前视图（ZIP 是原始归档，不再二次过滤）
function doExport() {
  window.open(logsApi.exportUrl(exportDays.value))
}

async function load() {
  loading.value = true
  try {
    const { data } = await logsApi.list({ level: level.value, keyword: keyword.value, channel: channel.value, limit: 500 })
    rows.value = data.rows
    total.value = data.total
    byChannel.value = data.byChannel || {}
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
    source = new EventSource(logsApi.streamUrl(level.value, keyword.value, channel.value))
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

watch([channel, level, keyword, follow], () => { load(); connect() })
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
