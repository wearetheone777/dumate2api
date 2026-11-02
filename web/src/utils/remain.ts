/**
 * 积分/批次的剩余时间文案。
 *
 * 之前恒显示 ceil 后的整天数——最后一天会一直挂着「还剩 1 天」，
 * 看不出几小时后作废。规则：>1 天显示「N 天」，≤1 天显示「N 小时」，
 * <1 小时显示「N 分钟」。
 */
export function remainText(expiresAt: number | null | undefined): string {
  if (!expiresAt) return '—'
  const ms = expiresAt - Date.now()
  if (ms <= 0) return '已过期'
  const h = ms / 3600000
  if (h >= 24) return `还剩 ${Math.floor(h / 24)} 天`
  if (h >= 1) return `还剩 ${Math.floor(h)} 小时`
  return `还剩 ${Math.max(1, Math.round(ms / 60000))} 分钟`
}

/** 剩余时间的警示色：不到 1 天红色（马上作废），7 天内橙色。 */
export function remainColor(expiresAt: number | null | undefined): string {
  if (!expiresAt) return 'default'
  const ms = expiresAt - Date.now()
  if (ms <= 0) return 'default'
  if (ms < 24 * 3600000) return 'red'
  if (ms < 7 * 24 * 3600000) return 'orange'
  return 'default'
}
