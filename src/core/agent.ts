/**
 * Agent 运行时：一次用户输入 → 完整「思考 → 工具 → 回答」循环。
 *
 * 事件语义（与 src/shared/types.ts 的 RuntimeEvent 对齐）：
 * - run_started（携带 userMessage 与首个 assistantMessageId）→ 每个模型回合：
 *   message_started → N×message_delta → message_completed；
 * - 工具：tool_started（status='waiting'）→ [permission_requested → permission_resolved]
 *   → tool_progress(status='running') → 执行 → tool_finished；
 * - 中断：优雅收尾，给未完成的 tool_use 回填 interrupted 结果，assistant 消息带 interrupted=true；
 * - 结束：run_finished（complete / cancelled / error / max-steps）。
 *
 * 本模块不 import electron / react；provider / 工具实现均可注入，便于单测。
 */
import type {
  Artifact,
  AskUserAnswer,
  AskUserRequest,
  ChatMessage,
  Goal,
  ModelInfo,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  ResultError,
  RunFinishReason,
  RuntimeEvent,
  SessionMode,
  ThinkingBlock,
  TextBlock,
  TodoItem,
  ToolStatus,
  ToolResult,
  ToolUseBlock,
  Usage
} from '../shared/types'
import {
  addUsage,
  applyCompaction,
  estimateMessagesTokens,
  localExtractSummary,
  planCompaction,
  serializeMessagesForSummary
} from './context'
import { buildChatModePromptSection, buildGoalPromptSection, buildSystemPrompt } from './prompt'
import { validateGoalEvidence } from './tools/meta-tools'
import {
  deniedMessage,
  evaluatePermission,
  isChatModeToolAllowed,
  type PermissionGate,
  type PermissionPolicyContext,
  type PermissionTarget
} from './permissions'
import type {
  GoalPatch,
  Provider,
  ProviderStreamRequest,
  RuntimeEventPayload,
  SubagentRequest,
  SubagentResult,
  ToolContext,
  ToolDefinition
} from './types'
import { ProviderError, toProviderError } from './providers/types'
import {
  GOAL_TOOL_DEFINITION,
  READ_ONLY_TOOL_DEFINITIONS,
  TOOL_DEFINITIONS,
  executeTool,
  toolCategory,
  toolDefinitionsForRun,
  toolRiskFor,
  toolTitleFor
} from './tools/registry'
import {
  abortable,
  abortError,
  errorMessage,
  isAbortError,
  iterateWithAbort,
  newId,
  parseToolArgs,
  truncateText
} from './util'

/* ── 公共契约 ─────────────────────────────────────────────────── */

export interface RunAgentOptions {
  runId: string
  sessionId: string
  provider: Provider
  model: ModelInfo
  systemPrompt: string
  /** 已持久化的历史（含此前的 tool_use+result） */
  history: ChatMessage[]
  /** 本次用户消息（已含 attachments 文本） */
  userMessage: ChatMessage
  /** 绝对路径；null 表示未绑定工作区 */
  workspace: string | null
  permissionMode: PermissionMode
  /**
   * 显式会话模式（审计报告第 5 项）：
   * - chat：只暴露只读工具 + ask_user，权限层硬拦截写入/执行/记忆/目标；系统提示注入「只讨论不执行」；
   * - work / 缺省：行为与之前完全一致（按 permissionMode 三档）。
   */
  mode?: SessionMode
  projectMemory?: string
  /** R10：项目指令 + 知识 + 记忆上下文（优先于 projectMemory） */
  projectContext?: string
  /** 写文件前备份旧内容到这里（<snapshotDir>/<toolUseId>/<filename>） */
  snapshotDir: string
  signal: AbortSignal
  emit: (event: RuntimeEvent) => void
  onPermission: (request: PermissionRequest) => Promise<PermissionDecision>
  onAskUser: (request: AskUserRequest) => Promise<AskUserAnswer>
  maxSteps?: number
  demo?: boolean
  /** 是否启用自动上下文压缩（默认 true）；false 时仍可手动 compactSession */
  autoCompact?: boolean
  /** 自动压缩阈值（contextWindow 占比，0.5–0.98，默认 0.8） */
  compactThreshold?: number
  /** 压缩时保留最近多少条消息（默认 8） */
  keepRecent?: number
  /** 会话已有的计划/产物（可选；主进程合并会话状态后传入） */
  initialTodos?: TodoItem[]
  initialArtifacts?: Artifact[]
  /** Goal 模式：存在且 status=active 时注入目标上下文与 update_goal 工具（多轮续跑由主进程循环） */
  goal?: Goal | null
}

export interface RunAgentResult {
  reason: RunFinishReason
  /** 本轮新增的 assistant 消息（tool_use block 的 result 已回填） */
  messages: ChatMessage[]
  usage: Usage
  todos: TodoItem[]
  artifacts: Artifact[]
  /** Goal 模式：本轮结束时的目标状态（含 update_goal 合并结果；非 Goal 模式回显传入值/null） */
  goal?: Goal | null
  error?: ResultError
}

/* ── 会话级「始终允许」记忆 ───────────────────────────────────── */

const sessionGrants = new Map<string, Set<string>>()

function grantsFor(sessionId: string): Set<string> {
  let grants = sessionGrants.get(sessionId)
  if (!grants) {
    grants = new Set<string>()
    sessionGrants.set(sessionId, grants)
  }
  return grants
}

export function getSessionPermissionGrants(sessionId: string): ReadonlySet<string> {
  return sessionGrants.get(sessionId) ?? new Set<string>()
}

export function clearSessionPermissionGrants(sessionId: string): void {
  sessionGrants.delete(sessionId)
}

/** 测试用：清空所有会话的审批记忆 */
export function resetAllPermissionGrants(): void {
  sessionGrants.clear()
}

/* ── 内部状态 ─────────────────────────────────────────────────── */

type EmitPayload = RuntimeEventPayload

/** 事件里传递消息的深拷贝快照：避免主进程延迟序列化时看到后续被回填的 tool result */
function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type !== 'tool_use') return { ...block }
      return {
        ...block,
        input: { ...block.input },
        ...(block.result
          ? {
              result: {
                ...block.result,
                ...(block.result.meta ? { meta: { ...block.result.meta } } : {})
              }
            }
          : {})
      }
    })
  }
}

interface RunContext {
  opts: RunAgentOptions
  emit: (payload: EmitPayload) => void
  /** 工作副本：history + 本轮 user + 新增 assistant */
  messages: ChatMessage[]
  newMessages: ChatMessage[]
  todos: TodoItem[]
  artifacts: Artifact[]
  systemPrompt: string
  tools: ToolDefinition[]
  effectiveMode: PermissionMode
  demo: boolean
  depth: number
  readOnly: boolean
  grants: Set<string>
  usage: Usage
  requestUsage: Usage
  /** 最近一次 provider 请求的真实 usage（contextUsed 精确值来源）；null = 尚无 usage，回退估算 */
  lastRequestUsage: Usage | null
  /** Goal 模式当前目标（update_goal 会合并更新；null = 非目标模式） */
  currentGoal: Goal | null
  lastMessage?: ChatMessage
  interruptFinalized: boolean
  /** 本会话已出现过的 tool_use id：保证跨回合/跨 run 唯一（快照目录、UI 定位都依赖它） */
  usedToolUseIds: Set<string>
  /** 工具参数解析失败（如输出被截断）的 tool_use id → 错误原因，执行前转成可自修复的工具错误 */
  toolParseErrors: Map<string, string>
  /** 审批/提问串行链：并行子代理不能同时弹出多个审批卡 */
  permissionChain: Promise<void>
}

