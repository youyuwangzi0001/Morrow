import { memo, useEffect, useRef, useState } from 'react'
import { Check, Copy, Square } from 'lucide-react'
import type { ChatMessage, ContentBlock, ToolUseBlock } from '@shared/types'
import { useAppStore } from '../../state/store'
import { Markdown } from '../../components/markdown/Markdown'
import { ActivitySpine } from '../activity/ActivitySpine'
import { ThinkingBlock } from './ThinkingBlock'
import { GoalContinuation, parseGoalContinuation } from './GoalContinuation'
import './Transcript.css'

/* ── 工具 ─────────────────────────────────────────────────────── */

export function messagePlainText(message: ChatMessage): string {
  return message.content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'error') return block.message
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function formatTime(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp))
  } catch {
    return ''
  }
}

function CopyButton({ text, label }: { text: string; label: string }): React.JSX.Element | null {
  const copyText = useAppStore((s) => s.copyText)
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    []
  )

  if (!text) return null
  return (
    <button
      type="button"
      className="message-copy"
      aria-label={label}
      title={label}
      onClick={() => {
        void copyText(text)
        setCopied(true)
        if (timer.current) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1_500)
      }}
    >
      {copied ? <Check size={13} strokeWidth={1.6} aria-hidden /> : <Copy size={13} strokeWidth={1.6} aria-hidden />}
      <span>{copied ? '已复制' : '复制'}</span>
    </button>
  )
}

/* ── 流式 Markdown（节流渲染，避免每个 delta 都重排整段） ─────── */

function StreamingMarkdown({ text, streaming }: { text: string; streaming: boolean }): React.JSX.Element {
  const [visible, setVisible] = useState(text)
  const latest = useRef(text)
  latest.current = text
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (!streaming) {
      if (visible !== text) setVisible(text)
      return
    }
    if (visible === text) return
    if (timer.current !== null) return
    // 积压越多越快刷新；正常节奏约 15 帧/次
    const delay = text.length - visible.length > 240 ? 16 : 64
    timer.current = window.setTimeout(() => {
      timer.current = null
      setVisible(latest.current)
    }, delay)
  }, [text, streaming, visible])

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )

  return (
    <div className={['stream-text', streaming ? 'is-streaming' : ''].filter(Boolean).join(' ')}>
      <Markdown text={visible} streaming={streaming} />
    </div>
  )
}

/* ── 内容块渲染 ───────────────────────────────────────────────── */

function InlineError({ block }: { block: Extract<ContentBlock, { type: 'error' }> }): React.JSX.Element {
  return (
    <div className="message-inline-error" role="alert">
      <p>{block.message}</p>
      {block.code ? <span className="message-inline-error-code mono">{block.code}</span> : null}
    </div>
  )
}

function AssistantContent({ message, streaming }: { message: ChatMessage; streaming: boolean }): React.JSX.Element {
  const nodes: React.ReactNode[] = []
  let tools: ToolUseBlock[] = []

  const lastTextIndex = message.content.reduce((last, block, index) => (block.type === 'text' ? index : last), -1)

  const flushTools = (): void => {
    if (tools.length === 0) return
    nodes.push(<ActivitySpine key={`spine-${tools[0].id}`} blocks={tools} />)
    tools = []
  }

  message.content.forEach((block, index) => {
    if (block.type === 'tool_use') {
      tools.push(block)
      return
    }
    flushTools()
    if (block.type === 'text') {
      const isLastText = index === lastTextIndex
      nodes.push(<StreamingMarkdown key={`text-${index}`} text={block.text} streaming={streaming && isLastText} />)
    } else if (block.type === 'thinking') {
      nodes.push(<ThinkingBlock key={`thinking-${index}`} text={block.text} durationMs={block.durationMs} streaming={streaming} />)
    } else if (block.type === 'error') {
      nodes.push(<InlineError key={`error-${index}`} block={block} />)
    }
  })
  flushTools()

  const hasText = lastTextIndex !== -1
  if (streaming && !hasText) {
    nodes.push(
      <p key="typing" className="message-typing">
        <span className="message-typing-dot" aria-hidden />
        正在组织回答
      </p>
    )
  }

  return <div className="message-blocks">{nodes}</div>
}

/* ── 消息 ─────────────────────────────────────────────────────── */

export interface MessageItemProps {
  message: ChatMessage
  /** 这条消息正在流式输出 */
  streaming: boolean
  /** 是否最后一条（决定思考块流式态） */
  isLast: boolean
}

export const MessageItem = memo(function MessageItem({ message, streaming }: MessageItemProps): React.JSX.Element {
  const time = formatTime(message.createdAt)
  const copyable = messagePlainText(message)

  if (message.role === 'user') {
    // 目标模式续跑消息：主进程插入的用户消息，渲染成克制的续跑行而不是用户气泡
    const continuation = parseGoalContinuation(copyable)
    if (continuation) {
      return (
        <article className="message message-user message-continuation">
          <GoalContinuation info={continuation} createdAt={message.createdAt} />
        </article>
      )
    }
    return (
      <article className="message message-user">
        <div className="message-user-bubble selectable">
          {message.content.map((block, index) =>
            block.type === 'text' ? <p key={index} className="message-user-text">{block.text}</p> : null
          )}
        </div>
        <div className="message-meta message-meta-user">
          <span className="message-time mono">{time}</span>
          <CopyButton text={copyable} label="复制这条消息" />
        </div>
      </article>
    )
  }

  return (
    <article className={['message', 'message-assistant', streaming ? 'is-streaming' : ''].filter(Boolean).join(' ')}>
      <AssistantContent message={message} streaming={streaming} />
      {message.interrupted ? (
        <p className="message-interrupted">
          <Square size={10} strokeWidth={1.8} aria-hidden />
          已停止生成
        </p>
      ) : null}
      {message.error ? (
        <div className="message-inline-error" role="alert">
          <p>{message.error.message}</p>
          {message.error.hint ? <p className="message-inline-error-hint">{message.error.hint}</p> : null}
        </div>
      ) : null}
      <div className="message-meta">
        <span className="message-time mono">{time}</span>
        <CopyButton text={copyable} label="复制这条回答" />
      </div>
    </article>
  )
})
