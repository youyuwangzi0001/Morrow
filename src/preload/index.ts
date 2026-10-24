import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { EVENT_CHANNEL, FOCUS_SESSION_CHANNEL, IPC, ISLAND_OPEN_CHANNEL, ISLAND_QUICK_SEND_CHANNEL, ISLAND_UPDATE_CHANNEL, WINDOW_CLOSE_REQUEST_CHANNEL, WINDOW_STATE_CHANNEL } from '../shared/ipc'
import type {
  CompactResult,
  GoalActionResult,
  GoalStartInput,
  IslandOpenMainInput,
  IslandQuickSendInput,
  PlanActionResult,
  SyncModelsResult,
  CompleteOnboardingInput,
  MorrowApi,
  ProviderTestInput,
  SaveProviderInput,
  SaveWebSearchInput,
  UpdateSettingsInput,
  WebSearchTestResult
} from '../shared/ipc'
import type {
  Artifact,
  ArtifactExportFormat,
  ArtifactVersionInfo,
  AskUserAnswer,
  Attachment,
  Bootstrap,
  CreateSessionInput,
  DemoInfo,
  FileSearchResult,
  ModelRef,
  PermissionDecision,
  PermissionMode,
  ProviderTestResult,
  Result,
  RuntimeEvent,
  RuntimeEventListener,
  SendMessageInput,
  SendMessageResult,
  Session,
  SessionMeta,
  SessionMode,
  Settings,
  WindowState,
  WorkspaceInfo
} from '../shared/types'

/**
 * 所有核心通道统一归一化为 Result：主进程 handler 即使因参数异常/系统调用失败抛出，
 * 渲染层也拿到可展示的结构化错误，而不是 Electron 的 "Error invoking remote method" 拒绝。
 */
const invoke = async <T>(channel: string, payload?: unknown): Promise<Result<T>> => {
  try {
    return (await ipcRenderer.invoke(channel, payload)) as Result<T>
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const message = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
    return { ok: false, error: { code: 'IPC_FAILED', message: message || '操作失败，请重试。' } }
  }
}

