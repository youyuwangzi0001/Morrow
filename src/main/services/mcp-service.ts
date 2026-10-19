/**
 * MCP / 连接器服务（主进程）。
 *
 * 两部分职责：
 * 1) 运行时接线：把应用数据目录注入 core（MORROW_DATA_DIR），并注册 safeStorage 密钥解析器，
 *    让 core 里的 mcp_list / mcp_call 能解密配置中的 `$MORROW_SECRET:<id>` 标记。
 * 2) 连接器管理（R10-G）：用户级 `<dataDir>/mcp.json` 与工作区级 `<workspace>/.morrow/mcp.json`
 *    的读取 / 新增 / 编辑 / 删除 / 启停 / 测试连接 / 工具列表；密钥用 Electron safeStorage
 *    （Windows 上是 DPAPI）加密存到 `<dataDir>/mcp-secrets.json`，渲染层永远拿不到明文。
 *
 * 安全约束：
 * - 渲染层只拿到掩码视图（hasSecret + masked），没有 reveal 接口；
 * - 工作区级配置写入后登记 `<dataDir>/mcp-trust.json`（工作区路径 → 配置内容 sha256），
 *   只有哈希与当前文件完全一致才被 core 信任；仓库里改过配置就自动失效；
 * - 测试连接会真实发起 stdio/HTTP 请求（用户点击才执行），仍受 URL 协议 + SSRF 校验；
 * - 本文件只被 main 进程 / feature IPC 使用，不暴露给 renderer 任意路径读写。
 */
import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  createMcpConnection,
  loadMcpConfig,
  mcpConfigHash,
  MCP_LIMITS,
  MCP_SECRET_MARKER,
  normalizeMcpServerInput,
  setMcpSecretResolver,
  validateMcpServerUrl,
  type McpConnection,
  type McpServerConfig,
  type McpToolInfo,
  type McpTransportKind
} from '../../core/tools/mcp-tools'

/* ── 运行时信息（保持 R8 导出兼容） ───────────────────────────── */

export interface McpRuntimeInfo {
  /** 应用数据目录（= app.getPath('userData')，已按便携版规则设置） */
  dataDir: string
  /** 默认配置文件路径：<dataDir>/mcp.json */
  configPath: string
}

let cached: McpRuntimeInfo | null = null

/**
 * 把应用数据目录注入 core 的 MCP 配置发现逻辑（MORROW_DATA_DIR），并注册密钥解析器。
 * - 不传 dataDir 时使用 app.getPath('userData')（主进程已 setPath 为 resolveDataDir() 的结果）；
 * - 幂等，可安全重复调用；
 * - 只写环境变量/注册解析器，不启动任何 MCP 进程、不读配置文件。
 */
export function installMcpRuntimeEnv(env: NodeJS.ProcessEnv = process.env, dataDir?: string): McpRuntimeInfo {
  const resolved = (dataDir && dataDir.trim()) || app.getPath('userData')
  env.MORROW_DATA_DIR = resolved
  cached = { dataDir: resolved, configPath: join(resolved, 'mcp.json') }
  setMcpSecretResolver((id) => resolveStoredSecret(resolved, id))
  return cached
}

/** 最近一次 installMcpRuntimeEnv 的路径信息；未初始化时按 app.getPath('userData') 现算 */
export function getMcpRuntimeInfo(): McpRuntimeInfo {
  if (cached) return cached
  const dataDir = app.getPath('userData')
  return { dataDir, configPath: join(dataDir, 'mcp.json') }
}

/** 默认 MCP 配置文件路径（供设置页/诊断展示用） */
export function mcpConfigPath(): string {
  return getMcpRuntimeInfo().configPath
}

/* ── 密钥存储（safeStorage / DPAPI） ──────────────────────────── */

export type SecretStorageMode = 'encrypted' | 'plaintext-fallback'

export interface SecretCodec {
  mode: SecretStorageMode
  encrypt(plaintext: string): string
  decrypt(payload: string): string | null
}

let codecOverride: SecretCodec | null = null

/** 测试用：注入假的加密实现（避免依赖真实 Electron safeStorage） */
export function setSecretCodecForTest(codec: SecretCodec | null): void {
  codecOverride = codec
}

