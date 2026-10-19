/**
 * R10-C：内置浏览器主进程服务（WebContentsView）+ R10-K1：浏览器自动化执行器。
 *
 * 安全基线（审计要求）：
 * - 导航/自动化只允许 http/https；file/javascript/data/blob 等一律拦截；localhost 允许；
 * - 远程页面：sandbox=true、contextIsolation=true、无 Node、无 preload、webviewTag=false、webSecurity=true；
 * - 独立持久 session 分区 `persist:morrow-browser`，与主应用隔离；
 * - 证书错误一律拒绝（app certificate-error 只处理本服务持有的 webContents）；
 * - 摄像头/麦克风/地理位置/通知等权限一律拒绝（permissionRequestHandler/CheckHandler 全 false）；
 * - 下载：surface 上下载先 pause，发给渲染层确认（批准→设置 dataPath/downloads 下路径并 resume；拒绝/超时→cancel）；
 *   自动化窗口内的下载直接取消（无人确认）；
 * - 自动化只操作本服务自己的隐藏 BrowserWindow，不查找/操作用户其他窗口；
 * - 每次自动化动作走 runId 步数预算（BROWSER_LIMITS.maxActionsPerRun），防无限自循环。
 *
 * 本文件不 import main/index / ipc / preload，避免循环依赖；窗口通过 IPC event.sender 反查。
 */
import { app, BrowserWindow, WebContentsView, session, type Session, type WebContents } from 'electron'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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
    error: null
  }
}

function safeFilename(name: string): string {
  const base = basename(name || 'download.bin')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .trim()
  return (base || 'download.bin').slice(0, 160)
}

function describeTarget(target: string): string {
  return target.length > 80 ? `${target.slice(0, 80)}…` : target
}

/** executeJavaScript 可能返回 undefined/不可序列化值：统一转成 JSON 安全结构 */
type LocateResult =
  | { ok: true; x: number; y: number; tag: string; label: string }
  | { ok: false; reason: string }

type ReadPageResult = { url: string; title: string; text: string }

export class BrowserService {
  private static instance: BrowserService | null = null

