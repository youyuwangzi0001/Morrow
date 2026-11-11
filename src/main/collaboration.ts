// 协作域主进程服务：由 collaboration-*、shared-resources、worker-slots、tool-audit 扁平合并。
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync, readdirSync, renameSync, realpathSync } from 'node:fs'
import { dirname, join, basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { ToolAuditEntry, CollaborationAction, CollaborationActionStatus, CollaborationMessage, CollaborationProjection, SuperAgentState, SuperTask, CollaborationArtifact, CollaborationArtifactUsage, StuckAlert, CollaborationVerificationCommand, CollaborationVerificationFile } from '../shared/types'
import { dataPath, resolveDataDir, openPathFromUserShell } from './workspace'
import { WorkerSlotLease, WorkerSlotPort, SharedResourceKind, SharedResourceLease, SharedResourceOwner, SharedResourcePort, CollaborationRuntimePort, CollaborationTaskControl, CollaborationArtifactOutcome, CollaborationArtifactPort, CollaborationArtifactReadResult, CollaborationArtifactPublishInput, CollaborationVerificationCandidate, CollaborationVerificationPort, CollaborationVerificationRun } from '../core/types'
import { randomUUID, createHash } from 'node:crypto'
import { collaborationAttemptId, normalizeSuperAgentCollaboration, reconcileSuperAgentAfterRestart } from '../shared/contracts'
import { log } from './logger'
import { recomputeArtifactStaleness, latestReadyArtifact, publishArtifactVersion, recordArtifactUsage, revokeArtifactVersion, isSafeVerificationCommand } from '../core/collaboration'
import { detectCommandPorts } from '../core/collaboration'
import { getTerminalManager } from './terminal-manager'

const MAX_AUDIT_BYTES = 1024 * 1024
const MAX_AUDIT_ENTRIES = 500

let auditDataDir: string | null = null

/** 测试与数据迁移可指定独立目录；生产默认使用用户数据目录。 */
export function configureToolAuditRuntime(dataDir: string | null): void {
  auditDataDir = dataDir
}

function auditPath(): string {
  return auditDataDir
    ? join(auditDataDir, 'collaboration', 'tool-audit.jsonl')
    : dataPath('collaboration', 'tool-audit.jsonl')
}

/** 追加一条工具允许/拒绝记录。记录只含身份、工具名和原因，不含工具参数或文件内容。 */
export function appendToolAudit(entry: ToolAuditEntry): void {
  const file = auditPath()
  mkdirSync(dirname(file), { recursive: true })
  if (existsSync(file) && statSync(file).size > MAX_AUDIT_BYTES) {
    const lines = readFileSync(file, 'utf8').trim().split('\n').slice(-MAX_AUDIT_ENTRIES * 2)
    writeFileSync(file, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  }
  writeFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' })
}

export function listToolAudit(limit = 100): ToolAuditEntry[] {
  try {
    const file = auditPath()
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-MAX_AUDIT_ENTRIES * 2)
    const entries: ToolAuditEntry[] = []
    for (const line of lines) {
      try {
        const item = JSON.parse(line) as ToolAuditEntry
        if (typeof item.at !== 'number' || typeof item.toolName !== 'string' || typeof item.actor !== 'string') continue
        entries.push(item)
      } catch {
        // 跳过损坏行
      }
    }
    return entries.sort((a, b) => b.at - a.at).slice(0, Math.max(1, Math.min(MAX_AUDIT_ENTRIES, Math.round(limit))))
  } catch {
    return []
  }
}

export function clearToolAudit(): void {
  try {
    rmSync(auditPath(), { force: true })
  } catch {
    // 清理失败不影响后续运行
  }
}

interface Waiter {
  resolve: (lease: WorkerSlotLease | null) => void
  signal?: AbortSignal
  onAbort?: () => void
}

/**
 * 全局限流：跨 Router 批次/会话共用一个 Worker 并发上限。
 * 超过上限的 Worker 在内存里排队，不会启动模型请求；取消信号会直接退出队列。
 */
export class WorkerSlotManager implements WorkerSlotPort {
  private active = 0
  private limit = 2
  private readonly waiters: Waiter[] = []

  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.min(8, Math.round(limit)))
    this.drain()
  }

  acquire(input: { ownerId: string; signal?: AbortSignal }): Promise<WorkerSlotLease | null> {
    if (input.signal?.aborted) return Promise.resolve(null)
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve(this.lease())
    }
    return new Promise<WorkerSlotLease | null>((resolve) => {
      const waiter: Waiter = { resolve, signal: input.signal }
      if (input.signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          resolve(null)
        }
        input.signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  snapshot(): { active: number; waiting: number; limit: number } {
    return { active: this.active, waiting: this.waiters.length, limit: this.limit }
  }

  private lease(): WorkerSlotLease {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.active = Math.max(0, this.active - 1)
        this.drain()
      }
    }
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal?.aborted) {
        waiter.resolve(null)
        continue
      }
      this.active += 1
      waiter.resolve(this.lease())
    }
  }
}

let workerInstance: WorkerSlotManager | null = null

export function getWorkerSlotManager(): WorkerSlotManager {
  if (!workerInstance) workerInstance = new WorkerSlotManager()
  return workerInstance
}

export interface SharedResourceEvent {
  type: 'acquire' | 'release' | 'expire' | 'deny'
  at: number
  resource: string
  kind: SharedResourceKind
  ownerId: string
  label: string
  sessionId: string
  taskId?: string
  attemptId?: string
  reason?: string
}

const DEFAULT_TTL_MS = 30 * 60_000
const MAX_TTL_MS = 60 * 60_000
const MAX_HISTORY = 200

/**
 * 桌面/端口等本机共享资源租约。
 * 同一资源一次只允许一个 owner；任务结束或崩溃超时后释放，并把占用记录写入本地审计。
 */
export class SharedResourceManager implements SharedResourcePort {
  private readonly leases = new Map<string, SharedResourceLease>()
  private readonly events: SharedResourceEvent[] = []

  constructor(private readonly dataDir?: string) {}

  private auditFile(): string {
    return join(this.dataDir ?? resolveDataDir(), 'collaboration', 'shared-resources.jsonl')
  }

  private record(event: SharedResourceEvent): void {
    this.events.push(event)
    if (this.events.length > MAX_HISTORY) this.events.splice(0, this.events.length - MAX_HISTORY)
    try {
      const file = this.auditFile()
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8')
    } catch {
      // 审计写盘失败不能影响任务执行
    }
  }

  private sweep(now = Date.now()): void {
    for (const [resource, lease] of this.leases) {
      if (lease.expiresAt > now) continue
      this.leases.delete(resource)
      this.record({
        type: 'expire',
        at: now,
        resource,
        kind: lease.kind,
        ownerId: lease.owner.ownerId,
        label: lease.owner.label,
        sessionId: lease.owner.sessionId,
        ...(lease.owner.taskId ? { taskId: lease.owner.taskId } : {}),
        ...(lease.owner.attemptId ? { attemptId: lease.owner.attemptId } : {}),
        reason: '租约超时'
      })
    }
  }

  async acquire(input: {
    kind: SharedResourceKind
    resource: string
    owner: SharedResourceOwner
    ttlMs?: number
    waitMs?: number
  }): Promise<{ ok: true; lease: SharedResourceLease } | { ok: false; holder?: SharedResourceLease; reason: string }> {
    const waitMs = Math.max(0, Math.min(60_000, Math.round(input.waitMs ?? 0)))
    const deadline = Date.now() + waitMs
    for (;;) {
      this.sweep()
      const existing = this.leases.get(input.resource)
      if (!existing) {
        const now = Date.now()
        const ttl = Math.max(10_000, Math.min(MAX_TTL_MS, Math.round(input.ttlMs ?? DEFAULT_TTL_MS)))
        const lease: SharedResourceLease = {
          id: `lease_${randomUUID().slice(0, 12)}`,
          kind: input.kind,
          resource: input.resource,
          owner: { ...input.owner },
          acquiredAt: now,
          expiresAt: now + ttl
        }
        this.leases.set(input.resource, lease)
        this.record({
          type: 'acquire',
          at: now,
          resource: lease.resource,
          kind: lease.kind,
          ownerId: lease.owner.ownerId,
          label: lease.owner.label,
          sessionId: lease.owner.sessionId,
          ...(lease.owner.taskId ? { taskId: lease.owner.taskId } : {}),
          ...(lease.owner.attemptId ? { attemptId: lease.owner.attemptId } : {})
        })
        return { ok: true, lease }
      }
      if (existing.owner.ownerId === input.owner.ownerId) return { ok: true, lease: existing }
      if (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        continue
      }
      this.record({
        type: 'deny',
        at: Date.now(),
        resource: input.resource,
        kind: input.kind,
        ownerId: input.owner.ownerId,
        label: input.owner.label,
        sessionId: input.owner.sessionId,
        ...(input.owner.taskId ? { taskId: input.owner.taskId } : {}),
        ...(input.owner.attemptId ? { attemptId: input.owner.attemptId } : {}),
        reason: `已被「${existing.owner.label}」占用`
      })
      return { ok: false, holder: existing, reason: `已被「${existing.owner.label}」占用` }
    }
  }