const DEFAULT_MAX_STEPS = 60
const MAX_ALLOWED_STEPS = 200
const SUBAGENT_MAX_STEPS = 12
const SUBAGENT_MAX_OUTPUT = 4096
const DEFAULT_COMPACT_THRESHOLD = 0.8
const MIN_COMPACT_THRESHOLD = 0.5
const MAX_COMPACT_THRESHOLD = 0.98
const DEFAULT_KEEP_RECENT = 8

function clampThreshold(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_COMPACT_THRESHOLD
  return Math.min(MAX_COMPACT_THRESHOLD, Math.max(MIN_COMPACT_THRESHOLD, value))
}

function clampKeepRecent(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_KEEP_RECENT
  return Math.min(50, Math.max(2, Math.trunc(value)))
}

function createEmitter(opts: RunAgentOptions): (payload: EmitPayload) => void {
  let seq = 0
  return (payload) => {
    seq += 1
    opts.emit({ ...payload, seq, runId: opts.runId, sessionId: opts.sessionId, at: Date.now() } as RuntimeEvent)
  }
}

function clampSteps(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return DEFAULT_MAX_STEPS
  return Math.min(MAX_ALLOWED_STEPS, Math.max(1, Math.trunc(value)))
}

function normalizeOptions(options: RunAgentOptions): RunAgentOptions {
  return {
    ...options,
    history: options.history ?? [],
    mode: options.mode === 'chat' ? 'chat' : 'work',
    maxSteps: clampSteps(options.maxSteps),
    autoCompact: options.autoCompact !== false,
    compactThreshold: clampThreshold(options.compactThreshold),
    keepRecent: clampKeepRecent(options.keepRecent)
  }
}

function resolveSystemPrompt(
  opts: RunAgentOptions,
  tools: ToolDefinition[],
  mode: PermissionMode,
  goal: Goal | null
): string {
  const chatMode = opts.mode === 'chat'
  const base = opts.systemPrompt?.trim() ?? ''
  let prompt =
    base.length > 0
      ? base
      : buildSystemPrompt({
          workspace: opts.workspace,
          permissionMode: mode,
          mode: opts.mode,
          projectContext: opts.projectContext ?? opts.projectMemory,
          modelLabel: opts.model.label,
          demo: opts.demo,
          tools,
          readOnly: false,
          goal
        })
  const memory = (opts.projectContext ?? opts.projectMemory)?.trim()
  if (memory) {
    const fingerprint = memory.slice(0, Math.min(48, memory.length))
    if (!prompt.includes(fingerprint)) prompt += `\n\n## 项目记忆\n${memory}`
  }
  // 聊天模式：主进程可能自己构建了 systemPrompt；缺「聊天模式」段时由内核补上，
  // 保证工具被过滤的同时，模型也明确知道当前只讨论、不执行。
  if (chatMode && !prompt.includes('## 聊天模式')) {
    prompt += `\n\n${buildChatModePromptSection()}`
  }
  // 主进程可能自己构建了 systemPrompt：goal 段缺失时由 Agent 补上，避免目标上下文丢失
  if (!chatMode && goal && goal.status === 'active' && !prompt.includes('## 目标模式')) {
    prompt += `\n\n${buildGoalPromptSection(goal)}`
  }
  return prompt
}

/**
 * 当前用量快照。
 * contextUsed 优先取「最近一次 provider 请求的真实 usage（inputTokens + outputTokens）」，
 * 与 API 账单口径一致；只有在完全没有 usage（例如本地 Provider 不返回）时才回退到估算。
 */
function currentUsage(ctx: RunContext): Usage {
  const request = ctx.requestUsage
  const inputTokens = ctx.usage.inputTokens + request.inputTokens
  const outputTokens = ctx.usage.outputTokens + request.outputTokens
  const cacheRead = (ctx.usage.cacheReadTokens ?? 0) + (request.cacheReadTokens ?? 0)
  const contextUsed = ctx.lastRequestUsage
    ? ctx.lastRequestUsage.inputTokens + ctx.lastRequestUsage.outputTokens
    : estimateMessagesTokens(ctx.messages, ctx.systemPrompt)
  return {
    inputTokens,
    outputTokens,
    contextUsed,
    contextLimit: ctx.opts.model.contextWindow,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {})
  }
}

function commitRequestUsage(ctx: RunContext): void {
  const request = ctx.requestUsage
  if (request.inputTokens || request.outputTokens || request.cacheReadTokens) {
    ctx.usage = addUsage(ctx.usage, request)
    // 该次请求观察到了真实 usage：作为 contextUsed 的精确来源
    ctx.lastRequestUsage = {
      inputTokens: request.inputTokens,
      outputTokens: request.outputTokens,
      ...(typeof request.cacheReadTokens === 'number' ? { cacheReadTokens: request.cacheReadTokens } : {})
    }
  }
  ctx.requestUsage = { inputTokens: 0, outputTokens: 0 }
}

function pushAssistant(ctx: RunContext, message: ChatMessage): void {
  ctx.messages.push(message)
  ctx.newMessages.push(message)
  ctx.lastMessage = message
}

/** 收集已有历史里的 tool_use id，避免 provider 复用 id 造成快照/UI 定位冲突 */
function collectToolUseIds(messages: ChatMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id) ids.add(block.id)
    }
  }
  return ids
}

/** 给工具调用分配唯一 id（provider 复用/空 id 时重新生成） */
function allocateToolUseId(ctx: RunContext, requested: string): string {
  const id = requested && !ctx.usedToolUseIds.has(requested) ? requested : newId('call')
  ctx.usedToolUseIds.add(id)
  return id
}

function toResultError(err: unknown): ResultError {
  if (err instanceof ProviderError) return err.toResultError()
  if (isAbortError(err)) return { code: 'aborted', message: '本轮运行已中断。', retryable: false }
  return { code: 'agent_error', message: errorMessage(err) }
}

/* ── 对外主入口 ───────────────────────────────────────────────── */

