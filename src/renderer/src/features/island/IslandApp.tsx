import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronUp,
  GripHorizontal,
  LoaderCircle,
  MessageSquare,
  Plus,
  Send,
  Sparkles,
  X
} from 'lucide-react'
import type { IslandSnapshot, IslandStatus, SessionMeta, Settings } from '@shared/types'
import { applyThemePreferences } from '../../theme'
import './island.css'

const STATUS_LABEL: Record<IslandStatus, string> = {
  idle: '待命',
  running: '进行中',
  waiting: '等你确认',
  done: '已完成',
  error: '需要看看'
}

function PetOrb({ status, large = false }: { status: IslandStatus; large?: boolean }): ReactElement {
  return (
    <div className="island-pet" data-status={status} data-large={large || undefined} aria-hidden>
      <span className="island-pet-halo" />
      <svg viewBox="0 0 40 40" className="island-pet-face">
        <defs>
          <linearGradient id="island-gold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f4e5c0" />
            <stop offset="0.48" stopColor="#c8ae7d" />
            <stop offset="1" stopColor="#8d7343" />
          </linearGradient>
        </defs>
        <path
          d="M11.4 14.2 12.7 8.4l4.7 3.1M28.6 14.2 27.3 8.4l-4.7 3.1"
          fill="#161b22"
          stroke="url(#island-gold)"
          strokeWidth="0.9"
          strokeLinejoin="round"
        />
        <circle cx="20" cy="20" r="12.1" fill="#10141a" stroke="url(#island-gold)" strokeWidth="1.05" />
        <path
          d="M20 10.4c-1.7 3.3-4.2 5-4.2 8.4 0 2.9 1.9 4.9 4.2 4.9s4.2-2 4.2-4.9c0-3.4-2.5-5.1-4.2-8.4z"
          fill="url(#island-gold)"
          opacity="0.14"
        />
        <g className="island-pet-eyes">
          <ellipse cx="16.9" cy="19.7" rx="0.95" ry="1.35" fill="#e9d7ab" />
          <ellipse cx="23.1" cy="19.7" rx="0.95" ry="1.35" fill="#e9d7ab" />
          <circle cx="16.9" cy="19.9" r="0.4" fill="#0b0d10" />
          <circle cx="23.1" cy="19.9" r="0.4" fill="#0b0d10" />
        </g>
        <path d="M19.3 23.1c.45.4.95.4 1.4 0" stroke="#c8ae7d" strokeWidth="0.7" strokeLinecap="round" fill="none" opacity="0.65" />
        <circle className="island-pet-spark" cx="30.6" cy="10.6" r="0.9" fill="#e4ce9e" />
      </svg>
      <span className="island-pet-orbit" />
    </div>
  )
}

