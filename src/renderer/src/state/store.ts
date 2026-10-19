import { create } from 'zustand'
import type {
  AppInfo,
  Artifact,
  AskUserAnswer,
  AskUserRequest,
  Attachment,
  ChatMessage,
  FileSearchResult,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  Project,
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
  streaming: StreamingState | null
  pendingPermission: PermissionRequest | null
  pendingQuestion: AskUserRequest | null
  compacting: boolean
  demoStep: DemoStepState | null

  /* UI */
  windowState: WindowState
  sidebarCollapsed: boolean
  canvas: { open: boolean; artifactId: string | null }
  paletteOpen: boolean
  settingsOpen: boolean
  onboardingOpen: boolean
  planExpanded: boolean
  theme: ThemeMode
  sidebarWidth: number
  canvasWidth: number
  autoCompact: boolean
  compactThreshold: number
  toast: Toast | null
  searchQuery: string

  /* actions */
  init: () => Promise<void>
  applyEvent: (event: RuntimeEvent) => void
  newSession: (opts?: { workspace?: string | null }) => Promise<Session | null>
  selectSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  sendMessage: (text: string, attachments?: Attachment[]) => Promise<void>
  stopRun: () => Promise<void>
  respondPermission: (decision: PermissionDecision) => Promise<void>
  respondQuestion: (answer: AskUserAnswer) => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  saveProvider: (input: Parameters<typeof window.morrow.settings.saveProvider>[0]) => Promise<void>
  completeOnboarding: (input: Parameters<typeof window.morrow.settings.completeOnboarding>[0]) => Promise<void>
  testProvider: (input: Parameters<typeof window.morrow.settings.testProvider>[0]) => Promise<import('@shared/types').ProviderTestResult>
  removeProvider: (providerId: string) => Promise<void>
  pickWorkspaceInfo: () => Promise<import('@shared/types').WorkspaceInfo | null>
  openDataDir: () => Promise<void>
  openLogs: () => Promise<void>
  setTheme: (theme: ThemeMode) => void
  toggleSidebar: () => void
  setSidebarWidth: (width: number, persist?: boolean) => void
  setCanvasWidth: (width: number, persist?: boolean) => void
  toggleCanvas: () => void
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
  setPlanExpanded: (value: boolean) => void
  pickWorkspace: () => Promise<void>
  attachFiles: () => Promise<Attachment[]>
  searchFiles: (query: string) => Promise<FileSearchResult[]>
  startDemo: () => Promise<void>
  setSearchQuery: (query: string) => void
  notify: (kind: Toast['kind'], message: string, action?: { label: string; run: () => void }) => void
  dismissToast: () => void
  copyText: (text: string) => Promise<void>
  setModel: (modelId: string, providerId: string) => Promise<void>
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  /** 切换显式「聊天 / 工作」模式（主进程持久化；运行中会先提示停止） */
  setSessionMode: (mode: SessionMode) => Promise<void>
  revealArtifact: (path: string) => Promise<void>
  saveArtifactAs: (path: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  openArtifactExternal: (path: string) => Promise<void>
  compactSession: () => Promise<void>
  undoFileChange: (snapshotPath: string, targetPath: string) => Promise<void>
}

/* ── 工具函数 ─────────────────────────────────────────────────── */

const now = (): number => Date.now()
const uid = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10)}`

function applyTheme(settings: Settings): void {
  const root = document.documentElement
  root.dataset.theme = settings.theme
  root.dataset.reduceMotion = settings.reduceMotion ? 'true' : 'false'
  root.style.setProperty('--fs-body', `${settings.fontSize}px`)
  root.style.setProperty('--fs-ui', `${Math.max(11, settings.fontSize - 1)}px`)
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
  streaming: null,
  pendingPermission: null,
  pendingQuestion: null,
  compacting: false,
  demoStep: null,

  windowState: { maximized: false, focused: true, fullscreen: false },
  sidebarCollapsed: false,
  canvas: { open: false, artifactId: null },
  paletteOpen: false,
  settingsOpen: false,
  onboardingOpen: false,
  planExpanded: true,
  theme: 'dark',
  sidebarWidth: 240,
  canvasWidth: 420,
  autoCompact: true,
  compactThreshold: 0.8,
  toast: null,
  searchQuery: '',

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
    if (event.type === 'run_started') {
      const session = state.session && state.session.id === event.sessionId ? state.session : state.session
      set({
        run: { runId: event.runId, sessionId: event.sessionId, startedAt: event.at, assistantMessageId: event.assistantMessageId },
        pendingPermission: null,
        pendingQuestion: null,
        planExpanded: true,
        ...(session && session.id === event.sessionId
          ? {
              session: {
                ...session,
                messages: session.messages.some((m) => m.id === event.userMessage.id)
                  ? session.messages
                  : [...session.messages, event.userMessage],
                updatedAt: event.at
              }
            }
          : {})
      })
      return
    }

    if (event.type === 'run_finished') {
      const session = state.session && state.session.id === event.sessionId ? state.session : null
      set({
        run: null,
        streaming: null,
        pendingPermission: null,
        pendingQuestion: null,
        compacting: false,
        demoStep: null,
        ...(session
          ? {
              session: {
                ...session,
                usage: mergeUsage(session.usage, event.usage),
                updatedAt: now()
              }
            }
          : {})
      })
      if (event.reason === 'error') {
        set({ toast: toast('error', '这次任务没有完成。可以重试，或把需求说得更具体一点。') })
      }
      if (event.reason === 'complete') {
        set({ demoStep: null })
      }
      return
    }

    const current = state.session
    if (!current || current.id !== event.sessionId) {
      // 非当前会话的事件只更新元信息（后台运行场景暂不支持，忽略）
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
              subagent: event.note ? { label: event.note, stepCount: block.subagent?.stepCount } : block.subagent
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
            return {
              ...block,
              status: event.denied ? 'denied' : event.interrupted ? 'interrupted' : event.result.ok ? 'success' : 'error',
              result: event.result,
              finishedAt: event.at
            }
          })
        }))
        set({ session })
        return
      }
      case 'permission_requested': {
        const session = updateSessionMessage(current, current.messages.find((m) => m.content.some((b) => b.type === 'tool_use' && b.id === event.request.toolUseId))?.id ?? '', (message) => ({
          ...message,
          content: message.content.map((block) =>
            block.type === 'tool_use' && block.id === event.request.toolUseId ? { ...block, status: 'waiting' } : block
          )
        }))
        set({ session, pendingPermission: event.request })
        return
      }
      case 'permission_resolved': {
        set({
          pendingPermission: state.pendingPermission?.id === event.requestId ? null : state.pendingPermission,
          ...(state.pendingPermission?.id === event.requestId && state.pendingPermission
            ? {
                session: updateSessionMessage(current, current.messages.find((m) => m.content.some((b) => b.type === 'tool_use' && b.id === state.pendingPermission!.toolUseId))?.id ?? '', (message) => ({
                  ...message,
                  content: message.content.map((block) =>
                    block.type === 'tool_use' && block.id === state.pendingPermission!.toolUseId
                      ? { ...block, status: event.decision === 'deny' ? 'denied' : 'running' }
                      : block
                  )
                }))
              }
            : {})
        })
        return
      }
      case 'question_asked': {
        set({ pendingQuestion: event.request })
        return
      }
      case 'question_answered': {
        set({ pendingQuestion: state.pendingQuestion?.id === event.requestId ? null : state.pendingQuestion })
        return
      }
      case 'todos_updated': {
        set({ session: { ...current, todos: event.todos } })
        return
      }
      case 'artifacts_updated': {
        const shouldOpen = event.artifacts.length > current.artifacts.length
        const latest = event.artifacts[event.artifacts.length - 1]
        set({
          session: { ...current, artifacts: event.artifacts },
          ...(shouldOpen && latest ? { canvas: { open: true, artifactId: latest.id } } : {})
        })
        return
      }
      case 'usage_updated': {
        set({ session: { ...current, usage: mergeUsage(current.usage, event.usage) } })
        return
      }
      case 'compaction': {
        set({ compacting: event.phase === 'started' })
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
      case 'session_updated': {
        set({ sessions: upsertSessionMeta(state.sessions, event.meta) })
        return
      }
      case 'goal_updated': {
        set((state) => ({ session: state.session ? { ...state.session, goal: event.goal } : state.session }))
        return
      }
      default:
        return
    }
  },

  async newSession(opts) {
    try {
      const workspace = opts?.workspace !== undefined ? opts.workspace : get().settings.lastWorkspace
      const session = await call(
        window.morrow.session.create({
          workspace,
          model: get().settings.defaultModel,
          permissionMode: get().settings.permissionMode
        })
      )
      set({
        session,
        activeSessionId: session.id,
        sessions: upsertSessionMeta(get().sessions, deriveMeta(session)),
        canvas: { open: false, artifactId: null },
        planExpanded: true,
        toast: null
      })
      return session
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '新建对话失败')
      return null
    }
  },

  async selectSession(id) {
    if (get().activeSessionId === id && get().session) return
    set({ loadingSession: true, canvas: { open: false, artifactId: null }, planExpanded: true })
    try {
      const session = await call(window.morrow.session.load(id))
      set({ session, activeSessionId: id, loadingSession: false, pendingPermission: null, pendingQuestion: null })
    } catch (err) {
      set({ loadingSession: false })
      get().notify('error', err instanceof Error ? err.message : '会话加载失败')
    }
  },

  async deleteSession(id) {
    try {
      await call(window.morrow.session.remove(id))
      const sessions = get().sessions.filter((s) => s.id !== id)
      set({ sessions })
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

  async sendMessage(text, attachments) {
    const trimmed = text.trim()
    if (!trimmed) return
    let session = get().session
    if (!session || get().activeSessionId === null) {
      session = await get().newSession()
      if (!session) return
    }
    try {
      // run_started 事件会插入用户消息；这里只负责发起请求
      const result: SendMessageResult = await call(
        window.morrow.chat.send({
          sessionId: session.id,
          text: trimmed,
          attachments: attachments?.length ? attachments : undefined
        })
      )
      if (!get().run) {
        set({ run: { runId: result.runId, sessionId: session.id, startedAt: now() } })
      }
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '消息发送失败')
    }
  },

  async stopRun() {
    const run = get().run
    if (!run) return
    try {
      await call(window.morrow.chat.cancel(run.runId))
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '停止失败')
    }
  },

  async respondPermission(decision) {
    const request = get().pendingPermission
    if (!request) return
    try {
      await call(window.morrow.chat.respondPermission(request.id, decision))
      set({ pendingPermission: null })
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '审批失败')
    }
  },

  async respondQuestion(answer) {
    const request = get().pendingQuestion
    if (!request) return
    try {
      await call(window.morrow.chat.respondQuestion(request.id, answer))
      set({ pendingQuestion: null })
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '提交失败')
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
      set({ settings, hasAnyApiKey: settings.providers.some((p) => p.apiKeyStored && p.kind !== 'demo') })
      get().notify('success', '模型连接已保存')
    } catch (err) {
      const message = err instanceof Error ? err.message : '模型连接保存失败'
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

  async removeProvider(providerId) {
    try {
      const settings = await call(window.morrow.settings.removeProvider(providerId))
      applyTheme(settings)
      set({ settings, hasAnyApiKey: settings.providers.some((p) => p.apiKeyStored && p.kind !== 'demo') })
      get().notify('success', '模型提供方已删除')
    } catch (err) {
      const message = err instanceof Error ? err.message : '删除失败'
      get().notify('error', message)
      throw new Error(message)
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

  toggleCanvas() {
    const canvas = get().canvas
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
    try {
      // 不传 maxRounds 时由主进程按目标复杂度自动估算（≤200 轮）；显式传值仅用于高级用法/测试
      const result = await call(
        window.morrow.goal.start({
          sessionId: session.id,
          objective,
          ...(typeof maxRounds === 'number' && maxRounds > 0 ? { maxRounds } : {})
        })
      )
      set((state) => ({ session: state.session ? { ...state.session, goal: result.goal } : state.session }))
      get().notify('success', '目标已建立，Morrow 将自动多轮推进。')
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '目标启动失败')
      throw err
    }
  },

  async pauseGoal() {
    const session = get().session
    if (!session) return
    try {
      const result = await call(window.morrow.goal.pause(session.id))
      set((state) => ({ session: state.session ? { ...state.session, goal: result.goal } : state.session }))
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '暂停目标失败')
    }
  },

  async resumeGoal() {
    const session = get().session
    if (!session) return
    try {
      const result = await call(window.morrow.goal.resume(session.id))
      set((state) => ({ session: state.session ? { ...state.session, goal: result.goal } : state.session }))
      get().notify('success', '继续推进目标。')
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '继续目标失败')
    }
  },

  async stopGoal() {
    const session = get().session
    if (!session) return
    try {
      const result = await call(window.morrow.goal.stop(session.id))
      set((state) => ({ session: state.session ? { ...state.session, goal: result.goal } : state.session }))
      get().notify('info', '目标已结束。')
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '结束目标失败')
    }
  },

  async clearGoal() {
    const session = get().session
    if (!session) return
    try {
      const result = await call(window.morrow.goal.clear(session.id))
      set((state) => ({ session: state.session ? { ...state.session, goal: result.goal } : state.session }))
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
    set({ canvas: { open: true, artifactId: target } })
  },
  closeCanvas() {
    set({ canvas: { open: false, artifactId: null } })
  },
  setPlanExpanded(value) {
    set({ planExpanded: value })
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
          window.morrow.session.create({ workspace: info.path, ...(session.mode ? { mode: session.mode } : {}) })
        )
        set({
          session: created,
          activeSessionId: created.id,
          sessions: upsertSessionMeta(get().sessions, deriveMeta(created))
        })
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
    try {
      const workspace = await call(window.morrow.workspace.createDemo())
      const session = await call(
        window.morrow.session.create({
          workspace: workspace.path,
          model: DEMO_MODEL,
          permissionMode: 'auto',
          mode: 'work',
          title: '演示 · 季度销售分析'
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
      void call(window.morrow.settings.update({ demoSeen: true })).catch(() => undefined)
      await get().sendMessage('帮我把这个季度的销售数据理一遍，做一份可以给老板看的分析报告。')
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '演示启动失败')
    }
  },

  setSearchQuery(query) {
    set({ searchQuery: query })
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
      try {
        const meta = await call(window.morrow.session.setModel(session.id, model))
        set({ session: { ...session, model }, sessions: upsertSessionMeta(get().sessions, meta) })
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
      try {
        const meta = await call(window.morrow.session.setPermissionMode(session.id, mode))
        set({ session: { ...session, permissionMode: mode }, sessions: upsertSessionMeta(get().sessions, meta) })
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
        session: state.session ? { ...state.session, mode } : state.session,
        sessions: upsertSessionMeta(state.sessions, meta)
      }))
      get().notify(
        'info',
        mode === 'chat'
          ? '已切到聊天模式：只讨论与只读分析，不改文件、不跑命令。'
          : '已切到工作模式：可以读写文件、执行命令（受权限档位约束）。'
      )
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '切换模式失败')
    }
  },

  async revealArtifact(path) {
    try {
      await call(window.morrow.artifacts.reveal(path))
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '打开文件夹失败')
    }
  },

  async saveArtifactAs(path) {
    try {
      const saved = await call(window.morrow.artifacts.saveAs(path))
      if (saved) get().notify('success', '已保存副本')
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '保存失败')
    }
  },

  async compactSession() {
    const session = get().session
    if (!session) return
    set({ compacting: true })
    try {
      const result = await call(window.morrow.chat.compact(session.id))
      const latest = await call(window.morrow.session.load(session.id))
      set({ session: latest })
      if (result.compacted) {
        const saved = result.savedTokens >= 1000 ? `${Math.round(result.savedTokens / 100) / 10}k` : `${result.savedTokens}`
        get().notify('success', `上下文已压缩，节省约 ${saved} tokens。`)
      } else {
        get().notify('info', result.reason === 'below-threshold' ? '对话还很短，暂时不需要压缩。' : '当前没有可安全压缩的段落。')
      }
    } catch (err) {
      get().notify('error', err instanceof Error ? err.message : '压缩失败')
    } finally {
      set({ compacting: false })
    }
  },

  async undoFileChange(snapshotPath, targetPath) {
    const session = get().session
    if (!session) return
    try {
      await call(window.morrow.files.restoreSnapshot({ sessionId: session.id, snapshotPath, targetPath }))
      const latest = await call(window.morrow.session.load(session.id))
      set({ session: latest })
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
