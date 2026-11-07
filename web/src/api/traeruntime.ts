import client from './client'

/** TRAE 运行期配置（data/traework-runtime.json，跨进程热读） */
export interface TraeRuntimeConfig {
  degrade: {
    enabled: boolean
    fallbackModel: string
    fallbackRegion: '' | 'cn' | 'intl'
    warnBelow: number | null
    onQuota: boolean
    onUpgrade: boolean
  }
  maxMode: { enabled: boolean; models: string[] }
  pickStrategy: 'round-robin' | 'credits-desc'
  accountGuard: {
    enabled: boolean
    reserveCredits: number | null
    reserveBelow: number | null
    /** 每账号每日 token 上限（null/0 = 不限） */
    dailyTokens: number | null
    /** 每账号每日积分上限（null/0 = 不限） */
    dailyCredits: number | null
    /** 按 (账号, 模型) 的每日 token 上限（null/0 = 不限） */
    modelTokens: number | null
  }
  gatewayPaused: boolean
}

export interface TraeRuntimeResponse {
  file: string
  fields: string[]
  config: TraeRuntimeConfig
  accounts: {
    total: number
    enabled: number
    needRelogin: number
    exhausted: number
    pausedModel: number
    disabled: number
    cooling: number
    creditsUnknown: number
  }
  note: string
}

export const traeRuntimeApi = {
  get: () => client.get<TraeRuntimeResponse>('/trae-runtime'),
  save: (patch: Partial<TraeRuntimeConfig>) => client.put('/trae-runtime', patch),
  maxModels: (region?: 'cn' | 'intl') =>
    client.get<{
      region: string
      ok: boolean
      error: string
      total: number
      models: { id: string; name: string; contextWindow: number | null }[]
      note: string
    }>(`/trae-runtime/max-mode/models${region ? `?region=${region}` : ''}`),
  applyMaxModels: (region?: 'cn' | 'intl') =>
    client.post(`/trae-runtime/max-mode/apply${region ? `?region=${region}` : ''}`, {}),
  usage: () =>
    client.get<{
      ok: boolean
      error: string
      day: string
      config: TraeRuntimeConfig['accountGuard']
      rows: Array<{
        id: number
        name: string
        region: string
        tokens: number | null
        requests: number
        credits: number | null
      }>
      totals: { tokens: number | null; credits: number | null }
      note: string
    }>('/trae-runtime/usage'),
}

/** 服务端运行日志（进程内环形缓冲，强制脱敏） */
export interface ServerLogRow {
  ts: number
  level: 'log' | 'warn' | 'error'
  text: string
  seq: number
}

export const logsApi = {
  list: (params: { level?: string; keyword?: string; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.level) q.set('level', params.level)
    if (params.keyword) q.set('keyword', params.keyword)
    if (params.limit) q.set('limit', String(params.limit))
    return client.get<{ rows: ServerLogRow[]; total: number; capacity: number }>(`/logs?${q}`)
  },
  streamUrl: (level = '', keyword = '') => {
    const q = new URLSearchParams()
    if (level) q.set('level', level)
    if (keyword) q.set('keyword', keyword)
    return `/api/admin/logs/stream?${q}`   // EventSource 不走 axios 基址
  },
}

/** 月度账单（月 × 通道 × Key，只统计经本网关的请求） */
export interface MonthlyBillingRow {
  month: string
  channel: string
  key_id: string
  requests: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  failed: number
}

export const monthlyBillingApi = {
  list: (month = '', channel = '') =>
    client.get<{
      rows: MonthlyBillingRow[]
      months: string[]
      month: string
      channel: string
      totals: { requests: number; input_tokens: number; output_tokens: number; total_tokens: number; failed: number }
      note: string
    }>(`/monthly-billing?month=${encodeURIComponent(month)}&channel=${encodeURIComponent(channel)}`),
  exportUrl: (month = '', channel = '') =>
    `/monthly-billing/export?month=${encodeURIComponent(month)}&channel=${encodeURIComponent(channel)}`,
}
