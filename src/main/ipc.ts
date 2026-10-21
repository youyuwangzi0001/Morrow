import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC, WINDOW_STATE_CHANNEL, type CompleteOnboardingInput, type GoalActionResult, type GoalStartInput, type IslandOpenMainInput, type IslandQuickSendInput, type PlanActionResult, type ProviderTestInput, type SaveProviderInput, type SaveWebSearchInput, type UpdateSettingsInput, type WebSearchTestResult } from '../shared/ipc'
import { DEFAULT_MODEL, findModel } from '../shared/models'
import { isReasoningEffort } from '../shared/reasoning'
import type {
  Artifact,
  ArtifactExportFormat,
  ArtifactVersionInfo,
  AskUserAnswer,
  Attachment,
  CreateSessionInput,
  FileSearchResult,
  ModelRef,
  PermissionDecision,
  PermissionMode,
  ProviderConfig,
  Result,
  ReasoningEffort,
  RewindScope,
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
import { deriveMeta, getSessionStore } from './services/session-store'
import { getCheckpointService } from './services/checkpoint-service'
import { sessionExportContent } from './services/session-export'
import { getWebSearchService } from './services/web-search'
import { syncProviderModels } from './services/model-sync'
import { restoreSnapshotSafely } from './services/snapshot-restore'
import { registerArtifactHtml } from './services/artifact-preview'
import { getArtifactVersionStore } from './services/artifact-versions-runtime'
import { buildExportHtml, buildExportMarkdown, buildExportText } from './services/artifact-export'
import {
  clearIslandSession,
  getIslandSnapshot,
  hideIsland,
  openMainFromIsland,
  quickSendToMain,
  resetIslandAfterClear,
  setIslandExpanded,
  syncIslandVisibility
} from './services/island'
import {
  createDemoWorkspace,
  describeWorkspace,
  isDemoWorkspace,
  pickWorkspace,
  readTextSafe,
  searchWorkspaceFiles
} from './services/workspace'
import { describeAttachment } from './services/attachments'
import { clearSearchIndex, invalidateSearchSession } from './services/search-invalidation'
import { clearScheduleSessionReferences } from './services/schedule-runtime'
import { abortAllSideChats } from './features/sidechat'
import { getTokenActivityService, initializeTokenActivity } from './services/token-activity-runtime'
import { log } from './services/logger'
import { cleanTargetDataDir, copyUserDataForMigration } from './services/data-dir-migration'
import {
  canChangeDataDir,
  dataDirInfo,
  isNestedPath,
  readDataLocation,
  removeDataLocation,
  resolveDefaultDataDir,
  samePath,
  writeDataLocation
} from './services/paths'

const ok = <T>(data: T): Result<T> => ({ ok: true, data })
const fail = (code: string, message: string, hint?: string): Result<never> => ({
  ok: false,
  error: { code, message, hint }
})

function windowOf(): BrowserWindow | null {
  return getMainWindow()
}

function dataDirTargetError(target: string, current: string): string | null {
  if (!isAbsolute(target)) return '请选择绝对路径。'
  if (samePath(target, current)) return '新目录与当前数据目录相同。'
  if (isNestedPath(target, current) || isNestedPath(current, target)) {
    return '新目录不能与当前数据目录互相包含。'
  }
  if (existsSync(target) && !statSync(target).isDirectory()) return '请选择一个文件夹。'
  if (existsSync(target) && readdirSync(target).length > 0) return '请选择一个空文件夹，避免覆盖已有内容。'
  return null
}

function dataDirTestMode(): boolean {
  return process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')
}

function relaunchSoon(): void {
  if (dataDirTestMode()) return
  setTimeout(() => {
    app.relaunch()
    app.exit(0)
  }, 800)
}

/**
 * 文件类 IPC 的路径边界：只接受「已登记工作区」内的真实路径（realpath 后比较，防符号链接逃逸）。
 * 产物、文件搜索等通道不接受渲染层随手传来的任意绝对路径。
 */
function workspaceRootsForIpc(): string[] {
  const roots = new Set<string>()
  try {
    const settings = getSettingsStore().get()
    if (settings.lastWorkspace) roots.add(settings.lastWorkspace)
    for (const path of settings.recentWorkspaces) roots.add(path)
  } catch {
    // 设置尚未就绪时仍尝试会话列表
  }
  try {
    for (const meta of getSessionStore().list()) {
      if (meta.workspace) roots.add(meta.workspace)
    }
  } catch {
    // 会话库损坏时退回设置里的工作区
  }
  return [...roots]
}

function isInsideReal(root: string, target: string): boolean {
  const normalize = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = normalize(root)
  const candidate = normalize(target)
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  return candidate === base || candidate.startsWith(prefix)
}

/** 校验并返回真实路径；kind 不匹配/不在工作区/不存在时返回 null */
function resolveWorkspacePath(raw: unknown, kind: 'file' | 'dir'): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let real: string
  try {
    real = realpathSync(raw)
    const stat = statSync(real)
    if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) return null
  } catch {
    return null
  }
  for (const root of workspaceRootsForIpc()) {
    let rootReal: string
    try {
      rootReal = realpathSync(root)
    } catch {
      continue
    }
    if (isInsideReal(rootReal, real)) return real
  }
  return null
}

/* ── 成品保存 ─────────────────────────────────────────────────── */

const ARTIFACT_CONTENT_MAX_BYTES = 32 * 1024 * 1024
const CODE_EXT: Record<string, string> = {
  typescript: 'ts',
  javascript: 'js',
  tsx: 'tsx',
  jsx: 'jsx',
  python: 'py',
  bash: 'sh',
  shell: 'sh',
  powershell: 'ps1',
  css: 'css',
  json: 'json',
  yaml: 'yml',
  html: 'html',
  xml: 'xml',
  sql: 'sql',
  go: 'go',
  rust: 'rs',
  java: 'java',
  markdown: 'md'
}

function artifactExtension(artifact: Artifact): string {
  if (artifact.path) {
    const ext = extname(artifact.path).toLowerCase()
    if (ext) return ext
  }
  if (artifact.kind === 'html') return '.html'
  if (artifact.kind === 'markdown') return '.md'
  if (artifact.kind === 'svg') return '.svg'
  if (artifact.kind === 'text') return '.txt'
  if (artifact.kind === 'code' && artifact.language) {
    const ext = CODE_EXT[artifact.language.toLowerCase()]
    if (ext) return `.${ext}`
  }
  return artifact.kind === 'file' ? '.bin' : '.txt'
}

function safeArtifactBase(title: string, fallbackPath?: string): string {
  const source = title.trim() || (fallbackPath ? basenameLike(fallbackPath) : '')
  let base = source
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80)
  if (!base) base = 'Morrow 成品'
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(base)) base = `_${base}`
  return base
}

