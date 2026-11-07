// web/src/api/channelbalance.ts - 跨通道额度总览（P2-10）
import client from './client'

export interface ChannelBalanceRow {
  id: string
  label: string
  /** 该通道是否至少有一个账号查询成功 */
  ok: boolean
  /** 通道口径的剩余合计；null = 取不到（不是 0） */
  remaining: number | null
  unit: string
  /** 存在不限量的团队共享额度（Qoder cap=-1） */
  unlimited: boolean
  accounts: { total: number; ok: number; fail: number }
  failed: Array<{ name: string; error: string }>
  /** 口径说明（前端在无错误时显示） */
  note: string
  error: string | null
  /** 窗口内临期的账号数 + 最早到期时刻 */
  expiring: { accounts: number; nearest: number | null } | null
}

export interface ChannelBalanceData {
  ok: boolean
  at: number
  cached: boolean
  channels: ChannelBalanceRow[]
  ttlMs: number
  error?: string
}

export const channelBalanceApi = {
  snapshot(force = false) {
    return client.get<ChannelBalanceData>(`/channel-balance${force ? '?force=1' : ''}`)
  },
}
