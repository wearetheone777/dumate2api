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
  /** P1-1：后台提前续期状态（默认关闭，DUMATE_QODER_TOKEN_PREREFRESH=1 才写） */
  tokenRefresh: { at: number; ok: boolean; error: string } | null
  machineId: string
  lastError: string
  /** lastError 的写入时刻，界面显示「N 分钟前」用 */
  lastErrorAt: number | null
  createdAt: number | null
  daysAlive: number | null
  hasRefresh: boolean
  hasAccess: boolean
  /** P2-1：凭证族 device / job / pat（只读展示，不带 token） */
  tokenFamily: 'device' | 'job' | 'pat' | 'unknown'
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
  // ---- 批次二十一角标：逐账号临期明细（grants 账本，快照没有 qoder）----
  /** 7 天内到期批次数 */
  expiringCount?: number
  /** 推算剩余合计（estOk=false 时回落领取额口径，与 summary 行为一致） */
  expiringAmount?: number
  /** 最早到期批次的时刻（无临期批次为 null） */
  expiringNearest?: number | null
  /** expiringAmount 是否推算口径（false = 领取额口径） */
  expiringEstimated?: boolean
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
  /**
   * 归属核验三态（P0-2，docs/QODER-GATEWAY-FEATURE-MERGE.md）。
   *
   * 每日积分**按账号各发一份**，只有服务端判定「同一个人」时才只发一份
   * （后领的被拒 `SAME_PERSON_ALREADY_CLAIMED`）。所以「领过了」与「真领到了」
   * 是两回事——被判同人的号没有积分进账，账本照记领取额就是假数据。
   *
   * `claimed` 真领到 / `same_person` 额度进了同一个人的另一个号 /
   * `unverified` **问不出结论（不猜不假报）**。老行缺失按 unverified 显示。
   */
  verification?: 'claimed' | 'same_person' | 'unverified'
  /** true 已核实进账 / false 核实未进账 / null 未核实（**null 不是 false**） */
  verified?: boolean | null
  samePerson?: boolean
  /** 核验的说明（为什么未核实、额度被谁领走） */
  verifyNote?: string
}

/** 到期分布的一行（P2-18）：某一天会作废多少 */
export interface QoderGrantExpiryDay {
  /** 到期日（本地时区 YYYY-MM-DD） */
  date: string
  /** 这天到期的批次数 */
  grantCount: number
  /** 领取额合计（对照口径，不随消耗变） */
  amounts: number
  /** **推算剩余**合计——真正会作废的数量 */
  remaining: number
  /** 涉及的账号 id（同一天可能多账号一起到期） */
  accounts: number[]
  accountCount: number
  /** 距今天数（自然日差，今天到期为 0） */
  daysLeft: number
  /** 到期前日均需耗量 = 推算剩余 ÷ max(1, daysLeft) */
  dailyNeed: number
  /** critical（≤1 天）/ high（≤3 天）/ watch（≤7 天）/ ''（其余） */
  warn: '' | 'critical' | 'high' | 'watch'
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
  /** P0-2：上游声明 enable=false 时 'disabled'；快照候选下线 'retired_candidate' */
  status?: 'active' | 'disabled' | 'retired_candidate'
  disabledReason?: string
  retiredCandidate?: boolean
  /** 模型表来源：upstream / disk-cache / client-cache / snapshot */
  catalogSource?: string
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
  status: (region?: 'cn' | 'intl') =>
    client.get<QoderStatus>(`/qoder/status${region ? `?region=${region}` : ''}`),
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
  dashboard: (region?: 'cn' | 'intl') =>
    client.get<{
      accounts: QoderDashboardAccount[]
      region?: string
      summary: { total: number; enabled: number; refreshExpired: number; errored: number }
      note: string
    }>(`/qoder/dashboard${region ? `?region=${region}` : ''}`),
  /** 聊天测试台用的模型清单：**带 qoder/ 前缀**（网关靠前缀分流） */
  chatlabModels: (region?: 'cn' | 'global') => client.get<{
    models: Array<{ id: string; name: string; prefixed: string; rate?: number | null }>
    region?: 'cn' | 'global'
    error?: string
  }>(`/chatlab/qoder-models${region ? `?region=${region}` : ''}`),
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
  credits: (region?: 'cn' | 'intl') => client.get<{
    count: number
    region?: string
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
  }>(`/qoder/credits${region ? `?region=${region}` : ''}`),
  /** 最近 N 条逐笔消耗明细（本地归因账本，不打上游） */
  creditRecords: (limit = 200, region?: 'cn' | 'intl') =>
    client.get<{
      limit: number
      region?: string
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
    }>(`/qoder/credits/records?limit=${limit}${region ? `&region=${region}` : ''}`),
  /** 积分过期明细（本地账本 + 上游总余额的先领先扣推算） */
  grants: (days = 30, region?: 'cn' | 'intl') => client.get<{
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
    /**
     * 到期分布（P2-18）：按到期日聚合「哪天会一口气作废多少」。
     * 明细里看不出的真风险（明天同时作废 300）只有聚合后可见。
     */
    distribution?: QoderGrantExpiryDay[]
    note: string
  }>(`/qoder/grants?days=${days}${region ? `&region=${region}` : ''}`),
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

