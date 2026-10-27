/**
 * 定时任务存储：CRUD + 下一次执行时间 + 最近一次结果。
 * 纯 Node（不 import electron），便于单元测试；文件原子写入、损坏自动备份。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  SCHEDULE_MAX_PROMPT_CHARS,
  SCHEDULE_MAX_TASKS,
  SCHEDULE_MAX_TITLE_CHARS,
  computeNextRun,
  isScheduledPermission,
  validateScheduleSpec,
  type ScheduledPermission,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduledTaskStatus,
  type ScheduleSpec
} from '../../shared/schedules'

const STORE_VERSION = 1
const STORE_MAX_BYTES = 2 * 1024 * 1024

interface StoreFile {
  version: number
  tasks: ScheduledTask[]
}

function newTaskId(): string {
  return `sch_${createHash('sha1').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 12)}`
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const content = JSON.stringify(value, null, 2)
  if (Buffer.byteLength(content, 'utf8') > STORE_MAX_BYTES) throw new Error('定时任务数据超过大小上限。')
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
    }
    throw err
  }
  // Windows 上杀毒/索引服务可能短暂占用目标文件，rename 会报 EPERM/EBUSY。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      renameSync(tmp, path)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
        try {
          rmSync(tmp, { force: true })
        } catch {
        }
        throw err
      }
      if (attempt === 3) {
        try {
          writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 })
          rmSync(tmp, { force: true })
          return
        } catch (writeErr) {
          try {
            rmSync(tmp, { force: true })
          } catch {
          }
          throw writeErr
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1))
    }
  }
}

function readSafe(path: string): unknown | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}.bak`)
    } catch {
    }
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数格式不正确')
  return value as Record<string, unknown>
}

function clampText(value: unknown, max: number, label: string, required = true): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label}不能为空`)
    return ''
  }
  if (typeof value !== 'string') throw new Error(`${label}必须是文本`)
  const cleaned = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
  if (required && !cleaned) throw new Error(`${label}不能为空`)
  if (cleaned.length > max) throw new Error(`${label}过长（最多 ${max} 字）`)
  return cleaned
}

function sanitizeSpec(raw: unknown): ScheduleSpec {
  const record = asRecord(raw)
  return {
    kind: record.kind as ScheduleSpec['kind'],
    time: typeof record.time === 'string' ? record.time : '',
    ...(typeof record.date === 'string' ? { date: record.date } : {}),
    ...(typeof record.weekday === 'number' ? { weekday: record.weekday } : {})
  }
}

function normalizeWorkspace(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !value.trim()) return null
  let real: string
  try {
    real = realpathSync(resolve(value))
  } catch {
    throw new Error('文件夹不存在或不可访问。')
  }
  if (!statSync(real).isDirectory()) throw new Error('定时任务的文件夹必须是一个目录。')
  return real
}

function normalizeStatus(value: unknown): ScheduledTaskStatus {
  return value === 'running' ||
    value === 'success' ||
    value === 'error' ||
    value === 'stopped' ||
    value === 'missed'
    ? value
    : 'never'
}

export interface ScheduleStoreOptions {
  /** 数据目录（任务文件会写到 <dataDir>/tasks.json） */
  dir: string
  now?: () => number
}

export class ScheduleStore {
  private readonly dir: string
  private readonly now: () => number
  private tasks: ScheduledTask[] | null = null

  constructor(options: ScheduleStoreOptions) {
    if (!options?.dir) throw new Error('ScheduleStore 需要数据目录')
    this.dir = resolve(options.dir)
    this.now = options.now ?? (() => Date.now())
  }

  filePath(): string {
    return join(this.dir, 'tasks.json')
  }

  private load(): ScheduledTask[] {
    if (this.tasks) return this.tasks
    const raw = readSafe(this.filePath())
    const tasks: ScheduledTask[] = []
    if (raw && typeof raw === 'object' && Array.isArray((raw as StoreFile).tasks)) {
      for (const candidate of (raw as StoreFile).tasks) {
        try {
          const record = asRecord(candidate)
          const spec = sanitizeSpec(record.schedule)
          if (
            typeof record.id !== 'string' ||
            typeof record.title !== 'string' ||
            typeof record.prompt !== 'string' ||
            (typeof record.workspace !== 'string' && record.workspace !== null) ||
            !isScheduledPermission(record.permissionMode)
          ) {
            continue
          }
          // 规则可能因版本变化失效：保留任务但暂停，避免调度时反复报错。
          const specValid = (() => {
            try {
              validateScheduleSpec(spec, 0)
              return true
            } catch {
              return false
            }
          })()
          tasks.push({
            id: record.id,
            title: record.title.slice(0, SCHEDULE_MAX_TITLE_CHARS),
            prompt: record.prompt.slice(0, SCHEDULE_MAX_PROMPT_CHARS),
            schedule: spec,
            workspace: typeof record.workspace === 'string' ? record.workspace : null,
            permissionMode: record.permissionMode,
            enabled: record.enabled === true && specValid,
            createdAt: typeof record.createdAt === 'number' ? record.createdAt : this.now(),
            updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : this.now(),
            nextRunAt: typeof record.nextRunAt === 'number' ? record.nextRunAt : null,
            lastRunAt: typeof record.lastRunAt === 'number' ? record.lastRunAt : null,
            lastStatus: normalizeStatus(record.lastStatus),
            ...(typeof record.lastError === 'string' && record.lastError ? { lastError: record.lastError } : {}),
            ...(typeof record.lastSessionId === 'string' && record.lastSessionId
              ? { lastSessionId: record.lastSessionId }
              : {})
          })
        } catch {
          // 跳过损坏条目
        }
      }
    }
    this.tasks = tasks.slice(0, SCHEDULE_MAX_TASKS)
    return this.tasks
  }

