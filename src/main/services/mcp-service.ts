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
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log } from './logger'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  CONNECTOR_CATALOG,
  findCatalogEntry,
  type ConnectorCatalogEntry,
  type ConnectorRuntimeStatus
} from '../../shared/connector-catalog'
import { buildLocalNpxInvocation } from '../../shared/connector-catalog'
import {
  createMcpConnection,
  mcpConfigHash,
  MCP_LIMITS,
  MCP_SECRET_MARKER,
  normalizeMcpServerInput,
  setMcpOAuthTokenResolver,
  setMcpSecretResolver,
  validateMcpServerUrl,
  type McpConnection,
  type McpPromptInfo,
  type McpResourceInfo,
  type McpResourceTemplateInfo,
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
  loadOAuthTokens(resolved)
  return cached
}

/** 最近一次 installMcpRuntimeEnv 的路径信息；未初始化时按 app.getPath('userData') 现算 */
export function getMcpRuntimeInfo(): McpRuntimeInfo {
  if (cached) return cached
  const dataDir = app.getPath('userData')
  return { dataDir, configPath: join(dataDir, 'mcp.json') }
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

function isRetryableFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

/** 配置/密钥/令牌文件统一走临时文件 + 重命名；Windows 安全软件短暂占用时退避重试。 */
function writeFileAtomic(target: string, contents: string, options: { mode?: number } = {}): void {
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, contents, { encoding: 'utf8', ...(options.mode ? { mode: options.mode } : {}) })
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      renameSync(temp, target)
      return
    } catch (err) {
      if (!isRetryableFsError(err) || attempt === 3) {
        // 最后兜底：直接覆盖，至少保证本次数据落盘
        writeFileSync(target, contents, { encoding: 'utf8', ...(options.mode ? { mode: options.mode } : {}) })
        try {
          unlinkSync(temp)
        } catch {
          // ignore
        }
        return
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80 * (attempt + 1))
    }
  }
}

function secretsPath(dataDir: string): string {
  return join(dataDir, 'mcp-secrets.json')
}

function readSecrets(dataDir: string, strict = false): SecretFile {
  let text: string
  try {
    text = readFileSync(secretsPath(dataDir), 'utf8')
  } catch (err) {
    if (!strict || (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, mode: getSecretCodec().mode, entries: {} }
    }
    throw new Error('无法读取 MCP 密钥文件，已取消保存以避免覆盖现有密钥。')
  }
  try {
    const raw = JSON.parse(text) as unknown
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
    // 损坏文件：调用方决定是否按空存储处理
  }
  if (strict) throw new Error('MCP 密钥文件已损坏，已取消保存以避免覆盖现有密钥。请先备份并修复或删除该文件。')
  return { version: 1, mode: getSecretCodec().mode, entries: {} }
}

function writeSecrets(dataDir: string, file: SecretFile): void {
  writeFileAtomic(secretsPath(dataDir), JSON.stringify(file, null, 2), { mode: 0o600 })
}

/** core 注册的解析器：id → 明文；不存在/解密失败返回 null */
export function resolveStoredSecret(dataDir: string, id: string): string | null {
  const file = readSecrets(dataDir)
  const payload = file.entries[id]
  if (!payload) return null
  return getSecretCodec().decrypt(payload)
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
  writeFileAtomic(path, JSON.stringify(registry, null, 2))
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
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { mcpServers: {} }
    throw new Error(`无法读取 MCP 配置文件：${path}。`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error(`MCP 配置文件不是合法 JSON：${path}。已取消操作，请先修复或备份该文件。`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`MCP 配置文件顶层必须是对象：${path}。`)
  }
  const servers = (parsed as Record<string, unknown>).mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(`MCP 配置文件缺少 mcpServers 对象：${path}。`)
  }
  return { mcpServers: servers as Record<string, unknown> }
}

