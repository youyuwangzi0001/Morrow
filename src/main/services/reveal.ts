/**
 * 在系统文件管理器中定位文件 / 用系统默认程序打开文件。
 *
 * Windows 上从受限会话创建 explorer.exe 子进程（或 shell.openPath 一个目录）会以
 * 0xC0000142 失败并弹出系统错误框。便携启动器通过命名管道代理 SHELL 请求；代理不可用时，
 * 这里用 PowerShell 调用现有 Shell 的 COM 接口完成定位，同样不创建新的 Explorer 进程。
 * SHOpenFolderAndSelectItems 与 Shell.Application.Explore 都由已运行的 shell 执行。
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { shell } from 'electron'
import { log } from './logger'

const LAUNCHER_PIPE_ENV = 'MORROW_LAUNCHER_PIPE'
const BROKER_TIMEOUT_MS = 2_500
const SHELL_HELPER_TIMEOUT_MS = 8_000

type BrokerResult =
  | { kind: 'ok' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }

/**
 * 请求启动器代理执行 OPEN / REVEAL。代理只接受绝对且真实存在的路径；
 * 通过命名管道传递 Base64，避免引号、空格和中文路径的转义问题。
 */
function askLauncher(command: 'OPEN' | 'REVEAL', target: string): Promise<BrokerResult> {
  const pipe = process.env[LAUNCHER_PIPE_ENV]?.trim()
  if (process.platform !== 'win32' || !pipe) return Promise.resolve({ kind: 'unavailable' })
  return new Promise((resolve) => {
    let settled = false
    let buffer = ''
    let attempt = 0
    let socket: ReturnType<typeof connect> | null = null

    const finish = (result: BrokerResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      resolve(result)
    }
    let timer: NodeJS.Timeout

    const start = (): void => {
      buffer = ''
      socket = connect(`\\\\.\\pipe\\${pipe}`)
      socket.setEncoding('utf8')
      socket.on('connect', () => {
        socket?.write(`${command} ${Buffer.from(target, 'utf8').toString('base64')}\n`)
      })
      socket.on('data', (chunk: string) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline).trim()
        if (line === 'OK') {
          finish({ kind: 'ok' })
          return
        }
        finish({ kind: 'error', message: line.replace(/^ERR\t?/, '').trim() || '启动器代理执行失败' })
      })
      socket.on('error', (err: NodeJS.ErrnoException) => {
        // 启动器可能比 Electron 晚准备好命名管道；短暂重试，避免第一次点击落空。
        if ((err.code === 'ENOENT' || err.code === 'ECONNREFUSED') && attempt < 2) {
          attempt += 1
          setTimeout(start, 180)
          return
        }
        finish({ kind: 'error', message: err.message })
      })
      socket.on('close', () => finish({ kind: 'error', message: '启动器代理连接已关闭' }))
    }

    timer = setTimeout(() => finish({ kind: 'error', message: '启动器代理响应超时' }), BROKER_TIMEOUT_MS)
    start()
  })
}

