// 定时任务仓库与运行时：由 schedule-store、schedule-runtime 扁平合并。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { ScheduledPermission, ScheduledTask, ScheduledTaskInput, ScheduledTaskStatus, ScheduleSpec } from '../shared/contracts'
import { SCHEDULE_MAX_PROMPT_CHARS, SCHEDULE_MAX_TASKS, SCHEDULE_MAX_TITLE_CHARS, computeNextRun, isScheduledPermission, validateScheduleSpec, SCHEDULE_CATCHUP_MS, SCHEDULE_RUN_TIMEOUT_MS } from '../shared/contracts'
import { BrowserWindow } from 'electron'
import type { Session } from '../shared/types'
import { dataPath } from './workspace'
import { getSettingsStore } from './settings'
import { getSessionStore } from './session'
import { getAgentService } from './agent'
import { getIslandWindow } from './runtime'
import { sendFeatureEvent } from './feature-ipc'
import { log } from './logger'



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


export interface ScheduleState {
  tasks: ScheduledTask[]
  runningTaskIds: string[]
}


let store: ScheduleStore | null = null

let timer: NodeJS.Timeout | null = null

let runningTaskId: string | null = null

let initialized = false


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}


function mainWindow(): BrowserWindow | null {
  const island = getIslandWindow()
  return (
    BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win !== island) ?? null
  )
}


function requireStore(): ScheduleStore {
  if (!store) throw new Error('定时任务还没有初始化。')
  return store
}


export function scheduleState(): ScheduleState {
  const current = store
  return {
    tasks: current ? current.list() : [],
    runningTaskIds: runningTaskId ? [runningTaskId] : []
  }
}


function broadcast(): void {
  sendFeatureEvent('feature:schedules:changed', scheduleState())
}


export function initializeScheduleRuntime(): void {
  if (initialized) return
  store = new ScheduleStore({ dir: dataPath('schedules') })
  const recovered = store.recoverInterrupted()
  const missed = store.recoverMissed(SCHEDULE_CATCHUP_MS)
  if (recovered || missed) log.info('schedules recovered', { interrupted: recovered, missed })
  initialized = true
  timer = setInterval(() => {
    void tick()
  }, 5_000)
  timer.unref?.()
  broadcast()
  log.info('schedule runtime initialized', { tasks: store.list().length })
}


export function disposeScheduleRuntime(): void {
  if (timer) clearInterval(timer)
  timer = null
  runningTaskId = null
  store = null
  initialized = false
}


async function tick(): Promise<void> {
  if (!store || runningTaskId) return
  const due = store.due()
  if (due.length === 0) return
  const task = due[0]
  try {
    await launchTask(task, false)
  } catch (err) {
    log.warn('scheduled task failed to start', {
      id: task.id,
      error: err instanceof Error ? err.message : String(err)
    })
    broadcast()
  }
}


function scheduledPrompt(task: ScheduledTask): string {
  return [
    task.prompt,
    '',
    '（这是定时任务，无人值守：不要向我提问；信息不足时做出合理假设，并在结尾说明你的假设。',
    '需要额外授权的高风险操作会被自动拒绝，请不要尝试绕过限制。）'
  ].join('\n')
}


/**
 * 启动一次任务。同步完成「建会话 + 发起运行」后返回；结果在后台跟踪，不阻塞 IPC。
 * manual=true 时（立即运行）不推进下一次自动执行时间。
 */
async function launchTask(task: ScheduledTask, manual: boolean): Promise<ScheduledTask> {
  if (!store) throw new Error('定时任务还没有初始化。')
  if (runningTaskId) throw new Error('另一个定时任务正在运行，等它完成后再试。')
  // 手动运行恰好撞上已到点的自动执行时，让这次手动运行“吃掉”该次到期，避免完成后立刻再跑一遍。
  const dueAtStart = task.enabled && task.nextRunAt !== null && task.nextRunAt <= Date.now()
  const scheduleManual = manual && !dueAtStart
  let workspace = task.workspace
  if (workspace) {
    try {
      workspace = realpathSync(workspace)
      if (!statSync(workspace).isDirectory()) throw new Error('not a directory')
    } catch {
      store.markFinished(task.id, 'error', { error: '绑定的文件夹不存在了，请重新选择文件夹。', manual: scheduleManual })
      broadcast()
      throw new Error('绑定的文件夹不存在了，请重新选择文件夹。')
    }
  }
  const settings = getSettingsStore().get()
  const sessionStore = getSessionStore()
  let session: Session
  try {
    session = sessionStore.create({
      workspace,
      title: `定时 · ${task.title}`,
      mode: 'work',
      permissionMode: task.permissionMode,
      defaultModel: settings.defaultModel,
      defaultPermission: settings.permissionMode
    })
  } catch (err) {
    runningTaskId = null
    const message = err instanceof Error ? err.message : '定时任务创建对话失败。'
    store.markFinished(task.id, 'error', { error: message, manual: scheduleManual })
    broadcast()
    throw err
  }
  runningTaskId = task.id
  const running = store.markRunning(task.id, session.id)
  broadcast()
  try {
    const result = await getAgentService(getSettingsStore(), sessionStore).send(
      {
        sessionId: session.id,
        text: scheduledPrompt(task),
        permissionMode: task.permissionMode,
        unattended: true
      },
      mainWindow()
    )
    void trackCompletion(task, session.id, result.runId, scheduleManual)
    return running
  } catch (err) {
    runningTaskId = null
    const message = err instanceof Error ? err.message : '定时任务启动失败。'
    store.markFinished(task.id, 'error', { error: message, manual: scheduleManual })
    broadcast()
    throw err
  }
}