function writeConfigFile(path: string, file: RawConfigFile): void {
  writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`)
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
  oauth?: ConnectorOAuthInput
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
    ...(config.oauth ? { oauth: config.oauth } : {}),
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
  oauth?: ConnectorOAuthInput | null
}

function secretId(scope: ConnectorScope, server: string, kind: 'env' | 'headers', key: string): string {
  return `${scope}/${server}/${kind}/${key}`
}

function stringMap(raw: unknown): Record<string, string> {
  const map: Record<string, string> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0) map[key] = value
  }
  return map
}

/**
 * 只改内存里的密钥集合，不写盘；保存流程在校验通过后才统一落盘。
 * fields 省略（局部更新没携带该字段）→ 原样保留，绝不因“未出现”删密钥；
 * fields 显式传数组（含空数组）→ 以数组为准增删。
 */
function buildSecretMap(
  scope: ConnectorScope,
  server: string,
  kind: 'env' | 'headers',
  fields: ConnectorSecretInput[] | undefined,
  existingRaw: unknown,
  secrets: SecretFile
): { map: Record<string, string>; removed: number; changed: boolean; warnings: string[] } {
  const existing = stringMap(existingRaw)
  if (fields === undefined) {
    return { map: existing, removed: 0, changed: false, warnings: [] }
  }
  const warnings: string[] = []
  const map: Record<string, string> = {}
  const codec = getSecretCodec()
  const validKeys: string[] = []
  let changed = false
  for (const field of fields) {
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
      changed = true
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
  if (removed > 0) changed = true
  return { map, removed, changed, warnings }
}

export interface SaveConnectorResult {
  connector: ConnectorView
  configPath: string
  warnings: string[]
  secretStorage: SecretStorageMode
}

function transportKindOf(value: unknown): McpTransportKind | null {
  if (value === 'stdio') return 'stdio'
  if (value === 'http' || value === 'streamable-http' || value === 'streamablehttp') return 'http'
  if (value === 'sse' || value === 'http+sse') return 'sse'
  return null
}

export function saveConnector(input: ConnectorSaveInput): SaveConnectorResult {
  const scope: ConnectorScope = input.scope === 'workspace' ? 'workspace' : 'user'
  const workspace = scope === 'workspace' ? input.workspace : null
  const dataDir = currentDataDir()
  const path = configPathFor(scope, workspace)
  const file = readConfigFile(path)
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) throw new Error('连接器名称不能为空。')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    throw new Error('名称只能包含字母、数字、下划线、点、短横线，最长 64 字符。')
  }
  const requestedTransport = input.transport === 'streamable-http' ? 'http' : input.transport
  if (requestedTransport !== undefined && !transportKindOf(requestedTransport)) {
    throw new Error('transport 只能是 stdio / http / sse。')
  }
  const explicitOriginal = typeof input.originalName === 'string' && input.originalName.trim().length > 0
  const originalName = explicitOriginal ? (input.originalName as string).trim() : name
  const existingRaw = file.mcpServers[originalName]
  if (explicitOriginal && existingRaw === undefined) {
    throw new Error(`原连接器「${originalName}」不存在，可能已被删除；请刷新连接器列表后重试。`)
  }
  if (!explicitOriginal && existingRaw !== undefined) {
    throw new Error(`连接器「${name}」已存在；请从列表中选择它再编辑，或换一个名称。`)
  }
  if (originalName !== name && file.mcpServers[name] !== undefined) {
    throw new Error(`连接器「${name}」已存在；请换一个名称，避免覆盖已有连接器。`)
  }
  const existing =
    existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw)
      ? (existingRaw as Record<string, unknown>)
      : {}

  // 改名只改内存里的密钥 id；配置校验通过后才统一写盘，避免失败时丢密钥。
  const secrets = readSecrets(dataDir, true)
  let secretsChanged = false
  if (originalName !== name) {
    const prefix = `${scope}/${originalName}/`
    const moved: Array<[string, string]> = []
    for (const [key, value] of Object.entries(secrets.entries)) {
      if (!key.startsWith(prefix)) continue
      moved.push([key, value])
      delete secrets.entries[key]
    }
    for (const [oldId, value] of moved) {
      secrets.entries[`${scope}/${name}/${oldId.slice(prefix.length)}`] = value
    }
    secretsChanged = moved.length > 0
    // 同步把 existing 里的密钥标记 id 换成新前缀（否则保留旧字段会指向已删除的 id）
    for (const kind of ['env', 'headers'] as const) {
      const map = existing[kind]
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue
      const record = map as Record<string, unknown>
      for (const [key, value] of Object.entries(record)) {
        if (typeof value !== 'string' || !value.startsWith(MCP_SECRET_MARKER)) continue
        const id = value.slice(MCP_SECRET_MARKER.length)
        if (!id.startsWith(`${scope}/${originalName}/`)) continue
        record[key] = `${MCP_SECRET_MARKER}${scope}/${name}/${id.slice(prefix.length)}`
      }
    }
    delete file.mcpServers[originalName]
  }

  const existingTransport = transportKindOf(existing.transport) ?? transportKindOf(existing.type)
  const transportKind: McpTransportKind =
    transportKindOf(requestedTransport) ?? existingTransport ?? (typeof input.url === 'string' && input.url.trim() ? 'http' : 'stdio')
  // 只有 stdio 用 env；只有 http/sse 用 headers。切换传输时显式清空另一类旧密钥，避免孤儿数据；
  // 同类字段未出现在本次保存里则保留（局部更新不会误删密钥）。
  const env = buildSecretMap(scope, name, 'env', transportKind === 'stdio' ? input.env : [], existing.env, secrets)
  const headers = buildSecretMap(
    scope,
    name,
    'headers',
    transportKind === 'stdio' ? [] : input.headers,
    existing.headers,
    secrets
  )
  if (env.changed || headers.changed) secretsChanged = true
  const warnings = [...env.warnings, ...headers.warnings]

  const disabled = input.enabled === undefined ? existing.disabled === true : input.enabled === false
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
    ...(input.oauth === null
      ? {}
      : input.oauth
        ? { oauth: input.oauth }
        : existing.oauth && typeof existing.oauth === 'object' && !Array.isArray(existing.oauth)
          ? { oauth: existing.oauth }
          : {}),
    ...(typeof input.description === 'string' && input.description.trim() ? { description: input.description.trim() } : {}),
    ...(disabled ? { disabled: true } : {})
  }
  const normalized = normalizeMcpServerInput(name, rawConfig)
  if (!normalized.config) {
    throw new Error(normalized.errors.length > 0 ? normalized.errors.join('；') : '连接器配置不合法。')
  }
  if (secretsChanged) writeSecrets(dataDir, secrets)
  file.mcpServers[name] = rawConfig
  const configPath = writeConfigAndTrust(scope, workspace, file)
  // 改名时保留 OAuth 授权；端点/Client ID 变化或移除 OAuth 时清理不再匹配的旧令牌。
  try {
    const scopeKey = scopeKeyOf(scope, workspace)
    let oauthChanged = false
    if (originalName !== name) {
      for (const record of oauthTokens.values()) {
        if (record.scopeKey === scopeKey && record.name === originalName) {
          record.name = name
          oauthChanged = true
        }
      }
      const legacyKey = `legacy:${originalName}`
      const legacy = oauthTokens.get(legacyKey)
      if (legacy) {
        oauthTokens.delete(legacyKey)
        oauthTokens.set(`legacy:${name}`, { ...legacy, name })
        oauthChanged = true
      }
    }
    if (pruneOAuthRecords(scope, workspace, name, normalized.config.oauth)) oauthChanged = true
    if (oauthChanged) persistOAuthTokens()
  } catch (err) {
    log.warn('mcp oauth token housekeeping failed', { name, error: String(err) })
  }
  const view = toView(scope, name, rawConfig, configPath, [...warnings, ...normalized.warnings])
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
): { deleted: boolean; removedSecrets: number; removedOAuth: boolean; configPath: string } {
  const path = configPathFor(scope, workspace)
  const file = readConfigFile(path)
  if (!(name in file.mcpServers)) throw new Error(`没有名为「${name}」的连接器。`)
  const raw = file.mcpServers[name]
  const normalized = normalizeMcpServerInput(name, raw)
  delete file.mcpServers[name]
  const configPath = writeConfigAndTrust(scope, workspace, file)
  const removedSecrets = removeSecretsFor(scope, name)
  let removedOAuth = false
  try {
    removedOAuth = deleteOAuthRecords(scope, workspace, name, normalized.config?.oauth)
  } catch (err) {
    log.warn('mcp oauth token cleanup failed on delete', { name, error: String(err) })
  }
  return { deleted: true, removedSecrets, removedOAuth, configPath }
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
  resources?: { supported: boolean; resources: McpResourceInfo[]; templates: McpResourceTemplateInfo[] }
  prompts?: { supported: boolean; prompts: McpPromptInfo[] }
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
  timeoutMsOverride?: number,
  oauthContext?: { source: 'workspace' | 'dataDir'; workspace?: string | null }
): Promise<{
  tools: McpToolInfo[]
  resources: { supported: boolean; resources: McpResourceInfo[]; templates: McpResourceTemplateInfo[] }
  prompts: { supported: boolean; prompts: McpPromptInfo[] }
  latencyMs: number
  transport: McpTransportKind
}> {
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
    client = createMcpConnection(serverName, config, {
      signal: controller.signal,
      timeoutMs,
      ...(oauthContext ? { oauthContext } : {})
    })
    await client.connect()
    const tools = await client.listTools()
    const resources = await client.listResources().catch(() => ({
      supported: false,
      resources: [] as McpResourceInfo[],
      templates: [] as McpResourceTemplateInfo[]
    }))
    const prompts = await client.listPrompts().catch(() => ({ supported: false, prompts: [] as McpPromptInfo[] }))
    return { tools, resources, prompts, latencyMs: Date.now() - startedAt, transport }
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
    const { tools, resources, prompts, latencyMs, transport: actual } = await connectAndListTools(
      serverName,
      config,
      undefined,
      { source: scope === 'workspace' ? 'workspace' : 'dataDir', workspace }
    )
    return {
      ok: true,
      transport: actual,
      latencyMs,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {})
      })),
      resources,
      prompts,
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

/* ── A3 连接器目录：真实安装 + 运行环境检测 ──────────────────── */

const execFileAsync = promisify(execFile)
let connectorRuntimeCache: { at: number; value: ConnectorRuntimeStatus } | null = null

async function probeNpx(): Promise<{ available: boolean; version?: string }> {
  try {
    const isWindows = process.platform === 'win32'
    const command = isWindows ? process.env.ComSpec || 'cmd.exe' : 'npx'
    const args = isWindows ? ['/d', '/s', '/c', 'npx --version'] : ['--version']
    const { stdout } = await execFileAsync(command, args, {
      timeout: 8_000,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 64 * 1024
    })
    const version = String(stdout).trim().split(/\r?\n/)[0]?.trim() ?? ''
    return version ? { available: true, version } : { available: false }
  } catch {
    return { available: false }
  }
}

/** 目录安装前检测本机运行环境；30 秒缓存，避免每次开面板都启动子进程。 */
export async function detectConnectorRuntime(force = false): Promise<ConnectorRuntimeStatus> {
  if (!force && connectorRuntimeCache && Date.now() - connectorRuntimeCache.at < 30_000) {
    return connectorRuntimeCache.value
  }
  const npx = await probeNpx()
  const value: ConnectorRuntimeStatus = {
    platform: process.platform,
    npx,
    ...(npx.available
      ? {}
      : { note: '本机连接器需要 Node.js（包含 npx）。安装 Node.js LTS 后重新检测即可。' })
  }
  connectorRuntimeCache = { at: Date.now(), value }
  return value
}

export function getConnectorCatalog(): readonly ConnectorCatalogEntry[] {
  return CONNECTOR_CATALOG
}

export interface CatalogInstallOptions {
  scope: ConnectorScope
  workspace?: string | null
  id: string
  token?: string
  folder?: string
  /** true = 先测试再保存；false = 仅安装，稍后手动测试 */
  test: boolean
}

export interface CatalogInstallResult {
  saved: boolean
  view?: ConnectorView
  test?: ConnectorTestResult
}

/**
 * 目录一键安装：真实写入用户/工作区配置，密钥走现有加密通道。
 * - test=true 时先对草稿做真实连接测试；失败不落盘，避免留下“看起来装好了”的坏配置。
 * - test=false 时只保存，用户在详情页可随时测试。
 */
export async function installCatalogConnector(options: CatalogInstallOptions): Promise<CatalogInstallResult> {
  const entry = findCatalogEntry(options.id)
  if (!entry) throw new Error('目录里没有这个连接器（可能已下架）。')
  const scope: ConnectorScope = options.scope === 'workspace' ? 'workspace' : 'user'
  const workspace = scope === 'workspace' ? options.workspace ?? null : null
  if (scope === 'workspace' && !workspace) throw new Error('安装到当前文件夹前，请先选择一个文件夹。')

  const token = typeof options.token === 'string' ? options.token.trim().replace(/^Bearer\s+/i, '') : ''
  if (entry.requiresToken && !token) throw new Error(`请填写${entry.tokenLabel ?? '访问令牌'}。`)
  if (token.length > 8192) throw new Error('访问令牌过长。')

  let folder: string | undefined
  if (entry.requiresFolder) {
    if (typeof options.folder !== 'string' || !options.folder.trim()) throw new Error('请选择要授权的文件夹。')
    try {
      folder = realpathSync(resolve(options.folder))
      if (!statSync(folder).isDirectory()) throw new Error('不是目录')
    } catch {
      throw new Error('文件夹不存在或不可访问，请重新选择。')
    }
  }

  if (entry.requiresNpx) {
    const runtime = await detectConnectorRuntime(true)
    if (!runtime.npx.available) {
      throw new Error(runtime.note ?? '本机连接器需要 Node.js（包含 npx）。请先安装 Node.js LTS 后重试。')
    }
  }

  const headers = entry.headerKey && token ? [{ key: entry.headerKey, value: `Bearer ${token}` }] : []
  const env = entry.envKey && token ? [{ key: entry.envKey, value: token }] : []
  let command: string | undefined
  let args: string[] | undefined
  if (entry.transport === 'stdio') {
    const invocation = buildLocalNpxInvocation(entry.packageArgs ?? [], folder, process.platform, process.env.ComSpec)
    command = invocation.command
    args = invocation.args
  }

  const draft: Record<string, unknown> = {
    name: entry.name,
    transport: entry.transport,
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(entry.url ? { url: entry.url } : {}),
    ...(headers.length > 0 ? { headers } : {}),
    ...(env.length > 0 ? { env } : {}),
    timeoutMs: entry.timeoutMs,
    description: entry.detail,
    allowPrivateNetwork: false
  }

  let test: ConnectorTestResult | undefined
  if (options.test) {
    test = await testConnector({
      scope,
      ...(workspace ? { workspace } : {}),
      draft
    })
    if (!test.ok) return { saved: false, test }
  }

  const saved = await saveConnector({
    scope,
    ...(workspace ? { workspace } : {}),
    name: entry.name,
    transport: entry.transport,
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(entry.url ? { url: entry.url } : {}),
    ...(headers.length > 0 ? { headers } : {}),
    ...(env.length > 0 ? { env } : {}),
    timeoutMs: entry.timeoutMs,
    description: entry.detail,
    enabled: true
  })
  return { saved: true, view: saved.connector, ...(test ? { test } : {}) }
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

/* ── MCP OAuth 2.0（授权码 + PKCE，P1-14） ────────────────────── */

/**
 * 说明：这里实现 OAuth 2.0 授权码 + PKCE 的公共客户端流程。
 * 端点由用户在连接器里填写（authorizationUrl / tokenUrl / clientId），不做自动动态注册；
 * 适用于支持公共客户端（无需 client_secret）的 MCP 服务。令牌用 safeStorage 加密后写
 * <dataDir>/mcp-oauth.json（0600），渲染层只拿到是否已授权与过期时间。
 */
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

export const CONNECTOR_OAUTH_EVENT = 'feature:connectors:oauth'

interface OAuthTokenRecord {
  name: string
  /** 用户级 = user；工作区级 = workspace:<realpath>；旧版令牌为空字符串 */
  scopeKey: string
  /** OAuth 端点 + clientId 的指纹，配置变化后旧令牌自动失效 */
  fingerprint: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
  tokenUrl: string
  clientId: string
  allowPrivateNetwork: boolean
  scope?: string
  updatedAt: number
}

interface PendingOAuthFlow {
  server: Server
  timer: NodeJS.Timeout
}

interface OAuthTokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  token_type?: unknown
  scope?: unknown
  error?: unknown
  error_description?: unknown
}

const oauthTokens = new Map<string, OAuthTokenRecord>()
const pendingOAuthFlows = new Map<string, PendingOAuthFlow>()
const refreshing = new Set<string>()
let oauthRefreshTimer: NodeJS.Timeout | null = null

function oauthFilePath(): string {
  return join(currentDataDir(), 'mcp-oauth.json')
}

function emitOAuthEvent(payload: { name: string; scopeKey?: string; status: string; message?: string; expiresAt?: number }): void {
  try {
    const { sendFeatureEvent } = require('../feature-ipc') as typeof import('../feature-ipc')
    sendFeatureEvent(CONNECTOR_OAUTH_EVENT, payload)
  } catch {
    // 测试/非 Electron 环境忽略
  }
}

function normalizeWorkspaceForToken(workspace?: string | null): string {
  const value = (workspace ?? '').trim()
  if (!value) return ''
  try {
    const real = realpathSync(value)
    return process.platform === 'win32' ? real.toLowerCase() : real
  } catch {
    const fallback = resolve(value)
    return process.platform === 'win32' ? fallback.toLowerCase() : fallback
  }
}

function scopeKeyOf(scope: ConnectorScope, workspace?: string | null): string {
  return scope === 'workspace' ? `workspace:${normalizeWorkspaceForToken(workspace)}` : 'user'
}

function scopeKeyForSource(context?: { source?: string | null; workspace?: string | null }): string {
  if (context?.source === 'workspace') return `workspace:${normalizeWorkspaceForToken(context.workspace)}`
  if (context?.source === 'dataDir') return 'user'
  return 'external'
}

function oauthFingerprint(oauth: { authorizationUrl: string; tokenUrl: string; clientId: string }): string {
  return createHash('sha256')
    .update(`${oauth.authorizationUrl}\n${oauth.tokenUrl}\n${oauth.clientId}`)
    .digest('hex')
    .slice(0, 24)
}

function oauthTokenKey(scopeKey: string, oauth: { authorizationUrl: string; tokenUrl: string; clientId: string }): string {
  return `${scopeKey}|${oauthFingerprint(oauth)}`
}

function tokenUsable(record: OAuthTokenRecord): string | null {
  if (record.expiresAt > 0 && record.expiresAt <= Date.now() + 10_000) return null
  return record.accessToken
}

function legacyOAuthRecord(name: string, oauth: { tokenUrl: string; clientId: string }): OAuthTokenRecord | null {
  const record = oauthTokens.get(`legacy:${name}`)
  return record && record.tokenUrl === oauth.tokenUrl && record.clientId === oauth.clientId ? record : null
}

function closePendingOAuthFlow(key: string): void {
  const flow = pendingOAuthFlows.get(key)
  if (!flow) return
  pendingOAuthFlows.delete(key)
  clearTimeout(flow.timer)
  try {
    flow.server.close()
  } catch {
    // ignore
  }
}

function applyOAuthResolver(): void {
  setMcpOAuthTokenResolver((name, config, context) => {
    const oauth = config.oauth
    if (!oauth) return null
    const record = oauthTokens.get(oauthTokenKey(scopeKeyForSource(context), oauth))
    if (record) return tokenUsable(record)
    const legacy = legacyOAuthRecord(name, oauth)
    return legacy ? tokenUsable(legacy) : null
  })
}

/** 启动/测试时加载加密令牌；坏条目忽略，不影响连接器列表。 */
function loadOAuthTokens(dataDir: string): void {
  oauthTokens.clear()
  const file = join(dataDir, 'mcp-oauth.json')
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { tokens?: Record<string, Record<string, unknown>> }
      const codec = getSecretCodec()
      for (const [storedKey, raw] of Object.entries(parsed.tokens ?? {})) {
        if (!raw || typeof raw !== 'object') continue
        const access = typeof raw.access === 'string' ? codec.decrypt(raw.access) : null
        if (!access) continue
        const refresh = typeof raw.refresh === 'string' ? codec.decrypt(raw.refresh) : null
        const expiresAt = typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt) ? raw.expiresAt : 0
        const tokenUrl = typeof raw.tokenUrl === 'string' ? raw.tokenUrl : ''
        const clientId = typeof raw.clientId === 'string' ? raw.clientId : ''
        if (!tokenUrl || !clientId) continue
        const name = typeof raw.name === 'string' && raw.name ? raw.name : storedKey
        const scopeKey = typeof raw.scopeKey === 'string' ? raw.scopeKey : ''
        const fingerprint = typeof raw.fingerprint === 'string' ? raw.fingerprint : ''
        const key = scopeKey && fingerprint ? `${scopeKey}|${fingerprint}` : `legacy:${name}`
        oauthTokens.set(key, {
          name,
          scopeKey,
          fingerprint,
          accessToken: access,
          ...(refresh ? { refreshToken: refresh } : {}),
          expiresAt,
          tokenUrl,
          clientId,
          allowPrivateNetwork: raw.allowPrivateNetwork === true,
          ...(typeof raw.scope === 'string' ? { scope: raw.scope } : {}),
          updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now()
        })
      }
    }
  } catch {
    // 损坏文件按未授权处理
  }
  applyOAuthResolver()
  if (!oauthRefreshTimer) {
    oauthRefreshTimer = setInterval(() => void refreshExpiringOAuth(), 60_000)
    oauthRefreshTimer.unref?.()
  }
}

function persistOAuthTokens(): void {
  const codec = getSecretCodec()
  const tokens: Record<string, Record<string, unknown>> = {}
  for (const [key, record] of oauthTokens) {
    tokens[key] = {
      name: record.name,
      ...(record.scopeKey && record.fingerprint
        ? { scopeKey: record.scopeKey, fingerprint: record.fingerprint }
        : {}),
      access: codec.encrypt(record.accessToken),
      ...(record.refreshToken ? { refresh: codec.encrypt(record.refreshToken) } : {}),
      expiresAt: record.expiresAt,
      tokenUrl: record.tokenUrl,
      clientId: record.clientId,
      allowPrivateNetwork: record.allowPrivateNetwork,
      ...(record.scope ? { scope: record.scope } : {}),
      updatedAt: record.updatedAt
    }
  }
  writeFileAtomic(oauthFilePath(), JSON.stringify({ version: 1, tokens }), { mode: 0o600 })
}

/** 删除某个连接器在指定作用域下的全部令牌；旧版令牌按名称与端点匹配。 */
function deleteOAuthRecords(
  scope: ConnectorScope,
  workspace: string | null | undefined,
  name: string,
  oauth?: { authorizationUrl: string; tokenUrl: string; clientId: string }
): boolean {
  const scopeKey = scopeKeyOf(scope, workspace)
  const keys = new Set<string>()
  if (oauth) keys.add(oauthTokenKey(scopeKey, oauth))
  for (const [key, record] of oauthTokens) {
    if (record.scopeKey === scopeKey && record.name === name) {
      keys.add(key)
      continue
    }
    if (!record.scopeKey && record.name === name) {
      if (!oauth || (record.tokenUrl === oauth.tokenUrl && record.clientId === oauth.clientId)) keys.add(key)
    }
  }
  closePendingOAuthFlow(`${scopeKey}|${name}`)
  let removed = false
  for (const key of keys) {
    if (oauthTokens.delete(key)) removed = true
  }
  if (removed) persistOAuthTokens()
  return removed
}

/** 配置中的 OAuth 端点变化后，删除同一作用域/连接器下不再匹配的旧令牌。 */
function pruneOAuthRecords(
  scope: ConnectorScope,
  workspace: string | null | undefined,
  name: string,
  oauth?: { authorizationUrl: string; tokenUrl: string; clientId: string }
): boolean {
  const scopeKey = scopeKeyOf(scope, workspace)
  const desired = oauth ? oauthFingerprint(oauth) : ''
  let removed = false
  for (const [key, record] of oauthTokens) {
    if (record.name !== name || record.scopeKey !== scopeKey) continue
    if (desired && record.fingerprint === desired) continue
    closePendingOAuthFlow(key)
    if (oauthTokens.delete(key)) removed = true
  }
  return removed
}

function readSavedConnectorConfig(scope: ConnectorScope, name: string, workspace?: string | null): McpServerConfig {
  const path = configPathFor(scope, scope === 'workspace' ? workspace : null)
  const file = readConfigFile(path)
  const raw = file.mcpServers[name]
  if (!raw) throw new Error(`没有名为「${name}」的连接器。`)
  const normalized = normalizeMcpServerInput(name, raw)
  if (!normalized.config) throw new Error(normalized.errors.join('；') || '连接器配置不合法。')
  return normalized.config
}

function createPkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(24).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge, state }
}

function escapeHtml(value: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return value.replace(/[&<>"']/g, (char) => map[char] ?? char)
}

function oauthResponsePage(ok: boolean, message: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Morrow 授权</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1318;color:#e9e2d3;display:grid;place-items:center;height:100vh;margin:0}main{max-width:440px;padding:32px;text-align:center}h1{font-size:18px;color:${ok ? '#7fa292' : '#c2795f'}}p{font-size:13px;line-height:1.7;color:#b8b0a0}</style></head>
<body><main><h1>${ok ? '授权完成' : '授权失败'}</h1><p>${escapeHtml(message)}</p><p>可以关闭此页面，回到 Morrow 继续。</p></main></body></html>`
}

