// web/src/utils/expiringBadge.ts - 临期角标的共享装载逻辑（批次二十一）
//
// 数据源是 GET /api/admin/expiring（expiring-snapshot 的只读出仓，写方在
// 各通道 /credits）。四个快照通道（dumate/qwenwork/traework/workbuddy）的
// 账号卡视图共用：entryOf / preferredOf / reorder。qoder 不在快照里——
// 它的角标从 /qoder/credits 行的 expiring* 字段出（grants 账本）。
//
// 纪律：快照陈旧（fresh=false）时一律当没有数据——过期数据比没有数据更害人，
// 标着红角标让人以为是刚查到的，等于在编数据。
import { ref } from 'vue'
import { expiringApi } from '@/api/expiring'
import type { ExpiringEntry } from '@/api/expiring'

export function useExpiring(channel: string) {
  const expMap = ref<Map<string, ExpiringEntry>>(new Map())
  const expFresh = ref(false)
  const expWindow = ref(0)
  const expPreferredId = ref('')

  async function loadExpiring() {
    try {
      const { data } = await expiringApi.view()
      const v = data.channels[channel]
      const m = new Map<string, ExpiringEntry>()
      expPreferredId.value = ''
      if (v && v.fresh) {
        for (const e of v.accounts) m.set(e.id, e)
        // view 已按 nearest 升序：首个 = 全频道最早到期的那张卡挂「建议优先使用」
        expPreferredId.value = v.accounts.length ? v.accounts[0].id : ''
        expWindow.value = v.windowDays
      }
      expMap.value = m
      expFresh.value = !!(v && v.fresh)
    } catch {
      expMap.value = new Map()
      expFresh.value = false
    }
  }

  const entryOf = (id: number | string): ExpiringEntry | null =>
    expMap.value.get(String(id)) || null

  const preferredOf = (id: number | string): boolean =>
    expPreferredId.value !== '' && expPreferredId.value === String(id)

  /** 按紧迫度排序：有临期条目的账号浮到前面（内部按最早到期升序），
   *  其余账号保持原有相对顺序——不打乱既有的排列约定，只让「要作废的」先露脸。 */
  function reorder<T>(list: T[], idOf: (x: T) => number | string): T[] {
    if (!expFresh.value || !expMap.value.size) return list
    const withIdx = list.map((x, i) => ({ x, i, e: expMap.value.get(String(idOf(x))) || null }))
    const head = withIdx.filter((r) => r.e).sort((a, b) => (a.e as ExpiringEntry).nearest - (b.e as ExpiringEntry).nearest)
    if (!head.length) return list
    const rest = withIdx.filter((r) => !r.e).sort((a, b) => a.i - b.i)
    return [...head, ...rest].map((r) => r.x)
  }

  return { expMap, expFresh, expWindow, expPreferredId, loadExpiring, entryOf, preferredOf, reorder }
}
