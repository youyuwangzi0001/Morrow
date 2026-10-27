// Agent 运行时：一次用户输入 → 完整「思考 → 工具 → 回答」循环。
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
  PermissionRule,
  ResearchState,
  ResultError,
  RunFinishReason,
  RuntimeEvent,
  SessionMode,
  SessionPlan,
  SwarmOperation,
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
  aggressiveTrim,
  applyCompaction,
  estimateMessagesTokens,
  localExtractSummary,
  planCompaction,
  shrinkToolOutputs,
  serializeMessagesForSummary
} from './context'
import { buildChatModePromptSection, buildGoalPromptSection, buildPlanModePromptSection, buildSystemPrompt } from './prompt'
import { ROLE_SKILL_BOUNDARY } from './agent-roles'
import { validateGoalEvidence } from './tools/meta-tools'
import {
  deniedMessage,
  evaluatePermission,
  isChatModeToolAllowed,
  isResearchModeToolAllowed,
  type PermissionGate,
  type PermissionPolicyContext,
  type PermissionTarget
} from './permissions'
import type {
  GoalPatch,
  Provider,
  ProviderStreamRequest,
  RuntimeEventPayload,
  SwarmMemberRequest,
  SwarmMemberResult,
  SwarmMemberRole,
  ToolContext,
  ToolDefinition,
  TerminalToolHandler,
  MediaToolHandler,
  WebSearchHandler
} from './types'
import { ProviderError, toProviderError } from './providers/types'
import { reasoningRequestFor } from '../shared/models'
import {
  GOAL_TOOL_DEFINITION,
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
  /** 用户在本会话用户消息中显式附加的文件（只读；供 PDF/Office 等文档工具读取工作区外附件） */
  attachedFiles?: readonly string[]
  permissionMode: PermissionMode
  /**
   * 显式会话模式（审计报告第 5 项）：
   * - chat：只暴露只读工具 + ask_user，权限层硬拦截写入/执行/记忆/目标；系统提示注入「只讨论不执行」；
   * - work / 缺省：行为与之前完全一致（按 permissionMode 三档）。
   */
  mode?: SessionMode
  /** 深度研究状态：注入研究提示与轮次/来源目标 */
  research?: ResearchState | null
  /** 研究计划阶段：不暴露任何工具，只让模型输出可审阅计划 */
  researchPlanning?: boolean
  /**
   * 计划模式：只读探索 + submit_plan；用户批准前不写入、不执行。
   * 与 chat 互斥（chat 优先）。
   */
  planMode?: boolean
  projectMemory?: string
  /** R10：项目指令 + 知识 + 记忆上下文（优先于 projectMemory） */
  projectContext?: string
  /** 临时对话：不注入项目记忆，也不向模型暴露 remember */
  temporary?: boolean
  /** 全局回答风格（仅在主进程没有自带 systemPrompt、由内核构建时使用） */
  answerStyle?: import('../shared/types').AnswerStyleId
  answerStyleCustom?: string
  /** 写文件前备份旧内容到这里（<snapshotDir>/<toolUseId>/<filename>） */
  snapshotDir: string
  /** 联网搜索处理器；未配置时 web_search 不暴露给模型 */
  webSearch?: WebSearchHandler
  /** 本机 PDF OCR（主进程注入；扫描页自动识别） */
  ocrPdf?: import('./types').PdfOcrHandler
  /** 终端/后台任务处理器（主进程注入） */
  terminal?: TerminalToolHandler
  /** 本地多媒体引擎处理器（主进程注入） */
  media?: MediaToolHandler
  /** 创作台作品服务处理器（主进程注入） */
  studio?: import('./types').StudioToolHandler
  /** 当前对话 Provider/模型（主进程注入；用于优先使用自带视觉能力） */
  vision?: { provider: Provider; model: ModelInfo }
  /** 写入记忆中心（由主进程注入；未注入时 remember 回退 MEMORY.md） */
  remember?: (input: {
    text: string
    scope: 'project' | 'global'
    tags?: string[]
  }) => Promise<{ scope: 'project' | 'global'; text: string }>
  /** 工作区持久化权限规则 */
  permissionRules?: PermissionRule[]
  /** 推理强度；仅在模型声明 reasoningStyle 时映射到 provider */
  reasoningEffort?: import('../shared/types').ReasoningEffort
  /** 本会话覆盖的上下文上限；传给支持该参数的代理 */
  contextWindow?: number
  /** 可用的集群成员角色（主进程加载内置 + 自定义） */
  agents?: SwarmMemberRole[]
  signal: AbortSignal
  emit: (event: RuntimeEvent) => void
  onPermission: (request: PermissionRequest) => Promise<PermissionDecision>
  onAskUser: (request: AskUserRequest) => Promise<AskUserAnswer>
  /** 无人值守运行：拒绝审批时使用「已自动拒绝」文案，而不是「用户拒绝」 */
  unattended?: boolean
  maxSteps?: number
  demo?: boolean
  /** 是否启用自动上下文压缩（默认 true）；false 时仍可手动 compactSession */
  autoCompact?: boolean
  /** 自动压缩阈值（contextWindow 占比，0.5–0.98，默认 0.8） */
  compactThreshold?: number
  /** 压缩时保留最近多少条消息（默认 8） */
  keepRecent?: number
  /** 用户设置的默认终端（run_command 与一次性命令使用；主进程注入） */
  commandShell?: import('./types').CommandShell
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
  /** 发生过自动压缩时，压缩后的完整会话消息（含摘要与保留历史）；否则省略 */
  compactedMessages?: ChatMessage[]
  usage: Usage
  todos: TodoItem[]
  artifacts: Artifact[]
  /** Goal 模式：本轮结束时的目标状态（含 update_goal 合并结果；非 Goal 模式回显传入值/null） */
  goal?: Goal | null
  /** 计划模式：本轮结束时的计划（尚未提交则为 null） */
  plan?: SessionPlan | null
  /** 本轮是否运行在计划模式 */
  planMode?: boolean
  error?: ResultError
}

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
  /** 本轮是否实际压缩过上下文（用于把压缩后的完整历史带回主进程） */
  compacted: boolean
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
  /** 计划模式：本轮提交的计划（submit_plan 写入；null = 尚未提交） */
  plan: SessionPlan | null
  planMode: boolean
  lastMessage?: ChatMessage
  interruptFinalized: boolean
  /** 本会话已出现过的 tool_use id：保证跨回合/跨 run 唯一（快照目录、UI 定位都依赖它） */
  usedToolUseIds: Set<string>
  /** 工具参数解析失败（如输出被截断）的 tool_use id → 错误原因，执行前转成可自修复的工具错误 */
  toolParseErrors: Map<string, string>
  /** 审批/提问串行链：并行集群成员不能同时弹出多个审批卡 */
  permissionChain: Promise<void>
}

/**
 * 单轮默认不设步数上限：长程任务（搭建页面、跑测试、修复循环）不应因固定步数被截断。
 * 仍保留显式 maxSteps 支持（计划模式、测试与高级调用方可以设硬上限）。
 */
const DEFAULT_MAX_STEPS = Number.POSITIVE_INFINITY
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
  // 不传 = 不限制；显式传入有限值时才作为硬上限。
  if (!value || !Number.isFinite(value)) return DEFAULT_MAX_STEPS
  return Math.max(1, Math.trunc(value))
}

