<template>
  <!-- 签到详情：按月 / 按年查看。三条有签到体系的通道共用（千问办公没有，
       由父组件 v-if 挡掉）。
       数据源不是一个接口能直接给的：搭子上游只给当月、TRAE 完全没有历史、
       Qoder 只有积分领取批次。后端把它们合并成同一种形状，这里只负责渲染，
       并把「本地从哪天开始有记录」如实标出来——否则「账本里没有」会被
       读成「那天没签到」。 -->
  <a-card title="签到详情" :bordered="false" class="mt-4">
    <template #extra>
      <a-space>
        <a-select
          v-model:value="year"
          size="small"
          style="width: 104px"
          :options="yearOptions"
          @change="load"
        />
        <a-select
          v-model:value="month"
          size="small"
          style="width: 92px"
          :options="monthOptions"
          @change="load"
        />
        <a-button size="small" class="ghost-btn" :loading="loading" @click="load">刷新</a-button>
      </a-space>
    </template>

    <a-alert v-if="error" type="error" show-icon :message="error" class="mb-2" />
    <a-spin v-else :spinning="loading">
      <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
        <span>{{ data?.year ?? year }} 年 {{ data?.month ?? month }} 月</span>
        <span>本月签到 <b class="num text-slate-200">{{ monthAccountDays }}</b> 账号·天</span>
        <span v-if="data?.coverage?.since">本地记录自 {{ data.coverage.since }} 起</span>
        <span v-if="upstreamWarn" class="text-amber-500">{{ upstreamWarn }}</span>
      </div>

      <a-empty v-if="!accounts.length" description="还没有账号" />
      <div v-for="a in accounts" :key="a.id" class="mb-4">
        <div class="mb-1.5 flex items-center justify-between">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{{ a.name }}</span>
            <!-- WorkBuddy 国际版没有签到接口：账号要出现（用户想看「这个号」），
                 但不能让人以为「它一直没签」——标签说清是上游不支持 -->
            <a-tag v-if="a.unsupportedCheckin" color="default">不支持签到</a-tag>
            <a-tag v-else-if="isCurrentMonth" :color="a.checkedToday ? 'green' : 'orange'">
              {{ a.checkedToday ? '今日已签' : '今日未签' }}
            </a-tag>
            <span class="text-xs text-slate-500">本月 {{ a.daysInMonth }} 天</span>
          </div>
          <span v-if="a.lastCheckin" class="text-xs text-slate-500">上次 {{ dateTime(a.lastCheckin) }}</span>
        </div>
        <div class="ck-grid">
          <span
            v-for="d in cells(a)"
            :key="d.day"
            class="ck-cell"
            :class="{ on: d.on, today: d.today, future: d.future }"
            :title="d.title"
          >{{ d.label }}</span>
        </div>
      </div>

      <div class="mt-5">
        <div class="mb-2 text-xs text-slate-400">{{ data?.year ?? year }} 年各月签到（点击切换月份）</div>
        <div class="ck-year">
          <button
            v-for="m in months"
            :key="m.month"
            type="button"
            class="ck-month"
            :class="{ active: m.month === month, empty: !m.hasData }"
            @click="pickMonth(m.month)"
          >
            <span class="text-xs text-slate-400">{{ m.month }} 月</span>
            <span class="num text-sm">{{ m.days }} 天</span>
            <span v-if="multiAccount" class="text-[10px] text-slate-500">{{ m.accountDays }} 账号·天</span>
          </button>
        </div>
      </div>

      <div v-if="data?.note" class="mt-3 text-xs text-slate-500">{{ data.note }}</div>
    </a-spin>
  </a-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import client from '@/api/client'
import { channelStore, isQwenwork } from '@/stores/channel'
import type { CheckinAccount, CheckinDetailData } from '@/api/checkin'

const now = new Date()
const year = ref(now.getFullYear())
const month = ref(now.getMonth() + 1)
const data = ref<CheckinDetailData | null>(null)
const loading = ref(false)
const error = ref('')

