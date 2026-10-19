import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { IPC, WINDOW_STATE_CHANNEL, type CompleteOnboardingInput, type GoalActionResult, type GoalStartInput, type ProviderTestInput, type SaveProviderInput, type UpdateSettingsInput } from '../shared/ipc'
import { DEMO_MODEL, findModel } from '../shared/models'
import type {
  AskUserAnswer,
  Attachment,
  CreateSessionInput,
  FileSearchResult,
  ModelRef,
  PermissionDecision,
  PermissionMode,
  ProviderConfig,
  Result,
  Session,
  SessionMeta,
  SessionMode,
  WindowState,
  WorkspaceInfo
} from '../shared/types'
import { getMainWindow } from './index'
import { createBootstrap } from './services/bootstrap'
import { getSettingsStore } from './services/settings-store'
import { testProviderConnection } from '@core/index'
import { getAgentService } from './services/agent-service'
import { getSessionStore } from './services/session-store'
import { syncProviderModels } from './services/model-sync'
import { restoreSnapshotSafely } from './services/snapshot-restore'
import {
  createDemoWorkspace,
  describeWorkspace,
  isTextFile,
  pickWorkspace,
  readTextSafe,
  searchWorkspaceFiles
} from './services/workspace'
import { log } from './services/logger'

const ok = <T>(data: T): Result<T> => ({ ok: true, data })
const fail = (code: string, message: string, hint?: string): Result<never> => ({
  ok: false,
  error: { code, message, hint }
})

function windowOf(): BrowserWindow | null {
  return getMainWindow()
}

export function emitWindowState(state: WindowState): void {
  windowOf()?.webContents.send(WINDOW_STATE_CHANNEL, state)
}

function pushSessionMeta(meta: SessionMeta): void {
  const win = windowOf()
  if (!win || win.isDestroyed()) return
  win.webContents.send('morrow:event', {
    seq: 0,
    runId: 'meta',
    sessionId: meta.id,
    at: Date.now(),
    type: 'session_updated',
    meta
  })
}