function getSecretCodec(): SecretCodec {
  if (codecOverride) return codecOverride
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return {
        mode: 'encrypted',
        encrypt: (plaintext) => safeStorage.encryptString(plaintext).toString('base64'),
        decrypt: (payload) => {
          try {
            return safeStorage.decryptString(Buffer.from(payload, 'base64'))
          } catch {
            return null
          }
        }
      }
    }
  } catch {
    // safeStorage 不可用（例如无 keyring 的 Linux）
  }
  return {
    mode: 'plaintext-fallback',
    encrypt: (plaintext) => `plain:${Buffer.from(plaintext, 'utf8').toString('base64')}`,
    decrypt: (payload) => {
      if (!payload.startsWith('plain:')) return null
      try {
        return Buffer.from(payload.slice('plain:'.length), 'base64').toString('utf8')
      } catch {
        return null
      }
    }
  }
}

interface SecretFile {
  version: 1
  mode: SecretStorageMode
  entries: Record<string, string>
}

function secretsPath(dataDir: string): string {
  return join(dataDir, 'mcp-secrets.json')
}

function readSecrets(dataDir: string): SecretFile {
  try {
    const raw = JSON.parse(readFileSync(secretsPath(dataDir), 'utf8')) as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>
      const entries =
        record.entries && typeof record.entries === 'object' && !Array.isArray(record.entries)
          ? (record.entries as Record<string, unknown>)
          : {}
      const clean: Record<string, string> = {}
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value === 'string') clean[key] = value
      }
      return {
        version: 1,
        mode: record.mode === 'plaintext-fallback' ? 'plaintext-fallback' : 'encrypted',
        entries: clean
      }
    }
  } catch {
    // 文件不存在/损坏：当作空存储（下次保存重建）
  }
  return { version: 1, mode: getSecretCodec().mode, entries: {} }
}

function writeSecrets(dataDir: string, file: SecretFile): void {
  mkdirSync(dataDir, { recursive: true })
  const target = secretsPath(dataDir)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, target)
}

/** core 注册的解析器：id → 明文；不存在/解密失败返回 null */
export function resolveStoredSecret(dataDir: string, id: string): string | null {
  const file = readSecrets(dataDir)
  const payload = file.entries[id]
  if (!payload) return null
  return getSecretCodec().decrypt(payload)
}

export interface SecretStoreStatus {
  mode: SecretStorageMode
  path: string
}

export function getSecretStoreStatus(): SecretStoreStatus {
  return { mode: getSecretCodec().mode, path: secretsPath(getMcpRuntimeInfo().dataDir) }
}

/* ── 工作区信任登记 ───────────────────────────────────────────── */

export interface WorkspaceTrustStatus {
  workspace: string
  trusted: boolean
  hash: string
  configPath: string
}

export function workspaceTrustStatus(workspace: string): WorkspaceTrustStatus {
  const dataDir = getMcpRuntimeInfo().dataDir
  const configPath = workspaceConfigPath(workspace)
  let hash = ''
  try {
    hash = mcpConfigHash(readFileSync(configPath, 'utf8'))
  } catch {
    hash = ''
  }
  let trusted = false
  if (hash) {
    try {
      const raw = JSON.parse(readFileSync(join(dataDir, 'mcp-trust.json'), 'utf8')) as unknown
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const entry = (raw as Record<string, unknown>)[workspace]
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          trusted = (entry as Record<string, unknown>).hash === hash
        }
      }
    } catch {
      trusted = false
    }
  }
  return { workspace, trusted, hash, configPath }
}

function registerWorkspaceTrust(workspace: string, content: string): void {
  const dataDir = getMcpRuntimeInfo().dataDir
  const path = join(dataDir, 'mcp-trust.json')
  const registry: Record<string, { hash: string; trustedAt: number }> = {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const record = value as Record<string, unknown>
          if (typeof record.hash === 'string') {
            registry[key] = { hash: record.hash, trustedAt: Number(record.trustedAt) || 0 }
          }
        }
      }
    }
  } catch {
    // 空登记表
  }
  registry[workspace] = { hash: mcpConfigHash(content), trustedAt: Date.now() }
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(path, JSON.stringify(registry, null, 2), 'utf8')
}

