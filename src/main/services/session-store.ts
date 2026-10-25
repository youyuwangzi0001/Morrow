import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ChatMessage,
  CreateSessionInput,
  Goal,
  ModelRef,
  PermissionMode,
  ReasoningEffort,
  ResearchState,
  Session,
  SessionMeta,
  SessionMode,
  SessionPlan,
  TodoItem,
  Usage
} from '../../shared/types'
import { userMessageDisplayText } from '../../shared/message'
import { isReasoningEffort } from '../../shared/models'
import { dataPath, ensureDataDirs } from './paths'
import { log } from './logger'

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
            // ignore
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
