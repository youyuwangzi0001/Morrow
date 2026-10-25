import { create } from 'zustand'
import { applyThemePreferences } from './theme'
import type {
  AppInfo,
  Artifact,
  ArtifactExportFormat,
  ArtifactVersionInfo,
  AskUserAnswer,
  AskUserRequest,
  Attachment,
  ChatMessage,
  FileSearchResult,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  Project,
  QueuedMessage,
  Result,
  RuntimeEvent,
  SendMessageResult,
  Session,
  SessionMeta,
  SessionMode,
  Settings,
  ThemeMode,
  Usage,
  WindowState
} from '@shared/types'
import { DEFAULT_MODEL, DEMO_MODEL, defaultSettings } from '@shared/models'
import { mergeSwarmTask, swarmTasksFromMeta } from '@shared/swarm'

/* ── IPC 结果解包 ─────────────────────────────────────────────── */

class IpcError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

async function call<T>(promise: Promise<Result<T>>): Promise<T> {
  const result = await promise
  if (!result.ok) throw new IpcError(result.error.code, result.error.message)
  return result.data
}

/* ── UI 类型 ──────────────────────────────────────────────────── */

export interface Toast {
  id: string
  kind: 'info' | 'success' | 'error' | 'warning'
  message: string
  actionLabel?: string
  action?: () => void
  createdAt: number
}

export interface RunState {
  runId: string
  sessionId: string
  startedAt: number
  assistantMessageId?: string
}

export interface StreamingState {
  messageId: string
  text: string
  thinking: string
}

export interface DemoStepState {
  index: number
  total: number
  caption: string
}

export interface AppStore {
  /* 启动 */
  ready: boolean
  bootError: string | null
  initPromise: Promise<void> | null

  /* 数据 */
  settings: Settings
  sessions: SessionMeta[]
  projects: Project[]
  appInfo: AppInfo | null
  demoAvailable: boolean
  hasAnyApiKey: boolean

  /* 当前会话 */
  activeSessionId: string | null
  session: Session | null
  loadingSession: boolean

  /* 运行态 */
  run: RunState | null
  /** 所有会话的活动运行（多会话后台运行） */
  runs: Record<string, RunState>
  /** 打断当前运行并发送新消息的过程态 */
  interrupting: boolean
  streaming: StreamingState | null
  /** 当前会话的审批/提问（UI 直接渲染） */
  pendingPermission: PermissionRequest | null
  pendingQuestion: AskUserRequest | null
  /** 按会话保留的挂起请求：切走再回来时恢复，后台运行也能收到提醒 */
  pendingPermissions: Record<string, PermissionRequest>
  pendingQuestions: Record<string, AskUserRequest>
  /** 按会话保存的运行中排队消息 */
  queues: Record<string, QueuedMessage[]>
  compacting: boolean
  /** 正在压缩的会话 id：切到别的会话时不应把它的输入框也锁住 */
  compactingSessionId: string | null
  demoStep: DemoStepState | null

  /* UI */
  windowState: WindowState
  sidebarCollapsed: boolean
  canvas: { open: boolean; artifactId: string | null }
  /** 底部集成终端是否展开 */
  terminalOpen: boolean
  /** 侧边聊天占用右侧栏；与画布共用栏宽，同一时间只显示一个 */
  sideChatOpen: boolean
  /** 从 /btw 打开时带入的第一个问题 */
  sideChatSeed: { question: string; nonce: number } | null
  paletteOpen: boolean
  settingsOpen: boolean
  onboardingOpen: boolean
  planExpanded: boolean
  /** 检查点回退面板 */
  rewindOpen: boolean
  rewindTargetMessageId: string | null
  theme: ThemeMode
  sidebarWidth: number
  canvasWidth: number
  autoCompact: boolean
  compactThreshold: number
  toast: Toast | null
  searchQuery: string
  /** 全局搜索命中后待定位的消息；Transcript 滚动并高亮后清空 */
  focusMessageId: string | null

  /* actions */
  init: () => Promise<void>
  applyEvent: (event: RuntimeEvent) => void
  newSession: (opts?: { workspace?: string | null; temporary?: boolean }) => Promise<Session | null>
  /** 清除全部对话及其派生数据；返回删除的对话数，失败返回 null */
  clearAllSessions: () => Promise<number | null>
  selectSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  setSessionPinned: (id: string, pinned: boolean) => Promise<void>
  setSessionArchived: (id: string, archived: boolean) => Promise<void>
  branchFromMessage: (messageId: string) => Promise<void>
  regenerateLast: () => Promise<void>
  editMessageAndResend: (messageId: string, text: string) => Promise<void>
  deleteMessagesAfter: (messageId: string) => Promise<void>
  exportCurrentSession: (format: 'markdown' | 'json') => Promise<void>
  sendMessage: (
    text: string,
    attachments?: Attachment[],
    options?: { researchDepth?: import('@shared/types').ResearchDepth }
  ) => Promise<boolean>
  /** 用户确认研究计划后开始检索 */
  startResearch: (
    sessionId: string,
    input: { plan: string; depth?: import('@shared/types').ResearchDepth }
  ) => Promise<boolean>
  /** 检索中追加研究要求 */
  steerResearch: (sessionId: string, text: string) => Promise<boolean>
  queueMessage: (text: string, attachments?: Attachment[]) => Promise<boolean>
  updateQueuedMessage: (id: string, text: string) => Promise<void>
  removeQueuedMessage: (id: string) => Promise<void>
  /** 停止当前运行并立即发送这条排队消息 */
  interruptAndSendQueued: (id: string) => Promise<void>
  /** 停止当前运行并立即发送输入内容 */
  interruptAndSend: (text: string, attachments?: Attachment[], targetSessionId?: string) => Promise<boolean>
  stopRun: () => Promise<void>
  /** 按 runId 停止后台会话任务 */
  stopRunById: (runId: string) => Promise<void>
  respondPermission: (decision: PermissionDecision) => Promise<void>
  respondQuestion: (answer: AskUserAnswer) => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  /** 从主进程重新读取设置（订阅等主进程侧 Provider 变更后同步 UI） */
  refreshSettings: () => Promise<void>
  saveProvider: (input: Parameters<typeof window.morrow.settings.saveProvider>[0]) => Promise<void>
  completeOnboarding: (input: Parameters<typeof window.morrow.settings.completeOnboarding>[0]) => Promise<void>
  testProvider: (input: Parameters<typeof window.morrow.settings.testProvider>[0]) => Promise<import('@shared/types').ProviderTestResult>
  saveWebSearch: (input: Parameters<typeof window.morrow.settings.saveWebSearch>[0]) => Promise<boolean>
  testWebSearch: () => Promise<import('@shared/ipc').WebSearchTestResult>
  removeProvider: (providerId: string) => Promise<void>
  pickWorkspaceInfo: () => Promise<import('@shared/types').WorkspaceInfo | null>
  /** 校验一个路径当前是否仍是可用文件夹；不可用返回 null */
  validateWorkspace: (path: string) => Promise<import('@shared/types').WorkspaceInfo | null>
  openDataDir: () => Promise<void>
  openLogs: () => Promise<void>
  changeDataDir: () => Promise<void>
  resetDataDir: () => Promise<void>
  setTheme: (theme: ThemeMode) => void
  toggleSidebar: () => void
  setSidebarWidth: (width: number, persist?: boolean) => void
  setCanvasWidth: (width: number, persist?: boolean) => void
  toggleCanvas: () => void
  toggleTerminal: () => void
  openTerminal: () => void
  closeTerminal: () => void
  startGoal: (objective: string, maxRounds?: number) => Promise<void>
  pauseGoal: () => Promise<void>
  resumeGoal: () => Promise<void>
  stopGoal: () => Promise<void>
  clearGoal: () => Promise<void>
  syncModels: (providerId: string) => Promise<import('@shared/ipc').SyncModelsResult | null>
  openSettings: () => void
  closeSettings: () => void
  openPalette: () => void
  closePalette: () => void
  openCanvas: (artifactId?: string) => void
  closeCanvas: () => void
  openSideChat: (question?: string) => void
  closeSideChat: () => void
  toggleSideChat: () => void
  clearSideChatSeed: () => void
  setPlanExpanded: (value: boolean) => void
  /** 打开回退面板（可指定某条用户消息对应的检查点） */
  openRewind: (messageId?: string) => void
  closeRewind: () => void
  /** 执行回退：恢复文件与/或截断对话 */
  rewindTo: (
    checkpointId: string,
    scope: import('@shared/types').RewindScope
  ) => Promise<{ ok: boolean; error?: string }>
  pickWorkspace: () => Promise<void>
  attachFiles: () => Promise<Attachment[]>
  searchFiles: (query: string) => Promise<FileSearchResult[]>
  startDemo: () => Promise<void>
  setSearchQuery: (query: string) => void
  focusMessage: (messageId: string) => void
  clearFocusMessage: () => void
  notify: (kind: Toast['kind'], message: string, action?: { label: string; run: () => void }) => void
  dismissToast: () => void
  copyText: (text: string) => Promise<void>
  setModel: (modelId: string, providerId: string) => Promise<void>
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  setReasoningEffort: (effort: import('@shared/types').ReasoningEffort) => Promise<void>
  /** 设置当前会话/默认模型的上下文上限（仅支持 contextOptions 的模型） */
  setContextWindow: (contextWindow?: number) => Promise<void>
  /** 切换显式「聊天 / 工作」模式（主进程持久化；运行中会先提示停止） */
  setSessionMode: (mode: SessionMode) => Promise<void>
  /** 开启/关闭计划模式（仅工作模式；运行中拒绝） */
  setPlanMode: (enabled: boolean) => Promise<void>
  /** 批准计划并自动开始执行 */
  approvePlan: () => Promise<void>
  /** 带修改意见重新规划 */
  revisePlan: (feedback: string) => Promise<void>
  /** 拒绝计划（保留计划文本与反馈） */
  rejectPlan: (feedback?: string) => Promise<void>
  revealArtifact: (path: string) => Promise<void>
  saveArtifactToWorkspace: (sessionId: string, artifactId: string) => Promise<void>
  loadArtifactVersions: (sessionId: string, artifactId: string) => Promise<ArtifactVersionInfo[]>
  readArtifactVersion: (
    sessionId: string,
    artifactId: string,
    versionId: string
  ) => Promise<{ version: ArtifactVersionInfo; content: string }>
  restoreArtifactVersion: (sessionId: string, artifactId: string, versionId: string) => Promise<void>
  exportArtifact: (sessionId: string, artifactId: string, format: ArtifactExportFormat) => Promise<string | null>
  copyArtifactExport: (
    sessionId: string,
    artifactId: string,
    format: Exclude<ArtifactExportFormat, 'pdf' | 'original'>
  ) => Promise<void>
  openExternal: (url: string) => Promise<void>
  openArtifactExternal: (path: string) => Promise<void>
  compactSession: () => Promise<void>
  undoFileChange: (snapshotPath: string, targetPath: string) => Promise<void>
}