  releaseOwner(input: { ownerId: string }): void {
    for (const [resource, lease] of this.leases) {
      if (lease.owner.ownerId !== input.ownerId) continue
      this.leases.delete(resource)
      this.record({
        type: 'release',
        at: Date.now(),
        resource,
        kind: lease.kind,
        ownerId: lease.owner.ownerId,
        label: lease.owner.label,
        sessionId: lease.owner.sessionId,
        ...(lease.owner.taskId ? { taskId: lease.owner.taskId } : {}),
        ...(lease.owner.attemptId ? { attemptId: lease.owner.attemptId } : {})
      })
    }
  }

  /** 会话删除时释放其主代理和所有 Worker 的租约。 */
  releaseSession(sessionId: string): void {
    for (const [resource, lease] of this.leases) {
      if (lease.owner.sessionId !== sessionId) continue
      this.leases.delete(resource)
      this.record({
        type: 'release',
        at: Date.now(),
        resource,
        kind: lease.kind,
        ownerId: lease.owner.ownerId,
        label: lease.owner.label,
        sessionId: lease.owner.sessionId,
        ...(lease.owner.taskId ? { taskId: lease.owner.taskId } : {}),
        ...(lease.owner.attemptId ? { attemptId: lease.owner.attemptId } : {})
      })
    }
  }

  snapshot(): SharedResourceLease[] {
    this.sweep()
    return [...this.leases.values()].map((lease) => ({
      ...lease,
      owner: { ...lease.owner }
    }))
  }

  history(limit = 50): SharedResourceEvent[] {
    return this.events.slice(-Math.max(1, limit))
  }
}

let resourceInstance: SharedResourceManager | null = null

export function getSharedResourceManager(): SharedResourceManager {
  if (!resourceInstance) resourceInstance = new SharedResourceManager()
  return resourceInstance
}

const STORE_VERSION = 1
const MAX_ACTIONS = 200
const SAFE_ID = /^[A-Za-z0-9_-]{3,100}$/

export interface CollaborationProjectRecord {
  version: number
  projectId: string
  sessionId: string
  workspace: string | null
  title: string
  createdAt: number
  updatedAt: number
  revision: number
  superAgent: SuperAgentState | null
  actions: CollaborationAction[]
  messages: CollaborationMessage[]
}

interface LoadedProject {
  record: CollaborationProjectRecord | null
  readOnly: boolean
  reason?: string
}

export interface CollaborationSyncInput {
  projectId: string
  sessionId: string
  workspace: string | null
  title: string
  state: SuperAgentState
}

export interface CollaborationSyncResult {
  projection: CollaborationProjection
  /** false = 进度未能落盘，调用方必须阻止新的执行 */
  saved: boolean
  readOnly: boolean
  error?: string
}

let runtimeDataDir: string | null = null
let storeInstance: CollaborationStore | null = null

/** 测试/数据目录迁移时切换存储根目录；null 恢复用户数据目录。 */
export function configureCollaborationStoreRuntime(dataDir: string | null): void {
  runtimeDataDir = dataDir
  storeInstance = null
}

export function getCollaborationStore(): CollaborationStore {
  if (!storeInstance) storeInstance = new CollaborationStore(runtimeDataDir ?? resolveDataDir())
  return storeInstance
}

function now(): number {
  return Date.now()
}

function isAction(value: unknown): value is CollaborationAction {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    typeof item.projectId === 'string' &&
    typeof item.kind === 'string' &&
    typeof item.label === 'string' &&
    typeof item.status === 'string' &&
    typeof item.idempotencyKey === 'string' &&
    typeof item.createdAt === 'number' &&
    typeof item.updatedAt === 'number'
  )
}

function isMessage(value: unknown): value is CollaborationMessage {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    typeof item.projectId === 'string' &&
    typeof item.text === 'string' &&
    typeof item.status === 'string' &&
    typeof item.createdAt === 'number' &&
    typeof item.updatedAt === 'number' &&
    typeof item.idempotencyKey === 'string'
  )
}

function normalizeMessage(raw: CollaborationMessage): CollaborationMessage {
  const direction = raw.direction === 'worker' ? 'worker' : 'main'
  const kind = raw.kind === 'note' || raw.kind === 'question' || raw.kind === 'answer' ? raw.kind : 'directive'
  return { ...raw, direction, kind }
}

function normalizeAction(raw: CollaborationAction, projectId: string): CollaborationAction {
  return {
    ...raw,
    projectId,
    status: raw.status,
    requiresReview: raw.status === 'uncertain' ? true : raw.requiresReview
  }
}

function emptyProject(projectId: string): CollaborationProjectRecord {
  const at = now()
  return {
    version: STORE_VERSION,
    projectId,
    sessionId: '',
    workspace: null,
    title: '',
    createdAt: at,
    updatedAt: at,
    revision: 0,
    superAgent: null,
    actions: [],
    messages: []
  }
}

function actionStatusForAttempt(attemptStatus: string): CollaborationActionStatus | null {
  switch (attemptStatus) {
    case 'running':
      return 'running'
    case 'delivered':
    case 'verified':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'superseded':
      return 'cancelled'
    default:
      return null
  }
}

function actionLabel(task: SuperTask, attempt: number): string {
  return `执行「${task.title}」第 ${attempt} 次尝试`
}

function mergeActions(existing: CollaborationAction[], state: SuperAgentState, projectId: string): CollaborationAction[] {
  const at = now()
  const byId = new Map(existing.map((action) => [action.id, action]))
  for (const task of state.tasks) {
    // 排队且从未启动的任务先落一条待执行动作：重开后只有这类任务可恢复/重试。
    if (task.status === 'queued') {
      const nextAttempt = Math.max(0, task.attempts ?? 0) + 1
      const attemptId = collaborationAttemptId(task.taskId ?? task.id, nextAttempt)
      const actionId = `action_${attemptId}`
      const current = byId.get(actionId)
      if (!current || current.status === 'pending' || current.status === 'running') {
        byId.set(actionId, {
          id: actionId,
          projectId,
          taskId: task.taskId ?? task.id,
          attemptId,
          kind: 'execute_attempt',
          label: actionLabel(task, nextAttempt),
          status: 'pending',
          idempotencyKey: attemptId,
          createdAt: current?.createdAt ?? at,
          updatedAt: at
        })
      }
    }
    const attempts = task.attemptHistory ?? []
    for (const attempt of attempts) {
      const actionId = `action_${attempt.id}`
      const targetStatus = actionStatusForAttempt(attempt.status)
      if (!targetStatus) continue
      const current = byId.get(actionId)
      if (current && ['done', 'failed', 'cancelled', 'uncertain'].includes(current.status)) {
        continue
      }
      const terminal = targetStatus === 'done' || targetStatus === 'failed' || targetStatus === 'cancelled'
      const action: CollaborationAction = {
        id: actionId,
        projectId,
        taskId: task.taskId ?? task.id,
        attemptId: attempt.id,
        kind: 'execute_attempt',
        label: actionLabel(task, attempt.attempt),
        status: targetStatus,
        idempotencyKey: attempt.id,
        createdAt: current?.createdAt ?? attempt.startedAt ?? at,
        updatedAt: at,
        startedAt: attempt.startedAt,
        ...(terminal ? { executedAt: attempt.finishedAt ?? at } : {}),
        ...(targetStatus === 'done'
          ? {
              confirmedAt: attempt.finishedAt ?? at,
              confirmedBy: attempt.status === 'verified' ? ('verifier' as const) : ('system' as const)
            }
          : {}),
        ...(attempt.summary ? { result: attempt.summary } : {}),
        ...(attempt.error ? { error: attempt.error } : {}),
        ...(current?.requiresReview ? { requiresReview: true } : {})
      }
      byId.set(actionId, action)
    }
  }
  // 排队动作只在任务仍处于 queued 时有效；任务被阻塞/失败/取消后不能留下“可恢复”的假待办。
  const taskById = new Map(state.tasks.map((task) => [task.taskId ?? task.id, task]))
  for (const action of byId.values()) {
    if (action.kind !== 'execute_attempt' || action.status !== 'pending' || !action.taskId) continue
    const task = taskById.get(action.taskId)
    if (!task || task.status === 'queued') continue
    action.status = 'cancelled'
    action.updatedAt = at
    action.error = '任务已不处于排队状态，待执行动作已取消。'
  }
  const actions = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt)
  if (actions.length <= MAX_ACTIONS) return actions
  const uncertain = actions.filter((action) => action.status === 'uncertain')
  const recent = actions.slice(-(MAX_ACTIONS - uncertain.length))
  return [...new Map([...uncertain, ...recent].map((action) => [action.id, action])).values()].sort(
    (a, b) => a.createdAt - b.createdAt
  )
}

