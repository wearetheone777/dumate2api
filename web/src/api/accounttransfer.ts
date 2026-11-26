// web/src/api/accounttransfer.ts - 账号导入/导出（跨通道搬凭证）
//
// 与 /system/backup（搬配置）分工不同：这个搬的是账号凭证本身。
// 导出是敏感 GET，后端只对 admin 放行；前端把它当文件下载，不放进任何缓存。
import client from '@/api/client'

export interface TransferChannelSummary {
  channel: string
  label: string
  total: number
  enabled: number
  /** 有区域概念的通道才有：cn/intl 各几个 */
  byRegion?: Record<string, number>
}

export interface TransferSummary {
  ok: boolean
  channels: TransferChannelSummary[]
  fields: Record<string, string[]>
  note: string
}

export interface TransferChannelField {
  channel: string
  label: string
  fields: string[]
  required: string[]
}

export interface TransferFields {
  ok: boolean
  channels: TransferChannelField[]
  excluded: string[]
  excludedNote: string
}

export interface TransferChannelResult {
  channel: string
  label: string
  mode: 'skip' | 'overwrite'
  received: number
  created: number
  updated: number
  skipped: number
  failed: number
  /** 凭证已过期（refreshExpiresAt 已过）的条数——迁移本身没错，是号老了 */
  refreshExpired: number
  errors: string[]
}

export interface TransferImportResult {
  ok: boolean
  mode: 'skip' | 'overwrite'
  channels: TransferChannelResult[]
  totals: {
    received: number
    created: number
    updated: number
    skipped: number
    failed: number
  }
  note?: string
  error?: string
}

export const accountTransferApi = {
  summary: () => client.get<TransferSummary>('/account-transfer/summary'),
  fields: () => client.get<TransferFields>('/account-transfer/fields'),

  /** 导出为文件下载（blob）。返回解析后的信封，供界面显示条数 */
  exportFile: async (params: { channel?: string; region?: string } = {}) => {
    const q: Record<string, string> = {}
    if (params.channel) q.channel = params.channel
    if (params.region) q.region = params.region
    const res = await client.get('/account-transfer/export', {
      params: q,
      responseType: 'blob',
      timeout: 60000,
    })
    const text = await (res.data as Blob).text()
    const parsed = JSON.parse(text)
    const url = URL.createObjectURL(res.data as Blob)
    const a = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 10)
    a.href = url
    a.download = `dumate2api-accounts-${params.channel || 'all'}-${stamp}.json`
    a.click()
    URL.revokeObjectURL(url)
    return parsed
  },

  import: (payload: unknown, opts: { mode?: 'skip' | 'overwrite'; channel?: string; region?: string } = {}) => {
    const q: Record<string, string> = {}
    if (opts.mode) q.mode = opts.mode
    if (opts.channel) q.channel = opts.channel
    if (opts.region) q.region = opts.region
    return client.post<TransferImportResult>('/account-transfer/import', payload, { params: q, timeout: 60000 })
  },
}
