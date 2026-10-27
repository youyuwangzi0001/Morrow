/**
 * R10-G 连接器管理 IPC（`feature:connectors:*`）。
 *
 * 由 Lead 在 src/main/features/index.ts 里 `import './connectors'` 挂载（import 即注册）。
 * renderer 通过 window.morrow.features.invoke('feature:connectors:xxx', payload) 调用，
 * 统一返回 Result<T>；本模块只负责参数校验 + 转调 mcp-service，不直接碰 IPC 详情。
 *
 * 安全：
 * - 所有频道都只接受已注册的精确名称；
 * - 参数在边界处校验（字符串长度、枚举、数组上限），非法参数直接抛错；
 * - 返回给渲染层的连接器视图已掩码（没有明文密钥），也没有任意文件读写入口；
 * - 测试连接是用户显式动作，仍走 URL 协议 + SSRF 校验后再真实连接。
 */
import { registerFeatureHandler } from '../feature-ipc'
import { resolveWorkspaceDir } from './workspace-roots'
import type {
  ConnectorSaveInput,
  ConnectorScope,
  ConnectorSecretInput
} from '../services/mcp-service'
import {
  deleteConnector,
  getConnector,
  getConnectorCatalog,
  getConnectorPaths,
  connectorOAuthStatus,
  detectConnectorRuntime,
  installCatalogConnector,
  revokeConnectorOAuth,
  startConnectorOAuth,
  listConnectorTools,
  listConnectors,
  saveConnector,
  setConnectorEnabled,
  testConnector,
  trustWorkspaceConfig
} from '../services/mcp-service'

/** 频道清单：Lead 集成/测试/文档共用（避免手写字符串漂移） */
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
  oauthRevoke: 'feature:connectors:oauth-revoke'
} as const

export type ConnectorChannel = (typeof CONNECTOR_CHANNELS)[keyof typeof CONNECTOR_CHANNELS]

function asRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('参数格式错误：payload 必须是一个对象。')
  }
  return payload as Record<string, unknown>
}

function readScope(payload: Record<string, unknown>): ConnectorScope {
  if (payload.scope === 'workspace') return 'workspace'
  if (payload.scope === 'user' || payload.scope === undefined || payload.scope === null) return 'user'
  throw new Error('scope 只能是 "user" 或 "workspace"。')
}

function readWorkspace(payload: Record<string, unknown>, scope: ConnectorScope): string | null {
  if (scope !== 'workspace') return null
  const workspace = payload.workspace
  if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('工作区级连接器需要 workspace 路径。')
  if (workspace.length > 4096) throw new Error('workspace 路径过长。')
  return resolveWorkspaceDir(workspace, '工作区级连接器只能操作已登记的工作区。')
}

function readString(payload: Record<string, unknown>, key: string, options: { required?: boolean; max?: number } = {}): string | undefined {
  const value = payload[key]
  if (value === undefined || value === null || value === '') {
    if (options.required) throw new Error(`缺少必填参数「${key}」。`)
    return undefined
  }
  if (typeof value !== 'string') throw new Error(`参数「${key}」应该是字符串。`)
  const trimmed = value.trim()
  if (options.required && !trimmed) throw new Error(`参数「${key}」不能为空。`)
  if (options.max && trimmed.length > options.max) throw new Error(`参数「${key}」过长（上限 ${options.max} 字符）。`)
  return trimmed
}

function readNumber(payload: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = payload[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`参数「${key}」应该是数字。`)
  if (value < min || value > max) throw new Error(`参数「${key}」超出范围（${min}–${max}）。`)
  return value
}

function readBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`参数「${key}」应该是布尔值。`)
  return value
}

function readStringArray(payload: Record<string, unknown>, key: string, maxItems = 64, maxLength = 4096): string[] | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    // 兼容 UI 多行文本：按行切分，忽略空行
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, maxItems)
      .map((line) => {
        if (line.length > maxLength) throw new Error(`args 单行过长（上限 ${maxLength} 字符）。`)
        return line
      })
  }
  if (!Array.isArray(value)) throw new Error(`参数「${key}」应该是字符串数组。`)
  if (value.length > maxItems) throw new Error(`参数「${key}」数量过多（上限 ${maxItems}）。`)
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error(`参数「${key}」数组里只能包含字符串。`)
    if (item.length > maxLength) throw new Error(`参数「${key}」单个元素过长（上限 ${maxLength} 字符）。`)
    return item
  })
}

