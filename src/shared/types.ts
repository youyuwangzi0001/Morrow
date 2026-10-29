// 共享契约与纯函数：types/plan/message/usage/工具协议/文件路径等由此统一导出。
import { diffArrays, diffChars } from 'diff'
import type { StudioKind } from './studio'

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

/** 点击关闭按钮/关闭灵动岛时执行的动作；ask = 首次询问并记住选择 */
export type CloseAction = 'ask' | 'minimize' | 'quit'

/**
 * 显式会话模式（审计报告第 5 项）：
 * - work（默认）：按权限档位读写文件、执行命令、推进目标；
 * - chat：只讨论与只读分析，内核强制只暴露只读工具并拦截任何写入/执行/目标操作。
 */
export type SessionMode = 'work' | 'chat' | 'research'

/* ── 深度研究（研究模式：多轮检索 → 带引用报告） ─────────────── */

export type ResearchDepth = 'quick' | 'standard' | 'deep'

export type ResearchStatus = 'idle' | 'planning' | 'ready' | 'searching' | 'completed' | 'stopped' | 'error'

export interface ResearchState {
  /** 研究主题（首条用户消息） */
  topic: string
  depth: ResearchDepth
  status: ResearchStatus
  /** 当前/已完成的检索轮次（从 1 开始） */
  round: number
  maxRounds: number
  minSources: number
  sourceCount: number
  startedAt: number
  updatedAt: number
  /** 待用户确认/执行的可编辑研究计划（Markdown） */
  plan?: string
  /** 检索中用户补充的要求：下一轮检索优先纳入 */
  steer?: string
  /** 没完成时说明差在哪（来源不足 / 缺少报告 / 已送上限） */
  gap?: string
  /** 最终研究报告（画布成品） */
  artifactId?: string
}

/**
 * 计划模式（P0-2）：
 * - `planMode=true` 时内核只暴露只读工具与 submit_plan，模型先探索再提交计划；
 * - 用户批准后自动切到执行（planMode=false），并按计划步骤建立 todo 列表；
 * - 计划本身独立持久化在会话元数据里，可跨重启恢复。
 */
export type PlanStatus = 'pending' | 'executing' | 'completed' | 'rejected'

export interface PlanStep {
  id: string
  text: string
}

export interface SessionPlan {
  id: string
  title: string
  summary: string
  steps: PlanStep[]
  /** 风险、假设或需要用户确认的前提（可选） */
  risks?: string
  status: PlanStatus
  /** 用户修改意见（rejected/revise 时保留） */
  feedback?: string
  createdAt: number
  updatedAt: number
  approvedAt?: number
  completedAt?: number
  /** 计划文档产物（画布内 markdown） */
  artifactId?: string
}

/* ── 检查点与回退（P0-3） ─────────────────────────────────────── */

export interface CheckpointFile {
  /** 工作区内绝对路径 */
  path: string
  /** 本轮开始前文件是否存在（false = 本轮新建，回退时删除） */
  existed: boolean
  beforeHash: string | null
  /** 本轮最后一次成功写入后的哈希（冲突检测） */
  afterHash: string | null
  /** 位于 <userData>/snapshots/<sessionId>/ 的写前快照 */
  snapshotPath?: string
}

export interface TurnCheckpoint {
  id: string
  sessionId: string
  /** 对应本轮用户消息 id；阶段检查点对应阶段完成时的最后一条 assistant 消息 */
  messageId: string
  /** 创建时的消息下标（仅在消息未被压缩时有效） */
  messageIndex: number
  /** 用户消息摘录（回退列表展示） */
  label: string
  /** turn = 每轮开始；stage = 计划步骤完成 */
  kind?: 'turn' | 'stage'
  /** 回退时是否保留 messageId 这条消息（阶段检查点保留已完成阶段） */
  keepMessage?: boolean
  createdAt: number
  files: CheckpointFile[]
  /** 本轮开始前的 todo 快照 */
  todos: TodoItem[]
  /** 本轮开始前已存在的产物 id */
  artifactIds: string[]
  /** 本轮开始前的计划快照（回退对话时一起恢复） */
  plan: SessionPlan | null
  /** 本轮开始前的计划模式状态 */
  planMode?: boolean
}

export type RewindScope = 'both' | 'code' | 'conversation'

export interface RewindConflict {
  path: string
  reason: string
}

export interface RewindFilePreview {
  path: string
  /** true = 恢复为写前快照；false = 删除本轮新建的文件 */
  existed: boolean
  conflict: boolean
}

export interface RewindPreview {
  checkpoint: TurnCheckpoint
  /** 本次回退涉及的全部文件（目标轮及之后） */
  files: RewindFilePreview[]
  conflicts: RewindConflict[]
  /** 是否能在当前消息列表里定位到回退点（压缩后可能失效） */
  messageFound: boolean
  /** 需要恢复/删除的文件数 */
  fileCount: number
  /** 将被移除的消息数（含回退点用户消息本身） */
  removableMessages: number
}

export interface RewindResult {
  checkpointId: string
  kind?: 'turn' | 'stage'
  scope: RewindScope
  restoredFiles: number
  removedFiles: number
  removedMessages: number
}

export type ThemeMode = 'dark' | 'light'

/** 代码/等宽内容的字体 */
export type CodeFontId = 'ibm-plex' | 'jetbrains' | 'system'

/* ── 模型与提供方 ─────────────────────────────────────────────── */

export type ProviderKind = 'openai-compat' | 'anthropic' | 'demo'

export type ReasoningEffort = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelPricing {
  /** 每百万输入 token 的美元参考价 */
  inputPerMTok: number
  /** 每百万输出 token 的美元参考价 */
  outputPerMTok: number
  /** 缓存命中输入 token 的参考价（可选） */
  cacheReadPerMTok?: number
}

export interface ModelInfo {
  id: string
  label: string
  contextWindow: number
  maxOutput?: number
  supportsTools: boolean
  supportsReasoning?: boolean
  /** 模型是否接受图片输入；describe_media 会优先用当前对话模型的视觉能力 */
  supportsVision?: boolean
  /** 推理强度如何映射到 provider：effort=reasoning_effort，thinking=thinking budget */
  reasoningStyle?: 'effort' | 'thinking'
  /** 服务商真实支持的思考档位；未提供时只展示安全的“自动”，不猜测档位 */
  reasoningEfforts?: ReasoningEffort[]
  /** 服务端声明的默认上下文上限；未提供时用 contextWindow */
  defaultContextWindow?: number
  /** 服务商支持客户端指定上下文上限时的可选值（tokens） */
  contextOptions?: number[]
  pricing?: ModelPricing
  note?: string
}

export type ProviderCategory = 'cn' | 'global' | 'local' | 'custom'

export interface ProviderConfig {
  id: string
  kind: ProviderKind
  name: string
  baseUrl: string
  models: ModelInfo[]
  /** 设置页分组：国内 / 国际 / 本地 / 自定义 */
  category?: ProviderCategory
  /** 主进程保存的加密 Key 是否存在（渲染层永远拿不到明文） */
  apiKeyStored: boolean
  enabled: boolean
  /** 额外请求头，例如自定义网关需要的字段 */
  headers?: Record<string, string>
  isBuiltin?: boolean
  /** 上次从服务商 /models 同步的时间；内置 Provider 升级合并时据此保留服务商返回的元数据 */
  modelsSyncedAt?: number
}

export interface ModelRef {
  providerId: string
  modelId: string
  /** 本会话覆盖的上下文上限；未设置时使用模型元数据里的上限 */
  contextWindow?: number
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
  /** 长任务进度（0–100），由工具进度事件实时更新 */
  progressPercent?: number
  /** swarm 每个子任务的实时状态与最终摘要 */
  swarmTasks?: SwarmTaskProgress[]
}

export type SwarmTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'exhausted'

export interface SwarmOperation {
  id: string
  name: string
  title: string
  status: ToolStatus
  /** 入参摘要（路径/命令/关键词） */
  input?: string
  /** 结果摘要（成功输出） */
  output?: string
  error?: string
  startedAt?: number
  finishedAt?: number
}

