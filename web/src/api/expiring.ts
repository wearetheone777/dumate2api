// web/src/api/expiring.ts - 临期快照只读出仓（批次二十一，账号卡角标数据源）
//
// 后端 src/admin/routes/expiring.js 是**只读**的：快照由各通道 /credits 写方
// 维护，这里只消费。qoder 不在快照里（它的临期在 grants 账本，/qoder/credits
// 的 expiringAmount 已按账号透出），账号卡直接用 credits 行。
import client from '@/api/client'

/** 单账号临期明细：快照只记时刻不记金额（写入方刻意如此），金额去积分明细页 */
export interface ExpiringEntry {
  id: string
  nearest: number
  daysLeft: number
}

export interface ExpiringChannelView {
  at: number | null
  fresh: boolean
  windowDays: number
  accounts: ExpiringEntry[]
}

export interface ExpiringView {
  channels: Record<string, ExpiringChannelView>
  generatedAt: number
}

export const expiringApi = {
  view: () => client.get<ExpiringView>('/expiring'),
}
