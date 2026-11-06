// web/src/api/qwenwork.ts - 千问办公通道的接口类型
import client from '@/api/client'

export interface QwWallet {
  /** 只剩两个付费池：monthly（订阅套餐）/ longterm（充值赠送）。
   *  daily 池已移除——上游 2026-11-01 起停止发放每日免费额度，恒 0。 */
  id: 'monthly' | 'longterm'
  label: string
  kind: 'paid'
  /**
   * 余额。**null = 未知**（上游坏读，已用 account-context 的权威总数校正过），
   * 界面显示「—」。显示 0 会被读成「用完了」，两者不能混。
   */
  balance: number | null
  /** 该池额度刷新的时刻（上游 active_wallet 的 valid_to）；无则为 null */
  resetAt: string | null
}

export interface QwCredits {
  ok: boolean
  error: string
  /**
   * 两个付费池平级返回，不合并——月度来自订阅套餐、长期来自充值赠送，
   * 性质不同。**余额是全账号合计**，与顶部「积分余额」
   * （/accounts 的 summary.pointsTotal）同源，同一页两个数字必须对得上。
   */
  wallets: QwWallet[]
  /** 付费余额 = monthly + longterm */
  paid: number
  monthly: number
  longterm: number
  total: number | null
  /** 参与合计的账号数（余额查询成功的） */
  accountCount: number
  /** 余额查询失败的账号数。>0 时合计是**部分和**，界面要说明 */
  failedAccounts: number
  /**
   * 上游重试后仍返回「三池全 0」的账号数。这类账号的 0 可能是**真·额度耗尽**，
   * 也可能是上游持续异常——后端无法区分，界面要如实说明，不要武断下结论。
   */
  retriedAccounts: number
  /**
   * 其中已被 account-context 的权威总数校正过的账号数（池子分配未知，
   * total 可信）。这些账号的 0 已确认是上游坏读，不是「已用光」——
   * 界面要说「已校正」，不要与 retriedAccounts 一起说成「可能已用尽」。
   */
  misreadAccounts: number
  /** 合计里余额**已知**的账号数。小于 accountCount 时合计是部分和 */
  totalKnown: number
  /** true = 有账号余额未知，上面各池合计只含已知的部分 */
  partial: boolean
  /** 合计由哪些账号构成（每账号的池子余额） */
  accounts: Array<{
    id: string
    name: string
    monthly: number | null
    longterm: number | null
    total: number | null
    refreshAt: string | null
    /** 该账号余额是上游坏读、已用权威总数校正（池子分配未知） */
    misread: boolean
    /** 重试后仍为全 0（可能真耗尽，也可能上游持续异常） */
    retried: boolean
  }>
  /**
   * 额度刷新时刻（上游 active_wallet 的 valid_to，实测月初）。
   * **不是「每日重置」**：Free 号的月度额度按这个时刻刷新。
   */
  resetAt: string | null
  /**
   * 上游自己给的「即将过期」列表——**这才是会作废的那部分**（付费积分
   * 按有效期，过期即消失）。count 为 0 表示无风险。
   */
  expiringSoon: { count: number; total: number; wallets: Array<{ balance: number; valid_to: string }> }
  fetchedAt: number
  /**
   * 今日消耗。**仅统计经本网关的请求**——这是唯一有实测依据的口径。
   * 不再提供「今日全部消耗（含客户端内对话）」：那需要「每日上限 − 余额」，
   * 而上游已不再发放每日额度，推不出来。
   */
  today: { total: number; requests: number; scope: 'gateway' }
  /** 主账号名（保留字段）。合计口径下它不再代表全体，改用 accountCount */
  account?: string
}

export interface QwDailyRow {
  day: string
  /** 当日经本网关的消耗合计。不再拆 free/paid——上游停发每日额度后 free 恒 0 */
  total: number
  requests: number
  concurrent: number
}

export interface QwModel {
  id: string
  name: string
  prefixed: string
}

/** 归因里附带的账号信息（千问是单账号直连，但字段留着方便以后扩展） */
export interface QwAccountInfo {
  id: string
  name: string
  tier: string
  planId: string
}