  private save(): void {
    const tasks = this.load()
    atomicWrite(this.filePath(), { version: STORE_VERSION, tasks })
  }

  list(): ScheduledTask[] {
    return [...this.load()].sort((a, b) => {
      const aNext = a.nextRunAt ?? Number.MAX_SAFE_INTEGER
      const bNext = b.nextRunAt ?? Number.MAX_SAFE_INTEGER
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
      if (aNext !== bNext) return aNext - bNext
      return b.updatedAt - a.updatedAt
    })
  }

  get(id: string): ScheduledTask | null {
    return this.load().find((task) => task.id === id) ?? null
  }

  /** 启动时把上次进程遗留的「运行中」还原为失败，避免永远转圈。 */
  recoverInterrupted(): boolean {
    let changed = false
    for (const task of this.load()) {
      if (task.lastStatus !== 'running') continue
      task.lastStatus = 'error'
      task.lastError = 'Morrow 上次在执行这个任务时退出了。'
      task.nextRunAt = this.nextAfter(task, this.now(), true)
      if (task.schedule.kind === 'once') {
        task.enabled = false
        task.nextRunAt = null
      }
      task.updatedAt = this.now()
      changed = true
    }
    if (changed) this.save()
    return changed
  }

  /** 处理启动时已过期很久的任务：不补跑，记一次「错过」，并排到下一次。 */
  recoverMissed(catchupMs: number): number {
    const now = this.now()
    let changed = 0
    for (const task of this.load()) {
      if (!task.enabled || task.nextRunAt === null || task.nextRunAt > now) continue
      if (now - task.nextRunAt <= catchupMs) continue
      task.lastStatus = 'missed'
      task.lastError = 'Morrow 当时没有运行，这次已跳过。'
      if (task.schedule.kind === 'once') {
        task.enabled = false
        task.nextRunAt = null
      } else {
        task.nextRunAt = this.nextAfter(task, now, true)
      }
      task.updatedAt = now
      changed += 1
    }
    if (changed > 0) this.save()
    return changed
  }

  create(input: ScheduledTaskInput): ScheduledTask {
    const tasks = this.load()
    if (tasks.length >= SCHEDULE_MAX_TASKS) throw new Error(`定时任务最多 ${SCHEDULE_MAX_TASKS} 个。`)
    const normalized = this.normalizeInput(input)
    const timestamp = this.now()
    const schedule = validateScheduleSpec(normalized.schedule, timestamp)
    const task: ScheduledTask = {
      id: newTaskId(),
      title: normalized.title,
      prompt: normalized.prompt,
      schedule: schedule.spec,
      workspace: normalized.workspace,
      permissionMode: normalized.permissionMode,
      enabled: normalized.enabled,
      createdAt: timestamp,
      updatedAt: timestamp,
      nextRunAt: normalized.enabled ? schedule.nextRunAt : null,
      lastRunAt: null,
      lastStatus: 'never'
    }
    tasks.push(task)
    this.save()
    return { ...task }
  }

  update(id: string, input: ScheduledTaskInput): ScheduledTask {
    const task = this.get(id)
    if (!task) throw new Error('找不到这个定时任务（可能已被删除）。')
    const normalized = this.normalizeInput(input)
    const scheduleChanged = JSON.stringify(task.schedule) !== JSON.stringify(normalized.schedule)
    const enabling = normalized.enabled && !task.enabled
    const timestamp = this.now()
    const schedule = validateScheduleSpec(normalized.schedule, timestamp)
    task.title = normalized.title
    task.prompt = normalized.prompt
    task.schedule = schedule.spec
    task.workspace = normalized.workspace
    task.permissionMode = normalized.permissionMode
    task.enabled = normalized.enabled
    task.updatedAt = timestamp
    if (!normalized.enabled) task.nextRunAt = null
    else if (enabling || scheduleChanged || task.nextRunAt === null) task.nextRunAt = schedule.nextRunAt
    this.save()
    return { ...task }
  }

