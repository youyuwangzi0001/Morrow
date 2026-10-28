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
  ModelInfo,
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
  /** 本会话覆盖的上下文上限；由支持该参数的本地代理读取 */
  contextWindow?: number
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

/* ── 集群成员 ───────────────────────────────────────────────────── */

export interface SwarmMemberRole {
  /** 小写名字（task/swarm 的 agent 字段） */
  name: string
  title: string
  description: string
  /** 角色专属系统提示（叠加在基础系统提示之后；只影响工作重点，不限制工具或权限） */
  systemPrompt: string
  source?: 'builtin' | 'project' | 'user'
}

export interface SwarmMemberRequest {
  /** 一句话任务描述（展示用） */
  description: string
  /** 完整指令，作为集群成员的用户消息 */
  prompt: string
  /** 父代理任务上下文摘要（可选） */
  context?: string
  /** 自定义角色；缺省为 general */
  role?: SwarmMemberRole
  /** swarm 子任务身份：让进度事件能精确更新对应任务 */
  swarmTask?: { index: number; title: string; agent: string }
}

export type SwarmMemberStatus = 'completed' | 'failed' | 'cancelled' | 'exhausted'

export interface SwarmMemberResult {
  /**
   * 集群成员终态。只有 `completed` 表示集群成员给出了可采用最终结论；
   * failed=模型请求失败、死循环或没有结论，cancelled=父任务取消（以 AbortError 向上传递）。
   * exhausted 仅用于兼容旧版本会话数据，当前内核不再限制成员步数。
   */
  status: SwarmMemberStatus
  /** 集群成员最后的文本结论（失败/耗尽时可能只是中间文字，父任务不得当成完成） */
  summary: string
  /** 实际使用的角色名 */
  role?: string
  steps: number
  usage: Usage
  /** 真实失败原因（模型错误 / 步数耗尽说明），父任务必须保留 */
  error?: string
  /** 集群成员执行期间失败的工具（名称 + 错误），父任务必须保留，不得被“完成”文字覆盖 */
  failedTools?: string[]
  /** 集群成员写/编辑过的文件（检查点登记用：absolutePath/beforeHash/afterHash/snapshotPath/created） */
  changedFiles?: Array<Record<string, unknown>>
  /** 成员实际执行过的全部工具操作，供集群卡片展开查看 */
  operations?: import('../shared/types').SwarmOperation[]
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

/** 用户选择的终端；id 对应 TerminalManager 的 profile id。 */
export interface CommandShell {
  id: string
  label: string
  file: string
}

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
  /** 集群成员深度：0 = 主 Agent；1 = 集群成员；集群成员不允许再嵌套 */
  depth: number
  /** 工具层只读兜底：即使调用方绕过权限层也只允许只读工具（主流程与集群成员共用权限链，通常为 false） */
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
  /** 集群成员/长任务进度：映射为 RuntimeEvent.tool_progress */
  progress(note: string, opts?: { title?: string; status?: ToolStatus; percent?: number; swarmTask?: import('../shared/types').SwarmTaskProgress }): void
  /** 写入记忆中心（主进程注入）；未注入时 remember 回退旧 MEMORY.md */
  remember?: (input: {
    text: string
    scope: 'project' | 'global'
    tags?: string[]
  }) => Promise<{ scope: 'project' | 'global'; text: string }>
  runSwarmMember(req: SwarmMemberRequest): Promise<SwarmMemberResult>
  /** 本轮可用的集群成员角色（含内置与自定义；测试上下文可省略） */
  agents?: SwarmMemberRole[]
  /** 联网搜索（由主进程注入；未配置时为 undefined，web_search 工具不会暴露） */
  searchWeb?: (input: { query: string; maxResults?: number; signal: AbortSignal }) => Promise<WebSearchResponse>
  /** 本机 PDF OCR（由主进程注入；未注入时扫描件会明确报错） */
  ocrPdf?: PdfOcrHandler
  /** 终端/后台任务（由主进程注入） */
  terminal?: TerminalToolHandler
  /** 本地多媒体引擎（由主进程注入；未注入时媒体工具明确报错） */
  media?: MediaToolHandler
  /** 创作台作品服务（由主进程注入；绑定作品后可用） */
  studio?: StudioToolHandler
  /** 当前对话的 Provider/模型；支持视觉时优先用于 describe_media */
  vision?: { provider: Provider; model: ModelInfo }
  /** 用户设置的默认终端（run_command 与一次性命令使用） */
  commandShell?: CommandShell
}