async function postOAuthToken(
  tokenUrl: string,
  body: URLSearchParams,
  allowPrivateNetwork: boolean
): Promise<OAuthTokenResponse> {
  const url = await validateMcpServerUrl(tokenUrl, { allowPrivateNetwork })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      redirect: 'error',
      signal: controller.signal
    })
    const text = (await response.text()).slice(0, 256 * 1024)
    let parsed: OAuthTokenResponse
    try {
      parsed = JSON.parse(text) as OAuthTokenResponse
    } catch {
      throw new Error(`OAuth 令牌端点返回了非 JSON 响应（HTTP ${response.status}）。`)
    }
    if (!response.ok || parsed.error) {
      const detail =
        typeof parsed.error_description === 'string'
          ? parsed.error_description
          : typeof parsed.error === 'string'
            ? parsed.error
            : `HTTP ${response.status}`
      throw new Error(`OAuth 令牌请求失败：${detail}`)
    }
    if (typeof parsed.access_token !== 'string' || !parsed.access_token) {
      throw new Error('OAuth 令牌响应缺少 access_token。')
    }
    return parsed
  } finally {
    clearTimeout(timer)
  }
}

function expiresAtFrom(response: OAuthTokenResponse): number {
  const seconds = typeof response.expires_in === 'number' ? response.expires_in : Number(response.expires_in)
  return Number.isFinite(seconds) && seconds > 0 ? Date.now() + Math.round(seconds) * 1000 : 0
}