// 由已运行的 Explorer 执行：REVEAL 优先复用/打开目标文件夹并选中文件；EXPLORE 只打开文件夹。
const SHELL_HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = $env:MORROW_SHELL_TARGET
$mode = $env:MORROW_SHELL_MODE
$item = Get-Item -LiteralPath $target -Force
$shell = New-Object -ComObject Shell.Application
if ($mode -eq 'REVEAL' -and -not $item.PSIsContainer) {
  $folder = $item.DirectoryName
  $name = $item.Name
  $window = $null
  foreach ($candidate in $shell.Windows()) {
    try {
      if ($candidate.Document.Folder.Self.Path -ieq $folder) { $window = $candidate; break }
    } catch { }
  }
  if ($null -eq $window) {
    $shell.Explore($folder) | Out-Null
    Start-Sleep -Milliseconds 700
    foreach ($candidate in $shell.Windows()) {
      try {
        if ($candidate.Document.Folder.Self.Path -ieq $folder) { $window = $candidate; break }
      } catch { }
    }
  }
  if ($null -ne $window) {
    try {
      $window.Visible = $true
      $entry = $shell.Namespace($folder).ParseName($name)
      if ($null -ne $entry) { $window.Document.SelectItem($entry, 1) }
    } catch { }
  } else {
    $shell.Explore($folder) | Out-Null
  }
} else {
  $folder = $item.FullName
  if (-not $item.PSIsContainer) { $folder = $item.DirectoryName }
  $shell.Explore($folder) | Out-Null
}
Start-Sleep -Milliseconds 200
exit 0
`

/**
 * 启动器代理不可用时的兜底：用 PowerShell 驱动现有 Shell 打开/定位。
 * 不创建 explorer.exe，因此不会在受限会话里触发 0xC0000142 错误框。
 */
function runShellHelper(target: string, mode: 'REVEAL' | 'EXPLORE'): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve('仅支持 Windows')
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const finish = (error: string | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(error)
    }
    try {
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          Buffer.from(SHELL_HELPER_SCRIPT, 'utf16le').toString('base64')
        ],
        {
          windowsHide: true,
          stdio: 'ignore',
          env: { ...process.env, MORROW_SHELL_TARGET: target, MORROW_SHELL_MODE: mode }
        }
      )
      child.on('error', (err) => finish(err.message))
      child.on('exit', (code) => finish(code === 0 ? null : `系统 Shell 辅助进程退出码 ${code ?? '未知'}`))
      timer = setTimeout(() => {
        finish('系统 Shell 辅助进程超时')
        child.kill()
      }, SHELL_HELPER_TIMEOUT_MS)
      child.unref()
    } catch (err) {
      finish(err instanceof Error ? err.message : String(err))
    }
  })
}

function existingTarget(absolutePath: string): boolean {
  try {
    return existsSync(absolutePath)
  } catch {
    return false
  }
}

function isDirectoryPath(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isDirectory()
  } catch {
    return false
  }
}

/**
 * 在资源管理器中选中目标。返回 null 表示已成功（至少已交给系统），
 * 返回字符串表示所有方式都失败的原因。
 */
export async function revealInFileManager(absolutePath: string): Promise<string | null> {
  if (!existingTarget(absolutePath)) return '文件不存在或已被移动。'

  if (process.platform !== 'win32') {
    try {
      shell.showItemInFolder(absolutePath)
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  // Windows 受限会话里启动器代理可能卡在 Shell COM；先走 PowerShell Shell 助手，
  // 只有助手失败时才回退到启动器代理。
  const helperError = await runShellHelper(absolutePath, 'REVEAL')
  if (!helperError) return null
  log.warn('shell helper reveal failed', { path: absolutePath, error: helperError })

  const broker = await askLauncher('REVEAL', absolutePath)
  if (broker.kind === 'ok') return null
  if (broker.kind === 'error') log.warn('launcher reveal failed', { path: absolutePath, error: broker.message })

  return broker.kind === 'error' ? broker.message : helperError
}

/** 用系统默认程序打开文件/文件夹。返回 null 表示成功，字符串表示错误。 */
export async function openPathFromUserShell(absolutePath: string): Promise<string | null> {
  if (!existingTarget(absolutePath)) return '文件不存在或已被移动。'

  if (process.platform !== 'win32') {
    const error = await shell.openPath(absolutePath)
    return error || null
  }

  // 目录必须交给现有 Shell 打开；shell.openPath(目录) 会新建 explorer.exe 并弹 0xC0000142。
  // 先走 PowerShell Shell 助手，避免启动器代理在部分会话里卡在 Shell COM。
  if (isDirectoryPath(absolutePath)) {
    // 自动化测试里不拉起真实的资源管理器窗口，直接走 shell.openPath 便于断言错误。
    if (process.env.MORROW_TEST === '1') {
      const testError = await shell.openPath(absolutePath)
      return testError || null
    }
    const helperError = await runShellHelper(absolutePath, 'EXPLORE')
    if (!helperError) return null
    log.warn('shell helper open failed', { path: absolutePath, error: helperError })
    const broker = await askLauncher('OPEN', absolutePath)
    if (broker.kind === 'ok') return null
    return broker.kind === 'error' ? broker.message : helperError
  }

  const broker = await askLauncher('OPEN', absolutePath)
  if (broker.kind === 'ok') return null
  if (broker.kind === 'error') log.warn('launcher open failed', { path: absolutePath, error: broker.message })

  // 非 HTML 文件优先用 ShellExecute；HTML 成品已由画布内置浏览器处理，不会再触发 Edge 提权提示。
  const shellError = await shell.openPath(absolutePath)
  if (!shellError) return null

  return broker.kind === 'error' ? broker.message : shellError
}

