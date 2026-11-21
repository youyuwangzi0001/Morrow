// 主进程与渲染层共享的功能域类型；只放两边逐字一致的契约。
import type { MemoryImportance } from './contracts'

export type ConnectorScope = 'user' | 'workspace'

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
  workspace: string | null
  legacyKey?: string
}

export interface MemoryStats {
  scope: MemoryScope
  workspace: string | null
  total: number
  enabled: number
  disabled: number
  enabledTokens: number
  limitTokens: number
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