export interface SwarmTaskProgress {
  index: number
  title: string
  agent: string
  /** 成员类型的中文名（新事件提供；旧数据回退到 agent） */
  agentTitle?: string
  status: SwarmTaskStatus
  stepCount?: number
  /** 最近一步在做什么 */
  note?: string
  summary?: string
  error?: string
  /** 成员实际执行过的全部工具操作（按时间顺序） */
  operations?: SwarmOperation[]
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
export interface TokenActivityDay {
  /** 本地日期 YYYY-MM-DD */
  date: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** 服务商未返回 usage 时，本地计数器补的估算值（已包含在 totalTokens） */
  estimatedTokens: number
  totalTokens: number
  requests: number
}

export interface TokenActivitySummary {
  /** 最近 365 天（含今天），按日期升序 */
  days: TokenActivityDay[]
  today: number
  week: number
  yearTotal: number
  total: number
  activeDays: number
  estimatedTokens: number
  generatedAt: number
}

export interface ChatImage {
  mediaType: string
  dataBase64: string
  /** 原附件名，用于对话内的图片说明 */
  name?: string
}

/** 用户消息附件的展示元数据；正文只进入模型上下文，不进入用户气泡。 */
export interface MessageAttachment {
  name: string
  path?: string
  size: number
  kind: 'text' | 'image' | 'file'
  mediaType?: string
  note?: string
  truncated?: boolean
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: ContentBlock[]
  createdAt: number
  model?: string
  usage?: Usage
  /** 用户输入的原始文本；缺省时回退到 content（兼容旧会话） */
  displayText?: string
  /** 用户消息附件展示元数据（不参与模型请求） */
  attachments?: MessageAttachment[]
  /** 用户消息携带的图片（多模态输入；历史请求也会带上） */
  images?: ChatImage[]
  /** 研究模式自动续研的内部消息：不展示为用户气泡 */
  hidden?: boolean
  /** 用户中途停止 */
  interrupted?: boolean
  /** 消息级错误（不打断会话，展示为内联错误） */
  error?: ResultError
  /** 阶段式检查点：该消息完成了一个计划步骤，UI 在此提供分叉/回退 */
  stageBoundary?: { checkpointId: string; label: string }
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
  /** 本目标授权的总轮次预算（按目标复杂度自动估算，默认 5，上限 256；用户主动继续可追加一段） */
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

/* ── 成品版本与导出 ───────────────────────────────────────────── */

export type ArtifactVersionSource = 'baseline' | 'agent' | 'restore' | 'manual'

export interface ArtifactVersionInfo {
  id: string
  artifactId: string
  title: string
  kind: ArtifactKind
  language?: string
  createdAt: number
  source: ArtifactVersionSource
  size: number
  hash: string
  /** 是否有可读取/恢复的快照内容 */
  restorable: boolean
}

export type ArtifactExportFormat = 'original' | 'markdown' | 'html' | 'text' | 'pdf'

export interface SessionMeta {
  id: string
  title: string
  workspace: string | null
  model: ModelRef
  permissionMode: PermissionMode
  /** 显式会话模式；缺省 = work（兼容旧会话文件） */
  mode?: SessionMode
  /** 当前会话推理强度；缺省用全局设置 */
  reasoningEffort?: ReasoningEffort
  /** 计划模式：true 时下一次运行先探索并提交计划（仅工作模式可用） */
  planMode?: boolean
  /** 最近一次计划提案（持久化，跨重启可继续批准或修订） */
  plan?: SessionPlan | null
  /** 深度研究状态（研究模式） */
  research?: ResearchState | null
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 最后一条消息的纯文本预览 */
  preview?: string
  todoProgress?: { completed: number; total: number }
  /** 置顶（侧栏排序优先） */
  pinned?: boolean
  /** 归档（默认列表隐藏，可展开查看） */
  archived?: boolean
  /** 演示会话：只能使用演示模型，且只能在演示工作区运行 */
  demo?: boolean
  /** 临时对话：只存在于内存，不写入会话文件、搜索索引、token 账本与成品版本 */
  temporary?: boolean
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

export type PermissionRuleKind = 'tool' | 'prefix' | 'path'

export type PermissionRuleDecision = 'allow' | 'deny'

export interface PermissionRule {
  id: string
  workspace: string
  tool: string
  kind: PermissionRuleKind
  pattern: string
  decision: PermissionRuleDecision
  createdAt: number
}

export interface PermissionLogEntry {
  id: string
  at: number
  workspace: string | null
  sessionId: string
  toolName: string
  title: string
  decision: PermissionDecision
}

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
  /** false = 高风险/外部动作/越界，不提供「始终允许」，每次都会重新询问 */
  allowAlways?: boolean
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
  /** 未发送/截断等需要提示用户的原因 */
  note?: string
}

/* ── Git 工作台（P1-8） ───────────────────────────────────────── */

export interface GitFileStatus {
  /** 相对仓库根的路径（posix 分隔符） */
  path: string
  /** 重命名/复制前的路径 */
  origPath?: string
  /** porcelain v1 的索引状态字母（M/A/D/R/C/U/?） */
  indexStatus: string
  /** porcelain v1 的工作区状态字母 */
  worktreeStatus: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
}

export interface GitIdentity {
  name: string | null
  email: string | null
  /** name 与 email 都已在当前仓库/全局配置中设置 */
  configured: boolean
}

export interface GitStatus {
  isRepo: boolean
  root: string | null
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  hasCommits: boolean
  files: GitFileStatus[]
  stagedCount: number
  changedCount: number
  identity: GitIdentity
}

export interface GitDiff {
  path: string
  staged: boolean
  diff: string
  truncated: boolean
  binary: boolean
}

export interface GitBranch {
  name: string
  current: boolean
  upstream: string | null
  lastCommitAt: number | null
  lastCommitSubject: string
}

export interface GitCommit {
  hash: string
  shortHash: string
  author: string
  date: number
  subject: string
}

export interface GitCommitDetail {
  commit: GitCommit
  body: string
  diff: string
  truncated: boolean
}

export interface GitCommitResult {
  status: GitStatus
  commitHash: string | null
  summary: string
}

/* ── 终端与后台任务（P0-1） ──────────────────────────────────── */

export type TerminalProcessKind = 'shell' | 'task'

export type TerminalProcessStatus = 'running' | 'exited'

export interface TerminalProcessInfo {
  id: string
  title: string
  cwd: string
  kind: TerminalProcessKind
  command?: string
  shellId?: string
  shellLabel?: string
  status: TerminalProcessStatus
  pid?: number
  createdAt: number
  exitCode?: number
}

export interface TerminalShellProfile {
  id: string
  label: string
  detail: string
  isDefault?: boolean
  disabled?: boolean
}

export interface TerminalEventPayload {
  type: 'data' | 'state' | 'removed'
  id: string
  info?: TerminalProcessInfo
  chunk?: string
  stream?: 'stdout' | 'stderr'
  /** 真实 PTY 输出：保留 ANSI/回车，直接交给 xterm；后台任务为纯文本 */
  pty?: boolean
}

/* ── 联网搜索 ─────────────────────────────────────────────────── */

export type WebSearchProvider = 'builtin' | 'tavily' | 'brave' | 'serper' | 'searxng'

export interface WebSearchSettings {
  enabled: boolean
  provider: WebSearchProvider
  /** SearXNG 实例地址；其他提供商使用内置端点 */
  baseUrl?: string
  /** 主进程已保存加密 Key（渲染层永远拿不到明文） */
  apiKeyStored: boolean
  maxResults: number
}

export interface WebSearchSource {
  rank: number
  title: string
  url: string
  snippet: string
  publishedAt?: string
  engine?: string
}

export interface WebSearchResponse {
  query: string
  provider: string
  sources: WebSearchSource[]
  answer?: string
  elapsedMs: number
  cached?: boolean
}

/* ── 本地多媒体（ComfyUI / ffmpeg） ──────────────────────────── */

/**
 * Morrow 不内置推理引擎和权重，只负责检测、启动、配置与调用本机 ComfyUI。
 * 两个可选引擎（ComfyUI、ffmpeg）各自独立，缺失时给出明确指引。
 */
export interface MediaEngineSettings {
  enabled: boolean
  /** ComfyUI HTTP API，例如 http://127.0.0.1:8188 */
  comfyuiUrl: string
  /** ComfyUI 安装目录；填写后可在设置里一键启动引擎 */
  comfyuiDir: string | null
  /** 自定义 ffmpeg 路径；留空则从 PATH 检测 */
  ffmpegPath: string | null
  /** 引擎离线时，生成任务自动尝试启动 */
  autoStart: boolean
  /** 单张图片/编辑的超时（秒） */
  imageTimeoutSec: number
  /** 单条视频的超时（秒） */
  videoTimeoutSec: number
  /** 成品在工作区内的子目录，例如 media */
  outputDir: string
}

export type MediaKind = 'image' | 'video' | 'audio'

/** 生成/编辑结果随 ToolResult.meta.media 回传，用于聊天内联卡片与画布。 */
export interface MediaToolMeta {
  kind: MediaKind
  /** 工作区内的绝对路径 */
  path: string
  artifactId?: string
  title: string
  model: string
  engine: string
  bytes: number
  width?: number
  height?: number
  durationSec?: number
  seed?: number
  elapsedMs?: number
  /** 内联缩略图（data URL），避免依赖会过期的预览令牌 */
  thumbnailDataUrl?: string
  referencePath?: string
}

export interface MediaEngineModelStatus {
  id: 'image' | 'video' | 'audio'
  label: string
  ready: boolean
  /** false 表示没有安装目录、引擎也不在线，无法核对文件，而不是文件真的缺失 */
  verified: boolean
  missing: string[]
  installed: string[]
  /** 视频模型的可用模式；图片模型省略 */
  modes?: { ref2va: boolean; fl2va: boolean }
}

export interface MediaEngineStatus {
  engine: {
    online: boolean
    url: string
    version?: string
    gpu?: string
    vramTotalMb?: number
    vramFreeMb?: number
    message: string
  }
  models: MediaEngineModelStatus[]
  /** ComfyUI 侧必需的自定义节点是否可用（离线时未知，按 false 处理） */
  nodes: { gguf: boolean; minimaxH3: boolean; aceStep: boolean }
  ffmpeg: {
    available: boolean
    path?: string
    version?: string
    message: string
  }
  comfyuiDir: string | null
  canStart: boolean
}

/* ── 设置 ─────────────────────────────────────────────────────── */

export type SendKey = 'enter' | 'ctrl+enter'

/** 运行中按发送键：插话（停止当前运行并立即发送）或排队（本轮结束后发送） */
export type RunningSendMode = 'steer' | 'queue'

export type AnswerStyleId = 'balanced' | 'concise' | 'explanatory' | 'formal' | 'custom'

export interface Settings {
  version: number
  theme: ThemeMode
  fontSize: number
  /** 代码/等宽内容的独立字号（不影响正文与界面字号） */
  codeFontSize: number
  codeFont: CodeFontId
  reduceMotion: boolean
  permissionMode: PermissionMode
  sendKey: SendKey
  /** 运行中默认发送方式：插话或排队 */
  runningSendMode: RunningSendMode
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
  /** 输入框手动高度（0 = 随内容自动；80–360 为手动高度） */
  composerHeight: number
  /** 布局版本：用于把旧默认宽度一次性迁移到 R7 新默认（240 / 420） */
  layoutVersion?: number
  /** 会话自动命名（用首条消息） */
  autoTitle: boolean
  /** 任务结束后自动复盘，生成记忆/技能改进建议（只在强信号时调用当前模型） */
  evolutionEnabled: boolean
  /** 任务完成后自动记录一条任务经验（不调用模型） */
  episodeMemoryEnabled: boolean
  /** 联网搜索配置 */
  webSearch: WebSearchSettings
  /** 本地多媒体引擎（ComfyUI / ffmpeg）；不内置模型 */
  mediaEngine: MediaEngineSettings
  /** 关闭窗口时：询问并记住 / 最小化到任务栏 / 完全退出 */
  closeAction: CloseAction
  /** 任务完成/失败时发送系统通知 */
  notifyOnFinish: boolean
  /** 桌面灵动岛：置顶的小伙伴，可拖到桌面任意位置 */
  islandEnabled: boolean
  /** 灵动岛收起时的左上角位置（DIP）；null = 默认停在主屏右下角 */
  islandPosition: { x: number; y: number } | null
  /** 默认推理强度（模型支持时生效） */
  reasoningEffort: ReasoningEffort
  /** 全局回答风格：影响所有对话、侧边聊天与定时任务的下一次回答 */
  answerStyle: AnswerStyleId
  /** 自定义回答风格说明（answerStyle = custom 时生效） */
  answerStyleCustom: string
  /** 用户配置的运行钩子（显式启用后执行） */
  hooks: HookConfig[]
  /** 终端默认 Shell（终端列表里的 id；空字符串 = 自动选择） */
  terminalShell: string
}

/* ── 自定义命令与钩子（P1-12） ───────────────────────────────── */

export interface CustomCommandInfo {
  /** 不含斜杠的命令名（小写） */
  name: string
  description: string
  argumentHint?: string
  scope: 'project' | 'user'
  path: string
  /** Markdown 模板，支持 $ARGUMENTS 与 $1..$9 */
  body: string
}

export type HookEvent = 'user_prompt_submit' | 'post_tool_use' | 'run_finished'

export const HOOK_EVENTS: readonly HookEvent[] = ['user_prompt_submit', 'post_tool_use', 'run_finished']

export const MAX_HOOKS = 20

export const MAX_ENABLED_HOOKS_PER_EVENT = 5

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value)
}

