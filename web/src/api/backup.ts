// web/src/api/backup.ts - 备份分区表（批次十五，后端批次十四）
import client from '@/api/client'

/** GET /backup/sections 的一行：一个可备份类型（后端 SECTION_TABLE 的投影） */
export interface BackupSectionRow {
  id: string
  label: string
  kind: 'accounts' | 'object'
  sensitive: boolean
  exists: boolean
  count: number
  updatedAt: number | null
}

/** 单分区合并计数（预览与导入同源；conflictKeys 是命中身份/键名的清单） */
export interface BackupSectionResult {
  ok: boolean
  added: number
  overwritten: number
  skipped: number
  conflicts: number
  conflictKeys?: string[]
  error?: string
}

/** 导出信封（format/version 由后端定案；这里只声明消费侧需要的形状） */
export interface BackupEnvelope {
  format: 'dumate2api-backup'
  version: number
  app: string
  generatedAt: string
  includeCredentials: boolean
  sections: Record<string, { data: unknown; redacted: boolean }>
}

export const backupApi = {
  sections: () =>
    client.get<{ ok: boolean; sections: BackupSectionRow[] }>('/backup/sections'),
  /** 导出。sensitive 分区必须 includeCredentials+confirm（双确认），否则 400 */
  exportBackup: (sections: string[], includeCredentials: boolean, confirm: boolean) =>
    client.post<{ ok: boolean; envelope: BackupEnvelope; error?: string }>('/backup/export', {
      sections,
      includeCredentials,
      confirm,
    }),
  /** 导入预览：与导入同一份 merge 实现，只算不写（零写盘） */
  preview: (envelope: BackupEnvelope, policy: 'keepLocal' | 'overwrite' | 'keepBoth') =>
    client.post<{
      ok: boolean
      policy: string
      write: false
      results: Record<string, BackupSectionResult>
      ignored?: string[]
      error?: string
    }>('/backup/preview', { envelope, policy }),
  /** 执行导入：merge 后落盘 */
  importBackup: (envelope: BackupEnvelope, policy: 'keepLocal' | 'overwrite' | 'keepBoth') =>
    client.post<{
      ok: boolean
      policy: string
      write: true
      results: Record<string, BackupSectionResult>
      ignored?: string[]
      error?: string
    }>('/backup/import', { envelope, policy }),
}
