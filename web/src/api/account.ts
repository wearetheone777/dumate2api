export interface InstallCheck {
  key: string
  label: string
  path: string
  kind: 'file' | 'dir'
  exists: boolean
  size: number | null
}

export interface ClientVersion {
  file_version: string
  product_version: string
  company: string
}

export interface LoginAccount {
  name: string
  user_id: string
  account_id: string
  login_type: string
  last_login: number
  age_days: number | null
  active: boolean
  has_credentials: boolean
  state: 'active' | 'stale'
}

export interface LoginState {
  ok: boolean
  reason?: string
  file?: string
  file_stat?: { size: number; mtime: number } | null
  has_top_level_cookies?: boolean
  cookie_key_present?: boolean
  active_provider?: string
  accounts?: LoginAccount[]
}

export interface ProcInfo {
  pid: number
  name: string
  port: number | null
  managed_by_proxy: boolean | null
}

export interface AccountData {
  install: { dir: string; checks: InstallCheck[]; platform_note?: string }
  version: ClientVersion | null
  login: LoginState
  processes: ProcInfo[]
  upstream: { port: number | null; managed_port: number; is_managed: boolean }
  readonly_note: string
}
