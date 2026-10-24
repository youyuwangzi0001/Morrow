/** 统一的外部链接打开：Windows 优先用系统 URL 处理器，失败时复制链接，避免静默无反应。 */
import { clipboard, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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

/** 不关心结果的场景（登录授权页、后台提示）；失败时仍有剪贴板兜底。 */
export function openExternalQuiet(url: string): void {
  void openExternalUrl(url).catch(() => undefined)
}
