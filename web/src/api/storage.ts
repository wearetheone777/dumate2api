// web/src/api/storage.ts - 存储管理（批次十七，后端 src/admin/routes/storage.js）
import client from '@/api/client'

export type StorageCategoryId = 'credentials' | 'config' | 'logs' | 'cache' | 'other'

/** data/ 目录一个条目（文件或目录）；deletable 只有 logs/cache 两类的普通文件为 true */
export interface StorageFileRow {
  name: string
  bytes: number
  files: number
  mtimeMs: number | null
  isDir: boolean
  category: StorageCategoryId
  deletable: boolean
  note: string
}

export interface StorageCategory {
  id: StorageCategoryId
  label: string
  deletable: boolean
  bytes: number
  files: number
  count: number
}

export interface StorageSnapshot {
  ok: boolean
  generatedAt: number
  dataDir: string
  ttlMs: number
  cached: boolean
  totals: { bytes: number; files: number }
  deletableBytes: number
  categories: StorageCategory[]
  files: StorageFileRow[]
  warnings: string[]
}

export interface CleanupItem {
  name: string
  bytes: number
  category: StorageCategoryId
  note: string
}

export interface CleanupRefused {
  name: string
  reason: string
}

export const storageApi = {
  /** 扫描（60s 快照；refresh=1 强制重扫） */
  scan: (refresh: boolean) =>
    client.get<StorageSnapshot>('/storage/scan', { params: refresh ? { refresh: 1 } : {} }),
  /** 预览：零写盘，返回将删清单 + 拒绝清单（含原因） */
  preview: (names: string[]) =>
    client.post<{ ok: boolean; items: CleanupItem[]; refused: CleanupRefused[]; totalBytes: number; write: false }>(
      '/storage/cleanup/preview',
      { names },
    ),
  /** 执行清理（不可逆，后端强制 confirm:true） */
  cleanup: (names: string[]) =>
    client.post<{ ok: boolean; removed: CleanupItem[]; failed: CleanupRefused[]; refused: CleanupRefused[]; freedBytes: number }>(
      '/storage/cleanup',
      { names, confirm: true },
    ),
}
