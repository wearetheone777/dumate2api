// web/src/api/agentsetup.ts - 智能体一键配置的接口封装
//
// 后端直写本机 Claude Code（~/.claude/settings.json）与 Codex CLI
// （~/.codex/config.toml），写前自动备份、一键还原。响应不回显 token。
import client from './client'

export interface SetupClient {
  id: string
  name: string
  /** 配置文件绝对路径 */
  configPath: string
  /** 配置文件当前是否存在（不存在 = 客户端的默认位置还没被创建） */
  configExists: boolean
  /** 是否已经指向本网关（Claude 比对 env.ANTHROPIC_BASE_URL；Codex 看托管 provider 表） */
  configured: boolean
  /** Claude Code 已配置的 base_url（未配置时为空串） */
  baseUrl?: string
  detail: string
}

export interface SetupClientsData {
  ok: boolean
  clients: SetupClient[]
  /** 网关根地址（写入配置用的 base） */
  gateway: string
  note: string
}

export interface SetupDerived {
  context_window: number | null
  compact_limit: number | null
  max_output: number | null
  rule: string
  notes: string[]
}

export interface SetupApplyResult {
  ok: boolean
  client: string
  configPath: string
  /** 写入前的备份文件；空串 = 原本没有配置文件（无从备份） */
  backup: string
  channel: string
  gateway: string
  model: string
  derived: SetupDerived
  accountNote?: string
  note: string
  error?: string
}

export interface SetupRestoreResult {
  ok: boolean
  client: string
  configPath: string
  restoredFrom: string
  at: number
  error?: string
}

export const agentSetupApi = {
  clients() {
    return client.get<SetupClientsData>('/agent-setup/clients')
  },

  /** 写入配置。token 留空时后端写 'nokey' 占位（鉴权已强制，实际请求会被 401） */
  apply(params: { client: string; channel: string; token?: string }) {
    return client.post<SetupApplyResult>('/agent-setup/apply', params)
  },

  restore(clientId: string) {
    return client.post<SetupRestoreResult>('/agent-setup/restore', { client: clientId })
  },
}
