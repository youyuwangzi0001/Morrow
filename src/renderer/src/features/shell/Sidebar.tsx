import { useRef, useState } from 'react'
import {
  AlarmClock,
  Archive,
  FolderKanban,
  Ghost,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2
} from 'lucide-react'
import type { SessionMeta } from '@shared/types'
import { useAppStore } from '../../store'
import { Button, IconButton, Modal, WithTooltip } from '../../ui'
import { FileTree } from '../files/FileTree'
import { openWorkbench } from '../workbench/events'
import './Sidebar.css'

/* ── 工具 ─────────────────────────────────────────────────────── */

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

/* ── 对话行（hover 出现重命名/删除，双击标题就地重命名） ────────── */

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

/* ── 折叠态 64px 图标栏 ──────────────────────────────────────── */

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

/* ── Sidebar ─────────────────────────────────────────────────── */

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
