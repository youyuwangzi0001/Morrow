// shell 功能域组件：由 5 个 TSX 文件扁平合并。
import './shell.css'
import { useEffect, useState, useRef } from 'react'
import { Minus, Power, AlarmClock, Archive, FolderKanban, Ghost, Pencil, Pin, PinOff, Plus, Search, Settings, Trash2, ChevronDown, Folder, Globe, Moon, PanelLeft, PanelRight, Square, SquareTerminal, Sun, Target, X, AlertTriangle, CheckCircle2, Info, XCircle, ArrowUpRight } from 'lucide-react'
import { Button, Modal, IconButton, WithTooltip } from '../components'
import type { SessionMeta } from '@shared/types'
import type { Toast } from '../store'
import { useAppStore } from '../store'
import { FileTree } from './files'
import { openWorkbench } from './workbench-core'
import { GOAL_STATUS_LABEL } from './goal-core'
import { useStudioStore } from './studio-core'
import { createPortal } from 'react-dom'
import { BrandMark } from '../components'
import { SUGGESTIONS, findModel } from '@shared/contracts'

type Choice = 'minimize' | 'quit'

/**
 * 关闭询问：标题栏关闭按钮、Alt+F4 与灵动岛“关闭 Morrow…”共用同一选择。
 * 选定后由主进程记住 closeAction，后续直接执行、不再询问。
 */
export function CloseConfirm(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<Choice | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(
    () =>
      window.morrow.window.onCloseRequested(() => {
        setBusy(null)
        setError(null)
        setOpen(true)
      }),
    []
  )

  const choose = async (action: Choice): Promise<void> => {
    if (busy) return
    setBusy(action)
    setError(null)
    const result = await window.morrow.window.resolveClose(action)
    if (!result.ok) {
      setBusy(null)
      setError(result.error.message)
      return
    }
    // 最小化时主进程会保留窗口；退出时进程结束，这个弹窗无需再手动收起。
    setOpen(false)
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) setOpen(false)
      }}
      title="要关闭 Morrow 吗？"
      description="选定一次后会记住，可在 设置 → 外观 随时修改。"
      width={520}
      ariaLabel="关闭 Morrow 的方式"
      footer={
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy !== null}>
          取消
        </Button>
      }
    >
      <div className="close-choice-grid">
        <button
          type="button"
          className="close-choice"
          disabled={busy !== null}
          onClick={() => void choose('minimize')}
        >
          <span className="close-choice-icon" aria-hidden>
            <Minus size={18} strokeWidth={1.7} />
          </span>
          <span className="close-choice-copy">
            <strong>最小化到任务栏</strong>
            <span>Morrow 留在后台继续运行，正在执行的任务不会中断。</span>
          </span>
        </button>
        <button
          type="button"
          className="close-choice is-danger"
          disabled={busy !== null}
          onClick={() => void choose('quit')}
        >
          <span className="close-choice-icon" aria-hidden>
            <Power size={18} strokeWidth={1.7} />
          </span>
          <span className="close-choice-copy">
            <strong>完全退出</strong>
            <span>结束后台任务，关闭 Morrow 的所有窗口与进程。</span>
          </span>
        </button>
      </div>
      {error ? (
        <p className="close-choice-error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  )
}

function startOfDay(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 对话列表的相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / 日期 */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const date = new Date(ts)
  const today = startOfDay(Date.now())
  if (ts >= today - 86_400_000) return '昨天'
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return sameYear ? `${month}/${day}` : `${date.getFullYear()}/${month}/${day}`
}

interface SessionGroup {
  label: string
  items: SessionMeta[]
}

function groupSessions(sessions: SessionMeta[]): SessionGroup[] {
  const today = startOfDay(Date.now())
  const groups: SessionGroup[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '更早', items: [] }
  ]
  for (const session of sessions) {
    if (session.updatedAt >= today) groups[0].items.push(session)
    else if (session.updatedAt >= today - 86_400_000) groups[1].items.push(session)
    else groups[2].items.push(session)
  }
  return groups.filter((group) => group.items.length > 0)
}