function Waveform(): ReactElement {
  return (
    <span className="island-wave" aria-hidden>
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}

function relativeTime(at: number): string {
  const diff = Date.now() - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const date = new Date(at)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
}

export function IslandApp(): ReactElement {
  const [snapshot, setSnapshot] = useState<IslandSnapshot | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recent, setRecent] = useState<SessionMeta[]>([])
  const [ctrlSend, setCtrlSend] = useState(false)
  const [now, setNow] = useState(Date.now())
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const expandedRef = useRef(false)

  useEffect(() => {
    expandedRef.current = expanded
  }, [expanded])

  useEffect(() => {
    let active = true
    const applySettings = (next: Settings): void => {
      setCtrlSend(next.sendKey === 'ctrl+enter')
      applyThemePreferences(next)
    }
    const off = window.morrow.island.onState((next) => {
      if (active) setSnapshot(next)
    })
    void window.morrow.island.snapshot().then((res) => {
      if (active && res.ok) setSnapshot(res.data)
    })
    void window.morrow.settings.get().then((res) => {
      if (active && res.ok) applySettings(res.data)
    })
    const offSettings = window.morrow.settings.onChanged((next) => {
      if (active) applySettings(next)
    })
    return () => {
      active = false
      off()
      offSettings()
    }
  }, [])

  useEffect(() => {
    if (expanded) return
    setError(null)
  }, [expanded])

  useEffect(() => {
    if (!expanded) return
    let cancelled = false
    void window.morrow.session.list().then((res) => {
      if (!cancelled && res.ok) {
        setRecent(res.data.filter((item) => !item.archived).slice(0, 3))
      }
    })
    return () => {
      cancelled = true
    }
  }, [expanded, snapshot?.sessionId])

  useEffect(() => {
    const status = snapshot?.status
    if (status !== 'running' && status !== 'waiting') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [snapshot?.status])

  useEffect(() => {
    if (!expanded) return
    const onBlur = (): void => {
      window.setTimeout(() => {
        if (document.hasFocus()) return
        setExpanded(false)
        void window.morrow.island.setExpanded(false)
      }, 260)
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [expanded])

  useEffect(() => {
    if (!expanded) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setExpanded(false)
      void window.morrow.island.setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  useEffect(() => {
    if (!expanded) return
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(104, textarea.scrollHeight)}px`
  }, [draft, expanded])

  const status = snapshot?.status ?? 'idle'
  const running = status === 'running' || status === 'waiting'
  const total = snapshot?.todos.length ?? 0
  const completed = snapshot?.todos.filter((todo) => todo.status === 'completed').length ?? 0
  const progress = total > 0 ? completed / total : null
  const elapsed = snapshot?.startedAt && running && now - snapshot.startedAt >= 1000 ? formatElapsed(now - snapshot.startedAt) : null
  const title = snapshot?.sessionId ? snapshot.sessionTitle || '新的对话' : 'Morrow 小伙伴'
  const detail = snapshot?.detail || '在桌面陪你待命'

  const expand = (): void => {
    setExpanded(true)
    void window.morrow.island.setExpanded(true)
    window.setTimeout(() => textareaRef.current?.focus(), 140)
  }

  const collapse = (): void => {
    setExpanded(false)
    void window.morrow.island.setExpanded(false)
  }

  const openMain = (input?: { sessionId?: string; newSession?: boolean }): void => {
    void window.morrow.island.openMain(input)
    collapse()
  }

  const submit = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    const result = await window.morrow.island.quickSend({
      text,
      ...(snapshot?.sessionId ? { sessionId: snapshot.sessionId } : {})
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setDraft('')
    setExpanded(false)
  }

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return
    const sendNow = ctrlSend ? event.ctrlKey || event.metaKey : !event.shiftKey && !event.ctrlKey && !event.metaKey
    if (event.key === 'Enter' && sendNow) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <div className="island-shell" data-expanded={expanded || undefined} data-status={status}>
      <div className="island-frame">
        <div className="island-pill">
          <PetOrb status={status} />
          <div className="island-copy">
            <div className="island-title-row">
              <span className="island-title truncate">{title}</span>
              {running ? <Waveform /> : null}
              {snapshot?.unread ? <span className="island-unread" aria-label="有新进展" /> : null}
            </div>
            <p className="island-detail truncate" aria-live="polite">
              {detail}
            </p>
          </div>
          <div className="island-actions">
            <button type="button" className="island-icon-btn" aria-label="快速对话" title="快速对话" onClick={(event) => {
              event.stopPropagation()
              expand()
            }}>
              <MessageSquare size={15} strokeWidth={1.6} />
            </button>
            <button type="button" className="island-icon-btn" aria-label="打开 Morrow" title="打开 Morrow" onClick={(event) => {
              event.stopPropagation()
              openMain()
            }}>
              <ArrowUpRight size={15} strokeWidth={1.6} />
            </button>
            <button type="button" className="island-icon-btn island-chevron" aria-label="展开" title="展开" onClick={(event) => {
              event.stopPropagation()
              expand()
            }}>
              {expanded ? <ChevronDown size={15} strokeWidth={1.6} /> : <ChevronUp size={15} strokeWidth={1.6} />}
            </button>
          </div>
          <span
            className={`island-progress-line${progress === null && running ? ' is-indeterminate' : ''}`}
            style={progress !== null ? ({ '--island-progress': `${Math.round(progress * 100)}%` } as CSSProperties) : undefined}
            aria-hidden
          />
        </div>

        {expanded ? (
          <section className="island-panel" aria-label="Morrow 小伙伴面板">
            <header className="island-panel-head">
              <PetOrb status={status} large />
              <div className="island-panel-title">
                <span className="island-panel-name">Morrow 小伙伴</span>
                <span className="island-status-chip" data-status={status}>
                  <i />
                  {STATUS_LABEL[status]}
                  {elapsed ? <em>{elapsed}</em> : null}
                </span>
              </div>
              <button type="button" className="island-icon-btn" aria-label="收起" title="收起" onClick={collapse}>
                <ChevronDown size={16} strokeWidth={1.6} />
              </button>
            </header>

            <div className="island-panel-body">
              <div className="island-task" data-status={status}>
                <div className="island-task-head">
                  <div>
                    <p className="island-eyebrow mono">当前任务</p>
                    <p className="island-task-title truncate">{snapshot?.sessionId ? title : '桌面伙伴，随时待命'}</p>
                  </div>
                  {total > 0 ? (
                    <span className="island-count mono">
                      {completed}/{total}
                    </span>
                  ) : null}
                </div>
                <p className="island-task-detail">{detail}</p>
                {total > 0 || running ? (
                  <div className={`island-task-bar${total === 0 ? ' is-live' : ''}`} aria-hidden>
                    <span style={total > 0 ? { width: `${Math.round((progress ?? 0) * 100)}%` } : undefined} />
                  </div>
                ) : null}

                {total > 0 ? (
                  <ul className="island-todos">
                    {snapshot?.todos.slice(0, 5).map((todo) => (
                      <li key={todo.id} className="island-todo" data-status={todo.status}>
                        <span className="island-todo-icon" aria-hidden>
                          {todo.status === 'completed' ? (
                            <Check size={10} strokeWidth={2.4} />
                          ) : todo.status === 'in_progress' ? (
                            <i />
                          ) : (
                            <span />
                          )}
                        </span>
                        <span className="truncate">{todo.text}</span>
                      </li>
                    ))}
                  </ul>
                ) : status === 'idle' ? (
                  <p className="island-empty-hint">
                    <Sparkles size={13} strokeWidth={1.5} />
                    交代一句话，它会在主窗口开始工作。
                  </p>
                ) : null}
              </div>

              <div className="island-composer">
                <textarea
                  ref={textareaRef}
                  value={draft}
                  rows={2}
                  maxLength={8_000}
                  spellCheck={false}
                  placeholder={snapshot?.sessionId ? '继续交代一件事…' : '交给 Morrow 一件事…'}
                  aria-label="交给 Morrow 的消息"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onComposerKeyDown}
                />
                <div className="island-composer-foot">
                  <span className="island-compose-hint mono">{ctrlSend ? 'Ctrl+Enter 发送' : 'Enter 发送'} · Esc 收起</span>
                  <button
                    type="button"
                    className="island-send"
                    aria-label="发送"
                    disabled={!draft.trim() || busy}
                    onClick={() => void submit()}
                  >
                    {busy ? <LoaderCircle size={14} className="island-spin" /> : <Send size={14} strokeWidth={1.8} />}
                  </button>
                </div>
                {error ? <p className="island-error">{error}</p> : null}
              </div>

              {recent.length > 0 ? (
                <div className="island-recent">
                  <p className="island-eyebrow mono">最近对话</p>
                  <ul>
                    {recent.map((session) => (
                      <li key={session.id}>
                        <button type="button" onClick={() => openMain({ sessionId: session.id })}>
                          <span className="island-recent-icon" aria-hidden>
                            {session.id === snapshot?.sessionId ? <i /> : <MessageSquare size={12} strokeWidth={1.5} />}
                          </span>
                          <span className="island-recent-title truncate">{session.title || '未命名对话'}</span>
                          <span className="island-recent-time mono">{relativeTime(session.updatedAt)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <p className="island-tip">
                <GripHorizontal size={12} strokeWidth={1.4} />
                按住顶部拖动，可把它放到桌面任意角落
              </p>
            </div>

            <footer className="island-panel-foot">
              <button type="button" className="island-text-btn" onClick={() => openMain({ newSession: true })}>
                <Plus size={13} strokeWidth={1.7} />
                新对话
              </button>
              <button type="button" className="island-text-btn is-gold" onClick={() => openMain({ ...(snapshot?.sessionId ? { sessionId: snapshot.sessionId } : {}) })}>
                打开 Morrow
                <ArrowUpRight size={13} strokeWidth={1.7} />
              </button>
              <button type="button" className="island-icon-btn island-hide" aria-label="隐藏小伙伴" title="隐藏（Ctrl+Shift+M 唤回）" onClick={() => void window.morrow.island.hide()}>
                <X size={14} strokeWidth={1.6} />
              </button>
            </footer>
          </section>
        ) : null}
      </div>
    </div>
  )
}