  // ---- 运行期配置（P0-3，热生效：保存后网关下一次判定就读到新值） ----
  runtime: () => client.get<QoderRuntime>('/qoder-runtime'),
  saveRuntime: (patch: Partial<QoderRuntimeConfig>) =>
    client.put<{ ok: boolean; config?: QoderRuntimeConfig; changed?: Record<string, object>; restartFields?: string[]; error?: string }>(
      '/qoder-runtime', patch,
    ),
  /** 删除面板配置，全部字段回落到 env 默认值 */
  resetRuntime: () => client.delete<{ ok: boolean; removed: boolean; config: QoderRuntimeConfig }>('/qoder-runtime'),

  // ---- 自动签到排程（P0-1） ----
  autocheckin: () => client.get<QoderAutoCheckin>('/qoder-runtime/autocheckin'),
  saveAutocheckin: (payload: { enabled?: boolean; hour?: number; minute?: number; jitter_minutes?: number; include_intl?: boolean }) =>
    client.put<QoderAutoCheckin & { ok: boolean; error?: string }>('/qoder-runtime/autocheckin', payload),
  /** 立即跑一轮（触发式：结果靠 autocheckin() 轮询） */
  runAutocheckin: () => client.post<{ ok: boolean; started: boolean }>('/qoder-runtime/autocheckin/run'),

  /**
   * 模型锁池视图（P2-19）。本地快照，不打上游。
   *
   * 回答「Qoder 用不了是通道挂了还是某个模型在排队」。限流是 (账号, 模型)
   * 粒度的，所以「某个模型用不了」不等于通道挂了——换模型往往立刻可用。
   */
  modelLocks: (region?: 'cn' | 'intl') =>
    client.get<QoderModelLocks>(`/qoder/model-locks${region ? `?region=${region}` : ''}`),

  // ---- 输出上限主动探测（P2-20）----
  /**
   * 探一个模型的真实输出上限。**触发式**：立刻返回 started，进度靠
   * `outputProbeStatus()` 轮询。
   *
   * **单档真机约 3~4 分钟**（max_tokens=4096 实测 214 秒），四档串行十几分钟
   * ——所以做成异步，不做同步 HTTP。同一时刻只允许一个（409 = 已有在跑）。
   */
  outputProbe: (model: string, region?: 'cn' | 'global') =>
    client.post<{
      ok: boolean
      started?: boolean
      model?: string
      region?: string
      status?: QoderProbeStatus
      error?: string
      note?: string
    }>('/qoder/output-probe', { model, region }, { timeout: 120000 }),

  /** 探测任务状态（不阻塞：只读进程内状态） */
  outputProbeStatus: () =>
    client.get<QoderProbeStatus & { ok: boolean }>('/qoder/output-probe/status'),

  /** 已探测结论一览（本地落盘，不打上游） */
  outputProbes: (region?: 'cn' | 'intl') =>
    client.get<{
      region?: string
      count: number
      rows: Array<{
        model: string
        region: string
        verdict: string
        claimed: number | null
        actual: number | null
        /** 「32K ⚠ 钳制 4×」/「64K ✓」/「?」 */
        label: string
        ts: number
        stale: boolean
      }>
      note: string
    }>(`/qoder/output-probes${region ? `?region=${region}` : ''}`),

