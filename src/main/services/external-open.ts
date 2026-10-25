/** 统一的外部链接打开：Windows 优先用系统 URL 处理器，失败时复制链接，避免静默无反应。 */
import { clipboard, shell } from 'electron'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { log } from './logger'

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

function loginBrowserProfile(): string {
  const base = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? process.env.TEMP ?? '.'
  const profile = join(base, 'Morrow', 'login-browser')
  try {
    mkdirSync(profile, { recursive: true })
  } catch {
    // 目录不可用时仍带上路径，让浏览器自行处理
  }
  return profile
}

function launchViaCmdStart(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let stdout = ''
    let stderr = ''
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(ok)
    }
    const child = spawn('cmd.exe', ['/c', 'start', '""', `"${url}"`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments: true
    })
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish(false)
    }, 3_000)
    child.once('error', () => finish(false))
    child.once('close', (code) => {
      if (code === 0) finish(true)
      else {
        // 记录失败原因但不输出授权 URL；调用方会继续尝试独立浏览器配置。
        log.warn('login browser cmd start failed', { code, stderr: stderr.trim().slice(0, 300), stdout: stdout.trim().slice(0, 300) })
        finish(false)
      }
    })
  })
}

function launchBrowser(exe: string, url: string, dedicated = false): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(ok)
    }
    const args = dedicated
      ? /firefox/i.test(exe)
        ? ['-profile', loginBrowserProfile(), '-new-window', url]
        : [`--user-data-dir=${loginBrowserProfile()}`, '--no-first-run', '--new-window', url]
      : [url]
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true })
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
    const browsers = windowsBrowserCandidates().filter((browser) => existsSync(browser))
    try {
      clipboard.writeText(url)
    } catch {
      // 剪贴板不可用时仍继续尝试浏览器
    }
    // 参考 dsh-chatgpt-subscription：Windows 用 cmd /c start 交给系统 ShellExecute；
    // 这比直接 spawn 浏览器更能兼容默认关联与既有实例。
    if (await launchViaCmdStart(url)) return { opened: true, copied: true }
    // 系统关联不可用时，再用独立配置直连浏览器兜底。
    for (const browser of browsers) {
      if (await launchBrowser(browser, url, true)) return { opened: true, copied: true }
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
