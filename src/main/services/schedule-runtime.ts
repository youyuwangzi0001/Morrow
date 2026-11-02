/**
 * 定时任务运行时：真实调度 + 创建会话 + 交给 Agent 执行 + 结果回写。
 *
 * 约束（与 UI 文案一致，不偷偷扩大能力）：
 * - 只在 Morrow 进程运行时执行；应用没开就跳过（1 小时内会补跑一次）。
 * - 无人值守，不询问审批：任务只允许「只读」或「自动修改文件」两种权限。
 * - 单次运行 30 分钟上限，避免提问/挂起占住调度队列。
 * - 同一时间只跑一个定时任务，避免多任务同时抢文件。
 */
import { BrowserWindow } from 'electron'
import { realpathSync, statSync } from 'node:fs'
import {
  SCHEDULE_CATCHUP_MS,
  SCHEDULE_RUN_TIMEOUT_MS,
  type ScheduledTask,
  type ScheduledTaskInput
} from '../../shared/schedules'
import type { Session } from '../../shared/types'
import { dataPath } from './paths'
import { ScheduleStore } from './schedule-store'
import { getSettingsStore } from './settings-store'
import { getSessionStore } from './session-store'
import { getAgentService } from './agent-service'
import { getIslandWindow } from './island'
import { sendFeatureEvent } from '../feature-ipc'
import { log } from './logger'

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

/* ── 供功能面板调用 ───────────────────────────────────────────── */

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