export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const opts = normalizeOptions(options)
  const emit = createEmitter(opts)
  const chatMode = opts.mode === 'chat'
  // 聊天模式不启用 Goal：即使主进程误传了 active 目标，内核也不注入 update_goal / 目标提示。
  const initialGoal = !chatMode && opts.goal ? { ...opts.goal } : null
  const goalMode = Boolean(initialGoal && initialGoal.status === 'active')
  const runTools = toolDefinitionsForRun(goalMode)
  const tools = chatMode
    ? runTools.filter((definition) => isChatModeToolAllowed(definition.name, definition.category))
    : runTools
  const effectiveMode: PermissionMode = opts.demo ? 'auto' : chatMode ? 'read-only' : opts.permissionMode
  const contextLimit = opts.model.contextWindow
  const ctx: RunContext = {
    opts,
    emit,
    messages: [...opts.history, opts.userMessage],
    newMessages: [],
    todos: [...(opts.initialTodos ?? [])],
    artifacts: [...(opts.initialArtifacts ?? [])],
    systemPrompt: resolveSystemPrompt(opts, tools, effectiveMode, initialGoal),
    tools,
    effectiveMode,
    demo: opts.demo === true,
    depth: 0,
    readOnly: false,
    grants: grantsFor(opts.sessionId),
    usage: { inputTokens: 0, outputTokens: 0, contextUsed: estimateMessagesTokens([], ''), contextLimit },
    requestUsage: { inputTokens: 0, outputTokens: 0 },
    lastRequestUsage: null,
    currentGoal: initialGoal,
    interruptFinalized: false,
    usedToolUseIds: collectToolUseIds([...opts.history, opts.userMessage]),
    toolParseErrors: new Map<string, string>(),
    permissionChain: Promise.resolve()
  }
  try {
    return await executeRun(ctx)
  } catch (err) {
    // 兜底：executeRun 里已经尽量吞错，这里只防止编程错误把整个主进程调用炸掉
    const resultError = toResultError(err)
    const fallbackUsage = currentUsage(ctx)
    try {
      emit({ type: 'error', error: resultError })
      emit({ type: 'usage_updated', usage: fallbackUsage })
      emit({ type: 'run_finished', reason: 'error', usage: fallbackUsage })
    } catch {
      // emit 本身失败时无能为力
    }
    return {
      reason: 'error',
      messages: ctx.newMessages,
      usage: fallbackUsage,
      todos: ctx.todos,
      artifacts: ctx.artifacts,
      goal: ctx.currentGoal,
      error: resultError
    }
  }
}

async function executeRun(ctx: RunContext): Promise<RunAgentResult> {
  const { opts } = ctx
  let reason: RunFinishReason = 'error'
  let runError: ResultError | undefined
  const firstAssistantId = newId('msg')
  ctx.emit({ type: 'run_started', userMessage: opts.userMessage, assistantMessageId: firstAssistantId })

  try {
    if (opts.signal.aborted) {
      const message = createPlainMessage(ctx, firstAssistantId, '（本轮运行在开始前已被停止）', true)
      ctx.emit({ type: 'message_started', messageId: message.id, role: 'assistant' })
      pushAssistant(ctx, message)
      ctx.emit({ type: 'message_completed', messageId: message.id, message: cloneMessage(message) })
      reason = 'cancelled'
    } else {
      const outcome = await runLoop(ctx, firstAssistantId)
      reason = outcome.reason
      runError = outcome.error
    }
  } catch (err) {
    if (isAbortError(err) || opts.signal.aborted) {
      finalizeInterrupted(ctx)
      reason = 'cancelled'
    } else {
      runError = toResultError(err)
      ctx.emit({ type: 'error', error: runError })
      reason = 'error'
    }
  }

  const usage = currentUsage(ctx)
  // 保证 UI 最后看到的 usage_updated 与 run_finished 完全一致
  ctx.emit({ type: 'usage_updated', usage })
  ctx.emit({ type: 'run_finished', reason, message: ctx.lastMessage ? cloneMessage(ctx.lastMessage) : undefined, usage })
  return {
    reason,
    messages: ctx.newMessages,
    usage,
    todos: ctx.todos,
    artifacts: ctx.artifacts,
    goal: ctx.currentGoal,
    ...(runError ? { error: runError } : {})
  }
}

interface LoopOutcome {
  reason: RunFinishReason
  error?: ResultError
}

async function runLoop(ctx: RunContext, firstAssistantId: string): Promise<LoopOutcome> {
  const maxSteps = ctx.opts.maxSteps ?? DEFAULT_MAX_STEPS
  let assistantId = firstAssistantId
  let step = 1
  for (;;) {
    if (ctx.opts.signal.aborted) {
      finalizeInterrupted(ctx)
      return { reason: 'cancelled' }
    }
    // 上下文压缩（超过阈值才真正调用摘要模型）
    await maybeCompact(ctx)
    if (ctx.opts.signal.aborted) {
      finalizeInterrupted(ctx)
      return { reason: 'cancelled' }
    }

    const streamed = await streamAssistantStep(ctx, assistantId)
    pushAssistant(ctx, streamed.message)

    if (streamed.interrupted) {
      finalizeInterrupted(ctx)
      return { reason: 'cancelled' }
    }
    if (streamed.error) {
      return { reason: 'error', error: streamed.error }
    }
    if (streamed.toolCalls.length === 0) {
      return { reason: 'complete' }
    }

    const interruptedDuringTools = await executeToolCalls(ctx, streamed.message, streamed.toolCalls)
    if (interruptedDuringTools) {
      finalizeInterrupted(ctx)
      return { reason: 'cancelled' }
    }

    if (step >= maxSteps) {
      ctx.emit({
        type: 'notice',
        level: 'warn',
        message: `已达到单轮最大步数（${maxSteps} 步），本轮先停在这里。可以回复「继续」接着做。`
      })
      await finalizeAtMaxSteps(ctx, maxSteps)
      return { reason: 'max-steps' }
    }
    step += 1
    assistantId = newId('msg')
  }
}

/* ── 模型回合：流式文本 + 工具调用累积 ─────────────────────────── */

interface StreamedStep {
  message: ChatMessage
  toolCalls: ToolUseBlock[]
  interrupted: boolean
  error?: ResultError
}

