import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Plus, RotateCcw, Square, Terminal as TerminalIcon, X } from 'lucide-react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type {
  Result,
  TerminalEventPayload,
  TerminalProcessInfo,
  ThemeMode
} from '@shared/types'
import { useAppStore } from '../../store'
import { Button } from '../../ui'
import './terminal.css'

const CODE_FONT_FAMILY =
  "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei UI', 'PingFang SC', 'Cascadia Mono', Consolas, 'Courier New', monospace"

function resolvedCodeFont(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--font-code').trim() || CODE_FONT_FAMILY
}

const EVENT_CHANNEL = 'feature:terminal:event'
const HEIGHT_KEY = 'morrow.terminal.height.v2'
const MIN_HEIGHT = 190
const DEFAULT_HEIGHT = 240

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const result = (await window.morrow.features.invoke(channel, payload)) as Result<T>
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

function clampHeight(value: number): number {
  const max = Math.max(MIN_HEIGHT, Math.min(680, window.innerHeight * 0.72))
  return Math.round(Math.max(MIN_HEIGHT, Math.min(max, value)))
}

function storedHeight(): number {
  const raw = Number(window.localStorage.getItem(HEIGHT_KEY))
  return Number.isFinite(raw) && raw > 0 ? clampHeight(raw) : DEFAULT_HEIGHT
}

function stateLabel(process: TerminalProcessInfo): string {
  if (process.status === 'running') return '运行中'
  if (process.exitCode !== undefined && process.exitCode !== 0) return `已退出 · 代码 ${process.exitCode}`
  return '已退出'
}

