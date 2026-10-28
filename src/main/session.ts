// 会话仓库、导出、快照与检查点：由 session-*、snapshot-restore、checkpoint-service 扁平合并。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync, copyFileSync, openSync, readSync, closeSync, realpathSync, statSync, lstatSync } from 'node:fs'
import { join, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ChatMessage, CreateSessionInput, Goal, ModelRef, PermissionMode, ReasoningEffort, ResearchState, Session, SessionMeta, SessionMode, SessionPlan, TodoItem, Usage, CheckpointFile, RewindPreview, RewindResult, RewindScope, TurnCheckpoint } from '../shared/types'
import { userMessageDisplayText, messagePlainText } from '../shared/types'
import { isReasoningEffort } from '../shared/contracts'
import { dataPath, ensureDataDirs } from './workspace'
import { log } from './logger'
import { createHash } from 'node:crypto'
import { inspectWorkspacePath } from '@core/tools'



const SAFE_ID = /^[A-Za-z0-9_-]{4,80}$/


function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}


function isStoredMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return (
    typeof message.id === 'string' &&
    typeof message.role === 'string' &&
    ['user', 'assistant', 'tool', 'system'].includes(message.role) &&
    Array.isArray(message.content)
  )
}


function isStoredGoal(value: unknown): value is Goal {
  if (!value || typeof value !== 'object') return false
  const goal = value as Record<string, unknown>
  return typeof goal.id === 'string' && typeof goal.status === 'string' && typeof goal.objective === 'string'
}


function isStoredPlan(value: unknown): value is SessionPlan {
  if (!value || typeof value !== 'object') return false
  const plan = value as Record<string, unknown>
  return (
    typeof plan.id === 'string' &&
    typeof plan.title === 'string' &&
    typeof plan.summary === 'string' &&
    Array.isArray(plan.steps) &&
    typeof plan.status === 'string' &&
    ['pending', 'executing', 'completed', 'rejected'].includes(plan.status)
  )
}


function isStoredResearch(value: unknown): value is ResearchState {
  if (!value || typeof value !== 'object') return false
  const research = value as Record<string, unknown>
  return (
    typeof research.topic === 'string' &&
    (research.depth === 'quick' || research.depth === 'standard' || research.depth === 'deep') &&
    (research.status === 'idle' ||
      research.status === 'planning' ||
      research.status === 'ready' ||
      research.status === 'searching' ||
      research.status === 'completed' ||
      research.status === 'stopped' ||
      research.status === 'error') &&
    (research.plan === undefined || (typeof research.plan === 'string' && research.plan.length <= 20_000)) &&
    (research.steer === undefined || (typeof research.steer === 'string' && research.steer.length <= 2_000)) &&
    (research.gap === undefined || typeof research.gap === 'string') &&
    (research.artifactId === undefined || typeof research.artifactId === 'string') &&
    typeof research.round === 'number' &&
    typeof research.maxRounds === 'number' &&
    typeof research.minSources === 'number' &&
    typeof research.sourceCount === 'number' &&
    typeof research.startedAt === 'number' &&
    typeof research.updatedAt === 'number'
  )
}


/**
 * 兼容旧会话/半损坏文件：只补齐必要结构，不猜测业务内容。
 * 路径与 id 不匹配时拒绝，避免把另一个会话文件当成目标会话。
 */
function normalizeStoredSession(raw: unknown, expectedId?: string): Session | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const id = typeof item.id === 'string' ? item.id : expectedId
  if (!id || !SAFE_ID.test(id) || (expectedId && id !== expectedId)) return null

  const messages = Array.isArray(item.messages) ? item.messages.filter(isStoredMessage) : []
  const todos = Array.isArray(item.todos) ? (item.todos as TodoItem[]) : []
  const artifacts = Array.isArray(item.artifacts) ? (item.artifacts as Session['artifacts']) : []
  const usageRaw = item.usage && typeof item.usage === 'object' ? (item.usage as Record<string, unknown>) : {}
  const usage: Usage = {
    ...usageRaw,
    inputTokens: finiteNumber(usageRaw.inputTokens),
    outputTokens: finiteNumber(usageRaw.outputTokens)
  }
  const modelRaw = item.model && typeof item.model === 'object' ? (item.model as Record<string, unknown>) : {}
  const contextWindow = typeof modelRaw.contextWindow === 'number' && Number.isInteger(modelRaw.contextWindow) && modelRaw.contextWindow > 0
    ? modelRaw.contextWindow
    : undefined
  const model: ModelRef =
    typeof modelRaw.providerId === 'string' && typeof modelRaw.modelId === 'string'
      ? {
          providerId: modelRaw.providerId,
          modelId: modelRaw.modelId,
          ...(contextWindow ? { contextWindow } : {})
        }
      : { providerId: '', modelId: '' }
  const permissionMode: PermissionMode =
    item.permissionMode === 'read-only' || item.permissionMode === 'ask' || item.permissionMode === 'auto'
      ? item.permissionMode
      : 'ask'
  const mode: SessionMode | undefined =
    item.mode === 'chat' || item.mode === 'work' || item.mode === 'research' ? item.mode : undefined
  const reasoningEffort: ReasoningEffort | undefined = isReasoningEffort(item.reasoningEffort)
    ? item.reasoningEffort
    : undefined
  const now = Date.now()
  const createdAt = finiteNumber(item.createdAt, now)
  const updatedAt = finiteNumber(item.updatedAt, createdAt)

  return {
    id,
    title: typeof item.title === 'string' && item.title.trim() ? item.title : '新对话',
    workspace: typeof item.workspace === 'string' && item.workspace.trim() ? item.workspace : null,
    model,
    permissionMode,
    ...(mode ? { mode } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(mode !== 'chat' && mode !== 'research' && item.planMode === true ? { planMode: true } : {}),
    ...(isStoredResearch(item.research) ? { research: item.research } : {}),
    ...(isStoredPlan(item.plan) ? { plan: item.plan } : {}),
    createdAt,
    updatedAt,
    messageCount: messages.length,
    messages,
    todos,
    artifacts,
    usage,
    ...(item.pinned === true ? { pinned: true } : {}),
    ...(item.archived === true ? { archived: true } : {}),
    ...(item.demo === true ? { demo: true } : {}),
    ...(isStoredGoal(item.goal) ? { goal: item.goal } : {})
  }
}


