import { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage, protocol, screen, session } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { disposeAgentRuntime, registerIpcHandlers } from './ipc'
import { installFeatureIpc } from './feature-ipc'
import { registerFeatureModules } from './features'
import { getSubscriptionService } from './services/subscriptions'
import { getQoderSubscriptionService } from './services/qoder-subscription'
import { allAgentServices } from './services/agent-subscriptions'
import { openExternalQuiet } from './services/external-open'
import { handlePreviewProtocol } from './services/file-preview'
import { ARTIFACT_PREVIEW_SCHEME, handleArtifactPreview } from './services/artifact-preview'
import { ensureDataDirs, resolveDataDir } from './services/paths'
import { installMcpRuntimeEnv } from './services/mcp-service'
import { configureMemoryRuntime } from './services/memory-service'
import { configureProjectsRuntime } from './services/project-service'
import { getTerminalManager } from './services/terminal-manager'
import { configurePermissionRulesRuntime } from './services/permission-rules'
import { initializeTokenActivity } from './services/runtime'
import { configureIsland, createIsland, hideIsland, markIslandRead, toggleIsland } from './services/island'
import { disposeScheduleRuntime, initializeScheduleRuntime } from './services/schedule-runtime'
import {
  appIconPath,
  attachIconTray,
  attachIconWindow,
  configureLifecycle,
  currentIconTheme,
  handleMainWindowClose,
  isAppQuitting,
  markAppQuitting,
  quitApp,
  requestCloseFromIsland
} from './services/lifecycle'
import { log } from './services/logger'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'morrow-file',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  },
  {
    scheme: ARTIFACT_PREVIEW_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true }
  }
])

// 数据目录必须在单实例锁之前确定：Electron 的单实例锁按 userData 区分；
// 若先抢默认的 %APPDATA%\Morrow，多个便携副本会互相顶掉。
const dataDir = resolveDataDir()
app.setPath('userData', dataDir)

/** 单实例：同一份数据目录双击两次不应开两个窗口 */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  bootstrap(dataDir)
}

function bootstrap(dataDir: string): void {
  // 便携版：数据目录跟随 exe，做到「拷走就能用」
  app.setAppUserModelId('studio.morrow.agent')
  ensureDataDirs()
  configureMemoryRuntime(dataDir)
  configureProjectsRuntime(dataDir)
  configurePermissionRulesRuntime(dataDir)
  installMcpRuntimeEnv(process.env, dataDir)

  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(() => {
    log.info('app ready', { dataDir, version: app.getVersion(), packaged: app.isPackaged })
    installSecurityPolicy()
    protocol.handle('morrow-file', handlePreviewProtocol)
    protocol.handle(ARTIFACT_PREVIEW_SCHEME, handleArtifactPreview)
    Menu.setApplicationMenu(null)
    registerIpcHandlers()
    registerFeatureModules()
    installFeatureIpc()
    void getSubscriptionService().restore()
    void getQoderSubscriptionService().restore()
    for (const service of allAgentServices()) void service.restore()
    initializeTokenActivity()
    configureLifecycle(() => mainWindow)
    createWindow()
    configureIsland({ openMain: showMainWindow, requestClose: () => void requestCloseFromIsland() })
    createIsland()
    createTray()
    initializeScheduleRuntime()
    registerIslandShortcut()

    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    })
  })

  app.on('before-quit', () => {
    markAppQuitting()
  })

  app.on('will-quit', () => {
    disposeScheduleRuntime()
    disposeAgentRuntime()
    void getSubscriptionService().dispose()
    void getQoderSubscriptionService().dispose()
    for (const service of allAgentServices()) void service.dispose()
    globalShortcut.unregisterAll()
    try {
      getTerminalManager().dispose()
    } catch {
      // ignore
    }
    hideIsland(true)
    if (tray && !tray.isDestroyed()) tray.destroy()
    tray = null
  })

  app.on('window-all-closed', () => {
    // 关闭动作已由主窗口 close 事件处理：最小化会保留窗口，退出会设置 quitting。
    // 这里保持进程运行（托盘/灵动岛仍在），避免误退出后台任务。
    if (isAppQuitting()) return
  })

  app.on('web-contents-created', (_event, contents) => {
    // 功能测试模式下绝不能弹出外部浏览器/Edge 窗口：测试站点导航只允许留在应用内部。
    const testMode = process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')
    const devUrl = process.env.ELECTRON_RENDERER_URL
    const rendererFileUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href
    const isAppUrl = (url: string): boolean => {
      if (devUrl) {
        try {
          return new URL(url).origin === new URL(devUrl).origin
        } catch {
          return false
        }
      }
      // 生产包只允许应用自己的 index.html（含锚点），不再放行任意 file:// 本地页面
      return url === rendererFileUrl || url.startsWith(`${rendererFileUrl}#`)
    }
    contents.setWindowOpenHandler(({ url }) => {
      if (!testMode && /^https?:/i.test(url)) openExternalQuiet(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!isAppUrl(url)) {
        event.preventDefault()
        if (!testMode && /^https?:/i.test(url)) openExternalQuiet(url)
      }
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}

function installSecurityPolicy(): void {
  // 生产环境收紧 CSP；开发环境由 Vite 注入 HMR，不启用严格 CSP。
  // MORROW_TEST_CSP=1 让 E2E 在未打包形态下也能验证生产 CSP（仅测试环境使用）。
  const forceCsp = process.env.MORROW_TEST_CSP === '1'
  if (!app.isPackaged && !forceCsp) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // HTML 产物由独立协议返回，自带更宽松但无同源的沙箱 CSP；父窗口 CSP 不能再覆盖它
    if (details.url.startsWith(`${ARTIFACT_PREVIEW_SCHEME}:`)) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: morrow-file:; media-src 'self' blob: morrow-file:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:* morrow-file:; frame-src 'self' data: blob: morrow-artifact:; worker-src 'self' blob:; object-src 'none'; base-uri 'none';"
        ]
      }
    })
  })
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

