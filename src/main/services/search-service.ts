/**
 * R10-I 全局搜索服务（无网络、纯本地索引）。
 *
 * 索引范围：会话标题/消息正文、工作区文件路径/文本内容、artifact 标题/内容。
 * - 每工作区独立文件索引，查询带 workspace 时严格隔离；
 * - 启动时构建一次；查询前按 updatedAt/mtime 增量刷新（保存/工具完成后搜得到）；
 * - 忽略 node_modules/.git/Morrow Data/二进制/超大文件；
 * - 不 import electron，便于单测（依赖注入会话/工作区读取）。
 */
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import type { Artifact, ChatMessage, Session, SessionMeta } from '../../shared/types'

/* ── 公共类型（渲染层复制同名类型，不改 shared 契约） ─────────── */

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
  /** 会话消息命中 */
  sessionId?: string
  messageId?: string
  role?: string
  /** 文件命中 */
  path?: string
  absolutePath?: string
  line?: number
  /** artifact 命中 */
  artifactId?: string
  artifactKind?: string
  updatedAt?: number
}

export interface SearchGroups {
  sessions: SearchHit[]
  files: SearchHit[]
  artifacts: SearchHit[]
}

export interface SearchIndexStatus {
  ready: boolean
  building: boolean
  sessions: number
  files: number
  artifacts: number
  workspaces: string[]
  lastBuiltAt?: number
}

export interface SearchResponse {
  query: string
  groups: SearchGroups
  total: number
  tookMs: number
  index: SearchIndexStatus
}

export interface SearchQueryInput {
  q: string
  /** 限定工作区；不传 = 搜索全部已索引工作区（全局） */
  workspace?: string | null
  limit?: number
}

export interface SearchServiceDeps {
  listSessions(): SessionMeta[]
  getSession(id: string): Session | null
  /** 用户最近/当前工作区（只索引这些，避免扫描无关磁盘） */
  listWorkspaces(): string[]
  /** 会话写入/删除版本；变化时绕过节流立即刷新会话索引 */
  getSessionRevision?: () => number
  /** 数据目录（Morrow Data 永不索引） */
  dataDir?: string
  now?: () => number
}

export interface SearchServiceOptions {
  /** 每个工作区最多索引文件数，默认 5000 */
  maxFilesPerWorkspace?: number
  /** 单文件最大索引字节，默认 512KB */
  maxFileBytes?: number
  /** 单条消息/artifact 最大索引字符，默认 20000 */
  maxTextChars?: number
  /** 查询自动刷新节流（毫秒），默认 1500 */
  autoRefreshMs?: number
}

/* ── 内部结构 ─────────────────────────────────────────────────── */

interface SessionDoc {
  id: string
  title: string
  workspace: string | null
  updatedAt: number
  messages: Array<{ id: string; role: ChatMessage['role']; text: string }>
  artifacts: Array<{ artifact: Artifact; sessionTitle: string }>
}

interface FileDoc {
  absolutePath: string
  relPath: string
  name: string
  mtimeMs: number
  size: number
  text: string | null
  binary: boolean
}

const IGNORED_DIR_NAMES = new Set(['node_modules', '.git', 'Morrow Data', 'out', 'release', 'dist', '.cache'])
const BINARY_PROBE_BYTES = 8192
/** 单个会话最多索引的正文字符数（优先保留最近的消息/成品，避免超长会话拖垮内存） */
export const SEARCH_SESSION_TEXT_BUDGET = 200_000
export const SEARCH_SESSION_ARTIFACT_BUDGET = 200_000

function normalizeWorkspace(workspace: string | null | undefined): string | null {
  if (!workspace) return null
  return resolve(workspace)
}

function stripMarkup(text: string, kind?: string): string {
  if (kind === 'html' || kind === 'svg') {
    return text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  if (kind === 'markdown') {
    return text
      .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ''))
      .replace(/[#>*_`~-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return text
}

function messageText(message: ChatMessage): string {
  return message.content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'thinking') return ''
      if (block.type === 'tool_use') {
        const result = block.result
        return `[工具 ${block.name}] ${result?.ok ? result.output : result?.error ?? ''}`.slice(0, 2000)
      }
      return block.type === 'error' ? block.message : ''
    })
    .filter(Boolean)
    .join('\n')
}

