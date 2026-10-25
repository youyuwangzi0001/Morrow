import type { ModelInfo, ProviderConfig } from './types'

/** 订阅接入页面的公共契约；不把明文 token 暴露给渲染层。 */

export type SubscriptionProtocol = 'openai-compat' | 'anthropic'

export interface SubscriptionQuotaWindow {
  label: string
  usedPercent: number
  /** 窗口长度（秒）；上游未提供时省略 */
  windowSeconds?: number
  /** 重置时间（epoch ms） */
  resetAt?: number
}

export interface CodexSubscriptionAccount {
  email?: string
  plan?: string
  accountId?: string
  /** access token 的过期时间（epoch ms） */
  expiresAt?: number
  source?: 'codex-cli' | 'oauth'
}

export interface CodexSubscriptionQuota {
  plan?: string
  email?: string
  windows: SubscriptionQuotaWindow[]
  credits?: {
    hasCredits: boolean
    unlimited: boolean
    balance?: number
  }
  fetchedAt: number
  message?: string
}

export interface CodexSubscriptionState {
  available: boolean
  connected: boolean
  providerId?: string
  account?: CodexSubscriptionAccount
  quota?: CodexSubscriptionQuota
  models: ModelInfo[]
  enabled: boolean
  sourcePath?: string
  error?: string
}

export interface CustomSubscriptionRecord {
  id: string
  name: string
  protocol: SubscriptionProtocol
  baseUrl: string
  providerId: string
  models: string[]
  createdAt: number
}

export interface CustomSubscriptionState {
  record: CustomSubscriptionRecord
  provider?: ProviderConfig
  connected: boolean
  error?: string
}


export interface QoderQuotaBucket {
  kind: 'personal' | 'add-on' | 'org'
  total?: number
  used?: number
  remaining?: number
  unit?: string
}

export interface QoderSubscriptionAccount {
  email?: string
  name?: string
  uid?: string
  region: 'global' | 'cn'
  expiresAt?: number
  source?: 'pat' | 'device' | 'local'
  sourcePath?: string
}

export interface QoderSubscriptionQuota {
  buckets: QoderQuotaBucket[]
  expiresAt?: number
  fetchedAt: number
  message?: string
}

export interface QoderSubscriptionState {
  available: boolean
  connected: boolean
  providerId?: string
  account?: QoderSubscriptionAccount
  quota?: QoderSubscriptionQuota
  models: ModelInfo[]
  enabled: boolean
  patUrl: string
  localImport?: { available: boolean; path: string }
  error?: string
}

export type AgentSubscriptionId =
  | 'kimi'
  | 'glm'
  | 'minimax'
  | 'step'
  | 'command-code'
  | 'cline'
  | 'antigravity'
  | 'opencode'

export interface AgentQuotaWindow {
  id: string
  label: string
  usedPercent?: number
  used?: number
  total?: number
  remaining?: number
  unit?: string
  resetAt?: number
}

export interface AgentSubscriptionAccount {
  email?: string
  name?: string
  uid?: string
  plan?: string
  region?: string
  expiresAt?: number
  source?: string
  sourcePath?: string
}

export interface AgentSubscriptionQuota {
  windows: AgentQuotaWindow[]
  fetchedAt: number
  message?: string
}

export interface AgentSubscriptionState {
  id: AgentSubscriptionId
  name: string
  connected: boolean
  providerId?: string
  account?: AgentSubscriptionAccount
  quota?: AgentSubscriptionQuota
  models: ModelInfo[]
  enabled: boolean
  login: 'device' | 'oauth' | 'token' | 'local' | 'browser'
  /** 登录页可选的区域；缺省表示该渠道没有区域选择。 */
  regionOptions?: { value: string; label: string }[]
  defaultRegion?: string
  /** 可直接粘贴的长期密钥（API key / PAT）；存在时设置页显示输入框。 */
  tokenLogin?: { label: string; placeholder: string; help?: string }
  localImport?: { available: boolean; path: string }
  error?: string
}

export interface SubscriptionStatus {
  codex: CodexSubscriptionState
  qoder?: QoderSubscriptionState
  agents?: AgentSubscriptionState[]
  custom: CustomSubscriptionState[]
  disclaimer: string
}

export interface CustomSubscriptionInput {
  id?: string
  name: string
  protocol: SubscriptionProtocol
  baseUrl: string
  apiKey: string
  models: string[]
}

export type SubscriptionAction =
  | { action: 'import-codex'; path?: string }
  | { action: 'login-codex' }
  | { action: 'refresh-codex' }
  | { action: 'remove-codex' }
  | { action: 'set-codex-enabled'; enabled: boolean }
  | { action: 'test-codex' }
  | { action: 'login-qoder'; pat: string; region: 'global' | 'cn' }
  | { action: 'login-qoder-device' }
  | { action: 'import-qoder-local' }
  | { action: 'refresh-qoder' }
  | { action: 'remove-qoder' }
  | { action: 'test-qoder' }
  | { action: 'set-qoder-enabled'; enabled: boolean }
  | { action: 'set-qoder-context'; modelId: string; contextWindow: number }
  | { action: 'login-agent'; id: AgentSubscriptionId; region?: string }
  | { action: 'login-agent-token'; id: AgentSubscriptionId; token: string; region?: string }
  | { action: 'import-agent-local'; id: AgentSubscriptionId }
  | { action: 'refresh-agent'; id: AgentSubscriptionId }
  | { action: 'remove-agent'; id: AgentSubscriptionId }
  | { action: 'test-agent'; id: AgentSubscriptionId }
  | { action: 'set-agent-enabled'; id: AgentSubscriptionId; enabled: boolean }
  | { action: 'add-custom'; input: CustomSubscriptionInput }
  | { action: 'update-custom'; input: CustomSubscriptionInput }
  | { action: 'remove-custom'; id: string }
  | { action: 'test-custom'; id: string }
  | { action: 'set-custom-enabled'; id: string; enabled: boolean }

export interface SubscriptionTestResult {
  ok: boolean
  latencyMs: number
  message: string
}
