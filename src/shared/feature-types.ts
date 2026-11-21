// 主进程与渲染层共享的功能域类型；只放两边逐字一致的契约。
import type { MemoryImportance } from './contracts'

export type ConnectorScope = 'user' | 'workspace'

/**
 * 密钥存储方式。
 *
 * `plaintext-fallback` 只在系统密钥环不可用时出现（例如未登录的 Linux 桌面）。
 * 它不是「用户选择了明文」，而是「没有更好的办法」—— 界面必须因此显示警告，
 * 而不是把它当成一个正常的选项。
 */
export type SecretStorageMode = 'encrypted' | 'plaintext-fallback'

export interface ConnectorSecretField {
  key: string
  /** 已脱敏的展示值。**永远不能**携带原文 —— 这份结构会过 IPC 进渲染层。 */
  masked: string
  hasSecret: boolean
  /** 这条是明文存的（见 SecretStorageMode），界面需要提示风险。 */
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
  /** null = 提供方没返回过期时间（不等于永久有效）。 */
  expiresAt: number | null
  hasRefreshToken: boolean
  /** 与 `expiresAt` 分开给：判断「过期」还要考虑时钟漂移，交给主进程算一次。 */
  expired: boolean
}

export type MemoryScope = 'project' | 'global'

export type MemorySource = 'agent' | 'user' | 'migration'

export interface MemoryEntry {
  id: string
  text: string
  tags: string[]
  createdAt: number
  updatedAt: number
  source: MemorySource
  enabled: boolean
  scope: MemoryScope
  importance: MemoryImportance
  /** null = 全局记忆；非 null 时是它所属的工作区根路径。 */
  workspace: string | null
  /** 从旧的单文件记忆迁移过来时的原键名，用于去重与回溯。 */
  legacyKey?: string
}

export interface MemoryStats {
  scope: MemoryScope
  workspace: string | null
  total: number
  enabled: number
  disabled: number
  /** 已启用记忆占用的 token 数。 */
  enabledTokens: number
  /** 上限。`enabledTokens` 接近它时界面要提示，超了注入会截断。 */
  limitTokens: number
  /** 检测到旧版单文件记忆（尚未迁移）。 */
  legacyFileDetected: boolean
  migratedTotal: number
}

export interface MemoryListResult {
  entries: MemoryEntry[]
  stats: MemoryStats
}

export interface MemoryExportResult {
  scope: MemoryScope
  workspace: string | null
  fileName: string
  markdown: string
  json: string
  count: number
  exportedAt: number
}

export interface MemoryInjection {
  text: string
  usedTokens: number
  limitTokens: number
  totalEnabled: number
  included: number
  omitted: number
  projectCount: number
  globalCount: number
}

export interface SkillFileEntry {
  path: string
  size: number
}

export interface SkillView {
  id: string
  name: string
  description: string
  source: 'workspace' | 'user'
  builtin: boolean
  enabled: boolean
  dir: string
  skillPath: string
  displayDir: string
  declaredName?: string
  installedAt: number | null
  updatedAt: number
  fileCount: number
  sizeBytes: number
  resources: string[]
  shadowed: boolean
  valid: boolean
  error?: string
}

export interface SkillDetail extends SkillView {
  raw: string
  rawTruncated: boolean
  files: SkillFileEntry[]
}

export interface SkillsSnapshot {
  userDir: string
  stateFile: string
  workspace: string | null
  skills: SkillView[]
  errors: string[]
  scannedAt: number
}

export interface InstallResult {
  installed: SkillView
  snapshot: SkillsSnapshot
  skipped: string[]
}

export interface ProjectRecord {
  id: string
  workspace: string
  name: string
  description: string
  instructions: string
  knowledgePaths: string[]
  pinned: boolean
  active: boolean
  createdAt: number
  updatedAt: number
}

export interface ProjectSummary extends ProjectRecord {
  workspaceExists: boolean
  knowledgeCount: number
}

export interface ProjectKnowledgeInfo {
  path: string
  name: string
  size: number
  mtime: number
  excerpt?: string
  truncated?: boolean
  error?: string
}

export interface ProjectContext {
  project: ProjectRecord
  instructions: string
  knowledge: ProjectKnowledgeInfo[]
  staleKnowledge: Array<{ path: string; error: string }>
  memory: MemoryInjection | null
  projectText: string
  memoryText: string
  text: string
  usedTokens: number
  limitTokens: number
  truncated: boolean
}

export interface ProjectCreateInput {
  workspace: string
  name?: string
  description?: string
  instructions?: string
  knowledgePaths?: string[]
  pinned?: boolean
  active?: boolean
}

export interface ProjectUpdateInput {
  name?: string
  description?: string
  instructions?: string
  knowledgePaths?: string[]
  pinned?: boolean
  active?: boolean
}

export type HistorySource = 'user' | 'agent' | 'baseline' | 'restore'

export interface HistoryVersion {
  id: string
  path: string
  name: string
  createdAt: number
  source: HistorySource
  size: number
  contentHash: string
  mtimeMs?: number
  label?: string
}

export interface HistoryRestoreResult {
  path: string
  versionId: string
  mtimeMs: number
  size: number
  newVersionId: string | null
}

export type SearchHitKind = 'session' | 'file' | 'artifact'

export interface SearchHighlight {
  start: number
  end: number
}

export interface SearchHit {
  kind: SearchHitKind
  id: string
  title: string
  snippet: string
  highlights: SearchHighlight[]
  score: number
  sessionId?: string
  messageId?: string
  role?: string
  path?: string
  absolutePath?: string
  line?: number
  artifactId?: string
  artifactKind?: string
  updatedAt?: number
}