async function exchangeOAuthCode(input: {
  name: string
  tokenKey: string
  scopeKey: string
  fingerprint: string
  code: string
  redirectUri: string
  verifier: string
  config: McpServerConfig
  allowPrivateNetwork: boolean
}): Promise<void> {
  const oauth = input.config.oauth
  if (!oauth) throw new Error('连接器缺少 OAuth 配置。')
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: oauth.clientId,
    code_verifier: input.verifier
  })
  const response = await postOAuthToken(oauth.tokenUrl, body, input.allowPrivateNetwork)
  oauthTokens.set(input.tokenKey, {
    name: input.name,
    scopeKey: input.scopeKey,
    fingerprint: input.fingerprint,
    accessToken: response.access_token as string,
    ...(typeof response.refresh_token === 'string' && response.refresh_token
      ? { refreshToken: response.refresh_token }
      : {}),
    expiresAt: expiresAtFrom(response),
    tokenUrl: oauth.tokenUrl,
    clientId: oauth.clientId,
    allowPrivateNetwork: input.allowPrivateNetwork,
    ...(typeof response.scope === 'string'
      ? { scope: response.scope }
      : oauth.scopes?.length
        ? { scope: oauth.scopes.join(' ') }
        : {}),
    updatedAt: Date.now()
  })
  persistOAuthTokens()
}

