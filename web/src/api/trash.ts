// web/src/api/trash.ts - 账号回收站（批次十六，后端 src/admin/trash.js）
//
// 五通道共用一套后端实现（routesFor(channel) 挂在各自的 /api/admin/<通道> 下），
// 搭子的挂载点是 /web-accounts（与其账号路由一致），其余通道是 /<通道>。
import client from '@/api/client'

/** 单条回收站记录（视图层形状；凭据永不下发——它们只在落盘的原始记录里） */
export interface TrashEntry {
  key: string
  id: number
  name: string
  deletedAt: number | null
  expiresAt: number | null
  /** 剩余可恢复天数（ceil；坏时间如实 null） */
  expiresInDays: number | null
}

export interface TrashList {
  ok: boolean
  /** 回收站文件解析失败 ⇒ true：列表退化为空但损坏可见（界面能起来，不装没事） */
  corrupt: boolean
  retentionDays: number
  maxEntries: number
  entries: TrashEntry[]
}

export type TrashChannel = 'dumate' | 'qwenwork' | 'traework' | 'qoder' | 'workbuddy'

function basePath(channel: TrashChannel): string {
  return channel === 'dumate' ? '/web-accounts' : `/${channel}`
}

export const trashApi = {
  list: (channel: TrashChannel) =>
    client.get<TrashList>(`${basePath(channel)}/trash`),
  /** 恢复（key = 账号 id 的字符串形态，后端原样回传匹配） */
  restore: (channel: TrashChannel, key: string) =>
    client.post<{ ok: boolean; name?: string; error?: string }>(
      `${basePath(channel)}/trash/${encodeURIComponent(key)}/restore`,
    ),
  /** 永久删除（不可逆，后端强制 confirm:true——与前端 danger 二次确认对齐） */
  purge: (channel: TrashChannel, key: string) =>
    client.delete<{ ok: boolean; error?: string }>(
      `${basePath(channel)}/trash/${encodeURIComponent(key)}`,
      { data: { confirm: true } },
    ),
  /** 清空（不可逆，同上双确认） */
  clear: (channel: TrashChannel) =>
    client.post<{ ok: boolean; removed: number; error?: string }>(
      `${basePath(channel)}/trash/clear`,
      { confirm: true },
    ),
}
