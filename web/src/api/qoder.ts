// web/src/api/qoder.ts - Qoder 通道的接口类型
//
// Qoder 与 TRAE Work 同构（多账号、可增删、有签到、单一 credits 结构），
// 但额度分**两块**（userQuota 订阅内 / addOnQuota 签到赠送），且**不能相加**。
import client from '@/api/client'

/** 一个 Qoder 账号（脱敏：token 只给尾部 6 位） */
export interface QoderAccount {
  id: number
  uid: string
  nickname: string
  username: string
  email: string
  /** 脱敏手机号。Qoder 无手机号字段，通常为空 */
  phoneMasked: string
  hasPhone: boolean
  /** 区域：cn（qoder.com.cn）/ global（qoder.sh）。两区账号不通用 */
  region: 'cn' | 'global'
  userType: string
  planName: string
  enabled: boolean
  preferred: boolean
  expiresAt: number | null
  refreshExpiresAt: number | null
  machineId: string
  lastError: string
  /** lastError 的写入时刻，界面显示「N 分钟前」用 */
  lastErrorAt: number | null
  createdAt: number | null
  daysAlive: number | null
  hasRefresh: boolean
  hasAccess: boolean
  refreshTail: string
}

export interface QoderStatus {
  ready: boolean
  error: string
  accounts: number
  /** 明确表示不需要任何客户端（签名纯本地） */
  needsClient: boolean
  mode: 'multi' | 'single'
  modeNote: string
  rows: QoderAccount[]
}

/** 一个额度池 */
export interface QoderQuotaBucket {
  total: number
  used: number
  remaining: number
  percentage: number
  unit: string
}

export interface QoderCreditRow {
  id: number
  nickname: string
  region: 'cn' | 'global'
  planName: string
  /** 订阅套餐内的额度。Free 套餐恒为 0 */
  userQuota: QoderQuotaBucket | null
  /** 签到/赠送得到的积分。**免费用户实际能用的就是这个** */
  addOnQuota: QoderQuotaBucket | null
  /**
   * 团队共享额度池（团队号才有）。有效余额 = 套餐 + 可用共享池。
   * `cap = -1` 表示不限量（用 `unlimited` 判断，别按数字比大小）。
   */
  orgResourcePackage: {
    used: number
    remaining: number
    cap: number
    unlimited: boolean
    available: boolean
  } | null
  isQuotaExceeded: boolean | null
  error: string
  /**
   * 签到状态查询的失败原因，与 `error`（额度查询）**分开**。
   * 额度查得到、签到查不到时不能混成一条「查询失败」——否则用户
   * 不知道自己点的签到到底成没成。
   */
  checkinError: string
  /**
   * 今日是否已签到。来自**只读**的 /campaigns（claimStatus），不触发领取。
   * null = 查不出来（上游没给活动），不猜成已签/未签。
   */
  checkedIn: boolean | null
  /** 待领额度（还有 CLAIMABLE 活动时）；已签为 0，查不出为 null */
  checkinPending: number | null
  /** 下次可签时刻（活动 endAt）。Qoder 是 10:00 UTC+8 刷新，不是 00:00 */
  checkinNextAt: number | null
  /** 上次签到时刻（本地记录，上游不提供） */
  lastCheckin: number | null
}

/**
 * 积分批次（来自本地账本，不是上游接口）。
 *
 * **为什么是本地账本**：Qoder 没有逐批积分余额接口，唯一带到期信息的是
 * 领取响应本身（签到后 30 天有效），所以每次签到落一条本地记录。
 *
 * **口径**：`amount` 是**领取额**（这批领到多少），不随消耗变；
 * `estimatedRemaining` 是按「先领先扣」从账号总余额（上游权威值）分配
 * 回批次的**推算剩余**——这才是「这批还剩多少」的可用读数。上游不按
 * 批次扣费，推算值不是上游数据；null = 总余额没查到，推不了。
 */
