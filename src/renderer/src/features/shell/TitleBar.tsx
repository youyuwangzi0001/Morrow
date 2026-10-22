import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Folder, Ghost, Globe, Minus, PanelLeft, PanelRight, Square, SquareTerminal, Target, X } from 'lucide-react'
import { useAppStore } from '../../state/store'
import { IconButton } from '../../ui'
import { GOAL_STATUS_LABEL } from '../goal/goal-format'
import { openWorkbench } from '../workbench/events'
import './TitleBar.css'

/** 当前对话标题：双击（或 F2）就地重命名 */
function SessionTitle(): React.JSX.Element {
  const session = useAppStore((s) => s.session)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const renameSession = useAppStore((s) => s.renameSession)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const title = session?.title ?? '新对话'

  useEffect(() => {
    if (!editing) return
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [editing])

  const startEditing = (): void => {
    if (!activeSessionId) return
    setDraft(title)
    setEditing(true)
  }

  const commit = (): void => {
    if (!editing) return
    setEditing(false)
    const next = draft.trim()
    if (activeSessionId && next && next !== title) void renameSession(activeSessionId, next)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="tb-title-input"
        value={draft}
        maxLength={80}
        aria-label="重命名对话"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <button
      type="button"
      className={['tb-title', activeSessionId ? '' : 'is-muted'].filter(Boolean).join(' ')}
      onDoubleClick={startEditing}
      onKeyDown={(event) => {
        if (event.key === 'F2') {
          event.preventDefault()
          startEditing()
        }
      }}
      title={
        session?.temporary
          ? '临时对话：关闭应用后消失，不进入历史与搜索。双击可重命名'
          : activeSessionId
            ? '双击重命名这条对话'
            : undefined
      }
      aria-label={
        session?.temporary
          ? `当前是临时对话：${title}，不会保存`
          : activeSessionId
            ? `当前对话：${title}，双击重命名`
            : '当前对话：新对话'
      }
    >
      <span className="truncate">{title}</span>
      {session?.temporary ? (
        <span className="tb-temp-badge mono">
          <Ghost size={10} strokeWidth={1.6} aria-hidden />
          临时
        </span>
      ) : null}
    </button>
  )
}

/** 当前文件夹（点击切换） */
function WorkspaceChip(): React.JSX.Element {
  const workspace = useAppStore((s) => s.session?.workspace ?? s.settings.lastWorkspace)
  const pickWorkspace = useAppStore((s) => s.pickWorkspace)
  const running = useAppStore((s) => !!s.run)
  const name = workspace ? (workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace) : null

  return (
    <button
      type="button"
      className={['tb-workspace', workspace ? '' : 'is-empty'].filter(Boolean).join(' ')}
      title={running ? '生成中，结束后再切换文件夹' : (workspace ?? '选择一个文件夹')}
      aria-label={workspace ? `当前文件夹：${workspace}，点击切换` : '未选择文件夹，点击选择'}
      onClick={() => void pickWorkspace()}
      disabled={running}
    >
      <Folder size={13} strokeWidth={1.5} aria-hidden />
      <span className="tb-workspace-name truncate">{name ?? '未选择文件夹'}</span>
      <ChevronDown size={11} strokeWidth={1.5} aria-hidden />
    </button>
  )
}

/** 目标指示：只在当前对话有 goal 时出现，靠近模型 chip，不挤压窗控 */
function GoalIndicator(): React.JSX.Element | null {
  const session = useAppStore((s) => s.session)
  const goal = session?.goal ?? null
  const run = useAppStore((s) => s.run)
  if (!goal) return null
  const running = !!run && goal.status === 'active' && run.sessionId === session?.id
  const detail = [
    goal.objective,
    `${GOAL_STATUS_LABEL[goal.status]} · 第 ${goal.round}/${goal.maxRounds} 轮`,
    goal.nextStep ? `下一步：${goal.nextStep}` : '',
    goal.blockedReason ? `阻塞：${goal.blockedReason}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <button
      type="button"
      className={['tb-goal', `is-${goal.status}`, running ? 'is-running' : ''].filter(Boolean).join(' ')}
      title={detail}
      aria-label={`目标：${goal.objective}，${GOAL_STATUS_LABEL[goal.status]}，第 ${goal.round}/${goal.maxRounds} 轮`}
      onClick={() => document.querySelector('.goal-bar')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}
    >
      <Target size={14} strokeWidth={1.5} aria-hidden />
      <span className="tb-goal-round mono">
        {goal.round}/{goal.maxRounds}
      </span>
    </button>
  )
}

/** 内置浏览器开关：打开或切回上次隐藏的浏览器页面 */
function BrowserToggle(): React.JSX.Element {
  return (
    <IconButton
      label="打开内置浏览器"
      size={30}
      className="tb-browser-toggle"
      onClick={() => openWorkbench('browser')}
    >
      <Globe size={15} strokeWidth={1.5} aria-hidden />
    </IconButton>
  )
}

/** 底部终端开关 */
function TerminalToggle(): React.JSX.Element {
  const open = useAppStore((s) => s.terminalOpen)
  const toggleTerminal = useAppStore((s) => s.toggleTerminal)
  return (
    <IconButton
      label={open ? '隐藏终端' : '打开终端'}
      size={30}
      active={open}
      className="tb-terminal-toggle"
      onClick={toggleTerminal}
    >
      <SquareTerminal size={15} strokeWidth={1.5} aria-hidden />
    </IconButton>
  )
}

/** 画布开关：未打开时打开（优先选最近成品），已打开时收起 */
function CanvasToggle(): React.JSX.Element {
  const open = useAppStore((s) => s.canvas.open)
  const toggleCanvas = useAppStore((s) => s.toggleCanvas)
  return (
    <IconButton
      label={open ? '收起画布' : '展开画布'}
      size={30}
      active={open}
      onClick={toggleCanvas}
    >
      <PanelRight size={15} strokeWidth={1.5} aria-hidden />
    </IconButton>
  )
}

function WindowControls(): React.JSX.Element {
  const maximized = useAppStore((s) => s.windowState.maximized)

  return (
    <div className="tb-window no-drag" role="group" aria-label="窗口控制">
      <button
        type="button"
        className="tb-win-btn"
        aria-label="最小化窗口"
        title="最小化"
        onClick={() => void window.morrow.window.minimize()}
      >
        <Minus size={14} strokeWidth={1.4} aria-hidden />
      </button>
      <button
        type="button"
        className="tb-win-btn"
        aria-label={maximized ? '还原窗口' : '最大化窗口'}
        title={maximized ? '还原' : '最大化'}
        onClick={() => void window.morrow.window.toggleMaximize()}
      >
        {maximized ? (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <rect x="1.2" y="3.2" width="7.2" height="7.2" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path
              d="M3.6 3.2V1.8c0-.4.3-.7.7-.7h6.2c.4 0 .7.3.7.7v6.2c0 .4-.3.7-.7.7h-1.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
        ) : (
          <Square size={11.5} strokeWidth={1.4} aria-hidden />
        )}
      </button>
      <button
        type="button"
        className="tb-win-btn tb-win-close"
        aria-label="关闭窗口"
        title="关闭"
        onClick={() => void window.morrow.window.close()}
      >
        <X size={14} strokeWidth={1.4} aria-hidden />
      </button>
    </div>
  )
}

/**
 * 无边框标题栏：拖动区 + 当前文件夹 + 居中对话标题（双击重命名）
 * + 目标状态 + 浏览器/画布开关 + 窗口控制（唯一允许直连 window.morrow 的地方）。
 */
export function TitleBar(): React.JSX.Element {
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const bootError = useAppStore((s) => s.bootError)
  const platform = useAppStore((s) => s.appInfo?.platform)
  const isMac = platform === 'darwin'

  return (
    <header className={['titlebar', 'tb-root', 'drag-region', isMac ? 'is-mac' : ''].filter(Boolean).join(' ')}>
      <div className="tb-left">
        <IconButton label="收起侧栏 (Ctrl+B)" onClick={toggleSidebar} size={30} active={!sidebarCollapsed}>
          <PanelLeft size={15} strokeWidth={1.5} aria-hidden />
        </IconButton>
        <WorkspaceChip />
      </div>

      <div className="tb-center">
        {bootError ? (
          <span className="tb-error mono" role="alert">
            启动异常
          </span>
        ) : activeSessionId ? (
          <SessionTitle />
        ) : null}
      </div>

      <div className="tb-right no-drag">
        <GoalIndicator />
        <span className="tb-sep" aria-hidden />
        <BrowserToggle />
        <TerminalToggle />
        <CanvasToggle />
        <WindowControls />
      </div>
    </header>
  )
}
