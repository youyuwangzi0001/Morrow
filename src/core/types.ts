/**
 * Morrow 内核（src/core）公共类型。
 *
 * 约束：core 是纯 TypeScript 运行时，不 import electron / react / DOM；
 * 只依赖 Node 内置模块（fs/path/child_process/crypto）与 src/shared 契约。
 */
import type {
  AnswerStyleId,
  Artifact,
  AskUserAnswer,
  AskUserRequest,
  ChatMessage,
  Goal,
  PermissionMode,
  RuntimeEvent,
  SessionPlan,
  TodoItem,
  ToolCategory,
  ToolResult,
  TerminalProcessInfo,
  ToolRisk,
  ToolStatus,
  Usage,
  WebSearchResponse
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
  SessionPlan,
  TodoItem,
  ToolCategory,
  ToolResult,
  TerminalProcessInfo,
  ToolRisk,
  ToolStatus,
  Usage,
  WebSearchResponse
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
  /** 推理强度映射：effort→reasoning_effort，thinking→Anthropic thinking budget */
  reasoning?: { effort: import('../shared/types').ReasoningEffort; style: 'effort' | 'thinking' }
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

export interface SubagentRole {
  /** 小写名字（task/swarm 的 agent 字段） */
  name: string
  title: string
  description: string
  /** 角色专属系统提示（叠加在基础系统提示之后） */
  systemPrompt: string
  /** 允许使用的工具名；省略表示沿用父代理工具集 */
  tools?: string[]
  /** 只读角色：即使父代理在工作模式，也不允许写/执行/MCP */
  readOnly?: boolean
  source?: 'builtin' | 'project' | 'user'
}

export interface SubagentRequest {
  /** 一句话任务描述（展示用） */
  description: string
  /** 完整指令，作为子代理的用户消息 */
  prompt: string
  /** 父代理任务上下文摘要（可选） */
  context?: string
  /** 自定义角色；缺省为 general */
  role?: SubagentRole
  /** swarm 子任务身份：让进度事件能精确更新对应任务 */
  swarmTask?: { index: number; title: string; agent: string }
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
  /** 实际使用的角色名 */
  role?: string
  steps: number
  usage: Usage
  /** 真实失败原因（模型错误 / 步数耗尽说明），父任务必须保留 */
  error?: string
  /** 子代理执行期间失败的工具（名称 + 错误），父任务必须保留，不得被“完成”文字覆盖 */
  failedTools?: string[]
  /** 子代理写/编辑过的文件（检查点登记用：absolutePath/beforeHash/afterHash/snapshotPath/created） */
  changedFiles?: Array<Record<string, unknown>>
}

/* ── 工具运行时上下文 ─────────────────────────────────────────── */

/**
 * 工具执行上下文：所有与「会话/Agent 状态」相关的副作用都通过回调交给 Agent，
 * 工具本身只做文件系统/进程操作，便于单独测试。
 */
export interface PdfOcrRequest {
  /** 已解析的真实 PDF 路径 */
  path: string
  /** 1 起始页码 */
  pages: number[]
  signal?: AbortSignal
}

export interface PdfOcrPage {
  page: number
  text: string
  error?: string
}

export interface PdfOcrResult {
  totalPages: number
  language: string
  engine: string
  pages: PdfOcrPage[]
}

/** 本机 OCR：由主进程注入；核心工具本身不依赖 Electron/Windows API。 */
export type PdfOcrHandler = (request: PdfOcrRequest) => Promise<PdfOcrResult>

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
  /** 工具层只读兜底：即使调用方绕过权限层也只允许只读工具（主流程与子代理共用权限链，通常为 false） */
  readOnly: boolean
  /** 本次调用已获准越出工作区（由审批层设置） */
  escapeApproved: boolean
  /** 用户在本会话用户消息中显式附加的文件（只读白名单；不含模型自行生成的路径） */
  attachedFiles?: readonly string[]
  demo: boolean
  /** 当前目标（仅 Goal 模式非 null；update_goal 工具据此合并补丁） */
  goal: Goal | null
  /** 当前是否处于计划模式（submit_plan 只在计划模式可用） */
  planMode: boolean
  /** 读取本轮已提交的计划（未提交/非计划模式为 null） */
  getPlan(): SessionPlan | null
  /** 提交/替换本轮计划并广播 plan_updated（计划产物由 submit_plan 工具登记） */
  proposePlan(plan: SessionPlan): SessionPlan
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
  progress(note: string, opts?: { title?: string; status?: ToolStatus; swarmTask?: import('../shared/types').SwarmTaskProgress }): void
  runSubagent(req: SubagentRequest): Promise<SubagentResult>
  /** 本轮可用的子代理角色（含内置与自定义；测试上下文可省略） */
  agents?: SubagentRole[]
  /** 联网搜索（由主进程注入；未配置时为 undefined，web_search 工具不会暴露） */
  searchWeb?: (input: { query: string; maxResults?: number; signal: AbortSignal }) => Promise<WebSearchResponse>
  /** 本机 PDF OCR（由主进程注入；未注入时扫描件会明确报错） */
  ocrPdf?: PdfOcrHandler
  /** 终端/后台任务（由主进程注入） */
  terminal?: TerminalToolHandler
}

export interface TerminalToolInput {
  action: 'list' | 'start' | 'run' | 'read' | 'write' | 'stop' | 'restart'
  id?: string
  command?: string
  title?: string
  data?: string
  tail?: number
  timeoutMs?: number
  /** 主进程注入的会话工作区；模型参数里没有 */
  cwd?: string | null
}

export interface TerminalToolResponse {
  ok: boolean
  summary: string
  process?: TerminalProcessInfo
  processes?: TerminalProcessInfo[]
  output?: string
  exitCode?: number
  error?: string
  hint?: string
}

export type TerminalToolHandler = (input: TerminalToolInput) => Promise<TerminalToolResponse>

export type WebSearchHandler = (input: {
  query: string
  maxResults?: number
  signal: AbortSignal
}) => Promise<WebSearchResponse>

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
  /** 本次可用的工具定义（主代理/子代理按各自工具集传入） */
  tools?: ToolDefinition[]
  /** Goal 模式：active 时注入目标上下文与每轮行为规范 */
  goal?: Goal | null
  /** 计划模式：注入「先探索、提交计划、等待批准」段，只列只读/计划工具 */
  planMode?: boolean
  /** 是否配置了联网搜索；false 时从工具清单中移除 web_search */
  webSearchAvailable?: boolean
  /** 可用子代理角色（工作模式注入；聊天/计划模式忽略） */
  agents?: SubagentRole[]
  /** 全局回答风格；缺省按平衡风格 */
  answerStyle?: AnswerStyleId
  /** answerStyle=custom 时使用的用户偏好 */
  answerStyleCustom?: string
}

/* ── 其它 ─────────────────────────────────────────────────────── */

export type ConnectionTestOptions = {
  /** 超时（毫秒），默认 15000 */
  timeoutMs?: number
}
