import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Folder, LayoutGrid, MessageCircle, Minus, PanelLeft, PanelRight, Square, Target, Wrench, X } from 'lucide-react'
import { findModel } from '@shared/models'
import { useAppStore } from '../../state/store'
import { openWorkbench } from '../workbench/events'
import { Dropdown, IconButton, type DropdownItem } from '../../ui'
import {
  contextSnapshot,
  contextSourceLabel,
  formatExactTokens
} from '../settings/context-format'
import { GOAL_STATUS_LABEL } from '../goal/goal-format'
import './TitleBar.css'

/** 当前会话标题：双击（或 F2）就地重命名 */
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
      title={activeSessionId ? '双击重命名这条对话' : undefined}
      aria-label={activeSessionId ? `当前对话：${title}，双击重命名` : '当前对话：新对话'}
    >
      <span className="truncate">{title}</span>
    </button>
  )
}

/** 当前工作区（点击切换文件夹） */
function WorkspaceChip(): React.JSX.Element {
  const workspace = useAppStore((s) => s.session?.workspace ?? s.settings.lastWorkspace)
  const pickWorkspace = useAppStore((s) => s.pickWorkspace)
  const running = useAppStore((s) => !!s.run)
  const name = workspace ? (workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace) : null

  return (
    <button
      type="button"
      className={['tb-workspace', workspace ? '' : 'is-empty'].filter(Boolean).join(' ')}
      title={running ? '生成中，结束后再切换工作区' : (workspace ?? '选择一个工作文件夹')}
      aria-label={workspace ? `当前工作区：${workspace}，点击切换` : '未选择工作区，点击选择文件夹'}
      onClick={() => void pickWorkspace()}
      disabled={running}
    >
      <Folder size={13} strokeWidth={1.5} aria-hidden />
      <span className="tb-workspace-name truncate">{name ?? '未选择文件夹'}</span>
      <ChevronDown size={11} strokeWidth={1.5} aria-hidden />
    </button>
  )
}

/** 模型 chip：下拉切换模型，末尾可进设置管理连接；未连接时圆点为锈红并直接去设置 */
function ModelChip(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const session = useAppStore((s) => s.session)
  const setModel = useAppStore((s) => s.setModel)
  const openSettings = useAppStore((s) => s.openSettings)
  const ref = session?.model ?? settings.defaultModel
  const model = findModel(settings.providers, ref)

  const items = useMemo<DropdownItem[]>(() => {
    const list: DropdownItem[] = []
    const available = settings.providers.filter(
      (provider) =>
        provider.enabled &&
        (provider.kind === 'demo' || provider.apiKeyStored || provider.id === ref.providerId)
    )
    for (const provider of available) {
      for (const info of provider.models) {
        const current = provider.id === ref.providerId && info.id === ref.modelId
        list.push({
          id: `${provider.id}:${info.id}`,
          label: current ? `${info.label}（当前）` : info.label,
          shortcut: provider.kind === 'demo' ? '离线' : provider.name,
          onSelect: () => void setModel(info.id, provider.id)
        })
      }
    }
    list.push({ id: 'manage', label: '管理模型连接…', separatorBefore: true, onSelect: openSettings })
    return list
  }, [settings.providers, ref.providerId, ref.modelId, setModel, openSettings])

  const disconnected = !useAppStore((s) => s.hasAnyApiKey) && ref.providerId !== 'demo'

  return (
    <Dropdown
      ariaLabel="切换模型"
      align="end"
      trigger={({ onClick, ...rest }) => (
        <button
          type="button"
          className={['tb-model', model ? '' : 'is-muted', disconnected ? 'is-disconnected' : '']
            .filter(Boolean)
            .join(' ')}
          onClick={disconnected ? openSettings : onClick}
          title={
            disconnected
              ? '模型未连接，点这里去设置里填 API Key'
              : model
                ? `${model.label}${model.note ? ` · ${model.note}` : ''}；点击切换`
                : '选择模型'
          }
          aria-label={disconnected ? '模型未连接，打开设置' : `当前模型：${model?.label ?? '未选择'}，点击切换`}
          {...rest}
        >
          <span className={['tb-model-dot', disconnected ? 'is-offline' : ''].join(' ')} aria-hidden />
          <span className="tb-model-label truncate">{model?.label ?? '选择模型'}</span>
        </button>
      )}
      items={items}
    />
  )
}

