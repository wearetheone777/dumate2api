// web/src/api/workbuddy.ts - WorkBuddy 通道的接口类型
import client from '@/api/client'

export interface WorkBuddyAccount {
  id: number
  uid: string
  /** 区域（cn=国内 copilot.tencent.com / global=国际 workbuddy.ai），不通用 */
  region: 'cn' | 'global'
  nickname: string
  email: string
  enterpriseName: string
  domain: string
  enabled: boolean
  createdAt: number | null
  expiresAt: number | null
  refreshExpiresAt: number | null
  /** 凭证来源：client-import（客户端导入）/ manual（手动粘贴） */
  source: string
  lastError: string
  lastErrorAt: number | null
  hasRefresh: boolean
  hasAccess: boolean
  refreshTail: string
  /** 上次签到时刻（本地记录；上游不提供）。国际版恒 null */
  lastCheckin: number | null
}

export interface WorkBuddyStatus {
  ready: boolean
  error: string
  accounts: number
  region?: 'cn' | 'global'
  mode: 'multi'
  modeNote: string
  rows: WorkBuddyAccount[]
}

export interface WorkBuddyCreditRow {
  id: number
  nickname: string
  uid: string
  region: 'cn' | 'global'
  checkedIn: boolean | null
  unsupportedCheckin: boolean
  dailyCredit: number | null
  streakDays: number | null
  /** 额度包剩余合计（billing 套餐包） */
  total: number | null
  packages: Array<{ name: string; remain: number; size: number }>
  lastCheckin: number | null
  error: string
}

export interface WorkBuddyDashAccount {
  id: number
  name: string
  uid: string
  region: 'cn' | 'global'
  enabled: boolean
  daysAlive: number | null
  expiresAt: number | null
  refreshExpiresAt: number | null
  refreshExpired: boolean
  lastError: string
  refreshTail: string
}

export interface WorkBuddyModel {
  id: string
  name: string
  /** 上下文上限（maxInputTokens，不是 defaultLength 那个默认档） */
  contextWindow: number
  contextWindowDefault: number | null
  maxTokens: number
  multimodal: boolean
  credits: string | null
  /** 解析后的倍率（"x0.34 credits" → 0.34）；0 = 免费 */
  rate: number | null
  free: boolean
  badges: string[]
  reasoning: { efforts: string[]; defaultEffort: string | null; canDisableThinking: boolean | null } | null
}

export const workbuddyApi = {
  status: (region?: 'cn' | 'intl') =>
    client.get<WorkBuddyStatus>(`/workbuddy/status${region ? `?region=${region}` : ''}`),
  dashboard: (region?: 'cn' | 'intl') =>
    client.get<{
      accounts: WorkBuddyDashAccount[]
      region?: string
      summary: { total: number; enabled: number; refreshExpired: number; errored: number }
    }>(`/workbuddy/dashboard${region ? `?region=${region}` : ''}`),
  models: (opts: { refresh?: boolean; region?: 'cn' | 'intl' } = {}) => {
    const q: string[] = []
    if (opts.refresh) q.push('refresh=1')
    if (opts.region) q.push(`region=${opts.region}`)
    const qs = q.length ? '?' + q.join('&') : ''
    return client.get<{
      models: WorkBuddyModel[]
      total: number
      region?: string
      error: string
      fetchedAt: number
      rateNote: string
    }>(`/workbuddy/models${qs}`)
  },
  credits: (region?: 'cn' | 'intl') =>
    client.get<{
      count: number
      region?: string
      rows: WorkBuddyCreditRow[]
      summary: {
        total: number
        valid: number
        checkedIn: number
        unknown: number
        remainTotal: number
      }
    }>(`/workbuddy/credits${region ? `?region=${region}` : ''}`),
  checkin: (id?: number) => client.post('/workbuddy/checkin', id ? { id } : {}),
  importClient: (region: 'cn' | 'intl') =>
    client.post<{ ok: boolean; account?: WorkBuddyAccount; error?: string; path?: string }>(
      '/workbuddy/import-client',
      { region },
    ),
  importToken: (payload: {
    region: 'cn' | 'intl'
    accessToken: string
    refreshToken: string
    uid?: string
    nickname?: string
    domain?: string
  }) =>
    client.post<{ ok: boolean; account?: WorkBuddyAccount; error?: string }>(
      '/workbuddy/import-token',
      payload,
    ),
  removeAccount: (id: number) => client.delete(`/workbuddy/accounts/${id}`),
  patchAccount: (id: number, fields: { enabled?: boolean; nickname?: string }) =>
    client.patch<{ ok: boolean; account?: WorkBuddyAccount }>(`/workbuddy/accounts/${id}`, fields),
}
