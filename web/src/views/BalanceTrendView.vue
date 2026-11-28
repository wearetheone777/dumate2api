<template>
  <div class="page">
    <PageHeader title="余额趋势" sub="账号余额流水 · 30 分钟独立采样 · 变动即留痕">
      <template #actions>
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
      </template>
    </PageHeader>

    <a-alert type="info" show-icon class="mb-3">
      <template #message>怎么看这张图</template>
      <template #description>
        数据来自签到 / 保活 / 手动刷新时真实查到的余额（变动即留痕，无变动不记）。
        折线按 30 分钟网格独立采样（事件驱动的原始流水会断线）：<b>实线 = 该桶内有新观测</b>；
        <b>虚线 = 估计</b>（桶内没有新观测，沿用上次观测值——期间若有消耗，真实余额只会更低，
        估计值是真实余额的<b>上界</b>）。所以下面的「窗口消耗」是<b>下界</b>：未观测时段的消耗不计入，
        实际消耗 ≥ 显示值。
      </template>
    </a-alert>

    <a-card :bordered="false" class="mb-3">
      <div class="flex flex-wrap items-center gap-2">
        <a-select v-model:value="windowHours" size="small" style="width: 130px" :options="windowOptions" />
        <a-select v-model:value="selected" size="small" mode="multiple" allow-clear
          placeholder="全部账号" :max-tag-count="3" style="min-width: 260px" :options="accountOptions" />
        <span class="text-xs text-slate-400">{{ rangeHint }}</span>
      </div>
    </a-card>

    <a-card :bordered="false" class="mb-3">
      <template #title>余额曲线</template>
      <a-empty v-if="!hasData" description="窗口内没有余额观测——余额只在签到 / 保活 / 手动刷新查到变动时留痕" />
      <div v-show="hasData" ref="chartEl" style="height: 420px" />
    </a-card>

    <a-row :gutter="12" class="mb-3">
      <a-col :span="6">
        <a-card :bordered="false" size="small">
          <a-statistic title="窗口消耗（下界）" :value="rateStat.consumed" :precision="2" />
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false" size="small">
          <a-statistic title="窗口获取" :value="rateStat.gained" :precision="2" />
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false" size="small">
          <a-statistic title="净变动" :value="rateStat.net" :precision="2" />
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false" size="small">
          <a-statistic title="每小时消耗（下界）" :value="rateStat.perHour" :precision="2" />
          <div class="text-xs text-slate-400 mt-1">按 {{ rateStat.samples }} 条带符号变动汇总，未观测时段不计入</div>
        </a-card>
      </a-col>
    </a-row>

    <a-card :bordered="false">
      <template #title>最近变动（所选账号，最新在前）</template>
      <a-table
        size="small"
        :columns="eventColumns"
        :data-source="recentRows"
        :pagination="false"
        row-key="rowKey"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'ts'">
            <span class="num">{{ fmtTime(record.ts) }}</span>
          </template>
          <template v-else-if="column.key === 'account'">
            <span :title="record.account">{{ labelOf(record.account) }}</span>
          </template>
          <template v-else-if="column.key === 'delta'">
            <a-tag v-if="record.delta === null" color="default">基线</a-tag>
            <a-tag v-else-if="record.delta > 0" color="green">+{{ exactNum(record.delta) }}</a-tag>
            <a-tag v-else-if="record.delta < 0" color="red">{{ exactNum(record.delta) }}</a-tag>
            <a-tag v-else color="default">0</a-tag>
          </template>
          <template v-else-if="column.key === 'balance'">
            <span class="num">{{ exactNum(record.balance) }}</span>
          </template>
          <template v-else-if="column.key === 'source'">
            <span class="text-xs text-slate-400">{{ record.source || '—' }}</span>
          </template>
        </template>
      </a-table>
    </a-card>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { App } from 'ant-design-vue'
import PageHeader from '@/components/PageHeader.vue'
import { balanceApi } from '@/api/points'
import type { BalanceEvent } from '@/api/points'
import client from '@/api/client'
import { SERIES, INK, TOOLTIP_BASE, axisStyle, compactNum, exactNum } from '@/utils/chartTheme'
import { useAutoRefresh } from '@/stores/ui'

// ECharts 按需引入：折线图需要的模块
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

const { message } = App.useApp()

// 30 分钟独立采样：事件驱动的原始流水只在变动时有点，直接画会断线；
// 按固定网格 carry-forward（每桶取「≤桶末的最后一条观测」）得到不间断的采样序列。
const STRIDE0 = 30 * 60 * 1000
// 折叠上限：采样点超过 20 万时倍增步长重建（ECharts 渲染 20 万+ 点会明显卡顿）
const FOLD_LIMIT = 200000
const STRIDE_CAP = STRIDE0 * 1024

const windowOptions = [
  { label: '近 24 小时', value: 24 },
  { label: '近 3 天', value: 72 },
  { label: '近 7 天', value: 168 },
  { label: '近 30 天', value: 720 },
]