async function streamAssistantStep(ctx: RunContext, messageId: string): Promise<StreamedStep> {
  const { opts } = ctx
  ctx.emit({ type: 'message_started', messageId, role: 'assistant' })
  const message: ChatMessage = {
    id: messageId,
    role: 'assistant',
    content: [],
    createdAt: Date.now(),
    model: opts.model.id
  }
  let textBlock: TextBlock | null = null
  let thinkingBlock: ThinkingBlock | null = null
  const pendingCalls = new Map<number, { id: string; name: string; args: string }>()

  const ensureText = (): TextBlock => {
    if (!textBlock) {
      textBlock = { type: 'text', text: '' }
      message.content.push(textBlock)
    }
    return textBlock
  }
  const ensureThinking = (): ThinkingBlock => {
    if (!thinkingBlock) {
      thinkingBlock = { type: 'thinking', text: '' }
      message.content.push(thinkingBlock)
    }
    return thinkingBlock
  }

  try {
    const request: ProviderStreamRequest = {
      system: ctx.systemPrompt,
      messages: ctx.messages,
      tools: ctx.tools,
      signal: opts.signal,
      workspace: opts.workspace,
      maxTokens: opts.model.maxOutput
    }
    for await (const event of iterateWithAbort(opts.provider.stream(request), opts.signal)) {
      switch (event.type) {
        case 'text_delta': {
          ensureText().text += event.text
          ctx.emit({ type: 'message_delta', messageId, textDelta: event.text })
          break
        }
        case 'thinking_delta': {
          ensureThinking().text += event.text
          ctx.emit({ type: 'message_delta', messageId, thinkingDelta: event.text })
          break
        }
        case 'tool_call_start': {
          const existing = pendingCalls.get(event.index)
          if (existing) {
            if (!existing.id) existing.id = event.id
            if (!existing.name) existing.name = event.name
          } else {
            pendingCalls.set(event.index, { id: event.id, name: event.name, args: '' })
          }
          break
        }
        case 'tool_call_delta': {
          const existing = pendingCalls.get(event.index)
          if (existing) existing.args += event.argsDelta
          else pendingCalls.set(event.index, { id: newId('call'), name: '', args: event.argsDelta })
          break
        }
        case 'tool_call_end': {
          // 用 end 事件的权威信息建 block（有些网关 start 帧缺 id/name）
          const input = event.input ?? {}
          const toolUseId = allocateToolUseId(ctx, event.id)
          if (event.parseError) ctx.toolParseErrors.set(toolUseId, event.parseError)
          message.content.push({
            type: 'tool_use',
            id: toolUseId,
            name: event.name,
            title: toolTitleFor(event.name, input),
            category: toolCategory(event.name),
            input,
            status: 'waiting'
          })
          pendingCalls.delete(event.index)
          break
        }
        case 'usage': {
          ctx.requestUsage = {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            ...(typeof event.usage.cacheReadTokens === 'number' ? { cacheReadTokens: event.usage.cacheReadTokens } : {})
          }
          // 流式 usage 可能分多次到达（Anthropic: message_start 给 input、message_delta 给 output）
          ctx.lastRequestUsage = { ...ctx.requestUsage }
          ctx.emit({ type: 'usage_updated', usage: currentUsage(ctx) })
          break
        }
        case 'notice': {
          ctx.emit({ type: 'notice', level: event.level, message: event.message })
          break
        }
        case 'demo_step': {
          ctx.emit({ type: 'demo_step', index: event.index, total: event.total, caption: event.caption })
          break
        }
      }
    }

    // 兜底：只发了 start/delta 没有 end 的工具调用，用累积参数补齐
    for (const [index, call] of pendingCalls) {
      if (!call.name) continue
      const parsed = parseToolArgs(call.args)
      const toolUseId = allocateToolUseId(ctx, call.id)
      if (!parsed && call.args) {
        ctx.toolParseErrors.set(toolUseId, '模型输出的工具参数不是合法 JSON（可能因为内容过长被截断）')
      }
      const input = parsed ?? {}
      message.content.push({
        type: 'tool_use',
        id: toolUseId,
        name: call.name,
        title: toolTitleFor(call.name, input),
        category: toolCategory(call.name),
        input,
        status: 'waiting'
      })
      pendingCalls.delete(index)
    }

    commitRequestUsage(ctx)
    if (message.content.length === 0) message.content.push({ type: 'text', text: '（模型没有返回内容）' })
    const toolCalls = message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
    if (toolCalls.length === 0) {
      // 没有工具的回合：在完成事件前再刷新一次 usage，确保 UI 上下文条准确
      ctx.emit({ type: 'usage_updated', usage: currentUsage(ctx) })
    }
    ctx.emit({ type: 'message_completed', messageId, message: cloneMessage(message) })
    return { message, toolCalls, interrupted: false }
  } catch (err) {
    commitRequestUsage(ctx)
    if (isAbortError(err) || opts.signal.aborted) {
      return { message, toolCalls: extractToolCalls(message), interrupted: true }
    }
    const providerError = err instanceof ProviderError ? err : toProviderError(err, 'agent')
    const resultError = providerError.toResultError()
    ctx.emit({ type: 'error', error: resultError })
    message.error = resultError
    if (message.content.length === 0) {
      message.content.push({ type: 'error', message: resultError.message, code: resultError.code })
    }
    ctx.emit({ type: 'message_completed', messageId, message: cloneMessage(message) })
    return { message, toolCalls: [], interrupted: false, error: resultError }
  }
}

function extractToolCalls(message: ChatMessage): ToolUseBlock[] {
  return message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
}

/* ── 工具执行（审批 → 执行） ──────────────────────────────────── */

const INTERRUPTED_RESULT: ToolResult = {
  ok: false,
  output: '',
  error: '执行已中断（用户停止了本轮运行）。',
  meta: { interrupted: true }
}

/* ── 工具执行（审批 → 执行）：主代理与子代理共用同一条链 ─────── */

type ToolCallMode = 'main' | 'subagent'

interface ToolCallRunOptions {
  mode: ToolCallMode
  /** main：父 assistant 消息 id；subagent：父 task 所在的 assistant 消息 id */
  parentMessageId: string
  /** subagent：父 task 的 toolUseId（子代理工具进度挂到父 task 卡片下） */
  parentToolUseId?: string
  /** subagent 的工具上下文覆盖（工作区/snapshot/权限与主代理一致，仅禁止嵌套与改 Goal） */
  toolContextOverrides?: { readOnly?: boolean; depth?: number; goal?: Goal | null; allowSubagent?: boolean }
}

interface ToolCallRunResult {
  interrupted: boolean
  result?: ToolResult
}

/** 审批/提问串行化：多个并行子代理不会同时弹出多个审批卡 */
async function runSerialized<T>(ctx: RunContext, fn: () => Promise<T>): Promise<T> {
  const previous = ctx.permissionChain
  let release: () => void = () => undefined
  ctx.permissionChain = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    await previous.catch(() => undefined)
    return await fn()
  } finally {
    release()
  }
}

function emitSubagentProgress(
  ctx: RunContext,
  runOptions: ToolCallRunOptions,
  note: string,
  status?: ToolStatus,
  title?: string
): void {
  if (runOptions.mode !== 'subagent' || !runOptions.parentToolUseId) return
  ctx.emit({
    type: 'tool_progress',
    messageId: runOptions.parentMessageId,
    toolUseId: runOptions.parentToolUseId,
    note,
    ...(status ? { status } : {}),
    ...(title ? { title } : {})
  })
}

/**
 * 执行单个工具调用（权限判定 → 审批 → 真实执行）。
 * 主代理与子代理共用：子代理与主代理使用同一套 evaluatePermission / onPermission / sessionGrants / 工作区 / snapshot，
 * 区别只在事件呈现：主代理发 tool_started/finished；子代理只发 tool_progress（挂到父 task 卡片），
 * 但 permission_requested/resolved 原样发给父级 UI，由用户在主界面审批。
 */