/* ── 工具函数 ─────────────────────────────────────────────────── */

const now = (): number => Date.now()
const uid = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10)}`

function syncIslandSessionId(sessionId: string | null): void {
  void window.morrow?.island?.syncSession?.(sessionId).catch(() => undefined)
}

function applyTheme(settings: Settings): void {
  applyThemePreferences(settings)
  const root = document.documentElement
  root.style.setProperty('--fs-body', `${settings.fontSize}px`)
  root.style.setProperty('--fs-ui', `${Math.max(12, settings.fontSize - 1)}px`)
  root.style.setProperty('--fs-code', `${settings.codeFontSize || 12}px`)
  root.style.setProperty('--sidebar-w', `${clampSidebarWidth(settings.sidebarWidth)}px`)
}

const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 400
export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)))
}

const CANVAS_MIN = 320
const CANVAS_MAX = 960
export function clampCanvasWidth(width: number): number {
  return Math.min(CANVAS_MAX, Math.max(CANVAS_MIN, Math.round(width)))
}

const toast = (kind: Toast['kind'], message: string, extra?: Partial<Toast>): Toast => ({
  id: uid('toast'),
  kind,
  message,
  createdAt: now(),
  ...extra
})

function withSession(state: AppStore, next: Session | null): Partial<AppStore> {
  if (!next) return { session: null }
  return { session: next }
}

function updateSessionMessage(
  session: Session,
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage
): Session {
  const index = session.messages.findIndex((m) => m.id === messageId)
  if (index === -1) return session
  const messages = session.messages.slice()
  messages[index] = updater(messages[index])
  return { ...session, messages }
}

function upsertAssistantMessage(session: Session, messageId: string, textDelta?: string, thinkingDelta?: string): Session {
  const existing = session.messages.find((m) => m.id === messageId)
  if (!existing) {
    const message: ChatMessage = {
      id: messageId,
      role: 'assistant',
      content: [
        ...(thinkingDelta ? [{ type: 'thinking' as const, text: thinkingDelta }] : []),
        ...(textDelta ? [{ type: 'text' as const, text: textDelta }] : [])
      ],
      createdAt: now()
    }
    return { ...session, messages: [...session.messages, message] }
  }
  return updateSessionMessage(session, messageId, (message) => {
    const content = message.content.slice()
    if (thinkingDelta) {
      const last = content[content.length - 1]
      if (last && last.type === 'thinking') {
        content[content.length - 1] = { ...last, text: last.text + thinkingDelta }
      } else {
        content.push({ type: 'thinking', text: thinkingDelta })
      }
    }
    if (textDelta) {
      const last = content[content.length - 1]
      if (last && last.type === 'text') {
        content[content.length - 1] = { ...last, text: last.text + textDelta }
      } else {
        content.push({ type: 'text', text: textDelta })
      }
    }
    return { ...message, content }
  })
}

function replaceMessage(session: Session, message: ChatMessage): Session {
  const index = session.messages.findIndex((m) => m.id === message.id)
  if (index === -1) return { ...session, messages: [...session.messages, message] }
  const messages = session.messages.slice()
  messages[index] = message
  return { ...session, messages }
}

function deriveMeta(session: Session): SessionMeta {
  const preview = session.messages
    .filter((m) => m.role === 'user')
    .slice(-1)
    .map((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join(' '))
    .join('')
  return {
    id: session.id,
    title: session.title,
    workspace: session.workspace,
    model: session.model,
    permissionMode: session.permissionMode,
    ...(session.mode ? { mode: session.mode } : {}),
    ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
    ...(session.planMode ? { planMode: true } : {}),
    ...(session.pinned ? { pinned: true } : {}),
    ...(session.archived ? { archived: true } : {}),
    ...(session.plan ? { plan: session.plan } : {}),
    ...(session.research ? { research: session.research } : {}),
    ...(session.demo ? { demo: true } : {}),
    ...(session.temporary ? { temporary: true } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    preview: preview.slice(0, 120),
    todoProgress: session.todos.length
      ? { completed: session.todos.filter((t) => t.status === 'completed').length, total: session.todos.length }
      : undefined
  }
}

function upsertSessionMeta(list: SessionMeta[], meta: SessionMeta): SessionMeta[] {
  const rest = list.filter((s) => s.id !== meta.id)
  return [meta, ...rest].sort((a, b) => b.updatedAt - a.updatedAt)
}

function mergeUsage(prev: Usage, next: Usage): Usage {
  return {
    ...prev,
    ...next,
    inputTokens: next.inputTokens ?? prev.inputTokens,
    outputTokens: next.outputTokens ?? prev.outputTokens
  }
}

/* ── store ────────────────────────────────────────────────────── */

let subscribed = false
let sessionSelectRequest = 0

export const useAppStore = create<AppStore>()((set, get) => ({
  ready: false,
  bootError: null,
  initPromise: null,

  settings: defaultSettings(),
  sessions: [],
  projects: [],
  appInfo: null,
  demoAvailable: true,
  hasAnyApiKey: false,

  activeSessionId: null,
  session: null,
  loadingSession: false,

  run: null,
  runs: {},
  interrupting: false,
  streaming: null,
  pendingPermission: null,
  pendingQuestion: null,
  pendingPermissions: {},
  pendingQuestions: {},
  queues: {},
  compacting: false,
  compactingSessionId: null,
  demoStep: null,

  windowState: { maximized: false, focused: true, fullscreen: false },
  sidebarCollapsed: false,
  canvas: { open: false, artifactId: null },
  terminalOpen: false,
  sideChatOpen: false,
  sideChatSeed: null,
  paletteOpen: false,
  settingsOpen: false,
  onboardingOpen: false,
  planExpanded: true,
  rewindOpen: false,
  rewindTargetMessageId: null,
  theme: 'dark',
  sidebarWidth: 240,
  canvasWidth: 420,
  autoCompact: true,
  compactThreshold: 0.8,
  toast: null,
  searchQuery: '',
  focusMessageId: null,

  async init() {
    if (get().initPromise) {
      await get().initPromise
      return
    }
    const promise = (async () => {
      try {
        if (!subscribed) {
          subscribed = true
          window.morrow.onEvent((event) => get().applyEvent(event))
          window.morrow.window.onStateChange((state) => set({ windowState: state }))
          window.morrow.app.onFocusSession((sessionId) => {
            void get().selectSession(sessionId)
          })
        }
        const state = await call(window.morrow.window.getState())
        const bootstrap = await call(window.morrow.bootstrap())
        applyTheme(bootstrap.settings)
        const firstSession = bootstrap.sessions[0] ?? null
        set({
          ready: true,
          bootError: null,
          settings: bootstrap.settings,
          sessions: bootstrap.sessions,
          projects: bootstrap.projects,
          appInfo: bootstrap.app,
          demoAvailable: bootstrap.demoAvailable,
          hasAnyApiKey: bootstrap.hasAnyApiKey,
          theme: bootstrap.settings.theme,
          sidebarWidth: clampSidebarWidth(bootstrap.settings.sidebarWidth),
          canvasWidth: clampCanvasWidth(bootstrap.settings.canvasWidth),
          autoCompact: bootstrap.settings.autoCompact,
          compactThreshold: bootstrap.settings.compactThreshold,
          sidebarCollapsed: bootstrap.settings.sidebarCollapsed,
          windowState: state,
          onboardingOpen: !bootstrap.settings.onboardingDone,
          activeSessionId: firstSession?.id ?? null
        })
        if (firstSession) {
          try {
            const session = await call(window.morrow.session.load(firstSession.id))
            set({ session })
            syncIslandSessionId(firstSession.id)
            const queue = await window.morrow.queue.list(firstSession.id)
            if (queue.ok) {
              set((state) => ({ queues: { ...state.queues, [firstSession.id]: queue.data } }))
            }
          } catch {
            set({ session: null })
          }
        }
      } catch (err) {
        set({
          ready: true,
          bootError: err instanceof Error ? err.message : '应用初始化失败',
          onboardingOpen: false
        })
      }
    })()
    set({ initPromise: promise })
    return promise
  },

  applyEvent(event: RuntimeEvent) {
    const state = get()
    const currentSession = state.session
    const isCurrentRun = !!currentSession && currentSession.id === event.sessionId

    if (event.type === 'run_started') {
      const pendingPermissions = { ...state.pendingPermissions }
      const pendingQuestions = { ...state.pendingQuestions }
      delete pendingPermissions[event.sessionId]
      delete pendingQuestions[event.sessionId]
      const runState: RunState = {
        runId: event.runId,
        sessionId: event.sessionId,
        startedAt: event.at,
        assistantMessageId: event.assistantMessageId
      }
      set({
        runs: { ...state.runs, [event.sessionId]: runState },
        ...(isCurrentRun ? { run: runState } : {}),
        pendingPermissions,
        pendingQuestions,
        ...(isCurrentRun ? { pendingPermission: null, pendingQuestion: null } : {}),
        planExpanded: isCurrentRun ? true : state.planExpanded,
        ...(currentSession && isCurrentRun
          ? {
              session: {
                ...currentSession,
                messages: currentSession.messages.some((m) => m.id === event.userMessage.id)
                  ? currentSession.messages
                  : [...currentSession.messages, event.userMessage],
                updatedAt: event.at
              }
            }
          : {})
      })
      return
    }

    if (event.type === 'run_finished') {
      const existingRun = state.runs[event.sessionId]
      // 迟到的旧 run 结束事件不能清掉同会话的新运行
      if (existingRun && existingRun.runId !== event.runId) return
      const pendingPermissions = { ...state.pendingPermissions }
      const pendingQuestions = { ...state.pendingQuestions }
      delete pendingPermissions[event.sessionId]
      delete pendingQuestions[event.sessionId]
      const runs = { ...state.runs }
      delete runs[event.sessionId]
      const currentRun =
        state.run?.runId === event.runId ? (currentSession ? runs[currentSession.id] ?? null : null) : state.run
      set({
        run: currentRun,
        runs,
        streaming: isCurrentRun ? null : state.streaming,
        pendingPermissions,
        pendingQuestions,
        ...(isCurrentRun ? { pendingPermission: null, pendingQuestion: null } : {}),
        ...(state.compactingSessionId === event.sessionId ? { compacting: false, compactingSessionId: null } : {}),
        demoStep: isCurrentRun ? null : state.demoStep,
        ...(currentSession && isCurrentRun
          ? {
              session: {
                ...currentSession,
                usage: mergeUsage(currentSession.usage, event.usage),
                updatedAt: now()
              }
            }
          : {})
      })
      if (event.reason === 'error') {
        set({ toast: toast('error', isCurrentRun ? '这次任务没有完成。可以重试，或把需求说得更具体一点。' : '另一个对话的任务没有完成。') })
      }
      if (event.reason === 'complete') {
        set({ demoStep: null })
      }
      return
    }

    if (event.type === 'permission_requested') {
      const pendingPermissions = { ...state.pendingPermissions, [event.sessionId]: event.request }
      if (currentSession && isCurrentRun) {
        const session = updateSessionMessage(
          currentSession,
          currentSession.messages.find((m) => m.content.some((b) => b.type === 'tool_use' && b.id === event.request.toolUseId))?.id ?? '',
          (message) => ({
            ...message,
            content: message.content.map((block) =>
              block.type === 'tool_use' && block.id === event.request.toolUseId ? { ...block, status: 'waiting' } : block
            )
          })
        )
        set({ session, pendingPermissions, pendingPermission: event.request })
      } else {
        set({ pendingPermissions })
        const title = state.sessions.find((item) => item.id === event.sessionId)?.title ?? '另一个对话'
        get().notify('warning', `「${title}」需要你的确认`, {
          label: '去处理',
          run: () => {
            void get().selectSession(event.sessionId)
          }
        })
      }
      return
    }

    if (event.type === 'permission_resolved') {
      const pending = state.pendingPermissions[event.sessionId] ?? (isCurrentRun ? state.pendingPermission : null)
      const pendingPermissions = { ...state.pendingPermissions }
      delete pendingPermissions[event.sessionId]
      set({
        pendingPermissions,
        ...(isCurrentRun && currentSession
          ? {
              pendingPermission: state.pendingPermission?.id === event.requestId ? null : state.pendingPermission,
              ...(pending
                ? {
                    session: updateSessionMessage(
                      currentSession,
                      currentSession.messages.find((m) => m.content.some((b) => b.type === 'tool_use' && b.id === pending.toolUseId))?.id ?? '',
                      (message) => ({
                        ...message,
                        content: message.content.map((block) =>
                          block.type === 'tool_use' && block.id === pending.toolUseId
                            ? { ...block, status: event.decision === 'deny' ? 'denied' : 'running' }
                            : block
                        )
                      })
                    )
                  }
                : {})
            }
          : {})
      })
      return
    }

    if (event.type === 'question_asked') {
      const pendingQuestions = { ...state.pendingQuestions, [event.sessionId]: event.request }
      if (currentSession && isCurrentRun) {
        set({ pendingQuestions, pendingQuestion: event.request })
      } else {
        set({ pendingQuestions })
        const title = state.sessions.find((item) => item.id === event.sessionId)?.title ?? '另一个对话'
        get().notify('info', `「${title}」有一个问题需要你回答`, {
          label: '去回答',
          run: () => {
            void get().selectSession(event.sessionId)
          }
        })
      }
      return
    }

    if (event.type === 'question_answered') {
      const pendingQuestions = { ...state.pendingQuestions }
      delete pendingQuestions[event.sessionId]
      set({
        pendingQuestions,
        ...(isCurrentRun
          ? { pendingQuestion: state.pendingQuestion?.id === event.requestId ? null : state.pendingQuestion }
          : {})
      })
      return
    }

    if (event.type === 'research_updated') {
      set((state) => ({
        session:
          state.session?.id === event.sessionId
            ? { ...state.session, research: event.research }
            : state.session,
        sessions: state.sessions.map((item) =>
          item.id === event.sessionId ? { ...item, research: event.research ?? undefined } : item
        )
      }))
      return
    }

    if (event.type === 'session_updated') {
      // 侧栏元信息对所有会话都要刷新（包括后台运行结束的会话）
      set({
        sessions: upsertSessionMeta(state.sessions, event.meta),
        ...(currentSession && currentSession.id === event.meta.id
          ? {
              session: {
                ...currentSession,
                ...event.meta,
                // 元数据里 planMode 只在 true 时携带；这里显式归一化，
                // 避免批准执行后残留上一次的 true，导致输入框仍锁在计划模式。
                planMode: event.meta.planMode === true,
                plan: event.meta.plan ?? currentSession.plan ?? null
              }
            }
          : {})
      })
      return
    }

    // 队列是跨会话的全局视图（运行中心/侧栏），后台会话的队列变化也要同步
    if (event.type === 'queue_updated') {
      set((state) => ({ queues: { ...state.queues, [event.sessionId]: event.queue } }))
      return
    }

    const current = state.session
    if (!current || current.id !== event.sessionId) {
      // 非当前会话的内容事件不写入当前视图；切换会话时会从磁盘加载最新内容
      if (event.type === 'notice') set({ toast: toast('info', event.message) })
      return
    }

    switch (event.type) {
      case 'message_started': {
        const session = upsertAssistantMessage(current, event.messageId)
        set({ session })
        return
      }
      case 'message_delta': {
        const session = upsertAssistantMessage(current, event.messageId, event.textDelta, event.thinkingDelta)
        const prev = state.streaming && state.streaming.messageId === event.messageId ? state.streaming : { messageId: event.messageId, text: '', thinking: '' }
        set({
          session,
          streaming: {
            messageId: event.messageId,
            text: prev.text + (event.textDelta ?? ''),
            thinking: prev.thinking + (event.thinkingDelta ?? '')
          }
        })
        return
      }
      case 'message_completed': {
        const session = replaceMessage(current, event.message)
        set({
          session,
          streaming: state.streaming?.messageId === event.messageId ? null : state.streaming
        })
        return
      }
      case 'tool_started': {
        let session = current
        if (!session.messages.some((m) => m.id === event.messageId)) {
          session = upsertAssistantMessage(session, event.messageId)
        }
        session = updateSessionMessage(session, event.messageId, (message) => {
          const content = message.content.map((block) =>
            block.type === 'tool_use' && block.id === event.block.id ? event.block : block
          )
          if (!content.some((block) => block.type === 'tool_use' && block.id === event.block.id)) {
            content.push(event.block)
          }
          return { ...message, content }
        })
        set({ session })
        return
      }
      case 'tool_progress': {
        const session = updateSessionMessage(current, event.messageId, (message) => ({
          ...message,
          content: message.content.map((block) => {
            if (block.type !== 'tool_use' || block.id !== event.toolUseId) return block
            return {
              ...block,
              status: event.status ?? block.status,
              title: event.title ?? block.title,
              ...(typeof event.percent === 'number' ? { progressPercent: event.percent } : {}),
              ...(event.swarmTask
                ? { swarmTasks: mergeSwarmTask(block.swarmTasks, event.swarmTask) }
                : {})
            }
          })
        }))
        set({ session })
        return
      }
      case 'tool_finished': {
        const session = updateSessionMessage(current, event.messageId, (message) => ({
          ...message,
          content: message.content.map((block) => {
            if (block.type !== 'tool_use' || block.id !== event.toolUseId) return block
            const swarmTasks = swarmTasksFromMeta(event.result.meta)
            return {
              ...block,
              status: event.denied ? 'denied' : event.interrupted ? 'interrupted' : event.result.ok ? 'success' : 'error',
              result: event.result,
              finishedAt: event.at,
              ...(swarmTasks.length > 0 ? { swarmTasks } : {})
            }
          })
        }))
        set({ session })
        return
      }
      case 'todos_updated': {
        const completed = event.todos.filter((todo) => todo.status === 'completed').length
        const meta = state.sessions.find((item) => item.id === current.id)
        set({
          session: { ...current, todos: event.todos },
          ...(meta
            ? {
                sessions: upsertSessionMeta(state.sessions, {
                  ...meta,
                  updatedAt: Date.now(),
                  ...(event.todos.length
                    ? { todoProgress: { completed, total: event.todos.length } }
                    : { todoProgress: undefined })
                })
              }
            : {})
        })
        return
      }
      case 'artifacts_updated': {
        const isNew = event.artifacts.length > current.artifacts.length
        const target = event.artifactId
          ? event.artifacts.find((artifact) => artifact.id === event.artifactId)
          : isNew
            ? event.artifacts[event.artifacts.length - 1]
            : null
        set({
          session: { ...current, artifacts: event.artifacts },
          ...(target ? { canvas: { open: true, artifactId: target.id } } : {})
        })
        return
      }
      case 'usage_updated': {
        set({ session: { ...current, usage: mergeUsage(current.usage, event.usage) } })
        return
      }
      case 'compaction': {
        // 只维护当前会话的压缩状态，后台会话的压缩不能覆盖当前会话
        if (event.phase === 'started') {
          if (isCurrentRun) set({ compacting: true, compactingSessionId: event.sessionId })
        } else if (state.compactingSessionId === event.sessionId) {
          set({ compacting: false, compactingSessionId: null })
        }
        return
      }
      case 'messages_replaced': {
        if (!current || event.sessionId !== current.id) return
        set({ session: { ...current, messages: event.messages }, streaming: null })
        return
      }
      case 'notice': {
        const kind = event.level === 'success' ? 'success' : event.level === 'warn' ? 'warning' : 'info'
        set({ toast: toast(kind, event.message) })
        return
      }
      case 'error': {
        set({ toast: toast('error', event.error.message) })
        return
      }
      case 'demo_step': {
        set({ demoStep: { index: event.index, total: event.total, caption: event.caption } })
        return
      }
      case 'goal_updated': {
        set((state) => ({ session: state.session ? { ...state.session, goal: event.goal } : state.session }))
        return
      }
      case 'plan_updated': {
        set((state) => ({
          session: state.session
            ? { ...state.session, plan: event.plan, planMode: event.planMode }
            : state.session
        }))
        return
      }
      default:
        return
    }
  },

  async newSession(opts) {
    try {
      const workspace = opts?.workspace !== undefined ? opts.workspace : get().settings.lastWorkspace
      const temporary = opts?.temporary === true
      const session = await call(
        window.morrow.session.create({
          workspace,
          model: get().settings.defaultModel,
          permissionMode: get().settings.permissionMode,
          ...(temporary ? { temporary: true } : {})
        })
      )
      set({
        session,
        activeSessionId: session.id,
        sessions: upsertSessionMeta(get().sessions, deriveMeta(session)),
        run: null,
        pendingPermission: null,
        pendingQuestion: null,
        streaming: null,
        demoStep: null,
        canvas: { open: false, artifactId: null },
        planExpanded: true,
        toast: null
      })
      syncIslandSessionId(session.id)
      return session
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '新建对话失败')
      return null
    }
  },

  async clearAllSessions() {
    try {
      const result = await call(window.morrow.session.clearAll())
      set({
        sessions: [],
        session: null,
        activeSessionId: null,
        run: null,
        runs: {},
        pendingPermission: null,
        pendingQuestion: null,
        pendingPermissions: {},
        pendingQuestions: {},
        queues: {},
        streaming: null,
        demoStep: null,
        canvas: { open: false, artifactId: null },
        planExpanded: true,
        focusMessageId: null,
        sideChatOpen: false,
        toast: null
      })
      get().notify('success', result.deleted > 0 ? `已清除 ${result.deleted} 个对话。` : '没有需要清除的对话。')
      return result.deleted
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '清除全部对话失败')
      return null
    }
  },

  async selectSession(id) {
    if (get().activeSessionId === id && get().session) {
      syncIslandSessionId(id)
      return
    }
    const request = ++sessionSelectRequest
    set({ loadingSession: true, canvas: { open: false, artifactId: null }, planExpanded: true, demoStep: null, focusMessageId: null })
    try {
      const session = await call(window.morrow.session.load(id))
      const queue = await window.morrow.queue.list(id)
      // 快速连续切换时，较早的加载结果不能覆盖后选的会话
      if (request !== sessionSelectRequest) return
      set({
        session,
        activeSessionId: id,
        loadingSession: false,
        run: get().runs[id] ?? null,
        pendingPermission: get().pendingPermissions[id] ?? null,
        pendingQuestion: get().pendingQuestions[id] ?? null,
        ...(queue.ok ? { queues: { ...get().queues, [id]: queue.data } } : {}),
        // 后台运行的流式缓冲不属于新会话；切回时从增量落盘内容继续接流。
        streaming: null,
        // 演示进度属于被切走的会话，不能继续盖在新会话上
        demoStep: null
      })
      syncIslandSessionId(id)
    } catch (err) {
      set({ loadingSession: false })
      get().notify('error', err instanceof Error ? err.message : '会话加载失败')
    }
  },

  async deleteSession(id) {
    try {
      await call(window.morrow.session.remove(id))
      const sessions = get().sessions.filter((s) => s.id !== id)
      const pendingPermissions = { ...get().pendingPermissions }
      const pendingQuestions = { ...get().pendingQuestions }
      const queues = { ...get().queues }
      const runs = { ...get().runs }
      delete pendingPermissions[id]
      delete pendingQuestions[id]
      delete queues[id]
      delete runs[id]
      set({
        sessions,
        pendingPermissions,
        pendingQuestions,
        queues,
        runs,
        ...(get().session?.id === id ? { run: null } : {})
      })
      if (get().activeSessionId === id) {
        const next = sessions[0]
        set({ activeSessionId: next?.id ?? null, session: null, canvas: { open: false, artifactId: null } })
        if (next) await get().selectSession(next.id)
      }
      get().notify('success', '对话已删除')
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '删除失败')
    }
  },

  async renameSession(id, title) {
    try {
      const meta = await call(window.morrow.session.rename(id, title))
      set({
        sessions: upsertSessionMeta(get().sessions, meta),
        ...(get().session?.id === id ? { session: { ...get().session!, title } } : {})
      })
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '重命名失败')
    }
  },

  async setSessionPinned(id, pinned) {
    try {
      const meta = await call(window.morrow.session.setPinned(id, pinned))
      set((state) => ({
        sessions: upsertSessionMeta(state.sessions, meta),
        ...(state.session?.id === id ? { session: { ...state.session, pinned } } : {})
      }))
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '置顶操作失败')
    }
  },

  async setSessionArchived(id, archived) {
    try {
      const meta = await call(window.morrow.session.setArchived(id, archived))
      set((state) => ({
        sessions: upsertSessionMeta(state.sessions, meta),
        ...(state.session?.id === id ? { session: { ...state.session, archived } } : {})
      }))
      if (archived && get().activeSessionId === id) {
        const next = get().sessions.find((item) => item.id !== id && !item.archived)
        if (next) await get().selectSession(next.id)
        // 没有其他可见对话时开一个空白对话，避免停留在已归档会话上
        else await get().newSession({ workspace: get().session?.workspace ?? undefined })
      }
      get().notify('info', archived ? '对话已归档，可在 设置 → 归档 中恢复' : '对话已恢复到侧栏')
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '归档操作失败')
    }
  },

  async branchFromMessage(messageId) {
    const session = get().session
    if (!session) return
    try {
      const branch = await call(window.morrow.session.branch(session.id, messageId))
      set({
        session: branch,
        activeSessionId: branch.id,
        sessions: upsertSessionMeta(get().sessions, deriveMeta(branch)),
        canvas: { open: false, artifactId: null },
        run: null,
        planExpanded: true
      })
      syncIslandSessionId(branch.id)
      get().notify('success', '已从这条消息分叉出新对话')
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '分叉失败')
    }
  },

  async regenerateLast() {
    const session = get().session
    if (!session) return
    if (get().run) {
      get().notify('warning', '当前对话正在运行，先停止后再重新生成。')
      return
    }
    try {
      // 截断后的消息由主进程先发 messages_replaced，随后 run_started / run_finished
      // 依序维护运行状态；这里不再按返回值回写 run，否则极快的本地模型会让已结束的
      // 运行被重新标记为进行中。
      await call(window.morrow.chat.regenerate(session.id))
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '重新生成失败')
    }
  },

  async editMessageAndResend(messageId, text) {
    const session = get().session
    if (!session) return
    if (get().run) {
      get().notify('warning', '当前对话正在运行，先停止后再编辑发送。')
      return
    }
    try {
      await call(window.morrow.chat.editResend(session.id, messageId, text))
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '编辑重发失败')
    }
  },

  async deleteMessagesAfter(messageId) {
    const session = get().session
    if (!session) return
    if (get().run) {
      get().notify('warning', '当前对话正在运行，先停止后再删除后续消息。')
      return
    }
    try {
      const latest = await call(window.morrow.chat.deleteAfter(session.id, messageId))
      if (get().activeSessionId !== latest.id) return
      set({
        session: latest,
        sessions: upsertSessionMeta(get().sessions, deriveMeta(latest)),
        streaming: null
      })
      get().notify('success', '已删除后续消息')
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '删除后续消息失败')
    }
  },

  async exportCurrentSession(format) {
    const session = get().session
    if (!session) return
    try {
      const path = await call(window.morrow.session.exportSession(session.id, format))
      if (path) get().notify('success', `已导出到 ${path}`)
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '导出失败')
    }
  },

  async sendMessage(text, attachments, options) {
    const trimmed = text.trim()
    if (!trimmed && !attachments?.length) return false
    const active = get()
    if (active.compacting && (!active.compactingSessionId || active.compactingSessionId === active.session?.id)) {
      get().notify('info', '正在压缩上下文，完成后再发送。')
      return false
    }
    let session = get().session
    if (!session || get().activeSessionId === null) {
      session = await get().newSession()
      if (!session) return false
    }
    const running = get().run
    if (running && running.sessionId === session.id) {
      // 当前对话运行中：加入队列，本轮结束后自动发送
      return get().queueMessage(trimmed, attachments)
    }
    try {
      // run_started 事件会插入用户消息并设置运行状态；这里只负责发起请求。
      // 不能用 IPC 返回值回写 run：极快的本地模型可能在响应返回前就已经结束，
      // 回写会把已完成的运行重新标记为「进行中」，导致下一条消息被误加入队列。
      await call(
        window.morrow.chat.send({
          sessionId: session.id,
          text: trimmed,
          attachments: attachments?.length ? attachments : undefined,
          ...(options?.researchDepth ? { researchDepth: options.researchDepth } : {})
        })
      )
      return true
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '消息发送失败')
      return false
    }
  },

  async startResearch(sessionId, input) {
    try {
      await call(window.morrow.chat.startResearch({ sessionId, ...input }))
      return true
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '开始研究失败')
      return false
    }
  },

  async steerResearch(sessionId, text) {
    try {
      await call(window.morrow.chat.steerResearch({ sessionId, text }))
      return true
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '追加研究要求失败')
      return false
    }
  },

  async queueMessage(text, attachments) {    const session = get().session
    const trimmed = text.trim()
    if (!session || (!trimmed && !attachments?.length)) return false
    try {
      const queue = await call(
        window.morrow.queue.add({
          sessionId: session.id,
          text: trimmed,
          attachments: attachments?.length ? attachments : undefined
        })
      )
      set((state) => ({ queues: { ...state.queues, [session.id]: queue } }))
      get().notify('info', '已加入队列：本轮结束后自动发送。')
      return true
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '加入队列失败')
      return false
    }
  },

  async updateQueuedMessage(id, text) {
    const session = get().session
    if (!session) return
    try {
      const queue = await call(window.morrow.queue.update({ sessionId: session.id, queueId: id, text }))
      set((state) => ({ queues: { ...state.queues, [session.id]: queue } }))
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '修改排队消息失败')
    }
  },

  async removeQueuedMessage(id) {
    const session = get().session
    if (!session) return
    try {
      const queue = await call(window.morrow.queue.remove({ sessionId: session.id, queueId: id }))
      set((state) => ({ queues: { ...state.queues, [session.id]: queue } }))
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '删除排队消息失败')
    }
  },

  async interruptAndSendQueued(id) {
    const session = get().session
    if (!session) return
    const sessionId = session.id
    const item = (get().queues[sessionId] ?? []).find((queued) => queued.id === id)
    if (!item) return
    const sent = await get().interruptAndSend(item.text, item.attachments, sessionId)
    if (!sent) return
    // 只有确认消息已发出/已重新入队后才移除旧条目，避免失败时丢失
    try {
      const queue = await call(window.morrow.queue.remove({ sessionId, queueId: id }))
      set((state) => ({ queues: { ...state.queues, [sessionId]: queue } }))
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '删除排队消息失败')
    }
  },

  async interruptAndSend(text, attachments, targetSessionId) {
    const trimmed = text.trim()
    if (!trimmed && !attachments?.length) return false
    const sessionId = targetSessionId ?? get().session?.id
    if (!sessionId) return false
    const known = get().sessions.some((item) => item.id === sessionId) || get().session?.id === sessionId
    if (!known) return false
    const active = get().runs[sessionId]
    if (!active) {
      if (get().session?.id === sessionId) return get().sendMessage(trimmed, attachments)
      try {
        await call(
          window.morrow.chat.send({
            sessionId,
            text: trimmed,
            attachments: attachments?.length ? attachments : undefined
          })
        )
        return true
      } catch (err) {
        get().notify('error', err instanceof Error ? err.message : '发送消息失败')
        return false
      }
    }
    if (get().interrupting) return false
    set({ interrupting: true })
    try {
      await call(window.morrow.chat.cancel(active.runId))
      const deadline = Date.now() + 15_000
      while (get().runs[sessionId] && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (get().runs[sessionId]) {
        const queue = await call(
          window.morrow.queue.add({
            sessionId,
            text: trimmed,
            attachments: attachments?.length ? attachments : undefined
          })
        )
        set((state) => ({ queues: { ...state.queues, [sessionId]: queue } }))
        get().notify('warning', '停止当前任务超时，已把消息放回队列。')
        return true
      }
      if (get().session?.id === sessionId) {
        const sent = await get().sendMessage(trimmed, attachments)
        if (sent) get().notify('success', '已打断上一轮并发送新消息。')
        return sent
      }
      // 等待期间用户切走了会话：消息发回原会话，绝不落到新会话
      await call(
        window.morrow.chat.send({
          sessionId,
          text: trimmed,
          attachments: attachments?.length ? attachments : undefined
        })
      )
      get().notify('success', '已打断原对话并发送新消息。')
      return true
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '打断并发送失败')
      return false
    } finally {
      set({ interrupting: false })
    }
  },

  async stopRun() {
    const run = get().run
    if (!run) return
    await get().stopRunById(run.runId)
  },

  async stopRunById(runId) {
    try {
      await call(window.morrow.chat.cancel(runId))
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '停止失败')
    }
  },

  async respondPermission(decision) {
    const request = get().pendingPermission
    if (!request) return
    const requestId = request.id
    try {
      await call(window.morrow.chat.respondPermission(requestId, decision))
      set((state) => (state.pendingPermission?.id === requestId ? { pendingPermission: null } : {}))
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '审批失败')
    }
  },

  async respondQuestion(answer) {
    const request = get().pendingQuestion
    if (!request) return
    const requestId = request.id
    try {
      await call(window.morrow.chat.respondQuestion(requestId, answer))
      set((state) => (state.pendingQuestion?.id === requestId ? { pendingQuestion: null } : {}))
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '提交失败')
    }
  },

  async refreshSettings() {
    try {
      const settings = await call(window.morrow.settings.get())
      applyTheme(settings)
      set({
        settings,
        theme: settings.theme,
        sidebarCollapsed: settings.sidebarCollapsed,
        sidebarWidth: clampSidebarWidth(settings.sidebarWidth),
        canvasWidth: clampCanvasWidth(settings.canvasWidth),
        autoCompact: settings.autoCompact,
        compactThreshold: settings.compactThreshold,
        hasAnyApiKey: settings.providers.some(
          (p) => p.enabled && p.kind !== 'demo' && (p.category === 'local' || p.apiKeyStored)
        )
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : '刷新设置失败'
      get().notify('error', message)
    }
  },

  async updateSettings(patch) {
    try {
      const settings = await call(window.morrow.settings.update(patch))
      applyTheme(settings)
      set({
        settings,
        theme: settings.theme,
        sidebarCollapsed: settings.sidebarCollapsed,
        sidebarWidth: clampSidebarWidth(settings.sidebarWidth),
        canvasWidth: clampCanvasWidth(settings.canvasWidth),
        autoCompact: settings.autoCompact,
        compactThreshold: settings.compactThreshold
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : '设置保存失败'
      get().notify('error', message)
      throw new Error(message)
    }
  },

  async saveProvider(input) {
    try {
      const settings = await call(window.morrow.settings.saveProvider(input))
      applyTheme(settings)
      set({
        settings,
        hasAnyApiKey: settings.providers.some(
          (p) => p.enabled && p.kind !== 'demo' && (p.category === 'local' || p.apiKeyStored)
        )
      })
      get().notify('success', input.apiKey === '' ? '已清除保存的密钥' : '模型服务已保存')
    } catch (err) {
      const message = err instanceof Error ? err.message : '模型服务保存失败'
      get().notify('error', message)
      throw new Error(message)
    }
  },

  async completeOnboarding(input) {
    try {
      const bootstrap = await call(window.morrow.settings.completeOnboarding(input))
      applyTheme(bootstrap.settings)
      const first = bootstrap.sessions[0] ?? null
      set({
        settings: bootstrap.settings,
        sessions: bootstrap.sessions,
        demoAvailable: bootstrap.demoAvailable,
        hasAnyApiKey: bootstrap.hasAnyApiKey,
        onboardingOpen: false,
        theme: bootstrap.settings.theme,
        sidebarWidth: clampSidebarWidth(bootstrap.settings.sidebarWidth),
        autoCompact: bootstrap.settings.autoCompact,
        compactThreshold: bootstrap.settings.compactThreshold,
        activeSessionId: first?.id ?? null
      })
      if (first) await get().selectSession(first.id)
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '初始化设置失败')
    }
  },

  async testProvider(input) {
    try {
      return await call(window.morrow.settings.testProvider(input))
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : '连接测试失败')
    }
  },

  async saveWebSearch(input) {
    try {
      const settings = await call(window.morrow.settings.saveWebSearch(input))
      set({ settings })
      get().notify('success', '联网搜索设置已保存')
      return true
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '保存联网搜索设置失败')
      return false
    }
  },

  async testWebSearch() {
    try {
      return await call(window.morrow.settings.testWebSearch())
    } catch (err) {
      return {
        ok: false,
        provider: '',
        sourceCount: 0,
        latencyMs: 0,
        message: err instanceof Error ? err.message : '联网搜索测试失败'
      }
    }
  },

  async removeProvider(providerId) {
    try {
      const settings = await call(window.morrow.settings.removeProvider(providerId))
      applyTheme(settings)
      set({
        settings,
        hasAnyApiKey: settings.providers.some(
          (p) => p.enabled && p.kind !== 'demo' && (p.category === 'local' || p.apiKeyStored)
        )
      })
      get().notify('success', '模型提供方已删除')
    } catch (err) {
      const message = err instanceof Error ? err.message : '删除失败'
      get().notify('error', message)
      throw new Error(message)
    }
  },

  async validateWorkspace(path) {
    try {
      const info = await call(window.morrow.workspace.validate(path))
      return info.exists ? info : null
    } catch {
      return null
    }
  },

  async pickWorkspaceInfo() {
    try {
      const info = await call(window.morrow.workspace.pick())
      if (info) {
        const settings = await call(window.morrow.settings.update({ lastWorkspace: info.path }))
        set({ settings })
      }
      return info
    } catch (err) {
      const message = err instanceof Error ? err.message : '选择文件夹失败'
      get().notify('error', message)
      throw new Error(message)
    }
  },

  async openDataDir() {
    try {
      await call(window.morrow.app.openDataDir())
    } catch {
      get().notify('error', '打开数据目录失败')
    }
  },

  async openLogs() {
    try {
      await call(window.morrow.app.openLogs())
    } catch {
      get().notify('error', '打开日志目录失败')
    }
  },

  async changeDataDir() {
    try {
      const result = await call(window.morrow.app.changeDataDir())
      if (result.canceled) return
      get().notify(
        'success',
        result.restarted ? '数据目录已切换，Morrow 正在重启…' : '数据目录已保存，重启后生效'
      )
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '更改数据目录失败')
    }
  },

  async resetDataDir() {
    try {
      const result = await call(window.morrow.app.resetDataDir())
      if (result.canceled) return
      get().notify(
        'success',
        result.restarted ? '已恢复默认数据目录，Morrow 正在重启…' : '已恢复默认数据目录，重启后生效'
      )
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '恢复默认数据目录失败')
    }
  },

  setTheme(theme) {
    const settings = { ...get().settings, theme }
    applyTheme(settings)
    set({ theme, settings })
    void call(window.morrow.settings.update({ theme })).catch(() => undefined)
  },

  toggleSidebar() {
    const sidebarCollapsed = !get().sidebarCollapsed
    set({ sidebarCollapsed })
    void call(window.morrow.settings.update({ sidebarCollapsed })).catch(() => undefined)
  },

  setSidebarWidth(width, persist = false) {
    const next = clampSidebarWidth(width)
    set({ sidebarWidth: next })
    document.documentElement.style.setProperty('--sidebar-w', `${next}px`)
    if (persist) {
      void call(window.morrow.settings.update({ sidebarWidth: next }))
        .then((settings) => set({ settings }))
        .catch(() => undefined)
    }
  },

  setCanvasWidth(width, persist = false) {
    const next = clampCanvasWidth(width)
    set({ canvasWidth: next })
    if (persist) {
      void call(window.morrow.settings.update({ canvasWidth: next }))
        .then((settings) => set({ settings }))
        .catch(() => undefined)
    }
  },

  toggleTerminal() {
    set((state) => ({ terminalOpen: !state.terminalOpen, paletteOpen: false }))
  },

  openTerminal() {
    set({ terminalOpen: true, paletteOpen: false })
  },

  closeTerminal() {
    set({ terminalOpen: false })
  },

  toggleCanvas() {
    const canvas = get().canvas
    if (get().sideChatOpen) {
      set({ sideChatOpen: false, canvas: { open: true, artifactId: canvas.artifactId } })
      return
    }
    if (canvas.open) {
      set({ canvas: { open: false, artifactId: null } })
      return
    }
    const session = get().session
    const latest = session?.artifacts[session.artifacts.length - 1] ?? null
    set({ canvas: { open: true, artifactId: latest?.id ?? null } })
  },

  async startGoal(objective, maxRounds) {
    const session = get().session
    if (!session) return
    const sessionId = session.id
    try {
      if (get().run) throw new Error('当前还有任务在运行，先停止或等它完成后再建立目标。')
      // 不传 maxRounds 时由主进程按目标复杂度自动估算（≤256 轮）；显式传值仅用于高级用法/测试
      const result = await call(
        window.morrow.goal.start({
          sessionId: session.id,
          objective,
          ...(typeof maxRounds === 'number' && maxRounds > 0 ? { maxRounds } : {})
        })
      )
      set((state) => ({
        session: state.session?.id === sessionId ? { ...state.session, goal: result.goal } : state.session
      }))
      get().notify('success', '目标已建立，Morrow 将自动多轮推进。')
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '目标启动失败')
      throw err
    }
  },

  async pauseGoal() {
    const session = get().session
    if (!session) return
    const sessionId = session.id
    try {
      const result = await call(window.morrow.goal.pause(sessionId))
      set((state) => ({
        session: state.session?.id === sessionId ? { ...state.session, goal: result.goal } : state.session
      }))
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '暂停目标失败')
    }
  },

  async resumeGoal() {
    const session = get().session
    if (!session) return
    const sessionId = session.id
    try {
      if (get().run) throw new Error('当前还有任务在运行，先停止或等它完成后再继续目标。')
      const result = await call(window.morrow.goal.resume(sessionId))
      set((state) => ({
        session: state.session?.id === sessionId ? { ...state.session, goal: result.goal } : state.session
      }))
      get().notify('success', '继续推进目标。')
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '继续目标失败')
    }
  },

  async stopGoal() {
    const session = get().session
    if (!session) return
    const sessionId = session.id
    try {
      const result = await call(window.morrow.goal.stop(sessionId))
      set((state) => ({
        session: state.session?.id === sessionId ? { ...state.session, goal: result.goal } : state.session
      }))
      get().notify('info', '目标已结束。')
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '结束目标失败')
    }
  },

  async clearGoal() {
    const session = get().session
    if (!session) return
    const sessionId = session.id
    try {
      const result = await call(window.morrow.goal.clear(sessionId))
      set((state) => ({
        session: state.session?.id === sessionId ? { ...state.session, goal: result.goal } : state.session
      }))
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '清除目标失败')
    }
  },

  async syncModels(providerId) {
    try {
      const result = await call(window.morrow.settings.syncModels(providerId))
      if (result.settings) {
        applyTheme(result.settings)
        set({ settings: result.settings })
      }
      get().notify('success', result.message)
      return result
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '同步模型列表失败')
      return null
    }
  },

  openSettings() {
    set({ settingsOpen: true, paletteOpen: false })
  },
  closeSettings() {
    set({ settingsOpen: false })
  },
  openPalette() {
    set({ paletteOpen: true })
  },
  closePalette() {
    set({ paletteOpen: false })
  },
  openCanvas(artifactId) {
    const session = get().session
    const target = artifactId ?? session?.artifacts[session.artifacts.length - 1]?.id ?? null
    set({ canvas: { open: true, artifactId: target }, sideChatOpen: false })
  },
  closeCanvas() {
    set({ canvas: { open: false, artifactId: null } })
  },
  openSideChat(question) {
    set({
      sideChatOpen: true,
      sideChatSeed: question?.trim() ? { question: question.trim(), nonce: Date.now() } : null,
      settingsOpen: false,
      paletteOpen: false
    })
  },
  closeSideChat() {
    set({ sideChatOpen: false })
  },
  toggleSideChat() {
    if (get().sideChatOpen) set({ sideChatOpen: false })
    else get().openSideChat()
  },
  clearSideChatSeed() {
    set({ sideChatSeed: null })
  },
  setPlanExpanded(value) {
    set({ planExpanded: value })
  },

  openRewind(messageId) {
    if (!get().session) {
      get().notify('warning', '先打开一个对话，再回退。')
      return
    }
    set({ rewindOpen: true, rewindTargetMessageId: messageId ?? null })
  },

  closeRewind() {
    set({ rewindOpen: false, rewindTargetMessageId: null })
  },

  async rewindTo(checkpointId, scope) {
    const session = get().session
    if (!session) return { ok: false, error: '先打开一个对话，再回退。' }
    if (get().run) {
      const message = '对话还在运行：先停止，再回到之前。'
      get().notify('warning', message)
      return { ok: false, error: message }
    }
    try {
      const result = await call(window.morrow.checkpoints.rewind(session.id, checkpointId, scope))
      const latest = await call(window.morrow.session.load(session.id))
      set((state) => ({
        // 回退已在主进程完成；若期间切到别的会话，只关闭旧弹窗，不能覆盖当前会话视图
        ...(state.activeSessionId === session.id
          ? { session: latest, streaming: null, canvas: { open: false, artifactId: null } }
          : {}),
        rewindOpen: false,
        rewindTargetMessageId: null
      }))
      const parts = [
        result.restoredFiles ? `恢复 ${result.restoredFiles} 个文件` : '',
        result.removedFiles ? `删除 ${result.removedFiles} 个新建文件` : '',
        result.removedMessages ? `移除 ${result.removedMessages} 条对话` : ''
      ].filter(Boolean)
      if (result.restoredFiles > 0 || result.removedFiles > 0) {
        window.dispatchEvent(new CustomEvent('morrow:files-changed'))
      }
      const target = result.kind === 'stage' ? '这个阶段完成时' : '这一轮之前'
      get().notify('success', parts.length ? `已回到${target}：${parts.join('，')}。` : `已回到${target}。`)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : '回到这一轮之前失败'
      get().notify('error', message)
      return { ok: false, error: message }
    }
  },

  async pickWorkspace() {
    try {
      const info = await call(window.morrow.workspace.pick())
      if (!info) return
      const settings = await call(window.morrow.settings.update({ lastWorkspace: info.path }))
      set({ settings })
      const session = get().session
      if (session) {
        // 换工作区会新建会话：沿用当前显式模式（聊天/工作），避免用户切换文件夹后被悄悄切回工作模式
        const created = await call(
          window.morrow.session.create({
            workspace: info.path,
            ...(session.mode ? { mode: session.mode } : {}),
            ...(session.temporary ? { temporary: true } : {})
          })
        )
        set({
          session: created,
          activeSessionId: created.id,
          sessions: upsertSessionMeta(get().sessions, deriveMeta(created)),
          run: null,
          pendingPermission: null,
          pendingQuestion: null,
          streaming: null,
          demoStep: null
        })
        syncIslandSessionId(created.id)
      }
      get().notify('success', `已切换到 ${info.name}`)
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '选择文件夹失败')
    }
  },

  async attachFiles() {
    try {
      return await call(window.morrow.files.attach())
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '添加文件失败')
      return []
    }
  },

  async searchFiles(query) {
    const workspace = get().session?.workspace ?? get().settings.lastWorkspace
    if (!workspace || !query.trim()) return []
    try {
      return await call(window.morrow.files.search(workspace, query.trim(), 12))
    } catch {
      return []
    }
  },

  async startDemo() {
    if (get().run) {
      get().notify('warning', '当前还有任务在运行，先停止或等它完成后再看演示。')
      return
    }
    try {
      const workspace = await call(window.morrow.workspace.createDemo())
      const session = await call(
        window.morrow.session.create({
          workspace: workspace.path,
          model: DEMO_MODEL,
          permissionMode: 'auto',
          mode: 'work',
          title: '演示 · 季度销售分析',
          demo: true
        })
      )
      set({
        session,
        activeSessionId: session.id,
        sessions: upsertSessionMeta(get().sessions, deriveMeta(session)),
        canvas: { open: false, artifactId: null },
        planExpanded: true,
        demoStep: null
      })
      syncIslandSessionId(session.id)
      void call(window.morrow.settings.update({ demoSeen: true })).catch(() => undefined)
      await get().sendMessage('帮我把这个季度的销售数据理一遍，做一份可以给老板看的分析报告。')
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '演示启动失败')
    }
  },

  setSearchQuery(query) {
    set({ searchQuery: query })
  },

  focusMessage(messageId) {
    set({ focusMessageId: messageId })
  },

  clearFocusMessage() {
    set({ focusMessageId: null })
  },

  notify(kind, message, action) {
    set({
      toast: toast(kind, message, action ? { actionLabel: action.label, action: action.run } : undefined)
    })
  },

  dismissToast() {
    set({ toast: null })
  },

  async copyText(text) {
    try {
      await navigator.clipboard.writeText(text)
      get().notify('success', '已复制')
    } catch {
      get().notify('error', '复制失败')
    }
  },

  async setModel(modelId, providerId) {
    const session = get().session
    const model = { providerId, modelId }
    if (session) {
      const sessionId = session.id
      try {
        const meta = await call(window.morrow.session.setModel(sessionId, model))
        set((state) => {
          if (state.session?.id !== sessionId) {
            return { sessions: upsertSessionMeta(state.sessions, meta) }
          }
          const nextSession = { ...state.session, model }
          if (meta.demo) nextSession.demo = true
          else delete nextSession.demo
          return { session: nextSession, sessions: upsertSessionMeta(state.sessions, meta) }
        })
      } catch (err) {
        get().notify('error', err instanceof Error ? err.message : '切换模型失败')
      }
    }
    try {
      const settings = await call(window.morrow.settings.update({ defaultModel: model }))
      set({ settings })
    } catch {
      // 忽略
    }
  },

  async setPermissionMode(mode) {
    const session = get().session
    if (session) {
      const sessionId = session.id
      try {
        const meta = await call(window.morrow.session.setPermissionMode(sessionId, mode))
        set((state) => ({
          ...(state.session?.id === sessionId ? { session: { ...state.session, permissionMode: mode } } : {}),
          sessions: upsertSessionMeta(state.sessions, meta)
        }))
      } catch (err) {
        get().notify('error', err instanceof Error ? err.message : '切换权限失败')
      }
    }
    try {
      const settings = await call(window.morrow.settings.update({ permissionMode: mode }))
      set({ settings })
    } catch {
      // 忽略
    }
  },

  async setReasoningEffort(effort) {
    const session = get().session
    if (session) {
      const sessionId = session.id
      try {
        const meta = await call(window.morrow.session.setReasoningEffort(sessionId, effort))
        set((state) => ({
          ...(state.session?.id === sessionId ? { session: { ...state.session, reasoningEffort: effort } } : {}),
          sessions: upsertSessionMeta(state.sessions, meta)
        }))
      } catch (err) {
        get().notify('error', err instanceof Error ? err.message : '切换推理强度失败')
      }
    }
    try {
      const settings = await call(window.morrow.settings.update({ reasoningEffort: effort }))
      set({ settings })
    } catch {
      // 忽略
    }
  },

  async setContextWindow(contextWindow) {
    const session = get().session
    const nextModel = { ...(session?.model ?? get().settings.defaultModel) }
    if (contextWindow && contextWindow > 0) nextModel.contextWindow = contextWindow
    else delete nextModel.contextWindow
    if (session) {
      const sessionId = session.id
      try {
        const meta = await call(window.morrow.session.setModel(sessionId, nextModel))
        set((state) => ({
          ...(state.session?.id === sessionId ? { session: { ...state.session, model: nextModel } } : {}),
          sessions: upsertSessionMeta(state.sessions, meta)
        }))
      } catch (err) {
        get().notify('error', err instanceof Error ? err.message : '切换上下文长度失败')
      }
      return
    }
    try {
      const settings = await call(window.morrow.settings.update({ defaultModel: nextModel }))
      set({ settings })
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '切换上下文长度失败')
    }
  },

  async setSessionMode(mode) {
    const session = get().session
    if (!session) {
      get().notify('warning', '先新建或打开一个对话，再切换模式。')
      return
    }
    const current = session.mode ?? 'work'
    if (current === mode) return
    // 运行中的任务不能跨模式继续：先提示用户停止（可一键停止并切换），不能让它带着工作模式的能力继续跑。
    if (get().run) {
      get().notify('warning', '本次任务正在运行，不能直接切换模式。先停止它，再切换。', {
        label: '停止并切换',
        run: () => {
          void (async () => {
            await get().stopRun()
            for (let attempt = 0; attempt < 20; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, 150))
              if (!get().run) break
            }
            await get().setSessionMode(mode)
          })()
        }
      })
      return
    }
    try {
      const meta = await call(window.morrow.session.setMode(session.id, mode))
      set((state) => ({
        session: state.session
          ? {
              ...state.session,
              ...meta,
              research: meta.research ?? null,
              mode,
              ...(mode === 'chat' || mode === 'research' ? { planMode: false } : {})
            }
          : state.session,
        sessions: upsertSessionMeta(state.sessions, meta)
      }))
      get().notify(
        'info',
        mode === 'chat'
          ? '已切到聊天模式：只讨论与只读分析，不改文件、不跑命令。'
          : mode === 'research'
            ? '已切到深度研究模式：多轮检索、交叉核对，最后生成带引用的报告。'
            : '已切到工作模式：可以读写文件、执行命令（受权限档位约束）。'
      )
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '切换模式失败')
    }
  },

  async setPlanMode(enabled) {
    const session = get().session
    if (!session) {
      get().notify('warning', '先新建或打开一个对话，再使用计划模式。')
      return
    }
    if (enabled && (session.mode ?? 'work') === 'chat') {
      get().notify('warning', '聊天模式不能进入计划模式：先切到工作模式。')
      return
    }
    if (get().run) {
      get().notify('warning', '本次任务正在运行，不能切换计划模式。先停止它再切换。')
      return
    }
    const sessionId = session.id
    try {
      const meta = await call(window.morrow.plan.setMode(sessionId, enabled))
      set((state) => ({
        ...(state.session?.id === sessionId
          ? { session: { ...state.session, planMode: enabled, plan: meta.plan ?? state.session.plan ?? null } }
          : {}),
        sessions: upsertSessionMeta(state.sessions, meta)
      }))
      get().notify(
        'info',
        enabled
          ? '已进入计划模式：Morrow 会先探索并给出计划，批准后才执行。'
          : '已退出计划模式。'
      )
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '切换计划模式失败')
    }
  },

  async approvePlan() {
    const session = get().session
    if (!session) return
    if (get().run) {
      get().notify('warning', '当前还有任务在运行，等它结束或先停止。')
      return
    }
    const sessionId = session.id
    try {
      const result = await call(window.morrow.plan.approve(sessionId))
      set((state) => ({
        ...(state.session?.id === sessionId
          ? { session: { ...state.session, plan: result.plan, planMode: false } }
          : {}),
        ...(result.meta ? { sessions: upsertSessionMeta(state.sessions, result.meta) } : {})
      }))
      get().notify('success', '计划已批准，Morrow 开始执行。')
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '批准计划失败')
    }
  },

  async revisePlan(feedback) {
    const session = get().session
    if (!session) return
    if (get().run) {
      get().notify('warning', '当前还有任务在运行，等它结束或先停止。')
      return
    }
    const sessionId = session.id
    try {
      const result = await call(window.morrow.plan.revise(sessionId, feedback))
      set((state) => ({
        ...(state.session?.id === sessionId
          ? { session: { ...state.session, planMode: true, plan: result.plan ?? state.session.plan ?? null } }
          : {})
      }))
      get().notify('info', '已提交修改意见，Morrow 正在重新规划。')
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '修改计划失败')
    }
  },

  async rejectPlan(feedback) {
    const session = get().session
    if (!session) return
    const sessionId = session.id
    try {
      const result = await call(window.morrow.plan.reject(sessionId, feedback))
      set((state) => ({
        ...(state.session?.id === sessionId
          ? { session: { ...state.session, plan: result.plan, planMode: true } }
          : {})
      }))
      get().notify('info', '计划已拒绝。你可以补充要求，让 Morrow 重新规划。')
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '拒绝计划失败')
    }
  },

  async revealArtifact(path) {
    try {
      await call(window.morrow.artifacts.reveal(path))
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '打开文件夹失败')
    }
  },

  async saveArtifactToWorkspace(sessionId, artifactId) {
    try {
      const result = await call(window.morrow.artifacts.saveToWorkspace(sessionId, artifactId))
      set((state) =>
        state.session?.id === sessionId
          ? {
              session: {
                ...state.session,
                artifacts: state.session.artifacts.map((item) =>
                  item.id === result.artifact.id ? result.artifact : item
                )
              }
            }
          : {}
      )
      get().notify('success', `已保存到文件夹：${result.path}`)
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '保存到文件夹失败')
    }
  },

  async loadArtifactVersions(sessionId, artifactId) {
    return call(window.morrow.artifacts.versions(sessionId, artifactId))
  },

  async readArtifactVersion(sessionId, artifactId, versionId) {
    return call(window.morrow.artifacts.readVersion(sessionId, artifactId, versionId))
  },

  async restoreArtifactVersion(sessionId, artifactId, versionId) {
    const artifact = await call(window.morrow.artifacts.restoreVersion(sessionId, artifactId, versionId))
    set((state) =>
      state.session?.id === sessionId
        ? {
            session: {
              ...state.session,
              artifacts: state.session.artifacts.map((item) => (item.id === artifact.id ? artifact : item))
            }
          }
        : {}
    )
    get().notify('success', '已恢复到所选版本，并记录为一个新版本。')
  },

  async exportArtifact(sessionId, artifactId, format) {
    const saved = await call(window.morrow.artifacts.exportFile(sessionId, artifactId, format))
    if (saved) get().notify('success', `已导出：${saved}`)
    return saved
  },

  async copyArtifactExport(sessionId, artifactId, format) {
    try {
      const text = await call(window.morrow.artifacts.exportText(sessionId, artifactId, format))
      await navigator.clipboard.writeText(text)
      const label = format === 'markdown' ? 'Markdown' : format === 'html' ? 'HTML' : '纯文本'
      get().notify('success', `已复制${label}内容`)
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '复制导出内容失败')
    }
  },

  async compactSession() {
    const session = get().session
    if (!session) return
    if (get().compacting) {
      get().notify('info', '正在压缩上下文，完成后再试。')
      return
    }
    const sessionId = session.id
    set({ compacting: true, compactingSessionId: sessionId })
    try {
      const result = await call(window.morrow.chat.compact(sessionId))
      // 压缩期间用户可能切到别的会话：不要把视图强行拉回旧会话
      if (get().activeSessionId === sessionId) {
        const latest = await call(window.morrow.session.load(sessionId))
        if (get().activeSessionId === sessionId) set({ session: latest })
      }
      if (result.compacted) {
        const saved = result.savedTokens >= 1000 ? `${Math.round(result.savedTokens / 100) / 10}k` : `${result.savedTokens}`
        get().notify('success', `上下文已压缩，节省约 ${saved} tokens。`)
      } else {
        get().notify('info', result.reason === 'below-threshold' ? '对话还很短，暂时不需要压缩。' : '当前没有可安全压缩的段落。')
      }
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '压缩失败')
    } finally {
      set((state) =>
        state.compactingSessionId === sessionId ? { compacting: false, compactingSessionId: null } : {}
      )
    }
  },

  async undoFileChange(snapshotPath, targetPath) {
    const session = get().session
    if (!session) return
    try {
      await call(window.morrow.files.restoreSnapshot({ sessionId: session.id, snapshotPath, targetPath }))
      const latest = await call(window.morrow.session.load(session.id))
      set((state) => (state.activeSessionId === session.id ? { session: latest } : {}))
      get().notify('success', '已恢复到修改前的内容。')
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '恢复文件失败')
    }
  },

  async openExternal(url) {
    if (!/^https?:\/\//i.test(url)) {
      get().notify('warning', '只支持打开网页链接。')
      return
    }
    try {
      await call(window.morrow.app.openExternal(url))
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '打开链接失败')
    }
  },

  async openArtifactExternal(path) {
    try {
      await call(window.morrow.artifacts.openExternal(path))
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '打开文件失败')
    }
  }
}))

/* 默认值对齐：避免 components 在 bootstrap 前空指针 */
export const fallbackModel = DEFAULT_MODEL

/** 便捷 hooks（组件可按需使用） */
export const useSession = (): Session | null => useAppStore((s) => s.session)
export const useRun = (): RunState | null => useAppStore((s) => s.run)
const EMPTY_ARTIFACTS: Artifact[] = []
export const useArtifacts = (): Artifact[] => useAppStore((s) => s.session?.artifacts ?? EMPTY_ARTIFACTS)