  /**
   * 用量分析（P2-17）：reqlog ⨝ credits 账本（按 req_id）。
   * 通用维度在 /usage/overview；这里补 Qoder 特有的账号归因、积分/1M 折算、
   * 本周期消耗（P1-10 口径）。
   */
  usage: (days = 30, region?: 'cn' | 'intl') =>
    client.get<{
      days: number
      region?: string
      totals: {
        requests: number
        ok: number
        failed: number
        inputTokens: number
        outputTokens: number
        totalTokens: number
        credits: number
        avgMs: number | null
        avgFirstTokenMs: number | null
        avgTokPerSec: number | null
      }
      byAccount: QoderUsageBucket[]
      byModel: QoderUsageBucket[]
      daily: Array<{ day: string; requests: number; tokens: number; credits: number; credited: number }>
      period: {
        bounded: boolean
        cost: number
        billedRequests: number
        perAccount: Array<{ id: number; name: string; bounded: boolean; cost: number; billedRequests: number; avg: number | null }>
      }
      note: string
    }>(`/qoder/usage?days=${days}${region ? `&region=${region}` : ''}`),
}

/** 用量分析的一个桶（按账号或按模型） */
export interface QoderUsageBucket {
  key: string
  name?: string
  requests: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  credits: number
  /** 有 credits 的请求数（折算比率的分母口径） */
  credited: number
  /** 积分 / 1M Token（真实成本密度）。null = 没有 credited 请求 */
  creditsPer1M: number | null
  avgTokPerSec: number | null
}

/** 模型锁池视图的一行 */
export interface QoderModelLock {
  model: string
  /** 被这个模型锁住的账号 id（已去前缀） */
  accounts: string[]
  accountCount: number
  /** 最早有一个号解锁的时刻 */
  earliestUntil: number
  earliestInMs: number
  /** **全池**解锁的时刻——与 earliestInMs 别混 */
  allClearUntil: number
  allClearInMs: number
  /** 该模型最多撞了几次 */
  maxHits: number
  /** 主因（上游原文，截断 160 字） */
  reason: string
  reasons: Array<{ text: string; count: number }>
  /** 粗分：queue（等就好）/ quota / model / other。**不给处置建议** */
  kind: 'queue' | 'quota' | 'model' | 'other'
  /**
   * 排队的子类别（2026-11-28 真机实测，只在 kind==='queue' 时给）：
   * - `real` 真排队（p4 / queueCount>0 / serviceAvailable:true）→ 等着会放行
   * - `hard` 伪装成排队的身份拒绝（p1 / queueCount:0 / serviceAvailable:false）
   *   → **等也不会放行**，要改 system 文本（见 identity-guard）
   * - `''` 认不出（不猜，按未知处理）
   */
  queueKind?: 'real' | 'hard' | ''
}

/** 探测任务状态（触发式编排的轮询目标） */
export interface QoderProbeStatus {
  running: boolean
  model: string
  region: string
  startedAt: number | null
  finishedAt: number | null
  elapsedMs: number
  last: {
    model: string
    region: string
    /**
     * clamped     被钳制（clamped 是实测值）
     * at_least    追平过该档（真实上限 ≥ atLeast）
     * unbounded   **上游不理 max_tokens**（真机：传 4096 回来 24706）
     *             ——这不是「上限很大」，是「没有可测的上限」
     * inconclusive 测不出（如实记录，不猜）
     */
    verdict: 'clamped' | 'at_least' | 'unbounded' | 'inconclusive'
    clamped: number | null
    atLeast: number | null
    unbounded: { requested: number; completion: number } | null
    modelMaxTokens: number | null
    steps: Array<{ requested: number; completion: number | null; finish: string | null; verdict: string; declared?: number; error?: string }>
    elapsedMs: number
    ts: number
    error?: string
  } | null
}

export interface QoderModelLocks {
  region?: string
  models: QoderModelLock[]
  /** true = 没有任何模型被锁（正常态） */
  cleared: boolean
  totalAccounts: number
  lockedAccounts: number
  /** 可选账号数 = 总数 − 被锁账号数 */
  available: number
  note: string
}

/**
 * Qoder 运行期配置（热生效）。三组值并排给出，是因为它们**可能不一致**：
 *   envDefaults  环境变量（部署时的意图）
 *   config       面板落盘值
 *   effective    **真正生效值**（还要过 chat.js 自己的兜底）
 * 界面显示 effective，同时把不一致标出来——否则「我明明改过」会变成悬案。
 */
