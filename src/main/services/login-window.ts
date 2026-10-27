// 订阅登录窗口：在 Morrow 内部用独立 BrowserWindow 打开授权页。
import { BrowserWindow, session } from 'electron'
import { log } from './logger'

const LOGIN_PARTITION = 'persist:morrow-login'
const LOGIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
const CHROME_BRANDS = '"Chromium";v="156", "Google Chrome";v="156", "Not?A_Brand";v="24"'
const CHROME_FULL_BRANDS =
  '"Chromium";v="156.0.0.0", "Google Chrome";v="156.0.0.0", "Not?A_Brand";v="24.0.0.0"'

let loginWindow: BrowserWindow | null = null
let headerHooksInstalled = false

function loginSession(): Electron.Session {
  const ses = session.fromPartition(LOGIN_PARTITION)
  ses.setUserAgent(LOGIN_UA)
  if (!headerHooksInstalled) {
    headerHooksInstalled = true
    // Electron 默认的 Client Hints 会暴露 Electron 身份，Cloudflare 因此要求
    // 额外的安全验证；把 UA-CH 对齐到 Chrome 后，真实的 ChatGPT 登录页可直接加载。
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders
      for (const key of Object.keys(headers)) {
        if (/^(user-agent|sec-ch-ua|accept-language)/i.test(key)) delete headers[key]
      }
      headers['User-Agent'] = LOGIN_UA
      headers['sec-ch-ua'] = CHROME_BRANDS
      headers['sec-ch-ua-mobile'] = '?0'
      headers['sec-ch-ua-platform'] = '"Windows"'
      headers['sec-ch-ua-full-version-list'] = CHROME_FULL_BRANDS
      headers['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8'
      callback({ requestHeaders: headers })
    })
  }
  return ses
}

function isLoginCallback(url: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1):1455\/auth\/callback(?:[/?#]|$)/i.test(url)
}

export function isLoginSession(ses: Electron.Session): boolean {
  return ses === session.fromPartition(LOGIN_PARTITION)
}

/**
 * 登录页需要在自己的窗口里完成整页跳转（Qoder 的“继续”就是同页导航）。
 * app 级 web-contents-created 给所有窗口装了“非应用地址一律拦截”的 will-navigate，
 * 这里对登录窗口及其 OAuth 子窗口解除该拦截，只保留 http(s) 白名单。
 */
function installLoginNavigation(window: BrowserWindow): void {
  const contents = window.webContents
  contents.removeAllListeners('will-navigate')
  contents.on('will-navigate', (event, target) => {
    if (!/^https?:\/\//i.test(target) && target !== 'about:blank') event.preventDefault()
  })
  contents.on('did-create-window', (child) => {
    child.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
      if (!/^https?:\/\//i.test(popupUrl)) return { action: 'deny' }
      return { action: 'allow' }
    })
    installLoginNavigation(child)
  })
}

export function openLoginWindow(url: string): boolean {
  try {
    loginSession()
    if (loginWindow && !loginWindow.isDestroyed()) {
      void loginWindow.loadURL(url)
      loginWindow.show()
      loginWindow.focus()
      return true
    }
    const window = new BrowserWindow({
      width: 520,
      height: 760,
      minWidth: 380,
      minHeight: 520,
      title: 'Morrow 登录',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        partition: LOGIN_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false
      }
    })
    loginWindow = window
    window.setMenuBarVisibility(false)
    window.webContents.setUserAgent(LOGIN_UA)
    window.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
      if (!/^https?:\/\//i.test(popupUrl)) return { action: 'deny' }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 760,
          autoHideMenuBar: true,
          webPreferences: {
            partition: LOGIN_PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true
          }
        }
      }
    })
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    installLoginNavigation(window)
    window.webContents.on('did-navigate', (_event, target) => {
      if (isLoginCallback(target)) {
        // 本地回调已交给订阅服务的 1455 服务器，留一点时间完成响应再收起窗口。
        setTimeout(() => {
          if (!window.isDestroyed()) window.close()
        }, 900)
      }
    })
    window.webContents.on('did-fail-load', (_event, code, description, failedUrl) => {
      log.warn('login window load failed', { code, description, host: safeHost(failedUrl) })
    })
    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) {
        window.show()
        window.focus()
      }
    })
    window.on('closed', () => {
      if (loginWindow === window) loginWindow = null
    })
    void window.loadURL(url).catch((err) => {
      log.warn('login window load rejected', { host: safeHost(url), message: String(err) })
    })
    return true
  } catch (err) {
    log.warn('login window create failed', { host: safeHost(url), message: String(err) })
    return false
  }
}

export function closeLoginWindow(): void {
  const window = loginWindow
  loginWindow = null
  if (window && !window.isDestroyed()) {
    try { window.close() } catch { /* window may be closing */ }
  }
}

function safeHost(url: string): string {
  try { return new URL(url).host } catch { return '' }
}