function projectionOf(record: CollaborationProjectRecord | null, readOnly = false, reason?: string): CollaborationProjection {
  const actions = record?.actions ?? []
  const pending = actions
    .filter((action) => action.status === 'pending' || action.status === 'running')
    .sort((a, b) => a.createdAt - b.createdAt)
  const uncertain = actions.filter((action) => action.status === 'uncertain')
  return {
    projectId: record?.projectId ?? '',
    title: record?.title ?? '',
    revision: record?.revision ?? 0,
    updatedAt: record?.updatedAt ?? 0,
    pending,
    uncertain,
    messages: (record?.messages ?? []).slice(-50),
    nextAction: pending[0] ?? null,
    ...(readOnly ? { readOnly: true } : {}),
    ...(reason ? { readOnlyReason: reason } : {})
  }
}

export class CollaborationStore {
  constructor(private readonly dataDir = resolveDataDir()) {}

  private projectsDir(): string {
    const dir = join(this.dataDir, 'collaboration', 'projects')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  private fileFor(projectId: string): string {
    if (!SAFE_ID.test(projectId)) throw new Error('非法协作项目编号')
    return join(this.projectsDir(), `${projectId}.json`)
  }

  private load(projectId: string): LoadedProject {
    if (!SAFE_ID.test(projectId)) {
      return { record: null, readOnly: true, reason: '协作项目编号不合法，已拒绝读写。' }
    }
    const file = this.fileFor(projectId)
    if (!existsSync(file)) return { record: null, readOnly: false }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      log.warn('collaboration project parse failed', { projectId, error: String(err) })
      return { record: null, readOnly: true, reason: '本地协作记录损坏，已保留原文件供只读排查。' }
    }
    if (!raw || typeof raw !== 'object') {
      return { record: null, readOnly: true, reason: '本地协作记录格式无法识别，已保留原文件。' }
    }
    const item = raw as Record<string, unknown>
    const version = typeof item.version === 'number' && Number.isFinite(item.version) ? Math.round(item.version) : 0
    if (version > STORE_VERSION) {
      return {
        record: null,
        readOnly: true,
        reason: `本地协作记录由更高版本（v${version}）写入；当前版本只读，未覆盖原文件。`
      }
    }
    if (typeof item.projectId !== 'string' || item.projectId !== projectId) {
      return { record: null, readOnly: true, reason: '本地协作记录的项目编号不匹配，已拒绝覆盖。' }
    }
    const state = item.superAgent && typeof item.superAgent === 'object'
      ? normalizeSuperAgentCollaboration(item.superAgent as SuperAgentState, projectId)
      : null
    const actions = Array.isArray(item.actions) ? item.actions.filter(isAction).map((action) => normalizeAction(action, projectId)) : []
    const messages = Array.isArray(item.messages)
      ? item.messages.filter(isMessage).map(normalizeMessage).slice(-200)
      : []
    const record: CollaborationProjectRecord = {
      version: STORE_VERSION,
      projectId,
      sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
      workspace: typeof item.workspace === 'string' ? item.workspace : null,
      title: typeof item.title === 'string' ? item.title : '',
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : now(),
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : now(),
      revision: typeof item.revision === 'number' && Number.isFinite(item.revision) ? Math.max(0, Math.round(item.revision)) : 0,
      superAgent: state,
      actions,
      messages
    }
    return { record, readOnly: false }
  }