function readSecretFields(payload: Record<string, unknown>, key: 'env' | 'headers'): ConnectorSecretInput[] | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error(`参数「${key}」应该是数组。`)
  if (value.length > 64) throw new Error(`参数「${key}」条目过多（上限 64 个）。`)
  const fields: ConnectorSecretInput[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`参数「${key}」的每一项都应该是对象。`)
    const record = item as Record<string, unknown>
    if (typeof record.key !== 'string' || !record.key.trim()) throw new Error(`参数「${key}」的 key 不能为空。`)
    if (record.value !== undefined && record.value !== null && typeof record.value !== 'string') {
      throw new Error(`参数「${key}.${record.key}」的 value 应该是字符串。`)
    }
    if (typeof record.value === 'string' && record.value.length > 8192) throw new Error(`参数「${key}.${record.key}」的 value 过长。`)
    fields.push({ key: record.key.trim(), ...(typeof record.value === 'string' ? { value: record.value } : {}) })
  }
  return fields
}

function readSaveInput(payload: Record<string, unknown>, scope: ConnectorScope, workspace: string | null): ConnectorSaveInput {
  const transportRaw = payload.transport
  if (transportRaw !== undefined && transportRaw !== null && transportRaw !== 'stdio' && transportRaw !== 'http' && transportRaw !== 'sse' && transportRaw !== 'streamable-http') {
    throw new Error('transport 只能是 stdio / http / sse。')
  }
  const env = readSecretFields(payload, 'env')
  const headers = readSecretFields(payload, 'headers')
  let oauth: ConnectorSaveInput['oauth']
  if (payload.oauth === null) {
    oauth = null
  } else if (payload.oauth !== undefined) {
    const raw = payload.oauth
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('参数「oauth」应该是一个对象或 null。')
    const record = raw as Record<string, unknown>
    const authorizationUrl = readString(record, 'authorizationUrl', { max: 2048 })
    const tokenUrl = readString(record, 'tokenUrl', { max: 2048 })
    const clientId = readString(record, 'clientId', { max: 300 })
    if (authorizationUrl || tokenUrl || clientId) {
      if (!authorizationUrl || !tokenUrl || !clientId) {
        throw new Error('OAuth 需要同时提供 authorizationUrl、tokenUrl 与 clientId。')
      }
      oauth = {
        authorizationUrl,
        tokenUrl,
        clientId,
        ...(readStringArray(record, 'scopes') ? { scopes: readStringArray(record, 'scopes')!.slice(0, 20) } : {})
      }
    }
  }
  return {
    scope,
    ...(workspace ? { workspace } : {}),
    ...(typeof payload.originalName === 'string' && payload.originalName.trim() ? { originalName: payload.originalName.trim() } : {}),
    name: readString(payload, 'name', { required: true, max: 64 }) as string,
    ...(transportRaw ? { transport: transportRaw as ConnectorSaveInput['transport'] } : {}),
    ...(readString(payload, 'command', { max: 1024 }) ? { command: readString(payload, 'command', { max: 1024 }) } : {}),
    ...(readStringArray(payload, 'args') ? { args: readStringArray(payload, 'args') } : {}),
    ...(readString(payload, 'cwd', { max: 4096 }) ? { cwd: readString(payload, 'cwd', { max: 4096 }) } : {}),
    ...(readString(payload, 'url', { max: 2048 }) ? { url: readString(payload, 'url', { max: 2048 }) } : {}),
    ...(readString(payload, 'description', { max: 500 }) ? { description: readString(payload, 'description', { max: 500 }) } : {}),
    ...(env ? { env } : {}),
    ...(headers ? { headers } : {}),
    ...(readNumber(payload, 'timeoutMs', 250, 120_000) !== undefined ? { timeoutMs: readNumber(payload, 'timeoutMs', 250, 120_000) } : {}),
    ...(readNumber(payload, 'retries', 0, 5) !== undefined ? { retries: readNumber(payload, 'retries', 0, 5) } : {}),
    ...(readBoolean(payload, 'allowPrivateNetwork') !== undefined ? { allowPrivateNetwork: readBoolean(payload, 'allowPrivateNetwork') } : {}),
    ...(readBoolean(payload, 'enabled') !== undefined ? { enabled: readBoolean(payload, 'enabled') } : {}),
    ...(oauth !== undefined ? { oauth } : {})
  }
}

registerFeatureHandler(CONNECTOR_CHANNELS.list, (payload) => {
  const record = asRecord(payload)
  const scope = readScope(record)
  return listConnectors(scope, readWorkspace(record, scope))
})

registerFeatureHandler(CONNECTOR_CHANNELS.get, (payload) => {
  const record = asRecord(payload)
  const scope = readScope(record)
  const name = readString(record, 'name', { required: true, max: 64 }) as string
  return getConnector(scope, name, readWorkspace(record, scope))
})

registerFeatureHandler(CONNECTOR_CHANNELS.save, (payload) => {
  const record = asRecord(payload)
  const scope = readScope(record)
  return saveConnector(readSaveInput(record, scope, readWorkspace(record, scope)))
})

