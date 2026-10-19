import { app, BrowserWindow, Menu, screen, session, shell } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { registerIpcHandlers } from './ipc'
import { installFeatureIpc } from './feature-ipc'
import { registerFeatureModules } from './features'
import { ensureDataDirs, resolveDataDir } from './services/paths'
import { installMcpRuntimeEnv } from './services/mcp-service'
import { configureMemoryRuntime } from './services/memory-service'
import { configureProjectsRuntime } from './services/project-service'
import { log } from './services/logger'

/** 单实例：便携版双击两次不应开两个窗口 */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  bootstrap()
}

function bootstrap(): void {
  // 便携版：数据目录跟随 exe，做到「拷走就能用」
  const dataDir = resolveDataDir()
  app.setPath('userData', dataDir)
  app.setAppUserModelId('studio.morrow.agent')
  ensureDataDirs()
  configureMemoryRuntime(dataDir)
  configureProjectsRuntime(dataDir)
  installMcpRuntimeEnv(process.env, dataDir)

  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    log.info('app ready', { dataDir, version: app.getVersion(), packaged: app.isPackaged })
    installSecurityPolicy()
    Menu.setApplicationMenu(null)
    registerIpcHandlers()
    registerFeatureModules()
    installFeatureIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('web-contents-created', (_event, contents) => {
    // 功能测试模式下绝不能弹出外部浏览器/Edge 窗口：测试站点导航只允许留在应用内部。
    const testMode = process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')
    contents.setWindowOpenHandler(({ url }) => {
      if (!testMode && /^https?:/i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      const devUrl = process.env.ELECTRON_RENDERER_URL
      const allowed = (devUrl && url.startsWith(devUrl)) || url.startsWith('file://')
      if (!allowed) {
        event.preventDefault()
        if (!testMode && /^https?:/i.test(url)) void shell.openExternal(url)
      }
    })
  })
}

function installSecurityPolicy(): void {
  // 生产环境收紧 CSP；开发环境由 Vite 注入 HMR，不启用严格 CSP
  if (!app.isPackaged) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; frame-src 'self' data: blob:;"
        ]
      }
    })
  })
}

let mainWindow: BrowserWindow | null = null

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
  const windowIcon = [
    join(__dirname, '../../build/icon.png'),
    join(app.getAppPath(), 'build', 'icon.png'),
    join(process.resourcesPath, 'icon.png'),
    join(process.resourcesPath, 'build', 'icon.png')
  ].find((candidate) => existsSync(candidate))

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: toDip(1200),
    minHeight: toDip(760),
    center: true,
    show: false,
    frame: false,
    backgroundColor: '#0B0D10',
    title: 'Morrow',
    autoHideMenuBar: true,
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      webviewTag: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    const win = mainWindow
    if (!win) return
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
  mainWindow.on('closed', () => {
    mainWindow = null
  })

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