function SessionRow({
  session,
  active,
  onDelete
}: {
  session: SessionMeta
  active: boolean
  onDelete: (session: SessionMeta) => void
}): React.JSX.Element {
  const selectSession = useAppStore((s) => s.selectSession)
  const renameSession = useAppStore((s) => s.renameSession)
  const setSessionPinned = useAppStore((s) => s.setSessionPinned)
  const setSessionArchived = useAppStore((s) => s.setSessionArchived)
  const pendingPermission = useAppStore((s) => s.pendingPermissions[session.id] ?? null)
  const pendingQuestion = useAppStore((s) => s.pendingQuestions[session.id] ?? null)
  const running = useAppStore((s) => Boolean(s.runs[session.id]))
  const attention = Boolean(pendingPermission || pendingQuestion)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title)
  const inputRef = useRef<HTMLInputElement>(null)

  const beginEdit = (): void => {
    setDraft(session.title)
    setEditing(true)
    window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
  }

  const commit = (): void => {
    if (!editing) return
    setEditing(false)
    const title = draft.trim()
    if (title && title !== session.title) void renameSession(session.id, title)
  }

  return (
    <li className={['sb-session', active ? 'is-active' : ''].filter(Boolean).join(' ')}>
      {editing ? (
        <input
          ref={inputRef}
          className="sb-session-input"
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
      ) : (
        <button
          type="button"
          className="sb-session-main"
          onClick={() => void selectSession(session.id)}
          onDoubleClick={beginEdit}
          aria-current={active ? 'true' : undefined}
          title={[
            session.preview ? `${session.title}\n${session.preview}` : session.title,
            attention ? '等待你的确认' : running ? '正在运行' : ''
          ]
            .filter(Boolean)
            .join('\n')}
        >
          {session.pinned ? <Pin size={10} strokeWidth={1.8} className="sb-session-pin" aria-label="已置顶" /> : null}
          <span className="sb-session-title truncate">{session.title}</span>
          {session.demo && !session.temporary ? (
            <span className="sb-session-demo mono" title="演示会话：只在一次性演示文件夹里运行">
              演示
            </span>
          ) : null}
          {attention ? (
            <span className="sb-session-flag is-attention" role="img" aria-label="等待你的确认" title="等待你的确认" />
          ) : running ? (
            <span className="sb-session-flag is-running" role="img" aria-label="正在运行" title="正在运行" />
          ) : null}
          <span className="sb-session-time mono" aria-hidden>
            {session.todoProgress
              ? `${session.todoProgress.completed}/${session.todoProgress.total}`
              : relativeTime(session.updatedAt)}
          </span>
        </button>
      )}
      <span className="sb-session-actions">
        {session.temporary ? null : (
          <>
            <IconButton
              label={session.pinned ? '取消置顶' : '置顶对话'}
              size={22}
              active={session.pinned === true}
              onClick={() => void setSessionPinned(session.id, session.pinned !== true)}
            >
              {session.pinned ? <PinOff size={12} strokeWidth={1.5} aria-hidden /> : <Pin size={12} strokeWidth={1.5} aria-hidden />}
            </IconButton>
            <IconButton
              label="归档对话"
              size={22}
              onClick={() => void setSessionArchived(session.id, true)}
            >
              <Archive size={12} strokeWidth={1.5} aria-hidden />
            </IconButton>
          </>
        )}
        <IconButton label="重命名对话" size={22} onClick={beginEdit}>
          <Pencil size={12} strokeWidth={1.5} aria-hidden />
        </IconButton>
        <IconButton label="删除对话" size={22} tone="danger" onClick={() => onDelete(session)}>
          <Trash2 size={12} strokeWidth={1.5} aria-hidden />
        </IconButton>
      </span>
    </li>
  )
}

