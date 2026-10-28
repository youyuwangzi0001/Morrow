/**
 * 在系统文件管理器中定位文件 / 用系统默认程序打开文件。
 *
 * 打包版由启动器通过任务计划程序拉起一个普通权限的代理进程，代理把请求交给
 * 已运行的 Explorer；Electron 自己不创建 explorer.exe（受限会话里会 0xC0000142），
 * 也不调用会挂起的 Shell COM。代理不可用时，开发模式退回 Electron 自带的 Shell。
 */
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { shell } from 'electron'
import { log } from './logger'

const LAUNCHER_PIPE_ENV = 'MORROW_LAUNCHER_PIPE'
const BROKER_TIMEOUT_MS = 5_000
const CONNECT_RETRIES = 5
const RETRY_DELAY_MS = 250

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
    let timer: NodeJS.Timeout

    const finish = (result: BrokerResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      resolve(result)
    }

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
        // 任务代理刚被系统拉起来时管道可能晚几十毫秒；短暂重试，避免第一次点击落空。
        if ((err.code === 'ENOENT' || err.code === 'ECONNREFUSED') && attempt < CONNECT_RETRIES) {
          attempt += 1
          setTimeout(start, RETRY_DELAY_MS)
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

function existingTarget(absolutePath: string): boolean {
  try {
    return existsSync(absolutePath)
  } catch {
    return false
  }
}

/**
 * 在资源管理器中选中目标。返回 null 表示已成功（至少已交给系统），
 * 返回字符串表示失败原因。
 */
export async function revealInFileManager(absolutePath: string): Promise<string | null> {
  if (!existingTarget(absolutePath)) return '文件不存在或已被移动。'

  if (process.platform === 'win32' && process.env[LAUNCHER_PIPE_ENV]?.trim()) {
    const broker = await askLauncher('REVEAL', absolutePath)
    if (broker.kind === 'ok') return null
    if (broker.kind === 'error') {
      log.warn('launcher reveal failed', { path: absolutePath, error: broker.message })
      return broker.message
    }
  }

  try {
    shell.showItemInFolder(absolutePath)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** 用系统默认程序打开文件/文件夹。返回 null 表示成功，字符串表示错误。 */
export async function openPathFromUserShell(absolutePath: string): Promise<string | null> {
  if (!existingTarget(absolutePath)) return '文件不存在或已被移动。'

  if (process.platform === 'win32' && process.env[LAUNCHER_PIPE_ENV]?.trim()) {
    const broker = await askLauncher('OPEN', absolutePath)
    if (broker.kind === 'ok') return null
    if (broker.kind === 'error') {
      log.warn('launcher open failed', { path: absolutePath, error: broker.message })
      return broker.message
    }
  }

  const error = await shell.openPath(absolutePath)
  return error || null
}