function makeSnippet(text: string, query: string): { snippet: string; highlights: SearchHighlight[] } {
  if (!query) return { snippet: '', highlights: [] }
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const index = lowerText.indexOf(lowerQuery)
  if (index < 0) {
    return { snippet: text.slice(0, 120), highlights: [] }
  }
  const start = Math.max(0, index - 40)
  const end = Math.min(text.length, index + query.length + 80)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  const before = text.slice(start, index)
  const matched = text.slice(index, index + query.length)
  const after = text.slice(index + query.length, end)
  const normalizedBefore = `${prefix}${before}`.replace(/\s+/g, ' ')
  const normalizedMatched = matched.replace(/\s+/g, ' ')
  return {
    snippet: `${normalizedBefore}${normalizedMatched}${after}${suffix}`.replace(/\s+/g, ' '),
    highlights: [{ start: normalizedBefore.length, end: normalizedBefore.length + normalizedMatched.length }]
  }
}

function matchScore(haystack: string, needle: string, base: number, bonus = 0): number {
  if (!needle) return 0
  const index = haystack.toLowerCase().indexOf(needle.toLowerCase())
  if (index < 0) return 0
  if (index === 0) return base + 40 + bonus
  return base + bonus
}

function lineNumberAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1
  return line
}

/* ── 服务 ─────────────────────────────────────────────────────── */

export class SearchService {
  private readonly deps: SearchServiceDeps
  private readonly options: Required<SearchServiceOptions>
  private readonly now: () => number
  private readonly sessionIndex = new Map<string, SessionDoc>()
  /** workspace 绝对路径 → (absolutePath → FileDoc) */
  private readonly workspaceIndex = new Map<string, Map<string, FileDoc>>()
  private sessionSignatures = new Map<string, string>()
  private ready = false
  private building = false
  private started = false
  private lastBuildAt = 0
  private lastRefreshAt = 0
  private lastSessionRevision = 0
  private workspaceSet = new Set<string>()

