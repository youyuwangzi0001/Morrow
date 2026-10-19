import { useRef, useState } from 'react'
import {
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2
} from 'lucide-react'
import type { SessionMeta } from '@shared/types'
import brandMarkUrl from '../../assets/brand-mark.svg'
import { useAppStore } from '../../state/store'
import { Button, IconButton, Modal, WithTooltip } from '../../ui'
import { FileTree } from '../files/FileTree'
import './Sidebar.css'

/* ── 工具 ─────────────────────────────────────────────────────── */

function startOfDay(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 会话列表的相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / 日期 */
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

/* ── 会话行（hover 出现重命名/删除，双击标题就地重命名） ────────── */

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
          title={session.preview ? `${session.title}\n${session.preview}` : session.title}
        >
          <span className="sb-session-title truncate">{session.title}</span>
          <span className="sb-session-time mono" aria-hidden>
            {session.todoProgress
              ? `${session.todoProgress.completed}/${session.todoProgress.total}`
              : relativeTime(session.updatedAt)}
          </span>
        </button>
      )}
      <span className="sb-session-actions">
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
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const hasAnyApiKey = useAppStore((s) => s.hasAnyApiKey)
  const recent = sessions.slice(0, 7)

  return (
    <div className="sb-rail">
      <WithTooltip label="展开侧栏 (Ctrl+B)" side="right">
        <button type="button" className="sb-rail-brand" onClick={toggleSidebar} aria-label="展开侧栏">
          <span className="serif">M</span>
          <span className="sb-rail-horizon" aria-hidden />
        </button>
      </WithTooltip>

      <div className="sb-rail-group">
        <WithTooltip label="新建对话 (Ctrl+N)" side="right">
          <IconButton label="新建对话" size={34} onClick={() => void newSession()}>
            <Plus size={16} strokeWidth={1.5} aria-hidden />
          </IconButton>
        </WithTooltip>
        <WithTooltip label="搜索或运行命令 (Ctrl+K)" side="right">
          <IconButton label="搜索或运行命令" size={34} onClick={openPalette}>
            <Search size={15} strokeWidth={1.5} aria-hidden />
          </IconButton>
        </WithTooltip>
      </div>

      {recent.length > 0 ? <span className="sb-rail-sep" aria-hidden /> : null}

      <nav className="sb-rail-sessions" aria-label="会话列表">
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

  const groups = groupSessions(sessions)

  return (
    <aside className="sidebar" aria-label="侧栏">
      <div className="sb-brand">
        <span className="sb-brand-glow" aria-hidden />
        <img className="sb-brand-icon" src={brandMarkUrl} alt="" width={52} height={52} draggable={false} />
        <span className="sb-brand-title serif">Morrow</span>
      </div>

      <button type="button" className="sb-new" onClick={() => void newSession()}>
        <Plus size={15} strokeWidth={1.6} aria-hidden />
        <span className="sb-new-label">新建对话</span>
        <span className="sb-new-kbd mono" aria-hidden>
          Ctrl N
        </span>
      </button>

      <button type="button" className="sb-search" onClick={openPalette}>
        <Search size={14} strokeWidth={1.5} aria-hidden />
        <span className="sb-search-label">搜索或运行命令</span>
        <span className="sb-search-kbd mono" aria-hidden>
          Ctrl K
        </span>
      </button>

      <FileTree />

      <nav className="sb-nav" aria-label="会话列表">
        {groups.length === 0 ? (
          <div className="sb-empty">
            <p className="sb-empty-title">还没有对话</p>
            <p className="sb-empty-hint">从一句话开始。</p>
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
            v{version ?? '1.0.0'}
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
          「{pendingDelete?.title ?? ''}」和它的全部消息会被删除，无法恢复。工作区里的文件不受影响。
        </p>
        <p className="sb-delete-note mono">DEL · 只删对话记录，不删文件</p>
      </Modal>
    </aside>
  )
}
