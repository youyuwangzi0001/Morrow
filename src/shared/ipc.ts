import type {
  Artifact,
  ArtifactExportFormat,
  ArtifactVersionInfo,
  AskUserAnswer,
  ModelInfo,
  Attachment,
  Bootstrap,
  CreateSessionInput,
  DemoInfo,
  FileSearchResult,
  ModelRef,
  PermissionDecision,
  PermissionMode,
  ProviderConfig,
  ProviderTestResult,
  Result,
  RuntimeEventListener,
  SendMessageInput,
  SendMessageResult,
  Session,
  SessionMeta,
  SessionMode,
  TokenActivitySummary,
  Settings,
  WindowState,
  WorkspaceInfo
} from './types'

/** 所有 invoke 通道唯一来源，主进程与 preload 都必须引用这里 */
export const IPC = {
  bootstrap: 'app:bootstrap',
  appInfo: 'app:info',
  openExternal: 'app:open-external',
  openDataDir: 'app:open-data-dir',
  openLogs: 'app:open-logs',
  changeDataDir: 'app:change-data-dir',
  resetDataDir: 'app:reset-data-dir',

  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowState: 'window:state',

  sessionList: 'session:list',
  sessionCreate: 'session:create',
  sessionLoad: 'session:load',
  sessionRename: 'session:rename',
  sessionDelete: 'session:delete',
  sessionSetModel: 'session:set-model',
  sessionSetPermissionMode: 'session:set-permission-mode',
  sessionSetMode: 'session:set-mode',
  sessionSetReasoning: 'session:set-reasoning',
  sessionSetPinned: 'session:set-pinned',
  sessionSetArchived: 'session:set-archived',
  sessionBranch: 'session:branch',
  sessionExport: 'session:export',
  sessionClearAll: 'session:clear-all',
  chatRegenerate: 'chat:regenerate',
  chatEditResend: 'chat:edit-resend',
  chatDeleteAfter: 'chat:delete-after',

  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatCompact: 'chat:compact',
  researchStart: 'research:start',
  researchSteer: 'research:steer',

  queueList: 'queue:list',
  queueAdd: 'queue:add',
  queueUpdate: 'queue:update',
  queueRemove: 'queue:remove',

  permissionRespond: 'permission:respond',
  questionRespond: 'question:respond',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsChanged: 'settings:changed',
  settingsSaveProvider: 'settings:save-provider',
  settingsRemoveProvider: 'settings:remove-provider',
  settingsTestProvider: 'settings:test-provider',
  settingsCompleteOnboarding: 'settings:complete-onboarding',
  settingsSyncModels: 'settings:sync-models',
  settingsSaveWebSearch: 'settings:save-web-search',
  settingsTestWebSearch: 'settings:test-web-search',
  goalStart: 'goal:start',
  goalPause: 'goal:pause',
  goalResume: 'goal:resume',
  goalStop: 'goal:stop',
  goalClear: 'goal:clear',

  planSetMode: 'plan:set-mode',
  planApprove: 'plan:approve',
  planRevise: 'plan:revise',
  planReject: 'plan:reject',

  checkpointList: 'checkpoint:list',
  checkpointPreview: 'checkpoint:preview',
  checkpointRewind: 'checkpoint:rewind',

  workspacePick: 'workspace:pick',
  workspaceValidate: 'workspace:validate',
  workspaceRecent: 'workspace:recent',
  workspaceCreateDemo: 'workspace:create-demo',
  demoInfo: 'demo:info',

  fileSearch: 'file:search',
  fileAttach: 'file:attach',
  artifactRead: 'artifact:read',
  artifactPreviewHtml: 'artifact:preview-html',
  artifactOpenExternal: 'artifact:open-external',
  artifactReveal: 'artifact:reveal',
  artifactSaveToWorkspace: 'artifact:save-to-workspace',
  artifactVersions: 'artifact:versions',
  artifactVersionRead: 'artifact:version-read',
  artifactVersionRestore: 'artifact:version-restore',
  artifactExport: 'artifact:export',
  artifactExportText: 'artifact:export-text',
  tokenActivityGet: 'token-activity:get',
  islandState: 'island:state',
  islandSetExpanded: 'island:set-expanded',
  islandHide: 'island:hide',
  islandOpenMain: 'island:open-main',
  islandQuickSend: 'island:quick-send',
  fileRestoreSnapshot: 'file:restore-snapshot'
} as const