export interface HookConfig {
  id: string
  event: HookEvent
  command: string
  enabled: boolean
}

export type DataDirSource = 'arg' | 'custom' | 'portable' | 'default'

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: Platform
  buildTime?: string
  buildSha?: string
  dataDir: string
  defaultDataDir: string
  customDataDir: string | null
  dataDirSource: DataDirSource
  canChangeDataDir: boolean
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
      /** 长任务进度（0–100） */
      percent?: number
      /** 集群成员当前步数（用于活动条展示，不参与模型上下文） */
      stepCount?: number
      /** swarm 子任务的结构化实时状态（同一个 swarm 工具下按 index 区分） */
      swarmTask?: SwarmTaskProgress
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
  | (RuntimeEventBase & { type: 'artifacts_updated'; artifacts: Artifact[]; artifactId?: string })
  | (RuntimeEventBase & { type: 'usage_updated'; usage: Usage })
  | (RuntimeEventBase & { type: 'session_updated'; meta: SessionMeta; title?: string })
  | (RuntimeEventBase & { type: 'research_updated'; research: ResearchState | null })
  | (RuntimeEventBase & { type: 'messages_replaced'; messages: ChatMessage[] })
  | (RuntimeEventBase & { type: 'goal_updated'; goal: Goal | null })
  | (RuntimeEventBase & { type: 'plan_updated'; plan: SessionPlan | null; planMode: boolean })
  | (RuntimeEventBase & { type: 'queue_updated'; queue: QueuedMessage[] })
  | (RuntimeEventBase & { type: 'compaction'; phase: 'started' | 'finished'; savedTokens?: number; beforeTokens?: number; afterTokens?: number })
  | (RuntimeEventBase & { type: 'notice'; level: 'info' | 'warn' | 'success'; message: string })
  | (RuntimeEventBase & { type: 'error'; error: ResultError })
  | (RuntimeEventBase & { type: 'demo_step'; index: number; total: number; caption: string })

/** 事件在 preload 上的订阅回调 */
export type RuntimeEventListener = (event: RuntimeEvent) => void

/* ── 桌面灵动岛 ───────────────────────────────────────────────── */

export type IslandStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error'

/** 主进程聚合出的桌面小伙伴状态；与具体窗口无关，重开灵动岛也能恢复。 */
export interface IslandSnapshot {
  status: IslandStatus
  sessionId: string | null
  sessionTitle: string
  /** 一行进度描述，例如「正在执行 运行命令」 */
  detail: string
  todos: TodoItem[]
  /** 本轮开始时间（用于显示耗时）；空闲为 null */
  startedAt: number | null
  updatedAt: number
  /** 任务完成后还没回主窗口看过 */
  unread: boolean
  /** 当前展示的是 Agent 还是创作台；缺省 = Agent */
  mode?: 'agent' | 'studio'
  studioProjectId?: string | null
  studioProjectTitle?: string
  studioKind?: 'short' | 'novel' | 'drama'
  studioStage?: string
  studioJobLabel?: string
  studioJobProgress?: number | null
  studioJobActive?: boolean
  studioJobs?: number
}

/* ── 会话操作参数 ─────────────────────────────────────────────── */

export interface CreateSessionInput {
  workspace?: string | null
  model?: ModelRef
  permissionMode?: PermissionMode
  /** 新建会话的显式模式；缺省 = work */
  mode?: SessionMode
  title?: string
  /** 演示会话（由主进程校验演示模型与演示工作区） */
  demo?: boolean
  /** 临时对话：只存在内存中，关闭应用后消失 */
  temporary?: boolean
}

export interface SendMessageInput {
  sessionId: string
  text: string
  attachments?: Attachment[]
  model?: ModelRef
  permissionMode?: PermissionMode
  /** 研究模式：本条消息启动/继续研究时的深度 */
  researchDepth?: ResearchDepth
  /** 研究自动续研的内部消息：不显示为用户气泡 */
  hidden?: boolean
  /** 无人值守运行（定时任务）：需要审批的操作自动拒绝，提问自动跳过 */
  unattended?: boolean
}

export interface SendMessageResult {
  runId: string
  userMessage: ChatMessage
  assistantMessageId: string
}

/** 运行中排队的下一条消息（P0-5） */
export interface QueuedMessage {
  id: string
  sessionId: string
  text: string
  attachments?: Attachment[]
  createdAt: number
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

const TODO_TEXT_LIMIT = 200

/** todo_write 会把文本截到 200 字，匹配时统一按同样口径归一化。 */
export function planStepKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, TODO_TEXT_LIMIT)
}

export function todoMatchesPlanStep(todo: TodoItem, stepText: string): boolean {
  return planStepKey(todo.text) === planStepKey(stepText)
}

export function planStepsCompleted(plan: SessionPlan, todos: TodoItem[]): boolean {
  if (plan.steps.length === 0) return false
  const completed = new Set(
    todos.filter((todo) => todo.status === 'completed').map((todo) => planStepKey(todo.text))
  )
  return plan.steps.every((step) => completed.has(planStepKey(step.text)))
}

/** 批准计划时建立全新的待办；此前的计划模式 todo 不应被当成已完成进度。 */
export function todosFromPlan(plan: SessionPlan): TodoItem[] {
  return plan.steps.map((step) => ({ id: `todo_${step.id}`, text: step.text, status: 'pending' as const }))
}

/** 消息里给用户看的纯文本；思考与工具块不进入复制内容。 */
export function messagePlainText(message: ChatMessage): string {
  return message.content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'error') return block.message
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

/**
 * 用户气泡与侧栏预览只展示用户输入本身。
 * 新消息用 displayText；旧消息在附件块前有固定分隔，回退截断。
 */
export function userMessageDisplayText(message: ChatMessage): string {
  if (typeof message.displayText === 'string') return message.displayText.trim()
  const text = messagePlainText(message)
  const marker = text.indexOf('\n\n[附件] ')
  return (marker >= 0 ? text.slice(0, marker) : text).trim()
}

