/**
 * Morrow 领域契约 — 主进程与渲染进程共同引用。
 * 规则：本目录不得依赖 electron / react / node 内置模块，只放纯类型与常量。
 */

/* ── 通用 ─────────────────────────────────────────────────────── */

export interface ResultError {
  code: string
  message: string
  hint?: string
  retryable?: boolean
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ResultError }

export type Platform = 'win32' | 'darwin' | 'linux'

export type PermissionMode = 'read-only' | 'ask' | 'auto'

/**
 * 显式会话模式（审计报告第 5 项）：
 * - work（默认）：按权限档位读写文件、执行命令、推进目标；
 * - chat：只讨论与只读分析，内核强制只暴露只读工具并拦截任何写入/执行/目标操作。
 */
export type SessionMode = 'work' | 'chat'

export type ThemeMode = 'dark' | 'light'

/* ── 模型与提供方 ─────────────────────────────────────────────── */

export type ProviderKind = 'openai-compat' | 'anthropic' | 'demo'

export interface ModelInfo {
  id: string
  label: string
  contextWindow: number
  maxOutput?: number
  supportsTools: boolean
  supportsReasoning?: boolean
  note?: string
}

export type ProviderCategory = 'cn' | 'global' | 'aggregator' | 'local' | 'custom'

export interface ProviderConfig {
  id: string
  kind: ProviderKind
  name: string
  baseUrl: string
  models: ModelInfo[]
  /** 设置页分组：国内 / 国际 / 聚合 / 本地 / 自定义 */
  category?: ProviderCategory
  /** 主进程保存的加密 Key 是否存在（渲染层永远拿不到明文） */
  apiKeyStored: boolean
  enabled: boolean
  /** 额外请求头，例如自定义网关需要的字段 */
  headers?: Record<string, string>
  isBuiltin?: boolean
}

export interface ModelRef {
  providerId: string
  modelId: string
}

export interface ProviderTestResult {
  ok: boolean
  latencyMs: number
  modelCount?: number
  message: string
}

/* ── 消息内容 ─────────────────────────────────────────────────── */

export type ChatRole = 'user' | 'assistant' | 'system'

export type ToolCategory = 'read' | 'write' | 'exec' | 'meta'

export type ToolRisk = 'low' | 'medium' | 'high'

export type ToolStatus = 'running' | 'success' | 'error' | 'denied' | 'interrupted' | 'waiting'

export interface ToolResult {
  ok: boolean
  /** 给用户与模型看的文本结果（已截断） */
  output: string
  error?: string
  hint?: string
  durationMs?: number
  /** 结构化元信息：diff、行数、退出码、快照 id 等 */
  meta?: Record<string, unknown>
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ThinkingBlock {
  type: 'thinking'
  text: string
  durationMs?: number
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  /** 人类可读标题，例如「读取 sales-q3.csv」 */
  title: string
  category: ToolCategory
  input: Record<string, unknown>
  status: ToolStatus
  result?: ToolResult
  startedAt?: number
  finishedAt?: number
  /** 子代理工具的活动摘要 */
  subagent?: { label: string; stepCount?: number }
}

export interface ContentBlockError {
  type: 'error'
  message: string
  code?: string
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ContentBlockError

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** 最近一次请求后估算的上下文占用 */
  contextUsed?: number
  contextLimit?: number
  cacheReadTokens?: number
  /** 累计费用（若模型有价格配置） */
  costUsd?: number
}

/** 图片输入（多模态）：以 base64 + mediaType 发给支持视觉的模型 */
export interface ChatImage {
  mediaType: string
  dataBase64: string
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: ContentBlock[]
  createdAt: number
  model?: string
  usage?: Usage
  /** 用户消息携带的图片（多模态输入；历史请求也会带上） */
  images?: ChatImage[]
  /** 用户中途停止 */
  interrupted?: boolean
  /** 消息级错误（不打断会话，展示为内联错误） */
  error?: ResultError
}

/* ── 目标（Goal 模式：多轮自动续跑） ─────────────────────────── */

export type GoalStatus = 'active' | 'paused' | 'completed' | 'blocked' | 'cancelled'

/** 目标停止原因（不是完成；用于诚实说明为什么停下） */
export type GoalStopReason =
  | 'user_paused'
  | 'user_stopped'
  | 'app_restarted'
  | 'error'
  | 'budget_rounds'
  | 'budget_tool_calls'
  | 'budget_time'
  | 'no_progress'
  | 'blocked'

export interface Goal {
  id: string
  objective: string
  status: GoalStatus
  /** 当前已开始的轮次（从 1 开始；跨暂停/重启累计，不重置） */
  round: number
  /** 本目标授权的总轮次预算（按目标复杂度自动估算，默认 5，上限 200；用户主动继续可追加一段） */
  maxRounds: number
  /** true = 轮次预算由系统智能估算（用户没有手动指定） */
  maxRoundsAuto?: boolean
  /** 上一轮进度摘要（由 update_goal 工具写入） */
  summary?: string
  /** 下一轮建议动作 */
  nextStep?: string
  /** 模型/系统判定阻塞时的原因 */
  blockedReason?: string
  /** 停止原因（paused/cancelled 时说明为什么停；completed 时为 undefined） */
  stopReason?: GoalStopReason
  /** 完成证据：工作区内真实存在的文件路径（update_goal(completed) 强制校验） */
  evidence?: string[]
  /** 累计工具调用次数 */
  toolCalls?: number
  /** 累计有效运行时间（毫秒，暂停/重启期间不计时） */
  activeMs?: number
  /** 连续无进展轮数（有真实推进时清零） */
  noProgressRounds?: number
  /** 真实进展去重键（路径+内容哈希 / MCP 签名等；持久化后重启不重复计数） */
  progressKeys?: string[]
  /** 预算：工具调用上限 */
  maxToolCalls?: number
  /** 预算：有效运行时间上限（毫秒） */
  maxActiveMs?: number
  /** 预算：连续无进展轮数上限 */
  maxNoProgressRounds?: number
  createdAt: number
  updatedAt: number
  completedAt?: number
  cancelledAt?: number
}

/* ── 计划 / 画布 / 会话 ───────────────────────────────────────── */

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  id: string
  text: string
  status: TodoStatus
}