export interface QoderRuntimeConfig {
  timeouts: {
    /** 首字节超时（ms，0 = 关闭）。挡「连响应头都不给」的挂起 */
    firstByteMs: number
    /** 「无内容」超时（ms，0 = 关闭）。挡「先回空 ack 再沉默」的排队形态 */
    contentMs: number
    /** 读空闲超时（ms，每块数据重置，0 = 关闭）。必须大于首字节超时 */
    readIdleMs: number
    /** 请求体上限（MB），对齐阿里云 SLB 30MB 硬限 */
    maxBodyMb: number
  }
  queue: {
    /** 官方排队轮询协议（requestSetId 稳定 + queue/status 放行信号） */
    pollEnabled: boolean
    /** 排队等待的整次请求预算（ms，所有账号共享） */
    pollBudgetMs: number
    /** 快速轮询总预算（ms，0 = 拿到限流立刻 429） */
    patienceMs: number
    /** 快速轮询间隔（ms）。过长会直接累加到用户等待 */
    stepMs: number
    /** 每轮排队睡眠（ms，0 = 按上游 retryAfterSeconds，夹 [5s,20s]） */
    pollIntervalMs: number
    /** 排队类限流的短冷却（ms）。与「账号坏了」区分开 */
    cooldownMs: number
  }
  limits: {
    /** 冷却上限（ms）。上游实测给过 7015 秒，照单全收＝封号两小时 */
    throttleMaxMs: number
    /** FEFO 临期窗口（天，0 = 关闭） */
    fefoDays: number
  }
  repair: {
    /** 「播报即收尾」重试上限（0 = 关闭修复） */
    retry: number
    /** 正文缓冲门阈值（字符）。超过就转直发，避免长回答被扣住 */
    holdCap: number
  }
  /**
   * 单号并发闸门与节奏（P1-6/P1-7）。
   * **默认 0 全关**——调研建议 Qoder 默认并发 1，但那是「先埋点观察 10605 率
   * 再定阈值」的结论。升级时静默把吞吐砍四分之三不是该做的事。
   */
  concurrency: {
    /** 单号同时在途上限（0 = 用池默认 4）。设 1 = 超出本地排队 */
    inflightMax: number
    /** 单号最小请求间隔（ms，0 = 关）。约束发射节奏，不是请求时长 */
    minIntervalMs: number
    /** `''` = 池默认加权抽签；`least-inflight` = 最少在途优先 */
    pickStrategy: '' | 'least-inflight'
    /** Qoder 积分保底（0 = 关）。低于此值的账号不进候选；全部低于时按余额最高者继续 */
    creditFloor: number
  }
  /** 出站身份句守卫（11-23 受控 A/B：品牌身份句触发 10605/p1 硬拒绝）。默认关 */
  identityGuard: { enabled: boolean }
}

export interface QoderRuntime {
  file: string
  fields: string[]
  subfields: Record<string, string[]>
  config: QoderRuntimeConfig
  envDefaults: QoderRuntimeConfig
  /** **真正生效值**（含调用方兜底），与 config 不同时界面要标红 */
  effective: {
    timeouts: QoderRuntimeConfig['timeouts']
    /** 闸门参数的实际生效值（含 env 兜底与池默认）。null = channel-pool 不可用 */
    concurrency: QoderRuntimeConfig['concurrency'] | null
  }
  /** 需重启才生效的字段（本项目为空数组＝全部热生效，如实报空） */
  restartFields: string[]
  note: string
}

/** 自动签到排程（P0-1） */
export interface QoderAutoCheckin {
  ok?: boolean
  error?: string
  enabled: boolean
  hour: number
  minute: number
  jitter_minutes: number
  /** 是否把国际版账号也纳入（campaigns 只在 cn 有活动，默认 false） */
  include_intl: boolean
  per_account_delay_ms: number
  retry_backoff_ms: number
  last_run_at: number | null
  next_run_at: number | null
  running: boolean
  last_result: {
    trigger: string
    started_at: number
    duration_ms: number
    aborted: boolean
    region: string
    accounts: number
    claimed: number
    already: number
    /** 当天无可领活动（**有意不重试**，不是失败） */
    skipped: number
    /** 状态查不出来 → 不签（不拿盲签去赌） */
    unknown: number
    /** 当日失败退避中 */
    backoff: number
    failed: number
    /** 本轮实际到账合计（上游余额差值，不是领取额合计） */
    gained: number
    results: Array<{
      id: number
      name: string
      region: 'cn' | 'global'
      ok: boolean
      action: 'claim' | 'already' | 'skipped' | 'unknown' | 'backoff' | 'refresh'
      already?: boolean
      pending?: number | null
      gained?: number | null
      claimed?: number
      error: string
      note?: string
    }>
  } | null
  rationale: string[]
}