export function showMainWindow(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.setSkipTaskbar(false)
  win.show()
  win.focus()
  win.flashFrame(false)
}

function createTray(): void {
  if (tray && !tray.isDestroyed()) return
  const iconPath = appIconPath()
  let image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  if (!image.isEmpty()) image = image.resize({ width: 16, height: 16 })
  tray = new Tray(image)
  attachIconTray(tray)
  tray.setToolTip('Morrow')
  const menu = Menu.buildFromTemplate([
    { label: '打开 Morrow', click: () => showMainWindow() },
    { label: '显示 / 隐藏桌面小伙伴', click: () => toggleIsland() },
    { label: '快捷键：Ctrl+Shift+M', enabled: false },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitApp()
      }
    }
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => showMainWindow())
  tray.on('double-click', () => showMainWindow())
}

/** 桌面快速唤起：无论主窗口在托盘还是别的应用前面，都能把小伙伴叫出来。 */
function registerIslandShortcut(): void {
  const isTest = process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')
  if (isTest) return
  try {
    const ok = globalShortcut.register('CommandOrControl+Shift+M', () => toggleIsland())
    if (!ok) log.warn('global shortcut Ctrl+Shift+M is already taken')
  } catch (err) {
    log.warn('global shortcut registration failed', String(err))
  }
}

export function createWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow

  const isTest = process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')
  // 用户要求默认窗口为 2000×1000 **物理像素**：Electron 的 width/height 是 DIP，
  // 因此按当前主屏缩放比换算，保证 100%/125%/150%/200% 缩放下物理尺寸一致。
  const scaleFactor = screen.getPrimaryDisplay().scaleFactor || 1
  const targetPhysicalWidth = 2100
  const targetPhysicalHeight = 1200
  // DIP 换算：窗口最终物理像素 = DIP × 缩放比。目标物理 2000×1000，
  // 在 150% 等非整数倍缩放下 DIP 会带小数，因此构造后用 setBounds(小数 DIP)
  // 让 Chromium 按物理像素取整，屏幕截图为 2000×1000（部分缩放比为 2000×1001，1px 取整差）。
  const targetWidthDip = targetPhysicalWidth / scaleFactor
  const targetHeightDip = targetPhysicalHeight / scaleFactor
  const toDip = (physical: number): number => Math.max(1, Math.round(physical / scaleFactor))
  const windowWidth = toDip(targetPhysicalWidth)
  const windowHeight = toDip(targetPhysicalHeight)
  log.info('window sizing', { scaleFactor, windowWidth, windowHeight, targetPhysicalWidth, targetPhysicalHeight })
  const windowIcon = appIconPath(currentIconTheme())

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: toDip(1200),
    minHeight: toDip(760),
    center: true,
    show: false,
    skipTaskbar: false,
    frame: false,
    backgroundColor: '#0B0D10',
    title: 'Morrow',
    autoHideMenuBar: true,
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      webviewTag: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    const win = mainWindow
    if (!win) return
    // 隐藏/最小化时继续渲染流式增量；否则从灵动岛回来会一次性补做大量布局而像卡死。
    win.webContents.setBackgroundThrottling(false)
    win.show()
    win.focus()
    // 构造参数的 DIP 取整可能造成 ±1 物理像素偏差；等窗口完成首帧后再校正一次内容尺寸。
    setTimeout(() => {
      if (!win || win.isDestroyed()) return
      win.setSize(toDip(targetPhysicalWidth), toDip(targetPhysicalHeight))
    }, 900)
  })

  mainWindow.on('maximize', () => emitWindowState(true))
  mainWindow.on('unmaximize', () => emitWindowState(false))
  mainWindow.on('enter-full-screen', () => emitWindowState(true))
  mainWindow.on('leave-full-screen', () => emitWindowState(false))
  mainWindow.on('focus', () => {
    try {
      mainWindow?.flashFrame(false)
    } catch {
      // ignore
    }
    markIslandRead()
  })
  mainWindow.on('close', (event) => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    handleMainWindowClose(event, win)
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  attachIconWindow(mainWindow)

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
    if (!isTest) mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

function emitWindowState(maximized: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('morrow:window-state', {
    maximized,
    focused: mainWindow.isFocused(),
    fullscreen: mainWindow.isFullScreen()
  })
}