export type ArtifactKind = 'html' | 'markdown' | 'code' | 'svg' | 'text' | 'file'

export interface Artifact {
  id: string
  title: string
  kind: ArtifactKind
  /** 工作区内的绝对路径（文件型产物） */
  path?: string
  /** 内联内容（HTML/Markdown/SVG） */
  content?: string
  language?: string
  createdAt: number
  updatedAt: number
}

export interface SessionMeta {
  id: string
  title: string
  workspace: string | null
  model: ModelRef
  permissionMode: PermissionMode
  /** 显式会话模式；缺省 = work（兼容旧会话文件） */
  mode?: SessionMode
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 最后一条消息的纯文本预览 */
  preview?: string
  todoProgress?: { completed: number; total: number }
}

export interface Session extends SessionMeta {
  messages: ChatMessage[]
  todos: TodoItem[]
  artifacts: Artifact[]
  usage: Usage
  /** 目标模式（存在且 active/paused 时展示目标条并支持多轮续跑） */
  goal?: Goal | null
}

export interface Project {
  id: string
  name: string
  path: string
  lastOpenedAt: number
}

/* ── 审批与提问 ───────────────────────────────────────────────── */

export type PermissionDecision = 'once' | 'always' | 'deny'

export interface PermissionPreview {
  kind: 'command' | 'diff' | 'path' | 'text' | 'json'
  content: string
}

export interface PermissionRequest {
  id: string
  sessionId: string
  toolUseId: string
  toolName: string
  title: string
  summary: string
  category: ToolCategory
  risk: ToolRisk
  input: Record<string, unknown>
  preview?: PermissionPreview
  createdAt: number
}

export interface AskUserOption {
  label: string
  description?: string
  value: string
}

export interface AskUserRequest {
  id: string
  sessionId: string
  toolUseId: string
  question: string
  options: AskUserOption[]
  allowCustom: boolean
  createdAt: number
}

export interface AskUserAnswer {
  value: string
  label: string
  custom?: boolean
}

/* ── 附件 ─────────────────────────────────────────────────────── */

export interface Attachment {
  id: string
  name: string
  path: string
  size: number
  kind: 'text' | 'image' | 'file'
  /** 文本附件的内容（图片为 dataURL，二进制文件为 null） */
  content?: string | null
  /** 图片 MIME 类型（kind=image 时） */
  mediaType?: string
  truncated?: boolean
}

/* ── 设置 ─────────────────────────────────────────────────────── */

export type SendKey = 'enter' | 'ctrl+enter'