export interface QoderGrant {
  grantId: string
  accountId: number | null
  accountName: string
  campaignKey: string
  /** **领取额**，不是剩余额（上游不给逐批余额），仅作对照 */
  amount: number | null
  /** **推算剩余**（先领先扣模拟）。null = 余额没查到，不是 0 */
  estimatedRemaining: number | null
  grantedAt: number
  expiresAt: number
  validityDays: number | null
  modelScope: { modelSeries?: { key?: string } } | null
  /** 距到期天数（向上取整；已过期时为 0） */
  daysLeft: number | null
  expired: boolean
}

/**
 * 逐笔消耗明细（按时间倒序）。
 *
 * 与 TRAE 的同名字段形状相同但**成本来源不同**：TRAE 是 consumed 游标做差
 * （并发时可能不精确），Qoder 的 cost 是上游 `usage.credits` 直给的单请求扣费
 * （倍率 × tokens/1000），所以 exact 恒为 true。
 * cost 为 null = 上游这次没给 credits 字段，不补 0。
 */
export interface QoderCreditRecord {
  ts: number
  req_id: string
  account: string
  account_id: number
  model: string
  ms: number | null
  cost: number | null
  exact: boolean
}

export interface QoderModel {
  key: string
  name: string
  prefixed: string
  /** 倍率（上游 price_factor）。相对值，不是积分绝对值 */
  rate: number | null
  /**
   * 原价倍率（original_price_factor）。错峰/免费模型的 rate 会是 0
   * （实测 qfmodel=0、原价 0.1），只显示 rate 会被读成「完全不扣费」。
   */
  rateOriginal: number | null
  contextWindow: number | null
  isDefault: boolean
  isFree: boolean
  isNew: boolean
  isReasoning: boolean
  /** 错峰优惠（22:00-08:00 打折）。非活动期为 null */
  promotion: { discountFactor: number | null; windowStart: string; windowEnd: string } | null
  /** 是否低倍率（0.1 档）——适合开发调试 */
  cheap: boolean
}

export interface QoderDashboardAccount {
  id: number
  name: string
  uid: string
  region: 'cn' | 'global'
  planName: string
  enabled: boolean
  daysAlive: number | null
  expiresAt: number | null
  refreshExpiresAt: number | null
  refreshExpired: boolean
  lastError: string
  lastErrorAt: number | null
  refreshTail: string
}

/** device flow 登录：一次登录会话 */
export interface QoderLoginSession {
  ok: boolean
  url: string
  nonce: string
  region: 'cn' | 'global'
  hint: string
}

export interface QoderLoginPoll {
  status: 'pending' | 'ok' | 'error'
  waited?: number
  account?: QoderAccount
  error?: string
}