const loading = ref(false)
const windowHours = ref(168)
const selected = ref<string[]>([])
const accountKeys = ref<string[]>([])
const strideMs = ref(STRIDE0)
const totalPoints = ref(0)
const windowRows = ref<BalanceEvent[]>([]) // 所选窗口内流水（最新在前）
// 每账号「窗口开始前的最新观测」（carry-in 基线）：让曲线从窗口起点就连续
const carryIn = ref<Map<string, BalanceEvent>>(new Map())
const webNames = ref<Map<string, string>>(new Map())
const hasData = computed(() => accountKeys.value.length > 0)
const rangeHint = computed(() => {
  const buckets = Math.ceil((windowHours.value * 3600000) / strideMs.value)
  return `${accountKeys.value.length} 个账号 · ${buckets} 桶/账号${strideMs.value > STRIDE0 ? ` · 步长已折叠到 ${Math.round(strideMs.value / 60000)} 分钟` : ''}`
})

const accountOptions = computed(() =>
  accountKeys.value.map((k) => ({ label: labelOf(k), value: k })))

const labelOf = (key: string) => webNames.value.get(key) || key

const fmtTime = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false })

// ---- 窗口消耗（口径同 balance-hist.rate()：带符号 delta 汇总，基线行跳过）----
// 只数「被观测到的变动」——未观测时段的消耗没被记账，所以这是下界
const rateStat = computed(() => {
  const allow = new Set(selectedSet.value)
  let consumed = 0
  let gained = 0
  let samples = 0
  for (const r of windowRows.value) {
    if (allow.size && !allow.has(r.account)) continue
    if (typeof r.delta !== 'number' || !Number.isFinite(r.delta)) continue
    samples++
    if (r.delta < 0) consumed += -r.delta
    else gained += r.delta
  }
  const r2 = (v: number) => Math.round(v * 100) / 100
  return {
    consumed: r2(consumed),
    gained: r2(gained),
    net: r2(gained - consumed),
    perHour: r2(consumed / Math.max(1, windowHours.value)),
    samples,
  }
})

const recentRows = computed(() => {
  const allow = new Set(selectedSet.value)
  return windowRows.value
    .filter((r) => !allow.size || allow.has(r.account))
    .slice(0, 20)
    .map((r, i) => ({ ...r, rowKey: `${r.account}-${r.ts}-${i}` }))
})

const eventColumns = [
  { title: '时间', key: 'ts', width: 170 },
  { title: '账号', key: 'account', width: 220, ellipsis: true },
  { title: '变动', key: 'delta', width: 110 },
  { title: '余额', key: 'balance', width: 120 },
  { title: '来源', key: 'source', width: 130 },
]

const selectedSet = computed(() => new Set(selected.value))

async function load() {
  loading.value = true
  try {
    const now = Date.now()
    const from = now - windowHours.value * 3600000
    // 窗口内流水 + 每账号 carry-in 基线并行拉。基线查询取窗口前最新 2000 行的
    // 前缀（reverse 扫描最新优先）——足以覆盖所有活跃账号的最近一次观测；
    // 更久未动的账号没有 carry-in，曲线从它在窗口内的第一条观测开始，如实。
    const [win, preRes] = await Promise.all([
      balanceApi.timeline({ from, limit: 0 }),
      balanceApi.timeline({ to: from, limit: 2000 }).catch(() => ({ data: { rows: [] as BalanceEvent[] } })),
    ])
    windowRows.value = win.data.rows || []
    const carryMap = new Map<string, BalanceEvent>()
    for (const r of preRes.data.rows || []) {
      if (!carryMap.has(r.account)) carryMap.set(r.account, r) // 最新在前：首个即最新
    }
    carryIn.value = carryMap
    // 账号键 = 窗口内有流水的 ∪ 有 carry-in 的
    const keys = new Set<string>()
    for (const r of windowRows.value) keys.add(r.account)
    for (const k of carryMap.keys()) keys.add(k)
    accountKeys.value = [...keys].sort()
    // 选中集默认清空 = 全部；账号集变化时把已不存在的键剔除
    const exist = new Set(accountKeys.value)
    selected.value = selected.value.filter((k) => exist.has(k))
    // 网页账号显示名（bare 数字键 → 昵称；channel:id 形式的池键原样展示）
    try {
      const { data } = await client.get('/web-accounts')
      const m = new Map<string, string>()
      for (const a of (data.accounts || []) as { id: number; name: string; nickname: string }[]) {
        m.set(String(a.id), a.nickname || a.name)
      }
      webNames.value = m
    } catch { /* 显示名解析失败不挡主视图，键原样显示 */ }
    await nextTick()
    renderChart()
  } catch (e: any) {
    message.error(e?.response?.data?.error || '读取余额流水失败')
  } finally {
    loading.value = false
  }
}

// ---- 采样与画图 ----

interface GridPoint { ts: number; v: number; since: number; est: boolean }

/** 按固定网格 carry-forward：每桶末取「≤桶末的最后一条观测」。
 *  evtsAsc 升序（含 carry-in 基线行）；桶内有过观测的点是「观测」，靠更早行续命的是「估计」。 */
