import { memo, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  Check,
  ChevronDown,
  Copy,
  File as FileIcon,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Pencil,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2
} from 'lucide-react'
import type { ChatMessage, ContentBlock, MessageAttachment, ToolUseBlock } from '@shared/types'
import { formatBytes } from '@shared/format'
import { stripToolProtocol } from '@shared/tool-protocol'
import { messagePlainText, userMessageDisplayText } from '@shared/message'
import { useAppStore } from '../../state/store'
import { Markdown } from '../../components/Markdown'
import { ActivitySpine } from '../activity/ToolRow'
import { ThinkingBlock } from './ThinkingBlock'
import { GoalContinuation, parseGoalContinuation } from './GoalContinuation'
import { PlanNotice, parsePlanMessage } from '../activity/PlanCard'
import './Transcript.css'

const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

function formatTime(timestamp: number): string {
  try {
    return TIME_FORMAT.format(new Date(timestamp))
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
      nodes.push(
        <StreamingMarkdown
          key={`text-${index}`}
          text={stripToolProtocol(block.text)}
          streaming={streaming && isLastText}
        />
      )
    } else if (block.type === 'thinking') {
      nodes.push(
        <ThinkingBlock
          key={`thinking-${index}`}
          text={stripToolProtocol(block.text)}
          durationMs={block.durationMs}
          streaming={streaming}
        />
      )
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

/* ── 上下文压缩摘要：折叠成一条系统标记，不再伪装成助手长回复 ── */

function CompactionNotice({ message }: { message: ChatMessage }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const raw = message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
  const summary = raw.replace(/^\[历史对话摘要[^\]]*\]\s*/, '').trim()
  const bodyId = `compaction-${message.id}`
  const head = (
    <>
      <Archive size={12} strokeWidth={1.5} aria-hidden />
      <span>上下文已压缩</span>
      {summary ? <span className="compaction-hint">{open ? '收起摘要' : '查看摘要'}</span> : null}
      {summary ? <ChevronDown size={12} strokeWidth={1.6} className={['compaction-chevron', open ? 'is-open' : ''].filter(Boolean).join(' ')} aria-hidden /> : null}
    </>
  )
  return (
    <article className="message message-compaction">
      {summary ? (
        <button
          type="button"
          className="compaction-head"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={open ? '收起历史对话摘要' : '查看历史对话摘要'}
          onClick={() => setOpen((value) => !value)}
        >
          {head}
        </button>
      ) : (
        <div className="compaction-head">{head}</div>
      )}
      {open && summary ? (
        <div className="compaction-body selectable" id={bodyId}>
          <Markdown text={summary} />
        </div>
      ) : null}
    </article>
  )
}

/* ── 消息 ─────────────────────────────────────────────────────── */

export interface MessageItemProps {
  message: ChatMessage
  /** 这条消息正在流式输出 */
  streaming: boolean
  /** 是否最后一条 assistant 消息（仅它可重新生成） */
  isLastAssistant?: boolean
  /** 是否这一轮用户消息之后的最后一条回答（显示分叉/回退入口，中间模型步骤不显示） */
  isTurnFinal?: boolean
  /** 这一轮的用户消息 id：轮末回答用它显示「回退这一轮」 */
  rewindTargetUserMessageId?: string | null
  /** 折叠组内的步骤：收紧步骤之间的间距 */
  compact?: boolean
}

function AttachmentChip({ attachment }: { attachment: MessageAttachment }): React.JSX.Element {
  const Icon = attachment.kind === 'text' ? FileText : attachment.kind === 'image' ? ImageIcon : FileIcon
  const warn = attachment.note || attachment.truncated
  return (
    <span
      className={['message-user-attachment', warn ? 'is-warn' : ''].filter(Boolean).join(' ')}
      title={attachment.note ?? attachment.path ?? attachment.name}
    >
      <Icon size={12} strokeWidth={1.5} aria-hidden />
      <span className="message-user-attachment-name truncate">{attachment.name}</span>
      <span className="message-user-attachment-size mono">{formatBytes(attachment.size)}</span>
      {warn ? (
        <span
          className="message-user-attachment-warn"
          role="img"
          title={attachment.note ?? '附件内容已截断'}
          aria-label={attachment.note ?? '附件内容已截断'}
        >
          <AlertTriangle size={11} strokeWidth={1.6} aria-hidden />
        </span>
      ) : null}
    </span>
  )
}

export const MessageItem = memo(function MessageItem({
  message,
  streaming,
  isLastAssistant = false,
  isTurnFinal = false,
  rewindTargetUserMessageId = null,
  compact = false
}: MessageItemProps): React.JSX.Element {
  const time = formatTime(message.createdAt)
  const userText = message.role === 'user' ? userMessageDisplayText(message) : ''
  const copyable = message.role === 'user' ? userText : messagePlainText(message)
  const openRewind = useAppStore((s) => s.openRewind)
  const branchFromMessage = useAppStore((s) => s.branchFromMessage)
  const deleteMessagesAfter = useAppStore((s) => s.deleteMessagesAfter)
  const editMessageAndResend = useAppStore((s) => s.editMessageAndResend)
  const regenerateLast = useAppStore((s) => s.regenerateLast)
  const running = useAppStore((s) => s.run?.sessionId === s.session?.id)
  const notify = useAppStore((s) => s.notify)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(userText)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // 阶段节点只挂在创建检查点时的边界消息上；中间的模型步骤不再显示分叉/回退行。
  const stageInfo = message.role === 'assistant' ? message.stageBoundary ?? null : null

  const beginEdit = (): void => {
    if (running) {
      notify('warning', '当前对话正在运行，先停止后再编辑。')
      return
    }
    setDraft(userText)
    setEditing(true)
  }

  const submitEdit = (): void => {
    const value = draft.trim()
    if (!value) return
    if (value === userText) {
      setEditing(false)
      return
    }
    setEditing(false)
    void editMessageAndResend(message.id, value)
  }

  if (
    message.role === 'system' &&
    message.content.some((block) => block.type === 'text' && block.text.includes('历史对话摘要'))
  ) {
    return <CompactionNotice message={message} />
  }

  if (message.role === 'user') {
    // 目标模式续跑消息：主进程插入的用户消息，渲染成克制的续跑行而不是用户气泡
    const continuation = parseGoalContinuation(userText)
    if (continuation) {
      return (
        <article className="message message-user message-continuation" data-message-id={message.id}>
          <GoalContinuation info={continuation} createdAt={message.createdAt} />
        </article>
      )
    }
    // 计划批准/继续/修订也是主进程插入的控制消息：渲染为轻量提示行，不占用户气泡
    const planNotice = parsePlanMessage(userText)
    if (planNotice) {
      return (
        <article className="message message-user message-continuation" data-message-id={message.id}>
          <PlanNotice info={planNotice} />
        </article>
      )
    }
    const images = message.images ?? []
    const sentImageNames = new Set(images.map((image) => image.name).filter((name): name is string => Boolean(name)))
    const chips = (message.attachments ?? []).filter(
      (attachment) => attachment.kind !== 'image' || !attachment.name || !sentImageNames.has(attachment.name)
    )
    return (
      <article className="message message-user" data-message-id={message.id}>
        <div className={['message-user-bubble', 'selectable', editing ? 'is-editing' : ''].filter(Boolean).join(' ')}>
          {editing ? (
            <textarea
              className="message-user-editor"
              value={draft}
              aria-label="编辑这条消息"
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  submitEdit()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setEditing(false)
                }
              }}
            />
          ) : userText ? (
            <p className="message-user-text">{userText}</p>
          ) : null}
          {images.length > 0 ? (
            <div className="message-user-images">
              {images.map((image, index) => (
                <img
                  key={`${image.name ?? 'image'}-${index}`}
                  className="message-user-image"
                  src={`data:${image.mediaType};base64,${image.dataBase64}`}
                  alt={image.name ? `附件图片：${image.name}` : `附件图片 ${index + 1}`}
                  title={image.name}
                  loading="lazy"
                  decoding="async"
                />
              ))}
            </div>
          ) : null}
          {chips.length > 0 ? (
            <div className="message-user-attachments">
              {chips.map((attachment, index) => (
                <AttachmentChip key={`${attachment.name}-${index}`} attachment={attachment} />
              ))}
            </div>
          ) : null}
        </div>
        {editing ? (
          <div className="message-edit-bar">
            <span className="message-edit-hint">发送后会删除这条消息之后的对话</span>
            <button type="button" className="message-copy" onClick={() => setEditing(false)}>
              取消
            </button>
            <button
              type="button"
              className="message-edit-send"
              disabled={!draft.trim() || running}
              onClick={submitEdit}
            >
              发送
            </button>
          </div>
        ) : (
          <div className="message-meta message-meta-user">
            <span className="message-time mono">{time}</span>
            <button
              type="button"
              className="message-copy"
              aria-label="从这条消息分叉"
              title={running ? '当前对话正在运行，先停止后再分叉' : '从这条消息分叉出新对话，原对话保持不变'}
              disabled={running}
              onClick={() => void branchFromMessage(message.id)}
            >
              <GitBranch size={13} strokeWidth={1.6} aria-hidden />
              <span>分叉</span>
            </button>
            <button
              type="button"
              className="message-copy"
              aria-label="编辑并重发"
              title={running ? '当前对话正在运行，先停止后再编辑' : '编辑后从这里重新发送'}
              disabled={running}
              onClick={beginEdit}
            >
              <Pencil size={13} strokeWidth={1.6} aria-hidden />
              <span>编辑</span>
            </button>
            <button
              type="button"
              className="message-copy"
              aria-label="删除后续消息"
              title={running ? '当前对话正在运行，先停止后再删除' : '删除这条消息之后的所有对话'}
              disabled={running}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={13} strokeWidth={1.6} aria-hidden />
              <span>删除后续</span>
            </button>
            <CopyButton text={copyable} label="复制这条消息" />
          </div>
        )}
        {confirmDelete ? (
          <div className="message-confirm" role="alertdialog" aria-label="删除后续消息">
            <span className="message-confirm-text">删除这条消息之后的所有对话？此操作无法撤销。</span>
            <button type="button" className="message-copy" onClick={() => setConfirmDelete(false)}>
              取消
            </button>
            <button
              type="button"
              className="message-copy is-danger"
              onClick={() => {
                setConfirmDelete(false)
                void deleteMessagesAfter(message.id)
              }}
            >
              删除
            </button>
          </div>
        ) : null}
      </article>
    )
  }

  return (
    <article
      className={['message', 'message-assistant', streaming ? 'is-streaming' : '', compact ? 'is-compact' : ''].filter(Boolean).join(' ')}
      data-message-id={message.id}
    >
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
      {stageInfo ? (
        <div className="message-stage-node" role="note" aria-label={`阶段完成：${stageInfo.label}`}>
          <span className="message-stage-line" aria-hidden />
          <span className="message-stage-dot" aria-hidden>
            <Check size={10} strokeWidth={2.2} />
          </span>
          <span className="message-stage-label">阶段完成</span>
          <span className="message-stage-title truncate">{stageInfo.label}</span>
        </div>
      ) : null}
      {isTurnFinal || stageInfo ? (
        <div className="message-meta">
          <span className="message-time mono">{time}</span>
          {isLastAssistant && !streaming ? (
            <button
              type="button"
              className="message-copy"
              aria-label="重新生成回答"
              title={running ? '当前对话正在运行，先停止后再重新生成' : '丢弃这条回答并重新生成'}
              disabled={running}
              onClick={() => void regenerateLast()}
            >
              <RefreshCw size={13} strokeWidth={1.6} aria-hidden />
              <span>重新生成</span>
            </button>
          ) : null}
          {!streaming ? (
            <button
              type="button"
              className="message-copy"
              aria-label={stageInfo ? '从这个阶段分叉' : '从这条回答分叉'}
              title={running ? '当前对话正在运行，先停止后再分叉' : '从这条回答分叉出新对话，原对话保持不变'}
              disabled={running}
              onClick={() => void branchFromMessage(message.id)}
            >
              <GitBranch size={13} strokeWidth={1.6} aria-hidden />
              <span>分叉</span>
            </button>
          ) : null}
          <CopyButton text={copyable} label="复制这条回答" />
          {!streaming && (stageInfo || rewindTargetUserMessageId) ? (
            <button
              type="button"
              className="message-copy"
              aria-label={stageInfo ? '回退到这个阶段完成时' : '回退这一轮'}
              title={
                running
                  ? '当前对话正在运行，先停止再回退'
                  : stageInfo
                    ? '回到这个阶段完成时，之后的对话和文件一起恢复'
                    : '回到这一轮开始前，文件和对话一起恢复'
              }
              disabled={running}
              onClick={() => openRewind(stageInfo?.checkpointId ?? rewindTargetUserMessageId ?? '')}
            >
              <RotateCcw size={13} strokeWidth={1.6} aria-hidden />
              <span>回退</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  )
})
