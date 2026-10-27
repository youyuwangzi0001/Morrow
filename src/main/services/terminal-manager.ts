/**
 * 终端与后台进程管理。
 *
 * 持久终端使用 node-pty（Windows ConPTY）创建真实伪终端，支持交互式程序、
 * ANSI 配色、窗口尺寸和多种 Shell；后台任务仍使用独立子进程（无需 TTY）。
 * 退出应用时统一结束所有进程。
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import * as nodePty from 'node-pty'
import type {
  TerminalEventPayload,
  TerminalProcessInfo,
  TerminalProcessKind,
  TerminalShellProfile
} from '../../shared/types'
import type { CommandShell } from '../../core/types'
import { buildOneShotInvocation } from '../../core/shell'
import { sendFeatureEvent } from '../feature-ipc'

const MAX_LOG_CHARS = 400 * 1024
const MAX_RAW_CHARS = 600 * 1024
const MAX_READ_CHARS = 40_000
const KILL_GRACE_MS = 2_000
const MAX_PROCESSES = 32
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g

interface ShellSpec {
  id: string
  label: string
  detail: string
  file: string
  args: string[]
  isDefault: boolean
  disabled?: boolean
}

interface WslStatus {
  installed: boolean
  distros: string[]
}

interface BaseRecord {
  info: TerminalProcessInfo
  logs: string
  rawLogs: string
  onExit?: (code: number | null) => void
}

interface ShellRecord extends BaseRecord {
  kind: 'shell'
  pty: nodePty.IPty
  spec: ShellSpec
  cols: number
  rows: number
}

interface TaskRecord extends BaseRecord {
  kind: 'task'
  child: ChildProcessWithoutNullStreams
}

type ManagedRecord = ShellRecord | TaskRecord

function emit(payload: TerminalEventPayload): void {
  sendFeatureEvent('feature:terminal:event', payload)
}

function infoCopy(info: TerminalProcessInfo): TerminalProcessInfo {
  return { ...info }
}

function shortTitle(text: string, max = 36): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function stripTerminalMarkup(text: string): string {
  return text
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

function appendCapped(current: string, text: string, max: number): string {
  const next = current + text
  return next.length > max ? next.slice(-max) : next
}

function commandExists(file: string): boolean {
  if (file.includes('\\') || file.includes('/')) return existsSync(file)
  const hasExtension = /\.[A-Za-z0-9]+$/.test(file)
  const extensions =
    process.platform === 'win32' && !hasExtension
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']
  const separator = process.platform === 'win32' ? '\\' : '/'
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const joined = `${dir}${dir.endsWith('\\') || dir.endsWith('/') ? '' : separator}${file}${extension}`
      if (existsSync(joined)) return true
    }
  }
  return false
}

function firstExisting(paths: string[]): string | null {
  return paths.find((path) => existsSync(path)) ?? null
}

function probeWsl(): WslStatus {
  const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
  if (!existsSync(exe)) return { installed: false, distros: [] }
  try {
    const result = spawnSync(exe, ['-l', '-q'], {
      windowsHide: true,
      timeout: 8_000,
      encoding: 'buffer'
    })
    if (result.error) return { installed: true, distros: [] }
    const raw = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '')
    const text = (raw.includes(0) ? raw.toString('utf16le') : raw.toString('utf8')).replace(/\u0000/g, '')
    const distros = text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\uFEFF/, '').trim())
      .filter((line) => line && !/未安装|no installed|not installed|适用于 Linux|wsl --install|https?:\/\//i.test(line))
    return { installed: true, distros }
  } catch {
    return { installed: true, distros: [] }
  }
}

function windowsSpecs(): ShellSpec[] {
  const pwsh = firstExisting([
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe'
  ]) ?? (commandExists('pwsh') ? 'pwsh.exe' : null)
  const gitBash = firstExisting([
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Git\\bin\\bash.exe`
  ])
  const specs: ShellSpec[] = []
  if (gitBash) {
    specs.push({
      id: 'gitbash',
      label: 'Git Bash',
      detail: 'Git 附带的 Bash（推荐）',
      file: gitBash,
      args: ['--login', '-i'],
      isDefault: false
    })
  }
  if (pwsh) {
    specs.push({
      id: 'pwsh',
      label: 'PowerShell 7',
      detail: '新版 PowerShell',
      file: pwsh,
      args: ['-NoLogo'],
      isDefault: false
    })
  }
  const wsl = probeWsl()
  if (wsl.installed) {
    specs.push({
      id: 'wsl',
      label: 'WSL',
      detail: wsl.distros.length
        ? `Windows 子系统 · ${wsl.distros[0]}${wsl.distros.length > 1 ? ` 等 ${wsl.distros.length} 个发行版` : ''}`
        : '未安装 Linux 发行版，先在 PowerShell 运行 wsl --install',
      file: 'wsl.exe',
      args: [],
      isDefault: false,
      disabled: wsl.distros.length === 0
    })
  }
  // 极端环境下至少保留一个可用 Shell；正常安装 Git Bash 后不会出现该回退项。
  if (specs.length === 0) {
    specs.push({
      id: 'cmd',
      label: '命令提示符',
      detail: '兼容回退（未检测到 Git Bash / PowerShell 7 / WSL）',
      file: 'cmd.exe',
      args: ['/Q', '/K', 'chcp 65001>nul'],
      isDefault: false
    })
  }
  const preferred =
    specs.find((spec) => spec.id === 'gitbash') ??
    specs.find((spec) => spec.id === 'pwsh') ??
    specs.find((spec) => !spec.disabled)
  if (preferred) preferred.isDefault = true
  return specs
}

function posixSpecs(): ShellSpec[] {
  const fallbackFile = '/bin/bash'
  const login = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : fallbackFile
  const specs: ShellSpec[] = [
    {
      id: 'default',
      label: '默认终端',
      detail: basename(login),
      file: login,
      args: ['-l'],
      isDefault: true
    }
  ]
  for (const file of ['/bin/bash', '/bin/zsh', '/usr/bin/fish']) {
    if (file === login || !existsSync(file)) continue
    const name = basename(file)
    specs.push({
      id: name,
      label: name === 'bash' ? 'Bash' : name === 'zsh' ? 'Zsh' : 'Fish',
      detail: file,
      file,
      args: name === 'fish' ? ['-l'] : ['-l'],
      isDefault: false
    })
  }
  return specs
}

export class TerminalManager {
  private records = new Map<string, ManagedRecord>()
  private counter = 0
  private disposed = false
  private shellCounters = new Map<string, number>()
  private shellCache: ShellSpec[] | null = null

  private specs(): ShellSpec[] {
    if (!this.shellCache) {
      try {
        this.shellCache = process.platform === 'win32' ? windowsSpecs() : posixSpecs()
      } catch {
        this.shellCache = [
          {
            id: 'default',
            label: '默认终端',
            detail: process.platform === 'win32' ? 'PowerShell' : '系统 Shell',
            file: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
            args: [],
            isDefault: true
          }
        ]
      }
    }
    return this.shellCache
  }

  profiles(): TerminalShellProfile[] {
    return this.specs().map((spec) => ({
      id: spec.id,
      label: spec.label,
      detail: spec.detail,
      ...(spec.isDefault ? { isDefault: true } : {}),
      ...(spec.disabled ? { disabled: true } : {})
    }))
  }

  wslStatus(): WslStatus {
    return probeWsl()
  }

  refreshProfiles(): void {
    this.shellCache = null
  }

  defaultShellId(): string {
    return (this.specs().find((spec) => spec.isDefault) ?? this.specs()[0]).id
  }

  /** 当前设置对应的终端；Agent 的 run_command 与一次性后台任务共用。 */
  commandShell(shellId?: string): CommandShell {
    const spec = this.resolveSpec(shellId)
    return { id: spec.id, label: spec.label, file: spec.file }
  }

  private resolveSpec(shellId?: string): ShellSpec {
    const specs = this.specs()
    if (shellId) {
      const requested = specs.find((spec) => spec.id === shellId)
      if (requested && !requested.disabled) return requested
    }
    return specs.find((spec) => spec.isDefault) ?? specs[0]
  }

  list(): TerminalProcessInfo[] {
    return [...this.records.values()].map((record) => infoCopy(record.info)).sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): TerminalProcessInfo | null {
    const record = this.records.get(id)
    return record ? infoCopy(record.info) : null
  }

  private nextId(kind: TerminalProcessKind): string {
    this.counter += 1
    return `${kind}_${Date.now().toString(36)}_${this.counter}_${randomBytes(2).toString('hex')}`
  }

  private envForShell(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    env.MORROW_TERMINAL = '1'
    env.LANG = env.LANG || 'C.UTF-8'
    return env
  }

  private ptyArgs(spec: ShellSpec): string[] {
    if (spec.id !== 'pwsh') return spec.args
    // PSReadLine 默认历史和系统里其他 PowerShell 共用同一个文件，权限/并发冲突会在终端里刷错误。
    // 给 Morrow 的终端一个独立历史文件，仍然保留上下键历史和跨启动记录。
    const base = process.env.MORROW_DATA_DIR || tmpdir()
    const historyFile = join(base, 'terminal-history', `${spec.id}.txt`)
    try {
      mkdirSync(join(base, 'terminal-history'), { recursive: true })
    } catch {
      return spec.args
    }
    const escaped = historyFile.replace(/'/g, "''")
    // Windows PowerShell 5 默认使用 OEM 代码页，xterm 按 UTF-8 解码会出现菱形乱码。
    const utf8Setup = [
      'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }',
      'try { [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }',
      'try { $OutputEncoding = [Console]::OutputEncoding } catch { }'
    ].join('; ')
    return [
      ...spec.args,
      '-NoExit',
      '-Command',
      `${utf8Setup}; try { Set-PSReadLineOption -HistorySavePath '${escaped}' } catch { }`
    ]
  }

  private spawnPty(spec: ShellSpec, cwd: string, cols = DEFAULT_COLS, rows = DEFAULT_ROWS): nodePty.IPty {
    return nodePty.spawn(spec.file, this.ptyArgs(spec), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: this.envForShell(),
      ...(process.platform === 'win32' ? { useConpty: true } : {})
    })
  }

  private attachShell(record: ShellRecord): void {
    const { pty, info } = record
    let ended = false
    const isCurrent = (): boolean =>
      !this.disposed && this.records.get(info.id) === record && record.pty === pty
    pty.onData((chunk) => {
      if (!isCurrent()) return
      record.rawLogs = appendCapped(record.rawLogs, chunk, MAX_RAW_CHARS)
      record.logs = appendCapped(record.logs, stripTerminalMarkup(chunk), MAX_LOG_CHARS)
      if (!chunk) return
      emit({ type: 'data', id: info.id, chunk, stream: 'stdout', pty: true })
    })
    pty.onExit(({ exitCode }) => {
      if (ended || !isCurrent()) return
      ended = true
      info.status = 'exited'
      info.exitCode = exitCode
      emit({ type: 'state', id: info.id, info: infoCopy(info) })
      record.onExit?.(exitCode)
    })
  }

  private attachChild(record: TaskRecord): void {
    const { child, info } = record
    const stdout = new StringDecoder('utf8')
    const stderr = new StringDecoder('utf8')
    let ended = false
    const isCurrent = (): boolean =>
      !this.disposed && this.records.get(info.id) === record && record.child === child
    const append = (text: string, stream: 'stdout' | 'stderr'): void => {
      if (!isCurrent()) return
      const clean = stripTerminalMarkup(text)
      if (!clean) return
      record.logs = appendCapped(record.logs, clean, MAX_LOG_CHARS)
      record.rawLogs = record.logs
      emit({ type: 'data', id: info.id, chunk: clean, stream, pty: false })
    }
    const markEnded = (code: number | null): void => {
      // 旧子进程在 restart 后仍可能触发 exit/error，不能覆盖新进程状态
      if (ended || !isCurrent()) return
      ended = true
      info.status = 'exited'
      info.exitCode = code ?? undefined
      emit({ type: 'state', id: info.id, info: infoCopy(info) })
      record.onExit?.(code)
    }
    child.stdout.on('data', (chunk: Buffer) => append(stdout.write(chunk), 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => append(stderr.write(chunk), 'stderr'))
    child.on('error', (err) => {
      append(`\n[进程错误] ${err.message}\n`, 'stderr')
      markEnded(null)
    })
    child.on('exit', (code) => markEnded(code))
  }

  createShell(cwd: string, title?: string, shellId?: string): TerminalProcessInfo {
    if (this.records.size >= MAX_PROCESSES) {
      throw new Error(`同时最多保留 ${MAX_PROCESSES} 个终端/后台任务，请先关闭一些进程。`)
    }
    if (!isDirectory(cwd)) throw new Error('终端工作目录不存在。')
    const spec = this.resolveSpec(shellId)
    const id = this.nextId('shell')
    const count = (this.shellCounters.get(spec.id) ?? 0) + 1
    this.shellCounters.set(spec.id, count)
    const pty = this.spawnPty(spec, cwd)
    const info: TerminalProcessInfo = {
      id,
      title: title?.trim() || `${spec.label} ${count}`,
      cwd,
      kind: 'shell',
      shellId: spec.id,
      shellLabel: spec.label,
      status: 'running',
      pid: pty.pid,
      createdAt: Date.now()
    }
    const record: ShellRecord = {
      kind: 'shell',
      info,
      pty,
      spec,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      logs: '',
      rawLogs: ''
    }
    this.records.set(id, record)
    this.attachShell(record)
    emit({ type: 'state', id, info: infoCopy(info) })
    return infoCopy(info)
  }

  startTask(command: string, cwd: string, title?: string, shellId?: string): TerminalProcessInfo {
    if (this.records.size >= MAX_PROCESSES) {
      throw new Error(`同时最多保留 ${MAX_PROCESSES} 个终端/后台任务，请先关闭一些进程。`)
    }
    if (!command.trim()) throw new Error('后台任务命令不能为空。')
    if (!isDirectory(cwd)) throw new Error('后台任务工作目录不存在。')
    const id = this.nextId('task')
    const spec = this.resolveSpec(shellId)
    const { file, args } = buildOneShotInvocation(this.commandShell(shellId), command)
    const child = spawn(file, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, MORROW_TASK: '1', MORROW_TERMINAL: '1' }
    })
    if (!child.stdout || !child.stderr || !child.stdin) throw new Error('后台任务没有可用的标准输入输出。')
    const info: TerminalProcessInfo = {
      id,
      title: title?.trim() || shortTitle(command),
      cwd,
      kind: 'task',
      command,
      shellId: spec.id,
      shellLabel: spec.label,
      status: 'running',
      pid: child.pid,
      createdAt: Date.now()
    }
    const record: TaskRecord = {
      kind: 'task',
      info,
      child: child as ChildProcessWithoutNullStreams,
      logs: '',
      rawLogs: ''
    }
    this.records.set(id, record)
    this.attachChild(record)
    emit({ type: 'state', id, info: infoCopy(info) })
    return infoCopy(info)
  }

  read(id: string, tail = MAX_READ_CHARS): { info: TerminalProcessInfo; output: string; rawOutput: string } {
    const record = this.records.get(id)
    if (!record) throw new Error('终端/任务不存在或已关闭。')
    const limit = Math.min(MAX_READ_CHARS, Math.max(1000, Math.round(tail)))
    return {
      info: infoCopy(record.info),
      output: record.logs.length > limit ? record.logs.slice(-limit) : record.logs,
      rawOutput: record.rawLogs.length > limit ? record.rawLogs.slice(-limit) : record.rawLogs
    }
  }

  write(id: string, data: string, raw = false): TerminalProcessInfo {
    const record = this.records.get(id)
    if (!record) throw new Error('终端/任务不存在或已关闭。')
    if (record.info.status !== 'running') throw new Error('进程已经结束，不能再写入。')
    if (record.kind === 'shell') {
      if (!data) return infoCopy(record.info)
      // 非原样写入（Agent 工具）把换行转成回车；原样写入（xterm 键盘）保持每个字节
      record.pty.write(raw ? data : data.replace(/\r?\n/g, '\r') + (/\r?\n$/.test(data) ? '' : '\r'))
    } else {
      record.child.stdin.write(data.endsWith('\n') ? data : `${data}\n`)
    }
    return infoCopy(record.info)
  }

  resize(id: string, cols: number, rows: number): TerminalProcessInfo {
    const record = this.records.get(id)
    if (!record) throw new Error('终端/任务不存在或已关闭。')
    if (record.kind !== 'shell' || record.info.status !== 'running') return infoCopy(record.info)
    const nextCols = Math.max(2, Math.min(500, Math.round(cols)))
    const nextRows = Math.max(1, Math.min(300, Math.round(rows)))
    if (nextCols === record.cols && nextRows === record.rows) return infoCopy(record.info)
    record.cols = nextCols
    record.rows = nextRows
    record.pty.resize(nextCols, nextRows)
    return infoCopy(record.info)
  }

  private killPty(record: ShellRecord): void {
    const { pty } = record
    if (!pty.pid) {
      try {
        pty.kill()
      } catch {
      }
      return
    }
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(pty.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } catch {
        // fall through
      }
      try {
        pty.kill()
      } catch {
      }
      return
    }
    try {
      pty.kill('SIGTERM')
    } catch {
    }
    setTimeout(() => {
      try {
        pty.kill('SIGKILL')
      } catch {
      }
    }, KILL_GRACE_MS).unref?.()
  }

  private killTree(child: ChildProcessWithoutNullStreams): void {
    const pid = child.pid
    if (!pid) return
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } catch {
        child.kill()
      }
    } else {
      try {
        child.kill('SIGTERM')
      } catch {
      }
      // child.killed 在 SIGTERM 成功后就为 true，不能作为是否升级 SIGKILL 的依据
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
        }
      }, KILL_GRACE_MS).unref?.()
    }
  }

  stop(id: string): TerminalProcessInfo {
    const record = this.records.get(id)
    if (!record) throw new Error('终端/任务不存在或已关闭。')
    if (record.info.status === 'running') {
      if (record.kind === 'shell') this.killPty(record)
      else this.killTree(record.child)
    }
    return infoCopy(record.info)
  }

  restart(id: string): TerminalProcessInfo {
    const record = this.records.get(id)
    if (!record) throw new Error('终端/任务不存在或已关闭。')
    const { info } = record
    // 目录被删除/移走时不要先杀旧进程再失败，保持原状态
    if (!isDirectory(info.cwd)) throw new Error('原工作目录已不存在，无法重启。')
    if (record.kind === 'shell') {
      this.killPty(record)
      let next: nodePty.IPty
      try {
        next = this.spawnPty(record.spec, info.cwd, record.cols, record.rows)
      } catch (err) {
        info.status = 'exited'
        emit({ type: 'state', id, info: infoCopy(info) })
        throw err
      }
      // 先替换 pty 再 attach：旧 PTY 的 exit 会被 isCurrent 丢弃
      record.pty = next
      record.rawLogs = appendCapped(record.rawLogs, '\r\n\x1b[38;5;179m── 已重新启动 ──\x1b[0m\r\n', MAX_RAW_CHARS)
      record.logs = appendCapped(record.logs, '\n── 已重新启动 ──\n', MAX_LOG_CHARS)
      record.onExit = undefined
      info.status = 'running'
      info.pid = next.pid
      info.createdAt = Date.now()
      delete info.exitCode
      this.attachShell(record)
      emit({ type: 'state', id, info: infoCopy(info) })
      return infoCopy(info)
    }
    if (record.info.status === 'running') this.killTree(record.child)
    let child: ChildProcessWithoutNullStreams
    try {
      const { file, args } = buildOneShotInvocation(this.commandShell(info.shellId), info.command ?? '')
      child = spawn(file, args, {
        cwd: info.cwd,
        windowsHide: true,
        env: { ...process.env, MORROW_TASK: '1' }
      }) as ChildProcessWithoutNullStreams
    } catch (err) {
      info.status = 'exited'
      emit({ type: 'state', id, info: infoCopy(info) })
      throw err
    }
    // 先替换 child，再 attach：旧子进程的 exit/error 会被 isCurrent 丢弃
    record.child = child
    record.logs = appendCapped(record.logs, '\n--- 重新启动 ---\n', MAX_LOG_CHARS)
    record.rawLogs = record.logs
    record.onExit = undefined
    info.status = 'running'
    info.pid = child.pid
    info.createdAt = Date.now()
    delete info.exitCode
    this.attachChild(record)
    emit({ type: 'state', id, info: infoCopy(info) })
    return infoCopy(info)
  }

  remove(id: string): void {
    const record = this.records.get(id)
    if (!record) return
    if (record.info.status === 'running') {
      if (record.kind === 'shell') this.killPty(record)
      else this.killTree(record.child)
    }
    this.records.delete(id)
    emit({ type: 'removed', id })
  }

  /** 一次性命令：等待进程退出，超时则结束并返回已有输出。 */
  async runOnce(
    command: string,
    cwd: string,
    timeoutMs = 120_000,
    shellId?: string
  ): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
    if (!command.trim()) throw new Error('命令不能为空。')
    if (!isDirectory(cwd)) throw new Error('工作目录不存在。')
    const { file, args } = buildOneShotInvocation(this.commandShell(shellId), command)
    return new Promise((resolve) => {
      const child = spawn(file, args, { cwd, windowsHide: true, env: { ...process.env, MORROW_TERMINAL: '1' } })
      const stdout = new StringDecoder('utf8')
      const stderr = new StringDecoder('utf8')
      let output = ''
      let timedOut = false
      let settled = false
      let timer: NodeJS.Timeout | null = null
      let fallback: NodeJS.Timeout | null = null
      const append = (text: string): void => {
        output = appendCapped(output, stripTerminalMarkup(text), MAX_LOG_CHARS)
      }
      const finish = (code: number | null): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (fallback) clearTimeout(fallback)
        resolve({ output, exitCode: code, timedOut })
      }
      timer = setTimeout(() => {
        timedOut = true
        this.killTree(child)
        // kill 后进程仍可能不退出（忽略信号/POSIX 子进程树），必须在宽限期后返回已收集输出
        fallback = setTimeout(() => finish(null), KILL_GRACE_MS + 500)
        fallback.unref?.()
      }, Math.max(1000, Math.min(300_000, timeoutMs)))
      // 一次性命令不提供交互 stdin，主动关闭避免等待输入的命令一直挂起
      child.stdin?.end()
      child.stdout?.on('data', (chunk: Buffer) => append(stdout.write(chunk)))
      child.stderr?.on('data', (chunk: Buffer) => append(stderr.write(chunk)))
      child.on('error', (err) => {
        append(`\n[进程错误] ${err.message}\n`)
        finish(null)
      })
      child.on('exit', (code) => finish(code))
    })
  }

  dispose(): void {
    this.disposed = true
    for (const record of this.records.values()) {
      if (record.info.status !== 'running') continue
      if (record.kind === 'shell') this.killPty(record)
      else this.killTree(record.child)
    }
    this.records.clear()
  }
}

let instance: TerminalManager | null = null
export function getTerminalManager(): TerminalManager {
  if (!instance) instance = new TerminalManager()
  return instance
}

