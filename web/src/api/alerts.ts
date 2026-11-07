import client from './client'

/** 运维告警（/api/admin/alerts）。规则评估只读本地事实，余额/状态未知不猜 0。 */
export type AlertRule =
  | 'pool_empty' | 'task_failed' | 'token_expiring' | 'error_rate'
  | 'key_burst' | 'off_hours' | 'budget'

export interface AlertConfig {
  /** pool_empty：可用账号少于该值 */
  minUsable: number
  /** task_failed：连续失败轮数 */
  taskFailStreak: number
  /** token_expiring：refresh token 剩余寿命（小时） */
  tokenWarnHours: number
  /** error_rate：窗口内失败占比阈值 */
  errorRate: number
  /** error_rate：样本不足不判 */
  errorMinRequests: number
  /** key_burst：单 Key 窗口请求数 */
  keyBurst: number
  offHoursStart: number
  offHoursEnd: number
  /** budget：窗口 token 预算（0 = 关） */
  budget: number
  windowMs: number
  silenceMs: number
  hysteresis: number
}

export interface ActiveAlert {
  id: string
  rule: AlertRule
  object: string
  level: 'crit' | 'warn' | 'info'
  message: string
  at: number
  notified_at?: number
  clear_streak?: number
}

export type AlertConfigField = keyof AlertConfig

export const alertsApi = {
  get: () => client.get<{
    rules: AlertRule[]
    hint_rules: AlertRule[]
    config: AlertConfig
    active: ActiveAlert[]
    /** 需要人处理的（warn/crit）；侧栏角标只该数这个 */
    actionable: ActiveAlert[]
    /** 仅提示（info），如非工作时段请求；不计入待办、不推送 */
    hints: ActiveAlert[]
    notify_enabled: boolean
    schedule_minutes: number
    schedule_active: boolean
    note: string
  }>('/alerts'),

  saveConfig: (patch: Partial<AlertConfig>) => client.put('/alerts/config', patch),

  /** 立即评估一轮；notify=true 才真的打 webhook（推送内容含账号名，注意渠道） */
  evaluate: (notify = false) =>
    client.post<{
      notify: ActiveAlert[]
      resolved: Array<{ id: string; rule: AlertRule; object: string; resolved_at: number }>
      active: ActiveAlert[]
      candidates: ActiveAlert[]
      delivered: Array<{ id: string; ok: boolean; error: string }>
    }>('/alerts/evaluate', { notify }),
}

/** 每个规则的说明与阈值字段（界面按这张表渲染，避免字段名与文案两处漂移） */
export const ALERT_RULES: Array<{
  rule: AlertRule
  label: string
  desc: string
  fields: Array<{ key: AlertConfigField; label: string; unit?: string; step?: number }>
}> = [
  {
    rule: 'pool_empty',
    label: '账号池见底',
    desc: '某通道可用账号数低于阈值。全部账号冷却/禁用时它会先响，早于用户报故障。',
    fields: [{ key: 'minUsable', label: '可用账号下限', unit: '个' }],
  },
  {
    rule: 'task_failed',
    label: '任务连续失败',
    desc: '签到/任务轮询连续失败。单轮抖动不算，靠迟滞累计。',
    fields: [{ key: 'taskFailStreak', label: '连续失败轮数', unit: '轮' }],
  },
  {
    rule: 'token_expiring',
    label: 'Token 即将到期',
    desc: 'refresh token 剩余寿命低于阈值——到期后必须重新登录，自动续期救不了。',
    fields: [{ key: 'tokenWarnHours', label: '提前预警', unit: '小时' }],
  },
  {
    rule: 'error_rate',
    label: '错误率过高',
    desc: '窗口内失败请求占比超过阈值。样本不足时不下结论，避免一两条失败就报警。',
    fields: [
      { key: 'errorRate', label: '失败占比', step: 0.05 },
      { key: 'errorMinRequests', label: '最少样本', unit: '条' },
    ],
  },
  {
    rule: 'key_burst',
    label: 'Key 用量暴涨',
    desc: '单把 API Key 窗口内请求数异常——泄露后被盗刷的典型信号。',
    fields: [{ key: 'keyBurst', label: '请求数阈值', unit: '次' }],
  },
  {
    rule: 'off_hours',
    label: '非工作时段请求',
    desc: '低优先级提示。个人自用时多半是自己在熬夜，保留但不建议推送。',
    fields: [
      { key: 'offHoursStart', label: '起', unit: '点' },
      { key: 'offHoursEnd', label: '止', unit: '点' },
    ],
  },
  {
    rule: 'budget',
    label: 'Token 预算',
    desc: '窗口内 token 用量达到预算。0 = 不启用这条规则。',
    fields: [{ key: 'budget', label: 'token 预算', step: 1000 }],
  },
]

export const ALERT_TUNING: Array<{ key: AlertConfigField; label: string; desc: string; unit?: string }> = [
  { key: 'silenceMs', label: '静默窗', desc: '同一规则+对象在这段时间内只推一次', unit: 'ms' },
  { key: 'hysteresis', label: '迟滞轮数', desc: '连续 N 轮命中才告警，连续 N 轮正常才报恢复', unit: '轮' },
  { key: 'windowMs', label: '评估窗口', desc: '错误率/用量类规则回看的时间范围', unit: 'ms' },
]

/** Prometheus 抓取地址（可选 token；脱敏展示用） */
export const metricsPaths = {
  root: '/metrics',
  admin: '/api/admin/metrics',
}
