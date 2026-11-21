/**
 * 把桌面的 22 种 `RuntimeEvent` 裁成手机端真正需要的字段。
 *
 * ## 为什么要裁，而不是原样转发
 *
 * 1. **体积**：`tool_finished.result` 可能是整段命令输出或文件内容；
 *    `artifacts_updated.artifacts[].content` 是完整 HTML —— 一次几 MB，
 *    而手机端 `EventParser` 对这两处的处理都是 `Ignore`，传了也不显示。
 * 2. **无谓暴露**：运行事件里的工具参数可能带路径、token、用户原文。
 *    手机只看状态与消息正文，不需要这些。
 * 3. **协议稳定**：手机端解析器是穷举式 `when`，字段缺失必须是「没传」，
 *    不能是 `undefined` 序列化后变成 `null`（会把已有内容清空）。
 *
 * 这里**不做**权限过滤：下行帧已经在 AES-GCM 通道里，接收方是本机配对过的
 * 手机；真正的“最小可见信息”约束在推送通知（`notify/NotifyContent`）那一层。
 */
import type {
  Artifact,
  ChatMessage,
  PermissionRequest,
  RuntimeEvent,
  SuperAgentState
} from '../shared/types'
import { messagePlainText } from '../shared/types'

export interface PhoneEvent {
  type: string
  runId: string
  sessionId: string
  at: number
  [key: string]: unknown
}

/** 单条消息正文上限：手机屏幕不需要 100 KB 的单条消息 */
const MAX_MESSAGE_TEXT = 20_000
/** 快照里每个会话最多带多少条消息（最近优先） */
export const SNAPSHOT_MESSAGES_PER_SESSION = 40
/** `messages_replaced` 最多带多少条 */
const MAX_REPLACED_MESSAGES = 120

/**
 * 首连 / 补漏不足时下发的全量快照。
 *
 * 手机端把它当作「一次到位」的状态：会话、消息、运行、待审批、产物、成员。
 * 字段名与各增量事件保持一致，手机可以用同一套投影函数解析，
 * 不需要为快照再写一份 schema。
 */
export interface PhoneSnapshot {
  at: number
  activeSessionId: string | null
  sessions: Array<{
    id: string
    title: string
    liveMessageId: string | null
    messages: Array<Record<string, unknown>>
    artifacts: Array<Record<string, unknown>>
    superAgent: Record<string, unknown> | null
  }>
  runs: Array<{ sessionId: string; runId: string; startedAtMillis: number; stepCount: number }>
  approvals: Array<Record<string, unknown>>
  artifacts: Array<Record<string, unknown>>
  artifactsSessionId: string | null
  members: Record<string, unknown> | null
}

const clamp = (value: string, max = 2_000): string => (value.length > max ? value.slice(0, max) : value)

/** 桌面 `ChatMessage` → 手机 `UiMessage` 需要的四字段。 */
export function phoneMessage(message: ChatMessage): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    text: clamp(messagePlainText(message), MAX_MESSAGE_TEXT),
    createdAt: message.createdAt
  }
}

/**
 * 桌面成品 → 手机产物视图。
 *
 * 刻意不带 `content`：手机只需要标题/类型/时间；带了会让每次产物更新都
 * 重传完整 HTML。手机端对 `bytes` 的显示会退化成「—」，这是如实反映
 * 「桌面没把正文传过来」，不是编造一个 0。
 */
export function phoneArtifact(artifact: Artifact): Record<string, unknown> {
  return {
    title: artifact.title,
    ...(artifact.path ? { path: artifact.path } : {}),
    kind: artifact.kind,
    ...(artifact.language ? { language: artifact.language } : {}),
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt
  }
}

/** 审批请求只下发手机审批页真正展示与判定要用的字段，不带工具参数原文。 */
export function phonePermission(request: PermissionRequest): Record<string, unknown> {
  return {
    id: request.id,
    toolName: request.toolName,
    title: clamp(request.title, 200),
    summary: clamp(request.summary, 600),
    category: request.category,
    risk: request.risk,
    ...(typeof request.allowAlways === 'boolean' ? { allowAlways: request.allowAlways } : {}),
    createdAt: request.createdAt
  }
}

/**
 * 协作状态 → 手机成员列表需要的形状。
 *
 * 手机 `IgnoreBridges.membersOf` 读的是 `{ state: { tasks: [...] } }`，
 * 所以这里保留外层 `state` 结构、只裁字段，不重新发明一套 schema。
 */
export function phoneSuperState(state: SuperAgentState | null | undefined): Record<string, unknown> | null {
  if (!state) return null
  return {
    status: state.status,
    goal: clamp(state.goal, 800),
    tasks: state.tasks.slice(0, 20).map((task) => ({
      index: task.index,
      title: clamp(task.title, 200),
      agent: 'general',
      ...(task.roleTitle ? { agentTitle: clamp(task.roleTitle, 120) } : {}),
      status: task.status,
      ...(typeof task.stepCount === 'number' ? { stepCount: task.stepCount } : {}),
      ...(task.note ? { note: clamp(task.note, 400) } : {}),
      ...(task.summary ? { summary: clamp(task.summary, 800) } : {}),
      ...(task.error ? { error: clamp(task.error, 600) } : {})
    }))
  }
}

