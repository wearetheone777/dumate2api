export interface UsageToday {
  requests: number
  tokens: number
  failed: number
  success_rate: number | null
  avg_ms: number | null
  // 老日志没有首字字段，样本数说明这个均值基于多少条记录
  avg_first_token_ms: number | null
  first_token_samples: number
  input_tokens: number
  output_tokens: number
  stream_count: number
  models: Array<{ model: string; tokens: number }>
  // 只有搭子有上游积分账单；切到千问办公时这两项为 null
  consumed_points: number | null
  point_records: number | null
}

export interface UsageCards {
  today: UsageToday
  week: { requests: number; tokens: number; failed: number }
  consumed: number
  consumed_records: number
  active_keys: number
  top_model: string | null
}

export interface UsageDaily {
  day: string
  requests: number
  total_tokens: number
  failed: number
}

export interface UsageBucket {
  requests: number
  total_tokens: number
  input_tokens: number
  output_tokens: number
  failed: number
  avg_ms: number
}

export interface UsageByChannel {
  id: string
  label: string
  requests: number
  total_tokens: number
  failed: number
  avg_ms: number
  /** 首字延迟按通道分开算：千问首帧实测 6.7s，混进搭子均值会失真 */
  avg_first_token_ms: number | null
  first_token_samples: number
}

export interface UsageByModel extends UsageBucket {
  model: string
}

export interface UsageByKey extends UsageBucket {
  name: string
}

export interface UsagePointsAccount {
  id: number
  name: string
  ok: boolean
  consumed_points?: number
  count?: number
  error?: string
}

export interface UsageOverview {
  days: number
  /** 服务端实际应用的通道筛选（'' = 全部通道） */
  channel: string
  cards: UsageCards
  daily: UsageDaily[]
  by_model: UsageByModel[]
  /**
   * 按通道聚合。仅在「全部通道」时返回——已按单通道过滤时为空数组，
   * 因为那时只会得到一行自己的数据。
   */
  by_channel: UsageByChannel[]
  by_key: UsageByKey[]
  points_by_account: UsagePointsAccount[]
  /** 积分账单缓存元数据（批次二十）：cached=true 时前端必须标「缓存于」；
   *  cached=false = 刚现算过（后台已重新预热）；非搭子通道为 null */
  points_cache: { cached: boolean; cached_at?: number } | null
  note: string
}