export function makeId(prefix = 's'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}


export function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return '新对话'
  return clean.length > 26 ? `${clean.slice(0, 26)}…` : clean
}


export function deriveMeta(session: Session): SessionMeta {
  const lastUser = [...session.messages].reverse().find((m) => m.role === 'user' && !m.hidden)
  const preview = lastUser ? userMessageDisplayText(lastUser).replace(/\s+/g, ' ').slice(0, 120) : ''
  return {
    id: session.id,
    title: session.title,
    workspace: session.workspace,
    model: session.model,
    permissionMode: session.permissionMode,
    ...(session.mode ? { mode: session.mode } : {}),
    ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
    ...(session.planMode ? { planMode: true } : {}),
    ...(session.plan ? { plan: session.plan } : {}),
    ...(session.research ? { research: session.research } : {}),
    ...(session.pinned ? { pinned: true } : {}),
    ...(session.archived ? { archived: true } : {}),
    ...(session.demo ? { demo: true } : {}),
    ...(session.temporary ? { temporary: true } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    preview,
    todoProgress: session.todos.length
      ? {
          completed: session.todos.filter((t) => t.status === 'completed').length,
          total: session.todos.length
        }
      : undefined
  }
}


export class SessionStore {
  private revision = 0
  /** 临时对话只存在内存中；关闭应用后自然消失，不产生任何会话文件。 */
  private ephemeral = new Map<string, Session>()

  constructor(private readonly dataDir?: string) {
    if (this.dataDir) {
      mkdirSync(join(this.dataDir, 'sessions'), { recursive: true })
    } else {
      ensureDataDirs()
    }
  }

  private sessionsDir(): string {
    const dir = this.dataDir ? join(this.dataDir, 'sessions') : dataPath('sessions')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  private fileFor(id: string): string {
    return join(this.sessionsDir(), `${id}.json`)
  }

  private readAllMetas(): SessionMeta[] {
    const dir = this.sessionsDir()
    const metas: SessionMeta[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown
        const session = normalizeStoredSession(raw, name.slice(0, -'.json'.length))
        if (!session) {
          log.warn('skip invalid session file', { name })
          continue
        }
        metas.push(deriveMeta(session))
      } catch (err) {
        log.warn('skip corrupted session file', { name, error: String(err) })
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  list(): SessionMeta[] {
    return this.readAllMetas().slice(0, 300)
  }

  /** 供一次性历史回填使用：不受侧栏列表 300 条上限影响。 */
  listAll(): SessionMeta[] {
    return this.readAllMetas()
  }

  get(id: string): Session | null {
    if (!SAFE_ID.test(id)) return null
    const temp = this.ephemeral.get(id)
    if (temp) return this.cloneSession(temp)
    const file = this.fileFor(id)
    if (!existsSync(file)) return null
    try {
      return normalizeStoredSession(JSON.parse(readFileSync(file, 'utf8')) as unknown, id)
    } catch (err) {
      log.error('session parse failed', { id, error: String(err) })
      return null
    }
  }

  create(input: CreateSessionInput & { defaultModel: ModelRef; defaultPermission: PermissionMode }): Session {
    const now = Date.now()
    const temporary = input.temporary === true
    const mode: SessionMode | undefined =
      input.mode === 'chat' || input.mode === 'work' || input.mode === 'research' ? input.mode : undefined
    const session: Session = {
      id: makeId(temporary ? 'tmp' : 's'),
      title: input.title ?? (temporary ? '临时对话' : '新对话'),
      workspace: input.workspace ?? null,
      model: input.model ?? input.defaultModel,
      permissionMode: input.permissionMode ?? input.defaultPermission,
      ...(mode ? { mode } : {}),
      ...(input.demo === true ? { demo: true } : {}),
      ...(temporary ? { temporary: true } : {}),
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      messages: [],
      todos: [],
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0 }
    }
    this.save(session)
    return this.get(session.id) ?? session
  }

  private cloneSession(session: Session): Session {
    return JSON.parse(JSON.stringify(session)) as Session
  }

  /** 供「清除全部对话」统计与清理使用；临时对话不在 list() 中。 */
  listTemporaryIds(): string[] {
    return [...this.ephemeral.keys()]
  }

  /** 会话写入/删除版本：搜索索引据此在下次查询时立即刷新，不受节流窗口影响。 */
  getRevision(): number {
    return this.revision
  }

  save(session: Session): Session {
    if (!SAFE_ID.test(session.id)) throw new Error('非法会话 id')
    session.updatedAt = Date.now()
    session.messageCount = session.messages.length
    if (session.temporary || this.ephemeral.has(session.id)) {
      session.temporary = true
      // 内存快照 + 返回副本：保存后继续改对象不会绕过下一次 save。
      this.ephemeral.set(session.id, this.cloneSession(session))
      return session
    }
    const file = this.fileFor(session.id)
    const tmp = `${file}.${process.pid}.tmp`
    const content = JSON.stringify(session, null, 2)
    writeFileSync(tmp, content, 'utf8')
    // Windows 上杀毒/索引服务可能短暂占用目标文件，rename 会报 EPERM/EBUSY。
    let renamed = false
    for (let attempt = 0; attempt < 4 && !renamed; attempt += 1) {
      try {
        renameSync(tmp, file)
        renamed = true
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
        if (attempt === 3) {
          // 最后兜底：至少把最新内容写进正式文件，避免整轮会话丢失
          writeFileSync(file, content, 'utf8')
          try {
            unlinkSync(tmp)
          } catch {
          }
          renamed = true
          log.warn('session rename retried out, wrote in place', { id: session.id, code })
          break
        }
        const wait = 40 * (attempt + 1)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
      }
    }
    this.revision += 1
    return session
  }

  remove(id: string): void {
    if (!SAFE_ID.test(id)) return
    if (this.ephemeral.delete(id)) return
    const file = this.fileFor(id)
    if (existsSync(file)) {
      unlinkSync(file)
      this.revision += 1
    }
  }

  /** 删除磁盘上的全部会话（包含损坏/无法解析的会话文件）与内存中的临时对话。 */
  clearAll(): number {
    const dir = this.sessionsDir()
    let removed = this.ephemeral.size
    this.ephemeral.clear()
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        rmSync(join(dir, name), { force: true, maxRetries: 4, retryDelay: 50 })
        removed += 1
      } catch (err) {
        log.warn('session clear failed', { name, error: String(err) })
      }
    }
    this.revision += 1
    return removed
  }

  rename(id: string, title: string): SessionMeta | null {
    const session = this.get(id)
    if (!session) return null
    session.title = title.trim().slice(0, 80) || '新对话'
    this.save(session)
    return deriveMeta(session)
  }

  setModel(id: string, model: ModelRef, demo?: boolean): SessionMeta | null {
    const session = this.get(id)
    if (!session) return null
    session.model = model
    if (demo === true) session.demo = true
    else if (demo === false) delete session.demo
    this.save(session)
    return deriveMeta(session)
  }

  setPermissionMode(id: string, mode: PermissionMode): SessionMeta | null {
    const session = this.get(id)
    if (!session) return null
    session.permissionMode = mode
    this.save(session)
    return deriveMeta(session)
  }

  setReasoningEffort(id: string, effort: ReasoningEffort): SessionMeta | null {
    const session = this.get(id)
    if (!session) return null
    session.reasoningEffort = effort
    this.save(session)
    return deriveMeta(session)
  }

  setPinned(id: string, pinned: boolean): SessionMeta | null {
    const session = this.get(id)
    if (!session) return null
    session.pinned = pinned
    this.save(session)
    return deriveMeta(session)
  }

  setArchived(id: string, archived: boolean): SessionMeta | null {
    const session = this.get(id)
    if (!session) return null
    session.archived = archived
    this.save(session)
    return deriveMeta(session)
  }

  /** 从某条消息（含）分叉：新会话保留此前完整消息，独立继续。 */
  branch(id: string, messageId: string, title?: string): Session | null {
    const source = this.get(id)
    if (!source) return null
    const index = source.messages.findIndex((message) => message.id === messageId)
    if (index < 0) return null
    const now = Date.now()
    const session: Session = {
      ...source,
      id: makeId(source.temporary ? 'tmp' : 's'),
      ...(source.temporary ? { temporary: true } : {}),
      title: (title?.trim() || `${source.title} · 分支`).slice(0, 80),
      // 检查点按会话隔离：分叉后的旧阶段节点没有可回退的记录，复制消息时去掉标记。
      messages: source.messages.slice(0, index + 1).map((message) => {
        const copy = JSON.parse(JSON.stringify(message)) as ChatMessage
        delete copy.stageBoundary
        return copy
      }),
      todos: source.todos.map((todo) => ({ ...todo })),
      artifacts: source.artifacts.map((artifact) => ({ ...artifact })),
      pinned: false,
      archived: false,
      goal: null,
      plan: null,
      planMode: false,
      // 新分支的 token/费用从 0 开始；上下文占用在下一轮运行时重新估算
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        ...(source.usage.contextLimit ? { contextLimit: source.usage.contextLimit } : {})
      },
      createdAt: now,
      updatedAt: now,
      messageCount: index + 1
    }
    this.save(session)
    return session
  }

  /**
   * 消息操作的基础裁剪：
   * - keepMessage=false 删除该消息及之后；
   * - keepMessage=true 保留该消息，删除它之后的全部内容。
   */
  truncate(id: string, messageId: string, keepMessage: boolean): Session | null {
    const session = this.get(id)
    if (!session) return null
    const index = session.messages.findIndex((message) => message.id === messageId)
    if (index < 0) return null
    session.messages = session.messages.slice(0, keepMessage ? index + 1 : index)
    this.save(session)
    return session
  }

  /** 首条用户消息自动命名，仅在标题仍是默认值时 */
  autoName(session: Session, text: string): void {
    const current = (session.title ?? '').trim()
    // 「临时对话」也是系统默认标题；首次正常发言后仍然应该得到可识别的名字。
    if (!/^(新对话|临时对话)?$/.test(current) || !text.trim()) return
    session.title = deriveTitle(text)
  }

  /** Agent 运行结束后的持久化 */
  applyRunResult(
    session: Session,
    input: {
      messages: ChatMessage[]
      todos?: TodoItem[]
      artifacts?: Session['artifacts']
      usage?: Usage
      title?: string
      plan?: SessionPlan | null
      planMode?: boolean
    }
  ): Session {
    const existingIds = new Set(session.messages.map((m) => m.id))
    for (const message of input.messages) {
      const index = session.messages.findIndex((m) => m.id === message.id)
      if (index >= 0) session.messages[index] = message
      else if (!existingIds.has(message.id)) session.messages.push(message)
    }
    if (input.todos) session.todos = input.todos
    if (input.artifacts) {
      const byId = new Map(session.artifacts.map((a) => [a.id, a]))
      for (const artifact of input.artifacts) byId.set(artifact.id, artifact)
      session.artifacts = [...byId.values()]
    }
    if (input.usage) session.usage = input.usage
    if (input.title) session.title = input.title
    if (input.plan !== undefined) session.plan = input.plan
    if (input.planMode !== undefined) session.planMode = input.planMode
    return this.save(session)
  }
}