/** 开始授权：返回浏览器地址；主进程在 127.0.0.1 随机端口等待回调。 */
export async function startConnectorOAuth(options: {
  scope: ConnectorScope
  name: string
  workspace?: string | null
}): Promise<{ authorizationUrl: string; redirectUri: string }> {
  const config = readSavedConnectorConfig(options.scope, options.name, options.workspace)
  const oauth = config.oauth
  if (!oauth) {
    throw new Error('这个连接器还没有配置 OAuth 授权地址、令牌地址与 Client ID。请先填写并保存。')
  }
  if ((config.transport ?? (config.url ? 'http' : 'stdio')) === 'stdio') {
    throw new Error('OAuth 只适用于 HTTP/SSE 连接器。')
  }
  const allowPrivateNetwork = config.allowPrivateNetwork === true
  const authorizationUrl = await validateMcpServerUrl(oauth.authorizationUrl, { allowPrivateNetwork })
  const scopeKey = scopeKeyOf(options.scope, options.workspace)
  const fingerprint = oauthFingerprint(oauth)
  const tokenKey = `${scopeKey}|${fingerprint}`
  const flowKey = `${scopeKey}|${options.name}`

  // 重新发起授权时清理同一连接器的旧流程（含定时器与回调服务），避免旧超时误删新流程。
  closePendingOAuthFlow(flowKey)

  const { verifier, challenge, state } = createPkce()
  let timer: NodeJS.Timeout | null = null
  let server: Server
  const finish = (): void => {
    if (timer) clearTimeout(timer)
    const current = pendingOAuthFlows.get(flowKey)
    if (current?.server === server) pendingOAuthFlows.delete(flowKey)
    try {
      server.close()
    } catch {
      // ignore
    }
  }
  server = createServer((request, response) => {
    void (async () => {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      let url: URL
      try {
        url = new URL(request.url ?? '/', base)
      } catch {
        response.writeHead(400).end('bad request')
        return
      }
      if (url.pathname !== '/callback') {
        response.writeHead(404).end('not found')
        return
      }
      if (url.searchParams.get('state') !== state) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        response.end(oauthResponsePage(false, '状态校验失败，请重新发起授权。'))
        emitOAuthEvent({ name: options.name, scopeKey, status: 'error', message: '状态校验失败' })
        finish()
        return
      }
      const error = url.searchParams.get('error')
      if (error) {
        const detail = url.searchParams.get('error_description') ?? error
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        response.end(oauthResponsePage(false, detail))
        emitOAuthEvent({ name: options.name, scopeKey, status: 'error', message: detail })
        finish()
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        response.end(oauthResponsePage(false, '回调缺少 code。'))
        emitOAuthEvent({ name: options.name, scopeKey, status: 'error', message: '回调缺少 code' })
        finish()
        return
      }
      try {
        await exchangeOAuthCode({
          name: options.name,
          tokenKey,
          scopeKey,
          fingerprint,
          code,
          redirectUri: `${base}/callback`,
          verifier,
          config,
          allowPrivateNetwork
        })
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(oauthResponsePage(true, `连接器「${options.name}」已授权。`))
        emitOAuthEvent({
          name: options.name,
          scopeKey,
          status: 'success',
          expiresAt: oauthTokens.get(tokenKey)?.expiresAt
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
        response.end(oauthResponsePage(false, message))
        emitOAuthEvent({ name: options.name, scopeKey, status: 'error', message })
      } finally {
        finish()
      }
    })()
  })

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (err: Error): void => {
        server.off('listening', onListening)
        rejectListen(err)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolveListen()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })
  } catch (err) {
    try {
      server.close()
    } catch {
      // ignore
    }
    throw err instanceof Error ? err : new Error(String(err))
  }

  const address = server.address()
  if (!address || typeof address === 'string') {
    finish()
    throw new Error('无法启动 OAuth 本地回调服务。')
  }
  const redirectUri = `http://127.0.0.1:${address.port}/callback`
  const auth = new URL(authorizationUrl.toString())
  auth.searchParams.set('response_type', 'code')
  auth.searchParams.set('client_id', oauth.clientId)
  auth.searchParams.set('redirect_uri', redirectUri)
  auth.searchParams.set('code_challenge', challenge)
  auth.searchParams.set('code_challenge_method', 'S256')
  auth.searchParams.set('state', state)
  if (oauth.scopes?.length) auth.searchParams.set('scope', oauth.scopes.join(' '))

  timer = setTimeout(() => {
    const current = pendingOAuthFlows.get(flowKey)
    if (current?.server !== server) return
    pendingOAuthFlows.delete(flowKey)
    try {
      server.close()
    } catch {
      // ignore
    }
    emitOAuthEvent({ name: options.name, scopeKey, status: 'error', message: '授权超时（5 分钟）。' })
  }, 5 * 60_000)
  timer.unref?.()
  pendingOAuthFlows.set(flowKey, { server, timer })

  server.on('error', (err) => {
    const current = pendingOAuthFlows.get(flowKey)
    if (current?.server !== server) return
    pendingOAuthFlows.delete(flowKey)
    if (timer) clearTimeout(timer)
    try {
      server.close()
    } catch {
      // ignore
    }
    emitOAuthEvent({ name: options.name, scopeKey, status: 'error', message: err.message })
  })

  return { authorizationUrl: auth.toString(), redirectUri }
}

