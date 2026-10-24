/** 统一的外部链接打开：Windows 优先用系统 URL 处理器，失败时复制链接，避免静默无反应。 */
import { clipboard, shell } from 'electron'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function windowsBrowserCandidates(): string[] {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA
  const edge = [
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ]
  const chrome = [
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ...(localAppData ? [join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')] : [])
  ]
  const firefox = [join(programFiles, 'Mozilla Firefox', 'firefox.exe')]
  const brave = [join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')]
  let defaultProgId = ''
  try {
    defaultProgId = execFileSync('reg.exe', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
      '/v',
      'ProgId'
    ], { encoding: 'utf8', windowsHide: true, timeout: 2_000 })
  } catch {
    // 系统没有默认浏览器关联时仍使用已安装浏览器兜底
  }
  const order = /Chrome/i.test(defaultProgId)
    ? [...chrome, ...edge]
    : /Firefox/i.test(defaultProgId)
      ? [...firefox, ...edge, ...chrome]
      : [...edge, ...chrome]
  return [...order, ...firefox, ...brave]
}

function launchBrowser(exe: string, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(ok)
    }
    const child = spawn(exe, [url], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    timer = setTimeout(() => finish(true), 800)
    child.once('error', () => finish(false))
    child.once('spawn', () => finish(true))
  })
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
 * 登录授权页专用：直接拉起已安装浏览器，避免系统 URL 关联失效或 shell/rundll32
 * 在受限环境里“返回成功但没打开”的静默失败。
 */
export async function openLoginUrl(url: string): Promise<{ opened: boolean; copied: boolean }> {
  if (!isHttpUrl(url)) throw new Error('只能打开 http(s) 链接。')
  if (process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')) {
    clipboard.writeText(url)
    return { opened: false, copied: true }
  }
  if (process.platform === 'win32') {
    for (const browser of windowsBrowserCandidates()) {
      if (!existsSync(browser)) continue
      if (await launchBrowser(browser, url)) return { opened: true, copied: false }
    }
  }
  return openExternalUrl(url)
}

/** 不关心结果的场景（登录授权页、后台提示）；失败时仍有剪贴板兜底。 */
export function openExternalQuiet(url: string): void {
  void openExternalUrl(url).catch(() => undefined)
}

export function openLoginQuiet(url: string): void {
  void openLoginUrl(url).catch(() => undefined)
}
