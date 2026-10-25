import { BrowserWindow, Notification } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AskUserAnswer,
  AskUserRequest,
  ChatMessage,
  Goal,
  ModelInfo,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  ProviderConfig,
  QueuedMessage,
  ResearchState,
  RuntimeEvent,
  SendMessageInput,
  SendMessageResult,
  Session,
  SessionMeta,
  SessionMode,
  SessionPlan,
  TodoItem,
  ToolUseBlock
} from '../../shared/types'
import { EVENT_CHANNEL, FOCUS_SESSION_CHANNEL } from '../../shared/ipc'
import { EVOLUTION_CHANGED_EVENT, EVOLUTION_SKIP_LABEL } from '../../shared/memory'
import { estimateUsageCost } from '../../shared/usage'
import { dataPath, resolveDataDir } from './paths'
import { log } from './logger'
import { SensitiveGuard } from './output-guard'
import {
  GoalProgressTracker,
  clampRounds,
  inferGoalBudgets,
  inferGoalRounds,
  mergeGoalUsage,
  GOAL_MAX_ROUNDS
} from './goal-budget'
import type { SessionStore } from './session-store'
import { deriveMeta } from './session-store'
import type { SettingsStore } from './settings-store'
import { getProjectPrompt } from './project-service'
import { getAgentRulesPrompt } from './agent-rules'
import { getPermissionRulesService } from './permission-rules'
import { buildUserMessage, collectAttachedFilePaths } from './attachments'
import { replaceUserMessageText, userMessageDisplayText } from '../../shared/message'
import { mergeSwarmTask, swarmTasksFromMeta } from '../../shared/swarm'
import { planStepsCompleted, todosFromPlan } from '../../shared/plan'
import { getCheckpointService } from './checkpoint-service'
import { runHooks, runPromptHooks } from './hooks'
import { loadAgentRoles } from './custom-agents'
import { getWebSearchService } from './web-search'
import { getTerminalManager } from './terminal-manager'
import { getMediaService } from './media-service'
import { getMediaCatalog } from './media-catalog'
import { isDemoWorkspace } from './workspace'
import { getArtifactVersionStore, getTokenActivityService, recordTokenUsage } from './runtime'
import { getEvolutionService } from './evolution-service'
import { MemoryService, getEpisodePrompt } from './memory-service'
import { EPISODE_CHANGED_EVENT, MEMORY_CHANGED_EVENT } from '../../shared/memory'
import { sendFeatureEvent } from '../feature-ipc'
import { createPdfOcrHandler } from './pdf-ocr'
import { ingestIslandRuntimeEvent } from './island'
import {
  RESEARCH_DEPTHS,
  buildResearchPlanPrompt,
  createResearchState,
  decideResearchNextStep,
  normalizeResearchDepth,
  type ResearchStartInput
} from '../../shared/research'
import {
  buildSystemPrompt,
  clearSessionPermissionGrants,
  compactSession,
  createProvider,
  estimateContextUsage,
  estimateMessageTokens,
  estimateMessagesTokens,
  runAgent,
  type RunAgentResult
} from '@core/index'

interface PendingPermission {
  resolve: (decision: PermissionDecision) => void
  sessionId: string
}

interface PendingQuestion {
  resolve: (answer: AskUserAnswer) => void
  sessionId: string
}

/** 目标模式的预算输入（UI/IPC 可只传轮次，其余走默认） */
export interface GoalBudgetsInput {
  maxToolCalls?: number
  maxActiveMs?: number
  maxNoProgressRounds?: number
}

const DEFAULT_GOAL_BUDGETS = {
  maxToolCalls: 200,
  /** 20 分钟有效运行时间 */
  maxActiveMs: 20 * 60_000,
  maxNoProgressRounds: 3
} as const

const GOAL_MIN_ROUNDS = 2
/** 用户主动「继续」时追加的一段轮次（把「一段预算」与「整个目标」分开） */
const GOAL_RESUME_SEGMENT = 5

/** 批准计划后自动发给模型的第一条执行指令（用户可见，但渲染为系统续跑行） */
function buildPlanExecutionPrompt(plan: SessionPlan, resume: boolean): string {
  const lines = [
    resume ? '【计划执行 · 继续】' : '【计划已获批准】',
    `计划：${plan.title}`,
    plan.summary,
    '',
    '执行步骤：',
    ...plan.steps.map((step, index) => `${index + 1}. ${step.text}`)
  ]
  if (plan.risks?.trim()) lines.push('', `风险与前提：${plan.risks.trim()}`)
  lines.push(
    '',
    resume
      ? '上一轮执行被中断/未完成。请先核对当前进度（用 todo_write 查看/更新计划面板），再从不完整的步骤继续，不要从头假装重做。'
      : '现在开始执行这个计划。开始前先用 todo_write 把计划步骤写入任务面板，执行中实时更新状态；完成后给出结果与产物路径。',
    '如果执行中发现计划不可行，先说明原因并用 ask_user 请用户决定，不要擅自扩大范围。'
  )
  return lines.join('\n')
}

/** 修改计划的提示：带旧计划与用户反馈，要求重新探索后 submit_plan */
function buildPlanRevisionPrompt(previous: SessionPlan | null | undefined, feedback: string): string {
  const lines = ['【修改计划】', `用户的修改意见：${feedback}`, '']
  if (previous) {
    lines.push(`当前计划：${previous.title}`, previous.summary, '步骤：')
    previous.steps.forEach((step, index) => lines.push(`${index + 1}. ${step.text}`))
    lines.push('')
  }
  lines.push('请按修改意见重新核对现状，并用 submit_plan 提交修订后的完整计划；不要直接执行。')
  return lines.join('\n')
}
function clampBudget(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.max(min, Math.min(max, number))
}

interface ActiveRun {
  runId: string
  sessionId: string
  controller: AbortController
  /** 本轮用户消息（任务经验/记忆使用） */
  userMessage: ChatMessage
  startedAt: number
  window: BrowserWindow | null
  demo: boolean
  /** 启动本轮时的目标轮次（用于识别暂停/结束后旧 run 的迟到回调） */
  goalRound?: number
  /** 启动本轮时的目标 id（防止清除/重建目标后旧 run 写错目标） */
  goalId?: string
  /** 本轮开始前的目标累计计数（用于增量落盘时计算实时预算用量） */
  goalToolCallsBase: number
  goalActiveMsBase: number
  /** 本轮的计数 */
  roundToolCalls: number
  roundProgressActions: number
  /** 本轮工作区与目标创建时间（R2-F/G 真实进展判定用） */
  workspace: string | null
  goalCreatedAt?: number
  /** 跨轮真实进展去重器（从 goal.progressKeys 恢复；非目标模式为 null） */
  progressTracker: GoalProgressTracker | null
  baselineArtifacts: number
  baselineCompletedTodos: number
  /** 运行中的消息快照：用于崩溃后仍能看到「已完成 / 未完成」 */
  liveMessages: Map<string, ChatMessage>
  /** 本轮检查点 id（文件变更登记、回退用） */
  checkpointId?: string
  /** 当前阶段检查点 id（todo 步骤完成后切换；阶段内的工具改动登记到这里） */
  stageCheckpointId?: string
  /** 本轮开始前已有的消息数（用于阶段消息下标） */
  messageCountBase: number
  /** 已处理过的完成 todo id（避免同一阶段重复创建检查点） */
  completedTodoIds: Set<string>
  /** 本轮待处理的审批请求（用于审批日志与「始终允许」持久化） */
  permissionRequests: Map<string, PermissionRequest>
  /** 本轮模型的参考价格（用于累计费用） */
  pricing?: ModelInfo['pricing']
  /** 最近一次 todo 快照：切换会话/崩溃恢复时计划不倒退回旧版本 */
  liveTodos: TodoItem[] | null
  /** 生成中的画布产物：长视频/短片运行中崩溃后仍能恢复成品卡片 */
  liveArtifacts?: import('../../shared/types').Artifact[]
  incrementalTimer: ReturnType<typeof setTimeout> | null
  lastIncrementalAt: number
  /** 研究模式自动续研的内部轮次：不重复发系统通知 */
  internal?: boolean
  /** 无人值守运行（定时任务）：审批自动拒绝、提问自动跳过，也不弹交互卡 */
  unattended?: boolean
  /** 深度研究计划阶段：不把计划正文作为聊天消息逐字推给界面，只在计划卡中呈现 */
  researchPlanning?: boolean
}

/**
 * 主进程侧的 Agent 运行管理：
 * - 解析 provider / Key、构造用户消息、启动 core.runAgent
 * - 把 core 的事件流原样转发给渲染层（seq/runId/sessionId 由 core 维护）
 * - 管理审批/提问的挂起与恢复
 * - 运行中增量落盘（崩溃/退出后仍能看到已完成与未完成）
 * - 目标模式：多轮自动续跑、预算累计、无进展停止、重启恢复
 */