/** 创作台专用动作处理器（主进程注入；只走作品服务，不直接改文件）。 */
export interface StudioToolRequest {
  action: string
  projectId?: string
  [key: string]: unknown
}

export interface StudioToolResponse {
  summary: string
  data?: unknown
}

export type StudioToolHandler = (input: StudioToolRequest) => Promise<StudioToolResponse>

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

/* ── 本地多媒体（由主进程注入） ───────────────────────────────── */

export interface MediaProgressUpdate {
  /** 人话阶段，例如「加载模型」「采样 4/8」 */
  stage: string
  /** 0–100；未知时省略 */
  percent?: number
}

export interface MediaGenerateImageInput {
  workspace: string
  prompt: string
  /** 工作区内的参考图；提供时走图像编辑 */
  referencePath?: string
  width: number
  height: number
  seed?: number
  signal: AbortSignal
  onProgress: (update: MediaProgressUpdate) => void
  /** ComfyUI 返回的外部任务号；用于断电后对账与续跑。 */
  onPromptId?: (promptId: string) => void
}

export interface MediaGenerateVideoInput {
  workspace: string
  prompt: string
  /** 参考图/首帧（1–2 张）；不提供时由工具先生成首帧 */
  referencePaths: string[]
  /** 末帧；提供时走 FL2VA 首尾帧转场 */
  lastFramePath?: string
  /** reference = Ref2VA 身份参考；first-only = FL2VA 只锚定首帧；first-last = 首尾帧 */
  mode?: 'reference' | 'first-only' | 'first-last'
  width: number
  height: number
  seconds: number
  seed?: number
  signal: AbortSignal
  onProgress: (update: MediaProgressUpdate) => void
  onPromptId?: (promptId: string) => void
}

export interface MediaFilmShot {
  prompt: string
  imagePrompt?: string
  seconds: number
  /** 这一镜的末帧；提供时用首尾帧转场 */
  lastFramePath?: string
  /** 默认 true：从上一镜尾帧继续；false 时为本镜重新生成首帧 */
  continuePrevious?: boolean
}

export interface MediaGenerateFilmInput {
  workspace: string
  shots: MediaFilmShot[]
  /** 全片统一的角色/世界/风格描述，会拼进每张首帧 */
  style: string
  width: number
  height: number
  seed?: number
  signal: AbortSignal
  onProgress: (update: MediaProgressUpdate) => void
}

export interface MediaFilmResult extends MediaArtifactResult {
  shots: MediaArtifactResult[]
  coverPath?: string
}

export interface MediaEditInput {
  workspace: string
  inputPath: string
  /** concat 的完整片段列表（至少 2 个） */
  inputPaths?: string[]
  /** 省略时由主进程生成 media/edited/... */
  outputPath?: string
  operation: 'trim' | 'crop' | 'resize' | 'rotate' | 'flip' | 'speed' | 'mute' | 'volume' | 'extract_audio' | 'extract_frame' | 'gif' | 'convert' | 'concat'
  startSeconds?: number
  endSeconds?: number
  /** extract_frame：从末尾抽帧（默认从开头/指定时间） */
  fromEnd?: boolean
  /** extract_frame：指定时间点（秒） */
  atSeconds?: number
  width?: number
  height?: number
  x?: number
  y?: number
  angle?: number
  flip?: 'horizontal' | 'vertical'
  speed?: number
  volume?: number
  format?: string
  fps?: number
  signal: AbortSignal
  onProgress: (update: MediaProgressUpdate) => void
}

export interface MediaArtifactResult {
  path: string
  mediaKind?: 'image' | 'video' | 'audio'
  width?: number
  height?: number
  durationSec?: number
  bytes: number
  seed?: number
  model: string
  engine: string
  elapsedMs: number
  thumbnailDataUrl?: string
  referencePath?: string
}

export interface MediaDescribeInput {
  workspace: string
  path: string
  question?: string
  frames?: number
  signal: AbortSignal
  onProgress: (update: MediaProgressUpdate) => void
  /** 当前对话模型；声明 supportsVision 时优先调用它 */
  visionProvider?: { provider: Provider; model: ModelInfo }
}

export interface MediaDescribeResult {
  text: string
  model: string
  frameCount: number
  elapsedMs: number
  /** 当前对话模型不可用，已回退本机视觉模型 */
  fallback?: boolean
}