export function registerIpcHandlers(): void {
  /* ── 启动 ─────────────────────────────────────────────── */
  ipcMain.handle(IPC.bootstrap, async (): Promise<Result<unknown>> => {
    try {
      return ok(await createBootstrap())
    } catch (err) {
      log.error('bootstrap failed', String(err))
      return fail('BOOTSTRAP_FAILED', err instanceof Error ? err.message : '应用初始化失败，请重启 Morrow。')
    }
  })

  ipcMain.handle(IPC.appInfo, (): Result<unknown> => {
    return ok({
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      dataDir: app.getPath('userData')
    })
  })

  ipcMain.handle(IPC.openExternal, async (_e, payload: { url: string }): Promise<Result<void>> => {
    if (!/^https?:\/\//i.test(payload?.url ?? '')) return fail('INVALID_URL', '只能打开 http(s) 链接。')
    // 功能测试/演示自动化下不拉起外部 Edge，避免测试机出现“Edge 正在以提升权限运行”弹窗。
    if (process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')) return ok(undefined)
    await shell.openExternal(payload.url)
    return ok(undefined)
  })

  ipcMain.handle(IPC.openDataDir, async (): Promise<Result<void>> => {
    await shell.openPath(app.getPath('userData'))
    return ok(undefined)
  })

  ipcMain.handle(IPC.openLogs, async (): Promise<Result<void>> => {
    const dir = join(app.getPath('userData'), 'logs')
    await shell.openPath(existsSync(dir) ? dir : app.getPath('userData'))
    return ok(undefined)
  })

  /* ── 窗口 ─────────────────────────────────────────────── */
  ipcMain.handle(IPC.windowMinimize, (): Result<void> => {
    windowOf()?.minimize()
    return ok(undefined)
  })

  ipcMain.handle(IPC.windowToggleMaximize, (): Result<boolean> => {
    const win = windowOf()
    if (!win) return ok(false)
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return ok(win.isMaximized())
  })

  ipcMain.handle(IPC.windowClose, (): Result<void> => {
    windowOf()?.close()
    return ok(undefined)
  })

  ipcMain.handle(IPC.windowState, (): Result<WindowState> => {
    const win = windowOf()
    return ok({
      maximized: win?.isMaximized() ?? false,
      focused: win?.isFocused() ?? true,
      fullscreen: win?.isFullScreen() ?? false
    })
  })

  /* ── 设置 ─────────────────────────────────────────────── */
  ipcMain.handle(IPC.settingsGet, (): Result<unknown> => ok(getSettingsStore().get()))

  ipcMain.handle(IPC.settingsUpdate, (_e, patch: UpdateSettingsInput): Result<unknown> => {
    try {
      const settings = getSettingsStore().update(patch)
      return ok(settings)
    } catch (err) {
      return fail('SETTINGS_UPDATE_FAILED', err instanceof Error ? err.message : '保存设置失败')
    }
  })

  ipcMain.handle(IPC.settingsSaveProvider, (_e, input: SaveProviderInput): Result<unknown> => {
    try {
      const settings = getSettingsStore().saveProvider(input.config, input.apiKey)
      return ok(settings)
    } catch (err) {
      return fail('PROVIDER_SAVE_FAILED', err instanceof Error ? err.message : '保存模型连接失败')
    }
  })

  ipcMain.handle(IPC.settingsRemoveProvider, (_e, payload: { providerId: string }): Result<unknown> => {
    try {
      return ok(getSettingsStore().removeProvider(payload.providerId))
    } catch (err) {
      return fail('PROVIDER_REMOVE_FAILED', err instanceof Error ? err.message : '删除提供方失败')
    }
  })

  ipcMain.handle(IPC.settingsTestProvider, async (_e, input: ProviderTestInput): Promise<Result<unknown>> => {
    const store = getSettingsStore()
    const settings = store.get()
    const existing = settings.providers.find((p) => p.id === input.providerId)
    const config: ProviderConfig | null = existing
      ? { ...existing, ...(input.config ?? {}) }
      : input.config
        ? { id: input.providerId, name: input.providerId, baseUrl: '', models: [], apiKeyStored: false, enabled: true, kind: 'openai-compat', ...input.config }
        : null
    if (!config) return fail('PROVIDER_NOT_FOUND', '找不到这个模型提供方。')
    const apiKey = input.apiKey ?? store.getApiKey(config.id)
    try {
      return ok(await testProviderConnection(config, apiKey, input.modelId))
    } catch (err) {
      return fail('PROVIDER_TEST_FAILED', err instanceof Error ? err.message : '连接测试失败')
    }
  })

  ipcMain.handle(IPC.settingsSyncModels, async (_e, payload: { providerId: string }): Promise<Result<unknown>> => {
    try {
      const store = getSettingsStore()
      const settings = store.get()
      const provider = settings.providers.find((p) => p.id === payload.providerId)
      if (!provider) return fail('PROVIDER_NOT_FOUND', '找不到这个模型提供方。')
      const key = store.getApiKey(provider.id)
      const outcome = await syncProviderModels(provider, key)
      const nextSettings = store.saveProvider({ ...provider, models: outcome.models })
      log.info('models synced', { provider: provider.id, total: outcome.total, added: outcome.added, updated: outcome.updated })
      return ok({
        providerId: provider.id,
        providerName: provider.name,
        added: outcome.added,
        updated: outcome.updated,
        total: outcome.total,
        message: outcome.message,
        models: outcome.models,
        settings: nextSettings
      })
    } catch (err) {
      return fail('MODEL_SYNC_FAILED', err instanceof Error ? err.message : '同步模型列表失败')
    }
  })

  ipcMain.handle(IPC.settingsCompleteOnboarding, async (_e, input: CompleteOnboardingInput): Promise<Result<unknown>> => {
    try {
      const store = getSettingsStore()
      if (input.providerId && input.apiKey) {
        const settings = store.get()
        const provider = settings.providers.find((p) => p.id === input.providerId)
        if (provider) store.saveProvider({ ...provider, enabled: true }, input.apiKey)
      }
      const patch: Record<string, unknown> = { onboardingDone: true }
      if (input.model) patch.defaultModel = input.model
      if (input.demo) patch.defaultModel = DEMO_MODEL
      if (input.workspace) {
        const info = describeWorkspace(input.workspace)
        if (info.exists) {
          patch.lastWorkspace = info.path
          const existing = store.get().recentWorkspaces.filter((p) => p !== info.path)
          patch.recentWorkspaces = [info.path, ...existing].slice(0, 6)
        }
      }
      store.update(patch as UpdateSettingsInput)
      // 首次引导完成后建一个可用的空会话，避免用户面对空白界面
      const sessionStore = getSessionStore()
      if (!input.demo && sessionStore.list().length === 0) {
        const settings = store.get()
        sessionStore.create({
          workspace: settings.lastWorkspace,
          model: settings.defaultModel,
          permissionMode: settings.permissionMode,
          defaultModel: settings.defaultModel,
          defaultPermission: settings.permissionMode,
          title: '新对话'
        })
      }
      return ok(await createBootstrap())
    } catch (err) {
      return fail('ONBOARDING_FAILED', err instanceof Error ? err.message : '完成引导失败')
    }
  })

  /* ── 会话 ─────────────────────────────────────────────── */
  ipcMain.handle(IPC.sessionList, (): Result<SessionMeta[]> => ok(getSessionStore().list()))

  ipcMain.handle(IPC.sessionCreate, (_e, input: CreateSessionInput): Result<Session> => {
    try {
      const settings = getSettingsStore().get()
      const model = input.model ?? settings.defaultModel
      const modelInfo = findModel(settings.providers, model)
      if (!modelInfo) return fail('MODEL_NOT_FOUND', '这个模型不可用，请到设置里重新选择。')
      const session = getSessionStore().create({
        ...input,
        defaultModel: settings.defaultModel,
        defaultPermission: settings.permissionMode
      })
      // 显式模式随会话创建持久化；缺省保持 undefined（= work，兼容旧会话）
      if (input.mode === 'chat' || input.mode === 'work') session.mode = input.mode
      if (!input.workspace && settings.lastWorkspace) session.workspace = settings.lastWorkspace
      getSessionStore().save(session)
      return ok(session)
    } catch (err) {
      return fail('SESSION_CREATE_FAILED', err instanceof Error ? err.message : '新建对话失败')
    }
  })

  ipcMain.handle(IPC.sessionLoad, (_e, payload: { sessionId: string }): Result<Session> => {
    const session = getSessionStore().get(payload.sessionId)
    if (!session) return fail('SESSION_NOT_FOUND', '这个对话不存在了。')
    // 老会话可能引用已下线的模型（如 deepseek-chat）：迁移到该提供方当前第一个模型
    const settings = getSettingsStore().get()
    const provider = settings.providers.find((p) => p.id === session.model.providerId)
    if (provider && provider.models.length > 0 && !provider.models.some((m) => m.id === session.model.modelId)) {
      session.model = { providerId: provider.id, modelId: provider.models[0].id }
      getSessionStore().save(session)
    }
    return ok(session)
  })

  ipcMain.handle(IPC.sessionRename, (_e, payload: { sessionId: string; title: string }): Result<SessionMeta> => {
    const meta = getSessionStore().rename(payload.sessionId, payload.title)
    if (!meta) return fail('SESSION_NOT_FOUND', '这个对话不存在了。')
    pushSessionMeta(meta)
    return ok(meta)
  })

  ipcMain.handle(IPC.sessionDelete, (_e, payload: { sessionId: string }): Result<void> => {
    getSessionStore().remove(payload.sessionId)
    return ok(undefined)
  })

  ipcMain.handle(
    IPC.sessionSetModel,
    (_e, payload: { sessionId: string; model: ModelRef }): Result<SessionMeta> => {
      const meta = getSessionStore().setModel(payload.sessionId, payload.model)
      if (!meta) return fail('SESSION_NOT_FOUND', '这个对话不存在了。')
      pushSessionMeta(meta)
      return ok(meta)
    }
  )

  ipcMain.handle(
    IPC.sessionSetPermissionMode,
    (_e, payload: { sessionId: string; mode: PermissionMode }): Result<SessionMeta> => {
      const meta = getSessionStore().setPermissionMode(payload.sessionId, payload.mode)
      if (!meta) return fail('SESSION_NOT_FOUND', '这个对话不存在了。')
      pushSessionMeta(meta)
      return ok(meta)
    }
  )

  ipcMain.handle(
    IPC.sessionSetMode,
    (e, payload: { sessionId: string; mode: SessionMode }): Result<SessionMeta> => {
      try {
        const meta = getAgentService(getSettingsStore(), getSessionStore()).setSessionMode(
          payload.sessionId,
          payload.mode,
          BrowserWindow.fromWebContents(e.sender)
        )
        pushSessionMeta(meta)
        return ok(meta)
      } catch (err) {
        return fail('SESSION_MODE_SWITCH_FAILED', err instanceof Error ? err.message : '切换会话模式失败')
      }
    }
  )

  /* ── 目标（Goal 模式） ─────────────────────────────────── */
  const goalService = (): ReturnType<typeof getAgentService> => getAgentService(getSettingsStore(), getSessionStore())

  ipcMain.handle(IPC.goalStart, async (e, input: GoalStartInput): Promise<Result<GoalActionResult>> => {
    try {
      const window = BrowserWindow.fromWebContents(e.sender)
      const result = await goalService().startGoal(input.sessionId, input.objective, input.maxRounds ?? 0, window, {
        maxToolCalls: input.maxToolCalls,
        maxActiveMs: input.maxActiveMs,
        maxNoProgressRounds: input.maxNoProgressRounds
      })
      return ok(result)
    } catch (err) {
      return fail('GOAL_START_FAILED', err instanceof Error ? err.message : '目标启动失败')
    }
  })

  ipcMain.handle(IPC.goalPause, (e, payload: { sessionId: string }): Result<GoalActionResult> => {
    try {
      return ok(goalService().pauseGoal(payload.sessionId, BrowserWindow.fromWebContents(e.sender)))
    } catch (err) {
      return fail('GOAL_PAUSE_FAILED', err instanceof Error ? err.message : '暂停目标失败')
    }
  })

  ipcMain.handle(IPC.goalResume, (e, payload: { sessionId: string }): Result<GoalActionResult> => {
    try {
      return ok(goalService().resumeGoal(payload.sessionId, BrowserWindow.fromWebContents(e.sender)))
    } catch (err) {
      return fail('GOAL_RESUME_FAILED', err instanceof Error ? err.message : '继续目标失败')
    }
  })

  ipcMain.handle(IPC.goalStop, (e, payload: { sessionId: string }): Result<GoalActionResult> => {
    try {
      return ok(goalService().stopGoal(payload.sessionId, BrowserWindow.fromWebContents(e.sender)))
    } catch (err) {
      return fail('GOAL_STOP_FAILED', err instanceof Error ? err.message : '结束目标失败')
    }
  })

  ipcMain.handle(IPC.goalClear, (e, payload: { sessionId: string }): Result<GoalActionResult> => {
    try {
      return ok(goalService().clearGoal(payload.sessionId, BrowserWindow.fromWebContents(e.sender)))
    } catch (err) {
      return fail('GOAL_CLEAR_FAILED', err instanceof Error ? err.message : '清除目标失败')
    }
  })

  /* ── 工作区 ───────────────────────────────────────────── */
  ipcMain.handle(IPC.workspacePick, async (): Promise<Result<WorkspaceInfo | null>> => {
    try {
      const info = await pickWorkspace()
      if (info) {
        const store = getSettingsStore()
        const settings = store.get()
        store.update({
          lastWorkspace: info.path,
          recentWorkspaces: [info.path, ...settings.recentWorkspaces.filter((p) => p !== info.path)].slice(0, 6)
        })
      }
      return ok(info)
    } catch (err) {
      return fail('WORKSPACE_PICK_FAILED', err instanceof Error ? err.message : '选择文件夹失败')
    }
  })

  ipcMain.handle(IPC.workspaceValidate, (_e, payload: { path: string }): Result<WorkspaceInfo> => {
    try {
      return ok(describeWorkspace(payload.path))
    } catch (err) {
      return fail('WORKSPACE_INVALID', err instanceof Error ? err.message : '文件夹不可用')
    }
  })

  ipcMain.handle(IPC.workspaceRecent, (): Result<WorkspaceInfo[]> => {
    const settings = getSettingsStore().get()
    const list = [settings.lastWorkspace, ...settings.recentWorkspaces]
      .filter((p): p is string => Boolean(p))
      .filter((p, i, arr) => arr.indexOf(p) === i)
      .slice(0, 6)
      .map((p) => describeWorkspace(p))
      .filter((info) => info.exists)
    return ok(list)
  })

  ipcMain.handle(IPC.workspaceCreateDemo, (): Result<WorkspaceInfo> => {
    try {
      return ok(createDemoWorkspace())
    } catch (err) {
      return fail('DEMO_FAILED', err instanceof Error ? err.message : '演示工作区准备失败')
    }
  })

  ipcMain.handle(IPC.demoInfo, (): Result<unknown> => {
    const settings = getSettingsStore().get()
    return ok({
      available: true,
      title: '季度销售分析 · 一场安静的工作',
      description: '离线演示：Morrow 会读取数据、发现异常、生成一份可直接分享的分析报告。',
      workspace: settings.recentWorkspaces.find((p) => p.includes('demo-workspace')) ?? null,
      steps: 10
    })
  })

  /* ── 文件 ─────────────────────────────────────────────── */
  ipcMain.handle(IPC.fileSearch, (_e, payload: { root: string; query: string; limit?: number }): Result<FileSearchResult[]> => {
    try {
      return ok(searchWorkspaceFiles(payload.root, payload.query, payload.limit ?? 12))
    } catch (err) {
      return fail('FILE_SEARCH_FAILED', err instanceof Error ? err.message : '搜索文件失败')
    }
  })

  ipcMain.handle(IPC.fileAttach, async (): Promise<Result<Attachment[]>> => {
    try {
      const result = await dialog.showOpenDialog({
        title: '添加文件给 Morrow',
        buttonLabel: '添加',
        properties: ['openFile', 'multiSelections']
      })
      if (result.canceled) return ok([])
      const attachments: Attachment[] = []
      for (const file of result.filePaths.slice(0, 8)) {
        const info = describeFile(file)
        if (info) attachments.push(info)
      }
      return ok(attachments)
    } catch (err) {
      return fail('FILE_ATTACH_FAILED', err instanceof Error ? err.message : '添加文件失败')
    }
  })

  /* ── 产物 ─────────────────────────────────────────────── */
  ipcMain.handle(IPC.artifactRead, async (_e, payload: { path: string }): Promise<Result<{ content: string; size: number; kind: string }>> => {
    try {
      if (!existsSync(payload.path)) return fail('FILE_NOT_FOUND', '产物文件不存在了。')
      const { content, size } = await readTextSafe(payload.path, 2 * 1024 * 1024)
      const kind = payload.path.split('.').pop()?.toLowerCase() ?? 'txt'
      return ok({ content, size, kind })
    } catch (err) {
      return fail('ARTIFACT_READ_FAILED', err instanceof Error ? err.message : '读取产物失败')
    }
  })

  ipcMain.handle(IPC.artifactOpenExternal, async (_e, payload: { path: string }): Promise<Result<void>> => {
    const error = await shell.openPath(payload.path)
    if (error) return fail('OPEN_FAILED', error)
    return ok(undefined)
  })

  ipcMain.handle(IPC.artifactReveal, (_e, payload: { path: string }): Result<void> => {
    shell.showItemInFolder(payload.path)
    return ok(undefined)
  })

  ipcMain.handle(IPC.fileRestoreSnapshot, (_e, payload: { sessionId: string; snapshotPath: string; targetPath: string }): Result<void> => {
    try {
      const session = getSessionStore().get(payload.sessionId)
      if (!session) return fail('SESSION_NOT_FOUND', '这个对话不存在了。')
      // R7 审计修复：撤销前校验文件是否在写入后被用户手工改过，冲突时拒绝覆盖。
      const outcome = restoreSnapshotSafely({
        snapshotRoot: join(app.getPath('userData'), 'snapshots'),
        snapshotPath: payload.snapshotPath,
        targetPath: payload.targetPath,
        workspace: session.workspace
      })
      if (!outcome.ok) return fail(outcome.code, outcome.message, outcome.hint)
      log.info('snapshot restored', { target: payload.targetPath, written: outcome.written })
      return ok(undefined)
    } catch (err) {
      return fail('RESTORE_FAILED', err instanceof Error ? err.message : '恢复文件失败')
    }
  })

  ipcMain.handle(IPC.artifactSaveAs, async (_e, payload: { path: string }): Promise<Result<string | null>> => {
    const result = await dialog.showSaveDialog({
      title: '保存产物副本',
      defaultPath: payload.path.split(/[\\/]/).pop()
    })
    if (result.canceled || !result.filePath) return ok(null)
    const { copyFileSync } = await import('node:fs')
    copyFileSync(payload.path, result.filePath)
    return ok(result.filePath)
  })

  /* ── 对话与 Agent 运行 ────────────────────────────────── */
  const agentService = (): ReturnType<typeof getAgentService> =>
    getAgentService(getSettingsStore(), getSessionStore())

  ipcMain.handle(IPC.chatSend, async (_e, input: Parameters<ReturnType<typeof getAgentService>['send']>[0]): Promise<Result<unknown>> => {
    try {
      const result = await agentService().send(input, windowOf())
      return ok(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : '发送失败'
      const hint = /API Key|连接模型/.test(message)
        ? '打开设置 → 模型连接，填好 API Key 后重试。'
        : '可以重试，或新建一个对话再试。'
      return fail('SEND_FAILED', message, hint)
    }
  })

  ipcMain.handle(IPC.chatCompact, async (_e, payload: { sessionId: string }): Promise<Result<unknown>> => {
    try {
      const result = await agentService().compact(payload.sessionId, windowOf())
      return ok(result)
    } catch (err) {
      return fail('COMPACT_FAILED', err instanceof Error ? err.message : '压缩上下文失败')
    }
  })

  ipcMain.handle(IPC.chatCancel, (_e, payload: { runId: string }): Result<void> => {
    if (!agentService().cancel(payload.runId)) return fail('RUN_NOT_FOUND', '这个任务已经结束了。')
    return ok(undefined)
  })

  ipcMain.handle(IPC.permissionRespond, (_e, payload: { requestId: string; decision: PermissionDecision }): Result<void> => {
    if (!agentService().respondPermission(payload.requestId, payload.decision)) {
      return fail('PERMISSION_EXPIRED', '这个审批已经失效了。')
    }
    return ok(undefined)
  })

  ipcMain.handle(IPC.questionRespond, (_e, payload: { requestId: string; answer: AskUserAnswer }): Result<void> => {
    if (!agentService().respondQuestion(payload.requestId, payload.answer)) {
      return fail('QUESTION_EXPIRED', '这个问题已经失效了。')
    }
    return ok(undefined)
  })
}

function describeFile(file: string): Attachment | null {
  try {
    const { statSync } = require('node:fs') as typeof import('node:fs')
    const stat = statSync(file)
    const name = file.split(/[\\/]/).pop() ?? file
    const ext = file.split('.').pop()?.toLowerCase() ?? ''
    const imageExts = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
    if (imageExts.has(ext)) {
      // R7 审计修复：图片以前只给路径（content=null），模型根本看不到图。
      // 现在读成 dataURL（≤8MB），由 AgentService 转成模型的多模态 image 输入。
      const mediaType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'bmp' ? 'image/bmp' : `image/${ext}`
      if (stat.size <= 8 * 1024 * 1024) {
        const data = readFileSync(file).toString('base64')
        return {
          id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name,
          path: file,
          size: stat.size,
          kind: 'image',
          content: `data:${mediaType};base64,${data}`,
          mediaType
        }
      }
      return {
        id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name,
        path: file,
        size: stat.size,
        kind: 'image',
        content: null,
        mediaType,
        truncated: true
      }
    }
    if (isTextFile(file) && stat.size <= 512 * 1024) {
      const content = readFileSync(file, 'utf8')
      const truncated = false
      return {
        id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name,
        path: file,
        size: stat.size,
        kind: 'text',
        content,
        truncated
      }
    }
    return {
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      path: file,
      size: stat.size,
      kind: 'file',
      content: null
    }
  } catch {
    return null
  }
}

export function disposeAgentRuntime(): void {
  try {
    getAgentService(getSettingsStore(), getSessionStore()).dispose()
  } catch {
    // 内核可能尚未初始化
  }
}

export function disposeIpc(): void {
  for (const channel of Object.values(IPC)) {
    try {
      ipcMain.removeHandler(channel)
    } catch {
      // ignore
    }
  }
}
