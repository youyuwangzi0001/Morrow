/**
 * R10-C：内置浏览器主进程服务（WebContentsView）+ R10-K1：浏览器自动化执行器。
 *
 * 安全基线（审计要求）：
 * - 导航/自动化只允许 http/https；file/javascript/data/blob 等一律拦截；localhost 允许；
 * - 远程页面：sandbox=true、contextIsolation=true、无 Node、无 preload、webviewTag=false、webSecurity=true；
 * - 独立持久 session 分区 `persist:morrow-browser`，与主应用隔离；
 * - 证书错误一律拒绝（app certificate-error 只处理本服务持有的 webContents）；
 * - 摄像头/麦克风/地理位置/通知等权限一律拒绝（permissionRequestHandler/CheckHandler 全 false）；
 * - 下载：先写数据目录暂存区，由可见面板确认（批准→移动到 downloads；拒绝/超时→清理）；
 * - 自动化与用户共用同一个可见 WebContentsView：用户能看到 Agent 的每次导航与操作；
 * - 每次自动化动作走 runId 步数预算（BROWSER_LIMITS.maxActionsPerRun），防无限自循环。
 *
 * 本文件不 import main/index / ipc / preload，避免循环依赖；窗口通过 IPC event.sender 反查。
 */
import { app, BrowserWindow, WebContentsView, session, shell, type Session, type WebContents } from 'electron'
import { copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  BROWSER_LIMITS,
  BROWSER_PARTITION,
  BROWSER_WEB_PREFERENCES,
  checkBrowserUrl,
  isBrowserNavigationAllowed,
  normalizeBrowserAddress,
  sanitizeBrowserBounds,
  type BrowserActionResult,
  type BrowserBounds,
  type BrowserCallContext,
  type BrowserDownloadRequest,
  type BrowserReadResult,
  type BrowserScreenshotResult,
  type BrowserState
} from '../../core/browser-bridge'
import { dataPath } from './paths'
import { log } from './logger'

/** Agent 打开网页时通知渲染层展开浏览器面板 */
export const BROWSER_PRESENT_EVENT = 'feature:browser:present'
/** Agent 关闭浏览器时通知渲染层收起面板 */
export const BROWSER_CLOSED_EVENT = 'feature:browser:closed'

interface SurfaceHandle {
  view: WebContentsView
  owner: BrowserWindow
  visible: boolean
  bounds: BrowserBounds | null
}

interface PendingDownload {
  request: BrowserDownloadRequest
  item: Electron.DownloadItem
  /** 批准前文件只写到 app 数据目录的暂存区，不进入用户下载目录 */
  holdingPath: string
  /** 下载字节是否已写完（用户仍可稍后决定） */
  done: boolean
  /** Electron 的 done 状态：completed / cancelled / interrupted */
  doneState?: string
  /** 用户已批准，等下载写完后再移动 */
  approved: boolean
  timer: NodeJS.Timeout
}

function emptyState(): BrowserState {
  return {
    open: false,
    visible: false,
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
    automationActive: false
  }
}

function safeFilename(name: string): string {
  let base = basename(name || 'download.bin')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .trim()
  // Windows 设备名不能作为文件名
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(base)) base = `_${base}`
  return (base || 'download.bin').slice(0, 160)
}