  private initialized = false
  private surface: SurfaceHandle | null = null
  private automationWindow: BrowserWindow | null = null
  private state: BrowserState = emptyState()
  private pendingDownloads = new Map<string, PendingDownload>()
  private actionCounts = new Map<string, number>()
  private ownsWebContents = new Set<number>()

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
      this.reportError({ code: `CERT_${error}`, message: `证书错误，已拒绝连接：${url}` })
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
      try {
        rmSync(pending.holdingPath, { force: true })
      } catch {
        // 忽略
      }
    }
    this.pendingDownloads.clear()
    this.closeSurface()
    this.destroyAutomationWindow()
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
    const blocked = (url: string, kind: string): void => {
      log.warn('browser navigation blocked', { url, kind })
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
      // 不新增窗口：外链/弹窗在浏览器里一律拦下（避免绕过 surface 安全边界）
      log.warn('browser popup blocked', { url: url.slice(0, 200) })
      this.reportError({ code: 'POPUP_BLOCKED', message: `已拦截网页弹窗：${url.slice(0, 200)}` })
      return { action: 'deny' }
    })
    webContents.on('will-attach-webview', (event) => event.preventDefault())
    webContents.on('did-start-loading', () => this.updateState({ loading: true }))
    webContents.on('did-stop-loading', () => {
      this.updateState({ loading: false })
      this.refreshStateFrom(webContents)
    })
    webContents.on('did-navigate', () => this.refreshStateFrom(webContents))
    webContents.on('did-navigate-in-page', () => this.refreshStateFrom(webContents))
    webContents.on('page-title-updated', () => this.refreshStateFrom(webContents))
    webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 /* ABORTED */) return
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

  private refreshStateFrom(webContents: WebContents): void {
    if (!this.surface || webContents.id !== this.surface.view.webContents.id) return
    const nav = webContents.navigationHistory
    this.state = {
      ...this.state,
      open: true,
      url: webContents.getURL(),
      title: webContents.getTitle(),
      loading: webContents.isLoading(),
      canGoBack: nav ? nav.canGoBack() : false,
      canGoForward: nav ? nav.canGoForward() : false
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

  /** feature:browser:open { url, bounds? } */
  openSurface(url: string, event: Electron.IpcMainInvokeEvent, bounds?: unknown): BrowserState {
    const check = normalizeBrowserAddress(url)
    if (!check.allowed || !check.url) throw new Error(check.reason ?? '网址无效。')
    const owner = this.ownerFromEvent(event) ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!owner) throw new Error('找不到主窗口，无法打开内置浏览器。')

    // 已存在且属于同一窗口：直接导航
    if (this.surface && this.surface.owner.id === owner.id) {
      void this.surface.view.webContents.loadURL(check.url)
      this.state = { ...this.state, open: true, error: null, url: check.url }
      this.updateState({})
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
      visible: true
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
    this.state = { ...this.state, visible }
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
    const check = normalizeBrowserAddress(url)
    if (!check.allowed || !check.url) throw new Error(check.reason ?? '网址无效。')
    this.state = { ...this.state, error: null, url: check.url, loading: true }
    this.updateState({ error: null, loading: true })
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
    const nav = surface.view.webContents.navigationHistory
    if (direction === 'back') {
      if (!nav.canGoBack()) throw new Error('已经到第一页，无法后退。')
      nav.goBack()
    } else {
      if (!nav.canGoForward()) throw new Error('已经在最后一页，无法前进。')
      nav.goForward()
    }
    setTimeout(() => this.refreshStateFrom(surface.view.webContents), 300)
    return this.getState()
  }

  reload(): BrowserState {
    if (!this.surface) throw new Error('浏览器未打开。')
    this.surface.view.webContents.reload()
    this.updateState({ loading: true, error: null })
    return this.getState()
  }

  stop(): BrowserState {
    if (!this.surface) throw new Error('浏览器未打开。')
    this.surface.view.webContents.stop()
    this.updateState({ loading: false })
    return this.getState()
  }

  closeSurface(): void {
    const surface = this.surface
    if (!surface) {
      this.state = emptyState()
      return
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
    this.updateState({ error })
  }

  /* ── 下载确认 ───────────────────────────────────────────────── */

  private handleDownload(event: Electron.Event, item: Electron.DownloadItem, webContents: WebContents): void {
    const fromAutomation =
      this.automationWindow && !this.automationWindow.isDestroyed() && webContents?.id === this.automationWindow.webContents.id
    const surface = this.surface
    if (fromAutomation || !surface || webContents?.id !== surface.view.webContents.id) {
      // 自动化窗口没有用户确认入口；其它 webContents 也不允许静默下载
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
    const timer = setTimeout(() => {
      const pending = this.pendingDownloads.get(request.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pendingDownloads.delete(request.id)
      try {
        rmSync(pending.holdingPath, { force: true })
      } catch {
        // 忽略
      }
      this.emitToOwner('feature:browser:download-resolved', { id: request.id, allow: false })
      log.info('browser download request expired (temp removed)', { id: request.id, filename })
    }, 60_000)
    const pending: PendingDownload = { request, item, holdingPath, done: false, approved: false, timer }
    this.pendingDownloads.set(request.id, pending)
    item.on('done', (_doneEvent, state) => {
      pending.done = true
      log.info('browser download done', { id: request.id, state, bytes: item.getReceivedBytes(), holdingPath })
      if (pending.approved) this.finalizeDownload(pending)
    })
    this.emitToOwner('feature:browser:download', request)
    log.info('browser download requested', { id: request.id, filename, totalBytes: request.totalBytes, holdingPath })
  }

  /** 批准后把暂存文件移动到用户下载目录（同名冲突时追加时间戳） */
  private finalizeDownload(pending: PendingDownload): void {
    if (!this.pendingDownloads.delete(pending.request.id)) return
    clearTimeout(pending.timer)
    if (!pending.done) {
      pending.approved = true
      this.pendingDownloads.set(pending.request.id, pending)
      return
    }
    let target = pending.request.suggestedPath
    if (existsSync(target)) {
      const ext = target.endsWith('.txt') ? '.txt' : ''
      target = target.slice(0, target.length - ext.length) + `-${Date.now()}` + ext
    }
    try {
      mkdirSync(dirname(target), { recursive: true })
      try {
        renameSync(pending.holdingPath, target)
      } catch {
        copyFileSync(pending.holdingPath, target)
        rmSync(pending.holdingPath, { force: true })
      }
      log.info('browser download saved', { id: pending.request.id, path: target })
      this.emitToOwner('feature:browser:download-resolved', { id: pending.request.id, allow: true, path: target })
    } catch (err) {
      log.warn('browser download move failed', String(err))
      try {
        rmSync(pending.holdingPath, { force: true })
      } catch {
        // 忽略
      }
      this.emitToOwner('feature:browser:download-resolved', { id: pending.request.id, allow: false, error: String(err) })
    }
  }

  decideDownload(id: string, allow: boolean): void {
    const pending = this.pendingDownloads.get(id)
    if (!pending) throw new Error('下载请求不存在或已处理。')
    if (allow) {
      pending.approved = true
      if (!pending.done) {
        // 等 done 时 finalizeDownload；保留 pending 与超时兜底
        this.emitToOwner('feature:browser:download-resolved', { id, allow: true, pending: true })
        log.info('browser download approved (waiting for bytes)', { id })
        return
      }
      this.finalizeDownload(pending)
      return
    }
    clearTimeout(pending.timer)
    this.pendingDownloads.delete(id)
    try {
      if (!pending.done) pending.item.cancel()
      rmSync(pending.holdingPath, { force: true })
    } catch (err) {
      log.warn('browser download deny cleanup failed', String(err))
    }
    this.emitToOwner('feature:browser:download-resolved', { id, allow: false })
    log.info('browser download denied + temp removed', { id })
  }

  /* ── K1 自动化（隐藏窗口） ──────────────────────────────────── */

  private ensureAutomationWindow(): BrowserWindow {
    if (this.automationWindow && !this.automationWindow.isDestroyed()) return this.automationWindow
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        ...BROWSER_WEB_PREFERENCES,
        preload: undefined
      }
    })
    const webContentsId = win.webContents.id
    this.ownsWebContents.add(webContentsId)
    win.webContents.on('destroyed', () => this.ownsWebContents.delete(webContentsId))
    this.adoptOwnNavigationPolicy(win.webContents)
    this.attachNavigationGuards(win.webContents)
    win.on('closed', () => {
      this.automationWindow = null
    })
    this.automationWindow = win
    log.info('browser automation window created')
    return win
  }

  private destroyAutomationWindow(): void {
    const win = this.automationWindow
    this.automationWindow = null
    if (!win || win.isDestroyed()) return
    try {
      win.destroy()
    } catch {
      // 忽略
    }
  }

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
    const nav = webContents.navigationHistory
    return {
      open: true,
      visible: false,
      url: webContents.getURL(),
      title: webContents.getTitle(),
      loading: webContents.isLoading(),
      canGoBack: nav ? nav.canGoBack() : false,
      canGoForward: nav ? nav.canGoForward() : false,
      error: null
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
    const script = `(() => {
      const target = ${payload};
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const center = (el) => {
        el.scrollIntoView({ block: 'center', inline: 'center' });
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
          (candidate.getAttribute('name') || '').includes(target)
        ));
        el = exact || fuzzy || byAttr || null;
      }
      if (!el) return { ok: false, reason: selectorError ? ('CSS selector 无效：' + selectorError + '；也没有找到可见文本匹配的元素') : '没有找到匹配的可见元素' };
      if (!visible(el)) return { ok: false, reason: '元素存在但不可见' };
      const point = center(el);
      return { ok: true, x: point.x, y: point.y, tag: el.tagName, label: describe(el) };
    })()`
    const result = await this.execute<LocateResult>(webContents, script, timeoutMs, '定位网页元素')
    if (!result || typeof result !== 'object') return { ok: false, reason: '定位结果无效' }
    return result
  }

  private async waitForLoad(webContents: WebContents, timeoutMs: number): Promise<void> {
    if (!webContents.isLoading()) return
    await this.withTimeout(
      new Promise<void>((resolve) => {
        const onStop = (): void => {
          webContents.removeListener('did-stop-loading', onStop)
          webContents.removeListener('did-fail-load', onStop)
          resolve()
        }
        webContents.once('did-stop-loading', onStop)
        webContents.once('did-fail-load', onStop)
      }),
      timeoutMs,
      '等待页面加载'
    )
  }

  /* ── Bridge 实现 ────────────────────────────────────────────── */

  async automationOpen(url: string, ctx: BrowserCallContext): Promise<BrowserState> {
    this.checkActionBudget(ctx.runId)
    const check = checkBrowserUrl(url)
    if (!check.allowed || !check.url) throw new Error(check.reason ?? '网址无效。')
    const win = this.ensureAutomationWindow()
    const webContents = win.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.openTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    try {
      await this.withTimeout(webContents.loadURL(check.url), timeoutMs, '打开网页')
    } catch (err) {
      try {
        webContents.stop()
      } catch {
        // 忽略
      }
      throw new Error(`打开网页失败：${err instanceof Error ? err.message : String(err)}`)
    }
    return this.stateOf(webContents)
  }

  async automationClick(target: string, ctx: BrowserCallContext): Promise<BrowserActionResult> {
    this.checkActionBudget(ctx.runId)
    const win = this.ensureAutomationWindow()
    const webContents = win.webContents
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
    const win = this.ensureAutomationWindow()
    const webContents = win.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    const located = await this.locateElement(webContents, target, timeoutMs)
    if (!located.ok) throw new Error(located.reason)
    // 聚焦并全选（若有），随后用 insertText 发送真实文本输入事件
    const escapedTarget = JSON.stringify(target)
    await this.execute(
      webContents,
      `(() => {
        const target = ${escapedTarget};
        const visible = (el) => el && el.getBoundingClientRect().width > 0;
        let el = null;
        try { el = document.querySelector(target); } catch (err) { el = null; }
        if (!el) {
          const candidates = Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]'));
          el = candidates.find((candidate) => visible(candidate) && ((candidate.getAttribute('placeholder') || '').includes(target) || (candidate.getAttribute('aria-label') || '').includes(target) || (candidate.getAttribute('name') || '').includes(target))) || null;
        }
        if (!el) return false;
        el.focus();
        if (typeof el.select === 'function') el.select();
        return true;
      })()`,
      timeoutMs,
      '聚焦输入框'
    )
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
    const win = this.ensureAutomationWindow()
    const webContents = win.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    const maxChars = Math.max(200, Math.min(ctx.maxChars ?? BROWSER_LIMITS.maxReadChars, BROWSER_LIMITS.maxReadChars))
    await this.waitForLoad(webContents, timeoutMs).catch(() => undefined)
    const page = await this.execute<ReadPageResult>(
      webContents,
      `(() => ({
        url: location.href,
        title: document.title || '',
        text: ((document.body && document.body.innerText) || '').replace(/\\n{3,}/g, '\\n\\n').trim()
      }))()`,
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
    const win = this.ensureAutomationWindow()
    const webContents = win.webContents
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
      // 隐藏窗口首帧可能尚未绘制：稍等后重试一次
      await new Promise((resolve) => setTimeout(resolve, 300))
      return capture()
    }
  }

  async automationBack(ctx: BrowserCallContext): Promise<BrowserState> {
    this.checkActionBudget(ctx.runId)
    const win = this.ensureAutomationWindow()
    const webContents = win.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    if (!webContents.navigationHistory.canGoBack()) throw new Error('已经到第一页，无法后退。')
    webContents.navigationHistory.goBack()
    await this.waitForLoad(webContents, timeoutMs).catch(() => undefined)
    return this.stateOf(webContents)
  }

  async automationForward(ctx: BrowserCallContext): Promise<BrowserState> {
    this.checkActionBudget(ctx.runId)
    const win = this.ensureAutomationWindow()
    const webContents = win.webContents
    const timeoutMs = Math.min(ctx.timeoutMs ?? BROWSER_LIMITS.actionTimeoutMs, BROWSER_LIMITS.maxTimeoutMs)
    if (!webContents.navigationHistory.canGoForward()) throw new Error('已经在最后一页，无法前进。')
    webContents.navigationHistory.goForward()
    await this.waitForLoad(webContents, timeoutMs).catch(() => undefined)
    return this.stateOf(webContents)
  }

  async closeAutomation(): Promise<void> {
    this.destroyAutomationWindow()
  }

  /* ── 测试/E2E 辅助（只在 --test-mode 下被 globalThis 暴露） ──── */

  /** E2E：查询 surface / 自动化窗口的真实状态（仅在 --test-mode 经 globalThis 暴露） */
  debugInfo(): {
    surface: boolean
    surfaceBounds: BrowserBounds | null
    surfaceUrl: string
    surfaceTitle: string
    automationOpen: boolean
    automationUrl: string
    automationTitle: string
    pendingDownloads: string[]
  } {
    return {
      surface: Boolean(this.surface),
      surfaceBounds: this.surface?.bounds ?? null,
      surfaceUrl: this.surface?.view.webContents.getURL() ?? '',
      surfaceTitle: this.surface?.view.webContents.getTitle() ?? '',
      automationOpen: Boolean(this.automationWindow && !this.automationWindow.isDestroyed()),
      automationUrl: this.automationWindow && !this.automationWindow.isDestroyed() ? this.automationWindow.webContents.getURL() : '',
      automationTitle: this.automationWindow && !this.automationWindow.isDestroyed() ? this.automationWindow.webContents.getTitle() : '',
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