async function trackCompletion(
  task: ScheduledTask,
  sessionId: string,
  runId: string,
  manual: boolean
): Promise<void> {
  const started = Date.now()
  let timedOut = false
  try {
    const agent = getAgentService(getSettingsStore(), getSessionStore())
    while (agent.isRunRunning(runId)) {
      if (Date.now() - started >= SCHEDULE_RUN_TIMEOUT_MS) {
        timedOut = true
        agent.cancel(runId)
        // 给取消留出收尾时间，避免把「运行中」误写成成功
        for (let i = 0; i < 20 && agent.isRunRunning(runId); i += 1) await sleep(250)
        break
      }
      await sleep(1000)
    }
    if (timedOut) {
      finish(task.id, 'stopped', '运行超过 30 分钟，已自动停止。', manual)
      return
    }
    const session = getSessionStore().get(sessionId)
    // core 可能重新分配 assistant 消息 id，按「最后一条 assistant」判断本次结果；
    // 定时任务每次都会新建会话，因此不会有历史回复干扰。
    const message = [...(session?.messages ?? [])].reverse().find((item) => item.role === 'assistant')
    if (!message) {
      finish(task.id, 'error', '没有生成回复，请打开对话检查模型连接。', manual)
      return
    }
    if (message.interrupted) {
      finish(task.id, 'stopped', '这次运行被停止了。', manual)
      return
    }
    const errorBlock = message.content.find((block) => block.type === 'error') as
      | { type: 'error'; message: string }
      | undefined
    if (errorBlock) {
      finish(task.id, 'error', errorBlock.message, manual)
      return
    }
    if (message.error) {
      finish(task.id, 'error', message.error.message, manual)
      return
    }
    finish(task.id, 'success', undefined, manual)
  } catch (err) {
    finish(task.id, 'error', err instanceof Error ? err.message : '运行结果读取失败。', manual)
  } finally {
    runningTaskId = null
    broadcast()
    setTimeout(() => {
      void tick()
    }, 500).unref?.()
  }
}


function finish(
  taskId: string,
  status: 'success' | 'error' | 'stopped',
  error: string | undefined,
  manual: boolean
): void {
  try {
    requireStore().markFinished(taskId, status, { error, manual })
    log.info('scheduled task finished', { id: taskId, status })
  } catch (err) {
    // 任务在运行期间被删除：保留会话结果，不阻塞队列
    log.warn('scheduled task result dropped', { id: taskId, error: String(err) })
  }
}


export function listSchedules(): ScheduleState {
  return scheduleState()
}


export interface ScheduleMutation extends ScheduleState {
  task: ScheduledTask
}


export function createSchedule(input: ScheduledTaskInput): ScheduleMutation {
  const task = requireStore().create(input)
  broadcast()
  return { ...scheduleState(), task }
}


export function updateSchedule(id: string, input: ScheduledTaskInput): ScheduleMutation {
  const task = requireStore().update(id, input)
  broadcast()
  return { ...scheduleState(), task }
}


export function removeSchedule(id: string): ScheduleState {
  requireStore().remove(id)
  broadcast()
  return scheduleState()
}


export function setScheduleEnabled(id: string, enabled: boolean): ScheduleMutation {
  const task = requireStore().setEnabled(id, enabled)
  broadcast()
  return { ...scheduleState(), task }
}


/** 清除全部对话后移除任务对已删除会话的引用，避免「查看上次结果」指向空会话。 */
export function clearScheduleSessionReferences(): void {
  if (!store) return
  const changed = store.clearSessionReferences()
  if (changed > 0) {
    log.info('schedule session references cleared', { tasks: changed })
    broadcast()
  }
}


export async function runScheduleNow(id: string): Promise<ScheduleState> {
  const task = requireStore().get(id)
  if (!task) throw new Error('找不到这个定时任务（可能已被删除）。')
  await launchTask(task, true)
  return scheduleState()
}