/**
 * 编辑用户消息文本，保留原消息里的附件/图片块。
 * 用户消息正文是「用户输入 + 附件块」，只替换用户输入前缀，避免编辑后附件静默丢失。
 */
export function replaceUserMessageText(message: ChatMessage, text: string): ChatMessage {
  const value = text.trim()
  const display = userMessageDisplayText(message)
  // 旧版只有附件的消息没有 displayText，回退值就是附件块本身，不能把它当成用户正文
  const previous = typeof message.displayText !== 'string' && display.startsWith('[附件] ') ? '' : display
  let replaced = false
  const content = message.content.map((block) => {
    if (block.type !== 'text' || replaced) return block
    replaced = true
    if (previous && block.text.startsWith(previous)) {
      return { ...block, text: `${value}${block.text.slice(previous.length)}` }
    }
    const attachmentAt = block.text.indexOf('[附件] ')
    if (attachmentAt >= 0) {
      return { ...block, text: `${value}\n\n${block.text.slice(attachmentAt)}` }
    }
    return { ...block, text: value }
  })
  if (!replaced) content.push({ type: 'text', text: value })
  return { ...message, content, displayText: value }
}

/** 附件、预览与媒体结果的字节数显示。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 按参考价格估算一次用量（美元）；没有价格返回 undefined。 */
export function estimateUsageCost(usage: Pick<Usage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>, pricing: ModelPricing | undefined): number | undefined {
  if (!pricing) return undefined
  const cached = Math.min(usage.inputTokens, usage.cacheReadTokens ?? 0)
  const freshInput = Math.max(0, usage.inputTokens - cached)
  const inputCost = (freshInput / 1_000_000) * pricing.inputPerMTok
  const cachedCost = (cached / 1_000_000) * (pricing.cacheReadPerMTok ?? pricing.inputPerMTok)
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPerMTok
  return Math.round((inputCost + cachedCost + outputCost) * 1_000_000) / 1_000_000
}

export function formatUsd(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

/** Token 热力图的日期工具与月份标签排布（纯函数，便于单测）。 */

const WEEKDAY_MS = 86_400_000

export const MONTH_LABEL_MIN_GAP = 3

export function parseDay(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, (month ?? 1) - 1, day ?? 1)
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

export function diffDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / WEEKDAY_MS)
}

export function monthLabel(date: Date): string {
  return `${date.getMonth() + 1}月`
}

export function dayLabel(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

export function startOfWeek(date: Date): Date {
  return addDays(date, -((date.getDay() + 6) % 7))
}

export interface MonthLabel {
  column: number
  label: string
}

/**
 * 月份标签对齐到「该月 1 日所在的周列」。
 * 起始月剩余不足 3 周时不标起始月，否则它会和下个月标签挤在一起；其余标签至少间隔 3 列。
 */
export function buildMonthLabels(rangeStart: Date, end: Date): MonthLabel[] {
  const gridStart = startOfWeek(rangeStart)
  const columns = Math.ceil((diffDays(gridStart, end) + 1) / 7)
  const boundaries: MonthLabel[] = []
  let monthStart = new Date(rangeStart.getFullYear(), rangeStart.getMonth() + 1, 1)
  while (monthStart.getTime() <= end.getTime()) {
    const column = Math.floor(diffDays(gridStart, monthStart) / 7)
    if (column >= 0 && column < columns) boundaries.push({ column, label: monthLabel(monthStart) })
    monthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1)
  }
  const labels: MonthLabel[] = []
  const nextMonthStart = new Date(rangeStart.getFullYear(), rangeStart.getMonth() + 1, 1)
  if (diffDays(rangeStart, nextMonthStart) >= MONTH_LABEL_MIN_GAP * 7) {
    labels.push({ column: 0, label: monthLabel(rangeStart) })
  }
  for (const boundary of boundaries) {
    const previous = labels[labels.length - 1]
    if (previous && boundary.column - previous.column < MONTH_LABEL_MIN_GAP) continue
    labels.push(boundary)
  }
  return labels
}

export const LARGE_DIFF_CHARS = 20_000

export const DIFF_DISPLAY_LIMIT = 60_000

export interface DiffChange {
  value: string
  added?: boolean
  removed?: boolean
  count?: number
}

export interface DiffParagraphChange {
  value: string[]
  added?: boolean
  removed?: boolean
  count?: number
}

export interface CandidateDiffResult {
  parts: DiffChange[]
  paragraphs: DiffParagraphChange[]
  truncated: boolean
  /** 超长正文自动退到段落级，避免逐字 diff 卡住界面。 */
  degraded: boolean
}

export function candidateDiff(original: string, next: string, mode: 'chars' | 'paragraphs'): CandidateDiffResult {
  const truncated = original.length > DIFF_DISPLAY_LIMIT || next.length > DIFF_DISPLAY_LIMIT
  const left = original.slice(0, DIFF_DISPLAY_LIMIT)
  const right = next.slice(0, DIFF_DISPLAY_LIMIT)
  const large = original.length > LARGE_DIFF_CHARS || next.length > LARGE_DIFF_CHARS
  const leftParagraphs = left.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)
  const rightParagraphs = right.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)
  const paragraphs = diffArrays(leftParagraphs, rightParagraphs) as unknown as DiffParagraphChange[]
  const degraded = large && mode === 'chars'
  const parts = mode === 'chars' && !large ? diffChars(left, right) as DiffChange[] : []
  return { parts, paragraphs, truncated, degraded }
}
// 无外边框的石墨 + 香槟金滚动条。
export const MORROW_SCROLLBAR_RULES = `
* { scrollbar-width: thin !important; scrollbar-color: #8a6f42 transparent !important; }
*::-webkit-scrollbar { width: 8px !important; height: 8px !important; background: transparent !important; }
*::-webkit-scrollbar-track { background: transparent !important; border: 0 !important; }
*::-webkit-scrollbar-thumb {
  min-height: 36px; border: 1px solid transparent !important; border-radius: 999px !important;
  background: #8a6f42 !important; background-clip: content-box !important;
}
*::-webkit-scrollbar-thumb:hover {
  background: #b18f58 !important; background-clip: content-box !important;
}
*::-webkit-scrollbar-thumb:active {
  background: #e4ce9e !important; background-clip: content-box !important;
}
*::-webkit-scrollbar-corner { background: transparent !important; }
*::-webkit-scrollbar-button { display: none !important; width: 0 !important; height: 0 !important; }
`

export const MORROW_SCROLLBAR_CSS = `<style data-morrow-scrollbar>${MORROW_SCROLLBAR_RULES}</style>`

export function withMorrowScrollbar(html: string): string {
  if (!html || html.includes('data-morrow-scrollbar')) return html
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${MORROW_SCROLLBAR_CSS}</head>`)
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, `$&${MORROW_SCROLLBAR_CSS}`)
  return `${MORROW_SCROLLBAR_CSS}${html}`
}
/** 从 Markdown 行内代码/链接里识别工作区文件路径；只做保守匹配，避免把命令、URL、版本号变成文件链接。 */

export interface ParsedFilePath {
  /** 原始展示文本（可能带 :line） */
  display: string
  /** 去掉行号后的文件路径 */
  path: string
  /** 可选行号（仅用于提示，不改变打开目标） */
  line?: string
}

export const FILE_PATH_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'html', 'htm', 'css', 'scss', 'less', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml', 'svg', 'py', 'rb', 'go', 'rs', 'java', 'c',
  'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'sql', 'csv', 'tsv', 'log',
  'pdf', 'docx', 'xlsx', 'pptx', 'zip', '7z', 'rar', 'tar', 'gz', 'exe', 'msi', 'dll', 'png', 'jpg', 'jpeg',
  'gif', 'webp', 'bmp', 'ico', 'mp3', 'wav', 'mp4', 'mov', 'webm', 'woff', 'woff2', 'ttf', 'db', 'sqlite'
])

const BINARY_EXTENSIONS = new Set([
  'pdf', 'docx', 'xlsx', 'pptx', 'zip', '7z', 'rar', 'tar', 'gz', 'exe', 'msi', 'dll', 'png', 'jpg', 'jpeg',
  'gif', 'webp', 'bmp', 'ico', 'mp3', 'wav', 'mp4', 'mov', 'webm', 'woff', 'woff2', 'ttf', 'db', 'sqlite'
])

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/

const UNC = /^\\\\/

/** 排除代码表达式、命令拼接与 Windows 非法字符，避免把 `require('./a.js')` 当成文件 */
const INVALID_PATH_CHARS = /[<>"|?*\u0000-\u001f=;(){}'`]/

export function isAbsoluteFilePath(path: string): boolean {
  return WINDOWS_ABSOLUTE.test(path) || UNC.test(path) || path.startsWith('/')
}

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  return /\.([A-Za-z][A-Za-z0-9]{0,11})$/.exec(base)?.[1]?.toLowerCase() ?? ''
}

/**
 * 仅识别「看起来真的是文件」的文本：
 * - 支持 Windows/UNC/Unix 绝对路径、带目录的相对路径、带已知扩展名的裸文件名；
 * - 支持 `:12` / `:12:3` 行号后缀；
 * - 拒绝 URL、命令行参数、含非法 Windows 字符的内容。
 */