/** 用户在工作区面板里点「信任」：当前配置内容登记到信任表 */
export function trustWorkspaceConfig(workspace: string): WorkspaceTrustStatus {
  const content = readFileSync(workspaceConfigPath(workspace), 'utf8')
  registerWorkspaceTrust(workspace, content)
  return workspaceTrustStatus(workspace)
}

/* ── 配置文件读写 ─────────────────────────────────────────────── */

export type ConnectorScope = 'user' | 'workspace'

function currentDataDir(): string {
  return getMcpRuntimeInfo().dataDir
}

export function userConfigPath(): string {
  return join(currentDataDir(), 'mcp.json')
}

export function workspaceConfigPath(workspace: string): string {
  return join(workspace, '.morrow', 'mcp.json')
}

function configPathFor(scope: ConnectorScope, workspace?: string | null): string {
  if (scope === 'workspace') {
    if (!workspace || !workspace.trim()) throw new Error('工作区级连接器需要指定工作区路径。')
    return workspaceConfigPath(workspace)
  }
  return userConfigPath()
}

interface RawConfigFile {
  mcpServers: Record<string, unknown>
}

function readConfigFile(path: string): RawConfigFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      const servers = record.mcpServers
      if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
        return { mcpServers: servers as Record<string, unknown> }
      }
    }
  } catch {
    // 不存在/损坏 → 空配置（首次保存会重建）
  }
  return { mcpServers: {} }
}