function compactCwd(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

function xtermTheme(theme: ThemeMode): ITheme {
  const light = theme === 'light'
  return {
    background: '#00000000',
    foreground: light ? '#1b1a17' : '#ede7da',
    cursor: light ? '#8a6a3c' : '#c8ae7d',
    cursorAccent: light ? '#f1ede4' : '#0b0d10',
    selectionBackground: light ? 'rgba(138, 106, 60, 0.24)' : 'rgba(200, 174, 125, 0.28)',
    black: light ? '#3a352c' : '#1c2026',
    red: light ? '#a2543f' : '#d08b76',
    green: light ? '#4f7263' : '#94b8a4',
    yellow: light ? '#8a6a2f' : '#d8bd86',
    blue: light ? '#4f6887' : '#93aecb',
    magenta: light ? '#7c5a72' : '#c3a2bc',
    cyan: light ? '#4b7476' : '#93bfc0',
    white: light ? '#6f675a' : '#d8d2c5',
    brightBlack: light ? '#8c867a' : '#6b675f',
    brightRed: light ? '#bf6a50' : '#e5a38d',
    brightGreen: light ? '#5f8576' : '#a9cbb7',
    brightYellow: light ? '#9c7b3a' : '#e8d19f',
    brightBlue: light ? '#607c9c' : '#adc5df',
    brightMagenta: light ? '#8f6d85' : '#d7b7d0',
    brightCyan: light ? '#5c888a' : '#abd2d3',
    brightWhite: light ? '#1b1a17' : '#f5f0e6'
  }
}

/* ── xterm 实例 ─────────────────────────────────────────────── */

function TerminalSurface({
  process,
  active,
  open,
  theme,
  onError
}: {
  process: TerminalProcessInfo
  active: boolean
  open: boolean
  theme: ThemeMode
  onError: (message: string | null) => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const codeFontSize = useAppStore((state) => state.settings.codeFontSize || 12)
  const codeFont = useAppStore((state) => state.settings.codeFont || 'jetbrains')
  const runningRef = useRef(process.status === 'running')
  runningRef.current = process.status === 'running'

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const term = new Terminal({
      fontFamily: resolvedCodeFont(),
      fontSize: codeFontSize,
      fontWeight: 400,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 6000,
      allowTransparency: true,
      convertEol: false,
      theme: xtermTheme(theme)
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit
    let loaded = false
    let exitedNotified = process.status !== 'running'
    const pending: string[] = []
    const write = (text: string): void => {
      try {
        term.write(text)
      } catch {
        // 终端被销毁时忽略尾部输出
      }
    }
    const exitLine = (code?: number): void => {
      if (exitedNotified) return
      exitedNotified = true
      write(`\r\n\x1b[38;5;${theme === 'light' ? '95' : '179'}m[终端已退出${code !== undefined ? ` · 代码 ${code}` : ''}]\x1b[0m\r\n`)
    }
    void (async () => {
      try {
        const history = await call<{ rawOutput?: string; output?: string }>('feature:terminal:read', {
          id: process.id,
          tail: 40_000
        })
        write(history.rawOutput || history.output || '')
      } catch {
        // 新终端可能还没有历史
      }
      loaded = true
      for (const chunk of pending.splice(0)) write(chunk)
      if (process.status !== 'running') exitLine(process.exitCode)
    })()

    const dataDisposable = term.onData((data) => {
      if (!runningRef.current) return
      void call('feature:terminal:input', { id: process.id, data }).catch((err) => {
        if (err instanceof Error) onError(err.message)
      })
    })
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      void call('feature:terminal:resize', { id: process.id, cols, rows }).catch(() => undefined)
    })

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
        const selection = term.getSelection()
        if (selection) void navigator.clipboard.writeText(selection)
        return false
      }
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyV') {
        void navigator.clipboard.readText().then((text) => {
          if (!text || !runningRef.current) return
          void call('feature:terminal:input', { id: process.id, data: text }).catch((err) => {
            if (err instanceof Error) onError(err.message)
          })
        })
        return false
      }
      return true
    })

    const off = window.morrow.features.on(EVENT_CHANNEL, (payload) => {
      const event = payload as TerminalEventPayload
      if (!event || event.id !== process.id) return
      if (event.type === 'data' && event.pty && event.chunk) {
        if (loaded) write(event.chunk)
        else pending.push(event.chunk)
      } else if (event.type === 'state' && event.info?.status === 'exited') {
        runningRef.current = false
        exitLine(event.info.exitCode)
      }
    })

    const observer = new ResizeObserver(() => {
      if (!host.isConnected || host.offsetParent === null) return
      try {
        fit.fit()
      } catch {
        // 容器尺寸为 0 时忽略
      }
    })
    observer.observe(host)
    requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        // ignore
      }
    })

    return () => {
      off()
      observer.disconnect()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // 每个终端 id 只创建一次；主题通过独立 effect 更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [process.id])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(theme)
  }, [theme])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = resolvedCodeFont()
    term.options.fontSize = codeFontSize
    term.options.fontWeight = 400
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // 容器尚未布局完成时忽略
      }
    })
  }, [codeFontSize, codeFont])

  useEffect(() => {
    if (!active || !open) return undefined
    const frame = requestAnimationFrame(() => {
      const host = hostRef.current
      const term = termRef.current
      const fit = fitRef.current
      if (!host || !term || !fit) return
      try {
        fit.fit()
      } catch {
        // ignore
      }
      term.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [active, open])

  return <div ref={hostRef} className="terminal-xterm" hidden={!active} />
}

/* ── 后台任务输出 ───────────────────────────────────────────── */

function TaskView({
  process,
  logs,
  onSend
}: {
  process: TerminalProcessInfo
  logs: string
  onSend: (value: string) => void
}): React.JSX.Element {
  const [stdin, setStdin] = useState('')
  const outputRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = outputRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])
  const send = (): void => {
    if (!stdin.trim()) return
    onSend(stdin)
    setStdin('')
  }
  return (
    <div className="terminal-task-view">
      <pre ref={outputRef} className="terminal-task-output mono" aria-label="任务输出">
        {logs.trim() || '（还没有输出）'}
      </pre>
      {process.status === 'running' ? (
        <div className="terminal-task-stdin">
          <span className="mono">›</span>
          <input
            className="terminal-task-input mono"
            value={stdin}
            placeholder="要发送给任务的内容，回车发送"
            aria-label="向任务输入"
            onChange={(event) => setStdin(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                send()
              }
            }}
          />
          <Button variant="ghost" onClick={send} disabled={!stdin.trim()}>
            发送
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/* ── 面板 ───────────────────────────────────────────────────── */

export function TerminalPanel({
  open,
  onClose,
  workspace
}: {
  open: boolean
  onClose: () => void
  workspace: string | null
}): React.JSX.Element {
  const theme = useAppStore((s) => s.settings.theme)
  const [processes, setProcesses] = useState<TerminalProcessInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [taskLogs, setTaskLogs] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [height, setHeight] = useState(storedHeight)
  const heightRef = useRef(height)
  heightRef.current = height
  const autoOpenedFor = useRef<string | null>(null)

  const active = useMemo(
    () => processes.find((process) => process.id === activeId) ?? null,
    [processes, activeId]
  )

  const refresh = useCallback(async (): Promise<TerminalProcessInfo[]> => {
    if (!workspace) {
      setProcesses([])
      return []
    }
    const data = await call<{ processes: TerminalProcessInfo[] }>('feature:terminal:list', { workspace })
    setProcesses(data.processes)
    return data.processes
  }, [workspace])

  const createTerminal = useCallback(async (): Promise<void> => {
    if (!workspace) {
      setError('请先选择一个工作文件夹。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const info = await call<TerminalProcessInfo>('feature:terminal:create', { cwd: workspace })
      setProcesses((previous) =>
        previous.some((item) => item.id === info.id)
          ? previous.map((item) => (item.id === info.id ? info : item))
          : [...previous, info]
      )
      setActiveId(info.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开终端失败。')
    } finally {
      setBusy(false)
    }
  }, [workspace])

  // 打开面板时恢复当前工作区的终端；一个都没有就按设置里的默认终端新建
  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    void (async () => {
      try {
        const list = await refresh()
        if (cancelled) return
        const shell = list.find((item) => item.kind === 'shell')
        if (shell) {
          setActiveId((current) =>
            current && list.some((item) => item.id === current) ? current : shell.id
          )
          return
        }
        if (!workspace) return
        const key = workspace
        if (autoOpenedFor.current === key) return
        autoOpenedFor.current = key
        await createTerminal()
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取终端列表失败。')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, workspace, refresh, createTerminal])

  useEffect(() => {
    if (!workspace) autoOpenedFor.current = null
  }, [workspace])

  // Agent 启动/结束的后台任务、终端退出都通过事件同步到标签页
  useEffect(() => {
    const off = window.morrow.features.on(EVENT_CHANNEL, (payload) => {
      const event = payload as TerminalEventPayload
      if (!event || typeof event.id !== 'string') return
      if (event.type === 'data' && !event.pty && event.chunk) {
        setTaskLogs((previous) => {
          const next = `${previous[event.id] ?? ''}${event.chunk}`
          return { ...previous, [event.id]: next.length > 240_000 ? next.slice(-240_000) : next }
        })
      } else if (event.type === 'state' && event.info) {
        const info = event.info
        setProcesses((previous) => {
          const index = previous.findIndex((item) => item.id === info.id)
          if (index < 0) {
            if (info.cwd !== workspace) return previous
            return [...previous, info]
          }
          const copy = previous.slice()
          copy[index] = info
          return copy
        })
      } else if (event.type === 'removed') {
        setProcesses((previous) => previous.filter((item) => item.id !== event.id))
        setTaskLogs((previous) => {
          const next = { ...previous }
          delete next[event.id]
          return next
        })
        setActiveId((current) => (current === event.id ? null : current))
      }
    })
    return off
  }, [workspace])

  // 当前标签被关闭后，自动切到同工作区的下一个终端
  useEffect(() => {
    if (activeId && processes.some((process) => process.id === activeId)) return
    const next = processes.find((process) => process.kind === 'shell') ?? processes[0]
    setActiveId(next?.id ?? null)
  }, [activeId, processes])

  // 后台任务首次打开时拉取已有日志
  useEffect(() => {
    if (!active || active.kind !== 'task') return
    if (taskLogs[active.id] !== undefined) return
    let cancelled = false
    void (async () => {
      try {
        const data = await call<{ output: string }>('feature:terminal:read', {
          id: active.id,
          tail: 40_000
        })
        if (!cancelled) setTaskLogs((previous) => ({ ...previous, [active.id]: data.output }))
      } catch {
        // 任务刚启动时可能还没有日志
      }
    })()
    return () => {
      cancelled = true
    }
  }, [active, taskLogs])

  useEffect(() => {
    if (!open) return
    setHeight((current) => clampHeight(current))
  }, [open])

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = heightRef.current
    const move = (moveEvent: PointerEvent): void => {
      const next = clampHeight(startHeight + (startY - moveEvent.clientY))
      heightRef.current = next
      setHeight(next)
    }
    const finish = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.localStorage.setItem(HEIGHT_KEY, String(heightRef.current))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
  }

  const resizeByKeyboard = (delta: number): void => {
    const next = clampHeight(heightRef.current + delta)
    heightRef.current = next
    setHeight(next)
    window.localStorage.setItem(HEIGHT_KEY, String(next))
  }

  const restart = async (id: string): Promise<void> => {
    setError(null)
    try {
      const info = await call<TerminalProcessInfo>('feature:terminal:restart', { id })
      setProcesses((previous) => previous.map((item) => (item.id === id ? info : item)))
    } catch (err) {
      setError(err instanceof Error ? err.message : '重启终端失败。')
    }
  }

  const stop = async (id: string): Promise<void> => {
    setError(null)
    try {
      const info = await call<TerminalProcessInfo>('feature:terminal:stop', { id })
      setProcesses((previous) => previous.map((item) => (item.id === id ? info : item)))
    } catch (err) {
      setError(err instanceof Error ? err.message : '停止终端失败。')
    }
  }

  const remove = async (id: string): Promise<void> => {
    setError(null)
    try {
      await call('feature:terminal:remove', { id })
      setProcesses((previous) => previous.filter((item) => item.id !== id))
      setTaskLogs((previous) => {
        const next = { ...previous }
        delete next[id]
        return next
      })
      setActiveId((current) => (current === id ? null : current))
    } catch (err) {
      setError(err instanceof Error ? err.message : '关闭终端失败。')
    }
  }

  const sendTaskInput = async (value: string): Promise<void> => {
    if (!active) return
    setTaskLogs((previous) => ({
      ...previous,
      [active.id]: `${previous[active.id] ?? ''}› ${value}\n`
    }))
    try {
      await call('feature:terminal:write', { id: active.id, data: value })
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败。')
    }
  }

  const shellProcesses = processes.filter((process) => process.kind === 'shell')

  return (
    <section
      className={['terminal-dock', open ? 'is-open' : ''].filter(Boolean).join(' ')}
      style={{ height }}
      aria-label="终端"
      aria-hidden={!open}
    >
      <div
        className="terminal-resizer"
        role="separator"
        aria-label="拖动调整终端高度"
        aria-orientation="horizontal"
        tabIndex={open ? 0 : -1}
        onPointerDown={startResize}
        onDoubleClick={() => {
          heightRef.current = DEFAULT_HEIGHT
          setHeight(DEFAULT_HEIGHT)
          window.localStorage.setItem(HEIGHT_KEY, String(DEFAULT_HEIGHT))
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            resizeByKeyboard(24)
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            resizeByKeyboard(-24)
          }
        }}
      />

      <div className="terminal-bar">
        <div className="terminal-tabs" role="tablist" aria-label="终端标签">
          {processes.map((process) => (
            <div
              key={process.id}
              className={['terminal-tab', process.id === activeId ? 'is-active' : ''].filter(Boolean).join(' ')}
            >
              <button
                type="button"
                role="tab"
                aria-selected={process.id === activeId}
                className="terminal-tab-main"
                title={`${process.title}\n${process.cwd}`}
                onClick={() => setActiveId(process.id)}
              >
                <span
                  className={['terminal-tab-dot', process.status === 'running' ? 'is-running' : ''].filter(Boolean).join(' ')}
                  aria-hidden
                />
                {process.kind === 'task' ? (
                  <Box size={12} strokeWidth={1.6} aria-hidden />
                ) : (
                  <TerminalIcon size={12} strokeWidth={1.6} aria-hidden />
                )}
                <span className="terminal-tab-title truncate">{process.title}</span>
              </button>
              <button
                type="button"
                className="terminal-tab-close"
                aria-label={`关闭 ${process.title}`}
                onClick={() => void remove(process.id)}
              >
                <X size={11} strokeWidth={1.8} aria-hidden />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="terminal-tool terminal-new"
            aria-label="新建终端"
            title="新建终端"
            disabled={busy || !workspace}
            onClick={() => void createTerminal()}
          >
            <Plus size={14} strokeWidth={1.7} aria-hidden />
          </button>
        </div>

        <div className="terminal-actions">
          {active ? (
            <button
              type="button"
              className="terminal-tool"
              aria-label="重新启动"
              title="重新启动"
              onClick={() => void restart(active.id)}
            >
              <RotateCcw size={13} strokeWidth={1.7} aria-hidden />
            </button>
          ) : null}
          {active?.status === 'running' ? (
            <button
              type="button"
              className="terminal-tool is-danger"
              aria-label="停止终端"
              title="停止"
              onClick={() => void stop(active.id)}
            >
              <Square size={11} strokeWidth={2} fill="currentColor" aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            className="terminal-tool terminal-dock-close"
            aria-label="收起终端"
            title="收起终端（进程继续运行）"
            onClick={onClose}
          >
            <X size={14} strokeWidth={1.7} aria-hidden />
          </button>
        </div>
      </div>

      {error ? (
        <div className="terminal-error" role="alert">
          <span>{error}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setError(null)}>
            <X size={12} strokeWidth={1.8} aria-hidden />
          </button>
        </div>
      ) : null}

      <div className="terminal-stage">
        {shellProcesses.map((process) => (
          <TerminalSurface
            key={process.id}
            process={process}
            active={process.id === activeId}
            open={open}
            theme={theme}
            onError={setError}
          />
        ))}
        {active?.kind === 'task' ? (
          <TaskView
            key={active.id}
            process={active}
            logs={taskLogs[active.id] ?? ''}
            onSend={(value) => void sendTaskInput(value)}
          />
        ) : null}
        {!active ? (
          <div className="terminal-empty">
            <TerminalIcon size={24} strokeWidth={1.3} aria-hidden />
            <p>{workspace ? '终端会在当前文件夹里打开。' : '先选择一个工作文件夹，再打开终端。'}</p>
            {workspace ? (
              <Button variant="gold" onClick={() => void createTerminal()} disabled={busy}>
                {busy ? '正在打开…' : '打开终端'}
              </Button>
            ) : null}
            <p className="terminal-empty-hint">默认使用设置里选的终端，可在「设置 → 终端」更换。</p>
          </div>
        ) : null}
      </div>

      <div className="terminal-statusbar">
        <span className="terminal-status-path mono" title={active?.cwd ?? ''}>
          {active ? compactCwd(active.cwd) : workspace ? compactCwd(workspace) : '未选择文件夹'}
        </span>
        {active ? (
          <span
            className="terminal-status-meta"
            title={active.pid !== undefined ? `PID ${active.pid}` : undefined}
          >
            {active.kind === 'shell' ? active.shellLabel ?? '终端' : '后台任务'} · {stateLabel(active)}
          </span>
        ) : null}
      </div>
    </section>
  )
}
