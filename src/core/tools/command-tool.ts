/**
 * run_command：在工作区内执行命令。
 *
 * 安全与体验约束（ARCHITECTURE §6）：
 * - Windows 用 powershell -NoProfile -NonInteractive -Command；其它平台用 /bin/sh -lc；
 * - cwd 必须在工作区内（realpath 沙箱），不含用户环境里的 API Key 等敏感变量；
 * - 默认 120s 超时、上限 300s；输出硬截断 32KB；中断时杀掉整个进程树（taskkill /T）；
 * - 危险命令识别在权限层（permissions.ts），这里只负责真实执行。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { ToolResult } from '../../shared/types'
import type { ToolContext } from '../types'
import { clampInt, formatDuration } from '../util'
import { getNumber, getString } from './args'
import { errResult, okResult, oneLineInput, type ToolImpl } from './types'
import { displayPath, resolveWorkspacePath } from './paths'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 300_000
const MAX_OUTPUT_BYTES = 32 * 1024
const MAX_COMMAND_CHARS = 8000

/** 清除会泄露密钥的环境变量；补充让子进程输出稳定的变量 */
const SENSITIVE_ENV = /(?:API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|AUTH|COOKIE|SESSION[_-]?KEY|DEEPSEEK|OPENAI|ANTHROPIC|MOONSHOT|MORROW)/i

export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV.test(key)) continue
    out[key] = value
  }
  out.NO_COLOR = '1'
  out.FORCE_COLOR = '0'
  out.PYTHONIOENCODING = 'utf-8'
  out.PYTHONUTF8 = '1'
  out.CLICOLOR = '0'
  return out
}

/** 杀掉整个进程树：Windows 用 taskkill /T，Unix 用进程组 */
export function killProcessTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        env: sanitizeEnv(process.env)
      })
    } catch {
      // 进程可能已退出
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 进程可能已退出
      }
    }
  }
}

function buildLaunch(command: string): { file: string; args: string[]; detached: boolean } {
  if (process.platform === 'win32') {
    // 强制 PowerShell 以 UTF-8 输出，避免中文乱码；$ProgressPreference 防止进度条污染输出
    const prefix =
      "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); " +
      '$OutputEncoding=[Console]::OutputEncoding; $ProgressPreference="SilentlyContinue"; '
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prefix + command],
      detached: false
    }
  }
  return { file: '/bin/sh', args: ['-lc', command], detached: true }
}

interface CapturedOutput {
  stdout: Buffer[]
  stderr: Buffer[]
  totalBytes: number
  truncated: boolean
}

function captureChunk(output: CapturedOutput, chunks: Buffer[], chunk: Buffer): void {
  if (output.totalBytes >= MAX_OUTPUT_BYTES) {
    output.truncated = true
    return
  }
  const remaining = MAX_OUTPUT_BYTES - output.totalBytes
  if (chunk.length > remaining) {
    chunks.push(chunk.subarray(0, remaining))
    output.totalBytes = MAX_OUTPUT_BYTES
    output.truncated = true
  } else {
    chunks.push(chunk)
    output.totalBytes += chunk.length
  }
}

function formatTranscript(parts: {
  command: string
  cwd: string
  durationMs: number
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  killConfirmed: boolean
  stdout: string
  stderr: string
  truncated: boolean
}): string {
  const termination = parts.timedOut
    ? parts.killConfirmed
      ? '已超时终止（进程已确认结束）'
      : '已超时终止（未能确认进程完全退出）'
    : parts.aborted
      ? parts.killConfirmed
        ? '已中断（进程已确认结束）'
        : '已中断（未能确认进程完全退出）'
      : ''
  const status = [
    `exit ${parts.exitCode ?? '?'}`,
    formatDuration(parts.durationMs),
    termination
  ]
    .filter(Boolean)
    .join(' · ')
  const lines = [`$ ${parts.command.replace(/\r?\n/g, ' ; ').slice(0, 400)}`, `${parts.cwd} · ${status}`]
  if (parts.stdout) lines.push('', parts.stdout)
  else if (!parts.stderr) lines.push('', '（命令没有输出）')
  if (parts.stderr) lines.push('', '[stderr]', parts.stderr)
  if (parts.truncated) lines.push('', `…（输出超过 ${MAX_OUTPUT_BYTES / 1024}KB，已截断）`)
  return lines.join('\n')
}