let instance: SessionStore | null = null

export function getSessionStore(): SessionStore {
  if (!instance) instance = new SessionStore()
  return instance
}


function timeText(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return new Date(timestamp).toISOString()
  }
}


function toolLines(message: ChatMessage): string[] {
  const lines: string[] = []
  for (const block of message.content) {
    if (block.type !== 'tool_use') continue
    const result = block.result
    const state = result ? (result.ok ? '完成' : '失败') : block.status
    lines.push(`- 工具 \`${block.name}\`：${block.title || '调用'}（${state}）`)
    if (result?.output) {
      const text = result.output.replace(/\s+/g, ' ').trim()
      if (text) lines.push(`  > ${text.slice(0, 240)}${text.length > 240 ? '…' : ''}`)
    }
    if (result?.error) lines.push(`  > 错误：${result.error.slice(0, 240)}`)
  }
  return lines
}


export function sessionToMarkdown(session: Session): string {
  const lines = [
    `# ${session.title}`,
    '',
    `- 导出时间：${timeText(Date.now())}`,
    `- 创建时间：${timeText(session.createdAt)}`,
    `- 工作区：${session.workspace ?? '（未绑定）'}`,
    `- 模型：${session.model.providerId} / ${session.model.modelId}`,
    `- 消息数：${session.messages.length}`,
    ''
  ]
  for (const message of session.messages) {
    if (message.role === 'system' && message.content.some((block) => block.type === 'text' && block.text.includes('历史对话摘要'))) {
      lines.push('## 上下文摘要', '', messagePlainText(message).replace(/^\[历史对话摘要[^\]]*\]\s*/, '').trim(), '')
      continue
    }
    if (message.role === 'user') {
      lines.push(`## 用户 · ${timeText(message.createdAt)}`, '', userMessageDisplayText(message) || '（附件）', '')
      if (message.attachments?.length) lines.push(`附件：${message.attachments.map((item) => item.name).join('、')}`, '')
      continue
    }
    if (message.role === 'assistant') {
      lines.push(`## 助手 · ${timeText(message.createdAt)}`, '')
      const text = message.content
        .filter((block): block is import('../shared/types').TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n\n')
        .trim()
      if (text) lines.push(text, '')
      const tools = toolLines(message)
      if (tools.length) lines.push('### 工具调用', '', ...tools, '')
      if (message.interrupted) lines.push('> 本轮已停止', '')
      if (message.error) lines.push(`> 错误：${message.error.message}`, '')
    }
  }
  const todoLines = session.todos.map((todo) => `- [${todo.status === 'completed' ? 'x' : ' '}] ${todo.text}`)
  if (todoLines.length) lines.push('## 计划', '', ...todoLines, '')
  if (session.artifacts.length) {
    lines.push('## 产物', '')
    for (const artifact of session.artifacts) lines.push(`- ${artifact.title}（${artifact.kind}）${artifact.path ?? ''}`)
  }
  return `${lines.join('\n')}\n`
}


