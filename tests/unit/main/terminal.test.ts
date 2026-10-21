/**
 * P0-1 终端/后台任务：持久 shell 输入输出、后台任务日志/退出、一次性命令。
 * 使用本机 PowerShell/sh，不依赖 Electron。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { TerminalManager } from '../../../src/main/services/terminal-manager'
import { makeTempWorkspace } from '../core/helpers/workspace'

const managers: TerminalManager[] = []
afterEach(() => {
  while (managers.length) managers.pop()?.dispose()
})

function makeManager(): TerminalManager {
  const manager = new TerminalManager()
  managers.push(manager)
  return manager
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('等待终端输出超时')
}

describe('TerminalManager', () => {
  it('persistent shell keeps stdin/stdout and can be stopped', async () => {
    const ws = makeTempWorkspace()
    try {
      const manager = makeManager()
      const shell = manager.createShell(ws.root, '测试终端')
      expect(shell.kind).toBe('shell')
      expect(shell.status).toBe('running')
      manager.write(shell.id, "Write-Output 'hello-terminal'")
      await waitFor(() => manager.read(shell.id).output.includes('hello-terminal'))
      manager.write(shell.id, "Write-Output 'second-line'")
      await waitFor(() => manager.read(shell.id).output.includes('second-line'))
      manager.stop(shell.id)
      await waitFor(() => manager.get(shell.id)?.status === 'exited')
    } finally {
      ws.cleanup()
    }
  })

  it('shell runs inside a real PTY and accepts resize', async () => {
    if (process.platform !== 'win32') return
    const ws = makeTempWorkspace()
    try {
      const manager = makeManager()
      const shell = manager.createShell(ws.root, 'PTY 检测')
      expect(shell.pid).toBeGreaterThan(0)
      manager.resize(shell.id, 100, 30)
      manager.write(
        shell.id,
        "if ([Console]::IsOutputRedirected) { 'PTY_' + 'MISSING' } else { 'PTY_' + 'ACTIVE' }"
      )
      await waitFor(() => manager.read(shell.id).output.includes('PTY_ACTIVE'))
      expect(manager.read(shell.id).output).not.toContain('PTY_MISSING')
      manager.stop(shell.id)
      await waitFor(() => manager.get(shell.id)?.status === 'exited')
      manager.dispose()
      // Windows 上 ConPTY 宿主释放工作目录比 onExit 稍晚
      await new Promise((resolve) => setTimeout(resolve, 900))
    } finally {
      try {
        ws.cleanup()
      } catch (err) {
        // PTY 句柄释放有延迟时，临时目录留给系统清理
        if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err
      }
    }
  })

  it('runs commands through the command prompt and Git Bash when available', async () => {
    if (process.platform !== 'win32') return
    const ws = makeTempWorkspace()
    try {
      const manager = makeManager()
      const ids = manager.profiles().map((profile) => profile.id)
      expect(ids).toContain('powershell')
      const cases: Array<{ id: string; command: string; expected: string; cwd?: string }> = [
        { id: 'cmd', command: 'echo %OS%_cmd_ok', expected: 'Windows_NT_cmd_ok' },
        { id: 'gitbash', command: "printf 'gitbash_%s\\n' ok", expected: 'gitbash_ok' }
      ]
      for (const item of cases) {
        if (!ids.includes(item.id)) continue
        const shell = manager.createShell(ws.root, `测试 ${item.id}`, item.id)
        expect(shell.shellId).toBe(item.id)
        manager.write(shell.id, item.command)
        await waitFor(() => manager.read(shell.id).output.includes(item.expected))
        if (item.cwd) {
          await waitFor(() => manager.read(shell.id).output.includes(item.cwd!))
        }
        manager.stop(shell.id)
        await waitFor(() => manager.get(shell.id)?.status === 'exited')
      }
    } finally {
      ws.cleanup()
    }
  })

  it('background task streams logs, exits and can be restarted', async () => {
    const ws = makeTempWorkspace()
    try {
      const manager = makeManager()
      const task = manager.startTask("Write-Output 'task-ok'", ws.root, '后台任务')
      expect(task.kind).toBe('task')
      await waitFor(() => manager.read(task.id).output.includes('task-ok'))
      await waitFor(() => manager.get(task.id)?.status === 'exited')
      const restarted = manager.restart(task.id)
      expect(restarted.status).toBe('running')
      await waitFor(() => manager.read(task.id).output.includes('task-ok'))
      await waitFor(() => manager.get(task.id)?.status === 'exited')
      manager.remove(task.id)
      expect(manager.get(task.id)).toBeNull()
    } finally {
      ws.cleanup()
    }
  })

  it('runOnce returns output and exit code', async () => {
    const ws = makeTempWorkspace()
    try {
      const manager = makeManager()
      const result = await manager.runOnce("Write-Output 'run-ok'", ws.root)
      expect(result.timedOut).toBe(false)
      expect(result.exitCode).toBe(0)
      expect(result.output).toContain('run-ok')
    } finally {
      ws.cleanup()
    }
  })

  it('restarting a running shell does not let the old exit mark the new process exited', async () => {
    const ws = makeTempWorkspace()
    try {
      const manager = makeManager()
      const shell = manager.createShell(ws.root, '重启测试')
      // 旧进程被 taskkill/SIGTERM 后的 exit 可能晚于 restart 返回
      const restarted = manager.restart(shell.id)
      expect(restarted.status).toBe('running')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(manager.get(shell.id)?.status).toBe('running')
      manager.stop(shell.id)
      await waitFor(() => manager.get(shell.id)?.status === 'exited')
    } finally {
      ws.cleanup()
    }
  })

  it('runOnce returns collected output instead of hanging after timeout', async () => {
    const ws = makeTempWorkspace()
    try {
      const manager = makeManager()
      const command =
        process.platform === 'win32'
          ? "Write-Output 'started'; Start-Sleep -Seconds 10"
          : "echo started; sleep 10"
      const started = Date.now()
      const result = await manager.runOnce(command, ws.root, 1000)
      expect(result.timedOut).toBe(true)
      expect(result.output).toContain('started')
      expect(Date.now() - started).toBeLessThan(8000)
    } finally {
      ws.cleanup()
    }
  })

  it.skipIf(process.platform === 'win32')('spawn failure marks the process exited instead of running forever', async () => {
    const ws = makeTempWorkspace()
    const previous = process.env.SHELL
    process.env.SHELL = '/nonexistent/morrow-shell'
    try {
      const manager = makeManager()
      const shell = manager.createShell(ws.root, '缺失 shell')
      await waitFor(() => manager.get(shell.id)?.status === 'exited', 5_000)
    } finally {
      if (previous === undefined) delete process.env.SHELL
      else process.env.SHELL = previous
      ws.cleanup()
    }
  })
})