function CollapsedRail(): React.JSX.Element {
  const sessions = useAppStore((s) => s.sessions)
  const activeId = useAppStore((s) => s.activeSessionId)
  const selectSession = useAppStore((s) => s.selectSession)
  const newSession = useAppStore((s) => s.newSession)
  const openPalette = useAppStore((s) => s.openPalette)
  const openSettings = useAppStore((s) => s.openSettings)
  const hasAnyApiKey = useAppStore((s) => s.hasAnyApiKey)
  const recent = sessions.filter((session) => !session.archived).sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true)).slice(0, 7)

  return (
    <div className="sb-rail">
      <div className="sb-rail-group">
        <WithTooltip label="新建对话 (Ctrl+N)" side="right">
          <IconButton label="新建对话" size={34} onClick={() => void newSession()}>
            <Plus size={16} strokeWidth={1.5} aria-hidden />
          </IconButton>
        </WithTooltip>
        <WithTooltip label="临时对话 · 不保存" side="right">
          <IconButton label="新建临时对话" size={34} onClick={() => void newSession({ temporary: true })}>
            <Ghost size={15} strokeWidth={1.5} aria-hidden />
          </IconButton>
        </WithTooltip>
        <WithTooltip label="搜索或运行命令 (Ctrl+K)" side="right">
          <IconButton label="搜索或运行命令" size={34} onClick={openPalette}>
            <Search size={15} strokeWidth={1.5} aria-hidden />
          </IconButton>
        </WithTooltip>
      </div>

      {recent.length > 0 ? <span className="sb-rail-sep" aria-hidden /> : null}

      <nav className="sb-rail-sessions" aria-label="对话列表">
        {recent.map((session) => (
          <WithTooltip key={session.id} label={session.title} side="right">
            <button
              type="button"
              className={['sb-rail-session', session.id === activeId ? 'is-active' : ''].filter(Boolean).join(' ')}
              onClick={() => void selectSession(session.id)}
              aria-label={session.title}
            >
              {session.title.trim().charAt(0) || '新'}
            </button>
          </WithTooltip>
        ))}
      </nav>

      <div className="sb-rail-foot">
        <WithTooltip label={hasAnyApiKey ? '设置 · 模型已连接 (Ctrl+,)' : '设置 · 模型未连接 (Ctrl+,)'} side="right">
          <button
            type="button"
            className={['sb-rail-settings', hasAnyApiKey ? 'is-on' : 'is-off'].join(' ')}
            onClick={openSettings}
            aria-label={hasAnyApiKey ? '设置，模型已连接' : '设置，模型未连接'}
          >
            <Settings size={15} strokeWidth={1.5} aria-hidden />
            <span className="sb-conn-dot" aria-hidden />
          </button>
        </WithTooltip>
      </div>
    </div>
  )
}