  private save(record: CollaborationProjectRecord): void {
    const file = this.fileFor(record.projectId)
    const tmp = `${file}.${process.pid}.tmp`
    const content = `${JSON.stringify(record, null, 2)}\n`
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
    let saved = false
    for (let attempt = 0; attempt < 4 && !saved; attempt += 1) {
      try {
        renameSync(tmp, file)
        saved = true
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
        if (attempt === 3) {
          // 和会话落盘一致：目标被占用时至少把最新内容写进正式文件，避免整段进度丢失。
          writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 })
          saved = true
        } else {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1))
        }
      }
    }
  }

  projection(projectId: string): CollaborationProjection {
    if (!projectId) return projectionOf(null)
    const loaded = this.load(projectId)
    const projection = projectionOf(loaded.record, loaded.readOnly, loaded.reason)
    return projection.projectId ? projection : { ...projection, projectId }
  }

  /** 保存一条发往指定任务或由 Worker 发出的协作消息；同一 idempotencyKey 重复提交只保留一条。 */
  enqueueMessage(input: {
    projectId: string
    taskId?: string
    attemptId?: string
    text: string
    idempotencyKey: string
    direction?: import('../shared/types').CollaborationMessageDirection
    kind?: import('../shared/types').CollaborationMessageKind
    author?: string
    replyTo?: string
  }): CollaborationMessage {
    const loaded = this.load(input.projectId)
    if (loaded.readOnly) throw new Error(loaded.reason ?? '本地协作记录当前只读。')
    const record = loaded.record ?? emptyProject(input.projectId)
    const existing = record.messages.find((message) => message.idempotencyKey === input.idempotencyKey)
    if (existing) return existing
    const at = now()
    const id = `message_${createHash('sha256').update(`${input.projectId}|${input.idempotencyKey}`).digest('hex').slice(0, 16)}`
    const message: CollaborationMessage = {
      id,
      projectId: input.projectId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      text: input.text,
      status: 'pending',
      direction: input.direction === 'worker' ? 'worker' : 'main',
      kind: input.kind ?? 'directive',
      ...(input.author ? { author: input.author.slice(0, 80) } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      createdAt: at,
      updatedAt: at,
      idempotencyKey: input.idempotencyKey,
      informational: true
    }
    record.messages = [...record.messages, message].slice(-200)
    record.revision += 1
    record.updatedAt = at
    this.save(record)
    return message
  }

  /** Worker 在安全步取走待投递消息；领取即标记 delivered，第二次取不到。 */
  drainMessages(input: { projectId: string; taskId: string; attemptId: string }): CollaborationMessage[] {
    const loaded = this.load(input.projectId)
    if (loaded.readOnly || !loaded.record) return []
    const pending = loaded.record.messages.filter(
      (message) =>
        message.taskId === input.taskId &&
        message.direction === 'main' &&
        message.kind === 'directive' &&
        message.status === 'pending'
    )
    if (pending.length === 0) return []
    const at = now()
    for (const message of pending) {
      message.status = 'delivered'
      message.attemptId = input.attemptId
      message.deliveredAt = at
      message.updatedAt = at
    }
    loaded.record.revision += 1
    loaded.record.updatedAt = at
    this.save(loaded.record)
    return pending.map((message) => ({ ...message }))
  }

  markMessagesRead(projectId: string, messageIds: string[]): void {
    if (messageIds.length === 0) return
    const loaded = this.load(projectId)
    if (loaded.readOnly || !loaded.record) return
    const wanted = new Set(messageIds)
    let changed = false
    const at = now()
    for (const message of loaded.record.messages) {
      if (!wanted.has(message.id) || message.status !== 'delivered') continue
      message.status = 'read'
      message.readAt = at
      message.updatedAt = at
      changed = true
    }
    if (!changed) return
    loaded.record.revision += 1
    loaded.record.updatedAt = at
    this.save(loaded.record)
  }

  markMessagesAdopted(projectId: string, messageIds: string[]): CollaborationProjection | null {
    if (messageIds.length === 0) return null
    const loaded = this.load(projectId)
    if (loaded.readOnly || !loaded.record) return null
    const wanted = new Set(messageIds)
    let changed = false
    const at = now()
    for (const message of loaded.record.messages) {
      if (!wanted.has(message.id) || message.status === 'adopted' || message.status === 'cancelled' || message.status === 'failed') continue
      message.status = 'adopted'
      message.adoptedAt = at
      message.updatedAt = at
      changed = true
    }
    if (!changed) return null
    loaded.record.revision += 1
    loaded.record.updatedAt = at
    this.save(loaded.record)
    return projectionOf(loaded.record)
  }

  failMessage(projectId: string, messageId: string, error: string): CollaborationProjection | null {
    const loaded = this.load(projectId)
    if (loaded.readOnly || !loaded.record) return null
    const message = loaded.record.messages.find((item) => item.id === messageId)
    if (!message || message.status === 'adopted' || message.status === 'cancelled') return null
    message.status = 'failed'
    message.error = error
    message.failedAt = now()
    message.updatedAt = now()
    loaded.record.revision += 1
    loaded.record.updatedAt = now()
    this.save(loaded.record)
    return projectionOf(loaded.record)
  }

  cancelMessage(projectId: string, messageId: string): CollaborationProjection {
    const loaded = this.load(projectId)
    if (loaded.readOnly) throw new Error(loaded.reason ?? '本地协作记录当前只读。')
    if (!loaded.record) throw new Error('没有找到这个项目的进度记录。')
    const message = loaded.record.messages.find((item) => item.id === messageId)
    if (!message) throw new Error('没有找到这条补充要求。')
    if (message.status !== 'adopted' && message.status !== 'cancelled' && message.status !== 'failed') {
      message.status = 'cancelled'
      message.cancelledAt = now()
      message.updatedAt = now()
      loaded.record.revision += 1
      loaded.record.updatedAt = now()
      this.save(loaded.record)
    }
    return projectionOf(loaded.record)
  }

  /** 保存会话投影与动作；返回 saved=false 时调用方不得开始新的执行。 */
  syncSuperAgent(input: CollaborationSyncInput): CollaborationSyncResult {
    const loaded = this.load(input.projectId)
    if (loaded.readOnly) {
      return {
        projection: projectionOf(loaded.record, true, loaded.reason),
        saved: false,
        readOnly: true,
        ...(loaded.reason ? { error: loaded.reason } : {})
      }
    }
    const record = loaded.record ?? emptyProject(input.projectId)
    record.sessionId = input.sessionId
    record.workspace = input.workspace
    record.title = input.title
    record.superAgent = input.state
    record.revision = Math.max(record.revision + 1, input.state.revision ?? 0)
    record.updatedAt = now()
    record.actions = mergeActions(record.actions, input.state, input.projectId)
    try {
      this.save(record)
      return { projection: projectionOf(record), saved: true, readOnly: false }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('collaboration project save failed', { projectId: input.projectId, error: message })
      return { projection: projectionOf(record), saved: false, readOnly: false, error: `本地协作进度保存失败：${message}` }
    }
  }

  /** 启动时把上次进程留下的 running/executed 动作标为待核对，不自动重放。 */
  recoverInterruptedActions(): { projects: number; actions: number } {
    let projects = 0
    let actions = 0
    let names: string[] = []
    try {
      names = readdirSync(this.projectsDir()).filter((name) => name.endsWith('.json'))
    } catch {
      return { projects: 0, actions: 0 }
    }
    for (const name of names) {
      const projectId = name.slice(0, -'.json'.length)
      if (!SAFE_ID.test(projectId)) continue
      const loaded = this.load(projectId)
      if (!loaded.record || loaded.readOnly) continue
      let changed = false
      for (const action of loaded.record.actions) {
        if (action.status !== 'running' && action.status !== 'executed') continue
        action.status = 'uncertain'
        action.requiresReview = true
        action.error = '应用重启，执行结果不明确；请核对文件后标记已核对。'
        action.updatedAt = now()
        actions += 1
        changed = true
      }
      // 没有实际执行者的任务不能继续显示 running；已完成任务原样保留，
      // 排队未启动的任务保留为可恢复项，执行中的尝试转待核对。
      const state = loaded.record.superAgent
      if (state) {
        const recovery = reconcileSuperAgentAfterRestart(state)
        if (recovery.changed) changed = true
      }
      const actionsBefore = JSON.stringify(
        loaded.record.actions.map((action) => [action.id, action.status, action.requiresReview === true])
      )
      if (state) {
        loaded.record.actions = mergeActions(loaded.record.actions, state, projectId)
      }
      const actionsAfter = JSON.stringify(
        loaded.record.actions.map((action) => [action.id, action.status, action.requiresReview === true])
      )
      if (actionsBefore !== actionsAfter) changed = true
      if (changed) {
        loaded.record.revision += 1
        loaded.record.updatedAt = now()
        try {
          this.save(loaded.record)
          projects += 1
        } catch (err) {
          log.warn('collaboration recovery save failed', { projectId, error: String(err) })
        }
      }
    }
    return { projects, actions }
  }

  confirmAction(projectId: string, actionId: string, by: 'user' | 'system' | 'verifier' | 'router' | 'worker' = 'user'): CollaborationProjection {
    const loaded = this.load(projectId)
    if (loaded.readOnly) throw new Error(loaded.reason ?? '本地协作记录当前只读。')
    if (!loaded.record) throw new Error('没有找到这个项目的进度记录。')
    const action = loaded.record.actions.find((item) => item.id === actionId)
    if (!action) throw new Error('没有找到这条待核对动作。')
    if (action.status === 'uncertain' || action.status === 'executed') {
      action.status = 'done'
      action.confirmedAt = now()
      action.confirmedBy = by
      action.requiresReview = false
      action.updatedAt = now()
      loaded.record.revision += 1
      loaded.record.updatedAt = now()
      this.save(loaded.record)
    }
    return projectionOf(loaded.record)
  }

  /** 读取项目当前任务表与成果记录；不存在或只读时仍返回可用内容。 */
  projectState(projectId: string): SuperAgentState | null {
    return this.load(projectId).record?.superAgent ?? null
  }

  /** 测试用：读取原始记录，便于断言迁移/只读行为。 */
  rawProject(projectId: string): CollaborationProjectRecord | null {
    return this.load(projectId).record
  }
}

interface RegisteredControl extends CollaborationTaskControl {
  registeredAt: number
}

interface MergedBatch {
  state: SuperAgentState
  changed: boolean
}

function projectRunId(projectId: string): string {
  return `collab_${projectId.replace(/^project_/, '')}`
}

function taskKey(task: SuperTask): string {
  return task.taskId ?? task.id
}

function mergedStatus(tasks: SuperTask[], batchStatus: SuperAgentState['status']): SuperAgentState['status'] {
  const active = tasks.filter((task) => task.planRemoved !== true)
  if (active.some((task) => task.status === 'running')) return 'running'
  // 批次还在调度队列时，即使当前没有 running，也仍然是运行中。
  if (batchStatus === 'running' && active.some((task) => task.status === 'queued')) return 'running'
  if (active.length > 0 && active.every((task) => task.status === 'completed')) {
    const verificationOk = active
      .filter((task) => task.verify)
      .every((task) => task.verification?.status === 'passed')
    return active.some((task) => task.needsRetest) || !verificationOk ? 'partial' : 'completed'
  }
  const completed = active.filter((task) => task.status === 'completed' && !task.needsRetest).length
  const cancelled = active.filter((task) => task.status === 'cancelled').length
  if (completed > 0) return 'partial'
  if (active.length > 0 && cancelled === active.length) return 'cancelled'
  return 'failed'
}

function mergeArtifact(existing: CollaborationArtifact, incoming: CollaborationArtifact): CollaborationArtifact {
  if (existing.revokedAt && !incoming.revokedAt) return existing
  if (incoming.revokedAt && !existing.revokedAt) return incoming
  if ((incoming.revokedAt ?? 0) >= (existing.revokedAt ?? 0)) return incoming
  return existing
}

