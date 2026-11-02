/**
 * 运行钩子（P1-12）。
 *
 * 钩子只来自用户在设置里显式添加并启用的命令，不读取项目文件，避免打开陌生仓库即执行代码。
 * 通过系统 shell 执行（Windows: cmd /c；其它: sh -lc），JSON 载荷写入 stdin，
 * 并注入 MORROW_HOOK_EVENT / MORROW_WORKSPACE。单次 15s 超时，stdout/stderr 各 16KB 上限。
 *
 * 事件：
 * - user_prompt_submit：发送消息前运行；退出码 2 阻止本轮并显示输出；
 * - post_tool_use：每次工具结束后运行（观察型，不阻断）；
 * - run_finished：每轮结束后运行（观察型）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { HookEvent } from '../../shared/types'
import { MAX_ENABLED_HOOKS_PER_EVENT } from '../../shared/types'
import { getSettingsStore } from './settings-store'
import { log } from './logger'

const HOOK_TIMEOUT_MS = 15_000
const MAX_STREAM = 16 * 1024
const MAX_INPUT = 200 * 1024

export interface HookResult {
  hookId: string
  event: HookEvent
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  durationMs: number
}

/** shell:true 在 Windows 上会多一层 cmd.exe，只 kill 外壳会留下仍在运行的子进程。 */
function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform !== 'win32') {
    try {
      child.kill('SIGKILL')
    } catch {
      // ignore
    }
    return
  }
  try {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    killer.on('error', () => {
      try {
        child.kill()
      } catch {
        // ignore
      }
    })
    killer.unref()
  } catch {
    try {
      child.kill()
    } catch {
      // ignore
    }
  }
}

function workingDirectory(workspace: string | null): string {
  try {
    if (workspace && existsSync(workspace) && statSync(workspace).isDirectory()) return workspace
  } catch {
    // fall through
  }
  return homedir()
}

function runHook(
  hook: { id: string; event: HookEvent; command: string },
  payload: unknown,
  workspace: string | null
): Promise<HookResult> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const child = spawn(hook.command, {
      cwd: workingDirectory(workspace),
      windowsHide: true,
      shell: true,
      env: {
        ...process.env,
        MORROW_HOOK_EVENT: hook.event,
        MORROW_WORKSPACE: workspace ?? ''
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const result: HookResult = {
        hookId: hook.id,
        event: hook.event,
        exitCode,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt
      }
      if (exitCode !== 0 || timedOut) {
        log.warn('hook finished with error', {
          hookId: hook.id,
          event: hook.event,
          exitCode,
          timedOut,
          durationMs: result.durationMs,
          stderr: stderr.slice(0, 300)
        })
      }
      resolvePromise(result)
    }

    const timer = setTimeout(() => {
      timedOut = true
      terminateProcessTree(child)
      finish(null)
    }, HOOK_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_STREAM) stdout += chunk.toString('utf8').slice(0, MAX_STREAM - stdout.length)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STREAM) stderr += chunk.toString('utf8').slice(0, MAX_STREAM - stderr.length)
    })
    child.on('error', (err) => {
      stderr = `${stderr}\n${err.message}`.trim().slice(0, MAX_STREAM)
      finish(null)
    })
    child.on('close', (code) => finish(typeof code === 'number' ? code : null))

    child.stdin?.on('error', () => undefined)
    try {
      const body = JSON.stringify(payload ?? {})
      child.stdin?.end(body.length > MAX_INPUT ? `${body.slice(0, MAX_INPUT)}\n[payload truncated]` : body)
    } catch {
      child.stdin?.end('{}')
    }
  })
}

/** 运行某个事件下的全部启用钩子（顺序执行，最多 5 个）。 */
export async function runHooks(
  event: HookEvent,
  payload: unknown,
  workspace: string | null,
  options: { stopOnExit2?: boolean } = {}
): Promise<HookResult[]> {
  const hooks = getSettingsStore()
    .get()
    .hooks.filter((hook) => hook.enabled && hook.event === event)
    .slice(0, MAX_ENABLED_HOOKS_PER_EVENT)
  if (hooks.length === 0) return []
  const results: HookResult[] = []
  for (const hook of hooks) {
    const result = await runHook(hook, payload, workspace)
    results.push(result)
    // 发送前钩子被拒绝后不再执行后续钩子，避免已取消的发送继续产生副作用
    if (options.stopOnExit2 && result.exitCode === 2) break
  }
  return results
}

/** 发送消息前的阻断判断：退出码 2 = 阻止；其它失败只记录，不阻止用户。 */
export async function runPromptHooks(
  payload: unknown,
  workspace: string | null
): Promise<{ blocked: boolean; reason?: string }> {
  const results = await runHooks('user_prompt_submit', payload, workspace, { stopOnExit2: true })
  const blocking = results.find((result) => result.exitCode === 2)
  if (!blocking) return { blocked: false }
  const detail = `${blocking.stdout}\n${blocking.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 1200)
  return { blocked: true, reason: detail || '「发送消息前」的自动动作拒绝了这条消息。' }
}