export const EVENT_CHANNEL = 'morrow:event'
export const WINDOW_STATE_CHANNEL = 'morrow:window-state'
/** 系统通知点击后聚焦某个会话（主 → 渲染） */
export const FOCUS_SESSION_CHANNEL = 'morrow:focus-session'
/** 灵动岛状态推送（主进程 → 灵动岛窗口） */
export const ISLAND_UPDATE_CHANNEL = 'island:update'
/** 灵动岛把一句话交给主窗口发送（主进程 → 主窗口） */
export const ISLAND_QUICK_SEND_CHANNEL = 'morrow:island:quick-send'
/** 灵动岛请求主窗口切到某会话或新建会话（主进程 → 主窗口） */
export const ISLAND_OPEN_CHANNEL = 'morrow:island:open'

export interface IslandQuickSendInput {
  text: string
  /** 指定会话；缺省 = 主窗口当前会话 */
  sessionId?: string | null
}

export interface IslandOpenMainInput {
  sessionId?: string | null
  /** 打开后新建一个空对话 */
  newSession?: boolean
}

export interface CompactResult {
  compacted: boolean
  savedTokens: number
  messageCount: number
  reason?: string
}

export interface ProviderTestInput {
  providerId: string
  config?: Partial<ProviderConfig>
  apiKey?: string
  modelId?: string
}

export interface SaveProviderInput {
  config: ProviderConfig
  apiKey?: string
}

export interface GoalStartInput {
  sessionId: string
  objective: string
  maxRounds?: number
  /** 可选的预算参数（不传用产品默认：200 次工具调用 / 20 分钟 / 3 轮无进展） */
  maxToolCalls?: number
  maxActiveMs?: number
  maxNoProgressRounds?: number
}

export interface GoalActionResult {
  goal: import('./types').Goal | null
  /** 若启动了新一轮运行，返回 runId */
  runId?: string
}

export interface PlanActionResult {
  plan: import('./types').SessionPlan | null
  /** 批准或修订后若自动启动了运行，返回 runId */
  runId?: string
  meta?: import('./types').SessionMeta
}

export interface SyncModelsResult {
  providerId: string
  providerName: string
  added: number
  updated: number
  total: number
  message: string
  models: ModelInfo[]
  truncated?: boolean
  skipped?: number
  settings?: import('./types').Settings
}

export interface SaveWebSearchInput {
  enabled: boolean
  provider: import('./types').WebSearchProvider
  baseUrl?: string
  maxResults: number
  apiKey?: string
}

export interface WebSearchTestResult {
  ok: boolean
  provider: string
  sourceCount: number
  latencyMs: number
  message: string
  sources?: import('./types').WebSearchSource[]
}

export interface CompleteOnboardingInput {
  providerId?: string
  apiKey?: string
  model?: ModelRef
  workspace?: string | null
  demo?: boolean
}

export interface UpdateSettingsInput extends Partial<Settings> {}

/**
 * preload 通过 contextBridge 暴露给渲染层的窄接口。
 * 渲染层只能看到这个对象，拿不到 ipcRenderer / node。
 */
