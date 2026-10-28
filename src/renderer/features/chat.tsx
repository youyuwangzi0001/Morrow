// chat 功能域组件：由 6 个 TSX 文件扁平合并。
import './chat.css'
import { useEffect, useMemo, useState, useRef, memo, useId, useCallback, useLayoutEffect } from 'react'
import { ChevronRight, File as FileIcon, FileDiff, Brain, ChevronDown, Target, AlertTriangle, Archive, Check, Copy, FileText, GitBranch, Image as ImageIcon, Pencil, RefreshCw, RotateCcw, Square, Trash2, ListChecks, ArrowDown } from 'lucide-react'
import type { ChatMessage, ContentBlock, MessageAttachment, ToolUseBlock } from '@shared/types'
import { useAppStore } from '../store'
import { DiffView } from '../components'
import { extractDiff, toolStatusLabel, toolSummary, fileDiffEvents } from './activity-core'
import { formatBytes } from '@shared/types'
import { stripToolProtocol } from '@shared/types'
import { messagePlainText, userMessageDisplayText } from '@shared/types'
import { Markdown } from '../components'
import { BrandMark } from '../components'
import { ActivitySpine } from './activity'
import { PlanNotice, parsePlanMessage } from './activity'
import { Kbd, HorizonLoader } from '../components'
import { PermissionCard } from './activity'
import { QuestionCard } from './activity'

interface DiffDetail {
  patch?: string
  before?: string
  after?: string
  added: number
  removed: number
}

interface DiffEntry {
  key: string
  path: string
  added: number
  removed: number
  details: DiffDetail[]
}

interface DiffData {
  added: number
  removed: number
  files: string[]
  entries: DiffEntry[]
}

export interface DiffSummarySource {
  message: ChatMessage
  suppressed?: ReadonlySet<string> | null
}

/** 从一个或一组消息里汇总本轮文件改动；同一文件多次修改时保留每一次的可展示差异。 */
function collectDiffData(sources: DiffSummarySource[]): DiffData {
  const perFile = new Map<string, { display: string; added: number; removed: number }>()
  const entries = new Map<string, DiffEntry>()
  let anonymousAdded = 0
  let anonymousRemoved = 0
  let anonymousSeq = 0
  const addSummary = (key: string, display: string, plus: number, minus: number): void => {
    if (!key) {
      anonymousAdded += plus
      anonymousRemoved += minus
      return
    }
    const entry = perFile.get(key) ?? { display, added: 0, removed: 0 }
    entry.added += plus
    entry.removed += minus
    if (!entry.display && display) entry.display = display
    perFile.set(key, entry)
  }

  for (const { message, suppressed } of sources) {
    for (const block of message.content) {
      if (block.type !== 'tool_use' || !block.result) continue
      const meta = block.result.meta as Record<string, unknown> | undefined
      const changed = Array.isArray(meta?.changedFiles) ? meta.changedFiles : null
      if (changed) {
        let counted = false
        for (const raw of changed) {
          if (!raw || typeof raw !== 'object') continue
          const file = raw as Record<string, unknown>
          const plus = typeof file.diffAdded === 'number' ? file.diffAdded : 0
          const minus = typeof file.diffRemoved === 'number' ? file.diffRemoved : 0
          if (plus > 0 || minus > 0) counted = true
          const key = typeof file.absolutePath === 'string' ? file.absolutePath : ''
          if (key && suppressed?.has(key)) continue
          addSummary(key, key, plus, minus)
          if (key && (plus > 0 || minus > 0) && !entries.has(key)) {
            entries.set(key, { key, path: key, added: plus, removed: minus, details: [] })
          }
        }
        if (counted) continue
      }
      const diff = extractDiff(block.result, block)
      if (!diff) continue
      const plus = diff.added ?? 0
      const minus = diff.removed ?? 0
      if (plus === 0 && minus === 0) continue
      const key =
        typeof meta?.absolutePath === 'string'
          ? meta.absolutePath
          : typeof block.input?.path === 'string'
            ? block.input.path
            : typeof block.input?.file_path === 'string'
              ? block.input.file_path
              : ''
      if (key && suppressed?.has(key)) continue
      const display =
        diff.filePath || (typeof meta?.path === 'string' ? meta.path : '') || key
      addSummary(key, display, plus, minus)
      const entryKey = key || `__anonymous_${anonymousSeq++}`
      const entry = entries.get(entryKey) ?? {
        key: entryKey,
        path: display || entryKey,
        added: 0,
        removed: 0,
        details: []
      }
      if (!entry.path || entry.path === entryKey) entry.path = display || entryKey
      entry.added += plus
      entry.removed += minus
      entry.details.push({
        added: plus,
        removed: minus,
        ...(diff.patch ? { patch: diff.patch } : {}),
        ...(diff.before !== undefined ? { before: diff.before } : {}),
        ...(diff.after !== undefined ? { after: diff.after } : {})
      })
      entries.set(entryKey, entry)
    }
  }

  let added = anonymousAdded
  let removed = anonymousRemoved
  const files = new Set<string>()
  for (const [key, entry] of perFile) {
    added += entry.added
    removed += entry.removed
    if (entry.display) files.add(entry.display)
    const detail = entries.get(key)
    if (detail) {
      // 同一文件多次改动时，文件行与卡片总计都使用整轮累计值。
      detail.added = entry.added
      detail.removed = entry.removed
    } else if (entry.added > 0 || entry.removed > 0) {
      // 没有逐行 patch 的子任务汇总也保留在详情里，避免只看到数字。
      entries.set(key, {
        key,
        path: entry.display || key,
        added: entry.added,
        removed: entry.removed,
        details: []
      })
    }
  }
  return { added, removed, files: [...files], entries: [...entries.values()] }
}

