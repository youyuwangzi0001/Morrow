/**
 * Morrow 内核（src/core）公共类型。
 *
 * 约束：core 是纯 TypeScript 运行时，不 import electron / react / DOM；
 * 只依赖 Node 内置模块（fs/path/child_process/crypto）与 src/shared 契约。
 */
import type {
  Artifact,
  AskUserAnswer,
  AskUserRequest,
  ChatMessage,
  Goal,
  PermissionMode,
  RuntimeEvent,
  TodoItem,
  ToolCategory,
  ToolResult,
  ToolRisk,
  ToolStatus,
  Usage
} from '../shared/types'

export type {
  Artifact,
  AskUserAnswer,
  AskUserRequest,
  ChatMessage,
  Goal,
  GoalStatus,
  ModelInfo,
  ModelRef,
  PermissionDecision,
  PermissionMode,
  PermissionPreview,
  PermissionRequest,
  ProviderConfig,
  ProviderKind,
  ProviderTestResult,
  ResultError,
  RunFinishReason,
  RuntimeEvent,
  TodoItem,
  ToolCategory,
  ToolResult,
  ToolRisk,
  ToolStatus,
  Usage
} from '../shared/types'

/* ── Goal 模式 ────────────────────────────────────────────────── */

/** update_goal 工具接受的补丁（不能直接改 paused/cancelled——暂停与结束由用户/主进程控制） */
export interface GoalPatch {
  status: 'active' | 'completed' | 'blocked'
  /** 本轮完成内容摘要 */
  summary?: string
  /** 下一轮建议动作 */
  nextStep?: string
  /** blocked 时的阻塞原因 */
  blockedReason?: string
  /** completed 时的证据：工作区内真实存在的文件路径（工具层已校验） */
  evidence?: string[]
}

/** RuntimeEvent 去掉 envelope 后的载荷，供 ToolContext.emit 直接发送 */
type RuntimeEventBaseKeys = 'seq' | 'runId' | 'sessionId' | 'at'
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type RuntimeEventPayload = DistributiveOmit<RuntimeEvent, RuntimeEventBaseKeys>

/* ── 工具定义 ─────────────────────────────────────────────────── */

/**
 * 暴露给模型与主进程的工具定义。
 * `parameters` 是 JSON Schema；`titleFor` 只给 UI/审批卡用，序列化给模型时会剔除。
 */
export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema（object） */
  parameters: Record<string, unknown>
  category: ToolCategory
  /** 基础风险等级；具体调用可能被输入提升（危险命令 → high） */
  risk: ToolRisk
  /** 人类可读标题，例如「读取 sales.csv」 */
  titleFor: (input: Record<string, unknown>) => string
}

/* ── Provider 协议 ────────────────────────────────────────────── */

export interface ProviderStreamRequest {
  /** 系统提示词（已包含项目记忆等） */
  system: string
  /** 完整对话历史（含此前的 tool_use / tool_result） */
  messages: ChatMessage[]
  /** 给模型的工具 JSON Schema（由 TOOL_DEFINITIONS 转换） */
  tools: ToolDefinition[]
  signal: AbortSignal
  /** 仅 demo 引擎使用：定位演示工作区；真实 provider 忽略 */
  workspace?: string | null
  maxTokens?: number
  temperature?: number
}

/** Provider 层产出的细粒度流事件，由 Agent 循环聚合成 RuntimeEvent */
export type ProviderStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argsDelta: string }
  | { type: 'tool_call_end'; index: number; id: string; name: string; input: Record<string, unknown>; parseError?: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'notice'; level: 'info' | 'warn' | 'success'; message: string }
  /** demo 引擎专用：驱动 UI 演示进度条，真实 provider 不会产出 */
  | { type: 'demo_step'; index: number; total: number; caption: string }

export interface Provider {
  stream(req: ProviderStreamRequest): AsyncIterable<ProviderStreamEvent>
}

/* ── 子代理 ───────────────────────────────────────────────────── */

