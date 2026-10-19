/**
 * R10-G 连接器面板的渲染层 API 封装。
 *
 * 与主进程 `src/main/features/connectors.ts` 的 `feature:connectors:*` 契约一一对应。
 * 只通过 window.morrow.features.invoke 走窄 IPC；不直接 import 主进程代码（避免把 electron 带进 renderer）。
 * 所有返回值都是「已脱敏视图」：env/headers 只有 key + 掩码，没有明文密钥。
 */
import type { Result } from '@shared/types'

export const CONNECTOR_CHANNELS = {
  list: 'feature:connectors:list',
  get: 'feature:connectors:get',
  save: 'feature:connectors:save',
  delete: 'feature:connectors:delete',
  setEnabled: 'feature:connectors:set-enabled',
  test: 'feature:connectors:test',
  tools: 'feature:connectors:tools',
  templates: 'feature:connectors:templates',
  paths: 'feature:connectors:paths',
  trustWorkspace: 'feature:connectors:trust-workspace',
  secretStatus: 'feature:connectors:secret-status'
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

export interface ConnectorTestResult {
  ok: boolean
  transport: ConnectorTransport
  latencyMs: number
  tools?: ConnectorToolInfo[]
  error?: string
  hint?: string
  blockedReason?: 'ssrf-blocked' | 'invalid-config' | 'timeout' | 'network' | 'http-status' | 'protocol' | 'auth'
  warnings?: string[]
}

export interface ConnectorTemplate {
  id: string
  name: string
  transport: ConnectorTransport
  description: string
  exampleOnly: true
  command?: string
  args?: string[]
  url?: string
  headerKeys?: string[]
  notes?: string[]
}

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

  templates: (): Promise<ConnectorTemplate[]> => invoke(CONNECTOR_CHANNELS.templates, {}),

  paths: (workspace?: string | null): Promise<ConnectorPaths> =>
    invoke(CONNECTOR_CHANNELS.paths, workspace ? { workspace } : {}),

  trustWorkspace: (workspace: string): Promise<WorkspaceTrustSummary> =>
    invoke(CONNECTOR_CHANNELS.trustWorkspace, { workspace }),

  secretStatus: (): Promise<{ mode: SecretStorageMode; secretsPath: string }> =>
    invoke(CONNECTOR_CHANNELS.secretStatus, {})
}
