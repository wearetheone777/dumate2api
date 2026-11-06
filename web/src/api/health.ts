import client from './client'

// 健康预警（2026-11-06）：GET /api/admin/keepalive/health 的响应形状。
// 判据在后端 keepalive.internals.healthAlerts（纯函数）——前端只做着色与
// 展示，不重复判级，避免两端判据漂移。

export interface HealthAlert {
  level: 'crit' | 'warn'
  channel: string
  account: string
  reason: string
  message: string
}

export interface HealthAccount {
  id: number
  name: string
  enabled: boolean
  state: string
  cooling: boolean
  cool_remaining_s: number
  cooldown_reason: string
  disabled: boolean
  disabled_reason: string
  token_expires_in_s: number | null
  ok_count: number
  fail_count: number
  last_error: string
}

export interface KeepaliveHealth {
  ok: boolean
  summary: {
    crit: number
    warn: number
    accounts: number
    enabled: number
    healthy: number
  }
  alerts: HealthAlert[]
  web: HealthAccount[]
  keepalive: {
    enabled: boolean
    hour: number
    minute: number
    warn_hours: number
    running: boolean
    next_run_at: string | null
    last_run_at: string | null
    last_run_ok: boolean | null
    last_results: Array<{
      channel: string
      uid: string
      name: string
      ok: boolean
      skipped: boolean
      error: string
      expire_at: number | null
      expire_warn: { expire_at: number; left_hours: number } | null
    }>
  }
}

export function fetchKeepaliveHealth(): Promise<KeepaliveHealth> {
  return client.get<KeepaliveHealth>('/keepalive/health').then((r) => r.data)
}

export interface KeepaliveConfig {
  enabled: boolean
  hour: number
  minute: number
  jitter_minutes: number
  warn_hours: number
  sem_cap: number
  per_account_delay_ms: number
  balance_threshold: number
  checkin: boolean
}

export function fetchKeepaliveConfig(): Promise<KeepaliveConfig> {
  return client.get<{ ok: boolean; config: KeepaliveConfig }>('/keepalive/config').then((r) => r.data.config)
}

export function saveKeepaliveConfig(patch: Partial<KeepaliveConfig>): Promise<void> {
  return client.put('/keepalive/config', patch).then(() => undefined)
}

/** 立即跑一轮保活闭环。后端触发式：返回即已点火，结果靠 fetchKeepaliveHealth 轮询 */
export function runKeepaliveOnce(): Promise<{ ok: boolean; started: boolean }> {
  return client.post('/keepalive/run').then((r) => r.data)
}