function writeConfigFile(path: string, file: RawConfigFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

function writeConfigAndTrust(scope: ConnectorScope, workspace: string | null | undefined, file: RawConfigFile): string {
  const path = configPathFor(scope, workspace)
  writeConfigFile(path, file)
  if (scope === 'workspace' && workspace) {
    // 用户通过管理面板保存 = 显式信任这份内容（哈希绑定，仓库后续改动会失效）
    registerWorkspaceTrust(workspace, readFileSync(path, 'utf8'))
  }
  return path
}

/* ── 管理视图（渲染层拿不到明文） ─────────────────────────────── */

export interface ConnectorSecretField {
  key: string
  /** 掩码显示值（永远不是明文） */
  masked: string
  /** 是否保存了密钥（加密或明文回退） */
  hasSecret: boolean
  /** true = 该值以明文存在于 mcp.json（未通过面板加密保存），建议重新保存 */
  plaintext: boolean
}

export interface ConnectorView {
  scope: ConnectorScope
  name: string
  transport: McpTransportKind
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

function secretFields(config: McpServerConfig, kind: 'env' | 'headers'): ConnectorSecretField[] {
  const map = kind === 'env' ? config.env : config.headers
  return Object.entries(map ?? {}).map(([key, value]) => {
    const marker = typeof value === 'string' && value.startsWith(MCP_SECRET_MARKER)
    return { key, masked: '••••••••', hasSecret: marker || Boolean(value), plaintext: !marker && Boolean(value) }
  })
}

function toView(scope: ConnectorScope, name: string, raw: unknown, configPath: string, extraWarnings: string[] = []): ConnectorView | null {
  const normalized = normalizeMcpServerInput(name, raw)
  if (!normalized.config) return null
  const config = normalized.config
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    scope,
    name,
    transport: config.transport ?? 'stdio',
    enabled: record.disabled !== true,
    ...(config.description ? { description: config.description } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.retries !== undefined ? { retries: config.retries } : {}),
    allowPrivateNetwork: config.allowPrivateNetwork === true,
    ...(config.command ? { command: config.command } : {}),
    ...(config.args ? { args: config.args } : {}),
    ...(config.cwd ? { cwd: config.cwd } : {}),
    ...(config.url ? { url: config.url } : {}),
    env: secretFields(config, 'env'),
    headers: secretFields(config, 'headers'),
    configPath,
    warnings: [...extraWarnings, ...normalized.warnings, ...normalized.errors],
    secretStorage: getSecretCodec().mode
  }
}

export interface ConnectorListResult {
  scope: ConnectorScope
  configPath: string
  secretsMode: SecretStorageMode
  connectors: ConnectorView[]
  warnings: string[]
  /** 工作区级：当前配置内容是否已被用户信任（哈希绑定） */
  workspaceTrust?: WorkspaceTrustStatus
}

export function listConnectors(scope: ConnectorScope, workspace?: string | null): ConnectorListResult {
  const path = configPathFor(scope, workspace)
  const file = readConfigFile(path)
  const connectors: ConnectorView[] = []
  const warnings: string[] = []
  for (const [name, raw] of Object.entries(file.mcpServers)) {
    const view = toView(scope, name, raw, path)
    if (view) connectors.push(view)
    else warnings.push(`server「${name}」的配置无法解析，请编辑修正。`)
  }
  connectors.sort((a, b) => a.name.localeCompare(b.name))
  return {
    scope,
    configPath: path,
    secretsMode: getSecretCodec().mode,
    connectors,
    warnings,
    ...(scope === 'workspace' && workspace ? { workspaceTrust: workspaceTrustStatus(workspace) } : {})
  }
}

export function getConnector(scope: ConnectorScope, name: string, workspace?: string | null): ConnectorView | null {
  const path = configPathFor(scope, workspace)
  const file = readConfigFile(path)
  if (!(name in file.mcpServers)) return null
  return toView(scope, name, file.mcpServers[name], path)
}

/* ── 保存 / 删除 / 启停 ───────────────────────────────────────── */

export interface ConnectorSecretInput {
  key: string
  /** 新值（明文，只在 IPC 请求里出现一次）；不传表示保持原值 */
  value?: string
  keep?: boolean
}

export interface ConnectorSaveInput {
  scope: ConnectorScope
  workspace?: string | null
  /** 编辑时的原名（改名时用于迁移密钥） */
  originalName?: string
  name: string
  transport?: McpTransportKind | 'streamable-http'
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  headers?: ConnectorSecretInput[]
  env?: ConnectorSecretInput[]
  timeoutMs?: number
  retries?: number
  allowPrivateNetwork?: boolean
  description?: string
  enabled?: boolean
}

function secretId(scope: ConnectorScope, server: string, kind: 'env' | 'headers', key: string): string {
  return `${scope}/${server}/${kind}/${key}`
}

function buildSecretMap(
  scope: ConnectorScope,
  server: string,
  kind: 'env' | 'headers',
  fields: ConnectorSecretInput[] | undefined,
  existingRaw: unknown,
  dataDir: string
): { map: Record<string, string>; removed: number; warnings: string[] } {
  const warnings: string[] = []
  const map: Record<string, string> = {}
  const existing =
    existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw)
      ? (existingRaw as Record<string, unknown>)
      : {}
  const secrets = readSecrets(dataDir)
  const codec = getSecretCodec()
  const validKeys: string[] = []
  for (const field of fields ?? []) {
    const key = typeof field.key === 'string' ? field.key.trim() : ''
    if (!key) continue
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key)) {
      warnings.push(`${kind}.${key} 的键名不合法，已忽略。`)
      continue
    }
    validKeys.push(key)
    const value = typeof field.value === 'string' ? field.value : ''
    if (value) {
      const id = secretId(scope, server, kind, key)
      secrets.entries[id] = codec.encrypt(value)
      map[key] = `${MCP_SECRET_MARKER}${id}`
      continue
    }
    // 没传新值：保留已有配置（标记或明文都保留原样）
    const current = existing[key]
    if (typeof current === 'string' && current.length > 0) map[key] = current
  }
  // 删除本次不再出现的字段对应密钥
  let removed = 0
  for (const key of Object.keys(secrets.entries)) {
    const prefix = secretId(scope, server, kind, '')
    if (key.startsWith(prefix) && !validKeys.includes(key.slice(prefix.length))) {
      delete secrets.entries[key]
      removed += 1
    }
  }
  writeSecrets(dataDir, secrets)
  return { map, removed, warnings }
}

export interface SaveConnectorResult {
  connector: ConnectorView
  configPath: string
  warnings: string[]
  secretStorage: SecretStorageMode
}