/**
 * 单条事件裁剪。返回 null = 这条事件对手机没有意义，不占用序号也不占带宽。
 *
 * 被丢掉的是：`question_asked`（手机没有提问 UI）、`collaboration_updated`
 * （手机用 `super_updated` 的成员视图）、`episodes_captured`、`demo_step`。
 */
export function toPhoneEvent(event: RuntimeEvent): PhoneEvent | null {
  const base = {
    type: event.type,
    runId: event.runId,
    sessionId: event.sessionId,
    at: event.at
  }

  switch (event.type) {
    case 'run_started':
      return { ...base, userMessage: phoneMessage(event.userMessage), assistantMessageId: event.assistantMessageId }
    case 'run_finished':
      return { ...base, reason: event.reason }
    case 'message_started':
      return { ...base, messageId: event.messageId, role: event.role }
    case 'message_delta':
      return {
        ...base,
        messageId: event.messageId,
        ...(event.textDelta !== undefined ? { textDelta: clamp(event.textDelta, MAX_MESSAGE_TEXT) } : {}),
        ...(event.thinkingDelta !== undefined ? { thinkingDelta: clamp(event.thinkingDelta, MAX_MESSAGE_TEXT) } : {})
      }
    case 'message_completed':
      return { ...base, messageId: event.messageId, message: phoneMessage(event.message) }
    case 'messages_replaced':
      return {
        ...base,
        messages: event.messages.slice(-MAX_REPLACED_MESSAGES).map(phoneMessage)
      }
    case 'session_updated':
      return { ...base, title: event.title ?? event.meta.title }
    case 'permission_requested':
      return { ...base, request: phonePermission(event.request) }
    case 'permission_resolved':
      return { ...base, requestId: event.requestId, decision: event.decision }
    case 'tool_started':
      // 工具输入可能包含完整文件内容/命令；手机端只用于「哪个消息在执行工具」。
      return { ...base, messageId: event.messageId }
    case 'tool_progress':
      return {
        ...base,
        messageId: event.messageId,
        toolUseId: event.toolUseId,
        ...(event.status ? { status: event.status } : {}),
        ...(event.title ? { title: clamp(event.title, 200) } : {}),
        ...(event.note ? { note: clamp(event.note, 400) } : {}),
        ...(typeof event.percent === 'number' ? { percent: event.percent } : {}),
        ...(typeof event.stepCount === 'number' ? { stepCount: event.stepCount } : {}),
        ...(event.memberTask ? { memberTask: event.memberTask } : {})
      }
    case 'tool_finished':
      // 结果可能包含命令输出/文件内容；手机不展示，只保留完成与中断状态。
      return {
        ...base,
        messageId: event.messageId,
        toolUseId: event.toolUseId,
        ...(event.interrupted ? { interrupted: true } : {}),
        ...(event.denied ? { denied: true } : {})
      }
    case 'usage_updated':
      return {
        ...base,
        usage: {
          ...(typeof event.usage.inputTokens === 'number' ? { inputTokens: event.usage.inputTokens } : {}),
          ...(typeof event.usage.outputTokens === 'number' ? { outputTokens: event.usage.outputTokens } : {})
        }
      }
    case 'artifacts_updated':
      return {
        ...base,
        artifacts: event.artifacts.slice(-40).map(phoneArtifact),
        ...(event.artifactId ? { artifactId: event.artifactId } : {})
      }
    case 'todos_updated':
      return {
        ...base,
        todos: event.todos.map((todo) => ({ id: todo.id, text: clamp(todo.text, 200), status: todo.status }))
      }
    case 'super_updated':
      return { ...base, state: phoneSuperState(event.state) }
    case 'goal_updated':
      return {
        ...base,
        goal: event.goal
          ? {
              status: event.goal.status,
              round: event.goal.round,
              maxRounds: event.goal.maxRounds,
              ...(typeof event.goal.stopReason === 'string' ? { stopReason: clamp(event.goal.stopReason, 200) } : {})
            }
          : null
      }
    case 'plan_updated':
      return { ...base, planMode: event.planMode, plan: event.plan ? { title: clamp(event.plan.title, 200) } : null }
    case 'research_updated':
      return { ...base, research: event.research ? { status: event.research.status } : null }
    case 'queue_updated':
      return { ...base, queue: event.queue.slice(0, 20).map((item) => ({ id: item.id, text: clamp(item.text, 500) })) }
    case 'compaction':
      return {
        ...base,
        phase: event.phase,
        ...(typeof event.savedTokens === 'number' ? { savedTokens: event.savedTokens } : {})
      }
    case 'notice':
      return { ...base, level: event.level, message: clamp(event.message, 600), ...(event.code ? { code: event.code } : {}) }
    case 'error':
      return { ...base, error: { code: event.error.code, message: clamp(event.error.message, 600) } }
    case 'question_asked':
    case 'question_answered':
    case 'collaboration_updated':
    case 'episodes_captured':
    case 'demo_step':
      return null
    default: {
      // 穷举保护：将来新增事件时这里会是 `never`，编译报错而不是静默丢弃。
      const unexpected: never = event
      void unexpected
      return null
    }
  }
}