async function runToolCallWithPermissions(
  ctx: RunContext,
  call: ToolUseBlock,
  runOptions: ToolCallRunOptions
): Promise<ToolCallRunResult> {
  const policy: PermissionPolicyContext = {
    mode: ctx.effectiveMode,
    workspace: ctx.opts.workspace,
    // 子代理拥有与主代理相同的权限链：不再因为 isSubagent 自动放行
    isSubagent: false,
    isDemo: ctx.demo,
    sessionGrants: ctx.grants,
    sessionMode: ctx.opts.mode === 'chat' ? 'chat' : 'work'
  }
  const isMain = runOptions.mode === 'main'
  const emitStarted = (): void => {
    if (isMain) {
      ctx.emit({ type: 'tool_started', messageId: runOptions.parentMessageId, block: { ...call, input: { ...call.input } } })
    } else {
      emitSubagentProgress(ctx, runOptions, `子代理开始：${call.title}`, 'running', call.title)
    }
  }
  const emitFinished = (flags: { denied?: boolean } = {}): void => {
    if (isMain) {
      ctx.emit({
        type: 'tool_finished',
        messageId: runOptions.parentMessageId,
        toolUseId: call.id,
        result: call.result ?? { ok: false, output: '', error: '工具没有返回结果' },
        ...(flags.denied ? { denied: true } : {}),
        ...(call.status === 'interrupted' ? { interrupted: true } : {})
      })
    } else {
      const ok = call.result?.ok === true
      emitSubagentProgress(
        ctx,
        runOptions,
        `子代理：${call.title} ${ok ? '完成' : '失败'}${call.result?.error ? `（${truncateText(call.result.error, 160)}）` : ''}`,
        ok ? 'running' : 'error',
        call.title
      )
    }
  }

  // 模型输出被截断/参数不合法：不发权限、不执行，返回可自修复错误
  const parseError = ctx.toolParseErrors.get(call.id)
  if (parseError) {
    ctx.toolParseErrors.delete(call.id)
    call.startedAt = Date.now()
    call.status = 'waiting'
    emitStarted()
    const result: ToolResult = {
      ok: false,
      output: '',
      error: `工具参数不完整：${parseError}`,
      hint: '请把这次要写的内容拆小后重试：例如 write_file 先写主体骨架，再用 edit_file 或 run_command 追加补全；单次输出过长会被模型长度上限截断。'
    }
    call.result = result
    call.status = 'error'
    call.finishedAt = Date.now()
    emitFinished()
    return { interrupted: false, result }
  }

  const target: PermissionTarget = {
    toolName: call.name,
    category: call.category,
    baseRisk: toolRiskFor(call.name, call.input),
    input: call.input,
    title: call.title
  }
  let gate: PermissionGate
  try {
    gate = evaluatePermission(target, policy)
  } catch (err) {
    gate = { action: 'deny', reason: `权限检查失败：${errorMessage(err)}` }
  }

  let escapeApproved = false
  call.startedAt = Date.now()
  call.status = gate.action === 'ask' ? 'waiting' : 'running'
  emitStarted()

  if (gate.action === 'deny') {
    const denied = deniedMessage(target)
    const result: ToolResult = { ok: false, output: '', error: gate.reason || denied.error, hint: gate.hint ?? denied.hint }
    call.result = result
    call.status = 'denied'
    call.finishedAt = Date.now()
    emitFinished({ denied: true })
    return { interrupted: false, result }
  }

  if (gate.action === 'ask') {
    const request: PermissionRequest = {
      id: newId('permission'),
      sessionId: ctx.opts.sessionId,
      toolUseId: call.id,
      toolName: call.name,
      title: gate.title,
      summary: gate.summary,
      category: call.category,
      risk: gate.risk,
      input: call.input,
      ...(gate.preview ? { preview: gate.preview } : {}),
      createdAt: Date.now()
    }
    ctx.emit({ type: 'permission_requested', request })
    let decision: PermissionDecision
    try {
      decision = await runSerialized(ctx, () => abortable(ctx.opts.onPermission(request), ctx.opts.signal))
    } catch (err) {
      ctx.emit({ type: 'permission_resolved', requestId: request.id, decision: 'deny' })
      if (isAbortError(err) || ctx.opts.signal.aborted) {
        const result: ToolResult = { ...INTERRUPTED_RESULT }
        call.result = result
        call.status = 'interrupted'
        call.finishedAt = Date.now()
        if (!isMain) emitSubagentProgress(ctx, runOptions, `子代理：${call.title} 已中断`, 'error', call.title)
        return { interrupted: true, result }
      }
      const result: ToolResult = { ok: false, output: '', error: `审批失败：${errorMessage(err)}` }
      call.result = result
      call.status = 'error'
      call.finishedAt = Date.now()
      emitFinished()
      return { interrupted: false, result }
    }
    ctx.emit({ type: 'permission_resolved', requestId: request.id, decision })
    if (decision === 'always') ctx.grants.add(gate.signature)
    if (decision === 'deny') {
      const denied = deniedMessage(target)
      const result: ToolResult = { ok: false, output: '', error: denied.error, hint: denied.hint }
      call.result = result
      call.status = 'denied'
      call.finishedAt = Date.now()
      emitFinished({ denied: true })
      return { interrupted: false, result }
    }
    escapeApproved = gate.escape === true
    call.status = 'running'
    if (isMain) {
      ctx.emit({ type: 'tool_progress', messageId: runOptions.parentMessageId, toolUseId: call.id, status: 'running' })
    } else {
      emitSubagentProgress(ctx, runOptions, `子代理获得授权：${call.title}`, 'running', call.title)
    }
  }

  const toolContext = createToolContext(ctx, call, runOptions.parentMessageId, escapeApproved, runOptions.toolContextOverrides ?? {})
  const startedAt = Date.now()
  const beforeTodos = ctx.todos
  let result: ToolResult
  try {
    result = await executeTool(call.name, call.input, toolContext)
  } catch (err) {
    result = { ok: false, output: '', error: errorMessage(err) }
  }
  const durationMs = Date.now() - startedAt
  result = { ...result, durationMs }
  call.result = result
  call.finishedAt = Date.now()
  if (result.ok) call.status = 'success'
  else if ((result.meta as Record<string, unknown> | undefined)?.interrupted) call.status = 'interrupted'
  else call.status = 'error'
  emitFinished()
  if (isMain && ctx.todos !== beforeTodos) ctx.emit({ type: 'todos_updated', todos: ctx.todos })

  if (ctx.opts.signal.aborted) return { interrupted: true, result }
  return { interrupted: false, result }
}

async function executeToolCalls(ctx: RunContext, message: ChatMessage, toolCalls: ToolUseBlock[]): Promise<boolean> {
  let index = 0
  while (index < toolCalls.length) {
    if (ctx.opts.signal.aborted) {
      markPendingInterrupted(ctx, message, toolCalls)
      return true
    }
    const call = toolCalls[index]
    // R9.1：同一 assistant 消息里的多个 task 调用真正并发（Promise.all），互不阻塞
    if (call.name === 'task') {
      const batch: ToolUseBlock[] = []
      while (index < toolCalls.length && toolCalls[index].name === 'task') {
        batch.push(toolCalls[index])
        index += 1
      }
      const results = await Promise.all(
        batch.map((item) => runToolCallWithPermissions(ctx, item, { mode: 'main', parentMessageId: message.id }))
      )
      if (ctx.opts.signal.aborted || results.some((item) => item.interrupted)) {
        markPendingInterrupted(ctx, message, toolCalls)
        return true
      }
      continue
    }
    const result = await runToolCallWithPermissions(ctx, call, { mode: 'main', parentMessageId: message.id })
    if (result.interrupted) {
      markPendingInterrupted(ctx, message, toolCalls)
      return true
    }
    index += 1
  }
  return false
}

/** 给还没执行的 tool_use 回填 interrupted 结果，保证下一轮消息合法 */
function markPendingInterrupted(ctx: RunContext, message: ChatMessage, toolCalls: ToolUseBlock[]): void {
  for (const block of toolCalls) {
    if (block.result) continue
    block.result = { ...INTERRUPTED_RESULT }
    block.status = 'interrupted'
    block.finishedAt = Date.now()
    if (block.startedAt) {
      ctx.emit({ type: 'tool_finished', messageId: message.id, toolUseId: block.id, result: block.result, interrupted: true })
    }
  }
}

/**
 * 达到 max-steps 时的优雅收尾：额外发一次「不再调用工具」的请求，
 * 让模型用已完成的成果给出最终答复（避免用户只看到一条冷冰冰的上限提示）。
 * run_finished.reason 仍是 'max-steps'，但会话里有一条可读的收尾消息，便于继续。
 */
