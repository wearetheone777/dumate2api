// web/src/api/modelinfo.ts - 三条通道的模型信息（统一形状）
import client from '@/api/client'

/** 字段来源：决定这个数字能不能信 */
export type ModelFieldSource = 'upstream' | 'measured' | 'config'

export interface ModelInfoRow {
  id: string
  name: string
  /** 调用时用的全名（带通道前缀） */
  prefixed: string
  channel: 'dumate' | 'qwenwork' | 'traework' | 'qoder'
  /** 上游原生名字（非别名） */
  native: boolean
  /** 别名指向的目标 */
  target: string
  /** 消耗倍率。**只有 TRAE 与 Qoder 的上游给**，其余通道为 null（显示 —，不补 0） */
  rate: number | null
  rateSource: ModelFieldSource | null
  /**
   * 原价倍率（Qoder 的 original_price_factor）。
   * 错峰/免费模型的 rate 会是 0，只显示 rate 会被读成「不扣费」。
   */
  rateOriginal?: number | null
  rateDiscounted?: number | null
  memberDiscount?: number | null
  discountMatched?: boolean
  /** 上下文窗口（上游声明，实际是**客户端压缩阈值**）。拿不到为 null */
  contextWindow: number | null
  /**
   * 服务端实测硬限。null = 该模型没测过——不要用 contextWindow 顶替，
   * 两者在很多模型上差 5 倍（声明 200K / 实测 1M）
   */
  contextWindowHard?: number | null
  contextHardSource?: ModelFieldSource | null
  /** 实测下限（搭子：32K 通过 / 128K 超时，所以给区间而非单值） */
  contextWindowMin: number | null
  contextSource: ModelFieldSource | null
  contextNote?: string
  /** 输出上限 */
  maxTokens: number | null
  maxTokensSource: ModelFieldSource | null
  capability: string
  multimodal: boolean
  visible?: boolean
  usage?: string
  isDefault?: boolean
  isNew?: boolean
  isBeta?: boolean
  /** 免费档（Qoder 的 is_free）。与 TRAE 的会员折扣不是一回事 */
  isFree?: boolean
  note?: string
}

export const modelInfoApi = {
  list: (opts: { channel?: string; refresh?: boolean; all?: boolean } = {}) => {
    const q: string[] = []
    if (opts.channel) q.push(`channel=${opts.channel}`)
    if (opts.refresh) q.push('refresh=1')
    // all=1 看 TRAE 上游表全量（subagent / custom_model 占位 / summary）；
    // 默认只返回可用对话模型（与 /v1/models 的 usableIds 同口径）
    if (opts.all) q.push('all=1')
    const qs = q.length ? '?' + q.join('&') : ''
    return client.get<{
      channel: string
      rows: ModelInfoRow[]
      error?: string
      errors?: Record<string, string>
    }>(`/models/info${qs}`)
  },
}