  constructor(deps: SearchServiceDeps, options: SearchServiceOptions = {}) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.options = {
      maxFilesPerWorkspace: Math.max(100, options.maxFilesPerWorkspace ?? 5000),
      maxFileBytes: Math.max(4096, options.maxFileBytes ?? 512 * 1024),
      maxTextChars: Math.max(1000, options.maxTextChars ?? 20_000),
      autoRefreshMs: Math.max(0, options.autoRefreshMs ?? 1500)
    }
  }

  /** 启动时构建（可重复调用；已构建则只做增量刷新） */
  async start(): Promise<void> {
    if (this.building) return
    this.building = true
    try {
      this.rebuildSessions()
      this.workspaceSet = new Set(
        this.deps
          .listWorkspaces()
          .map((workspace) => normalizeWorkspace(workspace))
          .filter((workspace): workspace is string => Boolean(workspace))
      )
      for (const workspace of this.workspaceSet) this.refreshWorkspaceSync(workspace, true)
      this.ready = true
      this.started = true
      this.lastBuildAt = this.now()
      this.lastRefreshAt = this.now()
      this.lastSessionRevision = this.deps.getSessionRevision?.() ?? 0
    } finally {
      this.building = false
    }
  }

  /** 手动全量重建（供 refresh channel/测试） */
  async rebuild(): Promise<SearchIndexStatus> {
    this.sessionIndex.clear()
    this.workspaceIndex.clear()
    this.sessionSignatures.clear()
    this.workspaceSet.clear()
    this.ready = false
    this.started = false
    await this.start()
    return this.status()
  }

  /** 保存会话后调用：只重索引一个会话（增量） */
  async refreshSession(sessionId: string): Promise<boolean> {
    const session = this.deps.getSession(sessionId)
    if (!session) {
      this.sessionIndex.delete(sessionId)
      this.sessionSignatures.delete(sessionId)
      return false
    }
    this.indexSession(session)
    this.ready = true
    return true
  }

  /** 工具/文件保存后调用：增量刷新一个工作区（按 mtime/size 跳过未变文件） */
  async refreshWorkspace(workspace: string | null | undefined): Promise<void> {
    const normalized = normalizeWorkspace(workspace)
    if (!normalized) return
    this.workspaceSet.add(normalized)
    this.refreshWorkspaceSync(normalized, true)
    this.ready = true
    this.lastRefreshAt = this.now()
  }

  status(): SearchIndexStatus {
    let files = 0
    for (const map of this.workspaceIndex.values()) files += map.size
    let artifacts = 0
    for (const doc of this.sessionIndex.values()) artifacts += doc.artifacts.length
    return {
      ready: this.ready,
      building: this.building,
      sessions: this.sessionIndex.size,
      files,
      artifacts,
      workspaces: [...this.workspaceSet],
      ...(this.lastBuildAt > 0 ? { lastBuiltAt: this.lastBuildAt } : {})
    }
  }

  /** 查询（返回分组结果；空查询返回空） */
  async search(input: SearchQueryInput): Promise<SearchResponse> {
    const startedAt = this.now()
    await this.ensureStarted()
    await this.refreshIfStale()
    const q = typeof input.q === 'string' ? input.q.trim() : ''
    const limit = Math.max(1, Math.min(60, Math.trunc(input.limit ?? 20)))
    const workspace = normalizeWorkspace(input.workspace)
    // 首次查询某个工作区时立即索引，避免它因为自动刷新节流而返回空文件结果。
    if (workspace && !this.workspaceIndex.has(workspace)) {
      this.workspaceSet.add(workspace)
      this.refreshWorkspaceSync(workspace, true)
      this.lastRefreshAt = this.now()
    }
    // 全局搜索：首次查询时补齐启动后才出现的工作区，避免刚新建会话搜不到文件
    if (!workspace) {
      for (const raw of this.deps.listWorkspaces()) {
        const known = normalizeWorkspace(raw)
        if (!known || this.workspaceIndex.has(known)) continue
        this.workspaceSet.add(known)
        this.refreshWorkspaceSync(known, true)
      }
    }
    const groups: SearchGroups = { sessions: [], files: [], artifacts: [] }
    if (!q) {
      return { query: q, groups, total: 0, tookMs: this.now() - startedAt, index: this.status() }
    }
    const perGroup = Math.max(1, Math.ceil(limit / 3))
    groups.sessions = this.searchSessions(q, perGroup, workspace)
    groups.files = workspace ? this.searchFiles(q, workspace, perGroup) : this.searchFilesAll(q, perGroup)
    groups.artifacts = this.searchArtifacts(q, workspace, perGroup)
    for (const group of [groups.sessions, groups.files, groups.artifacts]) {
      group.sort((a, b) => b.score - a.score || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    }
    const total = groups.sessions.length + groups.files.length + groups.artifacts.length
    return {
      query: q,
      groups,
      total,
      tookMs: Math.max(0, this.now() - startedAt),
      index: this.status()
    }
  }

  /* ── 索引构建 ───────────────────────────────────────────────── */

  private async ensureStarted(): Promise<void> {
    if (!this.started) await this.start()
  }

  private async refreshIfStale(): Promise<void> {
    const revision = this.deps.getSessionRevision?.()
    const revisionChanged = revision !== undefined && revision !== this.lastSessionRevision
    if (!revisionChanged && this.now() - this.lastRefreshAt < this.options.autoRefreshMs) return
    this.lastRefreshAt = this.now()
    if (revision !== undefined) this.lastSessionRevision = revision
    try {
      // 会话：按 updatedAt/messageCount 签名增量更新，新增/删除也同步
      const metas = this.deps.listSessions()
      const seen = new Set<string>()
      for (const meta of metas) {
        seen.add(meta.id)
        const signature = `${meta.updatedAt}:${meta.messageCount}:${meta.title}`
        if (this.sessionSignatures.get(meta.id) === signature) continue
        const session = this.deps.getSession(meta.id)
        if (session) this.indexSession(session)
        else this.sessionSignatures.set(meta.id, signature)
      }
      for (const id of [...this.sessionIndex.keys()]) {
        if (!seen.has(id)) {
          this.sessionIndex.delete(id)
          this.sessionSignatures.delete(id)
        }
      }
      // 工作区：同步已知集合，删掉不再被最近工作区/会话引用的文件索引
      const knownWorkspaces = new Set(
        this.deps
          .listWorkspaces()
          .map((workspace) => normalizeWorkspace(workspace))
          .filter((workspace): workspace is string => Boolean(workspace))
      )
      for (const workspace of [...this.workspaceSet]) {
        if (knownWorkspaces.has(workspace)) continue
        this.workspaceSet.delete(workspace)
        this.workspaceIndex.delete(workspace)
      }
      for (const workspace of knownWorkspaces) this.workspaceSet.add(workspace)
      // 只刷新已索引过的目录（增量 stat）
      for (const workspace of this.workspaceSet) this.refreshWorkspaceSync(workspace, false)
    } catch {
      // 索引刷新失败不阻断查询（保留旧索引）
    }
  }

  private rebuildSessions(): void {
    this.sessionIndex.clear()
    this.sessionSignatures.clear()
    for (const meta of this.deps.listSessions()) {
      const session = this.deps.getSession(meta.id)
      if (session) this.indexSession(session)
    }
  }

  private indexSession(session: Session): void {
    const visibleMessages = session.messages.filter((message) => !message.hidden)
    const messages: SessionDoc['messages'] = []
    let messageBudget = SEARCH_SESSION_TEXT_BUDGET
    for (let index = visibleMessages.length - 1; index >= 0 && messageBudget > 0; index -= 1) {
      const message = visibleMessages[index]
      const text = messageText(message).slice(0, Math.min(this.options.maxTextChars, messageBudget))
      if (!text.trim()) continue
      messages.unshift({ id: message.id, role: message.role, text })
      messageBudget -= text.length
    }
    const artifacts: SessionDoc['artifacts'] = []
    let artifactBudget = SEARCH_SESSION_ARTIFACT_BUDGET
    for (let index = session.artifacts.length - 1; index >= 0 && artifactBudget > 0; index -= 1) {
      const artifact = session.artifacts[index]
      const content = artifact.content
        ? stripMarkup(artifact.content, artifact.kind).slice(0, Math.min(this.options.maxTextChars, artifactBudget))
        : undefined
      artifacts.unshift({
        artifact: content ? { ...artifact, content } : { ...artifact, content: undefined },
        sessionTitle: session.title
      })
      artifactBudget -= content?.length ?? 0
    }
    const doc: SessionDoc = {
      id: session.id,
      title: session.title,
      workspace: normalizeWorkspace(session.workspace),
      updatedAt: session.updatedAt,
      messages,
      artifacts
    }
    this.sessionIndex.set(session.id, doc)
    this.sessionSignatures.set(session.id, `${session.updatedAt}:${session.messages.length}:${session.title}`)
    if (doc.workspace) this.workspaceSet.add(doc.workspace)
  }

  private refreshWorkspaceSync(workspace: string, force: boolean): void {
    const normalized = normalizeWorkspace(workspace)
    if (!normalized) return
    const existing = this.workspaceIndex.get(normalized) ?? new Map<string, FileDoc>()
    const next = new Map<string, FileDoc>()
    let scanned = 0
    const maxFiles = this.options.maxFilesPerWorkspace

    const walk = (dir: string, depth: number): void => {
      if (depth > 8 || scanned >= maxFiles) return
      let entries: Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      for (const entry of entries) {
        if (scanned >= maxFiles) return
        if (entry.isSymbolicLink()) continue
        const absolute = join(dir, entry.name)
        if (this.shouldIgnorePath(absolute, entry.name)) continue
        if (entry.isDirectory()) {
          walk(absolute, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        scanned += 1
        const cached = existing.get(absolute)
        try {
          const stat = statSync(absolute)
          if (!force && cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            next.set(absolute, cached)
            continue
          }
          if (stat.size > this.options.maxFileBytes) {
            next.set(absolute, {
              absolutePath: absolute,
              relPath: relative(normalized, absolute).split('\\').join('/'),
              name: entry.name,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              text: null,
              binary: true
            })
            continue
          }
          const buffer = readFileSync(absolute)
          const binary = buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)
          next.set(absolute, {
            absolutePath: absolute,
            relPath: relative(normalized, absolute).split('\\').join('/'),
            name: entry.name,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            text: binary ? null : buffer.toString('utf8').slice(0, this.options.maxTextChars),
            binary
          })
        } catch {
          // 单文件读取失败跳过
        }
      }
    }
    walk(normalized, 0)
    // walk 从头构建 next（已删除/被忽略的文件自然不在 next 中）
    this.workspaceIndex.set(normalized, next)
  }

  private shouldIgnorePath(absolute: string, name: string): boolean {
    if (IGNORED_DIR_NAMES.has(name)) return true
    const normalized = absolute.split('\\').join('/').toLowerCase()
    if (this.deps.dataDir) {
      const dataDir = this.deps.dataDir.split('\\').join('/').toLowerCase().replace(/\/+$/, '')
      if (normalized === dataDir || normalized.startsWith(`${dataDir}/`)) return true
    }
    return false
  }

  /* ── 查询 ───────────────────────────────────────────────────── */

  private searchSessions(query: string, limit: number, workspace: string | null = null): SearchHit[] {
    const hits: SearchHit[] = []
    for (const doc of this.sessionIndex.values()) {
      // 工作区隔离：限定工作区时不返回其它工作区/未绑定工作区的会话
      if (workspace && doc.workspace !== workspace) continue
      const titleScore = matchScore(doc.title, query, 120)
      let bestMessage: SessionDoc['messages'][number] | null = null
      let bestMessageScore = 0
      for (const message of doc.messages) {
        const score = matchScore(message.text, query, 40)
        if (score > bestMessageScore) {
          bestMessageScore = score
          bestMessage = message
        }
      }
      const score = Math.max(titleScore, bestMessageScore)
      if (score <= 0) continue
      const source = titleScore >= bestMessageScore ? doc.title : bestMessage?.text ?? ''
      const snippet = makeSnippet(source, query)
      // 近期会话优先：0-8 天的衰减加分（旧实现按绝对天数取模，顺序与新旧无关）
      const ageDays = Math.max(0, (this.now() - (doc.updatedAt ?? 0)) / 86_400_000)
      const recencyBonus = Math.max(0, 8 - Math.floor(ageDays))
      hits.push({
        kind: 'session',
        id: doc.id,
        title: doc.title,
        snippet: snippet.snippet,
        highlights: snippet.highlights,
        score: score + recencyBonus,
        sessionId: doc.id,
        ...(titleScore < bestMessageScore && bestMessage ? { messageId: bestMessage.id, role: bestMessage.role } : {}),
        updatedAt: doc.updatedAt
      })
      if (hits.length >= limit * 2) break
    }
    return hits.slice(0, limit)
  }

  private searchFilesAll(query: string, limit: number): SearchHit[] {
    const hits: SearchHit[] = []
    for (const workspace of this.workspaceIndex.keys()) {
      hits.push(...this.searchFiles(query, workspace, limit))
    }
    hits.sort((a, b) => b.score - a.score || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return hits.slice(0, limit)
  }

  private searchFiles(query: string, workspace: string, limit: number): SearchHit[] {
    const index = this.workspaceIndex.get(workspace)
    if (!index) return []
    const hits: SearchHit[] = []
    for (const doc of index.values()) {
      const nameScore = matchScore(doc.name, query, 70)
      const pathScore = matchScore(doc.relPath, query, 45)
      const contentScore = doc.text ? matchScore(doc.text, query, 25) : 0
      const score = Math.max(nameScore, pathScore, contentScore)
      if (score <= 0) continue
      let snippet = makeSnippet(doc.text ? '' : doc.relPath, query)
      let line: number | undefined
      if (contentScore > 0 && doc.text) {
        snippet = makeSnippet(doc.text, query)
        const indexInText = doc.text.toLowerCase().indexOf(query.toLowerCase())
        if (indexInText >= 0) line = lineNumberAt(doc.text, indexInText)
      } else {
        snippet = makeSnippet(doc.relPath, query)
      }
      hits.push({
        kind: 'file',
        id: doc.absolutePath,
        title: doc.name,
        snippet: snippet.snippet,
        highlights: snippet.highlights,
        score,
        path: doc.relPath,
        absolutePath: doc.absolutePath,
        ...(line ? { line } : {}),
        updatedAt: doc.mtimeMs
      })
      if (hits.length >= limit * 3) break
    }
    return hits.slice(0, limit)
  }

  private searchArtifacts(query: string, workspace: string | null, limit: number): SearchHit[] {
    const hits: SearchHit[] = []
    for (const doc of this.sessionIndex.values()) {
      if (workspace && doc.workspace !== workspace) continue
      for (const { artifact, sessionTitle } of doc.artifacts) {
        const titleScore = matchScore(artifact.title, query, 80)
        const contentScore = artifact.content ? matchScore(artifact.content, query, 25) : 0
        const score = Math.max(titleScore, contentScore)
        if (score <= 0) continue
        const snippet = makeSnippet(titleScore >= contentScore ? artifact.title : artifact.content ?? '', query)
        hits.push({
          kind: 'artifact',
          id: artifact.id,
          title: artifact.title || `未命名产物（${sessionTitle}）`,
          snippet: snippet.snippet,
          highlights: snippet.highlights,
          score,
          sessionId: doc.id,
          artifactId: artifact.id,
          artifactKind: artifact.kind,
          ...(artifact.path ? { path: artifact.path } : {}),
          updatedAt: artifact.updatedAt
        })
        if (hits.length >= limit * 3) break
      }
      if (hits.length >= limit * 3) break
    }
    return hits.slice(0, limit)
  }
}

export { normalizeWorkspace as normalizeSearchWorkspace }