/** 千问登录态（只读）。来自官方客户端的 auth-v2.dat */
export interface QwLogin {
  ok: boolean
  error: string
  file: string | null
  fileStat: { size: number; mtime: number } | null
  machineId: string
  account: {
    id: string
    name: string
    username: string
    email: string
    tier: string
    planName: string
    planId: string
    planSubscriptionActive: boolean
    planNextDueDate: string | null
    isBiz: boolean
    orgName: string | null
    entitlements: {
      pageQuota?: number
      monthRequests?: number
      monthTraffic?: string
    } | null
  } | null
  token: {
    accessExpiresAt: number | null
    refreshExpiresAt: number | null
    accessExpired: boolean
    refreshExpired: boolean
    /** refresh token 临期（<24h）预警：过期即必须重新 device flow */
    refreshExpiringSoon: boolean
  }
  ready: boolean
  wasm: string | null
}

/** 积分逐笔记录（来自归因历史） */
export interface QwCreditRecord {
  ts: number
  req_id: string
  model: string
  ms: number | null
  /** 本次消耗合计。不再有 free/paid/pool 分列——上游停发每日额度后它们恒为 0/paid */
  total: number
  concurrent: boolean
  balance: { daily: number; monthly: number; longterm: number } | null
  account: QwAccountInfo | null
}

/**
 * 千问办公账号。
 *
 * 2026-09-25 起是多账号池：凭证由本项目通过 device flow 自行换取，
 * 存 data/qwenwork-accounts.json，可增删、可停用、可指定主账号。
 */
export interface QwAccount {
  id: string
  name: string
  username: string
  email: string
  /** 脱敏手机号（如 157****1251）。完整号码是 PII，接口不外传 */
  phone: string
  tier: string
  planName: string
  /** 主账号（当前在用）。故障时会自动转移到下一个可用账号 */
  active: boolean
  enabled: boolean
  usable: boolean
  /** 账号存活天数（仪表盘账号健康快照用，从 createdAt 算） */
  daysAlive: number | null
  /** 三池积分合计（仪表盘账号健康快照用） */
  points: number | null
  tokenExpiresAt: number | null
  refreshExpiresAt: number | null
  refreshExpired: boolean
  /** refresh token 临期（<24h）预警：过期即必须重新 device flow，提前亮牌 */
  refreshExpiringSoon: boolean
  /**
   * 凭证来源标记：refresh 被拒时从官方客户端 auth-v2.dat 收编救活的账号
   * 带 'official-desktop'。正常 device flow 账号无此字段
   */
  adoptedFrom: string | null
  machineId: string
  lastError: string
  /** lastError 的写入时刻。界面据此显示「N 分钟前」并判断新鲜度——无则 null */
  lastErrorAt: number | null
  /** refresh token 尾 6 位，供人工核对是哪个账号。全量不外传 */
  refreshTail: string
  wallets: {
    daily: number | null
    monthly: number | null
    longterm: number | null
    total: number | null
    /** 上游 active_wallet 的到期时刻 = 月度额度刷新点（实测月初） */
    refreshAt: string | null
    /** 该账号余额是上游坏读、已用权威总数校正：池子分配未知，total 可信 */
    misread: boolean
  } | null
  /** 该账号即将过期的积分（上游 expiring_soon）。count=0 表示无风险 */
  expiringSoon: { count: number; total: number; wallets: Array<{ balance: number; valid_to: string }> }
}

/** /qwenwork/accounts 的汇总（顶部指标卡用，口径与搭子对齐） */
export interface QwAccountsSummary {
  total: number
  enabled: number
  disabled: number
  /** 有效期内 = 凭证可用（enabled 且未 refreshExpired） */
  valid: number
  /** 有即将过期积分的**账号数** */
  expiringSoon: number
  /** 即将过期积分的**总量**——用户关心的是会作废多少积分 */
  expiringSoonPoints: number
  pointsTotal: number
}

/** device flow 登录：一次登录会话 */
export interface QwLoginSession {
  ok: boolean
  url: string
  nonce: string
  machineId: string
  hint: string
}