export function sessionExportContent(session: Session, format: 'markdown' | 'json'): { filename: string; content: string } {
  const safeTitle = session.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'Morrow 对话'
  if (format === 'json') {
    return { filename: `${safeTitle}.json`, content: JSON.stringify(session, null, 2) }
  }
  return { filename: `${safeTitle}.md`, content: sessionToMarkdown(session) }
}


export const RESTORE_MANIFEST_FILE = '.restore.json'


export interface RestoreSnapshotInput {
  /** 当前会话的快照根目录（<userData>/snapshots/<sessionId>） */
  snapshotRoot: string
  /** 写前备份文件路径（<snapshotRoot>/<toolUseId>/<filename>） */
  snapshotPath: string
  /** 要恢复的目标文件 */
  targetPath: string
  /** 会话工作区（恢复目标必须在其内部） */
  workspace: string | null
}


export type RestoreSnapshotOutcome =
  | { ok: true; written: boolean; message: string }
  | {
      ok: false
      code:
        | 'INVALID_SNAPSHOT'
        | 'SNAPSHOT_MISSING'
        | 'NO_WORKSPACE'
        | 'OUTSIDE_WORKSPACE'
        | 'UNDO_CONFLICT'
        | 'UNDO_UNVERIFIABLE'
        | 'RESTORE_FAILED'
      message: string
      hint?: string
    }


interface RestoreManifest {
  targetPath?: string
  beforeHash?: string | null
  afterHash?: string
}


function fail(
  code: Extract<RestoreSnapshotOutcome, { ok: false }>['code'],
  message: string,
  hint?: string
): RestoreSnapshotOutcome {
  return { ok: false, code, message, ...(hint ? { hint } : {}) }
}


/** 严格判断 child 是否在 parent 内（跨盘 relative 返回绝对路径，必须拒绝） */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}


function samePath(a: string, b: string): boolean {
  const fold = (value: string): string => {
    const absolute = resolve(value)
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }
  return fold(a) === fold(b)
}


function hashFileSync(path: string): string {
  const fd = openSync(path, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let position = 0
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, position)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
      position += read
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}


function readManifest(snapshotPath: string): RestoreManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dirname(snapshotPath), RESTORE_MANIFEST_FILE), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    return {
      ...(typeof record.targetPath === 'string' ? { targetPath: record.targetPath } : {}),
      ...(typeof record.beforeHash === 'string' || record.beforeHash === null ? { beforeHash: record.beforeHash } : {}),
      ...(typeof record.afterHash === 'string' ? { afterHash: record.afterHash } : {})
    }
  } catch {
    return null
  }
}