export function parseFilePath(raw: string, options: { allowBare?: boolean } = {}): ParsedFilePath | null {
  const display = raw.trim()
  if (!display || display.length > 500 || /[\r\n]/.test(display)) return null
  if (/^(?:https?|mailto|data|blob|morrow-file|file):/i.test(display)) return null
  if (display.includes('://') || display.startsWith('--') || display.startsWith('-')) return null

  const lineMatch = /^(.*?):(\d+)(?::\d+)?$/.exec(display)
  const path = (lineMatch?.[1] ?? display).trim()
  if (!path || path.length > 400) return null
  if (INVALID_PATH_CHARS.test(path)) return null
  if (!WINDOWS_ABSOLUTE.test(path) && path.includes(':')) return null

  const absolute = isAbsoluteFilePath(path)
  const hasSeparator = /[\\/]/.test(path)
  const ext = extensionOf(path)
  if (!ext) return null
  if (!absolute && !hasSeparator) {
    // 行内代码默认只认带目录的路径；裸文件名留给显式的 Markdown 链接，避免 console.log / example.com 误判。
    if (!options.allowBare || !FILE_PATH_EXTENSIONS.has(ext)) return null
  }

  return {
    display,
    path,
    ...(lineMatch?.[2] ? { line: lineMatch[2] } : {})
  }
}

/** 二进制文件不提供「复制内容」，避免把乱码写进剪贴板。 */
export function isTextFilePath(path: string): boolean {
  return !BINARY_EXTENSIONS.has(extensionOf(path))
}
/**
 * 附件文本解码：优先按 UTF-8（含 BOM），失败时回退到 Windows 中文环境常见的 GB18030。
 * 只用于附件读取；编辑器保存仍走 UTF-8，避免静默改写原文件编码。
 */
export interface DecodedText {
  text: string
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'
}

const ALLOWED_CONTROLS = new Set([8, 9, 10, 12, 13])

/** 采样控制字符与 NUL，判断解码结果是否更像二进制而不是文本。 */
export function looksBinaryText(text: string): boolean {
  if (!text) return false
  const sample = text.slice(0, 8192)
  let controls = 0
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index)
    if (code === 0) return true
    if (code < 32 && !ALLOWED_CONTROLS.has(code)) controls += 1
  }
  return controls / sample.length > 0.02
}

function decode(bytes: Uint8Array, encoding: string, fatal = false): string | null {
  try {
    return new TextDecoder(encoding, { fatal }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * 解码附件文本；返回 null 表示内容像二进制，不应内联给模型。
 * GB18030 几乎是 GBK/GB2312 的超集，能覆盖国内常见的旧版 .txt/.csv。
 */
export function decodeTextBytes(bytes: Uint8Array): DecodedText | null {
  if (bytes.length === 0) return { text: '', encoding: 'utf-8' }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = decode(bytes.subarray(3), 'utf-8')
    return text === null || looksBinaryText(text) ? null : { text, encoding: 'utf-8' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = decode(bytes.subarray(2), 'utf-16le')
    return text === null ? null : { text, encoding: 'utf-16le' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const text = decode(bytes.subarray(2), 'utf-16be')
    return text === null ? null : { text, encoding: 'utf-16be' }
  }

  const utf8 = decode(bytes, 'utf-8', true)
  if (utf8 !== null && !looksBinaryText(utf8)) return { text: utf8, encoding: 'utf-8' }

  const gb = decode(bytes, 'gb18030')
  if (gb !== null && !gb.includes('\uFFFD') && !looksBinaryText(gb)) {
    return { text: gb, encoding: 'gb18030' }
  }
  return null
}

export interface AnswerStyleOption {
  id: AnswerStyleId
  label: string
  summary: string
  prompt: string
}

export const ANSWER_STYLE_MAX_CUSTOM = 1200

export const ANSWER_STYLES: AnswerStyleOption[] = [
  {
    id: 'balanced',
    label: '平衡',
    summary: '清晰自然，先结论，再给必要的解释。',
    prompt:
      '先给结论，再给必要的解释或下一步；默认使用短段落或少量要点，不写套话，不重复用户的问题。'
  },
  {
    id: 'concise',
    label: '简洁',
    summary: '尽量短：先答案，只留关键理由与下一步。',
    prompt:
      '优先用最短的可执行回答：先直接回答，通常 1–3 句或不超过 5 个要点；省去客套、背景、重复和展开举例。不要省略关键风险、失败原因或需要用户确认的事项。'
  },
  {
    id: 'explanatory',
    label: '讲解',
    summary: '解释原因、步骤和原理，必要时举例。',
    prompt:
      '先给结论，再解释为什么这样做：补充关键原理、步骤依据和一个必要例子，帮助用户理解；不要堆砌术语或无关背景。'
  },
  {
    id: 'formal',
    label: '正式',
    summary: '专业书面语，适合报告、邮件和对外沟通。',
    prompt:
      '使用专业、客观、完整的书面语，适合直接放进报告、邮件或对外沟通；避免口语、感叹号、网络用语和过度亲昵的表达，但仍保持清楚易懂。'
  },
  {
    id: 'custom',
    label: '自定义',
    summary: '按你写下的偏好回答。',
    prompt: ''
  }
]

const STYLE_IDS = new Set<AnswerStyleId>(ANSWER_STYLES.map((style) => style.id))

export function isAnswerStyleId(value: unknown): value is AnswerStyleId {
  return typeof value === 'string' && STYLE_IDS.has(value as AnswerStyleId)
}

export function normalizeAnswerStyle(value: unknown): AnswerStyleId {
  return isAnswerStyleId(value) ? value : 'balanced'
}

/** 保留换行、压缩首尾空白；超长由设置层拒绝，这里只做宽松归一化。 */
export function normalizeAnswerStyleCustom(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n?/g, '\n').trim().slice(0, ANSWER_STYLE_MAX_CUSTOM)
}

export function answerStyleLabel(id: AnswerStyleId): string {
  return ANSWER_STYLES.find((style) => style.id === id)?.label ?? '平衡'
}

/**
 * 生成可拼进 system prompt 的「回答风格」段。
 * 明确的优先级说明放在段首，避免风格偏好覆盖安全与任务要求。
 */
export function buildAnswerStyleSection(style: AnswerStyleId, custom?: string): string {
  const normalized = normalizeAnswerStyle(style)
  const selection = ANSWER_STYLES.find((item) => item.id === normalized) ?? ANSWER_STYLES[0]
  const customText = normalizeAnswerStyleCustom(custom)
  const guidance =
    normalized === 'custom'
      ? customText ||
        '用户还没有写下自定义偏好。按「平衡」风格回答：先给结论，再给必要的解释或下一步。'
      : selection.prompt
  return [
    '## 回答风格（全局偏好）',
    '以下偏好只影响你对用户可见答复的措辞与结构，不改变工具使用、权限、安全边界、引用与核验要求，也不改变任务明确要求的交付格式；两者冲突时，以任务与安全要求为准。',
    `当前风格：${selection.label}。`,
    guidance
  ].join('\n')
}

const STATUSES: SwarmTaskStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled', 'exhausted']

function statusOf(value: unknown): SwarmTaskStatus {
  return typeof value === 'string' && (STATUSES as string[]).includes(value) ? (value as SwarmTaskStatus) : 'failed'
}

/** 按 index 合并一个子任务的最新状态，保证乱序/并行事件不会互相覆盖。 */
export function mergeSwarmTask(
  tasks: SwarmTaskProgress[] | undefined,
  incoming: SwarmTaskProgress
): SwarmTaskProgress[] {
  const next = tasks ? tasks.map((task) => ({ ...task })) : []
  const index = next.findIndex((task) => task.index === incoming.index)
  if (index >= 0) next[index] = { ...next[index], ...incoming }
  else next.push({ ...incoming })
  return next.sort((a, b) => a.index - b.index)
}

/** 从工具结果 meta.tasks 还原最终状态（重载旧会话、补发事件时使用）。 */
export function swarmTasksFromMeta(meta: unknown): SwarmTaskProgress[] {
  if (!meta || typeof meta !== 'object') return []
  const raw = (meta as Record<string, unknown>).tasks
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry, position) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    const title = typeof item.title === 'string' ? item.title : `子任务 ${position + 1}`
    return [
      {
        index: typeof item.index === 'number' ? item.index : position,
        title,
        agent: typeof item.agent === 'string' ? item.agent : typeof item.role === 'string' ? item.role : 'general',
        ...(typeof item.agentTitle === 'string' && item.agentTitle
          ? { agentTitle: item.agentTitle }
          : typeof item.role === 'string' && item.role
            ? { agentTitle: item.role }
            : {}),
        status: statusOf(item.status),
        ...(typeof item.steps === 'number' ? { stepCount: item.steps } : {}),
        ...(typeof item.summary === 'string' && item.summary ? { summary: item.summary } : {}),
        ...(typeof item.error === 'string' && item.error ? { error: item.error } : {}),
        ...(Array.isArray(item.operations) ? { operations: item.operations.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return []
          const op = entry as Record<string, unknown>
          if (typeof op.name !== 'string' || typeof op.title !== 'string') return []
          const status = typeof op.status === 'string' ? op.status : 'success'
          return [{
            id: typeof op.id === 'string' ? op.id : `${position}-${op.name}`,
            name: op.name,
            title: op.title,
            status: status as SwarmOperation['status'],
            ...(typeof op.input === 'string' ? { input: op.input.slice(0, 240) } : {}),
            ...(typeof op.output === 'string' ? { output: op.output.slice(0, 360) } : {}),
            ...(typeof op.error === 'string' ? { error: op.error.slice(0, 360) } : {}),
            ...(typeof op.startedAt === 'number' ? { startedAt: op.startedAt } : {}),
            ...(typeof op.finishedAt === 'number' ? { finishedAt: op.finishedAt } : {})
          }]
        }) } : {})
      }
    ]
  })
}
/**
 * 厂商无关的工具调用文本协议层。
 *
 * OpenAI 兼容接口正常应把工具调用放在结构化 tool_calls 里；但不同模型/网关
 * 在兼容性不佳时会把各自的“文本工具协议”写进正文。已知形态包括：
 *
 * - DeepSeek：`<｜｜DSML｜｜ calls>…` / `<|DSML|tool_calls>…`
 * - Kimi K2/K3：`<|tool_calls_section_begin|>` + `<|tool_call_begin|>functions.foo:0`
 * - MiniMax M2/M3：`<minimax:tool_call><invoke name="foo"><parameter …>`
 * - Qwen：`<tool_call>{"name":…,"arguments":…}</tool_call>` 或 `<function=foo><parameter=…>`
 * - GLM：`<tool_call>foo<arg_key>…</arg_key><arg_value>…</arg_value></tool_call>`
 * - Hermes / 通用：`<tool_call>` / `<function_call>` / `<invoke>`
 * - Mistral：`[TOOL_CALLS] [{"name":…}]`
 * - Llama：`<|python_tag|>{"name":…,"parameters":…}` 或 `[foo(x=1)]`
 *
 * 该模块负责：流式剔除协议文本、把可识别的调用还原成 {name,input}。
 */

