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
  /** 每日配额（2026-11-07）：0/缺省 = 不限；超限该 key 的请求一律 429，本地零点重置 */
  daily_limit: { requests?: number; tokens?: number } | null
  /** 父 Key id（2026-11-08 子 Key）：null = 独立 Key。
   *  父被停用/删除/过期时子 Key 一并失效；父的每日配额是全家共享上限 */
  parent_id?: number | null
  /** 当日配额用量（网关内存计数器经落盘回读，约 5 秒延迟） */
  quota_today: { requests: number; tokens: number }
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
