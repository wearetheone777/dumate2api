// web/src/api/checkin.ts - 签到详情（按月 / 按年）
//
// 数据来自 /api/admin/checkin/detail：本地签到账本 + 各通道可得的历史
// （搭子上游当月、操作流水；Qoder 积分领取账本）。千问办公没有签到体系，
// 接口对它返回 400，页面也不渲染这张卡片。
export interface CheckinDayInfo {
  /** upstream（上游 sign_in_days）/ claim（本次签到领取）/ already（已签）/
   *  grant（Qoder 积分领取）/ record（搭子操作流水）/ account（账号 lastCheckin） */
  source: string
  /** 这次签到带来的积分（拿不到就是 null，不补 0） */
  credits: number | null
  at: number | null
}

export interface CheckinAccount {
  id: number
  name: string
  lastCheckin: number | null
  days: Record<string, CheckinDayInfo>
  daysInMonth: number
  checkedToday: boolean
  /** WorkBuddy 国际版没有签到接口（上游不提供）——账号照列，标出来别让人误判 */
  unsupportedCheckin?: boolean
  /** 仅 WorkBuddy 有：区域（cn/global），用来解释「为什么这号不支持签到」 */
  region?: 'cn' | 'global'
}

export interface CheckinMonthSummary {
  month: number
  /** 这个月有几天「至少一个账号签过」 */
  days: number
  /** 账号·天合计（多账号时与 days 不同） */
  accountDays: number
  hasData: boolean
}

export interface CheckinDetailData {
  channel: string
  year: number
  month: number
  today: string
  accounts: CheckinAccount[]
  months: CheckinMonthSummary[]
  coverage: { since: string | null; ledgerSince: string | null }
  upstream: { ok: number; failed: number; errors: { id: number; error: string }[] } | null
  note: string
}