  remove(id: string): void {
    const tasks = this.load()
    const next = tasks.filter((task) => task.id !== id)
    if (next.length === tasks.length) throw new Error('找不到这个定时任务（可能已被删除）。')
    this.tasks = next
    this.save()
  }

  /** 清除全部对话后，任务不能再指向已删除的会话；同时重置由对话产生的运行历史。 */
  clearSessionReferences(): number {
    let changed = 0
    for (const task of this.load()) {
      if (
        task.lastSessionId === undefined &&
        task.lastRunAt === null &&
        task.lastStatus === 'never' &&
        task.lastError === undefined
      ) {
        continue
      }
      delete task.lastSessionId
      delete task.lastError
      task.lastRunAt = null
      task.lastStatus = 'never'
      task.updatedAt = this.now()
      changed += 1
    }
    if (changed > 0) this.save()
    return changed
  }

  setEnabled(id: string, enabled: boolean): ScheduledTask {
    const task = this.get(id)
    if (!task) throw new Error('找不到这个定时任务（可能已被删除）。')
    if (task.enabled === enabled) return { ...task }
    const timestamp = this.now()
    if (enabled) {
      const schedule = validateScheduleSpec(task.schedule, timestamp)
      task.nextRunAt = schedule.nextRunAt
      task.schedule = schedule.spec
    } else {
      task.nextRunAt = null
    }
    task.enabled = enabled
    task.updatedAt = timestamp
    this.save()
    return { ...task }
  }

  markRunning(id: string, sessionId: string): ScheduledTask {
    const task = this.get(id)
    if (!task) throw new Error('找不到这个定时任务。')
    task.lastStatus = 'running'
    task.lastRunAt = this.now()
    task.lastSessionId = sessionId
    delete task.lastError
    task.updatedAt = this.now()
    this.save()
    return { ...task }
  }

  markFinished(
    id: string,
    status: Exclude<ScheduledTaskStatus, 'never' | 'running'>,
    options: { error?: string; manual?: boolean } = {}
  ): ScheduledTask {
    const task = this.get(id)
    if (!task) throw new Error('找不到这个定时任务。')
    const now = this.now()
    task.lastStatus = status
    task.lastRunAt = task.lastRunAt ?? now
    if (options.error) task.lastError = options.error.slice(0, 1000)
    else delete task.lastError
    if (!options.manual) {
      if (task.schedule.kind === 'once') {
        task.enabled = false
        task.nextRunAt = null
      } else if (task.enabled) {
        task.nextRunAt = this.nextAfter(task, now, true)
      } else {
        // 运行中被用户暂停：完成后保持暂停，不能又写回下一次执行时间
        task.nextRunAt = null
      }
    }
    task.updatedAt = now
    this.save()
    return { ...task }
  }

  /** 到期的启用任务（按下一个执行时间升序）。 */
  due(now: number = this.now()): ScheduledTask[] {
    return this.load()
      .filter((task) => task.enabled && task.nextRunAt !== null && task.nextRunAt <= now)
      .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))
  }

  nextRunFor(spec: ScheduleSpec, from: number = this.now()): number | null {
    return computeNextRun(spec, from)
  }

  private nextAfter(task: ScheduledTask, from: number, strict: boolean): number | null {
    const next = computeNextRun(task.schedule, strict ? from + 1000 : from)
    if (next === null) return null
    return next
  }

  private normalizeInput(input: ScheduledTaskInput): ScheduledTaskInput {
    if (!input || typeof input !== 'object') throw new Error('定时任务参数格式不正确')
    return {
      title: clampText(input.title, SCHEDULE_MAX_TITLE_CHARS, '任务名称'),
      prompt: clampText(input.prompt, SCHEDULE_MAX_PROMPT_CHARS, '任务内容'),
      schedule: input.schedule,
      workspace: normalizeWorkspace(input.workspace),
      permissionMode: isScheduledPermission(input.permissionMode) ? input.permissionMode : 'read-only',
      enabled: input.enabled !== false
    }
  }
}

export function scheduledInputFromRecord(payload: unknown): ScheduledTaskInput {
  const record = asRecord(payload)
  const schedule = asRecord(record.schedule)
  return {
    title: record.title as string,
    prompt: record.prompt as string,
    schedule: sanitizeSpec(schedule),
    workspace: typeof record.workspace === 'string' ? record.workspace : null,
    permissionMode: record.permissionMode as ScheduledPermission,
    enabled: record.enabled !== false
  }
}