export function saveConnector(input: ConnectorSaveInput): SaveConnectorResult {
  const scope: ConnectorScope = input.scope === 'workspace' ? 'workspace' : 'user'
  const workspace = scope === 'workspace' ? input.workspace : null
  const dataDir = currentDataDir()
  const path = configPathFor(scope, workspace)
  const file = readConfigFile(path)
  const originalName = typeof input.originalName === 'string' && input.originalName.trim() ? input.originalName.trim() : input.name
  const existingRaw = file.mcpServers[originalName]
  const existing =
    existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw)
      ? (existingRaw as Record<string, unknown>)
      : {}

  // 服务器改名时迁移已有密钥 id
  if (originalName !== input.name) {
    const secrets = readSecrets(dataDir)
    const prefix = `${scope}/${originalName}/`
    const moved: Array<[string, string]> = []
    for (const [key, value] of Object.entries(secrets.entries)) {
      if (!key.startsWith(prefix)) continue
      moved.push([key, value])
      delete secrets.entries[key]
    }
    for (const [oldId, value] of moved) {
      secrets.entries[`${scope}/${input.name}/${oldId.slice(prefix.length)}`] = value
    }
    writeSecrets(dataDir, secrets)
    // 同步把 existing 里的密钥标记 id 换成新前缀（否则 keep 旧字段会指向已删除的 id）
    for (const kind of ['env', 'headers'] as const) {
      const map = existing[kind]
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue
      const record = map as Record<string, unknown>
      for (const [key, value] of Object.entries(record)) {
        if (typeof value !== 'string' || !value.startsWith(MCP_SECRET_MARKER)) continue
        const id = value.slice(MCP_SECRET_MARKER.length)
        if (!id.startsWith(`${scope}/${originalName}/`)) continue
        record[key] = `${MCP_SECRET_MARKER}${scope}/${input.name}/${id.slice(prefix.length)}`
      }
    }
    delete file.mcpServers[originalName]
  }

  const transportKind: McpTransportKind =
    input.transport === 'streamable-http' ? 'http' : input.transport ?? (input.url ? 'http' : 'stdio')
  // 只有 stdio 用 env；只有 http/sse 用 headers。切换传输时清掉另一类旧密钥，避免孤儿数据。
  const env = buildSecretMap(scope, input.name, 'env', transportKind === 'stdio' ? input.env : undefined, existing.env, dataDir)
  const headers = buildSecretMap(
    scope,
    input.name,
    'headers',
    transportKind === 'stdio' ? undefined : input.headers,
    existing.headers,
    dataDir
  )
  const warnings = [...env.warnings, ...headers.warnings]

  const rawConfig: Record<string, unknown> = {
    transport: transportKind,
    ...(typeof input.command === 'string' && input.command.trim() ? { command: input.command.trim() } : {}),
    ...(Array.isArray(input.args) && input.args.length > 0 ? { args: input.args.filter((item): item is string => typeof item === 'string') } : {}),
    ...(typeof input.cwd === 'string' && input.cwd.trim() ? { cwd: input.cwd.trim() } : {}),
    ...(typeof input.url === 'string' && input.url.trim() ? { url: input.url.trim() } : {}),
    ...(Object.keys(env.map).length > 0 ? { env: env.map } : {}),
    ...(Object.keys(headers.map).length > 0 ? { headers: headers.map } : {}),
    ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
    ...(typeof input.retries === 'number' ? { retries: input.retries } : {}),
    ...(input.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
    ...(typeof input.description === 'string' && input.description.trim() ? { description: input.description.trim() } : {}),
    ...(input.enabled === false ? { disabled: true } : {})
  }
  const normalized = normalizeMcpServerInput(input.name, rawConfig)
  if (!normalized.config) {
    throw new Error(normalized.errors.length > 0 ? normalized.errors.join('；') : '连接器配置不合法。')
  }
  file.mcpServers[input.name] = rawConfig
  const configPath = writeConfigAndTrust(scope, workspace, file)
  const view = toView(scope, input.name, rawConfig, configPath, [...warnings, ...normalized.warnings])
  if (!view) throw new Error('保存后无法解析该连接器配置。')
  return { connector: view, configPath, warnings: view.warnings, secretStorage: getSecretCodec().mode }
}