export const qoderApi = {
  status: () => client.get<QoderStatus>('/qoder/status'),
  /** 计费自检探针：按模型发一个小请求，比对「实测倍率 vs 模型表标称」。
   *  ratio≠1 不一定是改路由（错峰优惠/倍率元数据过期都是合法偏差）——判读看 note。 */
  billingCheck: (model: string, region?: 'cn' | 'global') =>
    client.get<{
      ok: boolean
      model: string
      account: string | null
      expected: number | null
      billed: number | null
      ratio: number | null
      credits: number | null
      elapsedMs?: number
      error?: string
      note?: string
    }>(`/qoder/billing-check?model=${encodeURIComponent(model)}${region ? `&region=${region}` : ''}`, { timeout: 120000 }),
  dashboard: () => client.get<{
    accounts: QoderDashboardAccount[]
    summary: { total: number; enabled: number; refreshExpired: number; errored: number }
    note: string
  }>('/qoder/dashboard'),
  /** 聊天测试台用的模型清单：**带 qoder/ 前缀**（网关靠前缀分流） */
  chatlabModels: () => client.get<{
    models: Array<{ id: string; name: string; prefixed: string }>
  }>('/chatlab/qoder-models'),
  models: (opts: { refresh?: boolean; region?: 'cn' | 'global' } = {}) => {
    const q: string[] = []
    if (opts.refresh) q.push('refresh=1')
    if (opts.region) q.push(`region=${opts.region}`)
    const qs = q.length ? '?' + q.join('&') : ''
    return client.get<{
      models: QoderModel[]
      total: number
      /** 本次模型表实际来自的区域（按所选账号归一化） */
      region?: 'cn' | 'global'
      error: string
      fetchedAt: number
      rateNote: string
    }>(`/qoder/models${qs}`)
  },
  credits: () => client.get<{
    count: number
    rows: QoderCreditRow[]
    summary: {
      total: number
      valid: number
      unknown: number
      /** 今日已签到的账号数（只数明确 true 的，查不出的 null 不计入） */
      checkedIn: number
      /** 签到/赠送积分合计 */
      addOnTotal: number
      /** 订阅内额度合计 */
      userTotal: number
      exceeded: number
      /** 7 天内到期的批次数 */
      expiringCount: number
      /**
       * 快过期积分：7 天窗口内批次的**推算剩余**合计（先领先扣模拟，
       * 余额来自上游额度接口）。estimated=false 时是领取额口径（降级）。
       */
      expiringAmount: number
      /** expiringAmount 是否推算口径（false = 余额没查到，回落的领取额） */
      expiringEstimated: boolean
      /** 领取额合计（对照口径，不随消耗变） */
      expiringGrantedAmount: number
    }
    note: string
  }>('/qoder/credits'),
  /** 最近 N 条逐笔消耗明细（本地归因账本，不打上游） */
  creditRecords: (limit = 200) =>
    client.get<{
      limit: number
      rows: QoderCreditRecord[]
      window: { cost: number; requests: number; exact: number }
      /**
       * 账本最早一条的时刻（null = 一本空账）。
       * **必须展示**：本功能上线前的请求没有逐笔记录、无法追溯，
       * 不标出起点的话「合计」会被读成「总共只花了这么点」。
       */
      since: number | null
      /** 账本涵盖的请求数（不是全部请求数） */
      recorded: number
    }>(`/qoder/credits/records?limit=${limit}`),
  /** 积分过期明细（本地账本 + 上游总余额的先领先扣推算） */
  grants: (days = 30) => client.get<{
    windowDays: number
    rows: QoderGrant[]
    expired: QoderGrant[]
    total: number
    /** 账本最早一条的时刻（null = 账本为空，本功能上线前领的无法追溯） */
    since: number | null
    /** 窗口内批次的**推算剩余**合计（先领先扣）；estimated=false 时是领取额 */
    expiringAmount: number
    /** 领取额合计（对照口径） */
    expiringGrantedAmount: number
    /** expiringAmount 是否推算口径 */
    estimated: boolean
    note: string
  }>(`/qoder/grants?days=${days}`),
  checkin: (id?: number) => client.post('/qoder/checkin', id ? { id } : {}),
  /** Pro 福利包资格（只读，一次性 +1800）。eligible=null 表示查不出来，不猜成「不能领」 */
  proEligibility: (id?: number) =>
    client.get<{
      rows: Array<{
        id: number
        nickname: string
        region: 'cn' | 'global'
        eligible: boolean | null
        /** true = 活动端点不存在（活动已下线），与「已领过」区分 */
        gone?: boolean
        error: string
      }>
      note: string
    }>(`/qoder/pro-eligibility${id ? `?id=${id}` : ''}`),
  /** 领取 Pro 福利包。**一次性不可逆**，后端要求 confirm: true */
  proClaim: (id?: number) =>
    client.post<{
      ok: boolean
      results: Array<{
        id: number
        nickname: string
        ok: boolean
        skipped?: boolean
        already?: boolean
        /** 到账差值（上游只回 success，不告诉我们发了多少） */
        gained?: number | null
        reason?: string
        error?: string
      }>
    }>('/qoder/pro-claim', { confirm: true, ...(id ? { id } : {}) }),
  // ---- device flow 登录 ----
  loginStart: (region: 'cn' | 'global' = 'cn') =>
    client.post<QoderLoginSession>('/qoder/login/start', { region }),
  loginPoll: (nonce: string) => client.post<QoderLoginPoll>('/qoder/login/poll', { nonce }),
  loginCancel: (nonce: string) => client.post<{ ok: boolean }>('/qoder/login/cancel', { nonce }),
  removeAccount: (id: number) => client.delete(`/qoder/accounts/${id}`),
  patchAccount: (id: number, fields: { enabled?: boolean; preferred?: boolean }) =>
    client.patch<{ ok: boolean; account?: QoderAccount }>(`/qoder/accounts/${id}`, fields),
}