/** 原子复制（避免打断时留下半个文件；不把整个快照读进内存） */
function atomicCopy(target: string, source: string): void {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.restore.tmp`
  try {
    copyFileSync(source, tmp)
    renameSync(tmp, target)
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 清理失败不影响结果
    }
  }
}


export function restoreSnapshotSafely(input: RestoreSnapshotInput): RestoreSnapshotOutcome {
  try {
    const snapshotRoot = resolve(input.snapshotRoot)
    const snapshot = resolve(input.snapshotPath)
    if (!isInside(snapshot, snapshotRoot)) {
      return fail('INVALID_SNAPSHOT', '快照路径不合法。')
    }

    let rootReal: string
    let snapshotReal: string
    try {
      rootReal = realpathSync(snapshotRoot)
      snapshotReal = realpathSync(snapshot)
    } catch {
      return fail('SNAPSHOT_MISSING', '这个快照已经不存在了。')
    }
    if (!isInside(snapshotReal, rootReal)) {
      return fail('INVALID_SNAPSHOT', '快照路径不合法。')
    }
    // 只接受 <toolUseId>/<filename> 两层；不能把 .restore.json 或更深层文件当备份恢复
    const relativeSnapshot = relative(rootReal, snapshotReal)
    const parts = relativeSnapshot.split(sep)
    if (parts.length !== 2 || !parts[0] || !parts[1] || parts[1] === RESTORE_MANIFEST_FILE) {
      return fail('INVALID_SNAPSHOT', '快照路径不合法。')
    }
    let snapshotStat
    try {
      snapshotStat = statSync(snapshotReal)
    } catch {
      return fail('SNAPSHOT_MISSING', '这个快照已经不存在了。')
    }
    if (!snapshotStat.isFile()) return fail('INVALID_SNAPSHOT', '快照不是普通文件。')

    if (!input.workspace) return fail('NO_WORKSPACE', '这个对话没有绑定工作区，不能恢复文件。')
    // 用与工具一致的 realpath 沙箱判断目标是否真的在工作区内（防符号链接越界）
    let resolvedTarget: ReturnType<typeof inspectWorkspacePath>
    try {
      resolvedTarget = inspectWorkspacePath(input.targetPath, input.workspace)
    } catch {
      return fail('OUTSIDE_WORKSPACE', '要恢复的文件不在工作区内，已拒绝。')
    }
    if (!resolvedTarget.inside) {
      return fail('OUTSIDE_WORKSPACE', '要恢复的文件不在工作区内，已拒绝。')
    }
    const target = resolvedTarget.absolute
    const targetReal = resolvedTarget.real

    const manifest = readManifest(snapshotReal)
    if (
      !manifest ||
      typeof manifest.targetPath !== 'string' ||
      typeof manifest.afterHash !== 'string' ||
      typeof manifest.beforeHash !== 'string'
    ) {
      return fail(
        'UNDO_UNVERIFIABLE',
        '无法确认这个快照对应哪次修改，已拒绝自动覆盖。',
        '可以先把当前文件另存一份，或从备份中手动恢复。'
      )
    }
    if (!samePath(manifest.targetPath, target)) {
      return fail('UNDO_CONFLICT', '快照记录的目标文件与要恢复的文件不一致，已拒绝。')
    }
    // 备份内容必须与清单记录一致，防止快照文件被替换后当成别的版本恢复
    if (hashFileSync(snapshotReal) !== manifest.beforeHash) {
      return fail('UNDO_UNVERIFIABLE', '备份内容与撤销记录不一致，已拒绝自动覆盖。')
    }

    let currentExists = false
    try {
      const current = statSync(targetReal)
      if (!current.isFile()) {
        return fail('UNDO_CONFLICT', '要恢复的目标不是普通文件，已拒绝。')
      }
      currentExists = true
    } catch {
      currentExists = false
    }
    const currentHash = currentExists ? hashFileSync(targetReal) : null

    if (currentExists) {
      if (currentHash !== manifest.afterHash) {
        if (currentHash === manifest.beforeHash) {
          return { ok: true, written: false, message: '文件已经是修改前的内容，无需再次撤销。' }
        }
        return fail(
          'UNDO_CONFLICT',
          '文件在 Morrow 修改之后又被改过，撤销会覆盖这些新改动，已拒绝。',
          '可以先把当前文件另存一份，再手动恢复快照内容。'
        )
      }
    }

    atomicCopy(targetReal, snapshotReal)
    return { ok: true, written: true, message: '已恢复到这次修改之前的内容。' }
  } catch (err) {
    return fail('RESTORE_FAILED', `恢复文件失败：${err instanceof Error ? err.message : String(err)}`)
  }
}


const CHECKPOINT_SAFE_ID = /^[A-Za-z0-9_-]{4,100}$/

const MAX_CHECKPOINTS = 100

const MAX_LABEL = 160


function sha256File(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null
    const hash = createHash('sha256')
    hash.update(readFileSync(path))
    return hash.digest('hex')
  } catch {
    return null
  }
}


function checkpointIsInside(root: string, target: string): boolean {
  const normalize = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = normalize(resolve(root))
  const candidate = normalize(resolve(target))
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  return candidate === base || candidate.startsWith(prefix)
}


function normalizeCheckpoint(raw: unknown, sessionId: string): TurnCheckpoint | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  if (
    typeof item.id !== 'string' ||
    !CHECKPOINT_SAFE_ID.test(item.id) ||
    item.sessionId !== sessionId ||
    typeof item.messageId !== 'string' ||
    typeof item.label !== 'string' ||
    !Array.isArray(item.files)
  ) {
    return null
  }
  const files: CheckpointFile[] = []
  for (const entry of item.files) {
    if (!entry || typeof entry !== 'object') continue
    const file = entry as Record<string, unknown>
    if (typeof file.path !== 'string' || typeof file.existed !== 'boolean') continue
    files.push({
      path: file.path,
      existed: file.existed,
      beforeHash: typeof file.beforeHash === 'string' ? file.beforeHash : null,
      afterHash: typeof file.afterHash === 'string' ? file.afterHash : null,
      ...(typeof file.snapshotPath === 'string' ? { snapshotPath: file.snapshotPath } : {})
    })
  }
  return {
    id: item.id,
    sessionId,
    messageId: item.messageId,
    messageIndex: typeof item.messageIndex === 'number' ? item.messageIndex : 0,
    label: item.label.slice(0, MAX_LABEL),
    kind: item.kind === 'stage' ? 'stage' : 'turn',
    keepMessage: item.keepMessage === true,
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
    files,
    todos: Array.isArray(item.todos) ? (item.todos as TurnCheckpoint['todos']) : [],
    artifactIds: Array.isArray(item.artifactIds)
      ? item.artifactIds.filter((id): id is string => typeof id === 'string')
      : [],
    plan: item.plan && typeof item.plan === 'object' ? (item.plan as TurnCheckpoint['plan']) : null,
    planMode: item.planMode === true
  }
}


interface RestorePlanEntry {
  pre: CheckpointFile
  expectedAfter: string | null
}


export class CheckpointService {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly dataDir?: string
  ) {}

  private root(sessionId: string): string {
    return this.dataDir
      ? join(this.dataDir, 'checkpoints', sessionId)
      : dataPath('checkpoints', sessionId)
  }

  private snapshotRoot(sessionId: string): string {
    return this.dataDir ? join(this.dataDir, 'snapshots', sessionId) : dataPath('snapshots', sessionId)
  }

  private fileFor(sessionId: string, checkpointId: string): string {
    return join(this.root(sessionId), `${checkpointId}.json`)
  }

  private save(checkpoint: TurnCheckpoint): void {
    if (!CHECKPOINT_SAFE_ID.test(checkpoint.id) || !CHECKPOINT_SAFE_ID.test(checkpoint.sessionId)) return
    const dir = this.root(checkpoint.sessionId)
    mkdirSync(dir, { recursive: true })
    const file = this.fileFor(checkpoint.sessionId, checkpoint.id)
    const tmp = `${file}.${process.pid}.tmp`
    const content = JSON.stringify(checkpoint, null, 2)
    writeFileSync(tmp, content, 'utf8')
    // Windows 杀毒/索引服务可能短暂占用目标文件，rename 会报 EPERM/EBUSY
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        renameSync(tmp, file)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
        if (attempt === 3) {
          writeFileSync(file, content, 'utf8')
          rmSync(tmp, { force: true })
          log.warn('checkpoint rename retried out, wrote in place', { id: checkpoint.id, code })
          return
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1))
      }
    }
  }

  /** 每轮开始：记录消息位置、todos/artifacts/plan 快照；无文件变更时也可用于对话回退。 */
  create(session: Session, userMessage: ChatMessage, messageIndex: number): TurnCheckpoint | null {
    if (!CHECKPOINT_SAFE_ID.test(session.id)) return null
    const checkpoint: TurnCheckpoint = {
      id: `cp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      sessionId: session.id,
      messageId: userMessage.id,
      messageIndex,
      label: userMessageDisplayText(userMessage).replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL) || '（空消息）',
      kind: 'turn',
      keepMessage: false,
      createdAt: Date.now(),
      files: [],
      todos: session.todos.map((todo) => ({ ...todo })),
      artifactIds: session.artifacts.map((artifact) => artifact.id),
      plan: session.plan ? (JSON.parse(JSON.stringify(session.plan)) as TurnCheckpoint['plan']) : null,
      planMode: session.planMode === true
    }
    this.save(checkpoint)
    this.prune(session.id)
    return checkpoint
  }

  /**
   * 阶段检查点：用户计划的一步完成后创建。files 从空开始，后续工具结果会记到它名下；
   * 回退时保留边界消息（keepMessage），只撤销该阶段之后的改动。
   */
  createStage(input: {
    sessionId: string
    messageId: string
    messageIndex: number
    label: string
    todos: TurnCheckpoint['todos']
    artifactIds: string[]
    plan: TurnCheckpoint['plan']
    planMode: boolean
  }): TurnCheckpoint | null {
    if (!CHECKPOINT_SAFE_ID.test(input.sessionId) || !input.messageId) return null
    const checkpoint: TurnCheckpoint = {
      id: `cp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      sessionId: input.sessionId,
      messageId: input.messageId,
      messageIndex: Math.max(0, input.messageIndex),
      label: input.label.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL) || '阶段完成',
      kind: 'stage',
      keepMessage: true,
      createdAt: Date.now(),
      files: [],
      todos: input.todos.map((todo) => ({ ...todo })),
      artifactIds: [...input.artifactIds],
      plan: input.plan ? (JSON.parse(JSON.stringify(input.plan)) as TurnCheckpoint['plan']) : null,
      planMode: input.planMode
    }
    this.save(checkpoint)
    this.prune(input.sessionId)
    return checkpoint
  }

  /** 写/编辑工具成功后登记文件；集群成员通过 meta.changedFiles 批量上报。 */
  recordToolResult(sessionId: string, checkpointId: string, meta: Record<string, unknown> | undefined): void {
    if (!meta || !CHECKPOINT_SAFE_ID.test(sessionId) || !CHECKPOINT_SAFE_ID.test(checkpointId)) return
    const checkpoint = this.get(sessionId, checkpointId)
    if (!checkpoint) return
    const rawEntries = Array.isArray(meta.changedFiles) ? meta.changedFiles : [meta]
    let changed = false
    for (const raw of rawEntries) {
      if (!raw || typeof raw !== 'object') continue
      const entry = raw as Record<string, unknown>
      const path = typeof entry.absolutePath === 'string' ? entry.absolutePath : ''
      if (!path) continue
      const deleted = entry.deleted === true
      const afterHash = typeof entry.afterHash === 'string' ? entry.afterHash : null
      if (!afterHash && !deleted) continue
      const created = entry.created === true
      const snapshotPath = typeof entry.snapshotPath === 'string' ? entry.snapshotPath : undefined
      const existing = checkpoint.files.find((file) => file.path === path)
      if (existing) {
        // 本轮新建后又删除：净变化为零，从检查点里移除，回退预览不再列出这个临时文件。
        if (deleted && existing.existed === false) {
          checkpoint.files = checkpoint.files.filter((file) => file.path !== path)
          changed = true
          continue
        }
        existing.afterHash = afterHash
        if (!existing.snapshotPath && snapshotPath && !created) existing.snapshotPath = snapshotPath
        changed = true
        continue
      }
      checkpoint.files.push({
        path,
        existed: !created,
        beforeHash: typeof entry.beforeHash === 'string' ? entry.beforeHash : null,
        afterHash,
        ...(snapshotPath && !created ? { snapshotPath } : {})
      })
      changed = true
    }
    if (changed) this.save(checkpoint)
  }

  get(sessionId: string, checkpointId: string): TurnCheckpoint | null {
    if (!CHECKPOINT_SAFE_ID.test(sessionId) || !CHECKPOINT_SAFE_ID.test(checkpointId)) return null
    const file = this.fileFor(sessionId, checkpointId)
    if (!existsSync(file)) return null
    try {
      return normalizeCheckpoint(JSON.parse(readFileSync(file, 'utf8')) as unknown, sessionId)
    } catch (err) {
      log.warn('checkpoint parse failed', { sessionId, checkpointId, error: String(err) })
      return null
    }
  }

  /** 最新在前，供回退面板展示。 */
  list(sessionId: string): TurnCheckpoint[] {
    if (!CHECKPOINT_SAFE_ID.test(sessionId)) return []
    const dir = this.root(sessionId)
    if (!existsSync(dir)) return []
    const checkpoints: TurnCheckpoint[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const checkpoint = this.get(sessionId, name.slice(0, -'.json'.length))
      if (checkpoint) checkpoints.push(checkpoint)
    }
    return checkpoints.sort((a, b) => b.createdAt - a.createdAt)
  }

  private prune(sessionId: string): void {
    const all = this.list(sessionId)
    for (const checkpoint of all.slice(MAX_CHECKPOINTS)) {
      try {
        rmSync(this.fileFor(sessionId, checkpoint.id), { force: true })
      } catch {
        // 清理失败不影响新一轮
      }
    }
  }

  removeSession(sessionId: string): void {
    if (!CHECKPOINT_SAFE_ID.test(sessionId)) return
    try {
      rmSync(this.root(sessionId), { recursive: true, force: true })
    } catch (err) {
      log.warn('checkpoint cleanup failed', { sessionId, error: String(err) })
    }
  }

  /**
   * 回退预览：找出目标轮及之后所有检查点涉及的文件的「目标轮开始前状态」，
   * 用最后登记的 afterHash 与当前文件哈希比对，检测外部修改。
   */
  preview(session: Session, checkpointId: string): RewindPreview {
    const checkpoint = this.get(session.id, checkpointId)
    if (!checkpoint) throw new Error('这一轮的记录已经过期，换一轮再试。')
    const ascending = this.list(session.id).slice().reverse()
    const targetIndex = ascending.findIndex((item) => item.id === checkpointId)
    if (targetIndex < 0) throw new Error('这一轮的记录已经过期，换一轮再试。')
    const plan = this.buildRestorePlan(ascending, targetIndex)
    const conflicts = this.detectConflicts(session, plan)
    const conflictPaths = new Set(conflicts.map((conflict) => conflict.path))
    const messageIndex = session.messages.findIndex((message) => message.id === checkpoint.messageId)
    return {
      checkpoint,
      files: [...plan].map(([path, entry]) => ({
        path,
        existed: entry.pre.existed,
        conflict: conflictPaths.has(path)
      })),
      conflicts,
      messageFound: messageIndex >= 0,
      fileCount: plan.size,
      removableMessages:
        messageIndex >= 0
          ? session.messages.length - (checkpoint.keepMessage ? messageIndex + 1 : messageIndex)
          : 0
    }
  }

  private buildRestorePlan(ascending: TurnCheckpoint[], targetIndex: number): Map<string, RestorePlanEntry> {
    const plan = new Map<string, RestorePlanEntry>()
    for (const checkpoint of ascending.slice(targetIndex)) {
      for (const file of checkpoint.files) {
        const existing = plan.get(file.path)
        if (!existing) {
          plan.set(file.path, { pre: file, expectedAfter: file.afterHash })
        } else if (file.afterHash) {
          existing.expectedAfter = file.afterHash
        }
      }
    }
    return plan
  }

  private detectConflicts(session: Session, plan: Map<string, RestorePlanEntry>): RewindPreview['conflicts'] {
    const conflicts: RewindPreview['conflicts'] = []
    for (const [path, entry] of plan) {
      const { pre, expectedAfter } = entry
      const inside = this.isAllowedTarget(session, path)
      if (!inside.ok) {
        conflicts.push({ path, reason: inside.reason })
        continue
      }
      if (pre.existed) {
        if (!pre.snapshotPath) {
          conflicts.push({ path, reason: '缺少本轮开始前的文件快照，无法安全恢复。' })
          continue
        }
        if (!this.isAllowedSnapshot(session, pre.snapshotPath)) {
          conflicts.push({ path, reason: '写前快照不属于当前会话，已拒绝恢复。' })
          continue
        }
        if (!existsSync(pre.snapshotPath)) {
          conflicts.push({ path, reason: '写前快照文件已丢失，无法恢复。' })
          continue
        }
        // 快照内容必须仍与登记时的 beforeHash 一致，防止快照被替换/截断后回退出错误内容
        if (pre.beforeHash && sha256File(pre.snapshotPath) !== pre.beforeHash) {
          conflicts.push({ path, reason: '写前快照已损坏或被替换，无法安全恢复。' })
          continue
        }
      }
      const actual = existsSync(path) ? sha256File(path) : null
      if (expectedAfter === null) {
        // 只有「本轮新建、且已经回退删除」的文件会以 null 记录：
        // 若现在又出现了，说明它被外部重建，视为冲突。
        if (actual !== null) conflicts.push({ path, reason: '已回退删除的文件又被外部重新创建。' })
        continue
      }
      if (actual !== expectedAfter) {
        conflicts.push({
          path,
          reason: actual === null ? '文件在检查点之后被删除或移走。' : '文件在检查点之后被外部修改。'
        })
      }
    }
    return conflicts
  }

  private isAllowedTarget(session: Session, path: string): { ok: true } | { ok: false; reason: string } {
    if (!session.workspace) return { ok: false, reason: '会话没有工作区，无法恢复文件。' }
    try {
      const rootReal = realpathSync(session.workspace)
      const target = resolve(path)
      if (!checkpointIsInside(rootReal, target) && !checkpointIsInside(session.workspace, target)) {
        return { ok: false, reason: '文件不在当前工作区内，已拒绝恢复。' }
      }
      if (existsSync(target) && !checkpointIsInside(rootReal, realpathSync(target))) {
        return { ok: false, reason: '文件通过符号链接指向工作区外，已拒绝恢复。' }
      }
      // 目标不存在时，校验最近的已存在父目录仍在工作区（防 junction/符号链接逃逸）
      let probe = dirname(target)
      while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
      if (existsSync(probe) && !checkpointIsInside(rootReal, realpathSync(probe))) {
        return { ok: false, reason: '目标目录指向工作区外，已拒绝恢复。' }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: `路径校验失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }

  private isAllowedSnapshot(session: Session, snapshotPath: string): boolean {
    const root = this.snapshotRoot(session.id)
    if (!existsSync(root)) return false
    try {
      const rootReal = realpathSync(root)
      const snapshotReal = realpathSync(snapshotPath)
      return checkpointIsInside(rootReal, snapshotReal) && statSync(snapshotReal).isFile()
    } catch {
      return false
    }
  }

  /**
   * 执行回退。code 回退在冲突时整体拒绝（不修改任何文件）；
   * conversation 回退要求仍能在当前消息列表里定位到目标用户消息。
   */
  rewind(session: Session, checkpointId: string, scope: RewindScope): RewindResult {
    const checkpoint = this.get(session.id, checkpointId)
    if (!checkpoint) throw new Error('这一轮的记录已经过期，换一轮再试。')
    const ascending = this.list(session.id).slice().reverse()
    const targetIndex = ascending.findIndex((item) => item.id === checkpointId)
    if (targetIndex < 0) throw new Error('这一轮的记录已经过期，换一轮再试。')
    const messageIndex = session.messages.findIndex((message) => message.id === checkpoint.messageId)
    if (scope !== 'code' && messageIndex < 0) {
      throw new Error('这条消息已不在当前对话里（可能已被压缩），请选择「只回退文件」。')
    }

    let restoredFiles = 0
    let removedFiles = 0
    let removedMessages = 0
    const plan = this.buildRestorePlan(ascending, targetIndex)

    if (scope !== 'conversation') {
      const conflicts = this.detectConflicts(session, plan)
      if (conflicts.length > 0) {
        const detail = conflicts
          .slice(0, 5)
          .map((conflict) => `${conflict.path}：${conflict.reason}`)
          .join('；')
        throw new Error(`暂时不能回到这里（${conflicts.length} 个文件有冲突）：${detail}`)
      }
      for (const [path, entry] of plan) {
        if (entry.pre.existed) {
          if (!entry.pre.snapshotPath) throw new Error(`缺少这一轮开始前的文件快照，不能安全恢复：${path}`)
          mkdirSync(dirname(path), { recursive: true })
          const tmp = `${path}.morrow-rewind-${process.pid}.tmp`
          copyFileSync(entry.pre.snapshotPath, tmp)
          renameSync(tmp, path)
          restoredFiles += 1
        } else {
          if (existsSync(path)) {
            if (lstatSync(path).isDirectory()) throw new Error(`这个位置变成了文件夹，已停止回退：${path}`)
            rmSync(path, { force: true })
            removedFiles += 1
          }
        }
      }
    }

    if (scope !== 'code') {
      const cut = checkpoint.keepMessage ? messageIndex + 1 : messageIndex
      removedMessages = session.messages.length - cut
      session.messages = session.messages.slice(0, cut)
      session.todos = checkpoint.todos.map((todo) => ({ ...todo }))
      session.artifacts = session.artifacts.filter((artifact) => checkpoint.artifactIds.includes(artifact.id))
      session.plan = checkpoint.plan ? (JSON.parse(JSON.stringify(checkpoint.plan)) as Session['plan']) : null
      session.planMode = session.plan ? checkpoint.planMode === true : false
      this.sessionStore.save(session)
    }

    if (scope === 'code') {
      // 代码已回到目标轮开始前：把目标检查点的 afterHash 改成恢复后的哈希，
      // 删除之后已失效的检查点；目标检查点保留，仍可只回退对话。
      for (const entry of plan.values()) {
        const file = checkpoint.files.find((item) => item.path === entry.pre.path)
        if (file) {
          file.afterHash = entry.pre.existed ? entry.pre.beforeHash : null
          if (entry.pre.existed && entry.pre.snapshotPath) file.snapshotPath = entry.pre.snapshotPath
        }
      }
      this.save(checkpoint)
      for (const later of ascending.slice(targetIndex + 1)) {
        rmSync(this.fileFor(session.id, later.id), { force: true })
      }
    } else {
      for (const removed of ascending.slice(targetIndex)) {
        rmSync(this.fileFor(session.id, removed.id), { force: true })
      }
    }

    log.info('rewind applied', {
      sessionId: session.id,
      checkpointId,
      scope,
      restoredFiles,
      removedFiles,
      removedMessages
    })
    return { checkpointId, kind: checkpoint.kind ?? 'turn', scope, restoredFiles, removedFiles, removedMessages }
  }
}


let checkpointInstance: CheckpointService | null = null

export function getCheckpointService(sessionStore: SessionStore): CheckpointService {
  if (!checkpointInstance) checkpointInstance = new CheckpointService(sessionStore)
  return checkpointInstance
}