function removeSecretsFor(scope: ConnectorScope, server: string): number {
  const dataDir = currentDataDir()
  const secrets = readSecrets(dataDir)
  let removed = 0
  for (const kind of ['env', 'headers'] as const) {
    const prefix = secretId(scope, server, kind, '')
    for (const key of Object.keys(secrets.entries)) {
      if (key.startsWith(prefix)) {
        delete secrets.entries[key]
        removed += 1
      }
    }
  }
  if (removed > 0) writeSecrets(dataDir, secrets)
  return removed
}

export function deleteConnector(
  scope: ConnectorScope,
  name: string,
  workspace?: string | null
): { deleted: boolean; removedSecrets: number; configPath: string } {
  const path = configPathFor(scope, workspace)
  const file = readConfigFile(path)
  if (!(name in file.mcpServers)) throw new Error(`没有名为「${name}」的连接器。`)
  delete file.mcpServers[name]
  const configPath = writeConfigAndTrust(scope, workspace, file)
  const removedSecrets = removeSecretsFor(scope, name)
  return { deleted: true, removedSecrets, configPath }
}

export function setConnectorEnabled(scope: ConnectorScope, name: string, enabled: boolean, workspace?: string | null): ConnectorView {
  const path = configPathFor(scope, workspace)
  const file = readConfigFile(path)
  const raw = file.mcpServers[name]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`没有名为「${name}」的连接器。`)
  const record = { ...(raw as Record<string, unknown>) }
  if (enabled) delete record.disabled
  else record.disabled = true
  file.mcpServers[name] = record
  const configPath = writeConfigAndTrust(scope, workspace, file)
  const view = toView(scope, name, record, configPath)
  if (!view) throw new Error('更新后无法解析该连接器配置。')
  return view
}

/* ── 测试连接 / 工具列表 ─────────────────────────────────────── */

export interface ConnectorTestResult {
  ok: boolean
  transport: McpTransportKind
  latencyMs: number
  tools?: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>
  error?: string
  hint?: string
  blockedReason?: 'ssrf-blocked' | 'invalid-config' | 'timeout' | 'network' | 'http-status' | 'protocol' | 'auth'
  warnings?: string[]
}

export interface ConnectorTestOptions {
  scope: ConnectorScope
  workspace?: string | null
  name?: string
  /** 测试尚未保存的草稿：普通字段 + env/headers（数组，value 为明文） */
  draft?: Record<string, unknown>
}

function draftToConfig(draft: Record<string, unknown>): { config?: McpServerConfig; errors: string[]; warnings: string[] } {
  const env: Record<string, string> = {}
  for (const item of Array.isArray(draft.env) ? draft.env : []) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.key === 'string' && typeof record.value === 'string' && record.value) env[record.key] = record.value
  }
  const headers: Record<string, string> = {}
  for (const item of Array.isArray(draft.headers) ? draft.headers : []) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.key === 'string' && typeof record.value === 'string' && record.value) headers[record.key] = record.value
  }
  const raw: Record<string, unknown> = { ...draft }
  delete raw.scope
  delete raw.workspace
  delete raw.originalName
  delete raw.enabled
  delete raw.env
  delete raw.headers
  if (Object.keys(env).length > 0) raw.env = env
  if (Object.keys(headers).length > 0) raw.headers = headers
  const name = typeof draft.name === 'string' ? draft.name : 'draft'
  const normalized = normalizeMcpServerInput(name, raw)
  return { config: normalized.config, errors: normalized.errors, warnings: normalized.warnings }
}

function mapTestError(err: unknown): ConnectorTestResult['blockedReason'] {
  const kind = (err as { kind?: unknown } | undefined)?.kind
  if (kind === 'ssrf-blocked') return 'ssrf-blocked'
  if (kind === 'timeout') return 'timeout'
  if (kind === 'http-status') return 'http-status'
  if (kind === 'protocol') return 'protocol'
  if (kind === 'network') return 'network'
  if (kind === 'tool-error') return 'protocol'
  if (kind === 'config' || kind === 'unsupported') return 'invalid-config'
  return undefined
}