function mergeUsage(
  existing: CollaborationArtifactUsage[] | undefined,
  incoming: CollaborationArtifactUsage[] | undefined
): CollaborationArtifactUsage[] | undefined {
  const byId = new Map<string, CollaborationArtifactUsage>()
  for (const usage of [...(existing ?? []), ...(incoming ?? [])]) {
    const previous = byId.get(usage.id)
    if (!previous || usage.readAt >= previous.readAt) byId.set(usage.id, usage)
  }
  return byId.size > 0 ? [...byId.values()].sort((a, b) => a.readAt - b.readAt) : undefined
}

function mergeStuckAlerts(existing: StuckAlert[] | undefined, incoming: StuckAlert[] | undefined): StuckAlert[] | undefined {
  const byId = new Map<string, StuckAlert>()
  for (const alert of [...(existing ?? []), ...(incoming ?? [])]) {
    const previous = byId.get(alert.id)
    if (!previous) {
      byId.set(alert.id, { ...alert })
      continue
    }
    const previousResolved = previous.status === 'resolved' ? previous.resolvedAt ?? 0 : -1
    const nextResolved = alert.status === 'resolved' ? alert.resolvedAt ?? 0 : -1
    if (nextResolved >= previousResolved) byId.set(alert.id, { ...alert })
  }
  return byId.size > 0
    ? [...byId.values()].sort((a, b) => a.detectedAt - b.detectedAt).slice(-50)
    : undefined
}

function lastStatusAt(task: SuperTask): number {
  return (task.statusHistory ?? []).reduce((max, change) => Math.max(max, change.at), 0)
}

/**
 * 同一 taskId 的跨批次合并：
 * - 尝试与状态历史按 id 取并集，重试不会丢掉旧记录；
 * - attempt 更少或状态更旧的晚到快照不能覆盖新尝试。
 */
function mergeTask(existing: SuperTask, incoming: SuperTask, preferIncomingPlan: boolean): SuperTask {
  const attempts = new Map<string, NonNullable<SuperTask['attemptHistory']>[number]>()
  for (const attempt of existing.attemptHistory ?? []) attempts.set(attempt.id, attempt)
  for (const attempt of incoming.attemptHistory ?? []) {
    const previous = attempts.get(attempt.id)
    if (!previous) {
      attempts.set(attempt.id, attempt)
      continue
    }
    const previousAt = previous.finishedAt ?? previous.startedAt
    const nextAt = attempt.finishedAt ?? attempt.startedAt
    if (attempt.status !== 'running' || nextAt >= previousAt) {
      attempts.set(attempt.id, { ...previous, ...attempt })
    }
  }
  const attemptHistory = [...attempts.values()]
    .sort((a, b) => a.attempt - b.attempt || a.startedAt - b.startedAt)
    .slice(-50)
  const history = new Map<string, NonNullable<SuperTask['statusHistory']>[number]>()
  for (const change of existing.statusHistory ?? []) history.set(change.id, change)
  for (const change of incoming.statusHistory ?? []) {
    const previous = history.get(change.id)
    if (!previous || change.at >= previous.at) history.set(change.id, change)
  }
  const statusHistory = [...history.values()].sort((a, b) => a.at - b.at).slice(-100)
  const existingAttempts = Math.max(existing.attempts ?? 0, existing.attemptHistory?.length ?? 0)
  const incomingAttempts = Math.max(incoming.attempts ?? 0, incoming.attemptHistory?.length ?? 0)
  const incomingNewer =
    incomingAttempts > existingAttempts ||
    (incomingAttempts === existingAttempts && lastStatusAt(incoming) >= lastStatusAt(existing))
  const base = incomingNewer ? incoming : existing
  const planFields = preferIncomingPlan
    ? {
        title: incoming.title,
        planKey: incoming.planKey,
        index: incoming.index,
        deliverable: incoming.deliverable,
        files: incoming.files,
        needs: incoming.needs,
        waitReason: incoming.waitReason,
        planRemoved: incoming.planRemoved,
        dependsOn: incoming.dependsOn,
        role: incoming.role,
        roleTitle: incoming.roleTitle,
        verify: incoming.verify,
        verifies: incoming.verifies
      }
    : {}
  const artifactUsage = mergeUsage(existing.artifactUsage, incoming.artifactUsage)
  const earlyStartedBy =
    incoming.earlyStartedBy && incoming.earlyStartedBy.length > 0
      ? incoming.earlyStartedBy
      : existing.earlyStartedBy
  const verificationById = new Map(
    [...(existing.verificationHistory ?? []), ...(incoming.verificationHistory ?? [])].map((record) => [
      record.id,
      record
    ])
  )
  const verificationHistory = [...verificationById.values()]
    .sort((a, b) => a.checkedAt - b.checkedAt)
    .slice(-5)
  const verification =
    (incoming.verification?.checkedAt ?? 0) >= (existing.verification?.checkedAt ?? 0)
      ? incoming.verification ?? existing.verification
      : existing.verification
  const reworkFeedback = incoming.reworkFeedback ?? existing.reworkFeedback
  return {
    ...base,
    ...planFields,
    attempts: Math.max(existingAttempts, incomingAttempts),
    attemptHistory,
    statusHistory,
    ...(artifactUsage ? { artifactUsage } : {}),
    ...(earlyStartedBy ? { earlyStartedBy: [...earlyStartedBy] } : {}),
    ...(verification ? { verification } : {}),
    ...(verificationHistory.length > 0 ? { verificationHistory } : {}),
    ...(reworkFeedback ? { reworkFeedback } : {}),
    reworkCount: Math.max(existing.reworkCount ?? 0, incoming.reworkCount ?? 0) || undefined,
    needsRetest: undefined,
    staleArtifacts: undefined
  }
}

/**
 * 主进程协作运行时：
 * - 把不同 Router 批次的任务合并成同一项目视图；
 * - 按批次 revision 丢弃重复/迟到快照；
 * - 登记后台任务的单独停止控制，供 IPC/驾驶舱调用。
 */
export class CollaborationRuntime implements CollaborationRuntimePort {
  private readonly projects = new Map<string, SuperAgentState>()
  private readonly batchRevisions = new Map<string, number>()
  private readonly controls = new Map<string, RegisteredControl>()
  
  constructor(private readonly store?: CollaborationStore) {}

  private getStore(): CollaborationStore {
    return this.store ?? getCollaborationStore()
  }

  /** 会话从磁盘恢复后，用已有的项目状态作为合并基线。 */
  seedProject(state: SuperAgentState | null | undefined): void {
    if (!state?.projectId || this.projects.has(state.projectId)) return
    this.projects.set(state.projectId, {
      ...state,
      runId: projectRunId(state.projectId),
      revision: state.revision ?? 0
    })
  }

  /** 冲突处理等主进程直接改写后，替换运行时基线，避免下一次批次用旧状态覆盖。 */
  replaceProjectState(state: SuperAgentState): void {
    if (!state.projectId) return
    this.projects.set(state.projectId, {
      ...state,
      runId: projectRunId(state.projectId)
    })
  }

