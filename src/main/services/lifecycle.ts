// 应用生命周期：关闭动作（询问 / 最小化到任务栏 / 完全退出）、退出兜底与主题图标。
import { app, BrowserWindow, dialog, nativeImage, type Event as ElectronEvent, type Tray } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CloseAction } from '../../shared/types'
import { WINDOW_CLOSE_REQUEST_CHANNEL } from '../../shared/ipc'
import { getSettingsStore } from './settings-store'
import { log } from './logger'

let quitting = false
let getMainWindowProvider: () => BrowserWindow | null = () => null

export function configureLifecycle(getMainWindow: () => BrowserWindow | null): void {
  getMainWindowProvider = getMainWindow
}

export function isAppQuitting(): boolean {
  return quitting
}

/** before-quit 由系统/托盘触发时同步状态，主窗口 close 处理器据此放行。 */
export function markAppQuitting(): void {
  quitting = true
}

export function quitApp(): void {
  if (quitting) return
  quitting = true
  log.info('quit requested')
  try {
    app.quit()
  } catch (err) {
    log.warn('app.quit failed; forcing exit', { error: String(err) })
    app.exit(0)
    return
  }
  // 某些子进程/句柄可能拖住退出流程；超时后强制结束，避免任务管理器里留下僵尸进程。
  const timer = setTimeout(() => {
    log.warn('graceful quit timed out; forcing exit')
    app.exit(0)
  }, 4_000)
  timer.unref?.()
}

/** 主窗口最小化到任务栏：确保不是被隐藏，任务栏必须有图标。 */
export function minimizeMainWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  win.setSkipTaskbar(false)
  if (!win.isVisible()) win.show()
  win.minimize()
}

function persistCloseAction(action: Exclude<CloseAction, 'ask'>): void {
  try {
    getSettingsStore().update({ closeAction: action })
  } catch (err) {
    log.warn('persist close action failed', { error: String(err) })
  }
}

/** 主窗口的 close 事件入口（标题栏关闭按钮、Alt+F4）。 */
export function handleMainWindowClose(event: ElectronEvent, win: BrowserWindow): void {
  if (quitting) return
  let action: CloseAction = 'ask'
  try {
    action = getSettingsStore().get().closeAction
  } catch {
    // 设置未就绪时仍按“询问”处理
  }
  if (action === 'minimize') {
    event.preventDefault()
    minimizeMainWindow(win)
    return
  }
  if (action === 'quit') {
    event.preventDefault()
    quitApp()
    return
  }
  event.preventDefault()
  if (!win.webContents.isDestroyed()) {
    win.webContents.send(WINDOW_CLOSE_REQUEST_CHANNEL)
  }
}

/** 渲染层在关闭询问弹窗里做出选择后调用：记住选择并立即执行。 */
export function resolveWindowClose(win: BrowserWindow | null, action: Exclude<CloseAction, 'ask'>): void {
  if (quitting) return
  persistCloseAction(action)
  if (action === 'minimize') {
    minimizeMainWindow(win ?? getMainWindowProvider())
    return
  }
  quitApp()
}

/**
 * 灵动岛右键菜单的“关闭 Morrow”：岛是独立小窗，用系统原生询问框，
 * 位置稳定且不会被主窗口是否可见影响。选定后同样记住。
 */
export async function requestCloseFromIsland(): Promise<void> {
  if (quitting) return
  const main = getMainWindowProvider()
  let action: CloseAction = 'ask'
  try {
    action = getSettingsStore().get().closeAction
  } catch {
    // 设置未就绪时询问
  }
  if (action === 'quit') {
    quitApp()
    return
  }
  if (action === 'minimize') {
    minimizeMainWindow(main)
    return
  }
  const options = {
    type: 'question' as const,
    title: '关闭 Morrow',
    message: '关闭动作要怎么做？',
    detail: '选定后会记住，可在 设置 → 外观 随时修改。',
    buttons: ['最小化到任务栏', '完全退出', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  }
  try {
    const result = main && !main.isDestroyed()
      ? await dialog.showMessageBox(main, options)
      : await dialog.showMessageBox(options)
    if (result.response === 0) {
      persistCloseAction('minimize')
      minimizeMainWindow(main)
    } else if (result.response === 1) {
      persistCloseAction('quit')
      quitApp()
    }
  } catch (err) {
    log.warn('island close prompt failed', { error: String(err) })
  }
}

export type AppIconTheme = 'dark' | 'light'

let iconTheme: AppIconTheme = 'dark'
let iconWindow: BrowserWindow | null = null
let iconTray: Tray | null = null

function iconCandidates(file: string): string[] {
  return [
    join(__dirname, '../../build', file),
    join(app.getAppPath(), 'build', file),
    join(process.resourcesPath, file),
    join(process.resourcesPath, 'build', file)
  ]
}

export function appIconPath(next: AppIconTheme = iconTheme): string | null {
  return iconCandidates(`icon-${next}.png`).find((candidate) => existsSync(candidate)) ?? null
}

function trayIconPath(next: AppIconTheme): string | null {
  return iconCandidates(`tray-${next}.png`).find((candidate) => existsSync(candidate)) ?? null
}

export function currentIconTheme(): AppIconTheme {
  return iconTheme
}

function applyIconToTargets(): void {
  const icon = appIconPath(iconTheme)
  if (icon && iconWindow && !iconWindow.isDestroyed()) {
    iconWindow.setIcon(nativeImage.createFromPath(icon))
  }
  const trayIcon = trayIconPath(iconTheme)
  if (trayIcon && iconTray && !iconTray.isDestroyed()) {
    iconTray.setImage(nativeImage.createFromPath(trayIcon).resize({ width: 16, height: 16 }))
  }
}

export function setAppIconTheme(next: AppIconTheme): void {
  iconTheme = next === 'light' ? 'light' : 'dark'
  applyIconToTargets()
}

export function attachIconWindow(win: BrowserWindow): void {
  iconWindow = win
  applyIconToTargets()
}

export function attachIconTray(tray: Tray): void {
  iconTray = tray
  applyIconToTargets()
}