/** 轮询取票的返回 */
export interface QwLoginPoll {
  status: 'pending' | 'ok' | 'error'
  /** pending 时是已等待毫秒数 */
  waited?: number
  account?: QwAccount
  error?: string
}

/** 计费自检探针的结果（/qwenwork/billing-check）。千问无标称倍率，只有实测成本 */
export interface QwBillingCheck {
  ok: boolean
  model: string
  account: string | null
  accountId: number | string | null
  /** 千问没有标称倍率可对标，恒为 null */
  expected: null
  /** 每千 token 实测成本（cost ÷ tokens/1000） */
  billed: number | null
  ratio: null
  /** 本次请求的三池余额差值合计（credits） */
  cost: number | null
  pools: {
    daily: number | null
    monthly: number | null
    longterm: number | null
    free: number | null
    paid: number | null
    total: number | null
  } | null
  tokens: { input: number; output: number; total: number } | null
  charged: Array<{ id: string; total: number }>
  singleAccount: boolean
  elapsedMs: number
  warning?: string
  error?: string
  note?: string
}

export const qwenworkApi = {
  /** 计费自检探针：发一个小请求，报实测成本（消耗真实额度，量级极小） */
  billingCheck: (model: string) =>
    client.get<QwBillingCheck>(`/qwenwork/billing-check?model=${encodeURIComponent(model)}`, { timeout: 120000 }),
  credits: () => client.get<QwCredits>('/qwenwork/credits'),
  daily: (days = 14) => client.get<{ days: number; rows: QwDailyRow[] }>(`/qwenwork/credits/daily?days=${days}`),
  models: () => client.get<{ models: QwModel[]; error: string }>('/qwenwork/models'),
  status: () => client.get<{
    ready: boolean; loggedIn: boolean; error: string;
    wasm: string | null;
    account: string; tier: string; planId: string;
    tokenExpiresAt: string | null;
    refreshExpiresAt: string | null;
    refreshExpired: boolean;
    /** refresh token 临期（<24h）预警 */
    refreshExpiringSoon: boolean;
    /** ACP 链路上游实定档位（最近一次建会话的 extra_data.mode；无会话 null） */
    acpMode: string | null;
  }>('/qwenwork/status'),
  // 登录态详情（只读）
  login: () => client.get<QwLogin>('/qwenwork/account'),
  // 积分逐笔明细
  creditRecords: (limit = 100) =>
    client.get<{
      limit: number
      rows: QwCreditRecord[]
      window: { total: number; requests: number }
    }>(`/qwenwork/credits/records?limit=${limit}`),
  // 账号列表（多账号池，mode='multi'）
  accounts: () => client.get<{
    mode: 'single' | 'multi'
    modeNote: string
    count: number
    accounts: QwAccount[]
    /** 顶部指标卡用（账号总数 / 有效期内 / 即将过期 / 积分余额） */
    summary: QwAccountsSummary
    /** FEFO 快照新鲜度（src/expiring.js info()）：at=null 表示从未落盘 */
    fefo: { at: number | null; fresh: boolean; accounts: number; windowDays: number }
    error: string
  }>('/qwenwork/accounts'),
  // ---- 以下为多账号后的写接口 ----
  loginStart: () => client.post<QwLoginSession>('/qwenwork/login/start'),
  loginPoll: (nonce: string) =>
    client.post<QwLoginPoll>('/qwenwork/login/poll', { nonce }),
  loginCancel: (nonce: string) =>
    client.post<{ ok: boolean }>('/qwenwork/login/cancel', { nonce }),
  removeAccount: (id: string | number) => client.delete(`/qwenwork/accounts/${id}`),
  patchAccount: (id: string | number, fields: { enabled?: boolean; preferred?: boolean }) =>
    client.patch<{ ok: boolean; account?: QwAccount }>(`/qwenwork/accounts/${id}`, fields),
  /** 回填手机号（对加这个字段之前登录的账号补一次） */
  refreshPhone: () =>
    client.post<{ ok: boolean; results: Array<{ id: number; name: string; ok: boolean; phone?: string; error?: string }> }>(
      '/qwenwork/accounts/refresh-phone',
    ),
}
