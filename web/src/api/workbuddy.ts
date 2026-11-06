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
  /** 出站代理（脱敏形态 http://user:***@h:p）；null = 直连。原始 URL 不出进程 */
  proxy: string | null
  /** 分组（自由命名标签，M2.4）：批量操作按组圈定范围；空串 = 未分组 */
  group: string
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
  /** 档位（计费摘要为唯一可信来源；取不到为 null） */
  tier: { paid: boolean; package: string; at: number | null } | null
  /** 额度包剩余合计（billing 套餐包，整数 remain 是 floor） */
  total: number | null
  /** 精确合计（上游 "…Precise" 字段，缺失为 null） */
  totalPrecise?: number | null
  packages: Array<{
    name: string
    remain: number
    size: number
    /** 到期时刻（北京时间 CycleEndTime 解析；缺失为 null） */
    expireAt: number | null
    /** 精确剩余（缺失为 null——整数 remain 是 floor） */
    remainPrecise?: number | null
  }>
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

/** 计费自检探针的结果（/workbuddy/billing-check）。口径同 TRAE：剩余额快照差值 */
export interface WorkBuddyBillingCheck {
  ok: boolean
  /** 国际版没有 credits 接口时的如实标记 */
  unsupported?: boolean
  model: string
  account?: string | null
  accountId?: number | null
  /** 模型表标称倍率（x0.00 = 免费，ratio 恒 null） */
  expected: number | null
  billed: number | null
  ratio: number | null
  /** 套餐剩余合计的前后差值（推断口径；没测到为 null，不编 0） */
  delta: number | null
  /** 整数积分口径下的测量分辨率（±积分/千token）= 1 ÷ (tokens/1000) */
  resolution?: number | null
  tokens: { input: number; output: number; total: number } | null
  charged: Array<{ id: string; delta: number }>
  singleAccount: boolean
  free?: boolean
  elapsedMs: number
  error?: string
  warning?: string
  note?: string
}

/** OAuth 设备授权登录·第一步的返回（/workbuddy/login/url） */
export interface WorkBuddyLoginStart {
  ok: boolean
  region?: string
  /** 设备授权 state（第二步轮询要带回） */
  state?: string
  /** 官方登录页链接（浏览器打开完成登录） */
  authUrl?: string
  error?: string
}

/** OAuth 设备授权登录·轮询返回（/workbuddy/login/poll） */
export interface WorkBuddyLoginPoll {
  status: 'pending' | 'ok' | 'error' | 'expired'
  message?: string
  error?: string
  /** status=ok 时已入池的账号 */
  account?: WorkBuddyAccount
}

/** 风控连坐状态（网关判定、管理端读快照） */
export interface WorkBuddyRestriction {
  /** 快照时刻；null = 从未触发过连坐 */
  at: number | null
  /** memory=网关同进程读到的实时态；snapshot=跨进程读落盘快照；none=从没触发 */
  source: 'memory' | 'snapshot' | 'none'
  config: { waveMin: number; waveWindowMs: number; holdMs: number; restrictedRotateMax: number }
  /** 仅含**仍有效**的暂停（until 已过期的不会出现在这里） */
  regions: Record<string, { until: number; remainingMs: number }>
  /** 窗口内被限制过的账号——和 regions 一起才说清「为什么暂停」 */
  events: Record<string, Array<{ uid: string; at: number; agoMs: number }>>
}

export const workbuddyApi = {
  status: (region?: 'cn' | 'intl') =>
    client.get<WorkBuddyStatus>(`/workbuddy/status${region ? `?region=${region}` : ''}`),
  /** 连坐暂停状态（比 status 轻：不查账号文件，仅读状态快照） */
  restriction: () => client.get<WorkBuddyRestriction>('/workbuddy/restriction'),
  /** 解除指定区域的连坐暂停（写信号给网关，并乐观更新快照） */
  clearRestriction: (region: 'cn' | 'intl') =>
    client.post<{ ok: boolean; region?: string; error?: string }>('/workbuddy/restriction/clear', { region }),
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
      /** FEFO 快照新鲜度（expiring.info()）：at 为空 = 没有快照；fresh=false = 超 TTL */
      fefo?: { at: number | null; fresh: boolean; accounts: number; windowDays: number }
    }>(`/workbuddy/credits${region ? `?region=${region}` : ''}`),
  checkin: (id?: number, group?: string) =>
    client.post('/workbuddy/checkin', id ? { id } : group ? { group } : {}),
  /** 计费自检：最低倍率的付费模型发一条小请求，按套餐剩余额差值实测扣费 */
  billingCheck: (model: string, region?: 'cn' | 'intl') =>
    client.get<WorkBuddyBillingCheck>(
      `/workbuddy/billing-check?model=${encodeURIComponent(model)}${region ? `&region=${region}` : ''}`,
      { timeout: 120000 },
    ),
  importClient: (region: 'cn' | 'intl') =>
    client.post<{ ok: boolean; account?: WorkBuddyAccount; error?: string; path?: string }>(
      '/workbuddy/import-client',
      { region },
    ),
  /** OAuth 浏览器登录：生成授权链接 → 轮询直到浏览器完成登录 */
  loginUrl: (region: 'cn' | 'intl') =>
    client.post<WorkBuddyLoginStart>('/workbuddy/login/url', { region }),
  loginPoll: (region: 'cn' | 'intl', state: string) =>
    client.post<WorkBuddyLoginPoll>('/workbuddy/login/poll', { region, state }),
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
  patchAccount: (id: number, fields: { enabled?: boolean; nickname?: string; proxy?: string; group?: string }) =>
    client.patch<{ ok: boolean; proxy?: string | null; account?: WorkBuddyAccount }>(`/workbuddy/accounts/${id}`, fields),
}
