import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { EVENT_CHANNEL, IPC, WINDOW_STATE_CHANNEL } from '../shared/ipc'
import type {
  CompactResult,
  GoalActionResult,
  GoalStartInput,
  SyncModelsResult,
  CompleteOnboardingInput,
  MorrowApi,
  ProviderTestInput,
  SaveProviderInput,
  UpdateSettingsInput
} from '../shared/ipc'
import type {
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

const invoke = <T>(channel: string, payload?: unknown): Promise<Result<T>> =>
  ipcRenderer.invoke(channel, payload) as Promise<Result<T>>

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

  window: {
    minimize: () => invoke<void>(IPC.windowMinimize),
    toggleMaximize: () => invoke<boolean>(IPC.windowToggleMaximize),
    close: () => invoke<void>(IPC.windowClose),
    getState: () => invoke<WindowState>(IPC.windowState),
    onStateChange: (listener: (state: WindowState) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: WindowState): void => listener(payload)
      ipcRenderer.on(WINDOW_STATE_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(WINDOW_STATE_CHANNEL, wrapped)
    }
  },

  chat: {
    send: (input: SendMessageInput) => invoke<SendMessageResult>(IPC.chatSend, input),
    cancel: (runId: string) => invoke<void>(IPC.chatCancel, { runId }),
    compact: (sessionId: string) => invoke<CompactResult>(IPC.chatCompact, { sessionId }),
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
    setMode: (sessionId: string, mode: SessionMode) => invoke<SessionMeta>(IPC.sessionSetMode, { sessionId, mode })
  },

  settings: {
    get: () => invoke<Settings>(IPC.settingsGet),
    update: (patch: UpdateSettingsInput) => invoke<Settings>(IPC.settingsUpdate, patch),
    saveProvider: (input: SaveProviderInput) => invoke<Settings>(IPC.settingsSaveProvider, input),
    removeProvider: (providerId: string) => invoke<Settings>(IPC.settingsRemoveProvider, { providerId }),
    testProvider: (input: ProviderTestInput) => invoke<ProviderTestResult>(IPC.settingsTestProvider, input),
    completeOnboarding: (input: CompleteOnboardingInput) => invoke<Bootstrap>(IPC.settingsCompleteOnboarding, input),
    syncModels: (providerId: string) => invoke<SyncModelsResult>(IPC.settingsSyncModels, { providerId })
  },

  goal: {
    start: (input: GoalStartInput) => invoke<GoalActionResult>(IPC.goalStart, input),
    pause: (sessionId: string) => invoke<GoalActionResult>(IPC.goalPause, { sessionId }),
    resume: (sessionId: string) => invoke<GoalActionResult>(IPC.goalResume, { sessionId }),
    stop: (sessionId: string) => invoke<GoalActionResult>(IPC.goalStop, { sessionId }),
    clear: (sessionId: string) => invoke<GoalActionResult>(IPC.goalClear, { sessionId })
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
      invoke<{ content: string; size: number; kind: string }>(IPC.artifactRead, { path }),
    openExternal: (path: string) => invoke<void>(IPC.artifactOpenExternal, { path }),
    reveal: (path: string) => invoke<void>(IPC.artifactReveal, { path }),
    saveAs: (path: string) => invoke<string | null>(IPC.artifactSaveAs, { path })
  },

  features: {
    invoke: <T = unknown>(channel: string, payload?: unknown): Promise<import('../shared/types').Result<T>> => {
      if (!channel.startsWith('feature:')) {
        return Promise.resolve({ ok: false, error: { code: 'FEATURE_CHANNEL', message: `非法 feature channel：${channel}` } })
      }
      return ipcRenderer.invoke(channel, payload) as Promise<import('../shared/types').Result<T>>
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
    openDataDir: () => invoke<void>(IPC.openDataDir),
    openLogs: () => invoke<void>(IPC.openLogs)
  }
}

contextBridge.exposeInMainWorld('morrow', api)
