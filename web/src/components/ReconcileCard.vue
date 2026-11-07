<template>
  <a-card :bordered="false" title="计费对账（每模型实扣）" class="mt-4">
    <template #extra>
      <a-space>
        <a-select v-model:value="days" size="small" style="width: 110px" :options="dayOptions" @change="load" />
        <a-button size="small" :loading="loading" @click="load">刷新</a-button>
      </a-space>
    </template>
    <div class="text-xs text-slate-500 mb-3">
      目的：把<b>倍率漂移</b>（上游改路由 / 倍率元数据过期）从「要跑探针才知道」变成打开页面就看见分布。
      只聚合有逐请求归因账本的通道；千问与搭子的账本是余额快照，单次成本核对走各自的「计费自检」探针。
    </div>

    <a-alert v-if="error" type="warning" show-icon class="mb-3" :message="error" />

    <a-tabs v-model:active-key="tab" size="small">
      <a-tab-pane v-for="ch in data?.channels || []" :key="ch.channel" :tab="`${ch.channel}（${ch.rows.length} 模型）`">
        <div class="text-xs text-slate-400 mb-2">{{ ch.note }}</div>
        <a-table
          size="small"
          :data-source="ch.rows"
          :columns="columnsFor(ch)"
          row-key="model"
          :pagination="ch.rows.length > 10 ? { pageSize: 10, showSizeChanger: false } : false"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'credits'">
              <span class="num">{{ fmtNum(record.credits_total ?? record.cost_total) }}</span>
            </template>
            <template v-else-if="column.key === 'rate'">
              <span v-if="record.rate_median != null" class="num">
                {{ record.rate_median }}
                <span class="text-xs text-slate-400">（{{ record.rate_min }} ~ {{ record.rate_max }}，{{ record.rate_samples }} 样本）</span>
              </span>
              <span v-else class="text-slate-300 text-xs">—</span>
            </template>
            <template v-else-if="column.key === 'exact'">
              <span class="text-xs">
                <a-tag v-if="record.exact" color="purple">精确 {{ record.exact }}</a-tag>
                <a-tag v-if="record.inexact" color="orange">推断 {{ record.inexact }}</a-tag>
                <a-tag v-if="record.discounted" color="cyan">错峰 {{ record.discounted }}</a-tag>
              </span>
            </template>
          </template>
        </a-table>
      </a-tab-pane>
    </a-tabs>
  </a-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import client from '@/api/client'

// 对账判据全在后端（GET /billing/reconcile，纯账本聚合零上游调用）；
// 前端只做天数切换与表格展示。qoder 行的 billed_rate 分布是核心信号——
// 同一模型倍率散得太开（如 min 0.1 / max 3.7）就值得去跑一次计费自检探针。
interface ReconcileRow {
  model: string
  requests: number
  credits_total?: number
  cost_total?: number
  rate_min?: number | null
  rate_median?: number | null
  rate_max?: number | null
  rate_samples?: number
  discounted?: number
  exact?: number
  inexact?: number
}
interface ReconcileChannel {
  channel: string
  kind: string
  note: string
  rows: ReconcileRow[]
}
interface ReconcileData {
  ok: boolean
  days: number
  channels: ReconcileChannel[]
  excluded: Array<{ channel: string; reason: string }>
  errors: Record<string, string>
}

const data = ref<ReconcileData | null>(null)
const loading = ref(false)
const error = ref('')
const tab = ref('qoder')
const days = ref(7)
const dayOptions = [
  { label: '最近 1 天', value: 1 },
  { label: '最近 7 天', value: 7 },
  { label: '最近 30 天', value: 30 },
  { label: '全部', value: 0 },
]

const baseColumns = [
  { title: '模型', dataIndex: 'model' },
  { title: '请求数', dataIndex: 'requests', width: 90 },
  { title: '实扣合计', key: 'credits', width: 120 },
]
const rateColumns = { title: '实测倍率（credits/千tok）', key: 'rate', width: 260 }
const exactColumn = { title: '口径', key: 'exact', width: 210 }

function columnsFor(ch: ReconcileChannel) {
  return ch.channel === 'qoder'
    ? [...baseColumns, rateColumns, exactColumn]
    : [...baseColumns, exactColumn]
}

const fmtNum = (n: number | null | undefined) =>
  n == null ? '—' : n >= 1000 ? n.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) : String(n)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await client.get(`/billing/reconcile?days=${days.value}`).then((res) => res.data)
    data.value = r
    const channels = (r as ReconcileData).channels || []
    if (!channels.some((c) => c.channel === tab.value)) tab.value = channels[0]?.channel || 'qoder'
  } catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>