const PIPE = '[|｜]{1,2}'

const DSML_MARK = `<${PIPE}\\s*DSML\\s*${PIPE}`

export interface TextToolCall {
  name: string
  input: Record<string, unknown>
}

/* ── 通用工具 ─────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function attr(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attributes)
  if (!match) return null
  return match[1] ?? match[2] ?? match[3] ?? null
}

function decodeValue(raw: string, stringAttr: string | null): unknown {
  if (stringAttr === 'true') return raw
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  if (stringAttr === 'false') {
    try {
      return JSON.parse(trimmed)
    } catch {
      return raw
    }
  }
  if (/^(?:[{[0-9-]|true$|false$|null$)/.test(trimmed)) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return raw
    }
  }
  return raw
}

function coerceInput(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw
  if (Array.isArray(raw)) return { value: raw }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return {}
    try {
      const parsed = JSON.parse(trimmed)
      if (isRecord(parsed)) return parsed
      return { value: parsed }
    } catch {
      return {}
    }
  }
  return {}
}

function normalizeCall(value: unknown): TextToolCall | null {
  if (!isRecord(value)) return null
  const fn = isRecord(value.function) ? value.function : isRecord(value.tool) ? value.tool : value
  const name =
    (typeof fn.name === 'string' && fn.name.trim()) ||
    (typeof value.name === 'string' && value.name.trim()) ||
    (typeof value.tool_name === 'string' && value.tool_name.trim()) ||
    (typeof value.function_name === 'string' && value.function_name.trim()) ||
    (typeof value.tool === 'string' && value.tool.trim()) ||
    ''
  if (!name) return null
  const args =
    fn.arguments ?? fn.parameters ?? fn.input ?? value.arguments ?? value.parameters ?? value.input ?? value.args ?? {}
  return { name, input: coerceInput(args) }
}

function collectCalls(value: unknown): TextToolCall[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectCalls(item))
  }
  if (isRecord(value) && Array.isArray(value.tool_calls)) {
    return value.tool_calls.flatMap((item) => collectCalls(item))
  }
  const call = normalizeCall(value)
  return call ? [call] : []
}

/** 扫描文本里所有完整的 JSON 对象/数组（忽略字符串内的括号）。 */
function jsonSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char !== '{' && char !== '[') {
      index += 1
      continue
    }
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let cursor = index; cursor < text.length; cursor += 1) {
      const current = text[cursor]
      if (inString) {
        if (escaped) escaped = false
        else if (current === '\\') escaped = true
        else if (current === '"') inString = false
        continue
      }
      if (current === '"') {
        inString = true
        continue
      }
      if (current === '{' || current === '[') depth += 1
      else if (current === '}' || current === ']') {
        depth -= 1
        if (depth === 0) {
          end = cursor + 1
          break
        }
      }
    }
    if (end > index) {
      spans.push({ start: index, end })
      index = end
    } else {
      index += 1
    }
  }
  return spans
}

function parseJsonCalls(text: string): TextToolCall[] {
  const calls: TextToolCall[] = []
  for (const span of jsonSpans(text)) {
    const raw = text.slice(span.start, span.end)
    try {
      calls.push(...collectCalls(JSON.parse(raw)))
    } catch {
      // 非 JSON，留给其它协议解析
    }
  }
  return calls
}

function normalizeDsmlTags(text: string): string {
  return text
    .replace(new RegExp(`</${PIPE}\\s*DSML\\s*${PIPE}\\s*`, 'gi'), '</')
    .replace(new RegExp(`<${PIPE}\\s*DSML\\s*${PIPE}\\s*`, 'gi'), '<')
}

function parseXmlParameters(body: string): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  const normalized = normalizeDsmlTags(body)
  // Qwen / MiniMax / DSML：<parameter name="x" string="true">v</parameter>
  const named = new RegExp(
    `<parameter\\b([^>]*)>([\\s\\S]*?)</parameter>`,
    'gi'
  )
  for (const match of normalized.matchAll(named)) {
    const attributes = match[1] ?? ''
    const name = attr(attributes, 'name')
    if (!name) continue
    input[name] = decodeValue(match[2] ?? '', attr(attributes, 'string'))
  }
  // Qwen3：<parameter=x>v</parameter>
  for (const match of normalized.matchAll(/<parameter=([A-Za-z_][\w.-]*)\s*>([\s\S]*?)<\/parameter>/gi)) {
    const name = match[1]
    if (name) input[name] = decodeValue(match[2] ?? '', null)
  }
  // GLM：<arg_key>k</arg_key><arg_value>v</arg_value>
  for (const match of normalized.matchAll(/<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi)) {
    const name = (match[1] ?? '').trim()
    if (name) input[name] = decodeValue(match[2] ?? '', null)
  }
  return input
}

function parseInvokeBlocks(body: string): TextToolCall[] {
  const calls: TextToolCall[] = []
  for (const match of body.matchAll(/<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/gi)) {
    const name = attr(match[1] ?? '', 'name')
    if (!name) continue
    let input = parseXmlParameters(match[2] ?? '')
    if (Object.keys(input).length === 0) {
      const json = parseJsonCalls(match[2] ?? '')
      if (json.length === 1) input = json[0].input
    }
    calls.push({ name, input })
  }
  return calls
}

function looksLikeToolName(value: string): boolean {
  const trimmed = value.trim()
  return /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(trimmed)
}