export class AgentService {
  private runs = new Map<string, ActiveRun>()
  /** 会话级敏感值守卫（工具结果/用户输入里出现过的邮箱、token 等） */
  private sensitiveGuards = new Map<string, SensitiveGuard>()
  /** 目标模式循环中的会话（无活跃 run 的轮次间隙也算运行中，避免用户消息插入） */
  private goalLoops = new Set<string>()
  private permissions = new Map<string, PendingPermission>()
  private questions = new Map<string, PendingQuestion>()
  /** 正在做手动上下文压缩的会话：期间禁止发送/建目标/切模式，避免摘要覆盖新消息。 */
  private compactingSessions = new Set<string>()
  private evolutionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 已删除会话的墓碑：阻止运行收尾/目标续跑在删除后重新写盘。 */
  private deletedSessions = new Set<string>()
  /** 运行中排队的下一条消息（按会话隔离，内存态） */
  private queues = new Map<string, QueuedMessage[]>()
  /** 队列因压缩/其他目标占用而延后启动的重试定时器 */
  private queueRetryTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly sessionStore: SessionStore
  ) {}

  isSessionRunning(sessionId: string): boolean {
    if (this.goalLoops.has(sessionId)) return true
    for (const run of this.runs.values()) if (run.sessionId === sessionId) return true
    return false
  }

  /** 供灵动岛跟随主窗口会话时读取：当前会话是否有活动运行、开始时间与是否在等待确认。 */
  activeRunInfo(sessionId: string): { startedAt: number; status: 'running' | 'waiting' } | null {
    let result: { startedAt: number; status: 'running' | 'waiting' } | null = null
    for (const run of this.runs.values()) {
      if (run.sessionId !== sessionId) continue
      const waiting =
        [...this.permissions.values()].some((item) => item.sessionId === sessionId) ||
        [...this.questions.values()].some((item) => item.sessionId === sessionId)
      result = { startedAt: run.startedAt, status: waiting ? 'waiting' : 'running' }
      break
    }
    return result
  }

  /** 精确判断某个 run 是否仍在运行（定时任务跟踪用，避免把用户后续轮次算进本次时长） */
  isRunRunning(runId: string): boolean {
    return this.runs.has(runId)
  }

  /** 运行中或压缩中：回退/切换等会改变会话状态的操作必须先停下。 */
  isSessionBusy(sessionId: string): boolean {
    return this.isSessionRunning(sessionId) || this.compactingSessions.has(sessionId)
  }

  /* ── 运行中消息排队（P0-5） ─────────────────────────────── */

  private queueOf(sessionId: string): QueuedMessage[] {
    return this.queues.get(sessionId) ?? []
  }

  private emitQueue(sessionId: string, window: BrowserWindow | null): void {
    this.forward(
      {
        seq: 0,
        runId: 'queue',
        sessionId,
        at: Date.now(),
        type: 'queue_updated',
        queue: [...this.queueOf(sessionId)]
      },
      window
    )
  }

  listQueue(sessionId: string): QueuedMessage[] {
    return [...this.queueOf(sessionId)]
  }

  addToQueue(
    input: { sessionId: string; text: string; attachments?: QueuedMessage['attachments'] },
    window: BrowserWindow | null
  ): QueuedMessage[] {
    const session = this.sessionStore.get(input.sessionId)
    if (!session) throw new Error('会话不存在，请新建对话。')
    if (this.deletedSessions.has(input.sessionId)) throw new Error('这个对话已被删除。')
    const text = (input.text ?? '').trim()
    const attachments = input.attachments?.slice(0, 8)
    if (!text && !attachments?.length) throw new Error('排队消息不能为空。')
    if (text.length > 20_000) throw new Error('排队消息过长（上限 20000 字）。')
    const queue = [...this.queueOf(input.sessionId)]
    if (queue.length >= 20) throw new Error('排队消息最多 20 条，先发送或删除一些吧。')
    queue.push({
      id: `queue_${randomUUID().slice(0, 12)}`,
      sessionId: input.sessionId,
      text: text.slice(0, 20_000),
      ...(attachments?.length ? { attachments } : {}),
      createdAt: Date.now()
    })
    this.queues.set(input.sessionId, queue)
    this.emitQueue(input.sessionId, window)
    return [...queue]
  }

  updateQueueItem(
    input: { sessionId: string; queueId: string; text: string },
    window: BrowserWindow | null
  ): QueuedMessage[] {
    const text = (input.text ?? '').trim()
    if (!text) throw new Error('排队消息不能为空。')
    const queue = this.queueOf(input.sessionId)
    const index = queue.findIndex((item) => item.id === input.queueId)
    if (index < 0) throw new Error('这条排队消息已经不存在了。')
    const next = queue.slice()
    next[index] = { ...next[index], text: text.slice(0, 20_000) }
    this.queues.set(input.sessionId, next)
    this.emitQueue(input.sessionId, window)
    return [...next]
  }

  removeQueueItem(
    input: { sessionId: string; queueId: string },
    window: BrowserWindow | null
  ): QueuedMessage[] {
    const queue = this.queueOf(input.sessionId)
    const next = queue.filter((item) => item.id !== input.queueId)
    this.queues.set(input.sessionId, next)
    this.emitQueue(input.sessionId, window)
    return [...next]
  }

  /** 本轮正常完成后自动发送队首消息；用户停止/出错时保留队列，交给用户决定。 */
  private maybeStartQueued(active: ActiveRun, result: RunAgentResult, window: BrowserWindow | null): void {
    if (result.reason !== 'complete' && result.reason !== 'max-steps') return
    if (this.deletedSessions.has(active.sessionId)) return
    const queue = this.queueOf(active.sessionId)
    if (queue.length === 0) return
    const session = this.sessionStore.get(active.sessionId)
    if (!session) return
    if (session.goal?.status === 'active' || this.goalLoops.has(active.sessionId)) return
    const [next, ...rest] = queue
    this.queues.set(active.sessionId, rest)
    this.emitQueue(active.sessionId, window)
    // 给 run 收尾/UI 事件一个稳定间隔，避免同一 tick 内立刻开始下一轮
    setTimeout(() => {
      if (this.deletedSessions.has(active.sessionId)) return
      if (this.isSessionRunning(active.sessionId)) {
        // 用户在间隙里手动发了消息/启动了目标：把队首放回去，避免丢消息
        this.queues.set(active.sessionId, [next, ...this.queueOf(active.sessionId)])
        this.emitQueue(active.sessionId, window)
        return
      }
      if (this.compactingSessions.has(active.sessionId) || this.otherSessionBusy(active.sessionId)) {
        // 压缩或另一个目标循环占用时不能抢跑；保留队首并稍后重试
        this.queues.set(active.sessionId, [next, ...this.queueOf(active.sessionId)])
        this.emitQueue(active.sessionId, window)
        this.scheduleQueueRetry(active.sessionId, window)
        return
      }
      this.startQueuedMessage(active.sessionId, next, window)
    }, 180)
  }

  private startQueuedMessage(sessionId: string, next: QueuedMessage, window: BrowserWindow | null): void {
    if (this.deletedSessions.has(sessionId)) return
    if (this.isSessionRunning(sessionId)) {
      this.queues.set(sessionId, [next, ...this.queueOf(sessionId)])
      this.emitQueue(sessionId, window)
      return
    }
    const latest = this.sessionStore.get(sessionId)
    if (!latest) return
    try {
      this.startRun(latest, { sessionId, text: next.text, attachments: next.attachments }, window)
    } catch (err) {
      log.error('queued message failed to start', { sessionId, error: String(err) })
      this.queues.set(sessionId, [next, ...this.queueOf(sessionId)])
      this.emitQueue(sessionId, window)
      this.forward(
        {
          seq: 0,
          runId: '',
          sessionId,
          at: Date.now(),
          type: 'notice',
          level: 'warn',
          message: `排队消息发送失败：${err instanceof Error ? err.message : String(err)}。已保留在队列里。`
        },
        window
      )
    }
  }

  private scheduleQueueRetry(sessionId: string, window: BrowserWindow | null): void {
    if (this.queueRetryTimers.has(sessionId) || this.deletedSessions.has(sessionId)) return
    const timer = setTimeout(() => {
      this.queueRetryTimers.delete(sessionId)
      if (this.deletedSessions.has(sessionId) || this.isSessionRunning(sessionId)) return
      const session = this.sessionStore.get(sessionId)
      if (!session) return
      if (session.goal?.status === 'active' || this.goalLoops.has(sessionId)) {
        this.scheduleQueueRetry(sessionId, window)
        return
      }
      if (this.compactingSessions.has(sessionId) || this.otherSessionBusy(sessionId)) {
        this.scheduleQueueRetry(sessionId, window)
        return
      }
      const [next, ...rest] = this.queueOf(sessionId)
      if (!next) return
      this.queues.set(sessionId, rest)
      this.emitQueue(sessionId, window)
      this.startQueuedMessage(sessionId, next, window)
    }, 1500)
    timer.unref?.()
    this.queueRetryTimers.set(sessionId, timer)
  }

  /** 目标循环仍保持全局串行（避免多个目标互相抢预算）；普通运行允许多会话并行。 */
  private otherSessionBusy(sessionId: string): string | null {
    for (const id of this.goalLoops) {
      if (id !== sessionId) return '另一个对话的目标正在自动推进，先处理它或等它完成。'
    }
    return null
  }

  async send(input: SendMessageInput, window: BrowserWindow | null): Promise<SendMessageResult> {
    const session = this.sessionStore.get(input.sessionId)
    if (!session) throw new Error('会话不存在，请新建对话。')
    if (this.deletedSessions.has(session.id)) throw new Error('这个对话已被删除。')
    // 目标续跑轮之间有 350ms 调度间隔：不能让另一个会话在这段窗口插队启动第二个 run
    const otherBusy = this.otherSessionBusy(session.id)
    if (otherBusy) throw new Error(otherBusy)
    if (this.isSessionRunning(session.id)) throw new Error('这个对话正在运行，等它完成或先停止。')
    if (this.compactingSessions.has(session.id)) throw new Error('正在压缩上下文，完成后再发送。')
    if (session.mode === 'research' && session.research?.status === 'searching' && input.hidden !== true) {
      throw new Error('深度研究正在自动续查：等这一轮完成，或先停止当前运行。')
    }
    const hookVerdict = await runPromptHooks(
      {
        event: 'user_prompt_submit',
        sessionId: session.id,
        workspace: session.workspace,
        text: input.text.slice(0, 8000),
        attachmentCount: input.attachments?.length ?? 0
      },
      session.workspace
    )
    if (hookVerdict.blocked) {
      throw new Error(`自动动作阻止了这条消息：${hookVerdict.reason ?? '未提供原因'}`)
    }
    // 钩子最长可跑 75s：重新读取会话，避免用旧快照覆盖期间的改名/压缩/回退/模式切换
    const latest = this.sessionStore.get(session.id)
    if (!latest || this.deletedSessions.has(session.id)) throw new Error('这个对话已被删除。')
    if (this.isSessionRunning(latest.id)) throw new Error('这个对话正在运行，等它完成或先停止。')
    if (this.compactingSessions.has(latest.id)) throw new Error('正在压缩上下文，完成后再发送。')
    const otherBusyAfterHook = this.otherSessionBusy(latest.id)
    if (otherBusyAfterHook) throw new Error(otherBusyAfterHook)
    if (latest.goal?.status === 'active' || this.goalLoops.has(latest.id)) {
      throw new Error('当前对话的目标正在推进：先暂停或结束目标，再发送普通消息。')
    }
    return this.startRun(latest, input, window)
  }

  /**
   * 删除会话：先阻止新写入，再停止运行/挂起请求，最后删会话文件与撤销快照。
   * 运行中的工具可能正在写快照，因此最多等待 5 秒让运行收尾；墓碑保证收尾不会把会话写回来。
   */
  async removeSession(sessionId: string): Promise<void> {
    const session = this.sessionStore.get(sessionId)
    if (!session) return
    this.deletedSessions.add(sessionId)
    this.goalLoops.delete(sessionId)
    this.queues.delete(sessionId)
    const queueTimer = this.queueRetryTimers.get(sessionId)
    if (queueTimer) {
      clearTimeout(queueTimer)
      this.queueRetryTimers.delete(sessionId)
    }

    for (const [id, pending] of this.permissions) {
      if (pending.sessionId !== sessionId) continue
      this.permissions.delete(id)
      pending.resolve('deny')
    }
    for (const [id, pending] of this.questions) {
      if (pending.sessionId !== sessionId) continue
      this.questions.delete(id)
      pending.resolve({ value: 'cancelled', label: '已取消' })
    }
    this.abortSession(sessionId)
    const stopped = await this.waitForRunsToStop(sessionId)
    if (!stopped) log.warn('session deletion: runs still active after timeout', { sessionId })

    try {
      this.sessionStore.remove(sessionId)
    } catch (err) {
      this.deletedSessions.delete(sessionId)
      throw err
    }

    try {
      rmSync(dataPath('snapshots', sessionId), { recursive: true, force: true })
    } catch (err) {
      log.warn('session deletion: snapshot cleanup failed', { sessionId, error: String(err) })
    }
    try {
      getCheckpointService(this.sessionStore).removeSession(sessionId)
    } catch (err) {
      log.warn('session deletion: checkpoint cleanup failed', { sessionId, error: String(err) })
    }
    try {
      getArtifactVersionStore().removeSession(sessionId)
    } catch (err) {
      log.warn('session deletion: artifact version cleanup failed', { sessionId, error: String(err) })
    }
    this.sensitiveGuards.delete(sessionId)
    clearSessionPermissionGrants(sessionId)
    log.info('session removed', { sessionId, stopped })
  }

  /**
   * 清除全部对话与它们的派生物（撤销快照、检查点、成品版本、用量账本、审批日志）。
   * 工作区里的真实文件、设置、记忆、项目和密钥都不会被删除。
   */
  async clearAllSessions(): Promise<number> {
    const ids = new Set<string>()
    for (const meta of this.sessionStore.list()) ids.add(meta.id)
    for (const id of this.sessionStore.listTemporaryIds()) ids.add(id)
    for (const run of this.runs.values()) ids.add(run.sessionId)
    for (const id of this.compactingSessions) ids.add(id)
    for (const id of this.queueRetryTimers.keys()) ids.add(id)
    for (const id of this.queues.keys()) ids.add(id)
    for (const id of this.goalLoops) ids.add(id)

    // 先立墓碑再中止：运行收尾即使晚到，也不会把已清除的会话重新写回磁盘。
    for (const id of ids) {
      this.deletedSessions.add(id)
      this.goalLoops.delete(id)
      this.queues.delete(id)
      const timer = this.queueRetryTimers.get(id)
      if (timer) {
        clearTimeout(timer)
        this.queueRetryTimers.delete(id)
      }
      this.sensitiveGuards.delete(id)
      clearSessionPermissionGrants(id)
    }
    this.queues.clear()
    for (const [id, pending] of this.permissions) {
      this.permissions.delete(id)
      pending.resolve('deny')
    }
    for (const [id, pending] of this.questions) {
      this.questions.delete(id)
      pending.resolve({ value: 'cancelled', label: '已取消' })
    }
    for (const run of this.runs.values()) run.controller.abort()

    const deadline = Date.now() + 5000
    while (this.runs.size > 0 && Date.now() < deadline) {
      await new Promise<void>((resolveDone) => setTimeout(resolveDone, 50))
    }

    const removed = this.sessionStore.clearAll()
    for (const dir of ['snapshots', 'checkpoints', 'artifact-versions']) {
      try {
        rmSync(dataPath(dir), { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
      } catch (err) {
        log.warn('clear all: derived data cleanup failed', { dir, error: String(err) })
      }
    }
    this.compactingSessions.clear()
    try {
      getTokenActivityService().reset()
    } catch (err) {
      log.warn('clear all: token activity reset failed', { error: String(err) })
    }
    try {
      getPermissionRulesService().clearLog()
    } catch (err) {
      log.warn('clear all: approval log cleanup failed', { error: String(err) })
    }
    this.updateTaskbar()
    log.info('all sessions cleared', { removed, runsStillActive: this.runs.size })
    return removed
  }

  private hasActiveRun(sessionId: string): boolean {
    for (const run of this.runs.values()) {
      if (run.sessionId === sessionId) return true
    }
    return false
  }

  private async waitForRunsToStop(sessionId: string, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.hasActiveRun(sessionId)) {
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return true
  }

  /** 启动一轮 Agent 运行（普通消息与目标模式续跑共用；userMessage 复用用于重新生成/编辑重发）。 */
  private startRun(
    session: Session,
    input: SendMessageInput,
    window: BrowserWindow | null,
    options?: { userMessage?: ChatMessage }
  ): SendMessageResult {
    if (this.deletedSessions.has(session.id)) throw new Error('这个对话已被删除。')
    if (session.mode === 'research' && !getWebSearchService(this.settingsStore).isConfigured()) {
      throw new Error('深度研究需要先配置联网搜索。请到设置 → 联网搜索选择一个服务并保存后再试。')
    }
    const resolved = this.resolveProvider(session, input)
    const isDemo = resolved.config.kind === 'demo'
    // 演示剧本会真实执行工具并跳过审批：只允许在一次性演示工作区运行，绝不写进用户的真实文件夹
    if (isDemo && !isDemoWorkspace(session.workspace)) {
      throw new Error('演示模型只能在 Morrow 的演示工作区中使用。请先在设置 → 模型里连接真实模型，再开始任务。')
    }
    if (isDemo) session.demo = true
    else if (session.demo) delete session.demo
    const userMessage = options?.userMessage ?? buildUserMessage(input.text, input.attachments)
    if (input.hidden === true) userMessage.hidden = true
    if (session.mode === 'research') {
      if (input.hidden === true) {
        if (!session.research || session.research.status !== 'searching') {
          throw new Error('这项研究已经结束，不能继续自动续研。')
        }
      } else {
        const depth = normalizeResearchDepth(input.researchDepth ?? session.research?.depth)
        session.research = createResearchState(input.text, depth, Date.now(), { status: 'planning' })
      }
      // 研究模式不允许计划/目标；用户切回工作模式后再使用。
      session.planMode = false
    }
    if (!options?.userMessage) {
      session.messages.push(userMessage)
      // 只发附件不写字时，用第一个文件名兜底命名，避免会话一直叫「新对话」
      if (this.settingsStore.get().autoTitle) {
        const firstAttachment = input.attachments?.[0]?.name?.trim() ?? ''
        const attachmentSeed = firstAttachment.replace(/\.[^.]+$/, '').trim() || firstAttachment
        this.sessionStore.autoName(session, input.text.trim() || attachmentSeed)
      }
    } else if (input.hidden === true && !session.messages.some((message) => message.id === userMessage.id)) {
      // 研究自动续研：内部提示要进入历史，但不展示为可见气泡。
      session.messages.push(userMessage)
    }
    this.sessionStore.save(session)

    const runId = `run_${randomUUID().slice(0, 12)}`
    const assistantMessageId = `msg_${randomUUID().slice(0, 12)}`
    const controller = new AbortController()
    const goal = session.goal
    // 显式会话模式：缺省 = work（兼容旧会话文件）。聊天/研究有独立工具白名单与权限硬拦截。
    const sessionMode: SessionMode =
      session.mode === 'chat' ? 'chat' : session.mode === 'research' ? 'research' : 'work'
    const researchMode = sessionMode === 'research'
    const researchPlanning = researchMode && session.research?.status === 'planning'
    const planMode = sessionMode === 'work' && session.planMode === true
    const effectivePermission: PermissionMode = researchMode ? 'auto' : session.permissionMode
    const active: ActiveRun = {
      runId,
      sessionId: session.id,
      controller,
      userMessage,
      startedAt: Date.now(),
      window,
      demo: isDemo,
      internal: input.hidden === true,
      unattended: input.unattended === true,
      researchPlanning,
      ...(goal?.status === 'active' && sessionMode === 'work' ? { goalRound: goal.round, goalId: goal.id } : {}),
      goalToolCallsBase: goal?.toolCalls ?? 0,
      goalActiveMsBase: goal?.activeMs ?? 0,
      roundToolCalls: 0,
      roundProgressActions: 0,
      workspace: session.workspace,
      ...(goal?.status === 'active' && sessionMode === 'work' ? { goalCreatedAt: goal.createdAt } : {}),
      progressTracker:
        goal?.status === 'active' && sessionMode === 'work'
          ? new GoalProgressTracker({ existingKeys: goal.progressKeys })
          : null,
      baselineArtifacts: session.artifacts.length,
      baselineCompletedTodos: session.todos.filter((todo) => todo.status === 'completed').length,
      liveMessages: new Map(),
      messageCountBase: session.messages.length,
      completedTodoIds: new Set(session.todos.filter((todo) => todo.status === 'completed').map((todo) => todo.id)),
      permissionRequests: new Map(),
      pricing: resolved.modelInfo.pricing,
      liveTodos: null,
      incrementalTimer: null,
      lastIncrementalAt: 0
    }
    // 每轮检查点：演示与临时对话不进入回退列表（临时对话不在磁盘留下消息摘要）
    if (!isDemo && !session.temporary) {
      const checkpoint = getCheckpointService(this.sessionStore).create(
        session,
        userMessage,
        session.messages.length - 1
      )
      if (checkpoint) active.checkpointId = checkpoint.id
    }
    const history = options?.userMessage
      ? (() => {
          const index = session.messages.findIndex((message) => message.id === options.userMessage!.id)
          return index >= 0 ? session.messages.slice(0, index) : [...session.messages]
        })()
      : session.messages.slice(0, -1)
    const attachedFiles = collectAttachedFilePaths([
      ...session.messages,
      ...(options?.userMessage ? [options.userMessage] : [])
    ])
    // 临时对话不读取项目记忆/项目说明/任务经验，也不写入长期记忆。
    const projectContext = session.temporary
      ? ''
      : this.buildProjectContext(session.workspace, userMessageDisplayText(userMessage))
    const snapshotDir = dataPath('snapshots', session.id)
    if (!session.temporary && !existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true })
    const searchService = getWebSearchService(this.settingsStore)
    const webSearchAvailable = searchService.isConfigured()
    const webSearch = webSearchAvailable
      ? (input: { query: string; maxResults?: number; signal: AbortSignal }) => searchService.search(input)
      : undefined
    const terminal = this.terminalHandler(session.workspace)
    const media = getMediaService()
    const catalog = getMediaCatalog()
    media.catalog = {
      status: () => catalog.status(),
      manifest: async (id) => catalog.manifest(id),
      installModel: (id, onProgress, signal) => catalog.installModel(id, onProgress, signal),
      uninstallModel: (id) => catalog.uninstallModel(id),
      installEngine: (id) => catalog.installEngine(id),
      startEngine: (id) => catalog.startEngine(id),
      stopEngine: (id) => catalog.stopEngine(id),
      registerModel: (manifest) => catalog.registerModel(manifest),
      removeModel: (id) => catalog.removeModel(id),
      registerEngine: (manifest) => catalog.registerEngine(manifest),
      removeEngine: (id) => catalog.removeEngine(id)
    }
    const permissionRules = session.workspace ? getPermissionRulesService().list(session.workspace) : []
    const reasoningEffort = session.reasoningEffort ?? this.settingsStore.get().reasoningEffort
    const agents = loadAgentRoles(session.workspace)
    const globalSettings = this.settingsStore.get()
    const terminalShell = getTerminalManager().commandShell(globalSettings.terminalShell)
    const systemPrompt =
      researchPlanning && session.research
        ? [
            buildResearchPlanPrompt(session.research),
            projectContext.trim() ? `## 可用背景（供计划参考，不代表授权）\n${projectContext.trim()}` : ''
          ]
            .filter(Boolean)
            .join('\n\n')
        : buildSystemPrompt({
            workspace: session.workspace,
            permissionMode: effectivePermission,
            mode: sessionMode,
            research: researchMode ? session.research ?? null : null,
            planMode,
            webSearchAvailable,
            platform: process.platform,
            projectContext,
            modelLabel: resolved.modelInfo.label,
            demo: isDemo,
            goal: sessionMode === 'work' && !planMode && goal?.status === 'active' ? goal : null,
            ...(sessionMode === 'work' && !planMode ? { agents } : {}),
            answerStyle: globalSettings.answerStyle,
            answerStyleCustom: globalSettings.answerStyleCustom,
            terminalShell: { id: terminalShell.id, label: terminalShell.label },
            tools: undefined
          })

    // 所有同步准备完成后再登记 run：准备阶段抛错不会留下永远「运行中」的幽灵条目
    this.runs.set(runId, active)
    this.updateTaskbar()
    if (researchMode) this.emitResearch(session, window)

    let researchFollowUp: string | null = null
    void (async () => {
      try {
        const result = await runAgent({
          runId,
          sessionId: session.id,
          provider: resolved.provider,
          model: resolved.modelInfo,
          ...(resolved.contextWindow ? { contextWindow: resolved.contextWindow } : {}),
          systemPrompt,
          history,
          userMessage,
          workspace: session.workspace,
          attachedFiles,
          permissionMode: effectivePermission,
          mode: sessionMode,
          research: researchMode ? session.research ?? null : null,
          researchPlanning,
          planMode,
          projectContext,
          temporary: session.temporary === true,
          answerStyle: globalSettings.answerStyle,
          answerStyleCustom: globalSettings.answerStyleCustom,
          ocrPdf: createPdfOcrHandler(),
          commandShell: terminalShell,
          snapshotDir,
          ...(webSearch ? { webSearch } : {}),
          remember: async ({ text, scope, tags }) => {
            if (session.temporary) throw new Error('临时对话不写入长期记忆。')
            if (scope === 'project' && !session.workspace) throw new Error('当前对话没有文件夹，只能写入全局记忆。')
            const memory = new MemoryService({ dataDir: resolveDataDir() })
            const entry = memory.add({
              scope,
              workspace: scope === 'project' ? session.workspace : null,
              text,
              tags,
              source: 'agent'
            })
            sendFeatureEvent(MEMORY_CHANGED_EVENT, {
              scope,
              workspace: entry.workspace
            })
            return { scope, text: entry.text }
          },
          terminal,
          media,
          vision: { provider: resolved.provider, model: resolved.modelInfo },
          permissionRules,
          reasoningEffort,
          agents: researchMode ? [] : agents,
          signal: controller.signal,
          // 正常任务不再限制单轮步数；只有研究计划阶段保留 2 步的轻量探索。
          ...(researchPlanning ? { maxSteps: 2 } : {}),
          autoCompact: this.settingsStore.get().autoCompact,
          compactThreshold: this.settingsStore.get().compactThreshold,
          goal: sessionMode === 'work' && !planMode && goal?.status === 'active' ? goal : null,
          demo: isDemo,
          initialTodos: session.todos,
          initialArtifacts: session.artifacts,
          emit: (event: RuntimeEvent) => this.handleRuntimeEvent(active, event, window),
          onPermission: (request) =>
            active.unattended ? Promise.resolve('deny') : this.awaitPermission(active, request),
          onAskUser: (request) =>
            active.unattended
              ? Promise.resolve({ value: 'cancelled', label: '无人值守：已跳过提问' })
              : this.awaitQuestion(active, request),
          unattended: active.unattended === true
        })
        this.persistResult(active, result)
        await this.afterRun(active, result, window)
        const latest = this.sessionStore.get(active.sessionId)
        researchFollowUp = this.finishResearchRound(active, result, window)
        const goalContinues = latest?.goal?.status === 'active' && this.goalLoops.has(active.sessionId)
        if (!goalContinues && !active.internal && sessionMode !== 'research' && !session.temporary) {
          this.notifyRunFinished(active, result, latest)
        }
        this.runFinishHooks(active, result)
        this.maybeStartQueued(active, result, window)
        if (result.reason === 'complete') this.scheduleEvolutionReview(active, resolved.config.kind)
      } catch (err) {
        log.error('agent run crashed', { runId, error: err instanceof Error ? err.message : String(err) })
        const message = err instanceof Error ? err.message : '执行出错'
        this.onRunFailure(active)
        this.failResearchRound(session.id, message, window)
        this.forward(
          {
            seq: 0,
            runId,
            sessionId: session.id,
            at: Date.now(),
            type: 'error',
            error: { code: 'AGENT_CRASHED', message, hint: '可以重试，或检查模型连接是否正常。' }
          },
          window
        )
        this.forward(
          {
            seq: 0,
            runId,
            sessionId: session.id,
            at: Date.now(),
            type: 'run_finished',
            reason: 'error',
            usage: session.usage
          },
          window
        )
      } finally {
        this.flushIncremental(active)
        this.cleanupRun(active)
        if (researchFollowUp) {
          const prompt = researchFollowUp
          setTimeout(() => {
            this.continueResearch(session.id, prompt, window)
          }, 350).unref?.()
        }
      }
    })()

    return { runId, userMessage, assistantMessageId }
  }

  /* ── 深度研究：轮次评估与自动续研 ─────────────────────────── */

  private emitResearch(session: Session, window: BrowserWindow | null): void {
    this.forward(
      {
        seq: 0,
        runId: 'research',
        sessionId: session.id,
        at: Date.now(),
        type: 'research_updated',
        research: session.research ?? null
      },
      window
    )
    this.forward(
      { seq: 0, runId: 'research', sessionId: session.id, at: Date.now(), type: 'session_updated', meta: deriveMeta(session) },
      window
    )
  }

  /** 计划阶段结束：取本轮（从计划开始时间起）最后一条助手文本作为计划。 */
  private latestAssistantText(session: Session, since: number): string {
    const chunks: string[] = []
    for (const message of session.messages) {
      if (message.role !== 'assistant' || message.createdAt < since) continue
      for (const block of message.content) {
        if (block.type === 'text') chunks.push(block.text)
      }
    }
    return chunks.join('\n').trim()
  }

  /** 用户确认研究计划后，真正开始多轮检索。 */
  startResearch(sessionId: string, input: ResearchStartInput, window: BrowserWindow | null): SendMessageResult {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error('会话不存在，请新建对话。')
    if (this.deletedSessions.has(sessionId)) throw new Error('这个对话已被删除。')
    if (session.mode !== 'research') throw new Error('当前对话不在深度研究模式。')
    const state = session.research
    if (!state || state.status !== 'ready') throw new Error('研究计划还没有准备好，请先生成计划。')
    if (this.isSessionRunning(sessionId)) throw new Error('这个对话正在运行，先停止再开始研究。')
    if (this.compactingSessions.has(sessionId)) throw new Error('正在压缩上下文，完成后再开始研究。')
    const plan = typeof input.plan === 'string' ? input.plan.trim() : (state.plan ?? '').trim()
    if (!plan) throw new Error('研究计划不能为空。')
    if (plan.length > 20_000) throw new Error('研究计划过长（最多 20000 字）。')
    const depth = normalizeResearchDepth(input.depth ?? state.depth)
    const config = RESEARCH_DEPTHS[depth]
    const now = Date.now()
    const previous = state
    session.research = {
      ...state,
      depth,
      status: 'searching',
      round: 1,
      maxRounds: config.maxRounds,
      minSources: config.minSources,
      sourceCount: 0,
      plan: plan.slice(0, 20_000),
      startedAt: now,
      updatedAt: now
    }
    delete session.research.gap
    delete session.research.artifactId
    delete session.research.steer
    this.sessionStore.save(session)
    this.emitResearch(session, window)
    try {
      const prompt = '开始执行已经确认的研究计划。先按计划拆分子问题并记录 todo，然后开始检索；不要再次询问用户。'
      const hiddenMessage = buildUserMessage(prompt)
      hiddenMessage.hidden = true
      return this.startRun(
        session,
        {
          sessionId,
          text: prompt,
          hidden: true
        },
        window,
        { userMessage: hiddenMessage }
      )
    } catch (err) {
      const latest = this.sessionStore.get(sessionId)
      if (latest?.research) {
        latest.research = {
          ...previous,
          status: 'ready',
          plan,
          gap: err instanceof Error ? err.message : '研究启动失败，请重试。',
          updatedAt: Date.now()
        }
        this.sessionStore.save(latest)
        this.emitResearch(latest, window)
      }
      throw err
    }
  }

  /** 检索中追加研究要求；写入状态后会在下一轮补查时优先纳入。 */
  steerResearch(sessionId: string, text: string, window: BrowserWindow | null): ResearchState {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error('会话不存在，请新建对话。')
    if (this.deletedSessions.has(sessionId)) throw new Error('这个对话已被删除。')
    if (session.mode !== 'research') throw new Error('当前对话不在深度研究模式。')
    if (!session.research || session.research.status !== 'searching') {
      throw new Error('研究还没有开始或已经结束，暂时不能追加要求。')
    }
    const cleaned = typeof text === 'string' ? text.trim() : ''
    if (!cleaned) throw new Error('补充要求不能为空。')
    if (cleaned.length > 2_000) throw new Error('补充要求过长（最多 2000 字）。')
    session.research = {
      ...session.research,
      steer: cleaned,
      updatedAt: Date.now()
    }
    this.sessionStore.save(session)
    this.emitResearch(session, window)
    return session.research
  }

  /** 研究子流程结束或失败后回到普通工作；研究状态和报告保留在会话里。 */
  private returnResearchToWork(session: Session, window: BrowserWindow | null): void {
    if (session.mode !== 'research') return
    if (!session.research || !['completed', 'stopped', 'error'].includes(session.research.status)) return
    session.mode = 'work'
    session.planMode = false
    this.sessionStore.save(session)
    this.forward(
      { seq: 0, runId: 'research', sessionId: session.id, at: Date.now(), type: 'session_updated', meta: deriveMeta(session) },
      window
    )
  }

  /** 一轮结束：计划阶段生成可审阅计划；检索阶段达到来源/报告目标就完成，否则继续补查。 */
  private finishResearchRound(active: ActiveRun, result: RunAgentResult, window: BrowserWindow | null): string | null {
    const session = this.sessionStore.get(active.sessionId)
    if (
      !session ||
      session.mode !== 'research' ||
      !session.research ||
      (session.research.status !== 'searching' && session.research.status !== 'planning')
    ) {
      return null
    }
    const now = Date.now()
    if (session.research.status === 'planning') {
      if (result.reason === 'cancelled') {
        session.research = {
          ...session.research,
          status: 'stopped',
          gap: '研究计划制定已停止；可以重新发送研究问题。',
          updatedAt: now
        }
        this.sessionStore.save(session)
        this.emitResearch(session, window)
        this.returnResearchToWork(session, window)
        return null
      }
      if (result.reason === 'error') {
        session.research = {
          ...session.research,
          status: 'error',
          gap: result.error?.message ?? '研究计划生成失败，可以重试。',
          updatedAt: now
        }
        this.sessionStore.save(session)
        this.emitResearch(session, window)
        this.returnResearchToWork(session, window)
        return null
      }
      const plan = this.latestAssistantText(session, session.research.startedAt)
      if (plan.length < 20) {
        session.research = {
          ...session.research,
          status: 'error',
          gap: '没有生成有效的研究计划，可以重新发送研究问题再试。',
          updatedAt: now
        }
        this.sessionStore.save(session)
        this.emitResearch(session, window)
        this.returnResearchToWork(session, window)
        return null
      }
      // 计划在进度卡里以可编辑形式呈现；把它从对话正文隐藏，避免同一份计划出现两次。
      for (let index = session.messages.length - 1; index >= 0; index -= 1) {
        const message = session.messages[index]
        if (message.role === 'assistant' && message.createdAt >= session.research.startedAt) {
          message.hidden = true
          break
        }
      }
      session.research = {
        ...session.research,
        status: 'ready',
        plan: plan.slice(0, 20_000),
        round: 1,
        sourceCount: 0,
        updatedAt: now
      }
      delete session.research.gap
      delete session.research.artifactId
      this.sessionStore.save(session)
      this.emitResearch(session, window)
        this.returnResearchToWork(session, window)
      this.notifyUser(active, '研究计划已生成', `《${session.title}》的研究计划已生成，确认后开始检索。`)
      return null
    }
    if (result.reason === 'cancelled') {
      session.research = {
        ...session.research,
        status: 'stopped',
        gap: '本轮研究已停止；可以继续发送消息接着研究。',
        updatedAt: now
      }
      this.sessionStore.save(session)
      this.emitResearch(session, window)
        this.returnResearchToWork(session, window)
      return null
    }
    if (result.reason === 'error') {
      session.research = {
        ...session.research,
        status: 'error',
        gap: result.error?.message ?? '研究运行出错，可以重试。',
        updatedAt: now
      }
      this.sessionStore.save(session)
      this.emitResearch(session, window)
        this.returnResearchToWork(session, window)
      return null
    }
    const decision = decideResearchNextStep(session.research, session.messages, session.artifacts)
    if (decision.status === 'searching' && decision.followUpPrompt) {
      session.research = {
        ...session.research,
        round: session.research.round + 1,
        sourceCount: decision.sourceCount,
        gap: decision.gap,
        updatedAt: now
      }
      // 补充要求已经写入下一轮 hidden prompt，避免之后每轮重复注入。
      if (session.research.steer) delete session.research.steer
      this.sessionStore.save(session)
      this.emitResearch(session, window)
        this.returnResearchToWork(session, window)
      return decision.followUpPrompt
    }
    const completed: ResearchState = {
      ...session.research,
      status: decision.status,
      sourceCount: decision.sourceCount,
      ...(decision.gap ? { gap: decision.gap } : {}),
      ...(decision.artifactId ? { artifactId: decision.artifactId } : {}),
      updatedAt: now
    }
    if (!decision.gap) delete completed.gap
    if (!decision.artifactId) delete completed.artifactId
    delete completed.steer
    session.research = completed
    this.sessionStore.save(session)
    this.emitResearch(session, window)
        this.returnResearchToWork(session, window)
    if (decision.status === 'completed') {
      this.notifyUser(active, '研究报告已生成', `《${session.title}》的深度研究已完成，可以在画布查看报告。`)
    }
    return null
  }

  private failResearchRound(sessionId: string, message: string, window: BrowserWindow | null): void {
    const session = this.sessionStore.get(sessionId)
    if (
      !session ||
      session.mode !== 'research' ||
      !session.research ||
      (session.research.status !== 'searching' && session.research.status !== 'planning')
    ) {
      return
    }
    const wasPlanning = session.research.status === 'planning'
    session.research = {
      ...session.research,
      status: 'error',
      gap: `${wasPlanning ? '研究计划生成失败：' : ''}${message}`.slice(0, 500),
      updatedAt: Date.now()
    }
    this.sessionStore.save(session)
    this.emitResearch(session, window)
        this.returnResearchToWork(session, window)
  }

  /** 自动续研：用隐藏的用户消息启动下一轮，不污染可见对话。 */
  private continueResearch(sessionId: string, prompt: string, window: BrowserWindow | null): void {
    const session = this.sessionStore.get(sessionId)
    if (!session || session.mode !== 'research' || session.research?.status !== 'searching') return
    if (this.isSessionRunning(sessionId) || this.compactingSessions.has(sessionId)) return
    const userMessage = buildUserMessage(prompt)
    userMessage.hidden = true
    try {
      this.startRun(session, { sessionId, text: prompt, hidden: true }, window, { userMessage })
      log.info('research follow-up started', { sessionId, round: session.research.round })
    } catch (err) {
      this.failResearchRound(sessionId, err instanceof Error ? err.message : '续研启动失败', window)
    }
  }

  /* ── 消息操作：重新生成 / 编辑重发 / 删除后续 / 分支 ─────────── */

  regenerate(sessionId: string, window: BrowserWindow | null): SendMessageResult {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error('会话不存在，请新建对话。')
    if (this.deletedSessions.has(sessionId)) throw new Error('这个对话已被删除。')
    const otherBusy = this.otherSessionBusy(sessionId)
    if (otherBusy) throw new Error(otherBusy)
    if (this.isSessionRunning(sessionId)) throw new Error('这个对话正在运行，先停止再试。')
    if (this.compactingSessions.has(sessionId)) throw new Error('正在压缩上下文，完成后再试。')
    const index = [...session.messages].map((message) => message.role).lastIndexOf('user')
    if (index < 0) throw new Error('没有可重新生成的用户消息。')
    const userMessage = session.messages[index]
    session.messages = session.messages.slice(0, index + 1).map((message, i) =>
      i === index ? { ...message, interrupted: false, error: undefined } : message
    )
    this.sessionStore.save(session)
    this.forward(
      { seq: 0, runId: 'messages', sessionId, at: Date.now(), type: 'messages_replaced', messages: session.messages },
      window
    )
    return this.startRun(session, { sessionId, text: '' }, window, { userMessage: session.messages[index] })
  }

  editResend(sessionId: string, messageId: string, text: string, window: BrowserWindow | null): SendMessageResult {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error('会话不存在，请新建对话。')
    if (this.deletedSessions.has(sessionId)) throw new Error('这个对话已被删除。')
    const otherBusy = this.otherSessionBusy(sessionId)
    if (otherBusy) throw new Error(otherBusy)
    if (this.isSessionRunning(sessionId)) throw new Error('这个对话正在运行，先停止再试。')
    if (this.compactingSessions.has(sessionId)) throw new Error('正在压缩上下文，完成后再试。')
    const index = session.messages.findIndex((message) => message.id === messageId && message.role === 'user')
    if (index < 0) throw new Error('这条用户消息不存在或已被压缩。')
    const value = text.trim()
    if (!value) throw new Error('消息内容不能为空。')
    const original = session.messages[index]
    const next: ChatMessage = {
      ...replaceUserMessageText(original, value),
      createdAt: Date.now(),
      interrupted: false,
      error: undefined
    }
    session.messages = [...session.messages.slice(0, index), next]
    this.sessionStore.save(session)
    this.forward(
      { seq: 0, runId: 'messages', sessionId, at: Date.now(), type: 'messages_replaced', messages: session.messages },
      window
    )
    return this.startRun(session, { sessionId, text: value }, window, { userMessage: next })
  }

  deleteAfter(sessionId: string, messageId: string): Session {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error('会话不存在，请新建对话。')
    if (this.deletedSessions.has(sessionId)) throw new Error('这个对话已被删除。')
    if (this.isSessionRunning(sessionId)) throw new Error('这个对话正在运行，先停止再试。')
    if (this.compactingSessions.has(sessionId)) throw new Error('正在压缩上下文，完成后再试。')
    const next = this.sessionStore.truncate(sessionId, messageId, true)
    if (!next) throw new Error('这条消息不存在或已被压缩。')
    return next
  }

  branch(sessionId: string, messageId: string, title?: string): Session {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error('会话不存在，请新建对话。')
    if (this.deletedSessions.has(sessionId)) throw new Error('这个对话已被删除。')
    if (this.isSessionRunning(sessionId)) throw new Error('这个对话正在运行，先停止再分支。')
    if (this.compactingSessions.has(sessionId)) throw new Error('正在压缩上下文，完成后再分支。')
    const branch = this.sessionStore.branch(sessionId, messageId, title)
    if (!branch) throw new Error('这条消息不存在或已被压缩，无法分叉。')
    return branch
  }

  async compact(sessionId: string, window: BrowserWindow | null): Promise<{ compacted: boolean; savedTokens: number; messageCount: number; reason?: string }> {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error('会话不存在，请新建对话。')
    if (this.deletedSessions.has(sessionId)) throw new Error('这个对话已被删除。')
    if (this.isSessionRunning(sessionId)) throw new Error('这个对话正在运行，先停止或等它完成。')
    if (this.compactingSessions.has(sessionId)) throw new Error('正在压缩上下文，请稍候。')
    if (session.messages.length < 4) throw new Error('对话还很短，暂时不需要压缩。')
    const resolved = this.resolveModel(session.model)
    if (resolved.config.kind === 'demo') throw new Error('演示会话不支持压缩上下文。')
    const projectContext = session.temporary ? '' : this.buildProjectContext(session.workspace)
    const systemPrompt = buildSystemPrompt({
      workspace: session.workspace,
      permissionMode: session.permissionMode,
      mode: session.mode === 'chat' ? 'chat' : session.mode === 'research' ? 'research' : 'work',
      platform: process.platform,
      projectContext,
      modelLabel: resolved.modelInfo.label,
      tools: undefined
    })
    const signature = session.messages.map((message) => message.id).join('|')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 90_000)
    this.compactingSessions.add(sessionId)
    this.forward({ seq: 0, runId: 'compact', sessionId, at: Date.now(), type: 'compaction', phase: 'started' }, window)
    try {
      const result = await compactSession({
        provider: resolved.provider,
        model: resolved.modelInfo,
        systemPrompt,
        messages: session.messages,
        signal: controller.signal,
        force: true
      })
      if (result.error) {
        throw new Error(controller.signal.aborted ? '压缩超时，已取消；对话内容未改变。' : result.error.message)
      }
      const latest = this.sessionStore.get(sessionId)
      if (!latest || this.deletedSessions.has(sessionId) || latest.messages.map((message) => message.id).join('|') !== signature) {
        // 压缩期间会话被删除或消息发生变化：丢弃摘要，绝不覆盖新内容
        throw new Error('对话在压缩期间发生了变化，请重试。')
      }
      if (result.compacted) {
        // 摘要可能复述历史里的密钥/邮箱：先登记历史值，再对持久化消息统一脱敏
        const guard = this.guardFor(sessionId)
        for (const message of latest.messages) guard.observe(JSON.stringify(message))
        latest.messages = result.messages.map((message) => guard.redactMessage(message))
        const context = estimateContextUsage(latest.messages, systemPrompt, resolved.modelInfo.contextWindow)
        const summaryUsage = result.summaryUsage
        const summaryCost = summaryUsage
          ? estimateUsageCost(summaryUsage, resolved.modelInfo.pricing)
          : undefined
        latest.usage = {
          ...latest.usage,
          inputTokens: latest.usage.inputTokens + (summaryUsage?.inputTokens ?? 0),
          outputTokens: latest.usage.outputTokens + (summaryUsage?.outputTokens ?? 0),
          ...(typeof summaryUsage?.cacheReadTokens === 'number'
            ? { cacheReadTokens: (latest.usage.cacheReadTokens ?? 0) + summaryUsage.cacheReadTokens }
            : {}),
          contextUsed: context.used,
          contextLimit: context.limit,
          ...(summaryCost !== undefined
            ? { costUsd: Math.round(((latest.usage.costUsd ?? 0) + summaryCost) * 1_000_000) / 1_000_000 }
            : {})
        }
        this.sessionStore.save(latest)
        if (summaryUsage && !latest.temporary) {
          recordTokenUsage({
            sessionId,
            inputTokens: summaryUsage.inputTokens,
            outputTokens: summaryUsage.outputTokens,
            cacheReadTokens: summaryUsage.cacheReadTokens ?? 0
          })
        }
        this.forward({ seq: 0, runId: 'compact', sessionId, at: Date.now(), type: 'compaction', phase: 'finished', savedTokens: result.savedTokens }, window)
        this.forward({ seq: 0, runId: 'compact', sessionId, at: Date.now(), type: 'usage_updated', usage: latest.usage }, window)
        this.forward({ seq: 0, runId: 'compact', sessionId, at: Date.now(), type: 'session_updated', meta: deriveMeta(latest) }, window)
      } else {
        this.forward({ seq: 0, runId: 'compact', sessionId, at: Date.now(), type: 'compaction', phase: 'finished', savedTokens: 0 }, window)
      }
      return {
        compacted: result.compacted,
        savedTokens: result.savedTokens,
        messageCount: latest.messages.length,
        ...(result.reason ? { reason: result.reason } : {})
      }
    } catch (err) {
      this.forward({ seq: 0, runId: 'compact', sessionId, at: Date.now(), type: 'compaction', phase: 'finished', savedTokens: 0 }, window)
      throw err
    } finally {
      clearTimeout(timeout)
      this.compactingSessions.delete(sessionId)
    }
  }

  /* ── 显式会话模式（聊天 / 工作） ─────────────────────────── */

  /**
   * 切换显式「聊天 / 工作」模式：
   * - 运行中拒绝切换（运行中的任务不能跨模式继续，先停下再切）；
   * - 持久化到会话文件（重启后保持）；
   * - 切到聊天模式时，正在推进的 Goal 自动暂停（Goal 只在工作模式可用）。
   */
  setSessionMode(sessionId: string, mode: SessionMode, window: BrowserWindow | null): SessionMeta {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error('会话不存在，请新建对话。')
    const next: SessionMode = mode === 'chat' ? 'chat' : mode === 'research' ? 'research' : 'work'
    if (this.deletedSessions.has(sessionId)) throw new Error('这个对话已被删除。')
    if ((session.mode ?? 'work') === next) return deriveMeta(session)
    if (this.isSessionRunning(sessionId)) throw new Error('这个对话正在运行：先停止本次运行，再切换模式。')
    if (this.compactingSessions.has(sessionId)) throw new Error('正在压缩上下文：完成后再切换模式。')
    if (
      (session.research?.status === 'searching' || session.research?.status === 'planning' || session.research?.status === 'ready') &&
      next !== 'research'
    ) {
      session.research = {
        ...session.research,
        status: 'stopped',
        gap: session.research.status === 'planning'
          ? '已退出研究；计划制定已停止。'
          : session.research.status === 'ready'
            ? '已退出研究；计划尚未开始。'
            : '已退出研究；可以继续普通工作。',
        updatedAt: Date.now()
      }
    }
    session.mode = next
    if (next === 'chat' || next === 'research') session.planMode = false
    this.sessionStore.save(session)
    if (next === 'chat' || next === 'research') this.emitPlan(session, window)
    if (next === 'research') {
      this.emitResearch(session, window)
      if (session.goal?.status === 'active') {
        this.pauseGoalInternal(
          session,
          window,
          'user_paused',
          '已切换到深度研究模式，目标自动暂停；切回工作模式后可手动继续。'
        )
      }
    }
    log.info('session mode changed', { sessionId, mode: next })
    return deriveMeta(session)
  }

  /* ── 计划模式 ─────────────────────────────────────────────── */

  private assertPlanIdle(sessionId: string): void {
    if (this.isSessionRunning(sessionId)) throw new Error('这个对话正在运行：先停止本次运行，再操作计划。')
    if (this.compactingSessions.has(sessionId)) throw new Error('正在压缩上下文：完成后再操作计划。')
    const otherBusy = this.otherSessionBusy(sessionId)
    if (otherBusy) throw new Error(otherBusy)
  }

  /**
   * 开启/关闭计划模式：
   * - 仅工作模式可用（聊天模式固定只读，不产生执行计划）；
   * - 开启时暂停正在推进的 Goal（计划批准前不自动续跑目标）；
   * - 运行/压缩期间拒绝切换，避免能力集在中途变化。
   */
  setPlanMode(sessionId: string, enabled: boolean, window: BrowserWindow | null): SessionMeta {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error('会话不存在，请新建对话。')
    if (this.deletedSessions.has(sessionId)) throw new Error('这个对话已被删除。')
    const next = enabled === true
    if (next && (session.mode ?? 'work') === 'chat') {
      throw new Error('聊天模式不能进入计划模式：请先切换到工作模式。')
    }
    if (next && session.mode === 'research') {
      throw new Error('深度研究模式不能进入计划模式：研究轮次由系统自动推进。')
    }
    if ((session.planMode === true) === next) return deriveMeta(session)
    this.assertPlanIdle(sessionId)
    session.planMode = next
    this.sessionStore.save(session)
    if (next && session.goal?.status === 'active') {
      this.pauseGoalInternal(
        session,
        window,
        'user_paused',
        '已进入计划模式，目标自动暂停；批准计划后会切回执行模式，可在目标条手动继续。'
      )
    }
    log.info('plan mode changed', { sessionId, planMode: next })
    this.emitPlan(session, window)
    return deriveMeta(session)
  }

  /**
   * 批准计划：pending 计划切到 executing，自动进入工作模式，
   * 用计划步骤建立 todo 列表，并立即启动一轮执行运行。
   */
  approvePlan(sessionId: string, window: BrowserWindow | null): { plan: SessionPlan; runId: string } {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error('会话不存在，请新建对话。')
    if (this.deletedSessions.has(sessionId)) throw new Error('这个对话已被删除。')
    const plan = session.plan
    if (!plan) throw new Error('当前对话还没有可批准的计划。')
    if (plan.status === 'completed') throw new Error('这个计划已经执行完成。')
    if ((session.mode ?? 'work') === 'chat') throw new Error('聊天模式不能执行计划：请先切换到工作模式。')
    if (session.permissionMode === 'read-only' && session.model.providerId !== 'demo') {
      throw new Error('当前权限是「只读」，批准后无法写文件或运行命令。请先把权限切到「询问」或「自动」，再执行计划。')
    }
    this.assertPlanIdle(sessionId)

    const firstApproval = plan.status === 'pending' || plan.status === 'rejected'
    const previousTodos = session.todos.map((todo) => ({ ...todo }))
    const now = Date.now()
    plan.status = 'executing'
    plan.updatedAt = now
    if (!plan.approvedAt) plan.approvedAt = now
    delete plan.feedback
    session.planMode = false
    if (firstApproval) {
      // 批准时重置为全新的待办：计划阶段写入的“已完成”不能当作执行进度
      session.todos = todosFromPlan(plan)
    }
    this.sessionStore.save(session)
    this.emitPlan(session, window)
    this.emitTodos(session, window)

    try {
      const result = this.startRun(session, { sessionId, text: buildPlanExecutionPrompt(plan, !firstApproval) }, window)
      log.info('plan approved', { sessionId, planId: plan.id, resumed: !firstApproval })
      return { plan, runId: result.runId }
    } catch (err) {
      // 启动失败（模型/密钥不可用）：回到待审状态，修好后可再次批准
      if (firstApproval) {
        plan.status = 'pending'
        plan.updatedAt = Date.now()
        session.planMode = true
        session.todos = previousTodos
        this.sessionStore.save(session)
        this.emitPlan(session, window)
        this.emitTodos(session, window)
      }
      throw err
    }
  }

  /** 拒绝计划：保留计划文本与反馈，回到计划模式等待用户重新规划。 */
  rejectPlan(sessionId: string, feedback: string | undefined, window: BrowserWindow | null): SessionPlan | null {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error('会话不存在，请新建对话。')
    if (this.deletedSessions.has(sessionId)) throw new Error('这个对话已被删除。')
    const plan = session.plan
    if (!plan) throw new Error('当前对话还没有计划。')
    if ((session.mode ?? 'work') === 'chat') throw new Error('聊天模式不能拒绝计划：请先切换到工作模式。')
    if (plan.status !== 'pending' && plan.status !== 'executing') {
      throw new Error(plan.status === 'completed' ? '计划已执行完成，不能再拒绝。' : '这个计划已经是拒绝状态。')
    }
    this.assertPlanIdle(sessionId)
    plan.status = 'rejected'
    plan.updatedAt = Date.now()
    const note = feedback?.trim()
    if (note) plan.feedback = note.slice(0, 2000)
    session.planMode = true
    this.sessionStore.save(session)
    this.emitPlan(session, window)
    log.info('plan rejected', { sessionId, planId: plan.id })
    return plan
  }

  /**
   * 修改计划：保留旧计划作为上下文，进入计划模式并带着反馈启动一轮，
   * 模型重新探索后提交新计划（会替换旧计划）。
   */
  revisePlan(sessionId: string, feedback: string, window: BrowserWindow | null): { plan: SessionPlan | null; runId?: string } {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error('会话不存在，请新建对话。')
    if (this.deletedSessions.has(sessionId)) throw new Error('这个对话已被删除。')
    if ((session.mode ?? 'work') === 'chat') throw new Error('聊天模式不能修改计划：请先切换到工作模式。')
    const previous = session.plan
    if (!previous) throw new Error('当前对话还没有计划。')
    if (previous.status === 'completed') throw new Error('计划已执行完成，不能再修改。')
    if (previous.status === 'executing') throw new Error('计划正在执行：等这一轮结束或先停止，再修改。')
    this.assertPlanIdle(sessionId)
    const raw = feedback.trim()
    if (!raw) throw new Error('请写下要修改的地方，再让 Morrow 重新规划。')
    session.planMode = true
    this.sessionStore.save(session)
    this.emitPlan(session, window)
    const result = this.startRun(session, { sessionId, text: buildPlanRevisionPrompt(previous, raw) }, window)
    return { plan: previous ?? null, runId: result.runId }
  }

  /* ── Goal 模式 ─────────────────────────────────────────────── */

  private saveGoal(session: Session, goal: Goal | null): void {
    session.goal = goal
    this.sessionStore.save(session)
  }

  private emitGoal(session: Session, window: BrowserWindow | null): void {
    this.forward(
      {
        seq: 0,
        runId: 'goal',
        sessionId: session.id,
        at: Date.now(),
        type: 'goal_updated',
        goal: session.goal ?? null
      },
      window
    )
  }

  private emitPlan(session: Session, window: BrowserWindow | null): void {
    this.forward(
      {
        seq: 0,
        runId: 'plan',
        sessionId: session.id,
        at: Date.now(),
        type: 'plan_updated',
        plan: session.plan ?? null,
        planMode: session.planMode === true
      },
      window
    )
  }

  private emitTodos(session: Session, window: BrowserWindow | null): void {
    this.forward(
      {
        seq: 0,
        runId: 'plan',
        sessionId: session.id,
        at: Date.now(),
        type: 'todos_updated',
        todos: session.todos
      },
      window
    )
  }

  private abortSession(sessionId: string): void {
    for (const run of this.runs.values()) {
      if (run.sessionId === sessionId) run.controller.abort()
    }
  }

  /** 只中止目标轮次，不误伤目标暂停后用户发的普通对话 */
  private abortGoalRun(sessionId: string): void {
    for (const run of this.runs.values()) {
      if (run.sessionId === sessionId && run.goalId) run.controller.abort()
    }
  }

  /** 核心 update_goal 工具事件：把目标变更落库后转发给渲染层。 */
  private guardFor(sessionId: string): SensitiveGuard {
    let guard = this.sensitiveGuards.get(sessionId)
    if (!guard) {
      guard = new SensitiveGuard()
      // 重启后内存守卫为空：先从已有会话历史恢复敏感值，避免模型复述旧消息里的原值
      try {
        const session = this.sessionStore.get(sessionId)
        if (session) guard.observe(JSON.stringify(session.messages))
      } catch {
        // 历史不可序列化时跳过
      }
      this.sensitiveGuards.set(sessionId, guard)
    }
    return guard
  }

  private handleRuntimeEvent(active: ActiveRun, event: RuntimeEvent, window: BrowserWindow | null): void {
    // 会话已删除/已被清除全部：迟到的运行事件不再进入 UI、日志、通知或 island。
    if (this.deletedSessions.has(active.sessionId)) return
    const guard = this.guardFor(active.sessionId)
    // 先登记用户输入与工具结果中的敏感值，再对用户可见输出做遮蔽。
    // 用户消息本身也可能包含邮箱/用户名（例如要求脱敏时引用原值），模型复述同样需要遮蔽。
    if (event.type === 'run_started') {
      try {
        guard.observe(JSON.stringify(event.userMessage))
      } catch {
        // 忽略不可序列化结果
      }
    }
    if (event.type === 'tool_finished') {
      try {
        guard.observe(JSON.stringify(event.result))
      } catch {
        // 忽略不可序列化结果
      }
    }
    if (event.type === 'message_delta') {
      event = {
        ...event,
        ...(typeof event.textDelta === 'string' ? { textDelta: guard.redact(event.textDelta) } : {}),
        ...(typeof event.thinkingDelta === 'string' ? { thinkingDelta: guard.redact(event.thinkingDelta) } : {})
      }
    }
    if (event.type === 'message_completed') {
      event = { ...event, message: guard.redactMessage(event.message) }
    }
    if (event.type === 'run_finished' && event.message) {
      // run_finished 也会携带最后一条 assistant 消息；必须和 message_completed 一样遮蔽
      event = { ...event, message: guard.redactMessage(event.message) }
    }
    if (active.unattended &&
      (event.type === 'permission_requested' ||
        event.type === 'permission_resolved' ||
        event.type === 'question_asked' ||
        event.type === 'question_answered')
    ) {
      if (event.type === 'permission_requested') {
        log.warn('unattended permission auto-denied', {
          sessionId: active.sessionId,
          tool: event.request.toolName,
          risk: event.request.risk
        })
      }
      return
    }
    if (active.researchPlanning && (event.type === 'message_delta' || event.type === 'message_completed')) {
      return
    }
    if (event.type === 'permission_requested') {
      // 通知只提示「有操作待确认」，不把命令/路径放到可能出现在锁屏上的系统通知里
      this.notifyUser(
        active,
        '需要你的确认',
        `《${this.sessionStore.get(active.sessionId)?.title ?? '对话'}》有一个操作等待确认。`,
        true
      )
    } else if (event.type === 'question_asked') {
      this.notifyUser(
        active,
        '有一个问题需要你回答',
        `《${this.sessionStore.get(active.sessionId)?.title ?? '对话'}》有一个问题等待回答。`,
        true
      )
    }
    switch (event.type) {
      case 'goal_updated': {
        const session = this.sessionStore.get(active.sessionId)
        if (session) {
          const prev = session.goal
          const round = prev?.round ?? event.goal?.round ?? 1
          // 保留主进程管理的预算/计数与身份字段，不被 core 的目标快照覆盖
          const next: Goal | null = event.goal
            ? {
                ...event.goal,
                round,
                ...(prev
                  ? {
                      id: prev.id,
                      createdAt: prev.createdAt,
                      toolCalls: prev.toolCalls,
                      activeMs: prev.activeMs,
                      noProgressRounds: prev.noProgressRounds,
                      progressKeys: prev.progressKeys,
                      maxToolCalls: prev.maxToolCalls,
                      maxActiveMs: prev.maxActiveMs,
                      maxNoProgressRounds: prev.maxNoProgressRounds
                    }
                  : {})
              }
            : null
          this.saveGoal(session, next)
        }
        break
      }
      case 'permission_requested': {
        active.permissionRequests.set(event.request.id, event.request)
        break
      }
      case 'permission_resolved': {
        const request = active.permissionRequests.get(event.requestId)
        active.permissionRequests.delete(event.requestId)
        if (request) {
          const rulesService = getPermissionRulesService()
          rulesService.appendLog({
            at: Date.now(),
            workspace: active.workspace,
            sessionId: active.sessionId,
            toolName: request.toolName,
            title: request.title,
            decision: event.decision
          })
          if (event.decision === 'always' && request.allowAlways !== false) {
            rulesService.addAlwaysRule({
              workspace: active.workspace,
              tool: request.toolName,
              toolInput: request.input
            })
          }
        }
        break
      }
      case 'plan_updated': {
        const session = this.sessionStore.get(active.sessionId)
        if (session) {
          session.plan = event.plan
          session.planMode = event.planMode
          this.sessionStore.save(session)
        }
        break
      }
      case 'message_completed': {
        active.liveMessages.set(event.message.id, event.message)
        this.scheduleIncrementalSave(active, true)
        break
      }
      case 'tool_started': {
        active.roundToolCalls += 1
        const message = active.liveMessages.get(event.messageId)
        if (message) {
          const block = message.content.find(
            (item): item is ToolUseBlock => item.type === 'tool_use' && item.id === event.block.id
          )
          if (block) {
            block.status = 'running'
            block.startedAt = event.block.startedAt ?? Date.now()
          }
        }
        this.scheduleIncrementalSave(active)
        break
      }
      case 'tool_progress': {
        const message = active.liveMessages.get(event.messageId)
        if (message) {
          const block = message.content.find(
            (item): item is ToolUseBlock => item.type === 'tool_use' && item.id === event.toolUseId
          )
          if (block) {
            if (event.status) block.status = event.status
            if (event.title) block.title = event.title
            if (typeof event.percent === 'number') block.progressPercent = event.percent
            if (event.swarmTask) {
              block.swarmTasks = mergeSwarmTask(block.swarmTasks, event.swarmTask)
            }
          }
        }
        break
      }
      case 'tool_finished': {
        const message = active.liveMessages.get(event.messageId)
        if (message) {
          const block = message.content.find(
            (item): item is ToolUseBlock => item.type === 'tool_use' && item.id === event.toolUseId
          )
          if (block) {
            block.result = event.result
            block.status = event.denied
              ? 'denied'
              : event.interrupted
                ? 'interrupted'
                : event.result.ok
                  ? 'success'
                  : 'error'
            block.finishedAt = Date.now()
            const finalSwarmTasks = swarmTasksFromMeta(event.result.meta)
            if (finalSwarmTasks.length > 0) block.swarmTasks = finalSwarmTasks
            const changedFiles = (event.result.meta as Record<string, unknown> | undefined)?.changedFiles
            if ((event.result.ok || Array.isArray(changedFiles)) && active.checkpointId) {
              try {
                const checkpoints = getCheckpointService(this.sessionStore)
                checkpoints.recordToolResult(active.sessionId, active.checkpointId, event.result.meta)
                if (active.stageCheckpointId && active.stageCheckpointId !== active.checkpointId) {
                  checkpoints.recordToolResult(active.sessionId, active.stageCheckpointId, event.result.meta)
                }
              } catch (err) {
                log.warn('checkpoint record failed', { sessionId: active.sessionId, error: String(err) })
              }
            }
            // R2-F/G：只有「真实文件变化 / 首次成功的 MCP/外部调用」才算进展；
            // 重复写相同内容、旧文件、空命令、失败调用都不刷新 no_progress。
            if (event.result.ok && active.progressTracker) {
              const observed = active.progressTracker.observe({
                toolName: block.name,
                input: block.input,
                ok: true,
                resultMeta: event.result.meta,
                workspace: active.workspace,
                goalCreatedAt: active.goalCreatedAt
              })
              if (observed.progress) active.roundProgressActions += 1
            }
            void runHooks(
              'post_tool_use',
              {
                event: 'post_tool_use',
                sessionId: active.sessionId,
                workspace: active.workspace,
                tool: block.name,
                input: block.input,
                result: {
                  ok: event.result.ok,
                  output: event.result.output.slice(0, 4000),
                  ...(event.result.error ? { error: event.result.error.slice(0, 1000) } : {}),
                  durationMs: event.result.durationMs
                },
                denied: event.denied === true,
                interrupted: event.interrupted === true
              },
              active.workspace
            ).catch((err) => {
              log.warn('post_tool_use hooks failed', { error: err instanceof Error ? err.message : String(err) })
            })
          }
        }
        this.scheduleIncrementalSave(active, event.denied === true || event.interrupted === true || event.result.ok === false)
        break
      }
      case 'artifacts_updated': {
        if (event.artifacts.length > active.baselineArtifacts) active.roundProgressActions += 1
        active.liveArtifacts = event.artifacts
        this.scheduleIncrementalSave(active, true)
        break
      }
      case 'todos_updated': {
        active.liveTodos = event.todos
        const completedNow = event.todos.filter((todo) => todo.status === 'completed').length
        if (completedNow > active.baselineCompletedTodos) active.roundProgressActions += 1
        const newlyCompleted = event.todos.filter(
          (todo) => todo.status === 'completed' && !active.completedTodoIds.has(todo.id)
        )
        for (const todo of newlyCompleted) active.completedTodoIds.add(todo.id)
        if (newlyCompleted.length > 0 && active.checkpointId && !active.demo && !active.researchPlanning) {
          const session = this.sessionStore.get(active.sessionId)
          const mode = session?.mode ?? 'work'
          if (session && mode === 'work' && session.planMode !== true) {
            const live = [...active.liveMessages.values()]
            const boundary = live[live.length - 1]
            if (boundary) {
              const titles = newlyCompleted.map((todo) => todo.text.replace(/\s+/g, ' ').trim()).filter(Boolean)
              const label =
                titles.length === 1
                  ? `完成：${titles[0].slice(0, 80)}`
                  : `完成 ${titles.length} 个步骤：${titles.join('、').slice(0, 80)}`
              try {
                const stage = getCheckpointService(this.sessionStore).createStage({
                  sessionId: active.sessionId,
                  messageId: boundary.id,
                  messageIndex: active.messageCountBase + live.length - 1,
                  label,
                  todos: event.todos,
                  artifactIds: session.artifacts.map((artifact) => artifact.id),
                  plan: session.plan ?? null,
                  planMode: false
                })
                if (stage) {
                  active.stageCheckpointId = stage.id
                  boundary.stageBoundary = { checkpointId: stage.id, label }
                  this.scheduleIncrementalSave(active, true)
                  // 让正在看的 UI 立刻出现阶段节点，而不是等本轮结束重载会话
                  this.forward(
                    {
                      seq: 0,
                      runId: active.runId,
                      sessionId: active.sessionId,
                      at: Date.now(),
                      type: 'message_completed',
                      messageId: boundary.id,
                      message: guard.redactMessage(boundary)
                    },
                    window
                  )
                }
              } catch (err) {
                log.warn('stage checkpoint create failed', { sessionId: active.sessionId, error: String(err) })
              }
            }
          }
        }
        this.scheduleIncrementalSave(active)
        break
      }
      default:
        break
    }
    this.forward(event, window)
  }

  /* ── 运行中增量落盘（崩溃/退出恢复的证据） ─────────────────── */

  private scheduleIncrementalSave(active: ActiveRun, immediate = false): void {
    if (active.incrementalTimer) return
    const elapsed = Date.now() - active.lastIncrementalAt
    const delay = immediate ? 0 : Math.max(0, 400 - elapsed)
    active.incrementalTimer = setTimeout(() => {
      active.incrementalTimer = null
      this.flushIncremental(active)
    }, delay)
  }

  /** 把运行中的消息与目标预算用量写入会话文件（不阻塞事件流） */
  private flushIncremental(active: ActiveRun): void {
    active.lastIncrementalAt = Date.now()
    if (this.deletedSessions.has(active.sessionId)) return
    try {
      const session = this.sessionStore.get(active.sessionId)
      if (!session) return
      let changed = false
      for (const message of active.liveMessages.values()) {
        const index = session.messages.findIndex((item) => item.id === message.id)
        if (index >= 0) {
          session.messages[index] = message
        } else {
          session.messages.push(message)
        }
        changed = true
      }
      if (active.liveTodos) {
        session.todos = active.liveTodos
        changed = true
      }
      if (active.liveArtifacts) {
        session.artifacts = active.liveArtifacts
        changed = true
      }
      // 目标预算计数实时落盘：崩溃重启后轮次/调用数/有效时间不会归零。
      // R2-D：统一用 base+round 的 assignment（不是 +=），flush 多次也不会重复累加。
      if (session.goal?.status === 'active') {
        const merged = mergeGoalUsage(
          { toolCalls: active.goalToolCallsBase, activeMs: active.goalActiveMsBase },
          { toolCalls: active.roundToolCalls, activeMs: Math.max(0, Date.now() - active.startedAt) }
        )
        session.goal.toolCalls = merged.toolCalls
        session.goal.activeMs = merged.activeMs
        if (active.progressTracker) session.goal.progressKeys = active.progressTracker.toKeys()
        session.goal.updatedAt = Date.now()
        changed = true
      }
      if (changed) this.sessionStore.save(session)
    } catch (err) {
      log.warn('incremental save failed', { runId: active.runId, error: String(err) })
    }
  }

  /**
   * 本轮结束后的目标调度：
   * - 完成/阻塞 → 结束循环；
   * - 用户中止/出错 → 自动暂停（可手动继续）；
   * - 达到轮次/工具调用/有效时间/连续无进展预算 → 诚实暂停并说明原因；
   * - 否则 350ms 后进入下一轮续跑。
   */
  private async afterRun(active: ActiveRun, result: RunAgentResult, window: BrowserWindow | null): Promise<void> {
    if (this.deletedSessions.has(active.sessionId)) return
    const session = this.sessionStore.get(active.sessionId)
    const goal = session?.goal
    if (!session || !goal) return
    // 旧轮次的迟到回调（用户已暂停/结束/继续后启动了新轮）：不要干扰当前目标状态
    if (active.goalId && goal.id !== active.goalId) return
    if (active.goalRound !== undefined && goal.round !== active.goalRound) return

    // 累计本轮预算与进展（即使完成/阻塞也要先记账，保证报告数字真实）。
    // R2-D：flushIncremental 可能已经写过 base+round，这里必须用 assignment，不能再次 +=。
    const merged = mergeGoalUsage(
      { toolCalls: active.goalToolCallsBase, activeMs: active.goalActiveMsBase },
      { toolCalls: active.roundToolCalls, activeMs: Math.max(0, Date.now() - active.startedAt) }
    )
    goal.toolCalls = merged.toolCalls
    goal.activeMs = merged.activeMs
    if (active.progressTracker) goal.progressKeys = active.progressTracker.toKeys()
    // R2-F/G：进展只来自「真实文件变化 / 首次成功的 MCP/外部成果」，不再用产物数量/todo 数兜底
    const progressed = active.roundProgressActions > 0
    // 完成/阻塞的那一轮不参与「无进展」计数（它已经给出了终态与说明）
    if (goal.status !== 'completed' && goal.status !== 'blocked') {
      goal.noProgressRounds = progressed ? 0 : (goal.noProgressRounds ?? 0) + 1
    }
    goal.updatedAt = Date.now()
    this.saveGoal(session, goal)

    if (goal.status === 'completed' || goal.status === 'blocked' || goal.status === 'cancelled') {
      this.goalLoops.delete(session.id)
      this.emitGoal(session, window)
      return
    }
    if (goal.status !== 'active') {
      // 用户在本轮运行中暂停：pauseGoal 已写好状态，这里只清循环标记
      this.goalLoops.delete(session.id)
      this.emitGoal(session, window)
      return
    }
    if (active.controller.signal.aborted || result.reason !== 'complete') {
      this.pauseGoalInternal(
        session,
        window,
        active.controller.signal.aborted ? 'user_paused' : 'error',
        active.controller.signal.aborted ? '本轮被用户暂停' : `本轮未正常完成（${result.reason}），已暂停`
      )
      return
    }
    const budget = this.checkBudgets(goal)
    if (budget) {
      this.pauseGoalInternal(session, window, budget.reason, budget.summary)
      return
    }
    // 轮次间隔：保持 goalLoops 标记，防止用户消息插队；目标可能被工具标记完成
    setTimeout(() => {
      if (this.deletedSessions.has(active.sessionId)) return
      const latest = this.sessionStore.get(active.sessionId)
      const current = latest?.goal
      if (!latest || !current || current.status !== 'active' || !this.goalLoops.has(session.id)) return
      if (this.runs.has(active.runId)) return
      // 暂停后立刻继续会复用同一个 goalId；只要该会话已有新 run，旧续跑计时器必须退出
      for (const run of this.runs.values()) if (run.sessionId === latest.id) return
      if (active.goalId && current.id !== active.goalId) return
      current.round += 1
      current.updatedAt = Date.now()
      this.saveGoal(latest, current)
      this.emitGoal(latest, window)
      const text = this.buildGoalContinuation(current)
      try {
        this.startRun(latest, { sessionId: latest.id, text }, window)
      } catch (err) {
        log.error('goal continuation failed to start', { sessionId: latest.id, error: String(err) })
        this.pauseGoalInternal(latest, window, 'error', '续跑启动失败，已暂停')
      }
    }, 350)
  }

  /** 达到预算时返回停止原因（不继续下一轮，也不把停止说成完成） */
  private checkBudgets(
    goal: Goal
  ): { reason: NonNullable<Goal['stopReason']>; summary: string } | null {
    const maxToolCalls = goal.maxToolCalls ?? DEFAULT_GOAL_BUDGETS.maxToolCalls
    const maxActiveMs = goal.maxActiveMs ?? DEFAULT_GOAL_BUDGETS.maxActiveMs
    const maxNoProgressRounds = goal.maxNoProgressRounds ?? DEFAULT_GOAL_BUDGETS.maxNoProgressRounds
    if (goal.round >= goal.maxRounds) {
      return {
        reason: 'budget_rounds',
        summary: `已达到轮次预算（${goal.round}/${goal.maxRounds} 轮），目标尚未标记完成，已停止自动续跑；已完成的进度保留，可手动继续。`
      }
    }
    if ((goal.toolCalls ?? 0) >= maxToolCalls) {
      return {
        reason: 'budget_tool_calls',
        summary: `已达到工具调用预算（${goal.toolCalls ?? 0}/${maxToolCalls} 次），目标尚未标记完成，已停止自动续跑。`
      }
    }
    if ((goal.activeMs ?? 0) >= maxActiveMs) {
      return {
        reason: 'budget_time',
        summary: `已达到有效运行时间预算（${Math.round((goal.activeMs ?? 0) / 60000)}/${Math.round(maxActiveMs / 60000)} 分钟），目标尚未标记完成，已停止自动续跑。`
      }
    }
    if ((goal.noProgressRounds ?? 0) >= maxNoProgressRounds) {
      return {
        reason: 'no_progress',
        summary: `连续 ${goal.noProgressRounds} 轮没有实际进展，已停止自动续跑（可能材料未就绪或需要用户决定）。`
      }
    }
    return null
  }

  private onRunFailure(active: ActiveRun): void {
    const session = this.sessionStore.get(active.sessionId)
    if (!session?.goal) return
    this.pauseGoalInternal(session, active.window, 'error', '本轮运行出错，已暂停')
  }

  /**
   * 暂停内部实现：保留已有进度摘要，只追加/记录停止原因；
   * 绝不把「暂停」写成 completed。
   */
  private pauseGoalInternal(
    session: Session,
    window: BrowserWindow | null,
    reason: NonNullable<Goal['stopReason']>,
    summary: string
  ): void {
    const goal = session.goal
    if (!goal) return
    if (goal.status !== 'active') return
    goal.status = 'paused'
    goal.stopReason = reason
    goal.summary = goal.summary?.trim() ? `${goal.summary.trim()}\n（${summary}）` : summary
    goal.updatedAt = Date.now()
    this.goalLoops.delete(session.id)
    this.saveGoal(session, goal)
    this.emitGoal(session, window)
  }

  private buildGoalContinuation(goal: Goal): string {
    const maxToolCalls = goal.maxToolCalls ?? DEFAULT_GOAL_BUDGETS.maxToolCalls
    const maxActiveMs = goal.maxActiveMs ?? DEFAULT_GOAL_BUDGETS.maxActiveMs
    const maxNoProgressRounds = goal.maxNoProgressRounds ?? DEFAULT_GOAL_BUDGETS.maxNoProgressRounds
    const lines = [
      `（目标模式 · 第 ${goal.round}/${goal.maxRounds} 轮续跑）`,
      `目标：${goal.objective}`,
      `上一轮摘要：${goal.summary?.trim() || '（无）'}`,
      `下一步建议：${goal.nextStep?.trim() || '回顾已有进展并继续推进目标'}`,
      `预算用量：工具调用 ${goal.toolCalls ?? 0}/${maxToolCalls}，有效运行 ${Math.round((goal.activeMs ?? 0) / 60000)}/${Math.round(maxActiveMs / 60000)} 分钟，连续无进展 ${goal.noProgressRounds ?? 0}/${maxNoProgressRounds} 轮`,
      '',
      '请继续推进。完成本轮可验证的推进后调用 update_goal：',
      '- 还有后续工作：status=active，并填写 summary 与本轮之后的 nextStep；',
      '- 目标全部完成：status=completed，并在 evidence 中列出工作区内真实存在的产物路径（系统会核验存在性）；',
      '- 确实无法继续：status=blocked，并填写 blockedReason。',
      '任何一项预算用尽时系统会停止自动续跑；不要为了凑轮次空转，也不要把停止说成完成。'
    ]
    return lines.join('\n')
  }

  async startGoal(
    sessionId: string,
    objective: string,
    maxRounds: number,
    window: BrowserWindow | null,
    budgets: GoalBudgetsInput = {}
  ): Promise<{ goal: Goal; runId: string }> {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error('会话不存在，请新建对话。')
    if (this.deletedSessions.has(sessionId)) throw new Error('这个对话已被删除。')
    const text = objective.trim()
    if (!text) throw new Error('请先写下目标。')
    if ((session.mode ?? 'work') === 'chat') {
      throw new Error('聊天模式下不能建立目标：请先把输入框旁的「聊天 / 工作」切到「工作」。')
    }
    if (session.mode === 'research') {
      throw new Error('深度研究模式下不能建立目标：研究报告由研究轮次自动推进。')
    }
    if (session.planMode) {
      throw new Error('计划模式下不能建立目标：先批准或关闭计划模式，再建立多轮目标。')
    }
    const otherBusy = this.otherSessionBusy(sessionId)
    if (otherBusy) throw new Error(otherBusy)
    if (this.isSessionRunning(sessionId)) throw new Error('这个对话正在运行，等它完成或先停止。')
    if (this.compactingSessions.has(sessionId)) throw new Error('正在压缩上下文，完成后再建立目标。')
    // R7 审计：默认由系统按目标复杂度智能估算轮次（最高 256 轮），用户不需要手动设置；
    // 显式传入 maxRounds 的调用方（高级用法 / 审计测试）仍然优先。
    const explicitRounds = typeof maxRounds === 'number' && Number.isFinite(maxRounds) && maxRounds > 0
    const rounds = explicitRounds ? clampRounds(maxRounds) : inferGoalRounds(text)
    const inferred = inferGoalBudgets(rounds)
    const now = Date.now()
    const goal: Goal = {
      id: `goal_${randomUUID().slice(0, 12)}`,
      objective: text.slice(0, 4000),
      status: 'active',
      round: 1,
      maxRounds: rounds,
      maxRoundsAuto: !explicitRounds,
      toolCalls: 0,
      activeMs: 0,
      noProgressRounds: 0,
      progressKeys: [],
      maxToolCalls: clampBudget(budgets.maxToolCalls, inferred.maxToolCalls, 1, 1_000_000),
      maxActiveMs: clampBudget(budgets.maxActiveMs, inferred.maxActiveMs, 1000, 24 * 3600_000),
      maxNoProgressRounds: clampBudget(budgets.maxNoProgressRounds, inferred.maxNoProgressRounds, 1, 100),
      createdAt: now,
      updatedAt: now
    }
    this.saveGoal(session, goal)
    this.goalLoops.add(session.id)
    this.emitGoal(session, window)
    log.info('goal started', {
      sessionId,
      rounds,
      autoRounds: !explicitRounds,
      maxToolCalls: goal.maxToolCalls,
      maxActiveMs: goal.maxActiveMs
    })
    try {
      const result = this.startRun(
        session,
        {
          sessionId,
          text: `开始执行目标：\n${goal.objective}\n\n请先规划并推进第一轮。每轮结束调用 update_goal 记录 summary 与 nextStep；目标完成时标记 completed（必须提供 evidence），无法继续时标记 blocked。`
        },
        window
      )
      return { goal, runId: result.runId }
    } catch (err) {
      // 首轮启动失败（例如还没配置可用的模型）：不留下「进行中但不会动」的幽灵目标
      this.goalLoops.delete(session.id)
      this.saveGoal(session, null)
      this.emitGoal(session, window)
      throw err
    }
  }

  pauseGoal(sessionId: string, window: BrowserWindow | null): { goal: Goal | null } {
    const session = this.sessionStore.get(sessionId)
    if (!session?.goal) throw new Error('当前对话没有目标。')
    if (this.deletedSessions.has(sessionId)) throw new Error('这个对话已被删除。')
    if (session.goal.status !== 'active') return { goal: session.goal }
    session.goal.status = 'paused'
    session.goal.stopReason = 'user_paused'
    // 保留已有进度摘要（旧实现会覆盖成「已手动暂停」，丢失进度）
    session.goal.updatedAt = Date.now()
    this.goalLoops.delete(sessionId)
    this.saveGoal(session, session.goal)
    this.abortGoalRun(sessionId)
    this.emitGoal(session, window)
    return { goal: session.goal }
  }

  resumeGoal(sessionId: string, window: BrowserWindow | null): { goal: Goal; runId: string } {
    const session = this.sessionStore.get(sessionId)
    const goal = session?.goal
    if (!session || !goal) throw new Error('当前对话没有目标。')
    if (this.deletedSessions.has(sessionId)) throw new Error('这个对话已被删除。')
    if ((session.mode ?? 'work') === 'chat') {
      throw new Error('聊天模式下不能继续目标：请先把输入框旁的「聊天 / 工作」切到「工作」。')
    }
    if (session.planMode === true) {
      throw new Error('计划模式下不能继续目标：先完成或退出计划模式，再继续目标。')
    }
    if (goal.status !== 'paused' && goal.status !== 'blocked') {
      throw new Error('只有已暂停或已阻塞的目标可以继续。')
    }
    const otherBusy = this.otherSessionBusy(sessionId)
    if (otherBusy) throw new Error(otherBusy)
    if (this.isSessionRunning(sessionId)) throw new Error('这个对话正在运行，等它完成或先停止。')
    if (this.compactingSessions.has(sessionId)) throw new Error('正在压缩上下文，完成后再继续目标。')
    if (goal.round >= GOAL_MAX_ROUNDS) {
      throw new Error(`已达到总轮次上限 ${GOAL_MAX_ROUNDS} 轮，请结束目标后重新建立一个新的目标。`)
    }
    const previousRound = goal.round
    // 用户主动继续 = 新的授权段：轮次/工具/时间预算不足时按段追加，而不是报错要求重建目标。
    const nextRound = goal.round + 1
    if (nextRound > goal.maxRounds) {
      goal.maxRounds = Math.min(GOAL_MAX_ROUNDS, nextRound + GOAL_RESUME_SEGMENT - 1)
    }
    if ((goal.toolCalls ?? 0) >= (goal.maxToolCalls ?? DEFAULT_GOAL_BUDGETS.maxToolCalls)) {
      goal.maxToolCalls = (goal.toolCalls ?? 0) + DEFAULT_GOAL_BUDGETS.maxToolCalls
    }
    if ((goal.activeMs ?? 0) >= (goal.maxActiveMs ?? DEFAULT_GOAL_BUDGETS.maxActiveMs)) {
      goal.maxActiveMs = (goal.activeMs ?? 0) + DEFAULT_GOAL_BUDGETS.maxActiveMs
    }
    goal.status = 'active'
    goal.round = nextRound
    goal.noProgressRounds = 0
    delete goal.stopReason
    delete goal.blockedReason
    goal.updatedAt = Date.now()
    this.saveGoal(session, goal)
    this.goalLoops.add(session.id)
    this.emitGoal(session, window)
    try {
      const result = this.startRun(session, { sessionId, text: this.buildGoalContinuation(goal) }, window)
      return { goal, runId: result.runId }
    } catch (err) {
      // 继续失败（模型被删/密钥失效等）：回到暂停态并恢复轮次，修好后可再次继续
      this.goalLoops.delete(session.id)
      goal.status = 'paused'
      goal.round = previousRound
      goal.stopReason = 'error'
      goal.blockedReason = err instanceof Error ? err.message : '继续目标失败'
      goal.updatedAt = Date.now()
      this.saveGoal(session, goal)
      this.emitGoal(session, window)
      throw err
    }
  }

  /** 用户手动结束目标：记为「已取消」（cancelled），绝不记为 completed */
  stopGoal(sessionId: string, window: BrowserWindow | null): { goal: Goal | null } {
    const session = this.sessionStore.get(sessionId)
    if (!session?.goal) throw new Error('当前对话没有目标。')
    if (this.deletedSessions.has(sessionId)) throw new Error('这个对话已被删除。')
    // 完成/已取消是终态：迟到的确认不能再把它改成 cancelled
    if (session.goal.status === 'completed' || session.goal.status === 'cancelled') {
      return { goal: session.goal }
    }
    session.goal.status = 'cancelled'
    session.goal.stopReason = 'user_stopped'
    session.goal.cancelledAt = Date.now()
    session.goal.updatedAt = Date.now()
    this.goalLoops.delete(sessionId)
    this.saveGoal(session, session.goal)
    // 暂停目标后用户可能正在普通聊天：只中止目标轮次，不误伤这条消息
    this.abortGoalRun(sessionId)
    this.emitGoal(session, window)
    return { goal: session.goal }
  }

  clearGoal(sessionId: string, window: BrowserWindow | null): { goal: null } {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error('会话不存在。')
    if (this.deletedSessions.has(sessionId)) throw new Error('这个对话已被删除。')
    this.goalLoops.delete(sessionId)
    // 清除时若还有运行中的轮次，一并停止，避免「目标没了但还在跑」
    if (session.goal?.status === 'active') this.abortSession(sessionId)
    this.saveGoal(session, null)
    this.emitGoal(session, window)
    return { goal: null }
  }

  cancel(runId: string): boolean {
    const active = this.runs.get(runId)
    if (!active) return false
    const session = this.sessionStore.get(active.sessionId)
    if (session?.goal?.status === 'active') {
      session.goal.status = 'paused'
      session.goal.stopReason = 'user_paused'
      session.goal.updatedAt = Date.now()
      this.goalLoops.delete(active.sessionId)
      this.saveGoal(session, session.goal)
      this.emitGoal(session, active.window)
    }
    active.controller.abort()
    return true
  }

  cancelAll(): void {
    for (const run of this.runs.values()) run.controller.abort()
  }

  respondPermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.permissions.get(requestId)
    if (!pending) return false
    this.permissions.delete(requestId)
    pending.resolve(decision)
    return true
  }

  respondQuestion(requestId: string, answer: AskUserAnswer): boolean {
    const pending = this.questions.get(requestId)
    if (!pending) return false
    this.questions.delete(requestId)
    pending.resolve(answer)
    return true
  }

  /** 应用退出前清空挂起请求，避免 core promise 悬挂；并把 active 目标转为可恢复的 paused */
  dispose(): void {
    for (const run of this.runs.values()) run.controller.abort()
    for (const pending of this.permissions.values()) pending.resolve('deny')
    for (const pending of this.questions.values()) pending.resolve({ value: 'cancelled', label: '已取消' })
    this.permissions.clear()
    this.questions.clear()
    this.compactingSessions.clear()
    this.runs.clear()
    for (const timer of this.evolutionTimers.values()) clearTimeout(timer)
    this.evolutionTimers.clear()
    for (const timer of this.queueRetryTimers.values()) clearTimeout(timer)
    this.queueRetryTimers.clear()
    this.queues.clear()
    for (const sessionId of [...this.goalLoops]) {
      const session = this.sessionStore.get(sessionId)
      if (session?.goal?.status === 'active') {
        session.goal.status = 'paused'
        session.goal.stopReason = 'app_restarted'
        session.goal.updatedAt = Date.now()
        this.sessionStore.save(session)
      }
    }
    this.goalLoops.clear()
  }

  private resolveProvider(
    session: Session,
    input: SendMessageInput
  ): {
    provider: ReturnType<typeof createProvider>
    config: ProviderConfig
    modelId: string
    modelInfo: ModelInfo
    contextWindow?: number
  } {
    return this.resolveModel(input.model ?? session.model)
  }

  private resolveModel(
    modelRef: Session['model']
  ): {
    provider: ReturnType<typeof createProvider>
    config: ProviderConfig
    modelId: string
    modelInfo: ModelInfo
    contextWindow?: number
  } {
    const settings = this.settingsStore.get()
    const config = settings.providers.find((p) => p.id === modelRef.providerId)
    if (!config) throw new Error('找不到这个模型提供方，请到设置里重新连接。')
    const modelInfo =
      config.models.find((m) => m.id === modelRef.modelId) ?? config.models[0] ?? null
    if (!modelInfo) throw new Error('这个提供方还没有可用模型，请到设置里添加。')
    const requestedContext =
      modelRef.contextWindow && Number.isFinite(modelRef.contextWindow) &&
      modelRef.contextWindow >= 1_024 && modelRef.contextWindow <= modelInfo.contextWindow
        ? Math.round(modelRef.contextWindow)
        : undefined
    const contextWindow = requestedContext ?? modelInfo.defaultContextWindow ?? modelInfo.contextWindow
    const effectiveModelInfo = contextWindow !== modelInfo.contextWindow ? { ...modelInfo, contextWindow } : modelInfo
    let apiKey = config.kind === 'demo' ? null : this.settingsStore.getApiKey(config.id)
    const isLocalEndpoint = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(config.baseUrl)
    if (config.kind !== 'demo' && !apiKey) {
      if (isLocalEndpoint) {
        // Ollama / LM Studio 等本机服务不需要 API Key
        apiKey = 'morrow-local'
      } else {
        throw new Error('还没有连接模型。请打开设置 → 模型连接，填入 API Key 后再试。')
      }
    }
    return {
      provider: createProvider(config, apiKey, modelInfo.id),
      config,
      modelId: modelInfo.id,
      modelInfo: effectiveModelInfo,
      contextWindow
    }
  }

  /** 终端工具：只允许操作当前会话工作区内的进程；命令由权限层审批。 */
  private terminalHandler(workspace: string | null): import('@core/index').TerminalToolHandler {
    const manager = getTerminalManager()
    return async (input) => {
      if (!workspace) {
        return { ok: false, summary: '', error: '当前会话没有工作区，不能启动终端。', hint: '请先选择工作文件夹。' }
      }
      const sameWorkspace = (id: string | undefined): boolean => {
        if (!id) return false
        const info = manager.get(id)
        return Boolean(info && info.cwd === workspace)
      }
      try {
        if (input.action === 'list') {
          const processes = manager.list().filter((item) => item.cwd === workspace)
          return { ok: true, summary: `共 ${processes.length} 个进程。`, processes }
        }
        const selectedShell = this.settingsStore.get().terminalShell || undefined
        if (input.action === 'start') {
          const process = manager.startTask(input.command ?? '', workspace, input.title, selectedShell)
          return { ok: true, summary: '后台任务已启动。', process }
        }
        if (input.action === 'run') {
          const result = await manager.runOnce(
            input.command ?? '',
            workspace,
            input.timeoutMs ?? 120_000,
            selectedShell
          )
          return {
            ok: true,
            summary: result.timedOut ? '命令超时，已停止。' : '命令结束。',
            output: result.output,
            exitCode: result.exitCode ?? undefined,
            ...(result.timedOut ? { hint: '长任务请改用 terminal(action=start) 在后台运行。' } : {})
          }
        }
        if (!input.id || !sameWorkspace(input.id)) {
          return { ok: false, summary: '', error: '这个终端/任务不存在，或不属于当前工作区。' }
        }
        if (input.action === 'read') {
          const result = manager.read(input.id, input.tail)
          return { ok: true, summary: '读取终端输出。', process: result.info, output: result.output }
        }
        if (input.action === 'write') {
          const info = manager.write(input.id, input.data ?? '')
          return { ok: true, summary: '已写入标准输入。', process: info }
        }
        if (input.action === 'stop') {
          const info = manager.stop(input.id)
          return { ok: true, summary: '已发送停止信号。', process: info }
        }
        if (input.action === 'restart') {
          const info = manager.restart(input.id)
          return { ok: true, summary: '已重新启动。', process: info }
        }
        return { ok: false, summary: '', error: `未知的终端操作：${input.action}` }
      } catch (err) {
        return {
          ok: false,
          summary: '',
          error: err instanceof Error ? err.message : String(err),
          hint: '可以先用 terminal(action=list) 查看可用进程。'
        }
      }
    }
  }

  /** 项目上下文 = 项目/记忆 + 规则文件 + 与当前请求相关的任务经验。 */
  private buildProjectContext(workspace: string | null, query = ''): string {
    const base = getProjectPrompt(workspace) || this.readProjectMemory(workspace) || ''
    const rules = getAgentRulesPrompt(workspace)
    const episodes = getEpisodePrompt(workspace, query)
    return [base.trim(), rules.trim(), episodes.trim()].filter(Boolean).join('\n\n')
  }

  private readProjectMemory(workspace: string | null): string | undefined {
    if (!workspace) return undefined
    const file = join(workspace, '.morrow', 'MEMORY.md')
    if (!existsSync(file)) return undefined
    try {
      const content = readFileSync(file, 'utf8').trim()
      return content ? content.slice(0, 8000) : undefined
    } catch {
      return undefined
    }
  }

  private forward(event: RuntimeEvent, window: BrowserWindow | null): void {
    if (this.deletedSessions.has(event.sessionId)) return
    // 灵动岛是独立窗口，不能依赖某个主窗口是否还活着：后台/计划/切换会话后的运行也要同步。
    ingestIslandRuntimeEvent(event)
    if (!window || window.isDestroyed()) return
    window.webContents.send(EVENT_CHANNEL, event)
  }

  private awaitPermission(active: ActiveRun, request: PermissionRequest): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      this.permissions.set(request.id, { resolve, sessionId: active.sessionId })
      active.controller.signal.addEventListener(
        'abort',
        () => {
          if (this.permissions.delete(request.id)) resolve('deny')
        },
        { once: true }
      )
    })
  }

  private awaitQuestion(active: ActiveRun, request: AskUserRequest): Promise<AskUserAnswer> {
    return new Promise<AskUserAnswer>((resolve) => {
      this.questions.set(request.id, { resolve, sessionId: active.sessionId })
      active.controller.signal.addEventListener(
        'abort',
        () => {
          if (this.questions.delete(request.id)) resolve({ value: 'cancelled', label: '已取消' })
        },
        { once: true }
      )
    })
  }

  private persistResult(active: ActiveRun, result: RunAgentResult): void {
    if (this.deletedSessions.has(active.sessionId)) return
    const session = this.sessionStore.get(active.sessionId)
    if (!session) return
    // 演示剧本的收尾动作在最后一次 todo_write 之后完成；演示正常结束即视为计划完成，
    // 避免出现「任务完成但计划停在 4/5」的观感问题。
    const todos =
      active.demo && result.reason === 'complete'
        ? result.todos.map((todo) => (todo.status === 'completed' ? todo : { ...todo, status: 'completed' as const }))
        : result.todos
    const goalIsCurrent =
      !!result.goal &&
      !!session.goal &&
      result.goal.id === session.goal.id &&
      session.goal.status === 'active' &&
      (active.goalId === undefined || session.goal.id === active.goalId) &&
      (active.goalRound === undefined || session.goal.round === active.goalRound)
    if (goalIsCurrent) {
      // 只在本轮仍属当前 active 目标时兜底同步；completed/blocked/paused/cancelled 等终态不会被旧 run 覆盖，
      // 主进程管理的预算计数也不会被 core 的旧快照覆盖。
      session.goal = {
        ...result.goal!,
        round: session.goal!.round,
        toolCalls: session.goal!.toolCalls,
        activeMs: session.goal!.activeMs,
        noProgressRounds: session.goal!.noProgressRounds,
        maxToolCalls: session.goal!.maxToolCalls,
        maxActiveMs: session.goal!.maxActiveMs,
        maxNoProgressRounds: session.goal!.maxNoProgressRounds
      }
    }
    const guard = this.guardFor(active.sessionId)
    const compactedMessages = result.compactedMessages
    // 阶段节点是主进程在流式消息上打的标；内核返回的消息副本不带这个字段，落盘前按 id 补回。
    const stageBoundaries = new Map<string, NonNullable<ChatMessage['stageBoundary']>>()
    for (const message of active.liveMessages.values()) {
      if (message.stageBoundary) stageBoundaries.set(message.id, message.stageBoundary)
    }
    const sourceMessages = compactedMessages ?? result.messages
    // 运行结束兜底：从完整消息（用户输入 + 工具结果）重新登记敏感值，
    // 防止流式分片把邮箱/用户名拆开后漏遮蔽；发生替换时同步刷新 UI。
    for (const message of sourceMessages) {
      try {
        guard.observe(JSON.stringify(message))
      } catch {
        // 忽略不可序列化结果
      }
    }
    let redactionChanged = false
    const safeMessages = sourceMessages.map((message) => {
      const redacted = guard.redactMessage(message)
      if (message.role === 'assistant' && JSON.stringify(redacted.content) !== JSON.stringify(message.content)) {
        redactionChanged = true
      }
      const boundary = stageBoundaries.get(message.id)
      return boundary ? { ...redacted, stageBoundary: boundary } : redacted
    })
    // 自动压缩返回的是完整会话历史；先替换，避免 applyRunResult 把旧消息继续并回来
    if (compactedMessages) session.messages = safeMessages
    // 计划模式运行带回计划（pending）；执行模式运行不得清掉已批准的计划。
    if (result.planMode === true && result.plan) session.plan = result.plan
    if (result.planMode !== undefined) session.planMode = result.planMode
    // 用量按会话累计；费用按本轮模型参考价估算（无价格时保持 undefined）。
    const previousUsage = session.usage
    const runCost = estimateUsageCost(result.usage, active.pricing)
    const usage = {
      inputTokens: previousUsage.inputTokens + result.usage.inputTokens,
      outputTokens: previousUsage.outputTokens + result.usage.outputTokens,
      ...(previousUsage.cacheReadTokens || result.usage.cacheReadTokens
        ? { cacheReadTokens: (previousUsage.cacheReadTokens ?? 0) + (result.usage.cacheReadTokens ?? 0) }
        : {}),
      contextUsed: result.usage.contextUsed ?? previousUsage.contextUsed,
      contextLimit: result.usage.contextLimit ?? previousUsage.contextLimit,
      ...(previousUsage.costUsd !== undefined || runCost !== undefined
        ? { costUsd: Math.round(((previousUsage.costUsd ?? 0) + (runCost ?? 0)) * 1_000_000) / 1_000_000 }
        : {})
    }
    const saved = this.sessionStore.applyRunResult(session, {
      messages: safeMessages,
      todos,
      artifacts: result.artifacts,
      usage,
      plan: session.plan ?? null,
      planMode: session.planMode === true
    })
    // 每轮结束把成品的最新文本快照入库；临时对话和演示不留下版本文件。
    if (!active.demo && !session.temporary) {
      try {
        getArtifactVersionStore().syncArtifacts(active.sessionId, saved.artifacts)
      } catch (err) {
        log.warn('artifact version sync failed', {
          sessionId: active.sessionId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    // 计划执行闭环：每一个计划步骤都有对应的已完成 todo 才落为 completed；
    // 只看 todo 会把「只完成了子集」误判成完成，未完成时保留 executing 供「继续执行」。
    // Token 账本：服务商 usage 是精确口径；缺失的字段用本地自研计数器补齐，并单独标记为估算。
    if (!active.demo && !session.temporary) {
      const exact = result.usage
      const newIds = new Set(result.messages.map((message) => message.id))
      const inputContext = saved.messages.filter((message) => !newIds.has(message.id))
      const estimatedInputTokens =
        exact.inputTokens > 0 ? 0 : estimateMessagesTokens(inputContext, '')
      const estimatedOutputTokens =
        exact.outputTokens > 0 ? 0 : result.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
      recordTokenUsage({
        sessionId: active.sessionId,
        inputTokens: exact.inputTokens,
        outputTokens: exact.outputTokens,
        cacheReadTokens: exact.cacheReadTokens ?? 0,
        estimatedInputTokens,
        estimatedOutputTokens
      })
    }
    const planStepsDone = saved.plan ? planStepsCompleted(saved.plan, saved.todos) : false
    if (saved.plan?.status === 'executing' && planStepsDone) {
      saved.plan.status = 'completed'
      saved.plan.completedAt = Date.now()
      saved.plan.updatedAt = saved.plan.completedAt
      this.sessionStore.save(saved)
      this.emitPlan(saved, active.window)
    } else if (saved.plan?.status === 'executing' && result.reason === 'complete') {
      this.forward(
        {
          seq: 0,
          runId: active.runId,
          sessionId: active.sessionId,
          at: Date.now(),
          type: 'notice',
          level: 'warn',
          message: '计划还有未完成的步骤：确认结果后可以点「继续执行」，或手动结束。'
        },
        active.window
      )
      this.emitPlan(saved, active.window)
    }
    this.ensureAutoTitle(saved)
    const meta = deriveMeta(saved)
    if (compactedMessages || redactionChanged) {
      // 自动压缩或在结束时补做了敏感值遮蔽：把最终历史一次性同步给当前视图，
      // 避免 UI 继续显示旧消息、重启后才突然变成摘要/脱敏后的内容。
      this.forward(
        {
          seq: 0,
          runId: active.runId,
          sessionId: active.sessionId,
          at: Date.now(),
          type: 'messages_replaced',
          messages: saved.messages
        },
        active.window
      )
    }
    if (active.demo && result.reason === 'complete') {
      // 与持久化一致地刷新 UI 的计划状态（演示收尾后全部完成）
      this.forward(
        {
          seq: 0,
          runId: active.runId,
          sessionId: active.sessionId,
          at: Date.now(),
          type: 'todos_updated',
          todos: saved.todos
        },
        active.window
      )
    }
    this.forward(
      {
        seq: 0,
        runId: active.runId,
        sessionId: active.sessionId,
        at: Date.now(),
        type: 'usage_updated',
        usage: saved.usage
      },
      active.window
    )
    this.forward(
      {
        seq: 0,
        runId: active.runId,
        sessionId: active.sessionId,
        at: Date.now(),
        type: 'session_updated',
        meta
      },
      active.window
    )
    this.captureTaskEpisode(active, result, saved)
    log.info('run persisted', {
      runId: active.runId,
      reason: result.reason,
      messages: result.messages.length,
      durationMs: Date.now() - active.startedAt
    })
  }

  /**
   * 自动任务经验：不调用模型，只把“这轮做了什么、结果如何”压成一条可检索的经验。
   * 只记录有实际工具/文件产出的完成轮次，避免把普通聊天塞进记忆。
   */
  private captureTaskEpisode(active: ActiveRun, result: RunAgentResult, session: Session): void {
    if (result.reason !== 'complete' || active.demo || active.internal || active.unattended) return
    if (!this.settingsStore.get().episodeMemoryEnabled) return
    if (session.temporary || session.demo || session.planMode === true) return
    const tools = new Set<string>()
    const files = new Set<string>()
    let toolCount = 0
    for (const message of result.messages) {
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue
        toolCount += 1
        tools.add(block.name)
        const meta = block.result?.meta as Record<string, unknown> | undefined
        const addPath = (value: unknown): void => {
          if (typeof value !== 'string' || !value) return
          let display = basename(value)
          if (session.workspace) {
            const rel = relative(session.workspace, value)
            if (rel && !rel.startsWith('..') && !rel.startsWith('/')) display = rel.split(sep).join('/')
          }
          files.add(display)
        }
        addPath(meta?.absolutePath)
        if (Array.isArray(meta?.changedFiles)) {
          for (const file of meta.changedFiles) {
            if (file && typeof file === 'object') addPath((file as Record<string, unknown>).absolutePath)
          }
        }
      }
    }
    if (toolCount === 0 && files.size === 0 && result.artifacts.length === 0) return
    const finalAssistant = [...result.messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.content.some((block) => block.type === 'text'))
    const summary = finalAssistant
      ? finalAssistant.content
          .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim()
          .slice(0, 1600)
      : result.artifacts.map((artifact) => artifact.title).filter(Boolean).join('、')
    if (!summary) return
    const intent = userMessageDisplayText(active.userMessage).trim().slice(0, 800)
    const genericTitle = !session.title || session.title === '新对话' || session.title === '临时对话'
    const title = (genericTitle ? intent.split(/\r?\n/)[0] : session.title).trim().slice(0, 120) || '任务记录'
    const tags = [
      ...new Set(
        [...files]
          .map((file) => file.split('.').pop()?.toLowerCase())
          .filter((value): value is string => Boolean(value && value.length <= 12))
      )
    ].slice(0, 4)
    try {
      const service = new MemoryService({ dataDir: resolveDataDir() })
      const entry = service.captureEpisode({
        scope: session.workspace ? 'project' : 'global',
        workspace: session.workspace,
        title,
        intent,
        summary,
        outcome: 'completed',
        tools: [...tools],
        files: [...files],
        tags,
        sourceSessionId: active.sessionId,
        sourceSessionTitle: session.title,
        sourceMessageId: finalAssistant?.id ?? active.runId
      })
      sendFeatureEvent(EPISODE_CHANGED_EVENT, {
        scope: entry.scope,
        workspace: entry.workspace,
        episodeId: entry.id
      })
    } catch (err) {
      log.warn('task episode capture failed', {
        sessionId: active.sessionId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  /**
   * 任务结束后延迟做一次轻量复盘。
   * 不在主流程里 await，避免拖慢队列/通知；如果用户马上开始了下一轮，直接跳过。
   */
  private scheduleEvolutionReview(active: ActiveRun, providerKind: ProviderConfig['kind']): void {
    if (providerKind === 'demo' || active.demo || active.internal || active.unattended) return
    if (!this.settingsStore.get().evolutionEnabled) return
    if (this.evolutionTimers.has(active.sessionId)) return
    const timer = setTimeout(() => {
      this.evolutionTimers.delete(active.sessionId)
      const session = this.sessionStore.get(active.sessionId)
      if (!session || session.temporary || session.demo || session.planMode === true) return
      if (this.isSessionRunning(active.sessionId) || this.compactingSessions.has(active.sessionId)) return
      void this.reviewEvolution(active.sessionId, false)
        .then((result) => {
          if (result.suggestions.length > 0) {
            log.info('evolution suggestions created', {
              sessionId: active.sessionId,
              count: result.suggestions.length,
              created: result.created
            })
          }
        })
        .catch((err) => {
          log.warn('automatic evolution review failed', {
            sessionId: active.sessionId,
            error: err instanceof Error ? err.message : String(err)
          })
        })
    }, 1_200)
    timer.unref?.()
    this.evolutionTimers.set(active.sessionId, timer)
  }

  /**
   * 复盘一个对话并生成建议。手工复盘允许在关闭自动复盘时使用；
   * 自动复盘仍受信号、冷却时间与待处理数量限制。
   */
  async reviewEvolution(
    sessionId: string,
    manual: boolean
  ): Promise<import('./evolution-service').EvolutionReviewOutcome> {
    const service = getEvolutionService()
    const skip = (
      reason: import('../../shared/memory').EvolutionSkipReason,
      message?: string
    ): import('./evolution-service').EvolutionReviewOutcome => ({
      suggestions: [],
      created: 0,
      reviewedAt: service?.lastReviewedAt() ?? null,
      skipped: reason,
      message: message ?? EVOLUTION_SKIP_LABEL[reason]
    })
    if (!service) return skip('no-model', '自进化服务尚未初始化。')
    if (!manual && !this.settingsStore.get().evolutionEnabled) return skip('disabled')
    const session = this.sessionStore.get(sessionId)
    if (!session) return skip('no-session')
    if (session.temporary) return skip('temporary')
    if (session.demo) return skip('demo')
    if (this.isSessionRunning(sessionId)) return skip('running')
    let resolved: ReturnType<typeof this.resolveModel>
    try {
      resolved = this.resolveModel(session.model)
    } catch (err) {
      return skip('no-model', err instanceof Error ? err.message : '还没有连接可用的模型')
    }
    if (resolved.config.kind === 'demo') return skip('demo')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45_000)
    timer.unref?.()
    try {
      const result = await service.review({
        session,
        provider: resolved.provider,
        model: resolved.modelInfo,
        signal: controller.signal,
        manual
      })
      if (result.usage && !session.temporary) {
        recordTokenUsage({
          sessionId,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens ?? 0
        })
      }
      if (!result.skipped) {
        sendFeatureEvent(EVOLUTION_CHANGED_EVENT, {
          reason: 'reviewed',
          sessionId,
          pending: service.pendingCount(),
          created: result.created
        })
      }
      return result
    } catch (err) {
      if (controller.signal.aborted) {
        return skip('timeout')
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /** 首次运行结束时兜底命名：覆盖排队、目标/计划等未能走普通发送路径的会话。 */
  private ensureAutoTitle(session: Session): void {
    if (!this.settingsStore.get().autoTitle) return
    const first = session.messages.find((message) => message.role === 'user' && !message.hidden)
    if (!first) return
    const before = session.title
    this.sessionStore.autoName(session, userMessageDisplayText(first))
    if (session.title !== before) this.sessionStore.save(session)
  }

  private updateTaskbar(): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) return
    try {
      win.setProgressBar(this.runs.size > 0 ? 2 : -1)
    } catch {
      // 某些平台不支持进度条
    }
  }

  /**
   * 系统通知：仅在窗口不在前台时提示；点击聚焦窗口并切到对应会话。
   * 完成通知受「任务完成时通知我」开关控制；审批/提问属于需要立即处理的动作，不受该开关影响。
   */
  private notifyUser(active: ActiveRun, title: string, body: string, force = false): void {
    if (this.deletedSessions.has(active.sessionId)) return
    const settings = this.settingsStore.get()
    if ((!settings.notifyOnFinish && !force) || active.demo) return
    const win = active.window
    if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) return
    try {
      win?.flashFrame(true)
    } catch {
      // ignore
    }
    if (!Notification.isSupported()) return
    try {
      const notification = new Notification({ title, body, silent: false })
      notification.on('click', () => {
        const target = active.window
        if (target && !target.isDestroyed()) {
          if (target.isMinimized()) target.restore()
          target.show()
          target.focus()
          target.flashFrame(false)
          target.webContents.send(FOCUS_SESSION_CHANNEL, active.sessionId)
        }
      })
      notification.show()
    } catch (err) {
      log.warn('notification failed', { error: String(err) })
    }
  }

  private notifyRunFinished(active: ActiveRun, result: RunAgentResult, session: Session | null): void {
    const title = session?.title ?? 'Morrow'
    if (result.reason === 'complete') {
      this.notifyUser(active, '任务完成', `《${title}》本轮已完成。`)
    } else if (result.reason === 'error') {
      this.notifyUser(active, '任务没有完成', `《${title}》执行出错，打开 Morrow 查看原因。`)
    }
  }

  /** 轮末钩子：观察型，不阻塞后续调度；失败以轻量提示告知。 */
  private runFinishHooks(active: ActiveRun, result: RunAgentResult): void {
    const last = result.messages.at(-1)
    const finalText = last
      ? last.content
          .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .slice(0, 2000)
      : ''
    void runHooks(
      'run_finished',
      {
        event: 'run_finished',
        sessionId: active.sessionId,
        workspace: active.workspace,
        reason: result.reason,
        finalText,
        usage: result.usage
      },
      active.workspace
    )
      .then((results) => {
        const failed = results.find(
          (item) => item.timedOut || (item.exitCode !== null && item.exitCode !== 0)
        )
        if (!failed) return
        const detail = `${failed.stdout}\n${failed.stderr}`
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .join(' ')
          .slice(0, 300)
        this.forward(
          {
            seq: 0,
            runId: active.runId,
            sessionId: active.sessionId,
            at: Date.now(),
            type: 'notice',
            level: 'warn',
            message: detail ? `运行钩子失败：${detail}` : `运行钩子失败（退出码 ${failed.exitCode ?? '超时'}）。`
          },
          active.window
        )
      })
      .catch((err) => {
        log.warn('run_finished hooks failed', { error: err instanceof Error ? err.message : String(err) })
      })
  }

  private cleanupRun(active: ActiveRun): void {
    if (active.incrementalTimer) clearTimeout(active.incrementalTimer)
    this.runs.delete(active.runId)
    this.updateTaskbar()
    for (const [id, pending] of this.permissions) {
      if (pending.sessionId === active.sessionId) {
        pending.resolve('deny')
        this.permissions.delete(id)
      }
    }
    for (const [id, pending] of this.questions) {
      if (pending.sessionId === active.sessionId) {
        pending.resolve({ value: 'cancelled', label: '已取消' })
        this.questions.delete(id)
      }
    }
  }
}

let instance: AgentService | null = null
export function getAgentService(settingsStore: SettingsStore, sessionStore: SessionStore): AgentService {
  if (!instance) instance = new AgentService(settingsStore, sessionStore)
  return instance
}