export function connectorOAuthStatus(scope: ConnectorScope, name: string, workspace?: string | null): ConnectorOAuthStatus {
  let oauth: McpServerConfig['oauth'] | undefined
  try {
    oauth = readSavedConnectorConfig(scope, name, workspace).oauth
  } catch {
    oauth = undefined
  }
  const record = oauth
    ? (oauthTokens.get(oauthTokenKey(scopeKeyOf(scope, workspace), oauth)) ?? legacyOAuthRecord(name, oauth))
    : null
  const expiresAt = record && record.expiresAt > 0 ? record.expiresAt : null
  return {
    configured: Boolean(oauth),
    authorized: Boolean(record),
    expiresAt,
    hasRefreshToken: Boolean(record?.refreshToken),
    expired: Boolean(expiresAt && expiresAt <= Date.now())
  }
}

export function revokeConnectorOAuth(scope: ConnectorScope, name: string, workspace?: string | null): boolean {
  let oauth: McpServerConfig['oauth'] | undefined
  try {
    oauth = readSavedConnectorConfig(scope, name, workspace).oauth
  } catch {
    oauth = undefined
  }
  const removed = deleteOAuthRecords(scope, workspace, name, oauth)
  emitOAuthEvent({ name, scopeKey: scopeKeyOf(scope, workspace), status: removed ? 'revoked' : 'unchanged' })
  return removed
}