/** 解析 `<tool_call>…</tool_call>` 内部（JSON / Qwen / GLM / invoke 多种形态）。 */
function parseToolCallBody(body: string): TextToolCall[] {
  const trimmed = body.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = parseJsonCalls(trimmed)
    if (json.length > 0) return json
  }
  const invokes = parseInvokeBlocks(trimmed)
  if (invokes.length > 0) return invokes

  // Qwen3：<function=foo><parameter=x>v</parameter></function>
  for (const match of trimmed.matchAll(/<function(?:=|\s+name=)["']?([A-Za-z_][\w.-]*)["']?\s*>([\s\S]*?)<\/function>/gi)) {
    const name = match[1]
    if (!name) continue
    return [{ name, input: parseXmlParameters(match[2] ?? '') }]
  }

  // GLM：foo\n<arg_key>…</arg_key><arg_value>…</arg_value>
  if (/<arg_key>/i.test(trimmed)) {
    const firstTag = trimmed.search(/<arg_key>/i)
    const name = trimmed.slice(0, firstTag).replace(/<[^>]+>/g, ' ').trim().split(/\s+/)[0] ?? ''
    if (looksLikeToolName(name)) return [{ name, input: parseXmlParameters(trimmed) }]
  }

  // 通用：首行是工具名，其余是 JSON 参数
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (looksLikeToolName(firstLine)) {
    const rest = trimmed.slice(firstLine.length).trim()
    const json = rest ? parseJsonCalls(rest) : []
    if (json.length === 1) return [{ name: firstLine, input: json[0].input }]
    return [{ name: firstLine, input: parseXmlParameters(trimmed) }]
  }
  return []
}

function parseTagBlocks(text: string, tag: 'tool_call' | 'tool_calls' | 'function_call'): TextToolCall[] {
  const calls: TextToolCall[] = []
  const matcher = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi')
  for (const match of text.matchAll(matcher)) {
    const body = match[1] ?? ''
    if (tag === 'function_call') {
      const json = parseJsonCalls(body)
      if (json.length > 0) calls.push(...json)
      else calls.push(...parseToolCallBody(body))
      continue
    }
    // 外层 <tool_calls> 可能包着多个 <tool_call>
    if (tag === 'tool_calls' && /<tool_call\b/i.test(body)) {
      calls.push(...parseTagBlocks(body, 'tool_call'))
      continue
    }
    calls.push(...parseToolCallBody(body))
  }
  return calls
}

function parseKimi(text: string): TextToolCall[] {
  if (!text.includes('tool_call_begin')) return []
  const calls: TextToolCall[] = []
  const matcher = /<\|tool_call_begin\|>\s*([\s\S]*?)<\|tool_call_argument_begin\|>([\s\S]*?)<\|tool_call_end\|>/gi
  for (const match of text.matchAll(matcher)) {
    const header = (match[1] ?? '').trim().split(/\r?\n/)[0] ?? ''
    let name = header.replace(/^(?:functions?|tools?)\./i, '').replace(/:\d+$/, '').trim()
    if (!looksLikeToolName(name) || /^call_[A-Za-z0-9]+$/i.test(name)) name = ''
    let input: Record<string, unknown> = {}
    let embedded: TextToolCall | null = null
    try {
      const parsed = JSON.parse((match[2] ?? '').trim())
      embedded = normalizeCall(parsed)
      input = coerceInput(parsed)
    } catch {
      // 参数不是合法 JSON：保留空参数，由 Agent 生成可自修复错误
    }
    if (name) {
      calls.push({ name, input: embedded ? embedded.input : input })
    } else if (embedded) {
      calls.push(embedded)
    } else if (input && typeof input.name === 'string') {
      calls.push({ name: input.name, input })
    }
  }
  return calls
}

function parseSpecialToolTags(text: string): TextToolCall[] {
  const calls: TextToolCall[] = []
  for (const match of text.matchAll(/<\|tool_call\|>([\s\S]*?)(?:<\|tool_call_end\|>|<\|<\/tool_call\|>)/gi)) {
    calls.push(...parseToolCallBody(match[1] ?? ''))
  }
  return calls
}

function parsePythonic(text: string): TextToolCall[] {
  const trimmed = text.trim().replace(/^\[/, '').replace(/\]$/, '')
  const match = /^([A-Za-z_][\w.]*)\s*\(([\s\S]*)\)$/.exec(trimmed)
  if (!match) return []
  const name = match[1]
  const input: Record<string, unknown> = {}
  const args = match[2] ?? ''
  for (const part of args.split(/,\s*(?=[A-Za-z_][\w]*\s*=)/)) {
    const pair = /^([A-Za-z_][\w]*)\s*=\s*([\s\S]+)$/.exec(part.trim())
    if (!pair) continue
    let value = pair[2].trim()
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1)
    }
    input[pair[1]] = decodeValue(value, null)
  }
  return [{ name, input }]
}

function parsePrefixPayloads(text: string): TextToolCall[] {
  const calls: TextToolCall[] = []
  const mistral = /\[TOOL_CALLS\]/gi
  for (const match of text.matchAll(mistral)) {
    const rest = text.slice((match.index ?? 0) + match[0].length)
    const json = parseJsonCalls(rest)
    calls.push(...(json.length > 0 ? json : parsePythonic(rest)))
    break
  }
  const pythonTag = /<\|python_tag\|>/gi
  for (const match of text.matchAll(pythonTag)) {
    const rest = text.slice((match.index ?? 0) + match[0].length)
    const json = parseJsonCalls(rest)
    calls.push(...(json.length > 0 ? json : parsePythonic(rest)))
    break
  }
  return calls
}

function parseDsml(text: string): TextToolCall[] {
  if (!text.includes('DSML')) return []
  const calls: TextToolCall[] = []
  const invoke = new RegExp(`${DSML_MARK}\\s*invoke\\b([^>]*)>([\\s\\S]*?)</${PIPE}\\s*DSML\\s*${PIPE}\\s*invoke\\s*>`, 'gi')
  for (const match of text.matchAll(invoke)) {
    const name = attr(match[1] ?? '', 'name')
    if (!name) continue
    let input = parseXmlParameters(match[2] ?? '')
    if (Object.keys(input).length === 0) {
      const json = parseJsonCalls(match[2] ?? '')
      if (json.length === 1) input = json[0].input
    }
    calls.push({ name, input })
  }
  if (calls.length === 0) {
    const callsBlock = new RegExp(`${DSML_MARK}\\s*(?:calls|tool_calls)\\s*>([\\s\\S]*?)</${PIPE}\\s*DSML\\s*${PIPE}\\s*(?:calls|tool_calls)\\s*>`, 'i').exec(text)
    if (callsBlock) calls.push(...parseJsonCalls(callsBlock[1] ?? ''))
  }
  return calls
}

