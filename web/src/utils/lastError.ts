// web/src/utils/lastError.ts - 账号 lastError 的新鲜度判定
//
// 背景（2026-10-02）：`lastError` 是「最近一次失败的错误串」，只在**换票成功**
// 或**请求成功**时才清空——所以一个不被使用的账号（非主账号、主账号一直成功）
// 会把一次瞬时失败永远挂着。界面把它当「当前故障」标红，用户以为账号坏了，
// 其实几小时前就自愈了。
//
// 两条判据：
//   1. **无时间戳 = 陈旧**。旧数据（本次改动前写入的）没有 lastErrorAt，无法
//      判断新鲜度——保守地当作陈旧，不报警。宁可少报也不要凭空报一个旧故障。
//   2. **有时间戳但要过窗**。超过 STALE_ERROR_MS 的错误大概率已自愈，同样
//      降级——但仍显示错误串（灰色），排查时看得到。
//
// 收敛到一处的原因：仪表盘账号卡与账号管理页都要判，各写一份必然漂移
// （上一版就是这么把「无时间戳」判成新鲜的）。

/** 超过这个时长未再失败，就认为该错误可能已自愈 */
export const STALE_ERROR_MS = 30 * 60 * 1000

export interface HasLastError {
  lastError?: string
  lastErrorAt?: number | null
}

/**
 * 这个账号的错误是否「新鲜」（值得标红成异常）。
 * - 无错误 → false
 * - 无时间戳（旧数据）→ false（当作陈旧，不报警）
 * - 有时间戳且未过窗 → true
 */
export function lastErrorFresh(a: HasLastError, now: number = Date.now()): boolean {
  if (!a.lastError) return false
  if (a.lastErrorAt == null) return false
  return now - a.lastErrorAt < STALE_ERROR_MS
}

/** 相对时间文案（「刚刚」「N 分钟前」…）。无时间戳返回空串 */
export function relTime(ts: number | null | undefined, now: number = Date.now()): string {
  if (!ts) return ''
  const d = now - ts
  if (d < 60000) return '刚刚'
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`
  return `${Math.floor(d / 86400000)} 天前`
}

/** 错误文案前缀：有时间戳显示「N 分钟前」，无则标「较早」 */
export function errorWhen(ts: number | null | undefined, now: number = Date.now()): string {
  return ts ? `${relTime(ts, now)}：` : '较早：'
}

/**
 * 数据是否已经「过期」（超过 ttlMs 没更新）。
 *
 * 为什么单独抽出来：这是「如实标注旧数据」的判据，界面上要据此变色/加话术。
 * 若写在组件里，只有靠肉眼等够 ttl 才能验证一次，回归时必然漂——而这类
 * 「看着是新的、其实是旧的」恰恰是本项目最忌讳的假象之一。
 *
 * 语义边界（刻意选的方向）：
 * - `ts` 为空 → **不算过期**。没数据时应显示「尚未读取」，那是另一句话，
 *   不该被标成「已过期」（旧数据过期 vs 从来没有数据，处置不同）。
 * - `ttlMs <= 0` → 永不过期（与 expiring/credits-snapshot 的开关口径一致）。
 * - 时间戳在未来（时钟回拨/跨机）→ 算新鲜，不因负数差值误报过期。
 */
export function isStale(
  ts: number | null | undefined,
  ttlMs: number,
  now: number = Date.now(),
): boolean {
  if (ts == null) return false
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false
  return now - ts > ttlMs
}
