/**
 * 账号列表的客户端分页 / 排序 / 轮询去重（docs/WORKBUDDY-FUSION.md P2-9）。
 *
 * 三条口径写在这里，因为都是「看起来该这样、实际会坑」的地方：
 *
 * 1. **筛选与排序作用于全量，再切页**。先切页再排序 = 每页各自排序，
 *    翻页看到的是同一批账号的不同顺序，用户会以为数据在乱跳。所以调用方
 *    必须把「全量 → filter → sort → slice」串成一条链，页只作用在最后一步。
 * 2. **页码要夹紧，不能信调用方传的值**。删账号、改筛选、减小每页条数都会
 *    让当前页超出总页数；不夹就渲染出一片空白，而且界面不会解释为什么空。
 * 3. **轮询去重比轮询本身更重要**。15 秒整表重画在几十个账号时是可见的闪烁，
 *    在几百个时是持续 CPU 占用（每张卡都是 a-card + a-tag + 几个按钮）。
 *    判据是「签名没变就不赋值」，不是「延迟赋值」——后者仍然重画。
 *
 * 排序里的 `null` 一律排**最后**：余额/到期时间取不到是「未知」，未知既不是 0
 * 也不是 -1，按 0 排会让最该看的账号沉到底部（宁可看漏一个未知，也不要把
 * 未知排在「积分 0」前面当成紧急）。
 *
 * 纯函数、无 Vue 依赖：`node --test` 能直接 import 这个 .ts（Node 24 的类型
 * 擦除），所以这些行为有单测锁着，不靠界面目测。
 */

/** 默认每页条数（对齐融合文档口径：每页 50） */
export const DEFAULT_PAGE_SIZE = 50
export const PAGE_SIZE_OPTIONS = [50, 100, 200] as const

/** 总页数。0 条 → 0 页（不是 1 页，界面据此决定要不要显示分页条） */
export function pageCount(total: number, pageSize: number): number {
  const size = Math.max(1, Math.floor(Number(pageSize)) || 1)
  const n = Math.max(0, Math.floor(Number(total)) || 0)
  return n === 0 ? 0 : Math.ceil(n / size)
}

/** 把页码夹进 [1, 总页数]。空集合恒为 1（分页条需要有个非 0 的 current） */
export function clampPage(page: number, total: number, pageSize: number): number {
  const pages = pageCount(total, pageSize)
  if (pages <= 0) return 1
  const p = Math.floor(Number(page))
  if (!Number.isFinite(p) || p < 1) return 1
  return p > pages ? pages : p
}

/** 取当前页的数据。页码越界时返回最后一页，不是空数组 */
export function pageSlice<T>(rows: readonly T[], page: number, pageSize: number): T[] {
  const size = Math.max(1, Math.floor(Number(pageSize)) || 1)
  const p = clampPage(page, rows.length, size)
  const start = (p - 1) * size
  return rows.slice(start, start + size)
}

/** 稳定签名：用于「数据没变就别重画」。undefined 也要有签名，不能当空串 */
export function stableSig(v: unknown): string {
  const s = JSON.stringify(v)
  return s === undefined ? 'undefined' : s
}

export function sameSig(a: unknown, b: unknown): boolean {
  return stableSig(a) === stableSig(b)
}

export type RowSort = 'default' | 'credits-asc' | 'credits-desc' | 'expiring'

export interface SortableRow {
  id: number
  expiresAt?: number | null
}

/**
 * 排序。只接受「全量行 + 取积分的回调」，不认 currentPage —— 分页是调用方
 * 在排序之后才做的事。
 *
 * @param creditOf 返回该账号的剩余积分；null = 未知（排最后，不当 0）
 */
export function sortRows<T extends SortableRow>(
  rows: readonly T[],
  sort: RowSort,
  creditOf: (id: number) => number | null,
): T[] {
  const out = rows.slice()
  if (sort === 'default') return out

  if (sort === 'expiring') {
    // 已过期的排最前（那才是真需要处理的），无到期时间的排最后
    const at = (r: T) => {
      const v = r.expiresAt
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    }
    return out.sort((a, b) => {
      const x = at(a)
      const y = at(b)
      if (x == null && y == null) return 0
      if (x == null) return 1
      if (y == null) return -1
      return x - y
    })
  }

  const dir = sort === 'credits-asc' ? 1 : -1
  return out.sort((a, b) => {
    const x = creditOf(a.id)
    const y = creditOf(b.id)
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    if (x === y) return 0
    return (x - y) * dir
  })
}