export interface MorrowApi {
  platform: string
  isTest: boolean
  versions: { electron: string; chrome: string; node: string }
  bootstrap(): Promise<Result<Bootstrap>>
  onEvent(listener: RuntimeEventListener): () => void
  island: {
    /** 当前桌面小伙伴状态（重开灵动岛时恢复） */
    snapshot(): Promise<Result<import('./types').IslandSnapshot>>
    /** 展开/收起；主进程负责改变窗口尺寸并保持贴边 */
    setExpanded(expanded: boolean): Promise<Result<void>>
    /** 完全隐藏灵动岛（不关闭功能，仍可从托盘/快捷键唤回） */
    hide(): Promise<Result<void>>
    /** 打开主窗口，可顺带切到指定会话或新建对话 */
    openMain(input?: IslandOpenMainInput): Promise<Result<void>>
    /** 把一句话交给主窗口发送；主窗口会显示并开始运行 */
    quickSend(input: IslandQuickSendInput): Promise<Result<void>>
    onState(listener: (snapshot: import('./types').IslandSnapshot) => void): () => void
    /** 仅主窗口使用：接收灵动岛转来的消息 */
    onQuickSend(listener: (input: IslandQuickSendInput) => void): () => void
    /** 仅主窗口使用：响应灵动岛的「打开/新对话」 */
    onOpen(listener: (input: IslandOpenMainInput) => void): () => void
  }
  window: {
    minimize(): Promise<Result<void>>
    toggleMaximize(): Promise<Result<boolean>>
    close(): Promise<Result<void>>
    getState(): Promise<Result<WindowState>>
    onStateChange(listener: (state: WindowState) => void): () => void
  }
  chat: {
    send(input: SendMessageInput): Promise<Result<SendMessageResult>>
    /** 用户确认深度研究计划后开始检索 */
    startResearch(input: { sessionId: string; plan: string; depth?: import('./types').ResearchDepth }): Promise<Result<SendMessageResult>>
    /** 检索中追加研究要求（下一轮优先纳入） */
    steerResearch(input: { sessionId: string; text: string }): Promise<Result<import('./types').ResearchState>>
    cancel(runId: string): Promise<Result<void>>
    compact(sessionId: string): Promise<Result<CompactResult>>
    /** 重新生成最后一条用户消息的回复 */
    regenerate(sessionId: string): Promise<Result<SendMessageResult>>
    /** 编辑一条用户消息并从这里重新发送 */
    editResend(sessionId: string, messageId: string, text: string): Promise<Result<SendMessageResult>>
    /** 删除某条消息之后的所有消息（保留该条） */
    deleteAfter(sessionId: string, messageId: string): Promise<Result<Session>>
    respondPermission(requestId: string, decision: PermissionDecision): Promise<Result<void>>
    respondQuestion(requestId: string, answer: AskUserAnswer): Promise<Result<void>>
  }
  session: {
    list(): Promise<Result<SessionMeta[]>>
    create(input: CreateSessionInput): Promise<Result<Session>>
    load(sessionId: string): Promise<Result<Session>>
    rename(sessionId: string, title: string): Promise<Result<SessionMeta>>
    remove(sessionId: string): Promise<Result<void>>
    setModel(sessionId: string, model: ModelRef): Promise<Result<SessionMeta>>
    setPermissionMode(sessionId: string, mode: PermissionMode): Promise<Result<SessionMeta>>
    /** 切换显式「聊天 / 工作」模式（运行中会被拒绝；持久化到会话文件并广播 session_updated） */
    setMode(sessionId: string, mode: SessionMode): Promise<Result<SessionMeta>>
    /** 切换当前会话推理强度 */
    setReasoningEffort(
      sessionId: string,
      effort: import('./types').ReasoningEffort
    ): Promise<Result<SessionMeta>>
    setPinned(sessionId: string, pinned: boolean): Promise<Result<SessionMeta>>
    setArchived(sessionId: string, archived: boolean): Promise<Result<SessionMeta>>
    /** 从某条消息分叉出一个新会话 */
    branch(sessionId: string, messageId: string, title?: string): Promise<Result<Session>>
    /** 导出为 Markdown / JSON；返回保存路径，取消返回 null */
    exportSession(sessionId: string, format: 'markdown' | 'json'): Promise<Result<string | null>>
    /** 清除全部对话及其派生数据（快照/检查点/成品版本/用量/审批日志），不删除工作区文件 */
    clearAll(): Promise<Result<{ deleted: number }>>
  }
  settings: {
    get(): Promise<Result<Settings>>
    update(patch: UpdateSettingsInput): Promise<Result<Settings>>
    onChanged(listener: (settings: Settings) => void): () => void
    saveProvider(input: SaveProviderInput): Promise<Result<Settings>>
    removeProvider(providerId: string): Promise<Result<Settings>>
    testProvider(input: ProviderTestInput): Promise<Result<ProviderTestResult>>
    completeOnboarding(input: CompleteOnboardingInput): Promise<Result<Bootstrap>>
    syncModels(providerId: string): Promise<Result<SyncModelsResult>>
    saveWebSearch(input: SaveWebSearchInput): Promise<Result<Settings>>
    testWebSearch(): Promise<Result<WebSearchTestResult>>
  }
  goal: {
    start(input: GoalStartInput): Promise<Result<GoalActionResult>>
    pause(sessionId: string): Promise<Result<GoalActionResult>>
    resume(sessionId: string): Promise<Result<GoalActionResult>>
    stop(sessionId: string): Promise<Result<GoalActionResult>>
    clear(sessionId: string): Promise<Result<GoalActionResult>>
  },
  plan: {
    /** 开启/关闭计划模式（仅工作模式可用；运行中拒绝） */
    setMode(sessionId: string, enabled: boolean): Promise<Result<import('./types').SessionMeta>>
    /** 批准当前待审计划，自动切到执行并启动一轮运行 */
    approve(sessionId: string): Promise<Result<PlanActionResult>>
    /** 带着修改意见重新生成计划（自动启动计划模式运行） */
    revise(sessionId: string, feedback: string): Promise<Result<PlanActionResult>>
    /** 拒绝当前计划（保留在会话里，可重新规划） */
    reject(sessionId: string, feedback?: string): Promise<Result<PlanActionResult>>
  },
  checkpoints: {
    list(sessionId: string): Promise<Result<import('./types').TurnCheckpoint[]>>
    preview(sessionId: string, checkpointId: string): Promise<Result<import('./types').RewindPreview>>
    rewind(
      sessionId: string,
      checkpointId: string,
      scope: import('./types').RewindScope
    ): Promise<Result<import('./types').RewindResult>>
  },
  queue: {
    list(sessionId: string): Promise<Result<import('./types').QueuedMessage[]>>
    add(input: { sessionId: string; text: string; attachments?: import('./types').Attachment[] }): Promise<
      Result<import('./types').QueuedMessage[]>
    >
    update(input: { sessionId: string; queueId: string; text: string }): Promise<
      Result<import('./types').QueuedMessage[]>
    >
    remove(input: { sessionId: string; queueId: string }): Promise<Result<import('./types').QueuedMessage[]>>
  },
  workspace: {
    pick(): Promise<Result<WorkspaceInfo | null>>
    validate(path: string): Promise<Result<WorkspaceInfo>>
    recent(): Promise<Result<WorkspaceInfo[]>>
    createDemo(): Promise<Result<WorkspaceInfo>>
  }
  demo: {
    info(): Promise<Result<DemoInfo>>
  }
  files: {
    search(root: string, query: string, limit?: number): Promise<Result<FileSearchResult[]>>
    attach(): Promise<Result<Attachment[]>>
    /** Electron 38 起 File.path 已移除，拖拽文件需要走 webUtils 拿到真实路径 */
    getPathForFile(file: File): string
    /** 从写前快照恢复文件（撤销一次文件修改） */
    restoreSnapshot(input: { sessionId: string; snapshotPath: string; targetPath: string }): Promise<Result<void>>
  }
  artifacts: {
    read(path: string): Promise<Result<{ content: string; size: number; kind: string; truncated: boolean }>>
    /** 为 HTML 产物登记一份沙箱预览文档，返回可放进 iframe 的 morrow-artifact:// URL */
    previewHtml(html: string): Promise<Result<{ url: string }>>
    openExternal(path: string): Promise<Result<void>>
    reveal(path: string): Promise<Result<void>>
    /** 把成品保存到工作区 artifacts/ 并回写 artifact.path */
    saveToWorkspace(sessionId: string, artifactId: string): Promise<Result<{ path: string; artifact: Artifact }>>
    /** 文本成品的历史版本（最新在前）；打开时会先把当前内容同步为基线。 */
    versions(sessionId: string, artifactId: string): Promise<Result<ArtifactVersionInfo[]>>
    readVersion(
      sessionId: string,
      artifactId: string,
      versionId: string
    ): Promise<Result<{ version: ArtifactVersionInfo; content: string }>>
    /** 恢复到历史版本，并记录一个 restore 版本 */
    restoreVersion(sessionId: string, artifactId: string, versionId: string): Promise<Result<Artifact>>
    /** 导出为不同格式，弹出系统保存框；取消返回 null */
    exportFile(
      sessionId: string,
      artifactId: string,
      format: ArtifactExportFormat
    ): Promise<Result<string | null>>
    /** 生成导出文本用于复制，不落盘（PDF 除外） */
    exportText(
      sessionId: string,
      artifactId: string,
      format: Exclude<ArtifactExportFormat, 'pdf' | 'original'>
    ): Promise<Result<string>>
  }
  tokenActivity: {
    get(): Promise<Result<TokenActivitySummary>>
  }
  features: {
    /** 扩展功能统一入口；仅接受已注册的 feature:<name>:<action> 频道 */
    invoke<T = unknown>(channel: string, payload?: unknown): Promise<Result<T>>
    /** 扩展功能事件（仅接受 feature: 前缀）；返回取消订阅函数 */
    on(channel: string, listener: (payload: unknown) => void): () => void
  }
  app: {
    openExternal(url: string): Promise<Result<void>>
    openDataDir(): Promise<Result<void>>
    openLogs(): Promise<Result<void>>
    /** 选择并应用新的数据目录；迁移现有数据后重启 */
    changeDataDir(): Promise<Result<{ restarted: boolean; path?: string; canceled?: boolean; files?: number }>>
    /** 移除自定义目录并重启回默认目录（当前自定义目录不删除） */
    resetDataDir(): Promise<Result<{ restarted: boolean; canceled?: boolean }>>
    /** 系统通知点击：聚焦并切换到指定会话 */
    onFocusSession(listener: (sessionId: string) => void): () => void
  }
}
