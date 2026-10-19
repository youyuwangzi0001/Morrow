import { useEffect, useRef, useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import './Transcript.css'

export interface ThinkingBlockProps {
  text: string
  /** 后端给出的思考耗时 */
  durationMs?: number
  streaming?: boolean
}

function formatSeconds(seconds: number): string {
  if (seconds < 1) return '不到 1 秒'
  return `${Math.round(seconds)} 秒`
}

/**
 * 思考块：默认折叠成一行「思考了 N 秒」，展开可见紫灰斜体思考内容。
 * 流式期间实时显示秒数，避免用户以为卡住。
 */
export function ThinkingBlock({ text, durationMs, streaming = false }: ThinkingBlockProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const startedAt = useRef(Date.now())
  const [elapsed, setElapsed] = useState(0)
  const textRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!streaming) return undefined
    const timer = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAt.current) / 1_000))
    }, 500)
    return () => window.clearInterval(timer)
  }, [streaming])

  useEffect(() => {
    if (open && streaming) {
      const element = textRef.current
      if (element) element.scrollTop = element.scrollHeight
    }
  }, [text, open, streaming])

  if (!text.trim() && !streaming) return null

  const seconds = durationMs && durationMs > 0 ? durationMs / 1_000 : elapsed
  const label = streaming
    ? `正在思考${seconds >= 1 ? ` · ${Math.floor(seconds)} 秒` : '…'}`
    : durationMs && durationMs > 0
      ? `思考了 ${formatSeconds(seconds)}`
      : '思考过程'

  return (
    <div className={['thinking', open ? 'is-open' : '', streaming ? 'is-streaming' : ''].filter(Boolean).join(' ')}>
      <button type="button" className="thinking-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Brain size={13} strokeWidth={1.5} aria-hidden className="thinking-icon" />
        <span className="thinking-label">{label}</span>
        {streaming ? <span className="thinking-pulse" aria-hidden /> : null}
        <ChevronRight size={12} strokeWidth={1.6} aria-hidden className="thinking-chevron" />
      </button>
      {open ? (
        <div className="thinking-body" ref={textRef}>
          {text.trim() ? text : '正在思考…'}
        </div>
      ) : null}
    </div>
  )
}
