import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ChatMessage,
  CreateSessionInput,
  ModelRef,
  PermissionMode,
  Session,
  SessionMeta,
  TodoItem,
  Usage
} from '../../shared/types'
import { dataPath, ensureDataDirs } from './paths'
import { log } from './logger'

const SAFE_ID = /^[A-Za-z0-9_-]{4,80}$/

function sessionsDir(): string {
  const dir = dataPath('sessions')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function fileFor(id: string): string {
  return join(sessionsDir(), `${id}.json`)
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
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
  const lastUser = [...session.messages].reverse().find((m) => m.role === 'user')
  const preview = lastUser ? messageText(lastUser).replace(/\s+/g, ' ').slice(0, 120) : ''
  return {
    id: session.id,
    title: session.title,
    workspace: session.workspace,
    model: session.model,
    permissionMode: session.permissionMode,
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

function messageText(message: ChatMessage): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text : block.type === 'thinking' ? '' : ''))
    .join(' ')
}

export class SessionStore {
  constructor() {
    ensureDataDirs()
  }

  list(): SessionMeta[] {
    const dir = sessionsDir()
    const metas: SessionMeta[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const session = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Session
        if (!session?.id) continue
        metas.push(deriveMeta(session))
      } catch (err) {
        log.warn('skip corrupted session file', { name, error: String(err) })
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 300)
  }

  get(id: string): Session | null {
    if (!SAFE_ID.test(id)) return null
    const file = fileFor(id)
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Session
    } catch (err) {
      log.error('session parse failed', { id, error: String(err) })
      return null
    }
  }

  create(input: CreateSessionInput & { defaultModel: ModelRef; defaultPermission: PermissionMode }): Session {
    const now = Date.now()
    const session: Session = {
      id: makeId(),
      title: input.title ?? '新对话',
      workspace: input.workspace ?? null,
      model: input.model ?? input.defaultModel,
      permissionMode: input.permissionMode ?? input.defaultPermission,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      messages: [],
      todos: [],
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0 }
    }
    this.save(session)
    return session
  }

  save(session: Session): Session {
    if (!SAFE_ID.test(session.id)) throw new Error('非法会话 id')
    session.updatedAt = Date.now()
    session.messageCount = session.messages.length
    atomicWrite(fileFor(session.id), JSON.stringify(session, null, 2))
    return session
  }

  remove(id: string): void {
    if (!SAFE_ID.test(id)) return
    const file = fileFor(id)
    if (existsSync(file)) unlinkSync(file)
  }

  rename(id: string, title: string): SessionMeta | null {
    const session = this.get(id)
    if (!session) return null
    session.title = title.trim().slice(0, 60) || '新对话'
    this.save(session)
    return deriveMeta(session)
  }

  setModel(id: string, model: ModelRef): SessionMeta | null {
    const session = this.get(id)
    if (!session) return null
    session.model = model
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

  /** 首条用户消息自动命名，仅在标题仍是默认值时 */
  autoName(session: Session, text: string): void {
    if (session.title !== '新对话' || !text.trim()) return
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
    return this.save(session)
  }
}

let instance: SessionStore | null = null
export function getSessionStore(): SessionStore {
  if (!instance) instance = new SessionStore()
  return instance
}