export function Sidebar(): React.JSX.Element {
  const sessions = useAppStore((s) => s.sessions)
  const activeId = useAppStore((s) => s.activeSessionId)
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const newSession = useAppStore((s) => s.newSession)
  const openPalette = useAppStore((s) => s.openPalette)
  const openSettings = useAppStore((s) => s.openSettings)
  const deleteSession = useAppStore((s) => s.deleteSession)
  const run = useAppStore((s) => s.run)
  const hasAnyApiKey = useAppStore((s) => s.hasAnyApiKey)
  const version = useAppStore((s) => s.appInfo?.version)
  const [pendingDelete, setPendingDelete] = useState<SessionMeta | null>(null)

  if (collapsed) {
    return (
      <aside className="sidebar is-collapsed" aria-label="侧栏">
        <CollapsedRail />
      </aside>
    )
  }

  const temporarySessions = sessions.filter((session) => session.temporary)
  const visibleSessions = sessions.filter((session) => !session.temporary && !session.archived)
  const hasArchived = sessions.some((session) => !session.temporary && session.archived)
  const pinnedSessions = visibleSessions.filter((session) => session.pinned)
  const groups: SessionGroup[] = [
    ...(temporarySessions.length > 0 ? [{ label: '临时 · 不保存', items: temporarySessions }] : []),
    ...(pinnedSessions.length > 0 ? [{ label: '置顶', items: pinnedSessions }] : []),
    ...groupSessions(visibleSessions.filter((session) => !session.pinned))
  ]

  return (
    <aside className="sidebar" aria-label="侧栏">
      <button type="button" className="sb-new" onClick={() => void newSession()}>
        <Plus size={15} strokeWidth={1.6} aria-hidden />
        <span className="sb-new-label">新建对话</span>
        <span className="sb-new-kbd mono" aria-hidden>
          Ctrl N
        </span>
      </button>

      <button
        type="button"
        className="sb-temp"
        onClick={() => void newSession({ temporary: true })}
        title="临时对话：关闭应用后消失，不进入历史与搜索，不读取或写入长期记忆"
      >
        <Ghost size={13} strokeWidth={1.5} aria-hidden />
        <span className="sb-temp-label">临时对话</span>
        <span className="sb-temp-note mono" aria-hidden>
          不保存
        </span>
      </button>

      <button type="button" className="sb-search" onClick={openPalette}>
        <Search size={14} strokeWidth={1.5} aria-hidden />
        <span className="sb-search-label">搜索或运行命令</span>
        <span className="sb-search-kbd mono" aria-hidden>
          Ctrl K
        </span>
      </button>

      <button
        type="button"
        className="sb-projects"
        onClick={() => openWorkbench('projects')}
        title="项目：长期说明、资料与项目内对话"
        aria-label="打开项目主页"
      >
        <FolderKanban size={14} strokeWidth={1.5} aria-hidden />
        <span className="sb-projects-label">项目</span>
        <span className="sb-projects-hint mono" aria-hidden>
          长期背景
        </span>
      </button>

      <button
        type="button"
        className="sb-projects sb-schedules"
        onClick={() => openWorkbench('schedules')}
        title="定时任务：到点自动开始一件事"
        aria-label="打开定时任务"
      >
        <AlarmClock size={14} strokeWidth={1.5} aria-hidden />
        <span className="sb-projects-label">定时任务</span>
        <span className="sb-projects-hint mono" aria-hidden>
          自动执行
        </span>
      </button>

      <FileTree />

      <nav className="sb-nav" aria-label="对话列表">
        {groups.length === 0 ? (
          <div className="sb-empty">
            <p className="sb-empty-title">{hasArchived ? '没有进行中的对话' : '还没有对话'}</p>
            <p className="sb-empty-hint">
              {hasArchived ? '已归档的对话在「设置 → 归档」中。' : '从一句话开始。'}
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.label} className="sb-group" aria-label={`${group.label}的对话`}>
              <h2 className="sb-group-head">{group.label}</h2>
              <ul className="sb-session-list">
                {group.items.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={session.id === activeId}
                    onDelete={setPendingDelete}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </nav>

      <footer className="sb-foot">
        <button
          type="button"
          className="sb-foot-row"
          onClick={openSettings}
          title={hasAnyApiKey ? '模型已连接 · 打开设置' : '模型未连接，打开设置去连接'}
          aria-label={hasAnyApiKey ? '设置，模型已连接' : '设置，模型未连接'}
        >
          <Settings size={14} strokeWidth={1.5} aria-hidden />
          <span className="sb-foot-label">设置</span>
          <span className={['sb-foot-conn', hasAnyApiKey ? 'is-on' : 'is-off'].join(' ')}>
            <span className="sb-conn-dot" aria-hidden />
            {hasAnyApiKey ? '已连接' : '未连接'}
          </span>
          <span className="sb-foot-version mono" aria-hidden>
            v{version ?? '0.1.0'}
          </span>
        </button>
      </footer>

      <Modal
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title="删除这条对话？"
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              data-autofocus
              onClick={() => {
                const target = pendingDelete
                setPendingDelete(null)
                if (target) void deleteSession(target.id)
              }}
            >
              删除
            </Button>
          </>
        }
      >
        <p className="sb-delete-body">
          「{pendingDelete?.title ?? ''}」和它的全部消息会被删除，无法恢复。文件夹里的文件不受影响。
        </p>
        {pendingDelete?.temporary ? (
          <p className="sb-delete-run" role="note">
            这是临时对话：它本来就不会写入磁盘，删除后立即从内存中消失。
          </p>
        ) : null}
        {pendingDelete && run?.sessionId === pendingDelete.id ? (
          <p className="sb-delete-run" role="note">
            这条对话正在运行。删除会先停止当前任务，并清理它的撤销快照。
          </p>
        ) : (
          <p className="sb-delete-run is-muted">它的撤销快照会一并清理；文件夹里的文件保留。</p>
        )}
        <p className="sb-delete-note mono">DEL · 只删对话记录、撤销快照，不删文件夹文件</p>
      </Modal>
    </aside>
  )
}

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

/** 主题切换：Agent 与创作台共用同一状态，在两种模式顶栏常驻。 */
function ThemeToggle(): React.JSX.Element {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  return (
    <IconButton
      label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
      size={30}
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
    >
      {theme === 'dark' ? <Sun size={15} strokeWidth={1.5} aria-hidden /> : <Moon size={15} strokeWidth={1.5} aria-hidden />}
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
        <button
          type="button"
          className="tb-create"
          title="打开创作台"
          aria-label="打开创作台"
          onClick={() => void useStudioStore.getState().openStudio()}
        >
          <span>创作台</span>
        </button>
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
        <ThemeToggle />
        <WindowControls />
      </div>
    </header>
  )
}

const AUTO_DISMISS_MS = 4000

const MAX_VISIBLE = 4

const KIND_ICON = {
  info: Info,
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle
} as const

/** 动作按钮：先执行动作，再收起这条通知 */
function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }): React.JSX.Element {
  const Icon = KIND_ICON[toast.kind]
  return (
    <div className={`toast-item toast-${toast.kind}`}>
      <span className="toast-icon" aria-hidden>
        <Icon size={15} strokeWidth={1.6} />
      </span>
      <p className="toast-msg">{toast.message}</p>
      {toast.action && toast.actionLabel ? (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            onDismiss()
            toast.action?.()
          }}
        >
          {toast.actionLabel}
        </button>
      ) : null}
      <button type="button" className="toast-close" aria-label="收起通知" onClick={onDismiss}>
        <X size={12} strokeWidth={1.8} aria-hidden />
      </button>
      <span className="toast-progress" aria-hidden />
    </div>
  )
}