/** 同名冲突时保留原扩展名，例如 report.pdf → report-1.pdf */
function uniqueDownloadPath(target: string): string {
  if (!existsSync(target)) return target
  const ext = extname(target)
  const stem = target.slice(0, target.length - ext.length)
  for (let index = 1; index <= 1_000; index += 1) {
    const candidate = `${stem}-${index}${ext}`
    if (!existsSync(candidate)) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

function describeTarget(target: string): string {
  return target.length > 80 ? `${target.slice(0, 80)}…` : target
}

/** Windows 上杀毒/索引服务可能短暂占用目标文件，rename 会报 EPERM/EBUSY。 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
      if (attempt === 3) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1))
    }
  }
}

function insideDirectory(root: string, target: string): boolean {
  const normalize = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = normalize(root).replace(/[\\/]+$/, '')
  const candidate = normalize(target)
  return candidate === base || candidate.startsWith(`${base}${sep}`)
}

/** executeJavaScript 可能返回 undefined/不可序列化值：统一转成 JSON 安全结构 */
type LocateResult =
  | { ok: true; x: number; y: number; tag: string; label: string; locatorId: string }
  | { ok: false; reason: string }

type ReadPageResult = { url: string; title: string; text: string }

export class BrowserService {
  private static instance: BrowserService | null = null

  private initialized = false
  private surface: SurfaceHandle | null = null
  private state: BrowserState = emptyState()
  private pendingDownloads = new Map<string, PendingDownload>()
  private actionCounts = new Map<string, number>()
  private ownsWebContents = new Set<number>()
  private automationTimer: NodeJS.Timeout | null = null

  static getInstance(): BrowserService {
    if (!BrowserService.instance) BrowserService.instance = new BrowserService()
    return BrowserService.instance
  }

  /* ── 初始化 ─────────────────────────────────────────────────── */

  initialize(): void {
    if (this.initialized) return
    this.initialized = true

    const browserSession = this.browserSession()
    // 权限：摄像头/麦克风/地理位置/通知/剪贴板/全屏等一律拒绝
    browserSession.setPermissionRequestHandler((webContents, permission, callback) => {
      log.warn('browser permission denied', { permission, url: webContents?.getURL?.() ?? '' })
      callback(false)
    })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.on('will-download', (event, item, webContents) => {
      this.handleDownload(event, item, webContents)
    })

    // 证书错误：只处理本服务持有的 webContents，明确拒绝（保护其余窗口默认行为）
    app.on('certificate-error', (event, webContents, url, error, _certificate, callback) => {
      if (!this.ownsWebContents.has(webContents.id)) return
      event.preventDefault()
      callback(false)
      log.warn('browser certificate error rejected', { url, error })
      if (this.surface?.view.webContents.id === webContents.id) {
        this.reportError({ code: `CERT_${error}`, message: `证书错误，已拒绝连接：${url}` })
      }
    })

    app.on('before-quit', () => {
      try {
        this.shutdown()
      } catch (err) {
        log.warn('browser shutdown error', String(err))
      }
    })

    // Chromium 需要可写的 downloads 目录才能完成下载（受限令牌下默认用户 Downloads 可能不可写，
    // 实测会导致 download 在 0 字节处 interrupted）。把应用级 downloads 指到数据目录。
    try {
      const downloadsDir = dataPath('downloads')
      mkdirSync(downloadsDir, { recursive: true })
      app.setPath('downloads', downloadsDir)
    } catch (err) {
      log.warn('browser downloads path setup failed', String(err))
    }

    // E2E/测试模式提供只读入口（不暴露给生产渲染进程）：用于 Playwright 断言真实浏览器窗口
    if (process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')) {
      ;(globalThis as typeof globalThis & { __morrowBrowserService?: BrowserService }).__morrowBrowserService = this
    }
    log.info('browser service initialized', { partition: BROWSER_PARTITION })
  }

  private browserSession(): Session {
    return session.fromPartition(BROWSER_PARTITION)
  }

  private shutdown(): void {
    for (const pending of this.pendingDownloads.values()) {
      clearTimeout(pending.timer)
      if (!pending.done) {
        try {
          pending.item.cancel()
        } catch {
          // 忽略
        }
      }
      try {
        rmSync(pending.holdingPath, { force: true })
      } catch {
        // 忽略
      }
    }
    this.pendingDownloads.clear()
    this.closeSurface()
  }

  /* ── UI surface ─────────────────────────────────────────────── */

  /**
   * 主进程全局安全策略（main/index.ts 的 app.on('web-contents-created')）会拦截所有
   * 非 file:// 导航并调用 shell.openExternal —— 对普通窗口正确，但会让内置浏览器
   * 点击链接变成「在系统浏览器打开」。浏览器的 webContents 必须换成本服务更严格的策略
   * （只允许 http/https，且禁止外部拉起），因此创建后先清掉全局 will-navigate 监听，
   * 再由 attachNavigationGuards 安装自己的守卫。
   * 注意：只对本服务创建的 webContents 生效，不影响主窗口。
   */
  private adoptOwnNavigationPolicy(webContents: WebContents): void {
    try {
      webContents.removeAllListeners('will-navigate')
    } catch (err) {
      log.warn('browser detach global will-navigate failed', String(err))
    }
  }

  private createView(owner: BrowserWindow): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        ...BROWSER_WEB_PREFERENCES,
        // 注意：不设置 preload —— 远程页面拿不到任何 Morrow 能力
        preload: undefined
      }
    })
    this.adoptOwnNavigationPolicy(view.webContents)
    view.setBackgroundColor('#0b0d10')
    const webContentsId = view.webContents.id
    this.ownsWebContents.add(webContentsId)
    view.webContents.on('destroyed', () => this.ownsWebContents.delete(webContentsId))
    this.attachNavigationGuards(view.webContents)
    owner.contentView.addChildView(view)
    return view
  }

  private attachNavigationGuards(webContents: WebContents): void {
    // 自动化与用户共用同一个 surface：加载/错误都写入同一个面板状态
    const isSurface = (): boolean => this.surface?.view.webContents.id === webContents.id
    const blocked = (url: string, kind: string): void => {
      log.warn('browser navigation blocked', { url, kind })
      if (!isSurface()) return
      this.reportError({
        code: 'NAVIGATION_BLOCKED',
        message: `已拦截不允许的导航：${url.slice(0, 200)}（只允许 http/https 网页）。`
      })
    }
    webContents.on('will-navigate', (event, url) => {
      if (!isBrowserNavigationAllowed(url)) {
        event.preventDefault()
        blocked(url, 'will-navigate')
      }
    })
    webContents.on('will-redirect', (event, url) => {
      if (!isBrowserNavigationAllowed(url)) {
        event.preventDefault()
        blocked(url, 'will-redirect')
      }
    })
    webContents.setWindowOpenHandler(({ url }) => {
      // 不新增窗口（避免绕过 surface 安全边界），但 http/https 弹窗/新标签改为当前视图导航：
      // 真实网站大量使用 target="_blank"，一律拒绝会让用户觉得「点了没反应」。
      if (isBrowserNavigationAllowed(url)) {
        setTimeout(() => {
          if (webContents.isDestroyed()) return
          void webContents.loadURL(url).catch((err: Error) => {
            log.warn('browser popup navigation failed', { url: url.slice(0, 200), error: String(err) })
            if (isSurface()) this.reportError({ code: 'LOAD_FAILED', message: `页面加载失败：${err.message}` })
          })
        }, 0)
        return { action: 'deny' }
      }
      // 非 http/https 弹窗只记录日志，不能把整页隐藏成错误页（广告/统计脚本常发这类请求）
      log.warn('browser popup blocked', { url: url.slice(0, 200) })
      return { action: 'deny' }
    })
    webContents.on('will-attach-webview', (event) => event.preventDefault())
    webContents.on('did-start-loading', () => {
      // 新的导航尝试意味着从上一个错误页恢复：清掉错误并重新显示视图
      if (isSurface()) {
        this.updateState({ loading: true, error: null, visible: this.surface?.visible ?? false })
      }
    })
    webContents.on('did-stop-loading', () => {
      if (!isSurface()) return
      this.updateState({ loading: false })
      this.refreshStateFrom(webContents)
    })
    webContents.on('did-navigate', () => this.refreshStateFrom(webContents))
    webContents.on('did-navigate-in-page', () => this.refreshStateFrom(webContents))
    webContents.on('page-title-updated', () => this.refreshStateFrom(webContents))
    webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isSurface() || !isMainFrame || errorCode === -3 /* ABORTED */) return
      this.updateState({
        loading: false,
        error: { code: String(errorCode), message: `页面加载失败：${errorDescription || '未知错误'}（${validatedURL.slice(0, 160)}）` }
      })
    })
  }

  getState(): BrowserState {
    if (!this.surface) return { ...emptyState() }
    return { ...this.state }
  }

  private updateState(patch: Partial<BrowserState>): void {
    this.state = { ...this.state, ...patch }
    if (patch.error) this.state.visible = false
    this.emitToOwner('feature:browser:state', this.getState())
    this.applySurfaceVisibility()
  }

  /**
   * Electron 44 在部分真实站点（尤其导航经过服务器重定向）后 `canGoBack()` 会误报 false，
   * 但历史条目与活动索引是正确的。这里按索引自行判断，避免后退按钮失效。
   */
  private historyState(webContents: WebContents): { canGoBack: boolean; canGoForward: boolean } {
    try {
      const nav = webContents.navigationHistory
      const index = nav.getActiveIndex()
      const length = nav.length()
      return {
        canGoBack: index > 0,
        canGoForward: index >= 0 && index < length - 1
      }
    } catch {
      return { canGoBack: false, canGoForward: false }
    }
  }

  private refreshStateFrom(webContents: WebContents): void {
    if (!this.surface || webContents.id !== this.surface.view.webContents.id) return
    const history = this.historyState(webContents)
    this.state = {
      ...this.state,
      open: true,
      url: webContents.getURL(),
      title: webContents.getTitle(),
      loading: webContents.isLoading(),
      ...history
    }
    this.emitToOwner('feature:browser:state', this.getState())
  }

  private emitToOwner(channel: string, payload: unknown): void {
    const owner = this.surface?.owner
    if (!owner || owner.isDestroyed()) return
    owner.webContents.send(channel, payload)
  }

  private ownerFromEvent(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
    return BrowserWindow.fromWebContents(event.sender)
  }

  /**
   * Agent 没有 IPC event：优先主窗口，而不是当前聚焦的任意窗口。
   * 灵动岛是 356/396px 宽、置顶的小窗口；不能把网页嵌到它里面。
   */
  private ownerWindow(): BrowserWindow | null {
    const mainSized = (window: BrowserWindow): boolean => {
      if (window.isDestroyed()) return false
      const bounds = window.getContentBounds()
      return bounds.width >= 800 && bounds.height >= 600
    }
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && mainSized(focused)) return focused
    const mainWindows = BrowserWindow.getAllWindows().filter(mainSized)
    if (mainWindows.length > 0) return mainWindows[0]
    if (focused && !focused.isDestroyed()) return focused
    return BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null
  }

  /** Agent 正在操作页面：状态里短暂标记，UI 显示「Morrow 操作中」。 */
  private markAutomation(): void {
    if (this.automationTimer) clearTimeout(this.automationTimer)
    this.state = { ...this.state, automationActive: true }
    this.emitToOwner('feature:browser:state', this.getState())
    this.automationTimer = setTimeout(() => {
      this.automationTimer = null
      if (!this.state.automationActive) return
      this.state = { ...this.state, automationActive: false }
      this.emitToOwner('feature:browser:state', this.getState())
    }, 4_000)
    this.automationTimer.unref?.()
  }

  private clearAutomationIndicator(): void {
    if (this.automationTimer) {
      clearTimeout(this.automationTimer)
      this.automationTimer = null
    }
    if (!this.state.automationActive) return
    this.state = { ...this.state, automationActive: false }
    this.emitToOwner('feature:browser:state', this.getState())
  }

  /** Agent 第一次操作时创建可见视图，并通知渲染层打开浏览器面板。 */
  private ensureSurfaceForAutomation(): SurfaceHandle {
    const existing = this.surface
    if (existing && !existing.owner.isDestroyed()) {
      if (!existing.visible) {
        existing.visible = true
        this.state = { ...this.state, visible: true, error: null }
        this.applySurfaceVisibility()
        this.emitToOwner('feature:browser:state', this.getState())
      }
      this.emitToOwner(BROWSER_PRESENT_EVENT, { source: 'agent' })
      return existing
    }
    if (existing) this.closeSurface()

    const owner = this.ownerWindow()
    if (!owner) throw new Error('找不到 Morrow 主窗口，无法打开内置浏览器。')
    const view = this.createView(owner)
    const handle: SurfaceHandle = { view, owner, visible: true, bounds: null }
    this.surface = handle
    this.state = { ...emptyState(), open: true, visible: true }
    owner.on('resize', this.onOwnerResize)
    owner.on('enter-full-screen', this.onOwnerResize)
    owner.on('leave-full-screen', this.onOwnerResize)
    this.emitToOwner(BROWSER_PRESENT_EVENT, { source: 'agent' })
    this.emitToOwner('feature:browser:state', this.getState())
    log.info('browser surface created for automation')
    return handle
  }

  private requireSurface(): SurfaceHandle {
    const surface = this.surface
    if (!surface || surface.owner.isDestroyed()) {
      throw new Error('浏览器还没有打开。请先使用 browser_open 打开一个网页。')
    }
    return surface
  }

  /** 等渲染层把面板 bounds 同步过来，避免 Agent 操作时用户还看不到页面。 */
  private async waitForSurfaceShown(timeoutMs = 1_500): Promise<void> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (this.surface?.bounds) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  /** feature:browser:open { url, bounds? } */
  openSurface(url: string, event: Electron.IpcMainInvokeEvent, bounds?: unknown): BrowserState {
    const check = normalizeBrowserAddress(url)
    if (!check.allowed || !check.url) throw new Error(check.reason ?? '网址无效。')
    const owner = this.ownerFromEvent(event) ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!owner) throw new Error('找不到主窗口，无法打开内置浏览器。')

    // 已存在且属于同一窗口：直接导航
    if (this.surface && this.surface.owner.id === owner.id) {
      this.clearAutomationIndicator()
      this.state = {
        ...this.state,
        open: true,
        error: null,
        url: check.url,
        loading: true,
        visible: this.surface.visible
      }
      this.updateState({ visible: this.surface.visible })
      void this.surface.view.webContents.loadURL(check.url).catch((err: Error) => {
        this.reportError({ code: 'LOAD_FAILED', message: `页面加载失败：${err.message}` })
      })
      return this.getState()
    }
    this.closeSurface()

    const view = this.createView(owner)
    const handle: SurfaceHandle = {
      view,
      owner,
      visible: true,
      bounds: sanitizeBrowserBounds(bounds) ?? null
    }
    this.surface = handle
    this.state = {
      ...emptyState(),
      open: true,
      url: check.url,
      loading: true,
      visible: true,
      automationActive: false
    }
    if (handle.bounds) view.setBounds(handle.bounds)
    view.setVisible(handle.bounds !== null)
    owner.on('resize', this.onOwnerResize)
    owner.on('enter-full-screen', this.onOwnerResize)
    owner.on('leave-full-screen', this.onOwnerResize)
    void view.webContents.loadURL(check.url).catch((err: Error) => {
      this.reportError({ code: 'LOAD_FAILED', message: `页面加载失败：${err.message}` })
    })
    log.info('browser surface opened', { url: check.url })
    return this.getState()
  }

  private onOwnerResize = (): void => {
    const surface = this.surface
    if (!surface) return
    if (surface.bounds) this.setBounds(surface.bounds)
  }

  /** feature:browser:set-bounds { x,y,width,height } */
  setBounds(rawBounds: unknown): BrowserBounds | null {
    const surface = this.surface
    if (!surface) return null
    const sanitized = sanitizeBrowserBounds(rawBounds)
    if (!sanitized) return null
    const owner = surface.owner
    const content = owner.isDestroyed() ? null : owner.getContentBounds()
    const maxWidth = content?.width ?? sanitized.width
    const maxHeight = content?.height ?? sanitized.height
    const x = Math.max(0, Math.min(sanitized.x, Math.max(0, maxWidth - 1)))
    const y = Math.max(0, Math.min(sanitized.y, Math.max(0, maxHeight - 1)))
    const width = Math.max(1, Math.min(sanitized.width, maxWidth - x))
    const height = Math.max(1, Math.min(sanitized.height, maxHeight - y))
    const bounds: BrowserBounds = { x, y, width, height }
    surface.bounds = bounds
    if (!surface.view.webContents.isDestroyed()) surface.view.setBounds(bounds)
    this.applySurfaceVisibility()
    return bounds
  }

  setVisible(visible: boolean): void {
    if (!this.surface) return
    this.surface.visible = visible
    // 有致命错误时由渲染层错误页承载，原生视图保持隐藏
    this.state = { ...this.state, visible: visible && !this.state.error }
    this.applySurfaceVisibility()
    this.emitToOwner('feature:browser:state', this.getState())
  }

  private applySurfaceVisibility(): void {
    const surface = this.surface
    if (!surface || surface.view.webContents.isDestroyed()) return
    // 视图必须等 bounds 到位且面板可见、且没有致命错误时才显示（错误由渲染层错误页承载）
    const show = surface.visible && surface.bounds !== null && !this.state.error
    surface.view.setVisible(show)
  }

  navigate(url: string): BrowserState {
    if (!this.surface) throw new Error('浏览器未打开。')
    this.clearAutomationIndicator()
    const check = normalizeBrowserAddress(url)
    if (!check.allowed || !check.url) throw new Error(check.reason ?? '网址无效。')
    this.state = { ...this.state, error: null, url: check.url, loading: true, visible: this.surface.visible }
    this.updateState({ error: null, loading: true, visible: this.surface.visible })
    void this.surface.view.webContents.loadURL(check.url).catch((err: Error) => {
      this.reportError({ code: 'LOAD_FAILED', message: `页面加载失败：${err.message}` })
    })
    return this.getState()
  }

  back(): BrowserState {
    return this.goHistory('back')
  }

  forward(): BrowserState {
    return this.goHistory('forward')
  }

  private goHistory(direction: 'back' | 'forward'): BrowserState {
    const surface = this.surface
    if (!surface) throw new Error('浏览器未打开。')
    this.clearAutomationIndicator()
    const nav = surface.view.webContents.navigationHistory
    const index = nav.getActiveIndex()
    const target = direction === 'back' ? index - 1 : index + 1
    if (index < 0 || target < 0) throw new Error('已经到第一页，无法后退。')
    if (target >= nav.length()) throw new Error('已经在最后一页，无法前进。')
    nav.goToIndex(target)
    setTimeout(() => this.refreshStateFrom(surface.view.webContents), 300)
    return this.getState()
  }

  reload(): BrowserState {
    if (!this.surface) throw new Error('浏览器未打开。')
    this.clearAutomationIndicator()
    this.surface.view.webContents.reload()
    this.updateState({ loading: true, error: null, visible: this.surface.visible })
    return this.getState()
  }

  stop(): BrowserState {
    if (!this.surface) throw new Error('浏览器未打开。')
    this.surface.view.webContents.stop()
    this.updateState({ loading: false })
    return this.getState()
  }

  closeSurface(): void {
    if (this.automationTimer) {
      clearTimeout(this.automationTimer)
      this.automationTimer = null
    }
    const surface = this.surface
    if (!surface) {
      this.state = emptyState()
      return
    }
    // 已批准的下载继续完成；未确认的请求随面板关闭取消，避免留下孤儿暂存文件
    for (const pending of [...this.pendingDownloads.values()]) {
      if (!pending.approved) this.cancelDownload(pending, '浏览器面板已关闭，未确认的下载已取消。')
    }
    this.surface = null
    this.state = emptyState()
    const view = surface.view
    try {
      surface.owner.removeListener('resize', this.onOwnerResize)
      surface.owner.removeListener('enter-full-screen', this.onOwnerResize)
      surface.owner.removeListener('leave-full-screen', this.onOwnerResize)
      // 关键：removeChildView / webContents.close 在 IPC handler 内同步调用会阻塞（实测卡住
      // handler 与 app.quit）。先隐藏 view，再在下一轮事件循环做真正的移除与销毁。
      try {
        view.setVisible(false)
      } catch {
        // 忽略
      }
      setImmediate(() => {
        try {
          if (!surface.owner.isDestroyed()) surface.owner.contentView.removeChildView(view)
          if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
        } catch (err) {
          log.warn('browser surface dispose error', String(err))
        }
      })
    } catch (err) {
      log.warn('browser surface close error', String(err))
    }
    if (!surface.owner.isDestroyed()) surface.owner.webContents.send('feature:browser:state', this.getState())
    log.info('browser surface closed')
  }

  private reportError(error: { code: string; message: string }): void {
    if (!this.surface) return
    this.updateState({ error })
  }

  /* ── 下载确认 ───────────────────────────────────────────────── */

  private handleDownload(event: Electron.Event, item: Electron.DownloadItem, webContents: WebContents): void {
    const surface = this.surface
    if (!surface || surface.owner.isDestroyed() || webContents?.id !== surface.view.webContents.id) {
      // 只有用户看得见的内置浏览器才能发起下载，其它 webContents 不允许静默下载
      event.preventDefault()
      log.warn('browser download rejected (no surface)', { filename: item.getFilename(), url: item.getURL().slice(0, 200) })
      return
    }

    // 初次请求：先写进 app 数据目录的暂存区（不是用户下载目录），渲染层确认后再移动。
    // 不调用 preventDefault/pause —— 实测 pause() 在 Electron 44 下状态不可靠、downloadURL 重发会卡住；
    // 暂存 + 批准后移动是确定性的，也不会在用户下载目录出现未确认文件。
    const downloadsDir = dataPath('downloads')
    mkdirSync(downloadsDir, { recursive: true })
    const filename = safeFilename(item.getFilename())
    const request: BrowserDownloadRequest = {
      id: `download-${randomUUID().slice(0, 8)}`,
      filename,
      url: item.getURL().slice(0, 500),
      suggestedPath: join(downloadsDir, filename),
      totalBytes: item.getTotalBytes(),
      createdAt: Date.now()
    }
    const holdingDir = dataPath('tmp', 'browser-downloads')
    mkdirSync(holdingDir, { recursive: true })
    const holdingPath = join(holdingDir, `${request.id}-${filename}`)
    try {
      item.setSavePath(holdingPath)
    } catch (err) {
      log.warn('browser download setSavePath failed', String(err))
      event.preventDefault()
      return
    }
    const timer = setTimeout(() => this.expireDownload(request.id), 60_000)
    const pending: PendingDownload = { request, item, holdingPath, done: false, approved: false, timer }
    this.pendingDownloads.set(request.id, pending)
    item.on('done', (_doneEvent, state) => {
      pending.done = true
      pending.doneState = state
      log.info('browser download done', { id: request.id, state, bytes: item.getReceivedBytes(), holdingPath })
      if (state !== 'completed') {
        const active = this.pendingDownloads.get(request.id) === pending
        if (active) {
          this.pendingDownloads.delete(request.id)
          clearTimeout(pending.timer)
          this.emitToOwner('feature:browser:download-resolved', {
            id: request.id,
            filename: request.filename,
            allow: false,
            error: `下载未完成（${state}），文件已清理。`
          })
        }
        this.cleanupHolding(pending)
        return
      }
      if (pending.approved) this.finalizeDownload(pending)
    })
    this.emitToOwner('feature:browser:download', request)
    log.info('browser download requested', { id: request.id, filename, totalBytes: request.totalBytes, holdingPath })
  }

  private cleanupHolding(pending: PendingDownload): void {
    try {
      rmSync(pending.holdingPath, { force: true })
    } catch {
      // 忽略
    }
  }

  /** 下载被取消/拒绝/超时后，等文件句柄释放再清理暂存文件 */
  private removeHoldingWhenDone(pending: PendingDownload): void {
    if (pending.done) {
      this.cleanupHolding(pending)
      return
    }
    const cleanup = (): void => this.cleanupHolding(pending)
    pending.item.once('done', cleanup)
    setTimeout(cleanup, 5_000)
  }

  private cancelDownload(pending: PendingDownload, message?: string): void {
    if (this.pendingDownloads.get(pending.request.id) === pending) {
      this.pendingDownloads.delete(pending.request.id)
    }
    clearTimeout(pending.timer)
    if (!pending.done) {
      try {
        pending.item.cancel()
      } catch {
        // 忽略
      }
    }
    this.removeHoldingWhenDone(pending)
    this.emitToOwner('feature:browser:download-resolved', {
      id: pending.request.id,
      filename: pending.request.filename,
      allow: false,
      ...(message ? { error: message } : {})
    })
  }

  private expireDownload(id: string): void {
    const pending = this.pendingDownloads.get(id)
    if (!pending || pending.approved) return
    this.cancelDownload(pending, '下载确认超时，已取消。')
    log.info('browser download request expired (temp removed)', { id, filename: pending.request.filename })
  }

  /** 已批准但长时间收不到 done（异常网络/服务端不停重试）时的兜底 */
  private expireApprovedDownload(id: string): void {
    const pending = this.pendingDownloads.get(id)
    if (!pending || pending.done) return
    this.pendingDownloads.delete(id)
    clearTimeout(pending.timer)
    try {
      pending.item.cancel()
    } catch {
      // 忽略
    }
    this.removeHoldingWhenDone(pending)
    this.emitToOwner('feature:browser:download-resolved', {
      id,
      filename: pending.request.filename,
      allow: false,
      error: '下载长时间未完成，已取消并清理暂存文件。'
    })
    log.info('browser approved download expired (temp removed)', { id, filename: pending.request.filename })
  }

  /** 批准后把暂存文件移动到用户下载目录（同名冲突时保留扩展名） */
  private finalizeDownload(pending: PendingDownload): void {
    if (!this.pendingDownloads.delete(pending.request.id)) return
    clearTimeout(pending.timer)
    if (pending.doneState !== 'completed') {
      this.cleanupHolding(pending)
      this.emitToOwner('feature:browser:download-resolved', {
        id: pending.request.id,
        filename: pending.request.filename,
        allow: false,
        error: '下载未完成，文件已清理。'
      })
      return
    }
    const target = uniqueDownloadPath(pending.request.suggestedPath)
    try {
      mkdirSync(dirname(target), { recursive: true })
      try {
        renameWithRetry(pending.holdingPath, target)
      } catch {
        copyFileSync(pending.holdingPath, target)
        rmSync(pending.holdingPath, { force: true })
      }
      log.info('browser download saved', { id: pending.request.id, path: target })
      this.emitToOwner('feature:browser:download-resolved', {
        id: pending.request.id,
        filename: pending.request.filename,
        allow: true,
        path: target
      })
    } catch (err) {
      log.warn('browser download move failed', String(err))
      this.cleanupHolding(pending)
      this.emitToOwner('feature:browser:download-resolved', {
        id: pending.request.id,
        filename: pending.request.filename,
        allow: false,
        error: String(err)
      })
    }
  }

  /** 在资源管理器中定位已批准的下载；只允许 app 数据目录的 downloads 内真实文件 */
  revealDownload(rawPath: string): void {
    const target = resolve(rawPath)
    let realTarget: string
    try {
      realTarget = realpathSync(target)
    } catch {
      throw new Error('文件已被移动或删除，无法定位。')
    }
    const downloadsDir = dataPath('downloads')
    let realDownloads = downloadsDir
    try {
      realDownloads = realpathSync(downloadsDir)
    } catch {
      // 目录可能尚未创建：保持原路径，下面的前缀检查会失败并给出明确错误
    }
    if (!insideDirectory(realDownloads, realTarget)) {
      throw new Error('只能定位内置浏览器下载目录里的文件。')
    }
    try {
      if (!statSync(realTarget).isFile()) throw new Error('not a file')
    } catch {
      throw new Error('这个路径不是可定位的文件。')
    }
    shell.showItemInFolder(realTarget)
  }

  decideDownload(id: string, allow: boolean): void {
    const pending = this.pendingDownloads.get(id)
    if (!pending) throw new Error('下载请求不存在或已处理。')
    if (allow) {
      // 用户批准后不再受 60 秒确认窗口限制，但保留一个长时间兜底，避免异常连接永远挂起
      clearTimeout(pending.timer)
      pending.approved = true
      if (!pending.done) {
        pending.timer = setTimeout(() => this.expireApprovedDownload(id), 10 * 60_000)
        this.emitToOwner('feature:browser:download-resolved', {
          id,
          filename: pending.request.filename,
          allow: true,
          pending: true
        })
        log.info('browser download approved (waiting for bytes)', { id })
        return
      }
      this.finalizeDownload(pending)
      return
    }
    this.cancelDownload(pending)
    log.info('browser download denied + temp removed', { id })
  }

  /* ── K1 自动化：统一操作用户可见的 surface ──────────────── */

  private checkActionBudget(runId: string): void {
    const next = (this.actionCounts.get(runId) ?? 0) + 1
    if (next > BROWSER_LIMITS.maxActionsPerRun) {
      throw new Error(`本轮浏览器自动化已达到步数上限（${BROWSER_LIMITS.maxActionsPerRun} 次），请结束当前任务或重新发起。`)
    }
    this.actionCounts.set(runId, next)
    if (this.actionCounts.size > 200) {
      const key = this.actionCounts.keys().next().value
      if (key) this.actionCounts.delete(key)
    }
  }

  private stateOf(webContents: WebContents): BrowserState {
    const history = this.historyState(webContents)
    return {
      open: true,
      visible: this.surface?.visible ?? false,
      url: webContents.getURL(),
      title: webContents.getTitle(),
      loading: webContents.isLoading(),
      ...history,
      error: this.state.error ?? null,
      automationActive: this.state.automationActive
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}超时（${timeoutMs}ms）。`)), timeoutMs)
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (err) => {
          clearTimeout(timer)
          reject(err)
        }
      )
    })
  }

  /** 执行页面脚本（带超时与错误归一化） */
  private async execute<T>(webContents: WebContents, script: string, timeoutMs: number, label: string): Promise<T> {
    try {
      return (await this.withTimeout(webContents.executeJavaScript(script, true), timeoutMs, label)) as T
    } catch (err) {
      throw new Error(`${label}失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 在页面里定位元素：先按 CSS selector，找不到再按可见文本/placeholder/aria-label */
  private async locateElement(webContents: WebContents, target: string, timeoutMs: number): Promise<LocateResult> {
    const payload = JSON.stringify(target)
    // 用一次性标记把「定位到的元素」交给后续点击/输入，避免二次查询选中别的元素
    const locatorId = `morrow-${randomUUID()}`
    const script = `(async () => {
      const target = ${payload};
      const locatorId = ${JSON.stringify(locatorId)};
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const center = async (el) => {
        // 页面可能设置了 scroll-behavior: smooth；强制 instant 等一帧再取坐标，避免点到旧位置
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      };
      const describe = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.tagName || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      let el = null;
      let selectorError = null;
      try {
        el = document.querySelector(target);
      } catch (err) {
        selectorError = String(err && err.message ? err.message : err);
      }
      if (!el) {
        const clickable = ${JSON.stringify(BROWSER_LIMITS.clickableSelector)} + ',input,textarea,select,[contenteditable="true"]';
        const candidates = Array.from(document.querySelectorAll(clickable));
        const exact = candidates.find((candidate) => visible(candidate) && describe(candidate) === target);
        const fuzzy = candidates.find((candidate) => visible(candidate) && describe(candidate).includes(target));
        const byAttr = candidates.find((candidate) => visible(candidate) && (
          (candidate.getAttribute('placeholder') || '').includes(target) ||
          (candidate.getAttribute('aria-label') || '').includes(target) ||
          (candidate.getAttribute('name') || '').includes(target) ||
          (candidate.labels && Array.from(candidate.labels).some((label) => (label.innerText || '').includes(target)))
        ));
        el = exact || fuzzy || byAttr || null;
      }
      if (!el) return { ok: false, reason: selectorError ? ('CSS selector 无效：' + selectorError + '；也没有找到可见文本匹配的元素') : '没有找到匹配的可见元素' };
      if (!visible(el)) return { ok: false, reason: '元素存在但不可见' };
      if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') return { ok: false, reason: '元素处于禁用状态，暂时不能操作' };
      el.setAttribute('data-morrow-locator', locatorId);
      const point = await center(el);
      return { ok: true, x: point.x, y: point.y, tag: el.tagName, label: describe(el), locatorId };
    })()`
    const result = await this.execute<LocateResult>(webContents, script, timeoutMs, '定位网页元素')
    if (!result || typeof result !== 'object') return { ok: false, reason: '定位结果无效' }
    return result
  }

  private clearLocator(webContents: WebContents, locatorId: string): void {
    try {
      webContents
        .executeJavaScript(`document.querySelector('[data-morrow-locator="${locatorId}"]')?.removeAttribute('data-morrow-locator')`)
        .catch(() => undefined)
    } catch {
      // 页面可能正在导航
    }
  }

  private async waitForLoad(webContents: WebContents, timeoutMs: number): Promise<void> {
    if (!webContents.isLoading()) return
    let cleanup = (): void => undefined
    try {
      await this.withTimeout(
        new Promise<void>((resolve) => {
          const onStop = (): void => {
            cleanup()
            resolve()
          }
          cleanup = (): void => {
            webContents.removeListener('did-stop-loading', onStop)
            webContents.removeListener('did-fail-load', onStop)
          }
          webContents.once('did-stop-loading', onStop)
          webContents.once('did-fail-load', onStop)
        }),
        timeoutMs,
        '等待页面加载'
      )
    } finally {
      // 超时也要摘掉监听，避免每次失败都在页面对象上积累监听器
      cleanup()
    }
  }

  /* ── Bridge 实现 ────────────────────────────────────────────── */

  /** 每个非 open 动作都复用同一个可见 surface；未打开时给出可操作错误。 */
  private async automationSurface(): Promise<SurfaceHandle> {
    const surface = this.requireSurface()
    this.markAutomation()
    await this.waitForSurfaceShown()
    return surface
  }

  async automationOpen(url: string, ctx: BrowserCallContext): Promise<BrowserState> {
    this.checkActionBudget(ctx.runId)
    const check = checkBrowserUrl(url)
    if (!check.allowed || !check.url) throw new Error(check.reason ?? '网址无效。')
    const surface = this.ensureSurfaceForAutomation()
    this.markAutomation()
    await this.waitForSurfaceShown()
    const webContents = surface.view.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.openTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    try {
      await this.withTimeout(webContents.loadURL(check.url), timeoutMs, '打开网页')
    } catch (err) {
      try {
        webContents.stop()
      } catch {
        // 忽略
      }
      this.reportError({
        code: 'LOAD_FAILED',
        message: `页面加载失败：${err instanceof Error ? err.message : String(err)}`
      })
      throw new Error(`打开网页失败：${err instanceof Error ? err.message : String(err)}`)
    }
    return this.stateOf(webContents)
  }

  async automationClick(target: string, ctx: BrowserCallContext): Promise<BrowserActionResult> {
    this.checkActionBudget(ctx.runId)
    const surface = await this.automationSurface()
    const webContents = surface.view.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    const located = await this.locateElement(webContents, target, timeoutMs)
    if (!located.ok) throw new Error(located.reason)
    const navigationStarted = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        webContents.removeListener('did-start-navigation', onStart)
        resolve(false)
      }, 800)
      const onStart = (): void => {
        clearTimeout(timer)
        webContents.removeListener('did-start-navigation', onStart)
        resolve(true)
      }
      webContents.once('did-start-navigation', onStart)
    })
    webContents.sendInputEvent({ type: 'mouseDown', x: located.x, y: located.y, button: 'left', clickCount: 1 })
    webContents.sendInputEvent({ type: 'mouseUp', x: located.x, y: located.y, button: 'left', clickCount: 1 })
    const navigating = await navigationStarted
    if (navigating) await this.waitForLoad(webContents, BROWSER_LIMITS.actionTimeoutMs).catch(() => undefined)
    else await new Promise((resolve) => setTimeout(resolve, 150))
    this.clearLocator(webContents, located.locatorId)
    return {
      url: webContents.getURL(),
      title: webContents.getTitle(),
      target: `<${located.tag.toLowerCase()}> ${located.label}`.trim(),
      x: located.x,
      y: located.y,
      navigating
    }
  }

  async automationType(
    target: string,
    text: string,
    ctx: BrowserCallContext & { submit?: boolean }
  ): Promise<BrowserActionResult> {
    this.checkActionBudget(ctx.runId)
    const surface = await this.automationSurface()
    const webContents = surface.view.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    const located = await this.locateElement(webContents, target, timeoutMs)
    if (!located.ok) throw new Error(located.reason)
    // 聚焦「刚才定位到的那个元素」并全选，避免按 target 二次查询时选中别的输入框
    const locatorId = located.locatorId
    const focused = await this.execute<{ ok: boolean; reason?: string }>(
      webContents,
      `(() => {
        const el = document.querySelector('[data-morrow-locator="${locatorId}"]');
        if (!el) return { ok: false, reason: '元素已从页面移除，请重新定位' };
        if (el.tagName === 'SELECT') {
          el.removeAttribute('data-morrow-locator');
          return { ok: false, reason: '下拉框不能直接输入文字，请用 browser_click 选择选项' };
        }
        if (el.tagName === 'INPUT') {
          const type = (el.type || 'text').toLowerCase();
          if (['checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit', 'reset', 'image', 'hidden'].includes(type)) {
            el.removeAttribute('data-morrow-locator');
            return { ok: false, reason: '这个输入类型（' + type + '）不支持文字输入' };
          }
        }
        el.focus();
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.select();
        } else if (el.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const selection = window.getSelection();
          if (selection) {
            selection.removeAllRanges();
            selection.addRange(range);
          }
        }
        el.removeAttribute('data-morrow-locator');
        const active = document.activeElement;
        return { ok: active === el || (active && el.contains(active)) };
      })()`,
      timeoutMs,
      '聚焦输入框'
    )
    if (!focused?.ok) throw new Error(focused?.reason ?? '无法聚焦输入框')
    webContents.insertText(text)
    let submitted = false
    if (ctx.submit) {
      const entered = await this.execute<boolean>(
        webContents,
        `(() => {
          const el = document.activeElement;
          if (el && el.form && typeof el.form.requestSubmit === 'function') { el.form.requestSubmit(); return true; }
          if (el && el.form && typeof el.form.submit === 'function') { el.form.submit(); return true; }
          if (el) {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
            return true;
          }
          return false;
        })()`,
        timeoutMs,
        '提交表单'
      )
      submitted = entered === true
      await new Promise((resolve) => setTimeout(resolve, 350))
    }
    return {
      url: webContents.getURL(),
      title: webContents.getTitle(),
      target: `<${located.tag.toLowerCase()}> ${located.label}${submitted ? '（已提交）' : ''}`.trim()
    }
  }

  async automationRead(ctx: BrowserCallContext & { maxChars?: number }): Promise<BrowserReadResult> {
    this.checkActionBudget(ctx.runId)
    const surface = await this.automationSurface()
    const webContents = surface.view.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    const maxChars = Math.max(200, Math.min(ctx.maxChars ?? BROWSER_LIMITS.maxReadChars, BROWSER_LIMITS.maxReadChars))
    await this.waitForLoad(webContents, timeoutMs).catch(() => undefined)
    // 在页面内就截断，避免超大页面把数 MB 文本经 IPC 回传后再丢弃
    const page = await this.execute<ReadPageResult>(
      webContents,
      `(() => {
        const raw = ((document.body && document.body.innerText) || '').replace(/\\n{3,}/g, '\\n\\n').trim();
        return {
          url: location.href,
          title: (document.title || '').slice(0, 300),
          text: raw.slice(0, ${maxChars + 1})
        };
      })()`,
      timeoutMs,
      '读取网页内容'
    )
    const raw = typeof page?.text === 'string' ? page.text : ''
    return {
      url: typeof page?.url === 'string' ? page.url : webContents.getURL(),
      title: typeof page?.title === 'string' ? page.title : webContents.getTitle(),
      text: raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw,
      truncated: raw.length > maxChars
    }
  }

  async automationScreenshot(ctx: BrowserCallContext): Promise<BrowserScreenshotResult> {
    this.checkActionBudget(ctx.runId)
    const surface = await this.automationSurface()
    const webContents = surface.view.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    await this.waitForLoad(webContents, timeoutMs).catch(() => undefined)
    const capture = async (): Promise<BrowserScreenshotResult> => {
      const image = await this.withTimeout(webContents.capturePage(), timeoutMs, '截取网页')
      const png = image.toPNG()
      if (!png || png.length === 0) throw new Error('截图内容为空')
      const size = image.getSize()
      return {
        pngBase64: png.toString('base64'),
        width: size.width,
        height: size.height,
        url: webContents.getURL(),
        title: webContents.getTitle()
      }
    }
    try {
      return await capture()
    } catch {
      // 可见视图首帧可能尚未绘制：稍等后重试一次
      await new Promise((resolve) => setTimeout(resolve, 300))
      return capture()
    }
  }

  async automationBack(ctx: BrowserCallContext): Promise<BrowserState> {
    this.checkActionBudget(ctx.runId)
    const surface = await this.automationSurface()
    const webContents = surface.view.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    // Electron 44 的 canGoBack() 在部分站点会误报 false；用活动索引判断（与面板按钮一致）
    if (!this.historyState(webContents).canGoBack) throw new Error('已经到第一页，无法后退。')
    const nav = webContents.navigationHistory
    nav.goToIndex(nav.getActiveIndex() - 1)
    await this.waitForLoad(webContents, timeoutMs).catch(() => undefined)
    return this.stateOf(webContents)
  }

  async automationForward(ctx: BrowserCallContext): Promise<BrowserState> {
    this.checkActionBudget(ctx.runId)
    const surface = await this.automationSurface()
    const webContents = surface.view.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    if (!this.historyState(webContents).canGoForward) throw new Error('已经在最后一页，无法前进。')
    const nav = webContents.navigationHistory
    nav.goToIndex(nav.getActiveIndex() + 1)
    await this.waitForLoad(webContents, timeoutMs).catch(() => undefined)
    return this.stateOf(webContents)
  }

  async closeAutomation(): Promise<void> {
    const owner = this.surface?.owner ?? this.ownerWindow()
    this.closeSurface()
    if (owner && !owner.isDestroyed()) owner.webContents.send(BROWSER_CLOSED_EVENT, {})
  }

  /* ── 测试/E2E 辅助（只在 --test-mode 下被 globalThis 暴露） ──── */

  /** E2E：查询统一 surface 的真实状态（仅在 --test-mode 经 globalThis 暴露） */
  debugInfo(): {
    surface: boolean
    surfaceBounds: BrowserBounds | null
    /** 原生视图是否真正显示；0×0 或隐藏会在窗口上留下黑底 */
    surfaceVisible: boolean
    surfaceWebContentsSize: { width: number; height: number } | null
    surfaceOwnerTitle: string
    surfaceOwnerSize: { width: number; height: number } | null
    surfaceUrl: string
    surfaceTitle: string
    automationActive: boolean
    /** 兼容旧测试字段：自动化现在就在 surface 上执行 */
    automationOpen: boolean
    automationUrl: string
    automationTitle: string
    pendingDownloads: string[]
  } {
    const surface = this.surface
    const url = surface?.view.webContents.getURL() ?? ''
    const title = surface?.view.webContents.getTitle() ?? ''
    return {
      surface: Boolean(surface),
      surfaceBounds: surface?.bounds ?? null,
      surfaceVisible: surface ? surface.view.getVisible() : false,
      surfaceWebContentsSize: surface
        ? (() => {
            const bounds = surface.view.getBounds()
            return { width: bounds.width, height: bounds.height }
          })()
        : null,
      surfaceOwnerTitle: surface && !surface.owner.isDestroyed() ? surface.owner.getTitle() : '',
      surfaceOwnerSize:
        surface && !surface.owner.isDestroyed() ? surface.owner.getContentBounds() : null,
      surfaceUrl: url,
      surfaceTitle: title,
      automationActive: this.state.automationActive,
      automationOpen: Boolean(surface),
      automationUrl: url,
      automationTitle: title,
      pendingDownloads: [...this.pendingDownloads.keys()]
    }
  }

  /** E2E 专用：在 surface 页面里执行一段脚本（用于触发下载链接等真实交互；生产不暴露） */
  async debugSurfaceScript(script: string): Promise<unknown> {
    const surface = this.surface
    if (!surface) throw new Error('浏览器面板未打开。')
    return surface.view.webContents.executeJavaScript(script)
  }
}

/** 进程级单例（feature 模块 import 时初始化） */
export const browserService = BrowserService.getInstance()

export { describeTarget }