registerFeatureHandler(CONNECTOR_CHANNELS.delete, (payload) => {
  const record = asRecord(payload)
  const scope = readScope(record)
  const name = readString(record, 'name', { required: true, max: 64 }) as string
  return deleteConnector(scope, name, readWorkspace(record, scope))
})

registerFeatureHandler(CONNECTOR_CHANNELS.setEnabled, (payload) => {
  const record = asRecord(payload)
  const scope = readScope(record)
  const name = readString(record, 'name', { required: true, max: 64 }) as string
  const enabled = readBoolean(record, 'enabled')
  if (enabled === undefined) throw new Error('缺少必填参数「enabled」。')
  return setConnectorEnabled(scope, name, enabled, readWorkspace(record, scope))
})

registerFeatureHandler(CONNECTOR_CHANNELS.test, (payload) => {
  const record = asRecord(payload)
  const scope = readScope(record)
  const workspace = readWorkspace(record, scope)
  const name = readString(record, 'name', { max: 64 })
  const draft = record.draft
  if (!name && !draft) throw new Error('测试连接需要 name（已保存的连接器）或 draft（未保存的草稿）。')
  if (draft !== undefined && (!draft || typeof draft !== 'object' || Array.isArray(draft))) {
    throw new Error('参数「draft」应该是一个对象。')
  }
  return testConnector({
    scope,
    ...(workspace ? { workspace } : {}),
    ...(name ? { name } : {}),
    ...(draft ? { draft: draft as Record<string, unknown> } : {})
  })
})

registerFeatureHandler(CONNECTOR_CHANNELS.tools, (payload) => {
  const record = asRecord(payload)
  const scope = readScope(record)
  const name = readString(record, 'name', { required: true, max: 64 }) as string
  return listConnectorTools(scope, name, readWorkspace(record, scope))
})

registerFeatureHandler(CONNECTOR_CHANNELS.catalog, () => ({ entries: getConnectorCatalog() }))

registerFeatureHandler(CONNECTOR_CHANNELS.runtime, (payload) => {
  if (payload === undefined || payload === null) return detectConnectorRuntime()
  const record = asRecord(payload)
  if (record.force !== undefined && typeof record.force !== 'boolean') throw new Error('force 必须是布尔值。')
  return detectConnectorRuntime(record.force === true)
})

registerFeatureHandler(CONNECTOR_CHANNELS.install, async (payload) => {
  const record = asRecord(payload)
  const scope = readScope(record)
  const id = readString(record, 'id', { required: true, max: 64 }) as string
  const token = readString(record, 'token', { max: 8192 })
  const folder = readString(record, 'folder', { max: 4096 })
  if (record.test !== undefined && typeof record.test !== 'boolean') throw new Error('test 必须是布尔值。')
  return installCatalogConnector({
    scope,
    ...(scope === 'workspace' ? { workspace: readWorkspace(record, scope) } : {}),
    id,
    ...(token ? { token } : {}),
    ...(folder ? { folder } : {}),
    test: record.test !== false
  })
})

registerFeatureHandler(CONNECTOR_CHANNELS.paths, (payload) => {
  const record = asRecord(payload)
  const requested = typeof record.workspace === 'string' && record.workspace.trim() ? record.workspace.trim() : ''
  const workspace = requested ? resolveWorkspaceDir(requested, '连接器路径只能查看已登记的工作区。') : null
  return getConnectorPaths(workspace)
})

registerFeatureHandler(CONNECTOR_CHANNELS.trustWorkspace, (payload) => {
  const record = asRecord(payload)
  const workspace = readString(record, 'workspace', { required: true, max: 4096 }) as string
  return trustWorkspaceConfig(resolveWorkspaceDir(workspace, '只能信任已登记工作区的连接器配置。'))
})

registerFeatureHandler(CONNECTOR_CHANNELS.secretStatus, () => {
  const paths = getConnectorPaths()
  return { mode: paths.secretStorage, secretsPath: paths.secretsPath }
})

registerFeatureHandler(CONNECTOR_CHANNELS.oauthStart, (payload) => {
  const record = asRecord(payload)
  const scope = readScope(record)
  const name = readString(record, 'name', { required: true, max: 64 }) as string
  return startConnectorOAuth({ scope, name, workspace: readWorkspace(record, scope) })
})

registerFeatureHandler(CONNECTOR_CHANNELS.oauthStatus, (payload) => {
  const record = asRecord(payload)
  const scope = readScope(record)
  const name = readString(record, 'name', { required: true, max: 64 }) as string
  return connectorOAuthStatus(scope, name, readWorkspace(record, scope))
})

registerFeatureHandler(CONNECTOR_CHANNELS.oauthRevoke, (payload) => {
  const record = asRecord(payload)
  const scope = readScope(record)
  const name = readString(record, 'name', { required: true, max: 64 }) as string
  return { removed: revokeConnectorOAuth(scope, name, readWorkspace(record, scope)) }
})