/**
 * Toast 堆叠器。
 * store 只保存「最近一条 toast」（单一事实源），这里把每次新出现的 toast 追加为本地堆叠，
 * 4 秒自动消失，行动作执行后收起；全部收起后把 store 的 toast 清空。
 */
export function Toasts(): React.JSX.Element | null {
  const toast = useAppStore((s) => s.toast)
  const dismissToast = useAppStore((s) => s.dismissToast)
  const [items, setItems] = useState<Toast[]>([])
  const timers = useRef(new Map<string, number>())

  useEffect(() => {
    if (!toast) return
    setItems((previous) => {
      if (previous.some((item) => item.id === toast.id)) return previous
      return [...previous, toast].slice(-MAX_VISIBLE)
    })
  }, [toast])

  useEffect(() => {
    const live = new Set(items.map((item) => item.id))
    for (const [id, timer] of timers.current) {
      if (live.has(id)) continue
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
    for (const item of items) {
      if (timers.current.has(item.id)) continue
      const timer = window.setTimeout(() => {
        timers.current.delete(item.id)
        setItems((previous) => previous.filter((entry) => entry.id !== item.id))
      }, AUTO_DISMISS_MS)
      timers.current.set(item.id, timer)
    }
  }, [items])

  useEffect(() => {
    if (items.length > 0) return
    if (useAppStore.getState().toast) dismissToast()
  }, [items.length, dismissToast])

  useEffect(() => {
    return () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer)
      timers.current.clear()
    }
  }, [])

  if (items.length === 0) return null

  return createPortal(
    <div className="toasts" role="region" aria-label="通知" aria-live="polite">
      {items.map((item) => (
        <ToastItem
          key={item.id}
          toast={item}
          onDismiss={() => setItems((previous) => previous.filter((entry) => entry.id !== item.id))}
        />
      ))}
    </div>,
    document.body
  )
}