export interface Settings {
  version: number
  theme: ThemeMode
  fontSize: number
  reduceMotion: boolean
  permissionMode: PermissionMode
  sendKey: SendKey
  providers: ProviderConfig[]
  defaultModel: ModelRef
  lastWorkspace: string | null
  recentWorkspaces: string[]
  onboardingDone: boolean
  sidebarCollapsed: boolean
  demoSeen: boolean
  showTokenMeter: boolean
  /** 侧栏宽度（可拖动调整，200–400） */
  sidebarWidth: number
  /** 上下文自动压缩 */
  autoCompact: boolean
  /** 自动压缩触发阈值（0.5–0.95，占上下文窗口比例） */
  compactThreshold: number
  /** 右侧画布宽度（可拖动调整，320–960） */
  canvasWidth: number
  /** 布局版本：用于把旧默认宽度一次性迁移到 R7 新默认（240 / 420） */
  layoutVersion?: number
  /** 会话自动命名（用首条消息） */
  autoTitle: boolean
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: Platform
  buildTime?: string
  buildSha?: string
  dataDir: string
}

export interface Bootstrap {
  settings: Settings
  sessions: SessionMeta[]
  projects: Project[]
  app: AppInfo
  demoAvailable: boolean
  hasAnyApiKey: boolean
}

/* ── 运行事件（主 → 渲染，带 seq 有序） ────────────────────────── */

export type RunFinishReason = 'complete' | 'cancelled' | 'error' | 'max-steps'

interface RuntimeEventBase {
  seq: number
  runId: string
  sessionId: string
  at: number
}

export type RuntimeEvent =
  | (RuntimeEventBase & { type: 'run_started'; userMessage: ChatMessage; assistantMessageId: string })
  | (RuntimeEventBase & { type: 'run_finished'; reason: RunFinishReason; message?: ChatMessage; usage: Usage })
  | (RuntimeEventBase & { type: 'message_started'; messageId: string; role: ChatRole })
  | (RuntimeEventBase & { type: 'message_delta'; messageId: string; textDelta?: string; thinkingDelta?: string })
  | (RuntimeEventBase & { type: 'message_completed'; messageId: string; message: ChatMessage })
  | (RuntimeEventBase & { type: 'tool_started'; messageId: string; block: ToolUseBlock })
  | (RuntimeEventBase & {
      type: 'tool_progress'
      messageId: string
      toolUseId: string
      status?: ToolStatus
      title?: string
      note?: string
    })
  | (RuntimeEventBase & {
      type: 'tool_finished'
      messageId: string
      toolUseId: string
      result: ToolResult
      interrupted?: boolean
      denied?: boolean
    })
  | (RuntimeEventBase & { type: 'permission_requested'; request: PermissionRequest })
  | (RuntimeEventBase & { type: 'permission_resolved'; requestId: string; decision: PermissionDecision })
  | (RuntimeEventBase & { type: 'question_asked'; request: AskUserRequest })
  | (RuntimeEventBase & { type: 'question_answered'; requestId: string; answer: AskUserAnswer })
  | (RuntimeEventBase & { type: 'todos_updated'; todos: TodoItem[] })
  | (RuntimeEventBase & { type: 'artifacts_updated'; artifacts: Artifact[] })
  | (RuntimeEventBase & { type: 'usage_updated'; usage: Usage })
  | (RuntimeEventBase & { type: 'session_updated'; meta: SessionMeta; title?: string })
  | (RuntimeEventBase & { type: 'goal_updated'; goal: Goal | null })
  | (RuntimeEventBase & { type: 'compaction'; phase: 'started' | 'finished'; savedTokens?: number })
  | (RuntimeEventBase & { type: 'notice'; level: 'info' | 'warn' | 'success'; message: string })
  | (RuntimeEventBase & { type: 'error'; error: ResultError })
  | (RuntimeEventBase & { type: 'demo_step'; index: number; total: number; caption: string })

/** 事件在 preload 上的订阅回调 */
export type RuntimeEventListener = (event: RuntimeEvent) => void

/* ── 会话操作参数 ─────────────────────────────────────────────── */

export interface CreateSessionInput {
  workspace?: string | null
  model?: ModelRef
  permissionMode?: PermissionMode
  /** 新建会话的显式模式；缺省 = work */
  mode?: SessionMode
  title?: string
}

export interface SendMessageInput {
  sessionId: string
  text: string
  attachments?: Attachment[]
  model?: ModelRef
  permissionMode?: PermissionMode
}

export interface SendMessageResult {
  runId: string
  userMessage: ChatMessage
  assistantMessageId: string
}

export interface FileSearchResult {
  path: string
  name: string
  dir: string
  score: number
}

export interface WorkspaceInfo {
  path: string
  name: string
  exists: boolean
  fileCount: number
  git: boolean
}

export interface DemoInfo {
  available: boolean
  title: string
  description: string
  workspace: string | null
  steps: number
}

export interface WindowState {
  maximized: boolean
  focused: boolean
  fullscreen: boolean
}
