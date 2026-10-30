// web/src/api/traework.ts - TRAE Work 通道的接口类型
import client from '@/api/client'

/** 通道状态（/system/status 的 channels.traework） */
export interface TraeworkChannelInfo {
  id: string
  label: string
  kind: 'http' | 'direct'
  ready: boolean
  loggedIn: boolean
  accounts: number
  account: string
  tokenExpiresAt: string | null
  refreshExpiresAt: string | null
  refreshExpired: boolean
  error: string
}

/** 一个 TRAE Work 账号（脱敏：refreshToken 只给尾部） */
export interface TraeworkAccount {
  id: number
  uid: string
  nickname: string
  email: string
  enabled: boolean
  expiresAt: number | null
  refreshExpiresAt: number | null
  credits: number | null
  lastCheckin: number | null
  lastError: string
  /** lastError 的写入时刻。无错误或旧数据为 null；界面据此判断故障是否已陈旧 */
  lastErrorAt: number | null
  deviceId: string
  refreshTail: string
  /** 9074 自愈：连续退避次数（成功签到即清零）；0 = 无退避史 */
  checkin9074Count?: number
  /** 9074 退避截止时刻。未过期且 > now 时账号处于「等重试」状态 */
  checkin9074Until?: number | null
  /** 设备派生代数。>0 说明发生过 9074 设备轮换（gen 0 = 原始派生） */
  deviceGeneration?: number
  /**
   * 脱敏手机号。可能为空——TRAE 无官方手机号接口（GetUserInfo 已 401），
   * 仅当昵称形如「用户13800138000」时才能取到。
   */
  phone: string
  /** 手机号来源。为空表示取不到 */
  phoneSource: string
}

export interface TraeworkStatus {
  ready: boolean
  error: string
  accounts: number
  /** multi = 凭证自持，可多账号增删；与千问的 single 不同 */
  mode: 'multi' | 'single'
  modeNote: string
  rows: TraeworkAccount[]
}

/** 一个额度包（含各自到期时间）。签到奖励是一批批到期的 */
export interface TraeworkPack {
  name: string
  /** 该包面额。取不到为 null——补 0 会被读成「这个包是空的」 */
  limit: number | null
  /** 该包**已消耗**（上游字段叫 credits_amount，不是剩余） */
  used: number | null
  /** 剩余 = limit − used。面额缺失时推不出来，为 null */
  remain: number | null
  expireAt: number | null
  status: number | null
}

export interface TraeworkCreditRow {
  id: number
  nickname: string
  uid: string
  credits: number | null
  checkedIn: boolean | null
  /** 额度接口的实时剩余值 = 总额 − 已消耗。取不到为 null（不补 0） */
  remain: number | null
  limit: number | null
  /** 已消耗（usage_summary.consumed_amount），取不到为 null */
  consumed: number | null
  /** 签到可得的额度（不是余额），来自 status 接口 */
  checkinCredits: number | null
  /** 签到额外赠送，如连续签到奖励 */
  checkinExtra: number | null
  lastCheckin: number | null
  /** 额度包明细（含到期时间），按到期时间升序 */
  packs: TraeworkPack[]
  error: string
}

/** 即将过期的一个额度包（7 天内到期且还有剩余） */
export interface TraeworkExpiring {
  account: string
  accountId: number
  name: string
  remain: number
  limit: number | null
  expireAt: number
  daysLeft: number
}

/** /traework/credits 的汇总（顶部指标卡用） */
export interface TraeworkCreditsSummary {
  total: number
  valid: number
  checkedIn: number
  /** 额度取不到的账号数——既不算有效，也不该被当成 0 额度 */
  unknown: number
  remainTotal: number
  limitTotal: number
}

/** 一个 TRAE Work 模型（上游下发，含消耗倍率） */
export interface TraeworkModel {
  id: string
  name: string
  prefixed: string
  /** 消耗倍率（相对值）。接口不给时为 null——显示 —，补 0 会被读成免费 */
  rate: number | null
  /** 折扣前倍率 */
  rateOriginal: number | null
  /** 会员折后倍率 */
  rateDiscounted: number | null
  /** 折扣力度（如 50 = 5 折） */
  memberDiscount: number | null
  /** 本账号是否命中会员折扣 */
  discountMatched: boolean
  contextWindow: number | null
  maxTokens: number | null
  promptMaxTokens: number | null
  capability: string
  multimodal: boolean
  isBeta: boolean
  isNew: boolean
  isDefault: boolean
  /** 客户端可见性：false 的多是内部模型（子代理 / 压缩用） */
  visible: boolean
  usage: string
}

/** 仪表盘用：一个 TRAE Work 账号的健康快照（本地数据，不打上游） */
export interface TraeworkDashAccount {
  id: number
  name: string
  uid: string
  phone: string
  phoneSource: string
  enabled: boolean
  credits: number | null
  /** 账号存活天数（从 createdAt 算到今天）。与搭子的「剩余天数」语义不同 */
  daysAlive: number | null
  expiresAt: number | null
  refreshExpiresAt: number | null
  refreshExpired: boolean
  lastCheckin: number | null
  checkedInToday: boolean
  lastError: string
  lastErrorAt: number | null
  refreshTail: string
}