// 千问办公没有签到体系；组件本来就被 v-if 挡掉，这里再兜一层，
// 避免将来有人复用时打出无意义的请求。
const channel = computed(() => (channelStore.current === 'qwenwork' ? 'dumate' : channelStore.current))
const accounts = computed(() => data.value?.accounts ?? [])
const months = computed(() => data.value?.months ?? [])
const multiAccount = computed(() => accounts.value.length > 1)
const isCurrentMonth = computed(() => year.value === now.getFullYear() && month.value === now.getMonth() + 1)

const monthAccountDays = computed(() => {
  const m = months.value.find((x) => x.month === month.value)
  return m ? m.accountDays : 0
})

// 年份选项：最近三年 + 账本覆盖到的更早年份。固定往前留两年，
// 免得选中一个「账本里还没有数据」的年份后选项突然消失。
const yearOptions = computed(() => {
  const cur = now.getFullYear()
  const since = data.value?.coverage?.since
  const from = Math.min(cur - 2, since ? Number(since.slice(0, 4)) : cur - 2)
  const out: { label: string; value: number }[] = []
  for (let y = cur; y >= from; y--) out.push({ label: `${y} 年`, value: y })
  return out
})

const monthOptions = Array.from({ length: 12 }, (_, i) => ({ label: `${i + 1} 月`, value: i + 1 }))

const upstreamWarn = computed(() => {
  const u = data.value?.upstream
  if (!u || !u.failed) return ''
  return `上游查询失败 ${u.failed} 个账号（当月已签日可能不全）`
})

function sourceText(s: string): string {
  if (s === 'upstream') return '上游'
  if (s === 'claim') return '签到领取'
  if (s === 'grant') return '积分领取'
  if (s === 'record') return '操作流水'
  if (s === 'account') return '账号记录'
  return '本地账本'
}

function cells(a: CheckinAccount) {
  const total = new Date(year.value, month.value, 0).getDate()
  const prefix = `${year.value}-${String(month.value).padStart(2, '0')}-`
  const today = data.value?.today || ''
  const out = []
  for (let d = 1; d <= total; d++) {
    const day = prefix + String(d).padStart(2, '0')
    const info = a.days?.[day]
    out.push({
      day,
      label: String(d),
      on: !!info,
      today: day === today,
      future: day > today,
      title: info
        ? `${day} 已签到${info.credits != null ? ` · +${info.credits}` : ''}（${sourceText(info.source)}）`
        : `${day} 未签到`,
    })
  }
  return out
}

function dateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function pickMonth(m: number) {
  month.value = m
  load()
}

async function load() {
  if (isQwenwork()) return
  loading.value = true
  error.value = ''
  try {
    const { data: d } = await client.get<CheckinDetailData>('/checkin/detail', {
      params: { channel: channel.value, year: year.value, month: month.value },
    })
    data.value = d
  } catch (e: any) {
    // 拉取失败与「这个月没签到」必须分开：后者是正常空态，
    // 折成空态等于把一次故障断言成「确实没签过」。
    error.value = e?.response?.data?.error || e?.message || '签到详情加载失败'
    data.value = null
  } finally {
    loading.value = false
  }
}

watch(() => channelStore.current, () => { load() })
onMounted(load)
</script>

<style scoped>
.ck-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.ck-cell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 24px;
  border-radius: 4px;
  border: 1px solid var(--lab-border);
  background: var(--lab-surface-2);
  color: var(--lab-text-mute);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.ck-cell.on {
  border-color: var(--lab-ok);
  background: var(--lab-ok-dim);
  color: var(--lab-ok);
}
.ck-cell.today {
  outline: 2px solid var(--lab-primary-line);
  outline-offset: -1px;
}
.ck-cell.future {
  opacity: 0.35;
}
.ck-year {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 6px;
}
.ck-month {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 4px;
  border-radius: 6px;
  border: 1px solid var(--lab-border);
  background: var(--lab-surface-2);
  color: var(--lab-text);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.ck-month:hover {
  border-color: var(--lab-primary-line);
  background: var(--lab-surface-hover);
}
.ck-month.active {
  border-color: var(--lab-primary);
  background: var(--lab-primary-dim);
}
.ck-month.empty {
  opacity: 0.55;
}
@media (max-width: 900px) {
  .ck-year {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>