function greetingOf(hour: number): string {
  if (hour < 5) return '夜深了'
  if (hour < 11) return '早上好'
  if (hour < 13) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

function dateLine(date: Date): string {
  const week = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()]
  return `${date.getMonth() + 1}月${date.getDate()}日，周${week}。`
}

/** 每天换一句安静的提示，不做模板化小标签 */
const DAILY_NOTES = [
  '适合把散在桌面上的文件理一理',
  '适合把攒下的表格算成一个结论',
  '适合把一个想法写成能用的第一版',
  '适合让 Morrow 跑完一件拖了很久的小事',
  '适合把周报写完，然后去散个步',
  '适合慢慢读一份数据，找出一个问题',
  '适合先做最小的一步，剩下的交给它'
]

function noteOf(date: Date): string {
  const start = new Date(date.getFullYear(), 0, 0)
  const day = Math.floor((date.getTime() - start.getTime()) / 86_400_000)
  return DAILY_NOTES[day % DAILY_NOTES.length]
}

export function Welcome(): React.JSX.Element {
  const demoAvailable = useAppStore((s) => s.demoAvailable)
  const startDemo = useAppStore((s) => s.startDemo)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const hasAnyApiKey = useAppStore((s) => s.hasAnyApiKey)
  const modelRef = useAppStore((s) => s.settings.defaultModel)
  const providers = useAppStore((s) => s.settings.providers)
  const openSettings = useAppStore((s) => s.openSettings)

  const now = new Date()
  const greeting = greetingOf(now.getHours())
  const model = findModel(providers, modelRef)

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <p className="welcome-overline">
          {dateLine(now)}
          {noteOf(now)}。
        </p>

        <h1 className="welcome-title">
          <span className="welcome-zh">{greeting}，今天想完成什么？</span>
        </h1>
        <p className="welcome-sub">说清想要的结果就行，过程我来想办法。</p>

        {demoAvailable ? (
          <div className="welcome-actions">
            <button type="button" className="welcome-demo" onClick={() => void startDemo()}>
              <BrandMark size={16} />
              <span>看一场演示</span>
              <span className="welcome-demo-meta mono">离线 · 约 40 秒</span>
            </button>
          </div>
        ) : null}

        <div className="welcome-papers">
          {SUGGESTIONS.map((suggestion, index) => (
            <button
              key={suggestion.title}
              type="button"
              className={['welcome-paper', index === 0 ? 'is-wide' : ''].filter(Boolean).join(' ')}
              onClick={() => void sendMessage(suggestion.prompt)}
            >
              <span className="welcome-paper-text">
                <span className="welcome-paper-title">{suggestion.title}</span>
                <span className="welcome-paper-desc">{suggestion.description}</span>
              </span>
              <ArrowUpRight className="welcome-paper-arrow" size={14} strokeWidth={1.5} aria-hidden />
            </button>
          ))}
        </div>

        <div className="welcome-foot">
          {hasAnyApiKey ? (
            <span className="welcome-foot-item">
              <span className="welcome-model-dot is-on" aria-hidden />
              <span className="mono">{model?.label ?? '模型已就绪'}</span>
            </span>
          ) : (
            <button type="button" className="welcome-foot-item is-action" onClick={openSettings}>
              <span className="welcome-model-dot is-off" aria-hidden />
              模型未连接 · 去连接
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