async function finalizeAtMaxSteps(ctx: RunContext, maxSteps: number): Promise<void> {
  const { opts } = ctx
  const messageId = newId('msg')
  ctx.emit({ type: 'message_started', messageId, role: 'assistant' })
  const message: ChatMessage = {
    id: messageId,
    role: 'assistant',
    content: [],
    createdAt: Date.now(),
    model: opts.model.id
  }
  const system = `${ctx.systemPrompt}\n\n## 重要\n本轮已达到最大工具步数限制（${maxSteps} 步）。不要再调用工具，请基于已完成的工作用简体中文给出最终答复：说明完成了什么、结果在哪里、还剩什么没做。`
  let text = ''
  try {
    for await (const event of iterateWithAbort(
      opts.provider.stream({
        system,
        messages: ctx.messages,
        // Goal 模式下收尾请求仍允许 update_goal，保证最后一轮目标状态能落库；
        // 聊天模式没有任何工具可用，收尾请求也不下发工具。
        tools:
          ctx.opts.mode === 'chat'
            ? []
            : ctx.currentGoal?.status === 'active'
              ? [GOAL_TOOL_DEFINITION]
              : [],
        signal: opts.signal,
        workspace: opts.workspace,
        maxTokens: Math.min(1500, opts.model.maxOutput ?? 1500)
      }),
      opts.signal
    )) {
      if (event.type === 'text_delta') {
        text += event.text
        ctx.emit({ type: 'message_delta', messageId, textDelta: event.text })
      } else if (event.type === 'tool_call_end' && event.name === 'update_goal') {
        // 收尾阶段不写回 tool_use（消息只保留文本），但目标状态要生效
        // R7：completed 同样必须通过证据校验，收尾通道不能成为「假完成」后门。
        const raw = event.input ?? {}
        const rawStatus = typeof raw.status === 'string' ? raw.status : ''
        if (rawStatus === 'completed') {
          const checked = validateGoalEvidence(raw.evidence, opts.workspace, ctx.currentGoal?.createdAt)
          if (!checked.ok) {
            ctx.emit({ type: 'notice', level: 'warn', message: `收尾阶段标记完成被拒绝：${checked.error}` })
          } else {
            updateGoalInRun(ctx, {
              status: 'completed',
              evidence: checked.paths,
              ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {})
            })
          }
        } else if (rawStatus === 'active' || rawStatus === 'blocked') {
          updateGoalInRun(ctx, {
            status: rawStatus,
            ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
            ...(typeof raw.nextStep === 'string' ? { nextStep: raw.nextStep } : {}),
            ...(typeof raw.blockedReason === 'string' ? { blockedReason: raw.blockedReason } : {})
          })
        }
      } else if (event.type === 'usage') {
        // 收尾请求也是一次真实 provider 请求：计入总量与精确 contextUsed
        ctx.requestUsage = {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          ...(typeof event.usage.cacheReadTokens === 'number' ? { cacheReadTokens: event.usage.cacheReadTokens } : {})
        }
        ctx.lastRequestUsage = { ...ctx.requestUsage }
      }
    }
  } catch (err) {
    if (isAbortError(err) || opts.signal.aborted) throw err
    ctx.emit({ type: 'notice', level: 'warn', message: '生成收尾说明失败，本轮先停在这里。' })
  }
  commitRequestUsage(ctx)
  message.content.push({
    type: 'text',
    text: text.trim() || '（本轮达到步数上限，先停在这里。可以回复「继续」接着完成剩余工作。）'
  })
  pushAssistant(ctx, message)
  ctx.emit({ type: 'message_completed', messageId, message: cloneMessage(message) })
}

/** 中断收尾：补齐未完成的工具结果 + 标记 assistant 消息 interrupted（只做一次） */
function finalizeInterrupted(ctx: RunContext): void {
  if (ctx.interruptFinalized) return
  ctx.interruptFinalized = true
  const target = ctx.lastMessage ?? findLastAssistant(ctx.messages)
  if (target) {
    markPendingInterrupted(ctx, target, extractToolCalls(target))
    target.interrupted = true
    ctx.emit({ type: 'message_completed', messageId: target.id, message: cloneMessage(target) })
  } else {
    const message = createPlainMessage(ctx, newId('msg'), '（本轮运行已停止）', true)
    ctx.emit({ type: 'message_started', messageId: message.id, role: 'assistant' })
    ctx.messages.push(message)
    ctx.newMessages.push(message)
    ctx.lastMessage = message
    ctx.emit({ type: 'message_completed', messageId: message.id, message: cloneMessage(message) })
  }
  ctx.emit({ type: 'notice', level: 'info', message: '已停止本轮运行。可以继续提问，或让 Morrow 接着完成。' })
}

function findLastAssistant(messages: ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'assistant') return messages[i]
  }
  return undefined
}

function createPlainMessage(ctx: RunContext, id: string, text: string, interrupted: boolean): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    createdAt: Date.now(),
    model: ctx.opts.model.id,
    ...(interrupted ? { interrupted: true } : {})
  }
}

/* ── 工具上下文 ───────────────────────────────────────────────── */

function createToolContext(
  ctx: RunContext,
  block: ToolUseBlock,
  messageId: string,
  escapeApproved: boolean,
  overrides: { readOnly?: boolean; depth?: number; goal?: Goal | null; allowSubagent?: boolean } = {}
): ToolContext {
  const opts = ctx.opts
  return {
    sessionId: opts.sessionId,
    runId: opts.runId,
    messageId,
    toolUseId: block.id,
    workspace: opts.workspace,
    permissionMode: ctx.effectiveMode,
    snapshotDir: opts.snapshotDir,
    signal: opts.signal,
    depth: overrides.depth ?? ctx.depth,
    readOnly: overrides.readOnly ?? ctx.readOnly,
    escapeApproved,
    demo: ctx.demo,
    goal: overrides.goal !== undefined ? overrides.goal : ctx.currentGoal,
    emit: (event) => ctx.emit(event),
    updateGoal: overrides.goal === null ? () => null : (patch) => updateGoalInRun(ctx, patch),
    getTodos: () => ctx.todos,
    setTodos: (todos) => {
      ctx.todos = todos
    },
    getArtifacts: () => ctx.artifacts,
    addArtifact: (artifact) => {
      ctx.artifacts = [...ctx.artifacts.filter((item) => item.id !== artifact.id), artifact]
      ctx.emit({ type: 'artifacts_updated', artifacts: ctx.artifacts })
    },
    askUser: async (request) => {
      ctx.emit({ type: 'question_asked', request })
      const answer = await abortable(opts.onAskUser(request), opts.signal)
      ctx.emit({ type: 'question_answered', requestId: request.id, answer })
      return answer
    },
    progress: (note, progressOpts) => {
      ctx.emit({
        type: 'tool_progress',
        messageId,
        toolUseId: block.id,
        note,
        ...(progressOpts?.status ? { status: progressOpts.status } : {}),
        ...(progressOpts?.title ? { title: progressOpts.title } : {})
      })
    },
    runSubagent:
      overrides.allowSubagent === false
        ? async () => ({
            status: 'failed' as const,
            summary: '',
            steps: 0,
            usage: { inputTokens: 0, outputTokens: 0 },
            error: '子代理不能再创建子代理。'
          })
        : (request) => runSubagentLoop(ctx, request, messageId, block.id)
  }
}