  /**
   * 合并一个 Router 批次的快照。相同批次 revision 不高于上次时视为重复/迟到；
   * 任务按 taskId 合并，旧批次任务不会因为新批次发布而消失。
   */
  mergeBatch(state: SuperAgentState): MergedBatch {
    if (!state.projectId) return { state, changed: true }
    const projectId = state.projectId
    const batchKey = `${projectId}|${state.runId}`
    const revision = state.revision ?? 0
    const lastRevision = this.batchRevisions.get(batchKey)
    if (lastRevision !== undefined && revision <= lastRevision) {
      return {
        state: this.projects.get(projectId) ?? state,
        changed: false
      }
    }
    this.batchRevisions.set(batchKey, revision)

    const existing = this.projects.get(projectId)
    const existingTasks = existing?.tasks ?? []
    const byTask = new Map(existingTasks.map((task) => [taskKey(task), task]))
    const order = existingTasks.map(taskKey)
    const preferIncomingPlan = (state.planRevision ?? 0) >= (existing?.planRevision ?? 0)
    for (const task of state.tasks) {
      const key = taskKey(task)
      if (!byTask.has(key)) order.push(key)
      const previous = byTask.get(key)
      byTask.set(key, previous ? mergeTask(previous, task, preferIncomingPlan) : task)
    }
    const tasks = order
      .map((key) => byTask.get(key))
      .filter((task): task is SuperTask => Boolean(task))
    const now = Date.now()
    const base = existing ?? state
    const { finishedAt: _previousFinishedAt, ...baseWithoutFinish } = base
    const conflictById = new Map(
      [...(base.conflicts ?? []), ...(state.conflicts ?? [])].map((conflict) => [conflict.id, conflict])
    )
    const conflicts = [...conflictById.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-50)
    const artifactById = new Map<string, CollaborationArtifact>()
    for (const artifact of [...(existing?.artifacts ?? []), ...(state.artifacts ?? [])]) {
      const previous = artifactById.get(artifact.id)
      artifactById.set(artifact.id, previous ? mergeArtifact(previous, artifact) : artifact)
    }
    const artifacts = [...artifactById.values()].sort((a, b) => a.publishedAt - b.publishedAt)
    // 可用版本变化后，以最新成果记录重算“谁用了旧版、需要重测”。
    const withArtifacts: SuperAgentState = {
      ...state,
      tasks,
      ...(artifacts.length > 0 ? { artifacts } : { artifacts: undefined })
    }
    const artifactCheck = artifacts.length > 0 || tasks.some((task) => task.needsRetest)
      ? recomputeArtifactStaleness(withArtifacts)
      : { state: withArtifacts, staleTaskIds: [], restoredTaskIds: [], changed: false }
    const checkedTasks = artifactCheck.state.tasks
    const computedStatus = mergedStatus(checkedTasks, state.status)
    const status = conflicts.some((conflict) => conflict.status === 'open') && computedStatus === 'completed'
      ? 'partial'
      : computedStatus
    const planRevision = Math.max(base.planRevision ?? 0, state.planRevision ?? 0) || undefined
    const stateHistoryRevision = state.planHistory?.at(-1)?.revision ?? 0
    const baseHistoryRevision = base.planHistory?.at(-1)?.revision ?? 0
    const planHistory =
      stateHistoryRevision >= baseHistoryRevision
        ? state.planHistory ?? base.planHistory
        : base.planHistory
    const usage =
      (state.usage?.updatedAt ?? 0) >= (existing?.usage?.updatedAt ?? 0) ? state.usage : existing?.usage
    const stuckAlerts = mergeStuckAlerts(existing?.stuckAlerts, state.stuckAlerts)
    const merged: SuperAgentState = {
      ...baseWithoutFinish,
      runId: projectRunId(projectId),
      projectId,
      // 新批次用新的 swarm 工具调用 id，重试/继续沿用原卡片。
      ...(state.toolUseId || base.toolUseId
        ? { toolUseId: state.toolUseId ?? base.toolUseId }
        : {}),
      goal: state.goal || existing?.goal || '',
      status,
      tasks: checkedTasks,
      ...(usage ? { usage: { ...usage } } : {}),
      ...(stuckAlerts ? { stuckAlerts } : { stuckAlerts: undefined }),
      revision: (existing?.revision ?? 0) + 1,
      ...(planRevision ? { planRevision } : {}),
      ...(planHistory && planHistory.length > 0 ? { planHistory } : {}),
      ...(artifacts.length > 0 ? { artifacts } : { artifacts: undefined }),
      ...(conflicts.length > 0 ? { conflicts } : {}),
      createdAt: existing ? Math.min(existing.createdAt, state.createdAt) : state.createdAt,
      updatedAt: now,
      ...(status === 'running' ? {} : { finishedAt: now })
    }
    this.projects.set(projectId, merged)
    return { state: merged, changed: true }
  }

  drainTaskMessages(input: { projectId: string; taskId: string; attemptId: string }): CollaborationMessage[] {
    try {
      return this.getStore().drainMessages(input)
    } catch {
      // 保存失败时保留 pending，下一步再试；不能假装已送达。
      return []
    }
  }