export interface MediaProbeResult {
  kind: 'image' | 'video' | 'audio' | 'unknown'
  width?: number
  height?: number
  durationSec?: number
  fps?: number
  codec?: string
  hasVideo?: boolean
  hasAudio?: boolean
  bytes: number
}

export interface MediaRunWorkflowInput {
  workspace: string
  modelId: string
  modelLabel: string
  workflow: import('../shared/studio').MediaWorkflowSpec
  prompt: string
  negativePrompt?: string
  referencePaths: string[]
  width: number
  height: number
  seconds?: number
  seed?: number
  signal: AbortSignal
  onProgress: (update: MediaProgressUpdate) => void
}

export interface MediaRenderAnimationInput {
  workspace: string
  /** 工作区内、提供 window.renderAt(t) 的自包含 HTML */
  htmlPath: string
  outputPath?: string
  durationSec: number
  fps: number
  width: number
  height: number
  /** renderAt(t) 的 t 单位；默认秒，兼容按毫秒写的代码 */
  timeUnit?: 'seconds' | 'milliseconds'
  signal: AbortSignal
  onProgress: (update: MediaProgressUpdate) => void
}

export interface MediaCatalogHandler {
  status(): Promise<import('../shared/studio').MediaCatalogStatus>
  manifest(id: string): Promise<import('../shared/studio').MediaModelManifest>
  installModel(
    id: string,
    onProgress: (update: MediaProgressUpdate) => void,
    signal: AbortSignal
  ): Promise<import('../shared/studio').MediaCatalogStatus>
  uninstallModel(id: string): Promise<import('../shared/studio').MediaCatalogStatus>
  installEngine(id: string): Promise<import('../shared/studio').MediaCatalogStatus>
  startEngine(id: string): Promise<import('../shared/studio').MediaCatalogStatus>
  stopEngine(id: string): Promise<import('../shared/studio').MediaCatalogStatus>
  registerModel(manifest: Record<string, unknown>): Promise<import('../shared/studio').MediaCatalogStatus>
  removeModel(id: string): Promise<import('../shared/studio').MediaCatalogStatus>
  registerEngine(manifest: Record<string, unknown>): Promise<import('../shared/studio').MediaCatalogStatus>
  removeEngine(id: string): Promise<import('../shared/studio').MediaCatalogStatus>
}

export interface MediaToolHandler {
  status(): Promise<import('../shared/types').MediaEngineStatus>
  catalog?: MediaCatalogHandler
  generateImage(input: MediaGenerateImageInput): Promise<MediaArtifactResult>
  generateVideo(input: MediaGenerateVideoInput): Promise<MediaArtifactResult>
  generateFilm(input: MediaGenerateFilmInput): Promise<MediaFilmResult>
  runWorkflow(input: MediaRunWorkflowInput): Promise<MediaArtifactResult>
  renderAnimation(input: MediaRenderAnimationInput): Promise<MediaArtifactResult>
  editMedia(input: MediaEditInput): Promise<MediaArtifactResult>
  probeMedia(input: { workspace: string; path: string }): Promise<MediaProbeResult>
  describeMedia(input: MediaDescribeInput): Promise<MediaDescribeResult>
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
  /** 本次可用的工具定义（主代理/集群成员按各自工具集传入） */
  tools?: ToolDefinition[]
  /** Goal 模式：active 时注入目标上下文与每轮行为规范 */
  goal?: Goal | null
  /** 计划模式：注入「先探索、提交计划、等待批准」段，只列只读/计划工具 */
  planMode?: boolean
  /** 是否配置了联网搜索；false 时从工具清单中移除 web_search */
  webSearchAvailable?: boolean
  /** 可用集群成员角色（工作模式注入；聊天/计划模式忽略） */
  agents?: SwarmMemberRole[]
  /** 全局回答风格；缺省按平衡风格 */
  answerStyle?: AnswerStyleId
  /** answerStyle=custom 时使用的用户偏好 */
  answerStyleCustom?: string
  /** 当前默认终端（注入环境段与命令语法提示） */
  terminalShell?: { id: string; label: string }
}

/* ── 其它 ─────────────────────────────────────────────────────── */

export type ConnectionTestOptions = {
  /** 超时（毫秒），默认 15000 */
  timeoutMs?: number
}
