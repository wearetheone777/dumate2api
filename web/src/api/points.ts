export interface PointsPackage {
  kind: 'subscription' | 'incremental'
  package_type: string
  source: string
  total: number
  used: number
  left: number
  granted_at: number | null
  expire_at: number | null
  status: string
}

export interface SourceRow {
  source: string
  count: number
  total: number
  used: number
  left: number
  first_at: number | null
  last_at: number | null
  active_days: number
  days_since_last: number | null
}

export interface DailyGrantRow {
  day: string
  granted: number
  used: number
  count: number
}

export interface PointsData {
  subscribed: boolean
  total: number
  used: number
  left: number
  has_remaining: boolean | null
  throttled: boolean
  throttle_reason: string
  packages: PointsPackage[]
  expiring: PointsPackage[]
  sources: SourceRow[]
  daily_grant: DailyGrantRow[]
  expired_unused: PointsPackage[]
  upstream_port: number
  // 账号身份。本地后端固定为 'local'，用来区分于网页账号的数字 id。
  account_id?: string
  account_name?: string
  // 数据来源：desktop=本地后端（桌面凭证），web=网页凭证。
  // 网页链路下这是**单账号**口径，多账号合计在 /web-accounts/dashboard 的 summary。
  via?: 'desktop' | 'web'
  fetched_at: number
  cached?: boolean
}

export interface Account {
  name: string
  user_id: string
  last_login: number
  age_days: number | null
  state: 'active' | 'standby' | 'no_credential' | 'unknown'
  has_credentials: boolean
  active: boolean
  points: { left: number; total: number; used: number } | null
  points_note: string
  // 网页端凭证（签到/抽奖/积分用）。null = 未在账号管理里添加。
  web: {
    id: number
    name: string
    enabled: boolean
    has_error: boolean
    last_error: string
    checkin_result: string
    points: number | null
  } | null
}

export interface AccountsData {
  accounts: Account[]
  total: number
  active: number
  standby: number
  no_credential: number
  unknown: number
}

// 多账号积分（网页凭证，各自独立）。
// 每个账号除余额外还带完整的派生视图，前端切换账号时不必再打上游。
export interface AccountPoints {
  id: number
  name: string
  nickname: string
  ok: boolean
  cached?: boolean
  left?: number
  total?: number
  used?: number
  subscribed?: boolean
  throttled?: boolean
  packages?: PointsPackage[]
  expiring?: PointsPackage[]
  expired_unused?: PointsPackage[]
  sources?: SourceRow[]
  daily_grant?: DailyGrantRow[]
  error?: string
  expired?: boolean
}

export interface AllPointsData {
  accounts: AccountPoints[]
  totals: {
    accounts: number
    ok_accounts: number
    left: number
    total: number
    used: number
  }
}
