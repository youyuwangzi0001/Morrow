// connectors 功能域逻辑：由 1 个 TS 文件扁平合并。
import type { Result } from '@shared/types'
import type { ConnectorCatalogEntry, ConnectorRuntimeStatus } from '@shared/contracts'

export const CONNECTOR_CHANNELS = {
  list: 'feature:connectors:list',
  get: 'feature:connectors:get',
  save: 'feature:connectors:save',
  delete: 'feature:connectors:delete',
  setEnabled: 'feature:connectors:set-enabled',
  test: 'feature:connectors:test',
  tools: 'feature:connectors:tools',
  catalog: 'feature:connectors:catalog',
  runtime: 'feature:connectors:runtime',
  install: 'feature:connectors:install',
  paths: 'feature:connectors:paths',
  trustWorkspace: 'feature:connectors:trust-workspace',
  secretStatus: 'feature:connectors:secret-status',
  oauthStart: 'feature:connectors:oauth-start',
  oauthStatus: 'feature:connectors:oauth-status',
  oauthRevoke: 'feature:connectors:oauth-revoke',
  oauthEvent: 'feature:connectors:oauth'
} as const

export type ConnectorScope = 'user' | 'workspace'

export type ConnectorTransport = 'stdio' | 'http' | 'sse'

export type SecretStorageMode = 'encrypted' | 'plaintext-fallback'

export interface ConnectorSecretField {
  key: string
  masked: string
  hasSecret: boolean
  plaintext: boolean
}

export interface ConnectorOAuthInput {
  authorizationUrl: string
  tokenUrl: string
  clientId: string
  scopes?: string[]
}

export interface ConnectorOAuthStatus {
  configured: boolean
  authorized: boolean
  expiresAt: number | null
  hasRefreshToken: boolean
  expired: boolean
}

export interface ConnectorView {
  scope: ConnectorScope
  name: string
  transport: ConnectorTransport
  enabled: boolean
  description?: string
  timeoutMs?: number
  retries?: number
  allowPrivateNetwork: boolean
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  oauth?: ConnectorOAuthInput
  env: ConnectorSecretField[]
  headers: ConnectorSecretField[]
  configPath: string
  warnings: string[]
  secretStorage: SecretStorageMode
}

export interface WorkspaceTrustSummary {
  workspace: string
  trusted: boolean
  hash: string
  configPath: string
}

export interface ConnectorListResult {
  scope: ConnectorScope
  configPath: string
  secretsMode: SecretStorageMode
  connectors: ConnectorView[]
  warnings: string[]
  workspaceTrust?: WorkspaceTrustSummary
}

export interface ConnectorToolInfo {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
}

export interface ConnectorResourceInfo {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export interface ConnectorResourceTemplateInfo {
  uriTemplate: string
  name?: string
  description?: string
  mimeType?: string
}

export interface ConnectorPromptArgument {
  name: string
  description?: string
  required?: boolean
}

export interface ConnectorPromptInfo {
  name: string
  description?: string
  arguments?: ConnectorPromptArgument[]
}

export interface ConnectorTestResult {
  ok: boolean
  transport: ConnectorTransport
  latencyMs: number
  tools?: ConnectorToolInfo[]
  resources?: { supported: boolean; resources: ConnectorResourceInfo[]; templates: ConnectorResourceTemplateInfo[] }
  prompts?: { supported: boolean; prompts: ConnectorPromptInfo[] }
  error?: string
  hint?: string
  blockedReason?: 'ssrf-blocked' | 'invalid-config' | 'timeout' | 'network' | 'http-status' | 'protocol' | 'auth'
  warnings?: string[]
}

export interface ConnectorCatalogInstallResult {
  saved: boolean
  view?: ConnectorView
  test?: ConnectorTestResult
}

export type { ConnectorCatalogEntry, ConnectorRuntimeStatus }

export interface ConnectorPaths {
  dataDir: string
  userConfigPath: string
  secretsPath: string
  trustPath: string
  workspaceConfigPath: string | null
  secretStorage: SecretStorageMode
}

export interface ConnectorSecretInput {
  key: string
  /** 新值（明文，只发一次）；不传 = 保持已保存的密钥 */
  value?: string
}

export interface ConnectorSavePayload {
  scope: ConnectorScope
  workspace?: string | null
  originalName?: string
  name: string
  transport: ConnectorTransport
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  env?: ConnectorSecretInput[]
  headers?: ConnectorSecretInput[]
  timeoutMs?: number
  retries?: number
  allowPrivateNetwork?: boolean
  description?: string
  enabled?: boolean
  oauth?: ConnectorOAuthInput | null
}

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const result = (await window.morrow.features.invoke<T>(channel, payload)) as Result<T>
  if (!result.ok) {
    const hint = result.error.hint ? `（${result.error.hint}）` : ''
    throw new Error(`${result.error.message}${hint}`)
  }
  return result.data
}