function basenameLike(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

function uniqueArtifactPath(dir: string, base: string, ext: string): string {
  let target = join(dir, `${base}${ext}`)
  for (let index = 1; existsSync(target) && index < 1_000; index += 1) {
    target = join(dir, `${base}-${index}${ext}`)
  }
  return target
}

function sessionArtifact(sessionId: unknown, artifactId: unknown): { session: import('../shared/types').Session; artifact: Artifact } {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('缺少会话 id。')
  if (typeof artifactId !== 'string' || !artifactId.trim()) throw new Error('缺少成品 id。')
  const session = getSessionStore().get(sessionId)
  if (!session) throw new Error('这个对话不存在了。')
  const artifact = session.artifacts.find((item) => item.id === artifactId)
  if (!artifact) throw new Error('这个成品不存在了。')
  return { session, artifact }
}

function artifactText(artifact: Artifact): string | null {
  if (typeof artifact.content === 'string') {
    if (Buffer.byteLength(artifact.content, 'utf8') > ARTIFACT_CONTENT_MAX_BYTES) {
      throw new Error('成品内容超过 32MB，无法保存。')
    }
    return artifact.content
  }
  if (artifact.path) {
    const source = resolveWorkspacePath(artifact.path, 'file')
    if (source) {
      const stat = statSync(source)
      if (stat.size > ARTIFACT_CONTENT_MAX_BYTES) throw new Error('成品文件超过 32MB，无法保存。')
      return readFileSync(source, 'utf8')
    }
  }
  return null
}

const TEXT_ARTIFACT_KINDS = new Set(['html', 'markdown', 'code', 'svg', 'text'])
const EXPORT_FORMATS: ArtifactExportFormat[] = ['original', 'markdown', 'html', 'text', 'pdf']

function isExportFormat(value: unknown): value is ArtifactExportFormat {
  return typeof value === 'string' && EXPORT_FORMATS.includes(value as ArtifactExportFormat)
}

function exportableArtifactText(artifact: Artifact): string {
  if (!TEXT_ARTIFACT_KINDS.has(artifact.kind)) {
    throw new Error('这个成品是文件类型，只能导出原文件。')
  }
  const text = artifactText(artifact)
  if (text === null) throw new Error('这个成品没有可导出的文本内容。')
  return text
}

function exportExtensionFor(format: ArtifactExportFormat, artifact: Artifact): string {
  if (format === 'original') return artifactExtension(artifact)
  if (format === 'markdown') return '.md'
  if (format === 'html') return '.html'
  if (format === 'text') return '.txt'
  return '.pdf'
}

const EXPORT_FILTERS: Record<ArtifactExportFormat, Electron.FileFilter[]> = {
  original: [{ name: '原文件', extensions: ['*'] }],
  markdown: [{ name: 'Markdown 文档', extensions: ['md'] }],
  html: [{ name: '网页', extensions: ['html'] }],
  text: [{ name: '纯文本', extensions: ['txt'] }],
  pdf: [{ name: 'PDF 文档', extensions: ['pdf'] }]
}

/**
 * HTML 报告里的相对图片（如 chart.png）在临时打印文件里找不到。
 * 给 <head> 注入原文件目录的 <base>，PDF 才能带上本地资源。
 */
function withSourceBase(html: string, artifactPath: string): string {
  try {
    const base = pathToFileURL(`${dirname(artifactPath)}${sep}`).href
    if (/<base\b/i.test(html)) return html
    const tag = `<base href="${base.replace(/"/g, '&quot;')}">`
    if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (head) => `${head}${tag}`)
    return html
  } catch {
    return html
  }
}

/** 用隐藏窗口把 HTML 渲染成 PDF；不显示窗口，也不允许弹出新窗口。 */
async function printHtmlToPdf(html: string, target: string): Promise<number> {
  const temp = join(app.getPath('temp'), `morrow-export-${randomUUID()}.html`)
  writeFileSync(temp, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    width: 960,
    height: 1280,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await win.loadFile(temp)
    // 等图片加载与字体排版稳定，最多 1.5 秒，避免导出 PDF 缺图或卡住。
    await win.webContents
      .executeJavaScript(
        `Promise.race([
          Promise.all(Array.from(document.images).map((img) => img.complete ? 0 : new Promise((done) => {
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
          }))),
          new Promise((done) => setTimeout(done, 1500))
        ])`,
        true
      )
      .catch(() => undefined)
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
    writeFileSync(target, pdf)
    return pdf.byteLength
  } finally {
    if (!win.isDestroyed()) win.destroy()
    try {
      rmSync(temp, { force: true })
    } catch {
      // 临时文件清理失败不影响导出结果
    }
  }
}