/**
 * 测试连接/工具列表前，用服务自己的密钥库解密 `$MORROW_SECRET:` 标记。
 * 这样即使主进程启动时忘记注册全局解析器（installMcpRuntimeEnv 未被调用），
 * 连接器面板的「测试连接」也不会误报密钥不存在；Agent 运行时仍依赖全局解析器。
 */
function resolveConfigSecretsForService(config: McpServerConfig): McpServerConfig {
  const dataDir = currentDataDir()
  const resolveValue = (value: string, where: string): string => {
    if (!value.startsWith(MCP_SECRET_MARKER)) return value
    const id = value.slice(MCP_SECRET_MARKER.length)
    const resolved = resolveStoredSecret(dataDir, id)
    if (resolved === null) {
      throw new Error(`连接器引用的密钥不存在或无法解密（${where} → ${id}），请在面板重新填写该密钥。`)
    }
    return resolved
  }
  const env = config.env
    ? Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, resolveValue(value, `env.${key}`)]))
    : undefined
  const headers = config.headers
    ? Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, resolveValue(value, `headers.${key}`)]))
    : undefined
  return { ...config, ...(env ? { env } : {}), ...(headers ? { headers } : {}) }
}

async function connectAndListTools(
  serverName: string,
  config: McpServerConfig,
  timeoutMsOverride?: number
): Promise<{ tools: McpToolInfo[]; latencyMs: number; transport: McpTransportKind }> {
  const transport = config.transport ?? (config.url ? 'http' : 'stdio')
  const timeoutMs = Math.max(
    500,
    Math.min(timeoutMsOverride ?? config.timeoutMs ?? MCP_LIMITS.timeoutMs, MCP_LIMITS.maxTimeoutMs)
  )
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const startedAt = Date.now()
  let client: McpConnection | null = null
  try {
    client = createMcpConnection(serverName, config, { signal: controller.signal, timeoutMs })
    await client.connect()
    const tools = await client.listTools()
    return { tools, latencyMs: Date.now() - startedAt, transport }
  } catch (err) {
    if (timedOut) {
      const error = new Error(`测试连接超时（${timeoutMs}ms）。`) as Error & { kind?: string }
      error.kind = 'timeout'
      throw error
    }
    throw err
  } finally {
    clearTimeout(timer)
    if (client) await client.close()
  }
}

export async function testConnector(options: ConnectorTestOptions): Promise<ConnectorTestResult> {
  const scope: ConnectorScope = options.scope === 'workspace' ? 'workspace' : 'user'
  const workspace = scope === 'workspace' ? options.workspace : null
  let config: McpServerConfig | undefined
  let warnings: string[] = []
  let serverName = options.name ?? 'draft'
  const startedAt = Date.now()
  try {
    if (options.draft) {
      const parsed = draftToConfig(options.draft)
      warnings = parsed.warnings
      if (!parsed.config) {
        return {
          ok: false,
          transport: 'stdio',
          latencyMs: 0,
          error: parsed.errors.join('；') || '连接器配置不合法。',
          blockedReason: 'invalid-config',
          warnings
        }
      }
      config = parsed.config
      serverName = typeof options.draft.name === 'string' ? options.draft.name : 'draft'
    } else {
      if (!options.name) throw new Error('测试连接需要 name 或 draft。')
      const path = configPathFor(scope, workspace)
      const file = readConfigFile(path)
      const raw = file.mcpServers[options.name]
      if (!raw) throw new Error(`没有名为「${options.name}」的连接器。`)
      const normalized = normalizeMcpServerInput(options.name, raw)
      warnings = normalized.warnings
      if (!normalized.config) {
        return { ok: false, transport: 'stdio', latencyMs: 0, error: normalized.errors.join('；'), blockedReason: 'invalid-config', warnings }
      }
      config = normalized.config
      serverName = options.name
    }
    const transport = config.transport ?? (config.url ? 'http' : 'stdio')
    if ((transport === 'http' || transport === 'sse') && config.url) {
      await validateMcpServerUrl(config.url, { allowPrivateNetwork: config.allowPrivateNetwork === true })
    }
    config = resolveConfigSecretsForService(config)
    const { tools, latencyMs, transport: actual } = await connectAndListTools(serverName, config)
    return {
      ok: true,
      transport: actual,
      latencyMs,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {})
      })),
      ...(warnings.length > 0 ? { warnings } : {})
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const hint = (err as { hint?: unknown } | undefined)?.hint
    return {
      ok: false,
      transport: config?.transport ?? 'stdio',
      latencyMs: Date.now() - startedAt,
      error: message,
      ...(typeof hint === 'string' ? { hint } : {}),
      ...(mapTestError(err) ? { blockedReason: mapTestError(err) } : {}),
      ...(warnings.length > 0 ? { warnings } : {})
    }
  }
}