/**
 * Goal 模式：合并 update_goal 补丁 → 更新当前目标 → emit goal_updated（完整 Goal 快照）。
 * 返回更新后的 Goal（供工具结果使用）。
 */
function updateGoalInRun(ctx: RunContext, patch: GoalPatch): Goal | null {
  if (!ctx.currentGoal) return null
  const now = Date.now()
  const next: Goal = {
    ...ctx.currentGoal,
    status: patch.status,
    ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
    ...(patch.nextStep !== undefined ? { nextStep: patch.nextStep } : {}),
    ...(patch.evidence !== undefined ? { evidence: patch.evidence } : {}),
    ...(patch.status === 'blocked'
      ? { blockedReason: patch.blockedReason ?? ctx.currentGoal.blockedReason }
      : {}),
    updatedAt: now,
    ...(patch.status === 'completed' ? { completedAt: now } : {})
  }
  if (patch.status === 'completed') delete next.stopReason
  if (patch.status !== 'blocked') delete next.blockedReason
  if (patch.status === 'completed') delete next.nextStep
  ctx.currentGoal = next
  ctx.emit({ type: 'goal_updated', goal: { ...next } })
  return next
}

/* ── 子代理（只读、深度 1） ───────────────────────────────────── */

/**
 * 子代理循环（R9.1：与主代理**权限完全一致**）：
 * - 工具集 = 主代理当前工具集 - task（防嵌套）- update_goal（防篡改父目标）；
 * - 同一 permissionMode/mode/工作区/snapshot/MCP 配置；
 * - 写文件/跑命令/mcp_call 走主代理同一套 evaluatePermission + onPermission（审批卡出现在父级 UI）；
 * - read-only 父任务或 chat 模式仍只读（权限层会拒绝/工具集已过滤）；
 * - 终态 failed/exhausted/cancelled 由 task 工具转成 ok=false，不被文字完成覆盖。
 */
async function runSubagentLoop(
  parent: RunContext,
  request: SubagentRequest,
  messageId: string,
  toolUseId: string
): Promise<SubagentResult> {
  const opts = parent.opts
  const emitProgress = (note: string, status: ToolStatus = 'running'): void => {
    parent.emit({ type: 'tool_progress', messageId, toolUseId, note, status })
  }
  // 与主代理一致的工具集（去掉 task 防嵌套、去掉 update_goal 防止子代理篡改父目标）
  const subagentTools = parent.tools.filter((tool) => tool.name !== 'task' && tool.name !== 'update_goal')
  const systemPrompt = [
    buildSystemPrompt({
      workspace: opts.workspace,
      permissionMode: parent.effectiveMode,
      mode: opts.mode,
      projectContext: opts.projectContext ?? opts.projectMemory,
      modelLabel: opts.model.label,
      tools: subagentTools
    }),
    '## 子代理',
    '你是主代理派出的子代理。你拥有与主代理相同的工具与权限：可以读文件、写文件、运行命令、调用 MCP；',
    '涉及写入/命令/MCP 的操作会按主代理当前的权限模式向用户请求审批，审批记录归属本轮主任务。',
    '你不能创建新的子代理，也不能更新父任务的目标状态；请把结论与真实产出路径返回给主代理。'
  ].join('\n\n')
  const firstMessage: ChatMessage = {
    id: newId('msg'),
    role: 'user',
    createdAt: Date.now(),
    content: [
      {
        type: 'text',
        text: [
          `【子任务】${request.description}`,
          request.prompt,
          request.context ? `\n【上下文】\n${request.context}` : ''
        ]
          .filter(Boolean)
          .join('\n\n')
      }
    ]
  }
  const messages: ChatMessage[] = [firstMessage]
  const usage: Usage = { inputTokens: 0, outputTokens: 0 }
  let summary = ''
  let steps = 0
  let lastError: string | undefined
  let outcome: SubagentResult['status'] = 'exhausted'
  const failedTools: string[] = []

  for (let step = 1; step <= SUBAGENT_MAX_STEPS; step += 1) {
    if (opts.signal.aborted) throw abortError()
    steps = step
    emitProgress(`子代理第 ${step} 步：分析中…`)
    const assistant: ChatMessage = {
      id: newId('msg'),
      role: 'assistant',
      content: [],
      createdAt: Date.now(),
      model: opts.model.id
    }
    let text = ''
    const streamedCalls: ToolUseBlock[] = []
    const pending = new Map<number, { id: string; name: string; args: string }>()
    let requestUsage: Usage = { inputTokens: 0, outputTokens: 0 }
    try {
      for await (const event of iterateWithAbort(
        opts.provider.stream({
          system: systemPrompt,
          messages: [...messages],
          tools: subagentTools,
          signal: opts.signal,
          workspace: opts.workspace,
          maxTokens: Math.min(opts.model.maxOutput ?? SUBAGENT_MAX_OUTPUT, SUBAGENT_MAX_OUTPUT)
        }),
        opts.signal
      )) {
        switch (event.type) {
          case 'text_delta':
            text += event.text
            break
          case 'tool_call_start': {
            pending.set(event.index, { id: event.id, name: event.name, args: '' })
            break
          }
          case 'tool_call_delta': {
            const existing = pending.get(event.index)
            if (existing) existing.args += event.argsDelta
            break
          }
          case 'tool_call_end': {
            const input = event.input ?? {}
            streamedCalls.push({
              type: 'tool_use',
              id: event.id,
              name: event.name,
              title: toolTitleFor(event.name, input),
              category: toolCategory(event.name),
              input,
              status: 'running'
            })
            pending.delete(event.index)
            break
          }
          case 'usage':
            requestUsage = { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens }
            break
          case 'notice':
            emitProgress(event.message, 'running')
            break
          default:
            break
        }
      }
    } catch (err) {
      if (isAbortError(err) || opts.signal.aborted) throw err
      lastError = err instanceof Error ? err.message : String(err)
      outcome = 'failed'
      break
    }
    usage.inputTokens += requestUsage.inputTokens
    usage.outputTokens += requestUsage.outputTokens

    if (text.trim()) assistant.content.push({ type: 'text', text })
    for (const call of streamedCalls) assistant.content.push(call)
    if (assistant.content.length === 0) assistant.content.push({ type: 'text', text: '（子代理没有返回内容）' })
    messages.push(assistant)
    summary = text.trim() || summary
    if (text.trim()) {
      emitProgress(`子代理：${text.replace(/\s+/g, ' ').trim().slice(0, 80)}`)
    }

    if (streamedCalls.length === 0) {
      if (text.trim()) outcome = 'completed'
      else {
        outcome = 'failed'
        lastError = lastError ?? '子代理没有返回任何结论'
      }
      break
    }
    // 与主代理完全相同的权限/执行链；子代理不能嵌套 task、不能 update_goal
    for (const call of streamedCalls) {
      if (opts.signal.aborted) throw abortError()
      if (call.name === 'task') {
        call.result = {
          ok: false,
          output: '',
          error: '子代理不能再创建子代理。',
          hint: '请直接使用现有工具完成任务，或把任务交回主代理拆分。'
        }
        call.status = 'error'
        call.finishedAt = Date.now()
        failedTools.push('task：子代理不能再创建子代理')
        continue
      }
      if (call.name === 'update_goal') {
        call.result = {
          ok: false,
          output: '',
          error: '子代理不能更新父任务的目标状态。',
          hint: '请把结论返回给主代理，由主代理决定是否 update_goal。'
        }
        call.status = 'error'
        call.finishedAt = Date.now()
        failedTools.push('update_goal：仅主代理可用')
        continue
      }
      const runResult = await runToolCallWithPermissions(parent, call, {
        mode: 'subagent',
        parentMessageId: messageId,
        parentToolUseId: toolUseId,
        toolContextOverrides: {
          readOnly: parent.readOnly,
          depth: parent.depth + 1,
          goal: null,
          allowSubagent: false
        }
      })
      if (runResult.interrupted || opts.signal.aborted) throw abortError()
      if (call.result && call.result.ok === false) {
        failedTools.push(`${call.name}：${call.result.error ?? call.result.output ?? '未知错误'}`)
      }
    }
  }

  if (outcome === 'exhausted') {
    lastError = `子代理达到原生最大步数（${SUBAGENT_MAX_STEPS} 步）仍未给出最终结论`
  }
  return {
    status: outcome,
    summary: truncateText(summary || '（子代理没有给出最终结论）', 4000),
    steps,
    usage,
    ...(lastError ? { error: lastError } : {}),
    ...(failedTools.length > 0 ? { failedTools: failedTools.slice(0, 20) } : {})
  }
}

