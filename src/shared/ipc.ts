import type {
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

  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatCompact: 'chat:compact',

  permissionRespond: 'permission:respond',
  questionRespond: 'question:respond',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsSaveProvider: 'settings:save-provider',
  settingsRemoveProvider: 'settings:remove-provider',
  settingsTestProvider: 'settings:test-provider',
  settingsCompleteOnboarding: 'settings:complete-onboarding',
  settingsSyncModels: 'settings:sync-models',
  goalStart: 'goal:start',
  goalPause: 'goal:pause',
  goalResume: 'goal:resume',
  goalStop: 'goal:stop',
  goalClear: 'goal:clear',

  workspacePick: 'workspace:pick',
  workspaceValidate: 'workspace:validate',
  workspaceRecent: 'workspace:recent',
  workspaceCreateDemo: 'workspace:create-demo',
  demoInfo: 'demo:info',

  fileSearch: 'file:search',
  fileAttach: 'file:attach',
  artifactRead: 'artifact:read',
  artifactOpenExternal: 'artifact:open-external',
  artifactReveal: 'artifact:reveal',
  artifactSaveAs: 'artifact:save-as',
  fileRestoreSnapshot: 'file:restore-snapshot'
} as const

export const EVENT_CHANNEL = 'morrow:event'
export const WINDOW_STATE_CHANNEL = 'morrow:window-state'

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

export interface SyncModelsResult {
  providerId: string
  providerName: string
  added: number
  updated: number
  total: number
  message: string
  models: ModelInfo[]
  settings?: import('./types').Settings
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
  window: {
    minimize(): Promise<Result<void>>
    toggleMaximize(): Promise<Result<boolean>>
    close(): Promise<Result<void>>
    getState(): Promise<Result<WindowState>>
    onStateChange(listener: (state: WindowState) => void): () => void
  }
  chat: {
    send(input: SendMessageInput): Promise<Result<SendMessageResult>>
    cancel(runId: string): Promise<Result<void>>
    compact(sessionId: string): Promise<Result<CompactResult>>
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
  }
  settings: {
    get(): Promise<Result<Settings>>
    update(patch: UpdateSettingsInput): Promise<Result<Settings>>
    saveProvider(input: SaveProviderInput): Promise<Result<Settings>>
    removeProvider(providerId: string): Promise<Result<Settings>>
    testProvider(input: ProviderTestInput): Promise<Result<ProviderTestResult>>
    completeOnboarding(input: CompleteOnboardingInput): Promise<Result<Bootstrap>>
    syncModels(providerId: string): Promise<Result<SyncModelsResult>>
  }
  goal: {
    start(input: GoalStartInput): Promise<Result<GoalActionResult>>
    pause(sessionId: string): Promise<Result<GoalActionResult>>
    resume(sessionId: string): Promise<Result<GoalActionResult>>
    stop(sessionId: string): Promise<Result<GoalActionResult>>
    clear(sessionId: string): Promise<Result<GoalActionResult>>
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
    read(path: string): Promise<Result<{ content: string; size: number; kind: string }>>
    openExternal(path: string): Promise<Result<void>>
    reveal(path: string): Promise<Result<void>>
    saveAs(path: string): Promise<Result<string | null>>
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
  }
}
