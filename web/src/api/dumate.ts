import client from './client'

// 搭子网页端只读查询（后端 src/dumate-web-api.js，路由 /api/admin/dumate/*）：
// 会话 / 项目 / MCP connector。全部是 www.dumate.cn 的网页接口（不是模型网关），
// 只读、不消耗额度、不改变账号状态。字段形状以后端归一化函数为准。

export interface DumateSession {
  id: string | null
  title: string | null
  /** 上游给的是**发起那台机器的本机路径**，换机器就失效——仅作展示 */
  directory: string | null
  projectId: string | null
  slug: string | null
  type: string | null
  source: string | null
  execEnv: string | null
  autoModelLevel: string | null
  isPinned: boolean | null
  isSubagent: boolean | null
  created: number | null
  updated: number | null
  summary: { additions: number | null; deletions: number | null; files: number | null } | null
}

export interface DumateConnector {
  id: string | null
  code: string | null
  name: string | null
  remark: string | null
  source: string | null
  connectionStatus: string | null
  enabled: boolean | null
  transProtocol: string | null
  serverUrl: string | null
  icon: string | null
}

export interface DumateSessionsResp {
  ok: boolean
  sessions: DumateSession[]
  account?: string
  error?: string
}

export interface DumateProjectsResp {
  ok: boolean
  projects: Array<Record<string, unknown>>
  total: number
  account?: string
  error?: string
}

export interface DumateConnectorsResp {
  ok: boolean
  connectors: DumateConnector[]
  total: number
  account?: string
  error?: string
}

export interface DumateTemplatesResp {
  ok: boolean
  templates: DumateConnector[]
  total: number
  account?: string
  error?: string
}

export const dumateApi = {
  sessions: () => client.get<DumateSessionsResp>('/dumate/sessions').then((r) => r.data),
  projects: () => client.get<DumateProjectsResp>('/dumate/projects').then((r) => r.data),
  connectors: () => client.get<DumateConnectorsResp>('/dumate/connectors').then((r) => r.data),
  connectorTemplates: () => client.get<DumateTemplatesResp>('/dumate/connectors/templates').then((r) => r.data),
  // 本地会话工作目录（dir = session 的 directory；file 省略 = 列目录）
  localFiles: (dir: string) =>
    client.get(`/dumate/local-files?dir=${encodeURIComponent(dir)}`).then((r) => r.data as {
      ok: boolean; dir?: string; entries?: LocalFileEntry[]; error?: string
    }),
  readLocalFile: (dir: string, file: string) =>
    client.get(`/dumate/local-files?dir=${encodeURIComponent(dir)}&file=${encodeURIComponent(file)}`).then((r) => r.data as {
      ok: boolean; name?: string; text?: string; error?: string
    }),
}

export interface LocalFileEntry {
  name: string
  is_dir: boolean
  readable: boolean
  size: number
  mtime: number
}