export interface SubagentRequest {
  /** 一句话任务描述（展示用） */
  description: string
  /** 完整指令，作为子代理的用户消息 */
  prompt: string
  /** 父代理任务上下文摘要（可选） */
  context?: string
}

export type SubagentStatus = 'completed' | 'failed' | 'cancelled' | 'exhausted'

export interface SubagentResult {
  /**
   * 子代理终态。只有 `completed` 表示子代理给出了可采用最终结论；
   * failed=首步/中途模型请求失败，exhausted=达到原生 12 步上限仍无结论，
   * cancelled=父任务取消（通常以 AbortError 向上传递）。
   */
  status: SubagentStatus
  /** 子代理最后的文本结论（失败/耗尽时可能只是中间文字，父任务不得当成完成） */
  summary: string
  steps: number
  usage: Usage
  /** 真实失败原因（模型错误 / 步数耗尽说明），父任务必须保留 */
  error?: string
  /** 子代理执行期间失败的工具（名称 + 错误），父任务必须保留，不得被“完成”文字覆盖 */
  failedTools?: string[]
}

/* ── 工具运行时上下文 ─────────────────────────────────────────── */

/**
 * 工具执行上下文：所有与「会话/Agent 状态」相关的副作用都通过回调交给 Agent，
 * 工具本身只做文件系统/进程操作，便于单独测试。
 */
export interface ToolContext {
  sessionId: string
  runId: string
  /** 当前 assistant 消息 id（tool_progress 用） */
  messageId: string
  /** 当前工具调用 id（快照目录名） */
  toolUseId: string
  workspace: string | null
  permissionMode: PermissionMode
  /** 写文件前的备份根目录：<snapshotDir>/<toolUseId>/<filename> */
  snapshotDir: string
  signal: AbortSignal
  /** 子代理深度：0 = 主 Agent；1 = 子代理；子代理不允许再嵌套 */
  depth: number
  /** true = 子代理，只允许只读工具 */
  readOnly: boolean
  /** 本次调用已获准越出工作区（由审批层设置） */
  escapeApproved: boolean
  demo: boolean
  /** 当前目标（仅 Goal 模式非 null；update_goal 工具据此合并补丁） */
  goal: Goal | null
  /** 原样发送 RuntimeEvent 载荷（envelope 由 Agent 补齐） */
  emit: (event: RuntimeEventPayload) => void
  /** Goal 模式：合并补丁、更新当前目标并 emit goal_updated（返回更新后的 Goal） */
  updateGoal: (patch: GoalPatch) => Goal | null

  getTodos(): TodoItem[]
  setTodos(todos: TodoItem[]): void
  getArtifacts(): Artifact[]
  addArtifact(artifact: Artifact): void
  askUser(request: AskUserRequest): Promise<AskUserAnswer>
  /** 子代理/长任务进度：映射为 RuntimeEvent.tool_progress */
  progress(note: string, opts?: { title?: string; status?: ToolStatus }): void
  runSubagent(req: SubagentRequest): Promise<SubagentResult>
}

/* ── 系统提示词参数 ───────────────────────────────────────────── */

export interface BuildSystemPromptOptions {
  workspace?: string | null
  permissionMode?: PermissionMode
  projectMemory?: string
  /** R10：项目指令 + 知识摘要 + 记忆中心（优先于 projectMemory） */
  projectContext?: string
  platform?: NodeJS.Platform | string
  modelLabel?: string
  /** 便于测试；默认 new Date() */
  date?: Date
  demo?: boolean
  todos?: TodoItem[]
  /** 本次可用的工具定义（子代理只有只读工具） */
  tools?: ToolDefinition[]
  /** 子代理模式：在提示词里说明只能只读 */
  readOnly?: boolean
  /** Goal 模式：active 时注入目标上下文与每轮行为规范 */
  goal?: Goal | null
}

/* ── 其它 ─────────────────────────────────────────────────────── */

export type ConnectionTestOptions = {
  /** 超时（毫秒），默认 15000 */
  timeoutMs?: number
}