  postTaskMessage(input: {
    projectId: string
    taskId: string
    attemptId?: string
    text: string
    kind: 'note' | 'question'
    author?: string
  }): { message: CollaborationMessage; projection: CollaborationProjection } {
    const message = this.getStore().enqueueMessage({
      projectId: input.projectId,
      taskId: input.taskId,
      text: input.text,
      idempotencyKey: `worker_${input.taskId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      direction: 'worker',
      kind: input.kind,
      ...(input.author ? { author: input.author } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {})
    })
    return { message, projection: this.getStore().projection(input.projectId) }
  }

  async waitForTaskReply(input: {
    projectId: string
    taskId: string
    questionId: string
    signal: AbortSignal
  }): Promise<{ text: string; messageId: string } | null> {
    const startedAt = Date.now()
    const timeoutMs = 10 * 60_000
    while (!input.signal.aborted && Date.now() - startedAt < timeoutMs) {
      const messages = this.getStore().projection(input.projectId).messages
      const reply = messages.find(
        (message) =>
          message.taskId === input.taskId &&
          message.direction === 'main' &&
          message.kind === 'answer' &&
          message.replyTo === input.questionId &&
          message.status !== 'failed' &&
          message.status !== 'cancelled'
      )
      if (reply) {
        try {
          this.getStore().markMessagesAdopted(input.projectId, [input.questionId, reply.id])
        } catch {
          // 状态落盘失败不影响把答复交给 Worker
        }
        return { text: reply.text, messageId: reply.id }
      }
      await new Promise((resolve) => setTimeout(resolve, 350))
    }
    if (!input.signal.aborted) {
      try {
        this.getStore().failMessage(input.projectId, input.questionId, '10 分钟内没有收到主代理答复，Worker 已继续执行。')
      } catch {
        // 问题状态保存失败不阻断 Worker
      }
    }
    return null
  }

  markTaskMessagesRead(input: { projectId: string; messageIds: string[] }): void {
    try {
      this.getStore().markMessagesRead(input.projectId, input.messageIds)
    } catch {
      // 下一条补充仍会保留在待投递列表
    }
  }

  markTaskMessagesAdopted(input: { projectId: string; messageIds: string[] }): void {
    try {
      this.getStore().markMessagesAdopted(input.projectId, input.messageIds)
    } catch {
      // 已读记录保留，稍后可人工核对
    }
  }

  registerTask(control: CollaborationTaskControl): void {
    this.controls.set(`${control.projectId}:${control.taskId}`, {
      ...control,
      registeredAt: Date.now()
    })
  }

  unregisterTask(input: { projectId: string; taskId: string; attemptId: string }): void {
    const key = `${input.projectId}:${input.taskId}`
    const current = this.controls.get(key)
    if (!current || current.attemptId !== input.attemptId) return
    this.controls.delete(key)
  }

  setTaskWaiting(input: { projectId: string; taskId: string; attemptId: string; waiting: boolean }): void {
    const control = this.controls.get(`${input.projectId}:${input.taskId}`)
    if (!control || control.attemptId !== input.attemptId) return
    try {
      control.setWaiting?.(input.waiting)
    } catch {
      // 看门狗状态更新失败不能阻断 Worker 的审批流程
    }
  }

  /** 供计划修订读取最新项目状态；未登记项目时返回 null。 */
  projectState(projectId: string): SuperAgentState | null {
    return this.projects.get(projectId) ?? null
  }

  /** 等后台任务真正退出（控制注销），避免修订计划时新旧尝试同时写文件。 */
  async waitForTaskStop(projectId: string, taskId: string, timeoutMs = 8_000): Promise<boolean> {
    const key = `${projectId}:${taskId}`
    const startedAt = Date.now()
    while (this.controls.has(key)) {
      if (Date.now() - startedAt >= timeoutMs) return false
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return true
  }

  /** 单独停止一个正在运行的任务；返回 false 表示任务已结束或不在本机。 */
  stopTask(projectId: string, taskId: string): boolean {
    const control = this.controls.get(`${projectId}:${taskId}`)
    if (!control) return false
    try {
      control.stop()
      return true
    } catch {
      return false
    }
  }

  /** 删除会话时只停止它自己启动的任务；同工作区其他会话的任务继续。 */
  stopSessionTasks(projectId: string, sessionId: string): number {
    let stopped = 0
    for (const [key, control] of [...this.controls]) {
      if (control.projectId !== projectId || control.sessionId !== sessionId) continue
      this.controls.delete(key)
      try {
        control.stop()
        stopped += 1
      } catch {
        // 单个任务停止失败不能阻断会话删除
      }
    }
    return stopped
  }

  /** 关闭某任务的卡住提醒但不停止任务；返回 false 表示任务已结束或没有可关闭的提醒。 */
  dismissTaskStuck(projectId: string, taskId: string): boolean {
    const control = this.controls.get(`${projectId}:${taskId}`)
    if (!control?.dismissStuck) return false
    try {
      control.dismissStuck()
      return true
    } catch {
      return false
    }
  }

  hasTask(projectId: string, taskId: string): boolean {
    return this.controls.has(`${projectId}:${taskId}`)
  }

  runningTaskIds(projectId: string): string[] {
    return [...this.controls.values()]
      .filter((control) => control.projectId === projectId)
      .map((control) => control.taskId)
  }

  clearProject(projectId: string): void {
    this.projects.delete(projectId)
    for (const [key] of this.batchRevisions) {
      if (key.startsWith(`${projectId}|`)) this.batchRevisions.delete(key)
    }
    for (const [key, value] of this.controls) {
      if (value.projectId === projectId) this.controls.delete(key)
    }
  }

  /** 会话删除时撤销其后台任务，避免旧 Worker 继续写文件。 */
  stopProject(projectId: string): void {
    for (const control of [...this.controls.values()]) {
      if (control.projectId !== projectId) continue
      try {
        control.stop()
      } catch {
        // ignore
      }
    }
    this.clearProject(projectId)
  }
}

let runtimeInstance: CollaborationRuntime | null = null

export function getCollaborationRuntime(): CollaborationRuntime {
  if (!runtimeInstance) runtimeInstance = new CollaborationRuntime()
  return runtimeInstance
}

/** 测试用：重置运行时单例。 */
export function resetCollaborationRuntime(): void {
  runtimeInstance = null
}

const SAFE_PROJECT = /^[A-Za-z0-9_-]{3,100}$/
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const MAX_READ_BYTES = 512 * 1024

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent).toLowerCase(), resolve(child).toLowerCase())
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function safeFileName(path: string): string {
  const name = basename(path).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim()
  return name || 'artifact.txt'
}

function isBinary(data: Buffer): boolean {
  return data.subarray(0, 4096).includes(0)
}

/**
 * 成果快照与版本事件：
 * - 发布时把文件复制到用户数据目录，依赖成员读取只读快照，不受发布者工作副本影响；
 * - 每次发布/读取/撤回写入 append-only 事件，配合任务表记录谁用了哪一版；
 * - 状态仍写入协作项目记录，`super_updated` 由调用方转发到界面。
 */
export class CollaborationArtifactService implements CollaborationArtifactPort {
  private lastEventRevision = 0

  constructor(private readonly dataDir: string = resolveDataDir()) {}

  private projectDir(projectId: string): string {
    if (!SAFE_PROJECT.test(projectId)) throw new Error('项目编号不合法，无法保存成果。')
    return join(this.dataDir, 'collaboration', 'projects', projectId, 'artifacts')
  }

  private currentState(projectId: string): SuperAgentState | null {
    const runtime = getCollaborationRuntime()
    const seeded = runtime.projectState(projectId)
    if (seeded) return seeded
    const stored = getCollaborationStore().projectState(projectId)
    if (!stored) return null
    runtime.seedProject(stored)
    return runtime.projectState(projectId) ?? stored
  }

  private nextEventRevision(): number {
    this.lastEventRevision = Math.max(Date.now(), this.lastEventRevision + 1)
    return this.lastEventRevision
  }

  private commit(state: SuperAgentState): SuperAgentState {
    getCollaborationRuntime().replaceProjectState(state)
    // 独立事件批次：成果发布可能发生在 Router 批次之间，不能占用它的 revision 序列。
    return { ...state, runId: 'artifact', revision: this.nextEventRevision() }
  }

  private appendEvent(event: Record<string, unknown>): void {
    try {
      const path = join(this.dataDir, 'collaboration', 'artifacts.jsonl')
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8')
    } catch {
      // 审计日志失败不能阻断成员交接；项目记录仍保留版本与使用情况。
    }
  }

  list(projectId: string, name?: string): CollaborationArtifact[] {
    const artifacts = this.currentState(projectId)?.artifacts ?? []
    const target = name?.trim()
    return artifacts
      .filter((artifact) => !target || artifact.name === target)
      .slice()
      .sort((a, b) => a.publishedAt - b.publishedAt)
  }

  async publish(input: CollaborationArtifactPublishInput): Promise<CollaborationArtifactOutcome> {
    const state = this.currentState(input.projectId)
    if (!state) throw new Error('项目还没有任务记录，不能发布成果。')
    const name = input.name.trim().slice(0, 80)
    if (!name) throw new Error('成果名不能为空。')
    const workspace = resolve(input.workspace)
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
      throw new Error('发布者工作区不可访问，无法发布成果。')
    }
    const source = isAbsolute(input.path) ? resolve(input.path) : resolve(workspace, input.path)
    if (!inside(workspace, source)) {
      throw new Error('成果文件必须位于发布者的工作区内。')
    }
    if (!existsSync(source) || !statSync(source).isFile()) {
      throw new Error(`要发布的文件不存在：${input.path}`)
    }
    // 符号链接可能指向工作区外：按真实路径再校验一次，避免把外部文件带进项目成果。
    const realWorkspace = realpathSync(workspace)
    const realSource = realpathSync(source)
    if (!inside(realWorkspace, realSource)) {
      throw new Error('成果文件通过链接指向了工作区外，已拒绝发布。')
    }
    const stat = statSync(realSource)
    if (stat.size > MAX_SNAPSHOT_BYTES) {
      throw new Error(`成果文件超过 ${Math.round(MAX_SNAPSHOT_BYTES / 1024 / 1024)}MB，无法保存只读快照。`)
    }
    const data = readFileSync(realSource)
    const hash = sha256(data)
    const version = Math.max(
      0,
      ...(state.artifacts ?? []).filter((artifact) => artifact.name === name).map((artifact) => artifact.version)
    ) + 1
    const requested = input.version ?? version
    if (requested !== version) {
      throw new Error(`「${name}」的下一版是 v${version}；版本号必须逐版递增。`)
    }
    const publishedPath = relative(workspace, source).split(sep).join('/')
    const snapshotName = basename(source)
    const dir = join(this.projectDir(input.projectId), sha256(name).slice(0, 12), `v${requested}`)
    const snapshotPath = join(dir, safeFileName(snapshotName))
    mkdirSync(dir, { recursive: true })
    writeFileSync(snapshotPath, data)
    const at = Date.now()
    const artifact: CollaborationArtifact = {
      id: `artifact_${sha256(`${input.projectId}|${name}|${requested}|${at}`).slice(0, 16)}`,
      projectId: input.projectId,
      name,
      version: requested,
      path: publishedPath,
      status: input.status,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      ...(input.summary?.trim() ? { summary: input.summary.trim().slice(0, 600) } : {}),
      hash,
      size: data.length,
      snapshotPath,
      publishedAt: at
    }
    let result: ReturnType<typeof publishArtifactVersion>
    try {
      result = publishArtifactVersion(state, artifact)
    } catch (err) {
      // 版本冲突时删除刚写入的快照目录，避免留下无法引用的文件。
      rmSync(dir, { recursive: true, force: true })
      this.appendEvent({ type: 'publish-rejected', at, projectId: input.projectId, name, version: requested, error: String(err) })
      throw err
    }
    const eventState = this.commit(result.state)
    this.appendEvent({
      type: 'publish',
      at,
      projectId: input.projectId,
      name,
      version: requested,
      status: input.status,
      path: publishedPath,
      hash: hash.slice(0, 16),
      taskId: input.taskId ?? null,
      attemptId: input.attemptId ?? null,
      staleTaskIds: result.staleTaskIds,
      restoredTaskIds: result.restoredTaskIds
    })
    return {
      state: eventState,
      artifact,
      staleTaskIds: result.staleTaskIds,
      restoredTaskIds: result.restoredTaskIds
    }
  }

  async read(input: {
    projectId: string
    taskId?: string
    attemptId?: string
    name: string
    version?: number
  }): Promise<CollaborationArtifactReadResult> {
    const state = this.currentState(input.projectId)
    if (!state) throw new Error('项目还没有任务记录，无法读取成果。')
    const name = input.name.trim()
    const artifact =
      input.version !== undefined
        ? (state.artifacts ?? []).find((entry) => entry.name === name && entry.version === input.version)
        : latestReadyArtifact(state.artifacts, name)
    if (!artifact) {
      throw new Error(`「${name}」还没有发布过这一版。`)
    }
    if (artifact.status === 'draft') {
      throw new Error(`「${name}」v${artifact.version} 还是草稿，不能交给其他成员使用。`)
    }
    if (artifact.status === 'revoked') {
      throw new Error(`「${name}」v${artifact.version} 的可用标记已撤回，不能再使用。`)
    }
    const buffer = readFileSync(artifact.snapshotPath)
    const content = isBinary(buffer)
      ? `（二进制成果 ${Math.round(buffer.length / 1024)}KB，无法在对话里展开；文件：${artifact.path}）`
      : buffer.subarray(0, MAX_READ_BYTES).toString('utf8')
    let nextState = state
    let usage: CollaborationArtifactReadResult['usage']
    if (input.taskId && input.attemptId && state.tasks.some((task) => (task.taskId ?? task.id) === input.taskId)) {
      const recorded = recordArtifactUsage(state, {
        artifactId: artifact.id,
        name: artifact.name,
        version: artifact.version,
        taskId: input.taskId,
        attemptId: input.attemptId
      })
      nextState = recorded.state
      usage = recorded.usage
      this.appendEvent({
        type: 'read',
        at: recorded.usage.readAt,
        projectId: input.projectId,
        name: artifact.name,
        version: artifact.version,
        taskId: input.taskId,
        attemptId: input.attemptId,
        status: recorded.usage.status
      })
    }
    const eventState = nextState === state ? { ...state, runId: 'artifact', revision: Date.now() } : this.commit(nextState)
    return { state: eventState, artifact, content, ...(usage ? { usage } : {}) }
  }

  async revoke(input: {
    projectId: string
    name: string
    version: number
    reason?: string
  }): Promise<CollaborationArtifactOutcome> {
    const state = this.currentState(input.projectId)
    if (!state) throw new Error('项目还没有任务记录，无法撤回成果。')
    const result = revokeArtifactVersion(state, {
      name: input.name.trim(),
      version: input.version,
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {})
    })
    const eventState = this.commit(result.state)
    this.appendEvent({
      type: 'revoke',
      at: result.artifact.revokedAt ?? Date.now(),
      projectId: input.projectId,
      name: result.artifact.name,
      version: result.artifact.version,
      reason: result.artifact.revokeReason ?? null,
      staleTaskIds: result.staleTaskIds,
      restoredTaskIds: result.restoredTaskIds
    })
    return {
      state: eventState,
      artifact: result.artifact,
      staleTaskIds: result.staleTaskIds,
      restoredTaskIds: result.restoredTaskIds
    }
  }
}

let artifactInstance: CollaborationArtifactService | null = null

export function getCollaborationArtifactService(): CollaborationArtifactService {
  if (!artifactInstance) artifactInstance = new CollaborationArtifactService()
  return artifactInstance
}

function normalizePath(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/^\.\//, '')
}

/**
 * 集成验证器：在合并后的候选工作区上核对必需文件、运行真实验收命令。
 * 候选版本只由交付文件内容决定，同一内容得到同一编号；文件变化立即产生新版本。
 */
export class CollaborationVerificationService implements CollaborationVerificationPort {
  constructor(private readonly dataDir: string = resolveDataDir()) {}

  private candidateFor(workspace: string, files: string[], required: string[]): CollaborationVerificationCandidate {
    const root = resolve(workspace)
    const requiredSet = new Set(required.map(normalizePath))
    const entries: CollaborationVerificationFile[] = []
    for (const raw of [...new Set(files.map(normalizePath).filter(Boolean))].sort()) {
      const path = resolve(root, raw)
      if (!inside(root, path)) {
        entries.push({ path: raw, required: requiredSet.has(raw), exists: false })
        continue
      }
      if (!existsSync(path)) {
        entries.push({ path: raw, required: requiredSet.has(raw), exists: false })
        continue
      }
      const stat = statSync(path)
      if (!stat.isFile()) {
        entries.push({ path: raw, required: requiredSet.has(raw), exists: false })
        continue
      }
      const data = readFileSync(path)
      entries.push({
        path: raw,
        required: requiredSet.has(raw),
        exists: true,
        hash: sha256(data),
        size: data.length
      })
    }
    const version = `cand_${sha256(JSON.stringify(entries.map((entry) => [entry.path, entry.exists, entry.hash ?? '']))).slice(0, 12)}`
    return { version, files: entries }
  }

  candidate(input: { workspace: string; files: string[]; required: string[] }): CollaborationVerificationCandidate {
    return this.candidateFor(input.workspace, input.files, input.required)
  }

  async run(input: {
    sessionId: string
    projectId: string
    taskId: string
    workspace: string
    files: string[]
    required: string[]
    command?: string
    timeoutMs?: number
    attempt: number
  }): Promise<CollaborationVerificationRun> {
    const before = this.candidateFor(input.workspace, input.files, input.required)
    let command: CollaborationVerificationCommand | undefined
    if (input.command?.trim()) {
      if (!isSafeVerificationCommand(input.command)) {
        throw new Error('验收命令不在安全测试命令范围内；只允许测试运行器，可用 cd <项目目录> && 或追加 2>&1。')
      }
      const timeoutMs = Math.max(5_000, Math.min(10 * 60_000, input.timeoutMs ?? 120_000))
      const manager = getSharedResourceManager()
      const ownerId = `verify:${input.sessionId}:${input.taskId}`
      const owner = {
        ownerId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        label: `验收 ${input.taskId}`
      }
      const leases: string[] = []
      try {
        for (const port of detectCommandPorts(input.command)) {
          const lease = await manager.acquire({
            kind: 'port',
            resource: `port:${port}`,
            owner,
            ttlMs: timeoutMs + 60_000
          })
          if (!lease.ok) {
            throw new Error(`验收命令需要端口 ${port}，${lease.reason}`)
          }
          leases.push(port.toString())
        }
        const workspace = resolve(input.workspace)
        const startedAt = Date.now()
        const result = await getTerminalManager().runOnce(input.command, workspace, timeoutMs)
        const secret = [workspace, workspace.replaceAll('\\', '/'), workspace.replaceAll('/', '\\')]
        let output = result.output.slice(-6_000)
        for (const form of secret) {
          output = output
            .replaceAll(form, '<工作区>')
            .replaceAll(encodeURI(form), '<工作区>')
            .replaceAll(encodeURIComponent(form), '<工作区>')
        }
        command = {
          command: input.command,
          exitCode: result.exitCode,
          output,
          timedOut: result.timedOut,
          durationMs: Date.now() - startedAt
        }
      } finally {
        if (leases.length > 0) manager.releaseOwner({ ownerId })
      }
    }
    const after = this.candidateFor(input.workspace, input.files, input.required)
    this.appendAudit({
      type: 'verify',
      at: Date.now(),
      projectId: input.projectId,
      taskId: input.taskId,
      attempt: input.attempt,
      candidateVersion: before.version,
      candidateAfter: after.version,
      command: input.command ?? null,
      exitCode: command?.exitCode ?? null,
      timedOut: command?.timedOut ?? false,
      missing: before.files.filter((file) => file.required && !file.exists).map((file) => file.path)
    })
    return {
      ...before,
      ...(command ? { command } : {}),
      candidateAfter: after.version
    }
  }

  private appendAudit(event: Record<string, unknown>): void {
    try {
      const path = join(this.dataDir, 'collaboration', 'verifications.jsonl')
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8')
    } catch {
      // 审计日志失败不能阻断验收；验收记录仍写入任务状态。
    }
  }
}

let verificationInstance: CollaborationVerificationService | null = null

export function getCollaborationVerificationService(): CollaborationVerificationService {
  if (!verificationInstance) verificationInstance = new CollaborationVerificationService()
  return verificationInstance
}
