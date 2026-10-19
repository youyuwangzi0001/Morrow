import { BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AskUserAnswer,
  AskUserRequest,
  Attachment,
  ChatImage,
  ChatMessage,
  Goal,
  ModelInfo,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  ProviderConfig,
  RuntimeEvent,
  SendMessageInput,
  SendMessageResult,
  Session,
  SessionMeta,
  SessionMode,
  ToolUseBlock
} from '../../shared/types'
import { EVENT_CHANNEL } from '../../shared/ipc'
import { dataPath } from './paths'
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
import { buildSystemPrompt, compactSession, createProvider, estimateContextUsage, runAgent, type RunAgentResult } from '@core/index'

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
function clampBudget(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.max(min, Math.min(max, number))
}

interface ActiveRun {
  runId: string
  sessionId: string
  controller: AbortController
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
  incrementalTimer: ReturnType<typeof setTimeout> | null
  lastIncrementalAt: number
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

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly sessionStore: SessionStore
  ) {}

  isSessionRunning(sessionId: string): boolean {
    if (this.goalLoops.has(sessionId)) return true
    for (const run of this.runs.values()) if (run.sessionId === sessionId) return true
    return false
  }

  async send(input: SendMessageInput, window: BrowserWindow | null): Promise<SendMessageResult> {
    const session = this.sessionStore.get(input.sessionId)
    if (!session) throw new Error('会话不存在，请新建对话。')
    if (this.isSessionRunning(session.id)) throw new Error('这个对话正在运行，等它完成或先停止。')
    return this.startRun(session, input, window)
  }

  /** 启动一轮 Agent 运行（普通消息与目标模式续跑共用）。 */
  private startRun(session: Session, input: SendMessageInput, window: BrowserWindow | null): SendMessageResult {
    const resolved = this.resolveProvider(session, input)
    const userMessage = this.buildUserMessage(input)
    session.messages.push(userMessage)
    this.sessionStore.autoName(session, input.text)
    this.sessionStore.save(session)

    const runId = `run_${randomUUID().slice(0, 12)}`
    const assistantMessageId = `msg_${randomUUID().slice(0, 12)}`
    const controller = new AbortController()
    const goal = session.goal
    // 显式会话模式：缺省 = work（兼容旧会话文件）。聊天模式下工具只读 + 权限层硬拦截。
    const sessionMode: SessionMode = session.mode === 'chat' ? 'chat' : 'work'
    const active: ActiveRun = {
      runId,
      sessionId: session.id,
      controller,
      startedAt: Date.now(),
      window,
      demo: resolved.config.kind === 'demo',
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
      incrementalTimer: null,
      lastIncrementalAt: 0
    }
    this.runs.set(runId, active)

    const history = session.messages.slice(0, -1)
    const projectContext = getProjectPrompt(session.workspace) || this.readProjectMemory(session.workspace)
    const snapshotDir = dataPath('snapshots', session.id)
    if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true })
    const isDemo = resolved.config.kind === 'demo'
    const systemPrompt = buildSystemPrompt({
      workspace: session.workspace,
      permissionMode: session.permissionMode,
      mode: sessionMode,
      platform: process.platform,
      projectContext,
      modelLabel: resolved.modelInfo.label,
      demo: isDemo,
      goal: sessionMode === 'work' && goal?.status === 'active' ? goal : null,
      tools: undefined
    })

    void (async () => {
      try {
        const result = await runAgent({
          runId,
          sessionId: session.id,
          provider: resolved.provider,
          model: resolved.modelInfo,
          systemPrompt,
          history,
          userMessage,
          workspace: session.workspace,
          permissionMode: session.permissionMode,
          mode: sessionMode,
          projectContext,
          snapshotDir,
          signal: controller.signal,
          maxSteps: 60,
          autoCompact: this.settingsStore.get().autoCompact,
          compactThreshold: this.settingsStore.get().compactThreshold,
          goal: sessionMode === 'work' && goal?.status === 'active' ? goal : null,
          demo: isDemo,
          initialTodos: session.todos,
          initialArtifacts: session.artifacts,
          emit: (event: RuntimeEvent) => this.handleRuntimeEvent(active, event, window),
          onPermission: (request) => this.awaitPermission(active, request),
          onAskUser: (request) => this.awaitQuestion(active, request)
        })
        this.persistResult(active, result)
        await this.afterRun(active, result, window)
      } catch (err) {
        log.error('agent run crashed', { runId, error: err instanceof Error ? err.message : String(err) })
        const message = err instanceof Error ? err.message : '执行出错'
        this.onRunFailure(active)
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
      }
    })()

    return { runId, userMessage, assistantMessageId }
  }

  async compact(sessionId: string, window: BrowserWindow | null): Promise<{ compacted: boolean; savedTokens: number; messageCount: number; reason?: string }> {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error('会话不存在，请新建对话。')
    if (this.isSessionRunning(sessionId)) throw new Error('这个对话正在运行，先停止或等它完成。')
    if (session.messages.length < 4) throw new Error('对话还很短，暂时不需要压缩。')
    const resolved = this.resolveModel(session.model)
    const projectContext = getProjectPrompt(session.workspace) || this.readProjectMemory(session.workspace)
    const systemPrompt = buildSystemPrompt({
      workspace: session.workspace,
      permissionMode: session.permissionMode,
      mode: session.mode === 'chat' ? 'chat' : 'work',
      platform: process.platform,
      projectContext,
      modelLabel: resolved.modelInfo.label,
      tools: undefined
    })
    const controller = new AbortController()
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
      if (result.error) throw new Error(result.error.message)
      if (result.compacted) {
        session.messages = result.messages
        const context = estimateContextUsage(result.messages, systemPrompt, resolved.modelInfo.contextWindow)
        session.usage = {
          ...session.usage,
          contextUsed: context.used,
          contextLimit: context.limit
        }
        this.sessionStore.save(session)
        this.forward({ seq: 0, runId: 'compact', sessionId, at: Date.now(), type: 'compaction', phase: 'finished', savedTokens: result.savedTokens }, window)
        this.forward({ seq: 0, runId: 'compact', sessionId, at: Date.now(), type: 'usage_updated', usage: session.usage }, window)
        this.forward({ seq: 0, runId: 'compact', sessionId, at: Date.now(), type: 'session_updated', meta: deriveMeta(session) }, window)
      } else {
        this.forward({ seq: 0, runId: 'compact', sessionId, at: Date.now(), type: 'compaction', phase: 'finished', savedTokens: 0 }, window)
      }
      return {
        compacted: result.compacted,
        savedTokens: result.savedTokens,
        messageCount: session.messages.length,
        ...(result.reason ? { reason: result.reason } : {})
      }
    } catch (err) {
      this.forward({ seq: 0, runId: 'compact', sessionId, at: Date.now(), type: 'compaction', phase: 'finished', savedTokens: 0 }, window)
      throw err
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
    const next: SessionMode = mode === 'chat' ? 'chat' : 'work'
    if ((session.mode ?? 'work') === next) return deriveMeta(session)
    if (this.isSessionRunning(sessionId)) throw new Error('这个对话正在运行：先停止本次运行，再切换模式。')
    session.mode = next
    this.sessionStore.save(session)
    if (next === 'chat' && session.goal?.status === 'active') {
      this.pauseGoalInternal(
        session,
        window,
        'user_paused',
        '已切换到聊天模式，目标自动暂停；切回工作模式后可手动继续。'
      )
    }
    log.info('session mode changed', { sessionId, mode: next })
    return deriveMeta(session)
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

  private abortSession(sessionId: string): void {
    for (const run of this.runs.values()) {
      if (run.sessionId === sessionId) run.controller.abort()
    }
  }

  /** 核心 update_goal 工具事件：把目标变更落库后转发给渲染层。 */
  private guardFor(sessionId: string): SensitiveGuard {
    let guard = this.sensitiveGuards.get(sessionId)
    if (!guard) {
      guard = new SensitiveGuard()
      this.sensitiveGuards.set(sessionId, guard)
    }
    return guard
  }

  private handleRuntimeEvent(active: ActiveRun, event: RuntimeEvent, window: BrowserWindow | null): void {
    const guard = this.guardFor(active.sessionId)
    // 先登记工具结果中的敏感值，再对用户可见输出做遮蔽
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
          }
        }
        this.scheduleIncrementalSave(active, event.denied === true || event.interrupted === true || event.result.ok === false)
        break
      }
      case 'artifacts_updated': {
        if (event.artifacts.length > active.baselineArtifacts) active.roundProgressActions += 1
        break
      }
      case 'todos_updated': {
        const completedNow = event.todos.filter((todo) => todo.status === 'completed').length
        if (completedNow > active.baselineCompletedTodos) active.roundProgressActions += 1
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
      const latest = this.sessionStore.get(active.sessionId)
      const current = latest?.goal
      if (!latest || !current || current.status !== 'active' || !this.goalLoops.has(session.id)) return
      if (this.runs.has(active.runId)) return
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
    const text = objective.trim()
    if (!text) throw new Error('请先写下目标。')
    if ((session.mode ?? 'work') === 'chat') {
      throw new Error('聊天模式下不能建立目标：请先把输入框旁的「聊天 / 工作」切到「工作」。')
    }
    if (this.isSessionRunning(sessionId)) throw new Error('这个对话正在运行，等它完成或先停止。')
    // R7 审计：默认由系统按目标复杂度智能估算轮次（最高 200 轮），用户不需要手动设置；
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
    const result = this.startRun(
      session,
      {
        sessionId,
        text: `开始执行目标：\n${goal.objective}\n\n请先规划并推进第一轮。每轮结束调用 update_goal 记录 summary 与 nextStep；目标完成时标记 completed（必须提供 evidence），无法继续时标记 blocked。`
      },
      window
    )
    return { goal, runId: result.runId }
  }

  pauseGoal(sessionId: string, window: BrowserWindow | null): { goal: Goal | null } {
    const session = this.sessionStore.get(sessionId)
    if (!session?.goal) throw new Error('当前对话没有目标。')
    if (session.goal.status === 'active') {
      session.goal.status = 'paused'
      session.goal.stopReason = 'user_paused'
      // 保留已有进度摘要（旧实现会覆盖成「已手动暂停」，丢失进度）
      session.goal.updatedAt = Date.now()
    }
    this.goalLoops.delete(sessionId)
    this.saveGoal(session, session.goal)
    this.abortSession(sessionId)
    this.emitGoal(session, window)
    return { goal: session.goal }
  }

  resumeGoal(sessionId: string, window: BrowserWindow | null): { goal: Goal; runId: string } {
    const session = this.sessionStore.get(sessionId)
    const goal = session?.goal
    if (!session || !goal) throw new Error('当前对话没有目标。')
    if ((session.mode ?? 'work') === 'chat') {
      throw new Error('聊天模式下不能继续目标：请先把输入框旁的「聊天 / 工作」切到「工作」。')
    }
    if (goal.status !== 'paused' && goal.status !== 'blocked') {
      throw new Error('只有已暂停或已阻塞的目标可以继续。')
    }
    if (this.isSessionRunning(sessionId)) throw new Error('这个对话正在运行，等它完成或先停止。')
    if (goal.round >= GOAL_MAX_ROUNDS) {
      throw new Error(`已达到总轮次上限 ${GOAL_MAX_ROUNDS} 轮，请结束目标后重新建立一个新的目标。`)
    }
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
    goal.updatedAt = Date.now()
    this.saveGoal(session, goal)
    this.goalLoops.add(session.id)
    this.emitGoal(session, window)
    const result = this.startRun(session, { sessionId, text: this.buildGoalContinuation(goal) }, window)
    return { goal, runId: result.runId }
  }

  /** 用户手动结束目标：记为「已取消」（cancelled），绝不记为 completed */
  stopGoal(sessionId: string, window: BrowserWindow | null): { goal: Goal | null } {
    const session = this.sessionStore.get(sessionId)
    if (!session?.goal) throw new Error('当前对话没有目标。')
    session.goal.status = 'cancelled'
    session.goal.stopReason = 'user_stopped'
    session.goal.cancelledAt = Date.now()
    session.goal.updatedAt = Date.now()
    this.goalLoops.delete(sessionId)
    this.saveGoal(session, session.goal)
    this.abortSession(sessionId)
    this.emitGoal(session, window)
    return { goal: session.goal }
  }

  clearGoal(sessionId: string, window: BrowserWindow | null): { goal: null } {
    const session = this.sessionStore.get(sessionId)
    if (!session) throw new Error('会话不存在。')
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
    this.runs.clear()
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
  ): { provider: ReturnType<typeof createProvider>; config: ProviderConfig; modelId: string; modelInfo: ModelInfo } {
    return this.resolveModel(input.model ?? session.model)
  }

  private resolveModel(
    modelRef: Session['model']
  ): { provider: ReturnType<typeof createProvider>; config: ProviderConfig; modelId: string; modelInfo: ModelInfo } {
    const settings = this.settingsStore.get()
    const config = settings.providers.find((p) => p.id === modelRef.providerId)
    if (!config) throw new Error('找不到这个模型提供方，请到设置里重新连接。')
    const modelInfo =
      config.models.find((m) => m.id === modelRef.modelId) ?? config.models[0] ?? null
    if (!modelInfo) throw new Error('这个提供方还没有可用模型，请到设置里添加。')
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
      modelInfo
    }
  }

  private buildUserMessage(input: SendMessageInput): ChatMessage {
    const parts: string[] = [input.text.trim()]
    const images: ChatImage[] = []
    for (const attachment of input.attachments ?? []) {
      if (attachment.kind === 'image' && typeof attachment.content === 'string') {
        const parsed = parseDataUrl(attachment.content)
        if (parsed) {
          images.push(parsed)
          parts.push(this.attachmentBlock(attachment, true))
          continue
        }
      }
      parts.push(this.attachmentBlock(attachment, false))
    }
    return {
      id: `msg_${randomUUID().slice(0, 12)}`,
      role: 'user',
      content: [{ type: 'text', text: parts.join('\n\n') }],
      createdAt: Date.now(),
      ...(images.length > 0 ? { images } : {})
    }
  }

  private attachmentBlock(attachment: Attachment, imageSent: boolean): string {
    const header = `[附件] ${attachment.name}（${this.humanSize(attachment.size)}${attachment.path ? `，路径：${attachment.path}` : ''}）`
    if (attachment.kind === 'image') {
      return imageSent
        ? `${header}：图片已作为视觉输入附在本条消息里，请直接看图回答，不要靠文件名猜内容。`
        : `${header}：图片未能读取（过大或格式不支持），不要猜测图片内容；可以请用户重新提供更小的图片。`
    }
    if (attachment.content) {
      const body = attachment.truncated ? `${attachment.content}\n…（内容过长，已截断）` : attachment.content
      return `${header}\n\`\`\`\n${body}\n\`\`\``
    }
    return `${header}：非文本文件，无法直接内联。需要时可以用 read_file 工具读取。`
  }

  private humanSize(bytes: number): string {
    if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    if (bytes > 1024) return `${Math.round(bytes / 1024)} KB`
    return `${bytes} B`
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
    const safeMessages = result.messages.map((message) => guard.redactMessage(message))
    const saved = this.sessionStore.applyRunResult(session, {
      messages: safeMessages,
      todos,
      artifacts: result.artifacts,
      usage: result.usage
    })
    const meta = deriveMeta(saved)
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
        type: 'session_updated',
        meta
      },
      active.window
    )
    log.info('run persisted', {
      runId: active.runId,
      reason: result.reason,
      messages: result.messages.length,
      durationMs: Date.now() - active.startedAt
    })
  }

  private cleanupRun(active: ActiveRun): void {
    if (active.incrementalTimer) clearTimeout(active.incrementalTimer)
    this.runs.delete(active.runId)
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

/** data:image/png;base64,xxx → { mediaType, dataBase64 }（模型只接受 base64 数据） */
function parseDataUrl(dataUrl: string): ChatImage | null {
  const match = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(dataUrl.trim())
  if (!match) return null
  const mediaType = match[1].toLowerCase()
  if (!/^image\/(png|jpe?g|webp|gif|bmp)$/.test(mediaType)) return null
  return { mediaType, dataBase64: match[2] }
}

let instance: AgentService | null = null
export function getAgentService(settingsStore: SettingsStore, sessionStore: SessionStore): AgentService {
  if (!instance) instance = new AgentService(settingsStore, sessionStore)
  return instance
}
