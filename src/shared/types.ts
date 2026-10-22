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

/* ── 模型与提供方 ─────────────────────────────────────────────── */

export type ProviderKind = 'openai-compat' | 'anthropic' | 'demo'

export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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
  /** 推理强度如何映射到 provider：effort=reasoning_effort，thinking=thinking budget */
  reasoningStyle?: 'effort' | 'thinking'
  pricing?: ModelPricing
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
  /** 上次从服务商 /models 同步的时间；内置 Provider 升级合并时据此保留服务商返回的元数据 */
  modelsSyncedAt?: number
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
  /** swarm 每个子任务的实时状态与最终摘要 */
  swarmTasks?: SwarmTaskProgress[]
}

export type SwarmTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'exhausted'

export interface SwarmTaskProgress {
  index: number
  title: string
  agent: string
  status: SwarmTaskStatus
  stepCount?: number
  /** 最近一步在做什么 */
  note?: string
  summary?: string
  error?: string
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

export type WebSearchProvider = 'tavily' | 'brave' | 'serper' | 'searxng'

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

/* ── 设置 ─────────────────────────────────────────────────────── */

export type SendKey = 'enter' | 'ctrl+enter'

export type AnswerStyleId = 'balanced' | 'concise' | 'explanatory' | 'formal' | 'custom'

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
  /** 联网搜索配置 */
  webSearch: WebSearchSettings
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
      /** 子代理当前步数（用于活动条展示，不参与模型上下文） */
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
  | (RuntimeEventBase & { type: 'compaction'; phase: 'started' | 'finished'; savedTokens?: number })
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