export const connectorsApi = {
  list: (scope: ConnectorScope, workspace?: string | null): Promise<ConnectorListResult> =>
    invoke<ConnectorListResult>(CONNECTOR_CHANNELS.list, { scope, ...(workspace ? { workspace } : {}) }),

  save: (payload: ConnectorSavePayload): Promise<{ connector: ConnectorView; warnings: string[]; secretStorage: SecretStorageMode }> =>
    invoke(CONNECTOR_CHANNELS.save, payload as unknown as Record<string, unknown>),

  remove: (
    scope: ConnectorScope,
    name: string,
    workspace?: string | null
  ): Promise<{ deleted: boolean; removedSecrets: number }> =>
    invoke(CONNECTOR_CHANNELS.delete, { scope, name, ...(workspace ? { workspace } : {}) }),

  setEnabled: (scope: ConnectorScope, name: string, enabled: boolean, workspace?: string | null): Promise<ConnectorView> =>
    invoke(CONNECTOR_CHANNELS.setEnabled, { scope, name, enabled, ...(workspace ? { workspace } : {}) }),

  test: (options: {
    scope: ConnectorScope
    workspace?: string | null
    name?: string
    draft?: Record<string, unknown>
  }): Promise<ConnectorTestResult> => invoke(CONNECTOR_CHANNELS.test, options),

  catalog: (): Promise<{ entries: ConnectorCatalogEntry[] }> => invoke(CONNECTOR_CHANNELS.catalog, {}),

  runtime: (force = false): Promise<ConnectorRuntimeStatus> =>
    invoke<ConnectorRuntimeStatus>(CONNECTOR_CHANNELS.runtime, { force }),

  install: (options: {
    scope: ConnectorScope
    workspace?: string | null
    id: string
    token?: string
    folder?: string
    test: boolean
  }): Promise<ConnectorCatalogInstallResult> => invoke(CONNECTOR_CHANNELS.install, options),

  paths: (workspace?: string | null): Promise<ConnectorPaths> =>
    invoke(CONNECTOR_CHANNELS.paths, workspace ? { workspace } : {}),

  trustWorkspace: (workspace: string): Promise<WorkspaceTrustSummary> =>
    invoke(CONNECTOR_CHANNELS.trustWorkspace, { workspace }),

  secretStatus: (): Promise<{ mode: SecretStorageMode; secretsPath: string }> =>
    invoke(CONNECTOR_CHANNELS.secretStatus, {}),

  oauthStart: (scope: ConnectorScope, name: string, workspace?: string | null): Promise<{ authorizationUrl: string; redirectUri: string }> =>
    invoke(CONNECTOR_CHANNELS.oauthStart, { scope, name, ...(workspace ? { workspace } : {}) }),

  oauthStatus: (scope: ConnectorScope, name: string, workspace?: string | null): Promise<ConnectorOAuthStatus> =>
    invoke(CONNECTOR_CHANNELS.oauthStatus, { scope, name, ...(workspace ? { workspace } : {}) }),

  oauthRevoke: (scope: ConnectorScope, name: string, workspace?: string | null): Promise<{ removed: boolean }> =>
    invoke(CONNECTOR_CHANNELS.oauthRevoke, { scope, name, ...(workspace ? { workspace } : {}) })
}