/** 仪表盘用：本地能算出的今日消耗（不打上游，所以没有剩余额度） */
export interface TraeworkTodayUsage {
  cost: number
  requests: number
  concurrent: number
}

export interface TraeworkDashboard {
  accounts: TraeworkDashAccount[]
  summary: {
    total: number
    enabled: number
    checkedInToday: number
    refreshExpired: number
    errored: number
    creditsTotal: number
  }
  today: TraeworkTodayUsage
  note: string
}

/** 按天聚合的消耗。成本取相邻 consumed 的差值，不是累计值 */
export interface TraeworkDailyRow {
  day: string
  cost: number
  requests: number
  concurrent: number
}

/** 逐笔消耗明细。cost 为 null 表示该条没有参照点（每账号首条） */
export interface TraeworkCreditRecord {
  ts: number
  req_id: string
  account: string
  account_id: number
  model: string
  ms: number | null
  cost: number | null
  /** false = 与相邻请求并发，差值可能含对方的消耗 */
  exact: boolean
  consumed: number | null
  remain: number | null
  limit: number | null
}

/** 计费自检探针的结果（/traework/billing-check） */
export interface TraeworkBillingCheck {
  ok: boolean
  model: string
  /** 本次实际服务的账号名（send 的 onAccount 上报） */
  account: string | null
  accountId: number | null
  /** 模型表标称倍率（consumption_rate；命中会员折扣取折后价）。取不到为 null */
  expected: number | null
  /** 实测倍率 = consumed 增量 ÷ (total_tokens/1000)，与 Qoder billed_rate 同口径 */
  billed: number | null
  /** billed / expected，三位小数。任一侧缺失为 null */
  ratio: number | null
  /** 本次 consumed 增量（credits）。未观测到增量为 null */
  delta: number | null
  tokens: { input: number; output: number; total: number } | null
  /** 被扣费的账号列表（并发时可能不止一个） */
  charged: Array<{ id: string; delta: number }>
  /** 是否恰好一个账号被扣费（并发流量会破坏这个前提） */
  singleAccount: boolean
  elapsedMs: number
  /** 非空 = 请求成功但没测到增量（结算延迟） */
  warning?: string
  error?: string
  note?: string
}

export const traeworkApi = {
  status: () => client.get<TraeworkStatus>('/traework/status'),
  dashboard: () => client.get<TraeworkDashboard>('/traework/dashboard'),
  daily: (days = 14) =>
    client.get<{ days: number; rows: TraeworkDailyRow[] }>(`/traework/credits/daily?days=${days}`),
  creditRecords: (limit = 100) =>
    client.get<{
      limit: number
      rows: TraeworkCreditRecord[]
      window: { cost: number; requests: number; exact: number }
    }>(`/traework/credits/records?limit=${limit}`),
  models: (opts: { visibleOnly?: boolean; refresh?: boolean } = {}) => {
    const q: string[] = []
    if (opts.visibleOnly) q.push('visible=1')
    if (opts.refresh) q.push('refresh=1')
    const qs = q.length ? '?' + q.join('&') : ''
    return client.get<{
      models: TraeworkModel[]
      total: number
      error: string
      fetchedAt: number
      rateNote: string
    }>(`/traework/models${qs}`)
  },
  credits: () => client.get<{
    count: number
    rows: TraeworkCreditRow[]
    summary: TraeworkCreditsSummary
    /** 7 天内到期且还有剩余的额度包，按到期时间升序。空数组 = 无风险 */
    expiring: TraeworkExpiring[]
    expiringPoints: number
  }>('/traework/credits'),
  checkin: (id?: number) => client.post('/traework/checkin', id ? { id } : {}),
  /**
   * 计费自检探针：按模型发一个小请求（消耗真实积分），比对实测倍率与标称。
   * 探针含「发请求 + 8 秒结算轮询」，用比默认 30s 更长的超时。
   */
  billingCheck: (model: string) =>
    client.get<TraeworkBillingCheck>(`/traework/billing-check?model=${encodeURIComponent(model)}`, { timeout: 120000 }),
  loginUrl: () => client.post<{ ok: boolean; url: string; deviceId: string; machineId: string; hint: string }>('/traework/login/url'),
  loginCallback: (payload: { callback: string; deviceId: string; machineId: string }) =>
    client.post<{ ok: boolean; account?: TraeworkAccount; error?: string }>('/traework/login/callback', payload),
  removeAccount: (id: number) => client.delete(`/traework/accounts/${id}`),
  patchAccount: (id: number, fields: { enabled?: boolean }) =>
    client.patch(`/traework/accounts/${id}`, fields),
  /** 回填手机号（从昵称抽；TRAE 无官方手机号接口，多数情况抽不到） */
  refreshPhone: () =>
    client.post<{
      ok: boolean
      results: Array<{ id: number; name: string; ok: boolean; phone?: string; error?: string }>
      note: string
    }>('/traework/accounts/refresh-phone'),
}
