/**
 * 在系统文件管理器中定位文件 / 用系统默认程序打开文件。
 *
 * Windows 上从 Electron 主进程直接 spawn explorer.exe 在部分会话/作业对象里会以
 * 0xC0000142（DLL 初始化失败）退出，表现为按钮点击后毫无反应。便携启动器现在会在
 * 应用外部提供一个命名管道代理（MORROW_LAUNCHER_PIPE），由普通 Win32 进程执行
 * ShellExecute；这里优先走代理，失败再回退到 Electron shell / explorer 命令。
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import { shell } from 'electron'
import { log } from './logger'

const LAUNCHER_PIPE_ENV = 'MORROW_LAUNCHER_PIPE'
const BROKER_TIMEOUT_MS = 2_500

export function explorerSelectArgs(absolutePath: string): string[] {
  // 与 windowsVerbatimArguments 搭配：由我们给出 `/select,"<path>"` 的最终命令行形态。
  return [`/select,"${absolutePath}"`]
}

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

/** spawn explorer.exe；能识别 0xC0000142，避免把“没打开”误报成成功。 */
function spawnExplorer(args: string[], verbatim = true): Promise<string | null> {
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
      const child = spawn('explorer.exe', args, {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: verbatim
      })
      child.on('error', (err) => finish(err.message))
      child.on('exit', (code) => {
        // Explorer 成功把请求交给现有 shell 后通常也以 1 退出；只有 DLL 初始化失败才回退。
        if (code === 0xc0000142) finish('Explorer 无法在当前会话中启动（0xC0000142）')
        else finish(null)
      })
      // 有些环境下 Explorer 交接后不返回退出事件，不能无限等待。
      timer = setTimeout(() => finish(null), 1_500)
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

function containingFolder(absolutePath: string): string {
  try {
    return statSync(absolutePath).isDirectory() ? absolutePath : dirname(absolutePath)
  } catch {
    return dirname(absolutePath)
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

  const broker = await askLauncher('REVEAL', absolutePath)
  if (broker.kind === 'ok') return null
  if (broker.kind === 'error') log.warn('launcher reveal failed', { path: absolutePath, error: broker.message })

  // 不再直接 spawn explorer.exe：受限会话里它会弹出 0xC0000142 应用程序错误。
  // 启动器代理不可用时，退化为用系统 Shell 打开所在文件夹（至少能继续操作）。
  const folder = containingFolder(absolutePath)
  const openError = await shell.openPath(folder)
  if (!openError) return null
  log.warn('shell open folder failed', { path: absolutePath, error: openError })

  // 最后一次尝试：Electron 的“选中文件”接口；失败时无返回值，只能作为兜底。
  try {
    shell.showItemInFolder(absolutePath)
    return null
  } catch (err) {
    log.warn('shell reveal fallback failed', { path: absolutePath, error: String(err) })
  }

  return broker.kind === 'error' ? broker.message : openError
}

/** 用系统默认程序打开文件/文件夹。返回 null 表示成功，字符串表示错误。 */
export async function openPathFromUserShell(absolutePath: string): Promise<string | null> {
  if (!existingTarget(absolutePath)) return '文件不存在或已被移动。'

  const broker = await askLauncher('OPEN', absolutePath)
  if (broker.kind === 'ok') return null
  if (broker.kind === 'error') log.warn('launcher open failed', { path: absolutePath, error: broker.message })

  if (process.platform !== 'win32') {
    const error = await shell.openPath(absolutePath)
    return error || null
  }

  // 非 HTML 文件优先用 ShellExecute；HTML 成品已由画布内置浏览器处理，不会再触发 Edge 提权提示。
  const shellError = await shell.openPath(absolutePath)
  if (!shellError) return null

  const spawnError = await spawnExplorer([absolutePath], false)
  if (!spawnError) return null

  return broker.kind === 'error' ? broker.message : (shellError || spawnError)
}

/** 打开数据目录、日志目录、技能目录等系统文件夹。 */
export async function openSystemFolder(absolutePath: string): Promise<string | null> {
  return openPathFromUserShell(absolutePath)
}