function buildGrid(evtsAsc: BalanceEvent[], from: number, to: number, stride: number): (GridPoint | null)[] {
  const pts: (GridPoint | null)[] = []
  let i = 0
  let cur: BalanceEvent | null = null
  for (let t = Math.ceil(from / stride) * stride; t <= to; t += stride) {
    while (i < evtsAsc.length && evtsAsc[i].ts <= t) { cur = evtsAsc[i]; i++ }
    if (!cur) { pts.push(null); continue }
    pts.push({ ts: t, v: cur.balance, since: cur.ts, est: !(cur.ts > t - stride) })
  }
  return pts
}

const chartEl = ref<HTMLElement | null>(null)
let chartInst: echarts.ECharts | null = null

function renderChart() {
  if (!chartEl.value) return
  if (!chartInst) chartInst = echarts.init(chartEl.value)
  if (!hasData.value) { chartInst.clear(); return }

  const now = Date.now()
  const from = now - windowHours.value * 3600000

  // 折叠：总采样点超上限时倍增步长整体重建（所有账号共享同一网格）
  let stride = STRIDE0
  const allow = selectedSet.value
  const keys = accountKeys.value.filter((k) => !allow.size || allow.has(k))
  const evtsOf = new Map<string, BalanceEvent[]>()
  let total = 0
  const build = (ms: number) => {
    total = 0
    for (const k of keys) {
      const evts: BalanceEvent[] = []
      const base = carryIn.value.get(k)
      if (base) evts.push(base)
      for (const r of windowRows.value) if (r.account === k) evts.push(r)
      evts.sort((a, b) => a.ts - b.ts)
      evtsOf.set(k, evts)
    }
    const grids = new Map<string, (GridPoint | null)[]>()
    for (const k of keys) {
      const g = buildGrid(evtsOf.get(k) || [], from, now, ms)
      grids.set(k, g)
      total += g.length
    }
    return grids
  }
  let grids = build(stride)
  while (total > FOLD_LIMIT && stride < STRIDE_CAP) {
    stride *= 2
    grids = build(stride)
  }
  strideMs.value = stride
  totalPoints.value = total

  const series: any[] = []
  const legendNames: string[] = []
  keys.forEach((k, idx) => {
    const color = SERIES[idx % SERIES.length]
    const g = grids.get(k) || []
    const obs: ([number, number, number] | null)[] = g.map((p) => (p && !p.est ? [p.ts, p.v, p.since] : null))
    const est: ([number, number, number] | null)[] = g.map((p) => (p && p.est ? [p.ts, p.v, p.since] : null))
    const label = labelOf(k)
    legendNames.push(label)
    series.push({
      name: label,
      type: 'line',
      data: obs,
      showSymbol: false,
      connectNulls: false,
      lineStyle: { color, width: 2, cap: 'round', join: 'round' },
      itemStyle: { color },
    })
    // 估计段：同色虚线、不进图例（图例只留账号名，避免双倍图例噪音）
    series.push({
      name: `${label}·估`,
      type: 'line',
      data: est,
      showSymbol: false,
      connectNulls: false,
      lineStyle: { color, width: 1.5, type: 'dashed', opacity: 0.9 },
      itemStyle: { color },
      legendHoverLink: false,
    })
  })

  chartInst.setOption({
    grid: { left: 64, right: 16, top: 40, bottom: 28 },
    legend: { data: legendNames, type: 'scroll', top: 6, textStyle: { color: INK.muted } },
    tooltip: {
      ...TOOLTIP_BASE,
      trigger: 'axis',
      formatter: (params: any[]) => {
        if (!params || !params.length) return ''
        const p0 = params[0]
        const ts = Array.isArray(p0.value) ? p0.value[0] : p0.value
        const lines = [`<div style="color:${INK.muted};font-size:11px">${fmtTime(Number(ts))}</div>`]
        const rows = params
          .filter((p) => Array.isArray(p.value))
          .sort((a, b) => b.value[1] - a.value[1])
          .slice(0, 12)
        for (const p of rows) {
          const est = String(p.seriesName).endsWith('·估')
          const label = est ? String(p.seriesName).slice(0, -2) : String(p.seriesName)
          const since = Array.isArray(p.value) ? p.value[2] : null
          const suffix = est ? ` <span style="color:${INK.muted}">估计 · 沿用 ${fmtTime(Number(since))}</span>` : ''
          lines.push(`<div>${label} <b>${exactNum(Number(p.value[1]))}</b>${suffix}</div>`)
        }
        return lines.join('')
      },
    },
    xAxis: { type: 'time', ...axisStyle({ showGrid: false }) },
    yAxis: { type: 'value', ...axisStyle({ formatter: (v: number) => compactNum(v) }) },
    series,
  }, { notMerge: true })
}

function onResize() { chartInst?.resize() }
function onThemePaint() { renderChart() }

useAutoRefresh(load)
watch(windowHours, load)
// 账号筛选只重画（数据已缓存），不重新拉
watch(selected, () => { renderChart() })

onMounted(() => {
  window.addEventListener('resize', onResize)
  window.addEventListener('lab:theme', onThemePaint)
  load()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  window.removeEventListener('lab:theme', onThemePaint)
  chartInst?.dispose()
  chartInst = null
})
</script>