export async function listConnectorTools(
  scope: ConnectorScope,
  name: string,
  workspace?: string | null
): Promise<ConnectorTestResult> {
  return testConnector({ scope, name, workspace })
}

/* ── 连接器模板（仅配置示例，不内置任何服务） ─────────────────── */

export interface ConnectorTemplate {
  id: string
  name: string
  transport: McpTransportKind
  description: string
  /** 永远是 true：模板只是配置示例，Morrow 不伪造/不内置这些服务 */
  exampleOnly: true
  command?: string
  args?: string[]
  url?: string
  headerKeys?: string[]
  notes?: string[]
}

export function getConnectorTemplates(): ConnectorTemplate[] {
  return [
    {
      id: 'filesystem-stdio',
      name: '读取文件夹（示例）',
      transport: 'stdio',
      description: '在本地读取一个文件夹的配置示例。Morrow 不内置这个服务，需要你自行准备运行环境和路径。',
      exampleOnly: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\path\\to\\folder'],
      notes: ['Windows 若无法直接启动 npx.cmd，请填写 node.exe 完整路径 + server 脚本路径。']
    },
    {
      id: 'memory-stdio',
      name: '长期笔记（示例）',
      transport: 'stdio',
      description: '在本地保存长期笔记的配置示例；Morrow 不内置这个服务。',
      exampleOnly: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory']
    },
    {
      id: 'fetch-stdio',
      name: '读取网页（示例）',
      transport: 'stdio',
      description: '读取网页内容的配置示例；Morrow 自身也能读取网页。',
      exampleOnly: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-fetch']
    },
    {
      id: 'generic-streamable-http',
      name: '网络服务（通用）',
      transport: 'http',
      description: '连接远程工具服务的配置示例；地址和密钥请按服务商说明填写。',
      exampleOnly: true,
      url: 'https://mcp.example.com/mcp',
      headerKeys: ['Authorization'],
      notes: ['Morrow 不提供任何默认远程服务；请自行确认地址与凭据。']
    },
    {
      id: 'generic-sse',
      name: '网络服务（旧版）',
      transport: 'sse',
      description: '旧版网络服务的配置示例；只有服务商明确要求时才使用。',
      exampleOnly: true,
      url: 'https://mcp.example.com/sse',
      headerKeys: ['Authorization']
    }
  ]
}

/* ── 给 Lead/测试用的路径与状态摘要 ──────────────────────────── */

export function getConnectorPaths(workspace?: string | null): {
  dataDir: string
  userConfigPath: string
  secretsPath: string
  trustPath: string
  workspaceConfigPath: string | null
  secretStorage: SecretStorageMode
} {
  const info = getMcpRuntimeInfo()
  return {
    dataDir: info.dataDir,
    userConfigPath: info.configPath,
    secretsPath: secretsPath(info.dataDir),
    trustPath: join(info.dataDir, 'mcp-trust.json'),
    workspaceConfigPath: workspace ? workspaceConfigPath(workspace) : null,
    secretStorage: getSecretCodec().mode
  }
}

/** 兼容旧代码：加载配置（core 实现），供诊断用 */
export async function loadConnectorConfig(workspace?: string | null) {
  return loadMcpConfig({ workspace, dataDir: currentDataDir() })
}

/** 避免 `existsSync` 因平台差异被 tree-shake 报未使用（导出诊断用） */
export function connectorConfigExists(path: string): boolean {
  return existsSync(path)
}
