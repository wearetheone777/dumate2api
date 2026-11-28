// web/src/api/workbuddy.ts - WorkBuddy 通道的接口类型
import client from '@/api/client'

/** 拼查询串：空值跳过，数组按逗号连（`uids=1,2`） */
function buildQuery(q: { region?: 'cn' | 'intl'; uids?: number[] }): string {
  const parts: string[] = []
  if (q.region) parts.push(`region=${q.region}`)
  if (q.uids && q.uids.length) parts.push(`uids=${q.uids.join(',')}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

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

/**
 * 模型繁忙度（`GET /workbuddy/busy`）。
 *
 * 三条界面必须如实传达的事实：
 *   1. `unsupported` 为真 = 国际版上游没有这个接口（404）。这是**查不到**，
 *      要显示成灰字说明，不能标红成故障。
 *   2. `guardEnabled` 默认 false = **只提示不拦**。如果界面让人以为「已避开
 *      繁忙模型」，那是撒谎——实际仍会打过去。
 *   3. `crowded` 只含 congested / unavailable 两档。`busy` 是偏忙，不是拥挤。
 */
export interface WorkBuddyBusy {
  ok: boolean
  region: 'cn' | 'global'
  /** 本次探测的模型 id（点名或目录全量） */
  models: string[]
  /** model → idle|normal|busy|congested|unavailable */
  levels: Record<string, string>
  /** 明显该避开的模型 id（congested / unavailable） */
  crowded: string[]
  /** 国际版没有该接口（404）：查不到，不是故障 */
  unsupported: boolean
  /** 繁忙度是否参与选号拦截（默认 false，需环境变量显式开启） */
  guardEnabled: boolean
  error: string
  note: string
  at: number
}

/**
 * 成长中心（`GET /workbuddy/growth`）—— **只读**。
 *
 * **为什么只有读没有写**：调研实证「伪造 /v2/report 成长事件会被上游识别为
 * 异常（2026-10-15 起国际版收紧）」，且接取/领奖的 body 形状被标为
 * 「未在 unlocked 态验证」。所以界面只能展示，不能代替用户去领。
 *
 * 五个字段**各自可空**：任一上游端点失败时它是 null，失败原因在 `errors` 里
 * 逐项记明。界面必须区分「查到了是 0」与「没查到（null）」——这是本项目
 * 反复强调的一条（null ≠ 0）。
 */
/**
 * 官方逐请求用量账本（`GET /workbuddy/usage-official`，P1-6）——**只读**。
 *
 * R2 两本账：这是**官方账本**（含官方客户端直连的消耗，网关 reqlog 看不到的
 * 那一半）；与用量页的网关侧账本并列呈现，不是「一个总量的两部分」。
 * credit 缺失/0 = 「这条记录没带」= 不知道，不是免费——creditsUnknown 如实单列。
 */
export interface WorkBuddyUsageOfficial {
  ok: boolean
  window_hours: number
  start: string
  end: string
  totals: {
    requests: number
    credits: number
    creditsUnknown: number
    accounts: number
    active: number
    truncated: boolean
  }
  by_account: Array<{
    id: number
    name: string
    region: string
    requests: number
    creditsKnown: number
    creditsUnknown: number
    truncated: boolean
    error?: string
  }>
  by_model: Array<{ model: string; requests: number; credits: number; creditsUnknown: number }>
  series: Array<{ day: string; requests: number; credits: number }>
  errors: Array<{ id: number; name: string; error: string }>
  skipped_enterprise?: number
  note?: string
}

export interface WorkBuddyGrowth {
  ok: boolean
  region: 'cn' | 'global'
  accountId?: number
  accountName?: string
  streak: {
    days: number | null
    monthTotal: number | null
    nextTier: string | null
    nextTierRemaining: number | null
    makeupCards: { balance: number | null; max: number | null }
    /** 已解锁但还没领的档位（「必须手动领，不领会过期」） */
    redeemable: number[]
    tiers: Array<{ tier: number; count: number | null; status: string }>
  } | null
  heatmap: {
    lit: number
    total: number
    today: string | null
    /** 今天的 score；**0 是「查到了没点亮」，null 是「查不到」** */
    todayScore: number | null
    recent: Array<{ date: string; score: number }>
  } | null
  tasks: {
    total: number
    claimed: number
    /** 排除 locked 与已过期后的「现在能做的」数量 */
    claimable: number
    creditTotal: number
    creditClaimed: number
    pending: Array<{
      code: string
      title: string
      desc: string
      type: string
      /** auto 类不接受接取，且是 single 任务的前置 */
      auto: boolean
      acceptStatus: string
      credit: number
      energy: number
      progress: { current: number; target: number }
      locked: boolean
      hasReward: boolean
      expired: boolean
    }>
  } | null
  energy: { balance: number | null; earned: number | null; consumed: number | null } | null
  buddyQuota: {
    affordable: number | null
    balance: number | null
    costPerOpen: number | null
    maxOpenCount: number | null
  } | null
  /** 逐项失败原因（key 为字段名） */
  errors: Record<string, string>
  note: string
  error?: string
  at: number
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

/** 连坐参数（P2-11：运行期可改，改短即时截断倒计时） */
export interface WorkBuddyRestrictionConfig {
  waveMin: number
  waveWindowSec: number
  holdSeconds: number
  restrictedRotateMax: number
}

/** 自动签到排程（P0-1） */
export interface WorkBuddyAutoCheckin {
  enabled: boolean
  hour: number
  minute: number
  jitter_minutes: number
  per_account_delay_ms: number
  last_run_at: number | null
  last_result: {
    trigger: string
    started_at: number
    duration_ms: number
    aborted: boolean
    region: 'cn' | 'global'
    accounts: number
    claimed: number
    already: number
    unknown: number
    failed: number
    /** 国际版网页打卡成功数（与签到分开计数——上游动作不同） */
    webDaily?: number
    /** 国际版网页打卡失败数 */
    webDailyFailed?: number
    /** 国内版对话活跃上报成功数（点亮 growth 连登，第三个上游体系） */
    activity?: number
    /** 活动中「已送达但回读失败」的数量——不冒充成功（见 reportActivity 注释） */
    activityUnverified?: number
    /** 国内版活跃上报失败数 */
    activityFailed?: number
    results: Array<{
      id: number
      name: string
      region: 'cn' | 'global'
      ok: boolean
      /** web-daily = 国际版网页打卡 / activity = 国内版连登活跃，都不是签到 */
      action: 'claim' | 'already' | 'unknown' | 'unsupported' | 'web-daily' | 'activity'
      already: boolean
      streakDays: number | null
      /** 仅 activity 行：连登天数回读成功才为 true（送达 ≠ 计入） */
      verified?: boolean
      error: string
      msg?: string
    }>
  } | null
  next_run_at: number | null
  running: boolean
  rationale?: string[]
}

/** 额度护栏（P1-6） */
export interface WorkBuddyGuard {
  config: {
    enabled: boolean
    threshold: number
    /** 保留积分下限（0 = 关闭）。**真正生效的是 poolFloor，这个值要重启才落到 pool** */
    creditFloor?: number
  }
  snapshot: { at: number | null; fresh: boolean; accounts: number; ttlMs: number }
  /** pool 当前实际生效的保底线（启动时读 env，运行期改不了） */
  poolFloor?: number | null
  note?: string
}

/** 模型规则（批次十二/十三）。models 元素可带 cn:/global: 前缀，裸名两域命中 */
export interface WorkBuddyModelRule {
  id: string
  name: string
  mode: 'deny' | 'allow'
  models: string[]
  note?: string
  updatedAt: string
}

/** GET /workbuddy/model-rules 的返回（?account_id=&model= 时附 account 诊断视图） */
export interface WorkBuddyModelRulesView {
  ok: boolean
  rules: WorkBuddyModelRule[]
  /** 规则 id → 挂载账号数 */
  counts: Record<string, number>
  /** 账号 id → 挂着的规则 id 全量映射 */
  assignments: Record<string, string[]>
  account?: {
    id: number
    nickname: string
    region: 'cn' | 'global'
    ruleIds: string[]
    /** 指定 model 时的判定结果（排查用）；未指定 model 时无此字段 */
    blocked?: boolean
  } | null
}

export const workbuddyApi = {
  status: (region?: 'cn' | 'intl') =>
    client.get<WorkBuddyStatus>(`/workbuddy/status${region ? `?region=${region}` : ''}`),
  /** 连坐暂停状态（比 status 轻：不查账号文件，仅读状态快照） */
  restriction: () => client.get<WorkBuddyRestriction>('/workbuddy/restriction'),
  /** 解除指定区域的连坐暂停（写信号给网关，并乐观更新快照） */
  clearRestriction: (region: 'cn' | 'intl') =>
    client.post<{ ok: boolean; region?: string; error?: string }>('/workbuddy/restriction/clear', { region }),
  /** 连坐参数（P2-11）：改完立即生效，改短时长会即时截断现有倒计时 */
  restrictionConfig: () =>
    client.get<{
      ok: boolean
      config: WorkBuddyRestrictionConfig
      envDefaults: WorkBuddyRestrictionConfig
      file: string
      note: string
    }>('/workbuddy/restriction/config'),
  saveRestrictionConfig: (payload: Partial<WorkBuddyRestrictionConfig>) =>
    client.put<{
      ok: boolean
      config?: WorkBuddyRestrictionConfig
      changed?: Partial<WorkBuddyRestrictionConfig>
      state?: WorkBuddyRestriction
      error?: string
    }>('/workbuddy/restriction/config', payload),
  /** 额度护栏（P1-6）：选号时跳过剩余低于阈值的账号 */
  guard: () => client.get<WorkBuddyGuard & { poolFloor?: number | null }>('/workbuddy/guard'),
  saveGuard: (payload: { enabled?: boolean; threshold?: number; creditFloor?: number }) =>
    client.put<{ ok: boolean; config?: { enabled: boolean; threshold: number; creditFloor?: number }; error?: string }>(
      '/workbuddy/guard',
      payload,
    ),
  /** 自动签到排程（P0-1）：打开时立即跑一轮，关闭时取消排程 */
  autocheckin: () => client.get<WorkBuddyAutoCheckin>('/workbuddy/autocheckin'),
  saveAutocheckin: (payload: { enabled?: boolean; hour?: number; minute?: number; jitter_minutes?: number }) =>
    client.put<WorkBuddyAutoCheckin & { ok: boolean; error?: string }>('/workbuddy/autocheckin', payload),
  /** 立即跑一轮自动签到（触发式：结果靠 autocheckin() 轮询） */
  runAutocheckin: () => client.post<{ ok: boolean; started: boolean }>('/workbuddy/autocheckin/run'),
  /**
   * 余额巡检（FEFO / 护栏保鲜）。
   *
   * **不属于 workbuddy 前缀**：本体是 `src/balance-refresh.js`，与搭子网页池
   * 共用同一份配置与同一个定时器（多起一个定时器只会让上游看到更密的节奏）。
   * 放在这里只是因为它从 WorkBuddy 账号页操作——接口归属跟页面归属不是一回事。
   */
  balanceRefresh: () => client.get<{
    ok: boolean
    enabled: boolean
    minutes: number
    last_run_at: number | null
    running: boolean
    interval_active: boolean
    note: string
    last_result: {
      ok_count?: number
      accounts?: number
      workbuddy?: { ok_count?: number; accounts?: number; entries?: number; error?: string } | null
    } | null
  }>('/auto-checkin/balance-refresh'),
  saveBalanceRefresh: (payload: { enabled?: boolean; minutes?: number }) =>
    client.post<{ ok: boolean; enabled?: boolean; minutes?: number; error?: string }>(
      '/auto-checkin/balance-refresh',
      payload,
    ),
  runBalanceRefresh: () => client.post<Record<string, unknown>>('/auto-checkin/balance-refresh/run-now'),
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
  /**
   * 模型实时繁忙度（2026-11-08 融合批）。
   *
   * 上游 `/v2/chat/busy` 是唯一「免费、不扣额度、不动账号状态」的接口。
   * 两条必须由界面如实传达的口径：
   *   - `unsupported`：国际版上游 404，是「查不到」不是「通道坏了」
   *   - `guardEnabled`：默认 false —— 繁忙度**只作参考、不参与选号**，
   *     要拦必须显式开环境变量（界面据此显示「仅提示」还是「已启用拦截」）
   */
  busy: (opts: { region?: 'cn' | 'intl'; models?: string[] } = {}) => {
    const q: string[] = []
    if (opts.region) q.push(`region=${opts.region}`)
    if (opts.models && opts.models.length) q.push(`models=${opts.models.join(',')}`)
    const qs = q.length ? '?' + q.join('&') : ''
    return client.get<WorkBuddyBusy>(`/workbuddy/busy${qs}`)
  },
  /**
   * 成长中心（**只读**）。一次打 5 个上游只读端点，所以只在用户点开时调，
   * 不进任何轮询。`id` 指定账号；不传用该区域第一个可用账号。
   */
  growth: (opts: { region?: 'cn' | 'intl'; id?: number } = {}) => {
    const q: string[] = []
    if (opts.region) q.push(`region=${opts.region}`)
    if (opts.id) q.push(`id=${opts.id}`)
    const qs = q.length ? '?' + q.join('&') : ''
    return client.get<WorkBuddyGrowth>(`/workbuddy/growth${qs}`)
  },
  usageOfficial: (opts: { hours?: number; region?: 'cn' | 'intl' } = {}) => {
    const q: string[] = []
    if (opts.hours) q.push(`hours=${opts.hours}`)
    if (opts.region) q.push(`region=${opts.region}`)
    const qs = q.length ? '?' + q.join('&') : ''
    return client.get<WorkBuddyUsageOfficial>(`/workbuddy/usage-official${qs}`)
  },
  credits: (region?: 'cn' | 'intl', uids?: number[]) =>
    client.get<{
      count: number
      region?: string
      /** all = 全量刷新；partial = 只刷了 uids 点名的账号（其余行沿用旧值） */
      scope?: 'all' | 'partial'
      requested?: number[]
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
    }>(`/workbuddy/credits${buildQuery({ region, uids })}`),
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

  // ---- 模型规则（批次十二/十三，misakano modelrules.go 移植） ----
  // 语义：deny 黑名单 / allow 白名单，多规则并集 + deny 优先；模型名可带
  // cn:/global: 前缀（裸名两域命中）；allow 在账号所属域零命中视作没挂。
  // 全部候选被拦 → 网关回 400 model_not_allowed（规则不会自愈，不回 503）。
  modelRules: (opts: { accountId?: number; model?: string } = {}) => {
    const q: string[] = []
    if (opts.accountId) q.push(`account_id=${opts.accountId}`)
    if (opts.model) q.push(`model=${encodeURIComponent(opts.model)}`)
    const qs = q.length ? '?' + q.join('&') : ''
    return client.get<WorkBuddyModelRulesView>(`/workbuddy/model-rules${qs}`)
  },
  saveModelRule: (rule: { id?: string; name: string; mode: 'deny' | 'allow'; models: string[]; note?: string }) =>
    client.post<{ ok: boolean; rule?: WorkBuddyModelRule; error?: string }>('/workbuddy/model-rules', { rule }),
  deleteModelRule: (id: string) =>
    client.delete<{ ok: boolean; error?: string }>(`/workbuddy/model-rules/${id}`),
  /** 设置某账号挂的规则集合（**整体替换**，空数组 = 全摘） */
  assignModelRules: (accountId: number, ids: string[]) =>
    client.post<{ ok: boolean; ids: string[]; error?: string }>('/workbuddy/model-rules/assign', {
      account_id: accountId,
      ids,
    }),
  /** 一条规则批量挂/摘到多账号（只增删这一条，其余规则原样保留；幂等） */
  applyModelRule: (id: string, accountIds: number[], assigned: boolean) =>
    client.post<{ ok: boolean; changed: number; error?: string }>('/workbuddy/model-rules/apply', {
      id,
      account_ids: accountIds,
      assigned,
    }),
}
