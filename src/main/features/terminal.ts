/**
 * P0-1 终端与后台任务 feature IPC。
 * 所有 cwd 必须位于已登记工作区内；输出通过 feature:terminal:event 广播。
 */
import { registerFeatureHandler } from '../feature-ipc'
import { getSettingsStore } from '../services/settings-store'
import { getTerminalManager } from '../services/terminal-manager'
import { resolveWorkspaceDir } from './workspace-roots'

function payloadOf(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function resolveCwd(raw: unknown): string {
  return resolveWorkspaceDir(raw, '终端只能在工作区内启动。')
}

function managerOf(): ReturnType<typeof getTerminalManager> {
  return getTerminalManager()
}

function sameCwd(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const clean = value.replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? clean.toLowerCase() : clean
  }
  return normalize(left) === normalize(right)
}

registerFeatureHandler('feature:terminal:list', (payload) => {
  const input = payloadOf(payload)
  const raw = text(input.workspace).trim()
  if (!raw) return { processes: managerOf().list() }
  const workspace = resolveWorkspaceDir(raw, '终端只能查看已登记工作区内的进程。')
  return { processes: managerOf().list().filter((process) => sameCwd(process.cwd, workspace)) }
})

registerFeatureHandler('feature:terminal:profiles', () => ({
  profiles: managerOf().profiles(),
  defaultShell: managerOf().defaultShellId()
}))

registerFeatureHandler('feature:terminal:create', (payload) => {
  const input = payloadOf(payload)
  const cwd = resolveCwd(input.cwd)
  const requested = text(input.shell).trim() || getSettingsStore().get().terminalShell
  return managerOf().createShell(
    cwd,
    text(input.title).trim().slice(0, 120) || undefined,
    requested || undefined
  )
})

registerFeatureHandler('feature:terminal:start-task', (payload) => {
  const input = payloadOf(payload)
  const command = text(input.command).trim()
  if (!command) throw new Error('后台任务命令不能为空。')
  if (command.length > 4000) throw new Error('后台任务命令不能超过 4000 字符。')
  return managerOf().startTask(
    command,
    resolveCwd(input.cwd),
    text(input.title).trim().slice(0, 120) || undefined
  )
})

registerFeatureHandler('feature:terminal:read', (payload) => {
  const input = payloadOf(payload)
  const id = text(input.id).trim()
  if (!id) throw new Error('缺少进程 id。')
  const tail = typeof input.tail === 'number' && Number.isFinite(input.tail) ? input.tail : 40_000
  return managerOf().read(id, tail)
})

registerFeatureHandler('feature:terminal:write', (payload) => {
  const input = payloadOf(payload)
  const id = text(input.id).trim()
  if (!id) throw new Error('缺少进程 id。')
  if (typeof input.data !== 'string') throw new Error('缺少要写入的内容。')
  if (input.data.length > 20_000) throw new Error('单次写入不能超过 20000 字符。')
  return managerOf().write(id, input.data)
})

registerFeatureHandler('feature:terminal:input', (payload) => {
  const input = payloadOf(payload)
  const id = text(input.id).trim()
  if (!id) throw new Error('缺少终端 id。')
  if (typeof input.data !== 'string') throw new Error('缺少输入内容。')
  if (input.data.length > 100_000) throw new Error('单次输入不能超过 100000 字符。')
  return managerOf().write(id, input.data, true)
})

registerFeatureHandler('feature:terminal:resize', (payload) => {
  const input = payloadOf(payload)
  const id = text(input.id).trim()
  if (!id) throw new Error('缺少终端 id。')
  const cols = typeof input.cols === 'number' ? input.cols : 0
  const rows = typeof input.rows === 'number' ? input.rows : 0
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) throw new Error('终端尺寸不合法。')
  return managerOf().resize(id, cols, rows)
})

registerFeatureHandler('feature:terminal:stop', (payload) => {
  const input = payloadOf(payload)
  return managerOf().stop(text(input.id).trim())
})

registerFeatureHandler('feature:terminal:restart', (payload) => {
  const input = payloadOf(payload)
  return managerOf().restart(text(input.id).trim())
})

registerFeatureHandler('feature:terminal:remove', (payload) => {
  const input = payloadOf(payload)
  managerOf().remove(text(input.id).trim())
  return { removed: true }
})
