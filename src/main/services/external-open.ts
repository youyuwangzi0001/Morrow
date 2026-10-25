/** 外部链接与订阅登录：普通链接交给系统；登录授权页在 Morrow 内置浏览器打开。 */
import { clipboard, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log } from './logger'
import { openLoginWindow } from './login-window'

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

export async function openExternalUrl(url: string): Promise<{ opened: boolean; copied: boolean }> {
  if (!isHttpUrl(url)) throw new Error('只能打开 http(s) 链接。')
  if (process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')) {
    clipboard.writeText(url)
    return { opened: false, copied: true }
  }
  if (process.platform === 'win32') {
    try {
      await shell.openExternal(url)
      return { opened: true, copied: false }
    } catch {
      // 交给系统 URL 处理器兜底
    }
    try {
      await promisify(execFile)('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
        windowsHide: true,
        timeout: 8_000
      })
      return { opened: true, copied: false }
    } catch {
      // 继续尝试 Electron 的实现
    }
  }
  try {
    await shell.openExternal(url)
    return { opened: true, copied: false }
  } catch {
    try {
      clipboard.writeText(url)
    } catch {
      // 剪贴板也可能不可用
    }
    return { opened: false, copied: true }
  }
}

/**
 * 登录授权页专用：始终在 Morrow 内置 BrowserWindow 打开。
 *
 * 外部浏览器路径在这台机器上不可靠：UAC 关闭后系统 Edge 是 High 完整性，
 * 而 Morrow 可能是 Low/Medium；跨完整性的 Edge 会白屏并弹出重启提示。
 * 内置 Chromium 不经过系统浏览器单例，用户登录后的回调/轮询仍由原服务处理。
 */
export async function openLoginUrl(url: string): Promise<{ opened: boolean; copied: boolean }> {
  if (!isHttpUrl(url)) throw new Error('只能打开 http(s) 链接。')
  if (process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')) {
    clipboard.writeText(url)
    return { opened: false, copied: true }
  }
  try {
    clipboard.writeText(url)
  } catch {
    // 剪贴板不可用时仍尝试打开内置登录窗口
  }
  if (openLoginWindow(url)) return { opened: true, copied: true }
  log.warn('login window unavailable')
  return { opened: false, copied: true }
}

/** 不关心结果的场景（普通外部链接）；失败时仍有剪贴板兜底。 */
export function openExternalQuiet(url: string): void {
  void openExternalUrl(url).catch(() => undefined)
}

export function openLoginQuiet(url: string): void {
  void openLoginUrl(url).catch(() => undefined)
}