/* ── 上下文压缩 ───────────────────────────────────────────────── */

async function maybeCompact(ctx: RunContext): Promise<void> {
  if (ctx.opts.autoCompact === false) return
  const plan = planCompaction(ctx.messages, ctx.systemPrompt, ctx.opts.model.contextWindow, {
    threshold: ctx.opts.compactThreshold,
    keepRecent: ctx.opts.keepRecent
  })
  if (!plan.shouldCompact) {
    if (plan.reason === 'no-safe-cut' && plan.estimatedTokens > plan.thresholdTokens) {
      ctx.emit({
        type: 'notice',
        level: 'warn',
        message: '上下文接近上限，但当前这一轮对话较长，暂时无法安全压缩历史。建议先完成手头任务。'
      })
    }
    return
  }
  ctx.emit({ type: 'compaction', phase: 'started' })
  const older = ctx.messages.slice(0, plan.cutIndex)
  let summaryText: string
  try {
    summaryText = await summarizeHistory({
      provider: ctx.opts.provider,
      model: ctx.opts.model,
      signal: ctx.opts.signal,
      older
    })
    if (!summaryText.trim()) throw new Error('摘要为空')
  } catch (err) {
    if (isAbortError(err) || ctx.opts.signal.aborted) throw err
    summaryText = localExtractSummary(older)
    ctx.emit({ type: 'notice', level: 'warn', message: '自动摘要失败，已用本地摘要压缩历史，对话可以继续。' })
  }
  ctx.messages = applyCompaction(ctx.messages, plan.cutIndex, summaryText)
  const after = estimateMessagesTokens(ctx.messages, ctx.systemPrompt)
  ctx.emit({ type: 'compaction', phase: 'finished', savedTokens: Math.max(0, plan.estimatedTokens - after) })
  ctx.emit({ type: 'usage_updated', usage: currentUsage(ctx) })
}

interface SummarizeHistoryOptions {
  provider: Provider
  model: ModelInfo
  signal: AbortSignal
  older: ChatMessage[]
}

/** 用模型把较早的历史压成结构化摘要（供自动压缩与手动 /compact 共用） */
async function summarizeHistory(options: SummarizeHistoryOptions): Promise<string> {
  const serialized = serializeMessagesForSummary(options.older)
  const system =
    '你是对话压缩器。把给定的历史对话压缩成结构化的中文摘要，必须保留：用户的目标与偏好、已确认的事实和数字、已创建/修改的文件路径与改动、未完成的事项、重要约束。' +
    '不要编造信息，不要评论，不要调用工具。直接输出摘要正文。'
  const message: ChatMessage = {
    id: newId('msg'),
    role: 'user',
    content: [{ type: 'text', text: `请压缩下面这段历史对话：\n\n${serialized}` }],
    createdAt: Date.now()
  }
  let text = ''
  for await (const event of iterateWithAbort(
    options.provider.stream({
      system,
      messages: [message],
      tools: [],
      signal: options.signal,
      workspace: null,
      maxTokens: Math.min(1200, options.model.maxOutput ?? 1200)
    }),
    options.signal
  )) {
    if (event.type === 'text_delta') text += event.text
  }
  return truncateText(text.trim(), 6000)
}

/* ── 手动 /compact 入口（主进程可直接调用） ───────────────────── */

export interface CompactSessionOptions {
  provider: Provider
  model: ModelInfo
  systemPrompt: string
  messages: ChatMessage[]
  signal: AbortSignal
  /** 手动 /compact 传 true：即使未达到阈值也压缩；自动压缩不传 */
  force?: boolean
  keepRecent?: number
  /** 压缩阈值（contextWindow 占比，0.5–0.98，默认 0.8；force=true 时不影响） */
  threshold?: number
}

export interface CompactSessionResult {
  /** 压缩后的完整消息数组（未压缩时原样返回） */
  messages: ChatMessage[]
  compacted: boolean
  savedTokens: number
  summary?: string
  error?: ResultError
  reason?: 'below-threshold' | 'no-safe-cut'
}

/**
 * 手动上下文压缩：给主进程 `session.compact` IPC 使用。
 * 与自动压缩共用同一套「user 消息边界切割 + 模型摘要 + 本地兜底」逻辑。
 */
export async function compactSession(options: CompactSessionOptions): Promise<CompactSessionResult> {
  const { provider, model, systemPrompt, messages, signal } = options
  const contextLimit = model.contextWindow > 0 ? model.contextWindow : 128_000
  const plan = planCompaction(messages, systemPrompt, contextLimit, {
    keepRecent: options.keepRecent === undefined ? undefined : clampKeepRecent(options.keepRecent),
    threshold: options.threshold === undefined ? undefined : clampThreshold(options.threshold),
    force: options.force
  })
  if (!plan.shouldCompact) {
    return { messages, compacted: false, savedTokens: 0, ...(plan.reason ? { reason: plan.reason } : {}) }
  }
  const older = messages.slice(0, plan.cutIndex)
  let summaryText: string
  try {
    summaryText = await summarizeHistory({ provider, model, signal, older })
    if (!summaryText.trim()) throw new Error('摘要为空')
  } catch (err) {
    if (isAbortError(err) || signal.aborted) {
      return { messages, compacted: false, savedTokens: 0, error: toResultError(err) }
    }
    summaryText = localExtractSummary(older)
  }
  const compactedMessages = applyCompaction(messages, plan.cutIndex, summaryText)
  const after = estimateMessagesTokens(compactedMessages, systemPrompt)
  return {
    messages: compactedMessages,
    compacted: true,
    savedTokens: Math.max(0, plan.estimatedTokens - after),
    summary: summaryText
  }
}

/* ── 便于主进程/测试使用的辅助导出 ────────────────────────────── */

/** 只估算，不触发压缩：用于 UI 上下文条 */
export function estimateContextUsage(
  messages: ChatMessage[],
  systemPrompt: string,
  contextLimit: number
): { used: number; limit: number; ratio: number } {
  const used = estimateMessagesTokens(messages, systemPrompt)
  return { used, limit: contextLimit, ratio: contextLimit > 0 ? used / contextLimit : 0 }
}