export const runCommandTool: ToolImpl = {
  definition: {
    name: 'run_command',
    description:
      '在工作区内执行一条命令（Windows 默认 PowerShell，其它平台 sh）。适合做计算、批处理、跑脚本、验证结果。' +
      '默认 120 秒超时，输出最多 32KB；工作目录必须在工作区内。危险命令（格式化磁盘/关机/删库/远程脚本等）会被权限层拦截。' +
      '执行前先想清楚命令是否只读、会不会覆盖用户文件；优先使用能明确看到结果的命令。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令，例如 "Get-ChildItem" 或 "python analyze.py"' },
        cwd: { type: 'string', description: '工作目录，相对工作区根目录（默认工作区根）' },
        timeout_ms: { type: 'number', description: '超时毫秒数，默认 120000，上限 300000' }
      },
      required: ['command']
    },
    category: 'exec',
    risk: 'medium',
    titleFor: (input) => `运行命令 ${oneLineInput(input, 'command', 60)}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const command = getString(input, 'command', { required: true, trim: false, maxLength: MAX_COMMAND_CHARS })
    const cwdInput = getString(input, 'cwd', { defaultValue: '.' }) || '.'
    const timeoutMs = clampInt(
      getNumber(input, 'timeout_ms', { defaultValue: DEFAULT_TIMEOUT_MS, min: 1000, max: MAX_TIMEOUT_MS }),
      1000,
      MAX_TIMEOUT_MS
    )
    const resolved = resolveWorkspacePath(cwdInput, ctx.workspace, {
      escapeApproved: ctx.escapeApproved,
      requireExist: true,
      requireDirectory: true
    })
    const cwd = resolved.real
    const displayCwd = displayPath(resolved.absolute, ctx.workspace)
    const startedAt = Date.now()
    const baseMeta: Record<string, unknown> = {
      command,
      cwd: displayCwd,
      absoluteCwd: resolved.absolute,
      timeoutMs
    }
    if (ctx.signal.aborted) {
      return errResult('命令执行被中断（本轮运行已停止）。', undefined, { ...baseMeta, aborted: true })
    }

    const { file, args, detached } = buildLaunch(command)
    let child: ChildProcess
    try {
      child = spawn(file, args, {
        cwd,
        env: sanitizeEnv(process.env),
        windowsHide: true,
        detached,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      return errResult(
        `无法启动命令解释器：${err instanceof Error ? err.message : String(err)}`,
        '这通常是系统环境异常，可以尝试重启 Morrow 后重试。',
        baseMeta
      )
    }

    return await new Promise<ToolResult>((resolvePromise) => {
      const output: CapturedOutput = { stdout: [], stderr: [], totalBytes: 0, truncated: false }
      let settled = false
      let timedOut = false
      let aborted = false
      let exitCode: number | null = null
      let processExited: boolean | null = null
      let timer: ReturnType<typeof setTimeout> | null = null
      let hardKillTimer: ReturnType<typeof setTimeout> | null = null
      let settleTimer: ReturnType<typeof setTimeout> | null = null
      let terminating = false

      const clearTimers = (): void => {
        if (timer) clearTimeout(timer)
        if (hardKillTimer) clearTimeout(hardKillTimer)
        if (settleTimer) clearTimeout(settleTimer)
      }

      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimers()
        ctx.signal.removeEventListener('abort', onAbort)
        const durationMs = Date.now() - startedAt
        const killConfirmed = processExited === true || exitCode !== null
        const stdout = Buffer.concat(output.stdout).toString('utf8')
        const stderr = Buffer.concat(output.stderr).toString('utf8')
        const transcript = formatTranscript({
          command,
          cwd: displayCwd,
          durationMs,
          exitCode,
          timedOut,
          aborted,
          killConfirmed,
          stdout,
          stderr,
          truncated: output.truncated
        })
        const meta: Record<string, unknown> = {
          ...baseMeta,
          exitCode,
          durationMs,
          timedOut,
          aborted,
          truncated: output.truncated,
          capturedBytes: output.totalBytes,
          // R7 审计：超时/取消不仅要发 kill，还要报告是否确认子进程已结束，
          // 避免「界面显示已停止、后台还在跑」。
          processExited: processExited === true,
          killConfirmed
        }
        if (aborted) {
          const result = errResult(
            killConfirmed
              ? '命令执行被中断（用户停止了本轮运行），进程已确认结束。'
              : '命令执行被中断（用户停止了本轮运行），但未能确认子进程已完全退出，可能有残留进程。',
            '如需继续，请重新发起任务。',
            meta
          )
          result.output = transcript
          resolvePromise(result)
          return
        }
        if (timedOut) {
          const result = errResult(
            killConfirmed
              ? `命令执行超时（超过 ${(timeoutMs / 1000).toFixed(0)} 秒），已强制终止并确认进程结束。`
              : `命令执行超时（超过 ${(timeoutMs / 1000).toFixed(0)} 秒），已尝试强制终止，但未能确认子进程完全退出（可能有残留进程）。`,
            '如果是大型任务，可以拆分步骤、减少处理的数据量，或提高 timeout_ms（上限 300000）。',
            meta
          )
          result.output = transcript
          resolvePromise(result)
          return
        }
        if (exitCode !== 0) {
          const result = errResult(
            `命令执行失败（退出码 ${exitCode ?? '未知'}）。`,
            '检查命令语法、文件路径是否正确；如果是脚本报错，先读一下错误信息再修改。',
            meta
          )
          result.output = transcript
          resolvePromise(result)
          return
        }
        resolvePromise(okResult(transcript, meta, durationMs))
      }

      /**
       * 超时/取消：先杀整棵进程树，再用硬兜底保证一定能返回。
       * 旧实现只发 taskkill 然后等 child 'close'：Windows 上孙进程可能继承 stdout 管道，
       * 管道不关闭会让 'close' 延迟数秒（审计实测 ~6s），这也是「停止后还在写文件」的温床。
       */
      const terminate = (reason: 'timeout' | 'abort'): void => {
        if (terminating) return
        terminating = true
        if (reason === 'timeout') timedOut = true
        else aborted = true
        killProcessTree(child.pid)
        hardKillTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // 进程可能已退出
          }
        }, 500)
        settleTimer = setTimeout(() => {
          killProcessTree(child.pid)
          finish()
        }, 2500)
      }

      child.stdout?.on('data', (chunk: Buffer) => captureChunk(output, output.stdout, chunk))
      child.stderr?.on('data', (chunk: Buffer) => captureChunk(output, output.stderr, chunk))
      child.on('error', (err) => {
        exitCode = exitCode ?? 1
        processExited = processExited ?? false
        output.stderr.push(Buffer.from(`进程启动失败：${err.message}\n`))
        finish()
      })
      // 超时/取消时用 exit 而不是 close 收尾：exit 代表主进程已结束，close 可能被孙进程的管道拖住
      child.on('exit', (code) => {
        exitCode = code
        processExited = true
        if (terminating) finish()
      })
      child.on('close', (code) => {
        if (processExited === null) {
          exitCode = code
          processExited = true
        }
        finish()
      })

      timer = setTimeout(() => {
        terminate('timeout')
      }, timeoutMs)
      const onAbort = (): void => {
        terminate('abort')
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}