function dedupeCalls(calls: TextToolCall[]): TextToolCall[] {
  const seen = new Set<string>()
  const output: TextToolCall[] = []
  for (const call of calls) {
    const key = `${call.name}\u0000${JSON.stringify(call.input)}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(call)
  }
  return output
}

/** 从任意文本中解析出所有可识别的工具调用。 */
export function parseTextToolCalls(text: string): TextToolCall[] {
  if (!text) return []
  const calls: TextToolCall[] = []
  calls.push(...parseDsml(text))
  calls.push(...parseTagBlocks(text, 'tool_call'))
  calls.push(...parseTagBlocks(text, 'tool_calls'))
  calls.push(...parseTagBlocks(text, 'function_call'))
  calls.push(...parseInvokeBlocks(text))
  calls.push(...parseKimi(text))
  calls.push(...parseSpecialToolTags(text))
  calls.push(...parsePrefixPayloads(text))
  for (const match of text.matchAll(/```(?:tool_calls?|function_call)\s*\n?([\s\S]*?)```/gi)) {
    calls.push(...parseJsonCalls(match[1] ?? ''))
  }
  return dedupeCalls(calls)
}

/** 从文本中剔除所有已知的文本工具协议，保留正常回答；Markdown 代码围栏内的示例原样保留。 */
export function stripToolProtocol(text: string): string {
  if (!text) return text
  if (!/DSML|tool_call|tool_calls|function_call|python_tag|TOOL_CALLS|minimax|invoke|arg_key/i.test(text)) return text
  // 围栏内的内容可能是用户在看的示例代码，不能当成协议删除。
  const parts = text.split(/(```[\s\S]*?(?:```|$))/g)
  return parts.map((part) => (part.startsWith('```') ? part : stripPlainProtocol(part))).join('').trimEnd()
}

function stripPlainProtocol(text: string): string {
  let output = text
  const patterns: RegExp[] = [
    new RegExp(`${DSML_MARK}\\s*(?:calls|tool_calls)\\s*>[\\s\\S]*?</${PIPE}\\s*DSML\\s*${PIPE}\\s*(?:calls|tool_calls)\\s*>`, 'gi'),
    new RegExp(`${DSML_MARK}\\s*invoke\\b[^>]*>[\\s\\S]*?</${PIPE}\\s*DSML\\s*${PIPE}\\s*invoke\\s*>`, 'gi'),
    /<minimax:tool_call\b[^>]*>[\s\S]*?<\/minimax:tool_call>/gi,
    /<tool_calls?\b[^>]*>[\s\S]*?<\/tool_calls?>/gi,
    /<function_call\b[^>]*>[\s\S]*?<\/function_call>/gi,
    /<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi,
    /<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/gi,
    /<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/gi,
    /<\|tool_call\|>[\s\S]*?(?:<\|tool_call_end\|>|<\|<\/tool_call\|>)/gi,
    /```(?:tool_calls?|function_call)\s*[\s\S]*?```/gi
  ]
  for (const pattern of patterns) output = output.replace(pattern, '')
  // Mistral / Llama 这种前缀后直接跟 JSON 的：去掉前缀和完整 JSON，保留 JSON 之后的正文
  output = output.replace(/\[TOOL_CALLS\]\s*([\s\S]*)$/i, (_all, rest: string) => {
    const spans = jsonSpans(rest)
    return spans.length > 0 ? rest.slice(spans[spans.length - 1].end) : ''
  })
  output = output.replace(/<\|python_tag\|>\s*([\s\S]*)$/i, (_all, rest: string) => {
    const spans = jsonSpans(rest)
    return spans.length > 0 ? rest.slice(spans[spans.length - 1].end) : ''
  })
  // 未闭合的协议：从第一个标记起截断，避免把参数正文当回答
  const open = /(?:<\|tool_call_begin\|>|<\|tool_calls_section_begin\|>|<\|tool_call\|>|\[TOOL_CALLS\]|<\|python_tag\|>|<tool_call\b[^>]*>|<tool_calls\b[^>]*>|<minimax:tool_call\b[^>]*>|<function_call\b[^>]*>|<invoke\b[^>]*>)/i.exec(output)
  if (open) output = output.slice(0, open.index)
  const dsmlOpen = new RegExp(`${DSML_MARK}\\s*[^>]*>`, 'i').exec(output)
  if (dsmlOpen) output = output.slice(0, dsmlOpen.index)
  // 残留的特殊 token / 空标签
  output = output.replace(/<\|[^>|]*(?:tool_call|tool_calls_section|python_tag)[^>|]*\|>/gi, '')
  output = output.replace(/<\/?(?:tool_calls?|function_calls?|invoke|parameter|minimax:tool_call)\b[^>]*>/gi, '')
  return output.replace(/\n{3,}/g, '\n\n')
}

/* ── 流式过滤 ─────────────────────────────────────────────────── */

interface StartMatch {
  index: number
  length: number
  kind: string
  end: RegExp | null
  holdRest: boolean
}

function findStart(buffer: string): StartMatch | null {
  const candidates: StartMatch[] = []
  const push = (regex: RegExp, kind: string, end: RegExp | null, holdRest = false): void => {
    const match = regex.exec(buffer)
    if (match) candidates.push({ index: match.index, length: match[0].length, kind, end, holdRest })
  }
  push(/<\|tool_calls_section_begin\|>/i, 'kimi-section', /<\|tool_calls_section_end\|>/i)
  push(/<\|tool_call_begin\|>/i, 'kimi-call', /<\|tool_call_end\|>/i)
  push(new RegExp(`${DSML_MARK}\\s*(?:calls|tool_calls)\\s*>`, 'i'), 'dsml-calls', new RegExp(`</${PIPE}\\s*DSML\\s*${PIPE}\\s*(?:calls|tool_calls)\\s*>`, 'i'))
  push(new RegExp(`${DSML_MARK}\\s*invoke\\b[^>]*>`, 'i'), 'dsml-invoke', new RegExp(`</${PIPE}\\s*DSML\\s*${PIPE}\\s*invoke\\s*>`, 'i'))
  push(/<minimax:tool_call\b[^>]*>/i, 'minimax', /<\/minimax:tool_call>/i)
  const toolCall = /<(tool_calls?)\b[^>]*>/i.exec(buffer)
  if (toolCall) {
    const tag = toolCall[1]
    candidates.push({
      index: toolCall.index,
      length: toolCall[0].length,
      kind: 'tool-call',
      end: new RegExp(`</${tag}>`, 'i'),
      holdRest: false
    })
  }
  push(/<function_call\b[^>]*>/i, 'function-call', /<\/function_call>/i)
  push(/<invoke\b[^>]*>/i, 'invoke', /<\/invoke>/i)
  push(/<\|tool_call\|>/i, 'special-call', /(?:<\|tool_call_end\|>|<\|<\/tool_call\|>)/i)
  push(/\[TOOL_CALLS\]/i, 'mistral', null, true)
  push(/<\|python_tag\|>/i, 'python-tag', null, true)
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.index - b.index || b.length - a.length)
  return candidates[0]
}

/**
 * 流式过滤器：正文按分片放行；协议块缓冲到闭合后交给解析器。
 * feed() 返回可立即展示的安全文本，finish() 返回尾部文本与完整协议块。
 */
export class ToolProtocolStreamFilter {
  private buffer = ''
  private protocol = false
  private end: RegExp | null = null
  private holdRest = false
  private blocks: string[] = []
  /** Markdown 代码围栏内的内容按普通文本放行，避免把示例代码里的 <invoke> 当成真实工具调用 */
  private inFence = false

  feed(chunk: string): string {
    if (!chunk) return ''
    this.buffer += chunk
    let output = ''
    for (;;) {
      if (!this.protocol) {
        const start = findStart(this.buffer)
        const fence = this.buffer.indexOf('```')
        if (this.inFence) {
          if (fence < 0) {
            const hold = Math.min(2, this.buffer.length)
            output += this.buffer.slice(0, this.buffer.length - hold)
            this.buffer = hold > 0 ? this.buffer.slice(-hold) : ''
            return output
          }
          output += this.buffer.slice(0, fence + 3)
          this.buffer = this.buffer.slice(fence + 3)
          this.inFence = false
          continue
        }
        if (fence >= 0 && (!start || fence < start.index)) {
          output += this.buffer.slice(0, fence + 3)
          this.buffer = this.buffer.slice(fence + 3)
          this.inFence = true
          continue
        }
        if (start) {
          output += this.buffer.slice(0, start.index)
          // 保留起始标签/前缀，闭合后整块交给解析器；Mistral 等无闭合协议在 finish 时再切正文。
          this.buffer = this.buffer.slice(start.index)
          this.protocol = true
          this.end = start.end
          this.holdRest = start.holdRest
          continue
        }
        // 末尾可能是被拆开的标记：最多保留 64 个字符，等下一片再判断。
        const lastLt = Math.max(this.buffer.lastIndexOf('<'), this.buffer.lastIndexOf('['), this.buffer.lastIndexOf('`'))
        const hold = lastLt >= 0 && this.buffer.length - lastLt <= 64 ? this.buffer.length - lastLt : 0
        output += this.buffer.slice(0, this.buffer.length - hold)
        this.buffer = this.buffer.slice(this.buffer.length - hold)
        return output
      }
      if (this.holdRest) return output
      const end = this.end?.exec(this.buffer)
      if (!end || !this.end) return output
      this.blocks.push(this.buffer.slice(0, end.index + end[0].length))
      const rest = this.buffer.slice(end.index + end[0].length)
      this.buffer = rest
      this.protocol = false
      this.end = null
    }
  }

  finish(): { text: string; blocks: string[] } {
    let text = ''
    if (this.protocol) {
      if (this.holdRest) {
        const split = splitPrefixBlock(this.buffer)
        if (split.protocol) this.blocks.push(split.protocol)
        text = split.trailing
      } else {
        // 未闭合的协议块不能展示成正文；保留原始块供诊断/解析。
        this.blocks.push(this.buffer)
      }
      this.buffer = ''
      this.protocol = false
      this.end = null
      this.holdRest = false
    }
    text += this.buffer
    this.buffer = ''
    this.inFence = false
    const blocks = this.blocks
    this.blocks = []
    return { text, blocks }
  }
}

/** Mistral / Llama 前缀协议没有闭合标记：在 finish 时把 JSON 之后的正文还回去。 */
function splitPrefixBlock(block: string): { protocol: string; trailing: string } {
  const match = /^(?:\[TOOL_CALLS\]|<\|python_tag\|>)\s*/i.exec(block)
  if (!match) return { protocol: block, trailing: '' }
  const rest = block.slice(match[0].length)
  const spans = jsonSpans(rest)
  if (spans.length === 0) return { protocol: block, trailing: '' }
  const last = spans[spans.length - 1]
  return {
    protocol: match[0] + rest.slice(0, last.end),
    trailing: rest.slice(last.end)
  }
}

export interface BriefPreview {
  subject: string | null
  goal: string | null
  obstacle: string | null
  turn: string | null
  confidence: 'low' | 'medium' | 'high'
  questions: string[]
}

const SUBJECT_PATTERN = /([\u4e00-\u9fa5A-Za-z0-9]{1,14}(?:女孩|少年|男人|女人|老人|孩子|司机|作家|记者|医生|警察|店主|程序员|工程师|学生|老师|母亲|父亲|外婆|外公|皇后|皇帝|剑客|侦探|歌手|演员|机器人|AI|书店|伞铺|电台))/

const GOAL_PATTERN = /(?:想要|想|必须|决定|为了|要)([\u4e00-\u9fa5A-Za-z0-9“”"「」！？、，。；：\s]{2,40})/

const OBSTACLE_PATTERN = /(?:却|但|可是|然而|没想到|直到|阻止)([\u4e00-\u9fa5A-Za-z0-9“”"「」！？、，。；：\s]{2,40})/

const TURN_PATTERN = /(?:每次|每当|结果|发现|原来|突然|直到)([\u4e00-\u9fa5A-Za-z0-9“”"「」！？、，。；：\s]{2,50})/

function clean(value: string | undefined): string | null {
  if (!value) return null
  const text = value.replace(/^[，,。；;：:\s]+|[，,。；;：:\s]+$/g, '').trim()
  return text ? text.slice(0, 46) : null
}

function firstMatch(pattern: RegExp, text: string): string | null {
  return clean(pattern.exec(text)?.[1])
}

export function previewBrief(logline: string, kind: StudioKind): BriefPreview {
  const text = logline.trim()
  const subject = clean(SUBJECT_PATTERN.exec(text)?.[1])
  const goal = firstMatch(GOAL_PATTERN, text)
  const obstacle = firstMatch(OBSTACLE_PATTERN, text)
  const turn = firstMatch(TURN_PATTERN, text)
  const signals = [goal, obstacle, turn].filter(Boolean).length
  const confidence: BriefPreview['confidence'] = text.length >= 18 && Boolean(subject) && signals >= 2
    ? 'high'
    : text.length >= 8 && signals >= 1
      ? 'medium'
      : 'low'
  const questions: string[] = []
  if (!subject) questions.push('主角是谁？')
  if (!goal) questions.push('她最想要什么？')
  if (!obstacle) questions.push('什么在阻止她？')
  if (!turn) questions.push('哪一刻让局面改变？')
  if (kind === 'drama' && text.length < 22) questions.push('这 96 秒里最关键的画面是什么？')
  return { subject, goal, obstacle, turn, confidence, questions: questions.slice(0, 2) }
}