/**
 * 本轮改动卡：整轮只保留这一张。结束前只显示统计；结束后展开先看改动文件，
 * 再点开单个文件查看逐行差异，避免一次性渲染全部 diff。
 */
export function DiffSummaryCard({
  sources,
  className
}: {
  sources: DiffSummarySource[]
  className?: string
}): React.JSX.Element | null {
  const run = useAppStore((state) =>
    state.run && state.session && state.run.sessionId === state.session.id ? state.run : null
  )
  const data = useMemo(() => collectDiffData(sources), [sources])
  const [open, setOpen] = useState(false)
  const [openFiles, setOpenFiles] = useState<ReadonlySet<string>>(() => new Set())
  const latestAt = useMemo(
    () => sources.reduce((latest, source) => Math.max(latest, source.message.createdAt), 0),
    [sources]
  )
  const isCurrentRun = Boolean(run && latestAt >= run.startedAt)
  const canExpand = !isCurrentRun && data.entries.length > 0

  useEffect(() => {
    if (isCurrentRun) {
      setOpen(false)
      setOpenFiles(new Set())
    }
  }, [isCurrentRun])

  useEffect(() => {
    if (!open) setOpenFiles(new Set())
  }, [open])

  if (data.added + data.removed <= 0) return null

  const fileCount = data.entries.length
  const label = `本轮改动 ${fileCount} 个文件，增加 ${data.added} 行，减少 ${data.removed} 行`
  const summaryClass = ['message-diff-summary', className].filter(Boolean).join(' ')
  const toggleFile = (key: string): void => {
    setOpenFiles((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const content = (
    <>
      <FileDiff size={12} strokeWidth={1.5} aria-hidden />
      <span className="message-diff-label">
        本轮改动{fileCount > 0 ? ` ${fileCount} 个文件` : ''}
      </span>
      <span className="message-diff-add mono">+{data.added}</span>
      <span className="message-diff-del mono">−{data.removed}</span>
      {!open && data.files.length > 0 ? (
        <span className="message-diff-paths truncate" title={data.files.join('\n')}>
          {data.files.slice(0, 3).join(' · ')}
          {data.files.length > 3 ? ` 等 ${data.files.length} 个` : ''}
        </span>
      ) : null}
    </>
  )

  if (!canExpand) {
    return (
      <div className={summaryClass} role="note" aria-label={label}>
        {content}
      </div>
    )
  }

  return (
    <div className={['message-diff-card', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        className={[summaryClass, 'is-expandable', open ? 'is-open' : ''].filter(Boolean).join(' ')}
        aria-expanded={open}
        aria-label={`${label}，${open ? '收起详细差异' : '展开查看详细差异'}`}
        onClick={() => setOpen((value) => !value)}
      >
        {content}
        <ChevronRight size={12} strokeWidth={1.6} className="message-diff-chevron" aria-hidden />
      </button>
      {open ? (
        <div className="message-diff-detail" role="region" aria-label="本轮修改的文件">
          <div className="message-diff-detail-head">
            <span>修改的文件</span>
            <span className="message-diff-detail-hint mono">点开文件查看逐行差异</span>
          </div>
          <div className="message-diff-files">
            {data.entries.map((entry) => {
              const hasDetail = entry.details.length > 0
              const fileOpen = hasDetail && openFiles.has(entry.key)
              const head = (
                <>
                  <ChevronRight
                    size={12}
                    strokeWidth={1.6}
                    className={['message-diff-file-caret', hasDetail ? '' : 'is-quiet'].filter(Boolean).join(' ')}
                    aria-hidden
                  />
                  <FileIcon size={12} strokeWidth={1.5} aria-hidden />
                  <span className="message-diff-file-path truncate" title={entry.path}>
                    {entry.path}
                  </span>
                  <span className="message-diff-add mono">+{entry.added}</span>
                  <span className="message-diff-del mono">−{entry.removed}</span>
                  {hasDetail ? null : <span className="message-diff-file-note">仅统计</span>}
                </>
              )
              return (
                <section
                  key={entry.key}
                  className={['message-diff-file', fileOpen ? 'is-open' : ''].filter(Boolean).join(' ')}
                >
                  {hasDetail ? (
                    <button
                      type="button"
                      className="message-diff-file-head"
                      aria-expanded={fileOpen}
                      aria-label={`${fileOpen ? '收起' : '查看'} ${entry.path} 的逐行差异`}
                      onClick={() => toggleFile(entry.key)}
                    >
                      {head}
                    </button>
                  ) : (
                    <div className="message-diff-file-head">{head}</div>
                  )}
                  {fileOpen ? (
                    <div className="message-diff-changes">
                      {entry.details.length > 1 ? (
                        <p className="message-diff-change-note">
                          本轮修改了 {entry.details.length} 次，按执行顺序显示
                        </p>
                      ) : null}
                      {entry.details.map((detail, index) => (
                        <div className="message-diff-change" key={`${entry.key}-${index}`}>
                          {entry.details.length > 1 ? (
                            <div className="message-diff-change-head mono">
                              <span>第 {index + 1} 次</span>
                              <span className="message-diff-add">+{detail.added}</span>
                              <span className="message-diff-del">−{detail.removed}</span>
                            </div>
                          ) : null}
                          <DiffView
                            patch={detail.patch}
                            before={detail.before}
                            after={detail.after}
                            filePath={entry.path}
                            hideHeader
                            contextLines={3}
                            maxHeight={360}
                          />
                        </div>
                      ))}
                    </div>
                  ) : null}
                </section>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}

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

  const hasDuration = typeof durationMs === 'number' && durationMs >= 0
  const seconds = hasDuration ? durationMs / 1_000 : elapsed
  const label = streaming
    ? `正在思考${seconds >= 1 ? ` · ${Math.floor(seconds)} 秒` : '…'}`
    : hasDuration
      ? seconds < 1
        ? '思考了不到 1 秒'
        : `思考了 ${formatSeconds(seconds)}`
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

export interface GoalContinuationInfo {
  round: number | null
  total: number | null
  body: string
}

/**
 * 目标续跑消息前缀：「（目标模式 · 第 N/M 轮续跑）」
 * 容错：全/半角括号、·/-/— 分隔、空格差异；解析失败返回 null（按普通消息渲染）。
 */
const CONTINUATION_PREFIX =
  /^[（(]\s*目标模式\s*[·•\-—]?\s*第\s*(\d+)\s*\/\s*(\d+)\s*轮续跑\s*[）)]\s*/

export function parseGoalContinuation(text: string): GoalContinuationInfo | null {
  const match = CONTINUATION_PREFIX.exec(text)
  if (!match) return null
  return {
    round: Number(match[1]),
    total: Number(match[2]),
    body: text.slice(match[0].length).trim()
  }
}

function formatClock(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp))
  } catch {
    return ''
  }
}

/**
 * 续跑行：和普通用户气泡区分开，金色细边 + Target 图标 + mono 轮次。
 * 正文只保留一行摘要，需要时点开查看完整说明。
 */
export function GoalContinuation({
  info,
  createdAt
}: {
  info: GoalContinuationInfo
  createdAt: number
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const collapsible = info.body.length > 64 || info.body.includes('\n')
  const label = info.round && info.total ? `目标续跑 · 第 ${info.round}/${info.total} 轮` : '目标续跑'

  return (
    <div className="goal-cont" role="note" aria-label={label}>
      <span className="goal-cont-icon" aria-hidden>
        <Target size={12} strokeWidth={1.7} />
      </span>
      <span className="goal-cont-label mono">{label}</span>
      {info.body ? (
        collapsible ? (
          <button
            type="button"
            className={['goal-cont-body', expanded ? 'is-expanded' : ''].filter(Boolean).join(' ')}
            aria-expanded={expanded}
            title={expanded ? '收起续跑说明' : '展开续跑说明'}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="goal-cont-text">{info.body}</span>
            <ChevronDown size={12} strokeWidth={1.6} className="goal-cont-chevron" aria-hidden />
          </button>
        ) : (
          <span className="goal-cont-body is-static">
            <span className="goal-cont-text">{info.body}</span>
          </span>
        )
      ) : null}
      <span className="goal-cont-time mono">{formatClock(createdAt)}</span>
    </div>
  )
}

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

function StreamingMarkdown({
  text,
  streaming,
  lead
}: {
  text: string
  streaming: boolean
  lead?: React.ReactNode
}): React.JSX.Element {
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
    <div className={['stream-text', streaming ? 'is-streaming' : '', lead ? 'has-lead' : ''].filter(Boolean).join(' ')}>
      {lead}
      <Markdown text={visible} streaming={streaming} />
    </div>
  )
}

function InlineError({ block }: { block: Extract<ContentBlock, { type: 'error' }> }): React.JSX.Element {
  return (
    <div className="message-inline-error" role="alert">
      <p>{block.message}</p>
      {block.code ? <span className="message-inline-error-code mono">{block.code}</span> : null}
    </div>
  )
}

function AssistantContent({
  message,
  streaming,
  showBrand
}: {
  message: ChatMessage
  streaming: boolean
  showBrand: boolean
}): React.JSX.Element {
  const nodes: React.ReactNode[] = []
  let tools: ToolUseBlock[] = []

  const lastTextIndex = message.content.reduce((last, block, index) => (block.type === 'text' ? index : last), -1)
  const firstTextIndex = message.content.findIndex(
    (block) => block.type === 'text' && stripToolProtocol(block.text).trim().length > 0
  )

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
          lead={showBrand && index === firstTextIndex ? <BrandMark size={18} className="message-agent-mark" /> : null}
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
  const savedMatch = /已压缩\s*([\d,]+)\s*tokens/.exec(raw)
  const savedTokens = savedMatch ? Number(savedMatch[1].replace(/,/g, '')) : 0
  const savedLabel = savedTokens >= 1000 ? `${(savedTokens / 1000).toFixed(1)}k` : String(savedTokens)
  const bodyId = `compaction-${message.id}`
  const head = (
    <>
      <Archive size={12} strokeWidth={1.5} aria-hidden />
      <span>上下文已压缩</span>
      {savedTokens > 0 ? <span className="compaction-saved mono">节省 {savedLabel} tokens</span> : null}
      <span className="compaction-hint">任务继续{summary ? (open ? ' · 收起摘要' : ' · 查看摘要') : ''}</span>
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
  /** 用户真实发起的一轮：供右侧轮次导航定位 */
  turnIndex?: number
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
  turnIndex,
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
      <article className="message message-user" data-message-id={message.id} data-turn-index={turnIndex}>
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
      <AssistantContent message={message} streaming={streaming} showBrand={isTurnFinal} />
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

/** 只有多步执行才折叠；1–3 步仍按原来的轨迹直接展示。 */
export const EXECUTION_GROUP_MIN_STEPS = 4

interface ExecutionGroupProps {
  messages: ChatMessage[]
  streamingMessageId: string | null
  revealMessageId?: string | null
}

/**
 * 一轮任务里的多步执行合并成一条摘要。
 * 默认收起，展开后仍是原来的思考与工具；整轮 diff 统一放在轮末改动卡。
 */
export function ExecutionGroup({
  messages,
  streamingMessageId,
  revealMessageId = null
}: ExecutionGroupProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const stats = useMemo(() => {
    let toolCount = 0
    let failed = 0
    let current: ToolUseBlock | null = null
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue
        toolCount += 1
        if (block.status === 'error' || block.status === 'denied') failed += 1
        if (block.status === 'running' || block.status === 'waiting') current = block
      }
    }
    const streaming = streamingMessageId
      ? messages.some((message) => message.id === streamingMessageId)
      : false
    return { toolCount, failed, current, running: streaming || current !== null }
  }, [messages, streamingMessageId])

  useEffect(() => {
    if (revealMessageId && messages.some((message) => message.id === revealMessageId)) setOpen(true)
  }, [messages, revealMessageId])

  const title = stats.toolCount > 0 ? `执行工具 ${stats.toolCount} 次` : '执行过程'
  const current = stats.current
  const currentTitle = current
    ? [current.title, toolStatusLabel(current.status)].filter(Boolean).join(' · ')
    : '正在组织下一步'
  const currentSummary = current ? toolSummary(current) : ''
  const tone = stats.running ? 'is-running' : stats.failed > 0 ? 'is-error' : ''
  const stateLabel = stats.running ? '进行中' : stats.failed > 0 ? `失败 ${stats.failed} 个工具` : '已完成'

  return (
    <div className={['exec-group', tone, open ? 'is-open' : ''].filter(Boolean).join(' ')}>
      <button
        type="button"
        className="exec-group-head"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        aria-label={`${title}，${stateLabel}，${open ? '收起执行详情' : '展开执行详情'}`}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight size={13} strokeWidth={1.6} className="exec-group-caret" aria-hidden />
        <ListChecks size={14} strokeWidth={1.5} className="exec-group-icon" aria-hidden />
        <span className="exec-group-title">{title}</span>
        <span className="exec-group-right">
          {stats.failed > 0 ? <span className="exec-group-failed">{stats.failed} 个失败</span> : null}
          {stats.running ? (
            <span className="exec-group-live">
              <span className="exec-group-pulse" aria-hidden />
              <span className="exec-group-live-title truncate">{currentTitle}</span>
              {currentSummary ? <span className="exec-group-live-summary truncate">{currentSummary}</span> : null}
            </span>
          ) : stats.failed === 0 ? (
            <span className="exec-group-done">
              <Check size={11} strokeWidth={2} aria-hidden />
              已完成
            </span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div className="exec-group-body" id={bodyId} role="region" aria-label={`${title}的详细步骤`}>
          {messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              streaming={streamingMessageId === message.id}
              compact
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

const EMPTY_MESSAGES: ChatMessage[] = []

/** 距底部小于该值视为「在跟随最新」 */
const FOLLOW_THRESHOLD = 96

type TranscriptUnit =
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'execution'; key: string; messages: ChatMessage[] }
  | { kind: 'turn-diff'; key: string; sources: DiffSummarySource[] }

interface TurnSegment {
  key: string
  /** 整轮全部消息（含隐藏步骤），用于汇总改动 */
  all: ChatMessage[]
  /** 对话流真正渲染的消息 */
  visible: ChatMessage[]
}

interface TurnNavItem {
  id: string
  index: number
  title: string
}

/** 计划续跑、目标续跑等控制消息不切分「本轮」；用户真正发来的新消息才另起一张改动卡。 */
function startsTurn(message: ChatMessage): boolean {
  if (message.role !== 'user' || message.hidden) return false
  const text = userMessageDisplayText(message)
  return !parseGoalContinuation(text) && !parsePlanMessage(text)
}

function distanceFromBottom(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight
}

/**
 * 对话流：滚动容器 + 自动跟随 + 「回到最新」。
 * 消息渲染在 MessageItem；权限卡/提问卡永远出现在流末尾。
 */
export function Transcript(): React.JSX.Element {
  const session = useAppStore((s) => s.session)
  const pendingPermission = useAppStore((s) => s.pendingPermission)
  const pendingQuestion = useAppStore((s) => s.pendingQuestion)
  const streaming = useAppStore((s) => s.streaming)
  const focusMessageId = useAppStore((s) => s.focusMessageId)
  const clearFocusMessage = useAppStore((s) => s.clearFocusMessage)
  const loadingSession = useAppStore((s) => s.loadingSession)
  const compacting = useAppStore(
    (s) => s.compacting && (!s.compactingSessionId || s.compactingSessionId === s.session?.id)
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const followRef = useRef(true)
  const jumpingRef = useRef(false)
  const lastMessageIdRef = useRef<string | null>(null)
  const [showJump, setShowJump] = useState(false)
  const [hasNew, setHasNew] = useState(false)
  const [hasOverflow, setHasOverflow] = useState(false)
  const [activeTurn, setActiveTurn] = useState(0)
  const [turnTip, setTurnTip] = useState<{ index: number; top: number } | null>(null)

  const messages = session?.messages ?? EMPTY_MESSAGES
  const visibleMessages = useMemo(() => messages.filter((message) => !message.hidden), [messages])
  // 每轮用户消息之后的最后一条 assistant 是「轮末回答」：只有它显示分叉/回退，
  // 中间的模型步骤保持连续、不产生操作节点。
  const turnFinals = useMemo(() => {
    const finals = new Map<string, string>()
    let userId = ''
    for (const message of messages) {
      if (message.role === 'user') {
        userId = message.id
        continue
      }
      if (message.role !== 'assistant') {
        userId = ''
        continue
      }
      if (userId) finals.set(message.id, userId)
    }
    for (let index = 0; index < messages.length - 1; index += 1) {
      if (messages[index].role === 'assistant' && messages[index + 1].role === 'assistant') {
        finals.delete(messages[index].id)
      }
    }
    return finals
  }, [messages])
  // 按用户真正发来的消息划分「本轮」：计划批准、目标续跑等控制消息仍属于同一轮。
  const turnSegments = useMemo(() => {
    const segments: TurnSegment[] = []
    let current: TurnSegment | null = null
    for (const message of messages) {
      if (!current || startsTurn(message)) {
        if (current && current.all.length > 0) segments.push(current)
        current = { key: message.id, all: [], visible: [] }
      }
      current.all.push(message)
      if (!message.hidden) current.visible.push(message)
    }
    if (current && current.all.length > 0) segments.push(current)
    return segments
  }, [messages])
  // 右侧轮次导航只取用户真正发起的轮次；计划批准、目标续跑等控制消息不单独成段。
  const turnNav = useMemo(() => {
    const items: TurnNavItem[] = []
    for (const segment of turnSegments) {
      const user = segment.visible.find((message) => message.role === 'user' && startsTurn(message))
      if (!user) continue
      const text = userMessageDisplayText(user).replace(/\s+/g, ' ').trim()
      const clipped = text.length > 80 ? `${text.slice(0, 80)}…` : text
      items.push({ id: user.id, index: items.length, title: clipped || '附件消息' })
    }
    return items
  }, [turnSegments])
  const turnIndexById = useMemo(
    () => new Map(turnNav.map((item) => [item.id, item.index] as const)),
    [turnNav]
  )
  // 新建后又删除的文件在这一轮净变化为零：所有相关消息都不再显示 +N/−N。
  const diffSuppression = useMemo(() => {
    const map = new Map<string, ReadonlySet<string>>()
    for (const segment of turnSegments) {
      const created = new Set<string>()
      const lastDeleted = new Map<string, boolean>()
      for (const message of segment.all) {
        for (const event of fileDiffEvents(message)) {
          if (event.created) created.add(event.path)
          lastDeleted.set(event.path, event.deleted)
        }
      }
      const suppressed = new Set([...created].filter((path) => lastDeleted.get(path) === true))
      if (suppressed.size > 0) {
        for (const message of segment.all) map.set(message.id, suppressed)
      }
    }
    return map
  }, [turnSegments])
  // 同一轮里的多步执行合并成一条摘要；整轮只在最后保留一张改动卡。
  const renderUnits = useMemo(() => {
    const units: TranscriptUnit[] = []
    for (const segment of turnSegments) {
      let batch: ChatMessage[] = []
      const flush = (): void => {
        if (batch.length === 0) return
        if (batch.length >= EXECUTION_GROUP_MIN_STEPS) {
          units.push({ kind: 'execution', key: `exec-${batch[0].id}`, messages: batch })
        } else {
          for (const message of batch) units.push({ kind: 'message', key: message.id, message })
        }
        batch = []
      }
      for (const message of segment.visible) {
        const foldable =
          message.role === 'assistant' &&
          !turnFinals.has(message.id) &&
          !message.stageBoundary
        if (!foldable) {
          flush()
          units.push({ kind: 'message', key: message.id, message })
          continue
        }
        batch.push(message)
      }
      flush()
      if (segment.visible.length > 0) {
        units.push({
          kind: 'turn-diff',
          key: `diff-${segment.key}`,
          sources: segment.all.map((message) => ({
            message,
            suppressed: diffSuppression.get(message.id) ?? null
          }))
        })
      }
    }
    return units
  }, [turnSegments, turnFinals, diffSuppression])
  const lastMessage = messages[messages.length - 1]
  const lastContentSize = lastMessage
    ? lastMessage.content.reduce((size, block) => {
        if (block.type === 'text' || block.type === 'thinking') return size + block.text.length
        return size + 1
      }, 0)
    : 0
  const streamingSize = (streaming?.text.length ?? 0) + (streaming?.thinking.length ?? 0)
  const sessionId = session?.id ?? null

  /* 切换对话：直接定位到最新 */
  useLayoutEffect(() => {
    followRef.current = true
    jumpingRef.current = false
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    setShowJump(false)
    setHasNew(false)
    setActiveTurn(0)
    setTurnTip(null)
  }, [sessionId])

  /* 只有内容明显超过一屏时才出现右侧轮次导航，短对话不增加视觉噪音。 */
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return undefined
    const measure = (): void => setHasOverflow(scroller.scrollHeight > scroller.clientHeight + 160)
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    if (contentRef.current) observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [sessionId, messages.length])

  /* 全局搜索命中：等消息渲染后滚到原消息并短暂金色高亮 */
  useEffect(() => {
    if (!focusMessageId || !session) return undefined
    let cancelled = false
    let attempts = 0
    let frame = 0
    const tryScroll = (): void => {
      if (cancelled) return
      const container = contentRef.current
      const target = container?.querySelector<HTMLElement>(`[data-message-id="${focusMessageId}"]`)
      if (target && scrollRef.current) {
        followRef.current = false
        jumpingRef.current = true
        setShowJump(true)
        setHasNew(false)
        target.scrollIntoView({ block: 'center', behavior: 'auto' })
        target.classList.add('is-search-hit')
        window.setTimeout(() => target.classList.remove('is-search-hit'), 2_800)
        window.setTimeout(() => {
          jumpingRef.current = false
        }, 700)
        clearFocusMessage()
        return
      }
      attempts += 1
      if (attempts < 24) frame = requestAnimationFrame(tryScroll)
      else clearFocusMessage()
    }
    frame = requestAnimationFrame(tryScroll)
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [focusMessageId, session?.id, messages.length, clearFocusMessage, session])

  /* 内容增长：跟随中则贴底，否则记录未读 */
  useLayoutEffect(() => {
    if (!session) return
    if (followRef.current) {
      const element = scrollRef.current
      if (element) element.scrollTop = element.scrollHeight
    } else {
      setHasNew(true)
    }
  }, [session, messages.length, lastContentSize, streamingSize])

  /* 用户刚发出新消息：即使正在回看历史，也跟到最新（目标续跑不打断阅读） */
  useLayoutEffect(() => {
    if (!lastMessage || lastMessage.id === lastMessageIdRef.current) return
    lastMessageIdRef.current = lastMessage.id
    if (lastMessage.role !== 'user') return
    if (parseGoalContinuation(userMessageDisplayText(lastMessage))) return
    followRef.current = true
    jumpingRef.current = false
    setShowJump(false)
    setHasNew(false)
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [lastMessage?.id, lastMessage?.role])

  /* 权限卡/提问卡出现时必须被看到 */
  useLayoutEffect(() => {
    if (pendingPermission || pendingQuestion) {
      followRef.current = true
      const element = scrollRef.current
      if (element) element.scrollTop = element.scrollHeight
      setShowJump(false)
      setHasNew(false)
    }
  }, [pendingPermission, pendingQuestion])

  /* 内容尺寸变化（图片/代码高亮/折叠开关）时保持贴底 */
  useEffect(() => {
    const element = contentRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (!followRef.current || jumpingRef.current) return
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        const scroll = scrollRef.current
        if (scroll) scroll.scrollTop = scroll.scrollHeight
      })
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [sessionId])

  const updateActiveTurn = useCallback((): void => {
    const scroller = scrollRef.current
    const content = contentRef.current
    if (!scroller || !content) return
    const nodes = content.querySelectorAll<HTMLElement>('[data-turn-index]')
    if (nodes.length === 0) return
    const scrollerTop = scroller.getBoundingClientRect().top
    let next = Number(nodes[0]?.dataset.turnIndex ?? 0)
    nodes.forEach((node) => {
      if (node.getBoundingClientRect().top - scrollerTop <= 140) {
        next = Number(node.dataset.turnIndex ?? next)
      }
    })
    setActiveTurn((previous) => (previous === next ? previous : next))
  }, [])

  useLayoutEffect(() => {
    if (!hasOverflow) return
    updateActiveTurn()
  }, [hasOverflow, turnNav.length, messages.length, updateActiveTurn])

  /* 轮次过多时导航在固定高度内滚动；初始把可视窗口对准中间，保持上下对称扩散。 */
  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return
    nav.scrollTop = Math.max(0, (nav.scrollHeight - nav.clientHeight) / 2)
  }, [turnNav.length, hasOverflow])

  const showTurnTip = useCallback((turn: TurnNavItem, element: HTMLElement): void => {
    const root = element.closest('.transcript-root')
    if (!root) return
    const rect = element.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    setTurnTip({ index: turn.index, top: rect.top + rect.height / 2 - rootRect.top })
  }, [])

  const onScroll = (): void => {
    if (jumpingRef.current) return
    const element = scrollRef.current
    if (!element) return
    const distance = distanceFromBottom(element)
    const following = distance < FOLLOW_THRESHOLD
    followRef.current = following
    setShowJump(!following)
    setHasNew((previous) => (following ? false : previous))
    updateActiveTurn()
  }

  const jumpToLatest = useCallback((): void => {
    const element = scrollRef.current
    if (!element) return
    jumpingRef.current = true
    followRef.current = true
    setShowJump(false)
    setHasNew(false)
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    window.setTimeout(() => {
      jumpingRef.current = false
      const scroll = scrollRef.current
      if (scroll && distanceFromBottom(scroll) < FOLLOW_THRESHOLD) followRef.current = true
    }, 700)
  }, [])

  const jumpToTurn = useCallback((turn: TurnNavItem): void => {
    const scroller = scrollRef.current
    const target = contentRef.current?.querySelector<HTMLElement>(
      `[data-message-id="${turn.id}"]`
    )
    if (!scroller || !target) return
    jumpingRef.current = true
    followRef.current = false
    setShowJump(true)
    setHasNew(false)
    setActiveTurn(turn.index)
    const top =
      scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 18
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    target.classList.add('is-turn-hit')
    window.setTimeout(() => target.classList.remove('is-turn-hit'), 1_800)
    window.setTimeout(() => {
      jumpingRef.current = false
    }, 700)
  }, [])

  if (!session) {
    return (
      <div className="transcript-root">
        <div className="transcript-loading">
          {loadingSession ? <HorizonLoader active /> : null}
        </div>
      </div>
    )
  }

  const streamingMessageId = streaming?.messageId ?? null
  const isEmpty = visibleMessages.length === 0 && !streaming
  const showTurnNav = hasOverflow && turnNav.length >= 3

  return (
    <div className="transcript-root">
      <div
        className="transcript-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        tabIndex={-1}
        role="log"
        aria-label="对话内容"
        aria-live="off"
      >
        <div className="transcript-inner" ref={contentRef}>
          {compacting ? (
            <div className="transcript-compacting" role="status" aria-live="polite">
              <span className="transcript-compacting-line" aria-hidden />
              <span className="mono">正在整理较早的对话，稍等片刻</span>
            </div>
          ) : null}
          {isEmpty ? (
            <div className="transcript-empty">
              <p className="transcript-empty-title">说清想要的结果，过程我来想办法。</p>
              <p className="transcript-empty-desc">
                比如「把文件夹里的文件整理成一份清单」——Morrow 会读文件、写脚本、把成品交给你。
              </p>
              <p className="transcript-empty-hint">
                按 <Kbd>Ctrl</Kbd>
                <span className="transcript-empty-plus">+</span>
                <Kbd>K</Kbd> 打开命令，或用 <Kbd>/</Kbd> 选择常见任务。
              </p>
            </div>
          ) : (
            renderUnits.map((unit) =>
              unit.kind === 'execution' ? (
                <ExecutionGroup
                  key={unit.key}
                  messages={unit.messages}
                  streamingMessageId={streamingMessageId}
                  revealMessageId={focusMessageId}
                />
              ) : unit.kind === 'turn-diff' ? (
                <DiffSummaryCard key={unit.key} sources={unit.sources} className="message-diff-turn" />
              ) : (
                <MessageItem
                  key={unit.key}
                  message={unit.message}
                  streaming={streamingMessageId === unit.message.id}
                  isLastAssistant={
                    unit.message.role === 'assistant' &&
                    unit.message.id === visibleMessages[visibleMessages.length - 1]?.id
                  }
                  isTurnFinal={turnFinals.has(unit.message.id)}
                  rewindTargetUserMessageId={turnFinals.get(unit.message.id) ?? null}
                  turnIndex={turnIndexById.get(unit.message.id)}
                />
              )
            )
          )}

          {pendingPermission ? <PermissionCard request={pendingPermission} /> : null}
          {pendingQuestion ? <QuestionCard request={pendingQuestion} /> : null}

          {!isEmpty ? <div className="transcript-tail" aria-hidden /> : null}
        </div>
      </div>

      {showTurnNav ? (
        <nav ref={navRef} className="transcript-turn-nav" aria-label="轮次跳转">
          {turnNav.map((turn) => (
            <button
              key={turn.id}
              type="button"
              className={`transcript-turn${activeTurn === turn.index ? ' is-active' : ''}`}
              aria-label={`跳到第 ${turn.index + 1} 轮：${turn.title}`}
              aria-current={activeTurn === turn.index ? 'true' : undefined}
              onClick={() => jumpToTurn(turn)}
              onMouseEnter={(event) => showTurnTip(turn, event.currentTarget)}
              onFocus={(event) => showTurnTip(turn, event.currentTarget)}
              onMouseLeave={() => setTurnTip(null)}
              onBlur={() => setTurnTip(null)}
            >
              <span className="transcript-turn-tick" aria-hidden />
            </button>
          ))}
        </nav>
      ) : null}

      {turnTip && showTurnNav ? (
        <div className="transcript-turn-tip" style={{ top: turnTip.top }} aria-hidden>
          <span className="mono transcript-turn-no">
            {String(turnTip.index + 1).padStart(2, '0')}
          </span>
          <span className="transcript-turn-title">{turnNav[turnTip.index]?.title}</span>
        </div>
      ) : null}

      {showJump ? (
        <div className="transcript-jump-bar">
          <button type="button" className="transcript-jump" onClick={jumpToLatest} aria-label="回到最新消息">
            <ArrowDown size={13} strokeWidth={1.7} aria-hidden />
            <span>回到最新</span>
            {hasNew ? <span className="transcript-jump-dot" aria-hidden /> : null}
          </button>
        </div>
      ) : null}
    </div>
  )
}
