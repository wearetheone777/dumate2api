export interface ApiKey {
  id: number
  name: string
  prefix: string
  /** 完整明文（2026-11-01 起随 key 落盘，管理端可随时查看复制）。
   *  旧 key（明文记录启用前创建的）为 null——明文从未落盘，无法回填。 */
  plain: string | null
  created_at: number
  expires_at: number | null
  enabled: boolean
  ip_allowlist: string[]
  model_allowlist: string[]
  /** 通道绑定：'' = 不限；设了就只允许走该通道的模型 */
  channel?: '' | 'dumate' | 'qwenwork' | 'traework' | 'qoder'
  note: string
  usage: {
    requests: number
    total_tokens: number
    failed: number
    last_at: number
    /** 按通道拆分的用量：同一把 key 可能两条通道都在用 */
    channels?: Record<string, { requests: number; total_tokens: number; failed: number }>
  }
}

export interface KeysData {
  keys: ApiKey[]
  /** 服务端实际应用的通道筛选（'' = 全部） */
  channel?: string
  /** 网关实况的鉴权开关（探测网关 /health 得来；null = 网关不在线，未知） */
  require_key: boolean | null
  gateway_online?: boolean
  days: number
}
