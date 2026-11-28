<template>
  <!-- fresh === false（快照陈旧）时不显示——过期数据比没有数据更害人，
       标着红角标让人以为是刚查到的，等于在编数据。悬浮提示说明口径。 -->
  <a-tooltip v-if="entry && fresh" :title="hint">
    <span class="inline-flex items-center gap-1 align-middle">
      <a-tag :color="urgent ? 'red' : 'orange'" class="!mr-0">{{ timeText }} 到期 · 剩 {{ entry.daysLeft }} 天</a-tag>
      <a-tag v-if="preferred" color="purple" class="!mr-0">建议优先使用</a-tag>
    </span>
  </a-tooltip>
  <span v-else class="text-slate-400">—</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ExpiringEntry } from '@/api/expiring'

const props = defineProps<{
  entry: ExpiringEntry | null
  /** 快照新鲜度（频道级）。false = 陈旧，一律不显示 */
  fresh: boolean
  /** 频道内最早到期的账号（view.accounts[0]）才挂「建议优先使用」 */
  preferred?: boolean
  /** 窗口天数（来自快照 view.windowDays，各通道不同：搭子/千问 30、TRAE/WorkBuddy 7） */
  windowDays?: number
}>()

const urgent = computed(() => !!props.entry && props.entry.daysLeft <= 3)
const timeText = computed(() => {
  if (!props.entry) return ''
  const d = new Date(props.entry.nearest)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
})
const hint = computed(() => {
  const win = props.windowDays ? `${props.windowDays} 天窗口` : 'FEFO 窗口'
  return `${win}内会作废的额度包；金额不在此快照里，明细见积分明细页。网关选号（FEFO）本来就会优先用这些账号。`
})
</script>
