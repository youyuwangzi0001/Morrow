// sidechat 功能域组件：由 1 个 TSX 文件扁平合并。
import './sidechat.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, MessageSquare, Square, X } from 'lucide-react'
import { responsiveCanvasWidth, useAppStore } from '../store'
import { Button, ErrorNote, IconButton, ResizeHandle } from '../components'
import { Markdown } from '../components'

const SIDECHAT_EVENT = 'feature:sidechat:event'

interface SideMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  stopped?: boolean
}

interface SideChatEvent {
  requestId?: string
  type?: 'delta' | 'done' | 'error' | 'cancelled' | 'notice'
  text?: string
  error?: string
  message?: string
}

/** 渲染层先生成 requestId，确保极快模型的首个事件不会早于 IPC 返回值 */
function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return `side_${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`
}

function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(max-width: 1200px)').matches
  })
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const query = window.matchMedia('(max-width: 1200px)')
    const onChange = (): void => setNarrow(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return narrow
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth))
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

/**
 * 侧边聊天：停靠在右侧栏，与画布共用宽度和拖拽习惯。
 * 只回答，不调用工具、不写主对话；关闭后本次问答仍保留。
 */
export function SideChat(): React.JSX.Element | null {
  const open = useAppStore((s) => s.sideChatOpen)
  const seed = useAppStore((s) => s.sideChatSeed)
  const clearSeed = useAppStore((s) => s.clearSideChatSeed)
  const setOpen = useAppStore((s) => s.closeSideChat)
  const sessionId = useAppStore((s) => s.session?.id ?? null)
  const canvasWidth = useAppStore((s) => s.canvasWidth)
  const setCanvasWidth = useAppStore((s) => s.setCanvasWidth)
  const narrow = useNarrowViewport()
  const viewportWidth = useViewportWidth()
  const displayCanvasWidth = responsiveCanvasWidth(canvasWidth, viewportWidth)

  const [messages, setMessages] = useState<SideMessage[]>([])
  const [input, setInput] = useState('')
  const [useContext, setUseContext] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const requestIdRef = useRef<string | null>(null)
  const assistantIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const busyRef = useRef(false)
  const sessionRef = useRef<string | null>(sessionId)

  const finalize = useCallback((text?: string, stopped = false): void => {
    const id = assistantIdRef.current
    assistantIdRef.current = null
    requestIdRef.current = null
    busyRef.current = false
    setBusy(false)
    if (!id) return
    setMessages((previous) =>
      previous.map((message) =>
        message.id === id
          ? {
              ...message,
              streaming: false,
              stopped,
              content:
                text && text.trim()
                  ? text
                  : message.content || (stopped ? '（已停止）' : '（没有回答）')
            }
          : message
      )
    )
  }, [])

  useEffect(() => {
    return window.morrow.features.on(SIDECHAT_EVENT, (payload) => {
      const event = payload as SideChatEvent
      if (!event.requestId || event.requestId !== requestIdRef.current) return
      if (event.type === 'delta' && typeof event.text === 'string') {
        const id = assistantIdRef.current
        if (!id) return
        setMessages((previous) =>
          previous.map((message) => (message.id === id ? { ...message, content: message.content + event.text } : message))
        )
      } else if (event.type === 'notice' && event.message) {
        setNotice(event.message)
      } else if (event.type === 'done') {
        finalize(typeof event.text === 'string' ? event.text : '')
      } else if (event.type === 'error') {
        setError(event.error ?? '这次没有回答上来，请再试一次。')
        finalize()
      } else if (event.type === 'cancelled') {
        finalize(undefined, true)
      }
    })
  }, [finalize])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => inputRef.current?.focus(), 60)
    return () => window.clearTimeout(timer)
  }, [open])

  // 切换主对话时清空侧边聊天，避免上下文串台
  useEffect(() => {
    if (sessionRef.current === sessionId) return
    sessionRef.current = sessionId
    if (busyRef.current && requestIdRef.current) {
      void window.morrow.features.invoke('feature:sidechat:cancel', { requestId: requestIdRef.current })
    }
    setMessages([])
    setError(null)
    setNotice(null)
    setInput('')
    setBusy(false)
    busyRef.current = false
    assistantIdRef.current = null
    requestIdRef.current = null
    setOpen()
  }, [sessionId, setOpen])

  const send = useCallback(
    async (questionArg?: string): Promise<void> => {
      const question = (questionArg ?? input).trim()
      if (!question || !sessionId || busyRef.current) return
      const history = messages
        .filter((message) => !message.streaming)
        .slice(-12)
        .map((message) => ({ role: message.role, content: message.content }))
      const requestId = newRequestId()
      const sentSessionId = sessionId
      const assistantId = `side_a_${Date.now()}`
      assistantIdRef.current = assistantId
      requestIdRef.current = requestId
      busyRef.current = true
      setBusy(true)
      setError(null)
      setNotice(null)
      setInput('')
      setMessages((previous) => [
        ...previous,
        { id: `side_u_${Date.now()}`, role: 'user', content: question },
        { id: assistantId, role: 'assistant', content: '', streaming: true }
      ])
      try {
        const result = await window.morrow.features.invoke<{ requestId: string }>('feature:sidechat:ask', {
          requestId,
          sessionId,
          question,
          useContext,
          history
        })
        if (sessionRef.current !== sentSessionId) {
          if (result.ok) {
            void window.morrow.features.invoke('feature:sidechat:cancel', { requestId: result.data.requestId })
          }
          return
        }
        if (!result.ok) {
          setError(result.error.message)
          finalize()
          return
        }
        if (requestIdRef.current === requestId && result.data.requestId !== requestId) {
          requestIdRef.current = result.data.requestId
        }
      } catch (err) {
        if (sessionRef.current === sentSessionId) {
          setError(err instanceof Error ? err.message : '这次没有回答上来，请再试一次。')
        }
        finalize()
      }
    },
    [finalize, input, messages, sessionId, useContext]
  )

  const sendRef = useRef(send)
  sendRef.current = send

  // /btw 打开时把带入的问题发出去；只消费一次
  useEffect(() => {
    if (!open || !seed) return
    const question = seed.question
    clearSeed()
    void sendRef.current(question)
  }, [open, seed, clearSeed])

  const stop = async (): Promise<void> => {
    if (requestIdRef.current) {
      await window.morrow.features.invoke('feature:sidechat:cancel', { requestId: requestIdRef.current })
    }
  }

  if (!open) return null

  return (
    <>
      {!narrow ? (
        <ResizeHandle
          edge="left"
          value={displayCanvasWidth}
          min={320}
          max={960}
          label="拖动调整侧边聊天宽度（方向键微调，双击恢复默认）"
          onChange={(width) => setCanvasWidth(width)}
          onCommit={(width) => setCanvasWidth(width, true)}
          onReset={() => setCanvasWidth(420, true)}
          className="sidechat-resizer"
        />
      ) : null}
      <aside
        className={['sidechat-rail', narrow ? 'is-overlay' : ''].filter(Boolean).join(' ')}
        aria-label="侧边聊天"
        style={!narrow ? { width: displayCanvasWidth } : undefined}
      >
        <header className="sidechat-head">
          <span className="sidechat-head-icon" aria-hidden>
            <MessageSquare size={15} strokeWidth={1.5} />
          </span>
          <div className="sidechat-head-copy">
            <span className="sidechat-title">侧边聊天</span>
            <span className="sidechat-sub">只回答，不改文件，也不写进主对话</span>
          </div>
          <div className="sidechat-head-actions">
            <label className="sidechat-context" title="把主对话最近的文字带进来，回答会更贴合语境">
              <input type="checkbox" checked={useContext} onChange={(event) => setUseContext(event.target.checked)} />
              <span>带上主对话</span>
            </label>
            <span className="sidechat-divider" aria-hidden />
            <IconButton label="关闭侧边聊天" size={26} onClick={() => setOpen()}>
              <X size={13} strokeWidth={1.7} aria-hidden />
            </IconButton>
          </div>
        </header>

        <div className="sidechat-body" ref={scrollRef} aria-live="polite">
          {messages.length === 0 ? (
            <div className="sidechat-empty">
              <span className="sidechat-empty-mark" aria-hidden>
                <MessageSquare size={20} strokeWidth={1.3} />
              </span>
              <p className="sidechat-empty-title">顺便问一句</p>
              <p className="sidechat-hint">
                适合问清概念、让 Morrow 解释一段话，或者比较两个选择。回答只出现在这里，不会打断主对话。
              </p>
              <p className="sidechat-hint sidechat-hint-tip">
                在输入框里用 <code className="mono">/btw 你的问题</code> 也可以直接打开。
              </p>
            </div>
          ) : (
            messages.map((message) => (
              <div key={message.id} className={`sidechat-msg is-${message.role}`}>
                <span className="sidechat-role">{message.role === 'user' ? '你' : 'Morrow'}</span>
                <div className="sidechat-text selectable">
                  {message.content ? <Markdown text={message.content} streaming={message.streaming === true} /> : null}
                  {message.streaming && !message.content ? <span className="sidechat-typing">正在回答…</span> : null}
                  {message.stopped ? <span className="sidechat-stopped">已停止</span> : null}
                </div>
              </div>
            ))
          )}
          {notice ? (
            <p className="sidechat-notice" role="status">
              {notice}
            </p>
          ) : null}
          {error ? <ErrorNote title={error} /> : null}
        </div>

        <div className="sidechat-compose">
          <div className="sidechat-composer chat-gold-frame">
            <textarea
              ref={inputRef}
              className="sidechat-input"
              rows={2}
              maxLength={8000}
              value={input}
              placeholder="问一句，不会影响主对话…"
              aria-label="侧边聊天输入"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            <div className="sidechat-actions">
              <span className="sidechat-note">Enter 发送 · Shift+Enter 换行</span>
              {busy ? (
                <Button size="sm" variant="ghost" onClick={() => void stop()}>
                  <Square size={10} strokeWidth={2} fill="currentColor" aria-hidden />
                  停止
                </Button>
              ) : (
                <Button size="sm" variant="gold" disabled={!input.trim()} onClick={() => void send()}>
                  <ArrowUp size={12} strokeWidth={1.8} aria-hidden />
                  发送
                </Button>
              )}
            </div>
          </div>
        </div>
      </aside>
    </>
  )
}