function normalizeOptions(options: RunAgentOptions): RunAgentOptions {
  const mode: SessionMode =
    options.mode === 'chat' || options.mode === 'research' ? options.mode : 'work'
  return {
    ...options,
    history: options.history ?? [],
    mode,
    planMode: mode === 'work' && options.planMode === true,
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
  const researchMode = opts.mode === 'research'
  const planMode = !chatMode && !researchMode && opts.planMode === true
  const base = opts.systemPrompt?.trim() ?? ''
  let prompt =
    base.length > 0
      ? base
      : buildSystemPrompt({
          workspace: opts.workspace,
          permissionMode: mode,
          mode: opts.mode,
          research: opts.research ?? null,
          planMode,
          projectContext: opts.projectContext ?? opts.projectMemory,
          modelLabel: opts.model.label,
          demo: opts.demo,
          tools,
          goal,
          answerStyle: opts.answerStyle,
          answerStyleCustom: opts.answerStyleCustom
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
  // 计划模式：主进程自建 systemPrompt 时同样必须带「先计划、后批准」约束。
  if (planMode && !prompt.includes('## 计划模式')) {
    prompt += `\n\n${buildPlanModePromptSection()}`
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

/** 判断是否是「上下文窗口已满」类错误：这类错误应压缩后重试，而不是结束任务。 */
function isContextOverflowError(error: { code?: string; message?: string }): boolean {
  const text = `${error.code ?? ''} ${error.message ?? ''}`
  return /context[_ -]?length|context.{0,24}(too|exceed|limit|full)|maximum.{0,20}context|prompt.{0,20}too long|reduce.{0,20}(length|token)|too many tokens|input.{0,16}too long|上下文.{0,16}(超|满|限制|过长)/i.test(
    text
  )
}

export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const opts = normalizeOptions(options)
  const emit = createEmitter(opts)
  const chatMode = opts.mode === 'chat'
  const researchMode = opts.mode === 'research'
  const planMode = !chatMode && !researchMode && opts.planMode === true
  // 聊天/计划/研究模式不启用 Goal：即使主进程误传了 active 目标，内核也不注入 update_goal / 目标提示。
  const initialGoal = !chatMode && !planMode && !researchMode && opts.goal ? { ...opts.goal } : null
  const goalMode = Boolean(initialGoal && initialGoal.status === 'active')
  const runTools = toolDefinitionsForRun(
    goalMode,
    planMode,
    Boolean(opts.webSearch),
    researchMode,
    opts.temporary === true,
    opts.researchPlanning === true
  )
  const tools = chatMode
    ? runTools.filter((definition) => isChatModeToolAllowed(definition.name, definition.category))
    : researchMode
      ? runTools.filter((definition) => isResearchModeToolAllowed(definition.name, definition.category))
      : runTools
  // 计划模式固定只读；研究模式由主进程传入 auto（权限层另有研究白名单兜底）。
  const effectiveMode: PermissionMode = opts.demo
    ? 'auto'
    : chatMode || planMode
      ? 'read-only'
      : opts.permissionMode
  const contextLimit = opts.model.contextWindow
  const ctx: RunContext = {
    opts,
    emit,
    messages: [...opts.history, opts.userMessage],
    newMessages: [],
    compacted: false,
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
    plan: null,
    planMode,
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
      ...(ctx.compacted ? { compactedMessages: ctx.messages } : {}),
      usage: fallbackUsage,
      todos: ctx.todos,
      artifacts: ctx.artifacts,
      goal: ctx.currentGoal,
      plan: ctx.plan,
      planMode: ctx.planMode,
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
    ...(ctx.compacted ? { compactedMessages: ctx.messages } : {}),
    usage,
    todos: ctx.todos,
    artifacts: ctx.artifacts,
    goal: ctx.currentGoal,
    plan: ctx.plan,
    planMode: ctx.planMode,
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
  let repeatedSignature = ''
  let repeatedCount = 0
  let todoCheckRounds = 0
  let qualityReviewRounds = 0
  let planReminderStep = 1
  let planReminderRounds = 0
  let finishTodoAdded = false
  let lastTodoSignature = JSON.stringify(ctx.todos.map((todo) => `${todo.id}:${todo.status}`))
  const runStartedAt = Date.now()
  const userText = ctx.opts.userMessage.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  const visualIntent =
    ctx.opts.mode !== 'chat' &&
    ctx.opts.mode !== 'research' &&
    /(惊艳|高级感|有质感|有氛围|视觉冲击|好看|漂亮|美术|酷炫)/.test(userText)
  const qualityIntent =
    ctx.opts.mode !== 'chat' &&
    ctx.opts.mode !== 'research' &&
    /(专业|高质量|精致|完美|拿得出手|直接交付|可交付|尽可能好|像作品|打磨|精品|正式|汇报|惊艳|高级感|有质感|有氛围|视觉冲击|好看|漂亮|美术|酷炫)/.test(
      userText
    )
  let overflowRetries = 0
  for (;;) {
    if (ctx.opts.signal.aborted) {
      finalizeInterrupted(ctx)
      return { reason: 'cancelled' }
    }
    // 上下文压缩：每次达到阈值都必须压缩，不能靠冷却跳过；长任务可以反复压缩
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
      if (overflowRetries < 2 && isContextOverflowError(streamed.error)) {
        overflowRetries += 1
        // 上一次失败回合不进入历史：清理后强制压缩，再用同一目标重试
        ctx.messages = ctx.messages.filter((message) => message.id !== streamed.message.id)
        ctx.newMessages = ctx.newMessages.filter((message) => message.id !== streamed.message.id)
        const compacted = await maybeCompact(ctx, { force: true, targetRatio: 0.35 })
        if (!compacted) {
          ctx.messages = aggressiveTrim(ctx.messages, ctx.systemPrompt, ctx.opts.model.contextWindow, 4)
          ctx.compacted = true
          ctx.lastRequestUsage = null
          ctx.emit({ type: 'messages_replaced', messages: ctx.messages })
          ctx.emit({
            type: 'notice',
            level: 'warn',
            message: '上下文已满，已折叠较早内容并重试本步。'
          })
        }
        assistantId = newId('msg')
        continue
      }
      ctx.emit({ type: 'error', error: streamed.error })
      return { reason: 'error', error: streamed.error }
    }
    if (streamed.toolCalls.length === 0) {
      // 模型常在工作完成后直接收尾，忘记把计划标记完成，界面上就会停在 0/N。
      // 结束前给一次（最多两次）纠正机会：只更新计划，不重复最终答复。
      const openTodos = ctx.todos.filter((todo) => todo.status !== 'completed')
      const canReconcileTodos =
        openTodos.length > 0 &&
        todoCheckRounds < 2 &&
        step < maxSteps &&
        ctx.depth === 0 &&
        !ctx.demo &&
        !ctx.planMode &&
        ctx.tools.some((tool) => tool.name === 'todo_write') &&
        !ctx.opts.signal.aborted
      if (canReconcileTodos) {
        todoCheckRounds += 1
        const list = openTodos
          .slice(0, 12)
          .map(
            (todo, index) =>
              `${index + 1}. ${todo.text}（${todo.status === 'in_progress' ? '进行中' : '未开始'}）`
          )
          .join('\n')
        const nudge: ChatMessage = {
          id: newId('msg'),
          role: 'user',
          hidden: true,
          createdAt: Date.now(),
          content: [
            {
              type: 'text',
              text:
                `[系统检查] 计划里还有 ${openTodos.length} 项未标记完成：\n${list}\n\n` +
                '结束本轮前请调用 todo_write 同步真实状态：已完成的标为 completed；仍需做的继续执行；' +
                '范围变化或不再需要的步骤从完整列表中移除。只更新计划，不要重复最终答复，也不要用正文代替更新。'
            }
          ]
        }
        ctx.messages.push(nudge)
        ctx.newMessages.push(nudge)
        assistantId = newId('msg')
        step += 1
        continue
      }

      // 视觉成品的自检由模型按 frontend-art-direction 在正常工作中完成。
      // 内核不再因为用户说了「惊艳/好看」就强制追加一轮打磨：多数情况下第二轮
      // 只增加延迟和 token，用户对细节差异的感知很低。模型认为确有弱点时可自行修。
      const visualArtifact = ctx.artifacts.some(
        (artifact) =>
          artifact.updatedAt >= runStartedAt &&
          (artifact.kind === 'html' ||
            artifact.kind === 'svg' ||
            /\.(?:html?|svg)$/i.test(artifact.path ?? ''))
      )

      // 非视觉成品（文档、表格、幻灯片、代码等）仍保留一次交付质量审查，而不是只打磨前端。
      const updatedArtifact = ctx.artifacts.some((artifact) => artifact.updatedAt >= runStartedAt)
      const changedFile = ctx.newMessages.some((message) =>
        message.content.some(
          (block) =>
            block.type === 'tool_use' &&
            block.result?.ok === true &&
            typeof block.result.meta?.absolutePath === 'string'
        )
      )
      // PPTX/DOCX/XLSX/PDF 等可能由 python 脚本经 run_command 生成，没有 absolutePath meta；
      // 只要命令里出现交付物扩展名，也视为产生了可审查的成品。
      const generatedByCommand = ctx.newMessages.some((message) =>
        message.content.some((block) => {
          if (block.type !== 'tool_use' || block.result?.ok !== true) return false
          if (block.name !== 'run_command' && block.name !== 'terminal') return false
          const command = typeof block.input.command === 'string' ? block.input.command : ''
          return /\.(?:md|markdown|html?|svg|pdf|docx?|xlsx?|pptx?|png|jpe?g|csv|zip)\b/i.test(command)
        })
      )
      const canReviewQuality =
        qualityIntent &&
        !(visualIntent && visualArtifact) &&
        (updatedArtifact || changedFile || generatedByCommand) &&
        qualityReviewRounds < 1 &&
        step < maxSteps &&
        ctx.depth === 0 &&
        !ctx.demo &&
        !ctx.planMode &&
        !ctx.opts.signal.aborted
      if (canReviewQuality) {
        qualityReviewRounds += 1
        const nudge: ChatMessage = {
          id: newId('msg'),
          role: 'user',
          hidden: true,
          createdAt: Date.now(),
          content: [
            {
              type: 'text',
              text:
                '[系统检查] 用户明确要求高质量交付。请在收尾前按 deliverable-quality 做一次交付前审查：\n' +
                '- 根据实际交付物类型核对：结构/完整性、关键数字与证据、边界与失败状态、可打开或可运行性；文档/表格/幻灯片还要检查版式、公式、引用和导出效果。\n' +
                '- 直接修正发现的具体问题（占位符、缺证据、排版/格式错误、公式或引用错位、测试未跑等），不要只重复总结，也不要重新做一遍整个任务。\n' +
                '- 改完重新验证成品，再简短收尾。'
            }
          ]
        }
        ctx.messages.push(nudge)
        ctx.newMessages.push(nudge)
        assistantId = newId('msg')
        step += 1
        continue
      }
      return { reason: 'complete' }
    }

    const todoSignatureBefore = JSON.stringify(ctx.todos.map((todo) => `${todo.id}:${todo.status}`))
    const allTodosDoneBefore = ctx.todos.length > 0 && ctx.todos.every((todo) => todo.status === 'completed')
    const interruptedDuringTools = await executeToolCalls(ctx, streamed.message, streamed.toolCalls)
    if (interruptedDuringTools) {
      finalizeInterrupted(ctx)
      return { reason: 'cancelled' }
    }

    const planUpdatedThisStep = streamed.toolCalls.some(
      (call) => call.name === 'todo_write' || call.name === 'update_goal'
    )
    const allTodosDoneAfter = ctx.todos.length > 0 && ctx.todos.every((todo) => todo.status === 'completed')
    const editedAfterDone = streamed.toolCalls.some((call) =>
      ['write_file', 'edit_file', 'delete_file'].includes(call.name)
    )
    // 计划已经全部完成，但模型仍在改文件：追加一个真实的“收尾完善”步骤，避免 UI 显示 6/6 却还在干活。
    if (
      !finishTodoAdded &&
      allTodosDoneBefore &&
      allTodosDoneAfter &&
      editedAfterDone &&
      !planUpdatedThisStep &&
      ctx.depth === 0 &&
      !ctx.demo &&
      !ctx.planMode &&
      ctx.opts.mode !== 'chat' &&
      ctx.opts.mode !== 'research'
    ) {
      finishTodoAdded = true
      const finishTodo = { id: newId('todo'), text: '收尾完善', status: 'in_progress' as const }
      ctx.todos = [...ctx.todos, finishTodo]
      ctx.emit({ type: 'todos_updated', todos: ctx.todos })
      ctx.messages.push({
        id: newId('msg'),
        role: 'user',
        hidden: true,
        createdAt: Date.now(),
        content: [
          {
            type: 'text',
            text:
              '[系统检查] 计划已全部标记完成，但本轮仍在修改文件。已在计划末尾追加「收尾完善（进行中）」；' +
              '如果你还要继续优化，请把它保留为进行中并在真正收尾时标为 completed；如果已经结束，直接停止工具调用并给出最终答复。'
          }
        ]
      })
    }
    // 长任务中每几步提醒一次同步计划/目标，避免只在最后一次性更新。
    if (planUpdatedThisStep || todoSignatureBefore !== lastTodoSignature) {
      planReminderStep = step
    }
    lastTodoSignature = JSON.stringify(ctx.todos.map((todo) => `${todo.id}:${todo.status}`))
    const openTodoCount = ctx.todos.filter((todo) => todo.status !== 'completed').length
    const goalActive = ctx.currentGoal?.status === 'active'
    if (
      (openTodoCount > 0 || goalActive) &&
      step - planReminderStep >= 5 &&
      planReminderRounds < 2 &&
      ctx.depth === 0 &&
      !ctx.demo &&
      !ctx.planMode &&
      ctx.opts.mode !== 'chat' &&
      !ctx.opts.signal.aborted
    ) {
      planReminderRounds += 1
      planReminderStep = step
      ctx.messages.push({
        id: newId('msg'),
        role: 'user',
        hidden: true,
        createdAt: Date.now(),
        content: [
          {
            type: 'text',
            text:
              '[系统检查] 已经连续多步没有更新计划/目标进度。' +
              (openTodoCount > 0
                ? `计划里还有 ${openTodoCount} 项未完成：完成一步就立即用 todo_write 更新；长任务可先追加下一段步骤，不必一次列完。`
                : '') +
              (goalActive ? '目标模式下每完成一部分就用 update_goal 记录 summary 和 nextStep，不要等到最后。' : '')
          }
        ]
      })
    }

    // 不设单轮步数上限，但仍要防止模型原地打转：连续 4 次完全相同的一组调用视为死循环。
    const callSignature = streamed.toolCalls
      .map((call) => `${call.name}:${JSON.stringify(call.input ?? {})}`)
      .join('|')
    if (callSignature === repeatedSignature) repeatedCount += 1
    else {
      repeatedSignature = callSignature
      repeatedCount = 1
    }
    if (repeatedCount >= 4) {
      ctx.emit({
        type: 'notice',
        level: 'warn',
        message: '检测到连续重复的工具调用，已停止以避免死循环。请换一种做法，或把任务拆小后重试。'
      })
      return {
        reason: 'error',
        error: {
          code: 'LOOP_DETECTED',
          message: '检测到连续重复的工具调用，已停止以避免死循环。',
          hint: '换一种做法，或把任务拆小后重试。'
        }
      }
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
  let thinkingStartedAt: number | null = null
  let thinkingLastAt: number | null = null
  const pendingCalls = new Map<number, { id: string; name: string; args: string }>()
  const seenProviderCallIds = new Set<string>()

  const finalizeThinkingDuration = (): void => {
    if (!thinkingBlock || thinkingStartedAt === null) return
    thinkingBlock.durationMs = Math.max(0, (thinkingLastAt ?? thinkingStartedAt) - thinkingStartedAt)
  }

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
    const reasoning = reasoningRequestFor(opts.model, opts.reasoningEffort)
    const request: ProviderStreamRequest = {
      system: ctx.systemPrompt,
      messages: ctx.messages,
      tools: ctx.tools,
      signal: opts.signal,
      workspace: opts.workspace,
      maxTokens: opts.model.maxOutput,
      ...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
      ...(reasoning ? { reasoning } : {})
    }
    for await (const event of iterateWithAbort(opts.provider.stream(request), opts.signal)) {
      switch (event.type) {
        case 'text_delta': {
          ensureText().text += event.text
          ctx.emit({ type: 'message_delta', messageId, textDelta: event.text })
          break
        }
        case 'thinking_delta': {
          const now = Date.now()
          if (thinkingStartedAt === null) thinkingStartedAt = now
          thinkingLastAt = now
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
          // 同一轮里重复的 end 帧（同 index + provider id）只处理一次；
          // 不同 index 复用同一 id 属于两个不同调用，仍交给 allocateToolUseId 重映射。
          const frameKey = `${event.index}:${event.id}`
          if (event.id && seenProviderCallIds.has(frameKey)) {
            pendingCalls.delete(event.index)
            break
          }
          if (event.id) seenProviderCallIds.add(frameKey)
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

    finalizeThinkingDuration()
    // 兜底：只发了 start/delta 没有 end 的工具调用，用累积参数补齐
    for (const [index, call] of pendingCalls) {
      if (!call.name) continue
      const frameKey = `${index}:${call.id}`
      if (call.id && seenProviderCallIds.has(frameKey)) continue
      if (call.id) seenProviderCallIds.add(frameKey)
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
    const toolCalls = dedupeMessageToolCalls(message)
    if (toolCalls.length === 0) {
      // 没有工具的回合：在完成事件前再刷新一次 usage，确保 UI 上下文条准确
      ctx.emit({ type: 'usage_updated', usage: currentUsage(ctx) })
    }
    ctx.emit({ type: 'message_completed', messageId, message: cloneMessage(message) })
    return { message, toolCalls, interrupted: false }
  } catch (err) {
    finalizeThinkingDuration()
    commitRequestUsage(ctx)
    if (isAbortError(err) || opts.signal.aborted) {
      return { message, toolCalls: extractToolCalls(message), interrupted: true }
    }
    const providerError = err instanceof ProviderError ? err : toProviderError(err, 'agent')
    const resultError = providerError.toResultError()
    // 上下文溢出会被主循环压缩后重试，先不向用户弹错误；重试耗尽时由循环统一报告
    const recoverableOverflow = isContextOverflowError(resultError)
    if (!recoverableOverflow) ctx.emit({ type: 'error', error: resultError })
    message.error = resultError
    if (message.content.length === 0) {
      message.content.push({ type: 'error', message: resultError.message, code: resultError.code })
    }
    ctx.emit({ type: 'message_completed', messageId, message: cloneMessage(message) })
    return { message, toolCalls: [], interrupted: false, error: resultError }
  }
}

/** 流式网关可能重复发送同一个 tool_call_end（同 id）：只保留参数更完整的一份，避免重复执行。 */
function dedupeToolCalls(calls: ToolUseBlock[]): ToolUseBlock[] {
  const order: string[] = []
  const byId = new Map<string, ToolUseBlock>()
  for (const call of calls) {
    const existing = byId.get(call.id)
    if (!existing) {
      byId.set(call.id, call)
      order.push(call.id)
      continue
    }
    let existingSize = 0
    let nextSize = 0
    try {
      existingSize = JSON.stringify(existing.input ?? {}).length
      nextSize = JSON.stringify(call.input ?? {}).length
    } catch {
      // 不可序列化时保留先到的
    }
    if (nextSize >= existingSize) byId.set(call.id, call)
  }
  return order.map((id) => byId.get(id)!).filter(Boolean)
}

function dedupeMessageToolCalls(message: ChatMessage): ToolUseBlock[] {
  const calls = message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
  const unique = dedupeToolCalls(calls)
  if (unique.length !== calls.length) {
    const uniqueIds = new Set(unique.map((call) => call.id))
    const seen = new Set<string>()
    message.content = message.content.filter((block) => {
      if (block.type !== 'tool_use') return true
      if (!uniqueIds.has(block.id) || seen.has(block.id)) return false
      seen.add(block.id)
      return true
    })
  }
  return unique
}

function extractToolCalls(message: ChatMessage): ToolUseBlock[] {
  return message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
}

const INTERRUPTED_RESULT: ToolResult = {
  ok: false,
  output: '',
  error: '执行已中断（用户停止了本轮运行）。',
  meta: { interrupted: true }
}

type ToolCallMode = 'main' | 'subagent'

interface ToolCallRunOptions {
  mode: ToolCallMode
  /** main：父 assistant 消息 id；subagent：父 swarm 所在的 assistant 消息 id */
  parentMessageId: string
  /** subagent：父 swarm 的 toolUseId（集群成员工具进度挂到父 swarm 卡片下） */
  parentToolUseId?: string
  /** swarm：当前子任务身份，用于把进度写到对应任务行 */
  swarmTask?: SwarmMemberRequest['swarmTask']
  /** subagent 的工具上下文覆盖（工作区/snapshot/权限与主代理一致，仅禁止嵌套与改 Goal） */
  toolContextOverrides?: { readOnly?: boolean; depth?: number; goal?: Goal | null; allowSubagent?: boolean; planMode?: boolean }
}

interface ToolCallRunResult {
  interrupted: boolean
  result?: ToolResult
}

/** 审批/提问串行化：多个并行集群成员不会同时弹出多个审批卡 */
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
  status?: ToolStatus
): void {
  if (runOptions.mode !== 'subagent' || !runOptions.parentToolUseId) return
  ctx.emit({
    type: 'tool_progress',
    messageId: runOptions.parentMessageId,
    toolUseId: runOptions.parentToolUseId,
    note,
    ...(status ? { status } : {}),
    ...(runOptions.swarmTask
      ? { swarmTask: { ...runOptions.swarmTask, status: 'running' as const, note } }
      : {})
  })
}

/**
 * 执行单个工具调用（权限判定 → 审批 → 真实执行）。
 * 主代理与集群成员共用：集群成员与主代理使用同一套 evaluatePermission / onPermission / sessionGrants / 工作区 / snapshot，
 * 区别只在事件呈现：主代理发 tool_started/finished；集群成员只发 tool_progress（挂到父 swarm 卡片），
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
    attachedFiles: ctx.opts.attachedFiles ?? [],
    isDemo: ctx.demo,
    sessionGrants: ctx.grants,
    workspaceRules: ctx.opts.permissionRules ?? [],
    sessionMode: ctx.opts.mode ?? 'work'
  }
  const isMain = runOptions.mode === 'main'
  const emitStarted = (): void => {
    if (isMain) {
      ctx.emit({ type: 'tool_started', messageId: runOptions.parentMessageId, block: { ...call, input: { ...call.input } } })
    } else {
      emitSubagentProgress(ctx, runOptions, `开始：${call.title}`, 'running')
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
        `${call.title} ${ok ? '完成' : '失败'}${call.result?.error ? `（${truncateText(call.result.error, 160)}）` : ''}`,
        ok ? 'running' : 'error'
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

  let escapeApproved = 'escape' in gate && gate.escape === true
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
      allowAlways: gate.allowAlways !== false,
      createdAt: Date.now()
    }
    let decision: PermissionDecision
    try {
      // 请求事件也必须在串行区内：多个并行集群成员不能同时往 UI 推两张审批卡
      decision = await runSerialized(ctx, async () => {
        if (ctx.opts.signal.aborted) throw abortError()
        ctx.emit({ type: 'permission_requested', request })
        try {
          const resolved = await abortable(ctx.opts.onPermission(request), ctx.opts.signal)
          ctx.emit({ type: 'permission_resolved', requestId: request.id, decision: resolved })
          return resolved
        } catch (err) {
          ctx.emit({ type: 'permission_resolved', requestId: request.id, decision: 'deny' })
          throw err
        }
      })
    } catch (err) {
      if (isAbortError(err) || ctx.opts.signal.aborted) {
        const result: ToolResult = { ...INTERRUPTED_RESULT }
        call.result = result
        call.status = 'interrupted'
        call.finishedAt = Date.now()
        if (!isMain) emitSubagentProgress(ctx, runOptions, `${call.title} 已中断`, 'error')
        return { interrupted: true, result }
      }
      const result: ToolResult = { ok: false, output: '', error: `审批失败：${errorMessage(err)}` }
      call.result = result
      call.status = 'error'
      call.finishedAt = Date.now()
      emitFinished()
      return { interrupted: false, result }
    }
    if (decision === 'always' && gate.allowAlways !== false) ctx.grants.add(gate.signature)
    if (decision === 'deny') {
      const denied = deniedMessage(target, ctx.opts.unattended ? 'unattended' : 'user')
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
      emitSubagentProgress(ctx, runOptions, `获得授权：${call.title}`, 'running')
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
  // 只收尾本轮新建的 assistant 消息；中断发生在首个模型请求前（如压缩阶段）时，
  // 不能把历史里最后一条已完成的 assistant 消息改标为 interrupted。
  const target = ctx.lastMessage ?? [...ctx.newMessages].reverse().find((message) => message.role === 'assistant')
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

function createToolContext(
  ctx: RunContext,
  block: ToolUseBlock,
  messageId: string,
  escapeApproved: boolean,
  overrides: { readOnly?: boolean; depth?: number; goal?: Goal | null; allowSubagent?: boolean; planMode?: boolean } = {}
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
    attachedFiles: opts.attachedFiles ?? [],
    demo: ctx.demo,
    goal: overrides.goal !== undefined ? overrides.goal : ctx.currentGoal,
    planMode: overrides.planMode !== undefined ? overrides.planMode : ctx.planMode,
    getPlan: () => ctx.plan,
    proposePlan: (plan) => proposePlanInRun(ctx, plan),
    emit: (event) => ctx.emit(event),
    updateGoal: overrides.goal === null ? () => null : (patch) => updateGoalInRun(ctx, patch),
    getTodos: () => ctx.todos,
    setTodos: (todos) => {
      ctx.todos = todos
    },
    getArtifacts: () => ctx.artifacts,
    addArtifact: (artifact) => {
      ctx.artifacts = [...ctx.artifacts.filter((item) => item.id !== artifact.id), artifact]
      ctx.emit({ type: 'artifacts_updated', artifacts: ctx.artifacts, artifactId: artifact.id })
    },
    ...(opts.webSearch ? { searchWeb: opts.webSearch } : {}),
    ...(opts.remember ? { remember: opts.remember } : {}),
    ...(opts.ocrPdf ? { ocrPdf: opts.ocrPdf } : {}),
    ...(opts.terminal ? { terminal: opts.terminal } : {}),
    ...(opts.media ? { media: opts.media } : {}),
    ...(opts.studio ? { studio: opts.studio } : {}),
    ...(opts.vision ? { vision: opts.vision } : {}),
    ...(opts.commandShell ? { commandShell: opts.commandShell } : {}),
    askUser: async (request) => {
      // 与审批共用同一条串行队列：并行集群成员一次只弹一张交互卡
      return runSerialized(ctx, async () => {
        if (opts.signal.aborted) throw abortError()
        ctx.emit({ type: 'question_asked', request })
        try {
          const answer = await abortable(opts.onAskUser(request), opts.signal)
          ctx.emit({ type: 'question_answered', requestId: request.id, answer })
          return answer
        } catch (err) {
          ctx.emit({
            type: 'question_answered',
            requestId: request.id,
            answer: { value: 'cancelled', label: '已取消' }
          })
          throw err
        }
      })
    },
    progress: (note, progressOpts) => {
      ctx.emit({
        type: 'tool_progress',
        messageId,
        toolUseId: block.id,
        note,
        ...(progressOpts?.status ? { status: progressOpts.status } : {}),
        ...(progressOpts?.title ? { title: progressOpts.title } : {}),
        ...(typeof progressOpts?.percent === 'number' ? { percent: Math.min(100, Math.max(0, Math.round(progressOpts.percent))) } : {}),
        ...(progressOpts?.swarmTask ? { swarmTask: progressOpts.swarmTask } : {})
      })
    },
    agents: opts.agents ?? [],
    runSwarmMember:
      overrides.allowSubagent === false
        ? async () => ({
            status: 'failed' as const,
            summary: '',
            steps: 0,
            usage: { inputTokens: 0, outputTokens: 0 },
            error: '集群成员不能再启动集群。'
          })
        : (request) => runSwarmMemberLoop(ctx, request, messageId, block.id)
  }
}

/**
 * Goal 模式：合并 update_goal 补丁 → 更新当前目标 → emit goal_updated（完整 Goal 快照）。
 * 返回更新后的 Goal（供工具结果使用）。
 */
/**
 * 计划模式：提交/替换本轮计划并广播。
 * 计划先进入 pending，等待用户批准；批准与执行由主进程驱动。
 */
function proposePlanInRun(ctx: RunContext, plan: SessionPlan): SessionPlan {
  const next: SessionPlan = {
    ...plan,
    status: 'pending',
    updatedAt: Date.now()
  }
  ctx.plan = next
  ctx.emit({ type: 'plan_updated', plan: { ...next }, planMode: true })
  return next
}

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

/**
 * 集群成员循环（R9.1：与主代理**权限完全一致**）：
 * - 工具集 = 主代理当前工具集 - swarm（防嵌套）- update_goal（防篡改父目标）- todo_write（防改主计划）；
 * - 同一 permissionMode/mode/工作区/snapshot/MCP 配置；
 * - 写文件/跑命令/mcp_call 走主代理同一套 evaluatePermission + onPermission（审批卡出现在父级 UI）；
 * - 成员与主代理同权限：父任务只读时成员也只读；角色不再限制工具或只读；
 * - 终态 failed/exhausted/cancelled 由 swarm 工具转成 ok=false，不被文字完成覆盖。
 */
async function runSwarmMemberLoop(
  parent: RunContext,
  request: SwarmMemberRequest,
  messageId: string,
  toolUseId: string
): Promise<SwarmMemberResult> {
  const opts = parent.opts
  const role: SwarmMemberRole | undefined =
    request.role ?? parent.opts.agents?.find((item) => item.name === 'general')
  const roleTitle = role?.title ?? '集群成员'
  const emitProgress = (
    note: string,
    status: ToolStatus = 'running',
    stepCount?: number,
    operations?: SwarmOperation[]
  ): void => {
    parent.emit({
      type: 'tool_progress',
      messageId,
      toolUseId,
      note: `${roleTitle} · ${note}`,
      status,
      ...(typeof stepCount === 'number' ? { stepCount } : {}),
      ...(request.swarmTask
        ? {
            swarmTask: {
              ...request.swarmTask,
              status: 'running' as const,
              note,
              ...(typeof stepCount === 'number' ? { stepCount } : {}),
              ...(operations && operations.length > 0 ? { operations: operations.map((op) => ({ ...op })) } : {})
            }
          }
        : {})
    })
  }
  // 与主代理完全一致的工具集；只去掉会破坏父任务的嵌套集群/目标/计划工具。
  // 角色只改变工作重点和提示，不再限制工具或只读。
  const memberTools = parent.tools.filter(
    (tool) => tool.name !== 'swarm' && tool.name !== 'update_goal' && tool.name !== 'todo_write'
  )
  const systemPrompt = [
    buildSystemPrompt({
      workspace: opts.workspace,
      permissionMode: parent.effectiveMode,
      mode: opts.mode,
      projectContext: opts.projectContext ?? opts.projectMemory,
      modelLabel: opts.model.label,
      tools: memberTools
    }),
    `## 集群成员：${roleTitle}`,
    role?.systemPrompt ??
      '你是主代理派出的集群成员。你拥有与主代理相同的工具和工作区访问权限：可以读文件、写文件、运行命令、调用 MCP；涉及写入/命令/MCP 的操作会按主代理当前的权限模式向用户请求审批。',
    '角色只决定你的工作重点，不限制工具或权限。涉及写入/命令/MCP 的操作会按主代理当前的权限模式向用户请求审批，审批记录归属本轮主任务。',
    ROLE_SKILL_BOUNDARY,
    '你不能启动新的集群、不能更新父任务的目标状态，也不要改动主任务的计划面板；请把结论与真实产出路径返回给主代理。'
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
  let outcome: SwarmMemberResult['status'] = 'failed'
  const failedTools: string[] = []
  const changedFiles = new Map<string, Record<string, unknown>>()
  const operations: SwarmOperation[] = []
  const recordOperation = (call: ToolUseBlock, startedAt: number): void => {
    const result = call.result
    const input = (() => {
      try {
        return truncateText(JSON.stringify(call.input ?? {}), 220)
      } catch {
        return ''
      }
    })()
    operations.push({
      id: call.id,
      name: call.name,
      title: call.title,
      status: call.status,
      ...(input ? { input } : {}),
      ...(result?.ok ? { output: truncateText(result.output ?? '', 320) } : {}),
      ...(result && result.ok === false
        ? { error: truncateText(result.error ?? result.output ?? '未知错误', 320) }
        : {}),
      startedAt,
      finishedAt: call.finishedAt ?? Date.now()
    })
    emitProgress(
      `${call.status === 'error' || call.status === 'denied' ? '未完成' : '完成'}：${call.title || call.name}`,
      call.status,
      steps,
      operations
    )
  }

  try {
  let repeatedSignature = ''
  let repeatedCount = 0
  let memberOverflowRetries = 0
  for (let step = 1; ; step += 1) {
    if (opts.signal.aborted) throw abortError()
    steps = step
    // 与主代理同款压缩：优先模型摘要，失败再退回本地摘要；不设步数上限，靠死循环检测收口
    const compactPlan = planCompaction(messages, systemPrompt, opts.model.contextWindow, {
      threshold: opts.compactThreshold,
      keepRecent: opts.keepRecent
    })
    let compactedStep = false
    let compactSaved = 0
    if (compactPlan.shouldCompact) {
      const older = messages.slice(0, compactPlan.cutIndex)
      let compactSummary = ''
      try {
        const summarized = await summarizeHistory({
          provider: opts.provider,
          model: opts.model,
          signal: opts.signal,
          older,
          ...(compactPlan.existingSummary ? { previousSummary: compactPlan.existingSummary } : {})
        })
        compactSummary = summarized.text
        if (!compactSummary.trim()) throw new Error('摘要为空')
        if (summarized.usage) {
          usage.inputTokens += summarized.usage.inputTokens
          usage.outputTokens += summarized.usage.outputTokens
          if (typeof summarized.usage.cacheReadTokens === 'number') {
            usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + summarized.usage.cacheReadTokens
          }
        }
      } catch (err) {
        if (isAbortError(err) || opts.signal.aborted) throw err
        compactSummary = localExtractSummary(older)
      }
      const before = estimateMessagesTokens(messages, systemPrompt)
      messages.splice(
        0,
        messages.length,
        ...applyCompaction(messages, compactPlan.cutIndex, compactSummary)
      )
      if (
        compactPlan.overTarget ||
        estimateMessagesTokens(messages, systemPrompt) > opts.model.contextWindow * 0.9
      ) {
        messages.splice(
          0,
          messages.length,
          ...aggressiveTrim(messages, systemPrompt, opts.model.contextWindow, 4)
        )
      }
      compactSaved = Math.max(0, before - estimateMessagesTokens(messages, systemPrompt))
      compactedStep = true
    }
    emitProgress(
      compactedStep
        ? `第 ${step} 步：上下文已压缩${compactSaved > 0 ? `（约 ${Math.round(compactSaved / 1000)}k tokens）` : ''}，继续分析…`
        : `第 ${step} 步：分析中…`,
      'running',
      step
    )
    const assistant: ChatMessage = {
      id: newId('msg'),
      role: 'assistant',
      content: [],
      createdAt: Date.now(),
      model: opts.model.id
    }
    let text = ''
    const streamedCalls: ToolUseBlock[] = []
    const seenProviderCallIds = new Set<string>()
    let requestUsage: Usage = { inputTokens: 0, outputTokens: 0 }
    const reasoning = reasoningRequestFor(opts.model, opts.reasoningEffort)
    try {
      for await (const event of iterateWithAbort(
        opts.provider.stream({
          system: systemPrompt,
          messages: [...messages],
          tools: memberTools,
          signal: opts.signal,
          workspace: opts.workspace,
          maxTokens: opts.model.maxOutput,
          ...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
          ...(reasoning ? { reasoning } : {})
        }),
        opts.signal
      )) {
        switch (event.type) {
          case 'text_delta':
            text += event.text
            break
          case 'tool_call_end': {
            const frameKey = `${event.index}:${event.id}`
            if (event.id && seenProviderCallIds.has(frameKey)) break
            if (event.id) seenProviderCallIds.add(frameKey)
            const input = event.input ?? {}
            // 与主代理共用唯一 id 分配：并行集群成员/主代理的工具 id 不会撞到同一快照目录
            const toolUseId = allocateToolUseId(parent, event.id)
            if (event.parseError) parent.toolParseErrors.set(toolUseId, event.parseError)
            streamedCalls.push({
              type: 'tool_use',
              id: toolUseId,
              name: event.name,
              title: toolTitleFor(event.name, input),
              category: toolCategory(event.name),
              input,
              status: 'running'
            })
            break
          }
          case 'usage':
            requestUsage = {
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              ...(typeof event.usage.cacheReadTokens === 'number'
                ? { cacheReadTokens: event.usage.cacheReadTokens }
                : {})
            }
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
      const overflow =
        err instanceof ProviderError
          ? isContextOverflowError(err.toResultError())
          : isContextOverflowError({ message: err instanceof Error ? err.message : String(err) })
      if (overflow && memberOverflowRetries < 2) {
        memberOverflowRetries += 1
        const emergency = planCompaction(messages, systemPrompt, opts.model.contextWindow, {
          force: true,
          targetRatio: 0.35
        })
        if (emergency.shouldCompact) {
          let emergencySummary = ''
          try {
            const summarized = await summarizeHistory({
              provider: opts.provider,
              model: opts.model,
              signal: opts.signal,
              older: messages.slice(0, emergency.cutIndex),
              ...(emergency.existingSummary ? { previousSummary: emergency.existingSummary } : {})
            })
            emergencySummary = summarized.text
          } catch (summaryError) {
            if (isAbortError(summaryError) || opts.signal.aborted) throw summaryError
            emergencySummary = localExtractSummary(messages.slice(0, emergency.cutIndex))
          }
          messages.splice(
            0,
            messages.length,
            ...applyCompaction(messages, emergency.cutIndex, emergencySummary || localExtractSummary([]))
          )
        }
        messages.splice(
          0,
          messages.length,
          ...aggressiveTrim(messages, systemPrompt, opts.model.contextWindow, 4)
        )
        emitProgress('上下文已满，已折叠历史后重试本步…', 'running', step)
        continue
      }
      lastError = err instanceof Error ? err.message : String(err)
      outcome = 'failed'
      break
    }
    // 重复 end 帧只执行一次
    if (streamedCalls.length > 1) {
      const unique = dedupeToolCalls(streamedCalls)
      if (unique.length !== streamedCalls.length) {
        streamedCalls.splice(0, streamedCalls.length, ...unique)
        const ids = new Set(unique.map((call) => call.id))
        const seen = new Set<string>()
        assistant.content = assistant.content.filter((block) => {
          if (block.type !== 'tool_use') return true
          if (!ids.has(block.id) || seen.has(block.id)) return false
          seen.add(block.id)
          return true
        })
      }
    }
    usage.inputTokens += requestUsage.inputTokens
    usage.outputTokens += requestUsage.outputTokens
    if (typeof requestUsage.cacheReadTokens === 'number') {
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + requestUsage.cacheReadTokens
    }

    if (text.trim()) assistant.content.push({ type: 'text', text })
    for (const call of streamedCalls) assistant.content.push(call)
    if (assistant.content.length === 0) assistant.content.push({ type: 'text', text: '（集群成员没有返回内容）' })
    messages.push(assistant)
    summary = text.trim() || summary
    if (text.trim()) {
      emitProgress(text.replace(/\s+/g, ' ').trim().slice(0, 80))
    }

    if (streamedCalls.length === 0) {
      if (text.trim()) outcome = 'completed'
      else {
        outcome = 'failed'
        lastError = lastError ?? '集群成员没有返回任何结论'
      }
      break
    }
    // 与主代理完全相同的权限/执行链；集群成员不能嵌套 swarm、不能 update_goal
    for (const call of streamedCalls) {
      if (opts.signal.aborted) throw abortError()
      if (call.name === 'update_goal') {
        call.result = {
          ok: false,
          output: '',
          error: '集群成员不能更新父任务的目标状态。',
          hint: '请把结论返回给主代理，由主代理决定是否 update_goal。'
        }
        call.status = 'error'
        call.finishedAt = Date.now()
        failedTools.push('update_goal：仅主代理可用')
        recordOperation(call, call.finishedAt)
        continue
      }
      if (call.name === 'todo_write') {
        call.result = {
          ok: false,
          output: '',
          error: '集群成员不能修改主任务的计划面板。',
          hint: '请把步骤进展写进最终结论，由主代理更新计划。'
        }
        call.status = 'error'
        call.finishedAt = Date.now()
        failedTools.push('todo_write：仅主代理可用')
        recordOperation(call, call.finishedAt)
        continue
      }
      const operationStarted = Date.now()
      const runResult = await runToolCallWithPermissions(parent, call, {
        mode: 'subagent',
        parentMessageId: messageId,
        parentToolUseId: toolUseId,
        ...(request.swarmTask ? { swarmTask: request.swarmTask } : {}),
        toolContextOverrides: {
          readOnly: parent.readOnly,
          depth: parent.depth + 1,
          goal: null,
          allowSubagent: false,
          planMode: false
        }
      })
      if (runResult.interrupted || opts.signal.aborted) throw abortError()
      recordOperation(call, operationStarted)
      if (call.result && call.result.ok === false) {
        failedTools.push(`${call.name}：${call.result.error ?? call.result.output ?? '未知错误'}`)
      }
      const meta = call.result?.ok === true ? (call.result.meta as Record<string, unknown> | undefined) : undefined
      const deleted = meta?.deleted === true
      if (
        meta &&
        typeof meta.absolutePath === 'string' &&
        (typeof meta.afterHash === 'string' || deleted)
      ) {
        const added = typeof meta.diffAdded === 'number' ? meta.diffAdded : 0
        const removed = typeof meta.diffRemoved === 'number' ? meta.diffRemoved : 0
        const existing = changedFiles.get(meta.absolutePath)
        // 集群成员本轮新建后删除：净零，不把临时文件带回父检查点。
        if (deleted && existing?.created === true) {
          changedFiles.delete(meta.absolutePath)
          continue
        }
        if (existing) {
          existing.afterHash = typeof meta.afterHash === 'string' ? meta.afterHash : null
          existing.deleted = deleted
          existing.diffAdded = (typeof existing.diffAdded === 'number' ? existing.diffAdded : 0) + added
          existing.diffRemoved = (typeof existing.diffRemoved === 'number' ? existing.diffRemoved : 0) + removed
        } else {
          changedFiles.set(meta.absolutePath, {
            absolutePath: meta.absolutePath,
            created: meta.created === true,
            deleted,
            beforeHash: typeof meta.beforeHash === 'string' ? meta.beforeHash : null,
            afterHash: typeof meta.afterHash === 'string' ? meta.afterHash : null,
            diffAdded: added,
            diffRemoved: removed,
            ...(typeof meta.snapshotPath === 'string' ? { snapshotPath: meta.snapshotPath } : {})
          })
        }
      }
    }

    const callSignature = streamedCalls
      .map((call) => `${call.name}:${JSON.stringify(call.input ?? {})}`)
      .join('|')
    if (callSignature === repeatedSignature) repeatedCount += 1
    else {
      repeatedSignature = callSignature
      repeatedCount = 1
    }
    if (repeatedCount >= 4) {
      lastError = '集群成员连续重复相同的工具调用，已停止以避免死循环。'
      outcome = 'failed'
      break
    }
  }

  } finally {
    // 集群成员的 token 也属于本次用户运行；计入父用量，避免并行集群成员的成本/计费不可见
    if (usage.inputTokens > 0 || usage.outputTokens > 0) {
      parent.usage = addUsage(parent.usage, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(typeof usage.cacheReadTokens === 'number' ? { cacheReadTokens: usage.cacheReadTokens } : {})
      })
    }
  }

  if (!lastError && !summary.trim()) lastError = '集群成员没有返回最终结论'
  return {
    status: outcome,
    summary: truncateText(summary || '（集群成员没有给出最终结论）', 4000),
    steps,
    usage,
    ...(role ? { role: role.name } : {}),
    ...(lastError ? { error: lastError } : {}),
    ...(failedTools.length > 0 ? { failedTools: failedTools.slice(0, 20) } : {}),
    ...(operations.length > 0 ? { operations } : {}),
    ...(changedFiles.size > 0 ? { changedFiles: [...changedFiles.values()].slice(0, 100) } : {})
  }
}

async function maybeCompact(
  ctx: RunContext,
  options: { force?: boolean; targetRatio?: number } = {}
): Promise<boolean> {
  if (!options.force && ctx.opts.autoCompact === false) return false
  const plan = planCompaction(ctx.messages, ctx.systemPrompt, ctx.opts.model.contextWindow, {
    threshold: ctx.opts.compactThreshold,
    keepRecent: ctx.opts.keepRecent,
    targetRatio: options.targetRatio,
    force: options.force
  })
  if (!plan.shouldCompact) {
    if (plan.reason === 'no-safe-cut' && plan.estimatedTokens > plan.thresholdTokens) {
      // 短历史/只有摘要时无法安全切段：只折叠过大的工具输出，绝不删除任何消息，
      // 也不设置 compacted（否则主进程会把不完整历史写回会话）。
      const before = estimateMessagesTokens(ctx.messages, ctx.systemPrompt)
      const shrunk = shrinkToolOutputs(ctx.messages)
      const after = estimateMessagesTokens(shrunk, ctx.systemPrompt)
      if (after < before) {
        ctx.messages = shrunk
        ctx.lastRequestUsage = null
        ctx.emit({ type: 'usage_updated', usage: currentUsage(ctx) })
        ctx.emit({ type: 'notice', level: 'info', message: '已折叠过大的工具输出，对话本身保持不变。' })
      } else {
        ctx.emit({
          type: 'notice',
          level: 'warn',
          message: '上下文接近上限，但当前没有可安全压缩的历史；已保留全部对话，继续当前步骤。'
        })
      }
    }
    return false
  }
  ctx.emit({ type: 'compaction', phase: 'started' })
  const older = ctx.messages.slice(0, plan.cutIndex)
  let summaryText: string
  try {
    const summary = await summarizeHistory({
      provider: ctx.opts.provider,
      model: ctx.opts.model,
      signal: ctx.opts.signal,
      older,
      ...(plan.existingSummary ? { previousSummary: plan.existingSummary } : {})
    })
    summaryText = summary.text
    if (!summaryText.trim()) throw new Error('摘要为空')
    if (summary.usage) {
      // 摘要请求也是真实消耗；计入本轮用量，但不要覆盖当前对话的 contextUsed
      ctx.usage = addUsage(ctx.usage, {
        inputTokens: summary.usage.inputTokens,
        outputTokens: summary.usage.outputTokens,
        ...(typeof summary.usage.cacheReadTokens === 'number' ? { cacheReadTokens: summary.usage.cacheReadTokens } : {})
      })
    }
  } catch (err) {
    if (isAbortError(err) || ctx.opts.signal.aborted) throw err
    summaryText = localExtractSummary(older)
    ctx.emit({ type: 'notice', level: 'warn', message: '自动摘要失败，已用本地摘要压缩历史，对话可以继续。' })
  }
  const beforeTokens = estimateMessagesTokens(ctx.messages, ctx.systemPrompt)
  ctx.messages = applyCompaction(ctx.messages, plan.cutIndex, summaryText)
  let afterTokens = estimateMessagesTokens(ctx.messages, ctx.systemPrompt)
  // 摘要模型偶尔会写长，或保留段本身过大：再折一刀工具输出/过老消息，绝不让下一步撞上下文上限。
  if (plan.overTarget || afterTokens > plan.thresholdTokens || afterTokens > ctx.opts.model.contextWindow * 0.9) {
    ctx.messages = aggressiveTrim(ctx.messages, ctx.systemPrompt, ctx.opts.model.contextWindow, 4)
    afterTokens = estimateMessagesTokens(ctx.messages, ctx.systemPrompt)
    ctx.emit({
      type: 'notice',
      level: 'info',
      message: `上下文已深度折叠到约 ${Math.round(afterTokens / 1000)}k tokens，继续执行。`
    })
  }
  ctx.compacted = true
  // 压缩后旧的 provider usage 已不代表当前上下文，改用新消息估算，避免上下文条停留在压缩前
  ctx.lastRequestUsage = null
  ctx.emit({
    type: 'compaction',
    phase: 'finished',
    savedTokens: Math.max(0, beforeTokens - afterTokens),
    beforeTokens,
    afterTokens
  })
  // 压缩摘要立即出现在当前对话里，而不是等本轮结束才替换历史
  ctx.emit({ type: 'messages_replaced', messages: ctx.messages })
  ctx.emit({ type: 'usage_updated', usage: currentUsage(ctx) })
  return true
}

interface SummarizeHistoryOptions {
  provider: Provider
  model: ModelInfo
  signal: AbortSignal
  older: ChatMessage[]
}

/** 用模型把较早的历史压成结构化摘要（供自动压缩与手动 /compact 共用） */
async function summarizeHistory(
  options: SummarizeHistoryOptions & { previousSummary?: string }
): Promise<{ text: string; usage?: Usage }> {
  // 摘要请求本身也要装进上下文：按窗口给足细节，同时给小窗口留出余量
  const contextWindow = options.model.contextWindow > 0 ? options.model.contextWindow : 32_000
  const summaryInputChars = Math.max(12_000, Math.min(60_000, Math.floor(contextWindow * 0.5)))
  const serialized = serializeMessagesForSummary(options.older, summaryInputChars)
  const system = [
    '你是对话压缩器，也是长任务交接摘要器。把历史对话压缩成一份让另一个同款代理不看原文也能继续工作的结构化交接摘要。',
    '严格按以下标题输出；没有内容写“无”：',
    '## 目标与用户意图',
    '## 硬约束与偏好（逐字保留用户明确要求与禁止项）',
    '## 已完成与关键决策',
    '## 文件与改动（路径、用途、关键改动结论）',
    '## 命令、测试与真实结果',
    '## 错误与修复',
    '## 当前状态（进行到哪一步，哪些动作已经执行）',
    '## 未完成与下一步',
    '## 必须保留的数据（数字、ID、URL、引用）',
    '规则：路径、命令、数字、错误信息原文照抄；不编造；不调用工具；不向用户提问；只输出摘要正文。',
    '如果给了“已有摘要”，请把它与新增历史合并成更新后的完整摘要，保留仍有效的约束、文件状态和待办，不要简单复述旧摘要。'
  ].join('\n')
  const message: ChatMessage = {
    id: newId('msg'),
    role: 'user',
    content: [
      {
        type: 'text',
        text: [
          ...(options.previousSummary ? [`【已有摘要】\n${options.previousSummary}`, ''] : []),
          '【新增历史】',
          serialized
        ].join('\n')
      }
    ],
    createdAt: Date.now()
  }
  let text = ''
  let usage: Usage | undefined
  for await (const event of iterateWithAbort(
    options.provider.stream({
      system,
      messages: [message],
      tools: [],
      signal: options.signal,
      workspace: null,
      maxTokens: Math.min(4000, Math.max(1200, Math.floor(contextWindow * 0.06)))
    }),
    options.signal
  )) {
    if (event.type === 'text_delta') text += event.text
    else if (event.type === 'usage') usage = event.usage
  }
  const trimmed = text.trim()
  if (!trimmed) throw new Error('摘要为空')
  return { text: truncateText(trimmed, 12_000), usage }
}

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
  /** 摘要请求自身的 token 用量（计入会话总用量） */
  summaryUsage?: Usage
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
  let summaryUsage: Usage | undefined
  try {
    const summary = await summarizeHistory({
      provider,
      model,
      signal,
      older,
      ...(plan.existingSummary ? { previousSummary: plan.existingSummary } : {})
    })
    summaryText = summary.text
    summaryUsage = summary.usage
    if (!summaryText.trim()) throw new Error('摘要为空')
  } catch (err) {
    if (isAbortError(err) || signal.aborted) {
      return { messages, compacted: false, savedTokens: 0, error: toResultError(err) }
    }
    summaryText = localExtractSummary(older)
  }
  let compactedMessages = applyCompaction(messages, plan.cutIndex, summaryText)
  if (plan.overTarget || estimateMessagesTokens(compactedMessages, systemPrompt) > contextLimit * 0.9) {
    compactedMessages = aggressiveTrim(compactedMessages, systemPrompt, contextLimit, 4)
  }
  const after = estimateMessagesTokens(compactedMessages, systemPrompt)
  return {
    messages: compactedMessages,
    compacted: true,
    savedTokens: Math.max(0, plan.estimatedTokens - after),
    summary: summaryText,
    ...(summaryUsage ? { summaryUsage } : {})
  }
}

/** 只估算，不触发压缩：用于 UI 上下文条 */
export function estimateContextUsage(
  messages: ChatMessage[],
  systemPrompt: string,
  contextLimit: number
): { used: number; limit: number; ratio: number } {
  const used = estimateMessagesTokens(messages, systemPrompt)
  return { used, limit: contextLimit, ratio: contextLimit > 0 ? used / contextLimit : 0 }
}
