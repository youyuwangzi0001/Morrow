import { useState } from 'react'
import { ChevronDown, Target } from 'lucide-react'
import './Transcript.css'

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
