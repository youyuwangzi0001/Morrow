import { useEffect, useId, useMemo, useState } from 'react'
import { Check, ChevronRight, ListChecks } from 'lucide-react'
import type { ChatMessage, ToolUseBlock } from '@shared/types'
import { toolStatusLabel, toolSummary } from '../activity/tool-meta'
import { MessageItem } from './MessageItem'

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