/** 会话模式小 chip：显示当前「聊天 / 工作」，点击切换（运行中由 store 提示先停止） */
function ModeChip(): React.JSX.Element | null {
  const session = useAppStore((s) => s.session)
  const setSessionMode = useAppStore((s) => s.setSessionMode)
  if (!session) return null
  const chat = session.mode === 'chat'
  const next = chat ? 'work' : 'chat'
  const detail = chat
    ? '当前：聊天模式（只讨论，不改文件、不跑命令）。点击切到工作模式。'
    : '当前：工作模式（可读写文件、执行命令，受权限档位约束）。点击切到聊天模式。'
  return (
    <button
      type="button"
      className={['tb-mode', chat ? 'is-chat' : 'is-work'].join(' ')}
      title={detail}
      aria-label={`${detail} 当前模式可点击切换`}
      aria-pressed={chat}
      onClick={() => void setSessionMode(next)}
    >
      {chat ? (
        <MessageCircle size={13} strokeWidth={1.5} aria-hidden />
      ) : (
        <Wrench size={13} strokeWidth={1.5} aria-hidden />
      )}
      <span className="tb-mode-label">{chat ? '聊天' : '工作'}</span>
    </button>
  )
}

/** 上下文占用环：tooltip 显示精确数字与「API 精确 / 估算」 */
function ContextMeter(): React.JSX.Element | null {
  const showTokenMeter = useAppStore((s) => s.settings.showTokenMeter)
  const usage = useAppStore((s) => s.session?.usage)
  const session = useAppStore((s) => s.session)
  const settings = useAppStore((s) => s.settings)
  const model = findModel(settings.providers, session?.model ?? settings.defaultModel)
  const snapshot = contextSnapshot(usage, model?.contextWindow)

  if (!showTokenMeter || snapshot.limit <= 0 || snapshot.used <= 0) return null

  const radius = 6.2
  const circumference = 2 * Math.PI * radius
  const tone = snapshot.ratio >= 0.9 ? 'is-danger' : snapshot.ratio >= 0.75 ? 'is-warning' : ''
  const detail = `上下文：${formatExactTokens(snapshot.used)} / ${formatExactTokens(snapshot.limit)} tokens（${snapshot.percent}%）· ${contextSourceLabel(snapshot.source)}`

  return (
    <span className={['tb-ctx', tone].filter(Boolean).join(' ')} role="img" aria-label={detail} title={detail}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--line-strong)" strokeWidth="1.5" />
        <circle
          cx="8"
          cy="8"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={`${Math.max(1, circumference * snapshot.ratio)} ${circumference}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
    </span>
  )
}

/** 目标指示：只在当前会话有 goal 时出现，靠近模型 chip，不挤压窗控 */
function GoalIndicator(): React.JSX.Element | null {
  const goal = useAppStore((s) => s.session?.goal ?? null)
  const run = useAppStore((s) => s.run)
  if (!goal) return null
  const running = !!run && goal.status === 'active'
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

/** 画布开关：未打开时打开（优先选最近产物），已打开时收起 */
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
 * 无边框标题栏：拖动区 + 当前工作区 + 居中会话标题（双击重命名）
 * + 模型 / 上下文 / 画布开关 + 命令面板入口 + 窗口控制（唯一允许直连 window.morrow 的地方）。
 */
export function TitleBar(): React.JSX.Element {
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const bootError = useAppStore((s) => s.bootError)
  const platform = useAppStore((s) => s.appInfo?.platform)
  const isMac = platform === 'darwin'

  return (
    <header className={['titlebar', 'tb-root', 'drag-region', isMac ? 'is-mac' : ''].filter(Boolean).join(' ')}>
      <div className="tb-left no-drag">
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
        ) : (
          <SessionTitle />
        )}
      </div>

      <div className="tb-right no-drag">
        <ModelChip />
        <ModeChip />
        <GoalIndicator />
        <ContextMeter />
        <span className="tb-sep" aria-hidden />
        <CanvasToggle />
        <IconButton label="打开工作台 (Ctrl+Shift+W)" onClick={() => openWorkbench()} size={30}>
          <LayoutGrid size={14} strokeWidth={1.5} aria-hidden />
        </IconButton>
        <WindowControls />
      </div>
    </header>
  )
}
