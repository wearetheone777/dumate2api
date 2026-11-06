// 请求日志（网关逐条转发的原始记录）
export interface ReqLogRow {
  ts: number
  ms: number
  first_token_ms: number | null
  path: string
  model: string
  mapped_model?: string
  // 上游通道。**历史记录没有这个字段**（分通道之前产生的），
  // 所以是可选的——界面遇到 undefined 显示「—」而不是默认成搭子。
  channel?: 'dumate' | 'qwenwork' | 'traework' | 'qoder' | 'workbuddy'
  stream: boolean
  messages: number
  status: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  ip: string
  ua?: string
  key_id: number
  key: string
  error?: string
  upstream?: string
  // 这条请求实际用了哪个上游账号。
  // **权威来源是 provider 上报**（多账号轮询下只有它知道选中的是哪一个），
  // 没有则按通道读当前凭证兜底。两者都拿不到时缺省——界面显示「—」。
  account?: string
  // 区域（2026-11-03 国际版）：traework/qoder 随实际服务账号记录。
  // 旧行与纯国内通道（搭子/千问）没有这个字段——空缺不读成国内
  region?: 'cn' | 'intl' | ''
  // 计量口径（2026-11-06）：wallet-delta = 上游会话帧不带 token 计量（ACP 链路），
  // tokens 恒 0 是「没数」不是「没花钱」——界面显示「无计量」而不是 0。
  metering?: '' | 'wallet-delta'
  // 实际扣费：由「请求后余额 - 上一条请求后余额」实测得出，非估算。
  // points_exact=false 表示这条与相邻请求并发，差值里可能混了别人的消耗。
  points_delta?: number
  points_exact?: boolean
  // ---- 千问办公通道的积分明细（与上面的搭子游标是两套账）----
  // 按 req_id 与归因记录精确配对；归因要等结算，所以刚发出的请求可能还没有
  // 这些字段，界面遇到缺省显示「—」而不是补 0。
  //
  // **只有 qw_total**：不再带 qw_free / qw_paid / qw_pool（2026-11-02）——
  // 上游已停止发放每日免费额度，新记录 free 恒 0、pool 恒 paid，那三列
  // 只会显示一排零和同一个标签。历史行里的字段仍在账本里，只是不再透出。
  qw_total?: number
  /** true = 与相邻请求并发，差值可能含别人消耗 */
  qw_concurrent?: boolean
  qw_balance?: { daily: number; monthly: number; longterm: number } | null
  /** 消耗的是哪个千问账号（单账号直连，但留接口以便以后多账号扩展） */
  qw_account?: { id: string; name: string; tier: string; planId: string } | null
  // ---- TRAE Work 通道的积分明细（第三套账，与上面两套都不同）----
  // TRAE 是多账号自持凭证，所以这里带的是**本次实际使用**的账号，
  // 而不是「池里的第一个」——多账号下两者不是一回事。
  /** 本次实际使用的账号（昵称，取不到则 uid 或「账号 N」） */
  tw_account?: string
  /** 这条请求的真实消耗 = 同账号上一条与本条的累计消耗之差 */
  tw_cost?: number
  /** 成本口径（2026-11-06）：session_usage=上游单请求账单（精确）；consumed_delta=差值推断 */
  tw_source?: 'session_usage' | 'consumed_delta'
  /** false = 与同账号相邻请求并发，差值可能含对方的消耗 */
  tw_exact?: boolean
  /** 请求后的累计已消耗 / 剩余 / 额度上限 */
  tw_consumed?: number | null
  tw_remain?: number | null
  tw_limit?: number | null
  // ---- Qoder 通道的积分明细（第四套账）----
  // 与千问/TRAE 都不同的地方：**上游 usage 直给本条 credits**
  // （倍率 × tokens/1000），不做相邻差值——所以首条就有值，并发也不串账。
  /** 本次实际使用的账号（昵称，取不到则 uid） */
  qoder_account?: string
  /** 这条请求消耗的真实 credits，上游直给 */
  qoder_cost?: number
  // ---- Qoder 的三段积分拆分（hub v1.7.22 融合，2026-11-04）----
  // 按 token 折算「非缓存输入 / 缓存输入 / 输出」。缓存段 null = 上游没回报
  // 缓存字段（不是零命中）；sum 缺缓存段时也是 null——少一段不假装完整。
  credit_split?: {
    input: number
    cached: number | null
    output: number
    sum: number | null
    tokens: { noncached_input: number; cached: number; output: number }
    coef: [number, number, number]
  }
}

export interface ReqLogsData {
  rows: ReqLogRow[]
  total: number
  limit: number
  offset: number
  /** 服务端实际应用的通道筛选（'' = 全部通道） */
  channel?: string
  note?: string
}

// 上游计费记录（网页端「积分消费记录」同源）。
// 与网关日志不是一一对应：一次转发可能拆成多笔扣费。
export interface PointsRecord {
  account_id: number
  account: string
  ts: number
  points: number
  conversation: string
  package_id: string
  rowKey?: string
}

export interface PointsAccountSummary {
  id: number
  name: string
  nickname: string
  ok: boolean
  error?: string
  total_count?: number
  consumed_points?: number
}

export interface PointsRecordsData {
  rows: PointsRecord[]
  total: number
  consumed_points: number
  page: number
  limit: number
  days: number
  accounts: PointsAccountSummary[]
  note?: string
}