async function refreshOAuthToken(key: string): Promise<boolean> {
  const record = oauthTokens.get(key)
  if (!record?.refreshToken || refreshing.has(key)) return false
  refreshing.add(key)
  try {
    const response = await postOAuthToken(
      record.tokenUrl,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: record.refreshToken,
        client_id: record.clientId
      }),
      record.allowPrivateNetwork
    )
    oauthTokens.set(key, {
      ...record,
      accessToken: response.access_token as string,
      ...(typeof response.refresh_token === 'string' && response.refresh_token
        ? { refreshToken: response.refresh_token }
        : {}),
      expiresAt: expiresAtFrom(response),
      ...(typeof response.scope === 'string' ? { scope: response.scope } : {}),
      updatedAt: Date.now()
    })
    persistOAuthTokens()
    emitOAuthEvent({
      name: record.name,
      scopeKey: record.scopeKey || undefined,
      status: 'refreshed',
      expiresAt: oauthTokens.get(key)?.expiresAt
    })
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    emitOAuthEvent({
      name: record.name,
      scopeKey: record.scopeKey || undefined,
      status: 'error',
      message: `刷新令牌失败：${message}`
    })
    return false
  } finally {
    refreshing.delete(key)
  }
}

async function refreshExpiringOAuth(): Promise<void> {
  for (const [key, record] of oauthTokens) {
    if (!record.refreshToken || record.expiresAt <= 0) continue
    if (record.expiresAt > Date.now() + 5 * 60_000) continue
    await refreshOAuthToken(key)
  }
}