function emitArtifacts(
  event: Electron.IpcMainInvokeEvent,
  session: import('../shared/types').Session,
  artifactId: string
): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) return
  window.webContents.send('morrow:event', {
    seq: 0,
    runId: 'artifact',
    sessionId: session.id,
    at: Date.now(),
    type: 'artifacts_updated',
    artifacts: session.artifacts,
    artifactId
  })
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

  ipcMain.handle(IPC.tokenActivityGet, (): Result<unknown> => {
    try {
      initializeTokenActivity()
      return ok(getTokenActivityService().summary())
    } catch (err) {
      return fail('TOKEN_ACTIVITY_FAILED', err instanceof Error ? err.message : '读取 Token 活动失败')
    }
  })

  ipcMain.handle(IPC.appInfo, (): Result<unknown> => {
    return ok({
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      ...dataDirInfo()
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
    const error = await shell.openPath(app.getPath('userData'))
    if (error) return fail('OPEN_DATA_DIR_FAILED', `打开数据目录失败：${error}`)
    return ok(undefined)
  })

  ipcMain.handle(IPC.openLogs, async (): Promise<Result<void>> => {
    const dir = join(app.getPath('userData'), 'logs')
    const error = await shell.openPath(existsSync(dir) ? dir : app.getPath('userData'))
    if (error) return fail('OPEN_LOGS_FAILED', `打开日志目录失败：${error}`)
    return ok(undefined)
  })

  ipcMain.handle(
    IPC.changeDataDir,
    async (): Promise<Result<{ restarted: boolean; path?: string; canceled?: boolean; files?: number }>> => {
      if (!canChangeDataDir()) {
        return fail('DATA_DIR_LOCKED', '当前数据目录由启动参数指定，不能在此修改。')
      }
      const win = BrowserWindow.getFocusedWindow() ?? windowOf()
      const openOptions: OpenDialogOptions = {
        title: '选择 Morrow 数据目录',
        buttonLabel: '选择此文件夹',
        properties: ['openDirectory', 'createDirectory']
      }
      const picked = win ? await dialog.showOpenDialog(win, openOptions) : await dialog.showOpenDialog(openOptions)
      if (picked.canceled || !picked.filePaths[0]) return ok({ restarted: false, canceled: true })

      const target = resolve(picked.filePaths[0])
      const current = app.getPath('userData')
      try {
        mkdirSync(target, { recursive: true })
      } catch (err) {
        return fail('DATA_DIR_INVALID', `无法使用该文件夹：${err instanceof Error ? err.message : String(err)}`)
      }
      const targetError = dataDirTargetError(target, current)
      if (targetError) return fail('DATA_DIR_INVALID', targetError)

      const detail =
        `新目录：${target}\n\n` +
        '迁移并重启：复制现有对话、设置、项目、记忆与技能；浏览器缓存与登录状态不迁移，原目录保留。\n' +
        '仅切换并重启：新目录从空白开始，原目录保留。'
      const choice = win
        ? await dialog.showMessageBox(win, {
            type: 'question',
            title: '切换数据目录',
            message: '切换数据目录后需要重启 Morrow',
            detail,
            buttons: ['迁移并重启', '仅切换并重启', '取消'],
            defaultId: 0,
            cancelId: 2,
            noLink: true
          })
        : await dialog.showMessageBox({
            type: 'question',
            title: '切换数据目录',
            message: '切换数据目录后需要重启 Morrow',
            detail,
            buttons: ['迁移并重启', '仅切换并重启', '取消'],
            defaultId: 0,
            cancelId: 2,
            noLink: true
          })
      if (choice.response === 2) return ok({ restarted: false, canceled: true })

      const migrate = choice.response === 0
      let files = 0
      if (migrate) {
        try {
          files = copyUserDataForMigration(current, target)
        } catch (err) {
          try {
            cleanTargetDataDir(target)
          } catch {
            // 清理失败不掩盖迁移错误
          }
          return fail('DATA_DIR_MIGRATE_FAILED', `迁移数据失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      try {
        writeDataLocation(target)
      } catch (err) {
        if (migrate) {
          try {
            cleanTargetDataDir(target)
          } catch {
            // ignore
          }
        }
        return fail('DATA_DIR_SAVE_FAILED', `保存数据目录失败：${err instanceof Error ? err.message : String(err)}`)
      }
      relaunchSoon()
      return ok({ restarted: !dataDirTestMode(), path: target, files })
    }
  )

  ipcMain.handle(IPC.resetDataDir, async (): Promise<Result<{ restarted: boolean; canceled?: boolean }>> => {
    if (!canChangeDataDir()) {
      return fail('DATA_DIR_LOCKED', '当前数据目录由启动参数指定，不能在此修改。')
    }
    if (!readDataLocation()) return ok({ restarted: false, canceled: true })
    const win = BrowserWindow.getFocusedWindow() ?? windowOf()
    const options = {
      type: 'question' as const,
      title: '恢复默认数据目录',
      message: '恢复默认数据目录并重启？',
      detail: `应用将使用默认目录：${resolveDefaultDataDir()}\n当前自定义目录不会被删除，数据也不会自动合并。`,
      buttons: ['恢复默认并重启', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }
    const choice = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    if (choice.response !== 0) return ok({ restarted: false, canceled: true })
    removeDataLocation()
    relaunchSoon()
    return ok({ restarted: !dataDirTestMode() })
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
      if (Object.prototype.hasOwnProperty.call(patch ?? {}, 'islandEnabled')) syncIslandVisibility()
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.settingsChanged, settings)
      }
      return ok(settings)
    } catch (err) {
      return fail('SETTINGS_UPDATE_FAILED', err instanceof Error ? err.message : '保存设置失败')
    }
  })

  /* ── 桌面灵动岛 ───────────────────────────────────────── */
  ipcMain.handle(IPC.islandState, (): Result<unknown> => ok(getIslandSnapshot()))

  ipcMain.handle(IPC.islandSetExpanded, (_e, payload: { expanded?: unknown }): Result<void> => {
    setIslandExpanded(payload?.expanded === true)
    return ok(undefined)
  })

  ipcMain.handle(IPC.islandHide, (): Result<void> => {
    hideIsland()
    return ok(undefined)
  })

  ipcMain.handle(IPC.islandOpenMain, (_e, payload: IslandOpenMainInput): Result<void> => {
    return openMainFromIsland(payload ?? {}) ? ok(undefined) : fail('ISLAND_NO_MAIN', '主窗口还没有准备好。')
  })

  ipcMain.handle(IPC.islandQuickSend, (_e, payload: IslandQuickSendInput): Result<void> => {
    if (typeof payload?.text !== 'string' || !payload.text.trim()) {
      return fail('ISLAND_EMPTY', '先说点什么，再交给 Morrow。')
    }
    if (payload.sessionId !== undefined && typeof payload.sessionId !== 'string') {
      return fail('ISLAND_SESSION_INVALID', '对话参数无效，请重新打开 Morrow。')
    }
    if (payload.sessionId) {
      // 岛内显示的会话可能已被删除；绝不能把消息落到当前另一个会话。
      const session = getSessionStore().get(payload.sessionId)
      if (!session) return fail('ISLAND_SESSION_GONE', '原来的对话不存在了，请打开 Morrow 选择或新建对话。')
    }
    return quickSendToMain(payload) ? ok(undefined) : fail('ISLAND_NO_MAIN', '主窗口还没有准备好。')
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

  ipcMain.handle(IPC.settingsSaveWebSearch, (_e, input: SaveWebSearchInput): Result<unknown> => {
    try {
      return ok(getSettingsStore().saveWebSearch(input))
    } catch (err) {
      return fail('WEB_SEARCH_SAVE_FAILED', err instanceof Error ? err.message : '保存联网搜索设置失败')
    }
  })

  ipcMain.handle(IPC.settingsTestWebSearch, async (): Promise<Result<WebSearchTestResult>> => {
    const startedAt = Date.now()
    try {
      const service = getWebSearchService(getSettingsStore())
      const result = await service.search({ query: 'Morrow 联网搜索连接测试', maxResults: 3 })
      return ok({
        ok: true,
        provider: result.provider,
        sourceCount: result.sources.length,
        latencyMs: Date.now() - startedAt,
        message: result.sources.length
          ? `连接正常：返回 ${result.sources.length} 条结果。`
          : '连接正常，但没有返回结果。',
        sources: result.sources
      })
    } catch (err) {
      return ok({
        ok: false,
        provider: '',
        sourceCount: 0,
        latencyMs: Date.now() - startedAt,
        message: err instanceof Error ? err.message : '联网搜索测试失败'
      })
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
      const nextSettings = store.saveProvider({
        ...provider,
        models: outcome.models,
        modelsSyncedAt: Date.now()
      })
      log.info('models synced', {
        provider: provider.id,
        total: outcome.total,
        added: outcome.added,
        updated: outcome.updated,
        skipped: outcome.skipped ?? 0
      })
      return ok({
        providerId: provider.id,
        providerName: provider.name,
        added: outcome.added,
        updated: outcome.updated,
        total: outcome.total,
        message: outcome.message,
        models: outcome.models,
        ...(outcome.truncated ? { truncated: true } : {}),
        ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
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
      if (!input || typeof input !== 'object') return fail('INVALID_SESSION_INPUT', '新建对话参数无效。')
      if (input.permissionMode && !['read-only', 'ask', 'auto'].includes(input.permissionMode)) {
        return fail('INVALID_PERMISSION_MODE', '权限模式无效。')
      }
      if (input.mode && input.mode !== 'chat' && input.mode !== 'work' && input.mode !== 'research') {
        return fail('INVALID_SESSION_MODE', '会话模式无效。')
      }
      if (input.workspace !== undefined && input.workspace !== null && typeof input.workspace !== 'string') {
        return fail('INVALID_WORKSPACE', '工作区路径必须是字符串。')
      }
      if (input.temporary !== undefined && typeof input.temporary !== 'boolean') {
        return fail('INVALID_SESSION_INPUT', '临时对话参数无效。')
      }
      const settings = getSettingsStore().get()
      const model = input.model ?? settings.defaultModel
      const modelInfo = findModel(settings.providers, model)
      if (!modelInfo) return fail('MODEL_NOT_FOUND', '这个模型不可用，请到设置里重新选择。')
      const provider = settings.providers.find((item) => item.id === model.providerId)
      if (!provider) return fail('MODEL_NOT_FOUND', '这个模型不可用，请到设置里重新选择。')
      const isDemoModel = provider.kind === 'demo'
      if (isDemoModel && !isDemoWorkspace(input.workspace ?? settings.lastWorkspace)) {
        return fail(
          'DEMO_WORKSPACE_REQUIRED',
          '演示模型只能在 Morrow 的演示工作区中使用。请先在设置 → 模型里连接真实模型，再开始任务。'
        )
      }
      if (!isDemoModel && input.demo === true) {
        return fail('DEMO_MODEL_REQUIRED', '演示会话必须使用演示模型。')
      }
      const session = getSessionStore().create({
        ...input,
        demo: isDemoModel,
        defaultModel: settings.defaultModel,
        defaultPermission: settings.permissionMode
      })
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
    let changed = false
    const provider = settings.providers.find((p) => p.id === session.model.providerId)
    if (provider && provider.models.length > 0 && !provider.models.some((m) => m.id === session.model.modelId)) {
      session.model = { providerId: provider.id, modelId: provider.models[0].id }
      changed = true
    }
    const activeProvider = settings.providers.find((p) => p.id === session.model.providerId)
    if (activeProvider?.kind === 'demo') {
      if (!isDemoWorkspace(session.workspace)) {
        // 旧版本会把演示模型写进普通会话：修复成默认真实模型，避免继续在真实文件夹里播放演示剧本
        const defaultProvider = settings.providers.find((p) => p.id === settings.defaultModel.providerId)
        const fallback =
          defaultProvider?.kind !== 'demo' && findModel(settings.providers, settings.defaultModel)
            ? settings.defaultModel
            : DEFAULT_MODEL
        session.model = fallback
        delete session.demo
        changed = true
      } else if (!session.demo) {
        session.demo = true
        changed = true
      }
    } else if (session.demo) {
      delete session.demo
      changed = true
    }
    if (changed) getSessionStore().save(session)
    return ok(session)
  })

  ipcMain.handle(IPC.sessionRename, (_e, payload: { sessionId: string; title: string }): Result<SessionMeta> => {
    const meta = getSessionStore().rename(payload.sessionId, payload.title)
    if (!meta) return fail('SESSION_NOT_FOUND', '这个对话不存在了。')
    pushSessionMeta(meta)
    return ok(meta)
  })

  ipcMain.handle(IPC.sessionDelete, async (_e, payload: { sessionId: string }): Promise<Result<void>> => {
    try {
      await getAgentService(getSettingsStore(), getSessionStore()).removeSession(payload.sessionId)
      clearIslandSession(payload.sessionId)
      try {
        await invalidateSearchSession(payload.sessionId)
      } catch (err) {
        // 搜索索引失效失败不应阻止会话删除；下次查询的全量刷新仍会清理
        log.warn('session delete: search invalidation failed', { sessionId: payload.sessionId, error: String(err) })
      }
      return ok(undefined)
    } catch (err) {
      return fail('SESSION_DELETE_FAILED', err instanceof Error ? err.message : '删除会话失败')
    }
  })

  ipcMain.handle(IPC.sessionClearAll, async (): Promise<Result<{ deleted: number }>> => {
    try {
      abortAllSideChats()
      const deleted = await getAgentService(getSettingsStore(), getSessionStore()).clearAllSessions()
      resetIslandAfterClear()
      try {
        clearScheduleSessionReferences()
      } catch (err) {
        log.warn('clear all: schedule session link cleanup failed', { error: String(err) })
      }
      try {
        await clearSearchIndex()
      } catch (err) {
        // 索引会在下次搜索时按会话 revision 自动清理
        log.warn('clear all: search index cleanup failed', { error: String(err) })
      }
      return ok({ deleted })
    } catch (err) {
      return fail('SESSION_CLEAR_ALL_FAILED', err instanceof Error ? err.message : '清除全部对话失败')
    }
  })

  ipcMain.handle(
    IPC.sessionSetModel,
    (_e, payload: { sessionId: string; model: ModelRef }): Result<SessionMeta> => {
      if (!payload || typeof payload !== 'object') return fail('INVALID_MODEL', '模型参数无效。')
      if (!findModel(getSettingsStore().get().providers, payload.model)) {
        return fail('MODEL_NOT_FOUND', '这个模型不可用，请到设置里重新选择。')
      }
      const settings = getSettingsStore().get()
      const provider = settings.providers.find((item) => item.id === payload.model.providerId)
      if (!provider) return fail('MODEL_NOT_FOUND', '这个模型不可用，请到设置里重新选择。')
      const session = getSessionStore().get(payload.sessionId)
      if (!session) return fail('SESSION_NOT_FOUND', '这个对话不存在了。')
      if (provider.kind === 'demo' && !isDemoWorkspace(session.workspace)) {
        return fail('DEMO_WORKSPACE_REQUIRED', '演示模型只能在 Morrow 的演示工作区中使用。')
      }
      const meta = getSessionStore().setModel(payload.sessionId, payload.model, provider.kind === 'demo')
      if (!meta) return fail('SESSION_NOT_FOUND', '这个对话不存在了。')
      pushSessionMeta(meta)
      return ok(meta)
    }
  )

  ipcMain.handle(
    IPC.sessionSetPermissionMode,
    (_e, payload: { sessionId: string; mode: PermissionMode }): Result<SessionMeta> => {
      if (!payload || typeof payload !== 'object' || !['read-only', 'ask', 'auto'].includes(payload.mode)) {
        return fail('INVALID_PERMISSION_MODE', '权限模式无效。')
      }
      const meta = getSessionStore().setPermissionMode(payload.sessionId, payload.mode)
      if (!meta) return fail('SESSION_NOT_FOUND', '这个对话不存在了。')
      pushSessionMeta(meta)
      return ok(meta)
    }
  )

  ipcMain.handle(
    IPC.sessionSetPinned,
    (_e, payload: { sessionId: string; pinned: boolean }): Result<SessionMeta> => {
      const meta = getSessionStore().setPinned(payload.sessionId, payload.pinned === true)
      if (!meta) return fail('SESSION_NOT_FOUND', '这个对话不存在了。')
      pushSessionMeta(meta)
      return ok(meta)
    }
  )

  ipcMain.handle(
    IPC.sessionSetArchived,
    (_e, payload: { sessionId: string; archived: boolean }): Result<SessionMeta> => {
      const meta = getSessionStore().setArchived(payload.sessionId, payload.archived === true)
      if (!meta) return fail('SESSION_NOT_FOUND', '这个对话不存在了。')
      pushSessionMeta(meta)
      return ok(meta)
    }
  )

  ipcMain.handle(
    IPC.sessionBranch,
    (_e, payload: { sessionId: string; messageId: string; title?: string }): Result<Session> => {
      try {
        const branch = getAgentService(getSettingsStore(), getSessionStore()).branch(
          payload.sessionId,
          payload.messageId,
          payload.title
        )
        pushSessionMeta(deriveMeta(branch))
        return ok(branch)
      } catch (err) {
        return fail('SESSION_BRANCH_FAILED', err instanceof Error ? err.message : '分叉会话失败')
      }
    }
  )

  ipcMain.handle(
    IPC.sessionExport,
    async (_e, payload: { sessionId: string; format: 'markdown' | 'json' }): Promise<Result<string | null>> => {
      try {
        const session = getSessionStore().get(payload.sessionId)
        if (!session) return fail('SESSION_NOT_FOUND', '这个对话不存在了。')
        const format = payload.format === 'json' ? 'json' : 'markdown'
        const { filename, content } = sessionExportContent(session, format)
        const bytes = Buffer.byteLength(content, 'utf8')
        if (bytes > 32 * 1024 * 1024) {
          return fail(
            'SESSION_EXPORT_TOO_LARGE',
            `对话导出内容过大（${(bytes / 1024 / 1024).toFixed(1)}MB，上限 32MB）。请改用 Markdown 导出，或先清理超大附件。`
          )
        }
        const result = await dialog.showSaveDialog({
          title: '导出对话',
          defaultPath: filename,
          filters: format === 'json' ? [{ name: 'JSON', extensions: ['json'] }] : [{ name: 'Markdown', extensions: ['md'] }]
        })
        if (result.canceled || !result.filePath) return ok(null)
        await writeFile(result.filePath, content, 'utf8')
        return ok(result.filePath)
      } catch (err) {
        return fail('SESSION_EXPORT_FAILED', err instanceof Error ? err.message : '导出对话失败')
      }
    }
  )

  ipcMain.handle(
    IPC.sessionSetReasoning,
    (_e, payload: { sessionId: string; effort: ReasoningEffort }): Result<SessionMeta> => {
      if (!payload || !isReasoningEffort(payload.effort)) {
        return fail('INVALID_REASONING_EFFORT', '推理强度无效。')
      }
      const meta = getSessionStore().setReasoningEffort(payload.sessionId, payload.effort)
      if (!meta) return fail('SESSION_NOT_FOUND', '这个对话不存在了。')
      pushSessionMeta(meta)
      return ok(meta)
    }
  )

  ipcMain.handle(
    IPC.sessionSetMode,
    (e, payload: { sessionId: string; mode: SessionMode }): Result<SessionMeta> => {
      try {
        if (!payload || (payload.mode !== 'chat' && payload.mode !== 'work' && payload.mode !== 'research')) {
          return fail('INVALID_SESSION_MODE', '会话模式无效。')
        }
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

  /* ── 计划模式（P0-2） ───────────────────────────────────── */
  ipcMain.handle(IPC.planSetMode, (e, payload: { sessionId: string; enabled: boolean }): Result<SessionMeta> => {
    try {
      if (!payload || typeof payload.enabled !== 'boolean') return fail('INVALID_PLAN_MODE', '计划模式参数无效。')
      const meta = goalService().setPlanMode(payload.sessionId, payload.enabled, BrowserWindow.fromWebContents(e.sender))
      pushSessionMeta(meta)
      return ok(meta)
    } catch (err) {
      return fail('PLAN_MODE_FAILED', err instanceof Error ? err.message : '切换计划模式失败')
    }
  })

  ipcMain.handle(IPC.planApprove, (e, payload: { sessionId: string }): Result<PlanActionResult> => {
    try {
      const result = goalService().approvePlan(payload.sessionId, BrowserWindow.fromWebContents(e.sender))
      const latest = getSessionStore().get(payload.sessionId)
      return ok({ plan: result.plan, runId: result.runId, ...(latest ? { meta: deriveMeta(latest) } : {}) })
    } catch (err) {
      return fail('PLAN_APPROVE_FAILED', err instanceof Error ? err.message : '批准计划失败')
    }
  })

  ipcMain.handle(IPC.planRevise, (e, payload: { sessionId: string; feedback: string }): Result<PlanActionResult> => {
    try {
      const result = goalService().revisePlan(payload.sessionId, payload.feedback ?? '', BrowserWindow.fromWebContents(e.sender))
      return ok({ plan: result.plan, ...(result.runId ? { runId: result.runId } : {}) })
    } catch (err) {
      return fail('PLAN_REVISE_FAILED', err instanceof Error ? err.message : '修改计划失败')
    }
  })

  ipcMain.handle(IPC.planReject, (e, payload: { sessionId: string; feedback?: string }): Result<PlanActionResult> => {
    try {
      const plan = goalService().rejectPlan(payload.sessionId, payload.feedback, BrowserWindow.fromWebContents(e.sender))
      return ok({ plan })
    } catch (err) {
      return fail('PLAN_REJECT_FAILED', err instanceof Error ? err.message : '拒绝计划失败')
    }
  })

  /* ── 检查点与回退（P0-3） ─────────────────────────────── */
  const checkpointService = (): ReturnType<typeof getCheckpointService> => getCheckpointService(getSessionStore())

  ipcMain.handle(IPC.checkpointList, (_e, payload: { sessionId: string }): Result<unknown> => {
    try {
      return ok(checkpointService().list(payload.sessionId))
    } catch (err) {
      return fail('CHECKPOINT_LIST_FAILED', err instanceof Error ? err.message : '读取检查点失败')
    }
  })

  ipcMain.handle(
    IPC.checkpointPreview,
    (_e, payload: { sessionId: string; checkpointId: string }): Result<unknown> => {
      try {
        const session = getSessionStore().get(payload.sessionId)
        if (!session) return fail('SESSION_NOT_FOUND', '这个对话不存在了。')
        return ok(checkpointService().preview(session, payload.checkpointId))
      } catch (err) {
        return fail('CHECKPOINT_PREVIEW_FAILED', err instanceof Error ? err.message : '检查文件失败')
      }
    }
  )

  ipcMain.handle(
    IPC.checkpointRewind,
    async (
      e,
      payload: { sessionId: string; checkpointId: string; scope: RewindScope }
    ): Promise<Result<unknown>> => {
      try {
        const scope = payload.scope
        if (scope !== 'both' && scope !== 'code' && scope !== 'conversation') {
          return fail('INVALID_REWIND_SCOPE', '请选择要回退的内容。')
        }
        const service = goalService()
        if (service.isSessionBusy(payload.sessionId)) {
          return fail('SESSION_BUSY', '对话还在运行或压缩：先停止，再回到之前。')
        }
        const session = getSessionStore().get(payload.sessionId)
        if (!session) return fail('SESSION_NOT_FOUND', '这个对话不存在了。')
        if (session.goal && !['completed', 'cancelled'].includes(session.goal.status)) {
          return fail('GOAL_ACTIVE', '先结束或清除当前目标，再回到之前。', '目标状态与回退后的对话可能不一致。')
        }
        const result = checkpointService().rewind(session, payload.checkpointId, scope)
        const latest = getSessionStore().get(payload.sessionId)
        const window = BrowserWindow.fromWebContents(e.sender)
        if (latest) {
          const base = { seq: 0, runId: 'checkpoint', sessionId: latest.id, at: Date.now() }
          if (scope !== 'code') {
            window?.webContents.send('morrow:event', { ...base, type: 'messages_replaced', messages: latest.messages })
            window?.webContents.send('morrow:event', { ...base, type: 'todos_updated', todos: latest.todos })
            window?.webContents.send('morrow:event', { ...base, type: 'artifacts_updated', artifacts: latest.artifacts })
            window?.webContents.send('morrow:event', {
              ...base,
              type: 'plan_updated',
              plan: latest.plan ?? null,
              planMode: latest.planMode === true
            })
            try {
              await invalidateSearchSession(latest.id)
            } catch (err) {
              log.warn('rewind: search invalidation failed', { sessionId: latest.id, error: String(err) })
            }
          }
          window?.webContents.send('morrow:event', { ...base, type: 'session_updated', meta: deriveMeta(latest) })
        }
        log.info('checkpoint rewind', { sessionId: payload.sessionId, checkpointId: payload.checkpointId, scope })
        return ok(result)
      } catch (err) {
        return fail('REWIND_FAILED', err instanceof Error ? err.message : '回到这一轮之前失败')
      }
    }
  )

  /* ── 运行中排队（P0-5） ─────────────────────────────────── */
  ipcMain.handle(IPC.queueList, (_e, payload: { sessionId: string }): Result<unknown> => {
    try {
      return ok(goalService().listQueue(payload.sessionId))
    } catch (err) {
      return fail('QUEUE_LIST_FAILED', err instanceof Error ? err.message : '读取排队消息失败')
    }
  })

  ipcMain.handle(
    IPC.queueAdd,
    (e, payload: { sessionId: string; text: string; attachments?: Attachment[] }): Result<unknown> => {
      try {
        return ok(goalService().addToQueue(payload, BrowserWindow.fromWebContents(e.sender)))
      } catch (err) {
        return fail('QUEUE_ADD_FAILED', err instanceof Error ? err.message : '加入队列失败')
      }
    }
  )

  ipcMain.handle(
    IPC.queueUpdate,
    (e, payload: { sessionId: string; queueId: string; text: string }): Result<unknown> => {
      try {
        return ok(goalService().updateQueueItem(payload, BrowserWindow.fromWebContents(e.sender)))
      } catch (err) {
        return fail('QUEUE_UPDATE_FAILED', err instanceof Error ? err.message : '修改排队消息失败')
      }
    }
  )

  ipcMain.handle(
    IPC.queueRemove,
    (e, payload: { sessionId: string; queueId: string }): Result<unknown> => {
      try {
        return ok(goalService().removeQueueItem(payload, BrowserWindow.fromWebContents(e.sender)))
      } catch (err) {
        return fail('QUEUE_REMOVE_FAILED', err instanceof Error ? err.message : '删除排队消息失败')
      }
    }
  )

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
  ipcMain.handle(
    IPC.fileSearch,
    (_e, payload: { root?: unknown; query?: unknown; limit?: unknown } | undefined): Result<FileSearchResult[]> => {
      try {
        const requested = typeof payload?.root === 'string' ? resolve(payload.root) : ''
        if (!requested || !resolveWorkspacePath(requested, 'dir')) {
          return fail('FILE_ROOT_DENIED', '只能搜索当前工作区内的文件夹。')
        }
        const rawLimit = Number(payload?.limit)
        const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.floor(rawLimit))) : 12
        const query = typeof payload?.query === 'string' ? payload.query.slice(0, 200) : ''
        return ok(searchWorkspaceFiles(requested, query, limit))
      } catch (err) {
        return fail('FILE_SEARCH_FAILED', err instanceof Error ? err.message : '搜索文件失败')
      }
    }
  )

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
        const info = describeAttachment(file)
        if (info) attachments.push(info)
      }
      return ok(attachments)
    } catch (err) {
      return fail('FILE_ATTACH_FAILED', err instanceof Error ? err.message : '添加文件失败')
    }
  })

  /* ── 产物 ─────────────────────────────────────────────── */
  ipcMain.handle(
    IPC.artifactRead,
    async (
      _e,
      payload: { path?: unknown } | undefined
    ): Promise<Result<{ content: string; size: number; kind: string; truncated: boolean }>> => {
      try {
        const target = resolveWorkspacePath(payload?.path, 'file')
        if (!target) return fail('FILE_UNAVAILABLE', '产物不在可访问的工作区内，或已被移动。')
        const kind = target.split('.').pop()?.toLowerCase() ?? 'txt'
        // HTML 报告常内嵌图片/样式，放宽到 8MB；其它文本仍限制 2MB，避免超大内容拖垮渲染
        const limit = /^(?:html?|xhtml)$/i.test(kind) ? 8 * 1024 * 1024 : 2 * 1024 * 1024
        const { content, size, truncated } = await readTextSafe(target, limit)
        return ok({ content, size, kind, truncated })
      } catch (err) {
        return fail('ARTIFACT_READ_FAILED', err instanceof Error ? err.message : '读取产物失败')
      }
    }
  )

  ipcMain.handle(
    IPC.artifactPreviewHtml,
    (_e, payload: { html?: unknown } | undefined): Result<{ url: string }> => {
      try {
        return ok({ url: registerArtifactHtml(payload?.html) })
      } catch (err) {
        return fail('ARTIFACT_PREVIEW_FAILED', err instanceof Error ? err.message : '网页预览准备失败')
      }
    }
  )

  ipcMain.handle(IPC.artifactOpenExternal, async (_e, payload: { path?: unknown } | undefined): Promise<Result<void>> => {
    try {
      const target = resolveWorkspacePath(payload?.path, 'file')
      if (!target) return fail('FILE_UNAVAILABLE', '产物不在可访问的工作区内，或已被移动。')
      const error = await shell.openPath(target)
      if (error) return fail('OPEN_FAILED', error)
      return ok(undefined)
    } catch (err) {
      return fail('OPEN_FAILED', err instanceof Error ? err.message : '打开文件失败')
    }
  })

  ipcMain.handle(IPC.artifactReveal, (_e, payload: { path?: unknown } | undefined): Result<void> => {
    try {
      const target = resolveWorkspacePath(payload?.path, 'file')
      if (!target) return fail('FILE_UNAVAILABLE', '产物不在可访问的工作区内，或已被移动。')
      shell.showItemInFolder(target)
      return ok(undefined)
    } catch (err) {
      return fail('REVEAL_FAILED', err instanceof Error ? err.message : '打开文件夹失败')
    }
  })

  ipcMain.handle(IPC.fileRestoreSnapshot, (_e, payload: { sessionId: string; snapshotPath: string; targetPath: string }): Result<void> => {
    try {
      const session = getSessionStore().get(payload.sessionId)
      if (!session) return fail('SESSION_NOT_FOUND', '这个对话不存在了。')
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) return fail('INVALID_SNAPSHOT', '快照路径不合法。')
      // R7/R11 审计修复：撤销前校验快照属于当前会话、文件在写入后未被手工改过，冲突时拒绝覆盖。
      const outcome = restoreSnapshotSafely({
        snapshotRoot: join(app.getPath('userData'), 'snapshots', session.id),
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

  ipcMain.handle(
    IPC.artifactSaveToWorkspace,
    async (
      e,
      payload: { sessionId?: unknown; artifactId?: unknown } | undefined
    ): Promise<Result<{ path: string; artifact: Artifact }>> => {
      try {
        const { session, artifact } = sessionArtifact(payload?.sessionId, payload?.artifactId)
        if (!session.workspace) return fail('WORKSPACE_REQUIRED', '这个对话还没有选择文件夹，无法保存到工作区。')
        const workspace = resolveWorkspacePath(session.workspace, 'dir')
        if (!workspace) return fail('WORKSPACE_UNAVAILABLE', '当前文件夹不可用，请重新选择。')
        const dir = join(workspace, 'artifacts')
        mkdirSync(dir, { recursive: true })
        const ext = artifactExtension(artifact)
        const target = uniqueArtifactPath(dir, safeArtifactBase(artifact.title, artifact.path), ext)
        if (!isInsideReal(workspace, target)) return fail('ARTIFACT_PATH_DENIED', '成品保存路径越出了当前文件夹。')

        const source = artifact.path ? resolveWorkspacePath(artifact.path, 'file') : null
        if (source && source !== target) {
          copyFileSync(source, target)
        } else if (source) {
          return ok({ path: source, artifact })
        } else {
          const text = artifactText(artifact)
          if (text === null) return fail('ARTIFACT_NOT_SAVEABLE', '这个成品没有可保存的文本内容。')
          writeFileSync(target, text, { encoding: 'utf8', flag: 'wx' })
        }

        artifact.path = target
        artifact.updatedAt = Date.now()
        getSessionStore().save(session)
        emitArtifacts(e, session, artifact.id)
        void invalidateSearchSession(session.id).catch(() => undefined)
        return ok({ path: target, artifact })
      } catch (err) {
        return fail('ARTIFACT_SAVE_FAILED', err instanceof Error ? err.message : '保存到文件夹失败')
      }
    }
  )

  ipcMain.handle(
    IPC.artifactVersions,
    (_e, payload: { sessionId?: unknown; artifactId?: unknown } | undefined): Result<ArtifactVersionInfo[]> => {
      try {
        const { session, artifact } = sessionArtifact(payload?.sessionId, payload?.artifactId)
        const store = getArtifactVersionStore()
        // 临时对话不在磁盘留成品版本。
        if (session.temporary) return ok([])
        // 打开历史时先记录当前内容，确保内联成品/未经过 Agent 收尾的修改也有版本。
        // 还没有快照时是基线；已有快照而内容又变了，说明是在编辑器/外部手动改的。
        const known = store.list(session.id, artifact.id).length
        store.record(session.id, artifact, known === 0 ? 'baseline' : 'manual')
        return ok(store.list(session.id, artifact.id))
      } catch (err) {
        return fail('ARTIFACT_VERSIONS_FAILED', err instanceof Error ? err.message : '读取版本历史失败')
      }
    }
  )

  ipcMain.handle(
    IPC.artifactVersionRead,
    (
      _e,
      payload: { sessionId?: unknown; artifactId?: unknown; versionId?: unknown } | undefined
    ): Result<{ version: ArtifactVersionInfo; content: string }> => {
      try {
        const { session, artifact } = sessionArtifact(payload?.sessionId, payload?.artifactId)
        if (typeof payload?.versionId !== 'string' || !payload.versionId) throw new Error('缺少版本 id。')
        const snapshot = getArtifactVersionStore().read(session.id, artifact.id, payload.versionId)
        if (!snapshot) throw new Error('这个版本已经不存在了。')
        return ok(snapshot)
      } catch (err) {
        return fail('ARTIFACT_VERSION_READ_FAILED', err instanceof Error ? err.message : '读取版本失败')
      }
    }
  )

  ipcMain.handle(
    IPC.artifactVersionRestore,
    (
      e,
      payload: { sessionId?: unknown; artifactId?: unknown; versionId?: unknown } | undefined
    ): Result<Artifact> => {
      try {
        const { session, artifact } = sessionArtifact(payload?.sessionId, payload?.artifactId)
        if (typeof payload?.versionId !== 'string' || !payload.versionId) throw new Error('缺少版本 id。')
        if (getAgentService(getSettingsStore(), getSessionStore()).isSessionRunning(session.id)) {
          throw new Error('这个对话正在运行：等它完成或先停止，再恢复版本。')
        }
        const store = getArtifactVersionStore()
        const snapshot = store.read(session.id, artifact.id, payload.versionId)
        if (!snapshot) throw new Error('这个版本已经不存在了。')
        if (artifact.path) {
          const target = resolveWorkspacePath(artifact.path, 'file')
          if (!target) throw new Error('成品文件已被移动或不在当前文件夹内，无法恢复。')
          writeFileSync(target, snapshot.content, 'utf8')
          // 已保存到工作区的成品仍可能带有内联内容；两者必须一起更新，否则画布会继续显示旧内容。
          artifact.content = snapshot.content
        } else {
          artifact.content = snapshot.content
        }
        artifact.updatedAt = Date.now()
        getSessionStore().save(session)
        store.record(session.id, artifact, 'restore')
        emitArtifacts(e, session, artifact.id)
        void invalidateSearchSession(session.id).catch(() => undefined)
        log.info('artifact version restored', {
          sessionId: session.id,
          artifactId: artifact.id,
          versionId: snapshot.version.id
        })
        return ok(artifact)
      } catch (err) {
        return fail('ARTIFACT_VERSION_RESTORE_FAILED', err instanceof Error ? err.message : '恢复版本失败')
      }
    }
  )

  ipcMain.handle(
    IPC.artifactExportText,
    (
      _e,
      payload: {
        sessionId?: unknown
        artifactId?: unknown
        format?: unknown
      } | undefined
    ): Result<string> => {
      try {
        const { artifact } = sessionArtifact(payload?.sessionId, payload?.artifactId)
        const format = payload?.format
        if (format !== 'markdown' && format !== 'html' && format !== 'text') {
          throw new Error('不支持的复制格式。')
        }
        const content = exportableArtifactText(artifact)
        if (format === 'markdown') return ok(buildExportMarkdown(artifact, content))
        if (format === 'html') return ok(buildExportHtml(artifact, content))
        return ok(buildExportText(artifact, content))
      } catch (err) {
        return fail('ARTIFACT_EXPORT_TEXT_FAILED', err instanceof Error ? err.message : '生成导出内容失败')
      }
    }
  )

  ipcMain.handle(
    IPC.artifactExport,
    async (
      e,
      payload: { sessionId?: unknown; artifactId?: unknown; format?: unknown } | undefined
    ): Promise<Result<string | null>> => {
      try {
        const { artifact } = sessionArtifact(payload?.sessionId, payload?.artifactId)
        if (!isExportFormat(payload?.format)) throw new Error('不支持的导出格式。')
        const format = payload.format
        const ext = exportExtensionFor(format, artifact)
        const defaultPath = `${safeArtifactBase(artifact.title, artifact.path)}${ext}`
        const options: Electron.SaveDialogOptions = {
          title: format === 'pdf' ? '导出 PDF' : format === 'original' ? '导出成品原文件' : '导出成品',
          defaultPath,
          filters: EXPORT_FILTERS[format]
        }
        const owner = BrowserWindow.fromWebContents(e.sender)
        const result =
          owner && !owner.isDestroyed()
            ? await dialog.showSaveDialog(owner, options)
            : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) return ok(null)
        const target = resolve(result.filePath)

        if (format === 'original') {
          const source = artifact.path ? resolveWorkspacePath(artifact.path, 'file') : null
          if (source) {
            if (source !== target) copyFileSync(source, target)
          } else {
            writeFileSync(target, exportableArtifactText(artifact), 'utf8')
          }
        } else {
          const content = exportableArtifactText(artifact)
          if (format === 'markdown') {
            writeFileSync(target, buildExportMarkdown(artifact, content), 'utf8')
          } else if (format === 'html') {
            writeFileSync(target, buildExportHtml(artifact, content), 'utf8')
          } else if (format === 'text') {
            writeFileSync(target, buildExportText(artifact, content), 'utf8')
          } else {
            const html = buildExportHtml(artifact, content)
            await printHtmlToPdf(artifact.path ? withSourceBase(html, artifact.path) : html, target)
          }
        }
        log.info('artifact exported', { artifactId: artifact.id, format, target })
        return ok(target)
      } catch (err) {
        return fail('ARTIFACT_EXPORT_FAILED', err instanceof Error ? err.message : '导出成品失败')
      }
    }
  )

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

  ipcMain.handle(IPC.researchStart, async (_e, payload: {
    sessionId?: unknown
    plan?: unknown
    depth?: unknown
  } | undefined): Promise<Result<unknown>> => {
    try {
      if (typeof payload?.sessionId !== 'string' || !payload.sessionId.trim()) throw new Error('缺少会话 id。')
      if (typeof payload?.plan !== 'string' || !payload.plan.trim()) throw new Error('研究计划不能为空。')
      if (payload.plan.length > 20_000) throw new Error('研究计划过长（最多 20000 字）。')
      if (payload.depth !== undefined && payload.depth !== 'quick' && payload.depth !== 'standard' && payload.depth !== 'deep') {
        throw new Error('研究深度无效。')
      }
      const result = await agentService().startResearch(
        payload.sessionId,
        {
          plan: payload.plan,
          ...(typeof payload.depth === 'string' ? { depth: payload.depth as 'quick' | 'standard' | 'deep' } : {})
        },
        windowOf()
      )
      return ok(result)
    } catch (err) {
      return fail('RESEARCH_START_FAILED', err instanceof Error ? err.message : '开始研究失败')
    }
  })

  ipcMain.handle(IPC.researchSteer, async (_e, payload: {
    sessionId?: unknown
    text?: unknown
  } | undefined): Promise<Result<unknown>> => {
    try {
      if (typeof payload?.sessionId !== 'string' || !payload.sessionId.trim()) throw new Error('缺少会话 id。')
      if (typeof payload?.text !== 'string' || !payload.text.trim()) throw new Error('补充要求不能为空。')
      if (payload.text.length > 2_000) throw new Error('补充要求过长（最多 2000 字）。')
      return ok(agentService().steerResearch(payload.sessionId, payload.text, windowOf()))
    } catch (err) {
      return fail('RESEARCH_STEER_FAILED', err instanceof Error ? err.message : '追加研究要求失败')
    }
  })

  ipcMain.handle(IPC.chatRegenerate, async (_e, payload: { sessionId: string }): Promise<Result<unknown>> => {
    try {
      return ok(agentService().regenerate(payload.sessionId, windowOf()))
    } catch (err) {
      return fail('REGENERATE_FAILED', err instanceof Error ? err.message : '重新生成失败')
    }
  })

  ipcMain.handle(
    IPC.chatEditResend,
    async (_e, payload: { sessionId: string; messageId: string; text: string }): Promise<Result<unknown>> => {
      try {
        return ok(agentService().editResend(payload.sessionId, payload.messageId, payload.text, windowOf()))
      } catch (err) {
        return fail('EDIT_RESEND_FAILED', err instanceof Error ? err.message : '编辑重发失败')
      }
    }
  )

  ipcMain.handle(
    IPC.chatDeleteAfter,
    (_e, payload: { sessionId: string; messageId: string }): Result<Session> => {
      try {
        const session = agentService().deleteAfter(payload.sessionId, payload.messageId)
        const win = windowOf()
        const base = { seq: 0, runId: 'messages', sessionId: session.id, at: Date.now() }
        win?.webContents.send('morrow:event', { ...base, type: 'messages_replaced', messages: session.messages })
        win?.webContents.send('morrow:event', { ...base, type: 'todos_updated', todos: session.todos })
        win?.webContents.send('morrow:event', { ...base, type: 'artifacts_updated', artifacts: session.artifacts })
        win?.webContents.send('morrow:event', { ...base, type: 'session_updated', meta: deriveMeta(session) })
        return ok(session)
      } catch (err) {
        return fail('DELETE_AFTER_FAILED', err instanceof Error ? err.message : '删除后续消息失败')
      }
    }
  )

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