const api: MorrowApi = {
  platform: process.platform,
  isTest: process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode'),
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },

  bootstrap: () => invoke<Bootstrap>(IPC.bootstrap),

  onEvent: (listener: RuntimeEventListener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: RuntimeEvent): void => listener(payload)
    ipcRenderer.on(EVENT_CHANNEL, wrapped)
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, wrapped)
  },

  island: {
    snapshot: () => invoke<import('../shared/types').IslandSnapshot>(IPC.islandState),
    setExpanded: (expanded: boolean) => invoke<void>(IPC.islandSetExpanded, { expanded }),
    hide: () => invoke<void>(IPC.islandHide),
    openMain: (input?: IslandOpenMainInput) => invoke<void>(IPC.islandOpenMain, input ?? {}),
    quickSend: (input: IslandQuickSendInput) => invoke<void>(IPC.islandQuickSend, input),
    syncSession: (sessionId: string | null) => invoke<void>(IPC.islandSyncSession, { sessionId }),
    onState: (listener: (snapshot: import('../shared/types').IslandSnapshot) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: import('../shared/types').IslandSnapshot): void =>
        listener(payload)
      ipcRenderer.on(ISLAND_UPDATE_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(ISLAND_UPDATE_CHANNEL, wrapped)
    },
    onQuickSend: (listener: (input: IslandQuickSendInput) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: IslandQuickSendInput): void => listener(payload)
      ipcRenderer.on(ISLAND_QUICK_SEND_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(ISLAND_QUICK_SEND_CHANNEL, wrapped)
    },
    onOpen: (listener: (input: IslandOpenMainInput) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: IslandOpenMainInput): void => listener(payload)
      ipcRenderer.on(ISLAND_OPEN_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(ISLAND_OPEN_CHANNEL, wrapped)
    }
  },

  window: {
    minimize: () => invoke<void>(IPC.windowMinimize),
    toggleMaximize: () => invoke<boolean>(IPC.windowToggleMaximize),
    close: () => invoke<void>(IPC.windowClose),
    resolveClose: (action: 'minimize' | 'quit') => invoke<void>(IPC.windowResolveClose, { action }),
    getState: () => invoke<WindowState>(IPC.windowState),
    onStateChange: (listener: (state: WindowState) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: WindowState): void => listener(payload)
      ipcRenderer.on(WINDOW_STATE_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(WINDOW_STATE_CHANNEL, wrapped)
    },
    onCloseRequested: (listener: () => void) => {
      const wrapped = (): void => listener()
      ipcRenderer.on(WINDOW_CLOSE_REQUEST_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(WINDOW_CLOSE_REQUEST_CHANNEL, wrapped)
    }
  },

  chat: {
    send: (input: SendMessageInput) => invoke<SendMessageResult>(IPC.chatSend, input),
    startResearch: (input: { sessionId: string; plan: string; depth?: import('../shared/types').ResearchDepth }) =>
      invoke<SendMessageResult>(IPC.researchStart, input),
    steerResearch: (input: { sessionId: string; text: string }) =>
      invoke<import('../shared/types').ResearchState>(IPC.researchSteer, input),
    cancel: (runId: string) => invoke<void>(IPC.chatCancel, { runId }),
    compact: (sessionId: string) => invoke<CompactResult>(IPC.chatCompact, { sessionId }),
    regenerate: (sessionId: string) => invoke<SendMessageResult>(IPC.chatRegenerate, { sessionId }),
    editResend: (sessionId: string, messageId: string, text: string) =>
      invoke<SendMessageResult>(IPC.chatEditResend, { sessionId, messageId, text }),
    deleteAfter: (sessionId: string, messageId: string) => invoke<Session>(IPC.chatDeleteAfter, { sessionId, messageId }),
    respondPermission: (requestId: string, decision: PermissionDecision) =>
      invoke<void>(IPC.permissionRespond, { requestId, decision }),
    respondQuestion: (requestId: string, answer: AskUserAnswer) =>
      invoke<void>(IPC.questionRespond, { requestId, answer })
  },

  session: {
    list: () => invoke<SessionMeta[]>(IPC.sessionList),
    create: (input: CreateSessionInput) => invoke<Session>(IPC.sessionCreate, input),
    load: (sessionId: string) => invoke<Session>(IPC.sessionLoad, { sessionId }),
    rename: (sessionId: string, title: string) => invoke<SessionMeta>(IPC.sessionRename, { sessionId, title }),
    remove: (sessionId: string) => invoke<void>(IPC.sessionDelete, { sessionId }),
    setModel: (sessionId: string, model: ModelRef) => invoke<SessionMeta>(IPC.sessionSetModel, { sessionId, model }),
    setPermissionMode: (sessionId: string, mode: PermissionMode) =>
      invoke<SessionMeta>(IPC.sessionSetPermissionMode, { sessionId, mode }),
    setMode: (sessionId: string, mode: SessionMode) => invoke<SessionMeta>(IPC.sessionSetMode, { sessionId, mode }),
    setReasoningEffort: (sessionId: string, effort: import('../shared/types').ReasoningEffort) =>
      invoke<SessionMeta>(IPC.sessionSetReasoning, { sessionId, effort }),
    setPinned: (sessionId: string, pinned: boolean) => invoke<SessionMeta>(IPC.sessionSetPinned, { sessionId, pinned }),
    setArchived: (sessionId: string, archived: boolean) =>
      invoke<SessionMeta>(IPC.sessionSetArchived, { sessionId, archived }),
    branch: (sessionId: string, messageId: string, title?: string) =>
      invoke<Session>(IPC.sessionBranch, { sessionId, messageId, title }),
    exportSession: (sessionId: string, format: 'markdown' | 'json') =>
      invoke<string | null>(IPC.sessionExport, { sessionId, format }),
    clearAll: () => invoke<{ deleted: number }>(IPC.sessionClearAll)
  },

  settings: {
    get: () => invoke<Settings>(IPC.settingsGet),
    update: (patch: UpdateSettingsInput) => invoke<Settings>(IPC.settingsUpdate, patch),
    onChanged: (listener: (settings: Settings) => void) => {
      const handler = (_event: unknown, next: Settings): void => listener(next)
      ipcRenderer.on(IPC.settingsChanged, handler)
      return () => ipcRenderer.removeListener(IPC.settingsChanged, handler)
    },
    saveProvider: (input: SaveProviderInput) => invoke<Settings>(IPC.settingsSaveProvider, input),
    removeProvider: (providerId: string) => invoke<Settings>(IPC.settingsRemoveProvider, { providerId }),
    testProvider: (input: ProviderTestInput) => invoke<ProviderTestResult>(IPC.settingsTestProvider, input),
    completeOnboarding: (input: CompleteOnboardingInput) => invoke<Bootstrap>(IPC.settingsCompleteOnboarding, input),
    syncModels: (providerId: string) => invoke<SyncModelsResult>(IPC.settingsSyncModels, { providerId }),
    saveWebSearch: (input: SaveWebSearchInput) => invoke<Settings>(IPC.settingsSaveWebSearch, input),
    testWebSearch: () => invoke<WebSearchTestResult>(IPC.settingsTestWebSearch)
  },

  goal: {
    start: (input: GoalStartInput) => invoke<GoalActionResult>(IPC.goalStart, input),
    pause: (sessionId: string) => invoke<GoalActionResult>(IPC.goalPause, { sessionId }),
    resume: (sessionId: string) => invoke<GoalActionResult>(IPC.goalResume, { sessionId }),
    stop: (sessionId: string) => invoke<GoalActionResult>(IPC.goalStop, { sessionId }),
    clear: (sessionId: string) => invoke<GoalActionResult>(IPC.goalClear, { sessionId })
  },
  plan: {
    setMode: (sessionId: string, enabled: boolean) => invoke<SessionMeta>(IPC.planSetMode, { sessionId, enabled }),
    approve: (sessionId: string) => invoke<PlanActionResult>(IPC.planApprove, { sessionId }),
    revise: (sessionId: string, feedback: string) => invoke<PlanActionResult>(IPC.planRevise, { sessionId, feedback }),
    reject: (sessionId: string, feedback?: string) => invoke<PlanActionResult>(IPC.planReject, { sessionId, feedback })
  },
  checkpoints: {
    list: (sessionId: string) => invoke<import('../shared/types').TurnCheckpoint[]>(IPC.checkpointList, { sessionId }),
    preview: (sessionId: string, checkpointId: string) =>
      invoke<import('../shared/types').RewindPreview>(IPC.checkpointPreview, { sessionId, checkpointId }),
    rewind: (sessionId: string, checkpointId: string, scope: import('../shared/types').RewindScope) =>
      invoke<import('../shared/types').RewindResult>(IPC.checkpointRewind, { sessionId, checkpointId, scope })
  },
  queue: {
    list: (sessionId: string) => invoke<import('../shared/types').QueuedMessage[]>(IPC.queueList, { sessionId }),
    add: (input: { sessionId: string; text: string; attachments?: Attachment[] }) =>
      invoke<import('../shared/types').QueuedMessage[]>(IPC.queueAdd, input),
    update: (input: { sessionId: string; queueId: string; text: string }) =>
      invoke<import('../shared/types').QueuedMessage[]>(IPC.queueUpdate, input),
    remove: (input: { sessionId: string; queueId: string }) =>
      invoke<import('../shared/types').QueuedMessage[]>(IPC.queueRemove, input)
  },
  workspace: {
    pick: () => invoke<WorkspaceInfo | null>(IPC.workspacePick),
    validate: (path: string) => invoke<WorkspaceInfo>(IPC.workspaceValidate, { path }),
    recent: () => invoke<WorkspaceInfo[]>(IPC.workspaceRecent),
    createDemo: () => invoke<WorkspaceInfo>(IPC.workspaceCreateDemo)
  },

  demo: {
    info: () => invoke<DemoInfo>(IPC.demoInfo)
  },

  files: {
    search: (root: string, query: string, limit?: number) =>
      invoke<FileSearchResult[]>(IPC.fileSearch, { root, query, limit }),
    attach: () => invoke<Attachment[]>(IPC.fileAttach),
    getPathForFile: (file: File) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    },
    restoreSnapshot: (input: { sessionId: string; snapshotPath: string; targetPath: string }) =>
      invoke<void>(IPC.fileRestoreSnapshot, input)
  },

  artifacts: {
    read: (path: string) =>
      invoke<{ content: string; size: number; kind: string; truncated: boolean }>(IPC.artifactRead, { path }),
    previewHtml: (html: string) => invoke<{ url: string }>(IPC.artifactPreviewHtml, { html }),
    openExternal: (path: string) => invoke<void>(IPC.artifactOpenExternal, { path }),
    reveal: (path: string) => invoke<void>(IPC.artifactReveal, { path }),
    saveToWorkspace: (sessionId: string, artifactId: string) =>
      invoke<{ path: string; artifact: Artifact }>(IPC.artifactSaveToWorkspace, { sessionId, artifactId }),
    versions: (sessionId: string, artifactId: string) =>
      invoke<ArtifactVersionInfo[]>(IPC.artifactVersions, { sessionId, artifactId }),
    readVersion: (sessionId: string, artifactId: string, versionId: string) =>
      invoke<{ version: ArtifactVersionInfo; content: string }>(IPC.artifactVersionRead, {
        sessionId,
        artifactId,
        versionId
      }),
    restoreVersion: (sessionId: string, artifactId: string, versionId: string) =>
      invoke<Artifact>(IPC.artifactVersionRestore, { sessionId, artifactId, versionId }),
    exportFile: (sessionId: string, artifactId: string, format: ArtifactExportFormat) =>
      invoke<string | null>(IPC.artifactExport, { sessionId, artifactId, format }),
    exportText: (
      sessionId: string,
      artifactId: string,
      format: Exclude<ArtifactExportFormat, 'pdf' | 'original'>
    ) => invoke<string>(IPC.artifactExportText, { sessionId, artifactId, format })
  },

  tokenActivity: {
    get: () => invoke<import('../shared/types').TokenActivitySummary>(IPC.tokenActivityGet)
  },

  features: {
    invoke: async <T = unknown>(channel: string, payload?: unknown): Promise<import('../shared/types').Result<T>> => {
      if (!channel.startsWith('feature:')) {
        return { ok: false, error: { code: 'FEATURE_CHANNEL', message: `非法 feature channel：${channel}` } }
      }
      try {
        return (await ipcRenderer.invoke(channel, payload)) as import('../shared/types').Result<T>
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err)
        const message = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
        return { ok: false, error: { code: 'FEATURE_CHANNEL', message: message || `feature channel 不可用：${channel}` } }
      }
    },
    on: (channel: string, listener: (payload: unknown) => void): (() => void) => {
      if (!channel.startsWith('feature:')) return () => undefined
      const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => listener(payload)
      ipcRenderer.on(channel, wrapped)
      return () => ipcRenderer.removeListener(channel, wrapped)
    }
  },

  app: {
    openExternal: (url: string) => invoke<void>(IPC.openExternal, { url }),
    setTheme: (theme: 'dark' | 'light') => invoke<void>(IPC.appTheme, { theme }),
    openDataDir: () => invoke<void>(IPC.openDataDir),
    openLogs: () => invoke<void>(IPC.openLogs),
    changeDataDir: () => invoke<{ restarted: boolean; path?: string; canceled?: boolean; files?: number }>(IPC.changeDataDir),
    resetDataDir: () => invoke<{ restarted: boolean; canceled?: boolean }>(IPC.resetDataDir),
    onFocusSession: (listener: (sessionId: string) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, sessionId: string): void => listener(sessionId)
      ipcRenderer.on(FOCUS_SESSION_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(FOCUS_SESSION_CHANNEL, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('morrow', api)
